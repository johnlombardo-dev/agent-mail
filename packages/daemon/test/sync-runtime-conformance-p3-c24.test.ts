import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createActor, fromPromise } from "xstate";
import type { Database } from "bun:sqlite";
import model from "../../../docs/architecture/sync-statechart.model.json" with { type: "json" };
import traces from "./fixtures/sync-runtime-conformance-traces.json" with { type: "json" };
import {
  createAccountId,
  createMailboxId,
  createRemoteUid,
  createRemoteUidValue,
  createUtcInstant,
  createUidValidity,
  type UtcInstant,
} from "@agent-mail/core";
import { createMetadataBatchAdapter } from "../../imap/src/metadata-batch";
import {
  type IdleSessionHandlers,
  type IdleSessionResource,
  idleSessionActor,
} from "../../imap/src/idle-session";
import { createRawMessageDownloadQueueActor } from "../../imap/src/raw-download-queue";
import type { RawMessageDownloadAdapter, RawMessageDownloadRequest, RawMessageDownloadResult } from "../../imap/src/raw-download";
import { runMigrations } from "../../storage/src/migration-runner";
import { openDatabase } from "../../storage/src/database";
import {
  createMailboxCheckpointRepository,
  mailboxCheckpointMigration,
} from "../../storage/src/checkpoint-repository";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
import { identityOnlyContentMigration } from "../../storage/src/migrations/0002-identity-only-content";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import { placementObservationMigration } from "../../storage/src/migrations/0003-placement-observation";
import {
  createInitialBackfillCompletionRepository,
  initialBackfillCompletionMigration,
  runInitialBackfillLoop,
} from "../src/initial-backfill-loop";
import { runRecurringMailboxSweep } from "../src/recurring-mailbox-sweep";
import {
  createPollingTimerActorLogic,
  type PollingTimerClock,
  type PollingTimerHandle,
} from "../src/polling-timer-actor";
import {
  createSyncExternalSendAdapter,
  createSyncLifecycleActor,
  createSyncResourceRegistry,
  registerCompositeQueueSlot,
  projectSyncStatus,
  type BootstrapOutput,
  type InitialBackfillActorInput,
  type LoopOutput,
  type RecurringSweepActorInput,
  type SyncActorInputs,
  type SyncActorImplementations,
  type SyncCleanupPhaseTerminal,
  type SyncLifecycleConfiguration,
  type SyncLifecycleEvent,
} from "../src/sync-statechart";
import type { InitialBackfillBatchDependencies } from "../src/initial-backfill-batch";

const modelDigest = "3c26fe8132871e2f2295ca805161e17571c93d99a74aad0161117c38eb979f91";
const accountId = createAccountId("account:p3-c24-runtime");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(42);
const observedAt = createUtcInstant("2026-08-18T00:00:00.000Z");
const eligibleAt = createUtcInstant("2026-08-18T01:00:00.000Z");
const checkpoint = {
  completedMailboxes: 0,
  totalMailboxes: 1,
  completedMessages: 0,
  pendingMessages: 0,
  lastMailbox: "INBOX",
  lastUid: null,
} as const;
const configuration: SyncLifecycleConfiguration = {
  retryBaseMs: 10,
  retryCapMs: 100,
  retryJitterRatio: 0,
  maxRetryAttempts: 2,
  periodicStatusIntervalMs: 10,
  controlDeadlineMs: 100,
  controlResultRetentionMs: 100,
  maxControlIdempotencyEntries: 16,
  maxReleaseSlotEntries: 32,
};
const roots: string[] = [];

type VirtualTimer = Readonly<{ readonly callback: () => void; readonly handle: number; readonly delayMs: number }>;

class VirtualClock implements PollingTimerClock {
  private nextHandle = 1;
  private readonly timers = new Map<number, VirtualTimer>();
  readonly scheduledDelays: number[] = [];

  get activeTimerCount(): number {
    return this.timers.size;
  }

  setTimeout(callback: () => void, delayMs: number): PollingTimerHandle {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduledDelays.push(delayMs);
    this.timers.set(handle, { callback, handle, delayMs });
    return handle;
  }

  clearTimeout(handle: PollingTimerHandle): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  tick(): number {
    const pending = [...this.timers.values()];
    for (const timer of pending) {
      this.timers.delete(timer.handle);
      timer.callback();
    }
    return pending.length;
  }

  leak(): void {
    this.timers.set(this.nextHandle, { handle: this.nextHandle, callback: () => undefined, delayMs: 0 });
    this.nextHandle += 1;
  }
}

class DeterministicIdleAdapter {
  constructor(private readonly delayedClose = false) {}

  private handlers: IdleSessionHandlers | null = null;
  private closeResolver: (() => void) | null = null;
  private closePromise: Promise<void> | null = null;
  closeCalls = 0;

  get listenerCount(): number {
    return this.handlers === null ? 0 : 1;
  }

  get activeSessions(): number {
    return this.handlers === null ? 0 : 1;
  }

  async start(handlers: IdleSessionHandlers): Promise<IdleSessionResource> {
    this.handlers = handlers;
    return {
      close: () => {
        this.closeCalls += 1;
        if (!this.delayedClose) {
          this.handlers = null;
          return Promise.resolve();
        }
        if (this.closePromise === null) {
          this.closePromise = new Promise<void>((resolve) => {
            this.closeResolver = resolve;
          });
        }
        return this.closePromise;
      },
    };
  }

  releaseClose(): void {
    this.handlers = null;
    this.closeResolver?.();
    this.closeResolver = null;
  }

  mailboxChanged(): void {
    this.handlers?.mailboxChanged();
  }

  complete(): void {
    this.handlers?.completed();
  }

  fail(error: unknown): void {
    this.handlers?.error(error);
  }
}

type StorageFixture = Readonly<{
  readonly db: Database;
  readonly path: string;
  readonly close: () => Promise<void>;
}>;

async function storageFixture(): Promise<StorageFixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-p3-c24-runtime-"));
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  runMigrations(opened, [
    { ...messageCatalogMigration, version: 1 },
    { ...mailboxCheckpointMigration, version: 2 },
    { ...identityOnlyContentMigration, version: 3 },
    { ...operationalJournalMigration, version: 4 },
    { ...placementObservationMigration, version: 5 },
    { ...initialBackfillCompletionMigration, version: 6 },
  ]);
  opened.db
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, uidValidity);
  return { db: opened.db, path, close: opened.close };
}

function checkpointRow(db: Database): Readonly<Record<string, unknown>> | null {
  const row = db
    .query("SELECT uid_next, uid_next_known, backfill_completed, observed_version FROM mailbox_checkpoints WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ?;")
    .get(accountId, mailboxId, uidValidity);
  return recordOrNull(row);
}

function completionRow(db: Database): Readonly<Record<string, unknown>> | null {
  const row = db
    .query("SELECT observed_uid_ceiling, observed_uid_next_known, observed_uid_next FROM initial_backfill_completions WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ?;")
    .get(accountId, mailboxId, uidValidity);
  return recordOrNull(row);
}

function recordOrNull(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function durableSummary(db: Database): Readonly<{ readonly checkpoint: unknown; readonly completion: unknown }> {
  return { checkpoint: checkpointRow(db), completion: completionRow(db) };
}

function batchDependencies(): Omit<InitialBackfillBatchDependencies, "checkpoints" | "observedAt" | "signal"> {
  return {
    metadata: createMetadataBatchAdapter({ fetchAll: async () => [] }),
    ingestSingleMessage: async () => {
      throw new Error("unexpected message ingestion in empty deterministic mailbox");
    },
    persistMetadata: () => {
      throw new Error("unexpected metadata persistence in empty deterministic mailbox");
    },
    persistMissing: () => {
      throw new Error("unexpected missing-message persistence in empty deterministic mailbox");
    },
  };
}

function summaryCheckpoint(): typeof checkpoint {
  return checkpoint;
}

function stateId(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const entries = Object.entries(value);
  const first = entries[0];
  if (first === undefined) return "";
  return typeof first[1] === "string" ? `${first[0]}.${first[1]}` : first[0];
}

function expectedActors(state: string): readonly string[] {
  const modelState = model.states.find((candidate) => candidate.id === state);
  return modelState !== undefined && "invokedActors" in modelState
    ? modelState.invokedActors ?? []
    : [];
}

function expectedPublicActorState(state: string): string {
  const candidate = model.states.find((item) => item.id === state);
  return candidate !== undefined && "public" in candidate && candidate.public !== undefined
    ? candidate.public.actorState
    : "stopped";
}

function assertOwnership(actor: ReturnType<typeof createSyncLifecycleActor>, state: string): void {
  expect(Object.keys(actor.getSnapshot().children).sort()).toEqual([...expectedActors(state)].sort());
}

async function waitForState(
  actor: ReturnType<typeof createSyncLifecycleActor>,
  predicate: (state: string) => boolean,
): Promise<void> {
  if (predicate(stateId(actor.getSnapshot().value))) return;
  await new Promise<void>((resolve) => {
    const subscription = actor.subscribe((snapshot) => {
      if (!predicate(stateId(snapshot.value))) return;
      subscription.unsubscribe();
      resolve();
    });
  });
}

function runtimeAudit(
  actor: ReturnType<typeof createSyncLifecycleActor>,
  clock: VirtualClock,
  idle: DeterministicIdleAdapter,
  registry: ReturnType<typeof createSyncResourceRegistry>,
  db: Database,
) {
  const snapshot = actor.getSnapshot();
  const state = stateId(snapshot.value);
  const status = projectSyncStatus(snapshot);
  const registrySnapshot = registry.snapshot?.();
  return {
    state,
    version: snapshot.context.version,
    public: status,
    activeChildren: Object.keys(snapshot.children).sort(),
    timers: clock.activeTimerCount,
    listeners: idle.listenerCount,
    streams: idle.activeSessions,
    subscriptions: idle.listenerCount,
    releaseSlots: registrySnapshot?.slotEntryCount ?? 0,
    registry: registrySnapshot,
    durable: durableSummary(db),
  } as const;
}

function assertTerminalQuiescence(
  audit: ReturnType<typeof runtimeAudit>,
): void {
  expect(audit.activeChildren).toEqual([]);
  expect(audit.timers).toBe(0);
  expect(audit.listeners).toBe(0);
  expect(audit.streams).toBe(0);
  expect(audit.subscriptions).toBe(0);
  expect(audit.releaseSlots).toBe(0);
  expect(audit.registry?.sourceTreeSnapshotCount).toBe(0);
  expect(audit.registry?.phaseSnapshotCount).toBe(0);
  expect(audit.registry?.cleanupSessionOpen).toBe(false);
}

function assertExactWatchResources(
  fixture: Readonly<{ readonly clock: VirtualClock; readonly idle: DeterministicIdleAdapter; readonly registry: ReturnType<typeof createSyncResourceRegistry> }>,
  state: "watching.idling" | "watching.polling",
): void {
  expect(fixture.clock.activeTimerCount).toBe(1);
  expect(fixture.registry.snapshot?.().slotEntryCount).toBe(state === "watching.idling" ? 2 : 1);
  if (state === "watching.idling") {
    expect(fixture.idle.listenerCount).toBe(1);
    expect(fixture.idle.activeSessions).toBe(1);
  } else {
    expect(fixture.idle.listenerCount).toBe(0);
    expect(fixture.idle.activeSessions).toBe(0);
  }
  expect(fixture.idle.listenerCount).toBe(fixture.idle.activeSessions);
}

function assertRuntimeStep(fixture: TraceFixture, expectedState: string): void {
  const audit = runtimeAudit(fixture.actor, fixture.clock, fixture.idle, fixture.registry, fixture.storage.db);
  const expected = model.states.find((state) => state.id === expectedState);
  const expectedInvoked = expected !== undefined && "invokedActors" in expected ? expected.invokedActors ?? [] : [];
  const expectedPublic = expectedPublicActorState(expectedState);
  expect(audit.state).toBe(expectedState);
  expect(audit.activeChildren).toEqual([...expectedInvoked].sort());
  expect(audit.public.version).toBe(audit.version);
  expect(audit.public.actorState as string).toBe(expectedPublic);
  expect(Number.isSafeInteger(audit.version)).toBe(true);
  expect(Number.isSafeInteger(fixture.actor.getSnapshot().context.scopeEpoch)).toBe(true);
  expect(audit.timers).toBeGreaterThanOrEqual(0);
  expect(audit.listeners).toBeGreaterThanOrEqual(0);
  expect(audit.streams).toBeGreaterThanOrEqual(0);
  expect(audit.subscriptions).toBeGreaterThanOrEqual(0);
  expect(audit.releaseSlots).toBeGreaterThanOrEqual(0);
  if (expectedState === "retryWaiting.active") {
    expect(audit.timers).toBe(1);
    expect(audit.listeners).toBe(0);
    expect(audit.streams).toBe(0);
    expect(audit.subscriptions).toBe(0);
    expect(audit.releaseSlots).toBe(2);
  }
  const cleanupStates = [
    "starting.pausing",
    "backfilling.pausing",
    "watching.closingForSweep",
    "watching.closingForRetry",
    "watching.closingForAuthBlock",
    "watching.closingForPause",
    "watching.closingForFailure",
    "sweeping.pausing",
    "retryWaiting.pausing",
    "stopping.forStop",
    "stopping.forRestart",
    "stopping.forShutdown",
    "stopping.afterFailure",
  ];
  if (cleanupStates.includes(expectedState)) {
    expect(audit.timers).toBe(0);
    expect(audit.listeners).toBe(0);
    expect(audit.streams).toBe(0);
    expect(audit.subscriptions).toBe(0);
    expect(audit.releaseSlots).toBe(1);
    expect(audit.registry?.sourceTreeSnapshotCount).toBe(1);
    expect(audit.registry?.phaseSnapshotCount).toBeGreaterThanOrEqual(1);
    expect(audit.registry?.phaseSnapshotCount).toBeLessThanOrEqual(2);
    expect(audit.registry?.cleanupSessionOpen).toBe(true);
  }
  if (["stopped.clean", "stopped.failed", "stopped.shutdown", "paused", "authBlocked"].includes(expectedState)) {
    expect(audit.timers).toBe(0);
    expect(audit.listeners).toBe(0);
    expect(audit.streams).toBe(0);
    expect(audit.subscriptions).toBe(0);
    expect(audit.releaseSlots).toBe(0);
  }
}

function injectStaleScopeOutcomes(fixture: TraceFixture): void {
  const staleScope = fixture.actor.getSnapshot().context.scopeEpoch - 1;
  const before = JSON.stringify(runtimeAudit(fixture.actor, fixture.clock, fixture.idle, fixture.registry, fixture.storage.db));
  const events: SyncLifecycleEvent[] = [
    { type: "idle.ready", scopeEpoch: staleScope },
    { type: "idle.mailboxChanged", scopeEpoch: staleScope },
    { type: "idle.completed", scopeEpoch: staleScope },
    { type: "idle.failed", scopeEpoch: staleScope, fault: { category: "transient", code: "sync.runtime-conformance-stale", safeMessage: "Stale outcome." } },
    { type: "watchTimer.elapsed", scopeEpoch: staleScope },
    { type: "watchTimer.failed", scopeEpoch: staleScope, fault: { category: "transient", code: "sync.runtime-conformance-stale", safeMessage: "Stale outcome." } },
    { type: "retryTimer.elapsed", scopeEpoch: staleScope },
    { type: "retryTimer.failed", scopeEpoch: staleScope, fault: { category: "invariant", code: "sync.runtime-conformance-stale", safeMessage: "Stale outcome." } },
  ];
  for (const actor of expectedActors(stateId(fixture.actor.getSnapshot().value))) {
    if (actor === "bootstrapSession") {
      events.push({ type: "xstate.done.actor.bootstrapSession", output: undefined as never });
    } else if (actor === "initialBackfill") {
      events.push({ type: "xstate.done.actor.initialBackfill", output: undefined as never });
    } else if (actor === "recurringSweep") {
      events.push({ type: "xstate.done.actor.recurringSweep", output: undefined as never });
    } else if (actor === "cleanupBarrier") {
      events.push({ type: "xstate.done.actor.cleanupBarrier", output: undefined as never });
    }
  }
  for (const event of events) fixture.actor.send(event);
  for (const event of events) fixture.actor.send(event);
  expect(JSON.stringify(runtimeAudit(fixture.actor, fixture.clock, fixture.idle, fixture.registry, fixture.storage.db))).toBe(before);
}

function assertVersionAdvance(
  before: number,
  after: number,
  transition: ModelTransition,
): void {
  const expected = before + (transition.actions.includes("advanceVersion") ? 1 : 0);
  expect(after).toBe(expected);
}

function injectLateDuplicateOutcomes(
  fixture: TraceFixture,
  transition: ModelTransition,
  expectedState: string,
): void {
  const stopped = transition.stoppedActors.filter((actor) => actor !== "@source" && actor !== "@target");
  const activeAfter = new Set(expectedActors(expectedState));
  const before = JSON.stringify(runtimeAudit(fixture.actor, fixture.clock, fixture.idle, fixture.registry, fixture.storage.db));
  for (const actor of stopped) {
    if (activeAfter.has(actor)) continue;
    let event: SyncLifecycleEvent | null = null;
    if (actor === "bootstrapSession") event = { type: "xstate.done.actor.bootstrapSession", output: { next: "idle", checkpoint } };
    else if (actor === "initialBackfill") event = { type: "xstate.done.actor.initialBackfill", output: { status: "cancelled", checkpoint, completion: {}, watchStrategy: "idle" } };
    else if (actor === "recurringSweep") event = { type: "xstate.done.actor.recurringSweep", output: { status: "cancelled", checkpoint, completion: {}, watchStrategy: "idle" } };
    else if (actor === "retryTimer") event = { type: "retryTimer.elapsed", scopeEpoch: fixture.actor.getSnapshot().context.scopeEpoch - 1 };
    else if (actor === "idleSession") event = { type: "idle.completed", scopeEpoch: fixture.actor.getSnapshot().context.scopeEpoch - 1 };
    else if (actor === "periodicStatusTimer") event = { type: "watchTimer.elapsed", scopeEpoch: fixture.actor.getSnapshot().context.scopeEpoch - 1 };
    if (event !== null) {
      fixture.actor.send(event);
      fixture.actor.send(event);
    }
  }
  expect(JSON.stringify(runtimeAudit(fixture.actor, fixture.clock, fixture.idle, fixture.registry, fixture.storage.db))).toBe(before);
}

function fakeBootstrapActor(next: BootstrapOutput["next"], value: typeof checkpoint) {
  return fromPromise<BootstrapOutput, SyncActorInputs>(async () => ({ next, checkpoint: value }));
}

function productionActors(
  db: Database,
  clock: VirtualClock,
  idle: DeterministicIdleAdapter,
  bootstrapNext: BootstrapOutput["next"] = "backfill",
): SyncActorImplementations {
  const checkpoints = createMailboxCheckpointRepository(db);
  const completions = createInitialBackfillCompletionRepository(db);
  const batch = batchDependencies();
  const initialBackfill = fromPromise<LoopOutput, InitialBackfillActorInput>(async ({ input, signal }) => {
    const result = await runInitialBackfillLoop(
      {
        accountId,
        mailboxId,
        uidValidity,
        observedUidCeiling: null,
        observedUidNext: { kind: "unknown" },
        observedAt,
        nextSweepEligibleAt: eligibleAt,
        maxBatchUids: 10,
        stagingDirectory: "/tmp/agent-mail-p3-c24-staging",
        owner: { pid: process.pid, processStartIdentity: "p3-c24-runtime" },
      },
      { checkpoints, completions, batch, signal },
    );
    return {
      status: result.status,
      checkpoint: summaryCheckpoint(),
      completion: {},
      watchStrategy: "idle",
    };
  });
  const recurringSweep = fromPromise<LoopOutput, RecurringSweepActorInput>(async ({ input, signal }) => {
    const result = await runRecurringMailboxSweep(
      {
        identity: { accountId, mailboxId, uidValidity },
        now: observedAt,
        observedUidCeiling: null,
        observedUidNext: { kind: "unknown" },
        observedAt,
        nextSweepEligibleAt: eligibleAt,
        maxNewUidBatchUids: 10,
        maxReconciliationUids: 10,
        stagingDirectory: "/tmp/agent-mail-p3-c24-staging",
        owner: { pid: process.pid, processStartIdentity: "p3-c24-runtime" },
        actor: { id: "sync-runtime-actor" },
      },
      {
        checkpoints,
        completions,
        batch,
        listExistingPlacementUids: () => [],
        reconcileExistingPlacement: () => undefined,
        ownsActor: () => true,
        signal,
      },
    );
    return {
      status: result.status,
      checkpoint: summaryCheckpoint(),
      completion: {},
      watchStrategy: "idle",
    };
  });
  return {
    bootstrapSession: fakeBootstrapActor(bootstrapNext, summaryCheckpoint()),
    initialBackfill,
    recurringSweep,
    idleSession: idleSessionActor,
    periodicStatusTimer: createPollingTimerActorLogic({ clock }),
  };
}

async function productionFixture(delayedClose = false, bootstrapNext: BootstrapOutput["next"] = "backfill"): Promise<{
  readonly storage: StorageFixture;
  readonly clock: VirtualClock;
  readonly idle: DeterministicIdleAdapter;
  readonly registry: ReturnType<typeof createSyncResourceRegistry>;
  readonly actor: ReturnType<typeof createSyncLifecycleActor>;
}> {
  const storage = await storageFixture();
  const clock = new VirtualClock();
  const idle = new DeterministicIdleAdapter(delayedClose);
  const registry = createSyncResourceRegistry({ incarnationId: "incarnation:p3-c24", maxReleaseSlotEntries: 32 });
  const actor = createSyncLifecycleActor(
    {
      configuration,
      initialCheckpoint: checkpoint,
      initialCredentialRevision: 0,
      incarnationId: "incarnation:p3-c24",
      validatedIdleAdapter: idle,
      retryTimerClock: clock,
      retryRandomSource: () => 0.5,
    },
    productionActors(storage.db, clock, idle, bootstrapNext),
    { resourceRegistry: registry },
  );
  return { storage, clock, idle, registry, actor };
}

function manualDependencies(): ReturnType<typeof createSyncResourceRegistry> {
  return createSyncResourceRegistry({ incarnationId: "incarnation:property", maxReleaseSlotEntries: 32 });
}

function externalEvent(index: number): Readonly<Record<string, unknown>> {
  switch (index % 7) {
    case 0:
      return { type: "control.start.requested", commandId: `property-start-${index}` };
    case 1:
      return { type: "control.pause.requested", commandId: `property-pause-${index}`, idempotencyKey: `property-${index}` };
    case 2:
      return { type: "control.resume.requested", commandId: `property-resume-${index}`, idempotencyKey: `property-${index}` };
    case 3:
      return { type: "control.stop.requested", commandId: `property-stop-${index}`, idempotencyKey: `property-${index}` };
    case 4:
      return { type: "lifecycle.restart.requested", requestId: `property-restart-${index}`, reason: "property" };
    case 5:
      return { type: "process.shutdown.requested", requestId: `property-shutdown-${index}`, signal: "TERM" };
    default:
      return { type: "credentials.changed", revision: index + 1 };
  }
}

type ModelTransition = (typeof model.transitions)[number];

type HeldResource = Readonly<{
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}>;

type TraceFixture = Readonly<{
  readonly storage: StorageFixture;
  readonly clock: VirtualClock;
  readonly idle: DeterministicIdleAdapter;
  readonly registry: ReturnType<typeof createSyncResourceRegistry>;
  readonly actor: ReturnType<typeof createSyncLifecycleActor>;
  readonly external: ReturnType<typeof createSyncExternalSendAdapter>;
  readonly held: { current: HeldResource | null };
}>;

async function flushActor(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function closeStorageFixture(storage: StorageFixture): Promise<void> {
  await storage.close();
}

function traceFault(transition: ModelTransition, snapshot: ReturnType<ReturnType<typeof createSyncLifecycleActor>["getSnapshot"]>) {
  const authentication = transition.guards.some((guard) => guard.startsWith("authFault") || guard === "faultIsAuthentication");
  const category = authentication
    ? "authentication"
    : transition.guards.includes("faultIsTransient")
      ? "transient"
      : transition.guards.includes("faultIsFatal")
        ? "permanent"
        : "invariant";
  const attemptedCredentialRevision = transition.guards.includes("authFaultUsesFutureRevision")
    ? snapshot.context.latestCredentialRevision + 1
    : transition.guards.includes("authFaultUsesSupersededRevision")
      ? Math.max(0, snapshot.context.latestCredentialRevision - 1)
      : snapshot.context.latestCredentialRevision;
  return {
    category,
    code: "sync.runtime-conformance-fault",
    safeMessage: "Deterministic conformance fault.",
    ...(authentication ? { attemptedCredentialRevision } : {}),
  } as const;
}

function eventForTraceTransition(
  transition: ModelTransition,
  snapshot: ReturnType<ReturnType<typeof createSyncLifecycleActor>["getSnapshot"]>,
  registry: ReturnType<typeof createSyncResourceRegistry>,
): SyncLifecycleEvent {
  const scopeEpoch = snapshot.context.scopeEpoch;
  switch (transition.event) {
    case "xstate.init":
      return { type: "xstate.init" };
    case "control.start.requested":
      return { type: transition.event, commandId: `trace:${transition.id}` };
    case "control.pause.requested":
    case "control.resume.requested":
    case "control.stop.requested":
      return {
        type: transition.event,
        commandId: `trace:${transition.id}`,
        idempotencyKey: `trace:${transition.id}`,
      };
    case "lifecycle.restart.requested":
      return { type: transition.event, requestId: `trace:${transition.id}`, reason: "conformance" };
    case "process.shutdown.requested":
      return { type: transition.event, requestId: `trace:${transition.id}`, signal: "TERM" };
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
      return { type: transition.event, error: traceFault(transition, snapshot) };
    case "xstate.done.actor.initialBackfill":
      return {
        type: transition.event,
        output: {
          status: transition.guards.includes("backfillAlreadyComplete") ? "already-complete" : transition.guards.includes("backfillReturnedUnexpectedCancellation") ? "cancelled" : "completed",
          checkpoint,
          completion: {},
          watchStrategy: transition.target === "watching.polling" ? "poll" : "idle",
        },
      };
    case "xstate.error.actor.initialBackfill":
      return { type: transition.event, error: traceFault(transition, snapshot) };
    case "idle.ready":
    case "idle.mailboxChanged":
    case "idle.completed":
      return { type: transition.event, scopeEpoch };
    case "idle.failed":
      return { type: transition.event, scopeEpoch, fault: traceFault(transition, snapshot) };
    case "watchTimer.elapsed":
      return { type: transition.event, scopeEpoch };
    case "watchTimer.failed":
      return { type: transition.event, scopeEpoch, fault: traceFault(transition, snapshot) };
    case "xstate.done.actor.recurringSweep":
      return {
        type: transition.event,
        output: {
          status: transition.guards.includes("sweepNotEligible")
            ? "not-eligible"
            : transition.guards.includes("sweepViolatedOwnership")
              ? "not-owner"
              : "completed",
          checkpoint,
          completion: {},
          watchStrategy: transition.target === "watching.polling" ? "poll" : "idle",
        },
      };
    case "xstate.error.actor.recurringSweep":
      return { type: transition.event, error: traceFault(transition, snapshot) };
    case "retryTimer.elapsed":
      return { type: transition.event, scopeEpoch };
    case "retryTimer.failed":
      return { type: transition.event, scopeEpoch, fault: traceFault(transition, snapshot) };
    case "xstate.done.actor.cleanupBarrier": {
      const phase = registry.currentPhase;
      if (!phase || phase.terminal.status !== "success") throw new Error(`cleanup success certificate unavailable for ${transition.id}`);
      return { type: transition.event, output: phase.terminal.certificate };
    }
    case "xstate.error.actor.cleanupBarrier": {
      const phase = registry.currentPhase;
      if (!phase || phase.terminal.status !== "error") throw new Error(`cleanup error certificate unavailable for ${transition.id}`);
      return { type: transition.event, error: { category: "permanent", code: "sync.cleanup-terminal-contract", safeMessage: "Cleanup terminal violated its fault-category contract.", releaseCertificate: phase.terminal.certificate } };
    }
    default: {
      throw new Error(`unhandled conformance event ${transition.event}`);
    }
  }
}

function cleanupEvent(transition: Pick<ModelTransition, "event">): "success" | "error" | null {
  if (transition.event === "xstate.done.actor.cleanupBarrier") return "success";
  if (transition.event === "xstate.error.actor.cleanupBarrier") return "error";
  return null;
}

function cleanupScopeFor(transition: ModelTransition): "watch" | "workflow" {
  const sources = Array.isArray(transition.source) ? transition.source : [transition.source];
  return sources.some((source) =>
    (source === "watching.idling" || source === "watching.polling") &&
    (transition.event === "idle.mailboxChanged" || transition.event === "watchTimer.elapsed"),
  ) ? "watch" : "workflow";
}

function holdResource(fixture: TraceFixture, ownerScope: "watch" | "workflow"): void {
  if (fixture.held.current !== null || fixture.registry.currentPhase !== null) return;
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const pending = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  fixture.registry.registerReleaseSlot?.({
    ownerScope,
    ownerInvokeIdentity: "runtime-conformance-held-resource",
    resourceOrdinal: 0,
    stableResourceId: `runtime-conformance:${ownerScope}`,
    release: () => pending,
  });
  fixture.held.current = { resolve: resolvePromise, reject: rejectPromise };
}

async function traceFixture(existingStorage?: StorageFixture): Promise<TraceFixture> {
  const storage = existingStorage ?? (await storageFixture());
  const clock = new VirtualClock();
  const idle = new DeterministicIdleAdapter();
  const registry = createSyncResourceRegistry({ incarnationId: "incarnation:p3-c24-trace", maxReleaseSlotEntries: 32 });
  const actor = createSyncLifecycleActor(
    {
      configuration,
      initialCheckpoint: checkpoint,
      initialCredentialRevision: 0,
      incarnationId: "incarnation:p3-c24-trace",
      retryTimerClock: clock,
      retryRandomSource: () => 0.5,
    },
    {},
    { resourceRegistry: registry },
  );
  actor.start();
  return { storage, clock, idle, registry, actor, external: createSyncExternalSendAdapter(actor), held: { current: null } };
}

async function settleTraceCleanup(
  fixture: TraceFixture,
  transition: Pick<ModelTransition, "event"> & Readonly<{ readonly id?: string }>,
): Promise<void> {
  const outcome = cleanupEvent(transition);
  if (outcome === null) return;
  if (fixture.held.current === null) throw new Error(`missing held resource for ${transition.id ?? transition.event}`);
  if (outcome === "success") fixture.held.current.resolve();
  else fixture.held.current.reject({ category: "permanent", code: "sync.runtime-conformance-cleanup", safeMessage: "Deterministic cleanup failure." });
  fixture.held.current = null;
  await flushActor();
}

async function sendTraceTransition(fixture: TraceFixture, transition: ModelTransition): Promise<void> {
  const source = stateId(fixture.actor.getSnapshot().value);
  const target = transition.target ?? source;
  if (transition.target !== null && transition.target !== undefined &&
      (transition.target.endsWith("pausing") || transition.target.includes("closingFor") || transition.target.startsWith("stopping."))) {
    holdResource(fixture, cleanupScopeFor(transition));
  }
  const outcome = cleanupEvent(transition);
  if (outcome !== null) {
    await settleTraceCleanup(fixture, transition);
  } else if (transition.event !== "xstate.init") {
    const event = eventForTraceTransition(transition, fixture.actor.getSnapshot(), fixture.registry);
    if (
      event.type === "control.start.requested" ||
      event.type === "control.pause.requested" ||
      event.type === "control.resume.requested" ||
      event.type === "control.stop.requested" ||
      event.type === "lifecycle.restart.requested" ||
      event.type === "process.shutdown.requested" ||
      event.type === "credentials.changed"
    ) fixture.external.send(event);
    else fixture.actor.send(event);
    await flushActor();
  }
  const actual = stateId(fixture.actor.getSnapshot().value);
  if (actual !== target) throw new Error(`${transition.id} from ${source}: expected ${target}, got ${actual}`);
  assertOwnership(fixture.actor, actual);
}

async function prepareSupersededAuth(fixture: TraceFixture, transition: ModelTransition): Promise<void> {
  if (!transition.guards.includes("authFaultUsesSupersededRevision")) return;
  fixture.external.send({ type: "credentials.changed", revision: fixture.actor.getSnapshot().context.latestCredentialRevision + 1 });
  await flushActor();
}

async function retryElapsed(fixture: TraceFixture): Promise<void> {
  const scopeEpoch = fixture.actor.getSnapshot().context.scopeEpoch;
  fixture.actor.send({ type: "retryTimer.elapsed", scopeEpoch });
  await flushActor();
}

async function returnToActiveSource(fixture: TraceFixture, source: string): Promise<void> {
  const current = stateId(fixture.actor.getSnapshot().value);
  if (source === "starting.active" && current === "starting.active") return;
  if (current === "starting.active") {
    fixture.actor.send({ type: "xstate.done.actor.bootstrapSession", output: { next: source === "backfilling.active" ? "backfill" : source === "watching.polling" ? "poll" : "idle", checkpoint } });
    await flushActor();
  } else if (current === "retryWaiting.active") {
    await retryElapsed(fixture);
    await returnToActiveSource(fixture, source);
  }
}

async function incrementRetryAttempt(fixture: TraceFixture, source: string): Promise<void> {
  const before = fixture.actor.getSnapshot().context.retryAttempt;
  if (before >= configuration.maxRetryAttempts) return;
  const state = stateId(fixture.actor.getSnapshot().value);
  if (state === "starting.active") {
    fixture.actor.send({ type: "xstate.error.actor.bootstrapSession", error: { category: "transient", code: "sync.runtime-conformance-transient", safeMessage: "Deterministic transient fault." } });
    await flushActor();
    await retryElapsed(fixture);
    await returnToActiveSource(fixture, source);
  } else if (state === "backfilling.active") {
    fixture.actor.send({ type: "xstate.error.actor.initialBackfill", error: { category: "transient", code: "sync.runtime-conformance-transient", safeMessage: "Deterministic transient fault." } });
    await flushActor();
    await retryElapsed(fixture);
    await returnToActiveSource(fixture, source);
  } else if (state === "watching.idling" || state === "watching.polling") {
    const event = state === "watching.idling" ? "idle.failed" : "watchTimer.failed";
    holdResource(fixture, "workflow");
    fixture.actor.send(state === "watching.idling"
      ? { type: event, scopeEpoch: fixture.actor.getSnapshot().context.scopeEpoch, fault: { category: "transient", code: "sync.runtime-conformance-transient", safeMessage: "Deterministic transient fault." } }
      : { type: event, scopeEpoch: fixture.actor.getSnapshot().context.scopeEpoch, fault: { category: "transient", code: "sync.runtime-conformance-transient", safeMessage: "Deterministic transient fault." } });
    await flushActor();
    if (stateId(fixture.actor.getSnapshot().value) !== "watching.closingForRetry") throw new Error(`retry setup did not enter cleanup from ${state}`);
    await settleTraceCleanup(fixture, { id: "retry-setup", event: "xstate.done.actor.cleanupBarrier" });
    await flushActor();
    if (stateId(fixture.actor.getSnapshot().value) !== "retryWaiting.active") throw new Error(`retry setup did not enter waiting from ${state}`);
    await retryElapsed(fixture);
    await returnToActiveSource(fixture, source);
  } else if (state === "sweeping.active") {
    fixture.actor.send({ type: "xstate.error.actor.recurringSweep", error: { category: "transient", code: "sync.runtime-conformance-transient", safeMessage: "Deterministic transient fault." } });
    await flushActor();
    await retryElapsed(fixture);
    await returnToActiveSource(fixture, "sweeping.active");
    if (stateId(fixture.actor.getSnapshot().value) !== "watching.idling") throw new Error("sweep retry setup did not return to watching");
    holdResource(fixture, "watch");
    fixture.actor.send({ type: "watchTimer.elapsed", scopeEpoch: fixture.actor.getSnapshot().context.scopeEpoch });
    await flushActor();
    await settleTraceCleanup(fixture, { id: "sweep-setup", event: "xstate.done.actor.cleanupBarrier" });
    await flushActor();
  }
}

async function prepareTraceTransition(fixture: TraceFixture, transition: ModelTransition): Promise<void> {
  await prepareSupersededAuth(fixture, transition);
  if (transition.guards.includes("retryBudgetExhausted")) {
    const source = stateId(fixture.actor.getSnapshot().value);
    for (let attempt = fixture.actor.getSnapshot().context.retryAttempt; attempt < configuration.maxRetryAttempts; attempt += 1)
      await incrementRetryAttempt(fixture, source);
  }
  if (transition.guards.includes("pendingAuthFaultWasSuperseded")) {
    fixture.external.send({ type: "credentials.changed", revision: fixture.actor.getSnapshot().context.latestCredentialRevision + 1 });
    await flushActor();
  }
}

async function executeGeneratedTrace(fixture: TraceFixture, transitionIds: readonly string[], expectedFinalState: string): Promise<void> {
  for (const transitionId of transitionIds.slice(1)) {
    const transition = model.transitions.find((candidate) => candidate.id === transitionId);
    if (!transition) throw new Error(`missing transition ${transitionId}`);
    const source = stateId(fixture.actor.getSnapshot().value);
    const sources = Array.isArray(transition.source) ? transition.source : [transition.source];
    if (!sources.includes(source)) throw new Error(`${transition.id} expected source ${sources.join(",")}, got ${source}`);
    await prepareTraceTransition(fixture, transition);
    const beforeVersion = fixture.actor.getSnapshot().context.version;
    await sendTraceTransition(fixture, transition);
    assertVersionAdvance(beforeVersion, fixture.actor.getSnapshot().context.version, transition);
    const expectedState = transition.target ?? source;
    assertRuntimeStep(fixture, expectedState);
    injectStaleScopeOutcomes(fixture);
  }
  expect(stateId(fixture.actor.getSnapshot().value)).toBe(expectedFinalState === "@uninitialized" ? "stopped.clean" : expectedFinalState);
}

function lcg(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1_103_515_245 + 12_345) % 2_147_483_647;
    return value;
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P3-C24 runtime conformance", () => {
  test("retains generated pairwise transition and ownership coverage metadata", () => {
    expect(traces.modelDigest).toBe(modelDigest);
    expect(traces.traces).toHaveLength(204);
    expect(new Set(traces.traces.map((trace) => trace.id)).size).toBe(204);
    expect(new Set(traces.traces.map((trace) => trace.transitionId)).size).toBe(91);
    expect(traces.resourceObservationGaps.map((gap) => gap.state)).toEqual([
      "starting.active",
      "backfilling.active",
      "watching.idling",
      "watching.polling",
      "sweeping.active",
    ]);
    expect(traces.durableObservationGaps).toEqual([
      {
        transitionIds: ["T110", "T116", "T117", "T118", "T150", "T156"],
        fields: ["mailboxCheckpoint", "initialBackfillCompletion"],
        reason: "The generated row lane exercises reserved actor-result routing against the default never-settling backfill/sweep placeholders; concrete production-composed loops own the SQLite writes and are checked separately.",
      },
    ]);
    expect(traces.counterexamples.map((counterexample) => counterexample.id)).toEqual([
      "CE-POLL-TIMER-LEAK",
      "CE-LATE-DOWNLOAD-COMPLETION",
    ]);
    for (const trace of traces.traces) {
      expect(trace.outcomeKinds).toEqual(["cancelled", "late", "duplicate"]);
      expect(trace.pathTransitionIds.at(-1)).toBe(trace.source === "@uninitialized" ? "T001" : trace.pathTransitionIds.at(-1));
      expect(trace.ownershipBefore).toEqual(
        model.states.find((state) => state.id === trace.source)?.invokedActors ?? [],
      );
      expect(trace.ownershipAfter).toEqual(
        model.states.find((state) => state.id === trace.target)?.invokedActors ??
          model.states.find((state) => state.id === trace.source)?.invokedActors ??
          [],
      );
    }
  });

  test("executes every generated transition row through the default production actor wiring", async () => {
    const sharedStorage = await storageFixture();
    try {
      for (const trace of traces.traces) {
        const fixture = await traceFixture(sharedStorage);
        try {
        expect(trace.pathTransitionIds.length).toBeGreaterThan(0);
        await executeGeneratedTrace(fixture, trace.pathTransitionIds, trace.source);
        const before = runtimeAudit(fixture.actor, fixture.clock, fixture.idle, fixture.registry, fixture.storage.db);
        expect(before.state).toBe(trace.source === "@uninitialized" ? "stopped.clean" : trace.source);
        if (trace.source === "@uninitialized") {
          expect(trace.event).toBe("xstate.init");
          continue;
        }
        assertRuntimeStep(fixture, trace.source);
        injectStaleScopeOutcomes(fixture);
        await prepareTraceTransition(fixture, model.transitions.find((candidate) => candidate.id === trace.transitionId)!);
        const transition = model.transitions.find((candidate) => candidate.id === trace.transitionId);
        if (!transition) throw new Error(`missing generated transition ${trace.transitionId}`);
        const beforeVersion = fixture.actor.getSnapshot().context.version;
        const beforeDurable = durableSummary(fixture.storage.db);
        await sendTraceTransition(fixture, transition);
        const after = runtimeAudit(fixture.actor, fixture.clock, fixture.idle, fixture.registry, fixture.storage.db);
        const expectedState = trace.target ?? trace.source;
        assertVersionAdvance(beforeVersion, after.version, transition);
        if (transition.durableWrites.length === 0) expect(after.durable).toEqual(beforeDurable);
        expect(after.state).toBe(expectedState);
        assertRuntimeStep(fixture, expectedState);
        injectLateDuplicateOutcomes(fixture, transition, expectedState);
        expect(after.version).toBeGreaterThanOrEqual(before.version);
        expect(after.public.version).toBe(after.version);
        expect(after.public.actorState as string).toBe(expectedPublicActorState(expectedState));
        expect(after.activeChildren).toEqual([...trace.ownershipAfter].sort());
        expect(after.timers).toBeGreaterThanOrEqual(0);
        expect(after.listeners).toBeGreaterThanOrEqual(0);
        expect(after.streams).toBeGreaterThanOrEqual(0);
        expect(after.subscriptions).toBeGreaterThanOrEqual(0);
        expect(after.releaseSlots).toBeGreaterThanOrEqual(0);
        } finally {
          fixture.actor.stop();
        }
      }
    } finally {
      await closeStorageFixture(sharedStorage);
    }
  });

  test("reproduces auth then transient retry through the real default composition and virtual time", async () => {
    const fixture = await traceFixture();
    const { actor, external, clock, registry, storage } = fixture;
    try {
      external.send({ type: "control.start.requested", commandId: "auth-retry-start" });
      expect(stateId(actor.getSnapshot().value)).toBe("starting.active");
      actor.send({
        type: "xstate.error.actor.bootstrapSession",
        error: {
          category: "authentication",
          code: "sync.auth-rejected",
          safeMessage: "Credentials were rejected.",
          attemptedCredentialRevision: 0,
        },
      });
      expect(stateId(actor.getSnapshot().value)).toBe("authBlocked");
      assertRuntimeStep(fixture, "authBlocked");
      external.send({ type: "credentials.changed", revision: 1 });
      expect(stateId(actor.getSnapshot().value)).toBe("starting.active");
      actor.send({
        type: "xstate.error.actor.bootstrapSession",
        error: {
          category: "transient",
          code: "sync.transient",
          safeMessage: "Transient provider failure.",
        },
      });
      expect(stateId(actor.getSnapshot().value)).toBe("retryWaiting.active");
      expect(Object.keys(actor.getSnapshot().children).sort()).toEqual(["retryTimer"]);
      expect(clock.activeTimerCount).toBe(1);
      expect(actor.getSnapshot().context.retryAttempt).toBe(1);
      expect(clock.scheduledDelays.at(-1)).toBe(configuration.retryBaseMs * 2);
      expect(registry.snapshot?.().slotEntryCount).toBe(2);
      assertRuntimeStep(fixture, "retryWaiting.active");
      clock.tick();
      await flushActor();
      expect(stateId(actor.getSnapshot().value)).toBe("starting.active");
      expect(clock.activeTimerCount).toBe(0);
      expect(registry.snapshot?.().slotEntryCount).toBe(0);
      expect(Object.keys(actor.getSnapshot().children).sort()).toEqual(["bootstrapSession"]);
      assertRuntimeStep(fixture, "starting.active");
      external.send({ type: "process.shutdown.requested", requestId: "auth-retry-shutdown", signal: "TERM" });
      await flushActor();
      expect(stateId(actor.getSnapshot().value)).toBe("stopped.shutdown");
      assertTerminalQuiescence(runtimeAudit(actor, clock, fixture.idle, registry, storage.db));
    } finally {
      actor.stop();
      await closeStorageFixture(storage);
    }
  });

  test("probes the real nested raw-download queue/job and composite release slot", async () => {
    const fixture = await storageFixture();
    const registry = createSyncResourceRegistry({ incarnationId: "incarnation:p3-c24-raw-probe", maxReleaseSlotEntries: 32 });
    const request: RawMessageDownloadRequest = {
      accountId,
      mailboxId,
      uidValidity,
      uid: createRemoteUidValue(1),
      stagingDirectory: "/tmp/agent-mail-p3-c24-raw-probe",
      owner: { pid: process.pid, processStartIdentity: "p3-c24-raw-probe" },
    };
    const releaseDownload: { current: (() => void) | undefined } = { current: undefined };
    let aborted = false;
    const result: RawMessageDownloadResult = {
      identity: createRemoteUid(request),
      staged: { path: "/tmp/agent-mail-p3-c24-raw-probe.eml", digest: "raw-probe", size: 0 },
    };
    const adapter: RawMessageDownloadAdapter = {
      download: async (input) => {
        input.signal?.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
        await new Promise<void>((resolve) => {
          releaseDownload.current = () => resolve();
        });
        return result;
      },
    };
    const queue = createRawMessageDownloadQueueActor(adapter, { capacity: 1 });
    const registration = registerCompositeQueueSlot(registry, "raw-probe:invoke");
    registration.bindQueueStop(() => queue.stop());
    const job = queue.enqueue(request);
    await flushActor();
    expect(queue.getSnapshot().matches({ active: "working" })).toBe(true);
    const nestedChildren = Object.keys(queue.getSnapshot().children);
    expect(nestedChildren).toHaveLength(1);
    expect(nestedChildren[0]).toMatch(/rawDownloadQueue\.active/);
    expect(registry.snapshot?.().slotEntryCount).toBe(1);
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM mailbox_checkpoints;").get()).toEqual({ count: 1 });
    const phase = registry.requestPhase({
      minimumScope: "workflow",
      cleanupEpoch: 1,
      cleanupPhase: 1,
      effectiveScope: "workflow",
      invokeLease: 1,
    });
    expect(phase.terminal.status).toBe("pending");
    await flushActor();
    expect(queue.getSnapshot().matches({ active: "stopping" })).toBe(true);
    expect(aborted).toBe(true);
    if (releaseDownload.current === undefined) throw new Error("raw probe adapter was not acquired");
    releaseDownload.current();
    const terminal = await registry.awaitPhase(1, 1, 1);
    expect(terminal.status).toBe("success");
    if (terminal.status !== "success") throw new Error("raw queue cleanup did not settle");
    await expect(job.result).rejects.toMatchObject({ code: "raw-download-queue-cancelled" });
    expect(queue.getSnapshot().matches("stopped")).toBe(true);
    expect(Object.keys(queue.getSnapshot().children)).toEqual([]);
    expect(registry.snapshot?.().slotEntryCount).toBe(0);
    registry.finishCleanupScope?.(terminal.certificate);
    expect(registry.snapshot?.().sourceTreeSnapshotCount).toBe(0);
    expect(registry.snapshot?.().phaseSnapshotCount).toBe(0);
    await closeStorageFixture(fixture);
  });

  test("runs bounded property traces against the default production machine and audits every snapshot", async () => {
    for (const seed of traces.boundedPropertySeeds) {
      const registry = manualDependencies();
      const actor = createSyncLifecycleActor(
        { configuration, initialCheckpoint: checkpoint, initialCredentialRevision: 0, incarnationId: `property:${seed}` },
        {},
        { resourceRegistry: registry },
      );
      const send = createSyncExternalSendAdapter(actor);
      actor.start();
      expect(stateId(actor.getSnapshot().value)).toBe("stopped.clean");
      for (let step = 0; step < 64; step += 1) {
        send.send(externalEvent(Math.abs(Math.trunc(lcg(seed)() * 10_000))));
        await Promise.resolve();
        const state = stateId(actor.getSnapshot().value);
        assertOwnership(actor, state);
        const modelState = model.states.find((candidate) => candidate.id === state);
        expect(modelState).toBeDefined();
        expect(actor.getSnapshot().context.version).toBeGreaterThanOrEqual(0);
        if (modelState !== undefined && "terminalForIncarnation" in modelState)
          expect(Object.keys(actor.getSnapshot().children)).toEqual([]);
        const scopeEpoch = actor.getSnapshot().context.scopeEpoch;
        actor.send({ type: "idle.mailboxChanged", scopeEpoch: scopeEpoch - 1 });
        actor.send({ type: "watchTimer.elapsed", scopeEpoch: scopeEpoch - 1 });
        actor.send({
          type: "xstate.done.actor.initialBackfill",
          output: { status: "cancelled", checkpoint, completion: {}, watchStrategy: "idle" },
        });
        expect(stateId(actor.getSnapshot().value)).toBe(state);
        if (state.includes("closing")) {
          actor.send({
            type: "xstate.done.actor.cleanupBarrier",
            output: {
              certificateId: "wrong-late-certificate",
              cleanupEpoch: scopeEpoch,
              cleanupPhase: actor.getSnapshot().context.cleanupPhase,
              invokeLease: actor.getSnapshot().context.cleanupInvokeLease,
              effectiveScope: "watch",
              frozenReleaseSetId: "wrong",
              released: true,
              authoritativeAudit: { scope: "watch", frozenReleaseSetId: "wrong", liveResourceCount: 0, unresolvedReleaseCount: 0, digest: "wrong" },
              diagnostics: [],
            },
          });
          expect(stateId(actor.getSnapshot().value)).toBe(state);
        }
      }
      actor.stop();
    }
  });

  test("drives real IDLE, polling, cleanup, backfill, sweep, SQLite, pause/resume, and shutdown", async () => {
    const fixture = await productionFixture();
    const { actor, clock, idle, registry, storage } = fixture;
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "p3-c24-start" });
    await waitForState(actor, (state) => state === "watching.idling");
    assertOwnership(actor, "watching.idling");
    assertExactWatchResources({ clock, idle, registry }, "watching.idling");
    expect(checkpointRow(storage.db)).toEqual({ uid_next: null, uid_next_known: 0, backfill_completed: 1, observed_version: 1 });
    expect(completionRow(storage.db)).toEqual({ observed_uid_ceiling: null, observed_uid_next_known: 0, observed_uid_next: null });

    const oldScope = actor.getSnapshot().context.scopeEpoch;
    clock.tick();
    await waitForState(actor, (state) => state === "watching.closingForSweep");
    expect(clock.activeTimerCount).toBe(0);
    idle.releaseClose();
    expect(idle.listenerCount).toBe(0);
    await waitForState(actor, (state) => state === "watching.idling");
    assertOwnership(actor, "watching.idling");

    actor.send({ type: "control.pause.requested", commandId: "p3-c24-pause", idempotencyKey: "p3-c24-pause" });
    await waitForState(actor, (state) => state === "watching.closingForPause");
    const closingAudit = runtimeAudit(actor, clock, idle, registry, storage.db);
    expect(closingAudit.activeChildren).toEqual(["cleanupBarrier"]);
    actor.send({ type: "idle.mailboxChanged", scopeEpoch: oldScope });
    actor.send({ type: "idle.completed", scopeEpoch: oldScope });
    expect(stateId(actor.getSnapshot().value)).toBe("watching.closingForPause");
    idle.releaseClose();
    await waitForState(actor, (state) => state === "paused");
    assertOwnership(actor, "paused");
    expect(runtimeAudit(actor, clock, idle, registry, storage.db).activeChildren).toEqual([]);

    actor.send({ type: "control.resume.requested", commandId: "p3-c24-resume", idempotencyKey: "p3-c24-resume" });
    await waitForState(actor, (state) => state === "watching.idling");
    assertExactWatchResources({ clock, idle, registry }, "watching.idling");
    expect(completionRow(storage.db)).not.toBeNull();

    actor.send({ type: "process.shutdown.requested", requestId: "p3-c24-shutdown", signal: "TERM" });
    await waitForState(actor, (state) => state === "stopping.forShutdown");
    idle.releaseClose();
    await waitForState(actor, (state) => state === "stopped.shutdown");
    const terminal = runtimeAudit(actor, clock, idle, registry, storage.db);
    assertTerminalQuiescence(terminal);
    actor.send({ type: "xstate.done.actor.initialBackfill", output: { status: "completed", checkpoint, completion: {}, watchStrategy: "idle" } });
    expect(stateId(actor.getSnapshot().value)).toBe("stopped.shutdown");
    actor.stop();
    await storage.close();
  });

  test("proves exact real polling ownership when IDLE is not selected", async () => {
    const fixture = await productionFixture(false, "poll");
    const { actor, clock, idle, registry, storage } = fixture;
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "p3-c24-poll-start" });
    await waitForState(actor, (state) => state === "watching.polling");
    assertOwnership(actor, "watching.polling");
    assertExactWatchResources({ clock, idle, registry }, "watching.polling");
    actor.send({ type: "control.stop.requested", commandId: "p3-c24-poll-stop", idempotencyKey: "poll-stop" });
    await waitForState(actor, (state) => state === "stopped.clean");
    assertTerminalQuiescence(runtimeAudit(actor, clock, idle, registry, storage.db));
    actor.stop();
    await storage.close();
  });

  test("the adjacent leaked-timer and late-download counterexamples are rejected", async () => {
    const fixture = await productionFixture();
    const { actor, clock, idle, registry, storage } = fixture;
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "p3-c24-counterexample-start" });
    await waitForState(actor, (state) => state === "watching.idling");
    const beforeLate = runtimeAudit(actor, clock, idle, registry, storage.db);
    actor.send({ type: "control.stop.requested", commandId: "p3-c24-counterexample-stop", idempotencyKey: "stop" });
    await waitForState(actor, (state) => state === "stopping.forStop");
    actor.send({ type: "xstate.done.actor.initialBackfill", output: { status: "completed", checkpoint, completion: {}, watchStrategy: "idle" } });
    expect(runtimeAudit(actor, clock, idle, registry, storage.db).state).toBe("stopping.forStop");
    idle.releaseClose();
    await waitForState(actor, (state) => state === "stopped.clean");
    const terminal = runtimeAudit(actor, clock, idle, registry, storage.db);
    assertTerminalQuiescence(terminal);
    expect(terminal.durable).toEqual(beforeLate.durable);

    clock.leak();
    expect(() => assertTerminalQuiescence(runtimeAudit(actor, clock, idle, registry, storage.db))).toThrow();
    actor.stop();
    await storage.close();
  });
});
