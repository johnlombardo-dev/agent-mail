import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  applyMigrations,
  migrationContentHash,
} from "../src/migration-runner";
import {
  CANONICAL_DATABASE_SCHEMA_VERSION,
  NEXT_DATABASE_MIGRATION_VERSION,
  NEXT_REPORT_MIGRATION_VERSION,
  canonicalDatabaseMigrations,
} from "../src/migration-registry";

describe("canonical migration registry", () => {
  test("is the immutable contiguous application authority", () => {
    const database = new Database(":memory:", { strict: true });
    applyMigrations(database, canonicalDatabaseMigrations);
    expect(CANONICAL_DATABASE_SCHEMA_VERSION).toBe(29);
    expect(NEXT_DATABASE_MIGRATION_VERSION).toBe(30);
    expect(NEXT_REPORT_MIGRATION_VERSION).toBe(30);
    expect(Object.isFrozen(canonicalDatabaseMigrations)).toBe(true);
    expect(canonicalDatabaseMigrations.map((migration) => migration.version)).toEqual(
      Array.from({ length: 29 }, (_, index) => index + 1),
    );
    expect(canonicalDatabaseMigrations.every((migration) => Object.isFrozen(migration))).toBe(true);
    expect(canonicalDatabaseMigrations.map(migrationContentHash)).toHaveLength(29);
    database.close();
  });
});
