import { afterAll, describe, expect, test } from "bun:test";
import { createActor, fromCallback, fromPromise } from "xstate";
import {
  createPollingTimerActor,
  createPollingTimerActorLogic,
  type PollingTimerClock,
  type PollingTimerHandle,
  type PollingTimerInput,
} from "../src/polling-timer-actor";
import {
  createSyncLifecycleActor,
  createSyncResourceRegistry,
  type SyncCleanupPhaseRequest,
  type SyncCleanupPhaseTerminal,
  type SyncLifecycleDependencies,
} from "../src/sync-statechart";
import { composeSourceToken, emitSourceTokenEvent } from "../../../scripts/capacity/source-token-event";

afterAll(async () => {
  await emitSourceTokenEvent({
    assertionId: "polling-timer-cleanup",
    sourcePath: "packages/daemon/test/polling-timer-actor-p3-c20.test.ts",
    token: composeSourceToken(["registers", "the", "timer/listener", "release"]),
    expected: 1,
  });
});

type VirtualTimer = Readonly<{
  readonly callback: () => void;
  readonly handle: PollingTimerHandle;
}>;

class VirtualClock implements PollingTimerClock {
  private nextHandle = 1;
  private readonly timers = new Map<PollingTimerHandle, VirtualTimer>();
  clearCalls = 0;

  get activeTimerCount(): number {
    return this.timers.size;
  }

  setTimeout(callback: () => void, _delayMs: number): PollingTimerHandle {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { callback, handle });
    return handle;
  }

  clearTimeout(handle: PollingTimerHandle): void {
    this.clearCalls += 1;
    this.timers.delete(handle);
  }

  tick(): void {
    const pending = [...this.timers.values()];
    for (const timer of pending) {
      this.timers.delete(timer.handle);
      timer.callback();
    }
  }
}

type ListenerProbe = Readonly<{
  readonly controller: AbortController;
  readonly activeAbortListeners: () => number;
  readonly addCalls: () => number;
  readonly removeCalls: () => number;
}>;

function trackedAbortController(): ListenerProbe {
  const controller = new AbortController();
  const signal = controller.signal;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let addCalls = 0;
  let removeCalls = 0;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);

  const addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void => {
    if (type === "abort") {
      addCalls += 1;
      listeners.add(listener);
    }
    originalAdd(type, listener, options);
  };
  const removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void => {
    if (type === "abort") {
      removeCalls += 1;
      listeners.delete(listener);
    }
    originalRemove(type, listener, options);
  };
  signal.addEventListener = addEventListener;
  signal.removeEventListener = removeEventListener;

  return {
    controller,
    activeAbortListeners: () => listeners.size,
    addCalls: () => addCalls,
    removeCalls: () => removeCalls,
  };
}

const resourceRegistry = (): SyncLifecycleDependencies["resourceRegistry"] => ({
  currentPhase: null,
  requestPhase: (_request: SyncCleanupPhaseRequest) => {
    throw new Error("timer tests do not open cleanup phases");
  },
  awaitPhase: async (_epoch: number, _phase: number): Promise<SyncCleanupPhaseTerminal> => ({
    status: "pending",
  }),
});

const inputs = (): PollingTimerInput => ({
  scopeEpoch: 1,
  periodicStatusIntervalMs: 10,
  resourceRegistry: resourceRegistry(),
});

const activeResources = (clock: VirtualClock, probe: ListenerProbe) => ({
  timers: clock.activeTimerCount,
  abortListeners: probe.activeAbortListeners(),
});

describe("polling timer actor P3-C20", () => {
  test("registers the timer/listener release before scheduling and retires it on disposal", async () => {
    const clock = new VirtualClock();
    const probe = trackedAbortController();
    const registry = createSyncResourceRegistry({ incarnationId: "polling:registry", maxReleaseSlotEntries: 8 });
    const actor = createPollingTimerActor(
      { ...inputs(), resourceRegistry: registry },
      { clock, createAbortController: () => probe.controller },
    );
    actor.start();
    expect(registry.snapshot?.().slotEntryCount).toBe(1);
    actor.stop();
    await Bun.sleep(0);
    expect(registry.snapshot?.().slotEntryCount).toBe(0);
    expect(probe.activeAbortListeners()).toBe(0);
  });

  test("keeps listener and timer ownership bounded across thousands of cancellation cycles", () => {
    const clock = new VirtualClock();

    for (let cycle = 0; cycle < 2_000; cycle += 1) {
      const probe = trackedAbortController();
      const actor = createPollingTimerActor(inputs(), {
        clock,
        createAbortController: () => probe.controller,
      });
      actor.start();
      expect(activeResources(clock, probe)).toEqual({ timers: 1, abortListeners: 1 });
      actor.stop();
      expect(activeResources(clock, probe)).toEqual({ timers: 0, abortListeners: 0 });
      expect(probe.controller.signal.aborted).toBe(true);
    }

    expect(clock.activeTimerCount).toBe(0);
    expect(clock.clearCalls).toBe(2_000);
  });

  test("cleans up before a normal tick", () => {
    const clock = new VirtualClock();
    const probe = trackedAbortController();
    let ticks = 0;
    const actor = createPollingTimerActor(inputs(), {
      clock,
      createAbortController: () => probe.controller,
      onTick: () => (ticks += 1),
    });

    actor.start();
    clock.tick();

    expect(ticks).toBe(1);
    expect(activeResources(clock, probe)).toEqual({ timers: 0, abortListeners: 0 });
    expect(clock.clearCalls).toBe(1);
    expect(probe.removeCalls()).toBe(1);
    actor.stop();
    expect(probe.removeCalls()).toBe(1);
  });

  test("cleans up before an injected tick error", () => {
    const clock = new VirtualClock();
    const probe = trackedAbortController();
    let callbackRan = false;
    const actor = createPollingTimerActor(inputs(), {
      clock,
      createAbortController: () => probe.controller,
      onTick: () => {
        callbackRan = true;
        throw new Error("injected test failure");
      },
    });

    actor.start();
    clock.tick();

    expect(callbackRan).toBe(true);
    expect(activeResources(clock, probe)).toEqual({ timers: 0, abortListeners: 0 });
    expect(clock.clearCalls).toBe(1);
    actor.stop();
    expect(probe.removeCalls()).toBe(1);
  });

  test("cleans up when the injected clock rejects timer ownership", () => {
    const probe = trackedAbortController();
    let clearCalls = 0;
    const clock: PollingTimerClock = {
      setTimeout: () => {
        throw new Error("injected clock failure");
      },
      clearTimeout: () => {
        clearCalls += 1;
      },
    };
    const actor = createPollingTimerActor(inputs(), {
      clock,
      createAbortController: () => probe.controller,
    });

    actor.start();

    expect(probe.activeAbortListeners()).toBe(0);
    expect(probe.removeCalls()).toBe(1);
    expect(clearCalls).toBe(0);
    actor.stop();
    expect(probe.removeCalls()).toBe(1);
  });

  test("does not attach to an already-aborted owned controller", () => {
    const clock = new VirtualClock();
    const probe = trackedAbortController();
    probe.controller.abort();
    const actor = createPollingTimerActor(inputs(), {
      clock,
      createAbortController: () => probe.controller,
    });

    actor.start();

    expect(activeResources(clock, probe)).toEqual({ timers: 0, abortListeners: 0 });
    expect(probe.addCalls()).toBe(0);
    expect(clock.clearCalls).toBe(0);
    actor.stop();
  });

  test("wires elapsed through the signed watching.polling transition", async () => {
    const clock = new VirtualClock();
    const probe = trackedAbortController();
    const checkpoint = {
      completedMailboxes: 0,
      totalMailboxes: 0,
      completedMessages: 0,
      pendingMessages: 0,
      lastMailbox: null,
      lastUid: null,
    } as const;
    const lifecycle = createSyncLifecycleActor(
      {
        configuration: {
          retryBaseMs: 1,
          retryCapMs: 1,
          retryJitterRatio: 0,
          maxRetryAttempts: 1,
          periodicStatusIntervalMs: 10,
          controlDeadlineMs: 1,
          controlResultRetentionMs: 1,
          maxControlIdempotencyEntries: 1,
          maxReleaseSlotEntries: 8,
        },
        initialCheckpoint: checkpoint,
        initialCredentialRevision: 0,
        incarnationId: "incarnation:polling-elapsed",
      },
      {
        bootstrapSession: fromPromise(async () => ({ next: "poll" as const, checkpoint })),
        periodicStatusTimer: createPollingTimerActorLogic({
          clock,
          createAbortController: () => probe.controller,
        }),
      },
    );

    lifecycle.start();
    lifecycle.send({ type: "control.start.requested", commandId: "polling-elapsed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lifecycle.getSnapshot().matches({ watching: "polling" })).toBe(true);
    clock.tick();
    expect(lifecycle.getSnapshot().matches({ watching: "closingForSweep" })).toBe(true);
    expect(activeResources(clock, probe)).toEqual({ timers: 0, abortListeners: 0 });
    lifecycle.stop();
  });

  test("wires injected timer failure through the signed watching.closingForFailure transition", async () => {
    const clock = new VirtualClock();
    const probe = trackedAbortController();
    const checkpoint = {
      completedMailboxes: 0,
      totalMailboxes: 0,
      completedMessages: 0,
      pendingMessages: 0,
      lastMailbox: null,
      lastUid: null,
    } as const;
    const lifecycle = createSyncLifecycleActor(
      {
        configuration: {
          retryBaseMs: 1,
          retryCapMs: 1,
          retryJitterRatio: 0,
          maxRetryAttempts: 1,
          periodicStatusIntervalMs: 10,
          controlDeadlineMs: 1,
          controlResultRetentionMs: 1,
          maxControlIdempotencyEntries: 1,
          maxReleaseSlotEntries: 8,
        },
        initialCheckpoint: checkpoint,
        initialCredentialRevision: 0,
        incarnationId: "incarnation:polling-error",
      },
      {
        bootstrapSession: fromPromise(async () => ({ next: "poll" as const, checkpoint })),
        periodicStatusTimer: createPollingTimerActorLogic({
          clock,
          createAbortController: () => probe.controller,
          onTick: () => {
            throw new Error("injected timer failure");
          },
        }),
      },
    );

    lifecycle.start();
    lifecycle.send({ type: "control.start.requested", commandId: "polling-error" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lifecycle.getSnapshot().matches({ watching: "polling" })).toBe(true);
    clock.tick();
    expect(lifecycle.getSnapshot().matches({ watching: "closingForFailure" })).toBe(true);
    expect(activeResources(clock, probe)).toEqual({ timers: 0, abortListeners: 0 });
    lifecycle.stop();
  });

  test("rejects anonymous callback cleanup as the adjacent counterexample", () => {
    const clock = new VirtualClock();
    const probe = trackedAbortController();
    const brokenActor = fromCallback<
      { readonly type: "broken" },
      PollingTimerInput
    >(({ input }) => {
      const controller = probe.controller;
      const timer = clock.setTimeout(() => undefined, input.periodicStatusIntervalMs);
      controller.signal.addEventListener("abort", () => undefined);
      return () => {
        clock.clearTimeout(timer);
        controller.abort();
        controller.signal.removeEventListener("abort", () => undefined);
      };
    });
    const actor = createActor(brokenActor, { input: inputs() });

    actor.start();
    actor.stop();

    expect(activeResources(clock, probe)).toEqual({ timers: 0, abortListeners: 1 });
    expect(probe.removeCalls()).toBe(1);
  });
});
