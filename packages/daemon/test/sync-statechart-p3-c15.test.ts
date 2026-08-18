import { describe, expect, test } from "bun:test";
import { fromPromise } from "xstate";
import signedModel from "../../../docs/architecture/sync-statechart.model.json" with { type: "json" };
import {
  SIGNED_ATOMIC_STATES,
  SIGNED_EXTERNAL_EVENT_IDS,
  SIGNED_SYNC_STATECHART,
  SIGNED_TRANSITIONS,
  cleanupTerminalFaultSchema,
  cleanupCertificateSchema,
  createSyncExternalSendAdapter,
  createSyncLifecycleActor,
  parseExternalSyncEvent,
  projectSyncStatus,
  syncLifecycleMachine,
  syncStatechartInspection,
  type CleanupTerminalFault,
  type SyncCleanupPhaseSnapshot,
  type SyncActorInputs,
  type SyncLifecycleEvent,
  type SyncLifecycleDependencies,
} from "../src/sync-statechart";

const configuration = {
  retryBaseMs: 1,
  retryCapMs: 1,
  retryJitterRatio: 0,
  maxRetryAttempts: 1,
  periodicStatusIntervalMs: 1,
  controlDeadlineMs: 1,
  controlResultRetentionMs: 1,
  maxControlIdempotencyEntries: 1,
  maxReleaseSlotEntries: 8,
} as const;

const checkpoint = {
  completedMailboxes: 0,
  totalMailboxes: 0,
  completedMessages: 0,
  pendingMessages: 0,
  lastMailbox: null,
  lastUid: null,
} as const;

const input = {
  configuration,
  initialCheckpoint: checkpoint,
  initialCredentialRevision: 0,
  incarnationId: "incarnation:test",
};

const waitForActor = () => new Promise((resolve) => setTimeout(resolve, 10));
const expectJsonEqual = (actual: unknown, expected: unknown) =>
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));

const cleanupCertificate = (value: Pick<SyncActorInputs, "cleanupEpoch" | "cleanupPhase" | "invokeLease">) => ({
  certificateId: "certificate:test",
  cleanupEpoch: value.cleanupEpoch,
  cleanupPhase: value.cleanupPhase,
  invokeLease: value.invokeLease,
  effectiveScope: "workflow" as const,
  frozenReleaseSetId: "release-set:test",
  released: true as const,
  authoritativeAudit: {
    scope: "workflow" as const,
    frozenReleaseSetId: "release-set:test",
    liveResourceCount: 0 as const,
    unresolvedReleaseCount: 0 as const,
    digest: "digest:test",
  },
  diagnostics: [],
});

const cleanupDependencies = (errorTerminal = false): SyncLifecycleDependencies => {
  let currentPhase: SyncCleanupPhaseSnapshot | null = null;
  return {
    resourceRegistry: {
      get currentPhase() {
        return currentPhase;
      },
      requestPhase: (request) => {
        const baseCertificate = cleanupCertificate(request);
        const certificate = {
          ...baseCertificate,
          effectiveScope: request.effectiveScope,
          authoritativeAudit: {
            ...baseCertificate.authoritativeAudit,
            scope: request.effectiveScope,
          },
        };
        const terminal = errorTerminal
          ? {
              status: "error" as const,
              certificate,
              fault: {
                category: "permanent" as const,
                code: "sync.cleanup-terminal-contract",
                safeMessage: "Cleanup terminal violated its fault-category contract.",
                releaseCertificate: certificate,
              },
            }
          : { status: "success" as const, certificate };
        currentPhase = {
          cleanupEpoch: request.cleanupEpoch,
          cleanupPhase: request.cleanupPhase,
          effectiveScope: request.effectiveScope,
          frozenReleaseSetId: certificate.frozenReleaseSetId,
          certificateId: certificate.certificateId,
          auditDigest: certificate.authoritativeAudit.digest,
          terminal,
        };
        return currentPhase;
      },
      awaitPhase: async () => {
        if (!currentPhase) return { status: "pending" as const };
        return currentPhase.terminal;
      },
    },
  };
};

const stateId = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const entries = Object.entries(value);
  if (entries.length === 0) return "";
  const [parent, child] = entries[0];
  return typeof child === "string" ? `${parent}.${child}` : parent;
};

const faultForTransition = (transition: (typeof signedModel.transitions)[number]) => ({
  category: transition.guards.includes("faultIsAuthentication") ||
    transition.guards.some((guard) => guard.startsWith("authFault"))
    ? ("authentication" as const)
    : transition.guards.includes("faultIsTransient")
      ? ("transient" as const)
      : transition.guards.includes("faultIsFatal")
        ? ("permanent" as const)
        : ("invariant" as const),
  code: "sync.test-fault",
  safeMessage: "test fault",
});

const cleanupTerminalCertificate = (dependencies: SyncLifecycleDependencies) => {
  const phase = dependencies.resourceRegistry.currentPhase;
  if (!phase || phase.terminal.status === "pending") throw new Error("cleanup phase is not installed");
  return phase.terminal.certificate;
};

const eventForTransition = (
  transition: (typeof signedModel.transitions)[number],
  snapshot: ReturnType<ReturnType<typeof createSyncLifecycleActor>["getSnapshot"]>,
  dependencies: SyncLifecycleDependencies,
): SyncLifecycleEvent => {
  const scopeEpoch = snapshot.context.scopeEpoch;
  switch (transition.event) {
    case "xstate.init":
      return { type: "xstate.init" };
    case "control.start.requested":
      return { type: transition.event, commandId: `path:${transition.id}` };
    case "control.pause.requested":
    case "control.resume.requested":
    case "control.stop.requested":
      return {
        type: transition.event,
        commandId: `path:${transition.id}`,
        idempotencyKey: `path:${transition.id}`,
      };
    case "lifecycle.restart.requested":
      return { type: transition.event, requestId: `path:${transition.id}`, reason: "path" };
    case "process.shutdown.requested":
      return { type: transition.event, requestId: `path:${transition.id}`, signal: "TERM" };
    case "credentials.changed":
      return { type: transition.event, revision: snapshot.context.latestCredentialRevision + 1 };
    case "xstate.done.actor.bootstrapSession":
      return {
        type: transition.event,
        output: {
          next: transition.target === "backfilling.active" ? "backfill" : transition.target === "watching.polling" ? "poll" : "idle",
          checkpoint,
        },
      };
    case "xstate.error.actor.bootstrapSession":
      return { type: transition.event, error: faultForTransition(transition) };
    case "xstate.done.actor.initialBackfill":
      return {
        type: transition.event,
        output: {
          status: "completed",
          checkpoint,
          completion: {},
          watchStrategy: transition.target === "watching.polling" ? "poll" : "idle",
        },
      };
    case "xstate.error.actor.initialBackfill":
      return { type: transition.event, error: faultForTransition(transition) };
    case "idle.ready":
      return { type: transition.event, scopeEpoch };
    case "idle.mailboxChanged":
      return { type: transition.event, scopeEpoch };
    case "idle.completed":
      return { type: transition.event, scopeEpoch };
    case "idle.failed":
      return { type: transition.event, scopeEpoch, fault: faultForTransition(transition) };
    case "watchTimer.elapsed":
      return { type: transition.event, scopeEpoch };
    case "watchTimer.failed":
      return { type: transition.event, scopeEpoch, fault: faultForTransition(transition) };
    case "xstate.done.actor.recurringSweep":
      return {
        type: transition.event,
        output: {
          status: transition.guards.includes("sweepNotEligible") ? "not-eligible" : "completed",
          checkpoint,
          completion: {},
          watchStrategy: transition.target === "watching.polling" ? "poll" : "idle",
        },
      };
    case "xstate.error.actor.recurringSweep":
      return { type: transition.event, error: faultForTransition(transition) };
    case "retryTimer.elapsed":
      return { type: transition.event, scopeEpoch };
    case "retryTimer.failed":
      return { type: transition.event, scopeEpoch, fault: faultForTransition(transition) };
    case "xstate.done.actor.cleanupBarrier":
      return { type: transition.event, output: cleanupTerminalCertificate(dependencies) };
    case "xstate.error.actor.cleanupBarrier": {
      const certificate = cleanupTerminalCertificate(dependencies);
      return {
        type: transition.event,
        error: {
          category: "permanent",
          code: "sync.cleanup-terminal-contract",
          safeMessage: "Cleanup terminal violated its fault-category contract.",
          releaseCertificate: certificate,
        },
      };
    }
    default: {
      const exhaustive: never = transition.event;
      throw new Error(`unhandled path event ${exhaustive}`);
    }
  }
};

const prepareExhaustedRetryBranch = (
  transitionId: string,
  actor: ReturnType<typeof createSyncLifecycleActor>,
  dependencies: SyncLifecycleDependencies,
) => {
  if (transitionId === "T104") {
    actor.send({
      type: "xstate.error.actor.bootstrapSession",
      error: { category: "transient", code: "sync.test-fault", safeMessage: "test fault" },
    });
    actor.send({ type: "retryTimer.elapsed", scopeEpoch: actor.getSnapshot().context.scopeEpoch });
    return;
  }
  if (transitionId === "T124" || transitionId === "T127") {
    actor.send({ type: "idle.completed", scopeEpoch: actor.getSnapshot().context.scopeEpoch });
    if (stateId(actor.getSnapshot().value) !== "watching.closingForRetry")
      throw new Error(`retry setup first step ${stateId(actor.getSnapshot().value)}`);
    actor.send({
      type: "xstate.done.actor.cleanupBarrier",
      output: cleanupTerminalCertificate(dependencies),
    });
    if (stateId(actor.getSnapshot().value) !== "retryWaiting.active")
      throw new Error(`retry setup cleanup step ${stateId(actor.getSnapshot().value)}`);
    actor.send({ type: "retryTimer.elapsed", scopeEpoch: actor.getSnapshot().context.scopeEpoch });
    actor.send({ type: "xstate.done.actor.bootstrapSession", output: { next: "idle", checkpoint } });
    if (stateId(actor.getSnapshot().value) !== "watching.idling")
      throw new Error(`retry setup bootstrap step ${stateId(actor.getSnapshot().value)}`);
    return;
  }
  if (transitionId === "T130") {
    actor.send({ type: "lifecycle.restart.requested", requestId: "path:restart", reason: "path" });
    actor.send({
      type: "xstate.done.actor.cleanupBarrier",
      output: cleanupTerminalCertificate(dependencies),
    });
    actor.send({ type: "xstate.done.actor.bootstrapSession", output: { next: "poll", checkpoint } });
  }
};

describe("P3-C15 candidate.8 signed projection", () => {
  test("normative JSON bytes retain the signed candidate.8 digest", async () => {
    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file("docs/architecture/sync-statechart.model.json").arrayBuffer())
      .digest("hex");
    expect(digest).toBe("3c26fe8132871e2f2295ca805161e17571c93d99a74aad0161117c38eb979f91");
  });

  test("runtime inspection metadata equals the independent normative model projection", () => {
    expect(syncStatechartInspection.modelDigest).toBe("3c26fe8132871e2f2295ca805161e17571c93d99a74aad0161117c38eb979f91");
    expectJsonEqual(syncStatechartInspection.transitions, signedModel.transitions);
    expectJsonEqual(syncStatechartInspection.events, signedModel.events);
    expectJsonEqual(syncStatechartInspection.stateHierarchy, signedModel.states);
    expectJsonEqual(syncStatechartInspection.guards, signedModel.guards);
    expectJsonEqual(syncStatechartInspection.actions, signedModel.actions);
    expectJsonEqual(syncStatechartInspection.actors, signedModel.actors);
    expectJsonEqual(syncStatechartInspection.globalEventPolicy, signedModel.globalEventPolicy);
    expectJsonEqual(
      syncStatechartInspection.forbiddenConfigurations,
      signedModel.unreachableStateAccount.forbiddenConfigurations,
    );
    expectJsonEqual(syncStatechartInspection.contextFieldCount, signedModel.context.length);
    expect(syncStatechartInspection.transitionCount).toBe(91);
    expect(syncStatechartInspection.expandedTransitionCount).toBe(204);

    const expectedRuntimeStates = signedModel.states.map((state) => ({
      id: state.id,
      kind: state.kind,
      tags: state.kind === "atomic" ? ["status", "version"] : [],
      invokedActors: "invokedActors" in state ? state.invokedActors : [],
    }));
    expectJsonEqual(syncStatechartInspection.runtimeStateNodes, expectedRuntimeStates);

    const expectedRuntimeTransitions = signedModel.transitions.flatMap((transition) => {
        const sources = Array.isArray(transition.source) ? transition.source : [transition.source];
        const targetState = signedModel.states.find((state) => state.id === transition.target);
        return sources.map((source) => ({
          id: transition.id,
          source,
          event: transition.event,
          target: transition.target,
          guards: transition.guards,
          actions: transition.actions,
          stoppedActors: transition.stoppedActors,
          startedActors: transition.startedActors,
          reenter: "reenter" in transition && transition.reenter === true,
          actorInputOwnership: transition.startedActors.map((actor) => ({
            actor,
            target: targetState && "actorInput" in targetState ? targetState.actorInput : null,
          })),
        }));
      });
    const byTransitionKey = (left: { id: string; source: string }, right: { id: string; source: string }) =>
      `${left.id}:${left.source}`.localeCompare(`${right.id}:${right.source}`);
    expectJsonEqual(
      [...syncStatechartInspection.runtimeExpandedTransitions].sort(byTransitionKey),
      [...expectedRuntimeTransitions].sort(byTransitionKey),
    );
    expect([...syncStatechartInspection.runtimeEventIds].sort()).toEqual(
      signedModel.events.map((event) => event.id).sort(),
    );
    expect([...syncStatechartInspection.runtimeGuardIds].sort()).toEqual(
      signedModel.guards.map((guard) => guard.id).sort(),
    );
    expect([...syncStatechartInspection.runtimeActionIds].sort()).toEqual(
      signedModel.actions.map((action) => action.id).sort(),
    );
    expect([...syncStatechartInspection.runtimeActorIds].sort()).toEqual(
      signedModel.actors.map((actor) => actor.id).sort(),
    );
    const cleanupInputFields = new Set([
      "minimumScope",
      "cleanupEpoch",
      "effectiveScope",
      "cleanupPhase",
      "invokeLease",
      "phaseTerminal",
      "frozenReleaseSetId",
      "resourceRegistry",
    ]);
    for (const inputMetadata of syncStatechartInspection.runtimeActorInputs.filter(
      (candidate) => candidate.actor === "cleanupBarrier",
    ))
      for (const field of cleanupInputFields) expect(inputMetadata.fields).toContain(field);
    expect(syncStatechartInspection.runtimeActorInputs.some((candidate) =>
      candidate.actor === "initialBackfill" && candidate.fields.includes("mailboxWorkSet") && candidate.fields.includes("boundedBatchConfiguration"),
    )).toBe(true);
    expect(syncStatechartInspection.runtimeActorInputs.some((candidate) =>
      candidate.actor === "retryTimer" && candidate.fields.includes("retryBaseMs") && candidate.fields.includes("injectedRandomSource"),
    )).toBe(true);
  });

  test("exports every accepted atomic state and generated shortest-path corpus", () => {
    expect(SIGNED_ATOMIC_STATES).toHaveLength(24);
    expectJsonEqual(syncStatechartInspection.generatedStatePaths, signedModel.coverage.generatedStatePaths);
    expectJsonEqual(syncStatechartInspection.pathCorpus, signedModel.coverage.pathCorpus);
    expectJsonEqual(syncStatechartInspection.registryChurn, signedModel.coverage.registryChurn);
    expect(SIGNED_TRANSITIONS).toHaveLength(91);
  });

  test("generated corpus resolves every path, forbidden configuration, and inventory reference", () => {
    const atomicIds = new Set(
      signedModel.states.filter((state) => state.kind === "atomic").map((state) => state.id),
    );
    const eventIds = new Set(signedModel.events.map((event) => event.id));
    const guardIds = new Set(signedModel.guards.map((guard) => guard.id));
    const actionIds = new Set(signedModel.actions.map((action) => action.id));
    const actorIds = new Set(signedModel.actors.map((actor) => actor.id));
    const resolverActions = new Set(
      [...signedModel.controlProjection.resolver.commonCells, ...signedModel.controlProjection.resolver.idempotencyCells]
        .filter((cell): cell is typeof cell & { action: string } => "action" in cell)
        .map((cell) => cell.action),
    );
    const usedActions = new Set([
      ...signedModel.transitions.flatMap((transition) => transition.actions),
      ...signedModel.globalEventPolicy.flatMap((policy) => policy.actions),
      ...resolverActions,
    ]);
    expect(usedActions).toEqual(actionIds);
    expect(signedModel.unreachableStateAccount.forbiddenConfigurations).toHaveLength(18);
    expect(new Set(signedModel.unreachableStateAccount.forbiddenConfigurations.map((item) => item.id)).size).toBe(18);
    expect(signedModel.transitions).toHaveLength(91);
    expect(signedModel.transitions.reduce((count, transition) => count + (Array.isArray(transition.source) ? transition.source.length : 1), 0)).toBe(204);

    for (const transition of signedModel.transitions) {
      const sources = Array.isArray(transition.source) ? transition.source : [transition.source];
      for (const source of sources) expect(source === "@uninitialized" || atomicIds.has(source)).toBe(true);
      expect(transition.target === null || atomicIds.has(transition.target)).toBe(true);
      expect(eventIds.has(transition.event)).toBe(true);
      for (const guard of transition.guards) expect(guardIds.has(guard)).toBe(true);
      for (const action of transition.actions) expect(actionIds.has(action)).toBe(true);
      for (const actor of [...transition.startedActors, ...transition.stoppedActors]) {
        expect(actor === "@source" || actor === "@target" || actorIds.has(actor)).toBe(true);
      }
    }

    for (const path of signedModel.coverage.generatedStatePaths) {
      let state = "@uninitialized";
      for (const transitionId of path.transitionIds) {
        const transition = signedModel.transitions.find((candidate) => candidate.id === transitionId);
        expect(transition).toBeDefined();
        if (!transition) continue;
        const sources = Array.isArray(transition.source) ? transition.source : [transition.source];
        expect(sources).toContain(state);
        state = transition.target ?? state;
      }
      expect(state).toBe(path.state);
    }
  });

  test("generated shortest paths execute against XState snapshots and child ownership", () => {
    for (const path of signedModel.coverage.generatedStatePaths) {
      const dependencies = cleanupDependencies(path.transitionIds.includes("T183"));
      const actor = createSyncLifecycleActor(input, {}, dependencies);
      actor.start();
      for (const transitionId of path.transitionIds.slice(1)) {
        const transition = signedModel.transitions.find((candidate) => candidate.id === transitionId);
        expect(transition).toBeDefined();
        if (!transition) continue;
        const source = stateId(actor.getSnapshot().value);
        const sources = Array.isArray(transition.source) ? transition.source : [transition.source];
        expect(sources).toContain(source);
        prepareExhaustedRetryBranch(transitionId, actor, dependencies);
        if (transitionId === "T124" && stateId(actor.getSnapshot().value) !== "watching.idling")
          throw new Error(`T124 precondition ended at ${stateId(actor.getSnapshot().value)}`);
        actor.send(eventForTransition(transition, actor.getSnapshot(), dependencies));
        const snapshot = actor.getSnapshot();
        expect(snapshot.status).not.toBe("error");
        if (transition.target && stateId(snapshot.value) !== transition.target)
          throw new Error(`${path.state}: ${transitionId} expected ${transition.target}, got ${stateId(snapshot.value)}`);
        const modelState = signedModel.states.find((state) => state.id === stateId(snapshot.value));
        const expectedActors = modelState && "invokedActors" in modelState ? modelState.invokedActors : [];
        expect(Object.keys(snapshot.children).sort()).toEqual([...expectedActors].sort());
      }
      expect(stateId(actor.getSnapshot().value)).toBe(path.state);
    }
  });

  test("runtime atomic nodes retain signed observation tags and actor ownership", () => {
    for (const state of SIGNED_ATOMIC_STATES) {
      const node = syncLifecycleMachine.getStateNodeById(state.id);
      expect(node.definition.tags).toEqual(["status", "version"]);
      const invoked = node.definition.invoke.map((entry) => entry.id);
      expect(invoked).toEqual("invokedActors" in state ? [...state.invokedActors] : []);
    }
    const reentry = syncLifecycleMachine
      .getStateNodeById("starting.active")
      .definition.transitions.find((transition) => transition.meta?.transitionId === "T097");
    expect(reentry?.reenter).toBe(true);
  });

  test("the seven-event adapter rejects every reserved/internal event before actor.send", () => {
    expect(SIGNED_EXTERNAL_EVENT_IDS).toHaveLength(7);
    for (const eventId of SIGNED_EXTERNAL_EVENT_IDS) {
      const candidate = eventId === "credentials.changed"
        ? { type: eventId, revision: 1 }
        : eventId === "lifecycle.restart.requested"
          ? { type: eventId, requestId: "r", reason: "test" }
          : eventId === "process.shutdown.requested"
            ? { type: eventId, requestId: "r", signal: "TERM" }
            : eventId === "control.start.requested"
              ? { type: eventId, commandId: "c" }
              : { type: eventId, commandId: "c", idempotencyKey: "k" };
      expect(parseExternalSyncEvent(candidate).type).toBe(eventId);
    }
    for (const eventId of signedModel.events.map((event) => event.id).filter((id) => !SIGNED_EXTERNAL_EVENT_IDS.includes(id as typeof SIGNED_EXTERNAL_EVENT_IDS[number]))) {
      expect(() => parseExternalSyncEvent({ type: eventId })).toThrow();
    }
  });

  test("actual snapshots reject stale, duplicate, reordered, and late events", async () => {
    const bootstrapSession = fromPromise(async () => ({ next: "idle" as const, checkpoint }));
    const dependencies = cleanupDependencies();
    const actor = createSyncLifecycleActor(input, { bootstrapSession }, dependencies);
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "illegal-start" });
    await waitForActor();
    const currentScopeEpoch = actor.getSnapshot().context.scopeEpoch;
    actor.send({ type: "idle.ready", scopeEpoch: currentScopeEpoch });
    const afterReady = JSON.stringify({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      children: Object.keys(actor.getSnapshot().children),
      status: projectSyncStatus(actor.getSnapshot()),
    });
    actor.send({ type: "idle.ready", scopeEpoch: currentScopeEpoch });
    expect(JSON.stringify({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      children: Object.keys(actor.getSnapshot().children),
      status: projectSyncStatus(actor.getSnapshot()),
    })).toBe(afterReady);
    actor.send({ type: "idle.mailboxChanged", scopeEpoch: currentScopeEpoch - 1 });
    expect(JSON.stringify({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      children: Object.keys(actor.getSnapshot().children),
      status: projectSyncStatus(actor.getSnapshot()),
    })).toBe(afterReady);
    actor.send({ type: "control.start.requested", commandId: "stale-start", expectedVersion: 0 });
    expect(JSON.stringify({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      children: Object.keys(actor.getSnapshot().children),
      status: projectSyncStatus(actor.getSnapshot()),
    })).toBe(afterReady);

    actor.send({ type: "control.pause.requested", commandId: "late-pause", idempotencyKey: "late-pause" });
    await waitForActor();
    actor.send({
      type: "xstate.done.actor.cleanupBarrier",
      output: cleanupTerminalCertificate(dependencies),
    });
    expect(actor.getSnapshot().matches("paused")).toBe(true);
    const pausedSnapshot = JSON.stringify({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      children: Object.keys(actor.getSnapshot().children),
      status: projectSyncStatus(actor.getSnapshot()),
    });
    actor.send({ type: "idle.mailboxChanged", scopeEpoch: currentScopeEpoch });
    expect(JSON.stringify({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      children: Object.keys(actor.getSnapshot().children),
      status: projectSyncStatus(actor.getSnapshot()),
    })).toBe(pausedSnapshot);
  });

  test("cleanup admission is registry-authoritative and enforces active minimum scope", async () => {
    const bootstrapSession = fromPromise(async () => ({ next: "idle" as const, checkpoint }));
    const dependencies = cleanupDependencies();
    const actor = createSyncLifecycleActor(input, { bootstrapSession }, dependencies);
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "authority-start" });
    await waitForActor();
    actor.send({ type: "control.pause.requested", commandId: "authority-pause", idempotencyKey: "authority-pause" });
    await waitForActor();
    const current = cleanupTerminalCertificate(dependencies);
    const wrongCertificate = {
      ...current,
      certificateId: "not-the-registry-certificate",
    };
    actor.send({ type: "xstate.done.actor.cleanupBarrier", output: wrongCertificate });
    expect(actor.getSnapshot().matches({ watching: "closingForPause" })).toBe(true);
    const narrowerCertificate = {
      ...current,
      effectiveScope: "watch" as const,
      authoritativeAudit: {
        ...current.authoritativeAudit,
        scope: "watch" as const,
      },
    };
    actor.send({ type: "xstate.done.actor.cleanupBarrier", output: narrowerCertificate });
    expect(actor.getSnapshot().matches({ watching: "closingForPause" })).toBe(true);
    actor.send({ type: "xstate.done.actor.cleanupBarrier", output: current });
    expect(actor.getSnapshot().matches("paused")).toBe(true);
  });
});

describe("P3-C15 executable lifecycle", () => {
  test("adopts only validated committed checkpoints from actor results", async () => {
    const committedCheckpoint = {
      ...checkpoint,
      completedMailboxes: 1,
      completedMessages: 4,
      lastMailbox: "INBOX",
      lastUid: 9,
    } as const;
    const bootstrapSession = fromPromise(async () => ({ next: "idle" as const, checkpoint: committedCheckpoint }));
    const actor = createSyncLifecycleActor(input, { bootstrapSession });
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "start-checkpoint" });
    await waitForActor();
    expect(actor.getSnapshot().context.checkpoint).toEqual(committedCheckpoint);
  });

  test("uses the configured retry budget without adding lifecycle context fields", () => {
    const actor = createSyncLifecycleActor(input);
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "start-retry" });
    actor.send({
      type: "xstate.error.actor.bootstrapSession",
      error: { category: "transient", code: "temporary", safeMessage: "temporary" },
    });
    expect(actor.getSnapshot().matches({ retryWaiting: "active" })).toBe(true);
    const scopeEpoch = actor.getSnapshot().context.scopeEpoch;
    actor.send({ type: "retryTimer.elapsed", scopeEpoch });
    actor.send({
      type: "xstate.error.actor.bootstrapSession",
      error: { category: "transient", code: "temporary", safeMessage: "temporary" },
    });
    expect(actor.getSnapshot().matches({ stopping: "afterFailure" })).toBe(true);
    expect(Object.keys(actor.getSnapshot().context)).toHaveLength(15);
  });

  test("opens a watch cleanup phase before promoting it to workflow scope", async () => {
    const bootstrapSession = fromPromise(async () => ({ next: "idle" as const, checkpoint }));
    const actor = createSyncLifecycleActor(input, { bootstrapSession });
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "start-watch" });
    await waitForActor();
    actor.send({ type: "idle.mailboxChanged", scopeEpoch: actor.getSnapshot().context.scopeEpoch });
    expect(actor.getSnapshot().matches({ watching: "closingForSweep" })).toBe(true);
    expect(actor.getSnapshot().context.effectiveCleanupScope).toBe("watch");
    expect(actor.getSnapshot().context.cleanupEpoch).toBe(1);
    expect(actor.getSnapshot().context.cleanupPhase).toBe(1);
    actor.send({ type: "control.pause.requested", commandId: "pause-watch", idempotencyKey: "pause-watch" });
    expect(actor.getSnapshot().context.effectiveCleanupScope).toBe("workflow");
    expect(actor.getSnapshot().context.cleanupEpoch).toBe(1);
    expect(actor.getSnapshot().context.cleanupPhase).toBe(2);
  });

  test("start uses one lifecycle authority and reaches watching through an injected actor", async () => {
    const bootstrapSession = fromPromise(async () => ({ next: "idle" as const, checkpoint }));
    const actor = createSyncLifecycleActor(input, { bootstrapSession });
    actor.start();
    createSyncExternalSendAdapter(actor).send({ type: "control.start.requested", commandId: "start-1" });
    await waitForActor();
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches({ watching: "idling" })).toBe(true);
    expect(snapshot.context.version).toBe(2);
    expect(Object.keys(snapshot.context)).toHaveLength(15);
    expect(projectSyncStatus(snapshot)).toMatchObject({ actorState: "watching", activeOperation: "watch", incarnationId: "incarnation:test", version: 2 });
  });

  test("default actors receive isolated registry authorities per incarnation", async () => {
    const registries: SyncActorInputs["resourceRegistry"][] = [];
    const bootstrapSession = fromPromise(
      async ({ input: actorInput }: { input: SyncActorInputs }) => {
        registries.push(actorInput.resourceRegistry);
        return { next: "idle" as const, checkpoint };
      },
    );
    const first = createSyncLifecycleActor(input, { bootstrapSession });
    const second = createSyncLifecycleActor(input, { bootstrapSession });
    first.start();
    second.start();
    first.send({ type: "control.start.requested", commandId: "isolated-first" });
    second.send({ type: "control.start.requested", commandId: "isolated-second" });
    await waitForActor();

    expect(registries).toHaveLength(2);
    const [firstRegistry, secondRegistry] = registries;
    expect(firstRegistry).not.toBe(secondRegistry);
    firstRegistry.requestPhase({
      minimumScope: "watch",
      cleanupEpoch: 1,
      cleanupPhase: 1,
      effectiveScope: "watch",
      invokeLease: 1,
    });
    expect(firstRegistry.currentPhase).not.toBeNull();
    expect(secondRegistry.currentPhase).toBeNull();
    first.stop();
    second.stop();
  });

  test("cleanup success reaches paused only after the current certificate", async () => {
    const bootstrapSession = fromPromise(async () => ({ next: "idle" as const, checkpoint }));
    const cleanupBarrier = fromPromise(async ({ input: value }: { input: SyncActorInputs }) => cleanupCertificate(value));
    const actor = createSyncLifecycleActor(input, { bootstrapSession, cleanupBarrier }, cleanupDependencies());
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "start-2" });
    await waitForActor();
    actor.send({ type: "control.pause.requested", commandId: "pause-1", idempotencyKey: "pause-1" });
    await waitForActor();
    expect(actor.getSnapshot().matches("paused")).toBe(true);
    expect(actor.getSnapshot().children).toEqual({});
  });

  test("certified cleanup errors terminate without a live child", async () => {
    const bootstrapSession = fromPromise(async () => ({ next: "idle" as const, checkpoint }));
    const dependencies = cleanupDependencies(true);
    const actor = createSyncLifecycleActor(input, { bootstrapSession }, dependencies);
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "error-start" });
    await waitForActor();
    actor.send({ type: "control.stop.requested", commandId: "error-stop", idempotencyKey: "error-stop" });
    await waitForActor();
    const certificate = cleanupTerminalCertificate(dependencies);
    actor.send({
      type: "xstate.error.actor.cleanupBarrier",
      error: {
        category: "permanent",
        code: "sync.cleanup-terminal-contract",
        safeMessage: "Cleanup terminal violated its fault-category contract.",
        releaseCertificate: certificate,
      },
    });
    expect(actor.getSnapshot().matches("stopped.failed")).toBe(true);
    expect(actor.getSnapshot().children).toEqual({});
    expect(projectSyncStatus(actor.getSnapshot()).diagnostics.map((item) => item.code)).toContain(
      "sync.terminal-failure",
    );
  });

  test("cleanup errors admit only the exact permanent/invariant terminal contract", () => {
    const actor = createSyncLifecycleActor(input);
    actor.start();
    const before = actor.getSnapshot();
    expect(() => createSyncExternalSendAdapter(actor).send({ type: "xstate.error.actor.cleanupBarrier", error: {} })).toThrow();
    expect(actor.getSnapshot().value).toEqual(before.value);
    expect(() => cleanupCertificateSchema.parse({})).toThrow();
    expect(() =>
      cleanupTerminalFaultSchema.parse({
        category: "transient",
        code: "Bad Code",
        safeMessage: "unsafe",
        releaseCertificate: {},
      }),
    ).toThrow();
    const invalid: CleanupTerminalFault = {
      category: "invariant",
      code: "sync.cleanup-terminal-contract",
      safeMessage: "Cleanup terminal violated its fault-category contract.",
      releaseCertificate: cleanupCertificate({ cleanupEpoch: before.context.cleanupEpoch, cleanupPhase: before.context.cleanupPhase, invokeLease: before.context.cleanupInvokeLease }),
    };
    expect(invalid.releaseCertificate.released).toBe(true);
  });

  test("adjacent counterexample is impossible: paused status follows the snapshot, never a helper boolean", () => {
    const actor = createSyncLifecycleActor(input);
    actor.start();
    const status = projectSyncStatus(actor.getSnapshot());
    expect(status.actorState).toBe("stopped");
    expect(actor.getSnapshot().hasTag("status")).toBe(true);
    expect(actor.getSnapshot().hasTag("version")).toBe(true);
  });
});

test("machine hierarchy has the accepted root and 24 atomic nodes", () => {
  expect(syncLifecycleMachine.id).toBe("syncLifecycle");
  expect(syncLifecycleMachine.version).toBe("1.0.0-candidate.8");
  expect(Object.keys(syncLifecycleMachine.states)).toEqual(["stopped", "starting", "backfilling", "watching", "sweeping", "retryWaiting", "authBlocked", "paused", "stopping"]);
});
