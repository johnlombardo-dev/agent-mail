import type { Database } from "bun:sqlite";
import {
  createActionPlanId,
  createMonotonicSequence,
  createRemoteAttemptId,
  createRemoteAttemptFailed,
  createRemoteAttemptRejected,
  createRemoteAttemptSuccess,
  createRemoteAttemptResult,
  createRemoteAttemptStale,
  createRemoteAttemptUncertain,
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  parseUtcInstant,
  type Action,
  type ActionPlanTarget,
  type RemoteAttemptResult,
  type RemoteAttemptStale,
} from "@agent-mail/core";
import { readActionPlanAttempt } from "./action-plan-attempt";

/** The read-only precondition observations accepted from the IMAP adapter. */
export type StalePreconditionObservation =
  | Readonly<{
      readonly kind: "stale";
      readonly target: ActionPlanTarget;
      readonly observed: Readonly<{
        readonly uidValidity: number;
        readonly uid: number;
        readonly modseq: number;
      }>;
      readonly reason: "newer-modseq" | "older-modseq";
    }>
  | Readonly<{
      readonly kind: "epoch_changed";
      readonly target: ActionPlanTarget;
      readonly observedUidValidity: number;
    }>;

export type ActionPlanStaleResultInput = Readonly<{
  readonly attemptId: unknown;
  readonly resultAt: unknown;
  readonly observation: unknown;
}>;

export type ActionPlanStaleResult =
  | Readonly<{
      readonly kind: "recorded";
      readonly result: RemoteAttemptStale;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly attemptId: string;
      readonly reason: "missing" | "target" | "result-exists";
    }>;

export type ActionPlanResultRepository = Readonly<{
  readonly recordStale: (input: unknown) => ActionPlanStaleResult;
  readonly recordDefinite: (input: unknown) => ActionPlanDefiniteResult;
  readonly read: (attemptId: unknown) => RemoteAttemptResult | undefined;
}>;

export type ActionPlanDefiniteResult =
  | Readonly<{
      readonly kind: "recorded";
      readonly result: Exclude<RemoteAttemptResult, { readonly certainty: "uncertain" }>;
      readonly journalId: string;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly attemptId: string;
      readonly reason:
        | "missing"
        | "inactive-claim"
        | "identity"
        | "result-exists"
        | "result-conflict";
    }>;

/** Input accepted by the one-attempt definite-result transaction. */
export type ActionPlanDefiniteResultInput = Readonly<{
  /** A normalized adapter result. The boundary still parses it as unknown. */
  readonly result: unknown;
}>;

export type ExpiredUndispatchedActionPlanResult =
  | Readonly<{
      readonly kind: "recorded";
      readonly result: Exclude<RemoteAttemptResult, { readonly certainty: "uncertain" }>;
    }>
  | Readonly<{
      readonly kind: "already-resolved";
      readonly result: RemoteAttemptResult;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly attemptId: string;
      readonly reason: "missing" | "already-dispatched" | "inactive-claim" | "result-conflict";
    }>;

/**
 * Durably classify an expired attempt that has not crossed dispatch. This is
 * intentionally a non-executing result and reuses the existing result
 * transaction, journal, and identity checks.
 */
export function recordExpiredUndispatchedActionPlanResult(
  database: Database,
  input: unknown,
): ExpiredUndispatchedActionPlanResult {
  const prepared = prepareExpiredUndispatchedResult(input);
  const attempt = readActionPlanAttempt(database, prepared.attemptId);
  if (attempt === undefined) {
    return { kind: "rejected", attemptId: prepared.attemptId, reason: "missing" };
  }
  const existing = readActionPlanResult(database, prepared.attemptId);
  if (existing !== undefined) return { kind: "already-resolved", result: existing };
  if (
    database
      .query("SELECT 1 AS present FROM action_attempt_dispatches WHERE attempt_id = ?;")
      .get(prepared.attemptId) !== null
  ) {
    return { kind: "rejected", attemptId: prepared.attemptId, reason: "already-dispatched" };
  }
  const result = createRemoteAttemptRejected({
    kind: "rejected",
    planId: attempt.attempt.planId,
    action: attempt.attempt.action,
    target: attempt.attempt.target,
    attemptId: attempt.attempt.attemptId,
    idempotencyKey: attempt.attempt.idempotencyKey,
    startedAt: attempt.attempt.startedAt,
    resultAt: prepared.resultAt,
    certainty: "definite",
    detail: "plan authority expired before remote dispatch",
  });
  const recorded = recordDefiniteActionPlanResult(database, { result });
  if (recorded.kind === "recorded") return { kind: "recorded", result: recorded.result };
  if (recorded.reason === "result-exists") {
    const current = readActionPlanResult(database, prepared.attemptId);
    if (current !== undefined) return { kind: "already-resolved", result: current };
  }
  return {
    kind: "rejected",
    attemptId: prepared.attemptId,
    reason: recorded.reason === "inactive-claim" ? "inactive-claim" : "result-conflict",
  };
}

const DETAIL_VERSION = 1;
const MAX_DETAIL_LENGTH = 512;

/**
 * Record a read-only stale precondition as a definite no-effect result.
 *
 * Parsing occurs before the write transaction. The transaction then locks and
 * rechecks the exact unresolved attempt identity before inserting one result.
 * No remote capability is available to this repository.
 */
export function recordStaleActionPlanResult(
  database: Database,
  input: unknown,
): ActionPlanStaleResult {
  const prepared = prepareInput(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    requireResultSchema(database);

    const attempt = readAttempt(database, prepared.attemptId);
    if (attempt === undefined)
      return commitResult(database, {
        kind: "rejected",
        attemptId: prepared.attemptId,
        reason: "missing",
      });
    if (!matchesTarget(attempt.target, prepared.observation.target)) {
      return commitResult(database, {
        kind: "rejected",
        attemptId: prepared.attemptId,
        reason: "target",
      });
    }
    if (hasResult(database, prepared.attemptId)) {
      return commitResult(database, {
        kind: "rejected",
        attemptId: prepared.attemptId,
        reason: "result-exists",
      });
    }

    const detail = serializeStalePreconditionObservation(prepared.observation);
    const result = createRemoteAttemptStale({
      kind: "stale",
      planId: attempt.planId,
      action: attempt.action,
      target: attempt.target,
      attemptId: attempt.attemptId,
      idempotencyKey: attempt.idempotencyKey,
      startedAt: attempt.startedAt,
      resultAt: prepared.resultAt,
      certainty: "definite",
      detail,
    });

    database
      .query(
        "INSERT INTO action_results " +
          "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
          "idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, " +
          "failure_reason, detail, postcondition_kind, postcondition_observed_at, " +
          "postcondition_modseq, postcondition_flags, postcondition_mailbox_id, " +
          "postcondition_uid_validity, postcondition_uid) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stale', 'definite', NULL, NULL, ?, " +
          "NULL, NULL, NULL, NULL, NULL, NULL, NULL);",
      )
      .run(
        attempt.attemptId,
        attempt.planId,
        attempt.targetOrdinal,
        attempt.target.accountId,
        attempt.target.mailboxId,
        attempt.target.uidValidity,
        attempt.target.uid,
        attempt.idempotencyKey,
        attempt.startedAt,
        prepared.resultAt,
        detail,
      );

    database.exec("COMMIT;");
    transactionStarted = false;
    return { kind: "recorded", result };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

/**
 * Persist one normalized definite adapter outcome and its audit event as one
 * SQLite transaction. The remote adapter result is parsed before the write
 * lock; the attempt and active claim are rechecked under that lock.
 */
export function recordDefiniteActionPlanResult(
  database: Database,
  input: unknown,
): ActionPlanDefiniteResult {
  const result = parseDefiniteResultInput(input);
  const attemptId = result.attemptId;
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    requireResultSchema(database, true);

    const attempt = readAttempt(database, attemptId);
    if (attempt === undefined)
      return commitDefiniteResult(database, {
        kind: "rejected",
        attemptId,
        reason: "missing",
      });
    if (!isActiveUnresolvedAttempt(database, attempt))
      return commitDefiniteResult(database, {
        kind: "rejected",
        attemptId,
        reason: "inactive-claim",
      });
    if (!matchesAttemptIdentity(attempt, result))
      return commitDefiniteResult(database, {
        kind: "rejected",
        attemptId,
        reason: "identity",
      });

    const existing = readActionPlanResult(database, attemptId);
    if (existing !== undefined) {
      if (existing.certainty !== "definite") {
        return commitDefiniteResult(database, {
          kind: "rejected",
          attemptId,
          reason: "result-exists",
        });
      }
      if (sameResult(existing, result)) {
        const journalId = actionResultJournalId(attemptId);
        ensureJournalEvent(database, journalId);
        return commitDefiniteResult(database, { kind: "recorded", result: existing, journalId });
      }
      return commitDefiniteResult(database, {
        kind: "rejected",
        attemptId,
        reason: "result-conflict",
      });
    }
    if (hasResult(database, attemptId))
      return commitDefiniteResult(database, {
        kind: "rejected",
        attemptId,
        reason: "result-exists",
      });

    insertStoredResult(database, attempt, result);
    const journalId = actionResultJournalId(attemptId);
    insertActionResultJournal(database, journalId, result);
    database.exec("COMMIT;");
    transactionStarted = false;
    return { kind: "recorded", result, journalId };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

/** Reopen the exact durable result for one attempt after a restart. */
export function readActionPlanResult(
  database: Database,
  attemptId: unknown,
): RemoteAttemptResult | undefined {
  const id = parseAttemptId(attemptId);
  requireResultSchema(database);
  const value: unknown = database
    .query(
      "SELECT attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
        "idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, " +
        "failure_reason, detail, postcondition_kind, postcondition_observed_at, postcondition_modseq, " +
        "postcondition_flags, postcondition_mailbox_id, postcondition_uid_validity, postcondition_uid " +
        "FROM action_results WHERE attempt_id = ?;",
    )
    .get(id);
  if (value === null) return undefined;
  const row = record(value, "action result row");
  const actionAttempt = readAttempt(database, id);
  if (actionAttempt === undefined) throw new Error("action result references a missing attempt");
  if (
    row.attempt_id !== actionAttempt.attemptId ||
    row.plan_id !== actionAttempt.planId ||
    row.account_id !== actionAttempt.target.accountId ||
    row.mailbox_id !== actionAttempt.target.mailboxId ||
    row.uid_validity !== actionAttempt.target.uidValidity ||
    row.uid !== actionAttempt.target.uid ||
    row.idempotency_key !== actionAttempt.idempotencyKey ||
    row.started_at !== actionAttempt.startedAt
  ) {
    throw new TypeError("action result identity does not match its attempt");
  }
  return decodeStoredResult(row, actionAttempt);
}

export function createActionPlanResultRepository(database: Database): ActionPlanResultRepository {
  return {
    recordStale: (input) => recordStaleActionPlanResult(database, input),
    recordDefinite: (input) => recordDefiniteActionPlanResult(database, input),
    read: (attemptId) => readActionPlanResult(database, attemptId),
  };
}

/** Compatibility names for the transaction boundary. */
export const finalizeStaleActionPlanAttempt = recordStaleActionPlanResult;
export const recordStaleActionPlanAttempt = recordStaleActionPlanResult;
/** Compatibility dispatcher for the original stale-only repository surface. */
export function recordActionPlanAttemptResult(
  database: Database,
  input: unknown,
): ActionPlanDefiniteResult | ActionPlanStaleResult {
  const value = record(input, "action plan result input");
  return Object.prototype.hasOwnProperty.call(value, "observation")
    ? recordStaleActionPlanResult(database, input)
    : recordDefiniteActionPlanResult(database, input);
}
export const finalizeActionPlanAttemptResult = recordDefiniteActionPlanResult;
export const recordActionPlanResult = recordDefiniteActionPlanResult;
export const finalizeDefiniteActionPlanResult = recordDefiniteActionPlanResult;
export const finalizeStaleActionAttempt = recordStaleActionPlanResult;
export const reopenActionPlanResult = readActionPlanResult;
export const readActionPlanAttemptResult = readActionPlanResult;

export type ActionPlanReconciliationResult =
  | Readonly<{
      readonly kind: "recorded";
      readonly result: RemoteAttemptResult;
      readonly journalId: string;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly attemptId: string;
      readonly reason:
        | "missing"
        | "inactive-claim"
        | "identity"
        | "not-dispatched"
        | "result-conflict"
        | "migration";
    }>;

/**
 * Atomically persist one read-only reconciliation result and its journal
 * event. A durable uncertain marker from P5-C13 may transition once to a
 * definite read-only result; no remote capability is available here.
 */
export function recordActionPlanReconciliationResult(
  database: Database,
  input: unknown,
): ActionPlanReconciliationResult {
  const result = parseReconciliationResultInput(input);
  const attemptId = result.attemptId;
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    requireResultSchema(database, true);
    requireReconciliationSchema(database);

    const attempt = readAttempt(database, attemptId);
    if (attempt === undefined) {
      return commitReconciliationResult(database, {
        kind: "rejected",
        attemptId,
        reason: "missing",
      });
    }
    if (!isActiveUnresolvedAttempt(database, attempt)) {
      return commitReconciliationResult(database, {
        kind: "rejected",
        attemptId,
        reason: "inactive-claim",
      });
    }
    if (!matchesAttemptIdentity(attempt, result)) {
      return commitReconciliationResult(database, {
        kind: "rejected",
        attemptId,
        reason: "identity",
      });
    }
    if (
      database
        .query("SELECT 1 AS present FROM action_attempt_dispatches WHERE attempt_id = ?;")
        .get(attemptId) === null
    ) {
      return commitReconciliationResult(database, {
        kind: "rejected",
        attemptId,
        reason: "not-dispatched",
      });
    }

    const existing = readActionPlanResult(database, attemptId);
    if (existing !== undefined) {
      if (sameResult(existing, result)) {
        const journalId = actionResultJournalId(attemptId);
        insertReconciliationJournal(database, journalId, existing);
        return commitReconciliationResult(database, {
          kind: "recorded",
          result: existing,
          journalId,
        });
      }
      if (existing.certainty !== "uncertain" || result.certainty !== "definite") {
        return commitReconciliationResult(database, {
          kind: "rejected",
          attemptId,
          reason: "result-conflict",
        });
      }
      updateStoredReconciliationResult(database, attempt, result);
    } else {
      insertStoredReconciliationResult(database, attempt, result);
    }
    const journalId = actionResultJournalId(attemptId);
    insertReconciliationJournal(database, journalId, result);
    database.exec("COMMIT;");
    transactionStarted = false;
    return { kind: "recorded", result, journalId };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

export const recordUncertainReconciliationResult = recordActionPlanReconciliationResult;
export const recordReconciledActionPlanResult = recordActionPlanReconciliationResult;
export const reconcileActionPlanAttemptResult = recordActionPlanReconciliationResult;

/** Exported for focused migration composition without broad registry changes. */
export {
  actionResultReconciliationMigration,
  actionResultReconciliationMigrations,
} from "./migrations/0007-action-result-reconciliation";

/** Stable, bounded JSON retained as the stale result's operator detail. */
export function serializeStalePreconditionObservation(observation: unknown): string {
  const parsed = parseObservation(observation);
  const target = parsed.target;
  const detail =
    parsed.kind === "stale"
      ? JSON.stringify({
          version: DETAIL_VERSION,
          kind: parsed.kind,
          reason: parsed.reason,
          uidValidity: target.uidValidity,
          uid: target.uid,
          preconditionModseq: target.precondition.modseq,
          observedUidValidity: parsed.observed.uidValidity,
          observedUid: parsed.observed.uid,
          observedModseq: parsed.observed.modseq,
        })
      : JSON.stringify({
          version: DETAIL_VERSION,
          kind: parsed.kind,
          uidValidity: target.uidValidity,
          uid: target.uid,
          preconditionModseq: target.precondition.modseq,
          observedUidValidity: parsed.observedUidValidity,
        });
  if (detail.length > MAX_DETAIL_LENGTH)
    throw new TypeError("stale observation detail is too large");
  return detail;
}

type PreparedInput = Readonly<{
  readonly attemptId: string;
  readonly resultAt: string;
  readonly observation: StalePreconditionObservation;
}>;

type PreparedExpiredUndispatchedResult = Readonly<{
  readonly attemptId: string;
  readonly resultAt: string;
}>;

function prepareExpiredUndispatchedResult(value: unknown): PreparedExpiredUndispatchedResult {
  const input = record(value, "expired undispatched action result input");
  exactKeys(input, ["attemptId", "resultAt"]);
  return {
    attemptId: parseAttemptId(input.attemptId),
    resultAt: parseUtcInstant(input.resultAt),
  };
}

type AttemptRow = Readonly<{
  readonly attemptId: ReturnType<typeof createRemoteAttemptId>;
  readonly planId: ReturnType<typeof createActionPlanId>;
  readonly targetOrdinal: number;
  readonly target: ActionPlanTarget;
  readonly action: Action;
  readonly idempotencyKey: string;
  readonly startedAt: string;
  readonly claimId: string;
}>;

type DefiniteResult = Exclude<RemoteAttemptResult, { readonly certainty: "uncertain" }>;

function prepareInput(value: unknown): PreparedInput {
  const input = record(value, "stale action result input");
  exactKeys(input, ["attemptId", "resultAt", "observation"]);
  const resultAt = parseUtcInstant(input.resultAt);
  return {
    attemptId: parseAttemptId(input.attemptId),
    resultAt,
    observation: parseObservation(input.observation),
  };
}

function parseObservation(value: unknown): StalePreconditionObservation {
  const input = record(value, "stale precondition observation");
  if (input.kind === "stale") {
    exactKeys(input, ["kind", "target", "observed", "reason"]);
    if (input.reason !== "newer-modseq" && input.reason !== "older-modseq") {
      throw new TypeError("stale observation reason is invalid");
    }
    const target = parseTarget(input.target);
    const observed = parseObserved(input.observed);
    if (observed.uidValidity !== target.uidValidity || observed.uid !== target.uid) {
      throw new TypeError("stale observation identity does not match its target");
    }
    const expectedComparison =
      input.reason === "newer-modseq"
        ? observed.modseq > target.precondition.modseq
        : observed.modseq < target.precondition.modseq;
    if (!expectedComparison) throw new TypeError("stale observation reason does not match MODSEQ");
    return { kind: "stale", target, observed, reason: input.reason };
  }
  if (input.kind === "epoch_changed") {
    exactKeys(input, ["kind", "target", "observedUidValidity"]);
    const target = parseTarget(input.target);
    const observedUidValidity = createUidValidity(input.observedUidValidity);
    if (observedUidValidity === target.uidValidity) {
      throw new TypeError("epoch-changed observation has the stored UIDVALIDITY");
    }
    return { kind: "epoch_changed", target, observedUidValidity };
  }
  throw new TypeError("observation must be stale or epoch_changed");
}

function parseTarget(value: unknown): ActionPlanTarget {
  const input = record(value, "stale observation target");
  exactKeys(input, ["accountId", "mailboxId", "uidValidity", "uid", "precondition"]);
  const preconditionValue = input.precondition;
  const precondition = record(preconditionValue, "stale observation precondition");
  exactKeys(precondition, ["modseq"]);
  return {
    accountId: parseAccountId(input.accountId),
    mailboxId: parseMailboxId(input.mailboxId),
    uidValidity: createUidValidity(input.uidValidity),
    uid: createRemoteUidValue(input.uid),
    precondition: { modseq: createMonotonicSequence(precondition.modseq) },
  };
}

function parseObserved(value: unknown): { uidValidity: number; uid: number; modseq: number } {
  const input = record(value, "stale observation observed value");
  exactKeys(input, ["uidValidity", "uid", "modseq"]);
  return {
    uidValidity: createUidValidity(input.uidValidity),
    uid: createRemoteUidValue(input.uid),
    modseq: createMonotonicSequence(input.modseq),
  };
}

function readAttempt(database: Database, attemptId: string): AttemptRow | undefined {
  const value: unknown = database
    .query(
      "SELECT attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
        "idempotency_key, started_at, action_kind, precondition_modseq, claim_id " +
        "FROM action_attempts WHERE attempt_id = ?;",
    )
    .get(attemptId);
  if (value === null) return undefined;
  const row = record(value, "action attempt row");
  return {
    attemptId: createRemoteAttemptId(row.attempt_id),
    planId: createActionPlanId(row.plan_id),
    targetOrdinal: requireOrdinal(row.target_ordinal),
    target: {
      accountId: parseAccountId(row.account_id),
      mailboxId: parseMailboxId(row.mailbox_id),
      uidValidity: createUidValidity(row.uid_validity),
      uid: createRemoteUidValue(row.uid),
      precondition: { modseq: createMonotonicSequence(row.precondition_modseq) },
    },
    action: parseAction(row.action_kind),
    idempotencyKey: requireText(row.idempotency_key),
    startedAt: parseUtcInstant(row.started_at),
    claimId: requireNamespacedText(row.claim_id, "claim ID", "claim:"),
  };
}

function parseDefiniteResultInput(value: unknown): DefiniteResult {
  const input = record(value, "definite action result input");
  const rawResult = Object.prototype.hasOwnProperty.call(input, "result")
    ? (() => {
        exactKeys(input, ["result"]);
        return input.result;
      })()
    : value;
  const result = createRemoteAttemptResult(rawResult);
  if (result.certainty !== "definite") {
    throw new TypeError("uncertain transport outcomes cannot be finalized as definite");
  }
  return result;
}

function matchesAttemptIdentity(attempt: AttemptRow, result: RemoteAttemptResult): boolean {
  return (
    result.attemptId === attempt.attemptId &&
    result.planId === attempt.planId &&
    result.action.kind === attempt.action.kind &&
    result.target.accountId === attempt.target.accountId &&
    result.target.mailboxId === attempt.target.mailboxId &&
    result.target.uidValidity === attempt.target.uidValidity &&
    result.target.uid === attempt.target.uid &&
    result.target.precondition.modseq === attempt.target.precondition.modseq &&
    result.idempotencyKey === attempt.idempotencyKey &&
    result.startedAt === attempt.startedAt
  );
}

function isActiveUnresolvedAttempt(database: Database, attempt: AttemptRow): boolean {
  const row: unknown = database
    .query(
      "SELECT 1 AS active " +
        "FROM action_attempts AS attempt " +
        "JOIN action_plans AS plan ON plan.plan_id = attempt.plan_id " +
        "JOIN action_plan_claims AS claim ON claim.plan_id = attempt.plan_id AND claim.claim_id = attempt.claim_id " +
        "WHERE attempt.attempt_id = ? AND attempt.certainty = 'unresolved' " +
        "AND plan.state = 'executing' AND plan.claim_id = attempt.claim_id " +
        "AND plan.started_at = claim.claimed_at;",
    )
    .get(attempt.attemptId);
  return row !== null;
}

function insertStoredResult(database: Database, attempt: AttemptRow, result: DefiniteResult): void {
  const stored = storedResultFields(result);
  database
    .query(
      "INSERT INTO action_results " +
        "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
        "idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, " +
        "failure_reason, detail, postcondition_kind, postcondition_observed_at, " +
        "postcondition_modseq, postcondition_flags, postcondition_mailbox_id, " +
        "postcondition_uid_validity, postcondition_uid) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'definite', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      attempt.attemptId,
      attempt.planId,
      attempt.targetOrdinal,
      attempt.target.accountId,
      attempt.target.mailboxId,
      attempt.target.uidValidity,
      attempt.target.uid,
      attempt.idempotencyKey,
      attempt.startedAt,
      result.resultAt,
      stored.resultKind,
      stored.failureReason,
      stored.detail,
      stored.postconditionKind,
      stored.postconditionObservedAt,
      stored.postconditionModseq,
      stored.postconditionFlags,
      stored.postconditionMailboxId,
      stored.postconditionUidValidity,
      stored.postconditionUid,
    );
}

type StoredResultFields = Readonly<{
  readonly resultKind: DefiniteResult["kind"];
  readonly failureReason: string | null;
  readonly detail: string | null;
  readonly postconditionKind: "flags" | "mailbox" | null;
  readonly postconditionObservedAt: string | null;
  readonly postconditionModseq: number | null;
  readonly postconditionFlags: string | null;
  readonly postconditionMailboxId: string | null;
  readonly postconditionUidValidity: number | null;
  readonly postconditionUid: number | null;
}>;

function storedResultFields(result: DefiniteResult): StoredResultFields {
  switch (result.kind) {
    case "success":
      return result.postcondition.kind === "flags"
        ? {
            resultKind: result.kind,
            failureReason: null,
            detail: null,
            postconditionKind: "flags",
            postconditionObservedAt: result.postcondition.observedAt,
            postconditionModseq: result.postcondition.modseq,
            postconditionFlags: JSON.stringify(result.postcondition.flags),
            postconditionMailboxId: null,
            postconditionUidValidity: null,
            postconditionUid: null,
          }
        : {
            resultKind: result.kind,
            failureReason: null,
            detail: null,
            postconditionKind: "mailbox",
            postconditionObservedAt: result.postcondition.observedAt,
            postconditionModseq: result.postcondition.modseq,
            postconditionFlags: null,
            postconditionMailboxId: result.postcondition.mailboxId,
            postconditionUidValidity: result.postcondition.uidValidity,
            postconditionUid: result.postcondition.uid,
          };
    case "stale":
    case "rejected":
      return {
        resultKind: result.kind,
        failureReason: null,
        detail: result.detail,
        postconditionKind: null,
        postconditionObservedAt: null,
        postconditionModseq: null,
        postconditionFlags: null,
        postconditionMailboxId: null,
        postconditionUidValidity: null,
        postconditionUid: null,
      };
    case "failed":
      return {
        resultKind: result.kind,
        failureReason: result.failureReason,
        detail: result.detail,
        postconditionKind: null,
        postconditionObservedAt: null,
        postconditionModseq: null,
        postconditionFlags: null,
        postconditionMailboxId: null,
        postconditionUidValidity: null,
        postconditionUid: null,
      };
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function insertActionResultJournal(
  database: Database,
  journalId: string,
  result: DefiniteResult,
): void {
  const payloadJson = serializeActionResultJournalPayload(result);
  database
    .query(
      "INSERT INTO operational_journal " +
        "(id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
        "VALUES (?, ?, 'action', ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING;",
    )
    .run(journalId, result.resultAt, result.attemptId, result.planId, payloadJson);
  const row: unknown = database
    .query(
      "SELECT occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE id = ?;",
    )
    .get(journalId);
  const stored = record(row, "action result journal row");
  if (
    stored.occurred_at !== result.resultAt ||
    stored.category !== "action" ||
    stored.subject_id !== result.attemptId ||
    stored.correlation_id !== result.planId ||
    stored.payload_version !== 1 ||
    stored.payload_json !== payloadJson
  ) {
    throw new TypeError("action result journal identity conflicts with the result");
  }
}

function ensureJournalEvent(database: Database, journalId: string): void {
  const row: unknown = database
    .query("SELECT 1 AS present FROM operational_journal WHERE id = ?;")
    .get(journalId);
  if (row === null) throw new Error("action result journal event is missing");
}

function serializeActionResultJournalPayload(result: DefiniteResult): string {
  const base = {
    version: 1,
    kind: result.kind,
    attemptId: result.attemptId,
    planId: result.planId,
    action: result.action.kind,
    resultAt: result.resultAt,
  };
  switch (result.kind) {
    case "success":
      return JSON.stringify({ ...base, postcondition: result.postcondition });
    case "stale":
    case "rejected":
      return JSON.stringify({ ...base, detail: result.detail });
    case "failed":
      return JSON.stringify({
        ...base,
        failureReason: result.failureReason,
        detail: result.detail,
      });
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function actionResultJournalId(attemptId: string): string {
  return `event:action-result:${attemptId}`;
}

function sameResult(left: RemoteAttemptResult, right: RemoteAttemptResult): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decodeStoredResult(
  row: Readonly<Record<string, unknown>>,
  attempt: AttemptRow,
): RemoteAttemptResult {
  const base = {
    planId: row.plan_id,
    action: attempt.action,
    target: attempt.target,
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    startedAt: row.started_at,
    resultAt: row.result_at,
  };
  switch (row.result_kind) {
    case "success": {
      if (row.certainty !== "definite")
        throw new TypeError("stored success result is not definite");
      const postcondition = decodeStoredPostcondition(row);
      return createRemoteAttemptSuccess({
        ...base,
        kind: "success",
        certainty: "definite",
        postcondition,
      });
    }
    case "stale":
      if (row.certainty !== "definite") throw new TypeError("stored stale result is not definite");
      return createRemoteAttemptStale({
        ...base,
        kind: "stale",
        certainty: "definite",
        detail: requireText(row.detail),
      });
    case "rejected":
      if (row.certainty !== "definite")
        throw new TypeError("stored rejected result is not definite");
      return createRemoteAttemptRejected({
        ...base,
        kind: "rejected",
        certainty: "definite",
        detail: requireText(row.detail),
      });
    case "failed":
      if (row.certainty !== "definite") throw new TypeError("stored failed result is not definite");
      return createRemoteAttemptFailed({
        ...base,
        kind: "failed",
        certainty: "definite",
        failureReason: row.failure_reason,
        detail: requireText(row.detail),
      });
    case "uncertain":
      if (row.certainty !== "uncertain")
        throw new TypeError("stored uncertain result has invalid certainty");
      return createRemoteAttemptUncertain({
        ...base,
        kind: "uncertain",
        certainty: "uncertain",
        uncertainReason: row.uncertain_reason,
        detail: requireText(row.detail),
      });
    default:
      throw new TypeError("stored action result kind is invalid");
  }
}

function decodeStoredPostcondition(
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (row.postcondition_kind === "flags") {
    return {
      kind: "flags",
      observedAt: row.postcondition_observed_at,
      flags: parseFlagsJson(row.postcondition_flags),
      modseq: row.postcondition_modseq,
    };
  }
  if (row.postcondition_kind === "mailbox") {
    return {
      kind: "mailbox",
      observedAt: row.postcondition_observed_at,
      mailboxId: row.postcondition_mailbox_id,
      uidValidity: row.postcondition_uid_validity,
      uid: row.postcondition_uid,
      modseq: row.postcondition_modseq,
    };
  }
  throw new TypeError("stored success result has no postcondition kind");
}

function parseFlagsJson(value: unknown): readonly string[] {
  if (typeof value !== "string") throw new TypeError("stored flags postcondition is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new TypeError("stored flags postcondition is invalid", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((flag) => typeof flag !== "string")) {
    throw new TypeError("stored flags postcondition is invalid");
  }
  return parsed;
}

function commitDefiniteResult(
  database: Database,
  result: ActionPlanDefiniteResult,
): ActionPlanDefiniteResult {
  database.exec("COMMIT;");
  return result;
}

function matchesTarget(left: ActionPlanTarget, right: ActionPlanTarget): boolean {
  return (
    left.accountId === right.accountId &&
    left.mailboxId === right.mailboxId &&
    left.uidValidity === right.uidValidity &&
    left.uid === right.uid &&
    left.precondition.modseq === right.precondition.modseq
  );
}

function hasResult(database: Database, attemptId: string): boolean {
  return (
    database
      .query("SELECT 1 AS present FROM action_results WHERE attempt_id = ?;")
      .get(attemptId) !== null
  );
}

function requireResultSchema(database: Database, requiresJournal = false): void {
  const resultColumns: readonly unknown[] = database
    .query("PRAGMA table_info(action_results);")
    .all();
  const attemptColumns: readonly unknown[] = database
    .query("PRAGMA table_info(action_attempts);")
    .all();
  const requiredResult = new Set(["attempt_id", "result_kind", "certainty", "detail"]);
  const requiredAttempt = new Set(["claim_id", "action_kind", "precondition_modseq"]);
  const journalColumns: readonly unknown[] = requiresJournal
    ? database.query("PRAGMA table_info(operational_journal);").all()
    : [];
  const names = (columns: readonly unknown[]): ReadonlySet<string> =>
    new Set(
      columns.flatMap((value) => {
        if (typeof value !== "object" || value === null || !("name" in value)) return [];
        return typeof value.name === "string" ? [value.name] : [];
      }),
    );
  if (
    resultColumns.length === 0 ||
    attemptColumns.length === 0 ||
    [...requiredResult].some((column) => !names(resultColumns).has(column)) ||
    [...requiredAttempt].some((column) => !names(attemptColumns).has(column)) ||
    (requiresJournal &&
      (journalColumns.length === 0 ||
        [
          "id",
          "occurred_at",
          "category",
          "subject_id",
          "correlation_id",
          "payload_version",
          "payload_json",
        ].some((column) => !names(journalColumns).has(column))))
  ) {
    throw new Error("action result migration is required before result use");
  }
}

function commitResult(database: Database, result: ActionPlanStaleResult): ActionPlanStaleResult {
  database.exec("COMMIT;");
  return result;
}

function rollback(database: Database, original: unknown): never {
  try {
    database.exec("ROLLBACK;");
  } catch (rollbackError: unknown) {
    throw new AggregateError([original, rollbackError], "action result rollback failed");
  }
  throw original;
}

function parseAttemptId(value: unknown): string {
  const id = createRemoteAttemptId(value);
  if (!id.startsWith("attempt:")) throw new TypeError("attempt ID must use the attempt: namespace");
  return id;
}

function parseAction(value: unknown): Action {
  if (
    value !== "markSeen" &&
    value !== "markUnseen" &&
    value !== "moveToArchive" &&
    value !== "moveToTrash"
  )
    throw new TypeError("action kind is invalid");
  return { kind: value };
}

function requireOrdinal(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("action target ordinal is invalid");
  }
  return value;
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("action result text is invalid");
  }
  return value;
}

function requireNamespacedText(value: unknown, label: string, prefix: string): string {
  const text = requireText(value);
  if (!text.startsWith(prefix)) throw new TypeError(`${label} is invalid`);
  return text;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !expected.has(key))) {
    throw new TypeError("stale action result input has missing or unknown fields");
  }
}

function parseReconciliationResultInput(value: unknown): RemoteAttemptResult {
  const input = record(value, "reconciliation action result input");
  exactKeys(input, ["result"]);
  const result = createRemoteAttemptResult(input.result);
  if (result.kind === "failed") {
    throw new TypeError(
      "uncertain reconciliation must classify applied, not-applied, stale, or still-uncertain",
    );
  }
  return result;
}

type StoredReconciliationFields = Readonly<{
  readonly resultKind: RemoteAttemptResult["kind"];
  readonly certainty: RemoteAttemptResult["certainty"];
  readonly uncertainReason: string | null;
  readonly failureReason: string | null;
  readonly detail: string | null;
  readonly postconditionKind: "flags" | "mailbox" | null;
  readonly postconditionObservedAt: string | null;
  readonly postconditionModseq: number | null;
  readonly postconditionFlags: string | null;
  readonly postconditionMailboxId: string | null;
  readonly postconditionUidValidity: number | null;
  readonly postconditionUid: number | null;
}>;

function storedReconciliationFields(result: RemoteAttemptResult): StoredReconciliationFields {
  if (result.kind === "uncertain") {
    return {
      resultKind: result.kind,
      certainty: result.certainty,
      uncertainReason: result.uncertainReason,
      failureReason: null,
      detail: result.detail,
      postconditionKind: null,
      postconditionObservedAt: null,
      postconditionModseq: null,
      postconditionFlags: null,
      postconditionMailboxId: null,
      postconditionUidValidity: null,
      postconditionUid: null,
    };
  }
  const fields = storedResultFields(result);
  return {
    resultKind: fields.resultKind,
    certainty: "definite",
    uncertainReason: null,
    failureReason: fields.failureReason,
    detail: fields.detail,
    postconditionKind: fields.postconditionKind,
    postconditionObservedAt: fields.postconditionObservedAt,
    postconditionModseq: fields.postconditionModseq,
    postconditionFlags: fields.postconditionFlags,
    postconditionMailboxId: fields.postconditionMailboxId,
    postconditionUidValidity: fields.postconditionUidValidity,
    postconditionUid: fields.postconditionUid,
  };
}

function insertStoredReconciliationResult(
  database: Database,
  attempt: AttemptRow,
  result: RemoteAttemptResult,
): void {
  const fields = storedReconciliationFields(result);
  database
    .query(
      "INSERT INTO action_results " +
        "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
        "idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, " +
        "failure_reason, detail, postcondition_kind, postcondition_observed_at, " +
        "postcondition_modseq, postcondition_flags, postcondition_mailbox_id, " +
        "postcondition_uid_validity, postcondition_uid) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      attempt.attemptId,
      attempt.planId,
      attempt.targetOrdinal,
      attempt.target.accountId,
      attempt.target.mailboxId,
      attempt.target.uidValidity,
      attempt.target.uid,
      attempt.idempotencyKey,
      attempt.startedAt,
      result.resultAt,
      fields.resultKind,
      fields.certainty,
      fields.uncertainReason,
      fields.failureReason,
      fields.detail,
      fields.postconditionKind,
      fields.postconditionObservedAt,
      fields.postconditionModseq,
      fields.postconditionFlags,
      fields.postconditionMailboxId,
      fields.postconditionUidValidity,
      fields.postconditionUid,
    );
}

function updateStoredReconciliationResult(
  database: Database,
  attempt: AttemptRow,
  result: Exclude<RemoteAttemptResult, { readonly certainty: "uncertain" }>,
): void {
  const fields = storedReconciliationFields(result);
  database
    .query(
      "UPDATE action_results SET result_at = ?, result_kind = ?, certainty = ?, uncertain_reason = ?, " +
        "failure_reason = ?, detail = ?, postcondition_kind = ?, postcondition_observed_at = ?, " +
        "postcondition_modseq = ?, postcondition_flags = ?, postcondition_mailbox_id = ?, " +
        "postcondition_uid_validity = ?, postcondition_uid = ? WHERE attempt_id = ?;",
    )
    .run(
      result.resultAt,
      fields.resultKind,
      fields.certainty,
      fields.uncertainReason,
      fields.failureReason,
      fields.detail,
      fields.postconditionKind,
      fields.postconditionObservedAt,
      fields.postconditionModseq,
      fields.postconditionFlags,
      fields.postconditionMailboxId,
      fields.postconditionUidValidity,
      fields.postconditionUid,
      attempt.attemptId,
    );
}

function insertReconciliationJournal(
  database: Database,
  journalId: string,
  result: RemoteAttemptResult,
): void {
  const payloadJson = serializeReconciliationJournalPayload(result);
  database
    .query(
      "INSERT INTO operational_journal " +
        "(id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
        "VALUES (?, ?, 'action', ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING;",
    )
    .run(journalId, result.resultAt, result.attemptId, result.planId, payloadJson);
  const row: unknown = database
    .query(
      "SELECT occurred_at, category, subject_id, correlation_id, payload_version, payload_json " +
        "FROM operational_journal WHERE id = ?;",
    )
    .get(journalId);
  const stored = record(row, "reconciliation action journal row");
  if (
    stored.occurred_at !== result.resultAt ||
    stored.category !== "action" ||
    stored.subject_id !== result.attemptId ||
    stored.correlation_id !== result.planId ||
    stored.payload_version !== 1 ||
    stored.payload_json !== payloadJson
  ) {
    throw new TypeError("reconciliation action journal identity conflicts with the result");
  }
}

function serializeReconciliationJournalPayload(result: RemoteAttemptResult): string {
  const base = {
    version: 1,
    kind: result.kind,
    attemptId: result.attemptId,
    planId: result.planId,
    action: result.action.kind,
    resultAt: result.resultAt,
  };
  switch (result.kind) {
    case "success":
      return JSON.stringify({ ...base, postcondition: result.postcondition });
    case "stale":
    case "rejected":
      return JSON.stringify({ ...base, detail: result.detail });
    case "failed":
      return JSON.stringify({
        ...base,
        failureReason: result.failureReason,
        detail: result.detail,
      });
    case "uncertain":
      return JSON.stringify({
        ...base,
        uncertainReason: result.uncertainReason,
        detail: result.detail,
      });
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function requireReconciliationSchema(database: Database): void {
  const dispatchTable = database
    .query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'action_attempt_dispatches';",
    )
    .get();
  if (dispatchTable === null) {
    throw new Error("action attempt dispatch migration is required before reconciliation use");
  }
  const row: unknown = database
    .query(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'action_result_immutable';",
    )
    .get();
  const sql = record(row, "action result reconciliation migration row").sql;
  if (typeof sql !== "string" || !sql.includes("OLD.result_kind = 'uncertain'")) {
    throw new Error("action result reconciliation migration is required before reconciliation use");
  }
}

function commitReconciliationResult(
  database: Database,
  result: ActionPlanReconciliationResult,
): ActionPlanReconciliationResult {
  database.exec("COMMIT;");
  return result;
}
