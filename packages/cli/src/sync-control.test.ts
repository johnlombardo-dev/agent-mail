import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "bun:test";
import { createCliClient, type CliClient, type CliResponse } from "./client";
import {
  executeCommand,
  exitCodeForSemanticKind,
  type CommandResultV1,
  type CommandSink,
} from "./command-outcome";
import {
  errorEnvelope,
  syncControlErrorFixtures,
  syncControlSuccessFixtures,
  type SyncControlErrorFixture,
} from "./sync-control-fixtures";
import {
  executeSyncControlCommand,
  parseSyncControlRequest,
  runSyncControlCommand,
  syncControlCommandDefinitions,
} from "./sync-control";

type Scenario = Readonly<{
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}>;

type CapturedRequest = Readonly<{
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly body: unknown;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observedField(fixture: Readonly<Record<string, unknown>>, field: string): string {
  const observed = fixture.observed;
  if (!isRecord(observed)) return "";
  const value = observed[field];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    if (chunk instanceof Uint8Array) chunks.push(chunk);
  }
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes));
}

async function withServer(
  scenario: () => Scenario,
  run: (client: ReturnType<typeof createCliClient>, requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      requests.push({ method: request.method, path: request.url, body: await readBody(request) });
      const current = scenario();
      response.writeHead(current.status, { "content-type": "application/json" });
      response.end(JSON.stringify(current.body));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
  try {
    await run(createCliClient({ baseUrl: `http://127.0.0.1:${address.port}` }), requests);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

function sinkCapture(): { readonly sink: CommandSink; readonly read: () => string } {
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      write: async (bytes) => {
        chunks.push(bytes);
        return { kind: "written", bytesAccepted: bytes.byteLength };
      },
    },
    read: () => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))),
  };
}

async function render(
  result: CommandResultV1,
  mode: "json" | "human",
): Promise<Readonly<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>> {
  const stdout = sinkCapture();
  const stderr = sinkCapture();
  const receipt = await executeCommand(
    result,
    {
      invocationCorrelationId: "cli:sync-control:test",
      mode,
      stdout: stdout.sink,
      stderr: stderr.sink,
      rawPolicy: { destination: "pipe", tty: "refuse" },
      signal: new AbortController().signal,
    },
  );
  return { stdout: stdout.read(), stderr: stderr.read(), exitCode: receipt.exitCode };
}

describe("sync-control CLI command family", () => {
  it("maps each verb once and reports only the API's observed state/version", async () => {
    let index = 0;
    await withServer(
      () => {
        const fixture = syncControlSuccessFixtures[index] ?? syncControlSuccessFixtures[0];
        index += 1;
        return { status: 200, body: fixture.response };
      },
      async (client, requests) => {
        for (const fixture of syncControlSuccessFixtures) {
          const result = await executeSyncControlCommand(fixture.command, fixture.request, {
            client,
            correlationId: `cli:${fixture.command}`,
          });
          expect(result.kind).toBe("value");
          if (result.kind !== "value") throw new Error("expected a validated sync value");
          expect(result.operationKey).toBe(syncControlCommandDefinitions[fixture.command].operation.key);
          expect(result.data).toEqual(fixture.response);
          const human = await render(result, "human");
          const json = await render(result, "json");
          expect(human.exitCode).toBe(0);
          expect(json.exitCode).toBe(0);
          expect(JSON.parse(json.stdout)).toEqual(fixture.response);
          expect(human.stdout).toContain(`state=${observedField(fixture.response, "actorState")}`);
          expect(human.stdout).toContain(`version=${observedField(fixture.response, "version")}`);
          expect(human.stderr).toBe("");
        }
        expect(requests).toHaveLength(4);
        expect(requests.map(({ method, path }) => [method, path])).toEqual([
          ["POST", "/v1/sync/start"],
          ["POST", "/v1/sync/pause"],
          ["POST", "/v1/sync/resume"],
          ["POST", "/v1/sync/stop"],
        ]);
        expect(requests.map(({ body }) => body)).toEqual(
          syncControlSuccessFixtures.map(({ request }) => request),
        );
      },
    );
  });

  it("preserves every registered rejection/failure/cancel/auth/timeout outcome", async () => {
    for (const fixture of syncControlErrorFixtures) {
      for (const status of [200, 500]) {
        await withServer(
          () => ({ status, body: errorEnvelope(fixture) }),
          async (client, requests) => {
            const request = fixture.command === "start" ? {} : { idempotencyKey: `idempotency:${fixture.name}` };
            const result = await executeSyncControlCommand(fixture.command, request, {
              client,
              correlationId: `cli:${fixture.name}`,
            });
            expect(result.kind).toBe("failure");
            if (result.kind !== "failure") throw new Error("expected a registered sync failure");
            expect(result.semanticKind).toBe(fixture.semanticKind);
            expect(result.error.code).toBe(fixture.code);
            expect(exitCodeForSemanticKind(result.semanticKind)).toBeGreaterThan(0);
            expect(requests).toHaveLength(1);
            const json = await render(result, "json");
            expect(json.exitCode).toBe(exitCodeForSemanticKind(fixture.semanticKind));
            expect(JSON.parse(json.stderr)).toMatchObject({ code: fixture.code });
            expect(json.stdout).toBe("");
          },
        );
      }
    }
  });

  it("does not retry repeated controls or invent success for invalid order", async () => {
    const repeated = syncControlErrorFixtures.find(({ name }) => name === "conflict");
    if (repeated === undefined) throw new Error("missing repeated fixture");
    await withServer(
      () => ({ status: 500, body: errorEnvelope(repeated) }),
      async (client, requests) => {
        const input = { idempotencyKey: "idempotency:repeat" };
        const first = await executeSyncControlCommand("pause", input, {
          client,
          correlationId: "cli:repeat:1",
        });
        const second = await executeSyncControlCommand("pause", input, {
          client,
          correlationId: "cli:repeat:2",
        });
        expect(first).toEqual(second);
        expect(requests).toHaveLength(2);
        expect(requests[0]?.body).toEqual(input);
        expect(requests[1]?.body).toEqual(input);
      },
    );

    const rejected = syncControlErrorFixtures.find(({ name }) => name === "rejected");
    if (rejected === undefined) throw new Error("missing rejected fixture");
    const invalidOrder: SyncControlErrorFixture = {
      ...rejected,
      command: "pause",
      response: { ...rejected.response, command: "pause", reason: "busy" },
    };
    await withServer(
      () => ({
        status: 500,
        body: {
          code: "sync.control-rejected",
          message: "Sync control was rejected.",
          correlationId: "request:invalid-order",
          details: invalidOrder.response,
        },
      }),
      async (client, requests) => {
        const result = await executeSyncControlCommand(
          "pause",
          { idempotencyKey: "idempotency:invalid-order" },
          { client, correlationId: "cli:invalid-order" },
        );
        expect(result.kind).toBe("failure");
        if (result.kind !== "failure") throw new Error("expected invalid order failure");
        expect(result.semanticKind).toBe("conflict");
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("rejects invalid requests before transport and never prints delayed pause as success", async () => {
    await withServer(
      () => ({ status: 200, body: {} }),
      async (client, requests) => {
        const result = await executeSyncControlCommand("pause", {}, {
          client,
          correlationId: "cli:invalid-input",
        });
        expect(result.kind).toBe("failure");
        if (result.kind !== "failure") throw new Error("expected invalid input failure");
        expect(result.semanticKind).toBe("invalid_input");
        expect(requests).toHaveLength(0);
      },
    );

    const delayedPause = syncControlErrorFixtures.find(({ name }) => name === "timeout");
    if (delayedPause === undefined) throw new Error("missing timeout fixture");
    await withServer(
      () => ({ status: 200, body: errorEnvelope(delayedPause) }),
      async (client) => {
        const result = await executeSyncControlCommand(
          "pause",
          { idempotencyKey: "idempotency:delayed-pause" },
          { client, correlationId: "cli:delayed-pause" },
        );
        expect(result.kind).toBe("failure");
        if (result.kind !== "failure") throw new Error("expected delayed pause failure");
        expect(result.semanticKind).toBe("temporary");
        const human = await render(result, "human");
        expect(human.exitCode).toBe(75);
        expect(human.stdout).toBe("");
        expect(human.stderr).toContain("sync.control-timeout");
        expect(human.stderr).not.toContain("state=paused");
      },
    );
  });

  it("parses all four requests from the shared contract without local fields", () => {
    expect(parseSyncControlRequest("start", {})).toEqual({ command: "start", input: {} });
    expect(parseSyncControlRequest("pause", { idempotencyKey: "key:pause" })).toEqual({
      command: "pause",
      input: { idempotencyKey: "key:pause" },
    });
    expect(() => parseSyncControlRequest("resume", {})).toThrow();
    expect(() => parseSyncControlRequest("stop", { idempotencyKey: "key:stop", retry: true })).toThrow();
  });

  it("accepts canonical argv paths and rejects local retry/positional policy", async () => {
    let calls = 0;
    const client: Pick<CliClient, "request"> = {
      request: async ({ operation, input }): Promise<CliResponse> => {
        calls += 1;
        expect(typeof operation === "string" ? operation : operation.key).toBe("sync.pause");
        expect(input).toEqual({ idempotencyKey: "key:argv" });
        return {
          kind: "success",
          operationKey: "sync.pause",
          status: 200,
          data: {
            accepted: true,
            commandId: "command:argv",
            completed: true,
            observed: { actorState: "paused", incarnationId: "incarnation:argv", version: 8 },
          },
        };
      },
    };
    const result = await runSyncControlCommand({
      argv: ["sync", "pause", "--idempotency-key", "key:argv"],
      client,
      correlationId: "cli:argv",
    });
    expect(result.kind).toBe("value");
    expect(calls).toBe(1);
    const invalid = await runSyncControlCommand({
      argv: ["sync", "pause", "key:argv"],
      client,
      correlationId: "cli:argv-invalid",
    });
    expect(invalid).toMatchObject({ kind: "failure", semanticKind: "usage" });
    expect(calls).toBe(1);
  });

  it("renders wrong-operation and non-value responses as protocol 76 without stdout", async () => {
    const wrongOperationClient: Pick<CliClient, "request"> = {
      request: async (): Promise<CliResponse> => ({
        kind: "success",
        operationKey: "sync.pause",
        status: 200,
        data: {
          accepted: true,
          commandId: "command:wrong-operation",
          completed: true,
          observed: { actorState: "paused", incarnationId: "incarnation:wrong", version: 1 },
        },
      }),
    };
    const wrongOperation = await executeSyncControlCommand("start", {}, {
      client: wrongOperationClient,
      correlationId: "cli:wrong-operation",
    });
    const wrongRendered = await render(wrongOperation, "human");
    expect(wrongRendered.exitCode).toBe(76);
    expect(wrongRendered.stdout).toBe("");
    expect(wrongRendered.stderr).toContain("cli.protocol");
    expect(wrongRendered.stderr).toContain("cli:wrong-operation");

    const nonValueClient: Pick<CliClient, "request"> = {
      request: async (): Promise<CliResponse> => ({
        kind: "stream",
        operationKey: "sync.start",
        status: 200,
        stream: {
          operationKey: "sync.start",
          body: (async function* (): AsyncGenerator<Uint8Array> {})(),
          cancel: async () => {},
        },
      }),
    };
    const nonValue = await executeSyncControlCommand("start", {}, {
      client: nonValueClient,
      correlationId: "cli:non-value",
    });
    const nonValueRendered = await render(nonValue, "human");
    expect(nonValueRendered.exitCode).toBe(76);
    expect(nonValueRendered.stdout).toBe("");
    expect(nonValueRendered.stderr).toContain("cli.protocol");
    expect(nonValueRendered.stderr).toContain("cli:non-value");
  });
});
