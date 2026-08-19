import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/migration-runner";
import { actionAttemptStartSequence, startActionPlanAttempt } from "../src/action-plan-attempt";
import { claimPendingActionPlan } from "../src/action-plan-claim";
import { createPendingActionPlan } from "../src/action-plan-repository";
import {
  createActionPlanResultRepository,
  readActionPlanResult,
  recordStaleActionPlanResult,
  serializeStalePreconditionObservation,
} from "../src/action-plan-result";

const databases: Database[] = [];
const createdAt = "2026-08-18T00:00:00.000Z";
const expiresAt = "2026-08-19T00:00:00.000Z";
const now = "2026-08-18T01:00:00.000Z";
const claimedAt = "2026-08-18T01:00:01.000Z";
const startedAt = "2026-08-18T01:00:02.000Z";
const resultAt = "2026-08-18T01:00:03.000Z";
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const target = {
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 9,
  uid: 7,
  precondition: { modseq: 101 },
} as const;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  runMigrations(database, actionAttemptStartSequence);
  createPendingActionPlan(database, {
    planId: "plan:one",
    action: { kind: "moveToArchive" },
    targets: [target],
    createdAt,
    expiresAt,
    previewDigest: digest,
    authorizationScope: "mail:action.create",
    idempotencyIdentity: "caller:one",
  });
  expect(
    claimPendingActionPlan(database, {
      planId: "plan:one",
      claimId: "claim:one",
      startedAt: claimedAt,
      now,
      digest,
      authorizationScope: "mail:action.create",
      expectedVersion: 1,
    }),
  ).toMatchObject({ kind: "claimed" });
  expect(
    startActionPlanAttempt(database, {
      planId: "plan:one",
      claimId: "claim:one",
      targetOrdinal: 1,
      attemptId: "attempt:one",
      idempotencyKey: "idempotency:one",
      startedAt,
      now: claimedAt,
    }),
  ).toMatchObject({ kind: "started" });
  return database;
}

function newerObservation() {
  return {
    kind: "stale",
    target,
    observed: { uidValidity: 9, uid: 7, modseq: 102 },
    reason: "newer-modseq",
  } as const;
}

describe("stale action result transaction P5-C07", () => {
  test("persists a definite no-effect result and reopens exact target data", () => {
    const database = openDatabase();
    const recorded = recordStaleActionPlanResult(database, {
      attemptId: "attempt:one",
      resultAt,
      observation: newerObservation(),
    });
    expect(recorded.kind).toBe("recorded");
    if (recorded.kind !== "recorded") throw new Error("expected recorded result");
    expect(recorded.result.kind).toBe("stale");
    expect(recorded.result.certainty).toBe("definite");
    expect(String(recorded.result.detail)).toBe(
      '{"version":1,"kind":"stale","reason":"newer-modseq","uidValidity":9,"uid":7,"preconditionModseq":101,"observedUidValidity":9,"observedUid":7,"observedModseq":102}',
    );
    expect(database.query("SELECT result_kind, certainty, detail FROM action_results;").get()).toEqual({
      result_kind: "stale",
      certainty: "definite",
      detail: recorded.result.detail,
    });

    const reopened = readActionPlanResult(database, "attempt:one");
    expect(reopened).toEqual(recorded.result);
    expect(createActionPlanResultRepository(database).read("attempt:one")).toEqual(recorded.result);
    expect(recordStaleActionPlanResult(database, {
      attemptId: "attempt:one",
      resultAt: "2026-08-18T01:00:04.000Z",
      observation: newerObservation(),
    })).toEqual({ kind: "rejected", attemptId: "attempt:one", reason: "result-exists" });
  });

  test("accepts changed epochs and retains the exact observation fields", () => {
    const database = openDatabase();
    const observation = {
      kind: "epoch_changed",
      target,
      observedUidValidity: 10,
    } as const;
    const result = recordStaleActionPlanResult(database, {
      attemptId: "attempt:one",
      resultAt,
      observation,
    });
    expect(result.kind).toBe("recorded");
    expect(database.query("SELECT detail FROM action_results;").get()).toEqual({
      detail: serializeStalePreconditionObservation(observation),
    });
  });

  test("rejects target, malformed observation, and invalid time without a result", () => {
    const database = openDatabase();
    expect(recordStaleActionPlanResult(database, {
      attemptId: "attempt:one",
      resultAt,
      observation: {
        ...newerObservation(),
        target: { ...target, uid: 8 },
        observed: { uidValidity: 9, uid: 8, modseq: 102 },
      },
    })).toEqual({ kind: "rejected", attemptId: "attempt:one", reason: "target" });
    expect(() => recordStaleActionPlanResult(database, {
      attemptId: "attempt:one",
      resultAt,
      observation: { ...newerObservation(), reason: "older-modseq" },
    })).toThrow("stale observation reason does not match MODSEQ");
    expect(() => recordStaleActionPlanResult(database, {
      attemptId: "attempt:one",
      resultAt: "2026-08-18T01:00:01.000Z",
      observation: newerObservation(),
    })).toThrow("remote attempt result precedes attempt start");
    expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 0 });
  });

  test("does not overwrite an existing uncertain result slot", () => {
    const database = openDatabase();
    database
      .query(
        "INSERT INTO action_results " +
          "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
          "idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, " +
          "failure_reason, detail, postcondition_kind, postcondition_observed_at, postcondition_modseq, " +
          "postcondition_flags, postcondition_mailbox_id, postcondition_uid_validity, postcondition_uid) " +
          "VALUES ('attempt:one', 'plan:one', 1, 'account:one', 'mailbox:inbox', 9, 7, " +
          "'idempotency:one', ?, ?, 'uncertain', 'uncertain', 'local-result-not-durable', NULL, ?, " +
          "NULL, NULL, NULL, NULL, NULL, NULL, NULL);",
      )
      .run(startedAt, resultAt, "remote result was not durable");
    expect(recordStaleActionPlanResult(database, {
      attemptId: "attempt:one",
      resultAt: "2026-08-18T01:00:04.000Z",
      observation: newerObservation(),
    })).toEqual({ kind: "rejected", attemptId: "attempt:one", reason: "result-exists" });
    expect(database.query("SELECT result_kind, certainty FROM action_results;").get()).toEqual({
      result_kind: "uncertain",
      certainty: "uncertain",
    });
  });
});
