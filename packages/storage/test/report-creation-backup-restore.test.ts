import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { renderReport } from "../../contracts/src/report-renderer";
import { applyMigrations } from "../src/migration-runner";
import { canonicalDatabaseMigrations } from "../src/migration-registry";
import { openDatabase } from "../src/database";
import { restoreBackup } from "../src/backup-restore";
import { writeBackup } from "../src/backup-writer";
import { installMigrationConversionInfrastructure } from "../src/migration-history-conversion";
import {
  ReportCreationRepository,
  canonicalJsonBytes,
  canonicalJsonStringBytes,
  createReportIdentity,
} from "../src/report-creation-repository";

const accountId = "account:backup-report";
const principal = "principal:backup";
const messageId = `message:${"b".repeat(64)}`;

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createDataBearingReport(database: Database): Promise<Readonly<{ charge: number; attempts: unknown }>> {
  database.query("INSERT INTO messages(message_id) VALUES (?);").run(messageId);
  database
    .query("INSERT INTO mailbox_checkpoints(account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, "mailbox:inbox", 1);
  database
    .query(
      "INSERT INTO remote_placements(account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason) VALUES (?, ?, 1, 1, ?, NULL, NULL);",
    )
    .run(accountId, "mailbox:inbox", messageId);
  const rawDigest = "c".repeat(64);
  database
    .query("INSERT INTO message_blob_references(message_id, kind, ordinal, blob_id, size) VALUES (?, 'raw-eml', 1, ?, 1);")
    .run(messageId, rawDigest);
  const source = "restored report source";
  const sourceJson = canonicalJsonStringBytes(source);
  database
    .query(
      "INSERT INTO message_text_projections(message_id, projection_version, normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id, materialized_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      messageId,
      sourceJson,
      digest(sourceJson),
      Buffer.byteLength(source, "utf8"),
      rawDigest,
      "mailparser:3.9.15",
      "2026-08-20T00:00:00.000Z",
    );
  const repository = new ReportCreationRepository(database, accountId);
  const identity = createReportIdentity(
    { title: "Restored report", sourceMessageIds: [messageId], metadata: { source: "backup" } },
    accountId,
    principal,
  );
  const sourceEvidence = await repository.resolveSourceEvidence(messageId);
  if (sourceEvidence === undefined) throw new Error("report source fixture did not resolve");
  const model = {
    title: identity.title,
    summary: "Evidence report with 1 text-only source.",
    sections: [{ heading: "Source evidence", claims: [{ text: source, citations: [{ id: messageId, label: "Source 1" }] }] }],
  };
  const rendered = renderReport(model);
  const modelJson = canonicalJsonBytes(model);
  const publication = {
    identity,
    model,
    modelJson,
    modelSha256: digest(modelJson),
    markdownSha256: digest(rendered.markdown),
    htmlSha256: digest(rendered.html),
    cspSha256: digest(rendered.contentSecurityPolicy),
    modelBytes: modelJson.byteLength,
    markdownBytes: Buffer.byteLength(rendered.markdown, "utf8"),
    htmlBytes: Buffer.byteLength(rendered.html, "utf8"),
    requestBodySha256: "d".repeat(64),
    authorizationAt: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
    sources: [sourceEvidence],
  };
  expect(repository.admitRate(identity.principalJson, publication.createdAt)).toBe(true);
  repository.publish(publication);
  const rate = database.query("SELECT attempts_json FROM report_create_rate_windows;").get();
  return { charge: repository.accountCapacity().logicalCharge, attempts: rate };
}

describe("report creation backup and restore", () => {
  test("retains data-bearing reports, artifacts, sources, charge, and rate state through empty/full restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-report-backup-"));
    await chmod(root, 0o700);
    try {
      const data = join(root, "data");
      const blobs = join(root, "blobs");
      const journal = join(root, "journal");
      const config = join(root, "config");
      await Promise.all([data, blobs, journal, config].map((path) => mkdir(path, { mode: 0o700 })));
      const databasePath = join(data, "archive.sqlite");
      const database = new Database(databasePath, { strict: true });
      applyMigrations(database, canonicalDatabaseMigrations);
      installMigrationConversionInfrastructure(database);
      const original = await createDataBearingReport(database);
      database.close();

      const reopened = await openDatabase(databasePath);
      expect(new ReportCreationRepository(reopened.db, accountId).accountCapacity().logicalCharge).toBe(original.charge);
      reopened.close();

      const metadataPath = join(config, "archive-metadata.json");
      await writeFile(metadataPath, '{"format":"agent-mail","version":1}\n', { mode: 0o600 });
      const backupPath = join(root, "backup-one");
      await writeBackup({
        privateRoot: root,
        databasePath,
        blobDirectory: blobs,
        journalDirectory: journal,
        configurationMetadataPaths: [metadataPath],
        referencedBlobDigests: [],
        destination: backupPath,
      });
      const restores = await Promise.all([
        restoreBackup({ backupPath, destination: join(root, "restored-empty") }),
        restoreBackup({ backupPath, destination: join(root, "restored-full") }),
      ]);
      for (const restored of restores) {
        const restoredDatabase = await openDatabase(restored.databasePath);
        const restoredRepository = new ReportCreationRepository(restoredDatabase.db, accountId);
        expect(restoredDatabase.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 28 });
        expect(restoredDatabase.db.query("SELECT COUNT(*) AS count FROM reports;").get()).toEqual({ count: 1 });
        expect(restoredDatabase.db.query("SELECT COUNT(*) AS count FROM report_artifacts;").get()).toEqual({ count: 1 });
        expect(restoredDatabase.db.query("SELECT COUNT(*) AS count FROM report_source_snapshots;").get()).toEqual({ count: 1 });
        expect(restoredRepository.accountCapacity().logicalCharge).toBe(original.charge);
        expect(restoredDatabase.db.query("SELECT attempts_json FROM report_create_rate_windows;").get()).toEqual(original.attempts);
        expect(restoredDatabase.db.query("PRAGMA integrity_check;").get()).toEqual({ integrity_check: "ok" });
        await restoredDatabase.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
