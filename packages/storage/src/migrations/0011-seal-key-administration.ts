import type { Migration } from "../migration-runner";

/**
 * D28 is an extension of the already-applied authority schema. The v9 bytes
 * remain immutable; this rebuild adds ADMIN challenge operations and the
 * matching seal-key output kinds to files that already reached v10.
 */
export const sealKeyAdministrationMigration = {
  version: 11,
  name: "seal-key-administration-authority",
  requiresForeignKeysOff: true,
  sql: `
/* The predecessor migrations attach these trigger names to the tables being
 * rebuilt.  Drop them before the rename so the new tables receive the
 * upgraded definitions instead of leaving guards attached to *_v10. */
DROP TRIGGER IF EXISTS authority_challenge_immutable_update;
DROP TRIGGER IF EXISTS authority_challenge_immutable_delete;
DROP TRIGGER IF EXISTS authority_challenge_consumption_immutable_update;
DROP TRIGGER IF EXISTS authority_challenge_consumption_immutable_delete;
DROP TRIGGER IF EXISTS authority_challenge_expiration_immutable_update;
DROP TRIGGER IF EXISTS authority_challenge_expiration_immutable_delete;
DROP TRIGGER IF EXISTS authority_challenge_invalidation_immutable_update;
DROP TRIGGER IF EXISTS authority_challenge_invalidation_immutable_delete;
DROP TRIGGER IF EXISTS authority_challenge_consumption_single_closure;
DROP TRIGGER IF EXISTS authority_challenge_expiration_single_closure;
DROP TRIGGER IF EXISTS authority_challenge_invalidation_single_closure;
DROP TRIGGER IF EXISTS authority_challenge_consumption_binding;
DROP TRIGGER IF EXISTS authority_challenge_consumption_output;
DROP TRIGGER IF EXISTS authority_challenge_commitment_shape_guard;
DROP TRIGGER IF EXISTS authority_v10_challenge_consumption_exact_guard;
DROP TRIGGER IF EXISTS authority_v10_terminal_receipt_exact_guard;
ALTER TABLE operator_presence_challenge_consumptions RENAME TO operator_presence_challenge_consumptions_v10;
ALTER TABLE operator_presence_challenges RENAME TO operator_presence_challenges_v10;
ALTER TABLE operator_presence_challenge_expirations RENAME TO operator_presence_challenge_expirations_v10;
ALTER TABLE operator_presence_challenge_invalidations RENAME TO operator_presence_challenge_invalidations_v10;

CREATE TABLE operator_presence_challenges (
  challenge_id TEXT PRIMARY KEY NOT NULL CHECK (challenge_id GLOB 'operator-challenge:*'),
  authority_instance_id TEXT NOT NULL,
  operator_configuration_revision INTEGER NOT NULL CHECK (operator_configuration_revision > 0),
  challenge_nonce_base64url TEXT NOT NULL UNIQUE CHECK (length(challenge_nonce_base64url) = 43 AND challenge_nonce_base64url NOT GLOB '*[^A-Za-z0-9_-]*'),
  credential_id TEXT NOT NULL,
  principal_id TEXT NOT NULL CHECK (principal_id = 'principal:local-operator'),
  profile TEXT NOT NULL CHECK (profile = 'operator-interactive'),
  operation TEXT NOT NULL CHECK (operation IN ('open-session', 'approve', 'cancel-approval', 'seal-key-rotate', 'seal-key-remove')),
  request_method TEXT NOT NULL CHECK (request_method IN ('POST', 'DELETE', 'ADMIN')),
  request_path TEXT NOT NULL,
  request_body_sha256 TEXT NOT NULL CHECK (length(request_body_sha256) = 64 AND request_body_sha256 NOT GLOB '*[^0-9a-f]*'),
  operator_display_code TEXT NOT NULL CHECK (operator_display_code GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  challenge_commitment TEXT NOT NULL,
  challenge_commitment_sha256 TEXT NOT NULL CHECK (length(challenge_commitment_sha256) = 64 AND challenge_commitment_sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (length(issued_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) = issued_at AND length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at AND ROUND((julianday(expires_at) - julianday(issued_at)) * 86400000.0) = 60000),
  CHECK ((operation = 'approve' AND request_method = 'POST') OR
         (operation = 'cancel-approval' AND request_method = 'DELETE') OR
         (operation = 'open-session' AND request_method = 'POST') OR
         ((operation = 'seal-key-rotate' OR operation = 'seal-key-remove') AND request_method = 'ADMIN'))
) STRICT;

INSERT INTO operator_presence_challenges
SELECT challenge_id, authority_instance_id, operator_configuration_revision,
  challenge_nonce_base64url, credential_id, principal_id, profile, operation,
  request_method, request_path, request_body_sha256, operator_display_code,
  challenge_commitment, challenge_commitment_sha256, issued_at, expires_at
FROM operator_presence_challenges_v10;

CREATE TABLE operator_presence_challenge_consumptions (
  challenge_id TEXT PRIMARY KEY NOT NULL REFERENCES operator_presence_challenges(challenge_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  consumed_at TEXT NOT NULL CHECK (length(consumed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) = consumed_at),
  operation TEXT NOT NULL CHECK (operation IN ('open-session', 'approve', 'cancel-approval', 'seal-key-rotate', 'seal-key-remove')),
  authority_output_kind TEXT NOT NULL CHECK (authority_output_kind IN ('operator-session', 'approval', 'cancellation', 'seal-key-rotation', 'seal-key-removal')),
  authority_output_id TEXT NOT NULL,
  signature_p1363_base64url TEXT NOT NULL CHECK (length(signature_p1363_base64url) = 86 AND signature_p1363_base64url NOT GLOB '*[^A-Za-z0-9_-]*'),
  signature_sha256 TEXT NOT NULL CHECK (length(signature_sha256) = 64 AND signature_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK ((operation = 'open-session' AND authority_output_kind = 'operator-session' AND authority_output_id GLOB 'operator-session:*') OR
         (operation = 'approve' AND authority_output_kind = 'approval' AND authority_output_id GLOB 'approval:*') OR
         (operation = 'cancel-approval' AND authority_output_kind = 'cancellation' AND authority_output_id GLOB 'approval:*') OR
         (operation = 'seal-key-rotate' AND authority_output_kind = 'seal-key-rotation' AND authority_output_id GLOB 'seal-keyring-revision:[1-9]*' AND substr(authority_output_id, 23) NOT GLOB '*[^0-9]*') OR
         (operation = 'seal-key-remove' AND authority_output_kind = 'seal-key-removal' AND authority_output_id GLOB 'seal-keyring-revision:[1-9]*' AND substr(authority_output_id, 23) NOT GLOB '*[^0-9]*'))
) STRICT;

INSERT INTO operator_presence_challenge_consumptions SELECT * FROM operator_presence_challenge_consumptions_v10;

CREATE TABLE operator_presence_challenge_expirations (
  challenge_id TEXT PRIMARY KEY NOT NULL REFERENCES operator_presence_challenges(challenge_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  expired_at TEXT NOT NULL CHECK (length(expired_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expired_at) = expired_at)
) STRICT;

INSERT INTO operator_presence_challenge_expirations SELECT * FROM operator_presence_challenge_expirations_v10;

CREATE TABLE operator_presence_challenge_invalidations (
  challenge_id TEXT PRIMARY KEY NOT NULL REFERENCES operator_presence_challenges(challenge_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  invalidated_at TEXT NOT NULL CHECK (length(invalidated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('credential-revoked', 'instance-mismatch', 'database-restore', 'configuration-change'))
) STRICT;

INSERT INTO operator_presence_challenge_invalidations SELECT * FROM operator_presence_challenge_invalidations_v10;

DROP TABLE operator_presence_challenge_consumptions_v10;
DROP TABLE operator_presence_challenge_expirations_v10;
DROP TABLE operator_presence_challenge_invalidations_v10;
DROP TABLE operator_presence_challenges_v10;

CREATE TRIGGER authority_challenge_immutable_update
BEFORE UPDATE ON operator_presence_challenges
BEGIN SELECT RAISE(ABORT, 'operator presence challenge is immutable'); END;
CREATE TRIGGER authority_challenge_immutable_delete
BEFORE DELETE ON operator_presence_challenges
BEGIN SELECT RAISE(ABORT, 'operator presence challenge is immutable'); END;
CREATE TRIGGER authority_challenge_consumption_immutable_update
BEFORE UPDATE ON operator_presence_challenge_consumptions
BEGIN SELECT RAISE(ABORT, 'operator presence challenge consumption is immutable'); END;
CREATE TRIGGER authority_challenge_consumption_immutable_delete
BEFORE DELETE ON operator_presence_challenge_consumptions
BEGIN SELECT RAISE(ABORT, 'operator presence challenge consumption is immutable'); END;
CREATE TRIGGER authority_challenge_expiration_immutable_update
BEFORE UPDATE ON operator_presence_challenge_expirations
BEGIN SELECT RAISE(ABORT, 'operator presence challenge expiration is immutable'); END;
CREATE TRIGGER authority_challenge_expiration_immutable_delete
BEFORE DELETE ON operator_presence_challenge_expirations
BEGIN SELECT RAISE(ABORT, 'operator presence challenge expiration is immutable'); END;
CREATE TRIGGER authority_challenge_invalidation_immutable_update
BEFORE UPDATE ON operator_presence_challenge_invalidations
BEGIN SELECT RAISE(ABORT, 'operator presence challenge invalidation is immutable'); END;
CREATE TRIGGER authority_challenge_invalidation_immutable_delete
BEFORE DELETE ON operator_presence_challenge_invalidations
BEGIN SELECT RAISE(ABORT, 'operator presence challenge invalidation is immutable'); END;

CREATE TRIGGER authority_challenge_consumption_single_closure
BEFORE INSERT ON operator_presence_challenge_consumptions
WHEN EXISTS (SELECT 1 FROM operator_presence_challenge_expirations WHERE challenge_id = NEW.challenge_id)
  OR EXISTS (SELECT 1 FROM operator_presence_challenge_invalidations WHERE challenge_id = NEW.challenge_id)
BEGIN SELECT RAISE(ABORT, 'operator presence challenge is already closed'); END;
CREATE TRIGGER authority_challenge_expiration_single_closure
BEFORE INSERT ON operator_presence_challenge_expirations
WHEN EXISTS (SELECT 1 FROM operator_presence_challenge_consumptions WHERE challenge_id = NEW.challenge_id)
  OR EXISTS (SELECT 1 FROM operator_presence_challenge_invalidations WHERE challenge_id = NEW.challenge_id)
BEGIN SELECT RAISE(ABORT, 'operator presence challenge is already closed'); END;
CREATE TRIGGER authority_challenge_invalidation_single_closure
BEFORE INSERT ON operator_presence_challenge_invalidations
WHEN EXISTS (SELECT 1 FROM operator_presence_challenge_consumptions WHERE challenge_id = NEW.challenge_id)
  OR EXISTS (SELECT 1 FROM operator_presence_challenge_expirations WHERE challenge_id = NEW.challenge_id)
BEGIN SELECT RAISE(ABORT, 'operator presence challenge is already closed'); END;

CREATE TRIGGER authority_challenge_consumption_binding
BEFORE INSERT ON operator_presence_challenge_consumptions
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  WHERE c.challenge_id = NEW.challenge_id AND c.operation = NEW.operation
    AND ((NEW.operation IN ('approve', 'open-session') AND c.request_method = 'POST') OR
         (NEW.operation = 'cancel-approval' AND c.request_method = 'DELETE') OR
         (NEW.operation IN ('seal-key-rotate', 'seal-key-remove') AND c.request_method = 'ADMIN'))
)
BEGIN SELECT RAISE(ABORT, 'operator presence challenge operation binding mismatch'); END;

CREATE TRIGGER authority_challenge_consumption_output
BEFORE INSERT ON operator_presence_challenge_consumptions
WHEN (NEW.operation = 'approve' AND NOT EXISTS (SELECT 1 FROM action_approvals WHERE approval_id = NEW.authority_output_id AND ceremony_id = NEW.challenge_id))
  OR (NEW.operation = 'cancel-approval' AND NOT EXISTS (SELECT 1 FROM action_approval_cancellations WHERE approval_id = NEW.authority_output_id AND ceremony_id = NEW.challenge_id))
  OR (NEW.operation = 'seal-key-rotate' AND (NEW.authority_output_kind <> 'seal-key-rotation' OR NEW.authority_output_id NOT GLOB 'seal-keyring-revision:[1-9]*' OR substr(NEW.authority_output_id, 23) GLOB '*[^0-9]*'))
  OR (NEW.operation = 'seal-key-remove' AND (NEW.authority_output_kind <> 'seal-key-removal' OR NEW.authority_output_id NOT GLOB 'seal-keyring-revision:[1-9]*' OR substr(NEW.authority_output_id, 23) GLOB '*[^0-9]*'))
BEGIN SELECT RAISE(ABORT, 'operator presence challenge output mismatch'); END;

CREATE TRIGGER authority_v10_challenge_consumption_exact_guard
BEFORE INSERT ON operator_presence_challenge_consumptions
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  WHERE c.challenge_id = NEW.challenge_id
    AND c.operation = NEW.operation
    AND (
      (NEW.operation = 'open-session' AND NEW.authority_output_kind = 'operator-session' AND NEW.authority_output_id GLOB 'operator-session:*') OR
      (NEW.operation = 'approve' AND NEW.authority_output_kind = 'approval' AND EXISTS (
        SELECT 1 FROM action_approvals a
        WHERE a.approval_id = NEW.authority_output_id AND a.ceremony_id = c.challenge_id
          AND a.authority_instance_id = c.authority_instance_id
          AND a.operator_configuration_revision = c.operator_configuration_revision
          AND a.approver_credential_id = c.credential_id
          AND a.approver_principal_id = c.principal_id AND a.approver_profile = c.profile
          AND a.presence_request_method = c.request_method AND a.presence_request_path = c.request_path
          AND a.presence_request_body_sha256 = c.request_body_sha256
          AND a.operator_display_code = c.operator_display_code
          AND a.challenge_commitment_sha256 = c.challenge_commitment_sha256
      )) OR
      (NEW.operation = 'cancel-approval' AND NEW.authority_output_kind = 'cancellation' AND EXISTS (
        SELECT 1 FROM action_approval_cancellations x
        WHERE x.approval_id = NEW.authority_output_id AND x.ceremony_id = c.challenge_id
          AND x.authority_instance_id = c.authority_instance_id
          AND x.operator_configuration_revision = c.operator_configuration_revision
          AND x.canceller_credential_id = c.credential_id
          AND x.canceller_principal_id = c.principal_id AND x.canceller_profile = c.profile
          AND x.presence_request_method = c.request_method AND x.presence_request_path = c.request_path
          AND x.presence_request_body_sha256 = c.request_body_sha256
          AND x.operator_display_code = c.operator_display_code
          AND x.challenge_commitment_sha256 = c.challenge_commitment_sha256
      )) OR
      (NEW.operation IN ('seal-key-rotate', 'seal-key-remove')
        AND NEW.authority_output_kind IN ('seal-key-rotation', 'seal-key-removal')
        AND NEW.authority_output_id GLOB 'seal-keyring-revision:[1-9]*'
        AND substr(NEW.authority_output_id, 23) NOT GLOB '*[^0-9]*')
    )
)
BEGIN SELECT RAISE(ABORT, 'challenge consumption output is not bound'); END;

CREATE TRIGGER authority_challenge_commitment_shape_guard
BEFORE INSERT ON operator_presence_challenges
WHEN length(CAST(NEW.challenge_commitment AS BLOB)) NOT BETWEEN 2 AND 4096
  OR json_valid(NEW.challenge_commitment) <> 1
  OR json(NEW.challenge_commitment) <> NEW.challenge_commitment
  OR json_type(NEW.challenge_commitment) <> 'array'
  OR json_array_length(NEW.challenge_commitment) <> 15
  OR json_extract(NEW.challenge_commitment, '$[0]') <> 'agent-mail-operator-challenge-v1'
  OR json_extract(NEW.challenge_commitment, '$[1]') <> NEW.authority_instance_id
  OR json_extract(NEW.challenge_commitment, '$[2]') <> NEW.challenge_id
  OR json_extract(NEW.challenge_commitment, '$[3]') <> NEW.challenge_nonce_base64url
  OR json_extract(NEW.challenge_commitment, '$[4]') <> NEW.credential_id
  OR json_extract(NEW.challenge_commitment, '$[5]') <> NEW.principal_id
  OR json_extract(NEW.challenge_commitment, '$[6]') <> NEW.profile
  OR json_extract(NEW.challenge_commitment, '$[7]') <> NEW.operation
  OR json_extract(NEW.challenge_commitment, '$[8]') <> NEW.request_method
  OR json_extract(NEW.challenge_commitment, '$[9]') <> NEW.request_path
  OR json_extract(NEW.challenge_commitment, '$[10]') <> NEW.request_body_sha256
  OR json_extract(NEW.challenge_commitment, '$[11]') <> NEW.operator_display_code
  OR json_extract(NEW.challenge_commitment, '$[12]') <> NEW.operator_configuration_revision
  OR json_extract(NEW.challenge_commitment, '$[13]') <> NEW.issued_at
  OR json_extract(NEW.challenge_commitment, '$[14]') <> NEW.expires_at
  OR ROUND((julianday(NEW.expires_at) - julianday(NEW.issued_at)) * 86400000.0) <> 60000
BEGIN SELECT RAISE(ABORT, 'operator challenge commitment is not canonical'); END;

/* D29 extends the unaccepted v11 schema with an immutable effect projection
 * and a distinct, non-authorizing finalizer identity. */
CREATE TRIGGER authority_d29_attempt_authority_shape_guard
BEFORE INSERT ON action_attempt_authorities
WHEN NEW.executor_profile <> 'internal-action-executor'
  OR NEW.executor_instance_id NOT GLOB 'executor:*'
  OR length(NEW.executor_instance_id) NOT BETWEEN 10 AND 256
  OR NEW.attempt_id NOT GLOB 'attempt:*'
  OR length(NEW.attempt_id) NOT BETWEEN 8 AND 256
BEGIN SELECT RAISE(ABORT, 'attempt authority identity is invalid'); END;

ALTER TABLE action_plan_terminal_audit
  ADD COLUMN effect_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (effect_attempt_count >= 0);
ALTER TABLE action_plan_terminal_audit
  ADD COLUMN effect_authority_set_digest TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (length(effect_authority_set_digest) = 64 AND effect_authority_set_digest NOT GLOB '*[^0-9a-f]*');
ALTER TABLE action_plan_terminal_audit
  ADD COLUMN finalizer_kind TEXT NOT NULL DEFAULT 'effect-executor'
    CHECK (finalizer_kind IN ('effect-executor', 'ordinary-recovery', 'restore-admission'));
ALTER TABLE action_plan_terminal_audit
  ADD COLUMN finalizer_instance_id TEXT NOT NULL DEFAULT 'executor:legacy-migration'
    CHECK (length(finalizer_instance_id) BETWEEN 1 AND 256);

CREATE TRIGGER authority_d29_terminal_effect_projection_guard
BEFORE INSERT ON action_plan_terminal_audit
WHEN NEW.effect_attempt_count <> (
       SELECT COUNT(*) FROM action_attempt_authorities a
       WHERE a.plan_id = NEW.plan_id AND a.receipt_id = NEW.receipt_id AND a.claim_id = NEW.claim_id
     )
  OR (NEW.executor_disposition = 'started' AND NEW.effect_attempt_count = 0)
  OR (NEW.executor_disposition = 'never-started-after-restore' AND NEW.effect_attempt_count <> 0)
  OR (NEW.effect_attempt_count > 0 AND NEW.executor_instance_id <> CASE
       WHEN (SELECT COUNT(DISTINCT a.executor_instance_id) FROM action_attempt_authorities a
             WHERE a.plan_id = NEW.plan_id AND a.receipt_id = NEW.receipt_id AND a.claim_id = NEW.claim_id) = 1
       THEN (SELECT MIN(a.executor_instance_id) FROM action_attempt_authorities a
             WHERE a.plan_id = NEW.plan_id AND a.receipt_id = NEW.receipt_id AND a.claim_id = NEW.claim_id)
       ELSE 'executor:multiple'
     END)
  OR (NEW.finalizer_kind = 'effect-executor' AND (NEW.finalizer_instance_id NOT GLOB 'executor:*' OR NOT EXISTS (
       SELECT 1 FROM action_attempt_authorities a
       WHERE a.plan_id = NEW.plan_id AND a.receipt_id = NEW.receipt_id
         AND a.claim_id = NEW.claim_id AND a.executor_instance_id = NEW.finalizer_instance_id
     )))
  OR (NEW.finalizer_kind = 'ordinary-recovery' AND NEW.finalizer_instance_id NOT GLOB 'recovery-finalizer:*')
  OR (NEW.finalizer_kind = 'restore-admission' AND NEW.finalizer_instance_id <> 'finalizer:restore-admission')
  OR (NEW.reason_code = 'normal-finalization' AND (NEW.finalizer_kind = 'restore-admission' OR NEW.restore_event_id <> 'restore-event:none'))
  OR (NEW.reason_code = 'explicit-database-restore' AND (NEW.finalizer_kind <> 'restore-admission' OR NEW.finalizer_instance_id <> 'finalizer:restore-admission'))
BEGIN SELECT RAISE(ABORT, 'terminal effect/finalizer projection is invalid'); END;

CREATE TRIGGER authority_d29_terminal_effect_projection_immutable_update
BEFORE UPDATE ON action_plan_terminal_audit
BEGIN SELECT RAISE(ABORT, 'action terminal audit is immutable'); END;
CREATE TRIGGER authority_d29_terminal_effect_projection_immutable_delete
BEFORE DELETE ON action_plan_terminal_audit
BEGIN SELECT RAISE(ABORT, 'action terminal audit is immutable'); END;
`,
} satisfies Migration;

export const sealKeyAdministrationMigrations = [sealKeyAdministrationMigration] as const;
