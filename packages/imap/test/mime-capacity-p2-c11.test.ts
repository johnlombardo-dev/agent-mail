import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  capacityProbeReportSchema,
  FIXTURE_BYTES,
  FIXTURE_PAYLOAD_BYTES,
  formatCapacityEvidence,
  RSS_GROWTH_THRESHOLD_BYTES,
  type CapacityEvidence,
  type CapacityProbeMode,
  type CapacityProbeReport,
} from "./mime-capacity-p2-c11";

const temporaryDirectories: string[] = [];

const fixtureObservationSchema = z
  .object({
    format: z.literal("agent-mail.fixture-observation/v1"),
    event: z.literal("fixture-observation"),
    fixtureId: z.literal("issue-176-mime-250mib"),
    sourcePath: z.literal("packages/imap/test/helpers/mime-capacity-p2-c11-child.ts"),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    producedBytes: z.number().int().nonnegative(),
    producedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    producedChunks: z.number().int().positive(),
    producerCompleted: z.boolean(),
    consumedBytes: z.number().int().nonnegative(),
    consumedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    consumedChunks: z.number().int().positive(),
    consumerCompleted: z.boolean(),
    peakRssGrowthBytes: z.number().int().nonnegative(),
    expectedPeakGrowthBytes: z.literal(RSS_GROWTH_THRESHOLD_BYTES),
    expectedBytes: z.literal(FIXTURE_BYTES),
    bytesEqual: z.boolean(),
    sha256Equal: z.boolean(),
    exactBytes: z.boolean(),
    pass: z.boolean(),
  })
  .strict();

type FixtureObservation = z.infer<typeof fixtureObservationSchema>;

function derivedFixtureObservation(observation: FixtureObservation): FixtureObservation {
  const bytesEqual = observation.producedBytes === observation.consumedBytes;
  const sha256Equal = observation.producedSha256 === observation.consumedSha256;
  const exactBytes =
    observation.producedBytes === FIXTURE_BYTES && observation.consumedBytes === FIXTURE_BYTES;
  const pass =
    observation.producerCompleted &&
    observation.consumerCompleted &&
    Number.isSafeInteger(observation.peakRssGrowthBytes) &&
    observation.peakRssGrowthBytes >= 0 &&
    observation.peakRssGrowthBytes < RSS_GROWTH_THRESHOLD_BYTES &&
    bytesEqual &&
    sha256Equal &&
    exactBytes &&
    observation.producedChunks > 0 &&
    observation.consumedChunks > 0;
  return {
    ...observation,
    bytesEqual,
    sha256Equal,
    exactBytes,
    pass,
  };
}

async function validateFixtureObservation(value: unknown): Promise<FixtureObservation> {
  const parsed = fixtureObservationSchema.parse(value);
  const sourceBytes = await readFile(join(import.meta.dir, "helpers/mime-capacity-p2-c11-child.ts"));
  expect(parsed.sourceSha256).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
  const derived = derivedFixtureObservation(parsed);
  expect(parsed.bytesEqual).toBe(derived.bytesEqual);
  expect(parsed.sha256Equal).toBe(derived.sha256Equal);
  expect(parsed.exactBytes).toBe(derived.exactBytes);
  expect(parsed.pass).toBe(derived.pass);
  return derived;
}

function createFixtureObservationEmitter(
  sink: (observation: FixtureObservation) => void = (observation) =>
    process.stdout.write(`${JSON.stringify(observation)}\n`),
): (observation: FixtureObservation) => void {
  let emitted = false;
  return (observation) => {
    if (emitted) throw new Error("duplicate fixture observation");
    emitted = true;
    sink(observation);
  };
}

const emitFixtureObservation = createFixtureObservationEmitter();

async function emitSourceToken(assertionId: string, sourcePath: string, tokenParts: string[]) {
  const token = tokenParts.join("");
  const sourceBytes = await readFile(fileURLToPath(import.meta.url));
  const observed = sourceBytes.toString("utf8").split(token).length - 1;
  process.stdout.write(
    `${JSON.stringify({
      format: "agent-mail.observation/v1",
      event: "source-token",
      assertionId,
      sourcePath,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      token,
      observed,
      expected: 1,
      pass: observed === 1,
    })}\n`,
  );
}

async function runProbe(
  mode: CapacityProbeMode,
  directory: string,
): Promise<{
  exitCode: number;
  observation: FixtureObservation | null;
  stderr: string;
  report: CapacityProbeReport | null;
  stdout: string;
}> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "helpers/mime-capacity-p2-c11-child.ts"), mode, directory],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let report: CapacityProbeReport | null = null;
  let observation: FixtureObservation | null = null;
  for (const line of stdout.split("\n").filter((value) => value.length > 0)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const reportResult = capacityProbeReportSchema.safeParse(value);
    if (reportResult.success) report = reportResult.data;
    const observationResult = fixtureObservationSchema.safeParse(value);
    if (observationResult.success) {
      if (observation !== null) throw new Error("duplicate fixture observation from capacity child");
      observation = observationResult.data;
    }
  }
  return { exitCode, observation, stderr, report, stdout };
}

async function retainEvidence(evidence: CapacityEvidence): Promise<string> {
  const configuredPath = process.env.AGENT_MAIL_MIME_CAPACITY_EVIDENCE;
  if (configuredPath !== undefined && configuredPath.length > 0) {
    await writeFile(configuredPath, formatCapacityEvidence(evidence), { mode: 0o600 });
    return configuredPath;
  }
  const directory = await mkdtemp(join(tmpdir(), "agent-mail-mime-capacity-evidence-"));
  const path = join(directory, "p2-c11.json");
  await writeFile(path, formatCapacityEvidence(evidence), { mode: 0o600 });
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("P2-C11 MIME capacity qualification", () => {
  test(
    "measures the full 250 MiB EML in a child and detects buffering",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "agent-mail-mime-capacity-p2-c11-"));
      temporaryDirectories.push(directory);
      const streaming = await runProbe("streaming", directory);
      const buffering = await runProbe("buffering", directory);

      expect(streaming.exitCode, streaming.stderr || streaming.stdout).toBe(0);
      expect(streaming.report, streaming.stderr || streaming.stdout).not.toBeNull();
      expect(buffering.exitCode, buffering.stderr || buffering.stdout).toBe(0);
      expect(buffering.report, buffering.stderr || buffering.stdout).not.toBeNull();
      if (streaming.report === null || buffering.report === null) {
        throw new Error("capacity child did not return a valid report");
      }

      const evidence: CapacityEvidence = {
        schemaVersion: 1,
        threshold: streaming.report.threshold,
        streaming: streaming.report,
        buffering: buffering.report,
      };
      const evidencePath = await retainEvidence(evidence);
      process.stdout.write(`P2-C11 evidence: ${evidencePath}\n`);

      expect(streaming.report.mode).toBe("streaming");
      expect(streaming.report.fixture.sizeBytes).toBe(FIXTURE_BYTES);
      expect(streaming.report.fixture.payloadBytes).toBe(FIXTURE_PAYLOAD_BYTES);
      expect(streaming.report.measurement.parsedAttachmentBytes).toBe(FIXTURE_PAYLOAD_BYTES);
      expect(streaming.report.measurement.parsedAttachmentCount).toBe(1);
      expect(streaming.report.measurement.bufferedBytes).toBe(0);
      expect(streaming.report.gate).toBe("pass");

      expect(buffering.report.mode).toBe("buffering");
      expect(buffering.report.fixture.sha256).toBe(streaming.report.fixture.sha256);
      expect(buffering.report.fixture.attachmentSha256).toBe(streaming.report.fixture.attachmentSha256);
      expect(buffering.report.measurement.bufferedBytes).toBe(FIXTURE_BYTES);
      expect(buffering.report.measurement.peakRssGrowthBytes).toBeGreaterThanOrEqual(
        RSS_GROWTH_THRESHOLD_BYTES,
      );
      expect(buffering.report.gate).toBe("fail");

      expect(evidencePath.length).toBeGreaterThan(0);
      expect(streaming.observation).not.toBeNull();
      expect(buffering.observation).toBeNull();
      if (streaming.observation === null) throw new Error("streaming fixture observation missing");
      const observation = await validateFixtureObservation(streaming.observation);
      expect(observation.producedBytes).toBe(FIXTURE_BYTES);
      expect(observation.consumedBytes).toBe(FIXTURE_BYTES);
      expect(observation.producedSha256).toBe(observation.consumedSha256);
      expect(observation.producedChunks).toBeGreaterThan(0);
      expect(observation.consumedChunks).toBeGreaterThan(0);
      expect(observation.producerCompleted).toBe(true);
      expect(observation.consumerCompleted).toBe(true);
      expect(observation.pass).toBe(true);
      emitFixtureObservation(observation);
      await emitSourceToken(
        "mime-streaming-gate",
        "packages/imap/test/mime-capacity-p2-c11.test.ts",
        ["streaming.report", ".gate"],
      );
      await emitSourceToken(
        "mime-buffering-counterexample",
        "packages/imap/test/mime-capacity-p2-c11.test.ts",
        ["buffering.report", ".gate"],
      );
    },
    120_000,
  );

  test("rejects dishonest fixture observations at the harness boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-mime-capacity-attacks-"));
    temporaryDirectories.push(directory);
    const streaming = await runProbe("streaming", directory);
    expect(streaming.observation).not.toBeNull();
    if (streaming.observation === null) throw new Error("streaming fixture observation missing");
    const baseline = await validateFixtureObservation(streaming.observation);
    const withPatch = (patch: Partial<FixtureObservation>): FixtureObservation =>
      derivedFixtureObservation({ ...baseline, ...patch });

    expect(derivedFixtureObservation(withPatch({ producedBytes: FIXTURE_BYTES - 1 })).pass).toBe(false);
    expect(derivedFixtureObservation(withPatch({ consumedBytes: FIXTURE_BYTES - 1 })).pass).toBe(false);
    expect(
      derivedFixtureObservation(withPatch({ consumedSha256: "0".repeat(64) })).pass,
    ).toBe(false);
    expect(derivedFixtureObservation(withPatch({ producerCompleted: false })).pass).toBe(false);
    expect(derivedFixtureObservation(withPatch({ consumerCompleted: false })).pass).toBe(false);
    expect(
      derivedFixtureObservation(
        withPatch({ peakRssGrowthBytes: RSS_GROWTH_THRESHOLD_BYTES }),
      ).pass,
    ).toBe(false);
    expect(
      derivedFixtureObservation(
        withPatch({ peakRssGrowthBytes: RSS_GROWTH_THRESHOLD_BYTES + 1 }),
      ).pass,
    ).toBe(false);
    expect(
      derivedFixtureObservation(withPatch({ peakRssGrowthBytes: -1 })).pass,
    ).toBe(false);
    expect(
      derivedFixtureObservation(
        withPatch({ peakRssGrowthBytes: 1.5 as unknown as number }),
      ).pass,
    ).toBe(false);
    expect(() =>
      fixtureObservationSchema.parse({ ...baseline, expectedPeakGrowthBytes: 1 }),
    ).toThrow();
    expect(() =>
      fixtureObservationSchema.parse({ ...baseline, expectedPeakGrowthBytes: "128MiB" }),
    ).toThrow();
    const { expectedPeakGrowthBytes: _removed, ...missingCeiling } = baseline;
    expect(() => fixtureObservationSchema.parse(missingCeiling)).toThrow();
    expect(() =>
      fixtureObservationSchema.parse({ ...baseline, format: "agent-mail.observation/v1" }),
    ).toThrow();
    await expect(
      validateFixtureObservation({ ...baseline, sourcePath: "packages/imap/test/other.ts" }),
    ).rejects.toThrow();

    const emissions: FixtureObservation[] = [];
    const emit = createFixtureObservationEmitter((observation) => emissions.push(observation));
    emit(baseline);
    expect(() => emit(baseline)).toThrow("duplicate fixture observation");
    expect(emissions).toHaveLength(1);
  });
});
