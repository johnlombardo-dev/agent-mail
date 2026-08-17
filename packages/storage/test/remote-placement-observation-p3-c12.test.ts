import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createMonotonicSequence,
  createMessageId,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import {
  observeRemotePlacement,
  readRemotePlacementObservation,
  type RemotePlacementObservationInput,
} from "../src/remote-placement-observation";

const roots: string[] = [];
const accountId = createAccountId("account:one");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(10);
const uid = createRemoteUidValue(7);
const messageId = createMessageId(`message:${"a".repeat(64)}`);
const identity = { accountId, mailboxId, uidValidity, uid };
const migrations: readonly Migration[] = [
  messageCatalogMigration,
  { ...operationalJournalMigration, version: 2 },
  placementObservationMigration,
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openCatalog() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-observation-p3-c12-"));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  applyMigrations(opened, migrations);
  opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  opened.db
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, uidValidity);
  opened.db
    .query(
      "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity, uid, messageId);
  return { opened, path };
}

function observation(overrides: Partial<RemotePlacementObservationInput> = {}): RemotePlacementObservationInput {
  return {
    ...identity,
    internalDate: "2026-08-18T00:00:00.000Z",
    flags: ["\\Seen"],
    modseq: { kind: "known", value: 10 },
    observationOrder: 1,
    observedAt: "2026-08-18T00:01:00.000Z",
    sourceCheckpoint: "checkpoint:inbox:10:1",
    ...overrides,
  };
}

describe("remote placement observation repository P3-C12", () => {
  test("orders real SQLite observations, preserves placement-scoped flags, and is idempotent", async () => {
    const { opened, path } = await openCatalog();
    const first = observeRemotePlacement(opened.db, observation());
    const newer = observeRemotePlacement(
      opened.db,
      observation({
        flags: ["\\Flagged", "\\Seen"],
        modseq: { kind: "known", value: 11 },
        observationOrder: 2,
        observedAt: "2026-08-18T00:02:00.000Z",
        sourceCheckpoint: "checkpoint:inbox:10:2",
      }),
    );
    const equal = observeRemotePlacement(
      opened.db,
      observation({
        flags: ["\\Seen", "\\Flagged"],
        modseq: { kind: "known", value: 11 },
        observationOrder: 4,
        observedAt: "2026-08-18T00:04:00.000Z",
        sourceCheckpoint: "checkpoint:inbox:10:4",
      }),
    );
    const stale = observeRemotePlacement(
      opened.db,
      observation({
        flags: [],
        modseq: { kind: "known", value: 10 },
        observationOrder: 3,
        observedAt: "2026-08-18T00:03:00.000Z",
        sourceCheckpoint: "checkpoint:inbox:10:3",
      }),
    );

    expect(first.status).toBe("applied");
    expect(newer.status).toBe("applied");
    expect(equal.status).toBe("already-applied");
    expect(stale.status).toBe("stale");
    expect(stale.observation.flags).toEqual(["\\Flagged", "\\Seen"]);
    expect(stale.observation.modseq).toEqual({ kind: "known", value: createMonotonicSequence(11) });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 2 });

    await opened.close();
    const reopened = await openDatabase(path, { supportedSchemaVersion: 3 });
    applyMigrations(reopened, migrations);
    expect(readRemotePlacementObservation(reopened.db, identity)).toMatchObject({
      internalDate: "2026-08-18T00:00:00.000Z",
      flags: ["\\Flagged", "\\Seen"],
      modseq: { kind: "known", value: 11 },
      observationOrder: 2,
    });
    await reopened.close();
  });

  test("rejects equal-MODSEQ flag conflicts and contradictory INTERNALDATE", async () => {
    const { opened } = await openCatalog();
    observeRemotePlacement(opened.db, observation());
    expect(() =>
      observeRemotePlacement(
        opened.db,
        observation({ flags: ["\\Flagged"], observationOrder: 2, sourceCheckpoint: "checkpoint:inbox:10:2" }),
      ),
    ).toThrow();
    expect(() =>
      observeRemotePlacement(opened.db, observation({ internalDate: "2026-08-18T00:00:01.000Z", observationOrder: 2 })),
    ).toThrow();
    expect(readRemotePlacementObservation(opened.db, identity)?.flags).toEqual(["\\Seen"]);
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 1 });
    await opened.close();
  });

  test("requires explicit positive ordering for unknown MODSEQ and rolls back on journal failure", async () => {
    const { opened } = await openCatalog();
    expect(() => observeRemotePlacement(opened.db, observation({ modseq: { kind: "unknown" }, observationOrder: 0 }))).toThrow();
    opened.db.exec(`
      CREATE TRIGGER reject_placement_observation_journal
      BEFORE INSERT ON operational_journal
      WHEN NEW.subject_id LIKE 'placement-observation:%'
      BEGIN
        SELECT RAISE(ABORT, 'injected placement observation journal failure');
      END;
    `);
    expect(() => observeRemotePlacement(opened.db, observation({ modseq: { kind: "unknown" }, observationOrder: 1 }))).toThrow();
    expect(opened.db.query("SELECT internal_date, flags_json, modseq_known, modseq, observation_order FROM remote_placements;").get()).toEqual({
      internal_date: null,
      flags_json: "[]",
      modseq_known: 0,
      modseq: null,
      observation_order: 0,
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 0 });
    await opened.close();
  });
});
