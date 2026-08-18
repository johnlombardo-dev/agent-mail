import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  MigrationRunnerError,
  applyMigrations,
  migrationContentHash,
  type Migration,
} from "../src/migration-runner";
import { DATABASE_BUSY_TIMEOUT_MS, openDatabase } from "../src/database";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-migrations-"));
  await chmod(root, 0o700);
  roots.push(root);
  return join(root, "archive.sqlite");
}

function migrationSet(): readonly Migration[] {
  return [
    { version: 1, name: "first", sql: "CREATE TABLE first(value TEXT NOT NULL);" },
    { version: 2, name: "second", sql: "CREATE TABLE second(value INTEGER NOT NULL);" },
  ];
}

describe("SQLite migration runner", () => {
  test("applies two migrations and reopens as an idempotent no-op", async () => {
    const path = await databasePath();
    const first = await openDatabase(path);
    applyMigrations(first, migrationSet());
    expect(first.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 2 });
    expect(first.db.query("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, name: "first" },
      { version: 2, name: "second" },
    ]);
    await first.close();

    const reopened = await openDatabase(path, { supportedSchemaVersion: 2 });
    expect(reopened.db.query("PRAGMA foreign_keys;").get()).toEqual({ foreign_keys: 1 });
    expect(reopened.db.query("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
    expect(reopened.db.query("PRAGMA synchronous;").get()).toEqual({ synchronous: 1 });
    expect(reopened.db.query("PRAGMA busy_timeout;").get()).toEqual({
      timeout: DATABASE_BUSY_TIMEOUT_MS,
    });
    expect(reopened.db.query("PRAGMA secure_delete;").get()).toEqual({ secure_delete: 1 });
    expect(reopened.db.query("PRAGMA trusted_schema;").get()).toEqual({ trusted_schema: 0 });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    applyMigrations(reopened, migrationSet());
    expect(reopened.db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([
      { name: "first" },
      { name: "schema_migrations" },
      { name: "second" },
    ]);
    await reopened.close();
  });

  test("rolls back a failed second migration, including history and user_version", async () => {
    const path = await databasePath();
    const opened = await openDatabase(path);
    const migrations: readonly Migration[] = [
      migrationSet()[0],
      { version: 2, name: "broken", sql: "CREATE TABLE second(value INTEGER); INSERT INTO missing VALUES (1);" },
    ];

    expect(() => applyMigrations(opened, migrations)).toThrow("storage migration 2 failed");
    expect(opened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 1 });
    expect(opened.db.query("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, name: "first" },
    ]);
    expect(opened.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'second'").get()).toBeNull();
    await opened.close();
  });

  test("rejects an edited definition for an already-applied migration", async () => {
    const path = await databasePath();
    const opened = await openDatabase(path);
    applyMigrations(opened, migrationSet());

    const edited: readonly Migration[] = [
      migrationSet()[0],
      { version: 2, name: "second", sql: "CREATE TABLE second(value INTEGER NOT NULL, extra TEXT);" },
    ];
    expect(() => applyMigrations(opened, edited)).toThrow(
      "an applied storage migration no longer matches its definition",
    );
    expect(opened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 2 });
    expect(opened.db.query("SELECT content_hash FROM schema_migrations WHERE version = 2").get()).toEqual({
      content_hash: migrationContentHash(migrationSet()[1]),
    });
    await opened.close();
  });

  test("rejects gaps and duplicate migration versions before touching SQLite", async () => {
    const path = await databasePath();
    const opened = await openDatabase(path);
    const first = { version: 1, name: "first", sql: "CREATE TABLE first(value TEXT);" };

    for (const migrations of [
      [first, { version: 3, name: "third", sql: "SELECT 1;" }],
      [first, { version: 1, name: "duplicate", sql: "SELECT 1;" }],
    ]) {
      expect(() => applyMigrations(opened, migrations)).toThrow(MigrationRunnerError);
      expect(opened.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()).toBeNull();
    }
    await opened.close();
  });

  test("rejects an orphan produced by a foreign-key-off rebuild before committing history", async () => {
    const path = await databasePath();
    const opened = await openDatabase(path);
    const migrations: readonly Migration[] = [
      {
        version: 1,
        name: "parent",
        sql: "CREATE TABLE parent(id INTEGER PRIMARY KEY);",
      },
      {
        version: 2,
        name: "orphaning-rebuild",
        requiresForeignKeysOff: true,
        sql: "CREATE TABLE child(parent_id INTEGER NOT NULL REFERENCES parent(id)); INSERT INTO child(parent_id) VALUES (42);",
      },
    ];
    expect(() => applyMigrations(opened, migrations)).toThrow("storage migration 2 failed");
    expect(opened.db.query("PRAGMA foreign_keys;").get()).toEqual({ foreign_keys: 1 });
    expect(opened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 1 });
    expect(opened.db.query("SELECT version, name FROM schema_migrations ORDER BY version;").all()).toEqual([
      { version: 1, name: "parent" },
    ]);
    expect(opened.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'child';").get()).toBeNull();
    await opened.close();
  });

  test("binds the foreign-key execution mode into an applied migration identity", async () => {
    const path = await databasePath();
    const opened = await openDatabase(path);
    const rebuild: Migration = {
      version: 2,
      name: "rebuild",
      requiresForeignKeysOff: true,
      sql: "CREATE TABLE rebuilt(value TEXT NOT NULL);",
    };
    applyMigrations(opened, [migrationSet()[0], rebuild]);
    expect(() =>
      applyMigrations(opened, [
        migrationSet()[0],
        { ...rebuild, requiresForeignKeysOff: false },
      ]),
    ).toThrow("an applied storage migration no longer matches its definition");
    expect(opened.db.query("SELECT content_hash FROM schema_migrations WHERE version = 2").get()).toEqual({
      content_hash: migrationContentHash(rebuild),
    });
    await opened.close();
  });
});
