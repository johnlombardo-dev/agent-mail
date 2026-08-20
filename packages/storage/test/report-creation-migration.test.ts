import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/migration-runner";
import { canonicalDatabaseMigrations } from "../src/migration-registry";

describe("report creation migration 28", () => {
  test("creates the strict immutable report graph and bounded rate ledger", () => {
    const database = new Database(":memory:", { strict: true });
    applyMigrations(database, canonicalDatabaseMigrations);
    const tables = database
      .query(
        "SELECT name, strict FROM pragma_table_list WHERE name IN ('message_text_projections', 'reports', 'report_artifacts', 'report_source_snapshots', 'report_sources', 'report_create_rate_windows') ORDER BY name;",
      )
      .all();
    expect(tables).toEqual([
      { name: "message_text_projections", strict: 1 },
      { name: "report_artifacts", strict: 1 },
      { name: "report_create_rate_windows", strict: 1 },
      { name: "report_source_snapshots", strict: 1 },
      { name: "report_sources", strict: 1 },
      { name: "reports", strict: 1 },
    ]);
    expect(
      database
        .query(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND (name LIKE 'report%reject_%' OR name LIKE 'message_text_projections_reject_%') ORDER BY name;",
        )
        .all().length,
    ).toBeGreaterThanOrEqual(15);
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 28 });
    database.close();
  });
});
