import type { Migration } from "../migration-runner";

/**
 * Report creation is deliberately a database-only migration.  Identity
 * sensitive strings are BLOBs containing canonical JSON-string bytes; the
 * repository performs the strict byte round-trip checks which SQLite cannot
 * express without lossy TEXT coercion.
 */
export const reportCreationMigration = {
  version: 28,
  name: "report-creation-v1",
  sql: `
CREATE TABLE message_text_projections (
  message_id TEXT NOT NULL
    CHECK (length(message_id) = 72 AND substr(message_id, 1, 8) = 'message:' AND substr(message_id, 9) NOT GLOB '*[^0-9a-f]*'),
  projection_version INTEGER NOT NULL CHECK (typeof(projection_version) = 'integer' AND projection_version = 1),
  normalized_text_json BLOB NOT NULL CHECK (
    typeof(normalized_text_json) = 'blob' AND length(normalized_text_json) BETWEEN 2 AND 50331650 AND
    json_valid(CAST(normalized_text_json AS TEXT)) AND json_type(CAST(normalized_text_json AS TEXT)) = 'text'
  ),
  normalized_text_sha256 TEXT NOT NULL CHECK (length(normalized_text_sha256) = 64 AND normalized_text_sha256 NOT GLOB '*[^0-9a-f]*'),
  normalized_text_utf8_bytes INTEGER NOT NULL CHECK (typeof(normalized_text_utf8_bytes) = 'integer' AND normalized_text_utf8_bytes BETWEEN 0 AND 8388608),
  raw_eml_sha256 TEXT NOT NULL CHECK (length(raw_eml_sha256) = 64 AND raw_eml_sha256 NOT GLOB '*[^0-9a-f]*'),
  parser_id TEXT NOT NULL CHECK (parser_id = 'mailparser:3.9.15'),
  materialized_at TEXT NOT NULL CHECK (length(materialized_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', materialized_at) = materialized_at),
  PRIMARY KEY (message_id, projection_version),
  FOREIGN KEY (message_id) REFERENCES messages(message_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER message_text_projections_reject_duplicate_insert
BEFORE INSERT ON message_text_projections
WHEN EXISTS (SELECT 1 FROM message_text_projections WHERE message_id = NEW.message_id AND projection_version = NEW.projection_version)
BEGIN SELECT RAISE(ABORT, 'message text projections are immutable'); END;
CREATE TRIGGER message_text_projections_reject_update
BEFORE UPDATE ON message_text_projections
BEGIN SELECT RAISE(ABORT, 'message text projections are immutable'); END;
CREATE TRIGGER message_text_projections_reject_delete
BEFORE DELETE ON message_text_projections
BEGIN SELECT RAISE(ABORT, 'message text projections are immutable'); END;

CREATE TABLE reports (
  report_id TEXT PRIMARY KEY NOT NULL CHECK (length(report_id) = 71 AND substr(report_id, 1, 7) = 'report:' AND substr(report_id, 8) NOT GLOB '*[^0-9a-f]*'),
  fingerprint_sha256 TEXT NOT NULL UNIQUE CHECK (length(fingerprint_sha256) = 64 AND fingerprint_sha256 NOT GLOB '*[^0-9a-f]*' AND report_id = 'report:' || fingerprint_sha256),
  identity_material_json BLOB NOT NULL CHECK (typeof(identity_material_json) = 'blob' AND length(identity_material_json) BETWEEN 1 AND 1048576 AND json_valid(CAST(identity_material_json AS TEXT)) AND json_type(CAST(identity_material_json AS TEXT)) = 'array'),
  account_id_json BLOB NOT NULL CHECK (typeof(account_id_json) = 'blob' AND length(account_id_json) >= 3 AND json_valid(CAST(account_id_json AS TEXT)) AND json_type(CAST(account_id_json AS TEXT)) = 'text'),
  owner_principal_json BLOB NOT NULL CHECK (typeof(owner_principal_json) = 'blob' AND length(owner_principal_json) >= 3 AND json_valid(CAST(owner_principal_json AS TEXT)) AND json_type(CAST(owner_principal_json AS TEXT)) = 'text'),
  create_scope TEXT NOT NULL CHECK (create_scope = 'reports:write'),
  read_scope TEXT NOT NULL CHECK (read_scope = 'reports:read'),
  authorization_method TEXT NOT NULL CHECK (authorization_method = 'bearer'),
  authorization_request_id TEXT NOT NULL UNIQUE CHECK (length(authorization_request_id) = 72 AND substr(authorization_request_id, 1, 8) = 'request:' AND substr(authorization_request_id, 9) NOT GLOB '*[^0-9a-f]*'),
  authorization_at TEXT NOT NULL CHECK (length(authorization_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', authorization_at) = authorization_at),
  request_body_sha256 TEXT NOT NULL CHECK (length(request_body_sha256) = 64 AND request_body_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at AND created_at = authorization_at),
  title_json BLOB NOT NULL CHECK (typeof(title_json) = 'blob' AND length(title_json) >= 3 AND json_valid(CAST(title_json AS TEXT)) AND json_type(CAST(title_json AS TEXT)) = 'text'),
  metadata_json BLOB NOT NULL CHECK (typeof(metadata_json) = 'blob' AND length(metadata_json) >= 2 AND length(metadata_json) <= 1048576 AND json_valid(CAST(metadata_json AS TEXT)) AND json_type(CAST(metadata_json AS TEXT)) = 'array'),
  source_count INTEGER NOT NULL CHECK (typeof(source_count) = 'integer' AND source_count BETWEEN 1 AND 100),
  UNIQUE (report_id, owner_principal_json, account_id_json)
) STRICT;

CREATE TRIGGER reports_reject_duplicate_insert
BEFORE INSERT ON reports
WHEN EXISTS (SELECT 1 FROM reports WHERE report_id = NEW.report_id OR fingerprint_sha256 = NEW.fingerprint_sha256 OR authorization_request_id = NEW.authorization_request_id)
BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
CREATE TRIGGER reports_reject_update
BEFORE UPDATE ON reports
BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
CREATE TRIGGER reports_reject_delete
BEFORE DELETE ON reports
BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
CREATE TRIGGER reports_require_complete_graph
BEFORE INSERT ON reports
WHEN NOT EXISTS (SELECT 1 FROM report_artifacts WHERE report_id = NEW.report_id)
  OR (SELECT COUNT(*) FROM report_sources WHERE report_id = NEW.report_id) <> NEW.source_count
  OR EXISTS (SELECT 1 FROM report_sources WHERE report_id = NEW.report_id AND (ordinal < 1 OR ordinal > NEW.source_count))
BEGIN SELECT RAISE(ABORT, 'report publication graph is incomplete'); END;

CREATE TABLE report_artifacts (
  report_id TEXT PRIMARY KEY NOT NULL CHECK (length(report_id) = 71 AND substr(report_id, 1, 7) = 'report:' AND substr(report_id, 8) NOT GLOB '*[^0-9a-f]*'),
  model_version INTEGER NOT NULL CHECK (typeof(model_version) = 'integer' AND model_version = 1),
  projection_version INTEGER NOT NULL CHECK (typeof(projection_version) = 'integer' AND projection_version = 1),
  renderer_version INTEGER NOT NULL CHECK (typeof(renderer_version) = 'integer' AND renderer_version = 1),
  model_json BLOB NOT NULL CHECK (typeof(model_json) = 'blob' AND length(model_json) BETWEEN 1 AND 1048576 AND json_valid(CAST(model_json AS TEXT)) AND json_type(CAST(model_json AS TEXT)) = 'object'),
  model_sha256 TEXT NOT NULL CHECK (length(model_sha256) = 64 AND model_sha256 NOT GLOB '*[^0-9a-f]*'),
  markdown_sha256 TEXT NOT NULL CHECK (length(markdown_sha256) = 64 AND markdown_sha256 NOT GLOB '*[^0-9a-f]*'),
  html_sha256 TEXT NOT NULL CHECK (length(html_sha256) = 64 AND html_sha256 NOT GLOB '*[^0-9a-f]*'),
  csp_sha256 TEXT NOT NULL CHECK (length(csp_sha256) = 64 AND csp_sha256 NOT GLOB '*[^0-9a-f]*'),
  model_bytes INTEGER NOT NULL CHECK (typeof(model_bytes) = 'integer' AND model_bytes BETWEEN 1 AND 1048576),
  markdown_bytes INTEGER NOT NULL CHECK (typeof(markdown_bytes) = 'integer' AND markdown_bytes BETWEEN 1 AND 16777216),
  html_bytes INTEGER NOT NULL CHECK (typeof(html_bytes) = 'integer' AND html_bytes BETWEEN 1 AND 16777216),
  FOREIGN KEY (report_id) REFERENCES reports(report_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER report_artifacts_reject_duplicate_insert
BEFORE INSERT ON report_artifacts
WHEN EXISTS (SELECT 1 FROM report_artifacts WHERE report_id = NEW.report_id)
BEGIN SELECT RAISE(ABORT, 'report artifacts are immutable'); END;
CREATE TRIGGER report_artifacts_reject_update
BEFORE UPDATE ON report_artifacts
BEGIN SELECT RAISE(ABORT, 'report artifacts are immutable'); END;
CREATE TRIGGER report_artifacts_reject_delete
BEFORE DELETE ON report_artifacts
BEGIN SELECT RAISE(ABORT, 'report artifacts are immutable'); END;

CREATE TABLE report_source_snapshots (
  owner_principal_json BLOB NOT NULL CHECK (typeof(owner_principal_json) = 'blob' AND length(owner_principal_json) >= 3 AND json_valid(CAST(owner_principal_json AS TEXT)) AND json_type(CAST(owner_principal_json AS TEXT)) = 'text'),
  account_id_json BLOB NOT NULL CHECK (typeof(account_id_json) = 'blob' AND length(account_id_json) >= 3 AND json_valid(CAST(account_id_json AS TEXT)) AND json_type(CAST(account_id_json AS TEXT)) = 'text'),
  message_id TEXT NOT NULL CHECK (length(message_id) = 72 AND substr(message_id, 1, 8) = 'message:' AND substr(message_id, 9) NOT GLOB '*[^0-9a-f]*'),
  projection_version INTEGER NOT NULL CHECK (typeof(projection_version) = 'integer' AND projection_version = 1),
  source_text_json BLOB NOT NULL CHECK (typeof(source_text_json) = 'blob' AND length(source_text_json) BETWEEN 2 AND 50331650 AND json_valid(CAST(source_text_json AS TEXT)) AND json_type(CAST(source_text_json AS TEXT)) = 'text'),
  source_text_sha256 TEXT NOT NULL CHECK (length(source_text_sha256) = 64 AND source_text_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_text_bytes INTEGER NOT NULL CHECK (typeof(source_text_bytes) = 'integer' AND source_text_bytes BETWEEN 1 AND 10485760),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  PRIMARY KEY (owner_principal_json, account_id_json, message_id, projection_version),
  UNIQUE (owner_principal_json, account_id_json, message_id, projection_version, source_text_sha256),
  FOREIGN KEY (message_id) REFERENCES messages(message_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER report_source_snapshots_reject_duplicate_insert
BEFORE INSERT ON report_source_snapshots
WHEN EXISTS (SELECT 1 FROM report_source_snapshots WHERE owner_principal_json = NEW.owner_principal_json AND account_id_json = NEW.account_id_json AND message_id = NEW.message_id AND projection_version = NEW.projection_version) OR EXISTS (SELECT 1 FROM report_source_snapshots WHERE owner_principal_json = NEW.owner_principal_json AND account_id_json = NEW.account_id_json AND message_id = NEW.message_id AND projection_version = NEW.projection_version AND source_text_sha256 = NEW.source_text_sha256)
BEGIN SELECT RAISE(ABORT, 'report source snapshots are immutable'); END;
CREATE TRIGGER report_source_snapshots_require_link
BEFORE INSERT ON report_source_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM report_sources
  WHERE owner_principal_json = NEW.owner_principal_json AND account_id_json = NEW.account_id_json
    AND message_id = NEW.message_id AND projection_version = NEW.projection_version
    AND source_text_sha256 = NEW.source_text_sha256
)
BEGIN SELECT RAISE(ABORT, 'report source snapshot requires a report link'); END;
CREATE TRIGGER report_source_snapshots_reject_update
BEFORE UPDATE ON report_source_snapshots
BEGIN SELECT RAISE(ABORT, 'report source snapshots are immutable'); END;
CREATE TRIGGER report_source_snapshots_reject_delete
BEFORE DELETE ON report_source_snapshots
BEGIN SELECT RAISE(ABORT, 'report source snapshots are immutable'); END;

CREATE TABLE report_sources (
  report_id TEXT NOT NULL CHECK (length(report_id) = 71 AND substr(report_id, 1, 7) = 'report:' AND substr(report_id, 8) NOT GLOB '*[^0-9a-f]*'),
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 1 AND 100),
  owner_principal_json BLOB NOT NULL CHECK (typeof(owner_principal_json) = 'blob' AND length(owner_principal_json) >= 3 AND json_valid(CAST(owner_principal_json AS TEXT)) AND json_type(CAST(owner_principal_json AS TEXT)) = 'text'),
  account_id_json BLOB NOT NULL CHECK (typeof(account_id_json) = 'blob' AND length(account_id_json) >= 3 AND json_valid(CAST(account_id_json AS TEXT)) AND json_type(CAST(account_id_json AS TEXT)) = 'text'),
  message_id TEXT NOT NULL CHECK (length(message_id) = 72 AND substr(message_id, 1, 8) = 'message:' AND substr(message_id, 9) NOT GLOB '*[^0-9a-f]*'),
  projection_version INTEGER NOT NULL CHECK (typeof(projection_version) = 'integer' AND projection_version = 1),
  citation_label TEXT NOT NULL CHECK (citation_label = 'Source ' || ordinal),
  source_text_sha256 TEXT NOT NULL CHECK (length(source_text_sha256) = 64 AND source_text_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (report_id, ordinal),
  UNIQUE (report_id, message_id),
  FOREIGN KEY (report_id, owner_principal_json, account_id_json) REFERENCES reports(report_id, owner_principal_json, account_id_json) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_principal_json, account_id_json, message_id, projection_version, source_text_sha256) REFERENCES report_source_snapshots(owner_principal_json, account_id_json, message_id, projection_version, source_text_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER report_sources_reject_duplicate_insert
BEFORE INSERT ON report_sources
WHEN EXISTS (SELECT 1 FROM report_sources WHERE report_id = NEW.report_id AND ordinal = NEW.ordinal) OR EXISTS (SELECT 1 FROM report_sources WHERE report_id = NEW.report_id AND message_id = NEW.message_id)
BEGIN SELECT RAISE(ABORT, 'report sources are immutable'); END;
CREATE TRIGGER report_sources_reject_update
BEFORE UPDATE ON report_sources
BEGIN SELECT RAISE(ABORT, 'report sources are immutable'); END;
CREATE TRIGGER report_sources_reject_delete
BEFORE DELETE ON report_sources
BEGIN SELECT RAISE(ABORT, 'report sources are immutable'); END;

CREATE INDEX reports_owner_account_created ON reports(owner_principal_json, account_id_json, created_at, report_id);
CREATE INDEX report_snapshots_owner_account_bytes ON report_source_snapshots(owner_principal_json, account_id_json, source_text_bytes, message_id);
CREATE INDEX report_sources_snapshot_lookup ON report_sources(owner_principal_json, account_id_json, message_id, projection_version, source_text_sha256, report_id);

CREATE TABLE report_create_rate_windows (
  principal_json BLOB PRIMARY KEY NOT NULL CHECK (typeof(principal_json) = 'blob' AND length(principal_json) >= 3 AND json_valid(CAST(principal_json AS TEXT)) AND json_type(CAST(principal_json AS TEXT)) = 'text'),
  attempts_json BLOB NOT NULL CHECK (typeof(attempts_json) = 'blob' AND length(attempts_json) >= 2 AND json_valid(CAST(attempts_json AS TEXT)) AND json_type(CAST(attempts_json AS TEXT)) = 'array'),
  last_observed_at TEXT NOT NULL CHECK (length(last_observed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at) = last_observed_at)
) STRICT;
CREATE TRIGGER report_create_rate_windows_no_delete
BEFORE DELETE ON report_create_rate_windows
BEGIN SELECT RAISE(ABORT, 'report rate windows are retained'); END;
`,
} satisfies Migration;

export const reportCreationSequence = [reportCreationMigration] as const;
