import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  reportAdminBackupOperation,
  reportAdminBackupResponseSchema,
  reportAdminDoctorOperation,
  reportAdminDoctorResponseSchema,
  reportAdminReindexOperation,
  reportAdminReindexResponseSchema,
  reportAdminRestoreOperation,
  reportAdminRestoreResponseSchema,
  type ReportAdminBackupResponse,
  type ReportAdminDoctorResponse,
  type ReportAdminReindexResponse,
  type ReportAdminRestoreRequest,
  type ReportAdminRestoreResponse,
} from "@agent-mail/contracts";
import { createCliClient } from "../../cli/src/client";
import { executeCommand, type CommandResultV1, type CommandSink } from "../../cli/src/command-outcome";
import { runBackupCommand } from "../../cli/src/backup-command";
import { runDoctorCommand } from "../../cli/src/doctor-command";
import { runReindexCommand } from "../../cli/src/reindex-command";
import { runRestoreCommand } from "../../cli/src/restore-command";
import { derivePrivatePaths } from "../src/config";
import { createBackupService } from "../src/backup-service";
import { createDoctorService } from "../src/doctor-service";
import {
  createHttpApp,
  publicOperationRegistry,
  type HttpCredentialResolution,
  type OperationHandlerContext,
} from "../src/http";
import { createReportAdminHandlers, type ReportAdminServices } from "../src/report-admin-handlers";
import { openDatabase } from "../../storage/src/database";
import { runMigrations, type Migration } from "../../storage/src/migration-runner";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
import { messageBlobReferencesMigration } from "../../storage/src/migrations/0003-message-blob-references";
import { externalContentSearchMigration } from "../../storage/src/migrations/0003-external-content-search";
import { structuredContentMigration } from "../../storage/src/migrations/0002-structured-content";
import { rebuildSearchIndex, SearchReindexError } from "../../storage/src/search-reindex";
import { replaceOfflinePrivateRoot, OfflineRootReplacementError } from "../../storage/src/offline-root-replacement";
import parityMatrix from "./fixtures/admin-parity-issue-164.json" with { type: "json" };

const instant = "2026-08-19T00:00:00.000Z";
const nonce = "restore-confirmation-issue-164";
const roots: string[] = [];
const servers: Server[] = [];
const databases: Database[] = [];

type Layer = "direct" | "rest" | "cli";
type AdminOperation =
  | typeof reportAdminDoctorOperation
  | typeof reportAdminReindexOperation
  | typeof reportAdminBackupOperation
  | typeof reportAdminRestoreOperation;

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operation(key: AdminOperation["key"]): AdminOperation {
  const value = publicOperationRegistry.get(key);
  if (value === undefined) throw new Error(`missing operation ${key}`);
  return value as AdminOperation;
}

function auth(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: {
      subject: "operator:local",
      scopes: ["admin:doctor", "admin:reindex", "admin:backup", "admin:restore"],
    },
  };
}

function contextFor(value: AdminOperation): OperationHandlerContext {
  return {
    operation: value,
    correlationId: `request:${value.key}`,
    params: {},
    query: {},
    principal: { subject: "operator:local", scopes: [value.scope] },
  };
}

function unused() {
  return { kind: "blocked" as const, reason: "operation not exercised" };
}

function servicesFor(
  services: Partial<Pick<ReportAdminServices, "doctor" | "reindex" | "backup" | "restore">>,
): ReportAdminServices {
  return {
    createReport: unused,
    exportSelected: unused,
    doctor: services.doctor ?? unused,
    reindex: services.reindex ?? unused,
    backup: services.backup ?? unused,
    restore: services.restore ?? unused,
  };
}

async function startServer(services: ReportAdminServices): Promise<string> {
  const app = createHttpApp({ authenticate: auth, handlers: createReportAdminHandlers(services) });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
  if (address === null || typeof address === "string") throw new Error("parity server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function sink(chunks: Uint8Array[]): CommandSink {
  return {
    async write(value) {
      chunks.push(value);
      return { kind: "written", bytesAccepted: value.byteLength };
    },
  };
}

async function receipt(result: CommandResultV1): Promise<{ result: CommandResultV1; exitCode: number; stdout: string; stderr: string }> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const completed = await executeCommand(result, {
    invocationCorrelationId: "cli:admin-parity-issue-164",
    mode: "human",
    stdout: sink(stdout),
    stderr: sink(stderr),
    rawPolicy: { destination: "pipe", tty: "refuse" },
    signal: new AbortController().signal,
  });
  return {
    result,
    exitCode: completed.exitCode,
    stdout: Buffer.concat(stdout.map((value) => Buffer.from(value))).toString("utf8"),
    stderr: Buffer.concat(stderr.map((value) => Buffer.from(value))).toString("utf8"),
  };
}

async function makeDoctorRoot(corrupt: boolean): Promise<Readonly<{ root: string; databasePath: string; blobDirectory: string }>> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-admin-parity-164-doctor-"));
  roots.push(root);
  await chmod(root, 0o700);
  const blobDirectory = join(root, "blobs");
  await mkdir(blobDirectory, { mode: 0o700 });
  const databasePath = join(root, "archive.sqlite");
  const definitions = [messageCatalogMigration, messageBlobReferencesMigration];
  const migrations: readonly Migration[] = definitions.map((migration, index) => ({ ...migration, version: index + 1 }));
  const opened = await openDatabase(databasePath);
  runMigrations(opened.db, migrations);
  if (corrupt) {
    const messageId = `message:${"a".repeat(64)}`;
    const missingBlob = "b".repeat(64);
    opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    opened.db.query(
      "INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, 'raw-eml', 1, ?, 10);",
    ).run(messageId, missingBlob);
    await chmod(blobDirectory, 0o755);
  }
  await opened.close();
  return { root, databasePath, blobDirectory };
}

function doctorService(value: Awaited<ReturnType<typeof makeDoctorRoot>>) {
  const definitions = [messageCatalogMigration, messageBlobReferencesMigration];
  const migrations: readonly Migration[] = definitions.map((migration, index) => ({ ...migration, version: index + 1 }));
  return createDoctorService({
    integrity: { privateRoot: value.root, databasePath: value.databasePath, blobDirectory: value.blobDirectory, migrations },
  });
}

async function makeBackupRoot(): Promise<Readonly<{ root: string; backupPath: string; metadataPath: string; databasePath: string }>> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-admin-parity-164-backup-"));
  roots.push(root);
  const paths = derivePrivatePaths(root);
  const metadataDir = join(root, "config");
  await Promise.all(
    [paths.data, paths.blob, paths.journal, paths.backup, paths.runtime, metadataDir].map((path) => mkdir(path, { mode: 0o700 })),
  );
  const databasePath = join(paths.data, "archive.sqlite");
  const database = new Database(databasePath);
  databases.push(database);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('parity');");
  await chmod(databasePath, 0o600);
  await chmod(`${databasePath}-wal`, 0o600);
  await chmod(`${databasePath}-shm`, 0o600);
  const blobBytes = Buffer.from("canonical raw bytes\n");
  await writeFile(join(paths.blob, digest(blobBytes)), blobBytes, { mode: 0o600 });
  await writeFile(join(paths.journal, "events.jsonl"), "{\"kind\":\"parity\"}\n", { mode: 0o600 });
  const metadataPath = join(metadataDir, "archive-metadata.json");
  await writeFile(metadataPath, "{\"format\":\"agent-mail\",\"fixture\":\"164\"}\n", { mode: 0o600 });
  return { root, backupPath: join(paths.backup, "parity"), metadataPath, databasePath };
}

function backupService(value: Awaited<ReturnType<typeof makeBackupRoot>>, beforePublish?: () => void) {
  const paths = derivePrivatePaths(value.root);
  return createBackupService({
    configuration: { privateRoot: value.root, paths },
    databasePath: value.databasePath,
    configurationMetadataPaths: [value.metadataPath],
    referencedBlobDigests: [digest("canonical raw bytes\n")],
    now: () => new Date(instant),
    beforePublish,
  });
}

function reindexDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  runMigrations(database, [messageCatalogMigration, structuredContentMigration, externalContentSearchMigration]);
  const first = `message:${"a".repeat(64)}`;
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(first);
  database.query("INSERT INTO message_search_documents (document_id, message_id) VALUES (10, ?);").run(first);
  database.query(
    "INSERT INTO message_headers (message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, 1, 'Subject', 'subject', 'parity subject', 'parity subject');",
  ).run(first);
  database.query(
    "INSERT INTO message_body_parts (message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text) VALUES (?, 1, 'text/plain', 'text/plain', ?, 'parity body');",
  ).run(first, "c".repeat(64));
  database.query(
    "INSERT INTO message_fts(rowid, subject, participants, body_plain, body_html, attachment_names) SELECT rowid, subject, participants, body_plain, body_html, attachment_names FROM indexed_messages WHERE rowid = 10;",
  ).run();
  return database;
}

function reindexService(database: Database, fail = false) {
  return () => {
    if (fail) return { kind: "failure" as const, reason: "reindex service failed" };
    try {
      const result = rebuildSearchIndex(database, { representativeQueries: [{ query: "parity", expectedRowids: [10] }] });
      const response: ReportAdminReindexResponse = {
        accepted: true,
        scope: "all",
        startedAt: instant,
        indexed: result.replacementRowCount,
        expected: result.sourceRowCount,
      };
      return response;
    } catch (error: unknown) {
      if (error instanceof SearchReindexError) return { kind: "failure" as const, reason: error.message };
      throw error;
    }
  };
}

async function restoreService(
  backupPath: string,
  request: ReportAdminRestoreRequest,
  fail = false,
): Promise<ReportAdminRestoreResponse | Readonly<{ kind: "failure"; reason: string }>> {
  if (fail) return { kind: "failure", reason: "restore service failed" };
  try {
    const result = await replaceOfflinePrivateRoot({
      request: { target: request.target, manifest: request.manifest, confirmationNonce: request.confirmationNonce, offline: true },
      backupPath,
      offlineToken: request.confirmationNonce,
      validateOfflineToken: async (token, expected) => ({
        kind: "offline-supervisor" as const,
        target: expected.target,
        confirmationNonce: expected.confirmationNonce,
        validatedAt: instant,
      }),
      verifyRepository: async () => undefined,
    });
    return { restored: true, target: request.target, manifest: request.manifest, completedAt: instant };
  } catch (error: unknown) {
    if (error instanceof OfflineRootReplacementError) return { kind: "failure", reason: error.message };
    throw error;
  }
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close(false);
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("#164 administrative direct/REST/CLI parity", () => {
  test("retains a complete matrix with no omitted direct, REST, or CLI cell", () => {
    expect(parityMatrix.layers).toEqual(["direct", "rest", "cli"]);
    expect(parityMatrix.operations).toEqual(["admin.doctor", "admin.reindex", "admin.backup", "admin.restore"]);
    expect(parityMatrix.rows.length).toBeGreaterThan(0);
    for (const row of parityMatrix.rows) {
      expect(parityMatrix.operations).toContain(row.operation);
      expect(row.cells).toEqual({ direct: true, rest: true, cli: true });
      expect(row.exitCode).toEqual(expect.any(Number));
    }
    expect(parityMatrix.negativeFixtures).toEqual([
      { id: "dropped-doctor-finding", kind: "doctor", mustFail: "finding-set-parity" },
      { id: "changed-backup-digest", kind: "backup", mustFail: "manifest-digest-parity" },
    ]);
  });

  test("preserves every doctor finding and exit through direct service, Hono, and real CLI", async () => {
    const corrupt = await makeDoctorRoot(true);
    const service = doctorService(corrupt);
    const direct = reportAdminDoctorResponseSchema.parse(await service({}, contextFor(operation("admin.doctor"))));
    expect(direct.status).toBe("unhealthy");
    expect(direct.issues.length).toBeGreaterThan(0);
    const app = createHttpApp({ authenticate: auth, handlers: createReportAdminHandlers(servicesFor({ doctor: service })) });
    const restResponse = await app.request(new Request("http://localhost/v1/admin/doctor", {
      method: "POST",
      headers: { authorization: "Bearer parity", "content-type": "application/json" },
      body: "{}",
    }));
    const rest = reportAdminDoctorResponseSchema.parse(await restResponse.json());
    expect(rest).toEqual(direct);
    const baseUrl = await startServer(servicesFor({ doctor: service }));
    const cliResult = await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-164",
      request: {},
      client: createCliClient({ baseUrl, authorization: "Bearer parity" }),
    });
    const cli = await receipt(cliResult);
    expect(cliResult).toMatchObject({ kind: "value", semanticKind: "attention", data: direct });
    expect(cli.exitCode).toBe(85);
    for (const issue of direct.issues) expect(cli.stdout).toContain(issue.code);
    expect(cli.stdout).not.toContain(corrupt.root);

    const dropped = { ...rest, issues: rest.issues.slice(1) };
    expect(dropped).not.toEqual(direct);
    expect(dropped.issues).not.toEqual(direct.issues);
  });

  test("runs healthy and service-failure doctor rows through all three layers", async () => {
    const healthyRoot = await makeDoctorRoot(false);
    const healthyService = doctorService(healthyRoot);
    const healthyDirect = reportAdminDoctorResponseSchema.parse(
      await healthyService({}, contextFor(operation("admin.doctor"))),
    );
    expect(healthyDirect).toMatchObject({ status: "healthy", issues: [] });
    const healthyApp = createHttpApp({
      authenticate: auth,
      handlers: createReportAdminHandlers(servicesFor({ doctor: healthyService })),
    });
    const healthyRest = reportAdminDoctorResponseSchema.parse(
      await (await healthyApp.request(new Request("http://localhost/v1/admin/doctor", {
        method: "POST",
        headers: { authorization: "Bearer parity", "content-type": "application/json" },
        body: "{}",
      }))).json(),
    );
    expect(healthyRest).toEqual(healthyDirect);
    const healthyBaseUrl = await startServer(servicesFor({ doctor: healthyService }));
    const healthyCli = await receipt(await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-healthy-164",
      request: {},
      client: createCliClient({ baseUrl: healthyBaseUrl, authorization: "Bearer parity" }),
    }));
    expect(healthyCli.result).toMatchObject({ kind: "value", semanticKind: "success", data: healthyDirect });
    expect(healthyCli.exitCode).toBe(0);

    const failureService = () => ({ kind: "failure" as const, reason: "doctor service failed" });
    const failureApp = createHttpApp({
      authenticate: auth,
      handlers: createReportAdminHandlers(servicesFor({ doctor: failureService })),
    });
    const failureRest = await failureApp.request(new Request("http://localhost/v1/admin/doctor", {
      method: "POST",
      headers: { authorization: "Bearer parity", "content-type": "application/json" },
      body: "{}",
    }));
    expect(failureRest.status).toBe(500);
    const failureBaseUrl = await startServer(servicesFor({ doctor: failureService }));
    const failureCli = await receipt(await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-failure-164",
      request: {},
      client: createCliClient({ baseUrl: failureBaseUrl, authorization: "Bearer parity" }),
    }));
    expect(failureCli.result).toMatchObject({ kind: "failure", semanticKind: "internal" });
    expect(failureCli.exitCode).toBe(70);
  });

  test("matches canonical backup identity, digest, destination, and CLI exit", async () => {
    const first = await makeBackupRoot();
    const directService = backupService(first);
    const direct = reportAdminBackupResponseSchema.parse(await directService.backup({ destination: first.backupPath }, contextFor(operation("admin.backup"))));
    const app = createHttpApp({ authenticate: auth, handlers: createReportAdminHandlers(servicesFor({ backup: backupService(first) .backup })) });
    const restResponse = await app.request(new Request("http://localhost/v1/admin/backup", {
      method: "POST",
      headers: { authorization: "Bearer parity", "content-type": "application/json" },
      body: JSON.stringify({ destination: join(derivePrivatePaths(first.root).backup, "rest") }),
    }));
    const rest = reportAdminBackupResponseSchema.parse(await restResponse.json());
    const baseUrl = await startServer(servicesFor({ backup: backupService(first).backup }));
    const cliResult = await runBackupCommand({
      argv: ["admin", "backup"],
      correlationId: "cli:backup-164",
      request: { destination: join(derivePrivatePaths(first.root).backup, "cli") },
      client: createCliClient({ baseUrl, authorization: "Bearer parity" }),
    });
    const cli = await receipt(cliResult);
    expect(cliResult).toMatchObject({ kind: "value", semanticKind: "success" });
    expect(cli.exitCode).toBe(0);
    expect(direct.manifest.digest).toBe(rest.manifest.digest);
    expect(rest.manifest.digest).toBe((cliResult as { data: ReportAdminBackupResponse }).data.manifest.digest);
    expect(direct.bytes).toBe(rest.bytes);
    expect(rest.bytes).toBe((cliResult as { data: ReportAdminBackupResponse }).data.bytes);
    expect(direct.backupId).toBe("backup:parity");
    expect(relative(first.root, direct.destination)).toBe("backups/parity");
    expect(JSON.parse(await readFile(join(direct.destination, "manifest.json"), "utf8"))).toMatchObject({ manifestSha256: direct.manifest.digest });
    expect((await readdir(join(derivePrivatePaths(first.root).backup, "rest"))).sort()).toContain("manifest.json");

    const changed = { ...direct, manifest: { ...direct.manifest, digest: "f".repeat(64) } };
    expect(changed.manifest.digest).not.toBe(direct.manifest.digest);
  });

  test("keeps backup publication failure blocked across direct, REST, and CLI", async () => {
    const value = await makeBackupRoot();
    const service = backupService(value, () => {
      throw new Error("injected publication interruption");
    });
    const direct = await service.backup({ destination: join(derivePrivatePaths(value.root).backup, "failed") }, contextFor(operation("admin.backup")));
    expect(direct).toMatchObject({ kind: "failure" });
    const app = createHttpApp({ authenticate: auth, handlers: createReportAdminHandlers(servicesFor({ backup: service.backup })) });
    const rest = await app.request(new Request("http://localhost/v1/admin/backup", {
      method: "POST",
      headers: { authorization: "Bearer parity", "content-type": "application/json" },
      body: JSON.stringify({ destination: join(derivePrivatePaths(value.root).backup, "rest-failed") }),
    }));
    expect(rest.status).toBe(500);
    const baseUrl = await startServer(servicesFor({ backup: service.backup }));
    const cli = await receipt(await runBackupCommand({
      argv: ["admin", "backup"],
      correlationId: "cli:backup-failure-164",
      request: { destination: join(derivePrivatePaths(value.root).backup, "cli-failed") },
      client: createCliClient({ baseUrl, authorization: "Bearer parity" }),
    }));
    expect(cli.result).toMatchObject({ kind: "failure", semanticKind: "internal" });
    expect(cli.exitCode).toBe(70);
  });

  test("runs reindex through real storage, Hono, and CliClient command execution", async () => {
    const database = reindexDatabase();
    const service = reindexService(database);
    const direct = reportAdminReindexResponseSchema.parse(await service({ scope: "all", operationIntent: "rebuild parity index" }, contextFor(operation("admin.reindex"))));
    const app = createHttpApp({ authenticate: auth, handlers: createReportAdminHandlers(servicesFor({ reindex: service })) });
    const restResponse = await app.request(new Request("http://localhost/v1/admin/reindex", {
      method: "POST", headers: { authorization: "Bearer parity", "content-type": "application/json" },
      body: JSON.stringify({ scope: "all", operationIntent: "rebuild parity index" }),
    }));
    const rest = reportAdminReindexResponseSchema.parse(await restResponse.json());
    const baseUrl = await startServer(servicesFor({ reindex: service }));
    const client = createCliClient({ baseUrl, authorization: "Bearer parity" });
    const cliResult = await runReindexCommand({
      argv: ["admin", "reindex"],
      correlationId: "cli:reindex-164",
      request: { scope: "all", operationIntent: "rebuild parity index" },
      client,
    });
    const cli = await receipt(cliResult);
    expect(direct).toEqual(rest);
    expect(cliResult).toMatchObject({ kind: "value", semanticKind: "success", data: direct });
    expect(cli.exitCode).toBe(0);
  });

  test("keeps reindex service failure blocked across direct, REST, and CLI", async () => {
    const database = reindexDatabase();
    const service = reindexService(database, true);
    expect(await service({ scope: "all", operationIntent: "rebuild parity index" }, contextFor(operation("admin.reindex")))).toMatchObject({ kind: "failure" });
    const app = createHttpApp({ authenticate: auth, handlers: createReportAdminHandlers(servicesFor({ reindex: service })) });
    const rest = await app.request(new Request("http://localhost/v1/admin/reindex", {
      method: "POST", headers: { authorization: "Bearer parity", "content-type": "application/json" },
      body: JSON.stringify({ scope: "all", operationIntent: "rebuild parity index" }),
    }));
    expect(rest.status).toBe(500);
    const baseUrl = await startServer(servicesFor({ reindex: service }));
    const cli = await receipt(await runReindexCommand({
      argv: ["admin", "reindex"],
      correlationId: "cli:reindex-failure-164",
      request: { scope: "all", operationIntent: "rebuild parity index" },
      client: createCliClient({ baseUrl, authorization: "Bearer parity" }),
    }));
    expect(cli.result).toMatchObject({ kind: "failure", semanticKind: "internal" });
    expect(cli.exitCode).toBe(70);
  });

  test("proves restore confirmation/offline guards and isolated root replacement parity", async () => {
    const source = await makeBackupRoot();
    const backup = backupService(source);
    const created = reportAdminBackupResponseSchema.parse(await backup.backup({ destination: source.backupPath }, contextFor(operation("admin.backup"))));
    const parent = await mkdtemp(join(tmpdir(), "agent-mail-admin-parity-164-restore-parent-"));
    roots.push(parent);
    const target = join(parent, "target");
    await mkdir(target, { mode: 0o700 });
    const restoreRequest: ReportAdminRestoreRequest = { target, manifest: created.manifest, confirmationNonce: nonce, offline: true };
    const service = (request: ReportAdminRestoreRequest) => restoreService(source.backupPath, request);
    const direct = await service(restoreRequest);
    if ("kind" in direct) throw new Error(`restore direct failed: ${direct.reason}`);
    const parsedDirect = reportAdminRestoreResponseSchema.parse(direct);
    expect(parsedDirect).toEqual({ restored: true, target, manifest: created.manifest, completedAt: instant });

    const app = createHttpApp({ authenticate: auth, handlers: createReportAdminHandlers(servicesFor({ restore: service })) });
    const restResponse = await app.request(new Request("http://localhost/v1/admin/restore", {
      method: "POST", headers: { authorization: "Bearer parity", "content-type": "application/json" }, body: JSON.stringify(restoreRequest),
    }));
    const rest = reportAdminRestoreResponseSchema.parse(await restResponse.json());
    const baseUrl = await startServer(servicesFor({ restore: service }));
    const cliResult = await runRestoreCommand({
      argv: ["admin", "restore"],
      correlationId: "cli:restore-164",
      request: restoreRequest,
      client: createCliClient({ baseUrl, authorization: "Bearer parity" }),
    });
    const cli = await receipt(cliResult);
    expect(rest).toEqual(parsedDirect);
    expect(cliResult).toMatchObject({ kind: "value", semanticKind: "success", data: parsedDirect });
    expect(cli.exitCode).toBe(0);
    expect(await readFile(join(target, "config", "archive-metadata.json"), "utf8")).toContain("agent-mail");

    for (const invalid of [
      { ...restoreRequest, confirmationNonce: "short" },
      { ...restoreRequest, offline: false },
    ]) {
      const blocked = await app.request(new Request("http://localhost/v1/admin/restore", {
        method: "POST", headers: { authorization: "Bearer parity", "content-type": "application/json" }, body: JSON.stringify(invalid),
      }));
      expect(blocked.status).toBe(400);
      const cliBlocked = await runRestoreCommand({
        argv: ["admin", "restore"],
        correlationId: "cli:restore-blocked-164",
        request: invalid,
        client: createCliClient({ baseUrl, authorization: "Bearer parity" }),
      });
      const blockedReceipt = await receipt(cliBlocked);
      expect(cliBlocked).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
      expect(blockedReceipt.exitCode).toBe(65);
    }

    const mismatch = { ...restoreRequest, manifest: { ...restoreRequest.manifest, digest: "e".repeat(64) } };
    const mismatchService = (request: ReportAdminRestoreRequest) => restoreService(source.backupPath, request);
    const mismatchResult = await mismatchService(mismatch);
    expect(mismatchResult).toMatchObject({ kind: "failure" });
    const mismatchApp = createHttpApp({ authenticate: auth, handlers: createReportAdminHandlers(servicesFor({ restore: mismatchService })) });
    const mismatchResponse = await mismatchApp.request(new Request("http://localhost/v1/admin/restore", {
      method: "POST", headers: { authorization: "Bearer parity", "content-type": "application/json" }, body: JSON.stringify(mismatch),
    }));
    expect(mismatchResponse.status).toBe(500);
    const mismatchCli = await runRestoreCommand({
      argv: ["admin", "restore"],
      correlationId: "cli:restore-mismatch-164",
      request: mismatch,
      client: createCliClient({
        baseUrl: await startServer(servicesFor({ restore: mismatchService })),
        authorization: "Bearer parity",
      }),
    });
    const mismatchReceipt = await receipt(mismatchCli);
    expect(mismatchCli).toMatchObject({ kind: "failure", semanticKind: "internal" });
    expect(mismatchReceipt.exitCode).toBe(70);
  });
});
