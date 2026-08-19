import {
  reportAdminRestoreOperation,
  reportAdminRestoreRequestSchema,
  reportAdminRestoreResponseSchema,
  type ReportAdminRestoreRequest,
  type ReportAdminRestoreResponse,
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

export const RESTORE_OPERATION_KEY = reportAdminRestoreOperation.key;
export const RESTORE_ARGV = Object.freeze(["admin", "restore"] as const);

export type RestoreCommandInput = Readonly<{
  readonly argv: readonly string[];
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  /** The strict offline restore request; the daemon owns its destructive policy. */
  readonly request: unknown;
  readonly signal?: AbortSignal;
}>;

type RestoreHumanLine = readonly [HumanSegment, ...HumanSegment[]];

function line(label: string, value: unknown): RestoreHumanLine {
  return [trustedChrome(label), untrustedValue(String(value))];
}

function humanLines(data: ReportAdminRestoreResponse): CommandValueV1["humanLines"] {
  return [
    line("restored: ", data.restored),
    line("target: ", data.target),
    line("manifest: ", data.manifest.manifestId),
    line("manifest digest: ", data.manifest.digest),
    line("completed: ", data.completedAt),
  ];
}

function usageFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: RESTORE_OPERATION_KEY,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: "admin restore",
      reasonCode: "argv",
    }),
  });
}

function invalidInputFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: RESTORE_OPERATION_KEY,
    semanticKind: "invalid_input",
    error: createLocalError("cli.invalid-input", correlationId, {
      operationKey: RESTORE_OPERATION_KEY,
      reasonCode: "request",
    }),
  });
}

/** Execute one already-confirmed offline restore through the shared transport. */
export async function executeRestoreCommand(
  requestInput: unknown,
  options: Readonly<{
    readonly client: Pick<CliClient, "request">;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  }>,
): Promise<CommandResultV1> {
  let request: ReportAdminRestoreRequest;
  try {
    request = reportAdminRestoreRequestSchema.parse(requestInput);
  } catch {
    return invalidInputFailure(options.correlationId);
  }

  try {
    const response: CliResponse = await options.client.request({
      operation: reportAdminRestoreOperation,
      input: request,
      signal: options.signal,
    });
    if (response.kind !== "success" || response.operationKey !== RESTORE_OPERATION_KEY) {
      return createCommandFailure({
        operationKey: RESTORE_OPERATION_KEY,
        semanticKind: "protocol",
        error: createLocalError("cli.protocol", options.correlationId, {
          operationKey: RESTORE_OPERATION_KEY,
          phase: "result-validation",
        }),
      });
    }
    const data = reportAdminRestoreResponseSchema.parse(response.data);
    if (
      data.target !== request.target ||
      data.manifest.manifestId !== request.manifest.manifestId ||
      data.manifest.digest !== request.manifest.digest
    ) {
      throw new TypeError("restore response authority does not match the request");
    }
    return createCommandValue({
      operationKey: RESTORE_OPERATION_KEY,
      data,
      humanLines: humanLines(data),
    });
  } catch (error: unknown) {
    if (error instanceof CliClientError) {
      return classifyCliClientError(error, options.correlationId);
    }
    return createCommandFailure({
      operationKey: RESTORE_OPERATION_KEY,
      semanticKind: "protocol",
      error: createLocalError("cli.protocol", options.correlationId, {
        operationKey: RESTORE_OPERATION_KEY,
        phase: "result-validation",
      }),
    });
  }
}

/** Execute the canonical `admin restore` argv shape. */
export function runRestoreCommand(input: RestoreCommandInput): Promise<CommandResultV1> {
  if (
    input.argv.length !== RESTORE_ARGV.length ||
    input.argv.some((value, index) => value !== RESTORE_ARGV[index])
  ) {
    return Promise.resolve(usageFailure(input.correlationId));
  }
  return executeRestoreCommand(input.request, {
    client: input.client,
    correlationId: input.correlationId,
    signal: input.signal,
  });
}

export const restoreCommand = runRestoreCommand;
