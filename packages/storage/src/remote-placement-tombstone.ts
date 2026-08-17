import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  createRemoteUidValue,
  createTombstoneReason,
  createUidValidity,
  createUtcInstant,
  parseAccountId,
  parseMailboxId,
  parseMessageId,
  parseUtcInstant,
  type AccountId,
  type MailboxId,
  type MessageId,
  type RemoteUidValue,
  type TombstoneReason,
  type UtcInstant,
  type UidValidity,
} from "@agent-mail/core";
import {
  decodeBoundedSafeInteger,
  decodeClosedEnum,
  decodeNullable,
  decodeSqliteRow,
  decodeUtcMillisecondInstant,
  type SqliteColumnContext,
  type SqliteRowColumn,
} from "./row-decoders";

const JOURNAL_PAYLOAD_VERSION = 1;
const JOURNAL_KIND = "remote-placement-tombstone";
const JOURNAL_CATEGORY = "sync" as const;

type RecordValue = Readonly<Record<string, unknown>>;

export type RemotePlacementIdentity = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
}>;

/** Input remains unknown-shaped so the repository owns its trust boundary. */
export type RemotePlacementTombstoneInput = Readonly<{
  readonly accountId: unknown;
  readonly mailboxId: unknown;
  readonly uidValidity: unknown;
  readonly uid: unknown;
  readonly observedAt: unknown;
  readonly sourceCheckpoint: unknown;
  readonly reason: unknown;
}>;

export type RemotePlacementTombstone = Readonly<{
  readonly identity: RemotePlacementIdentity;
  readonly messageId: MessageId;
  readonly observedAt: UtcInstant;
  readonly sourceCheckpoint: string;
  readonly reason: TombstoneReason;
  readonly journalId: string;
}>;

export type RemotePlacementTombstoneResult = Readonly<{
  readonly status: "tombstoned" | "already-tombstoned";
  readonly tombstone: RemotePlacementTombstone;
}>;

export type RemotePlacementRecord = Readonly<{
  readonly identity: RemotePlacementIdentity;
  readonly messageId: MessageId;
  readonly tombstone: RemotePlacementTombstone | null;
}>;

export type RemotePlacementTombstoneErrorCode =
  | "invalid-input"
  | "not-found"
  | "conflicting-tombstone"
  | "missing-provenance"
  | "write-failed";

export class RemotePlacementTombstoneError extends Error {
  readonly code: RemotePlacementTombstoneErrorCode;

  constructor(code: RemotePlacementTombstoneErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemotePlacementTombstoneError";
    this.code = code;
  }
}

/**
 * Parse one remote-placement tombstone request before opening a transaction.
 * The source checkpoint is kept as an opaque, bounded correlation value: its
 * producer owns checkpoint semantics, while this repository preserves it.
 */
export function parseRemotePlacementTombstoneInput(value: unknown): Readonly<{
  readonly identity: RemotePlacementIdentity;
  readonly observedAt: UtcInstant;
  readonly sourceCheckpoint: string;
  readonly reason: TombstoneReason;
}> {
  const record = requireRecord(value, "remote placement tombstone input");
  requireExactKeys(record, [
    "accountId",
    "mailboxId",
    "uidValidity",
    "uid",
    "observedAt",
    "sourceCheckpoint",
    "reason",
  ]);
  try {
    return {
      identity: {
        accountId: parseAccountId(record.accountId),
        mailboxId: parseMailboxId(record.mailboxId),
        uidValidity: createUidValidity(record.uidValidity),
        uid: createRemoteUidValue(record.uid),
      },
      observedAt: createUtcInstant(record.observedAt),
      sourceCheckpoint: boundedText(record.sourceCheckpoint, "source checkpoint", 200),
      reason: createTombstoneReason(record.reason),
    };
  } catch (error: unknown) {
    if (error instanceof RemotePlacementTombstoneError) throw error;
    throw new RemotePlacementTombstoneError(
      "invalid-input",
      "remote placement tombstone input is invalid",
      {
        cause: error,
      },
    );
  }
}

/**
 * Persist one placement-to-tombstone transition and its immutable journal
 * provenance. Both writes share the same SQLite transaction.
 */
export function tombstoneRemotePlacement(
  database: Database,
  value: RemotePlacementTombstoneInput,
): RemotePlacementTombstoneResult {
  const input = parseRemotePlacementTombstoneInput(value);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const current = readPlacement(database, input.identity);
    if (current === undefined) {
      throw new RemotePlacementTombstoneError(
        "not-found",
        "remote placement does not exist and cannot be tombstoned",
      );
    }

    const expected = buildTombstone(current, input);
    if (current.tombstone !== null) {
      if (!sameTombstone(current.tombstone, expected)) {
        throw new RemotePlacementTombstoneError(
          "conflicting-tombstone",
          "remote placement already has different tombstone provenance",
        );
      }
      const event = readJournalEvent(database, expected.journalId);
      if (event === undefined) {
        throw new RemotePlacementTombstoneError(
          "missing-provenance",
          "remote placement tombstone is missing its journal provenance",
        );
      }
      if (!sameJournalEvent(event, expected)) {
        throw new RemotePlacementTombstoneError(
          "conflicting-tombstone",
          "remote placement tombstone journal provenance differs",
        );
      }
      database.exec("COMMIT;");
      transactionStarted = false;
      return { status: "already-tombstoned", tombstone: expected };
    }

    database
      .query(
        "UPDATE remote_placements SET tombstone_observed_at = ?, tombstone_reason = ? " +
          "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND uid = ? " +
          "AND tombstone_observed_at IS NULL AND tombstone_reason IS NULL;",
      )
      .run(
        expected.observedAt,
        expected.reason,
        expected.identity.accountId,
        expected.identity.mailboxId,
        expected.identity.uidValidity,
        expected.identity.uid,
      );

    const payloadJson = serializeJournalPayload(expected);
    database
      .query(
        "INSERT INTO operational_journal " +
          "(id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        expected.journalId,
        expected.observedAt,
        JOURNAL_CATEGORY,
        placementSubjectId(expected.identity),
        expected.sourceCheckpoint,
        JOURNAL_PAYLOAD_VERSION,
        payloadJson,
      );

    const saved = readPlacement(database, input.identity);
    if (saved?.tombstone === null || saved === undefined) {
      throw new Error("remote placement tombstone disappeared during transaction");
    }
    if (!sameTombstone(saved.tombstone, expected)) {
      throw new Error("remote placement tombstone changed during transaction");
    }
    database.exec("COMMIT;");
    transactionStarted = false;
    return { status: "tombstoned", tombstone: expected };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new RemotePlacementTombstoneError(
          "write-failed",
          "remote placement tombstone transaction failed and could not be rolled back",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
    }
    if (error instanceof RemotePlacementTombstoneError) throw error;
    throw new RemotePlacementTombstoneError(
      "write-failed",
      "remote placement tombstone transaction failed",
      { cause: error },
    );
  }
}

/** Read a placement and its journal-backed tombstone through strict row decoders. */
export function readRemotePlacement(
  database: Database,
  value: Readonly<{
    readonly accountId: unknown;
    readonly mailboxId: unknown;
    readonly uidValidity: unknown;
    readonly uid: unknown;
  }>,
): RemotePlacementRecord | undefined {
  const identity = parseIdentity(value);
  return readPlacement(database, identity);
}

function readPlacement(
  database: Database,
  identity: RemotePlacementIdentity,
): RemotePlacementRecord | undefined {
  const row: unknown = database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid, message_id, " +
        "tombstone_observed_at, tombstone_reason " +
        "FROM remote_placements WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND uid = ?;",
    )
    .get(identity.accountId, identity.mailboxId, identity.uidValidity, identity.uid);
  if (row === null) return undefined;
  const decoded = decodeSqliteRow({
    table: "remote_placements",
    row,
    columns: {
      account_id: column((input, context) => parseAccountId(textValue(input, context))),
      mailbox_id: column((input, context) => parseMailboxId(textValue(input, context))),
      uid_validity: column((input, context) =>
        createUidValidity(
          decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 4294967295 }),
        ),
      ),
      uid: column((input, context) =>
        createRemoteUidValue(
          decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 4294967295 }),
        ),
      ),
      message_id: column((input, context) => parseMessageId(textValue(input, context))),
      tombstone_observed_at: column(decodeNullable(decodeUtcMillisecondInstant), true),
      tombstone_reason: column(
        decodeNullable((input, context) => createTombstoneReason(textValue(input, context))),
        true,
      ),
    },
  });
  const decodedIdentity: RemotePlacementIdentity = {
    accountId: readAccountId(decoded, "account_id"),
    mailboxId: readMailboxId(decoded, "mailbox_id"),
    uidValidity: readUidValidity(decoded, "uid_validity"),
    uid: readRemoteUid(decoded, "uid"),
  };
  const observedAt = readNullable(decoded, "tombstone_observed_at", parseInstant);
  const reason = readNullable(decoded, "tombstone_reason", parseReason);
  if ((observedAt === null) !== (reason === null)) {
    throw new RemotePlacementTombstoneError(
      "write-failed",
      "remote placement tombstone columns are inconsistent",
    );
  }
  if (observedAt === null || reason === null) {
    return {
      identity: decodedIdentity,
      messageId: readMessageId(decoded, "message_id"),
      tombstone: null,
    };
  }
  const messageId = readMessageId(decoded, "message_id");
  const subjectId = placementSubjectId(decodedIdentity);
  const event = readJournalEventForSubject(database, subjectId);
  if (event === undefined) {
    throw new RemotePlacementTombstoneError(
      "missing-provenance",
      "remote placement tombstone is missing its journal provenance",
    );
  }
  const provenance = decodeJournalPayload(event.payloadJson, decodedIdentity, messageId, event);
  if (provenance.observedAt !== observedAt || provenance.reason !== reason) {
    throw new RemotePlacementTombstoneError(
      "missing-provenance",
      "remote placement tombstone columns differ from journal provenance",
    );
  }
  return {
    identity: decodedIdentity,
    messageId,
    tombstone: {
      identity: decodedIdentity,
      messageId,
      observedAt,
      sourceCheckpoint: provenance.sourceCheckpoint,
      reason,
      journalId: event.id,
    },
  };
}

type JournalEvent = Readonly<{
  readonly id: string;
  readonly occurredAt: UtcInstant;
  readonly category: typeof JOURNAL_CATEGORY;
  readonly subjectId: string;
  readonly correlationId: string;
  readonly payloadVersion: number;
  readonly payloadJson: string;
}>;

function readJournalEvent(database: Database, id: string): JournalEvent | undefined {
  const row: unknown = database
    .query(
      "SELECT id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE id = ?;",
    )
    .get(id);
  return row === null ? undefined : decodeJournalRow(row);
}

function readJournalEventForSubject(
  database: Database,
  subjectId: string,
): JournalEvent | undefined {
  const rows: readonly unknown[] = database
    .query(
      "SELECT id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE subject_id = ? ORDER BY id;",
    )
    .all(subjectId);
  if (rows.length !== 1) return undefined;
  return decodeJournalRow(rows[0]);
}

function decodeJournalRow(row: unknown): JournalEvent {
  const decoded = decodeSqliteRow({
    table: "operational_journal",
    row,
    columns: {
      id: column((input) => boundedText(input, "journal id", 200)),
      occurred_at: column(decodeUtcMillisecondInstant),
      category: column((input, context) =>
        decodeClosedEnum(input, { ...context, values: [JOURNAL_CATEGORY] as const }),
      ),
      subject_id: column((input) => boundedText(input, "journal subject", 200)),
      correlation_id: column((input) => boundedText(input, "journal correlation", 200)),
      payload_version: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 255 }),
      ),
      payload_json: column((input) => boundedText(input, "journal payload", 16384)),
    },
  });
  return {
    id: readText(decoded, "id"),
    occurredAt: readInstant(decoded, "occurred_at"),
    category: JOURNAL_CATEGORY,
    subjectId: readText(decoded, "subject_id"),
    correlationId: readText(decoded, "correlation_id"),
    payloadVersion: readNumber(decoded, "payload_version"),
    payloadJson: readText(decoded, "payload_json"),
  };
}

function decodeJournalPayload(
  payloadJson: string,
  identity: RemotePlacementIdentity,
  messageId: MessageId,
  event: JournalEvent,
): Readonly<{
  readonly observedAt: UtcInstant;
  readonly sourceCheckpoint: string;
  readonly reason: TombstoneReason;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (error: unknown) {
    throw new RemotePlacementTombstoneError(
      "missing-provenance",
      "tombstone journal payload is invalid",
      {
        cause: error,
      },
    );
  }
  const payload = requireRecord(parsed, "tombstone journal payload");
  requireExactKeys(payload, [
    "kind",
    "version",
    "observedAt",
    "sourceCheckpoint",
    "reason",
    "priorPlacement",
  ]);
  if (payload.kind !== JOURNAL_KIND || payload.version !== JOURNAL_PAYLOAD_VERSION) {
    throw new RemotePlacementTombstoneError(
      "missing-provenance",
      "tombstone journal payload version is invalid",
    );
  }
  const sourceCheckpoint = boundedText(payload.sourceCheckpoint, "source checkpoint", 200);
  const reason = createTombstoneReason(payload.reason);
  const observedAt = parseUtcInstant(payload.observedAt);
  const prior = parsePriorPlacement(payload.priorPlacement);
  if (
    event.id !== journalIdForPayload(payloadJson) ||
    observedAt !== event.occurredAt ||
    sourceCheckpoint !== event.correlationId ||
    event.subjectId !== placementSubjectId(identity) ||
    !sameIdentity(prior.identity, identity) ||
    prior.messageId !== messageId
  ) {
    throw new RemotePlacementTombstoneError(
      "missing-provenance",
      "tombstone journal provenance is inconsistent",
    );
  }
  return { observedAt, sourceCheckpoint, reason };
}

function parsePriorPlacement(
  value: unknown,
): Readonly<{ readonly identity: RemotePlacementIdentity; readonly messageId: MessageId }> {
  const record = requireRecord(value, "prior placement");
  requireExactKeys(record, ["accountId", "mailboxId", "uidValidity", "uid", "messageId"]);
  return {
    identity: {
      accountId: parseAccountId(record.accountId),
      mailboxId: parseMailboxId(record.mailboxId),
      uidValidity: createUidValidity(record.uidValidity),
      uid: createRemoteUidValue(record.uid),
    },
    messageId: parseMessageId(record.messageId),
  };
}

function parseIdentity(value: unknown): RemotePlacementIdentity {
  const record = requireRecord(value, "remote placement identity");
  requireExactKeys(record, ["accountId", "mailboxId", "uidValidity", "uid"]);
  return {
    accountId: parseAccountId(record.accountId),
    mailboxId: parseMailboxId(record.mailboxId),
    uidValidity: createUidValidity(record.uidValidity),
    uid: createRemoteUidValue(record.uid),
  };
}

function buildTombstone(
  current: RemotePlacementRecord,
  input: Readonly<{
    readonly identity: RemotePlacementIdentity;
    readonly observedAt: UtcInstant;
    readonly sourceCheckpoint: string;
    readonly reason: TombstoneReason;
  }>,
): RemotePlacementTombstone {
  const payload = {
    kind: JOURNAL_KIND,
    version: JOURNAL_PAYLOAD_VERSION,
    observedAt: input.observedAt,
    sourceCheckpoint: input.sourceCheckpoint,
    reason: input.reason,
    priorPlacement: {
      accountId: current.identity.accountId,
      mailboxId: current.identity.mailboxId,
      uidValidity: current.identity.uidValidity,
      uid: current.identity.uid,
      messageId: current.messageId,
    },
  };
  const payloadJson = JSON.stringify(payload);
  const journalId = journalIdForPayload(payloadJson);
  return {
    identity: current.identity,
    messageId: current.messageId,
    observedAt: input.observedAt,
    sourceCheckpoint: input.sourceCheckpoint,
    reason: input.reason,
    journalId,
  };
}

function serializeJournalPayload(tombstone: RemotePlacementTombstone): string {
  return JSON.stringify({
    kind: JOURNAL_KIND,
    version: JOURNAL_PAYLOAD_VERSION,
    observedAt: tombstone.observedAt,
    sourceCheckpoint: tombstone.sourceCheckpoint,
    reason: tombstone.reason,
    priorPlacement: {
      accountId: tombstone.identity.accountId,
      mailboxId: tombstone.identity.mailboxId,
      uidValidity: tombstone.identity.uidValidity,
      uid: tombstone.identity.uid,
      messageId: tombstone.messageId,
    },
  });
}

function journalIdForPayload(payloadJson: string): string {
  return `event:remote-placement-tombstone:${sha256(payloadJson)}`;
}

function sameJournalEvent(event: JournalEvent, expected: RemotePlacementTombstone): boolean {
  return (
    event.id === expected.journalId &&
    event.occurredAt === expected.observedAt &&
    event.category === JOURNAL_CATEGORY &&
    event.subjectId === placementSubjectId(expected.identity) &&
    event.correlationId === expected.sourceCheckpoint &&
    event.payloadVersion === JOURNAL_PAYLOAD_VERSION &&
    event.payloadJson === serializeJournalPayload(expected)
  );
}

function sameTombstone(left: RemotePlacementTombstone, right: RemotePlacementTombstone): boolean {
  return (
    left.identity.accountId === right.identity.accountId &&
    left.identity.mailboxId === right.identity.mailboxId &&
    left.identity.uidValidity === right.identity.uidValidity &&
    left.identity.uid === right.identity.uid &&
    left.messageId === right.messageId &&
    left.observedAt === right.observedAt &&
    left.sourceCheckpoint === right.sourceCheckpoint &&
    left.reason === right.reason &&
    left.journalId === right.journalId
  );
}

function sameIdentity(left: RemotePlacementIdentity, right: RemotePlacementIdentity): boolean {
  return (
    left.accountId === right.accountId &&
    left.mailboxId === right.mailboxId &&
    left.uidValidity === right.uidValidity &&
    left.uid === right.uid
  );
}

function placementSubjectId(identity: RemotePlacementIdentity): string {
  return `placement:${sha256(
    JSON.stringify([identity.accountId, identity.mailboxId, identity.uidValidity, identity.uid]),
  )}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function column(decode: SqliteRowColumn["decode"], nullable = false): SqliteRowColumn {
  return nullable ? { decode, nullable: true } : { decode };
}

function textValue(value: unknown, context: SqliteColumnContext): string {
  if (typeof value !== "string")
    throw new TypeError(`${context.table}.${context.column} must be text`);
  return value;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > maximum ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`${name} must be a bounded, non-empty trimmed string`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && ((code >= 0 && code <= 31) || (code >= 127 && code <= 159))) {
      return true;
    }
  }
  return false;
}

function requireRecord(value: unknown, name: string): RecordValue {
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: RecordValue, keys: readonly string[]): void {
  const expected = new Set(keys);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new TypeError("value has unknown or missing fields");
  }
}

function readDecoded(value: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key))
    throw new TypeError(`decoded row is missing ${key}`);
  return value[key];
}

function readNullable<T>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  decode: (value: unknown) => T,
): T | null {
  const result = readDecoded(value, key);
  return result === null ? null : decode(result);
}

function readText(value: Readonly<Record<string, unknown>>, key: string): string {
  return textValue(readDecoded(value, key), { table: "decoded row", column: key });
}

function readNumber(value: Readonly<Record<string, unknown>>, key: string): number {
  const result = readDecoded(value, key);
  if (typeof result !== "number" || !Number.isSafeInteger(result)) {
    throw new TypeError(`decoded row ${key} is not a safe integer`);
  }
  return result;
}

function readInstant(value: Readonly<Record<string, unknown>>, key: string): UtcInstant {
  return parseUtcInstant(readDecoded(value, key));
}

function readAccountId(value: Readonly<Record<string, unknown>>, key: string): AccountId {
  return parseAccountId(readDecoded(value, key));
}

function readMailboxId(value: Readonly<Record<string, unknown>>, key: string): MailboxId {
  return parseMailboxId(readDecoded(value, key));
}

function readMessageId(value: Readonly<Record<string, unknown>>, key: string): MessageId {
  return parseMessageId(readDecoded(value, key));
}

function readUidValidity(value: Readonly<Record<string, unknown>>, key: string): UidValidity {
  return createUidValidity(readDecoded(value, key));
}

function readRemoteUid(value: Readonly<Record<string, unknown>>, key: string): RemoteUidValue {
  return createRemoteUidValue(readDecoded(value, key));
}

function parseInstant(value: unknown): UtcInstant {
  return parseUtcInstant(value);
}

function parseReason(value: unknown): TombstoneReason {
  return createTombstoneReason(value);
}
