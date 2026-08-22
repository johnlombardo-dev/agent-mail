import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  observationThresholdValues,
  validateManifest as validateExecutionManifest,
} from "../../scripts/qualification/capture-release-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");
const indexPath = join(here, "release-evidence-index.v1.json");
const executionManifestPath = join(
  repositoryRoot,
  "docs/architecture/release-evidence-execution-manifest.v2.json",
);
const findingIdPattern = /^(?:F(?:0[1-9]|[12][0-9]|30)(?:-[PR])?|SEC-R0[1-7]|CRED-0[1-8])$/u;
const shieldIdPattern = /^S(?:0[1-9]|1[0-2])$/u;
const requiredEvidenceClasses = [
  "implementation",
  "static",
  "isolated",
  "composed",
  "capacity",
  "liveRead",
  "liveMutation",
  "security",
  "deployedOperations",
  "delivery",
];
const requiredGateIds = [
  "static",
  "isolated",
  "composed",
  "capacity",
  "liveRead",
  "liveMutation",
  "security",
  "deployedOperations",
  "delivery",
];
const resultAuthorityCommentId = 5373630189;
const allowedStatuses = new Set([
  "specified",
  "implemented",
  "locally verified",
  "live verified",
  "deployed verified",
  "release-ready",
  "unverified",
  "superseded",
]);
const allowedProofClasses = new Set(["retained", "blocked", "unverified", "superseded"]);
const resultOwnerAuthority = {
  169: {
    mode: ["promotion"],
    gateIds: ["static", "isolated"],
    evidenceKinds: ["static", "isolated"],
    obligationIds: ["S07", "S08", "S10", "S11"],
  },
  170: {
    mode: ["promotion"],
    gateIds: ["composed"],
    evidenceKinds: ["composed"],
    obligationIds: ["F04", "F08", "F09-P", "F09-R", "S01", "S03", "S05", "S06", "S08"],
  },
  172: {
    mode: ["promotion"],
    gateIds: ["composed"],
    evidenceKinds: ["composed"],
    obligationIds: ["F02", "F05", "F11", "F12", "F14", "F29", "S03", "S04", "S06"],
  },
  173: {
    mode: ["promotion"],
    gateIds: ["composed"],
    evidenceKinds: ["composed"],
    obligationIds: ["F01", "F03", "F17", "F18", "F19", "F20", "F22", "S03", "S05", "S06"],
  },
  176: {
    mode: ["promotion"],
    gateIds: ["capacity"],
    evidenceKinds: ["capacity"],
    obligationIds: ["F17", "F18", "F22", "F23", "F30", "SEC-R03", "S04", "S05"],
  },
  177: {
    mode: ["promotion"],
    gateIds: ["liveRead"],
    evidenceKinds: ["liveRead"],
    obligationIds: [
      "F01",
      "F03",
      "F06",
      "F10",
      "F17",
      "F18",
      "F20",
      "F21",
      "F22",
      "CRED-01",
      "CRED-04",
      "CRED-06",
      "S01",
      "S05",
    ],
  },
  178: {
    mode: ["promotion"],
    gateIds: ["composed"],
    evidenceKinds: ["composed"],
    obligationIds: [
      "F09-P",
      "F09-R",
      "F13",
      "F16",
      "F19",
      "F23",
      "F27",
      "F28",
      "F30",
      "S01",
      "S02",
      "S04",
      "S05",
      "S06",
    ],
  },
  179: {
    mode: ["promotion"],
    gateIds: ["deployedOperations"],
    evidenceKinds: ["deployedOperations"],
    obligationIds: ["F07", "S06", "S12"],
  },
  180: {
    mode: ["promotion"],
    gateIds: ["deployedOperations"],
    evidenceKinds: ["deployedOperations"],
    obligationIds: ["F26", "SEC-R05", "S03", "S06", "S12"],
  },
  181: {
    mode: ["promotion"],
    gateIds: ["liveMutation"],
    evidenceKinds: ["liveMutation"],
    obligationIds: [
      "F04",
      "F08",
      "F09-P",
      "F09-R",
      "SEC-R01",
      "SEC-R02",
      "S01",
      "S03",
      "S05",
      "S08",
    ],
  },
  182: {
    mode: ["promotion"],
    gateIds: ["composed"],
    evidenceKinds: ["composed"],
    obligationIds: ["F07", "F24", "S03", "S06", "S07", "S12"],
  },
  183: {
    mode: ["promotion"],
    gateIds: ["security"],
    evidenceKinds: ["security"],
    obligationIds: [
      "F05",
      "F08",
      "F09-P",
      "F09-R",
      "F11",
      "F13",
      "F26",
      "F28",
      "SEC-R01",
      "SEC-R02",
      "SEC-R03",
      "SEC-R04",
      "SEC-R05",
      "SEC-R06",
      "SEC-R07",
      "CRED-01",
      "CRED-02",
      "CRED-03",
      "CRED-04",
      "CRED-05",
      "CRED-06",
      "CRED-07",
      "CRED-08",
      "S07",
      "S08",
      "S10",
      "S12",
    ],
  },
  184: { mode: ["disposition"], gateIds: [], evidenceKinds: [], obligationIds: [] },
  185: {
    mode: ["promotion"],
    gateIds: ["security"],
    evidenceKinds: ["security"],
    obligationIds: [],
    closureOnly: true,
  },
  186: {
    mode: ["promotion"],
    gateIds: ["delivery"],
    evidenceKinds: ["delivery"],
    obligationIds: ["S10", "S11", "S12"],
  },
  187: {
    mode: ["promotion"],
    gateIds: ["delivery"],
    evidenceKinds: ["delivery"],
    obligationIds: [],
    prerequisites: true,
  },
};
const gateResultAuthority = {
  static: [169],
  isolated: [169],
  composed: [170, 172, 173, 178, 182],
  capacity: [176],
  liveRead: [177],
  liveMutation: [181],
  security: [183, 185],
  deployedOperations: [179, 180],
  delivery: [186, 187],
};
const requiredCapacitySubgates = [
  "mime-250mib",
  "fts-250k",
  "selected-export-slow-sink",
  "http-stream-admission",
  "queue-backpressure",
  "cancellation",
  "lifecycle-leak",
];
const closureSourceContracts = {
  F17: {
    descriptorPaths: ["packages/daemon/test/polling-timer-actor-p3-c20.test.ts"],
    reproduction: { assertionId: "F17-polling-timer-pass", outcome: "pass" },
    counterexample: { assertionId: "F17-action-loop-load-blocked", outcome: "blocked" },
  },
  F18: {
    descriptorPaths: ["packages/daemon/test/sync-runtime-conformance-p3-c24.test.ts"],
    reproduction: { assertionId: "F18-restart-convergence-pass", outcome: "pass" },
    counterexample: { assertionId: "F18-convergence-digest-red", outcome: "blocked" },
  },
  F22: {
    descriptorPaths: ["packages/imap/test/raw-download-queue-p3-c07.test.ts"],
    reproduction: { assertionId: "F22-uid-range-planner-pass", outcome: "pass" },
    counterexample: { assertionId: "F22-metadata-batch-blocked", outcome: "blocked" },
  },
  F23: {
    descriptorPaths: ["packages/cli/src/selected-export-command.test.ts"],
    reproduction: { assertionId: "F23-client-command-pass", outcome: "pass" },
    counterexample: { assertionId: "F23-selected-export-blocked", outcome: "blocked" },
  },
};
const capacityManifest = {
  "mime-250mib": {
    argv: ["bun", "test", "packages/imap/test/mime-capacity-p2-c11.test.ts"],
    fixtureId: "issue-176-mime-250mib",
    descriptorPath: "packages/imap/test/mime-capacity-p2-c11.ts",
    scale: { key: "sizeBytes", minimum: 250 * 1024 * 1024, unit: "bytes" },
    metrics: {
      elapsed: { operator: "<=", unit: "seconds" },
      peakBytes: { operator: "<=", unit: "bytes" },
    },
    resources: { units: { peak: "MiB", retained: "MiB" }, limits: { peak: 1, retained: 0 } },
  },
  "fts-250k": {
    argv: ["bun", "test", "packages/storage/test/search-capacity-p4-c17.test.ts"],
    fixtureId: "issue-176-fts-250k",
    descriptorPath: "packages/storage/test/search-capacity-p4-c17.test.ts",
    scale: { key: "rowCount", minimum: 250000, unit: "rows" },
    metrics: {
      elapsed: { operator: "<=", unit: "seconds" },
      rowCount: { operator: ">=", unit: "rows" },
    },
    resources: { units: { peak: "MiB", retained: "MiB" }, limits: { peak: 1, retained: 0 } },
  },
  "selected-export-slow-sink": {
    argv: [
      "bun",
      "test",
      "packages/daemon/test/selected-export-stream-p6-c19.test.ts",
      "packages/cli/src/selected-export-command.test.ts",
    ],
    fixtureId: "issue-176-selected-export-slow-sink",
    descriptorPath: "packages/cli/src/selected-export.fixtures.ts",
    scale: { key: "exportCount", minimum: 1, unit: "exports" },
    metrics: {
      elapsed: { operator: "<=", unit: "seconds" },
      exportCount: { operator: ">=", unit: "exports" },
    },
    resources: { units: { peak: "MiB", retained: "MiB" }, limits: { peak: 1, retained: 0 } },
  },
  "http-stream-admission": {
    argv: ["bun", "test", "packages/daemon/test/http-admission-sec-r03.test.ts"],
    fixtureId: "issue-176-http-stream-admission",
    descriptorPath: "packages/daemon/test/http-admission-sec-r03.test.ts",
    scale: { key: "requestCount", minimum: 1, unit: "requests" },
    metrics: {
      elapsed: { operator: "<=", unit: "seconds" },
      requestCount: { operator: ">=", unit: "requests" },
    },
    resources: { units: { peak: "MiB", retained: "MiB" }, limits: { peak: 1, retained: 0 } },
  },
  "queue-backpressure": {
    argv: ["bun", "test", "packages/imap/test/raw-download-queue-p3-c07.test.ts"],
    fixtureId: "issue-176-queue-backpressure",
    descriptorPath: "packages/imap/test/raw-download-queue-p3-c07.test.ts",
    scale: { key: "itemCount", minimum: 1, unit: "items" },
    metrics: {
      elapsed: { operator: "<=", unit: "seconds" },
      itemCount: { operator: ">=", unit: "items" },
    },
    resources: { units: { peak: "MiB", retained: "MiB" }, limits: { peak: 1, retained: 0 } },
  },
  cancellation: {
    argv: ["bun", "test", "packages/imap/test/idle-session-p3-c18.test.ts"],
    fixtureId: "issue-176-cancellation",
    descriptorPath: "packages/imap/test/idle-session-p3-c18.test.ts",
    scale: { key: "sessionCount", minimum: 1, unit: "sessions" },
    metrics: {
      elapsed: { operator: "<=", unit: "seconds" },
      sessionCount: { operator: ">=", unit: "sessions" },
    },
    resources: { units: { peak: "MiB", retained: "MiB" }, limits: { peak: 1, retained: 0 } },
  },
  "lifecycle-leak": {
    argv: [
      "bun",
      "test",
      "packages/daemon/test/polling-timer-actor-p3-c20.test.ts",
      "packages/daemon/test/sync-runtime-conformance-p3-c24.test.ts",
    ],
    fixtureId: "issue-176-lifecycle-leak",
    descriptorPath: "packages/daemon/test/sync-runtime-conformance-p3-c24.test.ts",
    scale: { key: "iterationCount", minimum: 1, unit: "iterations" },
    metrics: {
      elapsed: { operator: "<=", unit: "seconds" },
      iterationCount: { operator: ">=", unit: "iterations" },
    },
    resources: { units: { peak: "MiB", retained: "MiB" }, limits: { peak: 1, retained: 0 } },
  },
};
const resultRecordSchema = {
  required: [
    "sequence",
    "previousRecordDigest",
    "ownerIssueId",
    "mode",
    "gateId",
    "obligationIds",
    "candidateCommit",
    "candidateTree",
    "evidenceCommit",
    "bundle",
    "closure",
    "argv",
    "startedAt",
    "completedAt",
    "environment",
    "evidence",
    "result",
    "observedOutcome",
  ],
  resultValues: ["pass", "fail", "blocked"],
  modes: ["promotion", "disposition"],
  bundleProjections: ["record", "execution"],
  closureSourceContracts,
  capacitySubgates: requiredCapacitySubgates,
  capacityManifest,
  appendOnly: true,
  protocols: ["legacy-v1", "agent-mail.release-evidence/v2"],
  v2RecordTypes: ["qualification", "disposition"],
  provenanceEnvelope: {
    format: "agent-mail.capture-provenance/v1",
    requiredForPromotion: true,
    outputRootClosure: true,
  },
  commitModel: "candidate-parent-of-evidence-parent-of-index",
  dispositionTargetFields: [
    "targetSequence",
    "targetRecordDigest",
    "targetOwnerIssueId",
    "targetGateId",
    "targetCandidateCommit",
    "targetCandidateTree",
    "targetEvidenceCommit",
  ],
  correctedRerunFields: ["correctedFromSequence", "correctedFromRecordDigest"],
};
let repositoryFilesCache;
let currentCommitCache;
let immutableRowsCache;
let immutableGatesCache;
const gitExistenceCache = new Map();
const gitBlobCache = new Map();
const gitTreeEntryCache = new Map();
const gitCommitTimeCache = new Map();
const validationMemo = new Set();
const canonicalFrozenPaths = new Map([
  ["PLAN", "PLAN.md"],
  ["EVIDENCE", "docs/planning/EVIDENCE.md"],
  ["CLI-OUTCOME-ORACLE", "docs/architecture/cli-command-outcome-oracle.v1.json"],
  ["CLI-OUTCOME-CHECK", "docs/architecture/cli-command-outcome-check.v1.mjs"],
  ["CLI-OUTCOME-COVERAGE", "docs/architecture/cli-command-outcome-coverage.v1.md"],
]);

function fail(message) {
  throw new Error(`release evidence index check failed: ${message}`);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceRows(path, pattern, kind) {
  const text = readFileSync(join(repositoryRoot, path), "utf8");
  const rows = new Map();
  for (const line of text.split("\n")) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = cells[0];
    if (!pattern.test(id ?? "")) continue;
    assert(!rows.has(id), `${path} repeats ${id}`);
    rows.set(id, { id, line, cells, kind });
  }
  return rows;
}

function authorities() {
  const findingRows = sourceRows("docs/planning/EVIDENCE.md", findingIdPattern, "finding");
  const shields = sourceRows("PLAN.md", shieldIdPattern, "shield");
  const expectedFindingIds = [
    ...Array.from({ length: 30 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`),
    "F09-P",
    "F09-R",
    ...Array.from({ length: 7 }, (_, index) => `SEC-R${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 8 }, (_, index) => `CRED-${String(index + 1).padStart(2, "0")}`),
  ];
  assert(findingRows.size === expectedFindingIds.length, "finding source row count drifted");
  for (const id of expectedFindingIds) assert(findingRows.has(id), `source ledger omits ${id}`);
  assert(shields.size === 12, `PLAN shield count ${shields.size} != 12`);
  for (let index = 1; index <= 12; index += 1) {
    const id = `S${String(index).padStart(2, "0")}`;
    assert(shields.has(id), `PLAN omits ${id}`);
  }
  return { findingRows, shields };
}

function issueIds(line) {
  return [...new Set([...line.matchAll(/#(\d+)/gu)].map((match) => Number(match[1])))];
}

function findingFields(row) {
  const { cells } = row;
  if (/^F(?:0[1-9]|[12][0-9]|30)$/u.test(row.id)) {
    return {
      owner: cells[4],
      status: cells[5],
      problem: cells[1],
      invariant: "",
      control: cells[2],
      proof: cells[3],
    };
  }
  if (/^F09-[PR]$|^SEC-R/u.test(row.id)) {
    return {
      owner: cells[5],
      status: cells[7],
      problem: cells[1],
      invariant: cells[2],
      control: cells[3],
      proof: cells[4],
    };
  }
  return {
    owner: cells[5],
    status: cells[10],
    problem: cells[1],
    invariant: cells[2],
    control: cells[3],
    proof: cells[4],
  };
}

function shieldFields(row) {
  return {
    owner: "PLAN planning-shield registry",
    status: row.cells[1],
    problem: row.cells[2],
    invariant: "",
    control: row.cells[2],
    proof: "PLAN planning-shield applicability row",
  };
}

function expectedFields(row) {
  const fields = row.kind === "shield" ? shieldFields(row) : findingFields(row);
  return { ...fields, ownerIssues: issueIds(row.line) };
}

function allRepositoryFiles() {
  if (repositoryFilesCache) return repositoryFilesCache;
  repositoryFilesCache = execFileSync(
    "rg",
    ["--files", "-g", "!node_modules/**", "-g", "!dist/**"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  return repositoryFilesCache;
}

function artifactPaths(status) {
  const files = allRepositoryFiles();
  const tokens = [...status.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
  const candidates = [];
  for (const token of tokens) {
    if (!/\.(?:ts|tsx|mjs|js|json|md)$/u.test(token)) continue;
    const direct = files.includes(token) ? token : files.find((file) => file.endsWith(`/${token}`));
    if (direct && !candidates.includes(direct)) candidates.push(direct);
  }
  return candidates;
}

function declaredCommits(status) {
  return [
    ...new Set([...status.matchAll(/(?:\(|`)([0-9a-f]{7,40})(?:\)|`)/gu)].map((match) => match[1])),
  ];
}

function commitArtifacts(commits, paths) {
  for (const commit of commits) {
    try {
      execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
        cwd: repositoryRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
      const artifacts = paths.map((path) => {
        const bytes = execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], {
          cwd: repositoryRoot,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return { path, sha256: digest(bytes) };
      });
      return { commit, artifacts };
    } catch {
      // A candidate commit that does not contain every artifact is not proof.
    }
  }
  return null;
}

function resultFor(row, fields) {
  const status = fields.status;
  const ref = `${row.kind === "shield" ? "PLAN.md" : "docs/planning/EVIDENCE.md"}#${row.id}`;
  if (status.includes("split below")) {
    return {
      kind: "superseded",
      status: "superseded",
      ref,
      reason: "Historical F09 is retained and replaced by F09-P and F09-R.",
    };
  }
  const blocked =
    /current red|load-blocked|current candidate load-blocked|unverified|deployed proof absent/iu.test(
      status,
    ) ||
    (/release-blocking/iu.test(status) && !status.startsWith("locally verified"));
  const paths = artifactPaths(status);
  const fingerprints = declaredCommits(status);
  const historicalProof =
    !blocked && paths.length > 0 ? commitArtifacts(fingerprints, paths) : null;
  if (historicalProof) {
    return {
      kind: "retained-proof",
      status: fields.status.startsWith("locally verified") ? "locally verified" : "implemented",
      ref,
      candidateFingerprint: historicalProof.commit,
      commit: historicalProof.commit,
      command: `bun test ${paths.join(" ")}`,
      artifacts: historicalProof.artifacts,
      sourceStatus: status,
    };
  }
  if (!blocked && paths.length > 0 && fingerprints.length > 0) {
    return {
      kind: "blocked",
      status: "unverified",
      ref,
      reason: `Source-declared commits ${fingerprints.join(", ")} do not share every retained artifact path; current-worktree evidence is inadmissible.`,
      ownerIssueIds: issueIds(row.line),
    };
  }
  return {
    kind: blocked ? "blocked" : "unverified",
    status: "unverified",
    ref,
    reason: status,
    ownerIssueIds: issueIds(row.line),
  };
}

function expectedProofClass(result) {
  return result.kind === "retained-proof" ? "retained" : result.kind;
}
function expectedRowStatus(fields) {
  if (fields.status === "required") return "specified";
  if (fields.status.includes("split below")) return "superseded";
  return fields.status.startsWith("specified") || fields.status.includes("design accepted")
    ? "specified"
    : "implemented";
}

function expectedEvidence(row, result) {
  const empty = Object.fromEntries(requiredEvidenceClasses.map((key) => [key, "unverified"]));
  if (result.kind !== "retained-proof") return empty;
  empty.implementation = "implemented";
  if (["F22", "F23", "F29", "F30"].includes(row.id)) empty.capacity = "implemented";
  if (/^SEC-R0[2-4]$/u.test(row.id)) empty.security = "locally verified";
  if (row.id === "F09-P") empty.security = "implemented";
  return empty;
}

function currentCommit() {
  if (currentCommitCache) return currentCommitCache;
  currentCommitCache = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return currentCommitCache;
}

function gateObligationIds(gateId) {
  return [
    ...new Set(
      (gateResultAuthority[gateId] ?? []).flatMap((issueId) => {
        const rule = resultOwnerAuthority[String(issueId)];
        return rule?.obligationIds ?? [];
      }),
    ),
  ];
}

function checkResultOwnerAuthority(index) {
  assert(
    index.resultAuthorityCommentId === resultAuthorityCommentId,
    "result authority comment is not frozen",
  );
  assert(
    JSON.stringify(index.gateResultAuthority) === JSON.stringify(gateResultAuthority),
    "gate-result authority is detached",
  );
  assert(
    JSON.stringify(index.resultOwnerAuthority) === JSON.stringify(resultOwnerAuthority),
    "result-owner authority is detached or overly broad",
  );
}

function recordDigest(record) {
  return digest(Buffer.from(JSON.stringify(record)));
}

function baselineProofDigest(row) {
  return digest(
    Buffer.from(
      JSON.stringify({
        id: row.id,
        owner: row.owner,
        ownerIssues: row.ownerIssues,
        proofClass: row.proofClass,
        status: row.status,
        sourceStatus: row.sourceStatus,
        sourceProblem: row.sourceProblem,
        sourceInvariant: row.sourceInvariant,
        sourceControl: row.sourceControl,
        sourceProof: row.sourceProof,
        artifact: row.artifact,
        result: row.result,
        evidence: row.evidence,
      }),
    ),
  );
}

function commitTimestamp(commit, root) {
  const key = `${root}\0${commit}`;
  if (!gitCommitTimeCache.has(key))
    gitCommitTimeCache.set(
      key,
      Date.parse(
        execFileSync("git", ["show", "-s", "--format=%cI", commit], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
      ),
    );
  return gitCommitTimeCache.get(key);
}

function gitExists(commit, path, root = repositoryRoot) {
  const key = `${root}\0${commit}\0${path}`;
  if (gitExistenceCache.has(key)) return gitExistenceCache.get(key);
  try {
    execFileSync("git", ["cat-file", "-e", path ? `${commit}:${path}` : `${commit}^{commit}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    gitExistenceCache.set(key, true);
    return true;
  } catch {
    gitExistenceCache.set(key, false);
    return false;
  }
}

function canonicalRecordProjection(record) {
  return {
    sequence: record.sequence,
    previousRecordDigest: record.previousRecordDigest,
    ownerIssueId: record.ownerIssueId,
    mode: record.mode,
    gateId: record.gateId,
    obligationIds: record.obligationIds,
    candidateCommit: record.candidateCommit,
    candidateTree: record.candidateTree,
    // The evidence commit is the commit that stores this bundle. Including its
    // own hash in the bundle would make the Git object self-referential. The
    // persisted index binds this field after the evidence-only commit exists.
    bundle: { path: record.bundle.path },
    closure: record.closure ?? {},
  };
}

function canonicalExecutionProjection(record) {
  return {
    argv: record.argv,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    environment: record.environment,
    evidence: record.evidence,
    result: record.result,
    observedOutcome: record.observedOutcome,
  };
}

function committedBlob(commit, path, root) {
  const key = `${root}\0${commit}\0${path}`;
  if (gitBlobCache.has(key)) return gitBlobCache.get(key);
  assert(gitExists(commit, path, root), `evidence path ${path} is absent at ${commit}`);
  const bytes = execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  gitBlobCache.set(key, bytes);
  return bytes;
}

function assertResourceOutcome(value, label) {
  if (value && typeof value === "object" && "status" in value)
    assert(value.status === "pass", `${label} resource outcome is not pass`);
}

const allowedThresholdOperators = new Set(["<", "<=", "===", ">=", ">"]);
function finiteNonnegative(value, label) {
  assert(
    typeof value === "number" &&
      Number.isFinite(value) &&
      !Object.is(value, -0) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER,
    `${label} must be finite, safe, and nonnegative`,
  );
}

// Receipt provenance is produced by the runner with canonical JSON.  Keep the
// checker-side projection independent of object insertion order so a persisted
// envelope cannot be made to agree merely by reserializing its fields.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepJsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function resolveJsonPointer(document, pointer) {
  assert(
    typeof pointer === "string" && (pointer === "" || pointer.startsWith("/")),
    "oracle pointer is invalid",
  );
  if (pointer === "") return document;
  let value = document;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    assert(
      value !== null && typeof value === "object" && key in value,
      "oracle pointer is unresolved",
    );
    value = value[key];
  }
  return value;
}

function canonicalEvidencePath(path, label, ownerIssueId = 176) {
  canonicalOwnerEvidencePath(path, ownerIssueId, label);
}

function canonicalOwnerEvidencePath(path, ownerIssueId, label) {
  const prefix = `docs/qualification/evidence/issue-${ownerIssueId}/`;
  assert(
    typeof path === "string" &&
      path.startsWith(prefix) &&
      !path.includes("..") &&
      !path.includes("\\") &&
      !path.startsWith("/"),
    `${label} path is outside owner evidence root`,
  );
  assert(
    path === path.normalize("NFC") && path.split("/").every((part) => part.length > 0),
    `${label} path is not normalized`,
  );
}

function regularEvidenceBlob(commit, path, root, label, ownerIssueId = 176) {
  canonicalEvidencePath(path, label, ownerIssueId);
  const key = `${root}\0${commit}\0${path}`;
  const entries = gitTreeEntryCache.has(key)
    ? gitTreeEntryCache.get(key)
    : execFileSync("git", ["ls-tree", "-z", commit, "--", path], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean);
  gitTreeEntryCache.set(key, entries);
  assert(entries.length === 1, `${label} must be one committed blob`);
  const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/u.exec(entries[0]);
  assert(match?.[2] === path, `${label} has non-regular Git mode or detached path`);
  const bytes = committedBlob(commit, path, root);
  assert(bytes.length > 0, `${label} is empty`);
  return bytes;
}

function regularCandidateBlob(commit, path, root, label) {
  const key = `${root}\0${commit}\0${path}`;
  const entries = gitTreeEntryCache.has(key)
    ? gitTreeEntryCache.get(key)
    : execFileSync("git", ["ls-tree", "-z", commit, "--", path], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean);
  gitTreeEntryCache.set(key, entries);
  assert(entries.length === 1, `${label} must be one committed blob`);
  const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/u.exec(entries[0]);
  assert(match?.[2] === path, `${label} has non-regular Git mode or detached path`);
  return committedBlob(commit, path, root);
}

function evaluateThreshold(actual, operator, limit) {
  return operator === "<"
    ? actual < limit
    : operator === "<="
      ? actual <= limit
      : operator === "==="
        ? actual === limit
        : operator === ">="
          ? actual >= limit
          : actual > limit;
}

function validateBundleRecord(
  record,
  baseline,
  sequence,
  previousDigest,
  root = repositoryRoot,
  options = {},
) {
  const label = `result sequence ${record.sequence}`;
  assert(
    Number.isInteger(record.sequence) && record.sequence === sequence,
    `${label} is not monotonic`,
  );
  assert(
    (sequence === 1 && record.previousRecordDigest === null) ||
      (sequence > 1 &&
        /^[0-9a-f]{64}$/u.test(record.previousRecordDigest ?? "") &&
        record.previousRecordDigest === previousDigest),
    `${label} hash chain is broken`,
  );
  assert(Number.isInteger(record.ownerIssueId), `${label} owner issue is invalid`);
  const ownerRule = resultOwnerAuthority[String(record.ownerIssueId)];
  assert(ownerRule, `${label} owner issue is unauthorized`);
  assert(resultRecordSchema.modes.includes(record.mode), `${label} mode is invalid`);
  assert(
    requiredGateIds.includes(record.gateId) || record.gateId === "disposition",
    `${label} gate is invalid`,
  );
  assert(ownerRule.mode.includes(record.mode), `${label} owner cannot write this mode`);
  assert(
    record.mode === "disposition"
      ? record.gateId === "disposition"
      : ownerRule.gateIds.includes(record.gateId),
    `${label} owner cannot write this gate`,
  );
  assert(Array.isArray(record.obligationIds), `${label} obligation coverage is missing`);
  const obligationIds = [...new Set(record.obligationIds)];
  assert(
    obligationIds.length === record.obligationIds.length,
    `${label} coverage repeats an obligation`,
  );
  for (const obligationId of obligationIds) {
    assert(baseline.has(obligationId), `${label} names an unknown obligation`);
    assert(
      ownerRule.obligationIds.includes(obligationId),
      `${label} owner cannot write ${obligationId}`,
    );
    const baselineRow = baseline.get(obligationId);
    assert(
      baselineRow.result.kind !== "superseded",
      `${label} overwrites superseded history ${obligationId}`,
    );
    if (baselineRow.result.kind === "blocked")
      assert(record.result === "pass", `${label} blocked history lacks a passing closure result`);
  }
  if (ownerRule.closureOnly)
    assert(obligationIds.length === 0, `${label} closure owner has obligation coverage`);
  if (record.mode === "disposition")
    assert(
      record.ownerIssueId === 184 && record.gateId === "disposition" && obligationIds.length === 0,
      `${label} disposition is not #184-only`,
    );
  assert(/^[0-9a-f]{40}$/u.test(record.candidateCommit), `${label} candidate commit is not full`);
  assert(/^[0-9a-f]{40}$/u.test(record.candidateTree), `${label} candidate tree is not full`);
  assert(/^[0-9a-f]{40}$/u.test(record.evidenceCommit), `${label} evidence commit is not full`);
  assert(gitExists(record.candidateCommit, "", root), `${label} candidate commit is missing`);
  const actualTree = execFileSync("git", ["rev-parse", `${record.candidateCommit}^{tree}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert(actualTree === record.candidateTree, `${label} candidate tree is mismatched`);
  execFileSync("git", ["cat-file", "-e", `${record.evidenceCommit}^{commit}`], {
    cwd: root,
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", record.candidateCommit, record.evidenceCommit],
      { cwd: root, stdio: "ignore" },
    );
  } catch {
    fail(`${label} candidate is not an ancestor of evidence commit`);
  }
  assert(
    Array.isArray(record.argv) &&
      record.argv.length > 1 &&
      record.argv.every((arg) => typeof arg === "string" && arg.length > 0),
    `${label} argv is missing or not structured`,
  );
  assert(
    ["bun", "node", "python3", "swift", "xcodebuild"].includes(record.argv[0]),
    `${label} argv is unrelated to qualification`,
  );
  assert(
    !("command" in record) && !("evidenceKind" in record) && !("artifacts" in record),
    `${label} uses free-form result fields`,
  );
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  assert(
    utc.test(record.startedAt) && utc.test(record.completedAt),
    `${label} timestamps must be strict UTC`,
  );
  assert(
    Date.parse(record.completedAt) > Date.parse(record.startedAt),
    `${label} timestamp order is invalid`,
  );
  assert(
    record.environment &&
      ["os", "arch", "runtime"].every(
        (key) => typeof record.environment[key] === "string" && record.environment[key].trim(),
      ),
    `${label} environment identity is incomplete`,
  );
  assert(resultRecordSchema.resultValues.includes(record.result), `${label} result is invalid`);
  assert(
    record.observedOutcome &&
      typeof record.observedOutcome === "object" &&
      typeof record.observedOutcome.status === "string",
    `${label} observed outcome is missing`,
  );
  assert(
    record.observedOutcome.status === record.result,
    `${label} observed outcome does not match result`,
  );
  assert(
    record.evidence &&
      typeof record.evidence === "object" &&
      Object.keys(record.evidence).length > 0,
    `${label} gate-specific evidence is missing`,
  );
  const prospective = options.mode === "prospective";
  const bundleCommit = options.bundleCommit ?? record.evidenceCommit;
  assert(record.closure && typeof record.closure === "object", `${label} closure map is missing`);
  const recordPaths = new Set(typeof record.bundle?.path === "string" ? [record.bundle.path] : []);
  const readClosureArtifact = (ref, closureLabel) => {
    assert(
      ref && typeof ref.path === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
      `${closureLabel} artifact reference is invalid`,
    );
    canonicalOwnerEvidencePath(ref.path, record.ownerIssueId, closureLabel);
    assert(!recordPaths.has(ref.path), `${closureLabel} artifact path is duplicated`);
    recordPaths.add(ref.path);
    if (prospective) {
      const stat = lstatSync(join(root, ref.path));
      assert(
        stat.isFile() && !stat.isSymbolicLink(),
        `${closureLabel} must be a regular non-symlink file`,
      );
    }
    const bytes = prospective
      ? readFileSync(join(root, ref.path))
      : regularEvidenceBlob(bundleCommit, ref.path, root, closureLabel, record.ownerIssueId);
    assert(digest(bytes) === ref.sha256, `${closureLabel} artifact digest drifted`);
    const artifact = JSON.parse(bytes.toString("utf8"));
    assert(
      artifact.status === "pass" && artifact.candidateCommit === record.candidateCommit,
      `${closureLabel} artifact is not pass-bound`,
    );
    return artifact;
  };
  const readClosureProof = (ref, proofLabel) => {
    assert(
      ref && typeof ref.path === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
      `${proofLabel} reference is invalid`,
    );
    canonicalOwnerEvidencePath(ref.path, record.ownerIssueId, proofLabel);
    assert(!recordPaths.has(ref.path), `${proofLabel} path is duplicated`);
    recordPaths.add(ref.path);
    if (prospective) {
      const stat = lstatSync(join(root, ref.path));
      assert(stat.isFile() && !stat.isSymbolicLink(), `${proofLabel} must be regular evidence`);
    }
    const bytes = prospective
      ? readFileSync(join(root, ref.path))
      : regularEvidenceBlob(bundleCommit, ref.path, root, proofLabel, record.ownerIssueId);
    assert(digest(bytes) === ref.sha256, `${proofLabel} digest drifted`);
    return JSON.parse(bytes.toString("utf8"));
  };
  if (record.result === "pass") {
    for (const obligationId of obligationIds) {
      const baselineRow = baseline.get(obligationId);
      if (baselineRow?.result.kind !== "blocked") continue;
      const closure = record.closure[obligationId];
      assert(
        closure &&
          closure.baselineSourceStatusSha256 === digest(Buffer.from(baselineRow.sourceStatus)) &&
          closure.baselineProofDigest === baselineProofDigest(baselineRow),
        `${label} ${obligationId} baseline closure digest is missing or forged`,
      );
      for (const [kind, expectedKind] of [
        ["originalReproduction", "reproduction"],
        ["adjacentCounterexample", "counterexample"],
      ]) {
        const entry = closure[kind];
        assert(
          Array.isArray(entry?.argv) && entry.argv.length > 1 && entry.artifact,
          `${label} ${obligationId} ${kind} is incomplete`,
        );
        const artifact = readClosureArtifact(entry.artifact, `${label} ${obligationId} ${kind}`);
        const proof = readClosureProof(entry.proof, `${label} ${obligationId} ${kind} proof`);
        const sourceContract = closureSourceContracts[obligationId];
        assert(sourceContract, `${label} ${obligationId} has no frozen source contract`);
        const roleContract = sourceContract[expectedKind];
        assert(roleContract, `${label} ${obligationId} ${kind} has no frozen assertion contract`);
        const expectedOutcome =
          expectedKind === "reproduction"
            ? { kind: "reproduction", baselineMatch: true, status: "pass" }
            : { kind: "counterexample", baselineMatch: false, status: "pass" };
        assert(
          Array.isArray(proof.sourceDescriptors) &&
            JSON.stringify(proof.sourceDescriptors.map((descriptor) => descriptor.path)) ===
              JSON.stringify(sourceContract.descriptorPaths),
          `${label} ${obligationId} ${kind} source descriptor paths are not frozen`,
        );
        for (const descriptor of proof.sourceDescriptors) {
          assert(
            descriptor &&
              typeof descriptor.path === "string" &&
              /^[0-9a-f]{64}$/u.test(descriptor.sha256),
            `${label} ${obligationId} ${kind} source descriptor reference is invalid`,
          );
          const descriptorBytes = regularCandidateBlob(
            record.candidateCommit,
            descriptor.path,
            root,
            `${label} ${obligationId} ${kind} source descriptor`,
          );
          assert(
            digest(descriptorBytes) === descriptor.sha256,
            `${label} ${obligationId} ${kind} source descriptor digest drifted`,
          );
        }
        const receipt = proof.receipt;
        assert(
          receipt &&
            JSON.stringify(receipt.argv) === JSON.stringify(entry.argv) &&
            receipt.exitCode === 0 &&
            Array.isArray(receipt.assertions) &&
            receipt.assertions.length === 1 &&
            receipt.assertions[0]?.id === roleContract.assertionId &&
            receipt.assertions[0]?.outcome === roleContract.outcome,
          `${label} ${obligationId} ${kind} execution receipt is not source-bound`,
        );
        const derivedSuccess =
          receipt.exitCode === 0 && receipt.assertions[0].outcome === roleContract.outcome;
        assert(
          derivedSuccess,
          `${label} ${obligationId} ${kind} proof outcome did not derive from receipt`,
        );
        assert(
          artifact.kind === expectedKind &&
            artifact.role === expectedKind &&
            artifact.obligationId === obligationId &&
            artifact.ownerIssueId === record.ownerIssueId &&
            artifact.gateId === record.gateId &&
            artifact.sequence === record.sequence &&
            artifact.candidateTree === record.candidateTree &&
            JSON.stringify(artifact.argv) === JSON.stringify(entry.argv) &&
            JSON.stringify(artifact.sourceDescriptors) ===
              JSON.stringify(proof.sourceDescriptors) &&
            JSON.stringify(artifact.receipt) === JSON.stringify(receipt) &&
            artifact.exitCode === 0 &&
            artifact.result === "pass" &&
            artifact.baselineProofDigest === closure.baselineProofDigest &&
            artifact.proof?.path === entry.proof.path &&
            artifact.proof?.sha256 === entry.proof.sha256 &&
            JSON.stringify(artifact.observedOutcome) === JSON.stringify(expectedOutcome),
          `${label} ${obligationId} ${kind} artifact is detached`,
        );
        assert(
          proof.kind === "closure-proof" &&
            proof.role === expectedKind &&
            proof.obligationId === obligationId &&
            proof.ownerIssueId === record.ownerIssueId &&
            proof.gateId === record.gateId &&
            proof.sequence === record.sequence &&
            proof.candidateCommit === record.candidateCommit &&
            proof.candidateTree === record.candidateTree &&
            JSON.stringify(proof.argv) === JSON.stringify(entry.argv) &&
            proof.exitCode === 0 &&
            proof.result === "pass" &&
            proof.baselineProofDigest === closure.baselineProofDigest &&
            JSON.stringify(proof.receipt) === JSON.stringify(receipt) &&
            JSON.stringify(proof.observedOutcome) === JSON.stringify(expectedOutcome),
          `${label} ${obligationId} ${kind} proof content is detached or non-substantive`,
        );
      }
    }
  }
  if (record.gateId === "capacity") {
    const subgates = record.evidence.subgates;
    assert(subgates && typeof subgates === "object", `${label} capacity subgates are missing`);
    assert(
      JSON.stringify(Object.keys(subgates).sort()) ===
        JSON.stringify([...requiredCapacitySubgates].sort()),
      `${label} capacity subgate coverage is incomplete or extra`,
    );
    const aggregatePaths = [
      ...new Set(
        requiredCapacitySubgates.flatMap((subgateId) => capacityManifest[subgateId].argv.slice(2)),
      ),
    ];
    const aggregateArgv = ["bun", "test", ...aggregatePaths];
    assert(
      JSON.stringify(record.argv) === JSON.stringify(aggregateArgv),
      `${label} top-level argv is not canonical aggregate`,
    );
    canonicalEvidencePath(record.bundle.path, `${label} bundle`, record.ownerIssueId);
    const seenRawDigests = new Set();
    const seenRawContent = new Set();
    const readEvidence = (ref, refLabel) => {
      assert(
        ref && typeof ref.path === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
        `${refLabel} reference is invalid`,
      );
      canonicalEvidencePath(ref.path, refLabel, record.ownerIssueId);
      assert(!recordPaths.has(ref.path), `${refLabel} path is duplicated or reuses bundle`);
      recordPaths.add(ref.path);
      if (options.mode === "prospective") {
        const stat = lstatSync(join(root, ref.path));
        assert(
          stat.isFile() && !stat.isSymbolicLink(),
          `${refLabel} must be a regular non-symlink file`,
        );
      }
      const bytes =
        options.mode === "prospective"
          ? readFileSync(join(root, ref.path))
          : regularEvidenceBlob(bundleCommit, ref.path, root, refLabel, record.ownerIssueId);
      assert(digest(bytes) === ref.sha256, `${refLabel} digest drifted`);
      return JSON.parse(bytes.toString("utf8"));
    };
    for (const subgateId of requiredCapacitySubgates) {
      const manifest = capacityManifest[subgateId];
      const subgate = subgates[subgateId];
      for (const testPath of manifest.argv.slice(2)) {
        assert(
          gitExists(record.candidateCommit, testPath, root),
          `${label} ${subgateId} candidate test path is absent`,
        );
      }
      assert(
        subgate.descriptor &&
          subgate.descriptor.path === manifest.descriptorPath &&
          /^[0-9a-f]{64}$/u.test(subgate.descriptor.sha256),
        `${label} ${subgateId} descriptor binding is invalid`,
      );
      const descriptorBytes = regularCandidateBlob(
        record.candidateCommit,
        subgate.descriptor.path,
        root,
        `${label} ${subgateId} descriptor`,
      );
      assert(
        digest(descriptorBytes) === subgate.descriptor.sha256,
        `${label} ${subgateId} descriptor digest drifted`,
      );
      assert(
        subgate.fixtureDigests[0] === subgate.descriptor.sha256,
        `${label} ${subgateId} fixture digest is not descriptor-bound`,
      );
      assert(
        JSON.stringify(subgate.argv) === JSON.stringify(manifest.argv),
        `${label} ${subgateId} argv is not canonical`,
      );
      assert(
        JSON.stringify(subgate.fixtureIds) === JSON.stringify([manifest.fixtureId]),
        `${label} ${subgateId} fixture ID is not canonical`,
      );
      assert(
        Array.isArray(subgate.fixtureDigests) &&
          subgate.fixtureDigests.length === 1 &&
          /^[0-9a-f]{64}$/u.test(subgate.fixtureDigests[0]),
        `${label} ${subgateId} fixture digest is invalid`,
      );
      assert(
        subgate.scale &&
          Object.keys(subgate.scale).length === 2 &&
          subgate.scale[manifest.scale.key] !== undefined &&
          subgate.scale.unit === manifest.scale.unit,
        `${label} ${subgateId} scale shape is invalid`,
      );
      finiteNonnegative(subgate.scale[manifest.scale.key], `${label} ${subgateId} scale`);
      assert(
        subgate.scale[manifest.scale.key] >= manifest.scale.minimum,
        `${label} ${subgateId} scale is below minimum`,
      );
      assert(
        Array.isArray(subgate.thresholds) &&
          subgate.thresholds.length === Object.keys(manifest.metrics).length,
        `${label} ${subgateId} threshold count is invalid`,
      );
      const thresholdByMetric = new Map();
      for (const threshold of subgate.thresholds) {
        assert(
          threshold &&
            typeof threshold.metric === "string" &&
            !thresholdByMetric.has(threshold.metric),
          `${label} ${subgateId} threshold metric is duplicate or invalid`,
        );
        const expected = manifest.metrics[threshold.metric];
        assert(
          expected &&
            allowedThresholdOperators.has(threshold.operator) &&
            threshold.operator === expected.operator &&
            threshold.unit === expected.unit,
          `${label} ${subgateId} threshold direction/unit is invalid`,
        );
        finiteNonnegative(threshold.limit, `${label} ${subgateId} threshold limit`);
        thresholdByMetric.set(threshold.metric, threshold);
      }
      assert(
        thresholdByMetric.size === Object.keys(manifest.metrics).length,
        `${label} ${subgateId} threshold metrics are incomplete`,
      );
      assert(
        Array.isArray(subgate.rawSamples) && subgate.rawSamples.length === 1,
        `${label} ${subgateId} raw sample count is invalid`,
      );
      const sample = subgate.rawSamples[0];
      const raw = readEvidence(sample, `${label} ${subgateId} raw sample`);
      assert(
        !seenRawDigests.has(sample.sha256) && !seenRawContent.has(JSON.stringify(raw)),
        `${label} ${subgateId} raw sample is reused across subgates`,
      );
      seenRawDigests.add(sample.sha256);
      seenRawContent.add(JSON.stringify(raw));
      assert(
        raw.subgateId === subgateId &&
          raw.fixtureId === manifest.fixtureId &&
          raw.fixtureDigest === subgate.fixtureDigests[0] &&
          raw.descriptorPath === manifest.descriptorPath &&
          raw.descriptorDigest === subgate.descriptor.sha256,
        `${label} ${subgateId} raw fixture association is invalid`,
      );
      assert(
        raw.scale && JSON.stringify(raw.scale) === JSON.stringify(subgate.scale),
        `${label} ${subgateId} raw scale is detached`,
      );
      assert(
        raw.metrics &&
          typeof raw.metrics === "object" &&
          JSON.stringify(Object.keys(raw.metrics).sort()) ===
            JSON.stringify(Object.keys(manifest.metrics).sort()),
        `${label} ${subgateId} raw metrics are incomplete or extra`,
      );
      for (const [metric, expected] of Object.entries(manifest.metrics)) {
        finiteNonnegative(raw.metrics[metric], `${label} ${subgateId} raw ${metric}`);
        assert(
          evaluateThreshold(
            raw.metrics[metric],
            expected.operator,
            thresholdByMetric.get(metric).limit,
          ),
          `${label} ${subgateId} raw ${metric} misses threshold`,
        );
      }
      assert(
        subgate.observations &&
          JSON.stringify(subgate.observations.metrics) === JSON.stringify(raw.metrics) &&
          typeof subgate.observations.summary === "string" &&
          subgate.observations.summary.length > 0,
        `${label} ${subgateId} observations are detached`,
      );
      const correctness = readEvidence(
        subgate.artifacts?.correctness,
        `${label} ${subgateId} correctness artifact`,
      );
      assert(
        correctness.kind === "correctness" &&
          correctness.subgateId === subgateId &&
          correctness.candidateCommit === record.candidateCommit &&
          correctness.status === "pass" &&
          correctness.oracle === manifest.fixtureId,
        `${label} ${subgateId} correctness artifact is invalid`,
      );
      assert(
        subgate.correctness?.status === "pass" &&
          subgate.correctness.oracle?.path === subgate.artifacts.correctness.path &&
          subgate.correctness.oracle?.sha256 === subgate.artifacts.correctness.sha256,
        `${label} ${subgateId} correctness binding is invalid`,
      );
      const resources = readEvidence(
        subgate.artifacts?.resources,
        `${label} ${subgateId} resources artifact`,
      );
      assert(
        resources.kind === "resources" &&
          resources.subgateId === subgateId &&
          resources.candidateCommit === record.candidateCommit &&
          resources.status === "pass",
        `${label} ${subgateId} resources artifact is invalid`,
      );
      assert(
        JSON.stringify(Object.keys(resources).sort()) ===
          JSON.stringify(
            ["candidateCommit", "kind", "limits", "peak", "retained", "status", "subgateId"].sort(),
          ),
        `${label} ${subgateId} resources artifact shape is invalid`,
      );
      for (const resourceKey of ["peak", "retained"]) {
        finiteNonnegative(
          resources[resourceKey]?.value,
          `${label} ${subgateId} ${resourceKey} resource`,
        );
        assert(
          typeof resources[resourceKey]?.unit === "string" &&
            resources[resourceKey].unit.length > 0,
          `${label} ${subgateId} ${resourceKey} unit is invalid`,
        );
        assert(
          resources[resourceKey].unit === manifest.resources.units[resourceKey] &&
            resources[resourceKey].value <= manifest.resources.limits[resourceKey],
          `${label} ${subgateId} ${resourceKey} resource exceeds frozen bound`,
        );
      }
      for (const resourceKey of ["peak", "retained"]) {
        finiteNonnegative(
          resources.limits?.[resourceKey],
          `${label} ${subgateId} ${resourceKey} resource limit`,
        );
        assert(
          resources.limits[resourceKey] === manifest.resources.limits[resourceKey],
          `${label} ${subgateId} resource limit is not frozen`,
        );
      }
      assert(
        subgate.resources?.status === "pass" &&
          subgate.resources.peak?.value === resources.peak.value &&
          subgate.resources.retained?.value === resources.retained.value &&
          subgate.resources.peak?.unit === resources.peak.unit &&
          subgate.resources.retained?.unit === resources.retained.unit &&
          JSON.stringify(subgate.resources.limits) === JSON.stringify(resources.limits),
        `${label} ${subgateId} resources binding is invalid`,
      );
      const cleanup = readEvidence(
        subgate.artifacts?.cleanup,
        `${label} ${subgateId} cleanup artifact`,
      );
      assert(
        cleanup.kind === "cleanup" &&
          cleanup.subgateId === subgateId &&
          cleanup.candidateCommit === record.candidateCommit &&
          cleanup.status === "pass" &&
          cleanup.leaks &&
          JSON.stringify(Object.keys(cleanup.leaks).sort()) ===
            JSON.stringify(["files", "listeners", "openHandles", "processes"].sort()) &&
          Object.values(cleanup.leaks).every((value) => Number.isSafeInteger(value) && value === 0),
        `${label} ${subgateId} cleanup artifact is invalid`,
      );
      assert(
        subgate.cleanup?.status === "pass" &&
          subgate.cleanup.leaks &&
          JSON.stringify(Object.keys(subgate.cleanup.leaks).sort()) ===
            JSON.stringify(["files", "listeners", "openHandles", "processes"].sort()) &&
          Object.values(subgate.cleanup.leaks).every(
            (value) => Number.isSafeInteger(value) && value === 0,
          ),
        `${label} ${subgateId} cleanup is not leak-free`,
      );
    }
  }
  for (const key of ["correctness", "cleanup"])
    assertResourceOutcome(record.evidence[key], `${label} evidence`);
  if (record.result === "pass") {
    assert(record.evidence.correctness?.status !== "fail", `${label} pass has failing correctness`);
    assert(record.evidence.cleanup?.status !== "fail", `${label} pass has failing cleanup`);
  }
  assert(
    record.bundle &&
      typeof record.bundle.path === "string" &&
      /^[0-9a-f]{64}$/u.test(record.bundle.sha256),
    `${label} bundle identity is invalid`,
  );
  assert(
    record.bundle.path.endsWith(".json") &&
      (prospective
        ? (() => {
            try {
              const stat = lstatSync(join(root, record.bundle.path));
              return stat.isFile() && !stat.isSymbolicLink();
            } catch {
              return false;
            }
          })()
        : (() => {
            try {
              regularEvidenceBlob(
                bundleCommit,
                record.bundle.path,
                root,
                `${label} bundle`,
                record.ownerIssueId,
              );
              return true;
            } catch {
              return false;
            }
          })()),
    `${label} bundle is absent from ${prospective ? "prospective worktree" : "evidence commit"}`,
  );
  const bundleBytes = prospective
    ? readFileSync(join(root, record.bundle.path))
    : execFileSync("git", ["cat-file", "blob", `${bundleCommit}:${record.bundle.path}`], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      });
  assert(digest(bundleBytes) === record.bundle.sha256, `${label} bundle digest drifted`);
  let bundle;
  try {
    bundle = JSON.parse(bundleBytes.toString("utf8"));
  } catch {
    fail(`${label} bundle is not JSON`);
  }
  assert(
    JSON.stringify(bundle.record) === JSON.stringify(canonicalRecordProjection(record)),
    `${label} bundle record projection is detached`,
  );
  assert(
    JSON.stringify(bundle.execution) === JSON.stringify(canonicalExecutionProjection(record)),
    `${label} bundle execution projection is detached`,
  );
  const evidenceCommitTime = commitTimestamp(bundleCommit, root);
  assert(
    Date.parse(record.completedAt) <= evidenceCommitTime + 5 * 60 * 1000,
    `${label} completed after evidence commit window`,
  );
  assert(
    Date.parse(record.completedAt) >= evidenceCommitTime - 24 * 60 * 60 * 1000,
    `${label} evidence is stale`,
  );
  return ownerRule;
}

function v2EvidenceRef(record, ref, root, label) {
  assert(
    ref && typeof ref.path === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
    `${label} reference is invalid`,
  );
  canonicalOwnerEvidencePath(ref.path, record.ownerIssueId, label);
  const bytes = regularEvidenceBlob(
    record.evidenceCommit,
    ref.path,
    root,
    label,
    record.ownerIssueId,
  );
  assert(digest(bytes) === ref.sha256, `${label} digest drifted`);
  return bytes;
}

function v2CandidateRef(record, ref, root, label) {
  assert(
    ref && typeof ref.path === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
    `${label} reference is invalid`,
  );
  const bytes = regularCandidateBlob(record.candidateCommit, ref.path, root, label);
  assert(digest(bytes) === ref.sha256, `${label} digest drifted`);
  return bytes;
}

function validatePersistedReceiptEnvelope(
  receipt,
  envelopeBytes,
  step,
  record,
  label,
  envelopeRef,
) {
  assert(
    receipt.provenance?.format === "agent-mail.capture-provenance/v1",
    `${label} persisted provenance envelope is missing`,
  );
  assert(
    envelopeRef && envelopeRef.path === receipt.provenance.path,
    `${label} provenance path is not receipt-bound`,
  );
  assert(
    envelopeBytes.length === receipt.provenance.bytes &&
      digest(envelopeBytes) === receipt.provenance.sha256,
    `${label} persisted provenance digest drifted`,
  );
  let envelope;
  try {
    envelope = JSON.parse(envelopeBytes.toString("utf8"));
  } catch {
    fail(`${label} persisted provenance is not JSON`);
  }
  assert(
    envelope?.format === "agent-mail.capture-provenance/v1" &&
      envelope.runId === receipt.runId &&
      envelope.role === receipt.role,
    `${label} persisted provenance identity is detached`,
  );
  const core = structuredClone(receipt);
  delete core.provenance;
  const receiptSha256 = digest(Buffer.from(canonicalJson(core)));
  assert(
    receipt.provenance.receiptSha256 === receiptSha256 && envelope.receiptSha256 === receiptSha256,
    `${label} persisted provenance receipt digest is detached`,
  );
  const observations = {
    process: receipt.process,
    processProbe: receipt.probes?.process,
    resources: receipt.probes?.resources,
    termination: receipt.probes?.cleanup?.termination,
    cleanup: receipt.probes?.cleanup,
    streams: receipt.probes?.streams,
    monotonic: receipt.monotonic,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    result: receipt.result,
    observedOutcome: receipt.observedOutcome,
  };
  const observationsSha256 = digest(Buffer.from(canonicalJson(observations)));
  assert(
    canonicalJson(envelope.observations) === canonicalJson(observations) &&
      envelope.observationsSha256 === observationsSha256 &&
      receipt.provenance.observationsSha256 === observationsSha256,
    `${label} persisted provenance observations are detached`,
  );
  const authority = {
    candidate: receipt.candidate,
    manifestStepId: receipt.manifestStepId,
    cwd: receipt.cwd,
    argv: receipt.argv,
    sources: receipt.sources,
    runnerSources: receipt.runnerSources,
    fixture: receipt.fixture,
    assertions: receipt.assertions,
    probes: step.probes,
    thresholds: step.thresholds,
  };
  assert(
    canonicalJson(envelope.authority) === canonicalJson(authority),
    `${label} persisted provenance authority is detached`,
  );
  const output = envelope.roots?.output;
  const temporary = envelope.roots?.temporary;
  assert(
    output &&
      typeof output.path === "string" &&
      output.path.length > 0 &&
      isAbsolute(output.path) &&
      output.path === resolve(output.path) &&
      !output.path.includes("\0") &&
      Number.isSafeInteger(output.dev) &&
      Number.isSafeInteger(output.ino) &&
      output.dev >= 0 &&
      output.ino > 0,
    `${label} persisted output-root identity is missing`,
  );
  assert(
    temporary &&
      typeof temporary.path === "string" &&
      isAbsolute(temporary.path) &&
      temporary.path === resolve(temporary.path) &&
      Number.isSafeInteger(temporary.dev) &&
      Number.isSafeInteger(temporary.ino) &&
      temporary.removed === true,
    `${label} persisted temporary-root closure is missing`,
  );
  const streamRefs = {
    stdout: receipt.streams?.stdout,
    stderr: receipt.streams?.stderr,
    events: receipt.streams?.events,
    ...(receipt.fixture?.materialized?.path ? { fixture: receipt.fixture.materialized } : {}),
  };
  const seenPaths = new Set([receipt.provenance.path]);
  for (const [key, ref] of Object.entries(streamRefs)) {
    assert(
      ref && typeof ref.path === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
      `${label} ${key} persisted artifact reference is missing`,
    );
    assert(!seenPaths.has(ref.path), `${label} persisted artifact path is reused`);
    seenPaths.add(ref.path);
    const artifact = envelope.artifacts?.[key];
    assert(
      artifact &&
        artifact.path === ref.path &&
        artifact.bytes === ref.bytes &&
        artifact.sha256 === ref.sha256,
      `${label} ${key} persisted artifact is detached`,
    );
  }
  return envelope;
}

function validateV2CapacityEvidence(record, baseline, root, label) {
  const evidence = record.evidence;
  assert(evidence && typeof evidence === "object", `${label} capacity evidence is missing`);
  const subgates = evidence.subgates;
  assert(
    subgates &&
      JSON.stringify(Object.keys(subgates).sort()) ===
        JSON.stringify([...requiredCapacitySubgates].sort()),
    `${label} capacity subgate coverage is incomplete or extra`,
  );
  const aggregatePaths = [
    ...new Set(requiredCapacitySubgates.flatMap((id) => capacityManifest[id].argv.slice(2))),
  ];
  assert(
    JSON.stringify(record.argv) === JSON.stringify(["bun", "test", ...aggregatePaths]),
    `${label} capacity aggregate argv is not canonical`,
  );
  const read = (ref, refLabel) => {
    assert(
      ref && typeof ref.path === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
      `${refLabel} reference is invalid`,
    );
    const bytes = v2EvidenceRef(record, ref, root, refLabel);
    assert(digest(bytes) === ref.sha256, `${refLabel} digest drifted`);
    return JSON.parse(bytes.toString("utf8"));
  };
  const rawDigests = new Set();
  for (const id of requiredCapacitySubgates) {
    const spec = capacityManifest[id];
    const subgate = subgates[id];
    assert(
      JSON.stringify(subgate.argv) === JSON.stringify(spec.argv),
      `${label} ${id} argv drifted`,
    );
    assert(
      subgate.descriptor?.path === spec.descriptorPath &&
        /^[0-9a-f]{64}$/u.test(subgate.descriptor.sha256),
      `${label} ${id} descriptor binding is invalid`,
    );
    const descriptorBytes = regularCandidateBlob(
      record.candidateCommit,
      spec.descriptorPath,
      root,
      `${label} ${id} descriptor`,
    );
    assert(
      digest(descriptorBytes) === subgate.descriptor.sha256,
      `${label} ${id} descriptor drifted`,
    );
    assert(
      subgate.fixtureIds?.length === 1 &&
        subgate.fixtureIds[0] === spec.fixtureId &&
        subgate.fixtureDigests?.length === 1 &&
        subgate.fixtureDigests[0] === subgate.descriptor.sha256,
      `${label} ${id} fixture binding is invalid`,
    );
    finiteNonnegative(subgate.scale?.[spec.scale.key], `${label} ${id} scale`);
    assert(
      subgate.scale?.unit === spec.scale.unit &&
        subgate.scale[spec.scale.key] >= spec.scale.minimum,
      `${label} ${id} scale is below manifest minimum`,
    );
    const thresholds = new Map(
      (subgate.thresholds ?? []).map((threshold) => [threshold.metric, threshold]),
    );
    assert(
      thresholds.size === Object.keys(spec.metrics).length,
      `${label} ${id} threshold coverage is incomplete`,
    );
    for (const [metric, expected] of Object.entries(spec.metrics)) {
      const threshold = thresholds.get(metric);
      assert(
        threshold?.operator === expected.operator && threshold.unit === expected.unit,
        `${label} ${id} threshold authority drifted`,
      );
      finiteNonnegative(threshold.limit, `${label} ${id} threshold`);
    }
    assert(subgate.rawSamples?.length === 1, `${label} ${id} raw sample coverage is incomplete`);
    const sample = subgate.rawSamples[0];
    assert(!rawDigests.has(sample.sha256), `${label} ${id} raw sample is reused`);
    rawDigests.add(sample.sha256);
    const raw = read(sample, `${label} ${id} raw sample`);
    assert(
      raw.subgateId === id &&
        raw.fixtureId === spec.fixtureId &&
        raw.fixtureDigest === subgate.descriptor.sha256 &&
        raw.descriptorPath === spec.descriptorPath &&
        raw.descriptorDigest === subgate.descriptor.sha256 &&
        JSON.stringify(raw.scale) === JSON.stringify(subgate.scale),
      `${label} ${id} raw sample identity is detached`,
    );
    for (const [metric, expected] of Object.entries(spec.metrics)) {
      finiteNonnegative(raw.metrics?.[metric], `${label} ${id} raw ${metric}`);
      assert(
        evaluateThreshold(raw.metrics[metric], expected.operator, thresholds.get(metric).limit),
        `${label} ${id} raw ${metric} misses threshold`,
      );
    }
    assert(
      JSON.stringify(subgate.observations?.metrics) === JSON.stringify(raw.metrics),
      `${label} ${id} observations are detached`,
    );
    const correctness = read(subgate.artifacts?.correctness, `${label} ${id} correctness`);
    assert(
      correctness.kind === "correctness" &&
        correctness.subgateId === id &&
        correctness.candidateCommit === record.candidateCommit &&
        correctness.status === "pass",
      `${label} ${id} correctness proof is invalid`,
    );
    const resources = read(subgate.artifacts?.resources, `${label} ${id} resources`);
    assert(
      resources.kind === "resources" &&
        resources.subgateId === id &&
        resources.candidateCommit === record.candidateCommit &&
        resources.status === "pass",
      `${label} ${id} resources proof is invalid`,
    );
    for (const key of ["peak", "retained"]) {
      finiteNonnegative(resources[key]?.value, `${label} ${id} ${key} resource`);
      assert(
        resources[key].unit === spec.resources.units[key],
        `${label} ${id} ${key} unit drifted`,
      );
      finiteNonnegative(resources.limits?.[key], `${label} ${id} ${key} limit`);
      assert(
        resources.limits[key] === spec.resources.limits[key] &&
          resources[key].value <= resources.limits[key],
        `${label} ${id} ${key} limit exceeded`,
      );
    }
    const cleanup = read(subgate.artifacts?.cleanup, `${label} ${id} cleanup`);
    assert(
      cleanup.kind === "cleanup" &&
        cleanup.subgateId === id &&
        cleanup.candidateCommit === record.candidateCommit &&
        cleanup.status === "pass" &&
        JSON.stringify(Object.keys(cleanup.leaks ?? {}).sort()) ===
          JSON.stringify(["files", "listeners", "openHandles", "processes"]) &&
        Object.values(cleanup.leaks).every((value) => Number.isSafeInteger(value) && value === 0),
      `${label} ${id} cleanup proof is invalid`,
    );
  }
  assert(
    evidence.correctness?.status === "pass" && evidence.cleanup?.status === "pass",
    `${label} aggregate outcome is incomplete`,
  );
  for (const obligationId of ["F17", "F18", "F22", "F23"]) {
    const row = baseline.get(obligationId);
    if (row?.result.kind !== "blocked") continue;
    const closure = record.closure?.[obligationId];
    assert(
      closure &&
        closure.baselineSourceStatusSha256 === digest(Buffer.from(row.sourceStatus)) &&
        closure.baselineProofDigest === baselineProofDigest(row),
      `${label} ${obligationId} closure is missing`,
    );
    for (const [entryKey, contractKey] of [
      ["originalReproduction", "reproduction"],
      ["adjacentCounterexample", "counterexample"],
    ]) {
      const entry = closure[entryKey];
      assert(
        entry?.artifact && entry?.proof && Array.isArray(entry.argv),
        `${label} ${obligationId} ${entryKey} closure is incomplete`,
      );
      const artifact = read(entry.artifact, `${label} ${obligationId} ${entryKey} artifact`);
      const proof = read(entry.proof, `${label} ${obligationId} ${entryKey} proof`);
      const contract = closureSourceContracts[obligationId][contractKey];
      assert(
        artifact.candidateCommit === record.candidateCommit &&
          artifact.candidateTree === record.candidateTree &&
          artifact.obligationId === obligationId &&
          artifact.role === contractKey &&
          artifact.result === "pass" &&
          proof.candidateCommit === record.candidateCommit &&
          proof.candidateTree === record.candidateTree &&
          proof.obligationId === obligationId &&
          proof.role === contractKey &&
          proof.result === "pass" &&
          proof.receipt?.exitCode === 0 &&
          proof.receipt.assertions?.length === 1 &&
          proof.receipt.assertions[0].id === contract.assertionId &&
          proof.receipt.assertions[0].outcome === contract.outcome,
        `${label} ${obligationId} ${entryKey} closure proof is detached`,
      );
    }
  }
}

function validateV2Record(record, baseline, sequence, previousDigest, root, options = {}) {
  const label = `v2 result sequence ${record.sequence}`;
  assert(record.protocol === "agent-mail.release-evidence/v2", `${label} protocol is invalid`);
  assert(
    record.recordType === "qualification" || record.recordType === "disposition",
    `${label} record type is invalid`,
  );
  assert(
    Number.isInteger(record.sequence) && record.sequence === sequence,
    `${label} sequence is not monotonic`,
  );
  assert(
    (sequence === 1 && record.previousRecordDigest === null) ||
      (sequence > 1 && record.previousRecordDigest === previousDigest),
    `${label} hash chain is broken`,
  );
  assert(
    Number.isInteger(record.ownerIssueId) && resultOwnerAuthority[String(record.ownerIssueId)],
    `${label} owner is unauthorized`,
  );
  const ownerRule = resultOwnerAuthority[String(record.ownerIssueId)];
  if (record.recordType === "disposition") {
    assert(
      record.ownerIssueId === 184 &&
        record.mode === "disposition" &&
        record.gateId === "disposition",
      `${label} disposition is not #184-only`,
    );
    assert(
      Array.isArray(record.obligationIds) && record.obligationIds.length === 0,
      `${label} disposition claims obligations`,
    );
    assert(
      Number.isInteger(record.targetSequence) &&
        record.targetSequence > 0 &&
        /^[0-9a-f]{64}$/u.test(record.targetRecordDigest ?? "") &&
        record.targetRecordDigest !== "0".repeat(64),
      `${label} disposition target is incomplete`,
    );
    assert(
      Number.isInteger(record.targetOwnerIssueId) &&
        typeof record.targetGateId === "string" &&
        requiredGateIds.includes(record.targetGateId) &&
        /^[0-9a-f]{40}$/u.test(record.targetCandidateCommit ?? "") &&
        record.targetCandidateCommit !== "0".repeat(40) &&
        /^[0-9a-f]{40}$/u.test(record.targetCandidateTree ?? "") &&
        record.targetCandidateTree !== "0".repeat(40) &&
        /^[0-9a-f]{40}$/u.test(record.targetEvidenceCommit ?? "") &&
        record.targetEvidenceCommit !== "0".repeat(40),
      `${label} disposition target identity is incomplete`,
    );
    assert(
      typeof record.reasonCode === "string" && record.reasonCode.length > 0,
      `${label} disposition reason is missing`,
    );
    assert(
      record.result === "invalidated" && record.observedOutcome?.status === "invalidated",
      `${label} disposition outcome is invalid`,
    );
    assert(record.reviewArtifact, `${label} disposition review artifact is missing`);
    const reviewBytes = v2EvidenceRef(
      record,
      record.reviewArtifact,
      root,
      `${label} review artifact`,
    );
    let review;
    try {
      review = JSON.parse(reviewBytes.toString("utf8"));
    } catch {
      fail(`${label} review artifact is not JSON`);
    }
    assert(
      review?.kind === "disposition-review" &&
        review.status === "pass" &&
        review.ownerIssueId === 184 &&
        review.gateId === "disposition" &&
        review.targetSequence === record.targetSequence &&
        review.targetRecordDigest === record.targetRecordDigest &&
        review.targetOwnerIssueId === record.targetOwnerIssueId &&
        review.targetGateId === record.targetGateId &&
        review.targetCandidateCommit === record.targetCandidateCommit &&
        review.targetCandidateTree === record.targetCandidateTree &&
        review.targetEvidenceCommit === record.targetEvidenceCommit,
      `${label} review artifact provenance is detached`,
    );
    return ownerRule;
  }
  assert(
    record.mode === "promotion" && requiredGateIds.includes(record.gateId),
    `${label} qualification mode/gate is invalid`,
  );
  assert(ownerRule.gateIds.includes(record.gateId), `${label} owner cannot write gate`);
  assert(
    Array.isArray(record.obligationIds) && record.obligationIds.length > 0,
    `${label} qualification coverage is empty`,
  );
  for (const obligationId of record.obligationIds) {
    assert(
      ownerRule.obligationIds.includes(obligationId),
      `${label} owner cannot write ${obligationId}`,
    );
    const baselineRow = baseline.get(obligationId);
    assert(
      baselineRow && baselineRow.result.kind !== "superseded",
      `${label} obligation history is invalid`,
    );
  }
  assert(
    record.result === "pass" || record.result === "fail" || record.result === "blocked",
    `${label} result is invalid`,
  );
  assert(record.observedOutcome?.status === record.result, `${label} observed outcome is detached`);
  assert(
    /^[0-9a-f]{40}$/u.test(record.candidateCommit) && /^[0-9a-f]{40}$/u.test(record.candidateTree),
    `${label} candidate identity is invalid`,
  );
  assert(/^[0-9a-f]{40}$/u.test(record.evidenceCommit), `${label} evidence identity is invalid`);
  assert(
    gitExists(record.candidateCommit, "", root) && gitExists(record.evidenceCommit, "", root),
    `${label} commit is missing`,
  );
  const candidateTree = execFileSync("git", ["rev-parse", `${record.candidateCommit}^{tree}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert(candidateTree === record.candidateTree, `${label} candidate tree drifted`);
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", record.candidateCommit, record.evidenceCommit],
      { cwd: root, stdio: "ignore" },
    );
  } catch {
    fail(`${label} candidate is not ancestor of evidence commit`);
  }
  const evidenceParents = execFileSync(
    "git",
    ["rev-list", "--parents", "-n", "1", record.evidenceCommit],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split(/\s+/u);
  assert(evidenceParents.length === 2, `${label} evidence commit is not a first-parent append`);
  assert(
    record.manifest?.path === "docs/architecture/release-evidence-execution-manifest.v2.json",
    `${label} manifest path is not canonical`,
  );
  const manifestBytes = regularCandidateBlob(
    record.candidateCommit,
    record.manifest.path,
    root,
    `${label} manifest`,
  );
  assert(digest(manifestBytes) === record.manifest.sha256, `${label} manifest digest drifted`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateExecutionManifest(manifest, root, record.candidateCommit);
  if (record.gateId === "capacity") validateV2CapacityEvidence(record, baseline, root, label);
  assert(
    Array.isArray(record.primaryReceipt) && record.primaryReceipt.length > 0,
    `${label} primary receipt is missing`,
  );
  assert(
    Array.isArray(record.replayReceipt) && record.replayReceipt.length > 0,
    `${label} replay receipt is missing`,
  );
  const receipts = [];
  for (const [role, refs] of [
    ["primary", record.primaryReceipt],
    ["independent-replay", record.replayReceipt],
  ]) {
    for (const ref of refs) {
      const bytes = v2EvidenceRef(record, ref, root, `${label} ${role} receipt`);
      const receipt = JSON.parse(bytes.toString("utf8"));
      const step = manifest.steps.find((candidate) => candidate.id === receipt.manifestStepId);
      assert(step, `${label} receipt step is not in manifest`);
      assert(receipt.role === role, `${label} receipt role is detached`);
      assert(
        receipt.candidate?.commit === record.candidateCommit &&
          receipt.candidate?.tree === record.candidateTree &&
          receipt.candidate?.manifestPath === record.manifest.path &&
          receipt.candidate?.manifestSha256 === record.manifest.sha256,
        `${label} ${role} receipt candidate is detached from enclosing record`,
      );
      const eventBytes = v2EvidenceRef(
        record,
        receipt.streams?.events,
        root,
        `${label} ${role} ${receipt.manifestStepId} event stream`,
      );
      validateExecutableReceipt(receipt, manifest, step, {
        repositoryRoot: root,
        eventBytes,
      });
      assert(
        receipt.provenance &&
          typeof receipt.provenance.path === "string" &&
          /^[0-9a-f]{64}$/u.test(receipt.provenance.sha256),
        `${label} ${role} receipt provenance is not persisted`,
      );
      const envelopeRef = {
        path: receipt.provenance.path,
        sha256: receipt.provenance.sha256,
      };
      const envelopeBytes = v2EvidenceRef(
        record,
        envelopeRef,
        root,
        `${label} ${role} provenance envelope`,
      );
      validatePersistedReceiptEnvelope(
        receipt,
        envelopeBytes,
        step,
        record,
        `${label} ${role} ${receipt.manifestStepId}`,
        envelopeRef,
      );
      for (const [artifactKey, artifactRef] of Object.entries({
        ...receipt.streams,
        ...(receipt.fixture?.materialized?.path ? { fixture: receipt.fixture.materialized } : {}),
      })) {
        const artifactBytes = v2EvidenceRef(
          record,
          artifactRef,
          root,
          `${label} ${role} ${receipt.manifestStepId} ${artifactKey} artifact`,
        );
        assert(
          artifactBytes.length === artifactRef.bytes &&
            digest(artifactBytes) === artifactRef.sha256,
          `${label} ${role} ${receipt.manifestStepId} ${artifactKey} artifact drifted`,
        );
      }
      receipts.push(receipt);
    }
  }
  assert(
    receipts.some((receipt) => receipt.role === "primary") &&
      receipts.some((receipt) => receipt.role === "independent-replay"),
    `${label} replay coverage is incomplete`,
  );
  const primary = receipts.find((receipt) => receipt.role === "primary");
  const replay = receipts.find((receipt) => receipt.role === "independent-replay");
  for (const key of ["commit", "tree", "manifestPath", "manifestSha256"])
    assert(primary.candidate[key] === replay.candidate[key], `${label} replay ${key} diverged`);
  assert(
    primary.runId !== replay.runId && primary.result === "pass" && replay.result === "pass",
    `${label} independent replay did not pass`,
  );
  if (record.ownerIssueId === 176 && record.gateId === "capacity") {
    const expectedObligations = ["F17", "F18", "F22", "F23", "F30", "SEC-R03", "S04", "S05"];
    assert(
      JSON.stringify([...record.obligationIds].sort((a, b) => a.localeCompare(b))) ===
        JSON.stringify([...expectedObligations].sort((a, b) => a.localeCompare(b))),
      `${label} #176 capacity obligation coverage is not definitive`,
    );
    const expectedSteps = manifest.steps.map((step) => step.id);
    for (const [role, roleReceipts] of [
      ["primary", record.primaryReceipt],
      ["independent-replay", record.replayReceipt],
    ]) {
      assert(
        roleReceipts.length === expectedSteps.length &&
          JSON.stringify(
            roleReceipts.map((ref) => {
              const bytes = v2EvidenceRef(record, ref, root, `${label} ${role} receipt`);
              return JSON.parse(bytes.toString("utf8")).manifestStepId;
            }),
          ) === JSON.stringify(expectedSteps),
        `${label} ${role} does not cover every manifest step`,
      );
    }
  }
  assert(record.bundle, `${label} bundle is missing`);
  const bundleBytes = v2EvidenceRef(record, record.bundle, root, `${label} bundle`);
  const bundle = JSON.parse(bundleBytes.toString("utf8"));
  assert(
    bundle.protocol === "agent-mail.release-evidence-bundle/v2" &&
      bundle.record?.sequence === record.sequence,
    `${label} bundle projection is detached`,
  );
  assert(
    JSON.stringify(bundle.record) ===
      JSON.stringify({
        protocol: record.protocol,
        recordType: record.recordType,
        sequence: record.sequence,
        previousRecordDigest: record.previousRecordDigest,
        ownerIssueId: record.ownerIssueId,
        mode: record.mode,
        gateId: record.gateId,
        obligationIds: record.obligationIds,
        candidateCommit: record.candidateCommit,
        candidateTree: record.candidateTree,
      }),
    `${label} bundle record projection is incomplete`,
  );
  return ownerRule;
}

function validateResultRecords(indexData, baselineRows, options = {}) {
  assert(Array.isArray(indexData.resultRecords), "resultRecords must be append-only array");
  const baseline = new Map(baselineRows.map((row) => [row.id, row]));
  const seenTargets = new Set();
  const seenCorrections = new Set();
  let previousDigest = null;
  const validationRoot = options.repositoryRoot ?? repositoryRoot;
  const evidenceHead = options.repositoryRoot
    ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: validationRoot, encoding: "utf8" }).trim()
    : currentCommit();
  let priorRecords = [];
  if (!options.allowEmptyBaseline) {
    try {
      const priorIndex = JSON.parse(
        execFileSync("git", ["show", `HEAD:${indexPath.slice(repositoryRoot.length + 1)}`], {
          cwd: validationRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      priorRecords = Array.isArray(priorIndex.resultRecords) ? priorIndex.resultRecords : [];
    } catch {
      priorRecords = [];
    }
  }
  assert(
    indexData.resultRecords.length >= priorRecords.length,
    "result record history was deleted",
  );
  for (let priorIndex = 0; priorIndex < priorRecords.length; priorIndex += 1) {
    assert(
      JSON.stringify(indexData.resultRecords[priorIndex]) ===
        JSON.stringify(priorRecords[priorIndex]),
      "result record prefix was rewritten or reordered",
    );
  }
  const dirtyPaths = execFileSync("git", ["status", "--short"], {
    cwd: validationRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  for (let recordIndex = 0; recordIndex < indexData.resultRecords.length; recordIndex += 1) {
    const record = indexData.resultRecords[recordIndex];
    assert(
      record.protocol !== "legacy-v1",
      `result sequence ${record.sequence ?? recordIndex + 1} legacy v1 records are inactive`,
    );
    const ownerRule =
      record.protocol === "agent-mail.release-evidence/v2"
        ? validateV2Record(
            record,
            baseline,
            recordIndex + 1,
            previousDigest,
            validationRoot,
            options,
          )
        : validateBundleRecord(
            record,
            baseline,
            recordIndex + 1,
            previousDigest,
            validationRoot,
            options,
          );
    if (
      record.protocol === "agent-mail.release-evidence/v2" &&
      record.recordType === "disposition"
    ) {
      const target = indexData.resultRecords[record.targetSequence - 1];
      assert(
        target?.protocol === "agent-mail.release-evidence/v2" &&
          target.recordType === "qualification",
        `v2 disposition ${record.sequence} target is not a qualification`,
      );
      assert(
        record.targetSequence < record.sequence,
        `v2 disposition ${record.sequence} targets a future record`,
      );
      assert(
        record.targetRecordDigest === recordDigest(target),
        `v2 disposition ${record.sequence} target digest is detached`,
      );
      for (const [dispositionKey, targetKey] of [
        ["targetOwnerIssueId", "ownerIssueId"],
        ["targetGateId", "gateId"],
        ["targetCandidateCommit", "candidateCommit"],
        ["targetCandidateTree", "candidateTree"],
        ["targetEvidenceCommit", "evidenceCommit"],
      ]) {
        assert(
          record[dispositionKey] === target[targetKey],
          `v2 disposition ${record.sequence} ${dispositionKey} diverged`,
        );
      }
      if (record.correctedFromSequence !== undefined) {
        assert(
          record.correctedFromSequence === record.targetSequence &&
            record.correctedFromRecordDigest === record.targetRecordDigest,
          `v2 disposition ${record.sequence} corrected rerun target is detached`,
        );
      }
      assert(
        !indexData.resultRecords
          .slice(0, recordIndex)
          .some(
            (candidate) =>
              candidate.protocol === "agent-mail.release-evidence/v2" &&
              candidate.recordType === "disposition" &&
              candidate.targetSequence === record.targetSequence,
          ),
        `v2 disposition ${record.sequence} targets a record twice`,
      );
    }
    if (
      record.protocol === "agent-mail.release-evidence/v2" &&
      record.recordType === "qualification" &&
      options.mode !== "prospective" &&
      !options.bundleCommit &&
      !options.diffCommit
    ) {
      const evidenceParent = execFileSync("git", ["rev-parse", `${record.evidenceCommit}^`], {
        cwd: validationRoot,
        encoding: "utf8",
      }).trim();
      assert(
        evidenceParent === record.candidateCommit,
        `result sequence ${record.sequence} evidence commit is not a direct evidence append`,
      );
      if (recordIndex === indexData.resultRecords.length - 1) {
        const indexParents = execFileSync(
          "git",
          ["rev-list", "--parents", "-n", "1", evidenceHead],
          { cwd: validationRoot, encoding: "utf8" },
        )
          .trim()
          .split(/\s+/u);
        assert(
          indexParents.length === 2,
          `result sequence ${record.sequence} index commit is not a one-parent append`,
        );
        const indexParent = execFileSync("git", ["rev-parse", `${evidenceHead}^`], {
          cwd: validationRoot,
          encoding: "utf8",
        }).trim();
        assert(
          indexParent === record.evidenceCommit,
          `result sequence ${record.sequence} index commit is not the evidence child`,
        );
        const indexChanges = execFileSync(
          "git",
          ["diff", "--name-only", `${record.evidenceCommit}..${evidenceHead}`],
          { cwd: validationRoot, encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        assert(
          JSON.stringify(indexChanges) ===
            JSON.stringify(["docs/architecture/release-evidence-index.v1.json"]),
          `result sequence ${record.sequence} index commit is not index-only`,
        );
      }
    }
    if (
      record.protocol === "agent-mail.release-evidence/v2" &&
      record.recordType === "qualification"
    ) {
      const priorDispositions = indexData.resultRecords
        .slice(0, recordIndex)
        .filter(
          (candidate) =>
            candidate.protocol === "agent-mail.release-evidence/v2" &&
            candidate.recordType === "disposition" &&
            candidate.gateId === "disposition",
        );
      const revokedTargets = priorDispositions.filter(
        (disposition) =>
          disposition.targetSequence > 0 &&
          indexData.resultRecords[disposition.targetSequence - 1]?.obligationIds?.some((id) =>
            record.obligationIds.includes(id),
          ),
      );
      if (revokedTargets.length > 0) {
        assert(
          revokedTargets.length === 1 &&
            Number.isInteger(record.correctedFromSequence) &&
            record.correctedFromSequence === revokedTargets[0].targetSequence &&
            record.correctedFromRecordDigest === revokedTargets[0].targetRecordDigest,
          `v2 corrected qualification ${record.sequence} is not digest-bound to its revocation`,
        );
      } else if (record.correctedFromSequence !== undefined) {
        const correction = indexData.resultRecords[record.correctedFromSequence - 1];
        assert(
          correction?.protocol === "agent-mail.release-evidence/v2" &&
            correction.recordType === "disposition" &&
            correction.targetRecordDigest === record.correctedFromRecordDigest,
          `v2 corrected qualification ${record.sequence} targets an inactive record`,
        );
      }
    }
    if (options.mode !== "prospective" && !options.bundleCommit) {
      assert(
        record.evidenceCommit === evidenceHead ||
          (() => {
            try {
              execFileSync(
                "git",
                ["merge-base", "--is-ancestor", record.evidenceCommit, evidenceHead],
                { cwd: validationRoot, stdio: "ignore" },
              );
              return true;
            } catch {
              return false;
            }
          })(),
        `result sequence ${record.sequence} evidence commit is not durable at current HEAD`,
      );
    }
    if (recordIndex >= priorRecords.length) {
      const allowedDirtyPaths = new Set([
        indexPath.slice(repositoryRoot.length + 1),
        ...(record.bundle?.path ? [record.bundle.path] : []),
        ...(record.manifest?.path ? [record.manifest.path] : []),
        ...(record.primaryReceipt ?? []).map((ref) => ref.path),
        ...(record.replayReceipt ?? []).map((ref) => ref.path),
        ...(record.reviewArtifact?.path ? [record.reviewArtifact.path] : []),
        ...Object.values(record.evidence?.subgates ?? {}).flatMap((subgate) =>
          (subgate.rawSamples ?? []).map((sample) => sample.path),
        ),
      ]);
      for (const subgate of Object.values(record.evidence?.subgates ?? {})) {
        for (const artifact of Object.values(subgate.artifacts ?? {})) {
          if (artifact?.path) allowedDirtyPaths.add(artifact.path);
        }
      }
      for (const closure of Object.values(record.closure ?? {})) {
        for (const entry of [closure.originalReproduction, closure.adjacentCounterexample]) {
          if (entry?.artifact?.path) allowedDirtyPaths.add(entry.artifact.path);
          if (entry?.proof?.path) allowedDirtyPaths.add(entry.proof.path);
        }
      }
      assert(
        options.repositoryRoot || dirtyPaths.every((path) => allowedDirtyPaths.has(path)),
        `result sequence ${record.sequence} has dirty implementation or checker state`,
      );
    }
    const changed = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        `${record.candidateCommit}..${options.diffCommit ?? record.evidenceCommit}`,
      ],
      { cwd: validationRoot, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const allowed = new Set([
      ...(record.bundle?.path ? [record.bundle.path] : []),
      ...(record.primaryReceipt ?? []).map((ref) => ref.path),
      ...(record.replayReceipt ?? []).map((ref) => ref.path),
      ...(record.reviewArtifact?.path ? [record.reviewArtifact.path] : []),
    ]);
    if (record.evidence?.subgates) {
      for (const subgate of Object.values(record.evidence.subgates)) {
        for (const sample of subgate.rawSamples ?? []) allowed.add(sample.path);
        for (const artifact of Object.values(subgate.artifacts ?? {}))
          if (artifact?.path) allowed.add(artifact.path);
      }
    }
    for (const receiptRef of [...(record.primaryReceipt ?? []), ...(record.replayReceipt ?? [])]) {
      try {
        const receipt = JSON.parse(
          v2EvidenceRef(
            record,
            receiptRef,
            validationRoot,
            `result sequence ${record.sequence} receipt`,
          ).toString("utf8"),
        );
        if (receipt.provenance?.path) allowed.add(receipt.provenance.path);
        for (const stream of Object.values(receipt.streams ?? {}))
          if (stream?.path) allowed.add(stream.path);
        if (receipt.fixture?.materialized?.path) allowed.add(receipt.fixture.materialized.path);
      } catch {
        // The record validator reports malformed or missing persisted receipts.
      }
    }
    for (const closure of Object.values(record.closure ?? {})) {
      for (const entry of [closure.originalReproduction, closure.adjacentCounterexample]) {
        if (entry?.artifact?.path) allowed.add(entry.artifact.path);
        if (entry?.proof?.path) allowed.add(entry.proof.path);
      }
    }
    assert(
      changed.every((path) => allowed.has(path)),
      `result sequence ${record.sequence} evidence commit mixes implementation or checker changes`,
    );
    if (
      record.protocol === "agent-mail.release-evidence/v2" &&
      record.recordType === "qualification" &&
      options.mode !== "prospective" &&
      !options.bundleCommit &&
      !options.diffCommit
    ) {
      assert(
        !changed.includes("docs/architecture/release-evidence-index.v1.json"),
        `result sequence ${record.sequence} evidence commit includes the index`,
      );
    }
    for (const obligationId of record.obligationIds) {
      const target = `${record.gateId}:${obligationId}`;
      if (seenTargets.has(target)) {
        const correctionKey = `${target}:${record.correctedFromSequence ?? ""}`;
        assert(
          record.protocol === "agent-mail.release-evidence/v2" &&
            record.recordType === "qualification" &&
            Number.isInteger(record.correctedFromSequence) &&
            record.correctedFromRecordDigest &&
            !seenCorrections.has(correctionKey),
          `result sequence ${record.sequence} duplicates ${target}`,
        );
        seenCorrections.add(correctionKey);
      } else {
        seenTargets.add(target);
      }
      assert(
        ownerRule.obligationIds.includes(obligationId),
        `result sequence ${record.sequence} crosses owner scope`,
      );
    }
    previousDigest = recordDigest(record);
  }
  return indexData.resultRecords;
}

function applyResultRecords(baseRows, baseGates, records) {
  const rows = structuredClone(baseRows);
  const gates = structuredClone(baseGates);
  const revoked = new Set(
    records
      .filter(
        (record) =>
          record.protocol === "agent-mail.release-evidence/v2" &&
          record.recordType === "disposition",
      )
      .map((record) => record.targetSequence),
  );
  for (const record of records) {
    if (
      record.result !== "pass" ||
      revoked.has(record.sequence) ||
      record.protocol === "legacy-v1" ||
      record.recordType === "disposition"
    )
      continue;
    for (const obligationId of record.obligationIds) {
      const row = rows.find((candidate) => candidate.id === obligationId);
      row.evidence[record.gateId] = "locally verified";
    }
  }
  for (const gate of gates) {
    const owners = gateResultAuthority[gate.id] ?? [];
    const complete = owners.every((issueId) => {
      const rule = resultOwnerAuthority[String(issueId)];
      const covered = new Set(
        records
          .filter(
            (record) =>
              record.protocol !== "legacy-v1" &&
              !revoked.has(record.sequence) &&
              record.ownerIssueId === issueId &&
              record.gateId === gate.id &&
              record.mode === "promotion" &&
              record.result === "pass",
          )
          .flatMap((record) => record.obligationIds),
      );
      return rule.prerequisites
        ? requiredGateIds
            .filter((id) => id !== "delivery")
            .every((id) => gates.find((candidate) => candidate.id === id)?.status !== "unverified")
        : rule.closureOnly
          ? covered.size === 0 &&
            records.some(
              (record) =>
                record.protocol !== "legacy-v1" &&
                !revoked.has(record.sequence) &&
                record.ownerIssueId === issueId &&
                record.gateId === gate.id &&
                record.result === "pass",
            )
          : rule.obligationIds.every((obligationId) => covered.has(obligationId));
    });
    if (complete) {
      const recordIds = records
        .filter(
          (record) =>
            record.protocol !== "legacy-v1" &&
            !revoked.has(record.sequence) &&
            record.gateId === gate.id &&
            record.mode === "promotion" &&
            record.result === "pass",
        )
        .map((record) => record.sequence);
      gate.status = "locally verified";
      gate.result = { kind: "retained-records", status: "locally verified", recordIds };
    }
  }
  return { rows, gates, promotion: promotionState(rows, gates) };
}

function promotionState(rows, gates) {
  const verified = (status) =>
    ["locally verified", "live verified", "deployed verified", "release-ready"].includes(status);
  const has = (ids) => ids.every((id) => verified(gates.find((gate) => gate.id === id)?.status));
  const local = has(["static", "isolated", "composed", "capacity"]);
  const live = local && has(["liveRead", "liveMutation"]);
  const deployed = live && has(["deployedOperations"]);
  const releaseReady =
    rows.every((row) => row.status === "release-ready") &&
    gates.every((gate) => gate.status === "release-ready");
  return {
    local: local ? "locally verified" : "unverified",
    live: live ? "live verified" : "unverified",
    deployed: deployed ? "deployed verified" : "unverified",
    releaseReady,
  };
}

export function materializeCurrent(index) {
  return applyResultRecords(index.rows, index.gates, index.resultRecords ?? []);
}

function baselineRows(authority) {
  if (immutableRowsCache) return immutableRowsCache;
  immutableRowsCache = [...authority.findingRows.values(), ...authority.shields.values()].map(
    (source) => {
      const fields = expectedFields(source);
      const result = resultFor(source, fields);
      return {
        id: source.id,
        owner: fields.owner,
        ownerIssues: fields.ownerIssues,
        proofClass: expectedProofClass(result),
        status: expectedRowStatus(fields),
        sourceStatus: fields.status,
        sourceProblem: fields.problem,
        sourceInvariant: fields.invariant,
        sourceControl: fields.control,
        sourceProof: fields.proof,
        artifact: result.ref,
        result,
        evidence: expectedEvidence(source, result),
      };
    },
  );
  return immutableRowsCache;
}

function baselineGates() {
  if (immutableGatesCache) return immutableGatesCache;
  const planText = readFileSync(join(repositoryRoot, "PLAN.md"), "utf8");
  const labels = new Map([
    ["static", "Static"],
    ["isolated", "Isolated"],
    ["composed", "Composed"],
    ["capacity", "Capacity"],
    ["liveRead", "Live read"],
    ["liveMutation", "Live mutation"],
    ["security", "Security"],
    ["deployedOperations", "Deployed operations"],
    ["delivery", "Delivery"],
  ]);
  immutableGatesCache = requiredGateIds.map((id) => {
    const label = labels.get(id);
    const cells = planText
      .split("\n")
      .find((line) => line.startsWith(`| ${label} |`))
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    return {
      id,
      label,
      requiredEvidence: cells[1],
      notProven: cells[2],
      source: "PLAN.md#Evidence tiers and promotion",
      status: "unverified",
      result: {
        kind: "unverified",
        reason:
          "No retained result for this release gate is recorded in the current planning authority.",
        ownerIssueIds: [],
      },
    };
  });
  return immutableGatesCache;
}

function checkFrozenInputs(index) {
  assert(
    Array.isArray(index.frozenInputs) && index.frozenInputs.length === canonicalFrozenPaths.size,
    "frozen input inventory changed",
  );
  const seen = new Set();
  for (const input of index.frozenInputs) {
    assert(canonicalFrozenPaths.has(input?.id), `unknown frozen input ID ${input?.id}`);
    assert(!seen.has(input.id), `duplicate frozen input ${input.id}`);
    seen.add(input.id);
    assert(input.path === canonicalFrozenPaths.get(input.id), `${input.id} path is not canonical`);
    assert(/^[0-9a-f]{64}$/u.test(input.sha256), `${input.id} digest is invalid`);
    assert(
      digest(readFileSync(join(repositoryRoot, input.path))) === input.sha256,
      `${input.id} digest drifted`,
    );
  }
  for (const id of canonicalFrozenPaths.keys()) assert(seen.has(id), `missing frozen input ${id}`);
}

function checkExecutionManifest(index) {
  assert(
    index.executionManifest?.path ===
      "docs/architecture/release-evidence-execution-manifest.v2.json",
    "execution manifest path is not canonical",
  );
  assert(
    index.executionManifest?.format === "agent-mail.release-evidence-execution-manifest/v2" &&
      index.executionManifest.ownerIssueId === 176 &&
      index.executionManifest.replayRequired === true,
    "execution manifest authority is incomplete",
  );
  const manifest = readJson(executionManifestPath);
  assert(
    manifest.authority?.planSha256 ===
      "15fbc0806a52c8a0ae9e46f855360a775e9a78f46fad7e1919a6135b78b3cc72" &&
      manifest.authority?.evidenceSha256 ===
        "a141f641cf9254ca04f91c3084419094dc6d8169c3f8f0e0ad26c79f53437fc9",
    "execution manifest planning authority drifted",
  );
  validateExecutionManifest(manifest, repositoryRoot, currentCommit());
  assert(
    index.executionManifest.sha256 === digest(readFileSync(executionManifestPath)),
    "execution manifest digest drifted",
  );
  assert(
    index.legacyV1Projection?.status === "inactive" &&
      typeof index.legacyV1Projection.reason === "string" &&
      index.legacyV1Projection.reason.includes("cannot promote"),
    "legacy v1 projection is not explicitly inactive",
  );
}

function assertReceiptPath(ref, label) {
  assert(
    ref && typeof ref.path === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
    `${label} reference is invalid`,
  );
  assert(
    !ref.path.startsWith("/") &&
      !ref.path.includes("\\") &&
      ref.path.split("/").every((part) => part && part !== "." && part !== ".."),
    `${label} path is not normalized`,
  );
}

function receiptSafeCount(value, label) {
  assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a safe nonnegative integer`);
}

function receiptNs(value, label) {
  assert(/^\d+$/u.test(value ?? ""), `${label} must be an unsigned integer`);
  return BigInt(value);
}

function validateReceiptIntervals(receipt, label) {
  const monotonic = receipt.monotonic;
  assert(Array.isArray(monotonic?.intervals), `${label} monotonic intervals are missing`);
  const expectedIds = ["setup", "execution", "retention-and-cleanup"];
  assert(
    monotonic.intervals.length === expectedIds.length &&
      monotonic.intervals.every((interval, index) => interval?.id === expectedIds[index]),
    `${label} monotonic interval inventory is invalid`,
  );
  const intervals = monotonic.intervals.map((interval, index) => {
    const startedNs = receiptNs(interval.startedNs, `${label} ${expectedIds[index]} start`);
    const completedNs = receiptNs(
      interval.completedNs,
      `${label} ${expectedIds[index]} completion`,
    );
    const durationNs = receiptNs(interval.durationNs, `${label} ${expectedIds[index]} duration`);
    assert(completedNs > startedNs, `${label} ${expectedIds[index]} interval is empty`);
    assert(
      completedNs - startedNs === durationNs,
      `${label} ${expectedIds[index]} duration equation is invalid`,
    );
    return { startedNs, completedNs, durationNs };
  });
  for (let index = 1; index < intervals.length; index += 1)
    assert(
      intervals[index - 1].completedNs <= intervals[index].startedNs,
      `${label} monotonic intervals overlap`,
    );
  const startedNs = receiptNs(monotonic.startedNs, `${label} monotonic start`);
  const completedNs = receiptNs(monotonic.completedNs, `${label} monotonic completion`);
  const durationNs = receiptNs(monotonic.durationNs, `${label} process duration`);
  const aggregateDurationNs = receiptNs(
    monotonic.aggregateDurationNs,
    `${label} aggregate duration`,
  );
  const intervalSum = intervals.reduce((sum, interval) => sum + interval.durationNs, 0n);
  assert(startedNs === intervals[0].startedNs, `${label} monotonic start is detached`);
  assert(completedNs === intervals.at(-1).completedNs, `${label} monotonic completion is detached`);
  assert(completedNs - startedNs === aggregateDurationNs, `${label} aggregate span is invalid`);
  assert(intervalSum === aggregateDurationNs, `${label} aggregate duration is invalid`);
  assert(durationNs === intervals[1].durationNs, `${label} execution duration is detached`);
}

function validateReceiptResources(receipt, step, label) {
  const resources = receipt.probes?.resources;
  const processSamples = receipt.probes?.process?.samples;
  assert(resources && typeof resources === "object", `${label} resource probe is missing`);
  assert(
    Array.isArray(processSamples),
    `${label} process samples are missing for resource binding`,
  );
  assert(typeof resources.observed === "boolean", `${label} resource availability is invalid`);
  assert(
    Array.isArray(resources.samples) && resources.samples.length >= 2,
    `${label} resource samples are incomplete`,
  );
  assert(
    resources.samples.length === processSamples.length,
    `${label} resource/process sample alignment is incomplete`,
  );
  const resourceKeys = ["fileDescriptors", "sockets", "listeners"];
  const observedSamples = [];
  const samplePids = new Set();
  const processTrackedPids = new Set(processSamples.flatMap((sample) => sample?.pids ?? []));
  assert(processTrackedPids.size > 0, `${label} process-derived PID inventory is empty`);
  for (const [index, sample] of resources.samples.entries()) {
    assert(sample && typeof sample === "object", `${label} resource sample ${index} is invalid`);
    assert(
      typeof sample.observed === "boolean",
      `${label} resource sample ${index} availability is invalid`,
    );
    assert(Array.isArray(sample.pids), `${label} resource sample ${index} PIDs are missing`);
    const pids = new Set();
    for (const pid of sample.pids) {
      assert(
        Number.isSafeInteger(pid) && pid > 1 && !pids.has(pid),
        `${label} resource sample ${index} PID is invalid`,
      );
      pids.add(pid);
      samplePids.add(pid);
      assert(
        processTrackedPids.has(pid),
        `${label} resource sample ${index} PID is not process-bound`,
      );
    }
    for (const key of resourceKeys) {
      if (sample.observed)
        receiptSafeCount(sample[key], `${label} resource sample ${index} ${key}`);
      else assert(sample[key] === null, `${label} unavailable ${key} sample is forged`);
    }
    assert(
      Array.isArray(sample.hermesPorts),
      `${label} resource sample ${index} Hermes ports are invalid`,
    );
    assert(
      new Set(sample.hermesPorts).size === sample.hermesPorts.length &&
        sample.hermesPorts.every(
          (port) => Number.isSafeInteger(port) && port >= 6110 && port <= 6119,
        ),
      `${label} resource sample ${index} Hermes ports are invalid`,
    );
    if (sample.observed) observedSamples.push(sample);
  }
  assert(
    resources.observed === observedSamples.length > 0,
    `${label} resource availability is detached`,
  );
  assert(
    JSON.stringify([...samplePids].sort((left, right) => left - right)) ===
      JSON.stringify([...new Set(resources.pids)].sort((left, right) => left - right)) &&
      JSON.stringify([...samplePids].sort((left, right) => left - right)) ===
        JSON.stringify([...processTrackedPids].sort((left, right) => left - right)),
    `${label} resource PID inventory is detached`,
  );
  for (const key of resourceKeys) {
    const values = observedSamples.map((sample) => sample[key]);
    const expectedMaximum = values.length > 0 ? Math.max(...values) : null;
    assert(resources[key] === expectedMaximum, `${label} resource ${key} summary is detached`);
  }
  const hermesPorts = [...new Set(observedSamples.flatMap((sample) => sample.hermesPorts))].sort(
    (left, right) => left - right,
  );
  assert(
    JSON.stringify(resources.hermesPorts) === JSON.stringify(hermesPorts),
    `${label} Hermes summary is detached`,
  );
  const declaredProbes = new Set(step.probes ?? []);
  const requiredResourceProbe = ["fileDescriptors", "sockets", "listeners"].find((probe) =>
    declaredProbes.has(probe),
  );
  if (requiredResourceProbe) {
    assert(resources.observed, `${label} ${requiredResourceProbe} probe is unavailable`);
    assert(
      resources.samples.length === receipt.probes.process.samples.length,
      `${label} resource sampling is incomplete`,
    );
    const threshold = step.thresholds?.[requiredResourceProbe];
    if (threshold) {
      assert(
        evaluateThreshold(resources[requiredResourceProbe], threshold.operator, threshold.limit),
        `${label} ${requiredResourceProbe} threshold failed`,
      );
    }
  }
  if (declaredProbes.has("HermesLease")) {
    assert(
      resources.observed && resources.hermesPorts.length > 0,
      `${label} Hermes probe is unavailable`,
    );
  }
}

function validateReceiptProcess(receipt, step, label) {
  const process = receipt.probes?.process;
  assert(process && typeof process === "object", `${label} process probe is missing`);
  assert(typeof process.observed === "boolean", `${label} process availability is invalid`);
  assert(
    Array.isArray(process.samples) && process.samples.length >= 2,
    `${label} process samples are incomplete`,
  );
  const observedRss = [];
  for (const [index, sample] of process.samples.entries()) {
    assert(sample && typeof sample === "object", `${label} process sample ${index} is invalid`);
    assert(
      typeof sample.rootPresent === "boolean",
      `${label} process sample ${index} root state is invalid`,
    );
    if (sample.rootPresent) {
      assert(sample.rssStatus === "observed", `${label} observed RSS status is invalid`);
      assert(
        Number.isSafeInteger(sample.rssBytes) && sample.rssBytes >= 0,
        `${label} observed RSS is invalid`,
      );
      observedRss.push(sample.rssBytes);
    } else {
      assert(
        sample.rssStatus === "notApplicable" && sample.rssBytes === null,
        `${label} exited RSS is forged`,
      );
    }
    assert(Array.isArray(sample.pids), `${label} process sample ${index} PIDs are missing`);
    assert(
      Array.isArray(sample.processGroups),
      `${label} process sample ${index} process groups are missing`,
    );
  }
  assert(
    process.observed === process.samples.some((sample) => sample.rootPresent),
    `${label} process availability is detached`,
  );
  const terminal = process.samples.at(-1);
  assert(!terminal.rootPresent, `${label} process terminal sample still has a root`);
  assert(
    JSON.stringify(process.descendants) === JSON.stringify(terminal.descendants),
    `${label} terminal descendants are detached`,
  );
  if (process.rssStatus === "observed") {
    assert(
      Number.isSafeInteger(process.peakRssBytes) && process.peakRssBytes >= 0,
      `${label} peak RSS is invalid`,
    );
    assert(process.rssBytes === process.peakRssBytes, `${label} RSS summary is detached`);
    assert(process.peakRssBytes === Math.max(...observedRss), `${label} peak RSS is forged`);
  } else {
    assert(
      process.rssStatus === "notApplicable" &&
        process.rssBytes === null &&
        process.peakRssBytes === null,
      `${label} RSS status is invalid`,
    );
  }
  if (new Set(step.probes ?? []).has("processTreeRss")) {
    assert(
      process.observed && process.rssStatus === "observed",
      `${label} processTreeRss probe is unavailable`,
    );
    const threshold = step.thresholds?.processRssBytes;
    if (threshold)
      assert(
        evaluateThreshold(process.peakRssBytes, threshold.operator, threshold.limit),
        `${label} process RSS threshold failed`,
      );
  }
}

function validateReceiptCleanup(receipt, label) {
  const cleanup = receipt.probes?.cleanup;
  assert(cleanup && typeof cleanup === "object", `${label} cleanup probe is missing`);
  assert(
    cleanup.barrier === "awaited-idempotent" && cleanup.invocations === 1,
    `${label} cleanup barrier is invalid`,
  );
  assert(cleanup.executionRootRemoved === true, `${label} execution root was not removed`);
  assert(
    Array.isArray(cleanup.survivorsAfterKill) && cleanup.survivorsAfterKill.length === 0,
    `${label} cleanup survivors are present`,
  );
  assert(
    Array.isArray(cleanup.descendantsBeforeRemoval) &&
      cleanup.descendantsBeforeRemoval.length === 0,
    `${label} cleanup descendants are present`,
  );
  const termination = cleanup.termination;
  assert(termination && typeof termination === "object", `${label} termination receipt is missing`);
  assert(
    termination.sigtermSent === true && typeof termination.sigkillSent === "boolean",
    `${label} termination signals are invalid`,
  );
  assert(
    Array.isArray(termination.survivorsBeforeKill),
    `${label} termination pre-kill survivors are invalid`,
  );
  assert(
    Array.isArray(termination.survivorsAfterKill) && termination.survivorsAfterKill.length === 0,
    `${label} terminal survivors are present`,
  );
  assert(termination.completed === true, `${label} termination completion is forged`);
  assert(
    JSON.stringify(cleanup.survivorsAfterKill) === JSON.stringify(termination.survivorsAfterKill),
    `${label} cleanup termination binding is detached`,
  );
}

function validateReceiptRuntimeEvidence(receipt, step, label) {
  validateReceiptIntervals(receipt, label);
  validateReceiptProcess(receipt, step, label);
  validateReceiptResources(receipt, step, label);
  const declaredProbes = new Set(step.probes ?? []);
  if (declaredProbes.has("streams") || declaredProbes.has("streamCompletion")) {
    assert(receipt.probes?.streams?.observed === true, `${label} stream probe is unavailable`);
    for (const key of ["stdout", "stderr", "events"])
      assert(
        receipt.probes.streams[key] === receipt.streams[key].bytes,
        `${label} stream probe ${key} is detached`,
      );
  }
  if (declaredProbes.has("tempRoot"))
    assert(receipt.probes?.tempRoot?.removed === true, `${label} temp root was not removed`);
  validateReceiptCleanup(receipt, label);
}

function validateReceiptAssertionSemantics(receipt, manifest, step, eventBytes, root, label) {
  const expectedIds = step.assertions.map((assertion) => assertion.id);
  assert(
    new Set(expectedIds).size === expectedIds.length,
    `${label} manifest assertion IDs repeat`,
  );
  assert(
    receipt.assertions.length === expectedIds.length &&
      new Set(receipt.assertions.map((assertion) => assertion.id)).size ===
        receipt.assertions.length &&
      receipt.assertions.every((assertion) => expectedIds.includes(assertion.id)),
    `${label} assertion IDs are not an exact unique manifest set`,
  );
  const actualIds = new Set(receipt.assertions.map((assertion) => assertion.id));
  assert(
    expectedIds.every((id) => actualIds.has(id)),
    `${label} assertion IDs are incomplete`,
  );
  const sourceKey = (source) =>
    JSON.stringify([source.role, source.path, source.gitBlob, source.sha256]);
  const expectedSources = step.sources ?? [];
  assert(
    new Set(expectedSources.map(sourceKey)).size === expectedSources.length &&
      new Set((receipt.sources ?? []).map(sourceKey)).size === (receipt.sources ?? []).length &&
      JSON.stringify([...new Set((receipt.sources ?? []).map(sourceKey))].sort()) ===
        JSON.stringify([...new Set(expectedSources.map(sourceKey))].sort()),
    `${label} selected source bindings are not an exact manifest set`,
  );
  if (Object.hasOwn(receipt, "selectedSources")) {
    assert(
      JSON.stringify([...new Set((receipt.selectedSources ?? []).map(sourceKey))].sort()) ===
        JSON.stringify([...new Set(expectedSources.map(sourceKey))].sort()),
      `${label} selectedSources are detached`,
    );
  }
  if (manifest?.runner?.sources) {
    assert(
      new Set(manifest.runner.sources.map(sourceKey)).size === manifest.runner.sources.length &&
        new Set((receipt.runnerSources ?? []).map(sourceKey)).size ===
          (receipt.runnerSources ?? []).length &&
        JSON.stringify([...new Set((receipt.runnerSources ?? []).map(sourceKey))].sort()) ===
          JSON.stringify([...new Set(manifest.runner.sources.map(sourceKey))].sort()),
      `${label} runner source bindings are not an exact manifest set`,
    );
  }
  if (!eventBytes) return;
  const events = eventBytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`${label} event stream is not JSONL`);
      }
    });
  const sourceByPath = new Map(expectedSources.map((source) => [source.path, source]));
  for (const expected of step.assertions) {
    const observed = receipt.assertions.find((assertion) => assertion.id === expected.id);
    assert(observed, `${label} assertion ${expected.id} is missing`);
    if (expected.kind === "source-token") {
      const matching = events.filter(
        (event) => event.event === "source-token" && event.assertionId === expected.id,
      );
      assert(matching.length === 1, `${label} source-token event count is not exactly one`);
      const event = matching[0];
      const source = sourceByPath.get(expected.sourcePath);
      assert(
        event.format === "agent-mail.observation/v1" &&
          source &&
          event.sourcePath === expected.sourcePath &&
          event.sourceSha256 === source.sha256 &&
          event.token === expected.token &&
          Number.isSafeInteger(event.observed) &&
          event.observed >= 0 &&
          event.expected === expected.occurrences &&
          typeof event.pass === "boolean" &&
          event.pass === (event.observed === event.expected) &&
          observed.observed === event.observed &&
          observed.pass === event.pass,
        `${label} source-token event is detached`,
      );
    } else if (expected.kind === "fixture-observation") {
      const matching = events.filter(
        (event) => event.event === "fixture-observation" && event.fixtureId === expected.fixtureId,
      );
      assert(matching.length === 1, `${label} fixture observation count is not exactly one`);
      const event = matching[0];
      const source = sourceByPath.get(expected.sourcePath);
      for (const field of [
        "producedBytes",
        "consumedBytes",
        "producedChunks",
        "consumedChunks",
        "peakRssGrowthBytes",
        "expectedBytes",
      ])
        assert(
          Number.isSafeInteger(event[field]) && event[field] >= 0,
          `${label} fixture observation number is invalid`,
        );
      const bytesEqual = event.producedBytes === event.consumedBytes;
      const sha256Equal = event.producedSha256 === event.consumedSha256;
      const exactBytes =
        event.producedBytes === expected.expectedBytes &&
        event.consumedBytes === expected.expectedBytes;
      const pass =
        event.format === "agent-mail.fixture-observation/v1" &&
        source &&
        event.sourcePath === expected.sourcePath &&
        event.sourceSha256 === source.sha256 &&
        event.fixtureId === expected.fixtureId &&
        /^[0-9a-f]{64}$/u.test(event.producedSha256 ?? "") &&
        /^[0-9a-f]{64}$/u.test(event.consumedSha256 ?? "") &&
        event.producerCompleted === true &&
        event.consumerCompleted === true &&
        bytesEqual &&
        sha256Equal &&
        exactBytes &&
        event.producedChunks > 0 &&
        event.consumedChunks > 0 &&
        event.peakRssGrowthBytes < 128 * 1024 * 1024;
      assert(
        event.expectedBytes === expected.expectedBytes &&
          event.bytesEqual === bytesEqual &&
          event.sha256Equal === sha256Equal &&
          event.exactBytes === exactBytes &&
          event.pass === pass &&
          deepJsonEqual(observed.observed, event) &&
          observed.pass === pass,
        `${label} fixture observation is detached`,
      );
    } else if (expected.kind === "structured-oracle") {
      const matching = events.filter((event) => event.event === expected.event);
      assert(matching.length === 1, `${label} structured oracle event count is not exactly one`);
      const event = matching[0];
      const oracleBytes = regularCandidateBlob(
        receipt.candidate.commit,
        expected.path,
        root,
        `${label} structured oracle`,
      );
      assert(digest(oracleBytes) === expected.sha256, `${label} structured oracle digest drifted`);
      const oracleValue = resolveJsonPointer(
        JSON.parse(oracleBytes.toString("utf8")),
        expected.pointer,
      );
      assert(
        event.path === expected.path &&
          event.sha256 === expected.sha256 &&
          event.pointer === expected.pointer &&
          deepJsonEqual(event.value, oracleValue) &&
          deepJsonEqual(observed.observed, event.value) &&
          observed.pass === deepJsonEqual(event.value, expected.value),
        `${label} structured oracle event is detached`,
      );
    }
  }
  observationThresholdValues(step, receipt.assertions, label);
}

export function validateExecutableReceipt(receipt, manifest, step, options = {}) {
  const label = `receipt ${receipt?.runId ?? "unknown"}`;
  assert(receipt?.format === "agent-mail.executable-receipt/v2", `${label} format is invalid`);
  assert(
    typeof receipt.runId === "string" && receipt.runId.length >= 8,
    `${label} run ID is invalid`,
  );
  assert(["primary", "independent-replay"].includes(receipt.role), `${label} role is invalid`);
  assert(receipt.manifestStepId === step.id, `${label} step binding is invalid`);
  assert(
    Array.isArray(receipt.argv) && JSON.stringify(receipt.argv) === JSON.stringify(step.argv),
    `${label} argv is detached`,
  );
  assert(receipt.cwd === step.cwd, `${label} cwd is detached`);
  assert(
    receipt.candidate &&
      /^[0-9a-f]{40}$/u.test(receipt.candidate.commit) &&
      /^[0-9a-f]{40}$/u.test(receipt.candidate.tree),
    `${label} candidate identity is invalid`,
  );
  assert(
    typeof receipt.candidate.manifestPath === "string" &&
      /^[0-9a-f]{64}$/u.test(receipt.candidate.manifestSha256),
    `${label} manifest binding is invalid`,
  );
  assert(
    receipt.observedOutcome?.derivedFrom?.includes(receipt.candidate.commit),
    `${label} candidate commit is not outcome-bound`,
  );
  assert(
    receipt.observedOutcome?.derivedFrom?.includes(receipt.candidate.tree),
    `${label} candidate tree is not outcome-bound`,
  );
  assert(
    receipt.observedOutcome?.derivedFrom?.includes(receipt.candidate.manifestSha256),
    `${label} manifest is not outcome-bound`,
  );
  assert(Array.isArray(receipt.sources), `${label} sources are missing`);
  const expectedSources = new Map(step.sources.map((source) => [source.path, source]));
  assert(receipt.sources.length === expectedSources.size, `${label} source count drifted`);
  for (const source of receipt.sources) {
    const expected = expectedSources.get(source.path);
    assert(
      expected &&
        source.role === expected.role &&
        source.gitBlob === expected.gitBlob &&
        source.sha256 === expected.sha256,
      `${label} source binding drifted`,
    );
  }
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  assert(
    utc.test(receipt.startedAt) && utc.test(receipt.completedAt),
    `${label} wall timestamps are not strict UTC`,
  );
  assert(
    Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt),
    `${label} wall timestamps are reversed`,
  );
  assert(
    receipt.monotonic &&
      /^\d+$/u.test(receipt.monotonic.durationNs ?? "") &&
      BigInt(receipt.monotonic.durationNs) > 0n,
    `${label} monotonic duration is invalid`,
  );
  assert(
    /^\d+$/u.test(receipt.monotonic.startedNs ?? "") &&
      /^\d+$/u.test(receipt.monotonic.completedNs ?? ""),
    `${label} monotonic timestamps are invalid`,
  );
  assert(
    BigInt(receipt.monotonic.completedNs) > BigInt(receipt.monotonic.startedNs),
    `${label} monotonic order is invalid`,
  );
  assert(
    receipt.environment &&
      typeof receipt.environment.os === "string" &&
      typeof receipt.environment.arch === "string" &&
      receipt.environment.runtime,
    `${label} environment is incomplete`,
  );
  assert(
    (receipt.process && Number.isInteger(receipt.process.exitCode)) ||
      receipt.process.exitCode === null,
    `${label} process observation is invalid`,
  );
  assert(["pass", "fail", "blocked"].includes(receipt.result), `${label} result is invalid`);
  assert(
    receipt.observedOutcome?.status === receipt.result,
    `${label} observed outcome is detached`,
  );
  validateReceiptRuntimeEvidence(receipt, step, label);
  assert(
    Array.isArray(receipt.assertions) && receipt.assertions.length === step.assertions.length,
    `${label} assertion receipt is incomplete`,
  );
  for (const assertion of receipt.assertions) {
    const expected = step.assertions.find((candidate) => candidate.id === assertion.id);
    assert(
      expected && assertion.observed !== undefined && typeof assertion.pass === "boolean",
      `${label} assertion is detached`,
    );
    if (assertion.kind === "exitCode")
      assert(
        assertion.observed === receipt.process.exitCode &&
          assertion.pass === (receipt.process.exitCode === assertion.expected),
        `${label} exit assertion is detached`,
      );
  }
  validateReceiptAssertionSemantics(
    receipt,
    manifest,
    step,
    options.eventBytes,
    options.repositoryRoot ?? repositoryRoot,
    label,
  );
  assert(
    receipt.result !== "pass" ||
      (receipt.process.exitCode === 0 && receipt.assertions.every((assertion) => assertion.pass)),
    `${label} pass was not derived from runner observations`,
  );
  for (const key of ["stdout", "stderr", "events"])
    assertReceiptPath(receipt.streams?.[key], `${label} ${key}`);
  for (const key of ["stdout", "stderr", "events"]) {
    const ref = receipt.streams[key];
    assert(
      Number.isSafeInteger(ref.bytes) && ref.bytes >= 0,
      `${label} ${key} byte count is invalid`,
    );
    assert(
      receipt.observedOutcome.derivedFrom?.includes(ref.sha256),
      `${label} ${key} digest is not outcome-bound`,
    );
  }
  if (options.outputRoot) {
    for (const key of ["stdout", "stderr", "events"]) {
      const ref = receipt.streams[key];
      const path = resolve(options.outputRoot, ref.path);
      assert(
        path.startsWith(resolve(options.outputRoot) + "/"),
        `${label} stream escapes output root`,
      );
      const bytes = readFileSync(path);
      assert(
        bytes.length === ref.bytes && digest(bytes) === ref.sha256,
        `${label} ${key} digest drifted`,
      );
    }
  }
  if (!options.skipGit) {
    assert(
      gitExists(receipt.candidate.commit, "", options.repositoryRoot ?? repositoryRoot),
      `${label} candidate commit is missing`,
    );
    const actualTree = execFileSync("git", ["rev-parse", `${receipt.candidate.commit}^{tree}`], {
      cwd: options.repositoryRoot ?? repositoryRoot,
      encoding: "utf8",
    }).trim();
    assert(actualTree === receipt.candidate.tree, `${label} candidate tree drifted`);
  }
  return true;
}

function runV2ExecutionSelfTest() {
  const capturePath = join(repositoryRoot, "scripts/qualification/capture-release-evidence.mjs");
  const replayPath = join(repositoryRoot, "scripts/qualification/replay-release-evidence.mjs");
  const captureOutput = execFileSync("bun", [capturePath, "--self-test"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const replayOutput = execFileSync("bun", [replayPath, "--self-test"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const captureResult = JSON.parse(captureOutput);
  const replayResult = JSON.parse(replayOutput);
  assert(
    captureResult.accepted === true && captureResult.receipt?.result === "pass",
    "real tiny capture did not pass",
  );
  assert(
    replayResult.accepted === true && replayResult.comparison?.replayResult === "pass",
    "real tiny replay did not pass",
  );
  const receipt = captureResult.receipt;
  const step = {
    id: receipt.manifestStepId,
    cwd: receipt.cwd,
    argv: receipt.argv,
    sources: receipt.sources,
    assertions: receipt.assertions.map(({ id, kind, expected }) => ({ id, kind, expected })),
    probes: ["processTreeRss", "streams", "tempRoot"],
    thresholds: {
      processRssBytes: {
        source: "kernel:ps",
        operator: "<=",
        limit: 1073741824,
        unit: "bytes",
      },
    },
  };
  validateExecutableReceipt(receipt, null, step, { skipGit: true });
  const attacks = [
    [
      "receipt forged exit",
      () => {
        const value = structuredClone(receipt);
        value.process.exitCode = 1;
        return value;
      },
    ],
    [
      "receipt forged result",
      () => {
        const value = structuredClone(receipt);
        value.result = "fail";
        return value;
      },
    ],
    [
      "receipt argv shell string",
      () => {
        const value = structuredClone(receipt);
        value.argv = ["node", "tiny-receipt.mjs;rm"];
        return value;
      },
    ],
    [
      "receipt source digest",
      () => {
        const value = structuredClone(receipt);
        value.sources[0].sha256 = "0".repeat(64);
        return value;
      },
    ],
    [
      "receipt source path",
      () => {
        const value = structuredClone(receipt);
        value.sources[0].path = "../tiny.mjs";
        return value;
      },
    ],
    [
      "receipt stream digest",
      () => {
        const value = structuredClone(receipt);
        value.streams.stdout.sha256 = "0".repeat(64);
        return value;
      },
    ],
    [
      "receipt stream traversal",
      () => {
        const value = structuredClone(receipt);
        value.streams.stderr.path = "../stderr";
        return value;
      },
    ],
    [
      "receipt timestamp",
      () => {
        const value = structuredClone(receipt);
        value.completedAt = "2020-01-01T00:00:00.000Z";
        return value;
      },
    ],
    [
      "receipt monotonic",
      () => {
        const value = structuredClone(receipt);
        value.monotonic.completedNs = value.monotonic.startedNs;
        return value;
      },
    ],
    [
      "receipt duplicate assertion ID",
      () => {
        const value = structuredClone(receipt);
        value.assertions = [value.assertions[0], structuredClone(value.assertions[0])];
        return value;
      },
    ],
    [
      "receipt role",
      () => {
        const value = structuredClone(receipt);
        value.role = "primary-replay";
        return value;
      },
    ],
    [
      "receipt candidate",
      () => {
        const value = structuredClone(receipt);
        value.candidate.tree = "0".repeat(40);
        return value;
      },
    ],
    [
      "receipt cleanup survivors",
      () => {
        const value = structuredClone(receipt);
        value.probes.cleanup.survivorsAfterKill = [1234];
        return value;
      },
    ],
    [
      "receipt resource sample",
      () => {
        const value = structuredClone(receipt);
        const sample = value.probes.resources.samples.find((candidate) => candidate.observed);
        sample.fileDescriptors = Number.MAX_SAFE_INTEGER;
        return value;
      },
    ],
    [
      "receipt resource summary",
      () => {
        const value = structuredClone(receipt);
        value.probes.resources.fileDescriptors += 1;
        return value;
      },
    ],
    [
      "receipt forged resource PID",
      () => {
        const value = structuredClone(receipt);
        value.probes.resources.samples[0].pids.push(1234);
        value.probes.resources.pids.push(1234);
        return value;
      },
    ],
    [
      "receipt RSS status",
      () => {
        const value = structuredClone(receipt);
        value.probes.process.rssStatus = "notApplicable";
        return value;
      },
    ],
    [
      "receipt RSS value",
      () => {
        const value = structuredClone(receipt);
        value.probes.process.peakRssBytes = 0;
        return value;
      },
    ],
    [
      "receipt interval duration",
      () => {
        const value = structuredClone(receipt);
        value.monotonic.intervals[1].durationNs = "1";
        return value;
      },
    ],
    [
      "receipt aggregate duration",
      () => {
        const value = structuredClone(receipt);
        value.monotonic.aggregateDurationNs = "1";
        return value;
      },
    ],
    [
      "receipt termination survivors",
      () => {
        const value = structuredClone(receipt);
        value.probes.cleanup.termination.survivorsAfterKill = [1234];
        return value;
      },
    ],
    [
      "receipt termination completion",
      () => {
        const value = structuredClone(receipt);
        value.probes.cleanup.termination.completed = false;
        return value;
      },
    ],
    [
      "receipt cleanup omission",
      () => {
        const value = structuredClone(receipt);
        delete value.probes.cleanup;
        return value;
      },
    ],
    [
      "receipt process samples omission",
      () => {
        const value = structuredClone(receipt);
        delete value.probes.process.samples;
        return value;
      },
    ],
    [
      "receipt resource samples omission",
      () => {
        const value = structuredClone(receipt);
        delete value.probes.resources.samples;
        return value;
      },
    ],
  ];
  let rejected = 0;
  for (const [name, mutate] of attacks) {
    let accepted = false;
    try {
      validateExecutableReceipt(mutate(), null, step, { skipGit: true });
      accepted = true;
    } catch {}
    assert(!accepted, `${name} was accepted`);
    rejected += 1;
  }
  return { attacks: rejected, accepted: true, capture: true, replay: true };
}

function checkGates(index, requireBaselineState = true) {
  assert(
    Array.isArray(index.gates) && index.gates.length === requiredGateIds.length,
    "gate inventory is incomplete",
  );
  const seen = new Set();
  const planText = readFileSync(join(repositoryRoot, "PLAN.md"), "utf8");
  const expectedLabels = new Map([
    ["static", "Static"],
    ["isolated", "Isolated"],
    ["composed", "Composed"],
    ["capacity", "Capacity"],
    ["liveRead", "Live read"],
    ["liveMutation", "Live mutation"],
    ["security", "Security"],
    ["deployedOperations", "Deployed operations"],
    ["delivery", "Delivery"],
  ]);
  for (const gate of index.gates) {
    assert(expectedLabels.has(gate?.id), `unknown gate ${gate?.id}`);
    assert(!seen.has(gate.id), `duplicate gate ${gate.id}`);
    seen.add(gate.id);
    assert(gate.label === expectedLabels.get(gate.id), `${gate.id} label drifted`);
    const line = planText
      .split("\n")
      .find((candidate) => candidate.startsWith(`| ${gate.label} |`));
    assert(line, `${gate.id} is not bound to PLAN evidence tiers`);
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    assert(gate.requiredEvidence === cells[1], `${gate.id} required evidence drifted`);
    assert(gate.notProven === cells[2], `${gate.id} limitation drifted`);
    assert(gate.source === "PLAN.md#Evidence tiers and promotion", `${gate.id} source is detached`);
    if (requireBaselineState) {
      assert(gate.status === "unverified", `${gate.id} promoted without a retained gate result`);
      assert(
        gate.result?.kind === "unverified" && typeof gate.result.reason === "string",
        `${gate.id} result is not explicit`,
      );
    }
  }
  for (const id of requiredGateIds) assert(seen.has(id), `missing gate ${id}`);
}

function checkSourceRow(row, authority) {
  const source = authority.findingRows.get(row.id) ?? authority.shields.get(row.id);
  assert(source, `${row.id} is not an authoritative obligation`);
  const expected = expectedFields(source);
  assert(row.owner === expected.owner, `${row.id} owner is detached or forged`);
  assert(
    JSON.stringify(row.ownerIssues) === JSON.stringify(expected.ownerIssues),
    `${row.id} issue ownership is detached or forged`,
  );
  assert(row.sourceStatus === expected.status, `${row.id} source status drifted`);
  assert(row.sourceControl === expected.control, `${row.id} source control drifted`);
  assert(row.sourceProof === expected.proof, `${row.id} source proof drifted`);
  assert(row.sourceProblem === expected.problem, `${row.id} source problem drifted`);
  assert(row.sourceInvariant === expected.invariant, `${row.id} source invariant drifted`);
  const expectedResult = resultFor(source, expected);
  assert(row.artifact === expectedResult.ref, `${row.id} artifact is detached from its authority`);
  assert(
    JSON.stringify(row.result) === JSON.stringify(expectedResult),
    `${row.id} result is detached, forged, or promoted`,
  );
  assert(
    row.proofClass === expectedProofClass(expectedResult),
    `${row.id} proof class was relabelled`,
  );
  assert(row.status === expectedRowStatus(expected), `${row.id} row status promoted or drifted`);
  assert(
    JSON.stringify(row.evidence) === JSON.stringify(expectedEvidence(source, expectedResult)),
    `${row.id} evidence gate status drifted`,
  );
  if (expectedResult.kind === "retained-proof") {
    assert(
      expectedResult.artifacts.length > 0 &&
        expectedResult.candidateFingerprint === expectedResult.commit,
      `${row.id} retained proof is incomplete`,
    );
    for (const artifact of expectedResult.artifacts) {
      assert(
        digest(
          execFileSync("git", ["cat-file", "blob", `${expectedResult.commit}:${artifact.path}`], {
            cwd: repositoryRoot,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          }),
        ) === artifact.sha256,
        `${row.id} retained artifact digest drifted`,
      );
    }
  }
}

export function validateIndex(index, options = {}) {
  const memoKey = options.memoizeValid
    ? `${options.repositoryRoot ?? repositoryRoot}\0${options.bundleCommit ?? ""}\0${options.diffCommit ?? ""}\0${digest(Buffer.from(JSON.stringify(index)))}`
    : null;
  if (memoKey && validationMemo.has(memoKey)) return true;
  assert(index?.format === "agent-mail.release-evidence-index/v1", "unsupported format");
  assert(index.schemaVersion === 1, "unsupported schema version");
  assert(
    index.oracle?.normative === true && index.oracle.issue === 166,
    "normative issue authority is missing",
  );
  assert(
    JSON.stringify(index.oracle.requiredEvidenceClasses) ===
      JSON.stringify(requiredEvidenceClasses),
    "evidence classes drifted",
  );
  const authority = authorities();
  checkResultOwnerAuthority(index);
  checkExecutionManifest(index);
  assert(
    JSON.stringify(index.resultRecordSchema) === JSON.stringify(resultRecordSchema),
    "result-record schema drifted",
  );
  checkFrozenInputs(index);
  const expectedIds = [...authority.findingRows.keys(), ...authority.shields.keys()];
  assert(index.baseline?.promotion?.releaseReady === false, "immutable baseline was promoted");
  assert(
    Array.isArray(index.baseline?.retirements),
    "immutable baseline retirement accounting is missing",
  );
  assert(index.baseline.kind === "immutable-source-projection", "immutable baseline kind drifted");
  assert(
    JSON.stringify(index.baseline.rowIds) === JSON.stringify(expectedIds),
    "immutable baseline obligations drifted",
  );
  assert(
    JSON.stringify(index.baseline.gateIds) === JSON.stringify(requiredGateIds),
    "immutable baseline gates drifted",
  );
  assert(
    JSON.stringify(index.baseline.sourceDigests) ===
      JSON.stringify(
        Object.fromEntries(index.frozenInputs.map((input) => [input.id, input.sha256])),
      ),
    "immutable baseline source digests drifted",
  );
  assert(
    JSON.stringify(index.baseline.retirements) ===
      JSON.stringify([
        {
          id: "F09",
          replacedBy: ["F09-P", "F09-R"],
          reason:
            "The historical bundled finding remains in the ledger; its two independently closable controls are indexed separately.",
        },
      ]),
    "immutable baseline retirement accounting drifted",
  );
  const immutableRows = baselineRows(authority);
  const immutableGates = baselineGates();
  const seen = new Set();
  for (const row of immutableRows) {
    assert(typeof row?.id === "string" && !seen.has(row.id), `missing or duplicate row ${row?.id}`);
    seen.add(row.id);
    checkSourceRow(row, authority);
  }
  for (const id of expectedIds) assert(seen.has(id), `index omits ${id}`);
  assert(
    Array.isArray(index.baseline.retirements) && index.baseline.retirements.length === 1,
    "retirement accounting is incomplete",
  );
  const retirement = index.baseline.retirements[0];
  assert(
    retirement.id === "F09" &&
      JSON.stringify(retirement.replacedBy) === JSON.stringify(["F09-P", "F09-R"]),
    "F09 retirement drifted",
  );
  for (const child of ["F09-P", "F09-R"])
    assert(
      !index.baseline.retirements.some((entry) => entry.id === child),
      `${child} was incorrectly retired`,
    );
  assert(
    JSON.stringify(index.retirements) === JSON.stringify(index.baseline.retirements),
    "current retirement accounting overwrote baseline",
  );
  validateResultRecords(index, immutableRows, options);
  const current = applyResultRecords(immutableRows, immutableGates, index.resultRecords);
  assert(
    Array.isArray(index.rows) && index.rows.length === expectedIds.length,
    `row count ${index.rows?.length} != ${expectedIds.length}`,
  );
  assert(
    JSON.stringify(index.rows) === JSON.stringify(current.rows),
    "current rows are not derived from baseline plus result records",
  );
  assert(
    JSON.stringify(index.gates) === JSON.stringify(current.gates),
    "current gates are not derived from result records",
  );
  assert(index.promotion?.local === current.promotion.local, "local promotion predicate drifted");
  assert(index.promotion?.live === current.promotion.live, "live promotion predicate drifted");
  assert(
    index.promotion?.deployed === current.promotion.deployed,
    "deployed promotion predicate drifted",
  );
  checkGates(index, false);
  for (const row of index.rows) {
    const source = authority.findingRows.get(row.id) ?? authority.shields.get(row.id);
    const expected = expectedFields(source);
    const baselineRow = immutableRows.find((candidate) => candidate.id === row.id);
    assert(
      row.owner === expected.owner && row.ownerIssues.join(",") === expected.ownerIssues.join(","),
      `${row.id} current authority drifted`,
    );
    assert(
      row.sourceStatus === expected.status &&
        row.sourceControl === expected.control &&
        row.sourceProof === expected.proof,
      `${row.id} current source binding drifted`,
    );
    assert(
      row.artifact === baselineRow.artifact &&
        JSON.stringify(row.result) === JSON.stringify(baselineRow.result),
      `${row.id} current result overwrote baseline`,
    );
    assert(
      row.status === baselineRow.status && row.proofClass === baselineRow.proofClass,
      `${row.id} current status overwrote baseline`,
    );
  }
  const releaseReady = current.promotion.releaseReady;
  assert(
    index.promotion?.releaseReady === releaseReady,
    "releaseReady is not derived from complete gates",
  );
  assert(
    index.promotion.releaseReady === false,
    "releaseReady must remain false for this candidate",
  );
  if (memoKey) validationMemo.add(memoKey);
  return {
    rowCount: index.rows.length,
    findingRows: authority.findingRows.size,
    shieldRows: authority.shields.size,
    gates: index.gates.length,
    retainedRows: index.rows.filter((row) => row.proofClass === "retained").length,
    blockedRows: index.rows.filter((row) => row.proofClass === "blocked").length,
    resultRecords: index.resultRecords.length,
    releaseReady,
    sourceDigests: Object.fromEntries(index.frozenInputs.map((input) => [input.id, input.sha256])),
  };
}

// A committed, validator-facing v2 fixture.  This is intentionally kept
// separate from the live ledger: it exercises the same candidate -> evidence
// -> index ancestry and the actual v2 receipt paths without making synthetic
// evidence look like production evidence.
function runComposedV2Fixture(baselineIndex) {
  const root = mkdtempSync("/tmp/release-evidence-v2-composed-");
  const evidenceRoot = "docs/qualification/evidence/issue-176";
  const writeJson = (path, value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    return { path, sha256: digest(bytes), bytes: bytes.length };
  };
  const zeroSha = "0".repeat(64);
  try {
    execFileSync("git", ["clone", "-q", repositoryRoot, "."], { cwd: root });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
    const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const candidateTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const manifestBytes = execFileSync(
      "git",
      [
        "cat-file",
        "blob",
        `${candidateCommit}:docs/architecture/release-evidence-execution-manifest.v2.json`,
      ],
      { cwd: root },
    );
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const manifestSha256 = digest(manifestBytes);
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const completedAt = new Date(Date.now()).toISOString();
    const aggregateArgv = [
      "bun",
      "test",
      ...new Set(requiredCapacitySubgates.flatMap((id) => capacityManifest[id].argv.slice(2))),
    ];
    const receiptRefs = { primary: [], replay: [] };
    const receiptObjects = [];
    const writeReceipt = (step, role, index) => {
      const runId = `fixture-${role}-${step.id}-${index}`;
      const pid = 32000 + index;
      const events = [];
      const observations = {};
      for (const assertion of step.assertions) {
        if (assertion.kind === "source-token") {
          const event = {
            format: "agent-mail.observation/v1",
            event: "source-token",
            assertionId: assertion.id,
            sourcePath: assertion.sourcePath,
            sourceSha256: step.sources.find((source) => source.path === assertion.sourcePath)
              .sha256,
            token: assertion.token,
            observed: assertion.occurrences,
            expected: assertion.occurrences,
            pass: true,
          };
          events.push(event);
          observations[assertion.id] = { ...event };
        } else if (assertion.kind === "fixture-observation") {
          const bytes = assertion.expectedBytes ?? 1;
          const event = {
            format: "agent-mail.fixture-observation/v1",
            event: "fixture-observation",
            sourcePath: assertion.sourcePath,
            sourceSha256: step.sources.find((source) => source.path === assertion.sourcePath)
              .sha256,
            fixtureId: assertion.fixtureId,
            producedBytes: bytes,
            consumedBytes: bytes,
            producedSha256: digest(Buffer.from(`${runId}-fixture`)),
            consumedSha256: digest(Buffer.from(`${runId}-fixture`)),
            producedChunks: 1,
            consumedChunks: 1,
            expectedBytes: bytes,
            peakRssGrowthBytes: 1,
            producerCompleted: true,
            consumerCompleted: true,
            bytesEqual: true,
            sha256Equal: true,
            exactBytes: true,
            pass: true,
          };
          events.push(event);
          observations[assertion.id] = { ...event };
        }
      }
      const eventBytes = Buffer.from(
        events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );
      const stdoutBytes = Buffer.from(`${runId}: stdout\n`);
      const stderrBytes = Buffer.from(`${runId}: stderr\n`);
      const stream = (name, bytes) => {
        const path = `${evidenceRoot}/${runId}-${name}.json`;
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), bytes);
        return { path, sha256: digest(bytes), bytes: bytes.length };
      };
      const streams = {
        stdout: stream("stdout", stdoutBytes),
        stderr: stream("stderr", stderrBytes),
        events: stream("events", eventBytes),
      };
      const fixtureBytes = Buffer.from(`${runId}: generated fixture\n`);
      const fixture = {
        ...step.fixture,
        materialized: writeJson(
          `${evidenceRoot}/${runId}-fixture.json`,
          fixtureBytes.toString("utf8"),
        ),
      };
      const processSamples = [
        {
          rootPresent: true,
          rssStatus: "observed",
          rssBytes: 1,
          pids: [pid],
          processGroups: [pid],
          descendants: [],
        },
        {
          rootPresent: false,
          rssStatus: "notApplicable",
          rssBytes: null,
          pids: [pid],
          processGroups: [pid],
          descendants: [],
        },
      ];
      const resourceSamples = processSamples.map((sample) => ({
        observed: true,
        pids: [pid],
        fileDescriptors: 0,
        sockets: 0,
        listeners: 0,
        hermesPorts: [6110],
      }));
      const receipt = {
        format: "agent-mail.executable-receipt/v2",
        runId,
        role,
        manifestStepId: step.id,
        argv: step.argv,
        cwd: step.cwd,
        candidate: {
          commit: candidateCommit,
          tree: candidateTree,
          manifestPath: "docs/architecture/release-evidence-execution-manifest.v2.json",
          manifestSha256,
        },
        startedAt,
        completedAt,
        monotonic: {
          startedNs: "1000000000",
          completedNs: "1000004000",
          durationNs: "2000",
          aggregateDurationNs: "4000",
          intervals: [
            { id: "setup", startedNs: "1000000000", completedNs: "1000001000", durationNs: "1000" },
            {
              id: "execution",
              startedNs: "1000001000",
              completedNs: "1000003000",
              durationNs: "2000",
            },
            {
              id: "retention-and-cleanup",
              startedNs: "1000003000",
              completedNs: "1000004000",
              durationNs: "1000",
            },
          ],
        },
        environment: { os: "darwin", arch: "arm64", runtime: "Bun 1.3.14" },
        process: { exitCode: 0 },
        result: "pass",
        observedOutcome: {
          status: "pass",
          derivedFrom: [
            candidateCommit,
            candidateTree,
            manifestSha256,
            ...Object.values(streams).map((ref) => ref.sha256),
          ],
          summary: "synthetic committed qualification fixture",
        },
        sources: step.sources,
        selectedSources: step.sources,
        runnerSources: manifest.runner.sources,
        fixture,
        assertions: step.assertions.map((assertion) => ({
          id: assertion.id,
          kind: assertion.kind,
          observed:
            assertion.kind === "source-token"
              ? observations[assertion.id].observed
              : (observations[assertion.id] ?? assertion.occurrences),
          pass: true,
        })),
        streams,
        probes: {
          process: {
            observed: true,
            samples: processSamples,
            descendants: [],
            rssStatus: "observed",
            rssBytes: 1,
            peakRssBytes: 1,
          },
          resources: {
            observed: true,
            samples: resourceSamples,
            pids: [pid],
            fileDescriptors: 0,
            sockets: 0,
            listeners: 0,
            hermesPorts: [6110],
          },
          streams: {
            observed: true,
            stdout: streams.stdout.bytes,
            stderr: streams.stderr.bytes,
            events: streams.events.bytes,
          },
          tempRoot: { removed: true },
          cleanup: {
            barrier: "awaited-idempotent",
            invocations: 1,
            executionRootRemoved: true,
            survivorsAfterKill: [],
            descendantsBeforeRemoval: [],
            termination: {
              sigtermSent: true,
              sigkillSent: false,
              survivorsBeforeKill: [],
              survivorsAfterKill: [],
              completed: true,
            },
          },
        },
      };
      const core = structuredClone(receipt);
      const provenancePath = `${evidenceRoot}/${runId}-provenance.json`;
      const observationsProjection = {
        process: receipt.process,
        processProbe: receipt.probes.process,
        resources: receipt.probes.resources,
        termination: receipt.probes.cleanup.termination,
        cleanup: receipt.probes.cleanup,
        streams: receipt.probes.streams,
        monotonic: receipt.monotonic,
        startedAt,
        completedAt,
        result: receipt.result,
        observedOutcome: receipt.observedOutcome,
      };
      const authority = {
        candidate: receipt.candidate,
        manifestStepId: receipt.manifestStepId,
        cwd: receipt.cwd,
        argv: receipt.argv,
        sources: receipt.sources,
        runnerSources: receipt.runnerSources,
        fixture: receipt.fixture,
        assertions: receipt.assertions,
        probes: step.probes,
        thresholds: step.thresholds,
      };
      const receiptSha256 = digest(Buffer.from(canonicalJson(core)));
      const observationsSha256 = digest(Buffer.from(canonicalJson(observationsProjection)));
      const envelope = {
        format: "agent-mail.capture-provenance/v1",
        runId,
        role,
        receiptSha256,
        observations: observationsProjection,
        observationsSha256,
        authority,
        roots: {
          output: { path: `/tmp/${runId}-output`, dev: 1, ino: 1000 + index },
          temporary: { path: `/tmp/${runId}-temporary`, dev: 1, ino: 2000 + index, removed: true },
        },
        artifacts: Object.fromEntries(
          Object.entries({ ...streams, fixture: fixture.materialized }).map(([key, ref]) => [
            key,
            { path: ref.path, bytes: ref.bytes, sha256: ref.sha256 },
          ]),
        ),
      };
      const envelopeRef = writeJson(provenancePath, envelope);
      receipt.provenance = {
        format: envelope.format,
        path: provenancePath,
        bytes: envelopeRef.bytes,
        sha256: envelopeRef.sha256,
        receiptSha256,
        observationsSha256,
      };
      const receiptRef = writeJson(`${evidenceRoot}/${runId}-receipt.json`, receipt);
      receiptObjects.push({ receipt, receiptRef, envelopeRef });
      return receiptRef;
    };
    for (const role of ["primary", "independent-replay"]) {
      for (const [index, step] of manifest.steps.entries())
        receiptRefs[role === "primary" ? "primary" : "replay"].push(
          writeReceipt(step, role, index + (role === "primary" ? 1 : 101)),
        );
    }
    const baseline = new Map(baselineRows(authorities()).map((row) => [row.id, row]));
    const subgates = Object.fromEntries(
      requiredCapacitySubgates.map((id) => {
        const spec = capacityManifest[id];
        const descriptorBytes = execFileSync(
          "git",
          ["cat-file", "blob", `${candidateCommit}:${spec.descriptorPath}`],
          { cwd: root },
        );
        const descriptorSha = digest(descriptorBytes);
        const scale = { [spec.scale.key]: spec.scale.minimum, unit: spec.scale.unit };
        const metrics = Object.fromEntries(
          Object.keys(spec.metrics).map((metric) => [
            metric,
            metric === spec.scale.key ? spec.scale.minimum : 1,
          ]),
        );
        const raw = writeJson(`${evidenceRoot}/${id}-raw.json`, {
          subgateId: id,
          fixtureId: spec.fixtureId,
          fixtureDigest: descriptorSha,
          descriptorPath: spec.descriptorPath,
          descriptorDigest: descriptorSha,
          scale,
          metrics,
        });
        const correctness = writeJson(`${evidenceRoot}/${id}-correctness.json`, {
          kind: "correctness",
          subgateId: id,
          candidateCommit,
          status: "pass",
          oracle: spec.fixtureId,
        });
        const resources = writeJson(`${evidenceRoot}/${id}-resources.json`, {
          kind: "resources",
          subgateId: id,
          candidateCommit,
          status: "pass",
          peak: { value: 0, unit: "MiB" },
          retained: { value: 0, unit: "MiB" },
          limits: { peak: 1, retained: 0 },
        });
        const cleanup = writeJson(`${evidenceRoot}/${id}-cleanup.json`, {
          kind: "cleanup",
          subgateId: id,
          candidateCommit,
          status: "pass",
          leaks: { openHandles: 0, processes: 0, files: 0, listeners: 0 },
        });
        return [
          id,
          {
            argv: spec.argv,
            descriptor: { path: spec.descriptorPath, sha256: descriptorSha },
            fixtureIds: [spec.fixtureId],
            fixtureDigests: [descriptorSha],
            scale,
            thresholds: Object.entries(spec.metrics).map(([metric, expected]) => ({
              metric,
              operator: expected.operator,
              limit: expected.operator === "<=" ? 300 : spec.scale.minimum,
              unit: expected.unit,
            })),
            rawSamples: [{ path: raw.path, sha256: raw.sha256 }],
            observations: { metrics },
            artifacts: { correctness, resources, cleanup },
          },
        ];
      }),
    );
    const closure = {};
    for (const obligationId of ["F17", "F18", "F22", "F23"]) {
      const row = baseline.get(obligationId);
      const contract = closureSourceContracts[obligationId];
      const make = (kind) => {
        const role = contract[kind];
        const descriptorBytes = execFileSync(
          "git",
          ["cat-file", "blob", `${candidateCommit}:${contract.descriptorPaths[0]}`],
          { cwd: root },
        );
        const sourceDescriptors = [
          { path: contract.descriptorPaths[0], sha256: digest(descriptorBytes) },
        ];
        const argv = ["bun", "test", `closure-${obligationId}-${kind}.test.ts`];
        const proof = writeJson(`${evidenceRoot}/${obligationId}-${kind}-proof.json`, {
          kind: "closure-proof",
          role: kind,
          obligationId,
          ownerIssueId: 176,
          gateId: "capacity",
          sequence: 1,
          argv,
          candidateCommit,
          candidateTree,
          sourceDescriptors,
          baselineProofDigest: baselineProofDigest(row),
          exitCode: 0,
          result: "pass",
          observedOutcome: { kind, baselineMatch: kind === "reproduction", status: "pass" },
          receipt: {
            argv,
            exitCode: 0,
            assertions: [{ id: role.assertionId, outcome: role.outcome }],
          },
        });
        const artifact = writeJson(`${evidenceRoot}/${obligationId}-${kind}.json`, {
          kind,
          role: kind,
          obligationId,
          ownerIssueId: 176,
          gateId: "capacity",
          sequence: 1,
          argv,
          candidateCommit,
          candidateTree,
          sourceDescriptors,
          baselineProofDigest: baselineProofDigest(row),
          exitCode: 0,
          result: "pass",
          observedOutcome: { kind, baselineMatch: kind === "reproduction", status: "pass" },
          receipt: {
            argv,
            exitCode: 0,
            assertions: [{ id: role.assertionId, outcome: role.outcome }],
          },
          proof,
        });
        return { argv, proof, artifact };
      };
      closure[obligationId] = {
        baselineSourceStatusSha256: digest(Buffer.from(row.sourceStatus)),
        baselineProofDigest: baselineProofDigest(row),
        originalReproduction: make("reproduction"),
        adjacentCounterexample: make("counterexample"),
      };
    }
    const execution = {
      argv: aggregateArgv,
      startedAt,
      completedAt,
      environment: { os: "darwin", arch: "arm64", runtime: "Bun 1.3.14" },
      evidence: { subgates, correctness: { status: "pass" }, cleanup: { status: "pass" } },
      result: "pass",
      observedOutcome: { status: "pass", summary: "all seven subgates pass" },
    };
    const bundleFor = (record) =>
      writeJson(record.bundle.path, {
        protocol: "agent-mail.release-evidence-bundle/v2",
        record: {
          protocol: record.protocol,
          recordType: record.recordType,
          sequence: record.sequence,
          previousRecordDigest: record.previousRecordDigest,
          ownerIssueId: record.ownerIssueId,
          mode: record.mode,
          gateId: record.gateId,
          obligationIds: record.obligationIds,
          candidateCommit: record.candidateCommit,
          candidateTree: record.candidateTree,
        },
      });
    const baseRecord = {
      protocol: "agent-mail.release-evidence/v2",
      recordType: "qualification",
      sequence: 1,
      previousRecordDigest: null,
      ownerIssueId: 176,
      mode: "promotion",
      gateId: "capacity",
      obligationIds: ["F17", "F18", "F22", "F23", "F30", "SEC-R03", "S04", "S05"],
      candidateCommit,
      candidateTree,
      evidenceCommit: candidateCommit,
      manifest: {
        path: "docs/architecture/release-evidence-execution-manifest.v2.json",
        sha256: manifestSha256,
      },
      bundle: { path: `${evidenceRoot}/qualification-1-bundle.json`, sha256: zeroSha },
      closure,
      ...execution,
      primaryReceipt: receiptRefs.primary,
      replayReceipt: receiptRefs.replay,
    };
    // E1: all qualification artifacts and its bundle are committed together.
    const qualificationBundle = bundleFor(baseRecord);
    execFileSync("git", ["add", evidenceRoot], { cwd: root });
    execFileSync("git", ["commit", "-qm", "composed qualification evidence"], { cwd: root });
    const evidenceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const qualification = { ...baseRecord, evidenceCommit, bundle: qualificationBundle };
    // I1: recording the qualification is a separate index-only commit.
    const indexFor = (records) => {
      const value = structuredClone(baselineIndex);
      value.resultRecords = records;
      const projection = materializeCurrent(value);
      value.rows = projection.rows;
      value.gates = projection.gates;
      value.promotion = { ...value.promotion, ...projection.promotion };
      return value;
    };
    let stagedIndex = indexFor([qualification]);
    mkdirSync(join(root, "docs/architecture"), { recursive: true });
    writeFileSync(
      join(root, "docs/architecture/release-evidence-index.v1.json"),
      JSON.stringify(stagedIndex),
    );
    execFileSync("git", ["add", "docs/architecture/release-evidence-index.v1.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "record qualification"], { cwd: root });
    const i1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const i1Tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    // E2 carries #184's review artifact. Its local commit identity is
    // intentionally distinct from the target qualification identity.
    const reviewPath = "docs/qualification/evidence/issue-184/disposition-review.json";
    const dispositionBase = {
      protocol: "agent-mail.release-evidence/v2",
      recordType: "disposition",
      sequence: 2,
      previousRecordDigest: recordDigest(qualification),
      ownerIssueId: 184,
      mode: "disposition",
      gateId: "disposition",
      obligationIds: [],
      candidateCommit: i1,
      candidateTree: i1Tree,
      evidenceCommit: i1,
      startedAt,
      completedAt,
      environment: execution.environment,
      result: "invalidated",
      observedOutcome: { status: "invalidated" },
      targetSequence: 1,
      targetRecordDigest: recordDigest(qualification),
      targetOwnerIssueId: 176,
      targetGateId: "capacity",
      targetCandidateCommit: candidateCommit,
      targetCandidateTree: candidateTree,
      targetEvidenceCommit: evidenceCommit,
      reasonCode: "review-revoked",
      reviewArtifact: { path: reviewPath, sha256: zeroSha },
    };
    const review = writeJson(reviewPath, {
      kind: "disposition-review",
      status: "pass",
      ownerIssueId: 184,
      gateId: "disposition",
      targetSequence: 1,
      targetRecordDigest: dispositionBase.targetRecordDigest,
      targetOwnerIssueId: 176,
      targetGateId: "capacity",
      targetCandidateCommit: candidateCommit,
      targetCandidateTree: candidateTree,
      targetEvidenceCommit: evidenceCommit,
    });
    execFileSync("git", ["add", evidenceRoot, "docs/qualification/evidence/issue-184"], {
      cwd: root,
    });
    execFileSync("git", ["commit", "-qm", "disposition review"], { cwd: root });
    const e2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const disposition = { ...dispositionBase, evidenceCommit: e2, reviewArtifact: review };
    // I2: disposition index append.
    stagedIndex = indexFor([qualification, disposition]);
    writeFileSync(
      join(root, "docs/architecture/release-evidence-index.v1.json"),
      JSON.stringify(stagedIndex),
    );
    execFileSync("git", ["add", "docs/architecture/release-evidence-index.v1.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "record disposition"], { cwd: root });
    const i2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const i2Tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const correctedReceipts = { primary: [], replay: [] };
    for (const [roleKey, refs] of Object.entries({
      primary: receiptRefs.primary,
      replay: receiptRefs.replay,
    })) {
      for (const [receiptIndex, sourceRef] of refs.entries()) {
        const receipt = JSON.parse(readFileSync(join(root, sourceRef.path), "utf8"));
        const oldCommit = receipt.candidate.commit;
        const oldTree = receipt.candidate.tree;
        receipt.runId = `corrected-${receipt.runId}`;
        receipt.candidate = { ...receipt.candidate, commit: i2, tree: i2Tree };
        receipt.observedOutcome = {
          ...receipt.observedOutcome,
          derivedFrom: receipt.observedOutcome.derivedFrom.map((value) =>
            value === oldCommit ? i2 : value === oldTree ? i2Tree : value,
          ),
        };
        const step = manifest.steps.find((candidate) => candidate.id === receipt.manifestStepId);
        const provenancePath = `${evidenceRoot}/corrected-${roleKey}-${receiptIndex + 1}-provenance.json`;
        const observations = {
          process: receipt.process,
          processProbe: receipt.probes.process,
          resources: receipt.probes.resources,
          termination: receipt.probes.cleanup.termination,
          cleanup: receipt.probes.cleanup,
          streams: receipt.probes.streams,
          monotonic: receipt.monotonic,
          startedAt: receipt.startedAt,
          completedAt: receipt.completedAt,
          result: receipt.result,
          observedOutcome: receipt.observedOutcome,
        };
        const authority = {
          candidate: receipt.candidate,
          manifestStepId: receipt.manifestStepId,
          cwd: receipt.cwd,
          argv: receipt.argv,
          sources: receipt.sources,
          runnerSources: receipt.runnerSources,
          fixture: receipt.fixture,
          assertions: receipt.assertions,
          probes: step.probes,
          thresholds: step.thresholds,
        };
        const core = structuredClone(receipt);
        delete core.provenance;
        const receiptSha256 = digest(Buffer.from(canonicalJson(core)));
        const observationsSha256 = digest(Buffer.from(canonicalJson(observations)));
        const artifacts = Object.fromEntries(
          Object.entries({ ...receipt.streams, fixture: receipt.fixture.materialized }).map(
            ([key, ref]) => [key, { path: ref.path, bytes: ref.bytes, sha256: ref.sha256 }],
          ),
        );
        const envelope = {
          format: "agent-mail.capture-provenance/v1",
          runId: receipt.runId,
          role: receipt.role,
          receiptSha256,
          observations,
          observationsSha256,
          authority,
          roots: {
            output: { path: `/tmp/${receipt.runId}-output`, dev: 1, ino: 5000 + receiptIndex },
            temporary: {
              path: `/tmp/${receipt.runId}-temporary`,
              dev: 1,
              ino: 6000 + receiptIndex,
              removed: true,
            },
          },
          artifacts,
        };
        const envelopeRef = writeJson(provenancePath, envelope);
        receipt.provenance = {
          format: envelope.format,
          path: provenancePath,
          bytes: envelopeRef.bytes,
          sha256: envelopeRef.sha256,
          receiptSha256,
          observationsSha256,
        };
        correctedReceipts[roleKey].push(
          writeJson(
            `${evidenceRoot}/corrected-${roleKey}-${receiptIndex + 1}-receipt.json`,
            receipt,
          ),
        );
      }
    }
    const correctedEvidence = structuredClone(execution.evidence);
    for (const [id, subgate] of Object.entries(correctedEvidence.subgates)) {
      for (const key of ["correctness", "resources", "cleanup"]) {
        const sourceRef = subgate.artifacts[key];
        const value = JSON.parse(readFileSync(join(root, sourceRef.path), "utf8"));
        value.candidateCommit = i2;
        value.candidateTree = i2Tree;
        const ref = writeJson(`${evidenceRoot}/corrected-${id}-${key}.json`, value);
        subgate.artifacts[key] = ref;
      }
    }
    correctedEvidence.subgates = correctedEvidence.subgates;
    const correctedClosure = structuredClone(closure);
    for (const [obligationId, obligationClosure] of Object.entries(correctedClosure)) {
      for (const entryName of ["originalReproduction", "adjacentCounterexample"]) {
        const entry = obligationClosure[entryName];
        for (const key of ["proof", "artifact"]) {
          const value = JSON.parse(readFileSync(join(root, entry[key].path), "utf8"));
          value.candidateCommit = i2;
          value.candidateTree = i2Tree;
          const ref = writeJson(
            `${evidenceRoot}/corrected-${obligationId}-${entryName}-${key}.json`,
            value,
          );
          entry[key] = ref;
        }
      }
    }
    // E3: corrected qualification targets the revoked sequence but runs from
    // the disposition index commit, so its evidence append remains direct.
    const correctedBase = {
      ...qualification,
      sequence: 3,
      previousRecordDigest: recordDigest(disposition),
      candidateCommit: i2,
      candidateTree: i2Tree,
      evidenceCommit: i2,
      evidence: correctedEvidence,
      closure: correctedClosure,
      primaryReceipt: correctedReceipts.primary,
      replayReceipt: correctedReceipts.replay,
      bundle: { path: `${evidenceRoot}/qualification-3-bundle.json`, sha256: zeroSha },
      correctedFromSequence: 1,
      correctedFromRecordDigest: recordDigest(qualification),
    };
    const correctedBundle = bundleFor(correctedBase);
    execFileSync("git", ["add", evidenceRoot], { cwd: root });
    execFileSync("git", ["commit", "-qm", "corrected qualification evidence"], { cwd: root });
    const e3 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const corrected = { ...correctedBase, evidenceCommit: e3, bundle: correctedBundle };
    const finalIndex = indexFor([qualification, disposition, corrected]);
    writeFileSync(
      join(root, "docs/architecture/release-evidence-index.v1.json"),
      JSON.stringify(finalIndex),
    );
    execFileSync("git", ["add", "docs/architecture/release-evidence-index.v1.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "record corrected qualification"], { cwd: root });
    validateIndex(finalIndex, { repositoryRoot: root, allowEmptyBaseline: true });
    const oracleStep = manifest.steps.find((step) => step.id === "mime-250mib");
    const oracleBytes = execFileSync(
      "git",
      ["cat-file", "blob", `${candidateCommit}:package.json`],
      {
        cwd: root,
      },
    );
    const oracleValue = JSON.parse(oracleBytes.toString("utf8")).name;
    const oracleAssertion = {
      id: "synthetic-structured-oracle",
      kind: "structured-oracle",
      event: "structured-oracle",
      path: "package.json",
      sha256: digest(oracleBytes),
      pointer: "/name",
      value: oracleValue,
    };
    const sourceReceipt = JSON.parse(readFileSync(join(root, receiptRefs.primary[0].path), "utf8"));
    const oracleEvent = JSON.stringify({
      event: "structured-oracle",
      path: oracleAssertion.path,
      sha256: oracleAssertion.sha256,
      pointer: oracleAssertion.pointer,
      value: oracleValue,
    });
    const sourceEventBytes = readFileSync(join(root, sourceReceipt.streams.events.path));
    const sourceEventText = sourceEventBytes.toString("utf8");
    const retainedMimeEvents = (oracleText) =>
      Buffer.from(
        `${sourceEventText.endsWith("\n") ? sourceEventText : `${sourceEventText}\n`}${oracleText}\n`,
      );
    const oracleStepWithAssertion = {
      ...oracleStep,
      assertions: [...oracleStep.assertions, oracleAssertion],
    };
    const oracleEventBytes = retainedMimeEvents(oracleEvent);
    const oracleEventsPath = `${evidenceRoot}/${sourceReceipt.runId}-structured-oracle-events.jsonl`;
    mkdirSync(dirname(join(root, oracleEventsPath)), { recursive: true });
    writeFileSync(join(root, oracleEventsPath), oracleEventBytes);
    const oracleEventsRef = {
      path: oracleEventsPath,
      sha256: digest(oracleEventBytes),
      bytes: oracleEventBytes.length,
    };
    const oracleReceipt = structuredClone(sourceReceipt);
    const sourceEventsSha256 = oracleReceipt.streams.events.sha256;
    oracleReceipt.streams.events = oracleEventsRef;
    oracleReceipt.probes.streams.events = oracleEventsRef.bytes;
    oracleReceipt.observedOutcome.derivedFrom = oracleReceipt.observedOutcome.derivedFrom.map(
      (value) => (value === sourceEventsSha256 ? oracleEventsRef.sha256 : value),
    );
    oracleReceipt.assertions = [
      ...oracleReceipt.assertions,
      { id: oracleAssertion.id, kind: oracleAssertion.kind, observed: oracleValue, pass: true },
    ];
    const sourceEnvelope = JSON.parse(
      readFileSync(join(root, sourceReceipt.provenance.path), "utf8"),
    );
    const oracleObservations = {
      process: oracleReceipt.process,
      processProbe: oracleReceipt.probes.process,
      resources: oracleReceipt.probes.resources,
      termination: oracleReceipt.probes.cleanup.termination,
      cleanup: oracleReceipt.probes.cleanup,
      streams: oracleReceipt.probes.streams,
      monotonic: oracleReceipt.monotonic,
      startedAt: oracleReceipt.startedAt,
      completedAt: oracleReceipt.completedAt,
      result: oracleReceipt.result,
      observedOutcome: oracleReceipt.observedOutcome,
    };
    const oracleAuthority = {
      candidate: oracleReceipt.candidate,
      manifestStepId: oracleReceipt.manifestStepId,
      cwd: oracleReceipt.cwd,
      argv: oracleReceipt.argv,
      sources: oracleReceipt.sources,
      runnerSources: oracleReceipt.runnerSources,
      fixture: oracleReceipt.fixture,
      assertions: oracleReceipt.assertions,
      probes: oracleStepWithAssertion.probes,
      thresholds: oracleStepWithAssertion.thresholds,
    };
    const oracleCore = structuredClone(oracleReceipt);
    delete oracleCore.provenance;
    const oracleReceiptSha256 = digest(Buffer.from(canonicalJson(oracleCore)));
    const oracleObservationsSha256 = digest(Buffer.from(canonicalJson(oracleObservations)));
    const oracleProvenancePath = `${evidenceRoot}/${sourceReceipt.runId}-structured-oracle-provenance.json`;
    const oracleProvenance = {
      format: "agent-mail.capture-provenance/v1",
      runId: oracleReceipt.runId,
      role: oracleReceipt.role,
      receiptSha256: oracleReceiptSha256,
      observations: oracleObservations,
      observationsSha256: oracleObservationsSha256,
      authority: oracleAuthority,
      roots: sourceEnvelope.roots,
      artifacts: Object.fromEntries(
        Object.entries({
          ...oracleReceipt.streams,
          fixture: oracleReceipt.fixture.materialized,
        }).map(([key, ref]) => [key, { path: ref.path, bytes: ref.bytes, sha256: ref.sha256 }]),
      ),
    };
    const oracleProvenanceRef = writeJson(oracleProvenancePath, oracleProvenance);
    oracleReceipt.provenance = {
      format: oracleProvenance.format,
      path: oracleProvenancePath,
      bytes: oracleProvenanceRef.bytes,
      sha256: oracleProvenanceRef.sha256,
      receiptSha256: oracleReceiptSha256,
      observationsSha256: oracleObservationsSha256,
    };
    const structuredOracleCheck = (
      eventText,
      receipt = oracleReceipt,
      step = oracleStepWithAssertion,
    ) => {
      validateExecutableReceipt(receipt, manifest, step, {
        repositoryRoot: root,
        eventBytes: retainedMimeEvents(eventText),
      });
    };
    structuredOracleCheck(oracleEvent);
    const oracleAttacks = [
      oracleEvent.replace("package.json", "README.md"),
      oracleEvent.replace(oracleAssertion.sha256, zeroSha),
      oracleEvent.replace('"/name"', '"/version"'),
      oracleEvent.replace(JSON.stringify(oracleValue), JSON.stringify("detached")),
      oracleEvent.replace('"structured-oracle"', '"wrong-event"'),
    ];
    for (const eventText of oracleAttacks) {
      let rejected = false;
      try {
        structuredOracleCheck(eventText);
      } catch {
        rejected = true;
      }
      assert(rejected, "structured-oracle mutation was accepted");
    }
    const missingFixtureReceipt = structuredClone(oracleReceipt);
    missingFixtureReceipt.assertions = missingFixtureReceipt.assertions.filter(
      (assertion) => assertion.id !== "mime-fixture-observation",
    );
    const missingFixtureStep = {
      ...oracleStepWithAssertion,
      assertions: oracleStepWithAssertion.assertions.filter(
        (assertion) => assertion.id !== "mime-fixture-observation",
      ),
    };
    let missingFixtureRejected = false;
    try {
      structuredOracleCheck(oracleEvent, missingFixtureReceipt, missingFixtureStep);
    } catch {
      missingFixtureRejected = true;
    }
    assert(missingFixtureRejected, "structured-oracle success masked missing MIME fixture metrics");
    const partial = structuredClone(baselineIndex);
    partial.resultRecords = [];
    const partialProjection = materializeCurrent(partial);
    partial.rows = partialProjection.rows;
    partial.gates = partialProjection.gates;
    partial.promotion = { ...partial.promotion, ...partialProjection.promotion };
    assert(
      partial.gates.find((gate) => gate.id === "capacity").status !== "locally verified",
      "partial v2 fixture promoted capacity",
    );
    const attacks = [
      [
        "duplicate disposition",
        (candidate) =>
          candidate.resultRecords.push({
            ...structuredClone(disposition),
            sequence: 4,
            previousRecordDigest: recordDigest(corrected),
          }),
      ],
      [
        "forward disposition target",
        (candidate) => {
          candidate.resultRecords[1].targetSequence = 99;
        },
      ],
      [
        "inactive correction",
        (candidate) => {
          candidate.resultRecords[2].correctedFromSequence = 2;
          candidate.resultRecords[2].correctedFromRecordDigest = recordDigest(disposition);
        },
      ],
      [
        "unbound correction",
        (candidate) => {
          delete candidate.resultRecords[2].correctedFromSequence;
          delete candidate.resultRecords[2].correctedFromRecordDigest;
        },
      ],
      [
        "restoration without disposition",
        (candidate) => {
          candidate.resultRecords.splice(1, 1);
          candidate.resultRecords[1].previousRecordDigest = recordDigest(
            candidate.resultRecords[0],
          );
        },
      ],
    ];
    for (const [name, mutate] of attacks) {
      const candidate = structuredClone(finalIndex);
      validateIndex(candidate, { repositoryRoot: root, allowEmptyBaseline: true });
      mutate(candidate);
      let rejected = false;
      try {
        validateIndex(candidate, { repositoryRoot: root, allowEmptyBaseline: true });
      } catch {
        rejected = true;
      }
      assert(rejected, `composed v2 attack was accepted: ${name}`);
    }
    return {
      root,
      full: finalIndex,
      partial,
      attacks: attacks.length,
      structuredOracleAttacks: oracleAttacks.length,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function runSelfTest() {
  const liveIndexBytes = readFileSync(indexPath);
  const liveIndex = readJson(indexPath);
  validateIndex(liveIndex);
  const liveIndexSnapshot = structuredClone(liveIndex);
  const liveRecordSnapshot = structuredClone(liveIndex.resultRecords);
  const baseline = structuredClone(liveIndex);
  const authoritative = authorities();
  baseline.resultRecords = [];
  baseline.rows = structuredClone(baselineRows(authoritative));
  baseline.gates = structuredClone(baselineGates());
  baseline.promotion = {
    ...baseline.promotion,
    ...promotionState(baseline.rows, baseline.gates),
  };
  validateIndex(baseline, { mode: "prospective", repositoryRoot, allowEmptyBaseline: true });
  assert(
    baseline.gates.find((gate) => gate.id === "capacity")?.status === "unverified",
    "synthetic baseline retained live capacity promotion",
  );
  const clearedLiveIndex = structuredClone(liveIndex);
  clearedLiveIndex.resultRecords = [];
  let staleClearRejected = liveRecordSnapshot.length === 0;
  if (!staleClearRejected) {
    try {
      validateIndex(clearedLiveIndex);
    } catch {
      staleClearRejected = true;
    }
  }
  assert(staleClearRejected, "clearing live records without rematerializing was accepted");
  const corruptLiveIndex = structuredClone(liveIndex);
  let corruptLiveRejected = liveRecordSnapshot.length === 0;
  if (!corruptLiveRejected) {
    corruptLiveIndex.resultRecords[0].bundle.sha256 = "0".repeat(64);
    try {
      validateIndex(corruptLiveIndex);
    } catch {
      corruptLiveRejected = true;
    }
  }
  assert(corruptLiveRejected, "corrupting a live record without writing was accepted");
  const removedLiveIndex = structuredClone(liveIndex);
  removedLiveIndex.resultRecords = [];
  let removedLiveRejected = liveRecordSnapshot.length === 0;
  if (!removedLiveRejected) {
    try {
      validateIndex(removedLiveIndex);
    } catch {
      removedLiveRejected = true;
    }
  }
  assert(removedLiveRejected, "removing a live record without writing was accepted");
  let validFixtureRecord;
  let fullFixtureRecord;
  let partialFixtureIndex;
  let fullFixtureIndex;
  let evidenceCommit;
  let partialRoot;
  let partialBundleBytes;
  let replayRoot;
  let composedV2;
  const isolatedRoot = mkdtempSync("/tmp/release-evidence-fixture-");
  try {
    writeFileSync(join(isolatedRoot, "candidate.js"), "export const fixture = true;\\n");
    for (const testPath of [
      ...new Set(
        requiredCapacitySubgates.flatMap((subgateId) => [
          ...capacityManifest[subgateId].argv.slice(2),
          capacityManifest[subgateId].descriptorPath,
        ]),
      ),
    ]) {
      mkdirSync(join(isolatedRoot, dirname(testPath)), { recursive: true });
      writeFileSync(join(isolatedRoot, testPath), "export const capacityFixture = true;\\n");
    }
    execFileSync("git", ["init", "-q"], { cwd: isolatedRoot });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: isolatedRoot });
    execFileSync("git", ["config", "user.name", "fixture"], { cwd: isolatedRoot });
    execFileSync("git", ["add", "."], { cwd: isolatedRoot });
    execFileSync("git", ["commit", "-qm", "candidate"], { cwd: isolatedRoot });
    const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: isolatedRoot,
      encoding: "utf8",
    }).trim();
    const candidateTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: isolatedRoot,
      encoding: "utf8",
    }).trim();
    const fixtureTimestamp = new Date(
      Date.parse(
        execFileSync("git", ["show", "-s", "--format=%cI", candidateCommit], {
          cwd: isolatedRoot,
          encoding: "utf8",
        }).trim(),
      ),
    ).toISOString();
    const bundlePath = "docs/qualification/evidence/issue-176/bundle.json";
    const subgates = Object.fromEntries(
      requiredCapacitySubgates.map((subgateId) => {
        const manifest = capacityManifest[subgateId];
        const rawPath = `docs/qualification/evidence/issue-176/${subgateId}-raw.json`;
        mkdirSync(join(isolatedRoot, "docs/qualification/evidence/issue-176"), { recursive: true });
        const scale = { [manifest.scale.key]: manifest.scale.minimum, unit: manifest.scale.unit };
        const metrics = Object.fromEntries(
          Object.keys(manifest.metrics).map((metric) => [
            metric,
            metric === "elapsed" ? 1 : manifest.scale.minimum,
          ]),
        );
        const descriptorBytes = execFileSync(
          "git",
          ["cat-file", "blob", `${candidateCommit}:${manifest.descriptorPath}`],
          { cwd: isolatedRoot },
        );
        const descriptorDigest = digest(descriptorBytes);
        const fixtureDigest = descriptorDigest;
        const rawBytes = Buffer.from(
          JSON.stringify({
            subgateId,
            fixtureId: manifest.fixtureId,
            fixtureDigest,
            descriptorPath: manifest.descriptorPath,
            descriptorDigest,
            scale,
            metrics,
            observations: { summary: "pass" },
          }),
        );
        writeFileSync(join(isolatedRoot, rawPath), rawBytes);
        const rawDigest = digest(rawBytes);
        const artifact = (kind, suffix, body) => {
          const path = `docs/qualification/evidence/issue-176/${subgateId}-${suffix}.json`;
          const bytes = Buffer.from(JSON.stringify(body));
          writeFileSync(join(isolatedRoot, path), bytes);
          return { path, sha256: digest(bytes) };
        };
        const correctness = artifact("correctness", "correctness", {
          kind: "correctness",
          subgateId,
          candidateCommit,
          status: "pass",
          oracle: manifest.fixtureId,
        });
        const resources = artifact("resources", "resources", {
          kind: "resources",
          subgateId,
          candidateCommit,
          status: "pass",
          peak: { value: 1, unit: "MiB" },
          retained: { value: 0, unit: "MiB" },
          limits: { peak: 1, retained: 0 },
        });
        const cleanup = artifact("cleanup", "cleanup", {
          kind: "cleanup",
          subgateId,
          candidateCommit,
          status: "pass",
          leaks: { openHandles: 0, processes: 0, files: 0, listeners: 0 },
        });
        return [
          subgateId,
          {
            argv: manifest.argv,
            descriptor: { path: manifest.descriptorPath, sha256: descriptorDigest },
            fixtureIds: [manifest.fixtureId],
            fixtureDigests: [fixtureDigest],
            scale,
            thresholds: Object.entries(manifest.metrics).map(([metric, expected]) => ({
              metric,
              operator: expected.operator,
              limit: metric === "elapsed" ? 300 : manifest.scale.minimum,
              unit: expected.unit,
            })),
            rawSamples: [{ path: rawPath, sha256: rawDigest }],
            observations: { summary: "pass", metrics },
            correctness: {
              status: "pass",
              oracle: { path: correctness.path, sha256: correctness.sha256 },
            },
            resources: {
              status: "pass",
              peak: { value: 1, unit: "MiB" },
              retained: { value: 0, unit: "MiB" },
              limits: { peak: 1, retained: 0 },
            },
            cleanup: {
              status: "pass",
              leaks: { openHandles: 0, processes: 0, files: 0, listeners: 0 },
            },
            artifacts: { correctness, resources, cleanup },
          },
        ];
      }),
    );
    const execution = {
      argv: [
        "bun",
        "test",
        ...new Set(
          requiredCapacitySubgates.flatMap((subgateId) =>
            capacityManifest[subgateId].argv.slice(2),
          ),
        ),
      ],
      startedAt: fixtureTimestamp,
      completedAt: new Date(Date.parse(fixtureTimestamp) + 1000).toISOString(),
      environment: { os: "darwin", arch: "arm64", runtime: "Bun 1.3.14" },
      evidence: { subgates },
      result: "pass",
      observedOutcome: { status: "pass", summary: "All capacity subgates passed." },
    };
    const recordBase = {
      sequence: 1,
      previousRecordDigest: null,
      ownerIssueId: 176,
      mode: "promotion",
      gateId: "capacity",
      obligationIds: ["F30"],
      candidateCommit,
      candidateTree,
      evidenceCommit: candidateCommit,
      bundle: { path: bundlePath, sha256: "0".repeat(64) },
      closure: {},
      ...execution,
    };
    const bundleBytes = Buffer.from(
      JSON.stringify({
        record: canonicalRecordProjection(recordBase),
        execution: canonicalExecutionProjection(recordBase),
      }),
    );
    partialBundleBytes = bundleBytes;
    writeFileSync(join(isolatedRoot, bundlePath), bundleBytes);
    const record = { ...recordBase, bundle: { path: bundlePath, sha256: digest(bundleBytes) } };
    validFixtureRecord = structuredClone(record);
    const fullBundlePath = "docs/qualification/evidence/issue-176/bundle-full.json";
    const fullClosure = {};
    for (const obligationId of ["F17", "F18", "F22", "F23"]) {
      const baselineRow = baseline.rows.find((row) => row.id === obligationId);
      const makeClosureArtifact = (kind) => {
        const suffix = kind === "reproduction" ? "reproduction" : "counterexample";
        const path = `docs/qualification/evidence/issue-176/${obligationId}-${suffix}.json`;
        const proofPath = `docs/qualification/evidence/issue-176/${obligationId}-${suffix}-proof.json`;
        const argv = ["bun", "test", `closure-${obligationId.toLowerCase()}-${suffix}.test.ts`];
        const observedOutcome =
          kind === "reproduction"
            ? { kind: "reproduction", baselineMatch: true, status: "pass" }
            : { kind: "counterexample", baselineMatch: false, status: "pass" };
        const baselineDigest = baselineProofDigest(baselineRow);
        const sourceDescriptors = closureSourceContracts[obligationId].descriptorPaths.map(
          (descriptorPath) => {
            const descriptorBytes = execFileSync(
              "git",
              ["cat-file", "blob", `${candidateCommit}:${descriptorPath}`],
              { cwd: isolatedRoot },
            );
            return { path: descriptorPath, sha256: digest(descriptorBytes) };
          },
        );
        const roleContract = closureSourceContracts[obligationId][kind];
        const receipt = {
          argv,
          exitCode: 0,
          assertions: [{ id: roleContract.assertionId, outcome: roleContract.outcome }],
        };
        const proofBytes = Buffer.from(
          JSON.stringify({
            kind: "closure-proof",
            role: kind,
            obligationId,
            ownerIssueId: 176,
            gateId: "capacity",
            sequence: 1,
            argv,
            candidateCommit,
            candidateTree,
            sourceDescriptors,
            baselineProofDigest: baselineDigest,
            exitCode: 0,
            result: "pass",
            observedOutcome,
            receipt,
          }),
        );
        writeFileSync(join(isolatedRoot, proofPath), proofBytes);
        const proof = { path: proofPath, sha256: digest(proofBytes) };
        const bytes = Buffer.from(
          JSON.stringify({
            kind,
            role: kind,
            obligationId,
            ownerIssueId: 176,
            gateId: "capacity",
            sequence: 1,
            argv,
            candidateCommit,
            candidateTree,
            sourceDescriptors,
            baselineProofDigest: baselineDigest,
            exitCode: 0,
            result: "pass",
            observedOutcome,
            receipt,
            proof,
            status: "pass",
          }),
        );
        writeFileSync(join(isolatedRoot, path), bytes);
        return { argv, proof, artifact: { path, sha256: digest(bytes) } };
      };
      fullClosure[obligationId] = {
        baselineSourceStatusSha256: digest(Buffer.from(baselineRow.sourceStatus)),
        baselineProofDigest: baselineProofDigest(baselineRow),
        originalReproduction: makeClosureArtifact("reproduction"),
        adjacentCounterexample: makeClosureArtifact("counterexample"),
      };
    }
    const fullRecordBase = {
      ...recordBase,
      obligationIds: ["F17", "F18", "F22", "F23", "F30", "SEC-R03", "S04", "S05"],
      bundle: { path: fullBundlePath, sha256: "0".repeat(64) },
      closure: fullClosure,
    };
    const fullBundleBytes = Buffer.from(
      JSON.stringify({
        record: canonicalRecordProjection(fullRecordBase),
        execution: canonicalExecutionProjection(fullRecordBase),
      }),
    );
    writeFileSync(join(isolatedRoot, fullBundlePath), fullBundleBytes);
    fullFixtureRecord = {
      ...fullRecordBase,
      bundle: { path: fullBundlePath, sha256: digest(fullBundleBytes) },
    };
    const baselineForFixture = new Map(baseline.rows.map((row) => [row.id, row]));
    const fixtureIndex = structuredClone(baseline);
    fixtureIndex.resultRecords = [record];
    const fixtureProjection = materializeCurrent(fixtureIndex);
    fixtureIndex.rows = fixtureProjection.rows;
    fixtureIndex.gates = fixtureProjection.gates;
    fixtureIndex.promotion = { ...fixtureIndex.promotion, rule: baseline.promotion.rule };
    partialFixtureIndex = structuredClone(fixtureIndex);
    const fullIndex = structuredClone(baseline);
    fullIndex.resultRecords = [fullFixtureRecord];
    const fullProjection = materializeCurrent(fullIndex);
    fullIndex.rows = fullProjection.rows;
    fullIndex.gates = fullProjection.gates;
    fullIndex.promotion = { ...fullIndex.promotion, rule: baseline.promotion.rule };
    fullFixtureIndex = structuredClone(fullIndex);
    mkdirSync(join(isolatedRoot, "docs/architecture"), { recursive: true });
    validateBundleRecord(record, baselineForFixture, 1, null, isolatedRoot, {
      mode: "prospective",
    });
    validateIndex(fixtureIndex, { mode: "prospective", repositoryRoot: isolatedRoot });
    validateBundleRecord(fullFixtureRecord, baselineForFixture, 1, null, isolatedRoot, {
      mode: "prospective",
    });
    validateIndex(fullIndex, { mode: "prospective", repositoryRoot: isolatedRoot });
    rmSync(join(isolatedRoot, bundlePath));
    execFileSync("git", ["add", "docs/qualification"], { cwd: isolatedRoot });
    execFileSync("git", ["commit", "-qm", "capacity evidence"], { cwd: isolatedRoot });
    evidenceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: isolatedRoot,
      encoding: "utf8",
    }).trim();
    record.evidenceCommit = evidenceCommit;
    fullFixtureRecord.evidenceCommit = evidenceCommit;
    partialFixtureIndex.resultRecords = [record];
    fullFixtureIndex.resultRecords = [fullFixtureRecord];
    const partialProjectionAfterEvidence = materializeCurrent(partialFixtureIndex);
    partialFixtureIndex.rows = partialProjectionAfterEvidence.rows;
    partialFixtureIndex.gates = partialProjectionAfterEvidence.gates;
    partialFixtureIndex.promotion = {
      ...partialFixtureIndex.promotion,
      rule: baseline.promotion.rule,
    };
    const fullProjectionAfterEvidence = materializeCurrent(fullFixtureIndex);
    fullFixtureIndex.rows = fullProjectionAfterEvidence.rows;
    fullFixtureIndex.gates = fullProjectionAfterEvidence.gates;
    fullFixtureIndex.promotion = {
      ...fullFixtureIndex.promotion,
      rule: baseline.promotion.rule,
    };
    writeFileSync(
      join(isolatedRoot, "docs/architecture/release-evidence-index.v1.json"),
      JSON.stringify(fullFixtureIndex),
    );
    execFileSync("git", ["add", "docs/architecture/release-evidence-index.v1.json"], {
      cwd: isolatedRoot,
    });
    execFileSync("git", ["commit", "-qm", "record qualification result"], {
      cwd: isolatedRoot,
    });
    validateBundleRecord(fullFixtureRecord, baselineForFixture, 1, null, isolatedRoot);
    validateIndex(fullFixtureIndex, { repositoryRoot: isolatedRoot });
    partialRoot = mkdtempSync("/tmp/release-evidence-partial-");
    execFileSync("git", ["clone", "-q", isolatedRoot, partialRoot]);
    execFileSync("git", ["checkout", "-q", candidateCommit], { cwd: partialRoot });
    execFileSync(
      "git",
      ["checkout", "-q", evidenceCommit, "--", "docs/qualification/evidence/issue-176"],
      { cwd: partialRoot },
    );
    rmSync(join(partialRoot, fullBundlePath));
    for (const obligationId of ["F17", "F18", "F22", "F23"]) {
      rmSync(
        join(
          partialRoot,
          `docs/qualification/evidence/issue-176/${obligationId}-reproduction.json`,
        ),
      );
      rmSync(
        join(
          partialRoot,
          `docs/qualification/evidence/issue-176/${obligationId}-counterexample.json`,
        ),
      );
      rmSync(
        join(
          partialRoot,
          `docs/qualification/evidence/issue-176/${obligationId}-reproduction-proof.json`,
        ),
      );
      rmSync(
        join(
          partialRoot,
          `docs/qualification/evidence/issue-176/${obligationId}-counterexample-proof.json`,
        ),
      );
    }
    writeFileSync(join(partialRoot, bundlePath), partialBundleBytes);
    execFileSync("git", ["add", "-A", "docs/qualification/evidence/issue-176"], {
      cwd: partialRoot,
    });
    execFileSync("git", ["commit", "-qm", "partial evidence bundle"], { cwd: partialRoot });
    const partialEvidenceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: partialRoot,
      encoding: "utf8",
    }).trim();
    record.evidenceCommit = partialEvidenceCommit;
    partialFixtureIndex.resultRecords = [record];
    mkdirSync(join(partialRoot, "docs/architecture"), { recursive: true });
    writeFileSync(
      join(partialRoot, "docs/architecture/release-evidence-index.v1.json"),
      JSON.stringify(partialFixtureIndex),
    );
    execFileSync("git", ["add", "docs/architecture/release-evidence-index.v1.json"], {
      cwd: partialRoot,
    });
    execFileSync("git", ["commit", "-qm", "partial qualification result"], {
      cwd: partialRoot,
    });
    validateBundleRecord(record, baselineForFixture, 1, null, partialRoot);
    validateIndex(partialFixtureIndex, { repositoryRoot: partialRoot });
    replayRoot = mkdtempSync("/tmp/release-evidence-replay-");
    execFileSync("git", ["clone", "-q", isolatedRoot, replayRoot]);
    execFileSync("git", ["checkout", "-q", candidateCommit], { cwd: replayRoot });
    execFileSync(
      "git",
      ["checkout", "-q", evidenceCommit, "--", "docs/qualification/evidence/issue-176"],
      { cwd: replayRoot },
    );
    const replayRecord = structuredClone(fullFixtureRecord);
    replayRecord.evidenceCommit = candidateCommit;
    const replayClosure = replayRecord.closure.F17;
    const sourceClosure = replayRecord.closure.F18.originalReproduction;
    const replayArtifactPath = "docs/qualification/evidence/issue-176/F17-reproduction.json";
    const replayProofPath = "docs/qualification/evidence/issue-176/F17-reproduction-proof.json";
    const sourceArtifact = JSON.parse(
      readFileSync(join(replayRoot, sourceClosure.artifact.path), "utf8"),
    );
    const sourceProof = JSON.parse(
      readFileSync(join(replayRoot, sourceClosure.proof.path), "utf8"),
    );
    const replayBaselineDigest = baselineProofDigest(baseline.rows.find((row) => row.id === "F17"));
    const replayProof = {
      ...sourceProof,
      obligationId: "F17",
      baselineProofDigest: replayBaselineDigest,
      argv: replayClosure.argv,
      receipt: { ...sourceProof.receipt, argv: replayClosure.argv },
    };
    const replayProofBytes = Buffer.from(JSON.stringify(replayProof));
    writeFileSync(join(replayRoot, replayProofPath), replayProofBytes);
    const replayProofRef = { path: replayProofPath, sha256: digest(replayProofBytes) };
    const replayArtifact = {
      ...sourceArtifact,
      obligationId: "F17",
      baselineProofDigest: replayBaselineDigest,
      argv: replayClosure.argv,
      proof: replayProofRef,
      receipt: replayProof.receipt,
    };
    const replayArtifactBytes = Buffer.from(JSON.stringify(replayArtifact));
    writeFileSync(join(replayRoot, replayArtifactPath), replayArtifactBytes);
    replayClosure.artifact = { path: replayArtifactPath, sha256: digest(replayArtifactBytes) };
    replayClosure.proof = replayProofRef;
    replayClosure.baselineProofDigest = replayBaselineDigest;
    const replayBundleBytes = Buffer.from(
      JSON.stringify({
        record: canonicalRecordProjection(replayRecord),
        execution: canonicalExecutionProjection(replayRecord),
      }),
    );
    writeFileSync(join(replayRoot, fullBundlePath), replayBundleBytes);
    replayRecord.bundle = { path: fullBundlePath, sha256: digest(replayBundleBytes) };
    execFileSync("git", ["add", "docs/qualification/evidence/issue-176"], { cwd: replayRoot });
    execFileSync("git", ["commit", "-qm", "replayed closure evidence"], { cwd: replayRoot });
    const replayEvidenceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: replayRoot,
      encoding: "utf8",
    }).trim();
    replayRecord.evidenceCommit = replayEvidenceCommit;
    const replayIndex = structuredClone(baseline);
    replayIndex.resultRecords = [replayRecord];
    const replayProjection = materializeCurrent(replayIndex);
    replayIndex.rows = replayProjection.rows;
    replayIndex.gates = replayProjection.gates;
    replayIndex.promotion = { ...replayIndex.promotion, rule: baseline.promotion.rule };
    mkdirSync(join(replayRoot, "docs/architecture"), { recursive: true });
    writeFileSync(
      join(replayRoot, "docs/architecture/release-evidence-index.v1.json"),
      JSON.stringify(replayIndex),
    );
    execFileSync("git", ["add", "docs/architecture/release-evidence-index.v1.json"], {
      cwd: replayRoot,
    });
    execFileSync("git", ["commit", "-qm", "replayed closure result"], { cwd: replayRoot });
    let replayRejected = false;
    try {
      validateIndex(replayIndex, { repositoryRoot: replayRoot });
    } catch {
      replayRejected = true;
    }
    assert(replayRejected, "replayed closure proof bypassed source/assertion contract");
    assert(
      partialFixtureIndex.gates.find((gate) => gate.id === "capacity").status === "unverified",
      "partial capacity fixture promoted the gate",
    );
    assert(
      fullFixtureIndex.gates.find((gate) => gate.id === "capacity").status === "locally verified",
      "full capacity fixture did not complete the gate",
    );
    for (const baselineRow of baseline.rows) {
      const fullRow = fullFixtureIndex.rows.find((row) => row.id === baselineRow.id);
      assert(
        fullRow.owner === baselineRow.owner &&
          JSON.stringify(fullRow.ownerIssues) === JSON.stringify(baselineRow.ownerIssues) &&
          fullRow.sourceStatus === baselineRow.sourceStatus &&
          fullRow.sourceProblem === baselineRow.sourceProblem &&
          fullRow.sourceInvariant === baselineRow.sourceInvariant &&
          fullRow.sourceControl === baselineRow.sourceControl &&
          fullRow.sourceProof === baselineRow.sourceProof &&
          fullRow.artifact === baselineRow.artifact &&
          JSON.stringify(fullRow.result) === JSON.stringify(baselineRow.result) &&
          fullRow.status === baselineRow.status &&
          fullRow.proofClass === baselineRow.proofClass,
        `full capacity fixture overwrote baseline history for ${baselineRow.id}`,
      );
    }
    for (const gate of baseline.gates) {
      if (gate.id === "capacity") continue;
      assert(
        JSON.stringify(fullFixtureIndex.gates.find((candidate) => candidate.id === gate.id)) ===
          JSON.stringify(gate),
        `full capacity fixture changed ${gate.id}`,
      );
    }
    assert(
      fullFixtureIndex.promotion.releaseReady === false,
      "full capacity fixture promoted release readiness",
    );
    assert(
      fixtureIndex.promotion.releaseReady === false,
      "capacity fixture promoted release readiness",
    );
    composedV2 = runComposedV2Fixture(baseline);
  } catch (error) {
    rmSync(isolatedRoot, { recursive: true, force: true });
    throw error;
  }
  try {
    const fixture = structuredClone(baseline);
    const fixtureRecord = validFixtureRecord;
    fixture.resultRecords.push(fixtureRecord);
    const fixtureProjection = materializeCurrent(fixture);
    fixture.rows = fixtureProjection.rows;
    fixture.gates = fixtureProjection.gates;
    fixture.promotion = { ...fixture.promotion, rule: baseline.promotion.rule };
    const twiceApplied = structuredClone(fixture);
    const twiceProjection = materializeCurrent(twiceApplied);
    assert(
      JSON.stringify(twiceProjection.rows) === JSON.stringify(fixture.rows) &&
        JSON.stringify(twiceProjection.gates) === JSON.stringify(fixture.gates),
      "result record was applied twice",
    );
    assert(
      fixture.rows.find((row) => row.id === "F30").evidence.capacity === "locally verified",
      "capacity fixture did not update capacity state",
    );
    for (const row of fixture.rows) {
      const original = baseline.rows.find((candidate) => candidate.id === row.id);
      if (row.id !== "F30") {
        assert(
          JSON.stringify(row) === JSON.stringify(original),
          "capacity fixture changed " + row.id,
        );
      }
    }
    const originalF01 = baseline.rows.find((row) => row.id === "F30");
    const fixtureF01 = fixture.rows.find((row) => row.id === "F30");
    assert(
      JSON.stringify({ ...fixtureF01.evidence, capacity: originalF01.evidence.capacity }) ===
        JSON.stringify(originalF01.evidence),
      "capacity fixture changed non-capacity evidence",
    );
    assert(
      JSON.stringify(fixture.gates) === JSON.stringify(baseline.gates),
      "partial capacity fixture changed another gate",
    );
    assert(
      fixture.gates.find((gate) => gate.id === "capacity").status === "unverified",
      "partial capacity fixture promoted the gate",
    );
    assert(fixture.promotion.releaseReady === false, "capacity fixture promoted release readiness");
    const attacks = [
      [
        "forged owner",
        (candidate) => {
          candidate.rows[0].owner = "forged";
        },
      ],
      [
        "forged issue IDs",
        (candidate) => {
          candidate.rows[0].ownerIssues = [999];
        },
      ],
      [
        "forged source status",
        (candidate) => {
          candidate.rows[0].sourceStatus = "release-ready";
        },
      ],
      [
        "red promoted to live",
        (candidate) => {
          candidate.rows.find((row) => row.id === "F04").evidence.liveMutation = "live verified";
        },
      ],
      [
        "red promoted to deployed",
        (candidate) => {
          candidate.rows.find((row) => row.id === "F07").evidence.deployedOperations =
            "deployed verified";
        },
      ],
      [
        "red promoted to release",
        (candidate) => {
          candidate.rows.find((row) => row.id === "F18").status = "release-ready";
        },
      ],
      [
        "detached result",
        (candidate) => {
          candidate.rows[0].result = {
            kind: "retained-proof",
            status: "implemented",
            ref: "detached",
          };
        },
      ],
      [
        "bogus retained path",
        (candidate) => {
          candidate.rows[0].result.kind = "retained-proof";
          candidate.rows[0].result.artifacts = [{ path: "README.md", sha256: "0".repeat(64) }];
        },
      ],
      [
        "retained fingerprint missing one artifact",
        (candidate) => {
          const row = candidate.rows.find((entry) => entry.id === "F30");
          row.result.candidateFingerprint = "6567382";
          row.result.commit = "6567382";
        },
      ],
      [
        "historical proof mixed with worktree digest",
        (candidate) => {
          const row = candidate.rows.find((entry) => entry.id === "F01");
          row.result.artifacts[0].sha256 = digest(
            readFileSync(join(repositoryRoot, row.result.artifacts[0].path)),
          );
        },
      ],
      [
        "blocked row promoted to retained",
        (candidate) => {
          const row = candidate.rows.find((entry) => entry.id === "F13");
          row.proofClass = "retained";
          row.result.kind = "retained-proof";
          row.result.candidateFingerprint = "6567382";
          row.result.commit = "6567382";
        },
      ],
      [
        "proof class relabel",
        (candidate) => {
          candidate.rows[0].proofClass = "blocked";
        },
      ],
      [
        "release-ready incomplete gates",
        (candidate) => {
          candidate.promotion.releaseReady = true;
        },
      ],
      [
        "frozen ID path substitution",
        (candidate) => {
          candidate.frozenInputs[0].path = "docs/planning/EVIDENCE.md";
        },
      ],
      [
        "omitted S row",
        (candidate) => {
          candidate.rows = candidate.rows.filter((row) => row.id !== "S01");
        },
      ],
      [
        "extra S row",
        (candidate) => {
          candidate.rows.push({ ...candidate.rows[0], id: "S99" });
        },
      ],
      [
        "relabelled S row",
        (candidate) => {
          candidate.rows.find((row) => row.id === "S01").id = "S02";
        },
      ],
      [
        "omitted finding row",
        (candidate) => {
          candidate.rows = candidate.rows.filter((row) => row.id !== "F30");
        },
      ],
      [
        "historical F09 release-ready",
        (candidate) => {
          candidate.rows.find((row) => row.id === "F09").status = "release-ready";
        },
      ],
      [
        "child retirement",
        (candidate) => {
          candidate.retirements.push({ id: "F09-P", replacedBy: [] });
        },
      ],
    ];
    const addFixture = (candidate) => {
      candidate.resultRecords.push(structuredClone(fixtureRecord));
      const projection = materializeCurrent(candidate);
      candidate.rows = projection.rows;
      candidate.gates = projection.gates;
    };
    const recordAttacks = [
      [
        "result unauthorized issue #999",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].ownerIssueId = 999;
        },
      ],
      [
        "result missing artifact",
        (candidate) => {
          addFixture(candidate);
          delete candidate.resultRecords[0].bundle;
        },
      ],
      [
        "result bogus digest",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].bundle.sha256 = "0".repeat(64);
        },
      ],
      [
        "result missing artifact at commit",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].bundle.path = "missing-result-artifact.json";
        },
      ],
      [
        "result stale candidate",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].candidateCommit = "0".repeat(40);
        },
      ],
      [
        "result mixed candidate",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords.push({
            ...structuredClone(fixtureRecord),
            sequence: 2,
            previousRecordDigest: "0".repeat(64),
            candidateCommit: "0".repeat(40),
          });
        },
      ],
      [
        "partial capacity promoted",
        (candidate) => {
          addFixture(candidate);
          candidate.gates.find((gate) => gate.id === "capacity").status = "release-ready";
        },
      ],
      [
        "result overwrites red history",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].ownerIssueId = 172;
          candidate.resultRecords[0].obligationIds = ["F04"];
          candidate.resultRecords[0].gateId = "composed";
        },
      ],
      [
        "result duplicate replay",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords.push(structuredClone(fixtureRecord));
        },
      ],
      [
        "result conflicting target",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords.push({
            ...structuredClone(fixtureRecord),
            sequence: 2,
            previousRecordDigest: recordDigest(fixtureRecord),
            result: "blocked",
          });
        },
      ],
      [
        "result downgrade",
        (candidate) => {
          addFixture(candidate);
          candidate.rows.find((row) => row.id === "F01").evidence.capacity = "unverified";
        },
      ],
      [
        "result wrong evidence kind",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].gateId = "security";
        },
      ],
      [
        "result cross gate",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].gateId = "security";
        },
      ],
      [
        "result missing environment",
        (candidate) => {
          addFixture(candidate);
          delete candidate.resultRecords[0].environment.os;
        },
      ],
      [
        "result missing command",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].argv = [];
        },
      ],
      [
        "result missing timestamp",
        (candidate) => {
          addFixture(candidate);
          delete candidate.resultRecords[0].startedAt;
        },
      ],
      [
        "result missing outcome",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].observedOutcome = { status: "fail" };
        },
      ],
      [
        "result-ready aggregation with absent gates",
        (candidate) => {
          addFixture(candidate);
          candidate.promotion.releaseReady = true;
        },
      ],
      [
        "wrong owner/gate tuple #179 security",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].ownerIssueId = 179;
          candidate.resultRecords[0].gateId = "security";
        },
      ],
      [
        "disposition #184 pass",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].ownerIssueId = 184;
          candidate.resultRecords[0].mode = "promotion";
        },
      ],
      [
        "premature #187 delivery",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].ownerIssueId = 187;
          candidate.resultRecords[0].gateId = "delivery";
          candidate.resultRecords[0].obligationIds = ["F30"];
        },
      ],
      [
        "wrong owner/gate tuple #169 composed",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].ownerIssueId = 169;
          candidate.resultRecords[0].gateId = "composed";
        },
      ],
      [
        "wrong closure coverage #185",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].ownerIssueId = 185;
          candidate.resultRecords[0].obligationIds = ["F30"];
        },
      ],
      [
        "unrelated argv",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].argv = ["rm", "-rf", "workspace"];
        },
      ],
      [
        "non-UTC timestamp",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].startedAt = "2026-08-22T01:38:40+08:00";
        },
      ],
      [
        "reversed timestamps",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].completedAt = candidate.resultRecords[0].startedAt;
        },
      ],
      [
        "detached outcome",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].observedOutcome.status = "blocked";
        },
      ],
      [
        "hash chain break",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].previousRecordDigest = "0".repeat(64);
        },
      ],
      [
        "candidate tree mismatch",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].candidateTree = "0".repeat(40);
        },
      ],
      [
        "detached bundle identity",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].bundle.path =
            "docs/architecture/release-evidence-index-check.v1.mjs";
        },
      ],
      [
        "bundle record projection mutation",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].ownerIssueId = 173;
        },
      ],
      [
        "bundle execution projection mutation",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].argv = ["bun", "run", "unrelated"];
        },
      ],
      [
        "capacity threshold mutation",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["mime-250mib"].thresholds[0].limit = 0;
        },
      ],
      [
        "capacity fixture digest mutation",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["fts-250k"].fixtureDigests[0] = "0".repeat(
            64,
          );
        },
      ],
      [
        "capacity raw sample mutation",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["cancellation"].rawSamples[0].sha256 =
            "0".repeat(64);
        },
      ],
      [
        "capacity correctness mutation",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["queue-backpressure"].correctness.status =
            "fail";
        },
      ],
      [
        "capacity resource mutation",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["http-stream-admission"].resources.status =
            "fail";
        },
      ],
      [
        "capacity cleanup mutation",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["lifecycle-leak"].cleanup.leaks = 1;
        },
      ],
      [
        "stale timestamp",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].completedAt = "2020-01-01T00:00:00.000Z";
        },
      ],
      [
        "future timestamp",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].completedAt = "2099-01-01T00:00:00.000Z";
        },
      ],
      [
        "missing capacity subgate",
        (candidate) => {
          addFixture(candidate);
          delete candidate.resultRecords[0].evidence.subgates.cancellation;
        },
      ],
      [
        "extra capacity subgate",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates.extra =
            candidate.resultRecords[0].evidence.subgates.cancellation;
        },
      ],
      [
        "duplicate sample path",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates.cancellation.rawSamples[0].path =
            candidate.resultRecords[0].evidence.subgates["mime-250mib"].rawSamples[0].path;
        },
      ],
      [
        "NaN threshold",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["mime-250mib"].thresholds[0].limit =
            Number.NaN;
        },
      ],
      [
        "negative resource",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["fts-250k"].resources.peak.value = -1;
        },
      ],
      [
        "overflow sample",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["fts-250k"].observations.metrics.rowCount =
            Number.MAX_VALUE;
        },
      ],
      [
        "fixture association mismatch",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["queue-backpressure"].fixtureIds[0] =
            "other-fixture";
        },
      ],
      [
        "artifact traversal",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates.cancellation.artifacts.cleanup.path =
            "docs/qualification/evidence/issue-176/../secret.json";
        },
      ],
      [
        "source artifact authority",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates.cancellation.rawSamples[0].path =
            "packages/imap/src/raw-download.ts";
        },
      ],
      [
        "record argv semantic mismatch",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].argv = [
            "bun",
            "test",
            "packages/imap/test/idle-session-p3-c18.test.ts",
          ];
        },
      ],
      [
        "wrong threshold direction",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["mime-250mib"].thresholds[0].operator = ">";
        },
      ],
      [
        "wrong threshold unit",
        (candidate) => {
          addFixture(candidate);
          candidate.resultRecords[0].evidence.subgates["mime-250mib"].thresholds[0].unit = "MiB";
        },
      ],
      [
        "omitted closure",
        (candidate) => {
          delete candidate.resultRecords[0].closure.F17;
        },
      ],
      [
        "forged closure baseline digest",
        (candidate) => {
          candidate.resultRecords[0].closure.F17.baselineSourceStatusSha256 = "0".repeat(64);
        },
      ],
      [
        "missing closure reproduction",
        (candidate) => {
          delete candidate.resultRecords[0].closure.F17.originalReproduction;
        },
      ],
      [
        "missing closure counterexample",
        (candidate) => {
          delete candidate.resultRecords[0].closure.F17.adjacentCounterexample;
        },
      ],
      [
        "historical closure overwrite",
        (candidate) => {
          candidate.rows.find((row) => row.id === "F17").result.status = "pass";
        },
      ],
      [
        "evidence commit detached from current HEAD",
        (candidate) => {
          candidate.resultRecords[0].evidenceCommit = candidate.resultRecords[0].candidateCommit;
        },
      ],
      [
        "closure artifact replay from another run",
        (candidate) => {
          const closure = candidate.resultRecords[0].closure.F17;
          const other = candidate.resultRecords[0].closure.F18.originalReproduction;
          closure.originalReproduction = structuredClone(other);
        },
      ],
      [
        "closure alternate owner root",
        (candidate) => {
          candidate.resultRecords[0].closure.F17.originalReproduction.artifact.path =
            "docs/qualification/evidence/issue-017/F17-reproduction.json";
        },
      ],
    ];
    const validationOptions = {
      repositoryRoot: isolatedRoot,
      memoizeValid: true,
    };
    let validBeforeMutation = 0;
    for (const [name, mutate] of [...attacks, ...recordAttacks]) {
      const candidate = structuredClone(fullFixtureIndex);
      validateIndex(candidate, validationOptions);
      validBeforeMutation += 1;
      mutate(candidate);
      let rejected = false;
      try {
        validateIndex(candidate, validationOptions);
      } catch {
        rejected = true;
      }
      assert(rejected, "self-test attack was accepted: " + String(name));
    }
    assert(
      Buffer.compare(readFileSync(indexPath), liveIndexBytes) === 0 &&
        JSON.stringify(readJson(indexPath)) === JSON.stringify(liveIndexSnapshot),
      "live index changed during self-test",
    );
    assert(
      liveIndex.resultRecords.length === liveRecordSnapshot.length &&
        liveIndex.resultRecords.every(
          (record, index) => recordDigest(record) === recordDigest(liveRecordSnapshot[index]),
        ),
      "live result record history changed during self-test",
    );
    const v2Execution = runV2ExecutionSelfTest();
    return {
      attacks: attacks.length + recordAttacks.length,
      validBeforeMutation,
      positiveCapacityFixture: true,
      replayRejected: true,
      liveIndexUnchanged: true,
      liveRecordCount: liveRecordSnapshot.length,
      staleClearRejected: true,
      corruptLiveRejected: true,
      doubleApplicationStable: true,
      v2Execution,
      accepted: true,
    };
  } finally {
    if (composedV2?.root) rmSync(composedV2.root, { recursive: true, force: true });
    if (replayRoot) rmSync(replayRoot, { recursive: true, force: true });
    if (partialRoot) rmSync(partialRoot, { recursive: true, force: true });
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = process.argv.includes("--self-test")
    ? runSelfTest()
    : validateIndex(readJson(indexPath));
  console.log(JSON.stringify(result));
}
