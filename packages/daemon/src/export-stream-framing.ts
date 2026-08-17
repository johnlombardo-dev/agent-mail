import { createHash } from "node:crypto";
import { z } from "zod";

/** The wire format version. A decoder must reject versions it does not know. */
export const EXPORT_STREAM_VERSION: 1 = 1;

/** Four bytes make a bare EML concatenation distinguishable from this format. */
export const EXPORT_STREAM_MAGIC = new Uint8Array([0x41, 0x4d, 0x45, 0x58]); // AMEX

/** Fixed header: magic, version, kind, flags, metadata length, content length. */
export const EXPORT_STREAM_HEADER_BYTES = 16;
export const EXPORT_STREAM_INTEGRITY_BYTES = 32;
export const MAX_EXPORT_METADATA_BYTES = 64 * 1024;
export const MAX_EXPORT_CONTENT_BYTES = 8 * 1024 * 1024;
export const MAX_EXPORT_FRAME_BYTES =
  EXPORT_STREAM_HEADER_BYTES +
  MAX_EXPORT_METADATA_BYTES +
  MAX_EXPORT_CONTENT_BYTES +
  EXPORT_STREAM_INTEGRITY_BYTES;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ID_BYTES = 256;
const MAX_SOURCE_BYTES = 256;

export type ExportFrameKind = "metadata" | "raw" | "attachment";

export type ExportProvenance = Readonly<{
  /** The trusted producer or selection operation, never email content. */
  readonly source: string;
  readonly selectionQueryDigest: string;
}>;

export type ExportFrameAttribution = Readonly<{
  readonly messageId: string;
  readonly placementId: string;
  readonly selectionQueryDigest: string;
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly provenance: ExportProvenance;
}>;

export type ExportFrame = Readonly<{
  readonly version: typeof EXPORT_STREAM_VERSION;
  readonly kind: ExportFrameKind;
  readonly attribution: ExportFrameAttribution;
  /** A complete current frame is bounded by MAX_EXPORT_CONTENT_BYTES. */
  readonly content: Uint8Array;
}>;

const boundedText = (name: string, maximum: number) =>
  z
    .string()
    .min(1, `${name} must not be empty`)
    .max(maximum, `${name} is too long`)
    .refine((value) => value.trim() === value, `${name} must be trimmed`)
    .refine((value) => {
      for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
      }
      return true;
    }, `${name} has control characters`);

const digestSchema = z.string().regex(SHA256, "digest must be lowercase SHA-256 hex");

const provenanceSchema = z.strictObject({
  source: boundedText("provenance source", MAX_SOURCE_BYTES),
  selectionQueryDigest: digestSchema,
});

const attributionSchema = z
  .strictObject({
    messageId: boundedText("canonical message ID", MAX_ID_BYTES),
    placementId: boundedText("canonical placement ID", MAX_ID_BYTES),
    selectionQueryDigest: digestSchema,
    contentDigest: digestSchema,
    contentSize: z.number().int().nonnegative().safe().max(MAX_EXPORT_CONTENT_BYTES),
    provenance: provenanceSchema,
  })
  .superRefine((attribution, context) => {
    if (attribution.provenance.selectionQueryDigest !== attribution.selectionQueryDigest) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "selectionQueryDigest"],
        message: "provenance selection digest must match attribution",
      });
    }
  });

const frameSchema = z.strictObject({
  version: z.literal(EXPORT_STREAM_VERSION),
  kind: z.enum(["metadata", "raw", "attachment"]),
  attribution: attributionSchema,
  content: z
    .instanceof(Uint8Array)
    .refine(
      (content) => content.byteLength <= MAX_EXPORT_CONTENT_BYTES,
      `content exceeds ${MAX_EXPORT_CONTENT_BYTES} bytes`,
    ),
});

const envelopeSchema = z.strictObject({
  version: z.literal(EXPORT_STREAM_VERSION),
  kind: z.enum(["metadata", "raw", "attachment"]),
  attribution: attributionSchema,
});

type HeaderKind = 1 | 2 | 3;

const kindToHeader: Readonly<Record<ExportFrameKind, HeaderKind>> = {
  metadata: 1,
  raw: 2,
  attachment: 3,
};

const headerToKind: Readonly<Record<HeaderKind, ExportFrameKind>> = {
  1: "metadata",
  2: "raw",
  3: "attachment",
};

function kindFromHeader(value: number): ExportFrameKind {
  switch (value) {
    case 1:
      return headerToKind[1];
    case 2:
      return headerToKind[2];
    case 3:
      return headerToKind[3];
    default:
      framingError("invalid_header", "frame kind is unknown");
  }
}

export type ExportFramingErrorCode =
  | "invalid_chunk"
  | "invalid_magic"
  | "unsupported_version"
  | "invalid_header"
  | "oversized_frame"
  | "invalid_metadata"
  | "frame_digest_mismatch"
  | "content_digest_mismatch"
  | "truncated";

export class ExportFramingError extends Error {
  readonly code: ExportFramingErrorCode;

  constructor(code: ExportFramingErrorCode, message: string) {
    super(message);
    this.name = "ExportFramingError";
    this.code = code;
  }
}

function framingError(code: ExportFramingErrorCode, message: string): never {
  throw new ExportFramingError(code, message);
}

function requireFrame(input: unknown): ExportFrame {
  const parsed = frameSchema.safeParse(input);
  if (!parsed.success) framingError("invalid_metadata", "export frame metadata is invalid");
  const frame = parsed.data;
  if (frame.attribution.contentSize !== frame.content.byteLength) {
    framingError("invalid_metadata", "content size does not match attribution");
  }
  if (digestOf(frame.content) !== frame.attribution.contentDigest) {
    framingError("content_digest_mismatch", "content digest does not match attribution");
  }
  return frame;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function encodedEnvelope(frame: ExportFrame): Uint8Array {
  const envelope = JSON.stringify({
    version: frame.version,
    kind: frame.kind,
    attribution: frame.attribution,
  });
  const metadata = new TextEncoder().encode(envelope);
  if (metadata.byteLength > MAX_EXPORT_METADATA_BYTES) {
    framingError("oversized_frame", "export frame metadata exceeds the bounded limit");
  }
  return metadata;
}

function frameIntegrity(metadata: Uint8Array, content: Uint8Array): Uint8Array {
  const hash = createHash("sha256");
  hash.update(metadata);
  hash.update(content);
  return new Uint8Array(hash.digest());
}

function copyInto(target: Uint8Array, source: Uint8Array, offset: number): void {
  target.set(source, offset);
}

/**
 * Encodes exactly one bounded frame. It does not select records, persist an
 * archive, or concatenate frames. The returned allocation is one frame only.
 */
export function encodeExportFrame(input: unknown): Uint8Array {
  const frame = requireFrame(input);
  const metadata = encodedEnvelope(frame);
  const totalBytes =
    EXPORT_STREAM_HEADER_BYTES +
    metadata.byteLength +
    frame.content.byteLength +
    EXPORT_STREAM_INTEGRITY_BYTES;
  if (totalBytes > MAX_EXPORT_FRAME_BYTES)
    framingError("oversized_frame", "export frame is too large");

  const encoded = new Uint8Array(totalBytes);
  encoded.set(EXPORT_STREAM_MAGIC, 0);
  encoded[4] = EXPORT_STREAM_VERSION;
  encoded[5] = kindToHeader[frame.kind];
  // Bytes 6 and 7 are reserved and must remain zero for forward compatibility.
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  view.setUint32(8, metadata.byteLength, false);
  view.setUint32(12, frame.content.byteLength, false);
  copyInto(encoded, metadata, EXPORT_STREAM_HEADER_BYTES);
  copyInto(encoded, frame.content, EXPORT_STREAM_HEADER_BYTES + metadata.byteLength);
  const integrityOffset =
    EXPORT_STREAM_HEADER_BYTES + metadata.byteLength + frame.content.byteLength;
  copyInto(encoded, frameIntegrity(metadata, frame.content), integrityOffset);
  return encoded;
}

/** Split one encoded frame for a deliberately small downstream write window. */
export function* encodeExportFrameChunks(
  input: unknown,
  chunkSize = 64 * 1024,
): Generator<Uint8Array> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_EXPORT_FRAME_BYTES) {
    framingError("invalid_header", "chunk size is outside the supported range");
  }
  const encoded = encodeExportFrame(input);
  for (let offset = 0; offset < encoded.byteLength; offset += chunkSize) {
    yield encoded.slice(offset, Math.min(offset + chunkSize, encoded.byteLength));
  }
}

/**
 * Incrementally decodes frames. At most one bounded current frame is retained;
 * callers consume the returned frames before feeding more input.
 */
export class ExportStreamDecoder {
  private readonly header = new Uint8Array(EXPORT_STREAM_HEADER_BYTES);
  private headerBytes = 0;
  private current: Uint8Array | undefined;
  private currentBytes = 0;
  private expectedBytes = 0;

  push(input: unknown): readonly ExportFrame[] {
    if (!(input instanceof Uint8Array)) {
      framingError("invalid_chunk", "decoder input must be a Uint8Array");
    }
    const frames: ExportFrame[] = [];
    let offset = 0;
    while (offset < input.byteLength) {
      if (this.current === undefined) {
        const headerLength = Math.min(
          EXPORT_STREAM_HEADER_BYTES - this.headerBytes,
          input.byteLength - offset,
        );
        this.header.set(input.subarray(offset, offset + headerLength), this.headerBytes);
        this.headerBytes += headerLength;
        offset += headerLength;
        if (this.headerBytes < EXPORT_STREAM_HEADER_BYTES) continue;
        this.expectedBytes = this.parseHeader();
        this.current = new Uint8Array(this.expectedBytes);
        this.current.set(this.header);
        this.currentBytes = EXPORT_STREAM_HEADER_BYTES;
        this.headerBytes = 0;
      }

      const current = this.current;
      const copyLength = Math.min(
        this.expectedBytes - this.currentBytes,
        input.byteLength - offset,
      );
      current.set(input.subarray(offset, offset + copyLength), this.currentBytes);
      this.currentBytes += copyLength;
      offset += copyLength;
      if (this.currentBytes === this.expectedBytes) {
        frames.push(this.decodeCurrent(current));
        this.current = undefined;
        this.currentBytes = 0;
        this.expectedBytes = 0;
      }
    }
    return frames;
  }

  finish(): void {
    if (this.current !== undefined || this.headerBytes !== 0) {
      framingError("truncated", "export stream ended in a partial frame");
    }
  }

  private parseHeader(): number {
    if (!equalBytes(this.header.subarray(0, EXPORT_STREAM_MAGIC.byteLength), EXPORT_STREAM_MAGIC)) {
      framingError("invalid_magic", "input is not an Agent Mail export stream");
    }
    if (this.header[4] !== EXPORT_STREAM_VERSION) {
      framingError("unsupported_version", "export stream version is unsupported");
    }
    if (this.header[6] !== 0 || this.header[7] !== 0) {
      framingError("invalid_header", "export stream header contains unknown flags");
    }
    const kind = this.header[5];
    if (kind !== 1 && kind !== 2 && kind !== 3)
      framingError("invalid_header", "frame kind is unknown");
    const view = new DataView(this.header.buffer, this.header.byteOffset, this.header.byteLength);
    const metadataBytes = view.getUint32(8, false);
    const contentBytes = view.getUint32(12, false);
    if (metadataBytes < 1 || metadataBytes > MAX_EXPORT_METADATA_BYTES) {
      framingError("oversized_frame", "frame metadata length is outside the bounded limit");
    }
    if (contentBytes > MAX_EXPORT_CONTENT_BYTES) {
      framingError("oversized_frame", "frame content length is outside the bounded limit");
    }
    const totalBytes =
      EXPORT_STREAM_HEADER_BYTES + metadataBytes + contentBytes + EXPORT_STREAM_INTEGRITY_BYTES;
    if (totalBytes > MAX_EXPORT_FRAME_BYTES)
      framingError("oversized_frame", "frame length is too large");
    return totalBytes;
  }

  private decodeCurrent(encoded: Uint8Array): ExportFrame {
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const metadataBytes = view.getUint32(8, false);
    const contentBytes = view.getUint32(12, false);
    const metadataStart = EXPORT_STREAM_HEADER_BYTES;
    const contentStart = metadataStart + metadataBytes;
    const integrityStart = contentStart + contentBytes;
    const metadata = encoded.slice(metadataStart, contentStart);
    const content = encoded.slice(contentStart, integrityStart);
    const suppliedIntegrity = encoded.slice(integrityStart, encoded.byteLength);
    if (!equalBytes(suppliedIntegrity, frameIntegrity(metadata, content))) {
      framingError("frame_digest_mismatch", "export frame integrity check failed");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
    } catch {
      framingError("invalid_metadata", "export frame metadata is not valid UTF-8 JSON");
    }
    const parsed = envelopeSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.kind !== kindFromHeader(this.header[5])) {
      framingError("invalid_metadata", "export frame attribution metadata is invalid");
    }
    const frame: ExportFrame = {
      version: parsed.data.version,
      kind: parsed.data.kind,
      attribution: parsed.data.attribution,
      content,
    };
    if (frame.attribution.contentSize !== content.byteLength) {
      framingError("invalid_metadata", "content size does not match attribution");
    }
    if (digestOf(content) !== frame.attribution.contentDigest) {
      framingError("content_digest_mismatch", "content digest does not match attribution");
    }
    return frame;
  }
}

/** Decode an async chunk source without retaining the complete export. */
export async function* decodeExportStream(
  chunks: AsyncIterable<unknown> | Iterable<unknown>,
): AsyncGenerator<ExportFrame> {
  const decoder = new ExportStreamDecoder();
  for await (const chunk of chunks) {
    for (const frame of decoder.push(chunk)) yield frame;
  }
  decoder.finish();
}

/** Decode one complete frame and reject trailing or incomplete bytes. */
export function decodeExportFrame(input: unknown): ExportFrame {
  const decoder = new ExportStreamDecoder();
  const frames = decoder.push(input);
  decoder.finish();
  if (frames.length !== 1)
    framingError("invalid_header", "input does not contain exactly one frame");
  const frame = frames[0];
  if (frame === undefined)
    framingError("invalid_header", "input does not contain exactly one frame");
  return frame;
}

/** Encode frames one at a time; no complete export is ever assembled. */
export async function* encodeExportStream(
  frames: AsyncIterable<ExportFrame> | Iterable<ExportFrame>,
  chunkSize = 64 * 1024,
): AsyncGenerator<Uint8Array> {
  for await (const frame of frames) {
    yield* encodeExportFrameChunks(frame, chunkSize);
  }
}
