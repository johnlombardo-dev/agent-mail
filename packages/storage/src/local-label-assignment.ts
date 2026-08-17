import { Database } from "bun:sqlite";
import {
  createMessageId,
  createRouteDecision,
  parseRoutingDecision,
  type LocalLabel,
  type MessageId,
  type RouteDecision,
} from "@agent-mail/core";
import { canonicalRoutingDecisionId } from "./routing-decision-identity";

const CANONICAL_MESSAGE_ID = /^message:[0-9a-f]{64}$/u;

export type LocalLabelAssignmentInput = Readonly<{
  readonly messageId: unknown;
  readonly label: unknown;
  readonly ruleId: unknown;
  readonly ruleVersion: unknown;
  readonly matchedFacts: unknown;
  readonly decidedAt: unknown;
  readonly provenance: unknown;
}>;

export type LocalLabelAssignment = Readonly<{
  readonly messageId: MessageId;
  readonly label: LocalLabel;
  readonly ruleId: RouteDecision["ruleId"];
  readonly ruleVersion: number;
  readonly matchedFactsJson: string;
  readonly decidedAt: RouteDecision["decidedAt"];
  readonly provenanceSource: string;
  readonly provenanceEvaluationId: string;
}>;

export type LocalLabelAssignmentResult = Readonly<{
  readonly assignment: LocalLabelAssignment;
  /** True only when this call inserted a new assignment row. */
  readonly created: boolean;
}>;

export type RoutingDecisionAssignmentInput = Readonly<{
  readonly messageId: unknown;
  /** Optional caller id accepted for caller-level idempotency; never part of identity. */
  readonly decisionId?: unknown;
  readonly decision: unknown;
}>;

export class LocalLabelAssignmentConflictError extends Error {
  constructor() {
    super("local label assignment conflicts with its existing decision provenance");
    this.name = "LocalLabelAssignmentConflictError";
  }
}

type RecordValue = Readonly<Record<string, unknown>>;

type StoredAssignment = Readonly<{
  readonly message_id: string;
  readonly label: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly matched_facts_json: string;
  readonly decided_at: string;
  readonly provenance_source: string;
  readonly provenance_evaluation_id: string;
}>;

/**
 * Persist one local label decision in one SQLite transaction.
 *
 * The unique key is the canonical message, local label, routing rule, and
 * rule version. A retry with byte-identical provenance is a no-op. Reusing
 * that identity with changed provenance is rejected instead of overwriting
 * the original decision.
 */
export function assignLocalLabel(
  database: Database,
  input: LocalLabelAssignmentInput,
): LocalLabelAssignmentResult {
  const assignment = parseAssignmentInput(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    database
      .query("INSERT INTO local_labels (label) VALUES (?) ON CONFLICT(label) DO NOTHING;")
      .run(assignment.label);

    const existing = readAssignment(database, assignment);
    if (existing === null) {
      database
        .query(
          `INSERT INTO local_label_assignments
            (message_id, label, rule_id, rule_version, matched_facts_json, decided_at,
             provenance_source, provenance_evaluation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          assignment.messageId,
          assignment.label,
          assignment.ruleId,
          assignment.ruleVersion,
          assignment.matchedFactsJson,
          assignment.decidedAt,
          assignment.provenanceSource,
          assignment.provenanceEvaluationId,
        );
      database.exec("COMMIT;");
      transactionStarted = false;
      return { assignment, created: true };
    }

    if (!sameAssignment(existing, assignment)) throw new LocalLabelAssignmentConflictError();

    database.exec("COMMIT;");
    transactionStarted = false;
    return { assignment, created: false };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "local label assignment transaction failed",
        );
      }
    }
    throw error;
  }
}

/**
 * Persist a route decision and its local-label assignment atomically.
 *
 * The routing decision unique key is the canonical message, rule, version, and
 * normalized matched-facts JSON.  `decisionId` is caller metadata only, so
 * ingestion and sweep callers converge even when they arrive with different
 * caller ids or provenance sources.
 */
export function persistRouteDecision(
  database: Database,
  input: RoutingDecisionAssignmentInput,
): LocalLabelAssignmentResult {
  const record = requireRecord(input, "routing decision assignment");
  const keys = Reflect.ownKeys(record);
  const allowed = new Set(["messageId", "decisionId", "decision"]);
  if (
    !Object.prototype.hasOwnProperty.call(record, "messageId") ||
    !Object.prototype.hasOwnProperty.call(record, "decision") ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError("routing decision assignment has missing or unknown fields");
  }

  const decision = createRouteDecision(record.decision);
  const assignment = parseAssignmentInput({
    messageId: record.messageId,
    label: decision.label,
    ruleId: decision.ruleId,
    ruleVersion: decision.ruleVersion,
    matchedFacts: decision.matchedFacts,
    decidedAt: decision.decidedAt,
    provenance: decision.provenance,
  });
  if (record.decisionId !== undefined) parseDecisionId(record.decisionId);
  const canonicalId = canonicalRoutingDecisionId(assignment.messageId, decision);

  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const existingDecision = readRoutingDecision(database, assignment);
    let decisionCreated = false;
    if (existingDecision === null) {
      database
        .query(
          `INSERT INTO routing_decisions
            (decision_id, message_id, rule_id, rule_version, matched_facts_json, decision_json)
           VALUES (?, ?, ?, ?, ?, ?);`,
        )
        .run(
          canonicalId,
          assignment.messageId,
          assignment.ruleId,
          assignment.ruleVersion,
          assignment.matchedFactsJson,
          JSON.stringify(["routing-decision-v1", decision]),
        );
      decisionCreated = true;
    }

    const durableAssignment =
      existingDecision === null
        ? assignment
        : parseAssignmentInput({
            messageId: assignment.messageId,
            label: existingDecision.decision.label,
            ruleId: existingDecision.decision.ruleId,
            ruleVersion: existingDecision.decision.ruleVersion,
            matchedFacts: existingDecision.decision.matchedFacts,
            decidedAt: existingDecision.decision.decidedAt,
            provenance: existingDecision.decision.provenance,
          });
    database
      .query("INSERT INTO local_labels (label) VALUES (?) ON CONFLICT(label) DO NOTHING;")
      .run(durableAssignment.label);
    const existingAssignment = readAssignment(database, durableAssignment);
    let assignmentCreated = false;
    if (existingAssignment === null) {
      insertAssignment(database, durableAssignment);
      assignmentCreated = true;
    }

    database.exec("COMMIT;");
    transactionStarted = false;
    return { assignment: durableAssignment, created: decisionCreated || assignmentCreated };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "routing decision assignment transaction failed",
        );
      }
    }
    throw error;
  }
}

/** Persist a previously constructed route decision for one canonical message. */
export function assignRouteDecision(
  database: Database,
  input: RoutingDecisionAssignmentInput,
): LocalLabelAssignmentResult {
  return persistRouteDecision(database, input);
}

/** Naming alias for callers that treat the durable row as the decision. */
export const persistRoutingDecision = persistRouteDecision;

type StoredRoutingDecision = Readonly<{
  readonly decision_id: string;
  readonly message_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly matched_facts_json: string;
  readonly decision: ReturnType<typeof createRouteDecision>;
}>;

function readRoutingDecision(
  database: Database,
  assignment: LocalLabelAssignment,
): StoredRoutingDecision | null {
  const row: unknown = database
    .query(
      `SELECT decision_id, message_id, rule_id, rule_version, matched_facts_json, decision_json
         FROM routing_decisions
        WHERE message_id = ? AND rule_id = ? AND rule_version = ? AND matched_facts_json = ?;`,
    )
    .get(
      assignment.messageId,
      assignment.ruleId,
      assignment.ruleVersion,
      assignment.matchedFactsJson,
    );
  if (row === null) return null;
  const value = requireRecord(row, "routing decision row");
  requireExactKeys(
    value,
    ["decision_id", "message_id", "rule_id", "rule_version", "matched_facts_json", "decision_json"],
    "routing decision row",
  );
  if (
    typeof value.decision_id !== "string" ||
    typeof value.message_id !== "string" ||
    typeof value.rule_id !== "string" ||
    typeof value.rule_version !== "number" ||
    !Number.isSafeInteger(value.rule_version) ||
    typeof value.matched_facts_json !== "string" ||
    typeof value.decision_json !== "string"
  ) {
    throw new TypeError("routing decision row has an invalid shape");
  }
  const decision = parseRoutingDecision(value.decision_json);
  if (decision.kind !== "route") throw new TypeError("routing decision row is not a route");
  if (
    decision.ruleId !== value.rule_id ||
    decision.ruleVersion !== value.rule_version ||
    JSON.stringify(decision.matchedFacts) !== value.matched_facts_json ||
    value.decision_id !== canonicalRoutingDecisionId(assignment.messageId, decision)
  ) {
    throw new TypeError("routing decision row identity does not match its decision");
  }
  return {
    decision_id: value.decision_id,
    message_id: value.message_id,
    rule_id: value.rule_id,
    rule_version: value.rule_version,
    matched_facts_json: value.matched_facts_json,
    decision,
  };
}

function insertAssignment(database: Database, assignment: LocalLabelAssignment): void {
  database
    .query(
      `INSERT INTO local_label_assignments
        (message_id, label, rule_id, rule_version, matched_facts_json, decided_at,
         provenance_source, provenance_evaluation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    )
    .run(
      assignment.messageId,
      assignment.label,
      assignment.ruleId,
      assignment.ruleVersion,
      assignment.matchedFactsJson,
      assignment.decidedAt,
      assignment.provenanceSource,
      assignment.provenanceEvaluationId,
    );
}

function parseDecisionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new TypeError("caller decision ID must be a bounded, trimmed text value");
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function parseAssignmentInput(input: LocalLabelAssignmentInput): LocalLabelAssignment {
  const record = requireRecord(input, "local label assignment");
  requireExactKeys(
    record,
    ["messageId", "label", "ruleId", "ruleVersion", "matchedFacts", "decidedAt", "provenance"],
    "local label assignment",
  );

  const messageId = createMessageId(record.messageId);
  if (!CANONICAL_MESSAGE_ID.test(messageId)) {
    throw new TypeError("message ID must use the canonical SHA-256 namespace form");
  }
  const decision = createRouteDecision({
    kind: "route",
    label: record.label,
    ruleId: record.ruleId,
    ruleVersion: record.ruleVersion,
    matchedFacts: record.matchedFacts,
    decidedAt: record.decidedAt,
    provenance: record.provenance,
  });

  return {
    messageId,
    label: decision.label,
    ruleId: decision.ruleId,
    ruleVersion: decision.ruleVersion,
    matchedFactsJson: JSON.stringify(decision.matchedFacts),
    decidedAt: decision.decidedAt,
    provenanceSource: decision.provenance.source,
    provenanceEvaluationId: decision.provenance.evaluationId,
  };
}

function readAssignment(
  database: Database,
  assignment: LocalLabelAssignment,
): StoredAssignment | null {
  const row: unknown = database
    .query(
      `SELECT message_id, label, rule_id, rule_version, matched_facts_json, decided_at,
              provenance_source, provenance_evaluation_id
         FROM local_label_assignments
        WHERE message_id = ? AND label = ? AND rule_id = ? AND rule_version = ?;`,
    )
    .get(assignment.messageId, assignment.label, assignment.ruleId, assignment.ruleVersion);
  if (row === null) return null;
  const value = requireRecord(row, "local label assignment row");
  requireExactKeys(
    value,
    [
      "message_id",
      "label",
      "rule_id",
      "rule_version",
      "matched_facts_json",
      "decided_at",
      "provenance_source",
      "provenance_evaluation_id",
    ],
    "local label assignment row",
  );
  if (
    typeof value.message_id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.rule_id !== "string" ||
    typeof value.rule_version !== "number" ||
    !Number.isSafeInteger(value.rule_version) ||
    typeof value.matched_facts_json !== "string" ||
    typeof value.decided_at !== "string" ||
    typeof value.provenance_source !== "string" ||
    typeof value.provenance_evaluation_id !== "string"
  ) {
    throw new TypeError("local label assignment row has an invalid shape");
  }
  return {
    message_id: value.message_id,
    label: value.label,
    rule_id: value.rule_id,
    rule_version: value.rule_version,
    matched_facts_json: value.matched_facts_json,
    decided_at: value.decided_at,
    provenance_source: value.provenance_source,
    provenance_evaluation_id: value.provenance_evaluation_id,
  };
}

function sameAssignment(stored: StoredAssignment, assignment: LocalLabelAssignment): boolean {
  return (
    stored.message_id === assignment.messageId &&
    stored.label === assignment.label &&
    stored.rule_id === assignment.ruleId &&
    stored.rule_version === assignment.ruleVersion &&
    stored.matched_facts_json === assignment.matchedFactsJson &&
    stored.decided_at === assignment.decidedAt &&
    stored.provenance_source === assignment.provenanceSource &&
    stored.provenance_evaluation_id === assignment.provenanceEvaluationId
  );
}

function requireRecord(value: unknown, name: string): RecordValue {
  if (!isRecord(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value: RecordValue, keys: readonly string[], name: string): void {
  const expected = new Set(keys);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new TypeError(`${name} has missing or unknown fields`);
  }
}
