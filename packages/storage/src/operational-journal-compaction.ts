import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { createUtcInstant, type UtcInstant } from "@agent-mail/core";
import { decodeClosedEnum, decodeSqliteRow, decodeUtcMillisecondInstant } from "./row-decoders";

const JOURNAL_CATEGORIES = ["sync", "routing", "action", "recovery", "administrative"] as const;
type JournalCategory = (typeof JOURNAL_CATEGORIES)[number];

const SUMMARY_TABLE = "operational_journal_summaries";
const AUTHORIZATION_TABLE = "operational_journal_compaction_authorizations";
const SUMMARY_TRIGGER = "operational_journal_summaries_immutable";
const SUMMARY_ID_PREFIX = "journal-summary:";

export type OperationalJournalCompactionInput = Readonly<{
  readonly cutoff: unknown;
  readonly protectedEventIds?: unknown;
}>;

export type OperationalJournalSummary = Readonly<{
  readonly summaryId: string;
  readonly category: JournalCategory;
  readonly subjectId: string;
  readonly correlationId: string;
  readonly eventCount: number;
  readonly sourceStartedAt: UtcInstant;
  readonly sourceEndedAt: UtcInstant;
  readonly cutoff: UtcInstant;
}>;

export type OperationalJournalCompactionResult = Readonly<{
  readonly cutoff: UtcInstant;
  readonly compactedEventCount: number;
  readonly retainedEventCount: number;
  readonly summaries: readonly OperationalJournalSummary[];
}>;

type JournalEvent = Readonly<{
  readonly id: string;
  readonly occurredAt: UtcInstant;
  readonly category: JournalCategory;
  readonly subjectId: string;
  readonly correlationId: string;
}>;

type RecordValue = Readonly<Record<string, unknown>>;

/**
 * Compact old journal detail while keeping the delete boundary private to
 * this transaction. The cutoff is normalized before it reaches SQLite, so
 * eligibility is chronological rather than a comparison of source strings.
 */
export function compactOperationalJournal(
  database: Database,
  input: unknown,
): OperationalJournalCompactionResult {
  const prepared = parseInput(input);
  requireCompactionSchema(database);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    requireAuthorizationTableEmpty(database);
    const candidates = readEligibleEvents(database, prepared.cutoff);
    const protectedEventIds = new Set(prepared.protectedEventIds);
    for (const eventId of readDecisionProvenanceReferences(database))
      protectedEventIds.add(eventId);
    const eligible = candidates.filter((event) => !protectedEventIds.has(event.id));
    const retainedEventCount = candidates.length - eligible.length;
    const summaries = buildSummaries(eligible, prepared.cutoff);

    if (eligible.length > 0) {
      for (const summary of summaries) insertSummary(database, summary);
      const authorizationInsert = database.query(
        `INSERT INTO ${AUTHORIZATION_TABLE} (event_id) VALUES (?) ON CONFLICT(event_id) DO NOTHING;`,
      );
      for (const event of eligible) authorizationInsert.run(event.id);
      database
        .query(
          `DELETE FROM operational_journal
             WHERE id IN (SELECT event_id FROM ${AUTHORIZATION_TABLE});`,
        )
        .run();
      database.exec(`DELETE FROM ${AUTHORIZATION_TABLE};`);
    }

    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      cutoff: prepared.cutoff,
      compactedEventCount: eligible.length,
      retainedEventCount,
      summaries,
    };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], "journal compaction rollback failed");
      }
    }
    throw error;
  }
}

function requireAuthorizationTableEmpty(database: Database): void {
  const row: unknown = database
    .query(`SELECT COUNT(*) AS count FROM ${AUTHORIZATION_TABLE};`)
    .get();
  if (!isRecord(row) || row.count !== 0) {
    throw new Error("operational journal compaction authorization state is not empty");
  }
}

function parseInput(value: unknown): Readonly<{
  readonly cutoff: UtcInstant;
  readonly protectedEventIds: readonly string[];
}> {
  if (!isRecord(value)) throw new TypeError("journal compaction input must be an object");
  const keys = Object.keys(value);
  if (
    keys.some((key) => key !== "cutoff" && key !== "protectedEventIds") ||
    !Object.prototype.hasOwnProperty.call(value, "cutoff")
  ) {
    throw new TypeError("journal compaction input has missing or unknown fields");
  }
  const protectedEventIds =
    value.protectedEventIds === undefined ? [] : parseEventIds(value.protectedEventIds);
  return { cutoff: createUtcInstant(value.cutoff), protectedEventIds };
}

function parseEventIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("protected journal event IDs must be an array");
  return value.map((eventId) => {
    if (
      typeof eventId !== "string" ||
      eventId.length < 1 ||
      eventId.length > 200 ||
      eventId.trim() !== eventId ||
      hasControlCharacters(eventId)
    ) {
      throw new TypeError("protected journal event ID is invalid");
    }
    return eventId;
  });
}

function requireCompactionSchema(database: Database): void {
  for (const table of [SUMMARY_TABLE, AUTHORIZATION_TABLE]) {
    if (!hasSchemaObject(database, "table", table)) {
      throw new Error("operational journal compaction migration is required");
    }
  }
  for (const trigger of [
    `${SUMMARY_TRIGGER}_update`,
    `${SUMMARY_TRIGGER}_delete`,
    "operational_journal_reject_delete",
  ]) {
    if (!hasSchemaObject(database, "trigger", trigger)) {
      throw new Error("operational journal compaction migration is required");
    }
  }
  const row: unknown = database
    .query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?;")
    .get("operational_journal_reject_delete");
  if (
    !isRecord(row) ||
    typeof row.sql !== "string" ||
    !row.sql.includes(AUTHORIZATION_TABLE) ||
    !row.sql.includes("operational journal is append-only")
  ) {
    throw new Error("operational journal compaction migration is invalid");
  }
}

function readEligibleEvents(database: Database, cutoff: UtcInstant): readonly JournalEvent[] {
  return database
    .query(
      `SELECT id, occurred_at, category, subject_id, correlation_id
         FROM operational_journal
        WHERE occurred_at <= ?
        ORDER BY occurred_at ASC, id ASC;`,
    )
    .all(cutoff)
    .map((row: unknown) => decodeJournalEvent(row));
}

function readDecisionProvenanceReferences(database: Database): readonly string[] {
  const references = new Set<string>();
  if (hasTable(database, "local_label_assignments")) {
    const rows: readonly unknown[] = database
      .query("SELECT provenance_evaluation_id FROM local_label_assignments;")
      .all();
    for (const row of rows) {
      if (isRecord(row) && typeof row.provenance_evaluation_id === "string") {
        references.add(row.provenance_evaluation_id);
      }
    }
  }
  if (hasTable(database, "routing_decisions")) {
    const rows: readonly unknown[] = database
      .query("SELECT decision_json FROM routing_decisions;")
      .all();
    for (const row of rows) {
      if (!isRecord(row) || typeof row.decision_json !== "string") {
        throw new TypeError("routing decision row is malformed");
      }
      try {
        const decision: unknown = JSON.parse(row.decision_json);
        references.add(extractProvenanceEvaluationId(decision));
      } catch (error: unknown) {
        throw new Error("routing decision provenance is malformed", { cause: error });
      }
    }
  }
  for (const subjectId of readRemotePlacementProvenanceReferences(database)) {
    const rows: readonly unknown[] = database
      .query("SELECT id FROM operational_journal WHERE subject_id = ?;")
      .all(subjectId);
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== "string") {
        throw new TypeError("remote placement journal provenance row is invalid");
      }
      references.add(row.id);
    }
  }
  return [...references];
}

function extractProvenanceEvaluationId(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== "routing-decision-v1") {
    throw new TypeError("routing decision envelope is invalid");
  }
  const decision = value[1];
  if (!isRecord(decision) || !isRecord(decision.provenance)) {
    throw new TypeError("routing decision provenance is missing");
  }
  const evaluationId = decision.provenance.evaluationId;
  if (typeof evaluationId !== "string" || evaluationId.length === 0) {
    throw new TypeError("routing decision evaluation ID is invalid");
  }
  return evaluationId;
}

function readRemotePlacementProvenanceReferences(database: Database): readonly string[] {
  if (!hasTable(database, "remote_placements")) return [];
  const rows: readonly unknown[] = database
    .query(
      `SELECT account_id, mailbox_id, uid_validity, uid
         FROM remote_placements
        WHERE tombstone_observed_at IS NOT NULL AND tombstone_reason IS NOT NULL;`,
    )
    .all();
  return rows.map((row: unknown) => {
    if (!isRecord(row)) throw new TypeError("remote placement provenance row is invalid");
    const accountId = boundedText(
      row.account_id,
      { table: "remote_placements", column: "account_id" },
      256,
    );
    const mailboxId = boundedText(
      row.mailbox_id,
      { table: "remote_placements", column: "mailbox_id" },
      256,
    );
    const uidValidity = boundedPositiveInteger(row.uid_validity, "remote_placements.uid_validity");
    const uid = boundedPositiveInteger(row.uid, "remote_placements.uid");
    return `placement:${createHash("sha256")
      .update(JSON.stringify([accountId, mailboxId, uidValidity, uid]), "utf8")
      .digest("hex")}`;
  });
}

function buildSummaries(
  events: readonly JournalEvent[],
  cutoff: UtcInstant,
): readonly OperationalJournalSummary[] {
  const groups = new Map<string, JournalEvent[]>();
  for (const event of events) {
    const key = `${event.category}\u0000${event.subjectId}\u0000${event.correlationId}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [event]);
    else group.push(event);
  }
  return [...groups.values()]
    .map((group) => createSummary({ group, cutoff }))
    .sort((left, right) =>
      left.summaryId < right.summaryId ? -1 : left.summaryId > right.summaryId ? 1 : 0,
    );
}

function createSummary(
  input: Readonly<{ readonly group: readonly JournalEvent[]; readonly cutoff: UtcInstant }>,
): OperationalJournalSummary {
  const first = input.group[0];
  if (first === undefined) throw new TypeError("journal summary group must not be empty");
  const last = input.group[input.group.length - 1];
  if (last === undefined) throw new TypeError("journal summary group must not be empty");
  const identity = JSON.stringify([
    "operational-journal-summary-v1",
    input.cutoff,
    first.category,
    first.subjectId,
    first.correlationId,
    input.group.map((event) => event.id),
  ]);
  const summaryId = `${SUMMARY_ID_PREFIX}${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  return {
    summaryId,
    category: first.category,
    subjectId: first.subjectId,
    correlationId: first.correlationId,
    eventCount: input.group.length,
    sourceStartedAt: first.occurredAt,
    sourceEndedAt: last.occurredAt,
    cutoff: input.cutoff,
  };
}

function insertSummary(database: Database, summary: OperationalJournalSummary): void {
  database
    .query(
      `INSERT INTO ${SUMMARY_TABLE}
        (summary_id, category, subject_id, correlation_id, event_count,
         source_started_at, source_ended_at, cutoff_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(summary_id) DO NOTHING;`,
    )
    .run(
      summary.summaryId,
      summary.category,
      summary.subjectId,
      summary.correlationId,
      summary.eventCount,
      summary.sourceStartedAt,
      summary.sourceEndedAt,
      summary.cutoff,
    );
}

function decodeJournalEvent(value: unknown): JournalEvent {
  const row = decodeSqliteRow({
    table: "operational_journal",
    row: value,
    columns: {
      id: { decode: (item, context) => boundedText(item, context, 200) },
      occurred_at: { decode: decodeUtcMillisecondInstant },
      category: {
        decode: (item, context) =>
          decodeClosedEnum(item, { ...context, values: JOURNAL_CATEGORIES }),
      },
      subject_id: { decode: (item, context) => boundedText(item, context, 200) },
      correlation_id: { decode: (item, context) => boundedText(item, context, 200) },
    },
  });
  const id = boundedText(row.id, { table: "operational_journal", column: "id" }, 200);
  const occurredAt = decodeUtcMillisecondInstant(row.occurred_at, {
    table: "operational_journal",
    column: "occurred_at",
  });
  const category = decodeClosedEnum(row.category, {
    table: "operational_journal",
    column: "category",
    values: JOURNAL_CATEGORIES,
  });
  const subjectId = boundedText(
    row.subject_id,
    { table: "operational_journal", column: "subject_id" },
    200,
  );
  const correlationId = boundedText(
    row.correlation_id,
    { table: "operational_journal", column: "correlation_id" },
    200,
  );
  return {
    id,
    occurredAt,
    category,
    subjectId,
    correlationId,
  };
}

function boundedText(
  value: unknown,
  context: Readonly<{ readonly table: string; readonly column: string }>,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`invalid ${context.table}.${context.column}`);
  }
  return value;
}

function hasTable(database: Database, table: string): boolean {
  return (
    database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?;")
      .get(table) !== null
  );
}

function hasSchemaObject(database: Database, kind: "table" | "trigger", name: string): boolean {
  return (
    database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?;")
      .get(kind, name) !== null
  );
}

function boundedPositiveInteger(value: unknown, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < 1 ||
    value > 4_294_967_295
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    )
      return true;
  }
  return false;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
