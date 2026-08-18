import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createClaimId,
  createExecutingActionPlan,
  createMonotonicSequence,
  createRemoteAttempt,
  createRemoteUidValue,
  createUidValidity,
  type RemoteAttempt,
} from "@agent-mail/core";
import { executeRemoteAttempt } from "../../imap/src/remote-executor";
import type { PreconditionObservation } from "../../imap/src/precondition";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { claimPendingActionPlan } from "../src/action-plan-claim";
import { startActionPlanAttempt } from "../src/action-plan-attempt";
import {
  actionAttemptDispatchMigrations,
  markActionPlanAttemptDispatched,
  recoverUnresolvedActionPlanAttempt,
} from "../src/action-plan-recovery";
import { createPendingActionPlan } from "../src/action-plan-repository";
import { recordDefiniteActionPlanResult, readActionPlanResult } from "../src/action-plan-result";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";

const databases: Database[] = [];
const target = {
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 9,
  uid: 7,
  precondition: { modseq: 101 },
} as const;
const startedAt = "2026-08-18T01:00:02.000Z";
const markerAt = "2026-08-18T01:00:02.500Z";
const recoveredAt = "2026-08-18T01:00:04.000Z";
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const migrations: readonly Migration[] = [
  ...actionAttemptDispatchMigrations,
  { ...operationalJournalMigration, version: 6 },
];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  applyMigrations(database, migrations);
  createPendingActionPlan(database, {
    planId: "plan:one",
    action: { kind: "markSeen" },
    targets: [target],
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
    previewDigest: digest,
    authorizationScope: "mail:action.create",
    idempotencyIdentity: "caller:one",
  });
  expect(
    claimPendingActionPlan(database, {
      planId: "plan:one",
      claimId: "claim:one",
      startedAt: "2026-08-18T01:00:01.000Z",
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
      now: "2026-08-18T01:00:01.000Z",
    }),
  ).toMatchObject({ kind: "started" });
  return database;
}

function executorInputs(database: Database, marker: (database: Database, observation: PreconditionObservation) => Promise<void>) {
  const attempt: RemoteAttempt = createRemoteAttempt({
    kind: "attempt",
    planId: "plan:one",
    action: { kind: "markSeen" },
    target,
    attemptId: "attempt:one",
    idempotencyKey: "idempotency:one",
    startedAt,
    certainty: "unresolved",
  });
  const claimedPlan = createExecutingActionPlan({
    state: "executing",
    planId: "plan:one",
    action: { kind: "markSeen" },
    targets: [target],
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
    claimId: "claim:one",
    startedAt: "2026-08-18T01:00:01.000Z",
  });
  const observation: PreconditionObservation = {
    kind: "satisfied",
    target,
    observed: {
      uidValidity: createUidValidity(9),
      uid: createRemoteUidValue(7),
      modseq: createMonotonicSequence(101),
    },
  };
  return {
    claimedPlan,
    durableAttempt: { claimId: createClaimId("claim:one"), attempt },
    readPrecondition: async () => observation,
    finalizeStale: async () => "not-used",
    markDispatched: async ({ observation: satisfied }: { readonly observation: PreconditionObservation }) => {
      await marker(database, satisfied);
    },
  };
}

async function durableMarker(database: Database, observation: PreconditionObservation): Promise<void> {
  if (observation.kind !== "satisfied") throw new Error("expected satisfied observation");
  const result = markActionPlanAttemptDispatched(database, {
    attemptId: "attempt:one",
    planId: "plan:one",
    claimId: "claim:one",
    expectedVersion: 2,
    dispatchedAt: markerAt,
    observation,
  });
  if (result.kind !== "marked") throw new Error(`dispatch marker failed: ${result.reason}`);
}

function successResult(resultAt: string) {
  return {
    planId: "plan:one",
    action: { kind: "markSeen" },
    target,
    attemptId: "attempt:one",
    idempotencyKey: "idempotency:one",
    startedAt,
    resultAt,
    kind: "success",
    certainty: "definite",
    postcondition: {
      kind: "flags",
      observedAt: resultAt,
      flags: ["\\Seen"],
      modseq: 102,
    },
  };
}

describe("executor dispatch/recovery matrix P5-C13", () => {
  test("pre-marker stale path never calls marker or adapter", async () => {
    const database = openDatabase();
    let markerCalls = 0;
    let adapterCalls = 0;
    const input = executorInputs(database, async () => {
      markerCalls += 1;
    });
    const stale: PreconditionObservation = {
      kind: "stale",
      target,
      observed: { uidValidity: createUidValidity(9), uid: createRemoteUidValue(7), modseq: createMonotonicSequence(102) },
      reason: "newer-modseq",
    };
    const result = await executeRemoteAttempt({
      ...input,
      readPrecondition: async () => stale,
      mutationAdapter: { execute: async () => { adapterCalls += 1; return "must-not-run"; } },
    });
    expect(result.kind).toBe("stale");
    expect(markerCalls).toBe(0);
    expect(adapterCalls).toBe(0);
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempt_dispatches;").get()).toEqual({ count: 0 });
  });

  test("marker failure prevents adapter call and recovery remains not-dispatched", async () => {
    const database = openDatabase();
    let adapterCalls = 0;
    const input = executorInputs(database, async () => {
      throw new Error("injected marker failure");
    });
    await expect(
      executeRemoteAttempt({
        ...input,
        mutationAdapter: { execute: async () => { adapterCalls += 1; return "must-not-run"; } },
      }),
    ).rejects.toThrow("injected marker failure");
    expect(adapterCalls).toBe(0);
    expect(recoverUnresolvedActionPlanAttempt(database, { attemptId: "attempt:one", recoveredAt })).toEqual({
      kind: "not-dispatched",
      attemptId: "attempt:one",
    });
  });

  test("marker commit followed by pre-send crash reopens uncertain", async () => {
    const database = openDatabase();
    const input = executorInputs(database, async (opened, observation) => {
      await durableMarker(opened, observation);
      throw new Error("crash after dispatch marker");
    });
    let adapterCalls = 0;
    await expect(
      executeRemoteAttempt({ ...input, mutationAdapter: { execute: async () => { adapterCalls += 1; return "must-not-run"; } } }),
    ).rejects.toThrow("crash after dispatch marker");
    expect(adapterCalls).toBe(0);
    const recovered = recoverUnresolvedActionPlanAttempt(database, { attemptId: "attempt:one", recoveredAt });
    expect(recovered.kind).toBe("uncertain");
  });

  test("marker transaction rejects an expired final instant and converges duplicate admission", async () => {
    const database = openDatabase();
    const observation: PreconditionObservation = {
      kind: "satisfied",
      target,
      observed: {
        uidValidity: createUidValidity(9),
        uid: createRemoteUidValue(7),
        modseq: createMonotonicSequence(101),
      },
    };
    const expired = markActionPlanAttemptDispatched(database, {
      attemptId: "attempt:one",
      planId: "plan:one",
      claimId: "claim:one",
      expectedVersion: 2,
      dispatchedAt: "2026-08-19T00:00:00.000Z",
      observation,
    });
    expect(expired).toEqual({
      kind: "expired",
      attemptId: "attempt:one",
      dispatchedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempt_dispatches;").get()).toEqual({ count: 0 });

    const admitted = markActionPlanAttemptDispatched(database, {
      attemptId: "attempt:one",
      planId: "plan:one",
      claimId: "claim:one",
      expectedVersion: 2,
      dispatchedAt: markerAt,
      observation,
    });
    expect(admitted).toMatchObject({ kind: "marked", attemptId: "attempt:one" });
    const duplicate = markActionPlanAttemptDispatched(database, {
      attemptId: "attempt:one",
      planId: "plan:one",
      claimId: "claim:one",
      expectedVersion: 2,
      dispatchedAt: markerAt,
      observation,
    });
    expect(duplicate).toMatchObject({ kind: "dispatched", attemptId: "attempt:one" });
    expect(database.query("SELECT COUNT(*) AS count FROM action_attempt_dispatches;").get()).toEqual({ count: 1 });
  });

  test("adapter ambiguity and result-write failure both recover uncertain", async () => {
    const database = openDatabase();
    const input = executorInputs(database, durableMarker);
    await expect(
      executeRemoteAttempt({ ...input, mutationAdapter: { execute: async () => { throw new Error("socket ambiguity"); } } }),
    ).rejects.toThrow("socket ambiguity");
    expect(recoverUnresolvedActionPlanAttempt(database, { attemptId: "attempt:one", recoveredAt })).toMatchObject({ kind: "uncertain" });
  });

  test("successful definite result supersedes dispatch marker and recovery is idempotent", async () => {
    const database = openDatabase();
    const input = executorInputs(database, durableMarker);
    const execution = await executeRemoteAttempt({
      ...input,
      mutationAdapter: { execute: async () => successResult(markerAt) },
    });
    expect(execution.kind).toBe("executed");
    if (execution.kind !== "executed") throw new Error("expected executed result");
    expect(recordDefiniteActionPlanResult(database, { result: execution.result })).toMatchObject({ kind: "recorded" });
    const recovered = recoverUnresolvedActionPlanAttempt(database, { attemptId: "attempt:one", recoveredAt });
    expect(recovered.kind).toBe("already-resolved");
    expect(readActionPlanResult(database, "attempt:one")).toMatchObject({ kind: "success", certainty: "definite" });
  });

  test("caught result-write failure cannot become retryable definite failure", async () => {
    const database = openDatabase();
    const input = executorInputs(database, durableMarker);
    const execution = await executeRemoteAttempt({
      ...input,
      mutationAdapter: { execute: async () => successResult(markerAt) },
    });
    if (execution.kind !== "executed") throw new Error("expected executed result");
    database.exec(`CREATE TRIGGER reject_result_write BEFORE INSERT ON action_results BEGIN SELECT RAISE(ABORT, 'injected result write'); END;`);
    expect(() => recordDefiniteActionPlanResult(database, { result: execution.result })).toThrow();
    database.exec("DROP TRIGGER reject_result_write;");
    const recovered = recoverUnresolvedActionPlanAttempt(database, { attemptId: "attempt:one", recoveredAt });
    expect(recovered).toMatchObject({ kind: "uncertain", result: { uncertainReason: "local-result-not-durable" } });
  });
});
