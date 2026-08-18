import type { Migration } from "../migration-runner";

/**
 * Durable Policy-A authority. This migration is intentionally an extension:
 * applications compose it after the dependency-complete action chain. Every
 * authority row is strict, insert-only, and keyed to existing action rows.
 */
export const ACTION_APPROVAL_AUTHORITY_MIGRATION_VERSION = 9;

export const actionApprovalAuthorityMigration = {
  version: ACTION_APPROVAL_AUTHORITY_MIGRATION_VERSION,
  name: "action-approval-authority-v1",
  sql: `
CREATE TABLE action_plan_authority_versions (
  plan_id TEXT PRIMARY KEY NOT NULL REFERENCES action_plans(plan_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  authority_version TEXT NOT NULL CHECK (authority_version IN ('trusted-v1', 'legacy-untrusted')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('trusted-create', 'legacy-pre-authority')),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) = recorded_at),
  CHECK ((authority_version = 'trusted-v1' AND reason_code = 'trusted-create') OR
         (authority_version = 'legacy-untrusted' AND reason_code = 'legacy-pre-authority'))
) STRICT;

INSERT INTO action_plan_authority_versions (plan_id, authority_version, reason_code, recorded_at)
SELECT plan_id, 'legacy-untrusted', 'legacy-pre-authority', created_at FROM action_plans;

CREATE TABLE action_plan_creators (
  plan_id TEXT PRIMARY KEY NOT NULL REFERENCES action_plans(plan_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  principal_id TEXT NOT NULL CHECK (length(CAST(principal_id AS BLOB)) BETWEEN 1 AND 256),
  credential_id TEXT NOT NULL CHECK (length(CAST(credential_id AS BLOB)) BETWEEN 1 AND 256),
  profile TEXT NOT NULL CHECK (profile IN ('operator-interactive', 'agent-unattended')),
  auth_event_id TEXT NOT NULL CHECK (length(CAST(auth_event_id AS BLOB)) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at),
  UNIQUE (plan_id, principal_id, credential_id)
) STRICT;

CREATE TABLE operator_presence_challenges (
  challenge_id TEXT PRIMARY KEY NOT NULL CHECK (challenge_id GLOB 'operator-challenge:*'),
  authority_instance_id TEXT NOT NULL,
  operator_configuration_revision INTEGER NOT NULL CHECK (operator_configuration_revision > 0),
  challenge_nonce_base64url TEXT NOT NULL UNIQUE CHECK (length(challenge_nonce_base64url) = 43 AND challenge_nonce_base64url NOT GLOB '*[^A-Za-z0-9_-]*'),
  credential_id TEXT NOT NULL,
  principal_id TEXT NOT NULL CHECK (principal_id = 'principal:local-operator'),
  profile TEXT NOT NULL CHECK (profile = 'operator-interactive'),
  operation TEXT NOT NULL CHECK (operation IN ('open-session', 'approve', 'cancel-approval')),
  request_method TEXT NOT NULL CHECK (request_method IN ('POST', 'DELETE')),
  request_path TEXT NOT NULL,
  request_body_sha256 TEXT NOT NULL CHECK (length(request_body_sha256) = 64 AND request_body_sha256 NOT GLOB '*[^0-9a-f]*'),
  operator_display_code TEXT NOT NULL CHECK (operator_display_code GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  challenge_commitment TEXT NOT NULL,
  challenge_commitment_sha256 TEXT NOT NULL CHECK (length(challenge_commitment_sha256) = 64 AND challenge_commitment_sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (length(issued_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) = issued_at AND length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at AND CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', issued_at) AS INTEGER) = 60),
  CHECK ((operation = 'approve' AND request_method = 'POST') OR (operation = 'cancel-approval' AND request_method = 'DELETE') OR (operation = 'open-session' AND request_method = 'POST'))
) STRICT;

CREATE TABLE operator_presence_challenge_consumptions (
  challenge_id TEXT PRIMARY KEY NOT NULL REFERENCES operator_presence_challenges(challenge_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  consumed_at TEXT NOT NULL CHECK (length(consumed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) = consumed_at),
  operation TEXT NOT NULL CHECK (operation IN ('open-session', 'approve', 'cancel-approval')),
  authority_output_kind TEXT NOT NULL CHECK (authority_output_kind IN ('operator-session', 'approval', 'cancellation')),
  authority_output_id TEXT NOT NULL,
  signature_p1363_base64url TEXT NOT NULL CHECK (length(signature_p1363_base64url) = 86 AND signature_p1363_base64url NOT GLOB '*[^A-Za-z0-9_-]*'),
  signature_sha256 TEXT NOT NULL CHECK (length(signature_sha256) = 64 AND signature_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK ((operation = 'open-session' AND authority_output_kind = 'operator-session' AND authority_output_id GLOB 'operator-session:*') OR
         (operation = 'approve' AND authority_output_kind = 'approval' AND authority_output_id GLOB 'approval:*') OR
         (operation = 'cancel-approval' AND authority_output_kind = 'cancellation' AND authority_output_id GLOB 'approval:*'))
) STRICT;

CREATE TABLE operator_presence_challenge_expirations (
  challenge_id TEXT PRIMARY KEY NOT NULL REFERENCES operator_presence_challenges(challenge_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  expired_at TEXT NOT NULL CHECK (length(expired_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expired_at) = expired_at)
) STRICT;

CREATE TABLE operator_presence_challenge_invalidations (
  challenge_id TEXT PRIMARY KEY NOT NULL REFERENCES operator_presence_challenges(challenge_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  invalidated_at TEXT NOT NULL CHECK (length(invalidated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('credential-revoked', 'instance-mismatch', 'database-restore', 'configuration-change'))
) STRICT;

CREATE TABLE action_approvals (
  approval_id TEXT PRIMARY KEY NOT NULL CHECK (approval_id GLOB 'approval:*'),
  plan_id TEXT NOT NULL REFERENCES action_plans(plan_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  plan_version INTEGER NOT NULL CHECK (plan_version > 0),
  preview_digest TEXT NOT NULL CHECK (length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^0-9a-f]*'),
  target_digest TEXT NOT NULL CHECK (length(target_digest) = 64 AND target_digest NOT GLOB '*[^0-9a-f]*'),
  canonical_target_set TEXT NOT NULL CHECK (length(CAST(canonical_target_set AS BLOB)) BETWEEN 2 AND 1048576 AND json_valid(canonical_target_set) AND json_type(canonical_target_set) = 'array'),
  normalized_intent TEXT NOT NULL CHECK (length(CAST(normalized_intent AS BLOB)) BETWEEN 2 AND 2048),
  approver_principal_id TEXT NOT NULL,
  approver_credential_id TEXT NOT NULL,
  approver_profile TEXT NOT NULL CHECK (approver_profile = 'operator-interactive'),
  approver_auth_event_id TEXT NOT NULL,
  ceremony_id TEXT NOT NULL UNIQUE,
  user_presence_verified_at TEXT NOT NULL CHECK (length(user_presence_verified_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', user_presence_verified_at) = user_presence_verified_at),
  presence_request_method TEXT NOT NULL CHECK (presence_request_method = 'POST'),
  presence_request_path TEXT NOT NULL,
  presence_request_body_sha256 TEXT NOT NULL CHECK (length(presence_request_body_sha256) = 64 AND presence_request_body_sha256 NOT GLOB '*[^0-9a-f]*'),
  authority_instance_id TEXT NOT NULL,
  operator_configuration_revision INTEGER NOT NULL CHECK (operator_configuration_revision > 0),
  challenge_commitment_sha256 TEXT NOT NULL CHECK (length(challenge_commitment_sha256) = 64 AND challenge_commitment_sha256 NOT GLOB '*[^0-9a-f]*'),
  assertion_signature_sha256 TEXT NOT NULL CHECK (length(assertion_signature_sha256) = 64 AND assertion_signature_sha256 NOT GLOB '*[^0-9a-f]*'),
  operator_display_code TEXT NOT NULL,
  issued_at TEXT NOT NULL CHECK (length(issued_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) = issued_at),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at),
  nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) = 64 AND nonce NOT GLOB '*[^0-9a-f]*'),
  authorization_scope TEXT NOT NULL CHECK (authorization_scope = 'mail:action.commit'),
  seal_key_id TEXT NOT NULL,
  seal_keyring_revision INTEGER NOT NULL CHECK (seal_keyring_revision > 0),
  seal_algorithm TEXT NOT NULL CHECK (seal_algorithm = 'hmac-sha256'),
  seal TEXT NOT NULL CHECK (length(seal) = 64 AND seal NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (plan_id, plan_version),
  CHECK (expires_at > issued_at)
) STRICT;

CREATE TABLE action_approval_consumptions (
  receipt_id TEXT PRIMARY KEY NOT NULL CHECK (receipt_id GLOB 'approval-receipt:*'),
  approval_id TEXT NOT NULL UNIQUE REFERENCES action_approvals(approval_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  plan_id TEXT NOT NULL,
  plan_version_before INTEGER NOT NULL CHECK (plan_version_before > 0),
  plan_version_after INTEGER NOT NULL CHECK (plan_version_after = plan_version_before + 1),
  claim_id TEXT NOT NULL,
  committer_principal_id TEXT NOT NULL,
  committer_credential_id TEXT NOT NULL,
  committer_profile TEXT NOT NULL CHECK (committer_profile = 'agent-unattended'),
  committer_auth_event_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL CHECK (length(consumed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) = consumed_at),
  approval_commitment_sha256 TEXT NOT NULL CHECK (length(approval_commitment_sha256) = 64 AND approval_commitment_sha256 NOT GLOB '*[^0-9a-f]*'),
  executor_profile TEXT NOT NULL CHECK (executor_profile = 'internal-action-executor'),
  receipt_commitment_sha256 TEXT NOT NULL CHECK (length(receipt_commitment_sha256) = 64 AND receipt_commitment_sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (plan_id, claim_id),
  UNIQUE (receipt_id, plan_id, claim_id),
  FOREIGN KEY (plan_id, claim_id) REFERENCES action_plan_claims(plan_id, claim_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE TABLE action_approval_expirations (
  approval_id TEXT PRIMARY KEY NOT NULL REFERENCES action_approvals(approval_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  expired_at TEXT NOT NULL CHECK (length(expired_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', expired_at) = expired_at),
  plan_version_before INTEGER NOT NULL CHECK (plan_version_before > 0),
  plan_version_after INTEGER NOT NULL CHECK (plan_version_after = plan_version_before + 1),
  plan_disposition TEXT NOT NULL CHECK (plan_disposition IN ('pending-advanced', 'plan-expired'))
) STRICT;

CREATE TABLE action_approval_cancellations (
  approval_id TEXT PRIMARY KEY NOT NULL REFERENCES action_approvals(approval_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  cancelled_at TEXT NOT NULL CHECK (length(cancelled_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at) = cancelled_at),
  canceller_principal_id TEXT NOT NULL,
  canceller_credential_id TEXT NOT NULL,
  canceller_profile TEXT NOT NULL CHECK (canceller_profile = 'operator-interactive'),
  canceller_auth_event_id TEXT NOT NULL,
  ceremony_id TEXT NOT NULL UNIQUE,
  user_presence_verified_at TEXT NOT NULL CHECK (length(user_presence_verified_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', user_presence_verified_at) = user_presence_verified_at),
  presence_request_method TEXT NOT NULL CHECK (presence_request_method = 'DELETE'),
  presence_request_path TEXT NOT NULL,
  presence_request_body_sha256 TEXT NOT NULL CHECK (length(presence_request_body_sha256) = 64 AND presence_request_body_sha256 NOT GLOB '*[^0-9a-f]*'),
  authority_instance_id TEXT NOT NULL,
  operator_configuration_revision INTEGER NOT NULL CHECK (operator_configuration_revision > 0),
  challenge_commitment_sha256 TEXT NOT NULL CHECK (length(challenge_commitment_sha256) = 64 AND challenge_commitment_sha256 NOT GLOB '*[^0-9a-f]*'),
  assertion_signature_sha256 TEXT NOT NULL CHECK (length(assertion_signature_sha256) = 64 AND assertion_signature_sha256 NOT GLOB '*[^0-9a-f]*'),
  operator_display_code TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code = 'operator-cancelled'),
  plan_version_before INTEGER NOT NULL CHECK (plan_version_before > 0),
  plan_version_after INTEGER NOT NULL CHECK (plan_version_after = plan_version_before + 1)
) STRICT;

CREATE TABLE action_approval_invalidations (
  approval_id TEXT PRIMARY KEY NOT NULL REFERENCES action_approvals(approval_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  invalidated_at TEXT NOT NULL CHECK (length(invalidated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) = invalidated_at),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('seal-mismatch', 'key-unavailable', 'credential-revoked', 'credential-expired', 'plan-mismatch', 'legacy-scope-only', 'configuration-change', 'database-restore')),
  plan_version_before INTEGER NOT NULL CHECK (plan_version_before > 0),
  plan_version_after INTEGER NOT NULL CHECK (plan_version_after = plan_version_before + 1)
) STRICT;

CREATE TABLE action_attempt_authorities (
  plan_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL REFERENCES action_approval_consumptions(receipt_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  claim_id TEXT NOT NULL,
  executor_profile TEXT NOT NULL CHECK (executor_profile = 'internal-action-executor'),
  executor_instance_id TEXT NOT NULL,
  attributed_at TEXT NOT NULL CHECK (length(attributed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', attributed_at) = attributed_at),
  PRIMARY KEY (plan_id, attempt_id),
  FOREIGN KEY (plan_id, attempt_id) REFERENCES action_attempts(plan_id, attempt_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (plan_id, claim_id) REFERENCES action_plan_claims(plan_id, claim_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE TABLE action_plan_terminal_audit (
  plan_id TEXT PRIMARY KEY NOT NULL REFERENCES action_plans(plan_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  receipt_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  terminal_state TEXT NOT NULL CHECK (terminal_state IN ('completed', 'partial', 'failed', 'rejected', 'expired', 'uncertain', 'restore-quarantined')),
  terminal_at TEXT NOT NULL CHECK (length(terminal_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at) = terminal_at),
  executor_disposition TEXT NOT NULL CHECK (executor_disposition IN ('started', 'never-started-after-restore', 'unknown-after-restore')),
  executor_instance_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('normal-finalization', 'explicit-database-restore')),
  restore_event_id TEXT NOT NULL,
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (receipt_id, plan_id, claim_id) REFERENCES action_approval_consumptions(receipt_id, plan_id, claim_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((executor_disposition = 'started' AND executor_instance_id NOT IN ('executor:not-started', 'executor:unknown-after-restore')) OR
         (executor_disposition = 'never-started-after-restore' AND executor_instance_id = 'executor:not-started') OR
         (executor_disposition = 'unknown-after-restore' AND executor_instance_id = 'executor:unknown-after-restore')),
  CHECK ((reason_code = 'normal-finalization' AND restore_event_id = 'restore-event:none') OR
         (reason_code = 'explicit-database-restore' AND restore_event_id GLOB 'restore-event:*'))
) STRICT;

CREATE TRIGGER authority_plan_version_pair_guard
BEFORE UPDATE OF version ON action_plans
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'authority plan version must advance exactly once'); END;

CREATE TRIGGER authority_challenge_immutable_update
BEFORE UPDATE ON operator_presence_challenges
BEGIN SELECT RAISE(ABORT, 'operator presence challenge is immutable'); END;
CREATE TRIGGER authority_challenge_immutable_delete
BEFORE DELETE ON operator_presence_challenges
BEGIN SELECT RAISE(ABORT, 'operator presence challenge is immutable'); END;
CREATE TRIGGER authority_approval_immutable_update
BEFORE UPDATE ON action_approvals
BEGIN SELECT RAISE(ABORT, 'action approval is immutable'); END;
CREATE TRIGGER authority_approval_immutable_delete
BEFORE DELETE ON action_approvals
BEGIN SELECT RAISE(ABORT, 'action approval is immutable'); END;

CREATE TRIGGER authority_consumption_actor_separation
BEFORE INSERT ON action_approval_consumptions
WHEN NEW.committer_principal_id = (SELECT approver_principal_id FROM action_approvals WHERE approval_id = NEW.approval_id)
  OR NEW.committer_credential_id = (SELECT approver_credential_id FROM action_approvals WHERE approval_id = NEW.approval_id)
BEGIN SELECT RAISE(ABORT, 'approval and committer identities must be distinct'); END;

CREATE TRIGGER authority_creator_immutable_update
BEFORE UPDATE ON action_plan_creators
BEGIN SELECT RAISE(ABORT, 'action plan creator provenance is immutable'); END;
CREATE TRIGGER authority_creator_created_at_guard
BEFORE INSERT ON action_plan_creators
WHEN NEW.created_at <> (SELECT created_at FROM action_plans WHERE plan_id = NEW.plan_id)
BEGIN SELECT RAISE(ABORT, 'action plan creator timestamp must match plan creation'); END;
CREATE TRIGGER authority_creator_immutable_delete
BEFORE DELETE ON action_plan_creators
BEGIN SELECT RAISE(ABORT, 'action plan creator provenance is immutable'); END;
CREATE TRIGGER authority_version_immutable_update
BEFORE UPDATE ON action_plan_authority_versions
BEGIN SELECT RAISE(ABORT, 'action plan authority version is immutable'); END;
CREATE TRIGGER authority_version_immutable_delete
BEFORE DELETE ON action_plan_authority_versions
BEGIN SELECT RAISE(ABORT, 'action plan authority version is immutable'); END;
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
CREATE TRIGGER authority_approval_consumption_immutable_update
BEFORE UPDATE ON action_approval_consumptions
BEGIN SELECT RAISE(ABORT, 'action approval consumption is immutable'); END;
CREATE TRIGGER authority_approval_consumption_immutable_delete
BEFORE DELETE ON action_approval_consumptions
BEGIN SELECT RAISE(ABORT, 'action approval consumption is immutable'); END;
CREATE TRIGGER authority_approval_expiration_immutable_update
BEFORE UPDATE ON action_approval_expirations
BEGIN SELECT RAISE(ABORT, 'action approval expiration is immutable'); END;
CREATE TRIGGER authority_approval_expiration_immutable_delete
BEFORE DELETE ON action_approval_expirations
BEGIN SELECT RAISE(ABORT, 'action approval expiration is immutable'); END;
CREATE TRIGGER authority_approval_cancellation_immutable_update
BEFORE UPDATE ON action_approval_cancellations
BEGIN SELECT RAISE(ABORT, 'action approval cancellation is immutable'); END;
CREATE TRIGGER authority_approval_cancellation_immutable_delete
BEFORE DELETE ON action_approval_cancellations
BEGIN SELECT RAISE(ABORT, 'action approval cancellation is immutable'); END;
CREATE TRIGGER authority_approval_invalidation_immutable_update
BEFORE UPDATE ON action_approval_invalidations
BEGIN SELECT RAISE(ABORT, 'action approval invalidation is immutable'); END;
CREATE TRIGGER authority_approval_invalidation_immutable_delete
BEFORE DELETE ON action_approval_invalidations
BEGIN SELECT RAISE(ABORT, 'action approval invalidation is immutable'); END;
CREATE TRIGGER authority_attempt_authority_immutable_update
BEFORE UPDATE ON action_attempt_authorities
BEGIN SELECT RAISE(ABORT, 'action attempt authority is immutable'); END;
CREATE TRIGGER authority_attempt_authority_immutable_delete
BEFORE DELETE ON action_attempt_authorities
BEGIN SELECT RAISE(ABORT, 'action attempt authority is immutable'); END;
CREATE TRIGGER authority_terminal_audit_immutable_update
BEFORE UPDATE ON action_plan_terminal_audit
BEGIN SELECT RAISE(ABORT, 'action terminal audit is immutable'); END;
CREATE TRIGGER authority_terminal_audit_immutable_delete
BEFORE DELETE ON action_plan_terminal_audit
BEGIN SELECT RAISE(ABORT, 'action terminal audit is immutable'); END;

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
CREATE TRIGGER authority_approval_consumption_single_closure
BEFORE INSERT ON action_approval_consumptions
WHEN EXISTS (SELECT 1 FROM action_approval_expirations WHERE approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM action_approval_cancellations WHERE approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM action_approval_invalidations WHERE approval_id = NEW.approval_id)
BEGIN SELECT RAISE(ABORT, 'action approval is already closed'); END;
CREATE TRIGGER authority_approval_expiration_single_closure
BEFORE INSERT ON action_approval_expirations
WHEN EXISTS (SELECT 1 FROM action_approval_consumptions WHERE approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM action_approval_cancellations WHERE approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM action_approval_invalidations WHERE approval_id = NEW.approval_id)
BEGIN SELECT RAISE(ABORT, 'action approval is already closed'); END;
CREATE TRIGGER authority_approval_cancellation_single_closure
BEFORE INSERT ON action_approval_cancellations
WHEN EXISTS (SELECT 1 FROM action_approval_consumptions WHERE approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM action_approval_expirations WHERE approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM action_approval_invalidations WHERE approval_id = NEW.approval_id)
BEGIN SELECT RAISE(ABORT, 'action approval is already closed'); END;
CREATE TRIGGER authority_approval_invalidation_single_closure
BEFORE INSERT ON action_approval_invalidations
WHEN EXISTS (SELECT 1 FROM action_approval_consumptions WHERE approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM action_approval_expirations WHERE approval_id = NEW.approval_id)
  OR EXISTS (SELECT 1 FROM action_approval_cancellations WHERE approval_id = NEW.approval_id)
BEGIN SELECT RAISE(ABORT, 'action approval is already closed'); END;
CREATE TRIGGER authority_challenge_consumption_binding
BEFORE INSERT ON operator_presence_challenge_consumptions
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  WHERE c.challenge_id = NEW.challenge_id
    AND c.operation = NEW.operation
    AND ((NEW.operation = 'approve' AND c.request_method = 'POST') OR
         (NEW.operation = 'cancel-approval' AND c.request_method = 'DELETE') OR
         (NEW.operation = 'open-session' AND c.request_method = 'POST'))
)
BEGIN SELECT RAISE(ABORT, 'operator presence challenge operation binding mismatch'); END;
CREATE TRIGGER authority_challenge_consumption_output
BEFORE INSERT ON operator_presence_challenge_consumptions
WHEN (NEW.authority_output_kind = 'approval' AND NOT EXISTS (SELECT 1 FROM action_approvals WHERE approval_id = NEW.authority_output_id))
  OR (NEW.authority_output_kind = 'cancellation' AND NOT EXISTS (SELECT 1 FROM action_approval_cancellations WHERE approval_id = NEW.authority_output_id))
  OR (NEW.authority_output_kind = 'operator-session' AND NEW.authority_output_id NOT GLOB 'operator-session:*')
  OR (NEW.operation = 'approve' AND NOT EXISTS (SELECT 1 FROM action_approvals WHERE approval_id = NEW.authority_output_id AND ceremony_id = NEW.challenge_id))
  OR (NEW.operation = 'cancel-approval' AND NOT EXISTS (SELECT 1 FROM action_approval_cancellations WHERE approval_id = NEW.authority_output_id AND ceremony_id = NEW.challenge_id))
BEGIN SELECT RAISE(ABORT, 'operator presence challenge output mismatch'); END;
CREATE TRIGGER authority_attempt_authority_shape_guard
BEFORE INSERT ON action_attempt_authorities
WHEN NOT EXISTS (
  SELECT 1 FROM action_plans p
  JOIN action_approval_consumptions c ON c.plan_id = p.plan_id AND c.claim_id = p.claim_id AND c.receipt_id = NEW.receipt_id
  WHERE p.plan_id = NEW.plan_id AND p.state = 'executing' AND p.claim_id = NEW.claim_id
)
  OR EXISTS (SELECT 1 FROM action_plan_terminal_audit WHERE plan_id = NEW.plan_id)
BEGIN SELECT RAISE(ABORT, 'attempt authority does not match the active receipt claim'); END;

CREATE TRIGGER authority_approval_current_trusted_plan_guard
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM action_plans p
  JOIN action_plan_authority_versions v ON v.plan_id = p.plan_id AND v.authority_version = 'trusted-v1'
  JOIN action_plan_creators cr ON cr.plan_id = p.plan_id
  WHERE p.plan_id = NEW.plan_id AND p.state = 'pending' AND p.version = NEW.plan_version
)
BEGIN SELECT RAISE(ABORT, 'approval must bind the current trusted plan version and creator'); END;

CREATE TRIGGER authority_approval_challenge_binding_guard
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  WHERE c.challenge_id = NEW.ceremony_id
    AND c.operation = 'approve'
    AND c.credential_id = NEW.approver_credential_id
    AND c.request_method = NEW.presence_request_method
    AND c.request_path = NEW.presence_request_path
    AND c.request_body_sha256 = NEW.presence_request_body_sha256
    AND c.authority_instance_id = NEW.authority_instance_id
    AND c.operator_configuration_revision = NEW.operator_configuration_revision
    AND c.challenge_commitment_sha256 = NEW.challenge_commitment_sha256
)
BEGIN SELECT RAISE(ABORT, 'approval ceremony is not bound to the durable challenge'); END;

CREATE TRIGGER authority_cancellation_challenge_binding_guard
BEFORE INSERT ON action_approval_cancellations
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  WHERE c.challenge_id = NEW.ceremony_id
    AND c.operation = 'cancel-approval'
    AND c.credential_id = NEW.canceller_credential_id
    AND c.request_method = NEW.presence_request_method
    AND c.request_path = NEW.presence_request_path
    AND c.request_body_sha256 = NEW.presence_request_body_sha256
    AND c.authority_instance_id = NEW.authority_instance_id
    AND c.operator_configuration_revision = NEW.operator_configuration_revision
    AND c.challenge_commitment_sha256 = NEW.challenge_commitment_sha256
)
BEGIN SELECT RAISE(ABORT, 'cancellation ceremony is not bound to the durable challenge'); END;

CREATE TRIGGER authority_consumption_plan_binding_guard
BEFORE INSERT ON action_approval_consumptions
WHEN NOT EXISTS (
  SELECT 1 FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id
  WHERE a.approval_id = NEW.approval_id AND a.plan_id = NEW.plan_id
    AND a.plan_version = NEW.plan_version_before AND p.version = NEW.plan_version_before
    AND p.claim_id IS NULL AND p.state = 'pending'
)
BEGIN SELECT RAISE(ABORT, 'consumption plan/version binding is invalid'); END;

CREATE TRIGGER authority_consumption_actor_guard
BEFORE INSERT ON action_approval_consumptions
WHEN NEW.committer_profile <> 'agent-unattended'
  OR NEW.executor_profile <> 'internal-action-executor'
  OR NEW.committer_principal_id = (SELECT approver_principal_id FROM action_approvals WHERE approval_id = NEW.approval_id)
  OR NEW.committer_credential_id = (SELECT approver_credential_id FROM action_approvals WHERE approval_id = NEW.approval_id)
BEGIN SELECT RAISE(ABORT, 'consumption actor attribution is invalid'); END;

CREATE TRIGGER authority_cancellation_version_guard
BEFORE INSERT ON action_approval_cancellations
WHEN NOT EXISTS (
  SELECT 1 FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id
  WHERE a.approval_id = NEW.approval_id AND p.version = NEW.plan_version_before AND p.state = 'pending'
    AND a.plan_version = NEW.plan_version_before
)
BEGIN SELECT RAISE(ABORT, 'cancellation closure version is invalid'); END;

CREATE TRIGGER authority_expiration_version_guard
BEFORE INSERT ON action_approval_expirations
WHEN NOT EXISTS (
  SELECT 1 FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id
  WHERE a.approval_id = NEW.approval_id AND p.version = NEW.plan_version_before AND p.state = 'pending'
    AND a.plan_version = NEW.plan_version_before
)
BEGIN SELECT RAISE(ABORT, 'expiration closure version is invalid'); END;

CREATE TRIGGER authority_invalidation_version_guard
BEFORE INSERT ON action_approval_invalidations
WHEN NOT EXISTS (
  SELECT 1 FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id
  WHERE a.approval_id = NEW.approval_id AND p.version = NEW.plan_version_before AND p.state = 'pending'
    AND a.plan_version = NEW.plan_version_before
)
BEGIN SELECT RAISE(ABORT, 'invalidation closure version is invalid'); END;

CREATE TRIGGER authority_attempt_receipt_claim_guard
BEFORE INSERT ON action_attempt_authorities
WHEN NOT EXISTS (
  SELECT 1 FROM action_approval_consumptions c
  WHERE c.receipt_id = NEW.receipt_id AND c.plan_id = NEW.plan_id AND c.claim_id = NEW.claim_id
)
BEGIN SELECT RAISE(ABORT, 'attempt authority receipt attribution is invalid'); END;
`,
} satisfies Migration;

/** Extension-only export for the application migration registry. */
export const actionApprovalAuthorityMigrations = [actionApprovalAuthorityMigration] as const;
