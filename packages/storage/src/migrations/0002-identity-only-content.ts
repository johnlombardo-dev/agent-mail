import type { Migration } from "../migration-runner";

/**
 * Identity-only content is kept in its own table so absence is never encoded
 * as an empty blob or as a nullable body/attachment value. The application
 * migration registry assigns the final contiguous version when this
 * standalone definition is composed with the other message migrations.
 */
export const IDENTITY_ONLY_CONTENT_MIGRATION_VERSION = 2;

export const identityOnlyContentMigration = {
  version: IDENTITY_ONLY_CONTENT_MIGRATION_VERSION,
  name: "identity-only-content",
  sql: `
    CREATE UNIQUE INDEX remote_placements_identity_with_message
      ON remote_placements (account_id, mailbox_id, uid_validity, uid, message_id);

    CREATE TABLE message_content_states (
      message_id TEXT PRIMARY KEY NOT NULL,
      content_kind TEXT NOT NULL CHECK (content_kind = 'identity-only'),
      account_id TEXT NOT NULL CHECK (
        length(account_id) > 8 AND
        substr(account_id, 1, 8) = 'account:' AND
        account_id = trim(account_id)
      ),
      mailbox_id TEXT NOT NULL CHECK (
        length(mailbox_id) > 8 AND
        substr(mailbox_id, 1, 8) = 'mailbox:' AND
        mailbox_id = trim(mailbox_id)
      ),
      uid_validity INTEGER NOT NULL CHECK (
        typeof(uid_validity) = 'integer' AND
        uid_validity > 0 AND
        uid_validity <= 4294967295
      ),
      uid INTEGER NOT NULL CHECK (
        typeof(uid) = 'integer' AND
        uid > 0 AND
        uid <= 4294967295
      ),
      absence_reason TEXT NOT NULL CHECK (
        absence_reason IN ('not-fetched', 'provider-unavailable', 'redacted')
      ),
      observed_at TEXT NOT NULL CHECK (
        length(observed_at) = 24 AND
        strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) = observed_at
      ),
      stored_at TEXT NOT NULL CHECK (
        length(stored_at) = 24 AND
        strftime('%Y-%m-%dT%H:%M:%fZ', stored_at) = stored_at AND
        stored_at >= observed_at
      ),
      FOREIGN KEY (message_id) REFERENCES messages(message_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      FOREIGN KEY (account_id, mailbox_id, uid_validity)
        REFERENCES mailbox_checkpoints(account_id, mailbox_id, uid_validity)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      FOREIGN KEY (account_id, mailbox_id, uid_validity, uid, message_id)
        REFERENCES remote_placements(account_id, mailbox_id, uid_validity, uid, message_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE INDEX message_content_states_remote_identity
      ON message_content_states (account_id, mailbox_id, uid_validity, uid);
  `,
} satisfies Migration;

/** A standalone set is convenient for focused schema and repository tests. */
export const identityOnlyContentMigrations = [identityOnlyContentMigration] as const;
