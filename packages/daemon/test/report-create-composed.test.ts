import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createRemoteUid,
  createUtcInstant,
} from "@agent-mail/core";
import type { MetadataBatchItem } from "../../imap/src/metadata-batch";
import type { RawMessageDownloadResult } from "../../imap/src/raw-download";
import { stageBlob } from "../../storage/src/blob-stage";
import { applyMigrations } from "../../storage/src/migration-runner";
import { canonicalDatabaseMigrations } from "../../storage/src/migration-registry";
import {
  ReportCreationRepository,
} from "../../storage/src/report-creation-repository";
import { createSqlitePromotionAdapter } from "../../storage/src/promotion-adapter";
import { createHttpApp } from "../src/http";
import { createReportAdminHandlers, type ReportAdminServices } from "../src/report-admin-handlers";
import { createReportCreationService } from "../src/report-creation-service";
import { ingestSingleMessage } from "../src/single-message-ingestion";

const accountId = createAccountId("account:composed");
const mailboxId = createMailboxId("mailbox:inbox");
const identity = createRemoteUid({ accountId, mailboxId, uidValidity: 7, uid: 11 });
const rawMessage = [
  "From: Ada <ada@example.test>",
  "To: Team <team@example.test>",
  "Subject: staged composed evidence",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "staged source evidence",
  "",
].join("\r\n");

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-report-composed-"));
  roots.push(root);
  const stagingDirectory = join(root, "staging");
  const canonicalDirectory = join(root, "blobs");
  await mkdir(stagingDirectory, { mode: 0o700 });
  await mkdir(canonicalDirectory, { mode: 0o700 });
  const staged = await stageBlob({
    stagingDirectory,
    owner: { pid: process.pid, processStartIdentity: "report-composed-stage" },
    source: (async function* () {
      yield new TextEncoder().encode(rawMessage);
    })(),
  });
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, canonicalDatabaseMigrations);
  database
    .query("INSERT INTO mailbox_checkpoints(account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, mailboxId, identity.uidValidity);
  const metadata: MetadataBatchItem = {
    identity,
    flags: [],
    modseq: { kind: "unknown" },
    envelope: {},
    size: Buffer.byteLength(rawMessage),
    internalDate: createUtcInstant("2026-08-20T00:00:00.000Z"),
  };
  const download: RawMessageDownloadResult = { identity, staged };
  const ingestion = await ingestSingleMessage(
    {
      request: {
        accountId,
        mailboxId,
        uidValidity: identity.uidValidity,
        uid: identity.uid,
        stagingDirectory,
        owner: { pid: process.pid, processStartIdentity: "report-composed-queue" },
      },
      metadata,
    },
    {
      queue: { download: async () => download },
      promotion: createSqlitePromotionAdapter(database),
      stagingDirectory,
      canonicalDirectory,
      owner: { pid: process.pid, processStartIdentity: "report-composed-promotion" },
      routing: () => [],
      occurredAt: metadata.internalDate,
      journal: ({ messageId }) => ({
        id: "event:report-composed-ingestion",
        occurredAt: metadata.internalDate,
        category: "sync",
        subjectId: messageId,
        correlationId: "sync:report-composed",
        payloadVersion: 1,
        payloadJson: '{"status":"promoted"}',
      }),
    },
  );
  if (ingestion.status !== "committed") throw new Error("staged composed ingestion did not commit");
  const repository = new ReportCreationRepository(database, accountId);
  const createReport = createReportCreationService({
    repository,
    accountId,
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
  const unused = () => {
    throw new Error("unused report admin operation");
  };
  const adminServices: ReportAdminServices = {
    createReport,
    exportSelected: unused,
    backup: unused,
    restore: unused,
    doctor: unused,
    reindex: unused,
  };
  return { database, handlers: createReportAdminHandlers(adminServices), messageId: ingestion.messageId };
}

describe("composed reports.create", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("executes staged EML through parser, ingestion, promotion, HTTP, service, SQLite, and artifact publication", async () => {
    const value = await setup();
    try {
      const app = createHttpApp({
        authenticate: (credential) => ({
          kind: "authenticated" as const,
          principal: {
            subject: "principal:composed",
            scopes: credential === "replay" ? ["reports:write"] : ["reports:write", "mail:read.message"],
          },
        }),
        handlers: value.handlers,
      });
      const request = JSON.stringify({
        title: "Composed staged report",
        sourceMessageIds: [value.messageId],
        metadata: {},
      });
      const first = await app.request("http://localhost/v1/reports", {
        method: "POST",
        headers: { authorization: "Bearer first", "content-type": "application/json" },
        body: request,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const replay = await app.request("http://localhost/v1/reports", {
        method: "POST",
        headers: { authorization: "Bearer replay", "content-type": "application/json" },
        body: request,
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(firstBody);
      expect(value.database.query("SELECT count(*) AS count FROM messages;").get()).toEqual({ count: 1 });
      expect(value.database.query("SELECT count(*) AS count FROM message_text_projections;").get()).toEqual({ count: 1 });
      expect(value.database.query("SELECT count(*) AS count FROM reports;").get()).toEqual({ count: 1 });
      expect(value.database.query("SELECT count(*) AS count FROM report_artifacts;").get()).toEqual({ count: 1 });
      expect(value.database.query("SELECT count(*) AS count FROM report_source_snapshots;").get()).toEqual({ count: 1 });
      expect(value.database.query("SELECT normalized_text_json FROM message_text_projections;").get()).toEqual({
        normalized_text_json: new Uint8Array(Buffer.from(JSON.stringify("staged source evidence\n"), "utf8")),
      });
      expect(value.database.query("SELECT model_json FROM report_artifacts;").get()).not.toBeNull();
    } finally {
      value.database.close();
    }
  });
});
