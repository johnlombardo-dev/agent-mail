import {
  assertCorpusComplete,
  parseByteStreamMetadata,
  parseNdjsonRecord,
  parseStreamMetadata,
  type OperationCorpus,
} from "../../packages/contracts/test/operation-corpus";
import type {
  OperationDefinition,
  OperationSchema,
  OperationStreaming,
} from "../../packages/contracts/src/index";

/** The only outcomes a parity cell may report. */
export type ParityCellStatus = "pass" | "fail" | "blocked" | "not-applicable";

/** Evidence origin is part of the result so fixtures cannot masquerade as production. */
export type ParityEvidenceOrigin = "real" | "mock" | "absent";

export type ParitySurface =
  | "shared-contract"
  | "rest-direct"
  | "cli-composed"
  | "production-adapter"
  | "stream";

export type ParityEvidence = Readonly<{
  readonly operationKey: string;
  readonly status: ParityCellStatus;
  readonly origin: ParityEvidenceOrigin;
  /** Stable path, test id, or retained probe identifier. */
  readonly evidence: string;
  /** Stable explanation of what the evidence does or does not prove. */
  readonly reason: string;
  /** Required for stream cells; prevents a byte fixture being used for NDJSON. */
  readonly streaming?: OperationStreaming;
}>;

export type ParityCell = Readonly<{
  readonly status: ParityCellStatus;
  readonly evidence: string;
  readonly reason: string;
  readonly origin: ParityEvidenceOrigin;
}>;

export type ParityRow = Readonly<{
  readonly operationKey: string;
  readonly route: string;
  readonly cliName: string;
  readonly streamMode: OperationStreaming;
  readonly sharedContract: ParityCell;
  readonly restDirectSurface: ParityCell;
  readonly cliComposedSurface: ParityCell;
  readonly productionAdapter: ParityCell;
  readonly streamBehavior: ParityCell;
}>;

export type ParityDiagnosticCode =
  | "missing-cell"
  | "duplicate-cell"
  | "unknown-cell"
  | "invalid-cell"
  | "incomplete-corpus";

export type ParityDiagnostic = Readonly<{
  readonly code: ParityDiagnosticCode;
  readonly surface: ParitySurface | "corpus";
  readonly operationKey: string;
  readonly message: string;
}>;

export type ParityMatrix = Readonly<{
  readonly complete: boolean;
  readonly rows: readonly ParityRow[];
  readonly diagnostics: readonly ParityDiagnostic[];
}>;

export type ParityMatrixInput = Readonly<{
  readonly operations: readonly OperationDefinition<OperationSchema, OperationSchema>[];
  readonly corpus: OperationCorpus;
  readonly restDirect: readonly ParityEvidence[];
  readonly cliComposed: readonly ParityEvidence[];
  readonly productionAdapter: readonly ParityEvidence[];
  readonly stream: readonly ParityEvidence[];
}>;

const surfaceOrder: readonly ParitySurface[] = [
  "rest-direct",
  "cli-composed",
  "production-adapter",
  "stream",
];

function nonEmpty(value: string): boolean {
  return value.trim() !== "" && value === value.trim() && !/[\r\n]/u.test(value);
}

function blockedEvidence(
  operationKey: string,
  reason: string,
  surface: ParitySurface,
): ParityEvidence {
  return {
    operationKey,
    status: "blocked",
    origin: "absent",
    evidence: `missing:${surface}:${operationKey}`,
    reason,
  };
}

/** Build explicit baseline cells for surfaces that do not exist in this phase. */
export function absentSurfaceEvidence(
  operations: readonly OperationDefinition[],
  surface: Exclude<ParitySurface, "shared-contract" | "stream">,
): readonly ParityEvidence[] {
  const reason =
    surface === "rest-direct"
      ? "REST direct operation surface is not implemented."
      : surface === "cli-composed"
        ? "CLI command registry is data-only; composed execution is not implemented."
        : "No production operation adapter is registered.";
  return operations.map(({ key }) => blockedEvidence(key, reason, surface));
}

/** Build stream cells from the contract corpus without claiming executable stream evidence. */
export function corpusStreamEvidence(
  operations: readonly OperationDefinition[],
  corpus: OperationCorpus,
): readonly ParityEvidence[] {
  return operations.map((operation) => {
    if (operation.streaming === "none") {
      return {
        operationKey: operation.key,
        status: "not-applicable",
        origin: "real",
        evidence: `contract:${operation.key}:streaming=none`,
        reason: "Operation does not declare a stream.",
        streaming: "none",
      } satisfies ParityEvidence;
    }
    const entry = corpus[operation.key];
    if (entry?.stream === undefined) {
      return {
        ...blockedEvidence(
          operation.key,
          `Corpus has no ${operation.streaming} stream fixture.`,
          "stream",
        ),
        streaming: operation.streaming,
      } satisfies ParityEvidence;
    }
    return {
      operationKey: operation.key,
      status: "blocked",
      origin: "absent",
      evidence: `corpus:${operation.key}:stream-metadata`,
      reason: `Corpus validates ${operation.streaming} metadata only; no executable stream producer is registered.`,
      streaming: operation.streaming,
    } satisfies ParityEvidence;
  });
}

function diagnostic(
  code: ParityDiagnosticCode,
  surface: ParitySurface | "corpus",
  operationKey: string,
  message: string,
): ParityDiagnostic {
  return { code, surface, operationKey, message };
}

function validateEvidence(
  surface: ParitySurface,
  evidence: readonly ParityEvidence[],
  expectedKeys: readonly string[],
): readonly ParityDiagnostic[] {
  const expectedSet = new Set(expectedKeys);
  const seen = new Set<string>();
  const diagnostics: ParityDiagnostic[] = [];
  for (const cell of evidence) {
    if (!expectedSet.has(cell.operationKey)) {
      diagnostics.push(
        diagnostic(
          "unknown-cell",
          surface,
          cell.operationKey,
          `unknown ${surface} cell for operation ${cell.operationKey}`,
        ),
      );
    }
    if (seen.has(cell.operationKey)) {
      diagnostics.push(
        diagnostic(
          "duplicate-cell",
          surface,
          cell.operationKey,
          `duplicate ${surface} cell for operation ${cell.operationKey}`,
        ),
      );
    }
    seen.add(cell.operationKey);
    if (!nonEmpty(cell.evidence) || !nonEmpty(cell.reason)) {
      diagnostics.push(
        diagnostic(
          "invalid-cell",
          surface,
          cell.operationKey,
          `${surface} cell for operation ${cell.operationKey} needs stable evidence and reason text`,
        ),
      );
    }
    if (cell.status === "pass" && cell.origin !== "real") {
      diagnostics.push(
        diagnostic(
          "invalid-cell",
          surface,
          cell.operationKey,
          `${surface} cell for operation ${cell.operationKey} cannot pass with ${cell.origin} evidence`,
        ),
      );
    }
  }
  for (const key of expectedKeys) {
    if (!seen.has(key)) {
      diagnostics.push(
        diagnostic("missing-cell", surface, key, `missing ${surface} cell for operation ${key}`),
      );
    }
  }
  return diagnostics;
}

function cellFor(
  surface: ParitySurface,
  operationKey: string,
  evidence: readonly ParityEvidence[],
): ParityCell {
  const match = evidence.find(({ operationKey: candidate }) => candidate === operationKey);
  if (match === undefined) {
    return {
      status: "fail",
      origin: "absent",
      evidence: `missing:${surface}:${operationKey}`,
      reason: `No ${surface} cell was provided.`,
    };
  }
  if (match.status === "pass" && match.origin !== "real") {
    return {
      status: "fail",
      origin: match.origin,
      evidence: match.evidence,
      reason: `${match.reason} Mock-only or absent evidence cannot establish a pass.`,
    };
  }
  return {
    status: match.status,
    origin: match.origin,
    evidence: match.evidence,
    reason: match.reason,
  };
}

function validateStreamMode(
  operations: readonly OperationDefinition[],
  evidence: readonly ParityEvidence[],
): readonly ParityDiagnostic[] {
  const byKey = new Map(operations.map((operation) => [operation.key, operation.streaming]));
  const diagnostics: ParityDiagnostic[] = [];
  for (const cell of evidence) {
    const expected = byKey.get(cell.operationKey);
    if (expected === undefined) continue;
    if (cell.streaming === undefined) {
      diagnostics.push(
        diagnostic(
          "invalid-cell",
          "stream",
          cell.operationKey,
          `stream cell for operation ${cell.operationKey} must declare ${expected}`,
        ),
      );
      continue;
    }
    if (cell.streaming !== expected) {
      diagnostics.push(
        diagnostic(
          "invalid-cell",
          "stream",
          cell.operationKey,
          `stream cell for operation ${cell.operationKey} declares ${cell.streaming}; expected ${expected}`,
        ),
      );
    }
  }
  return diagnostics;
}

function validateCorpus(
  operations: readonly OperationDefinition<OperationSchema, OperationSchema>[],
  corpus: OperationCorpus,
): readonly ParityDiagnostic[] {
  try {
    assertCorpusComplete(operations, corpus);
    for (const operation of operations) {
      const entry = corpus[operation.key];
      if (entry === undefined) continue;
      operation.request.parse(entry.request);
      operation.response.parse(entry.success);
      for (const error of entry.errors) operation.response.parse(error.response);
      if (entry.stream !== undefined) {
        const parseMetadata =
          operation.key === "exports.selected" ? parseByteStreamMetadata : parseStreamMetadata;
        parseMetadata(entry.stream);
        if (operation.streaming === "ndjson") parseNdjsonRecord(entry.stream);
      }
    }
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "corpus validation failed";
    return [diagnostic("incomplete-corpus", "corpus", "*", message)];
  }
}

function rowIsComplete(row: ParityRow): boolean {
  const established = (cell: ParityCell): boolean =>
    cell.status === "pass" || cell.status === "not-applicable";
  return (
    established(row.sharedContract) &&
    established(row.restDirectSurface) &&
    established(row.cliComposedSurface) &&
    established(row.productionAdapter) &&
    established(row.streamBehavior)
  );
}

/**
 * Build the operation parity matrix. Rows always follow shared operation order;
 * structural diagnostics make incomplete evidence visible instead of silently
 * dropping operations or surfaces.
 */
export function buildParityMatrix(input: ParityMatrixInput): ParityMatrix {
  const operations = input.operations;
  const expectedKeys = operations.map(({ key }) => key);
  const diagnostics = [
    ...validateCorpus(operations, input.corpus),
    ...surfaceOrder.flatMap((surface) =>
      validateEvidence(
        surface,
        input[
          surface === "rest-direct"
            ? "restDirect"
            : surface === "cli-composed"
              ? "cliComposed"
              : surface === "production-adapter"
                ? "productionAdapter"
                : "stream"
        ],
        expectedKeys,
      ),
    ),
    ...validateStreamMode(operations, input.stream),
  ];
  const corpusFailure = diagnostics.find(({ code }) => code === "incomplete-corpus");
  const rows = operations.map((operation) => ({
    operationKey: operation.key,
    route: operation.route,
    cliName: operation.cliName,
    streamMode: operation.streaming,
    sharedContract: {
      status: diagnostics.some(
        ({ surface, operationKey, code }) =>
          (surface === "corpus" && (operationKey === "*" || operationKey === operation.key)) ||
          (code === "incomplete-corpus" && operationKey === operation.key),
      )
        ? "fail"
        : "pass",
      origin: "real",
      evidence: `contracts:${operation.key}`,
      reason:
        corpusFailure === undefined
          ? "Shared request, response, error, and stream applicability corpus validates."
          : `Shared contract corpus failed validation: ${corpusFailure.message}`,
    } satisfies ParityCell,
    restDirectSurface: cellFor("rest-direct", operation.key, input.restDirect),
    cliComposedSurface: cellFor("cli-composed", operation.key, input.cliComposed),
    productionAdapter: cellFor("production-adapter", operation.key, input.productionAdapter),
    streamBehavior: cellFor("stream", operation.key, input.stream),
  })) satisfies readonly ParityRow[];
  return Object.freeze({
    // A structurally covered row with blocked surfaces is still incomplete parity.
    complete: diagnostics.length === 0 && rows.every(rowIsComplete),
    rows: Object.freeze(rows),
    diagnostics: Object.freeze(diagnostics),
  });
}
