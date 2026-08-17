import { createHash } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createContentStreamingApp,
  type ContentBlobHandle,
  type ContentBlobHandleOpener,
} from "../src/content-streaming";

const messageId = "message:stream-fixture";
const attachmentId = "attachment:stream-fixture";
const scope = "mail:read.raw";
const attachmentScope = "mail:read.attachment";

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function authFor(scopes: readonly string[]) {
  return () => ({
    kind: "authenticated" as const,
    principal: { subject: "stream-test", scopes },
  });
}

type Tracking = Readonly<{
  readonly opener: ContentBlobHandleOpener;
  readonly opened: () => number;
  readonly closed: () => number;
  readonly readLengths: () => readonly number[];
  readonly beginDelivery: () => void;
  readonly deliveryReadLengths: () => readonly number[];
  readonly deliveryBytes: () => number;
  readonly fullBufferCalls: () => number;
}>;

function trackingOpener(): Tracking {
  let opened = 0;
  let closed = 0;
  let fullBufferCalls = 0;
  let deliveryStarted = false;
  const readLengths: number[] = [];
  const deliveryReadLengths: number[] = [];
  let deliveryBytes = 0;
  const opener: ContentBlobHandleOpener = async (path) => {
    opened += 1;
    const handle = await open(path, "r");
    let didClose = false;
    const capability: ContentBlobHandle = {
      stat: async () => {
        const result = await handle.stat();
        return { isFile: result.isFile(), size: result.size };
      },
      read: async (buffer, offset, length, position) => {
        readLengths.push(length);
        const result = await handle.read(buffer, offset, length, position);
        if (deliveryStarted) {
          deliveryReadLengths.push(length);
          deliveryBytes += result.bytesRead;
        }
        return { bytesRead: result.bytesRead };
      },
      close: async () => {
        if (didClose) return;
        didClose = true;
        closed += 1;
        await handle.close();
      },
    };
    return new Proxy(capability, {
      get(target, property, receiver) {
        if (property === "arrayBuffer") {
          fullBufferCalls += 1;
          throw new Error("full-buffer counterexample invoked");
        }
        return Reflect.get(target, property, receiver);
      },
    });
  };
  return {
    opener,
    opened: () => opened,
    closed: () => closed,
    readLengths: () => readLengths,
    beginDelivery: () => {
      deliveryStarted = true;
    },
    deliveryReadLengths: () => deliveryReadLengths,
    deliveryBytes: () => deliveryBytes,
    fullBufferCalls: () => fullBufferCalls,
  };
}

async function fixture() {
  const directory = join(tmpdir(), `agent-mail-content-stream-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 123);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const digest = digestOf(bytes);
  await writeFile(join(directory, digest), bytes, { mode: 0o600 });
  return { directory, bytes, digest };
}

describe("raw and attachment HTTP content streaming", () => {
  test("streams a large raw fixture with bounded chunks, exact bytes, and metadata", async () => {
    const { directory, bytes, digest } = await fixture();
    try {
      const tracking = trackingOpener();
      const app = createContentStreamingApp({
        canonicalDirectory: directory,
        authenticate: authFor([scope]),
        openHandle: tracking.opener,
        resolveRaw: async () => ({
          messageId,
          blobId: `blob:${digest}`,
          size: bytes.length,
          contentType: "message/rfc822",
        }),
        resolveAttachment: async () => undefined,
      });
      const response = await app.request(`http://localhost/v1/messages/${encodeURIComponent(messageId)}/raw`, {
        method: "GET",
        headers: { authorization: "Bearer stream-token" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("message/rfc822");
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(response.headers.get("etag")).toBe(`"${digest}"`);
      expect(response.headers.get("content-disposition")).toBeNull();

      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("stream body was absent");
      // Verification has completed before the response is returned. From this
      // point onward, every read is delivery work and must follow demand.
      const preflightReadCount = tracking.readLengths().length;
      expect(preflightReadCount).toBeGreaterThan(0);
      tracking.beginDelivery();
      const received: Buffer[] = [];
      const first = await reader.read();
      expect(first.done).toBe(false);
      if (first.value === undefined) throw new Error("first stream chunk was absent");
      received.push(Buffer.from(first.value));
      // A stalled consumer may have one bounded queue window behind the
      // explicitly requested chunk, but it must not trigger unbounded reads.
      await Bun.sleep(25);
      expect(tracking.deliveryReadLengths().length).toBeLessThanOrEqual(2);
      expect(tracking.deliveryBytes()).toBeLessThanOrEqual(2 * 64 * 1024);
      expect(tracking.deliveryBytes()).toBeGreaterThanOrEqual(first.value.byteLength);
      while (true) {
        await Bun.sleep(1);
        const next = await reader.read();
        if (next.done) break;
        if (next.value === undefined) throw new Error("stream chunk was absent");
        received.push(Buffer.from(next.value));
      }
      expect(Buffer.concat(received)).toEqual(bytes);
      expect(Math.max(...tracking.deliveryReadLengths())).toBeLessThanOrEqual(64 * 1024);
      expect(tracking.deliveryBytes()).toBe(bytes.length);
      expect(tracking.fullBufferCalls()).toBe(0);
      expect(tracking.opened()).toBe(1);
      expect(tracking.closed()).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses RFC-safe attachment disposition and closes the handle on cancellation", async () => {
    const { directory, bytes, digest } = await fixture();
    try {
      const tracking = trackingOpener();
      const filename = "résumé; Q4/2026.pdf";
      const app = createContentStreamingApp({
        canonicalDirectory: directory,
        authenticate: authFor([attachmentScope]),
        openHandle: tracking.opener,
        resolveRaw: async () => undefined,
        resolveAttachment: async () => ({
          attachmentId,
          messageId,
          blobId: `blob:${digest}`,
          size: bytes.length,
          contentType: "application/pdf",
          filename,
        }),
      });
      const response = await app.request(
        `http://localhost/v1/attachments/${encodeURIComponent(attachmentId)}`,
        { headers: { authorization: "Bearer stream-token" } },
      );
      expect(response.status).toBe(200);
      const disposition = response.headers.get("content-disposition");
      expect(disposition).toContain('attachment; filename="r_sum_; Q4_2026.pdf";');
      expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%3B%20Q4%2F2026.pdf");

      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("stream body was absent");
      tracking.beginDelivery();
      const first = await reader.read();
      expect(first.done).toBe(false);
      await reader.cancel("slow client disconnected");
      expect(tracking.closed()).toBe(1);
      expect(Math.max(...tracking.readLengths())).toBeLessThanOrEqual(64 * 1024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns stable not-found and corrupt-content errors before a body stream", async () => {
    const { directory, bytes, digest } = await fixture();
    try {
      const tracking = trackingOpener();
      const missing = createContentStreamingApp({
        canonicalDirectory: directory,
        authenticate: authFor([scope]),
        openHandle: tracking.opener,
        resolveRaw: async () => undefined,
        resolveAttachment: async () => undefined,
      });
      const absent = await missing.request(`http://localhost/v1/messages/${encodeURIComponent(messageId)}/raw`, {
        headers: { authorization: "Bearer stream-token" },
      });
      expect(absent.status).toBe(404);
      expect(await absent.json()).toMatchObject({
        code: "not_found",
        details: { resource: "raw-message", id: messageId },
      });
      expect(tracking.opened()).toBe(0);

      await rm(join(directory, digest));
      const missingBlob = createContentStreamingApp({
        canonicalDirectory: directory,
        authenticate: authFor([scope]),
        openHandle: tracking.opener,
        resolveRaw: async () => ({
          messageId,
          blobId: `blob:${digest}`,
          size: bytes.length,
          contentType: "message/rfc822",
        }),
        resolveAttachment: async () => undefined,
      });
      const missingBlobResponse = await missingBlob.request(
        `http://localhost/v1/messages/${encodeURIComponent(messageId)}/raw`,
        { headers: { authorization: "Bearer stream-token" } },
      );
      expect(missingBlobResponse.status).toBe(500);
      expect(await missingBlobResponse.json()).toMatchObject({ code: "internal_error" });

      await writeFile(join(directory, digest), Buffer.from("corrupt"), { mode: 0o600 });
      const corrupt = createContentStreamingApp({
        canonicalDirectory: directory,
        authenticate: authFor([scope]),
        openHandle: tracking.opener,
        resolveRaw: async () => ({
          messageId,
          blobId: `blob:${digest}`,
          size: bytes.length,
          contentType: "message/rfc822",
        }),
        resolveAttachment: async () => undefined,
      });
      const response = await corrupt.request(`http://localhost/v1/messages/${encodeURIComponent(messageId)}/raw`, {
        headers: { authorization: "Bearer stream-token" },
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "internal_error" });
      expect(tracking.closed()).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps the authentication and exact operation-scope boundary before resolution", async () => {
    let resolved = 0;
    const app = createContentStreamingApp({
      canonicalDirectory: "/private/not-used",
      authenticate: authFor(["mail:read.search"]),
      resolveRaw: async () => {
        resolved += 1;
        return undefined;
      },
      resolveAttachment: async () => undefined,
    });
    const response = await app.request(`http://localhost/v1/messages/${encodeURIComponent(messageId)}/raw`);
    expect(response.status).toBe(401);
    expect(resolved).toBe(0);

    const insufficient = await app.request(
      `http://localhost/v1/messages/${encodeURIComponent(messageId)}/raw`,
      { headers: { authorization: "Bearer stream-token" } },
    );
    expect(insufficient.status).toBe(403);
    expect(resolved).toBe(0);
  });
});
