import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRemoteAttemptUncertain,
  createRemoteAttemptSuccess,
  type RemoteAttempt,
  type RemoteAttemptResult,
} from "@agent-mail/core";
import { applyMigrations } from "../../storage/src/migration-runner";
import { actionAttemptDispatchMigrations } from "../../storage/src/migrations/0005-action-attempt-dispatch";
import { actionResultReconciliationMigration } from "../../storage/src/migrations/0007-action-result-reconciliation";
import { threadGraphMigration } from "../../storage/src/migrations/0008-thread-graph";
import { actionApprovalAuthorityMigration } from "../../storage/src/migrations/0009-action-approval-authority";
import { actionPlanRestoreQuarantineMigration } from "../../storage/src/migrations/0010-action-plan-restore-quarantine";
import { sealKeyAdministrationMigration } from "../../storage/src/migrations/0011-seal-key-administration";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import { createPendingActionPlan } from "../../storage/src/action-plan-repository";
import {
  authorityPreviewDigestForPlan,
  consumeActionApproval,
  createApprovalSealKeyring,
  issueActionApproval,
  issueOperatorPresenceChallenge,
  recordTrustedActionPlanCreator,
} from "../../storage/src/action-approval-authority";
import { startActionPlanAttempt } from "../../storage/src/action-plan-attempt";
import { markActionPlanAttemptDispatched } from "../../storage/src/action-plan-recovery";
import {
  recordActionPlanReconciliationResult,
  recordDefiniteActionPlanResult,
} from "../../storage/src/action-plan-result";
import { registerTrustedAuthorityContext } from "../../storage/src/trusted-authority-context";
import {
  createConsumedActionPlanExecutor,
  createActionApprovalServices,
} from "../src/action-approval-service";
import {
  createFileActionPlanOwnerLeaseStore,
  recoverExecutingActionPlans,
} from "../src/action-plan-restart-recovery";
import type { ActionPlanServiceContext } from "../src/action-plan-handlers";
import type { PreconditionObservation } from "../../imap/src/precondition";

const now = "2026-08-18T00:00:02.000Z";
const digest = "a".repeat(64);
const signature = Buffer.concat([Buffer.alloc(31), Buffer.from([1]), Buffer.alloc(31), Buffer.from([1])]);
const signatureBase64url = signature.toString("base64url");
const signatureSha256 = createHash("sha256").update(signature).digest("hex");
const authorityInstanceId = "instance:00000000-0000-4000-8000-000000000001";

const databases: Database[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function commitment(challengeId: string, nonce: string, operation: "approve"): string {
  return JSON.stringify([
    "agent-mail-operator-challenge-v1",
    authorityInstanceId,
    challengeId,
    nonce,
    "credential:operator",
    "principal:local-operator",
    "operator-interactive",
    operation,
    "POST",
    "/v1/action-plans/plan%3Aexecutor/approvals",
    "b".repeat(64),
    "0000-0000-0000-0000-0000",
    1,
    "2026-08-18T00:00:01.000Z",
    "2026-08-18T00:01:01.000Z",
  ]);
}

function setup(): Readonly<{
  database: Database;
  receipt: ReturnType<typeof consumeActionApproval>;
  keyring: ReturnType<typeof createApprovalSealKeyring>;
  agent: ActionPlanServiceContext;
}> {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(database, [
    ...actionAttemptDispatchMigrations,
    { version: 6, name: "test-action-chain-placeholder", sql: "SELECT 1;" },
    actionResultReconciliationMigration,
    threadGraphMigration,
    actionApprovalAuthorityMigration,
    actionPlanRestoreQuarantineMigration,
    sealKeyAdministrationMigration,
  ]);
  database.exec(operationalJournalMigration.sql);
  const plan = createPendingActionPlan(database, {
    planId: "plan:executor",
    action: { kind: "markSeen" },
    targets: [{ accountId: "account:one", mailboxId: "mailbox:inbox", uidValidity: 1, uid: 2, precondition: { modseq: 7 } }],
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-18T01:00:00.000Z",
    previewDigest: digest,
    authorizationScope: "mail:action.commit",
    idempotencyIdentity: "executor-test",
  });
  const operator = registerTrustedAuthorityContext({
    principalId: "principal:local-operator",
    credentialId: "credential:operator",
    profile: "operator-interactive" as const,
    scopes: ["mail:action.approve"],
    authEventId: "auth-event:operator",
    authenticatedAt: "2026-08-18T00:00:01.000Z",
    credentialExpiresAt: "2027-08-18T00:00:01.000Z",
    presence: {
      kind: "human-present" as const,
      ceremonyId: "operator-challenge:executor",
      verifiedAt: "2026-08-18T00:00:01.000Z",
      validUntil: "2026-08-18T00:01:01.000Z",
      requestMethod: "POST" as const,
      requestPath: "/v1/action-plans/plan%3Aexecutor/approvals",
      requestBodySha256: "b".repeat(64),
      challengeCommitmentSha256: createHash("sha256").update(commitment("operator-challenge:executor", Buffer.alloc(32, 1).toString("base64url"), "approve")).digest("hex"),
      assertionSignatureSha256: signatureSha256,
      assertionSignatureP1363Base64url: signatureBase64url,
      displayCode: "0000-0000-0000-0000-0000",
      authorityInstanceId,
      operatorConfigurationRevision: 1,
    },
  });
  recordTrustedActionPlanCreator(database, { ...operator, planId: plan.planId, createdAt: plan.createdAt });
  const nonce = Buffer.alloc(32, 1).toString("base64url");
  issueOperatorPresenceChallenge(database, {
    challengeId: operator.presence.ceremonyId,
    authorityInstanceId,
    operatorConfigurationRevision: 1,
    challengeNonceBase64url: nonce,
    credentialId: operator.credentialId,
    operation: "approve",
    requestMethod: "POST",
    requestPath: "/v1/action-plans/plan%3Aexecutor/approvals",
    requestBodySha256: "b".repeat(64),
    operatorDisplayCode: "0000-0000-0000-0000-0000",
    challengeCommitment: commitment(operator.presence.ceremonyId, nonce, "approve"),
    issuedAt: "2026-08-18T00:00:01.000Z",
    expiresAt: "2026-08-18T00:01:01.000Z",
  });
  const keyring = createApprovalSealKeyring({ keyId: "approval-seal-key:one", keyHex: "1".repeat(64) });
  const approval = issueActionApproval(database, {
    request: { planId: plan.planId, planVersion: 1, previewDigest: authorityPreviewDigestForPlan(database, plan.planId) },
    context: operator,
    now: "2026-08-18T00:00:01.000Z",
    keyring,
  });
  const agent = registerTrustedAuthorityContext({
    principalId: "principal:agent",
    credentialId: "credential:agent",
    profile: "agent-unattended" as const,
    scopes: ["mail:action.commit"],
    authEventId: "auth-event:agent",
    authenticatedAt: now,
    credentialExpiresAt: "2027-08-18T00:00:02.000Z",
    presence: { kind: "unattended" as const },
  });
  const receipt = consumeActionApproval(database, {
    request: { planId: plan.planId, planVersion: 1, previewDigest: approval.approval.previewDigest, approvalId: approval.approval.approvalId },
    context: agent,
    now,
    keyring,
  });
  return {
    database,
    receipt,
    keyring,
    agent: {
      correlationId: "correlation:executor",
      operationKey: "action-plans.commit",
      scope: "mail:action.commit",
      principal: { subject: agent.principalId, scopes: agent.scopes },
      authContext: agent,
    },
  };
}

function success(attempt: RemoteAttempt, resultAt = "2026-08-18T00:00:03.000Z"): RemoteAttemptResult {
  return createRemoteAttemptSuccess({
    kind: "success",
    planId: attempt.planId,
    action: attempt.action,
    target: attempt.target,
    attemptId: attempt.attemptId,
    idempotencyKey: attempt.idempotencyKey,
    startedAt: attempt.startedAt,
    resultAt,
    certainty: "definite",
    postcondition: {
      kind: "flags",
      observedAt: resultAt,
      flags: ["\\Seen"],
      modseq: attempt.target.precondition.modseq + 1,
    },
  });
}

describe("consumed action-plan executor composition", () => {
  test("consumes, attributes, executes once, and finalizes the real result", async () => {
    const { database, receipt, agent } = setup();
    const root = await mkdtemp(join(tmpdir(), "agent-mail-executor-"));
    roots.push(root);
    const ownerLeases = createFileActionPlanOwnerLeaseStore({ directory: join(root, "leases") });
    let remoteCalls = 0;
    const executor = createConsumedActionPlanExecutor({
      database,
      ownerLeases,
      executorInstanceId: "executor:test",
      now,
      freshNow: () => now,
      targetLoopOptions: () => ({
        mutationAdapter: { execute: async () => { remoteCalls += 1; return {}; } },
        readPrecondition: async (target): Promise<PreconditionObservation> => ({
          kind: "satisfied",
          target,
          observed: { uidValidity: target.uidValidity, uid: target.uid, modseq: target.precondition.modseq },
        }),
        uncertainObserver: { read: async ({ attempt, resultAt }) => success(attempt, resultAt) },
        normalizeMutationResult: ({ attempt, resultAt }) => success(attempt, resultAt),
      }),
    });
    const result = await executor(receipt, agent);
    expect(remoteCalls).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(database.query("SELECT state FROM action_plans WHERE plan_id = ?;").get(receipt.planId)).toEqual({ state: "completed" });
    expect(database.query("SELECT receipt_id, executor_instance_id FROM action_attempt_authorities WHERE attempt_id = ?;").get(`attempt:${receipt.planId}:1`)).toEqual({ receipt_id: receipt.receiptId, executor_instance_id: "executor:test" });
    expect(database.query("SELECT terminal_state, receipt_id, executor_instance_id FROM action_plan_terminal_audit WHERE plan_id = ?;").get(receipt.planId)).toEqual({ terminal_state: "completed", receipt_id: receipt.receiptId, executor_instance_id: "executor:test" });
  });

  test("post-result recovery finalizes without constructing an effect loop", async () => {
    const { database, receipt } = setup();
    const started = startActionPlanAttempt(database, {
      planId: receipt.planId,
      claimId: receipt.claimId,
      targetOrdinal: 1,
      attemptId: `attempt:${receipt.planId}:1`,
      idempotencyKey: `action:${receipt.planId}:1`,
      startedAt: "2026-08-18T00:00:03.000Z",
      now: "2026-08-18T00:00:03.000Z",
      executorInstanceId: "executor:effect-a",
    });
    if (started.kind !== "started") throw new Error("recovery attempt did not start");
    expect(
      recordDefiniteActionPlanResult(database, { result: success(started.attempt) }),
    ).toMatchObject({ kind: "recorded" });
    const root = await mkdtemp(join(tmpdir(), "agent-mail-recovery-finalizer-"));
    roots.push(root);
    let targetLoopCalls = 0;
    const recovery = await recoverExecutingActionPlans({
      database,
      ownerLeases: createFileActionPlanOwnerLeaseStore({ directory: join(root, "leases") }),
      now: "2026-08-18T00:00:04.000Z",
      freshNow: () => "2026-08-18T00:00:04.000Z",
      finalizerInstanceId: "recovery-finalizer:process-b",
      targetLoopOptions: () => {
        targetLoopCalls += 1;
        throw new Error("post-result recovery must not construct an effect loop");
      },
    });
    expect(recovery.outcomes).toMatchObject([
      { planId: receipt.planId, kind: "recovered", finalized: { state: "completed" } },
    ]);
    expect(targetLoopCalls).toBe(0);
    expect(
      database
        .query(
          "SELECT effect_attempt_count, executor_instance_id, finalizer_kind, finalizer_instance_id FROM action_plan_terminal_audit WHERE plan_id = ?;",
        )
        .get(receipt.planId),
    ).toEqual({
      effect_attempt_count: 1,
      executor_instance_id: "executor:effect-a",
      finalizer_kind: "ordinary-recovery",
      finalizer_instance_id: "recovery-finalizer:process-b",
    });
  });

  test("attributed interrupted recovery reopens the effect boundary under its executor", async () => {
    const { database, receipt } = setup();
    const started = startActionPlanAttempt(database, {
      planId: receipt.planId,
      claimId: receipt.claimId,
      targetOrdinal: 1,
      attemptId: `attempt:${receipt.planId}:1`,
      idempotencyKey: `action:${receipt.planId}:1`,
      startedAt: "2026-08-18T00:00:03.000Z",
      now: "2026-08-18T00:00:03.000Z",
      executorInstanceId: "executor:effect-a",
    });
    if (started.kind !== "started") throw new Error("recovery attempt did not start");
    expect(database.query("SELECT COUNT(*) AS count FROM action_results WHERE plan_id = ?;").get(receipt.planId)).toEqual({ count: 0 });
    const root = await mkdtemp(join(tmpdir(), "agent-mail-incomplete-recovery-"));
    roots.push(root);
    let targetLoopCalls = 0;
    let remoteCalls = 0;
    const recovery = await recoverExecutingActionPlans({
      database,
      ownerLeases: createFileActionPlanOwnerLeaseStore({ directory: join(root, "leases") }),
      now: "2026-08-18T00:00:04.000Z",
      freshNow: () => "2026-08-18T00:00:04.000Z",
      executorInstanceId: "executor:effect-a",
      targetLoopOptions: () => {
        targetLoopCalls += 1;
        return {
          readPrecondition: async (target): Promise<PreconditionObservation> => ({
            kind: "satisfied",
            target,
            observed: { uidValidity: target.uidValidity, uid: target.uid, modseq: target.precondition.modseq },
          }),
          mutationAdapter: {
            execute: async () => {
              remoteCalls += 1;
              return {};
            },
          },
          uncertainObserver: { read: async ({ attempt, resultAt }) => success(attempt, resultAt) },
          normalizeMutationResult: ({ attempt, resultAt }) => success(attempt, resultAt),
        };
      },
    });
    expect(recovery.outcomes).toMatchObject([
      { planId: receipt.planId, kind: "recovered", finalized: { state: "completed" } },
    ]);
    expect(targetLoopCalls).toBe(1);
    expect(remoteCalls).toBe(1);
    expect(
      database
        .query("SELECT executor_instance_id, finalizer_kind, finalizer_instance_id FROM action_plan_terminal_audit WHERE plan_id = ?;")
        .get(receipt.planId),
    ).toEqual({
      executor_instance_id: "executor:effect-a",
      finalizer_kind: "effect-executor",
      finalizer_instance_id: "executor:effect-a",
    });
  });

  test("all-target durable uncertain recovery finalizes without an effect loop", async () => {
    const { database, receipt } = setup();
    const started = startActionPlanAttempt(database, {
      planId: receipt.planId,
      claimId: receipt.claimId,
      targetOrdinal: 1,
      attemptId: `attempt:${receipt.planId}:1`,
      idempotencyKey: `action:${receipt.planId}:1`,
      startedAt: "2026-08-18T00:00:03.000Z",
      now: "2026-08-18T00:00:03.000Z",
      executorInstanceId: "executor:effect-a",
    });
    if (started.kind !== "started") throw new Error("recovery attempt did not start");
    const marked = markActionPlanAttemptDispatched(database, {
      attemptId: started.attempt.attemptId,
      planId: receipt.planId,
      claimId: receipt.claimId,
      expectedVersion: 2,
      dispatchedAt: "2026-08-18T00:00:03.500Z",
      observation: {
        kind: "satisfied",
        target: started.attempt.target,
        observed: {
          uidValidity: started.attempt.target.uidValidity,
          uid: started.attempt.target.uid,
          modseq: started.attempt.target.precondition.modseq,
        },
      },
    });
    expect(marked.kind).toBe("marked");
    const uncertain = createRemoteAttemptUncertain({
      kind: "uncertain",
      planId: started.attempt.planId,
      action: started.attempt.action,
      target: started.attempt.target,
      attemptId: started.attempt.attemptId,
      idempotencyKey: started.attempt.idempotencyKey,
      startedAt: started.attempt.startedAt,
      resultAt: "2026-08-18T00:00:03.750Z",
      certainty: "uncertain",
      uncertainReason: "connection-lost-after-transmission",
      detail: "remote postcondition remains unconfirmed",
    });
    expect(recordActionPlanReconciliationResult(database, { result: uncertain })).toMatchObject({ kind: "recorded" });
    const root = await mkdtemp(join(tmpdir(), "agent-mail-uncertain-recovery-"));
    roots.push(root);
    let targetLoopCalls = 0;
    const recovery = await recoverExecutingActionPlans({
      database,
      ownerLeases: createFileActionPlanOwnerLeaseStore({ directory: join(root, "leases") }),
      now: "2026-08-18T00:00:04.000Z",
      freshNow: () => "2026-08-18T00:00:04.000Z",
      finalizerInstanceId: "recovery-finalizer:process-b",
      targetLoopOptions: () => {
        targetLoopCalls += 1;
        throw new Error("uncertain post-result recovery must not construct an effect loop");
      },
    });
    expect(recovery.outcomes).toMatchObject([
      { planId: receipt.planId, kind: "recovered", finalized: { state: "uncertain" } },
    ]);
    expect(targetLoopCalls).toBe(0);
    expect(
      database
        .query("SELECT terminal_state, executor_instance_id, finalizer_kind, finalizer_instance_id FROM action_plan_terminal_audit WHERE plan_id = ?;")
        .get(receipt.planId),
    ).toEqual({
      terminal_state: "uncertain",
      executor_instance_id: "executor:effect-a",
      finalizer_kind: "ordinary-recovery",
      finalizer_instance_id: "recovery-finalizer:process-b",
    });
  });

  test("incomplete trusted recovery receives an executor identity and finalizes as the effect executor", async () => {
    const { database, receipt } = setup();
    const root = await mkdtemp(join(tmpdir(), "agent-mail-effect-recovery-"));
    roots.push(root);
    let remoteCalls = 0;
    const recovery = await recoverExecutingActionPlans({
      database,
      ownerLeases: createFileActionPlanOwnerLeaseStore({ directory: join(root, "leases") }),
      now: "2026-08-18T00:00:03.000Z",
      freshNow: () => "2026-08-18T00:00:03.000Z",
      executorInstanceId: "executor:recovery-b",
      targetLoopOptions: () => ({
        readPrecondition: async (target): Promise<PreconditionObservation> => ({
          kind: "satisfied",
          target,
          observed: { uidValidity: target.uidValidity, uid: target.uid, modseq: target.precondition.modseq },
        }),
        mutationAdapter: {
          execute: async ({ attempt }) => {
            remoteCalls += 1;
            return {};
          },
        },
        uncertainObserver: { read: async ({ attempt, resultAt }) => success(attempt, resultAt) },
        normalizeMutationResult: ({ attempt, resultAt }) => success(attempt, resultAt),
      }),
    });
    expect(recovery.outcomes).toMatchObject([
      { planId: receipt.planId, kind: "recovered", finalized: { state: "completed" } },
    ]);
    expect(remoteCalls).toBe(1);
    expect(
      database
        .query("SELECT executor_instance_id, finalizer_kind, finalizer_instance_id FROM action_plan_terminal_audit WHERE plan_id = ?;")
        .get(receipt.planId),
    ).toEqual({
      executor_instance_id: "executor:recovery-b",
      finalizer_kind: "effect-executor",
      finalizer_instance_id: "executor:recovery-b",
    });
  });

  test("reloads the seal keyring inside each shared authority admission", async () => {
    const { database, receipt, keyring, agent } = setup();
    let loads = 0;
    const services = createActionApprovalServices({
      database,
      loadKeyring: async () => {
        loads += 1;
        return keyring;
      },
      loadAuthority: async () => ({
        authorityInstanceId,
        configurationRevision: 1,
        activeCredentialIds: ["credential:operator"],
      }),
      authorityLock: {
        runShared: async (operation) => operation(),
        runExclusive: async (operation) => operation(),
      },
      executeConsumedPlan: async () => {
        throw new Error("execution must not follow a consumed receipt");
      },
    });
    await expect(
      services.authorityCommitPlan(
        {
          planId: receipt.planId,
          planVersion: 1,
          previewDigest: "a".repeat(64),
          approvalId: receipt.approvalId,
        },
        agent,
      ),
    ).rejects.toMatchObject({ code: "action.approval_consumed" });
    expect(loads).toBe(1);
  });
});
