import { describe, expect, it } from "bun:test";
import {
  compareUtcInstants,
  createMailboxCheckpoint,
  createMonotonicSequence,
  createSearchCursor,
  createStreamingOffset,
  createUtcInstant,
  parseMailboxCheckpoint,
  parseMonotonicSequence,
  parseSearchCursor,
  parseStreamingOffset,
  parseUtcInstant,
  serializeMailboxCheckpoint,
  serializeMonotonicSequence,
  serializeStreamingOffset,
  serializeUtcInstant,
} from "../src/time-cursor";

const codec = {
  sign: (payload: string) => `keyed:${payload}`,
  verify: (payload: string, integrity: string) => integrity === `keyed:${payload}`,
};

describe("time and cursor values", () => {
  it("normalizes offset-equivalent instants and orders by epoch", () => {
    const utc = createUtcInstant("2026-01-01T00:00:00Z");
    const plusEight = createUtcInstant("2026-01-01T08:00:00+08:00");
    const minusEightThirty = createUtcInstant("2025-12-31T15:30:00-08:30");
    expect(serializeUtcInstant(utc)).toBe("2026-01-01T00:00:00.000Z");
    expect(plusEight).toBe(utc);
    expect(minusEightThirty).toBe(utc);
    expect(compareUtcInstants(createUtcInstant("2026-01-01T00:00:00+08:00"), utc)).toBeLessThan(0);
    expect(parseUtcInstant(serializeUtcInstant(utc))).toBe(utc);
  });

  it("round-trips nominal counters and preserves their distinction", () => {
    const sequence = createMonotonicSequence(4);
    const offset = createStreamingOffset(4);
    expect(parseMonotonicSequence(serializeMonotonicSequence(sequence))).toBe(sequence);
    expect(parseStreamingOffset(serializeStreamingOffset(offset))).toBe(offset);
    expect(() => parseMonotonicSequence("04")).toThrow();
  });

  it("retains unknown mailbox checkpoint fields", () => {
    const checkpoint = createMailboxCheckpoint({
      uidValidity: undefined,
      uid: 8,
      modseq: "unknown",
    });
    expect(parseMailboxCheckpoint(serializeMailboxCheckpoint(checkpoint))).toEqual(checkpoint);
    expect(checkpoint.uidValidity.kind).toBe("unknown");
    expect(checkpoint.modseq.kind).toBe("unknown");
    expect(() => createMailboxCheckpoint({ uid: 8, extra: true })).toThrow();
    expect(() =>
      parseMailboxCheckpoint('["mailbox-checkpoint-v1",null,["unknown"],["unknown"]]'),
    ).toThrow();
  });

  it("rejects cursor tampering, truncation, and unknown versions", () => {
    const cursor = createSearchCursor("opaque-payload", codec);
    expect(parseSearchCursor(cursor, codec).payload).toBe("opaque-payload");
    expect(() => parseSearchCursor(`${cursor.slice(0, -1)}A`, codec)).toThrow();
    expect(() => parseSearchCursor(cursor.slice(0, -2), codec)).toThrow();
    const unknown = btoa(
      JSON.stringify(["search-cursor-v2", "opaque-payload", "keyed:opaque-payload"]),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    expect(() => parseSearchCursor(unknown, codec)).toThrow();
  });
});
