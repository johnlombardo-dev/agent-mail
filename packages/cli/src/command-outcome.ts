import { z } from "zod";
import {
  createOperationRegistry,
  httpErrorRegistry,
  parseErrorDefinition,
  publicErrorEnvelopeSchema,
  type ErrorDefinition,
  type OperationDefinition,
  type OperationRegistry,
  type PublicErrorEnvelope,
} from "@agent-mail/contracts";
import { publicCliOperations } from "./command-registry";
import {
  type HumanSegment,
  type RawOutputPolicy,
  defaultHumanTerminalPolicy,
  renderHuman,
  renderJsonLine,
  trustedChrome,
  untrustedValue,
} from "./output-context";
import {
  CliClientError,
  type CliByteStream,
  type CliClientErrorKind,
  type CliResponse,
} from "./client";

/** The only semantic meanings that may cross the CLI result boundary. */
export const semanticKinds = Object.freeze([
  "success",
  "usage",
  "invalid_input",
  "not_found",
  "unavailable",
  "internal",
  "io",
  "temporary",
  "protocol",
  "authorization",
  "configuration",
  "conflict",
  "stale",
  "expired",
  "replay",
  "tampered",
  "cancelled",
  "attention",
  "partial",
  "uncertain",
  "partial_output",
] as const);
export type SemanticKind = (typeof semanticKinds)[number];
export type RegisteredValueSemanticKind =
  | "success"
  | "stale"
  | "expired"
  | "cancelled"
  | "attention"
  | "partial"
  | "uncertain";
export type RegisteredFailureSemanticKind = Exclude<SemanticKind, RegisteredValueSemanticKind>;
/** Failure envelopes may use cancelled even though domain values may also use it. */
export type CommandFailureSemanticKind = RegisteredFailureSemanticKind | "cancelled";
export type NormalExitSemanticKind = Exclude<SemanticKind, "partial_output">;

export const exitCodeRegistry = Object.freeze([
  ["success", 0],
  ["usage", 64],
  ["invalid_input", 65],
  ["not_found", 66],
  ["unavailable", 69],
  ["internal", 70],
  ["io", 74],
  ["temporary", 75],
  ["protocol", 76],
  ["authorization", 77],
  ["configuration", 78],
  ["conflict", 79],
  ["stale", 80],
  ["expired", 81],
  ["replay", 82],
  ["tampered", 83],
  ["cancelled", 84],
  ["attention", 85],
  ["partial", 86],
  ["uncertain", 87],
  ["partial_output", 88],
] as const satisfies readonly (readonly [SemanticKind, number])[]);
export const exitCodes = Object.freeze(Object.fromEntries(exitCodeRegistry)) as Readonly<
  Record<SemanticKind, number>
>;
const semanticKindSet = new Set<string>(semanticKinds);

export function isSemanticKind(value: unknown): value is SemanticKind {
  return typeof value === "string" && semanticKindSet.has(value);
}
export function isValueSemanticKind(value: unknown): value is RegisteredValueSemanticKind {
  return typeof value === "string" && valueSemanticKindSet.has(value);
}
export function isFailureSemanticKind(value: unknown): value is RegisteredFailureSemanticKind {
  return (
    typeof value === "string" && semanticKindSet.has(value) && !valueSemanticKindSet.has(value)
  );
}
function isCommandFailureSemanticKind(value: unknown): value is CommandFailureSemanticKind {
  return isFailureSemanticKind(value) || value === "cancelled";
}
export function exitCodeForSemanticKind(kind: SemanticKind): number {
  return exitCodes[kind];
}
export function semanticKindForExitCode(code: number): SemanticKind | undefined {
  return exitCodeRegistry.find(([, value]) => value === code)?.[0];
}
const receiptNormalExitCodes = Object.freeze({
  success: 0,
  usage: 64,
  invalid_input: 65,
  not_found: 66,
  unavailable: 69,
  internal: 70,
  io: 74,
  temporary: 75,
  protocol: 76,
  authorization: 77,
  configuration: 78,
  conflict: 79,
  stale: 80,
  expired: 81,
  replay: 82,
  tampered: 83,
  cancelled: 84,
  attention: 85,
  partial: 86,
  uncertain: 87,
  partial_output: 88,
} as const);
type ReceiptPair =
  | {
      [K in keyof typeof receiptNormalExitCodes]: Readonly<{
        readonly semanticKind: K;
        readonly exitCode: (typeof receiptNormalExitCodes)[K];
      }>;
    }[keyof typeof receiptNormalExitCodes]
  | Readonly<{ readonly semanticKind: "cancelled"; readonly exitCode: 130 | 143 }>
  | Readonly<{ readonly semanticKind: "partial_output"; readonly exitCode: 141 }>;

export type DiagnosticV1 = Readonly<{
  readonly version: 1;
  readonly kind: "diagnostic";
  readonly level: "info" | "warning";
  readonly code: string;
  readonly message: string;
  readonly correlationId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}>;
export type CommandValueV1 = Readonly<{
  readonly version: 1;
  readonly kind: "value";
  readonly operationKey: string;
  readonly semanticKind: RegisteredValueSemanticKind;
  readonly data: unknown;
  readonly humanLines: readonly [
    readonly [HumanSegment, ...HumanSegment[]],
    ...(readonly [HumanSegment, ...HumanSegment[]])[],
  ];
  readonly diagnostics: readonly DiagnosticV1[];
}>;
export type CommandRawV1 = Readonly<{
  readonly version: 1;
  readonly kind: "raw";
  readonly operationKey: string;
  readonly semanticKind: "success";
  readonly stream: CliByteStream;
  readonly diagnostics: readonly DiagnosticV1[];
}>;
export type CommandFailureV1 = Readonly<{
  readonly version: 1;
  readonly kind: "failure";
  readonly operationKey: string | null;
  readonly semanticKind: CommandFailureSemanticKind;
  readonly error: PublicErrorEnvelope;
  readonly diagnostics: readonly DiagnosticV1[];
}>;
export type CommandResultV1 = CommandValueV1 | CommandRawV1 | CommandFailureV1;

export type SinkWriteResultV1 =
  | Readonly<{ readonly kind: "written"; readonly bytesAccepted: number }>
  | Readonly<{
      readonly kind: "failed";
      readonly errorCode: string | null;
      readonly bytesAccepted: number | "unknown";
    }>;
export type CommandSink = Readonly<{
  readonly write: (bytes: Uint8Array) => Promise<SinkWriteResultV1>;
  readonly isTTY?: boolean;
}>;
export type CommandExecutionContextV1 = Readonly<{
  readonly invocationCorrelationId: string;
  readonly mode: "json" | "human" | "raw";
  readonly stdout: CommandSink;
  readonly stderr: CommandSink;
  readonly rawPolicy: RawOutputPolicy;
  readonly signal: AbortSignal;
  readonly terminalSignal?: "SIGINT" | "SIGTERM";
  readonly cleanup?: () => Promise<void>;
}>;
export type ExecutionReceiptV1 = Readonly<{
  readonly version: 1;
  readonly stdoutBytesAccepted: number;
  readonly stderrBytesAccepted: number;
  readonly cleanupAwaited: boolean;
}> &
  ReceiptPair;

/** Validate an execution receipt at an unknown boundary, including its exact pair. */
export function parseExecutionReceipt(input: unknown): ExecutionReceiptV1 {
  const value = recordValue(input);
  if (
    value === undefined ||
    !exactKeys(value, [
      "version",
      "semanticKind",
      "exitCode",
      "stdoutBytesAccepted",
      "stderrBytesAccepted",
      "cleanupAwaited",
    ]) ||
    value.version !== 1 ||
    !isSemanticKind(value.semanticKind) ||
    typeof value.exitCode !== "number" ||
    !validAccepted(value.exitCode) ||
    typeof value.stdoutBytesAccepted !== "number" ||
    !validAccepted(value.stdoutBytesAccepted) ||
    typeof value.stderrBytesAccepted !== "number" ||
    !validAccepted(value.stderrBytesAccepted) ||
    typeof value.cleanupAwaited !== "boolean"
  )
    throw new TypeError("invalid execution receipt");
  const valid =
    value.exitCode === exitCodeForSemanticKind(value.semanticKind) ||
    (value.semanticKind === "cancelled" && (value.exitCode === 130 || value.exitCode === 143)) ||
    (value.semanticKind === "partial_output" && value.exitCode === 141);
  if (!valid) throw new TypeError("invalid execution receipt pair");
  return Object.freeze({
    version: 1,
    semanticKind: value.semanticKind,
    exitCode: value.exitCode,
    stdoutBytesAccepted: value.stdoutBytesAccepted,
    stderrBytesAccepted: value.stderrBytesAccepted,
    cleanupAwaited: value.cleanupAwaited,
  }) as ExecutionReceiptV1;
}

const operationRegistry = createOperationRegistry(publicCliOperations);
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const nullableIdentifier = identifier.nullable();
const phase = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const detailSchemas: Readonly<Record<string, z.ZodType>> = {
  "cli.usage": z.strictObject({
    commandPath: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:[ ._-][a-z0-9]+)*$/u)
      .nullable(),
    reasonCode: phase,
  }),
  "cli.invalid-input": z.strictObject({ operationKey: nullableIdentifier, reasonCode: phase }),
  "cli.configuration": z.strictObject({ settingCode: phase, reasonCode: phase }),
  "cli.connect-timeout": z.strictObject({ operationKey: identifier, phase: z.literal("connect") }),
  "cli.control-timeout": z.strictObject({ operationKey: identifier, phase: z.literal("control") }),
  "cli.stream-idle-timeout": z.strictObject({
    operationKey: identifier,
    phase: z.literal("stream-idle"),
  }),
  "cli.protocol": z.strictObject({ operationKey: nullableIdentifier, phase }),
  "cli.cancelled": z.strictObject({
    operationKey: nullableIdentifier,
    source: z.enum(["caller", "domain"]),
  }),
  "cli.transport": z.strictObject({
    operationKey: identifier,
    phase: z.enum(["request", "stream"]),
  }),
  "cli.internal": z.strictObject({ operationKey: nullableIdentifier, phase }),
  "cli.output-io": z.strictObject({ destination: z.enum(["stdout", "stderr"]), phase }),
  "cli.partial-output": z.strictObject({
    operationKey: nullableIdentifier,
    causeCode: identifier,
    failedBoundary: z.enum(["stdout", "stderr", "client", "render", "cleanup", "diagnostic"]),
    stdoutBytesAccepted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    stderrBytesAccepted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }),
  "cli.raw-tty-refused": z.strictObject({
    operationKey: identifier,
    destination: z.literal("tty"),
  }),
};
const localErrorRows = [
  ["cli.usage", "command invocation is invalid", "usage"],
  [
    "cli.invalid-input",
    "command input does not satisfy the shared request contract",
    "invalid_input",
  ],
  ["cli.configuration", "Agent Mail configuration is missing or invalid", "configuration"],
  ["cli.connect-timeout", "connection did not complete before its deadline", "temporary"],
  ["cli.control-timeout", "control response did not arrive before its deadline", "temporary"],
  ["cli.stream-idle-timeout", "stream made no progress before its idle deadline", "temporary"],
  ["cli.protocol", "the CLI and service contract do not agree", "protocol"],
  ["cli.cancelled", "command execution was cancelled", "cancelled"],
  ["cli.transport", "the Agent Mail service is unavailable", "unavailable"],
  ["cli.internal", "the CLI could not complete the command", "internal"],
  ["cli.output-io", "the requested output could not be written", "io"],
  ["cli.partial-output", "output ended after an incomplete prefix was written", "partial_output"],
  ["cli.raw-tty-refused", "raw output is refused on a TTY without explicit opt-in", "usage"],
] as const;
type LocalCode = (typeof localErrorRows)[number][0];
function isLocalCode(value: string): value is LocalCode {
  return localByCode.has(value);
}
const localDefinitions = Object.freeze(
  localErrorRows.map(([code, message]) => ({
    code,
    status: 400 as const,
    message,
    details: detailSchemas[code],
  })) satisfies readonly ErrorDefinition[],
);
const localByCode = new Map<string, ErrorDefinition>(
  localDefinitions.map((row) => [row.code, row]),
);

export function createLocalError(
  code: LocalCode,
  correlationId: string,
  details: unknown,
): PublicErrorEnvelope {
  const definition = localByCode.get(code);
  if (definition === undefined) throw new TypeError("unknown local CLI error code");
  return parseErrorDefinition(definition, {
    code,
    message: definition.message,
    correlationId,
    details,
  });
}
export function parseLocalError(input: unknown): PublicErrorEnvelope {
  const envelope = publicErrorEnvelopeSchema.parse(input);
  const definition = localByCode.get(envelope.code);
  if (definition === undefined) throw new TypeError("not a local CLI error");
  return parseErrorDefinition(definition, envelope);
}

const sharedSemanticKinds: Readonly<Record<string, SemanticKind>> = Object.freeze({
  invalid_request: "invalid_input",
  missing_credentials: "authorization",
  invalid_credentials: "authorization",
  expired_credentials: "authorization",
  insufficient_scope: "authorization",
  request_too_large: "invalid_input",
  not_found: "not_found",
  internal_error: "internal",
  "action.approval_forbidden": "authorization",
  "action.approval_presence_required": "authorization",
  "action.operator_presence_unsupported": "unavailable",
  "action.operator_challenge_capacity": "temporary",
  "action.operator_challenge_not_found": "not_found",
  "action.operator_challenge_expired": "expired",
  "action.operator_challenge_consumed": "replay",
  "action.operator_assertion_invalid": "tampered",
  "action.approval_not_found": "not_found",
  "action.approval_mismatch": "tampered",
  "action.approval_expired": "expired",
  "action.approval_cancelled": "cancelled",
  "action.approval_invalidated": "stale",
  "action.approval_consumed": "replay",
  "action.plan_version_stale": "stale",
  "action.plan_not_pending": "conflict",
  "action.plan_expired": "expired",
  "action.legacy_authority": "authorization",
});
const operationErrorSemanticKinds: Readonly<
  Record<string, SemanticKind | Readonly<Record<string, SemanticKind>>>
> = Object.freeze({
  invalid_query: "invalid_input",
  invalid_cursor: "invalid_input",
  not_found: "not_found",
  "sync.control-rejected": Object.freeze({
    "stale-version": "stale",
    "incompatible-state": "conflict",
    busy: "conflict",
    "shutdown-terminal": "conflict",
  }),
  "sync.control-failed": Object.freeze({
    "terminal-failure": "internal",
    "auth-blocked": "authorization",
  }),
  "sync.control-cancelled": "cancelled",
  "sync.control-timeout": "temporary",
  "sync.control-idempotency-conflict": "conflict",
  "sync.control-capacity": "temporary",
});

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  forbidden: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.length === required.length &&
    forbidden.every((key) => !keys.includes(key))
  );
}
function operationFor(key: string, registry: OperationRegistry): OperationDefinition | undefined {
  return registry.get(key);
}

/** Validate a registered server envelope and map it by code/details, never by message/status. */
export function parseRegisteredError(
  input: unknown,
  operationKey: string,
  registry: OperationRegistry = operationRegistry,
): Readonly<{ error: PublicErrorEnvelope; semanticKind: SemanticKind }> {
  const operation = operationFor(operationKey, registry);
  let envelope: PublicErrorEnvelope;
  if (operation !== undefined) {
    const definition = operation.errors.find((candidate) => {
      const value = recordValue(input);
      return value?.code === candidate.code;
    });
    if (definition !== undefined) envelope = parseErrorDefinition(definition, input);
    else envelope = httpErrorRegistry.parse(input);
  } else envelope = httpErrorRegistry.parse(input);
  const operationMapping = operationErrorSemanticKinds[envelope.code];
  if (
    operationMapping !== undefined &&
    operation !== undefined &&
    operation.errors.some(({ code }) => code === envelope.code)
  ) {
    if (typeof operationMapping === "string")
      return { error: envelope, semanticKind: operationMapping };
    const details = recordValue(envelope.details);
    const reason = details?.reason;
    const mapped = typeof reason === "string" ? operationMapping[reason] : undefined;
    if (mapped !== undefined) return { error: envelope, semanticKind: mapped };
    throw new TypeError("registered operation error has an unknown detail discriminant");
  }
  const shared = sharedSemanticKinds[envelope.code];
  if (shared === undefined) throw new TypeError("registered error has no CLI mapping");
  return { error: envelope, semanticKind: shared };
}

export function classifyCliClientError(
  error: CliClientError,
  correlationId: string,
): CommandFailureV1 {
  const details =
    error.kind === "connect_timeout"
      ? { operationKey: error.operationKey, phase: "connect" }
      : error.kind === "control_timeout"
        ? { operationKey: error.operationKey, phase: "control" }
        : error.kind === "stream_idle_timeout"
          ? { operationKey: error.operationKey, phase: "stream-idle" }
          : error.kind === "client_contract_error"
            ? { operationKey: error.operationKey, phase: "result-validation" }
            : error.kind === "aborted"
              ? { operationKey: error.operationKey, source: "caller" }
              : error.kind === "transport_error"
                ? { operationKey: error.operationKey, phase: "request" }
                : undefined;
  if (error.kind === "http_error") {
    if (error.serverError === undefined) return protocolFailure(error.operationKey, correlationId);
    try {
      const mapped = parseRegisteredError(error.serverError, error.operationKey);
      if (!isCommandFailureSemanticKind(mapped.semanticKind))
        return protocolFailure(error.operationKey, correlationId);
      return failure(error.operationKey, mapped.semanticKind, mapped.error, []);
    } catch {
      return protocolFailure(error.operationKey, correlationId);
    }
  }
  const code: LocalCode =
    error.kind === "connect_timeout"
      ? "cli.connect-timeout"
      : error.kind === "control_timeout"
        ? "cli.control-timeout"
        : error.kind === "stream_idle_timeout"
          ? "cli.stream-idle-timeout"
          : error.kind === "client_contract_error"
            ? "cli.protocol"
            : error.kind === "aborted"
              ? "cli.cancelled"
              : error.kind === "transport_error"
                ? "cli.transport"
                : "cli.internal";
  const local = createLocalError(
    code,
    correlationId,
    details ?? { operationKey: null, phase: "result-classifier" },
  );
  return failure(error.operationKey, localSemanticKind(code), local, []);
}

function localSemanticKind(code: LocalCode): CommandFailureSemanticKind {
  const row = localErrorRows.find((candidate) => candidate[0] === code);
  if (row === undefined) throw new TypeError("unknown local error code");
  if (!isCommandFailureSemanticKind(row[2]))
    throw new TypeError("local error is not a failure semantic kind");
  return row[2];
}
function failure(
  operationKey: string | null,
  semanticKind: CommandFailureSemanticKind,
  error: PublicErrorEnvelope,
  diagnostics: readonly DiagnosticV1[],
): CommandFailureV1 {
  return Object.freeze({
    version: 1,
    kind: "failure",
    operationKey,
    semanticKind,
    error,
    diagnostics,
  });
}
function protocolFailure(operationKey: string | null, correlationId: string): CommandFailureV1 {
  return failure(
    operationKey,
    "protocol",
    createLocalError("cli.protocol", correlationId, { operationKey, phase: "result-validation" }),
    [],
  );
}

const valueSemanticKinds = new Set<RegisteredValueSemanticKind>([
  "success",
  "stale",
  "expired",
  "cancelled",
  "attention",
  "partial",
  "uncertain",
]);
const valueSemanticKindSet = new Set<string>(valueSemanticKinds);
export type FeatureSelectionV1 = Readonly<{
  readonly version: 1;
  readonly operationKey: string;
  readonly semanticKind: string;
}>;
function allowedValueSemanticKind(
  operationKey: string,
  kind: RegisteredValueSemanticKind,
): boolean {
  if (operationKey === "action-plans.inspect" || operationKey === "action-plans.commit")
    return true;
  if (
    operationKey === "admin.doctor" ||
    operationKey === "sync.status" ||
    operationKey === "messages.label"
  )
    return kind === "success" || kind === "attention";
  return kind === "success";
}
export function parseFeatureSelection(
  input: unknown,
  operationKey: string,
  registry: OperationRegistry = operationRegistry,
): FeatureSelectionV1 {
  const value = recordValue(input);
  if (
    value === undefined ||
    !exactKeys(value, ["version", "operationKey", "semanticKind"]) ||
    value.version !== 1 ||
    value.operationKey !== operationKey ||
    !isValueSemanticKind(value.semanticKind) ||
    !allowedValueSemanticKind(operationKey, value.semanticKind)
  )
    throw new TypeError("invalid feature semantic selection");
  const operation = registry.get(operationKey);
  if (operation === undefined || operation.streaming === "bytes")
    throw new TypeError("feature semantic selection is not applicable");
  return { version: 1, operationKey, semanticKind: value.semanticKind };
}

type FactValue = unknown;
export type DomainFacts = Readonly<Record<string, FactValue>>;
type DomainExpression =
  | Readonly<{ readonly op: "const"; readonly value: boolean }>
  | Readonly<{ readonly op: "eq"; readonly fact: string; readonly value: unknown }>
  | Readonly<{ readonly op: "in"; readonly fact: string; readonly values: readonly unknown[] }>
  | Readonly<{ readonly op: "all" | "any"; readonly clauses: readonly DomainExpression[] }>
  | Readonly<{ readonly op: "not-null"; readonly fact: string }>;
type DomainOutcome =
  | Readonly<{ readonly kind: "constant"; readonly semanticKind: RegisteredValueSemanticKind }>
  | Readonly<{ readonly kind: "fact"; readonly fact: "registeredErrorSemanticKind" }>;
type DomainRule = Readonly<{
  readonly id: string;
  readonly when: DomainExpression;
  readonly outcome: DomainOutcome;
}>;

const eq = (fact: string, value: unknown): DomainExpression => ({ op: "eq", fact, value });
const any = (...clauses: DomainExpression[]): DomainExpression => ({ op: "any", clauses });
const all = (...clauses: DomainExpression[]): DomainExpression => ({ op: "all", clauses });
const constant = (
  id: string,
  when: DomainExpression,
  semanticKind: RegisteredValueSemanticKind,
): DomainRule => ({ id, when, outcome: { kind: "constant", semanticKind } });
const domainRules: readonly DomainRule[] = Object.freeze([
  {
    id: "DOMAIN-REGISTERED-ERROR",
    when: { op: "not-null", fact: "registeredErrorSemanticKind" },
    outcome: { kind: "fact", fact: "registeredErrorSemanticKind" },
  },
  constant(
    "DOMAIN-ACTION-UNCERTAIN",
    any(
      eq("planState", "uncertain"),
      eq("anyUncertainResult", true),
      eq("terminalState", "uncertain"),
      eq("executorDisposition", "unknown-after-restore"),
    ),
    "uncertain",
  ),
  constant(
    "DOMAIN-ACTION-PARTIAL",
    any(
      eq("planState", "partial"),
      eq("terminalState", "partial"),
      eq("mixedSuccessAndNonSuccess", true),
    ),
    "partial",
  ),
  constant(
    "DOMAIN-ACTION-STALE",
    any(
      all(eq("targetCoverage", "exact"), eq("allResultsStale", true)),
      eq("approvalState", "invalidated"),
    ),
    "stale",
  ),
  constant(
    "DOMAIN-ACTION-EXPIRED",
    any(eq("planState", "expired"), eq("terminalState", "expired"), eq("approvalState", "expired")),
    "expired",
  ),
  constant("DOMAIN-ACTION-CANCELLED", eq("approvalState", "cancelled"), "cancelled"),
  constant(
    "DOMAIN-ACTION-INSPECT-PENDING",
    all(eq("planState", "pending"), eq("resultsEmpty", true), eq("terminalState", "absent"), {
      op: "in",
      fact: "approvalState",
      values: ["absent", "available"],
    }),
    "success",
  ),
  constant(
    "DOMAIN-ACTION-INSPECT-COMPLETED",
    all(
      eq("planState", "completed"),
      eq("targetCoverage", "exact"),
      eq("anyNonSuccessResult", false),
      eq("approvalState", "consumed"),
      eq("terminalState", "completed"),
      eq("executorDisposition", "started"),
    ),
    "success",
  ),
  constant(
    "DOMAIN-ACTION-COMMIT-COMPLETED",
    all(
      eq("planState", "completed"),
      eq("targetCoverage", "exact"),
      eq("anyNonSuccessResult", false),
      eq("hasConsumptionReceipt", true),
    ),
    "success",
  ),
  constant("DOMAIN-ACTION-ATTENTION", { op: "const", value: true }, "attention"),
  constant("DOMAIN-DOCTOR-HEALTHY", eq("doctorStatus", "healthy"), "success"),
  constant(
    "DOMAIN-DOCTOR-ATTENTION",
    { op: "in", fact: "doctorStatus", values: ["degraded", "unhealthy"] },
    "attention",
  ),
  constant("DOMAIN-SYNC-AUTH-BLOCKED", eq("syncActorState", "authBlocked"), "attention"),
  constant(
    "DOMAIN-SYNC-STATUS",
    {
      op: "in",
      fact: "syncActorState",
      values: [
        "stopped",
        "starting",
        "backfilling",
        "watching",
        "sweeping",
        "retrying",
        "paused",
        "stopping",
      ],
    },
    "success",
  ),
  constant("DOMAIN-ROUTING-COMMITTED", all(eq("committed", true), eq("dryRun", false)), "success"),
  constant("DOMAIN-ROUTING-DRY-RUN", all(eq("committed", false), eq("dryRun", true)), "success"),
  constant("DOMAIN-LABEL-COMMITTED", all(eq("committed", true), eq("dryRun", false)), "success"),
  constant("DOMAIN-LABEL-DRY-RUN", all(eq("committed", false), eq("dryRun", true)), "success"),
  constant(
    "DOMAIN-LABEL-UNCOMMITTED",
    all(eq("committed", false), eq("dryRun", false)),
    "attention",
  ),
  constant("DOMAIN-DEFAULT-SUCCESS", { op: "const", value: true }, "success"),
]);
const selectorByOperation = new Map<string, readonly DomainRule[]>([
  [
    "action-plans.inspect",
    domainRules.filter(
      ({ id }) => id.startsWith("DOMAIN-REGISTERED") || id.startsWith("DOMAIN-ACTION"),
    ),
  ],
  [
    "action-plans.commit",
    domainRules.filter(({ id }) =>
      [
        "DOMAIN-REGISTERED-ERROR",
        "DOMAIN-ACTION-UNCERTAIN",
        "DOMAIN-ACTION-PARTIAL",
        "DOMAIN-ACTION-STALE",
        "DOMAIN-ACTION-EXPIRED",
        "DOMAIN-ACTION-COMMIT-COMPLETED",
        "DOMAIN-ACTION-ATTENTION",
      ].includes(id),
    ),
  ],
  [
    "admin.doctor",
    domainRules.filter(({ id }) =>
      ["DOMAIN-REGISTERED-ERROR", "DOMAIN-DOCTOR-HEALTHY", "DOMAIN-DOCTOR-ATTENTION"].includes(id),
    ),
  ],
  [
    "sync.status",
    domainRules.filter(({ id }) =>
      ["DOMAIN-REGISTERED-ERROR", "DOMAIN-SYNC-AUTH-BLOCKED", "DOMAIN-SYNC-STATUS"].includes(id),
    ),
  ],
  [
    "routing.commit",
    domainRules.filter(({ id }) =>
      ["DOMAIN-REGISTERED-ERROR", "DOMAIN-ROUTING-COMMITTED", "DOMAIN-ROUTING-DRY-RUN"].includes(
        id,
      ),
    ),
  ],
  [
    "messages.label",
    domainRules.filter(({ id }) =>
      [
        "DOMAIN-REGISTERED-ERROR",
        "DOMAIN-LABEL-COMMITTED",
        "DOMAIN-LABEL-DRY-RUN",
        "DOMAIN-LABEL-UNCOMMITTED",
      ].includes(id),
    ),
  ],
]);
function pathValue(input: unknown, path: readonly string[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    const record = recordValue(current);
    if (record === undefined || !(key in record)) return undefined;
    current = record[key];
  }
  return current;
}
function targetKey(value: unknown): string {
  return JSON.stringify([
    pathValue(value, ["accountId"]),
    pathValue(value, ["mailboxId"]),
    pathValue(value, ["uidValidity"]),
    pathValue(value, ["uid"]),
  ]);
}
function targetCoverage(data: unknown): string {
  const plan = recordValue(pathValue(data, ["plan"]));
  const targets = plan?.targets;
  const results = pathValue(data, ["results"]);
  if (!Array.isArray(targets) || !Array.isArray(results)) return "multiple-invalid";
  const expected = new Set(targets.map(targetKey));
  const actual = results.map((result) => targetKey(pathValue(result, ["target"])));
  const actualSet = new Set(actual);
  const problems: string[] = [];
  if (actual.length < expected.size || [...expected].some((key) => !actualSet.has(key)))
    problems.push("missing");
  if (actualSet.size < actual.length) problems.push("duplicate");
  if (actual.some((key) => !expected.has(key))) problems.push("unexpected");
  return problems.length === 0 ? "exact" : problems.length === 1 ? problems[0] : "multiple-invalid";
}
function unionDiscriminant(
  data: unknown,
  path: readonly string[],
  field: string,
  sentinel: string,
): unknown {
  const value = pathValue(data, path);
  return value === undefined || value === sentinel ? sentinel : pathValue(value, [field]);
}
export function projectDomainFacts(
  operationKey: string,
  data: unknown,
  registeredErrorSemanticKind: SemanticKind | null = null,
): DomainFacts {
  const results = pathValue(data, ["results"]);
  const rows = Array.isArray(results) ? results : [];
  const kinds = rows.map((row) => pathValue(row, ["kind"]));
  const selector = operationKey;
  const inputRegisteredError = pathValue(data, ["registeredErrorSemanticKind"]);
  const facts: Record<string, unknown> = {
    registeredErrorSemanticKind:
      inputRegisteredError === undefined ? registeredErrorSemanticKind : inputRegisteredError,
  };
  if (selector === "action-plans.inspect" || selector === "action-plans.commit")
    Object.assign(facts, {
      planState: pathValue(data, ["plan", "state"]),
      ...(selector === "action-plans.inspect" ? { resultsEmpty: rows.length === 0 } : {}),
      anyUncertainResult: kinds.some((kind) => kind === "uncertain"),
      mixedSuccessAndNonSuccess:
        kinds.includes("success") && kinds.some((kind) => kind !== "success"),
      allResultsStale: rows.length > 0 && kinds.every((kind) => kind === "stale"),
      anyNonSuccessResult: kinds.some((kind) => kind !== "success"),
      targetCoverage: targetCoverage(data),
      approvalState:
        selector === "action-plans.commit"
          ? "not-applicable"
          : unionDiscriminant(data, ["approvalState"], "state", "absent"),
      terminalState:
        selector === "action-plans.commit"
          ? "not-applicable"
          : unionDiscriminant(data, ["terminalAudit"], "terminalState", "absent"),
      executorDisposition:
        selector === "action-plans.commit"
          ? "not-applicable"
          : unionDiscriminant(data, ["terminalAudit"], "executorDisposition", "absent"),
      ...(selector === "action-plans.commit"
        ? { hasConsumptionReceipt: pathValue(data, ["consumptionReceipt"]) !== undefined }
        : {}),
    });
  if (selector === "admin.doctor") facts.doctorStatus = pathValue(data, ["status"]);
  if (selector === "sync.status") facts.syncActorState = pathValue(data, ["actorState"]);
  if (selector === "routing.commit" || selector === "messages.label") {
    facts.committed = pathValue(data, ["committed"]);
    facts.dryRun = pathValue(data, ["dryRun"]);
  }
  return Object.freeze(facts);
}
function evaluateExpression(expression: DomainExpression, facts: DomainFacts): boolean {
  switch (expression.op) {
    case "const":
      return expression.value;
    case "eq":
      return facts[expression.fact] === expression.value;
    case "in":
      return expression.values.some((value) => facts[expression.fact] === value);
    case "not-null":
      return facts[expression.fact] !== null && facts[expression.fact] !== undefined;
    case "all":
      return expression.clauses.every((clause) => evaluateExpression(clause, facts));
    case "any":
      return expression.clauses.some((clause) => evaluateExpression(clause, facts));
    default: {
      const exhaustive: never = expression;
      return exhaustive;
    }
  }
}
export type DomainOutcomeSelection = Readonly<{
  readonly ruleId: string | null;
  readonly semanticKind: RegisteredValueSemanticKind | SemanticKind;
  readonly localCode: string | null;
}>;
export function evaluateDomainOutcome(
  operationKey: string,
  facts: DomainFacts,
): DomainOutcomeSelection {
  const rules =
    selectorByOperation.get(operationKey) ??
    domainRules.filter(
      ({ id }) => id === "DOMAIN-REGISTERED-ERROR" || id === "DOMAIN-DEFAULT-SUCCESS",
    );
  for (const rule of rules)
    if (evaluateExpression(rule.when, facts))
      return {
        ruleId: rule.id,
        semanticKind:
          rule.outcome.kind === "fact"
            ? (facts.registeredErrorSemanticKind as SemanticKind)
            : rule.outcome.semanticKind,
        localCode: null,
      };
  return { ruleId: null, semanticKind: "protocol", localCode: "cli.protocol" };
}
export function selectDomainOutcome(
  operationKey: string,
  data: unknown,
  registeredErrorSemanticKind: SemanticKind | null = null,
): DomainOutcomeSelection {
  return evaluateDomainOutcome(
    operationKey,
    projectDomainFacts(operationKey, data, registeredErrorSemanticKind),
  );
}

export function createCommandValue(
  input: Readonly<{
    operationKey: string;
    data: unknown;
    semanticKind?: RegisteredValueSemanticKind;
    humanLines: CommandValueV1["humanLines"];
    diagnostics?: readonly DiagnosticV1[];
    registeredError?: unknown;
  }>,
  registry: OperationRegistry = operationRegistry,
): CommandValueV1 | CommandFailureV1 {
  const operation = registry.get(input.operationKey);
  if (operation === undefined || operation.streaming === "bytes")
    throw new TypeError("value result operation is not registered for values");
  if (input.registeredError !== undefined) {
    try {
      const mapped = parseRegisteredError(input.registeredError, input.operationKey, registry);
      if (!isCommandFailureSemanticKind(mapped.semanticKind))
        throw new TypeError("registered error is not a failure semantic kind");
      return failure(
        input.operationKey,
        mapped.semanticKind,
        mapped.error,
        input.diagnostics ?? [],
      );
    } catch {
      throw new TypeError("registered error does not satisfy the operation error contract");
    }
  }
  const possibleError = recordValue(input.data);
  if (possibleError?.code !== undefined) {
    try {
      const mapped = parseRegisteredError(input.data, input.operationKey, registry);
      if (!isCommandFailureSemanticKind(mapped.semanticKind))
        throw new TypeError("response error is not a failure semantic kind");
      return failure(
        input.operationKey,
        mapped.semanticKind,
        mapped.error,
        input.diagnostics ?? [],
      );
    } catch {
      throw new TypeError("response error does not satisfy the operation error contract");
    }
  }
  let data: unknown;
  try {
    data = operation.response.parse(input.data);
  } catch {
    throw new TypeError("value data does not satisfy the operation response");
  }
  const selection = selectDomainOutcome(input.operationKey, data);
  const semanticKind = input.semanticKind ?? selection.semanticKind;
  if (
    !isValueSemanticKind(semanticKind) ||
    semanticKind !== selection.semanticKind ||
    !allowedValueSemanticKind(input.operationKey, semanticKind)
  )
    throw new TypeError("value semantic kind disagrees with the domain classifier");
  return Object.freeze({
    version: 1,
    kind: "value",
    operationKey: input.operationKey,
    semanticKind,
    data,
    humanLines: input.humanLines,
    diagnostics: input.diagnostics ?? [],
  });
}
export function createCommandRaw(
  input: Readonly<{
    operationKey: string;
    stream: CliByteStream;
    diagnostics?: readonly DiagnosticV1[];
  }>,
  registry: OperationRegistry = operationRegistry,
): CommandRawV1 {
  const operation = registry.get(input.operationKey);
  if (
    operation === undefined ||
    operation.streaming !== "bytes" ||
    input.stream.operationKey !== input.operationKey ||
    typeof input.stream.body?.[Symbol.asyncIterator] !== "function"
  )
    throw new TypeError("raw stream is not registered for the operation");
  return Object.freeze({
    version: 1,
    kind: "raw",
    operationKey: input.operationKey,
    semanticKind: "success",
    stream: input.stream,
    diagnostics: input.diagnostics ?? [],
  });
}
export function createCommandFailure(
  input: Readonly<{
    operationKey?: string | null;
    semanticKind: CommandFailureSemanticKind;
    error: PublicErrorEnvelope;
    diagnostics?: readonly DiagnosticV1[];
  }>,
): CommandFailureV1 {
  return failure(
    input.operationKey ?? null,
    input.semanticKind,
    input.error,
    input.diagnostics ?? [],
  );
}

function validateDiagnostic(value: unknown): DiagnosticV1 {
  const record = recordValue(value);
  if (
    record === undefined ||
    !exactKeys(record, [
      "version",
      "kind",
      "level",
      "code",
      "message",
      "correlationId",
      "details",
    ]) ||
    record.version !== 1 ||
    record.kind !== "diagnostic" ||
    !["info", "warning"].includes(String(record.level)) ||
    typeof record.code !== "string" ||
    typeof record.message !== "string" ||
    (record.correlationId !== null && typeof record.correlationId !== "string") ||
    record.details === null ||
    typeof record.details !== "object" ||
    Array.isArray(record.details)
  )
    throw new TypeError("invalid diagnostic");
  if (
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(record.code) ||
    hasControlCharacters(record.message) ||
    (typeof record.correlationId === "string" && hasControlCharacters(record.correlationId)) ||
    new TextEncoder().encode(record.message).byteLength > 500 ||
    new TextEncoder().encode(JSON.stringify(record.details)).byteLength > 2048
  )
    throw new TypeError("diagnostic exceeds bounds");
  const forbidden = new Set([
    "cause",
    "credential",
    "credentials",
    "password",
    "rawmail",
    "secret",
    "stack",
    "token",
  ]);
  const inspect = (candidate: unknown): void => {
    const object = recordValue(candidate);
    if (object === undefined) {
      if (Array.isArray(candidate)) candidate.forEach(inspect);
      return;
    }
    for (const [key, nested] of Object.entries(object)) {
      if (forbidden.has(key.replaceAll("_", "").replaceAll("-", "").toLowerCase()))
        throw new TypeError("diagnostic contains forbidden detail");
      inspect(nested);
    }
  };
  inspect(record.details);
  return Object.freeze({
    version: 1,
    kind: "diagnostic",
    level: record.level === "warning" ? "warning" : "info",
    code: record.code,
    message: record.message,
    correlationId: record.correlationId,
    details: record.details as Readonly<Record<string, unknown>>,
  });
}
function parseResultCandidate(input: unknown, registry: OperationRegistry): CommandResultV1 {
  const value = recordValue(input);
  if (
    value === undefined ||
    value.version !== 1 ||
    (value.operationKey !== null && typeof value.operationKey !== "string") ||
    typeof value.kind !== "string" ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 16
  )
    throw new TypeError("invalid command result");
  const diagnostics = Object.freeze(value.diagnostics.map(validateDiagnostic));
  if (
    value.kind === "value" &&
    typeof value.operationKey === "string" &&
    exactKeys(value, [
      "version",
      "kind",
      "operationKey",
      "semanticKind",
      "data",
      "humanLines",
      "diagnostics",
    ]) &&
    isValueSemanticKind(value.semanticKind) &&
    Array.isArray(value.humanLines)
  ) {
    const operation = registry.get(value.operationKey);
    if (operation === undefined || operation.streaming === "bytes")
      throw new TypeError("value result operation is not applicable");
    const possibleError = recordValue(value.data);
    if (possibleError?.code !== undefined) {
      const mapped = parseRegisteredError(value.data, value.operationKey, registry);
      return failure(
        value.operationKey,
        isCommandFailureSemanticKind(mapped.semanticKind) ? mapped.semanticKind : "protocol",
        mapped.error,
        diagnostics,
      );
    }
    let data: unknown;
    try {
      data = operation.response.parse(value.data);
    } catch {
      throw new TypeError("value data does not satisfy the operation response");
    }
    const selection = selectDomainOutcome(value.operationKey, data);
    if (
      value.semanticKind !== selection.semanticKind ||
      !allowedValueSemanticKind(value.operationKey, value.semanticKind)
    )
      throw new TypeError("value semantic kind disagrees with the domain classifier");
    const lines: Array<readonly [HumanSegment, ...HumanSegment[]]> = value.humanLines.map(
      (line) => {
        if (!Array.isArray(line) || line.length === 0)
          throw new TypeError("human line must be non-empty");
        const segments = line.map((segment): HumanSegment => {
          renderHuman([segment as HumanSegment], defaultHumanTerminalPolicy("pipe"));
          return segment as HumanSegment;
        });
        const [head, ...tail] = segments;
        if (head === undefined) throw new TypeError("human line must be non-empty");
        return [head, ...tail];
      },
    );
    if (lines.length === 0) throw new TypeError("value requires a human line");
    const [head, ...tail] = lines;
    if (head === undefined) throw new TypeError("value requires a human line");
    return Object.freeze({
      version: 1,
      kind: "value",
      operationKey: value.operationKey,
      semanticKind: value.semanticKind,
      data,
      humanLines: [head, ...tail],
      diagnostics,
    });
  }
  if (
    value.kind === "raw" &&
    typeof value.operationKey === "string" &&
    exactKeys(value, [
      "version",
      "kind",
      "operationKey",
      "semanticKind",
      "stream",
      "diagnostics",
    ]) &&
    value.semanticKind === "success" &&
    value.stream !== null &&
    typeof value.stream === "object"
  ) {
    const operation = registry.get(value.operationKey);
    if (operation === undefined || operation.streaming !== "bytes")
      throw new TypeError("raw result operation is not a registered byte stream");
    const stream = value.stream as CliByteStream;
    if (
      stream.operationKey !== value.operationKey ||
      typeof stream.body?.[Symbol.asyncIterator] !== "function" ||
      typeof stream.cancel !== "function"
    )
      throw new TypeError("invalid raw stream");
    return Object.freeze({
      version: 1,
      kind: "raw",
      operationKey: value.operationKey,
      semanticKind: "success",
      stream,
      diagnostics,
    });
  }
  if (
    value.kind === "failure" &&
    exactKeys(value, ["version", "kind", "operationKey", "semanticKind", "error", "diagnostics"]) &&
    isCommandFailureSemanticKind(value.semanticKind)
  ) {
    if (value.operationKey !== null && registry.get(value.operationKey) === undefined)
      throw new TypeError("failure operation is not registered");
    let error: PublicErrorEnvelope;
    let mapped: SemanticKind;
    try {
      error = parseLocalError(value.error);
      if (!isLocalCode(error.code)) throw new TypeError("unknown local error code");
      mapped = localSemanticKind(error.code);
    } catch {
      if (value.operationKey === null)
        throw new TypeError("failure without an operation must use a local error");
      const registered = parseRegisteredError(value.error, value.operationKey, registry);
      error = registered.error;
      mapped = registered.semanticKind;
    }
    if (mapped !== value.semanticKind)
      throw new TypeError("failure semantic kind disagrees with registered error");
    return Object.freeze({
      version: 1,
      kind: "failure",
      operationKey: value.operationKey,
      semanticKind: value.semanticKind,
      error,
      diagnostics,
    });
  }
  throw new TypeError("unknown or malformed command result");
}
export function parseCommandResult(
  input: unknown,
  registry: OperationRegistry = operationRegistry,
): CommandResultV1 {
  return parseResultCandidate(input, registry);
}

function isEpipe(value: unknown): boolean {
  const record = recordValue(value);
  return record?.errorCode === "EPIPE" || record?.code === "EPIPE";
}
function isByteChunk(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}
function localCauseCode(error: unknown): string {
  if (error instanceof CliClientError) {
    const map: Readonly<Record<CliClientErrorKind, string>> = {
      connect_timeout: "cli.connect-timeout",
      control_timeout: "cli.control-timeout",
      stream_idle_timeout: "cli.stream-idle-timeout",
      client_contract_error: "cli.protocol",
      http_error: "cli.protocol",
      aborted: "cli.cancelled",
      transport_error: "cli.transport",
    };
    return map[error.kind];
  }
  if (isEpipe(error)) return "EPIPE";
  return "cli.internal";
}
function validAccepted(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function envelopeLine(error: PublicErrorEnvelope): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({ code: error.code, message: error.message, correlationId: error.correlationId, details: error.details })}\n`,
  );
}
function diagnosticLine(diagnostic: DiagnosticV1): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(diagnostic)}\n`);
}
function humanErrorLine(error: PublicErrorEnvelope): Uint8Array {
  return new TextEncoder().encode(
    `${renderHuman([trustedChrome("error["), untrustedValue(error.code), trustedChrome("]: "), untrustedValue(error.message), trustedChrome(" (correlation "), untrustedValue(error.correlationId), trustedChrome(")")])}\n`,
  );
}
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)))
      return true;
  }
  return false;
}

/** Execute one already validated result through injected sinks. No process globals or retries. */
export async function executeCommand(
  resultInput: unknown,
  context: CommandExecutionContextV1,
  registry: OperationRegistry = operationRegistry,
): Promise<ExecutionReceiptV1> {
  let stdoutBytesAccepted = 0;
  let stderrBytesAccepted = 0;
  let cleanupAwaited = false;
  let parsed = false;
  let cleanupPromise: Promise<void> | undefined;
  let ownedCleanup: (() => Promise<void>) | undefined;
  let activeOperationKey: string | null = null;
  let failedDestination: "stdout" | "stderr" | undefined;
  let failureCauseCode = "cli.internal";
  let failureBoundary: "stdout" | "stderr" | "client" | "render" | "cleanup" | "diagnostic" =
    "client";
  let failureSnapshot:
    | Readonly<{ readonly stdout: number | null; readonly stderr: number | null }>
    | undefined;
  let unknownAcceptance = false;
  let callerAborted = false;
  let terminal: Readonly<{ kind: "signal" | "epipe" | "partial"; code: number }> | undefined;
  const signalCode = (): 130 | 143 =>
    context.terminalSignal === "SIGTERM" || context.signal.reason === "SIGTERM" ? 143 : 130;
  const latch = (cause: Readonly<{ kind: "signal" | "epipe" | "partial"; code: number }>): void => {
    if (terminal?.kind === "signal") return;
    if (
      cause.kind === "signal" ||
      terminal === undefined ||
      (cause.kind === "epipe" && terminal.kind === "partial")
    )
      terminal = cause;
  };
  const onAbort = (): void => {
    const reason = context.signal.reason;
    const processSignal =
      context.terminalSignal !== undefined || reason === "SIGINT" || reason === "SIGTERM";
    if (processSignal) latch({ kind: "signal", code: signalCode() });
    else {
      callerAborted = true;
      failureCauseCode = "cli.cancelled";
      failureBoundary = "client";
      failureSnapshot = { stdout: stdoutBytesAccepted, stderr: stderrBytesAccepted };
      latch({ kind: "partial", code: 84 });
    }
  };
  const currentTerminal = ():
    | Readonly<{ kind: "signal" | "epipe" | "partial"; code: number }>
    | undefined => terminal;
  context.signal.addEventListener("abort", onAbort);
  const cleanup = async (): Promise<boolean> => {
    if (ownedCleanup === undefined && context.cleanup === undefined) return true;
    if (cleanupPromise === undefined)
      cleanupPromise = (async () => {
        let firstError: unknown;
        try {
          if (ownedCleanup !== undefined) await ownedCleanup();
        } catch (error) {
          firstError = error;
        }
        try {
          if (context.cleanup !== undefined) await context.cleanup();
        } catch (error) {
          if (firstError === undefined) firstError = error;
        }
        if (firstError !== undefined) throw firstError;
      })();
    try {
      await cleanupPromise;
      cleanupAwaited = true;
      return true;
    } catch {
      cleanupAwaited = true;
      failureCauseCode = "cli.internal";
      failureBoundary = "cleanup";
      failureSnapshot = { stdout: stdoutBytesAccepted, stderr: stderrBytesAccepted };
      latch({ kind: "partial", code: 88 });
      return false;
    }
  };
  const write = async (
    sink: CommandSink,
    bytes: Uint8Array,
    destination: "stdout" | "stderr",
  ): Promise<"ok" | "failed" | "epipe" | "signal"> => {
    const observedTerminal = terminal;
    if (observedTerminal?.kind === "signal") return "signal";
    let attempt: SinkWriteResultV1;
    try {
      attempt = await sink.write(bytes);
    } catch (error) {
      failedDestination = destination;
      failureCauseCode = localCauseCode(error);
      failureBoundary = destination;
      failureSnapshot = {
        stdout: destination === "stdout" ? null : stdoutBytesAccepted,
        stderr: destination === "stderr" ? null : stderrBytesAccepted,
      };
      unknownAcceptance = true;
      if (isEpipe(error)) latch({ kind: "epipe", code: 141 });
      else latch({ kind: "partial", code: 88 });
      return isEpipe(error) ? "epipe" : "failed";
    }
    if (attempt.kind === "written") {
      if (!validAccepted(attempt.bytesAccepted)) {
        failedDestination = destination;
        failureCauseCode = "cli.output-io";
        failureBoundary = destination;
        failureSnapshot = { stdout: stdoutBytesAccepted, stderr: stderrBytesAccepted };
        latch({ kind: "partial", code: 88 });
        return "failed";
      }
      if (destination === "stdout") stdoutBytesAccepted += attempt.bytesAccepted;
      else stderrBytesAccepted += attempt.bytesAccepted;
      if (attempt.bytesAccepted !== bytes.byteLength) {
        failedDestination = destination;
        failureCauseCode = "cli.output-io";
        failureBoundary = destination;
        failureSnapshot = { stdout: stdoutBytesAccepted, stderr: stderrBytesAccepted };
        latch({ kind: "partial", code: 88 });
        return "failed";
      }
      if (terminal?.kind === "signal") return "signal";
      return "ok";
    }
    if (isEpipe(attempt)) {
      failedDestination = destination;
      failureCauseCode = "EPIPE";
      failureBoundary = destination;
      failureSnapshot = { stdout: stdoutBytesAccepted, stderr: stderrBytesAccepted };
      latch({ kind: "epipe", code: 141 });
      return "epipe";
    }
    failedDestination = destination;
    failureCauseCode = "cli.output-io";
    failureBoundary = destination;
    if (attempt.bytesAccepted === "unknown") unknownAcceptance = true;
    if (attempt.bytesAccepted !== "unknown") {
      if (destination === "stdout") stdoutBytesAccepted += attempt.bytesAccepted;
      else stderrBytesAccepted += attempt.bytesAccepted;
    }
    if (attempt.bytesAccepted === "unknown")
      failureSnapshot = {
        stdout: destination === "stdout" ? null : stdoutBytesAccepted,
        stderr: destination === "stderr" ? null : stderrBytesAccepted,
      };
    else failureSnapshot = { stdout: stdoutBytesAccepted, stderr: stderrBytesAccepted };
    latch({ kind: "partial", code: 88 });
    return "failed";
  };
  const report = async (bytes: Uint8Array): Promise<"ok" | "failed" | "epipe" | "signal"> => {
    if (currentTerminal()?.kind === "signal") return "signal";
    let attempt: SinkWriteResultV1;
    try {
      attempt = await context.stderr.write(bytes);
    } catch (error) {
      if (isEpipe(error)) {
        latch({ kind: "epipe", code: 141 });
        return "epipe";
      }
      unknownAcceptance = true;
      latch({ kind: "partial", code: 88 });
      return "failed";
    }
    if (attempt.kind !== "written") {
      if (isEpipe(attempt)) {
        latch({ kind: "epipe", code: 141 });
        return "epipe";
      }
      if (attempt.bytesAccepted === "unknown") unknownAcceptance = true;
      else if (validAccepted(attempt.bytesAccepted)) stderrBytesAccepted += attempt.bytesAccepted;
      latch({ kind: "partial", code: 88 });
      return "failed";
    }
    if (!validAccepted(attempt.bytesAccepted)) {
      latch({ kind: "partial", code: 88 });
      return "failed";
    }
    stderrBytesAccepted += attempt.bytesAccepted;
    if (attempt.bytesAccepted !== bytes.byteLength) {
      latch({ kind: "partial", code: 88 });
      return "failed";
    }
    if (currentTerminal()?.kind === "signal") return "signal";
    return "ok";
  };
  const failureReceipt = async (
    state: "failed" | "epipe" | "signal",
    semanticKind: SemanticKind = "io",
  ): Promise<ExecutionReceiptV1> => {
    const cleanupOk = await cleanup();
    if (terminal?.kind === "signal" || state === "signal")
      return receipt("cancelled", terminal?.code ?? signalCode());
    if (terminal?.kind === "epipe" || state === "epipe") return receipt("partial_output", 141);
    const hasPrefix = stdoutBytesAccepted > 0 || stderrBytesAccepted > 0 || unknownAcceptance;
    const snapshot = failureSnapshot ?? {
      stdout: stdoutBytesAccepted,
      stderr: stderrBytesAccepted,
    };
    if (callerAborted && !hasPrefix) {
      const error = createLocalError("cli.cancelled", context.invocationCorrelationId, {
        operationKey: activeOperationKey,
        source: "caller",
      });
      if (failedDestination !== "stderr") {
        const state = await report(
          context.mode === "human" ? humanErrorLine(error) : envelopeLine(error),
        );
        if (state === "signal")
          return receipt("cancelled", currentTerminal()?.code ?? signalCode());
        if (state === "epipe") return receipt("partial_output", 141);
      }
      return receipt("cancelled", 84);
    }
    if (hasPrefix) {
      if (failedDestination !== "stderr") {
        const error = createLocalError("cli.partial-output", context.invocationCorrelationId, {
          operationKey: activeOperationKey,
          causeCode: failureCauseCode === "EPIPE" ? "cli.internal" : failureCauseCode,
          failedBoundary: failureBoundary,
          stdoutBytesAccepted: snapshot.stdout,
          stderrBytesAccepted: snapshot.stderr,
        });
        const state = await report(
          context.mode === "human" ? humanErrorLine(error) : envelopeLine(error),
        );
        if (state === "signal")
          return receipt("cancelled", currentTerminal()?.code ?? signalCode());
        if (state === "epipe") return receipt("partial_output", 141);
        if (state === "failed") return receipt("partial_output", 88);
      }
      return receipt("partial_output", 88);
    }
    if (!cleanupOk) {
      const error = createLocalError("cli.internal", context.invocationCorrelationId, {
        operationKey: activeOperationKey,
        phase: "cleanup",
      });
      const state = await report(
        context.mode === "human" ? humanErrorLine(error) : envelopeLine(error),
      );
      if (state === "signal") return receipt("cancelled", currentTerminal()?.code ?? signalCode());
      if (state === "epipe" || state === "failed")
        return receipt("partial_output", state === "epipe" ? 141 : 88);
      return receipt("internal", 70);
    }
    if (failedDestination !== undefined && failedDestination === "stdout") {
      const error = createLocalError("cli.output-io", context.invocationCorrelationId, {
        destination: "stdout",
        phase: "primary-frame",
      });
      const state = await report(
        context.mode === "human" ? humanErrorLine(error) : envelopeLine(error),
      );
      if (state === "signal") return receipt("cancelled", currentTerminal()?.code ?? signalCode());
      if (state === "epipe") return receipt("partial_output", 141);
      if (state === "failed") return receipt("partial_output", 88);
      return receipt("io", 74);
    }
    return receipt(semanticKind, exitCodeForSemanticKind(semanticKind));
  };
  try {
    const result = parseResultCandidate(resultInput, registry);
    parsed = true;
    activeOperationKey = result.operationKey;
    if (result.kind === "raw") ownedCleanup = result.stream.cancel;
    if (context.signal.aborted) {
      onAbort();
      if (callerAborted) return await failureReceipt("failed");
      return await failureReceipt("signal");
    }
    const operation =
      typeof result.operationKey === "string" ? registry.get(result.operationKey) : undefined;
    const modeMismatch = result.kind === "raw" ? context.mode !== "raw" : context.mode === "raw";
    if (modeMismatch) {
      const commandPath = operation?.cliName.replaceAll("-", " ") ?? null;
      const error = createLocalError("cli.usage", context.invocationCorrelationId, {
        commandPath,
        reasonCode: "mode-not-supported",
      });
      const state = await write(
        context.stderr,
        context.mode === "human" ? humanErrorLine(error) : envelopeLine(error),
        "stderr",
      );
      if (state !== "ok") return await failureReceipt(state);
      const cleanupOk = await cleanup();
      const afterCleanup = currentTerminal();
      if (afterCleanup?.kind === "signal") return receipt("cancelled", afterCleanup.code);
      if (callerAborted) return await failureReceipt("failed");
      if (!cleanupOk) return await failureReceipt("failed");
      return receipt("usage", 64);
    }
    if (result.kind === "raw") {
      ownedCleanup = result.stream.cancel;
      if (context.rawPolicy.destination === "tty" && context.rawPolicy.tty === "refuse") {
        const error = createLocalError("cli.raw-tty-refused", context.invocationCorrelationId, {
          operationKey: result.operationKey,
          destination: "tty",
        });
        const state = await write(context.stderr, envelopeLine(error), "stderr");
        if (state !== "ok") return await failureReceipt(state);
        const cleanupOk = await cleanup();
        const afterCleanup = currentTerminal();
        if (afterCleanup?.kind === "signal") return receipt("cancelled", afterCleanup.code);
        if (callerAborted) return await failureReceipt("failed");
        if (!cleanupOk) return await failureReceipt("failed");
        return receipt("usage", 64);
      }
      for (const diagnostic of result.diagnostics) {
        const bytes =
          context.mode === "human"
            ? new TextEncoder().encode(
                `${renderHuman([trustedChrome("diagnostic: "), untrustedValue(diagnostic.message)])}\n`,
              )
            : diagnosticLine(diagnostic);
        const state = await write(context.stderr, bytes, "stderr");
        if (state !== "ok") return await failureReceipt(state);
      }
      try {
        for await (const chunk of result.stream.body) {
          if (context.signal.aborted) {
            onAbort();
            break;
          }
          if (!isByteChunk(chunk)) {
            failureCauseCode = "cli.protocol";
            failureBoundary = "client";
            throw new TypeError("raw stream yielded a non-byte chunk");
          }
          const state = await write(context.stdout, chunk, "stdout");
          if (state !== "ok") return await failureReceipt(state);
        }
      } catch (error) {
        if (
          !(error instanceof CliClientError) &&
          failureCauseCode === "cli.protocol" &&
          stdoutBytesAccepted === 0 &&
          stderrBytesAccepted === 0
        ) {
          const protocol = createLocalError("cli.protocol", context.invocationCorrelationId, {
            operationKey: activeOperationKey,
            phase: "result-validation",
          });
          const cleaned = await cleanup();
          if (!cleaned) return await failureReceipt("failed");
          const report = await write(
            context.stderr,
            context.mode === "human" ? humanErrorLine(protocol) : envelopeLine(protocol),
            "stderr",
          );
          if (report !== "ok") return await failureReceipt(report);
          return receipt("protocol", 76);
        }
        if (
          error instanceof CliClientError &&
          stdoutBytesAccepted === 0 &&
          stderrBytesAccepted === 0
        ) {
          const classified = classifyCliClientError(error, context.invocationCorrelationId);
          const bytes =
            context.mode === "human"
              ? humanErrorLine(classified.error)
              : envelopeLine(classified.error);
          const cleaned = await cleanup();
          if (!cleaned) return await failureReceipt("failed");
          const report = await write(context.stderr, bytes, "stderr");
          if (report !== "ok") return await failureReceipt(report);
          return receipt(classified.semanticKind, exitCodeForSemanticKind(classified.semanticKind));
        }
        if (error instanceof CliClientError) {
          failureCauseCode = localCauseCode(error);
          failureBoundary = "client";
          failureSnapshot = { stdout: stdoutBytesAccepted, stderr: stderrBytesAccepted };
        }
        if (isEpipe(error)) latch({ kind: "epipe", code: 141 });
        else latch({ kind: "partial", code: 88 });
        return await failureReceipt(terminal?.kind === "epipe" ? "epipe" : "failed");
      }
      if (terminal !== undefined)
        return await failureReceipt(
          terminal.kind === "signal" ? "signal" : terminal.kind === "epipe" ? "epipe" : "failed",
        );
      const cleanupOk = await cleanup();
      const afterCleanup = currentTerminal();
      if (afterCleanup?.kind === "signal") return receipt("cancelled", afterCleanup.code);
      if (!cleanupOk) return await failureReceipt("failed");
      return receipt("success", 0);
    }
    const frames: readonly Uint8Array[] =
      result.kind === "value"
        ? context.mode === "json"
          ? [new TextEncoder().encode(renderJsonLine(result.data))]
          : [
              new TextEncoder().encode(
                `${result.humanLines.map((line) => renderHuman(line, defaultHumanTerminalPolicy("pipe"))).join("\n")}\n`,
              ),
            ]
        : [context.mode === "human" ? humanErrorLine(result.error) : envelopeLine(result.error)];
    for (const diagnostic of result.diagnostics) {
      const bytes =
        context.mode === "human"
          ? new TextEncoder().encode(
              `${renderHuman([trustedChrome("diagnostic: "), untrustedValue(diagnostic.message)])}\n`,
            )
          : diagnosticLine(diagnostic);
      const state = await write(context.stderr, bytes, "stderr");
      if (state !== "ok") return await failureReceipt(state);
    }
    const state = await write(
      result.kind === "failure" ? context.stderr : context.stdout,
      frames[0],
      result.kind === "failure" ? "stderr" : "stdout",
    );
    if (state !== "ok") return await failureReceipt(state);
    const cleanupOk = await cleanup();
    const afterCleanup = currentTerminal();
    if (afterCleanup?.kind === "signal") return receipt("cancelled", afterCleanup.code);
    if (callerAborted) return await failureReceipt("failed");
    if (!cleanupOk) return await failureReceipt("failed");
    return receipt(result.semanticKind, exitCodeForSemanticKind(result.semanticKind));
  } catch {
    if (!parsed) {
      const error = createLocalError("cli.protocol", context.invocationCorrelationId, {
        operationKey: null,
        phase: "result-validation",
      });
      if (stdoutBytesAccepted === 0 && stderrBytesAccepted === 0) {
        const report = await write(
          context.stderr,
          context.mode === "human" ? humanErrorLine(error) : envelopeLine(error),
          "stderr",
        );
        if (report !== "ok") return await failureReceipt(report);
      }
      const cleanupOk = await cleanup();
      if (terminal?.kind === "signal") return receipt("cancelled", terminal.code);
      if (!cleanupOk) return receipt("internal", 70);
      return receipt("protocol", 76);
    }
    const error = createLocalError("cli.internal", context.invocationCorrelationId, {
      operationKey: null,
      phase: "result-classifier",
    });
    const hadPrefixBeforeReport = stdoutBytesAccepted > 0 || stderrBytesAccepted > 0;
    if (!hadPrefixBeforeReport) {
      const report = await write(
        context.stderr,
        context.mode === "human" ? humanErrorLine(error) : envelopeLine(error),
        "stderr",
      );
      if (report !== "ok") return await failureReceipt(report);
    }
    const cleanupOk = await cleanup();
    if (terminal?.kind === "signal") return receipt("cancelled", terminal.code);
    if (!cleanupOk) return receipt("internal", 70);
    return receipt(
      hadPrefixBeforeReport ? "partial_output" : "internal",
      hadPrefixBeforeReport ? 88 : 70,
    );
  } finally {
    context.signal.removeEventListener("abort", onAbort);
  }
  function receipt(semanticKind: SemanticKind, exitCode: number): ExecutionReceiptV1 {
    const normal = receiptNormalExitCodes[semanticKind as keyof typeof receiptNormalExitCodes];
    const valid =
      normal === exitCode ||
      (semanticKind === "cancelled" && (exitCode === 130 || exitCode === 143)) ||
      (semanticKind === "partial_output" && exitCode === 141);
    if (!valid) throw new TypeError("invalid execution receipt pair");
    return Object.freeze({
      version: 1,
      semanticKind,
      exitCode,
      stdoutBytesAccepted,
      stderrBytesAccepted,
      cleanupAwaited,
    }) as ExecutionReceiptV1;
  }
}

export const commandOutcomeRegistry = Object.freeze({
  exitCodeRegistry,
  localDefinitions,
  semanticKinds,
  operationRegistry,
});
export type { CliResponse };
