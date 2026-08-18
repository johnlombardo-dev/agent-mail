import type { Database } from "bun:sqlite";
import {
  createRemoteAttemptFailed,
  createRemoteAttemptRejected,
  createRemoteAttemptResult,
  type ActionPlanTarget,
  type ExecutingActionPlan,
  type RemoteAttempt,
  type RemoteAttemptResult,
  type UtcInstant,
} from "@agent-mail/core";
import {
  executeRemoteAttempt,
  type RemoteAttemptExecution,
  type RemoteMutationAdapter,
} from "../../imap/src/remote-executor";
import type { PreconditionObservation } from "../../imap/src/precondition";
import {
  readActionPlanAttempt,
  readActionPlanAttemptAuthority,
  startActionPlanAttempt,
  type ActionPlanAttemptAuthority,
  type ActionAttemptStartResult,
} from "../../storage/src/action-plan-attempt";
import {
  markActionPlanAttemptDispatched,
  recoverUnresolvedActionPlanAttempt,
  type ActionAttemptRecoveryResult,
} from "../../storage/src/action-plan-recovery";
import {
  readActionPlanResult,
  recordExpiredUndispatchedActionPlanResult,
  recordActionPlanReconciliationResult,
  recordDefiniteActionPlanResult,
  recordStaleActionPlanResult,
} from "../../storage/src/action-plan-result";
import {
  reconcileUncertainActionPlanAttempt,
  type UncertainAttemptReadOnlyObserver,
} from "../../storage/src/action-plan-reconciliation";

/** A durable result tied to its immutable plan target ordinal. */
export type ActionPlanTargetProgress = Readonly<{
  readonly targetOrdinal: number;
  readonly target: ActionPlanTarget;
  readonly result: RemoteAttemptResult;
}>;

export type ActionPlanTargetLoopResult = Readonly<{
  readonly status: "completed" | "cancelled";
  /** Results are ordered by the immutable target order, never by completion time. */
  readonly progress: readonly ActionPlanTargetProgress[];
}>;

export type ActionPlanTargetLoopOptions = Readonly<{
  readonly database: Database;
  readonly claimedPlan: ExecutingActionPlan;
  /** The fake and production adapter must expose only one target's capability. */
  readonly mutationAdapter: RemoteMutationAdapter;
  readonly readPrecondition: (target: RemoteAttempt["target"]) => Promise<PreconditionObservation>;
  /** Read-only evidence used whenever a durable uncertain result is reopened. */
  readonly uncertainObserver: UncertainAttemptReadOnlyObserver;
  /** A canonical instant supplied by the owning actor, not wall-clock state in this loop. */
  readonly now: UtcInstant;
  /** The optimistic plan version captured by claim or restart discovery. */
  readonly expectedPlanVersion: number;
  /** Actor-owned clock sampled at every target/effect authority boundary. */
  readonly freshNow: () => UtcInstant;
  readonly signal?: AbortSignal;
  /** Production adapters translate their result algebra into the core result algebra here. */
  readonly normalizeMutationResult?: (
    input: Readonly<{
      readonly attempt: RemoteAttempt;
      readonly resultAt: UtcInstant;
      readonly raw: unknown;
    }>,
  ) => unknown;
  /** @internal Test-only process-crash seam; absent in production callers. */
  readonly onDurableTargetResult?: (
    input: Readonly<{
      readonly attempt: RemoteAttempt;
      readonly result: RemoteAttemptResult;
    }>,
  ) => void | Promise<void>;
}>;

type AttemptBoundary = Readonly<{
  readonly attempt: RemoteAttempt;
  readonly claimId: ExecutingActionPlan["claimId"];
}>;

class ExpiredUndispatchedAttempt extends Error {
  readonly result: RemoteAttemptResult;

  constructor(result: RemoteAttemptResult) {
    super("action plan authority expired before remote dispatch");
    this.name = "ExpiredUndispatchedAttempt";
    this.result = result;
  }
}

class DispatchAlreadyCrossed extends Error {
  constructor() {
    super("action attempt dispatch was crossed by another owner");
    this.name = "DispatchAlreadyCrossed";
  }
}

/**
 * Execute one claimed plan's frozen targets in order.
 *
 * This is intentionally an internal coordinator. It does not claim, finalize,
 * aggregate, retry, or expose a route. A target is eligible to leave the loop
 * only after its result row is durable. An uncertain row is reconciled by a
 * read-only observer, but is never retried by this function.
 */
export async function runActionPlanTargetLoop(
  options: ActionPlanTargetLoopOptions,
): Promise<ActionPlanTargetLoopResult> {
  const progress: ActionPlanTargetProgress[] = [];
  for (const [index, target] of options.claimedPlan.targets.entries()) {
    const targetOrdinal = index + 1;
    if (options.signal?.aborted) {
      return { status: "cancelled", progress: Object.freeze(progress) };
    }

    const attemptId = `attempt:${options.claimedPlan.planId}:${targetOrdinal}`;
    const idempotencyKey = `action:${options.claimedPlan.planId}:${targetOrdinal}`;
    const result = await runTarget(options, targetOrdinal, target, attemptId, idempotencyKey);
    progress.push({ targetOrdinal, target, result });

    // Cancellation is intentionally checked only after the active boundary has
    // returned and its result has been reopened from durable storage.
    if (options.signal?.aborted) {
      return { status: "cancelled", progress: Object.freeze(progress) };
    }
  }
  return { status: "completed", progress: Object.freeze(progress) };
}

async function runTarget(
  options: ActionPlanTargetLoopOptions,
  targetOrdinal: number,
  target: ActionPlanTarget,
  attemptId: string,
  idempotencyKey: string,
): Promise<RemoteAttemptResult> {
  const existingResult = readActionPlanResult(options.database, attemptId);
  if (existingResult !== undefined) {
    return resolveExistingResult(options, existingResult, targetOrdinal);
  }

  let boundary = readActionPlanAttempt(options.database, attemptId);
  if (boundary === undefined) {
    const attemptNow = currentNow(options);
    const started = startActionPlanAttempt(options.database, {
      planId: options.claimedPlan.planId,
      claimId: options.claimedPlan.claimId,
      targetOrdinal,
      attemptId,
      idempotencyKey,
      startedAt: laterInstant(attemptNow, options.claimedPlan.startedAt),
      now: attemptNow,
    });
    boundary = startedBoundary(started);
  }

  const durableAttempt = boundary;
  if (durableAttempt === undefined) throw new Error("target attempt boundary disappeared");
  const recovered = recoverExistingDispatch(options, durableAttempt.attempt.attemptId);
  if (recovered !== undefined) {
    const result = await resultAfterRecovery(options, recovered, durableAttempt.attempt);
    if (result !== undefined) return result;
  }

  const admission = freshAuthority(options, targetOrdinal, durableAttempt.attempt);
  if (admission.kind !== "admitted") {
    return await resolveDeniedAdmission(options, admission, durableAttempt.attempt);
  }

  try {
    const execution = await executeRemoteAttempt({
      claimedPlan: options.claimedPlan,
      durableAttempt,
      readPrecondition: options.readPrecondition,
      finalizeStale: async ({ attempt, observation }) => {
        const recorded = recordStaleActionPlanResult(options.database, {
          attemptId: attempt.attemptId,
          resultAt: resultInstant(options, attempt),
          observation,
        });
        if (recorded.kind === "rejected" && recorded.reason !== "result-exists") {
          throw new Error(`stale result was not durable: ${recorded.reason}`);
        }
        return recorded;
      },
      markDispatched: async ({ attempt, observation }) => {
        const marked = markActionPlanAttemptDispatched(options.database, {
          attemptId: attempt.attemptId,
          planId: options.claimedPlan.planId,
          claimId: options.claimedPlan.claimId,
          expectedVersion: options.expectedPlanVersion,
          dispatchedAt: resultInstant(options, attempt),
          observation,
        });
        switch (marked.kind) {
          case "marked":
            return;
          case "expired":
            throw new ExpiredUndispatchedAttempt(classifyExpiredUndispatched(options, attempt));
          case "dispatched":
            throw new DispatchAlreadyCrossed();
          case "rejected":
            throw new Error(`dispatch marker was not admitted: ${marked.reason}`);
          default: {
            const exhaustive: never = marked;
            return exhaustive;
          }
        }
      },
      mutationAdapter: options.mutationAdapter,
    });
    const result = await persistExecution(options, durableAttempt.attempt, execution);
    await options.onDurableTargetResult?.({ attempt: durableAttempt.attempt, result });
    return result;
  } catch (error: unknown) {
    if (error instanceof ExpiredUndispatchedAttempt) return error.result;
    if (error instanceof DispatchAlreadyCrossed) {
      const recovered = recoverExistingDispatch(options, durableAttempt.attempt.attemptId);
      if (recovered === undefined) throw error;
      const result = await resultAfterRecovery(options, recovered, durableAttempt.attempt);
      if (result !== undefined) return result;
      throw error;
    }
    return await recoverAfterInterruption(options, durableAttempt.attempt);
  }
}

function freshAuthority(
  options: ActionPlanTargetLoopOptions,
  targetOrdinal: number,
  attempt: RemoteAttempt,
): ActionPlanAttemptAuthority {
  return readActionPlanAttemptAuthority(options.database, {
    planId: options.claimedPlan.planId,
    claimId: options.claimedPlan.claimId,
    attemptId: attempt.attemptId,
    targetOrdinal,
    target: attempt.target,
    expectedVersion: options.expectedPlanVersion,
    now: currentNow(options),
  });
}

async function resolveDeniedAdmission(
  options: ActionPlanTargetLoopOptions,
  admission: Exclude<ActionPlanAttemptAuthority, { readonly kind: "admitted" }>,
  attempt: RemoteAttempt,
): Promise<RemoteAttemptResult> {
  switch (admission.kind) {
    case "expired-undispatched":
      return classifyExpiredUndispatched(options, attempt);
    case "dispatched":
      return reconcileExistingUncertain(options, attempt);
    case "rejected":
      throw new Error(`remote effect authority rejected: ${admission.reason}`);
    default: {
      const exhaustive: never = admission;
      return exhaustive;
    }
  }
}

function classifyExpiredUndispatched(
  options: ActionPlanTargetLoopOptions,
  attempt: RemoteAttempt,
): RemoteAttemptResult {
  const classified = recordExpiredUndispatchedActionPlanResult(options.database, {
    attemptId: attempt.attemptId,
    resultAt: resultInstant(options, attempt),
  });
  switch (classified.kind) {
    case "recorded":
    case "already-resolved":
      return classified.result;
    case "rejected":
      throw new Error(`expired attempt classification was rejected: ${classified.reason}`);
    default: {
      const exhaustive: never = classified;
      return exhaustive;
    }
  }
}

function startedBoundary(result: ActionAttemptStartResult): AttemptBoundary {
  if (result.kind !== "started") {
    throw new Error(`target attempt could not start: ${result.reason}`);
  }
  return { attempt: result.attempt, claimId: result.claimId };
}

function recoverExistingDispatch(
  options: ActionPlanTargetLoopOptions,
  attemptId: string,
): ActionAttemptRecoveryResult | undefined {
  const result = recoverUnresolvedActionPlanAttempt(options.database, {
    attemptId,
    recoveredAt: currentNow(options),
  });
  return result.kind === "not-dispatched" ? undefined : result;
}

async function resultAfterRecovery(
  options: ActionPlanTargetLoopOptions,
  recovery: ActionAttemptRecoveryResult,
  attempt: RemoteAttempt,
): Promise<RemoteAttemptResult | undefined> {
  switch (recovery.kind) {
    case "uncertain":
      return reconcileExistingUncertain(options, attempt);
    case "already-resolved":
      return recovery.result;
    case "rejected":
      throw new Error(`target recovery was rejected: ${recovery.reason}`);
    case "not-dispatched":
      return undefined;
    default: {
      const exhaustive: never = recovery;
      return exhaustive;
    }
  }
}

async function resolveExistingResult(
  options: ActionPlanTargetLoopOptions,
  result: RemoteAttemptResult,
  targetOrdinal: number,
): Promise<RemoteAttemptResult> {
  if (result.certainty === "uncertain") {
    const attempt = readActionPlanAttempt(options.database, result.attemptId);
    if (attempt === undefined) throw new Error("uncertain result has no durable attempt");
    const reconciled = await reconcileExistingUncertain(options, attempt.attempt);
    if (reconciled === undefined)
      throw new Error(`target ${targetOrdinal} uncertain result missing`);
    return reconciled;
  }
  return result;
}

async function reconcileExistingUncertain(
  options: ActionPlanTargetLoopOptions,
  attempt: RemoteAttempt,
): Promise<RemoteAttemptResult> {
  const existing = readActionPlanResult(options.database, attempt.attemptId);
  const resultAt =
    existing?.certainty === "uncertain"
      ? laterInstant(options.now, existing.resultAt)
      : resultInstant(options, attempt);
  const reconciled = await reconcileUncertainActionPlanAttempt(options.database, {
    attemptId: attempt.attemptId,
    resultAt,
    observer: options.uncertainObserver,
  });
  switch (reconciled.kind) {
    case "recorded":
      return reconciled.result;
    case "already-resolved":
      return reconciled.result;
    case "not-dispatched":
      throw new Error("uncertain target has no durable dispatch marker");
    case "rejected":
      if (reconciled.reason === "result-conflict") {
        const existing = readActionPlanResult(options.database, attempt.attemptId);
        if (existing?.certainty === "uncertain") return existing;
      }
      throw new Error(`uncertain reconciliation was rejected: ${reconciled.reason}`);
    default: {
      const exhaustive: never = reconciled;
      return exhaustive;
    }
  }
}

async function persistExecution(
  options: ActionPlanTargetLoopOptions,
  attempt: RemoteAttempt,
  execution: RemoteAttemptExecution,
): Promise<RemoteAttemptResult> {
  if (execution.kind === "stale") {
    const result = readActionPlanResult(options.database, attempt.attemptId);
    if (result === undefined || result.certainty !== "definite") {
      throw new Error("stale execution did not produce a durable definite result");
    }
    return result;
  }
  if (execution.kind === "blocked") {
    const result = blockedResult(attempt, execution.observation, resultInstant(options, attempt));
    return persistDefinite(options.database, result);
  }

  const raw =
    options.normalizeMutationResult?.({
      attempt,
      resultAt: resultInstant(options, attempt),
      raw: execution.result,
    }) ?? execution.result;
  const result = createRemoteAttemptResult(raw);
  assertResultIdentity(result, attempt);
  if (result.certainty === "uncertain") {
    const reconciled = recordActionPlanReconciliationResult(options.database, { result });
    if (reconciled.kind !== "recorded") {
      throw new Error(`uncertain result was not durable: ${reconciled.reason}`);
    }
    return reconcileExistingUncertain(options, attempt);
  }
  return persistDefinite(options.database, result);
}

function persistDefinite(
  database: Database,
  result: Exclude<RemoteAttemptResult, { certainty: "uncertain" }>,
): RemoteAttemptResult {
  const recorded = recordDefiniteActionPlanResult(database, { result });
  if (recorded.kind === "recorded") return recorded.result;
  if (recorded.reason === "result-exists") {
    const existing = readActionPlanResult(database, result.attemptId);
    if (existing !== undefined) return existing;
  }
  throw new Error(`definite result was not durable: ${recorded.reason}`);
}

async function recoverAfterInterruption(
  options: ActionPlanTargetLoopOptions,
  attempt: RemoteAttempt,
): Promise<RemoteAttemptResult> {
  const recovered = recoverUnresolvedActionPlanAttempt(options.database, {
    attemptId: attempt.attemptId,
    recoveredAt: resultInstant(options, attempt),
  });
  switch (recovered.kind) {
    case "uncertain":
      return reconcileExistingUncertain(options, attempt);
    case "already-resolved":
      return recovered.result;
    case "not-dispatched": {
      const failed = createRemoteAttemptFailed({
        kind: "failed",
        planId: attempt.planId,
        action: attempt.action,
        target: attempt.target,
        attemptId: attempt.attemptId,
        idempotencyKey: attempt.idempotencyKey,
        startedAt: attempt.startedAt,
        resultAt: resultInstant(options, attempt),
        certainty: "definite",
        failureReason: "transport-failed-before-transmission",
        detail: "target execution failed before dispatch",
      });
      return persistDefinite(options.database, failed);
    }
    case "rejected":
      throw new Error(`target interruption recovery was rejected: ${recovered.reason}`);
    default: {
      const exhaustive: never = recovered;
      return exhaustive;
    }
  }
}

function blockedResult(
  attempt: RemoteAttempt,
  observation: Exclude<PreconditionObservation, { kind: "satisfied" | "stale" | "epoch_changed" }>,
  resultAt: UtcInstant,
): Exclude<RemoteAttemptResult, { certainty: "uncertain" }> {
  if (observation.kind === "transport_error") {
    return createRemoteAttemptFailed({
      kind: "failed",
      planId: attempt.planId,
      action: attempt.action,
      target: attempt.target,
      attemptId: attempt.attemptId,
      idempotencyKey: attempt.idempotencyKey,
      startedAt: attempt.startedAt,
      resultAt,
      certainty: "definite",
      failureReason: "transport-failed-before-transmission",
      detail: `precondition read failed during ${observation.phase}`,
    });
  }
  return createRemoteAttemptRejected({
    kind: "rejected",
    planId: attempt.planId,
    action: attempt.action,
    target: attempt.target,
    attemptId: attempt.attemptId,
    idempotencyKey: attempt.idempotencyKey,
    startedAt: attempt.startedAt,
    resultAt,
    certainty: "definite",
    detail:
      observation.kind === "missing"
        ? "precondition target is missing"
        : `precondition is unsupported: ${observation.reason}`,
  });
}

function assertResultIdentity(result: RemoteAttemptResult, attempt: RemoteAttempt): void {
  if (
    result.planId !== attempt.planId ||
    result.attemptId !== attempt.attemptId ||
    result.idempotencyKey !== attempt.idempotencyKey ||
    result.action.kind !== attempt.action.kind ||
    result.target.accountId !== attempt.target.accountId ||
    result.target.mailboxId !== attempt.target.mailboxId ||
    result.target.uidValidity !== attempt.target.uidValidity ||
    result.target.uid !== attempt.target.uid ||
    result.target.precondition.modseq !== attempt.target.precondition.modseq
  ) {
    throw new TypeError("mutation result does not match the durable target attempt");
  }
}

function resultInstant(options: ActionPlanTargetLoopOptions, attempt: RemoteAttempt): UtcInstant {
  const now = currentNow(options);
  return Date.parse(now) >= Date.parse(attempt.startedAt) ? now : attempt.startedAt;
}

function currentNow(options: ActionPlanTargetLoopOptions): UtcInstant {
  return options.freshNow();
}

function laterInstant(left: UtcInstant, right: UtcInstant): UtcInstant {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
