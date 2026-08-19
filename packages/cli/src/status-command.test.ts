import { describe, expect, it } from "bun:test";
import { syncStatusResponseSchema, type SyncActorState } from "@agent-mail/contracts";
import { CliClientError, type CliResponse } from "./client";
import { runStatusCommand } from "./status-command";

const states: readonly SyncActorState[] = [
  "stopped",
  "starting",
  "backfilling",
  "watching",
  "sweeping",
  "retrying",
  "authBlocked",
  "paused",
  "stopping",
];

function status(actorState: SyncActorState, version = 7): unknown {
  const activeOperation =
    actorState === "starting"
      ? "start"
      : actorState === "backfilling"
        ? "backfill"
        : actorState === "watching"
          ? "watch"
          : actorState === "sweeping"
            ? "sweep"
            : actorState === "retrying"
              ? "retry"
              : actorState === "stopping"
                ? "stop"
                : null;
  return {
    actorState,
    activeOperation,
    authBlocked:
      actorState === "authBlocked"
        ? { reason: "provider-rejected", detail: "provider rejected the credentials" }
        : null,
    incarnationId: "incarnation:test",
    version,
    checkpoint: {
      completedMailboxes: 2,
      totalMailboxes: 3,
      completedMessages: 10,
      pendingMessages: 4,
      lastMailbox: "INBOX",
      lastUid: 42,
    },
    diagnostics: [{ code: "sync.note", message: "safe diagnostic" }],
  };
}

function clientFor(data: unknown, calls: { count: number; input?: unknown }) {
  return {
    async request(options: { readonly input: unknown; readonly operation: unknown }): Promise<CliResponse> {
      calls.count += 1;
      calls.input = options.input;
      return { kind: "success", operationKey: "sync.status", status: 200, data };
    },
  };
}

describe("sync status command adapter", () => {
  it("captures the empty shared request and preserves every actor-state response", async () => {
    for (const actorState of states) {
      const calls: { count: number; input?: unknown } = { count: 0 };
      const result = await runStatusCommand({
        argv: ["sync", "status"],
        client: clientFor(status(actorState), calls),
        correlationId: "cli:status-test",
      });
      const canonical = syncStatusResponseSchema.parse(status(actorState));
      expect(result).toMatchObject({ kind: "value", operationKey: "sync.status", semanticKind: actorState === "authBlocked" ? "attention" : "success", data: canonical });
      expect(calls).toEqual({ count: 1, input: {} });
    }
  });

  it("cannot print cached watching state for authBlocked at a newer version", async () => {
    const calls: { count: number; input?: unknown } = { count: 0 };
    const result = await runStatusCommand({
      argv: ["sync", "status"],
      client: clientFor(status("authBlocked", 12), calls),
      correlationId: "cli:status-test",
    });
    expect(result).toMatchObject({ kind: "value", semanticKind: "attention", data: { actorState: "authBlocked", version: 12 } });
    if (result.kind === "value") expect(result.humanLines.flat().map((segment) => segment.text).join(" ")).toContain("authBlocked");
  });

  it("rejects argv drift without making a request", async () => {
    const calls: { count: number; input?: unknown } = { count: 0 };
    const result = await runStatusCommand({
      argv: ["sync-status", "watching"],
      client: clientFor(status("watching"), calls),
      correlationId: "cli:status-test",
    });
    expect(result).toMatchObject({ kind: "failure", semanticKind: "usage" });
    expect(calls.count).toBe(0);
  });

  it("maps transport errors through the shared outcome authority", async () => {
    const result = await runStatusCommand({
      argv: ["sync", "status"],
      client: {
        async request(): Promise<CliResponse> {
          throw new CliClientError("control_timeout", "sync.status", "deadline");
        },
      },
      correlationId: "cli:status-test",
    });
    expect(result).toMatchObject({ kind: "failure", semanticKind: "temporary", operationKey: "sync.status" });
  });
});
