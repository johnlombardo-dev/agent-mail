import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/migration-runner";
import { actionPlanProposalMigrations } from "../src/migrations/0002-action-plan-proposal";
import { actionSchemaMigration } from "../src/migrations/0001-action-schema";
import {
  createPendingActionPlan,
  PendingActionPlanSchemaError,
  PendingActionPlanIdempotencyConflictError,
  readPendingActionPlan,
} from "../src/action-plan-repository";

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openActionDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  applyMigrations(database, actionPlanProposalMigrations);
  return database;
}

const targets = [
  {
    accountId: "account:one",
    mailboxId: "mailbox:zeta",
    uidValidity: 9,
    uid: 7,
    precondition: { modseq: 101 },
  },
  {
    accountId: "account:one",
    mailboxId: "mailbox:alpha",
    uidValidity: 9,
    uid: 3,
    precondition: { modseq: 99 },
  },
] as const;

const proposal = {
  planId: "plan:one",
  action: { kind: "markSeen" },
  targets,
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T01:00:00.000Z",
  previewDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  authorizationScope: "mail:action.create",
  idempotencyIdentity: "caller:one",
} as const;

describe("pending action plan repository", () => {
  test("persists, reopens, canonicalizes target order, and freezes target membership", () => {
    const database = openActionDatabase();
    const created = createPendingActionPlan(database, proposal);
    const reopened = readPendingActionPlan(database, "plan:one");

    expect(reopened).toEqual(created);
    expect(created.targets.map((target) => target.mailboxId)).toEqual([
      "mailbox:alpha",
      "mailbox:zeta",
    ]);
    expect(
      database.query("SELECT target_ordinal, mailbox_id FROM action_plan_targets ORDER BY target_ordinal;").all(),
    ).toEqual([
      { target_ordinal: 1, mailbox_id: "mailbox:alpha" },
      { target_ordinal: 2, mailbox_id: "mailbox:zeta" },
    ]);

    expect(() =>
      database
        .query(
          "INSERT INTO action_plan_targets " +
            "(plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, precondition_modseq) " +
            "VALUES ('plan:one', 3, 'account:one', 'mailbox:later', 9, 11, 103);",
        )
        .run(),
    ).toThrow("pending action plan targets are immutable");
    expect(database.query("SELECT COUNT(*) AS count FROM action_plan_targets WHERE plan_id = 'plan:one';").get()).toEqual({ count: 2 });
  });

  test("converges for byte-equivalent retries and rejects conflicting idempotency payloads atomically", () => {
    const database = openActionDatabase();
    const first = createPendingActionPlan(database, proposal);
    const retry = createPendingActionPlan(database, {
      ...proposal,
      targets: [...proposal.targets].reverse(),
    });
    expect(retry).toEqual(first);

    expect(() =>
      createPendingActionPlan(database, {
        ...proposal,
        targets: [proposal.targets[0]],
      }),
    ).toThrow(PendingActionPlanIdempotencyConflictError);
    expect(database.query("SELECT COUNT(*) AS count FROM action_plans;").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM action_plan_targets;").get()).toEqual({ count: 2 });
  });

  test("accepts the shared preview vocabulary at the repository boundary", () => {
    const database = openActionDatabase();
    const created = createPendingActionPlan(database, {
      plan: {
        state: "pending",
        planId: proposal.planId,
        action: proposal.action,
        targets: proposal.targets,
        createdAt: proposal.createdAt,
        expiresAt: proposal.expiresAt,
      },
      digest: proposal.previewDigest,
      scope: proposal.authorizationScope,
      idempotencyKey: proposal.idempotencyIdentity,
    });
    expect(created.previewDigest).toBe(proposal.previewDigest);
    expect(created.authorizationScope).toBe(proposal.authorizationScope);
    expect(created.idempotencyIdentity).toBe(proposal.idempotencyIdentity);
  });

  test("rejects unknown input before SQLite mutation", () => {
    const database = openActionDatabase();
    expect(() => createPendingActionPlan(database, { ...proposal, extra: true })).toThrow();
    expect(() => createPendingActionPlan(database, { ...proposal, previewDigest: "bad" })).toThrow();
    expect(database.query("SELECT COUNT(*) AS count FROM action_plans;").get()).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM action_plan_proposals;").get()).toEqual({ count: 0 });
  });

  test("requires the proposal evidence migration before repository use", () => {
    const database = new Database(":memory:");
    databases.push(database);
    applyMigrations(database, [actionSchemaMigration]);
    expect(() => createPendingActionPlan(database, proposal)).toThrow(PendingActionPlanSchemaError);
    expect(() => readPendingActionPlan(database, proposal.planId)).toThrow(PendingActionPlanSchemaError);
  });
});
