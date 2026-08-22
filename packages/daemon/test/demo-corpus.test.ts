import { describe, expect, test } from "bun:test";
import {
  CORPUS_VERSION,
  DEFAULT_REFERENCE_SIZE,
  assertRequiredCoverage,
  assertCorpusIntegrity,
  assertCorpusAttachmentStreams,
  buildCorpus,
  checksumCorpus,
  CorpusOptionsError,
  deriveCorpusInventory,
  parseCorpusOptions,
  requiredCoverageCases,
  streamCorpus,
} from "../src/demo/corpus/index.ts";

const scenarioMix = {
  ordinary: 1,
  transactional: 1,
  "mailing-list": 1,
  newsletter: 1,
  automated: 1,
  spam: 1,
} as const;

function options(seed: string, size = DEFAULT_REFERENCE_SIZE) {
  return { scenarioVersion: CORPUS_VERSION, seed, size, scenarioMix };
}

describe("deterministic demo corpus", () => {
  test("is byte and logically repeatable across execution context", () => {
    const first = buildCorpus(options("reference"));
    const second = buildCorpus({ ...options("reference"), root: "/other", locale: "tr-TR", timezone: "Pacific/Auckland", wallClock: "2099-12-31T23:59:59.999Z" });
    expect(first.logicalDigest).toBe(second.logicalDigest);
    expect(first.byteDigest).toBe(second.byteDigest);
    expect(first.checksum).toBe(second.checksum);
    expect(first.inventory).toEqual(second.inventory);
    expect(checksumCorpus(first)).toBe(first.checksum);
  });

  test("retains every required case and relationship inventory", () => {
    const corpus = buildCorpus(options("coverage"));
    assertRequiredCoverage(corpus);
    expect(corpus.inventory.requiredCases).toEqual(requiredCoverageCases);
    expect(corpus.inventory.entries.every((entry) => entry.messageIds.length > 0)).toBe(true);
    expect(corpus.mailboxes.length).toBe(3);
    expect(corpus.timeline.length).toBeGreaterThan(corpus.messages.length);
  });

  test("streams large attachment profiles without materializing the corpus", async () => {
    const source = streamCorpus(options("large"));
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
    await assertCorpusAttachmentStreams(buildCorpus(options("large-verify")));
  });

  test("rejects a missing hostile or sparse case instead of silently passing", () => {
    const corpus = buildCorpus(options("tiny", 1));
    expect(() => assertRequiredCoverage(corpus)).toThrow(/missing required cases/);
  });

  test("binds strict versioned options and rejects null, future, and unknown inputs", () => {
    const valid = options("strict", 96);
    expect(parseCorpusOptions(valid).scenarioVersion).toBe(CORPUS_VERSION);
    for (const input of [
      { ...valid, scenarioVersion: null },
      { ...valid, seed: null },
      { ...valid, size: null },
      { ...valid, scenarioMix: null },
      { ...valid, scenarioVersion: "agent-mail-demo-corpus.v2" },
      { ...valid, unexpected: true },
    ]) {
      expect(() => parseCorpusOptions(input)).toThrow(CorpusOptionsError);
    }
    expect(() => parseCorpusOptions({ ...valid, size: undefined })).toThrow(/size must be/);
  });

  test("resolves replies, records intentional exceptions, and binds mailbox state", () => {
    const corpus = buildCorpus(options("relationships"));
    const generatedIds = new Set(corpus.messages.map((message) => message.messageId));
    const missing = corpus.messages.filter((message) => message.relationship.kind === "missing-reference");
    expect(missing.length).toBeGreaterThan(0);
    for (const message of corpus.messages) {
      if (message.relationship.kind === "root") continue;
      if (message.relationship.kind === "missing-reference") {
        expect(generatedIds.has(message.relationship.inReplyTo)).toBe(false);
        continue;
      }
      expect(generatedIds.has(message.relationship.inReplyTo)).toBe(true);
      expect(message.headers["in-reply-to"]).toBe(message.relationship.inReplyTo);
    }
    for (const mailbox of corpus.mailboxes) {
      const extant = corpus.messages.filter((message) => message.mailboxId === mailbox.id && !message.tombstone);
      expect(mailbox.exists).toBe(extant.length);
      if (mailbox.uidNext !== null)
        expect(mailbox.uidNext).toBeGreaterThan(Math.max(0, ...extant.map((message) => message.uid)));
    }
    assertCorpusIntegrity(corpus);
  });

  test("derives coverage and rejects independent authority mutations", () => {
    const corpus = buildCorpus(options("integrity"));
    expect(deriveCorpusInventory(corpus)).toEqual(corpus.inventory);

    const raw = new Uint8Array(corpus.messages[0].rawBytes);
    raw[0] ^= 0xff;
    const rawTampered = {
      ...corpus,
      messages: corpus.messages.map((message, index) =>
        index === 0 ? { ...message, rawBytes: raw } : message,
      ),
    };
    expect(() => assertCorpusIntegrity(rawTampered)).toThrow(/digest/);

    const timeline = [...corpus.timeline];
    timeline[0] = { ...timeline[0], at: "2099-01-01T00:00:00.000Z" };
    const timelineTampered = { ...corpus, timeline };
    expect(() => assertCorpusIntegrity(timelineTampered)).toThrow(/timeline/);

    const emptyInventory = {
      requiredCases: corpus.inventory.requiredCases,
      entries: corpus.inventory.entries.map((entry) => ({ ...entry, messageIds: [], mailboxIds: [] })),
      presentCases: [],
      missingCases: corpus.inventory.requiredCases,
    };
    const forged = { ...corpus, inventory: emptyInventory, checksum: checksumCorpus(corpus) };
    expect(() => assertCorpusIntegrity(forged)).toThrow(/inventory/);
  });

  test("returns copy-safe byte buffers and immutable containers", () => {
    const corpus = buildCorpus(options("immutable"));
    const firstBytes = corpus.messages[0].rawBytes;
    const original = firstBytes[0];
    firstBytes[0] ^= 0xff;
    expect(corpus.messages[0].rawBytes[0]).toBe(original);
    expect(Object.isFrozen(corpus.messages)).toBe(true);
    expect(Object.isFrozen(corpus.mailboxes)).toBe(true);
    expect(Object.isFrozen(corpus.timeline)).toBe(true);
    expect(Object.isFrozen(corpus.inventory)).toBe(true);
    expect(Object.isFrozen(corpus.messages[0].headers)).toBe(true);
    expect(Object.isFrozen(corpus.messages[0].parts)).toBe(true);
  });

  test("binds attachment stream bytes to their declared digest", async () => {
    const corpus = buildCorpus(options("attachment-integrity"));
    const messageIndex = corpus.messages.findIndex((message) =>
      message.parts.some((part) => part.kind === "attachment" && part.byteLength === 41),
    );
    const message = corpus.messages[messageIndex];
    const parts = message.parts.map((part) => {
      if (part.kind !== "attachment" || part.byteLength !== 41) return part;
      return {
        ...part,
        openStream: async function* (): AsyncIterable<Uint8Array> {
          yield new Uint8Array(part.byteLength);
        },
      };
    });
    const tampered = {
      ...corpus,
      messages: corpus.messages.map((candidate, index) =>
        index === messageIndex ? { ...candidate, parts } : candidate,
      ),
    };
    await expect(assertCorpusAttachmentStreams(corpus)).resolves.toBeUndefined();
    await expect(assertCorpusAttachmentStreams(tampered)).rejects.toThrow(/content digest/);
  });
});
