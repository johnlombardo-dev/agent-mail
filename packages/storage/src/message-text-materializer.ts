import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { parseMessageId, type MessageId } from "@agent-mail/core";
import { parseStagedEml } from "../../imap/src/mime-parser";
import { parseBlobStageFilename, stageBlob, type BlobStageOwner } from "./blob-stage";
import { canonicalJsonStringBytes, REPORT_PARSER_ID } from "./report-creation-repository";
import type { Database } from "bun:sqlite";

export type MessageTextMaterializerState =
  | "checking-existing"
  | "verifying-raw"
  | "staging-exact-bytes"
  | "parsing-production-mime"
  | "publishing-projection"
  | "cleaning-stage"
  | "available"
  | "failed-clean";

export class MessageTextMaterializerError extends Error {
  readonly state: MessageTextMaterializerState;

  constructor(state: MessageTextMaterializerState, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MessageTextMaterializerError";
    this.state = state;
  }
}

export type MessageTextMaterializerOptions = Readonly<{
  readonly database: Database;
  readonly canonicalDirectory: string;
  readonly stagingDirectory: string;
  readonly owner: BlobStageOwner;
  readonly now?: () => Date;
}>;

type RawReference = Readonly<{ readonly digest: string; readonly size: number }>;

type ProjectionRecord = Readonly<{
  readonly text: string;
  readonly digest: string;
  readonly bytes: number;
  readonly rawDigest: string;
}>;

const activeStagePaths = new Set<string>();
const stageBarriers = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error("row is invalid");
  return value;
}

function message(value: MessageId): MessageId {
  const parsed = parseMessageId(value);
  if (!/^message:[0-9a-f]{64}$/u.test(parsed)) throw new Error("message identity is invalid");
  return parsed;
}

function rawReference(database: Database, messageId: MessageId): RawReference {
  const row = database
    .query(
      "SELECT blob_id, size FROM message_blob_references WHERE message_id = ? AND kind = 'raw-eml' AND ordinal = 1;",
    )
    .get(messageId);
  if (row === null)
    throw new MessageTextMaterializerError("verifying-raw", "raw message source is unavailable");
  const value = record(row);
  if (
    typeof value.blob_id !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.blob_id) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  )
    throw new MessageTextMaterializerError("verifying-raw", "raw message source is invalid");
  return { digest: value.blob_id, size: value.size };
}

function projectionRecord(value: unknown): ProjectionRecord {
  const row = record(value);
  if (!(row.normalized_text_json instanceof Uint8Array))
    throw new Error("projection text is invalid");
  const encoded = new Uint8Array(row.normalized_text_json);
  let serialized: string;
  let text: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "string" || JSON.stringify(parsed) !== serialized)
      throw new Error("non-canonical projection");
    text = parsed;
  } catch (error: unknown) {
    throw new Error("projection text is not canonical", { cause: error });
  }
  const digest = createHash("sha256").update(encoded).digest("hex");
  if (
    row.normalized_text_sha256 !== digest ||
    row.parser_id !== "mailparser:3.9.15" ||
    row.normalized_text_utf8_bytes !== Buffer.byteLength(text, "utf8") ||
    typeof row.raw_eml_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.raw_eml_sha256)
  )
    throw new Error("projection integrity is invalid");
  return { text, digest, bytes: Buffer.byteLength(text, "utf8"), rawDigest: row.raw_eml_sha256 };
}

async function removeOwnedStaleStages(options: MessageTextMaterializerOptions): Promise<void> {
  const ownerDigest = createHash("sha256").update(options.owner.processStartIdentity).digest("hex");
  let names: readonly string[];
  try {
    names = await readdir(options.stagingDirectory);
  } catch (error: unknown) {
    throw new MessageTextMaterializerError(
      "checking-existing",
      "materializer staging directory is unavailable",
      { cause: error },
    );
  }
  for (const name of names) {
    const parsed = parseBlobStageFilename(name);
    if (
      parsed === undefined ||
      parsed.pid !== options.owner.pid ||
      parsed.identityDigest !== ownerDigest
    )
      continue;
    const path = join(options.stagingDirectory, name);
    if (activeStagePaths.has(path)) continue;
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
        throw new MessageTextMaterializerError(
          "checking-existing",
          "owned stale stage cleanup failed",
          { cause: error },
        );
    }
  }
}

function stageBarrierKey(options: MessageTextMaterializerOptions): string {
  const ownerDigest = createHash("sha256").update(options.owner.processStartIdentity).digest("hex");
  return `${options.stagingDirectory}\0${options.owner.pid}\0${ownerDigest}`;
}

async function withStageBarrier<T>(
  options: MessageTextMaterializerOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const key = stageBarrierKey(options);
  const previous = stageBarriers.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  stageBarriers.set(key, current);
  if (previous !== undefined) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stageBarriers.get(key) === current) stageBarriers.delete(key);
  }
}

async function verifyAndStage(
  options: MessageTextMaterializerOptions,
  reference: RawReference,
): Promise<Readonly<{ path: string; digest: string; size: number }>> {
  return withStageBarrier(options, async () => {
    await removeOwnedStaleStages(options);
    const rawPath = join(options.canonicalDirectory, reference.digest);
    let entry;
    try {
      entry = await lstat(rawPath);
    } catch (error: unknown) {
      throw new MessageTextMaterializerError("verifying-raw", "raw message source is unavailable", {
        cause: error,
      });
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== reference.size)
      throw new MessageTextMaterializerError(
        "verifying-raw",
        "raw message source is not a verified regular file",
      );
    let handle: FileHandle | undefined;
    let verified = false;
    try {
      // Keep the verified descriptor for the copy. O_NOFOLLOW closes the
      // lstat-to-open symlink substitution window; staging never re-resolves
      // the untrusted canonical path after this point.
      handle = await open(rawPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < reference.size) {
        const result = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, reference.size - offset),
          offset,
        );
        if (result.bytesRead === 0) throw new Error("raw source ended early");
        hash.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
      }
      const final = await handle.stat();
      if (
        !final.isFile() ||
        final.size !== reference.size ||
        hash.digest("hex") !== reference.digest
      )
        throw new Error("raw source digest mismatch");
      verified = true;
    } catch (error: unknown) {
      throw new MessageTextMaterializerError(
        "verifying-raw",
        "raw message source failed verification",
        { cause: error },
      );
    } finally {
      // The descriptor remains open through staging below. Verification errors
      // close it here; successful verification transfers ownership to staging.
      if (handle !== undefined && !verified) await handle.close();
    }
    try {
      if (handle === undefined) throw new Error("raw source descriptor is unavailable");
      const staged = await stageBlob({
        stagingDirectory: options.stagingDirectory,
        owner: options.owner,
        source: readHandleExactly(handle, reference.size),
        maxBytes: reference.size,
      });
      activeStagePaths.add(staged.path);
      return staged;
    } catch (error: unknown) {
      throw new MessageTextMaterializerError("staging-exact-bytes", "raw message staging failed", {
        cause: error,
      });
    } finally {
      await handle?.close();
    }
  });
}

async function* readHandleExactly(handle: FileHandle, size: number): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
    if (result.bytesRead === 0) throw new Error("raw source ended early");
    offset += result.bytesRead;
    yield new Uint8Array(buffer.subarray(0, result.bytesRead));
  }
  const final = await handle.stat();
  if (!final.isFile() || final.size !== size) throw new Error("raw source changed during staging");
}

async function cleanupStage(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  try {
    await unlink(path);
    activeStagePaths.delete(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      activeStagePaths.delete(path);
      return;
    }
    throw error;
  }
}

function canonicalInstant(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("materializer clock is invalid");
  return value.toISOString();
}

/** Create a restartable, per-message, owner-staged legacy projection adapter. */
export function createLegacyNormalizedTextMaterializer(
  options: MessageTextMaterializerOptions,
): (messageId: MessageId) => Promise<void> {
  const active = new Map<string, Promise<void>>();
  const now = options.now ?? (() => new Date());
  return (input: MessageId): Promise<void> => {
    const messageId = message(input);
    const existing = active.get(messageId);
    if (existing !== undefined) return existing;
    const run = (async (): Promise<void> => {
      let state: MessageTextMaterializerState = "checking-existing";
      let staged: Readonly<{ path: string; digest: string; size: number }> | undefined;
      try {
        const reference = rawReference(options.database, messageId);
        const current = options.database
          .query(
            "SELECT normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id FROM message_text_projections WHERE message_id = ? AND projection_version = 1;",
          )
          .get(messageId);
        if (current !== null) {
          if (projectionRecord(current).rawDigest !== reference.digest)
            throw new Error("existing projection raw digest differs");
          return;
        }
        state = "verifying-raw";
        state = "staging-exact-bytes";
        staged = await verifyAndStage(options, reference);
        state = "parsing-production-mime";
        const parsed = await parseStagedEml({
          sourcePath: staged.path,
          limits: {
            maxDecodedTextBytes: 8 * 1024 * 1024,
          },
        });
        state = "publishing-projection";
        const textJson = canonicalJsonStringBytes(parsed.normalizedText);
        const textDigest = createHash("sha256").update(textJson).digest("hex");
        options.database.exec("BEGIN IMMEDIATE;");
        let committed = false;
        try {
          const winner = options.database
            .query(
              "SELECT normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id FROM message_text_projections WHERE message_id = ? AND projection_version = 1;",
            )
            .get(messageId);
          if (winner === null) {
            options.database
              .query(
                "INSERT INTO message_text_projections (message_id, projection_version, normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id, materialized_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
              )
              .run(
                messageId,
                1,
                textJson,
                textDigest,
                Buffer.byteLength(parsed.normalizedText, "utf8"),
                reference.digest,
                REPORT_PARSER_ID,
                canonicalInstant(now),
              );
          } else {
            const winnerRecord = projectionRecord(winner);
            if (
              winnerRecord.rawDigest !== reference.digest ||
              winnerRecord.digest !== textDigest ||
              winnerRecord.bytes !== Buffer.byteLength(parsed.normalizedText, "utf8") ||
              winnerRecord.text !== parsed.normalizedText
            )
              throw new Error("projection winner differs");
          }
          options.database.exec("COMMIT;");
          committed = true;
        } finally {
          if (!committed) {
            try {
              options.database.exec("ROLLBACK;");
            } catch {
              /* preserve publication failure */
            }
          }
        }
        const readback = options.database
          .query(
            "SELECT normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id FROM message_text_projections WHERE message_id = ? AND projection_version = 1;",
          )
          .get(messageId);
        if (readback === null || projectionRecord(readback).rawDigest !== reference.digest)
          throw new Error("materialized projection read-back failed");
        state = "cleaning-stage";
      } catch (error: unknown) {
        try {
          await cleanupStage(staged?.path);
        } catch (cleanupError: unknown) {
          throw new MessageTextMaterializerError("failed-clean", "materializer cleanup failed", {
            cause: new AggregateError([error, cleanupError]),
          });
        }
        if (error instanceof MessageTextMaterializerError) throw error;
        throw new MessageTextMaterializerError(
          state === "cleaning-stage" ? "failed-clean" : state,
          "legacy normalized text materialization failed",
          { cause: error },
        );
      }
      try {
        await cleanupStage(staged?.path);
      } catch (error: unknown) {
        throw new MessageTextMaterializerError("failed-clean", "materializer cleanup failed", {
          cause: error,
        });
      }
    })();
    active.set(messageId, run);
    void run.then(
      () => {
        if (active.get(messageId) === run) active.delete(messageId);
      },
      () => {
        if (active.get(messageId) === run) active.delete(messageId);
      },
    );
    return run;
  };
}
