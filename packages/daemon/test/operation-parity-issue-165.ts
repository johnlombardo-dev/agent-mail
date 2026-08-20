import { publicOperationDefinitions } from "../src/http";
import { operationCorpus } from "../../contracts/test/operation-corpus";

export type MatrixStatus = "pass" | "blocked" | "not-applicable";
export type MatrixOrigin = "real" | "mock" | "absent";
export type MatrixSurface =
  | "shared-contract"
  | "rest-direct"
  | "cli-composed"
  | "stream"
  | "production-adapter";

export type MatrixOutcomeKind =
  | "success"
  | "registered-error"
  | "client-error"
  | "attention"
  | "partial"
  | "uncertain"
  | "raw";

export type MatrixInvocation = Readonly<{
  readonly command: string;
  readonly artifact: string;
}>;

export type MatrixCell = Readonly<{
  readonly status: MatrixStatus;
  readonly origin: MatrixOrigin;
  readonly invocation: keyof typeof parityMatrixInvocations | null;
  readonly reason: string;
}>;

export type MatrixOutcomeCell = MatrixCell & Readonly<{ readonly outcome: MatrixOutcomeKind }>;

export type OperationParityRow = Readonly<{
  readonly operation: string;
  readonly route: string;
  readonly method: string;
  readonly cliName: string;
  readonly scope: string | null;
  readonly streaming: "none" | "ndjson" | "bytes";
  readonly applicability: Readonly<Record<MatrixSurface, "required" | "not-applicable">>;
  readonly cells: Readonly<Record<MatrixSurface, MatrixCell>>;
  readonly outcomes: Readonly<Record<MatrixOutcomeKind, MatrixOutcomeCell>>;
}>;

/** Exact commands and retained artifacts for every matrix and authority invocation. */
export const parityMatrixInvocations = Object.freeze({
  "shared-contract": {
    command:
      "bun test packages/contracts/test/operation-corpus.test.ts tests/parity-matrix/harness.test.ts",
    artifact: "packages/contracts/test/operation-corpus.test.ts",
  },
  "rest-direct": {
    command:
      'bun test packages/daemon/test/operation-parity-issue-165.test.ts --test-name-pattern "direct REST"',
    artifact: "packages/daemon/test/operation-parity-issue-165.test.ts",
  },
  "cli-composed": {
    command:
      'bun test packages/daemon/test/operation-parity-issue-165.test.ts --test-name-pattern "composed CLI"',
    artifact: "packages/daemon/test/operation-parity-issue-165.test.ts",
  },
  "production-adapter": {
    command:
      'bun test packages/daemon/test/operation-parity-issue-165.test.ts --test-name-pattern "production adapter"',
    artifact: "packages/daemon/test/operation-parity-issue-165.test.ts",
  },
  "stream-bytes": {
    command:
      "bun test packages/daemon/test/content-streaming-p6-c05.test.ts packages/daemon/test/selected-export-stream-p6-c19.test.ts packages/cli/src/raw-content-command.test.ts packages/cli/src/selected-export-command.test.ts",
    artifact: "packages/daemon/test/content-streaming-p6-c05.test.ts",
  },
  "retrieval-real": {
    command:
      "bun test packages/daemon/test/retrieval-handlers-p6-c04.test.ts packages/daemon/test/retrieval-error-closure-p6-c20.test.ts",
    artifact: "packages/daemon/test/retrieval-handlers-p6-c04.test.ts",
  },
  "raw-real": {
    command: "bun test packages/daemon/test/content-streaming-p6-c05.test.ts",
    artifact: "packages/daemon/test/content-streaming-p6-c05.test.ts",
  },
  "routing-real": {
    command:
      "bun test packages/daemon/test/routing-handlers-p6-c06.test.ts packages/daemon/test/routing-caller-adapter-p4-c14.test.ts",
    artifact: "packages/daemon/test/routing-handlers-p6-c06.test.ts",
  },
  "operator-native": {
    command: "bun test packages/daemon/test/action-authority-http.test.ts",
    artifact: "packages/daemon/test/action-authority-http.test.ts",
  },
  "report-real": {
    command:
      "bun test packages/daemon/test/report-create-composed.test.ts packages/daemon/test/report-create-http.test.ts",
    artifact: "packages/daemon/test/report-create-composed.test.ts",
  },
  "export-real": {
    command: "bun test packages/daemon/test/selected-export-stream-p6-c19.test.ts",
    artifact: "packages/daemon/test/selected-export-stream-p6-c19.test.ts",
  },
  "admin-real": {
    command: "bun test packages/daemon/test/admin-parity-issue-164.test.ts",
    artifact: "packages/daemon/test/admin-parity-issue-164.test.ts",
  },
  "sync-real": {
    command: "bun test packages/daemon/test/sync-http-issue-147.test.ts",
    artifact: "packages/daemon/test/sync-http-issue-147.test.ts",
  },
  "routing-cli-real": {
    command: "bun test packages/cli/src/routing-commands.test.ts",
    artifact: "packages/cli/src/routing-commands.test.ts",
  },
  "report-cli-real": {
    command: "bun test packages/cli/src/report-create-command.test.ts",
    artifact: "packages/cli/src/report-create-command.test.ts",
  },
  "export-cli-real": {
    command: "bun test packages/cli/src/selected-export-command.test.ts",
    artifact: "packages/cli/src/selected-export-command.test.ts",
  },
  "admin-cli-real": {
    command: "bun test packages/daemon/test/admin-parity-issue-164.test.ts",
    artifact: "packages/daemon/test/admin-parity-issue-164.test.ts",
  },
  "outcome-authority": {
    command: "bun test packages/cli/src/command-outcome.test.ts",
    artifact: "packages/cli/src/command-outcome.test.ts",
  },
  "action-outcomes": {
    command: "bun test packages/cli/src/action-plan-command.test.ts",
    artifact: "packages/cli/src/action-plan-command.test.ts",
  },
  "raw-cli": {
    command:
      "bun test packages/cli/src/raw-content-command.test.ts packages/cli/src/selected-export-command.test.ts",
    artifact: "packages/cli/src/raw-content-command.test.ts",
  },
} as const satisfies Readonly<Record<string, MatrixInvocation>>);

export const matrixOutcomeKinds: readonly MatrixOutcomeKind[] = Object.freeze([
  "success",
  "registered-error",
  "client-error",
  "attention",
  "partial",
  "uncertain",
  "raw",
]);

const sharedReason =
  "Request, response, declared errors, and stream metadata are parsed from the shared corpus.";
const genericRestReason =
  "The route probe uses a schema-valid fixture handler; generic transport evidence does not prove feature composition.";
const genericCliReason =
  "The operation has a CLI registry entry, but no accepted composed CLI-through-real-service observation exists for this row.";
const missingAdapterReason =
  "No accepted production adapter invocation exists for this operation; the cell remains red rather than promoting a mock.";
const unsupportedStreamReason =
  "The operation declares a stream mode outside the accepted none/ndjson/bytes closure; fail closed until a mode-specific proof exists.";

function cell(
  status: MatrixStatus,
  origin: MatrixOrigin,
  invocation: MatrixCell["invocation"],
  reason: string,
): MatrixCell {
  return { status, origin, invocation, reason };
}

function outcomeCell(
  outcome: MatrixOutcomeKind,
  status: MatrixStatus,
  origin: MatrixOrigin,
  invocation: MatrixCell["invocation"],
  reason: string,
): MatrixOutcomeCell {
  return { outcome, status, origin, invocation, reason };
}

function sharedCorpusApplicabilityMatches(
  operation: (typeof publicOperationDefinitions)[number],
): boolean {
  const entry = operationCorpus[operation.key];
  if (entry === undefined) return false;
  return JSON.stringify(operation.errors.map(({ code }) => code).sort()) ===
    JSON.stringify(entry.errors.map(({ code }) => code).sort());
}

const realEvidence: Readonly<Record<string, keyof typeof parityMatrixInvocations>> = Object.freeze({
  "messages.search": "retrieval-real",
  "messages.get": "retrieval-real",
  "threads.get": "retrieval-real",
  "messages.raw": "raw-real",
  "attachments.get": "raw-real",
  "routing.preview": "routing-real",
  "routing.commit": "routing-real",
  "messages.label": "routing-real",
  "operator-sessions.create": "operator-native",
  "reports.create": "report-real",
  "exports.selected": "export-real",
  "admin.backup": "admin-real",
  "admin.restore": "admin-real",
  "admin.doctor": "admin-real",
  "admin.reindex": "admin-real",
  "sync.status": "sync-real",
  "sync.start": "sync-real",
  "sync.pause": "sync-real",
  "sync.resume": "sync-real",
  "sync.stop": "sync-real",
});

const cliEvidence: Readonly<Record<string, keyof typeof parityMatrixInvocations>> = Object.freeze({
  "routing.preview": "routing-cli-real",
  "routing.commit": "routing-cli-real",
  "messages.label": "routing-cli-real",
  "reports.create": "report-cli-real",
  "exports.selected": "export-cli-real",
  "admin.backup": "admin-cli-real",
  "admin.restore": "admin-cli-real",
  "admin.doctor": "admin-cli-real",
  "admin.reindex": "admin-cli-real",
});

const knownStreamModes = Object.freeze(["none", "ndjson", "bytes"] as const);
export function isKnownStreamMode(value: string): value is (typeof knownStreamModes)[number] {
  return knownStreamModes.some((mode) => mode === value);
}

function outcomeCoverage(
  operation: (typeof publicOperationDefinitions)[number],
): Readonly<Record<MatrixOutcomeKind, MatrixOutcomeCell>> {
  const operationKey = operation.key;
  const stream = operation.streaming === "bytes";
  const cli = operation.scope !== null;
  const action = operationKey === "action-plans.inspect" || operationKey === "action-plans.commit";
  const attention =
    operationKey === "admin.doctor" ||
    operationKey === "sync.status" ||
    operationKey === "messages.label" ||
    action;
  return Object.freeze({
    success: outcomeCell(
      "success",
      "pass",
      "real",
      "outcome-authority",
      "#213/#214 success selection and exit proof is accepted; surface cells below retain endpoint-specific gaps.",
    ),
    "registered-error": operation.errors.length === 0
      ? outcomeCell(
          "registered-error",
          "not-applicable",
          "real",
          null,
          "The operation declares no operation-scoped registered error; shared client errors remain covered centrally.",
        )
      : outcomeCell(
          "registered-error",
          "pass",
          "real",
          "outcome-authority",
          "The accepted #213/#214 registered-error precedence and typed operation applicability proof covers this declared error set.",
        ),
    "client-error": cli
      ? outcomeCell(
          "client-error",
          "pass",
          "real",
          "outcome-authority",
          "The accepted #214 seven-kind client-error mapping is exercised without operation-local exit tables.",
        )
      : outcomeCell(
          "client-error",
          "not-applicable",
          "real",
          null,
          "Loopback operator-session issuance has no CLI client operation by contract.",
        ),
    attention: attention
      ? outcomeCell(
          "attention",
          "pass",
          "real",
          action ? "action-outcomes" : "outcome-authority",
          "The accepted domain selector preserves a validated attention value with its nonzero semantic exit.",
        )
      : outcomeCell(
          "attention",
          "not-applicable",
          "real",
          null,
          "No accepted attention-valued outcome is applicable to this operation.",
        ),
    partial: action
      ? outcomeCell(
          "partial",
          "pass",
          "real",
          "action-outcomes",
          "Action command evidence exercises partial target results and the shared partial exit.",
        )
      : outcomeCell(
          "partial",
          "not-applicable",
          "real",
          null,
          "No partial domain result is declared for this operation.",
        ),
    uncertain: action
      ? outcomeCell(
          "uncertain",
          "pass",
          "real",
          "action-outcomes",
          "Action command evidence exercises uncertain postconditions and the shared uncertain exit.",
        )
      : outcomeCell(
          "uncertain",
          "not-applicable",
          "real",
          null,
          "No uncertain domain result is declared for this operation.",
        ),
    raw: stream
      ? outcomeCell(
          "raw",
          "pass",
          "real",
          operationKey === "exports.selected" ? "export-cli-real" : "raw-cli",
          "Mode-specific raw output evidence preserves exact bytes, diagnostics separation, and cleanup.",
        )
      : outcomeCell(
          "raw",
          "not-applicable",
          "real",
          null,
          "Value operations do not permit raw output mode under #213/#214.",
        ),
  });
}

function realCell(operationKey: string): MatrixCell {
  const invocation = realEvidence[operationKey];
  if (invocation === undefined) {
    return cell("blocked", "absent", "production-adapter", missingAdapterReason);
  }
  return cell(
    "pass",
    "real",
    invocation,
    `Concrete operation evidence is retained at ${parityMatrixInvocations[invocation].artifact}.`,
  );
}

/**
 * Complete operation inventory. Cells only pass where a concrete accepted
 * feature test observes the operation; generic fixture transport remains red.
 */
export const operationParityRows: readonly OperationParityRow[] = Object.freeze(
  publicOperationDefinitions.map((operation) => {
    const cliApplicable = operation.scope !== null;
    const streamApplicable = operation.streaming !== "none";
    const streamKnown = isKnownStreamMode(operation.streaming);
    const concreteCli = cliEvidence[operation.key];
    const cliCell = !cliApplicable
      ? cell("not-applicable", "real", null, "Loopback operator-session issuance has CLI N/A by contract.")
      : concreteCli === undefined
        ? cell("blocked", "absent", "cli-composed", genericCliReason)
        : cell(
            "pass",
            "real",
            concreteCli,
            `CLI-through-real-service evidence is retained at ${parityMatrixInvocations[concreteCli].artifact}.`,
          );
    const streamCell = !streamApplicable
      ? cell("not-applicable", "real", null, "The operation declares streaming=none.")
      : !streamKnown
        ? cell("blocked", "absent", "stream-bytes", unsupportedStreamReason)
        : operation.streaming === "bytes" &&
            (operation.key === "messages.raw" ||
              operation.key === "attachments.get" ||
              operation.key === "exports.selected")
          ? cell(
              "pass",
              "real",
              "stream-bytes",
              `The ${operation.streaming} stream proof is mode-specific for ${operation.key}; no NDJSON proof is reused.`,
            )
          : cell("blocked", "absent", "stream-bytes", "No executable stream producer proof is retained for this mode.");
    const sharedCell = sharedCorpusApplicabilityMatches(operation)
      ? cell("pass", "real", "shared-contract", sharedReason)
      : cell(
          "blocked",
          "real",
          "shared-contract",
          "The registry error applicability differs from the retained shared corpus; preserve the red contract seam.",
        );
    const restCell = realEvidence[operation.key] === undefined
      ? cell("blocked", "mock", "rest-direct", genericRestReason)
      : realCell(operation.key);
    const productionCell = realEvidence[operation.key] === undefined
      ? cell("blocked", "absent", "production-adapter", missingAdapterReason)
      : realCell(operation.key);
    return {
      operation: operation.key,
      route: operation.route,
      method: operation.method,
      cliName: operation.cliName,
      scope: operation.scope,
      streaming: operation.streaming,
      applicability: {
        "shared-contract": "required",
        "rest-direct": "required",
        "cli-composed": cliApplicable ? "required" : "not-applicable",
        stream: streamApplicable ? "required" : "not-applicable",
        "production-adapter": "required",
      },
      cells: {
        "shared-contract": sharedCell,
        "rest-direct": restCell,
        "cli-composed": cliCell,
        stream: streamCell,
        "production-adapter": productionCell,
      },
      outcomes: outcomeCoverage(operation),
    } satisfies OperationParityRow;
  }),
);

export const securityParityRows = Object.freeze([
  {
    id: "same-token-self-approval",
    invariant: "An acting credential cannot mint the independent approval it consumes.",
    status: "pass" as const,
    command:
      "bun test packages/daemon/test/action-approval-service-composed.test.ts && bun test packages/storage/test/action-approval-authority.test.ts --test-name-pattern 'same-token|authority bindings|persists strict authority'",
    artifact: "packages/daemon/test/action-approval-service-composed.test.ts",
  },
  {
    id: "caller-spoofed-principal",
    invariant: "Caller-supplied principal data cannot override authenticated provenance.",
    status: "pass" as const,
    command:
      "bun test packages/daemon/test/action-authority-http.test.ts --test-name-pattern 'caller-supplied|validated authenticated profile'",
    artifact: "packages/daemon/test/action-authority-http.test.ts",
  },
  {
    id: "oversized-request-admission",
    invariant: "Oversized bodies are rejected before JSON materialization.",
    status: "pass" as const,
    command: "bun test packages/daemon/test/http-admission-sec-r03.test.ts",
    artifact: "packages/daemon/test/http-admission-sec-r03.test.ts",
  },
  {
    id: "wrong-scope-body-not-read",
    invariant: "Wrong-scope credentials cannot cause body reads or handler invocation.",
    status: "pass" as const,
    command: "bun test packages/daemon/test/http-admission-sec-r03.test.ts",
    artifact: "packages/daemon/test/http-admission-sec-r03.test.ts",
  },
  {
    id: "hostile-terminal-values",
    invariant: "Hostile terminal values remain inert in human output.",
    status: "pass" as const,
    command: "bun test packages/cli/test/output-context.test.ts",
    artifact: "packages/cli/test/output-context.test.ts",
  },
  {
    id: "raw-byte-preservation",
    invariant: "Permitted raw and attachment streams remain byte exact.",
    status: "pass" as const,
    command:
      "bun test packages/cli/src/raw-content-command.test.ts packages/cli/src/selected-export-command.test.ts",
    artifact: "packages/cli/src/raw-content-command.test.ts",
  },
] as const);

export const parityNegativeFixtures = Object.freeze([
  {
    id: "removed-cli-cell",
    mutation: "remove cli-composed evidence for messages.search",
    expected: "incomplete with missing-cell diagnostic",
  },
  {
    id: "mistyped-production-operation",
    mutation: "replace production-adapter operation key with messages.searchx",
    expected: "incomplete with unknown-cell and missing-cell diagnostics",
  },
] as const);

export const parityPlanningHashes = Object.freeze({
  plan: "6daf232f6d2895b3e76bdde9a8fb51da31b4506d8c2b2cab7544147ddf6257ce",
  evidence: "92ad4982f2d2edc94acae40f7b7fd5b149a674ecf6600823ff895f1a29c9b87e",
});
