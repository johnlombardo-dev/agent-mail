import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { createMessageId } from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { localLabelMigration } from "../src/local-label-migration";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { externalContentSearchMigration } from "../src/migrations/0003-external-content-search";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import { compileSearchQuery } from "../src/search-query-compiler";
import { selectSearchCandidates } from "../src/search-candidate-repository";
import { compileStructuredFilters } from "../src/structured-filter-compiler";
import { createSearchCursorIntegrityCodec, SearchCursorError } from "../src/search-cursor";
import { threadGraphMigration } from "../src/migrations/0008-thread-graph";

const roots: string[] = [];
const accountId = "account:fixture";
const otherAccountId = "account:other";
const mailboxId = "mailbox:inbox";
const cursorCodec = createSearchCursorIntegrityCodec("search-filter-closure-secret");
const messageIds = {
  a: createMessageId(`message:${"a".repeat(64)}`),
  b: createMessageId(`message:${"b".repeat(64)}`),
  c: createMessageId(`message:${"c".repeat(64)}`),
  d: createMessageId(`message:${"d".repeat(64)}`),
} as const;

const migrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  externalContentSearchMigration,
  { ...placementObservationMigration, version: 4 },
  { ...localLabelMigration, version: 5 },
  { ...threadGraphMigration, version: 6 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type FixtureName = keyof typeof messageIds;

async function openFixture(
  order: readonly FixtureName[] = ["a", "b", "c", "d"],
  equalText = false,
) {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-search-candidate-p4-c05-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  applyMigrations(opened, migrations);
  opened.db
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, 1);

  for (const [documentId, name] of order.entries()) {
    const messageId = messageIds[name];
    const subject = name === "b" && !equalText ? "ordinary" : "needle";
    opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    opened.db
      .query("INSERT INTO message_search_documents (document_id, message_id) VALUES (?, ?);")
      .run(documentId + 1, messageId);
    opened.db
      .query(
        "INSERT INTO message_headers (message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, ?, ?, ?, ?, ?);",
      )
      .run(messageId, 1, "Subject", "subject", subject, subject);
    opened.db
      .query(
        "INSERT INTO message_headers (message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, ?, ?, ?, ?, ?);",
      )
      .run(messageId, 2, "List-Id", "list-id", "<news@example.test>", "<news@example.test>");
    opened.db
      .query(
        "INSERT INTO message_addresses (message_id, ordinal, role, position, address, normalized_address) VALUES (?, ?, ?, ?, ?, ?);",
      )
      .run(messageId, 1, "from", 1, "Alice@example.test", "alice@example.test");

    const internalDate = name === "c" ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z";
    const flags = name === "a" || name === "d" ? ["\\Seen"] : [];
    const tombstone = name === "d";
    opened.db
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json, tombstone_observed_at, tombstone_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        accountId,
        mailboxId,
        1,
        documentId + 1,
        messageId,
        internalDate,
        JSON.stringify(flags),
        tombstone ? "2026-01-03T00:00:00.000Z" : null,
        tombstone ? "fixture removal" : null,
      );

    if (name === "a") {
      opened.db.query("INSERT INTO local_labels (label) VALUES (?);").run("label:importance:high");
      opened.db
        .query(
          "INSERT INTO local_label_assignments (message_id, label, rule_id, rule_version, matched_facts_json, decided_at, provenance_source, provenance_evaluation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
        )
        .run(
          messageId,
          "label:importance:high",
          "rule:fixture",
          1,
          '["fixture"]',
          "2026-01-01T00:00:00.000Z",
          "fixture",
          "evaluation:fixture",
        );
    }
    if (name === "a" || (name === "b" && equalText)) {
      opened.db
        .query(
          "INSERT INTO message_attachments (message_id, ordinal, filename, content_type, normalized_content_type, size, blob_id) VALUES (?, ?, ?, ?, ?, ?, ?);",
        )
        .run(messageId, 1, "invoice.pdf", "application/pdf", "application/pdf", 1, "f".repeat(64));
    }
    if (name === "b" && !equalText) {
      opened.db
        .query(
          "INSERT INTO message_body_parts (message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text) VALUES (?, ?, ?, ?, ?, ?);",
        )
        .run(messageId, 1, "text/plain", "text/plain", "e".repeat(64), "needle");
    }
  }

  const canonicalThread = `thread:${"a".repeat(64)}`;
  const aliasThread = `thread:${"b".repeat(64)}`;
  const otherAccountThread = `thread:${"d".repeat(64)}`;
  opened.db
    .query(
      "INSERT INTO thread_sets (account_id, set_id, member_count, node_count, equivalence_count, edge_count, participant_count, handle_count, canonical_root_node_key, canonical_thread_id, updated_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      accountId,
      "set-a",
      2,
      0,
      0,
      0,
      0,
      2,
      "m:" + "a".repeat(64),
      canonicalThread,
      0,
      accountId,
      "set-b",
      1,
      0,
      0,
      0,
      0,
      1,
      "m:" + "c".repeat(64),
      `thread:${"c".repeat(64)}`,
      0,
      otherAccountId,
      "set-other",
      1,
      0,
      0,
      0,
      0,
      1,
      "m:" + "c".repeat(64),
      otherAccountThread,
      0,
    );
  opened.db
    .query(
      "INSERT INTO thread_handles (thread_id, account_id, set_id, created_generation, canonical_when_created) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?);",
    )
    .run(
      canonicalThread,
      accountId,
      "set-a",
      0,
      1,
      aliasThread,
      accountId,
      "set-a",
      0,
      0,
      `thread:${"c".repeat(64)}`,
      accountId,
      "set-b",
      0,
      1,
      otherAccountThread,
      otherAccountId,
      "set-other",
      0,
      1,
    );
  opened.db
    .query(
      "INSERT INTO thread_memberships (account_id, message_id, set_id, member_node_key, order_state, sent_at_missing_rank, added_generation) VALUES (?, ?, ?, ?, 'parsed', 1, 0), (?, ?, ?, ?, 'parsed', 1, 0), (?, ?, ?, ?, 'parsed', 1, 0), (?, ?, ?, ?, 'parsed', 1, 0);",
    )
    .run(
      accountId,
      messageIds.a,
      "set-a",
      "m:" + "a".repeat(64),
      accountId,
      messageIds.b,
      "set-a",
      "m:" + "b".repeat(64),
      accountId,
      messageIds.c,
      "set-b",
      "m:" + "c".repeat(64),
      otherAccountId,
      messageIds.c,
      "set-other",
      "m:" + "c".repeat(64),
    );

  opened.db
    .query(
      "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) SELECT rowid, subject, participants, body_plain, body_html, attachment_names FROM indexed_messages;",
    )
    .run();
  return opened;
}

function request(
  filters: readonly unknown[] = [],
  limit = 100,
  selectedAccountId: unknown = accountId,
  cursor?: unknown,
) {
  const text = compileSearchQuery("needle");
  const compiledFilters = compileStructuredFilters(filters, { accountId: selectedAccountId });
  expect(text.kind).toBe("compiled");
  expect(compiledFilters.kind).toBe("compiled");
  if (text.kind !== "compiled" || compiledFilters.kind !== "compiled") {
    throw new Error("fixture compiler input did not compile");
  }
  return { accountId: selectedAccountId, text, filters: compiledFilters, limit, cursor, cursorCodec };
}

describe("bounded FTS candidate repository P4-C05", () => {
  test("executes every compiled structured predicate against placement-aware schema", async () => {
    const opened = await openFixture();
    const cases: readonly [string, readonly unknown[]][] = [
      ["sender", [{ field: "sender", operator: "eq", value: "alice@example.test" }]],
      ["list", [{ field: "list", operator: "eq", value: "<news@example.test>" }]],
      ["remote mailbox", [{ field: "remoteMailbox", operator: "eq", value: "mailbox:inbox" }]],
      ["flag", [{ field: "flag", operator: "eq", value: "\\Seen" }]],
      ["importance", [{ field: "importance", operator: "eq", value: "high" }]],
      ["attachment", [{ field: "attachment", operator: "exists" }]],
      ["local label", [{ field: "localLabel", operator: "eq", value: "label:importance:high" }]],
      ["receivedAt", [{ field: "receivedAt", operator: "gte", value: "2026-01-01T00:00:00Z" }]],
    ];
    for (const [name, filters] of cases) {
      expect(() => selectSearchCandidates(opened.db, request(filters)), name).not.toThrow();
    }

    expect(
      selectSearchCandidates(
        opened.db,
        request([{ field: "flag", operator: "eq", value: "\\Seen" }]),
      ).candidates.map((candidate) => candidate.messageId),
    ).not.toContain(messageIds.d);
    expect(
      selectSearchCandidates(
        opened.db,
        request([{ field: "receivedAt", operator: "gte", value: "2026-01-03T00:00:00Z" }]),
      ).candidates,
    ).toEqual([]);
    expect(
      selectSearchCandidates(
        opened.db,
        request([{ field: "importance", operator: "eq", value: "high" }]),
      ).candidates.map((candidate) => candidate.messageId),
    ).toEqual([messageIds.a]);
    await opened.close();
  });

  test("matches exact normalized subjects and account-scoped canonical/alias handles", async () => {
    const opened = await openFixture();
    const canonical = `thread:${"a".repeat(64)}`;
    const alias = `thread:${"b".repeat(64)}`;
    // Mirror the ingestion boundary: normalized_value is whitespace-collapsed
    // and NFC-normalized before the candidate query ever sees it.
    opened.db
      .query(
        "UPDATE message_headers SET value = ?, normalized_value = ? WHERE message_id = ? AND normalized_name = 'subject';",
      )
      .run("Cafe\u0301  Report", "Caf\u00e9 Report", messageIds.a);
    const subject = selectSearchCandidates(
      opened.db,
      request([{ field: "subject", operator: "eq", value: " Cafe\u0301\t Report " }]),
    );
    expect(subject.candidates.map(({ messageId }) => messageId)).toEqual([messageIds.a]);

    const canonicalPage = selectSearchCandidates(
      opened.db,
      request([{ field: "threadId", operator: "eq", value: canonical }]),
    );
    const aliasPage = selectSearchCandidates(
      opened.db,
      request([{ field: "threadId", operator: "eq", value: alias }]),
    );
    expect(aliasPage.candidates.map(({ messageId }) => messageId)).toEqual(
      canonicalPage.candidates.map(({ messageId }) => messageId),
    );
    expect(
      selectSearchCandidates(
        opened.db,
        request([{ field: "threadId", operator: "eq", value: `thread:${"f".repeat(64)}` }]),
      ).candidates,
    ).toEqual([]);
    expect(
      selectSearchCandidates(
        opened.db,
        request([{ field: "threadId", operator: "eq", value: `thread:${"d".repeat(64)}` }]),
      ).candidates,
    ).toEqual([]);

    const combined = selectSearchCandidates(
      opened.db,
      request([
        { field: "subject", operator: "eq", value: "Cafe\u0301 Report" },
        { field: "threadId", operator: "eq", value: alias },
      ]),
    );
    expect(combined.candidates.map(({ messageId }) => messageId)).toEqual([messageIds.a]);
    await opened.close();
  });

  test("keeps an alias-issued cursor valid after the canonical handle changes", async () => {
    const opened = await openFixture();
    const alias = `thread:${"b".repeat(64)}`;
    const first = selectSearchCandidates(
      opened.db,
      request([{ field: "threadId", operator: "eq", value: alias }], 1),
    );
    expect(first.nextCursor).not.toBeNull();
    opened.db
      .query("UPDATE thread_sets SET canonical_thread_id = ? WHERE account_id = ? AND set_id = ?;")
      .run(`thread:${"e".repeat(64)}`, accountId, "set-a");
    if (first.nextCursor === null) throw new Error("expected alias cursor");
    const continuation = selectSearchCandidates(
      opened.db,
      request([{ field: "threadId", operator: "eq", value: alias }], 1, accountId, first.nextCursor),
    );
    expect(continuation.candidates).toHaveLength(1);
    await opened.close();
  });

  test("binds cursor replay to the requested account and thread handle", async () => {
    const opened = await openFixture();
    const alias = `thread:${"b".repeat(64)}`;
    const first = selectSearchCandidates(
      opened.db,
      request([{ field: "threadId", operator: "eq", value: alias }], 1),
    );
    if (first.nextCursor === null) throw new Error("expected alias cursor");
    expect(() =>
      selectSearchCandidates(
        opened.db,
        request([{ field: "threadId", operator: "eq", value: alias }], 1, otherAccountId, first.nextCursor),
      ),
    ).toThrow(SearchCursorError);
    expect(() =>
      selectSearchCandidates(
        opened.db,
        request(
          [{ field: "threadId", operator: "eq", value: `thread:${"c".repeat(64)}` }],
          1,
          accountId,
          first.nextCursor,
        ),
      ),
    ).toThrow(SearchCursorError);
    await opened.close();
  });

  test("returns pinned BM25 scores, canonical instants, and bounded deterministic order", async () => {
    const opened = await openFixture(["a", "b", "c"]);
    const page = selectSearchCandidates(opened.db, request([], 3));

    expect(page.limit).toBe(3);
    expect(page.bm25Weights).toEqual({
      subject: 10,
      participants: 4,
      bodyPlain: 3,
      bodyHtml: 2,
      attachmentNames: 1,
    });
    expect(page.candidates).toHaveLength(3);
    expect(page.candidates.map(({ messageId }) => messageId)).toEqual([messageIds.c, messageIds.a, messageIds.b]);
    expect(page.candidates.map(({ position }) => position)).toEqual([1, 2, 3]);
    expect(page.candidates.map(({ canonicalInstant }) => canonicalInstant)).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    expect(page.candidates.map(({ score }) => score)).toEqual([
      -0.000001996370235934664,
      -0.0000019332161687170474,
      -0.0000015714285714285712,
    ]);
    await opened.close();
  });

  test("returns only messages with a live placement in the selected account", async () => {
    const opened = await openFixture();
    opened.db
      .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
      .run(otherAccountId, mailboxId, 1);

    // b has one live and one tombstoned placement in the selected account.
    opened.db
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json, tombstone_observed_at, tombstone_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        accountId,
        mailboxId,
        1,
        101,
        messageIds.b,
        "2026-01-01T00:00:00.000Z",
        "[]",
        "2026-01-03T00:00:00.000Z",
        "fixture removal",
      );
    // c is all-tombstoned in the selected account.
    opened.db
      .query(
        "UPDATE remote_placements SET tombstone_observed_at = ?, tombstone_reason = ? WHERE account_id = ? AND message_id = ?;",
      )
      .run("2026-01-03T00:00:00.000Z", "fixture removal", accountId, messageIds.c);
    // d is tombstoned in the selected account but live in another account.
    opened.db
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        otherAccountId,
        mailboxId,
        1,
        201,
        messageIds.d,
        "2026-01-01T00:00:00.000Z",
        "[]",
      );

    expect(selectSearchCandidates(opened.db, request([], 100)).candidates.map(({ messageId }) => messageId)).toEqual([
      messageIds.a,
      messageIds.b,
    ]);

    // Tombstoning b's final live placement hides it without deleting retained content.
    opened.db
      .query(
        "UPDATE remote_placements SET tombstone_observed_at = ?, tombstone_reason = ? WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL;",
      )
      .run("2026-01-04T00:00:00.000Z", "fixture removal", accountId, messageIds.b);
    expect(selectSearchCandidates(opened.db, request([], 100)).candidates.map(({ messageId }) => messageId)).toEqual([
      messageIds.a,
    ]);
    expect(opened.db.query("SELECT COUNT(*) AS count FROM message_fts;").get()).toEqual({ count: 4 });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM messages WHERE message_id = ?;").get(messageIds.b)).toEqual({
      count: 1,
    });
    expect(
      opened.db.query("SELECT COUNT(*) AS count FROM message_search_documents WHERE message_id = ?;").get(messageIds.b),
    ).toEqual({ count: 1 });
    await opened.close();
  });

  test("breaks equal-score/equal-time ties by canonical identity independent of insertion order", async () => {
    const first = await openFixture(["b", "a"], true);
    const second = await openFixture(["a", "b"], true);
    const firstPage = selectSearchCandidates(first.db, request([], 2));
    const secondPage = selectSearchCandidates(second.db, request([], 2));

    expect(firstPage.candidates.map(({ messageId }) => messageId)).toEqual([messageIds.a, messageIds.b]);
    expect(secondPage.candidates.map(({ messageId }) => messageId)).toEqual([messageIds.a, messageIds.b]);
    expect(firstPage.candidates.map(({ score }) => score)).toEqual(secondPage.candidates.map(({ score }) => score));
    expect(firstPage.candidates.map(({ canonicalInstant }) => canonicalInstant)).toEqual(
      secondPage.candidates.map(({ canonicalInstant }) => canonicalInstant),
    );
    await first.close();
    await second.close();
  });

  test("uses only the selected account placement for canonical time and tie order", async () => {
    const opened = await openFixture(["a", "b"], true);
    opened.db
      .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
      .run(otherAccountId, mailboxId, 1);
    opened.db
      .query("DELETE FROM remote_placements WHERE account_id = ? AND message_id = ?;")
      .run(accountId, messageIds.b);
    opened.db
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        accountId,
        mailboxId,
        1,
        102,
        messageIds.b,
        "2026-01-02T00:00:00.000Z",
        "[]",
      );
    opened.db
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        otherAccountId,
        mailboxId,
        1,
        201,
        messageIds.b,
        "2025-01-01T00:00:00.000Z",
        "[]",
      );

    const page = selectSearchCandidates(opened.db, request([], 2));
    expect(page.candidates.map(({ messageId }) => messageId)).toEqual([messageIds.b, messageIds.a]);
    expect(page.candidates.map(({ canonicalInstant }) => canonicalInstant)).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    await opened.close();
  });

  test("rejects an unbounded candidate page", async () => {
    const opened = await openFixture();
    expect(() => selectSearchCandidates(opened.db, request([], 101))).toThrow(
      "candidate page size must be between 1 and 100",
    );
    await opened.close();
  });

  test("rejects an account scope that is not a canonical account identifier", async () => {
    const opened = await openFixture();
    expect(() => selectSearchCandidates(opened.db, request([], 100, "fixture"))).toThrow(
      "Account ID serialization has the wrong namespace",
    );
    await opened.close();
  });
});
