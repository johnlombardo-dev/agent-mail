import {
  reportAdminBackupOperation,
  reportAdminBackupRequestSchema,
  reportAdminBackupResponseSchema,
  type ReportAdminBackupRequest,
  type ReportAdminBackupResponse,
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

export const BACKUP_OPERATION_KEY = reportAdminBackupOperation.key;
export const BACKUP_ARGV = Object.freeze(["admin", "backup"] as const);

export type BackupCommandInput = Readonly<{
  readonly argv: readonly string[];
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  /** The shared request; the daemon validates that its destination is configured. */
  readonly request: unknown;
  readonly signal?: AbortSignal;
}>;

type BackupHumanLine = readonly [HumanSegment, ...HumanSegment[]];

function line(label: string, value: unknown): BackupHumanLine {
  return [trustedChrome(label), untrustedValue(String(value))];
}

function humanLines(data: ReportAdminBackupResponse): CommandValueV1["humanLines"] {
  return [
    line("backup id: ", data.backupId),
    line("manifest: ", data.manifest.manifestId),
    line("manifest digest: ", data.manifest.digest),
    line("destination: ", data.destination),
    line("bytes: ", data.bytes),
    line("created: ", data.createdAt),
  ];
}

function usageFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: BACKUP_OPERATION_KEY,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: "admin backup",
      reasonCode: "argv",
    }),
  });
}

function invalidInputFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: BACKUP_OPERATION_KEY,
    semanticKind: "invalid_input",
    error: createLocalError("cli.invalid-input", correlationId, {
      operationKey: BACKUP_OPERATION_KEY,
      reasonCode: "request",
    }),
  });
}

/** Execute one backup request through the shared transport and outcome authority. */
export async function executeBackupCommand(
  requestInput: unknown,
  options: Readonly<{
    readonly client: Pick<CliClient, "request">;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  }>,
): Promise<CommandResultV1> {
  let request: ReportAdminBackupRequest;
  try {
    request = reportAdminBackupRequestSchema.parse(requestInput);
  } catch {
    return invalidInputFailure(options.correlationId);
  }
  try {
    const response: CliResponse = await options.client.request({
      operation: reportAdminBackupOperation,
      input: request,
      signal: options.signal,
    });
    if (response.kind !== "success" || response.operationKey !== BACKUP_OPERATION_KEY) {
      return createCommandFailure({
        operationKey: BACKUP_OPERATION_KEY,
        semanticKind: "protocol",
        error: createLocalError("cli.protocol", options.correlationId, {
          operationKey: BACKUP_OPERATION_KEY,
          phase: "result-validation",
        }),
      });
    }
    const data = reportAdminBackupResponseSchema.parse(response.data);
    return createCommandValue({
      operationKey: BACKUP_OPERATION_KEY,
      data,
      humanLines: humanLines(data),
    });
  } catch (error: unknown) {
    if (error instanceof CliClientError) {
      return classifyCliClientError(error, options.correlationId);
    }
    return createCommandFailure({
      operationKey: BACKUP_OPERATION_KEY,
      semanticKind: "protocol",
      error: createLocalError("cli.protocol", options.correlationId, {
        operationKey: BACKUP_OPERATION_KEY,
        phase: "result-validation",
      }),
    });
  }
}

/** Execute the canonical `admin backup` argv shape. */
export function runBackupCommand(input: BackupCommandInput): Promise<CommandResultV1> {
  if (
    input.argv.length !== BACKUP_ARGV.length ||
    input.argv.some((value, index) => value !== BACKUP_ARGV[index])
  ) {
    return Promise.resolve(usageFailure(input.correlationId));
  }
  return executeBackupCommand(input.request, {
    client: input.client,
    correlationId: input.correlationId,
    signal: input.signal,
  });
}

export const backupCommand = runBackupCommand;
