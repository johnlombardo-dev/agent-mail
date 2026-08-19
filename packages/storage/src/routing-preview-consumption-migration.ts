import type { Migration } from "./migration-runner";
import { routingPreviewMigration } from "./routing-preview-migration";

/**
 * Adds the one-way receipt for a routing preview. The preview proposal remains
 * immutable except for this single first-consumption transition.
 */
export const ROUTING_PREVIEW_CONSUMPTION_MIGRATION_VERSION = 2;

export const routingPreviewConsumptionMigration = {
  version: ROUTING_PREVIEW_CONSUMPTION_MIGRATION_VERSION,
  name: "routing-preview-consumption",
  sql: `
ALTER TABLE routing_previews ADD COLUMN consumed_at TEXT;
ALTER TABLE routing_previews ADD COLUMN consumed_by TEXT;

DROP TRIGGER routing_previews_reject_update;

CREATE TRIGGER routing_previews_reject_update
BEFORE UPDATE ON routing_previews
WHEN
  OLD.consumed_at IS NOT NULL
  OR NEW.preview_id IS NOT OLD.preview_id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.rule_version IS NOT OLD.rule_version
  OR NEW.rule_json IS NOT OLD.rule_json
  OR NEW.facts_json IS NOT OLD.facts_json
  OR NEW.provenance_json IS NOT OLD.provenance_json
  OR NEW.candidate_targets_json IS NOT OLD.candidate_targets_json
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.nonce IS NOT OLD.nonce
  OR NEW.digest IS NOT OLD.digest
  OR NEW.consumed_at IS NULL
  OR NEW.consumed_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'routing previews are immutable except for first consumption');
END;

CREATE INDEX routing_previews_by_consumption
  ON routing_previews (consumed_at, expires_at);
`,
} satisfies Migration;

/** Compose the accepted creation schema with its one-way consumption receipt. */
export const routingPreviewConsumptionSequence = [
  routingPreviewMigration,
  { ...routingPreviewConsumptionMigration, version: 2 },
] as const;
