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
import { fileURLToPath } from "node:url";

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
  return execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
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
  return allowlist.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function assertCleanCandidate(root, allowlist = []) {
  const snapshot = repositorySnapshot(root);
  const forbidden = snapshot.status.filter((path) => !isAllowedUntracked(path, allowlist));
  assert(forbidden.length === 0, `candidate worktree is dirty: ${forbidden.join(", ")}`);
  return snapshot;
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

function sourceBindings(manifest, root, commit) {
  const all = [];
  for (const step of manifest.steps) {
    for (const source of step.sources ?? []) all.push(source);
  }
  for (const source of manifest.runner?.sources ?? []) all.push(source);
  const unique = new Map(all.map((source) => [source.path, source]));
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
  } else if (assertion.kind === "structured-oracle") {
    assert(
      typeof assertion.event === "string" && assertion.event.length > 0,
      `${step.id} oracle event is missing`,
    );
    assert(
      typeof assertion.field === "string" && assertion.field.length > 0,
      `${step.id} oracle field is missing`,
    );
    assert(assertion.expected !== undefined, `${step.id} oracle expected value is missing`);
  } else if (assertion.kind === "exitCode") {
    assert(Number.isInteger(assertion.expected), `${step.id} exit expectation is invalid`);
  } else {
    fail(`${step.id} assertion kind ${assertion.kind} is not runner-supported`);
  }
}

export function validateManifest(manifest, root, commit = git(root, ["rev-parse", "HEAD"])) {
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
  if (manifest.runner?.sources) {
    assert(
      Array.isArray(manifest.runner.sources) && manifest.runner.sources.length > 0,
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
    for (const assertion of step.assertions) validateAssertion(assertion, step);
    assert(
      step.observations && step.thresholds && step.probes,
      `${step.id} observation authority is incomplete`,
    );
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

function outputRef(root, outputRoot, runId, filename, bytes) {
  const path = join(outputRoot, runId, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  const relativePath = relative(root, path);
  assert(!relativePath.startsWith(".."), "output escaped output root");
  return { path: relativePath, sha256: sha256(bytes), bytes: bytes.length };
}

function now() {
  return new Date().toISOString();
}

function completedWallTime(startedAt) {
  const started = Date.parse(startedAt);
  const completed = Date.now();
  return new Date(Math.max(completed, started + 1)).toISOString();
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
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
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
      });
    });
  });
}

function processTreeSnapshot(pid) {
  if (!pid) return { observed: true, rootPid: null, descendants: [], rssBytes: 0 };
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pidValue, ppidValue, rssValue] = line.trim().split(/\s+/u).map(Number);
        return { pid: pidValue, ppid: ppidValue, rssBytes: rssValue * 1024 };
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
    return {
      observed: true,
      rootPid: pid,
      descendants: descendants.map(({ pid: childPid, rssBytes }) => ({ pid: childPid, rssBytes })),
      rssBytes: (root?.rssBytes ?? 0) + descendants.reduce((sum, row) => sum + row.rssBytes, 0),
    };
  } catch {
    return { observed: false, rootPid: pid, descendants: [], rssBytes: null };
  }
}

function descendantPids(pid) {
  return processTreeSnapshot(pid).descendants.map((entry) => entry.pid);
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

function materializeFixture(fixture, destination, runId) {
  const bytes = fixtureBytes(fixture);
  if (!bytes) return fixture ?? null;
  const path = join(destination, runId, "fixtures", `${fixture.id ?? "fixture"}.bin`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    ...fixture,
    materialized: {
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
      const source = readFileSync(resolve(sourceRoot, assertion.sourcePath), "utf8");
      const observed = source.split(assertion.token).length - 1;
      return { ...assertion, observed, pass: observed === assertion.occurrences };
    }
    const matching = events.find((event) => event.event === assertion.event);
    const observed = matching?.[assertion.field];
    return { ...assertion, observed, pass: Object.is(observed, assertion.expected) };
  });
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
        thresholds: { timeoutMs: 5000 },
        probes: ["process", "streams", "tempRoot"],
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
  role = "primary",
  runId = randomUUID(),
  timeoutMs,
} = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const candidateCommit = git(root, ["rev-parse", "HEAD"]);
  const candidateTree = git(root, ["rev-parse", `${candidateCommit}^{tree}`]);
  const manifestRelative = relative(root, resolve(manifestPath));
  assert(!manifestRelative.startsWith(".."), "manifest must be inside candidate repository");
  const manifestBytes = readFileSync(manifestPath);
  const allowedUntracked = manifest.runner?.untrackedAllowlist ?? [];
  const originalSnapshot = assertCleanCandidate(root, allowedUntracked);
  validateManifest(manifest, root, candidateCommit);
  const step = manifest.steps.find((candidate) => candidate.id === stepId) ?? manifest.steps[0];
  assert(step, `unknown manifest step ${stepId}`);
  const stepBindings = stepSourceBindings(step, root, candidateCommit);
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
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", root, checkout], { stdio: "ignore" });
    execFileSync("git", ["checkout", "-q", "--detach", candidateCommit], {
      cwd: checkout,
      stdio: "ignore",
    });
    assert(gitStatus(checkout).length === 0, "disposable candidate checkout is dirty");
    const cwd = resolve(checkout, step.cwd);
    for (const source of step.sources)
      committedBlob(checkout, candidateCommit, source.path, `${step.id} source`);
    const fixture = materializeFixture(step.fixture, destination, runId);
    const fixturePath = fixture?.materialized?.path
      ? resolve(destination, fixture.materialized.path)
      : join(executionRoot, "generated-fixture");
    if (fixture?.materialized && !existsSync(fixturePath))
      fail("runner fixture was not materialized");
    const argv = resolveArgv(step.argv, fixturePath, destination, runId);
    const beforeRun = repositorySnapshot(checkout);
    const startedAt = now();
    const processBefore = processTreeSnapshot(null);
    const processResult = await runProcess(
      argv,
      cwd,
      timeoutMs ?? step.thresholds.timeoutMs ?? 300_000,
    );
    const completedAt = completedWallTime(startedAt);
    const processAfter = processTreeSnapshot(processResult.pid);
    const descendants = descendantPids(processResult.pid);
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
    const result =
      processResult.timedOut || processResult.exitCode === null
        ? "blocked"
        : processResult.exitCode === 0 && assertions.every((assertion) => assertion.pass)
          ? "pass"
          : "fail";
    assert(
      JSON.stringify(repositorySnapshot(checkout)) === JSON.stringify(beforeRun),
      "candidate checkout changed during execution",
    );
    assert(descendants.length === 0, "runner left descendant processes behind");
    const cleanup = { attempted: true, completed: true, descendants: [], checkoutRemoved: true };
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
      argv: [...step.argv],
      stdin: { kind: "none" },
      sources: stepBindings,
      fixture,
      assertions,
      startedAt,
      completedAt,
      monotonic: {
        startedNs: processResult.started.toString(10),
        completedNs: processResult.completed.toString(10),
        durationNs: durationNs.toString(10),
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
          observed: processAfter.observed,
          pid: processResult.pid,
          descendants: processAfter.descendants,
          rssBytes: processAfter.rssBytes,
          spawned: processResult.spawnedAt,
        },
        before: processBefore,
        streams: {
          observed: true,
          stdout: stdout.bytes,
          stderr: stderr.bytes,
          events: events.bytes,
        },
        tempRoot: { path: executionRoot, removed: true },
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
      after.status.every((path) => isAllowedUntracked(path, allowedUntracked)),
      "capture introduced unallowlisted worktree changes",
    );
    return receipt;
  } finally {
    try {
      rmSync(executionRoot, { recursive: true, force: true });
    } finally {
      if (existsSync(executionRoot)) fail("runner temporary checkout was not removed");
    }
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
    outputRoot: args.outputRoot ? resolve(args.outputRoot) : undefined,
    role: args.role ?? "primary",
    runId: args.runId,
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
  });
  const receiptPath = args.receipt
    ? resolve(args.receipt)
    : join(process.cwd(), `${receipt.runId}.receipt.json`);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, json(receipt));
  console.log(JSON.stringify({ receiptPath, result: receipt.result, runId: receipt.runId }));
}

if (import.meta.main) await main();
