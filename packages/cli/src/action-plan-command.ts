import { z } from "zod";
import {
  actionPlanAuthorityCommitOperation,
  actionPlanAuthorityCommitRequestSchema,
  actionPlanAuthorityCommitResponseSchema,
  actionPlanApproveRequestSchema,
  actionPlanApproveResponseSchema,
  actionPlanCancelApprovalRequestSchema,
  actionPlanCancelApprovalResponseSchema,
  actionPlanCreateOperation,
  actionPlanCreateRequestSchema,
  actionPlanInspectOperation,
  actionPlanInspectRequestSchema,
  actionPlanInspectResponseSchema,
  actionPlanPreviewResponseSchema,
  authorityApproveOperation,
  authorityCancelApprovalOperation,
  createOperationRegistry,
  type ActionPlanAuthorityCommitRequest,
  type ActionPlanCreateRequest,
  type ActionPlanApproveRequest,
  type ActionPlanCancelApprovalRequest,
  type OperationDefinition,
  type OperationRegistry,
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
import {
  defaultHumanTerminalPolicy,
  renderHuman,
  trustedChrome,
  untrustedValue,
  type HumanSegment,
} from "./output-context";

/** The public action command family. The obsolete authorize command is absent. */
export const actionPlanCommandNames = Object.freeze([
  "create",
  "inspect",
  "approve",
  "cancel",
  "commit",
] as const);
export type ActionPlanCommandName = (typeof actionPlanCommandNames)[number];

/** The CLI registry uses the daemon's authority-aware definitions, not v1 authorize aliases. */
export const actionPlanCommandRegistry: OperationRegistry = createOperationRegistry([
  actionPlanCreateOperation,
  actionPlanInspectOperation,
  authorityApproveOperation,
  authorityCancelApprovalOperation,
  actionPlanAuthorityCommitOperation,
]);

const actionPresenceProtocolVersion = "agent-mail-macos-operator-presence-v1" as const;
const actionPresenceChallengeSchema = z.strictObject({
  version: z.literal(actionPresenceProtocolVersion),
  challengeId: z.string().min(1).max(256),
  challengeCommitment: z.string().min(1).max(4_096),
  operatorDisplayCode: z.string().min(1).max(128),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  credentialId: z.string().min(1).max(256),
  algorithm: z.literal("ES256"),
});
const actionPresenceAssertionSchema = z.strictObject({
  version: z.literal(actionPresenceProtocolVersion),
  challengeId: z.string().min(1).max(256),
  credentialId: z.string().min(1).max(256),
  signatureBase64url: z
    .string()
    .regex(/^[A-Za-z0-9_-]{86}$/u, "operator assertion signature is invalid"),
});

export type ActionPresenceRequest = Readonly<{
  readonly operation: "approve" | "cancel-approval";
  readonly method: "POST" | "DELETE";
  readonly path: string;
  readonly rawBody: Uint8Array;
}>;
export type ActionPresenceChallenge = z.infer<typeof actionPresenceChallengeSchema>;
export type ActionPresenceAssertion = z.infer<typeof actionPresenceAssertionSchema>;

/**
 * Native A1 is intentionally an injected boundary. The CLI supplies no
 * principal, credential, key, or signature; the daemon-owned broker does.
 */
export type ActionPresenceBroker = Readonly<{
  readonly issue: (request: ActionPresenceRequest) => Promise<unknown>;
  readonly sign: (
    request: ActionPresenceRequest,
    challenge: ActionPresenceChallenge,
  ) => Promise<unknown>;
}>;

export type ActionPlanCommandRequest =
  | Readonly<{ readonly command: "create"; readonly input: ActionPlanCreateRequest }>
  | Readonly<{ readonly command: "inspect"; readonly input: ActionPlanInspectRequest }>
  | Readonly<{ readonly command: "approve"; readonly input: ActionPlanApproveRequest }>
  | Readonly<{ readonly command: "cancel"; readonly input: ActionPlanCancelApprovalRequest }>
  | Readonly<{ readonly command: "commit"; readonly input: ActionPlanAuthorityCommitRequest }>;

export type ActionPlanCommandOptions = Readonly<{
  readonly client: Pick<CliClient, "request">;
  readonly correlationId: string;
  readonly mode: "json" | "human";
  readonly signal?: AbortSignal;
  /** Human confirmation must return exactly y or yes (case-insensitive). */
  readonly confirm?: (
    prompt: string,
    preview: z.infer<typeof actionPlanInspectResponseSchema>,
  ) => Promise<string>;
  readonly presence?: ActionPresenceBroker;
  /** Builds a client carrying only the one daemon-issued A1 assertion. */
  readonly operatorClientForAssertion?: (authorization: string) => Pick<CliClient, "request">;
  /** Renders the daemon display code before native signing. */
  readonly displayChallenge?: (challenge: ActionPresenceChallenge) => Promise<void> | void;
}>;

type ActionPlanPreview = z.infer<typeof actionPlanPreviewResponseSchema>;
type ActionPlanInspect = z.infer<typeof actionPlanInspectResponseSchema>;
type ActionPlanInspectRequest = z.infer<typeof actionPlanInspectRequestSchema>;
type ActionPlanApprove = z.infer<typeof actionPlanApproveResponseSchema>;
type ActionPlanCancel = z.infer<typeof actionPlanCancelApprovalResponseSchema>;
type ActionPlanCommit = z.infer<typeof actionPlanAuthorityCommitResponseSchema>;
type ActionHumanLine = readonly [HumanSegment, ...HumanSegment[]];

function line(label: string, value: unknown): ActionHumanLine {
  return [trustedChrome(label), untrustedValue(String(value))];
}

function targetLines(targets: ActionPlanPreview["plan"]["targets"]): ActionHumanLine[] {
  const lines: ActionHumanLine[] = [];
  targets.forEach((target, index) => {
    lines.push(
      line(`target ${index + 1} account: `, target.accountId),
      line(`target ${index + 1} mailbox: `, target.mailboxId),
      line(`target ${index + 1} uid-validity: `, target.uidValidity),
      line(`target ${index + 1} uid: `, target.uid),
      line(`target ${index + 1} requested-modseq: `, target.precondition.modseq),
    );
  });
  return lines;
}

function resultLines(results: ActionPlanInspect["results"]): ActionHumanLine[] {
  const lines: ActionHumanLine[] = [];
  results.forEach((result, index) => {
    lines.push(
      line(`result ${index + 1} kind: `, result.kind),
      line(`result ${index + 1} certainty: `, result.certainty),
      line(`result ${index + 1} attempt: `, result.attemptId),
      line(`result ${index + 1} account: `, result.target.accountId),
      line(`result ${index + 1} mailbox: `, result.target.mailboxId),
      line(`result ${index + 1} uid: `, result.target.uid),
      line(`result ${index + 1} requested-modseq: `, result.target.precondition.modseq),
    );
    switch (result.kind) {
      case "success":
        lines.push(line(`result ${index + 1} postcondition: `, result.postcondition.kind));
        break;
      case "stale":
      case "rejected":
        lines.push(line(`result ${index + 1} detail: `, result.detail));
        break;
      case "failed":
        lines.push(
          line(`result ${index + 1} failure: `, result.failureReason),
          line(`result ${index + 1} detail: `, result.detail),
        );
        break;
      case "uncertain":
        lines.push(
          line(`result ${index + 1} uncertainty: `, result.uncertainReason),
          line(`result ${index + 1} detail: `, result.detail),
        );
        break;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  });
  return lines;
}

function asHumanLines(lines: readonly ActionHumanLine[]): CommandValueV1["humanLines"] {
  const [first, ...rest] = lines;
  if (first === undefined) throw new TypeError("action output requires a human line");
  return [first, ...rest];
}

function previewLines(data: ActionPlanPreview | ActionPlanInspect): CommandValueV1["humanLines"] {
  const lines: ActionHumanLine[] = [
    line("plan: ", data.plan.planId),
    line("version: ", data.planVersion),
    line("action: ", data.plan.action.kind),
    line("preview digest: ", data.previewDigest),
    line("target digest: ", data.targetDigest),
    line("intent: ", data.normalizedIntent),
    line("expires: ", data.plan.expiresAt),
  ];
  lines.push(...targetLines(data.plan.targets));
  if ("approvalState" in data) lines.push(line("approval: ", approvalState(data.approvalState)));
  if ("results" in data) lines.push(...resultLines(data.results));
  return asHumanLines(lines);
}

function approvalState(value: ActionPlanInspect["approvalState"]): string {
  return typeof value === "string" ? value : value.state;
}

function approvalLines(data: ActionPlanApprove): CommandValueV1["humanLines"] {
  return [
    line("approval: ", data.approval.approvalId),
    line("plan: ", data.approval.planId),
    line("version: ", data.approval.planVersion),
    line("preview digest: ", data.approval.previewDigest),
    line("approval expires: ", data.approval.expiresAt),
    line("approver: ", data.approval.approver.principalId),
  ];
}

function cancelLines(data: ActionPlanCancel): CommandValueV1["humanLines"] {
  return [
    line("approval cancelled: ", data.approval.approvalId),
    line("plan: ", data.approval.planId),
    line("version: ", data.planVersion),
    line("cancelled at: ", data.approval.cancelledAt),
  ];
}

function commitLines(data: ActionPlanCommit): CommandValueV1["humanLines"] {
  return [
    line("plan: ", data.plan.planId),
    line("state: ", data.plan.state),
    line("approval consumed: ", data.consumptionReceipt.approvalId),
    line("committer: ", data.consumptionReceipt.committer.principalId),
    line("executor: ", data.consumptionReceipt.executorProfile),
    ...targetLines(data.plan.targets),
    ...resultLines(data.results),
  ];
}

function humanLinesFor(operationKey: string, data: unknown): CommandValueV1["humanLines"] {
  switch (operationKey) {
    case actionPlanCreateOperation.key: {
      const parsed = actionPlanPreviewResponseSchema.parse(data);
      return previewLines(parsed);
    }
    case actionPlanInspectOperation.key: {
      const parsed = actionPlanInspectResponseSchema.parse(data);
      return previewLines(parsed);
    }
    case authorityApproveOperation.key: {
      const parsed = actionPlanApproveResponseSchema.parse(data);
      return approvalLines(parsed);
    }
    case authorityCancelApprovalOperation.key: {
      const parsed = actionPlanCancelApprovalResponseSchema.parse(data);
      return cancelLines(parsed);
    }
    case actionPlanAuthorityCommitOperation.key: {
      const parsed = actionPlanAuthorityCommitResponseSchema.parse(data);
      return commitLines(parsed);
    }
    default: {
      throw new TypeError(`unsupported action operation ${operationKey}`);
    }
  }
}

function localFailure(
  operationKey: string | null,
  correlationId: string,
  semanticKind: "invalid_input" | "usage" | "protocol" | "internal" | "cancelled",
  code: "cli.invalid-input" | "cli.usage" | "cli.protocol" | "cli.internal" | "cli.cancelled",
  details: Readonly<Record<string, unknown>>,
): CommandFailureV1 {
  return createCommandFailure({
    operationKey,
    semanticKind,
    error: createLocalError(code, correlationId, details),
  });
}

function requestFailure(
  operationKey: string,
  correlationId: string,
  phase: "request-validation" | "result-validation" | "request",
  semanticKind: "invalid_input" | "protocol" | "internal" = "protocol",
): CommandFailureV1 {
  return localFailure(
    operationKey,
    correlationId,
    semanticKind,
    semanticKind === "invalid_input"
      ? "cli.invalid-input"
      : semanticKind === "internal"
        ? "cli.internal"
        : "cli.protocol",
    semanticKind === "invalid_input"
      ? { operationKey, reasonCode: phase }
      : semanticKind === "internal"
        ? { operationKey, phase }
        : { operationKey, phase },
  );
}

function actionPrompt(planExpiresAt: string): string {
  return renderHuman(
    [
      trustedChrome(
        "Approve this frozen action plan for one unattended commit within 10 minutes and no later than ",
      ),
      untrustedValue(planExpiresAt),
      trustedChrome("? [y/N]"),
    ],
    defaultHumanTerminalPolicy("pipe"),
  );
}

function cancelPrompt(planId: string): string {
  return renderHuman(
    [
      trustedChrome("Cancel this frozen action plan approval for plan "),
      untrustedValue(planId),
      trustedChrome("? [y/N]"),
    ],
    defaultHumanTerminalPolicy("pipe"),
  );
}

function bodyBytes(input: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(input));
}

function assertionHeader(assertion: ActionPresenceAssertion): string {
  const canonical = {
    version: assertion.version,
    challengeId: assertion.challengeId,
    credentialId: assertion.credentialId,
    signatureBase64url: assertion.signatureBase64url,
  };
  return `AgentMail-Operator ${Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url")}`;
}

function operationFor(command: ActionPlanCommandName): OperationDefinition {
  switch (command) {
    case "create":
      return actionPlanCreateOperation;
    case "inspect":
      return actionPlanInspectOperation;
    case "approve":
      return authorityApproveOperation;
    case "cancel":
      return authorityCancelApprovalOperation;
    case "commit":
      return actionPlanAuthorityCommitOperation;
    default: {
      const exhaustive: never = command;
      void exhaustive;
      throw new TypeError("unsupported action command");
    }
  }
}

/** Parse the command/input pair at the adapter boundary using shared schemas. */
export function parseActionPlanCommand(command: unknown, input: unknown): ActionPlanCommandRequest {
  const parsed = z.enum(actionPlanCommandNames).parse(command);
  switch (parsed) {
    case "create":
      return { command: parsed, input: actionPlanCreateRequestSchema.parse(input) };
    case "inspect":
      return { command: parsed, input: actionPlanInspectRequestSchema.parse(input) };
    case "approve":
      return { command: parsed, input: actionPlanApproveRequestSchema.parse(input) };
    case "cancel":
      return { command: parsed, input: actionPlanCancelApprovalRequestSchema.parse(input) };
    case "commit":
      return { command: parsed, input: actionPlanAuthorityCommitRequestSchema.parse(input) };
    default: {
      const exhaustive: never = parsed;
      void exhaustive;
      throw new TypeError("unsupported action command");
    }
  }
}

async function requestValue(
  operation: OperationDefinition,
  input: unknown,
  options: ActionPlanCommandOptions,
): Promise<CommandResultV1> {
  try {
    const response: CliResponse = await options.client.request({
      operation,
      input,
      signal: options.signal,
    });
    if (response.kind !== "success" || response.operationKey !== operation.key)
      throw new CliClientError("client_contract_error", operation.key, "action returned a stream");
    try {
      return createCommandValue(
        {
          operationKey: operation.key,
          data: response.data,
          humanLines: humanLinesFor(operation.key, response.data),
        },
        actionPlanCommandRegistry,
      );
    } catch {
      return requestFailure(operation.key, options.correlationId, "result-validation");
    }
  } catch (error: unknown) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    return requestFailure(operation.key, options.correlationId, "request", "internal");
  }
}

async function inspectForConfirmation(
  planId: string,
  options: ActionPlanCommandOptions,
): Promise<Readonly<{ readonly result: CommandResultV1; readonly preview?: ActionPlanInspect }>> {
  const result = await requestValue(actionPlanInspectOperation, { planId }, options);
  if (result.kind !== "value") return { result };
  try {
    return { result, preview: actionPlanInspectResponseSchema.parse(result.data) };
  } catch {
    return {
      result: requestFailure(
        actionPlanInspectOperation.key,
        options.correlationId,
        "result-validation",
      ),
    };
  }
}

async function approveOrCancel(
  command: "approve" | "cancel",
  request: ActionPlanApproveRequest | ActionPlanCancelApprovalRequest,
  options: ActionPlanCommandOptions,
): Promise<CommandResultV1> {
  const operation =
    command === "approve" ? authorityApproveOperation : authorityCancelApprovalOperation;
  if (
    options.mode !== "human" ||
    options.confirm === undefined ||
    options.presence === undefined ||
    options.operatorClientForAssertion === undefined ||
    options.displayChallenge === undefined
  )
    return localFailure(operation.key, options.correlationId, "usage", "cli.usage", {
      commandPath: command === "approve" ? "action plans approve" : "action plans approval cancel",
      reasonCode: "human-presence-required",
    });

  const preflight = await inspectForConfirmation(request.planId, options);
  if (preflight.preview === undefined) return preflight.result;
  const preview = preflight.preview;
  const prompt =
    command === "approve" ? actionPrompt(preview.plan.expiresAt) : cancelPrompt(request.planId);
  let answer: string;
  try {
    answer = await options.confirm(prompt, preview);
  } catch {
    return requestFailure(operation.key, options.correlationId, "request", "internal");
  }
  if (!/^(?:y|yes)$/iu.test(answer))
    return localFailure(operation.key, options.correlationId, "cancelled", "cli.cancelled", {
      operationKey: operation.key,
      source: "domain",
    });

  const parsedRequest =
    command === "approve"
      ? actionPlanApproveRequestSchema.parse(request)
      : actionPlanCancelApprovalRequestSchema.parse(request);
  const rawBody = bodyBytes(parsedRequest);
  const presenceRequest: ActionPresenceRequest = {
    operation: command === "approve" ? "approve" : "cancel-approval",
    method: command === "approve" ? "POST" : "DELETE",
    path:
      command === "approve"
        ? `/v1/action-plans/${encodeURIComponent(parsedRequest.planId)}/approvals`
        : (() => {
            const cancelRequest = actionPlanCancelApprovalRequestSchema.parse(parsedRequest);
            return `/v1/action-plans/${encodeURIComponent(cancelRequest.planId)}/approvals/${encodeURIComponent(cancelRequest.approvalId)}`;
          })(),
    rawBody,
  };
  try {
    const challenge = actionPresenceChallengeSchema.parse(
      await options.presence.issue(presenceRequest),
    );
    await options.displayChallenge(challenge);
    const assertion = actionPresenceAssertionSchema.parse(
      await options.presence.sign(presenceRequest, challenge),
    );
    const client = options.operatorClientForAssertion(assertionHeader(assertion));
    return requestValue(operation, parsedRequest, { ...options, client });
  } catch (error: unknown) {
    if (error instanceof CliClientError)
      return classifyCliClientError(error, options.correlationId);
    return requestFailure(operation.key, options.correlationId, "request", "internal");
  }
}

/** Execute one action command through the shared HTTP client and outcome authority. */
export async function runActionPlanCommand(
  command: unknown,
  input: unknown,
  options: ActionPlanCommandOptions,
): Promise<CommandResultV1> {
  let request: ActionPlanCommandRequest;
  try {
    request = parseActionPlanCommand(command, input);
  } catch {
    const parsed = z.enum(actionPlanCommandNames).safeParse(command);
    return localFailure(
      parsed.success ? operationFor(parsed.data).key : null,
      options.correlationId,
      "invalid_input",
      "cli.invalid-input",
      {
        operationKey: parsed.success ? operationFor(parsed.data).key : null,
        reasonCode: "request-schema",
      },
    );
  }
  if (request.command === "approve" || request.command === "cancel")
    return approveOrCancel(request.command, request.input, options);
  return requestValue(operationFor(request.command), request.input, options);
}

/** Descriptive aliases used by command wiring and composed fixtures. */
export const executeActionPlanCommand = runActionPlanCommand;
export const runActionCommand = runActionPlanCommand;

/** Exported only for focused fixture assertions; it never writes process output. */
export function actionPlanHumanLines(data: unknown): CommandValueV1["humanLines"] {
  const parsed = actionPlanInspectResponseSchema.parse(data);
  return previewLines(parsed);
}
