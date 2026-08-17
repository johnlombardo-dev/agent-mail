import type { Migration } from "../migration-runner";

/**
 * The journal migration is intentionally published as a standalone definition.
 * The storage migration registry must assign this definition its position when
 * it is composed with the message/placement migration from issue #61.
 */
export const OPERATIONAL_JOURNAL_MIGRATION_VERSION = 1;

export const operationalJournalMigration = {
  version: OPERATIONAL_JOURNAL_MIGRATION_VERSION,
  name: "operational-journal",
  sql: `
CREATE TABLE operational_journal (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(id) BETWEEN 1 AND 200
      AND id = trim(id)
      AND instr(id, char(0)) = 0
      AND id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  occurred_at TEXT NOT NULL
    CHECK (
      length(occurred_at) = 24
      AND substr(occurred_at, 12, 2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at
    ),
  category TEXT NOT NULL
    CHECK (category IN ('sync', 'routing', 'action', 'recovery', 'administrative')),
  subject_id TEXT NOT NULL
    CHECK (
      length(subject_id) BETWEEN 1 AND 200
      AND subject_id = trim(subject_id)
      AND instr(subject_id, char(0)) = 0
      AND subject_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND subject_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  correlation_id TEXT NOT NULL
    CHECK (
      length(correlation_id) BETWEEN 1 AND 200
      AND correlation_id = trim(correlation_id)
      AND instr(correlation_id, char(0)) = 0
      AND correlation_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND correlation_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  payload_version INTEGER NOT NULL
    CHECK (payload_version BETWEEN 1 AND 255),
  payload_json TEXT NOT NULL
    CHECK (
      length(payload_json) BETWEEN 2 AND 16384
      AND json_valid(payload_json)
      AND json_type(payload_json) = 'object'
    )
);

CREATE INDEX operational_journal_order
  ON operational_journal (occurred_at, id);

CREATE TRIGGER operational_journal_reject_update
BEFORE UPDATE ON operational_journal
BEGIN
  SELECT RAISE(ABORT, 'operational journal is append-only');
END;

CREATE TRIGGER operational_journal_reject_delete
BEFORE DELETE ON operational_journal
BEGIN
  SELECT RAISE(ABORT, 'operational journal is append-only');
END;

CREATE TRIGGER operational_journal_reject_forbidden_payload
BEFORE INSERT ON operational_journal
WHEN EXISTS (
  SELECT 1
  FROM json_tree(NEW.payload_json)
  WHERE key IS NOT NULL
    AND (
      lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE 'raw%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%body%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%eml%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%mime%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%attachment%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%credential%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%password%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%passwd%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%secret%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%token%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%authorization%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%bearer%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%apikey%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%accesskey%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%privatekey%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%stack%'
      OR lower(replace(replace(replace(CAST(key AS TEXT), '_', ''), '-', ''), ' ', '')) LIKE '%cause%'
    )
    OR (
      type = 'text'
      AND (
        lower(value) LIKE 'authorization:%'
        OR lower(value) LIKE 'bearer %'
        OR lower(value) LIKE '%password=%'
        OR lower(value) LIKE '%passwd=%'
        OR lower(value) LIKE '%secret=%'
        OR lower(value) LIKE '%token=%'
        OR lower(value) LIKE 'from:%'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'operational journal payload contains forbidden data');
END;
`,
} satisfies Migration;

/** A standalone set is convenient for migration tests and later composition. */
export const operationalJournalMigrations = [operationalJournalMigration] as const;
