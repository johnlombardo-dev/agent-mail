import { describe, expect, test } from "bun:test";
import {
  parseByteStreamMetadata,
  parseStreamMetadata,
  operationCorpus,
  assertCorpusComplete,
} from "../../contracts/test/operation-corpus";
import { parseErrorDefinition } from "../../contracts/src/index";
import { publicCliOperations } from "../../cli/src/command-registry";
import {
  buildParityMatrix,
  type ParityEvidence,
  type ParitySurface,
} from "../../../tests/parity-matrix/harness";
import {
  createHttpApp,
  publicOperationDefinitions,
  publicOperationRegistry,
  type HttpCredentialResolution,
} from "../src/http";
import {
  operationParityRows,
  parityMatrixInvocations,
  parityNegativeFixtures,
  parityPlanningHashes,
  matrixOutcomeKinds,
  isKnownStreamMode,
  securityParityRows,
  type MatrixSurface,
} from "./operation-parity-issue-165";

const surfaces: readonly MatrixSurface[] = [
  "shared-contract",
  "rest-direct",
  "cli-composed",
  "stream",
  "production-adapter",
];

function rowFor(operationKey: string) {
  const row = operationParityRows.find(({ operation }) => operation === operationKey);
  if (row === undefined) throw new Error(`missing retained parity row: ${operationKey}`);
  return row;
}

function evidenceFor(surface: Exclude<ParitySurface, "shared-contract">): ParityEvidence[] {
  return operationParityRows.map((row) => {
    const cell = row.cells[surface === "rest-direct" ? "rest-direct" : surface];
    const streaming = surface === "stream" ? { streaming: row.streaming } : {};
    return {
      operationKey: row.operation,
      status: cell.status,
      origin: cell.origin,
      evidence:
        cell.invocation === null
          ? `not-applicable:${surface}:${row.operation}`
          : `${cell.invocation}:${row.operation}`,
      reason: cell.reason,
      ...streaming,
    };
  });
}

function routeRequest(operationKey: string): Request {
  const operation = publicOperationRegistry.get(operationKey);
  if (operation === undefined) throw new Error(`missing operation ${operationKey}`);
  const entry = operationCorpus[operation.key];
  if (entry === undefined) throw new Error(`missing corpus entry ${operation.key}`);
  const parsedInput = operation.request.parse(entry.request);
  if (typeof parsedInput !== "object" || parsedInput === null || Array.isArray(parsedInput))
    throw new Error(`operation ${operationKey} request is not an object`);
  const input: Readonly<Record<string, unknown>> = parsedInput;
  const parameterNames = new Set(
    [...operation.route.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
  const path = operation.route.replaceAll(
    /\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu,
    (_, name: string) => encodeURIComponent(String(input[name])),
  );
  const url = new URL(`http://127.0.0.1${path}`);
  if (operation.method === "GET") {
    for (const [key, value] of Object.entries(input)) {
      if (!parameterNames.has(key)) url.searchParams.set(key, String(value));
    }
  }
  const hasBody = operation.method !== "GET";
  return new Request(url, {
    method: operation.method,
    headers: {
      authorization: "Bearer parity",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(input) } : {}),
  });
}

function genericHandlers(): Readonly<Record<string, (input: unknown) => unknown>> {
  return Object.fromEntries(
    publicOperationDefinitions.map((operation) => {
      const entry = operationCorpus[operation.key];
      if (entry === undefined) throw new Error(`missing corpus entry ${operation.key}`);
      return [operation.key, () => entry.success];
    }),
  );
}

describe("#165 complete public operation parity matrix", () => {
  test("enumerates every current registry operation and every applicability cell", () => {
    expect(parityPlanningHashes).toEqual({
      plan: "6daf232f6d2895b3e76bdde9a8fb51da31b4506d8c2b2cab7544147ddf6257ce",
      evidence: "92ad4982f2d2edc94acae40f7b7fd5b149a674ecf6600823ff895f1a29c9b87e",
    });
    expect(operationParityRows.map(({ operation }) => operation)).toEqual(
      publicOperationDefinitions.map(({ key }) => key),
    );
    expect(new Set(operationParityRows.map(({ operation }) => operation)).size).toBe(
      publicOperationDefinitions.length,
    );
    for (const operation of publicOperationDefinitions) {
      const row = rowFor(operation.key);
      expect(row.route).toBe(operation.route);
      expect(row.method).toBe(operation.method);
      expect(row.cliName).toBe(operation.cliName);
      expect(row.scope).toBe(operation.scope);
      expect(row.streaming).toBe(operation.streaming);
      for (const surface of surfaces) {
        expect(row.applicability[surface]).toMatch(/^(required|not-applicable)$/u);
        const cell = row.cells[surface];
        expect(cell.reason.trim()).not.toBe("");
        if (row.applicability[surface] === "required") {
          expect(cell.status).not.toBe("not-applicable");
          expect(cell.invocation).not.toBeNull();
          if (cell.invocation !== null) {
            expect(parityMatrixInvocations[cell.invocation]).toEqual({
              command: expect.any(String),
              artifact: expect.any(String),
            });
          }
        } else {
          expect(cell.status).toBe("not-applicable");
          expect(cell.invocation).toBeNull();
        }
      }
    }
    expect(operationParityRows).toHaveLength(25);
    expect(publicCliOperations).toHaveLength(24);
    expect(rowFor("routing.commit").cells["shared-contract"]).toMatchObject({
      status: "pass",
      origin: "real",
    });
  });

  test("validates every shared request, response, error, and stream fixture", () => {
    assertCorpusComplete(publicOperationDefinitions, operationCorpus);
    for (const operation of publicOperationDefinitions) {
      const entry = operationCorpus[operation.key];
      if (entry === undefined) throw new Error(`missing corpus entry ${operation.key}`);
      operation.request.parse(entry.request);
      operation.response.parse(entry.success);
      for (const error of entry.errors) {
        const definition = operation.errors.find(({ code }) => code === error.code);
        if (definition === undefined) throw new Error(`missing declared error ${error.code}`);
        parseErrorDefinition(definition, error.response);
      }
      if (entry.stream !== undefined) {
        if (operation.key === "exports.selected") parseByteStreamMetadata(entry.stream);
        else parseStreamMetadata(entry.stream);
      }
    }
  });

  test("direct REST transport probe covers every registered route before production composition", async () => {
    const authenticate = (): HttpCredentialResolution => ({
      kind: "authenticated",
      principal: {
        subject: "principal:parity-issue-165",
        scopes: [
          ...new Set(
            publicOperationDefinitions.flatMap(({ scope }) => (scope === null ? [] : [scope])),
          ),
        ],
      },
    });
    const app = createHttpApp({
      registry: publicOperationRegistry,
      authenticate,
      handlers: genericHandlers(),
    });
    for (const operation of publicOperationDefinitions) {
      const response = await app.request(routeRequest(operation.key));
      // Operator-session issuance needs the native loopback authority; keep
      // that missing authority red instead of claiming a fixture pass.
      expect({ operation: operation.key, status: response.status }).toEqual({
        operation: operation.key,
        status: operation.key === "operator-sessions.create" ? 403 : 200,
      });
    }
    expect(rowFor("messages.search").cells["rest-direct"].status).toBe("pass");
    expect(rowFor("action-plans.create").cells["rest-direct"].status).toBe("blocked");
    expect(rowFor("operator-sessions.create").cells["rest-direct"]).toMatchObject({
      status: "pass",
      origin: "real",
    });
  });

  test("composed CLI applicability is explicit and does not promote client-only probes", () => {
    const cliKeys = new Set(publicCliOperations.map(({ key }) => key));
    for (const row of operationParityRows) {
      if (row.applicability["cli-composed"] === "required") {
        expect(cliKeys.has(row.operation)).toBe(true);
        expect(row.cells["cli-composed"].status).not.toBe("not-applicable");
      } else {
        expect(cliKeys.has(row.operation)).toBe(false);
        expect(row.cells["cli-composed"].status).toBe("not-applicable");
      }
    }
    expect(rowFor("reports.create").cells["cli-composed"]).toMatchObject({
      status: "pass",
      origin: "real",
    });
    expect(rowFor("action-plans.create").cells["cli-composed"].status).toBe("blocked");
  });

  test("production adapter cells use concrete feature evidence and retain missing seams red", () => {
    for (const row of operationParityRows) {
      expect(row.applicability["production-adapter"]).toBe("required");
      expect(row.cells["production-adapter"].status).not.toBe("not-applicable");
    }
    expect(rowFor("reports.create").cells["production-adapter"]).toMatchObject({
      status: "pass",
      origin: "real",
    });
    expect(rowFor("action-plans.create").cells["production-adapter"]).toMatchObject({
      status: "blocked",
      origin: "absent",
    });
  });

  test("builds a structurally complete matrix while retaining blocked cells", () => {
    const matrix = buildParityMatrix({
      operations: publicOperationDefinitions,
      corpus: operationCorpus,
      restDirect: evidenceFor("rest-direct"),
      cliComposed: evidenceFor("cli-composed"),
      productionAdapter: evidenceFor("production-adapter"),
      stream: evidenceFor("stream"),
    });
    expect(matrix.rows).toHaveLength(25);
    expect(matrix.diagnostics).toEqual([]);
    expect(matrix.complete).toBe(false);
    expect(matrix.rows.every(({ sharedContract }) => sharedContract.status === "pass")).toBe(true);
    expect(matrix.rows.some(({ restDirectSurface }) => restDirectSurface.status === "blocked")).toBe(true);
    expect(matrix.rows.some(({ productionAdapter }) => productionAdapter.status === "blocked")).toBe(true);
  });

  test("records every accepted #213/#214 outcome dimension with no unclassified operation", () => {
    expect(matrixOutcomeKinds).toEqual([
      "success",
      "registered-error",
      "client-error",
      "attention",
      "partial",
      "uncertain",
      "raw",
    ]);
    for (const row of operationParityRows) {
      expect(Object.keys(row.outcomes).sort()).toEqual([...matrixOutcomeKinds].sort());
      for (const outcome of matrixOutcomeKinds) {
        const cell = row.outcomes[outcome];
        expect(cell.outcome).toBe(outcome);
        expect(cell.status).toMatch(/^(pass|blocked|not-applicable)$/u);
        expect(cell.reason.trim()).not.toBe("");
        if (cell.status !== "not-applicable") expect(cell.invocation).not.toBeNull();
      }
    }
    expect(rowFor("action-plans.commit").outcomes).toMatchObject({
      attention: { status: "pass" },
      partial: { status: "pass" },
      uncertain: { status: "pass" },
    });
    expect(rowFor("messages.raw").outcomes.raw).toMatchObject({ status: "pass" });
    expect(rowFor("operator-sessions.create").outcomes["client-error"].status).toBe(
      "not-applicable",
    );
  });

  test("closes stream evidence by declared mode and rejects future modes", () => {
    expect(isKnownStreamMode("future-unseen-mode")).toBe(false);
    for (const row of operationParityRows) {
      const stream = row.cells.stream;
      if (row.streaming === "none") {
        expect(row.applicability.stream).toBe("not-applicable");
        expect(stream.status).toBe("not-applicable");
        continue;
      }
      expect(row.applicability.stream).toBe("required");
      expect(stream.invocation).not.toBeNull();
      if (row.streaming === "bytes") expect(stream.status).toBe("pass");
    }
  });

  test("negative removal and mistype fixtures become incomplete", () => {
    expect(parityNegativeFixtures).toEqual([
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
    ]);
    const baseline = {
      operations: publicOperationDefinitions,
      corpus: operationCorpus,
      restDirect: evidenceFor("rest-direct"),
      cliComposed: evidenceFor("cli-composed"),
      productionAdapter: evidenceFor("production-adapter"),
      stream: evidenceFor("stream"),
    };
    const removed = buildParityMatrix({
      ...baseline,
      cliComposed: baseline.cliComposed.filter(({ operationKey }) => operationKey !== "messages.search"),
    });
    expect(removed.complete).toBe(false);
    expect(removed.diagnostics).toContainEqual({
      code: "missing-cell",
      surface: "cli-composed",
      operationKey: "messages.search",
      message: "missing cli-composed cell for operation messages.search",
    });
    const mistyped = buildParityMatrix({
      ...baseline,
      productionAdapter: baseline.productionAdapter.map((evidence) =>
        evidence.operationKey === "messages.search"
          ? { ...evidence, operationKey: "messages.searchx" }
          : evidence,
      ),
    });
    expect(mistyped.complete).toBe(false);
    expect(mistyped.diagnostics).toContainEqual({
      code: "unknown-cell",
      surface: "production-adapter",
      operationKey: "messages.searchx",
      message: "unknown production-adapter cell for operation messages.searchx",
    });
    expect(mistyped.diagnostics).toContainEqual({
      code: "missing-cell",
      surface: "production-adapter",
      operationKey: "messages.search",
      message: "missing production-adapter cell for operation messages.search",
    });
  });

  test("retains all security intervention rows and faithful commands", () => {
    expect(securityParityRows).toHaveLength(6);
    expect(securityParityRows.map(({ id }) => id)).toEqual([
      "same-token-self-approval",
      "caller-spoofed-principal",
      "oversized-request-admission",
      "wrong-scope-body-not-read",
      "hostile-terminal-values",
      "raw-byte-preservation",
    ]);
    for (const row of securityParityRows) {
      expect(row.status).toBe("pass");
      expect(row.command).toMatch(/^bun test /u);
      expect(row.artifact).toMatch(/\.test\.ts$/u);
    }
  });
});
