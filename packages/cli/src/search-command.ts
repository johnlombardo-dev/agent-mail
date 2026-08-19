import { z } from "zod";
import {
  searchFiltersSchema,
  searchOperation,
  searchPageSchema,
  searchRequestSchema,
  searchResponseSchema,
  type SearchPage,
} from "@agent-mail/contracts";
import {
  classifyCliClientError,
  createCommandValue,
  createLocalError,
  type CommandResultV1,
} from "./command-outcome";
import { CliClient, CliClientError, type CliResponse } from "./client";
import { trustedChrome, untrustedValue, type HumanSegment } from "./output-context";

export const SEARCH_OPERATION_KEY = searchOperation.key;
export const SEARCH_ARGV = Object.freeze(["messages", "search"] as const);

type SearchFiltersInput = z.input<typeof searchFiltersSchema>;
export type SearchRequestInput = z.input<typeof searchRequestSchema>;

export type SearchCommandInput = Readonly<{
  readonly argv: readonly string[];
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

class SearchArgvError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SearchArgvError";
  }
}

type FilterName = keyof SearchFiltersInput;

const optionToFilter: Readonly<Record<string, FilterName>> = Object.freeze({
  "--mailbox-id": "mailboxId",
  "--thread-id": "threadId",
  "--sender": "sender",
  "--subject": "subject",
  "--after": "after",
  "--before": "before",
  "--is-unread": "isUnread",
  "--has-attachment": "hasAttachment",
  "--label": "label",
});

function line(first: HumanSegment, ...rest: HumanSegment[]): [HumanSegment, ...HumanSegment[]] {
  return [first, ...rest];
}

function value(value: unknown): HumanSegment {
  return untrustedValue(String(value));
}

function emailValue(sender: SearchPage["items"][number]["sender"]): string {
  return sender.name === undefined ? sender.address : `${sender.name} <${sender.address}>`;
}

function humanLines(
  page: SearchPage,
): readonly [
  readonly [HumanSegment, ...HumanSegment[]],
  ...(readonly [HumanSegment, ...HumanSegment[]])[],
] {
  type HumanLine = [HumanSegment, ...HumanSegment[]];
  const first = line(trustedChrome("search results:"));
  const lines: [HumanLine, ...HumanLine[]] = [first];
  if (page.items.length === 0) {
    lines.push(line(trustedChrome("No search results.")));
  } else {
    page.items.forEach((hit, index) => {
      lines.push(
        line(trustedChrome(`result ${index + 1}: `), value(hit.subject ?? "(no subject)")),
        line(
          trustedChrome("  message: "),
          value(hit.messageId),
          trustedChrome("  thread: "),
          value(hit.threadId),
        ),
        line(trustedChrome("  sender: "), value(emailValue(hit.sender))),
        line(
          trustedChrome("  received: "),
          value(hit.receivedAt),
          trustedChrome("  sent: "),
          value(hit.sentAt ?? "unknown"),
        ),
        line(trustedChrome("  snippet: "), value(hit.snippet)),
        line(
          trustedChrome("  unread: "),
          value(hit.isUnread),
          trustedChrome("  attachment: "),
          value(hit.hasAttachment),
          trustedChrome("  score: "),
          value(hit.score),
        ),
      );
    });
  }
  lines.push(line(trustedChrome("next cursor: "), value(page.nextCursor ?? "none")));
  return lines;
}

function usageFailure(correlationId: string): CommandResultV1 {
  return {
    version: 1,
    kind: "failure",
    operationKey: SEARCH_OPERATION_KEY,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: "messages search",
      reasonCode: "argv",
    }),
    diagnostics: [],
  };
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new SearchArgvError("boolean filter must be true or false");
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed))
    throw new SearchArgvError("limit must be an integer");
  return parsed;
}

function splitOption(
  token: string,
): Readonly<{ readonly name: string; readonly inline: string | undefined }> {
  const separator = token.indexOf("=");
  if (separator < 0) return { name: token, inline: undefined };
  return {
    name: token.slice(0, separator),
    inline: token.slice(separator + 1),
  };
}

function optionValue(
  option: Readonly<{
    readonly name: string;
    readonly inline: string | undefined;
  }>,
  argv: readonly string[],
  index: number,
  booleanOption: boolean,
): Readonly<{ readonly value: string; readonly nextIndex: number }> {
  if (option.inline !== undefined) return { value: option.inline, nextIndex: index };
  const next = argv[index + 1];
  if (booleanOption && (next === undefined || next.startsWith("--")))
    return { value: "true", nextIndex: index };
  if (next === undefined || next.startsWith("--"))
    throw new SearchArgvError(`missing value for ${option.name}`);
  return { value: next, nextIndex: index + 1 };
}

/**
 * Parse only the command spelling and option transport shape. The shared
 * request schema remains the authority for values and defaults, so omitted
 * fields stay omitted until the client crosses that boundary.
 */
export function parseSearchArgv(argv: readonly string[]): SearchRequestInput {
  if (argv.length < SEARCH_ARGV.length || argv[0] !== SEARCH_ARGV[0] || argv[1] !== SEARCH_ARGV[1])
    throw new SearchArgvError("command path is not messages search");
  let query: string | undefined;
  let limit: number | undefined;
  let cursor: string | undefined;
  const filters: SearchFiltersInput = {};
  const seen = new Set<string>();

  for (let index: number = SEARCH_ARGV.length; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token.length === 0) throw new SearchArgvError("empty argument");
    if (!token.startsWith("--")) {
      if (query !== undefined)
        throw new SearchArgvError("search query was supplied more than once");
      query = token;
      continue;
    }
    const option = splitOption(token);
    if (seen.has(option.name)) throw new SearchArgvError(`duplicate option ${option.name}`);
    seen.add(option.name);
    if (option.name === "--query") {
      if (query !== undefined)
        throw new SearchArgvError("search query was supplied more than once");
      const result = optionValue(option, argv, index, false);
      query = result.value;
      index = result.nextIndex;
      continue;
    }
    if (option.name === "--limit") {
      const result = optionValue(option, argv, index, false);
      limit = parseInteger(result.value);
      index = result.nextIndex;
      continue;
    }
    if (option.name === "--cursor") {
      const result = optionValue(option, argv, index, false);
      cursor = result.value;
      index = result.nextIndex;
      continue;
    }
    const filterName = optionToFilter[option.name];
    if (filterName === undefined) throw new SearchArgvError(`unknown option ${option.name}`);
    const result = optionValue(
      option,
      argv,
      index,
      filterName === "isUnread" || filterName === "hasAttachment",
    );
    switch (filterName) {
      case "isUnread":
        filters.isUnread = parseBoolean(result.value);
        break;
      case "hasAttachment":
        filters.hasAttachment = parseBoolean(result.value);
        break;
      case "mailboxId":
        filters.mailboxId = result.value;
        break;
      case "threadId":
        filters.threadId = result.value;
        break;
      case "sender":
        filters.sender = result.value;
        break;
      case "subject":
        filters.subject = result.value;
        break;
      case "after":
        filters.after = result.value;
        break;
      case "before":
        filters.before = result.value;
        break;
      case "label":
        filters.label = result.value;
        break;
      default: {
        const exhaustive: never = filterName;
        void exhaustive;
        throw new SearchArgvError("unknown filter");
      }
    }
    index = result.nextIndex;
  }
  if (query === undefined) throw new SearchArgvError("search query is required");
  return {
    query,
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** Execute one search page through the shared operation and outcome authority. */
export async function runSearchCommand(input: SearchCommandInput): Promise<CommandResultV1> {
  let request: SearchRequestInput;
  try {
    request = parseSearchArgv(input.argv);
  } catch {
    return usageFailure(input.correlationId);
  }
  try {
    const response: CliResponse = await input.client.request({
      operation: searchOperation,
      input: request,
      signal: input.signal,
    });
    if (response.kind !== "success" || response.operationKey !== SEARCH_OPERATION_KEY)
      throw new CliClientError(
        "client_contract_error",
        SEARCH_OPERATION_KEY,
        "search returned a stream",
      );
    const data = searchResponseSchema.parse(response.data);
    const page = searchPageSchema.safeParse(data);
    return createCommandValue({
      operationKey: SEARCH_OPERATION_KEY,
      data,
      humanLines: page.success ? humanLines(page.data) : [line(trustedChrome("search failed"))],
      diagnostics: [],
    });
  } catch (error: unknown) {
    if (error instanceof CliClientError) return classifyCliClientError(error, input.correlationId);
    return {
      version: 1,
      kind: "failure",
      operationKey: SEARCH_OPERATION_KEY,
      semanticKind: "protocol",
      error: createLocalError("cli.protocol", input.correlationId, {
        operationKey: SEARCH_OPERATION_KEY,
        phase: "result-validation",
      }),
      diagnostics: [],
    };
  }
}
