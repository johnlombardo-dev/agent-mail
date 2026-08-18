import { z } from "zod";
import {
  defineOperation,
  type OperationDefinition,
  type OperationSchema,
} from "./operation-registry";
import { correlationIdSchema, createErrorRegistry, defineError } from "./error-envelope";
import { localLabelSchema } from "./routing-operations";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)))
      return true;
  }
  return false;
}

function text(name: string, minimum = 1, maximum = 4_096): z.ZodString {
  return z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => value.trim() === value, `${name} must be trimmed`)
    .refine((value) => !hasControlCharacters(value), `${name} has control characters`);
}

function namespacedId(namespace: string): z.ZodString {
  return text(`${namespace} ID`).regex(
    new RegExp(`^${namespace}:[^\\s:][^\\u0000-\\u001f\\u007f-\\u009f]*$`, "u"),
    `${namespace} ID has the wrong namespace`,
  );
}

const mailboxIdSchema = namespacedId("mailbox");
const messageIdSchema = namespacedId("message");
const threadIdSchema = text("thread ID").regex(
  /^thread:[a-f0-9]{64}$/u,
  "thread ID must be thread:<64 lowercase hex>",
);
const attachmentIdSchema = namespacedId("attachment");

export const retrievalMailboxIdSchema = mailboxIdSchema;
export const retrievalMessageIdSchema = messageIdSchema;
export const retrievalThreadIdSchema = threadIdSchema;
export const retrievalAttachmentIdSchema = attachmentIdSchema;

/** An ISO instant with an explicit UTC offset. It is normalized by the owner. */
export const retrievalInstantSchema = text("instant", 1, 40).refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value)),
  "instant must be ISO-8601 with an explicit offset",
);

/**
 * A cursor is opaque to transport consumers. The small envelope check keeps
 * versions and malformed values out of the public boundary; the core cursor
 * codec verifies the integrity field before a cursor is used for a query.
 */
export const opaqueSearchCursorSchema = text("search cursor", 1, 8_192).refine((value) => {
  if (!BASE64URL.test(value)) return false;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const envelope: unknown = JSON.parse(decoded);
    return (
      Array.isArray(envelope) &&
      envelope.length === 3 &&
      envelope[0] === "search-cursor-v1" &&
      typeof envelope[1] === "string" &&
      envelope[1].length > 0 &&
      typeof envelope[2] === "string" &&
      envelope[2].length > 0
    );
  } catch {
    return false;
  }
}, "cursor must be a versioned opaque search cursor");

export const threadCursorPayloadSchema = z.strictObject({
  registryVersion: z.literal(1),
  cursorKeyId: text("cursor key ID", 1, 200).regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    "cursor key ID must be an ASCII identifier",
  ),
  accountScopeDigest: z.string().regex(SHA256_HEX, "account scope digest must be SHA-256 hex"),
  requestedThreadHandle: threadIdSchema,
  lastSentAtMissingRank: z.union([z.literal(0), z.literal(1)]),
  lastSentAt: retrievalInstantSchema.nullable(),
  lastMessageId: z
    .string()
    .regex(/^message:[a-f0-9]{64}$/u, "cursor message ID must be message:<64 lowercase hex>"),
});
export type ThreadCursorPayload = z.infer<typeof threadCursorPayloadSchema>;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return encodeBase64Url(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isThreadCursor(value: string): boolean {
  if (new TextEncoder().encode(value).byteLength > 8_192) return false;
  const decoded = decodeBase64Url(value);
  if (decoded === undefined) return false;
  try {
    const envelope: unknown = JSON.parse(decoded);
    if (
      !Array.isArray(envelope) ||
      envelope.length !== 3 ||
      envelope[0] !== "thread-cursor-v1" ||
      typeof envelope[1] !== "string" ||
      !SHA256_HEX.test(typeof envelope[2] === "string" ? envelope[2] : "")
    )
      return false;
    if (JSON.stringify(envelope) !== decoded) return false;
    const payloadValue: unknown = JSON.parse(envelope[1]);
    const payload = threadCursorPayloadSchema.safeParse(payloadValue);
    return payload.success && JSON.stringify(payload.data) === envelope[1];
  } catch {
    return false;
  }
}

/** A structurally valid, opaque thread cursor. HMAC verification belongs to storage. */
export const opaqueThreadCursorSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => value.trim() === value, "thread cursor must be trimmed")
  .refine((value) => !hasControlCharacters(value), "thread cursor has control characters")
  .refine(isThreadCursor, "cursor must be a versioned opaque thread cursor");
export const threadCursorSchema = opaqueThreadCursorSchema;

export const emailAddressSchema = z.strictObject({
  name: text("address name", 1, 512).optional(),
  address: text("email address", 3, 320).email(),
});

export const searchFiltersSchema = z
  .strictObject({
    mailboxId: mailboxIdSchema.optional(),
    threadId: threadIdSchema.optional(),
    sender: text("sender", 3, 320).email().optional(),
    subject: text("subject", 1, 998).optional(),
    after: retrievalInstantSchema.optional(),
    before: retrievalInstantSchema.optional(),
    isUnread: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
    label: localLabelSchema.optional(),
  })
  .superRefine((filters, context) => {
    if (filters.after !== undefined && filters.before !== undefined) {
      if (Date.parse(filters.after) > Date.parse(filters.before)) {
        context.addIssue({
          code: "custom",
          path: ["after"],
          message: "after must not be later than before",
        });
      }
    }
  });

export const searchRequestSchema = z.strictObject({
  query: text("search query", 1, 2_048),
  filters: searchFiltersSchema.default({}),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: opaqueSearchCursorSchema.optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchHitSchema = z.strictObject({
  messageId: messageIdSchema,
  threadId: threadIdSchema,
  subject: text("subject", 1, 998).nullable(),
  sender: emailAddressSchema,
  sentAt: retrievalInstantSchema.nullable(),
  receivedAt: retrievalInstantSchema,
  snippet: text("snippet", 0, 4_096),
  isUnread: z.boolean(),
  hasAttachment: z.boolean(),
  score: z.number().finite(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchPageSchema = z.strictObject({
  items: z.array(searchHitSchema),
  nextCursor: opaqueSearchCursorSchema.nullable(),
});
export type SearchPage = z.infer<typeof searchPageSchema>;
export const searchResponseSchema = searchPageSchema;

const attachmentSummarySchema = z.strictObject({
  attachmentId: attachmentIdSchema,
  filename: text("attachment filename", 1, 4_096),
  contentType: text("attachment content type", 1, 255),
  sizeBytes: z.number().int().nonnegative(),
});

export const hydratedMessageSchema = z.strictObject({
  messageId: messageIdSchema,
  threadId: threadIdSchema,
  subject: text("subject", 1, 998).nullable(),
  from: emailAddressSchema,
  to: z.array(emailAddressSchema),
  cc: z.array(emailAddressSchema),
  sentAt: retrievalInstantSchema.nullable(),
  receivedAt: retrievalInstantSchema,
  textBody: text("text body", 0, 10_000_000).nullable(),
  htmlBody: text("HTML body", 0, 10_000_000).nullable(),
  snippet: text("snippet", 0, 4_096),
  isUnread: z.boolean(),
  labels: z.array(localLabelSchema),
  attachments: z.array(attachmentSummarySchema),
});
export type HydratedMessage = z.infer<typeof hydratedMessageSchema>;

const safePositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const threadSchema = z
  .strictObject({
    threadId: threadIdSchema,
    resolvedFromThreadId: threadIdSchema.nullable(),
    subject: text("subject", 1, 998).nullable(),
    participants: z.array(emailAddressSchema).max(256),
    participantsTruncated: z.boolean(),
    messageCount: safePositiveInteger,
    messageIds: z.array(messageIdSchema).max(100),
    messages: z.array(hydratedMessageSchema).max(100),
    firstReceivedAt: retrievalInstantSchema,
    lastReceivedAt: retrievalInstantSchema,
    nextCursor: opaqueThreadCursorSchema.nullable(),
  })
  .superRefine((thread, context) => {
    if (thread.resolvedFromThreadId === thread.threadId)
      context.addIssue({
        code: "custom",
        path: ["resolvedFromThreadId"],
        message: "resolvedFromThreadId must be a distinct alias",
      });
    if (thread.messageIds.length !== thread.messages.length)
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: "messageIds and messages must have the same length",
      });
    if (thread.messageIds.length === 0 && thread.nextCursor !== null)
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "an empty page must not have a next cursor",
      });
    if (thread.messageCount < thread.messageIds.length)
      context.addIssue({
        code: "custom",
        path: ["messageCount"],
        message: "messageCount must include the returned page",
      });
    if (Date.parse(thread.firstReceivedAt) > Date.parse(thread.lastReceivedAt))
      context.addIssue({
        code: "custom",
        path: ["firstReceivedAt"],
        message: "firstReceivedAt must not be later than lastReceivedAt",
      });
    thread.messages.forEach((message, index) => {
      if (thread.messageIds[index] !== message.messageId)
        context.addIssue({
          code: "custom",
          path: ["messages", index, "messageId"],
          message: "message order must match messageIds",
        });
      if (message.threadId !== thread.threadId)
        context.addIssue({
          code: "custom",
          path: ["messages", index, "threadId"],
          message: "hydrated message must carry the canonical thread ID",
        });
    });
  });
export type RetrievedThread = z.infer<typeof threadSchema>;

const notFoundDetailsSchema = z.discriminatedUnion("resource", [
  z.strictObject({ resource: z.literal("message"), id: messageIdSchema }),
  z.strictObject({ resource: z.literal("thread"), id: threadIdSchema }),
  z.strictObject({ resource: z.literal("raw-message"), id: messageIdSchema }),
  z.strictObject({ resource: z.literal("attachment"), id: attachmentIdSchema }),
]);

/** Stable public absence outcome shared by every retrieval operation. */
export const retrievalNotFoundErrorSchema = z.strictObject({
  code: z.literal("not_found"),
  message: text("error message", 1, 500),
  correlationId: text("correlation ID", 1, 200),
  details: notFoundDetailsSchema,
});
export type RetrievalNotFoundError = z.infer<typeof retrievalNotFoundErrorSchema>;

function notFoundFor(
  resource: "message" | "thread" | "raw-message" | "attachment",
  idSchema: z.ZodString,
) {
  return z.strictObject({
    code: z.literal("not_found"),
    message: text("error message", 1, 500),
    correlationId: text("correlation ID", 1, 200),
    details: z.strictObject({ resource: z.literal(resource), id: idSchema }),
  });
}

export const messageNotFoundErrorSchema = notFoundFor("message", messageIdSchema);
export const threadNotFoundErrorSchema = notFoundFor("thread", threadIdSchema);
export const rawMessageNotFoundErrorSchema = notFoundFor("raw-message", messageIdSchema);
export const attachmentNotFoundErrorSchema = notFoundFor("attachment", attachmentIdSchema);

const threadInvalidCursorMessage = "thread cursor is invalid";
export const threadInvalidCursorDetailsSchema = z.strictObject({
  resource: z.literal("thread"),
});
export const threadInvalidCursorErrorDefinition = defineError({
  code: "invalid_cursor",
  message: threadInvalidCursorMessage,
  details: threadInvalidCursorDetailsSchema,
});
export const threadRetrievalErrorDefinitions = Object.freeze([threadInvalidCursorErrorDefinition]);
export const threadRetrievalErrorRegistry = createErrorRegistry(threadRetrievalErrorDefinitions);
export const threadErrorDefinitions = threadRetrievalErrorDefinitions;
export const threadErrorRegistry = threadRetrievalErrorRegistry;
export const threadInvalidCursorErrorSchema = z.strictObject({
  code: z.literal("invalid_cursor"),
  message: z.literal(threadInvalidCursorMessage),
  correlationId: correlationIdSchema,
  details: threadInvalidCursorDetailsSchema,
});
export type ThreadInvalidCursorError = z.infer<typeof threadInvalidCursorErrorSchema>;

export const messageResponseSchema = z.union([
  z.strictObject({ message: hydratedMessageSchema }),
  messageNotFoundErrorSchema,
]);
export type MessageResponse = z.infer<typeof messageResponseSchema>;

export const threadSuccessResponseSchema = z.strictObject({ thread: threadSchema });
export type ThreadSuccessResponse = z.infer<typeof threadSuccessResponseSchema>;

export const threadResponseSchema = z.union([
  threadSuccessResponseSchema,
  threadNotFoundErrorSchema,
  threadInvalidCursorErrorSchema,
]);
export type ThreadResponse = z.infer<typeof threadResponseSchema>;

/** Metadata is returned before/alongside the byte stream, never as fake bytes. */
export const streamMetadataSchema = z.strictObject({
  contentType: text("content type", 1, 255),
  contentLength: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u, "digest must be SHA-256 hex"),
  filename: text("filename", 1, 4_096).nullable(),
});
export type StreamMetadata = z.infer<typeof streamMetadataSchema>;

export const rawMessageResponseSchema = z.union([
  streamMetadataSchema,
  rawMessageNotFoundErrorSchema,
]);
export type RawMessageResponse = z.infer<typeof rawMessageResponseSchema>;

export const attachmentResponseSchema = z.union([
  z.strictObject({
    attachmentId: attachmentIdSchema,
    messageId: messageIdSchema,
    metadata: streamMetadataSchema,
  }),
  attachmentNotFoundErrorSchema,
]);
export type AttachmentResponse = z.infer<typeof attachmentResponseSchema>;

export const messageRequestSchema = z.strictObject({ messageId: messageIdSchema });
export const threadRequestSchema = z.strictObject({
  threadId: threadIdSchema,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: opaqueThreadCursorSchema.optional(),
});
export type ThreadRequest = z.infer<typeof threadRequestSchema>;

/**
 * Validate the request-dependent part of a parsed thread success response.
 *
 * Callers must parse untrusted request and response data with
 * `threadRequestSchema` and `threadSuccessResponseSchema` first. This typed
 * boundary then applies the live pagination rule shared by storage, HTTP, and
 * CLI consumers without coupling the contract to any transport.
 */
export function validateThreadSuccess(
  request: ThreadRequest,
  response: ThreadSuccessResponse,
): ThreadSuccessResponse {
  const pageLength = response.thread.messageIds.length;
  if (pageLength > request.limit)
    throw new z.ZodError([
      {
        code: "custom",
        path: ["thread", "messageIds"],
        message: "thread page must not exceed the requested limit",
      },
    ]);
  if (request.cursor === undefined && pageLength === 0)
    throw new z.ZodError([
      {
        code: "custom",
        path: ["thread", "messageIds"],
        message: "an initial thread page must not be empty",
      },
    ]);
  if (pageLength === 0 && response.thread.nextCursor !== null)
    throw new z.ZodError([
      {
        code: "custom",
        path: ["thread", "nextCursor"],
        message: "an empty page must not have a next cursor",
      },
    ]);
  return response;
}
export const rawMessageRequestSchema = z.strictObject({ messageId: messageIdSchema });
export const attachmentRequestSchema = z.strictObject({ attachmentId: attachmentIdSchema });

export const searchOperation = defineOperation({
  key: "messages.search",
  route: "/v1/messages/search",
  cliName: "messages-search",
  scope: "mail:read.search",
  request: searchRequestSchema,
  response: searchPageSchema,
  streaming: "none",
  strictness: "strict",
});

export const messageOperation = defineOperation({
  key: "messages.get",
  route: "/v1/messages/{messageId}",
  cliName: "messages-get",
  scope: "mail:read.message",
  request: messageRequestSchema,
  response: messageResponseSchema,
  streaming: "none",
  strictness: "strict",
});
export const messageRetrievalOperation = messageOperation;

export const threadOperation = defineOperation({
  key: "threads.get",
  route: "/v1/threads/{threadId}",
  cliName: "threads-get",
  scope: "mail:read.thread",
  request: threadRequestSchema,
  response: threadResponseSchema,
  streaming: "none",
  strictness: "strict",
});
export const threadRetrievalOperation = threadOperation;

export const rawMessageOperation = defineOperation({
  key: "messages.raw",
  route: "/v1/messages/{messageId}/raw",
  cliName: "messages-raw",
  scope: "mail:read.raw",
  request: rawMessageRequestSchema,
  response: rawMessageResponseSchema,
  streaming: "bytes",
  strictness: "strict",
});
export const rawMessageRetrievalOperation = rawMessageOperation;

export const attachmentOperation = defineOperation({
  key: "attachments.get",
  route: "/v1/attachments/{attachmentId}",
  cliName: "attachments-get",
  scope: "mail:read.attachment",
  request: attachmentRequestSchema,
  response: attachmentResponseSchema,
  streaming: "bytes",
  strictness: "strict",
});
export const attachmentRetrievalOperation = attachmentOperation;

export const retrievalOperations = [
  searchOperation,
  messageOperation,
  threadOperation,
  rawMessageOperation,
  attachmentOperation,
] as const satisfies readonly OperationDefinition<OperationSchema, OperationSchema>[];

export const retrievalOperationDefinitions = retrievalOperations;
