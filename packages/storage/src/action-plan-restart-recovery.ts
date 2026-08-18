import type { Database } from "bun:sqlite";
import {
  createActionPlanId,
  createExecutingActionPlan,
  createMonotonicSequence,
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  parseUtcInstant,
  type ExecutingActionPlan,
} from "@agent-mail/core";

/** A durable executing plan together with the optimistic version used to finalize it. */
export type ExecutingActionPlanRecoveryCandidate = Readonly<{
  readonly plan: ExecutingActionPlan;
  readonly version: number;
  readonly authorityVersion: "trusted-v1" | "legacy-untrusted";
}>;

/**
 * Discover only plans whose durable state is executing.
 *
 * Terminal and pending plans are deliberately filtered by SQLite before any
 * target rows are opened. This keeps startup recovery from accidentally
 * treating a terminal result as work that may be resumed.
 */
export function discoverExecutingActionPlans(
  database: Database,
): readonly ExecutingActionPlanRecoveryCandidate[] {
  const hasAuthority =
    database
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'action_approval_consumptions';",
      )
      .get() !== null;
  const rows: readonly unknown[] = database
    .query(
      "SELECT p.plan_id, p.action_kind, p.created_at, p.expires_at, p.claim_id, p.started_at, p.version " +
        "FROM action_plans AS p " +
        (hasAuthority
          ? "JOIN action_approval_consumptions AS c ON c.plan_id = p.plan_id AND c.claim_id = p.claim_id LEFT JOIN action_plan_terminal_audit AS t ON t.plan_id = p.plan_id "
          : "") +
        "WHERE p.state = 'executing' " +
        (hasAuthority ? "AND t.plan_id IS NULL " : "") +
        "ORDER BY p.plan_id;",
    )
    .all();
  return rows.map((value) => readCandidate(database, value, "trusted-v1"));
}

/**
 * Select only legacy plans whose every durable attempt already crossed the
 * dispatch marker. No receipt is manufactured and undispatched legacy plans
 * are intentionally excluded from this effect-capable recovery list.
 */
export function discoverLegacyExecutingActionPlans(
  database: Database,
): readonly ExecutingActionPlanRecoveryCandidate[] {
  if (
    database
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'action_plan_authority_versions';",
      )
      .get() === null
  )
    return [];
  const values: readonly unknown[] = database
    .query(
      "SELECT p.plan_id, p.action_kind, p.created_at, p.expires_at, p.claim_id, p.started_at, p.version " +
        "FROM action_plans AS p JOIN action_plan_authority_versions AS v ON v.plan_id = p.plan_id " +
        "WHERE p.state = 'executing' AND v.authority_version = 'legacy-untrusted' " +
        "AND (SELECT COUNT(*) FROM action_plan_targets t WHERE t.plan_id = p.plan_id) > 0 " +
        "AND (SELECT COUNT(DISTINCT a.attempt_id) FROM action_attempts a JOIN action_attempt_dispatches d ON d.attempt_id = a.attempt_id AND d.plan_id = a.plan_id WHERE a.plan_id = p.plan_id AND a.claim_id = p.claim_id) = " +
        "(SELECT COUNT(*) FROM action_plan_targets t WHERE t.plan_id = p.plan_id) " +
        "ORDER BY p.plan_id;",
    )
    .all();
  return values.map((value) => readCandidate(database, value, "legacy-untrusted"));
}

function readCandidate(
  database: Database,
  value: unknown,
  authorityVersion: "trusted-v1" | "legacy-untrusted",
): ExecutingActionPlanRecoveryCandidate {
  const row = record(value, "executing action plan row");
  const planId = createActionPlanId(row.plan_id);
  const claimId = text(row.claim_id, "executing action plan claim ID");
  if (!claimId.startsWith("claim:")) {
    throw new TypeError("executing action plan claim ID has the wrong namespace");
  }
  const startedAt = parseUtcInstant(row.started_at);
  const version = positiveInteger(row.version, "executing action plan version");
  const targetRows: readonly unknown[] = database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid, precondition_modseq " +
        "FROM action_plan_targets WHERE plan_id = ? ORDER BY target_ordinal;",
    )
    .all(planId);
  const targets = targetRows.map((target) => {
    const item = record(target, "executing action plan target row");
    return {
      accountId: parseAccountId(item.account_id),
      mailboxId: parseMailboxId(item.mailbox_id),
      uidValidity: createUidValidity(item.uid_validity),
      uid: createRemoteUidValue(item.uid),
      precondition: {
        modseq: createMonotonicSequence(item.precondition_modseq),
      },
    };
  });
  const [first, ...rest] = targets;
  if (first === undefined) {
    throw new TypeError("executing action plan must contain at least one target");
  }
  return {
    plan: createExecutingActionPlan({
      state: "executing",
      planId,
      action: { kind: text(row.action_kind, "executing action plan action") },
      targets: [first, ...rest],
      createdAt: parseUtcInstant(row.created_at),
      expiresAt: parseUtcInstant(row.expires_at),
      claimId,
      startedAt,
    }),
    version,
    authorityVersion,
  };
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

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}
