import { createHash } from "node:crypto";

export const SEARCH_CAPACITY_TOP_LIMIT = 20;
export const SEARCH_CAPACITY_WARMUPS = 3;
export const SEARCH_CAPACITY_SAMPLES = 10;
export const SEARCH_CAPACITY_P95_MS = 250;
export const SEARCH_CAPACITY_MAX_PAGE_SIZE = 100;

export type SearchSample = Readonly<{
  readonly query: string;
  readonly phase: "warmup" | "measured";
  readonly iteration: number;
  readonly status: "ok" | "timeout" | "error";
  readonly elapsedMs: number;
  readonly peakRssBytes: number | null;
  readonly candidateCount: number;
  readonly hydratedCount: number;
  readonly identities: readonly string[];
  readonly identityDigest: string;
  readonly error?: string;
}>;

export type SearchQueryEvidence = Readonly<{
  readonly query: string;
  readonly expectedIdentities: readonly string[];
  readonly expectedIdentityDigest: string;
  readonly warmups: readonly SearchSample[];
  readonly samples: readonly SearchSample[];
}>;

export type SearchPlanEvidence = Readonly<{
  readonly candidate: readonly string[];
  readonly hydration: readonly string[];
  readonly negativeFullScan: readonly string[];
  readonly negativeFullScanRejected: boolean;
}>;

export type SearchCapacityEvidence = Readonly<{
  readonly thresholds: Readonly<{
    readonly warmups: number;
    readonly measuredSamples: number;
    readonly topLimit: number;
    readonly p95Ms: number;
    readonly maxPageSize: number;
  }>;
  readonly plans: SearchPlanEvidence;
  readonly queries: readonly SearchQueryEvidence[];
  readonly adjacentCounterexample: Readonly<{
    readonly status: "rejected";
    readonly reason: string;
  }>;
}>;

export type GateCheck = Readonly<{
  readonly name: string;
  readonly status: "pass" | "fail";
  readonly observed: string | number | boolean;
  readonly expected: string;
}>;

export type SearchCapacityEvaluation = Readonly<{
  readonly status: "pass" | "fail";
  readonly checks: readonly GateCheck[];
  readonly p95ByQuery: Readonly<Record<string, number | null>>;
}>;

export function digestOrderedIdentities(identities: readonly string[]): string {
  const hash = createHash("sha256");
  for (const identity of identities) hash.update(`${identity}\n`);
  return hash.digest("hex");
}

export function percentile(values: readonly number[], percentileRank: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  const value = sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
  return value ?? Number.POSITIVE_INFINITY;
}

export function hasForbiddenFullScan(plan: readonly string[]): boolean {
  return plan.some((detail) => /\bSCAN\s+messages?\b/iu.test(detail));
}

function expectedIdentityMismatch(query: SearchQueryEvidence, sample: SearchSample): boolean {
  return (
    sample.status !== "ok" ||
    sample.candidateCount > SEARCH_CAPACITY_MAX_PAGE_SIZE ||
    sample.hydratedCount !== sample.candidateCount ||
    sample.identities.length !== query.expectedIdentities.length ||
    sample.identityDigest !== query.expectedIdentityDigest ||
    sample.identities.some((identity, index) => identity !== query.expectedIdentities[index])
  );
}

/** Evaluate the retained evidence, including correctness and plan shape. */
export function evaluateSearchCapacity(evidence: SearchCapacityEvidence): SearchCapacityEvaluation {
  const checks: GateCheck[] = [];
  const p95ByQuery: Record<string, number | null> = {};
  const add = (
    name: string,
    passed: boolean,
    observed: string | number | boolean,
    expected: string,
  ) => {
    checks.push({ name, status: passed ? "pass" : "fail", observed, expected });
  };

  add(
    "negative full-scan plan is rejected",
    evidence.plans.negativeFullScanRejected &&
      hasForbiddenFullScan(evidence.plans.negativeFullScan),
    evidence.plans.negativeFullScanRejected,
    "the evaluator rejects a plan that scans messages",
  );
  add(
    "candidate plan avoids message-catalog full scan",
    !hasForbiddenFullScan(evidence.plans.candidate),
    hasForbiddenFullScan(evidence.plans.candidate),
    "no SCAN messages/messages detail",
  );
  add(
    "hydration plan avoids message-catalog full scan",
    !hasForbiddenFullScan(evidence.plans.hydration),
    hasForbiddenFullScan(evidence.plans.hydration),
    "no SCAN messages/messages detail",
  );

  for (const query of evidence.queries) {
    const measured = query.samples.filter((sample) => sample.status === "ok");
    const durations = measured.map((sample) => sample.elapsedMs);
    const p95 = measured.length === 0 ? null : percentile(durations, 95);
    p95ByQuery[query.query] = p95;
    add(
      `${query.query} warm top-20 p95`,
      p95 !== null && p95 < SEARCH_CAPACITY_P95_MS,
      p95 ?? "no successful samples",
      `< ${SEARCH_CAPACITY_P95_MS} ms`,
    );
    const wrong = [...query.expectedIdentities].reverse();
    const counterexample: SearchSample = {
      query: query.query,
      phase: "measured",
      iteration: 0,
      status: "ok",
      elapsedMs: 1,
      peakRssBytes: 0,
      candidateCount: wrong.length,
      hydratedCount: wrong.length,
      identities: wrong,
      identityDigest: digestOrderedIdentities(wrong),
    };
    add(
      `${query.query} exact ordered identities`,
      query.samples.every((sample) => !expectedIdentityMismatch(query, sample)),
      query.samples.every((sample) => !expectedIdentityMismatch(query, sample)),
      "every measured sample matches identities and order",
    );
    add(
      `${query.query} rejects fast wrong tied order`,
      expectedIdentityMismatch(query, counterexample),
      expectedIdentityMismatch(query, counterexample),
      "wrong ordered identities fail regardless of latency",
    );
    add(
      `${query.query} bounded page size`,
      query.samples.every(
        (sample) =>
          sample.status !== "ok" || sample.candidateCount <= SEARCH_CAPACITY_MAX_PAGE_SIZE,
      ),
      query.samples.every(
        (sample) =>
          sample.status !== "ok" || sample.candidateCount <= SEARCH_CAPACITY_MAX_PAGE_SIZE,
      ),
      `candidate and hydrated pages <= ${SEARCH_CAPACITY_MAX_PAGE_SIZE}`,
    );
  }

  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    checks: Object.freeze(checks),
    p95ByQuery: Object.freeze(p95ByQuery),
  };
}
