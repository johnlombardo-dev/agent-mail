import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { capture, sha256, validateManifest } from "../../scripts/qualification/capture-release-evidence.mjs";
import { compareReceipts } from "../../scripts/qualification/replay-release-evidence.mjs";

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function disposableManifest(root: string) {
  const sourcePath = "tiny-runner.mjs";
  const sourceBytes = Buffer.from(
    "process.stdout.write(JSON.stringify({format:'agent-mail.observation/v1',event:'oracle',value:'pass'}) + '\\n');\nconst sourceToken = true;\n",
  );
  writeFileSync(join(root, sourcePath), sourceBytes);
  git(root, ["add", sourcePath]);
  git(root, ["commit", "-qm", "candidate source"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const blob = git(root, ["rev-parse", `HEAD:${sourcePath}`]);
  const manifest = {
    format: "agent-mail.release-evidence-execution-manifest/v2",
    schemaVersion: 2,
    ownerIssueId: 176,
    replay: { required: true },
    attackInventory: Array.from({ length: 40 }, (_, index) => `runner-attack-${index + 1}`),
    steps: [
      {
        id: "tiny-runner",
        gate: "capacity",
        obligationIds: ["F17"],
        cwd: ".",
        argv: ["node", sourcePath],
        sources: [{ role: "entrypoint", path: sourcePath, gitBlob: blob, sha256: sha256(sourceBytes) }],
        assertions: [
          { id: "source-token", kind: "source-token", sourcePath, token: "sourceToken", occurrences: 1 },
          { id: "oracle", kind: "structured-oracle", event: "oracle", field: "value", expected: "pass" },
          { id: "exit", kind: "exitCode", expected: 0 },
        ],
        observations: ["stdout", "events"],
        thresholds: { timeoutMs: 5_000 },
        probes: ["processTreeRss", "tempRoot"],
      },
    ],
  };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(root, ["add", "manifest.json"]);
  git(root, ["commit", "-qm", "candidate manifest"]);
  validateManifest(manifest, root, git(root, ["rev-parse", "HEAD"]));
  return { manifest, manifestPath, commit };
}

function disposableRepo() {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-runner-test-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "runner-test@example.invalid"]);
  git(root, ["config", "user.name", "runner test"]);
  const fixture = disposableManifest(root);
  return { root, ...fixture };
}

describe("release evidence executable runner", () => {
  test("captures committed bytes and independently replays a real selected step", async () => {
    const fixture = disposableRepo();
    const output = mkdtempSync(join(tmpdir(), "agent-mail-runner-output-"));
    try {
      const primary = await capture({ root: fixture.root, manifestPath: fixture.manifestPath, outputRoot: output });
      const replayRoot = mkdtempSync(join(tmpdir(), "agent-mail-runner-replay-"));
      try {
        git(fixture.root, ["clone", "-q", "--no-hardlinks", fixture.root, replayRoot]);
        const replay = await capture({
          root: replayRoot,
          manifestPath: join(replayRoot, "manifest.json"),
          outputRoot: mkdtempSync(join(tmpdir(), "agent-mail-runner-replay-output-")),
          role: "independent-replay",
        });
        expect(primary.result).toBe("pass");
        expect(replay.result).toBe("pass");
        expect(primary.sources).toHaveLength(1);
        expect(primary.runnerSources).toHaveLength(0);
        expect(primary.resolvedArgv).toEqual(["node", "tiny-runner.mjs"]);
        expect(compareReceipts(primary, replay).replayResult).toBe("pass");
      } finally {
        rmSync(replayRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("blocks dirty candidate bytes and unresolved literal placeholders", async () => {
    const fixture = disposableRepo();
    try {
      writeFileSync(join(fixture.root, "tiny-runner.mjs"), "process.exit(0);\n");
      await expect(
        capture({ root: fixture.root, manifestPath: fixture.manifestPath }),
      ).rejects.toThrow(/worktree is dirty/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
