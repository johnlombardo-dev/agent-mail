import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BackupWriterError, writeBackup } from "../src/backup-writer";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type Fixture = Readonly<{
  root: string;
  databasePath: string;
  blobDirectory: string;
  journalDirectory: string;
  metadataPath: string;
  backupDirectory: string;
  blobDigest: string;
  database: Database;
}>;

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-backup-writer-p2-c17-"));
  roots.push(root);
  await chmod(root, 0o700);
  const dataDirectory = join(root, "data");
  const blobDirectory = join(root, "blobs");
  const journalDirectory = join(root, "journal");
  const configDirectory = join(root, "config");
  const backupDirectory = join(root, "backups");
  await Promise.all(
    [dataDirectory, blobDirectory, journalDirectory, configDirectory, backupDirectory].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );

  const databasePath = join(dataDirectory, "archive.sqlite");
  const database = new Database(databasePath);
  database.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE wal_rows (value TEXT NOT NULL); INSERT INTO wal_rows VALUES ('committed in WAL');",
  );
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    await chmod(path, 0o600);
  }

  const blobContents = "raw canonical message bytes\n";
  const blobDigest = createHash("sha256").update(blobContents).digest("hex");
  await writeFile(join(blobDirectory, blobDigest), blobContents, { mode: 0o600 });
  const journalPath = join(journalDirectory, "events.jsonl");
  await writeFile(journalPath, '{"event":"snapshot"}\n', { mode: 0o600 });
  const metadataPath = join(configDirectory, "archive-metadata.json");
  await writeFile(metadataPath, '{"format":"agent-mail","version":1}\n', { mode: 0o600 });
  return {
    root,
    databasePath,
    blobDirectory,
    journalDirectory,
    metadataPath,
    backupDirectory,
    blobDigest,
    database,
  };
}

function optionsFor(value: Fixture, destination: string, extra: Partial<Parameters<typeof writeBackup>[0]> = {}) {
  return {
    privateRoot: value.root,
    databasePath: value.databasePath,
    blobDirectory: value.blobDirectory,
    journalDirectory: value.journalDirectory,
    configurationMetadataPaths: [value.metadataPath],
    referencedBlobDigests: [value.blobDigest],
    destination,
    ...extra,
  };
}

describe("backup writer P2-C17", () => {
  test("captures committed WAL data and publishes a verified complete backup", async () => {
    const value = await fixture();
    const destination = join(value.backupDirectory, "backup-one");
    const result = await writeBackup(optionsFor(value, destination));
    value.database.close();

    const restored = new Database(join(destination, "data", "archive.sqlite"), {
      strict: true,
      create: false,
    });
    expect(restored.query("PRAGMA integrity_check;").get()).toEqual({ integrity_check: "ok" });
    expect(restored.query("SELECT value FROM wal_rows;").all()).toEqual([
      { value: "committed in WAL" },
    ]);
    restored.close();

    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
      `blobs/${value.blobDigest}`,
      "config/archive-metadata.json",
      "data/archive.sqlite",
      "data/archive.sqlite-shm",
      "data/archive.sqlite-wal",
      "journal/events.jsonl",
    ]);
    expect(JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"))).toEqual(result.manifest);
    expect(await readFile(join(destination, `blobs/${value.blobDigest}`), "utf8")).toBe(
      "raw canonical message bytes\n",
    );
  });

  test("keeps source pause bounded to serialization and resumes before publication", async () => {
    const value = await fixture();
    const events: string[] = [];
    const result = await writeBackup(
      optionsFor(value, join(value.backupDirectory, "backup-two"), {
        pauseSource: () => {
          events.push("pause");
        },
        resumeSource: () => {
          events.push("resume");
        },
        beforePublish: () => {
          events.push("publish");
        },
      }),
    );
    value.database.close();
    expect(events).toEqual(["pause", "resume", "publish"]);
    expect(result.backupPath).toBe(join(value.backupDirectory, "backup-two"));
  });

  test("rejects an unpaired pause callback before creating a stage", async () => {
    const value = await fixture();
    await expect(
      writeBackup(
        optionsFor(value, join(value.backupDirectory, "backup-invalid-control"), {
          pauseSource: () => undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-snapshot-control", stagingPath: undefined });
    expect(await readdir(value.backupDirectory)).toEqual([]);
    value.database.close();
  });

  test("an interruption before rename leaves no incomplete final and a removable stage", async () => {
    const value = await fixture();
    const destination = join(value.backupDirectory, "backup-interrupted");
    let error: unknown;
    try {
      await writeBackup(
        optionsFor(value, destination, {
          beforePublish: () => {
            throw new Error("test interruption");
          },
        }),
      );
    } catch (caught: unknown) {
      error = caught;
    } finally {
      value.database.close();
    }

    expect(error).toBeInstanceOf(BackupWriterError);
    expect(error).toMatchObject({ code: "publication-interrupted" });
    if (!(error instanceof BackupWriterError)) throw error;
    const interrupted = error;
    expect(interrupted.stagingPath).toMatch(/\.stage-v1-\d+-[0-9a-f]{48}\.tmp$/u);
    await expect(readdir(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const stages = await readdir(value.backupDirectory);
    expect(stages).toEqual([interrupted.stagingPath?.split("/").at(-1)]);
    await rm(interrupted.stagingPath ?? "", { force: true, recursive: true });
    expect(await readdir(value.backupDirectory)).toEqual([]);
  });
});
