import { describe, expect, test } from "bun:test";
import {
  CORPUS_VERSION,
  DEFAULT_REFERENCE_SIZE,
  assertRequiredCoverage,
  buildCorpus,
  checksumCorpus,
  requiredCoverageCases,
  streamCorpus,
} from "../src/demo/corpus/index.ts";

describe("deterministic demo corpus", () => {
  test("is byte and logically repeatable across execution context", () => {
    const first = buildCorpus({ scenarioVersion: CORPUS_VERSION, seed: "reference", size: DEFAULT_REFERENCE_SIZE });
    const second = buildCorpus({ scenarioVersion: CORPUS_VERSION, seed: "reference", size: DEFAULT_REFERENCE_SIZE, root: "/other", locale: "tr-TR", timezone: "Pacific/Auckland", wallClock: "2099-12-31T23:59:59.999Z" });
    expect(first.logicalDigest).toBe(second.logicalDigest);
    expect(first.byteDigest).toBe(second.byteDigest);
    expect(first.checksum).toBe(second.checksum);
    expect(first.inventory).toEqual(second.inventory);
    expect(checksumCorpus(first)).toBe(first.checksum);
  });

  test("retains every required case and relationship inventory", () => {
    const corpus = buildCorpus({ scenarioVersion: CORPUS_VERSION, seed: "coverage", size: DEFAULT_REFERENCE_SIZE });
    assertRequiredCoverage(corpus);
    expect(corpus.inventory.requiredCases).toEqual(requiredCoverageCases);
    expect(corpus.inventory.entries.every((entry) => entry.messageIds.length > 0)).toBe(true);
    expect(corpus.mailboxes.length).toBe(3);
    expect(corpus.timeline.length).toBeGreaterThan(corpus.messages.length);
  });

  test("streams large attachment profiles without materializing the corpus", async () => {
    const source = streamCorpus({ scenarioVersion: CORPUS_VERSION, seed: "large", size: DEFAULT_REFERENCE_SIZE });
    let count = 0;
    let maxChunk = 0;
    for await (const message of source) {
      count += 1;
      for (const part of message.parts) {
        if (part.kind !== "attachment" || part.byteLength < 8 * 1024 * 1024) continue;
        let chunks = 0;
        for await (const chunk of part.openStream()) {
          chunks += 1;
          maxChunk = Math.max(maxChunk, chunk.byteLength);
          if (chunks > 2) break;
        }
      }
    }
    expect(count).toBe(DEFAULT_REFERENCE_SIZE);
    expect(maxChunk).toBeLessThanOrEqual(64 * 1024);
  });

  test("rejects a missing hostile or sparse case instead of silently passing", () => {
    const corpus = buildCorpus({ scenarioVersion: CORPUS_VERSION, seed: "tiny", size: 1 });
    expect(() => assertRequiredCoverage(corpus)).toThrow(/missing required cases/);
  });
});
