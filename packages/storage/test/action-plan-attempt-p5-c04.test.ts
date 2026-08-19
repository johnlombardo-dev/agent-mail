import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/migration-runner";
import {
  actionAttemptStartSequence,
  readActionPlanAttempt,
  startActionPlanAttempt,
} from "../src/action-plan-attempt";
import { createPendingActionPlan } from "../src/action-plan-repository";
import { claimPendingActionPlan } from "../src/action-plan-claim";

const databases: Database[] = [];
const createdAt = "2026-08-18T00:00:00.000Z";
const expiresAt = "2026-08-19T00:00:00.000Z";
const now = "2026-08-18T01:00:00.000Z";
const startedAt = "2026-08-18T01:00:01.000Z";
const resultAt = "2026-08-18T01:00:03.000Z";
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const scope = "mail:action.create";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openActionDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  runMigrations(database, actionAttemptStartSequence);
  return database;
}

function claim(database: Database, planId = "plan:one", claimId = "claim:one") {
  createPendingActionPlan(database, {
    planId,
    action: { kind: "markSeen" },
    targets: [
      {
        accountId: "account:one",
        mailboxId: "mailbox:inbox",
        uidValidity: 9,
        uid: 7,
        precondition: { modseq: 101 },
      },
    ],
    createdAt,
    expiresAt,
    previewDigest: digest,
    authorizationScope: scope,
    idempotencyIdentity: `caller:${planId}`,
  });
  const result = claimPendingActionPlan(database, {
    planId,
    claimId,
    startedAt,
    now,
    digest,
    authorizationScope: scope,
    expectedVersion: 1,
  });
  expect(result.kind).toBe("claimed");
}

function startInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    planId: "plan:one",
    claimId: "claim:one",
    targetOrdinal: 1,
    attemptId: "attempt:one",
    idempotencyKey: "idempotency:one",
    startedAt: "2026-08-18T01:00:02.000Z",
    now: startedAt,
    ...overrides,
  };
}

describe("durable action attempt start", () => {
  test("commits one exact executor input before permission can be granted", () => {
    const database = openActionDatabase();
    expect(
      database
        .query(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'action_attempts_unresolved_target_idx';",
        )
        .get(),
    ).toBeNull();
    expect(
      database
        .query(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = 'action_attempt_start_duplicate_guard';",
        )
        .get(),
    ).toEqual({ present: 1 });
    claim(database);

    const started = startActionPlanAttempt(database, startInput());
    expect(started).toMatchObject({ kind: "started" });
    if (started.kind !== "started") throw new Error("expected a started attempt");

    const beforePermission = database
      .query("SELECT certainty FROM action_attempts WHERE attempt_id = ?;")
      .get("attempt:one");
    expect(beforePermission).toEqual({ certainty: "unresolved" });

    const reopened = readActionPlanAttempt(database, "attempt:one");
    expect(reopened).toEqual(started.executorInput);
    expect(reopened?.claimId).toBe("claim:one");
    expect(reopened?.attempt.target.precondition).toEqual({ modseq: 101 });
    expect(reopened?.attempt.action).toEqual({ kind: "markSeen" });

    let adapterPermission = false;
    const executor = () => {
      expect(database.query("SELECT 1 FROM action_attempts WHERE attempt_id = ?;").get("attempt:one")).not.toBeNull();
      adapterPermission = true;
    };
    executor();
    expect(adapterPermission).toBe(true);
  });

  test("rejects wrong claim, invalid target, stale plan, and duplicate unresolved target", () => {
    const database = openActionDatabase();
    claim(database);

    expect(startActionPlanAttempt(database, startInput({ claimId: "claim:wrong" }))).toMatchObject({
      kind: "rejected",
      reason: "claim",
    });
    expect(startActionPlanAttempt(database, startInput({ targetOrdinal: 2 }))).toMatchObject({
      kind: "rejected",
      reason: "target",
    });
    expect(
      startActionPlanAttempt(
        database,
        startInput({ now: "2026-08-18T23:59:59.000Z", startedAt: expiresAt }),
      ),
    ).toMatchObject({
      kind: "rejected",
      reason: "stale",
    });

    expect(startActionPlanAttempt(database, startInput())).toMatchObject({ kind: "started" });
    expect(() =>
      database
        .query(
          "INSERT INTO action_attempts " +
            "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
            "idempotency_key, started_at, certainty, claim_id, action_kind, precondition_modseq) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?, ?, ?);",
        )
        .run(
          "attempt:direct",
          "plan:one",
          1,
          "account:one",
          "mailbox:inbox",
          9,
          7,
          "idempotency:direct",
          "2026-08-18T01:00:02.500Z",
          "claim:one",
          "markSeen",
          101,
        ),
    ).toThrow("action target already has an unresolved attempt");
    expect(startActionPlanAttempt(database, startInput({ attemptId: "attempt:two", idempotencyKey: "idempotency:two" }))).toMatchObject({
      kind: "rejected",
      reason: "duplicate",
    });
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempts;").get()).toEqual({ count: 1 });
  });

  test("allows a new attempt only after a durable result resolves the prior attempt", () => {
    const database = openActionDatabase();
    claim(database);
    expect(startActionPlanAttempt(database, startInput())).toMatchObject({ kind: "started" });

    const result = database
      .query(
        "INSERT INTO action_results " +
          "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
          "idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, " +
          "failure_reason, detail, postcondition_kind, postcondition_observed_at, " +
          "postcondition_modseq, postcondition_flags, postcondition_mailbox_id, " +
          "postcondition_uid_validity, postcondition_uid) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', 'definite', NULL, NULL, NULL, " +
          "'flags', ?, ?, ?, NULL, NULL, NULL);",
      )
      .run(
        "attempt:one",
        "plan:one",
        1,
        "account:one",
        "mailbox:inbox",
        9,
        7,
        "idempotency:one",
        "2026-08-18T01:00:02.000Z",
        resultAt,
        resultAt,
        102,
        JSON.stringify(["\\Seen"]),
      );
    expect(result.changes).toBe(1);

    expect(
      startActionPlanAttempt(
        database,
        startInput({
          attemptId: "attempt:two",
          idempotencyKey: "idempotency:two",
          startedAt: "2026-08-18T01:00:04.000Z",
          now: resultAt,
        }),
      ),
    ).toMatchObject({ kind: "started" });
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempts;").get()).toEqual({ count: 2 });
  });

  test("keeps an uncertain result unresolved while the plan is still executing", () => {
    const database = openActionDatabase();
    claim(database);
    expect(startActionPlanAttempt(database, startInput())).toMatchObject({ kind: "started" });

    const result = database
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
        "attempt:one",
        "plan:one",
        1,
        "account:one",
        "mailbox:inbox",
        9,
        7,
        "idempotency:one",
        "2026-08-18T01:00:02.000Z",
        resultAt,
        "local-result-not-durable",
        "the remote outcome remains unresolved",
      );
    expect(result.changes).toBe(1);
    expect(
      database
        .query("SELECT certainty FROM action_results WHERE attempt_id = ?;")
        .get("attempt:one"),
    ).toEqual({ certainty: "uncertain" });

    expect(
      startActionPlanAttempt(
        database,
        startInput({
          attemptId: "attempt:two",
          idempotencyKey: "idempotency:two",
          startedAt: "2026-08-18T01:00:04.000Z",
          now: resultAt,
        }),
      ),
    ).toMatchObject({ kind: "rejected", reason: "duplicate" });
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempts;").get()).toEqual({ count: 1 });
  });

  test("rejects terminal plans without writing an attempt", () => {
    const database = openActionDatabase();
    claim(database);
    database
      .query(
        "UPDATE action_plans SET state = 'completed', claim_id = NULL, started_at = NULL, completed_at = ? WHERE plan_id = ?;",
      )
      .run(expiresAt, "plan:one");

    expect(startActionPlanAttempt(database, startInput())).toMatchObject({
      kind: "rejected",
      reason: "plan",
      state: "completed",
    });
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempts;").get()).toEqual({ count: 0 });
  });

  test("reopens a retained attempt from a failed plan but never starts another one", () => {
    const database = openActionDatabase();
    claim(database);
    const started = startActionPlanAttempt(database, startInput());
    expect(started).toMatchObject({ kind: "started" });
    if (started.kind !== "started") throw new Error("expected a started attempt");

    database
      .query(
        "UPDATE action_plans SET state = 'failed', claim_id = NULL, started_at = NULL, failed_at = ? WHERE plan_id = ?;",
      )
      .run(resultAt, "plan:one");

    expect(readActionPlanAttempt(database, "attempt:one")).toEqual(started.executorInput);
    expect(startActionPlanAttempt(database, startInput({
      attemptId: "attempt:two",
      idempotencyKey: "idempotency:two",
    }))).toEqual({
      kind: "rejected",
      planId: "plan:one",
      reason: "plan",
      state: "failed",
    });
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempts;").get()).toEqual({ count: 1 });
    expect(database.query("SELECT state, version FROM action_plans;").get()).toEqual({
      state: "failed",
      version: 2,
    });
  });

  test("accepts an exact target snapshot selector without iterating plan targets", () => {
    const database = openActionDatabase();
    claim(database);
    const { targetOrdinal: _targetOrdinal, ...byTarget } = startInput({
      attemptId: "attempt:by-target",
      idempotencyKey: "idempotency:by-target",
      target: {
        accountId: "account:one",
        mailboxId: "mailbox:inbox",
        uidValidity: 9,
        uid: 7,
        precondition: { modseq: 101 },
      },
    });
    expect(startActionPlanAttempt(database, byTarget)).toMatchObject({ kind: "started" });
    expect(database.query("SELECT target_ordinal FROM action_attempts WHERE attempt_id = ?;").get("attempt:by-target")).toEqual({ target_ordinal: 1 });
  });
});
