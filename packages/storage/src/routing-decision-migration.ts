import type { Migration } from "./migration-runner";

/**
 * Routing decisions are identified by the message and normalized facts that
 * produced them. Caller identity is deliberately absent from this table's
 * identity boundary.
 */
export const ROUTING_DECISION_MIGRATION_VERSION = 1;

export const routingDecisionMigration = {
  version: ROUTING_DECISION_MIGRATION_VERSION,
  name: "routing-decisions",
  sql: `
CREATE TABLE routing_decisions (
  decision_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(decision_id) BETWEEN 9 AND 256
      AND substr(decision_id, 1, 9) = 'decision:'
      AND decision_id = trim(decision_id)
      AND instr(decision_id, char(0)) = 0
      AND decision_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND decision_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  message_id TEXT NOT NULL
    CHECK (
      length(message_id) = 72
      AND substr(message_id, 1, 8) = 'message:'
      AND substr(message_id, 9) NOT GLOB '*[^0-9a-f]*'
    ),
  rule_id TEXT NOT NULL
    CHECK (
      length(rule_id) BETWEEN 6 AND 256
      AND substr(rule_id, 1, 5) = 'rule:'
      AND rule_id = trim(rule_id)
      AND instr(rule_id, char(0)) = 0
      AND rule_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND rule_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  rule_version INTEGER NOT NULL
    CHECK (typeof(rule_version) = 'integer' AND rule_version > 0),
  matched_facts_json TEXT NOT NULL
    CHECK (
      length(matched_facts_json) BETWEEN 2 AND 16384
      AND json_valid(matched_facts_json)
      AND json_type(matched_facts_json) = 'array'
      AND json_array_length(matched_facts_json) > 0
    ),
  decision_json TEXT NOT NULL
    CHECK (
      length(decision_json) BETWEEN 2 AND 32768
      AND json_valid(decision_json)
      AND json_type(decision_json) = 'array'
    ),
  UNIQUE (message_id, rule_id, rule_version, matched_facts_json),
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX routing_decisions_by_message
  ON routing_decisions (message_id, rule_id, rule_version);

CREATE TRIGGER routing_decisions_reject_update
BEFORE UPDATE ON routing_decisions
BEGIN
  SELECT RAISE(ABORT, 'routing decisions are immutable');
END;

CREATE TRIGGER routing_decisions_reject_delete
BEFORE DELETE ON routing_decisions
BEGIN
  SELECT RAISE(ABORT, 'routing decisions are immutable');
END;
`,
} satisfies Migration;

/** A standalone set supports focused schema tests and later composition. */
export const routingDecisionSequence = [routingDecisionMigration] as const;

/** Descriptive aliases for callers that name the migration by its invariant. */
export const routingDecisionUniquenessMigration = routingDecisionMigration;
export const routingDecisionUniquenessSequence = routingDecisionSequence;
