#!/usr/bin/env bun
/**
 * Deterministic, disposable P4-C16 search fixture.
 *
 * This is deliberately a bulk fixture writer rather than a production ingest
 * path. It applies the real message/placement/content/search/label migrations,
 * writes only values accepted by those constraints, and asks SQLite to rebuild
 * the external-content FTS index from its source view.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase } from "../../packages/storage/src/database";

export const DEFAULT_SEED = 116_2026;
export const DEFAULT_COUNT = 250_000;
export const CORPUS_VERSION = "p4-c16-v1";

const labels = [
  "label:important",
  "label:finance",
  "label:newsletter",
  "label:follow-up",
  "label:travel",
] as const;
const mailboxes = ["mailbox:inbox", "mailbox:archive", "mailbox:sent", "mailbox:projects"] as const;
const terms = [
  "atlas",
  "beacon",
  "cobalt",
  "delta",
  "ember",
  "fjord",
  "harbor",
  "lumen",
  "orbit",
  "quartz",
] as const;
const senders = ["alice", "bob", "carol", "david", "erin", "frank", "grace", "heidi"] as const;

export type CorpusInventory = Readonly<{
  readonly version: string;
  readonly seed: number;
  readonly messages: number;
  readonly placements: number;
  readonly livePlacements: number;
  readonly tombstones: number;
  readonly labels: number;
  readonly labelAssignments: number;
  readonly searchDocuments: number;
  readonly ftsRows: number;
  readonly querySelectivities: Readonly<Record<string, number>>;
  readonly queryIdentityDigests: Readonly<Record<string, string>>;
  readonly schemaIndexCounts: Readonly<Record<string, number>>;
  readonly schemaIndexTotal: number;
  readonly bytes: number;
  readonly logicalChecksum: string;
}>;

type CountRow = Readonly<{ readonly count: number }>;

const representativeQueries = ["atlas", "beacon", '"status update"'] as const;

function countRows(database: Database, sql: string, parameter?: string): number {
  const row =
    parameter === undefined
      ? database.query<CountRow, []>(sql).get()
      : database.query<CountRow, [string]>(sql).get(parameter);
  return Number(row?.count ?? 0);
}

function queryIdentityDigest(database: Database, query: string): string {
  const hash = createHash("sha256");
  const rows = database
    .query<{ message_id: string }, [string]>(
      "SELECT d.message_id FROM message_fts f JOIN message_search_documents d ON d.document_id = f.rowid WHERE message_fts MATCH ? ORDER BY d.message_id;",
    )
    .all(query);
  for (const row of rows) hash.update(`${row.message_id}\n`);
  return hash.digest("hex");
}

function schemaIndexCounts(database: Database): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const row of database
    .query<{ tbl_name: string }, []>(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY tbl_name, name;",
    )
    .all())
    counts[row.tbl_name] = (counts[row.tbl_name] ?? 0) + 1;
  return Object.freeze(counts);
}

/** Validate the real SQLite artifact, including relationships a count-only inventory can miss. */
export function validateCorpusInventory(database: Database, expected: CorpusInventory): void {
  database.exec("PRAGMA foreign_keys = ON;");
  const integrity = database
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check;")
    .get();
  if (integrity?.integrity_check !== "ok")
    throw new Error(
      `SQLite integrity check failed: ${integrity?.integrity_check ?? "missing result"}`,
    );
  const foreignKeys = database.query("PRAGMA foreign_key_check;").all();
  if (foreignKeys.length > 0)
    throw new Error(`foreign-key invariant failed (${foreignKeys.length} rows)`);
  for (const table of [
    "messages",
    "remote_placements",
    "message_headers",
    "message_addresses",
    "message_body_parts",
    "message_search_documents",
    "message_fts",
    "local_labels",
    "local_label_assignments",
  ]) {
    if (database.query("SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1;").get(table) === null)
      throw new Error(`required schema object missing: ${table}`);
  }
  const actualIndexes = schemaIndexCounts(database);
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expected.schemaIndexCounts))
    throw new Error("schema index inventory mismatch");
  if (
    Object.values(actualIndexes).reduce((sum, value) => sum + value, 0) !==
    expected.schemaIndexTotal
  )
    throw new Error("schema index total mismatch");
  const actualMessages = countRows(database, "SELECT COUNT(*) AS count FROM messages;");
  if (actualMessages !== expected.messages) throw new Error("message inventory mismatch");
  const placementMissing = countRows(
    database,
    "SELECT COUNT(*) AS count FROM messages WHERE message_id NOT IN (SELECT DISTINCT message_id FROM remote_placements);",
  );
  if (placementMissing !== 0) throw new Error("placement invariant failed");
  const contentMissing = countRows(
    database,
    "SELECT COUNT(*) AS count FROM messages WHERE message_id NOT IN (SELECT DISTINCT message_id FROM message_headers WHERE normalized_name = 'subject') OR message_id NOT IN (SELECT DISTINCT message_id FROM message_body_parts WHERE normalized_content_type = 'text/plain');",
  );
  if (contentMissing !== 0) throw new Error("normalized content invariant failed");
  const documentMissing = countRows(
    database,
    "SELECT COUNT(*) AS count FROM messages m WHERE NOT EXISTS (SELECT 1 FROM message_search_documents d WHERE d.message_id = m.message_id);",
  );
  if (
    documentMissing !== 0 ||
    countRows(database, "SELECT COUNT(*) AS count FROM message_search_documents;") !==
      expected.searchDocuments
  )
    throw new Error("search document invariant failed");
  if (
    countRows(database, "SELECT COUNT(*) AS count FROM message_fts;") !== expected.ftsRows ||
    expected.ftsRows !== expected.searchDocuments
  )
    throw new Error("FTS row inventory mismatch");
  if (
    countRows(
      database,
      "SELECT COUNT(*) AS count FROM message_fts f WHERE NOT EXISTS (SELECT 1 FROM message_search_documents d WHERE d.document_id = f.rowid);",
    ) !== 0
  )
    throw new Error("FTS source relationship failed");
  if (
    countRows(database, "SELECT COUNT(*) AS count FROM remote_placements;") !==
      expected.placements ||
    countRows(
      database,
      "SELECT COUNT(*) AS count FROM remote_placements WHERE tombstone_observed_at IS NULL;",
    ) !== expected.livePlacements ||
    countRows(
      database,
      "SELECT COUNT(*) AS count FROM remote_placements WHERE tombstone_observed_at IS NOT NULL;",
    ) !== expected.tombstones
  )
    throw new Error("placement inventory mismatch");
  if (
    countRows(database, "SELECT COUNT(*) AS count FROM local_labels;") !== expected.labels ||
    countRows(database, "SELECT COUNT(*) AS count FROM local_label_assignments;") !==
      expected.labelAssignments
  )
    throw new Error("label inventory mismatch");
  for (const query of representativeQueries) {
    const selectivity = countRows(
      database,
      "SELECT COUNT(*) AS count FROM message_fts WHERE message_fts MATCH ?;",
      query,
    );
    if (
      selectivity !== expected.querySelectivities[query] ||
      queryIdentityDigest(database, query) !== expected.queryIdentityDigests[query]
    )
      throw new Error(`query identity inventory mismatch: ${query}`);
  }
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)]!;
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

function messageId(index: number, seed: number): string {
  return `message:${createHash("sha256").update(`${CORPUS_VERSION}:${seed}:${index}`).digest("hex")}`;
}

function iso(index: number): string {
  const date = new Date(
    Date.UTC(
      2020 + (index % 7),
      index % 12,
      (index % 27) + 1,
      index % 24,
      index % 60,
      index % 60,
      index % 1000,
    ),
  );
  return date.toISOString();
}

function hashLogical(database: Database): string {
  const hash = createHash("sha256");
  const tables = [
    ["messages", "SELECT message_id FROM messages ORDER BY message_id;"],
    [
      "placements",
      "SELECT account_id,mailbox_id,uid_validity,uid,message_id,internal_date,flags_json,tombstone_observed_at,tombstone_reason FROM remote_placements ORDER BY account_id,mailbox_id,uid_validity,uid;",
    ],
    [
      "headers",
      "SELECT message_id,ordinal,normalized_name,normalized_value FROM message_headers ORDER BY message_id,ordinal;",
    ],
    [
      "addresses",
      "SELECT message_id,ordinal,role,position,normalized_address FROM message_addresses ORDER BY message_id,ordinal;",
    ],
    [
      "bodies",
      "SELECT message_id,ordinal,normalized_content_type,plain_text,html_derived_text FROM message_body_parts ORDER BY message_id,ordinal;",
    ],
    [
      "labels",
      "SELECT message_id,label,rule_id,rule_version,matched_facts_json,decided_at,provenance_source,provenance_evaluation_id FROM local_label_assignments ORDER BY message_id,label;",
    ],
  ] as const;
  for (const [name, sql] of tables) {
    hash.update(`${name}\n`);
    for (const row of database.query(sql).all()) hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest("hex");
}

export async function generateCorpus(
  outputPath: string,
  corpusCount = DEFAULT_COUNT,
  seed = DEFAULT_SEED,
): Promise<CorpusInventory> {
  if (!isAbsolute(outputPath)) throw new TypeError("output path must be absolute");
  if (!Number.isSafeInteger(corpusCount) || corpusCount < 1)
    throw new TypeError("count must be a positive integer");
  const root = dirname(outputPath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const opened = await openDatabase(outputPath);
  try {
    const db = opened.db;
    db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    db.query(
      "INSERT INTO mailbox_checkpoints (account_id,mailbox_id,uid_validity) VALUES (?,?,?);",
    ).run("account:capacity", mailboxes[0], 1);
    for (const mailbox of mailboxes.slice(1))
      db.query(
        "INSERT INTO mailbox_checkpoints (account_id,mailbox_id,uid_validity) VALUES (?,?,?);",
      ).run("account:capacity", mailbox, 1);
    for (const label of labels) db.query("INSERT INTO local_labels(label) VALUES (?);").run(label);
    const rng = new Rng(seed);
    const insertMessage = db.query("INSERT INTO messages(message_id) VALUES (?);");
    const insertHeader = db.query(
      "INSERT INTO message_headers(message_id,ordinal,name,normalized_name,value,normalized_value) VALUES (?,?,?,?,?,?);",
    );
    const insertAddress = db.query(
      "INSERT INTO message_addresses(message_id,ordinal,role,position,address,normalized_address,display_name,group_name) VALUES (?,?,?,?,?,?,?,?);",
    );
    const insertBody = db.query(
      "INSERT INTO message_body_parts(message_id,ordinal,content_type,normalized_content_type,blob_id,plain_text,html_derived_text) VALUES (?,?,?,?,?,?,?);",
    );
    const insertPlacement = db.query(
      "INSERT INTO remote_placements(account_id,mailbox_id,uid_validity,uid,message_id,internal_date,flags_json,modseq_known,modseq,observation_order,observation_observed_at,observation_checkpoint,tombstone_observed_at,tombstone_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);",
    );
    const insertAssignment = db.query(
      "INSERT INTO local_label_assignments(message_id,label,rule_id,rule_version,matched_facts_json,decided_at,provenance_source,provenance_evaluation_id) VALUES (?,?,?,?,?,?,?,?);",
    );
    db.exec("BEGIN;");
    for (let i = 0; i < corpusCount; i += 1) {
      const id = messageId(i, seed);
      const term = i % 10 === 0 ? "atlas" : rng.pick(terms);
      const subject = `${term} ${i % 20 === 0 ? "status update" : "weekly note"}`;
      const body = `Meeting notes for ${term}. Reference ${terms[(i + 3) % terms.length]} and ${term}; deterministic message ${i}.`;
      const sender = `${rng.pick(senders)}@example.test`;
      const date = iso(i);
      insertMessage.run(id);
      insertHeader.run(id, 1, "Subject", "subject", subject, subject.toLowerCase());
      insertAddress.run(id, 1, "from", 1, sender, sender, null, null);
      insertAddress.run(id, 2, "to", 1, "archive@example.test", "archive@example.test", null, null);
      insertBody.run(
        id,
        1,
        "text/plain",
        "text/plain",
        createHash("sha256").update(id).digest("hex"),
        body,
        "",
      );
      const placements = i % 17 === 0 ? 2 : 1;
      for (let placement = 0; placement < placements; placement += 1) {
        const mailbox = mailboxes[(i + placement) % mailboxes.length]!;
        const tombstoned = (i + placement) % 13 === 0;
        const flags = i % 11 === 0 ? ["\\Seen", "\\Flagged"] : i % 3 === 0 ? ["\\Seen"] : [];
        insertPlacement.run(
          "account:capacity",
          mailbox,
          1,
          i + 1 + placement * corpusCount,
          id,
          date,
          JSON.stringify(flags),
          1,
          i + 1,
          i + 1,
          date,
          `checkpoint:capacity:${mailbox}:1`,
          tombstoned ? date : null,
          tombstoned ? "absent from completed mailbox sweep" : null,
        );
      }
      if (i % 4 === 0) {
        const label = labels[(i / 4) % labels.length]!;
        insertAssignment.run(
          id,
          label,
          "rule:capacity",
          1,
          JSON.stringify(["fixture", term]),
          date,
          "capacity-fixture",
          `evaluation:capacity:${i}`,
        );
      }
    }
    db.exec("COMMIT;");
    db.exec(
      "INSERT INTO message_search_documents(message_id) SELECT message_id FROM messages ORDER BY message_id;",
    );
    db.exec("INSERT INTO message_fts(message_fts) VALUES ('rebuild');");
    // Make the reported artifact size stable and include WAL-backed pages.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const querySelectivities: Record<string, number> = {};
    const queryIdentityDigests: Record<string, string> = {};
    for (const query of representativeQueries) {
      querySelectivities[query] = countRows(
        db,
        "SELECT COUNT(*) AS count FROM message_fts WHERE message_fts MATCH ?;",
        query,
      );
      queryIdentityDigests[query] = queryIdentityDigest(db, query);
    }
    const indexes = schemaIndexCounts(db);
    const inventory: CorpusInventory = {
      version: CORPUS_VERSION,
      seed,
      messages: corpusCount,
      placements: countRows(db, "SELECT COUNT(*) AS count FROM remote_placements;"),
      livePlacements: countRows(
        db,
        "SELECT COUNT(*) AS count FROM remote_placements WHERE tombstone_observed_at IS NULL;",
      ),
      tombstones: countRows(
        db,
        "SELECT COUNT(*) AS count FROM remote_placements WHERE tombstone_observed_at IS NOT NULL;",
      ),
      labels: labels.length,
      labelAssignments: countRows(db, "SELECT COUNT(*) AS count FROM local_label_assignments;"),
      searchDocuments: countRows(db, "SELECT COUNT(*) AS count FROM message_search_documents;"),
      ftsRows: countRows(db, "SELECT COUNT(*) AS count FROM message_fts;"),
      querySelectivities,
      queryIdentityDigests,
      schemaIndexCounts: indexes,
      schemaIndexTotal: Object.values(indexes).reduce((sum, value) => sum + value, 0),
      bytes: (await stat(outputPath)).size,
      logicalChecksum: hashLogical(db),
    };
    await Bun.write(`${outputPath}.inventory.json`, `${JSON.stringify(inventory, null, 2)}\n`);
    return inventory;
  } finally {
    await opened.close();
  }
}

if (import.meta.main) {
  const count = Number(process.argv[2] ?? DEFAULT_COUNT);
  const output = resolve(process.argv[3] ?? join(".artifacts", "p4-c16-search-corpus.sqlite"));
  const seed = Number(process.argv[4] ?? DEFAULT_SEED);
  console.log(JSON.stringify(await generateCorpus(output, count, seed), null, 2));
}
