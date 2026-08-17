import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { actionAttemptStartMigrations, startActionPlanAttempt } from "../src/action-plan-attempt";
import { claimPendingActionPlan } from "../src/action-plan-claim";
import { createPendingActionPlan } from "../src/action-plan-repository";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import {
  readActionPlanResult,
  recordDefiniteActionPlanResult,
} from "../src/action-plan-result";

const databases: Database[] = [];
const createdAt = "2026-08-18T00:00:00.000Z";
const expiresAt = "2026-08-19T00:00:00.000Z";
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

const migrations: readonly Migration[] = [
  ...actionAttemptStartMigrations,
  { ...operationalJournalMigration, version: 5 },
];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabaseFor(action: "markSeen" | "moveToArchive") {
  const database = new Database(":memory:");
  databases.push(database);
  applyMigrations(database, migrations);
  createPendingActionPlan(database, {
    planId: "plan:one",
    action: { kind: action },
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
      now: "2026-08-18T01:00:00.000Z",
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

function resultFor(
  action: "markSeen" | "moveToArchive",
  kind: "success" | "stale" | "rejected" | "failed",
): Record<string, unknown> {
  const base = {
    planId: "plan:one",
    action: { kind: action },
    target,
    attemptId: "attempt:one",
    idempotencyKey: "idempotency:one",
    startedAt,
    resultAt,
    kind,
    certainty: "definite",
  };
  if (kind === "success") {
    return action === "markSeen"
      ? {
          ...base,
          postcondition: {
            kind: "flags",
            observedAt: "2026-08-18T01:00:02.500Z",
            flags: ["\\Seen"],
            modseq: 102,
          },
        }
      : {
          ...base,
          postcondition: {
            kind: "mailbox",
            observedAt: "2026-08-18T01:00:02.500Z",
            mailboxId: "mailbox:archive",
            uidValidity: 4,
            uid: 18,
            modseq: 102,
          },
        };
  }
  if (kind === "failed") {
    return { ...base, failureReason: "server-rejected", detail: "server rejected the frozen target" };
  }
  return { ...base, detail: `${kind} before remote mutation` };
}

describe("definite action result transaction P5-C12", () => {
  test("persists every definite variant, reopens exact results, and converges on identical replay", () => {
    const kinds = ["success", "stale", "rejected", "failed"] as const;
    for (const [index, kind] of kinds.entries()) {
      const action = index % 2 === 0 ? "markSeen" : "moveToArchive";
      const database = openDatabaseFor(action);
      const input = resultFor(action, kind);
      const first = recordDefiniteActionPlanResult(database, input);
      expect(first.kind).toBe("recorded");
      if (first.kind !== "recorded") throw new Error("expected definite result");
      expect(readActionPlanResult(database, "attempt:one")).toEqual(first.result);
      expect(recordDefiniteActionPlanResult(database, input)).toEqual(first);
      expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 1 });
      expect(database.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 1 });
    }
  });

  test("rejects a conflicting replay and never overwrites the immutable terminal result", () => {
    const database = openDatabaseFor("markSeen");
    const input = resultFor("markSeen", "failed");
    expect(recordDefiniteActionPlanResult(database, input)).toMatchObject({ kind: "recorded" });
    expect(
      recordDefiniteActionPlanResult(database, {
        ...input,
        detail: "a different safe observation",
      }),
    ).toEqual({ kind: "rejected", attemptId: "attempt:one", reason: "result-conflict" });
    expect(database.query("SELECT failure_reason, detail FROM action_results;").get()).toEqual({
      failure_reason: "server-rejected",
      detail: "server rejected the frozen target",
    });
    expect(() =>
      database.query("UPDATE action_results SET detail = 'changed' WHERE attempt_id = 'attempt:one';").run(),
    ).toThrow("action result identity is immutable");
  });

  test("rolls back result and journal together when journal insertion fails", () => {
    const database = openDatabaseFor("markSeen");
    database.exec(`
      CREATE TRIGGER reject_action_result_journal
      BEFORE INSERT ON operational_journal
      WHEN NEW.category = 'action'
      BEGIN
        SELECT RAISE(ABORT, 'injected action result journal failure');
      END;
    `);
    expect(() => recordDefiniteActionPlanResult(database, resultFor("markSeen", "success"))).toThrow(
      "injected action result journal failure",
    );
    expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 0 });
    expect(database.query("SELECT certainty FROM action_attempts;").get()).toEqual({ certainty: "unresolved" });
  });

  test("rejects uncertain transport outcomes before any definite write", () => {
    const database = openDatabaseFor("markSeen");
    expect(() =>
      recordDefiniteActionPlanResult(database, {
        result: {
          planId: "plan:one",
          action: { kind: "markSeen" },
          target,
          attemptId: "attempt:one",
          idempotencyKey: "idempotency:one",
          startedAt,
          resultAt,
          kind: "uncertain",
          certainty: "uncertain",
          uncertainReason: "connection-lost-after-transmission",
          detail: "connection lost after transmission",
        },
      }),
    ).toThrow("uncertain transport outcomes cannot be finalized as definite");
    expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 0 });
  });

  test("requires the active claim at commit time", () => {
    const database = openDatabaseFor("markSeen");
    database
      .query("UPDATE action_plans SET started_at = '2026-08-18T01:00:04.000Z' WHERE plan_id = 'plan:one';")
      .run();
    expect(recordDefiniteActionPlanResult(database, resultFor("markSeen", "success"))).toEqual({
      kind: "rejected",
      attemptId: "attempt:one",
      reason: "inactive-claim",
    });
    expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 0 });
  });
});
