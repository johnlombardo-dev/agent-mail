import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  capture,
  cleanGeneratedStaging,
  generationReceipt,
  observationThresholdValues,
  processTreeSnapshot,
  retainGeneratedArtifact,
  runProcess,
  sha256,
  thresholdMetricRegistry,
  validateManifest,
} from "../../scripts/qualification/capture-release-evidence.mjs";
import {
  compareReceipts,
  writeExclusiveReceipt,
} from "../../scripts/qualification/replay-release-evidence.mjs";

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function disposableManifest(
  root: string,
  oracleValue: unknown = "pass",
  sourceEvent: "valid" | "missing" | "retyped" | "wrong-format" = "valid",
) {
  const sourcePath = "tiny-runner.mjs";
  const oraclePath = "oracle.json";
  const oracleBytes = Buffer.from(`${JSON.stringify({ value: oracleValue })}\n`);
  writeFileSync(join(root, oraclePath), oracleBytes);
  const oracleSha256 = sha256(oracleBytes);
  const oracleLiteral = JSON.stringify(oracleValue);
  const sourceEventLine =
    sourceEvent === "missing"
      ? ""
      : `process.stdout.write(JSON.stringify({format:'${sourceEvent === "wrong-format" ? "wrong-format" : "agent-mail.observation/v1"}',event:'source-token',assertionId:'source-token',sourcePath,sourceSha256,token:'${sourceEvent === "retyped" ? "wrongToken" : "sourceToken"}',observed:1,expected:1,pass:true}) + '\\n');\n`;
  const sourceBytes = Buffer.from(
    `import { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\nconst sourceToken = true;\nconst sourcePath = '${sourcePath}';\nconst sourceSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');\n${sourceEventLine}process.stdout.write(JSON.stringify({format:'agent-mail.observation/v1',event:'oracle',path:'${oraclePath}',sha256:'${oracleSha256}',pointer:'/value',value:${oracleLiteral}}) + '\\n');\n`,
  );
  writeFileSync(join(root, sourcePath), sourceBytes);
  writeFileSync(join(root, "package.json"), readFileSync("package.json"));
  writeFileSync(join(root, "bun.lock"), readFileSync("bun.lock"));
  git(root, ["add", sourcePath, oraclePath, "package.json", "bun.lock"]);
  git(root, ["commit", "-qm", "candidate source"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const blob = git(root, ["rev-parse", `HEAD:${sourcePath}`]);
  const oracleBlob = git(root, ["rev-parse", `HEAD:${oraclePath}`]);
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
        sources: [
          { role: "entrypoint", path: sourcePath, gitBlob: blob, sha256: sha256(sourceBytes) },
          { role: "oracle", path: oraclePath, gitBlob: oracleBlob, sha256: oracleSha256 },
        ],
        assertions: [
          { id: "source-token", kind: "source-token", sourcePath, token: "sourceToken", occurrences: 1 },
          {
            id: "oracle",
            kind: "structured-oracle",
            event: "oracle",
            path: oraclePath,
            sha256: oracleSha256,
            pointer: "/value",
            value: oracleValue,
          },
          { id: "exit", kind: "exitCode", expected: 0 },
        ],
        observations: ["stdout", "events"],
        thresholds: { timeoutMs: 5_000 },
        probes: ["processTreeRss", "tempRoot"],
      },
    ],
    runner: {
      dependencyMode: "bun-frozen-offline",
      sources: [{ role: "runner", path: sourcePath, gitBlob: blob, sha256: sha256(sourceBytes) }],
    },
  };
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  git(root, ["add", "manifest.json"]);
  git(root, ["commit", "-qm", "candidate manifest"]);
  validateManifest(manifest, root, git(root, ["rev-parse", "HEAD"]));
  return { manifest, manifestPath, commit };
}

function disposableRepo(
  oracleValue: unknown = "pass",
  sourceEvent: "valid" | "missing" | "retyped" | "wrong-format" = "valid",
) {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-runner-test-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "runner-test@example.invalid"]);
  git(root, ["config", "user.name", "runner test"]);
  const fixture = disposableManifest(root, oracleValue, sourceEvent);
  return { root, ...fixture };
}

function numericSourceFixture() {
  const fixture = disposableRepo();
  const sourcePath = "packages/imap/test/mime-capacity-p2-c11.ts";
  const sourceBytes = Buffer.from(
    "export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\n",
  );
  mkdirSync(join(fixture.root, "packages/imap/test"), { recursive: true });
  writeFileSync(join(fixture.root, sourcePath), sourceBytes);
  git(fixture.root, ["add", sourcePath]);
  git(fixture.root, ["commit", "-qm", "numeric source authority"]);
  const sourceBlob = git(fixture.root, ["rev-parse", `HEAD:${sourcePath}`]);
  const step = fixture.manifest.steps[0];
  step.id = "mime-250mib";
  step.sources.push({
    role: "mime-threshold-authority",
    path: sourcePath,
    gitBlob: sourceBlob,
    sha256: sha256(sourceBytes),
  });
  step.assertions.push({
    id: "mime-fixture-observation",
    kind: "fixture-observation",
    sourcePath,
    fixtureId: "issue-176-mime-250mib",
    expectedBytes: 262144000,
    expectedPeakGrowthBytes: 134217728,
  });
  step.thresholds = {
    peakGrowth: { source: "fixture-observation", operator: "<", limit: 134217728, unit: "bytes" },
    timeoutMs: 5_000,
  };
  step.numericSourceConstants = [
    {
      id: "mime-rss-growth-threshold",
      sourcePath,
      exportName: "RSS_GROWTH_THRESHOLD_BYTES",
      expression: "128 * MEBIBYTE",
      value: 134217728,
      fixtureAssertionId: "mime-fixture-observation",
      fixtureAssertionField: "expectedPeakGrowthBytes",
      thresholdMetric: "peakGrowth",
      thresholdField: "limit",
    },
  ];
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
  git(fixture.root, ["add", "manifest.json"]);
  git(fixture.root, ["commit", "-qm", "numeric source manifest authority"]);
  const commit = git(fixture.root, ["rev-parse", "HEAD"]);
  validateManifest(fixture.manifest, fixture.root, commit);
  return { ...fixture, commit, sourcePath };
}

function testCapture(options: Parameters<typeof capture>[0]) {
  return capture({ ...options, selfTest: true });
}

describe("release evidence executable runner", () => {
  test("captures committed bytes and independently replays a real selected step", async () => {
    const fixture = disposableRepo();
    const output = mkdtempSync(join(tmpdir(), "agent-mail-runner-output-"));
    try {
      const primary = await testCapture({ root: fixture.root, manifestPath: fixture.manifestPath, outputRoot: output });
      const replayRoot = mkdtempSync(join(tmpdir(), "agent-mail-runner-replay-"));
      const replayOutput = mkdtempSync(join(tmpdir(), "agent-mail-runner-replay-output-"));
      try {
        git(fixture.root, ["clone", "-q", "--no-hardlinks", fixture.root, replayRoot]);
        const replay = await testCapture({
          root: replayRoot,
          manifestPath: join(replayRoot, "manifest.json"),
          outputRoot: replayOutput,
          role: "independent-replay",
        });
        expect(primary.result).toBe("pass");
        expect(replay.result).toBe("pass");
        expect(primary.sources).toHaveLength(2);
        expect(primary.runnerSources).toHaveLength(1);
        expect(primary.argv).toEqual(["node", "tiny-runner.mjs"]);
        expect(primary.probes.process.observed).toBe(true);
        expect(typeof primary.probes.resources.observed).toBe("boolean");
        expect(primary.probes.cleanup.barrier).toBe("awaited-idempotent");
        expect(primary.provenance.format).toBe("agent-mail.capture-provenance/v1");
        expect(primary.provenance.receiptSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(existsSync(join(output, primary.provenance.path))).toBe(true);
        expect(primary.probes.cleanup.invocations).toBe(1);
        expect(primary.monotonic.intervals.map((interval: { id: string }) => interval.id)).toEqual([
          "setup",
          "execution",
          "retention-and-cleanup",
        ]);
        expect(
          compareReceipts(primary, replay, {
            primaryOutputRoot: output,
            replayOutputRoot: replayOutput,
            step: fixture.manifest.steps[0],
            runnerSources: fixture.manifest.runner.sources,
          }).replayResult,
        ).toBe("pass");
        const attacks = [
          (value: typeof replay) => (value.runId = primary.runId),
          (value: typeof replay) => (value.process.pid = primary.process.pid),
          (value: typeof replay) => (value.probes.tempRoot.path = primary.probes.tempRoot.path),
          (value: typeof replay) =>
            (value.streams.stdout.path = primary.streams.stdout.path),
          (value: typeof replay) => (value.probes.cleanup.termination.survivorsAfterKill = [1234]),
          (value: typeof replay) => (value.provenance.sha256 = "0".repeat(64)),
          (value: typeof replay) =>
            (value.provenance.path = `${primary.runId}/${primary.manifestStepId}.provenance.json`),
        ];
        for (const mutate of attacks) {
          const forged = structuredClone(replay);
          mutate(forged);
          expect(() => compareReceipts(primary, forged, {
            primaryOutputRoot: output,
            replayOutputRoot: replayOutput,
            step: fixture.manifest.steps[0],
            runnerSources: fixture.manifest.runner.sources,
          })).toThrow();
        }
      } finally {
        rmSync(replayRoot, { recursive: true, force: true });
        rmSync(replayOutput, { recursive: true, force: true });
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
        testCapture({ root: fixture.root, manifestPath: fixture.manifestPath }),
      ).rejects.toThrow(/worktree is dirty/u);
      rmSync(fixture.root, { recursive: true, force: true });
      const placeholder = disposableRepo();
      placeholder.manifest.steps[0].argv = ["node", "<unresolved-placeholder>"];
      writeFileSync(placeholder.manifestPath, `${JSON.stringify(placeholder.manifest, null, 2)}\n`);
      git(placeholder.root, ["add", "manifest.json"]);
      git(placeholder.root, ["commit", "-qm", "placeholder attack"]);
      await expect(
        testCapture({ root: placeholder.root, manifestPath: placeholder.manifestPath }),
      ).rejects.toThrow(/placeholder/u);
      rmSync(placeholder.root, { recursive: true, force: true });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects CLI receipt overwrite and aliases before replay capture", async () => {
    const fixture = disposableRepo();
    const primaryOutput = mkdtempSync(join(tmpdir(), "agent-mail-runner-primary-receipt-"));
    const replayOutput = mkdtempSync(join(tmpdir(), "agent-mail-runner-replay-receipt-"));
    const primaryReceiptPath = join(primaryOutput, "primary.receipt.json");
    try {
      const primary = await testCapture({
        root: fixture.root,
        manifestPath: fixture.manifestPath,
        outputRoot: primaryOutput,
      });
      writeFileSync(primaryReceiptPath, `${JSON.stringify(primary, null, 2)}\n`);
      const originalBytes = readFileSync(primaryReceiptPath);
      const originalStat = lstatSync(primaryReceiptPath);
      const hardlinkPath = join(primaryOutput, "hardlink.receipt.json");
      const symlinkPath = join(primaryOutput, "symlink.receipt.json");
      linkSync(primaryReceiptPath, hardlinkPath);
      symlinkSync(primaryReceiptPath, symlinkPath);
      const targets = [
        primaryReceiptPath,
        join(primaryOutput, ".", "primary.receipt.json"),
        join(primaryOutput, primary.provenance.path),
        hardlinkPath,
        symlinkPath,
      ];
      for (const target of targets) {
        expect(() =>
          execFileSync(
            "bun",
            [
              "scripts/qualification/replay-release-evidence.mjs",
              "--primary",
              primaryReceiptPath,
              "--manifest",
              fixture.manifestPath,
              "--root",
              fixture.root,
              "--primary-output-root",
              primaryOutput,
              "--output-root",
              replayOutput,
              "--receipt",
              target,
            ],
            { encoding: "utf8" },
          ),
        ).toThrow(/receipt output|overwrite|alias/u);
        expect(readdirSync(replayOutput)).toEqual([]);
        expect(readFileSync(primaryReceiptPath)).toEqual(originalBytes);
        const currentStat = lstatSync(primaryReceiptPath);
        expect([currentStat.dev, currentStat.ino]).toEqual([originalStat.dev, originalStat.ino]);
      }
      const exclusiveReceiptPath = join(replayOutput, "replay.receipt.json");
      writeExclusiveReceipt(exclusiveReceiptPath, Buffer.from('{"result":"pass"}\n'));
      expect(JSON.parse(readFileSync(exclusiveReceiptPath, "utf8")).result).toBe("pass");
      expect(() => writeExclusiveReceipt(exclusiveReceiptPath, Buffer.from("overwrite\n"))).toThrow();
    } finally {
      rmSync(primaryOutput, { recursive: true, force: true });
      rmSync(replayOutput, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate assertion IDs before candidate execution", () => {
    const fixture = disposableRepo();
    try {
      fixture.manifest.steps[0].assertions.push({ ...fixture.manifest.steps[0].assertions[0] });
      expect(() => validateManifest(fixture.manifest, fixture.root)).toThrow(/assertion id repeats/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects unavailable probe names and detached kernel thresholds", () => {
    const fixture = disposableRepo();
    try {
      const unknownProbe = structuredClone(fixture.manifest);
      unknownProbe.steps[0].probes.push("synthetic-zero");
      expect(() => validateManifest(unknownProbe, fixture.root)).toThrow(/probe is not allowlisted/u);

      const detachedThreshold = structuredClone(fixture.manifest);
      detachedThreshold.steps[0].thresholds.processRssBytes = {
        source: "claimed-runtime",
        operator: "<=",
        limit: 1,
        unit: "MiB",
      };
      expect(() => validateManifest(detachedThreshold, fixture.root)).toThrow(
        /threshold processRssBytes source\/operator\/unit is incomplete/u,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("derives MIME fixture thresholds from retained observations", () => {
    const step = {
      id: "mime-250mib",
      thresholds: {
        bytes: { source: "fixture-observation", operator: "===", limit: 262144000, unit: "bytes" },
        peakGrowth: { source: "fixture-observation", operator: "<", limit: 134217728, unit: "bytes" },
      },
      assertions: [
        {
          id: "mime-fixture-observation",
          kind: "fixture-observation",
          expectedBytes: 262144000,
          expectedPeakGrowthBytes: 134217728,
        },
      ],
    };
    const base = {
      id: "mime-fixture-observation",
      observed: {
        producedBytes: 262144000,
        consumedBytes: 262144000,
        producedSha256: "a".repeat(64),
        consumedSha256: "a".repeat(64),
        producedChunks: 1,
        consumedChunks: 1,
        producerCompleted: true,
        consumerCompleted: true,
        peakRssGrowthBytes: 1,
        expectedPeakGrowthBytes: 134217728,
        pass: true,
      },
    };
    expect(observationThresholdValues(step, [base])).toEqual({ bytes: 262144000, peakGrowth: 1 });
    const attacks = [
      { producedBytes: 262143999 },
      { consumedBytes: 262143999 },
      { consumedSha256: "b".repeat(64) },
      { producerCompleted: false },
      { consumerCompleted: false },
      { peakRssGrowthBytes: 134217728 },
      { peakRssGrowthBytes: 134217729 },
      { peakRssGrowthBytes: -1 },
      { peakRssGrowthBytes: 1.5 },
      { expectedPeakGrowthBytes: 1024 * 1024 * 1024 },
      { expectedPeakGrowthBytes: 1.5 },
      { expectedPeakGrowthBytes: "128MiB" },
      { expectedPeakGrowthBytes: undefined },
      { pass: false },
    ];
    for (const patch of attacks) {
      expect(() =>
        observationThresholdValues(step, [
          { ...base, observed: { ...base.observed, ...patch } },
        ]),
      ).toThrow();
    }
    expect(() =>
      observationThresholdValues(
        { ...step, thresholds: { ...step.thresholds, unknown: step.thresholds.peakGrowth } },
        [base],
      ),
    ).toThrow();
    for (const threshold of [
      { ...step.thresholds.peakGrowth, limit: 1024 * 1024 * 1024 },
      { ...step.thresholds.peakGrowth, operator: "<=" },
      { ...step.thresholds.peakGrowth, source: "kernel:ps" },
      { ...step.thresholds.peakGrowth, unit: "MiB" },
    ]) {
      expect(() =>
        observationThresholdValues(
          { ...step, thresholds: { ...step.thresholds, peakGrowth: threshold } },
          [base],
        ),
      ).toThrow();
    }
    for (const role of ["primary", "independent-replay"]) {
      const coordinatedManifestDrift = {
        ...step,
        thresholds: {
          ...step.thresholds,
          peakGrowth: { ...step.thresholds.peakGrowth, limit: 1024 * 1024 * 1024 },
        },
        assertions: step.assertions.map((assertion) =>
          assertion.kind === "fixture-observation"
            ? { ...assertion, expectedPeakGrowthBytes: 1024 * 1024 * 1024 }
            : assertion,
        ),
      };
      expect(() => observationThresholdValues(coordinatedManifestDrift, [base], role)).toThrow();
      expect(() =>
        observationThresholdValues(
          step,
          [{ ...base, observed: { ...base.observed, expectedPeakGrowthBytes: 1024 * 1024 * 1024 } }],
          role,
        ),
      ).toThrow();
    }
    expect(thresholdMetricRegistry.peakGrowth.operator).toBe("<");
  });

  test("source-binds MIME growth threshold before execution", () => {
    const manifest = JSON.parse(
      readFileSync("docs/architecture/release-evidence-execution-manifest.v2.json", "utf8"),
    );
    const attacks = [
      (candidate: typeof manifest) => {
        candidate.steps.find((step: { id: string }) => step.id === "mime-250mib").thresholds.peakGrowth.limit =
          1024 * 1024 * 1024;
      },
      (candidate: typeof manifest) => {
        candidate.steps.find((step: { id: string }) => step.id === "mime-250mib").thresholds.peakGrowth.operator =
          "<=";
      },
      (candidate: typeof manifest) => {
        candidate.steps.find((step: { id: string }) => step.id === "mime-250mib").thresholds.peakGrowth.source =
          "kernel:ps";
      },
      (candidate: typeof manifest) => {
        candidate.steps.find((step: { id: string }) => step.id === "mime-250mib").thresholds.peakGrowth.unit =
          "MiB";
      },
      (candidate: typeof manifest) => {
        candidate.steps
          .find((step: { id: string }) => step.id === "mime-250mib")
          .assertions.find((assertion: { id: string }) => assertion.id === "mime-fixture-observation")
          .expectedPeakGrowthBytes = 1024 * 1024 * 1024;
      },
    ];
    for (const mutate of attacks) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      expect(() => validateManifest(candidate, ".")).toThrow();
    }
  });

  test("source-binds MIME growth authority to committed numeric declaration", () => {
    const fixture = numericSourceFixture();
    const base = structuredClone(fixture.manifest);
    const authority = (candidate: typeof base) => candidate.steps[0].numericSourceConstants[0];
    const metadataAttacks = [
      ["missing authority metadata", (candidate: typeof base) => delete candidate.steps[0].numericSourceConstants],
      ["unbound authority source", (candidate: typeof base) => candidate.steps[0].sources.pop()],
      ["wrong authority path", (candidate: typeof base) => (authority(candidate).sourcePath = "other.ts")],
      ["wrong authority export", (candidate: typeof base) => (authority(candidate).exportName = "OTHER")],
      ["wrong authority expression", (candidate: typeof base) => (authority(candidate).expression = "1024 * MEBIBYTE")],
      ["wrong authority value", (candidate: typeof base) => (authority(candidate).value = 1024 * 1024 * 1024)],
      ["wrong authority assertion field", (candidate: typeof base) => (authority(candidate).fixtureAssertionField = "expectedBytes")],
      ["wrong authority threshold", (candidate: typeof base) => (authority(candidate).thresholdMetric = "bytes")],
      ["wrong source SHA", (candidate: typeof base) => (candidate.steps[0].sources[2].sha256 = "0".repeat(64))],
      ["wrong source blob", (candidate: typeof base) => (candidate.steps[0].sources[2].gitBlob = "0".repeat(40))],
    ] as const;
    for (const [name, mutate] of metadataAttacks) {
      const candidate = structuredClone(base);
      mutate(candidate);
      expect(() => validateManifest(candidate, fixture.root, fixture.commit), name).toThrow();
    }

    const commitAuthoritySource = (source: string) => {
      writeFileSync(join(fixture.root, fixture.sourcePath), source);
      git(fixture.root, ["add", fixture.sourcePath]);
      git(fixture.root, ["commit", "-qm", "mutate numeric source authority"]);
      return {
        commit: git(fixture.root, ["rev-parse", "HEAD"]),
        gitBlob: git(fixture.root, ["rev-parse", `HEAD:${fixture.sourcePath}`]),
        sha256: sha256(Buffer.from(source)),
      };
    };
    const committedAttacks = [
      ["block comment declaration", "/* export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE; */\n"],
      ["line comment declaration", "// export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\n"],
      ["single string declaration", "const text = 'export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;';\n"],
      ["double string declaration", "const text = \"export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\";\n"],
      ["template string declaration", "const text = `export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;`;\n"],
      [
        "template interpolation declaration",
        "const text = `${\"export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\"}`;\n",
      ],
      ["nested block declaration", "if (true) { export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE; }\n"],
      ["nested function declaration", "function f() { export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE; }\n"],
      ["missing export", "export const OTHER_THRESHOLD = 128 * MEBIBYTE;\n"],
      ["wrong committed value", "export const RSS_GROWTH_THRESHOLD_BYTES = 1024 * MEBIBYTE;\n"],
      ["unsafe expression", "export const RSS_GROWTH_THRESHOLD_BYTES = 128 + MEBIBYTE;\n"],
      ["unsafe identifier", "export const RSS_GROWTH_THRESHOLD_BYTES = 128 * NOT_ALLOWLISTED;\n"],
      ["multiline expression trick", "export const RSS_GROWTH_THRESHOLD_BYTES = 128 *\nMEBIBYTE;\n"],
      ["escaped string trick", "const text = 'export const RSS_GROWTH_\\nTHRESHOLD_BYTES = 128 * MEBIBYTE;';\n"],
      ["unterminated block comment", "/* export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\n"],
      ["unterminated string", "const text = 'export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\n"],
      ["unterminated template", "const text = `export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\n"],
      ["regex at file start", "/export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/g;\n"],
      ["regex after equals", "const pattern = /export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/giu;\n"],
      ["regex after return", "function f() { return /export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/; }\n"],
      ["regex argument", "call(/export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/);\n"],
      ["regex escaped slash and class", "const pattern = /export[\\/] const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/g;\n"],
      ["regex malformed delimiter text", "/[)] export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/g;\n"],
      ["regex malformed nesting text", "const pattern = /([)] export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/g;\n"],
      ["regex comments and template", "const text = `value ${/* comment */ /export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/g}`;\n"],
      ["regex invalid flags", "const pattern = /export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/z;\n"],
      ["regex incompatible flags", "const pattern = /export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;/uv;\n"],
      ["unterminated regex", "/export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\n"],
      ["delimiter mismatch", "const value = (];\n"],
      ["delimiter underflow", "const value = );\n"],
      ["delimiter unclosed", "const value = ({\n"],
      [
        "ambiguous export",
        "export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\nexport const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\n",
      ],
    ] as const;
    for (const [name, source] of committedAttacks) {
      const committed = commitAuthoritySource(source);
      const candidate = structuredClone(base);
      const sourceBinding = candidate.steps[0].sources.find(
        (entry: { path: string }) => entry.path === fixture.sourcePath,
      );
      sourceBinding.gitBlob = committed.gitBlob;
      sourceBinding.sha256 = committed.sha256;
      expect(() => validateManifest(candidate, fixture.root, committed.commit), name).toThrow();
    }

    const division = commitAuthoritySource(
      "const ratio = 128 / MEBIBYTE;\nexport const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;\n",
    );
    const divisionCandidate = structuredClone(base);
    const divisionSource = divisionCandidate.steps[0].sources.find(
      (entry: { path: string }) => entry.path === fixture.sourcePath,
    );
    divisionSource.gitBlob = division.gitBlob;
    divisionSource.sha256 = division.sha256;
    expect(() => validateManifest(divisionCandidate, fixture.root, division.commit)).not.toThrow();

    const coordinated = commitAuthoritySource(
      "export const RSS_GROWTH_THRESHOLD_BYTES = 1024 * MEBIBYTE;\n",
    );
    const coordinatedCandidate = structuredClone(base);
    const coordinatedAuthority = coordinatedCandidate.steps[0].numericSourceConstants[0];
    coordinatedAuthority.expression = "1024 * MEBIBYTE";
    coordinatedAuthority.value = 1024 * 1024 * 1024;
    coordinatedAuthority.fixtureAssertionField = "expectedPeakGrowthBytes";
    coordinatedCandidate.steps[0].assertions[3].expectedPeakGrowthBytes = 1024 * 1024 * 1024;
    coordinatedCandidate.steps[0].thresholds.peakGrowth.limit = 1024 * 1024 * 1024;
    const coordinatedSource = coordinatedCandidate.steps[0].sources.find(
      (entry: { path: string }) => entry.path === fixture.sourcePath,
    );
    coordinatedSource.gitBlob = coordinated.gitBlob;
    coordinatedSource.sha256 = coordinated.sha256;
    expect(() => validateManifest(coordinatedCandidate, fixture.root, coordinated.commit)).toThrow(
      /authority drifted/u,
    );
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test("rejects an evil descendant beneath an exact untracked allowlist entry", async () => {
    const fixture = disposableRepo();
    try {
      fixture.manifest.runner = { untrackedAllowlist: ["safe-entry"] };
      writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
      git(fixture.root, ["add", "manifest.json"]);
      git(fixture.root, ["commit", "-qm", "allowlist authority"]);
      mkdirSync(join(fixture.root, "safe-entry"), { recursive: true });
      writeFileSync(join(fixture.root, "safe-entry", "evil.txt"), "untrusted\n");
      await expect(
        testCapture({ root: fixture.root, manifestPath: fixture.manifestPath }),
      ).rejects.toThrow(/worktree is dirty/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves a trailing-space untracked path through status parsing", async () => {
    const fixture = disposableRepo();
    try {
      fixture.manifest.runner.untrackedAllowlist = ["trailing-space "];
      writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
      git(fixture.root, ["add", "manifest.json"]);
      git(fixture.root, ["commit", "-qm", "trailing-space authority"]);
      writeFileSync(join(fixture.root, "trailing-space "), "allowed\n");
      const output = mkdtempSync(join(tmpdir(), "agent-mail-runner-trailing-output-"));
      try {
        await expect(
          testCapture({ root: fixture.root, manifestPath: fixture.manifestPath, outputRoot: output }),
        ).resolves.toMatchObject({ result: "pass" });
      } finally {
        rmSync(output, { recursive: true, force: true });
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("requires nonempty runner source bindings", () => {
    const fixture = disposableRepo();
    try {
      const missingSources = structuredClone(fixture.manifest);
      delete missingSources.runner.sources;
      expect(() => validateManifest(missingSources, fixture.root)).toThrow(/source bindings are missing/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("requires bun-frozen-offline runner dependency mode", () => {
    const fixture = disposableRepo();
    try {
      const missingMode = structuredClone(fixture.manifest);
      delete missingMode.runner.dependencyMode;
      expect(() => validateManifest(missingMode, fixture.root)).toThrow(/dependency mode/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not let a manifest selfTest flag bypass runner authority", () => {
    const fixture = disposableRepo();
    try {
      const forged = structuredClone(fixture.manifest);
      forged.runner = { selfTest: true };
      expect(() => validateManifest(forged, fixture.root)).toThrow(/dependency mode/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a source-token assertion when the candidate emits no event", async () => {
    const fixture = disposableRepo("pass", "missing");
    const output = mkdtempSync(join(tmpdir(), "agent-mail-runner-missing-event-"));
    try {
      await expect(
        testCapture({ root: fixture.root, manifestPath: fixture.manifestPath, outputRoot: output }),
      ).rejects.toThrow(/source-token event count is not exactly one/u);
    } finally {
      rmSync(output, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a same-ID source-token event with retyped content", async () => {
    const fixture = disposableRepo("pass", "retyped");
    const output = mkdtempSync(join(tmpdir(), "agent-mail-runner-retyped-event-"));
    try {
      await expect(
        testCapture({ root: fixture.root, manifestPath: fixture.manifestPath, outputRoot: output }),
      ).rejects.toThrow(/source-token event token is detached/u);
    } finally {
      rmSync(output, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a source-token event with the wrong observation envelope", async () => {
    const fixture = disposableRepo("pass", "wrong-format");
    const output = mkdtempSync(join(tmpdir(), "agent-mail-runner-wrong-format-"));
    try {
      await expect(
        testCapture({ root: fixture.root, manifestPath: fixture.manifestPath, outputRoot: output }),
      ).rejects.toThrow(/source-token event format is invalid/u);
    } finally {
      rmSync(output, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("requires and binds the shared source-token helper", () => {
    const manifestPath = "docs/architecture/release-evidence-execution-manifest.v2.json";
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const step = manifest.steps.find(
      (candidate: { id: string }) => candidate.id === "fts-generate-250k",
    );
    const helperPath = "scripts/capacity/source-token-event.ts";
    step.sources = step.sources.filter((source: { path: string }) => source.path !== helperPath);
    expect(() => validateManifest(manifest, ".")).toThrow(/helper binding is missing/u);

    const drifted = JSON.parse(readFileSync(manifestPath, "utf8"));
    const helper = drifted.steps
      .find((candidate: { id: string }) => candidate.id === "fts-generate-250k")
      .sources.find((source: { path: string }) => source.path === helperPath);
    helper.sha256 = "0".repeat(64);
    expect(() => validateManifest(drifted, ".")).toThrow(/source scripts\/capacity\/source-token-event.ts binding is inconsistent/u);
  });

  test("uses canonical deep equality for structured oracle objects and arrays", async () => {
    const fixture = disposableRepo({ list: [1, { a: true, b: ["x", 2] }] });
    const output = mkdtempSync(join(tmpdir(), "agent-mail-runner-object-output-"));
    try {
      await expect(
        testCapture({ root: fixture.root, manifestPath: fixture.manifestPath, outputRoot: output }),
      ).resolves.toMatchObject({ result: "pass" });
    } finally {
      rmSync(output, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("retains closed FTS artifacts and rejects lifecycle substitutions", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-mail-runner-retention-"));
    try {
      const output = join(root, "output");
      const runId = "run";
      const staging = join(output, runId, "staging", "fts.bin");
      const inventory = { logicalChecksum: "a".repeat(64) };
      mkdirSync(join(output, runId, "staging"), { recursive: true });
      writeFileSync(staging, "closed sqlite\n");
      writeFileSync(`${staging}.inventory.json`, `${JSON.stringify(inventory)}\n`);
      writeFileSync(`${staging}-wal`, "stale wal\n");
      writeFileSync(`${staging}-shm`, "stale shm\n");

      const retained = retainGeneratedArtifact(output, { id: "fts" }, staging, runId);
      expect(retained.artifactBytes).toBe("closed sqlite\n".length);
      expect(retained.logicalChecksum).toBe(inventory.logicalChecksum);
      cleanGeneratedStaging(staging);
      expect(existsSync(staging)).toBe(false);
      expect(existsSync(`${staging}-wal`)).toBe(false);
      expect(existsSync(retained.path)).toBe(true);

      const missing = join(output, "missing", "fts.bin");
      mkdirSync(join(output, "missing"), { recursive: true });
      writeFileSync(`${missing}.inventory.json`, `${JSON.stringify(inventory)}\n`);
      expect(() => retainGeneratedArtifact(output, { id: "missing" }, missing, "missing")).toThrow(
        /ENOENT/u,
      );

      const symlinkTarget = join(root, "target.sqlite");
      const symlinkPath = join(output, "symlink.sqlite");
      writeFileSync(symlinkTarget, "target\n");
      symlinkSync(symlinkTarget, symlinkPath);
      writeFileSync(`${symlinkPath}.inventory.json`, `${JSON.stringify(inventory)}\n`);
      expect(() => retainGeneratedArtifact(output, { id: "symlink" }, symlinkPath, "symlink")).toThrow(
        /regular non-symlink/u,
      );

      const occupied = join(output, "occupied", "staging", "fts.bin");
      const occupiedRetained = join(output, "occupied", "retained", "occupied.sqlite");
      mkdirSync(join(output, "occupied", "staging"), { recursive: true });
      mkdirSync(join(output, "occupied", "retained"), { recursive: true });
      writeFileSync(occupied, "closed sqlite\n");
      writeFileSync(`${occupied}.inventory.json`, `${JSON.stringify(inventory)}\n`);
      writeFileSync(occupiedRetained, "attacker\n");
      expect(() => retainGeneratedArtifact(output, { id: "occupied" }, occupied, "occupied")).toThrow(
        /already exists/u,
      );

      const receiptOutput = join(root, "receipt-output");
      const receiptRun = "receipt-run";
      const receiptArtifact = join(receiptOutput, receiptRun, "retained", "fts.sqlite");
      const receiptInventory = `${receiptArtifact}.inventory.json`;
      const artifactBytes = Buffer.from("receipt sqlite\n");
      const inventoryBytes = Buffer.from(`${JSON.stringify(inventory)}\n`);
      mkdirSync(join(receiptOutput, receiptRun, "retained"), { recursive: true });
      writeFileSync(receiptArtifact, artifactBytes);
      writeFileSync(receiptInventory, inventoryBytes);
      const receiptPath = join(root, "generation.receipt.json");
      writeFileSync(
        receiptPath,
        `${JSON.stringify({
          format: "agent-mail.executable-receipt/v2",
          result: "pass",
          manifestStepId: "generation",
          candidate: { commit: "candidate" },
          fixture: {
            materialized: {
              owner: "generator",
              presentAfterRun: true,
              path: `${receiptRun}/retained/fts.sqlite`,
              sha256: sha256(artifactBytes),
              bytes: artifactBytes.length,
              integrity: {
                inventorySha256: sha256(inventoryBytes),
                inventoryBytes: inventoryBytes.length,
                logicalChecksum: inventory.logicalChecksum,
              },
            },
          },
        })}\n`,
      );
      expect(
        generationReceipt(receiptPath, receiptOutput, { generationStepId: "generation" }, "candidate"),
      ).toMatchObject({ artifactSha256: sha256(artifactBytes), logicalChecksum: inventory.logicalChecksum });
      writeFileSync(receiptArtifact, "substituted\n");
      expect(() => generationReceipt(receiptPath, receiptOutput, { generationStepId: "generation" }, "candidate")).toThrow(
        /artifact drifted/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tracks and kills a detached descendant after its parent exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-mail-runner-detached-"));
    const script = join(root, "detached.mjs");
    writeFileSync(
      script,
      `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000)"], { detached: true, stdio: "ignore" });
child.unref();
setTimeout(() => process.exit(0), 250);
`,
    );
    try {
      const result = await runProcess([process.execPath, script], root, 2_000);
      const sawDetached = result.tree.samples.some(
        (sample: { pids: number[] }) => sample.pids.length > 1,
      );
      const termination = await result.terminate("detached-attack");
      expect(sawDetached).toBe(true);
      expect(termination.completed).toBe(true);
      expect(termination.survivorsAfterKill).toEqual([]);
      expect(termination.sigkillSent).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("samples resources after a late listener appears", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-mail-runner-late-resource-"));
    const script = join(root, "late-listener.mjs");
    writeFileSync(
      script,
      `import { createServer } from "node:net";
const server = createServer();
setTimeout(() => server.listen(0, "127.0.0.1"), 100);
setTimeout(() => server.close(() => process.exit(0)), 350);
`,
    );
    try {
      const result = await runProcess([process.execPath, script], root, 2_000);
      await result.terminate("late-resource-attack");
      expect(result.resources.samples.length).toBeGreaterThan(2);
      expect(
        result.resources.samples.some(
          (sample: { observed: boolean; listeners: number | null }) =>
            sample.observed && (sample.listeners ?? 0) > 0,
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("represents an exited process RSS as notApplicable instead of zero", () => {
    const snapshot = processTreeSnapshot(2_147_483_647);
    expect(snapshot.rssBytes).toBeNull();
    expect(snapshot.rssStatus).toBe("notApplicable");
  });

  test("escalates when a timed-out child ignores SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-mail-runner-sigterm-"));
    const script = join(root, "ignore-term.mjs");
    writeFileSync(
      script,
      `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
    );
    const started = Date.now();
    try {
      const result = await runProcess([process.execPath, script], root, 100);
      const termination = await result.terminate("sigterm-attack");
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(termination.completed).toBe(true);
      expect(result.timeoutSigkillSent || termination.sigkillSent).toBe(true);
      expect(termination.survivorsAfterKill).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
