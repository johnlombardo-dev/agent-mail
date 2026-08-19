import {
  syncControlCommandSchema,
  syncPauseRequestSchema,
  syncPauseOperationDefinition,
  syncResumeRequestSchema,
  syncResumeOperationDefinition,
  syncStartRequestSchema,
  syncStartOperationDefinition,
  syncStopRequestSchema,
  syncStopOperationDefinition,
  type OperationDefinition,
  type SyncControlCommand,
  type SyncPauseRequest,
  type SyncResumeRequest,
  type SyncStartRequest,
  type SyncStopRequest,
} from "@agent-mail/contracts";
import {
  classifyCliClientError,
  createCommandFailure,
  createCommandValue,
  createLocalError,
  type CommandFailureV1,
  type CommandResultV1,
  type CommandValueV1,
} from "./command-outcome";
import { CliClientError, type CliClient, type CliResponse } from "./client";
import { trustedChrome, untrustedValue, type HumanSegment } from "./output-context";

/** The four lifecycle controls intentionally share one adapter protocol. */
export type SyncControlCommandName = SyncControlCommand;

export type SyncControlRequest =
  | Readonly<{ readonly command: "start"; readonly input: SyncStartRequest }>
  | Readonly<{ readonly command: "pause"; readonly input: SyncPauseRequest }>
  | Readonly<{ readonly command: "resume"; readonly input: SyncResumeRequest }>
  | Readonly<{ readonly command: "stop"; readonly input: SyncStopRequest }>;

type SyncControlDefinition = Readonly<{
  readonly command: SyncControlCommandName;
  readonly operation: OperationDefinition;
  readonly parseRequest: (input: unknown) => SyncControlRequest;
}>;

/**
 * One mapping owns command-to-operation/request semantics for every control.
 * The client remains the only transport call; this module has no retry or state.
 */
export const syncControlCommandDefinitions = Object.freeze({
  start: {
    command: "start",
    operation: syncStartOperationDefinition,
    parseRequest: (input: unknown) => ({
      command: "start",
      input: syncStartRequestSchema.parse(input),
    }),
  },
  pause: {
    command: "pause",
    operation: syncPauseOperationDefinition,
    parseRequest: (input: unknown) => ({
      command: "pause",
      input: syncPauseRequestSchema.parse(input),
    }),
  },
  resume: {
    command: "resume",
    operation: syncResumeOperationDefinition,
    parseRequest: (input: unknown) => ({
      command: "resume",
      input: syncResumeRequestSchema.parse(input),
    }),
  },
  stop: {
    command: "stop",
    operation: syncStopOperationDefinition,
    parseRequest: (input: unknown) => ({
      command: "stop",
      input: syncStopRequestSchema.parse(input),
    }),
  },
} satisfies Readonly<Record<SyncControlCommandName, SyncControlDefinition>>);

export const SYNC_CONTROL_ARGV = Object.freeze({
  start: Object.freeze(["sync", "start"]),
  pause: Object.freeze(["sync", "pause"]),
  resume: Object.freeze(["sync", "resume"]),
  stop: Object.freeze(["sync", "stop"]),
} satisfies Readonly<Record<SyncControlCommandName, readonly [string, string]>>);

export type SyncControlCommandDefinition =
  (typeof syncControlCommandDefinitions)[SyncControlCommandName];

export type SyncControlAdapterOptions = Readonly<{
  readonly client: Pick<CliClient, "request">;
  /** Correlation used for locally-created validation/transport errors. */
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

export type SyncControlCommandInput = Readonly<{
  readonly argv: readonly string[];
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

function definitionFor(command: SyncControlCommandName): SyncControlCommandDefinition {
  return syncControlCommandDefinitions[command];
}

function commandFailure(
  operationKey: string | null,
  correlationId: string,
  phase: "request-validation" | "result-validation" | "request",
  semanticKind: "invalid_input" | "protocol" | "internal" = "protocol",
): CommandFailureV1 {
  const code =
    semanticKind === "invalid_input"
      ? "cli.invalid-input"
      : semanticKind === "internal"
        ? "cli.internal"
        : "cli.protocol";
  const details =
    semanticKind === "invalid_input"
      ? { operationKey, reasonCode: phase }
      : { operationKey, phase };
  return createCommandFailure({
    operationKey,
    semanticKind,
    error: createLocalError(code, correlationId, details),
  });
}

function humanLine(
  command: SyncControlCommandName,
  label: string,
  value: string,
): readonly [HumanSegment, ...HumanSegment[]] {
  return [trustedChrome(`sync ${command} ${label}=`), untrustedValue(value)];
}

function humanLines(
  command: SyncControlCommandName,
  data: Readonly<Record<string, unknown>>,
): CommandValueV1["humanLines"] {
  const observed = data.observed;
  if (!isRecord(observed)) throw new TypeError("sync control response has no observed actor");
  const observation = observed;
  if (
    typeof observation.actorState !== "string" ||
    typeof observation.version !== "number" ||
    typeof observation.incarnationId !== "string"
  )
    throw new TypeError("sync control response has an invalid observed actor");
  const result = data.completed === true ? "completed" : "accepted";
  return [
    humanLine(command, "result", result),
    humanLine(command, "state", observation.actorState),
    humanLine(command, "version", String(observation.version)),
    humanLine(command, "incarnation", observation.incarnationId),
  ];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRegisteredErrorValue(value: Readonly<Record<string, unknown>>): boolean {
  return typeof value.code === "string";
}

function usageFailure(operationKey: string | null, correlationId: string): CommandFailureV1 {
  return createCommandFailure({
    operationKey,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: operationKey === null ? null : "sync control",
      reasonCode: "argv",
    }),
  });
}

function parseSyncControlArgv(
  argv: readonly string[],
): Readonly<{ readonly command: SyncControlCommandName; readonly input: unknown }> | undefined {
  if (argv[0] !== "sync") return undefined;
  const command = syncControlCommandSchema.safeParse(argv[1]);
  if (!command.success) return undefined;
  const definition = definitionFor(command.data);
  const canonical = SYNC_CONTROL_ARGV[command.data];
  if (argv[0] !== canonical[0] || argv[1] !== canonical[1]) return undefined;
  if (command.data === "start")
    return argv.length === canonical.length ? { command: command.data, input: {} } : undefined;
  if (argv.length !== 4 || argv[2] !== "--idempotency-key" || argv[3] === undefined)
    return undefined;
  try {
    const request = definition.parseRequest({ idempotencyKey: argv[3] });
    return { command: command.data, input: request.input };
  } catch {
    return undefined;
  }
}

/** Parse a command/input pair against the exact shared request schema. */
export function parseSyncControlRequest(command: unknown, input: unknown): SyncControlRequest {
  const parsedCommand = syncControlCommandSchema.parse(command);
  return definitionFor(parsedCommand).parseRequest(input);
}

/**
 * Execute exactly one shared sync-control request and return a process-agnostic
 * #214 result. Actor state/version comes only from the validated API response.
 */
export async function executeSyncControlCommand(
  command: unknown,
  input: unknown,
  options: SyncControlAdapterOptions,
): Promise<CommandResultV1> {
  let request: SyncControlRequest;
  let definition: SyncControlCommandDefinition;
  try {
    const parsedCommand = syncControlCommandSchema.parse(command);
    definition = definitionFor(parsedCommand);
    request = definition.parseRequest(input);
  } catch {
    const parsedCommand = syncControlCommandSchema.safeParse(command);
    const operationKey = parsedCommand.success
      ? definitionFor(parsedCommand.data).operation.key
      : null;
    return commandFailure(
      operationKey,
      options.correlationId,
      "request-validation",
      "invalid_input",
    );
  }

  try {
    const response: CliResponse = await options.client.request({
      operation: definition.operation,
      input: request.input,
      signal: options.signal,
    });
    if (response.kind !== "success" || response.operationKey !== definition.operation.key)
      return commandFailure(definition.operation.key, options.correlationId, "result-validation");
    const data = response.data;
    if (!isRecord(data))
      return commandFailure(definition.operation.key, options.correlationId, "result-validation");
    try {
      return createCommandValue({
        operationKey: definition.operation.key,
        data,
        // Registered error values become failures in createCommandValue; this
        // inert placeholder is never rendered and keeps one shared constructor.
        humanLines: isRegisteredErrorValue(data)
          ? [[trustedChrome("sync control error")]]
          : humanLines(definition.command, data),
      });
    } catch {
      return commandFailure(definition.operation.key, options.correlationId, "result-validation");
    }
  } catch (error: unknown) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    return commandFailure(definition.operation.key, options.correlationId, "request", "internal");
  }
}

/** Execute one argv-shaped sync control command through the shared mapping. */
export async function runSyncControlCommand(
  input: SyncControlCommandInput,
): Promise<CommandResultV1> {
  const parsed = parseSyncControlArgv(input.argv);
  if (parsed === undefined) {
    const command = syncControlCommandSchema.safeParse(input.argv[1]);
    const operationKey = command.success ? definitionFor(command.data).operation.key : null;
    return usageFailure(operationKey, input.correlationId);
  }
  return executeSyncControlCommand(parsed.command, parsed.input, {
    client: input.client,
    correlationId: input.correlationId,
    signal: input.signal,
  });
}

export const syncControlCommand = runSyncControlCommand;
