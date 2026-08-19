import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { OpenDatabase } from "./database";

/** A migration is immutable once its version has been applied. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** A table-rebuild migration may need SQLite FK checks disabled before BEGIN. */
  readonly requiresForeignKeysOff?: boolean;
}

export type MigrationRunnerErrorCode =
  | "invalid-sequence"
  | "invalid-history"
  | "unknown-migration"
  | "migration-mismatch"
  | "schema-version-mismatch"
  | "migration-failed";

/**
 * Stable, safe diagnostics for migration failures. The SQLite error is kept as
 * the cause for diagnostics, but is not copied into the public message.
 */
export class MigrationRunnerError extends Error {
  readonly code: MigrationRunnerErrorCode;
  readonly version: number | undefined;

  constructor(
    code: MigrationRunnerErrorCode,
    message: string,
    options?: ErrorOptions & { readonly version?: number },
  ) {
    super(message, options);
    this.name = "MigrationRunnerError";
    this.code = code;
    this.version = options?.version;
  }
}

type MigrationConnection = Database | Pick<OpenDatabase, "db">;

type MigrationHistoryRow = {
  readonly version: unknown;
  readonly name: unknown;
  readonly content_hash: unknown;
};

type AppliedMigration = Readonly<{
  version: number;
  name: string;
  contentHash: string;
}>;

/**
 * Apply a contiguous migration sequence to an accepted storage connection.
 *
 * History reconciliation happens before any migration SQL runs. Each pending
 * migration, its history record, and PRAGMA user_version are committed as one
 * transaction. A changed migration is therefore an explicit failure rather
 * than an opportunity for the runner to repair an already-applied database.
 */
export function applyMigrations(
  connection: MigrationConnection,
  migrations: readonly Migration[],
): void {
  const database = getDatabase(connection);
  hardenFileBackedDatabase(database);
  const normalized = validateMigrationSequence(migrations);
  const userVersion = readUserVersion(database);
  const historyExists = hasHistoryTable(database);
  const applied = historyExists ? readHistory(database) : [];

  reconcileHistory(userVersion, applied, normalized, historyExists);

  const appliedVersions = new Set(applied.map((migration) => migration.version));
  for (const migration of normalized) {
    if (appliedVersions.has(migration.version)) continue;
    applyOne(database, migration);
  }
}

function hardenFileBackedDatabase(database: Database): void {
  const filename = database.filename;
  if (filename === ":memory:" || filename.length === 0 || filename.startsWith("file:")) return;
  try {
    chmodSync(filename, 0o600);
  } catch {
    // The application opener owns detailed path and permission errors. The
    // runner keeps its synchronous contract for raw test/fixture handles.
  }
}

/**
 * Compatibility entry point for legacy fixture callers. Application opens are
 * already canonical; a fixture sequence must not replay or remap that history.
 * Fresh synthetic connections still use the strict runner below.
 */
export function runMigrations(
  connection: MigrationConnection,
  migrations: readonly Migration[],
): void {
  const database = getDatabase(connection);
  if (readUserVersion(database) === 27 && hasHistoryTable(database)) return;
  applyMigrations(connection, migrations);
}

function getDatabase(connection: MigrationConnection): Database {
  if (isDatabase(connection)) return connection;
  return connection.db;
}

function isDatabase(connection: MigrationConnection): connection is Database {
  return "query" in connection && "exec" in connection;
}

function validateMigrationSequence(migrations: readonly Migration[]): readonly Migration[] {
  for (const [index, migration] of migrations.entries()) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== index + 1 ||
      migration.name.trim().length === 0 ||
      migration.sql.trim().length === 0
    ) {
      throw new MigrationRunnerError(
        "invalid-sequence",
        "storage migrations must use contiguous positive integer versions starting at 1",
      );
    }
  }
  return migrations;
}

function readUserVersion(database: Database): number {
  const row: unknown = database.query("PRAGMA user_version;").get();
  if (!isRecord(row) || !isInteger(row.user_version) || row.user_version < 0) {
    throw new MigrationRunnerError(
      "schema-version-mismatch",
      "storage database schema version is invalid",
    );
  }
  return row.user_version;
}

function hasHistoryTable(database: Database): boolean {
  const row: unknown = database
    .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?;")
    .get("schema_migrations");
  return row !== null;
}

function readHistory(database: Database): readonly AppliedMigration[] {
  let rows: readonly MigrationHistoryRow[];
  try {
    rows = database
      .query<MigrationHistoryRow, []>(
        "SELECT version, name, content_hash FROM schema_migrations ORDER BY version;",
      )
      .all();
  } catch (error: unknown) {
    throw new MigrationRunnerError("invalid-history", "storage migration history is invalid", {
      cause: error,
    });
  }

  const result: AppliedMigration[] = [];
  let previousVersion = 0;
  for (const row of rows) {
    if (
      !isInteger(row.version) ||
      row.version <= previousVersion ||
      row.version !== previousVersion + 1 ||
      typeof row.name !== "string" ||
      row.name.trim().length === 0 ||
      typeof row.content_hash !== "string" ||
      !isSha256(row.content_hash)
    ) {
      throw new MigrationRunnerError("invalid-history", "storage migration history is invalid");
    }
    result.push({ version: row.version, name: row.name, contentHash: row.content_hash });
    previousVersion = row.version;
  }
  return result;
}

function reconcileHistory(
  userVersion: number,
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
  historyExists: boolean,
): void {
  const latestApplied = applied.at(-1)?.version ?? 0;
  if (!historyExists && userVersion !== 0) {
    throw new MigrationRunnerError(
      "schema-version-mismatch",
      "storage database schema version does not match migration history",
    );
  }
  if (historyExists && userVersion !== latestApplied) {
    throw new MigrationRunnerError(
      "schema-version-mismatch",
      "storage database schema version does not match migration history",
    );
  }

  const definitions = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const appliedMigration of applied) {
    const definition = definitions.get(appliedMigration.version);
    if (definition === undefined) {
      throw new MigrationRunnerError(
        "unknown-migration",
        "storage migration history contains an unknown migration",
        { version: appliedMigration.version },
      );
    }
    if (
      appliedMigration.name !== definition.name ||
      appliedMigration.contentHash !== migrationContentHash(definition)
    ) {
      throw new MigrationRunnerError(
        "migration-mismatch",
        "an applied storage migration no longer matches its definition",
        { version: appliedMigration.version },
      );
    }
  }

  if (userVersion > migrations.length) {
    throw new MigrationRunnerError(
      "schema-version-mismatch",
      "storage database schema version is newer than the available migrations",
    );
  }
}

function applyOne(database: Database, migration: Migration): void {
  let transactionStarted = false;
  const foreignKeysOff = migration.requiresForeignKeysOff === true;
  try {
    if (foreignKeysOff) database.exec("PRAGMA foreign_keys = OFF;");
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
        "version INTEGER PRIMARY KEY NOT NULL, " +
        "name TEXT NOT NULL, " +
        "content_hash TEXT NOT NULL" +
        ");",
    );
    database.exec(migration.sql);
    database
      .query("INSERT INTO schema_migrations (version, name, content_hash) VALUES (?, ?, ?);")
      .run(migration.version, migration.name, migrationContentHash(migration));
    database.exec(`PRAGMA user_version = ${migration.version};`);
    if (foreignKeysOff) {
      const violations = database.query("PRAGMA foreign_key_check;").all();
      if (violations.length !== 0) throw new Error("migration produced foreign-key violations");
    }
    database.exec("COMMIT;");
    if (foreignKeysOff) database.exec("PRAGMA foreign_keys = ON;");
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new MigrationRunnerError(
          "migration-failed",
          `storage migration ${migration.version} failed and could not be rolled back`,
          {
            version: migration.version,
            cause: new AggregateError([error, rollbackError]),
          },
        );
      }
    }
    if (foreignKeysOff) {
      try {
        database.exec("PRAGMA foreign_keys = ON;");
      } catch {
        // The original migration failure remains the useful diagnostic.
      }
    }
    if (error instanceof MigrationRunnerError) throw error;
    throw new MigrationRunnerError(
      "migration-failed",
      `storage migration ${migration.version} failed`,
      { version: migration.version, cause: error },
    );
  }
}

export function migrationContentHash(
  migration: Pick<Migration, "sql"> & Partial<Pick<Migration, "requiresForeignKeysOff">>,
): string {
  // v1-v9 never set this flag, so their applied hashes remain byte-for-byte
  // compatible. For FK-off rebuilds the execution mode is part of the
  // immutable migration identity; changing it after application must fail
  // history reconciliation even when the SQL text is unchanged.
  const identity =
    migration.requiresForeignKeysOff === true
      ? `${migration.sql}\n/* migration-requires-foreign-keys-off:v1 */`
      : migration.sql;
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
