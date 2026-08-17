import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { stageBlob } from "../src/blob-stage";

const temporaryDirectories: string[] = [];

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

    const result = await stageBlob({ stagingDirectory: directory, source: source(), maxBytes: expected.byteLength });
    expect(result.size).toBe(expected.byteLength);
    expect(result.digest).toBe(digestOf(expected));
    expect(await readFile(result.path)).toEqual(expected);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).sort()).toEqual([result.path.slice(directory.length + 1)]);
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

    const result = await stageBlob({ stagingDirectory: directory, source });
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

    await expect(stageBlob({ stagingDirectory: directory, source: source() })).rejects.toBe(sourceFailure);
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
      stageBlob({ stagingDirectory: directory, source: source(), maxBytes: 3, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(directory)).toEqual([]);

    await expect(
      stageBlob({ stagingDirectory: directory, source: (async function* () { yield new Uint8Array([1, 2, 3, 4]); })(), maxBytes: 3 }),
    ).rejects.toThrow("exceeds maxBytes");
    expect(await readdir(directory)).toEqual([]);
  });
});
