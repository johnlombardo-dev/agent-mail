import {
  labelOperation,
  labelRequestSchema,
  labelResponseSchema,
  localLabelSchema,
  routingCommitOperation,
  routingCommitRequestSchema,
  routingCommitResponseSchema,
  routingPreviewOperation,
  routingPreviewRequestSchema,
  routingPreviewResponseSchema,
  type LabelRequest,
  type RoutingCommitRequest,
  type RoutingPreview,
  type RoutingPreviewRequest,
} from "@agent-mail/contracts";
import { z } from "zod";
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

type LabelResponse = z.infer<typeof labelResponseSchema>;
type RoutingCommitResponse = z.infer<typeof routingCommitResponseSchema>;

export const ROUTING_PREVIEW_ARGV = Object.freeze(["routing", "preview"] as const);
export const ROUTING_COMMIT_ARGV = Object.freeze(["routing", "commit"] as const);
export const LOCAL_LABEL_ARGV = Object.freeze(["messages", "label"] as const);

export type RoutingAdapterOptions = Readonly<{
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly argv: readonly string[];
}>;

export type RoutingPreviewCommandOptions = RoutingAdapterOptions &
  Readonly<{ readonly input: unknown }>;

/** A commit's confirmation is intentionally outside the shared HTTP body. */
export type RoutingCommitCommandOptions = RoutingAdapterOptions &
  Readonly<{ readonly input: unknown; readonly confirm: unknown }>;

export type LocalLabelCommandOptions = RoutingAdapterOptions &
  Readonly<{ readonly input: unknown; readonly confirm: unknown }>;

function matchesArgv(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((part, index) => part === expected[index])
  );
}

function failure(
  operationKey: string,
  correlationId: string,
  semanticKind: "usage" | "invalid_input" | "protocol" | "internal",
  reasonCode: string,
  commandPath: string,
): CommandFailureV1 {
  const code =
    semanticKind === "usage"
      ? "cli.usage"
      : semanticKind === "invalid_input"
        ? "cli.invalid-input"
        : semanticKind === "internal"
          ? "cli.internal"
          : "cli.protocol";
  const details =
    code === "cli.usage"
      ? { commandPath, reasonCode }
      : code === "cli.invalid-input"
        ? { operationKey, reasonCode }
        : { operationKey, phase: reasonCode };
  return createCommandFailure({
    operationKey,
    semanticKind,
    error: createLocalError(code, correlationId, details),
  });
}

function requestFailure(
  operationKey: string,
  correlationId: string,
  reasonCode: string,
): CommandFailureV1 {
  return failure(operationKey, correlationId, "invalid_input", reasonCode, "");
}

function usageFailure(
  operationKey: string,
  correlationId: string,
  commandPath: string,
): CommandFailureV1 {
  return failure(operationKey, correlationId, "usage", "argv", commandPath);
}

function protocolFailure(operationKey: string, correlationId: string): CommandFailureV1 {
  return failure(operationKey, correlationId, "protocol", "result-validation", "");
}

function unexpectedFailure(operationKey: string, correlationId: string): CommandFailureV1 {
  return failure(operationKey, correlationId, "internal", "result-classifier", "");
}

function line(first: HumanSegment, ...rest: HumanSegment[]): [HumanSegment, ...HumanSegment[]] {
  return [first, ...rest];
}

function text(value: unknown): HumanSegment {
  return untrustedValue(String(value));
}

function previewHumanLines(preview: RoutingPreview): CommandValueV1["humanLines"] {
  const lines: [HumanSegment, ...HumanSegment[]][] = [
    line(trustedChrome("preview: "), text(preview.previewId)),
    line(trustedChrome("authority: "), text(preview.authority)),
    line(trustedChrome("digest: "), text(preview.digest)),
    line(trustedChrome("expires: "), text(preview.expiresAt)),
    line(trustedChrome("targets: "), text(preview.candidateTargets.length)),
  ];
  for (const target of preview.candidateTargets) {
    const identity =
      target.kind === "local-label"
        ? `${target.messageId} ${target.label}`
        : `${target.messageId} ${target.placementId} ${target.mailboxId}`;
    lines.push(
      line(trustedChrome("target "), text(target.kind), trustedChrome(": "), text(identity)),
    );
  }
  const [first, ...rest] = lines;
  if (first === undefined) throw new TypeError("routing preview human projection is empty");
  return [first, ...rest];
}

function commitHumanLines(response: RoutingCommitResponse): CommandValueV1["humanLines"] {
  if (response.committed) {
    return [
      line(trustedChrome("committed: "), text(true)),
      line(trustedChrome("preview: "), text(response.previewId)),
      line(trustedChrome("decision: "), text(response.decisionId)),
      line(trustedChrome("digest: "), text(response.previewDigest)),
    ];
  }
  return [
    line(trustedChrome("committed: "), text(false)),
    line(trustedChrome("preview: "), text(response.previewId)),
    line(trustedChrome("digest: "), text(response.previewDigest)),
  ];
}

function labelHumanLines(response: LabelResponse): CommandValueV1["humanLines"] {
  if (response.committed) {
    return [
      line(trustedChrome("committed: "), text(true)),
      line(trustedChrome("message: "), text(response.messageId)),
      line(trustedChrome("label: "), text(response.label)),
      line(trustedChrome("decision: "), text(response.decisionId)),
    ];
  }
  return [
    line(trustedChrome("committed: "), text(false)),
    line(trustedChrome("message: "), text(response.messageId)),
    line(trustedChrome("label: "), text(response.label)),
  ];
}

function valueResult(
  operationKey: string,
  correlationId: string,
  response: CliResponse,
  parse: (value: unknown) => unknown,
  humanLines: (value: unknown) => CommandValueV1["humanLines"],
): CommandResultV1 {
  if (response.kind !== "success" || response.operationKey !== operationKey)
    return protocolFailure(operationKey, correlationId);
  try {
    const data = parse(response.data);
    return createCommandValue({ operationKey, data, humanLines: humanLines(data) });
  } catch {
    return protocolFailure(operationKey, correlationId);
  }
}

async function requestValue(
  operationKey: string,
  options: RoutingAdapterOptions,
  input: unknown,
  parse: (value: unknown) => unknown,
  humanLines: (value: unknown) => CommandValueV1["humanLines"],
): Promise<CommandResultV1> {
  try {
    const response = await options.client.request({
      operation: operationKey,
      input,
      signal: options.signal,
    });
    if (response.kind !== "success") return protocolFailure(operationKey, options.correlationId);
    return valueResult(operationKey, options.correlationId, response, parse, humanLines);
  } catch (error: unknown) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    return unexpectedFailure(operationKey, options.correlationId);
  }
}

/** Execute one server-authoritative routing preview. No target or digest is inferred locally. */
export async function executeRoutingPreviewCommand(
  options: RoutingPreviewCommandOptions,
): Promise<CommandResultV1> {
  const operationKey = routingPreviewOperation.key;
  if (!matchesArgv(options.argv, ROUTING_PREVIEW_ARGV))
    return usageFailure(operationKey, options.correlationId, "routing preview");
  let input: RoutingPreviewRequest;
  try {
    input = routingPreviewRequestSchema.parse(options.input);
  } catch {
    return requestFailure(operationKey, options.correlationId, "routing-preview-request");
  }
  return requestValue(
    operationKey,
    options,
    input,
    (value) => routingPreviewResponseSchema.parse(value),
    (value) => previewHumanLines(routingPreviewResponseSchema.parse(value)),
  );
}

/** Execute one preview commit only after explicit confirmation is supplied. */
export async function executeRoutingCommitCommand(
  options: RoutingCommitCommandOptions,
): Promise<CommandResultV1> {
  const operationKey = routingCommitOperation.key;
  if (!matchesArgv(options.argv, ROUTING_COMMIT_ARGV))
    return usageFailure(operationKey, options.correlationId, "routing commit");
  let input: RoutingCommitRequest;
  try {
    input = routingCommitRequestSchema.parse(options.input);
  } catch {
    return requestFailure(operationKey, options.correlationId, "routing-commit-request");
  }
  if (!input.dryRun && options.confirm !== true)
    return usageFailure(operationKey, options.correlationId, "routing commit");
  return requestValue(
    operationKey,
    options,
    input,
    (value) => routingCommitResponseSchema.parse(value),
    (value) => commitHumanLines(routingCommitResponseSchema.parse(value)),
  );
}

/** Execute one local-label assignment; the API owns the durable decision identity. */
export async function executeLocalLabelCommand(
  options: LocalLabelCommandOptions,
): Promise<CommandResultV1> {
  const operationKey = labelOperation.key;
  if (!matchesArgv(options.argv, LOCAL_LABEL_ARGV))
    return usageFailure(operationKey, options.correlationId, "messages label");
  let input: LabelRequest;
  try {
    input = labelRequestSchema.parse(options.input);
    localLabelSchema.parse(input.label);
  } catch {
    return requestFailure(operationKey, options.correlationId, "label-request");
  }
  if (!input.dryRun && options.confirm !== true)
    return usageFailure(operationKey, options.correlationId, "messages label");
  return requestValue(
    operationKey,
    options,
    input,
    (value) => labelResponseSchema.parse(value),
    (value) => labelHumanLines(labelResponseSchema.parse(value)),
  );
}

export const runRoutingPreviewCommand = executeRoutingPreviewCommand;
export const runRoutingCommitCommand = executeRoutingCommitCommand;
export const runLocalLabelCommand = executeLocalLabelCommand;
