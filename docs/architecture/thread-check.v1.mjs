import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ORACLE_SHA256 = "cddac2500b0a71a5e51525aa42e827b3e487a65aeaf9ad5f5405f39d9de70239";
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
  examples: 18,
  properties: 11,
  obligations: 8,
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
]);
const observedCaseTags = new Set(oracle.examples.flatMap(({ caseTags = [] }) => caseTags));
for (const tag of requiredCaseTags)
  if (!observedCaseTags.has(tag)) fail(`missing required case ${tag}`);

for (const example of oracle.examples) {
  if (example.base !== undefined && !exampleIds.has(example.base)) {
    fail(`${example.id} references unknown base ${example.base}`);
  }
}

for (const input of oracle.frozenInputs) {
  const bytes = readFileSync(join(repositoryRoot, input.path));
  const digest = sha256(bytes);
  if (digest !== input.sha256) fail(`${input.id} digest ${digest} != ${input.sha256}`);
}

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

const placeholder = readFileSync(
  join(repositoryRoot, "packages/storage/src/search-summary-hydration-repository.ts"),
  "utf8",
);
if (!placeholder.includes("'thread:' || substr(cp.message_id, 9) AS thread_id")) {
  fail("UC02 placeholder evidence changed; re-audit the contradiction ledger");
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
      status: "ok",
    },
    null,
    2,
  ),
);
