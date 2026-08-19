import {
  messageRequestSchema,
  hydratedMessageSchema,
  type HydratedMessage,
} from "@agent-mail/contracts";
import {
  classifyCliClientError,
  createCommandFailure,
  createCommandValue,
  createLocalError,
  type CommandResultV1,
} from "./command-outcome";
import { CliClientError, type CliClient } from "./client";
import { trustedChrome, untrustedValue, type HumanSegment } from "./output-context";

/** The message-show adapter owns no policy beyond the shared request/response boundary. */
export type MessageShowOptions = Readonly<{
  readonly client: Pick<CliClient, "request">;
  readonly messageId: unknown;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

function value(value: string | null): HumanSegment {
  return untrustedValue(value ?? "");
}

function address(valueToRender: HydratedMessage["from"]): string {
  return valueToRender.name === undefined
    ? valueToRender.address
    : `${valueToRender.name} <${valueToRender.address}>`;
}

function recipients(values: HydratedMessage["to"]): string {
  return values.map(address).join(", ");
}

function humanLines(
  message: HydratedMessage,
): readonly [
  readonly [HumanSegment, ...HumanSegment[]],
  ...(readonly [HumanSegment, ...HumanSegment[]])[],
] {
  const lines: [HumanSegment, ...HumanSegment[]][] = [
    [trustedChrome("message: "), value(message.messageId)],
    [trustedChrome("thread: "), value(message.threadId)],
    [trustedChrome("subject: "), value(message.subject)],
    [trustedChrome("from: "), value(address(message.from))],
    [trustedChrome("to: "), value(recipients(message.to))],
    [trustedChrome("cc: "), value(recipients(message.cc))],
    [trustedChrome("sent: "), value(message.sentAt)],
    [trustedChrome("received: "), value(message.receivedAt)],
    [trustedChrome("snippet: "), value(message.snippet)],
    [trustedChrome("text: "), value(message.textBody)],
    [trustedChrome("html: "), value(message.htmlBody)],
    [trustedChrome("unread: "), value(String(message.isUnread))],
    [trustedChrome("labels: "), value(message.labels.join(", "))],
    [
      trustedChrome("attachments: "),
      value(message.attachments.map(({ filename }) => filename).join(", ")),
    ],
  ];
  const [first, ...rest] = lines;
  if (first === undefined) throw new TypeError("message human projection is empty");
  return [first, ...rest];
}

/** Fetch and classify one canonical message. The client is called exactly once. */
export async function executeMessageShow(options: MessageShowOptions): Promise<CommandResultV1> {
  const operationKey = "messages.get";
  const request = messageRequestSchema.safeParse({ messageId: options.messageId });
  if (!request.success) {
    return createCommandFailure({
      operationKey,
      semanticKind: "invalid_input",
      error: createLocalError("cli.invalid-input", options.correlationId, {
        operationKey,
        reasonCode: "invalid-message-id",
      }),
    });
  }

  try {
    const response = await options.client.request({
      operation: operationKey,
      input: request.data,
      signal: options.signal,
    });
    if (response.kind !== "success" || response.operationKey !== operationKey)
      return createCommandFailure({
        operationKey,
        semanticKind: "protocol",
        error: createLocalError("cli.protocol", options.correlationId, {
          operationKey,
          phase: "result-validation",
        }),
      });
    const messageResponse = response.data;
    const messageValue =
      typeof messageResponse === "object" &&
      messageResponse !== null &&
      "message" in messageResponse
        ? messageResponse.message
        : undefined;
    const message =
      messageValue === undefined ? undefined : hydratedMessageSchema.safeParse(messageValue);
    try {
      return createCommandValue({
        operationKey,
        data: messageResponse,
        humanLines:
          message === undefined || !message.success
            ? [[trustedChrome("message: "), value(request.data.messageId)]]
            : humanLines(message.data),
      });
    } catch {
      return createCommandFailure({
        operationKey,
        semanticKind: "protocol",
        error: createLocalError("cli.protocol", options.correlationId, {
          operationKey,
          phase: "result-validation",
        }),
      });
    }
  } catch (error) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    throw error;
  }
}

export const messageShow = executeMessageShow;
