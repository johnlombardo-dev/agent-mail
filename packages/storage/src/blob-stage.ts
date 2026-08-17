import { createHash, randomBytes } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/** The default upper bound for one staged blob (256 MiB). */
export const DEFAULT_MAX_STAGE_BYTES = 256 * 1024 * 1024;

export type BlobChunkSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

export type BlobStageOwner = Readonly<{
  pid: number;
  processStartIdentity: string;
}>;

export type BlobStageOptions = Readonly<{
  /** A caller-validated, private directory reserved for staging blobs. */
  stagingDirectory: string;
  /** The process identity captured by the caller; raw identity is never persisted. */
  owner: BlobStageOwner;
  source: BlobChunkSource;
  maxBytes?: number;
  signal?: AbortSignal;
}>;

export type BlobStageFilenameMetadata = Readonly<{
  version: 1;
  pid: number;
  identityDigest: string;
  randomStageIdentity: string;
}>;

export type BlobStageResult = Readonly<{
  /** The exclusive temporary path. It is closed and durable when returned. */
  path: string;
  /** Lowercase SHA-256 digest of the exact staged bytes. */
  digest: string;
  size: number;
}>;

type ChunkIterator = AsyncIterator<Uint8Array>;

const STAGE_FILENAME =
  /^\.stage-v(1)-pid([1-9]\d*)-owner([0-9a-f]{64})-random([0-9a-f]{64})\.tmp$/u;
const MAX_PROCESS_START_IDENTITY_LENGTH = 4096;

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function validateOwner(value: unknown): BlobStageOwner {
  if (!isPlainRecord(value)) throw new TypeError("blob stage owner must be a plain object");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("pid") || !keys.includes("processStartIdentity")) {
    throw new TypeError("blob stage owner has missing or unknown fields");
  }
  const pid = value.pid;
  const processStartIdentity = value.processStartIdentity;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("blob stage owner pid must be a positive safe integer");
  }
  if (
    typeof processStartIdentity !== "string" ||
    processStartIdentity.length === 0 ||
    processStartIdentity.length > MAX_PROCESS_START_IDENTITY_LENGTH ||
    processStartIdentity.trim() !== processStartIdentity ||
    hasControlCharacters(processStartIdentity)
  ) {
    throw new TypeError("blob stage owner processStartIdentity is invalid");
  }
  return { pid, processStartIdentity };
}

function ownerIdentityDigest(processStartIdentity: string): string {
  return createHash("sha256").update(processStartIdentity).digest("hex");
}

/** Parse one exact recognized stage basename; unknown files return undefined. */
export function parseBlobStageFilename(value: unknown): BlobStageFilenameMetadata | undefined {
  if (typeof value !== "string") return undefined;
  const match = STAGE_FILENAME.exec(value);
  if (match === null) return undefined;
  const [, versionText, pidText, identityDigest, randomStageIdentity] = match;
  if (
    versionText === undefined ||
    pidText === undefined ||
    identityDigest === undefined ||
    randomStageIdentity === undefined
  ) {
    return undefined;
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || String(pid) !== pidText) return undefined;
  if (versionText !== "1") return undefined;
  return { version: 1, pid, identityDigest, randomStageIdentity };
}

export function isBlobStageFilename(value: unknown): value is string {
  return parseBlobStageFilename(value) !== undefined;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Blob staging was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function validateMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_MAX_STAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  return maxBytes;
}

function iteratorFor(source: BlobChunkSource): ChunkIterator {
  const iteratorFactory = source[Symbol.asyncIterator];
  if (typeof iteratorFactory !== "function") {
    throw new TypeError("blob source must be async iterable or a readable stream");
  }
  return iteratorFactory.call(source);
}

async function nextWithAbort(
  iterator: ChunkIterator,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<Uint8Array>> {
  throwIfAborted(signal);
  const next = iterator.next();
  if (signal === undefined) return next;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([next, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function mergeErrors(primary: unknown, cleanup: unknown): unknown {
  if (cleanup === undefined) return primary;
  if (primary === undefined) return cleanup;
  return new AggregateError([primary, cleanup], "blob staging and cleanup both failed");
}

async function createExclusiveStagePath(
  directory: string,
  owner: BlobStageOwner,
): Promise<{
  readonly path: string;
  readonly handle: FileHandle;
}> {
  const identityDigest = ownerIdentityDigest(owner.processStartIdentity);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const randomStageIdentity = randomBytes(32).toString("hex");
    const filename = `.stage-v1-pid${owner.pid}-owner${identityDigest}-random${randomStageIdentity}.tmp`;
    const path = join(directory, filename);
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.chmod(0o600);
        return { path, handle };
      } catch (error) {
        let cleanupFailure: unknown;
        try {
          await handle.close();
        } catch (closeError) {
          cleanupFailure = closeError;
        }
        try {
          await unlink(path);
        } catch (unlinkError) {
          cleanupFailure = mergeErrors(cleanupFailure, unlinkError);
        }
        throw mergeErrors(error, cleanupFailure) ?? new Error("blob stage setup failed");
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("could not create an exclusive blob staging path");
}

async function writeChunk(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("blob staging write made no progress");
    offset += bytesWritten;
  }
}

/**
 * Stream one validated blob into a private staging directory.
 *
 * The stage is never reused or promoted here. The returned path is only
 * observable after all writes have completed, fsync has succeeded, and the
 * file handle has been closed. Any failure removes the partial file.
 */
export async function stageBlob(options: BlobStageOptions): Promise<BlobStageResult> {
  const owner = validateOwner(options.owner);
  const maxBytes = validateMaxBytes(options.maxBytes);
  const hash = new Bun.CryptoHasher("sha256");
  const { path, handle } = await createExclusiveStagePath(options.stagingDirectory, owner);
  let fileHandle: FileHandle | undefined = handle;
  let iterator: ChunkIterator | undefined;
  let sourceFinished = false;
  let failed = false;
  let failure: unknown;
  let size = 0;

  try {
    throwIfAborted(options.signal);
    iterator = iteratorFor(options.source);
    while (true) {
      const item = await nextWithAbort(iterator, options.signal);
      if (item.done) {
        sourceFinished = true;
        break;
      }
      throwIfAborted(options.signal);
      if (!(item.value instanceof Uint8Array)) {
        throw new TypeError("blob source yielded a non-byte chunk");
      }
      if (item.value.byteLength > maxBytes - size) {
        throw new RangeError(`blob exceeds maxBytes (${maxBytes})`);
      }
      await writeChunk(handle, item.value);
      hash.update(item.value);
      size += item.value.byteLength;
    }
    await handle.sync();
    await handle.close();
    fileHandle = undefined;
  } catch (error) {
    failed = true;
    failure = error;
  }

  let cleanupFailure: unknown;
  if (!sourceFinished && iterator?.return !== undefined) {
    try {
      const sourceCleanup = iterator.return();
      if (options.signal?.aborted === true) {
        // An abort must not leave file cleanup waiting on an uncooperative
        // source. The iterator still receives cancellation, and any late
        // rejection is observed so it cannot become an unhandled rejection.
        void Promise.resolve(sourceCleanup).catch(() => undefined);
      } else {
        await sourceCleanup;
      }
    } catch (error) {
      cleanupFailure = mergeErrors(cleanupFailure, error);
    }
  }
  if (fileHandle !== undefined) {
    try {
      await fileHandle.close();
      fileHandle = undefined;
    } catch (error) {
      failed = true;
      failure = mergeErrors(failure, error);
    }
  }
  if (failed) {
    try {
      await unlink(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        cleanupFailure = mergeErrors(cleanupFailure, error);
      }
    }
    failure = mergeErrors(failure, cleanupFailure);
    throw failure ?? new Error("blob staging failed");
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;

  return { path, digest: hash.digest("hex"), size };
}
