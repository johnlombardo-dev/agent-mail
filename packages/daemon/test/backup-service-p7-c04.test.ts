import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { reportAdminBackupResponseSchema } from "@agent-mail/contracts";
import { createCliClient } from "../../cli/src/client";
import { runBackupCommand } from "../../cli/src/backup-command";
import { derivePrivatePaths } from "../src/config";
import { createBackupService, deriveBackupDestination } from "../src/backup-service";
import { createHttpApp, type HttpCredentialResolution } from "../src/http";
import { createReportAdminHandlers, type ReportAdminServices } from "../src/report-admin-handlers";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<Readonly<{ root: string; request: { destination: string }; database: Database }>> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-backup-service-p7-c04-"));
  roots.push(root);
  const paths = derivePrivatePaths(root);
  const config = join(root, "config");
  await Promise.all(
    [paths.data, paths.blob, paths.journal, paths.backup, paths.runtime, config].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  const databasePath = join(paths.data, "archive.sqlite");
  const database = new Database(databasePath);
  database.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('verified');",
  );
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`])
    await chmod(path, 0o600);
  const blob = "raw mail bytes\n";
  const digest = createHash("sha256").update(blob).digest("hex");
  await writeFile(join(paths.blob, digest), blob, { mode: 0o600 });
  await writeFile(join(paths.journal, "events.jsonl"), '{"kind":"backup"}\n', { mode: 0o600 });
  await writeFile(join(config, "archive-metadata.json"), '{"format":"agent-mail"}\n', { mode: 0o600 });
  return {
    root,
    request: { destination: join(paths.backup, "api-created") },
    database,
  };
}

function serviceFor(value: Awaited<ReturnType<typeof fixture>>) {
  const paths = derivePrivatePaths(value.root);
  return createBackupService({
    configuration: { privateRoot: value.root, paths },
    databasePath: join(paths.data, "archive.sqlite"),
    configurationMetadataPaths: [join(value.root, "config", "archive-metadata.json")],
    referencedBlobDigests: [
      createHash("sha256").update("raw mail bytes\n").digest("hex"),
    ],
    now: () => new Date("2026-08-18T00:00:00.000Z"),
  });
}

function authenticated(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: { subject: "operator:local", scopes: ["admin:backup"] },
  };
}

function servicesForBackup(
  backup: ReportAdminServices["backup"],
): ReportAdminServices {
  const unused = () => ({ kind: "blocked" as const, reason: "operation not exercised" });
  return {
    createReport: unused,
    exportSelected: unused,
    backup,
    restore: unused,
    doctor: unused,
    reindex: unused,
  };
}

async function startHttpServer(service: ReportAdminServices["backup"]): Promise<string> {
  const app = createHttpApp({
    authenticate: authenticated,
    handlers: createReportAdminHandlers(servicesForBackup(service)),
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
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function hashPublishedEntry(
  backupPath: string,
  entry: Readonly<{ readonly path: string; readonly size: number; readonly sha256: string }>,
): Promise<void> {
  const path = join(backupPath, entry.path);
  const info = await lstat(path);
  expect(info.isFile()).toBe(true);
  expect(info.isSymbolicLink()).toBe(false);
  const bytes = await readFile(path);
  expect(bytes.byteLength).toBe(entry.size);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
}

describe("P7-C04 concrete backup service", () => {
  test("returns metadata equal to the visible, independently hashed artifact", async () => {
    const value = await fixture();
    const service = serviceFor(value);
    const result = await service.backup(value.request, {
      correlationId: "request:backup-test",
      operationKey: "admin.backup",
      scope: "admin:backup",
      principal: { subject: "operator:local", scopes: ["admin:backup"] },
    });
    expect(result).toMatchObject({
      backupId: "backup:api-created",
      destination: value.request.destination,
      createdAt: "2026-08-18T00:00:00.000Z",
    });
    expect(result.manifest.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(await readFile(join(value.request.destination, "manifest.json"), "utf8"))).toMatchObject({
      manifestSha256: result.manifest.digest,
    });
    value.database.close();
  });

  test("rejects traversal and arbitrary destinations before the writer", async () => {
    const value = await fixture();
    let calls = 0;
    const paths = derivePrivatePaths(value.root);
    const service = createBackupService({
      configuration: { privateRoot: value.root, paths },
      configurationMetadataPaths: [join(value.root, "config", "archive-metadata.json")],
      writer: async () => {
        calls += 1;
        throw new Error("writer must not run");
      },
    });
    await expect(
      service.backup(
        { destination: join(value.root, "outside") },
        {
          correlationId: "request:backup-invalid",
          operationKey: "admin.backup",
          scope: "admin:backup",
          principal: { subject: "operator:local", scopes: ["admin:backup"] },
        },
      ),
    ).resolves.toMatchObject({ kind: "failure", reason: "backup destination is not configured backup storage" });
    expect(calls).toBe(0);
    value.database.close();
  });

  test("serializes concurrent operations and never publishes a staging identity", async () => {
    const value = await fixture();
    const service = serviceFor(value);
    const context = {
      correlationId: "request:backup-concurrent",
      operationKey: "admin.backup",
      scope: "admin:backup",
      principal: { subject: "operator:local", scopes: ["admin:backup"] },
    };
    const [first, second] = await Promise.all([
      service.backup(value.request, context),
      service.backup({ destination: join(derivePrivatePaths(value.root).backup, "second") }, context),
    ]);
    expect(first.destination).not.toContain(".stage-");
    expect(second.destination).not.toContain(".stage-");
    expect(await readdir(derivePrivatePaths(value.root).backup)).toEqual([
      "api-created",
      "second",
    ]);
    value.database.close();
  });

  test("turns a pre-publication interruption into failure without a final identity", async () => {
    const value = await fixture();
    const paths = derivePrivatePaths(value.root);
    const service = createBackupService({
      configuration: { privateRoot: value.root, paths },
      databasePath: join(paths.data, "archive.sqlite"),
      configurationMetadataPaths: [join(value.root, "config", "archive-metadata.json")],
      referencedBlobDigests: [
        createHash("sha256").update("raw mail bytes\n").digest("hex"),
      ],
      beforePublish: () => {
        throw new Error("interrupt before rename");
      },
    });
    await expect(service.backup(value.request, {
      correlationId: "request:backup-interrupted",
      operationKey: "admin.backup",
      scope: "admin:backup",
      principal: { subject: "operator:local", scopes: ["admin:backup"] },
    })).resolves.toMatchObject({ kind: "failure", reason: "backup could not be completed" });
    expect(await readdir(derivePrivatePaths(value.root).backup)).toEqual([
      expect.stringMatching(/\.stage-v1-/u),
    ]);
    value.database.close();
  });

  test("excludes credentials from service backups", async () => {
    const value = await fixture();
    const paths = derivePrivatePaths(value.root);
    const secrets = join(value.root, "secrets");
    await mkdir(secrets, { mode: 0o700 });
    const keyring = join(secrets, "action-approval-seal-keyring.v1.json");
    await writeFile(keyring, '{"activeKeyId":"secret"}\n', { mode: 0o600 });
    const service = createBackupService({
      configuration: { privateRoot: value.root, paths },
      databasePath: join(paths.data, "archive.sqlite"),
      configurationMetadataPaths: [keyring],
    });
    const result = await service.backup(value.request, {
      correlationId: "request:backup-secret",
      operationKey: "admin.backup",
      scope: "admin:backup",
      principal: { subject: "operator:local", scopes: ["admin:backup"] },
    });
    expect(result).toMatchObject({ kind: "failure", reason: "backup could not be completed" });
    expect(await readdir(paths.backup)).toEqual([]);
    value.database.close();
  });

  test("proves CLI through real HTTP, handler, service, and published artifact", async () => {
    const value = await fixture();
    const service = serviceFor(value);
    const baseUrl = await startHttpServer(service.backup);
    const client = createCliClient({
      baseUrl,
      authorization: "Bearer backup-test",
      timeouts: { connectMs: 2_000, controlMs: 2_000, streamIdleMs: 2_000 },
    });
    const result = await runBackupCommand({
      argv: ["admin", "backup"],
      correlationId: "cli:backup-composed",
      request: value.request,
      client,
    });
    expect(result).toMatchObject({ kind: "value", operationKey: "admin.backup", semanticKind: "success" });
    if (result.kind !== "value") throw new Error("composed backup did not return a value");
    const response = reportAdminBackupResponseSchema.parse(result.data);
    const manifest = JSON.parse(await readFile(join(response.destination, "manifest.json"), "utf8"));
    expect(manifest.manifestSha256).toBe(response.manifest.digest);
    expect(response.backupId).toBe(`backup:${response.destination.split("/").at(-1)}`);
    const bytes = manifest.entries.reduce(
      (total: number, entry: Readonly<{ readonly size: number }>) => total + entry.size,
      0,
    );
    expect(response.bytes).toBe(bytes);
    for (const entry of manifest.entries) await hashPublishedEntry(response.destination, entry);
    const databaseEntry = manifest.entries.find(
      (entry: Readonly<{ readonly role: string }>) => entry.role === "sqlite-database",
    );
    if (databaseEntry === undefined) throw new Error("published backup has no database entry");
    const publishedDatabase = new Database(join(response.destination, databaseEntry.path), {
      strict: true,
      create: false,
    });
    expect(publishedDatabase.query("PRAGMA integrity_check;").get()).toEqual({ integrity_check: "ok" });
    expect(publishedDatabase.query("SELECT value FROM records;").all()).toEqual([{ value: "verified" }]);
    publishedDatabase.close();
    value.database.close();
  });

  test("proves pre-publication failure through real HTTP and CLI has no final identity", async () => {
    const value = await fixture();
    const paths = derivePrivatePaths(value.root);
    const service = createBackupService({
      configuration: { privateRoot: value.root, paths },
      databasePath: join(paths.data, "archive.sqlite"),
      configurationMetadataPaths: [join(value.root, "config", "archive-metadata.json")],
      referencedBlobDigests: [createHash("sha256").update("raw mail bytes\n").digest("hex")],
      beforePublish: () => {
        throw new Error("injected publication interruption");
      },
    });
    const baseUrl = await startHttpServer(service.backup);
    const client = createCliClient({ baseUrl, authorization: "Bearer backup-test" });
    const result = await runBackupCommand({
      argv: ["admin", "backup"],
      correlationId: "cli:backup-failure",
      request: { destination: join(paths.backup, "failed") },
      client,
    });
    expect(result).toMatchObject({ kind: "failure", operationKey: "admin.backup", semanticKind: "internal" });
    if (result.kind !== "failure") throw new Error("interrupted backup was reported as success");
    expect(result.error.message).toBe("internal server error");
    expect(JSON.stringify(result)).not.toContain("injected publication interruption");
    await expect(stat(join(paths.backup, "failed"))).rejects.toMatchObject({ code: "ENOENT" });
    const entries = await readdir(paths.backup);
    expect(entries.some((entry) => entry === "failed")).toBe(false);
    expect(entries.some((entry) => entry.startsWith(".stage-v1-"))).toBe(true);
    value.database.close();
  });

  test("derives only one safe child segment from configuration", async () => {
    const value = await fixture();
    const paths = derivePrivatePaths(value.root);
    expect(deriveBackupDestination({ privateRoot: value.root, paths }, "label-1")).toBe(
      join(paths.backup, "label-1"),
    );
    expect(() => deriveBackupDestination({ privateRoot: value.root, paths }, "../escape")).toThrow();
    value.database.close();
  });
});
