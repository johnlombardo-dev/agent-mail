import { describe, expect, it } from "bun:test";
import {
  attachmentOperation,
  attachmentResponseSchema,
  hydratedMessageSchema,
  messageOperation,
  messageResponseSchema,
  opaqueSearchCursorSchema,
  rawMessageOperation,
  rawMessageResponseSchema,
  retrievalNotFoundErrorSchema,
  retrievalOperations,
  type RetrievalNotFoundError,
  searchOperation,
  searchPageSchema,
  searchRequestSchema,
  streamMetadataSchema,
  threadInvalidCursorErrorSchema,
  threadErrorRegistry,
  threadRequestSchema,
  threadSuccessResponseSchema,
  opaqueThreadCursorSchema,
  threadOperation,
  threadResponseSchema,
  validateThreadSuccess,
} from "../src/retrieval-operations";

const instant = "2026-01-01T00:00:00Z";
const threadId = `thread:${"a".repeat(64)}`;
const message = {
  messageId: "message:msg-1",
  threadId,
  subject: "Quarterly report",
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [],
  sentAt: instant,
  receivedAt: instant,
  textBody: "The report is attached.",
  htmlBody: null,
  snippet: "The report is attached.",
  isUnread: true,
  labels: ["label:inbox"],
  attachments: [
    {
      attachmentId: "attachment:report-pdf",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 1_024,
    },
  ],
};

function cursor(payload = "receivedAt=2026-01-01T00:00:00Z"): string {
  const envelope = JSON.stringify(["search-cursor-v1", payload, "test-integrity"]);
  let binary = "";
  for (const byte of new TextEncoder().encode(envelope)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function threadCursor(): string {
  const payload = JSON.stringify({
    registryVersion: 1,
    cursorKeyId: "active-key",
    accountScopeDigest: "b".repeat(64),
    requestedThreadHandle: threadId,
    lastSentAtMissingRank: 0,
    lastSentAt: instant,
    lastMessageId: `message:${"c".repeat(64)}`,
  });
  return encodeBase64Url(JSON.stringify(["thread-cursor-v1", payload, "d".repeat(64)]));
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

const notFound = {
  code: "not_found",
  message: "message was not found",
  correlationId: "request-1",
  details: { resource: "message", id: "message:missing" },
} satisfies RetrievalNotFoundError;

describe("retrieval operation contracts", () => {
  it("round-trips a filtered search page with an opaque versioned cursor", () => {
    const request = {
      query: "quarterly report",
      filters: {
        mailboxId: "mailbox:inbox",
        sender: "alice@example.com",
        after: "2025-12-01T00:00:00+00:00",
        before: instant,
        hasAttachment: true,
      },
      limit: 20,
      cursor: cursor(),
    };
    expect(searchRequestSchema.parse(request)).toEqual(request);

    const page = {
      items: [
        {
          messageId: message.messageId,
          threadId: message.threadId,
          subject: message.subject,
          sender: message.from,
          sentAt: message.sentAt,
          receivedAt: message.receivedAt,
          snippet: message.snippet,
          isUnread: message.isUnread,
          hasAttachment: true,
          score: 1.25,
        },
      ],
      nextCursor: cursor("receivedAt=2026-01-02T00:00:00Z"),
    };
    expect(searchPageSchema.parse(page)).toEqual(page);
    expect(opaqueSearchCursorSchema.parse(page.nextCursor)).toBe(page.nextCursor);
  });

  it("round-trips hydrated message and thread success payloads", () => {
    expect(hydratedMessageSchema.parse(message)).toEqual(message);
    expect(messageResponseSchema.parse({ message })).toEqual({ message });
    const thread = {
      threadId: message.threadId,
      resolvedFromThreadId: null,
      subject: message.subject,
      participants: [message.from, ...message.to],
      participantsTruncated: false,
      messageCount: 1,
      messageIds: [message.messageId],
      messages: [message],
      firstReceivedAt: instant,
      lastReceivedAt: instant,
      nextCursor: null,
    };
    expect(threadResponseSchema.parse({ thread })).toEqual({ thread });
  });

  it("round-trips alias provenance and a bounded multi-message page", () => {
    const secondMessage = { ...message, messageId: "message:msg-2", receivedAt: "2026-01-02T00:00:00Z" };
    const alias = `thread:${"f".repeat(64)}`;
    const thread = {
      threadId,
      resolvedFromThreadId: alias,
      subject: null,
      participants: [message.from, ...message.to],
      participantsTruncated: true,
      messageCount: 3,
      messageIds: [message.messageId, secondMessage.messageId],
      messages: [message, secondMessage],
      firstReceivedAt: instant,
      lastReceivedAt: secondMessage.receivedAt,
      nextCursor: threadCursor(),
    };
    expect(threadResponseSchema.parse({ thread })).toEqual({ thread });
    expect(
      threadResponseSchema.safeParse({
        thread: {
          ...thread,
          messageIds: Array.from({ length: 101 }, () => message.messageId),
          messages: Array.from({ length: 101 }, () => message),
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a truthful empty continuation and rejects request-incompatible pages", () => {
    const emptyContinuation = {
      thread: {
        threadId,
        resolvedFromThreadId: null,
        subject: null,
        participants: [],
        participantsTruncated: false,
        messageCount: 3,
        messageIds: [],
        messages: [],
        firstReceivedAt: instant,
        lastReceivedAt: instant,
        nextCursor: null,
      },
    };
    const structural = threadSuccessResponseSchema.parse(emptyContinuation);
    expect(threadResponseSchema.parse(emptyContinuation)).toEqual(emptyContinuation);

    const continuationRequest = threadRequestSchema.parse({
      threadId,
      limit: 2,
      cursor: threadCursor(),
    });
    expect(validateThreadSuccess(continuationRequest, structural)).toEqual(structural);

    expect(() => validateThreadSuccess(threadRequestSchema.parse({ threadId }), structural)).toThrow(
      /initial thread page must not be empty/,
    );
    expect(() =>
      threadResponseSchema.parse({
        thread: { ...emptyContinuation.thread, nextCursor: threadCursor() },
      }),
    ).toThrow(/empty page must not have a next cursor/);

    const twoMessagePage = threadSuccessResponseSchema.parse({
      thread: {
        ...emptyContinuation.thread,
        messageCount: 3,
        messageIds: [message.messageId, "message:msg-2"],
        messages: [message, { ...message, messageId: "message:msg-2" }],
      },
    });
    const narrowContinuationRequest = threadRequestSchema.parse({
      threadId,
      limit: 1,
      cursor: threadCursor(),
    });
    expect(() => validateThreadSuccess(narrowContinuationRequest, twoMessagePage)).toThrow(
      /must not exceed the requested limit/,
    );
  });

  it("applies bounded thread request and cursor contracts", () => {
    expect(threadRequestSchema.parse({ threadId })).toEqual({ threadId, limit: 50 });
    expect(threadRequestSchema.parse({ threadId, limit: 100, cursor: threadCursor() })).toEqual({
      threadId,
      limit: 100,
      cursor: threadCursor(),
    });
    expect(opaqueThreadCursorSchema.parse(threadCursor())).toBe(threadCursor());
    for (const limit of [0, 101, 1.5, Number.NaN])
      expect(threadRequestSchema.safeParse({ threadId, limit }).success).toBe(false);
    expect(threadRequestSchema.safeParse({ threadId, cursor: cursor() }).success).toBe(false);
    expect(
      opaqueThreadCursorSchema.safeParse(`${threadCursor()}x`).success,
    ).toBe(false);
  });

  it("keeps raw and attachment bytes outside strict stream metadata", () => {
    const metadata = {
      contentType: "message/rfc822",
      contentLength: 4_096,
      digest: "a".repeat(64),
      filename: null,
    };
    expect(streamMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(rawMessageResponseSchema.parse(metadata)).toEqual(metadata);
    const attachment = {
      attachmentId: "attachment:report-pdf",
      messageId: message.messageId,
      metadata: { ...metadata, contentType: "application/pdf", filename: "report.pdf" },
    };
    expect(attachmentResponseSchema.parse(attachment)).toEqual(attachment);
    expect(rawMessageOperation.streaming).toBe("bytes");
    expect(attachmentOperation.streaming).toBe("bytes");
  });

  it("uses one stable not_found outcome and rejects null or empty success payloads", () => {
    expect(retrievalNotFoundErrorSchema.parse(notFound)).toEqual(notFound);
    expect(messageResponseSchema.parse(notFound)).toEqual(notFound);
    expect(
      threadResponseSchema.parse({
        ...notFound,
        details: { resource: "thread", id: threadId },
      }),
    ).toMatchObject({ code: "not_found" });
    expect(() =>
      messageResponseSchema.parse({
        ...notFound,
        details: { resource: "message", id: "thread:wrong-namespace" },
      }),
    ).toThrow();

    const invalidCursor = {
      code: "invalid_cursor",
      message: "thread cursor is invalid",
      correlationId: "request-1",
      details: { resource: "thread" },
    };
    expect(threadInvalidCursorErrorSchema.parse(invalidCursor)).toEqual(invalidCursor);
    expect(threadResponseSchema.parse(invalidCursor)).toEqual(invalidCursor);
    expect(threadErrorRegistry.codes).toEqual(["invalid_cursor"]);
    expect(() => threadErrorRegistry.parse({ ...invalidCursor, details: { resource: "thread", sql: "hidden" } })).toThrow();

    for (const value of [null, {}, { message: null }, { thread: null }]) {
      expect(messageResponseSchema.safeParse(value).success).toBe(false);
      expect(threadResponseSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects unvalidated filters, unknown cursor versions, and metadata extras", () => {
    expect(
      searchRequestSchema.safeParse({
        query: "report",
        filters: { mailboxId: "not-a-mailbox" },
        limit: 20,
      }).success,
    ).toBe(false);
    const unknownVersion = cursor().replace(/./u, "A");
    expect(opaqueSearchCursorSchema.safeParse(unknownVersion).success).toBe(false);
    expect(
      streamMetadataSchema.safeParse({
        contentType: "text/plain",
        contentLength: 3,
        digest: "a".repeat(64),
        filename: null,
        bytes: "not-a-stream",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid thread handles, cursor tampering, extras, and page mismatches", () => {
    for (const invalidId of [
      "thread:missing",
      `thread:${"A".repeat(64)}`,
      `thread:${"a".repeat(63)}`,
      `thread:${"a".repeat(64)}\n`,
      `thread:${"a".repeat(64)}-例`,
    ]) {
      expect(threadRequestSchema.safeParse({ threadId: invalidId }).success).toBe(false);
      expect(searchRequestSchema.safeParse({ query: "x", filters: { threadId: invalidId } }).success).toBe(false);
    }
    const validThread = {
      threadId,
      resolvedFromThreadId: null,
      subject: null,
      participants: [],
      participantsTruncated: false,
      messageCount: 1,
      messageIds: [message.messageId],
      messages: [message],
      firstReceivedAt: instant,
      lastReceivedAt: instant,
      nextCursor: null,
    };
    expect(threadResponseSchema.parse({ thread: validThread })).toEqual({ thread: validThread });
    expect(threadResponseSchema.safeParse({ thread: { ...validThread, unknown: true } }).success).toBe(false);
    expect(
      threadResponseSchema.safeParse({
        thread: { ...validThread, messageIds: [], messages: [], nextCursor: null },
      }).success,
    ).toBe(true);
    expect(
      threadResponseSchema.safeParse({ thread: { ...validThread, messages: [{ ...message, messageId: "message:other" }] } }).success,
    ).toBe(false);
    expect(
      threadResponseSchema.safeParse({ thread: { ...validThread, messages: [{ ...message, threadId: `thread:${"e".repeat(64)}` }] } }).success,
    ).toBe(false);
    expect(
      threadResponseSchema.safeParse({ thread: { ...validThread, messageCount: 0 } }).success,
    ).toBe(false);
    expect(
      threadResponseSchema.safeParse({ thread: { ...validThread, participants: Array.from({ length: 257 }, () => message.from) } }).success,
    ).toBe(false);
    expect(
      threadResponseSchema.safeParse({ thread: { ...validThread, resolvedFromThreadId: threadId } }).success,
    ).toBe(false);
  });

  it("defines all five retrieval operations with strict public metadata", () => {
    expect(retrievalOperations.map((operation) => operation.key)).toEqual([
      "messages.search",
      "messages.get",
      "threads.get",
      "messages.raw",
      "attachments.get",
    ]);
    expect(searchOperation.strictness).toBe("strict");
    expect(messageOperation.strictness).toBe("strict");
    expect(threadOperation.strictness).toBe("strict");
  });
});
