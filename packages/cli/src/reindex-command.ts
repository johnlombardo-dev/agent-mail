import {
  reportAdminReindexOperation,
  reportAdminReindexRequestSchema,
  reportAdminReindexResponseSchema,
  type ReportAdminReindexRequest,
  type ReportAdminReindexResponse,
} from "@agent-mail/contracts";
import {
  classifyCliClientError,
  createCommandFailure,
  createCommandValue,
  createLocalError,
  type CommandResultV1,
  type CommandValueV1,
} from "./command-outcome";
import { CliClientError, type CliClient, type CliResponse } from "./client";
import { trustedChrome, untrustedValue, type HumanSegment } from "./output-context";

export const REINDEX_OPERATION_KEY = reportAdminReindexOperation.key;
export const REINDEX_ARGV = Object.freeze(["admin", "reindex"] as const);

export type ReindexCommandInput = Readonly<{
  readonly argv: readonly string[];
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly request: unknown;
  readonly signal?: AbortSignal;
}>;

type ReindexHumanLine = readonly [HumanSegment, ...HumanSegment[]];

function line(label: string, value: unknown): ReindexHumanLine {
  return [trustedChrome(label), untrustedValue(String(value))];
}

function humanLines(data: ReportAdminReindexResponse): CommandValueV1["humanLines"] {
  return [
    line("scope: ", data.scope),
    line("started: ", data.startedAt),
    line("indexed: ", data.indexed),
    line("expected: ", data.expected),
  ];
}

function usageFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: REINDEX_OPERATION_KEY,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: "admin reindex",
      reasonCode: "argv",
    }),
  });
}

function invalidInputFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: REINDEX_OPERATION_KEY,
    semanticKind: "invalid_input",
    error: createLocalError("cli.invalid-input", correlationId, {
      operationKey: REINDEX_OPERATION_KEY,
      reasonCode: "request",
    }),
  });
}

/** Execute one reindex request through the shared transport and outcome authority. */
export async function executeReindexCommand(
  requestInput: unknown,
  options: Readonly<{
    readonly client: Pick<CliClient, "request">;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  }>,
): Promise<CommandResultV1> {
  let request: ReportAdminReindexRequest;
  try {
    request = reportAdminReindexRequestSchema.parse(requestInput);
  } catch {
    return invalidInputFailure(options.correlationId);
  }

  try {
    const response: CliResponse = await options.client.request({
      operation: reportAdminReindexOperation,
      input: request,
      signal: options.signal,
    });
    if (response.kind !== "success" || response.operationKey !== REINDEX_OPERATION_KEY) {
      return createCommandFailure({
        operationKey: REINDEX_OPERATION_KEY,
        semanticKind: "protocol",
        error: createLocalError("cli.protocol", options.correlationId, {
          operationKey: REINDEX_OPERATION_KEY,
          phase: "result-validation",
        }),
      });
    }
    const data = reportAdminReindexResponseSchema.parse(response.data);
    if (data.scope !== request.scope) {
      throw new TypeError("reindex response scope does not match the request");
    }
    return createCommandValue({
      operationKey: REINDEX_OPERATION_KEY,
      data,
      humanLines: humanLines(data),
    });
  } catch (error: unknown) {
    if (error instanceof CliClientError) {
      return classifyCliClientError(error, options.correlationId);
    }
    return createCommandFailure({
      operationKey: REINDEX_OPERATION_KEY,
      semanticKind: "protocol",
      error: createLocalError("cli.protocol", options.correlationId, {
        operationKey: REINDEX_OPERATION_KEY,
        phase: "result-validation",
      }),
    });
  }
}

/** Execute the canonical `admin reindex` argv shape. */
export function runReindexCommand(input: ReindexCommandInput): Promise<CommandResultV1> {
  if (
    input.argv.length !== REINDEX_ARGV.length ||
    input.argv.some((value, index) => value !== REINDEX_ARGV[index])
  ) {
    return Promise.resolve(usageFailure(input.correlationId));
  }
  return executeReindexCommand(input.request, {
    client: input.client,
    correlationId: input.correlationId,
    signal: input.signal,
  });
}

export const reindexCommand = runReindexCommand;
