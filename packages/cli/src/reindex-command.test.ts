import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, expect, test } from "bun:test";
import {
  reportAdminReindexOperation,
  type ReportAdminReindexResponse,
} from "@agent-mail/contracts";
import { createReportAdminHandlers, type ReportAdminServices } from "../../daemon/src/report-admin-handlers";
import { createHttpApp } from "../../daemon/src/http";
import {
  executeCommand,
  type CommandExecutionContextV1,
  type CommandSink,
} from "./command-outcome";
import { CliClientError, createCliClient, type CliClient, type CliResponse } from "./client";
import {
  REINDEX_ARGV,
  REINDEX_OPERATION_KEY,
  runReindexCommand,
} from "./reindex-command";

const request = { scope: "all", operationIntent: "rebuild parity index" };
const response: ReportAdminReindexResponse = {
  accepted: true,
  scope: "all",
  startedAt: "2026-08-19T00:00:00.000Z",
  indexed: 12,
  expected: 12,
};

function clientFor(
  result: CliResponse | Error,
  calls: unknown[] = [],
): Pick<CliClient, "request"> {
  return {
    async request(options) {
      calls.push(options);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function sink(chunks: Uint8Array[]): CommandSink {
  return {
    async write(value) {
      chunks.push(value);
      return { kind: "written", bytesAccepted: value.byteLength };
    },
  };
}

function executionContext(
  mode: "json" | "human",
  stdout: Uint8Array[],
  stderr: Uint8Array[],
  signal = new AbortController().signal,
): CommandExecutionContextV1 {
  return {
    invocationCorrelationId: "cli:reindex-test",
    mode,
    stdout: sink(stdout),
    stderr: sink(stderr),
    rawPolicy: { destination: "pipe", tty: "refuse" },
    signal,
  };
}

function text(chunks: readonly Uint8Array[]): string {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return headers;
}

async function startHonoServer(
  app: Readonly<{ readonly fetch: (request: Request) => Promise<Response> }>,
): Promise<Readonly<{ readonly client: CliClient; readonly close: () => Promise<void> }>> {
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Uint8Array[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
    incoming.on("end", () => {
      void (async () => {
        try {
          const response = await app.fetch(
            new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
              method: incoming.method,
              headers: requestHeaders(incoming),
              body: chunks.length === 0 ? undefined : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
              duplex: "half",
            }),
          );
          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) => outgoing.setHeader(name, value));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          outgoing.statusCode = 500;
          outgoing.end();
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("reindex test server did not bind");
  return {
    client: createCliClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      authorization: "Bearer reindex-test",
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

describe("P7-C03A reindex CLI adapter", () => {
  test("uses the strict shared request once and retains the verified response", async () => {
    const calls: unknown[] = [];
    const result = await runReindexCommand({
      argv: [...REINDEX_ARGV],
      correlationId: "cli:reindex",
      request,
      client: clientFor(
        { kind: "success", operationKey: REINDEX_OPERATION_KEY, status: 200, data: response },
        calls,
      ),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: reportAdminReindexOperation, input: request });
      expect(result).toMatchObject({
        kind: "value",
        operationKey: REINDEX_OPERATION_KEY,
        semanticKind: "success",
        data: response,
      });
    if (result.kind !== "value") throw new Error("reindex result was not a value");
    expect(result.humanLines.flat().map((segment) => segment.kind)).toEqual([
      "trusted-chrome",
      "untrusted-value",
      "trusted-chrome",
      "untrusted-value",
      "trusted-chrome",
      "untrusted-value",
      "trusted-chrome",
      "untrusted-value",
    ]);
  });

  test("rejects argv, scope, and intent before opening the client", async () => {
    let calls = 0;
    const client = {
      request: async () => {
        calls += 1;
        throw new Error("must not call");
      },
    };
    const usage = await runReindexCommand({
      argv: ["admin", "reindex", "unexpected"],
      correlationId: "cli:reindex-usage",
      request,
      client,
    });
    const invalidScope = await runReindexCommand({
      argv: [...REINDEX_ARGV],
      correlationId: "cli:reindex-scope",
      request: { ...request, scope: "unknown" },
      client,
    });
    const invalidIntent = await runReindexCommand({
      argv: [...REINDEX_ARGV],
      correlationId: "cli:reindex-intent",
      request: { ...request, operationIntent: "" },
      client,
    });
    expect(usage).toMatchObject({ kind: "failure", semanticKind: "usage" });
    expect(invalidScope).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
    expect(invalidIntent).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
    expect(calls).toBe(0);
  });

  test("maps malformed and wrong-operation successes to protocol", async () => {
    const malformed = await runReindexCommand({
      argv: [...REINDEX_ARGV],
      correlationId: "cli:reindex-malformed",
      request,
      client: clientFor({
        kind: "success",
        operationKey: REINDEX_OPERATION_KEY,
        status: 200,
        data: { ...response, expected: -1 },
      }),
    });
    const wrongOperation = await runReindexCommand({
      argv: [...REINDEX_ARGV],
      correlationId: "cli:reindex-operation",
      request,
      client: clientFor({ kind: "success", operationKey: "admin.doctor", status: 200, data: response }),
    });
    const wrongScope = await runReindexCommand({
      argv: [...REINDEX_ARGV],
      correlationId: "cli:reindex-scope-response",
      request,
      client: clientFor({
        kind: "success",
        operationKey: REINDEX_OPERATION_KEY,
        status: 200,
        data: { ...response, scope: "attachments" },
      }),
    });
    expect(malformed).toMatchObject({ kind: "failure", semanticKind: "protocol" });
    expect(wrongOperation).toMatchObject({ kind: "failure", semanticKind: "protocol" });
    expect(wrongScope).toMatchObject({ kind: "failure", semanticKind: "protocol" });
  });

  test("preserves shared abort semantics without retrying", async () => {
    let calls = 0;
    const result = await runReindexCommand({
      argv: [...REINDEX_ARGV],
      correlationId: "cli:reindex-abort",
      request,
      client: {
        async request() {
          calls += 1;
          throw new CliClientError("aborted", REINDEX_OPERATION_KEY, "caller cancelled");
        },
      },
    });
    expect(result).toMatchObject({ kind: "failure", semanticKind: "cancelled" });
    expect(calls).toBe(1);
  });

  test("composes the real Hono route, HTTP client, and command outcome in JSON and human modes", async () => {
    let serviceCalls = 0;
    const services: ReportAdminServices = {
      createReport: () => ({ kind: "blocked", reason: "not exercised" }),
      exportSelected: () => ({ kind: "blocked", reason: "not exercised" }),
      backup: () => ({ kind: "blocked", reason: "not exercised" }),
      restore: () => ({ kind: "blocked", reason: "not exercised" }),
      doctor: () => ({ kind: "blocked", reason: "not exercised" }),
      reindex: async (value) => {
        serviceCalls += 1;
        expect(value).toEqual(request);
        return response;
      },
    };
    const app = createHttpApp({
      authenticate: (credential) =>
        credential === "reindex-test"
          ? { kind: "authenticated", principal: { subject: "operator:test", scopes: ["admin:reindex"] } }
          : { kind: "invalid" },
      handlers: createReportAdminHandlers(services),
    });
    const server = await startHonoServer(app);
    try {
      const result = await runReindexCommand({
        argv: [...REINDEX_ARGV],
        correlationId: "cli:reindex-composed",
        request,
        client: server.client,
      });
      expect(result).toMatchObject({ kind: "value", semanticKind: "success", data: response });
      const jsonOut: Uint8Array[] = [];
      const jsonErr: Uint8Array[] = [];
      const jsonReceipt = await executeCommand(
        result,
        executionContext("json", jsonOut, jsonErr),
      );
      expect(jsonReceipt).toMatchObject({ semanticKind: "success", exitCode: 0 });
      expect(JSON.parse(text(jsonOut))).toEqual(response);
      expect(text(jsonErr)).toBe("");

      const humanOut: Uint8Array[] = [];
      const humanErr: Uint8Array[] = [];
      const humanReceipt = await executeCommand(
        result,
        executionContext("human", humanOut, humanErr),
      );
      expect(humanReceipt).toMatchObject({ semanticKind: "success", exitCode: 0 });
      expect(text(humanOut)).toContain("scope: all");
      expect(text(humanOut)).toContain("started: 2026-08-19T00:00:00.000Z");
      expect(text(humanOut)).toContain("indexed: 12");
      expect(text(humanOut)).toContain("expected: 12");
      expect(text(humanErr)).toBe("");
      expect(serviceCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("maps a real service failure to the registered internal outcome", async () => {
    const services: ReportAdminServices = {
      createReport: () => ({ kind: "blocked", reason: "not exercised" }),
      exportSelected: () => ({ kind: "blocked", reason: "not exercised" }),
      backup: () => ({ kind: "blocked", reason: "not exercised" }),
      restore: () => ({ kind: "blocked", reason: "not exercised" }),
      doctor: () => ({ kind: "blocked", reason: "not exercised" }),
      reindex: () => ({ kind: "failure", reason: "index rebuild failed" }),
    };
    const app = createHttpApp({
      authenticate: () => ({
        kind: "authenticated",
        principal: { subject: "operator:test", scopes: ["admin:reindex"] },
      }),
      handlers: createReportAdminHandlers(services),
    });
    const server = await startHonoServer(app);
    try {
      const result = await runReindexCommand({
        argv: [...REINDEX_ARGV],
        correlationId: "cli:reindex-failure",
        request,
        client: server.client,
      });
      expect(result).toMatchObject({ kind: "failure", semanticKind: "internal" });
    } finally {
      await server.close();
    }
  });

});
