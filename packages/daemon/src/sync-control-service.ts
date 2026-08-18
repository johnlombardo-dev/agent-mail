import {
  correlationIdSchema,
  syncControlErrorRegistry,
  syncPauseResponseSchema,
  syncResumeResponseSchema,
  syncStartResponseSchema,
  syncStopResponseSchema,
  type SyncActorState,
  type SyncControlCancelledReason,
  type SyncControlCommand,
  type SyncControlFailedReason,
  type SyncControlRejectedReason,
  type SyncCommonResolverOrdering,
  type SyncControlResolverDirective,
  type SyncControlResolverInput,
  resolvePendingSyncControl,
  type SyncObservedActor,
  type SyncStartResponse,
  type SyncPauseResponse,
  type SyncResumeResponse,
  type SyncStopResponse,
} from "@agent-mail/contracts";
import {
  parseExternalSyncEvent,
  projectSyncStatus,
  type ExternalSyncEvent,
  type SyncLifecycleEvent,
  type SyncLifecycleSnapshotView,
} from "./sync-statechart";

export type SyncControlServiceRequest =
  | Readonly<{
      readonly command: "start";
      readonly commandId: string;
      readonly correlationId: string;
      readonly expectedVersion?: number;
    }>
  | Readonly<{
      readonly command: "pause" | "resume" | "stop";
      readonly commandId: string;
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly expectedVersion?: number;
    }>;

export type SyncControlTarget = Readonly<{
  readonly command: SyncControlCommand;
  readonly actorStates: readonly SyncActorState[];
  readonly completed: boolean;
}>;

export type SyncControlDecision =
  | Readonly<{
      readonly kind: "accepted";
      readonly commandId: string;
      readonly target: SyncControlTarget;
      readonly observed: SyncObservedActor;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly commandId: string;
      readonly reason: SyncControlRejectedReason;
      readonly observed: SyncObservedActor;
    }>
  | Readonly<{
      readonly kind: "failed";
      readonly commandId: string;
      readonly reason: SyncControlFailedReason;
      readonly observed: SyncObservedActor;
    }>
  | Readonly<{
      readonly kind: "cancelled";
      readonly commandId: string;
      readonly reason: SyncControlCancelledReason;
      readonly observed: SyncObservedActor;
    }>;

export interface SyncControlSubscription {
  readonly unsubscribe: () => void;
}

export interface SyncControlDecisionSource {
  readonly subscribe: (
    listener: (decision: SyncControlDecision) => void,
  ) => SyncControlSubscription;
}

export interface SyncControlActor {
  readonly getSnapshot: () => SyncLifecycleSnapshotView;
  readonly send: (event: SyncLifecycleEvent) => void;
  readonly subscribe: (
    listener: (snapshot: SyncLifecycleSnapshotView) => void,
  ) => SyncControlSubscription;
}

export interface SyncControlClock {
  readonly now: () => number;
  readonly setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface SyncControlServiceOptions {
  readonly actor: SyncControlActor;
  readonly decisions: SyncControlDecisionSource;
  readonly controlDeadlineMs: number;
  readonly controlResultRetentionMs: number;
  readonly maxControlIdempotencyEntries: number;
  readonly clock?: SyncControlClock;
}

export type SyncControlServiceResponse =
  | SyncStartResponse
  | SyncPauseResponse
  | SyncResumeResponse
  | SyncStopResponse;
type ServiceResponse = SyncControlServiceResponse;

type ServiceError =
  | Readonly<{ readonly kind: "rejected"; readonly reason: SyncControlRejectedReason }>
  | Readonly<{ readonly kind: "failed"; readonly reason: SyncControlFailedReason }>
  | Readonly<{
      readonly kind: "cancelled";
      readonly reason: SyncControlCancelledReason;
      readonly resolverOrdering?: SyncCommonResolverOrdering;
    }>
  | Readonly<{ readonly kind: "timeout"; readonly deadlineMs: number }>
  | Readonly<{ readonly kind: "conflict"; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "capacity"; readonly capacity: number }>;
type WorkflowSettlement = Extract<ServiceError, { readonly kind: "failed" | "cancelled" }>;

type NormalizedRequest = SyncControlServiceRequest &
  Readonly<{ readonly event: ExternalSyncEvent }>;

type CachedResponse = {
  readonly response: ServiceResponse;
  readonly settledAt: number;
  lastAccessedAt: number;
};

type IdempotencyEntry = {
  readonly key: string;
  readonly fingerprint: string;
  readonly request: NormalizedRequest;
  readonly promise: Promise<ServiceResponse>;
  readonly resolve: (response: ServiceResponse) => void;
  readonly createdAt: number;
  settled: CachedResponse | null;
};

type ActiveWaiter = Readonly<{
  readonly request: NormalizedRequest;
  readonly entry: IdempotencyEntry | null;
  readonly settle: (response: ServiceResponse) => void;
  readonly cancel: () => void;
}>;

const syncControlClock: SyncControlClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

function freezeResponse<T extends ServiceResponse>(response: T): T {
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(response);
  return response;
}

function observedActor(snapshot: SyncLifecycleSnapshotView): SyncObservedActor {
  const status = projectSyncStatus(snapshot);
  return {
    actorState: status.actorState,
    incarnationId: status.incarnationId,
    version: status.version,
  };
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

function normalizeRequest(request: SyncControlServiceRequest): NormalizedRequest {
  const event = (() => {
    switch (request.command) {
      case "start":
        return parseExternalSyncEvent({
          type: "control.start.requested",
          commandId: request.commandId,
          expectedVersion: request.expectedVersion,
        });
      case "pause":
        return parseExternalSyncEvent({
          type: "control.pause.requested",
          commandId: request.commandId,
          idempotencyKey: request.idempotencyKey,
          expectedVersion: request.expectedVersion,
        });
      case "resume":
        return parseExternalSyncEvent({
          type: "control.resume.requested",
          commandId: request.commandId,
          idempotencyKey: request.idempotencyKey,
          expectedVersion: request.expectedVersion,
        });
      case "stop":
        return parseExternalSyncEvent({
          type: "control.stop.requested",
          commandId: request.commandId,
          idempotencyKey: request.idempotencyKey,
          expectedVersion: request.expectedVersion,
        });
      default: {
        throw new Error("unsupported sync control command");
      }
    }
  })();
  correlationIdSchema.parse(request.correlationId);
  return { ...request, event };
}

function commandFingerprint(request: NormalizedRequest): string {
  return JSON.stringify({
    command: request.command,
    idempotencyKey: request.command === "start" ? null : request.idempotencyKey,
    expectedVersion: request.expectedVersion ?? null,
  });
}

function isIdempotent(
  request: NormalizedRequest,
): request is NormalizedRequest &
  Readonly<{ readonly command: "pause" | "resume" | "stop"; readonly idempotencyKey: string }> {
  return request.command !== "start";
}

function errorMessage(code: string): string {
  const definition = syncControlErrorRegistry.get(code);
  if (definition?.message === undefined) throw new Error(`missing sync control message: ${code}`);
  return definition.message;
}

function parseResponse(command: SyncControlCommand, value: unknown): ServiceResponse {
  switch (command) {
    case "start":
      return syncStartResponseSchema.parse(value);
    case "pause":
      return syncPauseResponseSchema.parse(value);
    case "resume":
      return syncResumeResponseSchema.parse(value);
    case "stop":
      return syncStopResponseSchema.parse(value);
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function successResponse(
  request: NormalizedRequest,
  observed: SyncObservedActor,
  completed: boolean,
): ServiceResponse {
  const directive = resolvePendingSyncControl(
    successOrdering(request.command, observed.actorState),
  );
  requireDirective(directive, "completed");
  const value = completed
    ? { accepted: true as const, commandId: request.commandId, completed: true as const, observed }
    : { accepted: true as const, commandId: request.commandId, observed };
  return freezeResponse(parseResponse(request.command, value));
}

function errorResponse(
  request: NormalizedRequest,
  observed: SyncObservedActor,
  error: ServiceError,
): ServiceResponse {
  const directive = resolvePendingSyncControl(errorOrdering(request.command, error));
  requireDirective(
    directive,
    error.kind === "timeout"
      ? "timeout"
      : error.kind === "conflict"
        ? "conflict"
        : error.kind === "capacity"
          ? "capacity"
          : error.kind,
  );
  const base = {
    commandId: request.commandId,
    command: request.command,
    actorState: observed.actorState,
    version: observed.version,
    incarnationId: observed.incarnationId,
  };
  const value = (() => {
    switch (error.kind) {
      case "rejected":
        return {
          code: "sync.control-rejected",
          message: errorMessage("sync.control-rejected"),
          correlationId: request.correlationId,
          details: { ...base, reason: error.reason },
        };
      case "failed":
        return {
          code: "sync.control-failed",
          message: errorMessage("sync.control-failed"),
          correlationId: request.correlationId,
          details: { ...base, reason: error.reason },
        };
      case "cancelled":
        return {
          code: "sync.control-cancelled",
          message: errorMessage("sync.control-cancelled"),
          correlationId: request.correlationId,
          details: { ...base, reason: error.reason },
        };
      case "timeout":
        return {
          code: "sync.control-timeout",
          message: errorMessage("sync.control-timeout"),
          correlationId: request.correlationId,
          details: { ...base, reason: "deadline-elapsed" as const, deadlineMs: error.deadlineMs },
        };
      case "conflict":
        return {
          code: "sync.control-idempotency-conflict",
          message: errorMessage("sync.control-idempotency-conflict"),
          correlationId: request.correlationId,
          details: {
            ...base,
            command: request.command,
            reason: "key-reused-with-different-fingerprint" as const,
            idempotencyKey: error.idempotencyKey,
          },
        };
      case "capacity":
        return {
          code: "sync.control-capacity",
          message: errorMessage("sync.control-capacity"),
          correlationId: request.correlationId,
          details: {
            ...base,
            command: request.command,
            reason: "all-retained-entries-in-flight" as const,
            capacity: error.capacity,
          },
        };
      default: {
        const exhaustive: never = error;
        return exhaustive;
      }
    }
  })();
  return freezeResponse(parseResponse(request.command, value));
}

function requireDirective(
  directive: SyncControlResolverDirective,
  settlement: SyncControlResolverDirective["settlement"],
): void {
  if (directive.settlement !== settlement)
    throw new Error(
      `sync control resolver mismatch: expected ${settlement}, got ${directive.settlement}`,
    );
  if (settlement === "completed" && directive.errorCode !== null)
    throw new Error("sync control resolver marked success with an error code");
  if (settlement !== "completed" && directive.errorCode === null)
    throw new Error("sync control resolver omitted the registered error code");
}

function commonOrdering(
  command: SyncControlCommand,
  ordering: SyncCommonResolverOrdering,
): SyncControlResolverInput {
  switch (command) {
    case "start":
      return { command, ordering };
    case "pause":
      return { command, ordering };
    case "resume":
      return { command, ordering };
    case "stop":
      return { command, ordering };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function successOrdering(
  command: SyncControlCommand,
  actorState: SyncActorState,
): SyncControlResolverInput {
  switch (command) {
    case "start":
      switch (actorState) {
        case "starting":
          return { command, ordering: "success-starting" };
        case "backfilling":
          return { command, ordering: "success-backfilling" };
        case "watching":
          return { command, ordering: "success-watching" };
        case "sweeping":
          return { command, ordering: "success-sweeping" };
        case "retrying":
          return { command, ordering: "success-retrying" };
        default:
          throw new Error(`invalid start success state: ${actorState}`);
      }
    case "pause":
      if (actorState !== "paused") throw new Error(`invalid pause success state: ${actorState}`);
      return { command, ordering: "success-paused" };
    case "resume":
      switch (actorState) {
        case "starting":
          return { command, ordering: "success-starting" };
        case "backfilling":
          return { command, ordering: "success-backfilling" };
        case "watching":
          return { command, ordering: "success-watching" };
        case "sweeping":
          return { command, ordering: "success-sweeping" };
        case "retrying":
          return { command, ordering: "success-retrying" };
        default:
          throw new Error(`invalid resume success state: ${actorState}`);
      }
    case "stop":
      if (actorState !== "stopped") throw new Error(`invalid stop success state: ${actorState}`);
      return { command, ordering: "success-stopped" };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function errorOrdering(command: SyncControlCommand, error: ServiceError): SyncControlResolverInput {
  switch (error.kind) {
    case "rejected":
      return commonOrdering(command, error.reason);
    case "failed":
      return commonOrdering(command, error.reason);
    case "cancelled":
      return commonOrdering(command, error.resolverOrdering ?? error.reason);
    case "timeout":
      return commonOrdering(command, "deadline-elapsed");
    case "conflict":
      if (command === "start") throw new Error("start cannot have idempotency conflict");
      return { command, ordering: "idempotency-conflict" };
    case "capacity":
      if (command === "start") throw new Error("start cannot have idempotency capacity");
      return { command, ordering: "capacity-exhausted" };
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function targetIsCompatible(
  request: NormalizedRequest,
  decision: Extract<SyncControlDecision, { readonly kind: "accepted" }>,
  observed: SyncObservedActor,
): boolean {
  return (
    decision.target.command === request.command &&
    decision.target.actorStates.includes(observed.actorState) &&
    decision.observed.incarnationId === observed.incarnationId &&
    decision.observed.version <= observed.version
  );
}

function createEvent(request: NormalizedRequest): SyncLifecycleEvent {
  return request.event;
}

export function createSyncControlDecisionChannel(): {
  readonly source: SyncControlDecisionSource;
  readonly publish: (decision: SyncControlDecision) => void;
} {
  const listeners = new Set<(decision: SyncControlDecision) => void>();
  return {
    source: {
      subscribe: (listener) => {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    },
    publish: (decision) => {
      for (const listener of Array.from(listeners)) listener(decision);
    },
  };
}

export interface SyncControlService {
  readonly execute: (request: SyncControlServiceRequest) => Promise<SyncControlServiceResponse>;
  readonly close: () => void;
}

export function createSyncControlService(options: SyncControlServiceOptions): SyncControlService {
  const clock = options.clock ?? syncControlClock;
  const entries = new Map<string, IdempotencyEntry>();
  const activeWaiters = new Set<ActiveWaiter>();
  const observedIncarnations = new Set<string>();
  let currentIncarnation: string | null = null;
  let closed = false;

  const evict = (now: number): void => {
    for (const [key, entry] of entries) {
      if (
        entry.settled !== null &&
        now - entry.settled.settledAt >= options.controlResultRetentionMs
      )
        entries.delete(key);
    }
    while (entries.size >= options.maxControlIdempotencyEntries) {
      const settled = [...entries.entries()]
        .filter(([, entry]) => entry.settled !== null)
        .sort(
          ([, left], [, right]) =>
            (left.settled?.lastAccessedAt ?? Number.POSITIVE_INFINITY) -
            (right.settled?.lastAccessedAt ?? Number.POSITIVE_INFINITY),
        )[0];
      if (settled === undefined) return;
      entries.delete(settled[0]);
    }
  };

  const settleIncarnation = (observation: SyncObservedActor): void => {
    if (currentIncarnation === null) {
      currentIncarnation = observation.incarnationId;
      observedIncarnations.add(observation.incarnationId);
      return;
    }
    if (currentIncarnation === observation.incarnationId) return;
    // A delayed decision from an already retired actor must not resurrect the
    // old map or cancel waiters belonging to the current incarnation.
    if (observedIncarnations.has(observation.incarnationId)) return;
    observedIncarnations.add(observation.incarnationId);
    currentIncarnation = observation.incarnationId;
    for (const waiter of Array.from(activeWaiters))
      waiter.settle(
        errorResponse(waiter.request, observation, {
          kind: "cancelled",
          reason: "superseded-by-restart",
          resolverOrdering: "process-reconstruction",
        }),
      );
    entries.clear();
  };

  const settleFromWorkflowState = (
    snapshot: SyncLifecycleSnapshotView,
    observation: SyncObservedActor,
  ): void => {
    const stateId = atomicStateId(snapshot.value);
    const settlement: WorkflowSettlement | null =
      stateId === "authBlocked"
        ? { kind: "failed", reason: "auth-blocked" }
        : stateId === "stopped.failed" || stateId === "stopping.afterFailure"
          ? { kind: "failed", reason: "terminal-failure" }
          : stateId === "stopping.forStop"
            ? { kind: "cancelled", reason: "superseded-by-stop" }
            : stateId === "stopping.forRestart"
              ? { kind: "cancelled", reason: "superseded-by-restart" }
              : stateId === "stopping.forShutdown" || stateId === "stopped.shutdown"
                ? { kind: "cancelled", reason: "superseded-by-shutdown" }
                : null;
    if (!settlement) return;
    for (const waiter of Array.from(activeWaiters)) {
      if (
        settlement.kind === "cancelled" &&
        stateId === "stopping.forStop" &&
        waiter.request.command === "stop"
      )
        continue;
      waiter.settle(errorResponse(waiter.request, observation, settlement));
    }
  };

  const execute = (request: SyncControlServiceRequest): Promise<SyncControlServiceResponse> => {
    if (closed) return Promise.reject(new Error("sync control service is closed"));
    const normalized = normalizeRequest(request);
    const now = clock.now();
    const observation = observedActor(options.actor.getSnapshot());
    settleIncarnation(observation);

    if (!isIdempotent(normalized)) return startWaiter(normalized, null);

    const fingerprint = commandFingerprint(normalized);
    const existing = entries.get(normalized.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint)
        return Promise.resolve(
          errorResponse(normalized, observation, {
            kind: "conflict",
            idempotencyKey: normalized.idempotencyKey,
          }),
        );
      if (existing.settled !== null) {
        existing.settled = {
          ...existing.settled,
          lastAccessedAt: now,
        };
        return Promise.resolve(existing.settled.response);
      }
      return existing.promise;
    }

    evict(now);
    if (entries.size >= options.maxControlIdempotencyEntries)
      return Promise.resolve(
        errorResponse(normalized, observation, {
          kind: "capacity",
          capacity: options.maxControlIdempotencyEntries,
        }),
      );

    let resolve: (response: ServiceResponse) => void = () => undefined;
    const promise = new Promise<ServiceResponse>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const entry: IdempotencyEntry = {
      key: normalized.idempotencyKey,
      fingerprint,
      request: normalized,
      promise,
      resolve,
      createdAt: now,
      settled: null,
    };
    entries.set(entry.key, entry);
    void startWaiter(normalized, entry);
    return promise;
  };

  function startWaiter(
    request: NormalizedRequest,
    entry: IdempotencyEntry | null,
  ): Promise<ServiceResponse> {
    let resolveResponse: (response: ServiceResponse) => void = () => undefined;
    const promise =
      entry?.promise ??
      new Promise<ServiceResponse>((resolve) => {
        resolveResponse = resolve;
      });
    let settled = false;
    // A decision and an actor snapshot are separate observations.  Keeping both
    // prevents a decision emitted synchronously by actor.send from being
    // mistaken for the actor subscription notification that may never arrive
    // for an idempotent no-op.
    let latestSnapshot: SyncObservedActor | undefined;
    let latestObservation: SyncObservedActor | undefined;
    let decision: Extract<SyncControlDecision, { readonly kind: "accepted" }> | undefined;
    let deadline: ReturnType<typeof globalThis.setTimeout> | undefined;
    let removeDecision: (() => void) | undefined;
    let removeSnapshots: (() => void) | undefined;

    const settle = (response: ServiceResponse): void => {
      if (settled) return;
      settled = true;
      const frozen = freezeResponse(response);
      if (entry !== null) {
        entry.settled = {
          response: frozen,
          settledAt: clock.now(),
          lastAccessedAt: clock.now(),
        };
        entry.resolve(frozen);
      } else resolveResponse(frozen);
      if (deadline !== undefined) clock.clearTimeout(deadline);
      removeDecision?.();
      removeSnapshots?.();
      activeWaiters.delete(waiter);
    };

    const evaluate = (): void => {
      if (settled || latestSnapshot === undefined || decision === undefined) return;
      if (!targetIsCompatible(request, decision, latestSnapshot)) return;
      settle(successResponse(request, latestSnapshot, decision.target.completed));
    };

    const onDecision = (candidate: SyncControlDecision): void => {
      if (settled) return;

      // Every decision carries a real actor observation.  Retain it for timeout
      // diagnostics and reconstruction detection even when it belongs to a
      // different command; the command id only selects this waiter's outcome.
      settleIncarnation(candidate.observed);
      if (settled || currentIncarnation !== candidate.observed.incarnationId) return;
      latestObservation = candidate.observed;
      if (candidate.commandId !== request.commandId) {
        if (candidate.kind === "accepted" && candidate.target.command !== request.command) {
          settle(
            errorResponse(request, candidate.observed, {
              kind: "cancelled",
              reason:
                candidate.target.command === "stop"
                  ? "superseded-by-stop"
                  : "superseded-by-incompatible-command",
            }),
          );
        }
        return;
      }
      switch (candidate.kind) {
        case "accepted":
          decision = candidate;
          evaluate();
          return;
        case "rejected":
          settle(
            errorResponse(request, latestObservation, {
              kind: "rejected",
              reason: candidate.reason,
            }),
          );
          return;
        case "failed":
          settle(
            errorResponse(request, latestObservation, { kind: "failed", reason: candidate.reason }),
          );
          return;
        case "cancelled":
          settle(
            errorResponse(request, latestObservation, {
              kind: "cancelled",
              reason: candidate.reason,
            }),
          );
          return;
        default: {
          const exhaustive: never = candidate;
          return exhaustive;
        }
      }
    };

    const onSnapshot = (snapshot: SyncLifecycleSnapshotView): void => {
      const next = observedActor(snapshot);
      settleIncarnation(next);
      if (currentIncarnation !== next.incarnationId) return;
      latestSnapshot = next;
      latestObservation = next;
      settleFromWorkflowState(snapshot, next);
      evaluate();
    };

    const cancel = (): void => {
      const observation = latestObservation ?? observedActor(options.actor.getSnapshot());
      settle(
        errorResponse(request, observation, { kind: "cancelled", reason: "superseded-by-restart" }),
      );
    };
    const waiter: ActiveWaiter = { request, entry, settle, cancel };
    activeWaiters.add(waiter);

    try {
      deadline = clock.setTimeout(() => {
        const observation = latestObservation ?? observedActor(options.actor.getSnapshot());
        settle(
          errorResponse(request, observation, {
            kind: "timeout",
            deadlineMs: options.controlDeadlineMs,
          }),
        );
      }, options.controlDeadlineMs);
      removeDecision = options.decisions.subscribe(onDecision).unsubscribe;
      removeSnapshots = options.actor.subscribe(onSnapshot).unsubscribe;
      const preSend = observedActor(options.actor.getSnapshot());
      latestSnapshot = preSend;
      latestObservation = preSend;
      settleIncarnation(preSend);
      options.actor.send(createEvent(request));
      const postSend = observedActor(options.actor.getSnapshot());
      latestSnapshot = postSend;
      latestObservation = postSend;
      settleIncarnation(postSend);
      evaluate();
    } catch {
      const observation = latestObservation ?? observedActor(options.actor.getSnapshot());
      settle(errorResponse(request, observation, { kind: "failed", reason: "terminal-failure" }));
    }
    return promise;
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    const observation = observedActor(options.actor.getSnapshot());
    for (const waiter of Array.from(activeWaiters))
      waiter.settle(
        errorResponse(waiter.request, observation, {
          kind: "cancelled",
          reason: "superseded-by-shutdown",
        }),
      );
    entries.clear();
  };

  return Object.freeze({ execute, close });
}
