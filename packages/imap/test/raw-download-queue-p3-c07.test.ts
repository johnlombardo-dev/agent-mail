import { describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createRemoteUid,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import {
  createRawMessageDownloadQueueActor,
  RawDownloadQueueBackpressureError,
  RawDownloadQueueCancelledError,
} from "../src/raw-download-queue";
import type { RawMessageDownloadAdapter, RawMessageDownloadRequest } from "../src/raw-download";

const REQUEST_BASE = {
  accountId: createAccountId("queue-test"),
  mailboxId: createMailboxId("inbox"),
  uidValidity: createUidValidity(9),
  stagingDirectory: "/tmp/agent-mail-queue-test",
  owner: { pid: 1, processStartIdentity: "queue-test-start" },
};

function request(uid: number): RawMessageDownloadRequest {
  return { ...REQUEST_BASE, uid: createRemoteUidValue(uid) };
}

function resultFor(input: RawMessageDownloadRequest) {
  return {
    identity: createRemoteUid(input),
    staged: { path: `/tmp/stage-${input.uid}`, digest: `digest-${input.uid}`, size: input.uid },
  };
}

async function tick(): Promise<void> {
  await Bun.sleep(0);
}

describe("raw download queue actor", () => {
  test("serializes FIFO jobs and rejects overflow at the configured capacity", async () => {
    const starts: number[] = [];
    const finishes: number[] = [];
    const releases: Array<() => void> = [];
    const adapter: RawMessageDownloadAdapter = {
      download: async (input) => {
        const uid = input.uid;
        starts.push(uid);
        await new Promise<void>((resolve) => releases.push(resolve));
        finishes.push(uid);
        return resultFor(input);
      },
    };
    const queue = createRawMessageDownloadQueueActor(adapter, { capacity: 2 });
    const first = queue.enqueue(request(1));
    const second = queue.enqueue(request(2));
    const overflow = queue.enqueue(request(3));
    await expect(overflow.result).rejects.toBeInstanceOf(RawDownloadQueueBackpressureError);
    await tick();
    expect(starts).toEqual([1]);
    releases.shift()?.();
    await first.result;
    await tick();
    expect(starts).toEqual([1, 2]);
    releases.shift()?.();
    await second.result;
    expect(finishes).toEqual([1, 2]);
    await queue.stop();
  });

  test("queued cancellation rejects only that job and active cancellation waits for cleanup", async () => {
    const events: string[] = [];
    let releaseActive: (() => void) | undefined;
    const adapter: RawMessageDownloadAdapter = {
      download: async (input) => {
        if (input.uid === 1) {
          await new Promise<void>((resolve) => {
            releaseActive = resolve;
            input.signal?.addEventListener("abort", () => events.push("adapter.abort"), { once: true });
          });
          events.push("stage.cleanup");
        }
        return resultFor(input);
      },
    };
    const queue = createRawMessageDownloadQueueActor(adapter, { capacity: 3 });
    const active = queue.enqueue(request(1));
    const queued = queue.enqueue(request(2));
    await tick();
    queue.cancel(queued.id);
    await expect(queued.result).rejects.toMatchObject({
      code: "raw-download-queue-cancelled",
      jobId: queued.id,
    } satisfies Partial<RawDownloadQueueCancelledError>);

    queue.cancel(active.id);
    await tick();
    expect(events).toEqual(["adapter.abort"]);
    let cancelled = false;
    const activeResult = active.result.catch((error: unknown) => {
      cancelled = error instanceof RawDownloadQueueCancelledError;
    });
    await tick();
    expect(cancelled).toBe(false);
    releaseActive?.();
    await activeResult;
    expect(events).toEqual(["adapter.abort", "stage.cleanup"]);
    await queue.stop();
  });

  test("stop waits for an active adapter that acknowledges abort only after stage cleanup", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const adapter: RawMessageDownloadAdapter = {
      download: async (input) => {
        await new Promise<void>((resolve) => {
          release = resolve;
          input.signal?.addEventListener("abort", () => events.push("adapter.abort"), { once: true });
        });
        events.push("stage.cleanup");
        return resultFor(input);
      },
    };
    const queue = createRawMessageDownloadQueueActor(adapter, { capacity: 1 });
    const active = queue.enqueue(request(4));
    await tick();
    let stopped = false;
    const stop = queue.stop().then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(false);
    expect(events).toEqual(["adapter.abort"]);
    release?.();
    await stop;
    expect(events).toEqual(["adapter.abort", "stage.cleanup"]);
    await expect(active.result).rejects.toMatchObject({ code: "raw-download-queue-cancelled" });
  });

  test("rejects late enqueues after stop has begun while the active adapter is closing", async () => {
    let release: (() => void) | undefined;
    const adapter: RawMessageDownloadAdapter = {
      download: async (input) => {
        await new Promise<void>((resolve) => {
          release = resolve;
          input.signal?.addEventListener("abort", () => undefined, { once: true });
        });
        return resultFor(input);
      },
    };
    const queue = createRawMessageDownloadQueueActor(adapter, { capacity: 2 });
    const active = queue.enqueue(request(5));
    await tick();
    const stop = queue.stop();
    const late = queue.enqueue(request(6));
    await expect(late.result).rejects.toMatchObject({ code: "raw-download-queue-stopped" });
    release?.();
    await stop;
    await expect(active.result).rejects.toMatchObject({ code: "raw-download-queue-cancelled" });
  });
});
