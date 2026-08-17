import { createHash, randomBytes } from "node:crypto";
import { lstat, open, rename as fsRename, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promoteBlob, type BlobPromotionResult } from "./blob-promotion";

/** Stable failure categories for one corrupt-canonical replacement transition. */
export type BlobCorruptionErrorCode =
  | "invalid-digest"
  | "invalid-size"
  | "canonical-missing"
  | "canonical-not-regular"
  | "canonical-already-verified"
  | "replacement-stage-missing"
  | "replacement-stage-not-regular"
  | "replacement-stage-mismatch"
  | "quarantine-failed"
  | "quarantine-name-collision"
  | "quarantine-race"
  | "quarantine-sync-failed";

export type BlobIntegrityMetadata = Readonly<{
  digest: string;
  size: number;
}>;

/** Details retained even when quarantine or replacement cannot complete. */
export class BlobCorruptionError extends Error {
  readonly code: BlobCorruptionErrorCode;
  readonly cause: unknown;
  readonly canonicalPath: string;
  readonly expected: BlobIntegrityMetadata;
  readonly observed: BlobIntegrityMetadata | undefined;
  readonly quarantinePath: string | undefined;

  constructor(
    code: BlobCorruptionErrorCode,
    message: string,
    details: Readonly<{
      canonicalPath: string;
      expected: BlobIntegrityMetadata;
      observed?: BlobIntegrityMetadata;
      quarantinePath?: string;
      cause?: unknown;
    }>,
  ) {
    super(message, { cause: details.cause });
    this.name = "BlobCorruptionError";
    this.code = code;
    this.cause = details.cause;
    this.canonicalPath = details.canonicalPath;
    this.expected = details.expected;
    this.observed = details.observed;
    this.quarantinePath = details.quarantinePath;
  }
}

export type BlobCorruptionDirectorySync = (
  directory: string,
  step: "corruption-quarantine" | "canonical-publication" | "staging-cleanup",
) => void | Promise<void>;

export type BlobCorruptionReplacementOptions = Readonly<{
  /** The closed, fsynced private stage containing the replacement bytes. */
  stagingPath: string;
  /** The caller-validated private directory containing canonical blobs. */
  canonicalDirectory: string;
  /** Lowercase SHA-256 digest expected for both stage and canonical bytes. */
  digest: string;
  /** Exact byte count expected for both stage and canonical bytes. */
  size: number;
  /** Optional durability seam; production fsyncs the owning directory. */
  syncDirectory?: BlobCorruptionDirectorySync;
  /** Test seam for forcing a rename failure without mutating the source. */
  renamePath?: (source: string, destination: string) => void | Promise<void>;
}>;

export type BlobCorruptionReplacementResult = Readonly<{
  canonicalPath: string;
  quarantinePath: string;
  expected: BlobIntegrityMetadata;
  observed: BlobIntegrityMetadata;
  promotion: BlobPromotionResult;
}>;

type FileInspection = Readonly<{
  metadata: BlobIntegrityMetadata;
  device: number;
  inode: number;
}>;

const transitions = new Map<string, Promise<void>>();

function isFsCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function validateDigest(value: string, canonicalPath: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new BlobCorruptionError("invalid-digest", "blob digest must be a lowercase SHA-256 hexadecimal string", {
      canonicalPath,
      expected: { digest: value, size: 0 },
    });
  }
  return value;
}

function validateSize(value: number, canonicalPath: string, digest: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BlobCorruptionError("invalid-size", "blob size must be a non-negative safe integer", {
      canonicalPath,
      expected: { digest, size: value },
    });
  }
  return value;
}

async function inspectFile(path: string): Promise<FileInspection> {
  let handle: FileHandle | undefined;
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error("not-regular");
    handle = await open(path, "r");
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error("not-regular");

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, offset);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const final = await handle.stat();
    if (final.size !== offset || final.size !== initial.size) throw new Error("changed");
    return {
      metadata: { digest: hash.digest("hex"), size: final.size },
      device: entry.dev,
      inode: entry.ino,
    };
  } finally {
    await handle?.close();
  }
}

function detailsFor(
  canonicalPath: string,
  expected: BlobIntegrityMetadata,
  observed?: BlobIntegrityMetadata,
  quarantinePath?: string,
  cause?: unknown,
): Readonly<{
  canonicalPath: string;
  expected: BlobIntegrityMetadata;
  observed?: BlobIntegrityMetadata;
  quarantinePath?: string;
  cause?: unknown;
}> {
  return { canonicalPath, expected, observed, quarantinePath, cause };
}

async function inspectCanonical(
  canonicalPath: string,
  expected: BlobIntegrityMetadata,
): Promise<FileInspection> {
  try {
    return await inspectFile(canonicalPath);
  } catch (error) {
    if (isFsCode(error, "ENOENT")) {
      throw new BlobCorruptionError("canonical-missing", "canonical blob does not exist", {
        canonicalPath,
        expected,
        cause: error,
      });
    }
    if (error instanceof Error && error.message === "not-regular") {
      throw new BlobCorruptionError("canonical-not-regular", "canonical blob is not a regular file", {
        canonicalPath,
        expected,
        cause: error,
      });
    }
    throw new BlobCorruptionError("quarantine-race", "canonical blob changed while it was inspected", {
      canonicalPath,
      expected,
      cause: error,
    });
  }
}

async function validateReplacementStage(
  stagingPath: string,
  canonicalPath: string,
  expected: BlobIntegrityMetadata,
): Promise<void> {
  let inspection: FileInspection;
  try {
    inspection = await inspectFile(stagingPath);
  } catch (error) {
    if (isFsCode(error, "ENOENT")) {
      throw new BlobCorruptionError("replacement-stage-missing", "replacement stage does not exist", {
        canonicalPath,
        expected,
        cause: error,
      });
    }
    if (error instanceof Error && error.message === "not-regular") {
      throw new BlobCorruptionError(
        "replacement-stage-not-regular",
        "replacement stage is not a regular file",
        { canonicalPath, expected, cause: error },
      );
    }
    throw new BlobCorruptionError("replacement-stage-mismatch", "replacement stage could not be verified", {
      canonicalPath,
      expected,
      cause: error,
    });
  }
  if (
    inspection.metadata.size !== expected.size ||
    inspection.metadata.digest !== expected.digest
  ) {
    throw new BlobCorruptionError(
      "replacement-stage-mismatch",
      "replacement stage does not match its expected digest and size",
      { canonicalPath, expected, observed: inspection.metadata },
    );
  }
}

async function syncOwningDirectory(
  directory: string,
  expected: BlobIntegrityMetadata,
  canonicalPath: string,
  quarantinePath: string,
  syncDirectory: BlobCorruptionDirectorySync | undefined,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    if (syncDirectory !== undefined) {
      await syncDirectory(directory, "corruption-quarantine");
      return;
    }
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    throw new BlobCorruptionError(
      "quarantine-sync-failed",
      "corruption quarantine directory could not be fsynced",
      detailsFor(canonicalPath, expected, undefined, quarantinePath, error),
    );
  } finally {
    await handle?.close();
  }
}

function quarantinePathFor(canonicalDirectory: string, digest: string): string {
  return join(canonicalDirectory, `.quarantine-v1-${digest}-${randomBytes(16).toString("hex")}.blob`);
}

async function withTransitionLock<T>(canonicalPath: string, action: () => Promise<T>): Promise<T> {
  const previous = transitions.get(canonicalPath) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  transitions.set(canonicalPath, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (transitions.get(canonicalPath) === current) transitions.delete(canonicalPath);
  }
}

/**
 * Verify one corrupt canonical path, atomically quarantine its bytes, and
 * promote one verified replacement stage. The quarantine artifact is never
 * removed by this transition.
 */
export async function quarantineAndReplaceBlob(
  options: BlobCorruptionReplacementOptions,
): Promise<BlobCorruptionReplacementResult> {
  const canonicalPath = join(options.canonicalDirectory, options.digest);
  const digest = validateDigest(options.digest, canonicalPath);
  const size = validateSize(options.size, canonicalPath, digest);
  const expected = { digest, size } satisfies BlobIntegrityMetadata;
  if (resolve(options.stagingPath) === resolve(canonicalPath)) {
    throw new BlobCorruptionError("quarantine-race", "replacement stage must not be the canonical path", {
      canonicalPath,
      expected,
    });
  }

  return withTransitionLock(canonicalPath, async () => {
    await validateReplacementStage(options.stagingPath, canonicalPath, expected);
    const canonical = await inspectCanonical(canonicalPath, expected);
    if (
      canonical.metadata.digest === expected.digest &&
      canonical.metadata.size === expected.size
    ) {
      throw new BlobCorruptionError(
        "canonical-already-verified",
        "canonical blob already matches its expected digest and size",
        { canonicalPath, expected, observed: canonical.metadata },
      );
    }

    const quarantinePath = quarantinePathFor(options.canonicalDirectory, expected.digest);
    const renamePath = options.renamePath ?? fsRename;
    try {
      await renamePath(canonicalPath, quarantinePath);
    } catch (error) {
      throw new BlobCorruptionError(
        isFsCode(error, "EEXIST") ? "quarantine-name-collision" : "quarantine-failed",
        "corrupt canonical blob could not be quarantined",
        detailsFor(canonicalPath, expected, canonical.metadata, quarantinePath, error),
      );
    }

    let moved: FileInspection;
    try {
      moved = await inspectFile(quarantinePath);
    } catch (error) {
      throw new BlobCorruptionError(
        "quarantine-race",
        "quarantined canonical blob could not be verified",
        detailsFor(canonicalPath, expected, canonical.metadata, quarantinePath, error),
      );
    }
    if (
      moved.device !== canonical.device ||
      moved.inode !== canonical.inode ||
      moved.metadata.digest !== canonical.metadata.digest ||
      moved.metadata.size !== canonical.metadata.size
    ) {
      throw new BlobCorruptionError(
        "quarantine-race",
        "canonical blob changed during quarantine",
        detailsFor(canonicalPath, expected, moved.metadata, quarantinePath),
      );
    }

    await syncOwningDirectory(
      dirname(canonicalPath),
      expected,
      canonicalPath,
      quarantinePath,
      options.syncDirectory,
    );

    try {
      await lstat(canonicalPath);
    } catch (error) {
      if (!isFsCode(error, "ENOENT")) {
        throw new BlobCorruptionError(
          "quarantine-race",
          "canonical path changed before replacement promotion",
          detailsFor(canonicalPath, expected, canonical.metadata, quarantinePath, error),
        );
      }
    }
    const promotion = await promoteBlob({
      stagingPath: options.stagingPath,
      canonicalDirectory: options.canonicalDirectory,
      digest: expected.digest,
      size: expected.size,
      syncDirectory: options.syncDirectory,
    });
    return { canonicalPath, quarantinePath, expected, observed: canonical.metadata, promotion };
  });
}

/** Descriptive alias for callers that name the corrupt-canonical transition. */
export const replaceCorruptCanonicalBlob = quarantineAndReplaceBlob;
