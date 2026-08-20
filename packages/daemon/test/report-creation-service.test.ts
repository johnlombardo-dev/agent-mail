import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../storage/src/migration-runner";
import { canonicalDatabaseMigrations } from "../../storage/src/migration-registry";
import {
  ReportCreationRepository,
  canonicalJsonStringBytes,
} from "../../storage/src/report-creation-repository";
import { createReportCreationService } from "../src/report-creation-service";

const accountId = "account:icloud-primary";
const messageId = `message:${"c".repeat(64)}`;
const principal = { subject: "principal:alice", scopes: ["reports:write", "mail:read.message"] };

function setup(): { database: Database; service: ReturnType<typeof createReportCreationService> } {
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, canonicalDatabaseMigrations);
  database.query("INSERT INTO messages(message_id) VALUES (?);").run(messageId);
  database
    .query("INSERT INTO mailbox_checkpoints(account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, "mailbox:inbox", 1);
  database
    .query(
      "INSERT INTO remote_placements(account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason) VALUES (?, ?, 1, 1, ?, NULL, NULL);",
    )
    .run(accountId, "mailbox:inbox", messageId);
  const source = "service source text";
  const sourceJson = canonicalJsonStringBytes(source);
  const rawDigest = "d".repeat(64);
  database
    .query("INSERT INTO message_blob_references(message_id,kind,ordinal,blob_id,size) VALUES (?, 'raw-eml', 1, ?, 1);")
    .run(messageId, rawDigest);
  database
    .query(
      "INSERT INTO message_text_projections(message_id,projection_version,normalized_text_json,normalized_text_sha256,normalized_text_utf8_bytes,raw_eml_sha256,parser_id,materialized_at) VALUES (?,1,?,?,?,?,?,?);",
    )
    .run(
      messageId,
      sourceJson,
      createHash("sha256").update(sourceJson).digest("hex"),
      Buffer.byteLength(source, "utf8"),
      rawDigest,
      "mailparser:3.9.15",
      "2026-08-20T00:00:00.000Z",
    );
  const repository = new ReportCreationRepository(database, accountId);
  return {
    database,
    service: createReportCreationService({
      repository,
      accountId,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    }),
  };
}

describe("report creation service", () => {
  test("creates once and exact-replays with reports:write alone", async () => {
    const { database, service } = setup();
    const request = { title: "Service report", sourceMessageIds: [messageId], metadata: {} };
    const first = await service(request, {
      correlationId: "request:service",
      operationKey: "reports.create",
      scope: "reports:write",
      principal,
      scopes: principal.scopes,
      requestBodySha256: "e".repeat(64),
    });
    const beforeReplay = database.query("SELECT attempts_json, last_observed_at FROM report_create_rate_windows;").get();
    const replay = await service(request, {
      correlationId: "request:replay",
      operationKey: "reports.create",
      scope: "reports:write",
      principal: { subject: principal.subject, scopes: ["reports:write"] },
      scopes: ["reports:write"],
      requestBodySha256: "f".repeat(64),
    });
    expect(replay).toEqual(first);
    expect(database.query("SELECT attempts_json, last_observed_at FROM report_create_rate_windows;").get()).toEqual(beforeReplay);
    expect(database.query("SELECT count(*) AS count FROM reports;").get()).toEqual({ count: 1 });
    database.close();
  });

  test("single-flights concurrent identical creates into one committed graph", async () => {
    const { database, service } = setup();
    const request = { title: "Concurrent report", sourceMessageIds: [messageId], metadata: {} };
    const context = (requestId: string) => ({
      correlationId: requestId,
      operationKey: "reports.create",
      scope: "reports:write",
      principal,
      scopes: principal.scopes,
      requestBodySha256: "a".repeat(64),
    });
    const [first, second] = await Promise.all([
      service(request, context("request:concurrent-a")),
      service(request, context("request:concurrent-b")),
    ]);
    expect(second).toEqual(first);
    expect(database.query("SELECT COUNT(*) AS count FROM reports;").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM report_artifacts;").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM report_sources;").get()).toEqual({ count: 1 });
    expect(database.query("SELECT attempts_json FROM report_create_rate_windows;").get()).not.toBeNull();
    database.close();
  });
});
