import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { renderReport } from "../../contracts/src/report-renderer";
import { applyMigrations } from "../src/migration-runner";
import { canonicalDatabaseMigrations } from "../src/migration-registry";
import {
  ReportCreationRepository,
  REPORT_MAX_ATTEMPTS,
  REPORT_MAX_CHARGED_BYTES,
  REPORT_MAX_COUNT,
  REPORT_WINDOW_MS,
  canonicalJsonBytes,
  canonicalJsonStringBytes,
  createReportIdentity,
  type ReportPublication,
} from "../src/report-creation-repository";

const accountId = "account:icloud-primary";
const principal = "principal:alice";
const messageId = `message:${"a".repeat(64)}`;

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(): { database: Database; repository: ReportCreationRepository } {
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, canonicalDatabaseMigrations);
  database
    .query("INSERT INTO messages (message_id) VALUES (?);")
    .run(messageId);
  database
    .query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
    .run(accountId, "mailbox:inbox", 1);
  database
    .query(
      "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason) VALUES (?, ?, ?, ?, ?, NULL, NULL);",
    )
    .run(accountId, "mailbox:inbox", 1, 1, messageId);
  const rawDigest = "b".repeat(64);
  database
    .query(
      "INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, 'raw-eml', 1, ?, ?);",
    )
    .run(messageId, rawDigest, 10);
  const text = "Durable source evidence";
  const textJson = canonicalJsonStringBytes(text);
  database
    .query(
      "INSERT INTO message_text_projections (message_id, projection_version, normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id, materialized_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      messageId,
      textJson,
      digest(textJson),
      Buffer.byteLength(text, "utf8"),
      rawDigest,
      "mailparser:3.9.15",
      "2026-08-20T00:00:00.000Z",
    );
  return { database, repository: new ReportCreationRepository(database, accountId) };
}

function publication(repository: ReportCreationRepository): ReportPublication {
  const identity = createReportIdentity(
    { title: "Evidence", sourceMessageIds: [messageId], metadata: { alpha: "one" } },
    accountId,
    principal,
  );
  const model = {
    title: identity.title,
    summary: "Evidence report with 1 text-only source.",
    sections: [
      {
        heading: "Source evidence",
        claims: [{ text: "Durable source evidence", citations: [{ id: messageId, label: "Source 1" }] }],
      },
    ],
  };
  const rendered = renderReport(model);
  const modelJson = canonicalJsonBytes(model);
  const sourceTextJson = canonicalJsonStringBytes("Durable source evidence");
  return {
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
    requestBodySha256: "c".repeat(64),
    authorizationAt: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
    sources: [
      {
        messageId,
        text: "Durable source evidence",
        sourceTextJson,
        sourceTextSha256: digest(sourceTextJson),
        sourceTextBytes: Buffer.byteLength("Durable source evidence", "utf8"),
      },
    ],
  };
}

class LogicalBlob extends Uint8Array {
  #reportedBytes: number;

  constructor(reportedBytes: number) {
    super(0);
    this.#reportedBytes = reportedBytes;
  }

  override get byteLength(): number {
    return this.#reportedBytes;
  }

  set reportedBytes(value: number) {
    this.#reportedBytes = value;
  }
}

function capacityHarness(rows: readonly Readonly<Record<string, unknown>>[]) {
  const database = {
    query(sql: string) {
      const selected = sql.includes("FROM reports WHERE") ? rows : [];
      return { iterate: () => selected };
    },
  };
  return new ReportCreationRepository(database as unknown as Database, accountId);
}

function syntheticReportRow(modelJson: LogicalBlob): Readonly<Record<string, unknown>> {
  return {
    report_id: `report:${"a".repeat(64)}`,
    fingerprint_sha256: "a".repeat(64),
    identity_material_json: new Uint8Array(),
    account_id_json: new Uint8Array(),
    owner_principal_json: new Uint8Array(),
    create_scope: "reports:write",
    read_scope: "reports:read",
    authorization_method: "bearer",
    authorization_request_id: `request:${"a".repeat(64)}`,
    authorization_at: "2026-08-20T00:00:00.000Z",
    request_body_sha256: "a".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
    title_json: new Uint8Array(),
    metadata_json: new Uint8Array(),
    source_count: 1,
    model_json: modelJson,
  };
}

describe("report creation repository", () => {
  test("publishes, replays from metadata, and accounts rows incrementally", () => {
    const { database, repository } = fixture();
    const publicationValue = publication(repository);
    expect(repository.admitRate(publicationValue.identity.principalJson, publicationValue.createdAt)).toBe(
      true,
    );
    const first = repository.publish(publicationValue);
    expect(repository.findReplay(publicationValue.identity)).toEqual(first);
    expect(repository.accountCapacity().count).toBe(1);
    expect(repository.accountCapacity().logicalCharge).toBeGreaterThan(0);
    expect(() =>
      database.query("UPDATE reports SET title_json = title_json WHERE report_id = ?;").run(first.reportId),
    ).toThrow();
    expect(() =>
      database.query("INSERT OR REPLACE INTO reports SELECT * FROM reports WHERE report_id = ?;").run(first.reportId),
    ).toThrow();
    database.close();
  });

  test("enforces attempts 10/11, exact 60-second expiry, and retained rate state", () => {
    const { database, repository } = fixture();
    const identity = publication(repository).identity;
    const start = Date.parse("2026-08-20T00:00:00.000Z");
    const instant = (offset: number) => new Date(start + offset).toISOString();
    for (let index = 0; index < REPORT_MAX_ATTEMPTS; index += 1)
      expect(repository.admitRate(identity.principalJson, instant(index * 1_000))).toBe(true);
    expect(repository.admitRate(identity.principalJson, instant(9_000))).toBe(false);
    expect(repository.admitRate(identity.principalJson, instant(REPORT_WINDOW_MS))).toBe(true);
    const row = database
      .query("SELECT attempts_json FROM report_create_rate_windows WHERE principal_json = ?;")
      .get(identity.principalJson) as { attempts_json: Uint8Array };
    expect(JSON.parse(new TextDecoder().decode(row.attempts_json))).toEqual([
      instant(1_000),
      instant(2_000),
      instant(3_000),
      instant(4_000),
      instant(5_000),
      instant(6_000),
      instant(7_000),
      instant(8_000),
      instant(9_000),
      instant(REPORT_WINDOW_MS),
    ]);
    expect(database.query("SELECT COUNT(*) AS count FROM report_create_rate_windows;").get()).toEqual({ count: 1 });
    database.close();
  });

  test("proves inclusive report-count and logical-charge boundaries without unbounded rows", () => {
    const logicalBlob = new LogicalBlob(0);
    const row = syntheticReportRow(logicalBlob);
    const repository = capacityHarness([row]);
    const baseline = repository.accountCapacity().logicalCharge;
    logicalBlob.reportedBytes = REPORT_MAX_CHARGED_BYTES - baseline;
    expect(repository.accountCapacity()).toEqual({ count: 1, logicalCharge: REPORT_MAX_CHARGED_BYTES });
    const firstOverflowBlob = new LogicalBlob(REPORT_MAX_CHARGED_BYTES - baseline - 1);
    const secondOverflowBlob = new LogicalBlob(2);
    expect(() =>
      capacityHarness([
        syntheticReportRow(firstOverflowBlob),
        syntheticReportRow(secondOverflowBlob),
      ]).accountCapacity(),
    ).toThrow("report capacity is exhausted");

    const countRow = syntheticReportRow(new LogicalBlob(0));
    const countRows = Array.from({ length: REPORT_MAX_COUNT }, () => countRow);
    expect(capacityHarness(countRows).accountCapacity().count).toBe(REPORT_MAX_COUNT);
    expect(capacityHarness([...countRows, countRow]).accountCapacity().count).toBe(REPORT_MAX_COUNT + 1);
  });
});
