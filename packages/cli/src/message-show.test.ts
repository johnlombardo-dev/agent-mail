import { describe, expect, it } from "bun:test";
import { executeCommand, type CommandSink, type SinkWriteResultV1 } from "./command-outcome";
import { CliClientError } from "./client";
import { executeMessageShow } from "./message-show";

const messageId = "message:known";
const hostileMessage = {
  messageId,
  threadId: `thread:${"a".repeat(64)}`,
  subject: "<script>ignore this link</script>",
  from: { name: "Sender", address: "sender@example.com" },
  to: [{ address: "recipient@example.com" }],
  cc: [],
  sentAt: "2026-08-19T00:00:00Z",
  receivedAt: "2026-08-19T00:00:01Z",
  textBody: "See javascript:alert(1) and https://example.test/?next=run",
  htmlBody: "<a href=\"javascript:alert(1)\">click</a>",
  snippet: "untrusted snippet",
  isUnread: true,
  labels: ["label:inbox"],
  attachments: [{
    attachmentId: "attachment:file",
    filename: "invoice <open>.pdf",
    contentType: "application/pdf",
    sizeBytes: 12,
  }],
} as const;

function sink(): CommandSink & { readonly bytes: Uint8Array[] } {
  const bytes: Uint8Array[] = [];
  return {
    bytes,
    async write(value): Promise<SinkWriteResultV1> {
      bytes.push(value.slice());
      return { kind: "written", bytesAccepted: value.byteLength };
    },
  };
}

function context(stdout: CommandSink, stderr: CommandSink, mode: "json" | "human" = "json") {
  return {
    invocationCorrelationId: "cli:message-show-test",
    mode,
    stdout,
    stderr,
    rawPolicy: { destination: "pipe" as const, tty: "refuse" as const },
    signal: new AbortController().signal,
  };
}

describe("message show adapter", () => {
  it("maps one canonical identifier to one request and preserves the validated value", async () => {
    const calls: unknown[] = [];
    const result = await executeMessageShow({
      client: {
        request: async (request) => {
          calls.push(request);
          return { kind: "success", operationKey: "messages.get", status: 200, data: { message: hostileMessage } };
        },
      },
      messageId,
      correlationId: "cli:known",
    });
    expect(calls).toEqual([{ operation: "messages.get", input: { messageId } }]);
    const stdout = sink();
    const stderr = sink();
    const receipt = await executeCommand(result, context(stdout, stderr));
    expect(receipt).toMatchObject({ semanticKind: "success", exitCode: 0 });
    expect(new TextDecoder().decode(stdout.bytes[0])).toBe(`${JSON.stringify({ message: hostileMessage })}\n`);
    expect(stderr.bytes).toHaveLength(0);
  });

  it("keeps registered unknown/tombstoned absence on stderr with not_found/66", async () => {
    const result = await executeMessageShow({
      client: {
        request: async () => ({
          kind: "success",
          operationKey: "messages.get",
          status: 200,
          data: {
            code: "not_found",
            message: "message is unavailable",
            correlationId: "request:missing",
            details: { resource: "message", id: "message:missing" },
          },
        }),
      },
      messageId: "message:missing",
      correlationId: "cli:missing",
    });
    const stdout = sink();
    const stderr = sink();
    const receipt = await executeCommand(result, context(stdout, stderr));
    expect(receipt).toMatchObject({ semanticKind: "not_found", exitCode: 66 });
    expect(stdout.bytes).toHaveLength(0);
    expect(new TextDecoder().decode(stderr.bytes[0])).toContain('"code":"not_found"');
  });

  it("renders hostile content as inert human values", async () => {
    const result = await executeMessageShow({
      client: {
        request: async () => ({ kind: "success", operationKey: "messages.get", status: 200, data: { message: hostileMessage } }),
      },
      messageId,
      correlationId: "cli:human",
    });
    const stdout = sink();
    const stderr = sink();
    const receipt = await executeCommand(result, context(stdout, stderr, "human"));
    const rendered = new TextDecoder().decode(stdout.bytes[0]);
    expect(receipt).toMatchObject({ semanticKind: "success", exitCode: 0 });
    expect(rendered).toContain("<script>ignore this link</script>");
    expect(rendered).toContain("javascript:alert(1)");
    expect(stderr.bytes).toHaveLength(0);
  });

  it("rejects invalid identifiers without making a request", async () => {
    let calls = 0;
    const result = await executeMessageShow({
      client: { request: async () => { calls += 1; throw new Error("must not request"); } },
      messageId: "not-canonical",
      correlationId: "cli:invalid",
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
  });

  it("maps authorization through the shared client classifier", async () => {
    const result = await executeMessageShow({
      client: {
        request: async () => {
          throw new CliClientError("http_error", "messages.get", "forbidden", {
            status: 403,
            serverError: {
              code: "insufficient_scope",
              message: "insufficient scope",
              correlationId: "request:auth",
              details: {},
            },
          });
        },
      },
      messageId,
      correlationId: "cli:auth",
    });
    expect(result).toMatchObject({ kind: "failure", semanticKind: "authorization" });
  });

  it("does not turn unknown message into an empty successful value", async () => {
    const result = await executeMessageShow({
      client: {
        request: async () => ({ kind: "success", operationKey: "messages.get", status: 200, data: {} }),
      },
      messageId,
      correlationId: "cli:counterexample",
    });
    expect(result).toMatchObject({ kind: "failure", semanticKind: "protocol" });
  });

  it("rejects a success response from a different operation", async () => {
    const result = await executeMessageShow({
      client: {
        request: async () => ({
          kind: "success",
          operationKey: "threads.get",
          status: 200,
          data: { message: hostileMessage },
        }),
      },
      messageId,
      correlationId: "cli:wrong-operation",
    });
    expect(result).toMatchObject({
      kind: "failure",
      operationKey: "messages.get",
      semanticKind: "protocol",
      error: {
        code: "cli.protocol",
        correlationId: "cli:wrong-operation",
      },
    });
    const stdout = sink();
    const stderr = sink();
    const receipt = await executeCommand(result, context(stdout, stderr));
    expect(receipt).toMatchObject({ semanticKind: "protocol", exitCode: 76 });
    expect(stdout.bytes).toHaveLength(0);
  });
});
