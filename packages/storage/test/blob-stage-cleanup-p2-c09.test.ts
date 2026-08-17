import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupAbandonedBlobStages, type BlobStageProcessObservation } from "../src/blob-stage-cleanup";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function digest(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function stageName(pid: number, identity: string, random: string): string {
  return `.stage-v1-pid${pid}-owner${digest(identity)}-random${random.repeat(64 / random.length)}.tmp`;
}

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-mail-blob-stage-cleanup-p2-c09-"));
  directories.push(value);
  return value;
}

describe("blob staging cleanup P2-C09", () => {
  test("removes only dead and PID-reused regular stages in one real directory scan", async () => {
    const stagingDirectory = await directory();
    const dead = stageName(1001, "dead-owner", "a");
    const reused = stageName(1002, "old-owner", "b");
    const matchingLive = stageName(1003, "live-owner", "c");
    const unknown = stageName(1004, "unknown-owner", "d");
    const malformed = ".stage-v2-pid1005-owner" + "e".repeat(64) + "-random" + "f".repeat(64) + ".tmp";
    const canonical = "1".repeat(64);
    const quarantine = `.quarantine-v1-${"2".repeat(64)}-${"3".repeat(32)}.blob`;
    const unrelated = "notes.txt";

    await Promise.all([
      writeFile(join(stagingDirectory, dead), "dead"),
      writeFile(join(stagingDirectory, reused), "reused"),
      writeFile(join(stagingDirectory, matchingLive), "live"),
      writeFile(join(stagingDirectory, unknown), "unknown"),
      writeFile(join(stagingDirectory, malformed), "malformed"),
      writeFile(join(stagingDirectory, canonical), "canonical"),
      writeFile(join(stagingDirectory, quarantine), "quarantine"),
      writeFile(join(stagingDirectory, unrelated), "unrelated"),
    ]);
    const symlinkName = stageName(1006, "symlink-owner", "e");
    const external = join(stagingDirectory, "..", `${basename(stagingDirectory)}-outside`);
    await writeFile(external, "outside");
    directories.push(external);
    await symlink(external, join(stagingDirectory, symlinkName));
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(join(stagingDirectory, matchingLive), old, old);

    const observations = new Map<number, BlobStageProcessObservation>([
      [1001, { kind: "not-live" }],
      [1002, { kind: "live", processStartIdentity: "new-owner" }],
      [1003, { kind: "live", processStartIdentity: "live-owner" }],
      [1004, { kind: "unknown", reason: "permission denied" }],
      [1006, { kind: "not-live" }],
    ]);
    const result = await cleanupAbandonedBlobStages({
      stagingDirectory,
      inspectProcess: async (pid) => observations.get(pid) ?? { kind: "unknown", reason: "unmapped" },
    });

    expect(result.directorySync).toBe("synced");
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { name: dead, reason: "removed-dead-owner" },
        { name: reused, reason: "removed-pid-reuse" },
        { name: matchingLive, reason: "preserved-live-owner" },
        { name: unknown, reason: "preserved-unknown-owner" },
        { name: malformed, reason: "preserved-malformed-name" },
        { name: canonical, reason: "preserved-canonical-name" },
        { name: quarantine, reason: "preserved-quarantine-name" },
        { name: unrelated, reason: "preserved-unknown-name" },
        { name: symlinkName, reason: "preserved-non-regular" },
      ]),
    );
    expect(await readdir(stagingDirectory)).toEqual(
      expect.arrayContaining([matchingLive, unknown, malformed, canonical, quarantine, unrelated, symlinkName]),
    );
    expect(await lstat(join(stagingDirectory, symlinkName))).toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect(await lstat(external)).toMatchObject({ isFile: expect.any(Function) });
  });

  test("preserves a recognized regular stage when process inspection errors", async () => {
    const stagingDirectory = await directory();
    const name = stageName(2001, "owner", "a");
    await writeFile(join(stagingDirectory, name), "bytes");
    const result = await cleanupAbandonedBlobStages({
      stagingDirectory,
      inspectProcess: async () => {
        throw new Error("probe failed");
      },
    });
    expect(result).toEqual({
      entries: [{ name, reason: "preserved-process-inspection-error" }],
      directorySync: "not-needed",
    });
  });

  test("does not follow recognized stage symlinks", async () => {
    const stagingDirectory = await directory();
    const targetDirectory = join(stagingDirectory, "target");
    await mkdir(targetDirectory);
    const name = stageName(3001, "owner", "a");
    await symlink(targetDirectory, join(stagingDirectory, name));
    const result = await cleanupAbandonedBlobStages({
      stagingDirectory,
      inspectProcess: async () => ({ kind: "not-live" }),
    });
    expect(result.entries).toEqual([
      { name, reason: "preserved-non-regular" },
      { name: "target", reason: "preserved-unknown-name" },
    ]);
    expect(await readdir(targetDirectory)).toEqual([]);
    await chmod(targetDirectory, 0o700);
  });
});
