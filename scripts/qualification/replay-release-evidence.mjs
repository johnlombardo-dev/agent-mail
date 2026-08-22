import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, canonicalJson, sha256 } from "./capture-release-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  throw new Error(`release evidence replay failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function comparableFixture(fixture) {
  if (!fixture || typeof fixture !== "object") return fixture;
  const value = structuredClone(fixture);
  if (value.materialized) delete value.materialized.path;
  return value;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function finiteReceiptNumber(value, label) {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    `${label} is unavailable or invalid`,
  );
}

function canonicalOutputRoot(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} output root is required`);
  const lexical = resolve(value);
  const lexicalStat = lstatSync(lexical);
  assert(
    lexicalStat.isDirectory() && !lexicalStat.isSymbolicLink(),
    `${label} output root is invalid`,
  );
  const canonical = realpathSync(lexical);
  const canonicalStat = lstatSync(canonical);
  assert(canonicalStat.isDirectory(), `${label} output root is not a directory`);
  return canonical;
}

function assertManifestStep(step) {
  assert(step && typeof step === "object", "manifest step authority is required");
  assert(typeof step.id === "string" && step.id.length > 0, "manifest step ID is required");
  assert(typeof step.cwd === "string", "manifest step cwd is required");
  assert(
    Array.isArray(step.argv) && step.argv.every((arg) => typeof arg === "string"),
    "manifest step argv is invalid",
  );
  assert(
    step.thresholds && typeof step.thresholds === "object",
    "manifest step thresholds are required",
  );
  assert(Array.isArray(step.probes), "manifest step probes are required");
}

function receiptPidSet(receipt, label) {
  const samples = receipt.probes?.process?.samples;
  assert(Array.isArray(samples) && samples.length >= 2, `${label} process samples are incomplete`);
  const process = receipt.process;
  assert(Number.isSafeInteger(process?.pid) && process.pid > 1, `${label} process PID is invalid`);
  assert(Number.isSafeInteger(process?.processGroup), `${label} process group is invalid`);
  assert(Math.abs(process.processGroup) === process.pid, `${label} process group is detached`);
  const pids = new Set();
  const processGroups = new Set();
  for (const sample of samples) {
    assert(Array.isArray(sample.pids), `${label} process sample PIDs are missing`);
    for (const pid of sample.pids) {
      assert(Number.isSafeInteger(pid) && pid > 1, `${label} process sample PID is invalid`);
      pids.add(pid);
    }
    for (const processGroup of sample.processGroups ?? []) {
      assert(
        Number.isSafeInteger(processGroup) && processGroup > 1,
        `${label} process sample group is invalid`,
      );
      processGroups.add(processGroup);
    }
  }
  assert(pids.has(process.pid), `${label} process PID is absent from process samples`);
  assert(
    processGroups.has(Math.abs(process.processGroup)),
    `${label} process group is absent from samples`,
  );
  for (const descendant of receipt.probes.process.descendants ?? [])
    assert(pids.has(descendant.pid), `${label} descendant PID is detached`);
  const resources = receipt.probes?.resources;
  assert(resources && Array.isArray(resources.pids), `${label} resource PID inventory is missing`);
  const resourcePids = new Set(resources.pids);
  for (const pid of resourcePids) {
    assert(Number.isSafeInteger(pid) && pid > 1, `${label} resource PID is invalid`);
    assert(pids.has(pid), `${label} resource PID is detached from process samples`);
  }
  for (const sample of resources.samples ?? [])
    for (const pid of sample.pids ?? []) {
      assert(Number.isSafeInteger(pid) && pid > 1, `${label} resource sample PID is invalid`);
      assert(pids.has(pid), `${label} resource sample PID is detached from process samples`);
    }
  assert(pids.size > 0, `${label} process PID inventory is empty`);
  return pids;
}

function validateIndependentRuntime(receipt, label, step) {
  assertManifestStep(step);
  assert(receipt.result === "pass", `${label} result is not pass`);
  const process = receipt.probes?.process;
  assert(process?.observed === true, `${label} process probe is unavailable`);
  assert(process.rssStatus === "observed", `${label} RSS probe is unavailable`);
  finiteReceiptNumber(process.peakRssBytes, `${label} peak RSS`);
  const terminal = process.samples.at(-1);
  assert(
    terminal && terminal.rootPresent === false,
    `${label} process did not reach terminal sample`,
  );
  assert(
    receipt.probes?.cleanup?.barrier === "awaited-idempotent" &&
      receipt.probes.cleanup.invocations === 1 &&
      receipt.probes.cleanup.executionRootRemoved === true &&
      receipt.probes.cleanup.termination?.completed === true &&
      receipt.probes.cleanup.termination.survivorsAfterKill?.length === 0,
    `${label} cleanup is unsettled`,
  );
  assert(
    receipt.probes?.tempRoot?.path && receipt.probes.tempRoot.removed === true,
    `${label} temporary root probe is unavailable`,
  );
  const thresholds = step?.thresholds ?? {};
  const thresholdSatisfied = (value, threshold) => {
    if (!Number.isFinite(value)) return false;
    if (threshold.operator === "<") return value < threshold.limit;
    if (threshold.operator === "<=") return value <= threshold.limit;
    if (threshold.operator === "===") return value === threshold.limit;
    if (threshold.operator === ">=") return value >= threshold.limit;
    if (threshold.operator === ">") return value > threshold.limit;
    return false;
  };
  const values = {
    processRssBytes: process.peakRssBytes,
    fileDescriptors: receipt.probes.resources?.fileDescriptors,
    sockets: receipt.probes.resources?.sockets,
    listeners: receipt.probes.resources?.listeners,
  };
  for (const [metric, threshold] of Object.entries(thresholds)) {
    if (metric === "timeoutMs") continue;
    assert(
      threshold && thresholdSatisfied(values[metric], threshold),
      `${label} ${metric} threshold failed`,
    );
  }
  const probes = new Set(step.probes);
  if (probes.has("streams")) {
    assert(receipt.probes?.streams?.observed === true, `${label} stream probe is unavailable`);
    for (const key of ["stdout", "stderr", "events"])
      assert(receipt.streams?.[key], `${label} ${key} stream is missing`);
  }
  if (probes.has("tempRoot"))
    assert(
      receipt.probes?.tempRoot?.path && receipt.probes.tempRoot.removed === true,
      `${label} temporary root probe is unavailable`,
    );
  if (["fileDescriptors", "sockets", "listeners", "HermesLease"].some((probe) => probes.has(probe)))
    assert(receipt.probes.resources?.observed === true, `${label} resource probe is unavailable`);
  return receiptPidSet(receipt, label);
}

function assertDistinctRegularArtifacts(primary, replay, options) {
  const primaryRoot = canonicalOutputRoot(options?.primaryOutputRoot, "primary");
  const replayRoot = canonicalOutputRoot(options?.replayOutputRoot, "replay");
  assert(primaryRoot !== replayRoot, "primary and replay output roots are aliased");
  assert(
    !primaryRoot.startsWith(`${replayRoot}/`) && !replayRoot.startsWith(`${primaryRoot}/`),
    "output roots overlap",
  );
  const identities = new Set();
  const validateRef = (root, runId, ref, label) => {
    assert(ref && typeof ref.path === "string", `${label} reference is missing`);
    assert(
      typeof ref.sha256 === "string" && /^[0-9a-f]{64}$/u.test(ref.sha256),
      `${label} digest is missing`,
    );
    assert(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0, `${label} byte count is invalid`);
    assert(!isAbsolute(ref.path) && !ref.path.includes("\\"), `${label} path is unsafe`);
    const parts = ref.path.split("/");
    assert(
      parts[0] === runId && parts.every((part) => part && part !== "." && part !== ".."),
      `${label} path is not run-bound`,
    );
    const path = resolve(root, ref.path);
    assert(relative(root, path) === ref.path, `${label} path escaped output root`);
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
    const realPath = realpathSync(path);
    assert(relative(root, realPath) === ref.path, `${label} path resolves outside output root`);
    const bytes = readFileSync(path);
    assert(bytes.length === ref.bytes, `${label} byte count drifted`);
    assert(sha256(bytes) === ref.sha256, `${label} digest drifted`);
    const identity = `${stat.dev}:${stat.ino}`;
    assert(!identities.has(identity), `${label} reuses another artifact inode`);
    identities.add(identity);
  };
  const refs = ["stdout", "stderr", "events"].map((key) => [
    key,
    primary.streams[key],
    replay.streams[key],
  ]);
  for (const [key, primaryRef, replayRef] of refs) {
    assert(primaryRef.path !== replayRef.path, `${key} path was reused`);
    validateRef(primaryRoot, primary.runId, primaryRef, `primary ${key}`);
    validateRef(replayRoot, replay.runId, replayRef, `replay ${key}`);
  }
  const primaryFixturePath = primary.fixture?.materialized?.path;
  const replayFixturePath = replay.fixture?.materialized?.path;
  if (primaryFixturePath || replayFixturePath) {
    assert(primaryFixturePath && replayFixturePath, "fixture materialization path is missing");
    assert(primaryFixturePath !== replayFixturePath, "fixture artifact path was reused");
    assert(primaryFixturePath.split("/")[0] === primary.runId, "primary fixture is not run-bound");
    assert(replayFixturePath.split("/")[0] === replay.runId, "replay fixture is not run-bound");
    validateRef(primaryRoot, primary.runId, primary.fixture.materialized, "primary fixture");
    validateRef(replayRoot, replay.runId, replay.fixture.materialized, "replay fixture");
  }
}

function provenanceObservations(receipt) {
  return {
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
}

function validateProvenanceEnvelope(root, receipt, step, label) {
  const outputRoot = canonicalOutputRoot(root, label);
  const provenance = receipt.provenance;
  assert(
    provenance?.format === "agent-mail.capture-provenance/v1",
    `${label} envelope reference is missing`,
  );
  assert(
    typeof provenance.path === "string" && provenance.path.split("/")[0] === receipt.runId,
    `${label} envelope path is not run-bound`,
  );
  assert(
    provenance.path === `${receipt.runId}/${receipt.manifestStepId}.provenance.json`,
    `${label} envelope path is not canonical`,
  );
  assert(
    !isAbsolute(provenance.path) && !provenance.path.includes("\\"),
    `${label} envelope path is unsafe`,
  );
  assert(
    provenance.path.split("/").every((part) => part && part !== "." && part !== ".."),
    `${label} envelope path traverses`,
  );
  const envelopePath = resolve(outputRoot, provenance.path);
  assert(
    relative(outputRoot, envelopePath) === provenance.path,
    `${label} envelope escaped output root`,
  );
  const envelopeStat = lstatSync(envelopePath);
  assert(
    envelopeStat.isFile() && !envelopeStat.isSymbolicLink(),
    `${label} envelope is not regular`,
  );
  const envelopeRealPath = realpathSync(envelopePath);
  assert(
    relative(outputRoot, envelopeRealPath) === provenance.path,
    `${label} envelope resolves outside output root`,
  );
  const envelopeBytes = readFileSync(envelopePath);
  assert(envelopeBytes.length === provenance.bytes, `${label} envelope byte count drifted`);
  assert(sha256(envelopeBytes) === provenance.sha256, `${label} envelope digest drifted`);
  const envelope = JSON.parse(envelopeBytes.toString("utf8"));
  assert(envelope.format === provenance.format, `${label} envelope format drifted`);
  assert(
    envelope.runId === receipt.runId && envelope.role === receipt.role,
    `${label} envelope identity drifted`,
  );
  const core = structuredClone(receipt);
  delete core.provenance;
  const receiptDigest = sha256(canonicalJson(core));
  assert(
    envelope.receiptSha256 === receiptDigest && provenance.receiptSha256 === receiptDigest,
    `${label} receipt digest is detached`,
  );
  const observations = provenanceObservations(receipt);
  assert(
    canonicalJson(envelope.observations) === canonicalJson(observations),
    `${label} observations drifted`,
  );
  const observationsDigest = sha256(canonicalJson(observations));
  assert(
    envelope.observationsSha256 === observationsDigest &&
      provenance.observationsSha256 === observationsDigest,
    `${label} observation digest is detached`,
  );
  const expectedAuthority = {
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
    canonicalJson(envelope.authority) === canonicalJson(expectedAuthority),
    `${label} manifest authority drifted`,
  );
  assert(envelope.roots?.output?.path === outputRoot, `${label} output root identity drifted`);
  assert(
    envelope.roots.output.dev === lstatSync(outputRoot).dev &&
      envelope.roots.output.ino === lstatSync(outputRoot).ino,
    `${label} output root inode drifted`,
  );
  assert(envelope.roots?.temporary?.removed === true, `${label} temporary root was not removed`);
  assert(
    typeof envelope.roots.temporary.path === "string" &&
      Number.isSafeInteger(envelope.roots.temporary.dev) &&
      Number.isSafeInteger(envelope.roots.temporary.ino),
    `${label} temporary root identity is missing`,
  );
  const artifactRefs = {
    stdout: receipt.streams.stdout,
    stderr: receipt.streams.stderr,
    events: receipt.streams.events,
    ...(receipt.fixture?.materialized?.path ? { fixture: receipt.fixture.materialized } : {}),
  };
  const identities = new Set([`${envelopeStat.dev}:${envelopeStat.ino}`]);
  for (const [key, ref] of Object.entries(artifactRefs)) {
    const artifact = envelope.artifacts?.[key];
    assert(artifact, `${label} ${key} provenance is missing`);
    assert(
      artifact.path === ref.path && artifact.bytes === ref.bytes && artifact.sha256 === ref.sha256,
      `${label} ${key} provenance reference drifted`,
    );
    assert(
      artifact.capturedAt === receipt.completedAt && !Number.isNaN(Date.parse(artifact.capturedAt)),
      `${label} ${key} capture timestamp is invalid`,
    );
    const path = resolve(outputRoot, ref.path);
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} ${key} is not regular`);
    const bytes = readFileSync(path);
    assert(
      bytes.length === ref.bytes && sha256(bytes) === ref.sha256,
      `${label} ${key} bytes drifted`,
    );
    assert(artifact.dev === stat.dev && artifact.ino === stat.ino, `${label} ${key} inode drifted`);
    assert(
      artifact.birthtimeMs === stat.birthtimeMs &&
        artifact.ctimeMs === stat.ctimeMs &&
        artifact.mtimeMs === stat.mtimeMs,
      `${label} ${key} filesystem timestamps drifted`,
    );
    const identity = `${stat.dev}:${stat.ino}`;
    assert(!identities.has(identity), `${label} ${key} reuses the envelope inode`);
    identities.add(identity);
  }
  return { identity: `${envelopeStat.dev}:${envelopeStat.ino}`, path: envelopePath };
}

function existingRegularPath(path, label) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
  return {
    absolute: resolve(path),
    canonical: realpathSync(path),
    dev: stat.dev,
    ino: stat.ino,
  };
}

function candidateOutputPath(path) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const parentStat = lstatSync(parent);
  assert(
    parentStat.isDirectory() && !parentStat.isSymbolicLink(),
    "receipt output parent is invalid",
  );
  const canonicalParent = realpathSync(parent);
  return { absolute, canonical: join(canonicalParent, absolute.slice(parent.length + 1)) };
}

function assertSafeReceiptOutput(primary, primaryPath, primaryOutputRoot, receiptPath, step) {
  assert(receiptPath, "--receipt is required");
  const primaryFile = existingRegularPath(primaryPath, "primary receipt");
  const primaryEnvelope = validateProvenanceEnvelope(primaryOutputRoot, primary, step, "primary");
  const output = candidateOutputPath(receiptPath);
  const protectedTargets = [
    primaryFile,
    existingRegularPath(primaryEnvelope.path, "primary provenance envelope"),
  ];
  for (const target of protectedTargets) {
    assert(
      output.absolute !== target.absolute,
      "receipt output would overwrite a primary artifact",
    );
    assert(
      output.canonical !== target.canonical,
      "receipt output is a lexical or symlink alias of a primary artifact",
    );
  }
  let existing;
  try {
    existing = lstatSync(output.absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing) {
    assert(
      existing.dev !== primaryFile.dev || existing.ino !== primaryFile.ino,
      "receipt output reuses the primary inode",
    );
    fail("receipt output already exists");
  }
  return output.absolute;
}

export function writeExclusiveReceipt(path, bytes) {
  let descriptor;
  let created = false;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    created = true;
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
    const file = fstatSync(descriptor);
    assert(
      file.isFile() && file.size === bytes.length,
      "receipt output changed during exclusive write",
    );
    const pathStat = lstatSync(path);
    assert(
      !pathStat.isSymbolicLink() && pathStat.dev === file.dev && pathStat.ino === file.ino,
      "receipt output identity changed during write",
    );
  } catch (error) {
    if (created) {
      try {
        const pathStat = lstatSync(path);
        if (descriptor !== undefined) {
          const file = fstatSync(descriptor);
          if (pathStat.dev === file.dev && pathStat.ino === file.ino) unlinkSync(path);
        }
      } catch {}
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function compareReceipts(primary, replay, options = {}) {
  assertManifestStep(options.step);
  assert(
    options.primaryOutputRoot && options.replayOutputRoot,
    "primary and replay output roots are required",
  );
  assert(Array.isArray(options.runnerSources), "runner source authority is required");
  assert(primary.format === "agent-mail.executable-receipt/v2", "primary receipt format");
  assert(replay.format === primary.format, "replay receipt format");
  assert(primary.role === "primary" && replay.role === "independent-replay", "receipt roles");
  assert(
    primary.manifestStepId === options.step.id && replay.manifestStepId === options.step.id,
    "manifest step diverged",
  );
  assert(
    primary.cwd === options.step.cwd && replay.cwd === options.step.cwd,
    "manifest cwd diverged",
  );
  const expectedSources = (options.step.sources ?? []).map(
    ({ role, path, gitBlob, sha256: digest }) => ({ role, path, gitBlob, sha256: digest }),
  );
  assert(
    canonicalJson(primary.sources) === canonicalJson(expectedSources),
    "primary source authority diverged",
  );
  assert(
    canonicalJson(replay.sources) === canonicalJson(expectedSources),
    "replay source authority diverged",
  );
  const expectedRunnerSources = options.runnerSources.map(
    ({ role, path, gitBlob, sha256: digest }) => ({
      role,
      path,
      gitBlob,
      sha256: digest,
    }),
  );
  assert(
    canonicalJson(primary.runnerSources ?? []) === canonicalJson(expectedRunnerSources) &&
      canonicalJson(replay.runnerSources ?? []) === canonicalJson(expectedRunnerSources),
    "runner source authority diverged",
  );
  assert(primary.runId !== replay.runId, "replay reused the primary run ID");
  const primaryPids = validateIndependentRuntime(primary, "primary receipt", options.step);
  const replayPids = validateIndependentRuntime(replay, "replay receipt", options.step);
  const primaryEnvelope = validateProvenanceEnvelope(
    options.primaryOutputRoot,
    primary,
    options.step,
    "primary",
  );
  const replayEnvelope = validateProvenanceEnvelope(
    options.replayOutputRoot,
    replay,
    options.step,
    "replay",
  );
  assert(
    primaryEnvelope.identity !== replayEnvelope.identity,
    "replay reused the primary provenance envelope",
  );
  assert(
    primary.process?.pid !== replay.process?.pid &&
      primary.process?.processGroup !== replay.process?.processGroup,
    "replay reused the primary process identity",
  );
  assert(
    [...primaryPids].every((pid) => !replayPids.has(pid)),
    "replay reused a primary process PID",
  );
  assert(
    primary.probes.tempRoot.path !== replay.probes.tempRoot.path,
    "replay reused the primary checkout/temp root",
  );
  for (const key of ["commit", "tree", "manifestPath", "manifestSha256"]) {
    assert(primary.candidate[key] === replay.candidate[key], `candidate ${key} diverged`);
  }
  for (const key of ["manifestStepId", "cwd"])
    assert(primary[key] === replay[key], `${key} diverged`);
  assert(canonicalJson(primary.argv) === canonicalJson(replay.argv), "replay argv diverged");
  assert(
    canonicalJson(primary.sources) === canonicalJson(replay.sources),
    "replay source bindings diverged",
  );
  assert(
    canonicalJson(comparableFixture(primary.fixture)) ===
      canonicalJson(comparableFixture(replay.fixture)),
    "replay fixture diverged",
  );
  assert(
    canonicalJson(primary.assertions) === canonicalJson(replay.assertions),
    "replay assertions diverged",
  );
  assertDistinctRegularArtifacts(primary, replay, options);
  return {
    candidateCommit: primary.candidate.commit,
    candidateTree: primary.candidate.tree,
    stepId: primary.manifestStepId,
    primaryRunId: primary.runId,
    replayRunId: replay.runId,
    primaryResult: primary.result,
    replayResult: replay.result,
    primaryDurationNs: primary.monotonic.durationNs,
    replayDurationNs: replay.monotonic.durationNs,
    primaryPeakRssBytes: primary.probes.process.peakRssBytes,
    replayPeakRssBytes: replay.probes.process.peakRssBytes,
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

async function selfTest() {
  const root = mkdtempSync("/tmp/agent-mail-replay-self-test-");
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "replay@example.invalid"]);
    git(root, ["config", "user.name", "replay self-test"]);
    writeFileSync(join(root, "tiny-receipt.mjs"), "process.stdout.write('tiny-pass\\n');\n");
    git(root, ["add", "tiny-receipt.mjs"]);
    git(root, ["commit", "-qm", "tiny command"]);
    const source = execFileSync("git", ["cat-file", "blob", "HEAD:tiny-receipt.mjs"], {
      cwd: root,
    });
    const manifest = {
      format: "agent-mail.release-evidence-execution-manifest/v2",
      schemaVersion: 2,
      ownerIssueId: 176,
      replay: {
        required: true,
        compare: ["candidate", "argv", "sources", "fixture", "assertions"],
      },
      attackInventory: Array.from({ length: 40 }, (_, index) => `tiny-attack-${index + 1}`),
      steps: [
        {
          id: "tiny-command",
          ownerIssueId: 176,
          gate: "capacity",
          obligationIds: ["F17"],
          cwd: ".",
          argv: ["node", "tiny-receipt.mjs"],
          sources: [
            {
              role: "entrypoint",
              path: "tiny-receipt.mjs",
              gitBlob: git(root, ["rev-parse", "HEAD:tiny-receipt.mjs"]),
              sha256: sha256(source),
            },
          ],
          assertions: [{ id: "tiny-exit-zero", kind: "exitCode", expected: 0 }],
          observations: ["stdout", "stderr", "exitCode", "durationNs"],
          thresholds: { timeoutMs: 5000 },
          probes: ["process", "streams", "tempRoot"],
          fixture: { kind: "generated-stream", id: "tiny-fixture", recipe: "stdout:tiny-pass" },
        },
      ],
    };
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    git(root, ["add", "manifest.json"]);
    git(root, ["commit", "-qm", "tiny manifest"]);
    const primaryRoot = mkdtempSync(join(tmpdir(), "agent-mail-replay-primary-"));
    const replayRoot = mkdtempSync(join(tmpdir(), "agent-mail-replay-replay-"));
    const primary = await capture({ manifestPath, root, outputRoot: primaryRoot, role: "primary" });
    const replayCheckout = join(root, "replay-checkout");
    git(root, ["clone", "-q", root, replayCheckout]);
    const replay = await capture({
      manifestPath: join(replayCheckout, "manifest.json"),
      root: replayCheckout,
      outputRoot: replayRoot,
      role: "independent-replay",
    });
    const comparison = compareReceipts(primary, replay, {
      primaryOutputRoot: primaryRoot,
      replayOutputRoot: replayRoot,
      step: manifest.steps[0],
      runnerSources: manifest.runner?.sources ?? [],
    });
    const attacks = [
      ["reused run ID", (value) => (value.runId = primary.runId)],
      ["reused temp root", (value) => (value.probes.tempRoot.path = primary.probes.tempRoot.path)],
      ["reused process PID", (value) => (value.process.pid = primary.process.pid)],
      [
        "reused process group",
        (value) => (value.process.processGroup = primary.process.processGroup),
      ],
      ["source drift", (value) => (value.sources[0].sha256 = "0".repeat(64))],
      ["argv drift", (value) => (value.argv = ["node", "forged.mjs"])],
      ["assertion drift", (value) => (value.assertions[0].pass = false)],
      [
        "fixture path reuse",
        (value) => (value.fixture.materialized.path = primary.fixture.materialized.path),
      ],
      ["stream path reuse", (value) => (value.streams.stdout.path = primary.streams.stdout.path)],
      ["RSS unavailable", (value) => (value.probes.process.rssStatus = "notApplicable")],
      [
        "cleanup survivor",
        (value) => (value.probes.cleanup.termination.survivorsAfterKill = [1234]),
      ],
      ["artifact digest drift", (value) => (value.streams.stdout.sha256 = "0".repeat(64))],
      ["artifact missing", (value) => (value.streams.stderr.path = `${value.runId}/missing`)],
      ["artifact traversal", (value) => (value.streams.events.path = "../events.jsonl")],
      ["resource PID retyping", (value) => (value.probes.resources.pids = [1234])],
      [
        "provenance receipt digest drift",
        (value) => (value.provenance.receiptSha256 = "0".repeat(64)),
      ],
      [
        "provenance path reuse",
        (value) =>
          (value.provenance.path = `${primary.runId}/${primary.manifestStepId}.provenance.json`),
      ],
      ["provenance digest drift", (value) => (value.provenance.sha256 = "0".repeat(64))],
      [
        "provenance observation drift",
        (value) => (value.provenance.observationsSha256 = "0".repeat(64)),
      ],
    ];
    let authorityRejected = 0;
    for (const invalidOptions of [
      { step: manifest.steps[0], runnerSources: manifest.runner?.sources ?? [] },
      { primaryOutputRoot: primaryRoot, replayOutputRoot: replayRoot },
      { primaryOutputRoot: primaryRoot, replayOutputRoot: replayRoot, step: manifest.steps[0] },
    ]) {
      try {
        compareReceipts(primary, replay, invalidOptions);
      } catch {
        authorityRejected += 1;
      }
    }
    assert(authorityRejected === 3, "root or manifest authority omission was accepted");
    let aliasRejected = false;
    try {
      compareReceipts(primary, replay, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: primaryRoot,
        step: manifest.steps[0],
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      aliasRejected = true;
    }
    assert(aliasRejected, "aliased output roots were accepted");
    const replayEnvelopePath = join(replayRoot, replay.provenance.path);
    const replayEnvelopeBytes = readFileSync(replayEnvelopePath);
    rmSync(replayEnvelopePath);
    let missingEnvelopeRejected = false;
    try {
      compareReceipts(primary, replay, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: manifest.steps[0],
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      missingEnvelopeRejected = true;
    }
    assert(missingEnvelopeRejected, "missing provenance envelope was accepted");
    writeFileSync(replayEnvelopePath, replayEnvelopeBytes);
    const primaryEnvelopeBytes = readFileSync(join(primaryRoot, primary.provenance.path));
    writeFileSync(replayEnvelopePath, primaryEnvelopeBytes);
    let substitutedEnvelopeRejected = false;
    try {
      compareReceipts(primary, replay, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: manifest.steps[0],
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      substitutedEnvelopeRejected = true;
    }
    assert(substitutedEnvelopeRejected, "substituted provenance envelope was accepted");
    writeFileSync(replayEnvelopePath, replayEnvelopeBytes);
    const replayRunDirectory = join(replayRoot, replay.runId);
    const symlinkPath = join(replayRunDirectory, "symlink");
    symlinkSync(join(primaryRoot, primary.streams.stdout.path), symlinkPath);
    const symlinkForged = structuredClone(replay);
    symlinkForged.streams.stderr.path = `${replay.runId}/symlink`;
    symlinkForged.streams.stderr.bytes = primary.streams.stdout.bytes;
    symlinkForged.streams.stderr.sha256 = primary.streams.stdout.sha256;
    let symlinkRejected = false;
    try {
      compareReceipts(primary, symlinkForged, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: manifest.steps[0],
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      symlinkRejected = true;
    }
    assert(symlinkRejected, "symlink artifact alias was accepted");
    const hardlinkPath = join(replayRunDirectory, "hardlink");
    linkSync(join(primaryRoot, primary.streams.stdout.path), hardlinkPath);
    const hardlinkForged = structuredClone(replay);
    hardlinkForged.streams.stderr.path = `${replay.runId}/hardlink`;
    hardlinkForged.streams.stderr.bytes = primary.streams.stdout.bytes;
    hardlinkForged.streams.stderr.sha256 = primary.streams.stdout.sha256;
    let hardlinkRejected = false;
    try {
      compareReceipts(primary, hardlinkForged, {
        primaryOutputRoot: primaryRoot,
        replayOutputRoot: replayRoot,
        step: manifest.steps[0],
        runnerSources: manifest.runner?.sources ?? [],
      });
    } catch {
      hardlinkRejected = true;
    }
    assert(hardlinkRejected, "hard-linked artifact alias was accepted");
    let rejected = 0;
    for (const [name, mutate] of attacks) {
      const forged = structuredClone(replay);
      mutate(forged);
      let accepted = false;
      try {
        compareReceipts(primary, forged, {
          primaryOutputRoot: primaryRoot,
          replayOutputRoot: replayRoot,
          step: manifest.steps[0],
          runnerSources: manifest.runner?.sources ?? [],
        });
        accepted = true;
      } catch {}
      const attackName = typeof name === "string" ? name : "unknown";
      assert(!accepted, `${attackName} attack was accepted`);
      rejected += 1;
    }
    rmSync(primaryRoot, { recursive: true, force: true });
    rmSync(replayRoot, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        format: "agent-mail.executable-receipt/v2",
        accepted: true,
        attacks: rejected + authorityRejected + 4,
        comparison,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  assert(args.primary, "--primary receipt is required");
  assert(args.manifest, "--manifest is required");
  assert(args["primary-output-root"], "--primary-output-root is required");
  assert(args["output-root"], "--output-root is required");
  const primary = JSON.parse(readFileSync(resolve(args.primary), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8"));
  const stepId = args.step ?? primary.manifestStepId;
  const step = manifest.steps?.find((candidate) => candidate.id === stepId);
  assert(step, `manifest step ${stepId} is missing`);
  const primaryOutputRoot = canonicalOutputRoot(args["primary-output-root"], "primary");
  const replayOutputRoot = canonicalOutputRoot(args["output-root"], "replay");
  const receiptPath = assertSafeReceiptOutput(
    primary,
    resolve(args.primary),
    primaryOutputRoot,
    args.receipt,
    step,
  );
  const receipt = await capture({
    manifestPath: args.manifest,
    root: args.root ? resolve(args.root) : resolve(here, "../.."),
    outputRoot: resolve(args["output-root"]),
    role: "independent-replay",
    stepId,
  });
  const comparison = compareReceipts(primary, receipt, {
    primaryOutputRoot,
    replayOutputRoot,
    step,
    runnerSources: manifest.runner?.sources ?? [],
  });
  writeExclusiveReceipt(receiptPath, Buffer.from(JSON.stringify(receipt, null, 2) + "\n"));
  console.log(JSON.stringify({ receiptPath, comparison }));
}

if (import.meta.main) await main();
