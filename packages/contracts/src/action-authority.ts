import { z } from "zod";
import {
  actionDigestSchema,
  actionInstantSchema,
  actionPlanIdSchema,
  actionPlanSchema,
  perTargetResultSchema,
} from "./action-operations";
import { defineOperation, type OperationDefinition } from "./operation-registry";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function boundedText(name: string, maximum: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, `${name} must be trimmed`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), `${name} has control characters`);
}

function namespacedId(namespace: string): z.ZodString {
  return boundedText(`${namespace} ID`, 256).regex(
    new RegExp(`^${namespace}:[^\\s:\\u0000-\\u001f\\u007f-\\u009f]+$`, "u"),
    `${namespace} ID has the wrong namespace`,
  );
}

export const actionApprovalIdSchema = namespacedId("approval");
export const actionConsumptionReceiptIdSchema = namespacedId("approval-receipt");
export const actionOperatorChallengeIdSchema = namespacedId("operator-challenge");
export const actionOperatorSessionIdSchema = namespacedId("operator-session");
export const actionClaimIdStrictSchema = namespacedId("claim");

export const actionPrincipalIdSchema = boundedText("principal ID", 256);
export const actionCredentialIdSchema = boundedText("credential ID", 256);
export const actionAuthEventIdSchema = boundedText("auth event ID", 256);
export const actionProfileSchema = z.enum([
  "operator-interactive",
  "agent-unattended",
  "internal-action-executor",
]);

export const safePrincipalSchema = z.strictObject({
  principalId: actionPrincipalIdSchema,
  profile: actionProfileSchema,
});

export const actionApprovalStateSchema = z.enum([
  "absent",
  "available",
  "consumed",
  "expired",
  "cancelled",
  "invalidated",
]);

const approvalCommon = {
  approvalId: actionApprovalIdSchema,
  planId: actionPlanIdSchema,
  planVersion: z.number().int().safe().positive(),
  previewDigest: actionDigestSchema,
  targetDigest: actionDigestSchema,
  normalizedIntent: boundedText("normalized intent", 2048),
  issuedAt: actionInstantSchema,
  expiresAt: actionInstantSchema,
};

export const availableApprovalSchema = z.strictObject({
  state: z.literal("available"),
  ...approvalCommon,
  authorizationScope: z.literal("mail:action.commit"),
  approver: z.strictObject({
    principalId: actionPrincipalIdSchema,
    profile: z.literal("operator-interactive"),
  }),
});

export const consumedApprovalSchema = z.strictObject({
  state: z.literal("consumed"),
  ...approvalCommon,
  consumedAt: actionInstantSchema,
  committer: z.strictObject({
    principalId: actionPrincipalIdSchema,
    profile: z.literal("agent-unattended"),
  }),
  receiptId: actionConsumptionReceiptIdSchema,
});

export const closedApprovalSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("expired"),
    ...approvalCommon,
    expiredAt: actionInstantSchema,
  }),
  z.strictObject({
    state: z.literal("cancelled"),
    approvalId: actionApprovalIdSchema,
    planId: actionPlanIdSchema,
    cancelledAt: actionInstantSchema,
  }),
  z.strictObject({
    state: z.literal("invalidated"),
    ...approvalCommon,
    invalidatedAt: actionInstantSchema,
  }),
]);

export const actionApprovalSchema = z.discriminatedUnion("state", [
  availableApprovalSchema,
  consumedApprovalSchema,
  ...closedApprovalSchema.options,
]);
export type ActionApproval = z.infer<typeof actionApprovalSchema>;
export type AvailableApproval = z.infer<typeof availableApprovalSchema>;

export const actionApprovalStateProjectionSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("absent") }),
  availableApprovalSchema,
  consumedApprovalSchema,
  ...closedApprovalSchema.options,
]);

export const actionPlanAuthorityCreateResponseSchema = z.strictObject({
  plan: actionPlanSchema,
  planVersion: z.number().int().safe().positive(),
  previewDigest: actionDigestSchema,
  targetDigest: actionDigestSchema,
  normalizedIntent: boundedText("normalized intent", 2048),
  creator: safePrincipalSchema,
  approvalState: z.literal("absent"),
});

export const actionPlanAuthorityInspectResponseSchema = z.strictObject({
  plan: actionPlanSchema,
  planVersion: z.number().int().safe().positive(),
  previewDigest: actionDigestSchema,
  targetDigest: actionDigestSchema,
  normalizedIntent: boundedText("normalized intent", 2048),
  creator: safePrincipalSchema,
  approval: actionApprovalStateProjectionSchema,
  results: z.array(perTargetResultSchema),
  terminalAudit: z
    .strictObject({
      terminalState: z.enum([
        "completed",
        "partial",
        "failed",
        "rejected",
        "expired",
        "uncertain",
        "restore-quarantined",
      ]),
      terminalAt: actionInstantSchema,
    })
    .nullable(),
});

export const actionPlanApproveRequestSchema = z.strictObject({
  planId: actionPlanIdSchema,
  planVersion: z.number().int().safe().positive(),
  previewDigest: actionDigestSchema,
});
export type ActionPlanApproveRequest = z.infer<typeof actionPlanApproveRequestSchema>;

export const actionPlanApproveResponseSchema = z.strictObject({
  approval: availableApprovalSchema,
});

export const actionPlanCancelApprovalRequestSchema = z.strictObject({
  planId: actionPlanIdSchema,
  approvalId: actionApprovalIdSchema,
  planVersion: z.number().int().safe().positive(),
  previewDigest: actionDigestSchema,
});
export type ActionPlanCancelApprovalRequest = z.infer<typeof actionPlanCancelApprovalRequestSchema>;

export const actionPlanCancelApprovalResponseSchema = z.strictObject({
  approval: z.strictObject({
    state: z.literal("cancelled"),
    approvalId: actionApprovalIdSchema,
    planId: actionPlanIdSchema,
    cancelledAt: actionInstantSchema,
  }),
  planVersion: z.number().int().safe().positive(),
});

export const actionPlanAuthorityCommitRequestSchema = z.strictObject({
  planId: actionPlanIdSchema,
  planVersion: z.number().int().safe().positive(),
  previewDigest: actionDigestSchema,
  approvalId: actionApprovalIdSchema,
});
export type ActionPlanAuthorityCommitRequest = z.infer<
  typeof actionPlanAuthorityCommitRequestSchema
>;

export const consumptionReceiptSchema = z.strictObject({
  receiptId: actionConsumptionReceiptIdSchema,
  approvalId: actionApprovalIdSchema,
  planId: actionPlanIdSchema,
  claimId: actionClaimIdStrictSchema,
  consumedAt: actionInstantSchema,
  committer: z.strictObject({
    principalId: actionPrincipalIdSchema,
    profile: z.literal("agent-unattended"),
  }),
  executorProfile: z.literal("internal-action-executor"),
});
export type ConsumptionReceipt = z.infer<typeof consumptionReceiptSchema>;

export const actionPlanAuthorityCommitResponseSchema = z
  .strictObject({
    plan: actionPlanSchema,
    results: z.array(perTargetResultSchema),
    consumptionReceipt: consumptionReceiptSchema,
  })
  .superRefine(({ plan, results }, context) => {
    for (const [index, result] of results.entries()) {
      if (result.planId !== plan.planId)
        context.addIssue({
          code: "custom",
          path: ["results", index],
          message: "result plan mismatch",
        });
    }
  });

export const operatorSessionRequestSchema = z.strictObject({
  requestedScopes: z.tuple([z.literal("mail:action.create"), z.literal("mail:action.inspect")]),
});

export const operatorSessionResponseSchema = z.strictObject({
  sessionId: actionOperatorSessionIdSchema,
  token: boundedText("operator session token", 256),
  tokenType: z.literal("Bearer"),
  scopes: z.tuple([z.literal("mail:action.create"), z.literal("mail:action.inspect")]),
  issuedAt: actionInstantSchema,
  expiresAt: actionInstantSchema,
});

export type OperatorSessionRequest = z.infer<typeof operatorSessionRequestSchema>;
export type OperatorSessionResponse = z.infer<typeof operatorSessionResponseSchema>;

export const actionAuthorityErrorDetails = {
  empty: z.strictObject({}),
  approval: z.strictObject({ planId: actionPlanIdSchema, approvalId: actionApprovalIdSchema }),
  expiredApproval: z.strictObject({
    planId: actionPlanIdSchema,
    approvalId: actionApprovalIdSchema,
    expiredAt: actionInstantSchema,
  }),
  cancelledApproval: z.strictObject({
    planId: actionPlanIdSchema,
    approvalId: actionApprovalIdSchema,
    cancelledAt: actionInstantSchema,
  }),
  invalidatedApproval: z.strictObject({
    planId: actionPlanIdSchema,
    approvalId: actionApprovalIdSchema,
    invalidatedAt: actionInstantSchema,
  }),
  consumedApproval: z.strictObject({
    planId: actionPlanIdSchema,
    approvalId: actionApprovalIdSchema,
    receiptId: actionConsumptionReceiptIdSchema,
    consumedAt: actionInstantSchema,
  }),
  planVersion: z.strictObject({
    planId: actionPlanIdSchema,
    currentVersion: z.number().int().positive(),
  }),
  planState: z.strictObject({ planId: actionPlanIdSchema, state: z.string().min(1) }),
  expiredPlan: z.strictObject({ planId: actionPlanIdSchema, expiredAt: actionInstantSchema }),
  legacy: z.strictObject({ planId: actionPlanIdSchema }),
};

export const operatorSessionOperation = defineOperation({
  key: "operator-sessions.create",
  route: "/v1/operator-sessions",
  cliName: "operator-sessions-create",
  scope: null,
  request: operatorSessionRequestSchema,
  response: operatorSessionResponseSchema,
  streaming: "none",
  strictness: "strict",
});

export const authorityApproveOperation = defineOperation({
  key: "action-plans.approve",
  route: "/v1/action-plans/{planId}/approvals",
  cliName: "action-plans-approve",
  scope: "mail:action.approve",
  request: actionPlanApproveRequestSchema,
  response: actionPlanApproveResponseSchema,
  streaming: "none",
  strictness: "strict",
});

export const authorityCancelApprovalOperation = defineOperation({
  key: "action-plans.cancel-approval",
  route: "/v1/action-plans/{planId}/approvals/{approvalId}",
  cliName: "action-plans-approval-cancel",
  scope: "mail:action.approve",
  request: actionPlanCancelApprovalRequestSchema,
  response: actionPlanCancelApprovalResponseSchema,
  streaming: "none",
  strictness: "strict",
});

export const actionPlanAuthorityCommitOperation = defineOperation({
  key: "action-plans.commit",
  route: "/v1/action-plans/{planId}/commit",
  cliName: "action-plans-commit",
  scope: "mail:action.commit",
  request: actionPlanAuthorityCommitRequestSchema,
  response: actionPlanAuthorityCommitResponseSchema,
  streaming: "none",
  strictness: "strict",
});

/** Authority-aware public action definitions. Retired authorize is absent. */
export const actionAuthorityOperationDefinitions = [
  operatorSessionOperation,
  authorityApproveOperation,
  authorityCancelApprovalOperation,
  actionPlanAuthorityCommitOperation,
] as const satisfies readonly OperationDefinition[];
