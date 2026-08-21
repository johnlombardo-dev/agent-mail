import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  return execFileSync("rg", ["--files", "-g", "!node_modules/**", "-g", "!dist/**"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
    .trim()
    .split("\n")
    .filter(Boolean);
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

function checkGates(index) {
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
    assert(gate.status === "unverified", `${gate.id} promoted without a retained gate result`);
    assert(
      gate.result?.kind === "unverified" && typeof gate.result.reason === "string",
      `${gate.id} result is not explicit`,
    );
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

export function validateIndex(index) {
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
  checkFrozenInputs(index);
  checkGates(index);
  const expectedIds = [...authority.findingRows.keys(), ...authority.shields.keys()];
  assert(
    Array.isArray(index.rows) && index.rows.length === expectedIds.length,
    `row count ${index.rows?.length} != ${expectedIds.length}`,
  );
  const seen = new Set();
  for (const row of index.rows) {
    assert(typeof row?.id === "string" && !seen.has(row.id), `missing or duplicate row ${row?.id}`);
    seen.add(row.id);
    checkSourceRow(row, authority);
  }
  for (const id of expectedIds) assert(seen.has(id), `index omits ${id}`);
  assert(
    Array.isArray(index.retirements) && index.retirements.length === 1,
    "retirement accounting is incomplete",
  );
  const retirement = index.retirements[0];
  assert(
    retirement.id === "F09" &&
      JSON.stringify(retirement.replacedBy) === JSON.stringify(["F09-P", "F09-R"]),
    "F09 retirement drifted",
  );
  for (const child of ["F09-P", "F09-R"])
    assert(
      !index.retirements.some((entry) => entry.id === child),
      `${child} was incorrectly retired`,
    );
  const releaseReady =
    index.rows.every((row) => row.status === "release-ready") &&
    index.gates.every((gate) => gate.status === "release-ready");
  assert(
    index.promotion?.releaseReady === releaseReady,
    "releaseReady is not derived from complete gates",
  );
  assert(
    index.promotion.releaseReady === false,
    "releaseReady must remain false for this candidate",
  );
  return {
    rowCount: index.rows.length,
    findingRows: authority.findingRows.size,
    shieldRows: authority.shields.size,
    gates: index.gates.length,
    releaseReady,
    sourceDigests: Object.fromEntries(index.frozenInputs.map((input) => [input.id, input.sha256])),
  };
}

export function runSelfTest() {
  const baseline = readJson(indexPath);
  validateIndex(baseline);
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
  for (const [name, mutate] of attacks) {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    let rejected = false;
    try {
      validateIndex(candidate);
    } catch {
      rejected = true;
    }
    assert(rejected, `self-test attack was accepted: ${String(name)}`);
  }
  return { attacks: attacks.length, accepted: true };
}

if (import.meta.main) {
  const result = process.argv.includes("--self-test")
    ? runSelfTest()
    : validateIndex(readJson(indexPath));
  console.log(JSON.stringify(result));
}
