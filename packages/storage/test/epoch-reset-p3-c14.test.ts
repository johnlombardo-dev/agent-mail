import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createMessageId,
  createStreamingOffset,
  createUidValidity,
} from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { runMigrations } from "../src/migration-runner";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import {
  mailboxCheckpointMigration,
  readMailboxCheckpoint,
} from "../src/checkpoint-repository";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { localLabelMigration } from "../src/local-label-migration";
import { assignLocalLabel, type LocalLabelAssignmentInput } from "../src/local-label-assignment";
import {
  MailboxEpochResetError,
  resetMailboxEpoch,
} from "../src/epoch-reset";
import { readRemotePlacement } from "../src/remote-placement-tombstone";

const roots: string[] = [];
const accountId = createAccountId("account:one");
const inbox = createMailboxId("mailbox:inbox");
const archive = createMailboxId("mailbox:archive");
const oldUidValidity = createUidValidity(10);
const newUidValidity = createUidValidity(11);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openEpochDatabase() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-epoch-reset-"));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  runMigrations(opened, [
    messageCatalogMigration,
    mailboxCheckpointMigration,
    { ...operationalJournalMigration, version: 3 },
    { ...localLabelMigration, version: 4 },
  ]);
  return { path, opened };
}

function addCheckpoint(
  database: Parameters<typeof readMailboxCheckpoint>[0],
  mailboxId: string,
  uidValidity: number,
): void {
  database
    .query(
      "INSERT INTO mailbox_checkpoints " +
        "(account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity);
}

function addPlacement(
  database: Parameters<typeof readMailboxCheckpoint>[0],
  mailboxId: string,
  uidValidity: number,
  uid: number,
  messageId: string,
): void {
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  database
    .query(
      "INSERT INTO remote_placements " +
        "(account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity, uid, messageId);
}

function localLabelAssignmentSnapshot(database: Parameters<typeof readMailboxCheckpoint>[0]): unknown {
  return database
    .query(
      "SELECT message_id, label, rule_id, rule_version, matched_facts_json, decided_at, " +
        "provenance_source, provenance_evaluation_id FROM local_label_assignments;",
    )
    .get();
}

const oldMessageId = createMessageId("a".repeat(64));
const oldMessageAssignment: LocalLabelAssignmentInput = {
  messageId: oldMessageId,
  label: "label:archive",
  ruleId: "rule:sender",
  ruleVersion: 2,
  matchedFacts: [{ field: "senderAddrSpec", value: "alice@example.com" }],
  decidedAt: "2026-08-18T00:00:00.000Z",
  provenance: { source: "routing-evaluator", evaluationId: "evaluation:epoch-reset" },
};

function expectResetError(action: () => unknown, code: MailboxEpochResetError["code"]): void {
  try {
    action();
    throw new Error("expected mailbox epoch reset to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(MailboxEpochResetError);
    if (error instanceof MailboxEpochResetError) expect(error.code).toBe(code);
  }
}

describe("mailbox UIDVALIDITY epoch reset P3-C14", () => {
  test("closes one mailbox epoch, retains messages, and reopens with unknown status", async () => {
    const { path, opened } = await openEpochDatabase();
    addCheckpoint(opened.db, archive, oldUidValidity);
    addCheckpoint(opened.db, inbox, oldUidValidity);
    addPlacement(opened.db, inbox, oldUidValidity, 42, oldMessageId);
    addPlacement(opened.db, inbox, oldUidValidity, 43, createMessageId("b".repeat(64)));
    addPlacement(
      opened.db,
      archive,
      oldUidValidity,
      42,
      createMessageId("c".repeat(64)),
    );
    assignLocalLabel(opened.db, oldMessageAssignment);
    const routingBeforeReset = localLabelAssignmentSnapshot(opened.db);
    expect(routingBeforeReset).toEqual({
      message_id: oldMessageId,
      label: "label:archive",
      rule_id: "rule:sender",
      rule_version: 2,
      matched_facts_json: '[{"field":"senderAddrSpec","value":"alice@example.com"}]',
      decided_at: "2026-08-18T00:00:00.000Z",
      provenance_source: "routing-evaluator",
      provenance_evaluation_id: "evaluation:epoch-reset",
    });

    const result = resetMailboxEpoch(opened.db, {
      accountId,
      mailboxId: inbox,
      oldUidValidity,
      newUidValidity,
      observedAt: "2026-08-18T00:00:00.000Z",
      sourceCheckpoint: "checkpoint:inbox-before-reset",
    });
    expect(result.closedPlacementCount).toBe(2);
    expect(result.checkpoint.uidNext).toEqual({ kind: "unknown" });
    expect(result.checkpoint.modseq).toEqual({ kind: "unknown" });
    expect(result.checkpoint.sweepCursor).toBe(createStreamingOffset(0));
    expect(
      opened.db
        .query(
          "SELECT uid, tombstone_observed_at, tombstone_reason FROM remote_placements " +
            "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? ORDER BY uid;",
        )
        .all(accountId, inbox, oldUidValidity),
    ).toEqual([
      {
        uid: 42,
        tombstone_observed_at: "2026-08-18T00:00:00.000Z",
        tombstone_reason: result.reason,
      },
      {
        uid: 43,
        tombstone_observed_at: "2026-08-18T00:00:00.000Z",
        tombstone_reason: result.reason,
      },
    ]);
    expect(
      opened.db
        .query(
          "SELECT uid, tombstone_observed_at FROM remote_placements " +
            "WHERE mailbox_id = ? AND uid_validity = ?;",
        )
        .all(archive, oldUidValidity),
    ).toEqual([{ uid: 42, tombstone_observed_at: null }]);
    expect(opened.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 3 });
    expect(localLabelAssignmentSnapshot(opened.db)).toEqual(routingBeforeReset);
    expect(
      opened.db
        .query(
          "SELECT json_extract(payload_json, '$.kind') AS kind, " +
            "json_extract(payload_json, '$.closedPlacementCount') AS closed " +
            "FROM operational_journal WHERE id = ?;",
        )
        .get(result.journalId),
    ).toEqual({ kind: "mailbox-epoch-reset", closed: 2 });
    expect(readRemotePlacement(opened.db, { accountId, mailboxId: inbox, uidValidity: oldUidValidity, uid: 42 })).toMatchObject({
      messageId: oldMessageId,
      tombstone: { reason: result.reason, sourceCheckpoint: "checkpoint:inbox-before-reset" },
    });
    await opened.close();

    const reopened = await openDatabase(path);
    expect(
      readMailboxCheckpoint(reopened.db, { accountId, mailboxId: inbox, uidValidity: newUidValidity }),
    ).toEqual(result.checkpoint);
    expect(
      readRemotePlacement(reopened.db, {
        accountId,
        mailboxId: inbox,
        uidValidity: oldUidValidity,
        uid: 42,
      }),
    ).toMatchObject({
      messageId: oldMessageId,
      tombstone: { reason: result.reason },
    });
    expect(localLabelAssignmentSnapshot(reopened.db)).toEqual(routingBeforeReset);

    // UID 42 is reusable only as a new epoch identity; the old placement and
    // canonical message remain independent rows.
    const newMessageId = createMessageId("d".repeat(64));
    reopened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(newMessageId);
    reopened.db
      .query(
        "INSERT INTO remote_placements " +
          "(account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);",
      )
      .run(accountId, inbox, newUidValidity, 42, newMessageId);
    expect(
      reopened.db
        .query(
          "SELECT uid_validity, uid, message_id FROM remote_placements " +
            "WHERE account_id = ? AND mailbox_id = ? AND uid = 42 ORDER BY uid_validity;",
        )
        .all(accountId, inbox),
    ).toEqual([
      { uid_validity: 10, uid: 42, message_id: oldMessageId },
      { uid_validity: 11, uid: 42, message_id: newMessageId },
    ]);
    await reopened.close();
  });

  test("rolls back all closures and the new checkpoint when journal writing fails", async () => {
    const { opened } = await openEpochDatabase();
    addCheckpoint(opened.db, inbox, oldUidValidity);
    addPlacement(opened.db, inbox, oldUidValidity, 42, createMessageId("e".repeat(64)));
    const before = opened.db
      .query(
        "SELECT uid, tombstone_observed_at, tombstone_reason FROM remote_placements " +
          "ORDER BY uid;",
      )
      .all();

    expectResetError(
      () =>
        resetMailboxEpoch(
        opened.db,
        {
          accountId,
          mailboxId: inbox,
          oldUidValidity,
          newUidValidity,
          observedAt: "2026-08-18T00:00:00.000Z",
          sourceCheckpoint: "checkpoint:inbox-before-reset",
        },
        {
          beforeJournalWrite: (kind) => {
            if (kind === "epoch-reset") throw new Error("injected reset journal failure");
          },
        },
        ),
      "write-failed",
    );
    expect(opened.db.query("SELECT COUNT(*) AS count FROM mailbox_checkpoints;").get()).toEqual({ count: 1 });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 0 });
    expect(
      opened.db
        .query(
          "SELECT uid, tombstone_observed_at, tombstone_reason FROM remote_placements ORDER BY uid;",
        )
        .all(),
    ).toEqual(before);
    resetMailboxEpoch(opened.db, {
      accountId,
      mailboxId: inbox,
      oldUidValidity,
      newUidValidity,
      observedAt: "2026-08-18T00:00:00.000Z",
      sourceCheckpoint: "checkpoint:inbox-before-reset",
    });
  });

  test("rejects same, stale, wrong-mailbox, and malformed epochs", async () => {
    const { opened } = await openEpochDatabase();
    addCheckpoint(opened.db, inbox, oldUidValidity);
    addCheckpoint(opened.db, inbox, newUidValidity);
    expectResetError(
      () =>
        resetMailboxEpoch(opened.db, {
          accountId,
          mailboxId: inbox,
          oldUidValidity: newUidValidity,
          newUidValidity,
          observedAt: "2026-08-18T00:00:00.000Z",
          sourceCheckpoint: "checkpoint:stale",
        }),
      "same-epoch",
    );
    expectResetError(() =>
      resetMailboxEpoch(opened.db, {
        accountId,
        mailboxId: inbox,
        oldUidValidity,
        newUidValidity: createUidValidity(12),
        observedAt: "2026-08-18T00:00:00.000Z",
        sourceCheckpoint: "checkpoint:stale",
      }),
      "stale-epoch",
    );
    expectResetError(() =>
      resetMailboxEpoch(opened.db, {
        accountId,
        mailboxId: archive,
        oldUidValidity,
        newUidValidity: createUidValidity(12),
        observedAt: "2026-08-18T00:00:00.000Z",
        sourceCheckpoint: "checkpoint:wrong-mailbox",
      }),
      "not-found",
    );
    expectResetError(() =>
      resetMailboxEpoch(opened.db, {
        accountId,
        mailboxId: inbox,
        oldUidValidity: 0,
        newUidValidity: 12,
        observedAt: "2026-08-18T00:00:00.000Z",
        sourceCheckpoint: "checkpoint:invalid",
      }),
      "invalid-input",
    );
    await opened.close();
  });
});
