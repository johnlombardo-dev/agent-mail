import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { applyMigrations } from "./migration-runner";
import {
  classifyMigrationHistory,
  convertMigrationHistory,
  installMigrationConversionInfrastructure,
  verifyCanonicalMigrationState,
  type ConversionBackupProof,
} from "./migration-history-conversion";
import {
  canonicalDatabaseMigrations,
  CANONICAL_DATABASE_SCHEMA_VERSION,
} from "./migration-registry";

export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

const PRIVATE_DATABASE_MODE = 0o600;
const execFileAsync = promisify(execFile);

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

export type OpenDatabaseOptions = Readonly<{
  /** Verified backup proof/capability for an exact legacy composition. */
  readonly legacyBackup?:
    | ConversionBackupProof
    | (() => ConversionBackupProof | Promise<ConversionBackupProof>);
}>;

type PermissionKind = "parent directory" | "database";

/**
 * Open the storage database with the package's non-negotiable SQLite policy.
 *
 * The caller owns configuration and path derivation. This boundary accepts only
 * a canonical absolute path, validates the immediate private parent, and does
 * not create directories or run schema migrations. Callers opening an
 * application database may declare a higher supported schema ceiling while
 * retaining the default future-version fail-closed behavior.
 */
export async function openDatabase(
  databasePath: string,
  options: OpenDatabaseOptions = {},
): Promise<OpenDatabase> {
  validateDatabasePath(databasePath);
  await assertPrivateParent(dirname(databasePath));

  const existed = await validateExistingDatabase(databasePath);
  const preflight = existed ? await preflightDatabase(databasePath) : undefined;
  if (preflight !== undefined && preflight.classification === "newer") {
    throw new DatabaseOpenError(
      "unsupported-schema",
      `storage database schema version is newer than supported version ${CANONICAL_DATABASE_SCHEMA_VERSION}`,
    );
  }
  if (
    preflight !== undefined &&
    !new Set(["supported-empty", "supported-canonical-prefix", "supported-legacy"]).has(
      preflight.classification,
    )
  ) {
    throw new DatabaseOpenError(
      "unsupported-schema",
      preflight.reason ?? "storage database history is unsupported",
    );
  }
  const legacyBackupProof =
    preflight?.classification === "supported-legacy"
      ? await resolveLegacyBackup(options.legacyBackup)
      : undefined;
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
    if (preflight?.classification === "supported-legacy") {
      try {
        convertMigrationHistory(db, { backupProof: legacyBackupProof });
      } catch (error: unknown) {
        throw new DatabaseOpenError("initialization-failed", "legacy migration conversion failed", {
          cause: error,
        });
      }
    } else {
      applyMigrations(db, canonicalDatabaseMigrations);
      installMigrationConversionInfrastructure(db);
    }
    verifyCanonicalMigrationState(db);
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

type PreflightResult = ReturnType<typeof classifyMigrationHistory>;

async function preflightDatabaseInProcess(databasePath: string): Promise<PreflightResult> {
  const scratchRoot = await mkdtemp(join(tmpdir(), "agent-mail-migration-preflight-"));
  const scratchPath = join(scratchRoot, "archive.sqlite");
  const stablePath = join(scratchRoot, "stable.sqlite");
  try {
    await copyFile(databasePath, scratchPath);
    const mainBytes = await Bun.file(scratchPath).bytes();
    if (mainBytes.byteLength === 0) {
      return emptyPreflight();
    }
    if (
      mainBytes.byteLength < 100 ||
      new TextDecoder().decode(mainBytes.subarray(0, 16)) !== "SQLite format 3\0"
    ) {
      return corruptPreflight("storage database header is invalid");
    }
    try {
      await copyFile(`${databasePath}-wal`, `${scratchPath}-wal`);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
    }
    await execFileAsync("sqlite3", ["-readonly", scratchPath, `.backup ${stablePath}`]);
    const stableBytes = await Bun.file(stablePath).bytes();
    if (stableBytes.length >= 20 && stableBytes[18] === 2 && stableBytes[19] === 2) {
      stableBytes[18] = 1;
      stableBytes[19] = 1;
      await Bun.write(stablePath, stableBytes);
    }
    let scratch: Database | undefined;
    try {
      scratch = new Database(stablePath, { create: false, strict: true });
      scratch.exec("PRAGMA query_only = ON");
      scratch.exec("PRAGMA foreign_keys = ON");
      scratch.exec("PRAGMA trusted_schema = OFF");
      return classifyMigrationHistory(scratch);
    } catch (error: unknown) {
      if (error instanceof DatabaseOpenError) throw error;
      return corruptPreflight("storage database preflight failed");
    } finally {
      scratch?.close();
    }
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

function corruptPreflight(reason: string): PreflightResult {
  return {
    classification: "corrupt",
    userVersion: -1,
    history: [],
    migrationIds: [],
    overlay: {
      id: "O-REINDEX-ABSENT",
      lease: null,
      progress: [],
      objects: [],
      sourceRows: [],
      replacementDocsizeRowids: [],
    },
    schema: [],
    reason,
  };
}

function emptyPreflight(): PreflightResult {
  return {
    classification: "supported-empty",
    userVersion: 0,
    history: [],
    migrationIds: [],
    overlay: {
      id: "O-REINDEX-ABSENT",
      lease: null,
      progress: [],
      objects: [],
      sourceRows: [],
      replacementDocsizeRowids: [],
    },
    schema: [],
  };
}

/** Classify in a fresh process so Bun's process-wide WAL cache cannot checkpoint the source. */
export async function preflightDatabase(databasePath: string): Promise<PreflightResult> {
  if (process.env.AGENT_MAIL_PREFLIGHT_WORKER === "1") {
    return preflightDatabaseInProcess(databasePath);
  }
  const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const workerScript = [
    `import { preflightDatabase as run } from ${JSON.stringify(moduleUrl)};`,
    "const databasePath = process.argv[1];",
    "const result = await run(databasePath);",
    "process.stdout.write(JSON.stringify(result));",
  ].join(" ");
  const { stdout } = await execFileAsync(process.execPath, ["-e", workerScript, databasePath], {
    env: { ...process.env, AGENT_MAIL_PREFLIGHT_WORKER: "1" },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as PreflightResult;
}

async function resolveLegacyBackup(
  value: OpenDatabaseOptions["legacyBackup"],
): Promise<ConversionBackupProof> {
  if (value === undefined) {
    throw new DatabaseOpenError(
      "initialization-failed",
      "legacy migration conversion requires a verified backup capability",
    );
  }
  const proof = typeof value === "function" ? await value() : value;
  if (
    typeof proof !== "object" ||
    proof === null ||
    typeof proof.backupId !== "string" ||
    typeof proof.manifestSha256 !== "string" ||
    typeof proof.createdAt !== "string"
  ) {
    throw new DatabaseOpenError("initialization-failed", "legacy backup proof is invalid");
  }
  return proof;
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
