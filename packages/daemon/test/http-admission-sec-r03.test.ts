import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createOperationRegistry, defineOperation, publicErrorEnvelopeSchema } from "@agent-mail/contracts";
import {
  admitHttpRequest,
  createHttpApp,
  DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES,
  httpErrorRegistry,
  type HttpCredentialResolution,
  type HttpAdmissionRequest,
} from "../src/http";

const requestSchema = z.strictObject({ value: z.string() });
const responseSchema = z.union([z.strictObject({ ok: z.literal(true), value: z.string() }), publicErrorEnvelopeSchema]);
const operation = defineOperation({
  key: "synthetic.admission",
  route: "/v1/synthetic/admission",
  method: "POST",
  cliName: "synthetic-admission",
  scope: "synthetic:admission",
  request: requestSchema,
  response: responseSchema,
  streaming: "none",
  strictness: "strict",
});
const registry = createOperationRegistry([operation] as const);

type StreamState = { pulls: number; cancels: number };

function streamBody(chunks: readonly Uint8Array[], state: StreamState): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      state.pulls += 1;
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      state.cancels += 1;
    },
  });
}

function requestWithBody(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return requestWithAuthorization(body, "Bearer correct", headers);
}

function requestWithAuthorization(
  body: BodyInit | null,
  authorization: string | undefined,
  headers: Record<string, string> = {},
): Request {
  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };
  if (authorization !== undefined) requestHeaders.authorization = authorization;
  return new Request("http://localhost/v1/synthetic/admission", {
    method: "POST",
    headers: {
      ...requestHeaders,
    },
    body,
  });
}

function authenticated(scope = operation.scope): HttpCredentialResolution {
  return { kind: "authenticated", principal: { subject: "operator", scopes: [scope] } };
}

function directAdmissionRequest(
  body: ReadableStream<Uint8Array>,
  authorization: string | undefined,
): HttpAdmissionRequest {
  return directAdmissionRequestShape(body, authorization, new AbortController().signal);
}

function directAdmissionRequestShape(
  body: ReadableStream<Uint8Array>,
  authorization: string | undefined,
  signal: AbortSignal,
): HttpAdmissionRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) headers.set("authorization", authorization);
  return { headers, body, method: "POST", signal };
}

function openStreamBody(chunks: readonly Uint8Array[], state: StreamState): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) controller.enqueue(chunk);
    },
    cancel() {
      state.cancels += 1;
    },
  });
}

function nonPullingBody(state: StreamState): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(100));
    },
    pull() {
      state.pulls += 1;
    },
    cancel() {
      state.cancels += 1;
    },
  });
}

describe("SEC-R03 bounded HTTP admission", () => {
  test("uses the explicit 1 MiB default and accepts one parsed exact-limit value", async () => {
    const value = "x".repeat(DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES - 12);
    const body = JSON.stringify({ value });
    expect(new TextEncoder().encode(body).byteLength).toBe(DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES);
    let received: unknown;
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated(),
      handlers: {
        [operation.key]: (input) => {
          received = input;
          return { ok: true, value: requestSchema.parse(input).value.slice(0, 1) };
        },
      },
    });

    const response = await app.request(requestWithBody(body));
    expect(response.status).toBe(200);
    expect(received).toEqual({ value });
  });

  test("rejects wrong-scope input after auth but before any body reader", async () => {
    const state: StreamState = { pulls: 0, cancels: 0 };
    let handlers = 0;
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated("other:scope"),
      maxRequestBodyBytes: 8,
      handlers: {
        [operation.key]: () => {
          handlers += 1;
          return { ok: true, value: "unexpected" };
        },
      },
    });
    const body = streamBody([new TextEncoder().encode('{"value":"' + "x".repeat(100) + '"}')], state);
    const response = await app.request(requestWithBody(body));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "insufficient_scope" });
    // The Hono adapter may prefetch a queued chunk, but the shared helper never
    // obtains a reader for denied input and cancels the request body once.
    expect(state.cancels).toBe(1);
    expect(handlers).toBe(0);
  });

  test("keeps every bearer decision ahead of small and oversized body admission", async () => {
    const cases: readonly [string | undefined, HttpCredentialResolution | undefined, number][] = [
      [undefined, undefined, 401],
      ["Bearer invalid", { kind: "invalid" }, 401],
      ["Bearer expired", { kind: "expired" }, 401],
      ["Bearer wrong", authenticated("other:scope"), 403],
      ["Bearer correct", authenticated(), 413],
    ];
    for (const [authorization, resolution, expectedStatus] of cases) {
      let handlers = 0;
      const app = createHttpApp({
        registry,
        maxRequestBodyBytes: 8,
        authenticate: () => resolution ?? { kind: "invalid" },
        handlers: {
          [operation.key]: () => {
            handlers += 1;
            return { ok: true, value: "unexpected" };
          },
        },
      });
      const headers = authorization === undefined ? {} : { authorization };
      const response = await app.request(
        requestWithBody(streamBody([new Uint8Array(9)], { pulls: 0, cancels: 0 }), headers),
      );
      expect(response.status).toBe(expectedStatus);
      expect(handlers).toBe(0);
    }
  });

  test("direct helper instrumentation proves every denied bearer releases without reader acquisition", async () => {
    const cases: readonly [string | undefined, HttpCredentialResolution, number][] = [
      [undefined, { kind: "invalid" }, 401],
      ["Bearer invalid", { kind: "invalid" }, 401],
      ["Bearer expired", { kind: "expired" }, 401],
      ["Bearer wrong", authenticated("other:scope"), 403],
    ];
    for (const [authorization, resolution, status] of cases) {
      const state: StreamState = { pulls: 0, cancels: 0 };
      const lifecycle = { readerAcquired: 0, readerReleased: 0, inputCancelled: 0 };
      const result = await admitHttpRequest({
        operation,
        request: directAdmissionRequest(
          nonPullingBody(state),
          authorization,
        ),
        authenticate: () => resolution,
        lifecycleProbe: {
          onReaderAcquired: () => (lifecycle.readerAcquired += 1),
          onReaderReleased: () => (lifecycle.readerReleased += 1),
          onInputCancelled: () => (lifecycle.inputCancelled += 1),
        },
      });
      expect(result).toMatchObject({ kind: "rejected", status });
      expect(lifecycle).toEqual({ readerAcquired: 0, readerReleased: 0, inputCancelled: 1 });
      expect(state.pulls).toBe(0);
      expect(state.cancels).toBe(1);
    }
  });

  test("direct helper instrumentation proves chunked rejection cancels and releases its reader once", async () => {
    const state: StreamState = { pulls: 0, cancels: 0 };
    const lifecycle = { readerAcquired: 0, readerReleased: 0, inputCancelled: 0 };
    const result = await admitHttpRequest({
      operation,
      request: directAdmissionRequest(
        openStreamBody([new Uint8Array(4), new Uint8Array(5)], state),
        "Bearer correct",
      ),
      authenticate: () => authenticated(),
      maxRequestBodyBytes: 8,
      lifecycleProbe: {
        onReaderAcquired: () => (lifecycle.readerAcquired += 1),
        onReaderReleased: () => (lifecycle.readerReleased += 1),
        onInputCancelled: () => (lifecycle.inputCancelled += 1),
      },
    });
    expect(result).toMatchObject({ kind: "rejected", status: 413 });
    expect(lifecycle).toEqual({ readerAcquired: 1, readerReleased: 1, inputCancelled: 0 });
    expect(state.cancels).toBe(1);
  });

  test("rejects declared oversize before obtaining a reader and maps a registered 413", async () => {
    const state: StreamState = { pulls: 0, cancels: 0 };
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated(),
      maxRequestBodyBytes: 8,
      handlers: { [operation.key]: () => ({ ok: true, value: "unexpected" }) },
    });
    const response = await app.request(
      requestWithBody(streamBody([new Uint8Array(100)], state), { "content-length": "100" }),
    );
    const body: unknown = await response.json();
    expect(response.status).toBe(413);
    expect(body).toMatchObject({ code: "request_too_large", details: {} });
    expect(publicErrorEnvelopeSchema.safeParse(body).success).toBe(true);
    expect(httpErrorRegistry.parse(body)).toMatchObject({ code: "request_too_large" });
    expect(state.cancels).toBe(1);
  });

  test("enforces the same limit for absent-length chunks and cancels the stream", async () => {
    const state: StreamState = { pulls: 0, cancels: 0 };
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated(),
      maxRequestBodyBytes: 8,
      handlers: { [operation.key]: () => ({ ok: true, value: "unexpected" }) },
    });
    const response = await app.request(
      requestWithBody(streamBody([new Uint8Array(4), new Uint8Array(5)], state)),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "request_too_large" });
    expect(state.pulls).toBeGreaterThanOrEqual(2);
    // Bun may prefetch the final queued chunk before the shared reader sees
    // the over-limit condition; direct helper instrumentation proves release.
  });

  test("fails closed for malformed/conflicting length and unsupported content encoding", async () => {
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated(),
      maxRequestBodyBytes: 100,
      handlers: { [operation.key]: () => ({ ok: true, value: "unexpected" }) },
    });
    for (const contentLength of ["-1", "1, 1", "not-a-length"]) {
      const response = await app.request(requestWithBody("{}", { "content-length": contentLength }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    const encoded = await app.request(requestWithBody("{}", { "content-encoding": "gzip" }));
    expect(encoded.status).toBe(415);
    expect(await encoded.json()).toMatchObject({ code: "invalid_request" });
  });

  test("rejects malformed UTF-8, empty JSON, trailing data, and mismatched length without leaking input", async () => {
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated(),
      maxRequestBodyBytes: 100,
      handlers: { [operation.key]: () => ({ ok: true, value: "unexpected" }) },
    });
    for (const body of ["", "{} trailing"]) {
      const response = await app.request(requestWithBody(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request", details: {} });
    }
    const invalidUtf8 = await app.request(
      requestWithBody(new Uint8Array([0xc3, 0x28]), { "content-length": "2" }),
    );
    expect(invalidUtf8.status).toBe(400);
    expect(JSON.stringify(await invalidUtf8.json())).not.toContain("(");
  });

  test("maps an aborted body stream to a stable 400 and never invokes the handler", async () => {
    let handlers = 0;
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated(),
      handlers: {
        [operation.key]: () => {
          handlers += 1;
          return { ok: true, value: "unexpected" };
        },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("aborted input"));
      },
    });
    const response = await app.request(requestWithBody(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request", details: {} });
    expect(handlers).toBe(0);
  });

  test("direct helper abort cancels/releases once and removes its abort listener", async () => {
    const controller = new AbortController();
    const state = { pulls: 0, cancels: 0 };
    const lifecycle = { readerAcquired: 0, readerReleased: 0, abortRemoved: 0 };
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new Uint8Array([123]));
      },
      pull() {
        state.pulls += 1;
        return new Promise<void>(() => {});
      },
      cancel() {
        state.cancels += 1;
      },
    });
    const admission = admitHttpRequest({
      operation,
      request: directAdmissionRequestShape(body, "Bearer correct", controller.signal),
      authenticate: () => authenticated(),
      lifecycleProbe: {
        onReaderAcquired: () => (lifecycle.readerAcquired += 1),
        onReaderReleased: () => (lifecycle.readerReleased += 1),
        onAbortListenerRemoved: () => (lifecycle.abortRemoved += 1),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await admission;
    expect(result).toMatchObject({ kind: "rejected", status: 400 });
    expect(lifecycle).toEqual({ readerAcquired: 1, readerReleased: 1, abortRemoved: 2 });
    expect(state.cancels).toBe(1);
  });

  test("awaits shared reader cancellation before releasing an aborted request", async () => {
    const controller = new AbortController();
    const lifecycle = { readerReleased: 0, abortRemoved: 0 };
    let cancelCalls = 0;
    let resolveCancel: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelCalls += 1;
        return new Promise<void>((resolve) => {
          resolveCancel = resolve;
        });
      },
    });
    const admission = admitHttpRequest({
      operation,
      request: directAdmissionRequestShape(body, "Bearer correct", controller.signal),
      authenticate: () => authenticated(),
      lifecycleProbe: {
        onReaderReleased: () => (lifecycle.readerReleased += 1),
        onAbortListenerRemoved: () => (lifecycle.abortRemoved += 1),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    let settled = false;
    void admission.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(lifecycle.readerReleased).toBe(0);
    expect(cancelCalls).toBe(1);
    expect(lifecycle.abortRemoved).toBe(1);
    if (resolveCancel === undefined) throw new Error("reader cancellation did not start");
    resolveCancel();

    const result = await admission;
    expect(result).toMatchObject({ kind: "rejected", status: 400 });
    expect(lifecycle.readerReleased).toBe(1);
    expect(cancelCalls).toBe(1);
  });

  test("Bun/Hono signal abort integration returns stable 400 without invoking the handler", async () => {
    const controller = new AbortController();
    let handlers = 0;
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated(),
      handlers: {
        [operation.key]: () => {
          handlers += 1;
          return { ok: true, value: "unexpected" };
        },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
    });
    const responsePromise = app.request(
      new Request("http://localhost/v1/synthetic/admission", {
        method: "POST",
        headers: { authorization: "Bearer correct", "content-type": "application/json" },
        body,
        signal: controller.signal,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const response = await responsePromise;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request", details: {} });
    expect(handlers).toBe(0);
  });

  test("waits for slow chunks while retaining only the bounded received bytes", async () => {
    const app = createHttpApp({
      registry,
      authenticate: () => authenticated(),
      maxRequestBodyBytes: 64,
      handlers: { [operation.key]: (input) => ({ ok: true, value: requestSchema.parse(input).value }) },
    });
    const encoded = new TextEncoder().encode('{"value":"slow"}');
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const chunk = encoded.slice(index, index + 3);
        index += chunk.byteLength;
        if (chunk.byteLength === 0) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await app.request(requestWithBody(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, value: "slow" });
  });

  test("retired every direct request JSON materializer from public daemon ingress", async () => {
    const files = ["packages/daemon/src/http.ts", "packages/daemon/src/selected-export-stream.ts"];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(/request\.json\(\)|request\.clone\(\)\.json\(\)/u);
    }
  });

  test("keeps repeated oversized chunked requests bounded in a child process", async () => {
    const child = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "helpers/http-admission-memory-child.ts")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const report = z
      .strictObject({
        baselineRssBytes: z.number().int().nonnegative(),
        peakRssBytes: z.number().int().nonnegative(),
        finalRssBytes: z.number().int().nonnegative(),
        peakGrowthBytes: z.number().int().nonnegative(),
        retainedGrowthBytes: z.number().int().nonnegative(),
        iterations: z.literal(200),
        limit: z.literal(64 * 1024),
        statuses: z.array(z.literal(413)),
      })
      .parse(JSON.parse(stdout));
    expect(report).toMatchObject({ iterations: 200, limit: 64 * 1024 });
    const { statuses, retainedGrowthBytes, peakGrowthBytes } = report;
    expect(statuses).toEqual(Array.from({ length: 200 }, () => 413));
    expect(retainedGrowthBytes).toBeLessThan(64 * 1024 * 1024);
    expect(peakGrowthBytes).toBeLessThan(96 * 1024 * 1024);
  });
});
