import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

/** Durable objects used only while a replacement search index is being built. */
export const SEARCH_REINDEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS search_reindex_lease (
  lease_id INTEGER PRIMARY KEY CHECK (lease_id = 1),
  operation_name TEXT NOT NULL CHECK (length(operation_name) BETWEEN 1 AND 128),
  replacement_name TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK (phase IN ('building', 'activating')),
  last_rowid INTEGER NOT NULL CHECK (last_rowid >= 0),
  processed_rows INTEGER NOT NULL CHECK (processed_rows >= 0)
);

CREATE TABLE IF NOT EXISTS search_reindex_progress (
  replacement_name TEXT NOT NULL,
  source_rowid INTEGER NOT NULL CHECK (source_rowid > 0),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  PRIMARY KEY (replacement_name, source_rowid)
);
`;

const ACTIVE_INDEX_NAME = "message_fts";
const REINDEX_OPERATION_NAME = "fts-reindex";
const DEFAULT_BATCH_SIZE = 128;
const MAX_BATCH_SIZE = 1_000;
export const MAX_REPRESENTATIVE_TOP_K = 100;

export type SearchReindexBoundary =
  "batch-committed" | "activation-before-swap" | "activation-after-swap";

export type SearchReindexOptions = Readonly<{
  /** A stable owner name lets a restart resume the same durable operation. */
  readonly operationName?: unknown;
  /** Keyset batch size. It is bounded to keep one write transaction short. */
  readonly batchSize?: number;
  /** Exact, ordered MATCH results required before the swap can commit. */
  readonly representativeQueries?: readonly SearchReindexRepresentativeQuery[];
  /** Test seam for proving verification retains only bounded batches. */
  readonly onVerificationBatch?: (
    batch: SearchReindexVerificationBatch,
  ) => void;
  /** Test seam for proving representative probes use a bounded top-k. */
  readonly onRepresentativeProbe?: (
    probe: SearchReindexRepresentativeProbe,
  ) => void;
  /** Test seam; called after a durable batch or during the atomic swap. */
  readonly beforeBoundary?: (boundary: SearchReindexBoundary) => void;
}>;

export type SearchReindexRepresentativeQuery = Readonly<{
  readonly query: string;
  readonly expectedRowids: readonly number[];
}>;

export type SearchReindexVerificationBatch = Readonly<{
  readonly requestedBatchSize: number;
  readonly sourceRows: number;
  readonly progressRows: number;
  readonly replacementRows: number;
}>;

export type SearchReindexRepresentativeProbe = Readonly<{
  readonly query: string;
  readonly requestedLimit: number;
  readonly returnedRows: number;
}>;

export type SearchReindexResult = Readonly<{
  readonly operationName: string;
  readonly replacementName: string;
  readonly sourceRowCount: number;
  readonly replacementRowCount: number;
  readonly sourceChecksum: string;
  readonly replacementChecksum: string;
  readonly status: "activated";
}>;

export type SearchReindexErrorCode =
  | "invalid-input"
  | "already-running"
  | "schema"
  | "verification-failed"
  | "activation-failed";

export class SearchReindexError extends Error {
  readonly code: SearchReindexErrorCode;

  constructor(
    code: SearchReindexErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SearchReindexError";
    this.code = code;
  }
}

type LeasePhase = "building" | "activating";
type Lease = Readonly<{
  readonly operationName: string;
  readonly replacementName: string;
  readonly phase: LeasePhase;
  readonly lastRowid: number;
  readonly processedRows: number;
}>;

type SourceRow = Readonly<{
  readonly rowid: unknown;
  readonly message_id: unknown;
  readonly subject: unknown;
  readonly participants: unknown;
  readonly body_plain: unknown;
  readonly body_html: unknown;
  readonly attachment_names: unknown;
}>;

type VerifiedSourceRow = Readonly<{
  readonly rowid: number;
  readonly messageId: string;
  readonly subject: string;
  readonly participants: string;
  readonly bodyPlain: string;
  readonly bodyHtml: string;
  readonly attachmentNames: string;
  readonly digest: string;
}>;

type ProgressRow = Readonly<{
  readonly source_rowid: unknown;
  readonly source_digest: unknown;
}>;

type ReplacementRow = Readonly<{ readonly id: unknown }>;

type DecodedProgressRow = Readonly<{
  readonly sourceRowid: number;
  readonly sourceDigest: string;
}>;

type RecordValue = Readonly<Record<string, unknown>>;

/**
 * Build a complete replacement external-content FTS index and atomically make
 * it available as `message_fts`. The active index is never written or dropped
 * until the replacement has passed all verification checks.
 */
export function rebuildSearchIndex(
  database: Database,
  options: SearchReindexOptions = {},
): SearchReindexResult {
  const operationName = parseOperationName(
    options.operationName ?? REINDEX_OPERATION_NAME,
  );
  const batchSize = parseBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);
  validateRepresentativeQueries(options.representativeQueries ?? []);

  createReindexSchema(database);
  let lease = acquireLease(database, operationName);
  ensureActiveIndex(database);
  if (!hasReplacementIndex(database, lease.replacementName)) {
    resetMissingReplacement(database, lease);
    lease = acquireLease(database, operationName);
  }
  ensureReplacementIndex(database, lease);

  while (lease.phase === "building") {
    const rows = readSourceBatch(database, lease.lastRowid, batchSize);
    if (rows.length === 0) {
      lease = markActivating(database, lease);
      break;
    }
    commitBatch(database, lease, rows);
    options.beforeBoundary?.("batch-committed");
    const nextLease = readLease(database, operationName, true);
    if (nextLease === undefined) {
      throw new SearchReindexError(
        "schema",
        "search reindex lease disappeared during build",
      );
    }
    lease = nextLease;
  }

  let verification: Verification;
  try {
    verification = verifyReplacement(database, lease, batchSize, {
      representativeQueries: options.representativeQueries ?? [],
      onVerificationBatch: options.onVerificationBatch,
      onRepresentativeProbe: options.onRepresentativeProbe,
    });
  } catch (error: unknown) {
    if (
      error instanceof SearchReindexError &&
      error.code === "verification-failed"
    ) {
      resetFailedOperation(database, lease);
    }
    throw error;
  }
  options.beforeBoundary?.("activation-before-swap");
  activateReplacement(database, lease, options.beforeBoundary);

  return Object.freeze({
    operationName,
    replacementName: lease.replacementName,
    sourceRowCount: verification.sourceRowCount,
    replacementRowCount: verification.replacementRowCount,
    sourceChecksum: verification.sourceChecksum,
    replacementChecksum: verification.replacementChecksum,
    status: "activated",
  });
}

/** Apply the durable helper schema without starting a reindex operation. */
export function applySearchReindexSchema(database: Database): void {
  createReindexSchema(database);
}

function createReindexSchema(database: Database): void {
  try {
    database.exec(SEARCH_REINDEX_SCHEMA_SQL);
  } catch (error: unknown) {
    throw new SearchReindexError(
      "schema",
      "search reindex helper schema is unavailable",
      {
        cause: error,
      },
    );
  }
}

function acquireLease(database: Database, operationName: string): Lease {
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const existing = readLease(database, operationName, true);
    if (existing !== undefined) {
      database.exec("COMMIT;");
      transactionStarted = false;
      return existing;
    }
    const occupied = database
      .query(
        "SELECT operation_name FROM search_reindex_lease WHERE lease_id = 1;",
      )
      .get();
    if (occupied !== null) {
      throw new SearchReindexError(
        "already-running",
        "another named search reindex operation already owns the lease",
      );
    }
    const replacementName = replacementNameFor(operationName);
    database
      .query(
        "INSERT INTO search_reindex_lease " +
          "(lease_id, operation_name, replacement_name, phase, last_rowid, processed_rows) " +
          "VALUES (1, ?, ?, 'building', 0, 0);",
      )
      .run(operationName, replacementName);
    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      operationName,
      replacementName,
      phase: "building",
      lastRowid: 0,
      processedRows: 0,
    };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    if (error instanceof SearchReindexError) throw error;
    throw new SearchReindexError(
      "schema",
      "search reindex lease could not be acquired",
      {
        cause: error,
      },
    );
  }
}

function readLease(
  database: Database,
  operationName: string,
  requireOwner: boolean,
): Lease | undefined {
  const row: unknown = database
    .query(
      "SELECT operation_name, replacement_name, phase, last_rowid, processed_rows " +
        "FROM search_reindex_lease WHERE lease_id = 1;",
    )
    .get();
  if (row === null) return undefined;
  const value = requireRecord(row, "search reindex lease");
  requireExactKeys(
    value,
    [
      "operation_name",
      "replacement_name",
      "phase",
      "last_rowid",
      "processed_rows",
    ],
    "search reindex lease",
  );
  if (
    typeof value.operation_name !== "string" ||
    typeof value.replacement_name !== "string" ||
    (value.phase !== "building" && value.phase !== "activating") ||
    !isNonNegativeInteger(value.last_rowid) ||
    !isNonNegativeInteger(value.processed_rows)
  ) {
    throw new SearchReindexError(
      "schema",
      "search reindex lease has an invalid shape",
    );
  }
  if (requireOwner && value.operation_name !== operationName) {
    throw new SearchReindexError(
      "already-running",
      "another named search reindex operation owns the lease",
    );
  }
  return {
    operationName: value.operation_name,
    replacementName: value.replacement_name,
    phase: value.phase,
    lastRowid: value.last_rowid,
    processedRows: value.processed_rows,
  };
}

function ensureActiveIndex(database: Database): void {
  const row: unknown = database
    .query("SELECT type, sql FROM sqlite_master WHERE name = ?;")
    .get(ACTIVE_INDEX_NAME);
  if (row === null) {
    throw new SearchReindexError(
      "schema",
      "active message_fts index does not exist",
    );
  }
  const value = requireRecord(row, "active search index");
  if (
    value.type !== "table" ||
    typeof value.sql !== "string" ||
    !value.sql.includes("fts5")
  ) {
    throw new SearchReindexError(
      "schema",
      "active message_fts object is not an FTS5 table",
    );
  }
}

function ensureReplacementIndex(database: Database, lease: Lease): void {
  const row: unknown = database
    .query("SELECT type, sql FROM sqlite_master WHERE name = ?;")
    .get(lease.replacementName);
  if (row !== null) {
    const value = requireRecord(row, "replacement search index");
    if (
      value.type !== "table" ||
      typeof value.sql !== "string" ||
      !value.sql.includes("fts5")
    ) {
      throw new SearchReindexError(
        "schema",
        "replacement search object is not an FTS5 table",
      );
    }
    return;
  }
  if (
    lease.phase !== "building" ||
    lease.lastRowid !== 0 ||
    lease.processedRows !== 0
  ) {
    throw new SearchReindexError(
      "schema",
      "activating reindex lease has no replacement index to resume",
    );
  }
  const quoted = quoteIdentifier(lease.replacementName);
  database.exec(
    `CREATE VIRTUAL TABLE ${quoted} USING fts5(` +
      "subject, participants, body_plain, body_html, attachment_names, " +
      "content='indexed_messages', content_rowid='rowid', " +
      "tokenize='unicode61 remove_diacritics 2'" +
      ");",
  );
}

function hasReplacementIndex(
  database: Database,
  replacementName: string,
): boolean {
  const row: unknown = database
    .query("SELECT type, sql FROM sqlite_master WHERE name = ?;")
    .get(replacementName);
  if (row === null) return false;
  const value = requireRecord(row, "replacement search index");
  return (
    value.type === "table" &&
    typeof value.sql === "string" &&
    value.sql.includes("fts5")
  );
}

function readSourceBatch(
  database: Database,
  lastRowid: number,
  batchSize: number,
): VerifiedSourceRow[] {
  const rows: readonly SourceRow[] = database
    .query<SourceRow, [number, number]>(
      "SELECT rowid, message_id, subject, participants, body_plain, body_html, attachment_names " +
        "FROM indexed_messages WHERE rowid > ? ORDER BY rowid ASC LIMIT ?;",
    )
    .all(lastRowid, batchSize);
  return rows.map(decodeSourceRow);
}

function readProgressBatch(
  database: Database,
  replacementName: string,
  lastRowid: number,
  batchSize: number,
): readonly ProgressRow[] {
  return database
    .query<ProgressRow, [string, number, number]>(
      "SELECT source_rowid, source_digest FROM search_reindex_progress " +
        "WHERE replacement_name = ? AND source_rowid > ? " +
        "ORDER BY source_rowid ASC LIMIT ?;",
    )
    .all(replacementName, lastRowid, batchSize);
}

function readReplacementRowBatch(
  database: Database,
  replacementDocsize: string,
  lastRowid: number,
  batchSize: number,
): readonly ReplacementRow[] {
  return database
    .query<ReplacementRow, [number, number]>(
      `SELECT id FROM ${replacementDocsize} WHERE id > ? ORDER BY id ASC LIMIT ?;`,
    )
    .all(lastRowid, batchSize);
}

function decodeProgressRow(row: ProgressRow): DecodedProgressRow {
  if (!isPositiveInteger(row.source_rowid) || !isSha256(row.source_digest)) {
    throw new SearchReindexError(
      "verification-failed",
      "reindex progress row is invalid",
    );
  }
  return { sourceRowid: row.source_rowid, sourceDigest: row.source_digest };
}

function readCount(database: Database, table: string): number {
  const row: unknown = database
    .query(`SELECT COUNT(*) AS count FROM ${table};`)
    .get();
  const value = requireRecord(row, "reindex count");
  if (!isNonNegativeInteger(value.count)) {
    throw new SearchReindexError(
      "verification-failed",
      "reindex count is invalid",
    );
  }
  return value.count;
}

function commitBatch(
  database: Database,
  lease: Lease,
  rows: readonly VerifiedSourceRow[],
): void {
  const last = rows.at(-1);
  if (last === undefined)
    throw new SearchReindexError("schema", "empty reindex batch");
  const index = quoteIdentifier(lease.replacementName);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const insertIndex = database.query(
      `INSERT OR IGNORE INTO ${index}(rowid, subject, participants, body_plain, body_html, attachment_names) ` +
        "VALUES (?, ?, ?, ?, ?, ?);",
    );
    const insertProgress = database.query(
      "INSERT OR REPLACE INTO search_reindex_progress " +
        "(replacement_name, source_rowid, source_digest) VALUES (?, ?, ?);",
    );
    for (const row of rows) {
      insertIndex.run(
        row.rowid,
        row.subject,
        row.participants,
        row.bodyPlain,
        row.bodyHtml,
        row.attachmentNames,
      );
      insertProgress.run(lease.replacementName, row.rowid, row.digest);
    }
    database
      .query(
        "UPDATE search_reindex_lease SET last_rowid = ?, processed_rows = ? " +
          "WHERE lease_id = 1 AND operation_name = ? AND phase = 'building';",
      )
      .run(last.rowid, lease.processedRows + rows.length, lease.operationName);
    database.exec("COMMIT;");
    transactionStarted = false;
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    if (error instanceof SearchReindexError) throw error;
    throw new SearchReindexError(
      "schema",
      "replacement index batch could not be committed",
      {
        cause: error,
      },
    );
  }
}

function markActivating(database: Database, lease: Lease): Lease {
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    database
      .query(
        "UPDATE search_reindex_lease SET phase = 'activating' " +
          "WHERE lease_id = 1 AND operation_name = ? AND phase = 'building';",
      )
      .run(lease.operationName);
    database.exec("COMMIT;");
    transactionStarted = false;
    return { ...lease, phase: "activating" };
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    if (error instanceof SearchReindexError) throw error;
    throw new SearchReindexError(
      "schema",
      "search reindex could not enter activation",
      {
        cause: error,
      },
    );
  }
}

type Verification = Readonly<{
  readonly sourceRowCount: number;
  readonly replacementRowCount: number;
  readonly sourceChecksum: string;
  readonly replacementChecksum: string;
}>;

function verifyReplacement(
  database: Database,
  lease: Lease,
  batchSize: number,
  options: Readonly<{
    readonly representativeQueries: readonly SearchReindexRepresentativeQuery[];
    readonly onVerificationBatch?: (
      batch: SearchReindexVerificationBatch,
    ) => void;
    readonly onRepresentativeProbe?: (
      probe: SearchReindexRepresentativeProbe,
    ) => void;
  }>,
): Verification {
  validateRepresentativeQueries(options.representativeQueries);
  const sourceRowCount = readCount(database, "indexed_messages");
  const index = quoteIdentifier(lease.replacementName);
  const replacementDocsize = quoteIdentifier(
    `${lease.replacementName}_docsize`,
  );
  const replacementRowCount = readCount(database, replacementDocsize);
  if (
    sourceRowCount !== replacementRowCount ||
    sourceRowCount !== lease.processedRows
  ) {
    throw new SearchReindexError(
      "verification-failed",
      "replacement FTS row count does not match the source or durable checkpoint",
    );
  }

  const sourceAccumulator = createChecksumAccumulator();
  const replacementAccumulator = createChecksumAccumulator();
  let sourceLastRowid = 0;
  let progressLastRowid = 0;
  let replacementLastRowid = 0;
  let verifiedRows = 0;
  while (true) {
    const sourceRows = readSourceBatch(database, sourceLastRowid, batchSize);
    const progressRows = readProgressBatch(
      database,
      lease.replacementName,
      progressLastRowid,
      batchSize,
    );
    const replacementRows = readReplacementRowBatch(
      database,
      replacementDocsize,
      replacementLastRowid,
      batchSize,
    );
    options.onVerificationBatch?.({
      requestedBatchSize: batchSize,
      sourceRows: sourceRows.length,
      progressRows: progressRows.length,
      replacementRows: replacementRows.length,
    });
    if (
      sourceRows.length === 0 &&
      progressRows.length === 0 &&
      replacementRows.length === 0
    )
      break;
    if (
      sourceRows.length !== progressRows.length ||
      sourceRows.length !== replacementRows.length
    ) {
      throw new SearchReindexError(
        "verification-failed",
        "replacement keyset batches do not have matching identities",
      );
    }
    for (const [index, sourceRow] of sourceRows.entries()) {
      const progressRow = progressRows[index];
      const replacementRow = replacementRows[index];
      if (progressRow === undefined || replacementRow === undefined) {
        throw new SearchReindexError(
          "verification-failed",
          "replacement keyset batch is incomplete",
        );
      }
      const progress = decodeProgressRow(progressRow);
      if (
        sourceRow.rowid !== progress.sourceRowid ||
        sourceRow.rowid !== replacementRow.id
      ) {
        throw new SearchReindexError(
          "verification-failed",
          "replacement identities do not match the source",
        );
      }
      if (sourceRow.digest !== progress.sourceDigest) {
        throw new SearchReindexError(
          "verification-failed",
          "replacement source checksum does not match",
        );
      }
      sourceAccumulator.add(sourceRow.digest);
      replacementAccumulator.add(progress.sourceDigest);
      verifiedRows += 1;
    }
    sourceLastRowid = sourceRows.at(-1)?.rowid ?? sourceLastRowid;
    const lastProgress = progressRows.at(-1);
    const lastReplacement = replacementRows.at(-1);
    if (lastProgress === undefined || !isPositiveInteger(lastReplacement?.id)) {
      throw new SearchReindexError(
        "verification-failed",
        "replacement keyset batch has no terminal identity",
      );
    }
    progressLastRowid = decodeProgressRow(lastProgress).sourceRowid;
    replacementLastRowid = lastReplacement.id;
    if (verifiedRows > sourceRowCount) {
      throw new SearchReindexError(
        "verification-failed",
        "replacement verification exceeded the source count",
      );
    }
  }
  if (verifiedRows !== sourceRowCount || verifiedRows !== replacementRowCount) {
    throw new SearchReindexError(
      "verification-failed",
      "replacement verification count is incomplete",
    );
  }
  const sourceChecksum = sourceAccumulator.finish();
  const replacementChecksum = replacementAccumulator.finish();

  try {
    database
      .query(`INSERT INTO ${index}(${index}) VALUES ('integrity-check');`)
      .run();
  } catch (error: unknown) {
    throw new SearchReindexError(
      "verification-failed",
      "replacement FTS integrity check failed",
      {
        cause: error,
      },
    );
  }
  for (const representative of options.representativeQueries) {
    const requestedLimit = Math.min(
      representative.expectedRowids.length + 1,
      MAX_REPRESENTATIVE_TOP_K + 1,
    );
    const actual = database
      .query<{ rowid: unknown }, [string]>(
        `SELECT rowid FROM ${index} WHERE ${index} MATCH ? ` +
          `ORDER BY bm25(${index}) ASC, rowid ASC LIMIT ${requestedLimit};`,
      )
      .all(representative.query)
      .map((row) => {
        if (!isPositiveInteger(row.rowid)) {
          throw new SearchReindexError(
            "verification-failed",
            "representative FTS row identity is invalid",
          );
        }
        return row.rowid;
      });
    options.onRepresentativeProbe?.({
      query: representative.query,
      requestedLimit,
      returnedRows: actual.length,
    });
    if (!sameNumbers(actual, representative.expectedRowids)) {
      throw new SearchReindexError(
        "verification-failed",
        `representative FTS query ${representative.query} did not produce the expected ordered identities`,
      );
    }
  }
  return {
    sourceRowCount,
    replacementRowCount,
    sourceChecksum,
    replacementChecksum,
  };
}

function sameNumbers(
  actual: readonly number[],
  expected: readonly number[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function activateReplacement(
  database: Database,
  lease: Lease,
  beforeBoundary: SearchReindexOptions["beforeBoundary"],
): void {
  const replacement = quoteIdentifier(lease.replacementName);
  const active = quoteIdentifier(ACTIVE_INDEX_NAME);
  const previous = quoteIdentifier("message_fts_previous");
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const triggerDefinitions = readFtsTriggerDefinitions(database);
    // A previous retained index is never active because reads use message_fts.
    database.exec(`DROP TABLE IF EXISTS ${previous};`);
    database.exec(`ALTER TABLE ${active} RENAME TO ${previous};`);
    database.exec(`ALTER TABLE ${replacement} RENAME TO ${active};`);
    restoreFtsTriggerTargets(database, triggerDefinitions);
    beforeBoundary?.("activation-after-swap");
    database.exec(`DROP TABLE ${previous};`);
    database
      .query("DELETE FROM search_reindex_progress WHERE replacement_name = ?;")
      .run(lease.replacementName);
    database
      .query(
        "DELETE FROM search_reindex_lease WHERE lease_id = 1 AND operation_name = ?;",
      )
      .run(lease.operationName);
    database.exec("COMMIT;");
    transactionStarted = false;
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    if (error instanceof SearchReindexError) throw error;
    throw new SearchReindexError(
      "activation-failed",
      "replacement FTS activation failed",
      {
        cause: error,
      },
    );
  }
}

type TriggerDefinition = Readonly<{
  readonly name: string;
  readonly sql: string;
}>;

function readFtsTriggerDefinitions(
  database: Database,
): readonly TriggerDefinition[] {
  const rows = database
    .query<{ name: unknown; sql: unknown }, [string]>(
      "SELECT name, sql FROM sqlite_master " +
        "WHERE type = 'trigger' AND sql IS NOT NULL AND instr(sql, ?) > 0 ORDER BY name;",
    )
    .all(ACTIVE_INDEX_NAME);
  return rows.map((row) => {
    if (typeof row.name !== "string" || typeof row.sql !== "string") {
      throw new SearchReindexError(
        "schema",
        "FTS maintenance trigger definition is invalid",
      );
    }
    return { name: row.name, sql: row.sql };
  });
}

/**
 * SQLite rewrites trigger SQL when the active FTS table is renamed. Recreate
 * the accepted trigger definitions from their pre-swap SQL so they target the
 * newly active table rather than the retained previous table.
 */
function restoreFtsTriggerTargets(
  database: Database,
  definitions: readonly TriggerDefinition[],
): void {
  for (const definition of definitions) {
    database.exec(`DROP TRIGGER ${quoteIdentifier(definition.name)};`);
    database.exec(definition.sql);
  }
}

function validateRepresentativeQueries(
  queries: readonly SearchReindexRepresentativeQuery[],
): void {
  if (queries.length === 0) {
    throw new SearchReindexError(
      "verification-failed",
      "at least one representative search query is required before activation",
    );
  }
  for (const query of queries) {
    if (
      typeof query.query !== "string" ||
      query.query.trim().length === 0 ||
      query.query.length > 512 ||
      !Array.isArray(query.expectedRowids) ||
      query.expectedRowids.length > MAX_REPRESENTATIVE_TOP_K ||
      query.expectedRowids.some((rowid) => !isPositiveInteger(rowid))
    ) {
      throw new SearchReindexError(
        "invalid-input",
        "representative search query is invalid",
      );
    }
  }
}

function resetMissingReplacement(database: Database, lease: Lease): void {
  if (lease.replacementName === ACTIVE_INDEX_NAME) {
    throw new SearchReindexError(
      "schema",
      "reindex lease points at the active FTS index",
    );
  }
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    database
      .query("DELETE FROM search_reindex_progress WHERE replacement_name = ?;")
      .run(lease.replacementName);
    database
      .query(
        "DELETE FROM search_reindex_lease WHERE lease_id = 1 AND operation_name = ?;",
      )
      .run(lease.operationName);
    database.exec("COMMIT;");
    transactionStarted = false;
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw new SearchReindexError(
      "schema",
      "stale replacement reindex state could not be cleaned",
      {
        cause: error,
      },
    );
  }
}

function resetFailedOperation(database: Database, lease: Lease): void {
  if (lease.replacementName === ACTIVE_INDEX_NAME) {
    throw new SearchReindexError(
      "schema",
      "reindex lease points at the active FTS index",
    );
  }
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    database.exec(
      `DROP TABLE IF EXISTS ${quoteIdentifier(lease.replacementName)};`,
    );
    database
      .query("DELETE FROM search_reindex_progress WHERE replacement_name = ?;")
      .run(lease.replacementName);
    database
      .query(
        "DELETE FROM search_reindex_lease WHERE lease_id = 1 AND operation_name = ?;",
      )
      .run(lease.operationName);
    database.exec("COMMIT;");
    transactionStarted = false;
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw new SearchReindexError(
      "schema",
      "failed replacement reindex state could not be cleaned",
      {
        cause: error,
      },
    );
  }
}

function decodeSourceRow(row: SourceRow): VerifiedSourceRow {
  if (
    !isPositiveInteger(row.rowid) ||
    typeof row.message_id !== "string" ||
    typeof row.subject !== "string" ||
    typeof row.participants !== "string" ||
    typeof row.body_plain !== "string" ||
    typeof row.body_html !== "string" ||
    typeof row.attachment_names !== "string"
  ) {
    throw new SearchReindexError(
      "verification-failed",
      "indexed message source row is invalid",
    );
  }
  const fields = [
    row.rowid,
    row.message_id,
    row.subject,
    row.participants,
    row.body_plain,
    row.body_html,
    row.attachment_names,
  ] as const;
  return {
    rowid: row.rowid,
    messageId: row.message_id,
    subject: row.subject,
    participants: row.participants,
    bodyPlain: row.body_plain,
    bodyHtml: row.body_html,
    attachmentNames: row.attachment_names,
    digest: createHash("sha256")
      .update(JSON.stringify(fields), "utf8")
      .digest("hex"),
  };
}

function createChecksumAccumulator(): Readonly<{
  readonly add: (digest: string) => void;
  readonly finish: () => string;
}> {
  const hash = createHash("sha256");
  return {
    add: (digest) => hash.update(`${digest}\n`, "utf8"),
    finish: () => hash.digest("hex"),
  };
}

function replacementNameFor(operationName: string): string {
  return `message_fts_replacement_${createHash("sha256").update(operationName).digest("hex").slice(0, 16)}`;
}

function parseOperationName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new SearchReindexError(
      "invalid-input",
      "reindex operation name is invalid",
    );
  }
  return value;
}

function parseBatchSize(value: unknown): number {
  if (!isPositiveInteger(value) || value > MAX_BATCH_SIZE) {
    throw new SearchReindexError(
      "invalid-input",
      `reindex batch size must be between 1 and ${MAX_BATCH_SIZE}`,
    );
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function requireRecord(value: unknown, description: string): RecordValue {
  if (!isRecord(value)) {
    throw new SearchReindexError("schema", `${description} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: RecordValue,
  keys: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new SearchReindexError(
      "schema",
      `${description} has unexpected columns`,
    );
  }
}

function rollback(database: Database, error: unknown): never {
  try {
    database.exec("ROLLBACK;");
  } catch (rollbackError: unknown) {
    throw new SearchReindexError(
      "schema",
      "search reindex transaction could not roll back",
      {
        cause: new AggregateError([error, rollbackError]),
      },
    );
  }
  throw error;
}
