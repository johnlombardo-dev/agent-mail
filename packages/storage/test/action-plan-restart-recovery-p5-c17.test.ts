import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { claimPendingActionPlan } from "../src/action-plan-claim";
import { createPendingActionPlan } from "../src/action-plan-repository";
import {
  actionAttemptDispatchMigrations,
  discoverExecutingActionPlans,
} from "../src/index";

const databases: Database[] = [];
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const migrations: readonly Migration[] = actionAttemptDispatchMigrations;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("executing action-plan startup discovery P5-C17", () => {
  test("returns only executing plans with their immutable version and targets", () => {
    const database = new Database(":memory:");
    databases.push(database);
    applyMigrations(database, migrations);
    for (const [planId, idempotencyIdentity] of [
      ["plan:executing", "caller:executing"],
      ["plan:pending", "caller:pending"],
    ] as const) {
      createPendingActionPlan(database, {
        planId,
        action: { kind: "moveToArchive" },
        targets: [
          {
            accountId: "account:one",
            mailboxId: "mailbox:inbox",
            uidValidity: 9,
            uid: 7,
            precondition: { modseq: 101 },
          },
        ],
        createdAt: "2026-08-18T00:00:00.000Z",
        expiresAt: "2026-08-19T00:00:00.000Z",
        previewDigest: digest,
        authorizationScope: "mail:action.create",
        idempotencyIdentity,
      });
    }
    expect(
      claimPendingActionPlan(database, {
        planId: "plan:executing",
        claimId: "claim:executing",
        startedAt: "2026-08-18T01:00:00.000Z",
        now: "2026-08-18T01:00:00.000Z",
        digest,
        authorizationScope: "mail:action.create",
        expectedVersion: 1,
      }),
    ).toMatchObject({ kind: "claimed" });

    expect(discoverExecutingActionPlans(database)).toMatchObject([
      {
        version: 2,
        plan: {
          planId: "plan:executing",
          state: "executing",
          claimId: "claim:executing",
          action: { kind: "moveToArchive" },
          targets: [{ uid: 7, uidValidity: 9 }],
        },
      },
    ]);
  });
});
