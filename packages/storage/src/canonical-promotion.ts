import { Database } from "bun:sqlite";
import {
  createUtcInstant,
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
import { canonicalRoutingDecisionId } from "./routing-decision-identity";
import { parseRoutingDecisionOrigin, type RoutingDecisionOrigin } from "./routing-decision-origin";
import { normalizeThreadFacts } from "./thread-normalizer";
import { ThreadGraphRepository } from "./thread-graph-repository";
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
  readonly rawSource: PromotionBlobReference;
  readonly placements: readonly PromotionPlacement[];
  readonly headers: readonly PromotionHeader[];
  readonly addresses: readonly PromotionAddress[];
  readonly bodyParts: readonly PromotionBodyPart[];
  readonly attachments: readonly PromotionAttachment[];
  readonly routingDecisions: readonly PromotionRoutingDecision[];
  readonly journal: PromotionJournalEvent;
}>;

/** Authoritative content-addressed blob evidence captured at promotion time. */
export type PromotionBlobReference = Readonly<{
  readonly blobId: BlobId;
  readonly size: number;
}>;

export type PromotionPlacement = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: number;
  readonly uid: number;
  readonly internalDate: UtcInstant;
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
  readonly size: number;
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
  /** Non-identity caller observations persisted beside the canonical decision. */
  readonly origins?: readonly RoutingDecisionOrigin[];
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
  | "blob-reference"
  | "routing-decision"
  | "routing-origin"
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
      const write = createWriter(database, options.beforeWrite);
      for (const routing of unit.routingDecisions) {
        writeRoutingOrigins(write, unit.messageId, routing);
      }
      promoteThreadFacts(database, unit);
      database.exec("COMMIT;");
      return { messageId: unit.messageId, status: "duplicate" };
    }

    const write = createWriter(database, options.beforeWrite);
    write("message", "INSERT INTO messages (message_id) VALUES (?);", [unit.messageId]);
    write(
      "blob-reference",
      "INSERT INTO message_blob_references " +
        "(message_id, kind, ordinal, blob_id, size) VALUES (?, ?, ?, ?, ?);",
      [
        unit.messageId,
        "raw-eml",
        1,
        unit.rawSource.blobId.replace(/^blob:/u, ""),
        unit.rawSource.size,
      ],
    );
    for (const bodyPart of unit.bodyParts) {
      write(
        "blob-reference",
        "INSERT INTO message_blob_references " +
          "(message_id, kind, ordinal, blob_id, size) VALUES (?, ?, ?, ?, ?);",
        [
          unit.messageId,
          "body-part",
          bodyPart.ordinal,
          bodyPart.blobId.replace(/^blob:/u, ""),
          bodyPart.size,
        ],
      );
    }
    for (const attachment of unit.attachments) {
      write(
        "blob-reference",
        "INSERT INTO message_blob_references " +
          "(message_id, kind, ordinal, blob_id, size) VALUES (?, ?, ?, ?, ?);",
        [
          unit.messageId,
          "attachment",
          attachment.ordinal,
          attachment.blobId.replace(/^blob:/u, ""),
          attachment.size,
        ],
      );
    }
    for (const placement of unit.placements) {
      write(
        "placement",
        "INSERT INTO remote_placements " +
          "(account_id, mailbox_id, uid_validity, uid, message_id, internal_date) VALUES (?, ?, ?, ?, ?, ?);",
        [
          placement.accountId,
          placement.mailboxId,
          placement.uidValidity,
          placement.uid,
          unit.messageId,
          placement.internalDate,
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
      const decisionId = canonicalRoutingDecisionId(unit.messageId, routing.decision);
      write(
        "routing-decision",
        "INSERT INTO routing_decisions " +
          "(decision_id, message_id, rule_id, rule_version, matched_facts_json, decision_json) " +
          "VALUES (?, ?, ?, ?, ?, ?);",
        [
          decisionId,
          unit.messageId,
          routing.decision.ruleId,
          routing.decision.ruleVersion,
          JSON.stringify(routing.decision.matchedFacts),
          decision,
        ],
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
      writeRoutingOrigins(write, unit.messageId, routing);
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
    promoteThreadFacts(database, unit);
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

/** Submit bounded normalized header facts only when the thread extension is composed. */
function promoteThreadFacts(database: Database, unit: PromotionUnit): void {
  if (!hasTable(database, "thread_generation") || unit.placements.length === 0) return;
  const accounts = new Set(unit.placements.map((placement) => placement.accountId));
  const headers = unit.headers.map((header) => ({
    ordinal: header.ordinal,
    normalizedName: header.normalizedName,
    value: header.value,
  }));
  const participants = unit.addresses
    .filter(
      (
        address,
      ): address is PromotionAddress &
        Readonly<{ readonly role: "from" | "sender" | "to" | "cc" }> =>
        address.role === "from" ||
        address.role === "sender" ||
        address.role === "to" ||
        address.role === "cc",
    )
    .map((address) => ({
      address: address.normalizedAddress,
      displayName: address.displayName,
      role: address.role,
      position: address.position,
    }));
  const repository = new ThreadGraphRepository(database);
  for (const accountId of accounts) {
    const receivedAt = unit.placements
      .filter((placement) => placement.accountId === accountId)
      .map((placement) => placement.internalDate)
      .sort()[0];
    const facts = normalizeThreadFacts({
      accountId,
      messageId: unit.messageId,
      contentState: "parsed",
      headers,
      sentAt: parseStructuredSentAt(unit.headers),
      receivedAt,
      participants,
    });
    repository.ingestFactsInTransaction(facts);
  }
}

function hasTable(database: Database, name: string): boolean {
  return (
    database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?;")
      .get(name) !== null
  );
}

const RFC_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|GMT|UT|UTC)$/iu;

/** Structured-content owns Date parsing; the thread normalizer receives UTC or null. */
function parseStructuredSentAt(headers: readonly PromotionHeader[]): UtcInstant | null {
  const dateHeaders = headers.filter((header) => header.normalizedName === "date");
  if (dateHeaders.length !== 1) return null;
  const value = dateHeaders[0]?.value;
  if (value === undefined) return null;
  try {
    return parseUtcInstant(value);
  } catch {
    if (!RFC_DATE.test(value)) return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    try {
      return createUtcInstant(new Date(timestamp).toISOString());
    } catch {
      return null;
    }
  }
}

function writeRoutingOrigins(
  write: ReturnType<typeof createWriter>,
  messageId: MessageId,
  routing: PromotionRoutingDecision,
): void {
  const decisionId = canonicalRoutingDecisionId(messageId, routing.decision);
  for (const origin of routing.origins ?? []) {
    write(
      "routing-origin",
      "INSERT INTO routing_decision_origins " +
        "(decision_id, caller_source, observed_at, evaluation_id) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(decision_id, caller_source) DO NOTHING;",
      [decisionId, origin.callerSource, origin.observedAt, origin.evaluationId],
    );
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
      "SELECT account_id, mailbox_id, uid_validity, uid, internal_date FROM remote_placements " +
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
      "SELECT decision_id, message_id, rule_id, rule_version, matched_facts_json, decision_json " +
        "FROM routing_decisions " +
        "WHERE message_id = ? ORDER BY decision_id;",
    )
    .all(messageId)
    .map((row: unknown) => {
      const routing = decodeRoutingRow(row);
      const originTable: unknown = database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'routing_decision_origins';",
        )
        .get();
      if (originTable === null) return routing;
      const origins = database
        .query(
          "SELECT caller_source, observed_at, evaluation_id FROM routing_decision_origins " +
            "WHERE decision_id = ? ORDER BY caller_source;",
        )
        .all(routing.decisionId)
        .map((origin: unknown) => decodeRoutingOriginRow(origin));
      return origins.length === 0 ? routing : { ...routing, origins };
    });
  const journalRows = database
    .query(
      "SELECT id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE subject_id = ? ORDER BY id;",
    )
    .all(messageId)
    .map((row: unknown) => decodeJournalRow(row));
  if (journalRows.length !== 1) return undefined;
  const references = database
    .query(
      "SELECT kind, ordinal, blob_id, size FROM message_blob_references " +
        "WHERE message_id = ? ORDER BY kind, ordinal;",
    )
    .all(messageId)
    .map((row: unknown) => decodeBlobReferenceRow(row));
  const rawSource = references.find((reference) => reference.kind === "raw-eml");
  if (
    rawSource === undefined ||
    references.filter((reference) => reference.kind === "raw-eml").length !== 1
  ) {
    return undefined;
  }
  const bodyReferences = new Map(
    references
      .filter((reference) => reference.kind === "body-part")
      .map((reference) => [reference.ordinal, reference]),
  );
  const attachmentReferences = new Map(
    references
      .filter((reference) => reference.kind === "attachment")
      .map((reference) => [reference.ordinal, reference]),
  );
  if (
    bodyReferences.size !== bodyParts.length ||
    attachmentReferences.size !== attachments.length
  ) {
    return undefined;
  }
  const bodyPartsWithSizes = bodyParts.map((bodyPart) => {
    const reference = bodyReferences.get(bodyPart.ordinal);
    if (reference === undefined || reference.blob.blobId !== bodyPart.blobId) {
      throw new TypeError("body part blob reference does not match its content row");
    }
    return { ...bodyPart, size: reference.blob.size };
  });
  const attachmentsWithSizes = attachments.map((attachment) => {
    const reference = attachmentReferences.get(attachment.ordinal);
    if (reference === undefined || reference.blob.blobId !== attachment.blobId) {
      throw new TypeError("attachment blob reference does not match its content row");
    }
    return { ...attachment, size: reference.blob.size };
  });
  return {
    messageId: parseMessageId(decodedId),
    rawSource: rawSource.blob,
    placements,
    headers,
    addresses,
    bodyParts: bodyPartsWithSizes,
    attachments: attachmentsWithSizes,
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
      internal_date: column(decodeUtcMillisecondInstant),
    },
  });
  return {
    accountId: parseAccountId(value.account_id),
    mailboxId: parseMailboxId(value.mailbox_id),
    uidValidity: numberValue(value.uid_validity),
    uid: numberValue(value.uid),
    internalDate: parseUtcInstant(value.internal_date),
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
    size: 0,
    blobId: blobValue(value.blob_id),
  };
}

type BlobReferenceRow = Readonly<{
  readonly kind: "raw-eml" | "body-part" | "attachment";
  readonly ordinal: number;
  readonly blob: PromotionBlobReference;
}>;

function decodeBlobReferenceRow(row: unknown): BlobReferenceRow {
  const value = decodeSqliteRow({
    table: "message_blob_references",
    row,
    columns: {
      kind: column((input, context) =>
        decodeClosedEnum(input, {
          ...context,
          values: ["raw-eml", "body-part", "attachment"] as const,
        }),
      ),
      ordinal: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1 }),
      ),
      blob_id: column(decodeStoredBlobId),
      size: column((input, context) => decodeBoundedSafeInteger(input, { ...context, minimum: 0 })),
    },
  });
  const kind = value.kind;
  if (kind !== "raw-eml" && kind !== "body-part" && kind !== "attachment") {
    throw new TypeError("decoded blob reference kind is invalid");
  }
  return {
    kind,
    ordinal: numberValue(value.ordinal),
    blob: { blobId: blobValue(value.blob_id), size: numberValue(value.size) },
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
      rule_id: column(textDecoder),
      rule_version: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1 }),
      ),
      matched_facts_json: column(textDecoder),
      decision_json: column(textDecoder),
    },
  });
  const decision = parseRoutingDecision(value.decision_json);
  const decisionId = stringValue(value.decision_id);
  const messageId = parseMessageId(stringValue(value.message_id));
  if (
    decision.ruleId !== value.rule_id ||
    decision.ruleVersion !== value.rule_version ||
    JSON.stringify(decision.matchedFacts) !== value.matched_facts_json ||
    decisionId !== canonicalRoutingDecisionId(messageId, decision)
  ) {
    throw new TypeError("routing decision row identity does not match its decision");
  }
  return {
    decisionId,
    decision,
  };
}

function decodeRoutingOriginRow(row: unknown): RoutingDecisionOrigin {
  const value = decodeSqliteRow({
    table: "routing_decision_origins",
    row,
    columns: {
      caller_source: column((input) => {
        if (input !== "direct-ingestion" && input !== "recurring-sweep") {
          throw new TypeError("invalid routing origin caller source");
        }
        return input;
      }),
      observed_at: column(decodeUtcMillisecondInstant),
      evaluation_id: column(textDecoder),
    },
  });
  return parseRoutingDecisionOrigin({
    callerSource: value.caller_source,
    observedAt: value.observed_at,
    evaluationId: value.evaluation_id,
  });
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
    rawSource: unit.rawSource,
    placements: unit.placements,
    headers: unit.headers,
    addresses: unit.addresses,
    bodyParts: unit.bodyParts,
    attachments: unit.attachments,
    routingDecisions: unit.routingDecisions.map((routing) => ({
      decisionId: canonicalRoutingDecisionId(unit.messageId, routing.decision),
      decision: serializeRoutingDecision(routing.decision),
    })),
    journal: unit.journal,
  });
}
