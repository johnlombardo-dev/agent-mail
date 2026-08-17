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
  type AccountId,
  type MailboxId,
  type MessageId,
  type RemoteUidValue,
  type UtcInstant,
  type UidValidity,
} from "@agent-mail/core";
import { readMailboxCheckpoint, type MailboxCheckpoint } from "./checkpoint-repository";

const JOURNAL_PAYLOAD_VERSION = 1;
const JOURNAL_CATEGORY = "sync" as const;
const RESET_JOURNAL_KIND = "mailbox-epoch-reset";
const TOMBSTONE_JOURNAL_KIND = "remote-placement-tombstone";
const MAX_CHECKPOINT_BYTES = 200;

type RecordValue = Readonly<Record<string, unknown>>;

export type MailboxEpochResetInput = Readonly<{
  readonly accountId: unknown;
  readonly mailboxId: unknown;
  readonly oldUidValidity: unknown;
  readonly newUidValidity: unknown;
  readonly observedAt: unknown;
  readonly sourceCheckpoint: unknown;
}>;

export type MailboxEpochResetOptions = Readonly<{
  /** Test seam for interrupting the transaction before a journal write. */
  readonly beforeJournalWrite?: (kind: "placement-tombstone" | "epoch-reset") => void;
}>;

export type MailboxEpochReset = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly oldUidValidity: UidValidity;
  readonly newUidValidity: UidValidity;
  readonly observedAt: UtcInstant;
  readonly sourceCheckpoint: string;
  readonly reason: string;
  readonly closedPlacementCount: number;
  readonly checkpoint: MailboxCheckpoint;
  readonly journalId: string;
}>;

export type MailboxEpochResetErrorCode =
  | "invalid-input"
  | "same-epoch"
  | "not-found"
  | "stale-epoch"
  | "new-epoch-exists"
  | "write-failed";

export class MailboxEpochResetError extends Error {
  readonly code: MailboxEpochResetErrorCode;

  constructor(code: MailboxEpochResetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailboxEpochResetError";
    this.code = code;
  }
}

type ParsedInput = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly oldUidValidity: UidValidity;
  readonly newUidValidity: UidValidity;
  readonly observedAt: UtcInstant;
  readonly sourceCheckpoint: string;
}>;

type LivePlacement = Readonly<{
  readonly uid: RemoteUidValue;
  readonly messageId: MessageId;
}>;

/** Parse the reset envelope before taking SQLite's write lock. */
export function parseMailboxEpochResetInput(value: unknown): ParsedInput {
  const record = requireExactRecord(value, [
    "accountId",
    "mailboxId",
    "oldUidValidity",
    "newUidValidity",
    "observedAt",
    "sourceCheckpoint",
  ]);
  try {
    const oldUidValidity = createUidValidity(record.oldUidValidity);
    const newUidValidity = createUidValidity(record.newUidValidity);
    if (oldUidValidity === newUidValidity) {
      throw new MailboxEpochResetError(
        "same-epoch",
        "mailbox epoch reset requires a different UIDVALIDITY",
      );
    }
    return {
      accountId: parseAccountId(record.accountId),
      mailboxId: parseMailboxId(record.mailboxId),
      oldUidValidity,
      newUidValidity,
      observedAt: createUtcInstant(record.observedAt),
      sourceCheckpoint: boundedText(
        record.sourceCheckpoint,
        "source checkpoint",
        MAX_CHECKPOINT_BYTES,
      ),
    };
  } catch (error: unknown) {
    if (error instanceof MailboxEpochResetError) throw error;
    throw new MailboxEpochResetError("invalid-input", "mailbox epoch reset input is invalid", {
      cause: error,
    });
  }
}

/**
 * Close one mailbox's live old-epoch placements and create its fresh epoch in
 * one transaction. Canonical messages and every other mailbox are outside the
 * mutation predicate.
 */
export function resetMailboxEpoch(
  database: Database,
  value: MailboxEpochResetInput,
  options: MailboxEpochResetOptions = {},
): MailboxEpochReset {
  const input = parseMailboxEpochResetInput(value);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const oldCheckpoint = readMailboxCheckpoint(database, {
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      uidValidity: input.oldUidValidity,
    });
    if (oldCheckpoint === undefined) {
      throw new MailboxEpochResetError("not-found", "mailbox epoch checkpoint does not exist");
    }

    const latest = readLatestEpoch(database, input.accountId, input.mailboxId);
    if (latest !== input.oldUidValidity) {
      throw new MailboxEpochResetError(
        "stale-epoch",
        "mailbox epoch reset is based on a stale UIDVALIDITY",
      );
    }
    if (
      readMailboxCheckpoint(database, {
        accountId: input.accountId,
        mailboxId: input.mailboxId,
        uidValidity: input.newUidValidity,
      }) !== undefined
    ) {
      throw new MailboxEpochResetError(
        "new-epoch-exists",
        "mailbox epoch reset target UIDVALIDITY already exists",
      );
    }

    const livePlacements = readLivePlacements(database, input);
    const reason = createTombstoneReason(
      `uidvalidity-reset; account=${input.accountId}; mailbox=${input.mailboxId}; ` +
        `oldUidValidity=${input.oldUidValidity}; newUidValidity=${input.newUidValidity}; ` +
        `observedAt=${input.observedAt}; sourceCheckpoint=${input.sourceCheckpoint}`,
    );

    database
      .query(
        "UPDATE remote_placements SET tombstone_observed_at = ?, tombstone_reason = ? " +
          "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? " +
          "AND tombstone_observed_at IS NULL AND tombstone_reason IS NULL;",
      )
      .run(input.observedAt, reason, input.accountId, input.mailboxId, input.oldUidValidity);

    database
      .query(
        "INSERT INTO mailbox_checkpoints " +
          "(account_id, mailbox_id, uid_validity, uid_next_known, uid_next, modseq_known, modseq, " +
          "sweep_cursor, backfill_completed, observed_version, storage_version) " +
          "VALUES (?, ?, ?, 0, NULL, 0, NULL, 0, 0, 0, 1);",
      )
      .run(input.accountId, input.mailboxId, input.newUidValidity);

    for (const placement of livePlacements) {
      options.beforeJournalWrite?.("placement-tombstone");
      insertPlacementTombstoneJournal(database, input, placement, reason);
    }

    const payloadJson = serializeResetPayload(input, livePlacements.length);
    const journalId = journalIdForResetPayload(payloadJson);
    options.beforeJournalWrite?.("epoch-reset");
    database
      .query(
        "INSERT INTO operational_journal " +
          "(id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        journalId,
        input.observedAt,
        JOURNAL_CATEGORY,
        mailboxResetSubjectId(input.accountId, input.mailboxId),
        input.sourceCheckpoint,
        JOURNAL_PAYLOAD_VERSION,
        payloadJson,
      );

    const checkpoint = readMailboxCheckpoint(database, {
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      uidValidity: input.newUidValidity,
    });
    if (checkpoint === undefined || !isUnknownCheckpoint(checkpoint)) {
      throw new Error("new mailbox epoch checkpoint is not explicitly unknown");
    }
    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      oldUidValidity: input.oldUidValidity,
      newUidValidity: input.newUidValidity,
      observedAt: input.observedAt,
      sourceCheckpoint: input.sourceCheckpoint,
      reason,
      closedPlacementCount: livePlacements.length,
      checkpoint,
      journalId,
    };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new MailboxEpochResetError(
          "write-failed",
          "mailbox epoch reset failed and could not be rolled back",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
    }
    if (error instanceof MailboxEpochResetError) throw error;
    throw new MailboxEpochResetError("write-failed", "mailbox epoch reset transaction failed", {
      cause: error,
    });
  }
}

function readLatestEpoch(
  database: Database,
  accountId: AccountId,
  mailboxId: MailboxId,
): UidValidity {
  const row: unknown = database
    .query(
      "SELECT uid_validity FROM mailbox_checkpoints " +
        "WHERE account_id = ? AND mailbox_id = ? ORDER BY rowid DESC LIMIT 1;",
    )
    .get(accountId, mailboxId);
  if (!isRecord(row)) {
    throw new MailboxEpochResetError("not-found", "mailbox has no epoch checkpoint");
  }
  return createUidValidity(row.uid_validity);
}

function readLivePlacements(database: Database, input: ParsedInput): readonly LivePlacement[] {
  const rows: readonly unknown[] = database
    .query(
      "SELECT uid, message_id FROM remote_placements " +
        "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? " +
        "AND tombstone_observed_at IS NULL AND tombstone_reason IS NULL ORDER BY uid;",
    )
    .all(input.accountId, input.mailboxId, input.oldUidValidity);
  return rows.map((row) => {
    if (!isRecord(row)) throw new TypeError("live placement row must be an object");
    return {
      uid: createRemoteUidValue(row.uid),
      messageId: parseMessageId(row.message_id),
    };
  });
}

function insertPlacementTombstoneJournal(
  database: Database,
  input: ParsedInput,
  placement: LivePlacement,
  reason: string,
): void {
  const payloadJson = JSON.stringify({
    kind: TOMBSTONE_JOURNAL_KIND,
    version: JOURNAL_PAYLOAD_VERSION,
    observedAt: input.observedAt,
    sourceCheckpoint: input.sourceCheckpoint,
    reason,
    priorPlacement: {
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      uidValidity: input.oldUidValidity,
      uid: placement.uid,
      messageId: placement.messageId,
    },
  });
  database
    .query(
      "INSERT INTO operational_journal " +
        "(id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      `event:remote-placement-tombstone:${sha256(payloadJson)}`,
      input.observedAt,
      JOURNAL_CATEGORY,
      placementSubjectId(input, placement.uid),
      input.sourceCheckpoint,
      JOURNAL_PAYLOAD_VERSION,
      payloadJson,
    );
}

function serializeResetPayload(input: ParsedInput, closedPlacementCount: number): string {
  return JSON.stringify({
    kind: RESET_JOURNAL_KIND,
    version: JOURNAL_PAYLOAD_VERSION,
    reason: "uidvalidity-reset",
    accountId: input.accountId,
    mailboxId: input.mailboxId,
    oldUidValidity: input.oldUidValidity,
    newUidValidity: input.newUidValidity,
    observedAt: input.observedAt,
    sourceCheckpoint: input.sourceCheckpoint,
    closedPlacementCount,
  });
}

function isUnknownCheckpoint(checkpoint: MailboxCheckpoint): boolean {
  return (
    checkpoint.uidNext.kind === "unknown" &&
    checkpoint.modseq.kind === "unknown" &&
    checkpoint.sweepCursor === 0 &&
    checkpoint.backfillCompleted === false
  );
}

function placementSubjectId(input: ParsedInput, uid: RemoteUidValue): string {
  return `placement:${sha256(
    JSON.stringify([input.accountId, input.mailboxId, input.oldUidValidity, uid]),
  )}`;
}

function mailboxResetSubjectId(accountId: AccountId, mailboxId: MailboxId): string {
  return `mailbox-epoch-reset:${sha256(JSON.stringify([accountId, mailboxId]))}`;
}

function journalIdForResetPayload(payloadJson: string): string {
  return `event:mailbox-epoch-reset:${sha256(payloadJson)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireExactRecord(value: unknown, keys: readonly string[]): RecordValue {
  if (!isRecord(value)) throw new TypeError("mailbox epoch reset input must be an object");
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !(key in value))) {
    throw new TypeError("mailbox epoch reset input has unknown or missing fields");
  }
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

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
