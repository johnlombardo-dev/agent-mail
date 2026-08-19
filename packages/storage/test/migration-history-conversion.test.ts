import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/migration-runner";
import { canonicalDatabaseMigrations } from "../src/migration-registry";
import {
  classifyMigrationHistory,
  installMigrationConversionInfrastructure,
  verifyCanonicalMigrationState,
} from "../src/migration-history-conversion";

describe("migration history conversion authority", () => {
  test("classifies and verifies a canonical history", () => {
    const database = new Database(":memory:", { strict: true });
    applyMigrations(database, canonicalDatabaseMigrations);
    installMigrationConversionInfrastructure(database);
    const state = classifyMigrationHistory(database);
    expect(state.classification).toBe("supported-canonical-prefix");
    expect(() => verifyCanonicalMigrationState(database)).not.toThrow();
    database.close();
  });
});
