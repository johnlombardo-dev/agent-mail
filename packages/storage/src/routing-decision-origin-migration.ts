import type { Migration } from "./migration-runner";

/** Append-only caller attribution kept outside canonical routing identity. */
export const ROUTING_DECISION_ORIGIN_MIGRATION_VERSION = 1;

export const routingDecisionOriginMigration = {
  version: ROUTING_DECISION_ORIGIN_MIGRATION_VERSION,
  name: "routing-decision-origins",
  sql: `
CREATE TABLE routing_decision_origins (
  decision_id TEXT NOT NULL,
  caller_source TEXT NOT NULL CHECK (caller_source IN ('direct-ingestion', 'recurring-sweep')),
  observed_at TEXT NOT NULL CHECK (
    length(observed_at) = 24 AND
    strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) = observed_at
  ),
  evaluation_id TEXT NOT NULL CHECK (
    length(evaluation_id) BETWEEN 1 AND 256 AND
    evaluation_id = trim(evaluation_id) AND
    instr(evaluation_id, char(0)) = 0 AND
    evaluation_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*' AND
    evaluation_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
  ),
  PRIMARY KEY (decision_id, caller_source),
  FOREIGN KEY (decision_id) REFERENCES routing_decisions(decision_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX routing_decision_origins_by_decision
  ON routing_decision_origins (decision_id);

CREATE TRIGGER routing_decision_origins_reject_update
BEFORE UPDATE ON routing_decision_origins
BEGIN
  SELECT RAISE(ABORT, 'routing decision origins are immutable');
END;

CREATE TRIGGER routing_decision_origins_reject_delete
BEFORE DELETE ON routing_decision_origins
BEGIN
  SELECT RAISE(ABORT, 'routing decision origins are immutable');
END;
`,
} satisfies Migration;

export const routingDecisionOriginMigrations = [routingDecisionOriginMigration] as const;
