import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createBlobId,
  createMailboxId,
  createMonotonicSequence,
  createMessageId,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import { openDatabase } from "../src/database";
import { runMigrations, type Migration } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { messageBlobReferencesMigration } from "../src/migrations/0003-message-blob-references";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import { createSqlitePromotionAdapter } from "../src/promotion-adapter";
import {
  RemotePlacementObservationError,
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
  runMigrations(opened, migrations);
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

async function openPromotedCatalog() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-promoted-observation-p3-c25-"));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  const promotedMigrations: readonly Migration[] = [
    messageCatalogMigration,
    { ...operationalJournalMigration, version: 2 },
    { ...messageBlobReferencesMigration, version: 3 },
    { ...placementObservationMigration, version: 4 },
  ];
  runMigrations(opened, promotedMigrations);
  opened.db
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, uidValidity);
  createSqlitePromotionAdapter(opened.db).promote({
    messageId,
    rawSource: { blobId: createBlobId(`blob:${"b".repeat(64)}`), size: 1 },
    placements: [{ ...identity, internalDate: "2026-08-18T00:00:00.000Z" }],
    headers: [],
    addresses: [],
    bodyParts: [],
    attachments: [],
    routingDecisions: [],
    journal: {
      id: "event:canonical-promotion:observation-test",
      occurredAt: "2026-08-18T00:00:00.000Z",
      category: "sync",
      subjectId: messageId,
      correlationId: "checkpoint:promotion:observation-test",
      payloadVersion: 1,
      payloadJson: "{\"kind\":\"canonical-promotion\"}",
    },
  });
  return { opened, path, migrations: promotedMigrations };
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
  test("completes the first observation after real canonical promotion without losing INTERNALDATE", async () => {
    const { opened, path, migrations: promotedMigrations } = await openPromotedCatalog();
    expect(readRemotePlacementObservation(opened.db, identity)).toBeUndefined();
    const result = observeRemotePlacement(opened.db, observation());

    expect(result.status).toBe("applied");
    expect(result.observation.internalDate).toBe("2026-08-18T00:00:00.000Z");
    expect(readRemotePlacementObservation(opened.db, identity)).toMatchObject({
      internalDate: "2026-08-18T00:00:00.000Z",
      flags: ["\\Seen"],
      modseq: { kind: "known", value: 10 },
      observationOrder: 1,
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 2 });

    await opened.close();
    const reopened = await openDatabase(path);
    runMigrations(reopened, promotedMigrations);
    expect(readRemotePlacementObservation(reopened.db, identity)?.internalDate).toBe(
      "2026-08-18T00:00:00.000Z",
    );
    await reopened.close();
  });

  test("rejects every partial order-zero observation state", async () => {
    const partialStates = [
      ["flags", "UPDATE remote_placements SET flags_json = '[\"\\\\Seen\"]';"],
      ["MODSEQ", "UPDATE remote_placements SET modseq_known = 1, modseq = 10;"],
      ["observed timestamp", "UPDATE remote_placements SET observation_observed_at = '2026-08-18T00:01:00.000Z';"],
      ["checkpoint", "UPDATE remote_placements SET observation_checkpoint = 'checkpoint:partial';"],
    ] as const;
    for (const [name, update] of partialStates) {
      const { opened } = await openCatalog();
      if (name === "observed timestamp" || name === "checkpoint") {
        expect(() => opened.db.exec(update), name).toThrow();
      } else {
        opened.db.exec(update);
        expect(() => readRemotePlacementObservation(opened.db, identity), name).toThrow();
      }
      await opened.close();
    }
  });

  test("rejects journal provenance on an otherwise unobserved placement", async () => {
    const { opened } = await openCatalog();
    opened.db
      .query(
        "INSERT INTO operational_journal (id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        "event:orphaned-placement-observation",
        "2026-08-18T00:01:00.000Z",
        "sync",
        `placement-observation:${createHash("sha256")
          .update(JSON.stringify([accountId, mailboxId, uidValidity, uid]))
          .digest("hex")}`,
        "checkpoint:orphaned",
        1,
        "{\"kind\":\"orphaned\"}",
      );
    expect(() => readRemotePlacementObservation(opened.db, identity)).toThrow();
    await opened.close();
  });

  test("rejects a conflicting promoted INTERNALDATE and rolls back matching observation journal failure", async () => {
    const { opened } = await openPromotedCatalog();
    expect(() =>
      opened.db
        .query("UPDATE remote_placements SET internal_date = NULL WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND uid = ?;")
        .run(accountId, mailboxId, uidValidity, uid),
    ).toThrow();
    let conflict: unknown;
    try {
      observeRemotePlacement(
        opened.db,
        observation({ internalDate: "2026-08-18T00:00:01.000Z" }),
      );
    } catch (error: unknown) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(RemotePlacementObservationError);
    if (!(conflict instanceof RemotePlacementObservationError)) {
      throw new Error("expected the conflicting promoted INTERNALDATE error");
    }
    expect(conflict.code).toBe("internal-date-conflict");
    expect(opened.db.query("SELECT internal_date, flags_json, modseq_known, modseq, observation_order FROM remote_placements;").get()).toEqual({
      internal_date: "2026-08-18T00:00:00.000Z",
      flags_json: "[]",
      modseq_known: 0,
      modseq: null,
      observation_order: 0,
    });

    opened.db.exec(`
      CREATE TRIGGER reject_promoted_observation_journal
      BEFORE INSERT ON operational_journal
      WHEN NEW.subject_id LIKE 'placement-observation:%'
      BEGIN
        SELECT RAISE(ABORT, 'injected promoted observation journal failure');
      END;
    `);
    expect(() => observeRemotePlacement(opened.db, observation())).toThrow();
    expect(opened.db.query("SELECT internal_date, flags_json, modseq_known, modseq, observation_order FROM remote_placements;").get()).toEqual({
      internal_date: "2026-08-18T00:00:00.000Z",
      flags_json: "[]",
      modseq_known: 0,
      modseq: null,
      observation_order: 0,
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 1 });
    await opened.close();
  });

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
    const reopened = await openDatabase(path);
    runMigrations(reopened, migrations);
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
