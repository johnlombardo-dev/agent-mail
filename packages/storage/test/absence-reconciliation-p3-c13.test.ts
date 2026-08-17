import { mkdtemp, rm } from "node:fs/promises";
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
import {
  createAbsenceReconciliationService,
  createSqliteAbsenceReconciliationService,
  type AbsenceTombstoneWriter,
} from "../src/absence-reconciliation";
import { openDatabase } from "../src/database";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { readRemotePlacement } from "../src/remote-placement-tombstone";

const roots: string[] = [];
const accountId = createAccountId("account:one");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(77);
const uid = createRemoteUidValue(7);
const otherUid = createRemoteUidValue(8);
const messageId = createMessageId(`message:${"a".repeat(64)}`);
const identity = { accountId, mailboxId, uidValidity, uid };

const migrations: readonly Migration[] = [messageCatalogMigration, operationalJournalMigration].map(
  (migration, index) => ({ ...migration, version: index + 1 }),
);

function observation(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    accountId,
    mailboxId,
    uidValidity,
    uid,
    queriedUidScope: [uid, otherUid],
    missingUids: [uid, otherUid],
    items: [],
    checkpoint: "checkpoint:inbox:77:42",
    observationId: "observation:inbox:77:42",
    observedAt: "2026-08-18T00:00:00.000Z",
    transport: { completion: "complete", authority: "authoritative" },
    ...overrides,
  };
}

function fakeWriter(calls: unknown[]): AbsenceTombstoneWriter {
  return (input) => {
    calls.push(input);
  };
}

async function openCatalog() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-absence-p3-c13-"));
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  applyMigrations(opened, migrations);
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("single-placement absence reconciliation P3-C13", () => {
  test("fake writer receives one confirmed absence with complete provenance", () => {
    const calls: unknown[] = [];
    const service = createAbsenceReconciliationService(fakeWriter(calls));

    expect(service.reconcile(observation())).toEqual({
      status: "tombstoned",
      sourceCheckpoint: "checkpoint:inbox:77:42",
      observationId: "observation:inbox:77:42",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      accountId,
      mailboxId,
      uidValidity,
      uid,
      observedAt: "2026-08-18T00:00:00.000Z",
      sourceCheckpoint: "checkpoint:inbox:77:42",
    });
    expect(JSON.stringify(calls[0])).toContain("observation=observation:inbox:77:42");
    expect(JSON.stringify(calls[0])).toContain("observedAt=2026-08-18T00:00:00.000Z");
  });

  test.each([
    ["partial", { completion: "partial", authority: "non-authoritative" }],
    ["transport error", { completion: "error", authority: "non-authoritative" }],
    ["unknown completeness", { completion: "unknown", authority: "unknown" }],
    ["unknown authority", { completion: "complete", authority: "unknown" }],
  ] as const)("does not tombstone a %s result", (_name, transport) => {
    const calls: unknown[] = [];
    const service = createAbsenceReconciliationService(fakeWriter(calls));

    expect(service.reconcile(observation({ transport }))).toEqual({
      status: "skipped",
      reason: transport.completion === "complete" ? "transport-unauthoritative" : "transport-incomplete",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["target outside scope", { queriedUidScope: [otherUid] }, "target-out-of-scope"],
    ["missing outside scope", { missingUids: [uid, createRemoteUidValue(99)] }, "missing-out-of-scope"],
    ["target not explicitly missing", { missingUids: [otherUid] }, "target-not-explicitly-missing"],
    [
      "target present",
      {
        missingUids: [],
        items: [{ identity }],
      },
      "target-not-explicitly-missing",
    ],
    [
      "present item has wrong epoch",
      {
        items: [{ identity: { ...identity, uidValidity: createUidValidity(78) } }],
      },
      "present-item-identity-mismatch",
    ],
    [
      "present item has wrong mailbox",
      {
        items: [{ identity: { ...identity, mailboxId: createMailboxId("archive") } }],
      },
      "present-item-identity-mismatch",
    ],
    [
      "present item has wrong account",
      {
        items: [{ identity: { ...identity, accountId: createAccountId("account:two") } }],
      },
      "present-item-identity-mismatch",
    ],
    [
      "present item is outside scope",
      {
        items: [{ identity: { ...identity, uid: createRemoteUidValue(99) } }],
      },
      "present-item-out-of-scope",
    ],
  ] as const)("leaves the placement live for %s", (_name, overrides, reason) => {
    const calls: unknown[] = [];
    const service = createAbsenceReconciliationService(fakeWriter(calls));

    expect(service.reconcile(observation(overrides))).toEqual({ status: "skipped", reason });
    expect(calls).toHaveLength(0);
  });

  test("does not infer a second omission from an unaccounted scope UID", () => {
    const calls: unknown[] = [];
    const service = createAbsenceReconciliationService(fakeWriter(calls));

    expect(
      service.reconcile(
        observation({
          missingUids: [uid],
          items: [],
        }),
      ),
    ).toEqual({ status: "skipped", reason: "scope-incomplete" });
    expect(calls).toHaveLength(0);
  });

  test("failed stream omission is not absence authority", () => {
    const calls: unknown[] = [];
    const service = createAbsenceReconciliationService(fakeWriter(calls));

    expect(
      service.reconcile(
        observation({
          missingUids: [uid],
          transport: { completion: "error", authority: "non-authoritative" },
        }),
      ),
    ).toEqual({ status: "skipped", reason: "transport-incomplete" });
    expect(calls).toHaveLength(0);
  });

  test("real writer atomically tombstones one placement and retains content", async () => {
    const { opened } = await openCatalog();
    const service = createSqliteAbsenceReconciliationService(opened.db);

    expect(service.reconcile(observation())).toMatchObject({ status: "tombstoned" });
    expect(readRemotePlacement(opened.db, identity)?.tombstone).toMatchObject({
      sourceCheckpoint: "checkpoint:inbox:77:42",
      observedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 1 });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({
      count: 1,
    });
    await opened.close();
  });

  test("real writer leaves placement and content live for a partial omission", async () => {
    const { opened } = await openCatalog();
    const service = createSqliteAbsenceReconciliationService(opened.db);

    expect(
      service.reconcile(
        observation({
          transport: { completion: "error", authority: "non-authoritative" },
        }),
      ),
    ).toEqual({ status: "skipped", reason: "transport-incomplete" });
    expect(readRemotePlacement(opened.db, identity)?.tombstone).toBeNull();
    expect(opened.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 1 });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({
      count: 0,
    });
    await opened.close();
  });

  test("real writer rolls back the placement when provenance journaling fails", async () => {
    const { opened } = await openCatalog();
    opened.db.exec(`
      CREATE TRIGGER reject_absence_journal
      BEFORE INSERT ON operational_journal
      WHEN NEW.category = 'sync' AND NEW.subject_id LIKE 'placement:%'
      BEGIN
        SELECT RAISE(ABORT, 'injected absence journal failure');
      END;
    `);
    const service = createSqliteAbsenceReconciliationService(opened.db);

    expect(() => service.reconcile(observation())).toThrow();
    expect(readRemotePlacement(opened.db, identity)?.tombstone).toBeNull();
    expect(opened.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 1 });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({
      count: 0,
    });
    await opened.close();
  });
});
