import { z } from "zod";
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

const nonNegativeInteger = z.number().int().nonnegative().finite();
const commandIdSchema = boundedText(256);
const idempotencyKeySchema = boundedText(256);

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
  version: nonNegativeInteger,
  checkpoint: syncCheckpointSummarySchema,
  diagnostics: syncDiagnosticsSchema,
} as const;

const statusWithoutAuth = <
  const TState extends Exclude<SyncActorState, "authBlocked">,
  const TOperation extends SyncActiveOperation | null,
>(
  actorState: TState,
  activeOperation: TOperation,
) =>
  z.strictObject({
    actorState: z.literal(actorState),
    activeOperation:
      activeOperation === null ? z.null() : z.literal(activeOperation as SyncActiveOperation),
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

/** A control response observes the actor separately from the accepted command identity. */
export const syncObservedActorSchema = z.strictObject({
  actorState: syncActorStateSchema,
  version: nonNegativeInteger,
});
export type SyncObservedActor = z.infer<typeof syncObservedActorSchema>;

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

const startObservedActorSchema = z.strictObject({
  actorState: z.enum(["starting", "backfilling", "watching", "sweeping", "retrying"]),
  version: nonNegativeInteger,
});
const pauseObservedActorSchema = z.strictObject({
  actorState: z.literal("paused"),
  version: nonNegativeInteger,
});
const resumeObservedActorSchema = z.strictObject({
  actorState: z.enum(["starting", "backfilling", "watching", "sweeping", "retrying"]),
  version: nonNegativeInteger,
});
const stopObservedActorSchema = z.strictObject({
  actorState: z.enum(["stopping", "stopped"]),
  version: nonNegativeInteger,
});
const completedStartObservedActorSchema = z.strictObject({
  actorState: z.literal("watching"),
  version: nonNegativeInteger,
});
const completedResumeObservedActorSchema = z.strictObject({
  actorState: z.enum(["backfilling", "watching", "sweeping", "retrying"]),
  version: nonNegativeInteger,
});
const completedStopObservedActorSchema = z.strictObject({
  actorState: z.literal("stopped"),
  version: nonNegativeInteger,
});

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
  acceptedResponse(startObservedActorSchema),
  completedResponse(completedStartObservedActorSchema),
]);
export const syncPauseResponseSchema = z.union([
  acceptedResponse(pauseObservedActorSchema),
  completedResponse(pauseObservedActorSchema),
]);
export const syncResumeResponseSchema = z.union([
  acceptedResponse(resumeObservedActorSchema),
  completedResponse(completedResumeObservedActorSchema),
]);
export const syncStopResponseSchema = z.union([
  acceptedResponse(stopObservedActorSchema),
  completedResponse(completedStopObservedActorSchema),
]);

export type SyncStartResponse = z.infer<typeof syncStartResponseSchema>;
export type SyncPauseResponse = z.infer<typeof syncPauseResponseSchema>;
export type SyncResumeResponse = z.infer<typeof syncResumeResponseSchema>;
export type SyncStopResponse = z.infer<typeof syncStopResponseSchema>;

const operationDefaults = {
  streaming: "none" as const,
  strictness: "strict" as const,
};

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
] as const satisfies readonly OperationDefinition[];

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
