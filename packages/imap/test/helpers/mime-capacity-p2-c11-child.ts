import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  capacityProbeReportSchema,
  FIXTURE_BLOCK_BYTES,
  FIXTURE_BYTES,
  FIXTURE_PAYLOAD_BYTES,
  fixtureHead,
  fixtureTail,
  RSS_GROWTH_THRESHOLD_BYTES,
  SAMPLE_INTERVAL_MS,
  type CapacityProbeMode,
} from "../mime-capacity-p2-c11";
import { parseStagedEml } from "../../src/mime-parser";

function modeFrom(value: string | undefined): CapacityProbeMode {
  if (value === "streaming" || value === "buffering") return value;
  throw new Error("mode must be streaming or buffering");
}

function maxRssBytes(): number {
  const value = process.resourceUsage().maxRSS;
  return process.platform === "linux" ? value * 1_024 : value;
}

async function writeFixture(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const handle = await open(path, "w", 0o600);
  const digest = createHash("sha256");
  const block = Buffer.alloc(FIXTURE_BLOCK_BYTES, 0x61);
  let remaining = FIXTURE_PAYLOAD_BYTES;
  try {
    await handle.write(fixtureHead());
    digest.update(fixtureHead());
    while (remaining > 0) {
      const chunk = remaining >= block.byteLength ? block : block.subarray(0, remaining);
      await handle.write(chunk);
      digest.update(chunk);
      remaining -= chunk.byteLength;
    }
    await handle.write(fixtureTail());
    digest.update(fixtureTail());
  } finally {
    await handle.close();
  }
  return { sha256: digest.digest("hex"), sizeBytes: (await lstat(path)).size };
}

const mode = modeFrom(process.argv[2]);
const directory = process.argv[3];
if (directory === undefined || directory.length === 0) throw new Error("fixture directory is required");

const sourcePath = join(directory, `${mode}.eml`);
const fixture = await writeFixture(sourcePath);
const baselineRssBytes = process.memoryUsage().rss;
let peakRssBytes = Math.max(baselineRssBytes, maxRssBytes());
let samples = 1;
const sampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss, maxRssBytes());
  samples += 1;
}, SAMPLE_INTERVAL_MS);
const startedAt = performance.now();
let bufferedBytes = 0;
let parsedAttachmentBytes = 0;
let parsedAttachmentCount = 0;
const attachmentHash = createHash("sha256");
let buffered: Uint8Array | undefined;

try {
  if (mode === "buffering") {
    buffered = await readFile(sourcePath);
    bufferedBytes = buffered.byteLength;
  }
  const parsed = await parseStagedEml({
    sourcePath,
    onPart: async (part) => {
      if (part.kind !== "attachment") return;
      parsedAttachmentCount += 1;
      for await (const chunk of part.content) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        parsedAttachmentBytes += bytes.byteLength;
        attachmentHash.update(bytes);
      }
    },
  });
  if (parsed.attachments.length !== 1) throw new Error("capacity fixture did not produce one attachment");
  if (buffered !== undefined && buffered.byteLength !== FIXTURE_BYTES) {
    throw new Error("buffering fixture retained an unexpected byte count");
  }
} finally {
  clearInterval(sampler);
}

peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss, maxRssBytes());
const finalRssBytes = process.memoryUsage().rss;
const peakRssGrowthBytes = Math.max(0, peakRssBytes - baselineRssBytes);
const report = capacityProbeReportSchema.parse({
  schemaVersion: 1,
  mode,
  fixture: {
    path: sourcePath,
    sizeBytes: fixture.sizeBytes,
    payloadBytes: FIXTURE_PAYLOAD_BYTES,
    sha256: fixture.sha256,
    attachmentSha256: attachmentHash.digest("hex"),
    encoding: "binary",
  },
  measurement: {
    baselineRssBytes,
    peakRssBytes,
    finalRssBytes,
    peakRssGrowthBytes,
    elapsedMs: performance.now() - startedAt,
    samples,
    exitStatus: "completed",
    parsedAttachmentBytes,
    parsedAttachmentCount,
    bufferedBytes,
  },
  threshold: {
    peakRssGrowthBytes: RSS_GROWTH_THRESHOLD_BYTES,
    semantics: "peak RSS growth from the post-fixture baseline must be below the threshold",
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    runtime: process.version,
    bun: process.versions.bun ?? null,
  },
  gate: peakRssGrowthBytes < RSS_GROWTH_THRESHOLD_BYTES ? "pass" : "fail",
});

process.stdout.write(`${JSON.stringify(report)}\n`);
