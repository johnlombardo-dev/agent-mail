import type { Database } from "bun:sqlite";
import { parseMessageId, type MessageId } from "@agent-mail/core";

const CANONICAL_MESSAGE_ID = /^message:[0-9a-f]{64}$/u;

/** The source update is deliberately owned by this transaction primitive. */
export type SearchProjectionSourceUpdate = (database: Database, messageId: MessageId) => void;

export type SearchProjectionOperation =
  | Readonly<{
      readonly kind: "update";
      readonly messageId: unknown;
      readonly sourceUpdate: SearchProjectionSourceUpdate;
    }>
  | Readonly<{
      readonly kind: "delete";
      readonly messageId: unknown;
    }>;

export type SearchProjectionWriteBoundary =
  | "mapping"
  | "source"
  | "after-source"
  | "fts-delete"
  | "fts-insert";

export type SearchProjectionMutationOptions = Readonly<{
  readonly beforeWrite?: (boundary: SearchProjectionWriteBoundary) => void;
}>;

export type SearchProjection = Readonly<{
  readonly documentId: number;
  readonly messageId: MessageId;
  readonly subject: string;
  readonly participants: string;
  readonly bodyPlain: string;
  readonly bodyHtml: string;
  readonly attachmentNames: string;
}>;

export type SearchProjectionMutationResult =
  | Readonly<{ readonly kind: "updated"; readonly projection: SearchProjection }>
  | Readonly<{
      readonly kind: "deleted";
      readonly status: "deleted" | "already-absent";
      readonly documentId: number | undefined;
    }>;

export type SearchProjectionErrorCode = "invalid-input" | "not-found" | "write-failed";

export class SearchProjectionError extends Error {
  readonly code: SearchProjectionErrorCode;

  constructor(code: SearchProjectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SearchProjectionError";
    this.code = code;
  }
}

/**
 * Update or remove one message projection. Source writes and the external
 * content FTS5 delete/insert commands share this transaction. The immutable
 * message_search_documents row is retained when a projection is deleted.
 */
export function mutateMessageSearchProjection(
  database: Database,
  operation: SearchProjectionOperation,
  options: SearchProjectionMutationOptions = {},
): SearchProjectionMutationResult {
  const prepared = prepareOperation(operation);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const messageExists: unknown = database
      .query("SELECT message_id FROM messages WHERE message_id = ?;")
      .get(prepared.messageId);
    if (messageExists === null) {
      throw new SearchProjectionError(
        "not-found",
        "canonical message does not exist for search projection",
      );
    }
    const messageRow = requireRecord(messageExists, "canonical message row");
    requireExactKeys(messageRow, ["message_id"], "canonical message row");
    if (typeof messageRow.message_id !== "string") {
      throw new TypeError("canonical message row has an invalid message ID");
    }
    const decodedMessageId = parseMessageId(messageRow.message_id);
    if (!CANONICAL_MESSAGE_ID.test(decodedMessageId) || decodedMessageId !== prepared.messageId) {
      throw new TypeError("canonical message row has an invalid message ID");
    }

    if (prepared.kind === "delete") {
      const mapping = readMapping(database, prepared.messageId);
      if (mapping === undefined) {
        database.exec("COMMIT;");
        transactionStarted = false;
        return { kind: "deleted", status: "already-absent", documentId: undefined };
      }
      const source = readProjection(database, prepared.messageId, mapping.documentId);
      const hasFtsRow = readFtsRow(database, mapping.documentId);
      if (hasFtsRow) {
        options.beforeWrite?.("fts-delete");
        deleteFtsRow(database, source);
      }
      database.exec("COMMIT;");
      transactionStarted = false;
      return {
        kind: "deleted",
        status: hasFtsRow ? "deleted" : "already-absent",
        documentId: mapping.documentId,
      };
    }

    options.beforeWrite?.("mapping");
    database
      .query(
        "INSERT INTO message_search_documents (message_id) VALUES (?) " +
          "ON CONFLICT(message_id) DO NOTHING;",
      )
      .run(prepared.messageId);
    const mapping = readMapping(database, prepared.messageId);
    if (mapping === undefined) {
      throw new Error("search document mapping disappeared during transaction");
    }

    const previous = readProjection(database, prepared.messageId, mapping.documentId);
    const hadFtsRow = readFtsRow(database, mapping.documentId);
    options.beforeWrite?.("source");
    prepared.sourceUpdate(database, prepared.messageId);
    options.beforeWrite?.("after-source");
    const current = readProjection(database, prepared.messageId, mapping.documentId);
    if (hadFtsRow) {
      options.beforeWrite?.("fts-delete");
      deleteFtsRow(database, previous);
    }
    options.beforeWrite?.("fts-insert");
    insertFtsRow(database, current);
    database.exec("COMMIT;");
    transactionStarted = false;
    return { kind: "updated", projection: current };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    if (error instanceof SearchProjectionError) throw error;
    throw new SearchProjectionError("write-failed", "search projection transaction failed", {
      cause: error,
    });
  }
}

/** Convenience update entry point for callers that own a source mutation. */
export function updateMessageSearchProjection(
  database: Database,
  messageId: unknown,
  sourceUpdate: SearchProjectionSourceUpdate,
  options: SearchProjectionMutationOptions = {},
): SearchProjectionMutationResult {
  return mutateMessageSearchProjection(
    database,
    { kind: "update", messageId, sourceUpdate },
    options,
  );
}

/** Remove only one FTS projection; canonical source rows and its mapping remain. */
export function deleteMessageSearchProjection(
  database: Database,
  messageId: unknown,
  options: SearchProjectionMutationOptions = {},
): SearchProjectionMutationResult {
  return mutateMessageSearchProjection(database, { kind: "delete", messageId }, options);
}

function prepareOperation(operation: SearchProjectionOperation): SearchProjectionOperation & {
  readonly messageId: MessageId;
} {
  try {
    const messageId = parseMessageId(operation.messageId);
    if (!CANONICAL_MESSAGE_ID.test(messageId)) {
      throw new TypeError("message ID must use the canonical SHA-256 namespace form");
    }
    if (operation.kind === "update" && typeof operation.sourceUpdate !== "function") {
      throw new TypeError("search projection source update is invalid");
    }
    return { ...operation, messageId };
  } catch (error: unknown) {
    if (error instanceof SearchProjectionError) throw error;
    throw new SearchProjectionError("invalid-input", "search projection input is invalid", {
      cause: error,
    });
  }
}

type Mapping = Readonly<{ readonly documentId: number; readonly messageId: MessageId }>;

function readMapping(database: Database, messageId: MessageId): Mapping | undefined {
  const row: unknown = database
    .query("SELECT document_id, message_id FROM message_search_documents WHERE message_id = ?;")
    .get(messageId);
  if (row === null) return undefined;
  const value = requireRecord(row, "search document mapping row");
  requireExactKeys(value, ["document_id", "message_id"], "search document mapping row");
  if (
    typeof value.document_id !== "number" ||
    !Number.isSafeInteger(value.document_id) ||
    value.document_id <= 0 ||
    typeof value.message_id !== "string"
  ) {
    throw new TypeError("search document mapping row has an invalid shape");
  }
  const decodedMessageId = parseMessageId(value.message_id);
  if (!CANONICAL_MESSAGE_ID.test(decodedMessageId) || decodedMessageId !== messageId) {
    throw new TypeError("search document mapping row has an invalid message ID");
  }
  return { documentId: value.document_id, messageId: decodedMessageId };
}

function readProjection(
  database: Database,
  messageId: MessageId,
  documentId: number,
): SearchProjection {
  const row: unknown = database
    .query(
      "SELECT rowid, message_id, subject, participants, body_plain, body_html, attachment_names " +
        "FROM indexed_messages WHERE message_id = ?;",
    )
    .get(messageId);
  if (row === null) throw new Error("indexed message projection disappeared during transaction");
  const value = requireRecord(row, "indexed message projection row");
  requireExactKeys(
    value,
    [
      "rowid",
      "message_id",
      "subject",
      "participants",
      "body_plain",
      "body_html",
      "attachment_names",
    ],
    "indexed message projection row",
  );
  if (
    typeof value.rowid !== "number" ||
    !Number.isSafeInteger(value.rowid) ||
    value.rowid !== documentId ||
    typeof value.message_id !== "string" ||
    typeof value.subject !== "string" ||
    typeof value.participants !== "string" ||
    typeof value.body_plain !== "string" ||
    typeof value.body_html !== "string" ||
    typeof value.attachment_names !== "string"
  ) {
    throw new TypeError("indexed message projection row has an invalid shape");
  }
  const decodedMessageId = parseMessageId(value.message_id);
  if (!CANONICAL_MESSAGE_ID.test(decodedMessageId) || decodedMessageId !== messageId) {
    throw new TypeError("indexed message projection row has an invalid message ID");
  }
  return {
    documentId,
    messageId: decodedMessageId,
    subject: value.subject,
    participants: value.participants,
    bodyPlain: value.body_plain,
    bodyHtml: value.body_html,
    attachmentNames: value.attachment_names,
  };
}

function readFtsRow(database: Database, documentId: number): boolean {
  // External-content FTS exposes rows from its content view even before their
  // index entries exist. The docsize shadow table is the SQLite-owned record
  // of rows actually present in the FTS index.
  const row: unknown = database
    .query("SELECT id FROM message_fts_docsize WHERE id = ?;")
    .get(documentId);
  if (row === null) return false;
  const value = requireRecord(row, "FTS docsize row");
  requireExactKeys(value, ["id"], "FTS docsize row");
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) {
    throw new TypeError("FTS row has an invalid row identity");
  }
  if (value.id !== documentId) throw new TypeError("FTS row identity does not match mapping");
  return true;
}

function deleteFtsRow(database: Database, projection: SearchProjection): void {
  database
    .query(
      "INSERT INTO message_fts(message_fts, rowid, subject, participants, body_plain, body_html, attachment_names) " +
        "VALUES ('delete', ?, ?, ?, ?, ?, ?);",
    )
    .run(
      projection.documentId,
      projection.subject,
      projection.participants,
      projection.bodyPlain,
      projection.bodyHtml,
      projection.attachmentNames,
    );
}

function insertFtsRow(database: Database, projection: SearchProjection): void {
  database
    .query(
      "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) " +
        "VALUES (?, ?, ?, ?, ?, ?);",
    )
    .run(
      projection.documentId,
      projection.subject,
      projection.participants,
      projection.bodyPlain,
      projection.bodyHtml,
      projection.attachmentNames,
    );
}

function rollback(database: Database, error: unknown): never {
  try {
    database.exec("ROLLBACK;");
  } catch (rollbackError: unknown) {
    throw new SearchProjectionError(
      "write-failed",
      "search projection transaction failed and could not be rolled back",
      { cause: new AggregateError([error, rollbackError]) },
    );
  }
  if (error instanceof SearchProjectionError) throw error;
  throw new SearchProjectionError("write-failed", "search projection transaction failed", {
    cause: error,
  });
}

type RecordValue = Readonly<Record<string, unknown>>;

function requireRecord(value: unknown, description: string): RecordValue {
  if (!isRecord(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: RecordValue, keys: readonly string[], description: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${description} has unexpected columns`);
  }
}
