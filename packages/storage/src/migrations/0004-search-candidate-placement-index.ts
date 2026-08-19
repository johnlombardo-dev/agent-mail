import type { Migration } from "../migration-runner";

/** Add the account/message access path used by bounded FTS candidate ranking. */
export const SEARCH_CANDIDATE_PLACEMENT_INDEX_MIGRATION_VERSION = 1;

export const searchCandidatePlacementIndexMigration = {
  version: SEARCH_CANDIDATE_PLACEMENT_INDEX_MIGRATION_VERSION,
  name: "search-candidate-placement-index",
  sql: `
CREATE INDEX search_placements_by_account_message
  ON remote_placements (account_id, message_id, tombstone_observed_at, internal_date);
`,
} satisfies Migration;

export const searchCandidatePlacementIndexSequence = [
  searchCandidatePlacementIndexMigration,
] as const;
