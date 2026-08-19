import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { externalContentSearchMigration } from "../src/migrations/0003-external-content-search";
import {
  rebuildSearchIndex,
  SearchReindexError,
  type SearchReindexBoundary,
} from "../src/search-reindex";

const migrations = [
  messageCatalogMigration,
  structuredContentMigration,
  externalContentSearchMigration,
];
const firstMessage = `message:${"a".repeat(64)}`;
const secondMessage = `message:${"b".repeat(64)}`;
const thirdMessage = `message:${"c".repeat(64)}`;
const roots: string[] = [];

function fixture(): Database {
  const database = new Database(":memory:", { strict: true });
  seedFixture(database);
  return database;
}

function seedFixture(database: Database): void {
  runMigrations(database, migrations);
  database
    .query("INSERT INTO messages (message_id) VALUES (?), (?);")
    .run(firstMessage, secondMessage);
  database
    .query(
      "INSERT INTO message_search_documents (document_id, message_id) VALUES (?, ?), (?, ?);",
    )
    .run(10, firstMessage, 20, secondMessage);
  database
    .query(
      "INSERT INTO message_headers " +
        "(message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, 1, 'Subject', 'subject', ?, ?), (?, 1, 'Subject', 'subject', ?, ?);",
    )
    .run(
      firstMessage,
      "old invoice",
      "old invoice",
      secondMessage,
      "new receipt",
      "new receipt",
    );
  database
    .query(
      "INSERT INTO message_body_parts " +
        "(message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text) VALUES (?, 1, 'text/plain', 'text/plain', ?, ?), (?, 1, 'text/plain', 'text/plain', ?, ?);",
    )
    .run(
      firstMessage,
      "1".repeat(64),
      "old body",
      secondMessage,
      "2".repeat(64),
      "new body",
    );
  database
    .query(
      "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) " +
        "SELECT rowid, subject, participants, body_plain, body_html, attachment_names FROM indexed_messages WHERE rowid = 10;",
    )
    .run();
}

function activeIds(database: Database, query: string): readonly number[] {
  return database
    .query<{ rowid: number }, [string]>(
      "SELECT rowid FROM message_fts WHERE message_fts MATCH ? ORDER BY rowid;",
    )
    .all(query)
    .map((row) => row.rowid);
}

describe("replacement FTS reindex P7-C03", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("interrupting each durable build boundary leaves the old index active and restart resumes", () => {
    const database = fixture();
    const boundaries: SearchReindexBoundary[] = [];
    expect(() =>
      rebuildSearchIndex(database, {
        batchSize: 1,
        representativeQueries: [
          { query: "old", expectedRowids: [10] },
          { query: "new", expectedRowids: [20] },
        ],
        beforeBoundary: (boundary) => {
          boundaries.push(boundary);
          if (boundary === "batch-committed")
            throw new Error("interrupt batch");
        },
      }),
    ).toThrow("interrupt batch");
    expect(activeIds(database, "old")).toEqual([10]);
    expect(activeIds(database, "new")).toEqual([]);
    expect(
      database
        .query(
          "SELECT phase, last_rowid, processed_rows FROM search_reindex_lease;",
        )
        .all(),
    ).toEqual([{ phase: "building", last_rowid: 10, processed_rows: 1 }]);

    const verificationBatches: number[] = [];
    const representativeLimits: number[] = [];
    const result = rebuildSearchIndex(database, {
      batchSize: 1,
      representativeQueries: [
        { query: "old", expectedRowids: [10] },
        { query: "new", expectedRowids: [20] },
      ],
      onVerificationBatch: (batch) => {
        expect(batch.sourceRows).toBeLessThanOrEqual(1);
        expect(batch.progressRows).toBeLessThanOrEqual(1);
        expect(batch.replacementRows).toBeLessThanOrEqual(1);
        verificationBatches.push(
          Math.max(batch.sourceRows, batch.progressRows, batch.replacementRows),
        );
      },
      onRepresentativeProbe: (probe) => {
        expect(probe.requestedLimit).toBeLessThanOrEqual(2);
        expect(probe.returnedRows).toBeLessThanOrEqual(2);
        representativeLimits.push(probe.requestedLimit);
      },
    });
    expect(result.sourceRowCount).toBe(2);
    expect(result.replacementRowCount).toBe(2);
    expect(result.sourceChecksum).toBe(result.replacementChecksum);
    expect(activeIds(database, "old")).toEqual([10]);
    expect(activeIds(database, "new")).toEqual([20]);
    expect(database.query("SELECT * FROM search_reindex_lease;").all()).toEqual(
      [],
    );
    expect(verificationBatches).toEqual([1, 1, 0]);
    expect(representativeLimits).toEqual([2, 2]);
    expect(boundaries).toEqual(["batch-committed"]);
    database.close();
  });

  test("interrupting after the rename rolls the swap back and never drops the active index", () => {
    const database = fixture();
    expect(() =>
      rebuildSearchIndex(database, {
        batchSize: 2,
        representativeQueries: [{ query: "new", expectedRowids: [20] }],
        beforeBoundary: (boundary) => {
          if (boundary === "activation-after-swap")
            throw new Error("interrupt activation");
        },
      }),
    ).toThrow("interrupt activation");
    expect(activeIds(database, "old")).toEqual([10]);
    expect(activeIds(database, "new")).toEqual([]);
    expect(
      database.query("SELECT phase FROM search_reindex_lease;").all(),
    ).toEqual([{ phase: "activating" }]);

    const result = rebuildSearchIndex(database, {
      batchSize: 2,
      representativeQueries: [{ query: "new", expectedRowids: [20] }],
    });
    expect(result.status).toBe("activated");
    expect(activeIds(database, "new")).toEqual([20]);
    expect(
      database
        .query(
          "SELECT name FROM sqlite_master WHERE name LIKE 'message_fts_previous%';",
        )
        .all(),
    ).toEqual([]);
    database.close();
  });

  test("interrupting immediately before the swap leaves the durable activating phase resumable", () => {
    const database = fixture();
    expect(() =>
      rebuildSearchIndex(database, {
        representativeQueries: [{ query: "new", expectedRowids: [20] }],
        beforeBoundary: (boundary) => {
          if (boundary === "activation-before-swap")
            throw new Error("interrupt before swap");
        },
      }),
    ).toThrow("interrupt before swap");
    expect(activeIds(database, "old")).toEqual([10]);
    expect(
      database.query("SELECT phase FROM search_reindex_lease;").all(),
    ).toEqual([{ phase: "activating" }]);

    rebuildSearchIndex(database, {
      representativeQueries: [{ query: "new", expectedRowids: [20] }],
    });
    expect(activeIds(database, "new")).toEqual([20]);
    database.close();
  });

  test("retargets accepted FTS maintenance triggers and keeps post-activation writes searchable", () => {
    const database = fixture();
    database.exec(`
      CREATE TRIGGER message_search_documents_fts_insert
      AFTER INSERT ON message_search_documents
      BEGIN
        INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names)
        SELECT rowid, subject, participants, body_plain, body_html, attachment_names
        FROM indexed_messages WHERE rowid = NEW.document_id;
      END;
    `);
    rebuildSearchIndex(database, {
      representativeQueries: [{ query: "new", expectedRowids: [20] }],
    });

    database
      .query("INSERT INTO messages (message_id) VALUES (?);")
      .run(thirdMessage);
    database
      .query(
        "INSERT INTO message_headers " +
          "(message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, 1, 'Subject', 'subject', 'post activation', 'post activation');",
      )
      .run(thirdMessage);
    database
      .query(
        "INSERT INTO message_body_parts " +
          "(message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text) VALUES (?, 1, 'text/plain', 'text/plain', ?, 'post body');",
      )
      .run(thirdMessage, "3".repeat(64));
    database
      .query(
        "INSERT INTO message_search_documents (document_id, message_id) VALUES (?, ?);",
      )
      .run(30, thirdMessage);

    expect(activeIds(database, "post")).toEqual([30]);
    const trigger = database
      .query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE name = ?;",
      )
      .get("message_search_documents_fts_insert");
    expect(trigger?.sql).toContain("message_fts(rowid");
    expect(trigger?.sql).not.toContain("message_fts_previous");
    database.close();
  });

  test("a reopened database resumes the durable checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-search-reindex-"));
    roots.push(root);
    const path = join(root, "archive.sqlite");
    const first = new Database(path, { strict: true });
    seedFixture(first);
    expect(() =>
      rebuildSearchIndex(first, {
        batchSize: 1,
        representativeQueries: [{ query: "new", expectedRowids: [20] }],
        beforeBoundary: (boundary) => {
          if (boundary === "batch-committed") throw new Error("restart");
        },
      }),
    ).toThrow("restart");
    first.close();

    const reopened = new Database(path, { create: false, strict: true });
    const result = rebuildSearchIndex(reopened, {
      batchSize: 1,
      representativeQueries: [{ query: "new", expectedRowids: [20] }],
    });
    expect(result.replacementRowCount).toBe(2);
    expect(activeIds(reopened, "new")).toEqual([20]);
    reopened.close();
  });

  test("the named lease rejects a different concurrent operation and input is bounded", () => {
    const database = fixture();
    expect(() =>
      rebuildSearchIndex(database, {
        operationName: "first",
        representativeQueries: [{ query: "old", expectedRowids: [10] }],
        beforeBoundary: () => {
          throw new Error("stop");
        },
      }),
    ).toThrow("stop");
    expect(() =>
      rebuildSearchIndex(database, {
        operationName: "second",
        representativeQueries: [{ query: "old", expectedRowids: [10] }],
      }),
    ).toThrow(SearchReindexError);
    expect(() => rebuildSearchIndex(database, { batchSize: 1_001 })).toThrow(
      "between 1 and 1000",
    );
    database.close();
  });
});
