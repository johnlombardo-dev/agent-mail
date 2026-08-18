import { describe, expect, test } from "bun:test";
import {
  messageResponseSchema,
  searchRequestSchema,
  searchResponseSchema,
  threadResponseSchema,
  type SearchResponse,
} from "@agent-mail/contracts";
import {
  createHttpApp,
  type HttpCredentialResolution,
  type RegisteredFeatureOutcome,
  RegisteredFeatureErrorException,
} from "../src/http";

const searchRoute = "/v1/messages/search";
const threadId = `thread:${"a".repeat(64)}`;
const messageId = "message:missing";

function auth(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: {
      subject: "operator",
      scopes: ["mail:read.search", "mail:read.thread", "mail:read.message"],
    },
  };
}

function jsonRequest(path: string, body: unknown, correlationId = "correlation:test"): Request {
  const method = path === searchRoute || path.startsWith("/v1/threads/") ? "POST" : "GET";
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-correlation-id": correlationId,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function searchError(
  code: "invalid_query" | "invalid_cursor",
  message: "invalid search query" | "search cursor is invalid",
): RegisteredFeatureOutcome {
  return {
    kind: "feature-error",
    error: { code, message, details: { resource: "search" } },
  };
}

function opaqueSearchCursor(): string {
  const envelope = JSON.stringify(["search-cursor-v1", "payload", "tampered-tag"]);
  let binary = "";
  for (const byte of new TextEncoder().encode(envelope)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function opaqueThreadCursor(): string {
  const payload = JSON.stringify({
    registryVersion: 1,
    cursorKeyId: "active-key",
    accountScopeDigest: "b".repeat(64),
    requestedThreadHandle: threadId,
    lastSentAtMissingRank: 0,
    lastSentAt: "2026-01-01T00:00:00Z",
    lastMessageId: `message:${"c".repeat(64)}`,
  });
  const envelope = JSON.stringify(["thread-cursor-v1", payload, "d".repeat(64)]);
  let binary = "";
  for (const byte of new TextEncoder().encode(envelope)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("retrieval feature errors at the HTTP boundary", () => {
  test("distinguishes malformed requests, invalid query grammar, and tampered search cursors", async () => {
    let invocations = 0;
    const app = createHttpApp({
      authenticate: auth,
      handlers: {
        "messages.search": (input) => {
          invocations += 1;
          const request = searchRequestSchema.parse(input);
          if (request.query.includes("OR")) return searchError("invalid_query", "invalid search query");
          if (request.cursor !== undefined)
            throw new RegisteredFeatureErrorException(
              searchError("invalid_cursor", "search cursor is invalid").error,
            );
          return { items: [], nextCursor: null } satisfies SearchResponse;
        },
      },
    });

    const malformed = await app.request(jsonRequest(searchRoute, { query: "alpha", extra: true }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_request", details: {} });
    expect(invocations).toBe(0);

    const invalidQuery = await app.request(jsonRequest(searchRoute, { query: "alpha OR beta" }));
    expect(invalidQuery.status).toBe(400);
    expect(await invalidQuery.json()).toEqual({
      code: "invalid_query",
      message: "invalid search query",
      correlationId: "correlation:test",
      details: { resource: "search" },
    });

    const invalidCursor = await app.request(
      jsonRequest(searchRoute, { query: "alpha", cursor: opaqueSearchCursor() }),
    );
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({
      code: "invalid_cursor",
      message: "search cursor is invalid",
      correlationId: "correlation:test",
      details: { resource: "search" },
    });
    expect(invocations).toBe(2);
  });

  test("projects thread cursor and not-found outcomes, while keeping auth pre-handler", async () => {
    const app = createHttpApp({
      authenticate: auth,
      handlers: {
        "threads.get": () =>
          new RegisteredFeatureErrorException({
            code: "invalid_cursor",
            message: "thread cursor is invalid",
            details: { resource: "thread" },
          }),
        "messages.get": () => ({
          code: "not_found",
          message: "message was not found",
          correlationId: "private-correlation",
          details: { resource: "message", id: messageId },
        }),
      },
    });

    const thread = await app.request(
      jsonRequest(`/v1/threads/${threadId}`, { threadId, cursor: opaqueThreadCursor() }),
    );
    expect(thread.status).toBe(400);
    expect(await thread.json()).toEqual({
      code: "invalid_cursor",
      message: "thread cursor is invalid",
      correlationId: "correlation:test",
      details: { resource: "thread" },
    });

    const message = await app.request(
      jsonRequest(`/v1/messages/${messageId}`, { messageId }, "correlation:message"),
    );
    expect(message.status).toBe(404);
    expect(await message.json()).toEqual({
      code: "not_found",
      message: "message was not found",
      correlationId: "correlation:message",
      details: { resource: "message", id: messageId },
    });

    const missingIdentity = await app.request(
      new Request(`http://localhost${searchRoute}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "alpha" }),
      }),
    );
    expect(missingIdentity.status).toBe(401);
    expect(await missingIdentity.json()).toMatchObject({ code: "missing_credentials" });
  });

  test("redacts private handler failures and keeps details out of the public body", async () => {
    const app = createHttpApp({
      authenticate: auth,
      handlers: {
        "messages.search": () => {
          throw new Error("private storage failure", {
            cause: { sql: "secret", password: "secret-password" },
          });
        },
      },
    });

    const response = await app.request(jsonRequest(searchRoute, { query: "alpha" }));
    const body: unknown = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: "internal_error",
      message: "internal server error",
      correlationId: "correlation:test",
      details: {},
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  test("requires exact operation registration and never classifies incidental or unknown codes", async () => {
    const app = createHttpApp({
      authenticate: auth,
      handlers: {
        "messages.search": () => ({
          code: "not_found",
          message: "ordinary success metadata",
          details: { resource: "search" },
          items: [],
          nextCursor: null,
        }),
        "messages.get": () => ({
          code: "invalid_cursor",
          message: "search cursor is invalid",
          details: { resource: "search" },
        }),
      },
    });

    const incidental = await app.request(jsonRequest(searchRoute, { query: "alpha" }));
    expect(incidental.status).toBe(500);
    expect(await incidental.json()).toMatchObject({ code: "internal_error", details: {} });

    const unregistered = await app.request(
      jsonRequest(`/v1/messages/${messageId}`, { messageId }),
    );
    expect(unregistered.status).toBe(500);
    expect(await unregistered.json()).toMatchObject({ code: "internal_error", details: {} });
  });

  test("keeps the operation response unions strict", () => {
    expect(searchResponseSchema.safeParse({ code: "invalid_cursor", details: {} }).success).toBe(false);
    expect(threadResponseSchema.safeParse({ code: "invalid_cursor", message: "thread cursor is invalid", correlationId: "c", details: { resource: "thread", sql: "secret" } }).success).toBe(false);
    expect(messageResponseSchema.safeParse({ code: "not_found", message: "message was not found", correlationId: "c", details: { resource: "message", id: "thread:wrong" } }).success).toBe(false);
  });
});
