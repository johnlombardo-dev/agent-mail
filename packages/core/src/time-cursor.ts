/** Canonical time, checkpoint, and opaque cursor values for core boundaries. */

import {
  createRemoteUidValue,
  createUidValidity,
  type RemoteUidValue,
  type UidValidity,
} from "./identifiers";

declare const utcInstantBrand: unique symbol;
declare const monotonicSequenceBrand: unique symbol;
declare const streamingOffsetBrand: unique symbol;

export type UtcInstant = string & { readonly [utcInstantBrand]: "UtcInstant" };
export type MonotonicSequence = number & { readonly [monotonicSequenceBrand]: "MonotonicSequence" };
export type StreamingOffset = number & { readonly [streamingOffsetBrand]: "StreamingOffset" };

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createUtcInstant(value: unknown): UtcInstant {
  if (typeof value !== "string") throw new TypeError("UTC instant must be a string");
  const match = ISO_WITH_OFFSET.exec(value);
  if (match === null) throw new TypeError("UTC instant must be ISO with an explicit offset");
  const [, year, month, day, hour, minute, second, fraction = "", offset] = match;
  const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("UTC instant is invalid");
  const check = new Date(parsed);
  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutePart = offset === "Z" ? 0 : Number(offset.slice(4));
  const offsetSign = offset.startsWith("-") ? -1 : 1;
  const offsetMinutes = offsetSign * (offsetHours * 60 + offsetMinutePart);
  if (
    offset !== "Z" &&
    (offsetHours > 14 || offsetMinutePart >= 60 || (offsetHours === 14 && offsetMinutePart !== 0))
  ) {
    throw new TypeError("UTC instant offset is invalid");
  }
  // Date.parse normalizes out-of-range calendar fields; compare the source's
  // local fields against the computed instant to reject those normalizations.
  const local = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(milliseconds),
  );
  if (new Date(local - offsetMinutes * 60_000).getTime() !== parsed || check.getTime() !== parsed)
    throw new TypeError("UTC instant has invalid calendar fields");
  return check.toISOString() as UtcInstant;
}

export const serializeUtcInstant = (value: UtcInstant): string => value;

export function parseUtcInstant(value: unknown): UtcInstant {
  const result = createUtcInstant(value);
  if (serializeUtcInstant(result) !== value)
    throw new TypeError("non-canonical UTC instant serialization");
  return result;
}

export function compareUtcInstants(left: UtcInstant, right: UtcInstant): number {
  return Date.parse(left) - Date.parse(right);
}

function createNonNegativeSafeInteger<T>(value: unknown, name: string): T {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value as T;
}

export const createMonotonicSequence = (value: unknown): MonotonicSequence =>
  createNonNegativeSafeInteger<MonotonicSequence>(value, "monotonic sequence");
export const createStreamingOffset = (value: unknown): StreamingOffset =>
  createNonNegativeSafeInteger<StreamingOffset>(value, "streaming offset");
export const serializeMonotonicSequence = (value: MonotonicSequence): string => String(value);
export const serializeStreamingOffset = (value: StreamingOffset): string => String(value);

function parseNonNegativeSafeInteger<T>(
  value: unknown,
  create: (input: unknown) => T,
  name: string,
): T {
  if (typeof value !== "string" || !/^\d+$/u.test(value))
    throw new TypeError(`${name} serialization must be decimal`);
  const result = create(Number(value));
  if (String(result) !== value) throw new TypeError(`non-canonical ${name} serialization`);
  return result;
}

export const parseMonotonicSequence = (value: unknown): MonotonicSequence =>
  parseNonNegativeSafeInteger(value, createMonotonicSequence, "monotonic sequence");
export const parseStreamingOffset = (value: unknown): StreamingOffset =>
  parseNonNegativeSafeInteger(value, createStreamingOffset, "streaming offset");

export type CheckpointValue<T> =
  | { readonly kind: "known"; readonly value: T }
  | { readonly kind: "unknown" };

export type MailboxCheckpoint = {
  readonly uidValidity: CheckpointValue<UidValidity>;
  readonly uid: CheckpointValue<RemoteUidValue>;
  readonly modseq: CheckpointValue<MonotonicSequence>;
};

function checkpoint<T>(value: unknown, create: (input: unknown) => T): CheckpointValue<T> {
  if (value === undefined || value === null || value === "unknown") return { kind: "unknown" };
  return { kind: "known", value: create(value) };
}

export function createMailboxCheckpoint(value: unknown): MailboxCheckpoint {
  if (!isRecord(value)) throw new TypeError("mailbox checkpoint must be an object");
  const allowedKeys = new Set(["uidValidity", "uid", "modseq"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new TypeError("mailbox checkpoint has unknown fields");
  }
  return {
    uidValidity: checkpoint(value.uidValidity, createUidValidity),
    uid: checkpoint(value.uid, createRemoteUidValue),
    modseq: checkpoint(value.modseq, createMonotonicSequence),
  };
}

export function serializeMailboxCheckpoint(value: MailboxCheckpoint): string {
  const encode = <T>(entry: CheckpointValue<T>, serialize: (item: T) => number): unknown =>
    entry.kind === "unknown" ? ["unknown"] : ["known", serialize(entry.value)];
  return JSON.stringify([
    "mailbox-checkpoint-v1",
    encode(value.uidValidity, (item) => item),
    encode(value.uid, (item) => item),
    encode(value.modseq, (item) => item),
  ]);
}

export function parseMailboxCheckpoint(value: unknown): MailboxCheckpoint {
  if (typeof value !== "string")
    throw new TypeError("mailbox checkpoint serialization must be a string");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new TypeError("malformed mailbox checkpoint serialization");
  }
  if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== "mailbox-checkpoint-v1") {
    throw new TypeError("malformed mailbox checkpoint serialization");
  }
  const parseEntry = (item: unknown): unknown => {
    if (Array.isArray(item) && item.length === 1 && item[0] === "unknown") return undefined;
    if (!Array.isArray(item)) throw new TypeError("malformed checkpoint value");
    if (item.length !== 2 || item[0] !== "known") throw new TypeError("malformed checkpoint value");
    return item[1];
  };
  const result = createMailboxCheckpoint({
    uidValidity: parseEntry(decoded[1]),
    uid: parseEntry(decoded[2]),
    modseq: parseEntry(decoded[3]),
  });
  if (serializeMailboxCheckpoint(result) !== value)
    throw new TypeError("non-canonical mailbox checkpoint serialization");
  return result;
}

export type CursorIntegrityCodec = {
  readonly sign: (payload: string) => string;
  readonly verify: (payload: string, integrity: string) => boolean;
};

export type SearchCursor = string & { readonly __searchCursor: "SearchCursor" };

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decodeBase64Url(value: string): string {
  if (!BASE64URL.test(value)) throw new TypeError("malformed search cursor encoding");
  const normalized = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new TypeError("malformed search cursor encoding");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (encodeBase64Url(decoded) !== value)
    throw new TypeError("non-canonical search cursor encoding");
  return decoded;
}

export function createSearchCursor(payload: unknown, codec: CursorIntegrityCodec): SearchCursor {
  if (typeof payload !== "string" || payload.length === 0)
    throw new TypeError("cursor payload must be a non-empty string");
  const integrity = codec.sign(payload);
  if (typeof integrity !== "string" || integrity.length === 0)
    throw new TypeError("cursor integrity is missing");
  return encodeBase64Url(JSON.stringify(["search-cursor-v1", payload, integrity])) as SearchCursor;
}

export function parseSearchCursor(
  value: unknown,
  codec: CursorIntegrityCodec,
): { readonly payload: string } {
  if (typeof value !== "string") throw new TypeError("search cursor must be a string");
  const decoded = decodeBase64Url(value);
  let envelope: unknown;
  try {
    envelope = JSON.parse(decoded);
  } catch {
    throw new TypeError("malformed search cursor");
  }
  if (
    !Array.isArray(envelope) ||
    envelope.length !== 3 ||
    envelope[0] !== "search-cursor-v1" ||
    typeof envelope[1] !== "string" ||
    envelope[1].length === 0 ||
    typeof envelope[2] !== "string" ||
    envelope[2].length === 0
  ) {
    throw new TypeError("malformed or unknown search cursor");
  }
  const payload = envelope[1];
  const integrity = envelope[2];
  if (!codec.verify(payload, integrity)) throw new TypeError("invalid search cursor integrity");
  if (createSearchCursor(payload, codec) !== value)
    throw new TypeError("non-canonical search cursor");
  return { payload };
}
