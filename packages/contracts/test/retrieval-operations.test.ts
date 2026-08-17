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
  threadOperation,
  threadResponseSchema,
} from "../src/retrieval-operations";

const instant = "2026-01-01T00:00:00Z";
const message = {
  messageId: "message:msg-1",
  threadId: "thread:thread-1",
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
      subject: message.subject,
      participants: [message.from, ...message.to],
      messageIds: [message.messageId],
      messages: [message],
      firstReceivedAt: instant,
      lastReceivedAt: instant,
    };
    expect(threadResponseSchema.parse({ thread })).toEqual({ thread });
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
        details: { resource: "thread", id: "thread:missing" },
      }),
    ).toMatchObject({ code: "not_found" });
    expect(() =>
      messageResponseSchema.parse({
        ...notFound,
        details: { resource: "message", id: "thread:wrong-namespace" },
      }),
    ).toThrow();

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
