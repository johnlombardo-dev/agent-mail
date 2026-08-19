import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ORACLE_SHA256 = "c31919b28e986603b87d5bda14b4f973a850602536f1ea8d0943c5d9af559e2e";
const EXPECTED_CLI_ORACLE_SHA256 =
  "d0f569cbb3364bebbf3e02ef33b69997a05b4bf6d5dd9485cf386e8ab7768c6d";
const ACCEPTED_HEAD = "fc321ceba7cacf09f892e46363880625c2db9b8b";
const EXPECTED_VIEW_SHA256 = [
  "9f99b49e7229697ab18bb9907b8a85f3b1fdc6843779e277222d74119d8f2b3f",
  "78990c79470e55b1ca48a3ab504d239eeed539004c2c09018000e6d8b453e839",
  "8a0e06534d16d718274bf96c69c4b9c2caa22cba85fa89bde0b170678a17835e",
];

const architectureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(architectureDirectory, "../..");
const oraclePath = join(architectureDirectory, "routing-commit-authority-oracle.v1.json");
const viewPaths = [
  join(architectureDirectory, "routing-commit-authority-design.v1.md"),
  join(architectureDirectory, "routing-commit-authority-decisions.v1.md"),
  join(architectureDirectory, "routing-commit-authority-coverage.v1.md"),
];

const expectedDispositions = [
  {
    disposition: "committed",
    requestDryRun: false,
    httpStatus: 200,
    representation: "value",
    schema: "committedDecisionSchema",
    code: null,
    detailsSchemaId: null,
    client: "CliSuccess",
    semanticKind: "success",
    exitCode: 0,
    primaryOutput: "stdout",
  },
  {
    disposition: "intentional-dry-run",
    requestDryRun: true,
    httpStatus: 200,
    representation: "value",
    schema: "uncommittedResponseSchema",
    code: null,
    detailsSchemaId: null,
    client: "CliSuccess",
    semanticKind: "success",
    exitCode: 0,
    primaryOutput: "stdout",
  },
  {
    disposition: "replayed",
    requestDryRun: false,
    httpStatus: 409,
    representation: "registered-error",
    schema: "publicErrorEnvelopeSchema",
    code: "routing.preview_replayed",
    detailsSchemaId: "DETAIL-ROUTING-PREVIEW-IDENTITY",
    client: "CliClientError kind=http_error",
    semanticKind: "replay",
    exitCode: 82,
    primaryOutput: "stderr",
  },
  {
    disposition: "expired",
    requestDryRun: false,
    httpStatus: 409,
    representation: "registered-error",
    schema: "publicErrorEnvelopeSchema",
    code: "routing.preview_expired",
    detailsSchemaId: "DETAIL-ROUTING-PREVIEW-IDENTITY",
    client: "CliClientError kind=http_error",
    semanticKind: "expired",
    exitCode: 81,
    primaryOutput: "stderr",
  },
  {
    disposition: "tampered",
    requestDryRun: false,
    httpStatus: 409,
    representation: "registered-error",
    schema: "publicErrorEnvelopeSchema",
    code: "routing.preview_tampered",
    detailsSchemaId: "DETAIL-ROUTING-PREVIEW-IDENTITY",
    client: "CliClientError kind=http_error",
    semanticKind: "tampered",
    exitCode: 83,
    primaryOutput: "stderr",
  },
  {
    disposition: "not-found",
    requestDryRun: "either",
    httpStatus: 404,
    representation: "registered-error",
    schema: "publicErrorEnvelopeSchema",
    code: "not_found",
    detailsSchemaId: "DETAIL-EMPTY",
    client: "CliClientError kind=http_error",
    semanticKind: "not_found",
    exitCode: 66,
    primaryOutput: "stderr",
  },
  {
    disposition: "internal-failure",
    requestDryRun: "either",
    httpStatus: 500,
    representation: "registered-error",
    schema: "publicErrorEnvelopeSchema",
    code: "internal_error",
    detailsSchemaId: "DETAIL-EMPTY",
    client: "CliClientError kind=http_error",
    semanticKind: "internal",
    exitCode: 70,
    primaryOutput: "stderr",
  },
];

const expectedErrors = [
  {
    disposition: "replayed",
    owner: "operation:routing.commit",
    code: "routing.preview_replayed",
    status: 409,
    fixedMessage: "routing preview was already consumed",
    projectionMessage: undefined,
    detailsSchemaId: "DETAIL-ROUTING-PREVIEW-IDENTITY",
    applicableOperations: ["routing.commit"],
    semanticKind: "replay",
    exitCode: 82,
    messageSelectsSemantic: false,
  },
  {
    disposition: "expired",
    owner: "operation:routing.commit",
    code: "routing.preview_expired",
    status: 409,
    fixedMessage: "routing preview has expired",
    projectionMessage: undefined,
    detailsSchemaId: "DETAIL-ROUTING-PREVIEW-IDENTITY",
    applicableOperations: ["routing.commit"],
    semanticKind: "expired",
    exitCode: 81,
    messageSelectsSemantic: false,
  },
  {
    disposition: "tampered",
    owner: "operation:routing.commit",
    code: "routing.preview_tampered",
    status: 409,
    fixedMessage: "routing preview authority does not match",
    projectionMessage: undefined,
    detailsSchemaId: "DETAIL-ROUTING-PREVIEW-IDENTITY",
    applicableOperations: ["routing.commit"],
    semanticKind: "tampered",
    exitCode: 83,
    messageSelectsSemantic: false,
  },
  {
    disposition: "not-found",
    owner: "shared:httpErrorRegistry",
    code: "not_found",
    status: 404,
    fixedMessage: null,
    projectionMessage: "routing commit resource was not found",
    detailsSchemaId: "DETAIL-EMPTY",
    applicableOperations: ["shared"],
    semanticKind: "not_found",
    exitCode: 66,
    messageSelectsSemantic: false,
  },
  {
    disposition: "internal-failure",
    owner: "shared:httpErrorRegistry",
    code: "internal_error",
    status: 500,
    fixedMessage: null,
    projectionMessage: "internal server error",
    detailsSchemaId: "DETAIL-EMPTY",
    applicableOperations: ["shared"],
    semanticKind: "internal",
    exitCode: 70,
    messageSelectsSemantic: false,
  },
];

const expectedSources = [
  ["service.preview-lookup", "not-found", "either", "not-found", false],
  ["service.preview-lookup", "found-and-dry-run", true, "intentional-dry-run", false],
  ["storage.consume", "result:consumed", false, "committed", true],
  ["storage.consume", "result:replayed", false, "replayed", true],
  ["storage.consume", "result:expired", false, "expired", true],
  ["storage.consume", "error:tampered", false, "tampered", true],
  ["storage.consume", "error:not-found", false, "not-found", true],
  ["storage.consume", "error:target", false, "not-found", true],
  ["storage.consume", "error:invalid-input", false, "internal-failure", true],
  ["storage.consume", "error:schema", false, "internal-failure", true],
  ["storage.consume", "throw:unknown-or-aggregate", false, "internal-failure", true],
  ["service.invoke", "unregistered-failure-or-blocked", "either", "internal-failure", "unknown"],
];

const expectedServiceTerminals = [
  ["committed", "success", ["kind", "value"], "committedDecisionSchema", null],
  ["intentional-dry-run", "success", ["kind", "value"], "uncommittedResponseSchema", null],
  [
    "replayed",
    "routing-commit-terminal",
    ["kind", "disposition", "previewId"],
    null,
    "routing.preview_replayed",
  ],
  [
    "expired",
    "routing-commit-terminal",
    ["kind", "disposition", "previewId"],
    null,
    "routing.preview_expired",
  ],
  [
    "tampered",
    "routing-commit-terminal",
    ["kind", "disposition", "previewId"],
    null,
    "routing.preview_tampered",
  ],
  ["not-found", "routing-commit-terminal", ["kind", "disposition"], null, "not_found"],
  ["internal-failure", "private-failure", ["kind"], null, "internal_error"],
];

const expectedMutationIds = [
  "MUT-MISSING-DISPOSITION",
  "MUT-DUPLICATE-DISPOSITION",
  "MUT-OVERLAPPING-SOURCE",
  "MUT-CROSS-PAIRED-CODE",
  "MUT-WRONG-OPERATION",
  "MUT-MESSAGE-PARSED",
  "MUT-UNSAFE-DETAIL",
  "MUT-DRY-RUN-CONFUSION",
  "MUT-WRONG-STATUS",
  "MUT-PERMISSIVE-DETAILS",
  "MUT-MISSING-LAYER",
  "MUT-GLOBAL-WIDENING",
  "MUT-SUCCESS-NONZERO",
  "MUT-MISSING-COMPOSITION",
  "MUT-BASE-CLI-DRIFT",
];

function fail(message) {
  throw new Error("Routing commit authority check failed: " + message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stable(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function exactValue(actual, expected, label) {
  if (stable(actual) !== stable(expected)) fail(label + " differs: " + stable(actual));
}

function exactSet(actual, expected, label) {
  if (!Array.isArray(actual)) fail(label + " is not an array");
  const left = actual.map(stable).sort();
  const right = expected.map(stable).sort();
  if (stable(left) !== stable(right)) fail(label + " differs: " + stable(actual));
}

function unique(items, key, label) {
  if (!Array.isArray(items)) fail(label + " is not an array");
  const values = items.map(key);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    fail(label + " has an invalid key");
  }
  if (new Set(values).size !== values.length) fail(label + " has a duplicate key");
  return new Set(values);
}

function requireReferences(values, authority, label) {
  if (!Array.isArray(values) || values.length === 0) fail(label + " is empty");
  for (const value of values) {
    if (!authority.has(value)) fail(label + " references unknown " + value);
  }
}

function readCommitted(path, commit) {
  try {
    return execFileSync("git", ["show", commit + ":" + path], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    fail("cannot read committed authority " + commit + ":" + path);
  }
}

function projectedDisposition(row) {
  return {
    disposition: row.disposition,
    requestDryRun: row.requestDryRun,
    httpStatus: row.http?.status,
    representation: row.http?.representation,
    schema: row.http?.schema,
    code: row.http?.code,
    detailsSchemaId: row.http?.detailsSchemaId,
    client: row.client,
    semanticKind: row.cli?.semanticKind,
    exitCode: row.cli?.exitCode,
    primaryOutput: row.cli?.primaryOutput,
  };
}

function projectedError(error) {
  return {
    disposition: error.disposition,
    owner: error.owner,
    code: error.code,
    status: error.status,
    fixedMessage: error.fixedMessage,
    projectionMessage: error.projectionMessage,
    detailsSchemaId: error.detailsSchemaId,
    applicableOperations: error.applicableOperations,
    semanticKind: error.semanticKind,
    exitCode: error.exitCode,
    messageSelectsSemantic: error.messageSelectsSemantic,
  };
}

function validateCore(oracle, cliOracle) {
  exactValue(oracle.format, "agent-mail.routing-commit-authority-oracle/v1", "format");
  exactValue(oracle.schemaVersion, 1, "schemaVersion");
  exactValue(oracle.modelVersion, "1.0.0", "modelVersion");
  exactValue(oracle.status, "frozen-design", "status");
  exactValue(oracle.oracle?.issue, 220, "oracle issue");
  exactValue(oracle.oracle?.acceptedHead, ACCEPTED_HEAD, "accepted head");
  exactValue(oracle.oracle?.normative, true, "normative flag");
  if (!String(oracle.oracle?.invariant).includes("exactly one strict public representation")) {
    fail("invariant does not require one strict public representation");
  }
  exactValue(
    oracle.productDecision?.selected,
    "operation-scoped-registered-errors",
    "selected public design",
  );
  exactValue(
    oracle.productDecision?.rejected,
    "strict-success-value-discriminants",
    "rejected public design",
  );
  exactSet(
    oracle.productDecision?.publicValueVariants,
    ["committed", "intentional-dry-run"],
    "public value variants",
  );
  exactSet(
    oracle.productDecision?.publicErrorVariants,
    ["replayed", "expired", "tampered", "not-found", "internal-failure"],
    "public error variants",
  );

  const dispositionIds = unique(oracle.dispositionMatrix, (row) => row.id, "disposition ids");
  const dispositionNames = unique(
    oracle.dispositionMatrix,
    (row) => row.disposition,
    "disposition names",
  );
  exactSet(
    oracle.dispositionMatrix.map(projectedDisposition),
    expectedDispositions,
    "terminal disposition matrix",
  );
  for (const row of oracle.dispositionMatrix) {
    for (const layer of ["storage", "service", "http", "client", "cli"]) {
      if (row[layer] === undefined || row[layer] === null) {
        fail(row.disposition + " omits " + layer + " layer");
      }
    }
    if (typeof row.mutationPostcondition !== "string" || row.mutationPostcondition.length === 0) {
      fail(row.disposition + " omits its mutation postcondition");
    }
  }

  unique(oracle.serviceTerminalAlgebra, (row) => row.id, "service terminal ids");
  exactSet(
    oracle.serviceTerminalAlgebra.map((row) => [
      row.disposition,
      row.kind,
      row.strictShape,
      row.valueSchema,
      row.publicErrorCode,
    ]),
    expectedServiceTerminals,
    "service terminal algebra",
  );

  unique(oracle.sourceMapping, (row) => row.id, "source mapping ids");
  unique(
    oracle.sourceMapping,
    (row) => stable([row.stage, row.signal, row.requestDryRun]),
    "source mapping domains",
  );
  exactSet(
    oracle.sourceMapping.map((row) => [
      row.stage,
      row.signal,
      row.requestDryRun,
      row.disposition,
      row.consumptionInvoked,
    ]),
    expectedSources,
    "storage/service source mapping",
  );
  for (const row of oracle.sourceMapping) {
    if (!dispositionNames.has(row.disposition)) {
      fail("source mapping references unknown disposition " + row.disposition);
    }
  }

  const detailIds = unique(oracle.detailSchemas, (schema) => schema.id, "detail schema ids");
  const previewDetails = oracle.detailSchemas.find(
    (schema) => schema.id === "DETAIL-ROUTING-PREVIEW-IDENTITY",
  );
  const emptyDetails = oracle.detailSchemas.find((schema) => schema.id === "DETAIL-EMPTY");
  exactValue(
    previewDetails?.schema,
    {
      $id: "RoutingPreviewIdentityErrorDetailsV1",
      type: "object",
      additionalProperties: false,
      required: ["previewId"],
      properties: {
        previewId: {
          type: "string",
          minLength: 9,
          maxLength: 256,
          pattern:
            "^preview:[^\\s:\\u0000-\\u001f\\u007f-\\u009f][^\\s\\u0000-\\u001f\\u007f-\\u009f]*$",
        },
      },
    },
    "preview identity detail schema",
  );
  exactValue(
    emptyDetails?.schema,
    {
      $id: "EmptyErrorDetailsV1",
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
    "empty detail schema",
  );
  exactSet(previewDetails?.allowedPublicFacts, ["request.previewId"], "allowed public facts");
  exactSet(
    previewDetails?.forbiddenPublicFacts,
    [
      "digest",
      "nonce",
      "rule",
      "ruleVersion",
      "candidateTargets",
      "stored payload",
      "private reason",
      "cause",
      "stack",
    ],
    "forbidden routing detail facts",
  );

  unique(oracle.errorDefinitions, (error) => error.id, "error ids");
  unique(oracle.errorDefinitions, (error) => error.code, "error codes");
  exactSet(
    oracle.errorDefinitions.map(projectedError),
    expectedErrors,
    "registered error definitions",
  );
  for (const error of oracle.errorDefinitions) {
    if (!detailIds.has(error.detailsSchemaId)) {
      fail(error.code + " references an unknown detail schema");
    }
    if (!dispositionNames.has(error.disposition)) {
      fail(error.code + " references an unknown disposition");
    }
  }

  const newErrors = oracle.errorDefinitions.filter((error) => error.code.startsWith("routing."));
  if (newErrors.length !== 3) fail("new routing error count differs");
  for (const error of newErrors) {
    exactValue(error.owner, "operation:routing.commit", error.code + " owner");
    exactValue(error.status, 409, error.code + " status");
    exactValue(error.applicableOperations, ["routing.commit"], error.code + " applicability");
    exactValue(error.messageSelectsSemantic, false, error.code + " message selector");
  }

  exactSet(
    oracle.operationApplicability,
    newErrors.map((error) => ({
      code: error.code,
      status: 409,
      allowedOperations: ["routing.commit"],
      deniedOperations: "all-other-public-operations",
    })),
    "operation applicability",
  );

  exactValue(
    oracle.classificationPolicy?.semanticSelector,
    "registered-code-and-strict-details",
    "semantic selector",
  );
  exactValue(oracle.classificationPolicy?.messageParser, "forbidden", "message parser policy");
  exactValue(
    oracle.classificationPolicy?.statusOnlySelector,
    "forbidden",
    "status-only selector policy",
  );
  exactValue(
    oracle.classificationPolicy?.privateReasonSelector,
    "forbidden",
    "private reason selector policy",
  );
  exactValue(
    oracle.classificationPolicy?.unknownDisposition,
    "internal_error/500 then internal/70",
    "unknown disposition policy",
  );
  if (!String(oracle.classificationPolicy?.dryRunRule).includes("request.dryRun=true")) {
    fail("dry-run rule does not require request.dryRun=true");
  }
  if (!String(oracle.classificationPolicy?.dryRunRule).includes("can never produce")) {
    fail("dry-run rule does not reject replay/expiry confusion");
  }

  exactValue(oracle.cliAuthorityPins?.oracleSha256, EXPECTED_CLI_ORACLE_SHA256, "CLI oracle pin");
  const expectedSemanticExitPairs = [
    { semanticKind: "success", exitCode: 0 },
    { semanticKind: "not_found", exitCode: 66 },
    { semanticKind: "internal", exitCode: 70 },
    { semanticKind: "expired", exitCode: 81 },
    { semanticKind: "replay", exitCode: 82 },
    { semanticKind: "tampered", exitCode: 83 },
  ];
  exactSet(
    oracle.cliAuthorityPins?.semanticExitPairs,
    expectedSemanticExitPairs,
    "CLI semantic/exit pins",
  );
  exactSet(
    oracle.cliAuthorityPins?.additiveOperationMappings,
    newErrors.map((error) => ({
      code: error.code,
      status: 409,
      selector: "constant",
      semanticKind: error.semanticKind,
      operationKey: "routing.commit",
    })),
    "additive CLI mappings",
  );
  const basePairs = new Map(
    (cliOracle.exitCodeRegistry ?? []).map((entry) => [entry.semanticKind, entry.code]),
  );
  for (const pair of expectedSemanticExitPairs) {
    exactValue(
      basePairs.get(pair.semanticKind),
      pair.exitCode,
      "base CLI exit for " + pair.semanticKind,
    );
  }
  const issue156 = (cliOracle.implementationObligations ?? []).find(
    (obligation) => obligation.id === "I156-01",
  );
  if (!String(issue156?.must).includes("Current routing operations expose no strict")) {
    fail("base CLI oracle no longer records the issue 156 routing discriminant gap");
  }

  const proofIds = unique(oracle.constructiveProofs, (proof) => proof.id, "proof ids");
  if (oracle.constructiveProofs.length !== 14) fail("constructive proof count differs");
  for (const disposition of dispositionNames) {
    exactSet(
      oracle.constructiveProofs
        .filter((proof) => proof.disposition === disposition)
        .map((proof) => proof.pathKind),
      ["direct", "real-sqlite"],
      disposition + " proof paths",
    );
  }
  for (const proof of oracle.constructiveProofs) {
    if (!dispositionNames.has(proof.disposition)) {
      fail(proof.id + " references unknown disposition");
    }
    if (!proof.trigger || !proof.requiredObservation) fail(proof.id + " is incomplete");
  }

  const mutationIds = unique(oracle.mutationTests, (mutation) => mutation.id, "mutation ids");
  exactSet([...mutationIds], expectedMutationIds, "mutation ids");
  const decisionIds = unique(oracle.decisions, (decision) => decision.id, "decision ids");
  exactSet(
    [...decisionIds],
    Array.from({ length: 10 }, (_, index) => `D${String(index + 1).padStart(2, "0")}`),
    "decision ids",
  );
  const requirementIds = unique(
    oracle.requirements,
    (requirement) => requirement.id,
    "requirement ids",
  );
  exactSet(
    [...requirementIds],
    [
      "REQ-ALGEBRA",
      "REQ-PUBLIC",
      "REQ-DRY-RUN",
      "REQ-SAFE",
      "REQ-APPLICABILITY",
      "REQ-CLI",
      "REQ-COMPOSITION",
      "REQ-HANDOFF",
    ],
    "requirement ids",
  );
  exactSet(Object.keys(oracle.coverage ?? {}), [...requirementIds], "coverage requirement keys");
  for (const [requirementId, coverage] of Object.entries(oracle.coverage ?? {})) {
    requireReferences(coverage.decisions, decisionIds, requirementId + " decisions");
    requireReferences(coverage.proofs, proofIds, requirementId + " proofs");
    requireReferences(coverage.mutations, mutationIds, requirementId + " mutations");
  }

  const shieldIds = unique(
    oracle.planningShieldApplicability,
    (shield) => shield.id,
    "planning shield ids",
  );
  exactSet(
    [...shieldIds],
    Array.from({ length: 12 }, (_, index) => `S${String(index + 1).padStart(2, "0")}`),
    "planning shield ids",
  );
  for (const shield of oracle.planningShieldApplicability) {
    if (!["required", "not-applicable"].includes(shield.status) || !shield.reason) {
      fail(shield.id + " has an invalid applicability record");
    }
  }

  exactValue(
    oracle.downstreamImplementationPacket?.id,
    "PACKET-LUNA-ROUTING-COMMIT-AUTHORITY",
    "implementation packet id",
  );
  exactValue(oracle.downstreamImplementationPacket?.worker, "luna_worker", "packet worker");
  exactValue(
    oracle.downstreamImplementationPacket?.minimumReasoningEffort,
    "high",
    "packet effort",
  );
  exactSet(
    oracle.downstreamImplementationPacket?.mutationFiles,
    [
      "packages/contracts/src/routing-operations.ts",
      "packages/contracts/test/routing-operations.test.ts",
      "packages/daemon/src/routing-handlers.ts",
      "packages/daemon/test/routing-handlers-p6-c06.test.ts",
      "packages/cli/src/command-outcome.ts",
      "packages/cli/src/command-outcome.test.ts",
      "packages/cli/test/client.test.ts",
      "docs/openapi.json",
    ],
    "packet mutation files",
  );
  const protectedPaths = new Set(oracle.downstreamImplementationPacket?.protectedFiles ?? []);
  for (const path of [
    "packages/cli/src/routing-commands.ts",
    "packages/cli/src/routing-commands.test.ts",
    "PLAN.md",
    "docs/planning/EVIDENCE.md",
    "docs/architecture/cli-command-outcome-oracle.v1.json",
    "docs/architecture/cli-command-outcome-check.v1.mjs",
    "docs/architecture/cli-command-outcome-design.v1.md",
    "docs/architecture/cli-command-outcome-decisions.v1.md",
    "docs/architecture/cli-command-outcome-coverage.v1.md",
  ]) {
    if (!protectedPaths.has(path)) fail("implementation packet does not protect " + path);
  }

  const redispatchIds = unique(
    oracle.redispatchObligations,
    (obligation) => obligation.id,
    "issue 156 redispatch ids",
  );
  exactSet(
    [...redispatchIds],
    [
      "REDISPATCH-156-DEPENDENCY",
      "REDISPATCH-156-PRESERVE",
      "REDISPATCH-156-MATRIX",
      "REDISPATCH-156-PARITY",
      "REDISPATCH-156-NO-PRIVATE-POLICY",
    ],
    "issue 156 redispatch ids",
  );
  for (const obligation of oracle.redispatchObligations) {
    exactValue(obligation.issue, 156, obligation.id + " issue");
    if (!obligation.must) fail(obligation.id + " is empty");
  }
  exactValue(oracle.remainingConsequentialChoices, [], "remaining consequential choices");

  return {
    dispositionIds,
    dispositionNames,
    proofIds,
    mutationIds,
    decisionIds,
    requirementIds,
    shieldIds,
    redispatchIds,
  };
}

function validateFrozenInputs(oracle, strictSource) {
  unique(oracle.frozenInputs, (input) => input.id, "frozen input ids");
  unique(oracle.frozenInputs, (input) => input.path, "frozen input paths");
  if (oracle.frozenInputs.length !== 24) fail("frozen input count differs");
  const sourceDrift = [];
  for (const input of oracle.frozenInputs) {
    exactValue(input.gitCommit, ACCEPTED_HEAD, input.id + " commit");
    const committed = readCommitted(input.path, input.gitCommit);
    exactValue(sha256(committed), input.sha256, input.id + " committed digest");
    const path = join(repositoryRoot, input.path);
    const current = existsSync(path) ? sha256(readFileSync(path)) : null;
    if (current !== input.sha256) {
      sourceDrift.push({ id: input.id, path: input.path, expected: input.sha256, current });
    }
  }
  if (strictSource && sourceDrift.length > 0) {
    fail("strict source gate found drift in " + sourceDrift.map((entry) => entry.id).join(", "));
  }
  return sourceDrift;
}

function validateProtectedWorktree(oracle, protectedGate) {
  unique(oracle.protectedWorktree, (input) => input.id, "protected worktree ids");
  unique(oracle.protectedWorktree, (input) => input.path, "protected worktree paths");
  if (oracle.protectedWorktree.length !== 3) fail("protected worktree count differs");
  const protectedDrift = [];
  for (const input of oracle.protectedWorktree) {
    const path = join(repositoryRoot, input.path);
    const current = existsSync(path) ? sha256(readFileSync(path)) : null;
    if (current !== input.sha256) {
      protectedDrift.push({ id: input.id, path: input.path, expected: input.sha256, current });
    }
  }
  if (protectedGate && protectedDrift.length > 0) {
    fail(
      "protected worktree gate found drift in " +
        protectedDrift.map((entry) => entry.id).join(", "),
    );
  }
  return protectedDrift;
}

function validateViews(oracle, oracleDigest) {
  const views = viewPaths.map((path) => readFileSync(path));
  exactValue(
    views.map((view) => sha256(view)),
    EXPECTED_VIEW_SHA256,
    "checked view digests",
  );
  for (const [index, view] of views.entries()) {
    const text = view.toString("utf8");
    if (!text.includes("routing-commit-authority-oracle.v1.json")) {
      fail("view " + index + " does not link the normative oracle");
    }
    if (!text.includes(oracleDigest)) fail("view " + index + " omits the oracle digest");
  }
  const design = views[0].toString("utf8");
  for (const row of expectedDispositions) {
    for (const value of [row.disposition, row.code, String(row.httpStatus), row.semanticKind]) {
      if (value !== null && !design.includes(value)) {
        fail("design view omits disposition token " + value);
      }
    }
  }
  const decisions = views[1].toString("utf8");
  for (const decision of oracle.decisions) {
    if (!decisions.includes(decision.id)) fail("decision view omits " + decision.id);
  }
  const coverage = views[2].toString("utf8");
  for (const item of [
    ...oracle.requirements,
    ...oracle.constructiveProofs,
    ...oracle.mutationTests,
    ...oracle.sourceMapping,
    ...oracle.redispatchObligations,
  ]) {
    if (!coverage.includes(item.id)) fail("coverage view omits " + item.id);
  }
  if (!coverage.includes(oracle.downstreamImplementationPacket.id)) {
    fail("coverage view omits the downstream packet");
  }
  return views.map((view) => sha256(view));
}

function runSelfTests(oracle, cliOracle) {
  const mutations = [
    ["MUT-MISSING-DISPOSITION", (copy) => copy.dispositionMatrix.pop()],
    [
      "MUT-DUPLICATE-DISPOSITION",
      (copy) =>
        copy.dispositionMatrix.push({
          ...structuredClone(copy.dispositionMatrix[0]),
          id: "DISPOSITION-DUPLICATE",
        }),
    ],
    [
      "MUT-OVERLAPPING-SOURCE",
      (copy) =>
        copy.sourceMapping.push({
          ...structuredClone(copy.sourceMapping[0]),
          id: "SOURCE-OVERLAP",
          disposition: "internal-failure",
        }),
    ],
    [
      "MUT-CROSS-PAIRED-CODE",
      (copy) => {
        copy.dispositionMatrix.find((row) => row.disposition === "replayed").http.code =
          "routing.preview_expired";
      },
    ],
    [
      "MUT-WRONG-OPERATION",
      (copy) => {
        copy.operationApplicability[0].allowedOperations = ["routing.preview"];
      },
    ],
    [
      "MUT-MESSAGE-PARSED",
      (copy) => {
        copy.classificationPolicy.messageParser = "enabled";
      },
    ],
    [
      "MUT-UNSAFE-DETAIL",
      (copy) => {
        const schema = copy.detailSchemas.find(
          (entry) => entry.id === "DETAIL-ROUTING-PREVIEW-IDENTITY",
        ).schema;
        schema.required.push("digest");
        schema.properties.digest = { type: "string" };
      },
    ],
    [
      "MUT-DRY-RUN-CONFUSION",
      (copy) => {
        copy.dispositionMatrix.find((row) => row.disposition === "replayed").requestDryRun = true;
      },
    ],
    [
      "MUT-WRONG-STATUS",
      (copy) => {
        copy.errorDefinitions.find((error) => error.code === "routing.preview_expired").status =
          400;
      },
    ],
    [
      "MUT-PERMISSIVE-DETAILS",
      (copy) => {
        copy.detailSchemas.find(
          (entry) => entry.id === "DETAIL-ROUTING-PREVIEW-IDENTITY",
        ).schema.additionalProperties = true;
      },
    ],
    [
      "MUT-MISSING-LAYER",
      (copy) => {
        delete copy.dispositionMatrix.find((row) => row.disposition === "tampered").client;
      },
    ],
    [
      "MUT-GLOBAL-WIDENING",
      (copy) => {
        copy.errorDefinitions.find((error) => error.code === "routing.preview_tampered").owner =
          "shared:httpErrorRegistry";
      },
    ],
    [
      "MUT-SUCCESS-NONZERO",
      (copy) => {
        copy.dispositionMatrix.find(
          (row) => row.disposition === "intentional-dry-run",
        ).cli.exitCode = 82;
      },
    ],
    ["MUT-MISSING-COMPOSITION", (copy) => copy.constructiveProofs.pop()],
    [
      "MUT-BASE-CLI-DRIFT",
      (copy) => {
        copy.cliAuthorityPins.oracleSha256 = "0".repeat(64);
      },
    ],
  ];
  exactSet(
    mutations.map(([id]) => id),
    expectedMutationIds,
    "self-test mutation ids",
  );
  const rejected = [];
  for (const [id, mutate] of mutations) {
    const copy = structuredClone(oracle);
    mutate(copy);
    try {
      validateCore(copy, cliOracle);
    } catch {
      rejected.push(id);
      continue;
    }
    fail("self-test mutation survived: " + id);
  }
  return rejected;
}

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!["--self-test", "--strict-source", "--protected-gate"].includes(flag)) {
    fail("unknown option " + flag);
  }
}

const oracleBytes = readFileSync(oraclePath);
const oracleDigest = sha256(oracleBytes);
exactValue(oracleDigest, EXPECTED_ORACLE_SHA256, "oracle digest");
const oracle = JSON.parse(oracleBytes.toString("utf8"));
const cliPin = oracle.frozenInputs.find((input) => input.id === "CLI-OUTCOME-ORACLE");
if (!cliPin) fail("CLI outcome oracle source pin is missing");
const cliOracleBytes = readCommitted(cliPin.path, cliPin.gitCommit);
exactValue(sha256(cliOracleBytes), cliPin.sha256, "committed CLI oracle digest");
const cliOracle = JSON.parse(cliOracleBytes.toString("utf8"));

const authorities = validateCore(oracle, cliOracle);
const sourceDrift = validateFrozenInputs(oracle, flags.has("--strict-source"));
const protectedDrift = validateProtectedWorktree(oracle, flags.has("--protected-gate"));
const viewDigests = validateViews(oracle, oracleDigest);
const selfTests = flags.has("--self-test") ? runSelfTests(oracle, cliOracle) : [];
const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

process.stdout.write(
  JSON.stringify(
    {
      status: "ok",
      oracleSha256: oracleDigest,
      acceptedHead: ACCEPTED_HEAD,
      currentHead,
      counts: {
        frozenInputs: oracle.frozenInputs.length,
        protectedWorktreeFiles: oracle.protectedWorktree.length,
        dispositions: authorities.dispositionNames.size,
        errors: oracle.errorDefinitions.length,
        newErrors: oracle.errorDefinitions.filter((error) => error.code.startsWith("routing."))
          .length,
        sourceMappings: oracle.sourceMapping.length,
        constructiveProofs: authorities.proofIds.size,
        mutations: authorities.mutationIds.size,
        requirements: authorities.requirementIds.size,
        decisions: authorities.decisionIds.size,
        shields: authorities.shieldIds.size,
        redispatchObligations: authorities.redispatchIds.size,
      },
      viewDigests,
      selfTests,
      sourceDrift,
      protectedDrift,
    },
    null,
    2,
  ) + "\n",
);
