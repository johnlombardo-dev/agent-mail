import type { Database } from "bun:sqlite";
import {
  createRemoteAttemptId,
  createRemoteAttemptUncertain,
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  parseUtcInstant,
  type RemoteAttemptResult,
  type RemoteAttemptUncertain,
} from "@agent-mail/core";
import { readActionPlanAttempt } from "./action-plan-attempt";
import { readActionPlanResult } from "./action-plan-result";
import { actionAttemptDispatchMigrations } from "./migrations/0005-action-attempt-dispatch";

export type ActionAttemptDispatchResult =
  | Readonly<{ readonly kind: "marked"; readonly attemptId: string; readonly dispatchedAt: string }>
  | Readonly<{
      readonly kind: "rejected";
      readonly attemptId: string;
      readonly reason: "missing" | "inactive-claim" | "conflict";
    }>;

export type ActionAttemptRecoveryResult =
  | Readonly<{ readonly kind: "not-dispatched"; readonly attemptId: string }>
  | Readonly<{ readonly kind: "uncertain"; readonly result: RemoteAttemptUncertain }>
  | Readonly<{ readonly kind: "already-resolved"; readonly result: RemoteAttemptResult }>
  | Readonly<{
      readonly kind: "rejected";
      readonly attemptId: string;
      readonly reason: "missing" | "inactive-claim";
    }>;

type PreparedDispatch = Readonly<{
  readonly attemptId: string;
  readonly dispatchedAt: string;
  readonly observationAt: string;
  readonly observationAccountId: string;
  readonly observationMailboxId: string;
  readonly observationUidValidity: number;
  readonly observationUid: number;
  readonly observationModseq: number;
}>;

type DispatchEvidence = Readonly<{
  readonly dispatchedAt: string;
  readonly observationAt: string;
  readonly observationUidValidity: number;
  readonly observationUid: number;
  readonly observationModseq: number;
}>;

/** Commit the dispatch-crossed marker before the adapter is called. */
export function markActionPlanAttemptDispatched(
  database: Database,
  input: unknown,
): ActionAttemptDispatchResult {
  const prepared = prepareDispatch(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    requireRecoverySchema(database);
    const attempt = readActionPlanAttempt(database, prepared.attemptId);
    if (attempt === undefined) {
      return commit(database, { kind: "rejected", attemptId: prepared.attemptId, reason: "missing" });
    }
    if (!isActiveAttempt(database, prepared.attemptId, attempt.claimId)) {
      return commit(database, {
        kind: "rejected",
        attemptId: prepared.attemptId,
        reason: "inactive-claim",
      });
    }
    if (
      prepared.observationAccountId !== attempt.attempt.target.accountId ||
      prepared.observationMailboxId !== attempt.attempt.target.mailboxId ||
      prepared.observationUidValidity !== attempt.attempt.target.uidValidity ||
      prepared.observationUid !== attempt.attempt.target.uid ||
      prepared.observationModseq !== attempt.attempt.target.precondition.modseq
    ) {
      throw new TypeError("dispatch observation does not match the attempt target");
    }
    const existing = readDispatchEvidence(database, prepared.attemptId);
    if (existing !== undefined) {
      return commit(
        database,
        sameDispatch(existing, prepared)
          ? { kind: "marked", attemptId: prepared.attemptId, dispatchedAt: existing.dispatchedAt }
          : { kind: "rejected", attemptId: prepared.attemptId, reason: "conflict" },
      );
    }
    const targetOrdinal = readTargetOrdinal(database, prepared.attemptId);
    database
      .query(
        "INSERT INTO action_attempt_dispatches " +
          "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
          "idempotency_key, started_at, command_kind, dispatched_at, observation_kind, " +
          "observation_at, observation_uid_validity, observation_uid, observation_modseq) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'satisfied', ?, ?, ?, ?);",
      )
      .run(
        attempt.attempt.attemptId,
        attempt.attempt.planId,
        targetOrdinal,
        attempt.attempt.target.accountId,
        attempt.attempt.target.mailboxId,
        attempt.attempt.target.uidValidity,
        attempt.attempt.target.uid,
        attempt.attempt.idempotencyKey,
        attempt.attempt.startedAt,
        attempt.attempt.action.kind,
        prepared.dispatchedAt,
        prepared.observationAt,
        prepared.observationUidValidity,
        prepared.observationUid,
        prepared.observationModseq,
      );
    database.exec("COMMIT;");
    transactionStarted = false;
    return { kind: "marked", attemptId: prepared.attemptId, dispatchedAt: prepared.dispatchedAt };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

/** Reclassify a dispatch-crossed unresolved attempt after restart. */
export function recoverUnresolvedActionPlanAttempt(
  database: Database,
  input: unknown,
): ActionAttemptRecoveryResult {
  const prepared = prepareRecovery(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    requireRecoverySchema(database);
    const attempt = readActionPlanAttempt(database, prepared.attemptId);
    if (attempt === undefined) {
      return commit(database, { kind: "rejected", attemptId: prepared.attemptId, reason: "missing" });
    }
    const existing = readExistingResult(database, prepared.attemptId);
    if (existing !== undefined) {
      return commit(
        database,
        existing.certainty === "uncertain"
          ? { kind: "uncertain", result: existing }
          : { kind: "already-resolved", result: existing },
      );
    }
    if (!isActiveAttempt(database, prepared.attemptId, attempt.claimId)) {
      return commit(database, {
        kind: "rejected",
        attemptId: prepared.attemptId,
        reason: "inactive-claim",
      });
    }
    const dispatch = readDispatchEvidence(database, prepared.attemptId);
    if (dispatch === undefined) {
      return commit(database, { kind: "not-dispatched", attemptId: prepared.attemptId });
    }
    const result = createRemoteAttemptUncertain({
      planId: attempt.attempt.planId,
      action: attempt.attempt.action,
      target: attempt.attempt.target,
      attemptId: attempt.attempt.attemptId,
      idempotencyKey: attempt.attempt.idempotencyKey,
      startedAt: attempt.attempt.startedAt,
      resultAt: prepared.recoveredAt,
      kind: "uncertain",
      certainty: "uncertain",
      uncertainReason: "local-result-not-durable",
      detail: dispatchDetail(attempt, dispatch),
    });
    const targetOrdinal = readTargetOrdinal(database, prepared.attemptId);
    database
      .query(
        "INSERT INTO action_results " +
          "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
          "idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, " +
          "failure_reason, detail, postcondition_kind, postcondition_observed_at, " +
          "postcondition_modseq, postcondition_flags, postcondition_mailbox_id, " +
          "postcondition_uid_validity, postcondition_uid) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uncertain', 'uncertain', ?, NULL, ?, " +
          "NULL, NULL, NULL, NULL, NULL, NULL, NULL);",
      )
      .run(
        attempt.attempt.attemptId,
        attempt.attempt.planId,
        targetOrdinal,
        attempt.attempt.target.accountId,
        attempt.attempt.target.mailboxId,
        attempt.attempt.target.uidValidity,
        attempt.attempt.target.uid,
        attempt.attempt.idempotencyKey,
        attempt.attempt.startedAt,
        prepared.recoveredAt,
        result.uncertainReason,
        result.detail,
      );
    database.exec("COMMIT;");
    transactionStarted = false;
    return { kind: "uncertain", result };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

export const recordActionAttemptDispatch = markActionPlanAttemptDispatched;
export const recoverActionAttempt = recoverUnresolvedActionPlanAttempt;
export { actionAttemptDispatchMigrations };

function prepareDispatch(value: unknown): PreparedDispatch {
  const input = record(value, "action attempt dispatch input");
  exactKeys(input, ["attemptId", "dispatchedAt", "observation"]);
  const observation = record(input.observation, "dispatch observation");
  exactKeys(observation, ["kind", "target", "observed"]);
  if (observation.kind !== "satisfied") throw new TypeError("dispatch observation must be satisfied");
  const observed = record(observation.observed, "dispatch observed target");
  exactKeys(observed, ["uidValidity", "uid", "modseq"]);
  const observedTarget = record(observation.target, "dispatch observation target");
  exactKeys(observedTarget, ["accountId", "mailboxId", "uidValidity", "uid", "precondition"]);
  const observedPrecondition = record(observedTarget.precondition, "dispatch observation precondition");
  exactKeys(observedPrecondition, ["modseq"]);
  const observationAccountId = parseAccountId(observedTarget.accountId);
  const observationMailboxId = parseMailboxId(observedTarget.mailboxId);
  const observationUidValidity = createUidValidity(observedTarget.uidValidity);
  const observationUid = createRemoteUidValue(observedTarget.uid);
  const observationModseq = parseNonNegativeInteger(observedPrecondition.modseq, "dispatch target MODSEQ");
  if (
    createUidValidity(observed.uidValidity) !== observationUidValidity ||
    createRemoteUidValue(observed.uid) !== observationUid ||
    parseNonNegativeInteger(observed.modseq, "dispatch observation MODSEQ") !== observationModseq
  ) {
    throw new TypeError("dispatch observation does not match its target");
  }
  const dispatchedAt = parseUtcInstant(input.dispatchedAt);
  return {
    attemptId: parseAttemptId(input.attemptId),
    dispatchedAt,
    observationAt: dispatchedAt,
    observationAccountId,
    observationMailboxId,
    observationUidValidity,
    observationUid,
    observationModseq,
  };
}

function prepareRecovery(value: unknown): Readonly<{ readonly attemptId: string; readonly recoveredAt: string }> {
  const input = record(value, "action attempt recovery input");
  exactKeys(input, ["attemptId", "recoveredAt"]);
  return { attemptId: parseAttemptId(input.attemptId), recoveredAt: parseUtcInstant(input.recoveredAt) };
}

function readDispatchEvidence(database: Database, attemptId: string): DispatchEvidence | undefined {
  const value: unknown = database
    .query(
      "SELECT dispatched_at, observation_at, observation_uid_validity, observation_uid, observation_modseq " +
        "FROM action_attempt_dispatches WHERE attempt_id = ?;",
    )
    .get(attemptId);
  if (value === null) return undefined;
  const row = record(value, "dispatch evidence row");
  return {
    dispatchedAt: parseUtcInstant(row.dispatched_at),
    observationAt: parseUtcInstant(row.observation_at),
    observationUidValidity: createUidValidity(row.observation_uid_validity),
    observationUid: createRemoteUidValue(row.observation_uid),
    observationModseq: parseNonNegativeInteger(row.observation_modseq, "stored observation MODSEQ"),
  };
}

function readExistingResult(database: Database, attemptId: string): RemoteAttemptResult | undefined {
  const row = database.query("SELECT 1 AS present FROM action_results WHERE attempt_id = ?;").get(attemptId);
  return row === null ? undefined : readActionPlanResult(database, attemptId);
}

function readTargetOrdinal(database: Database, attemptId: string): number {
  const row = record(
    database.query("SELECT target_ordinal FROM action_attempts WHERE attempt_id = ?;").get(attemptId),
    "action attempt row",
  );
  if (typeof row.target_ordinal !== "number" || !Number.isSafeInteger(row.target_ordinal) || row.target_ordinal < 1) {
    throw new TypeError("action attempt target ordinal is invalid");
  }
  return row.target_ordinal;
}

function isActiveAttempt(database: Database, attemptId: string, claimId: string): boolean {
  return database
    .query(
      "SELECT 1 AS active FROM action_attempts AS attempt " +
        "JOIN action_plans AS plan ON plan.plan_id = attempt.plan_id " +
        "JOIN action_plan_claims AS claim ON claim.plan_id = plan.plan_id AND claim.claim_id = attempt.claim_id " +
        "WHERE attempt.attempt_id = ? AND attempt.claim_id = ? AND attempt.certainty = 'unresolved' " +
        "AND plan.state = 'executing' AND plan.claim_id = attempt.claim_id AND plan.started_at = claim.claimed_at;",
    )
    .get(attemptId, claimId) !== null;
}

function sameDispatch(left: DispatchEvidence, right: PreparedDispatch): boolean {
  return (
    left.dispatchedAt === right.dispatchedAt &&
    left.observationAt === right.observationAt &&
    left.observationUidValidity === right.observationUidValidity &&
    left.observationUid === right.observationUid &&
    left.observationModseq === right.observationModseq
  );
}

function dispatchDetail(
  attempt: Readonly<{ readonly attempt: Readonly<{ readonly action: { readonly kind: string } }> }>,
  dispatch: DispatchEvidence,
): string {
  return [
    "dispatch-crossed",
    `command=${attempt.attempt.action.kind}`,
    `dispatchedAt=${dispatch.dispatchedAt}`,
    `lastObservation=satisfied@${dispatch.observationAt}`,
    `uidValidity=${dispatch.observationUidValidity}`,
    `uid=${dispatch.observationUid}`,
    `modseq=${dispatch.observationModseq}`,
  ].join(";");
}

function requireRecoverySchema(database: Database): void {
  const tables = ["action_attempt_dispatches", "action_results"].map((name) =>
    database.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?;").get(name),
  );
  if (tables.some((table) => table === null)) {
    throw new Error("action attempt dispatch migration is required before recovery use");
  }
}

function commit<T extends ActionAttemptDispatchResult | ActionAttemptRecoveryResult>(
  database: Database,
  result: T,
): T {
  database.exec("COMMIT;");
  return result;
}

function rollback(database: Database, original: unknown): never {
  try {
    database.exec("ROLLBACK;");
  } catch (rollbackError: unknown) {
    throw new AggregateError([original, rollbackError], "action attempt recovery rollback failed");
  }
  throw original;
}

function parseAttemptId(value: unknown): string {
  const id = createRemoteAttemptId(value);
  if (!id.startsWith("attempt:")) throw new TypeError("attempt ID must use the attempt: namespace");
  return id;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("action attempt recovery input has missing or unknown fields");
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
