import type { Migration } from "../migration-runner";

/**
 * Structured MIME metadata is deliberately separate from message identity and
 * placement. The application migration registry assigns the final contiguous
 * order when this definition is composed with other independently delivered
 * migrations.
 */
export const STRUCTURED_CONTENT_MIGRATION_VERSION = 2;

export const structuredContentMigration = {
  version: STRUCTURED_CONTENT_MIGRATION_VERSION,
  name: "structured-content",
  sql: `
    CREATE TABLE message_headers (
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (
        typeof(ordinal) = 'integer' AND ordinal > 0
      ),
      name TEXT NOT NULL CHECK (
        length(name) BETWEEN 1 AND 255 AND
        name = trim(name) AND
        instr(name, char(0)) = 0
      ),
      normalized_name TEXT NOT NULL CHECK (
        length(normalized_name) BETWEEN 1 AND 255 AND
        normalized_name = trim(normalized_name) AND
        normalized_name = lower(normalized_name) AND
        instr(normalized_name, char(0)) = 0
      ),
      value TEXT NOT NULL CHECK (
        length(value) BETWEEN 1 AND 4096 AND
        instr(value, char(0)) = 0
      ),
      normalized_value TEXT NOT NULL CHECK (
        length(normalized_value) BETWEEN 1 AND 4096 AND
        instr(normalized_value, char(0)) = 0
      ),
      PRIMARY KEY (message_id, ordinal),
      FOREIGN KEY (message_id) REFERENCES messages(message_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE TABLE message_addresses (
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (
        typeof(ordinal) = 'integer' AND ordinal > 0
      ),
      role TEXT NOT NULL CHECK (
        role IN ('from', 'sender', 'reply_to', 'to', 'cc', 'bcc')
      ),
      position INTEGER NOT NULL CHECK (
        typeof(position) = 'integer' AND position > 0
      ),
      address TEXT NOT NULL CHECK (
        length(address) BETWEEN 1 AND 1024 AND
        address = trim(address) AND
        instr(address, char(0)) = 0
      ),
      normalized_address TEXT NOT NULL CHECK (
        length(normalized_address) BETWEEN 1 AND 1024 AND
        normalized_address = trim(normalized_address) AND
        instr(normalized_address, char(0)) = 0
      ),
      display_name TEXT CHECK (
        display_name IS NULL OR (
          length(display_name) BETWEEN 1 AND 4096 AND
          instr(display_name, char(0)) = 0
        )
      ),
      group_name TEXT CHECK (
        group_name IS NULL OR (
          length(group_name) BETWEEN 1 AND 4096 AND
          instr(group_name, char(0)) = 0
        )
      ),
      PRIMARY KEY (message_id, ordinal),
      UNIQUE (message_id, role, position),
      FOREIGN KEY (message_id) REFERENCES messages(message_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE TABLE message_body_parts (
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (
        typeof(ordinal) = 'integer' AND ordinal > 0
      ),
      content_type TEXT NOT NULL CHECK (
        length(content_type) BETWEEN 1 AND 255 AND
        content_type = trim(content_type) AND
        instr(content_type, char(0)) = 0
      ),
      normalized_content_type TEXT NOT NULL CHECK (
        length(normalized_content_type) BETWEEN 1 AND 255 AND
        normalized_content_type = trim(normalized_content_type) AND
        normalized_content_type = lower(normalized_content_type) AND
        instr(normalized_content_type, char(0)) = 0
      ),
      blob_id TEXT NOT NULL CHECK (
        length(blob_id) = 64 AND
        blob_id NOT GLOB '*[^0-9a-f]*'
      ),
      PRIMARY KEY (message_id, ordinal),
      FOREIGN KEY (message_id) REFERENCES messages(message_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE TABLE message_attachments (
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (
        typeof(ordinal) = 'integer' AND ordinal > 0
      ),
      filename TEXT CHECK (
        filename IS NULL OR (
          length(filename) BETWEEN 1 AND 4096 AND
          instr(filename, char(0)) = 0
        )
      ),
      content_type TEXT NOT NULL CHECK (
        length(content_type) BETWEEN 1 AND 255 AND
        content_type = trim(content_type) AND
        instr(content_type, char(0)) = 0
      ),
      normalized_content_type TEXT NOT NULL CHECK (
        length(normalized_content_type) BETWEEN 1 AND 255 AND
        normalized_content_type = trim(normalized_content_type) AND
        normalized_content_type = lower(normalized_content_type) AND
        instr(normalized_content_type, char(0)) = 0
      ),
      disposition TEXT CHECK (
        disposition IS NULL OR (
          length(disposition) BETWEEN 1 AND 255 AND
          disposition = trim(disposition) AND
          instr(disposition, char(0)) = 0
        )
      ),
      content_id TEXT CHECK (
        content_id IS NULL OR (
          length(content_id) BETWEEN 1 AND 1024 AND
          content_id = trim(content_id) AND
          instr(content_id, char(0)) = 0
        )
      ),
      size INTEGER NOT NULL CHECK (
        typeof(size) = 'integer' AND size >= 0
      ),
      blob_id TEXT NOT NULL CHECK (
        length(blob_id) = 64 AND
        blob_id NOT GLOB '*[^0-9a-f]*'
      ),
      PRIMARY KEY (message_id, ordinal),
      FOREIGN KEY (message_id) REFERENCES messages(message_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE INDEX message_headers_name
      ON message_headers (message_id, normalized_name, ordinal);
    CREATE INDEX message_addresses_lookup
      ON message_addresses (message_id, role, normalized_address, ordinal);
  `,
} satisfies Migration;

/** A standalone set supports focused schema tests and later registry composition. */
export const structuredContentSequence = [structuredContentMigration] as const;
