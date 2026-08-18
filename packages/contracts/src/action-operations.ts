import { z } from "zod";
import {
  createOperationRegistry,
  defineOperation,
  type OperationDefinition,
  type OperationSchema,
  type OperationRegistry,
} from "./operation-registry";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function text(name: string, maximum: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, `${name} must be trimmed`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), `${name} has control characters`);
}

function safeDetail(name: string, maximum: number): z.ZodString {
  return text(name, maximum).refine(
    (value) =>
      !/(?:authorization\s*:|bearer\s+\S+|(?:password|passwd|token|secret|api[-_ ]?key)\s*[=:]\s*\S+|:\/\/[^/\s:]+:[^/@\s]+@)/iu.test(
        value,
      ),
    `${name} contains credential material`,
  );
}

function namespacedId(namespace: string, maximum = 256): z.ZodString {
  return text(`${namespace} ID`, maximum).regex(
    new RegExp(`^${namespace}:[^\\s:][^\\u0000-\\u001f\\u007f-\\u009f]*$`, "u"),
    `${namespace} ID has the wrong namespace`,
  );
}

/** Canonical wire representation of a core UTC instant. */
export const actionInstantSchema = text("action instant", 40).refine((value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}, "action instant must be a canonical millisecond UTC timestamp");

export const actionPlanIdSchema = namespacedId("plan");
export const actionAttemptIdSchema = namespacedId("attempt");
export const actionClaimIdSchema = namespacedId("claim");
export const actionAccountIdSchema = namespacedId("account");
export const actionMailboxIdSchema = namespacedId("mailbox");
export const actionDigestSchema = z
  .string()
  .regex(SHA256, "action digest must be a lowercase SHA-256 hexadecimal value");

const positiveSafeIntegerSchema = z.number().int().safe().positive();
const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();

/** A remote target is immutable and carries the exact MODSEQ precondition. */
export const actionPlanTargetSchema = z.strictObject({
  accountId: actionAccountIdSchema,
  mailboxId: actionMailboxIdSchema,
  uidValidity: positiveSafeIntegerSchema,
  uid: positiveSafeIntegerSchema,
  precondition: z.strictObject({ modseq: nonNegativeSafeIntegerSchema }),
});
export type ActionPlanTarget = z.infer<typeof actionPlanTargetSchema>;

function targetIdentity(target: ActionPlanTarget): string {
  return JSON.stringify([target.accountId, target.mailboxId, target.uidValidity, target.uid]);
}

const uniqueTargetsSchema = z
  .array(actionPlanTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    const identities = new Set<string>();
    targets.forEach((target, index) => {
      const identity = targetIdentity(target);
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "action-plan targets must have unique immutable identities",
        });
      }
      identities.add(identity);
    });
  });

export const actionSchema = z.strictObject({
  kind: z.enum(["markSeen", "markUnseen", "moveToArchive", "moveToTrash"]),
});

const planBaseShape = {
  planId: actionPlanIdSchema,
  action: actionSchema,
  targets: uniqueTargetsSchema,
  createdAt: actionInstantSchema,
  expiresAt: actionInstantSchema,
};

const pendingActionPlanInputSchema = z.strictObject({
  state: z.literal("pending"),
  ...planBaseShape,
});
const executingActionPlanInputSchema = z.strictObject({
  state: z.literal("executing"),
  ...planBaseShape,
  claimId: actionClaimIdSchema,
  startedAt: actionInstantSchema,
});
const completedActionPlanInputSchema = z.strictObject({
  state: z.literal("completed"),
  ...planBaseShape,
  completedAt: actionInstantSchema,
});
const partialActionPlanInputSchema = z.strictObject({
  state: z.literal("partial"),
  ...planBaseShape,
  completedAt: actionInstantSchema,
});
const failedActionPlanInputSchema = z.strictObject({
  state: z.literal("failed"),
  ...planBaseShape,
  failedAt: actionInstantSchema,
});
const rejectedActionPlanInputSchema = z.strictObject({
  state: z.literal("rejected"),
  ...planBaseShape,
  rejectedAt: actionInstantSchema,
  reason: text("action-plan reason", 2_048),
});
const expiredActionPlanInputSchema = z.strictObject({
  state: z.literal("expired"),
  ...planBaseShape,
  expiredAt: actionInstantSchema,
});
const uncertainActionPlanInputSchema = z.strictObject({
  state: z.literal("uncertain"),
  ...planBaseShape,
  remoteAttemptId: actionAttemptIdSchema,
  missingLocalResultAt: actionInstantSchema,
});
const restoreQuarantinedActionPlanInputSchema = z.strictObject({
  state: z.literal("restore-quarantined"),
  ...planBaseShape,
});

const actionPlanInputVariantsSchema = z.discriminatedUnion("state", [
  pendingActionPlanInputSchema,
  executingActionPlanInputSchema,
  completedActionPlanInputSchema,
  partialActionPlanInputSchema,
  failedActionPlanInputSchema,
  rejectedActionPlanInputSchema,
  expiredActionPlanInputSchema,
  uncertainActionPlanInputSchema,
  restoreQuarantinedActionPlanInputSchema,
]);

const actionPlanInputSchema = actionPlanInputVariantsSchema.superRefine((plan, context) => {
  const createdAt = Date.parse(plan.createdAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (expiresAt < createdAt) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiry precedes creation" });
  }
  if (plan.state === "executing" && Date.parse(plan.startedAt) < createdAt) {
    context.addIssue({
      code: "custom",
      path: ["startedAt"],
      message: "execution precedes creation",
    });
  }
  if (
    (plan.state === "completed" || plan.state === "partial") &&
    Date.parse(plan.completedAt) < createdAt
  ) {
    context.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "completion precedes creation",
    });
  }
  if (plan.state === "failed") validateFailedActionPlanTemporal(plan, context);
  if (plan.state === "rejected" && Date.parse(plan.rejectedAt) < createdAt) {
    context.addIssue({
      code: "custom",
      path: ["rejectedAt"],
      message: "rejection precedes creation",
    });
  }
  if (plan.state === "expired") validateExpiredActionPlanTemporal(plan, context);
  if (plan.state === "uncertain" && Date.parse(plan.missingLocalResultAt) < createdAt) {
    context.addIssue({
      code: "custom",
      path: ["missingLocalResultAt"],
      message: "missing-result boundary precedes creation",
    });
  }
});

/** Every state-specific field is represented by one strict public variant. */
export const actionPlanSchema = actionPlanInputSchema;
export type ActionPlanContract = z.infer<typeof actionPlanSchema>;

export const pendingActionPlanSchema = pendingActionPlanInputSchema;
export type PendingActionPlanContract = z.infer<typeof pendingActionPlanSchema>;

function validateFailedActionPlanTemporal(
  plan: z.infer<typeof failedActionPlanInputSchema>,
  context: z.RefinementCtx,
): void {
  if (Date.parse(plan.failedAt) < Date.parse(plan.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["failedAt"],
      message: "failure precedes creation",
    });
  }
}

export const failedActionPlanSchema = failedActionPlanInputSchema.superRefine(
  validateFailedActionPlanTemporal,
);
export type FailedActionPlanContract = z.infer<typeof failedActionPlanSchema>;

function validateExpiredActionPlanTemporal(
  plan: z.infer<typeof expiredActionPlanInputSchema>,
  context: z.RefinementCtx,
): void {
  if (Date.parse(plan.expiredAt) < Date.parse(plan.expiresAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiredAt"],
      message: "expiration precedes expiry",
    });
  }
}

export const expiredActionPlanSchema = expiredActionPlanInputSchema.superRefine(
  validateExpiredActionPlanTemporal,
);
export type ExpiredActionPlanContract = z.infer<typeof expiredActionPlanSchema>;

const actionResultBaseShape = {
  planId: actionPlanIdSchema,
  action: actionSchema,
  target: actionPlanTargetSchema,
  attemptId: actionAttemptIdSchema,
  idempotencyKey: text("idempotency key", 256),
  startedAt: actionInstantSchema,
  resultAt: actionInstantSchema,
};

const flagsPostconditionSchema = z.strictObject({
  kind: z.literal("flags"),
  observedAt: actionInstantSchema,
  flags: z.array(text("observed flag", 128)).superRefine((flags, context) => {
    if (new Set(flags).size !== flags.length) {
      context.addIssue({ code: "custom", message: "observed flags must be unique" });
    }
  }),
  modseq: nonNegativeSafeIntegerSchema,
});
const mailboxPostconditionSchema = z.strictObject({
  kind: z.literal("mailbox"),
  observedAt: actionInstantSchema,
  mailboxId: actionMailboxIdSchema,
  uidValidity: positiveSafeIntegerSchema,
  uid: positiveSafeIntegerSchema,
  modseq: nonNegativeSafeIntegerSchema,
});
const serverObservedPostconditionSchema = z.discriminatedUnion("kind", [
  flagsPostconditionSchema,
  mailboxPostconditionSchema,
]);

const successResultInputSchema = z.strictObject({
  kind: z.literal("success"),
  ...actionResultBaseShape,
  certainty: z.literal("definite"),
  postcondition: serverObservedPostconditionSchema,
});
const staleResultInputSchema = z.strictObject({
  kind: z.literal("stale"),
  ...actionResultBaseShape,
  certainty: z.literal("definite"),
  detail: safeDetail("stale result detail", 512),
});
const rejectedResultInputSchema = z.strictObject({
  kind: z.literal("rejected"),
  ...actionResultBaseShape,
  certainty: z.literal("definite"),
  detail: safeDetail("rejected result detail", 512),
});
const failedResultInputSchema = z.strictObject({
  kind: z.literal("failed"),
  ...actionResultBaseShape,
  certainty: z.literal("definite"),
  failureReason: z.enum([
    "server-rejected",
    "permission-denied",
    "target-not-found",
    "transport-failed-before-transmission",
  ]),
  detail: safeDetail("failed result detail", 512),
});
const uncertainResultInputSchema = z.strictObject({
  kind: z.literal("uncertain"),
  ...actionResultBaseShape,
  certainty: z.literal("uncertain"),
  uncertainReason: z.enum([
    "socket-timeout-after-transmission",
    "connection-lost-after-transmission",
    "local-result-not-durable",
  ]),
  detail: safeDetail("uncertain result detail", 512),
});

const remoteAttemptInputSchema = z.strictObject({
  kind: z.literal("attempt"),
  planId: actionPlanIdSchema,
  action: actionSchema,
  target: actionPlanTargetSchema,
  attemptId: actionAttemptIdSchema,
  idempotencyKey: text("idempotency key", 256),
  startedAt: actionInstantSchema,
  certainty: z.literal("unresolved"),
});

/** Publicly inspectable attempt identity; execution remains an internal concern. */
export const remoteAttemptSchema = remoteAttemptInputSchema;
export type RemoteAttemptContract = z.infer<typeof remoteAttemptSchema>;

const remoteAttemptResultVariantsSchema = z.discriminatedUnion("kind", [
  successResultInputSchema,
  staleResultInputSchema,
  rejectedResultInputSchema,
  failedResultInputSchema,
  uncertainResultInputSchema,
]);

const remoteAttemptResultInputSchema = remoteAttemptResultVariantsSchema.superRefine(
  (result, context) => {
    if (Date.parse(result.resultAt) < Date.parse(result.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["resultAt"],
        message: "result precedes attempt start",
      });
    }
    if (result.kind !== "success") return;
    const observedAt = Date.parse(result.postcondition.observedAt);
    if (observedAt < Date.parse(result.startedAt) || observedAt > Date.parse(result.resultAt)) {
      context.addIssue({
        code: "custom",
        path: ["postcondition", "observedAt"],
        message: "postcondition observation is outside attempt/result bounds",
      });
    }
    const expectsFlags = result.action.kind === "markSeen" || result.action.kind === "markUnseen";
    if (expectsFlags !== (result.postcondition.kind === "flags")) {
      context.addIssue({
        code: "custom",
        path: ["postcondition"],
        message: "postcondition contradicts action",
      });
    }
    if (result.postcondition.kind !== "flags") return;
    const hasSeen = result.postcondition.flags.some((flag) => flag.toLowerCase() === "\\seen");
    if (
      (result.action.kind === "markSeen" && !hasSeen) ||
      (result.action.kind === "markUnseen" && hasSeen)
    ) {
      context.addIssue({
        code: "custom",
        path: ["postcondition", "flags"],
        message: "observed flags contradict action",
      });
    }
  },
);

/** Each result retains its own target, precondition, attempt ID, and certainty. */
export const remoteAttemptResultSchema = remoteAttemptResultInputSchema;
export type RemoteAttemptResultContract = z.infer<typeof remoteAttemptResultSchema>;
export const perTargetResultSchema = remoteAttemptResultSchema;
export const uncertainResultSchema = uncertainResultInputSchema;
export type UncertainResultContract = z.infer<typeof uncertainResultSchema>;

const perTargetResultsSchema = z.array(remoteAttemptResultSchema);

export const actionPlanCreateRequestSchema = z.strictObject({
  action: actionSchema,
  targets: uniqueTargetsSchema,
});
export type ActionPlanCreateRequest = z.input<typeof actionPlanCreateRequestSchema>;

export const actionPlanInspectRequestSchema = z.strictObject({ planId: actionPlanIdSchema });

const actionPlanAuthorityCreatorSchema = z.strictObject({
  principalId: text("principal ID", 256),
  profile: z.enum(["operator-interactive", "agent-unattended", "internal-action-executor"]),
});
const actionPlanAuthorityApprovalSchema = z.union([
  z.literal("absent"),
  z.strictObject({
    state: z.literal("available"),
    approvalId: namespacedId("approval"),
    planId: actionPlanIdSchema,
    planVersion: positiveSafeIntegerSchema,
    previewDigest: actionDigestSchema,
    targetDigest: actionDigestSchema,
    normalizedIntent: text("normalized intent", 2_048),
    issuedAt: actionInstantSchema,
    expiresAt: actionInstantSchema,
    authorizationScope: z.literal("mail:action.commit"),
    approver: z.strictObject({
      principalId: text("principal ID", 256),
      profile: z.literal("operator-interactive"),
    }),
  }),
  z.strictObject({
    state: z.literal("consumed"),
    approvalId: namespacedId("approval"),
    planId: actionPlanIdSchema,
    planVersion: positiveSafeIntegerSchema,
    previewDigest: actionDigestSchema,
    targetDigest: actionDigestSchema,
    normalizedIntent: text("normalized intent", 2_048),
    issuedAt: actionInstantSchema,
    expiresAt: actionInstantSchema,
    consumedAt: actionInstantSchema,
    committer: z.strictObject({
      principalId: text("principal ID", 256),
      profile: z.literal("agent-unattended"),
    }),
    receiptId: namespacedId("approval-receipt"),
  }),
  z.strictObject({
    state: z.literal("expired"),
    approvalId: namespacedId("approval"),
    planId: actionPlanIdSchema,
    expiredAt: actionInstantSchema,
  }),
  z.strictObject({
    state: z.literal("cancelled"),
    approvalId: namespacedId("approval"),
    planId: actionPlanIdSchema,
    cancelledAt: actionInstantSchema,
  }),
  z.strictObject({
    state: z.literal("invalidated"),
    approvalId: namespacedId("approval"),
    planId: actionPlanIdSchema,
    invalidatedAt: actionInstantSchema,
  }),
]);
const actionPlanTerminalAuditSchema = z.strictObject({
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
  executorDisposition: z.enum(["started", "never-started-after-restore", "unknown-after-restore"]),
  effectAttemptCount: nonNegativeSafeIntegerSchema,
  effectAuthoritySetDigest: actionDigestSchema,
  executorInstanceId: text("executor instance ID", 256),
  finalizerKind: z.enum(["effect-executor", "ordinary-recovery", "restore-admission"]),
  finalizerInstanceId: text("finalizer instance ID", 256),
  reasonCode: z.enum(["normal-finalization", "explicit-database-restore"]),
  restoreEventId: text("restore event ID", 256),
  resultDigest: actionDigestSchema,
});

export const actionPlanPreviewResponseSchema = z.strictObject({
  plan: pendingActionPlanSchema,
  digest: actionDigestSchema,
  planVersion: positiveSafeIntegerSchema,
  previewDigest: actionDigestSchema,
  targetDigest: actionDigestSchema,
  normalizedIntent: text("normalized intent", 2_048),
  creator: actionPlanAuthorityCreatorSchema,
  approvalState: actionPlanAuthorityApprovalSchema,
});

function validateResultsForPlan(
  plan: z.infer<typeof actionPlanSchema>,
  results: readonly z.infer<typeof remoteAttemptResultSchema>[],
  context: z.RefinementCtx,
): void {
  const planTargets = new Set(plan.targets.map(targetIdentity));
  const attemptIds = new Set<string>();
  for (const [index, result] of results.entries()) {
    if (result.planId !== plan.planId || result.action.kind !== plan.action.kind) {
      context.addIssue({
        code: "custom",
        path: ["results", index],
        message: "result plan identity or action does not match the plan",
      });
    }
    if (!planTargets.has(targetIdentity(result.target))) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "target"],
        message: "result target is not one of the frozen plan targets",
      });
    }
    if (attemptIds.has(result.attemptId)) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "attemptId"],
        message: "result attempt identities must be unique",
      });
    }
    attemptIds.add(result.attemptId);
  }
  if (
    plan.state === "uncertain" &&
    !results.some(
      (result) => result.kind === "uncertain" && result.attemptId === plan.remoteAttemptId,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["results"],
      message: "uncertain plan must retain its matching uncertain attempt result",
    });
  }
}

export const actionPlanInspectResponseSchema = z
  .strictObject({
    plan: actionPlanSchema,
    results: perTargetResultsSchema,
    planVersion: positiveSafeIntegerSchema,
    previewDigest: actionDigestSchema,
    targetDigest: actionDigestSchema,
    normalizedIntent: text("normalized intent", 2_048),
    creator: actionPlanAuthorityCreatorSchema,
    approvalState: actionPlanAuthorityApprovalSchema,
    terminalAudit: z.union([z.literal("absent"), actionPlanTerminalAuditSchema]),
  })
  .superRefine(({ plan, results }, context) => validateResultsForPlan(plan, results, context));

/** Reconciliation is a result-level contract, not an executor endpoint. */
export const uncertainReconciliationRequestSchema = z
  .strictObject({
    planId: actionPlanIdSchema,
    attemptId: actionAttemptIdSchema,
    result: uncertainResultSchema,
  })
  .superRefine((request, context) => {
    if (request.planId !== request.result.planId) {
      context.addIssue({
        code: "custom",
        path: ["planId"],
        message: "plan identity does not match result",
      });
    }
    if (request.attemptId !== request.result.attemptId) {
      context.addIssue({
        code: "custom",
        path: ["attemptId"],
        message: "attempt identity does not match result",
      });
    }
  });
export const uncertainReconciliationResponseSchema = z.strictObject({
  plan: actionPlanSchema,
  result: remoteAttemptResultSchema,
});

export const actionPlanCreateOperation = defineOperation({
  key: "action-plans.create",
  route: "/v1/action-plans",
  cliName: "action-plans-create",
  scope: "mail:action.create",
  request: actionPlanCreateRequestSchema,
  response: actionPlanPreviewResponseSchema,
  streaming: "none",
  strictness: "strict",
});

export const actionPlanInspectOperation = defineOperation({
  key: "action-plans.inspect",
  route: "/v1/action-plans/{planId}",
  cliName: "action-plans-inspect",
  scope: "mail:action.inspect",
  request: actionPlanInspectRequestSchema,
  response: actionPlanInspectResponseSchema,
  streaming: "none",
  strictness: "strict",
});

/** Authority-v1 request/response contracts. Identity and intent are server-bound. */
export const actionPlanApproveRequestV1Schema = z.strictObject({
  planId: actionPlanIdSchema,
  planVersion: positiveSafeIntegerSchema,
  previewDigest: actionDigestSchema,
});
export const actionPlanApproveResponseV1Schema = z.strictObject({
  approval: z.strictObject({
    state: z.literal("available"),
    approvalId: namespacedId("approval"),
    planId: actionPlanIdSchema,
    planVersion: positiveSafeIntegerSchema,
    previewDigest: actionDigestSchema,
    targetDigest: actionDigestSchema,
    normalizedIntent: text("normalized intent", 2048),
    issuedAt: actionInstantSchema,
    expiresAt: actionInstantSchema,
    authorizationScope: z.literal("mail:action.commit"),
    approver: z.strictObject({
      principalId: text("principal ID", 256),
      profile: z.literal("operator-interactive"),
    }),
  }),
});
export const actionPlanCancelApprovalRequestV1Schema = z.strictObject({
  planId: actionPlanIdSchema,
  approvalId: namespacedId("approval"),
  planVersion: positiveSafeIntegerSchema,
  previewDigest: actionDigestSchema,
});
export const actionPlanCancelApprovalResponseV1Schema = z.strictObject({
  approval: z.strictObject({
    state: z.literal("cancelled"),
    approvalId: namespacedId("approval"),
    planId: actionPlanIdSchema,
    cancelledAt: actionInstantSchema,
  }),
  planVersion: positiveSafeIntegerSchema,
});
export const actionPlanCommitRequestV1Schema = z.strictObject({
  planId: actionPlanIdSchema,
  planVersion: positiveSafeIntegerSchema,
  previewDigest: actionDigestSchema,
  approvalId: namespacedId("approval"),
});
export const actionPlanCommitResponseV1Schema = z
  .strictObject({
    plan: actionPlanSchema,
    results: perTargetResultsSchema,
    consumptionReceipt: z.strictObject({
      receiptId: namespacedId("approval-receipt"),
      approvalId: namespacedId("approval"),
      planId: actionPlanIdSchema,
      claimId: actionClaimIdSchema,
      consumedAt: actionInstantSchema,
      committer: z.strictObject({
        principalId: text("principal ID", 256),
        profile: z.literal("agent-unattended"),
      }),
      executorProfile: z.literal("internal-action-executor"),
    }),
  })
  .superRefine(({ plan, results }, context) => validateResultsForPlan(plan, results, context));

export const actionPlanApproveOperation = defineOperation({
  key: "action-plans.approve",
  route: "/v1/action-plans/{planId}/approvals",
  cliName: "action-plans-approve",
  scope: "mail:action.approve",
  request: actionPlanApproveRequestV1Schema,
  response: actionPlanApproveResponseV1Schema,
  streaming: "none",
  strictness: "strict",
});

export const actionPlanCancelApprovalOperation = defineOperation({
  key: "action-plans.cancel-approval",
  route: "/v1/action-plans/{planId}/approvals/{approvalId}",
  cliName: "action-plans-approval-cancel",
  scope: "mail:action.approve",
  request: actionPlanCancelApprovalRequestV1Schema,
  response: actionPlanCancelApprovalResponseV1Schema,
  streaming: "none",
  strictness: "strict",
});

export const actionPlanCommitOperation = defineOperation({
  key: "action-plans.commit",
  route: "/v1/action-plans/{planId}/commit",
  cliName: "action-plans-commit",
  scope: "mail:action.commit",
  request: actionPlanCommitRequestV1Schema,
  response: actionPlanCommitResponseV1Schema,
  streaming: "none",
  strictness: "strict",
});

export const actionPlanOperationDefinitions = [
  actionPlanCreateOperation,
  actionPlanInspectOperation,
  actionPlanApproveOperation,
  actionPlanCancelApprovalOperation,
  actionPlanCommitOperation,
] as const satisfies readonly OperationDefinition<OperationSchema, OperationSchema>[];

/**
 * Action operations are user-intent surfaces. A raw executor-shaped entry is
 * rejected before a local action registry or the parent registry can consume it.
 */
export function assertPublicActionOperation(definition: OperationDefinition): OperationDefinition {
  const expected = actionPlanOperationDefinitions.find(({ key }) => key === definition.key);
  if (
    expected === undefined ||
    expected.route !== definition.route ||
    expected.cliName !== definition.cliName ||
    expected.scope !== definition.scope ||
    expected.streaming !== definition.streaming ||
    expected.strictness !== definition.strictness ||
    expected.request !== definition.request ||
    expected.response !== definition.response
  ) {
    throw new TypeError(`executor-shaped operation ${definition.key} is not public`);
  }
  return definition;
}

export function createActionOperationRegistry(
  definitions: readonly OperationDefinition[],
): OperationRegistry {
  definitions.forEach(assertPublicActionOperation);
  return createOperationRegistry(definitions);
}

actionPlanOperationDefinitions.forEach(assertPublicActionOperation);

// Stable aliases for the non-authority create/inspect/commit operation names.
export const actionPreviewOperation = actionPlanCreateOperation;
export const actionInspectOperation = actionPlanInspectOperation;
export const actionCommitOperation = actionPlanCommitOperation;
export const actionOperations = actionPlanOperationDefinitions;
