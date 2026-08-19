import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { canonicalDatabaseMigrations } from "../src/migration-registry";
import { classifyMigrationHistory } from "../src/migration-history-conversion";
import { applyLegacyMigrationFixture } from "./helpers/legacy-migration-history-fixtures";

describe("database migration preflight projection", () => {
  test("reads a canonical projection without changing it", () => {
    const database = new Database(":memory:", { strict: true });
    applyLegacyMigrationFixture(database, canonicalDatabaseMigrations);
    const before = database.query("PRAGMA user_version").get();
    expect(classifyMigrationHistory(database).classification).toBe("supported-canonical-prefix");
    expect(database.query("PRAGMA user_version").get()).toEqual(before);
    database.close();
  });
});
