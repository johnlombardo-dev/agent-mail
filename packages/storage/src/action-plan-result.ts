import type { Database } from "bun:sqlite";
import {
  createActionPlanId,
  createMonotonicSequence,
  createRemoteAttemptId,
  createRemoteAttemptResult,
  createRemoteAttemptStale,
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
  readonly read: (attemptId: unknown) => RemoteAttemptResult | undefined;
}>;

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
  if (row.result_kind !== "stale" || row.certainty !== "definite") {
    throw new TypeError("stored action result is not a definite stale result");
  }
  return createRemoteAttemptResult({
    kind: "stale",
    planId: row.plan_id,
    action: actionAttempt.action,
    target: actionAttempt.target,
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    startedAt: row.started_at,
    resultAt: row.result_at,
    certainty: "definite",
    detail: row.detail,
  });
}

export function createActionPlanResultRepository(database: Database): ActionPlanResultRepository {
  return {
    recordStale: (input) => recordStaleActionPlanResult(database, input),
    read: (attemptId) => readActionPlanResult(database, attemptId),
  };
}

/** Compatibility names for the transaction boundary. */
export const finalizeStaleActionPlanAttempt = recordStaleActionPlanResult;
export const recordStaleActionPlanAttempt = recordStaleActionPlanResult;
export const recordActionPlanAttemptResult = recordStaleActionPlanResult;
export const finalizeStaleActionAttempt = recordStaleActionPlanResult;
export const reopenActionPlanResult = readActionPlanResult;
export const readActionPlanAttemptResult = readActionPlanResult;

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

type AttemptRow = Readonly<{
  readonly attemptId: ReturnType<typeof createRemoteAttemptId>;
  readonly planId: ReturnType<typeof createActionPlanId>;
  readonly targetOrdinal: number;
  readonly target: ActionPlanTarget;
  readonly action: Action;
  readonly idempotencyKey: string;
  readonly startedAt: string;
}>;

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
        "idempotency_key, started_at, action_kind, precondition_modseq FROM action_attempts WHERE attempt_id = ?;",
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
  };
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

function requireResultSchema(database: Database): void {
  const resultColumns: readonly unknown[] = database
    .query("PRAGMA table_info(action_results);")
    .all();
  const attemptColumns: readonly unknown[] = database
    .query("PRAGMA table_info(action_attempts);")
    .all();
  const requiredResult = new Set(["attempt_id", "result_kind", "certainty", "detail"]);
  const requiredAttempt = new Set(["claim_id", "action_kind", "precondition_modseq"]);
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
    [...requiredAttempt].some((column) => !names(attemptColumns).has(column))
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
