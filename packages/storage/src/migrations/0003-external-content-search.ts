import type { Migration } from "../migration-runner";

/**
 * The weights are kept with the schema contract so a later query adapter
 * cannot silently reorder the FTS columns when it builds a bm25 expression.
 */
export const MESSAGE_FTS_BM25_WEIGHTS = {
  subject: 10,
  participants: 4,
  bodyPlain: 3,
  bodyHtml: 2,
  attachmentNames: 1,
} as const;

export const externalContentSearchMigration = {
  version: 3,
  name: "external-content-search",
  sql: `
    ALTER TABLE message_body_parts
      ADD COLUMN plain_text TEXT NOT NULL DEFAULT ''
        CHECK (
          typeof(plain_text) = 'text' AND
          length(CAST(plain_text AS BLOB)) <= 8388608 AND
          instr(plain_text, char(0)) = 0
        );

    ALTER TABLE message_body_parts
      ADD COLUMN html_derived_text TEXT NOT NULL DEFAULT ''
        CHECK (
          typeof(html_derived_text) = 'text' AND
          length(CAST(html_derived_text AS BLOB)) <= 8388608 AND
          instr(html_derived_text, char(0)) = 0
        );

    CREATE TABLE message_search_documents (
      document_id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE
        CHECK (
          length(message_id) = 72 AND
          substr(message_id, 1, 8) = 'message:' AND
          substr(message_id, 9) NOT GLOB '*[^0-9a-f]*'
        ),
      FOREIGN KEY (message_id) REFERENCES messages(message_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    );

    CREATE TRIGGER message_search_documents_reject_update
    BEFORE UPDATE ON message_search_documents
    BEGIN
      SELECT RAISE(ABORT, 'search document identity is immutable');
    END;

    CREATE TRIGGER message_search_documents_reject_delete
    BEFORE DELETE ON message_search_documents
    BEGIN
      SELECT RAISE(ABORT, 'search document identity is immutable');
    END;

    CREATE VIEW indexed_messages AS
      SELECT
        d.document_id AS rowid,
        m.message_id AS message_id,
        COALESCE((
          SELECT h.normalized_value
          FROM message_headers h
          WHERE h.message_id = m.message_id AND h.normalized_name = 'subject'
          ORDER BY h.ordinal
          LIMIT 1
        ), '') AS subject,
        COALESCE((
          SELECT group_concat(address, ' ')
          FROM (
            SELECT a.normalized_address AS address
            FROM message_addresses a
            WHERE a.message_id = m.message_id
            ORDER BY a.ordinal
          )
        ), '') AS participants,
        COALESCE((
          SELECT group_concat(body_text, ' ')
          FROM (
            SELECT p.plain_text AS body_text
            FROM message_body_parts p
            WHERE p.message_id = m.message_id
              AND p.normalized_content_type LIKE 'text/plain%'
              AND length(trim(p.plain_text)) > 0
            ORDER BY p.ordinal
          )
        ), '') AS body_plain,
        COALESCE((
          SELECT group_concat(body_text, ' ')
          FROM (
            SELECT p.html_derived_text AS body_text
            FROM message_body_parts p
            WHERE p.message_id = m.message_id
              AND p.normalized_content_type LIKE 'text/html%'
              AND length(trim(p.html_derived_text)) > 0
            ORDER BY p.ordinal
          )
        ), '') AS body_html,
        COALESCE((
          SELECT group_concat(filename, ' ')
          FROM (
            SELECT a.filename AS filename
            FROM message_attachments a
            WHERE a.message_id = m.message_id AND a.filename IS NOT NULL
            ORDER BY a.ordinal
          )
        ), '') AS attachment_names
      FROM message_search_documents d
      JOIN messages m ON m.message_id = d.message_id;

    CREATE VIRTUAL TABLE message_fts USING fts5(
      subject,
      participants,
      body_plain,
      body_html,
      attachment_names,
      content='indexed_messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
  `,
} satisfies Migration;

/** A dependency-complete set is convenient for focused FTS schema tests. */
export const externalContentSearchSequence = [externalContentSearchMigration] as const;
