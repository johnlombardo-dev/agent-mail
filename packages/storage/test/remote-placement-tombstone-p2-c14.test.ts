import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createMessageId,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { runMigrations, type Migration } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import {
  readRemotePlacement,
  tombstoneRemotePlacement,
  type RemotePlacementTombstoneInput,
} from "../src/remote-placement-tombstone";

const roots: string[] = [];
const accountId = createAccountId("account:one");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(10);
const uid = createRemoteUidValue(7);
const messageId = createMessageId(`message:${"a".repeat(64)}`);

const migrations: readonly Migration[] = [messageCatalogMigration, operationalJournalMigration].map(
  (migration, index) => ({ ...migration, version: index + 1 }),
);

const tombstone: RemotePlacementTombstoneInput = {
  accountId,
  mailboxId,
  uidValidity,
  uid,
  observedAt: "2026-08-18T00:00:00.000Z",
  sourceCheckpoint: "checkpoint:inbox:10:42",
  reason: "absent from completed mailbox sweep",
};
const identity = { accountId, mailboxId, uidValidity, uid };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openCatalog() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-tombstone-p2-c14-"));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  runMigrations(opened, migrations);
  opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  opened.db
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity);
  opened.db
    .query(
      "INSERT INTO remote_placements " +
        "(account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity, uid, messageId);
  return { opened, path };
}

describe("remote placement tombstone repository P2-C14", () => {
  test("tombstones twice, reopens, and retains one auditable transition and canonical message", async () => {
    const { opened, path } = await openCatalog();
    const first = tombstoneRemotePlacement(opened.db, tombstone);
    const second = tombstoneRemotePlacement(opened.db, tombstone);
    expect(first.status).toBe("tombstoned");
    expect(second).toEqual({ status: "already-tombstoned", tombstone: first.tombstone });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({
      count: 1,
    });
    await opened.close();

    const reopened = await openDatabase(path);
    runMigrations(reopened, migrations);
    expect(readRemotePlacement(reopened.db, identity)).toEqual({
      identity: { accountId, mailboxId, uidValidity, uid },
      messageId,
      tombstone: first.tombstone,
    });
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 1 });
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM remote_placements;").get()).toEqual({
      count: 1,
    });
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({
      count: 1,
    });
    await reopened.close();
  });

  test("rolls back the placement when the real SQLite journal insertion fails", async () => {
    const { opened } = await openCatalog();
    opened.db.exec(`
      CREATE TRIGGER reject_tombstone_journal
      BEFORE INSERT ON operational_journal
      WHEN NEW.category = 'sync' AND NEW.subject_id LIKE 'placement:%'
      BEGIN
        SELECT RAISE(ABORT, 'injected tombstone journal failure');
      END;
    `);

    expect(() => tombstoneRemotePlacement(opened.db, tombstone)).toThrow();
    expect(
      opened.db
        .query(
          "SELECT tombstone_observed_at, tombstone_reason FROM remote_placements " +
            "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND uid = ?;",
        )
        .get(accountId, mailboxId, uidValidity, uid),
    ).toEqual({ tombstone_observed_at: null, tombstone_reason: null });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({
      count: 0,
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 1 });
    await opened.close();
  });

  test("rejects a changed retry without overwriting immutable provenance", async () => {
    const { opened } = await openCatalog();
    const committed = tombstoneRemotePlacement(opened.db, tombstone);

    expect(() =>
      tombstoneRemotePlacement(opened.db, {
        ...tombstone,
        sourceCheckpoint: "checkpoint:inbox:10:43",
      }),
    ).toThrow();
    expect(readRemotePlacement(opened.db, identity)).toEqual({
      identity: { accountId, mailboxId, uidValidity, uid },
      messageId,
      tombstone: committed.tombstone,
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({
      count: 1,
    });
    await opened.close();
  });
});
