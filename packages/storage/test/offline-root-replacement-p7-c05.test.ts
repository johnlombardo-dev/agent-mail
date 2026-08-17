import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { writeBackup } from "../src/backup-writer";
import {
  OfflineRootReplacementError,
  replaceOfflinePrivateRoot,
  type OfflineSupervisorProof,
  type OfflineRootReplacementRequest,
  type RootReplacementFailurePoint,
} from "../src/offline-root-replacement";

const roots: string[] = [];
const failurePoints: readonly RootReplacementFailurePoint[] = [
  "before-rename-live-to-rollback",
  "after-rename-live-to-rollback",
  "before-rename-stage-to-target",
  "after-rename-stage-to-target",
  "before-post-swap-permissions",
  "after-post-swap-permissions",
  "before-post-swap-manifest",
  "after-post-swap-manifest",
  "before-post-swap-repository",
  "after-post-swap-repository",
];

type Fixture = Readonly<{
  readonly root: string;
  readonly target: string;
  readonly backupPath: string;
  readonly request: OfflineRootReplacementRequest;
}>;

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-root-replacement-p7-c05-"));
  roots.push(root);
  await chmod(root, 0o700);
  const source = join(root, "source");
  const target = join(root, "live");
  const backups = join(root, "backups");
  const backupPath = join(backups, "selected-backup");
  await Promise.all([source, target, backups].map((path) => mkdir(path, { mode: 0o700 })));
  await Promise.all(
    ["data", "blobs", "journal", "config"].map((name) =>
      mkdir(join(source, name), { mode: 0o700 }),
    ),
  );

  const databasePath = join(source, "data", "archive.sqlite");
  const database = new Database(databasePath);
  database.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE replacement_probe (value TEXT NOT NULL); " +
      "INSERT INTO replacement_probe VALUES ('new-root');",
  );
  database.close();
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      await chmod(path, 0o600);
    } catch {
      // SQLite may checkpoint a sidecar before the backup manifest is built.
    }
  }
  await writeFile(join(source, "journal", "events.jsonl"), '{"event":"replacement"}\n', {
    mode: 0o600,
  });
  const metadataPath = join(source, "config", "archive-metadata.json");
  await writeFile(metadataPath, '{"format":"agent-mail","version":1}\n', { mode: 0o600 });
  await writeBackup({
    privateRoot: source,
    databasePath,
    blobDirectory: join(source, "blobs"),
    journalDirectory: join(source, "journal"),
    configurationMetadataPaths: [metadataPath],
    referencedBlobDigests: [],
    destination: backupPath,
  });

  await writeFile(join(target, "old-root-sentinel"), "old-root", { mode: 0o600 });
  const manifest: unknown = JSON.parse(await readFile(join(backupPath, "manifest.json"), "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("manifestSha256" in manifest) ||
    typeof manifest.manifestSha256 !== "string"
  ) {
    throw new Error("fixture backup manifest has no digest");
  }
  return {
    root,
    target,
    backupPath,
    request: {
      target,
      manifest: { manifestId: "manifest:selected-backup", digest: manifest.manifestSha256 },
      confirmationNonce: "restore-confirmation-p7-c05",
      offline: true,
    },
  };
}

function supervisor(target: string, confirmationNonce: string): () => Promise<OfflineSupervisorProof> {
  return async () => ({
    kind: "offline-supervisor",
    target,
    confirmationNonce,
    validatedAt: "2026-08-18T00:00:00.000Z",
  });
}

async function verifyRepository(rootPath: string): Promise<void> {
  const database = new Database(join(rootPath, "data", "archive.sqlite"), {
    readonly: true,
    strict: true,
    create: false,
  });
  expect(database.query("SELECT value FROM replacement_probe;").get()).toEqual({
    value: "new-root",
  });
  database.close();
}

describe("offline private-root replacement P7-C05", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("stages, verifies, swaps, and preserves the old root as an explicit rollback", async () => {
    const value = await fixture();
    const result = await replaceOfflinePrivateRoot({
      request: value.request,
      backupPath: value.backupPath,
      offlineToken: "selected-offline-token",
      validateOfflineToken: supervisor(value.target, value.request.confirmationNonce),
      verifyRepository: ({ rootPath }) => verifyRepository(rootPath),
    });

    expect(result.state).toBe("completed");
    expect(result.rollback.status).toBe("not-needed");
    expect(result.disposition).toEqual({
      target: "directory",
      rollback: "directory",
      stage: "absent",
    });
    expect(await readFile(join(value.target, "manifest.json"), "utf8")).toContain(
      '"manifestId":"manifest:selected-backup"',
    );
    expect(await readFile(join(result.rollbackPath, "old-root-sentinel"), "utf8")).toBe(
      "old-root",
    );
    for (const path of [value.target, result.rollbackPath]) {
      expect((await lstat(path)).mode & 0o077).toBe(0);
    }
    await expect(lstat(result.stagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("requires the exact admin request and a supervisor proof before creating a stage", async () => {
    const value = await fixture();
    await expect(
      replaceOfflinePrivateRoot({
        request: { ...value.request, offline: false },
        backupPath: value.backupPath,
        offlineToken: "selected-offline-token",
        validateOfflineToken: supervisor(value.target, value.request.confirmationNonce),
        verifyRepository: ({ rootPath }) => verifyRepository(rootPath),
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(await readdir(value.target)).toEqual(["old-root-sentinel"]);

    await expect(
      replaceOfflinePrivateRoot({
        request: value.request,
        backupPath: value.backupPath,
        offlineToken: "rejected-token",
        validateOfflineToken: async () => {
          throw new Error("supervisor still owns target");
        },
        verifyRepository: ({ rootPath }) => verifyRepository(rootPath),
      }),
    ).rejects.toMatchObject({ code: "invalid-token" });
    expect(await readdir(value.target)).toEqual(["old-root-sentinel"]);

    await expect(
      replaceOfflinePrivateRoot({
        request: {
          ...value.request,
          manifest: { ...value.request.manifest, unexpected: "reject-me" },
        },
        backupPath: value.backupPath,
        offlineToken: "selected-offline-token",
        validateOfflineToken: supervisor(value.target, value.request.confirmationNonce),
        verifyRepository: ({ rootPath }) => verifyRepository(rootPath),
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(await readdir(value.target)).toEqual(["old-root-sentinel"]);

    await expect(
      replaceOfflinePrivateRoot({
        request: {
          ...value.request,
          manifest: {
            ...value.request.manifest,
            manifestId: `manifest:${"a".repeat(248)}`,
          },
        },
        backupPath: value.backupPath,
        offlineToken: "selected-offline-token",
        validateOfflineToken: supervisor(value.target, value.request.confirmationNonce),
        verifyRepository: ({ rootPath }) => verifyRepository(rootPath),
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(await readdir(value.target)).toEqual(["old-root-sentinel"]);

    const laterColonRequest = {
      ...value.request,
      manifest: { ...value.request.manifest, manifestId: "manifest:selected:backup" },
    };
    const accepted = await replaceOfflinePrivateRoot({
      request: laterColonRequest,
      backupPath: value.backupPath,
      offlineToken: "selected-offline-token",
      validateOfflineToken: supervisor(value.target, laterColonRequest.confirmationNonce),
      verifyRepository: ({ rootPath }) => verifyRepository(rootPath),
    });
    expect(accepted.manifestIdentity.manifestId).toBe("manifest:selected:backup");
  });

  test("proves target, rollback, and stage disposition at every interruption point", async () => {
    for (const point of failurePoints) {
      const value = await fixture();
      let error: unknown;
      try {
        await replaceOfflinePrivateRoot({
          request: value.request,
          backupPath: value.backupPath,
          offlineToken: "selected-offline-token",
          validateOfflineToken: supervisor(value.target, value.request.confirmationNonce),
          verifyRepository: ({ rootPath }) => verifyRepository(rootPath),
          injectFailure: (observed) => {
            if (observed === point) throw new Error(`injected ${point}`);
          },
        });
      } catch (caught: unknown) {
        error = caught;
      }
      if (!(error instanceof OfflineRootReplacementError) || error.disposition === undefined) {
        throw new Error("interruption did not produce a diagnosed replacement error");
      }
      expect(error.events).toContainEqual({ point, status: "failed" });
      const disposition = error.disposition;
      expect(disposition.target).toBe("directory");
      if (point === "before-rename-live-to-rollback") {
        expect(error.rollback.status).toBe("not-needed");
        expect(disposition.rollback).toBe("absent");
        expect(disposition.stage).toBe("absent");
        expect(await readFile(join(value.target, "old-root-sentinel"), "utf8")).toBe("old-root");
      } else if (
        point === "after-rename-live-to-rollback" ||
        point === "before-rename-stage-to-target"
      ) {
        expect(error.rollback.status).toBe("succeeded");
        expect(disposition.rollback).toBe("absent");
        expect(disposition.stage).toBe("absent");
      } else {
        expect(error.rollback.status).toBe("succeeded");
        expect(disposition.rollback).toBe("absent");
        expect(disposition.stage).toBe("directory");
      }
    }
  });

  test("reports an explicitly recoverable swap when rollback itself is interrupted", async () => {
    const value = await fixture();
    await expect(
      replaceOfflinePrivateRoot({
        request: value.request,
        backupPath: value.backupPath,
        offlineToken: "selected-offline-token",
        validateOfflineToken: supervisor(value.target, value.request.confirmationNonce),
        verifyRepository: ({ rootPath }) => verifyRepository(rootPath),
        injectFailure: async (point) => {
          if (point === "after-rename-live-to-rollback") {
            await mkdir(value.target, { mode: 0o700 });
            await writeFile(join(value.target, "collision"), "occupied", { mode: 0o600 });
          }
        },
      }),
    ).rejects.toMatchObject({
      code: "rollback-failed",
      state: "recoverable-swap",
      rollback: { attempted: true, status: "failed" },
      disposition: { target: "directory", rollback: "directory", stage: "directory" },
    });
  });
});
