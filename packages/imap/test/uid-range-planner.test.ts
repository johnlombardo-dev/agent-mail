import { describe, expect, test } from "bun:test";
import { createRemoteUidValue, type CheckpointValue, type RemoteUidValue } from "@agent-mail/core";
import {
  parseUidRangePlannerInput,
  planUidFetchRanges,
  type UidRange,
} from "../src/uid-range-planner";

function uid(value: number): RemoteUidValue {
  return createRemoteUidValue(value);
}

function plan(
  knownPlacementUids: readonly number[],
  checkpointUidNext: CheckpointValue<RemoteUidValue>,
  observedUidCeiling: number | null,
  maxRangeSpan: number,
  reconcileKnown = false,
): readonly UidRange[] {
  return planUidFetchRanges({
    knownPlacementUids: knownPlacementUids.map(uid),
    checkpointUidNext,
    observedUidCeiling: observedUidCeiling === null ? null : uid(observedUidCeiling),
    maxRangeSpan,
    reconcileKnown,
  });
}

describe("sparse UID fetch range planner", () => {
  test("plans new UIDs from a known UIDNEXT through the observed ceiling", () => {
    expect(plan([1, 3, 8], { kind: "known", value: uid(4) }, 10, 3)).toEqual([
      { start: uid(4), end: uid(6) },
      { start: uid(7), end: uid(7) },
      { start: uid(9), end: uid(10) },
    ]);
  });

  test("uses the explicit observed ceiling when UIDNEXT is unknown", () => {
    expect(plan([3, 5], { kind: "unknown" }, 8, 3)).toEqual([
      { start: uid(1), end: uid(2) },
      { start: uid(4), end: uid(4) },
      { start: uid(6), end: uid(8) },
    ]);
  });

  test("does not plan an empty mailbox or a ceiling below the cursor", () => {
    expect(plan([], { kind: "unknown" }, null, 100)).toEqual([]);
    expect(plan([], { kind: "known", value: uid(20) }, 19, 100)).toEqual([]);
  });

  test("deduplicates and sorts sparse placements without requesting known UIDs", () => {
    expect(plan([9, 2, 9, 4, 2], { kind: "unknown" }, 10, 20)).toEqual([
      { start: uid(1), end: uid(1) },
      { start: uid(3), end: uid(3) },
      { start: uid(5), end: uid(8) },
      { start: uid(10), end: uid(10) },
    ]);
  });

  test("never bridges the million-UID sparse gap", () => {
    const ranges = plan([1, 1_000_000], { kind: "unknown" }, 1_000_000, 10_000);
    expect(ranges.length).toBe(100);
    expect(ranges[0]).toEqual({ start: uid(2), end: uid(10_001) });
    expect(ranges.at(-1)).toEqual({ start: uid(990_002), end: uid(999_999) });
    expect(ranges.every((range) => range.end - range.start + 1 <= 10_000)).toBe(true);
  });

  test("reconciles known placements only when explicitly requested", () => {
    expect(plan([2, 4], { kind: "unknown" }, 5, 10, true)).toEqual([
      { start: uid(1), end: uid(5) },
    ]);
  });

  test("handles the maximum safe UID without overflowing the range cursor", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(plan([], { kind: "known", value: uid(maximum) }, maximum, 1)).toEqual([
      { start: uid(maximum), end: uid(maximum) },
    ]);
  });

  test("rejects malformed public input instead of treating unknown facts as defaults", () => {
    expect(() =>
      parseUidRangePlannerInput({
        knownPlacementUids: [],
        checkpointUidNext: { kind: "unknown" },
        observedUidCeiling: 10,
        maxRangeSpan: 0,
      }),
    ).toThrow("maxRangeSpan must be a positive safe integer");
    expect(() =>
      parseUidRangePlannerInput({
        knownPlacementUids: [],
        checkpointUidNext: { kind: "unknown" },
        observedUidCeiling: 10,
        maxRangeSpan: 10,
        unexpected: true,
      }),
    ).toThrow("unknown fields");
  });

  test("property fixture preserves ordering, bounds, caps, and known-UID exclusion", () => {
    let seed = 0x83c04;
    const next = (): number => {
      seed = (seed * 48_271 + 12_345) % 2_147_483_647;
      return seed;
    };

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const ceiling = (next() % 500) + 1;
      const known = Array.from({ length: next() % 35 }, () => (next() % ceiling) + 1);
      const cap = (next() % 25) + 1;
      const ranges = plan(known, { kind: "unknown" }, ceiling, cap);
      const knownSet = new Set(known);
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        expect(range.start).toBeGreaterThan(0);
        expect(range.start).toBeLessThanOrEqual(range.end);
        expect(range.end).toBeLessThanOrEqual(ceiling);
        expect(range.end - range.start + 1).toBeLessThanOrEqual(cap);
        if (index > 0) {
          expect(ranges[index - 1]?.end).toBeLessThan(range.start);
        }
        for (let candidate = range.start; candidate <= range.end; candidate += 1) {
          expect(knownSet.has(candidate)).toBe(false);
        }
      }
    }
  });
});
