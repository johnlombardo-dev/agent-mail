import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createMessageId, type MessageId } from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { runMigrations, type Migration } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { externalContentSearchMigration } from "../src/migrations/0003-external-content-search";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import { compileSearchQuery } from "../src/search-query-compiler";
import { compileStructuredFilters } from "../src/structured-filter-compiler";
import {
  createSearchCursorIntegrityCodec,
  parseSearchCursor,
  SearchCursorError,
  SEARCH_CURSOR_REGISTRY_VERSION,
} from "../src/search-cursor";
import { selectSearchCandidates, type SearchCandidateRequest } from "../src/search-candidate-repository";

const roots: string[] = [];
const accountId = "account:cursor-fixture";
const mailboxId = "mailbox:inbox";
const codec = createSearchCursorIntegrityCodec("cursor-fixture-secret-2026");
const ids = {
  a: createMessageId(`message:${"a".repeat(64)}`),
  b: createMessageId(`message:${"b".repeat(64)}`),
  c: createMessageId(`message:${"c".repeat(64)}`),
  d: createMessageId(`message:${"d".repeat(64)}`),
  top: createMessageId(`message:${"0".repeat(64)}`),
} as const;

const migrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  externalContentSearchMigration,
  { ...placementObservationMigration, version: 4 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-search-cursor-p4-c08-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  runMigrations(opened, migrations);
  opened.db
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, 1);
  for (const [index, messageId] of [ids.a, ids.b, ids.c, ids.d].entries()) {
    insertMessage(opened.db, messageId, index + 1, "2026-01-01T00:00:00.000Z");
  }
  rebuildFts(opened.db);
  return opened;
}

function insertMessage(database: Database, messageId: MessageId, uid: number, internalDate: string) {
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  database
    .query("INSERT INTO message_search_documents (document_id, message_id) VALUES (?, ?);")
    .run(uid, messageId);
  database
    .query(
      "INSERT INTO message_headers (message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "Subject", "subject", "needle", "needle");
  database
    .query(
      "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, ?, ?, ?, ?, ?);",
    )
    .run(accountId, mailboxId, 1, uid, messageId, internalDate, "[]");
}

function rebuildFts(database: Database): void {
  database
    .query(
      "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) SELECT rowid, subject, participants, body_plain, body_html, attachment_names FROM indexed_messages WHERE rowid NOT IN (SELECT id FROM message_fts_docsize);",
    )
    .run();
}

function request(limit: number, cursor?: unknown): SearchCandidateRequest {
  const text = compileSearchQuery("needle");
  const filters = compileStructuredFilters([]);
  if (text.kind !== "compiled" || filters.kind !== "compiled") throw new Error("fixture query did not compile");
  return { accountId, text, filters, limit, cursor, cursorCodec: codec };
}

function idsOf(page: ReturnType<typeof selectSearchCandidates>): readonly MessageId[] {
  return page.candidates.map((candidate) => candidate.messageId);
}

describe("stable keyset search cursors P4-C08", () => {
  test("round-trips a versioned payload and rejects query, version, and tag changes", async () => {
    const opened = await openFixture();
    const first = selectSearchCandidates(opened.db, request(2));
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    if (cursor === null) throw new Error("expected a next cursor");
    const payload = parseSearchCursor(cursor, codec);
    expect(payload.registryVersion).toBe(SEARCH_CURSOR_REGISTRY_VERSION);
    expect(payload.normalizedQueryDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(payload.ranking.score).toBe(first.candidates[1]?.score);
    expect(payload.identityTieBreaker).toBe(ids.b);
    expect(() => selectSearchCandidates(opened.db, request(2, `${cursor.slice(0, -1)}A`))).toThrow(SearchCursorError);

    const otherText = compileSearchQuery("different");
    const filters = compileStructuredFilters([]);
    if (otherText.kind !== "compiled" || filters.kind !== "compiled") throw new Error("fixture query did not compile");
    expect(() => selectSearchCandidates(opened.db, { ...request(2, cursor), text: otherText })).toThrow(SearchCursorError);

    const wrongVersionPayload = JSON.stringify({
      ...payload,
      registryVersion: 99,
    });
    const wrongVersionUnsigned = JSON.stringify([
      "search-keyset-v1",
      99,
      payload.normalizedQueryDigest,
      payload.ranking.score,
      payload.ranking.canonicalInstant,
      payload.identityTieBreaker,
    ]);
    const sign = (value: string): string =>
      createHmac("sha256", "cursor-fixture-secret-2026").update(value, "utf8").digest("hex");
    const wrongVersionCursor = Buffer.from(
      JSON.stringify(["search-cursor-v1", wrongVersionPayload, sign(wrongVersionPayload)]),
      "utf8",
    ).toString("base64url");
    expect(sign(wrongVersionUnsigned)).not.toBe(payload.integrityTag);
    expect(() => selectSearchCandidates(opened.db, request(2, wrongVersionCursor))).toThrow(SearchCursorError);
    await opened.close();
  });

  test("pages tied real SQLite rows without duplicates or skips after insert and tombstone", async () => {
    const opened = await openFixture();
    const snapshot = selectSearchCandidates(opened.db, request(100));
    const first = selectSearchCandidates(opened.db, request(2));
    expect(idsOf(first)).toEqual([ids.a, ids.b]);
    if (first.nextCursor === null) throw new Error("expected a next cursor");

    insertMessage(opened.db, ids.top, 5, "2026-01-01T00:00:00.000Z");
    rebuildFts(opened.db);
    opened.db
      .query("UPDATE remote_placements SET tombstone_observed_at = ?, tombstone_reason = ? WHERE message_id = ?;")
      .run("2026-01-02T00:00:00.000Z", "fixture removal", ids.a);

    const second = selectSearchCandidates(opened.db, request(2, first.nextCursor));
    const third = second.nextCursor === null ? { candidates: [] as const } : selectSearchCandidates(opened.db, request(2, second.nextCursor));
    expect([...idsOf(first), ...idsOf(second), ...idsOf(third)]).toEqual(idsOf(snapshot));
    expect(new Set([...idsOf(first), ...idsOf(second), ...idsOf(third)]).size).toBe(4);
    await opened.close();
  });

  test("shows the adjacent OFFSET counterexample when a new top-ranked row arrives", async () => {
    const opened = await openFixture();
    const snapshot = selectSearchCandidates(opened.db, request(100));
    const first = selectSearchCandidates(opened.db, request(2));
    insertMessage(opened.db, ids.top, 5, "2026-01-01T00:00:00.000Z");
    rebuildFts(opened.db);
    const offsetRows = opened.db
      .query<{ message_id: string }, [number]>(
        "SELECT ranked.message_id FROM (SELECT m.message_id, bm25(message_fts, 10.0, 4.0, 3.0, 2.0, 1.0) AS score FROM message_fts JOIN message_search_documents AS d ON d.document_id = message_fts.rowid JOIN messages AS m ON m.message_id = d.message_id WHERE message_fts MATCH ?) AS ranked ORDER BY ranked.score ASC, ranked.message_id ASC LIMIT 2 OFFSET 2;",
      )
      .all('"needle"');
    expect(offsetRows.map((row) => row.message_id)).toEqual([ids.b, ids.c]);
    expect(offsetRows.map((row) => row.message_id)).not.toEqual(snapshot.candidates.slice(2, 4).map((candidate) => candidate.messageId));
    expect(first.nextCursor).not.toBeNull();
    await opened.close();
  });
});
