import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/migration-runner";
import { canonicalDatabaseMigrations } from "../src/migration-registry";
import {
  CANONICAL_DATABASE_REGISTRY_SHA256,
  classifyMigrationHistory,
  canonicalRegistryDigestAtVersion,
  installMigrationConversionInfrastructure,
  verifyCanonicalMigrationPrefixState,
  verifyCanonicalMigrationState,
} from "../src/migration-history-conversion";

describe("migration history conversion authority", () => {
  test("classifies and verifies a canonical history", () => {
    const database = new Database(":memory:", { strict: true });
    applyMigrations(database, canonicalDatabaseMigrations);
    installMigrationConversionInfrastructure(database);
    const state = classifyMigrationHistory(database);
    expect(state.classification).toBe("supported-canonical-prefix");
    expect(canonicalRegistryDigestAtVersion(27)).toBe(CANONICAL_DATABASE_REGISTRY_SHA256);
    expect(() => verifyCanonicalMigrationPrefixState(database, 27)).not.toThrow();
    expect(() => verifyCanonicalMigrationState(database)).not.toThrow();
    database.close();
  });
});
