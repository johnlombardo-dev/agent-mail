import { describe, expect, test } from "bun:test";
import { fromCallback, fromPromise } from "xstate";
import { idleSessionActor } from "../../imap/src/idle-session";
import {
  createSyncLifecycleActor,
  type CleanupCertificate,
  type SyncActorInputs,
  type SyncCleanupPhaseSnapshot,
  type SyncCleanupPhaseTerminal,
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
  incarnationId: "incarnation:idle-test",
};

function certificateFor(
  value: Pick<SyncActorInputs, "cleanupEpoch" | "cleanupPhase" | "invokeLease"> & {
    readonly effectiveScope: "watch" | "workflow";
  },
): CleanupCertificate {
  return {
    certificateId: "certificate:idle-test",
    cleanupEpoch: value.cleanupEpoch,
    cleanupPhase: value.cleanupPhase,
    invokeLease: value.invokeLease,
    effectiveScope: value.effectiveScope,
    frozenReleaseSetId: "release-set:idle-test",
    released: true,
    authoritativeAudit: {
      scope: value.effectiveScope,
      frozenReleaseSetId: "release-set:idle-test",
      liveResourceCount: 0,
      unresolvedReleaseCount: 0,
      digest: "digest:idle-test",
    },
    diagnostics: [],
  };
}

function cleanupDependencies(): SyncLifecycleDependencies {
  let currentPhase: SyncCleanupPhaseSnapshot | null = null;
  return {
    resourceRegistry: {
      get currentPhase() {
        return currentPhase;
      },
      requestPhase: (request) => {
        const certificate = certificateFor(request);
        const terminal: SyncCleanupPhaseTerminal = { status: "success", certificate };
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
      awaitPhase: async () => currentPhase?.terminal ?? { status: "pending" },
    },
  };
}

function createComposedActor(dependencies: SyncLifecycleDependencies) {
  const bootstrapSession = fromPromise(async () => ({ next: "idle" as const, checkpoint }));
  // The signed chart currently supplies no production adapter. Keep this
  // acceptance fixture inert so manual sends exercise only chart guards and
  // transitions; the actual actor/input seam is asserted separately below.
  return createSyncLifecycleActor(
    input,
    { bootstrapSession, idleSession: fromCallback(() => undefined) },
    dependencies,
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("P3-C18 signed IDLE workflow composition", () => {
  test("accepts signed ready/change events and rejects manual late events after exit", async () => {
    const actor = createComposedActor(cleanupDependencies());
    let manualScopeEpoch: number | undefined;
    let beforeReadyVersion: number | undefined;
    let sent = false;
    actor.subscribe((snapshot) => {
      if (sent || !snapshot.matches({ watching: "idling" })) return;
      sent = true;
      manualScopeEpoch = snapshot.context.scopeEpoch;
      beforeReadyVersion = snapshot.context.version;
      actor.send({ type: "idle.ready", scopeEpoch: manualScopeEpoch });
      actor.send({ type: "idle.mailboxChanged", scopeEpoch: manualScopeEpoch });
    });
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "idle-start" });
    await settle();
    expect(manualScopeEpoch).toBeDefined();
    expect(beforeReadyVersion).toBeDefined();
    expect(actor.getSnapshot().matches({ watching: "closingForSweep" })).toBe(true);

    expect(actor.getSnapshot().context.idleReadyEpoch).toBe(manualScopeEpoch);
    expect(actor.getSnapshot().context.version).toBeGreaterThan(beforeReadyVersion!);
    const exited = JSON.stringify({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      children: Object.keys(actor.getSnapshot().children),
    });
    actor.send({ type: "idle.ready", scopeEpoch: manualScopeEpoch! });
    actor.send({ type: "idle.mailboxChanged", scopeEpoch: manualScopeEpoch! });
    expect(JSON.stringify({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      children: Object.keys(actor.getSnapshot().children),
    })).toBe(exited);
    actor.stop();
  });

  test("accepts signed auth failure and reaches authBlocked without retry", async () => {
    const dependencies = cleanupDependencies();
    const actor = createComposedActor(dependencies);
    let sent = false;
    actor.subscribe((snapshot) => {
      if (sent || !snapshot.matches({ watching: "idling" })) return;
      sent = true;
      actor.send({
        type: "idle.failed",
        scopeEpoch: snapshot.context.scopeEpoch,
        fault: {
          category: "authentication",
          code: "auth_required",
          safeMessage: "Credentials were rejected.",
          authReason: "provider-rejected",
          attemptedCredentialRevision: 0,
        },
      });
    });
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "auth-start" });
    await settle();
    expect(actor.getSnapshot().matches({ watching: "closingForAuthBlock" })).toBe(true);
    const phase = dependencies.resourceRegistry.currentPhase;
    if (phase === null || phase.terminal.status !== "success") throw new Error("missing watch cleanup phase");
    actor.send({ type: "xstate.done.actor.cleanupBarrier", output: phase.terminal.certificate });
    expect(actor.getSnapshot().matches("authBlocked")).toBe(true);
    expect(actor.getSnapshot().context.retryAttempt).toBe(0);
    expect(actor.getSnapshot().children).toEqual({});
    actor.stop();
  });

  test("actual IDLE actor reports missing adapter as a consumed transient failure", async () => {
    const actor = createSyncLifecycleActor(
      input,
      {
        bootstrapSession: fromPromise(async () => ({ next: "idle" as const, checkpoint })),
        idleSession: idleSessionActor,
      },
      cleanupDependencies(),
    );
    actor.start();
    actor.send({ type: "control.start.requested", commandId: "idle-invalid-adapter" });
    await settle();
    expect(actor.getSnapshot().matches({ watching: "closingForRetry" })).toBe(true);
    expect(actor.getSnapshot().context.retryAttempt).toBe(1);
    actor.stop();
  });
});
