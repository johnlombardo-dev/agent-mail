import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createRemoteAttemptSuccess } from "@agent-mail/core";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { actionApprovalAuthorityMigration } from "../src/migrations/0009-action-approval-authority";
import { actionPlanRestoreQuarantineMigration } from "../src/migrations/0010-action-plan-restore-quarantine";
import { sealKeyAdministrationMigration } from "../src/migrations/0011-seal-key-administration";
import { actionAttemptDispatchSequence } from "../src/migrations/0005-action-attempt-dispatch";
import { actionResultReconciliationMigration } from "../src/migrations/0007-action-result-reconciliation";
import { threadGraphMigration } from "../src/migrations/0008-thread-graph";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { createPendingActionPlan } from "../src/action-plan-repository";
import {
  consumeActionApproval,
  cancelActionApproval,
  expireActionApproval,
  createApprovalSealKeyring,
  authorityPreviewDigestForPlan,
  invalidateAuthorityForConfigurationChange,
  invalidateApprovalsForMissingKeys,
  issueActionApproval,
  quarantineRestoredAuthority,
  recordTrustedActionPlanCreator,
  issueOperatorPresenceChallenge,
  readEffectAuthorityProjection,
  recordActionPlanTerminalAudit,
} from "../src/action-approval-authority";
import { discoverExecutingActionPlans } from "../src/action-plan-restart-recovery";
import { startActionPlanAttempt } from "../src/action-plan-attempt";
import {
  finalizeActionPlan,
  finalizeActionPlanAfterRecovery,
} from "../src/action-plan-finalization";
import { recordDefiniteActionPlanResult } from "../src/action-plan-result";
import { registerTrustedAuthorityContext } from "../src/trusted-authority-context";

const assertionSignatureBytes = Buffer.alloc(64);
assertionSignatureBytes[31] = 1;
assertionSignatureBytes[63] = 1;
const assertionSignatureP1363Base64url = assertionSignatureBytes.toString("base64url");
const assertionSignatureSha256 = createHash("sha256").update(assertionSignatureBytes).digest("hex");

const operator = registerTrustedAuthorityContext({
  principalId: "principal:local-operator",
  credentialId: "credential:operator",
  profile: "operator-interactive" as const,
  scopes: ["mail:action.approve"],
  authEventId: "auth-event:operator",
  authenticatedAt: "2026-08-18T00:00:01.000Z",
  credentialExpiresAt: "2027-08-18T00:00:01.000Z",
  presence: { kind: "human-present" as const, ceremonyId: "operator-challenge:one", verifiedAt: "2026-08-18T00:00:01.000Z", validUntil: "2026-08-18T00:01:01.000Z", requestMethod: "POST" as const, requestPath: "/v1/action-plans/plan%3Aauthority/approvals", requestBodySha256: "b".repeat(64), challengeCommitmentSha256: createHash("sha256").update("c".repeat(64)).digest("hex"), assertionSignatureSha256, assertionSignatureP1363Base64url, displayCode: "0000-0000-0000-0000-0000", authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001", operatorConfigurationRevision: 1 },
});
const agent = registerTrustedAuthorityContext({
  principalId: "principal:agent",
  credentialId: "credential:agent",
  profile: "agent-unattended" as const,
  scopes: ["mail:action.commit"],
  authEventId: "auth-event:agent",
  authenticatedAt: "2026-08-18T00:00:02.000Z",
  credentialExpiresAt: "2027-08-18T00:00:02.000Z",
  presence: { kind: "unattended" as const },
});
const keyring = createApprovalSealKeyring({ keyId: "approval-seal-key:one", keyHex: "1".repeat(64) });

function challengeCommitmentFor(input: Readonly<{
  readonly challengeId: string;
  readonly challengeNonceBase64url: string;
  readonly credentialId: string;
  readonly operation: "open-session" | "approve" | "cancel-approval";
  readonly requestMethod: "POST" | "DELETE";
  readonly requestPath: string;
  readonly requestBodySha256: string;
  readonly operatorDisplayCode: string;
  readonly authorityInstanceId: string;
  readonly operatorConfigurationRevision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}>): string {
  return JSON.stringify([
    "agent-mail-operator-challenge-v1",
    input.authorityInstanceId,
    input.challengeId,
    input.challengeNonceBase64url,
    input.credentialId,
    "principal:local-operator",
    "operator-interactive",
    input.operation,
    input.requestMethod,
    input.requestPath,
    input.requestBodySha256,
    input.operatorDisplayCode,
    input.operatorConfigurationRevision,
    input.issuedAt,
    input.expiresAt,
  ]);
}

function setup(
  targets: readonly Readonly<{
    readonly accountId: string;
    readonly mailboxId: string;
    readonly uidValidity: number;
    readonly uid: number;
    readonly precondition: Readonly<{ readonly modseq: number }>;
  }>[] = [
    { accountId: "account:one", mailboxId: "mailbox:inbox", uidValidity: 1, uid: 2, precondition: { modseq: 7 } },
  ],
): { readonly database: Database; readonly planId: string } {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  runMigrations(database, [
    ...actionAttemptDispatchSequence,
    { ...operationalJournalMigration, version: 6 },
    actionResultReconciliationMigration,
    threadGraphMigration,
    actionApprovalAuthorityMigration,
    actionPlanRestoreQuarantineMigration,
    sealKeyAdministrationMigration,
  ]);
  const plan = createPendingActionPlan(database, {
    planId: "plan:authority",
    action: { kind: "markSeen" },
    targets,
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-18T01:00:00.000Z",
    previewDigest: "a".repeat(64),
    authorizationScope: "mail:action.commit",
    idempotencyIdentity: "authority-plan",
  });
  recordTrustedActionPlanCreator(database, { ...operator, planId: plan.planId, createdAt: plan.createdAt });
  return { database, planId: plan.planId };
}

function approve(database: Database, planId: string) {
  const previewDigest = authorityPreviewDigestForPlan(database, planId);
  const challengeNonceBase64url = Buffer.alloc(32, 1).toString("base64url");
  const challengeInput = {
    challengeId: operator.presence.ceremonyId,
    authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
    operatorConfigurationRevision: 1,
    challengeNonceBase64url,
    credentialId: operator.credentialId,
    operation: "approve" as const,
    requestMethod: "POST" as const,
    requestPath: `/v1/action-plans/${encodeURIComponent(planId)}/approvals`,
    requestBodySha256: "b".repeat(64),
    operatorDisplayCode: "0000-0000-0000-0000-0000",
    issuedAt: "2026-08-18T00:00:01.000Z",
    expiresAt: "2026-08-18T00:01:01.000Z",
  };
  issueOperatorPresenceChallenge(database, {
    ...challengeInput,
    challengeCommitment: challengeCommitmentFor(challengeInput),
  });
  const verifiedOperator = registerTrustedAuthorityContext({
    ...operator,
    presence: {
      ...operator.presence,
      challengeCommitmentSha256: createHash("sha256")
        .update(challengeCommitmentFor(challengeInput))
        .digest("hex"),
    },
  });
  return issueActionApproval(database, {
    request: { planId, planVersion: 1, previewDigest },
    context: verifiedOperator,
    now: "2026-08-18T00:00:01.000Z",
    keyring,
  });
}

describe("durable one-use action approval authority", () => {
  it("upgrades an old file-backed v9 database to v11 and default-reopens after close", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-authority-migration-"));
    await chmod(root, 0o700);
    const path = join(root, "archive.sqlite");
    try {
      const first = new Database(path, { strict: true });
      first.exec("PRAGMA foreign_keys = ON;");
      runMigrations(first, [
        ...actionAttemptDispatchSequence,
        { ...operationalJournalMigration, version: 6 },
        actionResultReconciliationMigration,
        threadGraphMigration,
        actionApprovalAuthorityMigration,
      ]);
      expect(first.query("PRAGMA user_version;").get()).toEqual({ user_version: 9 });
      const migrationChallengeId = "operator-challenge:00000000-0000-4000-8000-000000000051";
      const migrationNonce = Buffer.alloc(32, 5).toString("base64url");
      const migrationIssuedAt = "2026-08-18T00:00:00.000Z";
      const migrationExpiresAt = "2026-08-18T00:01:00.000Z";
      const migrationCommitment = JSON.stringify([
        "agent-mail-operator-challenge-v1",
        "instance:00000000-0000-4000-8000-000000000001",
        migrationChallengeId,
        migrationNonce,
        "credential:operator",
        "principal:local-operator",
        "operator-interactive",
        "approve",
        "POST",
        "/v1/action-plans/plan%3Aauthority/approvals",
        "a".repeat(64),
        "0000-0000-0000-0000-000000000000".replace("000000000000", "0000"),
        1,
        migrationIssuedAt,
        migrationExpiresAt,
      ]);
      first
        .query(
          "INSERT INTO operator_presence_challenges (challenge_id, authority_instance_id, operator_configuration_revision, challenge_nonce_base64url, credential_id, principal_id, profile, operation, request_method, request_path, request_body_sha256, operator_display_code, challenge_commitment, challenge_commitment_sha256, issued_at, expires_at) VALUES (?, ?, 1, ?, ?, 'principal:local-operator', 'operator-interactive', 'approve', 'POST', ?, ?, '0000-0000-0000-0000-0000', ?, ?, ?, ?);",
        )
        .run(
          migrationChallengeId,
          "instance:00000000-0000-4000-8000-000000000001",
          migrationNonce,
          "credential:operator",
          "/v1/action-plans/plan%3Aauthority/approvals",
          "a".repeat(64),
          migrationCommitment,
          "a".repeat(64),
          migrationIssuedAt,
          migrationExpiresAt,
        );
      first
        .query(
          "INSERT INTO operator_presence_challenge_expirations (challenge_id, expired_at) VALUES (?, ?);",
        )
        .run(migrationChallengeId, migrationExpiresAt);
      first.close();
      const reopened = new Database(path, { strict: true });
      reopened.exec("PRAGMA foreign_keys = ON;");
      runMigrations(reopened, [
        ...actionAttemptDispatchSequence,
        { ...operationalJournalMigration, version: 6 },
        actionResultReconciliationMigration,
        threadGraphMigration,
        actionApprovalAuthorityMigration,
        actionPlanRestoreQuarantineMigration,
      ]);
      expect(reopened.query("PRAGMA user_version;").get()).toEqual({ user_version: 10 });
      expect(reopened.query("PRAGMA table_info(action_plans);").all().some((row) => row.name === "state")).toBe(true);
      reopened.close();
      const v11 = new Database(path, { strict: true });
      v11.exec("PRAGMA foreign_keys = ON;");
      runMigrations(v11, [
        ...actionAttemptDispatchSequence,
        { ...operationalJournalMigration, version: 6 },
        actionResultReconciliationMigration,
        threadGraphMigration,
        actionApprovalAuthorityMigration,
        actionPlanRestoreQuarantineMigration,
        sealKeyAdministrationMigration,
      ]);
      expect(v11.query("PRAGMA user_version;").get()).toEqual({ user_version: 11 });
      expect(v11.query("PRAGMA integrity_check;").get()).toEqual({ integrity_check: "ok" });
      expect(v11.query("PRAGMA foreign_key_check;").all()).toEqual([]);
      expect(v11.query("SELECT challenge_id FROM operator_presence_challenge_expirations WHERE challenge_id = ?;").get(migrationChallengeId)).toEqual({ challenge_id: migrationChallengeId });
      v11.close();
      await chmod(path, 0o600);
      const defaultReopened = await openDatabase(path);
      expect(defaultReopened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 11 });
      await defaultReopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces exact decimal seal-key revisions in the v11 SQL boundary", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    runMigrations(database, [
      ...actionAttemptDispatchSequence,
      { ...operationalJournalMigration, version: 6 },
      actionResultReconciliationMigration,
      threadGraphMigration,
      actionApprovalAuthorityMigration,
      actionPlanRestoreQuarantineMigration,
      sealKeyAdministrationMigration,
    ]);
    const challengeId = "operator-challenge:00000000-0000-4000-8000-000000000099";
    const nonce = Buffer.alloc(32, 9).toString("base64url");
    const issuedAt = "2026-08-18T00:00:00.000Z";
    const expiresAt = "2026-08-18T00:01:00.000Z";
    const bodyHash = "a".repeat(64);
    const displayCode = "0000-0000-0000-0000-0000";
    const commitment = JSON.stringify([
      "agent-mail-operator-challenge-v1",
      "instance:00000000-0000-4000-8000-000000000001",
      challengeId,
      nonce,
      "credential:operator",
      "principal:local-operator",
      "operator-interactive",
      "seal-key-rotate",
      "ADMIN",
      "/internal/action-authority/seal-keyring/rotate",
      bodyHash,
      displayCode,
      1,
      issuedAt,
      expiresAt,
    ]);
    database
      .query(
        "INSERT INTO operator_presence_challenges (challenge_id, authority_instance_id, operator_configuration_revision, challenge_nonce_base64url, credential_id, principal_id, profile, operation, request_method, request_path, request_body_sha256, operator_display_code, challenge_commitment, challenge_commitment_sha256, issued_at, expires_at) VALUES (?, ?, 1, ?, 'credential:operator', 'principal:local-operator', 'operator-interactive', 'seal-key-rotate', 'ADMIN', ?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        challengeId,
        "instance:00000000-0000-4000-8000-000000000001",
        nonce,
        "/internal/action-authority/seal-keyring/rotate",
        bodyHash,
        displayCode,
        commitment,
        createHash("sha256").update(commitment).digest("hex"),
        issuedAt,
        expiresAt,
      );
    const signature = assertionSignatureP1363Base64url;
    const signatureHash = assertionSignatureSha256;
    expect(() =>
      database
        .query(
          "INSERT INTO operator_presence_challenge_consumptions (challenge_id, consumed_at, operation, authority_output_kind, authority_output_id, signature_p1363_base64url, signature_sha256) VALUES (?, ?, 'seal-key-rotate', 'seal-key-rotation', ?, ?, ?);",
        )
        .run(
          challengeId,
          "2026-08-18T00:00:01.000Z",
          "seal-keyring-revision:1evil",
          signature,
          signatureHash,
        ),
    ).toThrow();
    database
      .query(
        "INSERT INTO operator_presence_challenge_consumptions (challenge_id, consumed_at, operation, authority_output_kind, authority_output_id, signature_p1363_base64url, signature_sha256) VALUES (?, ?, 'seal-key-rotate', 'seal-key-rotation', ?, ?, ?);",
      )
      .run(
        challengeId,
        "2026-08-18T00:00:01.000Z",
        "seal-keyring-revision:1",
        signature,
        signatureHash,
      );
    expect(
      database
        .query("SELECT authority_output_id FROM operator_presence_challenge_consumptions WHERE challenge_id = ?;")
        .get(challengeId),
    ).toEqual({ authority_output_id: "seal-keyring-revision:1" });
    database.close();
  });

  it("persists strict authority tables and consumes exactly once", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    const receipt = consumeActionApproval(database, { request: { planId, planVersion: 1, previewDigest: approval.approval.previewDigest, approvalId: approval.approval.approvalId }, context: agent, now: "2026-08-18T00:00:02.000Z", keyring });
    expect(receipt.executorProfile).toBe("internal-action-executor");
    expect(database.query("SELECT state, version FROM action_plans WHERE plan_id = ?").get(planId)).toEqual({ state: "executing", version: 2 });
    expect(() => consumeActionApproval(database, { request: { planId, planVersion: 1, previewDigest: "a".repeat(64), approvalId: approval.approval.approvalId }, context: agent, now: "2026-08-18T00:00:03.000Z", keyring })).toThrow(/already consumed/);
  });

  it("attributes every newly started target to the consumed receipt before admission", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    const receipt = consumeActionApproval(database, {
      request: {
        planId,
        planVersion: 1,
        previewDigest: approval.approval.previewDigest,
        approvalId: approval.approval.approvalId,
      },
      context: agent,
      now: "2026-08-18T00:00:02.000Z",
      keyring,
    });
    const started = startActionPlanAttempt(database, {
      planId,
      claimId: receipt.claimId,
      targetOrdinal: 1,
      attemptId: "attempt:authority-one",
      idempotencyKey: "idempotency:authority-one",
      startedAt: "2026-08-18T00:00:03.000Z",
      now: "2026-08-18T00:00:03.000Z",
      executorInstanceId: "executor:authority-one",
    });
    expect(started.kind).toBe("started");
    expect(
      database
        .query(
          "SELECT receipt_id, claim_id, executor_profile, executor_instance_id FROM action_attempt_authorities WHERE plan_id = ? AND attempt_id = ?;",
        )
        .get(planId, "attempt:authority-one"),
    ).toEqual({
      receipt_id: receipt.receiptId,
      claim_id: receipt.claimId,
      executor_profile: "internal-action-executor",
      executor_instance_id: "executor:authority-one",
    });
  });

  it("requires explicit terminal executor attribution and rejects omission or mismatch", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    const receipt = consumeActionApproval(database, {
      request: {
        planId,
        planVersion: 1,
        previewDigest: approval.approval.previewDigest,
        approvalId: approval.approval.approvalId,
      },
      context: agent,
      now: "2026-08-18T00:00:02.000Z",
      keyring,
    });
    const started = startActionPlanAttempt(database, {
      planId,
      claimId: receipt.claimId,
      targetOrdinal: 1,
      attemptId: "attempt:terminal-attribution",
      idempotencyKey: "idempotency:terminal-attribution",
      startedAt: "2026-08-18T00:00:03.000Z",
      now: "2026-08-18T00:00:03.000Z",
      executorInstanceId: "executor:actual",
    });
    if (started.kind !== "started") throw new Error("terminal attribution attempt was not started");
    const result = createRemoteAttemptSuccess({
      kind: "success",
      planId,
      action: started.attempt.action,
      target: started.attempt.target,
      attemptId: started.attempt.attemptId,
      idempotencyKey: started.attempt.idempotencyKey,
      startedAt: started.attempt.startedAt,
      resultAt: "2026-08-18T00:00:04.000Z",
      certainty: "definite",
      postcondition: { kind: "flags", observedAt: "2026-08-18T00:00:04.000Z", flags: ["\\Seen"], modseq: 8 },
    });
    expect(recordDefiniteActionPlanResult(database, { result })).toMatchObject({ kind: "recorded" });
    const base = { planId, claimId: receipt.claimId, expectedVersion: 2, now: "2026-08-18T00:00:05.000Z" };
    expect(() => finalizeActionPlan(database, base)).toThrow("executor identity is required");
    expect(() => finalizeActionPlan(database, { ...base, executorInstanceId: "executor:wrong" })).toThrow(
      "not attributed",
    );
    expect(finalizeActionPlan(database, { ...base, executorInstanceId: "executor:actual" })).toMatchObject({
      kind: "finalized",
      state: "completed",
    });
    expect(database.query("SELECT executor_instance_id FROM action_plan_terminal_audit WHERE plan_id = ?;").get(planId)).toEqual({ executor_instance_id: "executor:actual" });
  });

  it("keeps effect executor A separate from recovery finalizer B and commits the full projection", () => {
    const { database, planId } = setup([
      { accountId: "account:one", mailboxId: "mailbox:inbox", uidValidity: 1, uid: 2, precondition: { modseq: 7 } },
      { accountId: "account:one", mailboxId: "mailbox:inbox", uidValidity: 1, uid: 3, precondition: { modseq: 8 } },
    ]);
    const approval = approve(database, planId);
    const receipt = consumeActionApproval(database, {
      request: {
        planId,
        planVersion: 1,
        previewDigest: approval.approval.previewDigest,
        approvalId: approval.approval.approvalId,
      },
      context: agent,
      now: "2026-08-18T00:00:02.000Z",
      keyring,
    });
    const started = [1, 2].map((targetOrdinal) =>
      startActionPlanAttempt(database, {
        planId,
        claimId: receipt.claimId,
        targetOrdinal,
        attemptId: `attempt:recovery-${targetOrdinal}`,
        idempotencyKey: `idempotency:recovery-${targetOrdinal}`,
        startedAt: "2026-08-18T00:00:03.000Z",
        now: "2026-08-18T00:00:03.000Z",
        executorInstanceId: "executor:effect-a",
      }),
    );
    for (const result of started) expect(result.kind).toBe("started");
    for (const [index, result] of started.entries()) {
      if (result.kind !== "started") throw new Error("effect attempt did not start");
      expect(
        recordDefiniteActionPlanResult(database, {
          result: createRemoteAttemptSuccess({
            kind: "success",
            planId,
            action: result.attempt.action,
            target: result.attempt.target,
            attemptId: result.attempt.attemptId,
            idempotencyKey: result.attempt.idempotencyKey,
            startedAt: result.attempt.startedAt,
            resultAt: `2026-08-18T00:00:0${4 + index}.000Z`,
            certainty: "definite",
            postcondition: {
              kind: "flags",
              observedAt: `2026-08-18T00:00:0${4 + index}.000Z`,
              flags: ["\\Seen"],
              modseq: 8 + index,
            },
          }),
        }),
      ).toMatchObject({ kind: "recorded" });
    }
    const projection = readEffectAuthorityProjection(database, {
      planId,
      receiptId: receipt.receiptId,
      claimId: receipt.claimId,
    });
    expect(projection).toMatchObject({ count: 2, executorInstanceId: "executor:effect-a" });
    const before = database
      .query("SELECT * FROM action_plan_terminal_audit WHERE plan_id = ?;")
      .get(planId);
    expect(before).toBeNull();
    expect(() =>
      finalizeActionPlan(database, {
        planId,
        claimId: receipt.claimId,
        expectedVersion: 2,
        now: "2026-08-18T00:00:06.000Z",
        executorInstanceId: "executor:recovery-b",
      }),
    ).toThrow("not attributed");
    const finalized = finalizeActionPlanAfterRecovery(
      database,
      {
        planId,
        claimId: receipt.claimId,
        expectedVersion: 2,
        now: "2026-08-18T00:00:06.000Z",
      },
      "recovery-finalizer:process-b",
    );
    expect(finalized).toMatchObject({ kind: "finalized", state: "completed" });
    const audit = database
      .query(
        "SELECT effect_attempt_count, effect_authority_set_digest, executor_instance_id, finalizer_kind, finalizer_instance_id FROM action_plan_terminal_audit WHERE plan_id = ?;",
      )
      .get(planId);
    expect(audit).toEqual({
      effect_attempt_count: 2,
      effect_authority_set_digest: projection.digest,
      executor_instance_id: "executor:effect-a",
      finalizer_kind: "ordinary-recovery",
      finalizer_instance_id: "recovery-finalizer:process-b",
    });
    const reopenedAudit = database
      .query("SELECT * FROM action_plan_terminal_audit WHERE plan_id = ?;")
      .get(planId);
    expect(
      finalizeActionPlanAfterRecovery(
        database,
        { planId, claimId: receipt.claimId, expectedVersion: 2, now: "2026-08-18T00:00:06.000Z" },
        "recovery-finalizer:process-b",
      ),
    ).toEqual(finalized);
    expect(database.query("SELECT * FROM action_plan_terminal_audit WHERE plan_id = ?;").get(planId)).toEqual(reopenedAudit);
  });

  it("rejects incomplete or tampered projections and records executor:multiple", () => {
    const { database, planId } = setup([
      { accountId: "account:one", mailboxId: "mailbox:inbox", uidValidity: 1, uid: 2, precondition: { modseq: 7 } },
      { accountId: "account:one", mailboxId: "mailbox:inbox", uidValidity: 1, uid: 3, precondition: { modseq: 8 } },
    ]);
    const approval = approve(database, planId);
    const receipt = consumeActionApproval(database, {
      request: { planId, planVersion: 1, previewDigest: approval.approval.previewDigest, approvalId: approval.approval.approvalId },
      context: agent,
      now: "2026-08-18T00:00:02.000Z",
      keyring,
    });
    const started = [1, 2].map((targetOrdinal) =>
      startActionPlanAttempt(database, {
        planId,
        claimId: receipt.claimId,
        targetOrdinal,
        attemptId: `attempt:multiple-${targetOrdinal}`,
        idempotencyKey: `idempotency:multiple-${targetOrdinal}`,
        startedAt: "2026-08-18T00:00:03.000Z",
        now: "2026-08-18T00:00:03.000Z",
        executorInstanceId: targetOrdinal === 1 ? "executor:effect-a" : "executor:effect-b",
      }),
    );
    const persistResult = (index: number): void => {
      const result = started[index];
      if (result === undefined || result.kind !== "started")
        throw new Error("multiple executor attempt did not start");
      const resultAt = `2026-08-18T00:00:0${4 + index}.000Z`;
      recordDefiniteActionPlanResult(database, {
        result: createRemoteAttemptSuccess({
          kind: "success",
          planId,
          action: result.attempt.action,
          target: result.attempt.target,
          attemptId: result.attempt.attemptId,
          idempotencyKey: result.attempt.idempotencyKey,
          startedAt: result.attempt.startedAt,
          resultAt,
          certainty: "definite",
          postcondition: { kind: "flags", observedAt: resultAt, flags: ["\\Seen"], modseq: 8 + index },
        }),
      });
    };
    persistResult(0);
    expect(() =>
      finalizeActionPlanAfterRecovery(
        database,
        { planId, claimId: receipt.claimId, expectedVersion: 2, now: "2026-08-18T00:00:06.000Z" },
        "recovery-finalizer:process-c",
      ),
    ).toThrow("requires every durable target result");
    persistResult(1);
    const projection = readEffectAuthorityProjection(database, {
      planId,
      receiptId: receipt.receiptId,
      claimId: receipt.claimId,
    });
    expect(projection.executorInstanceId).toBe("executor:multiple");
    expect(() =>
      recordActionPlanTerminalAudit(database, {
        planId,
        receiptId: receipt.receiptId,
        claimId: receipt.claimId,
        terminalState: "completed",
        terminalAt: "2026-08-18T00:00:06.000Z",
        executorDisposition: "started",
        effectAttemptCount: projection.count,
        effectAuthoritySetDigest: "0".repeat(64),
        executorInstanceId: "executor:multiple",
        finalizerKind: "ordinary-recovery",
        finalizerInstanceId: "recovery-finalizer:process-c",
        reasonCode: "normal-finalization",
        restoreEventId: "restore-event:none",
        resultDigest: "1".repeat(64),
      }),
    ).toThrow("projection");
    finalizeActionPlanAfterRecovery(
      database,
      { planId, claimId: receipt.claimId, expectedVersion: 2, now: "2026-08-18T00:00:06.000Z" },
      "recovery-finalizer:process-c",
    );
    expect(database.query("SELECT executor_instance_id, finalizer_kind FROM action_plan_terminal_audit WHERE plan_id = ?;").get(planId)).toEqual({ executor_instance_id: "executor:multiple", finalizer_kind: "ordinary-recovery" });
  });

  it("fails closed for same-token and seal tampering", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    expect(() => consumeActionApproval(database, { request: { planId, planVersion: 1, previewDigest: approval.approval.previewDigest, approvalId: approval.approval.approvalId }, context: registerTrustedAuthorityContext({ ...agent, principalId: operator.principalId, credentialId: operator.credentialId }), now: "2026-08-18T00:00:02.000Z", keyring })).toThrow(/cannot perform/);
    expect(() => database.query("UPDATE action_approvals SET target_digest = ? WHERE approval_id = ?").run("f".repeat(64), approval.approval.approvalId)).toThrow(/immutable/);
  });

  it("invalidates stale configuration authority before ordinary restart admission", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    const result = invalidateAuthorityForConfigurationChange(database, {
      authorityInstanceId: "instance:00000000-0000-4000-8000-000000000002",
      configurationRevision: 2,
      activeCredentialIds: [],
      invalidatedAt: "2026-08-18T00:00:03.000Z",
    });
    expect(result).toEqual({ invalidatedChallenges: 0, invalidatedApprovals: 1 });
    expect(
      database
        .query(
          "SELECT reason_code, plan_version_before, plan_version_after FROM action_approval_invalidations WHERE approval_id = ?;",
        )
        .get(approval.approval.approvalId),
    ).toEqual({ reason_code: "configuration-change", plan_version_before: 1, plan_version_after: 2 });
    expect(database.query("SELECT version FROM action_plans WHERE plan_id = ?;").get(planId)).toEqual({ version: 2 });
  });

  it("enforces authority bindings in SQLite triggers, not only in service code", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    expect(() => database.query("UPDATE action_plans SET version = version + 2 WHERE plan_id = ?;").run(planId)).toThrow(/version/);
    issueOperatorPresenceChallenge(database, {
      challengeId: "operator-challenge:sql-adversary",
      authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
      operatorConfigurationRevision: 1,
      challengeNonceBase64url: Buffer.alloc(32, 2).toString("base64url"),
      credentialId: operator.credentialId,
      operation: "approve",
      requestMethod: "POST",
      requestPath: `/v1/action-plans/${encodeURIComponent(planId)}/approvals`,
      requestBodySha256: "b".repeat(64),
      operatorDisplayCode: "0000-0000-0000-0000-0000",
      challengeCommitment: challengeCommitmentFor({
        challengeId: "operator-challenge:sql-adversary",
        authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
        operatorConfigurationRevision: 1,
        challengeNonceBase64url: Buffer.alloc(32, 2).toString("base64url"),
        credentialId: operator.credentialId,
        operation: "approve",
        requestMethod: "POST",
        requestPath: `/v1/action-plans/${encodeURIComponent(planId)}/approvals`,
        requestBodySha256: "b".repeat(64),
        operatorDisplayCode: "0000-0000-0000-0000-0000",
        issuedAt: "2026-08-18T00:00:01.000Z",
        expiresAt: "2026-08-18T00:01:01.000Z",
      }),
      issuedAt: "2026-08-18T00:00:01.000Z",
      expiresAt: "2026-08-18T00:01:01.000Z",
    });
    expect(() => database.query("INSERT INTO operator_presence_challenge_consumptions (challenge_id, consumed_at, operation, authority_output_kind, authority_output_id, signature_p1363_base64url, signature_sha256) VALUES (?, ?, 'cancel-approval', 'cancellation', ?, ?, ?);").run("operator-challenge:sql-adversary", "2026-08-18T00:00:02.000Z", approval.approval.approvalId, assertionSignatureP1363Base64url, assertionSignatureSha256)).toThrow(/binding|output/);
  });

  it("rejects v9-shaped rows that v10 cannot bind to the exact ceremony, receipt, or terminal authority", () => {
    const { database, planId } = setup();
    const validChallenge = challengeCommitmentFor({
      challengeId: "operator-challenge:shape-adversary",
      authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
      operatorConfigurationRevision: 1,
      challengeNonceBase64url: Buffer.alloc(32, 3).toString("base64url"),
      credentialId: operator.credentialId,
      operation: "approve",
      requestMethod: "POST",
      requestPath: `/v1/action-plans/${encodeURIComponent(planId)}/approvals`,
      requestBodySha256: "b".repeat(64),
      operatorDisplayCode: "0000-0000-0000-0000-0000",
      issuedAt: "2026-08-18T00:00:01.000Z",
      expiresAt: "2026-08-18T00:01:01.000Z",
    });
    const malformed = JSON.stringify([
      ...JSON.parse(validChallenge) as unknown[],
      "trailing-element",
    ]);
    expect(() =>
      issueOperatorPresenceChallenge(database, {
        challengeId: "operator-challenge:shape-adversary",
        authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
        operatorConfigurationRevision: 1,
        challengeNonceBase64url: Buffer.alloc(32, 3).toString("base64url"),
        credentialId: operator.credentialId,
        operation: "approve",
        requestMethod: "POST",
        requestPath: `/v1/action-plans/${encodeURIComponent(planId)}/approvals`,
        requestBodySha256: "b".repeat(64),
        operatorDisplayCode: "0000-0000-0000-0000-0000",
        challengeCommitment: malformed,
        issuedAt: "2026-08-18T00:00:01.000Z",
        expiresAt: "2026-08-18T00:01:01.000Z",
      }),
    ).toThrow(/canonical|authority assertion/);

    const approval = approve(database, planId);
    const fakeClaim = "claim:sql-adversary";
    expect(() =>
      database
        .query(
          "INSERT INTO action_approval_consumptions (receipt_id, approval_id, plan_id, plan_version_before, plan_version_after, claim_id, committer_principal_id, committer_credential_id, committer_profile, committer_auth_event_id, consumed_at, approval_commitment_sha256, executor_profile, receipt_commitment_sha256) VALUES (?, ?, ?, 1, 2, ?, 'principal:agent', 'credential:agent', 'agent-unattended', 'auth-event:agent', ?, ?, 'internal-action-executor', ?);",
        )
        .run(
          "approval-receipt:sql-adversary",
          approval.approval.approvalId,
          planId,
          fakeClaim,
          "2026-08-18T00:00:02.000Z",
          "a".repeat(64),
          "b".repeat(64),
        ),
    ).toThrow(/receipt|plan|FOREIGN KEY|constraint/);
  });

  it("quarantines restored authority before recovery can redispatch", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    const receipt = consumeActionApproval(database, { request: { planId, planVersion: 1, previewDigest: approval.approval.previewDigest, approvalId: approval.approval.approvalId }, context: agent, now: "2026-08-18T00:00:02.000Z", keyring });
    expect(quarantineRestoredAuthority(database, "restore-event:one", "2026-08-18T00:01:00.000Z")).toEqual({ invalidatedApprovals: 0, quarantinedPlans: 1 });
    expect(database.query("SELECT terminal_state, receipt_id, claim_id FROM action_plan_terminal_audit WHERE plan_id = ?").get(planId)).toEqual({ terminal_state: "restore-quarantined", receipt_id: receipt.receiptId, claim_id: receipt.claimId });
    expect(discoverExecutingActionPlans(database)).toHaveLength(0);
  });

  it("records cancellation ceremony closure and advances the exact plan version", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    const cancelRequestPath = `/v1/action-plans/plan%3Aauthority/approvals/${encodeURIComponent(approval.approval.approvalId)}`;
    const cancelCommitment = challengeCommitmentFor({
      challengeId: "operator-challenge:cancel",
      authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
      operatorConfigurationRevision: 1,
      challengeNonceBase64url: Buffer.alloc(32, 2).toString("base64url"),
      credentialId: operator.credentialId,
      operation: "cancel-approval",
      requestMethod: "DELETE",
      requestPath: cancelRequestPath,
      requestBodySha256: "e".repeat(64),
      operatorDisplayCode: "0000-0000-0000-0000-0000",
      issuedAt: "2026-08-18T00:00:02.000Z",
      expiresAt: "2026-08-18T00:01:02.000Z",
    });
    const cancelOperator = registerTrustedAuthorityContext({ ...operator, presence: { ...operator.presence, kind: "human-present" as const, ceremonyId: "operator-challenge:cancel", verifiedAt: "2026-08-18T00:00:02.000Z", validUntil: "2026-08-18T00:01:02.000Z", requestMethod: "DELETE" as const, requestPath: cancelRequestPath, requestBodySha256: "e".repeat(64), challengeCommitmentSha256: createHash("sha256").update(cancelCommitment).digest("hex") } });
    issueOperatorPresenceChallenge(database, {
      challengeId: cancelOperator.presence.ceremonyId,
      authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
      operatorConfigurationRevision: 1,
      challengeNonceBase64url: Buffer.alloc(32, 2).toString("base64url"),
      credentialId: cancelOperator.credentialId,
      operation: "cancel-approval",
      requestMethod: "DELETE",
      requestPath: cancelOperator.presence.requestPath,
      requestBodySha256: "e".repeat(64),
      operatorDisplayCode: "0000-0000-0000-0000-0000",
      challengeCommitment: cancelCommitment,
      issuedAt: "2026-08-18T00:00:02.000Z",
      expiresAt: "2026-08-18T00:01:02.000Z",
    });
    const result = cancelActionApproval(database, {
      request: { planId, approvalId: approval.approval.approvalId, planVersion: 1, previewDigest: approval.approval.previewDigest },
      context: cancelOperator,
      now: "2026-08-18T00:00:02.000Z",
    });
    expect(result.planVersion).toBe(2);
    expect(database.query("SELECT operation, authority_output_kind FROM operator_presence_challenge_consumptions WHERE challenge_id = ?").get(cancelOperator.presence.ceremonyId)).toEqual({ operation: "cancel-approval", authority_output_kind: "cancellation" });
    expect(database.query("SELECT plan_version_after FROM action_approval_cancellations WHERE approval_id = ?").get(approval.approval.approvalId)).toEqual({ plan_version_after: 2 });
    expect(() => consumeActionApproval(database, { request: { planId, planVersion: 1, previewDigest: approval.approval.previewDigest, approvalId: approval.approval.approvalId }, context: agent, now: "2026-08-18T00:00:03.000Z", keyring })).toThrow(/cancelled/);
  });

  it("records approval expiry and advances or expires the pending plan exactly once", () => {
    const { database, planId } = setup();
    const approval = approve(database, planId);
    expect(expireActionApproval(database, approval.approval.approvalId, "2026-08-18T00:10:02.000Z")).toEqual({ approvalId: approval.approval.approvalId, planId, planVersion: 2, disposition: "pending-advanced" });
    expect(database.query("SELECT version, state FROM action_plans WHERE plan_id = ?").get(planId)).toEqual({ version: 2, state: "pending" });
  });
});
