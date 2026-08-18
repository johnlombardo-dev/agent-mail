import { describe, expect, test } from "bun:test";
import {
  createSyncControlDecisionChannel,
  createSyncControlService,
  type SyncControlActor,
  type SyncControlDecision,
  type SyncControlClock,
} from "../src/sync-control-service";
import {
  createSyncLifecycleDependencies,
  createSyncLifecycleActor,
  type SyncLifecycleEvent,
  type SyncLifecycleSnapshotView,
} from "../src/sync-statechart";

const checkpoint = {
  completedMailboxes: 0,
  totalMailboxes: 0,
  completedMessages: 0,
  pendingMessages: 0,
  lastMailbox: null,
  lastUid: null,
} as const;

function view(state: string, version: number, incarnationId = "incarnation:test"): SyncLifecycleSnapshotView {
  return {
    value: state,
    context: {
      incarnationId,
      version,
      scopeEpoch: 0,
      idleReadyEpoch: null,
      retryAttempt: 0,
      checkpoint,
      authBlockedDetail:
        state === "authBlocked"
          ? { reason: "provider-rejected" as const, detail: "Credentials were rejected." }
          : null,
      diagnostics: [],
      latestCredentialRevision: 0,
      activeCredentialRevision: null,
      authFaultCredentialRevision: null,
      cleanupEpoch: 0,
      cleanupPhase: 0,
      cleanupInvokeLease: 0,
      effectiveCleanupScope: null,
    },
  };
}

function clockFixture(): SyncControlClock & { readonly fire: () => void; readonly advance: (ms: number) => void } {
  let now = 0;
  type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
  const timers = new Map<TimerHandle, { readonly at: number; readonly callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const handle = globalThis.setTimeout(() => undefined, 2_147_483_647);
      globalThis.clearTimeout(handle);
      timers.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
    fire: () => {
      const pending = [...timers.entries()].sort(([, left], [, right]) => left.at - right.at)[0];
      if (pending === undefined) throw new Error("no pending timer");
      timers.delete(pending[0]);
      pending[1].callback();
    },
    advance: (ms) => {
      now += ms;
      for (const [handle, timer] of [...timers.entries()]) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
  };
}

function actorFixture(initial: SyncLifecycleSnapshotView, onSend: (event: SyncLifecycleEvent) => void) {
  let current = initial;
  let sendCount = 0;
  const listeners = new Set<(snapshot: SyncLifecycleSnapshotView) => void>();
  const actor: SyncControlActor = {
    getSnapshot: () => current,
    send: (event) => {
      sendCount += 1;
      onSend(event);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
  };
  return {
    actor,
    get sendCount() {
      return sendCount;
    },
    set: (next: SyncLifecycleSnapshotView, notify = true) => {
      current = next;
      if (notify) for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

function accepted(
  commandId: string,
  command: "pause" | "resume" | "stop",
  observed: SyncLifecycleSnapshotView,
  actorStates: readonly ["stopped" | "starting" | "backfilling" | "watching" | "sweeping" | "retrying" | "authBlocked" | "paused" | "stopping"],
  completed: boolean,
): SyncControlDecision {
  const context = observed.context;
  const actorState = command === "stop" && context.version > 0 ? "stopping" : "watching";
  return {
    kind: "accepted",
    commandId,
    target: { command, actorStates, completed },
    observed: {
      actorState,
      incarnationId: context.incarnationId,
      version: context.version,
    },
  };
}

function serviceFixture(
  initial: SyncLifecycleSnapshotView,
  onSend: (event: SyncLifecycleEvent, fixture: ReturnType<typeof actorFixture>) => void,
  options: Partial<{ deadlineMs: number; retentionMs: number; capacity: number }> = {},
) {
  let fixture: ReturnType<typeof actorFixture>;
  fixture = actorFixture(initial, (event) => onSend(event, fixture));
  const decisions = createSyncControlDecisionChannel();
  let decisionListenerCount = 0;
  const decisionSource = {
    subscribe: (listener: (decision: SyncControlDecision) => void) => {
      decisionListenerCount += 1;
      const subscription = decisions.source.subscribe(listener);
      return {
        unsubscribe: () => {
          decisionListenerCount -= 1;
          subscription.unsubscribe();
        },
      };
    },
  };
  const clock = clockFixture();
  const service = createSyncControlService({
    actor: fixture.actor,
    decisions: decisionSource,
    controlDeadlineMs: options.deadlineMs ?? 10,
    controlResultRetentionMs: options.retentionMs ?? 100,
    maxControlIdempotencyEntries: options.capacity ?? 8,
    clock,
  });
  return { decisions, clock, fixture, service, decisionListenerCount: () => decisionListenerCount };
}

describe("P3-C22 observed sync control", () => {
  test("observes a real statechart actor for a synchronous stop no-op", async () => {
    const input = {
      configuration: {
        retryBaseMs: 1,
        retryCapMs: 1,
        retryJitterRatio: 0,
        maxRetryAttempts: 1,
        periodicStatusIntervalMs: 1,
        controlDeadlineMs: 10,
        controlResultRetentionMs: 100,
        maxControlIdempotencyEntries: 8,
        maxReleaseSlotEntries: 8,
      },
      initialCheckpoint: checkpoint,
      initialCredentialRevision: 0,
      incarnationId: "incarnation:real-actor",
    } as const;
    const decisions = createSyncControlDecisionChannel();
    const observedDecisions: SyncControlDecision[] = [];
    const removeDecisionProbe = decisions.source.subscribe((decision) => observedDecisions.push(decision));
    const dependencies = createSyncLifecycleDependencies(input);
    const actor = createSyncLifecycleActor(input, {}, {
      ...dependencies,
      controlDecisionSink: decisions.publish,
    });
    actor.start();
    const actualClock = clockFixture();
    const service = createSyncControlService({
      actor: {
        getSnapshot: () => actor.getSnapshot(),
        subscribe: (listener) => actor.subscribe(listener),
        send: (event) => actor.send(event),
      },
      decisions: decisions.source,
      controlDeadlineMs: 10,
      controlResultRetentionMs: 100,
      maxControlIdempotencyEntries: 8,
      clock: actualClock,
    });

    const result = await service.execute({
      command: "stop",
      commandId: "stop:real",
      correlationId: "corr:real",
      idempotencyKey: "stop:real",
    });
    expect(result).toMatchObject({ accepted: true, completed: true, observed: { actorState: "stopped", version: 0 } });
    const rejected = await service.execute({
      command: "start",
      commandId: "start:stale",
      correlationId: "corr:stale",
      expectedVersion: 99,
    });
    expect(rejected).toMatchObject({
      code: "sync.control-rejected",
      details: { actorState: "stopped", version: 0, reason: "stale-version" },
    });
    const start = await service.execute({
      command: "start",
      commandId: "start:pending",
      correlationId: "corr:pending-start",
    });
    expect(start).toMatchObject({ accepted: true, observed: { actorState: "starting", version: 1 } });
    const pause = service.execute({
      command: "pause",
      commandId: "pause:pending",
      correlationId: "corr:pending-pause",
      idempotencyKey: "pause:pending",
    });
    actualClock.advance(10);
    const pauseResult = await pause;
    expect(observedDecisions.some((decision) => decision.commandId === "pause:pending" && decision.kind === "accepted")).toBe(true);
    expect(pauseResult).toMatchObject({ code: "sync.control-timeout" });
    removeDecisionProbe.unsubscribe();
    service.close();
    actor.stop();
  });

  test("registers both observers before send and joins decision/snapshot in either order", async () => {
    let decisionFirst = true;
    let registrationsAtSend = 0;
    const initial = view("watching.idling", 1);
    const fixture = serviceFixture(initial, (event, harness) => {
      if (!("commandId" in event)) throw new Error("control service sent a non-control event");
      registrationsAtSend = harness.listenerCount() + fixture.decisionListenerCount();
      const next = view("stopping.forStop", 2);
      const decision = accepted(event.commandId, "stop", next, ["stopped"], true);
      // The decision may arrive before or after the snapshot callback.  The
      // service must not require one fixed event order.
      if (decisionFirst) harness.set(next);
      fixture.decisions.publish(decision);
      if (!decisionFirst) harness.set(next);
      harness.set(view("stopped.clean", 3));
    });

    const first = await fixture.service.execute({
      command: "stop",
      commandId: "stop:first",
      correlationId: "corr:first",
      idempotencyKey: "stop:first",
    });
    expect(first).toMatchObject({ accepted: true, completed: true, observed: { actorState: "stopped", version: 3 } });
    expect(registrationsAtSend).toBe(2);
    expect(fixture.fixture.sendCount).toBe(1);
    expect(fixture.fixture.listenerCount()).toBe(0);
    expect(fixture.decisionListenerCount()).toBe(0);

    decisionFirst = false;
    const second = await fixture.service.execute({
      command: "stop",
      commandId: "stop:second",
      correlationId: "corr:second",
      idempotencyKey: "stop:second",
    });
    expect(second).toMatchObject({ accepted: true, completed: true, observed: { actorState: "stopped", version: 3 } });
    expect(fixture.fixture.sendCount).toBe(2);
  });

  test("does not fabricate stop completion while cleanup is closing, and caches timeout across convergence", async () => {
    const fixture = serviceFixture(view("watching.idling", 1), (event, harness) => {
      if (!("commandId" in event)) throw new Error("control service sent a non-control event");
      const closing = view("watching.closingForPause", 2);
      harness.set(closing);
      fixture.decisions.publish(accepted(event.commandId, "pause", closing, ["paused"], true));
    }, { deadlineMs: 10, retentionMs: 100 });

    const pending = fixture.service.execute({
      command: "pause",
      commandId: "pause:delayed",
      correlationId: "corr:delayed",
      idempotencyKey: "pause:delayed",
    });
    fixture.clock.advance(10);
    const timeout = await pending;
    expect(timeout).toMatchObject({
      code: "sync.control-timeout",
      details: { actorState: "watching", version: 2, reason: "deadline-elapsed" },
    });

    fixture.fixture.set(view("paused", 3));
    const replay = await fixture.service.execute({
      command: "pause",
      commandId: "pause:replay",
      correlationId: "corr:replay",
      idempotencyKey: "pause:delayed",
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(timeout));
    expect(fixture.fixture.sendCount).toBe(1);
    expect(fixture.fixture.listenerCount()).toBe(0);
    expect(fixture.decisionListenerCount()).toBe(0);
  });

  test("returns exact conflict/capacity responses without installing a waiter", async () => {
    const fixture = serviceFixture(view("watching.idling", 1), () => undefined, { capacity: 1 });
    const first = fixture.service.execute({
      command: "stop",
      commandId: "stop:one",
      correlationId: "corr:one",
      idempotencyKey: "same-key",
    });
    const conflict = await fixture.service.execute({
      command: "pause",
      commandId: "pause:conflict",
      correlationId: "corr:conflict",
      idempotencyKey: "same-key",
    });
    expect(conflict).toMatchObject({ code: "sync.control-idempotency-conflict" });
    expect(fixture.fixture.sendCount).toBe(1);
    const capacity = await fixture.service.execute({
      command: "pause",
      commandId: "pause:capacity",
      correlationId: "corr:capacity",
      idempotencyKey: "other-key",
    });
    expect(capacity).toMatchObject({ code: "sync.control-capacity" });
    fixture.clock.fire();
    await first;
    expect(fixture.fixture.listenerCount()).toBe(0);
  });

  test("ignores a delayed decision from a retired incarnation", async () => {
    const fixture = serviceFixture(view("watching.idling", 1, "incarnation:old"), () => undefined, {
      deadlineMs: 10,
    });
    const oldWaiter = fixture.service.execute({
      command: "stop",
      commandId: "stop:old",
      correlationId: "corr:old",
      idempotencyKey: "stop:old",
    });
    fixture.fixture.set(view("watching.idling", 1, "incarnation:new"));
    await expect(oldWaiter).resolves.toMatchObject({
      code: "sync.control-cancelled",
      details: { reason: "superseded-by-restart", incarnationId: "incarnation:new" },
    });

    const newWaiter = fixture.service.execute({
      command: "pause",
      commandId: "pause:new",
      correlationId: "corr:new",
      idempotencyKey: "pause:new",
    });
    fixture.decisions.publish({
      kind: "accepted",
      commandId: "pause:new",
      target: { command: "pause", actorStates: ["paused"], completed: true },
      observed: { actorState: "watching", incarnationId: "incarnation:old", version: 2 },
    });
    fixture.clock.advance(10);
    await expect(newWaiter).resolves.toMatchObject({
      code: "sync.control-timeout",
      details: { incarnationId: "incarnation:new" },
    });
  });

  test("settles pending controls from truthful workflow failure and supersession states", async () => {
    const cases = [
      ["authBlocked", "sync.control-failed", "auth-blocked"],
      ["stopped.failed", "sync.control-failed", "terminal-failure"],
      ["stopping.afterFailure", "sync.control-failed", "terminal-failure"],
      ["stopping.forStop", "sync.control-cancelled", "superseded-by-stop"],
      ["stopping.forRestart", "sync.control-cancelled", "superseded-by-restart"],
      ["stopping.forShutdown", "sync.control-cancelled", "superseded-by-shutdown"],
      ["stopped.shutdown", "sync.control-cancelled", "superseded-by-shutdown"],
    ] as const;
    for (const [state, code, reason] of cases) {
      const fixture = serviceFixture(view("watching.idling", 1), () => undefined);
      const pending = fixture.service.execute({
        command: "pause",
        commandId: `pause:${state}`,
        correlationId: `corr:${state}`,
        idempotencyKey: `pause:${state}`,
      });
      fixture.fixture.set(view(state, 2));
      await expect(pending).resolves.toMatchObject({ code, details: { reason } });
      expect(fixture.clock.advance(100)).toBeUndefined();
      expect(fixture.fixture.listenerCount()).toBe(0);
      expect(fixture.decisionListenerCount()).toBe(0);
    }
  });

  test("cancels a pending waiter when an incompatible same-incarnation command wins", async () => {
    const fixture = serviceFixture(view("watching.idling", 1), () => undefined);
    const pending = fixture.service.execute({
      command: "pause",
      commandId: "pause:incompatible",
      correlationId: "corr:incompatible",
      idempotencyKey: "pause:incompatible",
    });
    fixture.decisions.publish({
      kind: "accepted",
      commandId: "stop:winner",
      target: { command: "stop", actorStates: ["stopped"], completed: true },
      observed: { actorState: "watching", incarnationId: "incarnation:test", version: 1 },
    });
    await expect(pending).resolves.toMatchObject({
      code: "sync.control-cancelled",
      details: { reason: "superseded-by-stop", version: 1 },
    });
    expect(fixture.fixture.listenerCount()).toBe(0);
    expect(fixture.decisionListenerCount()).toBe(0);
  });
});
