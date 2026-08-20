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
      expect(first.inventory.logicalChecksum).toBe("71a29ee9cd3a2e012a0417cf6a54411bbfd38b6b8a4795c36d90140d3f885ba6");
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
});
