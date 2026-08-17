import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BackupManifestError, buildBackupManifest } from "../src/backup-manifest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function file(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
}

type Fixture = Readonly<{
  root: string;
  databasePath: string;
  blobDirectory: string;
  journalDirectory: string;
  metadataPath: string;
  blobDigest: string;
}>;

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-backup-manifest-p2-c16-"));
  roots.push(root);
  const dataDirectory = join(root, "data");
  const blobDirectory = join(root, "blobs");
  const journalDirectory = join(root, "journal");
  const configDirectory = join(root, "config");
  await Promise.all(
    [dataDirectory, blobDirectory, journalDirectory, configDirectory].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );

  const databasePath = join(dataDirectory, "archive.sqlite");
  await file(databasePath, "SQLite database fixture\n");
  await file(`${databasePath}-wal`, "SQLite WAL fixture\n");
  await file(`${databasePath}-shm`, "SQLite SHM fixture\n");

  const blobContents = "canonical raw message bytes\n";
  const blobDigest = digestOf(blobContents);
  await file(join(blobDirectory, blobDigest), blobContents);
  await file(
    join(blobDirectory, `.stage-v1-pid43127-owner${"a".repeat(64)}-random${"b".repeat(64)}.tmp`),
    "staging evidence\n",
  );
  await file(join(blobDirectory, `.quarantine-v1-${"c".repeat(64)}-${"d".repeat(32)}.blob`), "quarantine evidence\n");

  const metadataPath = join(configDirectory, "archive-metadata.json");
  await file(metadataPath, '{"format":"agent-mail","version":1}\n');
  await file(join(journalDirectory, "events.jsonl"), '{"category":"recovery"}\n');
  await mkdir(join(journalDirectory, "2026"), { mode: 0o700 });
  await file(join(journalDirectory, "2026", "events.jsonl"), '{"category":"sync"}\n');

  return { root, databasePath, blobDirectory, journalDirectory, metadataPath, blobDigest };
}

function optionsFor(value: Fixture) {
  return {
    privateRoot: value.root,
    databasePath: value.databasePath,
    blobDirectory: value.blobDirectory,
    journalDirectory: value.journalDirectory,
    configurationMetadataPaths: [value.metadataPath],
    referencedBlobDigests: [value.blobDigest],
  };
}

describe("backup inventory manifest P2-C16", () => {
  test("returns a deterministic sorted inventory with hashes and artifact roles", async () => {
    const value = await fixture();
    const options = optionsFor(value);
    const first = await buildBackupManifest(options);
    const second = await buildBackupManifest(options);

    expect(first).toEqual(second);
    expect(first.version).toBe(1);
    expect(first.hashAlgorithm).toBe("sha256");
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "blobs/" + value.blobDigest,
      "config/archive-metadata.json",
      "data/archive.sqlite",
      "data/archive.sqlite-shm",
      "data/archive.sqlite-wal",
      "journal/2026/events.jsonl",
      "journal/events.jsonl",
    ]);
    expect(first.entries.every((entry) => entry.type === "file" && entry.required)).toBe(true);
    expect(first.entries.find((entry) => entry.role === "canonical-blob")?.sha256).toBe(value.blobDigest);
    expect(first.entries.find((entry) => entry.path === "data/archive.sqlite")?.role).toBe("sqlite-database");
    expect(first.entries.find((entry) => entry.path === "data/archive.sqlite-wal")?.role).toBe("sqlite-wal");
    expect(first.entries.find((entry) => entry.path === "config/archive-metadata.json")?.role).toBe(
      "configuration-metadata",
    );
    expect(first.entries.filter((entry) => entry.role === "operational-journal")).toHaveLength(2);
    expect(first.entries.some((entry) => entry.path.includes("stage") || entry.path.includes("quarantine"))).toBe(false);
    expect(first.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("rejects a referenced blob that is absent from the canonical store", async () => {
    const value = await fixture();
    await rm(join(value.blobDirectory, value.blobDigest));

    await expect(buildBackupManifest(optionsFor(value))).rejects.toMatchObject<Partial<BackupManifestError>>({
      code: "missing-required-artifact",
    });
  });

  test("rejects a present canonical blob whose bytes do not match its digest name", async () => {
    const value = await fixture();
    await file(join(value.blobDirectory, value.blobDigest), "corrupt bytes\n");

    await expect(buildBackupManifest(optionsFor(value))).rejects.toMatchObject<Partial<BackupManifestError>>({
      code: "blob-integrity-mismatch",
    });
  });

  test("rejects missing database, path traversal, duplicate paths, and symlink escape", async () => {
    const value = await fixture();
    const duplicate = { ...optionsFor(value), configurationMetadataPaths: [value.metadataPath, value.metadataPath] };
    await expect(buildBackupManifest(duplicate)).rejects.toMatchObject<Partial<BackupManifestError>>({
      code: "duplicate-path",
    });

    await rm(value.databasePath);
    await expect(buildBackupManifest(optionsFor(value))).rejects.toMatchObject<Partial<BackupManifestError>>({
      code: "missing-required-artifact",
    });

    const traversal = { ...optionsFor(value), databasePath: `${value.root}/../outside.sqlite` };
    await expect(buildBackupManifest(traversal)).rejects.toMatchObject<Partial<BackupManifestError>>({
      code: "unsafe-path",
    });

    const escaped = await fixture();
    const outside = `${escaped.root}/../agent-mail-backup-manifest-outside.json`;
    roots.push(outside);
    await file(outside, "outside\n");
    const escapedMetadata = join(escaped.root, "config", "escaped.json");
    await symlink(outside, escapedMetadata);
    await expect(
      buildBackupManifest({ ...optionsFor(escaped), configurationMetadataPaths: [escapedMetadata] }),
    ).rejects.toMatchObject<Partial<BackupManifestError>>({ code: "symlink" });
  });

  test("rejects an incomplete SQLite WAL representation and secret metadata", async () => {
    const value = await fixture();
    await rm(`${value.databasePath}-shm`);
    await expect(buildBackupManifest(optionsFor(value))).rejects.toMatchObject<Partial<BackupManifestError>>({
      code: "wal-inconsistent",
    });

    await file(`${value.databasePath}-shm`, "SQLite SHM fixture\n");
    const secretPath = join(value.root, "config", "api-token");
    await file(secretPath, "must not be inventoried\n");
    await expect(
      buildBackupManifest({ ...optionsFor(value), configurationMetadataPaths: [secretPath] }),
    ).rejects.toMatchObject<Partial<BackupManifestError>>({ code: "secret-metadata" });
  });

  test("rejects a symlink in the canonical blob directory even when it points outside", async () => {
    const value = await fixture();
    const outside = `${value.root}/../agent-mail-backup-manifest-blob-outside`;
    roots.push(outside);
    await file(outside, "outside blob\n");
    await symlink(outside, join(value.blobDirectory, "e".repeat(64)));

    await expect(buildBackupManifest(optionsFor(value))).rejects.toMatchObject<Partial<BackupManifestError>>({
      code: "symlink",
    });
  });
});
