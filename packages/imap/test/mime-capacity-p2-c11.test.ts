import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
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
): Promise<{ exitCode: number; stderr: string; report: CapacityProbeReport | null; stdout: string }> {
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
  try {
    report = capacityProbeReportSchema.parse(JSON.parse(stdout));
  } catch {
    report = null;
  }
  return { exitCode, stderr, report, stdout };
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
});
