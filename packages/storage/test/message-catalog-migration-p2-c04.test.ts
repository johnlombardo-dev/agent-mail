import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { messageCatalogSequence } from "../src/migrations/0001-message-catalog";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openCatalog() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-message-catalog-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  runMigrations(opened, messageCatalogSequence);
  return opened;
}

const messageId = `message:${"a".repeat(64)}`;

function checkpoint(
  database: Awaited<ReturnType<typeof openCatalog>>["db"],
  mailbox: string,
  uidValidity: number,
): void {
  database
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run("account:one", mailbox, uidValidity);
}

function placement(
  database: Awaited<ReturnType<typeof openCatalog>>["db"],
  values: Readonly<{
    mailbox: string;
    uidValidity: number;
    uid: number;
    messageId?: string;
    tombstoneObservedAt?: string | null;
    tombstoneReason?: string | null;
  }>,
): void {
  database
    .query(
      "INSERT INTO remote_placements " +
        "(account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      "account:one",
      values.mailbox,
      values.uidValidity,
      values.uid,
      values.messageId ?? messageId,
      values.tombstoneObservedAt ?? null,
      values.tombstoneReason ?? null,
    );
}

describe("message catalog migration", () => {
  test("stores one canonical message in two distinct remote placements", async () => {
    const opened = await openCatalog();
    opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    checkpoint(opened.db, "mailbox:inbox", 10);
    checkpoint(opened.db, "mailbox:archive", 10);

    placement(opened.db, { mailbox: "mailbox:inbox", uidValidity: 10, uid: 7 });
    placement(opened.db, { mailbox: "mailbox:archive", uidValidity: 10, uid: 7 });

    expect(opened.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 1 });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM remote_placements;").get()).toEqual({
      count: 2,
    });
    await opened.close();
  });

  test("rejects duplicate placement and duplicate checkpoint identity", async () => {
    const opened = await openCatalog();
    opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    checkpoint(opened.db, "mailbox:inbox", 10);
    placement(opened.db, { mailbox: "mailbox:inbox", uidValidity: 10, uid: 7 });

    expect(() =>
      placement(opened.db, { mailbox: "mailbox:inbox", uidValidity: 10, uid: 7 }),
    ).toThrow();
    expect(() => checkpoint(opened.db, "mailbox:inbox", 10)).toThrow();
    await opened.close();
  });

  test("rejects orphan message references and missing checkpoint epochs", async () => {
    const opened = await openCatalog();
    checkpoint(opened.db, "mailbox:inbox", 10);

    expect(() =>
      placement(opened.db, {
        mailbox: "mailbox:inbox",
        uidValidity: 10,
        uid: 7,
        messageId: `message:${"b".repeat(64)}`,
      }),
    ).toThrow();

    opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    expect(() =>
      placement(opened.db, { mailbox: "mailbox:inbox", uidValidity: 11, uid: 7 }),
    ).toThrow();
    await opened.close();
  });

  test("requires tombstone time and reason as one nullable pair", async () => {
    const opened = await openCatalog();
    opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    checkpoint(opened.db, "mailbox:inbox", 10);

    expect(() =>
      placement(opened.db, {
        mailbox: "mailbox:inbox",
        uidValidity: 10,
        uid: 7,
        tombstoneObservedAt: "2026-08-18T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      placement(opened.db, {
        mailbox: "mailbox:inbox",
        uidValidity: 10,
        uid: 8,
        tombstoneReason: "removed from remote mailbox",
      }),
    ).toThrow();

    placement(opened.db, {
      mailbox: "mailbox:inbox",
      uidValidity: 10,
      uid: 9,
      tombstoneObservedAt: "2026-08-18T00:00:00.000Z",
      tombstoneReason: "removed from remote mailbox",
    });
    expect(opened.db.query("SELECT message_id FROM messages;").all()).toEqual([{ message_id: messageId }]);
    await opened.close();
  });

  test("permits the same UID in two UIDVALIDITY epochs but not twice in one epoch", async () => {
    const opened = await openCatalog();
    opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    checkpoint(opened.db, "mailbox:inbox", 10);
    checkpoint(opened.db, "mailbox:inbox", 11);

    placement(opened.db, { mailbox: "mailbox:inbox", uidValidity: 10, uid: 7 });
    placement(opened.db, { mailbox: "mailbox:inbox", uidValidity: 11, uid: 7 });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM remote_placements;").get()).toEqual({
      count: 2,
    });
    expect(() =>
      placement(opened.db, { mailbox: "mailbox:inbox", uidValidity: 11, uid: 7 }),
    ).toThrow();
    await opened.close();
  });
});
