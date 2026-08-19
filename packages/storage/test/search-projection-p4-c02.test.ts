import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createMessageId, type MessageId } from "@agent-mail/core";
import { runMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { externalContentSearchMigration } from "../src/migrations/0003-external-content-search";
import {
  deleteMessageSearchProjection,
  SearchProjectionError,
  updateMessageSearchProjection,
} from "../src/search-projection";

const roots: string[] = [];
const messageId = createMessageId(`message:${"b".repeat(64)}`);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openSearchDatabase() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-search-projection-p4-c02-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  runMigrations(opened, [
    messageCatalogMigration,
    structuredContentMigration,
    externalContentSearchMigration,
  ]);
  opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  seedSource(opened.db, messageId, "old subject", "old body");
  return opened;
}

function seedSource(database: Database, id: MessageId, subject: string, body: string): void {
  database
    .query(
      "INSERT INTO message_headers " +
        "(message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, 1, ?, ?, ?, ?);",
    )
    .run(id, "Subject", "subject", subject, subject);
  database
    .query(
      "INSERT INTO message_body_parts " +
        "(message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text) " +
        "VALUES (?, 1, 'text/plain', 'text/plain', ?, ?);",
    )
    .run(id, "c".repeat(64), body);
}

function projectionRows(database: Database): readonly unknown[] {
  return database.query("SELECT * FROM indexed_messages;").all();
}

function ftsMatches(database: Database, query: string): number {
  return database
    .query("SELECT rowid FROM message_fts WHERE message_fts MATCH ?;")
    .all(query).length;
}

function sourceSubject(database: Database): string {
  const row = database
    .query<{ normalized_value: string }, []>(
      "SELECT normalized_value FROM message_headers WHERE message_id = ? AND normalized_name = 'subject';",
    )
    .get(messageId);
  if (row === null) throw new Error("subject source row is missing");
  return row.normalized_value;
}

describe("transactional FTS projection P4-C02", () => {
  test("updates normalized source fields and FTS with stable mapping identity", async () => {
    const opened = await openSearchDatabase();
    const initial = updateMessageSearchProjection(opened.db, messageId, () => undefined);
    expect(initial).toMatchObject({ kind: "updated", projection: { documentId: 1 } });
    expect(ftsMatches(opened.db, "old")).toBe(1);

    const updated = updateMessageSearchProjection(opened.db, messageId, (database, id) => {
      database
        .query(
          "UPDATE message_headers SET value = ?, normalized_value = ? " +
            "WHERE message_id = ? AND normalized_name = 'subject';",
        )
        .run("New subject", "new subject", id);
      database
        .query("UPDATE message_body_parts SET plain_text = ? WHERE message_id = ?;")
        .run("new body", id);
    });
    expect(updated).toEqual({
      kind: "updated",
      projection: {
        documentId: 1,
        messageId,
        subject: "new subject",
        participants: "",
        bodyPlain: "new body",
        bodyHtml: "",
        attachmentNames: "",
      },
    });
    expect(ftsMatches(opened.db, "old")).toBe(0);
    expect(ftsMatches(opened.db, "new")).toBe(1);
    expect(projectionRows(opened.db)).toEqual([
      {
        rowid: 1,
        message_id: messageId,
        subject: "new subject",
        participants: "",
        body_plain: "new body",
        body_html: "",
        attachment_names: "",
      },
    ]);

    const mapping = opened.db
      .query("SELECT document_id FROM message_search_documents WHERE message_id = ?;")
      .get(messageId);
    expect(mapping).toEqual({ document_id: 1 });
    await opened.close();
  });

  test("rolls back source and FTS changes at every post-source failure boundary", async () => {
    for (const boundary of ["after-source", "fts-delete", "fts-insert"] as const) {
      const opened = await openSearchDatabase();
      updateMessageSearchProjection(opened.db, messageId, () => undefined);
      const injected = new Error(`injected ${boundary}`);
      let observed: unknown;
      try {
        updateMessageSearchProjection(
          opened.db,
          messageId,
          (database, id) => {
            database
              .query(
                "UPDATE message_headers SET value = ?, normalized_value = ? " +
                  "WHERE message_id = ? AND normalized_name = 'subject';",
              )
              .run("new subject", "new subject", id);
          },
          {
            beforeWrite: (actual) => {
              if (actual === boundary) throw injected;
            },
          },
        );
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(SearchProjectionError);
      expect(observed).toMatchObject({ code: "write-failed", cause: injected });
      expect(sourceSubject(opened.db)).toBe("old subject");
      expect(ftsMatches(opened.db, "old")).toBe(1);
      expect(ftsMatches(opened.db, "new")).toBe(0);
      await opened.close();
    }
  });

  test("deletes only FTS projection and retains canonical source and immutable mapping", async () => {
    const opened = await openSearchDatabase();
    updateMessageSearchProjection(opened.db, messageId, () => undefined);
    expect(deleteMessageSearchProjection(opened.db, messageId)).toEqual({
      kind: "deleted",
      status: "deleted",
      documentId: 1,
    });
    expect(ftsMatches(opened.db, "old")).toBe(0);
    expect(sourceSubject(opened.db)).toBe("old subject");
    expect(opened.db.query("SELECT message_id FROM messages WHERE message_id = ?;").get(messageId)).toEqual({
      message_id: messageId,
    });
    expect(
      opened.db.query("SELECT document_id FROM message_search_documents WHERE message_id = ?;").get(messageId),
    ).toEqual({ document_id: 1 });
    await opened.close();
  });

  test("rejects malformed message identity before opening a transaction", async () => {
    const opened = await openSearchDatabase();
    expect(() => updateMessageSearchProjection(opened.db, "message:not-a-digest", () => undefined)).toThrow(
      "search projection input",
    );
    await opened.close();
  });
});
