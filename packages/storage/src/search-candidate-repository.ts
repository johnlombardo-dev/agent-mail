import {
  parseAccountId,
  parseMessageId,
  parseUtcInstant,
  type AccountId,
  type MessageId,
  type UtcInstant,
} from "@agent-mail/core";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Database } from "bun:sqlite";
import { MESSAGE_FTS_BM25_WEIGHTS } from "./migrations/0003-external-content-search";
import { SEARCH_CANDIDATE_SQL, type CompiledSearchQuery } from "./search-query-compiler";
import type { CompiledStructuredFilter } from "./structured-filter-compiler";
import {
  createSearchCursor,
  digestNormalizedSearchQuery,
  parseSearchCursor,
  searchKeysetPredicate,
  SearchCursorError,
  type SearchCursor,
  type SearchCursorIntegrityCodec,
} from "./search-cursor";

/** The largest page that the candidate query can ask SQLite to return. */
export const MAX_CANDIDATE_PAGE_SIZE = 100;

export type SearchCandidateRequest = Readonly<{
  /** Untrusted account scope; parsed before any SQL executes. */
  readonly accountId: unknown;
  readonly text: CompiledSearchQuery;
  readonly filters: CompiledStructuredFilter;
  readonly limit: number;
  /** Opaque keyset cursor from the preceding page. */
  readonly cursor?: unknown;
  /** The daemon-owned codec; callers never supply or inspect an integrity tag. */
  readonly cursorCodec?: SearchCursorIntegrityCodec;
}>;

export type SearchCandidate = Readonly<{
  readonly messageId: MessageId;
  readonly score: number;
  readonly canonicalInstant: UtcInstant | null;
  /** One-based position in the deterministic page order. */
  readonly position: number;
}>;

export type SearchCandidatePage = Readonly<{
  readonly candidates: readonly SearchCandidate[];
  readonly limit: number;
  readonly bm25Weights: typeof MESSAGE_FTS_BM25_WEIGHTS;
  readonly nextCursor: SearchCursor | null;
}>;

type CandidateRow = Readonly<{
  readonly message_id: unknown;
  readonly score: unknown;
  readonly canonical_instant: unknown;
}>;

/**
 * Select one bounded FTS candidate page. This operation intentionally returns
 * only identity, score, and ordering metadata; message hydration belongs to a
 * later seam.
 */
export function selectSearchCandidates(
  database: Database,
  request: SearchCandidateRequest,
): SearchCandidatePage {
  const accountId = assertRequest(request);
  const queryDigest = digestNormalizedSearchQuery(request.text, request.filters, accountId);
  const cursor =
    request.cursor === undefined
      ? undefined
      : parseSearchCursor(request.cursor, request.cursorCodec ?? invalidCursorCodec());
  if (cursor !== undefined && cursor.normalizedQueryDigest !== queryDigest) {
    throw new SearchCursorError();
  }
  const keyset = cursor === undefined ? undefined : searchKeysetPredicate(cursor);

  const sql = `
    WITH ranked AS MATERIALIZED (
      SELECT
        m.message_id AS message_id,
        bm25(
          message_fts,
          ${MESSAGE_FTS_BM25_WEIGHTS.subject}.0,
          ${MESSAGE_FTS_BM25_WEIGHTS.participants}.0,
          ${MESSAGE_FTS_BM25_WEIGHTS.bodyPlain}.0,
          ${MESSAGE_FTS_BM25_WEIGHTS.bodyHtml}.0,
          ${MESSAGE_FTS_BM25_WEIGHTS.attachmentNames}.0
        ) AS score,
        (
          SELECT MIN(rp.internal_date)
          FROM remote_placements AS rp
          WHERE rp.message_id = m.message_id
            AND rp.account_id = ?
            AND rp.tombstone_observed_at IS NULL
            AND rp.internal_date IS NOT NULL
        ) AS canonical_instant
      FROM message_fts
      JOIN message_search_documents AS d ON d.document_id = message_fts.rowid
      JOIN messages AS m ON m.message_id = d.message_id
      WHERE ${request.text.sql}
        AND ${request.filters.sql}
        AND EXISTS (
          SELECT 1
          FROM remote_placements AS visibility_rp
          WHERE visibility_rp.account_id = ?
            AND visibility_rp.message_id = m.message_id
            AND visibility_rp.tombstone_observed_at IS NULL
        )
    )
    SELECT message_id, score, canonical_instant
    FROM ranked
    ${keyset === undefined ? "" : `WHERE ${keyset.sql}`}
    ORDER BY
      score ASC,
      CASE WHEN canonical_instant IS NULL THEN 1 ELSE 0 END ASC,
      canonical_instant DESC,
      message_id ASC
    LIMIT ?;
  `;
  const parameters: SQLQueryBindings[] = [
    accountId,
    ...request.text.parameters,
    ...request.filters.parameters,
    accountId,
    ...(keyset?.parameters ?? []),
    request.limit,
  ];
  const rows = database.query<CandidateRow, SQLQueryBindings[]>(sql).all(...parameters);
  const candidates = rows.map((row, index) => decodeCandidate(row, index + 1));
  const lastCandidate = candidates[candidates.length - 1];

  return Object.freeze({
    candidates: Object.freeze(candidates),
    limit: request.limit,
    bm25Weights: MESSAGE_FTS_BM25_WEIGHTS,
    nextCursor:
      request.cursorCodec === undefined || lastCandidate === undefined
        ? null
        : createSearchCursor(
            {
              normalizedQueryDigest: queryDigest,
              score: lastCandidate.score,
              canonicalInstant: lastCandidate.canonicalInstant,
              identityTieBreaker: lastCandidate.messageId,
            },
            request.cursorCodec,
          ),
  });
}

function invalidCursorCodec(): SearchCursorIntegrityCodec {
  return {
    sign: () => "",
    verify: () => false,
  };
}

function assertRequest(request: SearchCandidateRequest): AccountId {
  const accountId = parseAccountId(request.accountId);
  if (
    request.text.kind !== "compiled" ||
    request.text.ok !== true ||
    request.text.sql !== SEARCH_CANDIDATE_SQL
  ) {
    throw new TypeError("compiled search text is invalid");
  }
  if (
    request.filters.kind !== "compiled" ||
    request.filters.ok !== true ||
    request.filters.sql.length === 0
  ) {
    throw new TypeError("compiled structured filters are invalid");
  }
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_CANDIDATE_PAGE_SIZE
  ) {
    throw new RangeError(`candidate page size must be between 1 and ${MAX_CANDIDATE_PAGE_SIZE}`);
  }
  return accountId;
}

function decodeCandidate(row: CandidateRow, position: number): SearchCandidate {
  if (
    typeof row.message_id !== "string" ||
    typeof row.score !== "number" ||
    !Number.isFinite(row.score) ||
    (row.canonical_instant !== null && typeof row.canonical_instant !== "string")
  ) {
    throw new TypeError("candidate row has an invalid shape");
  }

  return Object.freeze({
    messageId: parseMessageId(row.message_id),
    score: row.score,
    canonicalInstant:
      row.canonical_instant === null ? null : parseUtcInstant(row.canonical_instant),
    position,
  });
}
