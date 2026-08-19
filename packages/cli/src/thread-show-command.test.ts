import { describe, expect, it } from "bun:test";
import { CliClientError } from "./client";
import { executeCommand, type CommandSink } from "./command-outcome";
import { executeThreadShow } from "./thread-show-command";
import { threadShowFixture, unknownThreadError } from "./thread-show.fixtures";

const threadId = threadShowFixture.thread.threadId;

function sink(): CommandSink & { readonly text: () => string } {
  const chunks: Uint8Array[] = [];
  return {
    async write(bytes) {
      chunks.push(bytes.slice());
      return { kind: "written", bytesAccepted: bytes.byteLength };
    },
    text: () => new TextDecoder().decode(
      chunks.reduce((all, chunk) => {
        const next = new Uint8Array(all.byteLength + chunk.byteLength);
        next.set(all);
        next.set(chunk, all.byteLength);
        return next;
      }, new Uint8Array()),
    ),
  };
}

describe("thread show adapter", () => {
  it("maps one request and preserves server message order in both projections", async () => {
    const requests: unknown[] = [];
    const result = await executeThreadShow({
      client: {
        async request(input) {
          requests.push(input);
          return { kind: "success", operationKey: "threads.get", status: 200, data: threadShowFixture };
        },
      },
      threadId,
      correlationId: "corr:success",
    });
    expect(requests).toEqual([
      { operation: "threads.get", input: { threadId, limit: 50 }, signal: undefined },
    ]);
    expect(result.kind).toBe("value");
    if (result.kind !== "value") throw new Error("expected value result");
    expect(result.semanticKind).toBe("success");
    expect(result.data).toEqual(threadShowFixture);
    expect(result.humanLines.map((line) => line.map((segment) => segment.text).join(""))).toEqual([
      `Thread ${threadId}`,
      "Subject: Quarterly review",
      "Messages: 2",
      `Resolved from: ${threadShowFixture.thread.resolvedFromThreadId}`,
      "Participants: Ava <ava@example.com>",
      "1. message:first Quarterly review",
      "2. message:second Re: Quarterly review",
    ]);
  });

  it("keeps unknown threads as the shared not-found failure", async () => {
    const result = await executeThreadShow({
      client: {
        async request() {
          throw new CliClientError("http_error", "threads.get", "not found", {
            status: 404,
            serverError: unknownThreadError,
          });
        },
      },
      threadId,
      correlationId: "corr:unknown",
    });
    expect(result.kind).toBe("failure");
    if (result.kind !== "failure") throw new Error("expected failure result");
    expect(result.semanticKind).toBe("not_found");
    expect(result.error).toEqual(unknownThreadError);
  });

  it("rejects invalid identifiers without calling the client", async () => {
    let calls = 0;
    const result = await executeThreadShow({
      client: { async request() { calls += 1; throw new Error("must not call"); } },
      threadId: "thread:invalid",
      correlationId: "corr:invalid",
    });
    expect(calls).toBe(0);
    expect(result.kind).toBe("failure");
    if (result.kind !== "failure") throw new Error("expected failure result");
    expect(result.semanticKind).toBe("invalid_input");
  });

  it("returns executable protocol failure for a stream or mismatched operation", async () => {
    for (const response of [
      {
        kind: "stream",
        operationKey: "threads.get",
        status: 200,
        stream: {
          operationKey: "threads.get",
          body: (async function* () {})(),
          cancel: async () => {},
        },
      },
      { kind: "success", operationKey: "messages.get", status: 200, data: threadShowFixture },
    ] as const) {
      const result = await executeThreadShow({
        client: { async request() { return response; } },
        threadId,
        correlationId: "corr:protocol",
      });
      expect(result.kind).toBe("failure");
      if (result.kind !== "failure") throw new Error("expected failure result");
      expect(result.semanticKind).toBe("protocol");
      const stdout = sink();
      const stderr = sink();
      const receipt = await executeCommand(result, {
        invocationCorrelationId: "corr:protocol",
        mode: "json",
        stdout,
        stderr,
        rawPolicy: { destination: "pipe", tty: "refuse" },
        signal: new AbortController().signal,
      });
      expect(receipt.semanticKind).toBe("protocol");
      expect(receipt.exitCode).toBe(76);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe(`${JSON.stringify(result.error)}\n`);
    }
  });
});
