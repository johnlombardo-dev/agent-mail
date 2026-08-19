import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { publicErrorEnvelopeSchema } from "@agent-mail/contracts";
import {
  executeCommand,
  type CommandExecutionContextV1,
  type CommandSink,
} from "./command-outcome";
import {
  CliClientError,
  type CliClient,
  type CliByteStream,
  type CliRequestOptions,
  type CliResponse,
} from "./client";
import {
  executeAttachmentCommand,
  executeRawContentCommand,
  executeRawMessageCommand,
} from "./raw-content-command";

const messageId = `message:${"a".repeat(64)}`;
const attachmentId = `attachment:${"b".repeat(64)}`;
const chunkSize = 64 * 1024;
const largeFixtureBytes = 64 * 1024 * 1024;
const peakRssGrowthBoundBytes = 32 * 1024 * 1024;

type StreamFixture = Readonly<{
  readonly stream: CliByteStream;
  readonly cancelCount: () => number;
  readonly closed: () => boolean;
}>;

function chunksFor(totalBytes: number): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < totalBytes; offset += chunkSize) {
    const chunk = new Uint8Array(Math.min(chunkSize, totalBytes - offset));
    for (let index = 0; index < chunk.byteLength; index += 1)
      chunk[index] = (offset + index * 13) % 251;
    chunks.push(chunk);
  }
  return chunks;
}

function generatedChunk(offset: number, totalBytes: number): Uint8Array {
  const chunk = new Uint8Array(Math.min(chunkSize, totalBytes - offset));
  for (let index = 0; index < chunk.byteLength; index += 1)
    chunk[index] = (offset + index * 13) % 251;
  return chunk;
}

function generatedDigest(totalBytes: number): string {
  const digest = createHash("sha256");
  for (let offset = 0; offset < totalBytes; offset += chunkSize)
    digest.update(generatedChunk(offset, totalBytes));
  return digest.digest("hex");
}

function currentRssBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  const maxRssBytes = process.platform === "linux" ? maxRss * 1_024 : maxRss;
  return Math.max(process.memoryUsage().rss, maxRssBytes);
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function streamFixture(
  operationKey: "messages.raw" | "attachments.get",
  chunks: readonly Uint8Array[],
  filename: string | null = null,
): StreamFixture {
  let cancelCount = 0;
  let wasClosed = false;
  const body = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for (const chunk of chunks) {
        if (wasClosed) return;
        yield chunk;
      }
    } finally {
      wasClosed = true;
    }
  })();
  const stream: CliByteStream = Object.freeze({
    operationKey,
    metadata: {
      contentType: "application/octet-stream",
      contentLength: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      digest: "c".repeat(64),
      filename,
    },
    body,
    cancel: async (): Promise<void> => {
      cancelCount += 1;
      wasClosed = true;
      await body.return();
    },
  });
  return Object.freeze({
    stream,
    cancelCount: () => cancelCount,
    closed: () => wasClosed,
  });
}

function generatedStreamFixture(
  operationKey: "messages.raw" | "attachments.get",
  totalBytes: number,
  observe: () => void,
): StreamFixture {
  let cancelCount = 0;
  let wasClosed = false;
  const body = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for (let offset = 0; offset < totalBytes; offset += chunkSize) {
        if (wasClosed) return;
        const chunk = generatedChunk(offset, totalBytes);
        observe();
        yield chunk;
      }
    } finally {
      wasClosed = true;
    }
  })();
  const stream: CliByteStream = Object.freeze({
    operationKey,
    metadata: {
      contentType: "application/octet-stream",
      contentLength: totalBytes,
      digest: generatedDigest(totalBytes),
      filename: null,
    },
    body,
    cancel: async (): Promise<void> => {
      cancelCount += 1;
      wasClosed = true;
      await body.return();
    },
  });
  return Object.freeze({
    stream,
    cancelCount: () => cancelCount,
    closed: () => wasClosed,
  });
}

type ClientFixture = Readonly<{
  readonly client: Pick<CliClient, "request">;
  readonly calls: readonly CliRequestOptions[];
}>;

function clientFixture(response: CliResponse): ClientFixture {
  const calls: CliRequestOptions[] = [];
  return Object.freeze({
    calls,
    client: {
      request: async (options: CliRequestOptions): Promise<CliResponse> => {
        calls.push(options);
        return response;
      },
    },
  });
}

function outputSink(
  options: Readonly<{
    readonly delayMs?: number;
    readonly failure?: Readonly<{ readonly errorCode: string; readonly bytesAccepted: number | "unknown" }>;
    readonly failureAfterWrites?: number;
    readonly writes?: { count: number };
    readonly retain?: boolean;
    readonly onWrite?: (chunk: Uint8Array) => void;
  }> = {},
): CommandSink & {
  readonly bytes: Uint8Array[];
  readonly maxInFlight: () => number;
  readonly maxOutstandingBytes: () => number;
} {
  const bytes: Uint8Array[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  let outstandingBytes = 0;
  let maximumOutstandingBytes = 0;
  let writeCount = 0;
  const writes = options.writes;
  const sink: CommandSink & {
    readonly bytes: Uint8Array[];
    readonly maxInFlight: () => number;
    readonly maxOutstandingBytes: () => number;
  } = {
    bytes,
    isTTY: false,
    maxInFlight: () => maximumInFlight,
    maxOutstandingBytes: () => maximumOutstandingBytes,
    write: async (chunk: Uint8Array) => {
      writeCount += 1;
      if (writes !== undefined) writes.count = writeCount;
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      outstandingBytes += chunk.byteLength;
      maximumOutstandingBytes = Math.max(maximumOutstandingBytes, outstandingBytes);
      options.onWrite?.(chunk);
      if (options.delayMs !== undefined)
        await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs));
      inFlight -= 1;
      outstandingBytes -= chunk.byteLength;
      if (
        options.failure !== undefined &&
        (options.failureAfterWrites === undefined ||
          writeCount >= options.failureAfterWrites)
      )
        return { kind: "failed", ...options.failure };
      if (options.retain !== false) bytes.push(chunk.slice());
      return { kind: "written", bytesAccepted: chunk.byteLength };
    },
  };
  return sink;
}

function context(
  stdout: CommandSink,
  options: Readonly<{
    readonly mode?: "raw" | "json";
    readonly rawDestination?: "tty" | "pipe";
    readonly rawTty?: "refuse" | "allow";
    readonly signal?: AbortSignal;
    readonly terminalSignal?: "SIGINT" | "SIGTERM";
    readonly stderr?: CommandSink;
    readonly cleanup?: () => Promise<void>;
  }> = {},
): CommandExecutionContextV1 {
  const signal = options.signal ?? new AbortController().signal;
  return {
    invocationCorrelationId: "cli:raw-fixture",
    mode: options.mode ?? "raw",
    stdout,
    stderr: options.stderr ?? outputSink(),
    rawPolicy: {
      destination: options.rawDestination ?? "pipe",
      tty: options.rawTty ?? "refuse",
    },
    signal,
    terminalSignal: options.terminalSignal,
    cleanup: options.cleanup,
  };
}

describe("raw-message and attachment CLI command adapters", () => {
  it("maps exact shared requests and preserves raw stream identity", async () => {
    const messageSource = streamFixture("messages.raw", []);
    const messageClient = clientFixture({
      kind: "stream",
      operationKey: "messages.raw",
      status: 200,
      stream: messageSource.stream,
    });
    const messageResult = await executeRawMessageCommand(messageId, {
      client: messageClient.client,
      correlationId: "cli:message",
    });
    expect(messageClient.calls).toHaveLength(1);
    expect(messageClient.calls[0]).toMatchObject({ input: { messageId }, signal: undefined });
    const messageCall = messageClient.calls[0];
    if (messageCall === undefined) throw new Error("message request was not recorded");
    expect(messageCall.operation).toMatchObject({ key: "messages.raw", route: "/v1/messages/{messageId}/raw" });
    expect(messageResult).toMatchObject({ kind: "raw", operationKey: "messages.raw", semanticKind: "success" });
    if (messageResult.kind === "raw") expect(messageResult.stream).toBe(messageSource.stream);

    const attachmentSource = streamFixture("attachments.get", []);
    const attachmentClient = clientFixture({
      kind: "stream",
      operationKey: "attachments.get",
      status: 200,
      stream: attachmentSource.stream,
    });
    const attachmentResult = await executeAttachmentCommand(attachmentId, {
      client: attachmentClient.client,
      correlationId: "cli:attachment",
    });
    expect(attachmentClient.calls[0]).toMatchObject({ input: { attachmentId } });
    expect(attachmentResult).toMatchObject({ kind: "raw", operationKey: "attachments.get" });
  });

  it("rejects invalid IDs without making a request and keeps target dispatch discriminated", async () => {
    const source = streamFixture("messages.raw", []);
    const fixture = clientFixture({ kind: "stream", operationKey: "messages.raw", status: 200, stream: source.stream });
    const invalid = await executeRawMessageCommand("not-a-message", {
      client: fixture.client,
      correlationId: "cli:invalid",
    });
    expect(invalid).toMatchObject({ kind: "failure", operationKey: "messages.raw", semanticKind: "invalid_input", error: { code: "cli.invalid-input" } });
    expect(fixture.calls).toHaveLength(0);

    const dispatched = await executeRawContentCommand(
      { kind: "attachment", id: attachmentId },
      { client: fixture.client, correlationId: "cli:dispatch" },
    );
    expect(dispatched).toMatchObject({ kind: "failure", operationKey: "attachments.get", semanticKind: "protocol" });
    expect(fixture.calls).toHaveLength(1);
  });

  it("maps not-found, authorization, and malformed stream responses through shared outcomes", async () => {
    const notFoundClient = {
      request: async (): Promise<CliResponse> => {
        throw new CliClientError("http_error", "messages.raw", "missing", {
          status: 404,
          serverError: publicErrorEnvelopeSchema.parse({
            code: "not_found",
            message: "raw message not found",
            correlationId: "request:not-found",
            details: { resource: "raw-message", id: messageId },
          }),
        });
      },
    };
    const notFound = await executeRawMessageCommand(messageId, {
      client: notFoundClient,
      correlationId: "cli:not-found",
    });
    expect(notFound).toMatchObject({ kind: "failure", semanticKind: "not_found", error: { code: "not_found" } });

    const unauthorizedClient = {
      request: async (): Promise<CliResponse> => {
        throw new CliClientError("http_error", "attachments.get", "forbidden", {
          status: 403,
          serverError: publicErrorEnvelopeSchema.parse({
            code: "insufficient_scope",
            message: "insufficient scope",
            correlationId: "request:forbidden",
            details: {},
          }),
        });
      },
    };
    const unauthorized = await executeAttachmentCommand(attachmentId, {
      client: unauthorizedClient,
      correlationId: "cli:auth",
    });
    expect(unauthorized).toMatchObject({ kind: "failure", semanticKind: "authorization", error: { code: "insufficient_scope" } });

    const malformed = clientFixture({ kind: "success", operationKey: "messages.raw", status: 200, data: {} });
    const malformedResult = await executeRawMessageCommand(messageId, {
      client: malformed.client,
      correlationId: "cli:malformed",
    });
    expect(malformedResult).toMatchObject({ kind: "failure", semanticKind: "protocol", error: { code: "cli.protocol" } });

    const corruptClient = {
      request: async (): Promise<CliResponse> => {
        throw new CliClientError(
          "client_contract_error",
          "attachments.get",
          "corrupt stream metadata",
        );
      },
    };
    const corrupt = await executeAttachmentCommand(attachmentId, {
      client: corruptClient,
      correlationId: "cli:corrupt",
    });
    expect(corrupt).toMatchObject({ kind: "failure", semanticKind: "protocol", error: { code: "cli.protocol" } });
  });
});

describe("raw content composed stream fixtures", () => {
  it("streams a large chunked fixture byte-for-byte with bounded sink concurrency", async () => {
    const expectedDigest = generatedDigest(largeFixtureBytes);
    const baselineRssBytes = currentRssBytes();
    let peakRssBytes = baselineRssBytes;
    const observeRss = (): void => {
      peakRssBytes = Math.max(peakRssBytes, currentRssBytes());
    };
    const source = generatedStreamFixture("messages.raw", largeFixtureBytes, observeRss);
    const client = clientFixture({ kind: "stream", operationKey: "messages.raw", status: 200, stream: source.stream });
    const result = await executeRawMessageCommand(messageId, { client: client.client, correlationId: "cli:large" });
    const actualDigest = createHash("sha256");
    let actualBytes = 0;
    let comparedBytes = 0;
    let mismatchOffset: number | null = null;
    const sink = outputSink({
      delayMs: 1,
      retain: false,
      onWrite: (chunk) => {
        for (let index = 0; index < chunk.byteLength; index += 1) {
          const expectedByte = (comparedBytes + index * 13) % 251;
          if (chunk[index] !== expectedByte && mismatchOffset === null)
            mismatchOffset = comparedBytes + index;
        }
        comparedBytes += chunk.byteLength;
        actualDigest.update(chunk);
        actualBytes += chunk.byteLength;
        observeRss();
      },
    });
    const receipt = await executeCommand(result, context(sink));
    observeRss();

    expect(receipt).toMatchObject({ semanticKind: "success", exitCode: 0, stdoutBytesAccepted: largeFixtureBytes, stderrBytesAccepted: 0, cleanupAwaited: true });
    expect(actualBytes).toBe(largeFixtureBytes);
    expect(comparedBytes).toBe(largeFixtureBytes);
    expect(mismatchOffset).toBeNull();
    expect(actualDigest.digest("hex")).toBe(expectedDigest);
    expect(sink.maxInFlight()).toBe(1);
    expect(sink.maxOutstandingBytes()).toBeLessThanOrEqual(chunkSize);
    expect(peakRssBytes - baselineRssBytes).toBeLessThan(peakRssGrowthBoundBytes);
    expect(source.cancelCount()).toBe(1);
    expect(source.closed()).toBe(true);
  });

  it("supports zero-byte streams and does not leak hostile attachment filenames to stderr", async () => {
    const source = streamFixture("attachments.get", [], "evil\r\nX-Agent-Mail: forged\u0000.bin");
    const client = clientFixture({ kind: "stream", operationKey: "attachments.get", status: 200, stream: source.stream });
    const result = await executeAttachmentCommand(attachmentId, { client: client.client, correlationId: "cli:zero" });
    const stdout = outputSink();
    const stderr = outputSink();
    const receipt = await executeCommand(result, context(stdout, { stderr }));

    expect(receipt).toMatchObject({ semanticKind: "success", exitCode: 0, stdoutBytesAccepted: 0, stderrBytesAccepted: 0 });
    expect(stdout.bytes).toHaveLength(0);
    expect(stderr.bytes).toHaveLength(0);
    expect(source.cancelCount()).toBe(1);
  });

  it("refuses TTY raw output by default, allows explicit override, and awaits cleanup", async () => {
    const refusedSource = streamFixture("messages.raw", chunksFor(1));
    const refusedClient = clientFixture({ kind: "stream", operationKey: "messages.raw", status: 200, stream: refusedSource.stream });
    const refusedResult = await executeRawMessageCommand(messageId, { client: refusedClient.client, correlationId: "cli:tty" });
    const refusedStdout = outputSink();
    const refusedStderr = outputSink();
    const refusedReceipt = await executeCommand(refusedResult, context(refusedStdout, { rawDestination: "tty", stderr: refusedStderr }));
    expect(refusedReceipt).toMatchObject({ semanticKind: "usage", exitCode: 64, stdoutBytesAccepted: 0, cleanupAwaited: true });
    expect(refusedStdout.bytes).toHaveLength(0);
    expect(refusedStderr.bytes).not.toHaveLength(0);
    expect(refusedSource.cancelCount()).toBe(1);

    const allowedSource = streamFixture("messages.raw", [new Uint8Array([0, 255, 1])]);
    const allowedClient = clientFixture({ kind: "stream", operationKey: "messages.raw", status: 200, stream: allowedSource.stream });
    const allowedResult = await executeRawMessageCommand(messageId, { client: allowedClient.client, correlationId: "cli:tty-allow" });
    const allowedStdout = outputSink();
    const allowedReceipt = await executeCommand(allowedResult, context(allowedStdout, { rawDestination: "tty", rawTty: "allow" }));
    expect(allowedReceipt).toMatchObject({ semanticKind: "success", exitCode: 0 });
    expect(joined(allowedStdout.bytes)).toEqual(new Uint8Array([0, 255, 1]));
  });

  it("returns usage for non-raw mode without opening output and cleans up", async () => {
    const source = streamFixture("messages.raw", chunksFor(1));
    const client = clientFixture({ kind: "stream", operationKey: "messages.raw", status: 200, stream: source.stream });
    const result = await executeRawMessageCommand(messageId, { client: client.client, correlationId: "cli:mode" });
    const stdout = outputSink();
    const stderr = outputSink();
    const receipt = await executeCommand(result, context(stdout, { mode: "json", stderr }));
    expect(receipt).toMatchObject({ semanticKind: "usage", exitCode: 64, stdoutBytesAccepted: 0, cleanupAwaited: true });
    expect(stdout.bytes).toHaveLength(0);
    expect(stderr.bytes).not.toHaveLength(0);
    expect(source.cancelCount()).toBe(1);
  });

  it("cancels on EPIPE with partial-output receipt and never retries", async () => {
    const source = streamFixture("messages.raw", chunksFor(chunkSize * 3));
    const client = clientFixture({ kind: "stream", operationKey: "messages.raw", status: 200, stream: source.stream });
    const result = await executeRawMessageCommand(messageId, { client: client.client, correlationId: "cli:epipe" });
    const writes = { count: 0 };
    const stdout = outputSink({
      writes,
      failureAfterWrites: 2,
      failure: { errorCode: "EPIPE", bytesAccepted: "unknown" },
    });
    const receipt = await executeCommand(result, context(stdout));

    expect(receipt).toMatchObject({ semanticKind: "partial_output", exitCode: 141, cleanupAwaited: true });
    expect(writes.count).toBe(2);
    expect(source.cancelCount()).toBe(1);
    expect(stdout.bytes).toHaveLength(1);
  });

  it("maps SIGINT during a progressing write to cancellation without stderr", async () => {
    const source = streamFixture("messages.raw", [new Uint8Array([1, 2, 3])]);
    const client = clientFixture({ kind: "stream", operationKey: "messages.raw", status: 200, stream: source.stream });
    const result = await executeRawMessageCommand(messageId, { client: client.client, correlationId: "cli:signal" });
    const controller = new AbortController();
    const stdout = outputSink({ delayMs: 10 });
    const stderr = outputSink();
    setTimeout(() => controller.abort("SIGINT"), 1);
    const receipt = await executeCommand(result, context(stdout, { signal: controller.signal, terminalSignal: "SIGINT", stderr }));

    expect(receipt).toMatchObject({ semanticKind: "cancelled", exitCode: 130, cleanupAwaited: true });
    expect(stderr.bytes).toHaveLength(0);
    expect(source.cancelCount()).toBe(1);
  });

  it("marks unknown acceptance as partial output without placing raw bytes on stderr", async () => {
    const source = streamFixture("attachments.get", [new Uint8Array([0, 255, 1])]);
    const client = clientFixture({ kind: "stream", operationKey: "attachments.get", status: 200, stream: source.stream });
    const result = await executeAttachmentCommand(attachmentId, { client: client.client, correlationId: "cli:unknown" });
    const stdout = outputSink({ failure: { errorCode: "EIO", bytesAccepted: "unknown" } });
    const stderr = outputSink();
    const receipt = await executeCommand(result, context(stdout, { stderr }));

    expect(receipt).toMatchObject({ semanticKind: "partial_output", exitCode: 88, cleanupAwaited: true });
    expect(joined(stderr.bytes)).not.toEqual(new Uint8Array([0, 255, 1]));
    expect(source.cancelCount()).toBe(1);
  });
});
