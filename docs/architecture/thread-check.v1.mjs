import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ORACLE_SHA256 = "e24efd672113aa5743ef776c3c3add502eea509512cc0573febc7b1d3b1ea269";
const architectureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(architectureDirectory, "../..");
const oraclePath = join(architectureDirectory, "thread-oracle.v1.json");
const viewPaths = [
  join(architectureDirectory, "thread-design.v1.md"),
  join(architectureDirectory, "thread-decisions.v1.md"),
  join(architectureDirectory, "thread-coverage.v1.md"),
];

function fail(message) {
  throw new Error(`thread design check failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readFrozenAuthority(input) {
  if (input.gitCommit === undefined) return readFileSync(join(repositoryRoot, input.path));
  if (!/^[0-9a-f]{40}$/u.test(input.gitCommit)) fail(`${input.id} has invalid gitCommit`);
  try {
    return execFileSync("git", ["show", `${input.gitCommit}:${input.path}`], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    fail(`${input.id} committed authority ${input.gitCommit}:${input.path} is unreadable`);
  }
}

function uniqueIds(items, label) {
  const ids = items.map(({ id }) => id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) fail(`${label} has invalid ID`);
  if (new Set(ids).size !== ids.length) fail(`${label} has duplicate ID`);
  return new Set(ids);
}

function exactSet(actual, expected, label) {
  if (actual.size !== expected.size || [...actual].some((item) => !expected.has(item))) {
    fail(`${label} differs: ${JSON.stringify([...actual].sort())}`);
  }
}

function everyReferenceExists(values, ids, label) {
  if (!Array.isArray(values) || values.length === 0) fail(`${label} is empty`);
  for (const value of values) if (!ids.has(value)) fail(`${label} references unknown ${value}`);
}

const oracleBytes = readFileSync(oraclePath);
const oracleDigest = sha256(oracleBytes);
if (oracleDigest !== EXPECTED_ORACLE_SHA256) {
  fail(`oracle digest ${oracleDigest} != ${EXPECTED_ORACLE_SHA256}`);
}

const oracle = JSON.parse(oracleBytes.toString("utf8"));
if (oracle.format !== "agent-mail.thread-oracle/v1" || oracle.schemaVersion !== 1) {
  fail("unsupported oracle format or schema version");
}
if (oracle.oracle?.normative !== true) fail("oracle is not normative");
if (oracle.limits?.anchorsPerMessage !== 2 + 100 + 32) fail("anchor bound is inconsistent");
if (oracle.limits?.threadPageMaximum !== 100 || oracle.limits?.participantMaximum !== 256) {
  fail("public bounds drifted");
}

const requirementIds = uniqueIds(oracle.requirements, "requirements");
const decisionIds = uniqueIds(oracle.decisions, "decisions");
const exampleIds = uniqueIds(oracle.examples, "examples");
const propertyIds = uniqueIds(oracle.properties, "properties");
const obligationIds = uniqueIds(oracle.implementationObligations, "implementation obligations");
const contradictionIds = uniqueIds(oracle.upstreamContradictions, "upstream contradictions");

const expectedCounts = {
  requirements: 13,
  decisions: 18,
  examples: 19,
  properties: 11,
  obligations: 10,
  contradictions: 3,
};
for (const [label, expected] of Object.entries(expectedCounts)) {
  const actual =
    label === "obligations"
      ? obligationIds.size
      : label === "contradictions"
        ? contradictionIds.size
        : new Map([
            ["requirements", requirementIds.size],
            ["decisions", decisionIds.size],
            ["examples", exampleIds.size],
            ["properties", propertyIds.size],
          ]).get(label);
  if (actual !== expected) fail(`${label} count ${actual} != ${expected}`);
}

const coverageIds = new Set(Object.keys(oracle.coverage));
exactSet(coverageIds, requirementIds, "coverage requirements");
for (const [requirementId, coverage] of Object.entries(oracle.coverage)) {
  everyReferenceExists(coverage.decisions, decisionIds, `${requirementId}.decisions`);
  everyReferenceExists(coverage.examples, exampleIds, `${requirementId}.examples`);
  everyReferenceExists(coverage.properties, propertyIds, `${requirementId}.properties`);
  everyReferenceExists(coverage.obligations, obligationIds, `${requirementId}.obligations`);
}
for (const [label, allIds, referenced] of [
  [
    "decision",
    decisionIds,
    new Set(Object.values(oracle.coverage).flatMap(({ decisions }) => decisions)),
  ],
  [
    "example",
    exampleIds,
    new Set(Object.values(oracle.coverage).flatMap(({ examples }) => examples)),
  ],
  [
    "property",
    propertyIds,
    new Set(Object.values(oracle.coverage).flatMap(({ properties }) => properties)),
  ],
  [
    "implementation obligation",
    obligationIds,
    new Set(Object.values(oracle.coverage).flatMap(({ obligations }) => obligations)),
  ],
]) {
  for (const id of allIds)
    if (!referenced.has(id)) fail(`${label} ${id} has no requirement coverage`);
}

const requiredCaseTags = new Set([
  "two-message-reply",
  "branched-replies",
  "missing-headers",
  "malformed-adversarial-ids",
  "duplicate-message-id",
  "cross-mailbox-copies",
  "late-root",
  "late-bridge-merge",
  "tombstoned-member",
  "equal-timestamps",
  "restart",
  "backup-restore",
  "unknown-thread",
  "pagination-identity-recovery-empty-continuation",
]);
const observedCaseTags = new Set(oracle.examples.flatMap(({ caseTags = [] }) => caseTags));
for (const tag of requiredCaseTags)
  if (!observedCaseTags.has(tag)) fail(`missing required case ${tag}`);

for (const example of oracle.examples) {
  if (example.base !== undefined && !exampleIds.has(example.base)) {
    fail(`${example.id} references unknown base ${example.base}`);
  }
}

const frozenInputById = new Map(oracle.frozenInputs.map((input) => [input.id, input]));
const downstreamWorktreeDrift = [];
for (const input of oracle.frozenInputs) {
  const bytes = readFrozenAuthority(input);
  const digest = sha256(bytes);
  if (digest !== input.sha256) fail(`${input.id} digest ${digest} != ${input.sha256}`);
  if (input.gitCommit !== undefined) {
    try {
      const worktreeDigest = sha256(readFileSync(join(repositoryRoot, input.path)));
      if (worktreeDigest !== digest) {
        downstreamWorktreeDrift.push({
          id: input.id,
          authoritySha256: digest,
          worktreeSha256: worktreeDigest,
        });
      }
    } catch {
      downstreamWorktreeDrift.push({
        id: input.id,
        authoritySha256: digest,
        worktreeSha256: null,
      });
    }
  }
}

const liveRecoveryExample = oracle.examples.find(
  ({ id }) => id === "EX-LIVE-PAGINATION-IDENTITY-RECOVERY-EMPTY",
);
if (
  liveRecoveryExample?.firstPageExpected?.successStatus !== 200 ||
  liveRecoveryExample.firstPageExpected.messageCount !== 3 ||
  liveRecoveryExample.firstPageExpected.messageIds?.length !== 2 ||
  liveRecoveryExample.continuationRequest?.limit !== 2 ||
  liveRecoveryExample.recovery?.sentAt !== "2025-01-01T00:00:00.000Z" ||
  liveRecoveryExample?.continuationExpected?.successStatus !== 200 ||
  liveRecoveryExample.continuationExpected.messageCount !== 3 ||
  liveRecoveryExample.continuationExpected.messageIds?.length !== 0 ||
  liveRecoveryExample.continuationExpected.messages?.length !== 0 ||
  liveRecoveryExample.continuationExpected.nextCursor !== null ||
  liveRecoveryExample.freshInitialExpected?.messageIds?.length < 1 ||
  liveRecoveryExample.freshInitialExpected.emptyAllowed !== false
) {
  fail("identity-recovery empty-continuation counterexample drifted");
}
if (
  typeof oracle.pagination?.serviceBoundary?.classificationOrder !== "string" ||
  typeof oracle.pagination?.serviceBoundary?.initialKnown !== "string" ||
  typeof oracle.pagination?.serviceBoundary?.knownContinuation !== "string" ||
  typeof oracle.pagination?.serviceBoundary?.emptyContinuation !== "string" ||
  typeof oracle.pagination?.serviceBoundary?.nextCursor !== "string"
) {
  fail("live page service-boundary rule is incomplete");
}
exactSet(
  new Set(oracle.implementationObligations.map(({ issue }) => issue)),
  new Set([137, 195, 198, 199]),
  "downstream issue owners",
);

const viewTexts = viewPaths.map((path) => readFileSync(path, "utf8"));
for (const [index, text] of viewTexts.entries()) {
  if (!text.includes(EXPECTED_ORACLE_SHA256)) fail(`view ${index + 1} omits oracle digest`);
}
for (const id of decisionIds)
  if (!viewTexts[1].includes(`\`${id}\``)) fail(`decision view omits ${id}`);
for (const id of requirementIds)
  if (!viewTexts[2].includes(`\`${id}\``)) fail(`coverage view omits ${id}`);
for (const id of contradictionIds)
  if (!viewTexts[2].includes(`\`${id}\``)) fail(`coverage view omits ${id}`);

for (const standard of oracle.primaryStandards) {
  if (!standard.url.startsWith("https://www.rfc-editor.org/rfc/")) {
    fail(`${standard.id} is not an RFC Editor primary source`);
  }
  if (
    !viewTexts[0].includes(standard.url) &&
    !viewTexts[0].includes(standard.url.replace(/#.*$/u, ""))
  ) {
    fail(`design view omits primary source ${standard.id}`);
  }
}

const placeholderInput = frozenInputById.get("P4-C07-SEARCH-SUMMARY");
if (placeholderInput === undefined) fail("UC02 frozen input is missing");
const placeholder = readFrozenAuthority(placeholderInput).toString("utf8");
if (!placeholder.includes("'thread:' || substr(cp.message_id, 9) AS thread_id")) {
  fail("UC02 placeholder evidence changed; re-audit the contradiction ledger");
}

const acceptedContractInput = frozenInputById.get("P6-C04-THREAD-CONTRACT");
if (acceptedContractInput === undefined) fail("UC01 frozen input is missing");
const acceptedContract = readFrozenAuthority(acceptedContractInput).toString("utf8");
if (
  !acceptedContract.includes("messageIds: z.array(messageIdSchema).min(1).max(100)") ||
  !acceptedContract.includes("messages: z.array(hydratedMessageSchema).min(1).max(100)")
) {
  fail("UC01 accepted contract evidence changed; re-audit the contradiction ledger");
}

console.log(
  JSON.stringify(
    {
      oracleSha256: oracleDigest,
      frozenInputs: oracle.frozenInputs.length,
      requirements: requirementIds.size,
      decisions: decisionIds.size,
      examples: exampleIds.size,
      requiredCaseTags: requiredCaseTags.size,
      properties: propertyIds.size,
      obligations: obligationIds.size,
      contradictions: contradictionIds.size,
      views: viewPaths.length,
      authorityMode: "committed-blob-when-gitCommit-is-present",
      downstreamWorktreeDrift,
      status: "ok",
    },
    null,
    2,
  ),
);
