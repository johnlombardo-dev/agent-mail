import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createExecutingActionPlan,
  createMonotonicSequence,
  createPendingActionPlan as createPendingCoreActionPlan,
  createRemoteAttemptSuccess,
  createRemoteAttemptUncertain,
  createRemoteUidValue,
  createUidValidity,
  createUtcInstant,
  type ActionPlanTarget,
  type RemoteAttempt,
  type RemoteAttemptResult,
} from "@agent-mail/core";
import type { PreconditionObservation } from "../../imap/src/precondition";
import { runMigrations, type Migration } from "../../storage/src/migration-runner";
import { startActionPlanAttempt } from "../../storage/src/action-plan-attempt";
import { claimPendingActionPlan } from "../../storage/src/action-plan-claim";
import { createPendingActionPlan } from "../../storage/src/action-plan-repository";
import {
  actionResultReconciliationSequence,
} from "../../storage/src/action-plan-result";
import { actionAttemptDispatchSequence } from "../../storage/src/action-plan-recovery";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import {
  runActionPlanTargetLoop,
  type ActionPlanTargetLoopOptions,
} from "../src/action-plan-target-loop";

const databases: Database[] = [];
const now = createUtcInstant("2026-08-18T02:00:00.000Z");
const resultAt = createUtcInstant("2026-08-18T02:00:01.000Z");
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const migrations: readonly Migration[] = [
  ...actionAttemptDispatchSequence,
  { ...operationalJournalMigration, version: 6 },
  ...actionResultReconciliationSequence.map((migration) => ({ ...migration, version: 7 })),
];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function targets(count: number): readonly ActionPlanTarget[] {
  return createPendingCoreActionPlan({
    state: "pending",
    planId: "plan:target-fixture",
    action: { kind: "markSeen" },
    targets: Array.from({ length: count }, (_, index) => ({
      accountId: "account:one",
      mailboxId: "mailbox:inbox",
      uidValidity: 9,
      uid: index + 1,
      precondition: { modseq: 100 + index },
    })),
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
  }).targets;
}

function openDatabase(targetList: readonly ActionPlanTarget[]): ReturnType<typeof createExecutingActionPlan> {
  const database = new Database(":memory:");
  databases.push(database);
  runMigrations(database, migrations);
  createPendingActionPlan(database, {
    planId: "plan:serial",
    action: { kind: "markSeen" },
    targets: targetList,
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
    previewDigest: digest,
    authorizationScope: "mail:action.create",
    idempotencyIdentity: "caller:serial",
  });
  const claimed = claimPendingActionPlan(database, {
    planId: "plan:serial",
    claimId: "claim:serial",
    startedAt: "2026-08-18T01:00:00.000Z",
    now: "2026-08-18T01:00:00.000Z",
    digest,
    authorizationScope: "mail:action.create",
    expectedVersion: 1,
  });
  if (claimed.kind !== "claimed") throw new Error("test plan was not claimed");
  return claimed.plan;
}

function setup(targetList: readonly ActionPlanTarget[]): {
  readonly database: Database;
  readonly plan: ReturnType<typeof createExecutingActionPlan>;
} {
  const plan = openDatabase(targetList);
  const database = databases.at(-1);
  if (database === undefined) throw new Error("test database was not retained");
  return { database, plan };
}

function satisfied(target: RemoteAttempt["target"]): PreconditionObservation {
  return {
    kind: "satisfied",
    target,
    observed: {
      uidValidity: createUidValidity(target.uidValidity),
      uid: createRemoteUidValue(target.uid),
      modseq: createMonotonicSequence(target.precondition.modseq),
    },
  };
}

function success(attempt: RemoteAttempt, at = resultAt): RemoteAttemptResult {
  return createRemoteAttemptSuccess({
    kind: "success",
    planId: attempt.planId,
    action: attempt.action,
    target: attempt.target,
    attemptId: attempt.attemptId,
    idempotencyKey: attempt.idempotencyKey,
    startedAt: attempt.startedAt,
    resultAt: at,
    certainty: "definite",
    postcondition: {
      kind: "flags",
      observedAt: at,
      flags: ["\\Seen"],
      modseq: createMonotonicSequence(attempt.target.precondition.modseq + 1),
    },
  });
}

function uncertain(attempt: RemoteAttempt, at = resultAt): RemoteAttemptResult {
  return createRemoteAttemptUncertain({
    kind: "uncertain",
    planId: attempt.planId,
    action: attempt.action,
    target: attempt.target,
    attemptId: attempt.attemptId,
    idempotencyKey: attempt.idempotencyKey,
    startedAt: attempt.startedAt,
    resultAt: at,
    certainty: "uncertain",
    uncertainReason: "connection-lost-after-transmission",
    detail: "remote result remains uncertain",
  });
}

function options(
  database: Database,
  plan: ReturnType<typeof createExecutingActionPlan>,
  readPrecondition: ActionPlanTargetLoopOptions["readPrecondition"],
  mutation: (attempt: RemoteAttempt) => Promise<unknown>,
  signal?: AbortSignal,
  uncertainObserver: ActionPlanTargetLoopOptions["uncertainObserver"] = {
    read: async ({ attempt, resultAt: observationAt }) => uncertain(attempt, observationAt),
  },
): ActionPlanTargetLoopOptions {
  return {
    database,
    claimedPlan: plan,
    now,
    expectedPlanVersion: 2,
    freshNow: () => now,
    signal,
    readPrecondition,
    mutationAdapter: { execute: async ({ attempt }) => mutation(attempt) },
    uncertainObserver,
  };
}

describe("serial action-plan target loop P5-C15", () => {
  test("classifies an undispatched attempt at the exact expiry boundary without remote reads or effects", async () => {
    const { database, plan } = setup(targets(1));
    expect(
      startActionPlanAttempt(database, {
        planId: plan.planId,
        claimId: plan.claimId,
        targetOrdinal: 1,
        attemptId: "attempt:plan:serial:1",
        idempotencyKey: "action:plan:serial:1",
        startedAt: now,
        now,
      }),
    ).toMatchObject({ kind: "started" });
    const expiredAt = createUtcInstant("2026-08-19T00:00:00.000Z");
    let preconditionReads = 0;
    let mutationCalls = 0;
    const result = await runActionPlanTargetLoop({
      ...options(
        database,
        plan,
        async () => {
          preconditionReads += 1;
          throw new Error("expired undispatched attempt must not read preconditions");
        },
        async () => {
          mutationCalls += 1;
          throw new Error("expired undispatched attempt must not mutate");
        },
      ),
      freshNow: () => expiredAt,
    });
    expect(result.progress[0]?.result).toMatchObject({
      kind: "rejected",
      certainty: "definite",
      detail: "plan authority expired before remote dispatch",
    });
    expect(preconditionReads).toBe(0);
    expect(mutationCalls).toBe(0);
    expect(database.query("SELECT result_kind, certainty, detail FROM action_results;").get()).toEqual({
      result_kind: "rejected",
      certainty: "definite",
      detail: "plan authority expired before remote dispatch",
    });
    const replay = await runActionPlanTargetLoop({
      ...options(
        database,
        plan,
        async () => {
          preconditionReads += 1;
          throw new Error("expired replay must not read preconditions");
        },
        async () => {
          mutationCalls += 1;
          throw new Error("expired replay must not mutate");
        },
      ),
      freshNow: () => expiredAt,
    });
    expect(replay.progress[0]?.result).toMatchObject({
      kind: "rejected",
      certainty: "definite",
      detail: "plan authority expired before remote dispatch",
    });
    expect(preconditionReads).toBe(0);
    expect(mutationCalls).toBe(0);
  });

  test("rechecks expiry in the marker transaction when the clock advances after precondition read", async () => {
    const { database, plan } = setup(targets(1));
    expect(
      startActionPlanAttempt(database, {
        planId: plan.planId,
        claimId: plan.claimId,
        targetOrdinal: 1,
        attemptId: "attempt:plan:serial:1",
        idempotencyKey: "action:plan:serial:1",
        startedAt: now,
        now,
      }),
    ).toMatchObject({ kind: "started" });
    const expiredAt = createUtcInstant("2026-08-19T00:00:00.000Z");
    let samples = 0;
    const clock = () => (samples++ < 2 ? now : expiredAt);
    const calls: string[] = [];
    const result = await runActionPlanTargetLoop({
      ...options(
        database,
        plan,
        async (target) => {
          calls.push(`precondition:${target.uid}`);
          return satisfied(target);
        },
        async (attempt) => {
          calls.push(`mutation:${attempt.target.uid}`);
          throw new Error("marker transaction must reject before mutation");
        },
      ),
      freshNow: clock,
    });
    expect(result.progress[0]?.result).toMatchObject({
      kind: "rejected",
      certainty: "definite",
      detail: "plan authority expired before remote dispatch",
    });
    expect(calls).toEqual(["precondition:1"]);
    expect(samples).toBe(4);
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempt_dispatches;").get()).toEqual({ count: 0 });
    expect(database.query("SELECT result_kind, certainty, detail FROM action_results;").get()).toEqual({
      result_kind: "rejected",
      certainty: "definite",
      detail: "plan authority expired before remote dispatch",
    });
  });

  test("reconciles a dispatched uncertain attempt after expiry without resending", async () => {
    const { database, plan } = setup(targets(1));
    let mutationCalls = 0;
    const first = await runActionPlanTargetLoop({
      ...options(
        database,
        plan,
        async (target) => satisfied(target),
        async () => {
          mutationCalls += 1;
          throw new Error("uncertain remote effect");
        },
      ),
    });
    expect(first.progress[0]?.result.certainty).toBe("uncertain");
    const expiredAt = createUtcInstant("2026-08-19T00:00:00.000Z");
    const resumed = await runActionPlanTargetLoop({
      ...options(
        database,
        plan,
        async () => {
          throw new Error("dispatched uncertainty must not reread preconditions");
        },
        async () => {
          throw new Error("dispatched uncertainty must not resend");
        },
        undefined,
        {
          read: async ({ attempt, resultAt: observationAt }) => success(attempt, observationAt),
        },
      ),
      freshNow: () => expiredAt,
    });
    expect(resumed.progress[0]?.result).toMatchObject({ kind: "success", certainty: "definite" });
    expect(mutationCalls).toBe(1);
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempt_dispatches;").get()).toEqual({ count: 1 });
  });

  test("does not begin a later target after authority expires between targets", async () => {
    const { database, plan } = setup(targets(2));
    let expired = false;
    let postExpirySamples = 0;
    const reads: number[] = [];
    const writes: number[] = [];
    const result = await runActionPlanTargetLoop({
      ...options(
        database,
        plan,
        async (target) => {
          reads.push(target.uid);
          return satisfied(target);
        },
        async (attempt) => {
          writes.push(attempt.target.uid);
          expired = true;
          return success(attempt);
        },
      ),
      freshNow: () =>
        !expired
          ? now
          : postExpirySamples++ === 0
            ? now
            : createUtcInstant("2026-08-19T00:00:00.000Z"),
    });
    expect(result.progress.map((entry) => entry.result.kind)).toEqual(["success", "rejected"]);
    expect(reads).toEqual([1]);
    expect(writes).toEqual([1]);
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempts;").get()).toEqual({ count: 2 });
  });

  test("rejects a stale plan version before any precondition or mutation adapter path", async () => {
    const { database, plan } = setup(targets(1));
    let preconditionReads = 0;
    let mutationCalls = 0;
    await expect(
      runActionPlanTargetLoop({
        ...options(
          database,
          plan,
          async () => {
            preconditionReads += 1;
            throw new Error("stale version must not read preconditions");
          },
          async () => {
            mutationCalls += 1;
            throw new Error("stale version must not mutate");
          },
        ),
        expectedPlanVersion: 1,
      }),
    ).rejects.toThrow("remote effect authority rejected: version");
    expect(preconditionReads).toBe(0);
    expect(mutationCalls).toBe(0);
  });

  test("persists ordered success, stale, rejected, failed, and uncertain siblings", async () => {
    const targetList = targets(5);
    const { database, plan } = setup(targetList);
    const order: string[] = [];
    const result = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => {
          order.push(`read:${target.uid}`);
          if (target.uid === 2) {
            return {
              kind: "stale",
              target,
              observed: {
                uidValidity: createUidValidity(target.uidValidity),
                uid: createRemoteUidValue(target.uid),
                modseq: createMonotonicSequence(target.precondition.modseq + 1),
              },
              reason: "newer-modseq",
            };
          }
          if (target.uid === 3) return { kind: "missing", target, uidValidity: createUidValidity(9) };
          if (target.uid === 4) return { kind: "transport_error", target, phase: "fetch" };
          return satisfied(target);
        },
        async (attempt) => {
          order.push(`write:${attempt.target.uid}`);
          if (attempt.target.uid === 1) return success(attempt);
          return uncertain(attempt);
        },
      ),
    );
    expect(result.status).toBe("completed");
    expect(result.progress.map((entry) => entry.result.kind)).toEqual([
      "success",
      "stale",
      "rejected",
      "failed",
      "uncertain",
    ]);
    expect(order).toEqual(["read:1", "write:1", "read:2", "read:3", "read:4", "read:5", "write:5"]);
    expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 5 });
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempts;").get()).toEqual({ count: 5 });
  });

  test("resumes after every active boundary without repeating a remote effect", async () => {
    const boundaries = ["before-target", "precondition", "mutation"] as const;
    for (const boundary of boundaries) {
      const targetList = targets(1);
      const { database, plan } = setup(targetList);
      const controller = new AbortController();
      let writes = 0;
      if (boundary === "before-target") controller.abort();
      const first = await runActionPlanTargetLoop(
        options(
          database,
          plan,
          async (target) => {
            if (boundary === "precondition") controller.abort();
            return satisfied(target);
          },
          async (attempt) => {
            if (boundary === "mutation") controller.abort();
            writes += 1;
            return success(attempt);
          },
          controller.signal,
        ),
      );
      expect(first.status).toBe("cancelled");
      const second = await runActionPlanTargetLoop(
        options(
          database,
          plan,
          async (target) => satisfied(target),
          async (attempt) => {
            writes += 1;
            return success(attempt);
          },
        ),
      );
      expect(second.status).toBe("completed");
      expect(writes).toBe(1);
      expect(second.progress[0]?.result.kind).toBe("success");
    }
  });

  test("a target-two throw retains target-one success and records target-two uncertainty", async () => {
    const targetList = targets(2);
    const { database, plan } = setup(targetList);
    let writes = 0;
    const result = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => satisfied(target),
        async (attempt) => {
          writes += 1;
          if (attempt.target.uid === 2) throw new Error("fake remote interrupted after dispatch");
          return success(attempt);
        },
      ),
    );
    expect(result.progress.map((entry) => entry.result.kind)).toEqual(["success", "uncertain"]);
    expect(writes).toBe(2);
    expect(database.query("SELECT result_kind, certainty FROM action_results ORDER BY target_ordinal;").all()).toEqual([
      { result_kind: "success", certainty: "definite" },
      { result_kind: "uncertain", certainty: "uncertain" },
    ]);
    const resumed = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => satisfied(target),
        async (attempt) => {
          writes += 1;
          return success(attempt);
        },
      ),
    );
    expect(resumed.progress.map((entry) => entry.result.kind)).toEqual(["success", "uncertain"]);
    expect(writes).toBe(2);
  });

  test("resumes after a durable dispatch marker without repeating target-one or skipping target-two", async () => {
    const { database, plan } = setup(targets(2));
    const calls: string[] = [];
    const first = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => {
          calls.push(`read:${target.uid}`);
          return satisfied(target);
        },
        async (attempt) => {
          calls.push(`write:${attempt.target.uid}`);
          if (attempt.target.uid === 1) throw new Error("interrupted after durable dispatch marker");
          return success(attempt);
        },
        undefined,
        {
          read: async ({ attempt, resultAt: observationAt }) => uncertain(attempt, observationAt),
        },
      ),
    );
    expect(first.progress.map((entry) => entry.result.kind)).toEqual(["uncertain", "success"]);
    expect(calls).toEqual(["read:1", "write:1", "read:2", "write:2"]);

    const resumed = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => {
          calls.push(`resume-read:${target.uid}`);
          return satisfied(target);
        },
        async (attempt) => {
          calls.push(`resume-write:${attempt.target.uid}`);
          return success(attempt);
        },
      ),
    );
    expect(resumed.progress.map((entry) => entry.result.kind)).toEqual(["uncertain", "success"]);
    expect(calls).toEqual(["read:1", "write:1", "read:2", "write:2"]);
  });

  test("reconciles after result journal failure without repeating the returned remote effect", async () => {
    const { database, plan } = setup(targets(2));
    database.exec(`
      CREATE TRIGGER reject_target_loop_action_journal
      BEFORE INSERT ON operational_journal
      WHEN NEW.category = 'action'
      BEGIN
        SELECT RAISE(ABORT, 'injected target-loop journal failure');
      END;
    `);
    const writes: number[] = [];
    const first = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => satisfied(target),
        async (attempt) => {
          writes.push(attempt.target.uid);
          return success(attempt);
        },
        undefined,
        {
          read: async ({ attempt, resultAt: observationAt }) => {
            database.exec("DROP TRIGGER reject_target_loop_action_journal;");
            return success(attempt, observationAt);
          },
        },
      ),
    );
    expect(first.progress.map((entry) => entry.result.kind)).toEqual(["success", "success"]);
    expect(writes).toEqual([1, 2]);
    expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 2 });

    const resumed = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async () => {
          throw new Error("resumed targets must not read preconditions");
        },
        async () => {
          throw new Error("resumed targets must not mutate");
        },
      ),
    );
    expect(resumed.progress.map((entry) => entry.result.kind)).toEqual(["success", "success"]);
    expect(writes).toEqual([1, 2]);
  });

  test("retains a durable uncertain result when reconciliation throws, then resumes safely", async () => {
    const { database, plan } = setup(targets(2));
    let writes = 0;
    const reads: number[] = [];
    await expect(
      runActionPlanTargetLoop(
        options(
          database,
          plan,
          async (target) => {
            reads.push(target.uid);
            return satisfied(target);
          },
          async (attempt) => {
            writes += 1;
            throw new Error("interrupted after remote effect");
          },
          undefined,
          { read: async () => { throw new Error("read-only reconciliation unavailable"); } },
        ),
      ),
    ).rejects.toThrow("read-only reconciliation unavailable");
    expect(writes).toBe(1);
    expect(reads).toEqual([1]);
    expect(database.query("SELECT result_kind, certainty FROM action_results ORDER BY target_ordinal;").all()).toEqual([
      { result_kind: "uncertain", certainty: "uncertain" },
    ]);

    const resumed = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => satisfied(target),
        async (attempt) => {
          writes += 1;
          return success(attempt);
        },
      ),
    );
    expect(resumed.progress.map((entry) => entry.result.kind)).toEqual(["uncertain", "success"]);
    expect(writes).toBe(2);
  });

  test("allows an uncertain sibling to remain uncertain without starting it again", async () => {
    const { database, plan } = setup(targets(2));
    const writes: number[] = [];
    const result = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => satisfied(target),
        async (attempt) => {
          writes.push(attempt.target.uid);
          return uncertain(attempt);
        },
      ),
    );
    expect(result.progress.map((entry) => entry.result.kind)).toEqual(["uncertain", "uncertain"]);
    expect(writes).toEqual([1, 2]);
  });

  test("returns durable progress when cancellation arrives after target-one result", async () => {
    const { database, plan } = setup(targets(2));
    const controller = new AbortController();
    const reads: number[] = [];
    const writes: number[] = [];
    const first = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => {
          reads.push(target.uid);
          return satisfied(target);
        },
        async (attempt) => {
          writes.push(attempt.target.uid);
          controller.abort();
          return success(attempt);
        },
        controller.signal,
      ),
    );
    expect(first.status).toBe("cancelled");
    expect(first.progress.map((entry) => entry.result.kind)).toEqual(["success"]);
    expect(reads).toEqual([1]);
    expect(writes).toEqual([1]);

    const resumed = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async (target) => {
          reads.push(target.uid);
          return satisfied(target);
        },
        async (attempt) => {
          writes.push(attempt.target.uid);
          return success(attempt);
        },
      ),
    );
    expect(resumed.progress.map((entry) => entry.result.kind)).toEqual(["success", "success"]);
    expect(reads).toEqual([1, 2]);
    expect(writes).toEqual([1, 2]);
  });

  test("reopens a durable attempt-start boundary without repeating its effect", async () => {
    const { database, plan } = setup(targets(1));
    expect(startActionPlanAttempt(database, {
      planId: plan.planId,
      claimId: plan.claimId,
      targetOrdinal: 1,
      attemptId: "attempt:plan:serial:1",
      idempotencyKey: "action:plan:serial:1",
      startedAt: now,
      now,
    })).toMatchObject({ kind: "started" });
    const controller = new AbortController();
    controller.abort();
    const beforeResume = await runActionPlanTargetLoop(
      options(
        database,
        plan,
        async () => { throw new Error("precondition must wait for resume"); },
        async () => { throw new Error("mutation must wait for resume"); },
        controller.signal,
      ),
    );
    expect(beforeResume).toEqual({ status: "cancelled", progress: [] });
    const resumed = await runActionPlanTargetLoop(
      options(database, plan, async (target) => satisfied(target), async (attempt) => success(attempt)),
    );
    expect(resumed.progress.map((entry) => entry.result.kind)).toEqual(["success"]);
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempts;").get()).toEqual({ count: 1 });
  });
});
