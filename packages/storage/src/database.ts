import { Database } from "bun:sqlite";
import { chmod, lstat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, parse } from "node:path";

/** The schema is intentionally empty until the first migration is delivered. */
export const SUPPORTED_DATABASE_SCHEMA_VERSION = 0;
export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

const PRIVATE_DATABASE_MODE = 0o600;

export type DatabaseOpenErrorCode =
  | "invalid-path"
  | "unsafe-permissions"
  | "unsupported-schema"
  | "initialization-failed"
  | "integrity-check-failed";

export class DatabaseOpenError extends Error {
  readonly code: DatabaseOpenErrorCode;

  constructor(code: DatabaseOpenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseOpenError";
    this.code = code;
  }
}

export type OpenDatabase = Readonly<{
  readonly db: Database;
  readonly close: () => Promise<void>;
}>;

type PermissionKind = "parent directory" | "database";

/**
 * Open the storage database with the package's non-negotiable SQLite policy.
 *
 * The caller owns configuration and path derivation. This boundary accepts only
 * a canonical absolute path, validates the immediate private parent, and does
 * not create directories or run schema migrations.
 */
export async function openDatabase(databasePath: string): Promise<OpenDatabase> {
  validateDatabasePath(databasePath);
  await assertPrivateParent(dirname(databasePath));

  const existed = await validateExistingDatabase(databasePath);
  let db: Database | undefined;
  try {
    db = new Database(databasePath, { create: true, strict: true });

    // Bun's default file mode follows the process umask. Set the durable mode
    // before the database can be handed to another capability.
    if (!existed) await chmod(databasePath, PRIVATE_DATABASE_MODE);
    await assertPrivateDatabase(databasePath);

    configureDatabase(db);
    // WAL configuration can create the companion files. Harden and verify
    // them only after SQLite has selected WAL, not before that side effect.
    await hardenCompanionFiles(databasePath);
    verifySchemaVersion(db);
    verifyIntegrity(db);

    let handleClosed = false;
    let closeSucceeded = false;
    let closePromise: Promise<void> | undefined;
    return {
      db,
      close: () => {
        if (closeSucceeded) return Promise.resolve();
        if (closePromise !== undefined) return closePromise;

        closePromise = (async () => {
          try {
            if (!handleClosed) {
              handleClosed = true;
              db?.close();
            }
            // A caller may have performed WAL writes after open. Re-check the
            // sidecars after the handle closes so those files remain private too.
            await hardenCompanionFiles(databasePath);
            closeSucceeded = true;
          } catch (error: unknown) {
            // The SQLite handle is never retried, but companion hardening is.
            closePromise = undefined;
            throw error;
          }
        })();
        return closePromise;
      },
    };
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = [];
    if (db !== undefined) {
      try {
        db.close();
      } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      // WAL may have created companions before a later initialization check
      // failed. Best-effort hardening must not replace the primary failure.
      await hardenCompanionFiles(databasePath);
    } catch (cleanupError: unknown) {
      cleanupErrors.push(cleanupError);
    }
    const primaryError =
      error instanceof DatabaseOpenError
        ? error
        : new DatabaseOpenError("initialization-failed", "storage database initialization failed", {
            cause: error,
          });
    if (cleanupErrors.length === 0) throw primaryError;
    throw new AggregateError([primaryError, ...cleanupErrors], "storage database cleanup failed", {
      cause: primaryError,
    });
  }
}

function validateDatabasePath(databasePath: string): void {
  if (
    databasePath.length === 0 ||
    databasePath.includes("\0") ||
    !isAbsolute(databasePath) ||
    normalize(databasePath) !== databasePath ||
    databasePath === parse(databasePath).root
  ) {
    throw new DatabaseOpenError(
      "invalid-path",
      "storage database path must be a canonical absolute file path",
    );
  }
}

async function assertPrivateParent(parentPath: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(parentPath);
  } catch (error: unknown) {
    throw new DatabaseOpenError("unsafe-permissions", "storage database parent is unavailable", {
      cause: error,
    });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw unsafePermissionsError(parentPath, "parent directory", info.mode & 0o777);
  }
  assertOwnerOnly(parentPath, "parent directory", info.mode & 0o777);
}

async function validateExistingDatabase(databasePath: string): Promise<boolean> {
  let existed: boolean;
  try {
    await assertPrivateDatabase(databasePath);
    existed = true;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) throw error;
    existed = false;
  }
  for (const companionPath of companionPaths(databasePath)) {
    try {
      await assertPrivateDatabase(companionPath);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return existed;
}

async function hardenCompanionFiles(databasePath: string): Promise<void> {
  for (const companionPath of companionPaths(databasePath)) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(companionPath);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw unsafePermissionsError(companionPath, "database", info.mode & 0o777);
    }

    // Pre-open validation rejects unsafe companions. Once WAL has been
    // selected, companions created by this connection may inherit a
    // permissive umask; harden those regular files before verifying them.
    await chmod(companionPath, PRIVATE_DATABASE_MODE);
    const hardened = await lstat(companionPath);
    if (
      !hardened.isFile() ||
      hardened.isSymbolicLink() ||
      (hardened.mode & 0o777) !== PRIVATE_DATABASE_MODE
    ) {
      throw unsafePermissionsError(companionPath, "database", hardened.mode & 0o777);
    }
  }
}

function companionPaths(databasePath: string): readonly string[] {
  return [`${databasePath}-wal`, `${databasePath}-shm`];
}

async function assertPrivateDatabase(databasePath: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(databasePath);
  } catch (error: unknown) {
    throw new DatabaseOpenError("unsafe-permissions", "storage database is unavailable", {
      cause: error,
    });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw unsafePermissionsError(databasePath, "database", info.mode & 0o777);
  }
  assertOwnerOnly(databasePath, "database", info.mode & 0o777);
}

function assertOwnerOnly(path: string, kind: PermissionKind, mode: number): void {
  if ((mode & 0o077) !== 0) throw unsafePermissionsError(path, kind, mode);
}

function unsafePermissionsError(
  path: string,
  kind: PermissionKind,
  mode: number,
): DatabaseOpenError {
  return new DatabaseOpenError(
    "unsafe-permissions",
    `${kind} has group or world permissions (${mode.toString(8)})`,
  );
}

function configureDatabase(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  expectPragmaNumber(db, "foreign_keys", 1);

  db.exec("PRAGMA journal_mode = WAL;");
  expectPragmaText(db, "journal_mode", "wal");

  db.exec("PRAGMA synchronous = NORMAL;");
  expectPragmaNumber(db, "synchronous", 1);

  db.exec(`PRAGMA busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS};`);
  expectPragmaNumber(db, "busy_timeout", DATABASE_BUSY_TIMEOUT_MS, "timeout");

  // Keep deleted content from remaining recoverable in the database file and
  // prevent schema objects from invoking application-defined functions.
  db.exec("PRAGMA secure_delete = ON;");
  expectPragmaNumber(db, "secure_delete", 1);
  db.exec("PRAGMA trusted_schema = OFF;");
  expectPragmaNumber(db, "trusted_schema", 0);
}

function verifySchemaVersion(db: Database): void {
  const row = db.query("PRAGMA user_version;").get();
  const version = readPragmaNumber(row, "user_version");
  if (version > SUPPORTED_DATABASE_SCHEMA_VERSION) {
    throw new DatabaseOpenError(
      "unsupported-schema",
      `storage database schema version ${version} is newer than supported version ${SUPPORTED_DATABASE_SCHEMA_VERSION}`,
    );
  }
  if (version < 0) {
    throw new DatabaseOpenError("unsupported-schema", "storage database schema version is invalid");
  }
}

function verifyIntegrity(db: Database): void {
  const row = db.query("PRAGMA integrity_check;").get();
  if (readPragmaText(row, "integrity_check") !== "ok") {
    throw new DatabaseOpenError(
      "integrity-check-failed",
      "storage database integrity check failed",
    );
  }
}

function expectPragmaNumber(
  db: Database,
  pragma: string,
  expected: number,
  resultKey = pragma,
): void {
  const row = db.query(`PRAGMA ${pragma};`).get();
  if (readPragmaNumber(row, resultKey) !== expected) {
    throw new DatabaseOpenError(
      "initialization-failed",
      `storage database pragma ${pragma} was not applied`,
    );
  }
}

function expectPragmaText(db: Database, pragma: string, expected: string): void {
  const row = db.query(`PRAGMA ${pragma};`).get();
  if (readPragmaText(row, pragma) !== expected) {
    throw new DatabaseOpenError(
      "initialization-failed",
      `storage database pragma ${pragma} was not applied`,
    );
  }
}

function readPragmaNumber(row: unknown, key: string): number {
  if (!isRecord(row) || typeof row[key] !== "number" || !Number.isInteger(row[key])) {
    throw new DatabaseOpenError(
      "initialization-failed",
      `storage database pragma ${key} is invalid`,
    );
  }
  return row[key];
}

function readPragmaText(row: unknown, key: string): string {
  if (!isRecord(row) || typeof row[key] !== "string") {
    throw new DatabaseOpenError(
      "initialization-failed",
      `storage database pragma ${key} is invalid`,
    );
  }
  return row[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  const cause = error instanceof DatabaseOpenError ? error.cause : error;
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
