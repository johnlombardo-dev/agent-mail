import { describe, expect, test } from "bun:test";
import { fromCallback, fromPromise } from "xstate";
import {
  createPollingTimerActorLogic,
  type PollingTimerClock,
  type PollingTimerHandle,
} from "../src/polling-timer-actor";
import {
  createSyncLifecycleActor,
  type CleanupCertificate,
  type SyncActorInputs,
  type SyncCleanupPhaseRequest,
  type SyncCleanupPhaseSnapshot,
  type SyncCleanupPhaseTerminal,
  type SyncLifecycleConfiguration,
  type SyncLifecycleDependencies,
  type SyncLifecycleEvent,
} from "../src/sync-statechart";

const checkpoint = {
  completedMailboxes: 0,
  totalMailboxes: 0,
  completedMessages: 0,
  pendingMessages: 0,
  lastMailbox: null,
  lastUid: null,
} as const;

const configuration: SyncLifecycleConfiguration = {
  retryBaseMs: 1,
  retryCapMs: 1,
  retryJitterRatio: 0,
  maxRetryAttempts: 1,
  periodicStatusIntervalMs: 10,
  controlDeadlineMs: 1,
  controlResultRetentionMs: 1,
  maxControlIdempotencyEntries: 1,
  maxReleaseSlotEntries: 8,
};

type VirtualTimer = Readonly<{
  readonly callback: () => void;
  readonly delayMs: number;
  readonly handle: PollingTimerHandle;
}>;

class VirtualClock implements PollingTimerClock {
  private nextHandle = 1;
  private readonly timers = new Map<PollingTimerHandle, VirtualTimer>();
  clearCalls = 0;
  scheduledDelays: number[] = [];

  get activeTimerCount(): number {
    return this.timers.size;
  }

  setTimeout(callback: () => void, delayMs: number): PollingTimerHandle {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduledDelays.push(delayMs);
    this.timers.set(handle, { callback, delayMs, handle });
    return handle;
  }

  clearTimeout(handle: PollingTimerHandle): void {
    this.clearCalls += 1;
    this.timers.delete(handle);
  }

  tick(): number {
    const pending = [...this.timers.values()];
    for (const timer of pending) {
      this.timers.delete(timer.handle);
      timer.callback();
    }
    return pending.length;
  }
}

class ControlledIdleServer {
  private readonly listeners = new Set<() => void>();
  notifications = 0;

  get listenerCount(): number {
    return this.listeners.size;
  }

  addListener(listener: () => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: () => void): void {
    this.listeners.delete(listener);
  }

  notify(): void {
    this.notifications += 1;
    for (const listener of this.listeners) listener();
  }
}

class AbortListenerProbe {
  activeAbortListeners = 0;

  createController(): AbortController {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    const listeners = new Set<EventListenerOrEventListenerObject>();

    signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      if (type === "abort") {
        listeners.add(listener);
        this.activeAbortListeners += 1;
      }
      originalAdd(type, listener, options);
    };
    signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void => {
      if (type === "abort" && listeners.delete(listener)) this.activeAbortListeners -= 1;
      originalRemove(type, listener, options);
    };

    return controller;
  }
}

type CleanupAuthority = Readonly<{
  readonly dependencies: SyncLifecycleDependencies;
  readonly completeCurrentPhase: () => void;
  readonly currentPhase: () => SyncCleanupPhaseSnapshot | null;
}>;

function createCleanupAuthority(): CleanupAuthority {
  let currentPhase: SyncCleanupPhaseSnapshot | null = null;
  let pendingResolve: ((terminal: SyncCleanupPhaseTerminal) => void) | null = null;
  let pendingCertificate: CleanupCertificate | null = null;

  const requestPhase = (request: SyncCleanupPhaseRequest): SyncCleanupPhaseSnapshot => {
    const certificate: CleanupCertificate = {
      certificateId: `certificate:issue-132:${request.cleanupEpoch}:${request.cleanupPhase}`,
      cleanupEpoch: request.cleanupEpoch,
      cleanupPhase: request.cleanupPhase,
      invokeLease: request.invokeLease,
      effectiveScope: request.effectiveScope,
      frozenReleaseSetId: `release-set:issue-132:${request.cleanupEpoch}:${request.cleanupPhase}`,
      released: true,
      authoritativeAudit: {
        scope: request.effectiveScope,
        frozenReleaseSetId: `release-set:issue-132:${request.cleanupEpoch}:${request.cleanupPhase}`,
        liveResourceCount: 0,
        unresolvedReleaseCount: 0,
        digest: `digest:issue-132:${request.cleanupEpoch}:${request.cleanupPhase}`,
      },
      diagnostics: [],
    };
    currentPhase = {
      cleanupEpoch: request.cleanupEpoch,
      cleanupPhase: request.cleanupPhase,
      effectiveScope: request.effectiveScope,
      frozenReleaseSetId: certificate.frozenReleaseSetId,
      certificateId: certificate.certificateId,
      auditDigest: certificate.authoritativeAudit.digest,
      terminal: { status: "pending" },
    };
    pendingCertificate = certificate;
    return currentPhase;
  };

  const phasePromises = new Map<string, Promise<SyncCleanupPhaseTerminal>>();
  const authority: SyncLifecycleDependencies = {
    resourceRegistry: {
      get currentPhase() {
        return currentPhase;
      },
      requestPhase,
      awaitPhase: async (cleanupEpoch, cleanupPhase) => {
        const key = `${cleanupEpoch}:${cleanupPhase}`;
        const existing = phasePromises.get(key);
        if (existing) return existing;
        const promise = new Promise<SyncCleanupPhaseTerminal>((resolve) => {
          pendingResolve = resolve;
        });
        phasePromises.set(key, promise);
        return promise;
      },
    },
  };

  return {
    dependencies: authority,
    currentPhase: () => currentPhase,
    completeCurrentPhase: () => {
      if (!currentPhase || !pendingCertificate || !pendingResolve)
        throw new Error("cleanup phase is not awaiting authoritative completion");
      const certificate = pendingCertificate;
      const terminal: SyncCleanupPhaseTerminal = { status: "success", certificate };
      currentPhase = { ...currentPhase, terminal };
      pendingResolve(terminal);
      pendingResolve = null;
      pendingCertificate = null;
    },
  };
}

type LifecycleActor = ReturnType<typeof createSyncLifecycleActor>;
type LifecycleSnapshot = ReturnType<LifecycleActor["getSnapshot"]>;

async function waitForSnapshot(
  actor: LifecycleActor,
  predicate: (snapshot: LifecycleSnapshot) => boolean,
): Promise<LifecycleSnapshot> {
  const current = actor.getSnapshot();
  if (predicate(current)) return current;
  return new Promise((resolve) => {
    const subscription = actor.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      subscription.unsubscribe();
      resolve(snapshot);
    });
  });
}

function makeActor(
  clock: VirtualClock,
  server: ControlledIdleServer,
  abortProbe: AbortListenerProbe,
  authority: CleanupAuthority,
  intervalMs = configuration.periodicStatusIntervalMs,
) {
  let activeIdleChildren = 0;
  let activeIdleListeners = 0;
  let timerTicks = 0;

  const idleSession = fromCallback<SyncLifecycleEvent, SyncActorInputs>(() => {
    const listener = (): void => undefined;
    activeIdleChildren += 1;
    activeIdleListeners += 1;
    server.addListener(listener);
    return () => {
      server.removeListener(listener);
      activeIdleListeners -= 1;
      activeIdleChildren -= 1;
    };
  });
  const periodicStatusTimer = createPollingTimerActorLogic({
    clock,
    createAbortController: () => abortProbe.createController(),
    onTick: () => {
      timerTicks += 1;
    },
  });
  const cleanupBarrier = fromPromise(async ({ input: value }: { input: SyncActorInputs }) => {
    if (!value.phaseTerminal) throw new Error("cleanup barrier missing phase terminal");
    const terminal = await value.phaseTerminal;
    if (terminal.status === "success") return terminal.certificate;
    if (terminal.status === "error") throw terminal.fault;
    throw new Error("cleanup barrier resolved before authoritative completion");
  });
  const actor = createSyncLifecycleActor(
    {
      configuration: { ...configuration, periodicStatusIntervalMs: intervalMs },
      initialCheckpoint: checkpoint,
      initialCredentialRevision: 0,
      incarnationId: "incarnation:issue-132",
    },
    {
      bootstrapSession: fromPromise(async () => ({ next: "idle" as const, checkpoint })),
      idleSession,
      periodicStatusTimer,
      cleanupBarrier,
    },
    authority.dependencies,
  );

  return {
    actor,
    get activeIdleChildren() {
      return activeIdleChildren;
    },
    get activeIdleListeners() {
      return activeIdleListeners;
    },
    get timerTicks() {
      return timerTicks;
    },
  };
}

function sendPause(actor: LifecycleActor, cycle: number): void {
  actor.send({
    type: "control.pause.requested",
    commandId: `issue-132-pause-${cycle}`,
    idempotencyKey: `issue-132-pause-${cycle}`,
  });
}

function sendResume(actor: LifecycleActor, cycle: number): void {
  actor.send({
    type: "control.resume.requested",
    commandId: `issue-132-resume-${cycle}`,
    idempotencyKey: `issue-132-resume-${cycle}`,
  });
}

describe("issue #132 periodic IDLE trigger composition", () => {
  test("without a server notification, one current-scope elapsed enters sweep cleanup", async () => {
    const clock = new VirtualClock();
    const server = new ControlledIdleServer();
    const abortProbe = new AbortListenerProbe();
    const authority = createCleanupAuthority();
    const composed = makeActor(clock, server, abortProbe, authority);

    composed.actor.start();
    composed.actor.send({ type: "control.start.requested", commandId: "issue-132-start" });
    await waitForSnapshot(composed.actor, (snapshot) => snapshot.matches({ watching: "idling" }));
    expect(server.notifications).toBe(0);
    expect(server.listenerCount).toBe(1);
    expect(composed.activeIdleListeners).toBe(1);
    expect(composed.activeIdleChildren).toBe(1);
    expect(clock.activeTimerCount).toBe(1);
    expect(abortProbe.activeAbortListeners).toBe(1);
    const currentScopeEpoch = composed.actor.getSnapshot().context.scopeEpoch;

    expect(clock.tick()).toBe(1);
    await waitForSnapshot(composed.actor, (snapshot) =>
      snapshot.matches({ watching: "closingForSweep" }),
    );
    expect(composed.timerTicks).toBe(1);
    expect(composed.actor.getSnapshot().context.scopeEpoch).toBe(currentScopeEpoch);
    expect(authority.currentPhase()?.effectiveScope).toBe("watch");
    expect(clock.activeTimerCount).toBe(0);
    expect(abortProbe.activeAbortListeners).toBe(0);
    expect(server.listenerCount).toBe(0);
    expect(composed.activeIdleListeners).toBe(0);
    expect(composed.activeIdleChildren).toBe(0);
    expect(Object.keys(composed.actor.getSnapshot().children)).toEqual(["cleanupBarrier"]);
    expect(composed.actor.getSnapshot().children.recurringSweep).toBeUndefined();
    expect(clock.tick()).toBe(0);
    expect(composed.timerTicks).toBe(1);
    composed.actor.stop();
  });

  test("leaving idling disposes both watch actors before the next state", async () => {
    const clock = new VirtualClock();
    const server = new ControlledIdleServer();
    const abortProbe = new AbortListenerProbe();
    const authority = createCleanupAuthority();
    const composed = makeActor(clock, server, abortProbe, authority);

    composed.actor.start();
    composed.actor.send({ type: "control.start.requested", commandId: "issue-132-pause-start" });
    await waitForSnapshot(composed.actor, (snapshot) => snapshot.matches({ watching: "idling" }));
    sendPause(composed.actor, 0);
    await waitForSnapshot(composed.actor, (snapshot) =>
      snapshot.matches({ watching: "closingForPause" }),
    );
    expect(clock.activeTimerCount).toBe(0);
    expect(abortProbe.activeAbortListeners).toBe(0);
    expect(server.listenerCount).toBe(0);
    expect(composed.activeIdleListeners).toBe(0);
    expect(composed.activeIdleChildren).toBe(0);
    expect(Object.keys(composed.actor.getSnapshot().children)).toEqual(["cleanupBarrier"]);
    authority.completeCurrentPhase();
    await waitForSnapshot(composed.actor, (snapshot) => snapshot.matches("paused"));
    expect(composed.actor.getSnapshot().children).toEqual({});
    composed.actor.stop();
  });

  test("keeps one-or-zero timer, listener, and child across repeated pause/resume cycles", async () => {
    const clock = new VirtualClock();
    const server = new ControlledIdleServer();
    const abortProbe = new AbortListenerProbe();
    const authority = createCleanupAuthority();
    const composed = makeActor(clock, server, abortProbe, authority);

    composed.actor.start();
    composed.actor.send({ type: "control.start.requested", commandId: "issue-132-cycle-start" });
    await waitForSnapshot(composed.actor, (snapshot) => snapshot.matches({ watching: "idling" }));

    for (let cycle = 0; cycle < 8; cycle += 1) {
      expect(clock.activeTimerCount).toBe(1);
      expect(abortProbe.activeAbortListeners).toBe(1);
      expect(server.listenerCount).toBe(1);
      expect(composed.activeIdleListeners).toBe(1);
      expect(composed.activeIdleChildren).toBe(1);
      expect(Object.keys(composed.actor.getSnapshot().children).sort()).toEqual([
        "idleSession",
        "periodicStatusTimer",
      ]);

      sendPause(composed.actor, cycle);
      await waitForSnapshot(composed.actor, (snapshot) =>
        snapshot.matches({ watching: "closingForPause" }),
      );
      expect(clock.activeTimerCount).toBe(0);
      expect(abortProbe.activeAbortListeners).toBe(0);
      expect(server.listenerCount).toBe(0);
      expect(composed.activeIdleListeners).toBe(0);
      expect(composed.activeIdleChildren).toBe(0);
      expect(Object.keys(composed.actor.getSnapshot().children)).toEqual(["cleanupBarrier"]);
      authority.completeCurrentPhase();
      await waitForSnapshot(composed.actor, (snapshot) => snapshot.matches("paused"));
      expect(composed.actor.getSnapshot().children).toEqual({});

      sendResume(composed.actor, cycle);
      await waitForSnapshot(composed.actor, (snapshot) => snapshot.matches("starting.active"));
      await waitForSnapshot(composed.actor, (snapshot) => snapshot.matches({ watching: "idling" }));
    }

    expect(clock.activeTimerCount).toBe(1);
    expect(abortProbe.activeAbortListeners).toBe(1);
    expect(server.listenerCount).toBe(1);
    expect(composed.activeIdleListeners).toBe(1);
    expect(composed.activeIdleChildren).toBe(1);
    composed.actor.stop();
    expect(clock.activeTimerCount).toBe(0);
    expect(abortProbe.activeAbortListeners).toBe(0);
    expect(server.listenerCount).toBe(0);
    expect(composed.activeIdleListeners).toBe(0);
    expect(composed.activeIdleChildren).toBe(0);
  });

  test("accepts exactly 900,000 ms and rejects invalid interval configuration at the statechart boundary", async () => {
    const clock = new VirtualClock();
    const server = new ControlledIdleServer();
    const abortProbe = new AbortListenerProbe();
    const authority = createCleanupAuthority();
    const composed = makeActor(clock, server, abortProbe, authority, 900_000);

    composed.actor.start();
    composed.actor.send({ type: "control.start.requested", commandId: "issue-132-max" });
    await waitForSnapshot(composed.actor, (snapshot) => snapshot.matches({ watching: "idling" }));
    expect(clock.scheduledDelays).toEqual([900_000]);
    composed.actor.stop();

    expect(() =>
      makeActor(
        new VirtualClock(),
        new ControlledIdleServer(),
        new AbortListenerProbe(),
        createCleanupAuthority(),
        900_001,
      ),
    ).toThrow();
    expect(() =>
      makeActor(
        new VirtualClock(),
        new ControlledIdleServer(),
        new AbortListenerProbe(),
        createCleanupAuthority(),
        0,
      ),
    ).toThrow();
  });
});
