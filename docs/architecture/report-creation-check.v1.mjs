import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ORACLE_SHA256 = "c8410a8204222685439ecca252362ac76510c13b767639ab39574ecc6ef83919";
const EXPECTED_VIEW_SHA256 = [
  "c597139f52f2680cfad7dc945e29ebaadc543cd9c99a31d91eb328bc94e20355",
  "87617987cbe4b1faaadf8d95e73e56bce774cd9d6f7f47125b2dd61910470b98",
  "eee62e122827d59fe410bc755c753b50946d8b64270a69991169d3bb1fdeb334",
];
const ACCEPTED_HEAD = "bd6ad478cf99f9ea9f3f25981c9d3044fabfef61";
const IMPLEMENTATION_BASE = "4f79eb54ff1442dcd12d3cf8771861c4ae6e15ce";
const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(directory, "../..");
const oraclePath = join(directory, "report-creation-oracle.v1.json");
const viewPaths = [
  join(directory, "report-creation-design.v1.md"),
  join(directory, "report-creation-decisions.v1.md"),
  join(directory, "report-creation-coverage.v1.md"),
];

function fail(message) {
  throw new Error("report creation check failed: " + message);
}

function writeStdout(value) {
  return new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(value, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
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

function exact(actual, expected, label) {
  if (stable(actual) !== stable(expected)) fail(label + " differs: " + stable(actual));
}

function exactSet(actual, expected, label) {
  exact([...actual].sort(), [...expected].sort(), label);
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail(label + " is empty");
}

function uniqueRows(rows, key, label) {
  if (!Array.isArray(rows) || rows.length === 0) fail(label + " is empty");
  const values = rows.map((row) => row[key]);
  if (
    values.some(
      (value) =>
        (typeof value !== "string" || value.length === 0) &&
        (typeof value !== "number" || !Number.isSafeInteger(value)),
    )
  ) {
    fail(label + " has an invalid " + key);
  }
  if (new Set(values).size !== values.length) fail(label + " has duplicate " + key);
  return new Map(rows.map((row) => [row[key], row]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readCommitted(path) {
  try {
    return execFileSync("git", ["show", ACCEPTED_HEAD + ":" + path], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    fail("cannot read accepted input " + ACCEPTED_HEAD + ":" + path);
  }
}

function requireCommit(commit, label) {
  try {
    execFileSync("git", ["cat-file", "-e", commit + "^{commit}"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    fail(label + " commit is unavailable: " + commit);
  }
}

function requireAcceptedAncestor(commit, label) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ACCEPTED_HEAD], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    fail(label + " is not an ancestor of accepted head: " + commit);
  }
}

function metadataEntries(metadata) {
  return Object.keys(metadata)
    .map((key) => ({ encoded: Buffer.from(JSON.stringify(key), "utf8"), key }))
    .sort((left, right) => Buffer.compare(left.encoded, right.encoded))
    .map(({ key }) => [key, metadata[key]]);
}

function identityFor(authority, input) {
  const material = JSON.stringify([
    authority.domain,
    input.accountId,
    input.principal,
    input.title,
    input.sourceMessageIds,
    metadataEntries(input.metadata),
  ]);
  const fingerprint = sha256(Buffer.from(material, "utf8"));
  const requestMaterial = JSON.stringify([authority.creationRequestDomain, fingerprint]);
  return {
    material,
    fingerprint,
    reportId: "report:" + fingerprint,
    creationRequestId: "request:" + sha256(Buffer.from(requestMaterial, "utf8")),
  };
}

function canonicalStringBytes(value) {
  if (typeof value !== "string") fail("canonical string input is not a string");
  return Buffer.from(JSON.stringify(value), "utf8");
}

function assertCanonicalStringRoundTrip(value, label) {
  const bytes = canonicalStringBytes(value);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = JSON.parse(decoded);
  if (typeof parsed !== "string" || parsed !== value) fail(label + " does not round trip");
  if (!bytes.equals(canonicalStringBytes(parsed))) fail(label + " is not canonically serialized");
  return bytes;
}

function requireExactRows(map, expected, label) {
  exactSet([...map.keys()], expected, label + " IDs");
}

function validateFrozenInputs(oracle, { checkSources = false } = {}) {
  const expected = {
    PLAN: ["PLAN.md", "6daf232f6d2895b3e76bdde9a8fb51da31b4506d8c2b2cab7544147ddf6257ce"],
    EVIDENCE: [
      "docs/planning/EVIDENCE.md",
      "92ad4982f2d2edc94acae40f7b7fd5b149a674ecf6600823ff895f1a29c9b87e",
    ],
    METRICS: ["METRICS.md", "5c286a31365fe9b84108d38875724395ca4281b041ab9d9b24d4b998db22ec3c"],
    "REPORT-CONTRACT": [
      "packages/contracts/src/report-admin-operations.ts",
      "6378e599f9325c03892924422494a31a34d90d9a9ad72f9155defc89127aa27f",
    ],
    "REPORT-RENDERER": [
      "packages/contracts/src/report-renderer.ts",
      "43ad589f76ea1b08552619e4452884df903de140cda0429ff7086849f43a71c6",
    ],
    "HTTP-ERROR-AUTHORITY": [
      "packages/contracts/src/http-error-authority.ts",
      "e300cdc29f27f3184080020e149a999f4f1da736b323fe16f1f31732d7fc28f5",
    ],
    "ERROR-ENVELOPE": [
      "packages/contracts/src/error-envelope.ts",
      "511a6ef675f87237a1394cfc81ac9b7d94f7d6031e0922ea4e062a1f0040ddb6",
    ],
    "REPORT-HANDLERS": [
      "packages/daemon/src/report-admin-handlers.ts",
      "4c06cf25443a0b5c915078145843e491d69c63d0ffdfb96d893bcbf7d874661c",
    ],
    "REPORT-SERVING": [
      "packages/daemon/src/report-serving.ts",
      "8a5cbe5d374f4c8cb177397c456128cbfb3db6006def3f4f418e1561879b1412",
    ],
    "HTTP-BOUNDARY": [
      "packages/daemon/src/http.ts",
      "89037a9d849b13a8cbf9e62879959ac3427879aba6512f879cf2fb73273c3e05",
    ],
    "TRUSTED-AUTH-CONTEXT": [
      "packages/daemon/src/trusted-auth-context.ts",
      "e69b1bd6001d332d027b0a22c4202901e7bd9d6490ce631d15aa8b730ff0fb70",
    ],
    "SINGLE-MESSAGE-INGESTION": [
      "packages/daemon/src/single-message-ingestion.ts",
      "f6b20ddd61e243a9b9568320ed094bba5d8c46a94f3ed87d067a2a76cbfb7b7c",
    ],
    "MIME-PARSER": [
      "packages/imap/src/mime-parser.ts",
      "e003194a3655f7c5aeec105d13e9a55be05328d84df606b833394d86c6d6a600",
    ],
    "CANONICAL-PROMOTION": [
      "packages/storage/src/canonical-promotion.ts",
      "2f3d081efbd15f3ad12935e723bd2d1194b45fba03d1798cd4d4bcf912f50173",
    ],
    "CANONICAL-PROMOTION-TEST": [
      "packages/storage/test/canonical-promotion-p2-c13.test.ts",
      "b594e06c2efdbc1e950ebb6413f4e5bbad6301225f6cf457ea5686f4b273210a",
    ],
    "REMOTE-PLACEMENT-OBSERVATION-TEST": [
      "packages/storage/test/remote-placement-observation-p3-c12.test.ts",
      "ee9af0c34cb929ffd0f8a930b28f92e97a11663ea68d6408c18537d5f5183385",
    ],
    "SEARCH-CORPUS-TEST": [
      "packages/storage/test/search-corpus-p4-c16.test.ts",
      "d9f50b9a75413d4d4fd3d724b7856390bf954abd7e3035020694f4120b42b92b",
    ],
    "BACKUP-RESTORE-PARITY-TEST": [
      "packages/storage/test/backup-restore-parity-p2-c19.test.ts",
      "cb30d41422d62576356ba561a14d16e47c288bcebfc5f97cc68c8f33e1083dde",
    ],
    "PROMOTION-ADAPTER": [
      "packages/storage/src/promotion-adapter.ts",
      "f1e588e4316390c495a3b1a6af402982c9a8f30869c224fc7fd03155ed2cd6f2",
    ],
    "STRUCTURED-CONTENT-MIGRATION": [
      "packages/storage/src/migrations/0002-structured-content.ts",
      "77d14d98925f5a60762f00d242abab5f9d6c049e638b63d1c4f0faae6534c010",
    ],
    "MESSAGE-BLOB-REFERENCES-MIGRATION": [
      "packages/storage/src/migrations/0003-message-blob-references.ts",
      "30ab3805fbcd0a2cb88c85dacc2896d8787b83a3291bb61cdf788b5ef97ab979",
    ],
    "BLOB-PROMOTION": [
      "packages/storage/src/blob-promotion.ts",
      "7eb895e21beb16ff5b081d121835104845e4ac6f1be80672d23dfb8ba33035d7",
    ],
    DATABASE: [
      "packages/storage/src/database.ts",
      "f6af053b4a29b944ef2323906038080be3700a9c339acd10c60a5aab26c0f8df",
    ],
    "MIGRATION-RUNNER": [
      "packages/storage/src/migration-runner.ts",
      "b3774cb89373ac527df8cd1a86f06c47fe89637c785a98d81c7546ec62a6ced0",
    ],
    "STORAGE-INDEX": [
      "packages/storage/src/index.ts",
      "3fd855f2502ab69f34e3f5edf23230e08d48b4c185734179f101153e561d50e8",
    ],
    "BACKUP-MANIFEST": [
      "packages/storage/src/backup-manifest.ts",
      "edfae5713e3209d9483bbc08d8e75d8ede438308459551f7b0ce106115102ac7",
    ],
    "BACKUP-WRITER": [
      "packages/storage/src/backup-writer.ts",
      "c1a7b1ded5b0dbf99bbc827d15806aa999ab679ec8d72d5f6ddabb58075b4129",
    ],
    "BACKUP-RESTORE": [
      "packages/storage/src/backup-restore.ts",
      "4f954adaf189fccf13430e9847ab7725d350e68c05eaf0d1352854d6d7f3ccc5",
    ],
    "CLI-CLIENT": [
      "packages/cli/src/client.ts",
      "ee587cd36b0879a7e5fbc688d6767513351970146e7f25087fa98e724ecd3797",
    ],
    "CLI-REGISTRY": [
      "packages/cli/src/command-registry.ts",
      "7bf11d1b61b2c9021b498d72e914b70ebc2364331fe1cea5684468fca5347097",
    ],
    "CLI-OUTCOME": [
      "packages/cli/src/command-outcome.ts",
      "10bfe2929de187658471c85125402864549c65a0508792f35b0822aa60282d50",
    ],
    "CLI-OUTPUT-CONTEXT": [
      "packages/cli/src/output-context.ts",
      "5e0812f3f82da977f5349cd30a264a9af58ea8ff25ae9402e86c8cb60f28641c",
    ],
    "CLI-OUTCOME-ORACLE": [
      "docs/architecture/cli-command-outcome-oracle.v1.json",
      "428c4043a5cfa031d237bf9638911b8a2ec71d7c919c11dacfde31b70f3bcfa8",
    ],
    "MIGRATION-REGISTRY-ORACLE": [
      "docs/architecture/database-migration-registry-oracle.v1.json",
      "08d817c11ba3d1a8f213f9254fdb792f43e9384b1a70471788c59497cb432345",
    ],
    "MIGRATION-REGISTRY-CHECKER": [
      "docs/architecture/database-migration-registry-check.v1.mjs",
      "bb420394846b1f34ee1dc00c77b5b94f1198f1aa37d24eace3a7513c69f7d5de",
    ],
    "MIGRATION-REGISTRY-DESIGN": [
      "docs/architecture/database-migration-registry-design.v1.md",
      "d88a844683490e20da12ba57a4f99496ee97878e777e00ae407d5e78f8b61609",
    ],
    "MIGRATION-REGISTRY-DECISIONS": [
      "docs/architecture/database-migration-registry-decisions.v1.md",
      "38feb62fae9dc733ed41dd2c1a0bfe23147e3237c64f081abcf12c0c4d3d2c0e",
    ],
    "MIGRATION-REGISTRY-COVERAGE": [
      "docs/architecture/database-migration-registry-coverage.v1.md",
      "ca2454f35a5f84ae87db783e1fccc7c2d3acb12aa61fafe5bbb5e29696cd03d6",
    ],
    "MIGRATION-REGISTRY": [
      "packages/storage/src/migration-registry.ts",
      "846fae2accd33257a87d3688eeef0e6a267bb6f3c629df2b54b0f4f4601174a0",
    ],
    "MIGRATION-HISTORY-CONVERSION": [
      "packages/storage/src/migration-history-conversion.ts",
      "d23e9767a5145a532ccb5f5123693d8d1782a69f20bbefcc71a6922a1b9665cb",
    ],
    "MIGRATION-REGISTRY-TEST": [
      "packages/storage/test/migration-registry.test.ts",
      "c22932c218eeb767ad29e2030a2e5902c9c5c922926a7c59df208c0d6aec69db",
    ],
    "MIGRATION-HISTORY-CONVERSION-TEST": [
      "packages/storage/test/migration-history-conversion.test.ts",
      "587172453926385307b1f8100cdf1698674490708d485106ffd5d72f9590a1d8",
    ],
    "MIGRATION-RUNNER-TEST": [
      "packages/storage/test/migration-runner.test.ts",
      "d6ecda0f83c120d3c9f18111f4d6502ede848b333c64150ea36a9d36139a1447",
    ],
  };
  const rows = uniqueRows(oracle.frozenInputs, "id", "frozen inputs");
  requireExactRows(rows, Object.keys(expected), "frozen inputs");
  for (const [id, [path, digest]] of Object.entries(expected)) {
    const row = rows.get(id);
    exact([row.path, row.sha256], [path, digest], "frozen input " + id);
    if (!/^(?:baseline|implementation-baseline|public-frozen)$/u.test(row.kind)) {
      fail("frozen input " + id + " has invalid kind");
    }
    if (checkSources) {
      const observed = sha256(readCommitted(path));
      if (observed !== digest) fail("accepted input digest drift for " + id + ": " + observed);
    }
  }
}

function validateOracle(oracle, { checkSources = false } = {}) {
  exact(
    [oracle.format, oracle.schemaVersion, oracle.modelVersion, oracle.status],
    ["agent-mail.report-creation-oracle/v1", 1, "1.0.0", "frozen-design"],
    "oracle header",
  );
  exact(
    [
      oracle.oracle.normative,
      oracle.oracle.signable,
      oracle.oracle.signatureState,
      oracle.oracle.issue,
      oracle.oracle.acceptedHead,
    ],
    [true, true, "signed", 231, ACCEPTED_HEAD],
    "oracle authority",
  );
  nonempty(oracle.oracle.description, "oracle description");
  nonempty(oracle.oracle.scope, "oracle scope");
  nonempty(oracle.oracle.compatibilityRule, "compatibility rule");
  nonempty(oracle.oracle.implementationRule, "implementation rule");

  const resolved = uniqueRows(oracle.resolvedAuthorities, "id", "resolved authorities");
  requireExactRows(
    resolved,
    ["AUTH-CAPACITY-POLICY-A", "AUTH-MIGRATION-SLOT-28"],
    "resolved authorities",
  );
  const capacityResolution = resolved.get("AUTH-CAPACITY-POLICY-A");
  exact(
    [capacityResolution.status, capacityResolution.choice],
    ["selected-and-frozen", "A"],
    "capacity resolution",
  );
  nonempty(capacityResolution.source, "capacity resolution source");
  nonempty(capacityResolution.rule, "capacity resolution rule");
  const migrationResolution = resolved.get("AUTH-MIGRATION-SLOT-28");
  exact(
    [
      migrationResolution.status,
      migrationResolution.dependencies,
      migrationResolution.architectureCommit,
      migrationResolution.architectureOracleSha256,
      migrationResolution.implementationCommit,
      migrationResolution.predecessorRegistryIdentitySha256,
      migrationResolution.historicalConversionTargetVersion,
      migrationResolution.historicalConversionTargetSha256,
      migrationResolution.predecessorSchemaVersion,
      migrationResolution.migrationVersion,
      migrationResolution.migrationPath,
    ],
    [
      "accepted-and-consumed",
      [233, 234],
      "2fd5b0eaf993b9f44068bd0f61552fc84479129a",
      "08d817c11ba3d1a8f213f9254fdb792f43e9384b1a70471788c59497cb432345",
      IMPLEMENTATION_BASE,
      "39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab",
      27,
      "39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab",
      27,
      28,
      "packages/storage/src/migrations/0028-report-creation.ts",
    ],
    "migration resolution",
  );
  nonempty(migrationResolution.rule, "migration resolution rule");

  const artifactRows = uniqueRows(oracle.acceptedArtifacts, "issue", "accepted artifacts");
  exactSet(
    [...artifactRows.keys()],
    [107, 141, 155, 206, 213, 214, 233, 234],
    "accepted issue chain",
  );
  const expectedCommits = new Map([
    [107, "a3f12f2"],
    [141, "dd224e5"],
    [155, "778e01b"],
    [206, "20e4d0e"],
    [213, "f4a3604"],
    [214, "b9aafae"],
    [233, "2fd5b0eaf993b9f44068bd0f61552fc84479129a"],
    [234, IMPLEMENTATION_BASE],
  ]);
  for (const [issue, commit] of expectedCommits) {
    exact(artifactRows.get(issue).commit, commit, "accepted artifact #" + issue);
    nonempty(artifactRows.get(issue).use, "accepted artifact use #" + issue);
    if (checkSources) {
      requireCommit(commit, "accepted artifact #" + issue);
      requireAcceptedAncestor(commit, "accepted artifact #" + issue);
    }
  }
  exact(
    artifactRows.get(213).oracleSha256,
    "428c4043a5cfa031d237bf9638911b8a2ec71d7c919c11dacfde31b70f3bcfa8",
    "#213 oracle digest",
  );
  exact(
    [artifactRows.get(233).oracleSha256, artifactRows.get(233).registryIdentitySha256],
    [
      "08d817c11ba3d1a8f213f9254fdb792f43e9384b1a70471788c59497cb432345",
      "39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab",
    ],
    "#233 authority digests",
  );

  if (checkSources) {
    requireCommit(ACCEPTED_HEAD, "accepted head");
  }
  validateFrozenInputs(oracle, { checkSources });

  const requirementRows = uniqueRows(oracle.requirements, "id", "requirements");
  requireExactRows(
    requirementRows,
    [
      "REQ-IDENTITY",
      "REQ-SOURCE",
      "REQ-RENDER",
      "REQ-DURABILITY",
      "REQ-PROVENANCE",
      "REQ-REPLAY",
      "REQ-SERVING",
      "REQ-CLI",
      "REQ-CAPACITY",
      "REQ-STRING-ROUNDTRIP",
      "REQ-DOWNSTREAM",
    ],
    "requirements",
  );
  for (const row of requirementRows.values()) nonempty(row.text, row.id + " text");

  exact(
    oracle.publicBoundary,
    {
      operationKey: "reports.create",
      route: "/v1/reports",
      method: "POST",
      cliName: "reports-create",
      commandPath: ["reports", "create"],
      scope: "reports:write",
      streaming: "none",
      strictness: "strict",
      requestKeys: ["title", "sourceMessageIds", "metadata"],
      responseKeys: ["reportId", "title", "citations", "authorization", "createdAt"],
      schemaDisposition: "unchanged",
      schemaRationale: oracle.publicBoundary.schemaRationale,
      firstCreateSourceScope: "mail:read.message",
      httpBodyHardCapBytes: 1048576,
    },
    "public boundary",
  );
  nonempty(oracle.publicBoundary.schemaRationale, "public schema rationale");

  const identity = oracle.identityAuthority;
  exact(
    [identity.version, identity.domain, identity.creationRequestDomain],
    [1, "agent-mail/report-create/v1", "agent-mail/report-create-request/v1"],
    "identity versions",
  );
  for (const key of [
    "material",
    "metadataOrdering",
    "stringSerialization",
    "stringComparison",
    "fingerprint",
    "reportId",
    "creationRequestMaterial",
    "creationRequestId",
    "accountRule",
    "orderRule",
    "replayRule",
    "replayReadProjection",
    "replayAuthorizationRule",
    "collisionRule",
    "concurrencyRule",
  ]) {
    nonempty(identity[key], "identity " + key);
  }
  const vector = identity.knownVector;
  const computed = identityFor(identity, vector);
  exact(
    computed,
    {
      material: vector.material,
      fingerprint: vector.fingerprint,
      reportId: vector.reportId,
      creationRequestId: vector.creationRequestId,
    },
    "identity known vector",
  );
  const corpus = uniqueRows(identity.stringRoundTripCorpus, "id", "string round-trip corpus");
  requireExactRows(
    corpus,
    [
      "astral",
      "nfd",
      "nfc",
      "bidi",
      "isolated-high-surrogate",
      "isolated-low-surrogate",
      "long-principal",
    ],
    "string round-trip corpus",
  );
  const corpusValues = new Map([
    ["astral", corpus.get("astral").value],
    ["nfd", corpus.get("nfd").value],
    ["nfc", corpus.get("nfc").value],
    ["bidi", corpus.get("bidi").value],
    ["isolated-high-surrogate", JSON.parse(corpus.get("isolated-high-surrogate").canonicalJson)],
    ["isolated-low-surrogate", JSON.parse(corpus.get("isolated-low-surrogate").canonicalJson)],
    ["long-principal", "p".repeat(255) + "\ud800"],
  ]);
  for (const [id, value] of corpusValues) assertCanonicalStringRoundTrip(value, id);
  exact(corpusValues.get("long-principal").length, 256, "long principal code-unit length");
  if (corpusValues.get("nfd") === corpusValues.get("nfc")) fail("NFD and NFC corpus collapsed");
  if (
    canonicalStringBytes(corpusValues.get("nfd")).equals(
      canonicalStringBytes(corpusValues.get("nfc")),
    )
  ) {
    fail("NFD and NFC canonical bytes collapsed");
  }

  const source = oracle.sourceAuthority;
  exact(source.projectionVersion, 1, "source projection version");
  for (const key of [
    "resolutionOrder",
    "eligibility",
    "placementRule",
    "plainSelection",
    "htmlFallback",
    "forbiddenContent",
    "snapshotRule",
    "servingRule",
    "citationRule",
  ]) {
    nonempty(source[key], "source " + key);
  }
  const sourceOutcomes = uniqueRows(source.outcomes, "case", "source outcomes");
  exact(
    [...sourceOutcomes.values()].map((row) => [row.case, row.publicCode, row.status, row.writes]),
    [
      [
        "eligible-active-account-text",
        "success",
        200,
        "exact replay with no write, or one retained rate-ledger attempt followed by one atomic report publication",
      ],
      [
        "missing-message",
        "not_found",
        404,
        "one retained rate-ledger attempt; zero report publication writes",
      ],
      [
        "identity-only-message",
        "not_found",
        404,
        "one retained rate-ledger attempt; zero report publication writes",
      ],
      [
        "all-configured-account-placements-tombstoned",
        "not_found",
        404,
        "one retained rate-ledger attempt; zero report publication writes",
      ],
      [
        "cross-account-only-active-placement",
        "not_found",
        404,
        "one retained rate-ledger attempt; zero report publication writes",
      ],
      [
        "textless-normalized-projection",
        "not_found",
        404,
        "one retained rate-ledger attempt and zero report publication writes; an exact textless legacy projection may already have been materialized",
      ],
    ],
    "source outcomes",
  );

  const normalizedText = oracle.normalizedTextAuthority;
  exact(
    [
      normalizedText.projectionVersion,
      normalizedText.table,
      normalizedText.primaryKey,
      normalizedText.maxNormalizedTextUtf8Bytes,
      normalizedText.maxNormalizedTextJsonBytes,
    ],
    [1, "message_text_projections", "message_id, projection_version", 8388608, 50331650],
    "normalized text authority",
  );
  for (const key of [
    "productionRule",
    "parserRule",
    "rowRule",
    "foreignKey",
    "immutabilityRule",
    "futureIngestionRule",
    "legacyMaterializerRule",
    "materializerTransitionRule",
    "legacyConcurrencyRule",
    "reportRule",
    "backupRule",
    "proofRule",
  ]) {
    nonempty(normalizedText[key], "normalized text " + key);
  }
  exact(normalizedText.columns.length, 8, "normalized text column count");
  normalizedText.columns.forEach((column, index) =>
    nonempty(column, "normalized text column " + index),
  );
  exact(
    normalizedText.materializerStates,
    [
      "checking-existing",
      "verifying-raw",
      "staging-exact-bytes",
      "parsing-production-mime",
      "publishing-projection",
      "cleaning-stage",
      "available",
      "failed-clean",
    ],
    "materializer states",
  );

  const model = oracle.reportModelAuthority;
  exact(
    [model.modelVersion, model.rendererVersion, model.sectionHeading],
    [1, 1, "Source evidence"],
    "model authority",
  );
  exact(
    model.rendererBinding,
    "packages/contracts/src/report-renderer.ts at SHA-256 43ad589f76ea1b08552619e4452884df903de140cda0429ff7086849f43a71c6",
    "renderer binding",
  );
  for (const key of [
    "title",
    "summary",
    "claimRule",
    "excerptRule",
    "metadataRule",
    "renderRule",
    "serveRule",
    "hostileRule",
  ]) {
    nonempty(model[key], "model " + key);
  }

  const persistence = oracle.persistenceAuthority;
  exact(
    [
      persistence.logicalMigrationName,
      persistence.migrationVersion,
      persistence.migrationPath,
      persistence.migrationTestPath,
      persistence.registryPath,
      persistence.registryTestPath,
      persistence.predecessorSchemaVersion,
      persistence.predecessorRegistryIdentitySha256,
      persistence.migrationDependencies,
      persistence.databaseOnly,
      persistence.transactionMode,
    ],
    [
      "report-creation-v1",
      28,
      "packages/storage/src/migrations/0028-report-creation.ts",
      "packages/storage/test/report-creation-migration.test.ts",
      "packages/storage/src/migration-registry.ts",
      "packages/storage/test/migration-registry.test.ts",
      27,
      "39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab",
      [233, 234],
      true,
      "BEGIN IMMEDIATE",
    ],
    "persistence authority",
  );
  const prefixEvolution = persistence.prefixEvolutionAuthority;
  exact(
    [
      prefixEvolution.architectureCommit,
      prefixEvolution.architectureOracleSha256,
      prefixEvolution.implementationCommit,
      prefixEvolution.predecessorVersion,
      prefixEvolution.historicalTargetVersion,
      prefixEvolution.historicalTargetRegistrySha256,
      prefixEvolution.reportVersion,
      prefixEvolution.registryPath,
      prefixEvolution.converterPath,
      prefixEvolution.conversionCompositionTestPath,
      prefixEvolution.beforePendingMigrationHook,
      prefixEvolution.legacyConversionSequence,
      prefixEvolution.implementationSequenceMode,
      prefixEvolution.implementationSequenceMutationIds,
      prefixEvolution.legacyFixtureRecorder,
      prefixEvolution.legacyFixtureRunner,
      prefixEvolution.strictMigrationRunner,
      prefixEvolution.implementationCompatibilityMode,
      prefixEvolution.safeRecorderSequence,
      prefixEvolution.implementationCompatibilityMutationIds,
    ],
    [
      "2fd5b0eaf993b9f44068bd0f61552fc84479129a",
      "08d817c11ba3d1a8f213f9254fdb792f43e9384b1a70471788c59497cb432345",
      IMPLEMENTATION_BASE,
      27,
      27,
      "39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab",
      28,
      "packages/storage/src/migration-registry.ts",
      "packages/storage/src/migration-history-conversion.ts",
      "packages/storage/test/migration-history-conversion.test.ts",
      "verifyCanonicalMigrationPrefixState",
      [
        "resolve the sole accepted historical target before conversion and freeze targetVersion 27 plus digest 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab",
        "derive targetMigrations as canonicalDatabaseMigrations.slice(0, targetVersion); never iterate the complete live registry",
        "inside one BEGIN IMMEDIATE execute only missing targetMigrations 1..27, install conversion infrastructure, insert the immutable target-27 provenance row, rewrite schema_migrations exactly to targetMigrations 1..27, and set user_version exactly 27",
        "verify the complete target-27 state and commit without executing, ledgering, or setting user_version for any migration above targetVersion",
        "after conversion returns, the production opener always invokes applyMigrations with the complete live registry and beforePendingMigration; this common suffix path is not confined to a non-legacy else branch",
        "each pending 28-or-later definition runs in its own BEGIN IMMEDIATE transaction only after verifyCanonicalMigrationPrefixState accepts the locked predecessor",
      ],
      "--implementation-sequence-check",
      ["converter-live-tip-loop", "legacy-opener-skips-suffix-runner"],
      "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures",
      "runMigrations",
      "applyMigrations",
      "--implementation-compatibility-check",
      [
        "the real legacy converter commits and verifies only explicit historical target 27, then returns without observing slot 28",
        "the common production opener routes pending slot 28 through strict applyMigrations and the inside-BEGIN beforePendingMigration prefix verifier",
        "after the complete live registry reaches exact current tip 28, the opener verifies canonical migration state and database integrity before recorder invocation",
        "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures synchronously and independently verifies registry-derived current-tip user_version, exact ordered history, complete sqlite_schema tuples, strict immutable conversion rows, and the grammar-valid reindex overlay before changing its module-private WeakMap",
        "runMigrations recomputes and byte-compares the complete recorded fingerprint before a zero-write legacy-fixture compatibility no-op; applyMigrations never reads compatibility state and remains strict",
      ],
      [
        "legacy-fixture-fingerprint-bypass",
        "legacy-fixture-failure-stores-expected-fingerprint",
        "strict-runner-compatibility-bypass",
      ],
    ],
    "prefix evolution authority",
  );
  nonempty(prefixEvolution.rule, "prefix evolution rule");
  exact(
    [
      migrationResolution.architectureCommit,
      migrationResolution.architectureOracleSha256,
      migrationResolution.implementationCommit,
      migrationResolution.predecessorSchemaVersion,
      migrationResolution.historicalConversionTargetVersion,
      migrationResolution.historicalConversionTargetSha256,
      migrationResolution.migrationVersion,
    ],
    [
      prefixEvolution.architectureCommit,
      prefixEvolution.architectureOracleSha256,
      prefixEvolution.implementationCommit,
      prefixEvolution.predecessorVersion,
      prefixEvolution.historicalTargetVersion,
      prefixEvolution.historicalTargetRegistrySha256,
      prefixEvolution.reportVersion,
    ],
    "resolved/persistence migration authority",
  );
  nonempty(persistence.migrationRule, "migration rule");
  nonempty(persistence.tablePolicy, "persistence table policy");
  const tables = uniqueRows(persistence.tables, "name", "persistence tables");
  requireExactRows(
    tables,
    ["reports", "report_artifacts", "report_source_snapshots", "report_sources"],
    "persistence tables",
  );
  for (const row of tables.values()) {
    if (row.immutable !== true) fail(row.name + " must be immutable");
    nonempty(row.purpose, row.name + " purpose");
    nonempty(row.primaryKey, row.name + " primary key");
    if (!Array.isArray(row.unique) || !Array.isArray(row.columns) || row.columns.length === 0) {
      fail(row.name + " omits unique or column authority");
    }
    row.columns.forEach((column, index) => nonempty(column, row.name + " column " + index));
  }
  exactSet(
    persistence.requiredReportColumns,
    [
      "report_id",
      "fingerprint_sha256",
      "identity_material_json",
      "account_id_json",
      "owner_principal_json",
      "create_scope",
      "read_scope",
      "authorization_method",
      "authorization_request_id",
      "authorization_at",
      "request_body_sha256",
      "created_at",
      "title_json",
      "metadata_json",
      "source_count",
    ],
    "report columns",
  );
  exactSet(
    persistence.requiredArtifactColumns,
    [
      "report_id",
      "model_version",
      "projection_version",
      "renderer_version",
      "model_json",
      "model_sha256",
      "markdown_sha256",
      "html_sha256",
      "csp_sha256",
      "model_bytes",
      "markdown_bytes",
      "html_bytes",
    ],
    "artifact columns",
  );
  exactSet(
    persistence.requiredSnapshotColumns,
    [
      "owner_principal_json",
      "account_id_json",
      "message_id",
      "projection_version",
      "source_text_json",
      "source_text_sha256",
      "source_text_bytes",
      "created_at",
    ],
    "snapshot columns",
  );
  exactSet(
    persistence.requiredSourceColumns,
    [
      "report_id",
      "ordinal",
      "owner_principal_json",
      "account_id_json",
      "message_id",
      "projection_version",
      "citation_label",
      "source_text_sha256",
    ],
    "source-link columns",
  );
  const describedColumnNames = (name) =>
    tables.get(name).columns.map((column) => column.slice(0, column.indexOf(" ")));
  exactSet(
    describedColumnNames("reports"),
    persistence.requiredReportColumns,
    "described report columns",
  );
  exactSet(
    describedColumnNames("report_artifacts"),
    persistence.requiredArtifactColumns,
    "described artifact columns",
  );
  exactSet(
    describedColumnNames("report_source_snapshots"),
    persistence.requiredSnapshotColumns,
    "described snapshot columns",
  );
  exactSet(
    describedColumnNames("report_sources"),
    persistence.requiredSourceColumns,
    "described source-link columns",
  );
  exact(
    tables.get("reports").unique,
    [
      "fingerprint_sha256",
      "authorization_request_id",
      "report_id, owner_principal_json, account_id_json",
    ],
    "report unique keys",
  );
  exact(tables.get("report_artifacts").unique, [], "artifact unique keys");
  exact(
    tables.get("report_source_snapshots").unique,
    ["owner_principal_json, account_id_json, message_id, projection_version, source_text_sha256"],
    "snapshot unique keys",
  );
  exact(tables.get("report_sources").unique, ["report_id, message_id"], "source-link unique keys");
  exactSet(
    persistence.foreignKeys,
    [
      "report_artifacts.report_id -> reports.report_id, DEFERRABLE INITIALLY DEFERRED",
      "report_source_snapshots.message_id -> messages.message_id, immediate",
      "report_sources.(report_id,owner_principal_json,account_id_json) -> reports.(report_id,owner_principal_json,account_id_json), DEFERRABLE INITIALLY DEFERRED",
      "report_sources.(owner_principal_json,account_id_json,message_id,projection_version,source_text_sha256) -> report_source_snapshots.(owner_principal_json,account_id_json,message_id,projection_version,source_text_sha256), DEFERRABLE INITIALLY DEFERRED",
    ],
    "report foreign keys",
  );
  exactSet(
    persistence.indexes,
    [
      "reports_owner_account_created on reports(owner_principal_json,account_id_json,created_at,report_id)",
      "report_snapshots_owner_account_bytes on report_source_snapshots(owner_principal_json,account_id_json,source_text_bytes,message_id)",
      "report_sources_snapshot_lookup on report_sources(owner_principal_json,account_id_json,message_id,projection_version,source_text_sha256,report_id)",
    ],
    "report indexes",
  );
  if (persistence.canonicalSerializations.length !== 5) {
    fail("canonical serialization authority differs");
  }
  persistence.canonicalSerializations.forEach((value, index) =>
    nonempty(value, "canonical serialization " + index),
  );
  const duplicateGuards = uniqueRows(
    persistence.duplicateInsertGuards,
    "table",
    "duplicate insert guards",
  );
  requireExactRows(
    duplicateGuards,
    ["reports", "report_artifacts", "report_source_snapshots", "report_sources"],
    "duplicate insert guards",
  );
  exact(
    [...duplicateGuards.values()].map((row) => row.trigger),
    [
      "reports_reject_duplicate_insert",
      "report_artifacts_reject_duplicate_insert",
      "report_source_snapshots_reject_duplicate_insert",
      "report_sources_reject_duplicate_insert",
    ],
    "duplicate insert trigger names",
  );
  for (const row of duplicateGuards.values()) {
    nonempty(row.when, row.table + " duplicate when");
    nonempty(row.effect, row.table + " duplicate effect");
  }
  if (persistence.publicationGuards.length !== 6) fail("publication guard count differs");
  persistence.publicationGuards.forEach((value, index) =>
    nonempty(value, "publication guard " + index),
  );
  exact(persistence.transactionSteps.length, 11, "transaction step count");
  persistence.transactionSteps.forEach((step, index) =>
    nonempty(step, "transaction step " + index),
  );
  exactSet(
    persistence.failureInjectionBoundaries,
    [
      "after-initial-replay-miss",
      "after-rate-admission",
      "after-source-resolution",
      "after-render",
      "after-publication-begin",
      "after-capacity-admission",
      "after-artifact-stage",
      "after-each-source-link",
      "after-each-snapshot",
      "after-final-report-insert",
      "after-read-back",
      "before-publication-commit",
    ],
    "failure injection boundaries",
  );
  for (const key of ["schemaRules", "orphanRule", "reopenRule", "backupRule", "restoreRule"]) {
    nonempty(persistence[key], "persistence " + key);
  }

  const provenance = oracle.provenanceAuthority;
  exact(
    [
      provenance.createScope,
      provenance.readScope,
      provenance.sourceReadScope,
      provenance.authorizationMethod,
    ],
    ["reports:write", "reports:read", "mail:read.message", "bearer"],
    "provenance fixed values",
  );
  for (const key of [
    "owner",
    "account",
    "firstCreateScopeRule",
    "replayScopeRule",
    "methodRule",
    "requestId",
    "authorizedAt",
    "requestBodySha256",
    "handlerContextChange",
  ]) {
    nonempty(provenance[key], "provenance " + key);
  }
  exact(
    provenance.missingSourceScopePostcondition,
    {
      rateLedgerAttemptsCommitted: 1,
      rateLedgerAttemptsRetained: 1,
      sourceReads: 0,
      materializerInvocations: 0,
      messageTextProjectionWrites: 0,
      reportWrites: 0,
      artifactWrites: 0,
      citationWrites: 0,
      capacityTotalWrites: 0,
      publicationWrites: 0,
      zeroTotalWritesClaim: false,
      totalWriteRule: provenance.missingSourceScopePostcondition.totalWriteRule,
      instrumentationRule: provenance.missingSourceScopePostcondition.instrumentationRule,
    },
    "missing source-scope postcondition",
  );
  nonempty(
    provenance.missingSourceScopePostcondition.totalWriteRule,
    "missing source-scope total-write rule",
  );
  nonempty(
    provenance.missingSourceScopePostcondition.instrumentationRule,
    "missing source-scope instrumentation rule",
  );
  exactSet(
    provenance.forbiddenSources,
    [
      "request title",
      "sourceMessageIds",
      "metadata",
      "x-correlation-id",
      "x-forwarded-user",
      "tailscale-user-login",
      "User-Agent",
      "filesystem path",
      "report model",
      "stored caller object",
    ],
    "forbidden provenance sources",
  );

  const serving = oracle.servingAuthority;
  exact(
    [
      serving.reportRoute,
      serving.reportScope,
      serving.sourceRoute,
      serving.sourceScope,
      serving.reportContentType,
      serving.sourceContentType,
    ],
    [
      "/v1/reports/{reportId}",
      "reports:read",
      "/v1/messages/{messageId}/text",
      "mail:read.message",
      "text/html; charset=utf-8",
      "text/plain; charset=utf-8",
    ],
    "serving boundary",
  );
  for (const key of [
    "repositoryRule",
    "defenseInDepth",
    "reportIntegrity",
    "sourceIntegrity",
    "notFoundRule",
  ]) {
    nonempty(serving[key], "serving " + key);
  }
  exactSet(
    serving.headers,
    [
      "Content-Security-Policy: accepted REPORT_CONTENT_SECURITY_POLICY",
      "Cache-Control: private, no-store",
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: no-referrer",
    ],
    "serving headers",
  );

  const cli = oracle.cliAuthority;
  exact(
    [cli.adapter, cli.argv, cli.successRule.includes("#214")],
    ["runReportCreateCommand", ["reports", "create"], true],
    "CLI adapter",
  );
  for (const key of ["inputRule", "successRule", "humanSafety", "failureRule", "composedRule"]) {
    nonempty(cli[key], "CLI " + key);
  }
  exact(
    cli.humanLines,
    [
      "report id: <reportId>",
      "title: <title>",
      "created: <createdAt>",
      "authorized principal: <authorization.principal>",
      "authorization method: <authorization.method>",
      "authorization scope: <authorization.scope>",
      "request id: <authorization.requestId>",
      "source: <citation.label> <citation.id> for each citation in order",
    ],
    "CLI human lines",
  );
  exact(
    cli.errorMappings,
    [
      { codes: ["invalid_request", "request_too_large"], semanticKind: "invalid_input", exit: 65 },
      { codes: ["not_found"], semanticKind: "not_found", exit: 66 },
      {
        codes: [
          "missing_credentials",
          "invalid_credentials",
          "expired_credentials",
          "insufficient_scope",
        ],
        semanticKind: "authorization",
        exit: 77,
      },
      { codes: ["internal_error"], semanticKind: "internal", exit: 70 },
    ],
    "CLI error mappings",
  );

  const capacity = oracle.capacityAuthority;
  exact(
    [
      capacity.selectedPolicy,
      capacity.httpRequestBytes,
      capacity.maxIdentityMaterialBytes,
      capacity.maxMetadataJsonBytes,
      capacity.maxSourceIds,
      capacity.maxSourceProjectionBytesEach,
      capacity.maxSourceProjectionBytesTotal,
      capacity.maxSourceProjectionJsonBytesEach,
      capacity.maxSourceProjectionJsonBytesTotal,
      capacity.maxClaimExcerptBytesEach,
      capacity.maxModelJsonBytes,
      capacity.maxRenderedMarkdownBytes,
      capacity.maxRenderedHtmlBytes,
      capacity.maxCommittedReports,
      capacity.maxLogicalChargedBytes,
      capacity.maxNonReplayAttemptsPerRollingWindow,
      capacity.rollingWindowMilliseconds,
    ],
    [
      "A",
      1048576,
      1048576,
      1048576,
      100,
      10485760,
      10485760,
      50331650,
      62914760,
      4096,
      1048576,
      16777216,
      16777216,
      10000,
      2147483648,
      10,
      60000,
    ],
    "capacity values",
  );
  for (const key of [
    "httpAdmissionRule",
    "admissionOrder",
    "admissionRule",
    "rateLedgerRule",
    "rateAdmissionRule",
    "logicalChargeRule",
    "accountAdmissionRule",
    "capacityOutcome",
    "memoryRule",
    "durableGrowthRule",
    "retentionRule",
    "cleanupRule",
    "restoreAccountingRule",
    "configurationRule",
  ]) {
    nonempty(capacity[key], "capacity " + key);
  }
  exact(capacity.rateLedgerTable, "report_create_rate_windows", "rate ledger table");
  exact(
    capacity.admissionSequence,
    [
      "reports:write-authorization",
      "bounded-body-parse",
      "canonical-identity",
      "identity-single-flight",
      "metadata-only-exact-replay",
      "durable-rate-ledger-admission",
      "account-capacity-read",
      "mail:read.message-authorization",
      "source-resolution-and-materialization",
      "bounded-model-and-render",
      "publication-BEGIN-IMMEDIATE",
      "publication-exact-replay-recheck",
      "count-and-logical-charge-admission",
      "report-publication",
    ],
    "capacity admission sequence",
  );
  const rateAdmissionIndex = capacity.admissionSequence.indexOf("durable-rate-ledger-admission");
  const mailReadIndex = capacity.admissionSequence.indexOf("mail:read.message-authorization");
  if (rateAdmissionIndex < 0 || mailReadIndex < 0 || rateAdmissionIndex >= mailReadIndex) {
    fail("rate admission must precede mail:read.message authorization");
  }
  nonempty(capacity.writeInstrumentationRule, "capacity write instrumentation rule");

  const disposition = oracle.serviceDispositionAuthority;
  nonempty(disposition.coreRule, "service disposition core rule");
  nonempty(disposition.ownershipRule, "service disposition ownership rule");
  nonempty(disposition.messageRule, "service disposition message rule");
  nonempty(disposition.rollbackRule, "service disposition rollback rule");
  const terminalRows = uniqueRows(disposition.terminals, "kind", "service terminals");
  exact(
    [...terminalRows.values()].map(({ kind, publicCode, status, message, details }) => [
      kind,
      publicCode,
      status,
      message,
      details,
    ]),
    [
      ["created-or-replayed", "success", 200, null, "validated ReportAdminReportResponse value"],
      [
        "source-scope-required",
        "insufficient_scope",
        403,
        "request credentials are not authorized",
        "strict empty object",
      ],
      [
        "source-unavailable",
        "not_found",
        404,
        "report source was not found",
        "strict empty object",
      ],
      [
        "capacity-exceeded",
        "request_too_large",
        413,
        "report request exceeds configured limit",
        "strict empty object",
      ],
      [
        "policy-capacity-exhausted",
        "request_too_large",
        413,
        "report capacity is exhausted",
        "strict empty object",
      ],
      ["internal-failure", "internal_error", 500, "internal server error", "strict empty object"],
    ],
    "service terminal mappings",
  );
  exact(
    disposition.boundaryMessages,
    {
      authenticationOrScope: "request credentials are not authorized",
      httpRequestTooLarge: "request body exceeds configured limit",
      sourceUnavailable: "report source was not found",
      serviceCapacityExceeded: "report request exceeds configured limit",
      policyCapacityExhausted: "report capacity is exhausted",
      internalFailure: "internal server error",
    },
    "service messages",
  );

  const outcomeRows = uniqueRows(oracle.publicOutcomes, "case", "public outcomes");
  requireExactRows(
    outcomeRows,
    [
      "first-create",
      "exact-replay-or-serialized-concurrent-waiter",
      "invalid-or-duplicate-public-request",
      "first-create-missing-source-read-scope",
      "source-ineligible",
      "per-request-bound",
      "policy-capacity-bound",
      "collision-corruption-renderer-storage-busy-or-readback-failure",
    ],
    "public outcomes",
  );
  exact(
    [...outcomeRows.values()].map(({ code, status }) => [code, status]),
    [
      ["success", 200],
      ["success", 200],
      ["invalid_request", 400],
      ["insufficient_scope", 403],
      ["not_found", 404],
      ["request_too_large", 413],
      ["request_too_large", 413],
      ["internal_error", 500],
    ],
    "public outcome codes",
  );
  exact(
    outcomeRows.get("first-create-missing-source-read-scope").effect,
    "after an admitted replay miss, retain exactly one rate-ledger attempt; reject before every source read/materializer and with zero report/artifact/citation/capacity-total/publication writes, not zero total writes",
    "missing source-scope public effect",
  );

  const traces = uniqueRows(oracle.constructiveTraces, "id", "constructive traces");
  requireExactRows(
    traces,
    [
      "TRACE-FIRST-SUCCESS",
      "TRACE-STAGED-EML-REPORT",
      "TRACE-LEGACY-MATERIALIZER",
      "TRACE-FIRST-CREATE-SCOPES",
      "TRACE-STRING-ROUNDTRIP",
      "TRACE-HTTP-OP-CAP",
      "TRACE-REPLAY",
      "TRACE-CONCURRENT",
      "TRACE-SOURCE-DENIALS",
      "TRACE-PLACEMENT-MIX",
      "TRACE-HOSTILE-CONTENT",
      "TRACE-RENDERER-REJECTION",
      "TRACE-STORAGE-ROLLBACK",
      "TRACE-MIGRATION-28",
      "TRACE-REOPEN",
      "TRACE-BACKUP-RESTORE",
      "TRACE-IMMUTABILITY-REPLACE",
      "TRACE-SERVING-AUTH",
      "TRACE-CAPACITY",
      "TRACE-POLICY-A-RATE",
      "TRACE-POLICY-A-ACCOUNT",
      "TRACE-CLI",
    ],
    "constructive traces",
  );
  for (const row of traces.values()) {
    nonempty(row.setup, row.id + " setup");
    nonempty(row.action, row.id + " action");
    nonempty(row.expected, row.id + " expected");
  }
  exact(
    traces.get("TRACE-FIRST-CREATE-SCOPES"),
    {
      id: "TRACE-FIRST-CREATE-SCOPES",
      setup:
        "distinct first-create identities under principals with reports:write only, mail:read.message only, both, and neither, plus an exact committed replay under reports:write only",
      action:
        "invoke through the real shared HTTP boundary and instrument body, report lookup, every message/placement/projection/blob/snapshot read, every materializer invocation, and every write to report_create_rate_windows, message_text_projections, reports, report_artifacts, report_source_snapshots, report_sources, capacity-total state, and publication sinks",
      expected:
        "missing reports:write is 403 before body read; replay under reports:write only succeeds with metadata-only reads and no rate write; an admitted first-create replay miss without mail:read.message commits and retains exactly one rate-ledger attempt before the exact 403, then performs zero source reads, materializer invocations, report/artifact/citation/capacity-total/publication writes and never claims zero total writes; both scopes can create",
    },
    "first-create scope trace",
  );
  exact(
    traces.get("TRACE-MIGRATION-28"),
    {
      id: "TRACE-MIGRATION-28",
      setup:
        "fresh database, every canonical 1..27 prefix, and a real supported legacy database whose converter must create immutable historical target version 27/digest 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab before any live suffix, plus unknown, forged, newer, and recomputed-live-full-digest-substituted provenance",
      action:
        "append report-creation-v1 as canonical slot 28, run the signed #233 implementation-sequence and implementation-compatibility proofs, and open through the sole database boundary so the real converter commits only target 1..27 before the protected common opener routes slot 28 through strict applyMigrations and the inside-BEGIN beforePendingMigration prefix hook, verifies exact current-tip canonical state and integrity, then invokes the effect-safe recorder",
      expected:
        "fresh, exact prefixes, and real legacy conversion first reach exact target 27, after which the common gated suffix path reaches schema 28 with the report and rate-ledger schema once; only that exact verified current-tip handle is fingerprint-recorded, runMigrations rederives the fingerprint for a zero-write legacy-fixture no-op, and applyMigrations remains strict and compatibility-unaware; all 1..27 semantic identities and target-27 provenance bytes remain exact while the live full-registry digest advances separately; both suffix crash boundaries, reopen, doctor, backup, empty restore, and full restore agree; converter-live-tip, legacy-opener-bypass, premature-recorder, fingerprint-bypass, and strict-runner-bypass counterexamples reject; unknown, forged, newer, full-digest-substituted, or current-tip-incomplete histories remain untouched and fail before any slot-28 or compatibility effect",
    },
    "migration 28 trace",
  );

  const forbidden = uniqueRows(oracle.forbiddenStates, "id", "forbidden states");
  requireExactRows(
    forbidden,
    [
      "FORBID-PUBLIC-SCHEMA-DRIFT",
      "FORBID-CALLER-PROVENANCE",
      "FORBID-ALTERNATE-IDENTITY",
      "FORBID-SOURCE-LEAK",
      "FORBID-RAW-OR-HTML-SOURCE",
      "FORBID-UNSTABLE-CITATION",
      "FORBID-STORED-RENDERED-ARTIFACT",
      "FORBID-SPLIT-PUBLICATION",
      "FORBID-STRING-LOSS",
      "FORBID-REPLACE-MUTATION",
      "FORBID-SOURCE-READ-WITHOUT-SCOPE",
      "FORBID-RAISED-REPORT-BODY-CAP",
      "FORBID-MIGRATION-AUTHORITY-DRIFT",
      "FORBID-REPLAY-REVALIDATION",
      "FORBID-UNBOUNDED-WORK",
      "FORBID-AUTOMATIC-DELETION",
      "FORBID-CLI-AUTHORITY-FORK",
    ],
    "forbidden states",
  );
  for (const row of forbidden.values()) nonempty(row.text, row.id + " text");
  exact(
    forbidden.get("FORBID-SOURCE-READ-WITHOUT-SCOPE").text,
    "Any message, placement, normalized-text, raw-blob, snapshot-text, or materializer read for a first-create replay miss before mail:read.message authorization; checking mail:read.message before an admitted miss commits exactly one rate-ledger attempt; erasing that attempt on missing scope; claiming the missing-scope terminal has zero total writes; any report/artifact/citation/capacity-total/publication write on that terminal; or requiring mail:read.message for an exact metadata-only replay.",
    "missing source-scope forbidden state",
  );
  exact(
    forbidden.get("FORBID-MIGRATION-AUTHORITY-DRIFT").text,
    "Any report migration other than report-creation-v1 at packages/storage/src/migrations/0028-report-creation.ts and canonical slot 28 after exact prefix-27 identity 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab; replacing immutable historical target-27 provenance with the new live full-registry digest; converting or ledgering any live suffix inside the legacy converter; placing the suffix runner only in a non-legacy opener branch; slot-28 SQL/history/user_version/commit before the inside-BEGIN prefix verifier; recording compatibility authority at target 27 before gated slot 28 and exact current-tip canonical-state/integrity verification; trusting the WeakMap without independent complete-fingerprint revalidation; allowing applyMigrations to read or bypass through compatibility state; changing protected converter, database opener, migration-runner, or #233 artifact bytes; any predecessor renumbering, semantic edit, alternate registry, caller ceiling, or conversion/reopen/doctor/backup/empty-restore/full-restore bypass.",
    "migration authority forbidden state",
  );

  const shields = uniqueRows(oracle.planningShieldApplicability, "id", "planning shields");
  requireExactRows(
    shields,
    Array.from({ length: 12 }, (_, index) => "S" + String(index + 1).padStart(2, "0")),
    "planning shields",
  );
  for (const [id, row] of shields) {
    if (!/^(?:required|not-applicable|gap)$/u.test(row.status)) fail(id + " has invalid status");
    nonempty(row.reason, id + " reason");
  }
  exact(shields.get("S10").status, "required", "security shield S10");
  exact(shields.get("S09").status, "required", "capacity shield S09");

  const decisions = uniqueRows(oracle.decisions, "id", "decisions");
  requireExactRows(
    decisions,
    Array.from({ length: 15 }, (_, index) => "D" + String(index + 1).padStart(2, "0")),
    "decisions",
  );
  for (const row of decisions.values()) {
    nonempty(row.choice, row.id + " choice");
    nonempty(row.reason, row.id + " reason");
    nonempty(row.rejected, row.id + " rejected alternatives");
  }

  const issue232 = oracle.downstream.issue232;
  exact(
    [issue232.model, issue232.minimumReasoning, issue232.status, issue232.implementationBase],
    ["gpt-5.6-luna", "xhigh", "ready-for-implementation", IMPLEMENTATION_BASE],
    "#232 profile",
  );
  exact(
    issue232.hardDependencies.map(({ issue, current }) => [issue, current]),
    [
      [231, "signed"],
      [233, "accepted"],
      [234, "implemented"],
    ],
    "#232 hard dependencies",
  );
  issue232.hardDependencies.forEach((row) =>
    nonempty(row.required, "#232 dependency " + row.issue),
  );
  exact(
    issue232.hardDependencies.slice(1).map(({ issue, required }) => [issue, required]),
    [
      [
        233,
        "signed append-stable canonical registry and safe legacy-fixture recorder authority at commit 2fd5b0eaf993b9f44068bd0f61552fc84479129a and oracle 08d817c11ba3d1a8f213f9254fdb792f43e9384b1a70471788c59497cb432345, with explicit historical target 27, real target-slice conversion sequence, common verified suffix runner, exact-current-tip fingerprint recorder, strict applyMigrations isolation, and reserved report slot 28",
      ],
      [
        234,
        "implemented target-27 converter slice, common post-conversion strict applyMigrations path, prefix digest helper, explicit target decoder, inside-BEGIN beforePendingMigration verifier, exact-current-tip safe recorder plus fingerprint-reverified runMigrations compatibility, and sole registry/conversion/opener/runner/doctor/backup/restore authority at 4f79eb54ff1442dcd12d3cf8771861c4ae6e15ce",
      ],
    ],
    "#232 migration dependencies",
  );
  exactSet(
    issue232.productionFiles,
    [
      "packages/imap/src/mime-parser.ts",
      "packages/storage/src/canonical-promotion.ts",
      "packages/storage/src/promotion-adapter.ts",
      "packages/storage/src/message-text-materializer.ts",
      "packages/storage/src/report-creation-repository.ts",
      "packages/storage/src/migrations/0028-report-creation.ts",
      "packages/storage/src/migration-registry.ts",
      "packages/storage/src/index.ts",
      "packages/daemon/src/single-message-ingestion.ts",
      "packages/daemon/src/http.ts",
      "packages/daemon/src/report-creation-service.ts",
      "packages/daemon/src/report-admin-handlers.ts",
      "packages/daemon/src/report-serving.ts",
      "packages/daemon/src/index.ts",
      "packages/cli/src/report-create-command.ts",
      "packages/cli/src/index.ts",
    ],
    "#232 production files",
  );
  exactSet(
    issue232.testFiles,
    [
      "packages/imap/test/mime-parser-p2-c10.test.ts",
      "packages/storage/test/canonical-promotion-p2-c13.test.ts",
      "packages/storage/test/remote-placement-observation-p3-c12.test.ts",
      "packages/storage/test/search-corpus-p4-c16.test.ts",
      "packages/storage/test/backup-restore-parity-p2-c19.test.ts",
      "packages/storage/test/promotion-adapter-p2-c20.test.ts",
      "packages/storage/test/message-text-materializer.test.ts",
      "packages/storage/test/report-creation-migration.test.ts",
      "packages/storage/test/report-creation-repository.test.ts",
      "packages/storage/test/report-creation-backup-restore.test.ts",
      "packages/storage/test/migration-registry.test.ts",
      "packages/storage/test/migration-history-conversion.test.ts",
      "packages/daemon/test/single-message-ingestion-p3-c08.test.ts",
      "packages/daemon/test/http-admission-sec-r03.test.ts",
      "packages/daemon/test/report-creation-service.test.ts",
      "packages/daemon/test/report-create-http.test.ts",
      "packages/daemon/test/report-admin-handlers-p6-c08.test.ts",
      "packages/daemon/test/report-serving-p6-c17.test.ts",
      "packages/daemon/test/report-create-composed.test.ts",
      "packages/cli/src/report-create-command.test.ts",
    ],
    "#232 test files",
  );
  exactSet(
    issue232.protectedFiles,
    [
      "packages/contracts/src/report-admin-operations.ts",
      "packages/contracts/src/report-renderer.ts",
      "packages/contracts/src/http-error-authority.ts",
      "packages/contracts/src/error-envelope.ts",
      "packages/daemon/src/config.ts",
      "packages/daemon/src/trusted-auth-context.ts",
      "packages/cli/src/client.ts",
      "packages/cli/src/command-registry.ts",
      "packages/cli/src/command-outcome.ts",
      "packages/cli/src/output-context.ts",
      "packages/storage/src/database.ts",
      "packages/storage/src/migration-runner.ts",
      "packages/storage/src/migration-history-conversion.ts",
      "docs/architecture/database-migration-registry-oracle.v1.json",
      "docs/architecture/database-migration-registry-check.v1.mjs",
      "docs/architecture/database-migration-registry-design.v1.md",
      "docs/architecture/database-migration-registry-decisions.v1.md",
      "docs/architecture/database-migration-registry-coverage.v1.md",
      "packages/daemon/test/operation-parity-issue-165.ts",
      "packages/daemon/test/operation-parity-issue-165.test.ts",
    ],
    "#232 protected files",
  );
  exact(
    [
      issue232.migrationFiles.production,
      issue232.migrationFiles.test,
      issue232.migrationFiles.registry,
      issue232.migrationFiles.registryTest,
      issue232.migrationFiles.conversionCompositionTest,
    ],
    [
      "packages/storage/src/migrations/0028-report-creation.ts",
      "packages/storage/test/report-creation-migration.test.ts",
      "packages/storage/src/migration-registry.ts",
      "packages/storage/test/migration-registry.test.ts",
      "packages/storage/test/migration-history-conversion.test.ts",
    ],
    "#232 migration paths",
  );
  nonempty(issue232.migrationFiles.rule, "#232 migration rule");
  exact(
    [issue232.changePolicy.base, issue232.changePolicy.selfTests, issue232.changePolicy.invocation],
    [
      IMPLEMENTATION_BASE,
      ["frozen-input-drift", "protected-path", "unknown-path"],
      "node docs/architecture/report-creation-check.v1.mjs --changed-path=<path> [repeat for the complete #232 diff] --self-test",
    ],
    "#232 change policy",
  );
  nonempty(issue232.changePolicy.allowedRule, "#232 allowed path rule");
  nonempty(issue232.changePolicy.driftRule, "#232 drift rule");
  const focused = issue232.focusedSuiteAuthority;
  exact(
    [
      focused.command,
      focused.defaultPerTestTimeoutMilliseconds,
      focused.timeoutOverrideAllowed,
      focused.canonicalPromotionTestPath,
      focused.canonicalPromotionAcceptedBaseSha256,
      focused.remotePlacementTestPath,
      focused.remotePlacementAcceptedBaseSha256,
      focused.normalizedTextLiteral,
    ],
    [
      ["bun", "test", ...issue232.testFiles],
      5000,
      false,
      "packages/storage/test/canonical-promotion-p2-c13.test.ts",
      "b594e06c2efdbc1e950ebb6413f4e5bbad6301225f6cf457ea5686f4b273210a",
      "packages/storage/test/remote-placement-observation-p3-c12.test.ts",
      "ee9af0c34cb929ffd0f8a930b28f92e97a11663ea68d6408c18537d5f5183385",
      "Promoted normalized text",
    ],
    "#232 focused suite authority",
  );
  exact(
    [
      focused.normalizedTextRule,
      focused.canonicalBoundaryRule,
      focused.cleanupRule,
      focused.protectedDependencyRule,
    ],
    [
      "Update the accepted remote-placement production-promotion caller to supply exactly the required normalizedText string Promoted normalized text. Keep normalizedText required in parsePromotionUnit and retain the existing omitted-field negative in packages/storage/test/promotion-adapter-p2-c20.test.ts; undefined, omission, or an optional fallback remains invalid-input.",
      "Keep the successful discovery pass on one real file-backed production-opened SQLite database, close it, then open exactly one fresh empty real file-backed production-opened SQLite database for the complete injected write-boundary loop. Reuse that empty handle only after every injected failure proves the complete zero-row rollback state, then close it once. Do not reopen or remigrate once per failure ordinal, reduce the boundary set, replace real SQLite with a fake or memory-only database, or increase/disable the default timeout.",
      "The test fixture must track every live opened database handle. afterEach first awaits idempotent close for every still-live handle, including assertion, timeout, and partial-open paths, and only then recursively removes its owner-only temporary roots. Root removal may never race database close or WAL/SHM companion hardening.",
      "This is test/proof stabilization only. packages/storage/src/database.ts, packages/storage/src/migration-runner.ts, packages/storage/src/migration-history-conversion.ts, the target-27 converter, gated slot-28 suffix sequence, safe recorder, and production WAL semantics remain byte-frozen and semantically unchanged.",
    ],
    "#232 focused suite rules",
  );
  exactSet(
    focused.proofPathBindings.stagedEmlHttpCli,
    [
      "packages/imap/test/mime-parser-p2-c10.test.ts",
      "packages/daemon/test/single-message-ingestion-p3-c08.test.ts",
      "packages/daemon/test/report-create-composed.test.ts",
      "packages/cli/src/report-create-command.test.ts",
    ],
    "#232 staged EML/HTTP/CLI proof paths",
  );
  exactSet(
    focused.proofPathBindings.policyABoundaries,
    [
      "packages/storage/test/report-creation-repository.test.ts",
      "packages/daemon/test/report-creation-service.test.ts",
      "packages/daemon/test/report-create-http.test.ts",
      "packages/daemon/test/report-create-composed.test.ts",
    ],
    "#232 Policy A proof paths",
  );
  exactSet(
    focused.proofPathBindings.concurrencyReplaceRecovery,
    [
      "packages/storage/test/report-creation-migration.test.ts",
      "packages/storage/test/report-creation-repository.test.ts",
      "packages/storage/test/report-creation-backup-restore.test.ts",
      "packages/daemon/test/report-create-composed.test.ts",
    ],
    "#232 concurrency/REPLACE/recovery proof paths",
  );
  const searchCorpus = focused.searchCorpusIndexAuthority;
  exact(
    [
      searchCorpus.testPath,
      searchCorpus.acceptedBaseSha256,
      searchCorpus.registryPath,
      searchCorpus.canonicalSchemaVersion,
      searchCorpus.indexQuery,
      searchCorpus.canonicalIndexCount,
      searchCorpus.canonicalIndexTupleSha256,
      searchCorpus.slot28IndexNames,
    ],
    [
      "packages/storage/test/search-corpus-p4-c16.test.ts",
      "d9f50b9a75413d4d4fd3d724b7856390bf954abd7e3035020694f4120b42b92b",
      "packages/storage/src/migration-registry.ts",
      28,
      "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name, tbl_name, sql",
      33,
      "8a1da254844604df5d8f9c8b1629de2683227c90b1758f3c137166b870affb24",
      [
        "report_snapshots_owner_account_bytes",
        "report_sources_snapshot_lookup",
        "reports_owner_account_created",
      ],
    ],
    "#232 search corpus index authority",
  );
  exact(
    [searchCorpus.derivationRule, searchCorpus.comparisonRule, searchCorpus.mutationRule],
    [
      "Create a separate empty owner-only file database through the protected production openDatabase path and current canonicalDatabaseMigrations registry, require user_version and exact ordered schema_migrations history to equal the registry-derived current tip 28, require integrity_check ok and zero foreign_key_check rows, then query the complete ordered non-auto sqlite_schema index tuples with indexQuery. Canonical JSON of those exact name/table/SQL tuples must contain 33 rows and hash to canonicalIndexTupleSha256. Never derive expected tuples from either corpus database under test or from a hand-maintained per-table count map.",
      "Compare each generated corpus database's complete ordered index tuples byte-for-byte with the independent canonical index oracle; derive schemaIndexCounts and schemaIndexTotal from those oracle tuples and compare the inventory to those derived values before retaining validateCorpusInventory's integrity, foreign-key, required-object, placement, normalized-content, FTS, label, query-selectivity, and query-identity checks.",
      "The focused test must reject one omitted canonical index, one extra index, and one same-name index recreated with different SQL while retaining the other tuples. The #231 checker must independently reject removal of the search test, stale accepted bytes, schema version 27, stale literal count 4, wrong tuple digest, omission of any slot-28 index name, and any production-scope widening.",
    ],
    "#232 search corpus index rules",
  );
  const backupParity = focused.backupRestoreParityAuthority;
  exact(
    [
      backupParity.testPath,
      backupParity.acceptedBaseSha256,
      backupParity.fixturePath,
      backupParity.normalizedTextSourceExpression,
      backupParity.normalizedTextLiteral,
      backupParity.normalizedTextUtf8Bytes,
      backupParity.canonicalJsonUtf8,
      backupParity.canonicalJsonBytes,
      backupParity.canonicalJsonSha256,
      backupParity.rawSourceSha256,
      backupParity.parserId,
    ],
    [
      "packages/storage/test/backup-restore-parity-p2-c19.test.ts",
      "cb30d41422d62576356ba561a14d16e47c288bcebfc5f97cc68c8f33e1083dde",
      "packages/storage/test/fixtures/backup-restore-p2-c19-comparison.json",
      "comparisonFixture.plainBody",
      "canonical body\n",
      15,
      '"canonical body\\n"',
      18,
      "acb6a0f8d3a17cedffe9f25e3b852a3f5256d1d9fd3454726e6451cc6052ae34",
      "991c5d77082d0849b0c569d0d9674ba0ffc6728d88c0f250481badef71032685",
      "mailparser:3.9.15",
    ],
    "#232 backup restore parity authority",
  );
  exact(
    [
      backupParity.fixtureRule,
      backupParity.parityRule,
      backupParity.missingFieldRule,
      backupParity.mutationRule,
    ],
    [
      "Change only the accepted test's typed canonicalUnit by adding normalizedText: comparisonFixture.plainBody. That expression evaluates exactly to normalizedTextLiteral and is fixture input, not a production fallback or a synthesized legacy-read rule. Do not edit the comparison JSON, production promotion, report source resolution, materializer, backup, restore, database, runner, converter, or migration code.",
      "Before backup, after closing and reopening the source database, and after verified empty-root restore plus reopen, require readCanonicalPromotion.normalizedText to equal normalizedTextLiteral and query the exact message_text_projections row. The canonical JSON BLOB bytes, SHA-256, normalized UTF-8 byte count, raw source SHA-256, parser id, projection version, and materialized timestamp must be byte-for-byte equal across all three states and equal the frozen values; integrity_check must be ok and foreign_key_check empty. Row-count-only, decoded-string-only, schema-only, or aggregate parity does not count.",
      "This fixture-only input does not authorize an optional normalizedText field or a plainBody fallback at any production boundary. parsePromotionUnit must retain its omitted-field invalid-input negative; newly parsed production promotion must always persist the projection; and report source resolution must continue to reject a missing projection unless the separately frozen legacy materializer succeeds under its identity/account/placement gates.",
      "The focused proof must fail if normalizedText is omitted, optional, replaced by an empty/fallback/different value, or if any canonical projection byte or source/reopen/restore state differs. The #231 checker must reject removal of the test, stale accepted bytes, changed source expression/literal/digests/counts/parser, weakened parity or missing-field rules, changed isolated outcomes, and any production-scope widening.",
    ],
    "#232 backup restore parity rules",
  );
  exact(
    backupParity.isolatedComparison,
    {
      acceptedBase: {
        authority:
          "accepted #234 base 4f79eb54ff1442dcd12d3cf8771861c4ae6e15ce with the accepted-base P2-C19 test bytes",
        passes: 2,
        fails: 0,
      },
      candidateBeforeRepair: {
        authority: "exact 30-path #232 candidate with the accepted-base P2-C19 test bytes",
        passes: 0,
        fails: 2,
        error: "restore parity fixture is missing a message repository read",
      },
      candidateAfterRepair: {
        authority: "exact 31-path #232 candidate with only the P2-C19 fixture repair added",
        requiredPasses: 2,
        requiredFails: 0,
        allowedChangedPaths: ["packages/storage/test/backup-restore-parity-p2-c19.test.ts"],
      },
    },
    "#232 isolated backup restore comparison",
  );
  for (const paths of Object.values(focused.proofPathBindings)) {
    validateChangedPaths(issue232, paths);
  }
  validateChangedPaths(issue232, [searchCorpus.testPath]);
  validateChangedPaths(issue232, [backupParity.testPath]);
  validateChangedPaths(issue232, issue232.productionFiles);
  validateChangedPaths(issue232, issue232.testFiles);
  if (issue232.implementationObligations.length !== 10) fail("#232 obligations differ");
  issue232.implementationObligations.forEach((value, index) =>
    nonempty(value, "#232 obligation " + index),
  );
  nonempty(issue232.retirement, "#232 retirement");

  const issue165 = oracle.downstream.issue165;
  exact([issue165.owner, issue165.protectedDuring232], [165, true], "#165 ownership");
  exact(
    issue165.cells.map(({ operation, surface }) => [operation, surface]),
    [
      ["reports.create", "production-adapter"],
      ["reports.create", "cli-composed"],
    ],
    "#165 cells",
  );
  issue165.cells.forEach((row) => nonempty(row.requiredEvidence, "#165 " + row.surface));
  exact(issue165.outcomeDimensions.length, 14, "#165 outcome dimension count");
  issue165.outcomeDimensions.forEach((value, index) =>
    nonempty(value, "#165 outcome dimension " + index),
  );
  nonempty(issue165.promotionRule, "#165 promotion rule");
}

function validateChangedPaths(issue232, paths) {
  const allowed = new Set([...issue232.productionFiles, ...issue232.testFiles]);
  const protectedPaths = new Set(issue232.protectedFiles);
  if (allowed.size !== issue232.productionFiles.length + issue232.testFiles.length) {
    fail("#232 allowed paths contain duplicates");
  }
  for (const changedPath of paths) {
    nonempty(changedPath, "#232 changed path");
    if (protectedPaths.has(changedPath)) fail("#232 protected path changed: " + changedPath);
    if (!allowed.has(changedPath)) fail("#232 unknown path changed: " + changedPath);
  }
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(headers, rows) {
  return [
    "| " + headers.map(escapeCell).join(" | ") + " |",
    "| " + headers.map(() => "---").join(" | ") + " |",
    ...rows.map((row) => "| " + row.map(escapeCell).join(" | ") + " |"),
  ].join("\n");
}

function projectionHeader(title, digest) {
  return [
    "# " + title,
    "",
    "> Checked projection of `report-creation-oracle.v1.json` at SHA-256 `" + digest + "`.",
    "> Status: **frozen-design; signed; normative; implementation authority within the checked #232 boundary**.",
    "> The JSON oracle is the projection source and this file must match the checker exactly.",
    "",
  ];
}

function renderDesign(oracle, digest) {
  const lines = projectionHeader("Report creation design v1", digest);
  lines.push(
    "## Boundary",
    "",
    oracle.oracle.description,
    "",
    "Implementation rule: " + oracle.oracle.implementationRule,
    "",
    "## Resolved authorities",
    "",
    table(
      ["Authority", "Status", "Frozen rule"],
      oracle.resolvedAuthorities.map((row) => [row.id, row.status, row.rule]),
    ),
    "",
    table(
      ["Field", "Frozen value"],
      [
        ["Operation", oracle.publicBoundary.operationKey],
        ["HTTP", oracle.publicBoundary.method + " " + oracle.publicBoundary.route],
        ["CLI", oracle.publicBoundary.commandPath.join(" ")],
        ["Scope", oracle.publicBoundary.scope],
        ["First-create source scope", oracle.publicBoundary.firstCreateSourceScope],
        ["reports.create body hard cap", oracle.publicBoundary.httpBodyHardCapBytes],
        ["Schemas", oracle.publicBoundary.schemaDisposition],
      ],
    ),
    "",
    oracle.publicBoundary.schemaRationale,
    "",
    "## Canonical identity and replay",
    "",
    oracle.identityAuthority.material,
    "",
    "- Metadata ordering: " + oracle.identityAuthority.metadataOrdering,
    "- Durable strings: " + oracle.identityAuthority.stringSerialization,
    "- String comparison: " + oracle.identityAuthority.stringComparison,
    "- Report ID: " + oracle.identityAuthority.reportId,
    "- Creation request ID: " + oracle.identityAuthority.creationRequestId,
    "- Account: " + oracle.identityAuthority.accountRule,
    "- Replay: " + oracle.identityAuthority.replayRule,
    "- Replay read projection: " + oracle.identityAuthority.replayReadProjection,
    "- Replay authorization: " + oracle.identityAuthority.replayAuthorizationRule,
    "- Collision: " + oracle.identityAuthority.collisionRule,
    "- Concurrency: " + oracle.identityAuthority.concurrencyRule,
    "",
    "## Source and citation authority",
    "",
    oracle.sourceAuthority.eligibility,
    "",
    table(
      ["First-create source case", "Public result", "HTTP", "Writes"],
      oracle.sourceAuthority.outcomes.map((row) => [
        row.case,
        row.publicCode,
        row.status,
        row.writes,
      ]),
    ),
    "",
    "- Plain text: " + oracle.sourceAuthority.plainSelection,
    "- HTML-derived fallback: " + oracle.sourceAuthority.htmlFallback,
    "- Snapshot: " + oracle.sourceAuthority.snapshotRule,
    "- Stable serving: " + oracle.sourceAuthority.servingRule,
    "- Citations: " + oracle.sourceAuthority.citationRule,
    "- Forbidden content: " + oracle.sourceAuthority.forbiddenContent,
    "",
    "## Production normalized text",
    "",
    oracle.normalizedTextAuthority.productionRule,
    "",
    "- Parser: " + oracle.normalizedTextAuthority.parserRule,
    "- Future ingestion: " + oracle.normalizedTextAuthority.futureIngestionRule,
    "- Accepted caller repair: " +
      oracle.downstream.issue232.focusedSuiteAuthority.normalizedTextRule,
    "- Legacy materializer: " + oracle.normalizedTextAuthority.legacyMaterializerRule,
    "- State set: " + oracle.normalizedTextAuthority.materializerStates.join(", "),
    "- Transition and cleanup: " + oracle.normalizedTextAuthority.materializerTransitionRule,
    "- Proof: " + oracle.normalizedTextAuthority.proofRule,
    "",
    "## Model and renderer",
    "",
    "- Title: " + oracle.reportModelAuthority.title,
    "- Summary: " + oracle.reportModelAuthority.summary,
    "- Section: `" + oracle.reportModelAuthority.sectionHeading + "`.",
    "- Claims: " + oracle.reportModelAuthority.claimRule,
    "- Excerpts: " + oracle.reportModelAuthority.excerptRule,
    "- Metadata: " + oracle.reportModelAuthority.metadataRule,
    "- Render: " + oracle.reportModelAuthority.renderRule,
    "- Serve: " + oracle.reportModelAuthority.serveRule,
    "",
    "## Durable publication",
    "",
    "Migration: " + oracle.persistenceAuthority.migrationRule,
    "",
    "Prefix evolution: " + oracle.persistenceAuthority.prefixEvolutionAuthority.rule,
    "",
    "Legacy conversion authority:",
    "",
    ...oracle.persistenceAuthority.prefixEvolutionAuthority.legacyConversionSequence.map(
      (step, index) => String(index + 1) + ". " + step,
    ),
    "",
    "Safe recorder authority:",
    "",
    ...oracle.persistenceAuthority.prefixEvolutionAuthority.safeRecorderSequence.map(
      (step, index) => String(index + 1) + ". " + step,
    ),
    "",
    "Signed implementation modes: `" +
      oracle.persistenceAuthority.prefixEvolutionAuthority.implementationSequenceMode +
      "` and `" +
      oracle.persistenceAuthority.prefixEvolutionAuthority.implementationCompatibilityMode +
      "`.",
    "",
    table(
      ["Table", "Primary key", "Purpose"],
      oracle.persistenceAuthority.tables.map((row) => [row.name, row.primaryKey, row.purpose]),
    ),
    "",
    ...oracle.persistenceAuthority.transactionSteps.flatMap((step, index) => [
      String(index + 1) + ". " + step,
      "",
    ]),
    "Backup: " + oracle.persistenceAuthority.backupRule,
    "",
    "Restore: " + oracle.persistenceAuthority.restoreRule,
    "",
    "Duplicate-key guards:",
    "",
    ...oracle.persistenceAuthority.duplicateInsertGuards.map(
      (row) => "- `" + row.trigger + "`: " + row.when + "; " + row.effect + ".",
    ),
    "",
    "## Provenance, serving, and CLI",
    "",
    "Provenance owner: " + oracle.provenanceAuthority.owner,
    "",
    "Provenance method: " + oracle.provenanceAuthority.methodRule,
    "",
    "First-create scopes: " + oracle.provenanceAuthority.firstCreateScopeRule,
    "",
    "Missing-scope total writes: " +
      oracle.provenanceAuthority.missingSourceScopePostcondition.totalWriteRule,
    "",
    "Missing-scope instrumentation: " +
      oracle.provenanceAuthority.missingSourceScopePostcondition.instrumentationRule,
    "",
    "Replay scopes: " + oracle.provenanceAuthority.replayScopeRule,
    "",
    "Serving repository: " + oracle.servingAuthority.repositoryRule,
    "",
    "Report integrity: " + oracle.servingAuthority.reportIntegrity,
    "",
    "Source integrity: " + oracle.servingAuthority.sourceIntegrity,
    "",
    "CLI success: " + oracle.cliAuthority.successRule,
    "",
    "CLI safety: " + oracle.cliAuthority.humanSafety,
    "",
    "## Capacity and retention",
    "",
    table(
      ["Limit", "Bytes or count"],
      [
        ["HTTP request", oracle.capacityAuthority.httpRequestBytes],
        ["Identity material", oracle.capacityAuthority.maxIdentityMaterialBytes],
        ["Metadata JSON", oracle.capacityAuthority.maxMetadataJsonBytes],
        ["Source IDs", oracle.capacityAuthority.maxSourceIds],
        ["One source projection", oracle.capacityAuthority.maxSourceProjectionBytesEach],
        ["All source projections", oracle.capacityAuthority.maxSourceProjectionBytesTotal],
        ["One canonical source JSON", oracle.capacityAuthority.maxSourceProjectionJsonBytesEach],
        ["All canonical source JSON", oracle.capacityAuthority.maxSourceProjectionJsonBytesTotal],
        ["One claim excerpt", oracle.capacityAuthority.maxClaimExcerptBytesEach],
        ["Model JSON", oracle.capacityAuthority.maxModelJsonBytes],
        ["Rendered Markdown", oracle.capacityAuthority.maxRenderedMarkdownBytes],
        ["Rendered HTML", oracle.capacityAuthority.maxRenderedHtmlBytes],
        ["Committed reports", oracle.capacityAuthority.maxCommittedReports],
        ["Logical charged bytes", oracle.capacityAuthority.maxLogicalChargedBytes],
        [
          "Non-replay attempts per principal/window",
          oracle.capacityAuthority.maxNonReplayAttemptsPerRollingWindow +
            " / " +
            oracle.capacityAuthority.rollingWindowMilliseconds +
            " ms",
        ],
      ],
    ),
    "",
    "Admission order: " + oracle.capacityAuthority.admissionOrder,
    "",
    "Machine admission sequence: " + oracle.capacityAuthority.admissionSequence.join(" -> "),
    "",
    oracle.capacityAuthority.admissionRule,
    "",
    oracle.capacityAuthority.httpAdmissionRule,
    "",
    oracle.capacityAuthority.rateAdmissionRule,
    "",
    oracle.capacityAuthority.logicalChargeRule,
    "",
    oracle.capacityAuthority.accountAdmissionRule,
    "",
    oracle.capacityAuthority.writeInstrumentationRule,
    "",
    oracle.capacityAuthority.durableGrowthRule,
    "",
    oracle.capacityAuthority.retentionRule,
    "",
    oracle.capacityAuthority.restoreAccountingRule,
    "",
    oracle.capacityAuthority.configurationRule,
    "",
    "## Exact service messages",
    "",
    oracle.serviceDispositionAuthority.ownershipRule,
    "",
    table(
      ["Terminal", "Code", "HTTP", "Message", "Details"],
      oracle.serviceDispositionAuthority.terminals.map((row) => [
        row.kind,
        row.publicCode,
        row.status,
        row.message ?? "success value",
        row.details,
      ]),
    ),
    "",
  );
  return lines.join("\n");
}

function renderDecisions(oracle, digest) {
  const lines = projectionHeader("Report creation decisions v1", digest);
  lines.push(
    "The signed oracle records the following frozen choices. Policy A and canonical migration slot 28 are resolved authority, not implementation options.",
    "",
    table(
      ["Authority", "Status", "Choice or slot"],
      oracle.resolvedAuthorities.map((row) => [
        row.id,
        row.status,
        row.choice ?? row.migrationVersion,
      ]),
    ),
    "",
  );
  for (const row of oracle.decisions) {
    lines.push(
      "## " + row.id,
      "",
      "Choice: " + row.choice,
      "",
      "Reason: " + row.reason,
      "",
      "Rejected: " + row.rejected + ".",
      "",
    );
  }
  return lines.join("\n");
}

function renderCoverage(oracle, digest) {
  const lines = projectionHeader("Report creation coverage v1", digest);
  lines.push(
    "## Resolved release authority",
    "",
    table(
      ["Authority", "Status", "Rule"],
      oracle.resolvedAuthorities.map((row) => [row.id, row.status, row.rule]),
    ),
    "",
    "## Requirements",
    "",
    table(
      ["Requirement", "Invariant"],
      oracle.requirements.map((row) => [row.id, row.text]),
    ),
    "",
    "## Constructive traces",
    "",
    table(
      ["Trace", "Setup", "Action", "Expected"],
      oracle.constructiveTraces.map((row) => [row.id, row.setup, row.action, row.expected]),
    ),
    "",
    "## Forbidden states",
    "",
    table(
      ["State", "Forbidden condition"],
      oracle.forbiddenStates.map((row) => [row.id, row.text]),
    ),
    "",
    "## Planning shields",
    "",
    table(
      ["Shield", "Status", "Reason"],
      oracle.planningShieldApplicability.map((row) => [row.id, row.status, row.reason]),
    ),
    "",
    "## Issue 232 implementation boundary",
    "",
    "Status: **" + oracle.downstream.issue232.status + "**.",
    "",
    "Implementation base: `" + oracle.downstream.issue232.implementationBase + "`.",
    "",
    table(
      ["Hard dependency", "Current", "Required"],
      oracle.downstream.issue232.hardDependencies.map((row) => [
        "#" + row.issue,
        row.current,
        row.required,
      ]),
    ),
    "",
    "Production files:",
    "",
    ...oracle.downstream.issue232.productionFiles.map((path) => "- `" + path + "`"),
    "",
    "Focused tests:",
    "",
    ...oracle.downstream.issue232.testFiles.map((path) => "- `" + path + "`"),
    "",
    "Protected files:",
    "",
    ...oracle.downstream.issue232.protectedFiles.map((path) => "- `" + path + "`"),
    "",
    "Migration production: `" + oracle.downstream.issue232.migrationFiles.production + "`.",
    "",
    "Migration test: `" + oracle.downstream.issue232.migrationFiles.test + "`.",
    "",
    "Canonical registry: `" + oracle.downstream.issue232.migrationFiles.registry + "`.",
    "",
    "Registry test: `" + oracle.downstream.issue232.migrationFiles.registryTest + "`.",
    "",
    "Conversion composition test: `" +
      oracle.downstream.issue232.migrationFiles.conversionCompositionTest +
      "`.",
    "",
    "Migration rule: " + oracle.downstream.issue232.migrationFiles.rule,
    "",
    "Change policy: " + oracle.downstream.issue232.changePolicy.allowedRule,
    "",
    "Drift policy: " + oracle.downstream.issue232.changePolicy.driftRule,
    "",
    "Default focused command: `" +
      oracle.downstream.issue232.focusedSuiteAuthority.command.join(" ") +
      "`.",
    "",
    "Default per-test timeout: " +
      oracle.downstream.issue232.focusedSuiteAuthority.defaultPerTestTimeoutMilliseconds +
      " ms; timeout override allowed: " +
      oracle.downstream.issue232.focusedSuiteAuthority.timeoutOverrideAllowed +
      ".",
    "",
    "Canonical P2-C13 stabilization: " +
      oracle.downstream.issue232.focusedSuiteAuthority.canonicalBoundaryRule,
    "",
    "Fixture cleanup: " + oracle.downstream.issue232.focusedSuiteAuthority.cleanupRule,
    "",
    "Protected dependencies: " +
      oracle.downstream.issue232.focusedSuiteAuthority.protectedDependencyRule,
    "",
    table(
      ["Proof family", "Authorized focused paths"],
      Object.entries(oracle.downstream.issue232.focusedSuiteAuthority.proofPathBindings).map(
        ([family, paths]) => [family, paths.join(", ")],
      ),
    ),
    "",
    "Search corpus test: `" +
      oracle.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.testPath +
      "` at accepted-base SHA-256 `" +
      oracle.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority
        .acceptedBaseSha256 +
      "`.",
    "",
    "Canonical search index oracle: schema " +
      oracle.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority
        .canonicalSchemaVersion +
      ", " +
      oracle.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority
        .canonicalIndexCount +
      " indexes, tuple SHA-256 `" +
      oracle.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority
        .canonicalIndexTupleSha256 +
      "`.",
    "",
    "Search index derivation: " +
      oracle.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.derivationRule,
    "",
    "Search index comparison: " +
      oracle.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.comparisonRule,
    "",
    "Search index mutations: " +
      oracle.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.mutationRule,
    "",
    "Backup/restore parity test: `" +
      oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.testPath +
      "` at accepted-base SHA-256 `" +
      oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority
        .acceptedBaseSha256 +
      "`.",
    "",
    "Backup normalized text: `" +
      JSON.stringify(
        oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority
          .normalizedTextLiteral,
      ) +
      "` from `" +
      oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority
        .normalizedTextSourceExpression +
      "`; canonical JSON SHA-256 `" +
      oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority
        .canonicalJsonSha256 +
      "`.",
    "",
    "Backup fixture rule: " +
      oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.fixtureRule,
    "",
    "Backup byte parity: " +
      oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.parityRule,
    "",
    "Backup missing-field rule: " +
      oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority
        .missingFieldRule,
    "",
    "Backup isolated comparison: " +
      JSON.stringify(
        oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority
          .isolatedComparison,
      ) +
      ".",
    "",
    "Backup parity mutations: " +
      oracle.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.mutationRule,
    "",
    "Obligations:",
    "",
    ...oracle.downstream.issue232.implementationObligations.map(
      (obligation, index) => String(index + 1) + ". " + obligation,
    ),
    "",
    "## Issue 165 handoff",
    "",
    table(
      ["Operation", "Surface", "Required evidence"],
      oracle.downstream.issue165.cells.map((row) => [
        row.operation,
        row.surface,
        row.requiredEvidence,
      ]),
    ),
    "",
    oracle.downstream.issue165.promotionRule,
    "",
  );
  return lines.join("\n");
}

function formatProjection(value, path) {
  try {
    return execFileSync("bunx", ["vp", "fmt", "--stdin-filepath=" + path], {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: value,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    fail("cannot format checked projection " + path);
  }
}

function projections(oracle, digest) {
  return [
    renderDesign(oracle, digest),
    renderDecisions(oracle, digest),
    renderCoverage(oracle, digest),
  ].map((value, index) => formatProjection(value, viewPaths[index]));
}

const mutations = [
  ["authority-status", (value) => (value.status = "repaired-pending-decisions")],
  ["authority-signable", (value) => (value.oracle.signable = false)],
  ["accepted-head", (value) => (value.oracle.acceptedHead = "0".repeat(40))],
  [
    "accepted-head-stale-pre-ledger",
    (value) => (value.oracle.acceptedHead = "e7c1d503548f759634f9b062647ca07381914569"),
  ],
  [
    "accepted-head-stale-implementation-base",
    (value) => (value.oracle.acceptedHead = "4f79eb54ff1442dcd12d3cf8771861c4ae6e15ce"),
  ],
  [
    "plan-stale-pre-reconciliation-hash",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "PLAN").sha256 =
        "1b50f59a6df4af0419707fb740c94c2fa08dde2c127267c7f68778f33f4c30b5"),
  ],
  [
    "evidence-stale-pre-reconciliation-hash",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "EVIDENCE").sha256 =
        "9d6666a4f850f7452f7bda80b14a28a74e434f3f99c26daf55fcb9e7d244953e"),
  ],
  [
    "plan-current-hash-crosswired",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "PLAN").sha256 =
        "92ad4982f2d2edc94acae40f7b7fd5b149a674ecf6600823ff895f1a29c9b87e"),
  ],
  [
    "evidence-current-hash-crosswired",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "EVIDENCE").sha256 =
        "6daf232f6d2895b3e76bdde9a8fb51da31b4506d8c2b2cab7544147ddf6257ce"),
  ],
  [
    "issue232-implementation-base-rebound-to-ledger-head",
    (value) => (value.downstream.issue232.implementationBase = ACCEPTED_HEAD),
  ],
  ["policy-a-resolution", (value) => (value.resolvedAuthorities[0].choice = "B")],
  ["migration-resolution", (value) => (value.resolvedAuthorities[1].migrationVersion = 29)],
  [
    "registry-identity",
    (value) => (value.resolvedAuthorities[1].predecessorRegistryIdentitySha256 = "0".repeat(64)),
  ],
  [
    "stale-233-pin",
    (value) =>
      (value.acceptedArtifacts.find((row) => row.issue === 233).commit =
        "62b3eaf02cf001dfb6847f356cc533c6d3122d50"),
  ],
  [
    "stale-233-oracle-pin",
    (value) =>
      (value.acceptedArtifacts.find((row) => row.issue === 233).oracleSha256 =
        "503eee3b4c19ca0f455fd33d1673a90b87682a202f6f1dadb718bc3dd01fa456"),
  ],
  [
    "stale-234-pin",
    (value) =>
      (value.acceptedArtifacts.find((row) => row.issue === 234).commit =
        "896405ac26aff907691d17908c9c4fa79b15cc71"),
  ],
  [
    "old-converter-pin",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "MIGRATION-HISTORY-CONVERSION").sha256 =
        "3a2214382060d7627107dda4a1d9b5630d89077ec95c5d24d0e52c756a4cc97a"),
  ],
  [
    "stale-233-checker-pin",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "MIGRATION-REGISTRY-CHECKER").sha256 =
        "e813cefdbbe84b45882de43f1a43423c77c4a4214a46835e366fa7da6be944a7"),
  ],
  [
    "stale-233-design-pin",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "MIGRATION-REGISTRY-DESIGN").sha256 =
        "f4505e55eaafca0f1085fe37844336433963511c9080fa95900de488db0df128"),
  ],
  [
    "stale-233-decisions-pin",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "MIGRATION-REGISTRY-DECISIONS").sha256 =
        "07fb450c0583813e9bc0b8f11fc2a7931ae34b77852c04d6c7e5d05d410565b5"),
  ],
  [
    "stale-233-coverage-pin",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "MIGRATION-REGISTRY-COVERAGE").sha256 =
        "2e1c6445dc1bfb43579459f012f53428e52e06b8761f5e2e29a23130c2281c37"),
  ],
  [
    "stale-234-database-pin",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "DATABASE").sha256 =
        "6a4a162dd5406e8f321a1eef5d99faf768365f626e1742aa513e06cd97209c84"),
  ],
  [
    "stale-234-migration-runner-pin",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "MIGRATION-RUNNER").sha256 =
        "c51d194bd1b9280da78c94fdc4acebcb87d5012ae979e5d9d86084d4973401bd"),
  ],
  [
    "stale-234-storage-index-pin",
    (value) =>
      (value.frozenInputs.find((row) => row.id === "STORAGE-INDEX").sha256 =
        "54bf151e4818cc85c469f4e37f4665837b607d2a7c3223b7de0b5572f1924d1c"),
  ],
  [
    "legacy-converter-live-tip-sequence",
    (value) =>
      (value.persistenceAuthority.prefixEvolutionAuthority.legacyConversionSequence[1] =
        "iterate the complete live registry"),
  ],
  [
    "legacy-opener-bypass-sequence",
    (value) =>
      (value.persistenceAuthority.prefixEvolutionAuthority.legacyConversionSequence[4] =
        "run suffixes only for non-legacy opens"),
  ],
  [
    "implementation-sequence-mode",
    (value) =>
      (value.persistenceAuthority.prefixEvolutionAuthority.implementationSequenceMode =
        "--implementation-check"),
  ],
  [
    "implementation-sequence-mutation",
    (value) =>
      value.persistenceAuthority.prefixEvolutionAuthority.implementationSequenceMutationIds.pop(),
  ],
  [
    "safe-recorder-before-suffix",
    (value) => {
      const sequence = value.persistenceAuthority.prefixEvolutionAuthority.safeRecorderSequence;
      [sequence[1], sequence[2]] = [sequence[2], sequence[1]];
    },
  ],
  [
    "safe-recorder-fingerprint-bypass",
    (value) =>
      (value.persistenceAuthority.prefixEvolutionAuthority.legacyFixtureRecorder =
        "trustRecordedCanonicalApplicationDatabase"),
  ],
  [
    "strict-runner-compatibility-bypass",
    (value) =>
      (value.persistenceAuthority.prefixEvolutionAuthority.strictMigrationRunner = "runMigrations"),
  ],
  [
    "implementation-compatibility-mode",
    (value) =>
      (value.persistenceAuthority.prefixEvolutionAuthority.implementationCompatibilityMode =
        "--implementation-check"),
  ],
  [
    "implementation-compatibility-mutation",
    (value) =>
      value.persistenceAuthority.prefixEvolutionAuthority.implementationCompatibilityMutationIds.pop(),
  ],
  ["frozen-input-drift", (value) => (value.frozenInputs[0].sha256 = "0".repeat(64))],
  ["public-route", (value) => (value.publicBoundary.route = "/v2/reports")],
  ["public-schema", (value) => (value.publicBoundary.schemaDisposition = "widened")],
  ["identity-domain", (value) => (value.identityAuthority.domain = "agent-mail/report/v1")],
  ["identity-vector", (value) => (value.identityAuthority.knownVector.reportId = "report:wrong")],
  ["identity-replay", (value) => (value.identityAuthority.replayRule = "")],
  ["identity-replay-read", (value) => (value.identityAuthority.replayReadProjection = "")],
  ["identity-replay-scope", (value) => (value.identityAuthority.replayAuthorizationRule = "")],
  ["string-serialization", (value) => (value.identityAuthority.stringSerialization = "")],
  ["string-corpus", (value) => value.identityAuthority.stringRoundTripCorpus.pop()],
  ["source-outcome", (value) => (value.sourceAuthority.outcomes[2].status = 400)],
  ["source-raw-fallback", (value) => (value.sourceAuthority.forbiddenContent = "")],
  ["source-snapshot", (value) => (value.sourceAuthority.snapshotRule = "")],
  ["citation-label", (value) => (value.sourceAuthority.citationRule = "")],
  ["normalized-production", (value) => (value.normalizedTextAuthority.productionRule = "")],
  ["normalized-proof", (value) => (value.normalizedTextAuthority.proofRule = "")],
  ["materializer-state", (value) => value.normalizedTextAuthority.materializerStates.pop()],
  ["renderer-binding", (value) => (value.reportModelAuthority.rendererBinding = "latest")],
  ["renderer-rule", (value) => (value.reportModelAuthority.renderRule = "")],
  ["persistence-table", (value) => value.persistenceAuthority.tables.pop()],
  ["persistence-column", (value) => value.persistenceAuthority.tables[0].columns.pop()],
  ["persistence-foreign-key", (value) => value.persistenceAuthority.foreignKeys.pop()],
  ["persistence-publication-guard", (value) => value.persistenceAuthority.publicationGuards.pop()],
  [
    "persistence-duplicate-guard",
    (value) => value.persistenceAuthority.duplicateInsertGuards.pop(),
  ],
  ["invented-migration-slot", (value) => (value.persistenceAuthority.migrationVersion = 777)],
  ["transaction-step", (value) => value.persistenceAuthority.transactionSteps.pop()],
  ["failure-boundary", (value) => value.persistenceAuthority.failureInjectionBoundaries.pop()],
  [
    "provenance-method",
    (value) => (value.provenanceAuthority.authorizationMethod = "trusted-proxy"),
  ],
  ["provenance-caller", (value) => value.provenanceAuthority.forbiddenSources.pop()],
  ["provenance-source-scope", (value) => (value.provenanceAuthority.firstCreateScopeRule = "")],
  ["serving-owner", (value) => (value.servingAuthority.repositoryRule = "")],
  ["cli-exit", (value) => (value.cliAuthority.errorMappings[1].exit = 1)],
  ["capacity-source-count", (value) => (value.capacityAuthority.maxSourceIds = 1000)],
  ["policy-report-count", (value) => (value.capacityAuthority.maxCommittedReports = 9999)],
  ["policy-logical-bytes", (value) => (value.capacityAuthority.maxLogicalChargedBytes = 1)],
  [
    "policy-rate-attempts",
    (value) => (value.capacityAuthority.maxNonReplayAttemptsPerRollingWindow = 11),
  ],
  ["policy-rate-window", (value) => (value.capacityAuthority.rollingWindowMilliseconds = 1)],
  ["policy-rate-ledger", (value) => (value.capacityAuthority.rateLedgerTable = "other")],
  ["policy-admission-order", (value) => (value.capacityAuthority.admissionOrder = "")],
  [
    "rate-admission-after-mail-read",
    (value) => {
      const sequence = value.capacityAuthority.admissionSequence;
      const rate = sequence.indexOf("durable-rate-ledger-admission");
      const mail = sequence.indexOf("mail:read.message-authorization");
      [sequence[rate], sequence[mail]] = [sequence[mail], sequence[rate]];
    },
  ],
  [
    "missing-scope-zero-total-writes",
    (value) =>
      (value.provenanceAuthority.missingSourceScopePostcondition.zeroTotalWritesClaim = true),
  ],
  [
    "missing-scope-trace-zero-total-writes",
    (value) =>
      (value.constructiveTraces.find((row) => row.id === "TRACE-FIRST-CREATE-SCOPES").expected =
        "first-create missing source scope writes zero"),
  ],
  ["policy-logical-charge", (value) => (value.capacityAuthority.logicalChargeRule = "")],
  ["http-operation-cap", (value) => (value.capacityAuthority.httpAdmissionRule = "")],
  ["durable-growth-gap", (value) => (value.capacityAuthority.durableGrowthRule = "")],
  ["retention-ttl", (value) => (value.capacityAuthority.retentionRule = "")],
  [
    "policy-capacity-message",
    (value) =>
      (value.serviceDispositionAuthority.boundaryMessages.policyCapacityExhausted = "wrong"),
  ],
  [
    "service-disposition",
    (value) => (value.serviceDispositionAuthority.terminals[1].publicCode = "invalid_request"),
  ],
  ["public-outcome", (value) => (value.publicOutcomes[3].code = "invalid_request")],
  ["trace-removal", (value) => value.constructiveTraces.pop()],
  ["forbidden-removal", (value) => value.forbiddenStates.pop()],
  ["security-shield", (value) => (value.planningShieldApplicability[9].status = "not-applicable")],
  ["decision-removal", (value) => value.decisions.pop()],
  ["issue232-file", (value) => value.downstream.issue232.productionFiles.pop()],
  ["issue232-base", (value) => (value.downstream.issue232.implementationBase = "wrong")],
  ["issue232-obligation", (value) => value.downstream.issue232.implementationObligations.pop()],
  [
    "issue232-prefix-composition-test",
    (value) =>
      (value.downstream.issue232.testFiles = value.downstream.issue232.testFiles.filter(
        (path) => path !== "packages/storage/test/migration-history-conversion.test.ts",
      )),
  ],
  [
    "issue232-remote-placement-test",
    (value) =>
      (value.downstream.issue232.testFiles = value.downstream.issue232.testFiles.filter(
        (path) => path !== "packages/storage/test/remote-placement-observation-p3-c12.test.ts",
      )),
  ],
  [
    "issue232-search-corpus-test",
    (value) =>
      (value.downstream.issue232.testFiles = value.downstream.issue232.testFiles.filter(
        (path) => path !== "packages/storage/test/search-corpus-p4-c16.test.ts",
      )),
  ],
  [
    "issue232-backup-restore-parity-test",
    (value) =>
      (value.downstream.issue232.testFiles = value.downstream.issue232.testFiles.filter(
        (path) => path !== "packages/storage/test/backup-restore-parity-p2-c19.test.ts",
      )),
  ],
  [
    "focused-suite-timeout-override",
    (value) =>
      value.downstream.issue232.focusedSuiteAuthority.command.splice(2, 0, "--timeout", "20000"),
  ],
  [
    "focused-suite-timeout-authorized",
    (value) => (value.downstream.issue232.focusedSuiteAuthority.timeoutOverrideAllowed = true),
  ],
  [
    "focused-suite-timeout-raised",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.defaultPerTestTimeoutMilliseconds = 20000),
  ],
  [
    "remote-normalized-text-literal",
    (value) => (value.downstream.issue232.focusedSuiteAuthority.normalizedTextLiteral = "fallback"),
  ],
  [
    "remote-normalized-text-optional",
    (value) => (value.downstream.issue232.focusedSuiteAuthority.normalizedTextRule = "optional"),
  ],
  [
    "canonical-boundary-reopens-per-ordinal",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.canonicalBoundaryRule =
        "open one database per failure ordinal"),
  ],
  [
    "canonical-cleanup-removes-before-close",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.cleanupRule =
        "remove roots before closing live handles"),
  ],
  [
    "canonical-production-scope-widening",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.protectedDependencyRule =
        "change database.ts to disable WAL"),
  ],
  [
    "canonical-stale-base-pin",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.canonicalPromotionAcceptedBaseSha256 =
        "0".repeat(64)),
  ],
  [
    "remote-stale-base-pin",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.remotePlacementAcceptedBaseSha256 =
        "0".repeat(64)),
  ],
  [
    "search-corpus-stale-base-pin",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.acceptedBaseSha256 =
        "0".repeat(64)),
  ],
  [
    "search-corpus-stale-schema-version",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.canonicalSchemaVersion = 27),
  ],
  [
    "search-corpus-stale-four-index-count",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.canonicalIndexCount = 4),
  ],
  [
    "search-corpus-wrong-index-digest",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.canonicalIndexTupleSha256 =
        "0".repeat(64)),
  ],
  [
    "search-corpus-slot28-index-omission",
    (value) =>
      value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.slot28IndexNames.pop(),
  ],
  [
    "search-corpus-count-only-query",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.indexQuery =
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index'"),
  ],
  [
    "search-corpus-self-derived-oracle",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.derivationRule =
        "derive expected indexes from the corpus database under test"),
  ],
  [
    "search-corpus-count-only-comparison",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.comparisonRule =
        "compare only schemaIndexTotal"),
  ],
  [
    "search-corpus-mutation-gap",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.searchCorpusIndexAuthority.mutationRule =
        "reject omissions only"),
  ],
  [
    "backup-parity-stale-base-pin",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.acceptedBaseSha256 =
        "0".repeat(64)),
  ],
  [
    "backup-parity-fallback-source",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.normalizedTextSourceExpression =
        "unit.normalizedText ?? comparisonFixture.plainBody"),
  ],
  [
    "backup-parity-wrong-normalized-text",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.normalizedTextLiteral =
        "fallback"),
  ],
  [
    "backup-parity-wrong-canonical-json",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.canonicalJsonSha256 =
        "0".repeat(64)),
  ],
  [
    "backup-parity-optional-field",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.missingFieldRule =
        "normalizedText may be omitted"),
  ],
  [
    "backup-parity-decoded-only",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.parityRule =
        "compare decoded strings only"),
  ],
  [
    "backup-parity-fixture-production-widening",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.fixtureRule =
        "change production promotion to synthesize normalizedText"),
  ],
  [
    "backup-parity-base-outcome-drift",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.isolatedComparison.acceptedBase.passes = 1),
  ],
  [
    "backup-parity-candidate-outcome-drift",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.isolatedComparison.candidateBeforeRepair.fails = 1),
  ],
  [
    "backup-parity-acceptance-scope-widening",
    (value) =>
      value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.isolatedComparison.candidateAfterRepair.allowedChangedPaths.push(
        "packages/storage/src/database.ts",
      ),
  ],
  [
    "backup-parity-mutation-gap",
    (value) =>
      (value.downstream.issue232.focusedSuiteAuthority.backupRestoreParityAuthority.mutationRule =
        "reject omission only"),
  ],
  [
    "staged-eml-http-cli-proof-path",
    (value) =>
      value.downstream.issue232.focusedSuiteAuthority.proofPathBindings.stagedEmlHttpCli.pop(),
  ],
  [
    "policy-a-proof-path",
    (value) =>
      value.downstream.issue232.focusedSuiteAuthority.proofPathBindings.policyABoundaries.pop(),
  ],
  [
    "concurrency-replace-recovery-proof-path",
    (value) =>
      value.downstream.issue232.focusedSuiteAuthority.proofPathBindings.concurrencyReplaceRecovery.pop(),
  ],
  ["issue165-cell", (value) => value.downstream.issue165.cells.pop()],
  ["issue165-dimensions", (value) => value.downstream.issue165.outcomeDimensions.pop()],
];

const boundaryMutations = [
  ["issue232-protected-path", "packages/contracts/src/report-admin-operations.ts", "path"],
  [
    "issue232-migration-authority-protected",
    "docs/architecture/database-migration-registry-oracle.v1.json",
    "path",
  ],
  [
    "issue232-converter-production-protected",
    "packages/storage/src/migration-history-conversion.ts",
    "path",
  ],
  ["issue232-database-production-protected", "packages/storage/src/database.ts", "path"],
  [
    "issue232-migration-runner-production-protected",
    "packages/storage/src/migration-runner.ts",
    "path",
  ],
  ["issue232-unknown-path", "packages/daemon/src/unknown-report-path.ts", "path"],
  ["issue232-search-generator-unknown", "scripts/capacity/generate-search-corpus.ts", "path"],
  ["issue232-undeclared-drift", "packages/daemon/src/http.ts", "drift"],
  ["issue232-missing-frozen-input", "packages/daemon/src/http.ts", "missing"],
];

function runSelfTest(oracle) {
  const failures = [];
  for (const [id, mutate] of mutations) {
    const candidate = clone(oracle);
    mutate(candidate);
    try {
      validateOracle(candidate);
      failures.push(id);
    } catch {
      // Expected: each mutation must violate a checked invariant.
    }
  }
  for (const [id, path, kind] of boundaryMutations) {
    try {
      if (kind === "path") validateChangedPaths(oracle.downstream.issue232, [path]);
      else {
        validateWorktreeDrift(
          oracle.downstream.issue232,
          [{ id: "HTTP-BOUNDARY", path, observed: kind === "missing" ? null : "0".repeat(64) }],
          kind === "missing" ? [path] : [],
        );
      }
      failures.push(id);
    } catch {
      // Expected: protected/unknown paths and missing/undeclared drift fail closed.
    }
  }
  try {
    validateWorktreeDrift(
      oracle.downstream.issue232,
      [{ id: "HTTP-BOUNDARY", path: "packages/daemon/src/http.ts", observed: "0".repeat(64) }],
      ["packages/daemon/src/http.ts"],
    );
  } catch {
    failures.push("issue232-declared-allowed-drift");
  }
  try {
    validateChangedPaths(oracle.downstream.issue232, [
      "packages/storage/test/canonical-promotion-p2-c13.test.ts",
      "packages/storage/test/remote-placement-observation-p3-c12.test.ts",
      "packages/storage/test/search-corpus-p4-c16.test.ts",
      "packages/storage/test/backup-restore-parity-p2-c19.test.ts",
    ]);
  } catch {
    failures.push("issue232-focused-scope-allowed");
  }
  if (failures.length > 0) fail("mutation self-test survived: " + failures.join(", "));
  return mutations.length + boundaryMutations.length;
}

function worktreeDrift(oracle) {
  const drift = [];
  for (const input of oracle.frozenInputs) {
    try {
      const observed = sha256(readFileSync(join(repositoryRoot, input.path)));
      if (observed !== input.sha256) drift.push({ id: input.id, path: input.path, observed });
    } catch {
      drift.push({ id: input.id, path: input.path, observed: null });
    }
  }
  return drift;
}

function validateWorktreeDrift(issue232, drift, changedPaths) {
  const declared = new Set(changedPaths);
  for (const row of drift) {
    if (row.observed === null) fail("frozen input is missing: " + row.id + ":" + row.path);
    if (!declared.has(row.path)) {
      fail("undeclared frozen input worktree drift: " + row.id + ":" + row.path);
    }
    validateChangedPaths(issue232, [row.path]);
  }
}

const oracleBytes = readFileSync(oraclePath);
const oracleDigest = sha256(oracleBytes);
let oracle;
try {
  oracle = JSON.parse(oracleBytes.toString("utf8"));
} catch {
  fail("oracle is not valid JSON");
}

validateOracle(oracle, { checkSources: true });

const changedPaths = process.argv
  .filter((value) => value.startsWith("--changed-path="))
  .map((value) => value.slice("--changed-path=".length));
if (changedPaths.length > 0) validateChangedPaths(oracle.downstream.issue232, changedPaths);

if (process.argv.includes("--print-views")) {
  const rendered = projections(oracle, oracleDigest);
  await writeStdout(
    rendered.map((value, index) => "===== " + viewPaths[index] + " =====\n" + value).join(""),
  );
  process.exit(0);
}

const printView = process.argv.find((value) => value.startsWith("--print-view="));
if (printView !== undefined) {
  const index = Number.parseInt(printView.slice("--print-view=".length), 10);
  const rendered = projections(oracle, oracleDigest);
  if (!Number.isSafeInteger(index) || rendered[index] === undefined) fail("invalid view index");
  await writeStdout(rendered[index]);
  process.exit(0);
}

if (EXPECTED_ORACLE_SHA256 === "PENDING") fail("oracle digest is not pinned");
if (oracleDigest !== EXPECTED_ORACLE_SHA256) {
  fail("oracle digest differs: " + oracleDigest);
}

const renderedViews = projections(oracle, oracleDigest);
for (const [index, path] of viewPaths.entries()) {
  let observed;
  try {
    observed = readFileSync(path, "utf8");
  } catch {
    fail("checked view is missing: " + path);
  }
  if (observed !== renderedViews[index]) fail("checked projection differs: " + path);
  const digest = sha256(Buffer.from(observed, "utf8"));
  if (digest !== EXPECTED_VIEW_SHA256[index]) {
    fail("checked view digest differs: " + path + " " + digest);
  }
}

const selfTestCount = process.argv.includes("--self-test") ? runSelfTest(oracle) : 0;
const drift = worktreeDrift(oracle);
validateWorktreeDrift(oracle.downstream.issue232, drift, changedPaths);
process.stdout.write(
  JSON.stringify({
    ok: true,
    acceptedHead: ACCEPTED_HEAD,
    oracleSha256: oracleDigest,
    viewSha256: EXPECTED_VIEW_SHA256,
    frozenInputs: oracle.frozenInputs.length,
    requirements: oracle.requirements.length,
    traces: oracle.constructiveTraces.length,
    forbiddenStates: oracle.forbiddenStates.length,
    mutations: selfTestCount,
    worktreeDrift: drift,
  }) + "\n",
);
