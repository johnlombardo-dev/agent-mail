import type { Migration } from "../migration-runner";

export const initialBackfillCompletionMigration = {
  version: 1,
  name: "initial-backfill-completion",
  sql: `
CREATE TABLE initial_backfill_completions (
  account_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  observed_uid_ceiling INTEGER,
  observed_uid_next_known INTEGER NOT NULL CHECK (observed_uid_next_known IN (0, 1)),
  observed_uid_next INTEGER,
  observed_at TEXT NOT NULL CHECK (
    length(observed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) = observed_at
  ),
  next_sweep_eligible_at TEXT NOT NULL CHECK (
    length(next_sweep_eligible_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', next_sweep_eligible_at) = next_sweep_eligible_at
  ),
  PRIMARY KEY (account_id, mailbox_id, uid_validity),
  FOREIGN KEY (account_id, mailbox_id, uid_validity)
    REFERENCES mailbox_checkpoints (account_id, mailbox_id, uid_validity),
  CHECK (
    (observed_uid_ceiling IS NULL) OR
    (typeof(observed_uid_ceiling) = 'integer' AND observed_uid_ceiling > 0 AND observed_uid_ceiling <= 4294967295)
  ),
  CHECK (
    (observed_uid_next_known = 0 AND observed_uid_next IS NULL) OR
    (observed_uid_next_known = 1 AND typeof(observed_uid_next) = 'integer' AND observed_uid_next > 0 AND observed_uid_next <= 4294967295)
  )
);
`,
} satisfies Migration;
