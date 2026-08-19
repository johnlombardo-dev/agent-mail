import { Database } from "bun:sqlite";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DATABASE_BUSY_TIMEOUT_MS,
  DatabaseOpenError,
  openDatabase,
} from "../src/database";
import { CANONICAL_DATABASE_SCHEMA_VERSION } from "../src/migration-registry";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryDatabasePath(): Promise<{ readonly root: string; readonly path: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-database-"));
  await chmod(root, 0o700);
  temporaryRoots.push(root);
  return { root, path: join(root, "archive.sqlite") };
}

async function expectOpenError(
  path: string,
  code: DatabaseOpenError["code"],
  options?: Parameters<typeof openDatabase>[1],
): Promise<void> {
  try {
    await openDatabase(path, options);
    throw new Error("expected database open to fail");
  } catch (error: unknown) {
    if (!(error instanceof DatabaseOpenError)) throw error;
    expect(error.code).toBe(code);
  }
}

async function expectPrivateDatabaseFiles(databasePath: string): Promise<void> {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    expect(info.isFile()).toBe(true);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.mode & 0o777).toBe(0o600);
  }
}

describe("SQLite database boundary", () => {
  test("opens a private database with the required pragma policy", async () => {
    const { path } = await temporaryDatabasePath();
    const opened = await openDatabase(path);

    expect(opened.db.query("PRAGMA foreign_keys;").get()).toEqual({ foreign_keys: 1 });
    expect(opened.db.query("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
    expect(opened.db.query("PRAGMA synchronous;").get()).toEqual({ synchronous: 1 });
    expect(opened.db.query("PRAGMA busy_timeout;").get()).toEqual({
      timeout: DATABASE_BUSY_TIMEOUT_MS,
    });
    expect(opened.db.query("PRAGMA secure_delete;").get()).toEqual({ secure_delete: 1 });
    expect(opened.db.query("PRAGMA trusted_schema;").get()).toEqual({ trusted_schema: 0 });
    expect(opened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: CANONICAL_DATABASE_SCHEMA_VERSION });
    expect(opened.db.query("PRAGMA integrity_check;").get()).toEqual({ integrity_check: "ok" });

    // Real WAL activity creates -wal and -shm companions. Close owns the
    // post-write hardening check for those files. Make the newly generated
    // companions permissive to model a normal 022 umask before close.
    opened.db.exec("CREATE TABLE wal_probe (value INTEGER NOT NULL);");
    opened.db.exec("INSERT INTO wal_probe VALUES (1);");
    await chmod(`${path}-wal`, 0o644);
    await chmod(`${path}-shm`, 0o644);
    expect((await lstat(`${path}-wal`)).mode & 0o777).toBe(0o644);
    expect((await lstat(`${path}-shm`)).mode & 0o777).toBe(0o644);
    await opened.close();
    await opened.close();
    await expectPrivateDatabaseFiles(path);
  });

  test("rejects a parent directory with group or world permissions", async () => {
    const { root, path } = await temporaryDatabasePath();
    await chmod(root, 0o755);
    await expectOpenError(path, "unsafe-permissions");
  });

  test("rejects an existing database with group or world permissions", async () => {
    const { path } = await temporaryDatabasePath();
    const seed = new Database(path);
    seed.close();
    await chmod(path, 0o644);

    await expectOpenError(path, "unsafe-permissions");
  });

  test("rejects an existing unsafe WAL companion before opening", async () => {
    const { path } = await temporaryDatabasePath();
    const seed = new Database(path);
    seed.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE wal_probe (value INTEGER NOT NULL); INSERT INTO wal_probe VALUES (1);",
    );
    seed.close();

    await chmod(path, 0o600);
    await chmod(`${path}-wal`, 0o644);
    await chmod(`${path}-shm`, 0o600);
    await expectOpenError(path, "unsafe-permissions");
  });

  test("shares close in flight and retries companion hardening after failure", async () => {
    const { path } = await temporaryDatabasePath();
    const opened = await openDatabase(path);
    opened.db.exec("CREATE TABLE wal_probe (value INTEGER NOT NULL);");
    opened.db.exec("INSERT INTO wal_probe VALUES (1);");

    const walPath = `${path}-wal`;
    await rm(walPath);
    await symlink(path, walPath);

    const firstClose = opened.close();
    expect(opened.close()).toBe(firstClose);
    await expect(firstClose).rejects.toBeInstanceOf(DatabaseOpenError);

    await rm(walPath);
    await writeFile(walPath, new Uint8Array(), { mode: 0o644 });
    await opened.close();
    await expectPrivateDatabaseFiles(path);
  });

  test("rejects a database schema newer than this adapter supports", async () => {
    const { path } = await temporaryDatabasePath();
    const seed = new Database(path);
    seed.exec(`PRAGMA user_version = ${CANONICAL_DATABASE_SCHEMA_VERSION + 1};`);
    seed.close();
    await chmod(path, 0o600);

    await expectOpenError(path, "unsupported-schema");

    // The failed open must close its handle, so another connection can inspect
    // the file immediately without waiting for a lock or leaked descriptor.
    const probe = new Database(path, { strict: true });
    expect(probe.query("PRAGMA user_version;").get()).toEqual({
      user_version: CANONICAL_DATABASE_SCHEMA_VERSION + 1,
    });
    probe.close();
  });

  test("enables foreign keys even when an adjacent connection left them off", async () => {
    const { path } = await temporaryDatabasePath();
    const adjacent = new Database(path);
    adjacent.exec("PRAGMA foreign_keys = OFF;");
    expect(adjacent.query("PRAGMA foreign_keys;").get()).toEqual({ foreign_keys: 0 });
    adjacent.close();
    await chmod(path, 0o600);

    const opened = await openDatabase(path);
    expect(opened.db.query("PRAGMA foreign_keys;").get()).toEqual({ foreign_keys: 1 });
    await opened.close();
  });

  test("rejects non-canonical relative paths before touching SQLite", async () => {
    await expectOpenError("relative/archive.sqlite", "invalid-path");
  });
});
