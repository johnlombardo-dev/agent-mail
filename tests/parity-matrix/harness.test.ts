import { describe, expect, test } from "bun:test";
import { publicOperationDefinitions } from "../../packages/daemon/src/http";
import { operationCorpus } from "../../packages/contracts/test/operation-corpus";
import {
  absentSurfaceEvidence,
  buildParityMatrix,
  corpusStreamEvidence,
  type ParityEvidence,
} from "./harness";

const baseline = () => ({
  operations: publicOperationDefinitions,
  corpus: operationCorpus,
  restDirect: absentSurfaceEvidence(publicOperationDefinitions, "rest-direct"),
  cliComposed: absentSurfaceEvidence(publicOperationDefinitions, "cli-composed"),
  productionAdapter: absentSurfaceEvidence(publicOperationDefinitions, "production-adapter"),
  stream: corpusStreamEvidence(publicOperationDefinitions, operationCorpus),
});

describe("REST/CLI operation parity matrix", () => {
  test("has one row per shared operation and reports honest baseline gaps", () => {
    const matrix = buildParityMatrix(baseline());

    expect(matrix.rows.map(({ operationKey }) => operationKey)).toEqual(
      publicOperationDefinitions.map(({ key }) => key),
    );
    expect(matrix.rows).toHaveLength(25);
    expect(matrix.complete).toBe(false);
    expect(matrix.diagnostics).toEqual([]);
    expect(matrix.rows.every(({ sharedContract }) => sharedContract.status === "pass")).toBe(true);
    expect(matrix.rows.every(({ restDirectSurface }) => restDirectSurface.status === "blocked")).toBe(true);
    expect(matrix.rows.every(({ cliComposedSurface }) => cliComposedSurface.status === "blocked")).toBe(true);
    expect(matrix.rows.every(({ productionAdapter }) => productionAdapter.status === "blocked")).toBe(true);
    expect(matrix.rows.filter(({ streamMode }) => streamMode === "none")).toHaveLength(22);
    expect(matrix.rows.filter(({ streamMode }) => streamMode === "bytes")).toHaveLength(3);
    expect(matrix.rows.filter(({ streamMode }) => streamMode === "ndjson")).toHaveLength(0);
    expect(matrix.rows.find(({ operationKey }) => operationKey === "exports.selected")?.streamBehavior.status).toBe("blocked");
    expect(matrix.rows.find(({ operationKey }) => operationKey === "messages.raw")?.streamBehavior.status).toBe("blocked");
    expect(matrix.rows.find(({ operationKey }) => operationKey === "messages.search")?.streamBehavior.status).toBe("not-applicable");
  });

  test("rejects mock-only or absent evidence that claims a pass", () => {
    const mockPass: ParityEvidence = {
      operationKey: "messages.search",
      status: "pass",
      origin: "mock",
      evidence: "mock:messages.search",
      reason: "An in-memory mock returned the expected shape.",
    };
    const matrix = buildParityMatrix({ ...baseline(), restDirect: [mockPass, ...baseline().restDirect.slice(1)] });

    expect(matrix.complete).toBe(false);
    expect(matrix.rows[0]?.restDirectSurface).toEqual({
      status: "fail",
      origin: "mock",
      evidence: "mock:messages.search",
      reason: "An in-memory mock returned the expected shape. Mock-only or absent evidence cannot establish a pass.",
    });
    expect(matrix.diagnostics).toContainEqual({
      code: "invalid-cell",
      surface: "rest-direct",
      operationKey: "messages.search",
      message: "rest-direct cell for operation messages.search cannot pass with mock evidence",
    });

    const absentPass: ParityEvidence = { ...mockPass, origin: "absent" };
    const absentMatrix = buildParityMatrix({
      ...baseline(),
      restDirect: [absentPass, ...baseline().restDirect.slice(1)],
    });
    expect(absentMatrix.rows[0]?.restDirectSurface.status).toBe("fail");
    expect(absentMatrix.diagnostics).toContainEqual({
      code: "invalid-cell",
      surface: "rest-direct",
      operationKey: "messages.search",
      message: "rest-direct cell for operation messages.search cannot pass with absent evidence",
    });
  });

  test("accepts a future real surface cell without changing matrix semantics", () => {
    const realRestEvidence: ParityEvidence = {
      operationKey: "messages.search",
      status: "pass",
      origin: "real",
      evidence: "tests/rest/messages-search-composed.jsonl",
      reason: "Direct route and composed response matched the shared corpus.",
    };
    const matrix = buildParityMatrix({
      ...baseline(),
      restDirect: [realRestEvidence, ...baseline().restDirect.slice(1)],
    });

    expect(matrix.complete).toBe(false);
    expect(matrix.diagnostics).toEqual([]);
    expect(matrix.rows[0]?.restDirectSurface).toEqual({
      status: "pass",
      origin: "real",
      evidence: "tests/rest/messages-search-composed.jsonl",
      reason: "Direct route and composed response matched the shared corpus.",
    });
  });

  test("emits deterministic diagnostics for missing, duplicate, and unknown cells", () => {
    const complete = baseline();
    const missing = complete.cliComposed.slice(0, -1);
    const duplicate = [
      ...complete.restDirect,
      complete.restDirect[0],
      {
        operationKey: "unknown.operation",
        status: "blocked" as const,
        origin: "absent" as const,
        evidence: "missing:rest-direct:unknown.operation",
        reason: "Unknown operation fixture.",
      },
    ];
    const matrix = buildParityMatrix({ ...complete, cliComposed: missing, restDirect: duplicate });

    expect(matrix.complete).toBe(false);
    expect(matrix.diagnostics).toContainEqual({
      code: "duplicate-cell",
      surface: "rest-direct",
      operationKey: "messages.search",
      message: "duplicate rest-direct cell for operation messages.search",
    });
    expect(matrix.diagnostics).toContainEqual({
      code: "unknown-cell",
      surface: "rest-direct",
      operationKey: "unknown.operation",
      message: "unknown rest-direct cell for operation unknown.operation",
    });
    expect(matrix.diagnostics).toContainEqual({
      code: "missing-cell",
      surface: "cli-composed",
      operationKey: "sync.stop",
      message: "missing cli-composed cell for operation sync.stop",
    });
    expect(matrix.diagnostics.map(({ message }) => message)).toEqual([
      "duplicate rest-direct cell for operation messages.search",
      "unknown rest-direct cell for operation unknown.operation",
      "missing cli-composed cell for operation sync.stop",
    ]);
  });

  test("fails completeness when a public operation is omitted from the shared corpus", () => {
    const { ["messages.search"]: _omitted, ...omittedCorpus } = operationCorpus;
    const matrix = buildParityMatrix({ ...baseline(), corpus: omittedCorpus });

    expect(matrix.complete).toBe(false);
    expect(matrix.diagnostics).toEqual([
      {
        code: "incomplete-corpus",
        surface: "corpus",
        operationKey: "*",
        message: "operation corpus missing operation: messages.search",
      },
    ]);
    expect(matrix.rows.find(({ operationKey }) => operationKey === "messages.search")?.sharedContract.status).toBe("fail");
  });

  test("fails completeness when the CLI surface omits a shared operation", () => {
    const matrix = buildParityMatrix({
      ...baseline(),
      cliComposed: baseline().cliComposed.filter(({ operationKey }) => operationKey !== "messages.search"),
    });

    expect(matrix.complete).toBe(false);
    expect(matrix.diagnostics).toContainEqual({
      code: "missing-cell",
      surface: "cli-composed",
      operationKey: "messages.search",
      message: "missing cli-composed cell for operation messages.search",
    });
  });

  test("rejects stream evidence whose declared mode differs from the contract", () => {
    const streamEvidence = corpusStreamEvidence(publicOperationDefinitions, operationCorpus).map((cell) =>
      cell.operationKey === "messages.raw" ? { ...cell, streaming: "ndjson" as const } : cell,
    );
    const matrix = buildParityMatrix({ ...baseline(), stream: streamEvidence });

    expect(matrix.complete).toBe(false);
    expect(matrix.diagnostics).toContainEqual({
      code: "invalid-cell",
      surface: "stream",
      operationKey: "messages.raw",
      message: "stream cell for operation messages.raw declares ndjson; expected bytes",
    });
  });

  test("rejects routing error removal and status/detail drift", () => {
    const routing = operationCorpus["routing.commit"];
    if (routing === undefined) throw new Error("routing.commit corpus fixture is missing");
    const removed = buildParityMatrix({
      ...baseline(),
      corpus: {
        ...operationCorpus,
        "routing.commit": { ...routing, errors: routing.errors.slice(0, 2) },
      },
    });
    expect(removed.complete).toBe(false);
    expect(removed.diagnostics[0]).toMatchObject({
      code: "incomplete-corpus",
      operationKey: "*",
    });

    const drifted = buildParityMatrix({
      ...baseline(),
      corpus: {
        ...operationCorpus,
        "routing.commit": {
          ...routing,
          errors: routing.errors.map((error) =>
            error.code === "routing.preview_tampered"
              ? {
                  ...error,
                  status: 400,
                  response: {
                    code: "routing.preview_tampered",
                    message: "routing preview authority does not match",
                    correlationId: "correlation:routing-preview-tampered-例",
                    details: { previewId: "preview:authority", digest: "a".repeat(64) },
                  },
                }
              : error,
          ),
        },
      },
    });
    expect(drifted.complete).toBe(false);
    expect(drifted.diagnostics[0]).toMatchObject({
      code: "incomplete-corpus",
      operationKey: "*",
    });
  });
});
