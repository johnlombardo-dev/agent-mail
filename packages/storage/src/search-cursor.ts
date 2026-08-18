import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  parseAccountId,
  parseMessageId,
  parseUtcInstant,
  type MessageId,
  type UtcInstant,
} from "@agent-mail/core";
import type { SQLQueryBindings } from "bun:sqlite";
import type { CompiledSearchQuery } from "./search-query-compiler";
import type { CompiledStructuredFilter } from "./structured-filter-compiler";

/** Bump this value when the ranking tuple or payload meaning changes. */
export const SEARCH_CURSOR_REGISTRY_VERSION = 1 as const;
const SEARCH_CURSOR_ENVELOPE_VERSION = "search-cursor-v1" as const;
const SEARCH_KEYSET_PAYLOAD_VERSION = "search-keyset-v1" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export type SearchCursorIntegrityCodec = Readonly<{
  readonly sign: (value: string) => string;
  readonly verify: (value: string, tag: string) => boolean;
}>;

export type SearchCursorPayload = Readonly<{
  readonly registryVersion: typeof SEARCH_CURSOR_REGISTRY_VERSION;
  readonly normalizedQueryDigest: string;
  readonly ranking: Readonly<{
    readonly score: number;
    readonly canonicalInstant: UtcInstant | null;
  }>;
  readonly identityTieBreaker: MessageId;
  readonly integrityTag: string;
}>;

export type SearchCursor = string & { readonly __searchKeysetCursor: "SearchCursor" };

export class SearchCursorError extends Error {
  readonly code = "invalid_cursor" as const;

  constructor(message = "search cursor is invalid") {
    super(message);
    this.name = "SearchCursorError";
  }
}

/** Create the process-local integrity codec used by the daemon's search boundary. */
export function createSearchCursorIntegrityCodec(secret: unknown): SearchCursorIntegrityCodec {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new TypeError("search cursor integrity secret must contain at least 16 characters");
  }
  return Object.freeze({
    sign: (value: string): string =>
      createHmac("sha256", secret).update(value, "utf8").digest("hex"),
    verify: (value: string, tag: string): boolean => {
      if (!SHA256_HEX.test(tag)) return false;
      const expected = createHmac("sha256", secret).update(value, "utf8").digest("hex");
      return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(tag, "utf8"));
    },
  });
}

/** Digest normalized query semantics and, for search, the exact account scope. */
export function digestNormalizedSearchQuery(
  text: CompiledSearchQuery,
  filters: CompiledStructuredFilter,
  accountId?: unknown,
): string {
  if (text.kind !== "compiled" || filters.kind !== "compiled") {
    throw new TypeError("search cursor digest requires compiled query and filters");
  }
  const normalized = JSON.stringify({
    accountId: accountId === undefined ? null : parseAccountId(accountId),
    ast: text.ast,
    filters: filters.filters,
  });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function createSearchCursor(
  input: Readonly<{
    readonly normalizedQueryDigest: string;
    readonly score: number;
    readonly canonicalInstant: UtcInstant | null;
    readonly identityTieBreaker: MessageId;
  }>,
  codec: SearchCursorIntegrityCodec,
): SearchCursor {
  if (!SHA256_HEX.test(input.normalizedQueryDigest)) {
    throw new TypeError("search cursor query digest is invalid");
  }
  if (!Number.isFinite(input.score)) throw new TypeError("search cursor score is invalid");
  const messageId = parseMessageId(input.identityTieBreaker);
  const canonicalInstant =
    input.canonicalInstant === null ? null : parseUtcInstant(input.canonicalInstant);
  const unsigned = JSON.stringify([
    SEARCH_KEYSET_PAYLOAD_VERSION,
    SEARCH_CURSOR_REGISTRY_VERSION,
    input.normalizedQueryDigest,
    input.score,
    canonicalInstant,
    messageId,
  ]);
  const integrityTag = codec.sign(unsigned);
  if (integrityTag.length === 0 || integrityTag.length > 4096) {
    throw new TypeError("search cursor integrity is invalid");
  }
  const payload: SearchCursorPayload = Object.freeze({
    registryVersion: SEARCH_CURSOR_REGISTRY_VERSION,
    normalizedQueryDigest: input.normalizedQueryDigest,
    ranking: Object.freeze({ score: input.score, canonicalInstant }),
    identityTieBreaker: messageId,
    integrityTag,
  });
  const payloadText = JSON.stringify(payload);
  const envelopeTag = codec.sign(payloadText);
  if (envelopeTag.length === 0 || envelopeTag.length > 4096) {
    throw new TypeError("search cursor integrity is invalid");
  }
  return encodeBase64Url(
    JSON.stringify([SEARCH_CURSOR_ENVELOPE_VERSION, payloadText, envelopeTag]),
  ) as SearchCursor;
}

export function parseSearchCursor(
  value: unknown,
  codec: SearchCursorIntegrityCodec,
): SearchCursorPayload {
  try {
    if (typeof value !== "string") throw new SearchCursorError();
    const decoded = decodeBase64Url(value);
    const envelope = parseJson(decoded);
    if (
      !Array.isArray(envelope) ||
      envelope.length !== 3 ||
      envelope[0] !== SEARCH_CURSOR_ENVELOPE_VERSION ||
      typeof envelope[1] !== "string" ||
      typeof envelope[2] !== "string" ||
      !codec.verify(envelope[1], envelope[2])
    ) {
      throw new SearchCursorError();
    }
    const payloadValue = parseJson(envelope[1]);
    if (!isRecord(payloadValue)) throw new SearchCursorError();
    const payload = decodePayload(payloadValue);
    if (JSON.stringify(payload) !== envelope[1]) throw new SearchCursorError();
    const unsigned = JSON.stringify([
      SEARCH_KEYSET_PAYLOAD_VERSION,
      payload.registryVersion,
      payload.normalizedQueryDigest,
      payload.ranking.score,
      payload.ranking.canonicalInstant,
      payload.identityTieBreaker,
    ]);
    if (!codec.verify(unsigned, payload.integrityTag)) throw new SearchCursorError();
    return payload;
  } catch (error: unknown) {
    if (error instanceof SearchCursorError) throw error;
    throw new SearchCursorError();
  }
}

/** Build the predicate for rows strictly after a cursor in the candidate ORDER BY. */
export function searchKeysetPredicate(
  cursor: Pick<SearchCursorPayload, "ranking" | "identityTieBreaker">,
): Readonly<{ readonly sql: string; readonly parameters: readonly SQLQueryBindings[] }> {
  const canonicalInstant = cursor.ranking.canonicalInstant;
  const nullRank = canonicalInstant === null ? 1 : 0;
  return Object.freeze({
    sql: `(
      ranked.score > ?
      OR (ranked.score = ? AND CASE WHEN ranked.canonical_instant IS NULL THEN 1 ELSE 0 END > ?)
      OR (
        ranked.score = ?
        AND CASE WHEN ranked.canonical_instant IS NULL THEN 1 ELSE 0 END = ?
        AND (
          (ranked.canonical_instant IS NOT NULL AND ? IS NOT NULL AND ranked.canonical_instant < ?)
          OR (
            ((ranked.canonical_instant IS NULL AND ? IS NULL)
              OR (ranked.canonical_instant IS NOT NULL AND ? IS NOT NULL AND ranked.canonical_instant = ?))
            AND ranked.message_id > ?
          )
        )
      )
    )`,
    parameters: Object.freeze([
      cursor.ranking.score,
      cursor.ranking.score,
      nullRank,
      cursor.ranking.score,
      nullRank,
      canonicalInstant,
      canonicalInstant,
      canonicalInstant,
      canonicalInstant,
      canonicalInstant,
      cursor.identityTieBreaker,
    ]),
  });
}

function decodePayload(value: Readonly<Record<string, unknown>>): SearchCursorPayload {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 5 ||
    !keys.every(
      (key) =>
        typeof key === "string" &&
        [
          "registryVersion",
          "normalizedQueryDigest",
          "ranking",
          "identityTieBreaker",
          "integrityTag",
        ].includes(key),
    )
  ) {
    throw new SearchCursorError();
  }
  if (
    value.registryVersion !== SEARCH_CURSOR_REGISTRY_VERSION ||
    typeof value.normalizedQueryDigest !== "string" ||
    !SHA256_HEX.test(value.normalizedQueryDigest) ||
    !isRecord(value.ranking) ||
    !hasExactKeys(value.ranking, ["score", "canonicalInstant"]) ||
    typeof value.ranking.score !== "number" ||
    !Number.isFinite(value.ranking.score) ||
    (value.ranking.canonicalInstant !== null &&
      typeof value.ranking.canonicalInstant !== "string") ||
    typeof value.identityTieBreaker !== "string" ||
    typeof value.integrityTag !== "string" ||
    value.integrityTag.length === 0 ||
    value.integrityTag.length > 4096
  ) {
    throw new SearchCursorError();
  }
  const canonicalInstant =
    value.ranking.canonicalInstant === null
      ? null
      : parseUtcInstant(value.ranking.canonicalInstant);
  return Object.freeze({
    registryVersion: SEARCH_CURSOR_REGISTRY_VERSION,
    normalizedQueryDigest: value.normalizedQueryDigest,
    ranking: Object.freeze({ score: value.ranking.score, canonicalInstant }),
    identityTieBreaker: parseMessageId(value.identityTieBreaker),
    integrityTag: value.integrityTag,
  });
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new SearchCursorError();
  }
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  if (!BASE64URL.test(value)) throw new SearchCursorError();
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (encodeBase64Url(decoded) !== value) throw new SearchCursorError();
  return decoded;
}
