import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  RESTART_CONVERGENCE_PHASES,
  runChild,
  snapshotDigest,
  type ChildMode,
  type DomainSnapshot,
  type InterruptMarker,
  type ResourceLeakEvidence,
} from "./helpers/restart-convergence-child";

const roots: string[] = [];
const worker = join(import.meta.dir, "helpers/restart-convergence-child.ts");
const evidenceFixture = join(
  import.meta.dir,
  "fixtures/restart-convergence-p3-c23.json",
);

type ChildEnvelope = Readonly<{
  readonly pid: number;
  readonly mode: ChildMode;
  readonly status: "completed";
  readonly snapshot?: DomainSnapshot;
  readonly resources: ResourceLeakEvidence;
}>;

async function child(
  root: string,
  mode: "oracle" | "resume",
): Promise<ChildEnvelope> {
  const process = Bun.spawn(["bun", "run", worker, root, mode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect(stderr, `${mode} stderr`).toBe("");
  expect(exitCode, `${mode} exit code`).toBe(0);
  const line = stdout.trim();
  expect(line, `${mode} child result`).not.toBe("");
  return JSON.parse(line) as ChildEnvelope;
}

async function interruptedChild(
  root: string,
  phase: (typeof RESTART_CONVERGENCE_PHASES)[number],
): Promise<InterruptMarker> {
  const process = Bun.spawn(
    ["bun", "run", worker, root, `interrupt:${phase}`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect(stderr, `${phase} stderr`).toBe("");
  expect(stdout.trim(), `${phase} abrupt child envelope`).toBe("");
  expect(exitCode, `${phase} abrupt exit code`).toBe(75);
  const marker = JSON.parse(
    await readFile(join(root, "interrupt-marker.json"), "utf8"),
  ) as InterruptMarker;
  expect(marker.reached, `${phase} marker reached`).toBe(true);
  expect(marker.phase, `${phase} marker phase`).toBe(phase);
  expect(marker.pid, `${phase} marker pid`).toBeGreaterThan(0);
  return marker;
}

function assertCutMarker(
  phase: (typeof RESTART_CONVERGENCE_PHASES)[number],
  marker: InterruptMarker,
  expectedCut: string,
): void {
  expect(marker.cut, `${phase} marker cut`).toBe(expectedCut);
  const facts = marker.durableBefore;
  expect(
    facts.messageCount,
    `${phase} message durable fact`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    facts.placementCount,
    `${phase} placement durable fact`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    facts.journalCount,
    `${phase} journal durable fact`,
  ).toBeGreaterThanOrEqual(0);
  switch (phase) {
    case "download":
      expect(facts.messageCount).toBe(0);
      expect(facts.canonicalBlobCount).toBe(0);
      break;
    case "parse":
      expect(facts.messageCount).toBe(0);
      expect(facts.stagingFiles.length).toBeGreaterThan(0);
      break;
    case "blob-promotion":
      expect(facts.messageCount).toBe(0);
      expect(facts.canonicalBlobCount).toBeGreaterThanOrEqual(3);
      break;
    case "storage-transaction":
      expect(facts.messageCount).toBe(1);
      expect(facts.placementCount).toBe(1);
      expect(facts.canonicalBlobCount).toBeGreaterThanOrEqual(3);
      break;
    case "checkpoint-update":
      expect(facts.messageCount).toBe(2);
      expect(facts.checkpointBackfillCompleted).toBe(true);
      break;
    case "epoch-reset":
      expect(facts.messageCount).toBe(2);
      expect(facts.tombstoneCount).toBeGreaterThan(0);
      break;
    case "pause":
    case "stop":
      expect(facts.messageCount).toBe(2);
      expect(marker.control).toMatchObject({ command: phase, observed: true });
      expect(marker.control?.configurationDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(marker.control?.actorState).toBe(
        phase === "pause" ? "paused" : "stopped",
      );
      expect(marker.control?.actorListenerCount).toBe(0);
      expect(marker.control?.decisionListenerCount).toBe(0);
      break;
  }
}

function assertConverged(
  oracle: DomainSnapshot,
  actual: DomainSnapshot,
  label = "snapshot",
): void {
  expect(actual, label).toEqual(oracle);
}

function assertNoResourceLeak(resources: ResourceLeakEvidence): void {
  expect(resources).toEqual({
    fakeImapOpenHandles: 0,
    activeQueueDownloads: 0,
    controlDecisionListeners: 0,
    stagingFiles: [],
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("P3-C23 process-level restart convergence", () => {
  test("every named interruption converges in a fresh child to the uninterrupted domain oracle", async () => {
    const oracleRoot = await mkdtemp(
      join(tmpdir(), "agent-mail-restart-convergence-oracle-"),
    );
    roots.push(oracleRoot);
    const oracleResult = await child(oracleRoot, "oracle");
    expect(oracleResult.status).toBe("completed");
    expect(oracleResult.snapshot).toBeDefined();
    if (oracleResult.snapshot === undefined)
      throw new Error("oracle snapshot is missing");
    assertNoResourceLeak(oracleResult.resources);

    const fixture = JSON.parse(await readFile(evidenceFixture, "utf8")) as {
      readonly oracleSnapshotSha256: string;
      readonly interruptionPoints: readonly string[];
      readonly snapshotDomains: readonly string[];
      readonly resourceEvidence: readonly string[];
      readonly interruptMarker: Readonly<{
        readonly schemaVersion: number;
        readonly abruptExitCode: number;
        readonly normalEnvelope: boolean;
        readonly durableFacts: readonly string[];
        readonly controlFacts: readonly string[];
      }>;
      readonly cutMarkers: Readonly<Record<string, string>>;
    };
    expect(fixture.interruptionPoints).toEqual(RESTART_CONVERGENCE_PHASES);
    expect(fixture.snapshotDomains).toEqual([
      "messages",
      "placements",
      "headers",
      "addresses",
      "bodyParts",
      "attachments",
      "blobs",
      "blobReferences",
      "routingDecisions",
      "routingOrigins",
      "localRoutingProvenance",
      "tombstones",
      "checkpoints",
      "completions",
      "journal",
    ]);
    expect(fixture.resourceEvidence).toEqual([
      "fakeImapOpenHandles",
      "activeQueueDownloads",
      "controlDecisionListeners",
      "stagingFiles",
    ]);
    expect(fixture.interruptMarker).toEqual({
      schemaVersion: 1,
      abruptExitCode: 75,
      normalEnvelope: false,
      durableFacts: [
        "messageCount",
        "placementCount",
        "tombstoneCount",
        "journalCount",
        "checkpointVersion",
        "checkpointBackfillCompleted",
        "canonicalBlobCount",
        "stagingFiles",
      ],
      controlFacts: [
        "command",
        "observed",
        "actorState",
        "version",
        "configurationDigest",
        "actorListenerCount",
        "decisionListenerCount",
      ],
    });
    expect(fixture.cutMarkers).toEqual({
      download: "download-queue-before-fetch",
      parse: "parse-after-stage-before-parse-success",
      "blob-promotion": "blob-publication-before-promotion-storage",
      "storage-transaction": "storage-transaction-before-routing-write",
      "checkpoint-update": "checkpoint-update-before-completion-write",
      "epoch-reset": "epoch-reset-before-journal-write",
      pause: "real-control-pause-accepted",
      stop: "real-control-stop-accepted",
    });
    expect(snapshotDigest(oracleResult.snapshot)).toBe(
      fixture.oracleSnapshotSha256,
    );

    for (const phase of RESTART_CONVERGENCE_PHASES) {
      const root = await mkdtemp(
        join(tmpdir(), `agent-mail-restart-convergence-${phase}-`),
      );
      roots.push(root);
      const marker = await interruptedChild(root, phase);
      assertCutMarker(phase, marker, fixture.cutMarkers[phase]);
      expect(marker.pid).not.toBe(oracleResult.pid);

      const resumed = await child(root, "resume");
      expect(resumed.status, `${phase} resume status`).toBe("completed");
      expect(resumed.pid).not.toBe(marker.pid);
      if (resumed.snapshot === undefined)
        throw new Error(`${phase} resumed snapshot is missing`);
      assertConverged(
        oracleResult.snapshot,
        resumed.snapshot,
        `${phase} snapshot`,
      );
      assertNoResourceLeak(resumed.resources);
    }
  });

  test("rejects the adjacent message-committed/routing-absent counterexample", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "agent-mail-restart-convergence-counterexample-"),
    );
    roots.push(root);
    const result = await child(root, "oracle");
    if (result.snapshot === undefined)
      throw new Error("counterexample oracle snapshot is missing");
    const counterexample: DomainSnapshot = {
      ...result.snapshot,
      routingDecisions: [],
      routingOrigins: [],
      localRoutingProvenance: [],
    };
    expect(counterexample.messages).toEqual(result.snapshot.messages);
    expect(counterexample.messages).not.toHaveLength(0);
    expect(() =>
      assertConverged(result.snapshot as DomainSnapshot, counterexample),
    ).toThrow();
    expect(
      createHash("sha256").update(JSON.stringify(counterexample)).digest("hex"),
    ).not.toBe(snapshotDigest(result.snapshot));
  });
});
