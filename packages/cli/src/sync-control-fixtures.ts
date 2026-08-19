import type { SyncControlCommandName } from "./sync-control";

export type SyncControlSuccessFixture = Readonly<{
  readonly command: SyncControlCommandName;
  readonly request: Readonly<Record<string, unknown>>;
  readonly response: Readonly<Record<string, unknown>>;
}>;

const identity = "incarnation:fixture";

/** Shared composed fixtures use only the public actor-observed response fields. */
export const syncControlSuccessFixtures: readonly SyncControlSuccessFixture[] = Object.freeze([
  {
    command: "start",
    request: {},
    response: {
      accepted: true,
      commandId: "command:start",
      observed: { actorState: "starting", incarnationId: identity, version: 1 },
    },
  },
  {
    command: "pause",
    request: { idempotencyKey: "idempotency:pause" },
    response: {
      accepted: true,
      commandId: "command:pause",
      completed: true,
      observed: { actorState: "paused", incarnationId: identity, version: 2 },
    },
  },
  {
    command: "resume",
    request: { idempotencyKey: "idempotency:resume" },
    response: {
      accepted: true,
      commandId: "command:resume",
      completed: true,
      observed: { actorState: "watching", incarnationId: identity, version: 3 },
    },
  },
  {
    command: "stop",
    request: { idempotencyKey: "idempotency:stop" },
    response: {
      accepted: true,
      commandId: "command:stop",
      completed: true,
      observed: { actorState: "stopped", incarnationId: identity, version: 4 },
    },
  },
]);

export type SyncControlErrorFixture = Readonly<{
  readonly name:
    | "rejected"
    | "conflict"
    | "failure"
    | "cancelled"
    | "authBlocked"
    | "timeout"
    | "capacity";
  readonly code: string;
  readonly reason: string;
  readonly semanticKind: "conflict" | "internal" | "cancelled" | "authorization" | "temporary";
  readonly command: SyncControlCommandName;
  readonly response: Readonly<Record<string, unknown>>;
}>;

const errorBase = {
  commandId: "command:error",
  actorState: "watching",
  version: 7,
  incarnationId: identity,
};

export const syncControlErrorFixtures: readonly SyncControlErrorFixture[] = Object.freeze([
  {
    name: "rejected",
    code: "sync.control-rejected",
    reason: "incompatible-state",
    semanticKind: "conflict",
    command: "start",
    response: { ...errorBase, command: "start", reason: "incompatible-state" },
  },
  {
    name: "conflict",
    code: "sync.control-idempotency-conflict",
    reason: "key-reused-with-different-fingerprint",
    semanticKind: "conflict",
    command: "pause",
    response: {
      ...errorBase,
      command: "pause",
      reason: "key-reused-with-different-fingerprint",
      idempotencyKey: "idempotency:conflict",
    },
  },
  {
    name: "failure",
    code: "sync.control-failed",
    reason: "terminal-failure",
    semanticKind: "internal",
    command: "resume",
    response: { ...errorBase, command: "resume", reason: "terminal-failure" },
  },
  {
    name: "authBlocked",
    code: "sync.control-failed",
    reason: "auth-blocked",
    semanticKind: "authorization",
    command: "start",
    response: { ...errorBase, command: "start", actorState: "authBlocked", reason: "auth-blocked" },
  },
  {
    name: "cancelled",
    code: "sync.control-cancelled",
    reason: "superseded-by-stop",
    semanticKind: "cancelled",
    command: "pause",
    response: { ...errorBase, command: "pause", reason: "superseded-by-stop" },
  },
  {
    name: "timeout",
    code: "sync.control-timeout",
    reason: "deadline-elapsed",
    semanticKind: "temporary",
    command: "pause",
    response: { ...errorBase, command: "pause", reason: "deadline-elapsed", deadlineMs: 30_000 },
  },
  {
    name: "capacity",
    code: "sync.control-capacity",
    reason: "all-retained-entries-in-flight",
    semanticKind: "temporary",
    command: "stop",
    response: {
      ...errorBase,
      command: "stop",
      reason: "all-retained-entries-in-flight",
      capacity: 4,
    },
  },
]);

export function errorEnvelope(fixture: SyncControlErrorFixture): Readonly<Record<string, unknown>> {
  return {
    code: fixture.code,
    message:
      fixture.code === "sync.control-rejected"
        ? "Sync control was rejected."
        : fixture.code === "sync.control-failed"
          ? "Sync control failed before completion."
          : fixture.code === "sync.control-cancelled"
            ? "Sync control was superseded."
            : fixture.code === "sync.control-timeout"
              ? "Sync control did not complete before the deadline."
              : fixture.code === "sync.control-idempotency-conflict"
                ? "Sync control idempotency key conflicts with an earlier request."
                : "Sync control idempotency capacity is exhausted.",
    correlationId: "request:fixture",
    details: fixture.response,
  };
}
