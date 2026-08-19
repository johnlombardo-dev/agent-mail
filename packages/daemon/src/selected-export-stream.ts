import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import {
  correlationIdSchema,
  publicErrorEnvelopeSchema,
  reportAdminExportRequestSchema,
  type ReportAdminExportSelection,
} from "@agent-mail/contracts";
import { parseAccountId, parseMessageId, type AccountId, type MessageId } from "@agent-mail/core";
import type { Database } from "bun:sqlite";
import { selectSearchCandidates } from "../../storage/src/search-candidate-repository";
import { compileSearchQuery } from "../../storage/src/search-query-compiler";
import {
  digestNormalizedSearchQuery,
  type SearchCursorIntegrityCodec,
} from "../../storage/src/search-cursor";
import { compileStructuredFilters } from "../../storage/src/structured-filter-compiler";
import {
  EXPORT_STREAM_VERSION,
  MAX_EXPORT_CONTENT_BYTES,
  encodeExportFrameChunks,
  type ExportFrame,
} from "./export-stream-framing";
import {
  admitHttpRequest,
  authenticatedTransportContext,
  createRegistryTransportAdapter,
  httpErrorRegistry,
  publicOperationRegistry,
  type HttpCredentialAuthenticator,
  type OperationHandlerMap,
  type PrivateHttpLogger,
} from "./http";

const PAGE_SIZE = 25;
const MAX_IDENTITY_SET = 1_000;
const MAX_RECORD_CONTENT_BYTES = MAX_EXPORT_CONTENT_BYTES;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export type SelectedExportBlob = Readonly<{
  readonly kind: "raw" | "attachment";
  readonly blobId: string;
  readonly size: number;
  readonly filename?: string | null;
  readonly contentType?: string;
}>;

export type SelectedExportRecord = Readonly<{
  readonly messageId: MessageId;
  readonly placementId: string;
  readonly metadata: Uint8Array;
  readonly blobs: readonly SelectedExportBlob[];
}>;

export type SelectedExportPage = Readonly<{
  readonly records: readonly SelectedExportRecord[];
  readonly nextCursor: string | null;
  readonly queryDigest: string;
  /** The source-owned page sequence makes cursor progress observable without a full seen set. */
  readonly pageNumber: number;
}>;

export type SelectedExportSource = Readonly<{
  readonly page: (
    input: Readonly<{
      readonly selection: ReportAdminExportSelection;
      readonly cursor: string | null;
      readonly pageNumber: number;
      readonly signal: AbortSignal;
    }>,
  ) => Promise<SelectedExportPage>;
  /** Reauthorization is deliberately performed after each page read. */
  readonly authorize: (record: SelectedExportRecord) => Promise<boolean>;
  readonly readBlob?: (blob: SelectedExportBlob, signal: AbortSignal) => AsyncIterable<Uint8Array>;
}>;

export type SelectedExportStreamOptions = Readonly<{
  readonly source: SelectedExportSource;
  readonly authenticate?: HttpCredentialAuthenticator;
  readonly logger?: PrivateHttpLogger;
  readonly maxRequestBodyBytes?: number;
}>;

export class SelectedExportError extends Error {
  readonly code:
    | "empty_selection"
    | "unauthorized_selection"
    | "tombstoned_selection"
    | "invalid_page"
    | "content_unavailable"
    | "cancelled";

  constructor(
    code: SelectedExportError["code"],
    message = "selected export could not be streamed",
  ) {
    super(message);
    this.name = "SelectedExportError";
    this.code = code;
  }
}

function digestOf(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function selectionDigest(selection: ReportAdminExportSelection): string {
  return digestOf(new TextEncoder().encode(JSON.stringify(selection)));
}

function placementId(
  accountId: string,
  mailboxId: string,
  uidValidity: number,
  uid: number,
): string {
  return `placement:${accountId}:${mailboxId}:${uidValidity}:${uid}`;
}

function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function correlationIdFrom(request: Request): string {
  const supplied = correlationIdSchema.safeParse(request.headers.get("x-correlation-id"));
  return supplied.success ? supplied.data : `request:${crypto.randomUUID()}`;
}

function internalErrorBody(correlationId: string): unknown {
  return publicErrorEnvelopeSchema.parse({
    code: "internal_error",
    message: "internal server error",
    correlationId,
    details: {},
  });
}

function metadataBytes(
  record: Readonly<{ messageId: string; placementId: string; subject: string | null }>,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

function streamFrame(
  kind: ExportFrame["kind"],
  record: SelectedExportRecord,
  content: Uint8Array,
  queryDigest: string,
): ExportFrame {
  const contentDigest = digestOf(content);
  return {
    version: EXPORT_STREAM_VERSION,
    kind,
    attribution: {
      messageId: record.messageId,
      placementId: record.placementId,
      selectionQueryDigest: queryDigest,
      contentDigest,
      contentSize: content.byteLength,
      provenance: {
        source: "selected-export",
        selectionQueryDigest: queryDigest,
      },
    },
    content,
  };
}

async function collectBlob(
  blob: SelectedExportBlob,
  source: SelectedExportSource,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_EXPORT_CONTENT_BYTES) {
    throw new SelectedExportError("content_unavailable");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (source.readBlob === undefined) throw new SelectedExportError("content_unavailable");
  const reader = source.readBlob(blob, signal)[Symbol.asyncIterator]();
  let readerDone = false;
  let pendingNext: Promise<IteratorResult<Uint8Array>> | undefined;
  let readerReturn: Promise<void> | undefined;
  let rejectAbort: ((reason: SelectedExportError) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const closeReader = (): Promise<void> => {
    readerReturn ??= (async (): Promise<void> => {
      try {
        await reader.return?.(undefined);
      } catch {
        // Cleanup remains idempotent even when the source rejects on abort.
      }
    })();
    return readerReturn;
  };
  const onAbort = (): void => {
    rejectAbort?.(new SelectedExportError("cancelled"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      pendingNext = reader.next();
      const result = await Promise.race([pendingNext, abortPromise]);
      pendingNext = undefined;
      if (result.done) {
        readerDone = true;
        break;
      }
      const chunk = result.value;
      if (isCancelled(signal)) throw new SelectedExportError("cancelled");
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        throw new SelectedExportError("content_unavailable");
      }
      total += chunk.byteLength;
      if (total > MAX_EXPORT_CONTENT_BYTES || total > blob.size) {
        throw new SelectedExportError("content_unavailable");
      }
      chunks.push(chunk.slice());
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!readerDone) {
      if (pendingNext !== undefined) {
        try {
          await pendingNext;
        } catch {
          // The aborted source may reject its in-flight read before closure.
        }
        pendingNext = undefined;
      }
      await closeReader();
    }
  }
  if (total !== blob.size) throw new SelectedExportError("content_unavailable");
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const expected = blob.blobId.startsWith("blob:") ? blob.blobId.slice(5) : blob.blobId;
  if (!SHA256.test(expected) || digestOf(content) !== expected) {
    throw new SelectedExportError("content_unavailable");
  }
  return content;
}

async function* fileBlobReader(
  canonicalDirectory: string,
  blob: SelectedExportBlob,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const digest = blob.blobId.startsWith("blob:") ? blob.blobId.slice(5) : blob.blobId;
  if (!SHA256.test(digest)) throw new SelectedExportError("content_unavailable");
  const handle = await open(join(canonicalDirectory, digest), "r");
  try {
    let position = 0;
    while (position < blob.size) {
      if (isCancelled(signal)) throw new SelectedExportError("cancelled");
      const length = Math.min(READ_CHUNK_BYTES, blob.size - position);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, position);
      if (isCancelled(signal)) throw new SelectedExportError("cancelled");
      if (result.bytesRead <= 0) throw new SelectedExportError("content_unavailable");
      position += result.bytesRead;
      yield buffer.subarray(0, result.bytesRead);
    }
  } finally {
    await handle.close();
  }
}

function encodeFrames(
  record: SelectedExportRecord,
  queryDigest: string,
  content: readonly Readonly<{
    readonly kind: "metadata" | "raw" | "attachment";
    readonly bytes: Uint8Array;
  }>[],
): readonly Uint8Array[] {
  return content.flatMap((part) => [
    ...encodeExportFrameChunks(streamFrame(part.kind, record, part.bytes, queryDigest)),
  ]);
}

/**
 * Build the bounded AMEX byte stream. The generator never retains more than
 * one selected record and one bounded content blob at a time.
 */
export async function* streamSelectedExport(
  selection: ReportAdminExportSelection,
  source: SelectedExportSource,
  signal: AbortSignal = new AbortController().signal,
): AsyncGenerator<Uint8Array> {
  if (selection.kind === "identities" && selection.messageIds.length === 0) {
    throw new SelectedExportError("empty_selection");
  }
  if (selection.kind === "identities" && selection.messageIds.length > MAX_IDENTITY_SET) {
    throw new SelectedExportError("invalid_page");
  }
  let cursor: string | null = null;
  let queryDigest: string | undefined;
  let emittedRecords = 0;
  let pageNumber = 0;
  do {
    if (isCancelled(signal)) throw new SelectedExportError("cancelled");
    const page = await source.page({ selection, cursor, pageNumber, signal });
    if (page.records.length > PAGE_SIZE) throw new SelectedExportError("invalid_page");
    if (page.pageNumber !== pageNumber) throw new SelectedExportError("invalid_page");
    queryDigest ??= page.queryDigest;
    if (queryDigest !== page.queryDigest) throw new SelectedExportError("invalid_page");
    for (const record of page.records) {
      if (isCancelled(signal)) throw new SelectedExportError("cancelled");
      if (!(await source.authorize(record))) {
        throw new SelectedExportError("unauthorized_selection");
      }
      const metadata = record.metadata;
      if (metadata.byteLength > MAX_EXPORT_CONTENT_BYTES)
        throw new SelectedExportError("invalid_page");
      const parts: Array<
        Readonly<{ readonly kind: "metadata" | "raw" | "attachment"; readonly bytes: Uint8Array }>
      > = [{ kind: "metadata", bytes: metadata }];
      let recordBytes = metadata.byteLength;
      for (const blob of record.blobs) {
        const bytes = await collectBlob(blob, source, signal);
        recordBytes += bytes.byteLength;
        if (recordBytes > MAX_RECORD_CONTENT_BYTES)
          throw new SelectedExportError("content_unavailable");
        parts.push({ kind: blob.kind, bytes });
      }
      for (const chunk of encodeFrames(record, queryDigest, parts)) {
        if (isCancelled(signal)) throw new SelectedExportError("cancelled");
        yield chunk;
      }
      emittedRecords += 1;
    }
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new SelectedExportError("invalid_page");
    }
    cursor = page.nextCursor;
    pageNumber += 1;
  } while (cursor !== null);
  if (emittedRecords === 0) {
    throw new SelectedExportError(
      selection.kind === "identities" ? "tombstoned_selection" : "unauthorized_selection",
    );
  }
}

/** Create the HTTP route while retaining the existing registry authentication boundary. */
export function createSelectedExportStreamingApp(options: SelectedExportStreamOptions): Hono {
  const app = new Hono();
  app.post("/v1/exports", async (context) => {
    const request = context.req.raw;
    const correlationId = correlationIdFrom(request);
    const operation = publicOperationRegistry.get("exports.selected");
    if (operation === undefined) return context.json(internalErrorBody(correlationId), 500);
    const admission = await admitHttpRequest({
      operation,
      request,
      authenticate: options.authenticate,
      errorRegistry: httpErrorRegistry,
      maxRequestBodyBytes: options.maxRequestBodyBytes,
      correlationId,
    });
    if (admission.kind === "rejected") return context.json(admission.body, admission.status);
    let stream: AsyncGenerator<Uint8Array> | undefined;
    const producerAbort = new AbortController();
    let terminal: Promise<void> | undefined;
    let terminated = false;
    const activePulls = new Set<Promise<void>>();
    const terminate = (): Promise<void> => {
      terminal ??= (async (): Promise<void> => {
        terminated = true;
        request.signal.removeEventListener("abort", onRequestAbort);
        producerAbort.abort();
        await Promise.allSettled(activePulls);
        try {
          await stream?.return(undefined);
        } catch {
          // The producer's error is already represented by the response or its
          // cancellation. Cleanup must remain awaitable and rejection-free.
        }
      })();
      return terminal;
    };
    const onRequestAbort = (): void => {
      void terminate();
    };
    const complete = (): void => {
      if (terminated) return;
      terminated = true;
      request.signal.removeEventListener("abort", onRequestAbort);
      terminal ??= Promise.resolve();
    };
    const handlers: OperationHandlerMap = {
      "exports.selected": async (value, _handlerContext) => {
        const parsed = reportAdminExportRequestSchema.parse(value);
        stream = streamSelectedExport(parsed.selection, options.source, producerAbort.signal);
        if (request.signal.aborted) onRequestAbort();
        else request.signal.addEventListener("abort", onRequestAbort, { once: true });
        return { version: 1, contentType: "application/octet-stream", streamVersion: 1 };
      },
    };
    const adapter = createRegistryTransportAdapter({
      registry: publicOperationRegistry,
      handlers,
      errorRegistry: httpErrorRegistry,
      logger: options.logger,
      authenticate: options.authenticate,
    });
    const result = await adapter.execute(
      "exports.selected",
      admission.input,
      authenticatedTransportContext({ request, correlationId }, admission.principal),
    );
    if (result.status !== 200 || stream === undefined)
      return context.json(result.body, result.status);
    let prefetched: IteratorResult<Uint8Array>;
    try {
      prefetched = await stream.next();
      if (prefetched.done) {
        request.signal.removeEventListener("abort", onRequestAbort);
        return context.json(internalErrorBody(correlationId), 500);
      }
    } catch {
      await terminate();
      request.signal.removeEventListener("abort", onRequestAbort);
      try {
        options.logger?.({
          kind: "handler-error",
          operationKey: "exports.selected",
          correlationId,
        });
      } catch {
        // Diagnostics cannot change the fail-closed response.
      }
      return context.json(internalErrorBody(correlationId), 500);
    }
    let firstPull = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const pullPromise = (async (): Promise<void> => {
          if (terminated) {
            try {
              controller.close();
            } catch {
              // A response cancellation may have already closed the controller.
            }
            await terminal;
            return;
          }
          try {
            const next = firstPull ? prefetched : await stream?.next();
            firstPull = false;
            if (terminated) {
              try {
                controller.close();
              } catch {
                // A response cancellation may have already closed the controller.
              }
              return;
            }
            if (next === undefined || next.done) {
              complete();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error: unknown) {
            if (terminated) {
              try {
                controller.close();
              } catch {
                // A response cancellation may have already closed the controller.
              }
              return;
            }
            try {
              options.logger?.({
                kind: "handler-error",
                operationKey: "exports.selected",
                correlationId,
              });
            } catch {
              // Diagnostics cannot change stream termination.
            }
            controller.error(error);
          }
        })();
        activePulls.add(pullPromise);
        void pullPromise.then(
          () => activePulls.delete(pullPromise),
          () => activePulls.delete(pullPromise),
        );
        return pullPromise;
      },
      cancel() {
        return terminate();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Agent-Mail-Export-Version": String(EXPORT_STREAM_VERSION),
      },
    });
  });
  return app;
}

type PlacementRow = Readonly<{
  readonly account_id: unknown;
  readonly mailbox_id: unknown;
  readonly uid_validity: unknown;
  readonly uid: unknown;
}>;

type BlobRow = Readonly<{
  readonly kind: unknown;
  readonly ordinal: unknown;
  readonly blob_id: unknown;
  readonly size: unknown;
  readonly filename?: unknown;
  readonly content_type?: unknown;
}>;

/** A real SQLite source used by the focused exactness test and the daemon composition. */
export function createSqliteSelectedExportSource(
  options: Readonly<{
    readonly database: Database;
    readonly accountId: unknown;
    readonly canonicalDirectory?: string;
    readonly cursorCodec?: SearchCursorIntegrityCodec;
  }>,
): SelectedExportSource {
  const accountId = parseAccountId(options.accountId);
  const filters = compileStructuredFilters([]);
  if (filters.kind !== "compiled") throw new TypeError("empty filters must compile");
  const canonicalDirectory = options.canonicalDirectory;
  const readBlob =
    canonicalDirectory === undefined
      ? undefined
      : (blob: SelectedExportBlob, signal: AbortSignal) =>
          fileBlobReader(canonicalDirectory, blob, signal);
  return {
    page: async ({ selection, cursor, pageNumber, signal }) => {
      if (isCancelled(signal)) throw new SelectedExportError("cancelled");
      if (selection.kind === "query") {
        if (options.cursorCodec === undefined) {
          throw new SelectedExportError(
            "invalid_page",
            "selected export query paging is unavailable",
          );
        }
        const text = compileSearchQuery(selection.query);
        if (text.kind !== "compiled") throw new SelectedExportError("invalid_page");
        const page = selectSearchCandidates(options.database, {
          accountId,
          text,
          filters,
          limit: PAGE_SIZE,
          cursor: cursor === null ? undefined : cursor,
          cursorCodec: options.cursorCodec,
        });
        const records = page.candidates.map((candidate) =>
          readRecord(options.database, accountId, candidate.messageId),
        );
        if (records.some((record) => record === undefined)) {
          throw new SelectedExportError("content_unavailable");
        }
        return {
          records: records.filter((record): record is SelectedExportRecord => record !== undefined),
          nextCursor: page.nextCursor,
          queryDigest: digestNormalizedSearchQuery(text, filters),
          pageNumber,
        };
      }
      const identityStart = cursor === null ? 0 : parseIdentityCursor(cursor);
      const ids = selection.messageIds.slice(identityStart, identityStart + PAGE_SIZE);
      const records = ids.map((messageId) =>
        readRecord(options.database, accountId, parseMessageId(messageId)),
      );
      if (records.some((record) => record === undefined)) {
        throw new SelectedExportError("tombstoned_selection");
      }
      const next =
        identityStart + ids.length < selection.messageIds.length
          ? String(identityStart + ids.length)
          : null;
      return {
        records: records.filter((record): record is SelectedExportRecord => record !== undefined),
        nextCursor: next,
        queryDigest: selectionDigest(selection),
        pageNumber,
      };
    },
    authorize: async (record) => record.placementId.length > 0,
    readBlob,
  };
}

function parseIdentityCursor(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new SelectedExportError("invalid_page");
  return parsed;
}

function readRecord(
  database: Database,
  accountId: AccountId,
  messageId: MessageId,
): SelectedExportRecord | undefined {
  const placement = database
    .query<PlacementRow, [string, string]>(
      "SELECT account_id, mailbox_id, uid_validity, uid FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL ORDER BY mailbox_id, uid_validity, uid LIMIT 1;",
    )
    .get(accountId, messageId);
  if (placement === null || placement === undefined) return undefined;
  if (
    typeof placement.account_id !== "string" ||
    typeof placement.mailbox_id !== "string" ||
    typeof placement.uid_validity !== "number" ||
    typeof placement.uid !== "number"
  )
    throw new SelectedExportError("invalid_page");
  const id = placementId(
    placement.account_id,
    placement.mailbox_id,
    placement.uid_validity,
    placement.uid,
  );
  const subjectRow = database
    .query<{ readonly subject: unknown }, [string]>(
      "SELECT value AS subject FROM message_headers WHERE message_id = ? AND normalized_name = 'subject' ORDER BY ordinal LIMIT 1;",
    )
    .get(messageId);
  const subject =
    subjectRow === null || typeof subjectRow.subject !== "string" ? null : subjectRow.subject;
  const blobRows = database
    .query<BlobRow, [string]>(
      "SELECT r.kind, r.ordinal, r.blob_id, r.size, a.filename, a.content_type FROM message_blob_references AS r LEFT JOIN message_attachments AS a ON a.message_id = r.message_id AND a.ordinal = r.ordinal AND r.kind = 'attachment' WHERE r.message_id = ? AND r.kind IN ('raw-eml', 'attachment') ORDER BY CASE r.kind WHEN 'raw-eml' THEN 0 ELSE 1 END, r.ordinal;",
    )
    .all(messageId);
  const blobs: SelectedExportBlob[] = [];
  for (const row of blobRows) {
    if (
      typeof row.kind !== "string" ||
      (row.kind !== "raw-eml" && row.kind !== "attachment") ||
      typeof row.blob_id !== "string" ||
      typeof row.size !== "number"
    )
      throw new SelectedExportError("invalid_page");
    blobs.push({
      kind: row.kind === "raw-eml" ? "raw" : "attachment",
      blobId: `blob:${row.blob_id}`,
      size: row.size,
      filename:
        row.filename === null || row.filename === undefined
          ? null
          : typeof row.filename === "string"
            ? row.filename
            : null,
      contentType: typeof row.content_type === "string" ? row.content_type : undefined,
    });
  }
  if (!blobs.some((blob) => blob.kind === "raw")) return undefined;
  return {
    messageId,
    placementId: id,
    metadata: metadataBytes({ messageId, placementId: id, subject }),
    blobs,
  };
}
