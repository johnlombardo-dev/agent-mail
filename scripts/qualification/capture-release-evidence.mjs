import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

function runProcess(argv, cwd, timeoutMs) {
  return new Promise((resolveResult) => {
    const started = process.hrtime.bigint();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      });
    });
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
  const bindings = validateManifest(manifest, root, candidateCommit);
  const step = manifest.steps.find((candidate) => candidate.id === stepId) ?? manifest.steps[0];
  assert(step, `unknown manifest step ${stepId}`);
  const cwd = resolve(root, step.cwd);
  regularPath(root, step.sources[0].path, `${step.id} source`);
  const destination = resolve(outputRoot ?? mkdtempSync("/tmp/agent-mail-release-evidence-"));
  mkdirSync(destination, { recursive: true });
  const startedAt = now();
  const processResult = await runProcess(
    step.argv,
    cwd,
    timeoutMs ?? step.thresholds.timeoutMs ?? 300_000,
  );
  const completedAt = now();
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
  const eventBytes = Buffer.from(
    json({
      format: "agent-mail.runner-event/v2",
      runId,
      stepId: step.id,
      pid: processResult.pid,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      timedOut: processResult.timedOut,
    }),
  );
  const events = outputRef(destination, destination, runId, `${step.id}.events.json`, eventBytes);
  const durationNs = processResult.completed - processResult.started;
  const assertions = step.assertions.map((assertion) => ({
    ...assertion,
    observed: assertion.kind === "exitCode" ? processResult.exitCode : null,
    pass: assertion.kind === "exitCode" ? processResult.exitCode === assertion.expected : false,
  }));
  const result =
    processResult.timedOut || processResult.exitCode === null
      ? "blocked"
      : processResult.exitCode === 0 && assertions.every((assertion) => assertion.pass)
        ? "pass"
        : "fail";
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
    sources: bindings,
    fixture: step.fixture ?? null,
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
      runtime: { executable: process.execPath, version: process.version, sha256: runtimeDigest() },
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
    probes: { process: "runner-observed", streams: "runner-retained", tempRoot: "runner-owned" },
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
  return receipt;
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
      const receipt = await capture({
        manifestPath,
        root,
        stepId: "tiny-command",
        outputRoot: join(root, "out"),
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
