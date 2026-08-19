import type { Migration } from "../migration-runner";

/**
 * Authoritative content-addressed evidence for one canonical message. The
 * normalized MIME tables retain their presentation metadata; this table is
 * the integrity source for every raw/body/attachment digest and byte size.
 */
export const messageBlobReferencesMigration = {
  version: 3,
  name: "message-blob-references",
  sql: `
CREATE TABLE message_blob_references (
  message_id TEXT NOT NULL
    CHECK (
      length(message_id) = 72
      AND substr(message_id, 1, 8) = 'message:'
      AND substr(message_id, 9) NOT GLOB '*[^0-9a-f]*'
    ),
  kind TEXT NOT NULL CHECK (kind IN ('raw-eml', 'body-part', 'attachment')),
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal > 0),
  blob_id TEXT NOT NULL CHECK (
    length(blob_id) = 64 AND blob_id NOT GLOB '*[^0-9a-f]*'
  ),
  size INTEGER NOT NULL CHECK (typeof(size) = 'integer' AND size >= 0),
  PRIMARY KEY (message_id, kind, ordinal),
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((kind = 'raw-eml' AND ordinal = 1) OR kind <> 'raw-eml')
);

CREATE UNIQUE INDEX message_blob_references_raw
  ON message_blob_references (message_id, kind)
  WHERE kind = 'raw-eml';

CREATE INDEX message_blob_references_by_blob
  ON message_blob_references (blob_id);

CREATE TRIGGER message_blob_references_reject_update
BEFORE UPDATE ON message_blob_references
BEGIN
  SELECT RAISE(ABORT, 'message blob references are immutable');
END;

CREATE TRIGGER message_blob_references_reject_delete
BEFORE DELETE ON message_blob_references
BEGIN
  SELECT RAISE(ABORT, 'message blob references are immutable');
END;
`,
} satisfies Migration;

export const messageBlobReferencesSequence = [messageBlobReferencesMigration] as const;
