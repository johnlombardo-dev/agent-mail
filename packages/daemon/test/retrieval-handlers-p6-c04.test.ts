import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseMessageId, parseUtcInstant } from "@agent-mail/core";
import { createSearchCursor, createSearchCursorIntegrityCodec } from "../../storage/src/search-cursor";
import { applyMigrations, type Migration } from "../../storage/src/migration-runner";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../../storage/src/migrations/0002-structured-content";
import { externalContentSearchMigration } from "../../storage/src/migrations/0003-external-content-search";
import { placementObservationMigration } from "../../storage/src/migrations/0003-placement-observation";
import { threadGraphMigration } from "../../storage/src/migrations/0008-thread-graph";
import { normalizeThreadFacts } from "../../storage/src/thread-normalizer";
import { ThreadCursorCodec } from "../../storage/src/thread-cursor";
import { ThreadGraphRepository } from "../../storage/src/thread-graph-repository";
import { createHttpApp, type HttpCredentialResolution } from "../src/http";
import { createRetrievalHandlers } from "../src/retrieval-handlers";

const accountId = "account:retrieval-http";
const rootMessageId = `message:${"a".repeat(64)}`;
const replyMessageId = `message:${"b".repeat(64)}`;
const isolatedMessageId = `message:${"c".repeat(64)}`;
const mailboxId = "mailbox:inbox";
const threadCursorCodec = new ThreadCursorCodec({
  accountId,
  activeKey: { keyId: "fixture", secret: "thread-http-test-secret" },
});
const searchCursorCodec = createSearchCursorIntegrityCodec("search-http-test-secret");
const databases: Database[] = [];

const migrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  externalContentSearchMigration,
  { ...placementObservationMigration, version: 4 },
  { ...threadGraphMigration, version: 5 },
];

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  applyMigrations(db, migrations);
  db.exec("PRAGMA foreign_keys = ON;");
  databases.push(db);
  return db;
}

function ingest(db: Database): void {
  db.query("INSERT INTO messages (message_id) VALUES (?), (?), (?);").run(rootMessageId, replyMessageId, isolatedMessageId);
  db.query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, 1);").run(accountId, mailboxId);
  db.query("INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, 1, 1, ?, ?, ?), (?, ?, 1, 2, ?, ?, ?), (?, ?, 1, 3, ?, ?, ?);").run(
    accountId,
    mailboxId,
    rootMessageId,
    "2026-01-01T00:00:00.000Z",
    "[\"\\\\Seen\"]",
    accountId,
    mailboxId,
    replyMessageId,
    "2026-01-01T00:01:00.000Z",
    "[]",
    accountId,
    mailboxId,
    isolatedMessageId,
    "2026-01-01T00:02:00.000Z",
    "[]",
  );
  db.query("INSERT INTO message_headers (message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, 1, 'Subject', 'subject', 'Thread subject', 'Thread subject'), (?, 1, 'Subject', 'subject', 'Thread subject', 'Thread subject'), (?, 1, 'Subject', 'subject', 'Thread subject', 'Thread subject');").run(rootMessageId, replyMessageId, isolatedMessageId);
  db.query("INSERT INTO message_addresses (message_id, ordinal, role, position, address, normalized_address, display_name) VALUES (?, 1, 'from', 1, 'alice@example.com', 'alice@example.com', 'Alice'), (?, 1, 'from', 1, 'bob@example.com', 'bob@example.com', 'Bob'), (?, 1, 'from', 1, 'carol@example.com', 'carol@example.com', 'Carol');").run(rootMessageId, replyMessageId, isolatedMessageId);
  db.query("INSERT INTO message_body_parts (message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text, html_derived_text) VALUES (?, 1, 'text/plain', 'text/plain', ?, 'needle root', ''), (?, 1, 'text/plain', 'text/plain', ?, 'needle reply', ''), (?, 1, 'text/plain', 'text/plain', ?, 'needle isolated', '');").run(rootMessageId, "a".repeat(64), replyMessageId, "b".repeat(64), isolatedMessageId, "c".repeat(64));
  db.query("INSERT INTO message_search_documents (message_id) VALUES (?), (?), (?);").run(rootMessageId, replyMessageId, isolatedMessageId);
  db.query("INSERT INTO message_fts (rowid, subject, participants, body_plain, body_html, attachment_names) VALUES (1, 'Thread subject', 'alice@example.com', 'needle root', '', ''), (2, 'Thread subject', 'bob@example.com', 'needle reply', '', ''), (3, 'Thread subject', 'carol@example.com', 'needle isolated', '', '');");
  db.exec("INSERT INTO message_fts(message_fts) VALUES ('rebuild');");
  const repository = new ThreadGraphRepository(db);
  repository.ingestFacts(normalizeThreadFacts({
    accountId,
    messageId: isolatedMessageId,
    headers: [
      { ordinal: 1, normalizedName: "message-id", value: "<isolated@example.com>" },
      { ordinal: 2, normalizedName: "date", value: "2026-01-01T00:02:00.000Z" },
    ],
    sentAt: "2026-01-01T00:02:00.000Z",
    receivedAt: "2026-01-01T00:02:00.000Z",
    participants: [{ address: "carol@example.com", displayName: "Carol" }],
  }));
  repository.ingestFacts(normalizeThreadFacts({
    accountId,
    messageId: rootMessageId,
    headers: [
      { ordinal: 1, normalizedName: "message-id", value: "<root@example.com>" },
      { ordinal: 2, normalizedName: "date", value: "2026-01-01T00:00:00.000Z" },
    ],
    sentAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    participants: [{ address: "alice@example.com", displayName: "Alice" }],
  }));
  repository.ingestFacts(normalizeThreadFacts({
    accountId,
    messageId: replyMessageId,
    headers: [
      { ordinal: 1, normalizedName: "message-id", value: "<reply@example.com>" },
      { ordinal: 2, normalizedName: "references", value: "<root@example.com> <isolated@example.com>" },
      { ordinal: 3, normalizedName: "date", value: "2026-01-01T00:01:00.000Z" },
    ],
    sentAt: "2026-01-01T00:01:00.000Z",
    receivedAt: "2026-01-01T00:01:00.000Z",
    participants: [{ address: "bob@example.com", displayName: "Bob" }],
  }));
}

function auth(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: {
      subject: "operator",
      scopes: ["mail:read.search", "mail:read.message", "mail:read.thread"],
    },
  };
}

function request(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer retrieval",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("direct Hono retrieval matrix P6-C04", () => {
  test("publishes exactly the non-streaming retrieval operations", () => {
    const db = database();
    expect(Object.keys(createRetrievalHandlers({ database: db, accountId }))).toEqual([
      "messages.search",
      "messages.get",
      "threads.get",
    ]);
  });

  test("searches and hydrates real SQLite candidates, then retrieves a message", async () => {
    const db = database();
    ingest(db);
    const app = createHttpApp({
      authenticate: auth,
      handlers: createRetrievalHandlers({ database: db, accountId, searchCursorCodec, threadCursorCodec }),
    });

    const search = await app.request(request("/v1/messages/search", { query: "needle", limit: 1, filters: {} }));
    expect(search.status).toBe(200);
    const page: unknown = await search.json();
    expect(page).toMatchObject({ items: [{ messageId: expect.any(String) }], nextCursor: expect.any(String) });

    const message = await app.request(request(`/v1/messages/${rootMessageId}`));
    expect(message.status).toBe(200);
    expect(await message.json()).toMatchObject({ message: { messageId: rootMessageId, textBody: "needle root" } });
  });

  test("passes subject, alias thread, and combined filters to the storage compiler", async () => {
    const db = database();
    ingest(db);
    const snapshot = new ThreadGraphRepository(db).snapshot(accountId).sets[0];
    if (snapshot === undefined) throw new Error("fixture thread is missing");
    const alias = snapshot.handles.find((handle) => handle !== snapshot.canonicalThreadId);
    if (alias === undefined) throw new Error("fixture alias is missing");
    const app = createHttpApp({
      authenticate: auth,
      handlers: createRetrievalHandlers({ database: db, accountId, searchCursorCodec }),
    });
    const matching = await app.request(request("/v1/messages/search", {
      query: "needle",
      limit: 100,
      filters: {
        subject: "Thread subject",
        threadId: alias,
        sender: "carol@example.com",
      },
    }));
    expect(matching.status).toBe(200);
    expect(await matching.json()).toMatchObject({ items: [{ messageId: isolatedMessageId }] });
    const unknownThread = await app.request(request("/v1/messages/search", {
      query: "needle",
      filters: { threadId: `thread:${"f".repeat(64)}` },
    }));
    expect(unknownThread.status).toBe(200);
    expect(await unknownThread.json()).toEqual({ items: [], nextCursor: null });
  });

  test("resolves an alias and preserves empty continuation success", async () => {
    const db = database();
    ingest(db);
    const repository = new ThreadGraphRepository(db);
    const canonical = repository.snapshot(accountId).sets[0]?.canonicalThreadId;
    if (canonical === undefined) throw new Error("fixture thread is missing");
    const alias = repository.snapshot(accountId).sets[0]?.handles.find((handle) => handle !== canonical);
    if (alias === undefined) throw new Error("fixture alias is missing");
    const app = createHttpApp({
      authenticate: auth,
      handlers: createRetrievalHandlers({ database: db, accountId, threadCursorCodec }),
    });

    const first = await app.request(request(`/v1/threads/${alias}`, { threadId: alias, limit: 1 }));
    expect(first.status).toBe(200);
    const firstBody: { thread: { nextCursor: string | null; resolvedFromThreadId: string | null } } = await first.json();
    expect(firstBody.thread.resolvedFromThreadId).toBe(alias);
    if (firstBody.thread.nextCursor === null) throw new Error("fixture did not produce a continuation");
    const terminalCursor = threadCursorCodec.encode({
      requestedThreadHandle: alias,
      tuple: { sentAtMissingRank: 0, sentAt: parseUtcInstant("2026-01-01T00:02:00.000Z"), messageId: parseMessageId(isolatedMessageId) },
    });
    const exhausted = await app.request(request(`/v1/threads/${alias}`, { threadId: alias, limit: 1, cursor: terminalCursor }));
    expect(exhausted.status).toBe(200);
    expect(await exhausted.json()).toMatchObject({ thread: { messageIds: [], messages: [], messageCount: 3, nextCursor: null } });
  });

  test("maps unknown message/thread and malformed thread cursor to exact envelopes", async () => {
    const db = database();
    ingest(db);
    const app = createHttpApp({
      authenticate: auth,
      handlers: createRetrievalHandlers({ database: db, accountId, searchCursorCodec, threadCursorCodec }),
    });
    const missingMessageId = `message:${"f".repeat(64)}`;
    const missingMessage = await app.request(request(`/v1/messages/${missingMessageId}`));
    expect(missingMessage.status).toBe(404);
    expect(await missingMessage.json()).toMatchObject({ code: "not_found", details: { resource: "message", id: missingMessageId } });
    const missingThreadId = `thread:${"f".repeat(64)}`;
    const missingThread = await app.request(request(`/v1/threads/${missingThreadId}`));
    expect(missingThread.status).toBe(404);
    expect(await missingThread.json()).toMatchObject({ code: "not_found", details: { resource: "thread", id: missingThreadId } });
    const malformedCursor = await app.request(request(`/v1/threads/${missingThreadId}`, { threadId: missingThreadId, limit: 1, cursor: "A".repeat(64) }));
    expect(malformedCursor.status).toBe(400);

    const known = new ThreadGraphRepository(db).snapshot(accountId).sets[0]?.canonicalThreadId;
    if (known === undefined) throw new Error("fixture thread is missing");
    const wrongCodec = new ThreadCursorCodec({ accountId, activeKey: { keyId: "fixture", secret: "wrong-thread-secret" } });
    const tampered = wrongCodec.encode({
      requestedThreadHandle: known,
      tuple: { sentAtMissingRank: 0, sentAt: parseUtcInstant("2026-01-01T00:00:00.000Z"), messageId: parseMessageId(rootMessageId) },
    });
    const invalidThreadCursor = await app.request(request(`/v1/threads/${known}`, { threadId: known, limit: 1, cursor: tampered }));
    expect(invalidThreadCursor.status).toBe(400);
    expect(await invalidThreadCursor.json()).toMatchObject({ code: "invalid_cursor", message: "thread cursor is invalid", details: { resource: "thread" } });

    const invalidQuery = await app.request(request("/v1/messages/search", { query: "needle OR reply", filters: {} }));
    expect(invalidQuery.status).toBe(400);
    expect(await invalidQuery.json()).toMatchObject({ code: "invalid_query", message: "invalid search query", details: { resource: "search" } });
    const firstSearch = await app.request(request("/v1/messages/search", { query: "needle", limit: 1, filters: {} }));
    const firstSearchBody: { nextCursor: string | null } = await firstSearch.json();
    if (firstSearchBody.nextCursor === null) throw new Error("fixture did not produce a search cursor");
    const invalidSearchCursor = await app.request(request("/v1/messages/search", {
      query: "needle",
      limit: 1,
      cursor: createSearchCursor({
        normalizedQueryDigest: "a".repeat(64),
        score: 0,
        canonicalInstant: null,
        identityTieBreaker: parseMessageId(rootMessageId),
      }, createSearchCursorIntegrityCodec("wrong-search-secret")),
      filters: {},
    }));
    expect(invalidSearchCursor.status).toBe(400);
    expect(await invalidSearchCursor.json()).toMatchObject({ code: "invalid_cursor", message: "search cursor is invalid", details: { resource: "search" } });

    const malformedRequest = await app.request(request("/v1/messages/search", { query: "needle", filters: {}, extra: true }));
    expect(malformedRequest.status).toBe(400);
    const deniedApp = createHttpApp({
      authenticate: () => ({ kind: "authenticated", principal: { subject: "operator", scopes: ["mail:read.message"] } }),
      handlers: createRetrievalHandlers({ database: db, accountId, searchCursorCodec, threadCursorCodec }),
    });
    const denied = await deniedApp.request(new Request("http://localhost/v1/messages/search", {
      method: "POST",
      headers: { authorization: "Bearer retrieval", "content-type": "application/json" },
      body: JSON.stringify({ query: "needle", filters: {} }),
    }));
    expect(denied.status).toBe(403);
    const unauthenticatedApp = createHttpApp({
      authenticate: () => ({ kind: "invalid" }),
      handlers: createRetrievalHandlers({ database: db, accountId, searchCursorCodec, threadCursorCodec }),
    });
    const unauthenticated = await unauthenticatedApp.request(new Request("http://localhost/v1/messages/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "needle", filters: {} }),
    }));
    expect(unauthenticated.status).toBe(401);

    const privateDb = database();
    ingest(privateDb);
    const privateLogs: Array<{ kind: string }> = [];
    const privateApp = createHttpApp({
      authenticate: auth,
      logger: (entry) => privateLogs.push(entry),
      handlers: createRetrievalHandlers({ database: privateDb, accountId, searchCursorCodec, threadCursorCodec }),
    });
    privateDb.close();
    const privateDatabaseIndex = databases.indexOf(privateDb);
    if (privateDatabaseIndex >= 0) databases.splice(privateDatabaseIndex, 1);
    const privateFailure = await privateApp.request(request(`/v1/messages/${rootMessageId}`));
    expect(privateFailure.status).toBe(500);
    expect(await privateFailure.json()).toEqual({
      code: "internal_error",
      message: "internal server error",
      correlationId: expect.any(String),
      details: {},
    });
    expect(privateLogs.map(({ kind }) => kind)).toEqual(["handler-error"]);

    const crossAccountApp = createHttpApp({
      authenticate: auth,
      handlers: createRetrievalHandlers({ database: db, accountId: "account:other", searchCursorCodec, threadCursorCodec }),
    });
    const crossAccountMessage = await crossAccountApp.request(request(`/v1/messages/${rootMessageId}`));
    expect(crossAccountMessage.status).toBe(404);
    const crossAccountSearch = await crossAccountApp.request(request("/v1/messages/search", { query: "needle", filters: {} }));
    expect(crossAccountSearch.status).toBe(200);
    expect(await crossAccountSearch.json()).toEqual({ items: [], nextCursor: null });
  });
});
