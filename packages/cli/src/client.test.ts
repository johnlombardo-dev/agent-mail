import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "bun:test";
import { createCliClient, type CliByteStream } from "./client";

type StreamMode = "infinite" | "pending" | "finite";

type StreamFixture = Readonly<{
  readonly stream: CliByteStream;
  readonly ready: Promise<void>;
  readonly peerClosed: Promise<void>;
  readonly close: () => Promise<void>;
}>;

function waitFor(promise: Promise<void>, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} was not observed`)), 2_000);
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function startStreamFixture(mode: StreamMode): Promise<StreamFixture> {
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let peerClosedResolve: (() => void) | undefined;
  const peerClosed = new Promise<void>((resolve) => {
    peerClosedResolve = resolve;
  });
  let peerClosedObserved = false;
  const sockets = new Set<Socket>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const markPeerClosed = (): void => {
    if (peerClosedObserved) return;
    peerClosedObserved = true;
    peerClosedResolve?.();
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.once("aborted", markPeerClosed);
    request.socket.once("close", markPeerClosed);
    response.once("close", markPeerClosed);
    const body = mode === "finite" ? Buffer.from("first-second") : Buffer.from("first");
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": mode === "finite" ? body.byteLength : 1_000_000_000,
      etag: `"${"a".repeat(64)}"`,
      connection: "close",
    });
    response.write(mode === "finite" ? body.subarray(0, 5) : body);
    readyResolve?.();
    if (mode === "finite") {
      response.end(body.subarray(5));
      return;
    }
    if (mode === "infinite") {
      const interval = setInterval(() => {
        if (!response.destroyed && !response.closed) response.write(Buffer.from("tick"));
      }, 10);
      intervals.add(interval);
      response.once("close", () => {
        clearInterval(interval);
        intervals.delete(interval);
      });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
  const client = createCliClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    timeouts: { connectMs: 2_000, controlMs: 2_000, streamIdleMs: 2_000 },
  });
  const result = await client.request({
    operation: "messages.raw",
    input: { messageId: `message:${"b".repeat(64)}` },
  });
  if (result.kind !== "stream") throw new Error("fixture did not return a stream");
  return {
    stream: result.stream,
    ready,
    peerClosed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const interval of intervals) clearInterval(interval);
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

describe("CLI byte-stream transport cancellation", () => {
  it("explicit cancel closes the upstream peer even after request upload close", async () => {
    const fixture = await startStreamFixture("infinite");
    try {
      await fixture.ready;
      await fixture.stream.cancel();
      await waitFor(fixture.peerClosed, "server peer closure");
    } finally {
      await fixture.close();
    }
  });

  it("cancel during a pending read closes the peer and settles the reader", async () => {
    const fixture = await startStreamFixture("pending");
    try {
      await fixture.ready;
      const iterator = fixture.stream.body[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first).toMatchObject({ done: false });
      const pendingRead = iterator.next();
      await Promise.resolve();
      await fixture.stream.cancel();
      await expect(waitFor(fixture.peerClosed, "server peer closure")).resolves.toBeUndefined();
      await expect(waitFor(pendingRead.then(() => undefined), "pending read settlement")).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("repeated cancel calls share one terminal and do not race", async () => {
    const fixture = await startStreamFixture("infinite");
    try {
      await fixture.ready;
      await Promise.all([fixture.stream.cancel(), fixture.stream.cancel(), fixture.stream.cancel()]);
      await waitFor(fixture.peerClosed, "server peer closure");
      await fixture.stream.cancel();
    } finally {
      await fixture.close();
    }
  });

  it("normal completion preserves bytes and awaits transport closure", async () => {
    const fixture = await startStreamFixture("finite");
    try {
      await fixture.ready;
      const chunks: Uint8Array[] = [];
      for await (const chunk of fixture.stream.body) chunks.push(chunk);
      expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("first-second");
      expect(fixture.stream.metadata).toMatchObject({
        contentType: "application/octet-stream",
        contentLength: 12,
        digest: "a".repeat(64),
      });
      await waitFor(fixture.peerClosed, "server peer closure");
      await fixture.stream.cancel();
    } finally {
      await fixture.close();
    }
  });
});
