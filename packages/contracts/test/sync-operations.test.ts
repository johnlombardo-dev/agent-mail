import { describe, expect, it } from "bun:test";
import {
  compareSyncObservations,
  resolvePendingSyncControl,
  type SyncControlErrorResponse,
  type SyncStatusResponse,
  syncControlErrorRegistry,
  syncOperationDefinitions,
  syncPauseRequestSchema,
  syncPauseResponseSchema,
  syncPendingControlResolverTable,
  syncResumeRequestSchema,
  syncResumeResponseSchema,
  syncStartRequestSchema,
  syncStartResponseSchema,
  syncStatusRequestSchema,
  syncStatusResponseSchema,
  syncStopRequestSchema,
  syncStopResponseSchema,
} from "../src/sync-operations";

const incarnationId = "incarnation:2026-08-18:01";
const checkpoint = {
  completedMailboxes: 2,
  totalMailboxes: 4,
  completedMessages: 120,
  pendingMessages: 8,
  lastMailbox: "INBOX",
  lastUid: 904,
};
const diagnostics = [{ code: "mailbox-slow", message: "mailbox is responding slowly" }];

const watchingStatus = {
  actorState: "watching",
  activeOperation: "watch",
  authBlocked: null,
  incarnationId,
  version: 12,
  checkpoint,
  diagnostics,
} satisfies SyncStatusResponse;
const authBlockedStatus = {
  actorState: "authBlocked",
  activeOperation: null,
  authBlocked: { reason: "credentials-invalid", detail: "provider rejected credentials" },
  incarnationId,
  version: 12,
  checkpoint,
  diagnostics,
} satisfies SyncStatusResponse;

const errorFixtures = [
  {
    code: "sync.control-rejected",
    message: "Sync control was rejected.",
    correlationId: "correlation:rejected",
    details: {
      commandId: "command:pause",
      command: "pause",
      actorState: "watching",
      version: 12,
      incarnationId,
      reason: "stale-version",
    },
  },
  {
    code: "sync.control-failed",
    message: "Sync control failed before completion.",
    correlationId: "correlation:failed",
    details: {
      commandId: "command:pause",
      command: "pause",
      actorState: "stopped",
      version: 13,
      incarnationId,
      reason: "terminal-failure",
    },
  },
  {
    code: "sync.control-cancelled",
    message: "Sync control was superseded.",
    correlationId: "correlation:cancelled",
    details: {
      commandId: "command:pause",
      command: "pause",
      actorState: "stopping",
      version: 14,
      incarnationId,
      reason: "superseded-by-stop",
    },
  },
  {
    code: "sync.control-timeout",
    message: "Sync control did not complete before the deadline.",
    correlationId: "correlation:timeout",
    details: {
      commandId: "command:pause",
      command: "pause",
      actorState: "backfilling",
      version: 15,
      incarnationId,
      reason: "deadline-elapsed",
      deadlineMs: 300_000,
    },
  },
  {
    code: "sync.control-idempotency-conflict",
    message: "Sync control idempotency key conflicts with an earlier request.",
    correlationId: "correlation:conflict",
    details: {
      commandId: "command:pause",
      command: "pause",
      actorState: "watching",
      version: 16,
      incarnationId,
      reason: "key-reused-with-different-fingerprint",
      idempotencyKey: "idempotency:pause",
    },
  },
  {
    code: "sync.control-capacity",
    message: "Sync control idempotency capacity is exhausted.",
    correlationId: "correlation:capacity",
    details: {
      commandId: "command:pause",
      command: "pause",
      actorState: "watching",
      version: 17,
      incarnationId,
      reason: "all-retained-entries-in-flight",
      capacity: 10_000,
    },
  },
] satisfies readonly SyncControlErrorResponse[];
const invalidIncarnationIds: readonly unknown[] = [
  undefined,
  "",
  " untrimmed",
  "x".repeat(257),
  "incarnation\ncontrol",
];

describe("sync operation contracts", () => {
  it("defines status and all four sync controls for registry integration", () => {
    expect(syncOperationDefinitions.map(({ key }) => key)).toEqual([
      "sync.status",
      "sync.start",
      "sync.pause",
      "sync.resume",
      "sync.stop",
    ]);
    expect(syncStatusRequestSchema.parse({})).toEqual({});
    expect(syncStartRequestSchema.parse({})).toEqual({});
    expect(syncPauseRequestSchema.parse({ idempotencyKey: "pause-1" })).toEqual({
      idempotencyKey: "pause-1",
    });
    expect(syncResumeRequestSchema.parse({ idempotencyKey: "resume-1" })).toEqual({
      idempotencyKey: "resume-1",
    });
    expect(syncStopRequestSchema.parse({ idempotencyKey: "stop-1" })).toEqual({
      idempotencyKey: "stop-1",
    });
  });

  it("requires a strict bounded incarnation identity on every status", () => {
    expect(syncStatusResponseSchema.parse(watchingStatus)).toEqual(watchingStatus);
    expect(syncStatusResponseSchema.parse(authBlockedStatus)).toEqual(authBlockedStatus);
    expect(() => syncStatusResponseSchema.parse({ ...watchingStatus, incarnationId: undefined })).toThrow();
    expect(() => syncStatusResponseSchema.parse({ ...watchingStatus, incarnationId: "" })).toThrow();
    expect(() => syncStatusResponseSchema.parse({ ...watchingStatus, incarnationId: " blank " })).toThrow();
    expect(() => syncStatusResponseSchema.parse({ ...watchingStatus, incarnationId: "x".repeat(257) })).toThrow();
    expect(() => syncStatusResponseSchema.parse({ ...watchingStatus, incarnationId: "incarnation\n2" })).toThrow();
    expect(() => syncStatusResponseSchema.parse({ ...watchingStatus, version: undefined })).toThrow();
    expect(() => syncStatusResponseSchema.parse({ ...authBlockedStatus, authBlocked: null })).toThrow();
    expect(() =>
      syncStatusResponseSchema.parse({ ...watchingStatus, authBlocked: authBlockedStatus.authBlocked }),
    ).toThrow();
    expect(() =>
      syncStatusResponseSchema.parse({ ...watchingStatus, diagnostics: Array(33).fill(diagnostics[0]) }),
    ).toThrow();
    expect(() => syncStatusResponseSchema.parse({ ...watchingStatus, activeOperation: "sweep" })).toThrow();
    expect(() =>
      syncStatusResponseSchema.parse({
        ...watchingStatus,
        diagnostics: [{ code: "auth", message: "Authorization: Bearer secret-value" }],
      }),
    ).toThrow();
  });

  it("orders only observations from the same incarnation", () => {
    const observation = { actorState: "watching", incarnationId, version: 8 };
    expect(compareSyncObservations(observation, { ...observation, version: 9 })).toBe("before");
    expect(compareSyncObservations(observation, observation)).toBe("equal");
    expect(compareSyncObservations({ ...observation, version: 10 }, observation)).toBe("after");
    expect(
      compareSyncObservations(observation, { ...observation, incarnationId: "incarnation:new", version: 0 }),
    ).toBe("unordered");
  });

  it("requires incarnation identity on every operation-specific success observation", () => {
    const completedPause = {
      accepted: true,
      commandId: "command-pause",
      completed: true,
      observed: { actorState: "paused", incarnationId, version: 13 },
    } as const;
    expect(syncPauseResponseSchema.parse(completedPause)).toEqual(completedPause);
    expect(() =>
      syncPauseResponseSchema.parse({ ...completedPause, observed: { actorState: "paused", version: 13 } }),
    ).toThrow();
    expect(() =>
      syncPauseResponseSchema.parse({
        accepted: true,
        commandId: "command-pause",
        observed: { actorState: "paused", incarnationId, version: 13 },
      }),
    ).toThrow();

    const completedStop = {
      accepted: true,
      commandId: "command-stop",
      completed: true,
      observed: { actorState: "stopped", incarnationId, version: 14 },
    } as const;
    expect(syncStopResponseSchema.parse(completedStop)).toEqual(completedStop);
    expect(() =>
      syncStopResponseSchema.parse({
        accepted: true,
        commandId: "command-stop",
        observed: { actorState: "stopping", incarnationId, version: 14 },
      }),
    ).toThrow();

    const acceptedStart = {
      accepted: true,
      commandId: "command-start",
      observed: { actorState: "starting", incarnationId, version: 15 },
    } as const;
    expect(syncStartResponseSchema.parse(acceptedStart)).toEqual(acceptedStart);
    expect(() =>
      syncStartResponseSchema.parse({
        ...acceptedStart,
        observed: { actorState: "watching", incarnationId, version: 15 },
      }),
    ).toThrow();
    expect(
      syncResumeResponseSchema.parse({
        accepted: true,
        commandId: "command-resume",
        completed: true,
        observed: { actorState: "watching", incarnationId, version: 21 },
      }),
    ).toBeTruthy();
  });

  it("requires idempotency for pause, resume, and stop", () => {
    expect(() => syncPauseRequestSchema.parse({})).toThrow();
    expect(() => syncResumeRequestSchema.parse({})).toThrow();
    expect(() => syncStopRequestSchema.parse({})).toThrow();
    expect(() => syncPauseRequestSchema.parse({ idempotencyKey: "" })).toThrow();
  });

  it("registers exactly six fixed-message strict non-success envelopes", () => {
    expect(syncControlErrorRegistry.codes).toEqual([
      "sync.control-rejected",
      "sync.control-failed",
      "sync.control-cancelled",
      "sync.control-timeout",
      "sync.control-idempotency-conflict",
      "sync.control-capacity",
    ]);
    expect(new Set(syncControlErrorRegistry.codes).size).toBe(6);
    for (const fixture of errorFixtures) {
      expect(syncControlErrorRegistry.parse(fixture)).toEqual(fixture);
      expect(syncPauseResponseSchema.parse(fixture)).toEqual(fixture);
      expect(() => syncControlErrorRegistry.parse({ ...fixture, message: "Different message" })).toThrow();
      expect(() =>
        syncControlErrorRegistry.parse({ ...fixture, details: { ...fixture.details, extra: true } }),
      ).toThrow();
      expect(() =>
        syncControlErrorRegistry.parse({ ...fixture, details: { ...fixture.details, token: "secret" } }),
      ).toThrow();
      for (const invalidIncarnationId of invalidIncarnationIds)
        expect(() =>
          syncControlErrorRegistry.parse({
            ...fixture,
            details: { ...fixture.details, incarnationId: invalidIncarnationId },
          }),
        ).toThrow();
    }
    expect(() =>
      syncStartResponseSchema.parse({
        ...errorFixtures[4],
        details: { ...errorFixtures[4]?.details, command: "start" },
      }),
    ).toThrow();
    expect(() =>
      syncStopResponseSchema.parse({
        ...errorFixtures[0],
        details: { ...errorFixtures[0]?.details, command: "pause" },
      }),
    ).toThrow();
  });

  it("freezes an exhaustive non-overlapping resolver table with one settlement per cell", () => {
    const expectedCounts = { start: 18, pause: 21, resume: 25, stop: 21 };
    const cellIds: string[] = [];
    const settlements = new Set<string>();

    for (const [command, table] of Object.entries(syncPendingControlResolverTable)) {
      const expectedCount =
        command === "start"
          ? expectedCounts.start
          : command === "pause"
            ? expectedCounts.pause
            : command === "resume"
              ? expectedCounts.resume
              : expectedCounts.stop;
      expect(Object.keys(table)).toHaveLength(expectedCount);
      for (const [ordering, directive] of Object.entries(table)) {
        cellIds.push(`${command}:${ordering}`);
        settlements.add(directive.settlement);
        expect(directive.waiter.length).toBeGreaterThan(0);
        expect(directive.idempotency.length).toBeGreaterThan(0);
        expect(directive.lastObservation.length).toBeGreaterThan(0);
        if (directive.settlement === "completed") {
          expect(directive.errorCode).toBeNull();
          expect(directive.reason).toBeNull();
        } else {
          expect(directive.errorCode).toStartWith("sync.control-");
          expect(directive.reason).toBeTruthy();
        }
      }
    }

    expect(cellIds).toHaveLength(85);
    expect(new Set(cellIds).size).toBe(85);
    expect([...settlements].sort()).toEqual([
      "cancelled",
      "capacity",
      "completed",
      "conflict",
      "failed",
      "rejected",
      "timeout",
    ]);
  });

  it("settles the consequential supersession, failure, reconstruction, and replay orderings exactly", () => {
    expect(resolvePendingSyncControl({ command: "stop", ordering: "superseded-by-shutdown" })).toMatchObject({
      settlement: "cancelled",
      errorCode: "sync.control-cancelled",
      reason: "superseded-by-shutdown",
    });
    expect(resolvePendingSyncControl({ command: "stop", ordering: "cleanup-failure" })).toMatchObject({
      settlement: "failed",
      errorCode: "sync.control-failed",
      reason: "terminal-failure",
    });
    expect(resolvePendingSyncControl({ command: "start", ordering: "auth-blocked" })).toMatchObject({
      settlement: "failed",
      reason: "auth-blocked",
    });
    expect(resolvePendingSyncControl({ command: "pause", ordering: "stale-version" })).toMatchObject({
      settlement: "rejected",
      reason: "stale-version",
      idempotency: "retain-byte-identical-result-until-fixed-expiry",
    });
    expect(resolvePendingSyncControl({ command: "resume", ordering: "process-reconstruction" })).toMatchObject({
      settlement: "cancelled",
      reason: "superseded-by-restart",
      idempotency: "discard-old-incarnation-map",
      lastObservation: "first-real-observation-from-new-incarnation",
    });
    expect(resolvePendingSyncControl({ command: "pause", ordering: "idempotency-replay-timeout" })).toMatchObject({
      settlement: "timeout",
      response: "cached-byte-identical-error",
      idempotency: "return-byte-identical-cached-result-without-extending-expiry",
      waiter: "no-waiter-or-deadline-created",
    });
    expect(resolvePendingSyncControl({ command: "stop", ordering: "capacity-exhausted" })).toMatchObject({
      settlement: "capacity",
      idempotency: "no-entry-created",
      waiter: "no-waiter-or-deadline-created",
    });
  });
});
