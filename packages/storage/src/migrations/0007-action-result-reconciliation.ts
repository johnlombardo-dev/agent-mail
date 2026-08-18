import type { Migration } from "../migration-runner";

/** Allow one durable uncertain marker to be finalized by read-only evidence. */
export const actionResultReconciliationMigration = {
  version: 7,
  name: "action-result-reconciliation-transition",
  sql: `
DROP TRIGGER action_result_immutable;

CREATE TRIGGER action_result_immutable
BEFORE UPDATE ON action_results
WHEN NOT (
  OLD.attempt_id = NEW.attempt_id AND
  OLD.plan_id = NEW.plan_id AND
  OLD.target_ordinal = NEW.target_ordinal AND
  OLD.account_id = NEW.account_id AND
  OLD.mailbox_id = NEW.mailbox_id AND
  OLD.uid_validity = NEW.uid_validity AND
  OLD.uid = NEW.uid AND
  OLD.idempotency_key = NEW.idempotency_key AND
  OLD.started_at = NEW.started_at AND
  OLD.result_kind = 'uncertain' AND
  OLD.certainty = 'uncertain' AND
  NEW.result_kind IN ('success', 'stale', 'rejected', 'failed') AND
  NEW.certainty = 'definite'
)
BEGIN
  SELECT RAISE(ABORT, 'action result identity is immutable');
END;
`,
} satisfies Migration;

export const actionResultReconciliationMigrations = [actionResultReconciliationMigration] as const;
