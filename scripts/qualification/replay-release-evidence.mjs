import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
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

function receiptPidSet(receipt, label) {
  const samples = receipt.probes?.process?.samples;
  assert(Array.isArray(samples) && samples.length >= 2, `${label} process samples are incomplete`);
  const pids = new Set();
  for (const sample of samples) {
    assert(Array.isArray(sample.pids), `${label} process sample PIDs are missing`);
    for (const pid of sample.pids) {
      assert(Number.isSafeInteger(pid) && pid > 1, `${label} process sample PID is invalid`);
      pids.add(pid);
    }
  }
  assert(pids.size > 0, `${label} process PID inventory is empty`);
  return pids;
}

function validateIndependentRuntime(receipt, label, step) {
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
  const rssThreshold = thresholds.processRssBytes;
  if (rssThreshold) {
    const { operator, limit } = rssThreshold;
    const pass =
      operator === "<"
        ? process.peakRssBytes < limit
        : operator === "<="
          ? process.peakRssBytes <= limit
          : operator === "==="
            ? process.peakRssBytes === limit
            : operator === ">="
              ? process.peakRssBytes >= limit
              : process.peakRssBytes > limit;
    assert(pass, `${label} RSS threshold failed`);
  }
  if (step?.probes?.includes("fileDescriptors"))
    assert(
      receipt.probes.resources?.observed === true,
      `${label} file descriptor probe is unavailable`,
    );
  if (step?.probes?.includes("listeners"))
    assert(receipt.probes.resources?.observed === true, `${label} listener probe is unavailable`);
  return receiptPidSet(receipt, label);
}

function assertDistinctRegularArtifacts(primary, replay, options) {
  const primaryRoot = options?.primaryOutputRoot;
  const replayRoot = options?.replayOutputRoot;
  const refs = ["stdout", "stderr", "events"].map((key) => [
    key,
    primary.streams[key],
    replay.streams[key],
  ]);
  for (const [key, primaryRef, replayRef] of refs) {
    assert(primaryRef.path !== replayRef.path, `${key} path was reused`);
    assert(primaryRef.path.split("/")[0] === primary.runId, `${key} primary path is not run-bound`);
    assert(replayRef.path.split("/")[0] === replay.runId, `${key} replay path is not run-bound`);
    if (!primaryRoot || !replayRoot) continue;
    const primaryStat = lstatSync(resolve(primaryRoot, primaryRef.path));
    const replayStat = lstatSync(resolve(replayRoot, replayRef.path));
    assert(primaryStat.isFile() && replayStat.isFile(), `${key} artifact is not a regular file`);
    assert(
      !primaryStat.isSymbolicLink() && !replayStat.isSymbolicLink(),
      `${key} artifact is a symlink`,
    );
    assert(
      primaryStat.dev !== replayStat.dev || primaryStat.ino !== replayStat.ino,
      `${key} artifact is hard-linked or reused`,
    );
  }
  const primaryFixturePath = primary.fixture?.materialized?.path;
  const replayFixturePath = replay.fixture?.materialized?.path;
  if (primaryFixturePath || replayFixturePath) {
    assert(primaryFixturePath && replayFixturePath, "fixture materialization path is missing");
    assert(primaryFixturePath !== replayFixturePath, "fixture artifact path was reused");
    assert(primaryFixturePath.split("/")[0] === primary.runId, "primary fixture is not run-bound");
    assert(replayFixturePath.split("/")[0] === replay.runId, "replay fixture is not run-bound");
  }
}

export function compareReceipts(primary, replay, options = {}) {
  assert(primary.format === "agent-mail.executable-receipt/v2", "primary receipt format");
  assert(replay.format === primary.format, "replay receipt format");
  assert(primary.role === "primary" && replay.role === "independent-replay", "receipt roles");
  assert(primary.runId !== replay.runId, "replay reused the primary run ID");
  const primaryPids = validateIndependentRuntime(primary, "primary receipt", options.step);
  const replayPids = validateIndependentRuntime(replay, "replay receipt", options.step);
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
    ];
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
        });
        accepted = true;
      } catch {}
      assert(!accepted, `${name} attack was accepted`);
      rejected += 1;
    }
    rmSync(primaryRoot, { recursive: true, force: true });
    rmSync(replayRoot, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        format: "agent-mail.executable-receipt/v2",
        accepted: true,
        attacks: rejected,
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
  const primary = JSON.parse(readFileSync(resolve(args.primary), "utf8"));
  const receipt = await capture({
    manifestPath: args.manifest,
    root: args.root ? resolve(args.root) : resolve(here, "../.."),
    outputRoot: args.outputRoot ? resolve(args.outputRoot) : undefined,
    role: "independent-replay",
    stepId: args.step,
  });
  const comparison = compareReceipts(primary, receipt);
  const output = args.receipt
    ? resolve(args.receipt)
    : join(process.cwd(), `${receipt.runId}.replay.json`);
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ receiptPath: output, comparison }));
}

if (import.meta.main) await main();
