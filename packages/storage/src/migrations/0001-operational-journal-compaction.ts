import type { Migration } from "../migration-runner";

/**
 * The compaction schema is separate from the append-only journal migration.
 * It is applied after the journal migration in the application assembly.
 */
export const OPERATIONAL_JOURNAL_COMPACTION_MIGRATION_VERSION = 1;

export const operationalJournalCompactionMigration = {
  version: OPERATIONAL_JOURNAL_COMPACTION_MIGRATION_VERSION,
  name: "operational-journal-compaction",
  sql: `
CREATE TABLE operational_journal_summaries (
  summary_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(summary_id) = 80 AND
    substr(summary_id, 1, 16) = 'journal-summary:' AND
    substr(summary_id, 17) NOT GLOB '*[^0-9a-f]*'
  ),
  category TEXT NOT NULL CHECK (category IN ('sync', 'routing', 'action', 'recovery', 'administrative')),
  subject_id TEXT NOT NULL CHECK (
    length(subject_id) BETWEEN 1 AND 200 AND subject_id = trim(subject_id) AND
    instr(subject_id, char(0)) = 0 AND
    subject_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*' AND
    subject_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
  ),
  correlation_id TEXT NOT NULL CHECK (
    length(correlation_id) BETWEEN 1 AND 200 AND correlation_id = trim(correlation_id) AND
    instr(correlation_id, char(0)) = 0 AND
    correlation_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*' AND
    correlation_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
  ),
  event_count INTEGER NOT NULL CHECK (typeof(event_count) = 'integer' AND event_count > 0),
  source_started_at TEXT NOT NULL CHECK (
    length(source_started_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', source_started_at) = source_started_at
  ),
  source_ended_at TEXT NOT NULL CHECK (
    length(source_ended_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', source_ended_at) = source_ended_at AND
    source_ended_at >= source_started_at
  ),
  cutoff_at TEXT NOT NULL CHECK (
    length(cutoff_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', cutoff_at) = cutoff_at
  )
);

CREATE TRIGGER operational_journal_summaries_immutable_update
BEFORE UPDATE ON operational_journal_summaries
BEGIN
  SELECT RAISE(ABORT, 'operational journal summaries are immutable');
END;

CREATE TRIGGER operational_journal_summaries_immutable_delete
BEFORE DELETE ON operational_journal_summaries
BEGIN
  SELECT RAISE(ABORT, 'operational journal summaries are immutable');
END;

CREATE TABLE operational_journal_compaction_authorizations (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES operational_journal(id) ON DELETE CASCADE
);

DROP TRIGGER operational_journal_reject_delete;

CREATE TRIGGER operational_journal_reject_delete
BEFORE DELETE ON operational_journal
WHEN NOT EXISTS (
  SELECT 1
  FROM operational_journal_compaction_authorizations
  WHERE event_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'operational journal is append-only');
END;
`,
} satisfies Migration;

export const operationalJournalCompactionSequence = [
  operationalJournalCompactionMigration,
] as const;
