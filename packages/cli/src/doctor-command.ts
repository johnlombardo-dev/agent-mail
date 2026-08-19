import {
  reportAdminDoctorOperation,
  reportAdminDoctorRequestSchema,
  reportAdminDoctorResponseSchema,
  type ReportAdminDoctorResponse,
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

export const DOCTOR_OPERATION_KEY = reportAdminDoctorOperation.key;
export const DOCTOR_ARGV = Object.freeze(["admin", "doctor"] as const);

export type DoctorCommandInput = Readonly<{
  readonly argv: readonly string[];
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly request: unknown;
  readonly signal?: AbortSignal;
}>;

type DoctorHumanLine = readonly [HumanSegment, ...HumanSegment[]];

function line(label: string, value: unknown): DoctorHumanLine {
  return [trustedChrome(label), untrustedValue(String(value))];
}

function humanLines(data: ReportAdminDoctorResponse): CommandValueV1["humanLines"] {
  const lines: DoctorHumanLine[] = [line("status: ", data.status)];
  data.checks.forEach((check, index) => {
    lines.push(
      line(`check ${index + 1} id: `, check.id),
      line(`check ${index + 1} status: `, check.status),
      line(`check ${index + 1} summary: `, check.summary),
    );
  });
  data.issues.forEach((issue, index) => {
    lines.push(
      line(`finding ${index + 1} code: `, issue.code),
      line(`finding ${index + 1} detail: `, issue.detail),
    );
  });
  const [first, ...rest] = lines;
  if (first === undefined) throw new TypeError("doctor output requires a status line");
  return [first, ...rest];
}

function usageFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: DOCTOR_OPERATION_KEY,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: "admin doctor",
      reasonCode: "argv",
    }),
  });
}

function invalidInputFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: DOCTOR_OPERATION_KEY,
    semanticKind: "invalid_input",
    error: createLocalError("cli.invalid-input", correlationId, {
      operationKey: DOCTOR_OPERATION_KEY,
      reasonCode: "request",
    }),
  });
}

/** Execute one doctor request through the shared transport and outcome authority. */
export async function executeDoctorCommand(
  requestInput: unknown,
  options: Readonly<{
    readonly client: Pick<CliClient, "request">;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  }>,
): Promise<CommandResultV1> {
  let request: unknown;
  try {
    request = reportAdminDoctorRequestSchema.parse(requestInput);
  } catch {
    return invalidInputFailure(options.correlationId);
  }
  try {
    const response: CliResponse = await options.client.request({
      operation: reportAdminDoctorOperation,
      input: request,
      signal: options.signal,
    });
    if (response.kind !== "success" || response.operationKey !== DOCTOR_OPERATION_KEY) {
      return createCommandFailure({
        operationKey: DOCTOR_OPERATION_KEY,
        semanticKind: "protocol",
        error: createLocalError("cli.protocol", options.correlationId, {
          operationKey: DOCTOR_OPERATION_KEY,
          phase: "result-validation",
        }),
      });
    }
    const data = reportAdminDoctorResponseSchema.parse(response.data);
    return createCommandValue({
      operationKey: DOCTOR_OPERATION_KEY,
      data,
      humanLines: humanLines(data),
    });
  } catch (error: unknown) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    return createCommandFailure({
      operationKey: DOCTOR_OPERATION_KEY,
      semanticKind: "protocol",
      error: createLocalError("cli.protocol", options.correlationId, {
        operationKey: DOCTOR_OPERATION_KEY,
        phase: "result-validation",
      }),
    });
  }
}

/** Execute the canonical `admin doctor` argv shape. */
export function runDoctorCommand(input: DoctorCommandInput): Promise<CommandResultV1> {
  if (
    input.argv.length !== DOCTOR_ARGV.length ||
    input.argv.some((value, index) => value !== DOCTOR_ARGV[index])
  ) {
    return Promise.resolve(usageFailure(input.correlationId));
  }
  return executeDoctorCommand(input.request, {
    client: input.client,
    correlationId: input.correlationId,
    signal: input.signal,
  });
}

export const doctorCommand = runDoctorCommand;
