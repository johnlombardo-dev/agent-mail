import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { PassThrough, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MailParser,
  type AttachmentStream,
  type HeaderLines,
  type Headers,
  type MessageText,
} from "mailparser";

const DEFAULT_LIMITS = {
  maxSourceBytes: 256 * 1024 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxHeaderLines: 512,
  maxParts: 512,
  maxNestingDepth: 32,
  maxDecodedTextBytes: 8 * 1024 * 1024,
  maxMetadataBytes: 16 * 1024,
} as const;

export type MimeParserLimits = Readonly<Partial<typeof DEFAULT_LIMITS>>;

export type MimeParseErrorCode =
  | "invalid-source"
  | "source-too-large"
  | "header-limit"
  | "malformed-header"
  | "parts-limit"
  | "nesting-limit"
  | "decoded-text-limit"
  | "metadata-limit"
  | "malformed-message"
  | "parser-error";

/** Stable, non-content-bearing error for untrusted staged MIME input. */
export class MimeParseError extends Error {
  readonly code: MimeParseErrorCode;

  constructor(code: MimeParseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MimeParseError";
    this.code = code;
  }
}

export type OrderedMimeHeader = Readonly<{
  ordinal: number;
  name: string;
  normalizedName: string;
  value: string;
  normalizedValue: string;
}>;

export type MimeAddressRole = "from" | "sender" | "reply-to" | "to" | "cc" | "bcc";

export type NormalizedMimeAddress = Readonly<{
  ordinal: number;
  role: MimeAddressRole;
  position: number;
  address: string | null;
  displayName: string | null;
  groupName: string | null;
}>;

export type MimePartProvenance = Readonly<{
  source: "staged-eml";
  ordinal: number;
  partId: string | null;
  untrusted: true;
}>;

export type MimeStreamPart = Readonly<{
  kind: "body" | "attachment";
  provenance: MimePartProvenance;
  contentType: string;
  disposition: string | null;
  filename: string | null;
  contentId: string | null;
  content: PassThrough;
}>;

export type MimeBodyMetadata = Readonly<{
  ordinal: number;
  contentType: "text/plain";
  decodedBytes: number;
  hasHtmlAlternative: boolean;
  provenance: MimePartProvenance;
}>;

export type MimeAttachmentMetadata = Readonly<{
  ordinal: number;
  contentType: string;
  disposition: string | null;
  filename: string | null;
  contentId: string | null;
  size: number;
  checksum: string;
  provenance: MimePartProvenance;
}>;

export type ParsedStagedMime = Readonly<{
  kind: "parsed";
  headers: readonly OrderedMimeHeader[];
  addresses: readonly NormalizedMimeAddress[];
  bodyParts: readonly MimeBodyMetadata[];
  attachments: readonly MimeAttachmentMetadata[];
}>;

export type SafeParsedStagedMime =
  | ParsedStagedMime
  | Readonly<{ kind: "error"; error: MimeParseError }>;

export type MimePartConsumer = (part: MimeStreamPart) => Promise<void> | void;

export type ParseStagedEmlOptions = Readonly<{
  sourcePath: string;
  limits?: MimeParserLimits;
  onPart?: MimePartConsumer;
  /** Optional bounded-I/O instrumentation for capacity tests and diagnostics. */
  onSourceBytes?: (bytes: number) => void;
  signal?: AbortSignal;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitsOf(value: MimeParserLimits | undefined): typeof DEFAULT_LIMITS {
  const result = { ...DEFAULT_LIMITS };
  if (value !== undefined) Object.assign(result, value);
  for (const [name, limit] of Object.entries(result)) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return result;
}

function text(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") throw new MimeParseError("metadata-limit", `${name} is invalid`);
  const normalized = value.normalize("NFC");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0 || bytes > maxBytes || hasControlCharacters(normalized)) {
    throw new MimeParseError("metadata-limit", `${name} exceeds the safe metadata boundary`);
  }
  return normalized;
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

function optionalText(value: unknown, name: string, maxBytes: number): string | null {
  return value === undefined || value === null ? null : text(value, name, maxBytes);
}

function partIdFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.partId === "string" && /^\d+(?:\.\d+)*$/u.test(value.partId)
    ? value.partId
    : null;
}

function provenance(ordinal: number, partId: string | null): MimePartProvenance {
  return { source: "staged-eml", ordinal, partId, untrusted: true };
}

function depthOf(partId: string | null): number {
  return partId === null ? 1 : partId.split(".").length;
}

function decodedHeaderValue(value: unknown, index: number): string | null {
  if (typeof value === "string") return index === 0 ? value : null;
  if (value instanceof Date) return index === 0 ? value.toISOString() : null;
  if (Array.isArray(value)) {
    const item = value[index];
    return typeof item === "string" ? item : null;
  }
  if (isRecord(value) && typeof value.value === "string") return index === 0 ? value.value : null;
  return null;
}

function normalizedHeaders(
  lines: unknown,
  headers: Headers,
  maxBytes: number,
): readonly OrderedMimeHeader[] {
  if (!Array.isArray(lines))
    throw new MimeParseError("malformed-message", "headers were not emitted");
  const seen = new Map<string, number>();
  return lines.map((line, index) => {
    if (!isRecord(line) || typeof line.key !== "string" || typeof line.line !== "string") {
      throw new MimeParseError("malformed-header", "MailParser emitted an invalid header line");
    }
    const separator = line.line.indexOf(":");
    if (separator <= 0)
      throw new MimeParseError("malformed-header", "header line has no field name");
    const name = text(line.line.slice(0, separator).trim(), "header name", maxBytes);
    const rawValue = text(line.line.slice(separator + 1).trim(), "header value", maxBytes);
    const valueIndex = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), valueIndex + 1);
    const value = text(
      decodedHeaderValue(headers.get(name.toLowerCase()), valueIndex) ?? rawValue,
      "header value",
      maxBytes,
    );
    return {
      ordinal: index + 1,
      name,
      normalizedName: name.toLowerCase(),
      value,
      normalizedValue: value.replace(/[ \t\r\n]+/gu, " ").trim(),
    };
  });
}

function addresses(headers: Headers, maxBytes: number): readonly NormalizedMimeAddress[] {
  const roles: readonly MimeAddressRole[] = ["from", "sender", "reply-to", "to", "cc", "bcc"];
  const result: NormalizedMimeAddress[] = [];
  let ordinal = 0;
  for (const role of roles) {
    const value = headers.get(role);
    if (!isRecord(value) || !Array.isArray(value.value)) continue;
    let position = 0;
    for (const entry of value.value) {
      if (!isRecord(entry))
        throw new MimeParseError("metadata-limit", "address metadata is invalid");
      const group = Array.isArray(entry.group) ? entry.group : [entry];
      const groupName =
        entry.group === undefined ? null : optionalText(entry.name, "group name", maxBytes);
      for (const member of group) {
        if (!isRecord(member))
          throw new MimeParseError("metadata-limit", "address member is invalid");
        ordinal += 1;
        position += 1;
        result.push({
          ordinal,
          role,
          position,
          address: optionalText(member.address, "address", maxBytes),
          displayName: optionalText(member.name, "display name", maxBytes),
          groupName,
        });
      }
    }
  }
  return result;
}

class HeaderAndSourceLimit extends Transform {
  #limits: typeof DEFAULT_LIMITS;
  #onSourceBytes: ((bytes: number) => void) | undefined;
  #sourceBytes = 0;
  #headerBytes = 0;
  #headerLines = 0;
  #headerDone = false;
  #haveHeaderField = false;
  #line = "";

  constructor(limits: typeof DEFAULT_LIMITS, onSourceBytes?: (bytes: number) => void) {
    super();
    this.#limits = limits;
    this.#onSourceBytes = onSourceBytes;
  }

  _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
      callback(new MimeParseError("invalid-source", "staged source emitted a non-byte chunk"));
      return;
    }
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    this.#sourceBytes += bytes;
    this.#onSourceBytes?.(this.#sourceBytes);
    if (this.#sourceBytes > this.#limits.maxSourceBytes) {
      callback(new MimeParseError("source-too-large", "staged EML exceeds the source limit"));
      return;
    }
    if (!this.#headerDone) {
      const value = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1");
      this.#line += value;
      let newline = this.#line.indexOf("\n");
      while (newline >= 0) {
        const line = this.#line.slice(0, newline).replace(/\r$/u, "");
        this.#line = this.#line.slice(newline + 1);
        this.#headerBytes += Buffer.byteLength(line, "latin1") + 1;
        this.#headerLines += 1;
        if (
          this.#headerBytes > this.#limits.maxHeaderBytes ||
          this.#headerLines > this.#limits.maxHeaderLines
        ) {
          callback(
            new MimeParseError("header-limit", "message headers exceed the configured limit"),
          );
          return;
        }
        if (line.length === 0) {
          this.#headerDone = true;
          break;
        }
        if (/^\s/u.test(line)) {
          if (!this.#haveHeaderField) {
            callback(new MimeParseError("malformed-header", "header continuation has no field"));
            return;
          }
        } else if (/^[^:\s]+:/u.test(line)) {
          this.#haveHeaderField = true;
        } else {
          callback(new MimeParseError("malformed-header", "message header line is malformed"));
          return;
        }
        newline = this.#line.indexOf("\n");
      }
    }
    callback(null, chunk);
  }
}

type MimeScanState = "headers" | "body" | "done";

/**
 * Counts only inline text bytes while the staged source is passing through.
 * It deliberately keeps at most one bounded header line and a short boundary
 * prefix; payload bytes are never accumulated. The count is conservative for
 * transfer encodings, so a message is rejected before MailParser can buffer a
 * decoded text node beyond the configured window.
 */
class InlineTextLimit extends Transform {
  #limits: typeof DEFAULT_LIMITS;
  #state: MimeScanState = "headers";
  #line = "";
  #linePrefix = "";
  #headerLines = 0;
  #headerBytes = 0;
  #headerFields = new Map<string, string>();
  #lastHeaderName: string | undefined;
  #boundaries: string[] = [];
  #currentText = false;
  #textBytes = 0;
  #partCount = 0;
  #maxBoundaryLength = 0;

  constructor(limits: typeof DEFAULT_LIMITS) {
    super();
    this.#limits = limits;
  }

  _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
      callback(new MimeParseError("invalid-source", "staged source emitted a non-byte chunk"));
      return;
    }
    const value = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    for (const byte of value) {
      const character = String.fromCharCode(byte);
      if (this.#state === "headers") {
        this.#line += character;
        this.#headerBytes += 1;
        if (this.#headerBytes > this.#limits.maxHeaderBytes) {
          callback(
            new MimeParseError("header-limit", "MIME part headers exceed the configured limit"),
          );
          return;
        }
        if (character === "\n") {
          const line = this.#line.slice(0, -1).replace(/\r$/u, "");
          this.#line = "";
          this.#headerLines += 1;
          if (this.#headerLines > this.#limits.maxHeaderLines) {
            callback(
              new MimeParseError("header-limit", "MIME part headers exceed the configured limit"),
            );
            return;
          }
          if (line.length === 0) {
            const error = this.#finishHeaders();
            if (error !== undefined) {
              callback(error);
              return;
            }
          } else if (/^\s/u.test(line)) {
            if (this.#lastHeaderName === undefined) {
              callback(
                new MimeParseError("malformed-header", "MIME header continuation has no field"),
              );
              return;
            }
            this.#headerFields.set(
              this.#lastHeaderName,
              `${this.#headerFields.get(this.#lastHeaderName) ?? ""} ${line.trim()}`,
            );
          } else {
            const separator = line.indexOf(":");
            if (separator <= 0) {
              callback(
                new MimeParseError("malformed-header", "MIME header line has no field name"),
              );
              return;
            }
            const name = line.slice(0, separator).trim().toLowerCase();
            this.#lastHeaderName = name;
            this.#headerFields.set(name, line.slice(separator + 1).trim());
          }
        }
        continue;
      }
      if (this.#state === "done") continue;
      if (this.#linePrefix.length <= this.#maxBoundaryLength + 4) this.#linePrefix += character;
      if (this.#currentText) {
        this.#textBytes += 1;
        if (this.#textBytes > this.#limits.maxDecodedTextBytes) {
          callback(
            new MimeParseError(
              "decoded-text-limit",
              "inline decoded text exceeds the configured limit",
            ),
          );
          return;
        }
      }
      if (character === "\n") {
        this.#finishBodyLine();
      }
    }
    callback(null, chunk);
  }

  #finishHeaders(): MimeParseError | undefined {
    this.#partCount += 1;
    if (this.#partCount > this.#limits.maxParts) {
      return new MimeParseError("parts-limit", "MIME parts exceed the configured limit");
    }
    const contentType = this.#headerFields.get("content-type")?.toLowerCase() ?? "text/plain";
    const disposition = this.#headerFields.get("content-disposition")?.toLowerCase() ?? "";
    const boundaryMatch = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/u.exec(contentType);
    const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
    if (boundary !== undefined && contentType.startsWith("multipart/")) {
      this.#boundaries.push(boundary);
      this.#maxBoundaryLength = Math.max(this.#maxBoundaryLength, boundary.length);
      if (this.#boundaries.length > this.#limits.maxNestingDepth) {
        return new MimeParseError("nesting-limit", "MIME nesting exceeds the configured limit");
      }
      this.#currentText = false;
    } else {
      this.#currentText =
        (contentType.startsWith("text/") || contentType.startsWith("message/rfc822")) &&
        !disposition.startsWith("attachment");
    }
    this.#headerFields.clear();
    this.#lastHeaderName = undefined;
    this.#headerBytes = 0;
    this.#headerLines = 0;
    this.#state = "body";
    this.#linePrefix = "";
    return undefined;
  }

  #finishBodyLine(): void {
    const line = this.#linePrefix.replace(/\r?\n$/u, "");
    this.#linePrefix = "";
    let matched = -1;
    let final = false;
    for (let index = this.#boundaries.length - 1; index >= 0; index -= 1) {
      const marker = `--${this.#boundaries[index]}`;
      if (line === marker || line === `${marker}--`) {
        matched = index;
        final = line === `${marker}--`;
        break;
      }
    }
    if (matched < 0) return;
    this.#boundaries.length = final ? matched : matched + 1;
    this.#currentText = false;
    // A closing nested boundary returns to its parent's multipart body. Its
    // epilogue is not a new header block; only a non-closing delimiter starts
    // the next child part's headers.
    this.#state = final
      ? this.#boundaries.length === 0
        ? "done"
        : "body"
      : "headers";
  }
}

function asMimeError(error: unknown): MimeParseError {
  if (error instanceof MimeParseError) return error;
  return new MimeParseError("parser-error", "MailParser rejected the staged message", {
    cause: error,
  });
}

function attachmentContent(attachment: AttachmentStream): PassThrough {
  const content = new PassThrough({ highWaterMark: 64 * 1024 });
  attachment.content.pipe(content);
  attachment.content.on("error", (error) => content.destroy(error));
  return content;
}

async function drain(content: PassThrough): Promise<void> {
  for await (const _chunk of content) {
    // The caller can replace this default consumer to stream a part elsewhere.
  }
}

/**
 * Parse one caller-validated staged EML path without reading the raw message
 * into memory. `onPart` runs while MailParser is consuming the file; its
 * attachment/body stream must be consumed before the callback resolves.
 *
 * MailParser 3.9.15 itself buffers decoded text and creates a final text/HTML
 * object. This adapter caps that decoded output and disables HTML conversion,
 * but cannot make that dependency's text path incremental.
 */
export async function parseStagedEml(options: ParseStagedEmlOptions): Promise<ParsedStagedMime> {
  if (typeof options.sourcePath !== "string" || options.sourcePath.length === 0) {
    throw new MimeParseError("invalid-source", "sourcePath must be a non-empty path");
  }
  const limits = limitsOf(options.limits);
  let file;
  try {
    file = await lstat(options.sourcePath);
  } catch (error) {
    throw new MimeParseError("invalid-source", "staged EML could not be opened", { cause: error });
  }
  if (!file.isFile())
    throw new MimeParseError("invalid-source", "staged EML is not a regular file");
  if (file.size > limits.maxSourceBytes) {
    throw new MimeParseError("source-too-large", "staged EML exceeds the source limit");
  }

  const parser = new MailParser({
    checksumAlgo: "sha256",
    keepCidLinks: true,
    skipImageLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const headerLines: unknown[] = [];
  let parsedHeaders: Headers = new Map();
  const attachmentTasks: Promise<void>[] = [];
  const attachments: MimeAttachmentMetadata[] = [];
  const bodyParts: MimeBodyMetadata[] = [];
  let partCount = 0;
  let textBytes = 0;
  let callbackError: MimeParseError | undefined;

  parser.on("headerLines", (lines: HeaderLines) => headerLines.push(...lines));
  parser.on("headers", (headers: Headers) => {
    parsedHeaders = headers;
  });
  parser.on("data", (part: AttachmentStream | MessageText) => {
    partCount += 1;
    if (partCount > limits.maxParts) {
      callbackError = new MimeParseError("parts-limit", "MIME parts exceed the configured limit");
      parser.destroy(callbackError);
      return;
    }
    if (part.type === "attachment") {
      const partId = partIdFrom(part);
      if (depthOf(partId) > limits.maxNestingDepth) {
        callbackError = new MimeParseError(
          "nesting-limit",
          "MIME nesting exceeds the configured limit",
        );
        parser.destroy(callbackError);
        return;
      }
      const ordinal = attachments.length + 1;
      const content = attachmentContent(part);
      const partProvenance = provenance(ordinal, partId);
      const contentType = text(
        part.contentType,
        "attachment content type",
        limits.maxMetadataBytes,
      );
      const disposition = optionalText(
        part.contentDisposition,
        "attachment disposition",
        limits.maxMetadataBytes,
      );
      const filename = optionalText(part.filename, "attachment filename", limits.maxMetadataBytes);
      const contentId = optionalText(
        part.contentId,
        "attachment content id",
        limits.maxMetadataBytes,
      );
      const streamPart: MimeStreamPart = {
        kind: "attachment",
        provenance: partProvenance,
        contentType,
        disposition,
        filename,
        contentId,
        content,
      };
      const task = (async () => {
        try {
          await (options.onPart === undefined ? drain(content) : options.onPart(streamPart));
          if (!content.readableEnded) await drain(content);
          attachments.push({
            ordinal,
            contentType,
            disposition,
            filename,
            contentId,
            size: part.size,
            checksum: text(part.checksum, "attachment checksum", 128),
            provenance: partProvenance,
          });
        } catch (error) {
          callbackError = asMimeError(error);
          parser.destroy(callbackError);
          throw callbackError;
        } finally {
          part.release();
        }
      })();
      attachmentTasks.push(task);
      return;
    }
    const value = typeof part.text === "string" ? part.text : "";
    textBytes += Buffer.byteLength(value, "utf8");
    if (textBytes > limits.maxDecodedTextBytes) {
      callbackError = new MimeParseError(
        "decoded-text-limit",
        "decoded text exceeds the configured limit",
      );
      parser.destroy(callbackError);
      return;
    }
    const ordinal = bodyParts.length + 1;
    const content = new PassThrough({ highWaterMark: 64 * 1024 });
    if (value.length > 0) content.end(Buffer.from(value, "utf8"));
    else content.end();
    const partProvenance = provenance(ordinal, null);
    const streamPart: MimeStreamPart = {
      kind: "body",
      provenance: partProvenance,
      contentType: "text/plain",
      disposition: null,
      filename: null,
      contentId: null,
      content,
    };
    bodyParts.push({
      ordinal,
      contentType: "text/plain",
      decodedBytes: Buffer.byteLength(value, "utf8"),
      hasHtmlAlternative: typeof part.html === "string",
      provenance: partProvenance,
    });
    const task = Promise.resolve(options.onPart?.(streamPart)).catch((error: unknown) => {
      callbackError = asMimeError(error);
      parser.destroy(callbackError);
      throw callbackError;
    });
    attachmentTasks.push(task);
  });

  try {
    await pipeline(
      createReadStream(options.sourcePath, { signal: options.signal }),
      new HeaderAndSourceLimit(limits, options.onSourceBytes),
      new InlineTextLimit(limits),
      parser,
    );
    await Promise.all(attachmentTasks);
  } catch (error) {
    throw callbackError ?? asMimeError(error);
  }
  if (callbackError !== undefined) throw callbackError;
  return {
    kind: "parsed",
    headers: normalizedHeaders(headerLines, parsedHeaders, limits.maxMetadataBytes),
    addresses: addresses(parsedHeaders, limits.maxMetadataBytes),
    bodyParts,
    attachments,
  };
}

/** Convert expected malformed/hostile input failures into a safe result. */
export async function safeParseStagedEml(
  options: ParseStagedEmlOptions,
): Promise<SafeParsedStagedMime> {
  try {
    return await parseStagedEml(options);
  } catch (error) {
    return { kind: "error", error: asMimeError(error) };
  }
}
