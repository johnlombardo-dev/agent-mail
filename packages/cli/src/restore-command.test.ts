import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createCliClient,
  CliClientError,
  type CliClient,
  type CliResponse,
} from "./client";
import { executeCommand, type CommandResultV1, type CommandSink } from "./command-outcome";
import { runRestoreCommand } from "./restore-command";
import {
  createHttpApp,
  type HttpCredentialResolution,
} from "../../daemon/src/http";
import {
  createReportAdminHandlers,
  type ReportAdminServices,
} from "../../daemon/src/report-admin-handlers";

const instant = "2026-08-18T00:00:00.000Z";
const digest = "a".repeat(64);
const request = {
  target: "/private/agent-mail/restore-́",
  manifest: { manifestId: "manifest:backup-1", digest },
  confirmationNonce: "restore-confirmation-2026-08-18",
  offline: true as const,
};
const response = {
  restored: true as const,
  target: request.target,
  manifest: request.manifest,
  completedAt: instant,
};

function success(data: unknown = response): CliResponse {
  return { kind: "success", operationKey: "admin.restore", status: 200, data };
}

function sinkCapture(): { readonly sink: CommandSink; readonly text: () => string } {
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      write: async (bytes) => {
        chunks.push(bytes.slice());
        return { kind: "written", bytesAccepted: bytes.byteLength };
      },
    },
    text: () => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))),
  };
}

async function render(
  result: CommandResultV1,
  mode: "json" | "human" = "human",
): Promise<Readonly<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>> {
  const stdout = sinkCapture();
  const stderr = sinkCapture();
  const receipt = await executeCommand(result, {
    invocationCorrelationId: "cli:restore:test",
    mode,
    stdout: stdout.sink,
    stderr: stderr.sink,
    rawPolicy: { destination: "pipe", tty: "refuse" },
    signal: new AbortController().signal,
  });
  return { stdout: stdout.text(), stderr: stderr.text(), exitCode: receipt.exitCode };
}

function authenticated(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: { subject: "operator:restore-test", scopes: ["admin:restore"] },
  };
}

function servicesFor(
  restore: ReportAdminServices["restore"],
): ReportAdminServices {
  const unused = (name: string): (() => never) => () => {
    throw new Error(`${name} fixture route was not expected`);
  };
  return {
    createReport: unused("reports.create"),
    exportSelected: unused("exports.selected"),
    backup: unused("admin.backup"),
    restore,
    doctor: unused("admin.doctor"),
    reindex: unused("admin.reindex"),
  };
}

async function readBody(requestInput: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of requestInput) {
    if (chunk instanceof Uint8Array) chunks.push(chunk);
  }
  return new TextDecoder().decode(
    Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
  );
}

async function withApi(
  restore: ReportAdminServices["restore"],
  run: (client: CliClient, requests: readonly unknown[]) => Promise<void>,
): Promise<void> {
  const app = createHttpApp({
    authenticate: authenticated,
    handlers: createReportAdminHandlers(servicesFor(restore)),
  });
  const requests: unknown[] = [];
  const server = createServer(async (requestInput, responseOutput) => {
    const body = await readBody(requestInput);
    requests.push(JSON.parse(body) as unknown);
    const webRequest = new Request(`http://127.0.0.1${requestInput.url ?? "/"}`, {
      method: requestInput.method,
      headers: Object.fromEntries(
        Object.entries(requestInput.headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : [],
        ),
      ),
      body,
    });
    const webResponse = await app.fetch(webRequest);
    responseOutput.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    responseOutput.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("restore fixture did not bind");
  try {
    await run(
      createCliClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        authorization: "Bearer restore-fixture",
      }),
      requests,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

describe("P7-C03B offline restore CLI adapter", () => {
  test("forwards the exact confirmed request once and returns the verified response", async () => {
    const calls: unknown[] = [];
    const result = await runRestoreCommand({
      argv: ["admin", "restore"],
      correlationId: "cli:restore-direct",
      request,
      client: {
        request: async (value) => {
          calls.push(value);
          return success();
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: { key: "admin.restore" }, input: request });
    expect(result).toMatchObject({
      kind: "value",
      operationKey: "admin.restore",
      semanticKind: "success",
      data: response,
    });
  });

  test("rejects every destructive guard before opening the client", async () => {
    const invalidRequests: readonly unknown[] = [
      {},
      { ...request, offline: false },
      { ...request, confirmationNonce: "short" },
      { ...request, target: "/private/agent-mail/../other" },
      { ...request, manifest: { manifestId: "manifest:backup-1", digest: "not-a-digest" } },
    ];
    let calls = 0;
    for (const invalid of invalidRequests) {
      const result = await runRestoreCommand({
        argv: ["admin", "restore"],
        correlationId: "cli:restore-invalid",
        request: invalid,
        client: { request: async () => { calls += 1; throw new Error("must not open client"); } },
      });
      expect(result).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
    }
    expect(calls).toBe(0);
  });

  test("returns usage for wrong argv and protocol for malformed or wrong-operation success", async () => {
    const usage = await runRestoreCommand({
      argv: ["admin", "restore", "latest"],
      correlationId: "cli:restore-usage",
      request,
      client: { request: async () => { throw new Error("must not call"); } },
    });
    expect(usage).toMatchObject({ kind: "failure", semanticKind: "usage" });

    const malformed = await runRestoreCommand({
      argv: ["admin", "restore"],
      correlationId: "cli:restore-malformed",
      request,
      client: { request: async () => success({ ...response, target: "/not/absolute/../target" }) },
    });
    expect(malformed).toMatchObject({ kind: "failure", semanticKind: "protocol" });

    const wrongOperation = await runRestoreCommand({
      argv: ["admin", "restore"],
      correlationId: "cli:restore-wrong-operation",
      request,
      client: {
        request: async () => ({ kind: "success", operationKey: "admin.backup", status: 200, data: response }),
      },
    });
    expect(wrongOperation).toMatchObject({ kind: "failure", semanticKind: "protocol" });

    for (const mismatched of [
      { ...response, target: "/private/agent-mail/different-target" },
      { ...response, manifest: { ...response.manifest, manifestId: "manifest:different" } },
      { ...response, manifest: { ...response.manifest, digest: "b".repeat(64) } },
    ]) {
      const authorityMismatch = await runRestoreCommand({
        argv: ["admin", "restore"],
        correlationId: "cli:restore-authority-mismatch",
        request,
        client: { request: async () => success(mismatched) },
      });
      expect(authorityMismatch).toMatchObject({ kind: "failure", semanticKind: "protocol" });
    }
  });

  test("retains registered client error semantics, including abort", async () => {
    const result = await runRestoreCommand({
      argv: ["admin", "restore"],
      correlationId: "cli:restore-aborted",
      request,
      client: {
        request: async () => {
          throw new CliClientError("aborted", "admin.restore", "request was aborted");
        },
      },
    });
    expect(result).toMatchObject({ kind: "failure", semanticKind: "cancelled", operationKey: "admin.restore" });
  });

  test("composes real Hono, client, and command outcome with no adapter filesystem mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-restore-cli-"));
    const before = await readdir(root);
    const calls: unknown[] = [];
    try {
      await withApi(
        (received, receivedContext) => {
          calls.push({ received, receivedContext });
          return response;
        },
        async (client, requests) => {
          const result = await runRestoreCommand({
            argv: ["admin", "restore"],
            correlationId: "cli:restore-composed",
            request,
            client,
          });
          const rendered = await render(result);
          expect(rendered.exitCode).toBe(0);
          expect(rendered.stdout).toContain("target: /private/agent-mail/restore-⟦U+0301⟧");
          expect(result).toMatchObject({ kind: "value", data: { manifest: request.manifest } });
          expect(requests).toEqual([request]);
        },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ received: request, receivedContext: { scope: "admin:restore" } });
      expect(await readdir(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("projects a service failure through the shared HTTP and command outcome boundaries", async () => {
    await withApi(
      () => ({ kind: "failure", reason: "manifest mismatch", provenance: { fixture: "restore" } }),
      async (client) => {
        const result = await runRestoreCommand({
          argv: ["admin", "restore"],
          correlationId: "cli:restore-service-failure",
          request,
          client,
        });
        expect(result).toMatchObject({ kind: "failure", semanticKind: "internal" });
      },
    );
  });
});
