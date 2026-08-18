import type { Migration } from "../migration-runner";

/** Durable v1 thread authority. Callers may remap this extension into their composed sequence. */
export const THREAD_GRAPH_MIGRATION_VERSION = 8;

export const threadGraphMigration = {
  version: THREAD_GRAPH_MIGRATION_VERSION,
  name: "thread-graph",
  sql: `
CREATE TABLE thread_generation (
  generation_id INTEGER PRIMARY KEY CHECK (generation_id = 1),
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 0)
);
INSERT INTO thread_generation (generation_id, generation) VALUES (1, 0);

CREATE TABLE thread_header_facts (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content_state TEXT NOT NULL CHECK (content_state IN ('identity-only', 'parsed')),
  normalizer_version TEXT NOT NULL CHECK (normalizer_version = 'thread-normalizer-v1'),
  member_node_key TEXT NOT NULL CHECK (member_node_key GLOB 'm:*'),
  message_id_node_key TEXT,
  references_json TEXT NOT NULL CHECK (json_valid(references_json) AND json_type(references_json) = 'array'),
  in_reply_to_json TEXT NOT NULL CHECK (json_valid(in_reply_to_json) AND json_type(in_reply_to_json) = 'array'),
  sent_at TEXT,
  received_at TEXT,
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'),
  facts_sha256 TEXT NOT NULL CHECK (length(facts_sha256) = 64 AND facts_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (account_id, message_id),
  CHECK (message_id_node_key IS NULL OR message_id_node_key GLOB 'i:*'),
  CHECK (json_array_length(references_json) <= 100),
  CHECK (json_array_length(in_reply_to_json) <= 32)
);
CREATE INDEX thread_header_facts_message_id_node ON thread_header_facts (account_id, message_id_node_key);

CREATE TABLE thread_sets (
  account_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  member_count INTEGER NOT NULL CHECK (member_count >= 0),
  node_count INTEGER NOT NULL CHECK (node_count >= 0),
  equivalence_count INTEGER NOT NULL CHECK (equivalence_count >= 0),
  edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
  participant_count INTEGER NOT NULL CHECK (participant_count >= 0),
  participants_truncated INTEGER NOT NULL DEFAULT 0 CHECK (participants_truncated IN (0, 1)),
  handle_count INTEGER NOT NULL CHECK (handle_count >= 0),
  canonical_root_node_key TEXT NOT NULL,
  canonical_thread_id TEXT NOT NULL,
  updated_generation INTEGER NOT NULL CHECK (updated_generation >= 0),
  PRIMARY KEY (account_id, set_id),
  UNIQUE (account_id, canonical_thread_id)
);
CREATE INDEX thread_sets_weight ON thread_sets (account_id, member_count, set_id);

CREATE TABLE thread_nodes (
  account_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  set_id TEXT NOT NULL,
  class_key TEXT NOT NULL,
  incoming_ancestry_count INTEGER NOT NULL DEFAULT 0 CHECK (incoming_ancestry_count >= 0),
  PRIMARY KEY (account_id, node_key),
  UNIQUE (account_id, class_key, node_key),
  FOREIGN KEY (account_id, set_id) REFERENCES thread_sets(account_id, set_id) ON DELETE RESTRICT
);
CREATE INDEX thread_nodes_set_class ON thread_nodes (account_id, set_id, class_key, incoming_ancestry_count, node_key);
CREATE INDEX thread_nodes_set ON thread_nodes (account_id, set_id);

CREATE TABLE thread_equivalences (
  account_id TEXT NOT NULL,
  member_node_key TEXT NOT NULL,
  set_id TEXT NOT NULL,
  message_id_node_key TEXT,
  message_id TEXT NOT NULL,
  PRIMARY KEY (account_id, member_node_key),
  FOREIGN KEY (account_id, set_id) REFERENCES thread_sets(account_id, set_id) ON DELETE RESTRICT
);
CREATE INDEX thread_equivalences_set_member ON thread_equivalences (account_id, set_id, member_node_key);
CREATE INDEX thread_equivalences_message_id ON thread_equivalences (account_id, message_id_node_key, member_node_key);

CREATE TABLE thread_edges (
  account_id TEXT NOT NULL,
  source_class_key TEXT NOT NULL,
  target_class_key TEXT NOT NULL,
  set_id TEXT NOT NULL,
  first_message_id TEXT NOT NULL,
  first_field TEXT NOT NULL CHECK (first_field IN ('references', 'in-reply-to')),
  first_ordinal INTEGER NOT NULL CHECK (first_ordinal > 0),
  PRIMARY KEY (account_id, source_class_key, target_class_key),
  CHECK (source_class_key <> target_class_key),
  FOREIGN KEY (account_id, set_id) REFERENCES thread_sets(account_id, set_id) ON DELETE RESTRICT
);
CREATE INDEX thread_edges_set ON thread_edges (account_id, set_id, source_class_key, target_class_key);
CREATE INDEX thread_edges_target ON thread_edges (account_id, target_class_key);
CREATE INDEX thread_edges_source ON thread_edges (account_id, source_class_key);

CREATE TABLE thread_memberships (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  member_node_key TEXT NOT NULL,
  order_state TEXT NOT NULL CHECK (order_state IN ('identity-only', 'parsed')),
  sent_at TEXT,
  sent_at_missing_rank INTEGER NOT NULL CHECK (sent_at_missing_rank IN (0, 1)),
  received_at TEXT,
  added_generation INTEGER NOT NULL CHECK (added_generation >= 0),
  PRIMARY KEY (account_id, message_id),
  FOREIGN KEY (account_id, set_id) REFERENCES thread_sets(account_id, set_id) ON DELETE RESTRICT
);
CREATE INDEX thread_memberships_order ON thread_memberships (account_id, set_id, sent_at_missing_rank, sent_at, message_id);
CREATE INDEX thread_memberships_received ON thread_memberships (account_id, set_id, received_at, message_id);

CREATE TABLE thread_participants (
  account_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  display_name TEXT,
  first_sent_at_missing_rank INTEGER NOT NULL CHECK (first_sent_at_missing_rank IN (0, 1)),
  first_sent_at TEXT,
  first_message_id TEXT NOT NULL,
  first_role_rank INTEGER NOT NULL CHECK (first_role_rank BETWEEN 0 AND 3),
  first_position INTEGER NOT NULL CHECK (first_position > 0),
  PRIMARY KEY (account_id, set_id, normalized_address),
  FOREIGN KEY (account_id, set_id) REFERENCES thread_sets(account_id, set_id) ON DELETE RESTRICT
);
CREATE INDEX thread_participants_order ON thread_participants (account_id, set_id, first_sent_at_missing_rank, first_sent_at, first_message_id, first_role_rank, first_position);

CREATE TABLE thread_handles (
  thread_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  created_generation INTEGER NOT NULL CHECK (created_generation >= 0),
  canonical_when_created INTEGER NOT NULL CHECK (canonical_when_created IN (0, 1)),
  FOREIGN KEY (account_id, set_id) REFERENCES thread_sets(account_id, set_id) ON DELETE RESTRICT
);
CREATE INDEX thread_handles_set ON thread_handles (account_id, set_id, thread_id);

CREATE TABLE thread_merges (
  account_id TEXT NOT NULL,
  losing_thread_id TEXT NOT NULL,
  merge_generation INTEGER NOT NULL CHECK (merge_generation >= 0),
  winning_thread_id TEXT NOT NULL,
  bridge_message_id TEXT NOT NULL,
  previous_root_node_key TEXT NOT NULL,
  current_root_node_key TEXT NOT NULL,
  PRIMARY KEY (account_id, losing_thread_id, merge_generation),
  FOREIGN KEY (losing_thread_id) REFERENCES thread_handles(thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (winning_thread_id) REFERENCES thread_handles(thread_id) ON DELETE RESTRICT
);
CREATE INDEX thread_merges_winner ON thread_merges (account_id, winning_thread_id, merge_generation);
`,
} satisfies Migration;

export const threadGraphMigrations = [threadGraphMigration] as const;
export const threadMigration = threadGraphMigration;
export const threadMigrations = threadGraphMigrations;
