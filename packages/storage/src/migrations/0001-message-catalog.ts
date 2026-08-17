import type { Migration } from "../migration-runner";

/**
 * The message-catalog migration is kept as a standalone definition because
 * other workers may contribute independent first migrations. The application
 * migration list must assign its final contiguous version when those
 * definitions are assembled.
 */
export const messageCatalogMigration: Migration = {
  version: 1,
  name: "message-catalog",
  sql: `
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY NOT NULL
        CHECK (
          length(message_id) = 72 AND
          substr(message_id, 1, 8) = 'message:' AND
          substr(message_id, 9) NOT GLOB '*[^0-9a-f]*'
        )
    );

    CREATE TABLE mailbox_checkpoints (
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
      PRIMARY KEY (account_id, mailbox_id, uid_validity)
    );

    CREATE TABLE remote_placements (
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
      message_id TEXT NOT NULL,
      tombstone_observed_at TEXT,
      tombstone_reason TEXT,
      PRIMARY KEY (account_id, mailbox_id, uid_validity, uid),
      FOREIGN KEY (message_id) REFERENCES messages(message_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      FOREIGN KEY (account_id, mailbox_id, uid_validity)
        REFERENCES mailbox_checkpoints(account_id, mailbox_id, uid_validity)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CHECK (
        (tombstone_observed_at IS NULL AND tombstone_reason IS NULL) OR
        (
          tombstone_observed_at IS NOT NULL AND
          length(tombstone_observed_at) = 24 AND
          strftime('%Y-%m-%dT%H:%M:%fZ', tombstone_observed_at) = tombstone_observed_at AND
          tombstone_reason IS NOT NULL AND
          length(trim(tombstone_reason)) > 0
        )
      )
    );
  `,
};

/** A standalone set is convenient for focused schema tests and later composition. */
export const messageCatalogMigrations = [messageCatalogMigration] as const;
