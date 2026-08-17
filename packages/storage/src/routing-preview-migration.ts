import type { Migration } from "./migration-runner";

/**
 * The preview schema is deliberately standalone. The application migration
 * registry assigns its final contiguous position when it is composed with the
 * message, label, and routing migrations.
 */
export const ROUTING_PREVIEW_MIGRATION_VERSION = 1;

export const routingPreviewMigration = {
  version: ROUTING_PREVIEW_MIGRATION_VERSION,
  name: "routing-preview",
  sql: `
CREATE TABLE routing_previews (
  preview_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(preview_id) BETWEEN 9 AND 256
      AND substr(preview_id, 1, 8) = 'preview:'
      AND preview_id = trim(preview_id)
      AND instr(preview_id, char(0)) = 0
      AND preview_id NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND preview_id NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  scope TEXT NOT NULL
    CHECK (scope = 'mail:routing:read'),
  rule_version INTEGER NOT NULL
    CHECK (typeof(rule_version) = 'integer' AND rule_version > 0),
  rule_json TEXT NOT NULL
    CHECK (
      length(rule_json) BETWEEN 2 AND 16384
      AND json_valid(rule_json)
      AND json_type(rule_json) = 'array'
    ),
  facts_json TEXT NOT NULL
    CHECK (
      length(facts_json) BETWEEN 2 AND 8192
      AND json_valid(facts_json)
      AND json_type(facts_json) = 'object'
    ),
  provenance_json TEXT NOT NULL
    CHECK (
      length(provenance_json) BETWEEN 2 AND 4096
      AND json_valid(provenance_json)
      AND json_type(provenance_json) = 'object'
    ),
  candidate_targets_json TEXT NOT NULL
    CHECK (
      length(candidate_targets_json) BETWEEN 2 AND 262144
      AND json_valid(candidate_targets_json)
      AND json_type(candidate_targets_json) = 'array'
      AND json_array_length(candidate_targets_json) BETWEEN 1 AND 1024
    ),
  created_at TEXT NOT NULL
    CHECK (
      length(created_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    ),
  expires_at TEXT NOT NULL
    CHECK (
      length(expires_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
      AND expires_at > created_at
    ),
  nonce TEXT NOT NULL
    CHECK (
      length(nonce) BETWEEN 7 AND 512
      AND substr(nonce, 1, 6) = 'nonce:'
      AND nonce = trim(nonce)
      AND instr(nonce, char(0)) = 0
      AND nonce NOT GLOB '*[' || char(1) || '-' || char(31) || ']*'
      AND nonce NOT GLOB '*[' || char(127) || '-' || char(159) || ']*'
    ),
  digest TEXT NOT NULL
    CHECK (
      length(digest) = 64
      AND digest NOT GLOB '*[^0-9a-f]*'
    ),
  UNIQUE (digest)
);

CREATE TRIGGER routing_previews_reject_update
BEFORE UPDATE ON routing_previews
BEGIN
  SELECT RAISE(ABORT, 'routing previews are immutable');
END;

CREATE TRIGGER routing_previews_reject_delete
BEFORE DELETE ON routing_previews
BEGIN
  SELECT RAISE(ABORT, 'routing previews are immutable');
END;
`,
} satisfies Migration;

/** A standalone set is convenient for focused schema tests and composition. */
export const routingPreviewMigrations = [routingPreviewMigration] as const;
