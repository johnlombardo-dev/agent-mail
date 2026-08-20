import {
  reportAdminReportOperation,
  reportAdminReportRequestSchema,
  reportAdminReportResponseSchema,
  type ReportAdminReportResponse,
} from "@agent-mail/contracts";
import {
  classifyCliClientError,
  createCommandFailure,
  createCommandValue,
  createLocalError,
  type CommandResultV1,
} from "./command-outcome";
import { CliClient, CliClientError, type CliResponse } from "./client";
import { trustedChrome, untrustedValue, type HumanSegment } from "./output-context";

export const REPORT_CREATE_OPERATION_KEY = reportAdminReportOperation.key;
export const REPORT_CREATE_ARGV = Object.freeze(["reports", "create"] as const);

export type ReportCreateCommandInput = Readonly<{
  readonly argv: readonly string[];
  /** Parsed by the shared contract at this boundary; parser ownership remains outside this adapter. */
  readonly request: unknown;
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}>;

function humanLines(
  response: ReportAdminReportResponse,
): readonly [
  readonly [HumanSegment, ...HumanSegment[]],
  ...(readonly [HumanSegment, ...HumanSegment[]])[],
] {
  const lines: [HumanSegment, ...HumanSegment[]][] = [
    [trustedChrome("report id: "), untrustedValue(response.reportId)],
    [trustedChrome("title: "), untrustedValue(response.title)],
    [trustedChrome("created: "), untrustedValue(response.createdAt)],
    [trustedChrome("authorized principal: "), untrustedValue(response.authorization.principal)],
    [trustedChrome("authorization method: "), untrustedValue(response.authorization.method)],
    [trustedChrome("authorization scope: "), untrustedValue(response.authorization.scope)],
    [trustedChrome("request id: "), untrustedValue(response.authorization.requestId)],
  ];
  for (const citation of response.citations) {
    lines.push([
      trustedChrome("source: "),
      untrustedValue(citation.label),
      trustedChrome(" "),
      untrustedValue(citation.id),
    ]);
  }
  const [first, ...rest] = lines;
  if (first === undefined) throw new TypeError("report human projection is empty");
  return [first, ...rest];
}

function usageFailure(correlationId: string): CommandResultV1 {
  return createCommandFailure({
    operationKey: REPORT_CREATE_OPERATION_KEY,
    semanticKind: "usage",
    error: createLocalError("cli.usage", correlationId, {
      commandPath: "reports create",
      reasonCode: "argv",
    }),
  });
}

/** Run reports create through the shared CLI client and outcome authority. */
export async function runReportCreateCommand(
  input: ReportCreateCommandInput,
): Promise<CommandResultV1> {
  if (
    input.argv.length !== REPORT_CREATE_ARGV.length ||
    input.argv[0] !== REPORT_CREATE_ARGV[0] ||
    input.argv[1] !== REPORT_CREATE_ARGV[1]
  )
    return usageFailure(input.correlationId);

  const request = reportAdminReportRequestSchema.safeParse(input.request);
  if (!request.success) {
    return createCommandFailure({
      operationKey: REPORT_CREATE_OPERATION_KEY,
      semanticKind: "invalid_input",
      error: createLocalError("cli.invalid-input", input.correlationId, {
        operationKey: REPORT_CREATE_OPERATION_KEY,
        reasonCode: "request",
      }),
    });
  }

  try {
    const response: CliResponse = await input.client.request({
      operation: reportAdminReportOperation,
      input: request.data,
      signal: input.signal,
    });
    if (response.kind !== "success" || response.operationKey !== REPORT_CREATE_OPERATION_KEY)
      throw new CliClientError(
        "client_contract_error",
        REPORT_CREATE_OPERATION_KEY,
        "reports create returned an unexpected result",
      );
    const data = reportAdminReportResponseSchema.parse(response.data);
    return createCommandValue({
      operationKey: REPORT_CREATE_OPERATION_KEY,
      data,
      humanLines: humanLines(data),
      diagnostics: [],
    });
  } catch (error: unknown) {
    if (error instanceof CliClientError) return classifyCliClientError(error, input.correlationId);
    return createCommandFailure({
      operationKey: REPORT_CREATE_OPERATION_KEY,
      semanticKind: "protocol",
      error: createLocalError("cli.protocol", input.correlationId, {
        operationKey: REPORT_CREATE_OPERATION_KEY,
        phase: "result-validation",
      }),
    });
  }
}
