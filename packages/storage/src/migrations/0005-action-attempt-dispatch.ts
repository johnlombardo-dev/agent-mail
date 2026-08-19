import type { Migration } from "../migration-runner";
import { actionAttemptStartSequence } from "./0004-action-attempt-start";

/** Immutable evidence that an unresolved attempt crossed command dispatch. */
export const actionAttemptDispatchMigration = {
  version: 5,
  name: "action-attempt-dispatch-evidence",
  sql: `
CREATE TABLE action_attempt_dispatches (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL,
  target_ordinal INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK (
    command_kind IN ('markSeen', 'markUnseen', 'moveToArchive', 'moveToTrash')
  ),
  dispatched_at TEXT NOT NULL CHECK (
    length(dispatched_at) = 24 AND
    substr(dispatched_at, 12, 2) BETWEEN '00' AND '23' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at) = dispatched_at AND
    dispatched_at >= started_at
  ),
  observation_kind TEXT NOT NULL CHECK (observation_kind = 'satisfied'),
  observation_at TEXT NOT NULL CHECK (
    length(observation_at) = 24 AND
    substr(observation_at, 12, 2) BETWEEN '00' AND '23' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', observation_at) = observation_at AND
    observation_at >= started_at AND observation_at <= dispatched_at
  ),
  observation_uid_validity INTEGER NOT NULL CHECK (
    typeof(observation_uid_validity) = 'integer' AND observation_uid_validity > 0
  ),
  observation_uid INTEGER NOT NULL CHECK (
    typeof(observation_uid) = 'integer' AND observation_uid > 0
  ),
  observation_modseq INTEGER NOT NULL CHECK (
    typeof(observation_modseq) = 'integer' AND observation_modseq >= 0
  ),
  UNIQUE (
    attempt_id, plan_id, target_ordinal, account_id, mailbox_id,
    uid_validity, uid, idempotency_key, started_at
  ),
  FOREIGN KEY (
    attempt_id, plan_id, target_ordinal, account_id, mailbox_id,
    uid_validity, uid, idempotency_key, started_at
  ) REFERENCES action_attempts(
    attempt_id, plan_id, target_ordinal, account_id, mailbox_id,
    uid_validity, uid, idempotency_key, started_at
  ) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TRIGGER action_attempt_dispatch_shape_guard
BEFORE INSERT ON action_attempt_dispatches
WHEN NOT EXISTS (
  SELECT 1 FROM action_attempts AS attempt
  WHERE attempt.attempt_id = NEW.attempt_id
    AND attempt.plan_id = NEW.plan_id
    AND attempt.target_ordinal = NEW.target_ordinal
    AND attempt.account_id = NEW.account_id
    AND attempt.mailbox_id = NEW.mailbox_id
    AND attempt.uid_validity = NEW.uid_validity
    AND attempt.uid = NEW.uid
    AND attempt.idempotency_key = NEW.idempotency_key
    AND attempt.started_at = NEW.started_at
    AND attempt.certainty = 'unresolved'
    AND attempt.action_kind = NEW.command_kind
    AND attempt.precondition_modseq = NEW.observation_modseq
    AND NEW.observation_uid_validity = NEW.uid_validity
    AND NEW.observation_uid = NEW.uid
)
BEGIN
  SELECT RAISE(ABORT, 'dispatch evidence does not match the unresolved attempt');
END;

CREATE TRIGGER action_attempt_dispatch_update_immutable
BEFORE UPDATE ON action_attempt_dispatches
BEGIN
  SELECT RAISE(ABORT, 'dispatch evidence is immutable');
END;

CREATE TRIGGER action_attempt_dispatch_delete_immutable
BEFORE DELETE ON action_attempt_dispatches
BEGIN
  SELECT RAISE(ABORT, 'dispatch evidence is immutable');
END;
`,
} satisfies Migration;

export const actionAttemptDispatchSequence = [
  ...actionAttemptStartSequence,
  actionAttemptDispatchMigration,
] as const;

export { actionAttemptDispatchSequence as actionAttemptDispatchMigrations };
