import { Database } from "bun:sqlite";
import {
  compareUtcInstants,
  createIdentityOnlyContentState,
  createRemoteUid,
  parseMessageId,
  parseUtcInstant,
  type AccountId,
  type ContentAbsenceReason,
  type IdentityOnlyContentState,
  type MessageId,
  type UtcInstant,
} from "@agent-mail/core";
import {
  decodeBoundedSafeInteger,
  decodeCanonicalIdentifier,
  decodeClosedEnum,
  decodeSqliteRow,
  decodeUtcMillisecondInstant,
  type SqliteColumnContext,
} from "./row-decoders";
import { ThreadGraphRepository } from "./thread-graph-repository";
import { normalizeThreadFacts } from "./thread-normalizer";

type RecordValue = Readonly<Record<string, unknown>>;

export type IdentityOnlyMessageInput = Readonly<{
  readonly messageId: unknown;
  readonly remoteUid: unknown;
  readonly absenceReason: unknown;
  readonly observedAt: unknown;
  readonly storedAt: unknown;
}>;

export type IdentityOnlyMessage = IdentityOnlyContentState &
  Readonly<{
    readonly observedAt: UtcInstant;
    readonly storedAt: UtcInstant;
  }>;

export type IdentityOnlyContentLookup =
  | Readonly<{ readonly kind: "unavailable"; readonly reason: ContentAbsenceReason }>
  | Readonly<{ readonly kind: "not-found" }>;

export type IdentityOnlyMessageErrorCode =
  | "invalid-input"
  | "conflicting-identity"
  | "write-failed";

export class IdentityOnlyMessageError extends Error {
  readonly code: IdentityOnlyMessageErrorCode;

  constructor(code: IdentityOnlyMessageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdentityOnlyMessageError";
    this.code = code;
  }
}

/** Parse untrusted identity-only input before opening the SQLite transaction. */
export function parseIdentityOnlyMessageInput(value: unknown): Readonly<{
  readonly content: IdentityOnlyContentState;
  readonly observedAt: UtcInstant;
  readonly storedAt: UtcInstant;
}> {
  const record = requireRecord(value, "identity-only message input");
  requireExactKeys(record, ["messageId", "remoteUid", "absenceReason", "observedAt", "storedAt"]);
  try {
    const content = createIdentityOnlyContentState({
      kind: "identity-only",
      messageId: record.messageId,
      remoteUid: record.remoteUid,
      absenceReason: record.absenceReason,
    });
    const observedAt = parseUtcInstant(record.observedAt);
    const storedAt = parseUtcInstant(record.storedAt);
    if (compareUtcInstants(storedAt, observedAt) < 0) {
      throw new TypeError("stored timestamp must not precede observed timestamp");
    }
    return { content, observedAt, storedAt };
  } catch (error: unknown) {
    throw new IdentityOnlyMessageError("invalid-input", "identity-only message input is invalid", {
      cause: error,
    });
  }
}

/**
 * Persist one identity-only message and its remote identity atomically.
 * Retries with identical durable values are idempotent; conflicting identity
 * or state is rejected without leaving a partial message or placement.
 */
export function storeIdentityOnlyMessage(database: Database, value: unknown): IdentityOnlyMessage {
  const input = parseIdentityOnlyMessageInput(value);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    database
      .query("INSERT INTO messages (message_id) VALUES (?) ON CONFLICT(message_id) DO NOTHING;")
      .run(input.content.messageId);
    database
      .query(
        "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?) " +
          "ON CONFLICT(account_id, mailbox_id, uid_validity) DO NOTHING;",
      )
      .run(
        input.content.remoteUid.accountId,
        input.content.remoteUid.mailboxId,
        input.content.remoteUid.uidValidity,
      );

    const placement = readPlacementIdentity(database, input.content);
    if (placement === undefined) {
      database
        .query(
          "INSERT INTO remote_placements " +
            "(account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);",
        )
        .run(
          input.content.remoteUid.accountId,
          input.content.remoteUid.mailboxId,
          input.content.remoteUid.uidValidity,
          input.content.remoteUid.uid,
          input.content.messageId,
        );
    } else if (placement.messageId !== input.content.messageId) {
      throw new IdentityOnlyMessageError(
        "conflicting-identity",
        "remote placement already belongs to another canonical message",
      );
    }

    rejectReadableContentIfPresent(database, input.content.messageId);
    const existing = readIdentityOnlyMessage(database, input.content.messageId);
    if (existing !== undefined) {
      if (!sameIdentityOnlyMessage(existing, input)) {
        throw new IdentityOnlyMessageError(
          "conflicting-identity",
          "identity-only message already has different durable state",
        );
      }
      persistIdentityOnlyThreadFacts(
        database,
        input.content.messageId,
        input.content.remoteUid.accountId,
      );
      database.exec("COMMIT;");
      return existing;
    }

    database
      .query(
        "INSERT INTO message_content_states " +
          "(message_id, content_kind, account_id, mailbox_id, uid_validity, uid, " +
          "absence_reason, observed_at, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        input.content.messageId,
        input.content.kind,
        input.content.remoteUid.accountId,
        input.content.remoteUid.mailboxId,
        input.content.remoteUid.uidValidity,
        input.content.remoteUid.uid,
        input.content.absenceReason,
        input.observedAt,
        input.storedAt,
      );
    persistIdentityOnlyThreadFacts(
      database,
      input.content.messageId,
      input.content.remoteUid.accountId,
    );
    database.exec("COMMIT;");
    return {
      ...input.content,
      observedAt: input.observedAt,
      storedAt: input.storedAt,
    };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new IdentityOnlyMessageError(
          "write-failed",
          "identity-only message transaction failed and could not be rolled back",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
    }
    if (error instanceof IdentityOnlyMessageError) throw error;
    throw new IdentityOnlyMessageError("write-failed", "identity-only message transaction failed", {
      cause: error,
    });
  }
}

/** Read one identity-only state through strict unknown-input row decoding. */
export function readIdentityOnlyMessage(
  database: Database,
  messageId: MessageId,
): IdentityOnlyMessage | undefined {
  const row: unknown = database
    .query(
      "SELECT message_id, content_kind, account_id, mailbox_id, uid_validity, uid, " +
        "absence_reason, observed_at, stored_at FROM message_content_states WHERE message_id = ?;",
    )
    .get(messageId);
  if (row === null) return undefined;

  const value = decodeSqliteRow({
    table: "message_content_states",
    row,
    columns: {
      message_id: column("message", false),
      content_kind: {
        decode: (input, context) =>
          decodeClosedEnum(input, { ...context, values: ["identity-only"] as const }),
      },
      account_id: column("account", false),
      mailbox_id: column("mailbox", false),
      uid_validity: {
        decode: (input, context) =>
          decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 4294967295 }),
      },
      uid: {
        decode: (input, context) =>
          decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 4294967295 }),
      },
      absence_reason: {
        decode: (input, context) =>
          decodeClosedEnum(input, {
            ...context,
            values: ["not-fetched", "provider-unavailable", "redacted"] as const,
          }),
      },
      observed_at: { decode: decodeUtcMillisecondInstant },
      stored_at: { decode: decodeUtcMillisecondInstant },
    },
  });

  const messageIdValue = stringValue(value.message_id, "message_id");
  const accountIdValue = stringValue(value.account_id, "account_id");
  const mailboxIdValue = stringValue(value.mailbox_id, "mailbox_id");
  const uidValidityValue = numberValue(value.uid_validity, "uid_validity");
  const uidValue = numberValue(value.uid, "uid");
  const absenceReason = stringValue(value.absence_reason, "absence_reason");
  const observedAt = stringValue(value.observed_at, "observed_at");
  const storedAt = stringValue(value.stored_at, "stored_at");
  const content = createIdentityOnlyContentState({
    kind: "identity-only",
    messageId: messageIdValue,
    remoteUid: createRemoteUid({
      accountId: accountIdValue,
      mailboxId: mailboxIdValue,
      uidValidity: uidValidityValue,
      uid: uidValue,
    }),
    absenceReason,
  });
  // Fail closed if another storage path attached readable content after this
  // identity-only state was stored. Returning "unavailable" in that state
  // would hide a contradictory durable representation.
  rejectReadableContentIfPresent(database, content.messageId);
  return {
    ...content,
    observedAt: parseUtcInstant(observedAt),
    storedAt: parseUtcInstant(storedAt),
  };
}

/** Identity-only body lookup is explicit and never an empty readable value. */
export function lookupIdentityOnlyBody(
  database: Database,
  messageId: MessageId,
): IdentityOnlyContentLookup {
  const message = readIdentityOnlyMessage(database, messageId);
  return message === undefined
    ? { kind: "not-found" }
    : { kind: "unavailable", reason: message.absenceReason };
}

/** Identity-only attachment lookup is explicit and never an empty collection. */
export function lookupIdentityOnlyAttachments(
  database: Database,
  messageId: MessageId,
): IdentityOnlyContentLookup {
  return lookupIdentityOnlyBody(database, messageId);
}

export const readIdentityOnlyBody = lookupIdentityOnlyBody;
export const readIdentityOnlyAttachments = lookupIdentityOnlyAttachments;

function readPlacementIdentity(
  database: Database,
  content: IdentityOnlyContentState,
): Readonly<{ readonly messageId: MessageId }> | undefined {
  const row: unknown = database
    .query(
      "SELECT message_id FROM remote_placements " +
        "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND uid = ?;",
    )
    .get(
      content.remoteUid.accountId,
      content.remoteUid.mailboxId,
      content.remoteUid.uidValidity,
      content.remoteUid.uid,
    );
  if (row === null) return undefined;
  const decoded = decodeSqliteRow({
    table: "remote_placements",
    row,
    columns: { message_id: column("message", false) },
  });
  return { messageId: parseMessageId(stringValue(decoded.message_id, "message_id")) };
}

function rejectReadableContentIfPresent(database: Database, messageId: MessageId): void {
  for (const table of ["message_body_parts", "message_attachments"] as const) {
    if (!tableExists(database, table)) continue;
    const row: unknown = database
      .query(`SELECT 1 AS present FROM ${table} WHERE message_id = ? LIMIT 1;`)
      .get(messageId);
    if (row !== null) {
      throw new IdentityOnlyMessageError(
        "conflicting-identity",
        "message already has readable content and cannot become identity-only",
      );
    }
  }
}

function tableExists(database: Database, table: string): boolean {
  const row: unknown = database
    .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?;")
    .get(table);
  return row !== null;
}

function persistIdentityOnlyThreadFacts(
  database: Database,
  messageId: MessageId,
  accountId: AccountId,
): void {
  if (!tableExists(database, "thread_generation")) return;
  const facts = normalizeThreadFacts({
    accountId,
    messageId,
    contentState: "identity-only",
  });
  new ThreadGraphRepository(database).ingestFactsInTransaction(facts);
}

function sameIdentityOnlyMessage(
  existing: IdentityOnlyMessage,
  input: Readonly<{
    readonly content: IdentityOnlyContentState;
    readonly observedAt: UtcInstant;
    readonly storedAt: UtcInstant;
  }>,
): boolean {
  return (
    existing.kind === input.content.kind &&
    existing.messageId === input.content.messageId &&
    existing.remoteUid.accountId === input.content.remoteUid.accountId &&
    existing.remoteUid.mailboxId === input.content.remoteUid.mailboxId &&
    existing.remoteUid.uidValidity === input.content.remoteUid.uidValidity &&
    existing.remoteUid.uid === input.content.remoteUid.uid &&
    existing.absenceReason === input.content.absenceReason &&
    existing.observedAt === input.observedAt &&
    existing.storedAt === input.storedAt
  );
}

function column(kind: "account" | "mailbox" | "message", nullable: boolean) {
  return {
    decode: (value: unknown, context: SqliteColumnContext) =>
      decodeCanonicalIdentifier(value, kind, context),
    ...(nullable ? { nullable: true } : {}),
  };
}

function requireRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) {
    throw new IdentityOnlyMessageError("invalid-input", `${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(record: RecordValue, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new IdentityOnlyMessageError(
        "invalid-input",
        "identity-only message input has unknown fields",
      );
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new IdentityOnlyMessageError(
        "invalid-input",
        "identity-only message input is incomplete",
      );
    }
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is not text`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") throw new TypeError(`${label} is not numeric`);
  return value;
}
