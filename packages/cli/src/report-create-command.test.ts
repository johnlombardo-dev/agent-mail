import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  reportAdminReportOperation,
  type ReportAdminReportResponse,
} from "@agent-mail/contracts";
import { applyMigrations } from "../../storage/src/migration-runner";
import { canonicalDatabaseMigrations } from "../../storage/src/migration-registry";
import {
  ReportCreationRepository,
  canonicalJsonStringBytes,
} from "../../storage/src/report-creation-repository";
import { createHttpApp } from "../../daemon/src/http";
import { createReportAdminHandlers, type ReportAdminServices } from "../../daemon/src/report-admin-handlers";
import { createReportCreationService } from "../../daemon/src/report-creation-service";
import { runReportCreateCommand } from "./report-create-command";
import { createCliClient, type CliResponse } from "./client";

const request = {
  title: "Inbox evidence",
  sourceMessageIds: ["message:" + "a".repeat(64)],
  metadata: { purpose: "review" },
};

const responseData: ReportAdminReportResponse = {
  reportId: "report:" + "b".repeat(64),
  title: request.title,
  citations: [{ id: request.sourceMessageIds[0], label: "Source 1" }],
  authorization: {
    principal: "principal:alice",
    scope: "reports:write",
    method: "local-cli",
    requestId: "request:" + "c".repeat(64),
    authorizedAt: "2026-08-20T00:00:00.000Z",
  },
  createdAt: "2026-08-20T00:00:00.000Z",
};

const loopbackTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test;

describe("reports create CLI command", () => {
  test("uses the registered client operation and returns trusted/untrusted human segments", async () => {
    let receivedOperation: string | undefined;
    const result = await runReportCreateCommand({
      argv: ["reports", "create"],
      request,
      correlationId: "request:" + "d".repeat(64),
      client: {
        request: async ({ operation }): Promise<CliResponse> => {
          receivedOperation = operation.key;
          return { kind: "success", operationKey: reportAdminReportOperation.key, status: 200, data: responseData };
        },
      },
    });

    expect(receivedOperation).toBe(reportAdminReportOperation.key);
    expect(result.kind).toBe("value");
    if (result.kind !== "value") throw new Error("expected a value result");
    expect(result.data).toEqual(responseData);
    expect(result.humanLines[0].map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "trusted-chrome", text: "report id: " },
      { kind: "untrusted-value", text: responseData.reportId },
    ]);
  });

  test("rejects an unrecognized command path before making a request", async () => {
    let calls = 0;
    const result = await runReportCreateCommand({
      argv: ["reports", "show"],
      request,
      correlationId: "request:" + "e".repeat(64),
      client: { request: async () => { calls += 1; return { kind: "success" } as CliResponse; } },
    });

    expect(calls).toBe(0);
    expect(result.kind).toBe("failure");
    if (result.kind !== "failure") throw new Error("expected a failure result");
    expect(result.semanticKind).toBe("usage");
  });

  loopbackTest("runs CLI through a real loopback HTTP server into SQLite report and artifact publication", async () => {
    const database = new Database(":memory:", { strict: true });
    applyMigrations(database, canonicalDatabaseMigrations);
    const messageId = request.sourceMessageIds[0]!;
    const rawDigest = "d".repeat(64);
    const source = "loopback source evidence";
    const sourceJson = canonicalJsonStringBytes(source);
    database.query("INSERT INTO messages(message_id) VALUES (?);").run(messageId);
    database
      .query("INSERT INTO mailbox_checkpoints(account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);")
      .run("account:icloud-primary", "mailbox:inbox", 1);
    database
      .query(
        "INSERT INTO remote_placements(account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason) VALUES (?, ?, 1, 1, ?, NULL, NULL);",
      )
      .run("account:icloud-primary", "mailbox:inbox", messageId);
    database
      .query("INSERT INTO message_blob_references(message_id, kind, ordinal, blob_id, size) VALUES (?, 'raw-eml', 1, ?, 1);")
      .run(messageId, rawDigest);
    database
      .query(
        "INSERT INTO message_text_projections(message_id, projection_version, normalized_text_json, normalized_text_sha256, normalized_text_utf8_bytes, raw_eml_sha256, parser_id, materialized_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?);",
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
    const repository = new ReportCreationRepository(database, "account:icloud-primary");
    const createReport = createReportCreationService({
      repository,
      accountId: "account:icloud-primary",
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const unused = () => {
      throw new Error("unused report admin operation");
    };
    const services: ReportAdminServices = {
      createReport,
      exportSelected: unused,
      backup: unused,
      restore: unused,
      doctor: unused,
      reindex: unused,
    };
    const app = createHttpApp({
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "principal:alice", scopes: ["reports:write", "mail:read.message"] },
      }),
      handlers: createReportAdminHandlers(services),
    });
    const server: Server = createServer((incoming: IncomingMessage, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        void (async () => {
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (typeof value === "string") headers.set(name, value);
              else if (Array.isArray(value)) headers.set(name, value.join(", "));
            }
            const response = await app.fetch(
              new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
                method: incoming.method ?? "POST",
                headers,
                body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
                duplex: "half",
              }),
            );
            outgoing.statusCode = response.status;
            response.headers.forEach((value, name) => outgoing.setHeader(name, value));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
          } catch {
            outgoing.statusCode = 500;
            outgoing.end();
          }
        })();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(6119, "127.0.0.1", resolve);
      });
      const result = await runReportCreateCommand({
        argv: ["reports", "create"],
        request,
        correlationId: "request:loopback",
        client: createCliClient({
          baseUrl: "http://127.0.0.1:6119",
          authorization: "Bearer loopback",
        }),
      });
      expect(result.kind).toBe("value");
      expect(database.query("SELECT COUNT(*) AS count FROM reports;").get()).toEqual({ count: 1 });
      expect(database.query("SELECT COUNT(*) AS count FROM report_artifacts;").get()).toEqual({ count: 1 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    }
  });
});
