import {
  createThreadId,
  parseAccountId,
  parseMessageId,
  parseUtcInstant,
  type MessageId,
  type ThreadId,
  type UtcInstant,
} from "@agent-mail/core";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Database } from "bun:sqlite";
import { MAX_CANDIDATE_PAGE_SIZE, type SearchCandidate } from "./search-candidate-repository";

const CANONICAL_MESSAGE_ID = /^message:[0-9a-f]{64}$/u;

/** The result shape is intentionally the shared retrieval SearchHit shape. */
export type SearchSummary = Readonly<{
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly subject: string | null;
  readonly sender: Readonly<{ readonly name?: string; readonly address: string }>;
  readonly sentAt: UtcInstant | null;
  readonly receivedAt: UtcInstant;
  readonly snippet: string;
  readonly isUnread: boolean;
  readonly hasAttachment: boolean;
  readonly score: number;
}>;

/** Hydration is deliberately given only the already bounded final candidate page. */
export type SearchSummaryHydrationRequest = Readonly<{
  readonly accountId: unknown;
  readonly candidates: readonly unknown[];
}>;

type HydrationRow = Readonly<{
  readonly message_id: unknown;
  readonly thread_id: unknown;
  readonly subject: unknown;
  readonly sender_name: unknown;
  readonly sender_address: unknown;
  readonly sent_at: unknown;
  readonly received_at: unknown;
  readonly snippet: unknown;
  readonly is_unread: unknown;
  readonly has_attachment: unknown;
  readonly score: unknown;
  readonly position: unknown;
}>;

/**
 * Build the one-query final-page hydration statement. The candidate VALUES
 * relation is the query's driving table, so SQLite cannot materialize the
 * rest of the message catalog as hydrated rows.
 */
export function searchSummaryHydrationSql(candidateCount: number): string {
  if (
    !Number.isSafeInteger(candidateCount) ||
    candidateCount < 1 ||
    candidateCount > MAX_CANDIDATE_PAGE_SIZE
  ) {
    throw new RangeError(`candidate page size must be between 1 and ${MAX_CANDIDATE_PAGE_SIZE}`);
  }
  const values = Array.from({ length: candidateCount }, () => "(?, ?, ?, ?)").join(", ");
  return `
    WITH candidate_page(position, message_id, score, canonical_instant) AS MATERIALIZED (
      VALUES ${values}
    )
    SELECT
      cp.position AS position,
      cp.message_id AS message_id,
      'thread:' || substr(cp.message_id, 9) AS thread_id,
      NULLIF(projection.subject, '') AS subject,
      (
        SELECT a.display_name
        FROM message_addresses AS a
        WHERE a.message_id = cp.message_id
          AND a.role IN ('from', 'sender')
        ORDER BY CASE a.role WHEN 'from' THEN 0 ELSE 1 END, a.position
        LIMIT 1
      ) AS sender_name,
      (
        SELECT a.normalized_address
        FROM message_addresses AS a
        WHERE a.message_id = cp.message_id
          AND a.role IN ('from', 'sender')
        ORDER BY CASE a.role WHEN 'from' THEN 0 ELSE 1 END, a.position
        LIMIT 1
      ) AS sender_address,
      (
        SELECT h.normalized_value
        FROM message_headers AS h
        WHERE h.message_id = cp.message_id AND h.normalized_name = 'date'
        ORDER BY h.ordinal
        LIMIT 1
      ) AS sent_at,
      cp.canonical_instant AS received_at,
      trim(substr(projection.body_plain, 1, 4096)) AS snippet,
      CASE WHEN EXISTS (
        SELECT 1
        FROM remote_placements AS rp
        WHERE rp.account_id = ?
          AND rp.message_id = cp.message_id
          AND rp.tombstone_observed_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(rp.flags_json) AS flag
            WHERE flag.value = char(92) || 'Seen'
          )
      ) THEN 1 ELSE 0 END AS is_unread,
      EXISTS (
        SELECT 1
        FROM message_attachments AS attachment
        WHERE attachment.message_id = cp.message_id
      ) AS has_attachment,
      cp.score AS score
    FROM candidate_page AS cp
    JOIN messages AS message ON message.message_id = cp.message_id
    JOIN indexed_messages AS projection ON projection.message_id = message.message_id
    ORDER BY cp.position;
  `;
}

/** Hydrate only the final bounded candidate page, preserving its explicit order. */
export function hydrateSearchSummaryPage(
  database: Database,
  request: SearchSummaryHydrationRequest,
): readonly SearchSummary[] {
  const accountId = parseAccountId(request.accountId);
  const candidates = parseCandidates(request.candidates);
  if (candidates.length === 0) return [];

  const sql = searchSummaryHydrationSql(candidates.length);
  const parameters: SQLQueryBindings[] = [];
  for (const candidate of candidates) {
    parameters.push(
      candidate.position,
      candidate.messageId,
      candidate.score,
      candidate.canonicalInstant,
    );
  }
  parameters.push(accountId);

  const rows = database.query<HydrationRow, SQLQueryBindings[]>(sql).all(...parameters);
  if (rows.length !== candidates.length) {
    throw new Error("final candidate page changed before summary hydration completed");
  }
  return Object.freeze(rows.map(decodeHydrationRow));
}

function parseCandidates(value: readonly unknown[]): readonly SearchCandidate[] {
  if (!Array.isArray(value)) throw new TypeError("final candidate page must be an array");
  if (value.length > MAX_CANDIDATE_PAGE_SIZE) {
    throw new RangeError(`candidate page size must be between 1 and ${MAX_CANDIDATE_PAGE_SIZE}`);
  }
  const candidates = value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("final candidate has an invalid shape");
    }
    const item: Readonly<Record<string, unknown>> = candidate;
    const messageId = parseMessageId(item.messageId);
    if (!CANONICAL_MESSAGE_ID.test(messageId))
      throw new TypeError("final candidate has an invalid message ID");
    if (typeof item.score !== "number" || !Number.isFinite(item.score)) {
      throw new TypeError("final candidate has an invalid score");
    }
    if (!Number.isSafeInteger(item.position) || item.position !== index + 1) {
      throw new TypeError("final candidate positions must be contiguous and ordered");
    }
    if (item.canonicalInstant === null) {
      throw new TypeError("final candidate canonical instant is required for SearchHit.receivedAt");
    }
    const canonicalInstant = parseUtcInstant(item.canonicalInstant);
    return Object.freeze({
      messageId,
      score: item.score,
      canonicalInstant,
      position: item.position,
    });
  });
  if (new Set(candidates.map((candidate) => candidate.messageId)).size !== candidates.length) {
    throw new TypeError("final candidate identities must be unique");
  }
  return Object.freeze(candidates);
}

function decodeHydrationRow(row: HydrationRow): SearchSummary {
  if (
    typeof row.message_id !== "string" ||
    typeof row.thread_id !== "string" ||
    (row.subject !== null && typeof row.subject !== "string") ||
    (row.sender_name !== null && typeof row.sender_name !== "string") ||
    typeof row.sender_address !== "string" ||
    (row.sent_at !== null && typeof row.sent_at !== "string") ||
    typeof row.received_at !== "string" ||
    typeof row.snippet !== "string" ||
    (row.is_unread !== 0 && row.is_unread !== 1) ||
    (row.has_attachment !== 0 && row.has_attachment !== 1) ||
    typeof row.score !== "number" ||
    !Number.isFinite(row.score) ||
    typeof row.position !== "number" ||
    !Number.isSafeInteger(row.position)
  ) {
    throw new TypeError("hydrated search summary row has an invalid shape");
  }
  const messageId = parseMessageId(row.message_id);
  if (!CANONICAL_MESSAGE_ID.test(messageId))
    throw new TypeError("hydrated search summary has an invalid message ID");
  const threadId = parseThreadId(row.thread_id);
  const senderAddress = row.sender_address.trim();
  if (senderAddress.length === 0 || hasControlCharacters(senderAddress)) {
    throw new TypeError("hydrated search summary sender is invalid");
  }
  const senderName = row.sender_name === null ? undefined : row.sender_name;
  if (senderName !== undefined && hasControlCharacters(senderName)) {
    throw new TypeError("hydrated search summary sender name is invalid");
  }
  const receivedAt = parseUtcInstant(row.received_at);
  const sentAt = row.sent_at === null ? null : parseUtcInstant(row.sent_at);
  const sender =
    senderName === undefined
      ? { address: senderAddress }
      : { name: senderName, address: senderAddress };
  return Object.freeze({
    messageId,
    threadId,
    subject: row.subject,
    sender,
    sentAt,
    receivedAt,
    snippet: row.snippet,
    isUnread: row.is_unread === 1,
    hasAttachment: row.has_attachment === 1,
    score: row.score,
  });
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

function parseThreadId(value: string): ThreadId {
  return createThreadId(value);
}
