import { createHash } from "node:crypto";
import { encodeExportFrame, type ExportFrame } from "../../daemon/src/export-stream-framing";

export const SELECTED_EXPORT_QUERY = "from:fixture@example.test";
export const SELECTED_EXPORT_CORPUS_SIZE = 250_000;
export const SELECTED_EXPORT_QUERY_DIGEST = "a".repeat(64);

export function fixtureMessageId(position: number): string {
  return `message:${position.toString(16).padStart(64, "0")}`;
}

export function fixtureContent(position: number): Uint8Array {
  return new TextEncoder().encode(
    `From: fixture-${position}@example.test\r\n\r\nrecord-${position}`,
  );
}

export function fixtureFrame(
  messageId: string,
  position: number,
  kind: ExportFrame["kind"] = "raw",
): Uint8Array {
  const content = fixtureContent(position);
  const contentDigest = createHash("sha256").update(content).digest("hex");
  return encodeExportFrame({
    version: 1,
    kind,
    attribution: {
      messageId,
      placementId: `placement:fixture:${position}`,
      selectionQueryDigest: SELECTED_EXPORT_QUERY_DIGEST,
      contentDigest,
      contentSize: content.byteLength,
      provenance: {
        source: "selected-export",
        selectionQueryDigest: SELECTED_EXPORT_QUERY_DIGEST,
      },
    },
    content,
  });
}

/** A pull-driven AMEX source; it does not retain the complete export. */
export function fixtureStream(
  positions: readonly number[],
  options: Readonly<{ readonly chunkSize?: number }> = {},
): Readonly<{
  readonly body: AsyncIterable<Uint8Array>;
  readonly cancel: () => Promise<void>;
  readonly cancelled: () => boolean;
  readonly cancelCalls: () => number;
  readonly finallyCalls: () => number;
  readonly pulls: () => number;
  readonly postTerminalPulls: () => number;
}> {
  let cancelled = false;
  let cancelCallCount = 0;
  let finallyCallCount = 0;
  let pullCount = 0;
  let postTerminalPullCount = 0;
  const chunkSize = options.chunkSize ?? 8_192;
  const body = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for (const position of positions) {
        if (cancelled) {
          postTerminalPullCount += 1;
          return;
        }
        const encoded = fixtureFrame(fixtureMessageId(position), position);
        for (let offset = 0; offset < encoded.byteLength; offset += chunkSize) {
          if (cancelled) {
            postTerminalPullCount += 1;
            return;
          }
          pullCount += 1;
          yield encoded.slice(offset, Math.min(offset + chunkSize, encoded.byteLength));
        }
      }
    } finally {
      finallyCallCount += 1;
      cancelled = true;
    }
  })();
  return Object.freeze({
    body,
    cancel: async (): Promise<void> => {
      cancelCallCount += 1;
      cancelled = true;
      await body.return(undefined);
    },
    cancelled: () => cancelled,
    cancelCalls: () => cancelCallCount,
    finallyCalls: () => finallyCallCount,
    pulls: () => pullCount,
    postTerminalPulls: () => postTerminalPullCount,
  });
}
