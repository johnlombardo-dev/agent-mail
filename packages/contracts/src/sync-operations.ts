import { z } from "zod";
import { correlationIdSchema, createErrorRegistry, defineError } from "./error-envelope";
import { defineOperation, type OperationDefinition } from "./operation-registry";

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value, "text must be trimmed")
    .refine((value) => !hasControlCharacters(value), "text contains control characters");

const safeDetail = (max: number) =>
  boundedText(max).refine(
    (value) =>
      !/(?:authorization\s*:|bearer\s+\S+|(?:password|passwd|token|secret|api[-_ ]?key)\s*[=:]\s*\S+|:\/\/[^/\s:]+:[^/@\s]+@)/iu.test(
        value,
      ),
    "detail contains credential material",
  );

const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const commandIdSchema = boundedText(256);
const idempotencyKeySchema = boundedText(256);

/** A process-local lifecycle identity. Versions are comparable only inside one identity. */
export const syncIncarnationIdSchema = boundedText(256);
export type SyncIncarnationId = z.infer<typeof syncIncarnationIdSchema>;

/** States exposed by the sync actor, matching the lifecycle in PLAN.md. */
export const syncActorStateSchema = z.enum([
  "stopped",
  "starting",
  "backfilling",
  "watching",
  "sweeping",
  "retrying",
  "authBlocked",
  "paused",
  "stopping",
]);
export type SyncActorState = z.infer<typeof syncActorStateSchema>;

export const syncControlCommandSchema = z.enum(["start", "pause", "resume", "stop"]);
export type SyncControlCommand = z.infer<typeof syncControlCommandSchema>;
export const syncIdempotentControlCommandSchema = z.enum(["pause", "resume", "stop"]);
export type SyncIdempotentControlCommand = z.infer<typeof syncIdempotentControlCommandSchema>;

/** The durable work currently represented by a status response. */
export const syncActiveOperationSchema = z.enum([
  "start",
  "backfill",
  "watch",
  "sweep",
  "retry",
  "stop",
]);
export type SyncActiveOperation = z.infer<typeof syncActiveOperationSchema>;

/** A bounded progress summary; it is not a promise that a sweep is complete. */
export const syncCheckpointSummarySchema = z.strictObject({
  completedMailboxes: nonNegativeInteger,
  totalMailboxes: nonNegativeInteger,
  completedMessages: nonNegativeInteger,
  pendingMessages: nonNegativeInteger,
  lastMailbox: boundedText(256).nullable(),
  lastUid: nonNegativeInteger.nullable(),
});
export type SyncCheckpointSummary = z.infer<typeof syncCheckpointSummarySchema>;

/** Safe detail explaining why credentials currently block automatic progress. */
export const syncAuthBlockedDetailSchema = z.strictObject({
  reason: z.enum(["credentials-missing", "credentials-invalid", "provider-rejected"]),
  detail: safeDetail(500),
});
export type SyncAuthBlockedDetail = z.infer<typeof syncAuthBlockedDetailSchema>;

/** Diagnostics are bounded and intentionally contain no exception or credential fields. */
export const syncDiagnosticSchema = z.strictObject({
  code: boundedText(80),
  message: safeDetail(500),
});
export const syncDiagnosticsSchema = z.array(syncDiagnosticSchema).max(32);
export type SyncDiagnostic = z.infer<typeof syncDiagnosticSchema>;

const statusFields = {
  incarnationId: syncIncarnationIdSchema,
  version: nonNegativeInteger,
  checkpoint: syncCheckpointSummarySchema,
  diagnostics: syncDiagnosticsSchema,
};

const statusWithoutAuth = <
  const TState extends Exclude<SyncActorState, "authBlocked">,
  const TOperation extends SyncActiveOperation | null,
>(
  actorState: TState,
  activeOperation: TOperation,
) =>
  z.strictObject({
    actorState: z.literal(actorState),
    activeOperation: z.literal(activeOperation),
    authBlocked: z.null(),
    ...statusFields,
  });

/** Status makes auth-blocked detail and actor state a constructive invariant. */
export const syncStatusResponseSchema = z.discriminatedUnion("actorState", [
  statusWithoutAuth("stopped", null),
  statusWithoutAuth("starting", "start"),
  statusWithoutAuth("backfilling", "backfill"),
  statusWithoutAuth("watching", "watch"),
  statusWithoutAuth("sweeping", "sweep"),
  statusWithoutAuth("retrying", "retry"),
  z.strictObject({
    actorState: z.literal("authBlocked"),
    activeOperation: z.null(),
    authBlocked: syncAuthBlockedDetailSchema,
    ...statusFields,
  }),
  statusWithoutAuth("paused", null),
  statusWithoutAuth("stopping", "stop"),
]);
export type SyncStatusResponse = z.infer<typeof syncStatusResponseSchema>;

const observedActorFields = {
  incarnationId: syncIncarnationIdSchema,
  version: nonNegativeInteger,
};

/** A control response observes the actor separately from the accepted command identity. */
export const syncObservedActorSchema = z.strictObject({
  actorState: syncActorStateSchema,
  ...observedActorFields,
});
export type SyncObservedActor = z.infer<typeof syncObservedActorSchema>;

export const syncObservationOrderSchema = z.enum(["before", "equal", "after", "unordered"]);
export type SyncObservationOrder = z.infer<typeof syncObservationOrderSchema>;

/** Compare versions only when both observations belong to the same incarnation. */
export function compareSyncObservations(
  left: Pick<SyncObservedActor, "incarnationId" | "version">,
  right: Pick<SyncObservedActor, "incarnationId" | "version">,
): SyncObservationOrder {
  if (left.incarnationId !== right.incarnationId) return "unordered";
  if (left.version < right.version) return "before";
  if (left.version > right.version) return "after";
  return "equal";
}

const acceptedResponse = <TObserved extends z.ZodType>(observed: TObserved) =>
  z.strictObject({
    accepted: z.literal(true),
    commandId: commandIdSchema,
    observed,
  });

const completedResponse = <TObserved extends z.ZodType>(observed: TObserved) =>
  z.strictObject({
    accepted: z.literal(true),
    commandId: commandIdSchema,
    completed: z.literal(true),
    observed,
  });

const startAcceptedObservedActorSchema = z.strictObject({
  actorState: z.enum(["starting", "backfilling", "sweeping", "retrying"]),
  ...observedActorFields,
});
const pauseCompletedObservedActorSchema = z.strictObject({
  actorState: z.literal("paused"),
  ...observedActorFields,
});
const resumeAcceptedObservedActorSchema = z.strictObject({
  actorState: z.literal("starting"),
  ...observedActorFields,
});
const resumeCompletedObservedActorSchema = z.strictObject({
  actorState: z.enum(["backfilling", "watching", "sweeping", "retrying"]),
  ...observedActorFields,
});
const startCompletedObservedActorSchema = z.strictObject({
  actorState: z.literal("watching"),
  ...observedActorFields,
});
const stopCompletedObservedActorSchema = z.strictObject({
  actorState: z.literal("stopped"),
  ...observedActorFields,
});

const syncControlErrorBaseFields = {
  commandId: commandIdSchema,
  command: syncControlCommandSchema,
  actorState: syncActorStateSchema,
  version: nonNegativeInteger,
  incarnationId: syncIncarnationIdSchema,
};
const syncIdempotentControlErrorBaseFields = {
  ...syncControlErrorBaseFields,
  command: syncIdempotentControlCommandSchema,
};

export const syncControlRejectedReasonSchema = z.enum([
  "stale-version",
  "incompatible-state",
  "busy",
  "shutdown-terminal",
]);
export const syncControlFailedReasonSchema = z.enum(["terminal-failure", "auth-blocked"]);
export const syncControlCancelledReasonSchema = z.enum([
  "superseded-by-stop",
  "superseded-by-restart",
  "superseded-by-shutdown",
  "superseded-by-incompatible-command",
]);

export type SyncControlRejectedReason = z.infer<typeof syncControlRejectedReasonSchema>;
export type SyncControlFailedReason = z.infer<typeof syncControlFailedReasonSchema>;
export type SyncControlCancelledReason = z.infer<typeof syncControlCancelledReasonSchema>;

export const syncControlRejectedDetailsSchema = z.strictObject({
  ...syncControlErrorBaseFields,
  reason: syncControlRejectedReasonSchema,
});
export const syncControlFailedDetailsSchema = z.strictObject({
  ...syncControlErrorBaseFields,
  reason: syncControlFailedReasonSchema,
});
export const syncControlCancelledDetailsSchema = z.strictObject({
  ...syncControlErrorBaseFields,
  reason: syncControlCancelledReasonSchema,
});
export const syncControlTimeoutDetailsSchema = z.strictObject({
  ...syncControlErrorBaseFields,
  reason: z.literal("deadline-elapsed"),
  deadlineMs: positiveSafeInteger.max(300_000),
});
export const syncControlIdempotencyConflictDetailsSchema = z.strictObject({
  ...syncIdempotentControlErrorBaseFields,
  reason: z.literal("key-reused-with-different-fingerprint"),
  idempotencyKey: idempotencyKeySchema,
});
export const syncControlCapacityDetailsSchema = z.strictObject({
  ...syncIdempotentControlErrorBaseFields,
  reason: z.literal("all-retained-entries-in-flight"),
  capacity: positiveSafeInteger.max(10_000),
});

const rejectedMessage = "Sync control was rejected.";
const failedMessage = "Sync control failed before completion.";
const cancelledMessage = "Sync control was superseded.";
const timeoutMessage = "Sync control did not complete before the deadline.";
const conflictMessage = "Sync control idempotency key conflicts with an earlier request.";
const capacityMessage = "Sync control idempotency capacity is exhausted.";

export const syncControlRejectedErrorDefinition = defineError({
  code: "sync.control-rejected",
  message: rejectedMessage,
  details: syncControlRejectedDetailsSchema,
});
export const syncControlFailedErrorDefinition = defineError({
  code: "sync.control-failed",
  message: failedMessage,
  details: syncControlFailedDetailsSchema,
});
export const syncControlCancelledErrorDefinition = defineError({
  code: "sync.control-cancelled",
  message: cancelledMessage,
  details: syncControlCancelledDetailsSchema,
});
export const syncControlTimeoutErrorDefinition = defineError({
  code: "sync.control-timeout",
  message: timeoutMessage,
  details: syncControlTimeoutDetailsSchema,
});
export const syncControlIdempotencyConflictErrorDefinition = defineError({
  code: "sync.control-idempotency-conflict",
  message: conflictMessage,
  details: syncControlIdempotencyConflictDetailsSchema,
});
export const syncControlCapacityErrorDefinition = defineError({
  code: "sync.control-capacity",
  message: capacityMessage,
  details: syncControlCapacityDetailsSchema,
});

/** The complete sync-control error registry. Each stable code is registered once. */
export const syncControlErrorDefinitions = Object.freeze([
  syncControlRejectedErrorDefinition,
  syncControlFailedErrorDefinition,
  syncControlCancelledErrorDefinition,
  syncControlTimeoutErrorDefinition,
  syncControlIdempotencyConflictErrorDefinition,
  syncControlCapacityErrorDefinition,
]);
export const syncControlErrorRegistry = createErrorRegistry(syncControlErrorDefinitions);

export const syncControlRejectedErrorSchema = z.strictObject({
  code: z.literal("sync.control-rejected"),
  message: z.literal(rejectedMessage),
  correlationId: correlationIdSchema,
  details: syncControlRejectedDetailsSchema,
});
export const syncControlFailedErrorSchema = z.strictObject({
  code: z.literal("sync.control-failed"),
  message: z.literal(failedMessage),
  correlationId: correlationIdSchema,
  details: syncControlFailedDetailsSchema,
});
export const syncControlCancelledErrorSchema = z.strictObject({
  code: z.literal("sync.control-cancelled"),
  message: z.literal(cancelledMessage),
  correlationId: correlationIdSchema,
  details: syncControlCancelledDetailsSchema,
});
export const syncControlTimeoutErrorSchema = z.strictObject({
  code: z.literal("sync.control-timeout"),
  message: z.literal(timeoutMessage),
  correlationId: correlationIdSchema,
  details: syncControlTimeoutDetailsSchema,
});
export const syncControlIdempotencyConflictErrorSchema = z.strictObject({
  code: z.literal("sync.control-idempotency-conflict"),
  message: z.literal(conflictMessage),
  correlationId: correlationIdSchema,
  details: syncControlIdempotencyConflictDetailsSchema,
});
export const syncControlCapacityErrorSchema = z.strictObject({
  code: z.literal("sync.control-capacity"),
  message: z.literal(capacityMessage),
  correlationId: correlationIdSchema,
  details: syncControlCapacityDetailsSchema,
});

export const syncControlErrorResponseSchema = z.union([
  syncControlRejectedErrorSchema,
  syncControlFailedErrorSchema,
  syncControlCancelledErrorSchema,
  syncControlTimeoutErrorSchema,
  syncControlIdempotencyConflictErrorSchema,
  syncControlCapacityErrorSchema,
]);
export type SyncControlErrorResponse = z.infer<typeof syncControlErrorResponseSchema>;

const startErrorCodes = new Set([
  "sync.control-rejected",
  "sync.control-failed",
  "sync.control-cancelled",
  "sync.control-timeout",
]);
const idempotentControlErrorCodes = new Set(syncControlErrorRegistry.codes);

const syncControlErrorForCommand = (
  command: SyncControlCommand,
  allowedCodes: ReadonlySet<string>,
) =>
  syncControlErrorResponseSchema.superRefine((error, context) => {
    if (error.details.command !== command)
      context.addIssue({ code: "custom", message: `error command must be ${command}` });
    if (!allowedCodes.has(error.code))
      context.addIssue({
        code: "custom",
        message: `error ${error.code} does not apply to ${command}`,
      });
  });

export const syncStartErrorResponseSchema = syncControlErrorForCommand("start", startErrorCodes);
export const syncPauseErrorResponseSchema = syncControlErrorForCommand(
  "pause",
  idempotentControlErrorCodes,
);
export const syncResumeErrorResponseSchema = syncControlErrorForCommand(
  "resume",
  idempotentControlErrorCodes,
);
export const syncStopErrorResponseSchema = syncControlErrorForCommand(
  "stop",
  idempotentControlErrorCodes,
);

/** Status is read-only and intentionally has no request payload. */
export const syncStatusRequestSchema = z.strictObject({});

/** Start is safe to retry through the operation boundary; controls below carry explicit keys. */
export const syncStartRequestSchema = z.strictObject({});
export const syncPauseRequestSchema = z.strictObject({ idempotencyKey: idempotencyKeySchema });
export const syncResumeRequestSchema = z.strictObject({ idempotencyKey: idempotencyKeySchema });
export const syncStopRequestSchema = z.strictObject({ idempotencyKey: idempotencyKeySchema });

export type SyncStartRequest = z.infer<typeof syncStartRequestSchema>;
export type SyncPauseRequest = z.infer<typeof syncPauseRequestSchema>;
export type SyncResumeRequest = z.infer<typeof syncResumeRequestSchema>;
export type SyncStopRequest = z.infer<typeof syncStopRequestSchema>;

export const syncStartResponseSchema = z.union([
  acceptedResponse(startAcceptedObservedActorSchema),
  completedResponse(startCompletedObservedActorSchema),
  syncStartErrorResponseSchema,
]);
export const syncPauseResponseSchema = z.union([
  completedResponse(pauseCompletedObservedActorSchema),
  syncPauseErrorResponseSchema,
]);
export const syncResumeResponseSchema = z.union([
  acceptedResponse(resumeAcceptedObservedActorSchema),
  completedResponse(resumeCompletedObservedActorSchema),
  syncResumeErrorResponseSchema,
]);
export const syncStopResponseSchema = z.union([
  completedResponse(stopCompletedObservedActorSchema),
  syncStopErrorResponseSchema,
]);

export type SyncStartResponse = z.infer<typeof syncStartResponseSchema>;
export type SyncPauseResponse = z.infer<typeof syncPauseResponseSchema>;
export type SyncResumeResponse = z.infer<typeof syncResumeResponseSchema>;
export type SyncStopResponse = z.infer<typeof syncStopResponseSchema>;

export type SyncControlIdempotencyEffect =
  | "not-applicable"
  | "retain-byte-identical-result-until-fixed-expiry"
  | "return-byte-identical-cached-result-without-extending-expiry"
  | "preserve-existing-entry"
  | "no-entry-created"
  | "discard-old-incarnation-map";
export type SyncControlWaiterEffect =
  | "remove-decision-listener-and-snapshot-subscription-and-clear-deadline"
  | "no-waiter-or-deadline-created"
  | "process-teardown-removes-listeners-subscription-and-deadline";
export type SyncControlObservationSource =
  | "current-real-observation"
  | "cached-real-observation"
  | "first-real-observation-from-new-incarnation";

type SyncControlDirectiveBase = Readonly<{
  readonly idempotency: SyncControlIdempotencyEffect;
  readonly waiter: SyncControlWaiterEffect;
  readonly lastObservation: SyncControlObservationSource;
}>;

export type SyncControlCompletedDirective = SyncControlDirectiveBase &
  Readonly<{
    readonly settlement: "completed";
    readonly response: "accepted" | "completed" | "cached-byte-identical-success";
    readonly errorCode: null;
    readonly reason: null;
  }>;
export type SyncControlRejectedDirective = SyncControlDirectiveBase &
  Readonly<{
    readonly settlement: "rejected";
    readonly response: "error" | "cached-byte-identical-error";
    readonly errorCode: "sync.control-rejected";
    readonly reason: SyncControlRejectedReason | "preserve-cached-registered-reason";
  }>;
export type SyncControlFailedDirective = SyncControlDirectiveBase &
  Readonly<{
    readonly settlement: "failed";
    readonly response: "error" | "cached-byte-identical-error";
    readonly errorCode: "sync.control-failed";
    readonly reason: SyncControlFailedReason | "preserve-cached-registered-reason";
  }>;
export type SyncControlCancelledDirective = SyncControlDirectiveBase &
  Readonly<{
    readonly settlement: "cancelled";
    readonly response: "error" | "cached-byte-identical-error";
    readonly errorCode: "sync.control-cancelled";
    readonly reason: SyncControlCancelledReason | "preserve-cached-registered-reason";
  }>;
export type SyncControlTimeoutDirective = SyncControlDirectiveBase &
  Readonly<{
    readonly settlement: "timeout";
    readonly response: "error" | "cached-byte-identical-error";
    readonly errorCode: "sync.control-timeout";
    readonly reason: "deadline-elapsed";
  }>;
export type SyncControlConflictDirective = SyncControlDirectiveBase &
  Readonly<{
    readonly settlement: "conflict";
    readonly response: "error";
    readonly errorCode: "sync.control-idempotency-conflict";
    readonly reason: "key-reused-with-different-fingerprint";
  }>;
export type SyncControlCapacityDirective = SyncControlDirectiveBase &
  Readonly<{
    readonly settlement: "capacity";
    readonly response: "error";
    readonly errorCode: "sync.control-capacity";
    readonly reason: "all-retained-entries-in-flight";
  }>;

export type SyncControlResolverDirective =
  | SyncControlCompletedDirective
  | SyncControlRejectedDirective
  | SyncControlFailedDirective
  | SyncControlCancelledDirective
  | SyncControlTimeoutDirective
  | SyncControlConflictDirective
  | SyncControlCapacityDirective;

const settledWaiter = "remove-decision-listener-and-snapshot-subscription-and-clear-deadline";
const noWaiter = "no-waiter-or-deadline-created";
const currentObservation = "current-real-observation";
const cachedObservation = "cached-real-observation";
const unkeyed = "not-applicable";
const retained = "retain-byte-identical-result-until-fixed-expiry";

const completed = (
  response: SyncControlCompletedDirective["response"],
  idempotency: SyncControlIdempotencyEffect,
  waiter: SyncControlWaiterEffect = settledWaiter,
  lastObservation: SyncControlObservationSource = currentObservation,
): SyncControlCompletedDirective =>
  Object.freeze({
    settlement: "completed",
    response,
    errorCode: null,
    reason: null,
    idempotency,
    waiter,
    lastObservation,
  });
const rejected = (
  reason: SyncControlRejectedDirective["reason"],
  idempotency: SyncControlIdempotencyEffect,
  response: SyncControlRejectedDirective["response"] = "error",
  waiter: SyncControlWaiterEffect = settledWaiter,
  lastObservation: SyncControlObservationSource = currentObservation,
): SyncControlRejectedDirective =>
  Object.freeze({
    settlement: "rejected",
    response,
    errorCode: "sync.control-rejected",
    reason,
    idempotency,
    waiter,
    lastObservation,
  });
const failed = (
  reason: SyncControlFailedDirective["reason"],
  idempotency: SyncControlIdempotencyEffect,
  response: SyncControlFailedDirective["response"] = "error",
  waiter: SyncControlWaiterEffect = settledWaiter,
  lastObservation: SyncControlObservationSource = currentObservation,
): SyncControlFailedDirective =>
  Object.freeze({
    settlement: "failed",
    response,
    errorCode: "sync.control-failed",
    reason,
    idempotency,
    waiter,
    lastObservation,
  });
const cancelled = (
  reason: SyncControlCancelledDirective["reason"],
  idempotency: SyncControlIdempotencyEffect,
  response: SyncControlCancelledDirective["response"] = "error",
  waiter: SyncControlWaiterEffect = settledWaiter,
  lastObservation: SyncControlObservationSource = currentObservation,
): SyncControlCancelledDirective =>
  Object.freeze({
    settlement: "cancelled",
    response,
    errorCode: "sync.control-cancelled",
    reason,
    idempotency,
    waiter,
    lastObservation,
  });
const timeout = (
  idempotency: SyncControlIdempotencyEffect,
  response: SyncControlTimeoutDirective["response"] = "error",
  waiter: SyncControlWaiterEffect = settledWaiter,
  lastObservation: SyncControlObservationSource = currentObservation,
): SyncControlTimeoutDirective =>
  Object.freeze({
    settlement: "timeout",
    response,
    errorCode: "sync.control-timeout",
    reason: "deadline-elapsed",
    idempotency,
    waiter,
    lastObservation,
  });
const conflict = (): SyncControlConflictDirective =>
  Object.freeze({
    settlement: "conflict",
    response: "error",
    errorCode: "sync.control-idempotency-conflict",
    reason: "key-reused-with-different-fingerprint",
    idempotency: "preserve-existing-entry",
    waiter: noWaiter,
    lastObservation: currentObservation,
  });
const capacity = (): SyncControlCapacityDirective =>
  Object.freeze({
    settlement: "capacity",
    response: "error",
    errorCode: "sync.control-capacity",
    reason: "all-retained-entries-in-flight",
    idempotency: "no-entry-created",
    waiter: noWaiter,
    lastObservation: currentObservation,
  });

export type SyncCommonResolverOrdering =
  | "auth-blocked"
  | "terminal-failure"
  | "cleanup-failure"
  | "superseded-by-stop"
  | "superseded-by-restart"
  | "superseded-by-shutdown"
  | "superseded-by-incompatible-command"
  | "stale-version"
  | "incompatible-state"
  | "busy"
  | "shutdown-terminal"
  | "deadline-elapsed"
  | "process-reconstruction";
export type SyncIdempotencyResolverOrdering =
  | "idempotency-replay-completed"
  | "idempotency-replay-rejected"
  | "idempotency-replay-failed"
  | "idempotency-replay-cancelled"
  | "idempotency-replay-timeout"
  | "idempotency-conflict"
  | "capacity-exhausted";
export type SyncStartResolverOrdering =
  | "success-starting"
  | "success-backfilling"
  | "success-watching"
  | "success-sweeping"
  | "success-retrying"
  | SyncCommonResolverOrdering;
export type SyncPauseResolverOrdering =
  | "success-paused"
  | SyncCommonResolverOrdering
  | SyncIdempotencyResolverOrdering;
export type SyncResumeResolverOrdering =
  | "success-starting"
  | "success-backfilling"
  | "success-watching"
  | "success-sweeping"
  | "success-retrying"
  | SyncCommonResolverOrdering
  | SyncIdempotencyResolverOrdering;
export type SyncStopResolverOrdering =
  | "success-stopped"
  | SyncCommonResolverOrdering
  | SyncIdempotencyResolverOrdering;

type SyncControlResolverTable = Readonly<{
  readonly start: Readonly<Record<SyncStartResolverOrdering, SyncControlResolverDirective>>;
  readonly pause: Readonly<Record<SyncPauseResolverOrdering, SyncControlResolverDirective>>;
  readonly resume: Readonly<Record<SyncResumeResolverOrdering, SyncControlResolverDirective>>;
  readonly stop: Readonly<Record<SyncStopResolverOrdering, SyncControlResolverDirective>>;
}>;

const unkeyedCommon = {
  "auth-blocked": failed("auth-blocked", unkeyed),
  "terminal-failure": failed("terminal-failure", unkeyed),
  "cleanup-failure": failed("terminal-failure", unkeyed),
  "superseded-by-stop": cancelled("superseded-by-stop", unkeyed),
  "superseded-by-restart": cancelled("superseded-by-restart", unkeyed),
  "superseded-by-shutdown": cancelled("superseded-by-shutdown", unkeyed),
  "superseded-by-incompatible-command": cancelled("superseded-by-incompatible-command", unkeyed),
  "stale-version": rejected("stale-version", unkeyed),
  "incompatible-state": rejected("incompatible-state", unkeyed),
  busy: rejected("busy", unkeyed),
  "shutdown-terminal": rejected("shutdown-terminal", unkeyed),
  "deadline-elapsed": timeout(unkeyed),
  "process-reconstruction": cancelled(
    "superseded-by-restart",
    "discard-old-incarnation-map",
    "error",
    "process-teardown-removes-listeners-subscription-and-deadline",
    "first-real-observation-from-new-incarnation",
  ),
} satisfies Readonly<Record<SyncCommonResolverOrdering, SyncControlResolverDirective>>;

const retainedCommon = {
  "auth-blocked": failed("auth-blocked", retained),
  "terminal-failure": failed("terminal-failure", retained),
  "cleanup-failure": failed("terminal-failure", retained),
  "superseded-by-stop": cancelled("superseded-by-stop", retained),
  "superseded-by-restart": cancelled("superseded-by-restart", retained),
  "superseded-by-shutdown": cancelled("superseded-by-shutdown", retained),
  "superseded-by-incompatible-command": cancelled("superseded-by-incompatible-command", retained),
  "stale-version": rejected("stale-version", retained),
  "incompatible-state": rejected("incompatible-state", retained),
  busy: rejected("busy", retained),
  "shutdown-terminal": rejected("shutdown-terminal", retained),
  "deadline-elapsed": timeout(retained),
  "process-reconstruction": cancelled(
    "superseded-by-restart",
    "discard-old-incarnation-map",
    "error",
    "process-teardown-removes-listeners-subscription-and-deadline",
    "first-real-observation-from-new-incarnation",
  ),
} satisfies Readonly<Record<SyncCommonResolverOrdering, SyncControlResolverDirective>>;

const idempotencyOrderings = {
  "idempotency-replay-completed": completed(
    "cached-byte-identical-success",
    "return-byte-identical-cached-result-without-extending-expiry",
    noWaiter,
    cachedObservation,
  ),
  "idempotency-replay-rejected": rejected(
    "preserve-cached-registered-reason",
    "return-byte-identical-cached-result-without-extending-expiry",
    "cached-byte-identical-error",
    noWaiter,
    cachedObservation,
  ),
  "idempotency-replay-failed": failed(
    "preserve-cached-registered-reason",
    "return-byte-identical-cached-result-without-extending-expiry",
    "cached-byte-identical-error",
    noWaiter,
    cachedObservation,
  ),
  "idempotency-replay-cancelled": cancelled(
    "preserve-cached-registered-reason",
    "return-byte-identical-cached-result-without-extending-expiry",
    "cached-byte-identical-error",
    noWaiter,
    cachedObservation,
  ),
  "idempotency-replay-timeout": timeout(
    "return-byte-identical-cached-result-without-extending-expiry",
    "cached-byte-identical-error",
    noWaiter,
    cachedObservation,
  ),
  "idempotency-conflict": conflict(),
  "capacity-exhausted": capacity(),
} satisfies Readonly<Record<SyncIdempotencyResolverOrdering, SyncControlResolverDirective>>;

/**
 * Constructive resolver contract. The command-specific record keys are exhaustive and unique;
 * adding an ordering requires a compile-time table entry before the contract can build.
 */
export const syncPendingControlResolverTable = Object.freeze({
  start: Object.freeze({
    "success-starting": completed("accepted", unkeyed),
    "success-backfilling": completed("accepted", unkeyed),
    "success-watching": completed("completed", unkeyed),
    "success-sweeping": completed("accepted", unkeyed),
    "success-retrying": completed("accepted", unkeyed),
    ...unkeyedCommon,
  }),
  pause: Object.freeze({
    "success-paused": completed("completed", retained),
    ...retainedCommon,
    ...idempotencyOrderings,
  }),
  resume: Object.freeze({
    "success-starting": completed("accepted", retained),
    "success-backfilling": completed("completed", retained),
    "success-watching": completed("completed", retained),
    "success-sweeping": completed("completed", retained),
    "success-retrying": completed("completed", retained),
    ...retainedCommon,
    ...idempotencyOrderings,
  }),
  stop: Object.freeze({
    "success-stopped": completed("completed", retained),
    ...retainedCommon,
    ...idempotencyOrderings,
  }),
} satisfies SyncControlResolverTable);

export type SyncControlResolverInput =
  | Readonly<{ readonly command: "start"; readonly ordering: SyncStartResolverOrdering }>
  | Readonly<{ readonly command: "pause"; readonly ordering: SyncPauseResolverOrdering }>
  | Readonly<{ readonly command: "resume"; readonly ordering: SyncResumeResolverOrdering }>
  | Readonly<{ readonly command: "stop"; readonly ordering: SyncStopResolverOrdering }>;

/** Resolve exactly one command/ordering cell without fallthrough or downstream policy. */
export function resolvePendingSyncControl(
  input: SyncControlResolverInput,
): SyncControlResolverDirective {
  switch (input.command) {
    case "start":
      return syncPendingControlResolverTable.start[input.ordering];
    case "pause":
      return syncPendingControlResolverTable.pause[input.ordering];
    case "resume":
      return syncPendingControlResolverTable.resume[input.ordering];
    case "stop":
      return syncPendingControlResolverTable.stop[input.ordering];
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

const operationDefaults = {
  streaming: "none",
  strictness: "strict",
} satisfies Pick<OperationDefinition, "streaming" | "strictness">;

export const syncStatusOperation = defineOperation({
  key: "sync.status",
  route: "/v1/sync/status",
  cliName: "sync-status",
  scope: "sync:read.status",
  request: syncStatusRequestSchema,
  response: syncStatusResponseSchema,
  ...operationDefaults,
});

export const syncStartOperation = defineOperation({
  key: "sync.start",
  route: "/v1/sync/start",
  cliName: "sync-start",
  scope: "sync:control.start",
  request: syncStartRequestSchema,
  response: syncStartResponseSchema,
  ...operationDefaults,
});

export const syncPauseOperation = defineOperation({
  key: "sync.pause",
  route: "/v1/sync/pause",
  cliName: "sync-pause",
  scope: "sync:control.pause",
  request: syncPauseRequestSchema,
  response: syncPauseResponseSchema,
  ...operationDefaults,
});

export const syncResumeOperation = defineOperation({
  key: "sync.resume",
  route: "/v1/sync/resume",
  cliName: "sync-resume",
  scope: "sync:control.resume",
  request: syncResumeRequestSchema,
  response: syncResumeResponseSchema,
  ...operationDefaults,
});

export const syncStopOperation = defineOperation({
  key: "sync.stop",
  route: "/v1/sync/stop",
  cliName: "sync-stop",
  scope: "sync:control.stop",
  request: syncStopRequestSchema,
  response: syncStopResponseSchema,
  ...operationDefaults,
});

export const syncOperationDefinitions = [
  syncStatusOperation,
  syncStartOperation,
  syncPauseOperation,
  syncResumeOperation,
  syncStopOperation,
] satisfies readonly OperationDefinition[];

export const syncStatusOperationDefinition = syncStatusOperation;
export const syncStartOperationDefinition = syncStartOperation;
export const syncPauseOperationDefinition = syncPauseOperation;
export const syncResumeOperationDefinition = syncResumeOperation;
export const syncStopOperationDefinition = syncStopOperation;
export const syncOperations = syncOperationDefinitions;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))) return true;
  }
  return false;
}
