import { createHash } from "node:crypto";
import {
  compareUtcInstants,
  createRemoteUidValue,
  createStreamingOffset,
  type CheckpointValue,
  type RemoteUidValue,
  type StreamingOffset,
  type UtcInstant,
} from "@agent-mail/core";
import { planUidFetchRanges } from "../../imap/src/uid-range-planner";
import type { MetadataBatchItem } from "../../imap/src/metadata-batch";
import type {
  InitialBackfillBatchDependencies,
  InitialBackfillBatchRequest,
  InitialBackfillCheckpointRepository,
} from "./initial-backfill-batch";
import { runInitialBackfillBatch } from "./initial-backfill-batch";
import type {
  InitialBackfillCompletion,
  InitialBackfillCompletionIdentity,
  InitialBackfillCompletionRepository,
} from "./initial-backfill-loop";
import type { MailboxCheckpoint } from "../../storage/src/checkpoint-repository";

/** The actor identity that is allowed to perform one sweep invocation. */
export type RecurringSweepActor = Readonly<{ readonly id: string }>;

export type RecurringSweepIdentity = InitialBackfillCompletionIdentity;

export type RecurringSweepRequest = Readonly<{
  readonly identity: RecurringSweepIdentity;
  /** Current actor time used only for the eligibility gate. */
  readonly now: UtcInstant;
  /** Server status facts captured by the caller's read-only IMAP observation. */
  readonly observedUidCeiling: RemoteUidValue | null;
  readonly observedUidNext: CheckpointValue<RemoteUidValue>;
  readonly observedAt: UtcInstant;
  /** The eligibility value to persist after this invocation completes. */
  readonly nextSweepEligibleAt: UtcInstant;
  readonly maxNewUidBatchUids: number;
  readonly maxReconciliationUids: number;
  readonly stagingDirectory: string;
  readonly owner: InitialBackfillBatchRequest["owner"];
  readonly actor: RecurringSweepActor;
}>;

export type ExistingPlacementSweepInput = Readonly<{
  readonly identity: RecurringSweepIdentity;
  readonly uid: RemoteUidValue;
  /** Undefined means the read-only IMAP observation explicitly omitted this UID. */
  readonly metadata: MetadataBatchItem | undefined;
  readonly observedAt: UtcInstant;
  readonly sourceCheckpoint: string;
}>;

export type RecurringSweepDependencies = Readonly<{
  readonly checkpoints: InitialBackfillCheckpointRepository;
  readonly completions: InitialBackfillCompletionRepository;
  readonly batch: Omit<InitialBackfillBatchDependencies, "checkpoints" | "observedAt" | "signal">;
  /** Returns active placements strictly after the durable sweep cursor. */
  readonly listExistingPlacementUids: (
    identity: RecurringSweepIdentity,
    after: StreamingOffset,
    limit: number,
  ) => readonly RemoteUidValue[];
  /** Owns the durable existing-placement observation or tombstone transition. */
  readonly reconcileExistingPlacement: (input: ExistingPlacementSweepInput) => void;
  /** Ownership is checked before the eligibility gate or any IMAP/durable write. */
  readonly ownsActor: (identity: RecurringSweepIdentity, actor: RecurringSweepActor) => boolean;
  readonly signal?: AbortSignal;
}>;

export type RecurringMailboxSweepResult = Readonly<{
  readonly status: "completed" | "not-eligible" | "not-owner" | "cancelled";
  readonly checkpoint: MailboxCheckpoint;
  readonly completion: InitialBackfillCompletion;
  readonly discoveredUids: readonly RemoteUidValue[];
  readonly reconciledUids: readonly RemoteUidValue[];
}>;

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new RangeError(`${name} must be between 1 and 10000`);
  }
  return value;
}

function identityMatches(left: RecurringSweepIdentity, right: RecurringSweepIdentity): boolean {
  return (
    left.accountId === right.accountId &&
    left.mailboxId === right.mailboxId &&
    left.uidValidity === right.uidValidity
  );
}

function sourceCheckpoint(request: RecurringSweepRequest, cursor: StreamingOffset): string {
  return `recurring-sweep-v1:${createHash("sha256")
    .update(
      JSON.stringify([
        request.identity.accountId,
        request.identity.mailboxId,
        request.identity.uidValidity,
        cursor,
        request.observedAt,
      ]),
    )
    .digest("hex")}`;
}

function normalizePlacementUids(
  values: readonly RemoteUidValue[],
  after: StreamingOffset,
  limit: number,
): readonly RemoteUidValue[] {
  const normalized = values
    .map((value) => createRemoteUidValue(value))
    .filter((uid) => uid > after);
  const unique = [...new Set(normalized)].sort((left, right) => left - right);
  return Object.freeze(unique.slice(0, limit));
}

function checkCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function validateObservedFacts(
  request: RecurringSweepRequest,
  checkpoint: MailboxCheckpoint,
): void {
  if (
    request.observedUidCeiling !== null &&
    request.observedUidNext.kind === "known" &&
    request.observedUidNext.value <= request.observedUidCeiling
  ) {
    throw new Error("recurring sweep observed UIDNEXT must exceed the observed UID ceiling");
  }
  if (
    checkpoint.uidNext.kind === "known" &&
    request.observedUidNext.kind === "known" &&
    request.observedUidNext.value < checkpoint.uidNext.value
  ) {
    throw new Error("recurring sweep observed UIDNEXT regressed behind the checkpoint");
  }
}

/**
 * Run exactly one bounded recurring sweep. New UID discovery is one bounded
 * initial-backfill batch; existing placements are a separate bounded metadata
 * observation pass. The final checkpoint/completion CAS is deliberately last,
 * so an interrupted reconciliation cannot advance either sweep progress fact.
 */
export async function runRecurringMailboxSweep(
  request: RecurringSweepRequest,
  dependencies: RecurringSweepDependencies,
): Promise<RecurringMailboxSweepResult> {
  const maxNewUidBatchUids = validateLimit(request.maxNewUidBatchUids, "maxNewUidBatchUids");
  const maxReconciliationUids = validateLimit(
    request.maxReconciliationUids,
    "maxReconciliationUids",
  );
  let checkpoint = dependencies.checkpoints.read(request.identity);
  if (checkpoint === undefined) throw new Error("recurring sweep checkpoint does not exist");
  if (!identityMatches(checkpoint, request.identity)) {
    throw new Error("recurring sweep checkpoint identity does not match the request");
  }
  const completion = dependencies.completions.read(request.identity);
  if (completion === undefined) {
    throw new Error("recurring sweep completion facts do not exist");
  }
  validateObservedFacts(request, checkpoint);

  if (!dependencies.ownsActor(request.identity, request.actor)) {
    return {
      status: "not-owner",
      checkpoint,
      completion,
      discoveredUids: [],
      reconciledUids: [],
    };
  }
  if (compareUtcInstants(request.now, completion.nextSweepEligibleAt) < 0) {
    return {
      status: "not-eligible",
      checkpoint,
      completion,
      discoveredUids: [],
      reconciledUids: [],
    };
  }
  if (checkCancelled(dependencies.signal)) {
    return {
      status: "cancelled",
      checkpoint,
      completion,
      discoveredUids: [],
      reconciledUids: [],
    };
  }

  // This path intentionally does not inspect backfillCompleted. A completed
  // initial pass is the normal caller of this reusable discovery operation.
  const cursor = checkpoint.sweepCursor;
  const placementCandidates = normalizePlacementUids(
    dependencies.listExistingPlacementUids(request.identity, cursor, maxReconciliationUids + 1),
    cursor,
    maxReconciliationUids + 1,
  );
  const placementUids = placementCandidates.slice(0, maxReconciliationUids);
  const hasReadAhead = placementCandidates.length > maxReconciliationUids;
  const checkpointSource = sourceCheckpoint(request, cursor);

  const newRanges = planUidFetchRanges({
    knownPlacementUids: [],
    checkpointUidNext: checkpoint.uidNext,
    observedUidCeiling: request.observedUidCeiling,
    maxRangeSpan: maxNewUidBatchUids,
  });
  const discoveredUids: RemoteUidValue[] = [];
  if (newRanges.length > 0) {
    const batchResult = await runInitialBackfillBatch(
      {
        accountId: request.identity.accountId,
        mailboxId: request.identity.mailboxId,
        uidValidity: request.identity.uidValidity,
        range: newRanges[0],
        stagingDirectory: request.stagingDirectory,
        owner: request.owner,
      },
      {
        ...dependencies.batch,
        checkpoints: dependencies.checkpoints,
        observedAt: request.observedAt,
        signal: dependencies.signal,
      },
    );
    checkpoint = batchResult.checkpoint;
    discoveredUids.push(...batchResult.processedUids.map((uid) => createRemoteUidValue(uid)));
    if (batchResult.status === "cancelled" || checkCancelled(dependencies.signal)) {
      return {
        status: "cancelled",
        checkpoint,
        completion,
        discoveredUids: Object.freeze(discoveredUids),
        reconciledUids: [],
      };
    }
  }

  const reconciledUids: RemoteUidValue[] = [];
  if (placementUids.length > 0) {
    const metadata = await dependencies.batch.metadata.fetch({
      accountId: request.identity.accountId,
      mailboxId: request.identity.mailboxId,
      uidValidity: request.identity.uidValidity,
      uids: placementUids,
    });
    const items = new Map(metadata.items.map((item) => [item.identity.uid, item]));
    for (const uid of placementUids) {
      if (checkCancelled(dependencies.signal)) {
        return {
          status: "cancelled",
          checkpoint,
          completion,
          discoveredUids: Object.freeze(discoveredUids),
          reconciledUids: Object.freeze(reconciledUids),
        };
      }
      dependencies.reconcileExistingPlacement({
        identity: request.identity,
        uid,
        metadata: items.get(uid),
        observedAt: request.observedAt,
        sourceCheckpoint: checkpointSource,
      });
      reconciledUids.push(uid);
    }
  }

  // This is the only sweep-progress write. It follows both the new-UID batch
  // and every existing-placement durable transition. `complete` uses the same
  // SQLite transaction/CAS as initial completion and preserves the flag rather
  // than using it as a gate.
  const nextCursor =
    placementUids.length === 0
      ? cursor === 0
        ? cursor
        : createStreamingOffset(0)
      : hasReadAhead
        ? createStreamingOffset(placementUids[placementUids.length - 1])
        : createStreamingOffset(0);
  const committed = dependencies.completions.complete({
    identity: request.identity,
    checkpoint: {
      ...checkpoint,
      sweepCursor: nextCursor,
      backfillCompleted: checkpoint.backfillCompleted,
    },
    expectedVersion: checkpoint.observedVersion,
    completion: {
      ...completion,
      observedAt: request.observedAt,
      nextSweepEligibleAt: request.nextSweepEligibleAt,
      observedUidCeiling: request.observedUidCeiling,
      observedUidNext: request.observedUidNext,
    },
  });
  return {
    status: "completed",
    checkpoint: committed.checkpoint,
    completion: committed.completion,
    discoveredUids: Object.freeze(discoveredUids),
    reconciledUids: Object.freeze(reconciledUids),
  };
}
