import type { Migration } from "./migration-runner";

/**
 * Local labels are deliberately separate from remote mailbox placements.
 * This migration is standalone so the application migration assembly can
 * assign its final contiguous version without changing this definition.
 */
export const LOCAL_LABEL_MIGRATION_VERSION = 1;

export const localLabelMigration = {
  version: LOCAL_LABEL_MIGRATION_VERSION,
  name: "local-labels",
  sql: `
CREATE TABLE local_labels (
  label TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(label) BETWEEN 7 AND 256
      AND substr(label, 1, 6) = 'label:'
      AND label = trim(label)
      AND instr(label, char(0)) = 0
      AND label NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND label NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
      AND substr(label, 7, 1) NOT IN ('', ':', ' ', char(9))
    )
);

CREATE TABLE local_label_assignments (
  message_id TEXT NOT NULL
    CHECK (
      length(message_id) = 72
      AND substr(message_id, 1, 8) = 'message:'
      AND substr(message_id, 9) NOT GLOB '*[^0-9a-f]*'
    ),
  label TEXT NOT NULL,
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
  decided_at TEXT NOT NULL
    CHECK (
      length(decided_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) = decided_at
    ),
  provenance_source TEXT NOT NULL
    CHECK (
      length(provenance_source) BETWEEN 1 AND 256
      AND provenance_source = trim(provenance_source)
      AND instr(provenance_source, char(0)) = 0
      AND provenance_source NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND provenance_source NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  provenance_evaluation_id TEXT NOT NULL
    CHECK (
      length(provenance_evaluation_id) BETWEEN 1 AND 256
      AND provenance_evaluation_id = trim(provenance_evaluation_id)
      AND instr(provenance_evaluation_id, char(0)) = 0
      AND provenance_evaluation_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND provenance_evaluation_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  PRIMARY KEY (message_id, label, rule_id, rule_version),
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (label) REFERENCES local_labels(label)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX local_label_assignments_by_message
  ON local_label_assignments (message_id, label);

CREATE TRIGGER local_labels_reject_update
BEFORE UPDATE ON local_labels
BEGIN
  SELECT RAISE(ABORT, 'local label catalog is immutable');
END;

CREATE TRIGGER local_labels_reject_delete
BEFORE DELETE ON local_labels
BEGIN
  SELECT RAISE(ABORT, 'local label catalog is immutable');
END;

CREATE TRIGGER local_label_assignments_reject_update
BEFORE UPDATE ON local_label_assignments
BEGIN
  SELECT RAISE(ABORT, 'local label assignments are immutable');
END;

CREATE TRIGGER local_label_assignments_reject_delete
BEFORE DELETE ON local_label_assignments
BEGIN
  SELECT RAISE(ABORT, 'local label assignments are immutable');
END;
`,
} satisfies Migration;

/** A standalone set supports focused schema tests and later composition. */
export const localLabelMigrations = [localLabelMigration] as const;
