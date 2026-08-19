import {
  reportAdminExportOperation,
  reportAdminExportRequestSchema,
  type ReportAdminExportRequest,
  type ReportAdminExportSelection,
} from "@agent-mail/contracts";
import {
  classifyCliClientError,
  createCommandFailure,
  createCommandRaw,
  createLocalError,
  type CommandResultV1,
} from "./command-outcome";
import { CliClientError, type CliClient, type CliResponse } from "./client";

/** The operation's canonical command path. */
export const SELECTED_EXPORT_OPERATION_KEY = reportAdminExportOperation.key;
export const SELECTED_EXPORT_ARGV = Object.freeze(["exports", "selected"] as const);

export type SelectedExportCommandOptions = Readonly<{
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

export type SelectedExportCommandInput = Readonly<{
  readonly argv: readonly string[];
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

export class SelectedExportArgvError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SelectedExportArgvError";
  }
}

function usageFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: SELECTED_EXPORT_OPERATION_KEY,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: "exports selected",
      reasonCode: "selection",
    }),
  });
}

function invalidInput(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: SELECTED_EXPORT_OPERATION_KEY,
    semanticKind: "invalid_input",
    error: createLocalError("cli.invalid-input", correlationId, {
      operationKey: SELECTED_EXPORT_OPERATION_KEY,
      reasonCode: "selection",
    }),
  });
}

function protocolFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: SELECTED_EXPORT_OPERATION_KEY,
    semanticKind: "protocol",
    error: createLocalError("cli.protocol", correlationId, {
      operationKey: SELECTED_EXPORT_OPERATION_KEY,
      phase: "result-validation",
    }),
  });
}

function internalFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: SELECTED_EXPORT_OPERATION_KEY,
    semanticKind: "internal",
    error: createLocalError("cli.internal", correlationId, {
      operationKey: SELECTED_EXPORT_OPERATION_KEY,
      phase: "request",
    }),
  });
}

function optionValue(
  argv: readonly string[],
  index: number,
  option: string,
): Readonly<{
  readonly value: string;
  readonly nextIndex: number;
}> {
  const token = argv[index];
  if (token === undefined) throw new SelectedExportArgvError(`missing value for ${option}`);
  const equals = token.indexOf("=");
  if (equals >= 0) {
    const value = token.slice(equals + 1);
    if (value.length === 0) throw new SelectedExportArgvError(`missing value for ${option}`);
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new SelectedExportArgvError(`missing value for ${option}`);
  return { value, nextIndex: index + 1 };
}

/**
 * Parse only the command spelling and selection transport. The shared request
 * schema remains the authority for IDs, query bounds, and uniqueness.
 *
 * Selection is deliberately explicit: one query or one-or-more repeated
 * `--message-id` values. There is no empty-selection or export-all default.
 */
export function parseSelectedExportArgv(argv: readonly string[]): ReportAdminExportRequest {
  if (
    argv.length < SELECTED_EXPORT_ARGV.length ||
    argv[0] !== SELECTED_EXPORT_ARGV[0] ||
    argv[1] !== SELECTED_EXPORT_ARGV[1]
  )
    throw new SelectedExportArgvError("command path is not exports selected");

  let query: string | undefined;
  const messageIds: string[] = [];
  const seenOptions = new Set<string>();
  for (let index: number = SELECTED_EXPORT_ARGV.length; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token.length === 0 || !token.startsWith("--"))
      throw new SelectedExportArgvError("selection must use --query or --message-id");
    const equals = token.indexOf("=");
    const option = equals >= 0 ? token.slice(0, equals) : token;
    if (option !== "--query" && option !== "--message-id")
      throw new SelectedExportArgvError(`unknown option ${option}`);
    if (option === "--query" && seenOptions.has(option))
      throw new SelectedExportArgvError("query was supplied more than once");
    const result = optionValue(argv, index, option);
    if (option === "--query") query = result.value;
    else messageIds.push(result.value);
    seenOptions.add(option);
    index = result.nextIndex;
  }

  if ((query === undefined) === (messageIds.length === 0))
    throw new SelectedExportArgvError("exactly one selection kind is required");
  const selection: ReportAdminExportSelection =
    query === undefined ? { kind: "identities", messageIds } : { kind: "query", query };
  return reportAdminExportRequestSchema.parse({ selection });
}

function validatedRequest(selection: unknown): ReportAdminExportRequest | undefined {
  const parsed = reportAdminExportRequestSchema.safeParse({ selection });
  return parsed.success ? parsed.data : undefined;
}

/** Execute one exact selected-export request and return only its AMEX stream. */
export async function executeSelectedExport(
  selection: unknown,
  options: SelectedExportCommandOptions,
): Promise<CommandResultV1> {
  const request = validatedRequest(selection);
  if (request === undefined) return invalidInput(options.correlationId);
  try {
    const response: CliResponse = await options.client.request({
      operation: reportAdminExportOperation,
      input: request,
      signal: options.signal,
    });
    if (response.kind !== "stream" || response.operationKey !== SELECTED_EXPORT_OPERATION_KEY)
      return protocolFailure(options.correlationId);
    try {
      return createCommandRaw({
        operationKey: SELECTED_EXPORT_OPERATION_KEY,
        stream: response.stream,
      });
    } catch {
      return protocolFailure(options.correlationId);
    }
  } catch (error: unknown) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    return internalFailure(options.correlationId);
  }
}

/** Parse argv and execute one selected export through the shared client. */
export async function runSelectedExportCommand(
  input: SelectedExportCommandInput,
): Promise<CommandResultV1> {
  let request: ReportAdminExportRequest;
  try {
    request = parseSelectedExportArgv(input.argv);
  } catch {
    return usageFailure(input.correlationId);
  }
  return executeSelectedExport(request.selection, input);
}

function isSelectedExportCommandInput(value: unknown): value is SelectedExportCommandInput {
  if (typeof value !== "object" || value === null || !("argv" in value) || !("client" in value))
    return false;
  const argv = value.argv;
  const client = value.client;
  return (
    Array.isArray(argv) &&
    argv.every((token): token is string => typeof token === "string") &&
    typeof client === "object" &&
    client !== null &&
    "request" in client &&
    typeof client.request === "function" &&
    "correlationId" in value &&
    typeof value.correlationId === "string"
  );
}

/** Compatibility entry point for callers that already separated argv parsing. */
export function executeSelectedExportCommand(
  input: SelectedExportCommandInput,
): Promise<CommandResultV1>;
export function executeSelectedExportCommand(
  selection: unknown,
  options: SelectedExportCommandOptions,
): Promise<CommandResultV1>;
export function executeSelectedExportCommand(
  inputOrSelection: unknown,
  options?: SelectedExportCommandOptions,
): Promise<CommandResultV1> {
  if (options !== undefined) return executeSelectedExport(inputOrSelection, options);
  if (!isSelectedExportCommandInput(inputOrSelection))
    throw new TypeError("selected export command input is invalid");
  return runSelectedExportCommand(inputOrSelection);
}

export const parseSelectedExportCommand = parseSelectedExportArgv;
export const runSelectedExport = runSelectedExportCommand;
export const selectedExport = runSelectedExportCommand;
