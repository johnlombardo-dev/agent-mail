import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { searchHitSchema } from "../../contracts/src/retrieval-operations";
import {
  createAccountId,
  createBlobId,
  createMailboxId,
  createMessageId,
  createUtcInstant,
  type MessageId,
} from "@agent-mail/core";
import { Database } from "bun:sqlite";
import type { Database as DatabaseType } from "bun:sqlite";
import { runMigrations, type Migration } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { externalContentSearchMigration } from "../src/migrations/0003-external-content-search";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { selectSearchCandidates } from "../src/search-candidate-repository";
import { compileSearchQuery } from "../src/search-query-compiler";
import { compileStructuredFilters } from "../src/structured-filter-compiler";
import { promoteCanonicalMessage, type PromotionUnit } from "../src/canonical-promotion";
import { messageBlobReferencesMigration } from "../src/migrations/0003-message-blob-references";
import { updateMessageSearchProjection } from "../src/search-projection";
import { threadGraphMigration } from "../src/migrations/0008-thread-graph";
import { ThreadGraphRepository } from "../src/thread-graph-repository";
import { normalizeThreadFacts } from "../src/thread-normalizer";
import {
  hydrateSearchSummaryPage,
  SearchSummaryHydrationError,
  searchSummaryHydrationSql,
} from "../src/search-summary-hydration-repository";

const roots: string[] = [];
const accountId = createAccountId("account:fixture");
const mailboxId = createMailboxId("mailbox:inbox");
const messageIds = {
  first: createMessageId(`message:${"a".repeat(64)}`),
  second: createMessageId(`message:${"b".repeat(64)}`),
  offPage: createMessageId(`message:${"c".repeat(64)}`),
  fourth: createMessageId(`message:${"d".repeat(64)}`),
  canonical: createMessageId(`message:${"e".repeat(64)}`),
} as const;

const migrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  { ...messageBlobReferencesMigration, version: 3 },
  { ...externalContentSearchMigration, version: 4 },
  { ...placementObservationMigration, version: 5 },
  { ...operationalJournalMigration, version: 6 },
  { ...threadGraphMigration, version: 7 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-search-summary-p4-c07-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  runMigrations(opened, migrations);
  opened.db
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, 1);

  seedMessage(opened.db, messageIds.first, 1, "First subject", "first body", "[]");
  seedMessage(opened.db, messageIds.second, 2, "Second subject", "second body", '["\\\\Seen"]');
  // The control character is a sentinel: it is invalid at the public contract
  // boundary, so a select-all hydration implementation would fail when it
  // materializes this off-page entity.
  seedMessage(opened.db, messageIds.offPage, 3, "OFF_PAGE_SENTINEL", "off-page body", "[]", "\u0001bad");
  seedMessage(opened.db, messageIds.fourth, 4, "Fourth subject", "fourth body", "[]");
  opened.db
    .query(
      "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) SELECT rowid, subject, participants, body_plain, body_html, attachment_names FROM indexed_messages;",
    )
    .run();
  promoteCanonicalMessage(opened.db, canonicalUnit());
  updateMessageSearchProjection(opened.db, messageIds.canonical, (database) => {
    database
      .query("UPDATE message_body_parts SET plain_text = ? WHERE message_id = ?;")
      .run("canonical body", messageIds.canonical);
  });
  return opened;
}

function canonicalUnit(): PromotionUnit {
  return {
    messageId: messageIds.canonical,
    rawSource: { blobId: createBlobId(`blob:${"1".repeat(64)}`), size: 1 },
    placements: [
      {
        accountId,
        mailboxId,
        uidValidity: 1,
        uid: 50,
        internalDate: createUtcInstant("2026-08-18T00:50:00.000Z"),
      },
    ],
    headers: [
      {
        ordinal: 1,
        name: "Subject",
        normalizedName: "subject",
        value: "Canonical subject",
        normalizedValue: "Canonical subject",
      },
      {
        ordinal: 2,
        name: "Date",
        normalizedName: "date",
        value: "2026-08-18T00:49:00.000Z",
        normalizedValue: "2026-08-18T00:49:00.000Z",
      },
    ],
    addresses: [
      {
        ordinal: 1,
        role: "from",
        position: 1,
        address: "canonical@example.test",
        normalizedAddress: "canonical@example.test",
        displayName: "Canonical Sender",
        groupName: null,
      },
    ],
    bodyParts: [
      {
        ordinal: 1,
        contentType: "text/plain",
        normalizedContentType: "text/plain",
        size: 15,
        blobId: createBlobId(`blob:${"2".repeat(64)}`),
      },
    ],
    attachments: [],
    routingDecisions: [],
    journal: {
      id: "event:promotion:canonical",
      occurredAt: createUtcInstant("2026-08-18T00:51:00.000Z"),
      category: "sync",
      subjectId: messageIds.canonical,
      correlationId: "sync:canonical",
      payloadVersion: 1,
      payloadJson: '{"status":"promoted"}',
    },
  };
}

function seedMessage(
  database: DatabaseType,
  messageId: MessageId,
  documentId: number,
  subject: string,
  body: string,
  flagsJson: string,
  senderAddress = `sender-${documentId}@example.test`,
  internalDate: string | null = `2026-08-18T00:0${documentId}:00.000Z`,
): void {
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  database
    .query("INSERT INTO message_search_documents (document_id, message_id) VALUES (?, ?);")
    .run(documentId, messageId);
  database
    .query(
      "INSERT INTO message_headers (message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, 1, 'Subject', 'subject', ?, ?), (?, 2, 'Date', 'date', ?, ?);",
    )
    .run(messageId, subject, subject, messageId, "2026-08-18T00:00:00.000Z", "2026-08-18T00:00:00.000Z");
  database
    .query(
      "INSERT INTO message_addresses (message_id, ordinal, role, position, address, normalized_address, display_name, group_name) VALUES (?, 1, 'from', 1, ?, ?, ?, NULL);",
    )
    .run(messageId, senderAddress, senderAddress, `Sender ${documentId}`);
  database
    .query(
      "INSERT INTO message_body_parts (message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text) VALUES (?, 1, 'text/plain', 'text/plain', ?, ?);",
    )
    .run(messageId, "e".repeat(64), body);
  database
    .query(
      "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, 1, ?, ?, ?, ?);",
    )
    .run(accountId, mailboxId, documentId, messageId, internalDate, flagsJson);
  database
    .query(
      "INSERT INTO operational_journal (id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) VALUES (?, ?, 'sync', ?, ?, 1, '{\"status\":\"promoted\"}');",
    )
    .run(`event:promotion:${documentId}`, "2026-08-18T00:00:00.000Z", messageId, `sync:${documentId}`);
  new ThreadGraphRepository(database).ingestFacts(
    normalizeThreadFacts({
      accountId,
      messageId,
      headers: [
        { ordinal: 1, normalizedName: "message-id", value: `<${messageId.slice("message:".length)}@fixture.test>` },
        { ordinal: 2, normalizedName: "date", value: "2026-08-18T00:00:00.000Z" },
      ],
      receivedAt: internalDate,
      participants: senderAddress.includes("\u0001")
        ? []
        : [{ address: senderAddress, displayName: `Sender ${documentId}`, role: "from", position: 1 }],
    }),
  );
}

function candidate(messageId: MessageId, score: number, position: number, receivedAt: string | null) {
  return { messageId, score, position, canonicalInstant: receivedAt } as const;
}

function addLivePlacement(database: DatabaseType, messageId: MessageId, uid: number, flagsJson: string): void {
  database
    .query(
      "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, 1, ?, ?, ?, ?);",
    )
    .run(accountId, mailboxId, uid, messageId, "2026-08-18T00:05:00.000Z", flagsJson);
}

describe("final-page search summary hydration P4-C07", () => {
  test("hydrates only final identities, restores order, and matches SearchHit", async () => {
    const opened = await openFixture();
    const result = hydrateSearchSummaryPage(opened.db, {
      accountId,
      candidates: [
        candidate(messageIds.second, -2, 1, "2026-08-18T00:02:00.000Z"),
        candidate(messageIds.first, -1, 2, "2026-08-18T00:01:00.000Z"),
      ],
    });

    expect(result.map(({ messageId }) => messageId)).toEqual([messageIds.second, messageIds.first]);
    expect(result[0]).toEqual({
      messageId: messageIds.second,
      threadId: expect.stringMatching(/^thread:[0-9a-f]{64}$/u),
      subject: "Second subject",
      sender: { name: "Sender 2", address: "sender-2@example.test" },
      sentAt: "2026-08-18T00:00:00.000Z",
      receivedAt: "2026-08-18T00:02:00.000Z",
      snippet: "second body",
      isUnread: false,
      hasAttachment: false,
      score: -2,
    });
    for (const item of result) expect(searchHitSchema.parse(item)).toEqual(item);
    expect(result).not.toContainEqual(expect.objectContaining({ messageId: messageIds.offPage }));
    await opened.close();
  });

  test("uses a candidate-driven SQLite plan and rejects the select-all counterexample", async () => {
    const opened = await openFixture();
    const hydrationSql = searchSummaryHydrationSql(2);
    const plan = opened.db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${hydrationSql}`)
      .all();
    const details = plan.map(({ detail }) => detail).join("\n");
    expect(details).toContain("SEARCH message USING COVERING INDEX");
    expect(details).not.toMatch(/SCAN message(?:\s|$)/u);

    const selectAllPlan = opened.db
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT message_id FROM messages ORDER BY message_id LIMIT 2;",
      )
      .all()
      .map(({ detail }) => detail)
      .join("\n");
    expect(selectAllPlan).toMatch(/SCAN messages/u);

    const result = hydrateSearchSummaryPage(opened.db, {
      accountId,
      candidates: [
        candidate(messageIds.first, -1, 1, "2026-08-18T00:01:00.000Z"),
        candidate(messageIds.fourth, -4, 2, "2026-08-18T00:04:00.000Z"),
      ],
    });
    expect(result).toHaveLength(2);
    expect(result.map(({ subject }) => subject)).toEqual(["First subject", "Fourth subject"]);
    await opened.close();
  });

  test("aggregates unread state across every live selected-account placement", async () => {
    const opened = await openFixture();
    // The first placement is \"\\Seen\"; the later live placement is unread.
    addLivePlacement(opened.db, messageIds.second, 102, "[]");
    const result = hydrateSearchSummaryPage(opened.db, {
      accountId,
      candidates: [candidate(messageIds.second, -2, 1, "2026-08-18T00:02:00.000Z")],
    });
    expect(result[0]?.isUnread).toBe(true);
    await opened.close();
  });

  test("flows persisted canonical INTERNALDATE through candidates into receivedAt", async () => {
    const opened = await openFixture();
    const placement = opened.db
      .query("SELECT internal_date FROM remote_placements WHERE message_id = ? AND account_id = ?;")
      .get(messageIds.canonical, accountId);
    expect(placement).toEqual({ internal_date: "2026-08-18T00:50:00.000Z" });
    expect(
      opened.db
        .query("SELECT normalized_value FROM message_headers WHERE message_id = ? AND normalized_name = 'date';")
        .get(messageIds.canonical),
    ).toEqual({ normalized_value: "2026-08-18T00:49:00.000Z" });
    expect(
      opened.db
        .query("SELECT subject_id FROM operational_journal WHERE subject_id = ?;")
        .all(messageIds.canonical),
    ).toEqual([{ subject_id: messageIds.canonical }]);

    const text = compileSearchQuery("Canonical");
    const filters = compileStructuredFilters([]);
    if (text.kind !== "compiled" || filters.kind !== "compiled") throw new Error("fixture query did not compile");
    const page = selectSearchCandidates(opened.db, {
      accountId,
      text,
      filters,
      limit: 1,
    });
    expect(page.candidates[0]?.canonicalInstant).toBe("2026-08-18T00:50:00.000Z");
    const result = hydrateSearchSummaryPage(opened.db, {
      accountId,
      candidates: page.candidates,
    });
    expect(result[0]?.receivedAt).toBe("2026-08-18T00:50:00.000Z");
    expect(result[0]?.sentAt).toBe("2026-08-18T00:49:00.000Z");
    await opened.close();
  });

  test("rejects a manual null canonical instant before SQL hydration", async () => {
    const opened = await openFixture();
    await opened.close();
    expect(() =>
      hydrateSearchSummaryPage(opened.db, {
        accountId,
        candidates: [candidate(messageIds.first, -1, 1, null)],
      }),
    ).toThrow("canonical instant is required");
  });

  test("rejects a page larger than the accepted candidate bound", async () => {
    const opened = await openFixture();
    expect(() =>
      hydrateSearchSummaryPage(opened.db, {
        accountId,
        candidates: Array.from({ length: 101 }, (_, index) =>
          candidate(messageIds.first, -index, index + 1, "2026-08-18T00:01:00.000Z"),
        ),
      }),
    ).toThrow("candidate page size");
    await opened.close();
  });

  test("requires the composed thread graph and never fabricates a thread handle", async () => {
    const database = new Database(":memory:");
    runMigrations(database, migrations.slice(0, -1));
    expect(searchSummaryHydrationSql(1)).not.toContain("substr(message_id");
    expect(() =>
      hydrateSearchSummaryPage(database, {
        accountId,
        candidates: [candidate(messageIds.first, -1, 1, "2026-08-18T00:01:00.000Z")],
      }),
    ).toThrow(SearchSummaryHydrationError);
    database.close();
  });

  test("fails closed when a final candidate has no graph membership", async () => {
    const opened = await openFixture();
    opened.db
      .query("DELETE FROM thread_memberships WHERE account_id = ? AND message_id = ?;")
      .run(accountId, messageIds.first);
    expect(() =>
      hydrateSearchSummaryPage(opened.db, {
        accountId,
        candidates: [candidate(messageIds.first, -1, 1, "2026-08-18T00:01:00.000Z")],
      }),
    ).toThrow("thread graph membership is missing");
    await opened.close();
  });
});
