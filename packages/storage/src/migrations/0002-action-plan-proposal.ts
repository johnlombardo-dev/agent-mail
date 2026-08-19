import type { Migration } from "../migration-runner";
import { actionSchemaMigration } from "./0001-action-schema";

/**
 * Proposal evidence is a standalone extension of the accepted action schema.
 * The application migration registry assigns its final contiguous position
 * when all parallel migrations are composed.
 */
export const ACTION_PLAN_PROPOSAL_MIGRATION_VERSION = 2;

export const actionPlanProposalMigration = {
  version: ACTION_PLAN_PROPOSAL_MIGRATION_VERSION,
  name: "action-plan-proposal-evidence",
  sql: `
CREATE TABLE action_plan_proposals (
  plan_id TEXT PRIMARY KEY NOT NULL
    REFERENCES action_plans(plan_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  preview_digest TEXT NOT NULL CHECK (
    typeof(preview_digest) = 'text' AND
    length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_scope TEXT NOT NULL CHECK (
    typeof(authorization_scope) = 'text' AND
    length(CAST(authorization_scope AS BLOB)) BETWEEN 1 AND 256 AND
    length(trim(authorization_scope)) = length(authorization_scope) AND
    instr(authorization_scope, char(0)) = 0 AND
    authorization_scope NOT GLOB '*[' || char(1) || '-' || char(31) || ']*' AND
    authorization_scope NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
  ),
  idempotency_identity TEXT NOT NULL CHECK (
    typeof(idempotency_identity) = 'text' AND
    length(CAST(idempotency_identity AS BLOB)) BETWEEN 1 AND 256 AND
    length(trim(idempotency_identity)) = length(idempotency_identity) AND
    instr(idempotency_identity, char(0)) = 0 AND
    idempotency_identity NOT GLOB '*[' || char(1) || '-' || char(31) || ']*' AND
    idempotency_identity NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
  ),
  proposal_bytes TEXT NOT NULL CHECK (
    typeof(proposal_bytes) = 'text' AND
    length(CAST(proposal_bytes AS BLOB)) BETWEEN 2 AND 1048576 AND
    json_valid(proposal_bytes) AND json_type(proposal_bytes) = 'array'
  ),
  UNIQUE (idempotency_identity)
);

CREATE TRIGGER action_plan_proposal_target_insert_guard
BEFORE INSERT ON action_plan_targets
WHEN EXISTS (SELECT 1 FROM action_plan_proposals WHERE plan_id = NEW.plan_id)
BEGIN
  SELECT RAISE(ABORT, 'pending action plan targets are immutable');
END;

CREATE TRIGGER action_plan_proposal_target_delete_guard
BEFORE DELETE ON action_plan_targets
WHEN EXISTS (SELECT 1 FROM action_plan_proposals WHERE plan_id = OLD.plan_id)
BEGIN
  SELECT RAISE(ABORT, 'pending action plan targets are immutable');
END;

CREATE TRIGGER action_plan_proposal_metadata_update_guard
BEFORE UPDATE ON action_plan_proposals
BEGIN
  SELECT RAISE(ABORT, 'pending action plan proposal is immutable');
END;

CREATE TRIGGER action_plan_proposal_metadata_delete_guard
BEFORE DELETE ON action_plan_proposals
BEGIN
  SELECT RAISE(ABORT, 'pending action plan proposal is immutable');
END;
`,
} satisfies Migration;

/** The extension alone is retained for the eventual application registry. */
export const actionPlanProposalExtensionSequence = [actionPlanProposalMigration] as const;

/** Dependency-complete composition for focused repository tests. */
export const actionPlanProposalSequence = [
  actionSchemaMigration,
  actionPlanProposalMigration,
] as const;
