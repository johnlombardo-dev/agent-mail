import { describe, expect, it } from "bun:test";
import {
  syncOperationDefinitions,
  syncPauseRequestSchema,
  syncPauseResponseSchema,
  syncResumeRequestSchema,
  syncResumeResponseSchema,
  syncStartRequestSchema,
  syncStartResponseSchema,
  syncStatusRequestSchema,
  syncStatusResponseSchema,
  syncStopRequestSchema,
  syncStopResponseSchema,
} from "../src/sync-operations";

const checkpoint = {
  completedMailboxes: 2,
  totalMailboxes: 4,
  completedMessages: 120,
  pendingMessages: 8,
  lastMailbox: "INBOX",
  lastUid: 904,
};

const diagnostics = [{ code: "mailbox-slow", message: "mailbox is responding slowly" }];

function status(actorState: "watching" | "authBlocked") {
  return actorState === "authBlocked"
    ? {
        actorState,
        activeOperation: null,
        version: 12,
        checkpoint,
        authBlocked: { reason: "credentials-invalid", detail: "provider rejected credentials" },
        diagnostics,
      }
    : {
        actorState,
        activeOperation: "watch",
        version: 12,
        checkpoint,
        authBlocked: null,
        diagnostics,
      };
}

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

  it("requires status fields and ties auth detail to authBlocked", () => {
    expect(syncStatusResponseSchema.parse(status("watching"))).toEqual(status("watching"));
    expect(syncStatusResponseSchema.parse(status("authBlocked"))).toEqual(status("authBlocked"));
    expect(() =>
      syncStatusResponseSchema.parse({ ...status("watching"), version: undefined }),
    ).toThrow();
    expect(() =>
      syncStatusResponseSchema.parse({ ...status("authBlocked"), authBlocked: null }),
    ).toThrow();
    expect(() =>
      syncStatusResponseSchema.parse({
        ...status("watching"),
        authBlocked: status("authBlocked").authBlocked,
      }),
    ).toThrow();
    expect(() =>
      syncStatusResponseSchema.parse({
        ...status("watching"),
        diagnostics: Array(33).fill(diagnostics[0]),
      }),
    ).toThrow();
    expect(() =>
      syncStatusResponseSchema.parse({ ...status("watching"), activeOperation: "sweep" }),
    ).toThrow();
    expect(() =>
      syncStatusResponseSchema.parse({
        ...status("watching"),
        diagnostics: [{ code: "auth", message: "Authorization: Bearer secret-value" }],
      }),
    ).toThrow();
  });

  it("keeps accepted command identity separate and requires observed version", () => {
    const response = {
      accepted: true,
      commandId: "command-1",
      observed: { actorState: "paused", version: 13 },
    };
    expect(syncPauseResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      syncPauseResponseSchema.parse({ ...response, observed: { actorState: "paused" } }),
    ).toThrow();
    expect(() => syncPauseResponseSchema.parse({ accepted: true })).toThrow();
    expect(() => syncPauseResponseSchema.parse({ ...response, commandId: undefined })).toThrow();
  });

  it("requires idempotency for pause, resume, and stop", () => {
    expect(() => syncPauseRequestSchema.parse({})).toThrow();
    expect(() => syncResumeRequestSchema.parse({})).toThrow();
    expect(() => syncStopRequestSchema.parse({})).toThrow();
    expect(() => syncPauseRequestSchema.parse({ idempotencyKey: "" })).toThrow();
  });

  it("rejects completed controls without observed versions or with incompatible states", () => {
    const completedStop = {
      accepted: true,
      commandId: "command-stop",
      completed: true,
      observed: { actorState: "stopped", version: 14 },
    };
    expect(syncStopResponseSchema.parse(completedStop)).toEqual(completedStop);
    expect(() =>
      syncStopResponseSchema.parse({ ...completedStop, observed: { actorState: "stopped" } }),
    ).toThrow();
    expect(() =>
      syncStopResponseSchema.parse({
        ...completedStop,
        observed: { actorState: "watching", version: 14 },
      }),
    ).toThrow();
    expect(() => syncStopResponseSchema.parse({ accepted: true })).toThrow();

    const completedStart = {
      accepted: true,
      commandId: "command-start",
      completed: true,
      observed: { actorState: "watching", version: 15 },
    };
    expect(syncStartResponseSchema.parse(completedStart)).toEqual(completedStart);
    expect(() =>
      syncStartResponseSchema.parse({
        ...completedStart,
        observed: { actorState: "stopped", version: 15 },
      }),
    ).toThrow();
  });

  it("keeps each operation response tied to its accepted actor state", () => {
    expect(
      syncResumeResponseSchema.parse({
        accepted: true,
        commandId: "command-resume",
        observed: { actorState: "backfilling", version: 21 },
      }),
    ).toBeTruthy();
    expect(() =>
      syncResumeResponseSchema.parse({
        accepted: true,
        commandId: "command-resume",
        observed: { actorState: "paused", version: 21 },
      }),
    ).toThrow();
    expect(() =>
      syncStopResponseSchema.parse({
        accepted: true,
        commandId: "command-stop",
        observed: { actorState: "watching", version: 21 },
      }),
    ).toThrow();
  });
});
