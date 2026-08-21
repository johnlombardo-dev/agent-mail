import type { Migration } from "../migration-runner";

/**
 * Repair the v10 approval guard without rewriting an applied migration.
 *
 * Policy A deliberately permits the plan creator and the human approver to be
 * different principals.  The creator row is still required as durable
 * provenance, but its auth event is not the approver's fresh presence event.
 */
export const approvalCreatorProvenanceRepairMigration = {
  version: 29,
  name: "approval-creator-provenance-repair",
  sql: `
DROP TRIGGER IF EXISTS authority_v10_approval_creator_exact_guard;

CREATE TRIGGER authority_v11_approval_creator_provenance_guard
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM action_plans p
  JOIN action_plan_authority_versions v ON v.plan_id = p.plan_id
    AND v.authority_version = 'trusted-v1'
  JOIN action_plan_creators cr ON cr.plan_id = p.plan_id
  WHERE p.plan_id = NEW.plan_id
    AND p.state = 'pending'
    AND p.version = NEW.plan_version
)
BEGIN SELECT RAISE(ABORT, 'approval creator provenance is not trusted'); END;
`,
} satisfies Migration;

export const approvalCreatorProvenanceRepairSequence = [
  approvalCreatorProvenanceRepairMigration,
] as const;
