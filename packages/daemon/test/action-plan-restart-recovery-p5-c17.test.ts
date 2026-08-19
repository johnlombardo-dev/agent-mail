import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createMonotonicSequence,
  createPendingActionPlan as createPendingCoreActionPlan,
  createRemoteAttemptSuccess,
  createRemoteUidValue,
  createUidValidity,
  createUtcInstant,
  type RemoteAttempt,
} from "@agent-mail/core";
import type { PreconditionObservation } from "../../imap/src/precondition";
import { runMigrations, type Migration } from "../../storage/src/migration-runner";
import { claimPendingActionPlan } from "../../storage/src/action-plan-claim";
import { readActionPlanAttempt, startActionPlanAttempt } from "../../storage/src/action-plan-attempt";
import { createPendingActionPlan } from "../../storage/src/action-plan-repository";
import { actionAttemptDispatchSequence } from "../../storage/src/action-plan-recovery";
import { actionResultReconciliationSequence } from "../../storage/src/action-plan-result";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import { threadGraphMigration } from "../../storage/src/migrations/0008-thread-graph";
import { actionApprovalAuthorityMigration } from "../../storage/src/migrations/0009-action-approval-authority";
import { actionPlanRestoreQuarantineMigration } from "../../storage/src/migrations/0010-action-plan-restore-quarantine";
import { discoverExecutingActionPlans, discoverLegacyExecutingActionPlans } from "../../storage/src/action-plan-restart-recovery";
import { markActionPlanAttemptDispatched } from "../../storage/src/action-plan-recovery";
import {
  createFileActionPlanOwnerLeaseStore,
  recoverExecutingActionPlans,
  runOwnedActionPlanTargetLoop,
  type ActionPlanOwnerLease,
} from "../src/action-plan-restart-recovery";

const databases: Database[] = [];
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const now = createUtcInstant("2026-08-18T02:00:00.000Z");
const resultAt = createUtcInstant("2026-08-18T02:00:01.000Z");
const target = {
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 9,
  uid: 7,
  precondition: { modseq: 101 },
} as const;
const migrations: readonly Migration[] = [
  ...actionAttemptDispatchSequence,
  { ...operationalJournalMigration, version: 6 },
  ...actionResultReconciliationSequence.map((migration) => ({ ...migration, version: 7 })),
];
const legacyMigrations: readonly Migration[] = [
  ...migrations,
  { ...threadGraphMigration, version: 8 },
  actionApprovalAuthorityMigration,
  actionPlanRestoreQuarantineMigration,
];

type CrashCutPoint =
  | "before-dispatch"
  | "after-dispatch-before-effect"
  | "after-effect-before-result"
  | "after-result-commit"
  | "before-finalization";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  runMigrations(database, migrations);
  createPendingActionPlan(database, {
    planId: "plan:restart",
    action: { kind: "moveToArchive" },
    targets: [target],
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
    previewDigest: digest,
    authorizationScope: "mail:action.create",
    idempotencyIdentity: "caller:restart",
  });
  const claimed = claimPendingActionPlan(database, {
    planId: "plan:restart",
    claimId: "claim:restart",
    startedAt: "2026-08-18T01:00:00.000Z",
    now: "2026-08-18T01:00:00.000Z",
    digest,
    authorizationScope: "mail:action.create",
    expectedVersion: 1,
  });
  if (claimed.kind !== "claimed") throw new Error("test plan was not claimed");
  return database;
}

function openLegacyDatabase(dispatched: boolean): Database {
  const database = new Database(":memory:");
  databases.push(database);
  runMigrations(database, migrations);
  createPendingActionPlan(database, {
    planId: dispatched ? "plan:legacy-dispatched" : "plan:legacy-undispatched",
    action: { kind: "moveToArchive" },
    targets: [target],
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
    previewDigest: digest,
    authorizationScope: "mail:action.create",
    idempotencyIdentity: dispatched ? "caller:legacy-dispatched" : "caller:legacy-undispatched",
  });
  const planId = dispatched ? "plan:legacy-dispatched" : "plan:legacy-undispatched";
  const claimed = claimPendingActionPlan(database, {
    planId,
    claimId: dispatched ? "claim:legacy-dispatched" : "claim:legacy-undispatched",
    startedAt: "2026-08-18T01:00:00.000Z",
    now: "2026-08-18T01:00:00.000Z",
    digest,
    authorizationScope: "mail:action.create",
    expectedVersion: 1,
  });
  if (claimed.kind !== "claimed") throw new Error("legacy plan was not claimed");
  if (dispatched) {
    const attempt = startActionPlanAttempt(database, {
      planId,
      claimId: claimed.plan.claimId,
      targetOrdinal: 1,
      attemptId: "attempt:plan:legacy-dispatched:1",
      idempotencyKey: "action:plan:legacy-dispatched:1",
      startedAt: "2026-08-18T01:00:01.000Z",
      now: "2026-08-18T01:00:01.000Z",
    });
    if (attempt.kind !== "started") throw new Error("legacy attempt was not started");
    const marked = markActionPlanAttemptDispatched(database, {
      attemptId: attempt.attempt.attemptId,
      planId,
      claimId: claimed.plan.claimId,
      expectedVersion: 2,
      dispatchedAt: "2026-08-18T01:00:02.000Z",
      observation: {
        kind: "satisfied",
        target,
        observed: { uidValidity: target.uidValidity, uid: target.uid, modseq: target.precondition.modseq },
      },
    });
    if (marked.kind !== "marked") throw new Error("legacy attempt was not dispatched");
  }
  runMigrations(database, legacyMigrations);
  return database;
}

function satisfied(observedTarget: RemoteAttempt["target"]): PreconditionObservation {
  return {
    kind: "satisfied",
    target: observedTarget,
    observed: {
      uidValidity: createUidValidity(observedTarget.uidValidity),
      uid: createRemoteUidValue(observedTarget.uid),
      modseq: createMonotonicSequence(observedTarget.precondition.modseq),
    },
  };
}

function success(attempt: RemoteAttempt, at = resultAt) {
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
      kind: "mailbox",
      observedAt: at,
      mailboxId: "mailbox:archive",
      uidValidity: createUidValidity(attempt.target.uidValidity),
      uid: createRemoteUidValue(attempt.target.uid),
      modseq: createMonotonicSequence(attempt.target.precondition.modseq + 1),
    },
  });
}

function ownerLeases(): {
  readonly acquire: (input: Readonly<{ planId: string; claimId: string }>) => Promise<Readonly<{ kind: "acquired"; lease: ActionPlanOwnerLease }>>;
  readonly release: (lease: ActionPlanOwnerLease) => Promise<"released">;
} {
  return {
    acquire: async (input) => ({ kind: "acquired", lease: { ...input, ownerToken: "owner:test" } }),
    release: async () => "released",
  };
}

function loopOptions(trace: string[], writes: { value: number }): (
  candidate: Parameters<typeof recoverExecutingActionPlans>[0]["targetLoopOptions"] extends (
    candidate: infer Candidate,
  ) => unknown
    ? Candidate
    : never,
) => Omit<import("../src/action-plan-target-loop").ActionPlanTargetLoopOptions, "database" | "claimedPlan" | "now" | "expectedPlanVersion" | "freshNow"> {
  return () => ({
    readPrecondition: async (candidate) => {
      trace.push(`read:${candidate.uid}`);
      return satisfied(candidate);
    },
    mutationAdapter: {
      execute: async ({ attempt }) => {
        trace.push(`write:${attempt.target.uid}`);
        writes.value += 1;
        return success(attempt);
      },
    },
    uncertainObserver: { read: async () => { throw new Error("not needed"); } },
  });
}

type CrashFixture = Readonly<{
  readonly root: string;
  readonly databasePath: string;
  readonly leaseDirectory: string;
  readonly tracePath: string;
  readonly remoteStatePath: string;
}>;

async function createCrashFixture(root: string, name: string): Promise<CrashFixture> {
  const fixtureRoot = join(root, name);
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const databasePath = join(fixtureRoot, "actions.sqlite");
  const leaseDirectory = join(fixtureRoot, "leases");
  const tracePath = join(fixtureRoot, "remote-trace.jsonl");
  const remoteStatePath = join(fixtureRoot, "remote-state.json");
  const database = new Database(databasePath);
  runMigrations(database, migrations);
  createPendingActionPlan(database, {
    planId: "plan:restart",
    action: { kind: "moveToArchive" },
    targets: [target],
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
    previewDigest: digest,
    authorizationScope: "mail:action.create",
    idempotencyIdentity: `caller:${name}`,
  });
  const claimed = claimPendingActionPlan(database, {
    planId: "plan:restart",
    claimId: "claim:restart",
    startedAt: "2026-08-18T01:00:00.000Z",
    now: "2026-08-18T01:00:00.000Z",
    digest,
    authorizationScope: "mail:action.create",
    expectedVersion: 1,
  });
  if (claimed.kind !== "claimed") throw new Error("crash fixture plan was not claimed");
  database.close();
  return { root: fixtureRoot, databasePath, leaseDirectory, tracePath, remoteStatePath };
}

function crashChildScript(fixture: CrashFixture, cutPoint: CrashCutPoint | "none"): string {
  const recoveryUrl = new URL("../src/action-plan-restart-recovery.ts", import.meta.url).href;
  const coreUrl = new URL("../../core/src/index.ts", import.meta.url).href;
  const migrationUrl = new URL("../../storage/src/migration-runner.ts", import.meta.url).href;
  const dispatchUrl = new URL("../../storage/src/action-plan-recovery.ts", import.meta.url).href;
  const resultUrl = new URL("../../storage/src/action-plan-result.ts", import.meta.url).href;
  const journalUrl = new URL("../../storage/src/migrations/0001-operational-journal.ts", import.meta.url).href;
  const config = JSON.stringify({ ...fixture, cutPoint });
  return `
    const config = ${config};
    const core = await import(${JSON.stringify(coreUrl)});
    const recovery = await import(${JSON.stringify(recoveryUrl)});
    const migration = await import(${JSON.stringify(migrationUrl)});
    const dispatch = await import(${JSON.stringify(dispatchUrl)});
    const resultStore = await import(${JSON.stringify(resultUrl)});
    const journal = await import(${JSON.stringify(journalUrl)});
    const { Database } = await import("bun:sqlite");
    const { appendFile, readFile, writeFile } = await import("node:fs/promises");
    const database = new Database(config.databasePath);
    const migrations = [
      ...dispatch.actionAttemptDispatchSequence,
      { ...journal.operationalJournalMigration, version: 6 },
      ...resultStore.actionResultReconciliationSequence.map((item) => ({ ...item, version: 7 })),
    ];
    migration.runMigrations(database, migrations);
    const now = core.createUtcInstant("2026-08-18T02:00:00.000Z");
    const resultAt = core.createUtcInstant("2026-08-18T02:00:01.000Z");
    const satisfied = (candidate) => ({ kind: "satisfied", target: candidate, observed: { uidValidity: candidate.uidValidity, uid: candidate.uid, modseq: candidate.precondition.modseq } });
    const success = (attempt, at) => core.createRemoteAttemptSuccess({ kind: "success", planId: attempt.planId, action: attempt.action, target: attempt.target, attemptId: attempt.attemptId, idempotencyKey: attempt.idempotencyKey, startedAt: attempt.startedAt, resultAt: at, certainty: "definite", postcondition: { kind: "mailbox", observedAt: at, mailboxId: "mailbox:archive", uidValidity: attempt.target.uidValidity, uid: attempt.target.uid, modseq: attempt.target.precondition.modseq + 1 } });
    const uncertain = (attempt, at) => core.createRemoteAttemptUncertain({ kind: "uncertain", planId: attempt.planId, action: attempt.action, target: attempt.target, attemptId: attempt.attemptId, idempotencyKey: attempt.idempotencyKey, startedAt: attempt.startedAt, resultAt: at, certainty: "uncertain", uncertainReason: "connection-lost-after-transmission", detail: "remote postcondition remains unconfirmed" });
    const crash = (point) => { if (config.cutPoint === point) process.exit(86); };
    await recovery.recoverExecutingActionPlans({
      database,
      ownerLeases: recovery.createFileActionPlanOwnerLeaseStore({ directory: config.leaseDirectory }),
      now,
      freshNow: () => now,
      targetLoopOptions: () => ({
        readPrecondition: async (candidate) => { crash("before-dispatch"); return satisfied(candidate); },
        mutationAdapter: { execute: async ({ attempt }) => { crash("after-dispatch-before-effect"); await writeFile(config.remoteStatePath, JSON.stringify({ command: "MOVE", uid: attempt.target.uid, mailboxId: "mailbox:archive" })); await appendFile(config.tracePath, JSON.stringify({ command: "MOVE", uid: attempt.target.uid }) + "\\n"); crash("after-effect-before-result"); return success(attempt, resultAt); } },
        uncertainObserver: { read: async ({ attempt, resultAt: observationAt }) => { try { await readFile(config.remoteStatePath, "utf8"); return success(attempt, observationAt); } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return uncertain(attempt, observationAt); throw error; } } },
        onDurableTargetResult: async () => { crash("after-result-commit"); },
      }),
      onAllTargetsDurable: async () => { crash("before-finalization"); },
    });
    database.close();
  `;
}

async function runCrashChild(fixture: CrashFixture, cutPoint: CrashCutPoint | "none"): Promise<number> {
  const child = Bun.spawn(["bun", "-e", crashChildScript(fixture, cutPoint)], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0 && exitCode !== 86) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`crash child failed with ${exitCode}: ${stderr}`);
  }
  return exitCode;
}

function durableSnapshot(databasePath: string): Readonly<{ readonly plan: unknown; readonly results: readonly unknown[] }> {
  const database = new Database(databasePath);
  const plan: unknown = database.query("SELECT state, version, claim_id FROM action_plans WHERE plan_id = 'plan:restart';").get();
  const results: readonly unknown[] = database.query("SELECT target_ordinal, result_kind, certainty, uncertain_reason, detail, postcondition_kind, postcondition_mailbox_id FROM action_results ORDER BY target_ordinal;").all();
  database.close();
  return { plan, results };
}

async function traceLines(path: string): Promise<readonly unknown[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim().length === 0 ? [] : text.trim().split("\n").map((line) => JSON.parse(line));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

describe("executing action-plan restart recovery P5-C17", () => {
  test("keeps legacy executing plans fail-closed while reconciling dispatched work read-only", async () => {
    const dispatched = openLegacyDatabase(true);
    expect(discoverExecutingActionPlans(dispatched)).toHaveLength(0);
    expect(discoverLegacyExecutingActionPlans(dispatched)).toMatchObject([
      { authorityVersion: "legacy-untrusted", plan: { planId: "plan:legacy-dispatched" } },
    ]);
    let remoteCalls = 0;
    let observerCalls = 0;
    const report = await recoverExecutingActionPlans({
      database: dispatched,
      ownerLeases: ownerLeases(),
      now,
      freshNow: () => now,
      targetLoopOptions: () => ({
        readPrecondition: async () => {
          throw new Error("legacy recovery must not read preconditions");
        },
        mutationAdapter: {
          execute: async () => {
            remoteCalls += 1;
            throw new Error("legacy recovery must not execute");
          },
        },
        uncertainObserver: {
          read: async ({ attempt, resultAt }) => {
            observerCalls += 1;
            return success(attempt, resultAt);
          },
        },
      }),
    });
    expect(report).toMatchObject({
      discovered: 1,
      outcomes: [{ planId: "plan:legacy-dispatched", kind: "recovered", finalized: { state: "completed" } }],
    });
    expect(remoteCalls).toBe(0);
    expect(observerCalls).toBe(1);
    expect(dispatched.query("SELECT state, claim_id FROM action_plans WHERE plan_id = ?;").get("plan:legacy-dispatched")).toEqual({ state: "completed", claim_id: null });
    expect(dispatched.query("SELECT authority_version, reason_code FROM action_plan_authority_versions WHERE plan_id = ?;").get("plan:legacy-dispatched")).toEqual({ authority_version: "legacy-untrusted", reason_code: "legacy-pre-authority" });

    const undispatched = openLegacyDatabase(false);
    const undispatchedReport = await recoverExecutingActionPlans({
      database: undispatched,
      ownerLeases: ownerLeases(),
      now,
      freshNow: () => now,
      targetLoopOptions: () => {
        throw new Error("undispatched legacy plan must not be selected");
      },
    });
    expect(undispatchedReport).toEqual({ discovered: 0, outcomes: [] });
    expect(undispatched.query("SELECT state, claim_id FROM action_plans WHERE plan_id = ?;").get("plan:legacy-undispatched")).toEqual({ state: "executing", claim_id: "claim:legacy-undispatched" });
  });

  test("recovers a pre-expiry persisted undispatched attempt after expiry with no remote calls", async () => {
    const database = openDatabase();
    expect(
      startActionPlanAttempt(database, {
        planId: "plan:restart",
        claimId: "claim:restart",
        targetOrdinal: 1,
        attemptId: "attempt:plan:restart:1",
        idempotencyKey: "action:plan:restart:1",
        startedAt: now,
        now,
      }),
    ).toMatchObject({ kind: "started" });
    expect(readActionPlanAttempt(database, "attempt:plan:restart:1")).toBeDefined();
    const trace: string[] = [];
    const expiredAt = createUtcInstant("2026-08-19T00:00:00.000Z");
    const recovered = await recoverExecutingActionPlans({
      database,
      ownerLeases: ownerLeases(),
      now: expiredAt,
      freshNow: () => expiredAt,
      targetLoopOptions: () => ({
        readPrecondition: async () => {
          trace.push("read");
          throw new Error("expired recovery must not read preconditions");
        },
        mutationAdapter: {
          execute: async () => {
            trace.push("write");
            throw new Error("expired recovery must not mutate");
          },
        },
        uncertainObserver: { read: async () => { throw new Error("no reconciliation expected"); } },
      }),
    });
    expect(recovered.outcomes[0]).toMatchObject({
      planId: "plan:restart",
      kind: "recovered",
      finalized: { state: "expired" },
    });
    expect(trace).toEqual([]);
    expect(database.query("SELECT result_kind, certainty, detail FROM action_results;").get()).toEqual({
      result_kind: "rejected",
      certainty: "definite",
      detail: "plan authority expired before remote dispatch",
    });
  });

  test("skips a demonstrably live owner and does not enter the remote loop", async () => {
    const database = openDatabase();
    let called = false;
    const result = await recoverExecutingActionPlans({
      database,
      ownerLeases: {
        acquire: async () => ({ kind: "live", planId: "plan:restart", claimId: "claim:other" }),
        release: async () => "not-owner",
      },
      now,
      freshNow: () => now,
      targetLoopOptions: () => {
        called = true;
        throw new Error("live owner must not be entered");
      },
    });
    expect(result.outcomes).toEqual([{ planId: "plan:restart", kind: "skipped-live-owner" }]);
    expect(called).toBe(false);
  });

  test("runs the target loop and finalizes only after its durable result", async () => {
    const database = openDatabase();
    const trace: string[] = [];
    const writes = { value: 0 };
    const result = await recoverExecutingActionPlans({
      database,
      ownerLeases: ownerLeases(),
      now,
      freshNow: () => now,
      targetLoopOptions: loopOptions(trace, writes),
    });
    expect(result.outcomes[0]).toMatchObject({ planId: "plan:restart", kind: "recovered", finalized: { state: "completed" } });
    expect(trace).toEqual(["read:7", "write:7"]);
    expect(writes.value).toBe(1);
    expect(database.query("SELECT state FROM action_plans WHERE plan_id = 'plan:restart';").get()).toEqual({ state: "completed" });
  });

  test("normal execution acquires and releases the same owner lease boundary", async () => {
    const database = openDatabase();
    const candidate = discoverExecutingActionPlans(database)[0];
    if (candidate === undefined) throw new Error("test candidate is missing");
    const trace: string[] = [];
    const writes = { value: 0 };
    let acquired = 0;
    let released = 0;
    const ownerLease = {
      acquire: async () => {
        acquired += 1;
        return { kind: "acquired" as const, lease: { planId: "plan:restart", claimId: "claim:restart", ownerToken: "owner:normal" } };
      },
      release: async () => {
        released += 1;
        return "released" as const;
      },
    };
    const options = loopOptions(trace, writes)(candidate);
    const result = await runOwnedActionPlanTargetLoop({
      ownerLeases: ownerLease,
      targetLoop: { ...options, database, claimedPlan: candidate.plan, now, expectedPlanVersion: candidate.version, freshNow: () => now },
    });
    expect(result.kind).toBe("ran");
    expect(acquired).toBe(1);
    expect(released).toBe(1);
  });

  test("a target-loop interruption leaves the plan executing and restart can converge", async () => {
    const database = openDatabase();
    const crashed = new AbortController();
    crashed.abort();
    const first = await recoverExecutingActionPlans({
      database,
      ownerLeases: ownerLeases(),
      now,
      freshNow: () => now,
      signal: crashed.signal,
      targetLoopOptions: () => ({
        readPrecondition: async () => { throw new Error("must not read"); },
        mutationAdapter: { execute: async () => { throw new Error("must not write"); } },
        uncertainObserver: { read: async () => { throw new Error("must not reconcile"); } },
      }),
    });
    expect(first.outcomes[0]).toEqual({ planId: "plan:restart", kind: "incomplete", durableTargetCount: 0 });
    expect(database.query("SELECT state FROM action_plans WHERE plan_id = 'plan:restart';").get()).toEqual({ state: "executing" });
    const trace: string[] = [];
    const writes = { value: 0 };
    const resumed = await recoverExecutingActionPlans({
      database,
      ownerLeases: ownerLeases(),
      now,
      freshNow: () => now,
      targetLoopOptions: loopOptions(trace, writes),
    });
    expect(resumed.outcomes[0]).toMatchObject({ planId: "plan:restart", kind: "recovered" });
    expect(trace).toEqual(["read:7", "write:7"]);
  });

  test("dispatch-crossed unresolved MOVE reconciles read-only and never resends MOVE", async () => {
    const database = openDatabase();
    const trace: string[] = [];
    const first = await recoverExecutingActionPlans({
      database,
      ownerLeases: ownerLeases(),
      now,
      freshNow: () => now,
      targetLoopOptions: () => ({
        readPrecondition: async (candidate) => {
          trace.push(`read:${candidate.uid}`);
          return satisfied(candidate);
        },
        mutationAdapter: {
          execute: async ({ attempt }) => {
            trace.push(`MOVE:${attempt.target.uid}`);
            throw new Error("crash after MOVE dispatch");
          },
        },
        uncertainObserver: { read: async () => { throw new Error("owner crashed before reconciliation"); } },
      }),
    });
    expect(first.outcomes[0]).toMatchObject({ planId: "plan:restart", kind: "failed" });
    const resumed = await recoverExecutingActionPlans({
      database,
      ownerLeases: ownerLeases(),
      now,
      freshNow: () => now,
      targetLoopOptions: () => ({
        readPrecondition: async () => { throw new Error("reconciled target must not reread precondition"); },
        mutationAdapter: { execute: async () => { throw new Error("resend MOVE is forbidden"); } },
        uncertainObserver: { read: async ({ attempt, resultAt: observationAt }) => success(attempt, observationAt) },
      }),
    });
    expect(resumed.outcomes[0]).toMatchObject({ planId: "plan:restart", kind: "recovered" });
    expect(trace).toEqual(["read:7", "MOVE:7"]);
    expect(database.query("SELECT result_kind, certainty FROM action_results;").get()).toEqual({ result_kind: "success", certainty: "definite" });
  });

  test("file-backed child crash/restart matrix converges to the uninterrupted oracle", async () => {
    const root = await mkdtemp(join(process.cwd(), ".agent-mail-p5-c17-"));
    try {
      const oracleFixture = await createCrashFixture(root, "oracle");
      expect(await runCrashChild(oracleFixture, "none")).toBe(0);
      const oracleSnapshot = durableSnapshot(oracleFixture.databasePath);
      const oracleTrace = await traceLines(oracleFixture.tracePath);
      expect(oracleTrace).toEqual([{ command: "MOVE", uid: 7 }]);

      const cases: readonly CrashCutPoint[] = [
        "before-dispatch",
        "after-dispatch-before-effect",
        "after-effect-before-result",
        "after-result-commit",
        "before-finalization",
      ];
      const expected: Readonly<Record<CrashCutPoint, Readonly<{
        readonly trace: "oracle" | "empty";
        readonly planState: "completed" | "uncertain";
      }>>> = {
        "before-dispatch": { trace: "oracle", planState: "completed" },
        "after-dispatch-before-effect": { trace: "empty", planState: "uncertain" },
        "after-effect-before-result": { trace: "oracle", planState: "completed" },
        "after-result-commit": { trace: "oracle", planState: "completed" },
        "before-finalization": { trace: "oracle", planState: "completed" },
      };
      for (const cutPoint of cases) {
        const fixture = await createCrashFixture(root, cutPoint);
        expect(await runCrashChild(fixture, cutPoint)).toBe(86);
        expect(await runCrashChild(fixture, "none")).toBe(0);
        const snapshot = durableSnapshot(fixture.databasePath);
        expect(snapshot.plan).toMatchObject({ state: expected[cutPoint].planState });
        const trace = await traceLines(fixture.tracePath);
        if (expected[cutPoint].trace === "empty") {
          // The marker is uncertainty evidence, not proof that MOVE happened.
          expect(snapshot.results).toMatchObject([{ result_kind: "uncertain", certainty: "uncertain", uncertain_reason: "local-result-not-durable" }]);
          expect(trace).toEqual([]);
        } else {
          expect(snapshot).toEqual(oracleSnapshot);
          expect(trace).toEqual(oracleTrace);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a child owner that exits is stale and can be reclaimed", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".agent-mail-lease-"));
    const modulePath = new URL("../src/action-plan-restart-recovery.ts", import.meta.url).href;
    const script = `import { createFileActionPlanOwnerLeaseStore } from ${JSON.stringify(modulePath)}; const store = createFileActionPlanOwnerLeaseStore({ directory: ${JSON.stringify(directory)} }); const result = await store.acquire({ planId: "plan:child", claimId: "claim:child" }); process.stdout.write(JSON.stringify(result));`;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(JSON.parse(output)).toMatchObject({ kind: "acquired", lease: { planId: "plan:child" } });
    const store = createFileActionPlanOwnerLeaseStore({ directory });
    expect(await store.acquire({ planId: "plan:child", claimId: "claim:child" })).toMatchObject({ kind: "acquired" });
    await rm(directory, { recursive: true, force: true });
  });
});
