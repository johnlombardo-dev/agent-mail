import type { Migration } from "../migration-runner";

/**
 * Upgrade already-applied action schemas without changing migration 0001.
 * SQLite cannot add a CHECK arm in place, so this is an atomic table rebuild.
 * The runner disables FK enforcement before BEGIN solely for this migration;
 * the existing child tables retain their original references to action_plans.
 */
export const actionPlanRestoreQuarantineMigration = {
  version: 10,
  name: "action-plan-restore-quarantine",
  requiresForeignKeysOff: true,
  sql: `
CREATE TABLE action_plans_rebuild (
  plan_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(plan_id) > 5 AND plan_id GLOB 'plan:*' AND length(trim(plan_id)) = length(plan_id)
  ),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('markSeen', 'markUnseen', 'moveToArchive', 'moveToTrash')),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24 AND substr(created_at, 12, 2) BETWEEN '00' AND '23' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) = 24 AND substr(expires_at, 12, 2) BETWEEN '00' AND '23' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at AND expires_at >= created_at
  ),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'executing', 'completed', 'partial', 'rejected', 'expired', 'failed', 'uncertain', 'restore-quarantined')
  ),
  claim_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  expired_at TEXT,
  uncertain_attempt_id TEXT,
  missing_local_result_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version > 0),
  UNIQUE (plan_id, claim_id),
  CHECK (
    (state = 'pending' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
    (state = 'executing' AND claim_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
    (state IN ('completed', 'partial') AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NOT NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
    (state = 'failed' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NOT NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
    (state = 'rejected' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
    (state = 'expired' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NOT NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
    (state = 'uncertain' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NOT NULL AND missing_local_result_at IS NOT NULL) OR
    (state = 'restore-quarantined' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL)
  ),
  CHECK (started_at IS NULL OR (length(started_at) = 24 AND substr(started_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at AND started_at >= created_at)),
  CHECK (completed_at IS NULL OR (length(completed_at) = 24 AND substr(completed_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at AND completed_at >= created_at)),
  CHECK (failed_at IS NULL OR (length(failed_at) = 24 AND substr(failed_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', failed_at) = failed_at AND failed_at >= created_at)),
  CHECK (rejected_at IS NULL OR (length(rejected_at) = 24 AND substr(rejected_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', rejected_at) = rejected_at AND rejected_at >= created_at)),
  CHECK (expired_at IS NULL OR (length(expired_at) = 24 AND substr(expired_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', expired_at) = expired_at AND expired_at >= expires_at)),
  CHECK (missing_local_result_at IS NULL OR (length(missing_local_result_at) = 24 AND substr(missing_local_result_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', missing_local_result_at) = missing_local_result_at AND missing_local_result_at >= created_at)),
  CHECK (rejection_reason IS NULL OR (length(trim(rejection_reason)) > 0 AND length(rejection_reason) <= 2048)),
  FOREIGN KEY (plan_id, claim_id) REFERENCES action_plan_claims(plan_id, claim_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (plan_id, uncertain_attempt_id) REFERENCES action_attempts(plan_id, attempt_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

INSERT INTO action_plans_rebuild (
  plan_id, action_kind, created_at, expires_at, state, claim_id, started_at,
  completed_at, failed_at, rejected_at, rejection_reason, expired_at,
  uncertain_attempt_id, missing_local_result_at, version
)
SELECT plan_id, action_kind, created_at, expires_at, state, claim_id, started_at,
  completed_at, failed_at, rejected_at, rejection_reason, expired_at,
  uncertain_attempt_id, missing_local_result_at,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('action_plans') WHERE name = 'version') THEN version ELSE 1 END
FROM action_plans;

DROP TABLE action_plans;
ALTER TABLE action_plans_rebuild RENAME TO action_plans;

CREATE TRIGGER action_plan_identity_immutable
BEFORE UPDATE ON action_plans
WHEN OLD.plan_id <> NEW.plan_id OR OLD.action_kind <> NEW.action_kind OR OLD.created_at <> NEW.created_at OR OLD.expires_at <> NEW.expires_at
BEGIN SELECT RAISE(ABORT, 'action plan identity is immutable'); END;

CREATE TRIGGER action_plan_transition_guard
BEFORE UPDATE OF state ON action_plans
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('pending', 'executing', 'rejected', 'expired')) OR
  (OLD.state = 'executing' AND NEW.state IN ('executing', 'completed', 'partial', 'failed', 'rejected', 'expired', 'uncertain', 'restore-quarantined')) OR
  (OLD.state = 'uncertain' AND NEW.state IN ('uncertain', 'completed', 'partial', 'failed', 'rejected')) OR
  (OLD.state = 'restore-quarantined' AND NEW.state = 'restore-quarantined') OR
  (OLD.state IN ('completed', 'partial', 'failed', 'rejected', 'expired') AND NEW.state = OLD.state)
)
BEGIN SELECT RAISE(ABORT, 'action plan transition is not allowed'); END;

CREATE TRIGGER action_plan_requires_target_on_execution
BEFORE UPDATE OF state ON action_plans
WHEN NEW.state IN ('executing', 'uncertain') AND NOT EXISTS (SELECT 1 FROM action_plan_targets WHERE plan_id = NEW.plan_id)
BEGIN SELECT RAISE(ABORT, 'executing action plan requires at least one target'); END;

CREATE TRIGGER action_plan_version_pair_guard
BEFORE UPDATE OF version ON action_plans
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'authority plan version must advance exactly once'); END;

CREATE INDEX IF NOT EXISTS action_plans_state_idx ON action_plans(state, expires_at, plan_id);

/*
 * Authority-v1 was already applied by the predecessor schema.  These guards
 * are deliberately in this upgrade (rather than editing migration 0009) so
 * an existing file receives the same structural checks as a fresh file.
 */
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

/*
 * The predecessor authority migration already has the basic relational
 * guards.  These v10 guards close the upgrade seam for files where v9 was
 * applied before the complete ceremony/receipt contract existed.  They are
 * intentionally insert-time checks: authority rows are append-only and a
 * later repair cannot make a forged row trustworthy.
 */
CREATE TRIGGER authority_v10_approval_creator_exact_guard
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
    AND cr.principal_id = NEW.approver_principal_id
    AND cr.credential_id = NEW.approver_credential_id
    AND cr.profile = NEW.approver_profile
    AND cr.auth_event_id = NEW.approver_auth_event_id
)
BEGIN SELECT RAISE(ABORT, 'approval creator provenance is not trusted'); END;

CREATE TRIGGER authority_v10_approval_challenge_exact_guard
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  WHERE c.challenge_id = NEW.ceremony_id
    AND c.operation = 'approve'
    AND c.authority_instance_id = NEW.authority_instance_id
    AND c.operator_configuration_revision = NEW.operator_configuration_revision
    AND c.credential_id = NEW.approver_credential_id
    AND c.principal_id = NEW.approver_principal_id
    AND c.profile = NEW.approver_profile
    AND c.request_method = NEW.presence_request_method
    AND c.request_path = NEW.presence_request_path
    AND c.request_body_sha256 = NEW.presence_request_body_sha256
    AND c.operator_display_code = NEW.operator_display_code
    AND c.challenge_commitment_sha256 = NEW.challenge_commitment_sha256
    AND c.issued_at <= NEW.user_presence_verified_at
    AND c.expires_at > NEW.user_presence_verified_at
    AND c.expires_at > c.issued_at
)
BEGIN SELECT RAISE(ABORT, 'approval ceremony binding is invalid'); END;

CREATE TRIGGER authority_v10_cancellation_challenge_exact_guard
BEFORE INSERT ON action_approval_cancellations
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  JOIN action_approvals a ON a.approval_id = NEW.approval_id
  WHERE c.challenge_id = NEW.ceremony_id
    AND c.operation = 'cancel-approval'
    AND c.authority_instance_id = NEW.authority_instance_id
    AND c.operator_configuration_revision = NEW.operator_configuration_revision
    AND c.credential_id = NEW.canceller_credential_id
    AND c.principal_id = NEW.canceller_principal_id
    AND c.profile = NEW.canceller_profile
    AND c.request_method = NEW.presence_request_method
    AND c.request_path = NEW.presence_request_path
    AND c.request_body_sha256 = NEW.presence_request_body_sha256
    AND c.operator_display_code = NEW.operator_display_code
    AND c.challenge_commitment_sha256 = NEW.challenge_commitment_sha256
    AND c.issued_at <= NEW.user_presence_verified_at
    AND c.expires_at > NEW.user_presence_verified_at
)
BEGIN SELECT RAISE(ABORT, 'cancellation ceremony binding is invalid'); END;

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
        WHERE a.approval_id = NEW.authority_output_id
          AND a.ceremony_id = c.challenge_id
          AND a.authority_instance_id = c.authority_instance_id
          AND a.operator_configuration_revision = c.operator_configuration_revision
          AND a.approver_credential_id = c.credential_id
          AND a.approver_principal_id = c.principal_id
          AND a.approver_profile = c.profile
          AND a.presence_request_method = c.request_method
          AND a.presence_request_path = c.request_path
          AND a.presence_request_body_sha256 = c.request_body_sha256
          AND a.operator_display_code = c.operator_display_code
          AND a.challenge_commitment_sha256 = c.challenge_commitment_sha256
      )) OR
      (NEW.operation = 'cancel-approval' AND NEW.authority_output_kind = 'cancellation' AND EXISTS (
        SELECT 1 FROM action_approval_cancellations x
        WHERE x.approval_id = NEW.authority_output_id
          AND x.ceremony_id = c.challenge_id
          AND x.authority_instance_id = c.authority_instance_id
          AND x.operator_configuration_revision = c.operator_configuration_revision
          AND x.canceller_credential_id = c.credential_id
          AND x.canceller_principal_id = c.principal_id
          AND x.canceller_profile = c.profile
          AND x.presence_request_method = c.request_method
          AND x.presence_request_path = c.request_path
          AND x.presence_request_body_sha256 = c.request_body_sha256
          AND x.operator_display_code = c.operator_display_code
          AND x.challenge_commitment_sha256 = c.challenge_commitment_sha256
      ))
    )
)
BEGIN SELECT RAISE(ABORT, 'challenge consumption output is not bound'); END;

CREATE TRIGGER authority_v10_consumption_exact_guard
BEFORE INSERT ON action_approval_consumptions
WHEN NOT EXISTS (
  SELECT 1
  FROM action_approvals a
  JOIN action_plans p ON p.plan_id = a.plan_id
  JOIN action_plan_claims cl ON cl.plan_id = p.plan_id AND cl.claim_id = NEW.claim_id
  WHERE a.approval_id = NEW.approval_id
    AND a.plan_id = NEW.plan_id
    AND a.plan_version = NEW.plan_version_before
    AND p.version = NEW.plan_version_before
    AND p.state = 'pending'
    AND p.claim_id IS NULL
    AND cl.claim_id = NEW.claim_id
    AND NEW.plan_version_after = NEW.plan_version_before + 1
    AND length(NEW.approval_commitment_sha256) = 64
    AND length(NEW.receipt_commitment_sha256) = 64
)
BEGIN SELECT RAISE(ABORT, 'approval receipt is not bound to its plan and claim'); END;

CREATE TRIGGER authority_v10_closure_version_exact_guard
BEFORE INSERT ON action_approval_expirations
WHEN NOT EXISTS (
  SELECT 1 FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id
  WHERE a.approval_id = NEW.approval_id AND a.plan_version = NEW.plan_version_before
    AND p.version = NEW.plan_version_before AND p.state = 'pending'
    AND NEW.plan_version_after = NEW.plan_version_before + 1
)
BEGIN SELECT RAISE(ABORT, 'expiration is not coupled to the current plan version'); END;

CREATE TRIGGER authority_v10_cancellation_version_exact_guard
BEFORE INSERT ON action_approval_cancellations
WHEN NOT EXISTS (
  SELECT 1 FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id
  WHERE a.approval_id = NEW.approval_id AND a.plan_version = NEW.plan_version_before
    AND p.version = NEW.plan_version_before AND p.state = 'pending'
    AND NEW.plan_version_after = NEW.plan_version_before + 1
)
BEGIN SELECT RAISE(ABORT, 'cancellation is not coupled to the current plan version'); END;

CREATE TRIGGER authority_v10_invalidation_version_exact_guard
BEFORE INSERT ON action_approval_invalidations
WHEN NOT EXISTS (
  SELECT 1 FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id
  WHERE a.approval_id = NEW.approval_id AND a.plan_version = NEW.plan_version_before
    AND p.version = NEW.plan_version_before AND p.state = 'pending'
    AND NEW.plan_version_after = NEW.plan_version_before + 1
)
BEGIN SELECT RAISE(ABORT, 'invalidation is not coupled to the current plan version'); END;

CREATE TRIGGER authority_v10_attempt_receipt_exact_guard
BEFORE INSERT ON action_attempt_authorities
WHEN NOT EXISTS (
  SELECT 1
  FROM action_attempts at
  JOIN action_plans p ON p.plan_id = at.plan_id
  JOIN action_approval_consumptions c ON c.plan_id = at.plan_id
    AND c.claim_id = NEW.claim_id AND c.receipt_id = NEW.receipt_id
  WHERE at.plan_id = NEW.plan_id
    AND at.attempt_id = NEW.attempt_id
    AND at.claim_id = NEW.claim_id
    AND p.state = 'executing'
    AND p.claim_id = NEW.claim_id
    AND c.executor_profile = NEW.executor_profile
)
BEGIN SELECT RAISE(ABORT, 'attempt authority is not attributed to the consumed receipt'); END;

CREATE TRIGGER authority_v10_terminal_receipt_exact_guard
BEFORE INSERT ON action_plan_terminal_audit
WHEN NOT EXISTS (
  SELECT 1 FROM action_approval_consumptions c
  WHERE c.receipt_id = NEW.receipt_id
    AND c.plan_id = NEW.plan_id
    AND c.claim_id = NEW.claim_id
    AND c.executor_profile = 'internal-action-executor'
)
  OR (NEW.executor_disposition = 'started' AND NOT EXISTS (
    SELECT 1 FROM action_attempt_authorities a
    WHERE a.plan_id = NEW.plan_id AND a.receipt_id = NEW.receipt_id AND a.claim_id = NEW.claim_id
  ))
  OR (NEW.executor_disposition = 'never-started-after-restore' AND EXISTS (
    SELECT 1 FROM action_attempt_dispatches d JOIN action_attempts at ON at.attempt_id = d.attempt_id AND at.plan_id = d.plan_id
    WHERE at.plan_id = NEW.plan_id
  ))
BEGIN SELECT RAISE(ABORT, 'terminal audit is not attributed to the consumed receipt'); END;

CREATE TRIGGER authority_approval_challenge_display_guard
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  WHERE c.challenge_id = NEW.ceremony_id
    AND c.operator_display_code = NEW.operator_display_code
)
BEGIN SELECT RAISE(ABORT, 'approval display or lifetime is not bound to its challenge'); END;

CREATE TRIGGER authority_cancellation_challenge_display_guard
BEFORE INSERT ON action_approval_cancellations
WHEN NOT EXISTS (
  SELECT 1 FROM operator_presence_challenges c
  WHERE c.challenge_id = NEW.ceremony_id
    AND c.operator_display_code = NEW.operator_display_code
)
BEGIN SELECT RAISE(ABORT, 'cancellation display is not bound to its challenge'); END;
`,
} satisfies Migration;

export const actionPlanRestoreQuarantineMigrations = [
  actionPlanRestoreQuarantineMigration,
] as const;
