import type { Database } from "bun:sqlite";
import {
  applyMigrations,
  type Migration,
} from "../../src/migration-runner";

/**
 * The only test helper allowed to construct a non-application migration
 * history. Callers must pass a frozen fixture sequence owned by this module.
 */
export function applyLegacyMigrationFixture(
  database: Database,
  migrations: readonly Migration[],
): void {
  applyMigrations(database, migrations);
}
