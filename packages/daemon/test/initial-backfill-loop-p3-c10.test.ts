import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createAccountId,
  createMailboxId,
  createMessageId,
  createRemoteUidValue,
  createUtcInstant,
  createUidValidity,
} from "@agent-mail/core";
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
import { storeIdentityOnlyMessage } from "../../storage/src/identity-only-repository";
import {
  createInitialBackfillCompletionRepository,
  initialBackfillCompletionMigration,
  runInitialBackfillLoop,
  type InitialBackfillLoopRequest,
} from "../src/initial-backfill-loop";
import type { InitialBackfillLoopDependencies } from "../src/initial-backfill-loop";

const accountId = createAccountId("account:loop");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(42);
const observedAt = createUtcInstant("2026-08-18T00:00:00.000Z");
const eligibleAt = createUtcInstant("2026-08-18T01:00:00.000Z");
const laterEligibleAt = createUtcInstant("2026-08-18T02:00:00.000Z");
const roots: string[] = [];

async function setup(): Promise<{ db: Database; path: string; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-backfill-loop-"));
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
  return { db: opened.db, path, close: opened.close };
}

function request(ceiling: number | null, nextSweepEligibleAt = eligibleAt): InitialBackfillLoopRequest {
  return {
    accountId,
    mailboxId,
    uidValidity,
    observedUidCeiling: ceiling === null ? null : createRemoteUidValue(ceiling),
    observedUidNext:
      ceiling === null ? { kind: "unknown" } : { kind: "known", value: createRemoteUidValue(ceiling + 1) },
    observedAt,
    nextSweepEligibleAt,
    maxBatchUids: 2,
    stagingDirectory: "/tmp/agent-mail-backfill-loop-staging",
    owner: { pid: process.pid, processStartIdentity: "backfill-loop-test" },
  };
}

function dependencies(db: Database, signal?: AbortSignal): InitialBackfillLoopDependencies {
  return {
    checkpoints: createMailboxCheckpointRepository(db),
    completions: createInitialBackfillCompletionRepository(db),
    batch: {
      metadata: {
        fetch: async (input) => ({ items: [], missingUids: input.uids }),
      },
      ingestSingleMessage: async () => ({
        messageId: createMessageId("message:unused"),
        placementIds: [],
        routingDecisionIds: [],
        journalId: "journal:unused",
        status: "committed",
      }),
      persistMetadata: () => {
        throw new Error("metadata persistence must not run for missing UIDs");
      },
      persistMissing: (observation) => {
        storeIdentityOnlyMessage(db, {
          messageId: observation.messageId,
          remoteUid: observation.remoteUid,
          absenceReason: observation.absenceReason,
          observedAt: observation.observedAt,
          storedAt: observation.observedAt,
        });
      },
    },
    signal,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("initial backfill loop P3-C10", () => {
  test("processes bounded ranges and reopens with completion facts and sweep eligibility", async () => {
    const fixture = await setup();
    const first = await runInitialBackfillLoop(request(5), dependencies(fixture.db));
    expect(first.status).toBe("completed");
    expect(first.processedRanges.map((range) => [range.start, range.end])).toEqual([
      [createRemoteUidValue(1), createRemoteUidValue(2)],
      [createRemoteUidValue(3), createRemoteUidValue(4)],
      [createRemoteUidValue(5), createRemoteUidValue(5)],
    ]);
    expect(first.checkpoint.backfillCompleted).toBe(true);
    expect(first.checkpoint.uidNext).toEqual({ kind: "known", value: createRemoteUidValue(6) });
    expect(first.completion).toEqual({
      observedUidCeiling: createRemoteUidValue(5),
      observedUidNext: { kind: "known", value: createRemoteUidValue(6) },
      observedAt,
      nextSweepEligibleAt: eligibleAt,
    });
    await fixture.close();

    const reopened = await openDatabase(fixture.path, { supportedSchemaVersion: 6 });
    const checkpoints = createMailboxCheckpointRepository(reopened.db);
    const completions = createInitialBackfillCompletionRepository(reopened.db);
    expect(checkpoints.read({ accountId, mailboxId, uidValidity })).toMatchObject({
      backfillCompleted: true,
      uidNext: { kind: "known", value: createRemoteUidValue(6) },
    });
    expect(completions.read({ accountId, mailboxId, uidValidity })).toEqual(first.completion);
    await reopened.close();
  });

  test("keeps a later server UID discoverable after initial completion", async () => {
    const fixture = await setup();
    const first = await runInitialBackfillLoop(request(5), dependencies(fixture.db));
    expect(first.status).toBe("completed");

    let metadataCalls = 0;
    const second = await runInitialBackfillLoop(request(6, laterEligibleAt), {
      ...dependencies(fixture.db),
      batch: {
        ...dependencies(fixture.db).batch,
        metadata: {
          fetch: async () => {
            metadataCalls += 1;
            return { items: [], missingUids: [] };
          },
        },
      },
    });

    expect(second.status).toBe("already-complete");
    expect(metadataCalls).toBe(0);
    expect(second.checkpoint.backfillCompleted).toBe(true);
    expect(second.checkpoint.uidNext).toEqual({ kind: "known", value: createRemoteUidValue(6) });
    expect(second.completion).toMatchObject({
      observedUidCeiling: createRemoteUidValue(6),
      observedUidNext: { kind: "known", value: createRemoteUidValue(7) },
      nextSweepEligibleAt: laterEligibleAt,
    });
    expect(
      createInitialBackfillCompletionRepository(fixture.db).read({
        accountId,
        mailboxId,
        uidValidity,
      })?.nextSweepEligibleAt,
    ).toBe(laterEligibleAt);
    await fixture.close();
  });

  test("rolls back the checkpoint when completion persistence fails between logical writes", async () => {
    const fixture = await setup();
    await expect(
      runInitialBackfillLoop(request(2), {
        ...dependencies(fixture.db),
        completions: createInitialBackfillCompletionRepository(fixture.db, {
          beforeCompletionWrite: () => {
            throw new Error("injected completion persistence failure");
          },
        }),
      }),
    ).rejects.toThrow("injected completion persistence failure");
    const checkpoints = createMailboxCheckpointRepository(fixture.db);
    expect(checkpoints.read({ accountId, mailboxId, uidValidity })).toMatchObject({
      backfillCompleted: false,
      uidNext: { kind: "known", value: createRemoteUidValue(3) },
    });
    expect(
      createInitialBackfillCompletionRepository(fixture.db).read({
        accountId,
        mailboxId,
        uidValidity,
      }),
    ).toBeUndefined();

    await fixture.close();
    const reopened = await openDatabase(fixture.path, { supportedSchemaVersion: 6 });
    const recovered = await runInitialBackfillLoop(request(2), dependencies(reopened.db));
    expect(recovered.status).toBe("completed");
    expect(recovered.checkpoint.backfillCompleted).toBe(true);
    expect(recovered.completion?.nextSweepEligibleAt).toBe(eligibleAt);
    expect(
      createInitialBackfillCompletionRepository(reopened.db).read({
        accountId,
        mailboxId,
        uidValidity,
      }),
    ).toEqual(recovered.completion);
    await reopened.close();
  });

  test("stops between bounded batches on cancellation without recording completion", async () => {
    const fixture = await setup();
    const controller = new AbortController();
    let metadataCalls = 0;
    const result = await runInitialBackfillLoop(request(5), {
      ...dependencies(fixture.db, controller.signal),
      batch: {
        ...dependencies(fixture.db).batch,
        metadata: {
          fetch: async (input) => {
            metadataCalls += 1;
            if (metadataCalls === 2) controller.abort();
            return { items: [], missingUids: input.uids };
          },
        },
      },
    });
    expect(result.status).toBe("cancelled");
    expect(result.processedRanges).toEqual([
      { start: createRemoteUidValue(1), end: createRemoteUidValue(2) },
    ]);
    expect(result.checkpoint.uidNext).toEqual({ kind: "known", value: createRemoteUidValue(3) });
    expect(result.checkpoint.backfillCompleted).toBe(false);
    expect(createInitialBackfillCompletionRepository(fixture.db).read({ accountId, mailboxId, uidValidity })).toBeUndefined();
    await fixture.close();
  });
});
