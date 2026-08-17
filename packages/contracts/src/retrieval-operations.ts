import { z } from "zod";
import {
  defineOperation,
  type OperationDefinition,
  type OperationSchema,
} from "./operation-registry";
import { localLabelSchema } from "./routing-operations";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

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
const threadIdSchema = namespacedId("thread");
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

export const threadSchema = z.strictObject({
  threadId: threadIdSchema,
  subject: text("subject", 1, 998).nullable(),
  participants: z.array(emailAddressSchema),
  messageIds: z.array(messageIdSchema).min(1),
  messages: z.array(hydratedMessageSchema).min(1),
  firstReceivedAt: retrievalInstantSchema,
  lastReceivedAt: retrievalInstantSchema,
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

export const messageResponseSchema = z.union([
  z.strictObject({ message: hydratedMessageSchema }),
  messageNotFoundErrorSchema,
]);
export type MessageResponse = z.infer<typeof messageResponseSchema>;

export const threadResponseSchema = z.union([
  z.strictObject({ thread: threadSchema }),
  threadNotFoundErrorSchema,
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
export const threadRequestSchema = z.strictObject({ threadId: threadIdSchema });
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
