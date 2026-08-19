import {
  attachmentOperation,
  attachmentRequestSchema,
  rawMessageOperation,
  rawMessageRequestSchema,
} from "@agent-mail/contracts";
import {
  classifyCliClientError,
  createCommandFailure,
  createCommandRaw,
  createLocalError,
  type CommandResultV1,
} from "./command-outcome";
import { CliClientError, type CliClient, type CliResponse } from "./client";

export type RawContentCommandOptions = Readonly<{
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

export type RawContentTarget =
  | Readonly<{ readonly kind: "raw-message"; readonly id: unknown }>
  | Readonly<{ readonly kind: "attachment"; readonly id: unknown }>;

const rawMessageOperationKey = rawMessageOperation.key;
const attachmentOperationKey = attachmentOperation.key;

function invalidInput(
  operationKey: string,
  correlationId: string,
  reasonCode: "invalid-message-id" | "invalid-attachment-id",
): CommandResultV1 {
  return createCommandFailure({
    operationKey,
    semanticKind: "invalid_input",
    error: createLocalError("cli.invalid-input", correlationId, { operationKey, reasonCode }),
  });
}

function protocolFailure(operationKey: string, correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey,
    semanticKind: "protocol",
    error: createLocalError("cli.protocol", correlationId, {
      operationKey,
      phase: "result-validation",
    }),
  });
}

function internalFailure(operationKey: string, correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey,
    semanticKind: "internal",
    error: createLocalError("cli.internal", correlationId, {
      operationKey,
      phase: "request",
    }),
  });
}

async function executeValidatedRawRequest(
  operation: typeof rawMessageOperation | typeof attachmentOperation,
  input: Readonly<Record<string, string>>,
  options: RawContentCommandOptions,
): Promise<CommandResultV1> {
  try {
    const response: CliResponse = await options.client.request({
      operation,
      input,
      signal: options.signal,
    });
    if (response.kind !== "stream" || response.operationKey !== operation.key)
      return protocolFailure(operation.key, options.correlationId);
    try {
      return createCommandRaw({ operationKey: operation.key, stream: response.stream });
    } catch {
      return protocolFailure(operation.key, options.correlationId);
    }
  } catch (error: unknown) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    return internalFailure(operation.key, options.correlationId);
  }
}

/** Execute the exact shared raw-message request and return a raw command result. */
export async function executeRawMessageCommand(
  messageId: unknown,
  options: RawContentCommandOptions,
): Promise<CommandResultV1> {
  const request = rawMessageRequestSchema.safeParse({ messageId });
  if (!request.success)
    return invalidInput(rawMessageOperationKey, options.correlationId, "invalid-message-id");
  return executeValidatedRawRequest(rawMessageOperation, request.data, options);
}

/** Execute the exact shared attachment request and return a raw command result. */
export async function executeAttachmentCommand(
  attachmentId: unknown,
  options: RawContentCommandOptions,
): Promise<CommandResultV1> {
  const request = attachmentRequestSchema.safeParse({ attachmentId });
  if (!request.success)
    return invalidInput(attachmentOperationKey, options.correlationId, "invalid-attachment-id");
  return executeValidatedRawRequest(attachmentOperation, request.data, options);
}

/** Dispatch one discriminated raw-content target without changing its operation mapping. */
export async function executeRawContentCommand(
  target: RawContentTarget,
  options: RawContentCommandOptions,
): Promise<CommandResultV1> {
  switch (target.kind) {
    case "raw-message":
      return executeRawMessageCommand(target.id, options);
    case "attachment":
      return executeAttachmentCommand(target.id, options);
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
