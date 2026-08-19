import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createBlobId,
  createLocalLabel,
  createMailboxId,
  createMessageId,
  createRemoteUid,
  createRouteDecision,
  createRoutingRuleId,
  createUtcInstant,
  serializeRemoteUid,
  type MessageId,
} from "@agent-mail/core";
import { runMigrations, type Migration } from "../src/migration-runner";
import { openDatabase, type OpenDatabase } from "../src/database";
import { writeBackup } from "../src/backup-writer";
import { restoreBackup } from "../src/backup-restore";
import {
  promoteCanonicalMessage,
  readCanonicalPromotion,
  type PromotionUnit,
} from "../src/canonical-promotion";
import {
  readIdentityOnlyMessage,
  storeIdentityOnlyMessage,
} from "../src/identity-only-repository";
import {
  readRemotePlacement,
  tombstoneRemotePlacement,
} from "../src/remote-placement-tombstone";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { identityOnlyContentMigration } from "../src/migrations/0002-identity-only-content";
import { localLabelMigration } from "../src/local-label-migration";
import { routingDecisionMigration } from "../src/routing-decision-migration";
import { messageBlobReferencesMigration } from "../src/migrations/0003-message-blob-references";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";

import comparisonFixture from "./fixtures/backup-restore-p2-c19-comparison.json";

const roots: string[] = [];

const migrations: readonly Migration[] = [
  { ...messageCatalogMigration, version: 1 },
  { ...structuredContentMigration, version: 2 },
  { ...operationalJournalMigration, version: 3 },
  { ...localLabelMigration, version: 4 },
  { ...routingDecisionMigration, version: 5 },
  { ...messageBlobReferencesMigration, version: 6 },
  { ...placementObservationMigration, version: 7 },
  { ...identityOnlyContentMigration, version: 8 },
];

type Fixture = Readonly<{
  readonly root: string;
  readonly databasePath: string;
  readonly blobDirectory: string;
  readonly journalDirectory: string;
  readonly metadataPath: string;
  readonly backupPath: string;
  readonly bodyBlob: string;
  readonly attachmentBlob: string;
  readonly messageId: MessageId;
  readonly identityOnlyMessageId: MessageId;
  readonly accountId: ReturnType<typeof createAccountId>;
  readonly mailboxId: ReturnType<typeof createMailboxId>;
  readonly uidValidity: number;
  readonly liveUid: number;
  readonly tombstonedUid: number;
  readonly identityOnlyUid: number;
  readonly opened: OpenDatabase;
}>;

type CanonicalPromotion = NonNullable<ReturnType<typeof readCanonicalPromotion>>;
type IdentityOnlyMessage = NonNullable<ReturnType<typeof readIdentityOnlyMessage>>;
type RemotePlacement = NonNullable<ReturnType<typeof readRemotePlacement>>;

type DomainSnapshot = Readonly<{
  readonly canonical: CanonicalPromotion;
  readonly identityOnly: IdentityOnlyMessage;
  readonly livePlacement: RemotePlacement;
  readonly tombstonedPlacement: RemotePlacement & {
    readonly tombstone: NonNullable<RemotePlacement["tombstone"]>;
  };
  readonly journalOrder: readonly string[];
}>;

const messageId = createMessageId(comparisonFixture.messageId);
const identityOnlyMessageId = createMessageId(comparisonFixture.identityOnlyMessageId);
const accountId = createAccountId(comparisonFixture.accountId);
const mailboxId = createMailboxId(comparisonFixture.mailboxId);
const uidValidity = comparisonFixture.uidValidity;
const liveUid = comparisonFixture.liveUid;
const tombstonedUid = comparisonFixture.tombstonedUid;
const identityOnlyUid = comparisonFixture.identityOnlyUid;

function assertFixtureNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

const canonicalUnit: PromotionUnit = {
  messageId,
  rawSource: {
    blobId: createBlobId(createHash("sha256").update(comparisonFixture.plainBody).digest("hex")),
    size: Buffer.byteLength(comparisonFixture.plainBody),
  },
  placements: [
    {
      accountId,
      mailboxId,
      uidValidity,
      uid: liveUid,
      internalDate: createUtcInstant("2026-08-18T00:00:00.000Z"),
    },
    {
      accountId,
      mailboxId,
      uidValidity,
      uid: tombstonedUid,
      internalDate: createUtcInstant("2026-08-18T00:00:00.000Z"),
    },
  ],
  headers: [
    {
      ordinal: 1,
      name: "Subject",
      normalizedName: "subject",
      value: "Restore parity",
      normalizedValue: "restore parity",
    },
  ],
  addresses: [
    {
      ordinal: 1,
      role: "from",
      position: 1,
      address: "Ada <ada@example.test>",
      normalizedAddress: "ada@example.test",
      displayName: "Ada",
      groupName: null,
    },
  ],
  bodyParts: [
    {
      ordinal: 1,
      contentType: "text/plain",
      normalizedContentType: "text/plain",
      size: Buffer.byteLength(comparisonFixture.plainBody),
      blobId: createBlobId(createHash("sha256").update(comparisonFixture.plainBody).digest("hex")),
    },
  ],
  attachments: [
    {
      ordinal: 1,
      filename: "attachment.txt",
      contentType: "text/plain",
      normalizedContentType: "text/plain",
      disposition: "attachment",
      contentId: null,
      size: Buffer.byteLength(comparisonFixture.attachment),
      blobId: createBlobId(
        createHash("sha256").update(comparisonFixture.attachment).digest("hex"),
      ),
    },
  ],
  routingDecisions: [
    {
      decisionId: "fixture-caller-id",
      decision: createRouteDecision({
        kind: "route",
        ruleId: createRoutingRuleId(comparisonFixture.routingRuleId),
        ruleVersion: comparisonFixture.routingRuleVersion,
        matchedFacts: [{ field: "sender", value: "ada@example.test" }],
        decidedAt: createUtcInstant(comparisonFixture.routingDecidedAt),
        provenance: {
          source: comparisonFixture.routingSource,
          evaluationId: comparisonFixture.routingEvaluationId,
        },
        label: createLocalLabel(comparisonFixture.routingLabel),
      }),
    },
  ],
  journal: {
    id: comparisonFixture.promotionJournalId,
    occurredAt: createUtcInstant(comparisonFixture.promotionJournalAt),
    category: "sync",
    subjectId: messageId,
    correlationId: "sync:restore-parity",
    payloadVersion: 1,
    payloadJson: '{"status":"promoted"}',
  },
};

function assertFixture(): void {
  assertFixtureNumber(uidValidity, "uidValidity");
  assertFixtureNumber(liveUid, "liveUid");
  assertFixtureNumber(tombstonedUid, "tombstonedUid");
  assertFixtureNumber(identityOnlyUid, "identityOnlyUid");
}

async function createFixture(): Promise<Fixture> {
  assertFixture();
  const root = await mkdtemp(join(tmpdir(), "agent-mail-restore-parity-p2-c19-"));
  roots.push(root);
  await chmod(root, 0o700);
  const dataDirectory = join(root, "data");
  const blobDirectory = join(root, "blobs");
  const journalDirectory = join(root, "journal");
  const configDirectory = join(root, "config");
  const backupDirectory = join(root, "backups");
  await Promise.all(
    [dataDirectory, blobDirectory, journalDirectory, configDirectory, backupDirectory].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );

  const databasePath = join(dataDirectory, "archive.sqlite");
  const opened = await openDatabase(databasePath);
  runMigrations(opened, migrations);
  opened.db
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity);
  promoteCanonicalMessage(opened.db, canonicalUnit);
  tombstoneRemotePlacement(opened.db, {
    accountId,
    mailboxId,
    uidValidity,
    uid: tombstonedUid,
    observedAt: comparisonFixture.tombstoneObservedAt,
    sourceCheckpoint: comparisonFixture.tombstoneSourceCheckpoint,
    reason: comparisonFixture.tombstoneReason,
  });
  storeIdentityOnlyMessage(opened.db, {
    messageId: identityOnlyMessageId,
    remoteUid: serializeRemoteUid(
      createRemoteUid({ accountId, mailboxId, uidValidity, uid: identityOnlyUid }),
    ),
    absenceReason: comparisonFixture.identityOnlyAbsenceReason,
    observedAt: comparisonFixture.identityOnlyObservedAt,
    storedAt: comparisonFixture.identityOnlyStoredAt,
  });

  const bodyBlob = canonicalUnit.bodyParts[0].blobId.slice("blob:".length);
  const attachmentBlob = canonicalUnit.attachments[0].blobId.slice("blob:".length);
  await writeFile(join(blobDirectory, bodyBlob), comparisonFixture.plainBody, { mode: 0o600 });
  await writeFile(join(blobDirectory, attachmentBlob), comparisonFixture.attachment, { mode: 0o600 });
  const metadataPath = join(configDirectory, "archive-metadata.json");
  await writeFile(metadataPath, '{"format":"agent-mail","version":1}\n', { mode: 0o600 });
  await writeFile(join(journalDirectory, "events.jsonl"), '{"event":"restore-parity"}\n', {
    mode: 0o600,
  });

  const backupPath = join(backupDirectory, "backup-one");
  await writeBackup({
    privateRoot: root,
    databasePath,
    blobDirectory,
    journalDirectory,
    configurationMetadataPaths: [metadataPath],
    referencedBlobDigests: [bodyBlob, attachmentBlob],
    destination: backupPath,
  });
  return {
    root,
    databasePath,
    blobDirectory,
    journalDirectory,
    metadataPath,
    backupPath,
    bodyBlob,
    attachmentBlob,
    messageId,
    identityOnlyMessageId,
    accountId,
    mailboxId,
    uidValidity,
    liveUid,
    tombstonedUid,
    identityOnlyUid,
    opened,
  };
}

async function reopenDatabase(path: string): Promise<OpenDatabase> {
  const reopened = await openDatabase(path);
  runMigrations(reopened, migrations);
  return reopened;
}

function readDomainSnapshot(database: Database, fixture: Fixture): DomainSnapshot {
  // The backup manifest digest and restore staging names are operation metadata;
  // the repository-observable domain facts below remain exact and comparable.
  const canonical = readCanonicalPromotion(database, fixture.messageId);
  const identityOnly = readIdentityOnlyMessage(database, fixture.identityOnlyMessageId);
  const livePlacement = readRemotePlacement(database, {
    accountId: fixture.accountId,
    mailboxId: fixture.mailboxId,
    uidValidity: fixture.uidValidity,
    uid: fixture.liveUid,
  });
  const tombstonedPlacement = readRemotePlacement(database, {
    accountId: fixture.accountId,
    mailboxId: fixture.mailboxId,
    uidValidity: fixture.uidValidity,
    uid: fixture.tombstonedUid,
  });
  if (canonical === undefined || identityOnly === undefined) {
    throw new Error("restore parity fixture is missing a message repository read");
  }
  if (
    livePlacement === undefined ||
    tombstonedPlacement === undefined ||
    tombstonedPlacement.tombstone === null
  ) {
    throw new Error("restore parity fixture is missing placement repository state");
  }
  const tombstoned = {
    identity: tombstonedPlacement.identity,
    messageId: tombstonedPlacement.messageId,
    tombstone: tombstonedPlacement.tombstone,
  };
  const journalFacts = [
    { id: canonical.journal.id, occurredAt: canonical.journal.occurredAt },
    {
      id: tombstoned.tombstone.journalId,
      occurredAt: tombstoned.tombstone.observedAt,
    },
  ];
  journalFacts.sort((left, right) =>
    left.occurredAt === right.occurredAt
      ? left.id.localeCompare(right.id)
      : left.occurredAt.localeCompare(right.occurredAt),
  );
  return {
    canonical,
    identityOnly,
    livePlacement,
    tombstonedPlacement: tombstoned,
    journalOrder: journalFacts.map((event) => event.id),
  };
}

describe("storage restore repository parity P2-C19", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  test("reopens source and restored roots with exact repository parity", async () => {
    const fixture = await createFixture();
    await fixture.opened.close();
    const source = await reopenDatabase(fixture.databasePath);
    const destination = join(fixture.root, "restored");
    const restored = await restoreBackup({ backupPath: fixture.backupPath, destination });
    const destinationDatabase = await reopenDatabase(restored.databasePath);

    const sourceSnapshot = readDomainSnapshot(source.db, fixture);
    const restoredSnapshot = readDomainSnapshot(destinationDatabase.db, fixture);
    expect(sourceSnapshot).toEqual(restoredSnapshot);
    expect(sourceSnapshot.livePlacement.tombstone).toBeNull();
    expect(String(sourceSnapshot.tombstonedPlacement.tombstone.reason)).toBe(
      comparisonFixture.tombstoneReason,
    );
    expect(String(sourceSnapshot.identityOnly.absenceReason)).toBe(
      comparisonFixture.identityOnlyAbsenceReason,
    );
    const routing = sourceSnapshot.canonical.routingDecisions[0];
    expect(routing).toBeDefined();
    if (routing === undefined) throw new Error("restore parity fixture is missing routing provenance");
    expect(routing.decision.provenance).toEqual({
      source: comparisonFixture.routingSource,
      evaluationId: comparisonFixture.routingEvaluationId,
    });
    expect(sourceSnapshot.journalOrder).toEqual([
      comparisonFixture.promotionJournalId,
      sourceSnapshot.tombstonedPlacement.tombstone?.journalId,
    ]);

    await source.close();
    await destinationDatabase.close();
  });

  test("fails parity when restored routing provenance is deleted despite valid SQLite", async () => {
    const fixture = await createFixture();
    await fixture.opened.close();
    const source = await reopenDatabase(fixture.databasePath);
    const destination = join(fixture.root, "restored-negative");
    const restored = await restoreBackup({ backupPath: fixture.backupPath, destination });
    const destinationDatabase = await reopenDatabase(restored.databasePath);
    const expected = readDomainSnapshot(source.db, fixture);

    destinationDatabase.db.exec("DROP TRIGGER routing_decisions_reject_delete;");
    destinationDatabase.db
      .query("DELETE FROM routing_decisions WHERE message_id = ?;")
      .run(fixture.messageId);
    expect(destinationDatabase.db.query("PRAGMA integrity_check;").get()).toEqual({
      integrity_check: "ok",
    });
    expect(destinationDatabase.db.query("PRAGMA foreign_key_check;").all()).toEqual([]);

    const actual = readDomainSnapshot(destinationDatabase.db, fixture);
    expect(actual).not.toEqual(expected);
    expect(actual.canonical.routingDecisions).toEqual([]);
    expect(expected.canonical.routingDecisions.length).toBe(1);

    await source.close();
    await destinationDatabase.close();
  });
});
