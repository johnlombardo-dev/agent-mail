import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runDoctorIntegrity, type DoctorIntegrityResult } from "../src/doctor-integrity";

const roots: string[] = [];
const messageId = `message:${"a".repeat(64)}`;
const rawBytes = Buffer.from("raw message bytes\n");
const bodyBytes = Buffer.from("body bytes\n");
const attachmentBytes = Buffer.from("attachment bytes\n");

type Fixture = Readonly<{
  readonly root: string;
  readonly databasePath: string;
  readonly blobDirectory: string;
  readonly blobs: Readonly<Record<"raw" | "body" | "attachment", string>>;
}>;

type SnapshotEntry = Readonly<{
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly size: number;
  readonly content: string;
}>;

const storageDatabaseModule = join(import.meta.dir, "../src/database.ts");

async function runFixtureChild<T>(script: string, args: readonly string[] = []): Promise<T> {
  const child = Bun.spawn(["bun", "-e", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`doctor fixture child failed: ${stderr}`);
  return JSON.parse(stdout) as T;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeFixture(expectedBodySize = bodyBytes.byteLength): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-doctor-p7-c01-"));
  roots.push(root);
  const result = await runFixtureChild<{
    readonly databasePath: string;
    readonly blobDirectory: string;
    readonly blobs: Readonly<Record<"raw" | "body" | "attachment", string>>;
  }>(
    `import { mkdir, chmod, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { openDatabase } from ${JSON.stringify(storageDatabaseModule)};
const root = process.argv[1];
const expectedBodySize = Number(process.argv[2]);
const messageId = ${JSON.stringify(messageId)};
const rawBytes = Buffer.from(${JSON.stringify(rawBytes.toString())});
const bodyBytes = Buffer.from(${JSON.stringify(bodyBytes.toString())});
const attachmentBytes = Buffer.from(${JSON.stringify(attachmentBytes.toString())});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
await chmod(root, 0o700);
const blobDirectory = root + "/blobs";
await mkdir(blobDirectory, { mode: 0o700 });
const databasePath = root + "/archive.sqlite";
const opened = await openDatabase(databasePath);
opened.db.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
const blobs = { raw: digest(rawBytes), body: digest(bodyBytes), attachment: digest(attachmentBytes) };
opened.db.query("INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, ?, ?, ?, ?);").run(messageId, "raw-eml", 1, blobs.raw, rawBytes.byteLength);
opened.db.query("INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, ?, ?, ?, ?);").run(messageId, "body-part", 1, blobs.body, expectedBodySize);
opened.db.query("INSERT INTO message_blob_references (message_id, kind, ordinal, blob_id, size) VALUES (?, ?, ?, ?, ?);").run(messageId, "attachment", 1, blobs.attachment, attachmentBytes.byteLength);
await opened.close();
await writeFile(blobDirectory + "/" + blobs.raw, rawBytes, { mode: 0o600 });
await writeFile(blobDirectory + "/" + blobs.body, bodyBytes, { mode: 0o600 });
await writeFile(blobDirectory + "/" + blobs.attachment, attachmentBytes, { mode: 0o600 });
process.stdout.write(JSON.stringify({ databasePath, blobDirectory, blobs }));`,
    [root, String(expectedBodySize)],
  );
  return { root, ...result };
}

async function mutateDatabase(path: string, operation: "foreign-key" | "migration-hash"): Promise<void> {
  await runFixtureChild<void>(
    `import { Database } from "bun:sqlite";
const database = new Database(process.argv[1], { create: false, strict: true });
switch (process.argv[2]) {
  case "foreign-key":
    database.exec("PRAGMA foreign_keys = OFF;");
    database.query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);").run("account:fixture", "mailbox:fixture", 1);
    database.query("INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);").run("account:fixture", "mailbox:fixture", 1, 1, "message:" + "b".repeat(64));
    break;
  case "migration-hash":
    database.query("UPDATE schema_migrations SET content_hash = ? WHERE version = 2;").run("f".repeat(64));
    break;
}
database.close();
process.stdout.write("null");`,
    [path, operation],
  );
}

async function snapshotTree(root: string): Promise<readonly SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    for (const child of children) {
      const path = join(directory, child.name);
      const info = await lstat(path);
      const relativePath = relative(root, path);
      if (info.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          kind: "symlink",
          mode: info.mode & 0o777,
          size: info.size,
          content: await readlink(path),
        });
      } else if (info.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory", mode: info.mode & 0o777, size: 0, content: "" });
        await visit(path);
      } else {
        entries.push({
          path: relativePath,
          kind: "file",
          mode: info.mode & 0o777,
          size: info.size,
          content: digest(await readFile(path)),
        });
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function check(result: DoctorIntegrityResult, id: string): DoctorIntegrityResult["checks"][number] {
  const found = result.checks.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing doctor check ${id}`);
  return found;
}

async function assertReadOnly(fixture: Fixture, operation: () => Promise<DoctorIntegrityResult>): Promise<DoctorIntegrityResult> {
  const before = await snapshotTree(fixture.root);
  const result = await operation();
  const after = await snapshotTree(fixture.root);
  expect(after).toEqual(before);
  return result;
}

function doctor(fixture: Fixture): Promise<DoctorIntegrityResult> {
  return runDoctorIntegrity({
    privateRoot: fixture.root,
    databasePath: fixture.databasePath,
    blobDirectory: fixture.blobDirectory,
  });
}

describe("read-only doctor integrity P7-C01", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("reports a healthy store and proves the complete tree is unchanged", async () => {
    const fixture = await makeFixture();
    const result = await assertReadOnly(fixture, () => doctor(fixture));
    expect(result.status).toBe("healthy");
    expect(result.checks.every((item) => item.status === "pass")).toBe(true);
  });

  test("keeps SQLite integrity and foreign-key outcomes separate", async () => {
    const fixture = await makeFixture();
    await mutateDatabase(fixture.databasePath, "foreign-key");

    const result = await assertReadOnly(fixture, () => doctor(fixture));
    expect(result.status).toBe("unhealthy");
    expect(check(result, "sqlite-integrity").status).toBe("pass");
    expect(check(result, "foreign-keys").status).toBe("fail");
    expect(check(result, "foreign-keys").evidence[0]?.identity).toContain("remote_placements");
  });

  const cases = [
    {
      name: "SQLite corruption",
      mutate: async (fixture: Fixture) => {
        await writeFile(fixture.databasePath, Buffer.alloc(512, 0x5a), { mode: 0o600 });
      },
      expected: (result: DoctorIntegrityResult) => expect(check(result, "sqlite-integrity").status).toBe("fail"),
    },
    {
      name: "missing blob",
      mutate: async (fixture: Fixture) => {
        await rm(join(fixture.blobDirectory, fixture.blobs.body));
      },
      expected: (result: DoctorIntegrityResult) => expect(check(result, "blobs").evidence[0]?.detail).toContain("missing"),
    },
    {
      name: "digest mismatch",
      mutate: async (fixture: Fixture) => {
        await writeFile(join(fixture.blobDirectory, fixture.blobs.body), "different bytes", { mode: 0o600 });
      },
      expected: (result: DoctorIntegrityResult) => expect(check(result, "blobs").evidence[0]?.detail).toContain("digest mismatch"),
    },
    {
      name: "unsafe path",
      mutate: async (fixture: Fixture) => {
        const path = join(fixture.blobDirectory, fixture.blobs.body);
        await rm(path);
        const outside = join(fixture.root, "outside-body");
        await writeFile(outside, bodyBytes, { mode: 0o600 });
        await symlink(outside, path);
      },
      expected: (result: DoctorIntegrityResult) => expect(check(result, "blobs").evidence[0]?.detail).toContain("symbolic link"),
    },
    {
      name: "orphan candidate",
      mutate: async (fixture: Fixture) => {
        const orphan = digest(Buffer.from("orphan bytes"));
        await writeFile(join(fixture.blobDirectory, orphan), "orphan bytes", { mode: 0o600 });
      },
      expected: (result: DoctorIntegrityResult) => expect(check(result, "orphans").status).toBe("fail"),
    },
    {
      name: "migration hash mismatch",
      mutate: async (fixture: Fixture) => {
        await mutateDatabase(fixture.databasePath, "migration-hash");
      },
      expected: (result: DoctorIntegrityResult) => expect(check(result, "migrations").status).toBe("fail"),
    },
    {
      name: "insecure permissions",
      mutate: async (fixture: Fixture) => {
        await chmod(fixture.blobDirectory, 0o755);
      },
      expected: (result: DoctorIntegrityResult) => expect(check(result, "permissions").status).toBe("fail"),
    },
  ] satisfies readonly Readonly<{
    readonly name: string;
    readonly mutate: (fixture: Fixture) => Promise<void>;
    readonly expected: (result: DoctorIntegrityResult) => void;
  }>[];

  for (const fixtureCase of cases) {
    test(`diagnoses ${fixtureCase.name} without writing`, async () => {
      const fixture = await makeFixture();
      await fixtureCase.mutate(fixture);
      const result = await assertReadOnly(fixture, () => doctor(fixture));
      expect(result.status).toBe("unhealthy");
      fixtureCase.expected(result);
    });
  }

  test("diagnoses a size mismatch from the immutable authoritative reference", async () => {
    const fixture = await makeFixture(bodyBytes.byteLength + 1);
    const result = await assertReadOnly(fixture, () => doctor(fixture));
    expect(result.status).toBe("unhealthy");
    expect(check(result, "blobs").evidence[0]?.detail).toContain("size mismatch");
  });
});
