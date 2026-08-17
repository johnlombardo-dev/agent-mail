import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { promoteBlob, BlobPromotionError } from "../src/blob-promotion";
import { stageBlob } from "../src/blob-stage";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-mail-blob-promotion-p2-c07-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("blob promotion P2-C07", () => {
  test("races identical stages and leaves one verified canonical blob with no stages", async () => {
    const directory = await temporaryDirectory();
    const bytes = new TextEncoder().encode("same content wins once\n");
    const digest = digestOf(bytes);
    const [first, second] = await Promise.all([
      stageBlob({ stagingDirectory: directory, source: (async function* () { yield bytes; })() }),
      stageBlob({ stagingDirectory: directory, source: (async function* () { yield bytes; })() }),
    ]);

    const results = await Promise.all([
      promoteBlob({ stagingPath: first.path, canonicalDirectory: directory, digest: first.digest, size: first.size }),
      promoteBlob({ stagingPath: second.path, canonicalDirectory: directory, digest: second.digest, size: second.size }),
    ]);

    expect(results.map((result) => result.deduplicated).sort()).toEqual([false, true]);
    expect(await readFile(join(directory, digest))).toEqual(bytes);
    expect(await readdir(directory)).toEqual([digest]);
  });

  test("interrupts immediately before publication without creating a canonical path", async () => {
    const directory = await temporaryDirectory();
    const bytes = new TextEncoder().encode("publication is interrupted\n");
    const staged = await stageBlob({ stagingDirectory: directory, source: (async function* () { yield bytes; })() });
    const interruption = new Error("injected interruption");

    await expect(
      promoteBlob({
        stagingPath: staged.path,
        canonicalDirectory: directory,
        digest: staged.digest,
        size: staged.size,
        beforePublish: () => { throw interruption; },
      }),
    ).rejects.toMatchObject({ name: "BlobPromotionError", code: "publication-interrupted", cause: interruption });
    expect(await readdir(directory)).toEqual([staged.path.slice(directory.length + 1)]);
    await expect(readFile(join(directory, staged.digest))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects an existing same-name file with different bytes and preserves evidence", async () => {
    const directory = await temporaryDirectory();
    const bytes = new TextEncoder().encode("the valid staged bytes\n");
    const staged = await stageBlob({ stagingDirectory: directory, source: (async function* () { yield bytes; })() });
    const corrupt = new TextEncoder().encode("different bytes under the digest name\n");
    const canonicalPath = join(directory, staged.digest);
    await writeFile(canonicalPath, corrupt, { mode: 0o600 });

    const failure = await promoteBlob({
      stagingPath: staged.path,
      canonicalDirectory: directory,
      digest: staged.digest,
      size: staged.size,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BlobPromotionError);
    expect(failure).toMatchObject({ code: "canonical-corrupt" });
    expect(await readFile(canonicalPath)).toEqual(corrupt);
    expect(await readFile(staged.path)).toEqual(bytes);
  });

  test("syncs separate canonical and staging directories and retries after cleanup-sync failure", async () => {
    const root = await temporaryDirectory();
    const stagingDirectory = join(root, "staging");
    const canonicalDirectory = join(root, "canonical");
    await Promise.all([mkdir(stagingDirectory), mkdir(canonicalDirectory)]);
    const bytes = new TextEncoder().encode("durable publication with recoverable cleanup\n");
    const staged = await stageBlob({
      stagingDirectory,
      source: (async function* () { yield bytes; })(),
    });
    const syncSteps: string[] = [];
    let failStagingSync = true;
    const syncDirectory = async (directory: string, step: "canonical-publication" | "staging-cleanup") => {
      syncSteps.push(`${step}:${directory === canonicalDirectory ? "canonical" : "staging"}`);
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (step === "staging-cleanup" && failStagingSync) {
        failStagingSync = false;
        throw new Error("injected staging cleanup sync failure");
      }
    };

    const firstFailure = await promoteBlob({
      stagingPath: staged.path,
      canonicalDirectory,
      digest: staged.digest,
      size: staged.size,
      syncDirectory,
    }).catch((error: unknown) => error);

    expect(firstFailure).toMatchObject({
      code: "directory-sync-failed",
      step: "staging-cleanup",
    });
    expect(firstFailure).toMatchObject({ message: "staging cleanup directory could not be fsynced" });
    expect(String(firstFailure)).not.toContain(root);
    expect(await readFile(join(canonicalDirectory, staged.digest))).toEqual(bytes);
    await expect(readFile(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(stagingDirectory, { recursive: true });

    const retry = await promoteBlob({
      stagingPath: staged.path,
      canonicalDirectory,
      digest: staged.digest,
      size: staged.size,
      syncDirectory,
    });

    expect(retry).toMatchObject({ canonicalPath: join(canonicalDirectory, staged.digest), deduplicated: true });
    expect(syncSteps).toEqual([
      "canonical-publication:canonical",
      "staging-cleanup:staging",
    ]);
  });
});
