import {
  hydratedMessageSchema,
  messageRequestSchema,
  messageResponseSchema,
  searchRequestSchema,
  searchResponseSchema,
  threadRequestSchema,
  threadResponseSchema,
  type HydratedMessage,
  type SearchRequest,
} from "@agent-mail/contracts";
import {
  parseAccountId,
  parseMessageId,
  parseThreadId,
  parseUtcInstant,
  type AccountId,
  type MessageId,
  type ThreadId,
} from "@agent-mail/core";
import type { Database } from "bun:sqlite";
import type { SearchCursorIntegrityCodec } from "../../storage/src/search-cursor";
import { SearchCursorError } from "../../storage/src/search-cursor";
import { selectSearchCandidates } from "../../storage/src/search-candidate-repository";
import { compileSearchQuery } from "../../storage/src/search-query-compiler";
import { compileStructuredFilters } from "../../storage/src/structured-filter-compiler";
import { hydrateSearchSummaryPage } from "../../storage/src/search-summary-hydration-repository";
import { ThreadGraphError } from "../../storage/src/thread-graph-repository";
import type { ThreadCursorCodec } from "../../storage/src/thread-cursor";
import { ThreadHydrationRepository } from "../../storage/src/thread-hydration-repository";
import type { ThreadParticipantFact, ThreadPage } from "../../storage/src/thread-types";
import type {
  OperationHandler,
  OperationHandlerContext,
  OperationHandlerMap,
  RegisteredFeatureOutcome,
} from "./http";
import { RegisteredFeatureErrorException } from "./http";

type Row = Readonly<Record<string, unknown>>;

export type RetrievalHandlerOptions = Readonly<{
  readonly database: Database;
  readonly accountId: unknown;
  readonly searchCursorCodec?: SearchCursorIntegrityCodec;
  readonly threadCursorCodec?: ThreadCursorCodec;
}>;

export type RetrievalHandlerServices = Readonly<{
  readonly accountId: AccountId;
  readonly database: Database;
  readonly searchCursorCodec?: SearchCursorIntegrityCodec;
  readonly threadCursorCodec?: ThreadCursorCodec;
}>;

class RetrievalStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetrievalStorageError";
  }
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new RetrievalStorageError(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return textValue(value, label);
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new RetrievalStorageError(`${label} is invalid`);
  return value;
}

function hasTable(database: Database, table: string): boolean {
  const row: unknown = database
    .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?;")
    .get(table);
  return row !== null;
}

function hasColumn(database: Database, table: string, column: string): boolean {
  const rows = database
    .query<Readonly<{ name: unknown }>, []>(`PRAGMA table_info(${table});`)
    .all();
  return rows.some((row) => row.name === column);
}

function accountIdOf(options: RetrievalHandlerOptions): AccountId {
  return parseAccountId(options.accountId);
}

function notFound(
  resource: "message" | "thread",
  id: MessageId | ThreadId,
  correlationId: string,
): Readonly<Record<string, unknown>> {
  return {
    code: "not_found",
    message: `${resource} was not found`,
    correlationId,
    details: { resource, id },
  };
}

function invalidThreadCursor(correlationId: string): Readonly<Record<string, unknown>> {
  return {
    code: "invalid_cursor",
    message: "thread cursor is invalid",
    correlationId,
    details: { resource: "thread" },
  };
}

function mapSearchFilters(request: SearchRequest): readonly unknown[] {
  const filters: unknown[] = [];
  const input = request.filters;
  if (input.mailboxId !== undefined)
    filters.push({ field: "remoteMailbox", operator: "eq", value: input.mailboxId });
  if (input.sender !== undefined)
    filters.push({ field: "sender", operator: "eq", value: input.sender });
  if (input.after !== undefined)
    filters.push({ field: "receivedAt", operator: "gte", value: input.after });
  if (input.before !== undefined)
    filters.push({ field: "receivedAt", operator: "lte", value: input.before });
  if (input.isUnread === true) filters.push({ field: "flag", operator: "neq", value: "\\Seen" });
  if (input.isUnread === false) filters.push({ field: "flag", operator: "eq", value: "\\Seen" });
  if (input.hasAttachment === true) filters.push({ field: "attachment", operator: "exists" });
  if (input.hasAttachment === false) filters.push({ field: "attachment", operator: "notExists" });
  if (input.label !== undefined)
    filters.push({ field: "localLabel", operator: "eq", value: input.label });
  if (input.subject !== undefined)
    filters.push({ field: "subject", operator: "eq", value: input.subject });
  if (input.threadId !== undefined)
    filters.push({ field: "threadId", operator: "eq", value: input.threadId });
  return Object.freeze(filters);
}

function featureError(
  code: "invalid_query" | "invalid_cursor",
  message: string,
): RegisteredFeatureOutcome {
  return {
    kind: "feature-error",
    error: { code, message, details: { resource: "search" } },
  };
}

function searchHandler(services: RetrievalHandlerServices): OperationHandler {
  return async (input: unknown, _context: OperationHandlerContext): Promise<unknown> => {
    const request = searchRequestSchema.parse(input);
    const text = compileSearchQuery(request.query);
    if (text.kind !== "compiled") return featureError("invalid_query", text.message);
    const filters = compileStructuredFilters(mapSearchFilters(request), {
      accountId: services.accountId,
    });
    if (filters.kind !== "compiled") return featureError("invalid_query", filters.message);
    let candidates;
    try {
      candidates = selectSearchCandidates(services.database, {
        accountId: services.accountId,
        text,
        filters,
        limit: request.limit,
        cursor: request.cursor,
        cursorCodec: services.searchCursorCodec,
      });
    } catch (error: unknown) {
      if (error instanceof SearchCursorError)
        throw new RegisteredFeatureErrorException({
          code: "invalid_cursor",
          message: "search cursor is invalid",
          details: { resource: "search" },
        });
      throw error;
    }
    const summaries = hydrateSearchSummaryPage(services.database, {
      accountId: services.accountId,
      candidates: candidates.candidates,
    });
    const response = searchResponseSchema.parse({
      items: summaries,
      nextCursor: candidates.nextCursor,
    });
    return response;
  };
}

type Address = Readonly<{ readonly name?: string; readonly address: string }>;

function decodeAddress(row: Row): Address {
  const address = textValue(row.normalized_address, "message address");
  const displayName = optionalText(row.display_name, "message display name");
  return displayName === null ? { address } : { name: displayName, address };
}

function fallbackAddress(participants: readonly ThreadParticipantFact[]): Address | undefined {
  for (const participant of participants) {
    if (participant.address.includes("@")) {
      return participant.displayName === undefined || participant.displayName === null
        ? { address: participant.address }
        : { name: participant.displayName, address: participant.address };
    }
  }
  return undefined;
}

function readThreadParticipants(
  database: Database,
  accountId: AccountId,
  setId: string,
): readonly ThreadParticipantFact[] {
  if (!hasTable(database, "thread_participants")) return [];
  const rows = database
    .query<Readonly<{ normalized_address: unknown; display_name: unknown }>, [string, string]>(
      "SELECT normalized_address, display_name FROM thread_participants WHERE account_id = ? AND set_id = ? ORDER BY first_sent_at_missing_rank, first_sent_at, first_message_id, first_role_rank, first_position LIMIT 256;",
    )
    .all(accountId, setId);
  return Object.freeze(
    rows.map((row) => ({
      address: textValue(row.normalized_address, "thread participant"),
      displayName:
        row.display_name === null ? null : textValue(row.display_name, "participant name"),
    })),
  );
}

function readMessagePlacementReceivedAt(
  database: Database,
  accountId: AccountId,
  messageId: MessageId,
): string | null {
  if (
    hasTable(database, "remote_placements") &&
    hasColumn(database, "remote_placements", "internal_date")
  ) {
    const row: unknown = database
      .query(
        "SELECT MIN(internal_date) AS received_at FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL AND internal_date IS NOT NULL;",
      )
      .get(accountId, messageId);
    if (isRow(row) && row.received_at !== null)
      return textValue(row.received_at, "received instant");
  }
  if (hasTable(database, "message_content_states")) {
    const row: unknown = database
      .query(
        "SELECT observed_at AS received_at FROM message_content_states WHERE account_id = ? AND message_id = ?;",
      )
      .get(accountId, messageId);
    if (isRow(row) && row.received_at !== null)
      return textValue(row.received_at, "received instant");
  }
  return null;
}

function hydrateMessage(
  database: Database,
  accountId: AccountId,
  messageIdInput: unknown,
  threadIdInput: unknown,
  fallbackParticipants: readonly ThreadParticipantFact[] = [],
): HydratedMessage {
  const messageId = parseMessageId(messageIdInput);
  const threadId = parseThreadId(threadIdInput);
  const membership: unknown = database
    .query(
      "SELECT set_id, sent_at, received_at FROM thread_memberships WHERE account_id = ? AND message_id = ?;",
    )
    .get(accountId, messageId);
  if (!isRow(membership)) throw new RetrievalStorageError("message membership is missing");
  const sentAt =
    membership.sent_at === null
      ? null
      : parseUtcInstant(textValue(membership.sent_at, "sent instant"));
  const receivedText =
    membership.received_at === null
      ? readMessagePlacementReceivedAt(database, accountId, messageId)
      : textValue(membership.received_at, "received instant");
  if (receivedText === null) throw new RetrievalStorageError("message received instant is missing");
  const receivedAt = parseUtcInstant(receivedText);

  const subjectRow: unknown = hasTable(database, "message_headers")
    ? database
        .query(
          "SELECT value FROM message_headers WHERE message_id = ? AND normalized_name = 'subject' ORDER BY ordinal LIMIT 1;",
        )
        .get(messageId)
    : null;
  const subject = isRow(subjectRow) ? optionalText(subjectRow.value, "message subject") : null;

  const addresses = hasTable(database, "message_addresses")
    ? database
        .query<Row, [string]>(
          "SELECT normalized_address, display_name, role, position FROM message_addresses WHERE message_id = ? AND role IN ('from', 'sender', 'to', 'cc') ORDER BY CASE role WHEN 'from' THEN 0 WHEN 'sender' THEN 1 WHEN 'to' THEN 2 ELSE 3 END, position;",
        )
        .all(messageId)
    : [];
  const fromRow = addresses.find((row) => row.role === "from" || row.role === "sender");
  const from =
    fromRow === undefined ? fallbackAddress(fallbackParticipants) : decodeAddress(fromRow);
  if (from === undefined) throw new RetrievalStorageError("message sender is missing");
  const to = addresses.filter((row) => row.role === "to").map(decodeAddress);
  const cc = addresses.filter((row) => row.role === "cc").map(decodeAddress);

  const parts =
    hasTable(database, "message_body_parts") &&
    hasColumn(database, "message_body_parts", "plain_text")
      ? database
          .query<
            Readonly<{ content_type: unknown; plain_text: unknown; html_derived_text: unknown }>,
            [string]
          >(
            "SELECT normalized_content_type AS content_type, plain_text, html_derived_text FROM message_body_parts WHERE message_id = ? ORDER BY ordinal;",
          )
          .all(messageId)
      : [];
  const plain = parts
    .filter((part) => textValue(part.content_type, "body content type").startsWith("text/plain"))
    .map((part) => textValue(part.plain_text, "plain body"))
    .join("\n");
  const html = parts
    .filter((part) => textValue(part.content_type, "body content type").startsWith("text/html"))
    .map((part) => textValue(part.html_derived_text, "HTML body"))
    .join("\n");
  const labels = hasTable(database, "local_label_assignments")
    ? database
        .query<Readonly<{ label: unknown }>, [string]>(
          "SELECT DISTINCT label FROM local_label_assignments WHERE message_id = ? ORDER BY label;",
        )
        .all(messageId)
        .map((row) => textValue(row.label, "message label"))
    : [];
  const attachments = hasTable(database, "message_attachments")
    ? database
        .query<
          Readonly<{
            ordinal: unknown;
            filename: unknown;
            content_type: unknown;
            size: unknown;
            blob_id: unknown;
          }>,
          [string]
        >(
          "SELECT ordinal, filename, content_type, size, blob_id FROM message_attachments WHERE message_id = ? ORDER BY ordinal;",
        )
        .all(messageId)
        .map((row) => ({
          attachmentId: `attachment:${textValue(row.blob_id, "attachment blob ID")}`,
          filename:
            row.filename === null ? "attachment" : textValue(row.filename, "attachment filename"),
          contentType: textValue(row.content_type, "attachment content type"),
          sizeBytes: integerValue(row.size, "attachment size"),
        }))
    : [];
  const activePlacement: unknown = hasTable(database, "remote_placements")
    ? database
        .query(
          "SELECT 1 AS present FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL LIMIT 1;",
        )
        .get(accountId, messageId)
    : null;
  const isUnread =
    activePlacement !== null && hasColumn(database, "remote_placements", "flags_json")
      ? database
          .query(
            "SELECT 1 AS present FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(flags_json) WHERE value = char(92) || 'Seen') LIMIT 1;",
          )
          .get(accountId, messageId) !== null
      : activePlacement !== null;

  return hydratedMessageSchema.parse({
    messageId,
    threadId,
    subject,
    from,
    to,
    cc,
    sentAt,
    receivedAt,
    textBody: parts.length === 0 ? null : plain,
    htmlBody: parts.length === 0 ? null : html,
    snippet: plain.slice(0, 4_096).trim(),
    isUnread,
    labels,
    attachments,
  });
}

function findMessageThread(
  database: Database,
  accountId: AccountId,
  messageId: MessageId,
): Readonly<{ readonly threadId: ThreadId; readonly setId: string }> | undefined {
  const row: unknown = database
    .query(
      "SELECT s.canonical_thread_id, s.set_id FROM thread_memberships AS m JOIN thread_sets AS s ON s.account_id = m.account_id AND s.set_id = m.set_id WHERE m.account_id = ? AND m.message_id = ?;",
    )
    .get(accountId, messageId);
  if (!isRow(row)) return undefined;
  return Object.freeze({
    threadId: parseThreadId(row.canonical_thread_id),
    setId: textValue(row.set_id, "thread set"),
  });
}

function messageHandler(services: RetrievalHandlerServices): OperationHandler {
  return (input: unknown, context: OperationHandlerContext): unknown => {
    const request = messageRequestSchema.parse(input);
    const messageId = parseMessageId(request.messageId);
    const thread = findMessageThread(services.database, services.accountId, messageId);
    if (thread === undefined) return notFound("message", messageId, context.correlationId);
    const participants = readThreadParticipants(
      services.database,
      services.accountId,
      thread.setId,
    );
    const message = hydrateMessage(
      services.database,
      services.accountId,
      messageId,
      thread.threadId,
      participants,
    );
    return messageResponseSchema.parse({ message });
  };
}

function threadResponse(
  page: ThreadPage,
  services: RetrievalHandlerServices,
): Readonly<Record<string, unknown>> {
  const messages = page.messages.map((message) =>
    hydrateMessage(
      services.database,
      services.accountId,
      message.messageId,
      page.threadId,
      message.participants,
    ),
  );
  return {
    thread: {
      threadId: page.threadId,
      resolvedFromThreadId: page.resolvedFromThreadId,
      subject: page.subject,
      participants: page.participants.map((participant) =>
        participant.displayName === undefined || participant.displayName === null
          ? { address: participant.address }
          : { name: participant.displayName, address: participant.address },
      ),
      participantsTruncated: page.participantsTruncated,
      messageCount: page.messageCount,
      messageIds: page.messageIds,
      messages,
      firstReceivedAt: page.firstReceivedAt,
      lastReceivedAt: page.lastReceivedAt,
      nextCursor: page.nextCursor,
    },
  };
}

function threadHandler(services: RetrievalHandlerServices): OperationHandler {
  const repository = new ThreadHydrationRepository(services.database, {
    cursorCodec: services.threadCursorCodec,
  });
  return (input: unknown, context: OperationHandlerContext): unknown => {
    const request = threadRequestSchema.parse(input);
    try {
      const page = repository.getPage({
        accountId: services.accountId,
        threadId: request.threadId,
        limit: request.limit,
        cursor: request.cursor,
      });
      return threadResponseSchema.parse(threadResponse(page, services));
    } catch (error: unknown) {
      if (error instanceof ThreadGraphError && error.code === "not_found")
        return notFound("thread", parseThreadId(request.threadId), context.correlationId);
      if (error instanceof ThreadGraphError && error.code === "invalid_cursor")
        return invalidThreadCursor(context.correlationId);
      throw error;
    }
  };
}

export function createRetrievalHandlers(options: RetrievalHandlerOptions): OperationHandlerMap {
  const services: RetrievalHandlerServices = Object.freeze({
    database: options.database,
    accountId: accountIdOf(options),
    searchCursorCodec: options.searchCursorCodec,
    threadCursorCodec: options.threadCursorCodec,
  });
  return Object.freeze({
    "messages.search": searchHandler(services),
    "messages.get": messageHandler(services),
    "threads.get": threadHandler(services),
  });
}

export const createSearchMessageThreadHandlers = createRetrievalHandlers;
