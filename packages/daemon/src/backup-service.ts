import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, parse, relative } from "node:path";
import {
  reportAdminBackupResponseSchema,
  type ReportAdminBackupRequest,
  type ReportAdminBackupResponse,
} from "@agent-mail/contracts";
import {
  createBackup,
  type BackupWriterOptions,
  type BackupWriterResult,
} from "../../storage/src/backup-writer";
import type { BackupManifest } from "../../storage/src/backup-manifest";
import type { PrivatePaths } from "./config";
import type {
  ReportAdminService,
  ReportAdminServiceContext,
  ReportAdminServiceFailure,
} from "./report-admin-handlers";

const BACKUP_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MANIFEST_NAME = "manifest.json";

/** The already validated private paths needed by the backup capability. */
export type BackupPrivateConfiguration = Readonly<{
  readonly privateRoot: string;
  readonly paths: PrivatePaths;
}>;

export type BackupServiceOptions = Readonly<{
  readonly configuration: BackupPrivateConfiguration;
  /** Defaults to `<privateRoot>/data/archive.sqlite`. */
  readonly databasePath?: string;
  /** Defaults to `<privateRoot>/config/archive-metadata.json`. */
  readonly configurationMetadataPaths?: readonly string[];
  readonly referencedBlobDigests?: readonly string[];
  readonly pauseSource?: () => void | Promise<void>;
  readonly resumeSource?: () => void | Promise<void>;
  readonly beforePublish?: () => void | Promise<void>;
  /** Injection is limited to the writer seam; production uses createBackup. */
  readonly writer?: (options: BackupWriterOptions) => Promise<BackupWriterResult>;
  readonly now?: () => Date;
}>;

export type BackupService = Readonly<{
  readonly backup: ReportAdminService<ReportAdminBackupRequest, ReportAdminBackupResponse>;
}>;

export type BackupServiceErrorCode =
  | "invalid-configuration"
  | "invalid-label"
  | "destination-conflict"
  | "backup-failed"
  | "verification-failed";

export class BackupServiceError extends Error {
  readonly code: BackupServiceErrorCode;

  constructor(code: BackupServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupServiceError";
    this.code = code;
  }
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBackupPrivateConfiguration(value: unknown): value is BackupPrivateConfiguration {
  if (!isRecord(value) || !isRecord(value.paths)) return false;
  const paths = value.paths;
  return (
    typeof value.privateRoot === "string" &&
    typeof paths.data === "string" &&
    typeof paths.blob === "string" &&
    typeof paths.journal === "string" &&
    typeof paths.backup === "string" &&
    typeof paths.runtime === "string"
  );
}

function validateConfiguration(
  configuration: unknown,
): asserts configuration is BackupPrivateConfiguration {
  if (
    !isBackupPrivateConfiguration(configuration) ||
    !isCanonicalAbsolutePath(configuration.privateRoot)
  ) {
    throw new BackupServiceError("invalid-configuration", "backup private root is invalid");
  }
  if (configuration.paths.backup !== join(configuration.privateRoot, "backups")) {
    throw new BackupServiceError(
      "invalid-configuration",
      "backup directory is not derived from private root",
    );
  }
  for (const path of [
    configuration.paths.data,
    configuration.paths.blob,
    configuration.paths.journal,
    configuration.paths.runtime,
  ]) {
    if (!isCanonicalAbsolutePath(path) || !isChildOf(configuration.privateRoot, path)) {
      throw new BackupServiceError(
        "invalid-configuration",
        "backup source path is outside private root",
      );
    }
  }
  if (!isCanonicalAbsolutePath(configuration.paths.backup)) {
    throw new BackupServiceError("invalid-configuration", "backup destination root is invalid");
  }
}

function isChildOf(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return (
    remainder.length > 0 &&
    remainder !== ".." &&
    !remainder.startsWith(`..${"/"}`) &&
    !isAbsolute(remainder) &&
    !remainder.includes("\\")
  );
}

/**
 * Derive a destination from the validated private backup directory. A label
 * is one path segment only; callers cannot select an arbitrary absolute path.
 */
export function deriveBackupDestination(
  configuration: BackupPrivateConfiguration,
  label?: string,
): string {
  validateConfiguration(configuration);
  const selected = label ?? `backup-${Date.now()}-${Math.random().toString(16).slice(2, 14)}`;
  if (!BACKUP_LABEL.test(selected) || selected.startsWith(".")) {
    throw new BackupServiceError("invalid-label", "backup label is invalid");
  }
  const destination = join(configuration.paths.backup, selected);
  if (dirname(destination) !== configuration.paths.backup) {
    throw new BackupServiceError(
      "invalid-label",
      "backup label must remain in the backup directory",
    );
  }
  return destination;
}

function labelFromRequest(
  configuration: BackupPrivateConfiguration,
  request: ReportAdminBackupRequest,
): string {
  validateConfiguration(configuration);
  if (dirname(request.destination) !== configuration.paths.backup) {
    throw new BackupServiceError(
      "invalid-label",
      "backup destination is not configured backup storage",
    );
  }
  const label = basename(request.destination);
  if (label.length === 0 || label === "." || label === ".." || !BACKUP_LABEL.test(label)) {
    throw new BackupServiceError("invalid-label", "backup destination label is invalid");
  }
  return label;
}

function manifestBytes(manifest: BackupManifest): number {
  const total = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
  if (!Number.isSafeInteger(total)) {
    throw new BackupServiceError(
      "verification-failed",
      "backup inventory size is not representable",
    );
  }
  return total;
}

function manifestIdentity(manifest: BackupManifest): string {
  const canonical = JSON.stringify({
    version: manifest.version,
    hashAlgorithm: manifest.hashAlgorithm,
    entries: manifest.entries,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function hashFile(
  path: string,
): Promise<Readonly<{ readonly size: number; readonly sha256: string }>> {
  let handle: FileHandle | undefined;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
      throw new BackupServiceError(
        "verification-failed",
        "published backup artifact is not private",
      );
    }
    handle = await open(path, "r");
    const initial = await handle.stat();
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
    if (
      !initial.isFile() ||
      !final.isFile() ||
      final.size !== initial.size ||
      final.size !== size
    ) {
      throw new BackupServiceError(
        "verification-failed",
        "published backup artifact changed during verification",
      );
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    await handle?.close();
  }
}

async function verifyPublishedBackup(
  result: BackupWriterResult,
): Promise<Readonly<{ readonly bytes: number; readonly manifest: BackupManifest }>> {
  const info = await lstat(result.backupPath);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new BackupServiceError(
      "verification-failed",
      "published backup directory is not private",
    );
  }
  if (manifestIdentity(result.manifest) !== result.manifest.manifestSha256) {
    throw new BackupServiceError("verification-failed", "backup manifest digest does not verify");
  }
  const manifestPath = join(result.backupPath, MANIFEST_NAME);
  const manifestInfo = await lstat(manifestPath);
  if (
    manifestInfo.isSymbolicLink() ||
    !manifestInfo.isFile() ||
    (manifestInfo.mode & 0o077) !== 0
  ) {
    throw new BackupServiceError("verification-failed", "published backup manifest is not private");
  }
  const rawManifest = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch (error: unknown) {
    throw new BackupServiceError(
      "verification-failed",
      "published backup manifest is not valid JSON",
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed) || JSON.stringify(parsed) !== JSON.stringify(result.manifest)) {
    throw new BackupServiceError(
      "verification-failed",
      "published backup manifest does not match the verified result",
    );
  }
  for (const entry of result.manifest.entries) {
    const observed = await hashFile(join(result.backupPath, entry.path));
    if (observed.size !== entry.size || observed.sha256 !== entry.sha256) {
      throw new BackupServiceError(
        "verification-failed",
        "published backup artifact digest does not verify",
      );
    }
  }
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true, encoding: "utf8" })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path.slice(`${result.backupPath}/`.length));
      else
        throw new BackupServiceError(
          "verification-failed",
          "published backup contains an invalid entry",
        );
    }
  };
  await visit(result.backupPath);
  const expected = [...result.manifest.entries.map((entry) => entry.path), MANIFEST_NAME].sort();
  if (files.sort().join("\n") !== expected.join("\n")) {
    throw new BackupServiceError(
      "verification-failed",
      "published backup contains an unmanifested artifact",
    );
  }
  return { bytes: manifestBytes(result.manifest), manifest: result.manifest };
}

function operationResult(
  result: BackupWriterResult,
  verified: Readonly<{ readonly bytes: number; readonly manifest: BackupManifest }>,
  now: Date,
): ReportAdminBackupResponse {
  const label = basename(result.backupPath);
  const response = {
    backupId: `backup:${label}`,
    manifest: {
      manifestId: `manifest:${verified.manifest.manifestSha256}`,
      digest: verified.manifest.manifestSha256,
    },
    destination: result.backupPath,
    createdAt: now.toISOString(),
    bytes: verified.bytes,
  };
  return reportAdminBackupResponseSchema.parse(response);
}

/** Create the concrete backup service used by the admin handler composition. */
export function createBackupService(options: BackupServiceOptions): BackupService {
  validateConfiguration(options.configuration);
  const writer = options.writer ?? createBackup;
  const databasePath =
    options.databasePath ?? join(options.configuration.paths.data, "archive.sqlite");
  const metadataPaths = options.configurationMetadataPaths ?? [
    join(options.configuration.privateRoot, "config", "archive-metadata.json"),
  ];
  let tail: Promise<void> = Promise.resolve();
  const run = async (
    request: ReportAdminBackupRequest,
    _context: ReportAdminServiceContext,
  ): Promise<ReportAdminBackupResponse | ReportAdminServiceFailure> => {
    const previous = tail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tail = current;
    await previous;
    try {
      const label = labelFromRequest(options.configuration, request);
      const destination = deriveBackupDestination(options.configuration, label);
      let result: BackupWriterResult;
      try {
        result = await writer({
          privateRoot: options.configuration.privateRoot,
          databasePath,
          blobDirectory: options.configuration.paths.blob,
          journalDirectory: options.configuration.paths.journal,
          configurationMetadataPaths: metadataPaths,
          referencedBlobDigests: options.referencedBlobDigests,
          destination,
          pauseSource: options.pauseSource,
          resumeSource: options.resumeSource,
          beforePublish: options.beforePublish,
        });
      } catch (error: unknown) {
        throw new BackupServiceError("backup-failed", "backup could not be completed", {
          cause: error,
        });
      }
      const verified = await verifyPublishedBackup(result);
      return operationResult(result, verified, options.now?.() ?? new Date());
    } catch (error: unknown) {
      const failure =
        error instanceof BackupServiceError
          ? error
          : new BackupServiceError("verification-failed", "backup result could not be verified", {
              cause: error,
            });
      return {
        kind: "failure",
        reason: failure.message,
        provenance: { code: failure.code },
      };
    } finally {
      release?.();
    }
  };
  return Object.freeze({ backup: run });
}
