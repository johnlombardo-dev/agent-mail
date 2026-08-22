import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const manifestDefaultPath = join(
  repositoryRoot,
  "docs/architecture/release-evidence-execution-manifest.v2.json",
);
const receiptFormat = "agent-mail.executable-receipt/v2";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(`release evidence capture failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 32 * 1024 * 1024 }).trim();
}

function gitStatus(root) {
  return gitStatusEntries(root).map((entry) => entry.path);
}

function gitStatusEntries(root) {
  return execFileSync("git", ["status", "--short", "--untracked-files=all", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
}

function repositorySnapshot(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
    status: gitStatus(root),
    submodules: git(root, ["submodule", "status", "--recursive"]),
  };
}

function isAllowedUntracked(path, allowlist = []) {
  const normalized = path.replace(/\/+$/u, "");
  return allowlist.some((entry) => normalized === entry.replace(/\/+$/u, ""));
}

function assertCleanCandidate(root, allowlist = []) {
  const snapshot = repositorySnapshot(root);
  const forbidden = gitStatusEntries(root).filter(
    (entry) => entry.code !== "??" || !isAllowedUntracked(entry.path, allowlist),
  );
  assert(
    forbidden.length === 0,
    `candidate worktree is dirty: ${forbidden.map((entry) => `${entry.code} ${entry.path}`).join(", ")}`,
  );
  return snapshot;
}

function installFrozenDependencies(checkout, manifest, { selfTest = false } = {}) {
  const dependencyMode = manifest.runner?.dependencyMode;
  if (selfTest) return { mode: "bun-frozen-offline", installed: false, selfTest: true };
  if (!dependencyMode) return { mode: "none", installed: false };
  assert(dependencyMode === "bun-frozen-offline", "unsupported dependency mode");
  assert(
    existsSync(join(checkout, "package.json")) && existsSync(join(checkout, "bun.lock")),
    "frozen dependency inputs are missing",
  );
  execFileSync("bun", ["install", "--frozen-lockfile", "--offline"], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const status = gitStatusEntries(checkout);
  const dependencyDrift = status.filter((entry) => {
    const normalized = entry.path.replace(/\/+$/u, "");
    return !(
      entry.code === "??" &&
      (normalized === "node_modules" ||
        normalized.startsWith("node_modules/") ||
        normalized === "packages/cli/node_modules" ||
        normalized.startsWith("packages/cli/node_modules/") ||
        normalized === "packages/daemon/node_modules" ||
        normalized.startsWith("packages/daemon/node_modules/") ||
        normalized === "packages/imap/node_modules" ||
        normalized.startsWith("packages/imap/node_modules/") ||
        normalized === "packages/storage/node_modules" ||
        normalized.startsWith("packages/storage/node_modules/"))
    );
  });
  assert(
    dependencyDrift.length === 0,
    `dependency install changed committed candidate files: ${dependencyDrift
      .slice(0, 3)
      .map((entry) => `${entry.code} ${entry.path}`)
      .join(", ")}`,
  );
  return {
    mode: dependencyMode,
    installed: true,
    packageManifestSha256: sha256(readFileSync(join(checkout, "package.json"))),
    lockfileSha256: sha256(readFileSync(join(checkout, "bun.lock"))),
  };
}

function regularPath(root, path, label) {
  assert(typeof path === "string" && path.length > 0, `${label} path is missing`);
  assert(!isAbsolute(path) && !path.includes("\\"), `${label} path is not candidate-relative`);
  const normalized = path.split("/");
  assert(
    normalized.every((part) => part && part !== "." && part !== ".."),
    `${label} path traverses`,
  );
  const absolute = resolve(root, path);
  assert(relative(root, absolute) === path, `${label} path escapes repository`);
  const stat = lstatSync(absolute);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
  return absolute;
}

function committedBlob(root, commit, path, label) {
  const entry = git(root, ["ls-tree", "-z", commit, "--", path]).replace(/\0+$/u, "");
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
  assert(match?.[3] === path, `${label} is not a regular committed blob`);
  const bytes = execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { bytes, gitBlob: match[2], sha256: sha256(bytes) };
}

function committedText(root, commit, path, label) {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    fail(`${label} is not committed`);
  }
}

function sourceBindings(manifest, root, commit) {
  const all = [];
  for (const step of manifest.steps) {
    for (const source of step.sources ?? []) all.push(source);
  }
  for (const source of manifest.runner?.sources ?? []) all.push(source);
  const unique = new Map();
  for (const source of all) {
    const previous = unique.get(source.path);
    assert(
      !previous || (previous.gitBlob === source.gitBlob && previous.sha256 === source.sha256),
      `source ${source.path} binding is inconsistent`,
    );
    unique.set(source.path, source);
  }
  return [...unique.values()].map((source) => {
    const actual = committedBlob(root, commit, source.path, `source ${source.path}`);
    assert(source.gitBlob === actual.gitBlob, `source ${source.path} Git blob drifted`);
    assert(source.sha256 === actual.sha256, `source ${source.path} SHA-256 drifted`);
    return {
      role: source.role,
      path: source.path,
      gitBlob: actual.gitBlob,
      sha256: actual.sha256,
    };
  });
}

function stepSourceBindings(step, root, commit) {
  const seen = new Set();
  return (step.sources ?? []).map((source) => {
    assert(!seen.has(source.path), `${step.id} source binding repeats ${source.path}`);
    seen.add(source.path);
    const actual = committedBlob(root, commit, source.path, `${step.id} source ${source.path}`);
    assert(source.gitBlob === actual.gitBlob, `${step.id} source ${source.path} Git blob drifted`);
    assert(source.sha256 === actual.sha256, `${step.id} source ${source.path} SHA-256 drifted`);
    return { role: source.role, path: source.path, gitBlob: actual.gitBlob, sha256: actual.sha256 };
  });
}

function validateAssertion(assertion, step) {
  assert(assertion && typeof assertion.id === "string", `${step.id} assertion id is missing`);
  assert(typeof assertion.kind === "string", `${step.id} assertion kind is missing`);
  if (assertion.kind === "source-token") {
    assert(
      step.sources.some((source) => source.path === assertion.sourcePath),
      `${step.id} source-token assertion is not source-bound`,
    );
    assert(
      typeof assertion.token === "string" && assertion.token.length > 0,
      `${step.id} source token is missing`,
    );
    assert(
      Number.isSafeInteger(assertion.occurrences) && assertion.occurrences >= 1,
      `${step.id} source token occurrence count is invalid`,
    );
  } else if (assertion.kind === "fixture-observation") {
    assert(
      step.sources.some((source) => source.path === assertion.sourcePath),
      `${step.id} fixture observation is not source-bound`,
    );
    assert(
      typeof assertion.fixtureId === "string" && assertion.fixtureId.length > 0,
      `${step.id} fixture observation id is missing`,
    );
    assert(
      Number.isSafeInteger(assertion.expectedBytes) && assertion.expectedBytes > 0,
      `${step.id} fixture observation byte target is invalid`,
    );
  } else if (assertion.kind === "structured-oracle") {
    assert(
      typeof assertion.event === "string" && assertion.event.length > 0,
      `${step.id} oracle event is missing`,
    );
    assert(
      typeof assertion.path === "string" &&
        step.sources.some((source) => source.path === assertion.path),
      `${step.id} oracle path is not source-bound`,
    );
    assert(/^[0-9a-f]{64}$/u.test(assertion.sha256 ?? ""), `${step.id} oracle digest is missing`);
    assert(
      typeof assertion.pointer === "string" && assertion.pointer.startsWith("/"),
      `${step.id} oracle pointer is missing`,
    );
    assert(assertion.value !== undefined, `${step.id} oracle value is missing`);
  } else if (assertion.kind === "exitCode") {
    assert(Number.isInteger(assertion.expected), `${step.id} exit expectation is invalid`);
  } else {
    fail(`${step.id} assertion kind ${assertion.kind} is not runner-supported`);
  }
}

function resolveJsonPointer(document, pointer) {
  assert(pointer === "" || pointer.startsWith("/"), "oracle JSON pointer is invalid");
  let value = document;
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    assert(
      value !== null && value !== undefined && Object.hasOwn(value, key),
      "oracle JSON pointer is missing",
    );
    value = value[key];
  }
  return value;
}

function deepJsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function validateManifest(
  manifest,
  root,
  commit = git(root, ["rev-parse", "HEAD"]),
  { selfTest = false } = {},
) {
  assert(
    manifest?.format === "agent-mail.release-evidence-execution-manifest/v2",
    "manifest format",
  );
  assert(manifest.schemaVersion === 2, "manifest schema version");
  assert(manifest.ownerIssueId === 176, "manifest owner is not #176");
  assert(Array.isArray(manifest.steps) && manifest.steps.length > 0, "manifest steps are missing");
  assert(manifest.replay?.required === true, "independent replay is not required");
  assert(
    Array.isArray(manifest.attackInventory) && manifest.attackInventory.length >= 40,
    "attack inventory is incomplete",
  );
  assert(
    new Set(manifest.attackInventory).size === manifest.attackInventory.length,
    "attack inventory repeats a seam",
  );
  for (const path of manifest.runner?.untrackedAllowlist ?? []) {
    assert(
      typeof path === "string" &&
        path.length > 0 &&
        !isAbsolute(path) &&
        !path.includes("\\") &&
        path.split("/").every((part) => part && part !== "." && part !== ".."),
      "runner untracked allowlist is malformed",
    );
  }
  if (!selfTest) {
    assert(
      manifest.runner?.dependencyMode === "bun-frozen-offline",
      "runner dependency mode must be bun-frozen-offline",
    );
    assert(
      Array.isArray(manifest.runner?.sources) && manifest.runner.sources.length > 0,
      "runner source bindings are missing",
    );
    for (const source of manifest.runner.sources) {
      assert(source.role && typeof source.path === "string", "runner source binding is incomplete");
      assert(/^[0-9a-f]{40}$/u.test(source.gitBlob ?? ""), "runner source Git blob is missing");
      assert(/^[0-9a-f]{64}$/u.test(source.sha256 ?? ""), "runner source SHA-256 is missing");
    }
  }
  const seen = new Set();
  for (const step of manifest.steps) {
    assert(typeof step.id === "string" && !seen.has(step.id), `duplicate manifest step ${step.id}`);
    seen.add(step.id);
    assert(Array.isArray(step.argv) && step.argv.length > 1, `${step.id} argv is missing`);
    assert(
      step.argv.every((arg) => typeof arg === "string" && arg.length > 0),
      `${step.id} argv is malformed`,
    );
    assert(
      ["bun", "node", "python3", "swift", "xcodebuild"].includes(step.argv[0]),
      `${step.id} executable is not allowlisted`,
    );
    assert(typeof step.cwd === "string" && !isAbsolute(step.cwd), `${step.id} cwd is not relative`);
    assert(step.cwd === "." || !step.cwd.split("/").includes(".."), `${step.id} cwd traverses`);
    assert(
      Array.isArray(step.sources) && step.sources.length > 0,
      `${step.id} source bindings are missing`,
    );
    for (const source of step.sources) {
      assert(
        source.role && typeof source.path === "string",
        `${step.id} source binding is incomplete`,
      );
      assert(/^[0-9a-f]{40}$/u.test(source.gitBlob ?? ""), `${step.id} source Git blob is missing`);
      assert(/^[0-9a-f]{64}$/u.test(source.sha256 ?? ""), `${step.id} source SHA-256 is missing`);
    }
    assert(
      Array.isArray(step.assertions) && step.assertions.length > 0,
      `${step.id} assertions are missing`,
    );
    const assertionIds = new Set();
    for (const assertion of step.assertions) {
      assert(!assertionIds.has(assertion.id), `${step.id} assertion id repeats`);
      assertionIds.add(assertion.id);
    }
    for (const assertion of step.assertions) validateAssertion(assertion, step);
    for (const assertion of step.assertions.filter(
      (candidate) => candidate.kind === "structured-oracle",
    )) {
      const source = step.sources.find((candidate) => candidate.path === assertion.path);
      assert(source.sha256 === assertion.sha256, `${step.id} oracle digest is detached`);
    }
    assert(
      step.observations && step.thresholds && Array.isArray(step.probes),
      `${step.id} observation authority is incomplete`,
    );
    const allowedProbes = new Set([
      "processTreeRss",
      "fileDescriptors",
      "sockets",
      "listeners",
      "HermesLease",
      "streams",
      "tempRoot",
      "streamCompletion",
      "sqliteIntegrity",
      "sqliteForeignKeys",
      "queryPlan",
      "sqliteClose",
      "queueCompletion",
      "childActors",
      "process",
    ]);
    for (const probe of step.probes)
      assert(
        typeof probe === "string" && allowedProbes.has(probe),
        `${step.id} probe is not allowlisted`,
      );
    for (const [metric, threshold] of Object.entries(step.thresholds)) {
      if (metric === "timeoutMs") continue;
      const probeThreshold = {
        processRssBytes: ["kernel:ps", "bytes"],
        fileDescriptors: ["kernel:lsof", "descriptors"],
        sockets: ["kernel:lsof", "sockets"],
        listeners: ["kernel:lsof", "listeners"],
      }[metric];
      assert(
        threshold &&
          typeof threshold.source === "string" &&
          threshold.source.length > 0 &&
          ["<", "<=", "===", ">=", ">"].includes(threshold.operator) &&
          typeof threshold.unit === "string" &&
          threshold.unit.length > 0 &&
          Number.isFinite(threshold.limit) &&
          threshold.limit >= 0 &&
          (!probeThreshold ||
            (threshold.source === probeThreshold[0] && threshold.unit === probeThreshold[1])),
        `${step.id} threshold ${metric} source/operator/unit is incomplete`,
      );
    }
    if (step.fixture !== undefined) {
      assert(
        step.fixture &&
          ["generated-stream", "generated-file", "committed-bytes"].includes(step.fixture.kind),
        `${step.id} fixture kind is invalid`,
      );
      assert(
        typeof step.fixture.id === "string" &&
          step.fixture.id.length > 0 &&
          !isAbsolute(step.fixture.id) &&
          !step.fixture.id.includes("\\") &&
          step.fixture.id.split("/").every((part) => part && part !== "." && part !== ".."),
        `${step.id} fixture id is unsafe`,
      );
      if (step.fixture.kind === "generated-stream" && step.fixture.minimumBytes !== undefined) {
        assert(
          Number.isSafeInteger(step.fixture.minimumBytes) && step.fixture.minimumBytes >= 0,
          `${step.id} stream fixture size is invalid`,
        );
      }
      if (step.fixture.kind === "generated-file" && step.fixture.generationStepId !== undefined) {
        assert(
          typeof step.fixture.generationStepId === "string" &&
            step.fixture.generationStepId.length > 0 &&
            step.fixture.generationStepId !== step.id &&
            seen.has(step.fixture.generationStepId),
          `${step.id} generation receipt source is invalid`,
        );
      }
    }
    const helperPath = "scripts/capacity/source-token-event.ts";
    const importsSourceTokenHelper = step.sources.some((source) => {
      if (source.path === helperPath) return false;
      try {
        return committedText(root, commit, source.path, `${step.id} source`).includes(
          "source-token-event",
        );
      } catch {
        return false;
      }
    });
    if (importsSourceTokenHelper) {
      assert(
        step.sources.some((source) => source.path === helperPath),
        `${step.id} source-token helper binding is missing`,
      );
    }
  }
  const bindings = sourceBindings(manifest, root, commit);
  assert(bindings.length > 0, "manifest has no source bindings");
  return bindings;
}

function runtimeDigest() {
  try {
    return sha256(readFileSync(process.execPath));
  } catch {
    return null;
  }
}

function optionalDigest(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function ownerRelativePath(root, path, label) {
  const rootPath = resolve(root);
  const absolutePath = resolve(path);
  const relativePath = relative(rootPath, absolutePath);
  assert(
    relativePath.length > 0 &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath) &&
      !relativePath.includes("\\") &&
      relativePath.split("/").every((part) => part && part !== "." && part !== ".."),
    `${label} path escaped owner root`,
  );
  return relativePath;
}

function fileDigest(path, label) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function outputRef(root, outputRoot, runId, filename, bytes) {
  const path = join(outputRoot, runId, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  return retainedFileRef(root, outputRoot, path, bytes.length, sha256(bytes), "output");
}

function retainedFileRef(root, outputRoot, path, expectedBytes, expectedSha256, label) {
  const relativePath = ownerRelativePath(root, path, label);
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  assert(bytes.length === expectedBytes, `${label} byte count drifted`);
  assert(digest === expectedSha256, `${label} digest drifted`);
  return { path: relativePath, sha256: digest, bytes: bytes.length };
}

function assertAbsent(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`${label} already exists before execution (${stat.isSymbolicLink() ? "symlink" : "path"})`);
}

export function cleanGeneratedStaging(path) {
  for (const suffix of ["", ".inventory.json", "-wal", "-shm"]) {
    const candidate = `${path}${suffix}`;
    if (existsSync(candidate)) rmSync(candidate, { force: true });
  }
}

export function retainGeneratedArtifact(outputRoot, fixture, sourcePath, runId) {
  const source = fileDigest(sourcePath, "generated SQLite artifact");
  const sourceInventoryPath = `${sourcePath}.inventory.json`;
  const sourceInventory = fileDigest(sourceInventoryPath, "generated inventory");
  const inventory = JSON.parse(readFileSync(sourceInventoryPath, "utf8"));
  assert(
    typeof inventory.logicalChecksum === "string" &&
      /^[0-9a-f]{64}$/u.test(inventory.logicalChecksum),
    "generated inventory logical checksum is missing",
  );
  const retainedPath = join(
    outputRoot,
    runId,
    "retained",
    `${fixture.id ?? "generated-artifact"}.sqlite`,
  );
  const retainedInventoryPath = `${retainedPath}.inventory.json`;
  mkdirSync(dirname(retainedPath), { recursive: true });
  assertAbsent(retainedPath, "retained generated SQLite artifact");
  assertAbsent(retainedInventoryPath, "retained generated inventory");
  cpSync(sourcePath, retainedPath);
  cpSync(sourceInventoryPath, retainedInventoryPath);
  const retained = fileDigest(retainedPath, "retained generated SQLite artifact");
  const retainedInventory = fileDigest(retainedInventoryPath, "retained generated inventory");
  assert(
    retained.sha256 === source.sha256 && retained.bytes === source.bytes,
    "retained generated SQLite artifact drifted",
  );
  assert(
    retainedInventory.sha256 === sourceInventory.sha256 &&
      retainedInventory.bytes === sourceInventory.bytes,
    "retained generated inventory drifted",
  );
  return {
    path: retainedPath,
    relativePath: ownerRelativePath(outputRoot, retainedPath, "retained generated artifact"),
    inventoryPath: retainedInventoryPath,
    inventoryRelativePath: ownerRelativePath(
      outputRoot,
      retainedInventoryPath,
      "retained generated inventory",
    ),
    artifactSha256: retained.sha256,
    artifactBytes: retained.bytes,
    inventorySha256: retainedInventory.sha256,
    inventoryBytes: retainedInventory.bytes,
    logicalChecksum: inventory.logicalChecksum,
  };
}

async function validateGeneratedSearchArtifact(path, checkout, expectedInventory) {
  const physical = fileDigest(path, "search artifact");
  const inventoryPath = `${path}.inventory.json`;
  const inventoryStat = lstatSync(inventoryPath);
  assert(
    inventoryStat.isFile() && !inventoryStat.isSymbolicLink(),
    "search inventory is not a regular non-symlink file",
  );
  const inventoryBytes = readFileSync(inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  assert(inventory.messages === 250000, "search inventory row count drifted");
  assert(inventory.bytes === physical.bytes, "search inventory byte count drifted");
  assert(
    typeof inventory.logicalChecksum === "string" &&
      /^[0-9a-f]{64}$/u.test(inventory.logicalChecksum),
    "search logical checksum is missing",
  );
  if (expectedInventory !== undefined)
    assert(
      canonicalJson(inventory) === canonicalJson(expectedInventory),
      "search inventory drifted",
    );
  const generator = await import(
    pathToFileURL(join(repositoryRoot, "scripts/capacity/generate-search-corpus.ts")).href
  );
  const sqlite = await import("bun:sqlite");
  const database = new sqlite.Database(path);
  try {
    generator.validateCorpusInventory(database, inventory);
  } finally {
    database.close();
  }
  const after = fileDigest(path, "search artifact");
  assert(
    after.sha256 === physical.sha256 && after.bytes === physical.bytes,
    "search artifact changed during validation",
  );
  return {
    physicalSha256: physical.sha256,
    bytes: physical.bytes,
    inventorySha256: sha256(inventoryBytes),
    logicalChecksum: inventory.logicalChecksum,
    inventory,
  };
}

export function generationReceipt(receiptPath, outputRoot, fixture, candidateCommit) {
  assert(receiptPath, `${fixture.id} requires a prior generation receipt`);
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  assert(receipt.format === receiptFormat, "generation receipt format is invalid");
  assert(receipt.result === "pass", "generation receipt is not passing");
  assert(
    receipt.manifestStepId === fixture.generationStepId,
    "generation receipt step is detached",
  );
  assert(receipt.candidate?.commit === candidateCommit, "generation receipt candidate is stale");
  const generated = receipt.fixture?.materialized;
  assert(
    generated?.owner === "generator" && generated.presentAfterRun === true,
    "generation receipt fixture is invalid",
  );
  assert(
    /^[0-9a-f]{64}$/u.test(generated.sha256 ?? ""),
    "generation receipt artifact digest is missing",
  );
  assert(
    Number.isSafeInteger(generated.bytes) && generated.bytes > 0,
    "generation receipt artifact bytes are invalid",
  );
  const sourcePath = resolve(outputRoot, generated.path);
  ownerRelativePath(outputRoot, sourcePath, "generation artifact");
  const actual = fileDigest(sourcePath, "generation artifact");
  assert(
    actual.sha256 === generated.sha256 && actual.bytes === generated.bytes,
    "generation artifact drifted",
  );
  const generatedInventory = generated.integrity;
  assert(
    generatedInventory &&
      /^[0-9a-f]{64}$/u.test(generatedInventory.inventorySha256 ?? "") &&
      Number.isSafeInteger(generatedInventory.inventoryBytes) &&
      generatedInventory.inventoryBytes > 0 &&
      /^[0-9a-f]{64}$/u.test(generatedInventory.logicalChecksum ?? ""),
    "generation receipt inventory binding is missing",
  );
  const inventoryPath = `${sourcePath}.inventory.json`;
  const inventory = fileDigest(inventoryPath, "generation inventory");
  const inventoryValue = JSON.parse(readFileSync(inventoryPath, "utf8"));
  assert(
    inventory.sha256 === generatedInventory.inventorySha256 &&
      inventory.bytes === generatedInventory.inventoryBytes &&
      inventoryValue.logicalChecksum === generatedInventory.logicalChecksum,
    "generation inventory drifted",
  );
  const receiptAbsolute = resolve(receiptPath);
  const receiptDigest = sha256(receiptBytes);
  return {
    receiptPath: receiptAbsolute,
    receiptSha256: receiptDigest,
    artifactPath: sourcePath,
    artifactRelativePath: ownerRelativePath(outputRoot, sourcePath, "generation artifact"),
    artifactSha256: actual.sha256,
    artifactBytes: actual.bytes,
    inventoryPath,
    inventoryRelativePath: ownerRelativePath(outputRoot, inventoryPath, "generation inventory"),
    inventorySha256: inventory.sha256,
    inventoryBytes: inventory.bytes,
    logicalChecksum: generatedInventory.logicalChecksum,
  };
}

async function finalizeFixture(fixture, outputRoot, fixturePath, checkout, integrityBefore) {
  if (!fixture?.materialized) return fixture;
  if (fixture.materialized.owner === "observation") return fixture;
  if (fixture.materialized.owner === "generator") {
    ownerRelativePath(outputRoot, fixturePath, "generator fixture");
    const physical = fileDigest(fixturePath, "generator fixture");
    const integrity =
      fixture.rowCount === 250000
        ? await validateGeneratedSearchArtifact(fixturePath, checkout)
        : undefined;
    const inventory = integrity
      ? fileDigest(`${fixturePath}.inventory.json`, "generator inventory")
      : undefined;
    return {
      ...fixture,
      materialized: {
        ...fixture.materialized,
        presentAfterRun: true,
        sha256: physical.sha256,
        bytes: physical.bytes,
        integrity: integrity
          ? { ...integrity, inventorySha256: inventory.sha256, inventoryBytes: inventory.bytes }
          : undefined,
      },
    };
  }
  const materialized = retainedFileRef(
    outputRoot,
    outputRoot,
    fixturePath,
    fixture.materialized.bytes,
    fixture.materialized.sha256,
    "fixture",
  );
  if (integrityBefore !== undefined) {
    const integrityAfter = await validateGeneratedSearchArtifact(
      fixturePath,
      checkout,
      integrityBefore.inventory,
    );
    assert(
      integrityAfter.physicalSha256 === integrityBefore.physicalSha256 &&
        integrityAfter.bytes === integrityBefore.bytes &&
        integrityAfter.logicalChecksum === integrityBefore.logicalChecksum,
      "fixture changed during measurement",
    );
    materialized.integrity = { before: integrityBefore, after: integrityAfter, unchanged: true };
  }
  return { ...fixture, materialized };
}

function now() {
  return new Date().toISOString();
}

function runProcess(argv, cwd, timeoutMs) {
  return new Promise((resolveResult) => {
    const started = process.hrtime.bigint();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const spawnedAt = processTreeSnapshot(child.pid);
    const treeSamples = [spawnedAt];
    const resourceAtSpawn = kernelResourceSnapshot(spawnedAt.pids ?? [child.pid]);
    const sampler = setInterval(() => treeSamples.push(processTreeSnapshot(child.pid)), 25);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }, timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearInterval(sampler);
      const completedTree = processTreeSnapshot(child.pid);
      treeSamples.push(completedTree);
      const observedTrees = treeSamples.filter((sample) => sample.observed);
      resolveResult({
        pid: child.pid,
        processGroup: -child.pid,
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        started,
        completed: process.hrtime.bigint(),
        spawnedAt,
        tree: {
          observed: observedTrees.some((sample) => sample.rootPresent),
          samples: treeSamples,
          completed: completedTree,
          peakRssBytes: observedTrees.reduce(
            (peak, sample) => Math.max(peak, sample.rssBytes ?? 0),
            0,
          ),
        },
        resources: resourceAtSpawn,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearInterval(sampler);
      resolveResult({
        pid: child.pid ?? null,
        processGroup: child.pid ? -child.pid : null,
        exitCode: null,
        signal: null,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.from(String(error)),
        started,
        completed: process.hrtime.bigint(),
        spawnedAt,
        tree: {
          observed: false,
          samples: treeSamples,
          completed: processTreeSnapshot(child.pid),
          peakRssBytes: null,
        },
        resources: resourceAtSpawn,
      });
    });
  });
}

function processTreeSnapshot(pid) {
  if (!pid)
    return {
      observed: false,
      rootPid: null,
      rootPresent: false,
      descendants: [],
      rssBytes: null,
      pids: [],
    };
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pidValue, ppidValue, pgidValue, rssValue] = line.trim().split(/\s+/u).map(Number);
        return { pid: pidValue, ppid: ppidValue, pgid: pgidValue, rssBytes: rssValue * 1024 };
      });
    const descendants = [];
    const pending = [pid];
    while (pending.length > 0) {
      const parent = pending.shift();
      for (const row of rows.filter((candidate) => candidate.ppid === parent)) {
        descendants.push(row);
        pending.push(row.pid);
      }
    }
    const root = rows.find((row) => row.pid === pid);
    const groupRows = rows.filter((row) => row.pgid === pid && row.pid !== pid);
    for (const row of groupRows)
      if (!descendants.some((candidate) => candidate.pid === row.pid)) descendants.push(row);
    return {
      observed: true,
      rootPid: pid,
      rootPresent: root !== undefined,
      descendants: descendants.map(({ pid: childPid, rssBytes }) => ({ pid: childPid, rssBytes })),
      rssBytes: (root?.rssBytes ?? 0) + descendants.reduce((sum, row) => sum + row.rssBytes, 0),
      pids: [root?.pid, ...descendants.map((row) => row.pid)].filter(Boolean),
    };
  } catch {
    return {
      observed: false,
      rootPid: pid,
      rootPresent: false,
      descendants: [],
      rssBytes: null,
      pids: [],
    };
  }
}

function kernelResourceSnapshot(pids) {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0)
    return {
      observed: false,
      reason: "no kernel process ids",
      pids: [],
      fileDescriptors: null,
      sockets: null,
      listeners: null,
      hermesPorts: [],
    };
  try {
    const output = execFileSync("lsof", ["-nP", "-a", "-p", uniquePids.join(",")], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const lines = output
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0);
    let sockets = 0;
    let listeners = 0;
    const hermesPorts = new Set();
    for (const line of lines) {
      const columns = line.trim().split(/\s+/u);
      const type = columns[4];
      if (!["IPv4", "IPv6", "unix"].includes(type)) continue;
      sockets += 1;
      if (line.includes("(LISTEN)")) {
        listeners += 1;
        for (const match of line.matchAll(/:(611\d)\b/gu)) hermesPorts.add(Number(match[1]));
      }
    }
    return {
      observed: true,
      pids: uniquePids,
      fileDescriptors: lines.length,
      sockets,
      listeners,
      hermesPorts: [...hermesPorts].sort((left, right) => left - right),
    };
  } catch (error) {
    return {
      observed: false,
      reason: String(error),
      pids: uniquePids,
      fileDescriptors: null,
      sockets: null,
      listeners: null,
      hermesPorts: [],
    };
  }
}

function thresholdSatisfied(value, threshold) {
  if (!Number.isFinite(value)) return false;
  if (threshold.operator === "<") return value < threshold.limit;
  if (threshold.operator === "<=") return value <= threshold.limit;
  if (threshold.operator === "===") return value === threshold.limit;
  if (threshold.operator === ">=") return value >= threshold.limit;
  if (threshold.operator === ">") return value > threshold.limit;
  return false;
}

function kernelThresholdsSatisfied(step, processResult) {
  const observed = {
    processRssBytes: processResult.tree.peakRssBytes,
    fileDescriptors: processResult.resources.fileDescriptors,
    sockets: processResult.resources.sockets,
    listeners: processResult.resources.listeners,
  };
  return Object.entries(observed).every(([metric, value]) => {
    const threshold = step.thresholds[metric];
    return threshold === undefined || thresholdSatisfied(value, threshold);
  });
}

function createCleanupBarrier(executionRoot, processResult) {
  let promise;
  let invocations = 0;
  return async function cleanup(reason) {
    if (!promise) {
      invocations += 1;
      promise = (async () => {
        const currentProcessResult =
          typeof processResult === "function" ? processResult() : processResult;
        if (currentProcessResult?.processGroup) {
          try {
            process.kill(currentProcessResult.processGroup, "SIGTERM");
          } catch {}
        }
        await new Promise((resolveResult) => setTimeout(resolveResult, 25));
        const descendantsBeforeRemoval = currentProcessResult?.pid
          ? processTreeSnapshot(currentProcessResult.pid).descendants
          : [];
        rmSync(executionRoot, { recursive: true, force: true });
        return {
          attempted: true,
          completed: true,
          barrier: "awaited-idempotent",
          reason,
          invocations,
          descendantsBeforeRemoval,
          executionRootRemoved: !existsSync(executionRoot),
        };
      })();
    }
    return promise;
  };
}

function parseMachineEvents(stdout, stderr) {
  const events = [];
  for (const bytes of [stdout, stderr]) {
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const value = JSON.parse(line);
        if (
          value &&
          typeof value === "object" &&
          (value.format === "agent-mail.observation/v1" || value.event)
        )
          events.push(value);
      } catch {}
    }
  }
  return events;
}

function resolveArgv(argv, fixturePath, outputRoot, runId) {
  const replacements = {
    "<temp-corpus>": fixturePath,
    "<measurement-output>": join(outputRoot, runId, "measurement.json"),
    "<benchmark-copy>": join(outputRoot, runId, "benchmark-copy.sqlite"),
  };
  const resolved = argv.map((arg) => replacements[arg] ?? arg);
  assert(!resolved.some((arg) => /<[^>]+>/u.test(arg)), "unresolved literal placeholder in argv");
  return resolved;
}

function fixtureBytes(fixture) {
  if (!fixture) return null;
  if (fixture.kind === "generated-stream") {
    const size = Number(fixture.minimumBytes ?? 0);
    assert(Number.isSafeInteger(size) && size >= 0, "fixture minimumBytes is invalid");
    const chunk = Buffer.from("agent-mail-fixture\n");
    const output = Buffer.alloc(size);
    for (let offset = 0; offset < output.length; offset += chunk.length)
      chunk.copy(output, offset, 0, Math.min(chunk.length, output.length - offset));
    return output;
  }
  if (fixture.kind === "generated-file") {
    assert(
      typeof fixture.seed === "number" || typeof fixture.recipe === "string",
      "fixture recipe is missing",
    );
    return Buffer.from(`${fixture.recipe ?? "generated"}\nseed=${fixture.seed ?? "none"}\n`);
  }
  return null;
}

function materializeFixture(fixture, destination, runId, priorGeneration) {
  if (!fixture) return null;
  const bytes = fixture.observationAssertionId ? null : fixtureBytes(fixture);
  if (fixture.kind === "generated-stream" && fixture.observationAssertionId) return { ...fixture };
  const path = join(
    destination,
    runId,
    fixture.kind === "generated-file" && !fixture.generationStepId ? "staging" : "fixtures",
    `${fixture.id ?? "fixture"}.bin`,
  );
  if (fixture.kind === "generated-file") {
    if (fixture.generationStepId) {
      assert(priorGeneration, `${fixture.id} requires a prior generation receipt`);
      mkdirSync(dirname(path), { recursive: true });
      assertAbsent(path, "measurement fixture");
      assertAbsent(`${path}.inventory.json`, "measurement inventory");
      cpSync(priorGeneration.artifactPath, path);
      cpSync(priorGeneration.inventoryPath, `${path}.inventory.json`);
      const copied = fileDigest(path, "measurement fixture");
      const copiedInventory = fileDigest(`${path}.inventory.json`, "measurement inventory");
      assert(
        copied.sha256 === priorGeneration.artifactSha256 &&
          copied.bytes === priorGeneration.artifactBytes &&
          copiedInventory.sha256 === priorGeneration.inventorySha256 &&
          copiedInventory.bytes === priorGeneration.inventoryBytes,
        "measurement fixture does not match generation artifact",
      );
      return {
        ...fixture,
        generationReceipt: {
          receiptPath: priorGeneration.receiptPath,
          receiptSha256: priorGeneration.receiptSha256,
          artifactPath: priorGeneration.artifactRelativePath,
          artifactSha256: priorGeneration.artifactSha256,
          artifactBytes: priorGeneration.artifactBytes,
          inventoryPath: priorGeneration.inventoryRelativePath,
          inventorySha256: priorGeneration.inventorySha256,
          inventoryBytes: priorGeneration.inventoryBytes,
          logicalChecksum: priorGeneration.logicalChecksum,
        },
        materialized: {
          path: relative(destination, path),
          owner: "prior-generator",
          presentBeforeRun: true,
          sha256: copied.sha256,
          bytes: copied.bytes,
        },
      };
    }
    return {
      ...fixture,
      materialized: {
        path: relative(destination, path),
        owner: "generator",
        presentBeforeRun: false,
      },
    };
  }
  if (!bytes) return fixture;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    ...fixture,
    materialized: {
      owner: "runner",
      presentBeforeRun: true,
      path: relative(destination, path),
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
  };
}

function evaluateAssertions(step, sourceRoot, processResult, events) {
  return step.assertions.map((assertion) => {
    if (assertion.kind === "exitCode") {
      return {
        ...assertion,
        observed: processResult.exitCode,
        pass: processResult.exitCode === assertion.expected,
      };
    }
    if (assertion.kind === "source-token") {
      const matching = events.filter(
        (event) => event.event === "source-token" && event.assertionId === assertion.id,
      );
      assert(matching.length === 1, `${step.id} source-token event count is not exactly one`);
      const event = matching[0];
      assert(
        event.format === "agent-mail.observation/v1",
        `${step.id} source-token event format is invalid`,
      );
      const source = step.sources.find((candidate) => candidate.path === assertion.sourcePath);
      assert(
        event.sourcePath === assertion.sourcePath && event.sourceSha256 === source.sha256,
        `${step.id} source-token event is detached`,
      );
      assert(event.token === assertion.token, `${step.id} source-token event token is detached`);
      assert(
        Number.isSafeInteger(event.observed) &&
          event.observed >= 0 &&
          event.expected === assertion.occurrences &&
          event.pass === (event.observed === event.expected),
        `${step.id} source-token event result is detached`,
      );
      return {
        ...assertion,
        observed: event.observed,
        pass: event.pass === true && event.observed === assertion.occurrences,
      };
    }
    if (assertion.kind === "fixture-observation") {
      const matching = events.filter(
        (event) => event.event === "fixture-observation" && event.fixtureId === assertion.fixtureId,
      );
      assert(matching.length === 1, `${step.id} fixture observation count is not exactly one`);
      const event = matching[0];
      assert(
        event.format === "agent-mail.fixture-observation/v1",
        `${step.id} fixture observation format is invalid`,
      );
      const source = step.sources.find((candidate) => candidate.path === assertion.sourcePath);
      assert(
        source && event.sourcePath === assertion.sourcePath && event.sourceSha256 === source.sha256,
        `${step.id} fixture observation source is detached`,
      );
      assert(
        event.fixtureId === assertion.fixtureId,
        `${step.id} fixture observation id is detached`,
      );
      for (const field of [
        "producedBytes",
        "consumedBytes",
        "producedChunks",
        "consumedChunks",
        "expectedBytes",
      ])
        assert(
          Number.isSafeInteger(event[field]) && event[field] >= 0,
          `${step.id} fixture observation numbers are invalid`,
        );
      assert(
        /^[0-9a-f]{64}$/u.test(event.producedSha256 ?? "") &&
          /^[0-9a-f]{64}$/u.test(event.consumedSha256 ?? ""),
        `${step.id} fixture observation digests are invalid`,
      );
      for (const field of [
        "producerCompleted",
        "consumerCompleted",
        "bytesEqual",
        "sha256Equal",
        "exactBytes",
        "pass",
      ])
        assert(
          typeof event[field] === "boolean",
          `${step.id} fixture observation flags are invalid`,
        );
      const bytesEqual = event.producedBytes === event.consumedBytes;
      const sha256Equal = event.producedSha256 === event.consumedSha256;
      const exactBytes =
        event.producedBytes === assertion.expectedBytes &&
        event.consumedBytes === assertion.expectedBytes;
      const pass =
        event.producerCompleted &&
        event.consumerCompleted &&
        bytesEqual &&
        sha256Equal &&
        exactBytes &&
        event.producedChunks > 0 &&
        event.consumedChunks > 0;
      assert(
        event.expectedBytes === assertion.expectedBytes &&
          event.bytesEqual === bytesEqual &&
          event.sha256Equal === sha256Equal &&
          event.exactBytes === exactBytes &&
          event.pass === pass,
        `${step.id} fixture observation result is detached`,
      );
      return { ...assertion, observed: event, pass };
    }
    const matching = events.filter(
      (event) =>
        event.event === assertion.event &&
        event.path === assertion.path &&
        event.sha256 === assertion.sha256 &&
        event.pointer === assertion.pointer,
    );
    assert(matching.length === 1, `${step.id} structured oracle event count is not exactly one`);
    const oracleBytes = readFileSync(resolve(sourceRoot, assertion.path));
    assert(sha256(oracleBytes) === assertion.sha256, `${step.id} oracle bytes drifted`);
    const oracleValue = resolveJsonPointer(
      JSON.parse(oracleBytes.toString("utf8")),
      assertion.pointer,
    );
    const observed = matching[0].value;
    assert(
      matching[0].path === assertion.path &&
        matching[0].sha256 === assertion.sha256 &&
        matching[0].pointer === assertion.pointer &&
        deepJsonEqual(observed, oracleValue),
      `${step.id} structured oracle event is detached`,
    );
    return {
      ...assertion,
      observed,
      pass: deepJsonEqual(observed, assertion.value) && deepJsonEqual(observed, oracleValue),
    };
  });
}

function fixtureFromObservation(fixture, assertions) {
  if (!fixture?.observationAssertionId) return fixture;
  const assertion = assertions.find((candidate) => candidate.id === fixture.observationAssertionId);
  assert(
    assertion?.kind === "fixture-observation" && assertion.pass,
    "fixture observation did not pass",
  );
  const observed = assertion.observed;
  return {
    ...fixture,
    materialized: {
      owner: "observation",
      presentBeforeRun: false,
      presentAfterRun: true,
      bytes: observed.producedBytes,
      sha256: observed.producedSha256,
    },
    observation: observed,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--self-test") args.selfTest = true;
    else if (token.startsWith("--")) args[token.slice(2)] = argv[++index];
    else fail(`unexpected argument ${token}`);
  }
  return args;
}

function selfTestManifest(root) {
  const tiny = "tiny-receipt.mjs";
  writeFileSync(join(root, tiny), "process.stdout.write('tiny-pass\\n');\n");
  git(root, ["add", tiny]);
  git(root, ["commit", "-qm", "tiny command"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const source = committedBlob(root, head, tiny, "tiny source");
  return {
    format: "agent-mail.release-evidence-execution-manifest/v2",
    schemaVersion: 2,
    ownerIssueId: 176,
    replay: { required: true, compare: ["candidate", "argv", "sources", "fixture", "assertions"] },
    attackInventory: Array.from({ length: 40 }, (_, index) => `tiny-attack-${index + 1}`),
    steps: [
      {
        id: "tiny-command",
        ownerIssueId: 176,
        gate: "capacity",
        obligationIds: ["F17"],
        cwd: ".",
        argv: ["node", tiny],
        sources: [
          { role: "entrypoint", path: tiny, gitBlob: source.gitBlob, sha256: source.sha256 },
        ],
        assertions: [{ id: "tiny-exit-zero", kind: "exitCode", expected: 0 }],
        observations: ["stdout", "stderr", "exitCode", "durationNs"],
        thresholds: {
          timeoutMs: 5000,
          processRssBytes: {
            source: "kernel:ps",
            operator: "<=",
            limit: 1073741824,
            unit: "bytes",
          },
        },
        probes: ["processTreeRss", "streams", "tempRoot"],
        fixture: { kind: "generated-stream", id: "tiny-fixture", recipe: "stdout:tiny-pass" },
      },
    ],
  };
}

export async function capture({
  manifestPath = manifestDefaultPath,
  stepId,
  root = repositoryRoot,
  outputRoot,
  generationReceiptPath,
  generationOutputRoot,
  role = "primary",
  runId = randomUUID(),
  timeoutMs,
  selfTest = process.argv.includes("--self-test"),
} = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const candidateCommit = git(root, ["rev-parse", "HEAD"]);
  const candidateTree = git(root, ["rev-parse", `${candidateCommit}^{tree}`]);
  const manifestRelative = relative(root, resolve(manifestPath));
  assert(!manifestRelative.startsWith(".."), "manifest must be inside candidate repository");
  const manifestBytes = readFileSync(manifestPath);
  const allowedUntracked = manifest.runner?.untrackedAllowlist ?? [];
  const originalSnapshot = assertCleanCandidate(root, allowedUntracked);
  validateManifest(manifest, root, candidateCommit, { selfTest });
  const step = manifest.steps.find((candidate) => candidate.id === stepId) ?? manifest.steps[0];
  assert(step, `unknown manifest step ${stepId}`);
  const stepBindings = stepSourceBindings(step, root, candidateCommit);
  const runnerBindings = manifest.runner?.sources
    ? sourceBindings(manifest, root, candidateCommit).filter((source) =>
        manifest.runner.sources.some((expected) => expected.path === source.path),
      )
    : [];
  const destination = resolve(
    outputRoot ?? mkdtempSync(join(tmpdir(), "agent-mail-release-evidence-")),
  );
  assert(
    !destination.startsWith(`${resolve(root)}/`),
    "output root must be outside candidate repository",
  );
  mkdirSync(destination, { recursive: true });
  const executionRoot = mkdtempSync(join(tmpdir(), "agent-mail-release-candidate-"));
  let checkout = join(executionRoot, "checkout");
  let processResult;
  const cleanupBarrier = createCleanupBarrier(executionRoot, () => processResult);
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", root, checkout], { stdio: "ignore" });
    execFileSync("git", ["checkout", "-q", "--detach", candidateCommit], {
      cwd: checkout,
      stdio: "ignore",
    });
    assert(gitStatus(checkout).length === 0, "disposable candidate checkout is dirty");
    const dependencies = installFrozenDependencies(checkout, manifest, { selfTest });
    const cwd = resolve(checkout, step.cwd);
    for (const source of step.sources)
      committedBlob(checkout, candidateCommit, source.path, `${step.id} source`);
    const priorGeneration = step.fixture?.generationStepId
      ? generationReceipt(
          generationReceiptPath,
          generationOutputRoot ?? dirname(resolve(generationReceiptPath ?? destination)),
          step.fixture,
          candidateCommit,
        )
      : undefined;
    let fixture = materializeFixture(step.fixture, destination, runId, priorGeneration);
    let fixturePath = fixture?.materialized?.path
      ? resolve(destination, fixture.materialized.path)
      : join(executionRoot, "generated-fixture");
    if (fixture?.materialized?.owner === "generator")
      assertAbsent(fixturePath, "generator fixture");
    if (fixture?.materialized?.presentBeforeRun && !existsSync(fixturePath))
      fail("runner fixture was not materialized");
    const argv = resolveArgv(step.argv, fixturePath, destination, runId);
    const beforeRun = repositorySnapshot(checkout);
    const integrityBefore =
      fixture?.materialized?.owner === "prior-generator" && fixture.rowCount === 250000
        ? await validateGeneratedSearchArtifact(fixturePath, checkout)
        : undefined;
    const startedAt = now();
    const captureStartedNs = process.hrtime.bigint();
    const processBefore = processTreeSnapshot(process.pid);
    processResult = await runProcess(argv, cwd, timeoutMs ?? step.thresholds.timeoutMs ?? 300_000);
    const processAfter = processResult.tree.completed;
    const descendants = processAfter.descendants;
    const eventsValue = parseMachineEvents(processResult.stdout, processResult.stderr);
    const eventBytes = Buffer.from(
      eventsValue.map((event) => `${JSON.stringify(event)}\n`).join(""),
    );
    const stdout = outputRef(
      destination,
      destination,
      runId,
      `${step.id}.stdout`,
      processResult.stdout,
    );
    const stderr = outputRef(
      destination,
      destination,
      runId,
      `${step.id}.stderr`,
      processResult.stderr,
    );
    const events = outputRef(
      destination,
      destination,
      runId,
      `${step.id}.events.jsonl`,
      eventBytes,
    );
    const durationNs = processResult.completed - processResult.started;
    const assertions = evaluateAssertions(step, checkout, processResult, eventsValue);
    const probeUnavailable =
      (step.probes.includes("processTreeRss") && !processResult.tree.observed) ||
      (["fileDescriptors", "sockets", "listeners", "HermesLease"].some((probe) =>
        step.probes.includes(probe),
      ) &&
        (!processResult.resources.observed ||
          (step.probes.includes("HermesLease") &&
            processResult.resources.hermesPorts.length === 0)));
    const kernelThresholdsPass = kernelThresholdsSatisfied(step, processResult);
    const result =
      probeUnavailable || processResult.timedOut || processResult.exitCode === null
        ? "blocked"
        : processResult.exitCode === 0 &&
            assertions.every((assertion) => assertion.pass) &&
            kernelThresholdsPass
          ? "pass"
          : "fail";
    if (fixture?.materialized?.owner === "generator" && result === "pass") {
      const retained = retainGeneratedArtifact(destination, fixture, fixturePath, runId);
      cleanGeneratedStaging(fixturePath);
      fixture = {
        ...fixture,
        materialized: {
          ...fixture.materialized,
          path: retained.relativePath,
          retainedFrom: fixture.materialized.path,
          presentAfterRun: true,
          sha256: retained.artifactSha256,
          bytes: retained.artifactBytes,
          integrity: {
            inventorySha256: retained.inventorySha256,
            inventoryBytes: retained.inventoryBytes,
            logicalChecksum: retained.logicalChecksum,
          },
        },
      };
      fixturePath = retained.path;
    }
    const observedFixture = fixtureFromObservation(fixture, assertions);
    const retainedFixture = await finalizeFixture(
      observedFixture,
      destination,
      fixturePath,
      checkout,
      integrityBefore,
    );
    assert(
      JSON.stringify(repositorySnapshot(checkout)) === JSON.stringify(beforeRun),
      "candidate checkout changed during execution",
    );
    assert(descendants.length === 0, "runner left descendant processes behind");
    const generatedStaging = fixture?.materialized?.retainedFrom
      ? {
          path: fixture.materialized.retainedFrom,
          removed: !existsSync(resolve(destination, fixture.materialized.retainedFrom)),
          retainedPath: fixture.materialized.path,
        }
      : undefined;
    if (generatedStaging)
      assert(generatedStaging.removed, "generated staging artifact was not cleaned");
    const cleanup = {
      ...(await cleanupBarrier("completed")),
      generatedStaging,
    };
    const captureCompletedNs = process.hrtime.bigint();
    const completedAt = new Date(Math.max(Date.now(), Date.parse(startedAt) + 1)).toISOString();
    const intervals = [
      {
        id: "setup",
        startedNs: captureStartedNs,
        completedNs: processResult.started,
      },
      {
        id: "execution",
        startedNs: processResult.started,
        completedNs: processResult.completed,
      },
      {
        id: "retention-and-cleanup",
        startedNs: processResult.completed,
        completedNs: captureCompletedNs,
      },
    ].map((interval) => ({
      ...interval,
      durationNs: interval.completedNs - interval.startedNs,
    }));
    assert(
      intervals.every((interval) => interval.startedNs < interval.completedNs) &&
        intervals.every(
          (interval, index) =>
            index === 0 || intervals[index - 1].completedNs <= interval.startedNs,
        ),
      "capture intervals are not sequential",
    );
    const aggregateDurationNs = intervals.reduce((sum, interval) => sum + interval.durationNs, 0n);
    const receipt = {
      format: receiptFormat,
      runId,
      role,
      manifestStepId: step.id,
      candidate: {
        repository: (() => {
          try {
            return git(root, ["config", "--get", "remote.origin.url"]);
          } catch {
            return "local";
          }
        })(),
        commit: candidateCommit,
        tree: candidateTree,
        manifestPath: manifestRelative,
        manifestSha256: sha256(manifestBytes),
      },
      cwd: step.cwd,
      argv: [...argv],
      stdin: { kind: "none" },
      sources: stepBindings,
      runnerSources: runnerBindings,
      fixture: retainedFixture,
      assertions,
      startedAt,
      completedAt,
      monotonic: {
        startedNs: captureStartedNs.toString(10),
        completedNs: captureCompletedNs.toString(10),
        durationNs: durationNs.toString(10),
        intervals: intervals.map((interval) => ({
          id: interval.id,
          startedNs: interval.startedNs.toString(10),
          completedNs: interval.completedNs.toString(10),
          durationNs: interval.durationNs.toString(10),
        })),
        aggregateDurationNs: aggregateDurationNs.toString(10),
      },
      environment: {
        os: process.platform,
        kernel: (() => {
          try {
            return execFileSync("uname", ["-sr"], { encoding: "utf8" }).trim();
          } catch {
            return "unknown";
          }
        })(),
        arch: process.arch,
        runtime: {
          executable: process.execPath,
          version: process.version,
          sha256: runtimeDigest(),
        },
        packageManifestSha256: optionalDigest(join(root, "package.json")),
        lockfileSha256: optionalDigest(join(root, "bun.lock")),
        dependencies,
      },
      process: {
        pid: processResult.pid,
        processGroup: processResult.processGroup,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
      },
      streams: { stdout, stderr, events },
      probes: {
        process: {
          observed: processResult.tree.observed,
          pid: processResult.pid,
          descendants: processAfter.descendants,
          rssBytes: processResult.tree.peakRssBytes,
          peakRssBytes: processResult.tree.peakRssBytes,
          samples: processResult.tree.samples,
          spawned: processResult.spawnedAt,
        },
        resources: processResult.resources,
        before: processBefore,
        streams: {
          observed: true,
          stdout: stdout.bytes,
          stderr: stderr.bytes,
          events: events.bytes,
        },
        tempRoot: { path: executionRoot, removed: cleanup.executionRootRemoved },
        cleanup,
      },
      result,
      observedOutcome: {
        status: result,
        derivedFrom: [
          candidateCommit,
          candidateTree,
          sha256(manifestBytes),
          events.sha256,
          stdout.sha256,
          stderr.sha256,
        ],
      },
    };
    const after = repositorySnapshot(root);
    assert(
      after.head === originalSnapshot.head && after.tree === originalSnapshot.tree,
      "candidate HEAD/tree changed during capture",
    );
    assert(
      after.submodules === originalSnapshot.submodules,
      "candidate submodules changed during capture",
    );
    assert(
      gitStatusEntries(root).every(
        (entry) => entry.code === "??" && isAllowedUntracked(entry.path, allowedUntracked),
      ),
      "capture introduced unallowlisted worktree changes",
    );
    return receipt;
  } finally {
    await cleanupBarrier("finally");
    if (existsSync(executionRoot)) fail("runner temporary checkout was not removed");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const root = mkdtempSync("/tmp/agent-mail-capture-self-test-");
    try {
      git(root, ["init", "-q"]);
      git(root, ["config", "user.email", "capture@example.invalid"]);
      git(root, ["config", "user.name", "capture self-test"]);
      const manifest = selfTestManifest(root);
      const manifestPath = join(root, "manifest.json");
      writeFileSync(manifestPath, json(manifest));
      git(root, ["add", "manifest.json"]);
      git(root, ["commit", "-qm", "tiny manifest"]);
      const receipt = await capture({
        manifestPath,
        root,
        stepId: "tiny-command",
      });
      assert(receipt.result === "pass", "tiny command did not pass");
      console.log(JSON.stringify({ format: receiptFormat, accepted: true, receipt }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }
  const receipt = await capture({
    manifestPath: args.manifest,
    stepId: args.step,
    root: args.root ? resolve(args.root) : repositoryRoot,
    outputRoot: args["output-root"] ? resolve(args["output-root"]) : undefined,
    generationReceiptPath: args["generation-receipt"]
      ? resolve(args["generation-receipt"])
      : undefined,
    generationOutputRoot: args["generation-output-root"]
      ? resolve(args["generation-output-root"])
      : undefined,
    role: args.role ?? "primary",
    runId: args["run-id"],
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });
  const receiptPath = args.receipt
    ? resolve(args.receipt)
    : join(process.cwd(), `${receipt.runId}.receipt.json`);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, json(receipt));
  console.log(JSON.stringify({ receiptPath, result: receipt.result, runId: receipt.runId }));
}

if (import.meta.main) await main();
