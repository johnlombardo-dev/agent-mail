import { createHash } from "node:crypto";
import { lstat, open, unlink, link, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Stable failure categories exposed by the staged-to-canonical transition. */
export type BlobPromotionErrorCode =
  | "invalid-digest"
  | "invalid-size"
  | "stage-missing"
  | "stage-not-regular"
  | "stage-size-mismatch"
  | "stage-digest-mismatch"
  | "canonical-corrupt"
  | "canonical-not-regular"
  | "publication-interrupted"
  | "publication-failed"
  | "cross-device-publication"
  | "directory-sync-failed"
  | "stage-cleanup-failed";

export type BlobPromotionDurabilityStep = "canonical-publication" | "staging-cleanup";

export class BlobPromotionError extends Error {
  readonly code: BlobPromotionErrorCode;
  readonly cause: unknown;
  readonly step: BlobPromotionDurabilityStep | undefined;

  constructor(
    code: BlobPromotionErrorCode,
    message: string,
    cause?: unknown,
    step?: BlobPromotionDurabilityStep,
  ) {
    super(message, { cause });
    this.name = "BlobPromotionError";
    this.code = code;
    this.cause = cause;
    this.step = step;
  }
}

export type BlobPromotionDirectorySync = (
  directory: string,
  step: BlobPromotionDurabilityStep,
) => void | Promise<void>;

export type BlobPromotionOptions = Readonly<{
  /** The closed, fsynced private stage produced by stageBlob. */
  stagingPath: string;
  /** The caller-validated private directory containing canonical blobs. */
  canonicalDirectory: string;
  /** Lowercase SHA-256 digest supplied by the stage result. */
  digest: string;
  /** Exact number of bytes supplied by the stage result. */
  size: number;
  /** Test/operations seam immediately before the no-overwrite publication. */
  beforePublish?: () => void | Promise<void>;
  /** Optional durability seam; production defaults to fsyncing the directory. */
  syncDirectory?: BlobPromotionDirectorySync;
}>;

export type BlobPromotionResult = Readonly<{
  canonicalPath: string;
  digest: string;
  size: number;
  /** True when an already verified canonical inode won the publication race. */
  deduplicated: boolean;
}>;

type Verification = Readonly<{ size: number; digest: string }>;

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function validateDigest(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new BlobPromotionError(
      "invalid-digest",
      "blob digest must be a lowercase SHA-256 hexadecimal string",
    );
  }
  return value;
}

function validateSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BlobPromotionError("invalid-size", "blob size must be a non-negative safe integer");
  }
  return value;
}

function stageVerificationError(error: unknown, expectedSize: number): BlobPromotionError {
  if (isErrorCode(error, "ENOENT")) {
    return new BlobPromotionError("stage-missing", "staged blob does not exist", error);
  }
  if (error instanceof BlobPromotionError) return error;
  return new BlobPromotionError(
    "stage-not-regular",
    `staged blob is not a regular file of ${expectedSize} bytes`,
    error,
  );
}

async function readDigest(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let read = 0;
  while (read < size) {
    const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - read), read);
    if (result.bytesRead === 0) {
      throw new BlobPromotionError("stage-size-mismatch", `staged blob ended before ${size} bytes`);
    }
    hash.update(buffer.subarray(0, result.bytesRead));
    read += result.bytesRead;
  }
  return hash.digest("hex");
}

async function verifyFile(
  path: string,
  expectedDigest: string,
  expectedSize: number,
  kind: "stage" | "canonical",
): Promise<Verification> {
  let handle: FileHandle | undefined;
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) {
      throw new BlobPromotionError(
        kind === "stage" ? "stage-not-regular" : "canonical-not-regular",
        `${kind} blob is not a regular file`,
      );
    }
    handle = await open(path, "r");
    const initial = await handle.stat();
    if (!initial.isFile()) {
      throw new BlobPromotionError(
        kind === "stage" ? "stage-not-regular" : "canonical-not-regular",
        `${kind} blob is not a regular file`,
      );
    }
    if (initial.size !== expectedSize) {
      throw new BlobPromotionError(
        kind === "stage" ? "stage-size-mismatch" : "canonical-corrupt",
        `${kind} blob size does not match the staged size`,
      );
    }
    const digest = await readDigest(handle, expectedSize);
    const final = await handle.stat();
    if (final.size !== expectedSize || digest !== expectedDigest) {
      throw new BlobPromotionError(
        kind === "stage"
          ? digest === expectedDigest
            ? "stage-size-mismatch"
            : "stage-digest-mismatch"
          : "canonical-corrupt",
        `${kind} blob does not match its expected digest and size`,
      );
    }
    return { size: final.size, digest };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) throw error;
    if (error instanceof BlobPromotionError) throw error;
    throw kind === "stage"
      ? stageVerificationError(error, expectedSize)
      : new BlobPromotionError("canonical-corrupt", "canonical blob could not be verified", error);
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(
  directory: string,
  step: BlobPromotionDurabilityStep,
  injectedSync: BlobPromotionDirectorySync | undefined,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    if (injectedSync !== undefined) {
      await injectedSync(directory, step);
    } else {
      handle = await open(directory, "r");
      await handle.sync();
    }
  } catch (error) {
    throw new BlobPromotionError(
      "directory-sync-failed",
      step === "canonical-publication"
        ? "canonical publication directory could not be fsynced"
        : "staging cleanup directory could not be fsynced",
      error,
      step,
    );
  } finally {
    await handle?.close();
  }
}

async function removeStage(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw new BlobPromotionError(
        "stage-cleanup-failed",
        "published stage could not be removed",
        error,
      );
    }
  }
}

async function verifyStageIfPresent(
  stagingPath: string,
  expectedDigest: string,
  expectedSize: number,
): Promise<boolean> {
  try {
    await verifyFile(stagingPath, expectedDigest, expectedSize, "stage");
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw stageVerificationError(error, expectedSize);
  }
}

async function existingCanonical(
  canonicalPath: string,
  expectedDigest: string,
  expectedSize: number,
): Promise<"absent" | "verified"> {
  try {
    await verifyFile(canonicalPath, expectedDigest, expectedSize, "canonical");
    return "verified";
  } catch (error) {
    if (error instanceof BlobPromotionError && error.code === "canonical-corrupt") throw error;
    if (isErrorCode(error, "ENOENT")) return "absent";
    if (error instanceof BlobPromotionError && error.code === "canonical-not-regular") throw error;
    throw error;
  }
}

/**
 * Publish one verified stage using an atomic, no-overwrite hard link. A hard
 * link is a same-filesystem atomic create, so a losing concurrent publisher
 * cannot replace a winner (or a corrupt pre-existing destination).
 */
export async function promoteBlob(options: BlobPromotionOptions): Promise<BlobPromotionResult> {
  const digest = validateDigest(options.digest);
  const size = validateSize(options.size);
  const canonicalPath = join(options.canonicalDirectory, digest);

  if ((await existingCanonical(canonicalPath, digest, size)) === "verified") {
    const stagePresent = await verifyStageIfPresent(options.stagingPath, digest, size);
    if (!stagePresent) return { canonicalPath, digest, size, deduplicated: true };
    await syncDirectory(options.canonicalDirectory, "canonical-publication", options.syncDirectory);
    await removeStage(options.stagingPath);
    await syncDirectory(dirname(options.stagingPath), "staging-cleanup", options.syncDirectory);
    return { canonicalPath, digest, size, deduplicated: true };
  }

  try {
    await verifyFile(options.stagingPath, digest, size, "stage");
  } catch (error) {
    throw stageVerificationError(error, size);
  }

  if (options.beforePublish !== undefined) {
    try {
      await options.beforePublish();
    } catch (error) {
      throw new BlobPromotionError(
        "publication-interrupted",
        "blob publication was interrupted before the atomic operation",
        error,
      );
    }
  }

  try {
    await link(options.stagingPath, canonicalPath);
    await syncDirectory(options.canonicalDirectory, "canonical-publication", options.syncDirectory);
    await removeStage(options.stagingPath);
    await syncDirectory(dirname(options.stagingPath), "staging-cleanup", options.syncDirectory);
    return { canonicalPath, digest, size, deduplicated: false };
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      const result = await existingCanonical(canonicalPath, digest, size);
      if (result === "verified") {
        const stagePresent = await verifyStageIfPresent(options.stagingPath, digest, size);
        if (!stagePresent) return { canonicalPath, digest, size, deduplicated: true };
        await syncDirectory(
          options.canonicalDirectory,
          "canonical-publication",
          options.syncDirectory,
        );
        await removeStage(options.stagingPath);
        await syncDirectory(dirname(options.stagingPath), "staging-cleanup", options.syncDirectory);
        return { canonicalPath, digest, size, deduplicated: true };
      }
    }
    if (isErrorCode(error, "EXDEV")) {
      throw new BlobPromotionError(
        "cross-device-publication",
        "staged and canonical paths are on different filesystems",
        error,
      );
    }
    if (error instanceof BlobPromotionError) throw error;
    throw new BlobPromotionError("publication-failed", "canonical blob publication failed", error);
  }
}
