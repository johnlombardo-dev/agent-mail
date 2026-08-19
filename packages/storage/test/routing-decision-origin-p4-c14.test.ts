import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMessageId, createRouteDecision, serializeRoutingDecision } from "@agent-mail/core";
import { restoreBackup } from "../src/backup-restore";
import { writeBackup } from "../src/backup-writer";
import { runMigrations, type Migration } from "../src/migration-runner";
import { localLabelMigration } from "../src/local-label-migration";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { routingDecisionMigration } from "../src/routing-decision-migration";
import { routingDecisionOriginMigration } from "../src/routing-decision-origin-migration";

const roots: string[] = [];
const messageId = createMessageId(`message:${"c".repeat(64)}`);
const decision = createRouteDecision({
  kind: "route",
  ruleId: "rule:origin",
  ruleVersion: 1,
  matchedFacts: [{ field: "list-id", value: "news.example.com" }],
  decidedAt: "2026-08-18T00:00:00.000Z",
  provenance: { source: "canonical-routing-v1", evaluationId: "evaluation:canonical" },
  label: "label:news",
});
const migrations: readonly Migration[] = [
  { ...messageCatalogMigration, version: 1 },
  { ...localLabelMigration, version: 2 },
  { ...routingDecisionMigration, version: 3 },
  { ...routingDecisionOriginMigration, version: 4 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("routing decision origin migration and backup parity P4-C14", () => {
  test("migrates, backs up, and restores both append-only caller origins", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-routing-origin-backup-p4-c14-"));
    roots.push(root);
    await chmod(root, 0o700);
    const blobDirectory = join(root, "blobs");
    const journalDirectory = join(root, "journal");
    const configDirectory = join(root, "config");
    const backupDirectory = join(root, "backups");
    await Promise.all(
      [blobDirectory, journalDirectory, configDirectory, backupDirectory].map((path) =>
        mkdir(path, { mode: 0o700 }),
      ),
    );
    const databasePath = join(root, "archive.sqlite");
    const database = new Database(databasePath);
    runMigrations({ db: database, close: () => database.close() }, migrations);
    database
      .query("INSERT INTO messages (message_id) VALUES (?);")
      .run(messageId);
    const decisionId = "decision:" + "d".repeat(64);
    database
      .query(
        "INSERT INTO routing_decisions (decision_id, message_id, rule_id, rule_version, matched_facts_json, decision_json) VALUES (?, ?, ?, ?, ?, ?);",
      )
      .run(
        decisionId,
        messageId,
        decision.ruleId,
        decision.ruleVersion,
        JSON.stringify(decision.matchedFacts),
        serializeRoutingDecision(decision),
      );
    database
      .query(
        "INSERT INTO routing_decision_origins (decision_id, caller_source, observed_at, evaluation_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?);",
      )
      .run(
        decisionId,
        "direct-ingestion",
        "2026-08-18T00:00:00.000Z",
        "evaluation:direct",
        decisionId,
        "recurring-sweep",
        "2026-08-18T00:00:01.000Z",
        "evaluation:sweep",
    );
    database.close();
    await chmod(databasePath, 0o600);
    const metadataPath = join(configDirectory, "archive-metadata.json");
    await writeFile(metadataPath, '{"format":"agent-mail","version":1}\n', { mode: 0o600 });
    await writeFile(join(journalDirectory, "events.jsonl"), '{"event":"origin-parity"}\n', {
      mode: 0o600,
    });
    const backupPath = join(backupDirectory, "backup-one");
    await writeBackup({
      privateRoot: root,
      databasePath,
      blobDirectory,
      journalDirectory,
      configurationMetadataPaths: [metadataPath],
      destination: backupPath,
    });

    const restored = await restoreBackup({
      backupPath,
      destination: join(root, "restored"),
    });
    const restoredDatabase = new Database(restored.databasePath, { create: false, readonly: true });
    expect(
      restoredDatabase
        .query(
          "SELECT caller_source, observed_at, evaluation_id FROM routing_decision_origins ORDER BY caller_source;",
        )
        .all(),
    ).toEqual([
      {
        caller_source: "direct-ingestion",
        observed_at: "2026-08-18T00:00:00.000Z",
        evaluation_id: "evaluation:direct",
      },
      {
        caller_source: "recurring-sweep",
        observed_at: "2026-08-18T00:00:01.000Z",
        evaluation_id: "evaluation:sweep",
      },
    ]);
    restoredDatabase.close();
  });
});
