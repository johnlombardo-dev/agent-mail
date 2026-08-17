import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";

const roots: string[] = [];
const messageId = `message:${"a".repeat(64)}`;
const plainBlob = "1".repeat(64);
const htmlBlob = "2".repeat(64);
const attachmentBlob = "3".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openStructuredContent() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-structured-content-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  applyMigrations(opened, [messageCatalogMigration, structuredContentMigration]);
  opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  return opened;
}

function insertMultipartFixture(database: Awaited<ReturnType<typeof openStructuredContent>>["db"]): void {
  database
    .query(
      "INSERT INTO message_headers " +
        "(message_id, ordinal, name, normalized_name, value, normalized_value) " +
        "VALUES (?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "Subject", "subject", "Multipart fixture", "multipart fixture");
  database
    .query(
      "INSERT INTO message_headers " +
        "(message_id, ordinal, name, normalized_name, value, normalized_value) " +
        "VALUES (?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 2, "X-Tag", "x-tag", "one", "one");
  database
    .query(
      "INSERT INTO message_addresses " +
        "(message_id, ordinal, role, position, address, normalized_address, display_name) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "to", 1, "Ada <ada@example.test>", "ada@example.test", "Ada");
  database
    .query(
      "INSERT INTO message_addresses " +
        "(message_id, ordinal, role, position, address, normalized_address, display_name) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 2, "to", 2, "Grace <grace@example.test>", "grace@example.test", "Grace");
  database
    .query(
      "INSERT INTO message_body_parts " +
        "(message_id, ordinal, content_type, normalized_content_type, blob_id) " +
        "VALUES (?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "text/plain; charset=utf-8", "text/plain; charset=utf-8", plainBlob);
  database
    .query(
      "INSERT INTO message_body_parts " +
        "(message_id, ordinal, content_type, normalized_content_type, blob_id) " +
        "VALUES (?, ?, ?, ?, ?);",
    )
    .run(messageId, 2, "text/html; charset=utf-8", "text/html; charset=utf-8", htmlBlob);
  database
    .query(
      "INSERT INTO message_attachments " +
        "(message_id, ordinal, filename, content_type, normalized_content_type, size, blob_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?);",
    )
    .run(messageId, 1, "report.pdf", "application/pdf", "application/pdf", 7, attachmentBlob);
}

describe("structured content migration", () => {
  test("stores multipart metadata in exact sequence with immutable blob references", async () => {
    const opened = await openStructuredContent();
    insertMultipartFixture(opened.db);

    expect(
      opened.db
        .query(
          "SELECT ordinal, normalized_name, normalized_value FROM message_headers " +
            "WHERE message_id = ? ORDER BY ordinal;",
        )
        .all(messageId),
    ).toEqual([
      { ordinal: 1, normalized_name: "subject", normalized_value: "multipart fixture" },
      { ordinal: 2, normalized_name: "x-tag", normalized_value: "one" },
    ]);
    expect(
      opened.db
        .query(
          "SELECT ordinal, role, position, normalized_address FROM message_addresses " +
            "WHERE message_id = ? ORDER BY ordinal;",
        )
        .all(messageId),
    ).toEqual([
      { ordinal: 1, role: "to", position: 1, normalized_address: "ada@example.test" },
      { ordinal: 2, role: "to", position: 2, normalized_address: "grace@example.test" },
    ]);
    expect(
      opened.db
        .query(
          "SELECT ordinal, blob_id FROM message_body_parts WHERE message_id = ? ORDER BY ordinal;",
        )
        .all(messageId),
    ).toEqual([
      { ordinal: 1, blob_id: plainBlob },
      { ordinal: 2, blob_id: htmlBlob },
    ]);
    expect(
      opened.db
        .query(
          "SELECT ordinal, filename, blob_id FROM message_attachments " +
            "WHERE message_id = ? ORDER BY ordinal;",
        )
        .all(messageId),
    ).toEqual([{ ordinal: 1, filename: "report.pdf", blob_id: attachmentBlob }]);
    await opened.close();
  });

  test("rejects orphaned rows, including orphaned body and attachment parts", async () => {
    const opened = await openStructuredContent();
    const missingMessage = `message:${"b".repeat(64)}`;
    expect(() =>
      opened.db
        .query(
          "INSERT INTO message_body_parts " +
            "(message_id, ordinal, content_type, normalized_content_type, blob_id) VALUES (?, ?, ?, ?, ?);",
        )
        .run(missingMessage, 1, "text/plain", "text/plain", plainBlob),
    ).toThrow();
    expect(() =>
      opened.db
        .query(
          "INSERT INTO message_attachments " +
            "(message_id, ordinal, content_type, normalized_content_type, size, blob_id) " +
            "VALUES (?, ?, ?, ?, ?, ?);",
        )
        .run(missingMessage, 1, "application/octet-stream", "application/octet-stream", 1, attachmentBlob),
    ).toThrow();
    await opened.close();
  });

  test("rejects duplicate sequence positions, including same recipient header kind", async () => {
    const opened = await openStructuredContent();
    opened.db
      .query(
        "INSERT INTO message_addresses " +
          "(message_id, ordinal, role, position, address, normalized_address) VALUES (?, ?, ?, ?, ?, ?);",
      )
      .run(messageId, 1, "to", 1, "ada@example.test", "ada@example.test");
    expect(() =>
      opened.db
        .query(
          "INSERT INTO message_addresses " +
            "(message_id, ordinal, role, position, address, normalized_address) VALUES (?, ?, ?, ?, ?, ?);",
        )
        .run(messageId, 2, "to", 1, "grace@example.test", "grace@example.test"),
    ).toThrow();
    opened.db
      .query(
        "INSERT INTO message_headers " +
          "(message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, ?, ?, ?, ?, ?);",
      )
      .run(messageId, 3, "X-One", "x-one", "one", "one");
    expect(() =>
      opened.db
        .query(
          "INSERT INTO message_headers " +
            "(message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, ?, ?, ?, ?, ?);",
        )
        .run(messageId, 3, "X-Two", "x-two", "two", "two"),
    ).toThrow();
    await opened.close();
  });

  test("rejects over-limit untrusted text and invalid blob references", async () => {
    const opened = await openStructuredContent();
    expect(() =>
      opened.db
        .query(
          "INSERT INTO message_headers " +
            "(message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, ?, ?, ?, ?, ?);",
        )
        .run(messageId, 1, "Subject", "subject", "x".repeat(4097), "x".repeat(4097)),
    ).toThrow();
    expect(() =>
      opened.db
        .query(
          "INSERT INTO message_attachments " +
            "(message_id, ordinal, filename, content_type, normalized_content_type, size, blob_id) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?);",
        )
        .run(messageId, 1, "x".repeat(4097), "application/pdf", "application/pdf", 1, attachmentBlob),
    ).toThrow();
    expect(() =>
      opened.db
        .query(
          "INSERT INTO message_body_parts " +
            "(message_id, ordinal, content_type, normalized_content_type, blob_id) VALUES (?, ?, ?, ?, ?);",
        )
        .run(messageId, 1, "text/plain", "text/plain", "not-a-digest"),
    ).toThrow();
    await opened.close();
  });
});
