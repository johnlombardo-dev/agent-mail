import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { isAbsolute, join, normalize, parse, relative } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrationContentHash, type Migration } from "./migration-runner";
import { canonicalDatabaseMigrations } from "./migration-registry";
import {
  classifyMigrationHistory,
  verifyCanonicalMigrationState,
} from "./migration-history-conversion";

const SHA256 = /^[0-9a-f]{64}$/u;
const MESSAGE_ID = /^message:[0-9a-f]{64}$/u;
const STAGE = /^\.stage-v1-pid[1-9]\d*-owner[0-9a-f]{64}-random[0-9a-f]{64}\.tmp$/u;
const QUARANTINE = /^\.quarantine-v1-[0-9a-f]{64}-[0-9a-f]{32}\.blob$/u;
const MAX_EVIDENCE = 32;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");

export type DoctorCheckId =
  | "sqlite-integrity"
  | "foreign-keys"
  | "migrations"
  | "blobs"
  | "orphans"
  | "permissions";

export type DoctorCheckStatus = "pass" | "fail" | "blocked";

export type DoctorEvidence = Readonly<{
  readonly detail: string;
  readonly identity?: string;
  readonly path?: string;
}>;

export type DoctorCheck = Readonly<{
  readonly id: DoctorCheckId;
  readonly status: DoctorCheckStatus;
  readonly summary: string;
  readonly evidence: readonly DoctorEvidence[];
}>;

export type DoctorIntegrityResult = Readonly<{
  readonly status: "healthy" | "unhealthy";
  readonly checks: readonly DoctorCheck[];
}>;

export type DoctorIntegrityOptions = Readonly<{
  /** Private archive root containing the database and canonical blob directory. */
  readonly privateRoot: string;
  readonly databasePath: string;
  readonly blobDirectory: string;
}>;

type RecordValue = Readonly<Record<string, unknown>>;
type BlobReference = Readonly<{
  readonly messageId: string;
  readonly kind: "raw-eml" | "body-part" | "attachment";
  readonly ordinal: number;
  readonly digest: string;
  readonly size: number;
}>;

type EvidenceCollector = Readonly<{
  readonly add: (evidence: DoctorEvidence) => void;
  readonly values: () => readonly DoctorEvidence[];
  readonly truncated: () => boolean;
}>;

type DbState = Readonly<{
  readonly database: Database | undefined;
  readonly openError: string | undefined;
  readonly cleanup?: () => Promise<void>;
}>;

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: RecordValue, key: string): unknown {
  return Reflect.get(value, key);
}

function evidenceCollector(): EvidenceCollector {
  const values: DoctorEvidence[] = [];
  let truncated = false;
  return {
    add(evidence) {
      if (values.length < MAX_EVIDENCE) values.push(evidence);
      else truncated = true;
    },
    values: () => Object.freeze([...values]),
    truncated: () => truncated,
  };
}

function check(
  id: DoctorCheckId,
  status: DoctorCheckStatus,
  summary: string,
  collector: EvidenceCollector,
): DoctorCheck {
  const suffix = collector.truncated() ? " (evidence truncated)" : "";
  return Object.freeze({
    id,
    status,
    summary: `${summary}${suffix}`,
    evidence: collector.values(),
  });
}

function isFsCode(error: unknown, code: string): boolean {
  return isRecord(error) && field(error, "code") === code;
}

function stableError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 256);
  return "operation could not be completed";
}

function validCanonicalPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    isAbsolute(path) &&
    normalize(path) === path &&
    path !== parse(path).root
  );
}

function pathWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${"/"}`) && !isAbsolute(value);
}

async function openReadOnly(databasePath: string): Promise<DbState> {
  const scratchRoot = await mkdtemp(join(tmpdir(), "agent-mail-doctor-readonly-"));
  const scratchPath = join(scratchRoot, "archive.sqlite");
  const stablePath = join(scratchRoot, "stable.sqlite");
  try {
    // Copy only the canonical main database and WAL bytes.  The SHM file is a
    // derived lock/index file and must never be copied or opened from the
    // private root.  sqlite3's backup command then replays the WAL into a
    // private, non-WAL snapshot before Bun opens anything.
    await copyFile(databasePath, scratchPath);
    const mainBytes = await readFile(scratchPath);
    if (
      mainBytes.byteLength < 100 ||
      !Buffer.from(mainBytes.subarray(0, SQLITE_HEADER.byteLength)).equals(SQLITE_HEADER)
    ) {
      throw new Error("SQLite database header is invalid");
    }
    try {
      await copyFile(`${databasePath}-wal`, `${scratchPath}-wal`);
    } catch (error: unknown) {
      if (!isFsCode(error, "ENOENT")) throw error;
    }
    await execFileAsync("sqlite3", ["-readonly", scratchPath, `.backup ${stablePath}`]);
    // The backup preserves the source's WAL journal-mode header but has no
    // companion WAL.  Normalize only this disposable copy before opening it
    // with Bun's readonly handle.
    const stableBytes = Uint8Array.from(await readFile(stablePath));
    if (stableBytes.length >= 20 && stableBytes[18] === 2 && stableBytes[19] === 2) {
      stableBytes[18] = 1;
      stableBytes[19] = 1;
      await writeFile(stablePath, stableBytes, { mode: 0o600 });
    } else {
      await chmod(stablePath, 0o600);
    }
    return {
      database: new Database(stablePath, { readonly: true, create: false }),
      openError: undefined,
      cleanup: async () => rm(scratchRoot, { recursive: true, force: true }),
    };
  } catch (error: unknown) {
    await rm(scratchRoot, { recursive: true, force: true });
    return { database: undefined, openError: stableError(error) };
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function migrationCheck(
  database: Database | undefined,
  openError: string | undefined,
  migrations: readonly Migration[],
  databasePath: string,
): DoctorCheck {
  const collector = evidenceCollector();
  if (database === undefined) {
    collector.add({
      path: databasePath,
      detail: `database could not be opened: ${openError ?? "unknown error"}`,
    });
    return check("migrations", "blocked", "migration history could not be read", collector);
  }

  let invalidInput = false;
  for (const [index, migration] of migrations.entries()) {
    if (
      migration.version !== index + 1 ||
      !Number.isSafeInteger(migration.version) ||
      migration.name.trim().length === 0 ||
      migration.sql.trim().length === 0
    ) {
      invalidInput = true;
      collector.add({
        identity: `migration:${index + 1}`,
        detail: "expected migration sequence is invalid",
      });
    }
  }
  if (invalidInput)
    return check("migrations", "fail", "expected migration sequence is invalid", collector);

  try {
    const userVersionRow: unknown = database.query("PRAGMA user_version;").get();
    const userVersion = isRecord(userVersionRow)
      ? readSafeInteger(field(userVersionRow, "user_version"))
      : undefined;
    const historyExists =
      database
        .query(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations';",
        )
        .get() !== null;
    if (userVersion === undefined) {
      collector.add({ path: databasePath, detail: "SQLite user_version is invalid" });
      return check("migrations", "fail", "migration version is invalid", collector);
    }
    if (!historyExists) {
      if (migrations.length === 0 && userVersion === 0) {
        return check("migrations", "pass", "migration history is empty as expected", collector);
      }
      collector.add({ path: databasePath, detail: "schema_migrations table is missing" });
      return check("migrations", "fail", "migration history is missing", collector);
    }

    const rows: readonly unknown[] = database
      .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version;")
      .all();
    let mismatch = userVersion !== migrations.length || rows.length !== migrations.length;
    if (userVersion !== migrations.length) {
      collector.add({
        path: databasePath,
        detail: `user_version is ${userVersion}; expected ${migrations.length}`,
      });
    }
    for (const [index, migration] of migrations.entries()) {
      const row = rows[index];
      const version = isRecord(row) ? readSafeInteger(field(row, "version")) : undefined;
      const name = isRecord(row) ? readString(field(row, "name")) : undefined;
      const contentHash = isRecord(row) ? readString(field(row, "content_hash")) : undefined;
      const expectedHash = migrationContentHash(migration);
      if (
        version !== migration.version ||
        name !== migration.name ||
        contentHash !== expectedHash
      ) {
        mismatch = true;
        collector.add({
          identity: `migration:${migration.version}`,
          path: databasePath,
          detail: "applied migration name or content hash does not match its definition",
        });
      }
    }
    if (rows.length > migrations.length) {
      collector.add({
        path: databasePath,
        detail: "database contains migrations not supplied by the expected sequence",
      });
    }
    if (mismatch)
      return check(
        "migrations",
        "fail",
        "migration history does not match the expected definitions",
        collector,
      );
    // Keep referential corruption attributed to the dedicated foreign-key
    // check. The store is already unhealthy there; migration admission still
    // runs for states whose relational structure is intact.
    if (database.query("PRAGMA foreign_key_check;").all().length !== 0)
      return check("migrations", "pass", "migration history and hashes match", collector);
    try {
      const classified = classifyMigrationHistory(database);
      if (
        classified.classification !== "supported-canonical-prefix" ||
        classified.userVersion !== migrations.length
      ) {
        throw new Error(classified.reason ?? "canonical migration preflight rejected the database");
      }
      verifyCanonicalMigrationState(database);
      return check(
        "migrations",
        "pass",
        "migration history, conversion provenance, and reindex overlay are valid",
        collector,
      );
    } catch (error: unknown) {
      collector.add({
        path: databasePath,
        detail: `canonical migration admission failed: ${stableError(error)}`,
      });
      return check("migrations", "fail", "canonical migration admission failed", collector);
    }
  } catch (error: unknown) {
    collector.add({
      path: databasePath,
      detail: `migration history could not be read: ${stableError(error)}`,
    });
    return check("migrations", "blocked", "migration history could not be read", collector);
  }
}

function sqliteIntegrityCheck(
  database: Database | undefined,
  openError: string | undefined,
  databasePath: string,
): DoctorCheck {
  const collector = evidenceCollector();
  if (database === undefined) {
    collector.add({
      path: databasePath,
      detail: `database could not be opened: ${openError ?? "unknown error"}`,
    });
    return check("sqlite-integrity", "fail", "SQLite integrity could not be verified", collector);
  }
  try {
    const rows: readonly unknown[] = database.query("PRAGMA integrity_check;").all();
    const problems = rows.filter((row) => !isRecord(row) || field(row, "integrity_check") !== "ok");
    if (problems.length === 0)
      return check("sqlite-integrity", "pass", "SQLite integrity_check returned ok", collector);
    for (const problem of problems) {
      collector.add({
        path: databasePath,
        detail: isRecord(problem)
          ? (readString(field(problem, "integrity_check")) ?? "invalid integrity result")
          : "invalid integrity result",
      });
    }
    return check(
      "sqlite-integrity",
      "fail",
      "SQLite integrity_check reported corruption",
      collector,
    );
  } catch (error: unknown) {
    collector.add({
      path: databasePath,
      detail: `integrity_check could not run: ${stableError(error)}`,
    });
    return check("sqlite-integrity", "fail", "SQLite integrity_check could not run", collector);
  }
}

function foreignKeyCheck(
  database: Database | undefined,
  openError: string | undefined,
  databasePath: string,
): DoctorCheck {
  const collector = evidenceCollector();
  if (database === undefined) {
    collector.add({
      path: databasePath,
      detail: `database could not be opened: ${openError ?? "unknown error"}`,
    });
    return check("foreign-keys", "blocked", "foreign-key check could not run", collector);
  }
  try {
    const rows: readonly unknown[] = database.query("PRAGMA foreign_key_check;").all();
    if (rows.length === 0)
      return check("foreign-keys", "pass", "foreign_key_check returned no violations", collector);
    for (const row of rows) {
      if (!isRecord(row)) {
        collector.add({ path: databasePath, detail: "foreign_key_check returned an invalid row" });
        continue;
      }
      const table = readString(field(row, "table")) ?? "unknown-table";
      const rowid = field(row, "rowid");
      const parent = readString(field(row, "parent")) ?? "unknown-parent";
      const fkid = readSafeInteger(field(row, "fkid"));
      const rowIdentity =
        rowid === null
          ? "without-rowid"
          : typeof rowid === "string" || typeof rowid === "number"
            ? `${rowid}`
            : "unknown-row";
      collector.add({
        identity: `${table}:${rowIdentity}`,
        path: databasePath,
        detail: `references missing ${parent} (foreign-key ${fkid === undefined ? "unknown" : fkid})`,
      });
    }
    return check("foreign-keys", "fail", "foreign_key_check reported violations", collector);
  } catch (error: unknown) {
    collector.add({
      path: databasePath,
      detail: `foreign_key_check could not run: ${stableError(error)}`,
    });
    return check("foreign-keys", "blocked", "foreign-key check could not run", collector);
  }
}

function parseBlobReference(row: unknown): BlobReference | undefined {
  if (!isRecord(row)) return undefined;
  const messageId = readString(field(row, "message_id"));
  const kind = readString(field(row, "kind"));
  const ordinal = readSafeInteger(field(row, "ordinal"));
  const digest = readString(field(row, "blob_id"));
  const size = readSafeInteger(field(row, "size"));
  if (
    messageId === undefined ||
    !MESSAGE_ID.test(messageId) ||
    (kind !== "raw-eml" && kind !== "body-part" && kind !== "attachment") ||
    ordinal === undefined ||
    ordinal < 1 ||
    digest === undefined ||
    !SHA256.test(digest) ||
    size === undefined ||
    size < 0
  )
    return undefined;
  return { messageId, kind, ordinal, digest, size };
}

async function safePathIssue(root: string, target: string): Promise<string | undefined> {
  if (!validCanonicalPath(root) || !validCanonicalPath(target) || !pathWithin(root, target)) {
    return "path is not a canonical path beneath the private root";
  }
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      return "private root is not a regular directory";
  } catch (error: unknown) {
    return isFsCode(error, "ENOENT")
      ? "private root is missing"
      : "private root could not be inspected";
  }
  const parts = relative(root, target).split("/");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return "path contains a symbolic link";
    } catch (error: unknown) {
      if (isFsCode(error, "ENOENT")) return undefined;
      return "path could not be inspected";
    }
  }
  return undefined;
}

type BlobInspection =
  | Readonly<{ readonly kind: "ok"; readonly digest: string; readonly size: number }>
  | Readonly<{ readonly kind: "missing" }>
  | Readonly<{ readonly kind: "unsafe"; readonly detail: string }>
  | Readonly<{ readonly kind: "error"; readonly detail: string }>;

async function inspectBlob(path: string): Promise<BlobInspection> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return { kind: "missing" };
    return { kind: "error", detail: stableError(error) };
  }
  if (info.isSymbolicLink() || !info.isFile())
    return { kind: "unsafe", detail: "canonical blob is not a regular file" };
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.dev !== info.dev || initial.ino !== info.ino) {
      return { kind: "unsafe", detail: "canonical blob changed or is not a regular file" };
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, size);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      size += result.bytesRead;
    }
    const final = await handle.stat();
    if (!final.isFile() || final.size !== initial.size || final.size !== size) {
      return { kind: "error", detail: "canonical blob changed while it was inspected" };
    }
    return { kind: "ok", digest: hash.digest("hex"), size };
  } catch (error: unknown) {
    if (isFsCode(error, "ELOOP"))
      return { kind: "unsafe", detail: "canonical blob is a symbolic link" };
    return { kind: "error", detail: stableError(error) };
  } finally {
    await handle?.close();
  }
}

async function readBlobReferences(database: Database): Promise<readonly BlobReference[]> {
  const rows: readonly unknown[] = database
    .query(
      "SELECT message_id, kind, ordinal, blob_id, size FROM message_blob_references ORDER BY message_id, kind, ordinal;",
    )
    .all();
  const references: BlobReference[] = [];
  for (const row of rows) {
    const reference = parseBlobReference(row);
    if (reference === undefined)
      throw new TypeError("message_blob_references contains an invalid row");
    references.push(reference);
  }
  return references;
}

type ReferenceRead = Readonly<{
  readonly references: readonly BlobReference[] | undefined;
  readonly error: string | undefined;
}>;

function blobIdentity(reference: BlobReference): string {
  return `${reference.messageId}:${reference.kind}:${reference.ordinal}`;
}

async function getReferences(database: Database | undefined): Promise<ReferenceRead> {
  if (database === undefined) return { references: undefined, error: "database is unavailable" };
  try {
    return { references: await readBlobReferences(database), error: undefined };
  } catch (error: unknown) {
    return { references: undefined, error: stableError(error) };
  }
}

async function blobCheck(
  options: DoctorIntegrityOptions,
  database: Database | undefined,
  openError: string | undefined,
): Promise<{
  readonly check: DoctorCheck;
  readonly references: readonly BlobReference[] | undefined;
}> {
  const collector = evidenceCollector();
  const read = await getReferences(database);
  if (read.references === undefined) {
    collector.add({
      path: options.databasePath,
      detail: `authoritative blob references could not be read: ${read.error ?? openError ?? "unknown error"}`,
    });
    return {
      check: check(
        "blobs",
        "blocked",
        "authoritative blob references could not be verified",
        collector,
      ),
      references: undefined,
    };
  }
  let failed = false;
  const inspections = new Map<string, Promise<BlobInspection>>();
  for (const reference of read.references) {
    const identity = blobIdentity(reference);
    const path = join(options.blobDirectory, reference.digest);
    const unsafe = await safePathIssue(options.privateRoot, path);
    if (unsafe !== undefined) {
      failed = true;
      collector.add({ identity, path, detail: unsafe });
      continue;
    }
    let inspection = inspections.get(path);
    if (inspection === undefined) {
      inspection = inspectBlob(path);
      inspections.set(path, inspection);
    }
    const result = await inspection;
    if (result.kind === "missing") {
      failed = true;
      collector.add({ identity, path, detail: "referenced canonical blob is missing" });
    } else if (result.kind === "unsafe") {
      failed = true;
      collector.add({ identity, path, detail: result.detail });
    } else if (result.kind === "error") {
      failed = true;
      collector.add({ identity, path, detail: result.detail });
    } else if (result.digest !== reference.digest) {
      failed = true;
      collector.add({
        identity,
        path,
        detail: `digest mismatch (expected ${reference.digest}, observed ${result.digest})`,
      });
    } else if (result.size !== reference.size) {
      failed = true;
      collector.add({
        identity,
        path,
        detail: `size mismatch (expected ${reference.size}, observed ${result.size})`,
      });
    }
  }
  return {
    check: failed
      ? check(
          "blobs",
          "fail",
          "one or more authoritative blob references failed verification",
          collector,
        )
      : check(
          "blobs",
          "pass",
          `verified ${read.references.length} authoritative blob reference(s)`,
          collector,
        ),
    references: read.references,
  };
}

async function orphanCheck(
  options: DoctorIntegrityOptions,
  references: readonly BlobReference[] | undefined,
): Promise<DoctorCheck> {
  const collector = evidenceCollector();
  if (references === undefined) {
    collector.add({
      path: options.blobDirectory,
      detail: "orphan scan is blocked until authoritative references are readable",
    });
    return check("orphans", "blocked", "orphan candidates could not be classified", collector);
  }
  const unsafeDirectory = await safePathIssue(options.privateRoot, options.blobDirectory);
  if (unsafeDirectory !== undefined) {
    collector.add({ path: options.blobDirectory, detail: unsafeDirectory });
    return check("orphans", "fail", "orphan scan path is unsafe", collector);
  }
  try {
    const directoryInfo = await lstat(options.blobDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      collector.add({
        path: options.blobDirectory,
        detail: "blob directory is not a regular directory",
      });
      return check("orphans", "fail", "orphan scan path is unsafe", collector);
    }
  } catch (error: unknown) {
    collector.add({
      path: options.blobDirectory,
      detail: `blob directory could not be inspected: ${stableError(error)}`,
    });
    return check("orphans", "blocked", "orphan candidates could not be classified", collector);
  }
  const referenced = new Set(references.map((reference) => reference.digest));
  let entries: readonly Dirent<string>[];
  try {
    entries = await readdir(options.blobDirectory, { withFileTypes: true, encoding: "utf8" });
  } catch (error: unknown) {
    collector.add({
      path: options.blobDirectory,
      detail: `blob directory could not be scanned: ${stableError(error)}`,
    });
    return check("orphans", "blocked", "orphan candidates could not be classified", collector);
  }
  let failed = false;
  for (const entry of entries) {
    if (STAGE.test(entry.name) || QUARANTINE.test(entry.name)) continue;
    const path = join(options.blobDirectory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      failed = true;
      collector.add({
        identity: `orphan:${entry.name}`,
        path,
        detail: "unreferenced canonical-name entry is not a regular file",
      });
    } else if (!SHA256.test(entry.name) || !referenced.has(entry.name)) {
      failed = true;
      collector.add({
        identity: `orphan:${entry.name}`,
        path,
        detail: "canonical blob is not referenced by message_blob_references",
      });
    }
  }
  return check(
    "orphans",
    failed ? "fail" : "pass",
    failed ? "orphan candidates were found" : "no orphan candidates found",
    collector,
  );
}

async function permissionsCheck(
  options: DoctorIntegrityOptions,
  checkedDatabasePath = options.databasePath,
): Promise<DoctorCheck> {
  const collector = evidenceCollector();
  const paths = [
    options.privateRoot,
    options.databasePath,
    `${options.databasePath}-wal`,
    `${options.databasePath}-shm`,
    options.blobDirectory,
  ];
  let failed = false;
  if (!validCanonicalPath(options.privateRoot)) {
    failed = true;
    collector.add({
      path: options.privateRoot,
      detail: "private root is not a canonical absolute path",
    });
  }
  if (
    validCanonicalPath(options.privateRoot) &&
    (!validCanonicalPath(checkedDatabasePath) ||
      !pathWithin(options.privateRoot, checkedDatabasePath))
  ) {
    failed = true;
    collector.add({
      path: checkedDatabasePath,
      detail: "database path is not beneath the private root",
    });
  }
  if (
    validCanonicalPath(options.privateRoot) &&
    (!validCanonicalPath(options.blobDirectory) ||
      !pathWithin(options.privateRoot, options.blobDirectory))
  ) {
    failed = true;
    collector.add({
      path: options.blobDirectory,
      detail: "blob directory is not beneath the private root",
    });
  }
  for (const path of paths) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error: unknown) {
      if (path === `${options.databasePath}-wal` || path === `${options.databasePath}-shm`) {
        if (isFsCode(error, "ENOENT")) continue;
      }
      failed = true;
      collector.add({
        path,
        detail: isFsCode(error, "ENOENT")
          ? "required private path is missing"
          : `private path could not be inspected: ${stableError(error)}`,
      });
      continue;
    }
    if (info.isSymbolicLink()) {
      failed = true;
      collector.add({ path, detail: "private path must not be a symbolic link" });
    }
    if ((info.mode & 0o077) !== 0) {
      failed = true;
      collector.add({
        path,
        detail: `private path has group/world permissions (${(info.mode & 0o777).toString(8)})`,
      });
    }
  }
  try {
    const entries: readonly Dirent<string>[] = await readdir(options.blobDirectory, {
      withFileTypes: true,
      encoding: "utf8",
    });
    for (const entry of entries) {
      const path = join(options.blobDirectory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        failed = true;
        collector.add({ path, detail: "blob entry must not be a symbolic link" });
      } else if ((info.mode & 0o077) !== 0) {
        failed = true;
        collector.add({
          path,
          detail: `blob entry has group/world permissions (${(info.mode & 0o777).toString(8)})`,
        });
      }
    }
  } catch (error: unknown) {
    failed = true;
    collector.add({
      path: options.blobDirectory,
      detail: `blob permissions could not be scanned: ${stableError(error)}`,
    });
  }
  return check(
    "permissions",
    failed ? "fail" : "pass",
    failed ? "private permission checks failed" : "private paths are owner-only",
    collector,
  );
}

/** Run all integrity checks without opening a write handle or issuing a mutating SQL/filesystem operation. */
async function runDoctorIntegrityInProcess(
  options: DoctorIntegrityOptions,
): Promise<DoctorIntegrityResult> {
  const opened = await openReadOnly(options.databasePath);
  const database = opened.database;
  try {
    const sqlite = sqliteIntegrityCheck(database, opened.openError, options.databasePath);
    const foreignKeys = foreignKeyCheck(database, opened.openError, options.databasePath);
    const migrations = migrationCheck(
      database,
      opened.openError,
      canonicalDatabaseMigrations,
      options.databasePath,
    );
    const blobs = await blobCheck(options, database, opened.openError);
    const orphans = await orphanCheck(options, blobs.references);
    const permissions = await permissionsCheck(
      options,
      Reflect.get(options as object, "permissionsDatabasePath") as string | undefined,
    );
    const checks = Object.freeze([
      sqlite,
      foreignKeys,
      migrations,
      blobs.check,
      orphans,
      permissions,
    ]);
    const status = checks.every((item) => item.status === "pass") ? "healthy" : "unhealthy";
    return Object.freeze({ status, checks });
  } finally {
    database?.close();
    await opened.cleanup?.();
  }
}

/**
 * Bun keeps a process-wide SQLite WAL cache.  A database handle that was
 * closed by a writer can still be checkpointed when a second Bun handle is
 * closed, even when that second handle points at a disposable copy.  Run the
 * read-only inspection in a fresh Bun process so the source process has no
 * SQLite state that can be checkpointed by the doctor.
 */
export async function runDoctorIntegrity(
  options: DoctorIntegrityOptions,
): Promise<DoctorIntegrityResult> {
  if (process.env.AGENT_MAIL_DOCTOR_WORKER === "1") {
    return runDoctorIntegrityInProcess(options);
  }
  const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const workerScript = [
    `import { runDoctorIntegrity as run } from ${JSON.stringify(moduleUrl)};`,
    "const options = JSON.parse(process.argv[1]);",
    "const result = await run(options);",
    "process.stdout.write(JSON.stringify(result));",
  ].join(" ");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["-e", workerScript, JSON.stringify(options)],
    {
      env: { ...process.env, AGENT_MAIL_DOCTOR_WORKER: "1" },
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as DoctorIntegrityResult;
}
