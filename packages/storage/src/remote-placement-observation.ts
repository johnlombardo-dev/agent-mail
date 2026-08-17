import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  createMonotonicSequence,
  createRemoteUidValue,
  createUidValidity,
  createUtcInstant,
  parseAccountId,
  parseMailboxId,
  parseMessageId,
  type AccountId,
  type MailboxId,
  type MessageId,
  type MonotonicSequence,
  type RemoteUidValue,
  type UidValidity,
  type UtcInstant,
} from "@agent-mail/core";
import {
  decodeBoundedSafeInteger,
  decodeClosedEnum,
  decodeNullable,
  decodeSqliteBoolean,
  decodeSqliteRow,
  decodeUtcMillisecondInstant,
  type SqliteColumnContext,
  type SqliteRowColumn,
} from "./row-decoders";

const JOURNAL_PAYLOAD_VERSION = 1;
const JOURNAL_CATEGORY = "sync" as const;
const JOURNAL_KIND = "remote-placement-observation";
const MAX_FLAG_COUNT = 512;
const MAX_FLAG_BYTES = 128;
const MAX_CHECKPOINT_BYTES = 200;
const MAX_MODSEQ = Number.MAX_SAFE_INTEGER;

type RecordValue = Readonly<Record<string, unknown>>;

export type RemotePlacementObservationModseq =
  | Readonly<{ readonly kind: "known"; readonly value: MonotonicSequence }>
  | Readonly<{ readonly kind: "unknown" }>;

export type RemotePlacementObservationInput = Readonly<{
  readonly accountId: unknown;
  readonly mailboxId: unknown;
  readonly uidValidity: unknown;
  readonly uid: unknown;
  readonly internalDate: unknown;
  readonly flags: unknown;
  readonly modseq: unknown;
  /** Positive, caller-supplied ordering fact. Zero is never a valid observation. */
  readonly observationOrder: unknown;
  readonly observedAt: unknown;
  /** Mailbox/checkpoint identity used to order and audit unknown MODSEQ facts. */
  readonly sourceCheckpoint: unknown;
}>;

export type RemotePlacementObservationIdentity = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
}>;

export type RemotePlacementObservation = Readonly<{
  readonly identity: RemotePlacementObservationIdentity;
  readonly messageId: MessageId;
  readonly internalDate: UtcInstant;
  readonly flags: readonly string[];
  readonly modseq: RemotePlacementObservationModseq;
  readonly observationOrder: number;
  readonly observedAt: UtcInstant;
  readonly sourceCheckpoint: string;
  readonly journalId: string;
}>;

type StoredPlacementObservation = Readonly<{
  readonly identity: RemotePlacementObservationIdentity;
  readonly messageId: MessageId;
  readonly internalDate: UtcInstant | null;
  readonly flags: readonly string[];
  readonly modseq: RemotePlacementObservationModseq;
  readonly observationOrder: number;
  readonly observedAt: UtcInstant | null;
  readonly sourceCheckpoint: string | null;
  readonly journalId: string | null;
}>;

export type RemotePlacementObservationResult = Readonly<{
  readonly status: "applied" | "already-applied" | "stale";
  readonly observation: RemotePlacementObservation;
}>;

export type RemotePlacementObservationErrorCode =
  | "invalid-input"
  | "not-found"
  | "stale-observation"
  | "conflicting-observation"
  | "internal-date-conflict"
  | "missing-provenance"
  | "write-failed";

export class RemotePlacementObservationError extends Error {
  readonly code: RemotePlacementObservationErrorCode;

  constructor(code: RemotePlacementObservationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemotePlacementObservationError";
    this.code = code;
  }
}

type ParsedInput = Readonly<{
  readonly identity: RemotePlacementObservationIdentity;
  readonly internalDate: UtcInstant;
  readonly flags: readonly string[];
  readonly modseq: RemotePlacementObservationModseq;
  readonly observationOrder: number;
  readonly observedAt: UtcInstant;
  readonly sourceCheckpoint: string;
}>;

/** Parse all observation data before taking the SQLite write lock. */
export function parseRemotePlacementObservationInput(value: unknown): ParsedInput {
  const record = requireRecord(value, "remote placement observation input");
  requireExactKeys(record, [
    "accountId",
    "mailboxId",
    "uidValidity",
    "uid",
    "internalDate",
    "flags",
    "modseq",
    "observationOrder",
    "observedAt",
    "sourceCheckpoint",
  ]);
  try {
    return {
      identity: {
        accountId: parseAccountId(record.accountId),
        mailboxId: parseMailboxId(record.mailboxId),
        uidValidity: createUidValidity(record.uidValidity),
        uid: createRemoteUidValue(record.uid),
      },
      internalDate: createUtcInstant(record.internalDate),
      flags: normalizeFlags(record.flags),
      modseq: parseModseq(record.modseq),
      observationOrder: positiveSafeInteger(record.observationOrder, "observation order"),
      observedAt: createUtcInstant(record.observedAt),
      sourceCheckpoint: boundedText(record.sourceCheckpoint, "source checkpoint", MAX_CHECKPOINT_BYTES),
    };
  } catch (error: unknown) {
    if (error instanceof RemotePlacementObservationError) throw error;
    throw new RemotePlacementObservationError("invalid-input", "remote placement observation input is invalid", {
      cause: error,
    });
  }
}

/**
 * Apply one observation to an existing placement. The placement update and
 * its versioned journal event are one SQLite transaction.
 */
export function observeRemotePlacement(
  database: Database,
  value: RemotePlacementObservationInput,
): RemotePlacementObservationResult {
  const input = parseRemotePlacementObservationInput(value);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const current = readStoredPlacementObservation(database, input.identity);
    if (current === undefined) {
      throw new RemotePlacementObservationError(
        "not-found",
        "remote placement does not exist and cannot be observed",
      );
    }
    if (current.internalDate !== null && current.internalDate !== input.internalDate) {
      throw new RemotePlacementObservationError(
        "internal-date-conflict",
        "remote placement INTERNALDATE is immutable",
      );
    }

    const currentHasObservation = current.observationOrder > 0;
    if (currentHasObservation) {
      const currentObservation = completeObservation(current);
      if (
        currentObservation.modseq.kind === "known" &&
        input.modseq.kind === "known" &&
        currentObservation.modseq.value === input.modseq.value
      ) {
        if (!sameFlags(currentObservation.flags, input.flags)) {
          throw new RemotePlacementObservationError(
            "conflicting-observation",
            "equal MODSEQ has conflicting placement flags",
          );
        }
        assertCurrentJournal(database, currentObservation);
        database.exec("COMMIT;");
        transactionStarted = false;
        return { status: "already-applied", observation: currentObservation };
      }
      const order = compareObservationVersion(current, input);
      if (order < 0) {
        database.exec("COMMIT;");
        transactionStarted = false;
        return { status: "stale", observation: currentObservation };
      }
      if (order === 0) {
        if (!sameObservationFacts(currentObservation, input)) {
          throw new RemotePlacementObservationError(
            "conflicting-observation",
            "equal placement observation version has conflicting flags or MODSEQ",
          );
        }
        assertCurrentJournal(database, currentObservation);
        database.exec("COMMIT;");
        transactionStarted = false;
        return { status: "already-applied", observation: currentObservation };
      }
    }

    const next = observationFromInput(current, input);
    const payloadJson = serializeJournalPayload(next);
    database
      .query(
        "UPDATE remote_placements SET internal_date = COALESCE(internal_date, ?), flags_json = ?, modseq_known = ?, modseq = ?, " +
          "observation_order = ?, observation_observed_at = ?, observation_checkpoint = ? " +
          "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND uid = ?;",
      )
      .run(
        next.internalDate,
        JSON.stringify(next.flags),
        next.modseq.kind === "known" ? 1 : 0,
        next.modseq.kind === "known" ? next.modseq.value : null,
        next.observationOrder,
        next.observedAt,
        next.sourceCheckpoint,
        next.identity.accountId,
        next.identity.mailboxId,
        next.identity.uidValidity,
        next.identity.uid,
      );
    database
      .query(
        "INSERT INTO operational_journal " +
          "(id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        next.journalId,
        next.observedAt,
        JOURNAL_CATEGORY,
        observationSubjectId(next.identity),
        next.sourceCheckpoint,
        JOURNAL_PAYLOAD_VERSION,
        payloadJson,
      );

    const saved = readStoredPlacementObservation(database, input.identity);
    if (saved === undefined || !sameObservation(completeObservation(saved), next)) {
      throw new Error("remote placement observation changed during transaction");
    }
    database.exec("COMMIT;");
    transactionStarted = false;
    return { status: "applied", observation: next };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new RemotePlacementObservationError(
          "write-failed",
          "remote placement observation transaction failed and could not be rolled back",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
    }
    if (error instanceof RemotePlacementObservationError) throw error;
    throw new RemotePlacementObservationError("write-failed", "remote placement observation transaction failed", {
      cause: error,
    });
  }
}

/** Reopen-safe read of the exact placement-scoped observation state. */
export function readRemotePlacementObservation(
  database: Database,
  value: unknown,
): RemotePlacementObservation | undefined {
  const identity = parseIdentity(value);
  const stored = readStoredPlacementObservation(database, identity);
  if (stored === undefined || stored.observationOrder === 0) return undefined;
  if (
    stored.internalDate === null ||
    stored.observedAt === null ||
    stored.sourceCheckpoint === null ||
    stored.journalId === null
  ) {
    throw new RemotePlacementObservationError("write-failed", "placement observation provenance is incomplete");
  }
  return stored as RemotePlacementObservation;
}

/** Alias for callers that use the shorter repository terminology. */
export const readPlacementObservation = readRemotePlacementObservation;

function readStoredPlacementObservation(
  database: Database,
  identity: RemotePlacementObservationIdentity,
): StoredPlacementObservation | undefined {
  const row: unknown = database
    .query(
      "SELECT rp.account_id, rp.mailbox_id, rp.uid_validity, rp.uid, rp.message_id, " +
        "rp.internal_date, rp.flags_json, rp.modseq_known, rp.modseq, rp.observation_order, " +
        "rp.observation_observed_at, rp.observation_checkpoint " +
        "FROM remote_placements AS rp " +
        "WHERE rp.account_id = ? AND rp.mailbox_id = ? AND rp.uid_validity = ? AND rp.uid = ?;",
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
        createUidValidity(decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 4294967295 })),
      ),
      uid: column((input, context) =>
        createRemoteUidValue(decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 4294967295 })),
      ),
      message_id: column((input, context) => parseMessageId(textValue(input, context))),
      internal_date: column(decodeNullable(decodeUtcMillisecondInstant), true),
      flags_json: column((input, context) => decodeFlagsJson(input, context)),
      modseq_known: column(decodeSqliteBoolean),
      modseq: column(
        decodeNullable((input, context) =>
          createMonotonicSequence(
            decodeBoundedSafeInteger(input, { ...context, minimum: 0, maximum: MAX_MODSEQ }),
          ),
        ),
        true,
      ),
      observation_order: column((input, context) =>
        decodeBoundedSafeInteger(input, { ...context, minimum: 0, maximum: MAX_MODSEQ }),
      ),
      observation_observed_at: column(decodeNullable(decodeUtcMillisecondInstant), true),
      observation_checkpoint: column(
        decodeNullable((input, context) => boundedText(textValue(input, context), "observation checkpoint", MAX_CHECKPOINT_BYTES)),
        true,
      ),
    },
  });
  const result = decodedObservation(decoded);
  if (result.observationOrder === 0) {
    if (result.internalDate !== null || result.flags.length !== 0 || result.observedAt !== null || result.sourceCheckpoint !== null) {
      throw new RemotePlacementObservationError("write-failed", "unobserved placement has observation state");
    }
    if (result.modseq.kind !== "unknown") {
      throw new RemotePlacementObservationError("write-failed", "unobserved placement has MODSEQ state");
    }
    return {
      identity: result.identity,
      messageId: result.messageId,
      internalDate: null,
      flags: [],
      modseq: { kind: "unknown" },
      observationOrder: 0,
      observedAt: null,
      sourceCheckpoint: null,
      journalId: null,
    };
  }
  if (result.internalDate === null || result.observedAt === null || result.sourceCheckpoint === null) {
    throw new RemotePlacementObservationError("write-failed", "placement observation provenance is incomplete");
  }
  const observation = {
    identity: result.identity,
    messageId: result.messageId,
    internalDate: result.internalDate,
    flags: result.flags,
    modseq: result.modseq,
    observationOrder: result.observationOrder,
    observedAt: result.observedAt,
    sourceCheckpoint: result.sourceCheckpoint,
    journalId: journalIdForPayload(
      serializeJournalPayload({
        identity: result.identity,
        messageId: result.messageId,
        internalDate: result.internalDate,
        flags: result.flags,
        modseq: result.modseq,
        observationOrder: result.observationOrder,
        observedAt: result.observedAt,
        sourceCheckpoint: result.sourceCheckpoint,
        journalId: "",
      }),
    ),
  } satisfies RemotePlacementObservation;
  assertCurrentJournal(database, observation);
  return observation;
}

type DecodedObservation = Readonly<{
  readonly identity: RemotePlacementObservationIdentity;
  readonly messageId: MessageId;
  readonly internalDate: UtcInstant | null;
  readonly flags: readonly string[];
  readonly modseq: RemotePlacementObservationModseq;
  readonly observationOrder: number;
  readonly observedAt: UtcInstant | null;
  readonly sourceCheckpoint: string | null;
}>;

function decodedObservation(decoded: Readonly<Record<string, unknown>>): DecodedObservation {
  const known = readBoolean(decoded, "modseq_known");
  const modseq = readNullable(decoded, "modseq");
  if (known === (modseq === null)) {
    throw new RemotePlacementObservationError("write-failed", "placement MODSEQ columns are inconsistent");
  }
  return {
    identity: {
      accountId: readAccountId(decoded, "account_id"),
      mailboxId: readMailboxId(decoded, "mailbox_id"),
      uidValidity: readUidValidity(decoded, "uid_validity"),
      uid: readUid(decoded, "uid"),
    },
    messageId: readMessageId(decoded, "message_id"),
    internalDate: readNullable(decoded, "internal_date"),
    flags: readFlags(decoded, "flags_json"),
    modseq: known
      ? { kind: "known", value: modseq as MonotonicSequence }
      : { kind: "unknown" },
    observationOrder: readNumber(decoded, "observation_order"),
    observedAt: readNullable(decoded, "observation_observed_at"),
    sourceCheckpoint: readNullable(decoded, "observation_checkpoint"),
  };
}

function observationFromInput(
  current: DecodedObservation,
  input: ParsedInput,
): RemotePlacementObservation {
  const base = {
    identity: current.identity,
    messageId: current.messageId,
    internalDate: input.internalDate,
    flags: input.flags,
    modseq: input.modseq,
    observationOrder: input.observationOrder,
    observedAt: input.observedAt,
    sourceCheckpoint: input.sourceCheckpoint,
    journalId: "",
  } satisfies Omit<RemotePlacementObservation, "journalId"> & { readonly journalId: string };
  return { ...base, journalId: journalIdForPayload(serializeJournalPayload(base)) };
}

function compareObservationVersion(current: DecodedObservation, input: ParsedInput): number {
  if (current.modseq.kind === "known" && input.modseq.kind === "known") {
    if (input.modseq.value !== current.modseq.value) {
      return input.modseq.value > current.modseq.value ? 1 : -1;
    }
  }
  if (input.observationOrder !== current.observationOrder) {
    return input.observationOrder > current.observationOrder ? 1 : -1;
  }
  return 0;
}

function sameObservationFacts(current: DecodedObservation, input: ParsedInput): boolean {
  return (
    sameFlags(current.flags, input.flags) &&
    sameModseq(current.modseq, input.modseq) &&
    current.observationOrder === input.observationOrder &&
    current.internalDate === input.internalDate
  );
}

function completeObservation(stored: StoredPlacementObservation): RemotePlacementObservation {
  if (
    stored.internalDate === null ||
    stored.observedAt === null ||
    stored.sourceCheckpoint === null ||
    stored.journalId === null
  ) {
    throw new RemotePlacementObservationError("write-failed", "placement observation provenance is incomplete");
  }
  return stored as RemotePlacementObservation;
}

function sameObservation(left: RemotePlacementObservation, right: RemotePlacementObservation): boolean {
  return (
    left.journalId === right.journalId &&
    left.identity.accountId === right.identity.accountId &&
    left.identity.mailboxId === right.identity.mailboxId &&
    left.identity.uidValidity === right.identity.uidValidity &&
    left.identity.uid === right.identity.uid &&
    left.messageId === right.messageId &&
    left.internalDate === right.internalDate &&
    sameFlags(left.flags, right.flags) &&
    sameModseq(left.modseq, right.modseq) &&
    left.observationOrder === right.observationOrder &&
    left.observedAt === right.observedAt &&
    left.sourceCheckpoint === right.sourceCheckpoint
  );
}

function assertCurrentJournal(database: Database, observation: RemotePlacementObservation): void {
  const row: unknown = database
    .query(
      "SELECT id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE id = ?;",
    )
    .get(observation.journalId);
  if (row === null) {
    throw new RemotePlacementObservationError("missing-provenance", "placement observation is missing its journal provenance");
  }
  const decoded = decodeSqliteRow({
    table: "operational_journal",
    row,
    columns: {
      id: column((input) => boundedText(input, "journal id", 200)),
      occurred_at: column(decodeUtcMillisecondInstant),
      category: column((input, context) => decodeClosedEnum(input, { ...context, values: [JOURNAL_CATEGORY] as const })),
      subject_id: column((input) => boundedText(input, "journal subject", 200)),
      correlation_id: column((input) => boundedText(input, "journal correlation", MAX_CHECKPOINT_BYTES)),
      payload_version: column((input, context) => decodeBoundedSafeInteger(input, { ...context, minimum: 1, maximum: 255 })),
      payload_json: column((input) => boundedText(input, "journal payload", 16384)),
    },
  });
  if (
    readText(decoded, "id") !== observation.journalId ||
    readInstant(decoded, "occurred_at") !== observation.observedAt ||
    readText(decoded, "subject_id") !== observationSubjectId(observation.identity) ||
    readText(decoded, "correlation_id") !== observation.sourceCheckpoint ||
    readNumber(decoded, "payload_version") !== JOURNAL_PAYLOAD_VERSION ||
    readText(decoded, "payload_json") !== serializeJournalPayload(observation)
  ) {
    throw new RemotePlacementObservationError("missing-provenance", "placement observation journal provenance differs");
  }
}

function serializeJournalPayload(observation: Omit<RemotePlacementObservation, "journalId"> | RemotePlacementObservation): string {
  return JSON.stringify({
    kind: JOURNAL_KIND,
    version: JOURNAL_PAYLOAD_VERSION,
    accountId: observation.identity.accountId,
    mailboxId: observation.identity.mailboxId,
    uidValidity: observation.identity.uidValidity,
    uid: observation.identity.uid,
    messageId: observation.messageId,
    internalDate: observation.internalDate,
    flags: observation.flags,
    modseq: observation.modseq,
    observationOrder: observation.observationOrder,
    observedAt: observation.observedAt,
    sourceCheckpoint: observation.sourceCheckpoint,
  });
}

function journalIdForPayload(payloadJson: string): string {
  return `event:remote-placement-observation:${sha256(payloadJson)}`;
}

function observationSubjectId(identity: RemotePlacementObservationIdentity): string {
  return `placement-observation:${sha256(JSON.stringify([identity.accountId, identity.mailboxId, identity.uidValidity, identity.uid]))}`;
}

function parseModseq(value: unknown): RemotePlacementObservationModseq {
  const record = requireRecord(value, "MODSEQ");
  if (record.kind === "unknown") {
    requireExactKeys(record, ["kind"]);
    return { kind: "unknown" };
  }
  requireExactKeys(record, ["kind", "value"]);
  if (record.kind !== "known") throw new TypeError("MODSEQ kind must be known or unknown");
  return { kind: "known", value: createMonotonicSequence(record.value) };
}

function normalizeFlags(value: unknown): readonly string[] {
  const values = value instanceof Set ? [...value] : value;
  if (!Array.isArray(values) || values.length > MAX_FLAG_COUNT) {
    throw new TypeError("placement flags must be an array or Set within the flag limit");
  }
  const flags = values.map((item) => {
    if (typeof item !== "string") throw new TypeError("placement flags must contain strings");
    const normalized = item.normalize("NFC");
    if (
      normalized.length === 0 ||
      normalized !== normalized.trim() ||
      Buffer.byteLength(normalized, "utf8") > MAX_FLAG_BYTES ||
      hasControlCharacters(normalized)
    ) {
      throw new TypeError("placement flag is empty, untrimmed, unsafe, or too long");
    }
    return normalized;
  });
  if (new Set(flags).size !== flags.length) throw new TypeError("placement flags must be unique");
  flags.sort();
  return Object.freeze(flags);
}

function decodeFlagsJson(value: unknown, context: SqliteColumnContext): readonly string[] {
  if (typeof value !== "string") throw new TypeError(`${context.table}.${context.column} must be text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("placement flags JSON is invalid");
  }
  const flags = normalizeFlags(parsed);
  if (JSON.stringify(flags) !== value) throw new TypeError("placement flags JSON is not canonical");
  return flags;
}

function parseIdentity(value: unknown): RemotePlacementObservationIdentity {
  const record = requireRecord(value, "remote placement identity");
  requireExactKeys(record, ["accountId", "mailboxId", "uidValidity", "uid"]);
  return {
    accountId: parseAccountId(record.accountId),
    mailboxId: parseMailboxId(record.mailboxId),
    uidValidity: createUidValidity(record.uidValidity),
    uid: createRemoteUidValue(record.uid),
  };
}

function requireRecord(value: unknown, name: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as RecordValue;
}

function requireExactKeys(record: RecordValue, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(record).some((key) => !expected.has(key)) || keys.some((key) => !(key in record))) {
    throw new TypeError("input has missing or unknown fields");
  }
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || value !== value.trim() || Buffer.byteLength(value, "utf8") > maximum || hasControlCharacters(value)) {
    throw new TypeError(`${name} must be bounded, non-empty, trimmed text`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function textValue(value: unknown, context: SqliteColumnContext): string {
  if (typeof value !== "string") throw new TypeError(`${context.table}.${context.column} must be text`);
  return value;
}

function column(decode: SqliteRowColumn["decode"], nullable = false): SqliteRowColumn {
  return nullable ? { decode, nullable: true } : { decode };
}

function readText(value: Readonly<Record<string, unknown>>, key: string): string {
  return value[key] as string;
}

function readNumber(value: Readonly<Record<string, unknown>>, key: string): number {
  return value[key] as number;
}

function readBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return value[key] as boolean;
}

function readInstant(value: Readonly<Record<string, unknown>>, key: string): UtcInstant {
  return value[key] as UtcInstant;
}

function readNullable<T>(value: Readonly<Record<string, unknown>>, key: string): T | null {
  return value[key] as T | null;
}

function readFlags(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  return value[key] as readonly string[];
}

function readAccountId(value: Readonly<Record<string, unknown>>, key: string): AccountId {
  return value[key] as AccountId;
}

function readMailboxId(value: Readonly<Record<string, unknown>>, key: string): MailboxId {
  return value[key] as MailboxId;
}

function readUidValidity(value: Readonly<Record<string, unknown>>, key: string): UidValidity {
  return value[key] as UidValidity;
}

function readUid(value: Readonly<Record<string, unknown>>, key: string): RemoteUidValue {
  return value[key] as RemoteUidValue;
}

function readMessageId(value: Readonly<Record<string, unknown>>, key: string): MessageId {
  return value[key] as MessageId;
}

function sameFlags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((flag, index) => flag === right[index]);
}

function sameModseq(
  left: RemotePlacementObservationModseq,
  right: RemotePlacementObservationModseq,
): boolean {
  return left.kind === right.kind && (left.kind === "unknown" || left.value === (right as { readonly value: MonotonicSequence }).value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
