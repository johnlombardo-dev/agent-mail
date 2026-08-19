import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createMessageId, type MessageId } from "@agent-mail/core";
import { publicErrorEnvelopeSchema } from "@agent-mail/contracts";
import { decodeExportStream } from "../src/export-stream-framing";
import {
  SelectedExportError,
  createSelectedExportStreamingApp,
  streamSelectedExport,
  type SelectedExportBlob,
  type SelectedExportRecord,
  type SelectedExportSource,
} from "../src/selected-export-stream";

const queryDigest = "a".repeat(64);

function blob(value: string): SelectedExportBlob & { readonly bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(value);
  return {
    kind: "raw",
    blobId: `blob:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.byteLength,
    bytes,
  };
}

type Fixture = Readonly<{
  readonly messageId: MessageId;
  readonly position: number;
  readonly queryMatch: boolean;
  readonly allowed: boolean;
  readonly tombstoned: boolean;
  readonly content: SelectedExportBlob & { readonly bytes: Uint8Array };
}>;

function fixture(position: number, options: Partial<Omit<Fixture, "messageId" | "position" | "content">> = {}): Fixture {
  const messageId = createMessageId(`message:${position.toString(16).padStart(64, "0")}`);
  const content = blob(`From: sender-${position}@example.test\r\n\r\nrecord-${position}`);
  return {
    messageId,
    position,
    queryMatch: true,
    allowed: true,
    tombstoned: false,
    content,
    ...options,
  };
}

function openFixtureDatabase(fixtures: readonly Fixture[]): Database {
  const database = new Database(":memory:");
  database.exec(
    "CREATE TABLE selected_export_fixture (message_id TEXT PRIMARY KEY, position INTEGER NOT NULL, query_match INTEGER NOT NULL, allowed INTEGER NOT NULL, tombstoned INTEGER NOT NULL, content BLOB NOT NULL);",
  );
  for (const item of fixtures) {
    database
      .query("INSERT INTO selected_export_fixture VALUES (?, ?, ?, ?, ?, ?);")
      .run(
        item.messageId,
        item.position,
        item.queryMatch ? 1 : 0,
        item.allowed ? 1 : 0,
        item.tombstoned ? 1 : 0,
        item.content.bytes,
      );
  }
  return database;
}

function sourceFor(database: Database): SelectedExportSource {
  return {
    page: async ({ selection, cursor, pageNumber }) => {
      const offset = cursor === null ? 0 : Number(cursor);
      const matching =
        selection.kind === "query"
          ? database
              .query<{ readonly message_id: string }, []>(
                "SELECT message_id FROM selected_export_fixture WHERE query_match = 1 ORDER BY position ASC;",
              )
              .all()
          : selection.messageIds.map((messageId) => ({ message_id: messageId }));
      const pageIds = matching.slice(offset, offset + 2);
      const records = pageIds.map(({ message_id }) => {
        const row = database
          .query<{
            readonly message_id: string;
            readonly position: number;
            readonly allowed: number;
            readonly tombstoned: number;
            readonly content: Uint8Array;
          }, [string]>(
            "SELECT message_id, position, allowed, tombstoned, content FROM selected_export_fixture WHERE message_id = ?;",
          )
          .get(message_id);
        if (row === null || row === undefined) return undefined;
        const bytes = new Uint8Array(row.content);
        return {
          record: {
            messageId: createMessageId(row.message_id),
            placementId: `placement:fixture:${row.position}`,
            metadata: new TextEncoder().encode(JSON.stringify({ messageId: row.message_id, position: row.position })),
            blobs: [blob(new TextDecoder().decode(bytes))],
          } satisfies SelectedExportRecord,
          allowed: row.allowed === 1,
          tombstoned: row.tombstoned === 1,
        };
      });
      return {
        records: records.flatMap((item) => (item === undefined ? [] : [item.record])),
        nextCursor: offset + pageIds.length < matching.length ? String(offset + pageIds.length) : null,
        queryDigest,
        pageNumber,
      };
    },
    authorize: async (record) => {
      const row = database
        .query<{ readonly allowed: number; readonly tombstoned: number }, [string]>(
          "SELECT allowed, tombstoned FROM selected_export_fixture WHERE message_id = ?;",
        )
        .get(record.messageId);
      return row !== null && row !== undefined && row.allowed === 1 && row.tombstoned === 0;
    },
    readBlob: async function* (item) {
      const fixtureRow = database
        .query<{ readonly content: Uint8Array }, [string]>(
          "SELECT content FROM selected_export_fixture WHERE message_id = ?;",
        )
        .get(item.blobId);
      if (fixtureRow !== null && fixtureRow !== undefined) yield fixtureRow.content;
      else {
        const value = new TextEncoder().encode("unreachable");
        yield value;
      }
    },
  };
}

function sourceWithBlobs(database: Database): SelectedExportSource {
  const source = sourceFor(database);
  return {
    ...source,
    readBlob: async function* (item) {
      const digest = item.blobId.slice("blob:".length);
      const rows = database
        .query<{ readonly content: Uint8Array }, []>("SELECT content FROM selected_export_fixture;")
        .all();
      for (const row of rows) {
        const bytes = new Uint8Array(row.content);
        if (createHash("sha256").update(bytes).digest("hex") === digest) yield bytes;
      }
    },
  };
}

async function collect(source: SelectedExportSource, selection: Parameters<typeof streamSelectedExport>[0]) {
  const chunks = streamSelectedExport(selection, source);
  return [...(await Array.fromAsync(decodeExportStream(chunks)))];
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}

describe("P6-C19 selected export stream", () => {
  test("streams the exact SQLite identity-set order with attribution and bounded pages", async () => {
    const fixtures = Array.from({ length: 5 }, (_, index) => fixture(index + 1));
    const database = openFixtureDatabase(fixtures);
    const source = sourceWithBlobs(database);
    const frames = await collect(source, {
      kind: "identities",
      messageIds: fixtures.map((item) => item.messageId),
    });
    expect(frames.map((frame) => frame.attribution.messageId)).toEqual(
      fixtures.flatMap((item) => [item.messageId, item.messageId]),
    );
    expect(frames.map((frame) => frame.kind)).toEqual(
      fixtures.flatMap(() => ["metadata", "raw"]),
    );
    expect(frames.every((frame) => frame.attribution.provenance.source === "selected-export")).toBe(true);
    expect(frames.every((frame) => frame.attribution.provenance.selectionQueryDigest === queryDigest)).toBe(true);
    database.close();
  });

  test("streams only the SQLite query selection and no unrelated record", async () => {
    const fixtures = [fixture(1), fixture(2, { queryMatch: false }), fixture(3)];
    const database = openFixtureDatabase(fixtures);
    const frames = await collect(sourceWithBlobs(database), { kind: "query", query: "needle" });
    expect([...new Set(frames.map((frame) => frame.attribution.messageId))]).toEqual([
      fixtures[0]?.messageId,
      fixtures[2]?.messageId,
    ]);
    database.close();
  });

  test("fails closed before emitting bytes for empty, unauthorized, and tombstoned selections", async () => {
    const unauthorized = fixture(1, { allowed: false });
    const tombstoned = fixture(2, { tombstoned: true });
    const database = openFixtureDatabase([unauthorized, tombstoned]);
    for (const selection of [
      { kind: "identities" as const, messageIds: [] },
      { kind: "identities" as const, messageIds: [unauthorized.messageId] },
      { kind: "identities" as const, messageIds: [tombstoned.messageId] },
    ]) {
      const iterator = streamSelectedExport(selection, sourceWithBlobs(database));
      await expect(iterator.next()).rejects.toBeInstanceOf(SelectedExportError);
    }
    database.close();
  });

  test("cancellation terminates a slow blob reader without broadening the selection", async () => {
    const fixtureRow = fixture(1);
    const database = openFixtureDatabase([fixtureRow]);
    const controller = new AbortController();
    let reads = 0;
    const source = sourceWithBlobs(database);
    const slow: SelectedExportSource = {
      ...source,
      readBlob: async function* (_item, signal) {
        reads += 1;
        while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1));
        throw new SelectedExportError("cancelled");
      },
    };
    const iterator = streamSelectedExport(
      { kind: "identities", messageIds: [fixtureRow.messageId] },
      slow,
      controller.signal,
    );
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(SelectedExportError);
    expect(reads).toBe(1);
    database.close();
  });

  test("response cancellation awaits a yielded blob iterator exactly once", async () => {
    const item = fixture(1);
    const requestAbort = new AbortController();
    let readsStarted = 0;
    let readsCompleted = 0;
    const source: SelectedExportSource = {
      page: async ({ pageNumber }) => ({
        records: [1, 2].map((position) => ({
          messageId: createMessageId(`message:${position.toString(16).padStart(64, "0")}`),
          placementId: item.content.blobId,
          metadata: item.content.bytes,
          blobs: [item.content],
        })),
        nextCursor: null,
        queryDigest,
        pageNumber,
      }),
      authorize: async () => true,
      readBlob: async function* (_blob, signal) {
        readsStarted += 1;
        try {
          yield item.content.bytes;
          if (readsStarted === 1) return;
          while (!signal.aborted) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        } finally {
          readsCompleted += 1;
        }
      },
    };
    const app = createSelectedExportStreamingApp({
      source,
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "operator:fixture", scopes: ["mail:export.selected"] },
      }),
    });
    const response = await app.request("http://localhost/v1/exports", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
      body: JSON.stringify({ selection: { kind: "identities", messageIds: [item.messageId] } }),
      signal: requestAbort.signal,
    });
    if (response.status !== 200) throw new Error(`unexpected status ${response.status}`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing stream reader");
    await reader.read();
    await reader.read();
    const pending = reader.read();
    try {
      await waitUntil(() => readsStarted === 2);
    } catch {
      throw new Error(`expected second read, started=${readsStarted}`);
    }
    requestAbort.abort();
    await Promise.all([reader.cancel(), reader.cancel()]);
    await pending;
    await waitUntil(() => readsCompleted === 2);
    expect(readsStarted).toBe(2);
    expect(readsCompleted).toBe(2);
  });

  test("authenticates and validates before the truthful AMEX byte response", async () => {
    const item = fixture(1);
    const database = openFixtureDatabase([item]);
    const app = createSelectedExportStreamingApp({
      source: sourceWithBlobs(database),
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "operator:fixture", scopes: ["mail:export.selected"] },
      }),
    });
    const response = await app.request("http://localhost/v1/exports", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
      body: JSON.stringify({ selection: { kind: "identities", messageIds: [item.messageId] } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/octet-stream");
    const frames = [...(await Array.fromAsync(decodeExportStream([new Uint8Array(await response.arrayBuffer())])))];
    expect(frames.map((frame) => frame.attribution.messageId)).toEqual([item.messageId, item.messageId]);
    database.close();
  });

  test("returns no AMEX bytes for an unauthorized preflight failure", async () => {
    const item = fixture(1, { allowed: false });
    const database = openFixtureDatabase([item]);
    const app = createSelectedExportStreamingApp({
      source: sourceWithBlobs(database),
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "operator:fixture", scopes: ["mail:export.selected"] },
      }),
    });
    const response = await app.request("http://localhost/v1/exports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fixture",
        "x-correlation-id": "correlation:unauthorized-fixture",
      },
      body: JSON.stringify({ selection: { kind: "identities", messageIds: [item.messageId] } }),
    });
    expect(response.status).toBe(500);
    const error = publicErrorEnvelopeSchema.parse(await response.json());
    expect(error.correlationId).toBe("correlation:unauthorized-fixture");
    database.close();
  });

  test("routes malformed JSON through the shared registered error envelope", async () => {
    const database = openFixtureDatabase([]);
    const app = createSelectedExportStreamingApp({
      source: sourceWithBlobs(database),
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "operator:fixture", scopes: ["mail:export.selected"] },
      }),
    });
    const response = await app.request("http://localhost/v1/exports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fixture",
        "x-correlation-id": "correlation:malformed-fixture",
      },
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    const error = publicErrorEnvelopeSchema.parse(await response.json());
    expect(error.code).toBe("invalid_request");
    expect(error.correlationId).toBe("correlation:malformed-fixture");
    database.close();
  });

  test("normalizes an invalid correlation header before adapter, diagnostics, and errors", async () => {
    const item = fixture(1, { allowed: false });
    const database = openFixtureDatabase([item]);
    const diagnostics: string[] = [];
    const app = createSelectedExportStreamingApp({
      source: sourceWithBlobs(database),
      logger: (entry) => diagnostics.push(entry.correlationId),
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "operator:fixture", scopes: ["mail:export.selected"] },
      }),
    });
    const response = await app.request("http://localhost/v1/exports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fixture",
        "x-correlation-id": "x".repeat(201),
      },
      body: JSON.stringify({ selection: { kind: "identities", messageIds: [item.messageId] } }),
    });
    expect(response.status).toBe(500);
    const error = publicErrorEnvelopeSchema.parse(await response.json());
    expect(error.correlationId).not.toBe("x".repeat(201));
    expect(error.correlationId).toMatch(/^request:/u);
    expect(diagnostics).toEqual([error.correlationId]);
    database.close();
  });

  test("returns no AMEX bytes when canonical content is unavailable", async () => {
    const item = fixture(1);
    const database = openFixtureDatabase([item]);
    const base = sourceWithBlobs(database);
    const app = createSelectedExportStreamingApp({
      source: {
        ...base,
        readBlob: async function* () {
          yield new TextEncoder().encode("tampered");
        },
      },
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "operator:fixture", scopes: ["mail:export.selected"] },
      }),
    });
    const response = await app.request("http://localhost/v1/exports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fixture",
        "x-correlation-id": "correlation:unavailable-fixture",
      },
      body: JSON.stringify({ selection: { kind: "identities", messageIds: [item.messageId] } }),
    });
    expect(response.status).toBe(500);
    const error = publicErrorEnvelopeSchema.parse(await response.json());
    expect(error.correlationId).toBe("correlation:unavailable-fixture");
    database.close();
  });

  test("terminates after a later authorization failure and keeps private diagnostics", async () => {
    const first = fixture(1);
    const second = fixture(2);
    const database = openFixtureDatabase([first, second]);
    const diagnostics: string[] = [];
    const base = sourceWithBlobs(database);
    let authorized = 0;
    const app = createSelectedExportStreamingApp({
      source: {
        ...base,
        authorize: async (record) => {
          authorized += 1;
          return record.messageId === first.messageId;
        },
      },
      logger: (entry) => diagnostics.push(`${entry.kind}:${entry.operationKey}`),
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "operator:fixture", scopes: ["mail:export.selected"] },
      }),
    });
    const response = await app.request("http://localhost/v1/exports", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
      body: JSON.stringify({
        selection: { kind: "identities", messageIds: [first.messageId, second.messageId] },
      }),
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing stream reader");
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    let failed = false;
    for (let attempt = 0; attempt < 20 && !failed; attempt += 1) {
      try {
        await reader.read();
      } catch {
        failed = true;
      }
    }
    expect(failed).toBe(true);
    expect(authorized).toBe(2);
    expect(diagnostics).toContain("handler-error:exports.selected");
    database.close();
  });
});
