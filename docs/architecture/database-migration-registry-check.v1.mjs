import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_ORACLE_SHA256 = "08d817c11ba3d1a8f213f9254fdb792f43e9384b1a70471788c59497cb432345";
const EXPECTED_VIEW_SHA256 = [
  "d88a844683490e20da12ba57a4f99496ee97878e777e00ae407d5e78f8b61609",
  "38feb62fae9dc733ed41dd2c1a0bfe23147e3237c64f081abcf12c0c4d3d2c0e",
  "ca2454f35a5f84ae87db783e1fccc7c2d3acb12aa61fafe5bbb5e29696cd03d6",
];
const ACCEPTED_HEAD = "547f70dd67959541324688b7b737749bc43791ab";
const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(directory, "../..");
const oraclePath = join(directory, "database-migration-registry-oracle.v1.json");
const viewPaths = [
  join(directory, "database-migration-registry-design.v1.md"),
  join(directory, "database-migration-registry-decisions.v1.md"),
  join(directory, "database-migration-registry-coverage.v1.md"),
];
const authorityArtifactPaths = new Set([
  relative(repositoryRoot, fileURLToPath(import.meta.url)),
  relative(repositoryRoot, oraclePath),
  ...viewPaths.map((path) => relative(repositoryRoot, path)),
]);

const CANONICAL_SIGNATURES = [
  "message-catalog:efed8a776eb3b10e6fc2ae274547e518e196d46daa6b646ff88f74f7928db334:on",
  "operational-journal:afb153e614a4233be9f3f1155852bd6f68008fde84878891b0279e4f30862013:on",
  "structured-content:d6b7499b793c0d004e375860ce9304d3a6c35c6fa1db280034b3f1650a690911:on",
  "routing-preview:79b8411046df9988be783acf9b0309672824ffda5cd286e3e6ba2ba52f47a34b:on",
  "action-schema:3988266a7422cab54f4a99aa39641b56c4939779686f4cce461ae4f51efffb3e:on",
  "mailbox-checkpoint-extension:2f3ceb36433eb04d04c812b8168c32dd849fc874842e285a65f4001b57eb20fd:on",
  "local-labels:4a76efa836865727034b605a8074f84cbbf4d2cfb1f4cde4305222114682bcb0:on",
  "external-content-search:0dccdafb0962ee76d930a88a57af13ec1e46405e8ce53f9a068e40257348c626:on",
  "action-plan-proposal-evidence:22034f49119a630a02197e9f788eff9f154095ac4b0c517c5b3da8d9421e5eab:on",
  "operational-journal-compaction:6b5fc2997036e38a85caa2534edfdd543c6ea40d57174518a326094d0961806e:on",
  "routing-decisions:b6da2e9673c39cc68bb5a9f10f228b3effb9b520fb07a8a5d06faf93fecaad9c:on",
  "identity-only-content:59fb64c8d5554121698c01674aa9663f9c18b1ce7e7fd28046b6affd4fa826bb:on",
  "routing-preview-consumption:0b084e173211b95384c5928c0cfbf22b4e6ee40f7faaa54a3633fe5a624fc6df:on",
  "action-plan-claim-version:0dbbbbd90d31e69187b5735c4fdf012a6a89653b2067338d571ccc16402958aa:on",
  "action-attempt-start-boundary:8342a92455a61be235504aafdc69f7fc9409cdf1a1e277619fe91028f8a17e60:on",
  "remote-placement-observation:a61a94191cb19c0b5e619da3ccd1d58bb07b511f215b4ef2d2605670bcbbfe2a:on",
  "message-blob-references:e4033a51c70fef0a678652129e47e3e3d73e4e9c9da23718043d3b82e61dbea8:on",
  "initial-backfill-completion:97f36004ad5e03159be30d1b2e663e37f4b983eadf65a79fd3c463ccd676ea0b:on",
  "search-candidate-placement-index:d42db322e6e0652811ab8571f13d8e24816ebc26bbd47b5e2bfc3f49872343c4:on",
  "search-reindex-schema:e3f8eb52d805c6b35fc12efbb0c3f3a8907ab24eaaceb22f6afaf3029fb7d0d0:on",
  "routing-decision-origins:bc90efaf7a8217bf94a65165df39cc16b4935eff08bdcd7f6648010ef1b9d298:on",
  "action-attempt-dispatch-evidence:8e0f4bf1caee9a414eef808934b8c993621d560e2ba2b8c30e2f7018c4274131:on",
  "action-result-reconciliation-transition:7766420d878431a0a7b33df0483931431b6daaf4568114a0749f97a3165f5af9:on",
  "thread-graph:cdf5af5482ca1b1b28436d42371cc91723b45a20f1747c7fb0bfeb6fb6411c9c:on",
  "action-approval-authority-v1:0f3bf555e87b7e82e0f50725301cced4ef00391715ec91bcaad53f0c16d15264:on",
  "action-plan-restore-quarantine:150cb6277c84be4e6cd5e056d99662f2db12b65f47e96ec45d20b20de6df6cab:off",
  "seal-key-administration-authority:0715be56cd5ee39745a5be25d2c041ec0ccac70d6c09abb9e455820bf091e184:off",
];

function fail(message) {
  throw new Error("database migration registry check failed: " + message);
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
  if (new Set(values).size !== values.length) fail(label + " has duplicate " + key);
  return new Map(rows.map((row) => [row[key], row]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function computeRegistryIdentityDigest(migrations) {
  return sha256(
    Buffer.from(
      JSON.stringify(
        migrations.map((migration) => [
          migration.version,
          migration.name,
          migration.contentHash ?? migration.content_hash,
          migration.requiresForeignKeysOff ?? false,
        ]),
      ),
      "utf8",
    ),
  );
}

function acceptedConversionTargets(oracle) {
  const targets = new Map();
  for (const target of oracle.appendStableProvenance.acceptedHistoricalTargets) {
    if (targets.has(target.targetRegistrySha256)) {
      fail("accepted conversion target digest collision: " + target.targetRegistrySha256);
    }
    targets.set(target.targetRegistrySha256, target.targetVersion);
  }
  return targets;
}

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: options.buffer === true ? "buffer" : "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.ignore === true ? "ignore" : undefined,
    });
  } catch {
    fail("git command failed: git " + args.join(" "));
  }
}

function readCommitted(path) {
  return git(["show", ACCEPTED_HEAD + ":" + path], { buffer: true });
}

function assertAncestor(commit, descendant, label) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, descendant], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    fail(label + " is not an ancestor: " + commit + " -> " + descendant);
  }
}

function grepCommitted(pattern, { extended = false } = {}) {
  const args = ["grep", "-n", extended ? "-E" : "-F", pattern, ACCEPTED_HEAD, "--", "*.ts"];
  try {
    const output = execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    return output.length === 0 ? [] : output.split("\n");
  } catch (error) {
    if (error?.status === 1) return [];
    fail("cannot scan accepted source for " + pattern);
  }
}

function validateFrozenInputs(oracle, checkGit) {
  const inputMap = uniqueRows(oracle.frozenInputs, "id", "frozen inputs");
  exactSet(
    inputMap.keys(),
    [
      "AGENTS",
      "PLAN",
      "EVIDENCE",
      "METRICS",
      "DATABASE",
      "RUNNER",
      "DOCTOR",
      "BACKUP-MANIFEST",
      "BACKUP-WRITER",
      "BACKUP-RESTORE",
      "FULL-RESTORE",
      "DAEMON-BACKUP",
      "DAEMON-DOCTOR",
      "STORAGE-EXPORT",
      "THREAD-COMPOSER",
      "SEARCH-REINDEX",
    ],
    "frozen input IDs",
  );
  for (const input of oracle.frozenInputs) {
    nonempty(input.path, "frozen input path");
    nonempty(input.kind, "frozen input kind");
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) fail("invalid frozen input hash: " + input.id);
    if (checkGit && sha256(readCommitted(input.path)) !== input.sha256) {
      fail("accepted input hash differs: " + input.id);
    }
  }
}

function validateOracle(oracle, { checkGit = true } = {}) {
  exact(oracle.format, "agent-mail.database-migration-registry-oracle/v1", "format");
  exact(oracle.schemaVersion, 1, "oracle schema version");
  exact(oracle.modelVersion, "1.0.0", "model version");
  exact(oracle.status, "frozen-design", "status");
  exact(oracle.oracle.issue, 233, "issue");
  exact(oracle.oracle.implementationIssue, 234, "implementation issue");
  exact(oracle.oracle.shapingCommit, ACCEPTED_HEAD, "shaping commit");
  exact(oracle.oracle.normative, true, "normative flag");
  for (const key of ["scope", "compatibilityRule", "absenceOfDeploymentAuthority"]) {
    nonempty(oracle.oracle[key], "oracle " + key);
  }

  exact(oracle.baseline.productionRegistry, "absent", "production registry baseline");
  exact(oracle.baseline.productionMigrationConsumer, "absent", "migration consumer baseline");
  exact(oracle.baseline.defaultSchemaCeiling, 11, "legacy schema ceiling");
  nonempty(oracle.baseline.ceilingDisposition, "schema ceiling disposition");
  exact(oracle.baseline.acceptedSemanticMigrationCount, 27, "semantic count");
  exact(oracle.baseline.freshSchemaObjectCount, 193, "fresh schema object count");
  exact(oracle.baseline.unrecordedSchemaSemanticCount, 1, "unrecorded schema count");
  exact(oracle.baseline.schemaDefinitionSourceFiles, 27, "schema definition source count");
  exact(oracle.baseline.convertibleCompositionCount, 44, "convertible composition count");
  exact(oracle.baseline.uniqueConvertiblePrefixCount, 76, "convertible prefix count");
  exact(
    oracle.baseline.declaredVersionCollisions,
    { 1: 10, 2: 5, 3: 4, 4: 1, 5: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1 },
    "declared version distribution",
  );
  exact(oracle.baseline.applyMigrationSourceFiles, 62, "migration corpus files");
  exact(oracle.baseline.applyMigrationCallSites, 94, "migration corpus calls");
  exact(
    oracle.baseline.applyMigrationCorpusSha256,
    "e35638caca271c94c87421d10f12f204b8a3ae38daee54e928323943cfaafa70",
    "migration corpus digest",
  );
  exact(
    oracle.baseline.applyMigrationCorpusSelection,
    "git grep -l -F applyMigrations( <acceptedHead> -- *.ts",
    "migration corpus selection",
  );
  exact(
    oracle.baseline.executionRootScriptPaths,
    ["scripts/capacity/benchmark-search.ts", "scripts/capacity/generate-search-corpus.ts"],
    "execution root scripts",
  );
  exact(oracle.baseline.placeholderOccurrences, 4, "placeholder count");
  exact(oracle.baseline.dynamicThreadComposerOccurrences, 3, "thread composer count");
  exact(oracle.baseline.directAcceptedSqlBypassOccurrences, 3, "direct SQL count");
  exact(oracle.baseline.adHocMigrationRegistryExports, 30, "ad hoc registry export count");

  exact(oracle.checksumAuthority.algorithm, "sha256", "checksum algorithm");
  exact(oracle.checksumAuthority.textEncoding, "utf8", "checksum encoding");
  for (const key of [
    "ordinaryMaterial",
    "foreignKeysOffMaterial",
    "immutability",
    "sourceVersionRule",
  ]) {
    nonempty(oracle.checksumAuthority[key], "checksum authority " + key);
  }

  exact(oracle.canonicalRegistry.schemaVersion, 27, "canonical schema version");
  exact(oracle.canonicalRegistry.nextLegalMigrationVersion, 28, "next migration version");
  exact(oracle.canonicalRegistry.nextLegalReportMigrationVersion, 28, "report migration version");
  exact(
    oracle.canonicalRegistry.identityDigestAlgorithm,
    "sha256(utf8(JSON.stringify(migrations.map(m => [m.version, m.name, m.contentHash, m.requiresForeignKeysOff]))))",
    "registry identity algorithm",
  );
  exact(
    oracle.canonicalRegistry.registryPath,
    "packages/storage/src/migration-registry.ts",
    "registry path",
  );
  exact(
    oracle.canonicalRegistry.conversionPath,
    "packages/storage/src/migration-history-conversion.ts",
    "conversion path",
  );
  nonempty(oracle.canonicalRegistry.orderRule, "canonical order rule");

  const migrations = oracle.canonicalRegistry.migrations;
  if (!Array.isArray(migrations) || migrations.length !== 27)
    fail("canonical registry must have 27 rows");
  const byId = uniqueRows(migrations, "id", "canonical migrations");
  uniqueRows(migrations, "version", "canonical migrations");
  uniqueRows(migrations, "name", "canonical migrations");
  uniqueRows(migrations, "contentHash", "canonical migrations");
  uniqueRows(migrations, "source", "canonical migrations");
  const signatures = [];
  const declaredVersions = {};
  let previousCommit;
  for (const [index, migration] of migrations.entries()) {
    exact(migration.version, index + 1, "canonical slot " + (index + 1));
    exact(migration.name, migration.id, "canonical name " + migration.id);
    if (migration.id === "search-reindex-schema") {
      exact(migration.declaredVersion, null, "reindex legacy declared version");
      exact(migration.legacyRecorded, false, "reindex legacy recorded flag");
      exact(migration.sourceKind, "sql-constant", "reindex source kind");
    } else {
      if (!Number.isSafeInteger(migration.declaredVersion) || migration.declaredVersion < 1) {
        fail("invalid declared version: " + migration.id);
      }
      if (migration.legacyRecorded !== undefined || migration.sourceKind !== undefined) {
        fail("unexpected legacy source metadata: " + migration.id);
      }
      declaredVersions[migration.declaredVersion] =
        (declaredVersions[migration.declaredVersion] ?? 0) + 1;
    }
    if (!/^[0-9a-f]{64}$/.test(migration.contentHash))
      fail("invalid content hash: " + migration.id);
    if (!/^[0-9a-f]{40}$/.test(migration.acceptedCommit))
      fail("invalid accepted commit: " + migration.id);
    if (!Number.isSafeInteger(migration.acceptedIssue) || migration.acceptedIssue < 1) {
      fail("invalid accepted issue: " + migration.id);
    }
    nonempty(migration.source, "source " + migration.id);
    nonempty(migration.export, "export " + migration.id);
    if (typeof migration.requiresForeignKeysOff !== "boolean")
      fail("missing execution mode: " + migration.id);
    signatures.push(
      migration.id +
        ":" +
        migration.contentHash +
        ":" +
        (migration.requiresForeignKeysOff ? "off" : "on"),
    );
    for (const dependency of migration.dependsOn) {
      const dependencyRow = byId.get(dependency);
      if (dependencyRow === undefined || dependencyRow.version >= migration.version) {
        fail("dependency is not earlier: " + migration.id + " -> " + dependency);
      }
    }
    if (checkGit) {
      assertAncestor(migration.acceptedCommit, ACCEPTED_HEAD, "accepted migration commit");
      if (previousCommit !== undefined && previousCommit !== migration.acceptedCommit) {
        assertAncestor(previousCommit, migration.acceptedCommit, "canonical commit order");
      }
      readCommitted(migration.source);
    }
    previousCommit = migration.acceptedCommit;
  }
  exact(signatures, CANONICAL_SIGNATURES, "canonical signatures");
  const registryIdentityDigest = sha256(
    Buffer.from(
      JSON.stringify(
        migrations.map((migration) => [
          migration.version,
          migration.name,
          migration.contentHash,
          migration.requiresForeignKeysOff,
        ]),
      ),
      "utf8",
    ),
  );
  exact(
    oracle.canonicalRegistry.identityDigest,
    registryIdentityDigest,
    "registry identity digest",
  );
  const appendAuthority = oracle.appendStableProvenance;
  exact(appendAuthority.legacyConversionTargetVersion, 27, "legacy conversion target version");
  exact(
    appendAuthority.targetDigestAlgorithm,
    "sha256(utf8(JSON.stringify(canonicalMigrations.slice(0, targetVersion).map(m => [m.version, m.name, m.contentHash, m.requiresForeignKeysOff]))))",
    "conversion target digest algorithm",
  );
  for (const key of [
    "currentRegistryIdentity",
    "historicalTargetIdentity",
    "targetRelations",
    "proofSuffixAuthority",
    "operationRule",
    "failureRule",
    "issue234RegistryContract",
    "issue234ConverterContract",
    "issue234RunnerContract",
    "issue234OpenerContract",
    "issue234PreflightContract",
    "issue234ProofContract",
  ]) {
    nonempty(appendAuthority[key], "append-stable provenance " + key);
  }
  exact(
    appendAuthority.acceptedHistoricalTargets,
    [{ targetVersion: 27, targetRegistrySha256: registryIdentityDigest }],
    "accepted historical conversion targets",
  );
  exact(
    acceptedConversionTargets(oracle).get(registryIdentityDigest),
    27,
    "current registry is recognized conversion target",
  );
  exact(
    appendAuthority.legacyConversionSequence,
    [
      "resolve the sole accepted historical target before conversion and freeze targetVersion 27 plus digest 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab",
      "derive targetMigrations as canonicalDatabaseMigrations.slice(0, targetVersion); never iterate the complete live registry",
      "inside one BEGIN IMMEDIATE execute only missing targetMigrations 1..27, install conversion infrastructure, insert the immutable target-27 provenance row, rewrite schema_migrations exactly to targetMigrations 1..27, and set user_version exactly 27",
      "verify the complete target-27 state and commit without executing, ledgering, or setting user_version for any migration above targetVersion",
      "after conversion returns, the production opener always invokes applyMigrations with the complete live registry and beforePendingMigration; this common suffix path is not confined to a non-legacy else branch",
      "each pending 28-or-later definition runs in its own BEGIN IMMEDIATE transaction only after verifyCanonicalMigrationPrefixState accepts the locked predecessor",
    ],
    "legacy conversion and suffix sequence",
  );
  exact(
    appendAuthority.suffixTransactionOrder,
    [
      "acquire the exclusive application write-admission barrier and complete byte-identical locked revalidation",
      "BEGIN IMMEDIATE for the next pending canonical suffix",
      "reconcile the exact current canonical prefix and full schema/reindex fingerprint",
      "strictly decode every conversion row and resolve its immutable target digest to one unique canonical prefix",
      "only after that gate succeeds execute the pending migration SQL, insert its exact history row, and set user_version",
      "commit the complete suffix or roll back to the exact predecessor",
      "repeat the gate for each later suffix and run the shared final verifier before admitting writers",
    ],
    "suffix transaction order",
  );
  exact(appendAuthority.proofSuffixes.length, 2, "append proof suffix count");
  for (const [index, suffix] of appendAuthority.proofSuffixes.entries()) {
    exact(suffix.version, 28 + index, "append proof suffix version");
    exact(suffix.name, "append-stability-probe-" + suffix.version, "append proof suffix name");
    exact(suffix.requiresForeignKeysOff, false, "append proof suffix mode");
    exact(sha256(Buffer.from(suffix.sql, "utf8")), suffix.contentHash, "append proof suffix hash");
  }
  const proof28FullDigest = computeRegistryIdentityDigest([
    ...migrations,
    appendAuthority.proofSuffixes[0],
  ]);
  exact(
    acceptedConversionTargets(oracle).has(proof28FullDigest),
    false,
    "proof suffix 28 full digest is not an accepted conversion target",
  );
  exact(
    appendAuthority.implementationSequenceMode,
    "--implementation-sequence-check",
    "implementation sequence mode",
  );
  exact(
    appendAuthority.implementationSequenceMutationIds,
    ["converter-live-tip-loop", "legacy-opener-skips-suffix-runner"],
    "implementation sequence mutation IDs",
  );
  exact(appendAuthority.selfMutationCases.length, 5, "append self-mutation cases");
  for (const value of appendAuthority.selfMutationCases) {
    nonempty(value, "append self-mutation case");
  }
  exact(declaredVersions, oracle.baseline.declaredVersionCollisions, "derived declared versions");
  exact(
    migrations.flatMap((migration) =>
      migration.registrySource === undefined
        ? []
        : [{ id: migration.id, registrySource: migration.registrySource }],
    ),
    [
      {
        id: "initial-backfill-completion",
        registrySource: "packages/storage/src/migrations/initial-backfill-completion.ts",
      },
    ],
    "registry source relocations",
  );

  for (const key of [
    "supported",
    "classification",
    "schemaFingerprint",
    "schemaOverlayRule",
    "conversionBackup",
    "conversionTransaction",
    "conversionFeasibility",
    "dataRule",
    "unknownRule",
    "prefixRule",
  ]) {
    nonempty(oracle.historicalPolicy[key], "historical policy " + key);
  }

  const compositions = oracle.observedCompositions;
  const compositionMap = uniqueRows(compositions, "id", "observed compositions");
  exact(compositions.length, 47, "observed composition count");
  const allowedClassifications = new Set([
    "convertible-ledger",
    "unsupported-placeholder",
    "unsupported-direct-sql-bypass",
  ]);
  const coveredMigrations = new Set();
  const evidencePaths = new Set();
  let convertibleCompositionCount = 0;
  for (const row of compositions) {
    if (!allowedClassifications.has(row.classification))
      fail("unknown composition classification: " + row.id);
    if (!Array.isArray(row.sequence) || row.sequence.length === 0)
      fail("empty composition: " + row.id);
    if (!Array.isArray(row.evidence) || row.evidence.length === 0)
      fail("missing composition evidence: " + row.id);
    const seen = new Set();
    for (const id of row.sequence) {
      if (seen.has(id)) fail("duplicate semantic migration in composition: " + row.id);
      seen.add(id);
      if (row.classification === "convertible-ledger") {
        if (seen.size === 1) convertibleCompositionCount += 1;
        const migration = byId.get(id);
        if (migration === undefined)
          fail("convertible composition has unknown migration: " + row.id + ":" + id);
        for (const dependency of migration.dependsOn) {
          if (!seen.has(dependency))
            fail("composition dependency is absent or late: " + row.id + ":" + dependency);
        }
        coveredMigrations.add(id);
      }
    }
    if (
      row.classification === "unsupported-placeholder" &&
      !row.sequence.includes("test-action-chain-placeholder")
    ) {
      fail("placeholder composition has no placeholder: " + row.id);
    }
    if (
      row.classification === "unsupported-direct-sql-bypass" &&
      !Array.isArray(row.unrecordedSql)
    ) {
      fail("direct SQL composition has no unrecorded SQL list: " + row.id);
    }
    for (const path of row.evidence) {
      nonempty(path, "composition evidence path");
      evidencePaths.add(path);
      if (checkGit) readCommitted(path);
    }
  }
  exact(
    convertibleCompositionCount,
    oracle.baseline.convertibleCompositionCount,
    "derived convertible composition count",
  );
  exactSet(
    coveredMigrations,
    migrations.filter((row) => row.legacyRecorded !== false).map((row) => row.id),
    "recorded migrations covered by convertible histories",
  );
  if (compositionMap.get("H-ACTION-PLACEHOLDER")?.classification !== "unsupported-placeholder") {
    fail("test placeholder became convertible");
  }

  const overlays = uniqueRows(oracle.historicalSchemaOverlays, "id", "historical schema overlays");
  exactSet(
    overlays.keys(),
    [
      "O-REINDEX-ABSENT",
      "O-REINDEX-PARTIAL-EMPTY",
      "O-REINDEX-IDLE",
      "O-REINDEX-BUILDING-EMPTY-ABSENT",
      "O-REINDEX-BUILDING-EMPTY-PRESENT",
      "O-REINDEX-BUILDING",
      "O-REINDEX-ACTIVATING",
      "O-REINDEX-INVALID",
    ],
    "historical schema overlay IDs",
  );
  for (const row of oracle.historicalSchemaOverlays) {
    if (!new Set(["convertible-overlay", "unsupported-overlay"]).has(row.classification)) {
      fail("unknown overlay classification: " + row.id);
    }
    for (const key of ["state", "conversion", "provenance"]) {
      nonempty(row[key], row.id + " " + key);
    }
  }
  exact(
    oracle.historicalSchemaOverlays
      .filter((row) => row.classification === "unsupported-overlay")
      .map((row) => row.id),
    ["O-REINDEX-INVALID"],
    "unsupported schema overlays",
  );

  exact(
    oracle.reindexAuthority.operationNamePattern,
    "^[A-Za-z][A-Za-z0-9._:-]{0,127}$",
    "reindex operation-name grammar",
  );
  exact(
    oracle.reindexAuthority.operationNameEncoding,
    "UTF-8 bytes of the exact operation name; no trim, normalization, or case folding",
    "reindex operation-name encoding",
  );
  exact(
    oracle.reindexAuthority.replacementNameDerivation,
    "message_fts_replacement_ plus the first 16 lowercase hexadecimal characters of SHA-256(operationName UTF-8 bytes)",
    "reindex replacement derivation",
  );
  exact(
    oracle.reindexAuthority.replacementObjectFamily,
    [
      "<replacement>",
      "<replacement>_data",
      "<replacement>_idx",
      "<replacement>_docsize",
      "<replacement>_config",
    ],
    "reindex replacement object family",
  );
  for (const key of [
    "replacementObjectTupleDerivation",
    "leaseRelation",
    "progressRelation",
    "counterRelation",
  ]) {
    nonempty(oracle.reindexAuthority[key], "reindex authority " + key);
  }
  exact(
    oracle.reindexAuthority.buildingEmptyVariants,
    ["O-REINDEX-BUILDING-EMPTY-ABSENT", "O-REINDEX-BUILDING-EMPTY-PRESENT"],
    "reindex building-empty variants",
  );
  exact(
    oracle.reindexAuthority.nondefaultFixtureOperationName,
    "Ops.reindex:tenant-7",
    "reindex nondefault operation",
  );
  exact(
    oracle.reindexAuthority.nondefaultFixtureReplacementName,
    "message_fts_replacement_" + sha256(Buffer.from("Ops.reindex:tenant-7", "utf8")).slice(0, 16),
    "reindex nondefault replacement",
  );
  exact(
    oracle.reindexAuthority.nondefaultFixtureObjectTupleSha256,
    "2e83e220d94e2698939d1185b24007e1dd586f4db013cb378ccf5d79085bcbfe",
    "reindex nondefault object tuple digest",
  );
  exact(oracle.reindexAuthority.forgedCases.length, 12, "reindex forged-case count");
  for (const value of oracle.reindexAuthority.forgedCases) nonempty(value, "reindex forged case");

  for (const [section, keys] of [
    [
      oracle.runtimeAuthority,
      [
        "singleRegistry",
        "packageBoundary",
        "derivedConstants",
        "conversionBackupCapability",
        "repeatedOpen",
        "newerVersion",
        "partialFailure",
        "metadata",
      ],
    ],
    [
      oracle.operationsAuthority,
      ["doctor", "backup", "emptyRootRestore", "fullRestore", "restoreAuthority"],
    ],
  ]) {
    for (const key of keys) nonempty(section[key], "authority " + key);
  }
  exact(oracle.conversionMetadata.table, "schema_migration_conversions", "conversion table");
  exact(oracle.conversionMetadata.layoutVersion, 1, "conversion metadata layout");
  exact(
    oracle.conversionMetadata.columns,
    [
      "conversion_id TEXT PRIMARY KEY NOT NULL",
      "source_user_version INTEGER NOT NULL",
      "source_history_json TEXT NOT NULL",
      "source_history_sha256 TEXT NOT NULL",
      "source_overlay_id TEXT NOT NULL",
      "source_overlay_json TEXT NOT NULL",
      "source_overlay_sha256 TEXT NOT NULL",
      "source_schema_json TEXT NOT NULL",
      "source_schema_sha256 TEXT NOT NULL",
      "target_registry_sha256 TEXT NOT NULL",
      "backup_id TEXT NOT NULL",
      "backup_manifest_sha256 TEXT NOT NULL",
      "completed_at TEXT NOT NULL",
      "record_sha256 TEXT NOT NULL",
    ],
    "conversion metadata columns",
  );
  exact(
    oracle.conversionMetadata.targetRegistrySha256,
    registryIdentityDigest,
    "conversion target registry digest",
  );
  for (const key of [
    "historyEncoding",
    "overlayEncoding",
    "schemaEncoding",
    "digestEncoding",
    "timestampDomain",
    "backupIdentityDomain",
    "recordEncoding",
    "conversionId",
    "recordSha256",
    "decoderAuthority",
    "historyDomain",
    "schemaDomain",
    "overlayDomain",
    "crossFieldRelations",
    "targetRegistrySha256Semantics",
    "insertionGate",
    "immutability",
  ]) {
    nonempty(oracle.conversionMetadata[key], "conversion metadata " + key);
  }
  exact(
    oracle.conversionMetadata.insertionGateMechanism,
    "transactional always-deny trigger replacement",
    "conversion insertion gate mechanism",
  );
  exact(oracle.conversionMetadata.forgedCases.length, 5, "conversion forged-case count");
  for (const value of oracle.conversionMetadata.forgedCases) {
    nonempty(value, "conversion forged case");
  }
  const conversionDdl = oracle.conversionMetadata.ddl;
  for (const [sqlKey, hashKey] of [
    ["tableSql", "tableSha256"],
    ["indexSql", "indexSha256"],
    ["insertGateTriggerSql", "insertGateTriggerSha256"],
    ["updateTriggerSql", "updateTriggerSha256"],
    ["deleteTriggerSql", "deleteTriggerSha256"],
  ]) {
    nonempty(conversionDdl[sqlKey], "conversion DDL " + sqlKey);
    exact(
      conversionDdl[hashKey],
      sha256(Buffer.from(conversionDdl[sqlKey], "utf8")),
      "conversion DDL hash " + sqlKey,
    );
  }
  exact(
    conversionDdl.bundleSha256,
    sha256(
      Buffer.from(
        JSON.stringify([
          conversionDdl.tableSql,
          conversionDdl.indexSql,
          conversionDdl.insertGateTriggerSql,
          conversionDdl.updateTriggerSql,
          conversionDdl.deleteTriggerSql,
        ]),
        "utf8",
      ),
    ),
    "conversion DDL bundle hash",
  );
  for (const key of [
    "sourceAccess",
    "sourceTreeSnapshotEncoding",
    "scratchSnapshot",
    "sequenceSchemaDerivation",
    "baseSchemaTupleDomain",
    "infrastructureExclusionGate",
    "rejectionOrder",
    "backupThenLock",
    "lockedRevalidation",
    "writeSequence",
    "probeContract",
  ]) {
    nonempty(oracle.preflightAuthority[key], "preflight authority " + key);
  }
  exact(
    oracle.preflightAuthority.allowedPragmas,
    ["PRAGMA query_only = ON", "PRAGMA foreign_keys = ON", "PRAGMA trusted_schema = OFF"],
    "preflight allowed pragmas",
  );
  exact(oracle.preflightAuthority.classificationReads.length, 7, "preflight classification reads");
  exact(oracle.preflightAuthority.schemaMutationCases.length, 8, "preflight schema mutations");
  for (const value of oracle.preflightAuthority.schemaMutationCases) {
    nonempty(value, "preflight schema mutation");
  }
  exact(
    oracle.preflightAuthority.forbiddenBeforeSupportedClassification.length,
    5,
    "preflight forbidden effects",
  );
  if (
    !Array.isArray(oracle.runtimeAuthority.openOrder) ||
    oracle.runtimeAuthority.openOrder.length !== 12
  ) {
    fail("runtime open order must have twelve steps");
  }
  const fixtureCompatibility = oracle.runtimeAuthority.legacyFixtureCompatibility;
  for (const key of [
    "entryPoint",
    "registrationApi",
    "stateAuthority",
    "fingerprintEncoding",
    "fingerprintRule",
    "appendRule",
    "strictnessRule",
    "packageBoundary",
    "moduleBoundaryRule",
    "broadSuiteCommand",
    "issue234ProofContract",
  ]) {
    nonempty(fixtureCompatibility[key], "legacy fixture compatibility " + key);
  }
  exact(
    fixtureCompatibility.adapterOrder,
    [
      "resolve the exact Database object and ignore no caller-supplied migration fact",
      "if the object has a recorded verified canonical application fingerprint, recompute the complete authority fingerprint",
      "return without writes only when the fingerprint is byte-identical",
      "if a recorded object drifted, reject with a stable migration mismatch before fixture SQL",
      "if the object is unrecorded, delegate unchanged to applyMigrations for a standalone fixture sequence",
    ],
    "legacy fixture adapter order",
  );
  exact(fixtureCompatibility.releaseProbeVersions, [27, 28, 29], "fixture release probes");
  exact(
    fixtureCompatibility.packageNamedExportAllowlist,
    [
      "ApplyMigrationsOptions",
      "BeforePendingMigration",
      "Migration",
      "MigrationRunnerError",
      "MigrationRunnerErrorCode",
      "applyMigrations",
      "migrationContentHash",
      "runMigrations",
    ],
    "fixture package named export allowlist",
  );
  exact(
    fixtureCompatibility.implementationMode,
    "--implementation-compatibility-check",
    "fixture compatibility implementation mode",
  );
  exact(
    fixtureCompatibility.implementationMutationIds,
    [
      "legacy-fixture-literal-tip",
      "legacy-fixture-caller-ceiling",
      "legacy-fixture-fingerprint-bypass",
      "legacy-fixture-constant-fingerprint",
      "legacy-fixture-count-only-schema",
      "legacy-fixture-failure-stores-expected-fingerprint",
      "legacy-fixture-verify-after-set",
      "strict-runner-compatibility-bypass",
      "migration-runner-export-star-double",
      "migration-runner-export-star-single",
      "migration-runner-export-star-extension",
      "migration-runner-named-export-missing",
    ],
    "fixture compatibility implementation mutations",
  );
  exact(fixtureCompatibility.negativeCases.length, 29, "fixture compatibility negative cases");
  for (const value of fixtureCompatibility.negativeCases) {
    nonempty(value, "fixture compatibility negative case");
  }
  const lifecycle = uniqueRows(oracle.lifecycleCases, "id", "lifecycle cases");
  exactSet(
    lifecycle.keys(),
    [
      "LC-FRESH",
      "LC-CREATE-EMPTY-FILE",
      "LC-CANONICAL-UPGRADE",
      "LC-LEGACY-UPGRADE",
      "LC-PREFLIGHT-REJECT",
      "LC-REOPEN",
      "LC-LEGACY-FIXTURE-COMPATIBILITY",
      "LC-ORDINARY-FAILURE",
      "LC-CONVERSION-FAILURE",
      "LC-NEWER",
      "LC-REINDEX-OVERLAY",
      "LC-PROVENANCE",
      "LC-UNKNOWN",
      "LC-DOCTOR",
      "LC-BACKUP-RESTORE",
      "LC-FULL-RESTORE",
    ],
    "lifecycle IDs",
  );
  for (const row of oracle.lifecycleCases) {
    for (const key of ["input", "expected", "writes"]) nonempty(row[key], row.id + " " + key);
  }

  const retirement = uniqueRows(oracle.retirement, "id", "retirement rows");
  exact(retirement.size, 10, "retirement count");
  const requirements = uniqueRows(oracle.requirements, "id", "requirements");
  const decisions = uniqueRows(oracle.decisions, "id", "decisions");
  const proofs = uniqueRows(oracle.proofs, "id", "proofs");
  exact(requirements.size, 15, "requirement count");
  exact(decisions.size, 15, "decision count");
  exact(proofs.size, 14, "proof count");
  exactSet(Object.keys(oracle.coverage), requirements.keys(), "coverage requirement IDs");
  for (const [requirement, references] of Object.entries(oracle.coverage)) {
    if (!Array.isArray(references) || references.length < 2) fail("thin coverage: " + requirement);
    for (const reference of references) {
      if (!decisions.has(reference) && !proofs.has(reference))
        fail("unknown coverage reference: " + reference);
    }
  }
  const shields = uniqueRows(oracle.shields, "id", "planning shields");
  exactSet(
    shields.keys(),
    Array.from({ length: 12 }, (_, index) => "S" + String(index + 1).padStart(2, "0")),
    "shield IDs",
  );
  for (const row of oracle.shields) {
    exact(row.applicability, "required", "shield applicability " + row.id);
    nonempty(row.proof, "shield proof " + row.id);
  }

  exactSet(
    oracle.issue234.productionPaths,
    [
      "packages/storage/src/migration-registry.ts",
      "packages/storage/src/migration-history-conversion.ts",
      "packages/storage/src/migrations/initial-backfill-completion.ts",
      "packages/storage/src/database.ts",
      "packages/storage/src/migration-runner.ts",
      "packages/storage/src/doctor-integrity.ts",
      "packages/storage/src/backup-writer.ts",
      "packages/storage/src/backup-restore.ts",
      "packages/storage/src/offline-root-replacement.ts",
      "packages/storage/src/thread-migration.ts",
      "packages/storage/src/search-reindex.ts",
      "packages/storage/src/index.ts",
      "packages/daemon/src/backup-service.ts",
      "packages/daemon/src/doctor-service.ts",
      "packages/daemon/src/initial-backfill-loop.ts",
    ],
    "issue 234 production scope",
  );
  const obligations = uniqueRows(oracle.issue234.obligations, "id", "issue 234 obligations");
  exact(obligations.size, 10, "issue 234 obligation count");
  exact(
    oracle.issue234.compositionCorpus,
    {
      acceptedHead: ACCEPTED_HEAD,
      selection: "git grep -l -F applyMigrations( <acceptedHead> -- *.ts",
      files: 62,
      calls: 94,
      sha256: "e35638caca271c94c87421d10f12f204b8a3ae38daee54e928323943cfaafa70",
      implementationRule:
        "Every tracked TypeScript execution root selected at acceptedHead, including both capacity scripts, is in issue 234 mutation and retirement scope even when it is not repeated in testPaths; the checker freezes the exact selected path-and-file-hash set.",
    },
    "issue 234 composition corpus",
  );
  exact(
    oracle.issue234.executionRootPaths,
    oracle.baseline.executionRootScriptPaths,
    "issue 234 execution roots",
  );
  const currentTree = oracle.issue234.currentTreeAuthority;
  exact(currentTree.mode, "--implementation-check", "implementation-check mode");
  exact(currentTree.scopeMode, "--implementation-scope-check", "implementation-scope-check mode");
  for (const key of [
    "enumeration",
    "allowedMutationPaths",
    "scopeModeRule",
    "semanticByteValidation",
    "unknownPathRule",
    "registryImport",
    "converterImport",
    "directSqlDetection",
    "mutationExitRule",
  ]) {
    nonempty(currentTree[key], "current-tree authority " + key);
  }
  const productionClassification = currentTree.productionSourceClassification;
  exact(
    productionClassification.productionSourcePattern,
    "^packages/[^/]+/src/(?:[^/]+/)*[^/]+\\.ts$",
    "production source pattern",
  );
  exact(
    productionClassification.nonProductionRoleTokenPattern,
    "(?:^|[./_-])(?:test|tests|spec|specs|fixture|fixtures|support)(?=$|[./_-])",
    "non-production role token pattern",
  );
  nonempty(productionClassification.rule, "production source classification rule");
  exact(
    productionClassification.acceptedAdjacentInventory,
    {
      acceptedHead: ACCEPTED_HEAD,
      selection:
        "tracked packages/**/src/**/*.ts paths whose src-relative path contains a complete non-production role token",
      paths: [
        "packages/cli/src/action-plan-command.test.ts",
        "packages/cli/src/backup-command.test.ts",
        "packages/cli/src/client.test.ts",
        "packages/cli/src/command-outcome.test.ts",
        "packages/cli/src/doctor-command.test.ts",
        "packages/cli/src/message-show.test.ts",
        "packages/cli/src/raw-content-command.test.ts",
        "packages/cli/src/reindex-command.test.ts",
        "packages/cli/src/restore-command.test.ts",
        "packages/cli/src/routing-commands.test.ts",
        "packages/cli/src/search-command.test.ts",
        "packages/cli/src/selected-export-command.test.ts",
        "packages/cli/src/selected-export.fixtures.ts",
        "packages/cli/src/status-command.test.ts",
        "packages/cli/src/sync-control-fixtures.ts",
        "packages/cli/src/sync-control.test.ts",
        "packages/cli/src/thread-show-command.test.ts",
        "packages/cli/src/thread-show.fixtures.ts",
      ],
      forms: [
        { form: ".test.ts", count: 15 },
        { form: ".fixtures.ts", count: 2 },
        { form: "-fixtures.ts", count: 1 },
      ],
      count: 18,
      sha256: "696c885ded011c2ffdfe45b0e756c92923a3f1fb50b829e75b881b96f44233b1",
    },
    "accepted adjacent source inventory",
  );
  exact(
    productionClassification.positiveFixture,
    {
      path: "packages/cli/src/selected-export-command.test.ts",
      acceptedSha256: "5a08ed01cf2b9b837ed045eb261d66f9ba9df08e7ccb1f09a31bd7f04654e0ae",
      ddlStatements: 12,
      classification: "non-production-test-fixture",
    },
    "positive production classification fixture",
  );
  exactSet(
    currentTree.protectedPaths,
    [
      "AGENTS.md",
      "PLAN.md",
      "docs/planning/EVIDENCE.md",
      "METRICS.md",
      "docs/architecture/report-creation-check.v1.mjs",
      "docs/architecture/report-creation-coverage.v1.md",
      "docs/architecture/report-creation-decisions.v1.md",
      "docs/architecture/report-creation-design.v1.md",
      "docs/architecture/report-creation-oracle.v1.json",
    ],
    "implementation protected paths",
  );
  exactSet(
    currentTree.protectedPrefixes,
    ["packages/contracts/", ".agents/skills/plan-agent-mail/", ".github/"],
    "implementation protected prefixes",
  );
  exact(
    currentTree.postImplementationApplyMigrationPaths,
    [
      "packages/storage/src/migration-runner.ts",
      "packages/storage/src/database.ts",
      "packages/storage/test/helpers/legacy-migration-history-fixtures.ts",
      "packages/storage/test/migration-runner.test.ts",
      "packages/storage/test/migration-registry.test.ts",
      "packages/storage/test/migration-history-conversion.test.ts",
    ],
    "post-implementation applyMigrations paths",
  );
  exact(
    currentTree.directSqlAllowedPaths,
    [
      "packages/storage/src/migration-registry.ts",
      "packages/storage/src/migration-runner.ts",
      "packages/storage/src/migration-history-conversion.ts",
      "packages/storage/test/helpers/legacy-migration-history-fixtures.ts",
    ],
    "post-implementation direct SQL paths",
  );
  exact(
    currentTree.sourceMutationIds,
    [
      "remove-semantic-source",
      "duplicate-semantic-source",
      "change-semantic-sql",
      "new-durable-ddl",
      "new-direct-semantic-sql",
      "new-apply-migrations-bypass",
      "protected-deletion",
      "unknown-deletion",
      "rename-endpoints",
      "third-migration-direct-sql",
      "registry-index-direct-sql",
      "alias-direct-sql",
      "slot20-sql-constant-alias",
      "registry-bracket-destructure",
      "registry-at-destructure",
      "registry-find-destructure",
      "unknown-source",
      "unknown-test",
      "converter-live-tip-loop",
      "legacy-opener-skips-suffix-runner",
      "legacy-fixture-literal-tip",
      "legacy-fixture-caller-ceiling",
      "legacy-fixture-fingerprint-bypass",
      "legacy-fixture-constant-fingerprint",
      "legacy-fixture-count-only-schema",
      "legacy-fixture-failure-stores-expected-fingerprint",
      "legacy-fixture-verify-after-set",
      "strict-runner-compatibility-bypass",
      "migration-runner-export-star-double",
      "migration-runner-export-star-single",
      "migration-runner-export-star-extension",
      "migration-runner-named-export-missing",
    ],
    "source mutation IDs",
  );
  exact(
    oracle.issue234.semanticSourceScope,
    {
      pathsFrom: "canonicalRegistry.migrations[].source",
      count: 27,
      allowedChanges:
        "Only remove obsolete aggregate/lazy-schema exports, wrap SEARCH_REINDEX_SCHEMA_SQL as canonical slot 20 without changing its bytes, or relocate initial-backfill-completion into its registrySource; every other accepted name, SQL byte, execution mode, declared version, checksum, and canonical slot remains frozen.",
    },
    "issue 234 semantic source scope",
  );
  exact(currentTree.allowedMutationPathCount, 111, "implementation allowed path count authority");
  exactSet(
    currentTree.semanticAllowedPaths,
    oracle.canonicalRegistry.migrations.map((row) => row.source),
    "implementation semantic allowed paths",
  );
  const allowedImplementationPaths = implementationAllowedPaths(oracle);
  exact(
    allowedImplementationPaths.size,
    currentTree.allowedMutationPathCount,
    "implementation allowed path count",
  );
  exactSet(
    allowedImplementationPaths,
    expectedImplementationAllowedPaths(oracle),
    "implementation allowed path set",
  );
  exact(
    allowedImplementationPaths.has(productionClassification.positiveFixture.path),
    false,
    "positive fixture absent from implementation allowlist",
  );
  exact(
    canonicalDdlAllowedPaths(oracle).has(productionClassification.positiveFixture.path),
    false,
    "positive fixture absent from canonical DDL allowlist",
  );
  exact(
    currentTree.directSqlAllowedPaths.includes(productionClassification.positiveFixture.path),
    false,
    "positive fixture absent from direct SQL allowlist",
  );
  exactSet(
    oracle.issue234.testPaths,
    [
      "packages/storage/test/helpers/legacy-migration-history-fixtures.ts",
      "packages/storage/test/migration-registry.test.ts",
      "packages/storage/test/migration-history-conversion.test.ts",
      "packages/storage/test/database-preflight.test.ts",
      "packages/storage/test/migration-conversion-provenance.test.ts",
      "packages/storage/test/search-reindex-p7-c03.test.ts",
      "packages/storage/test/migration-runner.test.ts",
      "packages/storage/test/database.test.ts",
      "packages/storage/test/doctor-integrity-p7-c01.test.ts",
      "packages/storage/test/backup-writer-p2-c17.test.ts",
      "packages/storage/test/backup-restore-p2-c18.test.ts",
      "packages/storage/test/backup-restore-parity-p2-c19.test.ts",
      "packages/storage/test/offline-root-replacement-p7-c05.test.ts",
      "packages/daemon/test/backup-service-p7-c04.test.ts",
      "packages/daemon/test/doctor-service-p7-c02.test.ts",
    ],
    "issue 234 test scope",
  );
  for (const path of oracle.issue234.testPaths) {
    nonempty(path, "issue 234 test path");
    if (
      checkGit &&
      !path.startsWith("packages/storage/test/helpers/legacy-") &&
      !path.endsWith("migration-registry.test.ts") &&
      !path.endsWith("migration-history-conversion.test.ts") &&
      !path.endsWith("database-preflight.test.ts") &&
      !path.endsWith("migration-conversion-provenance.test.ts")
    ) {
      readCommitted(path);
    }
  }
  if (oracle.issue234.productionPaths.some((path) => path.includes("report"))) {
    fail("issue 234 production scope absorbed report creation");
  }
  exact(oracle.blockers, [], "blockers");
  validateFrozenInputs(oracle, checkGit);
  return { byId, evidencePaths };
}

async function sourceProjection(oracle) {
  const runner = await import(
    pathToFileURL(join(repositoryRoot, "packages/storage/src/migration-runner.ts")).href
  );
  const definitions = [];
  for (const row of oracle.canonicalRegistry.migrations) {
    const registryPath =
      row.registrySource === undefined ? undefined : join(repositoryRoot, row.registrySource);
    const projectionPath =
      registryPath !== undefined && existsSync(registryPath) ? row.registrySource : row.source;
    const module = await import(pathToFileURL(join(repositoryRoot, projectionPath)).href);
    const exported = module[row.export];
    if (exported === undefined) fail("missing migration export: " + row.source + "#" + row.export);
    const definition =
      row.sourceKind === "sql-constant"
        ? {
            version: row.version,
            name: row.name,
            sql: exported,
            requiresForeignKeysOff: row.requiresForeignKeysOff,
          }
        : exported;
    if (row.sourceKind === "sql-constant") {
      exact(typeof exported, "string", "runtime SQL constant " + row.id);
      exact(row.declaredVersion, null, "runtime unrecorded version " + row.id);
    } else {
      exact(definition.version, row.declaredVersion, "runtime declared version " + row.id);
    }
    exact(definition.name, row.name, "runtime name " + row.id);
    exact(
      definition.requiresForeignKeysOff === true,
      row.requiresForeignKeysOff,
      "runtime mode " + row.id,
    );
    exact(
      runner.migrationContentHash(definition),
      row.contentHash,
      "runtime content hash " + row.id,
    );
    definitions.push({ ...definition, version: row.version });
  }
  const semanticIdentityDigest = sha256(
    Buffer.from(
      JSON.stringify(
        definitions.map((definition) => [
          definition.version,
          definition.name,
          runner.migrationContentHash(definition),
          definition.requiresForeignKeysOff === true,
        ]),
      ),
      "utf8",
    ),
  );
  exact(
    semanticIdentityDigest,
    oracle.canonicalRegistry.identityDigest,
    "runtime semantic source identity",
  );
  return {
    definitions,
    applyMigrations: runner.applyMigrations,
    migrationContentHash: runner.migrationContentHash,
    semanticIdentityDigest,
  };
}

function corpusProjection(oracle, evidencePaths) {
  const listed = git(["grep", "-l", "-F", "applyMigrations(", ACCEPTED_HEAD, "--", "*.ts"])
    .trim()
    .split("\n")
    .map((line) => line.slice(ACCEPTED_HEAD.length + 1))
    .sort();
  const calls = grepCommitted("applyMigrations(");
  const rows = listed.map((path) => [path, sha256(readCommitted(path))]);
  exact(
    listed.length,
    oracle.baseline.applyMigrationSourceFiles,
    "accepted migration corpus files",
  );
  exact(calls.length, oracle.baseline.applyMigrationCallSites, "accepted migration corpus calls");
  exact(
    sha256(Buffer.from(JSON.stringify(rows))),
    oracle.baseline.applyMigrationCorpusSha256,
    "accepted migration corpus digest",
  );
  exact(
    grepCommitted("test-action-chain-placeholder").length,
    oracle.baseline.placeholderOccurrences,
    "accepted placeholder scan",
  );
  exact(
    grepCommitted("composeThreadGraphMigrations", { extended: true }).length,
    oracle.baseline.dynamicThreadComposerOccurrences,
    "accepted thread composer scan",
  );
  exact(
    grepCommitted(
      "\\.exec\\((operationalJournalMigration|actionResultReconciliationMigration)\\.sql\\)",
      { extended: true },
    ).length,
    oracle.baseline.directAcceptedSqlBypassOccurrences,
    "accepted direct SQL scan",
  );
  const registryExports = grepCommitted("export const [A-Za-z0-9]+Migrations[[:space:]]*=", {
    extended: true,
  }).filter((line) => !line.includes("packages/storage/src/migration-runner.ts:"));
  exact(
    registryExports.length,
    oracle.baseline.adHocMigrationRegistryExports,
    "accepted ad hoc registry export scan",
  );
  const excluded = new Set([
    "packages/storage/src/migration-runner.ts",
    "packages/storage/test/migration-runner.test.ts",
    ...oracle.baseline.executionRootScriptPaths,
  ]);
  exactSet(
    listed.filter((path) => !excluded.has(path)),
    [...evidencePaths].filter((path) => listed.includes(path)),
    "composition evidence coverage",
  );
  exactSet(
    [...evidencePaths].filter((path) => !listed.includes(path)),
    ["packages/storage/src/routing-preview-consumption-migration.ts"],
    "non-caller composition evidence",
  );
  exactSet(
    listed.filter((path) => oracle.baseline.executionRootScriptPaths.includes(path)),
    oracle.baseline.executionRootScriptPaths,
    "execution-root composition coverage",
  );
  return {
    files: listed.length,
    calls: calls.length,
    digest: sha256(Buffer.from(JSON.stringify(rows))),
  };
}

function schemaSourceProjection(oracle) {
  const listed = git([
    "grep",
    "-l",
    "-E",
    "CREATE (TABLE|VIRTUAL TABLE|INDEX|TRIGGER)|ALTER TABLE|DROP TABLE",
    ACCEPTED_HEAD,
    "--",
    "packages/**/*.ts",
  ])
    .trim()
    .split("\n")
    .map((line) => line.slice(ACCEPTED_HEAD.length + 1))
    .filter(
      (path) =>
        isProductionTypeScriptSource(path, oracle.issue234.currentTreeAuthority) &&
        path !== "packages/storage/src/migration-runner.ts",
    )
    .sort();
  exact(listed.length, oracle.baseline.schemaDefinitionSourceFiles, "schema source files");
  exactSet(
    listed,
    oracle.canonicalRegistry.migrations.map((row) => row.source),
    "schema source closure",
  );
  return { files: listed.length };
}

async function freshSqliteProjection(oracle, runtime) {
  if (process.versions.bun === undefined) fail("real SQLite projection requires Bun");
  const { Database } = await import("bun:sqlite");
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    runtime.applyMigrations(database, runtime.definitions);
    const history = database
      .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
      .all();
    const expected = oracle.canonicalRegistry.migrations.map((row) => ({
      version: row.version,
      name: row.name,
      content_hash: row.contentHash,
    }));
    exact(history, expected, "fresh SQLite history");
    exact(
      database.query("PRAGMA user_version").get()?.user_version,
      27,
      "fresh SQLite user_version",
    );
    exact(
      database.query("PRAGMA integrity_check").get()?.integrity_check,
      "ok",
      "fresh SQLite integrity",
    );
    exact(database.query("PRAGMA foreign_key_check").all(), [], "fresh SQLite foreign keys");
    const objectCount = database
      .query("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get()?.count;
    exact(objectCount, oracle.baseline.freshSchemaObjectCount, "fresh SQLite object count");
    const before = JSON.stringify(history);
    runtime.applyMigrations(database, runtime.definitions);
    const after = JSON.stringify(
      database
        .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
        .all(),
    );
    exact(after, before, "repeated migration application");
    return { userVersion: 27, historyRows: history.length, schemaObjects: objectCount };
  } finally {
    database.close();
  }
}

function compatibilityAuthorityFingerprint(database) {
  const hasConversions = hasSchemaObject(database, "schema_migration_conversions");
  const hasLease = hasSchemaObject(database, "search_reindex_lease");
  const hasProgress = hasSchemaObject(database, "search_reindex_progress");
  return sha256(
    Buffer.from(
      JSON.stringify([
        database.query("PRAGMA user_version").get()?.user_version,
        database
          .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
          .all(),
        database
          .query(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all(),
        hasConversions
          ? database
              .query("SELECT * FROM schema_migration_conversions ORDER BY conversion_id")
              .all()
          : [],
        hasLease
          ? database.query("SELECT * FROM search_reindex_lease ORDER BY lease_id").all()
          : [],
        hasProgress
          ? database
              .query(
                "SELECT * FROM search_reindex_progress ORDER BY replacement_name, source_rowid",
              )
              .all()
          : [],
      ]),
      "utf8",
    ),
  );
}

function baseSchemaOutsideReindexFamily(database) {
  return database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name NOT LIKE 'sqlite_%' " +
        "AND name NOT IN ('schema_migration_conversions', " +
        "'schema_migration_conversions_source_identity', " +
        "'schema_migration_conversions_insert_gate', " +
        "'schema_migration_conversions_no_update', " +
        "'schema_migration_conversions_no_delete') " +
        "AND name NOT LIKE 'message_fts_replacement_%' " +
        "AND tbl_name NOT LIKE 'message_fts_replacement_%' " +
        "ORDER BY type, name, tbl_name, sql",
    )
    .all();
}

function verifyReferenceCompatibilityAuthority(database, registry, oracle, runtime) {
  const version = database.query("PRAGMA user_version").get()?.user_version;
  const history = database
    .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
    .all();
  const expected = registry.map((migration, index) => ({
    version: index + 1,
    name: migration.name,
    content_hash: runtime.migrationContentHash(migration),
  }));
  exact(version, registry.length, "fixture compatibility exact live tip");
  exact(history, expected, "fixture compatibility exact live history");
  const { Database } = requireBunSqlite();
  const reference = new Database(":memory:", { strict: true });
  try {
    runtime.applyMigrations(reference, registry);
    const expectedControlObjects = reference
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
          "WHERE name IN ('search_reindex_lease', 'search_reindex_progress') " +
          "ORDER BY type, name, tbl_name, sql",
      )
      .all();
    classifyReindexProjection(database, expectedControlObjects);
    exact(
      baseSchemaOutsideReindexFamily(database),
      baseSchemaOutsideReindexFamily(reference),
      "fixture compatibility exact current-tip schema",
    );
  } finally {
    reference.close();
  }
  const conversionObjects = conversionDdlRows(database);
  if (conversionObjects.length > 0) {
    const conversionRows = database
      .query("SELECT count(*) AS count FROM schema_migration_conversions")
      .get()?.count;
    const liveRegistryRows = registry.map((migration) => ({
      ...migration,
      contentHash: runtime.migrationContentHash(migration),
    }));
    verifyConversionProjection(database, oracle, conversionRows, runtime, liveRegistryRows);
  }
  return compatibilityAuthorityFingerprint(database);
}

function recordReferenceCompatibility(database, registry, fingerprints, oracle, runtime) {
  const fingerprint = verifyReferenceCompatibilityAuthority(database, registry, oracle, runtime);
  fingerprints.set(database, fingerprint);
}

function runReferenceCompatibility(database, fixtures, fingerprints, registry, oracle, runtime) {
  const recorded = fingerprints.get(database);
  if (recorded === undefined) {
    runtime.applyMigrations(database, fixtures);
    return;
  }
  const verifiedFingerprint = verifyReferenceCompatibilityAuthority(
    database,
    registry,
    oracle,
    runtime,
  );
  if (verifiedFingerprint !== recorded) {
    throw new Error("recorded canonical application migration authority changed");
  }
}

async function legacyFixtureCompatibilityProjection(oracle, runtime) {
  const { Database } = await import("bun:sqlite");
  bunSqliteModule = { Database };
  const fingerprints = new WeakMap();
  const suffixes = oracle.appendStableProvenance.proofSuffixes.map((suffix) => ({
    version: suffix.version,
    name: suffix.name,
    sql: suffix.sql,
    requiresForeignKeysOff: suffix.requiresForeignKeysOff,
  }));
  const registries = [
    runtime.definitions,
    [...runtime.definitions, suffixes[0]],
    [...runtime.definitions, ...suffixes],
  ];
  const fixture = [
    {
      version: 1,
      name: "standalone-legacy-fixture",
      sql: "CREATE TABLE standalone_legacy_fixture (id INTEGER PRIMARY KEY) STRICT",
    },
  ];
  const acceptedTips = [];
  let noOpWrites = 0;
  let sameCardinalitySchemaTupleRejections = 0;
  for (const registry of registries) {
    const database = new Database(":memory:", { strict: true });
    try {
      runtime.applyMigrations(database, registry);
      recordReferenceCompatibility(database, registry, fingerprints, oracle, runtime);
      const before = database.serialize();
      runReferenceCompatibility(database, fixture, fingerprints, registry, oracle, runtime);
      exact(
        Buffer.compare(before, database.serialize()),
        0,
        "fixture compatibility verified no-op at tip " + registry.length,
      );
      noOpWrites += 0;
      acceptedTips.push(registry.length);
      let strictRejected = false;
      try {
        runtime.applyMigrations(database, fixture);
      } catch {
        strictRejected = true;
      }
      exact(strictRejected, true, "strict runner ignores no compatibility authority");
    } finally {
      database.close();
    }
    for (const access of ["direct", "early", "dynamic-equivalent"]) {
      const substituted = new Database(":memory:", { strict: true });
      try {
        runtime.applyMigrations(substituted, registry);
        const original = substituteSameCardinalitySchemaTuple(substituted);
        const beforeRecord = substituted.serialize();
        let rejected = false;
        try {
          recordReferenceCompatibility(substituted, registry, fingerprints, oracle, runtime);
        } catch {
          rejected = true;
        }
        exact(rejected, true, "reference same-cardinality schema rejection " + access);
        exact(
          Buffer.compare(beforeRecord, substituted.serialize()),
          0,
          "reference same-cardinality rejection bytes " + access,
        );
        restoreSameCardinalitySchemaTuple(substituted, original);
        assertCompatibilityCallRejectsWithoutFixture(
          "reference same-cardinality rejection leaves no marker " + access,
          substituted,
          fixture,
          () =>
            runReferenceCompatibility(
              substituted,
              fixture,
              fingerprints,
              registry,
              oracle,
              runtime,
            ),
        );
        sameCardinalitySchemaTupleRejections += 1;
      } finally {
        substituted.close();
      }
    }
  }

  const rejected = [];
  const release29 = registries[2];
  for (const kind of ["pending", "partial", "unknown", "forged", "newer"]) {
    const database = new Database(":memory:", { strict: true });
    try {
      const prefix = kind === "partial" ? release29.slice(0, 3) : release29.slice(0, -1);
      runtime.applyMigrations(database, prefix);
      if (kind === "unknown") {
        database
          .query("UPDATE schema_migrations SET name = 'unknown-history' WHERE version = 2")
          .run();
      } else if (kind === "forged") {
        database
          .query("UPDATE schema_migrations SET content_hash = ? WHERE version = 2")
          .run("0".repeat(64));
      } else if (kind === "newer") {
        database.exec("PRAGMA user_version = 30");
      }
      let didReject = false;
      try {
        recordReferenceCompatibility(database, release29, fingerprints, oracle, runtime);
      } catch {
        didReject = true;
      }
      exact(didReject, true, "fixture compatibility " + kind + " rejection");
      rejected.push(kind);
    } finally {
      database.close();
    }
  }

  for (const kind of ["schema", "provenance", "reindex"]) {
    const database = new Database(":memory:", { strict: true });
    try {
      runtime.applyMigrations(database, runtime.definitions);
      if (kind === "schema") {
        database.exec("CREATE TABLE forged_schema_drift (id INTEGER PRIMARY KEY) STRICT");
      } else if (kind === "provenance") {
        database.exec(
          "CREATE TABLE schema_migration_conversions (conversion_id TEXT PRIMARY KEY, record_sha256 TEXT NOT NULL) STRICT; INSERT INTO schema_migration_conversions VALUES ('conversion:one', '" +
            "a".repeat(64) +
            "')",
        );
      } else {
        database.exec(
          "CREATE TABLE message_fts_replacement_0000000000000000 (id INTEGER PRIMARY KEY) STRICT",
        );
      }
      let didReject = false;
      try {
        recordReferenceCompatibility(database, runtime.definitions, fingerprints, oracle, runtime);
      } catch {
        didReject = true;
      }
      exact(didReject, true, "fixture compatibility " + kind + " authority rejection");
      rejected.push(kind);
    } finally {
      database.close();
    }
  }

  for (const kind of ["schema", "history"]) {
    const database = new Database(":memory:", { strict: true });
    try {
      runtime.applyMigrations(database, runtime.definitions);
      recordReferenceCompatibility(database, runtime.definitions, fingerprints, oracle, runtime);
      if (kind === "schema") {
        database.exec("CREATE TABLE forged_schema_drift (id INTEGER PRIMARY KEY) STRICT");
      } else {
        database.query("UPDATE schema_migrations SET name = 'forged' WHERE version = 1").run();
      }
      let didReject = false;
      try {
        runReferenceCompatibility(
          database,
          fixture,
          fingerprints,
          runtime.definitions,
          oracle,
          runtime,
        );
      } catch {
        didReject = true;
      }
      exact(didReject, true, "fixture compatibility recorded " + kind + " drift rejection");
      rejected.push("recorded-" + kind + "-drift");
    } finally {
      database.close();
    }
  }

  const standalone = new Database(":memory:", { strict: true });
  try {
    runReferenceCompatibility(standalone, fixture, fingerprints, [], oracle, runtime);
    runReferenceCompatibility(standalone, fixture, fingerprints, [], oracle, runtime);
    exact(
      standalone.query("PRAGMA user_version").get()?.user_version,
      1,
      "fresh and repeated standalone fixture",
    );
  } finally {
    standalone.close();
  }
  return {
    acceptedTips,
    verifiedNoOpWrites: noOpWrites,
    rejected,
    sameCardinalitySchemaTupleRejections,
    freshStandaloneVersion: 1,
    strictRunnerUnchanged: true,
  };
}

async function legacySchemaProjection(oracle, runtime) {
  const { Database } = await import("bun:sqlite");
  const definitions = new Map(
    oracle.canonicalRegistry.migrations.map((row, index) => [row.id, runtime.definitions[index]]),
  );
  const prefixes = new Map();
  const convertible = oracle.observedCompositions.filter(
    (row) => row.classification === "convertible-ledger",
  );
  for (const history of convertible) {
    for (let length = 1; length <= history.sequence.length; length += 1) {
      const sequence = history.sequence.slice(0, length);
      const key = sequence.join("\u0000");
      if (!prefixes.has(key)) prefixes.set(key, sequence);
    }
  }
  exact(
    convertible.length,
    oracle.baseline.convertibleCompositionCount,
    "legacy projection histories",
  );
  exact(prefixes.size, oracle.baseline.uniqueConvertiblePrefixCount, "legacy projection prefixes");

  for (const sequence of prefixes.values()) {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    try {
      runtime.applyMigrations(
        database,
        sequence.map((id, index) => ({ ...definitions.get(id), version: index + 1 })),
      );
      const installed = new Set(sequence);
      database.exec("PRAGMA foreign_keys = OFF;");
      database.exec("BEGIN IMMEDIATE;");
      try {
        for (const row of oracle.canonicalRegistry.migrations) {
          if (!installed.has(row.id)) database.exec(definitions.get(row.id).sql);
        }
        exact(
          database.query("PRAGMA foreign_key_check").all(),
          [],
          "legacy projection foreign keys",
        );
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      } finally {
        database.exec("PRAGMA foreign_keys = ON;");
      }
      exact(
        database.query("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
        "legacy projection integrity",
      );
      exact(
        database.query("PRAGMA foreign_key_check").all(),
        [],
        "legacy projection final foreign keys",
      );
      exact(
        database
          .query(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
          )
          .get()?.count,
        oracle.baseline.freshSchemaObjectCount - 1,
        "legacy projection application schema",
      );
    } finally {
      database.close();
    }
  }
  return { histories: convertible.length, uniquePrefixes: prefixes.size, passed: prefixes.size };
}

function hasSchemaObject(database, name) {
  return database.query("SELECT 1 AS present FROM sqlite_schema WHERE name = ?").get(name) !== null;
}

function reindexOverlaySnapshot(database) {
  const hasLease = hasSchemaObject(database, "search_reindex_lease");
  const hasProgress = hasSchemaObject(database, "search_reindex_progress");
  const lease = hasLease
    ? database
        .query(
          "SELECT lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows FROM search_reindex_lease ORDER BY lease_id",
        )
        .all()
    : [];
  const progress = hasProgress
    ? database
        .query(
          "SELECT replacement_name, source_rowid, source_digest FROM search_reindex_progress ORDER BY replacement_name, source_rowid",
        )
        .all()
    : [];
  const objects = database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name IN ('search_reindex_lease', 'search_reindex_progress') " +
        "OR name LIKE 'message_fts_replacement_%' OR tbl_name LIKE 'message_fts_replacement_%' " +
        "ORDER BY type, name, tbl_name, sql",
    )
    .all();
  const replacementName = lease[0]?.replacement_name;
  let sourceRows = [];
  let replacementDocsizeRowids = [];
  if (typeof replacementName === "string" && hasSchemaObject(database, "indexed_messages")) {
    sourceRows = database
      .query(
        "SELECT rowid, message_id, subject, participants, body_plain, body_html, attachment_names " +
          "FROM indexed_messages ORDER BY rowid",
      )
      .all();
  }
  if (typeof replacementName === "string" && hasSchemaObject(database, replacementName)) {
    if (!/^message_fts_replacement_[0-9a-f]{16}$/.test(replacementName)) {
      fail("invalid projected replacement name");
    }
    replacementDocsizeRowids = database
      .query(`SELECT id FROM "${replacementName}_docsize" ORDER BY id`)
      .all()
      .map((row) => row.id);
  }
  return {
    hasLease,
    hasProgress,
    lease,
    progress,
    objects,
    sourceRows,
    replacementDocsizeRowids,
  };
}

function replacementNameFor(operationName) {
  return "message_fts_replacement_" + sha256(Buffer.from(operationName, "utf8")).slice(0, 16);
}

function createReplacementIndex(database, replacementName) {
  if (!/^message_fts_replacement_[0-9a-f]{16}$/u.test(replacementName)) {
    fail("refusing unsafe projected replacement identifier");
  }
  database.exec(
    `CREATE VIRTUAL TABLE "${replacementName}" USING fts5(` +
      "subject, participants, body_plain, body_html, attachment_names, " +
      "content='indexed_messages', content_rowid='rowid', " +
      "tokenize='unicode61 remove_diacritics 2'" +
      ")",
  );
}

function createOrdinaryReplacementLookalikes(database, replacementName) {
  database.exec(
    `CREATE TABLE "${replacementName}" (` +
      "rowid INTEGER PRIMARY KEY, subject TEXT, participants TEXT, body_plain TEXT, " +
      "body_html TEXT, attachment_names TEXT)",
  );
  for (const suffix of ["_data", "_idx", "_docsize", "_config"]) {
    database.exec(`CREATE TABLE "${replacementName}${suffix}" (id INTEGER PRIMARY KEY)`);
  }
}

function createAlteredReplacementIndex(database, replacementName) {
  database.exec(
    `CREATE VIRTUAL TABLE "${replacementName}" USING fts5(` +
      "subject, participants, body_plain, body_html, attachment_names, " +
      "content='indexed_messages', content_rowid='rowid', tokenize='porter')",
  );
}

const replacementObjectTupleCache = new Map();
function expectedReplacementObjectRows(replacementName) {
  if (replacementObjectTupleCache.has(replacementName)) {
    return replacementObjectTupleCache.get(replacementName);
  }
  const { Database } = requireBunSqlite();
  const reference = new Database(":memory:", { strict: true });
  try {
    createReplacementIndex(reference, replacementName);
    const rows = reference
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
          "WHERE name = ? OR name LIKE ? ORDER BY type, name, tbl_name, sql",
      )
      .all(replacementName, replacementName + "_%");
    replacementObjectTupleCache.set(replacementName, rows);
    return rows;
  } finally {
    reference.close();
  }
}

function projectedSourceRows(database) {
  return database
    .query(
      "SELECT rowid, message_id, subject, participants, body_plain, body_html, attachment_names " +
        "FROM indexed_messages ORDER BY rowid",
    )
    .all()
    .map((row) => ({
      rowid: row.rowid,
      digest: sha256(
        Buffer.from(
          JSON.stringify([
            row.rowid,
            row.message_id,
            row.subject,
            row.participants,
            row.body_plain,
            row.body_html,
            row.attachment_names,
          ]),
          "utf8",
        ),
      ),
    }));
}

function classifyReindexProjection(database, expectedControlObjects) {
  const control = database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name IN ('search_reindex_lease', 'search_reindex_progress') " +
        "ORDER BY type, name, tbl_name, sql",
    )
    .all();
  const replacementObjects = database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name LIKE 'message_fts_replacement_%' " +
        "OR tbl_name LIKE 'message_fts_replacement_%' ORDER BY type, name, tbl_name, sql",
    )
    .all();
  if (control.length === 0) {
    if (replacementObjects.length !== 0) throw new Error("orphan replacement objects");
    return "absent";
  }
  if (control.length === 1) {
    exact(control, expectedControlObjects.slice(0, 1), "partial reindex control schema");
    const leaseCount = database
      .query("SELECT count(*) AS count FROM search_reindex_lease")
      .get()?.count;
    if (leaseCount !== 0 || replacementObjects.length !== 0)
      throw new Error("invalid partial overlay");
    return "partial-empty";
  }
  exact(control, expectedControlObjects, "reindex control schema");
  const leases = database
    .query(
      "SELECT lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows " +
        "FROM search_reindex_lease ORDER BY lease_id",
    )
    .all();
  const progress = database
    .query(
      "SELECT replacement_name, source_rowid, source_digest FROM search_reindex_progress " +
        "ORDER BY replacement_name, source_rowid",
    )
    .all();
  if (leases.length === 0) {
    if (progress.length !== 0 || replacementObjects.length !== 0) {
      throw new Error("idle overlay has orphan state");
    }
    return "idle";
  }
  if (leases.length !== 1) throw new Error("multiple leases");
  const lease = leases[0];
  if (
    lease.lease_id !== 1 ||
    typeof lease.operation_name !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(lease.operation_name) ||
    lease.replacement_name !== replacementNameFor(lease.operation_name) ||
    !new Set(["building", "activating"]).has(lease.phase) ||
    !Number.isSafeInteger(lease.last_rowid) ||
    lease.last_rowid < 0 ||
    !Number.isSafeInteger(lease.processed_rows) ||
    lease.processed_rows < 0 ||
    new Set(["message_fts", "message_fts_previous"]).has(lease.replacement_name)
  ) {
    throw new Error("invalid reindex lease");
  }
  const replacementName = lease.replacement_name;
  const hasFamily = replacementObjects.length > 0;
  if (hasFamily) {
    exact(
      replacementObjects,
      expectedReplacementObjectRows(replacementName),
      "reindex replacement object tuples",
    );
  }
  if (lease.last_rowid === 0 && lease.processed_rows === 0 && progress.length === 0) {
    if (lease.phase !== "building") throw new Error("empty activating overlay");
    if (hasFamily) {
      const count = database
        .query(`SELECT count(*) AS count FROM "${replacementName}_docsize"`)
        .get()?.count;
      if (count !== 0) throw new Error("building-empty replacement is not empty");
      return "building-empty-present";
    }
    return "building-empty-absent";
  }
  if (!hasFamily) throw new Error("nonempty overlay has no replacement family");
  if (
    progress.some(
      (row) =>
        row.replacement_name !== replacementName ||
        !Number.isSafeInteger(row.source_rowid) ||
        row.source_rowid <= 0 ||
        typeof row.source_digest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(row.source_digest),
    )
  ) {
    throw new Error("invalid reindex progress row");
  }
  const replacementIds = database
    .query(`SELECT id FROM "${replacementName}_docsize" ORDER BY id`)
    .all()
    .map((row) => row.id);
  const sourceRows = projectedSourceRows(database);
  const sourceById = new Map(sourceRows.map((row) => [row.rowid, row.digest]));
  exact(
    progress.map((row) => row.source_rowid),
    replacementIds,
    "reindex progress/replacement identities",
  );
  for (const row of progress) {
    if (sourceById.get(row.source_rowid) !== row.source_digest) {
      throw new Error("reindex progress digest mismatch");
    }
  }
  if (
    lease.processed_rows !== progress.length ||
    lease.last_rowid !== progress.at(-1)?.source_rowid
  ) {
    throw new Error("reindex counters mismatch");
  }
  if (lease.phase === "activating") {
    if (
      progress.length !== sourceRows.length ||
      lease.last_rowid !== (sourceRows.at(-1)?.rowid ?? 0)
    ) {
      throw new Error("activating replacement is incomplete");
    }
    return "activating";
  }
  return "building";
}

function seedReindexProjection(database) {
  const firstMessage = `message:${"a".repeat(64)}`;
  const secondMessage = `message:${"b".repeat(64)}`;
  database
    .query("INSERT INTO messages (message_id) VALUES (?), (?)")
    .run(firstMessage, secondMessage);
  database
    .query("INSERT INTO message_search_documents (document_id, message_id) VALUES (?, ?), (?, ?)")
    .run(10, firstMessage, 20, secondMessage);
  database
    .query(
      "INSERT INTO message_headers " +
        "(message_id, ordinal, name, normalized_name, value, normalized_value) " +
        "VALUES (?, 1, 'Subject', 'subject', ?, ?), (?, 1, 'Subject', 'subject', ?, ?)",
    )
    .run(firstMessage, "old invoice", "old invoice", secondMessage, "new receipt", "new receipt");
  database
    .query(
      "INSERT INTO message_body_parts " +
        "(message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text) " +
        "VALUES (?, 1, 'text/plain', 'text/plain', ?, ?), (?, 1, 'text/plain', 'text/plain', ?, ?)",
    )
    .run(firstMessage, "1".repeat(64), "old body", secondMessage, "2".repeat(64), "new body");
  database.exec(
    "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) " +
      "SELECT rowid, subject, participants, body_plain, body_html, attachment_names " +
      "FROM indexed_messages WHERE rowid = 10",
  );
}

async function reindexOverlayProjection(oracle, runtime) {
  bunSqliteModule = await import("bun:sqlite");
  const { Database } = bunSqliteModule;
  const search = await import(
    pathToFileURL(join(repositoryRoot, "packages/storage/src/search-reindex.ts")).href
  );
  const definitions = new Map(
    oracle.canonicalRegistry.migrations.map((row, index) => [row.id, runtime.definitions[index]]),
  );
  const baseIds = ["message-catalog", "structured-content", "external-content-search"];
  const states = [
    "absent",
    "partial-empty",
    "idle",
    "building-empty-absent",
    "building-empty-present",
    "building",
    "activating",
  ];
  const operationName = oracle.reindexAuthority.nondefaultFixtureOperationName;
  const replacementName = oracle.reindexAuthority.nondefaultFixtureReplacementName;
  exact(replacementName, replacementNameFor(operationName), "projected replacement derivation");
  exact(
    sha256(
      Buffer.from(
        JSON.stringify(
          expectedReplacementObjectRows(replacementName).map((row) => [
            row.type,
            row.name,
            row.tbl_name,
            row.sql,
          ]),
        ),
        "utf8",
      ),
    ),
    oracle.reindexAuthority.nondefaultFixtureObjectTupleSha256,
    "projected replacement tuple digest",
  );
  const reference = new Database(":memory:", { strict: true });
  search.applySearchReindexSchema(reference);
  const expectedControlObjects = reference
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name IN ('search_reindex_lease', 'search_reindex_progress') " +
        "ORDER BY type, name, tbl_name, sql",
    )
    .all();
  reference.close();
  let preserved = 0;
  let converged = 0;

  for (const state of states) {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    try {
      runtime.applyMigrations(
        database,
        baseIds.map((id, index) => ({ ...definitions.get(id), version: index + 1 })),
      );
      seedReindexProjection(database);
      if (state === "partial-empty") {
        const marker = "CREATE TABLE IF NOT EXISTS search_reindex_progress";
        const markerIndex = search.SEARCH_REINDEX_SCHEMA_SQL.indexOf(marker);
        if (markerIndex < 1) fail("cannot derive accepted partial reindex DDL");
        database.exec(search.SEARCH_REINDEX_SCHEMA_SQL.slice(0, markerIndex));
      } else if (state !== "absent") {
        search.applySearchReindexSchema(database);
      }

      if (state === "building-empty-absent" || state === "building-empty-present") {
        database
          .query(
            "INSERT INTO search_reindex_lease " +
              "(lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows) " +
              "VALUES (1, ?, ?, 'building', 0, 0)",
          )
          .run(operationName, replacementName);
        if (state === "building-empty-present") createReplacementIndex(database, replacementName);
      } else if (state === "building" || state === "activating") {
        let interrupted = false;
        try {
          search.rebuildSearchIndex(database, {
            operationName,
            batchSize: 1,
            representativeQueries: [{ query: "new", expectedRowids: [20] }],
            beforeBoundary: (boundary) => {
              if (
                (state === "building" && boundary === "batch-committed") ||
                (state === "activating" && boundary === "activation-before-swap")
              ) {
                throw new Error("projected " + state + " interruption");
              }
            },
          });
        } catch (error) {
          interrupted =
            error instanceof Error &&
            (error.message === "projected " + state + " interruption" ||
              (error.cause instanceof Error &&
                error.cause.message === "projected " + state + " interruption"));
          if (!interrupted) {
            fail(state + " projection failed before boundary: " + String(error));
          }
        }
        exact(interrupted, true, state + " interruption");
      }

      const before = reindexOverlaySnapshot(database);
      exact(
        classifyReindexProjection(database, expectedControlObjects),
        state,
        state + " overlay classification",
      );
      const completeOverlay = !new Set(["absent", "partial-empty"]).has(state);
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of oracle.canonicalRegistry.migrations) {
          if (baseIds.includes(row.id)) continue;
          if (row.id === "search-reindex-schema" && completeOverlay) continue;
          database.exec(definitions.get(row.id).sql);
        }
        exact(
          database.query("PRAGMA foreign_key_check").all(),
          [],
          state + " overlay foreign keys",
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        database.exec("PRAGMA foreign_keys = ON");
      }
      exact(
        database.query("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
        state + " overlay integrity",
      );
      const after = reindexOverlaySnapshot(database);
      if (completeOverlay) {
        exact(after, before, state + " overlay preservation");
        exact(
          classifyReindexProjection(database, expectedControlObjects),
          state,
          state + " overlay post-conversion classification",
        );
        preserved += 1;
      } else {
        exact(after.hasLease, true, state + " lease completion");
        exact(after.hasProgress, true, state + " progress completion");
        exact(after.lease, [], state + " completed lease rows");
        exact(after.progress, [], state + " completed progress rows");
        exact(after.sourceRows, [], state + " completed active source rows");
        exact(after.replacementDocsizeRowids, [], state + " completed replacement identities");
        converged += 1;
      }
    } finally {
      database.close();
    }
  }

  const forged = [
    [
      "invalid-operation",
      (database) => database.exec("UPDATE search_reindex_lease SET operation_name = 'bad name'"),
    ],
    [
      "wrong-replacement",
      (database) =>
        database.exec(
          "UPDATE search_reindex_lease SET replacement_name = 'message_fts_replacement_0000000000000000'",
        ),
    ],
    ["missing-object", (database) => database.exec(`DROP TABLE "${replacementName}"`)],
    [
      "wrong-progress-name",
      (database) =>
        database.exec(
          "UPDATE search_reindex_progress SET replacement_name = 'message_fts_replacement_0000000000000000'",
        ),
    ],
    [
      "digest-mismatch",
      (database) =>
        database.exec(`UPDATE search_reindex_progress SET source_digest = '${"0".repeat(64)}'`),
    ],
    [
      "counter-mismatch",
      (database) =>
        database.exec("UPDATE search_reindex_lease SET processed_rows = processed_rows + 1"),
    ],
    [
      "incomplete-activating",
      (database) => database.exec("UPDATE search_reindex_lease SET phase = 'activating'"),
    ],
    [
      "active-index-target",
      (database) =>
        database.exec("UPDATE search_reindex_lease SET replacement_name = 'message_fts'"),
    ],
  ];
  let rejected = 0;
  for (const [id, mutate] of forged) {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    try {
      runtime.applyMigrations(
        database,
        baseIds.map((migrationId, index) => ({
          ...definitions.get(migrationId),
          version: index + 1,
        })),
      );
      seedReindexProjection(database);
      let interrupted = false;
      try {
        search.rebuildSearchIndex(database, {
          operationName,
          batchSize: 1,
          representativeQueries: [{ query: "new", expectedRowids: [20] }],
          beforeBoundary: (boundary) => {
            if (boundary === "batch-committed") throw new Error("forgery fixture interruption");
          },
        });
      } catch (error) {
        interrupted =
          error instanceof Error &&
          (error.message === "forgery fixture interruption" ||
            (error.cause instanceof Error &&
              error.cause.message === "forgery fixture interruption"));
      }
      exact(interrupted, true, id + " fixture interruption");
      mutate(database);
      let rejectedForgery = false;
      try {
        classifyReindexProjection(database, expectedControlObjects);
      } catch {
        rejectedForgery = true;
      }
      exact(rejectedForgery, true, id + " forged overlay rejection");
      rejected += 1;
    } finally {
      database.close();
    }
  }
  const tupleForgeries = [
    ["building-empty-ordinary-family", "empty", createOrdinaryReplacementLookalikes],
    ["building-empty-altered-family", "empty", createAlteredReplacementIndex],
    ["building-ordinary-family", "nonempty", createOrdinaryReplacementLookalikes],
    ["building-altered-family", "nonempty", createAlteredReplacementIndex],
  ];
  for (const [id, fixtureState, createForgedFamily] of tupleForgeries) {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    try {
      runtime.applyMigrations(
        database,
        baseIds.map((migrationId, index) => ({
          ...definitions.get(migrationId),
          version: index + 1,
        })),
      );
      seedReindexProjection(database);
      search.applySearchReindexSchema(database);
      if (fixtureState === "empty") {
        database
          .query(
            "INSERT INTO search_reindex_lease " +
              "(lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows) " +
              "VALUES (1, ?, ?, 'building', 0, 0)",
          )
          .run(operationName, replacementName);
        createReplacementIndex(database, replacementName);
      } else {
        let interrupted = false;
        try {
          search.rebuildSearchIndex(database, {
            operationName,
            batchSize: 1,
            representativeQueries: [{ query: "new", expectedRowids: [20] }],
            beforeBoundary: (boundary) => {
              if (boundary === "batch-committed") throw new Error("tuple forgery interruption");
            },
          });
        } catch (error) {
          interrupted =
            error instanceof Error &&
            (error.message === "tuple forgery interruption" ||
              (error.cause instanceof Error &&
                error.cause.message === "tuple forgery interruption"));
        }
        exact(interrupted, true, id + " fixture interruption");
      }
      database.exec(`DROP TABLE "${replacementName}"`);
      createForgedFamily(database, replacementName);
      let rejectedForgery = false;
      try {
        classifyReindexProjection(database, expectedControlObjects);
      } catch {
        rejectedForgery = true;
      }
      exact(rejectedForgery, true, id + " forged tuple rejection");
      rejected += 1;
    } finally {
      database.close();
    }
  }
  return { states: states.length, preserved, converged, forgedRejected: rejected };
}

function conversionColumnNames(oracle) {
  return oracle.conversionMetadata.columns.map((column) => column.slice(0, column.indexOf(" ")));
}

function installConversionInfrastructure(database, oracle) {
  const ddl = oracle.conversionMetadata.ddl;
  database.exec(ddl.tableSql);
  database.exec(ddl.indexSql);
  database.exec(ddl.insertGateTriggerSql);
  database.exec(ddl.updateTriggerSql);
  database.exec(ddl.deleteTriggerSql);
}

function conversionDdlRows(database) {
  return database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name IN ('schema_migration_conversions', " +
        "'schema_migration_conversions_source_identity', " +
        "'schema_migration_conversions_insert_gate', " +
        "'schema_migration_conversions_no_update', " +
        "'schema_migration_conversions_no_delete') ORDER BY type, name",
    )
    .all();
}

function expectedConversionDdlRows(oracle) {
  const ddl = oracle.conversionMetadata.ddl;
  return [
    {
      type: "index",
      name: "schema_migration_conversions_source_identity",
      tbl_name: "schema_migration_conversions",
      sql: ddl.indexSql,
    },
    {
      type: "table",
      name: "schema_migration_conversions",
      tbl_name: "schema_migration_conversions",
      sql: ddl.tableSql,
    },
    {
      type: "trigger",
      name: "schema_migration_conversions_insert_gate",
      tbl_name: "schema_migration_conversions",
      sql: ddl.insertGateTriggerSql,
    },
    {
      type: "trigger",
      name: "schema_migration_conversions_no_delete",
      tbl_name: "schema_migration_conversions",
      sql: ddl.deleteTriggerSql,
    },
    {
      type: "trigger",
      name: "schema_migration_conversions_no_update",
      tbl_name: "schema_migration_conversions",
      sql: ddl.updateTriggerSql,
    },
  ];
}

const conversionInfrastructureNames = new Set([
  "schema_migration_conversions",
  "schema_migration_conversions_source_identity",
  "schema_migration_conversions_insert_gate",
  "schema_migration_conversions_no_update",
  "schema_migration_conversions_no_delete",
]);
const expectedBaseSchemaCache = new Map();
let expectedReindexControlRowsCache;
let expectedMigrationInfrastructureRowCache;

function explicitSchemaRows(database) {
  return database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name, sql",
    )
    .all();
}

function schemaTupleArrays(rows) {
  return rows.map((row) => [row.type, row.name, row.tbl_name, row.sql]);
}

function expectedReindexControlRows(oracle, runtime) {
  if (expectedReindexControlRowsCache !== undefined) return expectedReindexControlRowsCache;
  const { Database } = requireBunSqlite();
  const reference = new Database(":memory:", { strict: true });
  try {
    const index = oracle.canonicalRegistry.migrations.findIndex(
      (row) => row.id === "search-reindex-schema",
    );
    reference.exec(runtime.definitions[index].sql);
    expectedReindexControlRowsCache = reference
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
          "WHERE name IN ('search_reindex_lease', 'search_reindex_progress') " +
          "ORDER BY type, name, tbl_name, sql",
      )
      .all();
    return expectedReindexControlRowsCache;
  } finally {
    reference.close();
  }
}

function expectedMigrationInfrastructureRow(oracle, runtime) {
  if (expectedMigrationInfrastructureRowCache !== undefined) {
    return expectedMigrationInfrastructureRowCache;
  }
  const { Database } = requireBunSqlite();
  const reference = new Database(":memory:", { strict: true });
  try {
    runtime.applyMigrations(reference, [runtime.definitions[0]]);
    expectedMigrationInfrastructureRowCache = explicitSchemaRows(reference).find(
      (row) => row.name === "schema_migrations",
    );
    if (expectedMigrationInfrastructureRowCache === undefined) {
      throw new Error("runner did not create migration infrastructure");
    }
    return expectedMigrationInfrastructureRowCache;
  } finally {
    reference.close();
  }
}

function supportedSequenceKeys(oracle) {
  const keys = new Set([""]);
  const canonical = oracle.canonicalRegistry.migrations.map((row) => row.id);
  for (let length = 1; length <= canonical.length; length += 1) {
    keys.add(canonical.slice(0, length).join("\0"));
  }
  for (const history of oracle.observedCompositions) {
    if (history.classification !== "convertible-ledger") continue;
    for (let length = 1; length <= history.sequence.length; length += 1) {
      keys.add(history.sequence.slice(0, length).join("\0"));
    }
  }
  return keys;
}

function decodeHistoryTuples(history, sourceUserVersion, oracle) {
  if (!Array.isArray(history)) throw new Error("history is not an array");
  if (!Number.isSafeInteger(sourceUserVersion) || sourceUserVersion < 0) {
    throw new Error("invalid source user_version");
  }
  if (sourceUserVersion !== history.length) throw new Error("history/user_version mismatch");
  const identities = new Map(
    oracle.canonicalRegistry.migrations.map((row) => [row.name + "\0" + row.contentHash, row.id]),
  );
  const ids = [];
  const seen = new Set();
  for (const [index, tuple] of history.entries()) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      tuple[0] !== index + 1 ||
      !Number.isSafeInteger(tuple[0]) ||
      typeof tuple[1] !== "string" ||
      tuple[1].length === 0 ||
      typeof tuple[2] !== "string" ||
      !/^[0-9a-f]{64}$/u.test(tuple[2])
    ) {
      throw new Error("invalid history tuple");
    }
    const id = identities.get(tuple[1] + "\0" + tuple[2]);
    if (id === undefined || seen.has(id)) throw new Error("unknown or duplicate history identity");
    seen.add(id);
    ids.push(id);
  }
  if (!supportedSequenceKeys(oracle).has(ids.join("\0"))) {
    throw new Error("unsupported history sequence");
  }
  return ids;
}

function validatedReindexObjectNames(database, oracle, runtime) {
  classifyReindexProjection(database, expectedReindexControlRows(oracle, runtime));
  return new Set(reindexOverlaySnapshot(database).objects.map((row) => row.name));
}

function baseSchemaRows(database, oracle, runtime) {
  const sourceUserVersion = database.query("PRAGMA user_version").get()?.user_version;
  const hasHistory = hasSchemaObject(database, "schema_migrations");
  const historyRows = hasHistory
    ? database
        .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
        .all()
    : [];
  if (!hasHistory && sourceUserVersion !== 0) throw new Error("missing migration infrastructure");
  const ids = decodeHistoryTuples(
    historyRows.map((row) => [row.version, row.name, row.content_hash]),
    sourceUserVersion,
    oracle,
  );
  const overlayNames = validatedReindexObjectNames(database, oracle, runtime);
  const rows = explicitSchemaRows(database);
  const migrationInfrastructure = rows.filter((row) => row.name === "schema_migrations");
  if (hasHistory) {
    exact(
      migrationInfrastructure,
      [expectedMigrationInfrastructureRow(oracle, runtime)],
      "migration infrastructure tuple",
    );
  } else if (migrationInfrastructure.length !== 0) {
    throw new Error("invalid migration infrastructure");
  }
  const conversionNames = rows.filter((row) => conversionInfrastructureNames.has(row.name));
  if (conversionNames.length !== 0) {
    if (conversionNames.length !== conversionInfrastructureNames.size) {
      throw new Error("partial conversion infrastructure");
    }
    const count = database
      .query("SELECT count(*) AS count FROM schema_migration_conversions")
      .get()?.count;
    verifyConversionProjection(database, oracle, count, runtime);
  }
  return {
    ids,
    rows: rows.filter(
      (row) =>
        row.name !== "schema_migrations" &&
        !conversionInfrastructureNames.has(row.name) &&
        !overlayNames.has(row.name),
    ),
  };
}

function expectedBaseSchemaRows(ids, oracle, runtime) {
  const key = ids.join("\0");
  if (expectedBaseSchemaCache.has(key)) return expectedBaseSchemaCache.get(key);
  const { Database } = requireBunSqlite();
  const definitions = new Map(
    oracle.canonicalRegistry.migrations.map((row, index) => [row.id, runtime.definitions[index]]),
  );
  const reference = new Database(":memory:", { strict: true });
  reference.exec("PRAGMA foreign_keys = ON");
  try {
    runtime.applyMigrations(
      reference,
      ids.map((id, index) => ({ ...definitions.get(id), version: index + 1 })),
    );
    const overlayNames = validatedReindexObjectNames(reference, oracle, runtime);
    const rows = explicitSchemaRows(reference).filter(
      (row) => row.name !== "schema_migrations" && !overlayNames.has(row.name),
    );
    expectedBaseSchemaCache.set(key, rows);
    return rows;
  } finally {
    reference.close();
  }
}

function validateSequenceDerivedSchema(database, oracle, runtime) {
  const actual = baseSchemaRows(database, oracle, runtime);
  const expected = expectedBaseSchemaRows(actual.ids, oracle, runtime);
  exact(actual.rows, expected, "sequence-derived base schema tuples");
  exact(
    sha256(Buffer.from(JSON.stringify(schemaTupleArrays(actual.rows)), "utf8")),
    sha256(Buffer.from(JSON.stringify(schemaTupleArrays(expected)), "utf8")),
    "sequence-derived base schema digest",
  );
  return actual;
}

function makeConversionRecord(oracle, overrides = {}) {
  const sourceUserVersion = overrides.source_user_version ?? 1;
  const historyRows = overrides.historyRows ?? [
    [1, "message-catalog", oracle.canonicalRegistry.migrations[0].contentHash],
  ];
  const sourceHistoryJson = JSON.stringify(historyRows);
  const sourceHistorySha256 = sha256(Buffer.from(sourceHistoryJson, "utf8"));
  const sourceOverlayId = overrides.source_overlay_id ?? "O-REINDEX-ABSENT";
  const sourceOverlayJson =
    overrides.source_overlay_json ??
    JSON.stringify(["agent-mail/search-reindex-overlay/v1", sourceOverlayId, null, [], [], [], []]);
  const sourceOverlaySha256 = sha256(Buffer.from(sourceOverlayJson, "utf8"));
  const sourceSchemaJson =
    overrides.source_schema_json ?? JSON.stringify(overrides.schemaRows ?? []);
  const sourceSchemaSha256 = sha256(Buffer.from(sourceSchemaJson, "utf8"));
  const targetRegistrySha256 =
    overrides.target_registry_sha256 ?? oracle.conversionMetadata.targetRegistrySha256;
  const backupId = overrides.backup_id ?? "backup:fixture-20260819T000000000Z";
  const backupManifestSha256 = overrides.backup_manifest_sha256 ?? sha256("fixture manifest");
  const completedAt = overrides.completed_at ?? "2026-08-19T00:00:00.000Z";
  const conversionId =
    "migration-conversion:" +
    sha256(
      Buffer.from(
        JSON.stringify([
          "agent-mail/migration-conversion/v1",
          sourceUserVersion,
          sourceHistorySha256,
          sourceOverlayId,
          sourceOverlaySha256,
          sourceSchemaSha256,
          targetRegistrySha256,
          backupId,
          backupManifestSha256,
          completedAt,
        ]),
        "utf8",
      ),
    );
  const values = {
    conversion_id: conversionId,
    source_user_version: sourceUserVersion,
    source_history_json: sourceHistoryJson,
    source_history_sha256: sourceHistorySha256,
    source_overlay_id: sourceOverlayId,
    source_overlay_json: sourceOverlayJson,
    source_overlay_sha256: sourceOverlaySha256,
    source_schema_json: sourceSchemaJson,
    source_schema_sha256: sourceSchemaSha256,
    target_registry_sha256: targetRegistrySha256,
    backup_id: backupId,
    backup_manifest_sha256: backupManifestSha256,
    completed_at: completedAt,
    record_sha256: "",
  };
  values.record_sha256 = sha256(
    Buffer.from(
      JSON.stringify([
        "agent-mail/migration-conversion-record/v1",
        values.conversion_id,
        values.source_user_version,
        values.source_history_json,
        values.source_history_sha256,
        values.source_overlay_id,
        values.source_overlay_json,
        values.source_overlay_sha256,
        values.source_schema_json,
        values.source_schema_sha256,
        values.target_registry_sha256,
        values.backup_id,
        values.backup_manifest_sha256,
        values.completed_at,
      ]),
      "utf8",
    ),
  );
  return values;
}

function encodeReindexOverlaySnapshot(overlayId, snapshot) {
  const lease = snapshot.lease[0];
  return JSON.stringify([
    "agent-mail/search-reindex-overlay/v1",
    overlayId,
    lease === undefined
      ? null
      : [
          lease.lease_id,
          lease.operation_name,
          lease.replacement_name,
          lease.phase,
          lease.last_rowid,
          lease.processed_rows,
        ],
    snapshot.progress.map((row) => [row.replacement_name, row.source_rowid, row.source_digest]),
    snapshot.objects.map((row) => [row.type, row.name, row.tbl_name, row.sql]),
    snapshot.sourceRows.map((row) => [
      row.rowid,
      row.message_id,
      row.subject,
      row.participants,
      row.body_plain,
      row.body_html,
      row.attachment_names,
    ]),
    snapshot.replacementDocsizeRowids,
  ]);
}

function insertConversionRecord(database, oracle, record) {
  const columns = conversionColumnNames(oracle);
  database.exec("BEGIN IMMEDIATE");
  try {
    exact(
      conversionDdlRows(database),
      expectedConversionDdlRows(oracle),
      "pre-insert conversion DDL",
    );
    database.exec("DROP TRIGGER schema_migration_conversions_insert_gate");
    const result = database
      .query(
        "INSERT INTO schema_migration_conversions (" +
          columns.join(", ") +
          ") VALUES (" +
          columns.map(() => "?").join(", ") +
          ")",
      )
      .run(...columns.map((column) => record[column]));
    exact(result.changes, 1, "conversion record insert count");
    database.exec(oracle.conversionMetadata.ddl.insertGateTriggerSql);
    exact(
      conversionDdlRows(database),
      expectedConversionDdlRows(oracle),
      "restored conversion DDL",
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function replaceConversionRecord(database, oracle, record) {
  const columns = conversionColumnNames(oracle);
  database.exec("BEGIN IMMEDIATE");
  try {
    exact(
      conversionDdlRows(database),
      expectedConversionDdlRows(oracle),
      "pre-replacement conversion DDL",
    );
    database.exec("DROP TRIGGER schema_migration_conversions_no_update");
    const result = database
      .query(
        "UPDATE schema_migration_conversions SET " +
          columns.map((column) => column + " = ?").join(", "),
      )
      .run(...columns.map((column) => record[column]));
    exact(result.changes, 1, "conversion record replacement count");
    database.exec(oracle.conversionMetadata.ddl.updateTriggerSql);
    exact(
      conversionDdlRows(database),
      expectedConversionDdlRows(oracle),
      "restored conversion DDL after replacement",
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function parseCanonicalJson(value, label) {
  if (typeof value !== "string") throw new Error(label + " is not text");
  const decoded = JSON.parse(value);
  exact(JSON.stringify(decoded), value, "canonical conversion JSON " + label);
  return decoded;
}

function compareSchemaTuples(left, right) {
  return (
    left[0].localeCompare(right[0]) ||
    left[1].localeCompare(right[1]) ||
    left[2].localeCompare(right[2]) ||
    left[3].localeCompare(right[3])
  );
}

function validateSchemaTupleArrays(rows, label) {
  if (!Array.isArray(rows)) throw new Error(label + " is not an array");
  const identities = new Set();
  for (const tuple of rows) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 4 ||
      !new Set(["table", "index", "trigger", "view"]).has(tuple[0]) ||
      typeof tuple[1] !== "string" ||
      tuple[1].length === 0 ||
      typeof tuple[2] !== "string" ||
      tuple[2].length === 0 ||
      typeof tuple[3] !== "string" ||
      tuple[3].length === 0
    ) {
      throw new Error("invalid " + label + " tuple");
    }
    const identity = tuple[0] + "\0" + tuple[1];
    if (identities.has(identity)) throw new Error("duplicate " + label + " identity");
    identities.add(identity);
  }
  exact(rows, [...rows].sort(compareSchemaTuples), label + " order");
  return rows;
}

function validateOverlayTuple(overlay, sourceOverlayId, database, oracle, runtime) {
  if (!Array.isArray(overlay) || overlay.length !== 7) {
    throw new Error("invalid conversion overlay tuple");
  }
  exact(overlay[0], "agent-mail/search-reindex-overlay/v1", "conversion overlay tag");
  exact(overlay[1], sourceOverlayId, "conversion overlay identity");
  const allowedIds = new Set(
    oracle.historicalSchemaOverlays
      .filter((row) => row.classification === "convertible-overlay")
      .map((row) => row.id),
  );
  if (!allowedIds.has(sourceOverlayId)) throw new Error("unsupported conversion overlay");
  const [lease, progress, objects, sourceRows, replacementDocsizeRowids] = overlay.slice(2);
  if (
    !Array.isArray(progress) ||
    !Array.isArray(objects) ||
    !Array.isArray(sourceRows) ||
    !Array.isArray(replacementDocsizeRowids)
  ) {
    throw new Error("invalid conversion overlay collections");
  }
  validateSchemaTupleArrays(objects, "conversion overlay schema");
  const control = schemaTupleArrays(expectedReindexControlRows(oracle, runtime));
  if (lease === null) {
    exact(progress, [], "inactive overlay progress");
    exact(sourceRows, [], "inactive overlay source rows");
    exact(replacementDocsizeRowids, [], "inactive overlay indexed rowids");
    const expectedObjects =
      sourceOverlayId === "O-REINDEX-ABSENT"
        ? []
        : sourceOverlayId === "O-REINDEX-PARTIAL-EMPTY"
          ? control.slice(0, 1)
          : sourceOverlayId === "O-REINDEX-IDLE"
            ? control
            : null;
    if (expectedObjects === null) throw new Error("active overlay has no lease");
    exact(objects, expectedObjects, "inactive overlay schema");
    return;
  }
  if (
    !Array.isArray(lease) ||
    lease.length !== 6 ||
    lease[0] !== 1 ||
    typeof lease[1] !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(lease[1]) ||
    typeof lease[2] !== "string" ||
    lease[2] !== replacementNameFor(lease[1]) ||
    !new Set(["building", "activating"]).has(lease[3]) ||
    !Number.isSafeInteger(lease[4]) ||
    lease[4] < 0 ||
    !Number.isSafeInteger(lease[5]) ||
    lease[5] < 0
  ) {
    throw new Error("invalid conversion overlay lease");
  }
  const replacementName = lease[2];
  for (const tuple of progress) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      tuple[0] !== replacementName ||
      !Number.isSafeInteger(tuple[1]) ||
      tuple[1] <= 0 ||
      typeof tuple[2] !== "string" ||
      !/^[0-9a-f]{64}$/u.test(tuple[2])
    ) {
      throw new Error("invalid conversion overlay progress");
    }
  }
  exact(
    progress,
    [...progress].sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1]),
    "conversion overlay progress order",
  );
  if (new Set(progress.map((tuple) => tuple[1])).size !== progress.length) {
    throw new Error("duplicate conversion overlay progress identity");
  }
  for (const tuple of sourceRows) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 7 ||
      !Number.isSafeInteger(tuple[0]) ||
      tuple[0] <= 0 ||
      tuple.slice(1).some((value) => typeof value !== "string")
    ) {
      throw new Error("invalid conversion overlay source row");
    }
  }
  exact(
    sourceRows,
    [...sourceRows].sort((left, right) => left[0] - right[0]),
    "conversion overlay source order",
  );
  if (new Set(sourceRows.map((tuple) => tuple[0])).size !== sourceRows.length) {
    throw new Error("duplicate conversion overlay source identity");
  }
  if (
    replacementDocsizeRowids.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    new Set(replacementDocsizeRowids).size !== replacementDocsizeRowids.length
  ) {
    throw new Error("invalid conversion overlay indexed rowids");
  }
  exact(
    replacementDocsizeRowids,
    [...replacementDocsizeRowids].sort((left, right) => left - right),
    "conversion overlay indexed-row order",
  );
  const family = schemaTupleArrays(expectedReplacementObjectRows(replacementName));
  const empty = lease[4] === 0 && lease[5] === 0 && progress.length === 0;
  const familyPresent = objects.length === control.length + family.length;
  const expectedObjects = [...control, ...(familyPresent ? family : [])].sort(compareSchemaTuples);
  exact(objects, expectedObjects, "conversion overlay complete object tuples");
  if (empty) {
    if (lease[3] !== "building" || replacementDocsizeRowids.length !== 0) {
      throw new Error("invalid building-empty overlay");
    }
    exact(
      sourceOverlayId,
      familyPresent ? "O-REINDEX-BUILDING-EMPTY-PRESENT" : "O-REINDEX-BUILDING-EMPTY-ABSENT",
      "building-empty overlay identity",
    );
    return;
  }
  if (!familyPresent || lease[5] !== progress.length) {
    throw new Error("invalid nonempty overlay relations");
  }
  exact(
    progress.map((tuple) => tuple[1]),
    replacementDocsizeRowids,
    "overlay progress/index identities",
  );
  exact(lease[4], progress.at(-1)?.[1], "overlay last rowid");
  const sourceDigests = sourceRows.map((tuple) => ({
    rowid: tuple[0],
    digest: sha256(Buffer.from(JSON.stringify(tuple), "utf8")),
  }));
  const sourceById = new Map(sourceDigests.map((row) => [row.rowid, row.digest]));
  for (const tuple of progress) {
    if (sourceById.get(tuple[1]) !== tuple[2]) throw new Error("overlay source digest mismatch");
  }
  if (lease[3] === "activating") {
    exact(sourceOverlayId, "O-REINDEX-ACTIVATING", "activating overlay identity");
    if (
      progress.length !== sourceDigests.length ||
      lease[4] !== (sourceDigests.at(-1)?.rowid ?? 0)
    ) {
      throw new Error("incomplete activating overlay");
    }
  } else {
    exact(sourceOverlayId, "O-REINDEX-BUILDING", "building overlay identity");
  }
}

function decodeConversionRecord(
  database,
  row,
  oracle,
  runtime,
  liveRegistryRows = oracle.canonicalRegistry.migrations,
) {
  const history = parseCanonicalJson(row.source_history_json, "source_history_json");
  const ids = decodeHistoryTuples(history, row.source_user_version, oracle);
  const targetVersion = acceptedConversionTargets(oracle).get(row.target_registry_sha256);
  if (targetVersion === undefined) throw new Error("unknown conversion target registry prefix");
  const canonicalVersionById = new Map(
    oracle.canonicalRegistry.migrations.map((migration) => [migration.id, migration.version]),
  );
  if (
    ids.some((id) => (canonicalVersionById.get(id) ?? Number.POSITIVE_INFINITY) > targetVersion)
  ) {
    throw new Error("conversion source identity is newer than conversion target");
  }
  const schema = validateSchemaTupleArrays(
    parseCanonicalJson(row.source_schema_json, "source_schema_json"),
    "conversion source schema",
  );
  exact(
    schema,
    schemaTupleArrays(expectedBaseSchemaRows(ids, oracle, runtime)),
    "conversion sequence-derived schema",
  );
  const overlay = parseCanonicalJson(row.source_overlay_json, "source_overlay_json");
  validateOverlayTuple(overlay, row.source_overlay_id, database, oracle, runtime);
  if (
    !/^backup:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.backup_id) ||
    !/^[0-9a-f]{64}$/u.test(row.backup_manifest_sha256) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.completed_at) ||
    new Date(row.completed_at).toISOString() !== row.completed_at
  ) {
    throw new Error("conversion backup/timestamp domain mismatch");
  }
  for (const [jsonColumn, digestColumn] of [
    ["source_history_json", "source_history_sha256"],
    ["source_overlay_json", "source_overlay_sha256"],
    ["source_schema_json", "source_schema_sha256"],
  ]) {
    exact(
      sha256(Buffer.from(row[jsonColumn], "utf8")),
      row[digestColumn],
      "conversion component digest " + digestColumn,
    );
  }
  const expectedConversionId =
    "migration-conversion:" +
    sha256(
      Buffer.from(
        JSON.stringify([
          "agent-mail/migration-conversion/v1",
          row.source_user_version,
          row.source_history_sha256,
          row.source_overlay_id,
          row.source_overlay_sha256,
          row.source_schema_sha256,
          row.target_registry_sha256,
          row.backup_id,
          row.backup_manifest_sha256,
          row.completed_at,
        ]),
        "utf8",
      ),
    );
  exact(row.conversion_id, expectedConversionId, "conversion id encoding");
  const expectedRecordSha256 = sha256(
    Buffer.from(
      JSON.stringify([
        "agent-mail/migration-conversion-record/v1",
        row.conversion_id,
        row.source_user_version,
        row.source_history_json,
        row.source_history_sha256,
        row.source_overlay_id,
        row.source_overlay_json,
        row.source_overlay_sha256,
        row.source_schema_json,
        row.source_schema_sha256,
        row.target_registry_sha256,
        row.backup_id,
        row.backup_manifest_sha256,
        row.completed_at,
      ]),
      "utf8",
    ),
  );
  exact(row.record_sha256, expectedRecordSha256, "conversion record encoding");
  return { history, ids, schema, overlay, targetVersion };
}

function verifyConversionProjection(
  database,
  oracle,
  expectedRows,
  runtime,
  liveRegistryRows = oracle.canonicalRegistry.migrations,
) {
  exact(
    conversionDdlRows(database),
    expectedConversionDdlRows(oracle),
    "conversion DDL projection",
  );
  const columns = conversionColumnNames(oracle);
  const rows = database
    .query(
      "SELECT " + columns.join(", ") + " FROM schema_migration_conversions ORDER BY conversion_id",
    )
    .all();
  exact(rows.length, expectedRows, "conversion provenance row count");
  const liveHistory = database
    .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
    .all();
  exact(
    liveHistory,
    liveRegistryRows.map((migration) => ({
      version: migration.version,
      name: migration.name,
      content_hash: migration.contentHash,
    })),
    "conversion live canonical history",
  );
  for (const row of rows) {
    decodeConversionRecord(database, row, oracle, runtime, liveRegistryRows);
  }
  return rows;
}

function applyProofSuffixWithProvenanceGate(
  database,
  oracle,
  runtime,
  currentRegistryRows,
  suffix,
  { failBeforeCommit = false, failAfterCommit = false } = {},
) {
  database.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    verifyConversionProjection(database, oracle, 1, runtime, currentRegistryRows);
    database.exec(suffix.sql);
    database
      .query("INSERT INTO schema_migrations (version, name, content_hash) VALUES (?, ?, ?)")
      .run(suffix.version, suffix.name, suffix.contentHash);
    database.exec("PRAGMA user_version = " + suffix.version);
    if (failBeforeCommit) throw new Error("proof suffix crash before commit");
    database.exec("COMMIT");
    committed = true;
    if (failAfterCommit) throw new Error("proof suffix crash after commit");
  } catch (error) {
    if (!committed) database.exec("ROLLBACK");
    throw error;
  }
}

function proofRegistryRows(oracle, count) {
  return [
    ...oracle.canonicalRegistry.migrations,
    ...oracle.appendStableProvenance.proofSuffixes.slice(0, count),
  ];
}

async function provenanceProjection(oracle, runtime) {
  const { Database } = await import("bun:sqlite");
  const search = await import(
    pathToFileURL(join(repositoryRoot, "packages/storage/src/search-reindex.ts")).href
  );
  const converter = await import(
    pathToFileURL(join(repositoryRoot, "packages/storage/src/migration-history-conversion.ts")).href
  );
  const fresh = new Database(":memory:", { strict: true });
  fresh.exec("PRAGMA foreign_keys = ON");
  runtime.applyMigrations(fresh, runtime.definitions);
  installConversionInfrastructure(fresh, oracle);
  verifyConversionProjection(fresh, oracle, 0, runtime);
  exact(fresh.query("PRAGMA user_version").get()?.user_version, 27, "provenance fresh version");
  exact(
    fresh.query("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()
      ?.count,
    oracle.baseline.freshSchemaObjectCount + 5,
    "provenance fresh schema object count",
  );
  fresh.close();

  const converted = new Database(":memory:", { strict: true });
  converted.exec("PRAGMA foreign_keys = ON");
  const legacyDefinitions = [
    runtime.definitions[0],
    runtime.definitions[2],
    runtime.definitions[7],
  ].map((definition, index) => ({ ...definition, version: index + 1 }));
  runtime.applyMigrations(converted, legacyDefinitions);
  exact(
    converter.classifyMigrationHistory(converted).classification,
    "supported-legacy",
    "real production converter legacy fixture classification",
  );
  seedReindexProjection(converted);
  let interrupted = false;
  try {
    search.rebuildSearchIndex(converted, {
      operationName: oracle.reindexAuthority.nondefaultFixtureOperationName,
      batchSize: 1,
      representativeQueries: [{ query: "new", expectedRowids: [20] }],
      beforeBoundary: (boundary) => {
        if (boundary === "batch-committed") throw new Error("provenance overlay interruption");
      },
    });
  } catch (error) {
    interrupted =
      error instanceof Error &&
      (error.message === "provenance overlay interruption" ||
        (error.cause instanceof Error &&
          error.cause.message === "provenance overlay interruption"));
    if (!interrupted) fail("provenance overlay fixture failed before boundary: " + String(error));
  }
  exact(interrupted, true, "provenance overlay fixture interruption");
  const overlaySnapshot = reindexOverlaySnapshot(converted);
  const legacyClassification = converter.classifyMigrationHistory(converted);
  exact(
    legacyClassification.overlay.id,
    "O-REINDEX-BUILDING",
    "real production converter legacy overlay",
  );
  converter.convertMigrationHistory(converted, {
    backupProof: {
      backupId: "backup:oracle-real-converter",
      manifestSha256: sha256(Buffer.from("oracle real converter backup", "utf8")),
      createdAt: "2026-08-20T00:00:00.000Z",
    },
  });
  exact(
    converted.query("PRAGMA user_version").get()?.user_version,
    27,
    "real production converter target version",
  );
  exact(
    converted.query("SELECT count(*) AS count FROM schema_migrations").get()?.count,
    27,
    "real production converter target ledger count",
  );
  verifyConversionProjection(converted, oracle, 1, runtime);
  exact(reindexOverlaySnapshot(converted), overlaySnapshot, "real converter overlay preservation");
  const record = converted
    .query(
      "SELECT " +
        conversionColumnNames(oracle).join(", ") +
        " FROM schema_migration_conversions ORDER BY conversion_id",
    )
    .get();
  exact(
    record?.target_registry_sha256,
    oracle.conversionMetadata.targetRegistrySha256,
    "real production converter target digest",
  );
  let unauthorizedInsertRejected = false;
  try {
    const columns = conversionColumnNames(oracle);
    converted
      .query(
        "INSERT INTO schema_migration_conversions (" +
          columns.join(", ") +
          ") VALUES (" +
          columns.map(() => "?").join(", ") +
          ")",
      )
      .run(...columns.map((column) => record[column]));
  } catch {
    unauthorizedInsertRejected = true;
  }
  exact(unauthorizedInsertRejected, true, "unauthorized conversion insert rejection");
  for (const statement of [
    "UPDATE schema_migration_conversions SET completed_at = completed_at",
    "DELETE FROM schema_migration_conversions",
  ]) {
    let rejected = false;
    try {
      converted.exec(statement);
    } catch {
      rejected = true;
    }
    exact(rejected, true, "conversion immutability " + statement.split(" ")[0]);
  }

  const serialized = converted.serialize();
  converted.close();
  const reopened = Database.deserialize(serialized, { strict: true });
  verifyConversionProjection(reopened, oracle, 1, runtime);
  exact(reindexOverlaySnapshot(reopened), overlaySnapshot, "reopened provenance overlay");
  verifyConversionProjection(reopened, oracle, 1, runtime);
  exact(reindexOverlaySnapshot(reopened), overlaySnapshot, "doctor provenance overlay");
  const backupBytes = reopened.serialize();
  reopened.close();
  const restored = Database.deserialize(backupBytes, { strict: true });
  verifyConversionProjection(restored, oracle, 1, runtime);
  exact(reindexOverlaySnapshot(restored), overlaySnapshot, "restored provenance overlay");
  restored.close();

  const conversionColumns = conversionColumnNames(oracle);
  const target27Snapshot = Database.deserialize(backupBytes, { strict: true });
  const target27Bytes = JSON.stringify(
    target27Snapshot
      .query(
        "SELECT " +
          conversionColumns.join(", ") +
          " FROM schema_migration_conversions ORDER BY conversion_id",
      )
      .all(),
  );
  target27Snapshot.close();
  const registry27 = proofRegistryRows(oracle, 0);
  const registry28 = proofRegistryRows(oracle, 1);
  const registry29 = proofRegistryRows(oracle, 2);
  exact(
    acceptedConversionTargets(oracle).get(oracle.conversionMetadata.targetRegistrySha256),
    27,
    "target 27 remains recognized after append 28",
  );
  exact(
    acceptedConversionTargets(oracle).get(oracle.conversionMetadata.targetRegistrySha256),
    27,
    "target 27 remains recognized after later append 29",
  );
  const target28RegistrySha256 = computeRegistryIdentityDigest(registry28);
  if (target28RegistrySha256 === oracle.conversionMetadata.targetRegistrySha256) {
    fail("proof suffix 28 did not change the live full-registry digest");
  }
  const fullDigestSubstitutionRecord = makeConversionRecord(oracle, {
    historyRows: JSON.parse(record.source_history_json),
    source_overlay_id: record.source_overlay_id,
    source_overlay_json: record.source_overlay_json,
    source_schema_json: record.source_schema_json,
    target_registry_sha256: target28RegistrySha256,
    backup_id: record.backup_id,
    backup_manifest_sha256: record.backup_manifest_sha256,
    completed_at: record.completed_at,
  });
  const substituted = Database.deserialize(backupBytes, { strict: true });
  replaceConversionRecord(substituted, oracle, fullDigestSubstitutionRecord);
  const substitutedBytes = substituted.serialize();
  substituted.close();

  const fullDigestSubstitutionStages = ["reopen", "doctor", "backup", "restore"];
  let fullDigestSubstitutionRejections = 0;
  for (const stage of fullDigestSubstitutionStages) {
    const database = Database.deserialize(substitutedBytes, { strict: true });
    try {
      let rejected = false;
      try {
        verifyConversionProjection(database, oracle, 1, runtime, registry27);
      } catch {
        rejected = true;
      }
      exact(rejected, true, "full-digest substitution " + stage + " rejection");
      fullDigestSubstitutionRejections += 1;
    } finally {
      database.close();
    }
  }

  const substitutedBeforeSuffix = Database.deserialize(substitutedBytes, { strict: true });
  let fullDigestSubstitutionBeforeSuffixRejected = false;
  try {
    applyProofSuffixWithProvenanceGate(
      substitutedBeforeSuffix,
      oracle,
      runtime,
      registry27,
      oracle.appendStableProvenance.proofSuffixes[0],
    );
  } catch {
    fullDigestSubstitutionBeforeSuffixRejected = true;
  }
  exact(
    fullDigestSubstitutionBeforeSuffixRejected,
    true,
    "full-digest substitution rejects before suffix",
  );
  exact(
    substitutedBeforeSuffix.query("PRAGMA user_version").get()?.user_version,
    27,
    "full-digest substitution suffix version unchanged",
  );
  exact(
    hasSchemaObject(substitutedBeforeSuffix, "append_stability_probe_28"),
    false,
    "full-digest substitution executes no suffix SQL",
  );
  exact(
    substitutedBeforeSuffix.query("SELECT count(*) AS count FROM schema_migrations").get()?.count,
    27,
    "full-digest substitution inserts no suffix history",
  );
  substitutedBeforeSuffix.close();

  const beforeCommitCrash = Database.deserialize(backupBytes, { strict: true });
  let beforeCommitCrashObserved = false;
  try {
    applyProofSuffixWithProvenanceGate(
      beforeCommitCrash,
      oracle,
      runtime,
      registry27,
      oracle.appendStableProvenance.proofSuffixes[0],
      { failBeforeCommit: true },
    );
  } catch (error) {
    beforeCommitCrashObserved =
      error instanceof Error && error.message === "proof suffix crash before commit";
  }
  exact(beforeCommitCrashObserved, true, "precommit suffix crash observed");
  exact(
    beforeCommitCrash.query("PRAGMA user_version").get()?.user_version,
    27,
    "precommit suffix crash version",
  );
  exact(hasSchemaObject(beforeCommitCrash, "append_stability_probe_28"), false, "precommit SQL");
  verifyConversionProjection(beforeCommitCrash, oracle, 1, runtime, registry27);
  beforeCommitCrash.close();

  const appended = Database.deserialize(backupBytes, { strict: true });
  applyProofSuffixWithProvenanceGate(
    appended,
    oracle,
    runtime,
    registry27,
    oracle.appendStableProvenance.proofSuffixes[0],
  );
  verifyConversionProjection(appended, oracle, 1, runtime, registry28);
  exact(appended.query("PRAGMA user_version").get()?.user_version, 28, "appended version 28");
  exact(hasSchemaObject(appended, "append_stability_probe_28"), true, "appended SQL 28");
  exact(
    JSON.stringify(
      appended
        .query(
          "SELECT " +
            conversionColumns.join(", ") +
            " FROM schema_migration_conversions ORDER BY conversion_id",
        )
        .all(),
    ),
    target27Bytes,
    "immutable target-27 conversion bytes after append",
  );

  const appendedBytes = appended.serialize();
  appended.close();
  const appendedReopen = Database.deserialize(appendedBytes, { strict: true });
  verifyConversionProjection(appendedReopen, oracle, 1, runtime, registry28);
  exact(reindexOverlaySnapshot(appendedReopen), overlaySnapshot, "appended reopen overlay");
  verifyConversionProjection(appendedReopen, oracle, 1, runtime, registry28);
  const appendedBackupBytes = appendedReopen.serialize();
  appendedReopen.close();
  const appendedRestore = Database.deserialize(appendedBackupBytes, { strict: true });
  verifyConversionProjection(appendedRestore, oracle, 1, runtime, registry28);
  exact(reindexOverlaySnapshot(appendedRestore), overlaySnapshot, "appended restore overlay");
  const fullRestoreStageBytes = appendedRestore.serialize();
  const fullRestoreStage = Database.deserialize(fullRestoreStageBytes, { strict: true });
  verifyConversionProjection(fullRestoreStage, oracle, 1, runtime, registry28);
  exact(reindexOverlaySnapshot(fullRestoreStage), overlaySnapshot, "full restore staged overlay");
  const fullRestorePublishedBytes = fullRestoreStage.serialize();
  fullRestoreStage.close();
  const fullRestorePublished = Database.deserialize(fullRestorePublishedBytes, { strict: true });
  verifyConversionProjection(fullRestorePublished, oracle, 1, runtime, registry28);
  exact(
    reindexOverlaySnapshot(fullRestorePublished),
    overlaySnapshot,
    "full restore published overlay",
  );
  fullRestorePublished.close();
  applyProofSuffixWithProvenanceGate(
    appendedRestore,
    oracle,
    runtime,
    registry28,
    oracle.appendStableProvenance.proofSuffixes[1],
  );
  verifyConversionProjection(appendedRestore, oracle, 1, runtime, registry29);
  exact(appendedRestore.query("PRAGMA user_version").get()?.user_version, 29, "later append");
  appendedRestore.close();

  const afterCommitCrash = Database.deserialize(backupBytes, { strict: true });
  let afterCommitCrashObserved = false;
  try {
    applyProofSuffixWithProvenanceGate(
      afterCommitCrash,
      oracle,
      runtime,
      registry27,
      oracle.appendStableProvenance.proofSuffixes[0],
      { failAfterCommit: true },
    );
  } catch (error) {
    afterCommitCrashObserved =
      error instanceof Error && error.message === "proof suffix crash after commit";
  }
  exact(afterCommitCrashObserved, true, "postcommit suffix crash observed");
  verifyConversionProjection(afterCommitCrash, oracle, 1, runtime, registry28);
  afterCommitCrash.close();

  const invalidBeforeSuffix = Database.deserialize(backupBytes, { strict: true });
  invalidBeforeSuffix.exec("DROP TRIGGER schema_migration_conversions_no_update");
  invalidBeforeSuffix.exec(
    `UPDATE schema_migration_conversions SET record_sha256 = '${"0".repeat(64)}'`,
  );
  invalidBeforeSuffix.exec(oracle.conversionMetadata.ddl.updateTriggerSql);
  let invalidBeforeSuffixRejected = false;
  try {
    applyProofSuffixWithProvenanceGate(
      invalidBeforeSuffix,
      oracle,
      runtime,
      registry27,
      oracle.appendStableProvenance.proofSuffixes[0],
    );
  } catch {
    invalidBeforeSuffixRejected = true;
  }
  exact(invalidBeforeSuffixRejected, true, "invalid provenance rejects before suffix");
  exact(
    invalidBeforeSuffix.query("PRAGMA user_version").get()?.user_version,
    27,
    "invalid provenance suffix version unchanged",
  );
  exact(
    hasSchemaObject(invalidBeforeSuffix, "append_stability_probe_28"),
    false,
    "invalid provenance executes no suffix SQL",
  );
  exact(
    invalidBeforeSuffix.query("SELECT count(*) AS count FROM schema_migrations").get()?.count,
    27,
    "invalid provenance inserts no suffix history",
  );
  invalidBeforeSuffix.close();

  const mutations = [
    [
      "ddl-index",
      (database) => database.exec("DROP INDEX schema_migration_conversions_source_identity"),
    ],
    [
      "row-digest",
      (database) => {
        database.exec("DROP TRIGGER schema_migration_conversions_no_update");
        database.exec(
          `UPDATE schema_migration_conversions SET record_sha256 = '${"0".repeat(64)}'`,
        );
        database.exec(oracle.conversionMetadata.ddl.updateTriggerSql);
      },
    ],
    ["trigger", (database) => database.exec("DROP TRIGGER schema_migration_conversions_no_delete")],
  ];
  let mutationsRejected = 0;
  for (const [id, mutate] of mutations) {
    const database = Database.deserialize(backupBytes, { strict: true });
    try {
      mutate(database);
      let rejected = false;
      try {
        verifyConversionProjection(database, oracle, 1, runtime);
      } catch {
        rejected = true;
      }
      exact(rejected, true, id + " provenance mutation rejection");
      mutationsRejected += 1;
    } finally {
      database.close();
    }
  }
  const validSourceSchema = JSON.parse(record.source_schema_json);
  const invalidOverlay = JSON.parse(record.source_overlay_json);
  invalidOverlay[2][1] = "bad operation name";
  const forgedRecords = [
    [
      "self-consistent-history",
      makeConversionRecord(oracle, {
        historyRows: [[1, "unknown-migration", sha256("unknown migration")]],
        source_schema_json: record.source_schema_json,
      }),
    ],
    [
      "self-consistent-schema",
      makeConversionRecord(oracle, {
        source_schema_json: JSON.stringify(
          [
            ...validSourceSchema,
            [
              "table",
              "forged_provenance_table",
              "forged_provenance_table",
              "CREATE TABLE forged_provenance_table (id INTEGER)",
            ],
          ].sort(compareSchemaTuples),
        ),
      }),
    ],
    [
      "self-consistent-overlay",
      makeConversionRecord(oracle, {
        source_overlay_id: "O-REINDEX-BUILDING",
        source_overlay_json: JSON.stringify(invalidOverlay),
        source_schema_json: record.source_schema_json,
      }),
    ],
    [
      "self-consistent-target",
      makeConversionRecord(oracle, {
        target_registry_sha256: sha256("unknown conversion target"),
        source_overlay_id: "O-REINDEX-BUILDING",
        source_overlay_json: record.source_overlay_json,
        source_schema_json: record.source_schema_json,
        completed_at: "2026-08-19T00:00:01.000Z",
      }),
    ],
    ["full-digest-substitution", fullDigestSubstitutionRecord],
  ];
  let forgedRecordsRejected = 0;
  for (const [id, forgedRecord] of forgedRecords) {
    const database = Database.deserialize(backupBytes, { strict: true });
    try {
      insertConversionRecord(database, oracle, forgedRecord);
      let rejected = false;
      try {
        verifyConversionProjection(database, oracle, 2, runtime);
      } catch {
        rejected = true;
      }
      exact(rejected, true, id + " provenance rejection");
      forgedRecordsRejected += 1;
    } finally {
      database.close();
    }
  }
  return {
    stages: [
      "fresh",
      "conversion-27",
      "append-28",
      "crash-reopen",
      "doctor",
      "backup",
      "restore",
      "full-restore",
      "later-append-29",
    ],
    rows: 1,
    ddlObjects: 5,
    historicalTargetVersion: 27,
    realProductionConverter: true,
    realProductionConverterSource: oracle.canonicalRegistry.conversionPath,
    realProductionConversionSourceHistoryRows: 3,
    realProductionConversionTargetRows: 27,
    appendVersions: [28, 29],
    target28RegistrySha256,
    fullDigestSubstitutionRejections,
    fullDigestSubstitutionBeforeSuffixRejected,
    beforeCommitCrashObserved,
    afterCommitCrashObserved,
    invalidBeforeSuffixRejected,
    unauthorizedInsertRejected,
    immutableStatementsRejected: 2,
    mutationsRejected,
    forgedRecordsRejected,
  };
}

function snapshotFocusedTree(root) {
  const rows = [];
  const visit = (path) => {
    const metadata = lstatSync(path, { bigint: true });
    const name = relative(root, path).replaceAll("\\", "/") || ".";
    let type;
    let digest = null;
    if (metadata.isSymbolicLink()) type = "symlink";
    else if (metadata.isDirectory()) type = "directory";
    else if (metadata.isFile()) {
      type = "file";
      digest = sha256(readFileSync(path));
    } else type = "other";
    rows.push([
      name,
      type,
      metadata.dev.toString(),
      metadata.ino.toString(),
      Number(metadata.mode & 0o7777n),
      metadata.size.toString(),
      metadata.mtimeNs.toString(),
      metadata.ctimeNs.toString(),
      digest,
    ]);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    }
  };
  visit(root);
  return rows;
}

function stableDatabaseSourceSnapshot(privateRoot, databasePath) {
  const tree = snapshotFocusedTree(privateRoot);
  const files = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = databasePath + suffix;
    if (!existsSync(path)) {
      files[suffix || "main"] = null;
      continue;
    }
    const metadata = lstatSync(path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail("unsafe database source path");
    files[suffix || "main"] = {
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      mode: Number(metadata.mode & 0o7777n),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
      sha256: sha256(readFileSync(path)),
    };
  }
  if (files.main === null) fail("database source main file is absent");
  return { tree, files };
}

function classifyScratchDatabase(database, oracle, runtime) {
  database.exec("PRAGMA query_only = ON");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA trusted_schema = OFF");
  exact(database.query("PRAGMA query_only").get()?.query_only, 1, "scratch query_only");
  exact(database.query("PRAGMA foreign_keys").get()?.foreign_keys, 1, "scratch foreign_keys");
  exact(database.query("PRAGMA trusted_schema").get()?.trusted_schema, 0, "scratch trusted_schema");
  if (database.query("PRAGMA integrity_check").get()?.integrity_check !== "ok") return "corrupt";
  const userVersion = database.query("PRAGMA user_version").get()?.user_version;
  if (!Number.isSafeInteger(userVersion)) return "corrupt";
  if (userVersion > oracle.canonicalRegistry.schemaVersion) return "newer";
  if (!hasSchemaObject(database, "schema_migrations")) {
    return userVersion === 0 && explicitSchemaRows(database).length === 0 ? "supported" : "unknown";
  }
  const history = database
    .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
    .all();
  if (history.some((row) => row.name === "test-action-chain-placeholder")) return "placeholder";
  try {
    decodeHistoryTuples(
      history.map((row) => [row.version, row.name, row.content_hash]),
      userVersion,
      oracle,
    );
  } catch {
    return "unknown";
  }
  const hasConversionInfrastructure = expectedConversionDdlRows(oracle).some((row) =>
    hasSchemaObject(database, row.name),
  );
  try {
    validateSequenceDerivedSchema(database, oracle, runtime);
    exact(database.query("PRAGMA foreign_key_check").all(), [], "scratch foreign keys");
    const conversionObjects = expectedConversionDdlRows(oracle).filter((row) =>
      hasSchemaObject(database, row.name),
    );
    if (conversionObjects.length > 0) {
      const count = database
        .query("SELECT count(*) AS count FROM schema_migration_conversions")
        .get()?.count;
      if (!Number.isSafeInteger(count)) throw new Error("invalid conversion row count");
      verifyConversionProjection(database, oracle, count, runtime);
    }
  } catch {
    return hasConversionInfrastructure ? "provenance-invalid" : "schema-mismatch";
  }
  return "supported";
}

function scratchPreflight(privateRoot, databasePath, oracle, runtime) {
  const before = stableDatabaseSourceSnapshot(privateRoot, databasePath);
  const scratchRoot = mkdtempSync(join(tmpdir(), "agent-mail-migration-preflight-"));
  chmodSync(scratchRoot, 0o700);
  const scratchDatabasePath = join(scratchRoot, "archive.sqlite");
  let classification = "corrupt";
  try {
    copyFileSync(databasePath, scratchDatabasePath);
    if (existsSync(databasePath + "-wal")) {
      copyFileSync(databasePath + "-wal", scratchDatabasePath + "-wal");
    }
    const afterCopy = stableDatabaseSourceSnapshot(privateRoot, databasePath);
    exact(afterCopy, before, "stable preflight source copy");
    const { Database } = requireBunSqlite();
    let scratch;
    try {
      scratch = new Database(scratchDatabasePath, { create: false, strict: true });
      classification = classifyScratchDatabase(scratch, oracle, runtime);
    } catch {
      classification = "corrupt";
    } finally {
      scratch?.close();
    }
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
  exact(existsSync(scratchRoot), false, "preflight scratch cleanup");
  exact(
    stableDatabaseSourceSnapshot(privateRoot, databasePath),
    before,
    "preflight source tree preservation",
  );
  return { classification, source: before };
}

let bunSqliteModule;
function requireBunSqlite() {
  if (bunSqliteModule === undefined) fail("bun:sqlite module is not initialized");
  return bunSqliteModule;
}

async function createPreflightFixture(oracle, runtime, kind) {
  const { Database } = requireBunSqlite();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "agent-mail-migration-source-"));
  chmodSync(fixtureRoot, 0o700);
  const privateRoot = join(fixtureRoot, "private");
  mkdirSync(join(privateRoot, "blobs", "raw"), { recursive: true, mode: 0o700 });
  writeFileSync(join(privateRoot, "blobs", "raw", "sentinel"), "preserve", { mode: 0o600 });
  const databasePath = join(privateRoot, "archive.sqlite");
  if (kind === "corrupt") {
    writeFileSync(databasePath, Buffer.from("not a sqlite database\n", "utf8"), { mode: 0o440 });
    return { fixtureRoot, privateRoot, databasePath, writer: undefined };
  }
  const writer = new Database(databasePath, { create: true, strict: true });
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  runtime.applyMigrations(writer, runtime.definitions);
  if (kind === "unknown") {
    writer.exec("UPDATE schema_migrations SET name = 'unknown-migration' WHERE version = 1");
  }
  if (kind === "placeholder") {
    writer
      .query("UPDATE schema_migrations SET name = ?, content_hash = ? WHERE version = 1")
      .run("test-action-chain-placeholder", sha256("placeholder"));
  }
  if (kind === "direct-sql") writer.exec("CREATE TABLE unrecorded_direct_sql (id INTEGER)");
  if (kind === "added-table") writer.exec("CREATE TABLE forged_added_table (id INTEGER)");
  if (kind === "changed-table") writer.exec("ALTER TABLE messages ADD COLUMN forged_column TEXT");
  if (kind === "added-index")
    writer.exec("CREATE INDEX forged_added_index ON messages(message_id)");
  if (kind === "changed-index") {
    writer.exec("DROP INDEX action_plans_state_idx");
    writer.exec("CREATE INDEX action_plans_state_idx ON action_plans(plan_id)");
  }
  if (kind === "added-trigger") {
    writer.exec("CREATE TRIGGER forged_added_trigger AFTER INSERT ON messages BEGIN SELECT 1; END");
  }
  if (kind === "changed-trigger") {
    writer.exec("DROP TRIGGER action_attempt_dispatch_delete_immutable");
    writer.exec(
      "CREATE TRIGGER action_attempt_dispatch_delete_immutable BEFORE DELETE ON action_attempt_dispatches BEGIN SELECT 1; END",
    );
  }
  if (kind === "added-view") writer.exec("CREATE VIEW forged_added_view AS SELECT 1 AS value");
  if (kind === "changed-view") {
    writer.exec("DROP VIEW indexed_messages");
    writer.exec(
      "CREATE VIEW indexed_messages AS SELECT d.document_id AS rowid, d.message_id, " +
        "'' AS subject, '' AS participants, '' AS body_plain, '' AS body_html, " +
        "'' AS attachment_names FROM message_search_documents d",
    );
  }
  if (kind === "provenance-invalid" || kind === "provenance-full-digest-substitution") {
    installConversionInfrastructure(writer, oracle);
    const record = makeConversionRecord(oracle, {
      source_schema_json: JSON.stringify(
        schemaTupleArrays(expectedBaseSchemaRows(["message-catalog"], oracle, runtime)),
      ),
      ...(kind === "provenance-full-digest-substitution"
        ? { target_registry_sha256: computeRegistryIdentityDigest(proofRegistryRows(oracle, 1)) }
        : {}),
    });
    insertConversionRecord(writer, oracle, record);
    if (kind === "provenance-invalid") {
      writer.exec("DROP TRIGGER schema_migration_conversions_no_update");
      writer.exec(`UPDATE schema_migration_conversions SET record_sha256 = '${"0".repeat(64)}'`);
      writer.exec(oracle.conversionMetadata.ddl.updateTriggerSql);
    }
  }
  writer.exec("PRAGMA user_version = " + (kind === "newer" ? 28 : 27));
  chmodSync(databasePath, 0o440);
  return { fixtureRoot, privateRoot, databasePath, writer };
}

async function preflightProjection(oracle, runtime) {
  bunSqliteModule = await import("bun:sqlite");
  const cases = [
    ["supported", "supported"],
    ["newer", "newer"],
    ["unknown", "unknown"],
    ["placeholder", "placeholder"],
    ["direct-sql", "schema-mismatch"],
    ["corrupt", "corrupt"],
    ["added-table", "schema-mismatch"],
    ["changed-table", "schema-mismatch"],
    ["added-index", "schema-mismatch"],
    ["changed-index", "schema-mismatch"],
    ["added-trigger", "schema-mismatch"],
    ["changed-trigger", "schema-mismatch"],
    ["added-view", "schema-mismatch"],
    ["changed-view", "schema-mismatch"],
    ["provenance-invalid", "provenance-invalid"],
    ["provenance-full-digest-substitution", "provenance-invalid"],
  ];
  let sidecarCases = 0;
  for (const [fixtureKind, expected] of cases) {
    const fixture = await createPreflightFixture(oracle, runtime, fixtureKind);
    try {
      const result = scratchPreflight(fixture.privateRoot, fixture.databasePath, oracle, runtime);
      exact(result.classification, expected, fixtureKind + " preflight classification");
      if (fixtureKind !== "corrupt") {
        exact(result.source.files.main !== null, true, fixtureKind + " main presence");
        exact(result.source.files["-wal"] !== null, true, fixtureKind + " WAL presence");
        exact(result.source.files["-shm"] !== null, true, fixtureKind + " SHM presence");
        sidecarCases += 1;
      }
    } finally {
      fixture.writer?.close();
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  }
  return {
    cases: cases.length,
    supported: 1,
    rejected: cases.length - 1,
    wholeTreePreserved: cases.length,
    mainWalShmPreserved: sidecarCases,
    allowedPragmas: oracle.preflightAuthority.allowedPragmas.length,
  };
}

function acceptedTypeScriptSourceMap() {
  const paths = git(["ls-tree", "-r", "--name-only", ACCEPTED_HEAD])
    .trim()
    .split("\n")
    .filter((path) => path.endsWith(".ts"))
    .sort();
  return new Map(paths.map((path) => [path, readCommitted(path).toString("utf8")]));
}

function countPattern(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function packageSrcTypeScriptPath(path, authority) {
  return new RegExp(authority.productionSourceClassification.productionSourcePattern, "u").test(
    path,
  );
}

function hasNonProductionRoleToken(path, authority) {
  if (!packageSrcTypeScriptPath(path, authority)) return false;
  const srcRelative = path.slice(path.indexOf("/src/") + "/src/".length);
  return new RegExp(
    authority.productionSourceClassification.nonProductionRoleTokenPattern,
    "u",
  ).test(srcRelative);
}

function isProductionTypeScriptSource(path, authority) {
  return packageSrcTypeScriptPath(path, authority) && !hasNonProductionRoleToken(path, authority);
}

function durableDdlStatementCount(text) {
  return countPattern(
    text,
    /\b(?:CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER)|ALTER\s+TABLE|DROP\s+TABLE)\b/giu,
  );
}

function canonicalDdlAllowedPaths(oracle) {
  return new Set([
    ...oracle.canonicalRegistry.migrations.map((row) => row.source),
    ...oracle.canonicalRegistry.migrations.flatMap((row) =>
      row.registrySource === undefined ? [] : [row.registrySource],
    ),
    oracle.canonicalRegistry.conversionPath,
    "packages/storage/src/migration-runner.ts",
  ]);
}

function unregisteredProductionDdlPaths(oracle, sources) {
  const authority = oracle.issue234.currentTreeAuthority;
  const allowed = canonicalDdlAllowedPaths(oracle);
  return [...sources]
    .filter(
      ([path, text]) =>
        isProductionTypeScriptSource(path, authority) &&
        durableDdlStatementCount(text) > 0 &&
        !allowed.has(path),
    )
    .map(([path]) => path)
    .sort();
}

function productionSourceClassificationProjection(oracle) {
  const authority = oracle.issue234.currentTreeAuthority;
  const classification = authority.productionSourceClassification;
  const acceptedSources = acceptedTypeScriptSourceMap();
  const adjacentPaths = [...acceptedSources.keys()]
    .filter(
      (path) =>
        packageSrcTypeScriptPath(path, authority) && hasNonProductionRoleToken(path, authority),
    )
    .sort();
  exact(
    adjacentPaths,
    classification.acceptedAdjacentInventory.paths,
    "accepted adjacent source forms",
  );
  exact(
    adjacentPaths.length,
    classification.acceptedAdjacentInventory.count,
    "accepted adjacent count",
  );
  exact(
    sha256(Buffer.from(JSON.stringify(adjacentPaths))),
    classification.acceptedAdjacentInventory.sha256,
    "accepted adjacent digest",
  );
  const forms = [
    { form: ".test.ts", count: adjacentPaths.filter((path) => path.endsWith(".test.ts")).length },
    {
      form: ".fixtures.ts",
      count: adjacentPaths.filter((path) => path.endsWith(".fixtures.ts")).length,
    },
    {
      form: "-fixtures.ts",
      count: adjacentPaths.filter((path) => path.endsWith("-fixtures.ts")).length,
    },
  ];
  exact(forms, classification.acceptedAdjacentInventory.forms, "accepted adjacent form counts");

  const fixture = classification.positiveFixture;
  const acceptedFixture = readCommitted(fixture.path);
  const currentFixture = readFileSync(join(repositoryRoot, fixture.path));
  exact(sha256(acceptedFixture), fixture.acceptedSha256, "positive fixture accepted digest");
  exact(sha256(currentFixture), fixture.acceptedSha256, "positive fixture unchanged digest");
  exact(
    durableDdlStatementCount(currentFixture.toString("utf8")),
    fixture.ddlStatements,
    "positive fixture DDL statements",
  );
  exact(
    isProductionTypeScriptSource(fixture.path, authority),
    false,
    "positive fixture production classification",
  );
  exact(
    implementationAllowedPaths(oracle).has(fixture.path),
    false,
    "positive fixture mutation authority",
  );
  exact(
    canonicalDdlAllowedPaths(oracle).has(fixture.path),
    false,
    "positive fixture canonical DDL authority",
  );
  exact(
    authority.directSqlAllowedPaths.includes(fixture.path),
    false,
    "positive fixture direct SQL authority",
  );
  for (const path of [
    "packages/cli/src/example.test.ts",
    "packages/cli/src/example.spec.ts",
    "packages/cli/src/example.fixture.ts",
    "packages/cli/src/example-fixtures.ts",
    "packages/cli/src/support/example.ts",
  ]) {
    exact(isProductionTypeScriptSource(path, authority), false, "non-production role path " + path);
  }
  exact(
    isProductionTypeScriptSource("packages/cli/src/example.ts", authority),
    true,
    "ordinary production source path",
  );
  return {
    acceptedAdjacentFiles: adjacentPaths.length,
    forms,
    positiveFixture: {
      path: fixture.path,
      ddlStatements: fixture.ddlStatements,
      classification: fixture.classification,
      production: false,
      unchanged: true,
      mutationAllowed: false,
      canonicalDdlAllowed: false,
      directSqlAllowed: false,
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function resolveTypeScriptImport(fromPath, specifier, sources, oracle) {
  if (!specifier.startsWith(".")) return null;
  const base = join(dirname(fromPath), specifier).replaceAll("\\", "/");
  const candidates = [base, base + ".ts", join(base, "index.ts").replaceAll("\\", "/")];
  const authorityPaths = new Set([
    oracle.canonicalRegistry.registryPath,
    ...oracle.canonicalRegistry.migrations.map((row) => row.source),
  ]);
  return (
    candidates.find((candidate) => sources.has(candidate) || authorityPaths.has(candidate)) ?? null
  );
}

function importedAuthorityBindings(path, text, sources, oracle) {
  const migrationByPath = new Map();
  for (const migration of oracle.canonicalRegistry.migrations) {
    if (!migrationByPath.has(migration.source)) migrationByPath.set(migration.source, new Map());
    migrationByPath.get(migration.source).set(migration.export, {
      id: migration.id,
      sourceKind: migration.sourceKind ?? "migration-object",
    });
  }
  const migrations = new Set();
  const sqlConstants = new Set();
  const registries = new Set();
  const importPattern = /import\s+(?!type\b)([\s\S]*?)\s+from\s+["']([^"']+)["']/gu;
  for (const match of text.matchAll(importPattern)) {
    const clause = match[1].trim();
    const importedPath = resolveTypeScriptImport(path, match[2], sources, oracle);
    if (importedPath === null) continue;
    const semanticExports = migrationByPath.get(importedPath);
    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/u.exec(clause)?.[1];
    if (namespace !== undefined) {
      if (semanticExports !== undefined) {
        for (const [exported, authority] of semanticExports) {
          const bindings = authority.sourceKind === "sql-constant" ? sqlConstants : migrations;
          bindings.add(namespace + "." + exported);
        }
      }
      if (importedPath === oracle.canonicalRegistry.registryPath) {
        registries.add(namespace + ".canonicalDatabaseMigrations");
      }
      continue;
    }
    const braces = /\{([\s\S]*?)\}/u.exec(clause)?.[1];
    if (braces === undefined) continue;
    for (const item of braces.split(",")) {
      const binding = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/u.exec(item);
      if (binding === null) continue;
      const exported = binding[1];
      const local = binding[2] ?? exported;
      const authority = semanticExports?.get(exported);
      if (authority?.sourceKind === "sql-constant") sqlConstants.add(local);
      else if (authority !== undefined) migrations.add(local);
      if (
        importedPath === oracle.canonicalRegistry.registryPath &&
        exported === "canonicalDatabaseMigrations"
      ) {
        registries.add(local);
      }
    }
  }
  return { migrations, sqlConstants, registries };
}

function importedDirectSqlReferenceCount(path, text, sources, oracle) {
  const { migrations, sqlConstants, registries } = importedAuthorityBindings(
    path,
    text,
    sources,
    oracle,
  );
  const sqlAliases = new Set();
  const registrySelector =
    "(?:\\s*\\[\\s*\\d+\\s*\\]|\\.at\\(\\s*\\d+\\s*\\)|\\.find\\([^;\\n]*\\))\\s*!?";
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of text.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)[;\n]/gu,
    )) {
      const local = match[1];
      const expression = match[2]
        .trim()
        .replace(/^\((.*)\)$/su, "$1")
        .trim();
      if (migrations.has(expression) && !migrations.has(local)) {
        migrations.add(local);
        changed = true;
      }
      if (sqlConstants.has(expression) && !sqlConstants.has(local)) {
        sqlConstants.add(local);
        changed = true;
      }
      if (sqlAliases.has(expression) && !sqlAliases.has(local)) {
        sqlAliases.add(local);
        changed = true;
      }
      if (registries.has(expression) && !registries.has(local)) {
        registries.add(local);
        changed = true;
      }
      if (
        [...registries].some((registry) => {
          const escaped = escapeRegExp(registry);
          return new RegExp("^" + escaped + registrySelector + "$", "u").test(expression);
        }) &&
        !migrations.has(local)
      ) {
        migrations.add(local);
        changed = true;
      }
      for (const migration of migrations) {
        const escaped = escapeRegExp(migration);
        if (
          new RegExp("^" + escaped + "\\s*(?:\\.sql|\\[\\s*['\"]sql['\"]\\s*\\])$", "u").test(
            expression,
          ) &&
          !sqlAliases.has(local)
        ) {
          sqlAliases.add(local);
          changed = true;
        }
      }
    }
  }
  let count = 0;
  for (const sqlConstant of sqlConstants) {
    count += countPattern(text, new RegExp(escapeRegExp(sqlConstant), "gu"));
  }
  for (const migration of migrations) {
    count += countPattern(
      text,
      new RegExp(escapeRegExp(migration) + "\\s*(?:\\.sql|\\[\\s*['\"]sql['\"]\\s*\\])", "gu"),
    );
    count += countPattern(
      text,
      new RegExp(
        "\\{\\s*sql(?:\\s*:\\s*[A-Za-z_$][\\w$]*)?\\s*\\}\\s*=\\s*" +
          escapeRegExp(migration) +
          "\\b",
        "gu",
      ),
    );
  }
  for (const registry of registries) {
    count += countPattern(
      text,
      new RegExp(
        escapeRegExp(registry) + registrySelector + "\\s*(?:\\.sql|\\[\\s*['\"]sql['\"]\\s*\\])",
        "gu",
      ),
    );
    count += countPattern(
      text,
      new RegExp(
        "\\{\\s*sql(?:\\s*:\\s*[A-Za-z_$][\\w$]*)?\\s*\\}\\s*=\\s*" +
          escapeRegExp(registry) +
          registrySelector,
        "gu",
      ),
    );
  }
  for (const alias of sqlAliases) {
    count += countPattern(text, new RegExp("\\b" + escapeRegExp(alias) + "\\b", "gu"));
  }
  return count;
}

function sourceMutationFacts(oracle, sources) {
  const semantic = oracle.canonicalRegistry.migrations.map((row) => ({
    path: row.source,
    expectedSha256: sha256(readCommitted(row.source)),
    observedSha256: sources.has(row.source)
      ? sha256(Buffer.from(sources.get(row.source), "utf8"))
      : null,
  }));
  const acceptedSourceDigests = new Set(semantic.map((row) => row.expectedSha256));
  const duplicateSemanticFiles = [];
  const ddl = [];
  const directSql = [];
  const applyCalls = [];
  for (const [path, text] of sources) {
    const digest = sha256(Buffer.from(text, "utf8"));
    if (acceptedSourceDigests.has(digest) && !semantic.some((row) => row.path === path)) {
      duplicateSemanticFiles.push(path);
    }
    const ddlCount = countPattern(
      text,
      /\b(?:CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER)|ALTER\s+TABLE|DROP\s+TABLE)\b/giu,
    );
    if (ddlCount > 0) ddl.push([path, ddlCount]);
    const directCount = importedDirectSqlReferenceCount(path, text, sources, oracle);
    if (directCount > 0) directSql.push([path, directCount]);
    const applyCount = countPattern(text, /\bapplyMigrations\s*\(/gu);
    if (applyCount > 0) applyCalls.push([path, applyCount]);
  }
  return {
    semantic,
    duplicateSemanticFiles: duplicateSemanticFiles.sort(),
    ddl: ddl.sort((left, right) => left[0].localeCompare(right[0])),
    directSql: directSql.sort((left, right) => left[0].localeCompare(right[0])),
    applyCalls: applyCalls.sort((left, right) => left[0].localeCompare(right[0])),
  };
}

function isGeneratedImplementationPath(path) {
  return (
    path.startsWith("node_modules/") ||
    path.includes("/node_modules/") ||
    path.startsWith("dist/") ||
    path.includes("/dist/") ||
    path.startsWith("__pycache__/") ||
    path.includes("/__pycache__/") ||
    path.endsWith(".pyc")
  );
}

function acceptedCompositionCorpusPaths() {
  return git(["grep", "-l", "-F", "applyMigrations(", ACCEPTED_HEAD, "--", "*.ts"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(ACCEPTED_HEAD.length + 1));
}

function implementationPathUnion(oracle, semanticPaths) {
  return new Set([
    ...oracle.issue234.productionPaths,
    ...oracle.issue234.testPaths,
    ...oracle.issue234.executionRootPaths,
    ...acceptedCompositionCorpusPaths(),
    ...semanticPaths,
    ...oracle.canonicalRegistry.migrations.flatMap((row) =>
      row.registrySource === undefined ? [] : [row.registrySource],
    ),
  ]);
}

function implementationAllowedPaths(oracle) {
  return implementationPathUnion(oracle, oracle.issue234.currentTreeAuthority.semanticAllowedPaths);
}

function expectedImplementationAllowedPaths(oracle) {
  return implementationPathUnion(
    oracle,
    oracle.canonicalRegistry.migrations.map((row) => row.source),
  );
}

function assertImplementationScope(authority, allowed, records) {
  for (const record of records) {
    const path = record.path.replaceAll("\\", "/");
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("unsafe current-tree path: " + path);
    }
    if (isGeneratedImplementationPath(path)) continue;
    if (
      authority.protectedPaths.includes(path) ||
      authority.protectedPrefixes.some((prefix) => path.startsWith(prefix))
    ) {
      throw new Error("implementation changed protected path: " + path);
    }
    const untrackedRelevant =
      record.status === "?" &&
      path.endsWith(".ts") &&
      (path.startsWith("packages/") || path.startsWith("scripts/") || path.includes("/test/"));
    if (!allowed.has(path) && (record.status !== "?" || untrackedRelevant)) {
      throw new Error("implementation changed unknown path: " + path);
    }
  }
}

function semanticImportFixture(oracle, migrationIndex, options = {}) {
  const path = "packages/storage/src/forged-direct-sql.ts";
  const migration = oracle.canonicalRegistry.migrations[migrationIndex];
  const specifier = "./" + relative(dirname(path), migration.source).replaceAll("\\", "/");
  const imported = options.importAlias ?? migration.export;
  const importBinding =
    imported === migration.export ? migration.export : migration.export + " as " + imported;
  return {
    path,
    text:
      `import { ${importBinding} } from "${specifier}";\n` +
      (options.body ?? `database.exec(${imported}.sql);\n`),
  };
}

function parseNamedModuleBindings(clause) {
  const braces = /\{([\s\S]*?)\}/u.exec(clause)?.[1];
  if (braces === undefined) return [];
  return braces
    .split(",")
    .map((item) => item.trim().replace(/^type\s+/u, ""))
    .filter(Boolean)
    .map((item) => {
      const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(item);
      return match === null ? null : { imported: match[1], local: match[2] ?? match[1] };
    })
    .filter((item) => item !== null);
}

function maskTypeScriptComments(text) {
  let result = "";
  let state = "code";
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (state === "line-comment") {
      if (current === "\n" || current === "\r") {
        state = "code";
        result += current;
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" || current === "\r" ? current : " ";
      }
      continue;
    }
    if (state !== "code") {
      result += current;
      if (current === "\\") {
        if (next !== undefined) {
          result += next;
          index += 1;
        }
      } else if (
        (state === "single-quote" && current === "'") ||
        (state === "double-quote" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      continue;
    }
    if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else {
      result += current;
      if (current === "'") state = "single-quote";
      else if (current === '"') state = "double-quote";
      else if (current === "`") state = "template";
    }
  }
  return result;
}

function maskNonExecutableTypeScriptText(text) {
  const result = [];
  const frames = [{ kind: "code" }];
  let literal = null;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    const frame = frames.at(-1);
    const masked = current === "\n" || current === "\r" ? current : " ";
    if (literal === "line-comment") {
      result.push(masked);
      if (current === "\n" || current === "\r") literal = null;
      continue;
    }
    if (literal === "block-comment") {
      result.push(masked);
      if (current === "*" && next === "/") {
        result.push(" ");
        index += 1;
        literal = null;
      }
      continue;
    }
    if (literal === "single-quote" || literal === "double-quote") {
      result.push(masked);
      if (current === "\\" && next !== undefined) {
        result.push(next === "\n" || next === "\r" ? next : " ");
        index += 1;
      } else if (
        (literal === "single-quote" && current === "'") ||
        (literal === "double-quote" && current === '"')
      ) {
        literal = null;
      }
      continue;
    }
    if (frame.kind === "template") {
      result.push(masked);
      if (current === "\\" && next !== undefined) {
        result.push(next === "\n" || next === "\r" ? next : " ");
        index += 1;
      } else if (current === "`") {
        frames.pop();
      } else if (current === "$" && next === "{") {
        result.push(" ");
        index += 1;
        frames.push({ kind: "template-expression", depth: 1 });
      }
      continue;
    }
    if (current === "/" && next === "/") {
      result.push(" ", " ");
      index += 1;
      literal = "line-comment";
      continue;
    }
    if (current === "/" && next === "*") {
      result.push(" ", " ");
      index += 1;
      literal = "block-comment";
      continue;
    }
    if (current === "'") {
      result.push(" ");
      literal = "single-quote";
      continue;
    }
    if (current === '"') {
      result.push(" ");
      literal = "double-quote";
      continue;
    }
    if (current === "`") {
      result.push(" ");
      frames.push({ kind: "template" });
      continue;
    }
    if (frame.kind === "template-expression") {
      if (current === "{") frame.depth += 1;
      if (current === "}") {
        frame.depth -= 1;
        if (frame.depth === 0) {
          result.push(" ");
          frames.pop();
          continue;
        }
      }
    }
    result.push(current);
  }
  return result.join("");
}

function parseTypeScriptModuleEdges(text) {
  const source = maskTypeScriptComments(text);
  const edges = [];
  const pattern =
    /(?:^|[;\r\n])[\t ]*(import|export)\s+(?:type\s+)?(\*\s*(?:as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\}))?)\s+from\s+(["'])([^"'\r\n]+)\3\s*;?/gmu;
  for (const match of source.matchAll(pattern)) {
    const direction = match[1];
    const clause = match[2].trim().replace(/^type\s+/u, "");
    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/u.exec(clause)?.[1] ?? null;
    edges.push({
      direction,
      clause,
      specifier: match[4],
      typeOnly: /\b(?:import|export)\s+type\s/u.test(match[0]),
      exportAll: direction === "export" && clause === "*",
      namespace,
      named: parseNamedModuleBindings(clause),
    });
  }
  return edges;
}

function scannedTypeScriptModuleSpecifiers(text) {
  try {
    return new Bun.Transpiler({ loader: "ts" }).scan(text).imports;
  } catch {
    return null;
  }
}

function functionValuedBindings(executable) {
  const bindings = new Set();
  for (const pattern of [
    /\b(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gu,
    /\bclass\s+([A-Za-z_$][\w$]*)/gu,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/gu,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^;=\r\n]*\)|[A-Za-z_$][\w$]*)\s*=>/gu,
  ]) {
    for (const match of executable.matchAll(pattern)) bindings.add(match[1]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of executable.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*;/gu,
    )) {
      if (bindings.has(match[2]) && !bindings.has(match[1])) {
        bindings.add(match[1]);
        changed = true;
      }
    }
  }
  return bindings;
}

function dynamicCodeCapabilityIsAbsent(text, checkFunctionBindings = true) {
  const executable = maskNonExecutableTypeScriptText(text);
  if (/\bimport\s*\(/u.test(executable)) return false;
  if (
    /\b(?:require|createRequire|getBuiltinModule|eval|Function|AsyncFunction|GeneratorFunction|AsyncGeneratorFunction|getOwnPropertyDescriptor|getOwnPropertyDescriptors|setPrototypeOf|__proto__)\b/u.test(
      executable,
    )
  ) {
    return false;
  }
  if (
    /\bReflect\s*\[/u.test(executable) ||
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*Reflect\b(?!\s*[.[])/u.test(executable)
  ) {
    return false;
  }
  if (/\bReflect\s*\.\s*get\s*\(\s*(?:globalThis|global|window|self)\b/u.test(executable)) {
    return false;
  }
  if (/\b(?:globalThis|global|window|self)\b/u.test(executable)) {
    return false;
  }
  if (/\bprocess\s*(?:\.\s*getBuiltinModule\b|\[)/u.test(executable)) {
    return false;
  }
  if (/\b(?:module|exports)\s*(?:\.|\[|\()/u.test(executable)) {
    return false;
  }
  if (/\bimport\s*\.\s*meta\s*(?:\[|\.\s*require\b)/u.test(executable)) {
    return false;
  }
  if (
    /\bBun\s*(?:\[|\.\s*resolve(?:Sync)?\b)/u.test(executable) ||
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*Bun\b(?!\s*[.[])/u.test(executable)
  ) {
    return false;
  }
  if (/\.\s*constructor\b/u.test(executable)) {
    return false;
  }
  for (const match of executable.matchAll(/\bconstructor\b/gu)) {
    const suffix = executable.slice(match.index + match[0].length).trimStart();
    if (!suffix.startsWith("(")) {
      return false;
    }
  }
  if (checkFunctionBindings) {
    for (const binding of functionValuedBindings(executable)) {
      if (new RegExp("\\b" + escapeRegExp(binding) + "\\s*\\[", "u").test(executable)) {
        return false;
      }
    }
    if (
      /\(\s*(?:async\s*\([^)]*\)\s*=>\s*\{[^{}]*\}|function\s*\*?\s*\([^)]*\)\s*\{[^{}]*\})\s*\)\s*\[/u.test(
        executable,
      )
    ) {
      return false;
    }
  }
  return true;
}

function transpiledTypeScriptModuleSyntax(text) {
  try {
    return new Bun.Transpiler({ loader: "ts" }).transformSync(text);
  } catch {
    return null;
  }
}

function resolveTypeScriptModulePath(sources, fromPath, specifier) {
  if (!specifier.startsWith(".")) return false;
  const resolved = relative(
    repositoryRoot,
    resolve(repositoryRoot, dirname(fromPath), specifier),
  ).replaceAll("\\", "/");
  for (const candidate of [resolved, resolved + ".ts", resolved + "/index.ts"]) {
    if (sources.has(candidate)) return candidate;
  }
  return null;
}

function resolvesToMigrationRunner(sources, fromPath, specifier) {
  return (
    resolveTypeScriptModulePath(sources, fromPath, specifier) ===
    "packages/storage/src/migration-runner.ts"
  );
}

function recorderCallFollowsCompleteVerification(text, recorder) {
  const executable = maskNonExecutableTypeScriptText(text);
  const applyCall = executable.indexOf("applyMigrations(db");
  const installCall = executable.indexOf("installMigrationConversionInfrastructure(db");
  const verifyCall = executable.indexOf("verifyCanonicalMigrationState(db");
  const integrityCall = executable.indexOf("verifyIntegrity(db");
  const recordCall = executable.indexOf(recorder + "(db");
  return (
    applyCall >= 0 &&
    installCall > applyCall &&
    verifyCall > installCall &&
    integrityCall > verifyCall &&
    recordCall > integrityCall
  );
}

function privilegedRecorderUseIsExact(path, text, recorder) {
  const executable = maskNonExecutableTypeScriptText(text);
  const occurrences = [
    ...executable.matchAll(new RegExp("\\b" + escapeRegExp(recorder) + "\\b", "gu")),
  ].length;
  if (path === "packages/storage/src/migration-runner.ts") {
    const definitions = [
      ...executable.matchAll(
        new RegExp("\\bexport\\s+function\\s+" + escapeRegExp(recorder) + "\\s*\\(", "gu"),
      ),
    ].length;
    return occurrences === 1 && definitions === 1;
  }
  if (path === "packages/storage/src/database.ts") {
    const directCalls = [
      ...executable.matchAll(
        new RegExp("\\b" + escapeRegExp(recorder) + "\\s*\\(\\s*db\\s*\\)", "gu"),
      ),
    ].length;
    return (
      occurrences === 2 &&
      directCalls === 1 &&
      recorderCallFollowsCompleteVerification(text, recorder)
    );
  }
  return occurrences === 0;
}

function migrationRunnerModuleBoundaryAudit(sources, allowlist) {
  const recorder = "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures";
  const indexPath = "packages/storage/src/index.ts";
  const exported = [];
  let invalidShape = false;
  const indexSource = sources.get(indexPath);
  if (indexSource === undefined || transpiledTypeScriptModuleSyntax(indexSource) === null) {
    invalidShape = true;
  } else {
    const runnerExports = parseTypeScriptModuleEdges(indexSource).filter(
      (edge) =>
        edge.direction === "export" &&
        resolvesToMigrationRunner(sources, indexPath, edge.specifier),
    );
    if (runnerExports.length !== 1) invalidShape = true;
    for (const edge of runnerExports) {
      if (
        edge.specifier !== "./migration-runner" ||
        edge.exportAll ||
        edge.namespace !== null ||
        edge.named.length === 0
      ) {
        invalidShape = true;
      }
      for (const binding of edge.named) {
        exported.push(binding.local);
        if (binding.imported !== binding.local || binding.imported === recorder) {
          invalidShape = true;
        }
      }
    }
  }
  if (new Set(exported).size !== exported.length) invalidShape = true;
  if (stable([...new Set(exported)].sort()) !== stable([...allowlist].sort())) invalidShape = true;
  return {
    boundaryViolations: invalidShape ? ["legacy-fixture-package-boundary-bypass"] : [],
    unauthorizedPaths: [],
  };
}

function unauthorizedCompatibilityRecorderPaths(sources, oracle) {
  return migrationRunnerModuleBoundaryAudit(
    sources,
    oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
  ).unauthorizedPaths;
}

function compatibilityMutationBaseline(oracle) {
  const namedExports =
    oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist
      .map((name) =>
        [
          "ApplyMigrationsOptions",
          "BeforePendingMigration",
          "Migration",
          "MigrationRunnerErrorCode",
        ].includes(name)
          ? "type " + name
          : name,
      )
      .join(", ");
  return {
    runner: [
      "import { createHash } from 'node:crypto';",
      "const canonicalDatabaseMigrations = [{ version: 1, name: 'canonical', contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }];",
      "const verifiedCanonicalDatabases = new WeakMap();",
      "const expectedSchema = [",
      "  { type: 'index', name: 'action_plans_state_idx', tbl_name: 'schema_migrations', sql: 'CREATE INDEX action_plans_state_idx ON schema_migrations(name)' },",
      "  { type: 'table', name: 'schema_migrations', tbl_name: 'schema_migrations', sql: 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, content_hash TEXT NOT NULL) STRICT' },",
      "  { type: 'table', name: 'search_reindex_lease', tbl_name: 'search_reindex_lease', sql: 'CREATE TABLE search_reindex_lease (lease_id INTEGER PRIMARY KEY, operation_name TEXT NOT NULL, replacement_name TEXT NOT NULL, phase TEXT NOT NULL, last_rowid INTEGER NOT NULL, processed_rows INTEGER NOT NULL) STRICT' },",
      "  { type: 'table', name: 'search_reindex_progress', tbl_name: 'search_reindex_progress', sql: 'CREATE TABLE search_reindex_progress (replacement_name TEXT NOT NULL, source_rowid INTEGER NOT NULL, source_digest TEXT NOT NULL, PRIMARY KEY (replacement_name, source_rowid)) STRICT' },",
      "];",
      "function schemaRows(database) { return database.query(\"SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name, sql\").all(); }",
      "function verifyExactCurrentTipHistory(database, currentTip, registry) { const version = database.query('PRAGMA user_version').get()?.user_version; const history = database.query('SELECT version, name, content_hash FROM schema_migrations ORDER BY version').all(); const expected = registry.map((migration) => ({ version: migration.version, name: migration.name, content_hash: migration.contentHash })); if (version !== currentTip || JSON.stringify(history) !== JSON.stringify(expected)) throw new MigrationRunnerError(); }",
      "function verifyExactCurrentTipSchema(database) { const actual = schemaRows(database); if (JSON.stringify(actual) !== JSON.stringify(expectedSchema)) throw new MigrationRunnerError(); }",
      "function verifyImmutableConversionRows(database) { const conversionObjects = schemaRows(database).filter((row) => row.name.startsWith('schema_migration_conversions')); if (conversionObjects.length !== 0) throw new MigrationRunnerError(); }",
      "function verifyReindexOverlay(database) { const lease = database.query('SELECT lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows FROM search_reindex_lease ORDER BY lease_id').all(); const progress = database.query('SELECT replacement_name, source_rowid, source_digest FROM search_reindex_progress ORDER BY replacement_name, source_rowid').all(); if (progress.length !== 0 || lease.length > 1) throw new MigrationRunnerError(); if (lease.length === 0) return; const row = lease[0]; const derived = 'message_fts_replacement_' + createHash('sha256').update(row.operation_name).digest('hex').slice(0, 16); if (row.lease_id !== 1 || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(row.operation_name) || row.replacement_name !== derived || row.phase !== 'building' || row.last_rowid !== 0 || row.processed_rows !== 0) throw new MigrationRunnerError(); }",
      "function compatibilityAuthorityFingerprint(database) { const userVersion = database.query('PRAGMA user_version').get(); const sqliteSchema = schemaRows(database); const history = database.query('SELECT version,name,content_hash FROM schema_migrations ORDER BY version').all(); const conversions = []; const lease = database.query('SELECT * FROM search_reindex_lease ORDER BY lease_id').all(); const progress = database.query('SELECT * FROM search_reindex_progress ORDER BY replacement_name,source_rowid').all(); return createHash('sha256').update(JSON.stringify([userVersion, history, sqliteSchema, conversions, lease, progress])).digest('hex'); }",
      "function verifyCompleteCurrentTipAuthority(database) { const currentTip = canonicalDatabaseMigrations.length; verifyExactCurrentTipHistory(database, currentTip, canonicalDatabaseMigrations); verifyExactCurrentTipSchema(database, canonicalDatabaseMigrations); verifyImmutableConversionRows(database); verifyReindexOverlay(database); return compatibilityAuthorityFingerprint(database); }",
      "export function recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database) { const verifiedFingerprint = verifyCompleteCurrentTipAuthority(database); verifiedCanonicalDatabases.set(database, verifiedFingerprint); }",
      "export function runMigrations(database, migrations) { const authorityFingerprint = verifiedCanonicalDatabases.get(database); if (authorityFingerprint !== undefined) { const currentFingerprint = verifyCompleteCurrentTipAuthority(database); if (authorityFingerprint !== currentFingerprint) throw new MigrationRunnerError(); return; } applyMigrations(database, migrations); }",
      "function getDatabase(connection) { return connection; }",
      "export function applyMigrations(database, migrations) { const supplied = migrations.map((migration) => [migration.version, migration.name]); const expected = canonicalDatabaseMigrations.map((migration) => [migration.version, migration.name]); if (JSON.stringify(supplied) !== JSON.stringify(expected)) throw new MigrationRunnerError(); verifyCompleteCurrentTipAuthority(database); }",
      "function hardenFileBackedDatabase(database) { return database; }",
      "export class MigrationRunnerError extends Error {} export function migrationContentHash() { return ''; }",
    ].join("\n"),
    opener:
      'import { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures } from "./migration-runner";\n' +
      "applyMigrations(db); installMigrationConversionInfrastructure(db); verifyCanonicalMigrationState(db); verifyIntegrity(db); recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db);",
    index: `export { ${namedExports} } from "./migration-runner";`,
    modules: new Map(),
  };
}

function assertMigrationRunnerModuleBoundaryProjection(oracle) {
  const baseline = compatibilityMutationBaseline(oracle);
  const sources = new Map(baseline.modules);
  sources.set("packages/storage/src/migration-runner.ts", baseline.runner);
  sources.set(
    "packages/storage/src/database.ts",
    baseline.opener +
      "\n/* recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures is package-private. */\n" +
      'const recorderStringControl = "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures";\n' +
      "const recorderTemplateControl = `recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures`;\n" +
      'const recorderComputedControl = { ["recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures"]: true };\n',
  );
  sources.set("packages/storage/src/index.ts", baseline.index);
  exact(
    migrationRunnerModuleBoundaryAudit(
      sources,
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
    ),
    { boundaryViolations: [], unauthorizedPaths: [] },
    "migration runner valid package closure",
  );
  sources.set(
    "packages/storage/src/commented-boundary-fixture.ts",
    "/*\nexport * from './migration-runner.ts';\n*/\n" +
      "// import * as migrationRunner from './migration-runner';\n" +
      "// require('./migration-runner');\n" +
      "/* import.meta.require('./migration-runner'); */\n" +
      'const stringControl = "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures";\n' +
      'const evalStringControl = "eval(\\\"dynamic payload\\\")";\n' +
      'const functionStringControl = "Function(\\\"dynamic payload\\\")";\n' +
      "const templateControl = `recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures`;\n" +
      "const dynamicImportTemplateControl = `import('./migration-runner')`;\n" +
      "const computedLoaderTemplateControl = `globalThis['ev' + 'al']`;\n" +
      "const nestedTemplateControl = `safe ${stringControl}`;\n" +
      "export const ordinaryValue = 1;\n",
  );
  exact(
    migrationRunnerModuleBoundaryAudit(
      sources,
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
    ),
    { boundaryViolations: [], unauthorizedPaths: [] },
    "migration runner comments strings and template text are non-executable controls",
  );
  const executableTemplateSources = new Map(sources);
  executableTemplateSources.set(
    "packages/storage/src/template-expression-leak.ts",
    "const leakedRecorder = `${recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures}`;\n",
  );
  exact(
    migrationRunnerModuleBoundaryAudit(
      executableTemplateSources,
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
    ).boundaryViolations,
    ["legacy-fixture-package-boundary-bypass"],
    "migration runner executable template expression rejects",
  );
  const constructorCapabilitySources = new Map(sources);
  constructorCapabilitySources.set(
    "packages/storage/src/constructor-capability-leak.ts",
    'const DynamicFunction = (() => undefined).constructor;\nDynamicFunction("return 1")();\n',
  );
  exact(
    migrationRunnerModuleBoundaryAudit(
      constructorCapabilitySources,
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
    ).boundaryViolations,
    ["legacy-fixture-package-boundary-bypass"],
    "migration runner constructor capability rejects",
  );
  const reviewerCapabilityCases = new Map(REVIEWER_CAPABILITY_MUTATION_SOURCES);
  const adjacentCapabilityCases = new Map([
    ["process-get-builtin-module", 'process.getBuiltinModule("module");\n'],
    [
      "async-generator-variable-constructor",
      'const constructorName = "constructor"; const AsyncGeneratorFunction = (async function* () {})[constructorName];\n',
    ],
    ["indirect-eval", '(0, eval)("void 0");\n'],
    [
      "variable-reflect-get-key",
      'const getterName = "get"; Reflect[getterName](globalThis, "Function");\n',
    ],
    [
      "descriptor-map",
      "Object.getOwnPropertyDescriptors(Object.getPrototypeOf(async () => {}));\n",
    ],
  ]);
  for (const [id, source] of [...reviewerCapabilityCases, ...adjacentCapabilityCases]) {
    if (transpiledTypeScriptModuleSyntax(source) === null) {
      fail("pinned Bun rejected capability mutation syntax: " + id);
    }
    const capabilitySources = new Map(sources);
    capabilitySources.set("packages/storage/src/capability-" + id + ".ts", source);
    exact(
      migrationRunnerModuleBoundaryAudit(
        capabilitySources,
        oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
      ).boundaryViolations,
      ["legacy-fixture-package-boundary-bypass"],
      "migration runner capability rejects " + id,
    );
  }
}

function migrationRunnerPackageBoundaryProjection(oracle) {
  const baseline = compatibilityMutationBaseline(oracle);
  const sources = new Map(
    [...acceptedTypeScriptSourceMap()].filter(([path]) => path.startsWith("packages/storage/src/")),
  );
  sources.set("packages/storage/src/migration-runner.ts", baseline.runner);
  sources.set("packages/storage/src/database.ts", baseline.opener);
  sources.set("packages/storage/src/index.ts", baseline.index);
  exact(
    migrationRunnerModuleBoundaryAudit(
      sources,
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
    ),
    { boundaryViolations: [], unauthorizedPaths: [] },
    "accepted storage graph with canonical package boundary",
  );
  return {
    storageModules: sources.size,
    namedExports: oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
    publicSurfacePolicy: "defense-in-depth",
    recorderEffectAuthority: "synchronous-complete-current-tip-verification",
  };
}

function weakConstantFingerprintMutationSource(oracle) {
  return compatibilityMutationBaseline(oracle).runner.replace(
    "return createHash('sha256').update(JSON.stringify([userVersion, history, sqliteSchema, conversions, lease, progress])).digest('hex');",
    "void userVersion; void history; void sqliteSchema; void conversions; void lease; void progress; return createHash('sha256').update('constant-authority').digest('hex');",
  );
}

function countOnlySchemaMutationSource(oracle) {
  return compatibilityMutationBaseline(oracle).runner.replace(
    /function verifyExactCurrentTipSchema\(database\) \{[\s\S]*?\nfunction verifyImmutableConversionRows/u,
    "function verifyExactCurrentTipSchema(database) { const actual = schemaRows(database); if (actual.length !== expectedSchema.length) throw new MigrationRunnerError(); }\nfunction verifyImmutableConversionRows",
  );
}

function failureStoresExpectedFingerprintMutationSource(oracle) {
  return compatibilityMutationBaseline(oracle).runner.replace(
    "export function recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database) { const verifiedFingerprint = verifyCompleteCurrentTipAuthority(database); verifiedCanonicalDatabases.set(database, verifiedFingerprint); }",
    "function expectedCanonicalAuthorityFingerprint(database) { const userVersion = database.query('PRAGMA user_version').get(); const history = database.query('SELECT version,name,content_hash FROM schema_migrations ORDER BY version').all(); const conversions = []; const lease = database.query('SELECT * FROM search_reindex_lease ORDER BY lease_id').all(); const progress = database.query('SELECT * FROM search_reindex_progress ORDER BY replacement_name,source_rowid').all(); return createHash('sha256').update(JSON.stringify([userVersion, history, expectedSchema, conversions, lease, progress])).digest('hex'); }\n" +
      "export function recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database) { try { const verifiedFingerprint = verifyCompleteCurrentTipAuthority(database); verifiedCanonicalDatabases.set(database, verifiedFingerprint); } catch (error) { verifyExactCurrentTipHistory(database, canonicalDatabaseMigrations.length, canonicalDatabaseMigrations); verifiedCanonicalDatabases.set(database, expectedCanonicalAuthorityFingerprint(database)); throw error; } }",
  );
}

function verifyAfterSetMutationSource(oracle) {
  return compatibilityMutationBaseline(oracle).runner.replace(
    "const verifiedFingerprint = verifyCompleteCurrentTipAuthority(database); verifiedCanonicalDatabases.set(database, verifiedFingerprint);",
    "verifiedCanonicalDatabases.set(database, 'premature-authority'); verifyCompleteCurrentTipAuthority(database);",
  );
}

const REVIEWER_CAPABILITY_MUTATION_SOURCES = new Map([
  [
    "variable-import-and-recorder-name",
    'const modulePath = "./migration-runner";\n' +
      'const recorderName = "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures";\n' +
      "const runner = await import(modulePath);\nrunner[recorderName](database);\n",
  ],
  [
    "concatenated-variable-import-and-name",
    'const modulePrefix = "./migration-"; const moduleSuffix = "runner";\n' +
      'const recorderPrefix = "recordVerifiedCanonicalApplicationDatabase"; const recorderSuffix = "ForLegacyFixtures";\n' +
      "const runner = await import(modulePrefix + moduleSuffix);\n" +
      "runner[recorderPrefix + recorderSuffix](database);\n",
  ],
  [
    "node-module-create-require-named",
    'const { createRequire } = await import("node:module");\n' +
      "const load = createRequire(import.meta.url);\n" +
      'const runner = load("./migration-runner");\n' +
      "runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);\n",
  ],
  [
    "node-module-create-require-namespace",
    'const moduleApi = await import("node:module");\n' +
      "const load = moduleApi.createRequire(import.meta.url);\n" +
      'const runner = load("./migration-runner");\n' +
      "runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);\n",
  ],
  [
    "computed-import-meta-require",
    'const loaderName = "require";\n' +
      'const runner = import.meta[loaderName]("./migration-runner");\n' +
      "runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);\n",
  ],
  [
    "computed-global-eval",
    'const evaluatorName = "eval"; const evaluate = globalThis[evaluatorName];\n' +
      'evaluate("import(\\"./migration-runner\\").then((runner) => runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database))");\n',
  ],
  [
    "reflect-function-constructor",
    'const DynamicFunction = Reflect.get(globalThis, "Function");\n' +
      'DynamicFunction("return import(\\"./migration-runner\\").then((runner) => runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database))")();\n',
  ],
  [
    "async-function-variable-constructor",
    'const constructorName = "constructor";\n' +
      "const AsyncFunction = (async () => {})[constructorName];\n" +
      'AsyncFunction("return import(\\"./migration-runner\\").then((runner) => runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database))")();\n',
  ],
  [
    "generator-function-variable-constructor",
    'const constructorName = "constructor";\n' +
      "const GeneratorFunction = (function* () {})[constructorName];\n" +
      'GeneratorFunction("return import(\\"./migration-runner\\").then((runner) => runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database))")();\n',
  ],
  [
    "bun-resolve-sync-variable-import",
    'const resolved = Bun.resolveSync("./migration-runner", import.meta.dir);\n' +
      "const runner = await import(resolved);\n" +
      "runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);\n",
  ],
  [
    "descriptor-global-eval",
    'Object.getOwnPropertyDescriptor(globalThis, "eval").value("import(\\"./migration-runner\\").then((runner) => runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database))");\n',
  ],
  [
    "descriptor-async-constructor",
    "const asyncPrototype = Object.getPrototypeOf(async () => {});\n" +
      'Object.getOwnPropertyDescriptor(asyncPrototype, "constructor").value("return import(\\"./migration-runner\\").then((runner) => runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database))")();\n',
  ],
]);

function runSourceMutationChild(oracle, id) {
  const accepted = acceptedTypeScriptSourceMap();
  const baseline = sourceMutationFacts(oracle, accepted);
  const candidate = new Map(accepted);
  const firstSource = oracle.canonicalRegistry.migrations[0].source;
  let scopeMutation = null;
  let sequenceMutation = null;
  let compatibilityMutation = null;
  if (id === "remove-semantic-source") {
    candidate.delete(firstSource);
  } else if (id === "duplicate-semantic-source") {
    candidate.set(
      "packages/storage/src/migrations/forged-duplicate.ts",
      candidate.get(firstSource),
    );
  } else if (id === "change-semantic-sql") {
    candidate.set(firstSource, candidate.get(firstSource).replace("CREATE TABLE", "CREATE  TABLE"));
  } else if (id === "new-durable-ddl") {
    candidate.set(
      "packages/storage/src/forged-durable-ddl.ts",
      "export const forged = `CREATE TABLE forged_durable_state (id INTEGER PRIMARY KEY)`;\n",
    );
  } else if (id === "new-direct-semantic-sql") {
    const fixture = semanticImportFixture(oracle, 1);
    candidate.set(fixture.path, fixture.text);
  } else if (id === "new-apply-migrations-bypass") {
    candidate.set(
      "scripts/capacity/forged-bypass.ts",
      "applyMigrations(database, callerSelectedMigrations);\n",
    );
  } else if (id === "protected-deletion") {
    scopeMutation = parseGitChangeRecords("D\0docs/architecture/report-creation-check.v1.mjs\0");
  } else if (id === "unknown-deletion") {
    scopeMutation = parseGitChangeRecords("D\0README.md\0");
  } else if (id === "rename-endpoints") {
    scopeMutation = parseGitChangeRecords(
      "R100\0" + firstSource + "\0packages/storage/src/renamed-outside-scope.ts\0",
    );
  } else if (id === "third-migration-direct-sql") {
    const fixture = semanticImportFixture(oracle, 2);
    candidate.set(fixture.path, fixture.text);
  } else if (id === "registry-index-direct-sql") {
    candidate.set(
      "packages/storage/src/forged-direct-sql.ts",
      'import { canonicalDatabaseMigrations } from "./migration-registry.ts";\n' +
        "database.exec(canonicalDatabaseMigrations[2].sql);\n",
    );
  } else if (id === "alias-direct-sql") {
    const fixture = semanticImportFixture(oracle, 2, {
      importAlias: "sm",
      body: "const migrationAlias = sm;\nconst { sql: ddl } = migrationAlias;\ndatabase.exec(ddl);\n",
    });
    candidate.set(fixture.path, fixture.text);
  } else if (id === "slot20-sql-constant-alias") {
    const fixture = semanticImportFixture(oracle, 19, {
      importAlias: "schemaSql",
      body: "const schemaAlias = schemaSql;\ndatabase.exec(schemaAlias);\n",
    });
    candidate.set(fixture.path, fixture.text);
  } else if (id === "registry-bracket-destructure") {
    candidate.set(
      "packages/storage/src/forged-direct-sql.ts",
      'import { canonicalDatabaseMigrations } from "./migration-registry.ts";\n' +
        "const { sql: ddl } = canonicalDatabaseMigrations[2];\ndatabase.exec(ddl);\n",
    );
  } else if (id === "registry-at-destructure") {
    candidate.set(
      "packages/storage/src/forged-direct-sql.ts",
      'import { canonicalDatabaseMigrations } from "./migration-registry.ts";\n' +
        "const { sql: ddl } = canonicalDatabaseMigrations.at(2)!;\ndatabase.exec(ddl);\n",
    );
  } else if (id === "registry-find-destructure") {
    candidate.set(
      "packages/storage/src/forged-direct-sql.ts",
      'import { canonicalDatabaseMigrations } from "./migration-registry.ts";\n' +
        "const { sql: ddl } = canonicalDatabaseMigrations.find((migration) => migration.version === 3)!;\n" +
        "database.exec(ddl);\n",
    );
  } else if (id === "unknown-source") {
    scopeMutation = parseGitChangeRecords("A\0packages/storage/src/unrelated-helper.ts\0");
  } else if (id === "unknown-test") {
    scopeMutation = parseGitChangeRecords("?\0packages/storage/test/unrelated-helper.test.ts\0");
  } else if (id === "converter-live-tip-loop") {
    sequenceMutation = {
      converter:
        "const target = acceptedHistoricalTargets[0];\n" +
        "const targetMigrations = canonicalDatabaseMigrations;\n" +
        "for (const migration of targetMigrations) database.exec(migration.sql);\n",
      opener:
        "if (legacy) { convertMigrationHistory(db); }\n" +
        "applyMigrations(db, canonicalDatabaseMigrations, { beforePendingMigration });\n",
    };
  } else if (id === "legacy-opener-skips-suffix-runner") {
    sequenceMutation = {
      converter:
        "const target = acceptedHistoricalTargets[0];\n" +
        "const targetMigrations = canonicalDatabaseMigrations.slice(0, target.targetVersion);\n" +
        "for (const migration of targetMigrations) database.exec(migration.sql);\n",
      opener:
        "if (legacy) { convertMigrationHistory(db); } else {\n" +
        "applyMigrations(db, canonicalDatabaseMigrations, { beforePendingMigration });\n}\n",
    };
  } else if (id === "legacy-fixture-literal-tip") {
    compatibilityMutation = {
      runner:
        "const verifiedCanonicalDatabases = new WeakMap();\n" +
        "export function runMigrations(database, migrations) { if (readUserVersion(database) === 27) return; applyMigrations(database, migrations); }\n",
      opener:
        "applyMigrations(db); installMigrationConversionInfrastructure(db); verifyCanonicalMigrationState(db); verifyIntegrity(db); recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db);",
      index: 'export { runMigrations } from "./migration-runner";',
    };
  } else if (id === "legacy-fixture-caller-ceiling") {
    compatibilityMutation = {
      runner:
        "const verifiedCanonicalDatabases = new WeakMap();\n" +
        "export function runMigrations(database, migrations) { if (readUserVersion(database) > migrations.length) return; applyMigrations(database, migrations); }\n",
      opener:
        "applyMigrations(db); installMigrationConversionInfrastructure(db); verifyCanonicalMigrationState(db); verifyIntegrity(db); recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db);",
      index: 'export { runMigrations } from "./migration-runner";',
    };
  } else if (id === "legacy-fixture-premature-record") {
    compatibilityMutation = {
      runner:
        "import { canonicalDatabaseMigrations } from './migration-registry'; const verifiedCanonicalDatabases = new WeakMap(); const fingerprint = 'sqlite_schema schema_migration_conversions search_reindex_operations'; export function recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures() {} export function runMigrations(database, migrations) { const authorityFingerprint = verifiedCanonicalDatabases.get(database); if (authorityFingerprint !== fingerprint) throw new MigrationRunnerError(); return; }",
      opener:
        "applyMigrations(db); recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db); installMigrationConversionInfrastructure(db); verifyCanonicalMigrationState(db); verifyIntegrity(db);",
      index: 'export { runMigrations } from "./migration-runner";',
    };
  } else if (id === "legacy-fixture-fingerprint-bypass") {
    compatibilityMutation = {
      runner:
        "import { canonicalDatabaseMigrations } from './migration-registry'; const verifiedCanonicalDatabases = new WeakMap(); const fingerprint = 'sqlite_schema schema_migration_conversions search_reindex_operations'; export function recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures() {} export function runMigrations(database, migrations) { if (verifiedCanonicalDatabases.get(database)) return; applyMigrations(database, migrations); }",
      opener:
        "applyMigrations(db); installMigrationConversionInfrastructure(db); verifyCanonicalMigrationState(db); verifyIntegrity(db); recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db);",
      index: 'export { runMigrations } from "./migration-runner";',
    };
  } else if (id === "legacy-fixture-constant-fingerprint") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.runner = weakConstantFingerprintMutationSource(oracle);
  } else if (id === "legacy-fixture-count-only-schema") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.runner = countOnlySchemaMutationSource(oracle);
  } else if (id === "legacy-fixture-failure-stores-expected-fingerprint") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.runner = failureStoresExpectedFingerprintMutationSource(oracle);
  } else if (id === "legacy-fixture-verify-after-set") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.runner = verifyAfterSetMutationSource(oracle);
  } else if (id === "migration-runner-export-star-double") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index = 'export * from "./migration-runner";';
  } else if (id === "migration-runner-export-star-single") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index = "export * from './migration-runner';";
  } else if (id === "migration-runner-export-star-extension") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index = 'export * from "./migration-runner.ts";';
  } else if (id === "migration-runner-named-export-missing") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index = 'export { runMigrations } from "./migration-runner";';
  } else if (id === "migration-runner-recorder-named-reexport") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index =
      'export { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures } from "./migration-runner";';
  } else if (id === "migration-runner-recorder-aliased-reexport") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index =
      'export { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures as trustedDatabase } from "./migration-runner.ts";';
  } else if (id === "migration-runner-namespace-reexport") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index = 'export * as migrationRunner from "./migration-runner";';
  } else if (id === "migration-runner-recorder-named-import") {
    candidate.set(
      "packages/storage/src/doctor-integrity.ts",
      'import { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures } from "./migration-runner";\nrecordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);\n',
    );
  } else if (id === "migration-runner-recorder-aliased-import") {
    candidate.set(
      "packages/storage/src/doctor-integrity.ts",
      "import { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures as trust } from './migration-runner.ts';\ntrust(database);\n",
    );
  } else if (id === "migration-runner-recorder-namespace-import") {
    candidate.set(
      "packages/storage/src/doctor-integrity.ts",
      'import * as migrationRunner from "./migration-runner";\nmigrationRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);\n',
    );
  } else if (id === "migration-runner-doctor-recorder-local-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./doctor-integrity";';
    compatibilityMutation.modules.set(
      "packages/storage/src/doctor-integrity.ts",
      'import { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures } from "./migration-runner";\n' +
        "export { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures };\n",
    );
  } else if (id === "migration-runner-intermediary-recorder-alias-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += "\nexport * from './compatibility-intermediary.ts';";
    compatibilityMutation.modules.set(
      "packages/storage/src/compatibility-intermediary.ts",
      "import {\n  recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures as localTrust,\n} from './migration-runner.ts';\n" +
        "export { localTrust as publicTrust };\n",
    );
  } else if (id === "migration-runner-intermediary-recorder-namespace-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./compatibility-intermediary";';
    compatibilityMutation.modules.set(
      "packages/storage/src/compatibility-intermediary.ts",
      'import * as migrationRunner from "./migration-runner";\nexport { migrationRunner };\n',
    );
  } else if (id === "migration-runner-database-recorder-local-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.opener +=
      "\nexport { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures };\n";
  } else if (id === "migration-runner-database-recorder-alias-import") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.opener = compatibilityMutation.opener
      .replace(
        "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures }",
        "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures as localTrust }",
      )
      .replace("recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db)", "localTrust(db)");
  } else if (id === "migration-runner-database-recorder-namespace-import") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.opener = compatibilityMutation.opener
      .replace(
        'import { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures } from "./migration-runner";',
        'import * as migrationRunner from "./migration-runner.ts";',
      )
      .replace(
        "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db)",
        "migrationRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db)",
      );
  } else if (id === "migration-runner-intermediary-export-star-chain") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index = 'export * from "./compatibility-intermediary";';
    compatibilityMutation.modules.set(
      "packages/storage/src/compatibility-intermediary.ts",
      "export * from './migration-runner.ts';\n",
    );
  } else if (id === "migration-runner-intermediary-namespace-chain") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index = 'export { migrationRunner } from "./compatibility-intermediary";';
    compatibilityMutation.modules.set(
      "packages/storage/src/compatibility-intermediary.ts",
      'export * as migrationRunner from "./migration-runner";\n',
    );
  } else if (id === "migration-runner-intermediary-named-alias-chain") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index = 'export * from "./compatibility-intermediary";';
    compatibilityMutation.modules.set(
      "packages/storage/src/compatibility-intermediary.ts",
      'export { runMigrations as fixtureMigrations } from "./migration-runner";\n',
    );
  } else if (id === "migration-runner-comment-multiline-recorder-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./compatibility-intermediary";';
    compatibilityMutation.modules.set(
      "packages/storage/src/compatibility-intermediary.ts",
      "/* export * from './migration-runner'; */\n" +
        'import {\n  // the private binding remains private only without the export below\n  recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures,\n} from "./migration-runner"\n' +
        "export {\n  recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures as leakedRecorder,\n}\n",
    );
  } else if (id === "migration-runner-database-asi-direct-alias-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./database";';
    compatibilityMutation.opener +=
      "\nconst recorderAlias = recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures\n" +
      "export { recorderAlias }\n";
  } else if (id === "migration-runner-database-asi-multiline-alias-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./database";';
    compatibilityMutation.opener +=
      "\nconst firstRecorderAlias =\n  (recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures)\n" +
      "const secondRecorderAlias =\n  firstRecorderAlias\n" +
      "export {\n  secondRecorderAlias as publicRecorderAlias,\n}\n";
  } else if (id === "migration-runner-database-asi-comment-alias-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./database";';
    compatibilityMutation.opener +=
      "\nconst commentedRecorderAlias =\n  /* ASI-safe private alias */\n  recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures // no semicolon\n" +
      "export { commentedRecorderAlias }\n";
  } else if (id === "migration-runner-database-asi-property-alias-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./database";';
    compatibilityMutation.opener +=
      "\nconst recorderAuthority = {\n  recorder: recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures,\n}\n" +
      "const propertyRecorderAlias =\n  recorderAuthority.recorder\n" +
      "export { propertyRecorderAlias }\n";
  } else if (id === "migration-runner-recorder-object-shorthand-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./database";';
    compatibilityMutation.opener +=
      "\nexport const recorderCapabilityContainer = {\n" +
      "  recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures,\n" +
      "};\n";
  } else if (id === "migration-runner-recorder-object-explicit-computed-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./database";';
    compatibilityMutation.opener +=
      '\nexport const recorderCapabilityContainer = {\n  ["recorder"]: recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures,\n};\n';
  } else if (id === "migration-runner-recorder-object-property-read-export") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.index += '\nexport * from "./database";';
    compatibilityMutation.opener +=
      "\nconst recorderCapabilityContainer = { recorder: recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures };\n" +
      "export const leakedRecorderCapability = recorderCapabilityContainer.recorder;\n";
  } else if (id === "migration-runner-recorder-call-duplicated") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.opener +=
      "\nrecordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db);\n";
  } else if (id === "migration-runner-recorder-call-before-verification") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    const recorderCall = "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db);";
    compatibilityMutation.opener = compatibilityMutation.opener
      .replace(" verifyIntegrity(db); " + recorderCall, " verifyIntegrity(db);")
      .replace("applyMigrations(db);", "applyMigrations(db); " + recorderCall);
  } else if (id === "migration-runner-dynamic-import-bracket") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.modules.set(
      "packages/storage/src/dynamic-loader.ts",
      'const migrationRunner = await import("./migration-" + "runner");\n' +
        'migrationRunner["recordVerifiedCanonicalApplicationDatabase" + "ForLegacyFixtures"](database);\n',
    );
  } else if (id === "migration-runner-dynamic-import-computed-destructure") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.modules.set(
      "packages/storage/src/dynamic-loader.ts",
      'const { ["recordVerifiedCanonicalApplicationDatabase" + "ForLegacyFixtures"]: recorder } = await import(`./migration-${"runner"}`);\n' +
        "recorder(database);\n",
    );
  } else if (id === "migration-runner-require-loader") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.modules.set(
      "packages/storage/src/dynamic-loader.ts",
      'const migrationRunner = require("./migration-" + "runner");\n' +
        'migrationRunner["recordVerifiedCanonicalApplicationDatabase" + "ForLegacyFixtures"](database);\n',
    );
  } else if (id === "migration-runner-import-meta-require-loader") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.modules.set(
      "packages/storage/src/dynamic-loader.ts",
      'const migrationRunner = import.meta.require("./migration-" + "runner");\n' +
        'migrationRunner["recordVerifiedCanonicalApplicationDatabase" + "ForLegacyFixtures"](database);\n',
    );
  } else if (id === "migration-runner-eval-loader") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.modules.set(
      "packages/storage/src/dynamic-loader.ts",
      'const execute = globalThis["ev" + "al"];\n' +
        'execute("import(\\\"./migration-\\\" + \\\"runner\\\").then((module) => module[\\\"recordVerifiedCanonicalApplicationDatabase\\\" + \\\"ForLegacyFixtures\\\"](database))");\n',
    );
  } else if (id === "migration-runner-function-loader") {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.modules.set(
      "packages/storage/src/dynamic-loader.ts",
      'const load = globalThis["Fun" + "ction"]("return import(\\\"./migration-\\\" + \\\"runner\\\")");\n' +
        'load().then((module) => module["recordVerifiedCanonicalApplicationDatabase" + "ForLegacyFixtures"](database));\n',
    );
  } else if (REVIEWER_CAPABILITY_MUTATION_SOURCES.has(id)) {
    compatibilityMutation = compatibilityMutationBaseline(oracle);
    compatibilityMutation.modules.set(
      "packages/storage/src/dynamic-loader.ts",
      REVIEWER_CAPABILITY_MUTATION_SOURCES.get(id),
    );
  } else if (id === "legacy-fixture-unauthorized-recorder") {
    const path = "packages/storage/src/doctor-integrity.ts";
    candidate.set(
      path,
      candidate.get(path) +
        '\nimport { recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures } from "./migration-runner";\n' +
        "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);\n",
    );
  } else if (id === "strict-runner-compatibility-bypass") {
    compatibilityMutation = {
      runner:
        "import { canonicalDatabaseMigrations } from './migration-registry'; const verifiedCanonicalDatabases = new WeakMap(); const fingerprint = 'sqlite_schema schema_migration_conversions search_reindex_operations'; export function recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures() {} export function applyMigrations(database, migrations) { if (verifiedCanonicalDatabases.get(database)) return; } export function runMigrations(database, migrations) { const authorityFingerprint = verifiedCanonicalDatabases.get(database); if (authorityFingerprint !== fingerprint) throw new MigrationRunnerError(); return; }",
      opener:
        "applyMigrations(db); installMigrationConversionInfrastructure(db); verifyCanonicalMigrationState(db); verifyIntegrity(db); recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(db);",
      index: 'export { runMigrations } from "./migration-runner";',
    };
  } else {
    fail("unknown source mutation: " + id);
  }
  const observed = sourceMutationFacts(oracle, candidate);
  let detected = false;
  if (compatibilityMutation !== null) {
    const violations = implementationCompatibilityViolationsFromSources(
      compatibilityMutation.runner,
      compatibilityMutation.opener,
      compatibilityMutation.index,
      oracle,
      compatibilityMutation.modules ?? new Map(),
    );
    if (id === "legacy-fixture-constant-fingerprint") {
      const formerMarkers = [
        "new WeakMap",
        "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures",
        "canonicalDatabaseMigrations",
        "sqlite_schema",
        "schema_migration_conversions",
        "search_reindex_lease",
        "search_reindex_progress",
        ".get(database)",
        "authorityFingerprint !==",
        "throw new MigrationRunnerError",
      ];
      const outcome = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--weak-constant-fingerprint-child"],
        { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      detected =
        formerMarkers.every((marker) => compatibilityMutation.runner.includes(marker)) &&
        outcome.status === 37 &&
        outcome.stderr.includes("weak constant fingerprint rejected by runtime matrix");
    } else if (id === "legacy-fixture-verify-after-set") {
      const outcome = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--verify-after-set-child"],
        { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      detected =
        violations.includes("legacy-fixture-fingerprint-bypass") &&
        outcome.status === 38 &&
        outcome.stderr.includes("verify-after-set rejected by runtime matrix");
    } else if (id === "legacy-fixture-count-only-schema") {
      const outcome = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--count-only-schema-child"],
        { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      detected =
        outcome.status === 39 &&
        outcome.stderr.includes("count-only schema verifier rejected by runtime matrix");
    } else if (id === "legacy-fixture-failure-stores-expected-fingerprint") {
      const outcome = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--failure-marker-child"],
        { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      detected =
        outcome.status === 40 &&
        outcome.stderr.includes("failure marker rejected by fixture discriminator");
    } else if (id === "migration-runner-recorder-call-before-verification") {
      detected =
        violations.includes("legacy-fixture-package-boundary-bypass") &&
        violations.includes("legacy-fixture-premature-record");
    } else if (id.startsWith("migration-runner-") || REVIEWER_CAPABILITY_MUTATION_SOURCES.has(id)) {
      detected = violations.includes("legacy-fixture-package-boundary-bypass");
    } else {
      detected = violations.includes(id);
    }
  } else if (sequenceMutation !== null) {
    detected = implementationSequenceViolationsFromSources(
      sequenceMutation.converter,
      sequenceMutation.opener,
    ).includes(id);
  } else if (scopeMutation !== null) {
    try {
      assertImplementationScope(
        oracle.issue234.currentTreeAuthority,
        implementationAllowedPaths(oracle),
        scopeMutation,
      );
    } catch {
      detected = true;
    }
  } else if (id === "remove-semantic-source") {
    detected = observed.semantic.some((row) => row.observedSha256 === null);
  } else if (id === "duplicate-semantic-source") {
    detected = observed.duplicateSemanticFiles.length > baseline.duplicateSemanticFiles.length;
  } else if (id === "change-semantic-sql") {
    detected = observed.semantic.some(
      (row) => row.observedSha256 !== null && row.observedSha256 !== row.expectedSha256,
    );
  } else if (id === "new-durable-ddl") {
    detected = unregisteredProductionDdlPaths(oracle, candidate).includes(
      "packages/storage/src/forged-durable-ddl.ts",
    );
  } else if (
    new Set([
      "new-direct-semantic-sql",
      "third-migration-direct-sql",
      "registry-index-direct-sql",
      "alias-direct-sql",
      "slot20-sql-constant-alias",
      "registry-bracket-destructure",
      "registry-at-destructure",
      "registry-find-destructure",
    ]).has(id)
  ) {
    detected = stable(observed.directSql) !== stable(baseline.directSql);
  } else if (id === "new-apply-migrations-bypass") {
    detected = stable(observed.applyCalls) !== stable(baseline.applyCalls);
  } else if (
    id === "legacy-fixture-unauthorized-recorder" ||
    id.startsWith("migration-runner-recorder-")
  ) {
    detected = unauthorizedCompatibilityRecorderPaths(candidate, oracle).length > 0;
  }
  if (!detected) process.exit(0);
  process.stderr.write("source mutation rejected: " + id + "\n");
  process.exit(37);
}

function runSourceSelfTest(oracle) {
  const survived = [];
  for (const id of oracle.issue234.currentTreeAuthority.sourceMutationIds) {
    const outcome = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--source-mutation=" + id],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (outcome.status !== 37 || !outcome.stderr.includes("source mutation rejected: " + id)) {
      survived.push(id + " (status " + String(outcome.status) + ")");
    }
  }
  if (survived.length > 0) fail("source mutation self-test survived: " + survived.join(", "));
  return oracle.issue234.currentTreeAuthority.sourceMutationIds.length;
}

function nulPaths(value) {
  return value
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"));
}

function parseGitChangeRecords(value) {
  const tokens = value.split("\0").filter(Boolean);
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (/^[RC]\d+$/u.test(status)) {
      const source = tokens[index++];
      const destination = tokens[index++];
      if (source === undefined || destination === undefined)
        throw new Error("truncated rename record");
      records.push({ status: status + "-source", path: source });
      records.push({ status: status + "-destination", path: destination });
    } else {
      const path = tokens[index++];
      if (path === undefined) throw new Error("truncated change record");
      records.push({ status, path });
    }
  }
  return records;
}

function trackedImplementationChangeRecords() {
  return parseGitChangeRecords(git(["diff", "--name-status", "-z", "--find-renames", "HEAD"]));
}

function implementationScopeProjection(oracle, runtime) {
  const allowed = implementationAllowedPaths(oracle);
  const records = trackedImplementationChangeRecords().filter(
    (record) => !authorityArtifactPaths.has(record.path),
  );
  assertImplementationScope(oracle.issue234.currentTreeAuthority, allowed, records);
  exact(
    runtime.definitions.length,
    oracle.issue234.currentTreeAuthority.semanticAllowedPaths.length,
    "implementation semantic projection count",
  );
  return {
    allowedPaths: allowed.size,
    semanticAllowedPaths: oracle.issue234.currentTreeAuthority.semanticAllowedPaths.length,
    semanticMigrationsValidated: runtime.definitions.length,
    semanticIdentityDigest: runtime.semanticIdentityDigest,
    trackedChangedEndpoints: new Set(records.map((record) => record.path)).size,
    unknownTrackedEndpoints: 0,
    authorityArtifactsExcluded: authorityArtifactPaths.size,
  };
}

function implementationSequenceViolationsFromSources(converterSource, openerSource) {
  const violations = [];
  if (
    !/targetMigrations\s*=\s*canonicalDatabaseMigrations\.slice\(\s*0\s*,\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?targetVersion\s*\)/u.test(
      converterSource,
    ) ||
    !/for\s*\(const migration of targetMigrations\)/u.test(converterSource)
  ) {
    violations.push("converter-live-tip-loop");
  }
  const conversionCall = openerSource.indexOf("convertMigrationHistory(db");
  const suffixCall = openerSource.indexOf("applyMigrations(db", conversionCall + 1);
  if (
    conversionCall < 0 ||
    suffixCall < 0 ||
    /\}\s*else\s*\{[\s\S]*$/u.test(openerSource.slice(conversionCall, suffixCall)) ||
    !openerSource.slice(suffixCall).includes("beforePendingMigration")
  ) {
    violations.push("legacy-opener-skips-suffix-runner");
  }
  return violations;
}

function implementationCompatibilityViolationsFromSources(
  runnerSource,
  openerSource,
  indexSource,
  oracle,
  moduleSources = new Map(),
) {
  const violations = [];
  const recorder = "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures";
  const runStart = runnerSource.indexOf("export function runMigrations");
  const runEnd = runnerSource.indexOf("\nfunction getDatabase", runStart);
  const recorderStart = runnerSource.indexOf("export function " + recorder);
  const recorderEnd = runnerSource.indexOf("\nexport function runMigrations", recorderStart);
  const applyStart = runnerSource.indexOf("export function applyMigrations");
  const applyEnd = runnerSource.indexOf("\nfunction hardenFileBackedDatabase", applyStart);
  const runBody = runStart >= 0 && runEnd > runStart ? runnerSource.slice(runStart, runEnd) : "";
  const recorderBody =
    recorderStart >= 0 && recorderEnd > recorderStart
      ? runnerSource.slice(recorderStart, recorderEnd)
      : "";
  const applyBody =
    applyStart >= 0 && applyEnd > applyStart ? runnerSource.slice(applyStart, applyEnd) : "";
  if (
    /readUserVersion\([^)]*\)\s*===\s*\d+/u.test(runBody) ||
    /user[_A-Za-z]*version[^\n]*===\s*27/iu.test(runBody) ||
    /export function runMigrations[\s\S]{0,500}readUserVersion\([^)]*\)\s*===\s*\d+/u.test(
      runnerSource,
    )
  ) {
    violations.push("legacy-fixture-literal-tip");
  }
  if (
    /migrations\.length/u.test(runBody) ||
    /supportedSchemaVersion|schemaCeiling|callerCeiling/u.test(runBody) ||
    /export function runMigrations[\s\S]{0,500}migrations\.length/u.test(runnerSource)
  ) {
    violations.push("legacy-fixture-caller-ceiling");
  }
  void openerSource;
  const recorderVerify = recorderBody.indexOf("verifyCompleteCurrentTipAuthority");
  const recorderSet = recorderBody.indexOf(".set(database");
  const runVerify = runBody.indexOf("verifyCompleteCurrentTipAuthority");
  const runReturn = runBody.indexOf("return");
  if (
    !runnerSource.includes("new WeakMap") ||
    !runnerSource.includes(recorder) ||
    !runnerSource.includes("canonicalDatabaseMigrations") ||
    !runnerSource.includes("sqlite_schema") ||
    !runnerSource.includes("schema_migration_conversions") ||
    !runnerSource.includes("search_reindex_lease") ||
    !runnerSource.includes("search_reindex_progress") ||
    !runnerSource.includes("verifyExactCurrentTipHistory") ||
    !runnerSource.includes("verifyExactCurrentTipSchema") ||
    !runnerSource.includes("verifyImmutableConversionRows") ||
    !runnerSource.includes("verifyReindexOverlay") ||
    recorderVerify < 0 ||
    recorderSet <= recorderVerify ||
    !/\.get\(database\)/u.test(runBody) ||
    runVerify < 0 ||
    (runReturn >= 0 && runReturn < runVerify) ||
    !/(?:timingSafeEqual|===|!==)[^\n]*(?:fingerprint|authority)/iu.test(runBody) ||
    !/throw new MigrationRunnerError/u.test(runBody)
  ) {
    violations.push("legacy-fixture-fingerprint-bypass");
  }
  if (
    applyBody.includes(recorder) ||
    /(?:verifiedCanonical|fixtureCompatibility|compatibilityFingerprint)/u.test(applyBody) ||
    /export function applyMigrations[\s\S]{0,600}(?:verifiedCanonical|fixtureCompatibility|compatibilityFingerprint)/u.test(
      runnerSource,
    )
  ) {
    violations.push("strict-runner-compatibility-bypass");
  }
  const packageSources = new Map(moduleSources);
  packageSources.set("packages/storage/src/migration-runner.ts", runnerSource);
  packageSources.set("packages/storage/src/database.ts", openerSource);
  packageSources.set("packages/storage/src/index.ts", indexSource);
  violations.push(
    ...migrationRunnerModuleBoundaryAudit(
      packageSources,
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
    ).boundaryViolations,
  );
  return [...new Set(violations)];
}

function implementationSequenceSourceViolations(oracle) {
  return implementationSequenceViolationsFromSources(
    readFileSync(join(repositoryRoot, oracle.canonicalRegistry.conversionPath), "utf8"),
    readFileSync(join(repositoryRoot, "packages/storage/src/database.ts"), "utf8"),
  );
}

async function implementationSequenceCheck(oracle) {
  const sourceViolations = implementationSequenceSourceViolations(oracle);
  const runtimeViolations = [];
  const { mock } = await import("bun:test");
  const { Database } = await import("bun:sqlite");
  const runner = await import(
    pathToFileURL(join(repositoryRoot, "packages/storage/src/migration-runner.ts")).href
  );
  const registryUrl = pathToFileURL(
    join(repositoryRoot, oracle.canonicalRegistry.registryPath),
  ).href;
  const converterUrl = pathToFileURL(
    join(repositoryRoot, oracle.canonicalRegistry.conversionPath),
  ).href;
  const registry = await import(registryUrl);
  const suffixes = oracle.appendStableProvenance.proofSuffixes.map((suffix) =>
    Object.freeze({
      version: suffix.version,
      name: suffix.name,
      sql: suffix.sql,
      requiresForeignKeysOff: suffix.requiresForeignKeysOff,
    }),
  );
  const liveRegistry = Object.freeze([
    ...registry.canonicalDatabaseMigrations,
    ...suffixes.filter(
      (suffix) =>
        suffix.version > registry.canonicalDatabaseMigrations.length && suffix.version <= 29,
    ),
  ]);
  exact(liveRegistry.length, 29, "implementation sequence live plus proof registry length");
  const digestAtVersion = (targetVersion) => {
    if (
      !Number.isSafeInteger(targetVersion) ||
      targetVersion < 0 ||
      targetVersion > liveRegistry.length
    ) {
      throw new RangeError("canonical migration prefix version is out of range");
    }
    return computeRegistryIdentityDigest(
      liveRegistry.slice(0, targetVersion).map((migration) => ({
        ...migration,
        contentHash: runner.migrationContentHash(migration),
      })),
    );
  };
  mock.module(registryUrl, () => ({
    ...registry,
    canonicalDatabaseMigrations: liveRegistry,
    CANONICAL_DATABASE_SCHEMA_VERSION: liveRegistry.length,
    NEXT_DATABASE_MIGRATION_VERSION: liveRegistry.length + 1,
    NEXT_REPORT_MIGRATION_VERSION: liveRegistry.length + 1,
    canonicalRegistryDigestAtVersion: digestAtVersion,
  }));
  const converter = await import(converterUrl + "?implementation-sequence=" + Date.now());
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    runner.applyMigrations(database, [{ ...registry.canonicalDatabaseMigrations[1], version: 1 }]);
    exact(
      converter.classifyMigrationHistory(database).classification,
      "supported-legacy",
      "appended-registry real converter legacy classification",
    );
    converter.convertMigrationHistory(database, {
      backupProof: {
        backupId: "backup:implementation-sequence",
        manifestSha256: sha256(Buffer.from("implementation sequence backup", "utf8")),
        createdAt: "2026-08-20T00:00:00.000Z",
      },
    });
    const convertedVersion = database.query("PRAGMA user_version").get()?.user_version;
    const convertedRows = database
      .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
      .all();
    if (
      convertedVersion !== 27 ||
      convertedRows.length !== 27 ||
      hasSchemaObject(database, "append_stability_probe_29")
    ) {
      runtimeViolations.push("converter-live-tip-loop");
    } else {
      const conversionBytes = JSON.stringify(
        database.query("SELECT * FROM schema_migration_conversions ORDER BY conversion_id").all(),
      );
      const gatedSuffixes = [];
      runner.applyMigrations(database, liveRegistry, {
        beforePendingMigration: ({
          database: lockedDatabase,
          currentPrefixVersion,
          pendingMigration,
        }) => {
          converter.verifyCanonicalMigrationPrefixState(lockedDatabase, currentPrefixVersion);
          gatedSuffixes.push(pendingMigration.version);
        },
      });
      exact(gatedSuffixes, [28, 29], "real opener suffix gate sequence");
      exact(
        database.query("PRAGMA user_version").get()?.user_version,
        29,
        "real suffix final version",
      );
      exact(hasSchemaObject(database, "append_stability_probe_29"), true, "real suffix 29 SQL");
      exact(
        JSON.stringify(
          database.query("SELECT * FROM schema_migration_conversions ORDER BY conversion_id").all(),
        ),
        conversionBytes,
        "real suffix immutable target-27 provenance",
      );
      converter.verifyCanonicalMigrationState(database);
    }
  } catch (error) {
    if (!runtimeViolations.includes("converter-live-tip-loop")) {
      runtimeViolations.push("converter-live-tip-loop:" + String(error));
    }
  } finally {
    database.close();
  }
  const violations = [...new Set([...sourceViolations, ...runtimeViolations])];
  if (violations.length > 0) {
    fail("implementation sequence violations: " + violations.join(", "));
  }
  return {
    productionConverter: oracle.canonicalRegistry.conversionPath,
    productionOpener: "packages/storage/src/database.ts",
    conversionTargetVersion: 27,
    convertedHistoryRows: 27,
    suffixGateVersions: [28, 29],
    mutationsRejected: oracle.appendStableProvenance.implementationSequenceMutationIds.length,
  };
}

function assertCompatibilityCallRejectsWithoutFixture(label, database, fixture, call) {
  const before = database.serialize();
  let rejected = false;
  try {
    call();
  } catch {
    rejected = true;
  }
  exact(rejected, true, label + " rejection");
  exact(Buffer.compare(before, database.serialize()), 0, label + " byte preservation");
  exact(
    hasSchemaObject(database, "standalone_legacy_fixture"),
    false,
    label + " fixture SQL absence",
  );
}

function assertInvalidCompatibilityAuthority(
  label,
  database,
  recorderEntrypoints,
  runMigrations,
  fixture,
) {
  for (const entrypoint of recorderEntrypoints) {
    assertCompatibilityCallRejectsWithoutFixture(
      label + " " + entrypoint.id + " recorder",
      database,
      fixture,
      () => entrypoint.call(database),
    );
  }
  assertCompatibilityCallRejectsWithoutFixture(label + " runner", database, fixture, () =>
    runMigrations(database, fixture),
  );
}

function assertRecordedCompatibilityTamperRejected(
  label,
  database,
  recorder,
  runMigrations,
  fixture,
  tamper,
) {
  recorder(database);
  tamper(database);
  assertCompatibilityCallRejectsWithoutFixture(label, database, fixture, () =>
    runMigrations(database, fixture),
  );
}

function substituteSameCardinalitySchemaTuple(database) {
  const beforeCount = database
    .query("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
    .get()?.count;
  const original = database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE type = 'index' AND name = 'action_plans_state_idx'",
    )
    .get();
  if (
    original?.type !== "index" ||
    original.name !== "action_plans_state_idx" ||
    original.tbl_name !== "action_plans" ||
    typeof original.sql !== "string"
  ) {
    fail("same-cardinality schema tuple fixture is missing");
  }
  const changedSql = original.sql.replace(
    "(state, expires_at, plan_id)",
    "(state, plan_id, expires_at)",
  );
  if (changedSql === original.sql) fail("same-cardinality index SQL fixture changed shape");
  database.exec("DROP INDEX action_plans_state_idx;" + changedSql);
  const changed = database
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE type = 'index' AND name = 'action_plans_state_idx'",
    )
    .get();
  exact(changed?.type, original.type, "same-cardinality schema tuple type");
  exact(changed?.name, original.name, "same-cardinality schema tuple name");
  exact(changed?.tbl_name, original.tbl_name, "same-cardinality schema tuple table");
  if (changed?.sql === original.sql) fail("same-cardinality schema tuple SQL did not change");
  exact(
    database
      .query("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .get()?.count,
    beforeCount,
    "same-cardinality schema object count",
  );
  return original;
}

function restoreSameCardinalitySchemaTuple(database, original) {
  database.exec("DROP INDEX action_plans_state_idx;" + original.sql);
}

function createCompatibilityBaselineDatabase(Database) {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, content_hash TEXT NOT NULL) STRICT;" +
      "CREATE INDEX action_plans_state_idx ON schema_migrations(name);" +
      "CREATE TABLE search_reindex_lease (lease_id INTEGER PRIMARY KEY, operation_name TEXT NOT NULL, replacement_name TEXT NOT NULL, phase TEXT NOT NULL, last_rowid INTEGER NOT NULL, processed_rows INTEGER NOT NULL) STRICT;" +
      "CREATE TABLE search_reindex_progress (replacement_name TEXT NOT NULL, source_rowid INTEGER NOT NULL, source_digest TEXT NOT NULL, PRIMARY KEY (replacement_name, source_rowid)) STRICT;" +
      "INSERT INTO schema_migrations (version, name, content_hash) VALUES (1, 'canonical', '" +
      "a".repeat(64) +
      "');" +
      "PRAGMA user_version = 1",
  );
  return database;
}

function transitionCompatibilityBaselineToValidReindexOverlay(database) {
  const operationName = "Proof.reindex:constant-fingerprint";
  const replacementName =
    "message_fts_replacement_" + sha256(Buffer.from(operationName)).slice(0, 16);
  database
    .query(
      "INSERT INTO search_reindex_lease " +
        "(lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows) " +
        "VALUES (1, ?, ?, 'building', 0, 0)",
    )
    .run(operationName, replacementName);
}

function compatibilityBaselineSnapshotSha256(database) {
  return sha256(
    Buffer.from(
      JSON.stringify([
        database.query("PRAGMA user_version").get(),
        database
          .query("SELECT version, name, content_hash FROM schema_migrations ORDER BY version")
          .all(),
        database
          .query(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
              "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name, sql",
          )
          .all(),
        database.query("SELECT * FROM search_reindex_lease ORDER BY lease_id").all(),
        database
          .query("SELECT * FROM search_reindex_progress ORDER BY replacement_name, source_rowid")
          .all(),
      ]),
    ),
  );
}

async function weakConstantFingerprintCompatibilityChild(oracle) {
  const { Database } = await import("bun:sqlite");
  const fixture = [
    {
      version: 1,
      name: "standalone-legacy-fixture",
      sql: "CREATE TABLE standalone_legacy_fixture (id INTEGER PRIMARY KEY) STRICT",
    },
  ];
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "migration-registry-weak-fingerprint-"));
  const strongRunnerPath = join(temporaryDirectory, "migration-runner-strong.mjs");
  const weakRunnerPath = join(temporaryDirectory, "migration-runner.mjs");
  writeFileSync(strongRunnerPath, compatibilityMutationBaseline(oracle).runner);
  writeFileSync(weakRunnerPath, weakConstantFingerprintMutationSource(oracle));
  const strongRunner = await import(
    pathToFileURL(strongRunnerPath).href + "?runtime=" + Date.now()
  );
  const weakRunner = await import(pathToFileURL(weakRunnerPath).href + "?runtime=" + Date.now());
  const strongPrecondition = createCompatibilityBaselineDatabase(Database);
  const database = createCompatibilityBaselineDatabase(Database);
  try {
    strongRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(strongPrecondition);
    weakRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);
    const beforeOverlay = compatibilityBaselineSnapshotSha256(database);
    transitionCompatibilityBaselineToValidReindexOverlay(database);
    const afterOverlay = compatibilityBaselineSnapshotSha256(database);
    if (beforeOverlay === afterOverlay) fail("weak fingerprint overlay transition is not distinct");
    strongRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);
    const beforeFalseNoOp = database.serialize();
    weakRunner.runMigrations(database, fixture);
    exact(
      Buffer.compare(beforeFalseNoOp, database.serialize()),
      0,
      "weak constant fingerprint false no-op bytes",
    );
    exact(
      hasSchemaObject(database, "standalone_legacy_fixture"),
      false,
      "weak constant fingerprint false no-op fixture absence",
    );
  } finally {
    strongPrecondition.close();
    database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function countOnlySchemaCompatibilityChild(oracle) {
  const { Database } = await import("bun:sqlite");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "migration-registry-count-schema-"));
  const strongRunnerPath = join(temporaryDirectory, "migration-runner-strong.mjs");
  const countRunnerPath = join(temporaryDirectory, "migration-runner-count.mjs");
  writeFileSync(strongRunnerPath, compatibilityMutationBaseline(oracle).runner);
  writeFileSync(countRunnerPath, countOnlySchemaMutationSource(oracle));
  const strongRunner = await import(
    pathToFileURL(strongRunnerPath).href + "?runtime=" + Date.now()
  );
  const countRunner = await import(pathToFileURL(countRunnerPath).href + "?runtime=" + Date.now());
  const database = createCompatibilityBaselineDatabase(Database);
  try {
    strongRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);
    database.exec(
      "DROP INDEX action_plans_state_idx;" +
        "CREATE INDEX action_plans_state_idx ON schema_migrations(name) WHERE version > 0",
    );
    let strongRejected = false;
    try {
      strongRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);
    } catch {
      strongRejected = true;
    }
    exact(strongRejected, true, "exact schema verifier rejects same-cardinality substitution");
    countRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);
  } finally {
    database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function failureStoresExpectedFingerprintCompatibilityChild(oracle) {
  const { Database } = await import("bun:sqlite");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "migration-registry-failure-marker-"));
  const strongRunnerPath = join(temporaryDirectory, "migration-runner-strong.mjs");
  const mutationRunnerPath = join(temporaryDirectory, "migration-runner-failure-marker.mjs");
  writeFileSync(strongRunnerPath, compatibilityMutationBaseline(oracle).runner);
  writeFileSync(mutationRunnerPath, failureStoresExpectedFingerprintMutationSource(oracle));
  const strongRunner = await import(
    pathToFileURL(strongRunnerPath).href + "?runtime=" + Date.now()
  );
  const mutationRunner = await import(
    pathToFileURL(mutationRunnerPath).href + "?runtime=" + Date.now()
  );
  const database = createCompatibilityBaselineDatabase(Database);
  const strictControl = createCompatibilityBaselineDatabase(Database);
  const fixture = [{ version: 1, name: "standalone-legacy-fixture" }];
  try {
    strongRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);
    let strictRejected = false;
    try {
      strongRunner.runMigrations(strictControl, fixture);
    } catch {
      strictRejected = true;
    }
    exact(strictRejected, true, "failure-marker strict fixture control");
    database.exec(
      "DROP INDEX action_plans_state_idx;" +
        "CREATE INDEX action_plans_state_idx ON schema_migrations(name) WHERE version > 0",
    );
    let recorderRejected = false;
    try {
      mutationRunner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(database);
    } catch {
      recorderRejected = true;
    }
    exact(recorderRejected, true, "failure-marker recorder rethrows verifier failure");
    database.exec(
      "DROP INDEX action_plans_state_idx;" +
        "CREATE INDEX action_plans_state_idx ON schema_migrations(name)",
    );
    const beforeFalseNoOp = database.serialize();
    mutationRunner.runMigrations(database, fixture);
    exact(
      Buffer.compare(beforeFalseNoOp, database.serialize()),
      0,
      "failure-marker fixture false no-op bytes",
    );
    exact(
      hasSchemaObject(database, "standalone_legacy_fixture"),
      false,
      "failure-marker fixture false no-op table absence",
    );
  } finally {
    strictControl.close();
    database.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyAfterSetCompatibilityChild(oracle) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "migration-registry-verify-after-set-"));
  const runnerPath = join(temporaryDirectory, "migration-runner.mjs");
  writeFileSync(runnerPath, verifyAfterSetMutationSource(oracle));
  try {
    const runner = await import(pathToFileURL(runnerPath).href + "?runtime=" + Date.now());
    const invalidDatabase = {
      query() {
        throw new Error("invalid authority");
      },
    };
    let recordRejected = false;
    try {
      runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures(invalidDatabase);
    } catch {
      recordRejected = true;
    }
    exact(recordRejected, true, "verify-after-set recorder rejection");
    let leakedMapMutation = false;
    try {
      runner.runMigrations(invalidDatabase, [{ version: 1 }]);
    } catch {
      leakedMapMutation = true;
    }
    exact(leakedMapMutation, true, "verify-after-set leaked WeakMap mutation");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function implementationCompatibilityChild(oracle, releaseVersion) {
  const { mock } = await import("bun:test");
  const { Database } = await import("bun:sqlite");
  const registryUrl = pathToFileURL(
    join(repositoryRoot, oracle.canonicalRegistry.registryPath),
  ).href;
  const registry = await import(registryUrl);
  const base = registry.canonicalDatabaseMigrations.slice(0, 27);
  exact(base.length, 27, "implementation compatibility canonical base");
  const proofByVersion = new Map(
    oracle.appendStableProvenance.proofSuffixes.map((suffix) => [
      suffix.version,
      Object.freeze({
        version: suffix.version,
        name: suffix.name,
        sql: suffix.sql,
        requiresForeignKeysOff: suffix.requiresForeignKeysOff,
      }),
    ]),
  );
  const releaseRegistry = [...base];
  for (let version = 28; version <= releaseVersion; version += 1) {
    const live = registry.canonicalDatabaseMigrations[version - 1];
    const definition = live?.version === version ? live : proofByVersion.get(version);
    if (definition === undefined) fail("missing compatibility release suffix " + version);
    releaseRegistry.push(definition);
  }
  mock.module(registryUrl, () => ({
    ...registry,
    canonicalDatabaseMigrations: Object.freeze(releaseRegistry),
    CANONICAL_DATABASE_SCHEMA_VERSION: releaseRegistry.length,
    NEXT_DATABASE_MIGRATION_VERSION: releaseRegistry.length + 1,
    NEXT_REPORT_MIGRATION_VERSION: releaseRegistry.length + 1,
  }));
  const runnerModuleUrl =
    pathToFileURL(join(repositoryRoot, "packages/storage/src/migration-runner.ts")).href +
    "?fixture-release=" +
    releaseVersion;
  const runner = await import(runnerModuleUrl);
  const recorder = runner.recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures;
  if (typeof recorder !== "function") {
    fail("legacy fixture compatibility recorder is missing");
  }
  const dynamicallyReachedRecorder = Reflect.get(
    await import(runnerModuleUrl),
    "recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures",
  );
  if (typeof dynamicallyReachedRecorder !== "function") {
    fail("legacy fixture compatibility dynamic-equivalent recorder is missing");
  }
  const recorderEntrypoints = [
    { id: "direct", call: (database) => recorder(database) },
    { id: "early", call: (database) => recorder(database) },
    { id: "dynamic-equivalent", call: (database) => dynamicallyReachedRecorder(database) },
  ];
  const fixture = [
    {
      version: 1,
      name: "standalone-legacy-fixture",
      sql: "CREATE TABLE standalone_legacy_fixture (id INTEGER PRIMARY KEY) STRICT",
    },
  ];
  const converter = await import(
    pathToFileURL(join(repositoryRoot, oracle.canonicalRegistry.conversionPath)).href +
      "?fixture-release=" +
      releaseVersion
  );
  const makeCanonicalDatabase = () => {
    const target = new Database(":memory:", { strict: true });
    runner.applyMigrations(target, releaseRegistry);
    converter.installMigrationConversionInfrastructure(target);
    converter.verifyCanonicalMigrationState(target);
    return target;
  };
  const makeConvertedDatabase = () => {
    const target = new Database(":memory:", { strict: true });
    target.exec("PRAGMA foreign_keys = ON");
    runner.applyMigrations(target, [{ ...base[1], version: 1 }]);
    exact(
      converter.classifyMigrationHistory(target).classification,
      "supported-legacy",
      "compatibility converted legacy classification",
    );
    converter.convertMigrationHistory(target, {
      backupProof: {
        backupId: "backup:compatibility-" + releaseVersion,
        manifestSha256: sha256(Buffer.from("compatibility backup " + releaseVersion, "utf8")),
        createdAt: "2026-08-20T00:00:00.000Z",
      },
    });
    runner.applyMigrations(target, releaseRegistry, {
      beforePendingMigration: ({ database: locked, currentPrefixVersion }) =>
        converter.verifyCanonicalMigrationPrefixState(locked, currentPrefixVersion),
    });
    converter.verifyCanonicalMigrationState(target);
    return target;
  };
  const database = makeCanonicalDatabase();
  try {
    runner.applyMigrations(database, releaseRegistry);
    for (const entrypoint of recorderEntrypoints) {
      const beforeRecord = database.serialize();
      entrypoint.call(database);
      exact(
        Buffer.compare(beforeRecord, database.serialize()),
        0,
        "implementation safe recorder " + entrypoint.id + " release " + releaseVersion,
      );
      const beforeRun = database.serialize();
      runner.runMigrations(database, fixture);
      exact(
        Buffer.compare(beforeRun, database.serialize()),
        0,
        "implementation verified fixture no-op " + entrypoint.id + " release " + releaseVersion,
      );
    }
    let strictRejected = false;
    try {
      runner.applyMigrations(database, fixture);
    } catch {
      strictRejected = true;
    }
    exact(strictRejected, true, "implementation strict runner release " + releaseVersion);
  } finally {
    database.close();
  }

  for (const entrypoint of recorderEntrypoints) {
    const substituted = makeCanonicalDatabase();
    try {
      const original = substituteSameCardinalitySchemaTuple(substituted);
      assertCompatibilityCallRejectsWithoutFixture(
        "implementation same-cardinality sqlite_schema tuple " +
          entrypoint.id +
          " release " +
          releaseVersion,
        substituted,
        fixture,
        () => entrypoint.call(substituted),
      );
      restoreSameCardinalitySchemaTuple(substituted, original);
      assertCompatibilityCallRejectsWithoutFixture(
        "same-cardinality rejection leaves no WeakMap marker " + entrypoint.id,
        substituted,
        fixture,
        () => runner.runMigrations(substituted, fixture),
      );
    } finally {
      substituted.close();
    }
  }

  const pending = new Database(":memory:", { strict: true });
  try {
    runner.applyMigrations(pending, releaseRegistry.slice(0, -1));
    converter.installMigrationConversionInfrastructure(pending);
    assertInvalidCompatibilityAuthority(
      "implementation partial history release " + releaseVersion,
      pending,
      recorderEntrypoints,
      runner.runMigrations,
      fixture,
    );
  } finally {
    pending.close();
  }

  const invalidAuthorityCases = [
    [
      "unknown history",
      makeCanonicalDatabase,
      (target) => {
        target
          .query("INSERT INTO schema_migrations (version, name, content_hash) VALUES (?, ?, ?)")
          .run(releaseVersion + 1, "unknown-compatibility-migration", "a".repeat(64));
        target.exec("PRAGMA user_version = " + (releaseVersion + 1));
      },
    ],
    [
      "forged history checksum",
      makeCanonicalDatabase,
      (target) =>
        target
          .query("UPDATE schema_migrations SET content_hash = ? WHERE version = 1")
          .run("b".repeat(64)),
    ],
    [
      "newer version",
      makeCanonicalDatabase,
      (target) => target.exec("PRAGMA user_version = " + (releaseVersion + 1)),
    ],
    [
      "schema drift",
      makeCanonicalDatabase,
      (target) =>
        target.exec("CREATE TABLE compatibility_schema_drift (id INTEGER PRIMARY KEY) STRICT"),
    ],
    [
      "history name drift",
      makeCanonicalDatabase,
      (target) =>
        target
          .query("UPDATE schema_migrations SET name = ? WHERE version = 1")
          .run("forged-pre-record-history"),
    ],
    [
      "conversion provenance drift",
      makeConvertedDatabase,
      (target) =>
        target.exec(
          "DROP TRIGGER schema_migration_conversions_no_update;" +
            "UPDATE schema_migration_conversions SET backup_id = 'backup:pre-record-tampered';" +
            oracle.conversionMetadata.ddl.updateTriggerSql,
        ),
    ],
    [
      "reindex overlay drift",
      makeCanonicalDatabase,
      (target) =>
        target.exec(
          "INSERT INTO search_reindex_lease " +
            "(lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows) " +
            "VALUES (1, 'forged-reindex', 'forged_replacement', 'building', 0, 0)",
        ),
    ],
  ];
  for (const [label, make, mutate] of invalidAuthorityCases) {
    const invalid = make();
    try {
      mutate(invalid);
      assertInvalidCompatibilityAuthority(
        "implementation " + label + " release " + releaseVersion,
        invalid,
        recorderEntrypoints,
        runner.runMigrations,
        fixture,
      );
    } finally {
      invalid.close();
    }
  }

  for (const entrypoint of recorderEntrypoints) {
    const unrecorded = new Database(":memory:", { strict: true });
    try {
      assertCompatibilityCallRejectsWithoutFixture(
        "implementation failed recorder map preservation " +
          entrypoint.id +
          " release " +
          releaseVersion,
        unrecorded,
        fixture,
        () => entrypoint.call(unrecorded),
      );
      runner.runMigrations(unrecorded, fixture);
      exact(
        unrecorded.query("PRAGMA user_version").get()?.user_version,
        1,
        "failed recorder leaves standalone unrecorded " + entrypoint.id,
      );
    } finally {
      unrecorded.close();
    }
  }

  const recordedTamperCases = [
    {
      label: "user_version tamper",
      make: makeCanonicalDatabase,
      mutate: (target) => target.exec("PRAGMA user_version = " + (releaseVersion + 1)),
    },
    {
      label: "exact history tamper",
      make: makeCanonicalDatabase,
      mutate: (target) =>
        target
          .query("UPDATE schema_migrations SET name = ? WHERE version = 1")
          .run("forged-recorded-history"),
    },
    {
      label: "full sqlite_schema tamper",
      make: makeCanonicalDatabase,
      mutate: (target) =>
        target.exec("CREATE TABLE compatibility_schema_tamper (id INTEGER PRIMARY KEY) STRICT"),
    },
    {
      label: "conversion provenance tamper",
      make: makeConvertedDatabase,
      mutate: (target) =>
        target.exec(
          "DROP TRIGGER schema_migration_conversions_no_update;" +
            "UPDATE schema_migration_conversions SET backup_id = 'backup:tampered';" +
            oracle.conversionMetadata.ddl.updateTriggerSql,
        ),
    },
    {
      label: "reindex overlay tamper",
      make: makeCanonicalDatabase,
      mutate: (target) =>
        target.exec(
          "INSERT INTO search_reindex_lease " +
            "(lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows) " +
            "VALUES (1, 'forged-reindex', 'forged_replacement', 'building', 0, 0)",
        ),
    },
  ];
  for (const testCase of recordedTamperCases) {
    const tampered = testCase.make();
    try {
      assertRecordedCompatibilityTamperRejected(
        "implementation " + testCase.label + " release " + releaseVersion,
        tampered,
        recorder,
        runner.runMigrations,
        fixture,
        testCase.mutate,
      );
    } finally {
      tampered.close();
    }
  }

  const standalone = new Database(":memory:", { strict: true });
  try {
    runner.runMigrations(standalone, fixture);
    runner.runMigrations(standalone, fixture);
    exact(
      standalone.query("PRAGMA user_version").get()?.user_version,
      1,
      "implementation standalone strict reopen",
    );
  } finally {
    standalone.close();
  }
  return {
    releaseVersion,
    verifiedNoOp: true,
    validRecorderAccessPaths: recorderEntrypoints.length,
    invalidAuthoritiesRejected: 1 + invalidAuthorityCases.length,
    invalidRecorderCallsRejected: (1 + invalidAuthorityCases.length) * recorderEntrypoints.length,
    failedRecordMapMutationProbes: recorderEntrypoints.length,
    sameCardinalitySchemaTupleRejections: recorderEntrypoints.length,
    recordedTamperCasesRejected: recordedTamperCases.length,
    standaloneVersion: 1,
  };
}

function implementationCompatibilitySourceViolations(oracle) {
  const sources = new Map(
    nulPaths(git(["ls-files", "-co", "--exclude-standard", "-z"]))
      .filter((path) => path.endsWith(".ts") && !isGeneratedImplementationPath(path))
      .filter((path) => existsSync(join(repositoryRoot, path)))
      .map((path) => [path, readFileSync(join(repositoryRoot, path), "utf8")]),
  );
  const violations = implementationCompatibilityViolationsFromSources(
    readFileSync(join(repositoryRoot, "packages/storage/src/migration-runner.ts"), "utf8"),
    readFileSync(join(repositoryRoot, "packages/storage/src/database.ts"), "utf8"),
    readFileSync(join(repositoryRoot, "packages/storage/src/index.ts"), "utf8"),
    oracle,
    sources,
  );
  if (unauthorizedCompatibilityRecorderPaths(sources, oracle).length > 0) {
    violations.push("legacy-fixture-unauthorized-recorder");
  }
  return [...new Set(violations)];
}

function implementationCompatibilityCheck(oracle) {
  const sourceViolations = implementationCompatibilitySourceViolations(oracle);
  if (sourceViolations.length > 0) {
    fail("implementation compatibility violations: " + sourceViolations.join(", "));
  }
  const releases = [];
  for (const version of oracle.runtimeAuthority.legacyFixtureCompatibility.releaseProbeVersions) {
    const outcome = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--compatibility-child=" + version],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (outcome.status !== 0) {
      fail(
        "implementation compatibility child " +
          version +
          " failed: " +
          (outcome.stderr || outcome.stdout).trim(),
      );
    }
    releases.push(JSON.parse(outcome.stdout.trim()));
  }
  return {
    releases,
    validRecorderAccessPathsPerRelease: 3,
    invalidAuthorityCasesPerRelease: 8,
    invalidRecorderCallsPerRelease: 24,
    failedRecordMapMutationProbesPerRelease: 3,
    sameCardinalitySchemaTupleRejectionsPerRelease: 3,
    recordedTamperCasesPerRelease: 5,
    packageNamedExports:
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist.length,
    mutationsRejected:
      oracle.runtimeAuthority.legacyFixtureCompatibility.implementationMutationIds.length,
    broadSuiteCommand: oracle.runtimeAuthority.legacyFixtureCompatibility.broadSuiteCommand,
  };
}

async function implementationCheck(oracle, runtime) {
  const authority = oracle.issue234.currentTreeAuthority;
  const trackedChangeRecords = trackedImplementationChangeRecords();
  const untracked = new Set(nulPaths(git(["ls-files", "--others", "--exclude-standard", "-z"])));
  const changeRecords = [
    ...trackedChangeRecords,
    ...[...untracked].map((path) => ({ status: "?", path })),
  ];
  const allowed = implementationAllowedPaths(oracle);
  assertImplementationScope(authority, allowed, changeRecords);
  const allPaths = nulPaths(git(["ls-files", "-co", "--exclude-standard", "-z"]));
  for (const path of allPaths) {
    if (path.startsWith("/") || path.split("/").includes(".."))
      fail("unsafe current-tree path: " + path);
    if (isGeneratedImplementationPath(path)) continue;
    const absolute = join(repositoryRoot, path);
    if (lstatSync(absolute).isSymbolicLink()) fail("current-tree symlink is forbidden: " + path);
  }
  const changed = new Set(changeRecords.map((record) => record.path));
  const typeScriptPaths = allPaths.filter(
    (path) => path.endsWith(".ts") && !isGeneratedImplementationPath(path),
  );
  const sourceMap = new Map(
    typeScriptPaths.map((path) => [path, readFileSync(join(repositoryRoot, path), "utf8")]),
  );
  const moduleBoundaryAudit = migrationRunnerModuleBoundaryAudit(
    sourceMap,
    oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist,
  );
  exact(
    moduleBoundaryAudit.unauthorizedPaths,
    [],
    "implementation compatibility recorder ownership",
  );
  exact(
    moduleBoundaryAudit.boundaryViolations,
    [],
    "implementation compatibility package export closure",
  );
  const sourceFacts = sourceMutationFacts(oracle, sourceMap);
  const applyPaths = [];
  const directSqlPaths = sourceFacts.directSql.map(([path]) => path);
  const productionDdlPaths = [];
  const canonicalDdlAllowed = canonicalDdlAllowedPaths(oracle);
  for (const path of typeScriptPaths) {
    const text = readFileSync(join(repositoryRoot, path), "utf8");
    if (/\bapplyMigrations\s*\(/u.test(text)) applyPaths.push(path);
    if (isProductionTypeScriptSource(path, authority) && durableDdlStatementCount(text) > 0) {
      productionDdlPaths.push(path);
    }
    if (text.includes("test-action-chain-placeholder"))
      fail("implementation retains placeholder: " + path);
    if (text.includes("composeThreadGraphMigrations"))
      fail("implementation retains dynamic composer: " + path);
    if (isProductionTypeScriptSource(path, authority) && text.includes("supportedSchemaVersion")) {
      fail("implementation retains caller schema ceiling: " + path);
    }
    if (
      isProductionTypeScriptSource(path, authority) &&
      path !== oracle.canonicalRegistry.registryPath &&
      /export\s+const\s+[A-Za-z0-9]+Migrations\s*=/u.test(text)
    ) {
      fail("implementation retains aggregate migration registry: " + path);
    }
  }
  exactSet(
    applyPaths,
    authority.postImplementationApplyMigrationPaths,
    "implementation applyMigrations closure",
  );
  for (const path of directSqlPaths) {
    if (!authority.directSqlAllowedPaths.includes(path))
      fail("implementation direct SQL bypass: " + path);
  }
  for (const path of productionDdlPaths) {
    if (!canonicalDdlAllowed.has(path)) fail("implementation unregistered durable DDL: " + path);
  }

  const registryPath = join(repositoryRoot, oracle.canonicalRegistry.registryPath);
  const converterPath = join(repositoryRoot, oracle.canonicalRegistry.conversionPath);
  if (!existsSync(registryPath) || !existsSync(converterPath))
    fail("implementation registry/converter is absent");
  const registry = await import(
    pathToFileURL(registryPath).href + "?implementation-check=" + Date.now()
  );
  const converter = await import(
    pathToFileURL(converterPath).href + "?implementation-check=" + Date.now()
  );
  const projected = registry.canonicalDatabaseMigrations;
  if (!Array.isArray(projected)) fail("implemented canonicalDatabaseMigrations export is absent");
  exact(registry.CANONICAL_DATABASE_SCHEMA_VERSION, 27, "implemented schema version");
  exact(registry.NEXT_DATABASE_MIGRATION_VERSION, 28, "implemented next version");
  const runner = await import(
    pathToFileURL(join(repositoryRoot, "packages/storage/src/migration-runner.ts")).href
  );
  exact(
    projected.map((migration) => [
      migration.version,
      migration.name,
      runner.migrationContentHash(migration),
      migration.requiresForeignKeysOff === true,
    ]),
    oracle.canonicalRegistry.migrations.map((migration) => [
      migration.version,
      migration.name,
      migration.contentHash,
      migration.requiresForeignKeysOff,
    ]),
    "implemented registry projection",
  );
  for (const name of [
    "classifyMigrationHistory",
    "convertMigrationHistory",
    "verifyCanonicalMigrationState",
    "verifyCanonicalMigrationPrefixState",
    "canonicalRegistryDigestAtVersion",
    "installMigrationConversionInfrastructure",
  ]) {
    if (typeof converter[name] !== "function")
      fail("implemented converter export is absent: " + name);
  }
  const converterSource = readFileSync(converterPath, "utf8");
  const runnerSource = sourceMap.get("packages/storage/src/migration-runner.ts") ?? "";
  const openerSource = sourceMap.get("packages/storage/src/database.ts") ?? "";
  if (/target_registry_sha256\s*!==\s*CANONICAL_DATABASE_REGISTRY_SHA256/u.test(converterSource)) {
    fail("implemented converter equates historical target with live full registry");
  }
  if (!runnerSource.includes("beforePendingMigration"))
    fail("implemented runner lacks the locked pre-suffix provenance hook");
  if (!openerSource.includes("verifyCanonicalMigrationPrefixState"))
    fail("implemented opener does not supply the pre-suffix provenance verifier");
  const sequence = await implementationSequenceCheck(oracle);
  return {
    allowedPaths: allowed.size,
    semanticMigrationsValidated: projected.length,
    semanticIdentityDigest: runtime.semanticIdentityDigest,
    enumeratedPaths: allPaths.length,
    changedPaths: changed.size,
    typeScriptPaths: typeScriptPaths.length,
    applyMigrationPaths: applyPaths.length,
    sequence,
  };
}

function acceptedFileDrift(oracle) {
  const paths = new Map();
  for (const input of oracle.frozenInputs) paths.set(input.path, input.id);
  for (const migration of oracle.canonicalRegistry.migrations) {
    paths.set(migration.source, "MIGRATION-" + migration.version);
  }
  const drift = [];
  for (const [path, id] of paths) {
    let observed;
    try {
      observed = sha256(readFileSync(join(repositoryRoot, path)));
    } catch {
      drift.push({ id, path, acceptedSha256: sha256(readCommitted(path)), worktreeSha256: null });
      continue;
    }
    const accepted = sha256(readCommitted(path));
    if (observed !== accepted)
      drift.push({ id, path, acceptedSha256: accepted, worktreeSha256: observed });
  }
  return drift;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function table(headers, rows) {
  return [
    "| " + headers.map(escapeCell).join(" | ") + " |",
    "| " + headers.map(() => "---").join(" | ") + " |",
    ...rows.map((row) => "| " + row.map(escapeCell).join(" | ") + " |"),
  ].join("\n");
}

function renderDesign(oracle, digest) {
  const lines = [
    "# Canonical database migration registry v1",
    "",
    "Status: **frozen design for issue #233**. Implementation belongs to issue #234.",
    "",
    "Oracle SHA-256: `" + digest + "`.",
    "",
    "This checked view is generated from `database-migration-registry-oracle.v1.json`.",
    "",
    "## Result",
    "",
    "The application has **27 accepted semantic migrations**. Their one canonical contiguous order is 1 through 27. The exact next legal migration, including report creation, is **28**. The existing schema ceiling 11 is not a registry.",
    "",
    "`" +
      oracle.canonicalRegistry.registryPath +
      "` is the only production registry. `" +
      oracle.canonicalRegistry.conversionPath +
      "` owns exact historical conversion. Both are issue #234 deliverables; neither is implemented by this design issue.",
    "",
    "Package boundary: " + oracle.runtimeAuthority.packageBoundary,
    "",
    "## Canonical registry",
    "",
    table(
      [
        "Slot",
        "Semantic identity",
        "Legacy slot",
        "SHA-256",
        "FK mode",
        "Accepted issue",
        "Source",
      ],
      oracle.canonicalRegistry.migrations.map((row) => [
        row.version,
        row.id,
        row.declaredVersion ?? "unrecorded",
        "`" + row.contentHash + "`",
        row.requiresForeignKeysOff ? "off around transaction" : "on",
        "#" + row.acceptedIssue,
        "`" +
          row.source +
          "#" +
          row.export +
          "`" +
          (row.registrySource === undefined ? "" : "<br>registry: `" + row.registrySource + "`"),
      ]),
    ),
    "",
    "Order rule: " + oracle.canonicalRegistry.orderRule,
    "",
    "Checksum rule: " + oracle.checksumAuthority.immutability,
    "",
    "Registry identity SHA-256: `" + oracle.canonicalRegistry.identityDigest + "`.",
    "",
    "Legacy version rule: " + oracle.checksumAuthority.sourceVersionRule,
    "",
    "## Supported historical histories",
    "",
    oracle.historicalPolicy.supported,
    "",
    table(
      ["History", "Disposition", "Observed sequence", "Evidence paths"],
      oracle.observedCompositions.map((row) => [
        row.id,
        row.classification,
        row.sequence.join(" → ") +
          (row.unrecordedSql ? "; direct SQL: " + row.unrecordedSql.join(", ") : ""),
        row.evidence.map((path) => "`" + path + "`").join("<br>"),
      ]),
    ),
    "",
    "The accepted reindex schema was never recorded in those ledgers. It is classified independently:",
    "",
    table(
      ["Overlay", "Disposition", "Accepted state", "Conversion"],
      oracle.historicalSchemaOverlays.map((row) => [
        row.id,
        row.classification,
        row.state,
        row.conversion,
      ]),
    ),
    "",
    "Reindex operation names must match `" +
      oracle.reindexAuthority.operationNamePattern +
      "`. " +
      oracle.reindexAuthority.operationNameEncoding +
      ". " +
      oracle.reindexAuthority.replacementNameDerivation +
      ".",
    "",
    "The exact replacement family is " +
      oracle.reindexAuthority.replacementObjectFamily.map((name) => "`" + name + "`").join(", ") +
      ". The executable fixture uses `" +
      oracle.reindexAuthority.nondefaultFixtureOperationName +
      "` → `" +
      oracle.reindexAuthority.nondefaultFixtureReplacementName +
      "`, with complete tuple digest `" +
      oracle.reindexAuthority.nondefaultFixtureObjectTupleSha256 +
      "`. " +
      oracle.reindexAuthority.replacementObjectTupleDerivation,
    "",
    "Lease relation: " + oracle.reindexAuthority.leaseRelation,
    "",
    "Progress relation: " + oracle.reindexAuthority.progressRelation,
    "",
    "Counter relation: " + oracle.reindexAuthority.counterRelation,
    "",
    "Forged overlay cases: " + oracle.reindexAuthority.forgedCases.join("; ") + ".",
    "",
    "## Conversion and open behavior",
    "",
    "Classification: " + oracle.historicalPolicy.classification,
    "",
    "Backup first: " + oracle.historicalPolicy.conversionBackup,
    "",
    "Atomic conversion: " + oracle.historicalPolicy.conversionTransaction,
    "",
    "Schema feasibility: " + oracle.historicalPolicy.conversionFeasibility,
    "",
    "Backup capability: " + oracle.runtimeAuthority.conversionBackupCapability,
    "",
    "Schema fingerprint: " + oracle.historicalPolicy.schemaFingerprint,
    "",
    "Sequence derivation: " + oracle.preflightAuthority.sequenceSchemaDerivation,
    "",
    "Infrastructure exclusion gate: " + oracle.preflightAuthority.infrastructureExclusionGate,
    "",
    "Read-only source preflight: " + oracle.preflightAuthority.sourceAccess,
    "",
    "Scratch classification: " + oracle.preflightAuthority.scratchSnapshot,
    "",
    "Allowed scratch pragmas: " +
      oracle.preflightAuthority.allowedPragmas.map((pragma) => "`" + pragma + "`").join(", ") +
      ".",
    "",
    "Backup, barrier, and revalidation: " +
      oracle.preflightAuthority.backupThenLock +
      " " +
      oracle.preflightAuthority.lockedRevalidation,
    "",
    "Whole-tree probe: " + oracle.preflightAuthority.probeContract,
    "",
    "Conversion metadata: `" +
      oracle.conversionMetadata.table +
      "` layout v" +
      oracle.conversionMetadata.layoutVersion +
      " stores " +
      oracle.conversionMetadata.columns.join(", ") +
      ". " +
      oracle.conversionMetadata.immutability,
    "",
    "Canonical provenance encodings: " +
      oracle.conversionMetadata.historyEncoding +
      "; " +
      oracle.conversionMetadata.overlayEncoding +
      "; " +
      oracle.conversionMetadata.schemaEncoding +
      ".",
    "",
    "Shared provenance decoder: " +
      oracle.conversionMetadata.decoderAuthority +
      " " +
      oracle.conversionMetadata.crossFieldRelations,
    "",
    "### Append-stable historical targets",
    "",
    "Current registry identity: " + oracle.appendStableProvenance.currentRegistryIdentity + ".",
    "",
    "Historical target identity: " +
      oracle.appendStableProvenance.historicalTargetIdentity +
      " " +
      oracle.appendStableProvenance.targetRelations,
    "",
    table(
      ["Historical target", "Registry SHA-256"],
      oracle.appendStableProvenance.acceptedHistoricalTargets.map((target) => [
        target.targetVersion,
        "`" + target.targetRegistrySha256 + "`",
      ]),
    ),
    "",
    "Legacy conversion and suffix handoff:",
    "",
    ...oracle.appendStableProvenance.legacyConversionSequence.map(
      (step, index) => String(index + 1) + ". " + step,
    ),
    "",
    "Suffix transaction order:",
    "",
    ...oracle.appendStableProvenance.suffixTransactionOrder.map(
      (step, index) => String(index + 1) + ". " + step,
    ),
    "",
    "Proof-only suffixes: " +
      oracle.appendStableProvenance.proofSuffixes
        .map((suffix) => [suffix.version, suffix.name, suffix.contentHash].join(" / "))
        .join("; ") +
      ". " +
      oracle.appendStableProvenance.proofSuffixAuthority,
    "",
    "Operational rule: " + oracle.appendStableProvenance.operationRule,
    "",
    "Failure rule: " + oracle.appendStableProvenance.failureRule,
    "",
    "Issue #234 registry contract: " + oracle.appendStableProvenance.issue234RegistryContract,
    "",
    "Issue #234 converter contract: " + oracle.appendStableProvenance.issue234ConverterContract,
    "",
    "Issue #234 runner/open contract: " + oracle.appendStableProvenance.issue234RunnerContract,
    "",
    "Issue #234 opener handoff contract: " + oracle.appendStableProvenance.issue234OpenerContract,
    "",
    "Issue #234 preflight contract: " + oracle.appendStableProvenance.issue234PreflightContract,
    "",
    "Issue #234 proof contract: " + oracle.appendStableProvenance.issue234ProofContract,
    "",
    "Production sequence gate: `" +
      oracle.appendStableProvenance.implementationSequenceMode +
      "`; exact negative cases: " +
      oracle.appendStableProvenance.implementationSequenceMutationIds
        .map((id) => "`" + id + "`")
        .join(", ") +
      ".",
    "",
    "### Legacy fixture compatibility after registry append",
    "",
    oracle.runtimeAuthority.legacyFixtureCompatibility.entryPoint,
    "",
    "Recorder ownership: " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.registrationApi +
      " " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageBoundary,
    "",
    "Package named-export allowlist: " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist
        .map((name) => "`" + name + "`")
        .join(", ") +
      ". " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.moduleBoundaryRule,
    "",
    "Recorded state: " + oracle.runtimeAuthority.legacyFixtureCompatibility.stateAuthority,
    "",
    "Authority fingerprint: `" +
      oracle.runtimeAuthority.legacyFixtureCompatibility.fingerprintEncoding +
      "`. " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.fingerprintRule,
    "",
    "Compatibility adapter order:",
    "",
    ...oracle.runtimeAuthority.legacyFixtureCompatibility.adapterOrder.map(
      (step, index) => String(index + 1) + ". " + step,
    ),
    "",
    "Append rule: " + oracle.runtimeAuthority.legacyFixtureCompatibility.appendRule,
    "",
    "Strictness rule: " + oracle.runtimeAuthority.legacyFixtureCompatibility.strictnessRule,
    "",
    "Implementation gate: `" +
      oracle.runtimeAuthority.legacyFixtureCompatibility.implementationMode +
      "`; release probes " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.releaseProbeVersions.join(", ") +
      "; exact source mutations " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.implementationMutationIds
        .map((id) => "`" + id + "`")
        .join(", ") +
      ".",
    "",
    "Issue #234 compatibility proof: " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.issue234ProofContract,
    "",
    "Conversion identity: " + oracle.conversionMetadata.conversionId + ".",
    "",
    "Insertion gate: " + oracle.conversionMetadata.insertionGate,
    "",
    table(
      ["Provenance object", "SHA-256", "Exact SQL"],
      [
        [
          "table",
          oracle.conversionMetadata.ddl.tableSha256,
          oracle.conversionMetadata.ddl.tableSql,
        ],
        [
          "source identity index",
          oracle.conversionMetadata.ddl.indexSha256,
          oracle.conversionMetadata.ddl.indexSql,
        ],
        [
          "insert gate trigger",
          oracle.conversionMetadata.ddl.insertGateTriggerSha256,
          oracle.conversionMetadata.ddl.insertGateTriggerSql,
        ],
        [
          "update trigger",
          oracle.conversionMetadata.ddl.updateTriggerSha256,
          oracle.conversionMetadata.ddl.updateTriggerSql,
        ],
        [
          "delete trigger",
          oracle.conversionMetadata.ddl.deleteTriggerSha256,
          oracle.conversionMetadata.ddl.deleteTriggerSql,
        ],
      ].map(([name, hash, sql]) => [name, "`" + hash + "`", "`" + sql + "`"]),
    ),
    "",
    "DDL bundle SHA-256: `" + oracle.conversionMetadata.ddl.bundleSha256 + "`.",
    "",
    "Unknown history: " + oracle.historicalPolicy.unknownRule,
    "",
    "Every writable opener follows this order:",
    "",
    ...oracle.runtimeAuthority.openOrder.map((step, index) => String(index + 1) + ". " + step),
    "",
    "## Lifecycle contract",
    "",
    table(
      ["Case", "Input", "Expected result", "Allowed writes"],
      oracle.lifecycleCases.map((row) => [row.id, row.input, row.expected, row.writes]),
    ),
    "",
    "## Doctor, backup, and restore",
    "",
    "- Doctor: " + oracle.operationsAuthority.doctor,
    "",
    "- Backup: " + oracle.operationsAuthority.backup,
    "",
    "- Empty-root restore: " + oracle.operationsAuthority.emptyRootRestore,
    "",
    "- Full restore: " + oracle.operationsAuthority.fullRestore,
    "",
    "- Historical backup rule: " + oracle.operationsAuthority.restoreAuthority,
    "",
    "## Issue #234 implementation boundary",
    "",
    "Production paths:",
    "",
    ...oracle.issue234.productionPaths.map((path) => "- `" + path + "`"),
    "",
    "Focused and new test paths:",
    "",
    ...oracle.issue234.testPaths.map((path) => "- `" + path + "`"),
    "",
    "Composition corpus: " +
      oracle.issue234.compositionCorpus.files +
      " files / " +
      oracle.issue234.compositionCorpus.calls +
      " calls at `" +
      oracle.issue234.compositionCorpus.acceptedHead +
      "`, digest `" +
      oracle.issue234.compositionCorpus.sha256 +
      "`. " +
      oracle.issue234.compositionCorpus.implementationRule,
    "",
    "Semantic source scope: " + oracle.issue234.semanticSourceScope.allowedChanges,
    "",
    "Exact implementation allowlist: " +
      oracle.issue234.currentTreeAuthority.allowedMutationPathCount +
      " paths, including a " +
      oracle.issue234.currentTreeAuthority.semanticAllowedPaths.length +
      "-path semantic subunion exactly equal to `canonicalRegistry.migrations[].source`. " +
      oracle.issue234.currentTreeAuthority.semanticByteValidation,
    "",
    "Capacity execution roots: " +
      oracle.issue234.executionRootPaths.map((path) => "`" + path + "`").join(", ") +
      ".",
    "",
    "Current-tree acceptance modes: `" +
      oracle.issue234.currentTreeAuthority.mode +
      "` and tracked-only `" +
      oracle.issue234.currentTreeAuthority.scopeMode +
      "`. " +
      oracle.issue234.currentTreeAuthority.scopeModeRule +
      " " +
      oracle.issue234.currentTreeAuthority.enumeration +
      ". " +
      oracle.issue234.currentTreeAuthority.unknownPathRule,
    "",
    "Production-source DDL classifier: " +
      oracle.issue234.currentTreeAuthority.productionSourceClassification.rule +
      " Accepted adjacent inventory: " +
      oracle.issue234.currentTreeAuthority.productionSourceClassification.acceptedAdjacentInventory
        .count +
      " files at `" +
      oracle.issue234.currentTreeAuthority.productionSourceClassification.acceptedAdjacentInventory
        .acceptedHead +
      "`, digest `" +
      oracle.issue234.currentTreeAuthority.productionSourceClassification.acceptedAdjacentInventory
        .sha256 +
      "`; forms " +
      oracle.issue234.currentTreeAuthority.productionSourceClassification.acceptedAdjacentInventory.forms
        .map((row) => "`" + row.form + "`=" + row.count)
        .join(", ") +
      ". Positive fixture `" +
      oracle.issue234.currentTreeAuthority.productionSourceClassification.positiveFixture.path +
      "` is byte-identical to accepted SHA-256 `" +
      oracle.issue234.currentTreeAuthority.productionSourceClassification.positiveFixture
        .acceptedSha256 +
      "`, contains " +
      oracle.issue234.currentTreeAuthority.productionSourceClassification.positiveFixture
        .ddlStatements +
      " local DDL statements, and remains outside the 111-path mutation, canonical-DDL, and direct-SQL allowlists.",
    "",
    "Implemented registry proof: " + oracle.issue234.currentTreeAuthority.registryImport,
    "",
    "Implemented converter proof: " + oracle.issue234.currentTreeAuthority.converterImport,
    "",
    "Direct-SQL proof: " + oracle.issue234.currentTreeAuthority.directSqlDetection,
    "",
    "Source mutation proof: " + oracle.issue234.currentTreeAuthority.mutationExitRule,
    "",
    "Obligations:",
    "",
    ...oracle.issue234.obligations.map(
      (row, index) => String(index + 1) + ". **" + row.id + "**: " + row.text,
    ),
    "",
    "Report creation remains outside #234. It may consume slot 28 only after this registry is implemented and verified.",
    "",
  ];
  return lines.join("\n");
}

function renderDecisions(oracle, digest) {
  const lines = [
    "# Database migration registry decisions v1",
    "",
    "Status: **frozen design for issue #233**.",
    "",
    "Oracle SHA-256: `" + digest + "`.",
    "",
    "## Evidence baseline",
    "",
    table(
      ["Fact", "Accepted value"],
      [
        ["Shaping commit", "`" + ACCEPTED_HEAD + "`"],
        ["Production registry", oracle.baseline.productionRegistry],
        ["Production migration consumer", oracle.baseline.productionMigrationConsumer],
        [
          "Independent schema ceiling",
          oracle.baseline.defaultSchemaCeiling + "; " + oracle.baseline.ceilingDisposition,
        ],
        ["Accepted semantic migrations", oracle.baseline.acceptedSemanticMigrationCount],
        [
          "Actual composition corpus",
          oracle.baseline.applyMigrationSourceFiles +
            " files / " +
            oracle.baseline.applyMigrationCallSites +
            " calls / `" +
            oracle.baseline.applyMigrationCorpusSha256 +
            "`",
        ],
        [
          "Unsafe compatibility artifacts",
          oracle.baseline.placeholderOccurrences +
            " placeholders; " +
            oracle.baseline.dynamicThreadComposerOccurrences +
            " composer references; " +
            oracle.baseline.directAcceptedSqlBypassOccurrences +
            " direct SQL calls; " +
            oracle.baseline.adHocMigrationRegistryExports +
            " aggregate registry exports",
        ],
      ],
    ),
    "",
    "The repository has no production migration consumer, and no accepted evidence records a live or deployed database lineage. That absence allows automatic **lossless** conversion of exact source-observed ledgers. It does not authorize deletion, heuristic repair, or conversion of unknown files.",
    "",
    "## Frozen decisions",
    "",
    table(
      ["Decision", "Rule"],
      oracle.decisions.map((row) => [row.id, row.text]),
    ),
    "",
    "## Compatibility boundary",
    "",
    "Supported: " + oracle.historicalPolicy.supported,
    "",
    "Data preservation: " + oracle.historicalPolicy.dataRule,
    "",
    "Failure predecessor: " + oracle.historicalPolicy.prefixRule,
    "",
    "Repeated open: " + oracle.runtimeAuthority.repeatedOpen,
    "",
    "Newer version: " + oracle.runtimeAuthority.newerVersion,
    "",
    "Partial failure: " + oracle.runtimeAuthority.partialFailure,
    "",
    "Conversion provenance: " + oracle.runtimeAuthority.metadata,
    "",
    "Legacy fixture adapter: " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.appendRule +
      " " +
      oracle.runtimeAuthority.legacyFixtureCompatibility.strictnessRule,
    "",
    "## Rejected alternatives",
    "",
    table(
      ["Alternative", "Rejected choice", "Reason"],
      oracle.rejectedAlternatives.map((row) => [row.id, row.alternative, row.reason]),
    ),
    "",
    "## User decision and blockers",
    "",
    oracle.oracle.absenceOfDeploymentAuthority,
    "",
    "No user decision is required for this design. The blocker list is empty. Discovery of an external history that does not match the frozen whitelist is a new consequential compatibility decision and must stop before mutation.",
    "",
  ];
  return lines.join("\n");
}

function renderCoverage(oracle, digest) {
  const decisionMap = new Map(oracle.decisions.map((row) => [row.id, row.text]));
  const proofMap = new Map(oracle.proofs.map((row) => [row.id, row.postcondition]));
  const lines = [
    "# Database migration registry coverage v1",
    "",
    "Status: **frozen design for issue #233**.",
    "",
    "Oracle SHA-256: `" + digest + "`.",
    "",
    "## Requirement closure",
    "",
    table(
      ["Requirement", "Invariant", "Decision and proof coverage"],
      oracle.requirements.map((row) => [
        row.id,
        row.text,
        oracle.coverage[row.id]
          .map((id) => "**" + id + "**: " + (decisionMap.get(id) ?? proofMap.get(id)))
          .join("<br>"),
      ]),
    ),
    "",
    "## Required executable proofs for issue #234",
    "",
    table(
      ["Proof", "Kind", "Required postcondition"],
      oracle.proofs.map((row) => [row.id, row.kind, row.postcondition]),
    ),
    "",
    "The design checker closes all 27 accepted production DDL source files against the registry; classifies the exact 18-file accepted package-src test/fixture naming inventory and proves the unchanged selected-export local-DDL fixture is non-production without adding an allowlist exception; freezes all 62 TypeScript execution roots and 94 calls; executes the immutable source projection, fresh/repeated-open real-SQLite projection, append-stable legacy-fixture compatibility at release tips 27/28/29, schema-only convergence for all 44 convertible histories and 76 unique prefixes, all seven convertible reindex overlays plus 12 forgeries, 16 no-source-write preflight cases including every added/changed table/index/trigger/view adjacency with whole-tree and sidecar equality, and one shared strict provenance decoder through a real production legacy conversion to target 27 plus synthetic suffix/reopen/doctor/backup/empty/full-restore projections and five forged records. Dedicated implementation-sequence and implementation-compatibility gates import the real production converter/opener/runner. At exact release tips 27, 28, and 29, the compatibility child requires direct, early, and dynamic-equivalent recorder calls to verify the complete current-tip authority before WeakMap mutation and change zero serialized bytes; then runMigrations must rederive and byte-compare the fingerprint before its zero-write no-op. Each tip rejects eight invalid authorities through all three access forms, proves failed recording leaves three standalone fixtures unrecorded, and rejects five independent post-record tamper classes before fixture SQL with byte-identical state. Each access form also rejects a same-cardinality action_plans_state_idx replacement whose type/name/table remain fixed but SQL differs. After restoration it passes a standalone fixture registry: strict unrecorded apply must reject without changing bytes or creating the fixture table, while any leaked canonical marker would produce a detectable false no-op. A self-contained mutation stores that expected fingerprint on the verifier failure and rethrows, then is killed by this discriminator. The mutation runtime also first proves its exact verifier accepts valid authority before killing a count-only schema verifier. It proves strong and weak fingerprint implementations accept an initial valid reindex state, transitions to a second verifier-valid but fingerprint-distinct overlay state, revalidates that state with the strong verifier, and kills the weak constant only after observing its false no-op; precondition exceptions cannot count as kills. Verify-after-set remains covered. The exact eight-name storage index re-export is checked only as non-authoritative API hygiene; source reachability, recorder identifier counts, caller location, call order outside the recorder boundary, and dynamic-code capability bans are not security evidence. Domain-data parity, injected production crash hooks, operational doctor, filesystem backup/restore, and the complete Bun suite remain #234 implementation gates; this document does not claim them as implemented.",
    "",
    "## Retirement closure",
    "",
    table(
      ["Retirement", "Accepted baseline", "Issue #234 postcondition"],
      oracle.retirement.map((row) => [row.id, row.current, row.required]),
    ),
    "",
    "## Planning shields",
    "",
    table(
      ["Shield", "Applicability", "Proof shape"],
      oracle.shields.map((row) => [row.id, row.applicability, row.proof]),
    ),
    "",
    "## Frozen source evidence",
    "",
    table(
      ["Input", "Kind", "Path", "Accepted SHA-256"],
      oracle.frozenInputs.map((row) => [
        row.id,
        row.kind,
        "`" + row.path + "`",
        "`" + row.sha256 + "`",
      ]),
    ),
    "",
    "The accepted all-TypeScript `applyMigrations` corpus contains " +
      oracle.baseline.applyMigrationSourceFiles +
      " files and " +
      oracle.baseline.applyMigrationCallSites +
      " calls at digest `" +
      oracle.baseline.applyMigrationCorpusSha256 +
      "`. Observed compositions cover package execution roots, the runner remains its own authority, and both capacity scripts are explicit retirement and mutation targets; the standalone preview-consumption composer is also named.",
    "",
    "## Deterministic checks",
    "",
    "```sh",
    "bun docs/architecture/database-migration-registry-check.v1.mjs",
    "bun docs/architecture/database-migration-registry-check.v1.mjs --self-test",
    "bun docs/architecture/database-migration-registry-check.v1.mjs --source-self-test",
    "bun docs/architecture/database-migration-registry-check.v1.mjs --source-drift --json",
    "bun docs/architecture/database-migration-registry-check.v1.mjs --implementation-sequence-check",
    "bun docs/architecture/database-migration-registry-check.v1.mjs --implementation-compatibility-check",
    "bun docs/architecture/database-migration-registry-check.v1.mjs --digest",
    "bun run format:check -- docs/architecture/database-migration-registry-*.v1.*",
    "python3 .agents/skills/plan-agent-mail/scripts/check_plan.py",
    "```",
    "",
    "Issue #234 must make `--implementation-sequence-check` green with the real production converter and opener under live/synthetic suffixes 28/29, make `--implementation-compatibility-check` green for exact release tips 27/28/29, and run `bun test` before the complete scoped `--implementation-check`. The compatibility gate intentionally rejects the current literal-27 runner shortcut until #234 replaces it with the verified-handle fingerprint boundary.",
    "",
    "Checker mutations cover canonical identity/order, the all-TypeScript corpus and capacity roots, sequence-derived preflight effects/schema/order, strict provenance DDL/row/gate/trigger/domain/forgery checks, generic reindex grammar/full-object-tuple/counter forgeries, lifecycle and coverage closure, live-tip converter-loop, legacy-opener-bypass, literal fixture tip, caller ceiling, complete-fingerprint, same-cardinality/count-only schema, verifier-failure marker leakage, weak-constant, verify-after-set, exact package export-surface, and strict-runner-bypass counterexamples, the exact 111-path/27-semantic-source allowlist including removal and unrelated-addition negatives, current-tree deletion/rename allow/protect/import-alias/slot-20-sql-constant/registry-index/direct-bracket-at-find-destructuring/bypass policy, report-scope exclusion, blockers, and frozen-input drift. The source self-test launches one fresh checker process for each frozen source mutation over real accepted source bytes or explicit virtual Git source/test/deletion/rename records. Runtime children independently prove that recorder reachability is harmless because invalid authority cannot mutate compatibility state, rather than treating source exclusivity or dynamic-code syntax as trust.",
    "",
  ];
  return lines.join("\n");
}

function formatProjection(value, path) {
  try {
    return execFileSync("bunx", ["vp", "fmt", "--stdin-filepath=" + path], {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: value,
      maxBuffer: 32 * 1024 * 1024,
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
  ["status", (value) => (value.status = "draft")],
  ["slot-gap", (value) => (value.canonicalRegistry.migrations[2].version = 4)],
  ["row-reorder", (value) => value.canonicalRegistry.migrations.reverse()],
  ["name-drift", (value) => (value.canonicalRegistry.migrations[0].name = "messages")],
  [
    "checksum-drift",
    (value) => (value.canonicalRegistry.migrations[0].contentHash = "0".repeat(64)),
  ],
  [
    "execution-mode",
    (value) => (value.canonicalRegistry.migrations[25].requiresForeignKeysOff = false),
  ],
  ["unrecorded-version", (value) => (value.canonicalRegistry.migrations[19].declaredVersion = 20)],
  ["overlay-loss", (value) => value.historicalSchemaOverlays.pop()],
  ["next-slot", (value) => (value.canonicalRegistry.nextLegalReportMigrationVersion = 12)],
  ["registry-identity", (value) => (value.canonicalRegistry.identityDigest = "0".repeat(64))],
  ["source-kind", (value) => delete value.canonicalRegistry.migrations[19].sourceKind],
  ["ceiling-as-registry", (value) => (value.baseline.ceilingDisposition = "")],
  ["unknown-history", (value) => value.observedCompositions[0].sequence.push("unknown")],
  [
    "placeholder-convertible",
    (value) =>
      (value.observedCompositions.find((row) => row.id === "H-ACTION-PLACEHOLDER").classification =
        "convertible-ledger"),
  ],
  ["lifecycle-loss", (value) => value.lifecycleCases.pop()],
  ["coverage-loss", (value) => delete value.coverage["REQ-RESTORE"]],
  ["operations-loss", (value) => (value.operationsAuthority.fullRestore = "")],
  ["backup-capability-loss", (value) => (value.runtimeAuthority.conversionBackupCapability = "")],
  ["conversion-metadata-loss", (value) => value.conversionMetadata.columns.pop()],
  ["conversion-ddl", (value) => (value.conversionMetadata.ddl.tableSql += " ")],
  ["conversion-row-domain", (value) => (value.conversionMetadata.recordEncoding = "")],
  ["conversion-decoder", (value) => (value.conversionMetadata.decoderAuthority = "")],
  ["conversion-forgery", (value) => value.conversionMetadata.forgedCases.pop()],
  [
    "append-stability",
    (value) =>
      (value.appendStableProvenance.acceptedHistoricalTargets[0].targetRegistrySha256 = "0".repeat(
        64,
      )),
  ],
  [
    "accepted-target-widening",
    (value) =>
      value.appendStableProvenance.acceptedHistoricalTargets.push({
        targetVersion: 28,
        targetRegistrySha256: computeRegistryIdentityDigest([
          ...value.canonicalRegistry.migrations,
          value.appendStableProvenance.proofSuffixes[0],
        ]),
      }),
  ],
  [
    "verify-before-suffix",
    (value) => value.appendStableProvenance.suffixTransactionOrder.reverse(),
  ],
  [
    "converter-live-tip-loop",
    (value) =>
      (value.appendStableProvenance.legacyConversionSequence[1] =
        "iterate every canonicalDatabaseMigrations entry through the live tip"),
  ],
  [
    "legacy-opener-skips-suffix-runner",
    (value) =>
      (value.appendStableProvenance.legacyConversionSequence[4] =
        "run applyMigrations only in the non-legacy opener branch"),
  ],
  [
    "legacy-fixture-literal-tip",
    (value) => (value.runtimeAuthority.legacyFixtureCompatibility.appendRule = ""),
  ],
  [
    "legacy-fixture-caller-ceiling",
    (value) => (value.runtimeAuthority.legacyFixtureCompatibility.strictnessRule = ""),
  ],
  [
    "legacy-fixture-premature-record",
    (value) => value.runtimeAuthority.legacyFixtureCompatibility.adapterOrder.reverse(),
  ],
  [
    "legacy-fixture-fingerprint-bypass",
    (value) => (value.runtimeAuthority.legacyFixtureCompatibility.fingerprintRule = ""),
  ],
  [
    "legacy-fixture-unauthorized-recorder",
    (value) => (value.runtimeAuthority.legacyFixtureCompatibility.packageBoundary = ""),
  ],
  [
    "legacy-fixture-package-export-allowlist",
    (value) => value.runtimeAuthority.legacyFixtureCompatibility.packageNamedExportAllowlist.pop(),
  ],
  [
    "legacy-fixture-module-boundary",
    (value) => (value.runtimeAuthority.legacyFixtureCompatibility.moduleBoundaryRule = ""),
  ],
  [
    "strict-runner-compatibility-bypass",
    (value) => (value.runtimeAuthority.legacyFixtureCompatibility.entryPoint = ""),
  ],
  ["conversion-insert-gate", (value) => (value.conversionMetadata.insertionGate = "")],
  [
    "preflight-pragma",
    (value) => value.preflightAuthority.allowedPragmas.push("PRAGMA journal_mode = WAL"),
  ],
  ["preflight-effect", (value) => (value.preflightAuthority.sourceAccess = "")],
  [
    "preflight-sequence-schema",
    (value) => (value.preflightAuthority.sequenceSchemaDerivation = ""),
  ],
  ["preflight-schema-mutation", (value) => value.preflightAuthority.schemaMutationCases.pop()],
  ["preflight-open-order", (value) => value.runtimeAuthority.openOrder.pop()],
  ["reindex-grammar", (value) => (value.reindexAuthority.operationNamePattern = ".*")],
  ["reindex-family", (value) => value.reindexAuthority.replacementObjectFamily.pop()],
  [
    "reindex-object-tuples",
    (value) => (value.reindexAuthority.nondefaultFixtureObjectTupleSha256 = "0".repeat(64)),
  ],
  [
    "reindex-derivation",
    (value) => (value.reindexAuthority.nondefaultFixtureReplacementName = "forged"),
  ],
  ["reindex-forgery", (value) => value.reindexAuthority.forgedCases.pop()],
  ["corpus-scope", (value) => (value.issue234.compositionCorpus.files = 59)],
  ["corpus-selection", (value) => (value.issue234.compositionCorpus.selection += " packages/**")],
  ["execution-root", (value) => value.issue234.executionRootPaths.pop()],
  ["current-tree-protection", (value) => value.issue234.currentTreeAuthority.protectedPaths.pop()],
  [
    "production-source-classifier",
    (value) =>
      (value.issue234.currentTreeAuthority.productionSourceClassification.nonProductionRoleTokenPattern =
        ""),
  ],
  [
    "production-source-inventory",
    (value) =>
      value.issue234.currentTreeAuthority.productionSourceClassification.acceptedAdjacentInventory.paths.pop(),
  ],
  [
    "production-source-positive-fixture",
    (value) =>
      (value.issue234.currentTreeAuthority.productionSourceClassification.positiveFixture.path =
        "packages/cli/src/selected-export-command.ts"),
  ],
  [
    "semantic-allowlist-removal",
    (value) => value.issue234.currentTreeAuthority.semanticAllowedPaths.pop(),
  ],
  [
    "semantic-allowlist-unrelated",
    (value) =>
      value.issue234.currentTreeAuthority.semanticAllowedPaths.push(
        "packages/storage/src/unrelated-helper.ts",
      ),
  ],
  [
    "current-tree-bypass",
    (value) => value.issue234.currentTreeAuthority.postImplementationApplyMigrationPaths.pop(),
  ],
  ["source-mutation-scope", (value) => value.issue234.currentTreeAuthority.sourceMutationIds.pop()],
  [
    "direct-sql-authority",
    (value) => (value.issue234.currentTreeAuthority.directSqlDetection = ""),
  ],
  ["registry-relocation", (value) => delete value.canonicalRegistry.migrations[17].registrySource],
  [
    "report-scope",
    (value) => value.issue234.productionPaths.push("packages/storage/src/report-migration.ts"),
  ],
  ["blocker-invention", (value) => value.blockers.push("invented")],
  ["frozen-input", (value) => (value.frozenInputs[0].sha256 = "invalid")],
];

function runSelfTest(oracle) {
  const survived = [];
  for (const [id, mutate] of mutations) {
    const candidate = clone(oracle);
    mutate(candidate);
    try {
      validateOracle(candidate, { checkGit: false });
      survived.push(id);
    } catch {
      // Expected: each mutation violates one independently checked invariant.
    }
  }
  if (survived.length > 0) fail("mutation self-test survived: " + survived.join(", "));
  return mutations.length;
}

const oracleBytes = readFileSync(oraclePath);
const oracleDigest = sha256(oracleBytes);
let oracle;
try {
  oracle = JSON.parse(oracleBytes.toString("utf8"));
} catch {
  fail("oracle is not valid JSON");
}

const sourceMutationArgument = process.argv.find((value) => value.startsWith("--source-mutation="));
if (sourceMutationArgument !== undefined) {
  validateOracle(oracle, { checkGit: true });
  runSourceMutationChild(oracle, sourceMutationArgument.slice("--source-mutation=".length));
}

if (process.argv.includes("--weak-constant-fingerprint-child")) {
  validateOracle(oracle, { checkGit: true });
  await weakConstantFingerprintCompatibilityChild(oracle);
  process.stderr.write("weak constant fingerprint rejected by runtime matrix\n");
  process.exit(37);
}

if (process.argv.includes("--verify-after-set-child")) {
  validateOracle(oracle, { checkGit: true });
  await verifyAfterSetCompatibilityChild(oracle);
  process.stderr.write("verify-after-set rejected by runtime matrix\n");
  process.exit(38);
}

if (process.argv.includes("--count-only-schema-child")) {
  validateOracle(oracle, { checkGit: true });
  await countOnlySchemaCompatibilityChild(oracle);
  process.stderr.write("count-only schema verifier rejected by runtime matrix\n");
  process.exit(39);
}

if (process.argv.includes("--failure-marker-child")) {
  validateOracle(oracle, { checkGit: true });
  await failureStoresExpectedFingerprintCompatibilityChild(oracle);
  process.stderr.write("failure marker rejected by fixture discriminator\n");
  process.exit(40);
}

const compatibilityChildArgument = process.argv.find((value) =>
  value.startsWith("--compatibility-child="),
);
if (compatibilityChildArgument !== undefined) {
  validateOracle(oracle, { checkGit: true });
  const releaseVersion = Number.parseInt(
    compatibilityChildArgument.slice("--compatibility-child=".length),
    10,
  );
  if (![27, 28, 29].includes(releaseVersion)) fail("invalid compatibility child release");
  const childResult = await implementationCompatibilityChild(oracle, releaseVersion);
  process.stdout.write(JSON.stringify(childResult) + "\n");
  process.exit(0);
}

const validation = validateOracle(oracle, { checkGit: true });
const corpus = corpusProjection(oracle, validation.evidencePaths);
const schemaSources = schemaSourceProjection(oracle);
const productionSourceClassification = productionSourceClassificationProjection(oracle);
const migrationRunnerPackageBoundary = migrationRunnerPackageBoundaryProjection(oracle);
const runtime = await sourceProjection(oracle);
const sqlite = await freshSqliteProjection(oracle, runtime);
const legacyFixtureCompatibility = await legacyFixtureCompatibilityProjection(oracle, runtime);
const legacySchema = await legacySchemaProjection(oracle, runtime);
const reindexOverlays = await reindexOverlayProjection(oracle, runtime);
const preflight = await preflightProjection(oracle, runtime);
const provenance = await provenanceProjection(oracle, runtime);
const implementationSequence = process.argv.includes(
  oracle.appendStableProvenance.implementationSequenceMode,
)
  ? await implementationSequenceCheck(oracle)
  : null;
const implementationCompatibility = process.argv.includes(
  oracle.runtimeAuthority.legacyFixtureCompatibility.implementationMode,
)
  ? implementationCompatibilityCheck(oracle)
  : null;
const implementationScope = process.argv.includes(oracle.issue234.currentTreeAuthority.scopeMode)
  ? implementationScopeProjection(oracle, runtime)
  : null;
const implementation = process.argv.includes("--implementation-check")
  ? await implementationCheck(oracle, runtime)
  : null;

if (process.argv.includes("--write-views")) {
  const rendered = projections(oracle, oracleDigest);
  for (const [index, path] of viewPaths.entries()) writeFileSync(path, rendered[index]);
  process.stdout.write(
    JSON.stringify({ written: viewPaths.map((path) => relative(repositoryRoot, path)) }) + "\n",
  );
  process.exit(0);
}

const printView = process.argv.find((value) => value.startsWith("--print-view="));
if (printView !== undefined) {
  const index = Number.parseInt(printView.slice("--print-view=".length), 10);
  const rendered = projections(oracle, oracleDigest);
  if (!Number.isSafeInteger(index) || rendered[index] === undefined) fail("invalid view index");
  process.stdout.write(rendered[index]);
  process.exit(0);
}

if (oracleDigest !== EXPECTED_ORACLE_SHA256) fail("oracle digest differs: " + oracleDigest);

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
  if (digest !== EXPECTED_VIEW_SHA256[index])
    fail("checked view digest differs: " + path + " " + digest);
}

const mutationCount = process.argv.includes("--self-test") ? runSelfTest(oracle) : 0;
const sourceMutationCount = process.argv.includes("--source-self-test")
  ? runSourceSelfTest(oracle)
  : 0;
const fileDrift = acceptedFileDrift(oracle);
const result = {
  ok: true,
  acceptedHead: ACCEPTED_HEAD,
  oracleSha256: oracleDigest,
  viewSha256: EXPECTED_VIEW_SHA256,
  canonicalMigrations: oracle.canonicalRegistry.migrations.length,
  schemaVersion: oracle.canonicalRegistry.schemaVersion,
  nextLegalMigrationVersion: oracle.canonicalRegistry.nextLegalMigrationVersion,
  observedCompositions: oracle.observedCompositions.length,
  corpus,
  schemaSources,
  productionSourceClassification,
  migrationRunnerPackageBoundary,
  semanticSources: {
    paths: oracle.issue234.currentTreeAuthority.semanticAllowedPaths.length,
    identityDigest: runtime.semanticIdentityDigest,
    drift: [],
  },
  sqlite,
  legacyFixtureCompatibility,
  legacySchema,
  reindexOverlays,
  preflight,
  provenance,
  implementationSequence,
  implementationCompatibility,
  implementationScope,
  implementation,
  mutations: mutationCount,
  sourceMutations: sourceMutationCount,
  sourceDrift: [],
  acceptedFileDrift: fileDrift,
};

if (process.argv.includes("--digest")) {
  process.stdout.write(
    JSON.stringify({ oracleSha256: oracleDigest, viewSha256: EXPECTED_VIEW_SHA256 }) + "\n",
  );
} else if (process.argv.includes("--source-drift") || process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  process.stdout.write(JSON.stringify(result) + "\n");
}
