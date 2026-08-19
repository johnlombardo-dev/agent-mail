import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { operationalJournalCompactionMigration } from "../src/migrations/0001-operational-journal-compaction";
import { runMigrations, type Migration } from "../src/migration-runner";
import { localLabelMigration } from "../src/local-label-migration";
import { assignLocalLabel } from "../src/local-label-assignment";
import { compactOperationalJournal } from "../src/operational-journal-compaction";
import { readRemotePlacement, tombstoneRemotePlacement } from "../src/remote-placement-tombstone";

const databases: Database[] = [];
const messageId = `message:${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openJournal(withLocalLabels = false): Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON;");
  const definitions: readonly Migration[] = [
    messageCatalogMigration,
    operationalJournalMigration,
    operationalJournalCompactionMigration,
  ];
  const migrations = (withLocalLabels ? [...definitions, localLabelMigration] : definitions).map(
    (migration, index) => ({ ...migration, version: index + 1 }),
  );
  runMigrations(database, migrations);
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  return database;
}

function insertEvent(
  database: Database,
  event: Readonly<{
    readonly id: string;
    readonly occurredAt: string;
    readonly category?: string;
    readonly subjectId?: string;
    readonly correlationId?: string;
  }>,
): void {
  database
    .query(
      `INSERT INTO operational_journal
        (id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json)
       VALUES (?, ?, ?, ?, ?, 1, '{"status":"accepted"}');`,
    )
    .run(
      event.id,
      event.occurredAt,
      event.category ?? "routing",
      event.subjectId ?? "message:old",
      event.correlationId ?? "routing:one",
    );
}

describe("operational journal compaction", () => {
  test("compacts before, at, and after the normalized UTC cutoff", () => {
    const database = openJournal();
    insertEvent(database, { id: "event:before", occurredAt: "2025-12-31T23:59:59.999Z" });
    insertEvent(database, { id: "event:at", occurredAt: "2026-01-01T00:00:00.000Z" });
    insertEvent(database, { id: "event:after", occurredAt: "2026-01-01T00:00:00.001Z" });

    const result = compactOperationalJournal(database, {
      cutoff: "2026-01-01T01:00:00.000+01:00",
    });

    expect(String(result.cutoff)).toBe("2026-01-01T00:00:00.000Z");
    expect(result.compactedEventCount).toBe(2);
    expect(result.retainedEventCount).toBe(0);
    expect(
      database.query("SELECT id FROM operational_journal ORDER BY id;").all(),
    ).toEqual([{ id: "event:after" }]);
    expect(
      database
        .query(
          `SELECT category, subject_id, correlation_id, event_count, source_started_at, source_ended_at, cutoff_at
             FROM operational_journal_summaries;`,
        )
        .all(),
    ).toEqual([
      {
        category: "routing",
        subject_id: "message:old",
        correlation_id: "routing:one",
        event_count: 2,
        source_started_at: "2025-12-31T23:59:59.999Z",
        source_ended_at: "2026-01-01T00:00:00.000Z",
        cutoff_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const summary = result.summaries[0];
    if (summary === undefined) throw new Error("summary missing from compaction result");
    expect(() =>
      database
        .query("UPDATE operational_journal_summaries SET event_count = ? WHERE summary_id = ?;")
        .run(99, summary.summaryId),
    ).toThrow("operational journal summaries are immutable");
    expect(() =>
      database.query("DELETE FROM operational_journal_summaries WHERE summary_id = ?;").run(summary.summaryId),
    ).toThrow("operational journal summaries are immutable");
  });

  test("fails closed when the standalone compaction migration is absent", () => {
    const database = new Database(":memory:");
    databases.push(database);
    runMigrations(database, [operationalJournalMigration]);
    insertEvent(database, { id: "event:old", occurredAt: "2025-01-01T00:00:00.000Z" });

    expect(() =>
      compactOperationalJournal(database, { cutoff: "2025-01-02T00:00:00.000Z" }),
    ).toThrow("operational journal compaction migration is required");
    expect(database.query("SELECT id FROM operational_journal;").all()).toEqual([{ id: "event:old" }]);
  });

  test("fails closed instead of consuming stale delete authorizations", () => {
    const database = openJournal();
    insertEvent(database, { id: "event:stale", occurredAt: "2025-01-01T00:00:00.000Z" });
    database
      .query("INSERT INTO operational_journal_compaction_authorizations (event_id) VALUES (?);")
      .run("event:stale");

    expect(() =>
      compactOperationalJournal(database, { cutoff: "2025-01-02T00:00:00.000Z" }),
    ).toThrow("operational journal compaction authorization state is not empty");
    expect(database.query("SELECT id FROM operational_journal;").all()).toEqual([
      { id: "event:stale" },
    ]);
  });

  test("keeps old detail referenced by a live local decision and compacts the rest", () => {
    const database = openJournal(true);
    const protectedEventId = "event:decision";
    insertEvent(database, {
      id: "event:ordinary",
      occurredAt: "2025-01-01T00:00:00.000Z",
      subjectId: messageId,
    });
    insertEvent(database, {
      id: protectedEventId,
      occurredAt: "2025-01-01T00:00:00.001Z",
      subjectId: messageId,
    });
    assignLocalLabel(database, {
      messageId,
      label: "label:archive",
      ruleId: "rule:retention",
      ruleVersion: 1,
      matchedFacts: [{ field: "sender", value: "alice@example.com" }],
      decidedAt: "2025-01-02T00:00:00.000Z",
      provenance: { source: "routing-evaluator", evaluationId: protectedEventId },
    });

    const result = compactOperationalJournal(database, {
      cutoff: "2025-01-02T00:00:00.000Z",
    });

    expect(result.compactedEventCount).toBe(1);
    expect(result.retainedEventCount).toBe(1);
    expect(database.query("SELECT id FROM operational_journal;").all()).toEqual([
      { id: protectedEventId },
    ]);
    expect(
      database
        .query("SELECT provenance_evaluation_id FROM local_label_assignments;")
        .get(),
    ).toEqual({ provenance_evaluation_id: protectedEventId });
    expect(() => database.query("DELETE FROM operational_journal WHERE id = ?;").run(protectedEventId)).toThrow(
      "operational journal is append-only",
    );
  });

  test("fails closed on malformed routing-decision provenance", () => {
    const database = openJournal();
    database.exec("CREATE TABLE routing_decisions (decision_json TEXT NOT NULL);");
    database.query("INSERT INTO routing_decisions (decision_json) VALUES (?);").run("not-json");
    insertEvent(database, { id: "event:old", occurredAt: "2025-01-01T00:00:00.000Z" });

    expect(() =>
      compactOperationalJournal(database, { cutoff: "2025-01-02T00:00:00.000Z" }),
    ).toThrow("routing decision provenance is malformed");
    expect(database.query("SELECT id FROM operational_journal;").all()).toEqual([{ id: "event:old" }]);
  });

  test("retains tombstone detail required by remote-placement provenance", () => {
    const database = openJournal();
    const accountId = "account:one";
    const mailboxId = "mailbox:inbox";
    const uidValidity = 10;
    const uid = 7;
    database
      .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
      .run(accountId, mailboxId, uidValidity);
    database
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);",
      )
      .run(accountId, mailboxId, uidValidity, uid, messageId);
    const tombstone = tombstoneRemotePlacement(database, {
      accountId,
      mailboxId,
      uidValidity,
      uid,
      observedAt: "2025-01-01T00:00:00.000Z",
      sourceCheckpoint: "checkpoint:inbox:10:42",
      reason: "absent from completed mailbox sweep",
    });

    const result = compactOperationalJournal(database, {
      cutoff: "2025-01-02T00:00:00.000Z",
    });

    expect(result.compactedEventCount).toBe(0);
    expect(result.retainedEventCount).toBe(1);
    expect(
      readRemotePlacement(database, { accountId, mailboxId, uidValidity, uid }),
    ).toEqual({
      identity: { accountId, mailboxId, uidValidity, uid },
      messageId,
      tombstone: tombstone.tombstone,
    });
  });

  test("does not leave a summary or detail authorization on a failed transaction", () => {
    const database = openJournal();
    insertEvent(database, {
      id: "event:old",
      occurredAt: "2025-01-01T00:00:00.000Z",
    });
    database.exec(`
      CREATE TRIGGER fail_compaction_authorization
      BEFORE INSERT ON operational_journal_compaction_authorizations
      BEGIN SELECT RAISE(ABORT, 'injected compaction failure'); END;
    `);

    expect(() =>
      compactOperationalJournal(database, { cutoff: "2025-01-02T00:00:00.000Z" }),
    ).toThrow();
    expect(database.query("SELECT id FROM operational_journal;").all()).toEqual([{ id: "event:old" }]);
    expect(database.query("SELECT COUNT(*) AS count FROM operational_journal_summaries;").get()).toEqual({ count: 0 });
  });
});
