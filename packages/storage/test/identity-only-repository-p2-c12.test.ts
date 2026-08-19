import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createMessageId,
  createRemoteUid,
  createUtcInstant,
  serializeRemoteUid,
} from "@agent-mail/core";
import { runMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { identityOnlyContentMigration } from "../src/migrations/0002-identity-only-content";
import {
  IdentityOnlyMessageError,
  lookupIdentityOnlyAttachments,
  lookupIdentityOnlyBody,
  readIdentityOnlyMessage,
  storeIdentityOnlyMessage,
} from "../src/identity-only-repository";

const roots: string[] = [];
const accountId = createAccountId("account:one");
const mailboxId = createMailboxId("mailbox:inbox");
const messageId = createMessageId(`message:${"a".repeat(64)}`);
const remoteUid = createRemoteUid({ accountId, mailboxId, uidValidity: 42, uid: 7 });
const observedAt = createUtcInstant("2026-08-18T00:00:00.000Z");
const storedAt = createUtcInstant("2026-08-18T00:00:01.000Z");

const migrations = [
  { ...messageCatalogMigration, version: 1 },
  { ...identityOnlyContentMigration, version: 2 },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openIdentityOnlyDatabase() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-identity-only-"));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  runMigrations(opened, migrations);
  return { path, opened };
}

const input = {
  messageId,
  remoteUid: serializeRemoteUid(remoteUid),
  absenceReason: "provider-unavailable",
  observedAt,
  storedAt,
} as const;

describe("identity-only message repository", () => {
  test("writes exact identity, closes, reopens, and exposes unavailable content", async () => {
    const first = await openIdentityOnlyDatabase();
    const stored = storeIdentityOnlyMessage(first.opened.db, input);

    expect(stored).toEqual({
      kind: "identity-only",
      messageId,
      remoteUid,
      absenceReason: "provider-unavailable",
      observedAt,
      storedAt,
    });
    expect(first.opened.db.query("SELECT COUNT(*) AS count FROM message_content_states;").get()).toEqual({
      count: 1,
    });
    expect(
      first.opened.db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' " +
            "AND name IN ('message_body_parts', 'message_attachments');",
        )
        .all(),
    ).toEqual([]);
    await first.opened.close();

    const reopened = await openDatabase(first.path);
    runMigrations(reopened, migrations);
    expect(readIdentityOnlyMessage(reopened.db, messageId)).toEqual(stored);
    expect(lookupIdentityOnlyBody(reopened.db, messageId)).toEqual({
      kind: "unavailable",
      reason: "provider-unavailable",
    });
    expect(lookupIdentityOnlyAttachments(reopened.db, messageId)).toEqual({
      kind: "unavailable",
      reason: "provider-unavailable",
    });
    await reopened.close();
  });

  test("commits the checkpoint, placement, and state together", async () => {
    const { opened } = await openIdentityOnlyDatabase();
    storeIdentityOnlyMessage(opened.db, input);

    expect(
      opened.db
        .query(
          "SELECT account_id, mailbox_id, uid_validity, uid, message_id " +
            "FROM remote_placements;",
        )
        .all(),
    ).toEqual([
      {
        account_id: accountId,
        mailbox_id: mailboxId,
        uid_validity: 42,
        uid: 7,
        message_id: messageId,
      },
    ]);
    expect(opened.db.query("SELECT * FROM mailbox_checkpoints;").all()).toEqual([
      { account_id: accountId, mailbox_id: mailboxId, uid_validity: 42 },
    ]);
    await opened.close();
  });

  test("rejects a zero-byte blob or synthetic readable row", async () => {
    const { opened } = await openIdentityOnlyDatabaseWithStructuredContent();
    storeIdentityOnlyMessage(opened.db, input);

    opened.db
      .query(
        "INSERT INTO message_body_parts " +
          "(message_id, ordinal, content_type, normalized_content_type, blob_id) " +
          "VALUES (?, 1, 'text/plain', 'text/plain', ?);",
      )
      .run(messageId, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(() => lookupIdentityOnlyBody(opened.db, messageId)).toThrow(
      "message already has readable content and cannot become identity-only",
    );
    await opened.close();
  });

  test("rejects conflicting identity-only state without overwriting it", async () => {
    const { opened } = await openIdentityOnlyDatabase();
    storeIdentityOnlyMessage(opened.db, input);

    expect(() =>
      storeIdentityOnlyMessage(opened.db, {
        ...input,
        absenceReason: "redacted",
      }),
    ).toThrow(IdentityOnlyMessageError);
    expect(readIdentityOnlyMessage(opened.db, messageId)?.absenceReason).toBe(
      "provider-unavailable",
    );
    await opened.close();
  });

  test("rejects unknown input fields before opening a transaction", async () => {
    const { opened } = await openIdentityOnlyDatabase();

    expect(() =>
      storeIdentityOnlyMessage(opened.db, {
        ...input,
        body: "must not cross the repository boundary",
      }),
    ).toThrow(IdentityOnlyMessageError);
    expect(opened.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 0 });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM message_content_states;").get()).toEqual({
      count: 0,
    });
    await opened.close();
  });
});

async function openIdentityOnlyDatabaseWithStructuredContent() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-identity-only-structured-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  runMigrations(opened, [
    { ...messageCatalogMigration, version: 1 },
    { ...structuredContentMigration, version: 2 },
    { ...identityOnlyContentMigration, version: 3 },
  ]);
  return { opened };
}
