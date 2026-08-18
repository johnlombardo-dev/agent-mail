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
  const rows: readonly unknown[] = database
    .query(
      "SELECT plan_id, action_kind, created_at, expires_at, claim_id, started_at, version " +
        "FROM action_plans WHERE state = 'executing' ORDER BY plan_id;",
    )
    .all();
  return rows.map((value) => readCandidate(database, value));
}

function readCandidate(database: Database, value: unknown): ExecutingActionPlanRecoveryCandidate {
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
