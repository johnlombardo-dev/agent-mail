import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createAccountId,
  createMailboxId,
  createRemoteUid,
  createMessageId,
  createRemoteUidValue,
  createUtcInstant,
} from "@agent-mail/core";
import type { MetadataBatchItem } from "../../imap/src/metadata-batch";
import { applyMigrations } from "../../storage/src/migration-runner";
import { openDatabase } from "../../storage/src/database";
import {
  createMailboxCheckpointRepository,
  mailboxCheckpointMigration,
} from "../../storage/src/checkpoint-repository";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
import { identityOnlyContentMigration } from "../../storage/src/migrations/0002-identity-only-content";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import { placementObservationMigration } from "../../storage/src/migrations/0003-placement-observation";
import {
  observeRemotePlacement,
  readRemotePlacementObservation,
} from "../../storage/src/remote-placement-observation";
import {
  storeIdentityOnlyMessage,
} from "../../storage/src/identity-only-repository";
import {
  runInitialBackfillBatch,
  type InitialBackfillBatchRequest,
  type InitialBackfillCheckpointRepository,
} from "../src/initial-backfill-batch";

const accountId = createAccountId("account:backfill");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = 9;
const observedAt = createUtcInstant("2026-08-18T00:00:00.000Z");
const roots: string[] = [];

async function setup(): Promise<{
  readonly db: Database;
  readonly close: () => Promise<void>;
  readonly checkpoints: InitialBackfillCheckpointRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-backfill-"));
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  applyMigrations(opened, [
    { ...messageCatalogMigration, version: 1 },
    { ...mailboxCheckpointMigration, version: 2 },
    { ...identityOnlyContentMigration, version: 3 },
    { ...operationalJournalMigration, version: 4 },
    { ...placementObservationMigration, version: 5 },
  ]);
  opened.db
    .query(
      "INSERT INTO mailbox_checkpoints " +
        "(account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity);
  return {
    db: opened.db,
    close: async () => opened.close(),
    checkpoints: createMailboxCheckpointRepository(opened.db),
  };
}

function request(start: number, end: number): InitialBackfillBatchRequest {
  return {
    accountId,
    mailboxId,
    uidValidity,
    range: {
      start: createRemoteUidValue(start),
      end: createRemoteUidValue(end),
    },
    stagingDirectory: "/tmp/agent-mail-backfill-staging",
    owner: { pid: process.pid, processStartIdentity: "backfill-test" },
  };
}

function missingAdapter() {
  return {
    async fetch(input: { readonly uids: readonly number[] }) {
      return { items: [], missingUids: input.uids };
    },
  };
}

function checkpointValue(checkpoints: InitialBackfillCheckpointRepository) {
  return checkpoints.read({ accountId, mailboxId, uidValidity });
}

function item(uid: number): MetadataBatchItem {
  return {
    identity: createRemoteUid({ accountId, mailboxId, uidValidity, uid }),
    flags: ["\\Seen"],
    modseq: { kind: "unknown" },
    envelope: { subject: `UID ${uid}` },
    size: 1,
    internalDate: observedAt,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("one bounded initial-backfill batch P3-C09", () => {
  test("stores explicit metadata gaps before each durable checkpoint advance", async () => {
    const fixture = await setup();
    const result = await runInitialBackfillBatch(request(1, 3), {
      metadata: missingAdapter(),
      checkpoints: fixture.checkpoints,
      ingestSingleMessage: async () => ({
        messageId: createMessageId("message:unused"),
        status: "committed",
      }),
      persistMetadata: () => {
        throw new Error("metadata persistence must not run for missing UIDs");
      },
      persistMissing: (observation) => {
        storeIdentityOnlyMessage(fixture.db, {
          messageId: observation.messageId,
          remoteUid: observation.remoteUid,
          absenceReason: observation.absenceReason,
          observedAt: observation.observedAt,
          storedAt: observation.observedAt,
        });
      },
      observedAt,
    });

    expect(result.status).toBe("committed");
    expect(result.processedUids).toEqual([1, 2, 3]);
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM message_content_states;").get()).toEqual({
      count: 3,
    });
    expect(checkpointValue(fixture.checkpoints)?.uidNext).toEqual({ kind: "known", value: 4 });
    await fixture.close();
  });

  test("returns the last checkpoint on interruption and resumes idempotently", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    let writes = 0;
    const first = await runInitialBackfillBatch(request(1, 3), {
      metadata: missingAdapter(),
      checkpoints: fixture.checkpoints,
      ingestSingleMessage: async () => ({
        messageId: createMessageId("message:unused"),
        status: "committed",
      }),
      persistMetadata: () => undefined,
      persistMissing: (observation) => {
        writes += 1;
        storeIdentityOnlyMessage(fixture.db, {
          messageId: observation.messageId,
          remoteUid: observation.remoteUid,
          absenceReason: observation.absenceReason,
          observedAt: observation.observedAt,
          storedAt: observation.observedAt,
        });
        if (writes === 1) controller.abort();
      },
      observedAt,
      signal: controller.signal,
    });
    expect(first.status).toBe("cancelled");
    expect(first.processedUids).toEqual([1]);
    expect(first.checkpoint.uidNext).toEqual({ kind: "known", value: 2 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM message_content_states;").get()).toEqual({
      count: 1,
    });

    const second = await runInitialBackfillBatch(request(2, 3), {
      metadata: missingAdapter(),
      checkpoints: fixture.checkpoints,
      ingestSingleMessage: async () => ({
        messageId: createMessageId("message:unused"),
        status: "committed",
      }),
      persistMetadata: () => undefined,
      persistMissing: (observation) => {
        storeIdentityOnlyMessage(fixture.db, {
          messageId: observation.messageId,
          remoteUid: observation.remoteUid,
          absenceReason: observation.absenceReason,
          observedAt: observation.observedAt,
          storedAt: observation.observedAt,
        });
      },
      observedAt,
    });
    expect(second.status).toBe("committed");
    expect(second.processedUids).toEqual([2, 3]);
    expect(checkpointValue(fixture.checkpoints)?.uidNext).toEqual({ kind: "known", value: 4 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 3 });
    await fixture.close();
  });

  test("keeps the durable per-UID checkpoint for interruption after each terminal commit", async () => {
    for (const interruptedUid of [1, 2]) {
      const fixture = await setup();
      const controller = new AbortController();
      const result = await runInitialBackfillBatch(request(1, 2), {
        metadata: missingAdapter(),
        checkpoints: fixture.checkpoints,
        ingestSingleMessage: async () => ({
          messageId: createMessageId("message:unused"),
          status: "committed",
        }),
        persistMetadata: () => undefined,
        persistMissing: (observation) => {
          storeIdentityOnlyMessage(fixture.db, {
            messageId: observation.messageId,
            remoteUid: observation.remoteUid,
            absenceReason: observation.absenceReason,
            observedAt: observation.observedAt,
            storedAt: observation.observedAt,
          });
          if (observation.remoteUid.uid === interruptedUid) controller.abort();
        },
        observedAt,
        signal: controller.signal,
      });
      expect(result.checkpoint.uidNext).toEqual({
        kind: "known",
        value: interruptedUid + 1,
      });
      expect(result.processedUids).toEqual(interruptedUid === 1 ? [1] : [1, 2]);
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM message_content_states;").get()).toEqual({
        count: interruptedUid,
      });
      await fixture.close();
    }
  });

  test("returns the unchanged checkpoint when cancellation happens before the first terminal write", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    controller.abort();
    const result = await runInitialBackfillBatch(request(1, 2), {
      metadata: missingAdapter(),
      checkpoints: fixture.checkpoints,
      ingestSingleMessage: async () => ({
        messageId: createMessageId("message:unused"),
        status: "committed",
      }),
      persistMetadata: () => undefined,
      persistMissing: () => {
        throw new Error("cancellation must precede terminal storage");
      },
      observedAt,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.processedUids).toEqual([]);
    expect(result.checkpoint.uidNext).toEqual({ kind: "unknown" });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 0 });
    await fixture.close();
  });

  test("does not advance before the final message transaction and persists observation order", async () => {
    const fixture = await setup();
    const messageIds = [
      createMessageId(`message:${"b".repeat(64)}`),
      createMessageId(`message:${"c".repeat(64)}`),
    ];
    fixture.db.query("INSERT INTO messages (message_id) VALUES (?), (?);").run(...messageIds);
    fixture.db
      .query(
        "INSERT INTO remote_placements " +
          "(account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?);",
      )
      .run(accountId, mailboxId, uidValidity, 1, messageIds[0], accountId, mailboxId, uidValidity, 2, messageIds[1]);
    const observed: number[] = [];
    let attempts = 0;
    const run = (range: InitialBackfillBatchRequest["range"], fail: boolean) =>
      runInitialBackfillBatch({ ...request(range.start, range.end) }, {
        metadata: {
          fetch: async (input) => ({
            items: input.uids.map((uid) => item(uid)),
            missingUids: [],
          }),
        },
        checkpoints: fixture.checkpoints,
        ingestSingleMessage: async ({ request: messageRequest, metadata }) => {
          expect(messageRequest.uid).toBe(metadata.identity.uid);
          expect(metadata).toEqual(item(messageRequest.uid));
          attempts += 1;
          if (fail && attempts === 2) throw new Error("injected final ingestion failure");
          return { messageId: createMessageId(`message:${"a".repeat(64)}`), status: "committed" };
        },
        persistMetadata: (metadata, context) => {
          observed.push(metadata.identity.uid);
          expect(context.observationOrder).toBe(metadata.identity.uid);
          observeRemotePlacement(fixture.db, {
            accountId,
            mailboxId,
            uidValidity,
            uid: metadata.identity.uid,
            internalDate: metadata.internalDate,
            flags: metadata.flags,
            modseq: metadata.modseq,
            observationOrder: context.observationOrder,
            observedAt: context.observedAt,
            sourceCheckpoint: context.sourceCheckpoint,
          });
        },
        persistMissing: () => {
          throw new Error("unexpected gap");
        },
        observedAt,
      });
    await expect(
      run({ start: createRemoteUidValue(1), end: createRemoteUidValue(2) }, true),
    ).rejects.toThrow("injected final ingestion failure");
    expect(checkpointValue(fixture.checkpoints)?.uidNext).toEqual({ kind: "known", value: 2 });
    expect(observed).toEqual([1]);
    const result = await run({ start: createRemoteUidValue(2), end: createRemoteUidValue(2) }, false);
    expect(result.status).toBe("committed");
    expect(observed).toEqual([1, 2]);
    expect(checkpointValue(fixture.checkpoints)?.uidNext).toEqual({ kind: "known", value: 3 });
    expect(
      readRemotePlacementObservation(fixture.db, {
        accountId,
        mailboxId,
        uidValidity,
        uid: 2,
      })?.flags,
    ).toEqual(["\\Seen"]);
    await fixture.close();
  });
});
