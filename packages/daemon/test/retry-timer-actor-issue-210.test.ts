import { assign, createActor, fromPromise, setup } from "xstate";
import { describe, expect, test } from "bun:test";
import {
  createRetryTimerActorLogic,
  type RetryTimerDependencies,
  type RetryTimerClock,
  type RetryTimerHandle,
  type RetryTimerEvent,
} from "../src/retry-timer-actor";
import {
  calculateRetryDelay,
  type RetryDelayPolicyInput,
} from "../src/retry-delay-policy";
import {
  createSyncLifecycleActor,
  createSyncResourceRegistry,
  type RetryTimerActorInput,
  type SyncLifecycleDependencies,
  type SyncActorInputs,
  type WorkflowFault,
} from "../src/sync-statechart";

type VirtualTimer = Readonly<{ callback: () => void; delayMs: number; handle: RetryTimerHandle }>;

class VirtualClock implements RetryTimerClock {
  private nextHandle = 1;
  private readonly timers = new Map<RetryTimerHandle, VirtualTimer>();
  readonly clearCalls: RetryTimerHandle[] = [];

  get activeTimerCount(): number {
    return this.timers.size;
  }

  get delays(): readonly number[] {
    return [...this.timers.values()].map((timer) => timer.delayMs);
  }

  setTimeout(callback: () => void, delayMs: number): RetryTimerHandle {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { callback, delayMs, handle });
    return handle;
  }

  clearTimeout(handle: RetryTimerHandle): void {
    this.clearCalls.push(handle);
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

const checkpoint = {
  completedMailboxes: 0,
  totalMailboxes: 0,
  completedMessages: 0,
  pendingMessages: 0,
  lastMailbox: null,
  lastUid: null,
} as const;

const configuration = {
  retryBaseMs: 10,
  retryCapMs: 80,
  retryJitterRatio: 0,
  maxRetryAttempts: 3,
  periodicStatusIntervalMs: 10,
  controlDeadlineMs: 10,
  controlResultRetentionMs: 10,
  maxControlIdempotencyEntries: 8,
  maxReleaseSlotEntries: 8,
} as const;

function input(clock: RetryTimerClock, registry = createSyncResourceRegistry({ incarnationId: "retry:test", maxReleaseSlotEntries: 8 })): RetryTimerActorInput {
  return {
    configuration,
    scopeEpoch: 4,
    credentialRevision: 0,
    cleanupEpoch: 0,
    cleanupPhase: 0,
    invokeLease: 0,
    effectiveScope: null,
    minimumScope: null,
    phaseTerminal: null,
    frozenReleaseSetId: null,
    resourceRegistry: registry,
    retryAttempt: 2,
    retryBaseMs: 10,
    retryCapMs: 80,
    retryJitterRatio: 0,
    injectedRandomSource: () => 0.5,
    injectedClock: clock,
  };
}

function hostMachine(dependencies: RetryTimerDependencies = {}) {
  type HostContext = { readonly input: RetryTimerActorInput; readonly fault: WorkflowFault | null };
  return setup({
    types: {
      context: {} as HostContext,
      input: {} as RetryTimerActorInput,
      events: {} as RetryTimerEvent,
    },
    actors: { retryTimer: createRetryTimerActorLogic(dependencies) },
  }).createMachine({
    id: "retry-host",
    initial: "waiting",
    context: ({ input }) => ({ input, fault: null }),
    states: {
      waiting: {
        invoke: { src: "retryTimer", input: ({ context }) => context.input },
        on: {
          "retryTimer.elapsed": "elapsed",
          "retryTimer.failed": {
            target: "failed",
            actions: assign({ fault: ({ event }) => event.fault }),
          },
        },
      },
      elapsed: {},
      failed: {},
    },
  });
}

function retryLifecycleFixture(clock: RetryTimerClock) {
  let bootstrapCalls = 0;
  const registry = createSyncResourceRegistry({
    incarnationId: "retry:lifecycle",
    maxReleaseSlotEntries: 8,
  });
  const bootstrapSession = fromPromise(async () => {
    bootstrapCalls += 1;
    if (bootstrapCalls === 1) return { next: "backfill" as const, checkpoint };
    return new Promise<never>(() => undefined);
  });
  const initialBackfill = fromPromise<never, SyncActorInputs>(async () => {
    throw { category: "transient", code: "sync.test-transient", safeMessage: "transient" };
  });
  const actor = createSyncLifecycleActor(
    {
      configuration,
      initialCheckpoint: checkpoint,
      initialCredentialRevision: 0,
      incarnationId: "retry:lifecycle",
      retryTimerClock: clock,
      retryRandomSource: () => 0.5,
    },
    { bootstrapSession, initialBackfill },
    { resourceRegistry: registry } satisfies SyncLifecycleDependencies,
  );
  return { actor, registry, bootstrapCalls: () => bootstrapCalls };
}

async function startRetryLifecycle(clock: RetryTimerClock) {
  const fixture = retryLifecycleFixture(clock);
  fixture.actor.start();
  fixture.actor.send({ type: "control.start.requested", commandId: "retry-lifecycle" });
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(fixture.actor.getSnapshot().matches({ retryWaiting: "active" })).toBe(true);
  return fixture;
}

describe("signed retryTimer actor issue #210", () => {
  test("uses only the signed delay policy and settles both release slots before elapsed", async () => {
    const clock = new VirtualClock();
    const registry = createSyncResourceRegistry({ incarnationId: "retry:delay", maxReleaseSlotEntries: 8 });
    const actor = createActor(hostMachine(), { input: input(clock, registry) });
    actor.start();

    const expected = calculateRetryDelay({
      retryAttempt: 2,
      retryBaseMs: 10,
      retryCapMs: 80,
      retryJitterRatio: 0,
      random: () => 0.5,
    } satisfies RetryDelayPolicyInput);
    expect(clock.delays).toEqual([expected]);
    expect(registry.snapshot?.().slotEntryCount).toBe(2);

    clock.tick();
    await Bun.sleep(0);
    expect(actor.getSnapshot().value).toBe("elapsed");
    expect(clock.clearCalls).toHaveLength(1);
    expect(registry.snapshot?.().slotEntryCount).toBe(0);
    actor.stop();
  });

  test("cancels timer, listener, and release slots without an event on disposal", async () => {
    const clock = new VirtualClock();
    const registry = createSyncResourceRegistry({ incarnationId: "retry:dispose", maxReleaseSlotEntries: 8 });
    const actor = createActor(hostMachine(), { input: input(clock, registry) });
    actor.start();
    actor.stop();
    clock.tick();
    await Bun.sleep(0);

    expect(clock.activeTimerCount).toBe(0);
    expect(clock.clearCalls).toHaveLength(1);
    expect(registry.snapshot?.().slotEntryCount).toBe(0);
  });

  test("maps release-slot registration failure to one invariant scoped failure", async () => {
    const registry = createSyncResourceRegistry({ incarnationId: "retry:registration-failure", maxReleaseSlotEntries: 1 });
    const clock = new VirtualClock();
    const actor = createActor(hostMachine(), { input: input(clock, registry) });
    actor.start();
    await Bun.sleep(0);
    expect(actor.getSnapshot().value).toBe("failed");
    expect(clock.activeTimerCount).toBe(0);
    expect(registry.snapshot?.().slotEntryCount).toBe(0);
    actor.stop();
  });

  test("maps clock and policy callback failures to one invariant scoped failure", async () => {
    const registry = createSyncResourceRegistry({ incarnationId: "retry:clock-failure", maxReleaseSlotEntries: 8 });
    const clock: RetryTimerClock = {
      setTimeout: () => {
        throw new Error("clock failure");
      },
      clearTimeout: () => undefined,
    };
    const actor = createActor(hostMachine(), { input: input(clock, registry) });
    actor.start();
    await Bun.sleep(0);
    expect(actor.getSnapshot().value).toBe("failed");
    expect(registry.snapshot?.().slotEntryCount).toBe(0);
    actor.stop();

    const randomRegistry = createSyncResourceRegistry({ incarnationId: "retry:random-failure", maxReleaseSlotEntries: 8 });
    const randomActor = createActor(hostMachine(), {
      input: { ...input(new VirtualClock(), randomRegistry), injectedRandomSource: () => { throw new Error("random failure"); } },
    });
    randomActor.start();
    await Bun.sleep(0);
    expect(randomActor.getSnapshot().value).toBe("failed");
    expect(randomRegistry.snapshot?.().slotEntryCount).toBe(0);
    randomActor.stop();
  });

  test("normalizes non-invariant, extra, and unbounded injected faults", async () => {
    const clock: RetryTimerClock = {
      setTimeout: () => {
        throw new Error("clock failure");
      },
      clearTimeout: () => undefined,
    };
    const actor = createActor(
      hostMachine({
        faultFromError: () => ({
          category: "transient",
          code: "provider-secret",
          safeMessage: "provider-secret",
          extra: "not admitted",
        }),
      }),
      {
        input: input(
          clock,
          createSyncResourceRegistry({ incarnationId: "retry:fault-boundary", maxReleaseSlotEntries: 8 }),
        ),
      },
    );
    actor.start();
    await Bun.sleep(0);
    expect(actor.getSnapshot().context.fault).toEqual({
      category: "invariant",
      code: "sync.retry-timer",
      safeMessage: "Retry timer failed.",
    });
    actor.stop();
  });

  test("composed virtual lifecycle schedules exact current-attempt delay and bootstraps once", async () => {
    const clock = new VirtualClock();
    const fixture = await startRetryLifecycle(clock);

    expect(fixture.actor.getSnapshot().context.retryAttempt).toBe(1);
    expect(clock.delays).toEqual([
      calculateRetryDelay({
        retryAttempt: 1,
        retryBaseMs: configuration.retryBaseMs,
        retryCapMs: configuration.retryCapMs,
        retryJitterRatio: configuration.retryJitterRatio,
        random: () => 0.5,
      }),
    ]);
    expect(fixture.bootstrapCalls()).toBe(1);

    clock.tick();
    await Bun.sleep(0);
    expect(fixture.actor.getSnapshot().matches({ starting: "active" })).toBe(true);
    expect(fixture.bootstrapCalls()).toBe(2);
    expect(fixture.registry.snapshot?.().slotEntryCount).toBe(0);
    fixture.actor.stop();
  });

  test("stale elapsed is ignored and current retry remains owned", async () => {
    const clock = new VirtualClock();
    const fixture = await startRetryLifecycle(clock);
    const scopeEpoch = fixture.actor.getSnapshot().context.scopeEpoch;

    fixture.actor.send({ type: "retryTimer.elapsed", scopeEpoch: scopeEpoch + 1 });
    expect(fixture.actor.getSnapshot().matches({ retryWaiting: "active" })).toBe(true);
    expect(fixture.bootstrapCalls()).toBe(1);
    expect(clock.activeTimerCount).toBe(1);
    fixture.actor.stop();
  });

  test("pause, stop, shutdown, and auth-change paths cancel without retry start or ownership leaks", async () => {
    for (const operation of ["pause", "stop", "shutdown", "auth-change"] as const) {
      const clock = new VirtualClock();
      const fixture = await startRetryLifecycle(clock);
      if (operation === "auth-change") {
        fixture.actor.send({ type: "credentials.changed", revision: 1 });
        expect(fixture.actor.getSnapshot().matches({ retryWaiting: "active" })).toBe(true);
        expect(clock.activeTimerCount).toBe(1);
        fixture.actor.send({
          type: "control.pause.requested",
          commandId: "retry-auth-pause",
          idempotencyKey: "retry-auth-pause",
        });
      } else if (operation === "pause") {
        fixture.actor.send({
          type: "control.pause.requested",
          commandId: "retry-pause",
          idempotencyKey: "retry-pause",
        });
      } else if (operation === "stop") {
        fixture.actor.send({
          type: "control.stop.requested",
          commandId: "retry-stop",
          idempotencyKey: "retry-stop",
        });
      } else {
        fixture.actor.send({
          type: "process.shutdown.requested",
          requestId: "retry-shutdown",
          signal: "TERM",
        });
      }
      await Bun.sleep(0);
      await Bun.sleep(0);
      clock.tick();
      await Bun.sleep(0);
      expect(fixture.bootstrapCalls()).toBe(1);
      expect(clock.activeTimerCount).toBe(0);
      expect(clock.clearCalls).toHaveLength(1);
      expect(fixture.registry.snapshot?.().slotEntryCount).toBe(0);
      expect(fixture.registry.snapshot?.().cleanupSessionOpen).toBe(false);
      fixture.actor.stop();
    }
  });
});
