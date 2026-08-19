import {
  threadRequestSchema,
  threadSuccessResponseSchema,
  validateThreadSuccess,
  type ThreadRequest,
  type ThreadSuccessResponse,
} from "@agent-mail/contracts";
import { CliClientError, type CliClient, type CliResponse } from "./client";
import {
  classifyCliClientError,
  createCommandFailure,
  createCommandValue,
  createLocalError,
  type CommandResultV1,
} from "./command-outcome";
import { trustedChrome, untrustedValue, type HumanSegment } from "./output-context";

const OPERATION_KEY = "threads.get";

export type ThreadShowClient = Pick<CliClient, "request">;
export type ThreadShowOptions = Readonly<{
  readonly client: ThreadShowClient;
  readonly threadId: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

function text(value: string | null): HumanSegment {
  return untrustedValue(value ?? "");
}

function line(
  first: HumanSegment,
  ...rest: HumanSegment[]
): readonly [HumanSegment, ...HumanSegment[]] {
  return [first, ...rest];
}

function humanLines(
  response: ThreadSuccessResponse,
): readonly [
  readonly [HumanSegment, ...HumanSegment[]],
  ...(readonly [HumanSegment, ...HumanSegment[]])[],
] {
  const { thread } = response;
  const first = line(trustedChrome("Thread "), text(thread.threadId));
  const rest: Array<readonly [HumanSegment, ...HumanSegment[]]> = [
    line(trustedChrome("Subject: "), text(thread.subject ?? "")),
    line(
      trustedChrome("Messages: "),
      untrustedValue(String(thread.messageCount)),
      trustedChrome(thread.messageIds.length === 0 ? " (page exhausted)" : ""),
    ),
  ];
  if (thread.resolvedFromThreadId !== null)
    rest.push(line(trustedChrome("Resolved from: "), text(thread.resolvedFromThreadId)));
  if (thread.participants.length > 0) {
    rest.push(
      line(
        trustedChrome("Participants: "),
        untrustedValue(
          thread.participants
            .map(({ name, address }) => (name === undefined ? address : `${name} <${address}>`))
            .join(", "),
        ),
      ),
    );
  }
  for (const [index, message] of thread.messages.entries())
    rest.push(
      line(
        trustedChrome(`${index + 1}. `),
        text(message.messageId),
        trustedChrome(" "),
        text(message.subject ?? ""),
      ),
    );
  return [first, ...rest];
}

function invalidRequest(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: OPERATION_KEY,
    semanticKind: "invalid_input",
    error: createLocalError("cli.invalid-input", correlationId, {
      operationKey: OPERATION_KEY,
      reasonCode: "request",
    }),
  });
}

function protocolFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: OPERATION_KEY,
    semanticKind: "protocol",
    error: createLocalError("cli.protocol", correlationId, {
      operationKey: OPERATION_KEY,
      phase: "result-validation",
    }),
  });
}

/** Execute exactly one validated thread page request through the shared client. */
export async function executeThreadShow(options: ThreadShowOptions): Promise<CommandResultV1> {
  const input = {
    threadId: options.threadId,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  };
  let request: ThreadRequest;
  try {
    request = threadRequestSchema.parse(input);
  } catch {
    return invalidRequest(options.correlationId);
  }

  let result: CliResponse;
  try {
    result = await options.client.request({
      operation: OPERATION_KEY,
      input: request,
      signal: options.signal,
    });
  } catch (error: unknown) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    throw error;
  }
  if (result.kind !== "success" || result.operationKey !== OPERATION_KEY)
    return protocolFailure(options.correlationId);

  let response: ThreadSuccessResponse;
  try {
    response = threadSuccessResponseSchema.parse(result.data);
    response = validateThreadSuccess(request, response);
  } catch {
    return protocolFailure(options.correlationId);
  }
  return createCommandValue({
    operationKey: OPERATION_KEY,
    data: response,
    semanticKind: "success",
    humanLines: humanLines(response),
  });
}

export const executeThreadShowCommand = executeThreadShow;
export const threadShow = executeThreadShow;
