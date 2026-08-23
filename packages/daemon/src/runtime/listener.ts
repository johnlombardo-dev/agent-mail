import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export type CanonicalHttpListener = Readonly<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly activeConnections: () => number;
}>;

export type CanonicalHttpListenerInput = Readonly<{
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly maxRequestBodyBytes: number;
  readonly fetch: (request: Request) => Promise<Response>;
}>;

export type CanonicalHttpListenerFactory = (
  input: CanonicalHttpListenerInput,
) => Promise<CanonicalHttpListener>;

function headersFrom(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return headers;
}

async function requestBytes(incoming: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const value of incoming) {
    const chunk = value instanceof Uint8Array ? value : Buffer.from(value);
    const accepted = chunk.subarray(0, Math.min(chunk.byteLength, maximum + 1 - received));
    chunks.push(new Uint8Array(accepted));
    received += accepted.byteLength;
    if (received > maximum) {
      incoming.destroy();
      break;
    }
  }
  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function toRequest(
  incoming: IncomingMessage,
  input: CanonicalHttpListenerInput,
): Promise<Request> {
  const body = await requestBytes(incoming, input.maxRequestBodyBytes);
  const method = incoming.method ?? "GET";
  return new Request(
    `http://${input.host}:${input.port}${incoming.url?.startsWith("/") ? incoming.url : "/"}`,
    {
      method,
      headers: headersFrom(incoming),
      body:
        method === "GET" || method === "HEAD" || body.byteLength === 0
          ? undefined
          : Buffer.from(body),
    },
  );
}

async function forwardResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (response.body === null) {
    outgoing.end();
    return;
  }
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    if (!outgoing.write(chunk)) await once(outgoing, "drain");
  }
  outgoing.end();
}

function normalizeListenerInput(input: CanonicalHttpListenerInput): void {
  if (input.host !== "127.0.0.1") throw new TypeError("canonical daemon listener must use loopback");
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new TypeError("canonical daemon listener port is invalid");
  }
  if (!Number.isSafeInteger(input.maxRequestBodyBytes) || input.maxRequestBodyBytes <= 0) {
    throw new TypeError("canonical daemon HTTP body limit is invalid");
  }
  if (typeof input.fetch !== "function") throw new TypeError("canonical HTTP fetch is invalid");
}

/** Bind one loopback listener with bounded request materialization and owned sockets. */
export async function createLoopbackHttpListener(
  input: CanonicalHttpListenerInput,
): Promise<CanonicalHttpListener> {
  normalizeListenerInput(input);
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        await forwardResponse(await input.fetch(await toRequest(incoming, input)), outgoing);
      } catch {
        if (!outgoing.headersSent) outgoing.statusCode = 500;
        outgoing.end();
      }
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const candidate = server;
      if (candidate === undefined) return reject(new Error("canonical listener is unavailable"));
      const onError = (error: Error): void => {
        candidate.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        candidate.off("error", onError);
        resolve();
      };
      candidate.once("error", onError);
      candidate.once("listening", onListening);
      candidate.listen(input.port, input.host);
    });
  } catch (error: unknown) {
    for (const socket of sockets) socket.destroy();
    server.close();
    throw error;
  }

  const close = (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve();
    closed = true;
    closePromise = new Promise<void>((resolve, reject) => {
      const candidate = server;
      if (candidate === undefined || !candidate.listening) {
        for (const socket of sockets) socket.destroy();
        resolve();
        return;
      }
      candidate.close((error) => (error === undefined ? resolve() : reject(error)));
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };

  return Object.freeze({
    baseUrl: `http://${input.host}:${input.port}`,
    close,
    activeConnections: () => sockets.size,
  });
}
