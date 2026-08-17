import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  encodeExportFrame,
  encodeExportFrameChunks,
  ExportFramingError,
  ExportStreamDecoder,
  MAX_EXPORT_CONTENT_BYTES,
  type ExportFrame,
} from "../src/export-stream-framing";

function digestOf(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function frame(
  kind: ExportFrame["kind"],
  messageId: string,
  placementId: string,
  content: Uint8Array,
): ExportFrame {
  const digest = digestOf(content);
  return {
    version: 1,
    kind,
    attribution: {
      messageId,
      placementId,
      selectionQueryDigest: "a".repeat(64),
      contentDigest: digest,
      contentSize: content.byteLength,
      provenance: {
        source: "selected-export:test-query",
        selectionQueryDigest: "a".repeat(64),
      },
    },
    content,
  };
}

function expectFramingError(action: () => unknown, code: ExportFramingError["code"]): void {
  try {
    action();
    throw new Error("expected framing error");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ExportFramingError);
    if (error instanceof ExportFramingError) expect(error.code).toBe(code);
  }
}

describe("versioned selected-export stream framing", () => {
  test("round-trips mixed metadata, raw, and attachment frames through tiny chunks", () => {
    const metadata = frame("metadata", "message:one", "placement:inbox", new TextEncoder().encode('{"subject":"untrusted"}'));
    const rawBytes = Uint8Array.from([0, 255, 13, 10, 0, 42, 255]);
    const raw = frame("raw", "message:one", "placement:inbox", rawBytes);
    const attachment = frame("attachment", "message:two", "placement:archive", Uint8Array.from([1, 2, 3, 0, 255]));

    const encoded = [metadata, raw, attachment].flatMap((item) => [...encodeExportFrameChunks(item, 3)]);
    const decoder = new ExportStreamDecoder();
    const decoded = encoded.flatMap((chunk) => [...decoder.push(chunk)]);
    decoder.finish();

    expect(decoded).toHaveLength(3);
    expect(decoded.map((item) => item.kind)).toEqual(["metadata", "raw", "attachment"]);
    expect(decoded.map((item) => item.attribution.messageId)).toEqual([
      "message:one",
      "message:one",
      "message:two",
    ]);
    expect(decoded.map((item) => item.attribution.placementId)).toEqual([
      "placement:inbox",
      "placement:inbox",
      "placement:archive",
    ]);
    expect(decoded.every((item) => item.attribution.provenance.source === "selected-export:test-query")).toBe(true);
    expect(decoded.every((item) => item.attribution.provenance.selectionQueryDigest === "a".repeat(64))).toBe(true);
    expect(decoded[0]?.content).toEqual(metadata.content);
    expect(decoded[1]?.content).toEqual(rawBytes);
    expect(decoded[2]?.content).toEqual(attachment.content);
  });

  test("rejects missing or tampered attribution and digest", () => {
    const encoded = encodeExportFrame(frame("raw", "message:one", "placement:inbox", Uint8Array.from([1, 2, 3])));

    const missingAttribution = new ExportStreamDecoder();
    // The metadata is protected by the frame integrity trailer; removing a
    // required attribution field therefore cannot become a valid record.
    const metadataStart = 16;
    const metadataLength = new DataView(encoded.buffer).getUint32(8, false);
    const metadataText = new TextDecoder().decode(
      encoded.slice(metadataStart, metadataStart + metadataLength),
    );
    const withoutPlacement = metadataText.replace(/"placementId":"placement:inbox",/u, "");
    const replacement = new TextEncoder().encode(withoutPlacement.padEnd(metadataLength, " "));
    expect(replacement.byteLength).toBe(metadataLength);
    encoded.set(replacement, metadataStart);
    expectFramingError(() => missingAttribution.push(encoded), "frame_digest_mismatch");

    const tamperedDigest = encodeExportFrame(frame("attachment", "message:two", "placement:archive", Uint8Array.from([9, 8, 7])));
    const tamperedMetadataLength = new DataView(tamperedDigest.buffer).getUint32(8, false);
    const tamperedMetadataStart = 16;
    const tamperedMetadata = tamperedDigest.slice(
      tamperedMetadataStart,
      tamperedMetadataStart + tamperedMetadataLength,
    );
    const digestMarker = new TextEncoder().encode('"contentDigest":"');
    const digestOffset = tamperedMetadata.findIndex((value, index) => {
      if (index + digestMarker.byteLength > tamperedMetadata.byteLength) return false;
      return digestMarker.every((marker, markerIndex) => tamperedMetadata[index + markerIndex] === marker);
    });
    expect(digestOffset).toBeGreaterThanOrEqual(0);
    tamperedMetadata[digestOffset + digestMarker.byteLength] ^= 0x01;
    tamperedDigest.set(tamperedMetadata, tamperedMetadataStart);
    const digestDecoder = new ExportStreamDecoder();
    expectFramingError(() => digestDecoder.push(tamperedDigest), "frame_digest_mismatch");
  });

  test("rejects truncated and oversized frames before emitting a record", () => {
    const encoded = encodeExportFrame(frame("raw", "message:one", "placement:inbox", Uint8Array.from([4, 5, 6])));
    const truncated = new ExportStreamDecoder();
    truncated.push(encoded.slice(0, encoded.byteLength - 1));
    expectFramingError(() => truncated.finish(), "truncated");

    const oversizedHeader = new Uint8Array(16);
    oversizedHeader.set(Uint8Array.from([0x41, 0x4d, 0x45, 0x58]));
    oversizedHeader[4] = 1;
    oversizedHeader[5] = 2;
    new DataView(oversizedHeader.buffer).setUint32(8, 1, false);
    new DataView(oversizedHeader.buffer).setUint32(12, MAX_EXPORT_CONTENT_BYTES + 1, false);
    const oversized = new ExportStreamDecoder();
    expectFramingError(() => oversized.push(oversizedHeader), "oversized_frame");

    const oversizedMetadataHeader = new Uint8Array(16);
    oversizedMetadataHeader.set(Uint8Array.from([0x41, 0x4d, 0x45, 0x58]));
    oversizedMetadataHeader[4] = 1;
    oversizedMetadataHeader[5] = 1;
    new DataView(oversizedMetadataHeader.buffer).setUint32(8, 64 * 1024 + 1, false);
    const oversizedMetadata = new ExportStreamDecoder();
    expectFramingError(() => oversizedMetadata.push(oversizedMetadataHeader), "oversized_frame");
  });

  test("rejects a bare concatenation of EML bytes", () => {
    const decoder = new ExportStreamDecoder();
    expectFramingError(
      () => decoder.push(new TextEncoder().encode("From: sender@example.test\r\n\r\nbody\r\n")),
      "invalid_magic",
    );
  });

  test("rejects untrusted decoder input at the boundary", () => {
    const decoder = new ExportStreamDecoder();
    expectFramingError(() => decoder.push({}), "invalid_chunk");
  });
});
