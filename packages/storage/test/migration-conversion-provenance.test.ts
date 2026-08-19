import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { canonicalDatabaseMigrations } from "../src/migration-registry";
import {
  classifyMigrationHistory,
  installMigrationConversionInfrastructure,
  migrationConversionDdl,
} from "../src/migration-history-conversion";
import { applyLegacyMigrationFixture } from "./helpers/legacy-migration-history-fixtures";

describe("migration conversion provenance", () => {
  test("installs the frozen five-object provenance infrastructure", () => {
    const database = new Database(":memory:", { strict: true });
    applyLegacyMigrationFixture(database, canonicalDatabaseMigrations);
    installMigrationConversionInfrastructure(database);
    expect(database.query("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'schema_migration_conversions%'").get()).toEqual({ count: 5 });
    expect(migrationConversionDdl.tableSql).toContain("schema_migration_conversions");
    database.close();
  });

  test("rejects partial infrastructure without adding or repairing objects", () => {
    const database = new Database(":memory:", { strict: true });
    applyLegacyMigrationFixture(database, canonicalDatabaseMigrations);
    database.exec("CREATE TABLE schema_migration_conversions (conversion_id TEXT);");
    expect(classifyMigrationHistory(database).classification).toBe("schema-mismatch");
    expect(() => installMigrationConversionInfrastructure(database)).toThrow(
      "conversion provenance infrastructure is incomplete",
    );
    expect(
      database
        .query(
          "SELECT name FROM sqlite_schema WHERE name LIKE 'schema_migration_conversions%' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "schema_migration_conversions" }]);
    database.close();
  });
});
