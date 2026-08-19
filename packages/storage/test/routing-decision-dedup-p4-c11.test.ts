import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createMessageId,
  createRouteDecision,
  serializeRoutingDecision,
} from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { localLabelMigration } from "../src/local-label-migration";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { runMigrations, type Migration } from "../src/migration-runner";
import { persistRouteDecision } from "../src/local-label-assignment";
import { routingDecisionMigration } from "../src/routing-decision-migration";

const roots: string[] = [];
const messageId = createMessageId(`message:${"a".repeat(64)}`);
const migrations = [
  { ...messageCatalogMigration, version: 1 },
  { ...localLabelMigration, version: 2 },
  { ...routingDecisionMigration, version: 3 },
] satisfies readonly Migration[];

const decision = (ruleVersion: number, source: string, label = "label:important") => ({
  kind: "route" as const,
  ruleId: "rule:sender",
  ruleVersion,
  matchedFacts: [
    { field: "sender", value: "ada@example.test" },
    { field: "subject", value: "invoice" },
  ],
  decidedAt: "2026-08-18T00:00:00.000Z",
  provenance: { source, evaluationId: `${source}:evaluation` },
  label,
});

async function openRoutingDatabase() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-routing-dedup-p4-c11-"));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  runMigrations(opened, migrations);
  opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  return { ...opened, path };
}

async function runCaller(path: string, callerInput: Readonly<Record<string, unknown>>) {
  const script = `
    import { Database } from "bun:sqlite";
    import { persistRouteDecision } from "./packages/storage/src/local-label-assignment.ts";
    const database = new Database(Bun.argv[1], { create: false, readwrite: true });
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const result = persistRouteDecision(database, JSON.parse(Bun.argv[2]));
    console.log(JSON.stringify({ created: result.created }));
    database.close();
  `;
  const process = Bun.spawn(["bun", "-e", script, path, JSON.stringify(callerInput)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`routing caller failed (${status}): ${stderr}`);
  return JSON.parse(stdout.trim()) as Readonly<{ readonly created: boolean }>;
}

describe("routing decision deduplication P4-C11", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("races real SQLite ingestion and sweep callers to one decision and label", async () => {
    const opened = await openRoutingDatabase();
    opened.db.exec("BEGIN IMMEDIATE;");

    const ingestion = runCaller(opened.path, {
      messageId,
      decisionId: "decision:ingestion",
      decision: decision(1, "ingestion"),
    });
    const sweep = runCaller(opened.path, {
      messageId,
      decisionId: "decision:sweep",
      decision: decision(1, "sweep"),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    opened.db.exec("COMMIT;");

    const results = await Promise.all([ingestion, sweep]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(opened.db.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({
      count: 1,
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({
      count: 1,
    });
    expect(
      opened.db
        .query(
          `SELECT decision_id, provenance_source, provenance_evaluation_id
             FROM routing_decisions
             JOIN local_label_assignments USING (message_id, rule_id, rule_version, matched_facts_json);`,
        )
        .get(),
    ).toEqual({
      decision_id: expect.stringMatching(/^decision:[0-9a-f]{64}$/u),
      provenance_source: expect.stringMatching(/^(ingestion|sweep)$/u),
      provenance_evaluation_id: expect.stringMatching(/^(ingestion|sweep):evaluation$/u),
    });

    const newerVersion = persistRouteDecision(opened.db, {
      messageId,
      decisionId: "decision:new-version",
      decision: decision(2, "sweep"),
    });
    expect(newerVersion.created).toBe(true);
    expect(opened.db.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({
      count: 2,
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({
      count: 2,
    });
    await opened.close();
  });

  test("does not key the canonical decision by caller source", async () => {
    const opened = await openRoutingDatabase();
    persistRouteDecision(opened.db, {
      messageId,
      decisionId: "decision:ingestion",
      decision: decision(1, "ingestion"),
    });
    persistRouteDecision(opened.db, {
      messageId,
      decisionId: "decision:sweep",
      decision: decision(1, "sweep", "label:other"),
    });
    expect(
      opened.db
        .query(
          `SELECT decision_id, provenance_source
             FROM routing_decisions
             JOIN local_label_assignments USING (message_id, rule_id, rule_version, matched_facts_json);`,
        )
        .all(),
    ).toHaveLength(1);
    expect(opened.db.query("SELECT COUNT(*) AS count FROM local_labels;").get()).toEqual({
      count: 1,
    });
    expect(opened.db.query("SELECT decision_id FROM routing_decisions;").get()).toEqual({
      decision_id: expect.stringMatching(/^decision:[0-9a-f]{64}$/u),
    });
    await opened.close();
  });

  test("fails closed when a stored decision ID is not the canonical fact identity", async () => {
    const opened = await openRoutingDatabase();
    const stored = createRouteDecision(decision(1, "manual"));
    opened.db
      .query(
        `INSERT INTO routing_decisions
          (decision_id, message_id, rule_id, rule_version, matched_facts_json, decision_json)
         VALUES (?, ?, ?, ?, ?, ?);`,
      )
      .run(
        "decision:wrong",
        messageId,
        stored.ruleId,
        stored.ruleVersion,
        JSON.stringify(stored.matchedFacts),
        serializeRoutingDecision(stored),
      );

    expect(() =>
      persistRouteDecision(opened.db, {
        messageId,
        decisionId: "decision:sweep",
        decision: stored,
      }),
    ).toThrow("routing decision row identity does not match its decision");
    expect(opened.db.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({
      count: 0,
    });
    await opened.close();
  });
});
