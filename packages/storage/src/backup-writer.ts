import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  lstat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative } from "node:path";
import { buildBackupManifest, type BackupManifest, type BackupManifestOptions } from "./backup-manifest";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MANIFEST_NAME = "manifest.json";

/** A caller-validated source archive and its exact, caller-selected destination. */
export type BackupWriterOptions = Readonly<
  Omit<BackupManifestOptions, "privateRoot"> & {
    /** The existing private root containing the live archive. */
    readonly privateRoot: string;
    /** The exact final backup directory. It must not already exist. */
    readonly destination: string;
    /** Pause only for opening and serializing SQLite. */
    readonly pauseSource?: () => void | Promise<void>;
    /** Resume immediately after SQLite serialization. */
    readonly resumeSource?: () => void | Promise<void>;
    /** Test/operations seam immediately before the atomic directory rename. */
    readonly beforePublish?: () => void | Promise<void>;
  }
>;

export type BackupWriterResult = Readonly<{
  readonly backupPath: string;
  readonly manifest: BackupManifest;
}>;

export type BackupWriterErrorCode =
  | "invalid-destination"
  | "invalid-snapshot-control"
  | "destination-exists"
  | "snapshot-failed"
  | "copy-failed"
  | "verification-failed"
  | "publication-interrupted"
  | "publication-failed";

/** Stable errors retain the private stage path so an interrupted stage is removable. */
export class BackupWriterError extends Error {
  readonly code: BackupWriterErrorCode;
  readonly stagingPath: string | undefined;

  constructor(
    code: BackupWriterErrorCode,
    message: string,
    options?: ErrorOptions & { readonly stagingPath?: string },
  ) {
    super(message, options);
    this.name = "BackupWriterError";
    this.code = code;
    this.stagingPath = options?.stagingPath;
  }
}

type SourceArtifact = Readonly<{
  readonly path: string;
}>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value &&
    value !== parse(value).root
  );
}

function assertDestinationPath(destination: string): void {
  if (!isCanonicalAbsolutePath(destination)) {
    throw new BackupWriterError(
      "invalid-destination",
      "backup destination must be a canonical absolute directory path",
    );
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new BackupWriterError("invalid-destination", "backup directory is not private");
  }
}

async function assertDestinationAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw new BackupWriterError("publication-failed", "backup destination could not be inspected", {
      cause: error,
    });
  }
  throw new BackupWriterError("destination-exists", "backup destination already exists");
}

async function syncPath(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array | string): Promise<void> {
  await writeFile(path, bytes, { mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
  await syncPath(path);
}

async function makeStage(destinationDirectory: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = randomBytes(24).toString("hex");
    const stage = join(destinationDirectory, `.stage-v1-${process.pid}-${suffix}.tmp`);
    try {
      await mkdir(stage, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(stage, PRIVATE_DIRECTORY_MODE);
      return stage;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw new BackupWriterError("publication-failed", "backup staging directory could not be created", {
        cause: error,
      });
    }
  }
  throw new BackupWriterError("publication-failed", "backup staging directory name was not unique");
}

function sourceArtifacts(manifest: BackupManifest): readonly SourceArtifact[] {
  return manifest.entries
    .filter(
      (entry) =>
        entry.role !== "sqlite-database" &&
        entry.role !== "sqlite-wal" &&
        entry.role !== "sqlite-shm",
    )
    .map((entry) => ({ path: entry.path }));
}

function relativeFromRoot(root: string, path: string): string {
  const result = relative(root, path);
  if (
    result.length === 0 ||
    result === ".." ||
    result.startsWith(`..${"/"}`) ||
    isAbsolute(result) ||
    result.includes("\\")
  ) {
    throw new BackupWriterError("copy-failed", "backup artifact is outside the private root");
  }
  return result;
}

function stageManifestOptions(
  options: BackupWriterOptions,
  sourceRoot: string,
  stage: string,
): BackupManifestOptions {
  const pathInStage = (path: string): string => join(stage, relativeFromRoot(sourceRoot, path));
  return {
    privateRoot: stage,
    databasePath: pathInStage(options.databasePath),
    blobDirectory: pathInStage(options.blobDirectory),
    journalDirectory: pathInStage(options.journalDirectory),
    configurationMetadataPaths: options.configurationMetadataPaths.map(pathInStage),
    referencedBlobDigests: options.referencedBlobDigests,
  };
}

async function copyArtifact(sourceRoot: string, stage: string, artifact: SourceArtifact): Promise<void> {
  const source = join(sourceRoot, artifact.path);
  const target = join(stage, artifact.path);
  const targetDirectory = dirname(target);
  await ensurePrivatePath(stage, targetDirectory);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new BackupWriterError("copy-failed", "backup source artifact is not a regular file", {
      cause: artifact.path,
    });
  }
  await copyFile(source, target);
  await chmod(target, PRIVATE_FILE_MODE);
  await syncPath(target);
}

async function ensurePrivatePath(stage: string, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  let current = directory;
  while (current !== stage && current.startsWith(`${stage}/`)) {
    await chmod(current, PRIVATE_DIRECTORY_MODE);
    current = dirname(current);
  }
  await chmod(stage, PRIVATE_DIRECTORY_MODE);
}

async function snapshotDatabase(databasePath: string): Promise<Buffer> {
  let database: Database | undefined;
  try {
    // Bun exposes SQLite's consistent serialize operation, which includes
    // committed WAL pages. A main-file copy would silently lose those rows.
    database = new Database(databasePath, { readonly: true, create: false });
    const snapshot = database.serialize();
    if (snapshot.byteLength === 0) throw new Error("SQLite serialize returned no bytes");
    return Buffer.from(snapshot);
  } catch (error: unknown) {
    throw new BackupWriterError("snapshot-failed", "SQLite snapshot could not be serialized", {
      cause: error,
    });
  } finally {
    database?.close();
  }
}

async function verifySnapshot(databasePath: string): Promise<void> {
  let database: Database | undefined;
  try {
    // Bun 1.3.14 cannot query a serialized WAL-mode image in readonly mode
    // until SQLite has materialized its sidecars. Strict read/write mode is
    // used only for this local verification, then the private sidecars are
    // retained as part of the verified SQLite representation.
    database = new Database(databasePath, { strict: true, create: false });
    const row: unknown = database.query("PRAGMA integrity_check;").get();
    if (
      typeof row !== "object" ||
      row === null ||
      !("integrity_check" in row) ||
      row.integrity_check !== "ok"
    ) {
      throw new Error("SQLite integrity_check did not return ok");
    }
    database.close();
    database = undefined;
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      try {
        await chmod(sidecar, PRIVATE_FILE_MODE);
        await syncPath(sidecar);
      } catch (error: unknown) {
        if (!isMissing(error)) throw error;
      }
    }
  } catch (error: unknown) {
    if (error instanceof BackupWriterError) throw error;
    throw new BackupWriterError("verification-failed", "SQLite snapshot failed integrity verification", {
      cause: error,
    });
  } finally {
    database?.close();
  }
}

function manifestJson(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

async function syncDirectories(root: string): Promise<void> {
  const visited: string[] = [root];
  while (visited.length > 0) {
    const directory = visited.pop();
    if (directory === undefined) continue;
    const listing = await readdir(directory, {
      withFileTypes: true,
      encoding: "utf8",
    });
    for (const entry of listing) {
      if (entry.isDirectory()) visited.push(join(directory, entry.name));
    }
    await syncPath(directory);
  }
}

/**
 * Write one complete backup using a private stage and one final directory
 * rename. SQLite is captured through Bun's supported serialize API rather
 * than copying the live database/WAL pair.
 */
export async function writeBackup(options: BackupWriterOptions): Promise<BackupWriterResult> {
  assertDestinationPath(options.destination);
  if ((options.pauseSource === undefined) !== (options.resumeSource === undefined)) {
    throw new BackupWriterError(
      "invalid-snapshot-control",
      "pauseSource and resumeSource must be provided together",
    );
  }
  const destinationDirectory = dirname(options.destination);
  await assertPrivateDirectory(destinationDirectory);
  await assertDestinationAbsent(options.destination);

  const sourceManifest = await buildBackupManifest(options);
  const stage = await makeStage(destinationDirectory);
  let published = false;
  try {
    const databaseRelativePath = relativeFromRoot(options.privateRoot, options.databasePath);
    const snapshot = await (async () => {
      let paused = false;
      try {
        if (options.pauseSource !== undefined) {
          await options.pauseSource();
          paused = true;
        }
        return await snapshotDatabase(options.databasePath);
      } finally {
        if (paused && options.resumeSource !== undefined) await options.resumeSource();
      }
    })();
    const stagedDatabasePath = join(stage, databaseRelativePath);
    await mkdir(dirname(stagedDatabasePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(dirname(stagedDatabasePath), PRIVATE_DIRECTORY_MODE);
    await writePrivateFile(stagedDatabasePath, snapshot);
    await verifySnapshot(stagedDatabasePath);

    for (const artifact of sourceArtifacts(sourceManifest)) {
      await copyArtifact(options.privateRoot, stage, artifact);
    }
    await syncDirectories(stage);

    // Empty blob and journal directories are still part of the archive shape.
    await ensurePrivatePath(stage, join(stage, relativeFromRoot(options.privateRoot, options.blobDirectory)));
    await ensurePrivatePath(stage, join(stage, relativeFromRoot(options.privateRoot, options.journalDirectory)));
    const stagedOptions = stageManifestOptions(options, options.privateRoot, stage);
    const firstManifest = await buildBackupManifest(stagedOptions);
    await writePrivateFile(join(stage, MANIFEST_NAME), manifestJson(firstManifest));
    // A second inventory is the final rehash of every copied artifact. It also
    // catches a test/operations hook that mutates a stage before publication.
    const finalManifest = await buildBackupManifest(stagedOptions);
    if (JSON.stringify(finalManifest) !== JSON.stringify(firstManifest)) {
      throw new BackupWriterError("verification-failed", "backup artifacts changed during verification");
    }
    await writePrivateFile(join(stage, MANIFEST_NAME), manifestJson(finalManifest));
    await syncDirectories(stage);
    await syncPath(destinationDirectory);

    try {
      await options.beforePublish?.();
    } catch (error: unknown) {
      throw new BackupWriterError(
        "publication-interrupted",
        "backup publication was interrupted before the atomic rename",
        { cause: error, stagingPath: stage },
      );
    }
    await assertDestinationAbsent(options.destination);
    try {
      await rename(stage, options.destination);
      published = true;
    } catch (error: unknown) {
      throw new BackupWriterError("publication-failed", "backup directory could not be published", {
        cause: error,
        stagingPath: stage,
      });
    }
    await syncPath(destinationDirectory);
    return { backupPath: options.destination, manifest: finalManifest };
  } catch (error: unknown) {
    if (published) {
      if (error instanceof BackupWriterError) throw error;
      throw new BackupWriterError(
        "publication-failed",
        "backup was published but its parent directory could not be synchronized",
        { cause: error },
      );
    }
    if (error instanceof BackupWriterError) {
      if (error.stagingPath !== undefined) throw error;
      throw new BackupWriterError(error.code, error.message, {
        cause: error,
        stagingPath: stage,
      });
    }
    throw new BackupWriterError("copy-failed", "backup could not be written", {
      cause: error,
      stagingPath: stage,
    });
  }
}

/** Descriptive alias for callers that call the operation a backup creation. */
export const createBackup = writeBackup;
