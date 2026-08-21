import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function compareReceipts(primary, replay) {
  assert(primary.format === "agent-mail.executable-receipt/v2", "primary receipt format");
  assert(replay.format === primary.format, "replay receipt format");
  assert(primary.role === "primary" && replay.role === "independent-replay", "receipt roles");
  assert(primary.runId !== replay.runId, "replay reused the primary run ID");
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
    canonicalJson(primary.fixture) === canonicalJson(replay.fixture),
    "replay fixture diverged",
  );
  assert(
    canonicalJson(primary.assertions) === canonicalJson(replay.assertions),
    "replay assertions diverged",
  );
  assert(primary.result === "pass" && replay.result === "pass", "replay did not pass");
  assert(primary.streams.stdout.path !== replay.streams.stdout.path, "stdout path was reused");
  assert(primary.streams.stderr.path !== replay.streams.stderr.path, "stderr path was reused");
  assert(primary.streams.events.path !== replay.streams.events.path, "event path was reused");
  return {
    candidateCommit: primary.candidate.commit,
    candidateTree: primary.candidate.tree,
    stepId: primary.manifestStepId,
    primaryRunId: primary.runId,
    replayRunId: replay.runId,
    primaryResult: primary.result,
    replayResult: replay.result,
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
    const primaryRoot = join(root, "primary");
    const replayRoot = join(root, "replay");
    const primary = await capture({ manifestPath, root, outputRoot: primaryRoot, role: "primary" });
    const replayCheckout = join(root, "replay-checkout");
    git(root, ["clone", "-q", root, replayCheckout]);
    const replay = await capture({
      manifestPath: join(replayCheckout, "manifest.json"),
      root: replayCheckout,
      outputRoot: replayRoot,
      role: "independent-replay",
    });
    const comparison = compareReceipts(primary, replay);
    console.log(
      JSON.stringify({ format: "agent-mail.executable-receipt/v2", accepted: true, comparison }),
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
