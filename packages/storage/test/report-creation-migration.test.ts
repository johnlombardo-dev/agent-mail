import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/migration-runner";
import {
  CANONICAL_DATABASE_SCHEMA_VERSION,
  canonicalDatabaseMigrations,
} from "../src/migration-registry";

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
    const reportMigrations = canonicalDatabaseMigrations.filter(
      (migration) => migration.name === "report-creation-v1",
    );
    expect(reportMigrations).toHaveLength(1);
    const reportMigration = reportMigrations[0];
    if (reportMigration === undefined) throw new Error("canonical report migration is missing");
    expect(reportMigration).toMatchObject({ name: "report-creation-v1", version: 28 });
    expect(canonicalDatabaseMigrations[reportMigration.version - 1]).toMatchObject({
      name: reportMigration.name,
      version: 28,
    });
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: CANONICAL_DATABASE_SCHEMA_VERSION,
    });
    database.close();
  });
});
