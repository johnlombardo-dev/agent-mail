import {
  createActor,
  fromCallback,
  fromPromise,
  setup,
  type AnyActorLogic,
  type AnyActorRef,
} from "xstate";
import { z } from "zod";
import {
  errorCodeSchema,
  safeErrorMessageSchema,
  syncActorStateSchema,
  syncAuthBlockedDetailSchema,
  syncCheckpointSummarySchema,
  syncDiagnosticsSchema,
  syncStatusResponseSchema,
  type SyncAuthBlockedDetail,
  type SyncCheckpointSummary,
  type SyncDiagnostic,
  type SyncActorState,
  type SyncStatusResponse,
} from "@agent-mail/contracts";
import type { SyncControlDecision } from "./sync-control-service";
import {
  SIGNED_ATOMIC_STATES,
  SIGNED_EXTERNAL_EVENT_IDS,
  SIGNED_SYNC_STATECHART,
  SIGNED_TRANSITIONS,
  type SignedStatechartTransition,
} from "./sync-statechart-model";
import {
  nativeRetryRandomSource,
  nativeRetryTimerClock,
  retryTimerActorLogic,
} from "./retry-timer-actor";
import type { RetryTimerClock } from "./retry-timer-actor";

/** The model and this executable chart are intentionally pinned together. */
export const SYNC_STATECHART_MODEL_VERSION = SIGNED_SYNC_STATECHART.modelVersion;
export const SYNC_STATECHART_MODEL_DIGEST = SIGNED_SYNC_STATECHART.digest;
export const SYNC_STATECHART_ID = SIGNED_SYNC_STATECHART.machine.id;

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value);

export const syncLifecycleConfigurationSchema = z
  .strictObject({
    retryBaseMs: positiveSafeInteger,
    retryCapMs: positiveSafeInteger,
    retryJitterRatio: z.number().min(0).max(1),
    maxRetryAttempts: positiveSafeInteger,
    periodicStatusIntervalMs: positiveSafeInteger.max(900_000),
    controlDeadlineMs: positiveSafeInteger.max(300_000),
    controlResultRetentionMs: positiveSafeInteger.max(86_400_000),
    maxControlIdempotencyEntries: positiveSafeInteger.max(10_000),
    maxReleaseSlotEntries: positiveSafeInteger.max(4_096),
  })
  .refine((value) => value.retryCapMs >= value.retryBaseMs, "retryCapMs must be >= retryBaseMs");

export type SyncLifecycleConfiguration = z.infer<typeof syncLifecycleConfigurationSchema>;

export type WorkflowFaultCategory = "authentication" | "transient" | "permanent" | "invariant";

export interface WorkflowFault {
  readonly category: WorkflowFaultCategory;
  readonly code: string;
  readonly safeMessage: string;
  readonly authReason?: string;
  readonly attemptedCredentialRevision?: number;
}

const cleanupAuditSchema = z.strictObject({
  scope: z.enum(["watch", "workflow"]),
  frozenReleaseSetId: boundedText(256),
  liveResourceCount: z.literal(0),
  unresolvedReleaseCount: z.literal(0),
  digest: boundedText(256),
});

export const cleanupCertificateSchema = z.strictObject({
  certificateId: boundedText(256),
  cleanupEpoch: positiveSafeInteger,
  cleanupPhase: positiveSafeInteger,
  invokeLease: positiveSafeInteger,
  effectiveScope: z.enum(["watch", "workflow"]),
  frozenReleaseSetId: boundedText(256),
  released: z.literal(true),
  authoritativeAudit: cleanupAuditSchema,
  diagnostics: syncDiagnosticsSchema,
});

export type CleanupCertificate = {
  readonly certificateId: string;
  readonly cleanupEpoch: number;
  readonly cleanupPhase: number;
  readonly invokeLease: number;
  readonly effectiveScope: "watch" | "workflow";
  readonly frozenReleaseSetId: string;
  readonly released: true;
  readonly authoritativeAudit: {
    readonly scope: "watch" | "workflow";
    readonly frozenReleaseSetId: string;
    readonly liveResourceCount: 0;
    readonly unresolvedReleaseCount: 0;
    readonly digest: string;
  };
  readonly diagnostics: readonly SyncDiagnostic[];
};

export const cleanupTerminalFaultSchema = z.strictObject({
  category: z.union([z.literal("permanent"), z.literal("invariant")]),
  code: errorCodeSchema,
  safeMessage: safeErrorMessageSchema,
  releaseCertificate: cleanupCertificateSchema,
});

export type CleanupTerminalFault = {
  readonly category: "permanent" | "invariant";
  readonly code: string;
  readonly safeMessage: string;
  readonly releaseCertificate: CleanupCertificate;
};

/** The immutable terminal owned by one resource-registry cleanup phase. */
export type SyncCleanupPhaseTerminal =
  | { readonly status: "pending" }
  | { readonly status: "success"; readonly certificate: CleanupCertificate }
  | {
      readonly status: "error";
      readonly certificate: CleanupCertificate;
      readonly fault: CleanupTerminalFault;
    };

export interface SyncCleanupPhaseSnapshot {
  readonly cleanupEpoch: number;
  readonly cleanupPhase: number;
  readonly effectiveScope: "watch" | "workflow";
  readonly frozenReleaseSetId: string;
  readonly certificateId: string;
  readonly auditDigest: string;
  readonly terminal: SyncCleanupPhaseTerminal;
}

export interface SyncCleanupPhaseRequest {
  readonly minimumScope: "watch" | "workflow";
  readonly cleanupEpoch: number;
  readonly cleanupPhase: number;
  readonly effectiveScope: "watch" | "workflow";
  readonly invokeLease: number;
}

export type SyncReleaseOwnerScope = "watch" | "workflow";

export interface SyncReleaseSlotRequest {
  readonly ownerScope: SyncReleaseOwnerScope;
  readonly ownerInvokeIdentity: string;
  readonly resourceOrdinal: number;
  readonly stableResourceId: string;
  readonly release: () => void | Promise<void>;
}

export interface SyncReleaseSlotTerminal {
  readonly status: "success" | "error";
  readonly slotInstanceId: string;
  readonly slotGeneration: number;
  readonly stableResourceId: string;
  readonly diagnostic: SyncDiagnostic | null;
  readonly category: WorkflowFaultCategory | null;
}

export interface SyncReleaseSlotHandle {
  readonly slotInstanceId: string;
  readonly slotGeneration: number;
  readonly stableResourceId: string;
  readonly terminal: Promise<SyncReleaseSlotTerminal>;
  readonly triggerRelease: () => Promise<SyncReleaseSlotTerminal>;
}

export interface SyncCompositeQueueSlotRegistration {
  readonly handle: SyncReleaseSlotHandle;
  /** Bind exact queue.stop() after synchronous queue construction. */
  readonly bindQueueStop: (stop: () => void | Promise<void>) => void;
}

export interface SyncResourceRegistrySnapshot {
  readonly slotEntryCount: number;
  readonly sourceTreeSnapshotCount: number;
  readonly phaseSnapshotCount: number;
  readonly nextSlotGeneration: number;
  readonly cleanupSessionOpen: boolean;
}

export interface SyncResourceRegistryAuthority {
  /** The current immutable phase, or null before the first cleanup request. */
  readonly currentPhase: SyncCleanupPhaseSnapshot | null;
  /** requestPhase must install/return the phase before the cleanup invoke starts. */
  readonly requestPhase: (request: SyncCleanupPhaseRequest) => SyncCleanupPhaseSnapshot;
  /** Every call returns a fresh wrapper promise for the requested immutable phase. */
  readonly awaitPhase: (
    cleanupEpoch: number,
    cleanupPhase: number,
    invokeLease?: number,
  ) => Promise<SyncCleanupPhaseTerminal>;
  /** Optional concrete-registry operations; injected test authorities may omit them. */
  readonly registerReleaseSlot?: (request: SyncReleaseSlotRequest) => SyncReleaseSlotHandle;
  readonly finishCleanupScope?: (certificate: CleanupCertificate) => void;
  readonly snapshot?: () => SyncResourceRegistrySnapshot;
}

export interface SyncLifecycleDependencies {
  readonly resourceRegistry: SyncResourceRegistryAuthority;
  /** Optional in-process sink for the machine's typed control decisions. */
  readonly controlDecisionSink?: (decision: SyncControlDecision) => void;
}

export interface BootstrapOutput {
  readonly next: "backfill" | "idle" | "poll";
  readonly checkpoint: SyncCheckpointSummary;
}

export interface LoopOutput {
  readonly status: "completed" | "already-complete" | "not-eligible" | "not-owner" | "cancelled";
  readonly checkpoint: SyncCheckpointSummary;
  readonly completion: Readonly<Record<string, unknown>>;
  readonly watchStrategy: "idle" | "poll";
}

export interface ScopeEvent {
  readonly scopeEpoch: number;
}

export type SyncLifecycleEvent =
  | { readonly type: "xstate.init" }
  | {
      readonly type: "control.start.requested";
      readonly commandId: string;
      readonly expectedVersion?: number;
    }
  | {
      readonly type: "control.pause.requested";
      readonly commandId: string;
      readonly idempotencyKey: string;
      readonly expectedVersion?: number;
    }
  | {
      readonly type: "control.resume.requested";
      readonly commandId: string;
      readonly idempotencyKey: string;
      readonly expectedVersion?: number;
    }
  | {
      readonly type: "control.stop.requested";
      readonly commandId: string;
      readonly idempotencyKey: string;
      readonly expectedVersion?: number;
    }
  | {
      readonly type: "lifecycle.restart.requested";
      readonly requestId: string;
      readonly reason: string;
    }
  | {
      readonly type: "process.shutdown.requested";
      readonly requestId: string;
      readonly signal: string;
    }
  | { readonly type: "credentials.changed"; readonly revision: number }
  | { readonly type: "xstate.done.actor.bootstrapSession"; readonly output: BootstrapOutput }
  | { readonly type: "xstate.error.actor.bootstrapSession"; readonly error: WorkflowFault }
  | { readonly type: "xstate.done.actor.initialBackfill"; readonly output: LoopOutput }
  | { readonly type: "xstate.error.actor.initialBackfill"; readonly error: WorkflowFault }
  | ({ readonly type: "idle.ready" } & ScopeEvent)
  | ({ readonly type: "idle.mailboxChanged" } & ScopeEvent)
  | ({ readonly type: "idle.completed" } & ScopeEvent)
  | ({ readonly type: "idle.failed"; readonly fault: WorkflowFault } & ScopeEvent)
  | ({ readonly type: "watchTimer.elapsed" } & ScopeEvent)
  | ({ readonly type: "watchTimer.failed"; readonly fault: WorkflowFault } & ScopeEvent)
  | { readonly type: "xstate.done.actor.recurringSweep"; readonly output: LoopOutput }
  | { readonly type: "xstate.error.actor.recurringSweep"; readonly error: WorkflowFault }
  | ({ readonly type: "retryTimer.elapsed" } & ScopeEvent)
  | ({ readonly type: "retryTimer.failed"; readonly fault: WorkflowFault } & ScopeEvent)
  | { readonly type: "xstate.done.actor.cleanupBarrier"; readonly output: CleanupCertificate }
  | { readonly type: "xstate.error.actor.cleanupBarrier"; readonly error: CleanupTerminalFault };

const commandIdSchema = boundedText(256);
const idempotencyKeySchema = boundedText(256);
const expectedVersionSchema = nonNegativeSafeInteger.optional();
const externalEventSchemas = [
  z.strictObject({
    type: z.literal("control.start.requested"),
    commandId: commandIdSchema,
    expectedVersion: expectedVersionSchema,
  }),
  z.strictObject({
    type: z.literal("control.pause.requested"),
    commandId: commandIdSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedVersion: expectedVersionSchema,
  }),
  z.strictObject({
    type: z.literal("control.resume.requested"),
    commandId: commandIdSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedVersion: expectedVersionSchema,
  }),
  z.strictObject({
    type: z.literal("control.stop.requested"),
    commandId: commandIdSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedVersion: expectedVersionSchema,
  }),
  z.strictObject({
    type: z.literal("lifecycle.restart.requested"),
    requestId: commandIdSchema,
    reason: boundedText(500),
  }),
  z.strictObject({
    type: z.literal("process.shutdown.requested"),
    requestId: commandIdSchema,
    signal: boundedText(80),
  }),
  z.strictObject({ type: z.literal("credentials.changed"), revision: nonNegativeSafeInteger }),
] as const;

export const externalSyncEventSchema = z.discriminatedUnion("type", externalEventSchemas);
export type ExternalSyncEvent = z.infer<typeof externalSyncEventSchema>;

/** Strictly admit the seven trusted external events. Reserved actor events never cross this boundary. */
export function parseExternalSyncEvent(value: unknown): ExternalSyncEvent {
  return externalSyncEventSchema.parse(value);
}

export interface SyncExternalSendAdapter {
  readonly send: (value: unknown) => void;
}

export function createSyncExternalSendAdapter(
  actor: Pick<AnyActorRef, "send">,
): SyncExternalSendAdapter {
  return Object.freeze({ send: (value: unknown) => actor.send(parseExternalSyncEvent(value)) });
}

export interface SyncLifecycleContext {
  readonly incarnationId: string;
  readonly version: number;
  readonly scopeEpoch: number;
  readonly idleReadyEpoch: number | null;
  readonly retryAttempt: number;
  readonly checkpoint: SyncCheckpointSummary;
  readonly authBlockedDetail: SyncAuthBlockedDetail | null;
  readonly diagnostics: readonly SyncDiagnostic[];
  readonly latestCredentialRevision: number;
  readonly activeCredentialRevision: number | null;
  readonly authFaultCredentialRevision: number | null;
  readonly cleanupEpoch: number;
  readonly cleanupPhase: number;
  readonly cleanupInvokeLease: number;
  readonly effectiveCleanupScope: "watch" | "workflow" | null;
}

export interface SyncLifecycleInput {
  readonly configuration: SyncLifecycleConfiguration;
  readonly initialCheckpoint: SyncCheckpointSummary;
  readonly initialCredentialRevision: number;
  readonly incarnationId?: string;
  /** Concrete IDLE adapter injection remains owned by the composition seam. */
  readonly validatedIdleAdapter?: unknown;
  /** Internal retry composition seam; production defaults remain explicit. */
  readonly retryTimerClock?: RetryTimerClock;
  readonly retryRandomSource?: () => number;
}

export interface SyncActorInputs {
  readonly configuration: SyncLifecycleConfiguration;
  readonly scopeEpoch: number;
  readonly credentialRevision: number | null;
  readonly cleanupEpoch: number;
  readonly cleanupPhase: number;
  readonly invokeLease: number;
  readonly effectiveScope: "watch" | "workflow" | null;
  readonly minimumScope: "watch" | "workflow" | null;
  readonly phaseTerminal: Promise<SyncCleanupPhaseTerminal> | null;
  readonly frozenReleaseSetId: string | null;
  readonly resourceRegistry: SyncResourceRegistryAuthority;
}

export interface BootstrapSessionActorInput extends SyncActorInputs {
  readonly checkpoint: SyncCheckpointSummary;
}

export interface InitialBackfillActorInput extends SyncActorInputs {
  readonly checkpoint: SyncCheckpointSummary;
  readonly mailboxWorkSet: Readonly<Record<string, unknown>>;
  readonly boundedBatchConfiguration: SyncLifecycleConfiguration;
}

export interface IdleSessionActorInput extends SyncActorInputs {
  readonly validatedIdleAdapter: unknown;
}

export interface PeriodicStatusTimerActorInput extends SyncActorInputs {
  readonly periodicStatusIntervalMs: number;
}

export interface RecurringSweepActorInput extends SyncActorInputs {
  readonly checkpoint: SyncCheckpointSummary;
  readonly boundedWorkConfiguration: SyncLifecycleConfiguration;
}

export interface RetryTimerActorInput extends SyncActorInputs {
  readonly retryAttempt: number;
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  readonly retryJitterRatio: number;
  readonly injectedRandomSource: () => number;
  readonly injectedClock: RetryTimerClock;
}

export interface CleanupBarrierActorInput extends SyncActorInputs {
  readonly minimumScope: "watch" | "workflow";
  readonly phaseTerminal: Promise<SyncCleanupPhaseTerminal>;
  readonly frozenReleaseSetId: string;
  readonly resourceRegistry: SyncResourceRegistryAuthority;
}

export interface RawDownloadQueueActorInput extends SyncActorInputs {
  readonly productionDownloadAdapter: unknown;
  readonly capacity: number;
}

export interface RawDownloadJobActorInput extends SyncActorInputs {
  readonly request: unknown;
  readonly signal: AbortSignal;
  readonly productionDownloadAdapter: unknown;
}

export interface ControlWaiterActorInput extends SyncActorInputs {
  readonly commandId: string;
  readonly idempotencyKey?: string;
  readonly commandFingerprint: string;
  readonly targetPredicate: (snapshot: SyncLifecycleSnapshotView) => boolean;
  readonly controlDeadlineMs: number;
  readonly controlResultRetentionMs: number;
  readonly maxControlIdempotencyEntries: number;
  readonly injectedMonotonicClock: () => number;
}

export interface SyncActorInputMap {
  readonly bootstrapSession: BootstrapSessionActorInput;
  readonly initialBackfill: InitialBackfillActorInput;
  readonly idleSession: IdleSessionActorInput;
  readonly periodicStatusTimer: PeriodicStatusTimerActorInput;
  readonly recurringSweep: RecurringSweepActorInput;
  readonly retryTimer: RetryTimerActorInput;
  readonly cleanupBarrier: CleanupBarrierActorInput;
  readonly rawDownloadQueue: RawDownloadQueueActorInput;
  readonly rawDownloadJob: RawDownloadJobActorInput;
  readonly controlWaiter: ControlWaiterActorInput;
}

export type SyncActorImplementations = Readonly<
  Partial<
    Record<
      | "bootstrapSession"
      | "initialBackfill"
      | "idleSession"
      | "periodicStatusTimer"
      | "recurringSweep"
      | "retryTimer"
      | "cleanupBarrier"
      | "rawDownloadQueue"
      | "rawDownloadJob"
      | "controlWaiter",
      AnyActorLogic
    >
  >
>;

const neverPromiseActor = fromPromise<never, SyncActorInputs>(
  async () => new Promise<never>(() => undefined),
);
const inertCallbackActor = fromCallback<SyncLifecycleEvent, SyncActorInputs>(() => undefined);

function normalizedCleanupFault(certificate: CleanupCertificate): CleanupTerminalFault {
  return cleanupTerminalFaultSchema.parse({
    category: "invariant",
    code: "sync.cleanup-terminal-contract",
    safeMessage: "Cleanup terminal violated its fault-category contract.",
    releaseCertificate: certificate,
  });
}

const cleanupBarrierActor = fromPromise<CleanupCertificate, CleanupBarrierActorInput>(
  async ({ input }) => {
    // The #190 model-path harness injects a deliberately manual authority. It
    // drives reserved terminal events itself; only the concrete registry owns
    // an autonomous cleanup barrier.
    if (!input.resourceRegistry.registerReleaseSlot)
      return new Promise<CleanupCertificate>(() => undefined);
    let phaseTerminal = input.phaseTerminal;
    let internalFailure: unknown = undefined;
    for (;;) {
      let candidate: unknown;
      try {
        candidate = await phaseTerminal;
      } catch (value: unknown) {
        internalFailure = value;
        candidate = undefined;
      }
      if (isRecord(candidate) && candidate.status === "success") {
        const certificate = cleanupCertificateSchema.safeParse(candidate.certificate);
        if (certificate.success) {
          if (internalFailure !== undefined) throw normalizedCleanupFault(certificate.data);
          return certificate.data;
        }
      }
      if (isRecord(candidate) && candidate.status === "error") {
        const fault = cleanupTerminalFaultSchema.safeParse(candidate.fault);
        if (fault.success) {
          if (fault.data.category === "permanent" || fault.data.category === "invariant")
            throw fault.data;
        }
      }
      phaseTerminal = input.resourceRegistry.awaitPhase(
        input.cleanupEpoch,
        input.cleanupPhase,
        input.invokeLease,
      );
      internalFailure = undefined;
    }
  },
);

const defaultActors: Record<string, AnyActorLogic> = {
  bootstrapSession: neverPromiseActor,
  initialBackfill: neverPromiseActor,
  idleSession: inertCallbackActor,
  periodicStatusTimer: inertCallbackActor,
  recurringSweep: neverPromiseActor,
  retryTimer: retryTimerActorLogic,
  cleanupBarrier: cleanupBarrierActor,
  rawDownloadQueue: inertCallbackActor,
  rawDownloadJob: neverPromiseActor,
  controlWaiter: inertCallbackActor,
};

const releaseSlotOwnerScopeSchema = z.enum(["watch", "workflow"]);
const releaseSlotRequestSchema = z.strictObject({
  ownerScope: releaseSlotOwnerScopeSchema,
  ownerInvokeIdentity: boundedText(256),
  resourceOrdinal: nonNegativeSafeInteger,
  stableResourceId: boundedText(256),
});

type ReleaseSlotFailure = {
  readonly category: WorkflowFaultCategory;
  readonly diagnostic: SyncDiagnostic;
};

type ReleaseSlotEntry = {
  readonly key: string;
  readonly request: SyncReleaseSlotRequest;
  readonly slotInstanceId: string;
  readonly slotGeneration: number;
  readonly terminal: Promise<SyncReleaseSlotTerminal>;
  readonly resolveTerminal: (terminal: SyncReleaseSlotTerminal) => void;
  releaseStarted: boolean;
  settled: boolean;
  failure: ReleaseSlotFailure | null;
};

type FrozenSlot = Readonly<{
  readonly slotInstanceId: string;
  readonly slotGeneration: number;
  readonly stableResourceId: string;
  readonly terminal: Promise<SyncReleaseSlotTerminal>;
}>;

type RegistryPhase = {
  readonly epoch: number;
  readonly phase: number;
  readonly scope: SyncReleaseOwnerScope;
  readonly frozen: readonly FrozenSlot[];
  readonly frozenReleaseSetId: string;
  readonly certificateId: string;
  readonly waiters: Array<{
    readonly invokeLease: number | undefined;
    readonly resolve: (terminal: SyncCleanupPhaseTerminal) => void;
  }>;
  invokeLease: number;
  snapshot: SyncCleanupPhaseSnapshot;
  settled: boolean;
};

type SourceTreeSnapshot = Readonly<{
  readonly frozen: readonly FrozenSlot[];
}>;

function safeDiagnostic(
  value: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): SyncDiagnostic {
  if (isRecord(value)) {
    const code = value.code;
    const message = value.safeMessage ?? value.message;
    if (
      typeof code === "string" &&
      errorCodeSchema.safeParse(code).success &&
      typeof message === "string" &&
      safeErrorMessageSchema.safeParse(message).success
    )
      return { code, message };
  }
  return { code: fallbackCode, message: fallbackMessage };
}

function releaseFailure(value: unknown): ReleaseSlotFailure {
  const category =
    isRecord(value) &&
    (value.category === "authentication" ||
      value.category === "transient" ||
      value.category === "permanent" ||
      value.category === "invariant")
      ? value.category
      : "invariant";
  return {
    category,
    diagnostic: safeDiagnostic(
      value,
      "sync.cleanup-release",
      "A workflow-owned resource failed to close.",
    ),
  };
}

function phaseCertificate(
  phase: RegistryPhase,
  invokeLease: number,
  terminals: readonly SyncReleaseSlotTerminal[],
): CleanupCertificate {
  const diagnostics = syncDiagnosticsSchema.parse(
    terminals.flatMap((terminal) => (terminal.diagnostic ? [terminal.diagnostic] : [])).slice(-32),
  );
  const digest = `${phase.certificateId}:${phase.frozenReleaseSetId}:${diagnostics
    .map((item) => `${item.code}:${item.message}`)
    .join("|")}`.slice(0, 256);
  const certificate = cleanupCertificateSchema.parse({
    certificateId: phase.certificateId,
    cleanupEpoch: phase.epoch,
    cleanupPhase: phase.phase,
    invokeLease,
    effectiveScope: phase.scope,
    frozenReleaseSetId: phase.frozenReleaseSetId,
    released: true,
    authoritativeAudit: {
      scope: phase.scope,
      frozenReleaseSetId: phase.frozenReleaseSetId,
      liveResourceCount: 0,
      unresolvedReleaseCount: 0,
      digest,
    },
    diagnostics,
  });
  return Object.freeze({
    ...certificate,
    authoritativeAudit: Object.freeze({ ...certificate.authoritativeAudit }),
    diagnostics: Object.freeze(
      certificate.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
    ),
  });
}

function phaseTerminalForLease(
  terminal: SyncCleanupPhaseTerminal,
  invokeLease: number | undefined,
): SyncCleanupPhaseTerminal {
  if (invokeLease === undefined || terminal.status === "pending") return terminal;
  const certificate = { ...terminal.certificate, invokeLease };
  if (terminal.status === "success") return { status: "success", certificate };
  return {
    status: "error",
    certificate,
    fault: { ...terminal.fault, releaseCertificate: certificate },
  };
}

/**
 * One incarnation-scoped registry. Registration is synchronous, and cleanup
 * phases only ever retain immutable slot terminals after the registry entry is
 * retired. The optional methods on SyncResourceRegistryAuthority remain
 * optional so existing deterministic authority fakes stay source-compatible.
 */
export function createSyncResourceRegistry(
  options: Readonly<{ readonly incarnationId: string; readonly maxReleaseSlotEntries: number }>,
): SyncResourceRegistryAuthority {
  const incarnationId = boundedText(256).parse(options.incarnationId);
  const maxEntries = positiveSafeInteger.max(4096).parse(options.maxReleaseSlotEntries);
  const entries = new Map<string, ReleaseSlotEntry>();
  let nextGeneration = 0;
  let currentPhase: SyncCleanupPhaseSnapshot | null = null;
  let currentRecord: RegistryPhase | null = null;
  let supersededWatch: RegistryPhase | null = null;
  let sourceTree: SourceTreeSnapshot | null = null;
  let sessionOpen = false;

  const slotKey = (request: SyncReleaseSlotRequest): string =>
    `${request.ownerScope}:${request.ownerInvokeIdentity}:${request.resourceOrdinal}`;

  const snapshot = (): SyncResourceRegistrySnapshot => ({
    slotEntryCount: entries.size,
    sourceTreeSnapshotCount: sourceTree ? 1 : 0,
    phaseSnapshotCount: (currentRecord ? 1 : 0) + (supersededWatch ? 1 : 0),
    nextSlotGeneration: nextGeneration,
    cleanupSessionOpen: sessionOpen,
  });

  const settlePhase = (record: RegistryPhase): void => {
    if (record.settled) return;
    void Promise.all(record.frozen.map((slot) => slot.terminal)).then((terminals) => {
      if (record.settled) return;
      record.settled = true;
      const certificate = phaseCertificate(record, record.invokeLease, terminals);
      const settledAuditDigest = certificate.authoritativeAudit.digest;
      const firstFailure = terminals.find((terminal) => terminal.status === "error");
      const failure = firstFailure?.diagnostic
        ? releaseFailure({
            category: firstFailure.category,
            code: firstFailure.diagnostic.code,
            safeMessage: firstFailure.diagnostic.message,
          })
        : null;
      const terminal: SyncCleanupPhaseTerminal = failure
        ? {
            status: "error",
            certificate,
            fault: {
              category: failure.category === "permanent" ? "permanent" : "invariant",
              code:
                failure.category === "permanent"
                  ? failure.diagnostic.code
                  : "sync.cleanup-terminal-contract",
              safeMessage:
                failure.category === "permanent"
                  ? failure.diagnostic.message
                  : "Cleanup terminal violated its fault-category contract.",
              releaseCertificate: certificate,
            },
          }
        : { status: "success", certificate };
      record.snapshot = Object.freeze({
        ...record.snapshot,
        auditDigest: settledAuditDigest,
        terminal: Object.freeze(terminal),
      });
      if (currentRecord === record) currentPhase = record.snapshot;
      for (const waiter of record.waiters.splice(0))
        waiter.resolve(phaseTerminalForLease(record.snapshot.terminal, waiter.invokeLease));
    });
  };

  const trigger = (entry: ReleaseSlotEntry): Promise<SyncReleaseSlotTerminal> => {
    if (entry.releaseStarted) return entry.terminal;
    entry.releaseStarted = true;
    Promise.resolve()
      .then(() => entry.request.release())
      .then(
        () => {
          if (entry.settled) return;
          entry.settled = true;
          const terminal: SyncReleaseSlotTerminal = {
            status: "success",
            slotInstanceId: entry.slotInstanceId,
            slotGeneration: entry.slotGeneration,
            stableResourceId: entry.request.stableResourceId,
            diagnostic: null,
            category: null,
          };
          entry.resolveTerminal(terminal);
          entries.delete(entry.key);
        },
        (value: unknown) => {
          if (entry.settled) return;
          entry.settled = true;
          const failure = releaseFailure(value);
          entry.failure = failure;
          const terminal: SyncReleaseSlotTerminal = {
            status: "error",
            slotInstanceId: entry.slotInstanceId,
            slotGeneration: entry.slotGeneration,
            stableResourceId: entry.request.stableResourceId,
            diagnostic: failure.diagnostic,
            category: failure.category,
          };
          entry.resolveTerminal(terminal);
          entries.delete(entry.key);
        },
      );
    return entry.terminal;
  };

  const registerReleaseSlot = (request: SyncReleaseSlotRequest): SyncReleaseSlotHandle => {
    releaseSlotRequestSchema.parse({
      ownerScope: request.ownerScope,
      ownerInvokeIdentity: request.ownerInvokeIdentity,
      resourceOrdinal: request.resourceOrdinal,
      stableResourceId: request.stableResourceId,
    });
    if (typeof request.release !== "function") throw new TypeError("release must be callable");
    if (sessionOpen)
      throw {
        category: "invariant",
        code: "sync.release-slot-late-registration",
        safeMessage: "A resource was registered after cleanup began.",
      } satisfies WorkflowFault;
    const key = slotKey(request);
    const existing = entries.get(key);
    if (existing)
      return {
        slotInstanceId: existing.slotInstanceId,
        slotGeneration: existing.slotGeneration,
        stableResourceId: existing.request.stableResourceId,
        terminal: existing.terminal,
        triggerRelease: () => trigger(existing),
      };
    if (entries.size >= maxEntries)
      throw {
        category: "transient",
        code: "sync.release-slot-capacity",
        safeMessage: "Release-slot capacity exhausted.",
      } satisfies WorkflowFault;
    if (nextGeneration >= Number.MAX_SAFE_INTEGER)
      throw {
        category: "invariant",
        code: "sync.release-slot-generation-exhausted",
        safeMessage: "Release-slot generation exhausted.",
      } satisfies WorkflowFault;
    nextGeneration += 1;
    let resolveTerminal: (terminal: SyncReleaseSlotTerminal) => void = () => undefined;
    const terminal = new Promise<SyncReleaseSlotTerminal>((resolve) => {
      resolveTerminal = resolve;
    });
    const entry: ReleaseSlotEntry = {
      key,
      request: Object.freeze({ ...request }),
      slotInstanceId: `${incarnationId}:${nextGeneration}`,
      slotGeneration: nextGeneration,
      terminal,
      resolveTerminal,
      releaseStarted: false,
      settled: false,
      failure: null,
    };
    entries.set(key, entry);
    return {
      slotInstanceId: entry.slotInstanceId,
      slotGeneration: entry.slotGeneration,
      stableResourceId: entry.request.stableResourceId,
      terminal: entry.terminal,
      triggerRelease: () => trigger(entry),
    };
  };

  const releaseScopeIncludes = (
    effectiveScope: SyncReleaseOwnerScope,
    ownerScope: SyncReleaseOwnerScope,
  ): boolean => effectiveScope === "workflow" || ownerScope === "watch";

  const requestPhase = (request: SyncCleanupPhaseRequest): SyncCleanupPhaseSnapshot => {
    const effectiveScope =
      currentRecord?.scope === "workflow" ? "workflow" : request.effectiveScope;
    if (
      currentRecord &&
      currentRecord.epoch === request.cleanupEpoch &&
      currentRecord.scope === effectiveScope
    ) {
      currentRecord.invokeLease = request.invokeLease;
      if (
        currentRecord.snapshot.terminal.status === "pending" ||
        currentRecord.snapshot.terminal.certificate.invokeLease !== request.invokeLease
      ) {
        const replacement = {
          ...currentRecord.snapshot,
          terminal:
            currentRecord.snapshot.terminal.status === "pending"
              ? currentRecord.snapshot.terminal
              : phaseTerminalForLease(currentRecord.snapshot.terminal, request.invokeLease),
        };
        currentRecord.snapshot = Object.freeze(replacement);
        currentPhase = currentRecord.snapshot;
      }
      return currentRecord.snapshot;
    }
    sessionOpen = true;
    if (sourceTree === null) {
      const frozen = [...entries.values()].map((entry) =>
        Object.freeze({
          slotInstanceId: entry.slotInstanceId,
          slotGeneration: entry.slotGeneration,
          stableResourceId: entry.request.stableResourceId,
          terminal: entry.terminal,
        }),
      );
      sourceTree = Object.freeze({ frozen });
    }
    const selected = sourceTree.frozen.filter((slot) => {
      const entry = [...entries.values()].find(
        (candidate) => candidate.slotInstanceId === slot.slotInstanceId,
      );
      return entry === undefined || releaseScopeIncludes(effectiveScope, entry.request.ownerScope);
    });
    const frozenReleaseSetId =
      `release-set:${request.cleanupEpoch}:${request.cleanupPhase}:${selected
        .map((slot) => slot.slotInstanceId)
        .join(",")}`.slice(0, 256);
    const record: RegistryPhase = {
      epoch: request.cleanupEpoch,
      phase: request.cleanupPhase,
      scope: effectiveScope,
      frozen: selected,
      frozenReleaseSetId,
      certificateId:
        `certificate:${incarnationId}:${request.cleanupEpoch}:${request.cleanupPhase}`.slice(
          0,
          256,
        ),
      waiters: [],
      invokeLease: request.invokeLease,
      snapshot: Object.freeze({
        cleanupEpoch: request.cleanupEpoch,
        cleanupPhase: request.cleanupPhase,
        effectiveScope,
        frozenReleaseSetId,
        certificateId:
          `certificate:${incarnationId}:${request.cleanupEpoch}:${request.cleanupPhase}`.slice(
            0,
            256,
          ),
        auditDigest: `audit:${request.cleanupEpoch}:${request.cleanupPhase}`,
        terminal: { status: "pending" as const },
      }),
      settled: false,
    };
    if (currentRecord?.scope === "watch" && effectiveScope === "workflow")
      supersededWatch = currentRecord;
    currentRecord = record;
    currentPhase = record.snapshot;
    for (const slot of selected) {
      const entry = [...entries.values()].find(
        (candidate) => candidate.slotInstanceId === slot.slotInstanceId,
      );
      if (entry) void trigger(entry);
    }
    // Runtime inspection asks for actor input against the zeroed initial
    // context without starting the actor. Keep that synthetic phase pending;
    // real cleanup actions always advance all three identifiers first.
    if (request.cleanupEpoch > 0 && request.cleanupPhase > 0 && request.invokeLease > 0)
      settlePhase(record);
    return record.snapshot;
  };

  const authority: SyncResourceRegistryAuthority = {
    get currentPhase() {
      return currentPhase;
    },
    requestPhase,
    awaitPhase: (cleanupEpoch, cleanupPhase, invokeLease) => {
      const record =
        currentRecord &&
        currentRecord.epoch === cleanupEpoch &&
        currentRecord.phase === cleanupPhase
          ? currentRecord
          : supersededWatch &&
              supersededWatch.epoch === cleanupEpoch &&
              supersededWatch.phase === cleanupPhase
            ? supersededWatch
            : null;
      if (!record) return new Promise<SyncCleanupPhaseTerminal>(() => undefined);
      if (record.snapshot.terminal.status !== "pending")
        return Promise.resolve(phaseTerminalForLease(record.snapshot.terminal, invokeLease));
      return new Promise<SyncCleanupPhaseTerminal>((resolve) => {
        record.waiters.push({ invokeLease, resolve });
      });
    },
    registerReleaseSlot,
    finishCleanupScope: (certificate) => {
      const phase = currentPhase;
      if (!phase || phase.terminal.status === "pending") return;
      if (
        phase.certificateId !== certificate.certificateId ||
        phase.frozenReleaseSetId !== certificate.frozenReleaseSetId
      )
        return;
      sessionOpen = false;
      sourceTree = null;
      currentRecord = null;
      supersededWatch = null;
      currentPhase = null;
    },
    snapshot,
  };
  return authority;
}

/** Register the sole composite slot used by the frozen P3-C07 queue boundary. */
export function registerCompositeQueueSlot(
  resourceRegistry: SyncResourceRegistryAuthority,
  ownerInvokeIdentity: string,
): SyncCompositeQueueSlotRegistration {
  if (!resourceRegistry.registerReleaseSlot)
    throw new TypeError("a concrete resource registry is required for queue registration");
  let queueStop: (() => void | Promise<void>) | undefined;
  const handle = resourceRegistry.registerReleaseSlot({
    ownerScope: "workflow",
    ownerInvokeIdentity,
    resourceOrdinal: 0,
    stableResourceId: `rawDownloadQueue:${ownerInvokeIdentity}:0`,
    release: () => {
      if (!queueStop) throw new Error("raw download queue was not bound before cleanup");
      return queueStop();
    },
  });
  return Object.freeze({
    handle,
    bindQueueStop: (stop: () => void | Promise<void>) => {
      if (queueStop) throw new Error("raw download queue stop was already bound");
      queueStop = stop;
    },
  });
}

export const createSyncResourceRegistryAuthority = createSyncResourceRegistry;

function createDefaultDependencies(input?: SyncLifecycleInput): SyncLifecycleDependencies {
  const incarnationId = input?.incarnationId ?? `incarnation:${crypto.randomUUID()}`;
  const maxReleaseSlotEntries = input
    ? syncLifecycleConfigurationSchema.parse(input.configuration).maxReleaseSlotEntries
    : inspectionConfiguration.maxReleaseSlotEntries;
  return {
    resourceRegistry: createSyncResourceRegistry({ incarnationId, maxReleaseSlotEntries }),
  };
}

function validateRetryTimerComposition(input: SyncLifecycleInput): void {
  if (
    input.retryTimerClock !== undefined &&
    (typeof input.retryTimerClock.setTimeout !== "function" ||
      typeof input.retryTimerClock.clearTimeout !== "function")
  )
    throw new TypeError("retryTimerClock must provide setTimeout and clearTimeout");
  if (input.retryRandomSource !== undefined && typeof input.retryRandomSource !== "function")
    throw new TypeError("retryRandomSource must be callable");
}

export function createSyncLifecycleDependencies(
  input: SyncLifecycleInput,
): SyncLifecycleDependencies {
  return createDefaultDependencies(input);
}

function initialContext(input: SyncLifecycleInput): SyncLifecycleContext {
  syncLifecycleConfigurationSchema.parse(input.configuration);
  const checkpoint = syncCheckpointSummarySchema.parse(input.initialCheckpoint);
  const initialCredentialRevision = nonNegativeSafeInteger.parse(input.initialCredentialRevision);
  return {
    incarnationId: boundedText(256).parse(
      input.incarnationId ?? `incarnation:${crypto.randomUUID()}`,
    ),
    version: 0,
    scopeEpoch: 0,
    idleReadyEpoch: null,
    retryAttempt: 0,
    checkpoint,
    authBlockedDetail: null,
    diagnostics: [],
    latestCredentialRevision: initialCredentialRevision,
    activeCredentialRevision: null,
    authFaultCredentialRevision: null,
    cleanupEpoch: 0,
    cleanupPhase: 0,
    cleanupInvokeLease: 0,
    effectiveCleanupScope: null,
  };
}

function isWorkflowFault(value: unknown): value is WorkflowFault {
  if (typeof value !== "object" || value === null) return false;
  if (!("category" in value) || !("code" in value) || !("safeMessage" in value)) return false;
  const category = value.category;
  return (
    (category === "authentication" ||
      category === "transient" ||
      category === "permanent" ||
      category === "invariant") &&
    typeof value.code === "string" &&
    typeof value.safeMessage === "string"
  );
}

function eventFault(event: SyncLifecycleEvent): WorkflowFault | undefined {
  if ("error" in event && isWorkflowFault(event.error)) return event.error;
  if ("fault" in event && isWorkflowFault(event.fault)) return event.fault;
  return undefined;
}

function bootstrapOutput(event: SyncLifecycleEvent): BootstrapOutput | undefined {
  return event.type === "xstate.done.actor.bootstrapSession" ? event.output : undefined;
}

function loopOutput(event: SyncLifecycleEvent): LoopOutput | undefined {
  if (
    event.type === "xstate.done.actor.initialBackfill" ||
    event.type === "xstate.done.actor.recurringSweep"
  )
    return event.output;
  return undefined;
}

function cleanupOutput(event: SyncLifecycleEvent): CleanupCertificate | undefined {
  return event.type === "xstate.done.actor.cleanupBarrier"
    ? event.output
    : event.type === "xstate.error.actor.cleanupBarrier"
      ? event.error.releaseCertificate
      : undefined;
}

function scopeFor(
  source: string | readonly string[],
  event: SyncLifecycleEvent,
): "watch" | "workflow" {
  const sourceIds = typeof source === "string" ? [source] : source;
  if (
    sourceIds.some((id) => id === "watching.idling" || id === "watching.polling") &&
    (event.type === "idle.mailboxChanged" || event.type === "watchTimer.elapsed")
  )
    return "watch";
  return "workflow";
}

function applyAction(
  name: string,
  context: SyncLifecycleContext,
  event: SyncLifecycleEvent,
  source: string | readonly string[],
  dependencies?: SyncLifecycleDependencies,
  target?: string | null,
): Partial<SyncLifecycleContext> {
  switch (name) {
    case "emitControlAccepted":
    case "emitControlCompleted":
    case "emitControlPending":
    case "emitControlRejected": {
      emitControlDecision(name, context, event, source, target, dependencies?.controlDecisionSink);
      return {};
    }
    case "advanceVersion":
      return { version: context.version + 1 };
    case "beginEffectScope":
      return { scopeEpoch: context.scopeEpoch + 1, idleReadyEpoch: null };
    case "adoptCommittedCheckpoint": {
      const output =
        event.type === "xstate.done.actor.bootstrapSession" ||
        event.type === "xstate.done.actor.initialBackfill" ||
        event.type === "xstate.done.actor.recurringSweep" ||
        event.type === "xstate.done.actor.cleanupBarrier"
          ? event.output
          : undefined;
      if (output && "checkpoint" in output)
        return { checkpoint: syncCheckpointSummarySchema.parse(output.checkpoint) };
      return {};
    }
    case "resetRetryHistory":
      return {
        retryAttempt: 0,
        diagnostics: context.diagnostics.filter((item) => item.code !== "sync.transient-failure"),
      };
    case "markIdleReadyObserved":
      return { idleReadyEpoch: context.scopeEpoch };
    case "recordTransientFault":
      return {
        retryAttempt: context.retryAttempt + 1,
        diagnostics: syncDiagnosticsSchema.parse(
          [
            ...context.diagnostics,
            {
              code: "sync.transient-failure",
              message: "Sync encountered a transient failure; retry is scheduled.",
            },
          ].slice(-32),
        ),
      };
    case "recordAuthBlock": {
      const fault = eventFault(event);
      const revision =
        fault?.attemptedCredentialRevision ??
        context.activeCredentialRevision ??
        context.latestCredentialRevision;
      const candidateDetail = fault?.safeMessage ?? "Credentials were rejected.";
      const candidate = syncAuthBlockedDetailSchema.safeParse({
        reason: "provider-rejected",
        detail: candidateDetail,
      });
      const detail: SyncAuthBlockedDetail = candidate.success
        ? candidate.data
        : { reason: "provider-rejected", detail: "Credentials were rejected." };
      return { authBlockedDetail: detail, authFaultCredentialRevision: revision };
    }
    case "clearAuthBlock":
      return { authBlockedDetail: null, authFaultCredentialRevision: null };
    case "recordTerminalFailure":
      return {
        diagnostics: syncDiagnosticsSchema.parse(
          [
            ...context.diagnostics.filter((item) => item.code !== "sync.terminal-failure"),
            { code: "sync.terminal-failure", message: "Sync stopped after a terminal failure." },
          ].slice(-32),
        ),
      };
    case "appendCleanupDiagnostics": {
      const output = cleanupOutput(event);
      if (output && "diagnostics" in output)
        return {
          diagnostics: syncDiagnosticsSchema.parse(
            [...context.diagnostics, ...output.diagnostics].slice(-32),
          ),
        };
      if (event.type === "xstate.error.actor.cleanupBarrier")
        return {
          diagnostics: syncDiagnosticsSchema.parse(
            [...context.diagnostics, ...event.error.releaseCertificate.diagnostics].slice(-32),
          ),
        };
      return {};
    }
    case "clearTerminalFailure":
      return {
        diagnostics: context.diagnostics.filter((item) => item.code !== "sync.terminal-failure"),
      };
    case "latchCredentialRevision":
      return "revision" in event ? { latestCredentialRevision: event.revision } : {};
    case "bindCredentialRevision":
      return { activeCredentialRevision: context.latestCredentialRevision };
    case "beginOrPromoteCleanup": {
      const nextScope = scopeFor(source, event);
      const firstPhase = context.effectiveCleanupScope === null;
      const promotesWatchToWorkflow =
        context.effectiveCleanupScope === "watch" && nextScope === "workflow";
      return {
        cleanupEpoch: firstPhase ? context.cleanupEpoch + 1 : context.cleanupEpoch,
        cleanupPhase:
          firstPhase || promotesWatchToWorkflow ? context.cleanupPhase + 1 : context.cleanupPhase,
        cleanupInvokeLease: context.cleanupInvokeLease + 1,
        effectiveCleanupScope: nextScope,
      };
    }
    case "finishCleanupScope": {
      const certificate = cleanupOutput(event);
      if (certificate && dependencies?.resourceRegistry.finishCleanupScope)
        dependencies.resourceRegistry.finishCleanupScope(certificate);
      return { effectiveCleanupScope: null };
    }
    default:
      return {};
  }
}

function controlCommand(
  event: SyncLifecycleEvent,
): "start" | "pause" | "resume" | "stop" | undefined {
  switch (event.type) {
    case "control.start.requested":
      return "start";
    case "control.pause.requested":
      return "pause";
    case "control.resume.requested":
      return "resume";
    case "control.stop.requested":
      return "stop";
    default:
      return undefined;
  }
}

function actorStateForState(stateId: string): SyncActorState {
  const state = SIGNED_SYNC_STATECHART.states.find((candidate) => candidate.id === stateId);
  return syncActorStateSchema.parse(
    state && "public" in state ? state.public.actorState : "stopped",
  );
}

function emitControlDecision(
  action:
    | "emitControlAccepted"
    | "emitControlCompleted"
    | "emitControlPending"
    | "emitControlRejected",
  context: SyncLifecycleContext,
  event: SyncLifecycleEvent,
  source: string | readonly string[],
  target: string | null | undefined,
  sink: ((decision: SyncControlDecision) => void) | undefined,
): void {
  if (!sink) return;
  const command = controlCommand(event);
  if (!command || !("commandId" in event)) return;
  const sourceState = typeof source === "string" ? source : source[0];
  if (!sourceState) return;
  const actorState = actorStateForState(target ?? sourceState);
  const observed = { actorState, incarnationId: context.incarnationId, version: context.version };
  if (action === "emitControlRejected") {
    const stateId = target ?? sourceState;
    const reason =
      "expectedVersion" in event &&
      event.expectedVersion !== undefined &&
      event.expectedVersion !== context.version
        ? "stale-version"
        : stateId === "stopping.forShutdown" || stateId === "stopped.shutdown"
          ? "shutdown-terminal"
          : stateId.startsWith("stopping.")
            ? "busy"
            : "incompatible-state";
    sink({
      kind: "rejected",
      commandId: event.commandId,
      reason,
      observed,
    });
    return;
  }
  if (action === "emitControlAccepted") {
    sink({
      kind: "accepted",
      commandId: event.commandId,
      target: {
        command,
        actorStates:
          command === "resume"
            ? ["starting"]
            : command === "start"
              ? ["starting", "backfilling", "sweeping", "retrying"]
              : [actorState],
        completed: false,
      },
      observed,
    });
    return;
  }
  if (action === "emitControlPending") {
    sink({
      kind: "accepted",
      commandId: event.commandId,
      target: {
        command,
        actorStates:
          command === "pause" ? ["paused"] : command === "stop" ? ["stopped"] : [actorState],
        completed: true,
      },
      observed,
    });
    return;
  }
  sink({
    kind: "accepted",
    commandId: event.commandId,
    target: { command, actorStates: [actorState], completed: true },
    observed,
  });
}

function expectedVersionMatches(context: SyncLifecycleContext, event: SyncLifecycleEvent): boolean {
  return (
    !("expectedVersion" in event) ||
    event.expectedVersion === undefined ||
    event.expectedVersion === context.version
  );
}

function scopeIsCurrent(context: SyncLifecycleContext, event: SyncLifecycleEvent): boolean {
  return "scopeEpoch" in event && event.scopeEpoch === context.scopeEpoch;
}

function idleReadyUnseenForScope(context: SyncLifecycleContext): boolean {
  return context.idleReadyEpoch !== context.scopeEpoch;
}
function faultCategory(
  context: SyncLifecycleContext,
  event: SyncLifecycleEvent,
): WorkflowFaultCategory | undefined {
  return eventFault(event)?.category;
}
function attemptedRevision(context: SyncLifecycleContext, event: SyncLifecycleEvent): number {
  return (
    eventFault(event)?.attemptedCredentialRevision ??
    context.activeCredentialRevision ??
    context.latestCredentialRevision
  );
}

function evaluateGuard(
  name: string,
  context: SyncLifecycleContext,
  event: SyncLifecycleEvent,
  configuration: SyncLifecycleConfiguration,
  source: string | readonly string[],
  dependencies: SyncLifecycleDependencies,
): boolean {
  switch (name) {
    case "expectedVersionMatches":
      return expectedVersionMatches(context, event);
    case "scopeIsCurrent":
      return scopeIsCurrent(context, event);
    case "idleReadyUnseenForScope":
      return idleReadyUnseenForScope(context);
    case "bootstrapNeedsBackfill":
      return bootstrapOutput(event)?.next === "backfill";
    case "bootstrapUsesIdle":
      return bootstrapOutput(event)?.next === "idle";
    case "bootstrapUsesPolling":
      return bootstrapOutput(event)?.next === "poll";
    case "backfillCompletedNow":
      return loopOutput(event)?.status === "completed";
    case "backfillAlreadyComplete":
      return loopOutput(event)?.status === "already-complete";
    case "actorResultUsesIdle":
      return loopOutput(event)?.watchStrategy === "idle";
    case "actorResultUsesPolling":
      return loopOutput(event)?.watchStrategy === "poll";
    case "backfillReturnedUnexpectedCancellation":
      return loopOutput(event)?.status === "cancelled";
    case "sweepCompletedNow":
      return loopOutput(event)?.status === "completed";
    case "sweepNotEligible":
      return loopOutput(event)?.status === "not-eligible";
    case "sweepViolatedOwnership":
      return loopOutput(event)?.status === "not-owner" || loopOutput(event)?.status === "cancelled";
    case "faultIsAuthentication":
      return faultCategory(context, event) === "authentication";
    case "faultIsTransient":
      return faultCategory(context, event) === "transient";
    case "faultIsFatal":
      return (
        faultCategory(context, event) === "permanent" ||
        faultCategory(context, event) === "invariant" ||
        (event.type === "xstate.error.actor.cleanupBarrier" && isCleanupTerminalFault(event.error))
      );
    case "retryBudgetAvailable":
      return context.retryAttempt + 1 <= configuration.maxRetryAttempts;
    case "retryBudgetExhausted":
      return context.retryAttempt + 1 > configuration.maxRetryAttempts;
    case "cleanupCertificateCoversState":
      return cleanupCertificateCoversState(
        context,
        event,
        false,
        source,
        dependencies.resourceRegistry,
      );
    case "cleanupFailureCertificateCoversState":
      return cleanupCertificateCoversState(
        context,
        event,
        true,
        source,
        dependencies.resourceRegistry,
      );
    case "credentialRevisionIsNewer":
      return "revision" in event && event.revision > context.latestCredentialRevision;
    case "authFaultUsesSupersededRevision":
      return (
        faultCategory(context, event) === "authentication" &&
        attemptedRevision(context, event) < context.latestCredentialRevision
      );
    case "authFaultUsesCurrentRevision":
      return (
        faultCategory(context, event) === "authentication" &&
        attemptedRevision(context, event) === context.latestCredentialRevision
      );
    case "authFaultUsesFutureRevision":
      return (
        faultCategory(context, event) === "authentication" &&
        attemptedRevision(context, event) > context.latestCredentialRevision
      );
    case "pendingAuthFaultWasSuperseded":
      return (
        context.authFaultCredentialRevision !== null &&
        context.authFaultCredentialRevision < context.latestCredentialRevision
      );
    case "pendingAuthFaultIsCurrent":
      return context.authFaultCredentialRevision === context.latestCredentialRevision;
    default:
      return false;
  }
}

function isCleanupTerminalFault(value: unknown): value is CleanupTerminalFault {
  return cleanupTerminalFaultSchema.safeParse(value).success;
}

function cleanupCertificateCoversState(
  context: SyncLifecycleContext,
  event: SyncLifecycleEvent,
  error: boolean,
  source: string | readonly string[],
  resourceRegistry: SyncResourceRegistryAuthority,
): boolean {
  const candidate = cleanupOutput(event);
  if (!candidate || !cleanupCertificateSchema.safeParse(candidate).success) return false;
  const phase = resourceRegistry.currentPhase;
  if (!phase || phase.terminal.status === "pending") return false;
  const sourceIds = typeof source === "string" ? [source] : source;
  const minimumScopes = sourceIds.map((sourceId) => {
    const state = SIGNED_SYNC_STATECHART.states.find((item) => item.id === sourceId);
    return state && "cleanupRequirement" in state ? state.cleanupRequirement.minimumScope : null;
  });
  if (
    minimumScopes.some((minimumScope) => minimumScope === null) ||
    minimumScopes.some(
      (minimumScope) =>
        minimumScope !== undefined &&
        !(candidate.effectiveScope === "workflow" || minimumScope === "watch"),
    )
  )
    return false;
  const terminalCertificate = phase.terminal.certificate;
  return (
    candidate.cleanupEpoch === context.cleanupEpoch &&
    candidate.cleanupPhase === context.cleanupPhase &&
    candidate.invokeLease === context.cleanupInvokeLease &&
    candidate.effectiveScope === context.effectiveCleanupScope &&
    phase.cleanupEpoch === context.cleanupEpoch &&
    phase.cleanupPhase === context.cleanupPhase &&
    phase.effectiveScope === context.effectiveCleanupScope &&
    candidate.cleanupEpoch === phase.cleanupEpoch &&
    candidate.cleanupPhase === phase.cleanupPhase &&
    candidate.effectiveScope === phase.effectiveScope &&
    candidate.frozenReleaseSetId === phase.frozenReleaseSetId &&
    candidate.certificateId === phase.certificateId &&
    candidate.authoritativeAudit.digest === phase.auditDigest &&
    terminalCertificate.certificateId === candidate.certificateId &&
    terminalCertificate.cleanupEpoch === candidate.cleanupEpoch &&
    terminalCertificate.cleanupPhase === candidate.cleanupPhase &&
    terminalCertificate.invokeLease === candidate.invokeLease &&
    terminalCertificate.effectiveScope === candidate.effectiveScope &&
    terminalCertificate.frozenReleaseSetId === candidate.frozenReleaseSetId &&
    terminalCertificate.released === candidate.released &&
    terminalCertificate.authoritativeAudit.scope === candidate.authoritativeAudit.scope &&
    terminalCertificate.authoritativeAudit.frozenReleaseSetId ===
      candidate.authoritativeAudit.frozenReleaseSetId &&
    terminalCertificate.authoritativeAudit.liveResourceCount ===
      candidate.authoritativeAudit.liveResourceCount &&
    terminalCertificate.authoritativeAudit.unresolvedReleaseCount ===
      candidate.authoritativeAudit.unresolvedReleaseCount &&
    terminalCertificate.authoritativeAudit.digest === candidate.authoritativeAudit.digest &&
    candidate.authoritativeAudit.scope === candidate.effectiveScope &&
    candidate.authoritativeAudit.frozenReleaseSetId === candidate.frozenReleaseSetId &&
    candidate.released &&
    candidate.authoritativeAudit.liveResourceCount === 0 &&
    candidate.authoritativeAudit.unresolvedReleaseCount === 0 &&
    (!error || event.type === "xstate.error.actor.cleanupBarrier") &&
    (error ? phase.terminal.status === "error" : phase.terminal.status === "success")
  );
}

function atomicStateId(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const entries = Object.entries(value);
  if (entries.length === 0) return "";
  const [key, child] = entries[0];
  const nested = atomicStateId(child);
  return nested ? `${key}.${nested}` : key;
}

const machineSetup = setup({
  types: {
    context: {} as SyncLifecycleContext,
    events: {} as SyncLifecycleEvent,
    input: {} as SyncLifecycleInput,
    tags: {} as "status" | "version",
  },
  actors: defaultActors,
});

function transitionConfig(
  spec: SignedStatechartTransition,
  source: string,
  configuration: SyncLifecycleConfiguration,
  dependencies: SyncLifecycleDependencies,
) {
  const firstGuard = spec.guards[0];
  const guards = spec.guards;
  const targetState = spec.target
    ? SIGNED_SYNC_STATECHART.states.find((state) => state.id === spec.target)
    : undefined;
  return {
    meta: {
      transitionId: spec.id,
      source,
      event: spec.event,
      target: spec.target,
      guards: spec.guards,
      actions: spec.actions,
      stoppedActors: spec.stoppedActors,
      startedActors: spec.startedActors,
      reenter: "reenter" in spec && spec.reenter === true,
      actorInputOwnership: spec.startedActors.map((actor) => ({
        actor,
        target: targetState && "actorInput" in targetState ? targetState.actorInput : null,
      })),
    },
    ...(spec.target ? { target: `#${SYNC_STATECHART_ID}.${spec.target}` } : {}),
    ...("reenter" in spec && spec.reenter === true ? { reenter: true } : {}),
    ...(firstGuard
      ? {
          guard: ({
            context,
            event,
          }: {
            context: SyncLifecycleContext;
            event: SyncLifecycleEvent;
          }) =>
            guards.every((name) =>
              evaluateGuard(name, context, event, configuration, source, dependencies),
            ),
        }
      : {}),
    ...(spec.actions.length > 0
      ? {
          actions: spec.actions.map((name) =>
            machineSetup.assign(
              ({ context, event }: { context: SyncLifecycleContext; event: SyncLifecycleEvent }) =>
                applyAction(name, context, event, source, dependencies, spec.target),
            ),
          ),
        }
      : {}),
  };
}

function stateTransitions(
  stateId: string,
  configuration: SyncLifecycleConfiguration,
  dependencies: SyncLifecycleDependencies,
): Record<string, ReturnType<typeof transitionConfig>[]> {
  const records = SIGNED_TRANSITIONS.filter((transition) =>
    (typeof transition.source === "string" ? [transition.source] : transition.source).some(
      (source) => source === stateId,
    ),
  );
  const map: Record<string, ReturnType<typeof transitionConfig>[]> = {};
  for (const transition of records) {
    const list = map[transition.event] ?? [];
    list.push(transitionConfig(transition, stateId, configuration, dependencies));
    map[transition.event] = list;
  }
  return map;
}

function invokeConfig(
  actor: string,
  configuration: SyncLifecycleConfiguration,
  dependencies: SyncLifecycleDependencies,
  stateId: string,
  lifecycleInput?: SyncLifecycleInput,
): {
  id: string;
  src: string;
  input: ({ context }: { context: SyncLifecycleContext }) => SyncActorInputs;
} {
  const modelState = SIGNED_SYNC_STATECHART.states.find((state) => state.id === stateId);
  const minimumScope =
    modelState && "cleanupRequirement" in modelState
      ? modelState.cleanupRequirement.minimumScope
      : null;
  return {
    id: actor,
    src: actor,
    input: ({ context }) => {
      const phase = minimumScope
        ? dependencies.resourceRegistry.requestPhase({
            minimumScope,
            cleanupEpoch: context.cleanupEpoch,
            cleanupPhase: context.cleanupPhase,
            effectiveScope: context.effectiveCleanupScope ?? minimumScope,
            invokeLease: context.cleanupInvokeLease,
          })
        : null;
      return {
        configuration,
        scopeEpoch: context.scopeEpoch,
        credentialRevision: context.activeCredentialRevision,
        cleanupEpoch: context.cleanupEpoch,
        cleanupPhase: context.cleanupPhase,
        invokeLease: context.cleanupInvokeLease,
        effectiveScope: context.effectiveCleanupScope,
        minimumScope,
        phaseTerminal: phase
          ? dependencies.resourceRegistry.awaitPhase(
              context.cleanupEpoch,
              context.cleanupPhase,
              context.cleanupInvokeLease,
            )
          : null,
        frozenReleaseSetId: phase?.frozenReleaseSetId ?? null,
        resourceRegistry: dependencies.resourceRegistry,
        ...actorSpecificInput(actor, context, configuration, lifecycleInput),
      };
    },
  };
}

function actorSpecificInput(
  actor: string,
  context: SyncLifecycleContext,
  configuration: SyncLifecycleConfiguration,
  lifecycleInput?: SyncLifecycleInput,
): Readonly<Record<string, unknown>> {
  switch (actor) {
    case "bootstrapSession":
      return { checkpoint: context.checkpoint };
    case "initialBackfill":
      return {
        checkpoint: context.checkpoint,
        mailboxWorkSet: Object.freeze({}),
        boundedBatchConfiguration: configuration,
      };
    case "idleSession":
      return { validatedIdleAdapter: lifecycleInput?.validatedIdleAdapter };
    case "periodicStatusTimer":
      return { periodicStatusIntervalMs: configuration.periodicStatusIntervalMs };
    case "recurringSweep":
      return { checkpoint: context.checkpoint, boundedWorkConfiguration: configuration };
    case "retryTimer":
      return {
        retryAttempt: context.retryAttempt,
        retryBaseMs: configuration.retryBaseMs,
        retryCapMs: configuration.retryCapMs,
        retryJitterRatio: configuration.retryJitterRatio,
        injectedRandomSource: lifecycleInput?.retryRandomSource ?? nativeRetryRandomSource,
        injectedClock: lifecycleInput?.retryTimerClock ?? nativeRetryTimerClock,
      };
    case "cleanupBarrier":
      return {};
    case "rawDownloadQueue":
      return { productionDownloadAdapter: undefined, capacity: 1 };
    case "rawDownloadJob":
      return {
        request: undefined,
        signal: new AbortController().signal,
        productionDownloadAdapter: undefined,
      };
    case "controlWaiter":
      return {
        commandId: "injected",
        commandFingerprint: "injected",
        targetPredicate: () => false,
        controlDeadlineMs: configuration.controlDeadlineMs,
        controlResultRetentionMs: configuration.controlResultRetentionMs,
        maxControlIdempotencyEntries: configuration.maxControlIdempotencyEntries,
        injectedMonotonicClock: () => 0,
      };
    default:
      return {};
  }
}

function atomicConfig(
  stateId: string,
  configuration: SyncLifecycleConfiguration,
  dependencies: SyncLifecycleDependencies,
  lifecycleInput?: SyncLifecycleInput,
) {
  const modelState = SIGNED_SYNC_STATECHART.states.find((state) => state.id === stateId);
  const invoked = modelState && "invokedActors" in modelState ? modelState.invokedActors : [];
  return machineSetup.createStateConfig({
    id: stateId,
    tags: ["status", "version"],
    ...(invoked.length > 0
      ? {
          invoke: invoked.map((actor: string) =>
            invokeConfig(actor, configuration, dependencies, stateId, lifecycleInput),
          ),
        }
      : {}),
    on: stateTransitions(stateId, configuration, dependencies),
  });
}

function compoundConfig(
  name: string,
  initial: string,
  configuration: SyncLifecycleConfiguration,
  dependencies: SyncLifecycleDependencies,
  lifecycleInput?: SyncLifecycleInput,
) {
  const children = SIGNED_SYNC_STATECHART.states.filter(
    (state) => "parent" in state && state.parent === name,
  );
  return machineSetup.createStateConfig({
    id: name,
    initial,
    states: Object.fromEntries(
      children.map((child) => [
        child.id.slice(name.length + 1),
        atomicConfig(child.id, configuration, dependencies, lifecycleInput),
      ]),
    ),
  });
}

const rootFallbackTransitions = Object.fromEntries([
  [
    "xstate.init",
    [
      {
        meta: {
          transitionId: "T001",
          source: "@uninitialized",
          event: "xstate.init",
          target: "stopped.clean",
          guards: [],
          actions: [],
          stoppedActors: [],
          startedActors: [],
          reenter: false,
          actorInputOwnership: [],
        },
        target: `#${SYNC_STATECHART_ID}.stopped.clean`,
      },
    ],
  ],
  ["control.start.requested", [{ actions: () => undefined }]],
  ["control.pause.requested", [{ actions: () => undefined }]],
  ["control.resume.requested", [{ actions: () => undefined }]],
  ["control.stop.requested", [{ actions: () => undefined }]],
  ["lifecycle.restart.requested", [{ actions: () => undefined }]],
  ["credentials.changed", [{ actions: () => undefined }]],
  ["process.shutdown.requested", [{ actions: () => undefined }]],
]);

const inspectionConfiguration: SyncLifecycleConfiguration = {
  retryBaseMs: 1,
  retryCapMs: 1,
  retryJitterRatio: 0,
  maxRetryAttempts: 3,
  periodicStatusIntervalMs: 1,
  controlDeadlineMs: 1,
  controlResultRetentionMs: 1,
  maxControlIdempotencyEntries: 1,
  maxReleaseSlotEntries: 8,
};

function createSyncLifecycleMachine(
  configuration: SyncLifecycleConfiguration,
  dependencies: SyncLifecycleDependencies = createDefaultDependencies(),
  lifecycleInput?: SyncLifecycleInput,
) {
  const controlFallbackTransitions = Object.fromEntries(
    [
      "control.start.requested",
      "control.pause.requested",
      "control.resume.requested",
      "control.stop.requested",
    ].map((eventType) => [
      eventType,
      [
        {
          actions: machineSetup.assign(
            ({
              context,
              event,
              self,
            }: {
              context: SyncLifecycleContext;
              event: SyncLifecycleEvent;
              self: AnyActorRef;
            }) =>
              applyAction(
                "emitControlRejected",
                context,
                event,
                atomicStateId(self.getSnapshot().value),
                dependencies,
              ),
          ),
        },
      ],
    ]),
  );
  return machineSetup.createMachine({
    id: SYNC_STATECHART_ID,
    version: SYNC_STATECHART_MODEL_VERSION,
    meta: {
      runtimeActionIds: SIGNED_SYNC_STATECHART.actions.map((action) => action.id),
      runtimeActorIds: Object.keys(defaultActors),
    },
    initial: "stopped",
    context: ({ input }) => initialContext(input),
    on: { ...rootFallbackTransitions, ...controlFallbackTransitions },
    states: {
      stopped: compoundConfig("stopped", "clean", configuration, dependencies, lifecycleInput),
      starting: compoundConfig("starting", "active", configuration, dependencies, lifecycleInput),
      backfilling: compoundConfig(
        "backfilling",
        "active",
        configuration,
        dependencies,
        lifecycleInput,
      ),
      watching: compoundConfig("watching", "idling", configuration, dependencies, lifecycleInput),
      sweeping: compoundConfig("sweeping", "active", configuration, dependencies, lifecycleInput),
      retryWaiting: compoundConfig(
        "retryWaiting",
        "active",
        configuration,
        dependencies,
        lifecycleInput,
      ),
      authBlocked: atomicConfig("authBlocked", configuration, dependencies, lifecycleInput),
      paused: atomicConfig("paused", configuration, dependencies, lifecycleInput),
      stopping: compoundConfig("stopping", "forStop", configuration, dependencies, lifecycleInput),
    },
  });
}

export const syncLifecycleMachine = createSyncLifecycleMachine(inspectionConfiguration);

export type SyncLifecycleMachine = typeof syncLifecycleMachine;
export type SyncLifecycleSnapshot = ReturnType<SyncLifecycleMachine["getInitialSnapshot"]>;

export interface RuntimeStatechartTransition {
  readonly id: string;
  readonly source: string;
  readonly event: string;
  readonly target: string | null;
  readonly guards: readonly string[];
  readonly actions: readonly string[];
  readonly stoppedActors: readonly string[];
  readonly startedActors: readonly string[];
  readonly reenter: boolean;
  readonly actorInputOwnership: readonly Readonly<{
    actor: string;
    target: unknown;
  }>[];
}

export interface RuntimeStatechartNode {
  readonly id: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly invokedActors: readonly string[];
}

export interface RuntimeActorInputMetadata {
  readonly state: string;
  readonly actor: string;
  readonly fields: readonly string[];
}

const checkpointForRuntimeMetadata: SyncCheckpointSummary = {
  completedMailboxes: 0,
  totalMailboxes: 0,
  completedMessages: 0,
  pendingMessages: 0,
  lastMailbox: null,
  lastUid: null,
};

function runtimeTransitionMetadata(
  source: string,
  transition: {
    readonly eventType: string;
    readonly target?: readonly unknown[];
    readonly reenter?: boolean;
    readonly meta?: unknown;
  },
): RuntimeStatechartTransition {
  const metadata = transition.meta;
  if (!isRecord(metadata))
    throw new Error(`missing runtime transition metadata for ${source}:${transition.eventType}`);
  const transitionId = metadata["transitionId"];
  const guards = metadata["guards"];
  const actions = metadata["actions"];
  const stoppedActors = metadata["stoppedActors"];
  const startedActors = metadata["startedActors"];
  const actorInputOwnership = metadata["actorInputOwnership"];
  if (
    typeof transitionId !== "string" ||
    !Array.isArray(guards) ||
    !guards.every((value): value is string => typeof value === "string") ||
    !Array.isArray(actions) ||
    !actions.every((value): value is string => typeof value === "string") ||
    !Array.isArray(stoppedActors) ||
    !stoppedActors.every((value): value is string => typeof value === "string") ||
    !Array.isArray(startedActors) ||
    !startedActors.every((value): value is string => typeof value === "string") ||
    !Array.isArray(actorInputOwnership)
  )
    throw new Error(`invalid runtime transition metadata for ${source}:${transition.eventType}`);
  const target = transition.target?.find(
    (value): value is { readonly id: string } => isRecord(value) && typeof value.id === "string",
  );
  return {
    id: transitionId,
    source,
    event: transition.eventType,
    target: target ? target.id.replace(`${SYNC_STATECHART_ID}.`, "") : null,
    guards,
    actions,
    stoppedActors,
    startedActors,
    reenter: transition.reenter === true,
    actorInputOwnership: actorInputOwnership.filter(
      (value): value is Readonly<{ actor: string; target: unknown }> =>
        typeof value === "object" &&
        value !== null &&
        "actor" in value &&
        typeof value.actor === "string" &&
        "target" in value,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deriveRuntimeStatechartMetadata(): {
  readonly states: readonly RuntimeStatechartNode[];
  readonly events: readonly string[];
  readonly guards: readonly string[];
  readonly actions: readonly string[];
  readonly actors: readonly string[];
  readonly transitions: readonly RuntimeStatechartTransition[];
  readonly expandedTransitions: readonly RuntimeStatechartTransition[];
  readonly actorInputs: readonly RuntimeActorInputMetadata[];
} {
  const states = SIGNED_SYNC_STATECHART.states.map((state) => {
    const node = syncLifecycleMachine.getStateNodeById(`${SYNC_STATECHART_ID}.${state.id}`);
    return {
      id: state.id,
      kind: node.definition.type,
      tags: [...node.tags],
      invokedActors: node.definition.invoke
        .map((invoke) => invoke.src)
        .filter((src): src is string => typeof src === "string"),
    };
  });
  const transitions = SIGNED_ATOMIC_STATES.flatMap((state) => {
    const node = syncLifecycleMachine.getStateNodeById(`${SYNC_STATECHART_ID}.${state.id}`);
    return node.definition.transitions.map((transition) =>
      runtimeTransitionMetadata(state.id, transition),
    );
  });
  const sampleContext = initialContext({
    configuration: inspectionConfiguration,
    initialCheckpoint: checkpointForRuntimeMetadata,
    initialCredentialRevision: 0,
    incarnationId: "runtime-inspection",
  });
  const sampleSelf: AnyActorRef = createActor(syncLifecycleMachine, {
    input: {
      configuration: inspectionConfiguration,
      initialCheckpoint: checkpointForRuntimeMetadata,
      initialCredentialRevision: 0,
      incarnationId: "runtime-inspection",
    },
  });
  const actorInputs = states.flatMap((state) => {
    const node = syncLifecycleMachine.getStateNodeById(`${SYNC_STATECHART_ID}.${state.id}`);
    return node.definition.invoke.map((invoke) => {
      const input =
        typeof invoke.input === "function"
          ? invoke.input({
              context: sampleContext,
              event: { type: "xstate.init" },
              self: sampleSelf,
            })
          : invoke.input;
      return {
        state: state.id,
        actor: invoke.id,
        fields: isRecord(input) ? Object.keys(input) : [],
      };
    });
  });
  const initialTransition = syncLifecycleMachine.definition.transitions.find(
    (transition) => transition.eventType === "xstate.init",
  );
  if (!initialTransition) throw new Error("missing runtime xstate.init transition metadata");
  const expandedTransitions = [
    runtimeTransitionMetadata("@uninitialized", initialTransition),
    ...transitions,
  ];
  const eventIds = new Set<string>(["xstate.init"]);
  const guardIds = new Set<string>();
  const actionIds = new Set<string>();
  const actorIds = new Set<string>();
  for (const state of states) for (const actor of state.invokedActors) actorIds.add(actor);
  for (const transition of transitions) {
    eventIds.add(transition.event);
    for (const guard of transition.guards) guardIds.add(guard);
    for (const action of transition.actions) actionIds.add(action);
    for (const actor of transition.stoppedActors) if (actor !== "@source") actorIds.add(actor);
    for (const actor of transition.startedActors) if (actor !== "@source") actorIds.add(actor);
  }
  const runtimeDeclarations = syncLifecycleMachine.definition.meta;
  if (isRecord(runtimeDeclarations)) {
    const declaredActions = runtimeDeclarations["runtimeActionIds"];
    const declaredActors = runtimeDeclarations["runtimeActorIds"];
    if (Array.isArray(declaredActions))
      for (const action of declaredActions) if (typeof action === "string") actionIds.add(action);
    if (Array.isArray(declaredActors))
      for (const actor of declaredActors) if (typeof actor === "string") actorIds.add(actor);
  }
  return {
    states,
    events: [...eventIds],
    guards: [...guardIds],
    actions: [...actionIds],
    actors: [...actorIds],
    transitions,
    expandedTransitions,
    actorInputs,
  };
}

const runtimeMetadata = deriveRuntimeStatechartMetadata();

export function createSyncLifecycleActor(
  input: SyncLifecycleInput,
  actors: SyncActorImplementations = {},
  dependencies?: SyncLifecycleDependencies,
) {
  validateRetryTimerComposition(input);
  const configuration = syncLifecycleConfigurationSchema.parse(input.configuration);
  const machine = createSyncLifecycleMachine(
    configuration,
    dependencies ?? createDefaultDependencies(input),
    input,
  ).provide({
    actors: { ...defaultActors, ...actors },
  });
  return createActor(machine, { input });
}

export interface SyncLifecycleSnapshotView {
  readonly value: unknown;
  readonly context: SyncLifecycleContext;
}

export function projectSyncStatus(snapshot: SyncLifecycleSnapshotView): SyncStatusResponse {
  const stateId = atomicStateId(snapshot.value);
  const modelState = SIGNED_SYNC_STATECHART.states.find((state) => state.id === stateId);
  const publicState = modelState && "public" in modelState ? modelState.public : undefined;
  const actorState = syncActorStateSchema.parse(publicState?.actorState ?? "stopped");
  const authBlocked = actorState === "authBlocked" ? snapshot.context.authBlockedDetail : null;
  return syncStatusResponseSchema.parse({
    actorState,
    activeOperation: publicState?.activeOperation ?? null,
    authBlocked,
    incarnationId: snapshot.context.incarnationId,
    version: snapshot.context.version,
    checkpoint: snapshot.context.checkpoint,
    diagnostics: snapshot.context.diagnostics,
  });
}

export const syncStatechartInspection = Object.freeze({
  id: SYNC_STATECHART_ID,
  modelVersion: SYNC_STATECHART_MODEL_VERSION,
  modelDigest: SYNC_STATECHART_MODEL_DIGEST,
  stateHierarchy: SIGNED_SYNC_STATECHART.states,
  events: SIGNED_SYNC_STATECHART.events,
  guards: SIGNED_SYNC_STATECHART.guards,
  actions: SIGNED_SYNC_STATECHART.actions,
  actors: SIGNED_SYNC_STATECHART.actors,
  transitions: SIGNED_TRANSITIONS,
  globalEventPolicy: SIGNED_SYNC_STATECHART.globalEventPolicy,
  externalEventIds: SIGNED_EXTERNAL_EVENT_IDS,
  observationTags: ["status", "version"] as const,
  contextFieldCount: 15,
  transitionCount: 91,
  expandedTransitionCount: 204,
  forbiddenConfigurations: SIGNED_SYNC_STATECHART.forbiddenConfigurations,
  generatedStatePaths: SIGNED_SYNC_STATECHART.generatedStatePaths,
  pathCorpus: SIGNED_SYNC_STATECHART.pathCorpus,
  registryChurn: SIGNED_SYNC_STATECHART.registryChurn,
  runtimeStateNodes: runtimeMetadata.states,
  runtimeEventIds: runtimeMetadata.events,
  runtimeGuardIds: runtimeMetadata.guards,
  runtimeActionIds: runtimeMetadata.actions,
  runtimeActorIds: runtimeMetadata.actors,
  runtimeTransitions: runtimeMetadata.transitions,
  runtimeExpandedTransitions: runtimeMetadata.expandedTransitions,
  runtimeActorInputs: runtimeMetadata.actorInputs,
  runtimeStateTransitionCount: SIGNED_ATOMIC_STATES.reduce((count, state) => {
    const node = syncLifecycleMachine.getStateNodeById(state.id);
    return count + node.definition.transitions.length;
  }, 0),
  runtimeExpandedTransitionCount:
    SIGNED_ATOMIC_STATES.reduce((count, state) => {
      const node = syncLifecycleMachine.getStateNodeById(state.id);
      return count + node.definition.transitions.length;
    }, 0) + 1,
});

export function assertInspectionMatchesSignedModel(): void {
  if (syncStatechartInspection.modelDigest !== SIGNED_SYNC_STATECHART.digest)
    throw new Error("sync statechart model digest mismatch");
  if (syncStatechartInspection.transitions.length !== 91)
    throw new Error("sync statechart transition count mismatch");
  if (syncStatechartInspection.contextFieldCount !== 15)
    throw new Error("sync statechart context count mismatch");
  if (syncStatechartInspection.externalEventIds.length !== 7)
    throw new Error("sync statechart external boundary mismatch");
  if (SIGNED_ATOMIC_STATES.length !== 24)
    throw new Error("sync statechart atomic state count mismatch");
  if (syncStatechartInspection.runtimeExpandedTransitionCount !== 204)
    throw new Error("sync statechart expanded transition count mismatch");
  if (syncStatechartInspection.runtimeTransitions.length !== 203)
    throw new Error("sync statechart runtime transition metadata mismatch");
  if (syncStatechartInspection.runtimeStateNodes.length !== 31)
    throw new Error("sync statechart runtime state metadata mismatch");
  if (syncStatechartInspection.runtimeEventIds.length !== 24)
    throw new Error("sync statechart runtime event metadata mismatch");
  if (syncStatechartInspection.runtimeGuardIds.length !== 27)
    throw new Error("sync statechart runtime guard metadata mismatch");
  if (syncStatechartInspection.runtimeActionIds.length !== 24)
    throw new Error("sync statechart runtime action metadata mismatch");
  if (syncStatechartInspection.runtimeActorIds.length !== 10)
    throw new Error("sync statechart runtime actor metadata mismatch");
  if (syncStatechartInspection.runtimeActorInputs.length !== 20)
    throw new Error("sync statechart runtime actor-input metadata mismatch");
}

assertInspectionMatchesSignedModel();

export {
  SIGNED_SYNC_STATECHART,
  SIGNED_TRANSITIONS,
  SIGNED_ATOMIC_STATES,
  SIGNED_EXTERNAL_EVENT_IDS,
};
