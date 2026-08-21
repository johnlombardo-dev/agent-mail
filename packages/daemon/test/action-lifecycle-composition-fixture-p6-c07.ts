import { Database } from "bun:sqlite";
import { createHash, verify } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  actionPlanCreateRequestSchema,
  actionPlanInspectResponseSchema,
  actionPlanPreviewResponseSchema,
  actionPlanSchema,
  actionPlanApproveRequestSchema,
  actionPlanCancelApprovalRequestSchema,
  remoteAttemptResultSchema,
  type ActionPlanCreateRequest,
  type ActionPlanInspectResponse,
  type ActionPlanPreviewResponse,
  type ActionPlanTarget,
  type RemoteAttemptResultContract,
} from "@agent-mail/contracts";
import {
  createRemoteAttemptFailed,
  createRemoteAttemptSuccess,
  createRemoteAttemptUncertain,
  type RemoteAttempt,
  type UtcInstant,
} from "@agent-mail/core";
import type { PreconditionObservation } from "../../imap/src/precondition";
import { runMigrations } from "../../storage/src/migration-runner";
import { actionAttemptDispatchSequence } from "../../storage/src/migrations/0005-action-attempt-dispatch";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import { actionResultReconciliationMigration } from "../../storage/src/migrations/0007-action-result-reconciliation";
import { threadGraphMigration } from "../../storage/src/migrations/0008-thread-graph";
import { actionApprovalAuthorityMigration } from "../../storage/src/migrations/0009-action-approval-authority";
import { actionPlanRestoreQuarantineMigration } from "../../storage/src/migrations/0010-action-plan-restore-quarantine";
import { sealKeyAdministrationMigration } from "../../storage/src/migrations/0011-seal-key-administration";
import { approvalCreatorProvenanceRepairMigration } from "../../storage/src/migrations/0029-approval-creator-provenance-repair";
import {
  authorityPreviewDigestForPlan,
  createApprovalSealKeyring,
  recordTrustedActionPlanCreator,
} from "../../storage/src/action-approval-authority";
import { createPendingActionPlan, readPendingActionPlan, type PendingActionPlanProposal } from "../../storage/src/action-plan-repository";
import { readActionPlanResult } from "../../storage/src/action-plan-result";
import { createActionApprovalServices, createConsumedActionPlanExecutor } from "../src/action-approval-service";
import { createActionCredentialRegistry, authenticateActionCredential, createOperatorSessionRegistry, OperatorPresenceAuthority, OperatorSessionAuthority } from "../src/action-authority-auth";
import { registerTrustedAuthContext } from "../src/trusted-auth-context";
import type { ActionPlanServices, ActionPlanServiceContext } from "../src/action-plan-handlers";
import { createFileActionPlanOwnerLeaseStore } from "../src/action-plan-restart-recovery";
import { createTestA1Key, TestOperatorPresenceVerifier } from "./support/operator-presence";
import { OperatorPresenceError, type OperatorPresenceAssertion, type OperatorPresenceChallenge, type OperatorPresenceRequest } from "../src/operator-presence";

export type ActionLifecycleMode = "success" | "partial" | "stale" | "failed" | "uncertain";

export const actionLifecycleAgentSecret = "action-lifecycle-agent-secret" as const;
export const actionLifecycleOperatorCredentialId = "credential:operator" as const;
export const actionLifecycleAuthorityInstanceId =
  "instance:00000000-0000-4000-8000-000000000001" as const;

export const actionLifecycleTargets: readonly [ActionPlanTarget, ActionPlanTarget] = [
  {
    accountId: "account:composition",
    mailboxId: "mailbox:inbox",
    uidValidity: 9,
    uid: 7,
    precondition: { modseq: 101 },
  },
  {
    accountId: "account:composition",
    mailboxId: "mailbox:archive",
    uidValidity: 9,
    uid: 8,
    precondition: { modseq: 201 },
  },
];

type Row = Readonly<Record<string, unknown>>;

function row(value: unknown, label: string): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} row is invalid`);
  return Object.fromEntries(Object.entries(value));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function sortedTargetRows(database: Database, planId: string): readonly Row[] {
  return database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid, precondition_modseq FROM action_plan_targets WHERE plan_id = ?;",
    )
    .all(planId)
    .map((value) => row(value, "target"))
    .sort((left, right) => {
      const account = Buffer.from(stringValue(left.account_id, "account_id")).compare(
        Buffer.from(stringValue(right.account_id, "account_id")),
      );
      if (account !== 0) return account;
      const mailbox = Buffer.from(stringValue(left.mailbox_id, "mailbox_id")).compare(
        Buffer.from(stringValue(right.mailbox_id, "mailbox_id")),
      );
      if (mailbox !== 0) return mailbox;
      return (
        numberValue(left.uid_validity, "uid_validity") - numberValue(right.uid_validity, "uid_validity") ||
        numberValue(left.uid, "uid") - numberValue(right.uid, "uid") ||
        numberValue(left.precondition_modseq, "precondition_modseq") -
          numberValue(right.precondition_modseq, "precondition_modseq")
      );
    });
}

function canonicalTargetSet(database: Database, planId: string): string {
  const targets = sortedTargetRows(database, planId);
  if (targets.length === 0) throw new Error("action plan has no targets");
  return JSON.stringify([
    "action-target-set-v1",
    targets.map((target) => [
      target.account_id,
      target.mailbox_id,
      target.uid_validity,
      target.uid,
      target.precondition_modseq,
    ]),
  ]);
}

function targetDigest(database: Database, planId: string): string {
  return createHash("sha256").update(canonicalTargetSet(database, planId)).digest("hex");
}

function previewDigestForInput(
  planId: string,
  input: ActionPlanCreateRequest,
  createdAt: string,
  expiresAt: string,
): string {
  const targets = [...input.targets].sort((left, right) => {
    const account = Buffer.from(left.accountId).compare(Buffer.from(right.accountId));
    if (account !== 0) return account;
    const mailbox = Buffer.from(left.mailboxId).compare(Buffer.from(right.mailboxId));
    if (mailbox !== 0) return mailbox;
    return (
      left.uidValidity - right.uidValidity ||
      left.uid - right.uid ||
      left.precondition.modseq - right.precondition.modseq
    );
  });
  const targetSet = JSON.stringify([
    "action-target-set-v1",
    targets.map((target) => [
      target.accountId,
      target.mailboxId,
      target.uidValidity,
      target.uid,
      target.precondition.modseq,
    ]),
  ]);
  const targetDigestValue = createHash("sha256").update(targetSet).digest("hex");
  const intent = JSON.stringify(["action-intent-v1", input.action.kind, targetDigestValue]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "action-preview-v1",
        planId,
        1,
        input.action.kind,
        targetSet,
        intent,
        createdAt,
        expiresAt,
      ]),
    )
    .digest("hex");
}

function normalizedIntent(database: Database, planId: string): string {
  const plan = row(
    database.query("SELECT action_kind FROM action_plans WHERE plan_id = ?;").get(planId),
    "action plan",
  );
  return JSON.stringify(["action-intent-v1", stringValue(plan.action_kind, "action_kind"), targetDigest(database, planId)]);
}

function storedPlan(database: Database, planId: string): ReturnType<typeof actionPlanSchema.parse> {
  const value = row(
    database
      .query(
        "SELECT plan_id, action_kind, state, created_at, expires_at, claim_id, started_at, completed_at, failed_at, rejected_at, rejection_reason, expired_at, uncertain_attempt_id, missing_local_result_at FROM action_plans WHERE plan_id = ?;",
      )
      .get(planId),
    "action plan",
  );
  const targets = sortedTargetRows(database, planId).map((target) => ({
    accountId: stringValue(target.account_id, "account_id"),
    mailboxId: stringValue(target.mailbox_id, "mailbox_id"),
    uidValidity: numberValue(target.uid_validity, "uid_validity"),
    uid: numberValue(target.uid, "uid"),
    precondition: { modseq: numberValue(target.precondition_modseq, "precondition_modseq") },
  }));
  const state = stringValue(value.state, "state");
  const base = {
    planId: stringValue(value.plan_id, "plan_id"),
    action: { kind: stringValue(value.action_kind, "action_kind") },
    targets,
    createdAt: stringValue(value.created_at, "created_at"),
    expiresAt: stringValue(value.expires_at, "expires_at"),
  };
  const candidate: Record<string, unknown> = { state, ...base };
  if (state === "executing") {
    candidate.claimId = stringValue(value.claim_id, "claim_id");
    candidate.startedAt = stringValue(value.started_at, "started_at");
  } else if (state === "completed" || state === "partial") {
    candidate.completedAt = stringValue(value.completed_at, "completed_at");
  } else if (state === "failed") {
    candidate.failedAt = stringValue(value.failed_at, "failed_at");
  } else if (state === "rejected") {
    candidate.rejectedAt = stringValue(value.rejected_at, "rejected_at");
    candidate.reason = stringValue(value.rejection_reason, "rejection_reason");
  } else if (state === "expired") {
    candidate.expiredAt = stringValue(value.expired_at, "expired_at");
  } else if (state === "uncertain") {
    candidate.remoteAttemptId = stringValue(value.uncertain_attempt_id, "uncertain_attempt_id");
    candidate.missingLocalResultAt = stringValue(value.missing_local_result_at, "missing_local_result_at");
  }
  return actionPlanSchema.parse(candidate);
}

function resultRows(database: Database, planId: string): readonly RemoteAttemptResultContract[] {
  const targets = sortedTargetRows(database, planId);
  return targets.flatMap((_target, index) => {
    const result = database
      .query("SELECT attempt_id FROM action_attempts WHERE plan_id = ? AND target_ordinal = ?;")
      .get(planId, index + 1);
    if (result === null) return [];
    const attempt = row(result, "attempt");
    const attemptId = stringValue(attempt.attempt_id, "attempt_id");
    const stored = readActionPlanResult(database, attemptId);
    return stored === undefined ? [] : [remoteAttemptResultSchema.parse(stored)];
  });
}

function approvalProjection(database: Database, planId: string): unknown {
  const value = database
    .query(
      "SELECT approval_id, plan_version, preview_digest, target_digest, normalized_intent, approver_principal_id, issued_at, expires_at, authorization_scope FROM action_approvals WHERE plan_id = ? ORDER BY rowid DESC LIMIT 1;",
    )
    .get(planId);
  if (value === null) return "absent";
  const approval = row(value, "approval");
  const approvalId = stringValue(approval.approval_id, "approval_id");
  const cancelled = database
    .query("SELECT cancelled_at FROM action_approval_cancellations WHERE approval_id = ?;")
    .get(approvalId);
  if (cancelled !== null)
    return {
      state: "cancelled",
      approvalId,
      planId,
      cancelledAt: stringValue(row(cancelled, "cancellation").cancelled_at, "cancelled_at"),
    };
  const expired = database
    .query("SELECT expired_at FROM action_approval_expirations WHERE approval_id = ?;")
    .get(approvalId);
  if (expired !== null)
    return {
      state: "expired",
      approvalId,
      planId,
      previewDigest: stringValue(approval.preview_digest, "preview_digest"),
      targetDigest: stringValue(approval.target_digest, "target_digest"),
      normalizedIntent: stringValue(approval.normalized_intent, "normalized_intent"),
      issuedAt: stringValue(approval.issued_at, "issued_at"),
      expiresAt: stringValue(approval.expires_at, "expires_at"),
      expiredAt: stringValue(row(expired, "expiration").expired_at, "expired_at"),
    };
  const invalidated = database
    .query("SELECT invalidated_at FROM action_approval_invalidations WHERE approval_id = ?;")
    .get(approvalId);
  if (invalidated !== null)
    return {
      state: "invalidated",
      approvalId,
      planId,
      previewDigest: stringValue(approval.preview_digest, "preview_digest"),
      targetDigest: stringValue(approval.target_digest, "target_digest"),
      normalizedIntent: stringValue(approval.normalized_intent, "normalized_intent"),
      issuedAt: stringValue(approval.issued_at, "issued_at"),
      expiresAt: stringValue(approval.expires_at, "expires_at"),
      invalidatedAt: stringValue(row(invalidated, "invalidation").invalidated_at, "invalidated_at"),
    };
  const consumed = database
    .query(
      "SELECT receipt_id, consumed_at, committer_principal_id FROM action_approval_consumptions WHERE approval_id = ?;",
    )
    .get(approvalId);
  if (consumed !== null) {
    const receipt = row(consumed, "consumption");
    return {
      state: "consumed",
      approvalId,
      planId,
      planVersion: numberValue(approval.plan_version, "plan_version"),
      previewDigest: stringValue(approval.preview_digest, "preview_digest"),
      targetDigest: stringValue(approval.target_digest, "target_digest"),
      normalizedIntent: stringValue(approval.normalized_intent, "normalized_intent"),
      issuedAt: stringValue(approval.issued_at, "issued_at"),
      expiresAt: stringValue(approval.expires_at, "expires_at"),
      consumedAt: stringValue(receipt.consumed_at, "consumed_at"),
      committer: { principalId: stringValue(receipt.committer_principal_id, "committer_principal_id"), profile: "agent-unattended" },
      receiptId: stringValue(receipt.receipt_id, "receipt_id"),
    };
  }
  return {
    state: "available",
    approvalId,
    planId,
    planVersion: numberValue(approval.plan_version, "plan_version"),
    previewDigest: stringValue(approval.preview_digest, "preview_digest"),
    targetDigest: stringValue(approval.target_digest, "target_digest"),
    normalizedIntent: stringValue(approval.normalized_intent, "normalized_intent"),
    issuedAt: stringValue(approval.issued_at, "issued_at"),
    expiresAt: stringValue(approval.expires_at, "expires_at"),
    authorizationScope: stringValue(approval.authorization_scope, "authorization_scope"),
    approver: { principalId: stringValue(approval.approver_principal_id, "approver_principal_id"), profile: "operator-interactive" },
  };
}

function terminalAudit(database: Database, planId: string): unknown {
  const value = database
    .query(
      "SELECT terminal_state, terminal_at, executor_disposition, effect_attempt_count, effect_authority_set_digest, executor_instance_id, finalizer_kind, finalizer_instance_id, reason_code, restore_event_id, result_digest FROM action_plan_terminal_audit WHERE plan_id = ?;",
    )
    .get(planId);
  if (value === null) return "absent";
  const audit = row(value, "terminal audit");
  return {
    terminalState: stringValue(audit.terminal_state, "terminal_state"),
    terminalAt: stringValue(audit.terminal_at, "terminal_at"),
    executorDisposition: stringValue(audit.executor_disposition, "executor_disposition"),
    effectAttemptCount: numberValue(audit.effect_attempt_count, "effect_attempt_count"),
    effectAuthoritySetDigest: stringValue(audit.effect_authority_set_digest, "effect_authority_set_digest"),
    executorInstanceId: stringValue(audit.executor_instance_id, "executor_instance_id"),
    finalizerKind: stringValue(audit.finalizer_kind, "finalizer_kind"),
    finalizerInstanceId: stringValue(audit.finalizer_instance_id, "finalizer_instance_id"),
    reasonCode: stringValue(audit.reason_code, "reason_code"),
    restoreEventId: stringValue(audit.restore_event_id, "restore_event_id"),
    resultDigest: stringValue(audit.result_digest, "result_digest"),
  };
}

function responseFor(database: Database, planId: string): ActionPlanInspectResponse {
  const plan = storedPlan(database, planId);
  const metadata = row(
    database.query("SELECT preview_digest FROM action_plan_proposals WHERE plan_id = ?;").get(planId),
    "action plan proposal",
  );
  const creator = row(
    database
      .query("SELECT principal_id, profile FROM action_plan_creators WHERE plan_id = ?;")
      .get(planId),
    "action plan creator",
  );
  const value = {
    plan,
    results: resultRows(database, planId),
    planVersion: numberValue(
      row(database.query("SELECT version FROM action_plans WHERE plan_id = ?;").get(planId), "action plan").version,
      "version",
    ),
    previewDigest: stringValue(metadata.preview_digest, "preview_digest"),
    targetDigest: targetDigest(database, planId),
    normalizedIntent: normalizedIntent(database, planId),
    creator: { principalId: stringValue(creator.principal_id, "principal_id"), profile: stringValue(creator.profile, "profile") },
    approvalState: approvalProjection(database, planId),
    terminalAudit: terminalAudit(database, planId),
  };
  return actionPlanInspectResponseSchema.parse(value);
}

function previewFor(database: Database, proposal: PendingActionPlanProposal, creator: ActionPlanServiceContext): ActionPlanPreviewResponse {
  const digest = authorityPreviewDigestForPlan(database, proposal.planId);
  return actionPlanPreviewResponseSchema.parse({
    plan: {
      state: "pending",
      planId: proposal.planId,
      action: proposal.action,
      targets: proposal.targets,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
    },
    digest,
    planVersion: 1,
    previewDigest: digest,
    targetDigest: targetDigest(database, proposal.planId),
    normalizedIntent: normalizedIntent(database, proposal.planId),
    creator: { principalId: creator.authContext.principalId, profile: creator.authContext.profile },
    approvalState: "absent",
  });
}

function setupDatabase(path: string): Database {
  const database = new Database(path, { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  runMigrations(database, [
    ...actionAttemptDispatchSequence,
    { ...operationalJournalMigration, version: 6, name: "test-operational-journal" },
    actionResultReconciliationMigration,
    threadGraphMigration,
    actionApprovalAuthorityMigration,
    actionPlanRestoreQuarantineMigration,
    sealKeyAdministrationMigration,
    { ...approvalCreatorProvenanceRepairMigration, version: 12, name: "test-approval-creator-provenance-repair" },
  ]);
  return database;
}

function resultFor(attempt: RemoteAttempt, resultAt: UtcInstant, mode: ActionLifecycleMode): RemoteAttemptResultContract {
  const common = {
    planId: attempt.planId,
    action: attempt.action,
    target: attempt.target,
    attemptId: attempt.attemptId,
    idempotencyKey: attempt.idempotencyKey,
    startedAt: attempt.startedAt,
    resultAt,
    certainty: "definite" as const,
  };
  if (mode === "uncertain")
    return createRemoteAttemptUncertain({
      kind: "uncertain",
      ...common,
      certainty: "uncertain",
      uncertainReason: "local-result-not-durable",
      detail: "local result crossed the uncertain boundary",
    });
  if (mode === "failed")
    return createRemoteAttemptFailed({
      kind: "failed",
      ...common,
      failureReason: "server-rejected",
      detail: "disposable local remote rejected the frozen action",
    });
  return createRemoteAttemptSuccess({
    kind: "success",
    ...common,
    postcondition: {
      kind: "flags",
      observedAt: resultAt,
      flags: ["\\Seen"],
      modseq: attempt.target.precondition.modseq + 1,
    },
  });
}

export type ActionLifecycleCompositionFixture = Readonly<{
  readonly database: Database;
  readonly databasePath: string;
  readonly root: string;
  readonly mode: () => ActionLifecycleMode;
  readonly setMode: (mode: ActionLifecycleMode) => void;
  readonly services: ActionPlanServices;
  readonly app: ReturnType<typeof import("../src/http").createHttpApp>;
  readonly registry: ReturnType<typeof createActionCredentialRegistry>;
  readonly operatorPresence: OperatorPresenceAuthority;
  readonly operatorSessionToken: string;
  readonly operatorPresenceRequest: (operation: "approve" | "cancel-approval", input: unknown) => OperatorPresenceRequest;
  readonly operatorAssertion: (request: OperatorPresenceRequest) => Promise<OperatorPresenceAssertion>;
  readonly close: () => Promise<void>;
}>;

export async function createActionLifecycleCompositionFixture(
  root: string,
  initialMode: ActionLifecycleMode = "success",
): Promise<ActionLifecycleCompositionFixture> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const databasePath = join(root, "action-lifecycle.sqlite");
  const database = setupDatabase(databasePath);
  const createdAt = new Date().toISOString();
  const credentialExpiresAt = new Date(
    Date.parse(createdAt) + 365 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const planExpiresAt = new Date(Date.parse(createdAt) + 60 * 60 * 1_000).toISOString();
  const operatorKeys = createTestA1Key();
  const publicKeyDer = operatorKeys.publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.isBuffer(publicKeyDer)) throw new Error("operator public key export is not DER");
  const publicKeySpkiBase64url = publicKeyDer.toString("base64url");
  const operatorCredential = {
    credentialId: actionLifecycleOperatorCredentialId,
    principalId: "principal:local-operator" as const,
    profile: "operator-interactive" as const,
    scopes: ["mail:action.create", "mail:action.inspect", "mail:action.approve"],
    algorithm: "ES256" as const,
    publicKeySpkiBase64url,
    publicKeySpkiSha256: createHash("sha256").update(publicKeyDer).digest("hex"),
    status: "active" as const,
    enrolledAt: createdAt,
    expiresAt: credentialExpiresAt,
    revokedAt: null,
    replacedByCredentialId: null,
  };
  const agentCredential = {
    credentialId: "credential:agent",
    principalId: "principal:agent",
    profile: "agent-unattended" as const,
    scopes: ["mail:action.create", "mail:action.inspect", "mail:action.commit"],
    secret: actionLifecycleAgentSecret,
    issuedAt: createdAt,
    expiresAt: credentialExpiresAt,
    authEventId: "auth-event:agent-credential",
  };
  const registry = createActionCredentialRegistry([operatorCredential, agentCredential]);
  const keyring = createApprovalSealKeyring({ keyId: "approval-seal-key:composition", keyHex: "1".repeat(64) });
  const lock = {
    runShared: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
    runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
  };
  const verifier = new TestOperatorPresenceVerifier(operatorKeys.publicKey);
  let currentMode = initialMode;
  let sequence = 0;
  const sessions = createOperatorSessionRegistry(registry, 1);
  const broker = {
    verify: async (assertion: OperatorPresenceAssertion, request: OperatorPresenceRequest, challengeCommitment: string) => {
      const valid = verify(
        "sha256",
        Buffer.from(challengeCommitment),
        { key: operatorKeys.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(assertion.signatureP1363Base64url, "base64url"),
      );
      if (!valid) throw new OperatorPresenceError("operator signature is invalid");
    },
    sign: async (request: OperatorPresenceRequest, challenge: OperatorPresenceChallenge) => verifier.signForTest(challenge, operatorKeys.privateKey),
    issue: async (request: OperatorPresenceRequest) => verifier.issue(request, createdAt),
  };
  let operatorSessionToken = "";
  const authenticate = (secret: string) => {
    if (secret === operatorSessionToken) return sessions.authenticate(secret);
    const resolution = authenticateActionCredential(
      registry,
      secret,
      createdAt,
      "auth-event:agent-request",
    );
    return resolution.kind === "authenticated" && resolution.context !== undefined
      ? { ...resolution, context: registerTrustedAuthContext(resolution.context) }
      : resolution;
  };
  const operatorPresence = new OperatorPresenceAuthority({
    database,
    credentials: registry,
    broker,
    authorityInstanceId: actionLifecycleAuthorityInstanceId,
    configurationRevision: 1,
    loadCurrent: () => ({ credentials: registry, authorityInstanceId: actionLifecycleAuthorityInstanceId, configurationRevision: 1 }),
    loadKeyring: () => keyring,
  });
  const operatorSessionAuthority = new OperatorSessionAuthority({
    database,
    credentials: registry,
    sessions,
    broker,
    authorityInstanceId: actionLifecycleAuthorityInstanceId,
    configurationRevision: 1,
    loadCurrent: () => ({ credentials: registry, authorityInstanceId: actionLifecycleAuthorityInstanceId, configurationRevision: 1 }),
  });
  const sessionRequest: OperatorPresenceRequest = {
    operation: "open-session",
    method: "POST",
    path: "/v1/operator-sessions",
    rawBody: new TextEncoder().encode(JSON.stringify({ requestedScopes: ["mail:action.create", "mail:action.inspect"] })),
    credentialId: actionLifecycleOperatorCredentialId,
    principalId: "principal:local-operator",
    authorityInstanceId: actionLifecycleAuthorityInstanceId,
    configurationRevision: 1,
  };
  const sessionChallenge = await operatorSessionAuthority.issueChallenge(sessionRequest);
  const sessionAssertion = await operatorSessionAuthority.signChallenge(sessionRequest, sessionChallenge);
  operatorSessionToken = (await operatorSessionAuthority.open(sessionRequest, sessionAssertion, new Date().toISOString())).token;
  const authorityServices = createActionApprovalServices({
    database,
    loadKeyring: () => keyring,
    loadAuthority: () => ({ authorityInstanceId: actionLifecycleAuthorityInstanceId, configurationRevision: 1, activeCredentialIds: [actionLifecycleOperatorCredentialId] }),
    authorityLock: lock,
    now: () => createdAt,
    executeConsumedPlan: createConsumedActionPlanExecutor({
      database,
      ownerLeases: createFileActionPlanOwnerLeaseStore({ directory: join(root, "leases") }),
      executorInstanceId: "executor:action-lifecycle-composition",
      now: createdAt,
      freshNow: () => createdAt,
      targetLoopOptions: () => ({
        readPrecondition: async (target): Promise<PreconditionObservation> => {
          if (currentMode === "stale" || (currentMode === "partial" && target.uid === 8))
            return { kind: "stale", target, observed: { uidValidity: target.uidValidity, uid: target.uid, modseq: target.precondition.modseq + 1 }, reason: "newer-modseq" };
          return { kind: "satisfied", target, observed: { uidValidity: target.uidValidity, uid: target.uid, modseq: target.precondition.modseq } };
        },
        mutationAdapter: { execute: async () => ({ mode: currentMode }) },
        uncertainObserver: { read: async ({ attempt, resultAt }) => resultFor(attempt, resultAt, "uncertain") },
        normalizeMutationResult: ({ attempt, resultAt }) => resultFor(attempt, resultAt, currentMode),
      }),
    }),
  });
  const services: ActionPlanServices = {
    createPlan: (input, context) => {
      const request = actionPlanCreateRequestSchema.parse(input);
      const planId = `plan:action-lifecycle-${++sequence}`;
      const previewDigest = previewDigestForInput(planId, request, createdAt, planExpiresAt);
      const proposal = createPendingActionPlan(database, {
        plan: { state: "pending", planId, action: request.action, targets: request.targets, createdAt, expiresAt: planExpiresAt },
        previewDigest,
        authorizationScope: "mail:action.commit",
        idempotencyIdentity: `action-lifecycle:${planId}`,
      });
      recordTrustedActionPlanCreator(database, { planId, principalId: context.authContext.principalId, credentialId: context.authContext.credentialId, profile: context.authContext.profile === "internal-action-executor" ? "agent-unattended" : context.authContext.profile, authEventId: context.authContext.authEventId, createdAt });
      const corrected = readPendingActionPlan(database, planId);
      if (corrected === undefined) throw new Error("created action plan disappeared");
      return previewFor(database, corrected, context);
    },
    inspectPlan: (input) => responseFor(database, input.planId),
    ...authorityServices,
  };
  const { createHttpApp } = await import("../src/http");
  const app = createHttpApp({
    authenticate,
    maxRequestBodyBytes: 1_024,
    handlers: (await import("../src/action-plan-handlers")).createActionPlanHandlers(services),
    operatorSessionAuthority,
    operatorSessionCredentialId: actionLifecycleOperatorCredentialId,
    operatorSessionAuthorityInstanceId: actionLifecycleAuthorityInstanceId,
    operatorSessionConfigurationRevision: 1,
    operatorPresenceAuthority: operatorPresence,
  });
  const operatorPresenceRequest = (operation: "approve" | "cancel-approval", input: unknown): OperatorPresenceRequest => {
    const body = new TextEncoder().encode(JSON.stringify(input));
    let path: string;
    if (operation === "approve") {
      const parsed = actionPlanApproveRequestSchema.parse(input);
      path = `/v1/action-plans/${encodeURIComponent(parsed.planId)}/approvals`;
    } else {
      const parsed = actionPlanCancelApprovalRequestSchema.parse(input);
      path = `/v1/action-plans/${encodeURIComponent(parsed.planId)}/approvals/${encodeURIComponent(parsed.approvalId)}`;
    }
    return { operation, method: operation === "approve" ? "POST" : "DELETE", path, rawBody: body, credentialId: actionLifecycleOperatorCredentialId, principalId: "principal:local-operator", authorityInstanceId: actionLifecycleAuthorityInstanceId, configurationRevision: 1 };
  };
  const operatorAssertion = async (request: OperatorPresenceRequest): Promise<OperatorPresenceAssertion> => {
    const challenge = await operatorPresence.issueChallenge(request);
    return operatorPresence.signChallenge(request, challenge);
  };
  return {
    database,
    databasePath,
    root,
    mode: () => currentMode,
    setMode: (mode) => { currentMode = mode; },
    services,
    app,
    registry,
    operatorPresence,
    operatorSessionToken,
    operatorPresenceRequest,
    operatorAssertion,
    close: async () => database.close(),
  };
}
