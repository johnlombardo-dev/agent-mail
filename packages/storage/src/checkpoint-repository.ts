import { Database } from "bun:sqlite";
import {
  createMonotonicSequence,
  createStreamingOffset,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  createRemoteUidValue,
  type AccountId,
  type CheckpointValue,
  type MailboxId,
  type MonotonicSequence,
  type RemoteUidValue,
  type StreamingOffset,
  type UidValidity,
} from "@agent-mail/core";
import type { Migration } from "./migration-runner";
import { messageCatalogMigration } from "./migrations/0001-message-catalog";
import {
  decodeBoundedSafeInteger,
  decodeNullable,
  decodeSqliteBoolean,
  decodeSqliteRow,
  type SqliteColumnContext,
} from "./row-decoders";

/**
 * This is an extension of issue #61's mailbox_checkpoints table. The parent
 * migration remains authoritative for its account/mailbox/UIDVALIDITY key and
 * its placement foreign key. The application migration registry must compose
 * this standalone version-2 definition with #61's version-1 definition (and
 * any other standalone migrations) into one contiguous, immutable sequence.
 */
export const MAILBOX_CHECKPOINT_MIGRATION_VERSION = 2;

export const mailboxCheckpointMigration = {
  version: MAILBOX_CHECKPOINT_MIGRATION_VERSION,
  name: "mailbox-checkpoint-extension",
  sql: `
ALTER TABLE mailbox_checkpoints
  ADD COLUMN uid_next_known INTEGER NOT NULL DEFAULT 0
    CHECK (uid_next_known IN (0, 1));

ALTER TABLE mailbox_checkpoints
  ADD COLUMN uid_next INTEGER
    CHECK (
      (uid_next_known = 0 AND uid_next IS NULL) OR
      (
        uid_next_known = 1 AND
        typeof(uid_next) = 'integer' AND
        uid_next > 0 AND
        uid_next <= 4294967295
      )
    );

ALTER TABLE mailbox_checkpoints
  ADD COLUMN modseq_known INTEGER NOT NULL DEFAULT 0
    CHECK (modseq_known IN (0, 1));

ALTER TABLE mailbox_checkpoints
  ADD COLUMN modseq INTEGER
    CHECK (
      (modseq_known = 0 AND modseq IS NULL) OR
      (
        modseq_known = 1 AND
        typeof(modseq) = 'integer' AND
        modseq >= 0 AND
        modseq <= 9007199254740991
      )
    );

ALTER TABLE mailbox_checkpoints
  ADD COLUMN sweep_cursor INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(sweep_cursor) = 'integer' AND
      sweep_cursor >= 0 AND
      sweep_cursor <= 9007199254740991
    );

ALTER TABLE mailbox_checkpoints
  ADD COLUMN backfill_completed INTEGER NOT NULL DEFAULT 0
    CHECK (backfill_completed IN (0, 1));

ALTER TABLE mailbox_checkpoints
  ADD COLUMN observed_version INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(observed_version) = 'integer' AND
      observed_version >= 0 AND
      observed_version <= 9007199254740991
    );

ALTER TABLE mailbox_checkpoints
  ADD COLUMN storage_version INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(storage_version) = 'integer' AND
      storage_version >= 1 AND
      storage_version <= 255
    );
`,
} satisfies Migration;

/** The extension alone is retained for an application registry that composes all migrations. */
export const mailboxCheckpointExtensionMigrations = [mailboxCheckpointMigration] as const;

/** A dependency-complete set is convenient for focused checkpoint tests. */
export const mailboxCheckpointMigrations = [
  messageCatalogMigration,
  mailboxCheckpointMigration,
] as const;

type CheckpointValueInput<T> =
  | Readonly<{ readonly kind: "known"; readonly value: T }>
  | Readonly<{ readonly kind: "unknown" }>;

export type MailboxCheckpointInput = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uidNext: CheckpointValueInput<RemoteUidValue>;
  readonly modseq: CheckpointValueInput<MonotonicSequence>;
  readonly sweepCursor: StreamingOffset;
  readonly backfillCompleted: boolean;
}>;

export type MailboxCheckpoint = MailboxCheckpointInput &
  Readonly<{
    readonly observedVersion: number;
    readonly storageVersion: number;
  }>;

export type SaveMailboxCheckpointInput = Readonly<{
  readonly checkpoint: MailboxCheckpointInput;
  /** Zero creates a row; otherwise this must match the stored observed version. */
  readonly expectedVersion: number;
}>;

export class StaleMailboxCheckpointError extends Error {
  readonly code = "stale-checkpoint" as const;
  readonly expectedVersion: number;
  readonly actualVersion: number | undefined;

  constructor(expectedVersion: number, actualVersion: number | undefined) {
    super("mailbox checkpoint observed version is stale");
    this.name = "StaleMailboxCheckpointError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** Parse untrusted checkpoint input before beginning the SQLite transaction. */
export function parseMailboxCheckpointInput(value: unknown): MailboxCheckpointInput {
  if (!isRecord(value)) throw new TypeError("mailbox checkpoint input must be an object");
  assertKeys(
    value,
    [
      "accountId",
      "mailboxId",
      "uidValidity",
      "uidNext",
      "modseq",
      "sweepCursor",
      "backfillCompleted",
    ],
    ["observedVersion", "storageVersion"],
  );
  if ("observedVersion" in value) parseExpectedVersion(value.observedVersion);
  if ("storageVersion" in value) parseExpectedVersion(value.storageVersion);
  return {
    accountId: parseAccountId(value.accountId),
    mailboxId: parseMailboxId(value.mailboxId),
    uidValidity: createUidValidity(value.uidValidity),
    uidNext: parseCheckpointValue(value.uidNext, createRemoteUidValue),
    modseq: parseCheckpointValue(value.modseq, createMonotonicSequence),
    sweepCursor: createStreamingOffset(value.sweepCursor),
    backfillCompleted: parseBoolean(value.backfillCompleted, "backfillCompleted"),
  };
}

function parseCheckpointValue<T>(
  value: unknown,
  create: (input: unknown) => T,
): CheckpointValueInput<T> {
  if (!isRecord(value)) throw new TypeError("checkpoint value must be an object");
  if (value.kind === "unknown") {
    assertExactKeys(value, ["kind"]);
    return { kind: "unknown" };
  }
  if (value.kind === "known") {
    assertExactKeys(value, ["kind", "value"]);
    return { kind: "known", value: create(value.value) };
  }
  throw new TypeError("checkpoint value kind is invalid");
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function parseExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("expectedVersion must be a non-negative safe integer");
  }
  return value;
}

/** Read one checkpoint through the strict unknown-input SQLite row boundary. */
export function readMailboxCheckpoint(
  database: Database,
  identity: Readonly<{
    readonly accountId: AccountId;
    readonly mailboxId: MailboxId;
    readonly uidValidity: UidValidity;
  }>,
): MailboxCheckpoint | undefined {
  const row: unknown = database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid_next_known, uid_next, " +
        "modseq_known, modseq, sweep_cursor, backfill_completed, observed_version, storage_version " +
        "FROM mailbox_checkpoints WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ?;",
    )
    .get(identity.accountId, identity.mailboxId, identity.uidValidity);
  return row === null ? undefined : decodeCheckpointRow(row);
}

/**
 * Save one checkpoint in an IMMEDIATE transaction. The update predicate is a
 * compare-and-swap on observed_version; a stale writer never updates a field.
 */
export function saveMailboxCheckpoint(
  database: Database,
  value: SaveMailboxCheckpointInput,
): MailboxCheckpoint {
  const checkpoint = parseMailboxCheckpointInput(value.checkpoint);
  const expectedVersion = parseExpectedVersion(value.expectedVersion);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const current = readMailboxCheckpoint(database, checkpoint);
    if (current === undefined) {
      if (expectedVersion !== 0) throw new StaleMailboxCheckpointError(expectedVersion, undefined);
      insertCheckpoint(database, checkpoint);
    } else {
      if (current.observedVersion !== expectedVersion) {
        throw new StaleMailboxCheckpointError(expectedVersion, current.observedVersion);
      }
      updateCheckpoint(database, checkpoint, expectedVersion);
    }
    const saved = readMailboxCheckpoint(database, checkpoint);
    if (saved === undefined) throw new Error("mailbox checkpoint disappeared during transaction");
    database.exec("COMMIT;");
    return saved;
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], "mailbox checkpoint rollback failed");
      }
    }
    throw error;
  }
}

export function createMailboxCheckpointRepository(database: Database): Readonly<{
  readonly read: (
    identity: Readonly<{
      readonly accountId: AccountId;
      readonly mailboxId: MailboxId;
      readonly uidValidity: UidValidity;
    }>,
  ) => MailboxCheckpoint | undefined;
  readonly save: (value: SaveMailboxCheckpointInput) => MailboxCheckpoint;
}> {
  return {
    read: (identity) => readMailboxCheckpoint(database, identity),
    save: (value) => saveMailboxCheckpoint(database, value),
  };
}

function insertCheckpoint(database: Database, checkpoint: MailboxCheckpointInput): void {
  const values = checkpointParameters(checkpoint);
  database
    .query(
      "INSERT INTO mailbox_checkpoints " +
        "(account_id, mailbox_id, uid_validity, uid_next_known, uid_next, modseq_known, modseq, " +
        "sweep_cursor, backfill_completed, observed_version, storage_version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1);",
    )
    .run(...values, 1);
}

function updateCheckpoint(
  database: Database,
  checkpoint: MailboxCheckpointInput,
  expectedVersion: number,
): void {
  const values = checkpointParameters(checkpoint);
  const result = database
    .query(
      "UPDATE mailbox_checkpoints SET uid_next_known = ?, uid_next = ?, modseq_known = ?, modseq = ?, " +
        "sweep_cursor = ?, backfill_completed = ?, observed_version = observed_version + 1 " +
        "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND observed_version = ?;",
    )
    .run(
      values[3],
      values[4],
      values[5],
      values[6],
      values[7],
      values[8],
      values[0],
      values[1],
      values[2],
      expectedVersion,
    );
  if (result.changes !== 1) {
    const current = readMailboxCheckpoint(database, checkpoint);
    throw new StaleMailboxCheckpointError(expectedVersion, current?.observedVersion);
  }
}

function checkpointParameters(
  checkpoint: MailboxCheckpointInput,
): readonly [
  AccountId,
  MailboxId,
  UidValidity,
  number,
  RemoteUidValue | null,
  number,
  MonotonicSequence | null,
  StreamingOffset,
  number,
] {
  return [
    checkpoint.accountId,
    checkpoint.mailboxId,
    checkpoint.uidValidity,
    checkpoint.uidNext.kind === "known" ? 1 : 0,
    checkpoint.uidNext.kind === "known" ? checkpoint.uidNext.value : null,
    checkpoint.modseq.kind === "known" ? 1 : 0,
    checkpoint.modseq.kind === "known" ? checkpoint.modseq.value : null,
    checkpoint.sweepCursor,
    checkpoint.backfillCompleted ? 1 : 0,
  ];
}

function decodeCheckpointRow(value: unknown): MailboxCheckpoint {
  const decoded = decodeSqliteRow({
    table: "mailbox_checkpoints",
    row: value,
    columns: {
      account_id: { decode: (item, context) => parseAccountId(decodeString(item, context)) },
      mailbox_id: { decode: (item, context) => parseMailboxId(decodeString(item, context)) },
      uid_validity: {
        decode: (item, context) =>
          createUidValidity(
            decodeBoundedSafeInteger(item, { ...context, minimum: 1, maximum: 4294967295 }),
          ),
      },
      uid_next_known: { decode: decodeSqliteBoolean },
      uid_next: {
        decode: decodeNullable((item, context) =>
          createRemoteUidValue(
            decodeBoundedSafeInteger(item, { ...context, minimum: 1, maximum: 4294967295 }),
          ),
        ),
        nullable: true,
      },
      modseq_known: { decode: decodeSqliteBoolean },
      modseq: {
        decode: decodeNullable((item, context) =>
          createMonotonicSequence(decodeBoundedSafeInteger(item, { ...context, minimum: 0 })),
        ),
        nullable: true,
      },
      sweep_cursor: {
        decode: (item, context) =>
          createStreamingOffset(decodeBoundedSafeInteger(item, { ...context, minimum: 0 })),
      },
      backfill_completed: { decode: decodeSqliteBoolean },
      observed_version: {
        decode: (item, context) => decodeBoundedSafeInteger(item, { ...context, minimum: 0 }),
      },
      storage_version: {
        decode: (item, context) =>
          decodeBoundedSafeInteger(item, { ...context, minimum: 1, maximum: 255 }),
      },
    },
  });
  const accountId = parseAccountId(readDecoded(decoded, "account_id"));
  const mailboxId = parseMailboxId(readDecoded(decoded, "mailbox_id"));
  const uidValidity = createUidValidity(readDecoded(decoded, "uid_validity"));
  const uidNext = requireKnownValue(
    readDecoded(decoded, "uid_next_known"),
    readDecoded(decoded, "uid_next"),
    "uid_next",
    createRemoteUidValue,
  );
  const modseq = requireKnownValue(
    readDecoded(decoded, "modseq_known"),
    readDecoded(decoded, "modseq"),
    "modseq",
    createMonotonicSequence,
  );
  return {
    accountId,
    mailboxId,
    uidValidity,
    uidNext,
    modseq,
    sweepCursor: createStreamingOffset(readDecoded(decoded, "sweep_cursor")),
    backfillCompleted: requireBooleanValue(readDecoded(decoded, "backfill_completed")),
    observedVersion: readSafeInteger(decoded, "observed_version"),
    storageVersion: readSafeInteger(decoded, "storage_version"),
  };
}

function requireKnownValue<T>(
  known: unknown,
  value: unknown,
  column: string,
  create: (input: unknown) => T,
): CheckpointValue<T> {
  const knownValue = requireBooleanValue(known);
  if (knownValue && value !== null) return { kind: "known", value: create(value) };
  if (!knownValue && value === null) return { kind: "unknown" };
  throw new TypeError(`${column} known flag contradicts its value`);
}

function readDecoded(row: Readonly<Record<string, unknown>>, column: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, column)) {
    throw new TypeError(`decoded checkpoint row is missing ${column}`);
  }
  return row[column];
}

function readSafeInteger(row: Readonly<Record<string, unknown>>, column: string): number {
  const value = readDecoded(row, column);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`decoded checkpoint ${column} is not a safe integer`);
  }
  return value;
}

function requireBooleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("decoded checkpoint boolean is invalid");
  return value;
}

function decodeString(value: unknown, context: SqliteColumnContext): string {
  if (typeof value !== "string") throw new TypeError(`${context.column} must be text`);
  return value;
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  assertKeys(value, keys, []);
}

function assertKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const expected = new Set([...required, ...optional]);
  if (
    Object.keys(value).some((key) => !expected.has(key)) ||
    required.some((key) => !(key in value))
  ) {
    throw new TypeError("mailbox checkpoint input has unexpected or missing fields");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
