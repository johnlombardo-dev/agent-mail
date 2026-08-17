import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createAccountId,
  createMailboxId,
  createMessageId,
  createRemoteUid,
  createRemoteUidValue,
  createUtcInstant,
  createUidValidity,
  type UtcInstant,
} from "@agent-mail/core";
import { createMetadataBatchAdapter, type MetadataBatchItem } from "../../imap/src/metadata-batch";
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
  createInitialBackfillCompletionRepository,
  initialBackfillCompletionMigration,
  runInitialBackfillLoop,
} from "../src/initial-backfill-loop";
import { observeRemotePlacement } from "../../storage/src/remote-placement-observation";
import { tombstoneRemotePlacement } from "../../storage/src/remote-placement-tombstone";
import {
  runRecurringMailboxSweep,
  type RecurringSweepDependencies,
  type RecurringSweepRequest,
} from "../src/recurring-mailbox-sweep";
import type { InitialBackfillBatchDependencies } from "../src/initial-backfill-batch";

const accountId = createAccountId("account:recurring-sweep");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(42);
const initialObservedAt = createUtcInstant("2026-08-18T00:00:00.000Z");
const eligibleAt = createUtcInstant("2026-08-18T01:00:00.000Z");
const nextEligibleAt = createUtcInstant("2026-08-18T02:00:00.000Z");
const thirdEligibleAt = createUtcInstant("2026-08-18T03:00:00.000Z");
const roots: string[] = [];

type FakeMessage = Readonly<{ readonly uid: number; readonly flags: readonly string[] }>;

class ProductionShapedFakeImap {
  readonly calls: number[][] = [];
  private readonly messages = new Map<number, FakeMessage>();

  add(uid: number, flags: readonly string[] = ["\\Flagged"]): void {
    this.messages.set(uid, { uid, flags });
  }

  remove(uid: number): void {
    this.messages.delete(uid);
  }

  snapshotFlags(): readonly (readonly [number, readonly string[]])[] {
    return [...this.messages.values()]
      .sort((left, right) => left.uid - right.uid)
      .map((message): readonly [number, readonly string[]] => [message.uid, message.flags]);
  }

  metadata = createMetadataBatchAdapter({
    fetchAll: async (range) => {
      const uids = range.split(",").map((value) => Number(value));
      this.calls.push(uids);
      return uids
        .map((uid) => this.messages.get(uid))
        .filter((message): message is FakeMessage => message !== undefined)
        .map((message) => ({
          uid: message.uid,
          flags: new Set(message.flags),
          envelope: { subject: `Message ${message.uid}` },
          size: 128,
          internalDate: new Date("2026-08-18T00:00:00.000Z"),
        }));
    },
  });
}

async function setup(): Promise<{
  readonly db: Database;
  readonly path: string;
  readonly close: () => Promise<void>;
  readonly server: ProductionShapedFakeImap;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-recurring-sweep-"));
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  applyMigrations(opened, [
    { ...messageCatalogMigration, version: 1 },
    { ...mailboxCheckpointMigration, version: 2 },
    { ...identityOnlyContentMigration, version: 3 },
    { ...operationalJournalMigration, version: 4 },
    { ...placementObservationMigration, version: 5 },
    { ...initialBackfillCompletionMigration, version: 6 },
  ]);
  opened.db
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity);
  return { db: opened.db, path, close: opened.close, server: new ProductionShapedFakeImap() };
}

function messageId(uid: number) {
  return createMessageId(`message:${uid.toString(16).padStart(64, "0")}`);
}

function ingestIntoSqlite(db: Database, item: MetadataBatchItem) {
  const id = messageId(item.identity.uid);
  db.query("INSERT INTO messages (message_id) VALUES (?) ON CONFLICT DO NOTHING;").run(id);
  db.query(
    "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id) " +
      "VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING;",
  ).run(accountId, mailboxId, uidValidity, item.identity.uid, id);
  return { messageId: id, status: "committed" } satisfies Readonly<{
    readonly messageId: ReturnType<typeof messageId>;
    readonly status: "committed";
  }>;
}

function batchDependencies(
  db: Database,
  server: ProductionShapedFakeImap,
): Omit<InitialBackfillBatchDependencies, "checkpoints" | "observedAt" | "signal"> {
  return {
    metadata: server.metadata,
    ingestSingleMessage: async ({ metadata }: { readonly metadata: MetadataBatchItem }) =>
      ingestIntoSqlite(db, metadata),
    persistMetadata: (item: MetadataBatchItem, context: { readonly observationOrder: number; readonly sourceCheckpoint: string; readonly observedAt: UtcInstant }) => {
      observeRemotePlacement(db, {
        accountId,
        mailboxId,
        uidValidity,
        uid: item.identity.uid,
        internalDate: item.internalDate,
        flags: item.flags,
        modseq: item.modseq,
        observationOrder: context.observationOrder,
        observedAt: context.observedAt,
        sourceCheckpoint: context.sourceCheckpoint,
      });
    },
    persistMissing: () => {
      throw new Error("unexpected missing UID during recurring sweep fixture");
    },
  };
}

async function completeInitialBackfill(db: Database, server: ProductionShapedFakeImap, ceiling: number) {
  const checkpoints = createMailboxCheckpointRepository(db);
  const completions = createInitialBackfillCompletionRepository(db);
  const result = await runInitialBackfillLoop(
    {
      accountId,
      mailboxId,
      uidValidity,
      observedUidCeiling: createRemoteUidValue(ceiling),
      observedUidNext: { kind: "known", value: createRemoteUidValue(ceiling + 1) },
      observedAt: initialObservedAt,
      nextSweepEligibleAt: eligibleAt,
      maxBatchUids: 10,
      stagingDirectory: "/tmp/agent-mail-recurring-sweep-staging",
      owner: { pid: process.pid, processStartIdentity: "recurring-sweep-test" },
    },
    {
      checkpoints,
      completions,
      batch: { ...batchDependencies(db, server) },
    },
  );
  expect(result.status).toBe("completed");
}

function sweepRequest(
  observedAt = eligibleAt,
  nextSweepEligibleAt = nextEligibleAt,
): RecurringSweepRequest {
  return {
    identity: { accountId, mailboxId, uidValidity },
    now: observedAt,
    observedUidCeiling: createRemoteUidValue(3),
    observedUidNext: { kind: "known", value: createRemoteUidValue(4) },
    observedAt,
    nextSweepEligibleAt,
    maxNewUidBatchUids: 10,
    maxReconciliationUids: 10,
    stagingDirectory: "/tmp/agent-mail-recurring-sweep-staging",
    owner: { pid: process.pid, processStartIdentity: "recurring-sweep-test" },
    actor: { id: "sync-actor-1" },
  };
}

function dependencies(
  db: Database,
  server: ProductionShapedFakeImap,
  reconcileExistingPlacement: RecurringSweepDependencies["reconcileExistingPlacement"],
  ownsActor = true,
): RecurringSweepDependencies {
  return {
    checkpoints: createMailboxCheckpointRepository(db),
    completions: createInitialBackfillCompletionRepository(db),
    batch: batchDependencies(db, server),
    listExistingPlacementUids: (identity, after, limit) =>
      db
        .query(
          "SELECT uid FROM remote_placements WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? " +
            "AND tombstone_observed_at IS NULL AND uid > ? ORDER BY uid LIMIT ?;",
        )
        .all(identity.accountId, identity.mailboxId, identity.uidValidity, after, limit)
        .map((row) => {
          if (typeof row !== "object" || row === null || !("uid" in row) || typeof row.uid !== "number") {
            throw new TypeError("fixture placement row is invalid");
          }
          return createRemoteUidValue(row.uid);
        }),
    reconcileExistingPlacement,
    ownsActor: () => ownsActor,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recurring mailbox sweep P3-C11", () => {
  test("completed backfill still discovers later UID and keeps IMAP read-only", async () => {
    const fixture = await setup();
    fixture.server.add(1);
    fixture.server.add(2);
    await completeInitialBackfill(fixture.db, fixture.server, 2);
    fixture.server.add(3);
    const flagsBeforeSweep = fixture.server.snapshotFlags();

    const result = await runRecurringMailboxSweep(
      sweepRequest(),
      dependencies(fixture.db, fixture.server, ({ identity, uid, metadata, observedAt, sourceCheckpoint }) => {
        if (metadata === undefined) throw new Error(`fixture unexpectedly omitted UID ${uid}`);
        observeRemotePlacement(fixture.db, {
          accountId: identity.accountId,
          mailboxId: identity.mailboxId,
          uidValidity: identity.uidValidity,
          uid,
          internalDate: metadata.internalDate,
          flags: metadata.flags,
          modseq: metadata.modseq,
          observationOrder: uid,
          observedAt,
          sourceCheckpoint,
        });
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.discoveredUids).toEqual([3]);
    expect(result.reconciledUids).toEqual([1, 2]);
    expect(fixture.db.query("SELECT uid FROM remote_placements ORDER BY uid;").all()).toEqual([
      { uid: 1 },
      { uid: 2 },
      { uid: 3 },
    ]);
    expect(result.checkpoint.sweepCursor).toBe(0);
    expect(result.completion.nextSweepEligibleAt).toBe(nextEligibleAt);
    expect(result.completion.observedUidCeiling).toBe(3);
    expect(result.completion.observedUidNext).toEqual({ kind: "known", value: 4 });
    expect(fixture.server.snapshotFlags()).toEqual(flagsBeforeSweep);
    await fixture.close();
  });

  test("interrupted reconciliation leaves cursor and eligibility behind the unfinished UID", async () => {
    const fixture = await setup();
    fixture.server.add(1);
    fixture.server.add(2);
    await completeInitialBackfill(fixture.db, fixture.server, 2);
    fixture.server.add(3);

    await expect(
      runRecurringMailboxSweep(
        sweepRequest(),
        dependencies(fixture.db, fixture.server, ({ uid }) => {
          if (uid === 2) throw new Error("injected reconciliation interruption");
        }),
      ),
    ).rejects.toThrow("injected reconciliation interruption");
    const afterInterruption = createMailboxCheckpointRepository(fixture.db).read({
      accountId,
      mailboxId,
      uidValidity,
    });
    expect(afterInterruption?.uidNext).toEqual({ kind: "known", value: createRemoteUidValue(4) });
    expect(afterInterruption?.sweepCursor).toBe(0);
    expect(
      createInitialBackfillCompletionRepository(fixture.db).read({ accountId, mailboxId, uidValidity })
        ?.nextSweepEligibleAt,
    ).toBe(eligibleAt);

    const resumed = await runRecurringMailboxSweep(
      sweepRequest(),
      dependencies(fixture.db, fixture.server, ({ identity, uid, metadata, observedAt, sourceCheckpoint }) => {
        if (metadata === undefined) throw new Error(`fixture unexpectedly omitted UID ${uid}`);
        observeRemotePlacement(fixture.db, {
          accountId: identity.accountId,
          mailboxId: identity.mailboxId,
          uidValidity: identity.uidValidity,
          uid,
          internalDate: metadata.internalDate,
          flags: metadata.flags,
          modseq: metadata.modseq,
          observationOrder: uid,
          observedAt,
          sourceCheckpoint,
        });
      }),
    );
    expect(resumed.discoveredUids).toEqual([]);
    expect(resumed.reconciledUids).toEqual([1, 2, 3]);
    expect(resumed.checkpoint.sweepCursor).toBe(0);
    expect(resumed.completion.nextSweepEligibleAt).toBe(nextEligibleAt);
    expect(resumed.completion.observedUidCeiling).toBe(3);
    expect(resumed.completion.observedUidNext).toEqual({ kind: "known", value: 4 });
    expect(fixture.server.calls.slice(-1)[0]).toEqual([1, 2, 3]);
    await fixture.close();
  });

  test("wraps after reaching the end so a later cycle revisits and tombstones a removed UID", async () => {
    const fixture = await setup();
    fixture.server.add(1);
    fixture.server.add(2);
    await completeInitialBackfill(fixture.db, fixture.server, 2);
    fixture.server.add(3);

    const reconcile = ({ identity, uid, metadata, observedAt, sourceCheckpoint }: Parameters<RecurringSweepDependencies["reconcileExistingPlacement"]>[0]) => {
      if (metadata === undefined) {
        tombstoneRemotePlacement(fixture.db, {
          accountId: identity.accountId,
          mailboxId: identity.mailboxId,
          uidValidity: identity.uidValidity,
          uid,
          observedAt,
          sourceCheckpoint,
          reason: `fake server omitted UID ${uid}`,
        });
        return;
      }
      observeRemotePlacement(fixture.db, {
        accountId: identity.accountId,
        mailboxId: identity.mailboxId,
        uidValidity: identity.uidValidity,
        uid,
        internalDate: metadata.internalDate,
        flags: metadata.flags,
        modseq: metadata.modseq,
        observationOrder: uid,
        observedAt,
        sourceCheckpoint,
      });
    };

    const first = await runRecurringMailboxSweep(
      sweepRequest(),
      dependencies(fixture.db, fixture.server, reconcile),
    );
    expect(first.checkpoint.sweepCursor).toBe(0);

    fixture.server.remove(1);
    const second = await runRecurringMailboxSweep(
      sweepRequest(nextEligibleAt, thirdEligibleAt),
      dependencies(fixture.db, fixture.server, reconcile),
    );
    expect(second.reconciledUids).toEqual([1, 2, 3]);
    expect(second.checkpoint.sweepCursor).toBe(0);
    expect(
      fixture.db
        .query("SELECT tombstone_observed_at FROM remote_placements WHERE uid = 1;")
        .get(),
    ).not.toEqual({ tombstone_observed_at: null });
    expect(second.completion.observedUidCeiling).toBe(3);
    expect(second.completion.observedUidNext).toEqual({ kind: "known", value: 4 });
    await fixture.close();
  });

  test("requires eligibility and actor ownership without using completion as an early-return guard", async () => {
    const fixture = await setup();
    fixture.server.add(1);
    await completeInitialBackfill(fixture.db, fixture.server, 1);
    const before = fixture.server.calls.length;
    const early = await runRecurringMailboxSweep(
      { ...sweepRequest(createUtcInstant("2026-08-18T00:30:00.000Z")), observedUidCeiling: createRemoteUidValue(1) },
      dependencies(fixture.db, fixture.server, () => undefined),
    );
    expect(early.status).toBe("not-eligible");
    expect(fixture.server.calls.length).toBe(before);

    await expect(
      runRecurringMailboxSweep(
        { ...sweepRequest(), observedUidNext: { kind: "known", value: createRemoteUidValue(3) } },
        dependencies(fixture.db, fixture.server, () => undefined),
      ),
    ).rejects.toThrow("observed UIDNEXT must exceed");
    expect(fixture.server.calls.length).toBe(before);

    const notOwner = await runRecurringMailboxSweep(
      sweepRequest(),
      dependencies(fixture.db, fixture.server, () => undefined, false),
    );
    expect(notOwner.status).toBe("not-owner");
    expect(fixture.server.calls.length).toBe(before);
    await fixture.close();
  });
});
