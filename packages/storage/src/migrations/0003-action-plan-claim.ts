import type { Migration } from "../migration-runner";
import { actionPlanProposalSequence } from "./0002-action-plan-proposal";

/** Adds the optimistic version used by the atomic claim transaction. */
export const actionPlanClaimMigration = {
  version: 3,
  name: "action-plan-claim-version",
  sql: `
ALTER TABLE action_plans ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (
  typeof(version) = 'integer' AND version > 0
);
`,
} satisfies Migration;

export const actionPlanClaimSequence = [
  ...actionPlanProposalSequence,
  actionPlanClaimMigration,
] as const;
