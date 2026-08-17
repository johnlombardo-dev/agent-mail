import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BlobCorruptionError, quarantineAndReplaceBlob } from "../src/blob-corruption";
import { stageBlob } from "../src/blob-stage";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-mail-blob-corruption-p2-c08-"));
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

async function replacement(directory: string, bytes: Uint8Array) {
  return stageBlob({
    stagingDirectory: directory,
    owner: { pid: 9001, processStartIdentity: "p2-c08-test" },
    source: (async function* () {
      yield bytes;
    })(),
  });
}

describe("blob corruption quarantine P2-C08", () => {
  test("quarantines wrong-size canonical bytes and publishes a verified replacement", async () => {
    const directory = await temporaryDirectory();
    const expectedBytes = new TextEncoder().encode("the replacement is valid\n");
    const expectedDigest = digestOf(expectedBytes);
    const corruptBytes = new TextEncoder().encode("wrong-size");
    const canonicalPath = join(directory, expectedDigest);
    const staged = await replacement(directory, expectedBytes);
    await writeFile(canonicalPath, corruptBytes, { mode: 0o600 });

    const result = await quarantineAndReplaceBlob({
      stagingPath: staged.path,
      canonicalDirectory: directory,
      digest: expectedDigest,
      size: expectedBytes.byteLength,
    });

    expect(result.expected).toEqual({ digest: expectedDigest, size: expectedBytes.byteLength });
    expect(result.observed).toEqual({ digest: digestOf(corruptBytes), size: corruptBytes.byteLength });
    expect(await readFile(result.quarantinePath)).toEqual(corruptBytes);
    expect(await readFile(canonicalPath)).toEqual(expectedBytes);
    expect(new Set(await readdir(directory))).toEqual(
      new Set([expectedDigest, result.quarantinePath.slice(directory.length + 1)]),
    );
    expect(result.promotion).toMatchObject({ canonicalPath, digest: expectedDigest, size: expectedBytes.byteLength });
  });

  test("quarantines a same-size digest mismatch instead of deduplicating", async () => {
    const directory = await temporaryDirectory();
    const expectedBytes = new TextEncoder().encode("valid bytes with known size\n");
    const corruptBytes = new TextEncoder().encode("wrong bytes with known size\n");
    expect(corruptBytes.byteLength).toBe(expectedBytes.byteLength);
    const expectedDigest = digestOf(expectedBytes);
    const staged = await replacement(directory, expectedBytes);
    const canonicalPath = join(directory, expectedDigest);
    await writeFile(canonicalPath, corruptBytes, { mode: 0o600 });

    const result = await quarantineAndReplaceBlob({
      stagingPath: staged.path,
      canonicalDirectory: directory,
      digest: expectedDigest,
      size: expectedBytes.byteLength,
    });

    expect(result.observed).toEqual({ digest: digestOf(corruptBytes), size: expectedBytes.byteLength });
    expect(await readFile(result.quarantinePath)).toEqual(corruptBytes);
    expect(await readFile(canonicalPath)).toEqual(expectedBytes);
  });

  test("leaves corrupt canonical bytes and replacement stage untouched when quarantine rename fails", async () => {
    const directory = await temporaryDirectory();
    const expectedBytes = new TextEncoder().encode("replacement survives a failed quarantine\n");
    const corruptBytes = new TextEncoder().encode("corrupt canonical bytes survive\n");
    const expectedDigest = digestOf(expectedBytes);
    const staged = await replacement(directory, expectedBytes);
    const canonicalPath = join(directory, expectedDigest);
    await writeFile(canonicalPath, corruptBytes, { mode: 0o600 });
    const renameFailure = new Error("injected rename failure");

    const failure = await quarantineAndReplaceBlob({
      stagingPath: staged.path,
      canonicalDirectory: directory,
      digest: expectedDigest,
      size: expectedBytes.byteLength,
      renamePath: () => {
        throw renameFailure;
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BlobCorruptionError);
    expect(failure).toMatchObject({
      code: "quarantine-failed",
      cause: renameFailure,
      canonicalPath,
      expected: { digest: expectedDigest, size: expectedBytes.byteLength },
      observed: { digest: digestOf(corruptBytes), size: corruptBytes.byteLength },
    });
    expect(await readFile(canonicalPath)).toEqual(corruptBytes);
    expect(await readFile(staged.path)).toEqual(expectedBytes);
    expect(new Set(await readdir(directory))).toEqual(
      new Set([expectedDigest, staged.path.slice(directory.length + 1)]),
    );
  });

  test("fails the losing same-path quarantine race closed", async () => {
    const directory = await temporaryDirectory();
    const expectedBytes = new TextEncoder().encode("one replacement wins the canonical race\n");
    const corruptBytes = new TextEncoder().encode("corrupt bytes are retained\n");
    const expectedDigest = digestOf(expectedBytes);
    const [firstStage, secondStage] = await Promise.all([
      replacement(directory, expectedBytes),
      replacement(directory, expectedBytes),
    ]);
    const canonicalPath = join(directory, expectedDigest);
    await writeFile(canonicalPath, corruptBytes, { mode: 0o600 });

    const outcomes = await Promise.all(
      [firstStage, secondStage].map((staged) =>
        quarantineAndReplaceBlob({
          stagingPath: staged.path,
          canonicalDirectory: directory,
          digest: expectedDigest,
          size: expectedBytes.byteLength,
        }).catch((error: unknown) => error),
      ),
    );

    expect(outcomes.filter((outcome) => outcome instanceof BlobCorruptionError)).toHaveLength(1);
    expect(outcomes).toContainEqual(expect.objectContaining({ code: "canonical-already-verified" }));
    expect(await readFile(canonicalPath)).toEqual(expectedBytes);
    expect((await readdir(directory)).filter((name) => name.startsWith(".quarantine-v1-"))).toHaveLength(1);
    expect((await readdir(directory)).filter((name) => name.startsWith(".stage-v1-"))).toHaveLength(1);
  });
});
