import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative } from "node:path";
import {
  BACKUP_MANIFEST_HASH_ALGORITHM,
  BACKUP_MANIFEST_VERSION,
  isExcludedBackupPath,
  type BackupManifest,
  type BackupManifestArtifact,
  type BackupManifestArtifactRole,
} from "./backup-manifest";
import { verifyCanonicalAdmissionIfPresent } from "./migration-history-conversion";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MANIFEST_NAME = "manifest.json";
const SHA256 = /^[0-9a-f]{64}$/u;
const STAGE_PREFIX = ".restore-v1-";

export type BackupRestoreOptions = Readonly<{
  /** A published backup directory containing manifest.json. */
  readonly backupPath: string;
  /** A new private root, or an existing empty private directory. */
  readonly destination: string;
}>;

export type BackupRestoreResult = Readonly<{
  readonly restorePath: string;
  readonly manifest: BackupManifest;
  readonly databasePath: string;
}>;

export type BackupRestoreErrorCode =
  | "invalid-backup"
  | "invalid-manifest"
  | "unsafe-path"
  | "symlink"
  | "unsafe-permissions"
  | "backup-incomplete"
  | "manifest-hash-mismatch"
  | "artifact-hash-mismatch"
  | "destination-invalid"
  | "destination-not-empty"
  | "sqlite-integrity-failed"
  | "foreign-key-check-failed"
  | "restore-failed";

export class BackupRestoreError extends Error {
  readonly code: BackupRestoreErrorCode;
  readonly path: string | undefined;

  constructor(
    code: BackupRestoreErrorCode,
    message: string,
    path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackupRestoreError";
    this.code = code;
    this.path = path;
  }
}

type RecordValue = Readonly<Record<string, unknown>>;
function fail(code: BackupRestoreErrorCode, message: string, path?: string): never {
  throw new BackupRestoreError(code, message, path);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isCanonicalAbsolutePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    isAbsolute(path) &&
    normalize(path) === path &&
    path !== parse(path).root
  );
}

function assertCanonicalAbsolutePath(path: string, code: BackupRestoreErrorCode): void {
  if (!isCanonicalAbsolutePath(path)) fail(code, "path must be a canonical absolute path", path);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function assertOwnerOnly(mode: number | bigint, path: string): void {
  const permissions = typeof mode === "bigint" ? mode & 0o77n : mode & 0o077;
  if (permissions !== 0 && permissions !== 0n)
    fail("unsafe-permissions", "path is not owner-only", path);
}

function assertOwnedByCaller(uid: number, path: string): void {
  const callerUid = process.getuid?.();
  if (callerUid !== undefined && uid !== callerUid) {
    fail("destination-invalid", "destination is not owned by the caller", path);
  }
}

async function assertPrivateDirectory(path: string, code: BackupRestoreErrorCode): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    fail(code, "private directory is unavailable", path);
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    fail(code, "private path is not a directory", path);
  assertOwnerOnly(info.mode, path);
  assertOwnedByCaller(info.uid, path);
}

function relativeSafePath(root: string, path: string): string {
  const value = relative(root, path);
  if (
    value.length === 0 ||
    value === ".." ||
    value.startsWith("../") ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("unsafe-path", "path must remain beneath the private root", path);
  }
  return value;
}

function manifestRelativePath(path: string): string {
  if (
    path.length === 0 ||
    path === MANIFEST_NAME ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    hasControlCharacters(path) ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("unsafe-path", "manifest artifact path is unsafe", path);
  }
  if (isExcludedBackupPath(path)) {
    fail("invalid-manifest", "backup contains excluded secret material", path);
  }
  return path;
}

function isManifestRole(value: unknown): value is BackupManifestArtifactRole {
  return (
    value === "sqlite-database" ||
    value === "sqlite-wal" ||
    value === "sqlite-shm" ||
    value === "canonical-blob" ||
    value === "configuration-metadata" ||
    value === "operational-journal"
  );
}

function readManifestArtifact(value: unknown, index: number): BackupManifestArtifact {
  if (!isRecord(value)) fail("invalid-manifest", "manifest entry is not an object", String(index));
  const path = value.path;
  const type = value.type;
  const size = value.size;
  const sha256 = value.sha256;
  const role = value.role;
  const required = value.required;
  if (
    typeof path !== "string" ||
    type !== "file" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof sha256 !== "string" ||
    !SHA256.test(sha256) ||
    !isManifestRole(role) ||
    typeof required !== "boolean"
  ) {
    fail("invalid-manifest", "manifest entry has an invalid shape", String(index));
  }
  const safePath = manifestRelativePath(path);
  if (role === "canonical-blob") {
    const name = safePath.split("/").at(-1);
    if (name === undefined || !SHA256.test(name) || name !== sha256) {
      fail("invalid-manifest", "canonical blob path and digest do not agree", safePath);
    }
  }
  return Object.freeze({ path: safePath, type, size, sha256, role, required });
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalManifestJson(entries: readonly BackupManifestArtifact[]): string {
  return JSON.stringify({
    version: BACKUP_MANIFEST_VERSION,
    hashAlgorithm: BACKUP_MANIFEST_HASH_ALGORITHM,
    entries,
  });
}

async function readAndValidateManifest(
  backupPath: string,
): Promise<{ readonly manifest: BackupManifest; readonly sourceFiles: readonly string[] }> {
  const manifestPath = join(backupPath, MANIFEST_NAME);
  let manifestInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    manifestInfo = await lstat(manifestPath);
  } catch {
    fail("invalid-manifest", "backup manifest is unavailable", manifestPath);
  }
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    fail("symlink", "backup manifest must be a regular file", manifestPath);
  }
  assertOwnerOnly(manifestInfo.mode, manifestPath);
  const raw = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid-manifest", "backup manifest is not valid JSON", manifestPath);
  }
  if (!isRecord(parsed)) fail("invalid-manifest", "backup manifest is not an object", manifestPath);
  if (
    parsed.version !== BACKUP_MANIFEST_VERSION ||
    parsed.hashAlgorithm !== BACKUP_MANIFEST_HASH_ALGORITHM
  ) {
    fail(
      "invalid-manifest",
      "backup manifest version or hash algorithm is unsupported",
      manifestPath,
    );
  }
  if (
    !Array.isArray(parsed.entries) ||
    typeof parsed.manifestSha256 !== "string" ||
    !SHA256.test(parsed.manifestSha256)
  ) {
    fail("invalid-manifest", "backup manifest has an invalid shape", manifestPath);
  }
  const entries = parsed.entries.map(readManifestArtifact);
  const sortedEntries = [...entries].sort((left, right) => comparePaths(left.path, right.path));
  if (entries.some((entry, index) => entry.path !== sortedEntries[index]?.path)) {
    fail("invalid-manifest", "backup manifest entries are not canonically sorted", manifestPath);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path))
      fail("invalid-manifest", "backup manifest contains a duplicate path", entry.path);
    seen.add(entry.path);
  }
  const computedManifestHash = createHash("sha256")
    .update(canonicalManifestJson(entries), "utf8")
    .digest("hex");
  if (computedManifestHash !== parsed.manifestSha256) {
    fail("manifest-hash-mismatch", "backup manifest digest does not verify", manifestPath);
  }

  const databaseEntries = entries.filter((entry) => entry.role === "sqlite-database");
  if (databaseEntries.length !== 1)
    fail("backup-incomplete", "backup must contain one SQLite database");
  const hasWal = entries.some((entry) => entry.role === "sqlite-wal");
  const hasShm = entries.some((entry) => entry.role === "sqlite-shm");
  if (hasWal !== hasShm) fail("backup-incomplete", "SQLite WAL and SHM entries must be paired");
  if (!entries.some((entry) => entry.role === "configuration-metadata")) {
    fail("backup-incomplete", "backup must contain configuration metadata");
  }
  return {
    manifest: Object.freeze({
      version: BACKUP_MANIFEST_VERSION,
      hashAlgorithm: BACKUP_MANIFEST_HASH_ALGORITHM,
      entries: Object.freeze(entries),
      manifestSha256: parsed.manifestSha256,
    }),
    sourceFiles: Object.freeze(entries.map((entry) => entry.path)),
  };
}

async function hashFile(path: string): Promise<{ readonly size: number; readonly sha256: string }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const initial = await handle.stat();
    if (!initial.isFile()) fail("backup-incomplete", "artifact is not a regular file", path);
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
    if (!final.isFile() || final.size !== size || final.size !== initial.size) {
      fail("artifact-hash-mismatch", "artifact changed while it was verified", path);
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    await handle?.close();
  }
}

async function verifyArtifacts(
  root: string,
  entries: readonly BackupManifestArtifact[],
): Promise<void> {
  for (const entry of entries) {
    const path = join(root, entry.path);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) {
      if (entry.required)
        fail("backup-incomplete", "required backup artifact is missing", entry.path);
      continue;
    }
    if (info.isSymbolicLink()) fail("symlink", "backup artifact is a symbolic link", entry.path);
    if (!info.isFile())
      fail("backup-incomplete", "backup artifact is not a regular file", entry.path);
    assertOwnerOnly(info.mode, entry.path);
    const observed = await hashFile(path);
    if (observed.size !== entry.size || observed.sha256 !== entry.sha256) {
      fail("artifact-hash-mismatch", "backup artifact digest or size does not verify", entry.path);
    }
  }
}

async function enumerateFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relativeSafePath(root, absolutePath);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) fail("symlink", "backup contains a symbolic link", relativePath);
      assertOwnerOnly(info.mode, relativePath);
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        files.push(relativePath);
      } else {
        fail("backup-incomplete", "backup contains a non-regular artifact", relativePath);
      }
    }
  }
  await visit(root);
  return files;
}

async function verifyBackupInventory(
  backupPath: string,
  manifest: BackupManifest,
  sourceFiles: readonly string[],
): Promise<void> {
  const actual = await enumerateFiles(backupPath);
  const expected = [...sourceFiles, MANIFEST_NAME].sort(comparePaths);
  const observed = [...actual].sort(comparePaths);
  if (
    expected.length !== observed.length ||
    expected.some((path, index) => path !== observed[index])
  ) {
    fail("backup-incomplete", "backup contains files outside its verified manifest", backupPath);
  }
  await verifyArtifacts(backupPath, manifest.entries);
}

async function assertDestination(destination: string): Promise<void> {
  assertCanonicalAbsolutePath(destination, "destination-invalid");
  await assertPrivateDirectory(dirname(destination), "destination-invalid");
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isDirectory())
      fail("destination-invalid", "destination is not a directory", destination);
    assertOwnerOnly(info.mode, destination);
    assertOwnedByCaller(info.uid, destination);
    if ((await readdir(destination)).length !== 0)
      fail("destination-not-empty", "destination must be empty", destination);
    return;
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
}

async function makeStage(parent: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stage = join(
      parent,
      `${STAGE_PREFIX}${process.pid}-${randomBytes(16).toString("hex")}.tmp`,
    );
    try {
      await mkdir(stage, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(stage, PRIVATE_DIRECTORY_MODE);
      return stage;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("could not create a private restore staging root");
}

async function ensureDirectory(root: string, path: string): Promise<void> {
  const remainder = relative(root, path);
  if (remainder === ".." || remainder.startsWith("../") || isAbsolute(remainder)) {
    fail("unsafe-path", "restore path escaped its destination", path);
  }
  if (remainder === "") return;
  let current = root;
  for (const segment of remainder.split("/")) {
    current = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(current);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    if (info !== undefined) {
      if (info.isSymbolicLink() || !info.isDirectory())
        fail("symlink", "restore parent is unsafe", current);
      assertOwnerOnly(info.mode, current);
      continue;
    }
    await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(current, PRIVATE_DIRECTORY_MODE);
  }
}

async function copyArtifacts(
  sourceRoot: string,
  destinationRoot: string,
  entries: readonly BackupManifestArtifact[],
): Promise<void> {
  for (const entry of entries) {
    const source = join(sourceRoot, entry.path);
    const target = join(destinationRoot, entry.path);
    await ensureDirectory(destinationRoot, dirname(target));
    await copyFile(source, target);
    await chmod(target, PRIVATE_FILE_MODE);
  }
}

async function verifySQLite(
  destinationRoot: string,
  databaseEntry: BackupManifestArtifact,
): Promise<void> {
  const path = join(destinationRoot, databaseEntry.path);
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true, strict: true, create: false });
    const integrity: unknown = database.query("PRAGMA integrity_check;").get();
    if (!isRecord(integrity) || integrity.integrity_check !== "ok") {
      fail("sqlite-integrity-failed", "restored SQLite integrity_check failed", databaseEntry.path);
    }
    const foreignKeys = database.query("PRAGMA foreign_key_check;").all();
    if (foreignKeys.length !== 0) {
      fail(
        "foreign-key-check-failed",
        "restored SQLite foreign_key_check failed",
        databaseEntry.path,
      );
    }
    verifyCanonicalAdmissionIfPresent(database);
  } catch (error: unknown) {
    if (error instanceof BackupRestoreError) throw error;
    throw new BackupRestoreError(
      "sqlite-integrity-failed",
      "restored SQLite verification failed",
      databaseEntry.path,
      {
        cause: error,
      },
    );
  } finally {
    database?.close();
  }
}

/** Restore one verified backup into a private empty root without replacing a live root. */
export async function restoreBackup(options: BackupRestoreOptions): Promise<BackupRestoreResult> {
  assertCanonicalAbsolutePath(options.backupPath, "invalid-backup");
  await assertPrivateDirectory(options.backupPath, "invalid-backup");
  await assertDestination(options.destination);
  const { manifest, sourceFiles } = await readAndValidateManifest(options.backupPath);
  await verifyBackupInventory(options.backupPath, manifest, sourceFiles);

  const databaseEntry = manifest.entries.find((entry) => entry.role === "sqlite-database");
  if (databaseEntry === undefined) fail("backup-incomplete", "backup has no SQLite database");

  const stage = await makeStage(dirname(options.destination));
  try {
    await copyArtifacts(options.backupPath, stage, manifest.entries);
    await verifyArtifacts(stage, manifest.entries);
    await verifySQLite(stage, databaseEntry);
    // SQLite verification may materialize sidecars; the post-check hash is the final publication guard.
    await verifyArtifacts(stage, manifest.entries);
    // Renaming over an existing empty directory is atomic. If a concurrent writer
    // makes it non-empty after the precondition check, rename fails without
    // publishing the staged restore or touching that directory's contents.
    await rename(stage, options.destination);
    return {
      restorePath: options.destination,
      manifest,
      databasePath: join(options.destination, databaseEntry.path),
    };
  } catch (error: unknown) {
    try {
      await rm(stage, { recursive: true, force: true });
    } catch (cleanupError: unknown) {
      throw new BackupRestoreError(
        "restore-failed",
        "failed restore staging root could not be removed",
        options.destination,
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    if (error instanceof BackupRestoreError) throw error;
    throw new BackupRestoreError("restore-failed", "backup restore failed", options.destination, {
      cause: error,
    });
  }
}

/** Descriptive alias for callers that name the operation a verified restore. */
export const restoreVerifiedBackup = restoreBackup;
