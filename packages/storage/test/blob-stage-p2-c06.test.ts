import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseBlobStageFilename, stageBlob, type BlobStageOwner } from "../src/blob-stage";

const temporaryDirectories: string[] = [];
const OWNER: BlobStageOwner = {
  pid: 43127,
  processStartIdentity: "launchd-start-2026-08-18T04:12:09.123Z",
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-mail-blob-stage-p2-c06-"));
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

describe("blob staging P2-C06", () => {
  test("streams async chunks, hashes exact bytes, and closes a private mode file", async () => {
    const directory = await temporaryDirectory();
    const chunks = [new TextEncoder().encode("first\n"), new Uint8Array([0, 255, 1]), new TextEncoder().encode("last")];
    const expected = Buffer.concat(chunks);

    async function* source(): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield chunk;
    }

    const result = await stageBlob({
      stagingDirectory: directory,
      owner: OWNER,
      source: source(),
      maxBytes: expected.byteLength,
    });
    expect(result.size).toBe(expected.byteLength);
    expect(result.digest).toBe(digestOf(expected));
    expect(await readFile(result.path)).toEqual(expected);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).sort()).toEqual([result.path.slice(directory.length + 1)]);
    expect(parseBlobStageFilename(basename(result.path))).toEqual({
      version: 1,
      pid: OWNER.pid,
      identityDigest: digestOf(new TextEncoder().encode(OWNER.processStartIdentity)),
      randomStageIdentity: expect.any(String),
    });
  });

  test("consumes a ReadableStream without buffering the source", async () => {
    const directory = await temporaryDirectory();
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const result = await stageBlob({ stagingDirectory: directory, owner: OWNER, source });
    expect(await readFile(result.path)).toEqual(Buffer.concat(chunks));
    expect(result.size).toBe(5);
  });

  test("removes a partial file when the source throws", async () => {
    const directory = await temporaryDirectory();
    const sourceFailure = new Error("source failed");

    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([9, 8, 7]);
      throw sourceFailure;
    }

    await expect(stageBlob({ stagingDirectory: directory, owner: OWNER, source: source() })).rejects.toBe(sourceFailure);
    expect(await readdir(directory)).toEqual([]);
  });

  test("removes a partial file on abort and rejects overflow before writing its chunk", async () => {
    const directory = await temporaryDirectory();
    const controller = new AbortController();

    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      controller.abort();
      yield new Uint8Array([4]);
    }

    await expect(
      stageBlob({
        stagingDirectory: directory,
        owner: OWNER,
        source: source(),
        maxBytes: 3,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(directory)).toEqual([]);

    await expect(
      stageBlob({
        stagingDirectory: directory,
        owner: OWNER,
        source: (async function* () {
          yield new Uint8Array([1, 2, 3, 4]);
        })(),
        maxBytes: 3,
      }),
    ).rejects.toThrow("exceeds maxBytes");
    expect(await readdir(directory)).toEqual([]);
  });

  test("rejects invalid owner metadata before creating a stage artifact", async () => {
    const directory = await temporaryDirectory();
    const invalidOwners: readonly BlobStageOwner[] = [
      { pid: 0, processStartIdentity: OWNER.processStartIdentity },
      { pid: Number.NaN, processStartIdentity: OWNER.processStartIdentity },
      { pid: OWNER.pid, processStartIdentity: "" },
      { pid: OWNER.pid, processStartIdentity: " identity-with-leading-space" },
    ];

    for (const owner of invalidOwners) {
      await expect(
        stageBlob({
          stagingDirectory: directory,
          owner,
          source: (async function* () {
            yield new Uint8Array([1]);
          })(),
        }),
      ).rejects.toThrow();
    }
    expect(await readdir(directory)).toEqual([]);
  });

  test("does not parse unknown, malformed, or near-match stage filenames", () => {
    const valid = `.stage-v1-pid${OWNER.pid}-owner${"a".repeat(64)}-random${"b".repeat(64)}.tmp`;
    const malformed = [
      "unrelated.tmp",
      valid.replace("v1", "v2"),
      valid.replace(`pid${OWNER.pid}`, `pid0${OWNER.pid}`),
      valid.replace("a".repeat(64), "A".repeat(64)),
      valid.replace("b".repeat(64), "b".repeat(63)),
      `${valid}.bak`,
      `/private/tmp/${valid}`,
    ];

    expect(parseBlobStageFilename(valid)).toEqual({
      version: 1,
      pid: OWNER.pid,
      identityDigest: "a".repeat(64),
      randomStageIdentity: "b".repeat(64),
    });
    for (const filename of malformed) expect(parseBlobStageFilename(filename)).toBeUndefined();
  });
});
