import { fromPromise } from "xstate";
import { describe, expect, test } from "bun:test";
import {
  syncPauseResponseSchema,
  syncResumeResponseSchema,
  syncStartResponseSchema,
  syncStatusResponseSchema,
  syncStopResponseSchema,
  type SyncStatusResponse,
} from "@agent-mail/contracts";
import {
  createHttpApp,
  type HttpCredentialResolution,
} from "../src/http";
import { createSyncHandlers } from "../src/sync-handlers";
import {
  createSyncControlDecisionChannel,
  createSyncControlService,
} from "../src/sync-control-service";
import {
  createSyncLifecycleActor,
  createSyncLifecycleDependencies,
  projectSyncStatus,
  type SyncLifecycleInput,
} from "../src/sync-statechart";

const checkpoint = {
  completedMailboxes: 0,
  totalMailboxes: 0,
  completedMessages: 0,
  pendingMessages: 0,
  lastMailbox: null,
  lastUid: null,
} as const;

const input = {
  configuration: {
    retryBaseMs: 1,
    retryCapMs: 1,
    retryJitterRatio: 0,
    maxRetryAttempts: 1,
    periodicStatusIntervalMs: 1_000,
    controlDeadlineMs: 25,
    controlResultRetentionMs: 1_000,
    maxControlIdempotencyEntries: 16,
    maxReleaseSlotEntries: 16,
  },
  initialCheckpoint: checkpoint,
  initialCredentialRevision: 0,
  incarnationId: "incarnation:http-147",
} as const satisfies SyncLifecycleInput;

const allScopes = [
  "sync:read.status",
  "sync:control.start",
  "sync:control.pause",
  "sync:control.resume",
  "sync:control.stop",
] as const;

function authenticate(credential: string): HttpCredentialResolution {
  if (credential === "valid") {
    return {
      kind: "authenticated",
      principal: { subject: "test-operator", scopes: allScopes },
    };
  }
  if (credential === "status-only") {
    return {
      kind: "authenticated",
      principal: { subject: "read-only", scopes: ["sync:read.status"] },
    };
  }
  return { kind: "invalid" };
}

async function waitForWatching(actor: ReturnType<typeof createSyncLifecycleActor>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (actor.getSnapshot().matches({ watching: "idling" })) return;
    await Bun.sleep(1);
  }
  throw new Error(`actor did not reach watching.idling: ${JSON.stringify(actor.getSnapshot().value)}`);
}

function jsonRequest(
  path: string,
  method: "GET" | "POST",
  body: unknown = undefined,
  token = "valid",
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-correlation-id": `http-147-${path.slice("/v1/sync/".length).replaceAll("/", "-")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function createFixture(cleanupBarrier = false) {
  const decisions = createSyncControlDecisionChannel();
  const dependencies = {
    ...createSyncLifecycleDependencies(input),
    controlDecisionSink: decisions.publish,
  };
  const actors = cleanupBarrier
    ? {
        bootstrapSession: fromPromise(async () => ({ next: "idle" as const, checkpoint })),
        cleanupBarrier: fromPromise(async () => new Promise<never>(() => undefined)),
      }
    : {
        bootstrapSession: fromPromise(async () => ({ next: "idle" as const, checkpoint })),
      };
  const actor = createSyncLifecycleActor(input, actors, dependencies);
  actor.start();
  const observations: SyncStatusResponse[] = [];
  actor.subscribe((snapshot) => observations.push(projectSyncStatus(snapshot)));
  const control = createSyncControlService({
    actor: {
      getSnapshot: () => actor.getSnapshot(),
      send: (event) => actor.send(event),
      subscribe: (listener) => actor.subscribe(listener),
    },
    decisions: decisions.source,
    controlDeadlineMs: input.configuration.controlDeadlineMs,
    controlResultRetentionMs: input.configuration.controlResultRetentionMs,
    maxControlIdempotencyEntries: input.configuration.maxControlIdempotencyEntries,
  });
  const app = createHttpApp({
    authenticate,
    handlers: createSyncHandlers({
      actor: { getSnapshot: () => actor.getSnapshot() },
      control,
    }),
  });
  return { actor, control, app, observations };
}

describe("P6-C03 direct Hono sync status/control", () => {
  test("returns status and every control result from the real actor snapshot/version", async () => {
    const fixture = createFixture();
    try {
      const initial = await fixture.app.request(jsonRequest("/v1/sync/status", "GET"));
      expect(initial.status).toBe(200);
      const initialBody = syncStatusResponseSchema.parse(await initial.json());
      expect(initialBody).toEqual(projectSyncStatus(fixture.actor.getSnapshot()));

      const start = await fixture.app.request(jsonRequest("/v1/sync/start", "POST", {}));
      expect(start.status).toBe(200);
      const startBody = syncStartResponseSchema.parse(await start.json());
      expect(startBody).toMatchObject({ accepted: true, observed: { actorState: "starting" } });
      if ("observed" in startBody)
        expect(
          fixture.observations.some(
            (observation) =>
              observation.actorState === startBody.observed.actorState &&
              observation.version === startBody.observed.version &&
              observation.incarnationId === startBody.observed.incarnationId,
          ),
        ).toBe(true);
      await waitForWatching(fixture.actor);

      const watchingStatus = await fixture.app.request(jsonRequest("/v1/sync/status", "GET"));
      const watchingBody: SyncStatusResponse = syncStatusResponseSchema.parse(await watchingStatus.json());
      expect(watchingBody).toEqual(projectSyncStatus(fixture.actor.getSnapshot()));

      const pause = await fixture.app.request(
        jsonRequest("/v1/sync/pause", "POST", { idempotencyKey: "http-147-pause" }),
      );
      expect(pause.status).toBe(200);
      const pauseBody = syncPauseResponseSchema.parse(await pause.json());
      expect(pauseBody).toMatchObject({ accepted: true, completed: true });
      expect(pauseBody.observed).toEqual({
        actorState: "paused",
        incarnationId: fixture.actor.getSnapshot().context.incarnationId,
        version: fixture.actor.getSnapshot().context.version,
      });

      const resume = await fixture.app.request(
        jsonRequest("/v1/sync/resume", "POST", { idempotencyKey: "http-147-resume" }),
      );
      expect(resume.status).toBe(200);
      const resumeBody = syncResumeResponseSchema.parse(await resume.json());
      expect(resumeBody).toMatchObject({ accepted: true, observed: { actorState: "starting" } });
      if ("observed" in resumeBody)
        expect(
          fixture.observations.some(
            (observation) =>
              observation.actorState === resumeBody.observed.actorState &&
              observation.version === resumeBody.observed.version &&
              observation.incarnationId === resumeBody.observed.incarnationId,
          ),
        ).toBe(true);
      await waitForWatching(fixture.actor);

      const stop = await fixture.app.request(
        jsonRequest("/v1/sync/stop", "POST", { idempotencyKey: "http-147-stop" }),
      );
      expect(stop.status).toBe(200);
      const stopBody = syncStopResponseSchema.parse(await stop.json());
      expect(stopBody).toMatchObject({ accepted: true, completed: true });
      expect(stopBody.observed).toEqual({
        actorState: "stopped",
        incarnationId: fixture.actor.getSnapshot().context.incarnationId,
        version: fixture.actor.getSnapshot().context.version,
      });
    } finally {
      fixture.control.close();
      fixture.actor.stop();
    }
  });

  test("returns timeout/non-success while real stop cleanup remains open", async () => {
    const fixture = createFixture(true);
    try {
      const start = await fixture.app.request(jsonRequest("/v1/sync/start", "POST", {}));
      expect(start.status).toBe(200);
      await waitForWatching(fixture.actor);

      const stop = await fixture.app.request(
        jsonRequest("/v1/sync/stop", "POST", { idempotencyKey: "http-147-delayed-stop" }),
      );
      expect(stop.status).not.toBe(200);
      const body: unknown = await stop.json();
      expect(body).toMatchObject({
        code: "sync.control-timeout",
        details: { actorState: "stopping", reason: "deadline-elapsed" },
      });
      expect(fixture.actor.getSnapshot().matches({ stopping: "forStop" })).toBe(true);
    } finally {
      fixture.control.close();
      fixture.actor.stop();
    }
  });

  test("rejects malformed/oversize/wrong-scope input before handler execution", async () => {
    const fixture = createFixture();
    try {
      const before = fixture.actor.getSnapshot().context.version;
      const malformed = await fixture.app.request(
        new Request("http://localhost/v1/sync/pause", {
          method: "POST",
          headers: { authorization: "Bearer valid", "content-type": "application/json" },
          body: "{bad",
        }),
      );
      expect(malformed.status).toBe(400);
      expect(fixture.actor.getSnapshot().context.version).toBe(before);

      const boundedApp = createHttpApp({
        authenticate,
        maxRequestBodyBytes: 8,
        handlers: createSyncHandlers({
          actor: { getSnapshot: () => fixture.actor.getSnapshot() },
          control: fixture.control,
        }),
      });
      const oversized = await boundedApp.request(
        jsonRequest("/v1/sync/pause", "POST", { idempotencyKey: "oversize" }),
      );
      expect(oversized.status).toBe(413);
      expect(fixture.actor.getSnapshot().context.version).toBe(before);

      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"idempotencyKey":"wrong-scope"}'));
          controller.close();
        },
      });
      const wrongScopeRequest = new Request("http://localhost/v1/sync/pause", {
        method: "POST",
        headers: { authorization: "Bearer status-only", "content-type": "application/json" },
        body,
      });
      const requestBody = wrongScopeRequest.body;
      if (requestBody === null) throw new Error("wrong-scope request lost its body");
      let readers = 0;
      const originalGetReader = requestBody.getReader.bind(requestBody);
      Object.defineProperty(requestBody, "getReader", {
        configurable: true,
        value: () => {
          readers += 1;
          return originalGetReader();
        },
      });
      const wrongScope = await fixture.app.request(wrongScopeRequest);
      expect(wrongScope.status).toBe(403);
      expect(readers).toBe(0);
      expect(fixture.actor.getSnapshot().context.version).toBe(before);
    } finally {
      fixture.control.close();
      fixture.actor.stop();
    }
  });
});
