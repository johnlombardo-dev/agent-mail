import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

async function writeFixture(path: string): Promise<{
  sha256: string;
  sizeBytes: number;
  chunkCount: number;
}> {
  const handle = await open(path, "w", 0o600);
  const digest = createHash("sha256");
  const block = Buffer.alloc(FIXTURE_BLOCK_BYTES, 0x61);
  let remaining = FIXTURE_PAYLOAD_BYTES;
  let chunkCount = 0;
  try {
    await handle.write(fixtureHead());
    digest.update(fixtureHead());
    chunkCount += 1;
    while (remaining > 0) {
      const chunk = remaining >= block.byteLength ? block : block.subarray(0, remaining);
      await handle.write(chunk);
      digest.update(chunk);
      chunkCount += 1;
      remaining -= chunk.byteLength;
    }
    await handle.write(fixtureTail());
    digest.update(fixtureTail());
    chunkCount += 1;
  } finally {
    await handle.close();
  }
  return { sha256: digest.digest("hex"), sizeBytes: (await lstat(path)).size, chunkCount };
}

async function digestFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    digest.update(bytes);
    sizeBytes += bytes.byteLength;
  }
  return { sha256: digest.digest("hex"), sizeBytes };
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
let consumedSourceBytes = 0;
let consumedSourceChunkCount = 0;
const attachmentHash = createHash("sha256");
let buffered: Uint8Array | undefined;

try {
  if (mode === "buffering") {
    buffered = await readFile(sourcePath);
    bufferedBytes = buffered.byteLength;
  }
  const parsed = await parseStagedEml({
    sourcePath,
    onSourceBytes: (bytes) => {
      consumedSourceBytes = bytes;
      consumedSourceChunkCount += 1;
    },
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
const attachmentSha256 = attachmentHash.digest("hex");
const consumedSourceDigest = await digestFile(sourcePath);
const report = capacityProbeReportSchema.parse({
  schemaVersion: 1,
  mode,
  fixture: {
    path: sourcePath,
    sizeBytes: fixture.sizeBytes,
    payloadBytes: FIXTURE_PAYLOAD_BYTES,
    sha256: fixture.sha256,
    attachmentSha256,
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

if (mode === "streaming") {
  const sourceBytes = await readFile(fileURLToPath(import.meta.url));
  const producedBytes = fixture.sizeBytes;
  const consumedBytes = consumedSourceBytes;
  const producedSha256 = fixture.sha256;
  const consumedSha256 = consumedSourceDigest.sha256;
  const bytesEqual = producedBytes === consumedBytes;
  const sha256Equal = producedSha256 === consumedSha256;
  const exactBytes = producedBytes === FIXTURE_BYTES && consumedBytes === FIXTURE_BYTES;
  const producerCompleted = fixture.sizeBytes === FIXTURE_BYTES;
  const consumerCompleted =
    consumedSourceDigest.sizeBytes === consumedSourceBytes && consumedSourceBytes === FIXTURE_BYTES;
  process.stdout.write(
    `${JSON.stringify({
      format: "agent-mail.fixture-observation/v1",
      event: "fixture-observation",
      fixtureId: "issue-176-mime-250mib",
      sourcePath: "packages/imap/test/helpers/mime-capacity-p2-c11-child.ts",
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      producedBytes,
      producedSha256,
      producedChunks: fixture.chunkCount,
      producerCompleted,
      consumedBytes,
      consumedSha256,
      consumedChunks: consumedSourceChunkCount,
      consumerCompleted,
      peakRssGrowthBytes,
      expectedBytes: FIXTURE_BYTES,
      bytesEqual,
      sha256Equal,
      exactBytes,
      pass:
        producerCompleted &&
        consumerCompleted &&
        peakRssGrowthBytes < RSS_GROWTH_THRESHOLD_BYTES &&
        bytesEqual &&
        sha256Equal &&
        exactBytes &&
        fixture.chunkCount > 0 &&
        consumedSourceChunkCount > 0,
    })}\n`,
  );
}
