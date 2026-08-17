import { createHash } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import {
  attachmentNotFoundErrorSchema,
  attachmentOperation,
  attachmentResponseSchema,
  correlationIdSchema,
  rawMessageNotFoundErrorSchema,
  rawMessageOperation,
  retrievalAttachmentIdSchema,
  retrievalMessageIdSchema,
  streamMetadataSchema,
  type StreamMetadata,
} from "@agent-mail/contracts";
import {
  createRegistryTransportAdapter,
  httpErrorRegistry,
  publicOperationRegistry,
  type HttpCredentialAuthenticator,
  type OperationHandlerMap,
  type PrivateHttpLogger,
} from "./http";
import { z } from "zod";

/** A narrow file capability used by the stream and the direct cancellation tests. */
export type ContentBlobHandle = Readonly<{
  readonly stat: () => Promise<Readonly<{ readonly isFile: boolean; readonly size: number }>>;
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<Readonly<{ readonly bytesRead: number }>>;
  readonly close: () => Promise<void>;
}>;

export type ContentBlobHandleOpener = (path: string) => Promise<ContentBlobHandle>;

export type RawContentRecord = Readonly<{
  readonly messageId: string;
  readonly blobId: string;
  readonly size: number;
  readonly contentType: string;
}>;

export type AttachmentContentRecord = Readonly<{
  readonly attachmentId: string;
  readonly messageId: string;
  readonly blobId: string;
  readonly size: number;
  readonly contentType: string;
  readonly filename: string | null;
}>;

export type ContentStreamingAppOptions = Readonly<{
  /** A startup-config validated private canonical blob directory. */
  readonly canonicalDirectory: string;
  readonly resolveRaw: (messageId: string) => Promise<RawContentRecord | undefined>;
  readonly resolveAttachment: (
    attachmentId: string,
  ) => Promise<AttachmentContentRecord | undefined>;
  readonly authenticate?: HttpCredentialAuthenticator;
  readonly logger?: PrivateHttpLogger;
  /** Test-only capability; production uses the real fs handle opener. */
  readonly openHandle?: ContentBlobHandleOpener;
}>;

type ContentRecordSchema = z.ZodType;

const rawContentRecordSchema = z.strictObject({
  messageId: retrievalMessageIdSchema,
  blobId: z.string().regex(/^blob:[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative().safe(),
  contentType: z.string().min(1).max(255),
});

const attachmentContentRecordSchema = z.strictObject({
  attachmentId: retrievalAttachmentIdSchema,
  messageId: retrievalMessageIdSchema,
  blobId: z.string().regex(/^blob:[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative().safe(),
  contentType: z.string().min(1).max(255),
  filename: z.string().min(1).max(4_096).nullable(),
});

const STREAM_CHUNK_BYTES = 64 * 1024;

type ContentStreamErrorCode = "missing" | "not_regular" | "size_mismatch" | "digest_mismatch";

export class ContentStreamError extends Error {
  readonly code: ContentStreamErrorCode;

  constructor(code: ContentStreamErrorCode) {
    super("canonical content is unavailable");
    this.name = "ContentStreamError";
    this.code = code;
  }
}

type PreparedContent = Readonly<{
  readonly metadata: StreamMetadata;
  readonly handle: ContentBlobHandle;
  readonly close: () => Promise<void>;
}>;

function defaultOpenHandle(path: string): Promise<ContentBlobHandle> {
  return open(path, "r").then((handle) => fileHandleCapability(handle));
}

function fileHandleCapability(handle: FileHandle): ContentBlobHandle {
  return {
    stat: async () => {
      const result = await handle.stat();
      return { isFile: result.isFile(), size: result.size };
    },
    read: async (buffer, offset, length, position) => {
      const result = await handle.read(buffer, offset, length, position);
      return { bytesRead: result.bytesRead };
    },
    close: () => handle.close(),
  };
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function digestFromBlobId(blobId: string): string {
  const digest = blobId.slice("blob:".length);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new ContentStreamError("digest_mismatch");
  return digest;
}

function contentDisposition(filename: string): string {
  const encoded = new TextEncoder().encode(filename);
  let extended = "";
  for (const byte of encoded) {
    const character = String.fromCharCode(byte);
    if (/^[A-Za-z0-9!#$&+\-.^_`|~]$/u.test(character)) {
      extended += character;
    } else {
      extended += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  let fallback = "";
  for (const character of filename) {
    const codePoint = character.codePointAt(0) ?? 0;
    fallback +=
      codePoint >= 0x20 &&
      codePoint <= 0x7e &&
      character !== '"' &&
      character !== "\\" &&
      character !== "/"
        ? character
        : "_";
  }
  fallback = fallback.trim() || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

function headersFor(metadata: StreamMetadata): Headers {
  const headers = new Headers({
    "Content-Type": metadata.contentType,
    "Content-Length": String(metadata.contentLength),
    ETag: `"${metadata.digest}"`,
  });
  if (metadata.filename !== null)
    headers.set("Content-Disposition", contentDisposition(metadata.filename));
  return headers;
}

async function hashAndVerify(
  handle: ContentBlobHandle,
  expectedDigest: string,
  expectedSize: number,
): Promise<void> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  let position = 0;
  while (position < expectedSize) {
    const length = Math.min(buffer.byteLength, expectedSize - position);
    const result = await handle.read(buffer, 0, length, position);
    if (result.bytesRead <= 0 || result.bytesRead > length) {
      throw new ContentStreamError("size_mismatch");
    }
    hash.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  if (hash.digest("hex") !== expectedDigest) throw new ContentStreamError("digest_mismatch");
}

async function prepareContent(
  record: RawContentRecord | AttachmentContentRecord,
  canonicalDirectory: string,
  openHandle: ContentBlobHandleOpener,
  schema: ContentRecordSchema,
  expectedId: string,
): Promise<PreparedContent> {
  schema.parse(record);
  const recordId = "attachmentId" in record ? record.attachmentId : record.messageId;
  if (recordId !== expectedId) throw new ContentStreamError("digest_mismatch");
  const digest = digestFromBlobId(record.blobId);
  const metadata = streamMetadataSchema.parse({
    contentType: record.contentType,
    contentLength: record.size,
    digest,
    filename: "filename" in record ? record.filename : null,
  });
  const path = join(canonicalDirectory, digest);
  let handle: ContentBlobHandle | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve();
    closed = true;
    closePromise = handle?.close() ?? Promise.resolve();
    return closePromise;
  };
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new ContentStreamError("not_regular");
    handle = await openHandle(path);
    const observed = await handle.stat();
    if (!observed.isFile || observed.size !== metadata.contentLength) {
      throw new ContentStreamError("size_mismatch");
    }
    await hashAndVerify(handle, metadata.digest, metadata.contentLength);
    const final = await handle.stat();
    if (!final.isFile || final.size !== metadata.contentLength) {
      throw new ContentStreamError("size_mismatch");
    }
    return { metadata, handle, close };
  } catch (error: unknown) {
    await close();
    if (error instanceof ContentStreamError) throw error;
    if (isMissingError(error)) throw new ContentStreamError("missing");
    throw new ContentStreamError("digest_mismatch");
  }
}

function streamContent(prepared: PreparedContent): ReadableStream<Uint8Array> {
  let position = 0;
  let reading = false;
  let settled = false;
  const close = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    await prepared.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled || reading) return;
      reading = true;
      try {
        if (position >= prepared.metadata.contentLength) {
          await close();
          controller.close();
          return;
        }
        const buffer = Buffer.allocUnsafe(
          Math.min(STREAM_CHUNK_BYTES, prepared.metadata.contentLength - position),
        );
        const result = await prepared.handle.read(buffer, 0, buffer.byteLength, position);
        if (result.bytesRead <= 0 || result.bytesRead > buffer.byteLength) {
          throw new ContentStreamError("size_mismatch");
        }
        position += result.bytesRead;
        controller.enqueue(buffer.subarray(0, result.bytesRead));
        if (position === prepared.metadata.contentLength) {
          await close();
          controller.close();
        }
      } catch (error: unknown) {
        await close();
        controller.error(error);
      } finally {
        reading = false;
      }
    },
    async cancel() {
      await close();
    },
  });
}

function correlationIdFrom(request: Request): string {
  const supplied = correlationIdSchema.safeParse(request.headers.get("x-correlation-id"));
  return supplied.success ? supplied.data : `request:${crypto.randomUUID()}`;
}

function notFoundBody(
  kind: "raw-message" | "attachment",
  id: string,
  correlationId: string,
): unknown {
  const body = {
    code: "not_found",
    message: "requested content was not found",
    correlationId,
    details: { resource: kind, id },
  } satisfies Readonly<{
    readonly code: "not_found";
    readonly message: string;
    readonly correlationId: string;
    readonly details: Readonly<{
      readonly resource: "raw-message" | "attachment";
      readonly id: string;
    }>;
  }>;
  return kind === "raw-message"
    ? rawMessageNotFoundErrorSchema.parse(body)
    : attachmentNotFoundErrorSchema.parse(body);
}

async function executeStreamRoute(
  context: Context,
  options: ContentStreamingAppOptions,
  operationKey: "messages.raw" | "attachments.get",
  id: string,
): Promise<Response> {
  const operation = operationKey === "messages.raw" ? rawMessageOperation : attachmentOperation;
  let prepared: PreparedContent | undefined;
  const handlers: OperationHandlerMap = {
    [operation.key]: async (_input, handlerContext) => {
      const inputId = id;
      if (operationKey === "messages.raw") {
        const record = await options.resolveRaw(inputId);
        if (record === undefined)
          return notFoundBody("raw-message", inputId, handlerContext.correlationId);
        prepared = await prepareContent(
          record,
          options.canonicalDirectory,
          options.openHandle ?? defaultOpenHandle,
          rawContentRecordSchema,
          inputId,
        );
        return prepared.metadata;
      }
      const record = await options.resolveAttachment(inputId);
      if (record === undefined)
        return notFoundBody("attachment", inputId, handlerContext.correlationId);
      prepared = await prepareContent(
        record,
        options.canonicalDirectory,
        options.openHandle ?? defaultOpenHandle,
        attachmentContentRecordSchema,
        inputId,
      );
      return {
        attachmentId: record.attachmentId,
        messageId: record.messageId,
        metadata: prepared.metadata,
      };
    },
  };
  const request = context.req.raw;
  const correlationId = correlationIdFrom(request);
  const params: Readonly<Record<string, string>> =
    operationKey === "messages.raw" ? { messageId: id } : { attachmentId: id };
  const adapter = createRegistryTransportAdapter({
    registry: publicOperationRegistry,
    handlers,
    errorRegistry: httpErrorRegistry,
    logger: options.logger,
    authenticate: options.authenticate,
  });
  const result = await adapter.execute(operationKey, params, {
    request,
    correlationId,
    params,
  });
  if (result.status !== 200 || prepared === undefined) {
    await prepared?.close();
    return context.json(result.body, result.status);
  }
  const metadata =
    operationKey === "messages.raw"
      ? streamMetadataSchema.parse(result.body)
      : (() => {
          const parsed = attachmentResponseSchema.parse(result.body);
          if (!("metadata" in parsed)) throw new ContentStreamError("digest_mismatch");
          return parsed.metadata;
        })();
  return new Response(streamContent(prepared), { status: 200, headers: headersFor(metadata) });
}

/** Create the isolated byte-stream routes; the main HTTP app mounts these routes. */
export function createContentStreamingApp(options: ContentStreamingAppOptions): Hono {
  const app = new Hono();
  app.all("/v1/messages/:messageId/raw", async (context) =>
    executeStreamRoute(context, options, "messages.raw", context.req.param("messageId")),
  );
  app.all("/v1/attachments/:attachmentId", async (context) =>
    executeStreamRoute(context, options, "attachments.get", context.req.param("attachmentId")),
  );
  return app;
}

export { contentDisposition };
