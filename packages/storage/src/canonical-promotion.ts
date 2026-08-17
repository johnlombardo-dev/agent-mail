import { Database } from "bun:sqlite";
import {
  parseAccountId,
  parseBlobId,
  parseMailboxId,
  parseMessageId,
  parseRoutingDecision,
  parseUtcInstant,
  serializeRoutingDecision,
  type AccountId,
  type BlobId,
  type MailboxId,
  type MessageId,
  type RoutingDecision,
  type UtcInstant,
} from "@agent-mail/core";
import {
  decodeBoundedSafeInteger,
  decodeCanonicalIdentifier,
  decodeClosedEnum,
  decodeNullable,
  decodeSqliteRow,
  decodeUtcMillisecondInstant,
  type SqliteRowColumn,
} from "./row-decoders";

/** Rows supplied by the already parsed and normalized MIME pipeline. */
export type PromotionUnit = Readonly<{
  readonly messageId: MessageId;
  readonly placements: readonly PromotionPlacement[];
  readonly headers: readonly PromotionHeader[];
  readonly addresses: readonly PromotionAddress[];
  readonly bodyParts: readonly PromotionBodyPart[];
  readonly attachments: readonly PromotionAttachment[];
  readonly routingDecisions: readonly PromotionRoutingDecision[];
  readonly journal: PromotionJournalEvent;
}>;

export type PromotionPlacement = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: number;
  readonly uid: number;
}>;

export type PromotionHeader = Readonly<{
  readonly ordinal: number;
  readonly name: string;
  readonly normalizedName: string;
  readonly value: string;
  readonly normalizedValue: string;
}>;

export type PromotionAddress = Readonly<{
  readonly ordinal: number;
  readonly role: "from" | "sender" | "reply_to" | "to" | "cc" | "bcc";
  readonly position: number;
  readonly address: string;
  readonly normalizedAddress: string;
  readonly displayName: string | null;
  readonly groupName: string | null;
}>;

export type PromotionBodyPart = Readonly<{
  readonly ordinal: number;
  readonly contentType: string;
  readonly normalizedContentType: string;
  readonly blobId: BlobId;
}>;

export type PromotionAttachment = Readonly<{
  readonly ordinal: number;
  readonly filename: string | null;
  readonly contentType: string;
  readonly normalizedContentType: string;
  readonly disposition: string | null;
  readonly contentId: string | null;
  readonly size: number;
  readonly blobId: BlobId;
}>;

export type PromotionRoutingDecision = Readonly<{
  readonly decisionId: string;
  readonly decision: RoutingDecision;
}>;

export type PromotionJournalEvent = Readonly<{
  readonly id: string;
  readonly occurredAt: UtcInstant;
  readonly category: "sync" | "routing" | "action" | "recovery" | "administrative";
  readonly subjectId: string;
  readonly correlationId: string;
  readonly payloadVersion: number;
  readonly payloadJson: string;
}>;

export type PromotionWriteBoundary =
  | "message"
  | "placement"
  | "header"
  | "address"
  | "body-part"
  | "attachment"
  | "routing-decision"
  | "local-label"
  | "local-label-assignment"
  | "journal";

export type PromotionFailureInjector = (boundary: PromotionWriteBoundary, ordinal: number) => void;

export type PromoteCanonicalMessageOptions = Readonly<{
  readonly beforeWrite?: PromotionFailureInjector;
}>;

export type PromotionResult = Readonly<{
  readonly messageId: MessageId;
  readonly status: "committed" | "duplicate";
}>;

export type PromotionErrorCode = "write-failed" | "conflicting-identity";

export class CanonicalPromotionError extends Error {
  readonly code: PromotionErrorCode;

  constructor(code: PromotionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CanonicalPromotionError";
    this.code = code;
  }
}

/**
 * Persist one complete promotion unit. The transaction is deliberately owned
 * here: callers cannot observe or interleave the individual table writes.
 */
export function promoteCanonicalMessage(
  database: Database,
  unit: PromotionUnit,
  options: PromoteCanonicalMessageOptions = {},
): PromotionResult {
  const serialized = serializeUnit(unit);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const existing: unknown = database
      .query("SELECT message_id FROM messages WHERE message_id = ?;")
      .get(unit.messageId);
    if (existing !== null) {
      const stored = readPromotion(database, unit.messageId);
      if (stored === undefined || serializeUnit(stored) !== serialized) {
        throw new CanonicalPromotionError(
          "conflicting-identity",
          "canonical message identity already has different promotion content",
        );
      }
      database.exec("COMMIT;");
      return { messageId: unit.messageId, status: "duplicate" };
    }

    const write = createWriter(database, options.beforeWrite);
    write("message", "INSERT INTO messages (message_id) VALUES (?);", [unit.messageId]);
    for (const placement of unit.placements) {
      write(
        "placement",
        "INSERT INTO remote_placements " +
          "(account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);",
        [
          placement.accountId,
          placement.mailboxId,
          placement.uidValidity,
          placement.uid,
          unit.messageId,
        ],
      );
    }
    for (const header of unit.headers) {
      write(
        "header",
        "INSERT INTO message_headers " +
          "(message_id, ordinal, name, normalized_name, value, normalized_value) " +
          "VALUES (?, ?, ?, ?, ?, ?);",
        [
          unit.messageId,
          header.ordinal,
          header.name,
          header.normalizedName,
          header.value,
          header.normalizedValue,
        ],
      );
    }
    for (const address of unit.addresses) {
      write(
        "address",
        "INSERT INTO message_addresses " +
          "(message_id, ordinal, role, position, address, normalized_address, display_name, group_name) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
        [
          unit.messageId,
          address.ordinal,
          address.role,
          address.position,
          address.address,
          address.normalizedAddress,
          address.displayName,
          address.groupName,
        ],
      );
    }
    for (const bodyPart of unit.bodyParts) {
      write(
        "body-part",
        "INSERT INTO message_body_parts " +
          "(message_id, ordinal, content_type, normalized_content_type, blob_id) " +
          "VALUES (?, ?, ?, ?, ?);",
        [
          unit.messageId,
          bodyPart.ordinal,
          bodyPart.contentType,
          bodyPart.normalizedContentType,
          bodyPart.blobId.replace(/^blob:/u, ""),
        ],
      );
    }
    for (const attachment of unit.attachments) {
      write(
        "attachment",
        "INSERT INTO message_attachments " +
          "(message_id, ordinal, filename, content_type, normalized_content_type, disposition, content_id, size, blob_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
        [
          unit.messageId,
          attachment.ordinal,
          attachment.filename,
          attachment.contentType,
          attachment.normalizedContentType,
          attachment.disposition,
          attachment.contentId,
          attachment.size,
          attachment.blobId.replace(/^blob:/u, ""),
        ],
      );
    }
    for (const routing of unit.routingDecisions) {
      const decision = serializeRoutingDecision(routing.decision);
      write(
        "routing-decision",
        "INSERT INTO routing_decisions " +
          "(decision_id, message_id, decision_json) VALUES (?, ?, ?);",
        [routing.decisionId, unit.messageId, decision],
      );
      if (routing.decision.kind === "route") {
        write(
          "local-label",
          "INSERT INTO local_labels (label) VALUES (?) ON CONFLICT(label) DO NOTHING;",
          [routing.decision.label],
        );
        write(
          "local-label-assignment",
          "INSERT INTO local_label_assignments " +
            "(message_id, label, rule_id, rule_version, matched_facts_json, decided_at, " +
            "provenance_source, provenance_evaluation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
          [
            unit.messageId,
            routing.decision.label,
            routing.decision.ruleId,
            routing.decision.ruleVersion,
            JSON.stringify(routing.decision.matchedFacts),
            routing.decision.decidedAt,
            routing.decision.provenance.source,
            routing.decision.provenance.evaluationId,
          ],
        );
      }
    }
    write(
      "journal",
      "INSERT INTO operational_journal " +
        "(id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?);",
      [
        unit.journal.id,
        unit.journal.occurredAt,
        unit.journal.category,
        unit.journal.subjectId,
        unit.journal.correlationId,
        unit.journal.payloadVersion,
        unit.journal.payloadJson,
      ],
    );
    database.exec("COMMIT;");
    return { messageId: unit.messageId, status: "committed" };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new CanonicalPromotionError(
          "write-failed",
          "canonical promotion transaction failed and could not be rolled back",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
    }
    if (error instanceof CanonicalPromotionError) throw error;
    throw new CanonicalPromotionError("write-failed", "canonical promotion transaction failed", {
      cause: error,
    });
  }
}

function createWriter(database: Database, injector: PromotionFailureInjector | undefined) {
  let statementOrdinal = 0;
  return (
    boundary: PromotionWriteBoundary,
    sql: string,
    parameters: readonly SqliteBinding[],
  ): void => {
    statementOrdinal += 1;
    injector?.(boundary, statementOrdinal);
    const query = database.query(sql);
    switch (parameters.length) {
      case 1:
        query.run(parameters[0]);
        return;
      case 2:
        query.run(parameters[0], parameters[1]);
        return;
      case 3:
        query.run(parameters[0], parameters[1], parameters[2]);
        return;
      case 4:
        query.run(parameters[0], parameters[1], parameters[2], parameters[3]);
        return;
      case 5:
        query.run(parameters[0], parameters[1], parameters[2], parameters[3], parameters[4]);
        return;
      case 6:
        query.run(
          parameters[0],
          parameters[1],
          parameters[2],
          parameters[3],
          parameters[4],
          parameters[5],
        );
        return;
      case 7:
        query.run(
          parameters[0],
          parameters[1],
          parameters[2],
          parameters[3],
          parameters[4],
          parameters[5],
          parameters[6],
        );
        return;
      case 8:
        query.run(
          parameters[0],
          parameters[1],
          parameters[2],
          parameters[3],
          parameters[4],
          parameters[5],
          parameters[6],
          parameters[7],
        );
        return;
      case 9:
        query.run(
          parameters[0],
          parameters[1],
          parameters[2],
          parameters[3],
          parameters[4],
          parameters[5],
          parameters[6],
          parameters[7],
          parameters[8],
        );
        return;
      default:
        throw new TypeError("promotion write has an unsupported parameter count");
    }
  };
}

/** Reconstruct a committed promotion through strict unknown-input row decoders. */
export function readCanonicalPromotion(
  database: Database,
  messageId: MessageId,
): PromotionUnit | undefined {
  return readPromotion(database, messageId);
}

function readPromotion(database: Database, messageId: MessageId): PromotionUnit | undefined {
  const messageRow: unknown = database
    .query("SELECT message_id FROM messages WHERE message_id = ?;")
    .get(messageId);
  if (messageRow === null) return undefined;
  const decodedMessage = decodeSqliteRow({
    table: "messages",
    row: messageRow,
    columns: {
      message_id: column((value, context) => decodeCanonicalIdentifier(value, "message", context)),
    },
  });
  const decodedId = decodedMessage.message_id;
  if (typeof decodedId !== "string") throw new TypeError("decoded message ID is not text");

  const placements = database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid FROM remote_placements " +
        "WHERE message_id = ? ORDER BY account_id, mailbox_id, uid_validity, uid;",
    )
    .all(messageId)
    .map((row: unknown) => decodePlacementRow(row));
  const headers = database
    .query(
      "SELECT ordinal, name, normalized_name, value, normalized_value FROM message_headers " +
        "WHERE message_id = ? ORDER BY ordinal;",
    )
    .all(messageId)
    .map((row: unknown) => decodeHeaderRow(row));
  const addresses = database
    .query(
      "SELECT ordinal, role, position, address, normalized_address, display_name, group_name " +
        "FROM message_addresses WHERE message_id = ? ORDER BY ordinal;",
    )
    .all(messageId)
    .map((row: unknown) => decodeAddressRow(row));
  const bodyParts = database
    .query(
      "SELECT ordinal, content_type, normalized_content_type, blob_id FROM message_body_parts " +
        "WHERE message_id = ? ORDER BY ordinal;",
    )
    .all(messageId)
    .map((row: unknown) => decodeBodyPartRow(row));
  const attachments = database
    .query(
      "SELECT ordinal, filename, content_type, normalized_content_type, disposition, content_id, size, blob_id " +
        "FROM message_attachments WHERE message_id = ? ORDER BY ordinal;",
    )
    .all(messageId)
    .map((row: unknown) => decodeAttachmentRow(row));
  const routingDecisions = database
    .query(
      "SELECT decision_id, message_id, decision_json FROM routing_decisions " +
        "WHERE message_id = ? ORDER BY decision_id;",
    )
    .all(messageId)
    .map((row: unknown) => decodeRoutingRow(row));
  const journalRows = database
    .query(
      "SELECT id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE subject_id = ? ORDER BY id;",
    )
    .all(messageId)
    .map((row: unknown) => decodeJournalRow(row));
  if (journalRows.length !== 1) return undefined;
  return {
    messageId: parseMessageId(decodedId),
    placements,
    headers,
    addresses,
    bodyParts,
    attachments,
    routingDecisions,
    journal: journalRows[0],
  };
}

function column(decode: SqliteRowColumn["decode"], nullable = false): SqliteRowColumn {
  return nullable ? { decode, nullable: true } : { decode };
}

function decodePlacementRow(row: unknown): PromotionPlacement {
  const value = decodeSqliteRow({
    table: "remote_placements",
    row,
    columns: {
      account_id: column((input, context) => decodeCanonicalIdentifier(input, "account", context)),
      mailbox_id: column((input, context) => decodeCanonicalIdentifier(input, "mailbox", context)),
      uid_validity: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1 }),
      ),
      uid: column((input, context) => decodeBoundedSafeInteger(input, { ...context, minimum: 1 })),
    },
  });
  return {
    accountId: parseAccountId(value.account_id),
    mailboxId: parseMailboxId(value.mailbox_id),
    uidValidity: numberValue(value.uid_validity),
    uid: numberValue(value.uid),
  };
}

function decodeHeaderRow(row: unknown): PromotionHeader {
  const value = decodeSqliteRow({
    table: "message_headers",
    row,
    columns: textColumns("name", "normalized_name", "value", "normalized_value"),
  });
  return {
    ordinal: numberValue(value.ordinal),
    name: stringValue(value.name),
    normalizedName: stringValue(value.normalized_name),
    value: stringValue(value.value),
    normalizedValue: stringValue(value.normalized_value),
  };
}

function decodeAddressRow(row: unknown): PromotionAddress {
  const value = decodeSqliteRow({
    table: "message_addresses",
    row,
    columns: {
      ordinal: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1 }),
      ),
      role: column((input, context) =>
        decodeClosedEnum(input, {
          ...context,
          values: ["from", "sender", "reply_to", "to", "cc", "bcc"] as const,
        }),
      ),
      position: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1 }),
      ),
      address: column(textDecoder),
      normalized_address: column(textDecoder),
      display_name: column(decodeNullable(textDecoder), true),
      group_name: column(decodeNullable(textDecoder), true),
    },
  });
  return {
    ordinal: numberValue(value.ordinal),
    role: parseAddressRole(value.role),
    position: numberValue(value.position),
    address: stringValue(value.address),
    normalizedAddress: stringValue(value.normalized_address),
    displayName: nullableString(value.display_name),
    groupName: nullableString(value.group_name),
  };
}

function decodeBodyPartRow(row: unknown): PromotionBodyPart {
  const value = decodeSqliteRow({
    table: "message_body_parts",
    row,
    columns: {
      ordinal: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1 }),
      ),
      content_type: column(textDecoder),
      normalized_content_type: column(textDecoder),
      blob_id: column(decodeStoredBlobId),
    },
  });
  return {
    ordinal: numberValue(value.ordinal),
    contentType: stringValue(value.content_type),
    normalizedContentType: stringValue(value.normalized_content_type),
    blobId: blobValue(value.blob_id),
  };
}

function decodeAttachmentRow(row: unknown): PromotionAttachment {
  const value = decodeSqliteRow({
    table: "message_attachments",
    row,
    columns: {
      ordinal: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1 }),
      ),
      filename: column(decodeNullable(textDecoder), true),
      content_type: column(textDecoder),
      normalized_content_type: column(textDecoder),
      disposition: column(decodeNullable(textDecoder), true),
      content_id: column(decodeNullable(textDecoder), true),
      size: column((input, context) => decodeBoundedSafeInteger(input, { ...context, minimum: 0 })),
      blob_id: column(decodeStoredBlobId),
    },
  });
  return {
    ordinal: numberValue(value.ordinal),
    filename: nullableString(value.filename),
    contentType: stringValue(value.content_type),
    normalizedContentType: stringValue(value.normalized_content_type),
    disposition: nullableString(value.disposition),
    contentId: nullableString(value.content_id),
    size: numberValue(value.size),
    blobId: blobValue(value.blob_id),
  };
}

function decodeRoutingRow(row: unknown): PromotionRoutingDecision {
  const value = decodeSqliteRow({
    table: "routing_decisions",
    row,
    columns: {
      decision_id: column(textDecoder),
      message_id: column((input, context) => decodeCanonicalIdentifier(input, "message", context)),
      decision_json: column(textDecoder),
    },
  });
  return {
    decisionId: stringValue(value.decision_id),
    decision: parseRoutingDecision(value.decision_json),
  };
}

function decodeJournalRow(row: unknown): PromotionJournalEvent {
  const value = decodeSqliteRow({
    table: "operational_journal",
    row,
    columns: {
      id: column(textDecoder),
      occurred_at: column(decodeUtcMillisecondInstant),
      category: column((input, context) =>
        decodeClosedEnum(input, {
          ...context,
          values: ["sync", "routing", "action", "recovery", "administrative"] as const,
        }),
      ),
      subject_id: column(textDecoder),
      correlation_id: column(textDecoder),
      payload_version: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 255 }),
      ),
      payload_json: column(textDecoder),
    },
  });
  return {
    id: stringValue(value.id),
    occurredAt: parseUtcInstant(value.occurred_at),
    category: parseJournalCategory(value.category),
    subjectId: stringValue(value.subject_id),
    correlationId: stringValue(value.correlation_id),
    payloadVersion: numberValue(value.payload_version),
    payloadJson: stringValue(value.payload_json),
  };
}

function textColumns(...names: readonly string[]): Record<string, SqliteRowColumn> {
  const columns: Record<string, SqliteRowColumn> = {
    ordinal: column((input, context) =>
      decodeBoundedSafeInteger(input, { ...context, minimum: 1 }),
    ),
  };
  for (const name of names) columns[name] = column(textDecoder);
  return columns;
}

type SqliteBinding = string | number | bigint | boolean | null | Uint8Array;

function decodeStoredBlobId(
  value: unknown,
  context: { readonly table: string; readonly column: string },
): BlobId {
  if (typeof value !== "string") throw new TypeError(`invalid ${context.table}.${context.column}`);
  return parseBlobId(`blob:${value}`);
}

function blobValue(value: unknown): BlobId {
  if (typeof value !== "string") throw new TypeError("decoded blob ID is not text");
  return parseBlobId(value);
}

function parseAddressRole(value: unknown): PromotionAddress["role"] {
  if (
    value === "from" ||
    value === "sender" ||
    value === "reply_to" ||
    value === "to" ||
    value === "cc" ||
    value === "bcc"
  )
    return value;
  throw new TypeError("decoded address role is invalid");
}

function parseJournalCategory(value: unknown): PromotionJournalEvent["category"] {
  if (
    value === "sync" ||
    value === "routing" ||
    value === "action" ||
    value === "recovery" ||
    value === "administrative"
  )
    return value;
  throw new TypeError("decoded journal category is invalid");
}

function textDecoder(
  value: unknown,
  context: { readonly table: string; readonly column: string },
): string {
  if (typeof value !== "string") throw new TypeError(`invalid ${context.table}.${context.column}`);
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("decoded value is not text");
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return stringValue(value);
}

function numberValue(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("decoded value is not numeric");
  return value;
}

function serializeUnit(unit: PromotionUnit): string {
  return JSON.stringify({
    messageId: unit.messageId,
    placements: unit.placements,
    headers: unit.headers,
    addresses: unit.addresses,
    bodyParts: unit.bodyParts,
    attachments: unit.attachments,
    routingDecisions: unit.routingDecisions.map((routing) => ({
      decisionId: routing.decisionId,
      decision: serializeRoutingDecision(routing.decision),
    })),
    journal: unit.journal,
  });
}
