import type {
  ActionPlanApproveRequest,
  ActionPlanCancelApprovalRequest,
  ActionPlanAuthorityCommitRequest,
} from "@agent-mail/contracts";
import { actionPlanAuthorityCommitResponseSchema } from "@agent-mail/contracts";
import { z } from "zod";
import {
  cancelActionApproval,
  consumeActionApproval,
  issueActionApproval,
  type ApprovalAuthorityConsumeInput,
  type ApprovalAuthorityIssueInput,
  type ApprovalSealKeyring,
} from "../../storage/src/action-approval-authority";
import type { ActionPlanService, ActionPlanServiceContext } from "./action-plan-handlers";
import { ApprovalAuthorityError } from "../../storage/src/action-approval-authority";
import type { Database } from "bun:sqlite";
import type { AuthorityContext } from "../../storage/src/action-approval-authority";
import type { AuthorityFileLock } from "./action-authority-lock";
import {
  runOwnedActionPlanTargetLoop,
  type ActionPlanOwnerLeaseStore,
} from "./action-plan-restart-recovery";
import type { ActionPlanTargetLoopOptions } from "./action-plan-target-loop";
import { discoverExecutingActionPlans } from "../../storage/src/action-plan-restart-recovery";
import { finalizeActionPlan } from "../../storage/src/action-plan-finalization";
import { actionPlanSchema } from "@agent-mail/contracts";
import type { UtcInstant } from "@agent-mail/core";
import { registerTrustedAuthorityContext } from "../../storage/src/trusted-authority-context";

export type ConsumedActionPlanExecution = Readonly<{
  readonly plan: unknown;
  readonly results: readonly unknown[];
}>;

export type ActionApprovalServiceOptions = Readonly<{
  readonly database: Database;
  /** Resolve the current file-backed projection while the shared authority
   * admission is held. Long-lived daemons must not seal or consume with a
   * keyring snapshot that survived rotation/removal. */
  readonly loadKeyring: () => ApprovalSealKeyring | Promise<ApprovalSealKeyring>;
  /** Resolve the current public operator projection inside shared admission. */
  readonly loadAuthority: () =>
    | Readonly<{
        readonly authorityInstanceId: string;
        readonly configurationRevision: number;
        readonly activeCredentialIds: readonly string[];
      }>
    | Promise<
        Readonly<{
          readonly authorityInstanceId: string;
          readonly configurationRevision: number;
          readonly activeCredentialIds: readonly string[];
        }>
      >;
  readonly authorityLock: AuthorityFileLock;
  readonly now?: () => string;
  /** Internal executor loop. It is never exposed as an operation or authority input. */
  readonly executeConsumedPlan: (
    receipt: ReturnType<typeof consumeActionApproval>,
    context: ActionPlanServiceContext,
  ) => Promise<ConsumedActionPlanExecution>;
}>;

export type ConsumedActionPlanExecutorOptions = Readonly<{
  readonly database: Database;
  readonly ownerLeases: ActionPlanOwnerLeaseStore;
  readonly executorInstanceId: string;
  readonly now: UtcInstant;
  readonly freshNow: () => UtcInstant;
  readonly targetLoopOptions: (
    candidate: ReturnType<typeof discoverExecutingActionPlans>[number],
  ) => Omit<
    ActionPlanTargetLoopOptions,
    "database" | "claimedPlan" | "now" | "expectedPlanVersion" | "freshNow" | "executorInstanceId"
  >;
}>;

/**
 * Concrete internal commit executor. It is intentionally not part of the
 * public operation schema: receipt consumption selects the durable executing
 * row, the owner lease selects one process, and the existing target loop owns
 * fresh-authority/recovery/remote adapter permission.
 */
export function createConsumedActionPlanExecutor(
  options: ConsumedActionPlanExecutorOptions,
): ActionApprovalServiceOptions["executeConsumedPlan"] {
  return async (receipt) => {
    const candidate = discoverExecutingActionPlans(options.database).find(
      (item) => item.plan.planId === receipt.planId && item.plan.claimId === receipt.claimId,
    );
    if (candidate === undefined) throw new Error("consumed action plan is not executing");
    const owned = await runOwnedActionPlanTargetLoop({
      ownerLeases: options.ownerLeases,
      targetLoop: {
        ...options.targetLoopOptions(candidate),
        database: options.database,
        claimedPlan: candidate.plan,
        now: options.now,
        expectedPlanVersion: candidate.version,
        freshNow: options.freshNow,
        executorInstanceId: options.executorInstanceId,
      },
    });
    if (owned.kind !== "ran")
      throw new Error(`action plan executor was not admitted: ${owned.kind}`);
    const finalized = finalizeActionPlan(options.database, {
      planId: receipt.planId,
      claimId: receipt.claimId,
      expectedVersion: candidate.version,
      now: options.now,
      executorInstanceId: options.executorInstanceId,
    });
    const plan = readPlan(options.database, receipt.planId);
    actionPlanSchema.parse(plan);
    return {
      plan,
      results: finalized.targetResults.map((item) => item.result),
    };
  };
}

function now(options: ActionApprovalServiceOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function storageAuthorityContext(context: ActionPlanServiceContext): AuthorityContext {
  const auth = context.authContext;
  const presence = auth.presence;
  if (presence.kind === "human-present") {
    return registerTrustedAuthorityContext({
      principalId: auth.principalId,
      credentialId: auth.credentialId,
      profile: auth.profile,
      scopes: auth.scopes,
      authEventId: auth.authEventId,
      authenticatedAt: auth.authenticatedAt,
      credentialExpiresAt: auth.credentialExpiresAt,
      presence: {
        kind: "human-present",
        ceremonyId: presence.ceremonyId,
        verifiedAt: presence.verifiedAt,
        validUntil: presence.validUntil,
        requestMethod: presence.requestMethod,
        requestPath: presence.requestPath,
        requestBodySha256: presence.requestBodySha256,
        challengeCommitmentSha256: presence.challengeCommitmentSha256,
        assertionSignatureSha256: presence.assertionSignatureSha256,
        assertionSignatureP1363Base64url: presence.assertionSignatureP1363Base64url,
        displayCode: presence.operatorDisplayCode,
        authorityInstanceId: presence.authorityInstanceId,
        operatorConfigurationRevision: presence.operatorConfigurationRevision,
      },
    });
  }
  if (presence.kind === "unattended") {
    return registerTrustedAuthorityContext({ ...auth, presence: { kind: "unattended" } });
  }
  return registerTrustedAuthorityContext({
    ...auth,
    presence: { kind: "a1-non-approval-session", sessionId: presence.sessionId },
  });
}

async function assertLiveOperatorAuthority(
  context: ActionPlanServiceContext,
  loadAuthority: ActionApprovalServiceOptions["loadAuthority"],
): Promise<void> {
  if (context.authContext.presence.kind !== "human-present") return;
  const current = await loadAuthority();
  const presence = context.authContext.presence;
  if (
    presence.authorityInstanceId !== current.authorityInstanceId ||
    presence.operatorConfigurationRevision !== current.configurationRevision ||
    !current.activeCredentialIds.includes(context.authContext.credentialId)
  )
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
}

function readPlan(database: Database, planId: string): unknown {
  const planRow = database
    .query(
      "SELECT plan_id, action_kind, state, created_at, expires_at, claim_id, started_at, completed_at, failed_at, rejected_at, rejection_reason, expired_at, uncertain_attempt_id, missing_local_result_at FROM action_plans WHERE plan_id = ?;",
    )
    .get(planId);
  if (typeof planRow !== "object" || planRow === null || Array.isArray(planRow))
    throw new Error("action plan disappeared after consume");
  const row = Object.fromEntries(Object.entries(planRow));
  const targetRows = database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid, precondition_modseq FROM action_plan_targets WHERE plan_id = ? ORDER BY target_ordinal;",
    )
    .all(planId);
  const targets = targetRows.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("action target row is invalid");
    const target = Object.fromEntries(Object.entries(value));
    return {
      accountId: target.account_id,
      mailboxId: target.mailbox_id,
      uidValidity: target.uid_validity,
      uid: target.uid,
      precondition: { modseq: target.precondition_modseq },
    };
  });
  return actionPlanSchema.parse({
    state: row.state,
    planId: row.plan_id,
    action: { kind: row.action_kind },
    targets,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.state === "executing" ? { claimId: row.claim_id, startedAt: row.started_at } : {}),
    ...(row.state === "completed" || row.state === "partial"
      ? { completedAt: row.completed_at }
      : {}),
    ...(row.state === "failed" ? { failedAt: row.failed_at } : {}),
    ...(row.state === "rejected"
      ? { rejectedAt: row.rejected_at, reason: row.rejection_reason }
      : {}),
    ...(row.state === "expired" ? { expiredAt: row.expired_at } : {}),
    ...(row.state === "uncertain"
      ? {
          remoteAttemptId: row.uncertain_attempt_id,
          missingLocalResultAt: row.missing_local_result_at,
        }
      : {}),
  });
}

function authorityFailure(error: unknown): never {
  if (error instanceof ApprovalAuthorityError) {
    throw {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  throw error;
}

export function createActionApprovalServices(options: ActionApprovalServiceOptions): Readonly<{
  readonly approvePlan: ActionPlanService<
    ActionPlanApproveRequest,
    z.infer<typeof import("@agent-mail/contracts").actionPlanApproveResponseSchema>
  >;
  readonly cancelApproval: ActionPlanService<
    ActionPlanCancelApprovalRequest,
    z.infer<typeof import("@agent-mail/contracts").actionPlanCancelApprovalResponseSchema>
  >;
  readonly authorityCommitPlan: ActionPlanService<
    ActionPlanAuthorityCommitRequest,
    z.infer<typeof actionPlanAuthorityCommitResponseSchema>
  >;
}> {
  const approvePlan: ActionPlanService<
    ActionPlanApproveRequest,
    z.infer<typeof import("@agent-mail/contracts").actionPlanApproveResponseSchema>
  > = async (request, context) => {
    try {
      return await options.authorityLock.runShared(async () => {
        await assertLiveOperatorAuthority(context, options.loadAuthority);
        const input: ApprovalAuthorityIssueInput = {
          request,
          context: storageAuthorityContext(context),
          now: now(options),
          keyring: await options.loadKeyring(),
        };
        return issueActionApproval(options.database, input);
      });
    } catch (error: unknown) {
      return authorityFailure(error);
    }
  };
  const cancelApproval: ActionPlanService<
    ActionPlanCancelApprovalRequest,
    z.infer<typeof import("@agent-mail/contracts").actionPlanCancelApprovalResponseSchema>
  > = async (request, context) => {
    try {
      const result = await options.authorityLock.runShared(() =>
        (async () => {
          await assertLiveOperatorAuthority(context, options.loadAuthority);
          return cancelActionApproval(options.database, {
            request,
            context: storageAuthorityContext(context),
            now: now(options),
          });
        })(),
      );
      return {
        approval: {
          state: "cancelled",
          approvalId: result.approvalId,
          planId: result.planId,
          cancelledAt: result.cancelledAt,
        },
        planVersion: result.planVersion,
      };
    } catch (error: unknown) {
      return authorityFailure(error);
    }
  };
  const authorityCommitPlan: ActionPlanService<
    ActionPlanAuthorityCommitRequest,
    z.infer<typeof actionPlanAuthorityCommitResponseSchema>
  > = async (request, context) => {
    try {
      const receipt = await options.authorityLock.runShared(async () => {
        await assertLiveOperatorAuthority(context, options.loadAuthority);
        const input: ApprovalAuthorityConsumeInput = {
          request,
          context: storageAuthorityContext(context),
          now: now(options),
          keyring: await options.loadKeyring(),
        };
        return consumeActionApproval(options.database, input);
      });
      const execution = await options.executeConsumedPlan(receipt, context);
      return actionPlanAuthorityCommitResponseSchema.parse({
        plan: execution.plan,
        results: execution.results,
        consumptionReceipt: receipt,
      });
    } catch (error: unknown) {
      return authorityFailure(error);
    }
  };
  return Object.freeze({ approvePlan, cancelApproval, authorityCommitPlan });
}
