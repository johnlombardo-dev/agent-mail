import { z } from "zod";

export const MEBIBYTE = 1_024 * 1_024;
export const FIXTURE_BYTES = 250 * MEBIBYTE;
/** Frozen P2-C11 qualification ceiling for peak RSS growth during parsing. */
export const RSS_GROWTH_THRESHOLD_BYTES = 128 * MEBIBYTE;
export const SAMPLE_INTERVAL_MS = 5;

const FIXTURE_HEAD = Buffer.from(
  "Content-Type: multipart/mixed; boundary=agent-mail-capacity\r\n\r\n" +
    "--agent-mail-capacity\r\n" +
    "Content-Type: application/octet-stream\r\n" +
    "Content-Disposition: attachment; filename=capacity.bin\r\n" +
    "Content-Transfer-Encoding: binary\r\n\r\n",
  "ascii",
);
const FIXTURE_TAIL = Buffer.from("\r\n--agent-mail-capacity--\r\n", "ascii");

export const FIXTURE_HEAD_BYTES = FIXTURE_HEAD.byteLength;
export const FIXTURE_TAIL_BYTES = FIXTURE_TAIL.byteLength;
export const FIXTURE_PAYLOAD_BYTES = FIXTURE_BYTES - FIXTURE_HEAD_BYTES - FIXTURE_TAIL_BYTES;
export const FIXTURE_BLOCK_BYTES = MEBIBYTE;

export type CapacityProbeMode = "streaming" | "buffering";

export const capacityProbeReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["streaming", "buffering"]),
    fixture: z
      .object({
        path: z.string().min(1),
        sizeBytes: z.number().int().nonnegative(),
        payloadBytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        attachmentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        encoding: z.literal("binary"),
      })
      .strict(),
    measurement: z
      .object({
        baselineRssBytes: z.number().int().nonnegative(),
        peakRssBytes: z.number().int().nonnegative(),
        finalRssBytes: z.number().int().nonnegative(),
        peakRssGrowthBytes: z.number().int().nonnegative(),
        elapsedMs: z.number().nonnegative(),
        samples: z.number().int().positive(),
        exitStatus: z.literal("completed"),
        parsedAttachmentBytes: z.number().int().nonnegative(),
        parsedAttachmentCount: z.number().int().nonnegative(),
        bufferedBytes: z.number().int().nonnegative(),
      })
      .strict(),
    threshold: z
      .object({
        peakRssGrowthBytes: z.literal(RSS_GROWTH_THRESHOLD_BYTES),
        semantics: z.literal("peak RSS growth from the post-fixture baseline must be below the threshold"),
      })
      .strict(),
    environment: z
      .object({
        platform: z.string().min(1),
        arch: z.string().min(1),
        runtime: z.string().min(1),
        bun: z.string().nullable(),
      })
      .strict(),
    gate: z.enum(["pass", "fail"]),
  })
  .strict();

export type CapacityProbeReport = z.infer<typeof capacityProbeReportSchema>;

export type CapacityEvidence = Readonly<{
  schemaVersion: 1;
  threshold: Readonly<{
    peakRssGrowthBytes: typeof RSS_GROWTH_THRESHOLD_BYTES;
    semantics: "peak RSS growth from the post-fixture baseline must be below the threshold";
  }>;
  streaming: CapacityProbeReport;
  buffering: CapacityProbeReport;
}>;

export function formatCapacityEvidence(evidence: CapacityEvidence): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export function fixtureHead(): Buffer {
  return FIXTURE_HEAD;
}

export function fixtureTail(): Buffer {
  return FIXTURE_TAIL;
}
