import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/migration-runner";
import { canonicalDatabaseMigrations } from "../src/migration-registry";
import { createLegacyNormalizedTextMaterializer } from "../src/message-text-materializer";

const accountId = "account:icloud-primary";
const mailboxId = "mailbox:inbox";

async function fixture(messageId: string, text: string) {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-report-materializer-"));
  const canonicalDirectory = join(root, "canonical");
  const stagingDirectory = join(root, "staging");
  await mkdir(canonicalDirectory);
  await mkdir(stagingDirectory);
  const raw = Buffer.from(`Content-Type: text/plain\r\n\r\n${text}\r\n`, "utf8");
  const digest = createHash("sha256").update(raw).digest("hex");
  await writeFile(join(canonicalDirectory, digest), raw, { mode: 0o600 });
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, canonicalDatabaseMigrations);
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  database
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, 1);
  database
    .query(
      "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason) VALUES (?, ?, 1, 1, ?, NULL, NULL);",
    )
    .run(accountId, mailboxId, messageId);
  database
    .query(
      "INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, 'raw-eml', 1, ?, ?);",
    )
    .run(messageId, digest, raw.byteLength);
  return { root, canonicalDirectory, stagingDirectory, database };
}

describe("legacy normalized text materializer", () => {
  test("materializes exact production text and concurrent owners preserve active stages", async () => {
    const firstId = `message:${"a".repeat(64)}`;
    const secondId = `message:${"b".repeat(64)}`;
    const first = await fixture(firstId, "first source");
    const second = await fixture(secondId, "second source");
    // Share one durable DB and staging root to exercise the sibling barrier.
    second.database.close();
    const sharedDatabase = first.database;
    sharedDatabase
      .query("INSERT INTO messages (message_id) VALUES (?);")
      .run(secondId);
    sharedDatabase
      .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
      .run(accountId, mailboxId, 2);
    sharedDatabase
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason) VALUES (?, ?, 2, 2, ?, NULL, NULL);",
      )
      .run(accountId, mailboxId, secondId);
    const secondDigest = (await readdir(second.canonicalDirectory)).at(0);
    if (secondDigest === undefined) throw new Error("second raw fixture is missing");
    const secondBytes = await readFile(join(second.canonicalDirectory, secondDigest));
    await writeFile(join(first.canonicalDirectory, secondDigest), secondBytes, { mode: 0o600 });
    sharedDatabase
      .query(
        "INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, 'raw-eml', 1, ?, ?);",
      )
      .run(secondId, secondDigest, secondBytes.byteLength);

    const options = {
      database: sharedDatabase,
      canonicalDirectory: first.canonicalDirectory,
      stagingDirectory: first.stagingDirectory,
      owner: { pid: process.pid, processStartIdentity: "materializer-test-owner" },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    } as const;
    const left = createLegacyNormalizedTextMaterializer(options);
    const right = createLegacyNormalizedTextMaterializer(options);
    await Promise.all([left(firstId), right(secondId)]);
    expect(sharedDatabase.query("SELECT count(*) AS count FROM message_text_projections;").get()).toEqual({
      count: 2,
    });
    expect(await readdir(first.stagingDirectory)).toEqual([]);
    sharedDatabase.close();
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  });
});
