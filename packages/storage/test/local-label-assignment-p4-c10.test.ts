import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { localLabelMigration } from "../src/local-label-migration";
import {
  assignLocalLabel,
  LocalLabelAssignmentConflictError,
  type LocalLabelAssignmentInput,
} from "../src/local-label-assignment";

const databases: Database[] = [];
const messageId = `message:${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON;");
  const migrations: readonly Migration[] = [
    messageCatalogMigration,
    operationalJournalMigration,
    localLabelMigration,
  ].map((migration, index) => ({ ...migration, version: index + 1 }));
  applyMigrations(database, migrations);
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  database
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run("account:one", "mailbox:archive", 10);
  database
    .query(
      `INSERT INTO remote_placements
        (account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason)
       VALUES (?, ?, ?, ?, ?, NULL, NULL);`,
    )
    .run("account:one", "mailbox:archive", 10, 7, messageId);
  return database;
}

const assignment: LocalLabelAssignmentInput = {
  messageId,
  label: "label:archive",
  ruleId: "rule:sender",
  ruleVersion: 2,
  matchedFacts: [{ field: "senderAddrSpec", value: "alice@example.com" }],
  decidedAt: "2026-08-18T00:00:00.000Z",
  provenance: { source: "routing-evaluator", evaluationId: "evaluation:one" },
};

function placementSnapshot(database: Database): readonly unknown[] {
  return database
    .query(
      `SELECT account_id, mailbox_id, uid_validity, uid, message_id,
              tombstone_observed_at, tombstone_reason
         FROM remote_placements
        ORDER BY account_id, mailbox_id, uid_validity, uid;`,
    )
    .all();
}

describe("local label assignment", () => {
  test("persists one catalog entry, assignment, and immutable provenance", () => {
    const database = openDatabase();

    const first = assignLocalLabel(database, assignment);
    const second = assignLocalLabel(database, assignment);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(database.query("SELECT COUNT(*) AS count FROM local_labels;").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({
      count: 1,
    });
    expect(
      database
        .query(
          `SELECT message_id, label, rule_id, rule_version, matched_facts_json,
                  decided_at, provenance_source, provenance_evaluation_id
             FROM local_label_assignments;`,
        )
        .get(),
    ).toEqual({
      message_id: messageId,
      label: "label:archive",
      rule_id: "rule:sender",
      rule_version: 2,
      matched_facts_json: '[{"field":"senderAddrSpec","value":"alice@example.com"}]',
      decided_at: "2026-08-18T00:00:00.000Z",
      provenance_source: "routing-evaluator",
      provenance_evaluation_id: "evaluation:one",
    });

    expect(() =>
      database
        .query("UPDATE local_label_assignments SET provenance_source = ?;")
        .run("changed"),
    ).toThrow("local label assignments are immutable");
    expect(() => database.query("DELETE FROM local_label_assignments;").run()).toThrow(
      "local label assignments are immutable",
    );
  });

  test("rejects conflicting reuse instead of replacing provenance", () => {
    const database = openDatabase();
    assignLocalLabel(database, assignment);

    expect(() =>
      assignLocalLabel(database, {
        ...assignment,
        provenance: { source: "different-evaluator", evaluationId: "evaluation:two" },
      }),
    ).toThrow(LocalLabelAssignmentConflictError);
    expect(database.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({
      count: 1,
    });
    expect(
      database.query("SELECT provenance_source, provenance_evaluation_id FROM local_label_assignments;").get(),
    ).toEqual({ provenance_source: "routing-evaluator", provenance_evaluation_id: "evaluation:one" });
  });

  test("keeps remote placement bytes unchanged and rejects mailbox-label masquerading", () => {
    const database = openDatabase();
    const before = placementSnapshot(database);

    assignLocalLabel(database, assignment);

    expect(placementSnapshot(database)).toEqual(before);
    expect(() =>
      assignLocalLabel(database, { ...assignment, label: "mailbox:archive" }),
    ).toThrow();
    expect(placementSnapshot(database)).toEqual(before);
    expect(database.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({
      count: 1,
    });
  });

  test("rolls back the catalog insert when the canonical message is absent", () => {
    const database = openDatabase();

    expect(() =>
      assignLocalLabel(database, {
        ...assignment,
        messageId: `message:${"b".repeat(64)}`,
      }),
    ).toThrow();
    expect(database.query("SELECT COUNT(*) AS count FROM local_labels;").get()).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({
      count: 0,
    });
  });
});
