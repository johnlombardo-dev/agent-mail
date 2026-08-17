import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createLocalLabel,
  createMailboxId,
  createRemoteUid,
  createRouteDecision,
  createRoutingRuleId,
  createUtcInstant,
} from "@agent-mail/core";
import type { RawMessageDownloadRequest, RawMessageDownloadResult } from "../../imap/src/raw-download";
import { stageBlob } from "../../storage/src/blob-stage";
import { applyMigrations } from "../../storage/src/migration-runner";
import { openDatabase } from "../../storage/src/database";
import { createSqlitePromotionAdapter } from "../../storage/src/promotion-adapter";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import { structuredContentMigration } from "../../storage/src/migrations/0002-structured-content";
import { localLabelMigration } from "../../storage/src/local-label-migration";
import { routingDecisionMigration } from "../../storage/src/routing-decision-migration";
import { messageBlobReferencesMigration } from "../../storage/src/migrations/0003-message-blob-references";
import { ingestSingleMessage, type RawMessageDownloadQueuePort } from "../src/single-message-ingestion";

const roots: string[] = [];
const accountId = createAccountId("account:ingestion");
const mailboxId = createMailboxId("mailbox:inbox");
const identity = createRemoteUid({ accountId, mailboxId, uidValidity: 7, uid: 11 });
const migrations = [
  { ...messageCatalogMigration, version: 1 },
  { ...structuredContentMigration, version: 2 },
  { ...operationalJournalMigration, version: 3 },
  { ...localLabelMigration, version: 4 },
  { ...routingDecisionMigration, version: 5 },
  { ...messageBlobReferencesMigration, version: 6 },
] as const;

const rawMessage = [
  "From: Ada <ada@example.test>",
  "To: Team <team@example.test>",
  "Subject: composed ingestion",
  "Content-Type: multipart/mixed; boundary=outer",
  "",
  "--outer",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "hello body",
  "--outer",
  "Content-Type: application/octet-stream",
  "Content-Disposition: attachment; filename=note.txt",
  "Content-Transfer-Encoding: base64",
  "",
  "bm90ZSBieXRlcw==",
  "--outer--",
  "",
].join("\r\n");

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-ingestion-p3-c08-"));
  roots.push(root);
  const stagingDirectory = join(root, "staging");
  const canonicalDirectory = join(root, "blobs");
  await mkdir(stagingDirectory, { mode: 0o700 });
  await mkdir(canonicalDirectory, { mode: 0o700 });
  const raw = await stageBlob({
    stagingDirectory,
    owner: { pid: process.pid, processStartIdentity: "ingestion-test" },
    source: (async function* () {
      yield new TextEncoder().encode(rawMessage);
    })(),
  });
  const opened = await openDatabase(join(root, "archive.sqlite"));
  applyMigrations(opened, migrations);
  opened.db
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, 7);
  return { ...opened, root, stagingDirectory, canonicalDirectory, raw };
}

function queueFor(raw: RawMessageDownloadResult): RawMessageDownloadQueuePort {
  let calls = 0;
  return {
    async download(request: RawMessageDownloadRequest): Promise<RawMessageDownloadResult> {
      calls += 1;
      expect(calls).toBe(1);
      expect(request.accountId).toBe(accountId);
      return raw;
    },
  };
}

function routing() {
  return () => [
    {
      decisionId: "caller-routing-id",
      decision: createRouteDecision({
        kind: "route",
        ruleId: createRoutingRuleId("rule:ingestion"),
        ruleVersion: 1,
        matchedFacts: [{ field: "sender", value: "ada@example.test" }],
        decidedAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
        provenance: { source: "ingestion-test", evaluationId: "evaluation:one" },
        label: createLocalLabel("label:inbox"),
      }),
    },
  ];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("single-message parser-to-storage ingestion P3-C08", () => {
  test("commits exact parsed state and authoritative blob sizes through real SQLite", async () => {
    const fixture = await setup();
    const result = await ingestSingleMessage(
      {
        accountId,
        mailboxId,
        uidValidity: identity.uidValidity,
        uid: identity.uid,
        stagingDirectory: fixture.stagingDirectory,
        owner: { pid: process.pid, processStartIdentity: "queue-owner" },
      },
      {
        queue: queueFor({ identity, staged: fixture.raw }),
        promotion: createSqlitePromotionAdapter(fixture.db),
        stagingDirectory: fixture.stagingDirectory,
        canonicalDirectory: fixture.canonicalDirectory,
        owner: { pid: process.pid, processStartIdentity: "part-owner" },
        routing: routing(),
        occurredAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
        journal: ({ messageId }) => ({
          id: "event:ingestion:one",
          occurredAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
          category: "sync",
          subjectId: messageId,
          correlationId: "sync:ingestion:one",
          payloadVersion: 1,
          payloadJson: '{"status":"promoted"}',
        }),
      },
    );
    expect(result.status).toBe("committed");
    expect(
      fixture.db.query("SELECT kind, ordinal, size FROM message_blob_references ORDER BY kind, ordinal;").all(),
    ).toEqual([
      { kind: "attachment", ordinal: 1, size: 10 },
      { kind: "body-part", ordinal: 1, size: 10 },
      { kind: "raw-eml", ordinal: 1, size: Buffer.byteLength(rawMessage) },
    ]);
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 1 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({ count: 1 });
    await fixture.close();
  });

  test("routing-write failure leaves no durable rows while published blobs may remain", async () => {
    const fixture = await setup();
    const promotion = createSqlitePromotionAdapter(fixture.db, {
      beforeWrite: (boundary) => {
        if (boundary === "routing-decision") throw new Error("injected routing write");
      },
    });
    await expect(
      ingestSingleMessage(
        {
          accountId,
          mailboxId,
          uidValidity: identity.uidValidity,
          uid: identity.uid,
          stagingDirectory: fixture.stagingDirectory,
          owner: { pid: process.pid, processStartIdentity: "queue-owner" },
        },
        {
          queue: queueFor({ identity, staged: fixture.raw }),
          promotion,
          stagingDirectory: fixture.stagingDirectory,
          canonicalDirectory: fixture.canonicalDirectory,
          owner: { pid: process.pid, processStartIdentity: "part-owner" },
          routing: routing(),
          occurredAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
          journal: ({ messageId }) => ({
            id: "event:ingestion:failure",
            occurredAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
            category: "sync",
            subjectId: messageId,
            correlationId: "sync:ingestion:failure",
            payloadVersion: 1,
            payloadJson: '{"status":"promoted"}',
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "promotion-failed" });
    for (const table of [
      "messages",
      "remote_placements",
      "message_blob_references",
      "routing_decisions",
      "operational_journal",
    ]) {
      expect(fixture.db.query(`SELECT COUNT(*) AS count FROM ${table};`).get()).toEqual({ count: 0 });
    }
    await fixture.close();
  });
});
