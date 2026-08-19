import * as http from "node:http";
import * as https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { TextDecoder } from "node:util";
import {
  createOperationRegistry,
  httpErrorRegistry,
  parseErrorDefinition,
  publicErrorEnvelopeSchema,
  streamMetadataSchema,
  type ErrorRegistry,
  type OperationDefinition,
  type OperationRegistry,
  type PublicErrorEnvelope,
} from "@agent-mail/contracts";
import { cliCommandDefinitions } from "./command-registry";

/** The three transport phases deliberately have independent deadlines. */
export type CliClientTimeouts = Readonly<{
  readonly connectMs: number;
  readonly controlMs: number;
  readonly streamIdleMs: number;
}>;

export const DEFAULT_CLI_CLIENT_TIMEOUTS: CliClientTimeouts = Object.freeze({
  connectMs: 5_000,
  controlMs: 30_000,
  streamIdleMs: 30_000,
});

export type CliClientOptions = Readonly<{
  readonly baseUrl: string;
  readonly authorization?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeouts?: Partial<CliClientTimeouts>;
  readonly registry?: OperationRegistry;
  readonly maxResponseBytes?: number;
}>;

export type CliRequestOptions = Readonly<{
  readonly operation: string | OperationDefinition;
  readonly input: unknown;
  readonly signal?: AbortSignal;
}>;

export type CliByteStream = Readonly<{
  readonly operationKey: string;
  readonly metadata?: unknown;
  readonly body: AsyncIterable<Uint8Array>;
  /** Stop the response and await its owned reader/request cleanup. */
  readonly cancel: () => Promise<void>;
}>;

export type CliSuccess = Readonly<{
  readonly kind: "success";
  readonly operationKey: string;
  readonly status: 200;
  readonly data: unknown;
}>;

export type CliStreamSuccess = Readonly<{
  readonly kind: "stream";
  readonly operationKey: string;
  readonly status: 200;
  readonly stream: CliByteStream;
}>;

export type CliResponse = CliSuccess | CliStreamSuccess;

export type CliClientErrorKind =
  | "connect_timeout"
  | "control_timeout"
  | "stream_idle_timeout"
  | "client_contract_error"
  | "http_error"
  | "aborted"
  | "transport_error";

export class CliClientError extends Error {
  readonly kind: CliClientErrorKind;
  readonly operationKey: string;
  readonly status?: number;
  readonly serverError?: PublicErrorEnvelope;

  public constructor(
    kind: CliClientErrorKind,
    operationKey: string,
    message: string,
    options: Readonly<{
      readonly status?: number;
      readonly serverError?: PublicErrorEnvelope;
    }> = {},
  ) {
    super(message);
    this.name = "CliClientError";
    this.kind = kind;
    this.operationKey = operationKey;
    this.status = options.status;
    this.serverError = options.serverError;
  }
}

const defaultRegistry = createOperationRegistry(
  cliCommandDefinitions.map(({ operation }) => operation),
);

function bounded(value: string, limit = 512): string {
  return value.replaceAll(/[\u0000-\u001f\u007f-\u009f]/gu, "�").slice(0, limit);
}

function detailFor(value: unknown): string {
  if (value instanceof Error) return bounded(value.message);
  if (typeof value === "string") return bounded(value);
  try {
    return bounded(JSON.stringify(value));
  } catch {
    return "unserializable value";
  }
}

function timeoutValue(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function routeParameters(route: string): readonly string[] {
  return [...route.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function queryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("request query value cannot be encoded");
  return encoded;
}

function requestUrl(
  baseUrl: string,
  operation: OperationDefinition,
  input: Record<string, unknown>,
): URL {
  const url = new URL(
    operation.route.replaceAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu, (_, name: string) => {
      const value = input[name];
      if (value === undefined) throw new TypeError(`request is missing route parameter: ${name}`);
      return encodeURIComponent(queryValue(value));
    }),
    baseUrl,
  );
  if (operation.method === "GET") {
    const pathNames = new Set(routeParameters(operation.route));
    for (const [key, value] of Object.entries(input)) {
      if (!pathNames.has(key) && value !== undefined) url.searchParams.set(key, queryValue(value));
    }
  }
  return url;
}

function asBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  throw new TypeError("HTTP response yielded a non-byte chunk");
}

type ConnectedResponse = Readonly<{
  readonly request: http.ClientRequest;
  readonly response: IncomingMessage;
  readonly socket: Socket;
  readonly requestClosed: () => boolean;
  readonly responseClosed: () => boolean;
  readonly socketClosed: () => boolean;
}>;

async function awaitClose(
  resource: Readonly<{
    readonly destroyed: boolean;
    readonly closed?: boolean;
    readonly isClosed?: () => boolean;
    readonly destroy: () => unknown;
    readonly once: (event: string, listener: () => void) => unknown;
    readonly removeListener: (event: string, listener: () => void) => unknown;
  }>,
): Promise<void> {
  if (resource.closed === true || resource.isClosed?.() === true) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resource.removeListener("close", finish);
      resource.removeListener("error", ignoreError);
      resolve();
    };
    const ignoreError = (): void => undefined;
    resource.once("close", finish);
    resource.once("error", ignoreError);
    if (!resource.destroyed) {
      resource.destroy();
    }
    if (resource.isClosed?.() === true) finish();
  });
}

function openRequest(
  url: URL,
  method: string,
  headers: Readonly<Record<string, string>>,
  body: string | undefined,
  operationKey: string,
  timeouts: CliClientTimeouts,
  signal: AbortSignal | undefined,
): Promise<ConnectedResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let request: http.ClientRequest | undefined;
    let socket: Socket | undefined;
    let requestClosed = false;
    let socketClosed = false;
    let settled = false;
    let connected = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let controlTimer: ReturnType<typeof setTimeout> | undefined;
    const rememberSocket = (connectedSocket: Socket): void => {
      if (socket === connectedSocket) return;
      socket = connectedSocket;
      connectedSocket.once("close", () => {
        socketClosed = true;
      });
    };
    const clearTimers = (): void => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (controlTimer !== undefined) clearTimeout(controlTimer);
      connectTimer = undefined;
      controlTimer = undefined;
    };
    const finishError = async (error: CliClientError): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      if (request !== undefined)
        await awaitClose({
          destroyed: request.destroyed,
          isClosed: () => requestClosed || request?.destroyed === true,
          destroy: () => {
            const activeRequest = request;
            if (activeRequest === undefined) return;
            activeRequest.abort();
            return activeRequest.destroy();
          },
          once: (event, listener) => request?.once(event, listener),
          removeListener: (event, listener) => request?.removeListener(event, listener),
        });
      reject(error);
    };
    const onAbort = (): void => {
      request?.destroy();
      void finishError(new CliClientError("aborted", operationKey, "request was aborted"));
    };
    const onConnected = (): void => {
      if (connected || settled) return;
      connected = true;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      controlTimer = setTimeout(() => {
        request?.destroy();
        void finishError(
          new CliClientError("control_timeout", operationKey, "control response deadline elapsed"),
        );
      }, timeouts.controlMs);
    };
    connectTimer = setTimeout(() => {
      request?.destroy();
      void finishError(
        new CliClientError("connect_timeout", operationKey, "connection deadline elapsed"),
      );
    }, timeouts.connectMs);
    try {
      request = transport.request(url, { method, headers, agent: false }, (response) => {
        if (!connected) onConnected();
        if (settled) {
          response.destroy();
          return;
        }
        const requestSocket = request?.socket;
        const connectedSocket = socket ?? requestSocket;
        if (request === undefined || connectedSocket === null || connectedSocket === undefined) {
          response.destroy();
          void finishError(
            new CliClientError("transport_error", operationKey, "HTTP request was not established"),
          );
          return;
        }
        rememberSocket(connectedSocket);
        settled = true;
        clearTimers();
        signal?.removeEventListener("abort", onAbort);
        let responseClosed = false;
        response.once("close", () => {
          responseClosed = true;
        });
        resolve({
          request,
          response,
          socket: connectedSocket,
          requestClosed: () => requestClosed,
          responseClosed: () => responseClosed,
          socketClosed: () => socketClosed,
        });
      });
      request.once("close", () => {
        requestClosed = true;
      });
      request.once("socket", (connectedSocket: Socket) => {
        rememberSocket(connectedSocket);
        if (url.protocol === "https:") connectedSocket.once("secureConnect", onConnected);
        else {
          connectedSocket.once("connect", onConnected);
          if (!connectedSocket.connecting) onConnected();
        }
      });
      request.once("error", (error: Error) => {
        void finishError(
          new CliClientError(
            "transport_error",
            operationKey,
            `HTTP transport failed: ${detailFor(error)}`,
          ),
        );
      });
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      if (body === undefined) request.end();
      else {
        request.setHeader("content-length", Buffer.byteLength(body));
        request.write(body);
        request.end();
      }
    } catch (error: unknown) {
      void finishError(
        new CliClientError(
          "transport_error",
          operationKey,
          `HTTP transport failed: ${detailFor(error)}`,
        ),
      );
    }
  });
}

async function readBody(response: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = asBytes(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error("response exceeds configured size limit");
    chunks.push(bytes);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function contentType(headers: IncomingHttpHeaders): string | undefined {
  const value = headers["content-type"];
  return typeof value === "string" ? value.split(";", 1)[0]?.trim().toLowerCase() : undefined;
}

function assertResponseContentType(
  operation: OperationDefinition,
  headers: IncomingHttpHeaders,
  purpose: "success" | "error",
): void {
  const mediaType = contentType(headers);
  const valid =
    purpose === "error"
      ? mediaType === "application/json" || mediaType?.endsWith("+json") === true
      : operation.streaming === "none"
        ? mediaType === "application/json" || mediaType?.endsWith("+json") === true
        : operation.streaming === "ndjson"
          ? mediaType === "application/x-ndjson"
          : mediaType !== undefined;
  if (!valid) throw new Error(`${purpose} response has an invalid content type`);
}

function parseServerError(
  operation: OperationDefinition,
  payload: unknown,
  status: number,
  errorRegistry: Pick<ErrorRegistry, "get">,
): PublicErrorEnvelope {
  const envelope = publicErrorEnvelopeSchema.safeParse(payload);
  if (!envelope.success)
    throw new Error(`malformed public error envelope: ${detailFor(envelope.error)}`);
  const definition =
    operation.errors.find(({ code }) => code === envelope.data.code) ??
    errorRegistry.get(envelope.data.code);
  if (definition === undefined)
    throw new Error(`unregistered public error code: ${envelope.data.code}`);
  const parsed = parseErrorDefinition(definition, envelope.data);
  if (parsed.code !== envelope.data.code || status !== definition.status)
    throw new Error(`public error status mismatch for ${parsed.code}`);
  return parsed;
}

function metadataFromHeaders(operationKey: string, headers: IncomingHttpHeaders): unknown {
  if (operationKey !== "messages.raw" && operationKey !== "attachments.get") return undefined;
  const contentType = headers["content-type"];
  const contentLength = headers["content-length"];
  const etag = headers.etag;
  if (
    typeof contentType !== "string" ||
    typeof contentLength !== "string" ||
    typeof etag !== "string"
  )
    throw new Error("byte stream is missing required metadata headers");
  const digest = etag.replace(/^"|"$/gu, "");
  const length = Number(contentLength);
  const metadata = streamMetadataSchema.parse({
    contentType,
    contentLength: length,
    digest,
    filename: null,
  });
  return operationKey === "messages.raw" ? metadata : undefined;
}

async function closeOpened(opened: ConnectedResponse): Promise<void> {
  await Promise.all([
    awaitClose({
      destroyed: opened.response.destroyed,
      isClosed: () =>
        opened.responseClosed() || opened.response.closed === true || opened.response.destroyed,
      destroy: () => opened.response.destroy(),
      once: (event, listener) => opened.response.once(event, listener),
      removeListener: (event, listener) => opened.response.removeListener(event, listener),
    }),
    awaitClose({
      destroyed: opened.request.destroyed,
      isClosed: () =>
        opened.requestClosed() || opened.request.closed === true || opened.request.destroyed,
      destroy: () => {
        opened.request.abort();
        return opened.request.destroy();
      },
      once: (event, listener) => opened.request.once(event, listener),
      removeListener: (event, listener) => opened.request.removeListener(event, listener),
    }),
    awaitClose({
      destroyed: opened.socket.destroyed,
      isClosed: () => opened.socketClosed() || opened.socket.destroyed,
      destroy: () => opened.socket.destroy(),
      once: (event, listener) => opened.socket.once(event, listener),
      removeListener: (event, listener) => opened.socket.removeListener(event, listener),
    }),
  ]);
}

export class CliClient {
  readonly #baseUrl: string;
  readonly #authorization: string | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #timeouts: CliClientTimeouts;
  readonly #registry: OperationRegistry;
  readonly #errorRegistry: Pick<ErrorRegistry, "get">;
  readonly #maxResponseBytes: number;

  public constructor(options: CliClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
      throw new TypeError("baseUrl must use HTTP or HTTPS");
    this.#baseUrl = baseUrl.toString();
    this.#authorization = options.authorization;
    this.#headers = Object.freeze({ ...options.headers });
    this.#timeouts = Object.freeze({
      connectMs: timeoutValue(
        options.timeouts?.connectMs,
        DEFAULT_CLI_CLIENT_TIMEOUTS.connectMs,
        "connectMs",
      ),
      controlMs: timeoutValue(
        options.timeouts?.controlMs,
        DEFAULT_CLI_CLIENT_TIMEOUTS.controlMs,
        "controlMs",
      ),
      streamIdleMs: timeoutValue(
        options.timeouts?.streamIdleMs,
        DEFAULT_CLI_CLIENT_TIMEOUTS.streamIdleMs,
        "streamIdleMs",
      ),
    });
    this.#registry = options.registry ?? defaultRegistry;
    this.#errorRegistry = httpErrorRegistry;
    this.#maxResponseBytes = timeoutValue(
      options.maxResponseBytes,
      4 * 1024 * 1024,
      "maxResponseBytes",
    );
  }

  public async request(options: CliRequestOptions): Promise<CliResponse> {
    const operation =
      typeof options.operation === "string"
        ? this.#registry.get(options.operation)
        : options.operation;
    if (operation === undefined) throw new TypeError("unknown CLI operation");
    let parsedInput: unknown;
    try {
      parsedInput = this.#registry.parseRequest(operation.key, options.input);
    } catch (error: unknown) {
      throw new CliClientError(
        "client_contract_error",
        operation.key,
        `request contract rejected: ${detailFor(error)}`,
      );
    }
    if (typeof parsedInput !== "object" || parsedInput === null || Array.isArray(parsedInput))
      throw new CliClientError(
        "client_contract_error",
        operation.key,
        "request contract must be an object",
      );
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsedInput)) input[key] = value;
    let url: URL;
    try {
      url = requestUrl(this.#baseUrl, operation, input);
    } catch (error: unknown) {
      throw new CliClientError(
        "client_contract_error",
        operation.key,
        `request route rejected: ${detailFor(error)}`,
      );
    }
    const headers: Record<string, string> = { ...this.#headers, accept: "application/json" };
    if (this.#authorization !== undefined) headers.authorization = this.#authorization;
    const body = operation.method === "GET" ? undefined : JSON.stringify(input);
    if (body !== undefined) headers["content-type"] = "application/json";
    const opened = await openRequest(
      url,
      operation.method,
      headers,
      body,
      operation.key,
      this.#timeouts,
      options.signal,
    );
    const status = opened.response.statusCode ?? 0;
    if (status !== 200) {
      let payload: unknown;
      try {
        assertResponseContentType(operation, opened.response.headers, "error");
        payload = responseJson(await readBody(opened.response, this.#maxResponseBytes));
        await closeOpened(opened);
      } catch (error: unknown) {
        await closeOpened(opened);
        throw new CliClientError(
          "client_contract_error",
          operation.key,
          `malformed error response: ${detailFor(error)}`,
          { status },
        );
      }
      try {
        const serverError = parseServerError(operation, payload, status, this.#errorRegistry);
        throw new CliClientError("http_error", operation.key, serverError.message, {
          status,
          serverError,
        });
      } catch (error: unknown) {
        if (error instanceof CliClientError) throw error;
        throw new CliClientError(
          "client_contract_error",
          operation.key,
          `malformed error response: ${detailFor(error)}`,
          { status },
        );
      }
    }
    if (operation.streaming !== "none") {
      try {
        assertResponseContentType(operation, opened.response.headers, "success");
      } catch (error: unknown) {
        await closeOpened(opened);
        throw new CliClientError(
          "client_contract_error",
          operation.key,
          `success response contract rejected: ${detailFor(error)}`,
          { status: 200 },
        );
      }
      let metadata: unknown;
      try {
        metadata = metadataFromHeaders(operation.key, opened.response.headers);
      } catch (error: unknown) {
        await closeOpened(opened);
        throw new CliClientError(
          "client_contract_error",
          operation.key,
          `stream metadata contract rejected: ${detailFor(error)}`,
          { status: 200 },
        );
      }
      const stream = this.#stream(
        operation,
        opened.request,
        opened.response,
        opened.socket,
        metadata,
        options.signal,
        opened.requestClosed,
        opened.responseClosed,
        opened.socketClosed,
      );
      return Object.freeze({ kind: "stream", operationKey: operation.key, status: 200, stream });
    }
    let data: unknown;
    try {
      assertResponseContentType(operation, opened.response.headers, "success");
      data = responseJson(await readBody(opened.response, this.#maxResponseBytes));
      data = this.#registry.parseResponse(operation.key, data);
      await closeOpened(opened);
    } catch (error: unknown) {
      await closeOpened(opened);
      throw new CliClientError(
        "client_contract_error",
        operation.key,
        `success response contract rejected: ${detailFor(error)}`,
        { status: 200 },
      );
    }
    return Object.freeze({ kind: "success", operationKey: operation.key, status: 200, data });
  }

  #stream(
    operation: OperationDefinition,
    request: http.ClientRequest,
    response: IncomingMessage,
    socket: Socket,
    metadata: unknown,
    signal: AbortSignal | undefined,
    requestClosed: () => boolean,
    responseClosed: () => boolean,
    socketClosed: () => boolean,
  ): CliByteStream {
    let done = false;
    let aborted = false;
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const armIdle = (): void => {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        response.destroy();
      }, streamIdleMs);
    };
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      if (cleanupPromise !== undefined) return cleanupPromise;
      cleanupPromise = (async (): Promise<void> => {
        done = true;
        clearIdle();
        signal?.removeEventListener("abort", onAbort);
        await Promise.all([
          awaitClose({
            destroyed: response.destroyed,
            isClosed: () => responseClosed() || response.closed === true || response.destroyed,
            destroy: () => response.destroy(),
            once: (event, listener) => response.once(event, listener),
            removeListener: (event, listener) => response.removeListener(event, listener),
          }),
          awaitClose({
            destroyed: request.destroyed,
            isClosed: () => requestClosed() || request.closed === true || request.destroyed,
            destroy: () => {
              request.abort();
              return request.destroy();
            },
            once: (event, listener) => request.once(event, listener),
            removeListener: (event, listener) => request.removeListener(event, listener),
          }),
          awaitClose({
            destroyed: socket.destroyed,
            isClosed: () => socketClosed() || socket.destroyed,
            destroy: () => socket.destroy(),
            once: (event, listener) => socket.once(event, listener),
            removeListener: (event, listener) => socket.removeListener(event, listener),
          }),
        ]);
      })();
      return cleanupPromise;
    };
    const onAbort = (): void => {
      aborted = true;
      void cleanup();
    };
    const streamIdleMs = this.#timeouts.streamIdleMs;
    armIdle();
    const body = (async function* (): AsyncGenerator<Uint8Array> {
      try {
        if (signal !== undefined && signal.aborted)
          throw new CliClientError("aborted", operation.key, "stream was aborted");
        for await (const chunk of response) {
          if (aborted || (signal !== undefined && signal.aborted))
            throw new CliClientError("aborted", operation.key, "stream was aborted");
          if (done) return;
          clearIdle();
          const bytes = asBytes(chunk);
          armIdle();
          yield bytes;
        }
        if (idleTimedOut) throw new Error("stream idle deadline elapsed");
      } catch (error: unknown) {
        if (aborted || (signal !== undefined && signal.aborted))
          throw new CliClientError("aborted", operation.key, "stream was aborted");
        if (done) return;
        if (idleTimedOut)
          throw new CliClientError(
            "stream_idle_timeout",
            operation.key,
            "stream idle deadline elapsed",
          );
        throw new CliClientError(
          "transport_error",
          operation.key,
          `stream transport failed: ${detailFor(error)}`,
        );
      } finally {
        await cleanup();
      }
    })();
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return Object.freeze({ operationKey: operation.key, metadata, body, cancel: cleanup });
  }
}

export function createCliClient(options: CliClientOptions): CliClient {
  return new CliClient(options);
}
