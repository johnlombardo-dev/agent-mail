import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { publicErrorEnvelopeSchema } from "@agent-mail/contracts";
import {
  decodeExportStream,
  ExportStreamDecoder,
  type ExportFrame,
} from "../../daemon/src/export-stream-framing";
import {
  SelectedExportError,
  createSelectedExportStreamingApp,
  createSqliteSelectedExportSource,
  type SelectedExportSource,
} from "../../daemon/src/selected-export-stream";
import {
  createSearchCursorIntegrityCodec,
  digestNormalizedSearchQuery,
} from "../../storage/src/search-cursor";
import { compileSearchQuery } from "../../storage/src/search-query-compiler";
import { compileStructuredFilters } from "../../storage/src/structured-filter-compiler";
import {
  executeCommand,
  type CommandExecutionContextV1,
  type CommandResultV1,
  type CommandSink,
  type SinkWriteResultV1,
} from "./command-outcome";
import {
  CliClientError,
  createCliClient,
  type CliClient,
  type CliByteStream,
  type CliRequestOptions,
  type CliResponse,
} from "./client";
import {
  executeSelectedExport,
  parseSelectedExportArgv,
  runSelectedExportCommand,
  SELECTED_EXPORT_ARGV,
  SELECTED_EXPORT_OPERATION_KEY,
} from "./selected-export-command";
import {
  fixtureMessageId,
  fixtureStream,
  SELECTED_EXPORT_CORPUS_SIZE,
  SELECTED_EXPORT_QUERY,
  SELECTED_EXPORT_QUERY_DIGEST,
} from "./selected-export.fixtures";

const selectedPositions = Object.freeze([3, 104_729, 249_999]);

type SinkStats = Readonly<{
  readonly sink: CommandSink;
  readonly chunks: Uint8Array[];
  readonly writes: () => number;
  readonly maxOutstandingBytes: () => number;
  readonly maxConcurrentWrites: () => number;
  readonly peakRssBytes: () => number;
}>;

function rssBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  return Math.max(process.memoryUsage().rss, process.platform === "linux" ? maxRss * 1_024 : maxRss);
}

function sinkFixture(
  options: Readonly<{
    readonly delayMs?: number;
    readonly failureAfter?: number;
    readonly failureCode?: string;
    readonly retain?: boolean;
    readonly onWrite?: (bytes: Uint8Array) => void;
    readonly delayEvery?: number;
  }> = {},
): SinkStats {
  const chunks: Uint8Array[] = [];
  let writes = 0;
  let outstanding = 0;
  let maxOutstanding = 0;
  let activeWrites = 0;
  let maxConcurrent = 0;
  let peakRss = rssBytes();
  const sink: CommandSink = {
    isTTY: false,
    write: async (bytes: Uint8Array): Promise<SinkWriteResultV1> => {
      writes += 1;
      activeWrites += 1;
      maxConcurrent = Math.max(maxConcurrent, activeWrites);
      outstanding += bytes.byteLength;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      peakRss = Math.max(peakRss, rssBytes());
      try {
        options.onWrite?.(bytes);
        if (
          options.delayMs !== undefined &&
          (options.delayEvery === undefined || writes % options.delayEvery === 0)
        )
          await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
        if (options.failureAfter !== undefined && writes >= options.failureAfter) {
          return {
            kind: "failed",
            errorCode: options.failureCode ?? "EPIPE",
            bytesAccepted: "unknown",
          };
        }
        if (options.retain !== false) chunks.push(bytes.slice());
        return { kind: "written", bytesAccepted: bytes.byteLength };
      } finally {
        outstanding -= bytes.byteLength;
        activeWrites -= 1;
        peakRss = Math.max(peakRss, rssBytes());
      }
    },
  };
  return {
    sink,
    chunks,
    writes: () => writes,
    maxOutstandingBytes: () => maxOutstanding,
    maxConcurrentWrites: () => maxConcurrent,
    peakRssBytes: () => peakRss,
  };
}

function context(
  stdout: CommandSink,
  options: Readonly<{
    readonly stderr?: CommandSink;
    readonly signal?: AbortSignal;
    readonly mode?: "raw" | "json";
  }> = {},
): CommandExecutionContextV1 {
  return {
    invocationCorrelationId: "cli:selected-export-test",
    mode: options.mode ?? "raw",
    stdout,
    stderr: options.stderr ?? sinkFixture().sink,
    rawPolicy: { destination: "pipe", tty: "refuse" },
    signal: options.signal ?? new AbortController().signal,
  };
}

function streamResponse(
  positions: readonly number[],
  options: Readonly<{ readonly chunkSize?: number }> = {},
): Readonly<{
  readonly response: CliResponse;
  readonly cancelled: () => boolean;
  readonly cancelCalls: () => number;
  readonly finallyCalls: () => number;
  readonly pulls: () => number;
  readonly postTerminalPulls: () => number;
}> {
  const fixture = fixtureStream(positions, options);
  const stream: CliByteStream = {
    operationKey: SELECTED_EXPORT_OPERATION_KEY,
    body: fixture.body,
    cancel: fixture.cancel,
  };
  return {
    response: { kind: "stream", operationKey: SELECTED_EXPORT_OPERATION_KEY, status: 200, stream },
    cancelled: fixture.cancelled,
    cancelCalls: fixture.cancelCalls,
    finallyCalls: fixture.finallyCalls,
    pulls: fixture.pulls,
    postTerminalPulls: fixture.postTerminalPulls,
  };
}

function clientFixture(response: CliResponse): Readonly<{
  readonly client: Pick<CliClient, "request">;
  readonly calls: readonly CliRequestOptions[];
}> {
  const calls: CliRequestOptions[] = [];
  return {
    calls,
    client: {
      request: async (options: CliRequestOptions): Promise<CliResponse> => {
        calls.push(options);
        return response;
      },
    },
  };
}

const composedCorpusSize = 250_000;
const composedUnrelatedStride = 250;
const composedBlobSize = 2_048;
const composedBlobContent = new Uint8Array(
  Array.from({ length: composedBlobSize }, (_, index) => (index * 37) % 251),
);
const composedBlobDigest = createHash("sha256").update(composedBlobContent).digest("hex");
const interruptedBlobContent = new Uint8Array(4 * 1024 * 1024).fill(0x6d);
const composedAccountId = "account:fixture";
const composedMailboxId = "mailbox:inbox";

function composedMessageId(position: number): string {
  return fixtureMessageId(position);
}

function createComposedDatabase(
  corpusSize = composedCorpusSize,
  blobDigest = composedBlobDigest,
  blobSize = composedBlobSize,
): Database {
  const database = new Database(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE messages (message_id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE mailbox_checkpoints (
      account_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, uid_validity INTEGER NOT NULL,
      PRIMARY KEY (account_id, mailbox_id, uid_validity)
    );
    CREATE TABLE remote_placements (
      account_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, uid_validity INTEGER NOT NULL,
      uid INTEGER NOT NULL, message_id TEXT NOT NULL, tombstone_observed_at TEXT,
      tombstone_reason TEXT, internal_date TEXT, flags_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (account_id, mailbox_id, uid_validity, uid)
    );
    CREATE INDEX remote_placements_search ON remote_placements(account_id, message_id, tombstone_observed_at);
    CREATE TABLE message_headers (
      message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT NOT NULL,
      normalized_name TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL,
      PRIMARY KEY (message_id, ordinal)
    );
    CREATE TABLE message_addresses (
      message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL,
      position INTEGER NOT NULL, address TEXT NOT NULL, normalized_address TEXT NOT NULL,
      display_name TEXT, group_name TEXT, PRIMARY KEY (message_id, ordinal)
    );
    CREATE TABLE message_body_parts (
      message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, content_type TEXT NOT NULL,
      normalized_content_type TEXT NOT NULL, blob_id TEXT NOT NULL, plain_text TEXT NOT NULL,
      html_derived_text TEXT NOT NULL, PRIMARY KEY (message_id, ordinal)
    );
    CREATE INDEX message_body_parts_message ON message_body_parts(message_id);
    CREATE TABLE message_attachments (
      message_id TEXT NOT NULL, ordinal INTEGER NOT NULL, filename TEXT,
      content_type TEXT NOT NULL, normalized_content_type TEXT NOT NULL,
      disposition TEXT, content_id TEXT, blob_id TEXT NOT NULL, size INTEGER NOT NULL,
      PRIMARY KEY (message_id, ordinal)
    );
    CREATE TABLE message_blob_references (
      message_id TEXT NOT NULL, kind TEXT NOT NULL, ordinal INTEGER NOT NULL,
      blob_id TEXT NOT NULL, size INTEGER NOT NULL,
      PRIMARY KEY (message_id, kind, ordinal)
    );
    CREATE TABLE message_search_documents (document_id INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE);
    CREATE VIEW indexed_messages AS
      SELECT d.document_id AS rowid, m.message_id AS message_id,
        '' AS subject, '' AS participants,
        COALESCE((SELECT group_concat(p.plain_text, ' ') FROM message_body_parts p WHERE p.message_id = m.message_id), '') AS body_plain,
        '' AS body_html, '' AS attachment_names
      FROM message_search_documents d JOIN messages m ON m.message_id = d.message_id;
    CREATE VIRTUAL TABLE message_fts USING fts5(
      subject, participants, body_plain, body_html, attachment_names,
      content='indexed_messages', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  database
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, 1);")
    .run(composedAccountId, composedMailboxId);
  const insertMessage = database.query("INSERT INTO messages (message_id) VALUES (?);");
  const insertPlacement = database.query(
    "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date) VALUES (?, ?, 1, ?, ?, NULL);",
  );
  const insertBody = database.query(
    "INSERT INTO message_body_parts (message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text, html_derived_text) VALUES (?, 1, 'text/plain', 'text/plain', ?, ?, '');",
  );
  const insertReference = database.query(
      "INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, 'raw-eml', 1, ?, ?);",
  );
  const insertDocument = database.query(
    "INSERT INTO message_search_documents (document_id, message_id) VALUES (?, ?);",
  );
  const populate = database.transaction(() => {
    for (let position = 1; position <= corpusSize; position += 1) {
      const messageId = composedMessageId(position);
      const selected = position % composedUnrelatedStride === 0;
      insertMessage.run(messageId);
      insertPlacement.run(composedAccountId, composedMailboxId, position, messageId);
      insertBody.run(messageId, blobDigest, selected ? "selected" : "unrelated");
      insertReference.run(messageId, blobDigest, blobSize);
      insertDocument.run(position, messageId);
    }
  });
  populate();
  database.exec("INSERT INTO message_fts(message_fts) VALUES ('rebuild');");
  return database;
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
  streamIdleMs = 5_000,
): Promise<Readonly<{
  readonly client: CliClient;
  readonly close: () => Promise<void>;
  readonly aborted: () => number;
}>> {
  let aborted = 0;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const requestAbort = new AbortController();
    let downstreamClosed = false;
    const abortRequest = () => requestAbort.abort();
    request.on("aborted", () => {
      aborted += 1;
      abortRequest();
    });
    request.socket.once("close", abortRequest);
    response.on("close", () => {
      downstreamClosed = true;
      abortRequest();
    });
    const body: Uint8Array[] = [];
    request.on("data", (chunk: Buffer) => body.push(new Uint8Array(chunk)));
    request.on("end", () => {
      void (async () => {
        try {
          const payload = body.length === 0 ? undefined : Buffer.concat(body);
          const apiResponse = await app.fetch(
            new Request(`http://127.0.0.1${request.url ?? "/"}`, {
              method: request.method,
              headers: requestHeaders(request),
              body: payload,
              duplex: "half",
              signal: requestAbort.signal,
            }),
          );
          response.writeHead(apiResponse.status, Object.fromEntries(apiResponse.headers));
          if (apiResponse.body === null) {
            response.end();
            return;
          }
          const reader = apiResponse.body.getReader();
          try {
            while (true) {
              if (downstreamClosed || response.destroyed || response.closed) break;
              const next = await reader.read();
              if (next.done) break;
              if (!response.write(next.value)) {
                await new Promise<void>((resolve) => {
                  const finish = () => {
                    response.off("drain", finish);
                    response.off("close", finish);
                    resolve();
                  };
                  response.once("drain", finish);
                  response.once("close", finish);
                });
              }
              await new Promise<void>((resolve) => setImmediate(resolve));
              if (downstreamClosed || response.destroyed || response.closed) break;
            }
          } finally {
            await reader.cancel();
          }
          response.end();
        } catch {
          response.destroy();
        }
      })();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
  return {
    client: createCliClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      authorization: "Bearer selected-export-fixture",
      timeouts: { controlMs: 60_000, streamIdleMs },
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    aborted: () => aborted,
  };
}

async function waitForExactCleanup(
  isClean: () => boolean,
  timeoutMs = 500,
  detail?: () => string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!isClean() && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (!isClean()) throw new Error(`cleanup remained live: ${detail?.() ?? "unknown"}`);
}

async function withComposedFixture(
  run: (input: Readonly<{ readonly client: CliClient; readonly database: Database; readonly aborted: () => number }>) => Promise<void>,
  sourceOverride?: (source: SelectedExportSource) => SelectedExportSource,
  corpusSize = composedCorpusSize,
  streamIdleMs = 5_000,
  blobContent = composedBlobContent,
): Promise<void> {
  const blobDigest = createHash("sha256").update(blobContent).digest("hex");
  const database = createComposedDatabase(corpusSize, blobDigest, blobContent.byteLength);
  const directory = await mkdtemp(join(tmpdir(), "agent-mail-selected-export-"));
  await writeFile(join(directory, blobDigest), blobContent);
  const source = createSqliteSelectedExportSource({
    database,
    accountId: composedAccountId,
    canonicalDirectory: directory,
    cursorCodec: createSearchCursorIntegrityCodec("selected-export-fixture-secret"),
  });
  const app = createSelectedExportStreamingApp({
    source: sourceOverride?.(source) ?? source,
    authenticate: () => ({
      kind: "authenticated" as const,
      principal: { subject: "operator:selected-export-fixture", scopes: ["mail:export.selected"] },
    }),
  });
  const server = await startHonoServer(app, streamIdleMs);
  try {
    await run({ client: server.client, database, aborted: server.aborted });
  } finally {
    await server.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("selected-export CLI request adapter", () => {
  it("maps a query to the exact shared request and keeps the response stream raw", async () => {
    const selected = streamResponse(selectedPositions, { chunkSize: 17 });
    const fixture = clientFixture(selected.response);
    const result = await runSelectedExportCommand({
      argv: [...SELECTED_EXPORT_ARGV, "--query", SELECTED_EXPORT_QUERY],
      client: fixture.client,
      correlationId: "cli:query",
    });
    expect(result.kind).toBe("raw");
    expect(fixture.calls).toHaveLength(1);
    expect(
      typeof fixture.calls[0]?.operation === "string"
        ? fixture.calls[0]?.operation
        : fixture.calls[0]?.operation.key,
    ).toBe(SELECTED_EXPORT_OPERATION_KEY);
    expect(fixture.calls[0]?.input).toEqual({
      selection: { kind: "query", query: SELECTED_EXPORT_QUERY },
    });
    expect(result.kind === "raw" ? result.stream.metadata : undefined).toBeUndefined();
    expect(selected.cancelled()).toBe(false);
  });

  it("maps repeated identity input, rejects export-all and rejects mixed selection", () => {
    expect(
      parseSelectedExportArgv([
        ...SELECTED_EXPORT_ARGV,
        "--message-id",
        fixtureMessageId(1),
        `--message-id=${fixtureMessageId(2)}`,
      ]),
    ).toEqual({
      selection: { kind: "identities", messageIds: [fixtureMessageId(1), fixtureMessageId(2)] },
    });
    expect(() => parseSelectedExportArgv([...SELECTED_EXPORT_ARGV])).toThrow();
    expect(() =>
      parseSelectedExportArgv([
        ...SELECTED_EXPORT_ARGV,
        "--query",
        SELECTED_EXPORT_QUERY,
        "--message-id",
        fixtureMessageId(1),
      ]),
    ).toThrow();
    expect(() =>
      parseSelectedExportArgv([
        ...SELECTED_EXPORT_ARGV,
        "--message-id",
        fixtureMessageId(1),
        "--message-id",
        fixtureMessageId(1),
      ]),
    ).toThrow();
  });

  it("rejects an empty identity set before opening the client", async () => {
    const fixture = clientFixture(streamResponse(selectedPositions).response);
    const result = await executeSelectedExport(
      { kind: "identities", messageIds: [] },
      { client: fixture.client, correlationId: "cli:empty" },
    );
    expect(result).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("preserves authorization failure and malformed stream protocol outcomes", async () => {
    const forbidden = new CliClientError("http_error", SELECTED_EXPORT_OPERATION_KEY, "forbidden", {
      status: 403,
      serverError: publicErrorEnvelopeSchema.parse({
        code: "insufficient_scope",
        message: "insufficient scope",
        correlationId: "request:forbidden",
        details: {},
      }),
    });
    const unauthorizedClient: Pick<CliClient, "request"> = {
      request: async (): Promise<CliResponse> => {
        throw forbidden;
      },
    };
    const unauthorized = await executeSelectedExport(
      { kind: "query", query: SELECTED_EXPORT_QUERY },
      { client: unauthorizedClient, correlationId: "cli:unauthorized" },
    );
    expect(unauthorized).toMatchObject({ kind: "failure", semanticKind: "authorization" });

    const malformed = await executeSelectedExport(
      { kind: "query", query: SELECTED_EXPORT_QUERY },
      {
        client: clientFixture({
          kind: "success",
          operationKey: SELECTED_EXPORT_OPERATION_KEY,
          status: 200,
          data: {},
        }).client,
        correlationId: "cli:malformed",
      },
    );
    expect(malformed).toMatchObject({ kind: "failure", semanticKind: "protocol" });
  });
});

describe("selected-export CLI stream executor seam", () => {
  it("decodes selected identities and attribution through a throttled sink", async () => {
    const selected = streamResponse(selectedPositions, { chunkSize: 17 });
    const fixture = clientFixture(selected.response);
    const result = await executeSelectedExport(
      { kind: "query", query: SELECTED_EXPORT_QUERY },
      { client: fixture.client, correlationId: "cli:slow" },
    );
    const output = sinkFixture({ delayMs: 1 });
    const baseline = rssBytes();
    const receipt = await executeCommand(result, context(output.sink));
    const decoded = [];
    for await (const frame of decodeExportStream(output.chunks)) decoded.push(frame);
    expect(receipt).toMatchObject({
      semanticKind: "success",
      exitCode: 0,
      cleanupAwaited: true,
    });
    expect(decoded.map((frame) => frame.attribution.messageId)).toEqual(
      selectedPositions.map(fixtureMessageId),
    );
    expect(decoded.every((frame) => frame.attribution.provenance.source === "selected-export")).toBe(true);
    expect(decoded.every((frame) => frame.attribution.provenance.selectionQueryDigest === SELECTED_EXPORT_QUERY_DIGEST)).toBe(true);
    expect(output.maxOutstandingBytes()).toBeLessThanOrEqual(17);
    expect(output.maxConcurrentWrites()).toBe(1);
    expect(output.peakRssBytes() - baseline).toBeLessThan(32 * 1024 * 1024);
    expect(selected.cancelled()).toBe(true);
    expect(selected.cancelCalls()).toBe(1);
    expect(selected.finallyCalls()).toBe(1);
    expect(selected.pulls()).toBeGreaterThan(0);
    expect(selected.postTerminalPulls()).toBe(0);
  });

  it("cancels upstream exactly once on EPIPE and never retries", async () => {
    const selected = streamResponse(selectedPositions, { chunkSize: 17 });
    const fixture = clientFixture(selected.response);
    const result = await executeSelectedExport(
      { kind: "query", query: SELECTED_EXPORT_QUERY },
      { client: fixture.client, correlationId: "cli:epipe" },
    );
    const output = sinkFixture({ failureAfter: 2 });
    const receipt = await executeCommand(result, context(output.sink));
    expect(receipt).toMatchObject({ semanticKind: "partial_output", exitCode: 141, cleanupAwaited: true });
    expect(output.writes()).toBe(2);
    expect(selected.cancelled()).toBe(true);
    expect(selected.cancelCalls()).toBe(1);
    expect(selected.finallyCalls()).toBe(1);
    expect(selected.pulls()).toBeGreaterThan(0);
    expect(selected.postTerminalPulls()).toBe(0);
    expect(fixture.calls).toHaveLength(1);
  });

  it("maps caller cancellation to cancellation and awaits stream cleanup", async () => {
    const selected = streamResponse(selectedPositions, { chunkSize: 17 });
    const fixture = clientFixture(selected.response);
    const result = await executeSelectedExport(
      { kind: "query", query: SELECTED_EXPORT_QUERY },
      { client: fixture.client, correlationId: "cli:cancel" },
    );
    const controller = new AbortController();
    const output = sinkFixture({ delayMs: 10 });
    controller.abort();
    const receipt = await executeCommand(result, context(output.sink, { signal: controller.signal }));
    expect(receipt).toMatchObject({ semanticKind: "cancelled", exitCode: 84, cleanupAwaited: true });
    expect(selected.cancelled()).toBe(true);
    expect(selected.cancelCalls()).toBe(1);
    expect(selected.finallyCalls()).toBe(0);
    expect(selected.pulls()).toBe(0);
    expect(selected.postTerminalPulls()).toBe(0);
  });

  it("maps a stalled body to the shared idle-timeout outcome", async () => {
    let cancelled = false;
    const stalled: CliByteStream = {
      operationKey: SELECTED_EXPORT_OPERATION_KEY,
      body: (async function* (): AsyncGenerator<Uint8Array> {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        throw new CliClientError(
          "stream_idle_timeout",
          SELECTED_EXPORT_OPERATION_KEY,
          "stream idle deadline elapsed",
        );
      })(),
      cancel: async (): Promise<void> => {
        cancelled = true;
      },
    };
    const result = await executeSelectedExport(
      { kind: "query", query: SELECTED_EXPORT_QUERY },
      {
        client: clientFixture({
          kind: "stream",
          operationKey: SELECTED_EXPORT_OPERATION_KEY,
          status: 200,
          stream: stalled,
        }).client,
        correlationId: "cli:stall",
      },
    );
    const output = sinkFixture();
    const receipt = await executeCommand(result, context(output.sink));
    expect(receipt).toMatchObject({ semanticKind: "temporary", exitCode: 75, cleanupAwaited: true });
    expect(output.chunks).toHaveLength(0);
    expect(cancelled).toBe(true);
  });

  it("keeps the 250k corpus bound explicit while only selected AMEX records cross stdout", async () => {
    expect(SELECTED_EXPORT_CORPUS_SIZE).toBe(250_000);
    const selected = streamResponse(selectedPositions, { chunkSize: 1_024 });
    const fixture = clientFixture(selected.response);
    const result: CommandResultV1 = await executeSelectedExport(
      { kind: "query", query: SELECTED_EXPORT_QUERY },
      { client: fixture.client, correlationId: "cli:250k" },
    );
    const output = sinkFixture({ delayMs: 1 });
    const receipt = await executeCommand(result, context(output.sink));
    expect(receipt.semanticKind).toBe("success");
    const decoded = [];
    for await (const frame of decodeExportStream(output.chunks)) decoded.push(frame);
    expect(decoded.map((frame) => frame.attribution.messageId)).toEqual(
      selectedPositions.map(fixtureMessageId),
    );
    expect(output.maxOutstandingBytes()).toBeLessThanOrEqual(1_024);
    expect(selected.cancelled()).toBe(true);
    // The output remains a stream; this test intentionally does not retain a full export.
    expect(output.chunks.length).toBeGreaterThan(0);
  });
});

function expectedComposedCount(corpusSize: number): number {
  return Math.floor(corpusSize / composedUnrelatedStride);
}

type ComposedSourceProbe = {
  pagesStarted: number;
  pagesCompleted: number;
  pagesInFlight: number;
  maxPagesInFlight: number;
  readsStarted: number;
  readsCompleted: number;
  readsInFlight: number;
  maxReadsInFlight: number;
  sourceCompleted: boolean;
  firstStdoutWriteObserved: boolean;
  firstStdoutBeforeSourceCompletion: boolean | undefined;
};

function composedSourceProbe(): ComposedSourceProbe {
  return {
    pagesStarted: 0,
    pagesCompleted: 0,
    pagesInFlight: 0,
    maxPagesInFlight: 0,
    readsStarted: 0,
    readsCompleted: 0,
    readsInFlight: 0,
    maxReadsInFlight: 0,
    sourceCompleted: false,
    firstStdoutWriteObserved: false,
    firstStdoutBeforeSourceCompletion: undefined,
  };
}

function instrumentComposedSource(
  source: SelectedExportSource,
  probe: ComposedSourceProbe,
  expectedRecords: number,
): SelectedExportSource {
  const readBlob = source.readBlob;
  if (readBlob === undefined) throw new Error("composed source has no blob reader");
  return {
    ...source,
    page: async (input) => {
      probe.pagesStarted += 1;
      probe.pagesInFlight += 1;
      probe.maxPagesInFlight = Math.max(probe.maxPagesInFlight, probe.pagesInFlight);
      try {
        return await source.page(input);
      } finally {
        probe.pagesCompleted += 1;
        probe.pagesInFlight -= 1;
      }
    },
    readBlob: (blob, signal) => {
      probe.readsStarted += 1;
      probe.readsInFlight += 1;
      probe.maxReadsInFlight = Math.max(probe.maxReadsInFlight, probe.readsInFlight);
      const iterator = readBlob(blob, signal)[Symbol.asyncIterator]();
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        probe.readsCompleted += 1;
        probe.readsInFlight -= 1;
        if (probe.readsCompleted === expectedRecords) probe.sourceCompleted = true;
      };
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          try {
            const result = await iterator.next();
            if (result.done) finish();
            return result;
          } catch (error: unknown) {
            finish();
            throw error;
          }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          try {
            return iterator.return === undefined
              ? { done: true, value: undefined }
              : await iterator.return(undefined);
          } finally {
            finish();
          }
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}

function metadataMessageId(frame: ExportFrame): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(frame.content));
  } catch {
    throw new Error("selected export metadata is not JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("messageId" in parsed) ||
    typeof parsed.messageId !== "string"
  )
    throw new Error("selected export metadata has no message identity");
  return parsed.messageId;
}

describe("selected-export real API/storage composition", () => {
  it(
    "streams a 250k SQLite selection through the real Hono route and CLI with exact AMEX frames and bounded RSS",
    async () => {
      const corpusSize = composedCorpusSize;
      const expectedCount = expectedComposedCount(corpusSize);
      const probe = composedSourceProbe();
      await withComposedFixture(async ({ client, database }) => {
        const countRow: unknown = database.query("SELECT COUNT(*) AS count FROM messages;").get();
        if (typeof countRow !== "object" || countRow === null || !("count" in countRow))
          throw new Error("composed fixture count query returned no count");
        expect(countRow.count).toBe(corpusSize);
        const result = await executeSelectedExport(
          { kind: "query", query: "selected" },
          { client, correlationId: "cli:composed-250k" },
        );
        expect(result.kind).toBe("raw");
        const decoder = new ExportStreamDecoder();
        let expectedPosition = composedUnrelatedStride;
        let records = 0;
        let metadataFrames = 0;
        let rawFrames = 0;
        const compiledQuery = compileSearchQuery("selected");
        const compiledFilters = compileStructuredFilters([]);
        if (compiledQuery.kind !== "compiled" || compiledFilters.kind !== "compiled")
          throw new Error("composed fixture query did not compile");
        const expectedSelectionDigest = digestNormalizedSearchQuery(compiledQuery, compiledFilters);
        const baselineRss = rssBytes();
        const output = sinkFixture({
          retain: false,
          delayMs: 1,
          onWrite: (bytes) => {
            if (!probe.firstStdoutWriteObserved) {
              probe.firstStdoutWriteObserved = true;
              probe.firstStdoutBeforeSourceCompletion = !probe.sourceCompleted;
            }
            for (const frame of decoder.push(bytes)) {
              const expectedId = composedMessageId(expectedPosition);
              expect(frame.attribution.messageId).toBe(expectedId);
              expect(frame.attribution.provenance.source).toBe("selected-export");
              const frameSelectionDigest = frame.attribution.provenance.selectionQueryDigest;
              expect(frameSelectionDigest).toBe(expectedSelectionDigest);
              switch (frame.kind) {
                case "metadata":
                  expect(metadataMessageId(frame)).toBe(expectedId);
                  expect(frame.attribution.contentSize).toBe(frame.content.byteLength);
                  expect(frame.attribution.contentDigest).toBe(
                    createHash("sha256").update(frame.content).digest("hex"),
                  );
                  metadataFrames += 1;
                  break;
                case "raw":
                  expect(frame.content).toEqual(composedBlobContent);
                  expect(frame.attribution.contentSize).toBe(composedBlobSize);
                  expect(frame.attribution.contentDigest).toBe(composedBlobDigest);
                  rawFrames += 1;
                  records += 1;
                  expectedPosition += composedUnrelatedStride;
                  break;
                case "attachment": {
                  const exhaustive: never = frame.kind;
                  void exhaustive;
                  throw new Error("unexpected attachment frame");
                }
                default: {
                  const exhaustive: never = frame.kind;
                  void exhaustive;
                  throw new Error("unknown selected export frame");
                }
              }
            }
          },
        });
        if (result.kind !== "raw") throw new Error("selected export did not return a stream");
        const receipt = await executeCommand(result, context(output.sink));
        decoder.finish();
        expect(receipt).toMatchObject({
          semanticKind: "success",
          exitCode: 0,
          cleanupAwaited: true,
        });
        expect(records).toBe(expectedCount);
        expect(metadataFrames).toBe(expectedCount);
        expect(rawFrames).toBe(expectedCount);
        expect(probe.firstStdoutWriteObserved).toBe(true);
        // A response-buffering implementation completes every source read before
        // this first write and therefore fails this deterministic ordering proof.
        expect(probe.firstStdoutBeforeSourceCompletion).toBe(true);
        expect(probe.sourceCompleted).toBe(true);
        expect(probe.pagesStarted).toBe(probe.pagesCompleted);
        expect(probe.maxPagesInFlight).toBe(1);
        expect(probe.readsStarted).toBe(expectedCount);
        expect(probe.readsCompleted).toBe(expectedCount);
        expect(probe.maxReadsInFlight).toBe(1);
        expect(output.maxOutstandingBytes()).toBeLessThanOrEqual(64 * 1024);
        expect(output.maxConcurrentWrites()).toBe(1);
        expect(output.peakRssBytes() - baselineRss).toBeLessThan(96 * 1024 * 1024);
      }, (source) => instrumentComposedSource(source, probe, expectedCount), corpusSize);
    },
    180_000,
  );

  it("keeps real composed empty, unauthorized, EPIPE, cancellation, and stall outcomes fail-closed", async () => {
    const interruptedCorpusSize = 25_000;
    const interruptedRecordCount =
      interruptedCorpusSize - expectedComposedCount(interruptedCorpusSize);
    const emptyProbe = composedSourceProbe();
    await withComposedFixture(async ({ client }) => {
      const empty = await executeSelectedExport(
        { kind: "query", query: "absent-from-fixture" },
        { client, correlationId: "cli:composed-empty" },
      );
      const emptyOutput = sinkFixture();
      const emptyReceipt = await executeCommand(
        empty,
        context(emptyOutput.sink, { mode: "json" }),
      );
      expect(emptyReceipt).toMatchObject({ semanticKind: "internal", exitCode: 70 });
      expect(emptyReceipt.stdoutBytesAccepted).toBe(0);
      expect(emptyOutput.chunks).toHaveLength(0);
      expect(emptyProbe.pagesStarted).toBe(1);
      expect(emptyProbe.pagesCompleted).toBe(1);
      expect(emptyProbe.readsStarted).toBe(0);
      expect(emptyProbe.readsCompleted).toBe(0);
    }, (source) => instrumentComposedSource(source, emptyProbe, 3), 3);

    const epipeProbe = composedSourceProbe();
    await withComposedFixture(
      async ({ client }) => {
        const epipeResult = await executeSelectedExport(
          { kind: "query", query: "unrelated" },
          { client, correlationId: "cli:composed-epipe" },
        );
        let readsAtFirstWrite = 0;
        const epipeOutput = sinkFixture({
          failureAfter: 1,
          onWrite: () => {
            if (readsAtFirstWrite === 0) readsAtFirstWrite = epipeProbe.readsStarted;
          },
        });
        const epipeReceipt = await executeCommand(epipeResult, context(epipeOutput.sink));
        await waitForExactCleanup(
          () =>
            epipeProbe.readsCompleted === epipeProbe.readsStarted &&
            epipeProbe.readsInFlight === 0 &&
            epipeProbe.pagesCompleted === epipeProbe.pagesStarted &&
            epipeProbe.pagesInFlight === 0,
          500,
          () => JSON.stringify(epipeProbe),
        );
        expect(epipeReceipt).toMatchObject({
          semanticKind: "partial_output",
          exitCode: 141,
          cleanupAwaited: true,
        });
        expect(epipeProbe.pagesStarted).toBeGreaterThan(0);
        expect(epipeProbe.pagesCompleted).toBe(epipeProbe.pagesStarted);
        expect(epipeProbe.pagesInFlight).toBe(0);
        expect(epipeProbe.maxPagesInFlight).toBe(1);
        expect(readsAtFirstWrite).toBeGreaterThan(0);
        expect(readsAtFirstWrite).toBeLessThanOrEqual(3);
        expect(epipeProbe.readsStarted).toBeLessThan(interruptedRecordCount);
        expect(epipeProbe.readsCompleted).toBe(epipeProbe.readsStarted);
        expect(epipeProbe.readsInFlight).toBe(0);
        expect(epipeProbe.maxReadsInFlight).toBe(1);
        expect(epipeProbe.sourceCompleted).toBe(false);
      },
      (source) => instrumentComposedSource(source, epipeProbe, interruptedRecordCount),
      interruptedCorpusSize,
      5_000,
      interruptedBlobContent,
    );

    const cancelProbe = composedSourceProbe();
    await withComposedFixture(
      async ({ client }) => {
        const controller = new AbortController();
        const cancelledResult = await executeSelectedExport(
          { kind: "query", query: "unrelated" },
          { client, correlationId: "cli:composed-cancel" },
        );
        let readsAtFirstWrite = 0;
        const cancelledOutput = sinkFixture({
          onWrite: () => {
            readsAtFirstWrite = cancelProbe.readsStarted;
            controller.abort();
          },
        });
        const cancelledReceipt = await executeCommand(
          cancelledResult,
          context(cancelledOutput.sink, { signal: controller.signal }),
        );
        await waitForExactCleanup(
          () =>
            cancelProbe.readsCompleted === cancelProbe.readsStarted &&
            cancelProbe.readsInFlight === 0 &&
            cancelProbe.pagesCompleted === cancelProbe.pagesStarted &&
            cancelProbe.pagesInFlight === 0,
        );
        expect(cancelledReceipt).toMatchObject({
          semanticKind: "partial_output",
          exitCode: 88,
          cleanupAwaited: true,
        });
        expect(cancelledOutput.chunks.length).toBeGreaterThan(0);
        expect(cancelProbe.pagesStarted).toBeGreaterThan(0);
        expect(cancelProbe.pagesCompleted).toBe(cancelProbe.pagesStarted);
        expect(cancelProbe.pagesInFlight).toBe(0);
        expect(cancelProbe.maxPagesInFlight).toBe(1);
        expect(readsAtFirstWrite).toBeGreaterThan(0);
        expect(readsAtFirstWrite).toBeLessThanOrEqual(3);
        expect(cancelProbe.readsStarted).toBeLessThan(interruptedRecordCount);
        expect(cancelProbe.readsCompleted).toBe(cancelProbe.readsStarted);
        expect(cancelProbe.readsInFlight).toBe(0);
        expect(cancelProbe.maxReadsInFlight).toBe(1);
        expect(cancelProbe.sourceCompleted).toBe(false);
      },
      (source) => instrumentComposedSource(source, cancelProbe, interruptedRecordCount),
      interruptedCorpusSize,
      5_000,
      interruptedBlobContent,
    );

    const unauthorizedProbe = composedSourceProbe();
    await withComposedFixture(
      async ({ client }) => {
        const unauthorized = await executeSelectedExport(
          { kind: "query", query: "unrelated" },
          { client, correlationId: "cli:composed-unauthorized" },
        );
        const output = sinkFixture();
        const receipt = await executeCommand(unauthorized, context(output.sink, { mode: "json" }));
        expect(receipt).toMatchObject({ semanticKind: "internal", exitCode: 70 });
        expect(receipt.stdoutBytesAccepted).toBe(0);
        expect(output.chunks).toHaveLength(0);
        expect(unauthorizedProbe.pagesStarted).toBe(1);
        expect(unauthorizedProbe.pagesCompleted).toBe(1);
        expect(unauthorizedProbe.readsStarted).toBe(0);
        expect(unauthorizedProbe.readsCompleted).toBe(0);
      },
      (source) =>
        instrumentComposedSource(
          { ...source, authorize: async () => false },
          unauthorizedProbe,
          3,
        ),
      3,
      40,
    );

    let blobReads = 0;
    let blobFinalizers = 0;
    let stalledBlobTerminated = false;
    await withComposedFixture(
      async ({ client }) => {
        const stalled = await executeSelectedExport(
          { kind: "query", query: "unrelated" },
          { client, correlationId: "cli:composed-stall" },
        );
        const output = sinkFixture();
        const receipt = await executeCommand(stalled, context(output.sink));
        expect(receipt).toMatchObject({
          semanticKind: "partial_output",
          exitCode: 88,
          cleanupAwaited: true,
        });
        expect(output.chunks.length).toBeGreaterThan(0);
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
        expect(blobReads).toBe(2);
        expect(blobFinalizers).toBe(2);
        expect(stalledBlobTerminated).toBe(true);
      },
      (source) => ({
        ...source,
        readBlob: async function* (_blob, _signal) {
          blobReads += 1;
          try {
            if (blobReads === 1) {
              yield composedBlobContent;
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
            stalledBlobTerminated = true;
            throw new SelectedExportError("cancelled");
          } finally {
            blobFinalizers += 1;
          }
        },
      }),
      3,
      40,
    );
  }, 60_000);
});
