import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { isAbsolute, join, normalize, parse, relative, sep } from "node:path";

/** The on-disk manifest format. A format change requires a new version. */
export const BACKUP_MANIFEST_VERSION = 1 as const;
export const BACKUP_MANIFEST_HASH_ALGORITHM = "sha256" as const;

export type BackupManifestArtifactRole =
  | "sqlite-database"
  | "sqlite-wal"
  | "sqlite-shm"
  | "canonical-blob"
  | "configuration-metadata"
  | "operational-journal";

export type BackupManifestArtifact = Readonly<{
  /** A slash-separated path relative to privateRoot. */
  readonly path: string;
  readonly type: "file";
  readonly size: number;
  readonly sha256: string;
  readonly role: BackupManifestArtifactRole;
  readonly required: boolean;
}>;

export type BackupManifest = Readonly<{
  readonly version: typeof BACKUP_MANIFEST_VERSION;
  readonly hashAlgorithm: typeof BACKUP_MANIFEST_HASH_ALGORITHM;
  readonly entries: readonly BackupManifestArtifact[];
  /** SHA-256 of the canonical JSON representation of version, algorithm, and entries. */
  readonly manifestSha256: string;
}>;

export type BackupManifestOptions = Readonly<{
  /** The existing, canonical, private root. This function never creates it. */
  readonly privateRoot: string;
  /** The primary SQLite database file. Its WAL and SHM companions are discovered beside it. */
  readonly databasePath: string;
  /** The canonical content-addressed blob directory. */
  readonly blobDirectory: string;
  /** The journal directory. All regular files below it are inventory artifacts. */
  readonly journalDirectory: string;
  /** Required, non-secret configuration metadata files. */
  readonly configurationMetadataPaths: readonly string[];
  /** Blob digests referenced by the database's normalized rows. */
  readonly referencedBlobDigests?: readonly string[];
  /** Explicit sidecar paths are useful for tests and non-default SQLite names. */
  readonly databaseWalPath?: string;
  readonly databaseShmPath?: string;
}>;

export type BackupManifestErrorCode =
  | "invalid-root"
  | "unsafe-path"
  | "symlink"
  | "unsafe-permissions"
  | "duplicate-path"
  | "missing-required-artifact"
  | "not-regular-file"
  | "invalid-blob-name"
  | "blob-integrity-mismatch"
  | "unexpected-blob-artifact"
  | "wal-inconsistent"
  | "secret-metadata";

/** Stable errors for a rejected inventory; messages never contain file contents or secrets. */
export class BackupManifestError extends Error {
  readonly code: BackupManifestErrorCode;
  readonly path: string | undefined;

  constructor(code: BackupManifestErrorCode, message: string, path?: string) {
    super(message);
    this.name = "BackupManifestError";
    this.code = code;
    this.path = path;
  }
}

const SHA256 = /^[0-9a-f]{64}$/u;
const STAGE = /^\.stage-v1-pid[1-9]\d*-owner[0-9a-f]{64}-random[0-9a-f]{64}\.tmp$/u;
const QUARANTINE = /^\.quarantine-v1-[0-9a-f]{64}-[0-9a-f]{32}\.blob$/u;

type ArtifactInput = Readonly<{
  readonly absolutePath: string;
  readonly role: BackupManifestArtifactRole;
  readonly required: boolean;
}>;

type RootContext = Readonly<{ readonly root: string }>;

function fail(code: BackupManifestErrorCode, message: string, path?: string): never {
  throw new BackupManifestError(code, message, path);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateCanonicalAbsolutePath(path: string, code: "invalid-root" | "unsafe-path"): void {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === parse(path).root ||
    hasControlCharacters(path)
  ) {
    fail(code, code === "invalid-root" ? "private root must be a canonical directory" : "path is not canonical", path);
  }
}

async function openRoot(privateRoot: string): Promise<RootContext> {
  validateCanonicalAbsolutePath(privateRoot, "invalid-root");
  let rootStats: Stats;
  try {
    rootStats = await lstat(privateRoot);
  } catch {
    fail("invalid-root", "private root is unavailable", privateRoot);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    fail("invalid-root", "private root must be a regular directory", privateRoot);
  }
  if ((rootStats.mode & 0o077) !== 0) {
    fail("unsafe-permissions", "private root is not owner-only", privateRoot);
  }
  return { root: privateRoot };
}

function relativeSafePath(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath);
  if (
    path.length === 0 ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path) ||
    hasControlCharacters(path) ||
    path.includes("\\")
  ) {
    fail("unsafe-path", "artifact path must remain beneath private root", absolutePath);
  }
  return path.split(sep).join("/");
}

async function assertPrivatePath(context: RootContext, absolutePath: string): Promise<string> {
  validateCanonicalAbsolutePath(absolutePath, "unsafe-path");
  const path = relativeSafePath(context.root, absolutePath);
  const segments = path.split("/");
  let current = context.root;
  for (const segment of segments) {
    current = join(current, segment);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error: unknown) {
      if (isMissing(error)) fail("missing-required-artifact", "required artifact is missing", path);
      fail("unsafe-path", "artifact path cannot be inspected", path);
    }
    if (info.isSymbolicLink()) fail("symlink", "symbolic links are not allowed in the inventory", path);
  }
  return path;
}

async function assertPrivateDirectory(context: RootContext, path: string): Promise<string> {
  const relativePath = await assertPrivatePath(context, path);
  const info = await lstat(path);
  if (!info.isDirectory()) fail("not-regular-file", "artifact directory is not a directory", relativePath);
  if ((info.mode & 0o077) !== 0) fail("unsafe-permissions", "artifact directory is not owner-only", relativePath);
  return relativePath;
}

async function inspectRegularFile(
  context: RootContext,
  input: ArtifactInput,
): Promise<BackupManifestArtifact> {
  const relativePath = await assertPrivatePath(context, input.absolutePath);
  let info: Stats;
  try {
    info = await lstat(input.absolutePath);
  } catch (error: unknown) {
    if (isMissing(error) && input.required) {
      fail("missing-required-artifact", "required artifact is missing", relativePath);
    }
    throw error;
  }
  if (info.isSymbolicLink()) fail("symlink", "symbolic links are not allowed in the inventory", relativePath);
  if (!info.isFile()) fail("not-regular-file", "artifact is not a regular file", relativePath);
  if ((info.mode & 0o077) !== 0) fail("unsafe-permissions", "artifact is not owner-only", relativePath);

  let handle: FileHandle | undefined;
  try {
    handle = await open(input.absolutePath, "r");
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size !== info.size) {
      fail("not-regular-file", "artifact changed while it was inspected", relativePath);
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
    if (!final.isFile() || final.size !== size || final.size !== initial.size) {
      fail("not-regular-file", "artifact changed while it was inspected", relativePath);
    }
    return Object.freeze({
      path: relativePath,
      type: "file",
      size,
      sha256: hash.digest("hex"),
      role: input.role,
      required: input.required,
    });
  } finally {
    await handle?.close();
  }
}

function addUnique(
  seen: Set<string>,
  input: ArtifactInput,
  context: RootContext,
): Promise<BackupManifestArtifact> {
  const path = relativeSafePath(context.root, input.absolutePath);
  if (seen.has(path)) fail("duplicate-path", "manifest contains a duplicate path", path);
  seen.add(path);
  return inspectRegularFile(context, input);
}

function isSensitiveMetadataPath(path: string): boolean {
  return path
    .toLowerCase()
    .split("/")
    .some((segment) =>
      /^(?:secret|secrets|credential|credentials|token|tokens|password|passwd|\.env)|(?:secret|token|password|credential)/u.test(
        segment,
      ),
    );
}

function isCanonicalBlobName(name: string): boolean {
  return SHA256.test(name);
}

function isIgnoredBlobEvidence(name: string): boolean {
  return STAGE.test(name) || QUARANTINE.test(name);
}

async function readCanonicalBlobs(
  context: RootContext,
  blobDirectory: string,
  referencedBlobDigests: readonly string[],
  seen: Set<string>,
): Promise<BackupManifestArtifact[]> {
  const directoryPath = await assertPrivateDirectory(context, blobDirectory);
  let entries: readonly Dirent<string>[];
  try {
    entries = await readdir(blobDirectory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    fail("missing-required-artifact", "canonical blob directory is unavailable", directoryPath);
  }

  const artifacts: BackupManifestArtifact[] = [];
  for (const entry of entries) {
    const absolutePath = join(blobDirectory, entry.name);
    const relativePath = relativeSafePath(context.root, absolutePath);
    let info: Stats;
    try {
      info = await lstat(absolutePath);
    } catch {
      fail("unsafe-path", "blob entry cannot be inspected", relativePath);
    }
    if (info.isSymbolicLink()) fail("symlink", "symbolic links are not allowed in the blob store", relativePath);
    if (isIgnoredBlobEvidence(entry.name)) continue;
    if (!isCanonicalBlobName(entry.name) || !info.isFile()) {
      fail("unexpected-blob-artifact", "blob store contains an unclassified artifact", relativePath);
    }
    artifacts.push(
      await addUnique(
        seen,
        { absolutePath, role: "canonical-blob", required: true },
        context,
      ),
    );
    const artifact = artifacts.at(-1);
    if (artifact === undefined || artifact.sha256 !== entry.name) {
      fail("blob-integrity-mismatch", "canonical blob digest does not match its filename", relativePath);
    }
  }

  const available = new Set(
    artifacts.map((artifact) => artifact.path.slice(directoryPath.length + 1)),
  );
  for (const digest of referencedBlobDigests) {
    if (!SHA256.test(digest) || !available.has(digest)) {
      fail("missing-required-artifact", "a database-referenced canonical blob is missing", digest);
    }
  }
  return artifacts;
}

async function readJournalFiles(
  context: RootContext,
  directory: string,
  seen: Set<string>,
): Promise<BackupManifestArtifact[]> {
  await assertPrivateDirectory(context, directory);
  const artifacts: BackupManifestArtifact[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    let entries: readonly Dirent<string>[];
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      fail("unsafe-path", "journal directory cannot be inspected", currentDirectory);
    }
    for (const entry of entries) {
      const absolutePath = join(currentDirectory, entry.name);
      const relativePath = relativeSafePath(context.root, absolutePath);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) fail("symlink", "symbolic links are not allowed in the journal", relativePath);
      if (info.isDirectory()) {
        if ((info.mode & 0o077) !== 0) fail("unsafe-permissions", "journal directory is not owner-only", relativePath);
        await visit(absolutePath);
        continue;
      }
      if (!info.isFile()) fail("not-regular-file", "journal artifact is not a regular file", relativePath);
      artifacts.push(
        await addUnique(
          seen,
          { absolutePath, role: "operational-journal", required: true },
          context,
        ),
      );
    }
  }

  await visit(directory);
  return artifacts;
}

function canonicalManifestJson(
  entries: readonly BackupManifestArtifact[],
): string {
  return JSON.stringify({
    version: BACKUP_MANIFEST_VERSION,
    hashAlgorithm: BACKUP_MANIFEST_HASH_ALGORITHM,
    entries,
  });
}

/**
 * Inventory an existing private archive without copying, opening SQLite, or
 * mutating any path. The returned entries are sorted by their safe relative
 * path and contain hashes of bytes observed with a stable file-size check.
 */
export async function buildBackupManifest(options: BackupManifestOptions): Promise<BackupManifest> {
  const context = await openRoot(options.privateRoot);
  const seen = new Set<string>();
  const entries: BackupManifestArtifact[] = [];

  const databasePath = options.databasePath;
  const walPath = options.databaseWalPath ?? `${databasePath}-wal`;
  const shmPath = options.databaseShmPath ?? `${databasePath}-shm`;
  entries.push(
    await addUnique(seen, { absolutePath: databasePath, role: "sqlite-database", required: true }, context),
  );

  let walExists = false;
  try {
    const walInfo = await lstat(walPath);
    walExists = true;
    if (walInfo.isSymbolicLink()) fail("symlink", "SQLite WAL sidecar is a symbolic link", walPath);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    if (options.databaseWalPath !== undefined) {
      fail("missing-required-artifact", "explicit SQLite WAL sidecar is missing", walPath);
    }
  }
  let shmExists = false;
  try {
    const shmInfo = await lstat(shmPath);
    shmExists = true;
    if (shmInfo.isSymbolicLink()) fail("symlink", "SQLite SHM sidecar is a symbolic link", shmPath);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    if (options.databaseShmPath !== undefined) {
      fail("missing-required-artifact", "explicit SQLite SHM sidecar is missing", shmPath);
    }
  }
  if (walExists !== shmExists) {
    fail("wal-inconsistent", "SQLite WAL and SHM sidecars must be inventoried together");
  }
  if (walExists) {
    entries.push(
      await addUnique(seen, { absolutePath: walPath, role: "sqlite-wal", required: true }, context),
      await addUnique(seen, { absolutePath: shmPath, role: "sqlite-shm", required: true }, context),
    );
  }

  if (options.configurationMetadataPaths.length === 0) {
    fail("missing-required-artifact", "at least one configuration metadata artifact is required");
  }
  for (const path of options.configurationMetadataPaths) {
    const relativePath = relativeSafePath(context.root, path);
    if (isSensitiveMetadataPath(relativePath)) fail("secret-metadata", "secret material cannot be a metadata artifact", relativePath);
    entries.push(
      await addUnique(
        seen,
        { absolutePath: path, role: "configuration-metadata", required: true },
        context,
      ),
    );
  }

  const referencedBlobDigests = options.referencedBlobDigests ?? [];
  entries.push(
    ...(await readCanonicalBlobs(context, options.blobDirectory, referencedBlobDigests, seen)),
    ...(await readJournalFiles(context, options.journalDirectory, seen)),
  );
  // Use code-unit ordering rather than localeCompare so the manifest is stable
  // across machines with different locale settings.
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const frozenEntries = Object.freeze(entries.map((entry) => Object.freeze(entry)));
  const manifestJson = canonicalManifestJson(frozenEntries);
  return Object.freeze({
    version: BACKUP_MANIFEST_VERSION,
    hashAlgorithm: BACKUP_MANIFEST_HASH_ALGORITHM,
    entries: frozenEntries,
    manifestSha256: createHash("sha256").update(manifestJson, "utf8").digest("hex"),
  });
}

/** Descriptive alias for callers that name the result an inventory. */
export const buildBackupInventory = buildBackupManifest;
