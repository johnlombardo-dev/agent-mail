import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { restoreBackup } from "../src/backup-restore";
import { writeBackup } from "../src/backup-writer";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type Fixture = Readonly<{
  root: string;
  backupPath: string;
  blobPath: string;
  blobContents: string;
  databasePath: string;
  journalPath: string;
  metadataPath: string;
  database: Database;
}>;

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-backup-restore-p2-c18-"));
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
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; " +
      "CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT NOT NULL); " +
      "CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id), value TEXT NOT NULL); " +
      "INSERT INTO parents VALUES (1, 'parent'); INSERT INTO children VALUES (1, 1, 'child');",
  );
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      await chmod(path, 0o600);
    } catch {
      // SQLite may checkpoint a sidecar before the writer snapshots it.
    }
  }

  const blobContents = "raw canonical message bytes\n";
  const blobDigest = createHash("sha256").update(blobContents).digest("hex");
  const blobPath = join(blobDirectory, blobDigest);
  await writeFile(blobPath, blobContents, { mode: 0o600 });
  const journalPath = join(journalDirectory, "events.jsonl");
  await writeFile(journalPath, '{"event":"restore-proof"}\n', { mode: 0o600 });
  const metadataPath = join(configDirectory, "archive-metadata.json");
  await writeFile(metadataPath, '{"format":"agent-mail","version":1}\n', { mode: 0o600 });
  const backupPath = join(backupDirectory, "backup-one");
  await writeBackup({
    privateRoot: root,
    databasePath,
    blobDirectory,
    journalDirectory,
    configurationMetadataPaths: [metadataPath],
    referencedBlobDigests: [blobDigest],
    destination: backupPath,
  });
  return {
    root,
    backupPath,
    blobPath: join(backupPath, "blobs", blobDigest),
    blobContents,
    databasePath,
    journalPath,
    metadataPath,
    database,
  };
}

async function closeFixtureDatabase(value: Fixture): Promise<void> {
  value.database.close();
}

async function replaceDatabaseWithInvalidVerifiedBytes(backupPath: string): Promise<void> {
  const manifestPath = join(backupPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: number;
    hashAlgorithm: string;
    entries: Array<{
      path: string;
      role: string;
      size: number;
      sha256: string;
    }>;
    manifestSha256: string;
  };
  const databaseEntry = manifest.entries.find((entry) => entry.role === "sqlite-database");
  if (databaseEntry === undefined) throw new Error("fixture manifest has no database entry");
  const invalidDatabase = Buffer.from("verified bytes that are not a SQLite database\n", "utf8");
  await writeFile(join(backupPath, databaseEntry.path), invalidDatabase, { mode: 0o600 });
  databaseEntry.size = invalidDatabase.byteLength;
  databaseEntry.sha256 = createHash("sha256").update(invalidDatabase).digest("hex");
  manifest.manifestSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        version: manifest.version,
        hashAlgorithm: manifest.hashAlgorithm,
        entries: manifest.entries,
      }),
      "utf8",
    )
    .digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
}

describe("verified backup restore P2-C18", () => {
  test("restores SQLite, blob, journal, and configuration closure into an empty private root", async () => {
    const value = await fixture();
    const destination = join(value.root, "restore-one");
    const result = await restoreBackup({ backupPath: value.backupPath, destination });
    await closeFixtureDatabase(value);

    expect(result.restorePath).toBe(destination);
    const blobEntry = result.manifest.entries.find((entry) => entry.role === "canonical-blob");
    expect(blobEntry).toBeDefined();
    if (blobEntry === undefined) throw new Error("fixture manifest has no blob");
    expect(await readFile(join(destination, blobEntry.path), "utf8")).toBe(value.blobContents);
    expect(await readFile(join(destination, "journal", "events.jsonl"), "utf8")).toBe(
      '{"event":"restore-proof"}\n',
    );
    expect(await readFile(join(destination, "config", "archive-metadata.json"), "utf8")).toBe(
      '{"format":"agent-mail","version":1}\n',
    );
    const restored = new Database(result.databasePath, { readonly: true, strict: true, create: false });
    expect(restored.query("PRAGMA integrity_check;").get()).toEqual({ integrity_check: "ok" });
    expect(restored.query("PRAGMA foreign_key_check;").all()).toEqual([]);
    expect(restored.query("SELECT value FROM children JOIN parents ON parents.id = children.parent_id;").all()).toEqual([
      { value: "child" },
    ]);
    restored.close();
    for (const path of [destination, join(destination, "data"), join(destination, "blobs"), join(destination, "journal"), join(destination, "config")]) {
      expect((await lstat(path)).mode & 0o077).toBe(0);
    }
  });

  test("accepts an existing empty owner-only directory but rejects a non-empty live root before writing", async () => {
    const value = await fixture();
    const destination = join(value.root, "restore-empty");
    await mkdir(destination, { mode: 0o700 });
    await restoreBackup({ backupPath: value.backupPath, destination });
    await closeFixtureDatabase(value);
    const liveRoot = join(value.root, "live-root");
    await mkdir(liveRoot, { mode: 0o700 });
    const sentinel = join(liveRoot, "sentinel");
    await writeFile(sentinel, "must remain", { mode: 0o600 });
    await expect(restoreBackup({ backupPath: value.backupPath, destination: liveRoot })).rejects.toMatchObject({
      code: "destination-not-empty",
    });
    expect(await readFile(sentinel, "utf8")).toBe("must remain");
  });

  test("leaves an existing empty destination empty when staged SQLite verification fails", async () => {
    const value = await fixture();
    await closeFixtureDatabase(value);
    await replaceDatabaseWithInvalidVerifiedBytes(value.backupPath);
    const destination = join(value.root, "restore-invalid-sqlite");
    await mkdir(destination, { mode: 0o700 });

    await expect(
      restoreBackup({ backupPath: value.backupPath, destination }),
    ).rejects.toMatchObject({ code: "sqlite-integrity-failed" });
    expect(await readdir(destination)).toEqual([]);
  });

  test("fails closed on a corrupt blob without creating a usable destination", async () => {
    const value = await fixture();
    await closeFixtureDatabase(value);
    await writeFile(value.blobPath, "corrupted bytes\n", { mode: 0o600 });
    const destination = join(value.root, "restore-corrupt");
    await expect(restoreBackup({ backupPath: value.backupPath, destination })).rejects.toMatchObject({
      code: "artifact-hash-mismatch",
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects traversal and symlink artifacts before any destination write", async () => {
    const traversal = await fixture();
    await closeFixtureDatabase(traversal);
    const manifestPath = join(traversal.backupPath, "manifest.json");
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("entries" in parsed) ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length === 0 ||
      typeof parsed.entries[0] !== "object" ||
      parsed.entries[0] === null ||
      !("path" in parsed.entries[0])
    ) {
      throw new Error("fixture manifest has an unexpected shape");
    }
    const manifest = parsed;
    manifest.entries[0].path = "../escape.sqlite";
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const traversalDestination = join(traversal.root, "restore-traversal");
    await expect(restoreBackup({ backupPath: traversal.backupPath, destination: traversalDestination })).rejects.toMatchObject({
      code: "unsafe-path",
    });
    await expect(lstat(traversalDestination)).rejects.toMatchObject({ code: "ENOENT" });

    const linked = await fixture();
    await closeFixtureDatabase(linked);
    const outside = join(linked.root, "outside.blob");
    await writeFile(outside, "outside", { mode: 0o600 });
    const linkedPath = join(linked.backupPath, "blobs", "e".repeat(64));
    await symlink(outside, linkedPath);
    const linkedDestination = join(linked.root, "restore-symlink");
    await expect(restoreBackup({ backupPath: linked.backupPath, destination: linkedDestination })).rejects.toMatchObject({
      code: "symlink",
    });
    await expect(lstat(linkedDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
