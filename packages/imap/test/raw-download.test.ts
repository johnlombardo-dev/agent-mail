import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import { stageBlob } from "../../storage/src/blob-stage";
import {
  IMAP_RAW_MESSAGE_IDENTITY_QUERY,
  MAX_RAW_MESSAGE_BYTES,
  createRawMessageDownloadAdapter,
  parseRawMessageDownloadRequest,
  type ImapFlowRawMessageDownloadClient,
  type RawMessageDownloadRequest,
} from "../src/raw-download";
import {
  runAdapterContractParity,
  type AdapterContractSuite,
} from "../../../tests/adapter-contracts/harness";
import productionFixture from "./fixtures/raw-download-production-labeled.json";

const OWNER = { pid: 43127, processStartIdentity: "launchd-start-2026-08-18T04:12:09.123Z" };
const requestIdentity = {
  accountId: createAccountId(productionFixture.identity.accountId),
  mailboxId: createMailboxId(productionFixture.identity.mailboxId),
  uidValidity: createUidValidity(productionFixture.identity.uidValidity),
  uid: createRemoteUidValue(productionFixture.identity.uid),
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function stagingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-mail-raw-download-p3-c06-"));
  temporaryDirectories.push(directory);
  return directory;
}

function bytes(): Uint8Array[] {
  return productionFixture.chunks.map((chunk) => Uint8Array.from(Buffer.from(chunk, "base64")));
}

function digest(chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

type TrackedStream = AsyncIterable<Uint8Array> & {
  readonly destroyed: boolean;
  destroy(reason?: unknown): void;
};

function trackedStream(chunks: readonly Uint8Array[], waitAfterFirst = false): TrackedStream {
  let index = 0;
  let destroyed = false;
  let release: (() => void) | undefined;
  const iterator: AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> = {
    async next() {
      if (destroyed) return { done: true, value: undefined };
      if (waitAfterFirst && index === 1) await new Promise<void>((resolve) => (release = resolve));
      const chunk = chunks[index];
      if (chunk === undefined) return { done: true, value: undefined };
      index += 1;
      return { done: false, value: chunk };
    },
    async return() {
      destroyed = true;
      release?.();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    get destroyed() {
      return destroyed;
    },
    destroy() {
      destroyed = true;
      release?.();
    },
  };
}

function delayedProductionStream(chunks: readonly Uint8Array[]): Readable {
  let release: (() => void) | undefined;
  const source = (async function* () {
    const first = chunks[0];
    if (first !== undefined) yield first;
    await new Promise<void>((resolve) => (release = resolve));
    for (const chunk of chunks.slice(1)) yield chunk;
  })();
  const stream = Readable.from(source);
  stream.once("close", () => release?.());
  return stream;
}

function requestFor(directory: string, signal?: AbortSignal): RawMessageDownloadRequest {
  return {
    ...requestIdentity,
    stagingDirectory: directory,
    owner: OWNER,
    ...(signal === undefined ? {} : { signal }),
  };
}

function clientFor(
  content: AsyncIterable<Uint8Array>,
  options: Readonly<{
    readonly uid?: number;
    readonly includeUid?: boolean;
    readonly expectedSize?: number;
    readonly maxBytes?: number;
  }> = {},
): ImapFlowRawMessageDownloadClient {
  return {
    async download(range, part, downloadOptions): Promise<unknown> {
      expect(range).toBe(String(requestIdentity.uid));
      expect(part).toBeUndefined();
      expect(downloadOptions).toEqual({ uid: true, maxBytes: options.maxBytes ?? MAX_RAW_MESSAGE_BYTES });
      return {
        ...(options.includeUid === false ? {} : { uid: options.uid ?? requestIdentity.uid }),
        meta: {
          expectedSize:
            options.expectedSize ?? bytes().reduce((total, chunk) => total + chunk.byteLength, 0),
        },
        content,
      };
    },
  };
}

function adapterFor(client: ImapFlowRawMessageDownloadClient, maxBytes = MAX_RAW_MESSAGE_BYTES) {
  return createRawMessageDownloadAdapter(client, stageBlob, { maxBytes });
}

describe("single raw IMAP download into blob staging", () => {
  test("rejects malformed unknown request data before contacting IMAP", () => {
    expect(() => parseRawMessageDownloadRequest({ ...requestIdentity, owner: OWNER })).toThrow(
      "missing stagingDirectory",
    );
    expect(() => parseRawMessageDownloadRequest({
      ...requestFor("/tmp/stages"),
      extra: true,
    })).toThrow("unknown fields");
  });

  test("uses the metadata-only identity probe without requesting body bytes", async () => {
    const directory = await stagingDirectory();
    const calls: unknown[] = [];
    const client: ImapFlowRawMessageDownloadClient = {
      async fetchOne(range, query, options): Promise<unknown> {
        calls.push({ kind: "fetchOne", range, query, options });
        return { seq: 9, uid: requestIdentity.uid, size: 3 };
      },
      async download(range, part, options): Promise<unknown> {
        calls.push({ kind: "download", range, part, options });
        return { meta: { expectedSize: 3 }, content: (async function* () { yield new Uint8Array([1, 2, 3]); })() };
      },
    };
    const result = await adapterFor(client).download(requestFor(directory));
    expect(result.identity).toEqual(requestIdentity);
    expect(calls).toEqual([
      { kind: "fetchOne", range: "42", query: IMAP_RAW_MESSAGE_IDENTITY_QUERY, options: { uid: true } },
      { kind: "download", range: "42", part: undefined, options: { uid: true, maxBytes: MAX_RAW_MESSAGE_BYTES } },
    ]);
  });

  test("enforces advertised size and removes the stage when the stream is short or long", async () => {
    const shortDirectory = await stagingDirectory();
    await expect(
      adapterFor(clientFor((async function* () { yield new Uint8Array([1]); })(), { expectedSize: 2 })).download(
        requestFor(shortDirectory),
      ),
    ).rejects.toThrow("ended before");
    expect(await readdir(shortDirectory)).toEqual([]);

    const longDirectory = await stagingDirectory();
    await expect(
      adapterFor(clientFor((async function* () { yield new Uint8Array([1, 2, 3]); })(), { expectedSize: 2 })).download(
        requestFor(longDirectory),
      ),
    ).rejects.toThrow("exceeded");
    expect(await readdir(longDirectory)).toEqual([]);
  });

  test("rejects a message over the fixed stage budget before creating a file", async () => {
    const directory = await stagingDirectory();
    const stream = trackedStream([new Uint8Array([1, 2, 3])]);
    await expect(
      adapterFor(clientFor(stream, { expectedSize: 3, maxBytes: 2 }), 2).download(requestFor(directory)),
    ).rejects.toThrow("exceeds 2 bytes");
    expect(stream.destroyed).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  test("propagates provider failure and leaves no reusable stage", async () => {
    const directory = await stagingDirectory();
    const providerFailure = new Error("provider stream failed");
    async function* failingSource() {
      yield new Uint8Array([1]);
      throw providerFailure;
    }
    await expect(
      adapterFor(clientFor(failingSource(), { expectedSize: 1 })).download(requestFor(directory)),
    ).rejects.toBe(providerFailure);
    expect(await readdir(directory)).toEqual([]);
  });

  test("rejects a wrong UID even when its bytes are valid and closes the response", async () => {
    const directory = await stagingDirectory();
    const stream = trackedStream(bytes());
    await expect(
      adapterFor(clientFor(stream, { uid: 43 })).download(requestFor(directory)),
    ).rejects.toThrow("does not match");
    expect(stream.destroyed).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  test("fails closed when neither probe nor download response verifies the UID", async () => {
    const directory = await stagingDirectory();
    const stream = trackedStream(bytes());
    await expect(
      adapterFor(clientFor(stream, { includeUid: false })).download(requestFor(directory)),
    ).rejects.toThrow("no verified UID evidence");
    expect(stream.destroyed).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  for (const [kind, contentFactory] of [
    ["fake", () => trackedStream(bytes(), true)],
    ["production-shaped", () => delayedProductionStream(bytes())],
  ] as const) {
    test(`${kind} stream abort closes network content and removes the stage`, async () => {
      const directory = await stagingDirectory();
      const controller = new AbortController();
      const content = contentFactory();
      const promise = adapterFor(clientFor(content)).download(requestFor(directory, controller.signal));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
      if ("destroyed" in content) expect(content.destroyed).toBe(true);
      expect(await readdir(directory)).toEqual([]);
    });
  }
});

type ContractAdapter = Readonly<{ adapter: ReturnType<typeof adapterFor>; request: RawMessageDownloadRequest }>;

const contractSuite: AdapterContractSuite<ContractAdapter> = {
  name: "captured IMAP raw download fake-versus-production stream parity",
  cases: [
    {
      id: "multi-chunk-raw-message",
      run: async ({ adapter, request }) => {
        const result = await adapter.download(request);
        const expected = bytes();
        expect(result.identity).toEqual(requestIdentity);
        expect(result.staged).toMatchObject({ size: expected.reduce((total, chunk) => total + chunk.byteLength, 0), digest: digest(expected) });
        expect(await readFile(result.staged.path)).toEqual(Buffer.concat(expected));
      },
    },
  ],
};

test("runs the same multi-chunk contract against fake and captured production-shaped streams", async () => {
  const evidence = await runAdapterContractParity({
    suite: contractSuite,
    fake: {
      factory: async (): Promise<ContractAdapter> => {
        const directory = await stagingDirectory();
        return { adapter: adapterFor(clientFor(trackedStream(bytes()))), request: requestFor(directory) };
      },
      capabilities: [{ name: "streamed-raw-download", status: "available" }],
    },
    production: {
      factory: async (): Promise<ContractAdapter> => {
        const directory = await stagingDirectory();
        const fixtureBytes = productionFixture.chunks.map((chunk) => Buffer.from(chunk, "base64"));
        return { adapter: adapterFor(clientFor(Readable.from(fixtureBytes))), request: requestFor(directory) };
      },
      capabilities: [{ name: "streamed-raw-download", status: "available" }],
      retainedEvidencePath: "packages/imap/test/fixtures/raw-download-production-labeled.json",
    },
  });
  expect(evidence.fake.status).toBe("passed");
  expect(evidence.production?.status).toBe("passed");
  expect(evidence.semanticParity.status).toBe("matched");
});
