import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createMonotonicSequence,
  createRemoteUidValue,
  createStreamingOffset,
  createUidValidity,
  createAccountId,
  createMailboxId,
} from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { runMigrations } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import {
  MAILBOX_CHECKPOINT_MIGRATION_VERSION,
  mailboxCheckpointMigration,
  readMailboxCheckpoint,
  saveMailboxCheckpoint,
  StaleMailboxCheckpointError,
} from "../src/checkpoint-repository";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const accountId = createAccountId("account:one");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(10);

const unknownCheckpoint = {
  accountId,
  mailboxId,
  uidValidity,
  uidNext: { kind: "unknown" as const },
  modseq: { kind: "unknown" as const },
  sweepCursor: createStreamingOffset(0),
  backfillCompleted: false,
};

async function openCheckpointDatabase() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-checkpoint-"));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  runMigrations(opened, [messageCatalogMigration, mailboxCheckpointMigration]);
  return { path, opened };
}

describe("mailbox checkpoint extension and repository", () => {
  test("round-trips known and unknown facts through close and reopen", async () => {
    const { path, opened } = await openCheckpointDatabase();
    const known = saveMailboxCheckpoint(opened.db, {
      checkpoint: {
        ...unknownCheckpoint,
        uidNext: { kind: "known", value: createRemoteUidValue(1201) },
        modseq: { kind: "known", value: createMonotonicSequence(884422) },
        sweepCursor: createStreamingOffset(1200),
        backfillCompleted: true,
      },
      expectedVersion: 0,
    });
    expect(known.observedVersion).toBe(1);
    await opened.close();

    const reopened = await openDatabase(path);
    runMigrations(reopened, [messageCatalogMigration, mailboxCheckpointMigration]);
    expect(readMailboxCheckpoint(reopened.db, { accountId, mailboxId, uidValidity })).toEqual(known);
    await reopened.close();

    const unknownOpen = await openDatabase(path);
    expect(
      readMailboxCheckpoint(unknownOpen.db, { accountId, mailboxId, uidValidity }),
    ).toEqual(known);
    saveMailboxCheckpoint(unknownOpen.db, {
      checkpoint: unknownCheckpoint,
      expectedVersion: known.observedVersion,
    });
    await unknownOpen.close();

    const finalOpen = await openDatabase(path);
    expect(readMailboxCheckpoint(finalOpen.db, { accountId, mailboxId, uidValidity })).toMatchObject(
      unknownCheckpoint,
    );
    await finalOpen.close();
  });

  test("rejects a stale writer without changing any checkpoint field", async () => {
    const { opened } = await openCheckpointDatabase();
    const first = saveMailboxCheckpoint(opened.db, {
      checkpoint: unknownCheckpoint,
      expectedVersion: 0,
    });
    const second = saveMailboxCheckpoint(opened.db, {
      checkpoint: {
        ...unknownCheckpoint,
        uidNext: { kind: "known", value: createRemoteUidValue(1201) },
        modseq: { kind: "known", value: createMonotonicSequence(12) },
        sweepCursor: createStreamingOffset(8),
        backfillCompleted: true,
      },
      expectedVersion: first.observedVersion,
    });

    expect(() =>
      saveMailboxCheckpoint(opened.db, {
        checkpoint: {
          ...unknownCheckpoint,
          uidNext: { kind: "known", value: createRemoteUidValue(9999) },
          modseq: { kind: "known", value: createMonotonicSequence(99) },
          sweepCursor: createStreamingOffset(99),
          backfillCompleted: false,
        },
        expectedVersion: first.observedVersion,
      }),
    ).toThrow(StaleMailboxCheckpointError);
    expect(readMailboxCheckpoint(opened.db, { accountId, mailboxId, uidValidity })).toEqual(second);
    await opened.close();
  });

  test("does not encode unknown UIDNEXT as numeric zero", async () => {
    const { opened } = await openCheckpointDatabase();
    expect(() =>
      opened.db
        .query(
          "INSERT INTO mailbox_checkpoints " +
            "(account_id, mailbox_id, uid_validity, uid_next_known, uid_next, modseq_known, modseq, " +
            "sweep_cursor, backfill_completed, observed_version, storage_version) " +
            "VALUES (?, ?, ?, 1, 0, 0, NULL, 0, 0, 0, 1);",
        )
        .run(accountId, mailboxId, uidValidity),
    ).toThrow();
    await opened.close();
  });
});
