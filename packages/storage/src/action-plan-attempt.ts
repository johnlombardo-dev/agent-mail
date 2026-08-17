import type { Database } from "bun:sqlite";
import {
  createActionPlanId,
  createClaimId,
  createMonotonicSequence,
  createRemoteAttempt,
  createRemoteAttemptId,
  createRemoteIdempotencyKey,
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  parseUtcInstant,
  type Action,
  type ActionPlanState,
  type ClaimId,
  type RemoteAttempt,
} from "@agent-mail/core";
import {
  actionAttemptStartMigration,
  actionAttemptStartMigrations,
} from "./migrations/0004-action-attempt-start";

/** The exact input that an internal executor may pass to its remote adapter. */
export type ActionAttemptExecutorInput = Readonly<{
  readonly claimId: ClaimId;
  readonly attempt: RemoteAttempt;
}>;

export type ActionAttemptStartResult =
  | Readonly<{
      readonly kind: "started";
      readonly executorInput: ActionAttemptExecutorInput;
      /** Convenient direct access for the internal executor boundary. */
      readonly attempt: RemoteAttempt;
      readonly claimId: ClaimId;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly planId: string;
      readonly reason: "claim" | "plan" | "stale" | "target" | "duplicate";
      readonly state?: ActionPlanState;
    }>;

export type ActionAttemptStartRepository = Readonly<{
  readonly start: (input: unknown) => ActionAttemptStartResult;
  readonly read: (attemptId: unknown) => ActionAttemptExecutorInput | undefined;
}>;

/**
 * Start exactly one target attempt under the active claim.
 *
 * The only write in this function is the attempt INSERT. The transaction is
 * committed before the executor input is returned, so callers cannot obtain
 * remote-adapter permission from an uncommitted attempt identity.
 */
export function startActionPlanAttempt(
  database: Database,
  input: unknown,
): ActionAttemptStartResult {
  const prepared = prepareStart(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    requireAttemptStartSchema(database);

    const plan = readPlan(database, prepared.planId);
    if (plan === undefined) {
      return commitResult(database, {
        kind: "rejected",
        planId: prepared.planId,
        reason: "plan",
      });
    }
    if (plan.state !== "executing") {
      return commitResult(database, {
        kind: "rejected",
        planId: prepared.planId,
        reason: plan.state === "expired" ? "stale" : "plan",
        state: plan.state,
      });
    }
    if (
      plan.claimId === null ||
      plan.startedAt === null ||
      plan.claimId !== prepared.claimId ||
      !hasActiveClaim(database, prepared.planId, prepared.claimId, plan.startedAt)
    ) {
      return commitResult(database, {
        kind: "rejected",
        planId: prepared.planId,
        reason: "claim",
        state: plan.state,
      });
    }
    if (
      prepared.now >= plan.expiresAt ||
      prepared.startedAt < plan.startedAt ||
      prepared.startedAt >= plan.expiresAt
    ) {
      return commitResult(database, {
        kind: "rejected",
        planId: prepared.planId,
        reason: "stale",
        state: plan.state,
      });
    }

    const selectedTarget =
      prepared.targetOrdinal === null
        ? readTargetByIdentity(database, prepared.planId, prepared.target)
        : readTarget(database, prepared.planId, prepared.targetOrdinal);
    if (selectedTarget === undefined) {
      return commitResult(database, {
        kind: "rejected",
        planId: prepared.planId,
        reason: "target",
        state: plan.state,
      });
    }
    const { ordinal: targetOrdinal, target } = selectedTarget;
    if (hasUnresolvedAttempt(database, prepared.planId, targetOrdinal)) {
      return commitResult(database, {
        kind: "rejected",
        planId: prepared.planId,
        reason: "duplicate",
        state: plan.state,
      });
    }
    if (hasAttemptId(database, prepared.attemptId)) {
      return commitResult(database, {
        kind: "rejected",
        planId: prepared.planId,
        reason: "duplicate",
        state: plan.state,
      });
    }

    database
      .query(
        "INSERT INTO action_attempts " +
          "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
          "idempotency_key, started_at, certainty, claim_id, action_kind, precondition_modseq) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?, ?, ?);",
      )
      .run(
        prepared.attemptId,
        prepared.planId,
        targetOrdinal,
        target.accountId,
        target.mailboxId,
        target.uidValidity,
        target.uid,
        prepared.idempotencyKey,
        prepared.startedAt,
        prepared.claimId,
        plan.action.kind,
        target.precondition.modseq,
      );

    const executorInput = makeExecutorInput({
      planId: prepared.planId,
      claimId: prepared.claimId,
      action: plan.action,
      target,
      attemptId: prepared.attemptId,
      idempotencyKey: prepared.idempotencyKey,
      startedAt: prepared.startedAt,
    });
    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      kind: "started",
      executorInput,
      attempt: executorInput.attempt,
      claimId: executorInput.claimId,
    };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

/** Reopen one durable attempt and reconstruct the exact executor input. */
export function readActionPlanAttempt(
  database: Database,
  attemptId: unknown,
): ActionAttemptExecutorInput | undefined {
  const id = parseAttemptId(attemptId);
  requireAttemptStartSchema(database);
  const value: unknown = database
    .query(
      "SELECT plan_id, claim_id, action_kind, account_id, mailbox_id, uid_validity, uid, " +
        "precondition_modseq, attempt_id, idempotency_key, started_at, certainty " +
        "FROM action_attempts WHERE attempt_id = ?;",
    )
    .get(id);
  if (value === null) return undefined;
  const row = record(value, "action attempt row");
  const certainty = requireText(row.certainty, "action attempt certainty");
  if (certainty !== "unresolved") throw new TypeError("action attempt certainty is invalid");
  const action = parseAction(row.action_kind);
  const target = parseTarget({
    accountId: row.account_id,
    mailboxId: row.mailbox_id,
    uidValidity: row.uid_validity,
    uid: row.uid,
    precondition: { modseq: row.precondition_modseq },
  });
  return {
    claimId: parseClaimId(row.claim_id),
    attempt: createRemoteAttempt({
      kind: "attempt",
      planId: row.plan_id,
      action,
      target,
      attemptId: row.attempt_id,
      idempotencyKey: row.idempotency_key,
      startedAt: row.started_at,
      certainty: "unresolved",
    }),
  };
}

/** Compatibility names for callers that describe this as beginning/resuming. */
export const beginActionPlanAttempt = startActionPlanAttempt;
export const reopenActionPlanAttempt = readActionPlanAttempt;
export const startRemoteAttempt = startActionPlanAttempt;
export const readRemoteAttempt = readActionPlanAttempt;

export function createActionAttemptStartRepository(
  database: Database,
): ActionAttemptStartRepository {
  return {
    start: (input) => startActionPlanAttempt(database, input),
    read: (attemptId) => readActionPlanAttempt(database, attemptId),
  };
}

/** Exported for focused migration composition tests without duplicating the set. */
export { actionAttemptStartMigration, actionAttemptStartMigrations };

type PreparedStart = Readonly<{
  readonly planId: string;
  readonly claimId: ClaimId;
  readonly targetOrdinal: number | null;
  readonly target: ActionPlanTarget | null;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly startedAt: string;
  readonly now: string;
}>;

type PlanRow = Readonly<{
  readonly planId: string;
  readonly state: ActionPlanState;
  readonly action: Action;
  readonly claimId: string | null;
  readonly startedAt: string | null;
  readonly expiresAt: string;
}>;

type ActionPlanTarget = Readonly<{
  readonly accountId: string;
  readonly mailboxId: string;
  readonly uidValidity: number;
  readonly uid: number;
  readonly precondition: Readonly<{ readonly modseq: number }>;
}>;

function prepareStart(value: unknown): PreparedStart {
  const input = record(value, "action attempt start input");
  const hasOrdinal = Object.prototype.hasOwnProperty.call(input, "targetOrdinal");
  const hasTarget = Object.prototype.hasOwnProperty.call(input, "target");
  if (hasOrdinal === hasTarget) {
    throw new TypeError("action attempt start input must provide exactly one target selector");
  }
  exactKeys(input, [
    "planId",
    "claimId",
    "attemptId",
    "idempotencyKey",
    "startedAt",
    "now",
    ...(hasOrdinal ? ["targetOrdinal"] : ["target"]),
  ]);
  const targetOrdinal = input.targetOrdinal;
  if (
    hasOrdinal &&
    (typeof targetOrdinal !== "number" || !Number.isSafeInteger(targetOrdinal) || targetOrdinal < 1)
  ) {
    throw new TypeError("action attempt target ordinal must be a positive safe integer");
  }
  const startedAt = parseUtcInstant(input.startedAt);
  const now = parseUtcInstant(input.now);
  if (startedAt < now) throw new TypeError("attempt start must not precede observation time");
  return {
    planId: parsePlanId(input.planId),
    claimId: parseClaimId(input.claimId),
    targetOrdinal: hasOrdinal && typeof targetOrdinal === "number" ? targetOrdinal : null,
    target: hasTarget ? parseTarget(input.target) : null,
    attemptId: parseAttemptId(input.attemptId),
    idempotencyKey: createRemoteIdempotencyKey(input.idempotencyKey),
    startedAt,
    now,
  };
}

function readPlan(database: Database, planId: string): PlanRow | undefined {
  const value: unknown = database
    .query(
      "SELECT plan_id, state, action_kind, claim_id, started_at, expires_at " +
        "FROM action_plans WHERE plan_id = ?;",
    )
    .get(planId);
  if (value === null) return undefined;
  const row = record(value, "action plan row");
  return {
    planId: parsePlanId(row.plan_id),
    state: parseState(row.state),
    action: parseAction(row.action_kind),
    claimId: row.claim_id === null ? null : parseClaimId(row.claim_id),
    startedAt: row.started_at === null ? null : parseUtcInstant(row.started_at),
    expiresAt: parseUtcInstant(row.expires_at),
  };
}

function readTarget(
  database: Database,
  planId: string,
  targetOrdinal: number,
): SelectedTarget | undefined {
  const value: unknown = database
    .query(
      "SELECT target_ordinal, account_id, mailbox_id, uid_validity, uid, precondition_modseq " +
        "FROM action_plan_targets WHERE plan_id = ? AND target_ordinal = ?;",
    )
    .get(planId, targetOrdinal);
  if (value === null) return undefined;
  const row = record(value, "action plan target row");
  const target = parseTarget({
    accountId: row.account_id,
    mailboxId: row.mailbox_id,
    uidValidity: row.uid_validity,
    uid: row.uid,
    precondition: { modseq: row.precondition_modseq },
  });
  return { ordinal: targetOrdinal, target };
}

function readTargetByIdentity(
  database: Database,
  planId: string,
  target: ActionPlanTarget | null,
): SelectedTarget | undefined {
  if (target === null) throw new TypeError("target selector is missing");
  const value: unknown = database
    .query(
      "SELECT target_ordinal, account_id, mailbox_id, uid_validity, uid, precondition_modseq " +
        "FROM action_plan_targets WHERE plan_id = ? AND account_id = ? AND mailbox_id = ? " +
        "AND uid_validity = ? AND uid = ? AND precondition_modseq = ?;",
    )
    .get(
      planId,
      target.accountId,
      target.mailboxId,
      target.uidValidity,
      target.uid,
      target.precondition.modseq,
    );
  if (value === null) return undefined;
  const row = record(value, "action plan target row");
  return {
    ordinal: requireOrdinal(row.target_ordinal),
    target: parseTarget({
      accountId: row.account_id,
      mailboxId: row.mailbox_id,
      uidValidity: row.uid_validity,
      uid: row.uid,
      precondition: { modseq: row.precondition_modseq },
    }),
  };
}

type SelectedTarget = Readonly<{ readonly ordinal: number; readonly target: ActionPlanTarget }>;

function makeExecutorInput(values: {
  readonly planId: string;
  readonly claimId: ClaimId;
  readonly action: Action;
  readonly target: ActionPlanTarget;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly startedAt: string;
}): ActionAttemptExecutorInput {
  return {
    claimId: values.claimId,
    attempt: createRemoteAttempt({
      kind: "attempt",
      planId: values.planId,
      action: values.action,
      target: values.target,
      attemptId: values.attemptId,
      idempotencyKey: values.idempotencyKey,
      startedAt: values.startedAt,
      certainty: "unresolved",
    }),
  };
}

function hasActiveClaim(
  database: Database,
  planId: string,
  claimId: ClaimId,
  startedAt: string,
): boolean {
  const row: unknown = database
    .query("SELECT claimed_at FROM action_plan_claims WHERE plan_id = ? AND claim_id = ?;")
    .get(planId, claimId);
  if (row === null) return false;
  const claimedAt = record(row, "action plan claim row").claimed_at;
  return parseUtcInstant(claimedAt) === startedAt;
}

function hasUnresolvedAttempt(database: Database, planId: string, targetOrdinal: number): boolean {
  return (
    database
      .query(
        "SELECT 1 AS present FROM action_attempts AS prior " +
          "WHERE prior.plan_id = ? AND prior.target_ordinal = ? " +
          "AND NOT EXISTS (" +
          "SELECT 1 FROM action_results AS result " +
          "WHERE result.attempt_id = prior.attempt_id " +
          "AND result.plan_id = prior.plan_id " +
          "AND result.target_ordinal = prior.target_ordinal " +
          "AND result.certainty = 'definite');",
      )
      .get(planId, targetOrdinal) !== null
  );
}

function hasAttemptId(database: Database, attemptId: string): boolean {
  return (
    database
      .query("SELECT 1 AS present FROM action_attempts WHERE attempt_id = ?;")
      .get(attemptId) !== null
  );
}

function requireAttemptStartSchema(database: Database): void {
  const columns: readonly unknown[] = database.query("PRAGMA table_info(action_attempts);").all();
  const required = new Set(["claim_id", "action_kind", "precondition_modseq"]);
  const found = new Set(
    columns.flatMap((value) => {
      if (typeof value !== "object" || value === null || !("name" in value)) return [];
      return typeof value.name === "string" ? [value.name] : [];
    }),
  );
  if ([...required].some((column) => !found.has(column))) {
    throw new Error("action attempt start migration is required before attempt use");
  }
}

function commitResult(
  database: Database,
  result: ActionAttemptStartResult,
): ActionAttemptStartResult {
  database.exec("COMMIT;");
  return result;
}

function rollback(database: Database, original: unknown): never {
  try {
    database.exec("ROLLBACK;");
  } catch (rollbackError: unknown) {
    throw new AggregateError([original, rollbackError], "action attempt rollback failed");
  }
  throw original;
}

function parsePlanId(value: unknown): string {
  const id = createActionPlanId(value);
  if (!id.startsWith("plan:")) throw new TypeError("plan ID must use the plan: namespace");
  return id;
}

function parseClaimId(value: unknown): ClaimId {
  const id = createClaimId(value);
  if (!id.startsWith("claim:")) throw new TypeError("claim ID must use the claim: namespace");
  return id;
}

function parseAttemptId(value: unknown): string {
  const id = createRemoteAttemptId(value);
  if (!id.startsWith("attempt:")) throw new TypeError("attempt ID must use the attempt: namespace");
  return id;
}

function parseState(value: unknown): ActionPlanState {
  if (
    value !== "pending" &&
    value !== "executing" &&
    value !== "completed" &&
    value !== "partial" &&
    value !== "rejected" &&
    value !== "expired" &&
    value !== "uncertain"
  ) {
    throw new TypeError("action plan state is not recognized");
  }
  return value;
}

function parseAction(value: unknown): Action {
  if (
    value !== "markSeen" &&
    value !== "markUnseen" &&
    value !== "moveToArchive" &&
    value !== "moveToTrash"
  ) {
    throw new TypeError("action kind is not recognized");
  }
  return { kind: value };
}

function parseTarget(value: unknown): ActionPlanTarget {
  const row = record(value, "action target");
  const precondition = record(row.precondition, "action target precondition");
  return {
    accountId: parseAccountId(row.accountId),
    mailboxId: parseMailboxId(row.mailboxId),
    uidValidity: createUidValidity(row.uidValidity),
    uid: createRemoteUidValue(row.uid),
    precondition: { modseq: createMonotonicSequence(precondition.modseq) },
  };
}

function requireOrdinal(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("action plan target ordinal is invalid");
  }
  return value;
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

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be canonical text`);
  }
  return value;
}

function exactKeys(recordValue: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(recordValue);
  const expected = new Set(keys);
  if (actual.length !== keys.length || actual.some((key) => !expected.has(key))) {
    throw new TypeError("action attempt start input has missing or unknown fields");
  }
}
