import type { Migration } from "../migration-runner";
import { actionPlanClaimMigrations } from "./0003-action-plan-claim";

/**
 * Extends the accepted attempt table with the complete executor input.
 *
 * The original action schema created the per-target table ahead of the
 * executor boundary. These columns are deliberately denormalized snapshots:
 * an attempt must remain self-contained when it is reopened after a restart.
 */
export const actionAttemptStartMigration = {
  version: 4,
  name: "action-attempt-start-boundary",
  sql: `
ALTER TABLE action_attempts ADD COLUMN claim_id TEXT CHECK (
  claim_id IS NULL OR (
    length(claim_id) > 6 AND
    claim_id GLOB 'claim:*' AND
    length(trim(claim_id)) = length(claim_id)
  )
);

ALTER TABLE action_attempts ADD COLUMN action_kind TEXT CHECK (
  action_kind IS NULL OR action_kind IN ('markSeen', 'markUnseen', 'moveToArchive', 'moveToTrash')
);

ALTER TABLE action_attempts ADD COLUMN precondition_modseq INTEGER CHECK (
  precondition_modseq IS NULL OR (typeof(precondition_modseq) = 'integer' AND precondition_modseq >= 0)
);

DROP TRIGGER action_attempt_immutable;

UPDATE action_attempts
SET
  claim_id = (SELECT claim_id FROM action_plans WHERE action_plans.plan_id = action_attempts.plan_id),
  action_kind = (SELECT action_kind FROM action_plans WHERE action_plans.plan_id = action_attempts.plan_id),
  precondition_modseq = (
    SELECT precondition_modseq
    FROM action_plan_targets
    WHERE action_plan_targets.plan_id = action_attempts.plan_id
      AND action_plan_targets.target_ordinal = action_attempts.target_ordinal
  );

CREATE TRIGGER action_attempt_immutable
BEFORE UPDATE ON action_attempts
BEGIN
  SELECT RAISE(ABORT, 'action attempt identity is immutable');
END;

CREATE TRIGGER action_attempt_start_shape_guard
BEFORE INSERT ON action_attempts
WHEN
  NEW.claim_id IS NULL OR
  NEW.action_kind IS NULL OR
  NEW.precondition_modseq IS NULL OR
  NOT EXISTS (
    SELECT 1
    FROM action_plans
    JOIN action_plan_claims
      ON action_plan_claims.plan_id = action_plans.plan_id
     AND action_plan_claims.claim_id = NEW.claim_id
    JOIN action_plan_targets
      ON action_plan_targets.plan_id = NEW.plan_id
     AND action_plan_targets.target_ordinal = NEW.target_ordinal
    WHERE action_plans.plan_id = NEW.plan_id
      AND action_plans.state = 'executing'
      AND action_plans.claim_id = NEW.claim_id
      AND action_plans.action_kind = NEW.action_kind
      AND action_plan_targets.account_id = NEW.account_id
      AND action_plan_targets.mailbox_id = NEW.mailbox_id
      AND action_plan_targets.uid_validity = NEW.uid_validity
      AND action_plan_targets.uid = NEW.uid
      AND action_plan_targets.precondition_modseq = NEW.precondition_modseq
      AND NEW.started_at >= action_plans.started_at
      AND NEW.started_at < action_plans.expires_at
  )
BEGIN
  SELECT RAISE(ABORT, 'action attempt input does not match the active plan claim and target');
END;

CREATE TRIGGER action_attempt_start_duplicate_guard
BEFORE INSERT ON action_attempts
WHEN EXISTS (
  SELECT 1
  FROM action_attempts AS prior
  WHERE prior.plan_id = NEW.plan_id
    AND prior.target_ordinal = NEW.target_ordinal
    AND NOT EXISTS (
      SELECT 1
      FROM action_results AS result
      WHERE result.attempt_id = prior.attempt_id
        AND result.plan_id = prior.plan_id
        AND result.target_ordinal = prior.target_ordinal
        AND result.certainty = 'definite'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'action target already has an unresolved attempt');
END;
`,
} satisfies Migration;

export const actionPlanAttemptMigration = actionAttemptStartMigration;

/** Dependency-complete migration set for the attempt-start boundary. */
export const actionAttemptStartMigrations = [
  ...actionPlanClaimMigrations,
  actionAttemptStartMigration,
] as const;

export const actionPlanAttemptMigrations = actionAttemptStartMigrations;
