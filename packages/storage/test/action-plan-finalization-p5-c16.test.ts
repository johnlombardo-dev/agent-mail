import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createRemoteAttemptFailed,
  createRemoteAttemptRejected,
  createRemoteAttemptSuccess,
  createRemoteAttemptStale,
  type RemoteAttemptResult,
} from "@agent-mail/core";
import { runMigrations, type Migration } from "../src/migration-runner";
import { actionAttemptStartSequence, startActionPlanAttempt } from "../src/action-plan-attempt";
import { claimPendingActionPlan } from "../src/action-plan-claim";
import { createPendingActionPlan } from "../src/action-plan-repository";
import { recordDefiniteActionPlanResult } from "../src/action-plan-result";
import {
  finalizeActionPlan,
  mapPlanFinalization,
  type PlanFinalizationTarget,
} from "../src/action-plan-finalization";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";

const databases: Database[] = [];
const createdAt = "2026-08-18T00:00:00.000Z";
const expiresAt = "2026-08-19T00:00:00.000Z";
const claimedAt = "2026-08-18T01:00:01.000Z";
const startedAt = "2026-08-18T01:00:02.000Z";
const resultAt = "2026-08-18T01:00:03.000Z";
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const targets = [
  { accountId: "account:one", mailboxId: "mailbox:inbox", uidValidity: 9, uid: 7, precondition: { modseq: 101 } },
  { accountId: "account:one", mailboxId: "mailbox:inbox", uidValidity: 9, uid: 8, precondition: { modseq: 201 } },
] as const;
const migrations: readonly Migration[] = [
  ...actionAttemptStartSequence,
  { ...operationalJournalMigration, version: 5 },
];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openPlan(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  runMigrations(database, migrations);
  createPendingActionPlan(database, {
    planId: "plan:finalize",
    action: { kind: "markSeen" },
    targets,
    createdAt,
    expiresAt,
    previewDigest: digest,
    authorizationScope: "mail:action.create",
    idempotencyIdentity: "caller:finalize",
  });
  expect(claimPendingActionPlan(database, {
    planId: "plan:finalize",
    claimId: "claim:finalize",
    startedAt: claimedAt,
    now: "2026-08-18T01:00:00.000Z",
    digest,
    authorizationScope: "mail:action.create",
    expectedVersion: 1,
  })).toMatchObject({ kind: "claimed" });
  for (const [index, target] of targets.entries()) {
    expect(startActionPlanAttempt(database, {
      planId: "plan:finalize",
      claimId: "claim:finalize",
      targetOrdinal: index + 1,
      attemptId: `attempt:finalize-${index + 1}`,
      idempotencyKey: `idempotency:finalize-${index + 1}`,
      startedAt,
      now: claimedAt,
    })).toMatchObject({ kind: "started" });
  }
  return database;
}

function definiteResult(index: number, kind: "success" | "rejected" | "failed"): RemoteAttemptResult {
  const base = {
    planId: "plan:finalize",
    action: { kind: "markSeen" as const },
    target: targets[index],
    attemptId: `attempt:finalize-${index + 1}`,
    idempotencyKey: `idempotency:finalize-${index + 1}`,
    startedAt,
    resultAt,
  };
  if (kind === "success") {
    return createRemoteAttemptSuccess({
      ...base,
      kind,
      certainty: "definite",
      postcondition: { kind: "flags", observedAt: resultAt, flags: ["\\Seen"], modseq: 102 + index },
    });
  }
  if (kind === "rejected") {
    return createRemoteAttemptRejected({ ...base, kind, certainty: "definite", detail: "operator rejected target" });
  }
  return createRemoteAttemptFailed({
    ...base,
    kind,
    certainty: "definite",
    failureReason: "server-rejected",
    detail: "server rejected target before effect",
  });
}

function recordResults(database: Database, kinds: readonly ("success" | "rejected" | "failed")[]): void {
  for (const [index, kind] of kinds.entries()) {
    expect(recordDefiniteActionPlanResult(database, { result: definiteResult(index, kind) })).toMatchObject({ kind: "recorded" });
  }
}

function insertUncertainResult(database: Database, index: number): void {
  database
    .query(
      "INSERT INTO action_results " +
        "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, detail) " +
        "VALUES (?, 'plan:finalize', ?, 'account:one', 'mailbox:inbox', 9, ?, ?, ?, ?, 'uncertain', 'uncertain', 'local-result-not-durable', ?);",
    )
    .run(`attempt:finalize-${index + 1}`, index + 1, 7 + index, `idempotency:finalize-${index + 1}`, startedAt, resultAt, "result was not durable");
}

function pureInputs(): Readonly<{
  readonly policy: Parameters<typeof mapPlanFinalization>[0];
  readonly results: readonly [PlanFinalizationTarget, ...PlanFinalizationTarget[]];
}> {
  const success = createRemoteAttemptSuccess({
    planId: "plan:pure",
    action: { kind: "markSeen" },
    target: targets[0],
    attemptId: "attempt:pure",
    idempotencyKey: "idempotency:pure",
    startedAt,
    resultAt,
    kind: "success",
    certainty: "definite",
    postcondition: { kind: "flags", observedAt: resultAt, flags: ["\\Seen"], modseq: 102 },
  });
  const secondSuccess = createRemoteAttemptSuccess({
    ...success,
    target: targets[1],
    attemptId: "attempt:pure-second",
    idempotencyKey: "idempotency:pure-second",
    postcondition: { kind: "flags", observedAt: resultAt, flags: ["\\Seen"], modseq: 103 },
  });
  return {
    policy: { planId: "plan:pure", targets, createdAt, expiresAt, now: resultAt },
    results: [
      { targetOrdinal: 1, target: targets[0], result: success },
      { targetOrdinal: 2, target: targets[1], result: secondSuccess },
    ],
  };
}

describe("plan finalization P5-C16", () => {
  test("maps canonical sets exhaustively and is permutation invariant", () => {
    const pure = pureInputs();
    expect(mapPlanFinalization(pure.policy, pure.results).state).toBe("completed");
    const first = pure.results[0];
    const second = pure.results[1];
    if (first === undefined || second === undefined) throw new Error("pure fixture is incomplete");
    const reversed: typeof pure.results = [second, first];
    expect(mapPlanFinalization(pure.policy, reversed).state).toBe("completed");

    const firstMissing = pure.results[0];
    const secondMissing = pure.results[1];
    if (firstMissing === undefined || secondMissing === undefined) throw new Error("pure fixture is incomplete");
    const missing: readonly [PlanFinalizationTarget, PlanFinalizationTarget] = [
      { ...firstMissing, result: undefined },
      secondMissing,
    ];
    expect(() => mapPlanFinalization(pure.policy, missing)).toThrow(
      "requires every durable target result",
    );
    const firstResult = first.result;
    if (firstResult === undefined) throw new Error("pure fixture result is incomplete");
    const stale = createRemoteAttemptStale({
      planId: firstResult.planId,
      action: firstResult.action,
      target: firstResult.target,
      attemptId: firstResult.attemptId,
      idempotencyKey: firstResult.idempotencyKey,
      startedAt: firstResult.startedAt,
      resultAt: firstResult.resultAt,
      kind: "stale",
      certainty: "definite",
      detail: "target MODSEQ was stale",
    });
    expect(mapPlanFinalization(
      { ...pure.policy, targets: [targets[0]] },
      [{ targetOrdinal: 1, target: targets[0], result: stale }],
    ).state).toBe("rejected");
  });

  test("finalizes all-success, all-rejected, mixed, all-failed, and expired sets", () => {
    for (const [kinds, expected] of [
      [["success", "success"], "completed"],
      [["rejected", "rejected"], "rejected"],
      [["success", "rejected"], "partial"],
      [["failed", "failed"], "failed"],
    ] as const) {
      const database = openPlan();
      recordResults(database, kinds);
      const result = finalizeActionPlan(database, {
        planId: "plan:finalize",
        claimId: "claim:finalize",
        expectedVersion: 2,
        now: resultAt,
      });
      expect(result.state).toBe(expected);
      expect(database.query("SELECT state, version FROM action_plans;").get()).toEqual({ state: expected, version: 3 });
      expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 2 });
    }
    const expiredDatabase = openPlan();
    recordResults(expiredDatabase, ["success", "success"]);
    expect(finalizeActionPlan(expiredDatabase, {
      planId: "plan:finalize",
      claimId: "claim:finalize",
      expectedVersion: 2,
      now: expiresAt,
    }).state).toBe("expired");
  });

  test("success plus uncertain remains uncertain while missing result fails closed unchanged", () => {
    const uncertainDatabase = openPlan();
    recordResults(uncertainDatabase, ["success"]);
    insertUncertainResult(uncertainDatabase, 1);
    const uncertainFinalization = finalizeActionPlan(uncertainDatabase, {
      planId: "plan:finalize",
      claimId: "claim:finalize",
      expectedVersion: 2,
      now: resultAt,
    });
    expect(uncertainFinalization.state).toBe("uncertain");
    expect(
      uncertainFinalization.targetResults.find((item) => item.targetOrdinal === 2)?.result.attemptId,
    ).toBe("attempt:finalize-2");
    expect(uncertainDatabase.query("SELECT state, version, uncertain_attempt_id FROM action_plans;").get()).toEqual({
      state: "uncertain",
      version: 3,
      uncertain_attempt_id: "attempt:finalize-2",
    });

    const missingDatabase = openPlan();
    recordResults(missingDatabase, ["success"]);
    const before = {
      plan: missingDatabase.query("SELECT * FROM action_plans ORDER BY plan_id;").all(),
      claims: missingDatabase.query("SELECT * FROM action_plan_claims ORDER BY plan_id, claim_id;").all(),
      targets: missingDatabase.query("SELECT * FROM action_plan_targets ORDER BY plan_id, target_ordinal;").all(),
      attempts: missingDatabase.query("SELECT * FROM action_attempts ORDER BY attempt_id;").all(),
      results: missingDatabase.query("SELECT * FROM action_results ORDER BY attempt_id;").all(),
      journal: missingDatabase.query("SELECT * FROM operational_journal ORDER BY id;").all(),
    };
    expect(() => finalizeActionPlan(missingDatabase, {
      planId: "plan:finalize",
      claimId: "claim:finalize",
      expectedVersion: 2,
      now: resultAt,
    })).toThrow("requires every durable target result");
    expect({
      plan: missingDatabase.query("SELECT * FROM action_plans ORDER BY plan_id;").all(),
      claims: missingDatabase.query("SELECT * FROM action_plan_claims ORDER BY plan_id, claim_id;").all(),
      targets: missingDatabase.query("SELECT * FROM action_plan_targets ORDER BY plan_id, target_ordinal;").all(),
      attempts: missingDatabase.query("SELECT * FROM action_attempts ORDER BY attempt_id;").all(),
      results: missingDatabase.query("SELECT * FROM action_results ORDER BY attempt_id;").all(),
      journal: missingDatabase.query("SELECT * FROM operational_journal ORDER BY id;").all(),
    }).toEqual(before);
  });

  test("wrong claim/version and incomplete target identity fail closed", () => {
    const database = openPlan();
    recordResults(database, ["success", "success"]);
    expect(() => finalizeActionPlan(database, { planId: "plan:finalize", claimId: "claim:wrong", expectedVersion: 2, now: resultAt })).toThrow("claim identity");
    expect(() => finalizeActionPlan(database, { planId: "plan:finalize", claimId: "claim:finalize", expectedVersion: 1, now: resultAt })).toThrow("version");
  });

  test("journal failure rolls back only finalization and keeps every target result", () => {
    const database = openPlan();
    recordResults(database, ["success", "failed"]);
    database.exec("CREATE TRIGGER reject_plan_finalization_journal BEFORE INSERT ON operational_journal WHEN NEW.category = 'action' AND NEW.id LIKE 'action-plan-finalization:%' BEGIN SELECT RAISE(ABORT, 'injected finalization journal failure'); END;");
    expect(() => finalizeActionPlan(database, {
      planId: "plan:finalize",
      claimId: "claim:finalize",
      expectedVersion: 2,
      now: resultAt,
    })).toThrow("injected finalization journal failure");
    expect(database.query("SELECT state, version FROM action_plans;").get()).toEqual({ state: "executing", version: 2 });
    expect(database.query("SELECT result_kind FROM action_results ORDER BY target_ordinal;").all()).toEqual([
      { result_kind: "success" },
      { result_kind: "failed" },
    ]);
    expect(database.query("SELECT COUNT(*) AS count FROM operational_journal WHERE id LIKE 'action-plan-finalization:%';").get()).toEqual({ count: 0 });
  });

  test("same finalization input converges on replay while a wrong replay fails closed", () => {
    const database = openPlan();
    recordResults(database, ["success", "rejected"]);
    const input = { planId: "plan:finalize", claimId: "claim:finalize", expectedVersion: 2, now: resultAt };
    const first = finalizeActionPlan(database, input);
    expect(finalizeActionPlan(database, input)).toEqual(first);
    expect(() => finalizeActionPlan(database, { ...input, expectedVersion: 1 })).toThrow("replay claim or version");
  });
});
