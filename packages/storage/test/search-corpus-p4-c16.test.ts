import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateCorpus, validateCorpusInventory } from "../../../scripts/capacity/generate-search-corpus";

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
  schemaIndexCounts: {
    local_label_assignments: 1,
    message_addresses: 1,
    message_headers: 1,
    remote_placements: 1,
  },
  schemaIndexTotal: 4,
} as const;
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
    expect(first.inventory).toMatchObject(referenceOracle);
    expect(first.inventory.logicalChecksum).toBe(second.inventory.logicalChecksum);
    expect(first.inventory.logicalChecksum).toBe("71a29ee9cd3a2e012a0417cf6a54411bbfd38b6b8a4795c36d90140d3f885ba6");
    expect(first.inventory.querySelectivities).toEqual(second.inventory.querySelectivities);
    expect(first.inventory.queryIdentityDigests).toEqual(second.inventory.queryIdentityDigests);
    expect(first.inventory.placements).toBeGreaterThan(first.inventory.messages);
    expect(first.inventory.tombstones).toBeGreaterThan(0);
    expect(first.inventory.searchDocuments).toBe(first.inventory.messages);
    expect(first.inventory.ftsRows).toBe(first.inventory.messages);
    const database = new Database(first.path);
    expect(() => validateCorpusInventory(database, first.inventory)).not.toThrow();
    database.close();
  });
  test("inventory rejects a fixture that bypasses placement or FTS invariants", async () => {
    const { inventory, path } = await fixture(32, "counterexample");
    const database = new Database(path);
    expect(() => validateCorpusInventory(database, inventory)).not.toThrow();
    database.exec(
      "INSERT INTO message_fts(message_fts,rowid,subject,participants,body_plain,body_html,attachment_names) " +
        "SELECT 'delete',rowid,subject,participants,body_plain,body_html,attachment_names " +
        "FROM indexed_messages WHERE rowid=(SELECT rowid FROM message_fts WHERE message_fts MATCH 'atlas' LIMIT 1);",
    );
    expect(() => validateCorpusInventory(database, inventory)).toThrow("query identity inventory mismatch: atlas");
    database.close();
  });
});
