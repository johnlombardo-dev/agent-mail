import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createMessageId } from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { localLabelMigration } from "../src/local-label-migration";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { routingDecisionMigration } from "../src/routing-decision-migration";
import { persistRouteDecision } from "../src/local-label-assignment";
import {
  consumeRoutingPreview,
  RoutingPreviewConsumptionError,
} from "../src/routing-preview-consumption";
import { routingPreviewConsumptionMigration } from "../src/routing-preview-consumption-migration";
import {
  createRoutingPreview,
  type RoutingPreviewCreationDependencies,
} from "../src/routing-preview-creation";
import { routingPreviewMigration } from "../src/routing-preview-migration";

const roots: string[] = [];
const digestKey = Buffer.alloc(32, 0x5a);
const targetMessageId = createMessageId(`message:${"a".repeat(64)}`);
const adjacentMessageId = createMessageId(`message:${"b".repeat(64)}`);
const migrations = [
  { ...messageCatalogMigration, version: 1 },
  { ...localLabelMigration, version: 2 },
  { ...routingDecisionMigration, version: 3 },
  { ...routingPreviewMigration, version: 4 },
  { ...routingPreviewConsumptionMigration, version: 5 },
] satisfies readonly Migration[];

const dependencies: RoutingPreviewCreationDependencies = {
  clock: () => "2026-08-18T00:00:00.000Z",
  nonce: () => "nonce:one",
  digestKey,
};

function input(previewId = "preview:one") {
  return {
    previewId,
    scope: "mail:routing:read",
    rule: {
      version: 1,
      ruleId: "rule:sender",
      ruleVersion: 3,
      predicate: { kind: "exactSender", sender: "Ada@Example.com" },
    },
    facts: { senderAddrSpec: "ada@example.com", listId: null },
    provenance: { source: "preview-test", evaluationId: "evaluation:one" },
    candidateTargets: [{ kind: "local-label", messageId: targetMessageId, label: "label:important" }],
    ttlMs: 15 * 60 * 1000,
  };
}

function consumeInput(preview: ReturnType<typeof createRoutingPreview>, consumerId = "consumer:test", now = "2026-08-18T00:01:00.000Z") {
  return {
    previewId: preview.previewId,
    scope: preview.scope,
    nonce: preview.nonce,
    digest: preview.digest,
    ruleVersion: preview.rule.ruleVersion,
    consumerId,
    now,
  };
}

async function openRoutingDatabase() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-preview-consume-p4-c13-"));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  applyMigrations(opened, migrations);
  opened.db.query("PRAGMA foreign_keys = ON;").run();
  opened.db.query("INSERT INTO messages (message_id) VALUES (?), (?);").run(targetMessageId, adjacentMessageId);
  return { ...opened, path };
}

function createPreview(database: Database, previewId = "preview:one") {
  return createRoutingPreview(database, input(previewId), dependencies);
}

function counts(database: Database) {
  return {
    decisions: database.query("SELECT COUNT(*) AS count FROM routing_decisions;").get(),
    assignments: database.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get(),
    labels: database.query("SELECT COUNT(*) AS count FROM local_labels;").get(),
  };
}

async function runConsumer(path: string, request: Readonly<Record<string, unknown>>) {
  const script = `
    import { Database } from "bun:sqlite";
    import { consumeRoutingPreview } from "./packages/storage/src/routing-preview-consumption.ts";
    const database = new Database(Bun.argv[1], { create: false, readwrite: true });
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    try {
      const result = consumeRoutingPreview(database, JSON.parse(Bun.argv[2]), { digestKey: Buffer.alloc(32, 0x5a) });
      console.log(JSON.stringify(result));
    } catch (error) {
      console.log(JSON.stringify({ kind: "error", name: error?.name, reason: error?.reason }));
      process.exitCode = 0;
    } finally {
      database.close();
    }
  `;
  const process = Bun.spawn(["bun", "-e", script, path, JSON.stringify(request)], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (status !== 0) throw new Error(`consumer failed (${status}): ${stderr}`);
  return JSON.parse(stdout.trim()) as Readonly<Record<string, unknown>>;
}

describe("routing preview consumption P4-C13", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("commits one receipt, canonical decision, and local label, then reopens as replay", async () => {
    const opened = await openRoutingDatabase();
    const preview = createPreview(opened.db);
    expect(consumeRoutingPreview(opened.db, consumeInput(preview), { digestKey })).toEqual({
      kind: "consumed",
      previewId: "preview:one",
      consumerId: "consumer:test",
      consumedAt: "2026-08-18T00:01:00.000Z",
      decisionsCreated: 1,
      labelsCreated: 1,
    });
    expect(counts(opened.db)).toEqual({ decisions: { count: 1 }, assignments: { count: 1 }, labels: { count: 1 } });
    expect(opened.db.query("SELECT consumed_at, consumed_by FROM routing_previews;").get()).toEqual({ consumed_at: "2026-08-18T00:01:00.000Z", consumed_by: "consumer:test" });
    await opened.close();

    const reopened = await openDatabase(opened.path, { supportedSchemaVersion: 5 });
    expect(consumeRoutingPreview(reopened.db, consumeInput(preview), { digestKey })).toEqual({ kind: "replayed", previewId: "preview:one" });
    expect(counts(reopened.db)).toEqual({ decisions: { count: 1 }, assignments: { count: 1 }, labels: { count: 1 } });
    await reopened.close();
  });

  test("file-backed concurrent consumers produce one success and one replay", async () => {
    const opened = await openRoutingDatabase();
    const preview = createPreview(opened.db);
    opened.db.exec("BEGIN IMMEDIATE;");
    const first = runConsumer(opened.path, consumeInput(preview, "consumer:first"));
    const second = runConsumer(opened.path, consumeInput(preview, "consumer:second"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    opened.db.exec("COMMIT;");
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.kind).sort()).toEqual(["consumed", "replayed"]);
    expect(counts(opened.db)).toEqual({ decisions: { count: 1 }, assignments: { count: 1 }, labels: { count: 1 } });
    await opened.close();
  });

  test("converges with an existing canonical decision when the frozen label is exact", async () => {
    const opened = await openRoutingDatabase();
    const preview = createPreview(opened.db);
    persistRouteDecision(opened.db, {
      messageId: targetMessageId,
      decision: {
        kind: "route",
        label: "label:important",
        ruleId: "rule:sender",
        ruleVersion: 3,
        matchedFacts: [{ field: "sender-addr-spec", value: "ada@example.com" }],
        decidedAt: "2026-08-18T00:00:30.000Z",
        provenance: { source: "ingestion", evaluationId: "ingestion:one" },
      },
    });
    expect(consumeRoutingPreview(opened.db, consumeInput(preview), { digestKey })).toMatchObject({
      kind: "consumed",
      decisionsCreated: 0,
      labelsCreated: 0,
    });
    expect(opened.db.query("SELECT label FROM local_label_assignments;").get()).toEqual({ label: "label:important" });
    expect(opened.db.query("SELECT consumed_by FROM routing_previews;").get()).toEqual({ consumed_by: "consumer:test" });
    await opened.close();
  });

  test("rejects an existing canonical decision whose label conflicts with the frozen target", async () => {
    const opened = await openRoutingDatabase();
    const preview = createPreview(opened.db);
    persistRouteDecision(opened.db, {
      messageId: targetMessageId,
      decision: {
        kind: "route",
        label: "label:existing",
        ruleId: "rule:sender",
        ruleVersion: 3,
        matchedFacts: [{ field: "sender-addr-spec", value: "ada@example.com" }],
        decidedAt: "2026-08-18T00:00:30.000Z",
        provenance: { source: "ingestion", evaluationId: "ingestion:one" },
      },
    });
    const before = counts(opened.db);
    expect(() => consumeRoutingPreview(opened.db, consumeInput(preview), { digestKey })).toThrow(
      "stored routing decision label does not match the frozen target",
    );
    expect(counts(opened.db)).toEqual(before);
    expect(opened.db.query("SELECT consumed_at, consumed_by FROM routing_previews;").get()).toEqual({ consumed_at: null, consumed_by: null });
    expect(opened.db.query("SELECT label FROM local_label_assignments;").get()).toEqual({ label: "label:existing" });
    await opened.close();
  });

  test("tampered authority fields and missing frozen targets commit no effect", async () => {
    const tamperCases = [
      ["scope", "mail:routing:write"],
      ["nonce", "nonce:tampered"],
      ["expires_at", "2026-08-18T00:00:01.000Z"],
      ["digest", "f".repeat(64)],
      ["rule_version", 99],
      ["candidate_targets_json", JSON.stringify([{ kind: "local-label", messageId: adjacentMessageId, label: "label:important" }])],
    ] as const;
    for (const [column, value] of tamperCases) {
      const opened = await openRoutingDatabase();
      const preview = createPreview(opened.db);
      const request = column === "scope" ? { ...consumeInput(preview), scope: value } : consumeInput(preview);
      if (column !== "scope") {
        opened.db.exec("DROP TRIGGER routing_previews_reject_update;");
        opened.db.query(`UPDATE routing_previews SET ${column} = ? WHERE preview_id = ?;`).run(value, preview.previewId);
      }
      expect(() => consumeRoutingPreview(opened.db, request, { digestKey })).toThrow(RoutingPreviewConsumptionError);
      expect(counts(opened.db)).toEqual({ decisions: { count: 0 }, assignments: { count: 0 }, labels: { count: 0 } });
      await opened.close();
    }

    const missing = await openRoutingDatabase();
    const preview = createPreview(missing.db);
    missing.db.query("DELETE FROM messages WHERE message_id = ?;").run(targetMessageId);
    expect(() => consumeRoutingPreview(missing.db, consumeInput(preview), { digestKey })).toThrow(RoutingPreviewConsumptionError);
    expect(counts(missing.db)).toEqual({ decisions: { count: 0 }, assignments: { count: 0 }, labels: { count: 0 } });
    await missing.close();
  });

  test("expired previews are inert and newly matching adjacent messages are not consumed", async () => {
    const expired = await openRoutingDatabase();
    const expiredPreview = createPreview(expired.db);
    expect(consumeRoutingPreview(expired.db, consumeInput(expiredPreview, "consumer:expired", "2026-08-18T00:16:00.000Z"), { digestKey })).toEqual({ kind: "expired", previewId: expiredPreview.previewId });
    expect(counts(expired.db)).toEqual({ decisions: { count: 0 }, assignments: { count: 0 }, labels: { count: 0 } });
    await expired.close();

    const beforeCreation = await openRoutingDatabase();
    const beforeCreationPreview = createPreview(beforeCreation.db);
    expect(() => consumeRoutingPreview(beforeCreation.db, consumeInput(beforeCreationPreview, "consumer:early", "2026-08-17T23:59:59.999Z"), { digestKey })).toThrow(
      "routing preview cannot be consumed before its creation time",
    );
    expect(counts(beforeCreation.db)).toEqual({ decisions: { count: 0 }, assignments: { count: 0 }, labels: { count: 0 } });
    expect(beforeCreation.db.query("SELECT consumed_at, consumed_by FROM routing_previews;").get()).toEqual({ consumed_at: null, consumed_by: null });
    await beforeCreation.close();

    const atCreation = await openRoutingDatabase();
    const atCreationPreview = createPreview(atCreation.db);
    expect(consumeRoutingPreview(atCreation.db, consumeInput(atCreationPreview, "consumer:at-creation", "2026-08-18T00:00:00.000Z"), { digestKey })).toMatchObject({ kind: "consumed" });
    await atCreation.close();

    const adjacent = await openRoutingDatabase();
    const preview = createPreview(adjacent.db);
    expect(consumeRoutingPreview(adjacent.db, consumeInput(preview), { digestKey })).toMatchObject({ kind: "consumed", decisionsCreated: 1, labelsCreated: 1 });
    expect(adjacent.db.query("SELECT COUNT(*) AS count FROM routing_decisions WHERE message_id = ?;").get(adjacentMessageId)).toEqual({ count: 0 });
    expect(adjacent.db.query("SELECT COUNT(*) AS count FROM local_label_assignments WHERE message_id = ?;").get(adjacentMessageId)).toEqual({ count: 0 });
    await adjacent.close();
  });
});
