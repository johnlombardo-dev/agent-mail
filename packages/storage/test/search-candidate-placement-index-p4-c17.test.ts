import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/database";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import { externalContentSearchMigration } from "../src/migrations/0003-external-content-search";
import { localLabelMigration } from "../src/local-label-migration";
import { searchCandidatePlacementIndexMigration } from "../src/migrations/0004-search-candidate-placement-index";

const roots: string[] = [];
const migrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  placementObservationMigration,
  { ...externalContentSearchMigration, version: 4 },
  { ...localLabelMigration, version: 5 },
  { ...searchCandidatePlacementIndexMigration, version: 6 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P4-C17 search placement index migration", () => {
  test("adds the account/message access path and planner uses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-search-placement-index-p4-c17-"));
    await chmod(root, 0o700);
    roots.push(root);
    const opened = await openDatabase(join(root, "archive.sqlite"), { supportedSchemaVersion: 6 });
    applyMigrations(opened, migrations);
    applyMigrations(opened, migrations);

    const index = opened.db
      .query<{ readonly name: string; readonly sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'search_placements_by_account_message';",
      )
      .get();
    expect(index?.name).toBe("search_placements_by_account_message");
    expect(index?.sql).toContain(
      "(account_id, message_id, tombstone_observed_at, internal_date)",
    );

    const plan = opened.db
      .query<{ readonly detail: string }, [string, string]>(
        "EXPLAIN QUERY PLAN SELECT MIN(internal_date) FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL;",
      )
      .all("account:fixture", "message:" + "a".repeat(64))
      .map(({ detail }) => detail)
      .join("\n");
    expect(plan).toContain("USING COVERING INDEX search_placements_by_account_message");
    await opened.close();
  });

  test("does not make a full message-catalog scan look like bounded search", async () => {
    const database = new Database(":memory:");
    database.exec("CREATE TABLE messages (message_id TEXT PRIMARY KEY); INSERT INTO messages VALUES ('message:a');");
    const plan = database
      .query<{ readonly detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT message_id FROM messages ORDER BY message_id LIMIT 20;",
      )
      .all()
      .map(({ detail }) => detail)
      .join("\n");
    expect(plan).toMatch(/SCAN messages/u);
    database.close();
  });
});
