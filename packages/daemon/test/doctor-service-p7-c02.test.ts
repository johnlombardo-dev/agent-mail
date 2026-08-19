import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  reportAdminDoctorResponseSchema,
  type ReportAdminDoctorResponse,
} from "@agent-mail/contracts";
import { createCliClient } from "../../cli/src/client";
import { executeCommand, type CommandSink } from "../../cli/src/command-outcome";
import { runDoctorCommand } from "../../cli/src/doctor-command";
import { openDatabase } from "../../storage/src/database";
import type { DoctorIntegrityResult } from "../../storage/src/doctor-integrity";
import {
  createDoctorService,
  doctorResponseFromIntegrity,
} from "../src/doctor-service";
import {
  createHttpApp,
  publicOperationRegistry,
  type HttpCredentialResolution,
  type OperationHandlerContext,
} from "../src/http";
import { createReportAdminHandlers, type ReportAdminServices } from "../src/report-admin-handlers";

const roots: string[] = [];
const servers: Server[] = [];
const instant = "2026-08-19T00:00:00.000Z";
const messageId = `message:${"a".repeat(64)}`;
const rawBytes = Buffer.from("raw message bytes\n");
const bodyBytes = Buffer.from("body bytes\n");
const attachmentBytes = Buffer.from("attachment bytes\n");
type Fixture = Readonly<{
  readonly root: string;
  readonly databasePath: string;
  readonly blobDirectory: string;
  readonly bodyDigest: string;
  readonly attachmentDigest: string;
}>;

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-doctor-api-p7-c02-"));
  roots.push(root);
  await chmod(root, 0o700);
  const blobDirectory = join(root, "blobs");
  await mkdir(blobDirectory, { mode: 0o700 });
  const databasePath = join(root, "archive.sqlite");
  const opened = await openDatabase(databasePath);
  opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  const rawDigest = digest(rawBytes);
  const bodyDigest = digest(bodyBytes);
  const attachmentDigest = digest(attachmentBytes);
  for (const [kind, value, valueDigest] of [
    ["raw-eml", rawBytes, rawDigest],
    ["body-part", bodyBytes, bodyDigest],
    ["attachment", attachmentBytes, attachmentDigest],
  ] as const) {
    opened.db
      .query(
        "INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, ?, 1, ?, ?);",
      )
      .run(messageId, kind, valueDigest, value.byteLength);
    await writeFile(join(blobDirectory, valueDigest), value, { mode: 0o600 });
  }
  // Two independent FK defects must remain visible in the public result.
  opened.db.exec("PRAGMA foreign_keys = OFF;");
  for (const missingMessage of [`message:${"b".repeat(64)}`, `message:${"c".repeat(64)}`])
    opened.db
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, 1, ?, ?);",
      )
      .run("account:fixture", "mailbox:fixture", missingMessage === `message:${"b".repeat(64)}` ? 1 : 2, missingMessage);
  opened.db.close();
  await rm(join(blobDirectory, bodyDigest));
  await writeFile(join(blobDirectory, attachmentDigest), "tampered bytes\n", { mode: 0o600 });
  await chmod(blobDirectory, 0o755);
  return { root, databasePath, blobDirectory, bodyDigest, attachmentDigest };
}

function context(): OperationHandlerContext {
  const operation = publicOperationRegistry.get("admin.doctor");
  if (operation === undefined) throw new Error("missing doctor operation");
  return {
    operation,
    correlationId: "request:doctor-test",
    params: {},
    query: {},
    principal: { subject: "operator:local", scopes: ["admin:doctor"] },
  };
}

function auth(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: { subject: "operator:local", scopes: ["admin:doctor"] },
  };
}

function servicesFor(doctor: ReportAdminServices["doctor"]): ReportAdminServices {
  const unused = () => ({ kind: "blocked" as const, reason: "operation not exercised" });
  return {
    createReport: unused,
    exportSelected: unused,
    backup: unused,
    restore: unused,
    doctor,
    reindex: unused,
  };
}

async function startServer(doctor: ReportAdminServices["doctor"]): Promise<string> {
  const app = createHttpApp({
    authenticate: auth,
    handlers: createReportAdminHandlers(servicesFor(doctor)),
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(", "));
      }
      const request = new Request(`http://${incoming.headers.host ?? "127.0.0.1"}${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers,
        body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
      });
      const response = await app.fetch(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.statusCode = 500;
      outgoing.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("doctor test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function memorySink(output: Uint8Array[]): CommandSink {
  return {
    async write(bytes) {
      output.push(bytes);
      return { kind: "written", bytesAccepted: bytes.byteLength };
    },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7-C02 doctor API and CLI projection", () => {
  test("preserves every real corrupt-store finding through direct API, HTTP, and CLI", async () => {
    const value = await fixture();
    const doctor = createDoctorService({
      integrity: {
        privateRoot: value.root,
        databasePath: value.databasePath,
        blobDirectory: value.blobDirectory,
      },
    });
    const direct = reportAdminDoctorResponseSchema.parse(await doctor({}, context()));
    expect(direct.status).toBe("unhealthy");
    expect(direct.issues.length).toBeGreaterThanOrEqual(5);
    expect(direct.issues.map(({ code }) => code)).toEqual([
      ...direct.issues
        .filter(({ code }) => code.startsWith("doctor:foreign-keys:"))
        .map(({ code }) => code),
      "doctor:blobs:1",
      "doctor:blobs:2",
      "doctor:permissions:1",
    ]);
    const findingDetails: unknown[] = [];
    for (const issue of direct.issues) {
      const detail: unknown = JSON.parse(issue.detail);
      findingDetails.push(detail);
      expect(detail).toMatchObject({
        severity: expect.any(String),
        evidence: { reference: expect.anything(), detail: expect.any(String) },
      });
      expect(issue.detail).not.toContain(value.root);
    }
    expect(findingDetails).toContainEqual(
      expect.objectContaining({ subject: expect.any(String) }),
    );

    const app = createHttpApp({
      authenticate: auth,
      handlers: createReportAdminHandlers(servicesFor(doctor)),
    });
    const httpResponse = await app.request(
      new Request("http://localhost/v1/admin/doctor", {
        method: "POST",
        headers: { authorization: "Bearer doctor-test", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(httpResponse.status).toBe(200);
    const httpBody = reportAdminDoctorResponseSchema.parse(await httpResponse.json());
    expect(httpBody).toEqual(direct);

    const baseUrl = await startServer(doctor);
    const result = await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-test",
      request: {},
      client: createCliClient({ baseUrl, authorization: "Bearer doctor-test" }),
    });
    expect(result).toMatchObject({
      kind: "value",
      operationKey: "admin.doctor",
      semanticKind: "attention",
      data: direct,
    });
    if (result.kind !== "value") throw new Error("unhealthy doctor result was not a value");
    const output: Uint8Array[] = [];
    const receipt = await executeCommand(result, {
      invocationCorrelationId: "cli:doctor-test",
      mode: "human",
      stdout: memorySink(output),
      stderr: memorySink([]),
      rawPolicy: { destination: "pipe", tty: "refuse" },
      signal: new AbortController().signal,
    });
    const human = Buffer.concat(output.map((bytes) => Buffer.from(bytes))).toString("utf8");
    expect(receipt.exitCode).toBe(85);
    for (const issue of direct.issues) expect(human).toContain(issue.code);
    expect(human).not.toContain(value.root);
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(httpBody);
  });

  test("keeps a healthy real store on the normal CLI outcome path", async () => {
    const value = await fixture();
    // Remove the intentionally corrupting fixture defects and restore private modes.
    const database = new Database(value.databasePath, { create: false, readwrite: true });
    database.exec("DELETE FROM remote_placements;");
    database.close();
    await writeFile(join(value.blobDirectory, value.bodyDigest), bodyBytes, { mode: 0o600 });
    await writeFile(join(value.blobDirectory, value.attachmentDigest), attachmentBytes, { mode: 0o600 });
    await chmod(value.blobDirectory, 0o700);
    const doctor = createDoctorService({
      integrity: {
        privateRoot: value.root,
        databasePath: value.databasePath,
        blobDirectory: value.blobDirectory,
      },
    });
    const baseUrl = await startServer(doctor);
    const result = await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-healthy",
      request: {},
      client: createCliClient({ baseUrl, authorization: "Bearer doctor-test" }),
    });
    expect(result).toMatchObject({ kind: "value", semanticKind: "success", data: { status: "healthy", issues: [] } });
  });

  test("compacts hostile maximum evidence without truncating JSON", async () => {
    const value = await fixture();
    const hostile = value.root + "/" + "\"\\".repeat(2_048) + "😀\u0000\u001f";
    const source: DoctorIntegrityResult = {
      status: "unhealthy",
      checks: [
        {
          id: "blobs",
          status: "fail",
          summary: hostile,
          evidence: [
            {
              identity: hostile,
              path: hostile,
              detail: hostile,
            },
          ],
        },
      ],
    };
    const compact = doctorResponseFromIntegrity(value.root, source);
    const issue = compact.issues[0];
    if (issue === undefined) throw new Error("missing hostile doctor finding");
    expect(issue.detail.length).toBeLessThanOrEqual(2_048);
    expect(issue.detail).not.toContain(value.root);
    const parsed: unknown = JSON.parse(issue.detail);
    expect(parsed).toMatchObject({
      severity: "error",
      subject: expect.any(String),
      evidence: {
        reference: expect.any(String),
        detail: expect.any(String),
      },
    });

    const composedDoctor = async () => compact;
    const app = createHttpApp({
      authenticate: auth,
      handlers: createReportAdminHandlers(servicesFor(composedDoctor)),
    });
    const response = await app.request(
      new Request("http://localhost/v1/admin/doctor", {
        method: "POST",
        headers: { authorization: "Bearer doctor-test", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const httpBody = reportAdminDoctorResponseSchema.parse(await response.json());
    expect(httpBody).toEqual(compact);

    const baseUrl = await startServer(composedDoctor);
    const result = await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-hostile",
      request: {},
      client: createCliClient({ baseUrl, authorization: "Bearer doctor-test" }),
    });
    expect(result).toMatchObject({ kind: "value", semanticKind: "attention", data: compact });
  });
});
