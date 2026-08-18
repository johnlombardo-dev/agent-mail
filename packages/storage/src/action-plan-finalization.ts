import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  createActionPlanId,
  createClaimId,
  createExecutingActionPlan,
  createMonotonicSequence,
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  parseUtcInstant,
  type ActionPlanId,
  type ActionPlanTarget,
  type ActionPlanState,
  type ExecutingActionPlan,
  type RemoteAttemptResult,
  type UtcInstant,
} from "@agent-mail/core";
import { readActionPlanAttempt } from "./action-plan-attempt";
import { readActionPlanResult } from "./action-plan-result";
import {
  readEffectAuthorityProjection,
  recordActionPlanTerminalAudit,
} from "./action-approval-authority";

/** A status produced only after every durable target slot has been inspected. */
export type PlanFinalizationState =
  | "completed"
  | "partial"
  | "rejected"
  | "expired"
  | "failed"
  | "uncertain";

export type PlanFinalizationResultCounts = Readonly<{
  readonly success: number;
  readonly stale: number;
  readonly rejected: number;
  readonly failed: number;
  readonly uncertain: number;
}>;

export type PlanFinalizationTarget = Readonly<{
  readonly targetOrdinal: number;
  readonly target: ActionPlanTarget;
  readonly result: RemoteAttemptResult | undefined;
}>;

type CompletePlanFinalizationTarget = Readonly<{
  readonly targetOrdinal: number;
  readonly target: ActionPlanTarget;
  readonly result: RemoteAttemptResult;
}>;

export type PlanFinalizationPolicy = Readonly<{
  readonly planId: ActionPlanId;
  readonly targets: readonly [ActionPlanTarget, ...ActionPlanTarget[]];
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly now: UtcInstant;
}>;

export type PlanFinalizationDecision = Readonly<{
  readonly state: PlanFinalizationState;
  readonly counts: PlanFinalizationResultCounts;
  readonly targetResults: readonly [
    CompletePlanFinalizationTarget,
    ...CompletePlanFinalizationTarget[],
  ];
  readonly uncertainTargetOrdinals: readonly number[];
}>;

export type FinalizeActionPlanInput = Readonly<{
  readonly planId: unknown;
  readonly claimId: unknown;
  readonly expectedVersion: unknown;
  readonly now: unknown;
  /** The process that actually performs terminal finalization. */
  readonly executorInstanceId?: unknown;
}>;

export type FinalizeActionPlanResult = Readonly<{
  readonly kind: "finalized";
  readonly planId: ActionPlanId;
  readonly state: PlanFinalizationState;
  readonly version: number;
  readonly counts: PlanFinalizationResultCounts;
  readonly targetResults: readonly [
    CompletePlanFinalizationTarget,
    ...CompletePlanFinalizationTarget[],
  ];
}>;

export class ActionPlanFinalizationError extends Error {
  readonly code = "action-plan-finalization-rejected" as const;

  constructor(message: string) {
    super(message);
    this.name = "ActionPlanFinalizationError";
  }
}

/**
 * Pure, order-independent aggregation. Target ordinals are the identity; the
 * input order is never allowed to change the decision. Missing evidence is a
 * precondition failure, while a durable uncertain result remains a terminal
 * uncertain outcome.
 */
export function mapPlanFinalization(
  policy: PlanFinalizationPolicy,
  targetResults: readonly [PlanFinalizationTarget, ...PlanFinalizationTarget[]],
): PlanFinalizationDecision {
  if (targetResults.length !== policy.targets.length) {
    throw new ActionPlanFinalizationError("plan finalization target set is incomplete");
  }
  const targetByOrdinal = new Map<number, ActionPlanTarget>();
  for (const [index, target] of policy.targets.entries()) {
    const ordinal = index + 1;
    targetByOrdinal.set(ordinal, target);
  }

  const seen = new Set<number>();
  const ordered = [...targetResults].sort(
    (left, right) => left.targetOrdinal - right.targetOrdinal,
  );
  for (const item of ordered) {
    if (!Number.isSafeInteger(item.targetOrdinal) || item.targetOrdinal < 1) {
      throw new ActionPlanFinalizationError("plan finalization target ordinal is invalid");
    }
    const expected = targetByOrdinal.get(item.targetOrdinal);
    if (expected === undefined || seen.has(item.targetOrdinal)) {
      throw new ActionPlanFinalizationError("plan finalization target identity is incomplete");
    }
    assertTargetIdentity(expected, item.target);
    seen.add(item.targetOrdinal);
  }
  if (seen.size !== policy.targets.length) {
    throw new ActionPlanFinalizationError("plan finalization target identity is incomplete");
  }

  const counts = {
    success: 0,
    stale: 0,
    rejected: 0,
    failed: 0,
    uncertain: 0,
  } satisfies Record<keyof PlanFinalizationResultCounts, number>;
  const uncertainTargetOrdinals: number[] = [];
  const completeResults: CompletePlanFinalizationTarget[] = [];
  for (const item of ordered) {
    const result = item.result;
    if (result === undefined)
      throw new ActionPlanFinalizationError(
        "plan finalization requires every durable target result",
      );
    counts[result.kind] += 1;
    completeResults.push({ targetOrdinal: item.targetOrdinal, target: item.target, result });
    if (result.certainty === "uncertain") uncertainTargetOrdinals.push(item.targetOrdinal);
  }

  const state = decideState(policy, completeResults, counts);
  const first = completeResults[0];
  if (first === undefined)
    throw new ActionPlanFinalizationError("plan finalization has no targets");
  const orderedTuple: readonly [
    CompletePlanFinalizationTarget,
    ...CompletePlanFinalizationTarget[],
  ] = [first, ...completeResults.slice(1)];
  return Object.freeze({
    state,
    counts: Object.freeze(counts),
    targetResults: orderedTuple,
    uncertainTargetOrdinals: Object.freeze(uncertainTargetOrdinals),
  });
}

function decideState(
  policy: PlanFinalizationPolicy,
  targetResults: readonly CompletePlanFinalizationTarget[],
  counts: PlanFinalizationResultCounts,
): PlanFinalizationState {
  if (counts.uncertain > 0) return "uncertain";
  if (Date.parse(policy.now) >= Date.parse(policy.expiresAt)) return "expired";
  if (targetResults.every((item) => item.result?.kind === "success")) return "completed";
  if (
    targetResults.every((item) => item.result?.kind === "stale" || item.result?.kind === "rejected")
  ) {
    return "rejected";
  }
  if (targetResults.every((item) => item.result?.kind === "failed")) return "failed";
  return "partial";
}

/** Finalize one executing claim and its bounded journal summary in one transaction. */
export function finalizeActionPlan(
  database: Database,
  input: FinalizeActionPlanInput,
): FinalizeActionPlanResult {
  const prepared = prepareInput(input);
  const authorityInstalled =
    database
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'action_approval_consumptions';",
      )
      .get() !== null;
  if (authorityInstalled && prepared.executorInstanceId === undefined)
    throw new ActionPlanFinalizationError(
      "terminal executor identity is required when approval authority is installed",
    );
  return finalizeActionPlanInternal(database, input, {
    kind: "effect-executor",
    instanceId: prepared.executorInstanceId ?? "executor:legacy-finalizer",
  });
}

/** Finalize durable results after restart without becoming an effect executor. */
export function finalizeActionPlanAfterRecovery(
  database: Database,
  input: FinalizeActionPlanInput,
  finalizerInstanceId: unknown,
): FinalizeActionPlanResult {
  const finalizer = text(finalizerInstanceId, "recovery finalizer instance ID");
  if (
    !finalizer.startsWith("recovery-finalizer:") ||
    finalizer.length > 256 ||
    finalizer.length === "recovery-finalizer:".length ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(finalizer)
  )
    throw new ActionPlanFinalizationError("recovery finalizer identity is invalid");
  return finalizeActionPlanInternal(database, input, {
    kind: "ordinary-recovery",
    instanceId: finalizer,
  });
}

type FinalizerMode = Readonly<{
  readonly kind: "effect-executor" | "ordinary-recovery";
  readonly instanceId: string;
}>;

function finalizeActionPlanInternal(
  database: Database,
  input: FinalizeActionPlanInput,
  finalizer: FinalizerMode,
): FinalizeActionPlanResult {
  const prepared = prepareInput(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const row = readPlanRow(database, prepared.planId);
    if (row === undefined) throw new ActionPlanFinalizationError("action plan does not exist");
    if (row.state !== "executing") {
      const replay = readReplay(database, prepared, row.state);
      if (replay !== undefined) {
        database.exec("COMMIT;");
        transactionStarted = false;
        return replay;
      }
      throw new ActionPlanFinalizationError("action plan is not executing");
    }
    if (row.version !== prepared.expectedVersion) {
      throw new ActionPlanFinalizationError("action plan version is stale");
    }
    if (row.claimId !== prepared.claimId) {
      throw new ActionPlanFinalizationError("action plan claim identity is stale");
    }
    if (row.startedAt === undefined) {
      throw new ActionPlanFinalizationError("executing action plan has incomplete claim identity");
    }
    const plan = readExecutingPlan(database, row);
    assertActiveClaim(database, plan);
    const targetResults = readTargetResults(database, plan, prepared.claimId);
    const decision = mapPlanFinalization(
      {
        planId: plan.planId,
        targets: plan.targets,
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
        now: prepared.now,
      },
      targetResults,
    );
    const terminalVersion = prepared.expectedVersion + 1;
    updatePlan(database, plan, prepared.claimId, prepared.expectedVersion, prepared.now, decision);
    const journalId = `action-plan-finalization:${plan.planId}`;
    const payload = serializeSummary(prepared, decision, terminalVersion);
    recordAuthorityTerminalAudit(
      database,
      plan.planId,
      prepared.claimId,
      decision.state,
      prepared.now,
      payload,
      finalizer,
    );
    insertAndVerifyJournal(
      database,
      journalId,
      prepared.now,
      plan.planId,
      prepared.claimId,
      payload,
    );
    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      kind: "finalized",
      planId: plan.planId,
      state: decision.state,
      version: terminalVersion,
      counts: decision.counts,
      targetResults: decision.targetResults,
    };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

/**
 * Reconcile a pre-authority executing plan after a restart. Legacy plans have
 * no receipt and therefore cannot receive a fabricated terminal audit or a
 * new executor capability. This path only accepts already-dispatched target
 * results and records the terminal state in the existing plan/journal rows.
 */
export function finalizeLegacyActionPlan(
  database: Database,
  input: FinalizeActionPlanInput,
): FinalizeActionPlanResult {
  const prepared = prepareInput(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const row = readPlanRow(database, prepared.planId);
    if (row === undefined) throw new ActionPlanFinalizationError("action plan does not exist");
    if (row.state !== "executing") {
      const replay = readReplay(database, prepared, row.state);
      if (replay !== undefined) {
        database.exec("COMMIT;");
        transactionStarted = false;
        return replay;
      }
      throw new ActionPlanFinalizationError("legacy action plan is not executing");
    }
    if (row.version !== prepared.expectedVersion)
      throw new ActionPlanFinalizationError("legacy action plan version is stale");
    if (row.claimId !== prepared.claimId)
      throw new ActionPlanFinalizationError("legacy action plan claim identity is stale");
    const authority = database
      .query("SELECT authority_version FROM action_plan_authority_versions WHERE plan_id = ?;")
      .get(prepared.planId);
    if (!isRecord(authority) || authority.authority_version !== "legacy-untrusted")
      throw new ActionPlanFinalizationError("action plan is not legacy-untrusted");
    const plan = readExecutingPlan(database, row);
    assertActiveClaim(database, plan);
    const targetResults = readTargetResults(database, plan, prepared.claimId);
    const decision = mapPlanFinalization(
      {
        planId: plan.planId,
        targets: plan.targets,
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
        now: prepared.now,
      },
      targetResults,
    );
    const terminalVersion = prepared.expectedVersion + 1;
    updatePlan(database, plan, prepared.claimId, prepared.expectedVersion, prepared.now, decision);
    const payload = serializeSummary(prepared, decision, terminalVersion);
    insertAndVerifyJournal(
      database,
      `action-plan-finalization:${plan.planId}`,
      prepared.now,
      plan.planId,
      prepared.claimId,
      payload,
    );
    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      kind: "finalized",
      planId: plan.planId,
      state: decision.state,
      version: terminalVersion,
      counts: decision.counts,
      targetResults: decision.targetResults,
    };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

function recordAuthorityTerminalAudit(
  database: Database,
  planId: ActionPlanId,
  claimId: string,
  state: PlanFinalizationState,
  terminalAt: string,
  payload: string,
  finalizer: FinalizerMode,
): void {
  const authorityInstalled =
    database
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'action_approval_consumptions';",
      )
      .get() !== null;
  if (!authorityInstalled) return;
  const receipt = database
    .query(
      "SELECT receipt_id FROM action_approval_consumptions WHERE plan_id = ? AND claim_id = ?;",
    )
    .get(planId, claimId);
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt))
    throw new ActionPlanFinalizationError("authority receipt is missing for terminal action plan");
  const receiptId = Object.fromEntries(Object.entries(receipt)).receipt_id;
  if (typeof receiptId !== "string")
    throw new ActionPlanFinalizationError("authority receipt identity is invalid");
  const effect = readEffectAuthorityProjection(database, { planId, receiptId, claimId });
  if (effect.count === 0)
    throw new ActionPlanFinalizationError("terminal effect authority set is empty");
  const effectExecutorIds = new Set<string>();
  for (const [attemptId] of effect.rows) {
    const attempt = readActionPlanAttempt(database, attemptId);
    if (attempt === undefined || attempt.claimId !== claimId)
      throw new ActionPlanFinalizationError("terminal effect authority attempt is incomplete");
    if (readActionPlanResult(database, attemptId) === undefined)
      throw new ActionPlanFinalizationError("terminal effect authority result is incomplete");
    const row = effect.rows.find((candidate) => candidate[0] === attemptId);
    if (row !== undefined) effectExecutorIds.add(row[2]);
  }
  if (finalizer.kind === "effect-executor" && !effectExecutorIds.has(finalizer.instanceId))
    throw new ActionPlanFinalizationError(
      "terminal executor identity is not attributed to the consumed receipt",
    );
  recordActionPlanTerminalAudit(database, {
    planId,
    receiptId,
    claimId,
    terminalState: state,
    terminalAt,
    executorDisposition: "started",
    effectAttemptCount: effect.count,
    effectAuthoritySetDigest: effect.digest,
    executorInstanceId: effect.executorInstanceId,
    finalizerKind: finalizer.kind,
    finalizerInstanceId: finalizer.instanceId,
    reasonCode: "normal-finalization",
    restoreEventId: "restore-event:none",
    resultDigest: createHash("sha256").update(payload).digest("hex"),
  });
}

function prepareInput(input: FinalizeActionPlanInput): Readonly<{
  readonly planId: ActionPlanId;
  readonly claimId: ReturnType<typeof createClaimId>;
  readonly expectedVersion: number;
  readonly now: UtcInstant;
  readonly executorInstanceId: string | undefined;
}> {
  const executorInstanceId =
    input.executorInstanceId === undefined ? undefined : executorIdentity(input.executorInstanceId);
  return {
    planId: createActionPlanId(input.planId),
    claimId: createClaimId(input.claimId),
    expectedVersion: positiveInteger(input.expectedVersion, "expected plan version"),
    now: parseUtcInstant(input.now),
    executorInstanceId,
  };
}

type PlanRow = Readonly<{
  readonly planId: ActionPlanId;
  readonly state: ActionPlanState;
  readonly actionKind: string;
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly claimId: ReturnType<typeof createClaimId> | undefined;
  readonly startedAt: UtcInstant | undefined;
  readonly version: number;
}>;

function readPlanRow(database: Database, planId: ActionPlanId): PlanRow | undefined {
  const value: unknown = database
    .query(
      "SELECT plan_id, state, action_kind, created_at, expires_at, claim_id, started_at, version " +
        "FROM action_plans WHERE plan_id = ?;",
    )
    .get(planId);
  if (value === null) return undefined;
  const row = record(value, "action plan row");
  const state = closedState(row.state);
  return {
    planId: createActionPlanId(row.plan_id),
    state,
    actionKind: text(row.action_kind, "action kind"),
    createdAt: parseUtcInstant(row.created_at),
    expiresAt: parseUtcInstant(row.expires_at),
    claimId: row.claim_id === null ? undefined : createClaimId(row.claim_id),
    startedAt: row.started_at === null ? undefined : parseUtcInstant(row.started_at),
    version: positiveInteger(row.version, "stored plan version"),
  };
}

function readExecutingPlan(database: Database, row: PlanRow): ExecutingActionPlan {
  if (row.claimId === undefined || row.startedAt === undefined) {
    throw new ActionPlanFinalizationError("executing action plan has incomplete identity");
  }
  const values: unknown[] = database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid, precondition_modseq " +
        "FROM action_plan_targets WHERE plan_id = ? ORDER BY target_ordinal;",
    )
    .all(row.planId);
  const targets = values.map(readTarget);
  const first = targets[0];
  if (first === undefined) throw new ActionPlanFinalizationError("action plan has no targets");
  return createExecutingActionPlan({
    state: "executing",
    planId: row.planId,
    action: { kind: row.actionKind },
    targets: [first, ...targets.slice(1)],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    claimId: row.claimId,
    startedAt: row.startedAt,
  });
}

function readTarget(value: unknown): ActionPlanTarget {
  const row = record(value, "action plan target row");
  return {
    accountId: parseAccountId(row.account_id),
    mailboxId: parseMailboxId(row.mailbox_id),
    uidValidity: createUidValidity(row.uid_validity),
    uid: createRemoteUidValue(row.uid),
    precondition: {
      modseq: createMonotonicSequence(positiveOrZero(row.precondition_modseq, "target MODSEQ")),
    },
  };
}

function readTargetResults(
  database: Database,
  plan: ExecutingActionPlan,
  claimId: ReturnType<typeof createClaimId>,
): readonly [PlanFinalizationTarget, ...PlanFinalizationTarget[]] {
  const rows: unknown[] = database
    .query(
      "SELECT attempt_id, target_ordinal, claim_id FROM action_attempts WHERE plan_id = ? ORDER BY target_ordinal;",
    )
    .all(plan.planId);
  const byOrdinal = new Map<number, { readonly attemptId: string; readonly claimId: string }>();
  for (const value of rows) {
    const row = record(value, "action attempt identity row");
    const ordinal = positiveInteger(row.target_ordinal, "target ordinal");
    if (byOrdinal.has(ordinal))
      throw new ActionPlanFinalizationError("target has multiple attempts");
    byOrdinal.set(ordinal, {
      attemptId: namespaced(row.attempt_id, "attempt:"),
      claimId: namespaced(row.claim_id, "claim:"),
    });
  }
  for (const ordinal of byOrdinal.keys()) {
    if (ordinal > plan.targets.length)
      throw new ActionPlanFinalizationError("target attempt identity is incomplete");
  }
  const results: PlanFinalizationTarget[] = [];
  for (const [index, target] of plan.targets.entries()) {
    const ordinal = index + 1;
    const attemptIdentity = byOrdinal.get(ordinal);
    if (attemptIdentity === undefined) {
      throw new ActionPlanFinalizationError("target attempt identity is incomplete");
    }
    if (attemptIdentity.claimId !== claimId) {
      throw new ActionPlanFinalizationError("target attempt claim identity is stale");
    }
    const opened = readActionPlanAttempt(database, attemptIdentity.attemptId);
    if (opened === undefined || opened.claimId !== claimId) {
      throw new ActionPlanFinalizationError("target attempt identity is incomplete");
    }
    assertTargetIdentity(target, opened.attempt.target);
    const result = readActionPlanResult(database, attemptIdentity.attemptId);
    if (result === undefined) {
      throw new ActionPlanFinalizationError(
        "plan finalization requires every durable target result",
      );
    }
    if (result.planId !== plan.planId || result.action.kind !== plan.action.kind) {
      throw new ActionPlanFinalizationError("target result plan identity is stale");
    }
    assertTargetIdentity(target, result.target);
    results.push({ targetOrdinal: ordinal, target, result });
  }
  const first = results[0];
  if (first === undefined) throw new ActionPlanFinalizationError("action plan has no targets");
  return [first, ...results.slice(1)];
}

function assertActiveClaim(database: Database, plan: ExecutingActionPlan): void {
  const row: unknown = database
    .query("SELECT claimed_at FROM action_plan_claims WHERE plan_id = ? AND claim_id = ?;")
    .get(plan.planId, plan.claimId);
  if (row === null)
    throw new ActionPlanFinalizationError("executing action plan claim is incomplete");
  const claimedAt = parseUtcInstant(record(row, "action plan claim row").claimed_at);
  if (claimedAt !== plan.startedAt)
    throw new ActionPlanFinalizationError("action plan claim identity is stale");
}

function updatePlan(
  database: Database,
  plan: ExecutingActionPlan,
  claimId: ReturnType<typeof createClaimId>,
  expectedVersion: number,
  at: UtcInstant,
  decision: PlanFinalizationDecision,
): void {
  const uncertainResult = decision.targetResults.find(
    (item) => item.result.certainty === "uncertain",
  );
  const uncertainAttemptId = uncertainResult?.result.attemptId;
  if (decision.state === "uncertain" && uncertainAttemptId === undefined) {
    throw new ActionPlanFinalizationError("uncertain finalization has no durable attempt identity");
  }
  const failedAt = decision.state === "failed" ? at : null;
  const completedAt = decision.state === "completed" || decision.state === "partial" ? at : null;
  const rejectedAt = decision.state === "rejected" ? at : null;
  const expiredAt = decision.state === "expired" ? at : null;
  const rejectionReason =
    decision.state === "rejected" ? "all targets were rejected or stale" : null;
  const update = database
    .query(
      "UPDATE action_plans SET state = ?, claim_id = NULL, started_at = NULL, completed_at = ?, " +
        "failed_at = ?, rejected_at = ?, rejection_reason = ?, expired_at = ?, uncertain_attempt_id = ?, " +
        "missing_local_result_at = ?, version = version + 1 " +
        "WHERE plan_id = ? AND state = 'executing' AND claim_id = ? AND version = ?;",
    )
    .run(
      decision.state,
      completedAt,
      failedAt,
      rejectedAt,
      rejectionReason,
      expiredAt,
      uncertainAttemptId ?? null,
      decision.state === "uncertain" ? at : null,
      plan.planId,
      claimId,
      expectedVersion,
    );
  if (update.changes !== 1)
    throw new ActionPlanFinalizationError("action plan finalization lost its version race");
}

function serializeSummary(
  input: Readonly<{
    readonly claimId: ReturnType<typeof createClaimId>;
    readonly expectedVersion: number;
  }>,
  decision: PlanFinalizationDecision,
  version: number,
): string {
  const resultKinds = decision.targetResults.map((item) => item.result.kind);
  const payload = {
    version: 1,
    claimId: input.claimId,
    expectedVersion: input.expectedVersion,
    finalizedVersion: version,
    state: decision.state,
    counts: decision.counts,
    resultKinds,
    uncertainTargetOrdinals: decision.uncertainTargetOrdinals,
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > 16_000)
    throw new ActionPlanFinalizationError("finalization summary is too large");
  return serialized;
}

function insertAndVerifyJournal(
  database: Database,
  journalId: string,
  occurredAt: UtcInstant,
  planId: ActionPlanId,
  claimId: ReturnType<typeof createClaimId>,
  payload: string,
): void {
  database
    .query(
      "INSERT INTO operational_journal " +
        "(id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
        "VALUES (?, ?, 'action', ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING;",
    )
    .run(journalId, occurredAt, planId, claimId, payload);
  const row: unknown = database
    .query(
      "SELECT occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE id = ?;",
    )
    .get(journalId);
  const stored = record(row, "action plan finalization journal row");
  if (
    stored.occurred_at !== occurredAt ||
    stored.category !== "action" ||
    stored.subject_id !== planId ||
    stored.correlation_id !== claimId ||
    stored.payload_version !== 1 ||
    stored.payload_json !== payload
  ) {
    throw new ActionPlanFinalizationError("action plan finalization journal identity conflicts");
  }
}

function readReplay(
  database: Database,
  input: Readonly<{
    readonly planId: ActionPlanId;
    readonly claimId: ReturnType<typeof createClaimId>;
    readonly expectedVersion: number;
  }>,
  state: ActionPlanState,
): FinalizeActionPlanResult | undefined {
  if (state === "pending" || state === "executing") return undefined;
  const row: unknown = database
    .query(
      "SELECT occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE id = ?;",
    )
    .get(`action-plan-finalization:${input.planId}`);
  if (row === null)
    throw new ActionPlanFinalizationError("terminal plan has no finalization journal");
  const stored = record(row, "finalization replay journal row");
  if (
    stored.category !== "action" ||
    stored.subject_id !== input.planId ||
    stored.correlation_id !== input.claimId ||
    stored.payload_version !== 1
  ) {
    throw new ActionPlanFinalizationError("finalization replay identity is stale");
  }
  const payload = parseSummary(stored.payload_json);
  if (
    payload.claimId !== input.claimId ||
    payload.expectedVersion !== input.expectedVersion ||
    payload.state !== state
  ) {
    throw new ActionPlanFinalizationError("finalization replay claim or version is stale");
  }
  const targetResults = readTargetResultsForReplay(database, input.planId, payload.resultKinds);
  return {
    kind: "finalized",
    planId: input.planId,
    state: payload.state,
    version: payload.finalizedVersion,
    counts: payload.counts,
    targetResults,
  };
}

function readTargetResultsForReplay(
  database: Database,
  planId: ActionPlanId,
  kinds: readonly string[],
): readonly [CompletePlanFinalizationTarget, ...CompletePlanFinalizationTarget[]] {
  const row = readPlanRow(database, planId);
  if (row === undefined) throw new ActionPlanFinalizationError("terminal plan disappeared");
  const fake = {
    ...row,
    state: "executing",
    claimId: createClaimId("claim:replay"),
    startedAt: row.createdAt,
  } satisfies PlanRow;
  const plan = readExecutingPlan(database, fake);
  const attempts = database
    .query(
      "SELECT target_ordinal, attempt_id FROM action_attempts WHERE plan_id = ? ORDER BY target_ordinal;",
    )
    .all(planId)
    .map((value: unknown) => {
      const attempt = record(value, "replay target attempt row");
      return {
        ordinal: positiveInteger(attempt.target_ordinal, "target ordinal"),
        attemptId: namespaced(attempt.attempt_id, "attempt:"),
      };
    });
  const results: CompletePlanFinalizationTarget[] = [];
  for (const [index, target] of plan.targets.entries()) {
    const attempt = attempts.find((item) => item.ordinal === index + 1);
    if (attempt === undefined)
      throw new ActionPlanFinalizationError("replay target identity is incomplete");
    const result = readActionPlanResult(database, attempt.attemptId);
    const expectedKind = kinds[index];
    if (result === undefined || expectedKind === undefined || result.kind !== expectedKind) {
      throw new ActionPlanFinalizationError("finalization replay result set changed");
    }
    results.push({ targetOrdinal: index + 1, target, result });
  }
  const first = results[0];
  if (first === undefined) throw new ActionPlanFinalizationError("replay plan has no targets");
  return [first, ...results.slice(1)];
}

type Summary = Readonly<{
  readonly claimId: ReturnType<typeof createClaimId>;
  readonly expectedVersion: number;
  readonly finalizedVersion: number;
  readonly state: PlanFinalizationState;
  readonly counts: PlanFinalizationResultCounts;
  readonly resultKinds: readonly string[];
}>;

function parseSummary(value: unknown): Summary {
  if (typeof value !== "string")
    throw new ActionPlanFinalizationError("finalization journal payload is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ActionPlanFinalizationError("finalization journal payload is invalid");
  }
  const row = record(parsed, "finalization journal payload");
  if (row.version !== 1 || !Array.isArray(row.resultKinds))
    throw new ActionPlanFinalizationError("finalization journal payload is invalid");
  const counts = record(row.counts, "finalization result counts");
  return {
    claimId: createClaimId(row.claimId),
    expectedVersion: positiveInteger(row.expectedVersion, "expected plan version"),
    finalizedVersion: positiveInteger(row.finalizedVersion, "finalized plan version"),
    state: finalizationState(row.state),
    counts: {
      success: nonNegativeInteger(counts.success, "success count"),
      stale: nonNegativeInteger(counts.stale, "stale count"),
      rejected: nonNegativeInteger(counts.rejected, "rejected count"),
      failed: nonNegativeInteger(counts.failed, "failed count"),
      uncertain: nonNegativeInteger(counts.uncertain, "uncertain count"),
    },
    resultKinds: row.resultKinds.map((item) => text(item, "result kind")),
  };
}

function assertTargetIdentity(left: ActionPlanTarget, right: ActionPlanTarget): void {
  if (
    left.accountId !== right.accountId ||
    left.mailboxId !== right.mailboxId ||
    left.uidValidity !== right.uidValidity ||
    left.uid !== right.uid ||
    left.precondition.modseq !== right.precondition.modseq
  )
    throw new ActionPlanFinalizationError("target identity is not immutable");
}

function closedState(value: unknown): ActionPlanState {
  if (
    value !== "pending" &&
    value !== "executing" &&
    value !== "completed" &&
    value !== "partial" &&
    value !== "rejected" &&
    value !== "expired" &&
    value !== "failed" &&
    value !== "uncertain" &&
    value !== "restore-quarantined"
  )
    throw new ActionPlanFinalizationError("stored plan state is invalid");
  return value;
}

function finalizationState(value: unknown): PlanFinalizationState {
  if (
    value !== "completed" &&
    value !== "partial" &&
    value !== "rejected" &&
    value !== "expired" &&
    value !== "failed" &&
    value !== "uncertain"
  ) {
    throw new ActionPlanFinalizationError("finalization state is invalid");
  }
  return value;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ActionPlanFinalizationError(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    throw new ActionPlanFinalizationError(`${label} is invalid`);
  return value;
}

function executorIdentity(value: unknown): string {
  const identity = text(value, "executor instance ID");
  if (
    identity.length > 256 ||
    identity.length <= "executor:".length ||
    !identity.startsWith("executor:") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(identity)
  )
    throw new ActionPlanFinalizationError("executor instance ID is invalid");
  return identity;
}

function namespaced(value: unknown, prefix: string): string {
  const valueText = text(value, "namespaced identity");
  if (!valueText.startsWith(prefix))
    throw new ActionPlanFinalizationError("namespaced identity is invalid");
  return valueText;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ActionPlanFinalizationError(`${label} is invalid`);
  return value;
}

function positiveOrZero(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ActionPlanFinalizationError(`${label} is invalid`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  return positiveOrZero(value, label);
}

function rollback(database: Database, original: unknown): void {
  try {
    database.exec("ROLLBACK;");
  } catch (rollbackError: unknown) {
    throw new AggregateError([original, rollbackError], "action plan finalization rollback failed");
  }
}
