import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/migration-runner";
import { operationalJournalMigrations } from "../src/migrations/0001-operational-journal";

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openJournal(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  applyMigrations(database, operationalJournalMigrations);
  return database;
}

function insertEvent(
  database: Database,
  event: Readonly<{
    readonly id: string;
    readonly occurredAt?: string;
    readonly category: string;
    readonly subjectId?: string;
    readonly correlationId?: string;
    readonly payloadVersion?: number;
    readonly payloadJson?: string;
  }>,
): void {
  database
    .query(
      `INSERT INTO operational_journal
        (id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
    )
    .run(
      event.id,
      event.occurredAt ?? "2026-01-01T00:00:00.000Z",
      event.category,
      event.subjectId ?? "message:1",
      event.correlationId ?? "sync:1",
      event.payloadVersion ?? 1,
      event.payloadJson ?? '{"status":"accepted"}',
    );
}

describe("operational journal migration", () => {
  test("accepts every closed event category", () => {
    const database = openJournal();
    for (const [index, category] of ["sync", "routing", "action", "recovery", "administrative"].entries()) {
      insertEvent(database, { id: `event:${index + 1}`, category });
    }

    expect(database.query("SELECT category FROM operational_journal ORDER BY id;").all()).toEqual([
      { category: "sync" },
      { category: "routing" },
      { category: "action" },
      { category: "recovery" },
      { category: "administrative" },
    ]);
  });

  test("orders equal instants deterministically by immutable id", () => {
    const database = openJournal();
    const instant = "2026-01-01T00:00:00.123Z";
    insertEvent(database, { id: "event:z", occurredAt: instant, category: "sync" });
    insertEvent(database, { id: "event:a", occurredAt: instant, category: "routing" });
    insertEvent(database, {
      id: "event:m",
      occurredAt: "2025-12-31T23:59:59.999Z",
      category: "action",
    });

    expect(
      database
        .query("SELECT id FROM operational_journal ORDER BY occurred_at ASC, id ASC;")
        .all(),
    ).toEqual([{ id: "event:m" }, { id: "event:a" }, { id: "event:z" }]);
  });

  test("requires canonical UTC millisecond instants and bounded identities", () => {
    const database = openJournal();
    expect(() =>
      insertEvent(database, {
        id: "event:offset",
        occurredAt: "2026-01-01T00:00:00.000+00:00",
        category: "sync",
      }),
    ).toThrow();
    expect(() =>
      insertEvent(database, {
        id: "event:hour",
        occurredAt: "2026-01-01T24:00:00.000Z",
        category: "sync",
      }),
    ).toThrow();
    expect(() =>
      insertEvent(database, {
        id: "event:identity",
        category: "sync",
        subjectId: "x".repeat(201),
      }),
    ).toThrow();
  });

  test("rejects application updates and deletes, including routing payload changes", () => {
    const database = openJournal();
    insertEvent(database, { id: "event:routing", category: "routing" });

    expect(() =>
      database
        .query("UPDATE operational_journal SET payload_json = ? WHERE id = ?;")
        .run('{"status":"changed"}', "event:routing"),
    ).toThrow("operational journal is append-only");
    expect(() => database.query("DELETE FROM operational_journal WHERE id = ?;").run("event:routing")).toThrow(
      "operational journal is append-only",
    );
    expect(database.query("SELECT payload_json FROM operational_journal WHERE id = ?;").get("event:routing")).toEqual(
      { payload_json: '{"status":"accepted"}' },
    );
  });

  test("rejects oversized payloads", () => {
    const database = openJournal();
    const oversized = JSON.stringify({ details: "x".repeat(16_383) });
    expect(oversized.length).toBeGreaterThan(16_384);
    expect(() => insertEvent(database, { id: "event:oversized", category: "sync", payloadJson: oversized })).toThrow();
  });

  test("rejects raw-mail and secret-like payload fields, including nested fields", () => {
    const database = openJournal();
    for (const [index, payloadJson] of [
      '{"rawMail":"From: sender@example.test"}',
      '{"details":{"api_key":"secret-value"}}',
      '{"credentials":{"password":"secret-value"}}',
      '{"diagnostic":"Authorization: Bearer secret-value"}',
    ].entries()) {
      expect(() =>
        insertEvent(database, {
          id: `event:forbidden:${index}`,
          category: "administrative",
          payloadJson,
        }),
      ).toThrow("operational journal payload contains forbidden data");
    }
  });
});
