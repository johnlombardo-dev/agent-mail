#!/usr/bin/env bun
/**
 * P4-C17 read-only 250k search capacity gate.
 *
 * The child mode runs one complete candidate-selection plus final-page
 * hydration operation. The parent process owns the timeout so a slow SQLite
 * query cannot prevent timeout evidence from being retained.
 */
import { createHash } from "node:crypto";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { Database } from "bun:sqlite";
import { searchCandidatePlacementIndexMigration } from "../../packages/storage/src/migrations/0004-search-candidate-placement-index";
import {
  compileSearchQuery,
  type CompiledSearchQuery,
} from "../../packages/storage/src/search-query-compiler";
import {
  compileStructuredFilters,
  type CompiledStructuredFilter,
} from "../../packages/storage/src/structured-filter-compiler";
import { selectSearchCandidates } from "../../packages/storage/src/search-candidate-repository";
import {
  hydrateSearchSummaryPage,
  searchSummaryHydrationSql,
} from "../../packages/storage/src/search-summary-hydration-repository";
import {
  digestOrderedIdentities,
  evaluateSearchCapacity,
  hasForbiddenFullScan,
  SEARCH_CAPACITY_MAX_PAGE_SIZE,
  SEARCH_CAPACITY_SAMPLES,
  SEARCH_CAPACITY_TOP_LIMIT,
  SEARCH_CAPACITY_WARMUPS,
  type SearchCapacityEvidence,
  type SearchSample,
} from "./search-capacity-gate";
import { composeSourceToken, emitSourceTokenEvent } from "./source-token-event";

const ACCOUNT_ID = "account:capacity";
const DEFAULT_CORPUS = ".artifacts/p4-c16-search-corpus.sqlite";
const DEFAULT_OUTPUT = ".artifacts/p4-c17-search-capacity.json";
const DEFAULT_BENCHMARK_COPY = ".artifacts/p4-c17-search-corpus-indexed.sqlite";
const DEFAULT_TIMEOUT_MS = 1_500;
const REPRESENTATIVE_QUERIES = ["atlas", "beacon", '"status update"'] as const;

type PlanRow = Readonly<{ readonly detail: string }>;
type CountRow = Readonly<{ readonly count: number }>;
export type HydrationParameter = string | number | null;

type ChildResult = Readonly<{
  readonly status: "ok";
  readonly elapsedMs: number;
  readonly peakRssBytes: number;
  readonly candidateCount: number;
  readonly hydratedCount: number;
  readonly identities: readonly string[];
  readonly identityDigest: string;
}>;

function requireCompiledSearch(query: string): {
  readonly text: CompiledSearchQuery;
  readonly filters: CompiledStructuredFilter;
} {
  const text = compileSearchQuery(query);
  const filters = compileStructuredFilters([]);
  if (text.kind !== "compiled" || filters.kind !== "compiled") {
    throw new Error(`representative query did not compile: ${query}`);
  }
  return { text, filters };
}

function candidatePlanSql(text: CompiledSearchQuery, filters: CompiledStructuredFilter): string {
  return `
    WITH ranked AS MATERIALIZED (
      SELECT
        m.message_id AS message_id,
        bm25(message_fts, 10.0, 4.0, 3.0, 2.0, 1.0) AS score,
        (
          SELECT MIN(rp.internal_date)
          FROM remote_placements AS rp
          WHERE rp.message_id = m.message_id
            AND rp.account_id = ?
            AND rp.tombstone_observed_at IS NULL
            AND rp.internal_date IS NOT NULL
        ) AS canonical_instant
      FROM message_fts
      JOIN message_search_documents AS d ON d.document_id = message_fts.rowid
      JOIN messages AS m ON m.message_id = d.message_id
      WHERE ${text.sql}
        AND ${filters.sql}
        AND EXISTS (
          SELECT 1
          FROM remote_placements AS visibility_rp
          WHERE visibility_rp.account_id = ?
            AND visibility_rp.message_id = m.message_id
            AND visibility_rp.tombstone_observed_at IS NULL
        )
    )
    SELECT message_id, score, canonical_instant
    FROM ranked
    ORDER BY
      score ASC,
      CASE WHEN canonical_instant IS NULL THEN 1 ELSE 0 END ASC,
      canonical_instant DESC,
      message_id ASC
    LIMIT ?;
  `;
}

function queryPlan(
  database: Database,
  sql: string,
  parameters: readonly HydrationParameter[],
): readonly string[] {
  return Object.freeze(
    database
      .query<PlanRow, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters)
      .map(({ detail }) => detail),
  );
}

export function assertHydrationPlanParameterCount(
  parameters: readonly HydrationParameter[],
  candidateCount: number,
): void {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) {
    throw new Error(
      `hydration candidate count must be a non-negative safe integer: ${candidateCount}`,
    );
  }
  const expectedCount = candidateCount * 4 + 2;
  if (parameters.length !== expectedCount) {
    throw new Error(
      `hydration parameter count mismatch: expected ${expectedCount} values, received ${parameters.length}`,
    );
  }
}

export function buildHydrationPlanParameters(
  expected: readonly string[],
  candidateCount: number,
  accountId: string,
): readonly HydrationParameter[] {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < expected.length) {
    throw new Error(
      `hydration candidate count must cover expected identities: ${candidateCount} for ${expected.length}`,
    );
  }
  const parameters: HydrationParameter[] = [];
  for (const [index, identity] of expected.entries()) {
    parameters.push(index + 1, identity, 0, "2026-01-01T00:00:00.000Z");
  }
  while (parameters.length < candidateCount * 4) {
    parameters.push(1, expected[0] ?? "message:" + "0".repeat(64), 0, "2026-01-01T00:00:00.000Z");
  }
  parameters.push(accountId, accountId);
  assertHydrationPlanParameterCount(parameters, candidateCount);
  return Object.freeze(parameters);
}

function count(database: Database, sql: string): number {
  const row = database.query<CountRow, []>(sql).get();
  return Number(row?.count ?? 0);
}

function referenceIdentities(database: Database, query: string): readonly string[] {
  const { text } = requireCompiledSearch(query);
  const rows = database
    .query<Readonly<{ readonly message_id: string }>, (string | number)[]>(
      `
        WITH live AS MATERIALIZED (
          SELECT message_id, MIN(internal_date) AS canonical_instant
          FROM remote_placements
          WHERE account_id = ? AND tombstone_observed_at IS NULL
          GROUP BY message_id
        )
        SELECT m.message_id
        FROM message_fts
        JOIN message_search_documents AS d ON d.document_id = message_fts.rowid
        JOIN messages AS m ON m.message_id = d.message_id
        JOIN live ON live.message_id = m.message_id
        WHERE ${text.sql}
        ORDER BY
          bm25(message_fts, 10.0, 4.0, 3.0, 2.0, 1.0) ASC,
          CASE WHEN live.canonical_instant IS NULL THEN 1 ELSE 0 END ASC,
          live.canonical_instant DESC,
          m.message_id ASC
        LIMIT ?;
      `,
    )
    .all(ACCOUNT_ID, ...text.parameters, SEARCH_CAPACITY_TOP_LIMIT);
  return Object.freeze(rows.map(({ message_id }) => message_id));
}

function maxRss(current: number): number {
  return Math.max(current, process.memoryUsage().rss);
}

function readChildRssBytes(pid: number): number | null {
  const result = Bun.spawnSync(["/bin/ps", "-o", "rss=", "-p", String(pid)]);
  const value = Number(new TextDecoder().decode(result.stdout).trim()) * 1024;
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function childRun(corpusPath: string, query: string): Promise<void> {
  const database = new Database(corpusPath, { readonly: true });
  try {
    const { text, filters } = requireCompiledSearch(query);
    let peakRssBytes = process.memoryUsage().rss;
    const started = performance.now();
    const candidates = selectSearchCandidates(database, {
      accountId: ACCOUNT_ID,
      text,
      filters,
      limit: SEARCH_CAPACITY_TOP_LIMIT,
    });
    peakRssBytes = maxRss(peakRssBytes);
    const summaries = hydrateSearchSummaryPage(database, {
      accountId: ACCOUNT_ID,
      candidates: candidates.candidates,
    });
    peakRssBytes = maxRss(peakRssBytes);
    const identities = Object.freeze(candidates.candidates.map(({ messageId }) => messageId));
    const result: ChildResult = {
      status: "ok",
      elapsedMs: performance.now() - started,
      peakRssBytes,
      candidateCount: candidates.candidates.length,
      hydratedCount: summaries.length,
      identities,
      identityDigest: digestOrderedIdentities(identities),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    database.close();
  }
}

function parseChildResult(value: unknown): ChildResult | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = new Map(Object.entries(value));
  const identitiesValue = record.get("identities");
  if (
    record.get("status") !== "ok" ||
    typeof record.get("elapsedMs") !== "number" ||
    typeof record.get("peakRssBytes") !== "number" ||
    typeof record.get("candidateCount") !== "number" ||
    typeof record.get("hydratedCount") !== "number" ||
    typeof record.get("identityDigest") !== "string" ||
    !Array.isArray(identitiesValue) ||
    !identitiesValue.every((identity): identity is string => typeof identity === "string")
  )
    return undefined;
  return {
    status: "ok",
    elapsedMs: record.get("elapsedMs"),
    peakRssBytes: record.get("peakRssBytes"),
    candidateCount: record.get("candidateCount"),
    hydratedCount: record.get("hydratedCount"),
    identities: Object.freeze(identitiesValue),
    identityDigest: record.get("identityDigest"),
  };
}

async function runChildWithTimeout(
  corpusPath: string,
  query: string,
  timeoutMs: number,
): Promise<SearchSample> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, import.meta.path, "--child", corpusPath, query], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let peakChildRssBytes = readChildRssBytes(child.pid);
  const rssSampler = setInterval(() => {
    const observed = readChildRssBytes(child.pid);
    if (observed !== null) peakChildRssBytes = Math.max(peakChildRssBytes ?? 0, observed);
  }, 100);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  let exitCode: number | undefined;
  const finished = child.exited.then((code) => {
    exitCode = code;
    return "finished" as const;
  });
  const outcome = await Promise.race([finished, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  clearInterval(rssSampler);
  if (outcome === "timeout") {
    // SQLite may be inside a native call and not service SIGTERM until the
    // query completes. SIGKILL makes the parent timeout an actual bound.
    const finalObservedRss = readChildRssBytes(child.pid);
    if (finalObservedRss !== null) {
      peakChildRssBytes = Math.max(peakChildRssBytes ?? 0, finalObservedRss);
    }
    child.kill(9);
    return {
      query,
      phase: "measured",
      iteration: 0,
      status: "timeout",
      elapsedMs: performance.now() - started,
      peakRssBytes: peakChildRssBytes,
      candidateCount: 0,
      hydratedCount: 0,
      identities: [],
      identityDigest: digestOrderedIdentities([]),
      error: `child exceeded ${timeoutMs} ms`,
    };
  }
  const output = await new Response(child.stdout).text();
  const lastLine = output.trim().split("\n").at(-1);
  let decoded: unknown;
  try {
    decoded = lastLine === undefined ? undefined : JSON.parse(lastLine);
  } catch {
    decoded = undefined;
  }
  const parsed = parseChildResult(decoded);
  if (parsed !== undefined) {
    return {
      ...parsed,
      query,
      phase: "measured",
      iteration: 0,
    };
  }
  return {
    query,
    phase: "measured",
    iteration: 0,
    status: "error",
    elapsedMs: performance.now() - started,
    peakRssBytes: null,
    candidateCount: 0,
    hydratedCount: 0,
    identities: [],
    identityDigest: digestOrderedIdentities([]),
    error: `child failed (${exitCode ?? "unknown"}): ${await new Response(child.stderr).text()}`,
  };
}

async function main(): Promise<void> {
  const corpusPath = process.argv[2] ?? DEFAULT_CORPUS;
  const outputPath = process.argv[3] ?? DEFAULT_OUTPUT;
  const timeoutMs = Number(process.argv[4] ?? DEFAULT_TIMEOUT_MS);
  const benchmarkCopyPath = process.argv[5] ?? DEFAULT_BENCHMARK_COPY;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("timeout must be positive");
  const inventoryPath = `${corpusPath}.inventory.json`;
  const cleanupResult = Bun.spawnSync([
    "/bin/rm",
    "-f",
    benchmarkCopyPath,
    `${benchmarkCopyPath}-shm`,
    `${benchmarkCopyPath}-wal`,
  ]);
  if (cleanupResult.exitCode !== 0) throw new Error("failed to clear benchmark database copy");
  const inventoryBytes = await Bun.file(inventoryPath).bytes();
  const inventorySha256Before = createHash("sha256").update(inventoryBytes).digest("hex");
  const copyResult = Bun.spawnSync(["/bin/cp", "-p", corpusPath, benchmarkCopyPath]);
  if (copyResult.exitCode !== 0) throw new Error("failed to create benchmark database copy");
  const database = new Database(benchmarkCopyPath);
  try {
    const first = requireCompiledSearch(REPRESENTATIVE_QUERIES[0]);
    const candidateParameters: (string | number | null)[] = [
      ACCOUNT_ID,
      ...first.text.parameters,
      ACCOUNT_ID,
      SEARCH_CAPACITY_TOP_LIMIT,
    ];
    const candidatePlan = queryPlan(
      database,
      candidatePlanSql(first.text, first.filters),
      candidateParameters,
    );
    const expected = referenceIdentities(database, REPRESENTATIVE_QUERIES[0]);
    const hydrationSql = searchSummaryHydrationSql(SEARCH_CAPACITY_TOP_LIMIT);
    const hydrationParameters = buildHydrationPlanParameters(
      expected,
      SEARCH_CAPACITY_TOP_LIMIT,
      ACCOUNT_ID,
    );
    const hydrationPlan = queryPlan(database, hydrationSql, hydrationParameters);
    const negativeFullScan = queryPlan(
      database,
      "SELECT message_id FROM messages ORDER BY message_id LIMIT ?;",
      [SEARCH_CAPACITY_TOP_LIMIT],
    );
    const negativeFullScanRejected = hasForbiddenFullScan(negativeFullScan);

    const queries = [];
    for (const query of REPRESENTATIVE_QUERIES) {
      const expectedIdentities = referenceIdentities(database, query);
      const expectedIdentityDigest = digestOrderedIdentities(expectedIdentities);
      const warmups: SearchSample[] = [];
      for (let iteration = 1; iteration <= SEARCH_CAPACITY_WARMUPS; iteration += 1) {
        const sample = await runChildWithTimeout(benchmarkCopyPath, query, timeoutMs);
        warmups.push({ ...sample, phase: "warmup", iteration });
      }
      const samples: SearchSample[] = [];
      for (let iteration = 1; iteration <= SEARCH_CAPACITY_SAMPLES; iteration += 1) {
        const sample = await runChildWithTimeout(benchmarkCopyPath, query, timeoutMs);
        samples.push({ ...sample, phase: "measured", iteration });
      }
      queries.push({ query, expectedIdentities, expectedIdentityDigest, warmups, samples });
    }
    const evidence: SearchCapacityEvidence = {
      thresholds: {
        warmups: SEARCH_CAPACITY_WARMUPS,
        measuredSamples: SEARCH_CAPACITY_SAMPLES,
        topLimit: SEARCH_CAPACITY_TOP_LIMIT,
        p95Ms: 250,
        maxPageSize: SEARCH_CAPACITY_MAX_PAGE_SIZE,
      },
      plans: {
        candidate: candidatePlan,
        hydration: hydrationPlan,
        negativeFullScan,
        negativeFullScanRejected,
      },
      queries,
      adjacentCounterexample: {
        status: "rejected",
        reason: "fast reversed identities fail exact order",
      },
    };
    const evaluation = evaluateSearchCapacity(evidence);
    const inventorySha256After = createHash("sha256")
      .update(await Bun.file(inventoryPath).bytes())
      .digest("hex");
    const output = {
      contract: "P4-C17",
      generatedAt: new Date().toISOString(),
      command: process.argv.slice(1),
      corpus: {
        path: corpusPath,
        inventoryPath,
        inventorySha256: inventorySha256Before,
        inventorySha256After,
        inventoryUnchanged: inventorySha256Before === inventorySha256After,
        messages: count(database, "SELECT COUNT(*) AS count FROM messages;"),
        placements: count(database, "SELECT COUNT(*) AS count FROM remote_placements;"),
        ftsRows: count(database, "SELECT COUNT(*) AS count FROM message_fts;"),
      },
      benchmarkCopy: {
        path: benchmarkCopyPath,
        migration: searchCandidatePlacementIndexMigration.name,
        index: "search_placements_by_account_message",
        schemaVersion: database
          .query<{ readonly user_version: number }, []>("PRAGMA user_version;")
          .get()?.user_version,
      },
      runtime: {
        bun: process.versions.bun ?? "unknown",
        node: process.versions.node,
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        hostname: hostname(),
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
        workerProfile: "gpt-5.6-luna/high",
      },
      evidence,
      evaluation,
    };
    await Bun.write(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ status: evaluation.status, outputPath, p95ByQuery: evaluation.p95ByQuery })}\n`,
    );
    await emitSourceTokenEvent({
      assertionId: "fts-exact-top20",
      sourcePath: "scripts/capacity/benchmark-search.ts",
      token: composeSourceToken(["export", "function", "assertHydrationPlanParameterCount"]),
      expected: 1,
    });
    if (evaluation.status !== "pass") process.exitCode = 1;
  } finally {
    database.close();
  }
}

if (process.argv[2] === "--child") {
  await childRun(process.argv[3] ?? DEFAULT_CORPUS, process.argv[4] ?? REPRESENTATIVE_QUERIES[0]);
} else if (import.meta.main) {
  await main();
}
