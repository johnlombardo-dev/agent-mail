import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateCorpus, validateCorpusInventory } from "../../../scripts/capacity/generate-search-corpus";
import { openDatabase } from "../src/database";
import {
  CANONICAL_DATABASE_SCHEMA_VERSION,
  canonicalDatabaseMigrations,
} from "../src/migration-registry";
import { migrationContentHash } from "../src/migration-runner";

const roots: string[] = [];
const referenceOracle = {
  version: "p4-c16-v1",
  seed: 1162026,
  messages: 128,
  placements: 136,
  livePlacements: 125,
  tombstones: 11,
  labels: 5,
  labelAssignments: 32,
  searchDocuments: 128,
  ftsRows: 128,
  threadSets: 4,
  threadNodes: 128,
  threadEquivalences: 128,
  threadMemberships: 128,
  threadHandles: 4,
  threadIdentityDigest: "8a1100773adc7904f1431bbf410324e354ae2f98a4acd6e368c3c53c63fa3d28",
  querySelectivities: { atlas: 33, beacon: 21, '"status update"': 7 },
  queryIdentityDigests: {
    atlas: "c73e843426c24d5a97623d2ac3e345d797550b193428ca77383bef7dfff2c203",
    beacon: "008f0a1dbcc31b4fec9466df55c4a3663aefd9d82926b38e6d4d4ecf86ab90d8",
    '"status update"': "c5dee6479c0bcf3728df50cbca8542bfb0f100e780a49ac59e8ef1098f892806",
  },
} as const;

type IndexTuple = Readonly<{
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}>;

type IndexOracle = Readonly<{
  readonly tuples: readonly IndexTuple[];
  readonly schemaIndexCounts: Readonly<Record<string, number>>;
  readonly schemaIndexTotal: number;
  readonly digest: string;
}>;

function readIndexTuples(database: Database): readonly IndexTuple[] {
  return database
    .query<IndexTuple, []>(
      "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name, tbl_name, sql",
    )
    .all()
    .map(({ name, tbl_name, sql }) => ({ name, tbl_name, sql }));
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deriveSchemaIndexCounts(tuples: readonly IndexTuple[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const tuple of [...tuples].sort((left, right) => {
    const tableOrder = compareText(left.tbl_name, right.tbl_name);
    return tableOrder === 0 ? compareText(left.name, right.name) : tableOrder;
  })) {
    counts[tuple.tbl_name] = (counts[tuple.tbl_name] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

function indexTupleDigest(tuples: readonly IndexTuple[]): string {
  return createHash("sha256").update(JSON.stringify(tuples), "utf8").digest("hex");
}

async function productionIndexOracle(suffix: string): Promise<IndexOracle> {
  const root = await mkdtemp(join(tmpdir(), `agent-mail-p4-c16-oracle-${suffix}-`));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "canonical.sqlite"));
  try {
    const userVersion = Number(
      opened.db.query<{ readonly user_version: number }, []>("PRAGMA user_version;").get()
        ?.user_version ?? -1,
    );
    expect(userVersion).toBe(CANONICAL_DATABASE_SCHEMA_VERSION);
    expect(
      opened.db
        .query<{ readonly version: number; readonly name: string; readonly content_hash: string }, []>(
          "SELECT version, name, content_hash FROM schema_migrations ORDER BY version;",
        )
        .all(),
    ).toEqual(
      canonicalDatabaseMigrations.map((migration) => ({
        version: migration.version,
        name: migration.name,
        content_hash: migrationContentHash(migration),
      })),
    );
    expect(
      opened.db.query<{ readonly integrity_check: string }, []>("PRAGMA integrity_check;").get()
        ?.integrity_check,
    ).toBe("ok");
    expect(opened.db.query("PRAGMA foreign_key_check;").all()).toHaveLength(0);

    const tuples = readIndexTuples(opened.db);
    const digest = indexTupleDigest(tuples);
    expect(tuples).toHaveLength(33);
    expect(digest).toBe(
      "8a1da254844604df5d8f9c8b1629de2683227c90b1758f3c137166b870affb24",
    );
    return Object.freeze({
      tuples,
      schemaIndexCounts: deriveSchemaIndexCounts(tuples),
      schemaIndexTotal: tuples.length,
      digest,
    });
  } finally {
    await opened.close();
  }
}

function expectedInventory(
  inventory: Awaited<ReturnType<typeof generateCorpus>>,
  oracle: IndexOracle,
): Awaited<ReturnType<typeof generateCorpus>> {
  return {
    ...inventory,
    schemaIndexCounts: oracle.schemaIndexCounts,
    schemaIndexTotal: oracle.schemaIndexTotal,
  };
}

function validateAgainstProductionOracle(
  database: Database,
  inventory: Awaited<ReturnType<typeof generateCorpus>>,
  oracle: IndexOracle,
): void {
  const actualTuples = readIndexTuples(database);
  if (JSON.stringify(actualTuples) !== JSON.stringify(oracle.tuples))
    throw new Error("schema index tuple inventory mismatch");
  validateCorpusInventory(database, expectedInventory(inventory, oracle));
}

async function fixture(count: number, suffix: string) {
  const root = await mkdtemp(join(tmpdir(), `agent-mail-p4-c16-${suffix}-`));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "corpus.sqlite");
  const inventory = await generateCorpus(path, count, 1162026);
  return { inventory, path };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("P4-C16 deterministic search corpus", () => {
  test("same seed produces the same logical corpus and query identities", async () => {
    const [first, second] = await Promise.all([fixture(128, "a"), fixture(128, "b")]);
    const oracle = await productionIndexOracle("same-seed");
    const firstDatabase = new Database(first.path);
    const secondDatabase = new Database(second.path);
    try {
      expect(first.inventory).toMatchObject({
        ...referenceOracle,
        schemaIndexCounts: oracle.schemaIndexCounts,
        schemaIndexTotal: oracle.schemaIndexTotal,
      });
      expect(first.inventory.logicalChecksum).toBe(second.inventory.logicalChecksum);
      expect(first.inventory.logicalChecksum).toBe("af328c7861bd7491cc1a77514c5b0ec312697e4a717f146a21955190d0be73fa");
      expect(first.inventory.querySelectivities).toEqual(second.inventory.querySelectivities);
      expect(first.inventory.queryIdentityDigests).toEqual(second.inventory.queryIdentityDigests);
      expect(first.inventory.placements).toBeGreaterThan(first.inventory.messages);
      expect(first.inventory.tombstones).toBeGreaterThan(0);
      expect(first.inventory.searchDocuments).toBe(first.inventory.messages);
      expect(first.inventory.ftsRows).toBe(first.inventory.messages);
      validateAgainstProductionOracle(firstDatabase, first.inventory, oracle);
      validateAgainstProductionOracle(secondDatabase, second.inventory, oracle);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
  });
  test("inventory rejects index omissions, extras, and same-name SQL drift", async () => {
    const oracle = await productionIndexOracle("counterexamples");
    const omitted = await fixture(32, "omitted-index");
    const extra = await fixture(32, "extra-index");
    const drifted = await fixture(32, "drifted-index");
    const omittedDatabase = new Database(omitted.path);
    const extraDatabase = new Database(extra.path);
    const driftedDatabase = new Database(drifted.path);
    try {
      expect(() => validateAgainstProductionOracle(omittedDatabase, omitted.inventory, oracle)).not.toThrow();
      omittedDatabase.exec("DROP INDEX message_addresses_lookup;");
      expect(readIndexTuples(omittedDatabase)).toEqual(
        oracle.tuples.filter(({ name }) => name !== "message_addresses_lookup"),
      );
      expect(() => validateAgainstProductionOracle(omittedDatabase, omitted.inventory, oracle)).toThrow(
        "schema index tuple inventory mismatch",
      );

      expect(() => validateAgainstProductionOracle(extraDatabase, extra.inventory, oracle)).not.toThrow();
      extraDatabase.exec("CREATE INDEX search_corpus_extra_index ON messages(message_id);");
      const extraTuples = readIndexTuples(extraDatabase);
      expect(extraTuples.filter(({ name }) => name === "search_corpus_extra_index")).toHaveLength(1);
      expect(extraTuples.filter(({ name }) => name !== "search_corpus_extra_index")).toEqual(oracle.tuples);
      expect(() => validateAgainstProductionOracle(extraDatabase, extra.inventory, oracle)).toThrow(
        "schema index tuple inventory mismatch",
      );

      expect(() => validateAgainstProductionOracle(driftedDatabase, drifted.inventory, oracle)).not.toThrow();
      driftedDatabase.exec(
        "DROP INDEX message_addresses_lookup; CREATE INDEX message_addresses_lookup ON message_addresses(role);",
      );
      expect(readIndexTuples(driftedDatabase).filter(({ name }) => name !== "message_addresses_lookup")).toEqual(
        oracle.tuples.filter(({ name }) => name !== "message_addresses_lookup"),
      );
      expect(() => validateAgainstProductionOracle(driftedDatabase, drifted.inventory, oracle)).toThrow(
        "schema index tuple inventory mismatch",
      );
    } finally {
      omittedDatabase.close();
      extraDatabase.close();
      driftedDatabase.close();
    }
  });
  test("inventory rejects a fixture that bypasses placement or FTS invariants", async () => {
    const oracle = await productionIndexOracle("fts-counterexample");
    const { inventory, path } = await fixture(32, "fts-counterexample");
    const database = new Database(path);
    try {
      expect(() => validateAgainstProductionOracle(database, inventory, oracle)).not.toThrow();
      database.exec(
        "INSERT INTO message_fts(message_fts,rowid,subject,participants,body_plain,body_html,attachment_names) " +
          "SELECT 'delete',rowid,subject,participants,body_plain,body_html,attachment_names " +
          "FROM indexed_messages WHERE rowid=(SELECT rowid FROM message_fts WHERE message_fts MATCH 'atlas' LIMIT 1);",
      );
      expect(() => validateCorpusInventory(database, expectedInventory(inventory, oracle))).toThrow(
        "query identity inventory mismatch: atlas",
      );
    } finally {
      database.close();
    }
  });

  test("inventory rejects missing, wrong-account, and missing-set thread closure", async () => {
    const oracle = await productionIndexOracle("thread-counterexamples");
    const missing = await fixture(32, "missing-thread-membership");
    const wrongAccount = await fixture(32, "wrong-thread-account");
    const missingSet = await fixture(32, "missing-thread-set");
    const missingDatabase = new Database(missing.path);
    const wrongAccountDatabase = new Database(wrongAccount.path);
    const missingSetDatabase = new Database(missingSet.path);
    try {
      expect(() => validateAgainstProductionOracle(missingDatabase, missing.inventory, oracle)).not.toThrow();
      missingDatabase.exec(
        "DELETE FROM thread_memberships WHERE message_id = (SELECT message_id FROM messages ORDER BY message_id LIMIT 1);",
      );
      expect(() => validateAgainstProductionOracle(missingDatabase, missing.inventory, oracle)).toThrow(
        "thread inventory mismatch",
      );

      expect(() => validateAgainstProductionOracle(wrongAccountDatabase, wrongAccount.inventory, oracle)).not.toThrow();
      wrongAccountDatabase.exec(
        "PRAGMA foreign_keys = OFF; UPDATE thread_memberships SET account_id = 'account:other' WHERE message_id = (SELECT message_id FROM messages ORDER BY message_id LIMIT 1); PRAGMA foreign_keys = ON;",
      );
      expect(() => validateAgainstProductionOracle(wrongAccountDatabase, wrongAccount.inventory, oracle)).toThrow(
        "foreign-key invariant failed",
      );

      expect(() => validateAgainstProductionOracle(missingSetDatabase, missingSet.inventory, oracle)).not.toThrow();
      missingSetDatabase.exec(
        "PRAGMA foreign_keys = OFF; DELETE FROM thread_sets WHERE set_id = (SELECT set_id FROM thread_memberships ORDER BY message_id LIMIT 1); PRAGMA foreign_keys = ON;",
      );
      expect(() => validateAgainstProductionOracle(missingSetDatabase, missingSet.inventory, oracle)).toThrow(
        "foreign-key invariant failed",
      );
    } finally {
      missingDatabase.close();
      wrongAccountDatabase.close();
      missingSetDatabase.close();
    }
  });

  test("logical checksum covers every thread authority table", async () => {
    const oracle = await productionIndexOracle("thread-digest-counterexamples");
    const headerFact = await fixture(32, "digest-header-fact");
    const edge = await fixture(32, "digest-edge");
    const participant = await fixture(32, "digest-participant");
    const merge = await fixture(64, "digest-merge");
    const headerFactDatabase = new Database(headerFact.path);
    const edgeDatabase = new Database(edge.path);
    const participantDatabase = new Database(participant.path);
    const mergeDatabase = new Database(merge.path);
    try {
      expect(() => validateAgainstProductionOracle(headerFactDatabase, headerFact.inventory, oracle)).not.toThrow();
      const headerTarget = headerFactDatabase
        .query<Readonly<{ readonly message_id: string; readonly member_node_key: string }>, []>(
          "SELECT message_id,member_node_key FROM thread_memberships ORDER BY message_id LIMIT 1;",
        )
        .get();
      if (headerTarget === null) throw new Error("missing header-fact target");
      const factsSha256 = createHash("sha256")
        .update(
          JSON.stringify({
            content_state: "parsed",
            normalizer_version: "thread-normalizer-v1",
            member_node_key: headerTarget.member_node_key,
            message_id_node_key: null,
            references: [],
            in_reply_to: [],
            sent_at: "2020-01-01T00:00:00.000Z",
            diagnostics: [],
          }),
          "utf8",
        )
        .digest("hex");
      headerFactDatabase
        .query(
          "INSERT INTO thread_header_facts (account_id,message_id,content_state,normalizer_version,member_node_key,message_id_node_key,references_json,in_reply_to_json,sent_at,received_at,diagnostics_json,facts_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?);",
        )
        .run(
          "account:capacity",
          headerTarget.message_id,
          "parsed",
          "thread-normalizer-v1",
          headerTarget.member_node_key,
          null,
          "[]",
          "[]",
          "2020-01-01T00:00:00.000Z",
          "2020-01-01T00:00:00.000Z",
          "[]",
          factsSha256,
        );
      expect(() => validateAgainstProductionOracle(headerFactDatabase, headerFact.inventory, oracle)).toThrow(
        "logical checksum mismatch",
      );

      expect(() => validateAgainstProductionOracle(edgeDatabase, edge.inventory, oracle)).not.toThrow();
      const edgeTargets = edgeDatabase
        .query<
          Readonly<{ readonly message_id: string; readonly member_node_key: string; readonly set_id: string }>,
          []
        >(
          "SELECT message_id,member_node_key,set_id FROM thread_memberships WHERE set_id = (SELECT set_id FROM thread_memberships GROUP BY set_id ORDER BY set_id LIMIT 1) ORDER BY message_id LIMIT 2;",
        )
        .all();
      if (edgeTargets.length !== 2) throw new Error("missing edge targets");
      edgeDatabase
        .query(
          "INSERT INTO thread_edges (account_id,source_class_key,target_class_key,set_id,first_message_id,first_field,first_ordinal) VALUES (?,?,?,?,?,?,?);",
        )
        .run(
          "account:capacity",
          edgeTargets[0]!.member_node_key,
          edgeTargets[1]!.member_node_key,
          edgeTargets[0]!.set_id,
          edgeTargets[0]!.message_id,
          "references",
          1,
        );
      edgeDatabase
        .query("UPDATE thread_sets SET edge_count = edge_count + 1 WHERE account_id = ? AND set_id = ?;")
        .run("account:capacity", edgeTargets[0]!.set_id);
      expect(() => validateAgainstProductionOracle(edgeDatabase, edge.inventory, oracle)).toThrow(
        "logical checksum mismatch",
      );

      expect(() => validateAgainstProductionOracle(participantDatabase, participant.inventory, oracle)).not.toThrow();
      const participantTarget = participantDatabase
        .query<Readonly<{ readonly message_id: string; readonly set_id: string }>, []>(
          "SELECT message_id,set_id FROM thread_memberships ORDER BY message_id LIMIT 1;",
        )
        .get();
      if (participantTarget === null) throw new Error("missing participant target");
      participantDatabase
        .query(
          "INSERT INTO thread_participants (account_id,set_id,normalized_address,display_name,first_sent_at_missing_rank,first_sent_at,first_message_id,first_role_rank,first_position) VALUES (?,?,?,?,?,?,?,?,?);",
        )
        .run(
          "account:capacity",
          participantTarget.set_id,
          "digest@example.test",
          "Digest Fixture",
          0,
          "2020-01-01T00:00:00.000Z",
          participantTarget.message_id,
          0,
          1,
        );
      participantDatabase
        .query(
          "UPDATE thread_sets SET participant_count = participant_count + 1 WHERE account_id = ? AND set_id = ?;",
        )
        .run("account:capacity", participantTarget.set_id);
      expect(() => validateAgainstProductionOracle(participantDatabase, participant.inventory, oracle)).toThrow(
        "logical checksum mismatch",
      );

      expect(() => validateAgainstProductionOracle(mergeDatabase, merge.inventory, oracle)).not.toThrow();
      const handles = mergeDatabase
        .query<Readonly<{ readonly thread_id: string; readonly set_id: string; readonly root: string }>, []>(
          "SELECT handle.thread_id,handle.set_id,thread_set.canonical_root_node_key AS root FROM thread_handles AS handle JOIN thread_sets AS thread_set ON thread_set.account_id = handle.account_id AND thread_set.set_id = handle.set_id ORDER BY handle.thread_id LIMIT 2;",
        )
        .all();
      const bridgeMessage = mergeDatabase
        .query<Readonly<{ readonly message_id: string }>, []>(
          "SELECT message_id FROM messages ORDER BY message_id LIMIT 1;",
        )
        .get();
      if (handles.length !== 2 || bridgeMessage === null)
        throw new Error("missing merge targets");
      mergeDatabase
        .query(
          "INSERT INTO thread_merges (account_id,losing_thread_id,merge_generation,winning_thread_id,bridge_message_id,previous_root_node_key,current_root_node_key) VALUES (?,?,?,?,?,?,?);",
        )
        .run(
          "account:capacity",
          handles[0]!.thread_id,
          1,
          handles[1]!.thread_id,
          bridgeMessage.message_id,
          handles[0]!.root,
          handles[1]!.root,
        );
      expect(() => validateAgainstProductionOracle(mergeDatabase, merge.inventory, oracle)).toThrow(
        "logical checksum mismatch",
      );

      expect(() =>
        validateAgainstProductionOracle(
          headerFactDatabase,
          { ...headerFact.inventory, logicalChecksum: "0".repeat(64) },
          oracle,
        ),
      ).toThrow("logical checksum mismatch");
    } finally {
      headerFactDatabase.close();
      edgeDatabase.close();
      participantDatabase.close();
      mergeDatabase.close();
    }
  });
});
