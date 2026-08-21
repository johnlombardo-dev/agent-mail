import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");
const indexPath = join(here, "release-evidence-index.v1.json");
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

function validateResultRecords(indexData, baselineRows, options = {}) {
  assert(Array.isArray(indexData.resultRecords), "resultRecords must be append-only array");
  const baseline = new Map(baselineRows.map((row) => [row.id, row]));
  const seenTargets = new Set();
  let previousDigest = null;
  const validationRoot = options.repositoryRoot ?? repositoryRoot;
  const evidenceHead = options.repositoryRoot
    ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: validationRoot, encoding: "utf8" }).trim()
    : currentCommit();
  let priorRecords = [];
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
    const ownerRule = validateBundleRecord(
      record,
      baseline,
      recordIndex + 1,
      previousDigest,
      validationRoot,
      options,
    );
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
        record.bundle.path,
        ...((record.evidence?.subgates ?? {}) &&
          Object.values(record.evidence.subgates).flatMap((subgate) =>
            (subgate.rawSamples ?? []).map((sample) => sample.path),
          )),
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
      "docs/architecture/release-evidence-index.v1.json",
      record.bundle.path,
    ]);
    if (record.evidence?.subgates) {
      for (const subgate of Object.values(record.evidence.subgates)) {
        for (const sample of subgate.rawSamples ?? []) allowed.add(sample.path);
        for (const artifact of Object.values(subgate.artifacts ?? {}))
          if (artifact?.path) allowed.add(artifact.path);
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
    for (const obligationId of record.obligationIds) {
      const target = `${record.gateId}:${obligationId}`;
      assert(!seenTargets.has(target), `result sequence ${record.sequence} duplicates ${target}`);
      seenTargets.add(target);
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
  for (const record of records) {
    if (record.result !== "pass") continue;
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
            record.gateId === gate.id && record.mode === "promotion" && record.result === "pass",
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

export function runSelfTest() {
  const baseline = readJson(indexPath);
  validateIndex(baseline);
  let validFixtureRecord;
  let fullFixtureRecord;
  let partialFixtureIndex;
  let fullFixtureIndex;
  let evidenceCommit;
  let partialRoot;
  let partialBundleBytes;
  let replayRoot;
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
    return {
      attacks: attacks.length + recordAttacks.length,
      validBeforeMutation,
      positiveCapacityFixture: true,
      replayRejected: true,
      accepted: true,
    };
  } finally {
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
