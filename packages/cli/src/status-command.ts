import {
  syncStatusOperation,
  syncStatusResponseSchema,
  type SyncStatusResponse,
} from "@agent-mail/contracts";
import {
  classifyCliClientError,
  createCommandValue,
  createLocalError,
  type CommandResultV1,
  type DiagnosticV1,
} from "./command-outcome";
import { CliClient, CliClientError, type CliResponse } from "./client";
import { trustedChrome, untrustedValue, type HumanSegment } from "./output-context";

export const STATUS_OPERATION_KEY = syncStatusOperation.key;
export const STATUS_ARGV = Object.freeze(["sync", "status"]) satisfies readonly ["sync", "status"];

export type StatusCommandInput = Readonly<{
  readonly argv: readonly string[];
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

function line(first: HumanSegment, ...rest: HumanSegment[]): [HumanSegment, ...HumanSegment[]] {
  return [first, ...rest];
}

function text(value: unknown): HumanSegment {
  return untrustedValue(String(value));
}

function humanLines(
  status: SyncStatusResponse,
): readonly [
  readonly [HumanSegment, ...HumanSegment[]],
  ...(readonly [HumanSegment, ...HumanSegment[]])[],
] {
  const lines: [[HumanSegment, ...HumanSegment[]], ...[HumanSegment, ...HumanSegment[]][]] = [
    line(trustedChrome("state: "), text(status.actorState)),
    line(trustedChrome("active operation: "), text(status.activeOperation ?? "none")),
    line(trustedChrome("incarnation: "), text(status.incarnationId)),
    line(trustedChrome("version: "), text(status.version)),
    line(
      trustedChrome("checkpoint: "),
      text(
        `${status.checkpoint.completedMailboxes}/${status.checkpoint.totalMailboxes} mailboxes, `,
      ),
      text(
        `${status.checkpoint.completedMessages} completed, ${status.checkpoint.pendingMessages} pending`,
      ),
    ),
  ];
  if (status.authBlocked !== null) {
    lines.push(
      line(trustedChrome("auth blocked: "), text(status.authBlocked.reason)),
      line(trustedChrome("auth detail: "), text(status.authBlocked.detail)),
    );
  }
  for (const diagnostic of status.diagnostics)
    lines.push(
      line(trustedChrome("diagnostic: "), text(`${diagnostic.code}: ${diagnostic.message}`)),
    );
  return lines;
}

function diagnostics(status: SyncStatusResponse, correlationId: string): readonly DiagnosticV1[] {
  const diagnostic = (value: SyncStatusResponse["diagnostics"][number]): DiagnosticV1 =>
    Object.freeze({
      version: 1,
      kind: "diagnostic",
      level: "warning",
      code: value.code,
      message: value.message,
      correlationId,
      details: {},
    });
  return status.diagnostics.map(diagnostic);
}

function usageFailure(correlationId: string): CommandResultV1 {
  return {
    version: 1,
    kind: "failure",
    operationKey: STATUS_OPERATION_KEY,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: "sync status",
      reasonCode: "argv",
    }),
    diagnostics: [],
  };
}

/** Execute the read-only status adapter. It never caches, polls, retries, or infers state. */
export async function runStatusCommand(input: StatusCommandInput): Promise<CommandResultV1> {
  if (
    input.argv.length !== STATUS_ARGV.length ||
    input.argv.some((value, index) => value !== STATUS_ARGV[index])
  )
    return usageFailure(input.correlationId);
  try {
    const response: CliResponse = await input.client.request({
      operation: syncStatusOperation,
      input: {},
      signal: input.signal,
    });
    if (response.kind !== "success" || response.operationKey !== STATUS_OPERATION_KEY)
      throw new CliClientError(
        "client_contract_error",
        STATUS_OPERATION_KEY,
        "status returned a stream",
      );
    const status = syncStatusResponseSchema.parse(response.data);
    return createCommandValue({
      operationKey: STATUS_OPERATION_KEY,
      data: status,
      humanLines: humanLines(status),
      diagnostics: diagnostics(status, input.correlationId),
    });
  } catch (error: unknown) {
    if (error instanceof CliClientError) return classifyCliClientError(error, input.correlationId);
    return {
      version: 1,
      kind: "failure",
      operationKey: STATUS_OPERATION_KEY,
      semanticKind: "protocol",
      error: createLocalError("cli.protocol", input.correlationId, {
        operationKey: STATUS_OPERATION_KEY,
        phase: "result-validation",
      }),
      diagnostics: [],
    };
  }
}
