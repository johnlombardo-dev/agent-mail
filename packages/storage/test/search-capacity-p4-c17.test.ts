import { describe, expect, test } from "bun:test";
import {
  assertHydrationPlanParameterCount,
  buildHydrationPlanParameters,
} from "../../../scripts/capacity/benchmark-search";
import {
  digestOrderedIdentities,
  evaluateSearchCapacity,
  hasForbiddenFullScan,
  type SearchCapacityEvidence,
  type SearchSample,
} from "../../../scripts/capacity/search-capacity-gate";

const identities = ["message:" + "a".repeat(64), "message:" + "b".repeat(64)] as const;

function sample(overrides: Partial<SearchSample> = {}): SearchSample {
  return {
    query: "atlas",
    phase: "measured",
    iteration: 1,
    status: "ok",
    elapsedMs: 12,
    peakRssBytes: 10,
    candidateCount: identities.length,
    hydratedCount: identities.length,
    identities,
    identityDigest: digestOrderedIdentities(identities),
    ...overrides,
  };
}

function evidence(overrides: Partial<SearchCapacityEvidence> = {}): SearchCapacityEvidence {
  return {
    thresholds: {
      warmups: 1,
      measuredSamples: 1,
      topLimit: 20,
      p95Ms: 250,
      maxPageSize: 100,
    },
    plans: {
      candidate: ["SCAN message_fts VIRTUAL TABLE INDEX 0:M5"],
      hydration: ["SEARCH message USING COVERING INDEX sqlite_autoindex_messages_1"],
      negativeFullScan: ["SCAN messages"],
      negativeFullScanRejected: true,
    },
    queries: [
      {
        query: "atlas",
        expectedIdentities: identities,
        expectedIdentityDigest: digestOrderedIdentities(identities),
        warmups: [sample({ phase: "warmup" })],
        samples: [sample()],
      },
    ],
    adjacentCounterexample: { status: "rejected", reason: "wrong order" },
    ...overrides,
  };
}

describe("P4-C17 bounded search capacity evaluator", () => {
  test("binds hydration candidates and both account scopes", () => {
    const parameters = buildHydrationPlanParameters(identities, 20, "account:capacity");

    expect(parameters).toHaveLength(82);
    expect(parameters.slice(0, 4)).toEqual([1, identities[0], 0, "2026-01-01T00:00:00.000Z"]);
    expect(parameters.slice(-2)).toEqual(["account:capacity", "account:capacity"]);
    expect(() => assertHydrationPlanParameterCount(parameters, 20)).not.toThrow();
    expect(() => assertHydrationPlanParameterCount(parameters.slice(0, -1), 20)).toThrow(
      "expected 82 values, received 81",
    );
  });

  test("passes bounded ordered evidence and recognizes the negative full scan", () => {
    expect(hasForbiddenFullScan(["SCAN messages"])).toBe(true);
    const result = evaluateSearchCapacity(evidence());
    expect(result.status).toBe("pass");
    expect(result.p95ByQuery.atlas).toBe(12);
  });

  test("fails a full-scan plan even when a timing sample is fast", () => {
    const result = evaluateSearchCapacity(
      evidence({
        plans: {
          candidate: ["SCAN messages USING COVERING INDEX sqlite_autoindex_messages_1"],
          hydration: ["SEARCH message USING COVERING INDEX sqlite_autoindex_messages_1"],
          negativeFullScan: ["SCAN messages"],
          negativeFullScanRejected: true,
        },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.name === "candidate plan avoids message-catalog full scan")?.status).toBe(
      "fail",
    );
  });

  test("fails a fast result with the wrong tied order", () => {
    const wrong = [...identities].reverse();
    const result = evaluateSearchCapacity(
      evidence({
        queries: [
          {
            query: "atlas",
            expectedIdentities: identities,
            expectedIdentityDigest: digestOrderedIdentities(identities),
            warmups: [sample({ phase: "warmup" })],
            samples: [
              sample({
                identities: wrong,
                identityDigest: digestOrderedIdentities(wrong),
                elapsedMs: 1,
              }),
            ],
          },
        ],
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.name === "atlas exact ordered identities")?.status).toBe(
      "fail",
    );
  });
});
