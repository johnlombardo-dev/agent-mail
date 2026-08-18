import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createCliClient, type CliClient } from "../src/client";
import {
  createOperationRegistry,
  defineError,
  defineOperation,
} from "@agent-mail/contracts";

const requestSchema = z.strictObject({ id: z.string().min(1) });
const successSchema = z.strictObject({ ok: z.literal(true), id: z.string() });
const streamResponseSchema = z.unknown();
const errorDefinition = defineError({
  code: "fixture_failure",
  status: 409,
  message: "fixture failed",
  details: z.strictObject({ reason: z.literal("fixture") }),
});

const fixtureOperation = defineOperation({
  key: "fixture.read",
  route: "/v1/fixtures/{id}",
  method: "GET",
  cliName: "fixture-read",
  scope: "fixture:stream",
  request: requestSchema,
  response: successSchema,
  errors: [errorDefinition],
  streaming: "none",
  strictness: "strict",
});
const streamOperation = defineOperation({
  key: "fixture.stream",
  route: "/v1/fixtures/stream/{id}",
  method: "GET",
  cliName: "fixture-stream",
  scope: "fixture:read",
  request: requestSchema,
  response: streamResponseSchema,
  streaming: "bytes",
  strictness: "strict",
});
const registry = createOperationRegistry([fixtureOperation, streamOperation]);

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (client: CliClient, port: number) => Promise<void>,
  timeouts: Readonly<{ connectMs: number; controlMs: number; streamIdleMs: number }> = { connectMs: 100, controlMs: 100, streamIdleMs: 100 },
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
  try {
    const port = (address as AddressInfo).port;
    await run(
      createCliClient({
        baseUrl: `http://127.0.0.1:${port}`,
        registry,
        timeouts,
      }),
      port,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("CLI shared operation client", () => {
  it("serializes registry method/routes and validates a success response", async () => {
    await withServer((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/v1/fixtures/id%3Aone");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, id: "id:one" }));
    }, async (client) => {
      const result = await client.request({ operation: "fixture.read", input: { id: "id:one" } });
      expect(result).toEqual({ kind: "success", operationKey: "fixture.read", status: 200, data: { ok: true, id: "id:one" } });
    });
  });

  it("returns registered errors and rejects malformed success/error payloads", async () => {
    let mode: "error" | "bad-success" | "bad-error" | "transport" = "error";
    await withServer((_request, response) => {
      if (mode === "bad-success") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
      } else {
        response.writeHead(mode === "error" ? 409 : mode === "transport" ? 413 : 418, { "content-type": "application/json" });
        response.end(JSON.stringify(mode === "error"
          ? { code: "fixture_failure", message: "fixture failed", correlationId: "request:1", details: { reason: "fixture" } }
          : mode === "transport"
            ? { code: "request_too_large", message: "request too large", correlationId: "request:1", details: {} }
            : { code: "not_registered", message: "bad", correlationId: "request:1", details: {} }));
      }
    }, async (client) => {
      await expect(client.request({ operation: "fixture.read", input: { id: "one" } })).rejects.toMatchObject({ kind: "http_error", status: 409 });
      mode = "bad-success";
      await expect(client.request({ operation: "fixture.read", input: { id: "one" } })).rejects.toMatchObject({ kind: "client_contract_error" });
      mode = "bad-error";
      await expect(client.request({ operation: "fixture.read", input: { id: "one" } })).rejects.toMatchObject({ kind: "client_contract_error" });
      mode = "transport";
      await expect(client.request({ operation: "fixture.read", input: { id: "one" } })).rejects.toMatchObject({ kind: "http_error", status: 413 });
    });
  });

  it("classifies connect and control deadlines separately", async () => {
    const server = createNetServer((socket) => {
      setTimeout(() => {
        socket.end("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 22\\r\\nConnection: close\\r\\n\\r\\n{\"ok\":true,\"id\":\"one\"}");
      }, 80);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
    try {
      const port = (address as AddressInfo).port;
      const client = createCliClient({ baseUrl: `http://127.0.0.1:${port}`, registry, timeouts: { connectMs: 100, controlMs: 20, streamIdleMs: 100 } });
      await expect(client.request({ operation: "fixture.read", input: { id: "one" } })).rejects.toMatchObject({ kind: "control_timeout" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("classifies a TLS handshake stall as a connect timeout", async () => {
    let connection: import("node:net").Socket | undefined;
    const server = createNetServer((socket) => {
      connection = socket;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
    try {
      const port = (address as AddressInfo).port;
      const client = createCliClient({
        baseUrl: `https://127.0.0.1:${port}`,
        registry,
        timeouts: { connectMs: 20, controlMs: 100, streamIdleMs: 100 },
      });
      await expect(client.request({ operation: "fixture.read", input: { id: "one" } })).rejects.toMatchObject({ kind: "connect_timeout" });
    } finally {
      connection?.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("resets stream idle only on progress and survives beyond control timeout", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let index = 0;
      const write = (): void => {
        if (index === 8) {
          response.end();
          return;
        }
        response.write(Buffer.from([index++]));
        setTimeout(write, 5);
      };
      write();
    }, async (client) => {
      const result = await client.request({ operation: "fixture.stream", input: { id: "one" } });
      if (result.kind !== "stream") throw new Error("expected stream response");
      const received: number[] = [];
      for await (const chunk of result.stream.body) received.push(...chunk);
      expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }, { connectMs: 100, controlMs: 10, streamIdleMs: 20 });
  });

  it("classifies a stalled stream as stream-idle timeout and supports cancellation", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from([1]));
      setTimeout(() => response.end(Buffer.from([2])), 100);
    }, async (client) => {
      const result = await client.request({ operation: "fixture.stream", input: { id: "one" } });
      if (result.kind !== "stream") throw new Error("expected stream response");
      const iterator = result.stream.body[Symbol.asyncIterator]();
      await iterator.next();
      await expect(iterator.next()).rejects.toMatchObject({ kind: "stream_idle_timeout" });
      await result.stream.cancel();
    }, { connectMs: 100, controlMs: 100, streamIdleMs: 20 });
  });

  it("keeps a premature transport close distinct from stream-idle timeout", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "2" });
      response.write(Buffer.from([1]));
      setTimeout(() => response.socket?.destroy(), 5);
    }, async (client) => {
      const result = await client.request({ operation: "fixture.stream", input: { id: "one" } });
      if (result.kind !== "stream") throw new Error("expected stream response");
      const iterator = result.stream.body[Symbol.asyncIterator]();
      await iterator.next();
      await expect(iterator.next()).rejects.toMatchObject({ kind: "transport_error" });
      await result.stream.cancel();
    });
  });

  it("propagates abort and awaits owned stream cleanup", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from([1]));
      setTimeout(() => response.end(Buffer.from([2])), 100);
    }, async (client) => {
      const controller = new AbortController();
      const result = await client.request({ operation: "fixture.stream", input: { id: "one" }, signal: controller.signal });
      if (result.kind !== "stream") throw new Error("expected stream response");
      const iterator = result.stream.body[Symbol.asyncIterator]();
      await iterator.next();
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ kind: "aborted" });
      await result.stream.cancel();
    });
  });

  it("closes a stream aborted between response headers and iteration", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from([1]));
    }, async (client) => {
      const controller = new AbortController();
      const result = await client.request({
        operation: "fixture.stream",
        input: { id: "one" },
        signal: controller.signal,
      });
      if (result.kind !== "stream") throw new Error("expected stream response");
      controller.abort();
      const iterator = result.stream.body[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toMatchObject({ kind: "aborted" });
      await result.stream.cancel();
    });
  });
});
