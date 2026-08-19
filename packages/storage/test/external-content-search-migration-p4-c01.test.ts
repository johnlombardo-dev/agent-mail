import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import {
  externalContentSearchMigration,
  MESSAGE_FTS_BM25_WEIGHTS,
} from "../src/migrations/0003-external-content-search";

const roots: string[] = [];
const messageId = `message:${"a".repeat(64)}`;
const attachmentBlob = "f".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openSearchSchema() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-external-search-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  runMigrations(opened, [messageCatalogMigration, structuredContentMigration, externalContentSearchMigration]);
  opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  opened.db
    .query("INSERT INTO message_search_documents (document_id, message_id) VALUES (?, ?);")
    .run(41, messageId);
  return opened;
}

function seedFixture(database: Awaited<ReturnType<typeof openSearchSchema>>["db"]): void {
  database
    .query(
      "INSERT INTO message_headers " +
        "(message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "Subject", "subject", "Café launch", "café launch");
  database
    .query(
      "INSERT INTO message_addresses " +
        "(message_id, ordinal, role, position, address, normalized_address) VALUES (?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "to", 1, "Ada <ada@example.test>", "ada@example.test");
  database
    .query(
      "INSERT INTO message_body_parts " +
        "(message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text) VALUES (?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "text/plain", "text/plain", "1".repeat(64), "Plain café receipt");
  database
    .query(
      "INSERT INTO message_body_parts " +
        "(message_id, ordinal, content_type, normalized_content_type, blob_id, html_derived_text) VALUES (?, ?, ?, ?, ?, ?);",
    )
    .run(
      messageId,
      2,
      "text/html",
      "text/html",
      "2".repeat(64),
      "Safe button details",
    );
  database
    .query(
      "INSERT INTO message_attachments " +
        "(message_id, ordinal, filename, content_type, normalized_content_type, size, blob_id) VALUES (?, ?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "receipt.pdf", "application/pdf", "application/pdf", 4, attachmentBlob);
}

describe("external-content FTS5 migration", () => {
  test("creates an introspectable external-content schema with pinned tokenizer and weights", async () => {
    const opened = await openSearchSchema();

    expect(
      opened.db
        .query<{ name: string; type: string }, []>(
          "SELECT name, type FROM sqlite_master " +
            "WHERE name IN ('indexed_messages', 'message_fts', 'message_search_documents') " +
            "ORDER BY name;",
        )
        .all(),
    ).toEqual([
      { name: "indexed_messages", type: "view" },
      { name: "message_fts", type: "table" },
      { name: "message_search_documents", type: "table" },
    ]);
    expect(
      opened.db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('message_fts') ORDER BY cid;")
        .all(),
    ).toEqual([
      { name: "subject" },
      { name: "participants" },
      { name: "body_plain" },
      { name: "body_html" },
      { name: "attachment_names" },
    ]);
    const migrationSql = opened.db
      .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?;")
      .get("message_fts");
    expect(migrationSql?.sql).toContain("content='indexed_messages'");
    expect(migrationSql?.sql).toContain("content_rowid='rowid'");
    expect(migrationSql?.sql).toContain("tokenize='unicode61 remove_diacritics 2'");
    expect(MESSAGE_FTS_BM25_WEIGHTS).toEqual({
      subject: 10,
      participants: 4,
      bodyPlain: 3,
      bodyHtml: 2,
      attachmentNames: 1,
    });
    await opened.close();
  });

  test("projects only normalized searchable fields and tokenizes real Unicode content", async () => {
    const opened = await openSearchSchema();
    seedFixture(opened.db);

    expect(opened.db.query("SELECT * FROM indexed_messages;").all()).toEqual([
      {
        rowid: 41,
        message_id: messageId,
        subject: "café launch",
        participants: "ada@example.test",
        body_plain: "Plain café receipt",
        body_html: "Safe button details",
        attachment_names: "receipt.pdf",
      },
    ]);

    // External-content FTS is deliberately not updated by this migration. Seed
    // one row in the test with SQLite's real FTS API to inspect its tokenizer.
    opened.db
      .query(
        "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) " +
          "SELECT rowid, subject, participants, body_plain, body_html, attachment_names FROM indexed_messages;",
      )
      .run();
    opened.db.exec("CREATE VIRTUAL TABLE fts_terms USING fts5vocab(message_fts, 'row');");
    expect(opened.db.query("SELECT term FROM fts_terms ORDER BY term;").all()).toEqual([
      { term: "ada" },
      { term: "button" },
      { term: "cafe" },
      { term: "details" },
      { term: "example" },
      { term: "launch" },
      { term: "pdf" },
      { term: "plain" },
      { term: "receipt" },
      { term: "safe" },
      { term: "test" },
    ]);
    opened.db.exec("VACUUM;");
    expect(opened.db.query("SELECT rowid, message_id FROM indexed_messages;").get()).toMatchObject({
      rowid: 41,
      message_id: messageId,
    });
    expect(() =>
      opened.db
        .query("UPDATE message_search_documents SET document_id = 42 WHERE document_id = 41;")
        .run(),
    ).toThrow("search document identity is immutable");
    await opened.close();
  });

  test("does not expose raw HTML markup or attachment bytes as searchable fields", async () => {
    const opened = await openSearchSchema();
    seedFixture(opened.db);

    const content = opened.db.query("SELECT * FROM indexed_messages;").get();
    expect(content).not.toHaveProperty("blob_id");
    expect(content).not.toHaveProperty("content_type");
    expect(JSON.stringify(content)).not.toContain(attachmentBlob);
    expect(JSON.stringify(content)).not.toContain("<button");
    expect(JSON.stringify(content)).not.toContain("</button>");

    opened.db
      .query(
        "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) " +
          "SELECT rowid, subject, participants, body_plain, body_html, attachment_names FROM indexed_messages;",
      )
      .run();
    expect(opened.db.query("SELECT rowid FROM message_fts WHERE message_fts MATCH ?;").all("button")).toHaveLength(1);
    expect(opened.db.query("SELECT rowid FROM message_fts WHERE message_fts MATCH ?;").all("script")).toHaveLength(0);
    expect(
      opened.db.query("SELECT rowid FROM message_fts WHERE message_fts MATCH ?;").all(attachmentBlob),
    ).toHaveLength(0);
    expect(() =>
      opened.db
        .query("UPDATE message_body_parts SET plain_text = ? WHERE ordinal = 1;")
        .run(new Uint8Array([1, 2, 3])),
    ).toThrow();
    expect(() =>
      opened.db
        .query("UPDATE message_body_parts SET html_derived_text = ? WHERE ordinal = 2;")
        .run("x".repeat(8 * 1024 * 1024 + 1)),
    ).toThrow();
    await opened.close();
  });
});
