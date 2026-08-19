import type { Migration } from "../migration-runner";

/**
 * Durable state for one frozen remote action plan.
 *
 * This definition is deliberately standalone. It is currently numbered one
 * so it can be tested and composed in isolation; the application migration
 * assembly must assign the final contiguous number when the parallel feature
 * migrations are integrated.
 */
export const actionSchemaMigration = {
  version: 1,
  name: "action-schema",
  sql: `
    CREATE TABLE action_plans (
      plan_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(plan_id) > 5 AND
        plan_id GLOB 'plan:*' AND
        length(trim(plan_id)) = length(plan_id)
      ),
      action_kind TEXT NOT NULL CHECK (
        action_kind IN ('markSeen', 'markUnseen', 'moveToArchive', 'moveToTrash')
      ),
      created_at TEXT NOT NULL CHECK (
        length(created_at) = 24 AND
        substr(created_at, 12, 2) BETWEEN '00' AND '23' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
      ),
      expires_at TEXT NOT NULL CHECK (
        length(expires_at) = 24 AND
        substr(expires_at, 12, 2) BETWEEN '00' AND '23' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at AND
        expires_at >= created_at
      ),
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'executing', 'completed', 'partial', 'rejected', 'expired', 'failed', 'uncertain')
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
      UNIQUE (plan_id, claim_id),
      CHECK (
        (state = 'pending' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
        (state = 'executing' AND claim_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
        (state IN ('completed', 'partial') AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NOT NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
        (state = 'failed' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NOT NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
        (state = 'rejected' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL AND expired_at IS NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
        (state = 'expired' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NOT NULL AND uncertain_attempt_id IS NULL AND missing_local_result_at IS NULL) OR
        (state = 'uncertain' AND claim_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL AND expired_at IS NULL AND uncertain_attempt_id IS NOT NULL AND missing_local_result_at IS NOT NULL)
      ),
      CHECK (started_at IS NULL OR (length(started_at) = 24 AND substr(started_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at AND started_at >= created_at)),
      CHECK (completed_at IS NULL OR (length(completed_at) = 24 AND substr(completed_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at AND completed_at >= created_at)),
      CHECK (failed_at IS NULL OR (length(failed_at) = 24 AND substr(failed_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', failed_at) = failed_at AND failed_at >= created_at)),
      CHECK (rejected_at IS NULL OR (length(rejected_at) = 24 AND substr(rejected_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', rejected_at) = rejected_at AND rejected_at >= created_at)),
      CHECK (expired_at IS NULL OR (length(expired_at) = 24 AND substr(expired_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', expired_at) = expired_at AND expired_at >= expires_at)),
      CHECK (missing_local_result_at IS NULL OR (length(missing_local_result_at) = 24 AND substr(missing_local_result_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', missing_local_result_at) = missing_local_result_at AND missing_local_result_at >= created_at)),
      CHECK (rejection_reason IS NULL OR (length(trim(rejection_reason)) > 0 AND length(rejection_reason) <= 2048)),
      FOREIGN KEY (plan_id, claim_id)
        REFERENCES action_plan_claims(plan_id, claim_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      FOREIGN KEY (plan_id, uncertain_attempt_id)
        REFERENCES action_attempts(plan_id, attempt_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE TABLE action_plan_claims (
      plan_id TEXT NOT NULL,
      claim_id TEXT NOT NULL CHECK (
        length(claim_id) > 6 AND
        claim_id GLOB 'claim:*' AND
        length(trim(claim_id)) = length(claim_id)
      ),
      claimed_at TEXT NOT NULL CHECK (
        length(claimed_at) = 24 AND
        substr(claimed_at, 12, 2) BETWEEN '00' AND '23' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) = claimed_at
      ),
      PRIMARY KEY (plan_id, claim_id),
      UNIQUE (claim_id),
      FOREIGN KEY (plan_id) REFERENCES action_plans(plan_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE TABLE action_plan_targets (
      plan_id TEXT NOT NULL,
      target_ordinal INTEGER NOT NULL CHECK (
        typeof(target_ordinal) = 'integer' AND target_ordinal > 0
      ),
      account_id TEXT NOT NULL CHECK (
        length(account_id) > 8 AND account_id GLOB 'account:*' AND length(trim(account_id)) = length(account_id)
      ),
      mailbox_id TEXT NOT NULL CHECK (
        length(mailbox_id) > 8 AND mailbox_id GLOB 'mailbox:*' AND length(trim(mailbox_id)) = length(mailbox_id)
      ),
      uid_validity INTEGER NOT NULL CHECK (
        typeof(uid_validity) = 'integer' AND uid_validity > 0 AND uid_validity <= 4294967295
      ),
      uid INTEGER NOT NULL CHECK (
        typeof(uid) = 'integer' AND uid > 0 AND uid <= 4294967295
      ),
      precondition_modseq INTEGER NOT NULL CHECK (
        typeof(precondition_modseq) = 'integer' AND precondition_modseq >= 0
      ),
      PRIMARY KEY (plan_id, target_ordinal),
      UNIQUE (plan_id, account_id, mailbox_id, uid_validity, uid),
      UNIQUE (plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid),
      FOREIGN KEY (plan_id) REFERENCES action_plans(plan_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE TABLE action_attempts (
      attempt_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(attempt_id) > 8 AND attempt_id GLOB 'attempt:*' AND length(trim(attempt_id)) = length(attempt_id)
      ),
      plan_id TEXT NOT NULL,
      target_ordinal INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      mailbox_id TEXT NOT NULL,
      uid_validity INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0 AND length(idempotency_key) <= 256),
      started_at TEXT NOT NULL CHECK (
        length(started_at) = 24 AND
        substr(started_at, 12, 2) BETWEEN '00' AND '23' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at
      ),
      certainty TEXT NOT NULL CHECK (certainty = 'unresolved'),
      UNIQUE (plan_id, attempt_id),
      UNIQUE (plan_id, target_ordinal, idempotency_key),
      FOREIGN KEY (plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid)
        REFERENCES action_plan_targets(plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      FOREIGN KEY (plan_id) REFERENCES action_plans(plan_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE TABLE action_results (
      attempt_id TEXT PRIMARY KEY NOT NULL,
      plan_id TEXT NOT NULL,
      target_ordinal INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      mailbox_id TEXT NOT NULL,
      uid_validity INTEGER NOT NULL,
      uid INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0 AND length(idempotency_key) <= 256),
      started_at TEXT NOT NULL CHECK (
        length(started_at) = 24 AND
        substr(started_at, 12, 2) BETWEEN '00' AND '23' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at
      ),
      result_at TEXT NOT NULL CHECK (
        length(result_at) = 24 AND
        substr(result_at, 12, 2) BETWEEN '00' AND '23' AND
        strftime('%Y-%m-%dT%H:%M:%fZ', result_at) = result_at AND result_at >= started_at
      ),
      result_kind TEXT NOT NULL CHECK (
        result_kind IN ('success', 'stale', 'rejected', 'failed', 'uncertain')
      ),
      certainty TEXT NOT NULL CHECK (
        (result_kind = 'uncertain' AND certainty = 'uncertain') OR
        (result_kind IN ('success', 'stale', 'rejected', 'failed') AND certainty = 'definite')
      ),
      uncertain_reason TEXT,
      failure_reason TEXT,
      detail TEXT,
      postcondition_kind TEXT,
      postcondition_observed_at TEXT,
      postcondition_modseq INTEGER,
      postcondition_flags TEXT,
      postcondition_mailbox_id TEXT,
      postcondition_uid_validity INTEGER,
      postcondition_uid INTEGER,
      CHECK (
        (result_kind = 'success' AND uncertain_reason IS NULL AND failure_reason IS NULL AND detail IS NULL AND postcondition_kind IN ('flags', 'mailbox') AND postcondition_observed_at IS NOT NULL AND postcondition_modseq IS NOT NULL) OR
        (result_kind = 'uncertain' AND uncertain_reason IN ('socket-timeout-after-transmission', 'connection-lost-after-transmission', 'local-result-not-durable') AND failure_reason IS NULL AND detail IS NOT NULL AND postcondition_kind IS NULL AND postcondition_observed_at IS NULL AND postcondition_modseq IS NULL AND postcondition_flags IS NULL AND postcondition_mailbox_id IS NULL AND postcondition_uid_validity IS NULL AND postcondition_uid IS NULL) OR
        (result_kind = 'failed' AND failure_reason IN ('server-rejected', 'permission-denied', 'target-not-found', 'transport-failed-before-transmission') AND uncertain_reason IS NULL AND detail IS NOT NULL AND postcondition_kind IS NULL AND postcondition_observed_at IS NULL AND postcondition_modseq IS NULL AND postcondition_flags IS NULL AND postcondition_mailbox_id IS NULL AND postcondition_uid_validity IS NULL AND postcondition_uid IS NULL) OR
        (result_kind IN ('stale', 'rejected') AND uncertain_reason IS NULL AND failure_reason IS NULL AND detail IS NOT NULL AND postcondition_kind IS NULL AND postcondition_observed_at IS NULL AND postcondition_modseq IS NULL AND postcondition_flags IS NULL AND postcondition_mailbox_id IS NULL AND postcondition_uid_validity IS NULL AND postcondition_uid IS NULL)
      ),
      CHECK (
        (postcondition_kind = 'flags' AND postcondition_flags IS NOT NULL AND postcondition_mailbox_id IS NULL AND postcondition_uid_validity IS NULL AND postcondition_uid IS NULL) OR
        (postcondition_kind = 'mailbox' AND postcondition_flags IS NULL AND postcondition_mailbox_id IS NOT NULL AND postcondition_uid_validity IS NOT NULL AND postcondition_uid IS NOT NULL) OR
        postcondition_kind IS NULL
      ),
      CHECK (postcondition_observed_at IS NULL OR (length(postcondition_observed_at) = 24 AND substr(postcondition_observed_at, 12, 2) BETWEEN '00' AND '23' AND strftime('%Y-%m-%dT%H:%M:%fZ', postcondition_observed_at) = postcondition_observed_at AND postcondition_observed_at >= started_at AND postcondition_observed_at <= result_at)),
      CHECK (postcondition_modseq IS NULL OR (typeof(postcondition_modseq) = 'integer' AND postcondition_modseq >= 0)),
      CHECK (postcondition_uid_validity IS NULL OR (typeof(postcondition_uid_validity) = 'integer' AND postcondition_uid_validity > 0 AND postcondition_uid_validity <= 4294967295)),
      CHECK (postcondition_uid IS NULL OR (typeof(postcondition_uid) = 'integer' AND postcondition_uid > 0 AND postcondition_uid <= 4294967295)),
      CHECK (postcondition_mailbox_id IS NULL OR (length(postcondition_mailbox_id) > 8 AND postcondition_mailbox_id GLOB 'mailbox:*' AND length(trim(postcondition_mailbox_id)) = length(postcondition_mailbox_id))),
      FOREIGN KEY (attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, idempotency_key, started_at)
        REFERENCES action_attempts(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, idempotency_key, started_at)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE UNIQUE INDEX action_attempts_identity_idx ON action_attempts(
      attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, idempotency_key, started_at
    );

    CREATE TRIGGER action_claims_allowed_state
    BEFORE INSERT ON action_plan_claims
    WHEN (SELECT state FROM action_plans WHERE plan_id = NEW.plan_id) NOT IN ('pending', 'executing')
    BEGIN
      SELECT RAISE(ABORT, 'action claim requires a pending or executing plan');
    END;

    CREATE TRIGGER action_plan_identity_immutable
    BEFORE UPDATE ON action_plans
    WHEN OLD.plan_id <> NEW.plan_id OR OLD.action_kind <> NEW.action_kind OR OLD.created_at <> NEW.created_at OR OLD.expires_at <> NEW.expires_at
    BEGIN
      SELECT RAISE(ABORT, 'action plan identity is immutable');
    END;

    CREATE TRIGGER action_plan_transition_guard
    BEFORE UPDATE OF state ON action_plans
    WHEN NOT (
      (OLD.state = 'pending' AND NEW.state IN ('pending', 'executing', 'rejected', 'expired')) OR
      (OLD.state = 'executing' AND NEW.state IN ('executing', 'completed', 'partial', 'failed', 'rejected', 'expired', 'uncertain')) OR
      (OLD.state = 'uncertain' AND NEW.state IN ('uncertain', 'completed', 'partial', 'failed', 'rejected')) OR
      (OLD.state IN ('completed', 'partial', 'failed', 'rejected', 'expired') AND NEW.state = OLD.state)
    )
    BEGIN
      SELECT RAISE(ABORT, 'action plan transition is not allowed');
    END;

    CREATE TRIGGER action_plan_target_immutable
    BEFORE UPDATE ON action_plan_targets
    BEGIN
      SELECT RAISE(ABORT, 'action plan target identity is immutable');
    END;

    CREATE TRIGGER action_attempt_immutable
    BEFORE UPDATE ON action_attempts
    BEGIN
      SELECT RAISE(ABORT, 'action attempt identity is immutable');
    END;

    CREATE TRIGGER action_claim_immutable
    BEFORE UPDATE ON action_plan_claims
    BEGIN
      SELECT RAISE(ABORT, 'action claim identity is immutable');
    END;

    CREATE TRIGGER action_result_immutable
    BEFORE UPDATE ON action_results
    BEGIN
      SELECT RAISE(ABORT, 'action result identity is immutable');
    END;

    CREATE TRIGGER action_attempt_requires_execution
    BEFORE INSERT ON action_attempts
    WHEN (SELECT state FROM action_plans WHERE plan_id = NEW.plan_id) NOT IN ('executing', 'uncertain')
    BEGIN
      SELECT RAISE(ABORT, 'action attempt requires an executing or uncertain plan');
    END;

    CREATE TRIGGER action_plan_requires_target_on_execution
    BEFORE UPDATE OF state ON action_plans
    WHEN NEW.state IN ('executing', 'uncertain') AND NOT EXISTS (
      SELECT 1 FROM action_plan_targets WHERE plan_id = NEW.plan_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'executing action plan requires at least one target');
    END;

    CREATE TRIGGER action_result_requires_execution
    BEFORE INSERT ON action_results
    WHEN (SELECT state FROM action_plans WHERE plan_id = NEW.plan_id) NOT IN ('executing', 'uncertain')
    BEGIN
      SELECT RAISE(ABORT, 'action result requires an executing or uncertain plan');
    END;

    CREATE TRIGGER action_success_postcondition_matches_action
    BEFORE INSERT ON action_results
    WHEN NEW.result_kind = 'success' AND (
      ((SELECT action_kind FROM action_plans WHERE plan_id = NEW.plan_id) IN ('markSeen', 'markUnseen') AND NEW.postcondition_kind <> 'flags') OR
      ((SELECT action_kind FROM action_plans WHERE plan_id = NEW.plan_id) IN ('moveToArchive', 'moveToTrash') AND NEW.postcondition_kind <> 'mailbox')
    )
    BEGIN
      SELECT RAISE(ABORT, 'success postcondition does not match action kind');
    END;
  `,
} satisfies Migration;

/** A standalone set is convenient for focused schema tests and later composition. */
export const actionSchemaSequence = [actionSchemaMigration] as const;
