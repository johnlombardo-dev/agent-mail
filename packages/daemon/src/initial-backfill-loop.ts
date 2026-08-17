import { Database } from "bun:sqlite";
import {
  createRemoteUidValue,
  createUtcInstant,
  type AccountId,
  type CheckpointValue,
  type MailboxId,
  type RemoteUidValue,
  type UtcInstant,
  type UidValidity,
} from "@agent-mail/core";
import { planUidFetchRanges, type UidRange } from "../../imap/src/uid-range-planner";
import type {
  InitialBackfillBatchDependencies,
  InitialBackfillBatchRequest,
  InitialBackfillCheckpointRepository,
} from "./initial-backfill-batch";
import { runInitialBackfillBatch } from "./initial-backfill-batch";
import type { Migration } from "../../storage/src/migration-runner";
import {
  readMailboxCheckpoint,
  StaleMailboxCheckpointError,
  type MailboxCheckpoint,
  type MailboxCheckpointInput,
} from "../../storage/src/checkpoint-repository";

/** Durable facts captured when one initial backfill observation completes. */
export type InitialBackfillCompletion = Readonly<{
  readonly observedUidCeiling: RemoteUidValue | null;
  readonly observedUidNext: CheckpointValue<RemoteUidValue>;
  readonly observedAt: UtcInstant;
  /** This is eligibility metadata only; this module never runs a sweep. */
  readonly nextSweepEligibleAt: UtcInstant;
}>;

export type InitialBackfillCompletionIdentity = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
}>;

export type InitialBackfillCompletionRepository = Readonly<{
  readonly read: (
    identity: InitialBackfillCompletionIdentity,
  ) => InitialBackfillCompletion | undefined;
  readonly save: (
    identity: InitialBackfillCompletionIdentity,
    completion: InitialBackfillCompletion,
  ) => InitialBackfillCompletion;
  readonly complete: (
    input: InitialBackfillCompletionCommitInput,
  ) => InitialBackfillCompletionCommitResult;
}>;

export type InitialBackfillCompletionCommitInput = Readonly<{
  readonly identity: InitialBackfillCompletionIdentity;
  readonly checkpoint: MailboxCheckpointInput;
  readonly expectedVersion: number;
  readonly completion: InitialBackfillCompletion;
}>;

export type InitialBackfillCompletionCommitResult = Readonly<{
  readonly checkpoint: MailboxCheckpoint;
  readonly completion: InitialBackfillCompletion;
}>;

export type InitialBackfillCompletionRepositoryOptions = Readonly<{
  /** Test-only crash seam: invoked after the checkpoint write and before completion write. */
  readonly beforeCompletionWrite?: () => void;
}>;

export type InitialBackfillLoopRequest = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  /** The ceiling observed in one server status/fetch observation. Null means an observed empty mailbox. */
  readonly observedUidCeiling: RemoteUidValue | null;
  /** Other server facts captured with the same observation; unknown remains unknown. */
  readonly observedUidNext: CheckpointValue<RemoteUidValue>;
  readonly observedAt: UtcInstant;
  readonly nextSweepEligibleAt: UtcInstant;
  readonly maxBatchUids: number;
  readonly stagingDirectory: string;
  readonly owner: InitialBackfillBatchRequest["owner"];
}>;

export type InitialBackfillLoopDependencies = Readonly<{
  readonly checkpoints: InitialBackfillCheckpointRepository;
  readonly completions: InitialBackfillCompletionRepository;
  readonly batch: Omit<InitialBackfillBatchDependencies, "checkpoints" | "observedAt" | "signal">;
  readonly signal?: AbortSignal;
}>;

export type InitialBackfillLoopResult = Readonly<{
  readonly status: "completed" | "already-complete" | "cancelled";
  readonly checkpoint: MailboxCheckpoint;
  readonly completion: InitialBackfillCompletion | undefined;
  readonly processedRanges: readonly UidRange[];
}>;

/**
 * The completion record is deliberately separate from the mailbox cursor. A
 * completed initial pass records what the server said at that point and when a
 * later sweep may be considered; it does not turn the mailbox into a terminal
 * state.
 */
export const INITIAL_BACKFILL_COMPLETION_MIGRATION_VERSION = 1;

export const initialBackfillCompletionMigration = {
  version: INITIAL_BACKFILL_COMPLETION_MIGRATION_VERSION,
  name: "initial-backfill-completion",
  sql: `
CREATE TABLE initial_backfill_completions (
  account_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  observed_uid_ceiling INTEGER,
  observed_uid_next_known INTEGER NOT NULL CHECK (observed_uid_next_known IN (0, 1)),
  observed_uid_next INTEGER,
  observed_at TEXT NOT NULL CHECK (
    length(observed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) = observed_at
  ),
  next_sweep_eligible_at TEXT NOT NULL CHECK (
    length(next_sweep_eligible_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', next_sweep_eligible_at) = next_sweep_eligible_at
  ),
  PRIMARY KEY (account_id, mailbox_id, uid_validity),
  FOREIGN KEY (account_id, mailbox_id, uid_validity)
    REFERENCES mailbox_checkpoints (account_id, mailbox_id, uid_validity),
  CHECK (
    (observed_uid_ceiling IS NULL) OR
    (typeof(observed_uid_ceiling) = 'integer' AND observed_uid_ceiling > 0 AND observed_uid_ceiling <= 4294967295)
  ),
  CHECK (
    (observed_uid_next_known = 0 AND observed_uid_next IS NULL) OR
    (observed_uid_next_known = 1 AND typeof(observed_uid_next) = 'integer' AND observed_uid_next > 0 AND observed_uid_next <= 4294967295)
  )
);
`,
} satisfies Migration;

function completionIdentity(
  request: InitialBackfillLoopRequest,
): InitialBackfillCompletionIdentity {
  return {
    accountId: request.accountId,
    mailboxId: request.mailboxId,
    uidValidity: request.uidValidity,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Initial backfill was aborted", "AbortError");
  }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

function validateBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new RangeError("initial backfill maxBatchUids must be between 1 and 10000");
  }
  return value;
}

function identityRequest(request: InitialBackfillLoopRequest): InitialBackfillBatchRequest {
  return {
    accountId: request.accountId,
    mailboxId: request.mailboxId,
    uidValidity: request.uidValidity,
    range: { start: createRemoteUidValue(1), end: createRemoteUidValue(1) },
    stagingDirectory: request.stagingDirectory,
    owner: request.owner,
  };
}

function completionFor(request: InitialBackfillLoopRequest): InitialBackfillCompletion {
  return {
    observedUidCeiling: request.observedUidCeiling,
    observedUidNext: request.observedUidNext,
    observedAt: request.observedAt,
    nextSweepEligibleAt: request.nextSweepEligibleAt,
  };
}

/**
 * Process all ranges from one observed UID ceiling, one bounded batch at a
 * time. A completed checkpoint is still observed and refreshed, never treated
 * as a reason to suppress future discovery.
 */
export async function runInitialBackfillLoop(
  request: InitialBackfillLoopRequest,
  dependencies: InitialBackfillLoopDependencies,
): Promise<InitialBackfillLoopResult> {
  const maxBatchUids = validateBatchLimit(request.maxBatchUids);
  const identity = completionIdentity(request);
  let checkpoint = dependencies.checkpoints.read(identity);
  if (checkpoint === undefined) throw new Error("initial backfill checkpoint does not exist");
  const completion = completionFor(request);

  // A prior completion is not terminal. Record the newer server observation so
  // the independent sweep path can discover UIDs added after this pass.
  if (checkpoint.backfillCompleted) {
    throwIfAborted(dependencies.signal);
    const saved = dependencies.completions.save(identity, completion);
    return {
      status: "already-complete",
      checkpoint,
      completion: saved,
      processedRanges: [],
    };
  }

  const ranges = planUidFetchRanges({
    knownPlacementUids: [],
    checkpointUidNext: checkpoint.uidNext,
    observedUidCeiling: request.observedUidCeiling,
    maxRangeSpan: maxBatchUids,
    reconcileKnown: true,
  });
  const processedRanges: UidRange[] = [];
  const batchRequest = identityRequest(request);

  try {
    for (const range of ranges) {
      throwIfAborted(dependencies.signal);
      const result = await runInitialBackfillBatch(
        { ...batchRequest, range },
        {
          ...dependencies.batch,
          checkpoints: dependencies.checkpoints,
          observedAt: request.observedAt,
          signal: dependencies.signal,
        },
      );
      checkpoint = result.checkpoint;
      if (result.status === "cancelled") {
        return {
          status: "cancelled",
          checkpoint,
          completion: undefined,
          processedRanges: Object.freeze(processedRanges),
        };
      }
      processedRanges.push(range);
    }
    throwIfAborted(dependencies.signal);
  } catch (error: unknown) {
    if (isAbort(error, dependencies.signal)) {
      const current = dependencies.checkpoints.read(identity) ?? checkpoint;
      return {
        status: "cancelled",
        checkpoint: current,
        completion: undefined,
        processedRanges: Object.freeze(processedRanges),
      };
    }
    throw error;
  }

  const saved = dependencies.completions.complete({
    identity,
    checkpoint: {
      ...checkpoint,
      backfillCompleted: true,
    },
    expectedVersion: checkpoint.observedVersion,
    completion,
  });
  return {
    status: "completed",
    checkpoint: saved.checkpoint,
    completion: saved.completion,
    processedRanges: Object.freeze(processedRanges),
  };
}

type CompletionRow = Readonly<Record<string, unknown>>;

function isCompletionRow(value: unknown): value is CompletionRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowString(row: CompletionRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new TypeError(`initial backfill completion ${key} is invalid`);
  return value;
}

function rowInteger(row: CompletionRow, key: string, nullable: boolean): number | null {
  const value = row[key];
  if (value === null && nullable) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`initial backfill completion ${key} is invalid`);
  }
  return value;
}

function rowBoolean(row: CompletionRow, key: string): boolean {
  const value = row[key];
  if (value !== 0 && value !== 1)
    throw new TypeError(`initial backfill completion ${key} is invalid`);
  return value === 1;
}

function decodeCompletionRow(row: unknown): InitialBackfillCompletion {
  if (!isCompletionRow(row)) {
    throw new TypeError("initial backfill completion row is invalid");
  }
  const record = row;
  const observedUidCeiling = rowInteger(record, "observed_uid_ceiling", true);
  const observedNextKnown = rowBoolean(record, "observed_uid_next_known");
  const observedNext = rowInteger(record, "observed_uid_next", true);
  if (observedNextKnown !== (observedNext !== null)) {
    throw new TypeError("initial backfill completion UIDNEXT fields contradict");
  }
  if (observedNextKnown && observedNext === null) {
    throw new TypeError("initial backfill completion known UIDNEXT is missing");
  }
  return {
    observedUidCeiling:
      observedUidCeiling === null ? null : createRemoteUidValue(observedUidCeiling),
    observedUidNext: observedNextKnown
      ? { kind: "known", value: createRemoteUidValue(observedNext) }
      : { kind: "unknown" },
    observedAt: createUtcInstant(rowString(record, "observed_at")),
    nextSweepEligibleAt: createUtcInstant(rowString(record, "next_sweep_eligible_at")),
  };
}

export function createInitialBackfillCompletionRepository(
  database: Database,
  options: InitialBackfillCompletionRepositoryOptions = {},
): InitialBackfillCompletionRepository {
  function read(
    identity: InitialBackfillCompletionIdentity,
  ): InitialBackfillCompletion | undefined {
    const row: unknown = database
      .query(
        "SELECT observed_uid_ceiling, observed_uid_next_known, observed_uid_next, observed_at, next_sweep_eligible_at " +
          "FROM initial_backfill_completions WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ?;",
      )
      .get(identity.accountId, identity.mailboxId, identity.uidValidity);
    return row === null ? undefined : decodeCompletionRow(row);
  }

  function upsert(
    identity: InitialBackfillCompletionIdentity,
    completion: InitialBackfillCompletion,
  ): void {
    database
      .query(
        "INSERT INTO initial_backfill_completions " +
          "(account_id, mailbox_id, uid_validity, observed_uid_ceiling, observed_uid_next_known, observed_uid_next, observed_at, next_sweep_eligible_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(account_id, mailbox_id, uid_validity) DO UPDATE SET " +
          "observed_uid_ceiling = excluded.observed_uid_ceiling, " +
          "observed_uid_next_known = excluded.observed_uid_next_known, " +
          "observed_uid_next = excluded.observed_uid_next, observed_at = excluded.observed_at, " +
          "next_sweep_eligible_at = excluded.next_sweep_eligible_at;",
      )
      .run(
        identity.accountId,
        identity.mailboxId,
        identity.uidValidity,
        completion.observedUidCeiling,
        completion.observedUidNext.kind === "known" ? 1 : 0,
        completion.observedUidNext.kind === "known" ? completion.observedUidNext.value : null,
        completion.observedAt,
        completion.nextSweepEligibleAt,
      );
  }

  function checkpointParameters(
    checkpoint: MailboxCheckpointInput,
  ): readonly [
    number,
    RemoteUidValue | null,
    number,
    number | null,
    number,
    number,
    AccountId,
    MailboxId,
    UidValidity,
  ] {
    return [
      checkpoint.uidNext.kind === "known" ? 1 : 0,
      checkpoint.uidNext.kind === "known" ? checkpoint.uidNext.value : null,
      checkpoint.modseq.kind === "known" ? 1 : 0,
      checkpoint.modseq.kind === "known" ? checkpoint.modseq.value : null,
      checkpoint.sweepCursor,
      checkpoint.backfillCompleted ? 1 : 0,
      checkpoint.accountId,
      checkpoint.mailboxId,
      checkpoint.uidValidity,
    ];
  }

  function commitCompletion(
    input: InitialBackfillCompletionCommitInput,
  ): InitialBackfillCompletionCommitResult {
    let transactionStarted = false;
    try {
      database.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      const current = readMailboxCheckpoint(database, input.identity);
      if (current === undefined || current.observedVersion !== input.expectedVersion) {
        throw new StaleMailboxCheckpointError(input.expectedVersion, current?.observedVersion);
      }
      const values = checkpointParameters(input.checkpoint);
      const result = database
        .query(
          "UPDATE mailbox_checkpoints SET uid_next_known = ?, uid_next = ?, modseq_known = ?, modseq = ?, " +
            "sweep_cursor = ?, backfill_completed = ?, observed_version = observed_version + 1 " +
            "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND observed_version = ?;",
        )
        .run(...values, input.expectedVersion);
      if (result.changes !== 1) {
        const latest = readMailboxCheckpoint(database, input.identity);
        throw new StaleMailboxCheckpointError(input.expectedVersion, latest?.observedVersion);
      }
      options.beforeCompletionWrite?.();
      upsert(input.identity, input.completion);
      const checkpoint = readMailboxCheckpoint(database, input.identity);
      const completion = read(input.identity);
      if (checkpoint === undefined || completion === undefined) {
        throw new Error("initial backfill completion disappeared during transaction");
      }
      database.exec("COMMIT;");
      return { checkpoint, completion };
    } catch (error: unknown) {
      if (transactionStarted) database.exec("ROLLBACK;");
      throw error;
    }
  }

  return {
    read,
    save: (identity, completion) => {
      upsert(identity, completion);
      const saved = read(identity);
      if (saved === undefined)
        throw new Error("initial backfill completion disappeared after save");
      return saved;
    },
    complete: commitCompletion,
  };
}
