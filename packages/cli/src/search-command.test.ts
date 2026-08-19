import { describe, expect, it } from "bun:test";
import {
  publicErrorEnvelopeSchema,
  searchInvalidCursorErrorDefinition,
  searchInvalidQueryErrorDefinition,
} from "@agent-mail/contracts";
import {
  CliClientError,
  type CliRequestOptions,
  type CliResponse,
} from "./client";
import {
  parseSearchArgv,
  runSearchCommand,
  SEARCH_OPERATION_KEY,
} from "./search-command";

const hex = "a".repeat(64);
const cursor = btoa(JSON.stringify(["search-cursor-v1", "payload", "digest"]))
  .replaceAll("=", "")
  .replaceAll("+", "-")
  .replaceAll("/", "_");

const page = {
  items: [
    {
      messageId: `message:${hex}`,
      threadId: `thread:${"b".repeat(64)}`,
      subject: "Quarterly report",
      sender: { name: "Alice", address: "alice@example.com" },
      sentAt: "2026-08-19T00:00:00Z",
      receivedAt: "2026-08-19T00:00:01Z",
      snippet: "The report is attached.",
      isUnread: false,
      hasAttachment: true,
      score: 1.5,
    },
  ],
  nextCursor: cursor,
};

function errorEnvelope(
  definition: Readonly<{ readonly code: string; readonly message?: string }>,
  correlationId = "request:test",
) {
  if (definition.message === undefined)
    throw new Error("fixture error needs a fixed message");
  return publicErrorEnvelopeSchema.parse({
    code: definition.code,
    message: definition.message,
    correlationId,
    details: { resource: "search" },
  });
}

type FakeClient = {
  request: (input: CliRequestOptions) => Promise<CliResponse>;
  calls: CliRequestOptions[];
};

function fakeClient(data: unknown): FakeClient {
  const calls: CliRequestOptions[] = [];
  return {
    calls,
    request: async (input: CliRequestOptions): Promise<CliResponse> => {
      calls.push(input);
      return {
        kind: "success",
        operationKey: SEARCH_OPERATION_KEY,
        status: 200,
        data,
      };
    },
  };
}

describe("search command adapter", () => {
  it("keeps omitted filters, limits, and cursors absent while preserving explicit values", () => {
    expect(parseSearchArgv(["messages", "search", "invoice"])).toEqual({
      query: "invoice",
    });
    expect(
      parseSearchArgv([
        "messages",
        "search",
        "--query",
        "invoice",
        "--mailbox-id",
        "mailbox:inbox",
        "--is-unread=false",
        "--has-attachment",
        "false",
        "--limit=50",
        `--cursor=${cursor}`,
      ]),
    ).toEqual({
      query: "invoice",
      filters: {
        mailboxId: "mailbox:inbox",
        isUnread: false,
        hasAttachment: false,
      },
      limit: 50,
      cursor,
    });
  });

  it("uses one shared search request and returns canonical page data without hydration", async () => {
    const client = fakeClient(page);
    const result = await runSearchCommand({
      argv: ["messages", "search", "invoice"],
      client,
      correlationId: "cli:test",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      input: { query: "invoice" },
      signal: undefined,
    });
    const captured = client.calls[0];
    if (
      typeof captured !== "object" ||
      captured === null ||
      !("operation" in captured)
    )
      return;
    expect(captured.operation).toMatchObject({ key: SEARCH_OPERATION_KEY });
    expect(result.kind).toBe("value");
    if (result.kind !== "value") return;
    expect(result.operationKey).toBe(SEARCH_OPERATION_KEY);
    expect(result.data).toEqual(page);
    expect(result.semanticKind).toBe("success");
    expect(
      result.humanLines
        .flat()
        .some(
          (segment) =>
            segment.kind === "untrusted-value" &&
            segment.text === "The report is attached.",
        ),
    ).toBe(true);
  });

  it("keeps an empty page as successful canonical output", async () => {
    const client = fakeClient({ items: [], nextCursor: null });
    const result = await runSearchCommand({
      argv: ["messages", "search", "missing"],
      client,
      correlationId: "cli:test",
    });
    expect(result).toMatchObject({
      kind: "value",
      operationKey: SEARCH_OPERATION_KEY,
      semanticKind: "success",
      data: { items: [], nextCursor: null },
    });
  });

  it("maps registered invalid query and cursor responses to invalid_input", async () => {
    const invalidQueryClient = fakeClient(
      errorEnvelope(searchInvalidQueryErrorDefinition),
    );
    const invalidQuery = await runSearchCommand({
      argv: ["messages", "search", "bad NEAR expression"],
      client: invalidQueryClient,
      correlationId: "cli:test",
    });
    expect(invalidQuery).toMatchObject({
      kind: "failure",
      semanticKind: "invalid_input",
      error: { code: "invalid_query", message: "invalid search query" },
    });

    const invalidCursorClient = fakeClient(
      errorEnvelope(searchInvalidCursorErrorDefinition),
    );
    const invalidCursor = await runSearchCommand({
      argv: ["messages", "search", "invoice", `--cursor=${cursor}`],
      client: invalidCursorClient,
      correlationId: "cli:test",
    });
    expect(invalidCursor).toMatchObject({
      kind: "failure",
      semanticKind: "invalid_input",
      error: { code: "invalid_cursor", message: "search cursor is invalid" },
    });
  });

  it("does not turn an invalid expression into exit-0 empty results", async () => {
    const client = fakeClient(errorEnvelope(searchInvalidQueryErrorDefinition));
    const result = await runSearchCommand({
      argv: ["messages", "search", "unterminated NEAR"],
      client,
      correlationId: "cli:test",
    });
    expect(result.kind).toBe("failure");
    expect(result).not.toMatchObject({
      kind: "value",
      semanticKind: "success",
      data: { items: [] },
    });
  });

  it("preserves authorization and timeout categories from the shared client", async () => {
    const authorization = fakeClient(page);
    authorization.request = async (
      _input: CliRequestOptions,
    ): Promise<CliResponse> => {
      throw new CliClientError(
        "http_error",
        SEARCH_OPERATION_KEY,
        "forbidden",
        {
          status: 403,
          serverError: publicErrorEnvelopeSchema.parse({
            code: "insufficient_scope",
            message: "insufficient scope",
            correlationId: "request:test",
            details: {},
          }),
        },
      );
    };
    const authResult = await runSearchCommand({
      argv: ["messages", "search", "invoice"],
      client: authorization,
      correlationId: "cli:test",
    });
    expect(authResult).toMatchObject({
      kind: "failure",
      semanticKind: "authorization",
      error: { code: "insufficient_scope" },
    });

    const timeout = fakeClient(page);
    timeout.request = async (
      _input: CliRequestOptions,
    ): Promise<CliResponse> => {
      throw new CliClientError(
        "control_timeout",
        SEARCH_OPERATION_KEY,
        "deadline",
      );
    };
    const timeoutResult = await runSearchCommand({
      argv: ["messages", "search", "invoice"],
      client: timeout,
      correlationId: "cli:test",
    });
    expect(timeoutResult).toMatchObject({
      kind: "failure",
      semanticKind: "temporary",
      error: { code: "cli.control-timeout" },
    });
  });
});
