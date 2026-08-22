import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType, read } from "bun:ffi";
import {
  activeDemoImapTestPortLeases,
  demoImapTestPortLeaseExists,
  leaseDemoImapTestPort,
  type DemoImapTestPort,
} from "../src/demo/imap";

const leaseChild = join(import.meta.dir, "helpers/demo-imap-port-lease-child.ts");
const STRESS_WORKERS = 32;
const STRESS_ROUNDS = 100;

type WorkerMessage =
  | Readonly<{ readonly kind: "ready"; readonly worker: string }>
  | Readonly<{
      readonly kind: "result";
      readonly worker: string;
      readonly round: number;
      readonly acquired: boolean;
      readonly pid: number;
    }>
  | Readonly<{ readonly kind: "released"; readonly worker: string; readonly round: number }>
  | Readonly<{ readonly kind: "error"; readonly worker: string; readonly detail: string }>;

type StressWorker = Readonly<{
  readonly worker: string;
  readonly contend: (round: number) => Promise<Extract<WorkerMessage, { kind: "result" }>>;
  readonly release: (round: number) => Promise<void>;
  readonly stop: () => Promise<void>;
}>;

function parseWorkerMessage(value: unknown): WorkerMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("lease worker returned a non-object message");
  }
  const kind = Reflect.get(value, "kind");
  const worker = Reflect.get(value, "worker");
  if (typeof worker !== "string" || !/^\d{1,2}$/u.test(worker)) {
    throw new Error("lease worker returned an invalid identity");
  }
  if (kind === "ready") return Object.freeze({ kind, worker });
  if (kind === "error") {
    const detail = Reflect.get(value, "detail");
    if (typeof detail !== "string") throw new Error("lease worker returned an invalid error");
    return Object.freeze({ kind, worker, detail });
  }
  const round = Reflect.get(value, "round");
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 0 || round > 100) {
    throw new Error("lease worker returned an invalid round");
  }
  if (kind === "released") return Object.freeze({ kind, worker, round });
  if (kind === "result") {
    const acquired = Reflect.get(value, "acquired");
    const pid = Reflect.get(value, "pid");
    if (
      typeof acquired !== "boolean" ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    ) {
      throw new Error("lease worker returned an invalid result");
    }
    return Object.freeze({ kind, worker, round, acquired, pid });
  }
  throw new Error("lease worker returned an unknown message");
}

async function spawnStressWorker(
  directory: string,
  port: DemoImapTestPort,
  worker: string,
): Promise<StressWorker> {
  const buffered: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  const child = Bun.spawn(
    [process.execPath, leaseChild, directory, String(port), "worker", worker],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      ipc(message) {
        const waiter = waiters.shift();
        if (waiter === undefined) buffered.push(message);
        else waiter(message);
      },
    },
  );
  const receive = async (): Promise<WorkerMessage> => {
    const available = buffered.shift();
    const value =
      available ?? (await new Promise<unknown>((resolve) => waiters.push(resolve)));
    const message = parseWorkerMessage(value);
    if (message.kind === "error") throw new Error(message.detail);
    if (message.worker !== worker) throw new Error("lease worker identity changed");
    return message;
  };
  const ready = await receive();
  if (ready.kind !== "ready") throw new Error("lease worker did not become ready");
  let stopped = false;
  return Object.freeze({
    worker,
    contend: async (round) => {
      child.send({ kind: "contend", round });
      const message = await receive();
      if (message.kind !== "result" || message.round !== round) {
        throw new Error("lease worker returned an out-of-order contention result");
      }
      return message;
    },
    release: async (round) => {
      child.send({ kind: "release", round });
      const message = await receive();
      if (message.kind !== "released" || message.round !== round) {
        throw new Error("lease worker returned an out-of-order release result");
      }
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      child.kill();
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      if (stderr !== "") throw new Error(stderr);
    },
  });
}

function staleDiagnostic(
  port: DemoImapTestPort,
  winner: Extract<WorkerMessage, { kind: "result" }>,
  round: number,
): string {
  const identitySeconds = 1_700_000_000 + round;
  return JSON.stringify({
    schema: 1,
    port,
    pid: round % 3 === 0 ? 2_147_483_647 : winner.pid,
    processStartIdentity: `${identitySeconds}:000001`,
    ownerToken: round % 3 === 1 ? randomUUID() : "00000000-0000-4000-8000-000000000000",
  });
}

async function bindUnrelatedUdpOwner(port: DemoImapTestPort): Promise<Socket> {
  const socket = createSocket({ type: "udp4", reuseAddr: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });
  return socket;
}

async function closeUnrelatedUdpOwner(socket: Socket): Promise<void> {
  await new Promise<void>((resolve) => socket.close(resolve));
}

describe("demo IMAP kernel-atomic port leasing", () => {
  test("binds every path component and keeps publication on the opened directory inode", async () => {
    const base = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-fd-relative-"));
    const directory = join(base, "leases");
    const retained = join(base, "retained");
    const replacementMarker = join(directory, "hostile-marker");
    await mkdir(directory, { mode: 0o700 });
    let lease: ReturnType<typeof leaseDemoImapTestPort> | null = null;
    try {
      lease = leaseDemoImapTestPort({
        directory,
        preferredPort: 6112,
        testOnlyDirectoryBoundObserver: () => {
          renameSync(directory, retained);
          mkdirSync(directory, { mode: 0o700 });
          writeFileSync(replacementMarker, "replacement", { mode: 0o600 });
        },
      });
      expect(await readFile(replacementMarker, "utf8")).toBe("replacement");
      expect((await lstat(join(retained, "6112.json"))).isFile()).toBe(true);
      expect(() => leaseDemoImapTestPort({ directory, preferredPort: 6112 })).toThrow(
        "demo IMAP test port 6112 is leased",
      );
      lease.release();
      lease = null;
      const replacementLease = leaseDemoImapTestPort({ directory, preferredPort: 6112 });
      replacementLease.release();
      expect(await readFile(replacementMarker, "utf8")).toBe("replacement");
    } finally {
      lease?.release();
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects parent symlinks and replaces only a hostile canonical link entry", async () => {
    const base = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-symlink-race-"));
    const targetParent = join(base, "target-parent");
    const targetDirectory = join(targetParent, "leases");
    const linkedParent = join(base, "linked-parent");
    const safeDirectory = join(base, "safe");
    const hostileTarget = join(base, "hostile-target");
    try {
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      await symlink(targetParent, linkedParent);
      expect(() =>
        leaseDemoImapTestPort({
          directory: join(linkedParent, "leases"),
          preferredPort: 6113,
        }),
      ).toThrow("demo IMAP lease directory is not private");

      await mkdir(safeDirectory, { mode: 0o700 });
      await writeFile(hostileTarget, "untouched", { mode: 0o600 });
      const lease = leaseDemoImapTestPort({
        directory: safeDirectory,
        preferredPort: 6113,
        testOnlyDirectoryBoundObserver: () =>
          symlinkSync(hostileTarget, join(safeDirectory, "6113.json")),
      });
      lease.release();
      expect(await readFile(hostileTarget, "utf8")).toBe("untouched");
      expect((await lstat(join(safeDirectory, "6113.json"))).isSymbolicLink()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("releases authority after chmod, publication, and directory-sync failures", async () => {
    const base = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-release-failure-"));
    const chmodDirectory = join(base, "chmod");
    const hostileDirectory = join(base, "hostile-record");
    const syncDirectory = join(base, "sync");
    await Promise.all([
      mkdir(chmodDirectory, { mode: 0o700 }),
      mkdir(hostileDirectory, { mode: 0o700 }),
      mkdir(syncDirectory, { mode: 0o700 }),
    ]);
    try {
      expect(() =>
        leaseDemoImapTestPort({
          directory: chmodDirectory,
          preferredPort: 6114,
          testOnlyDirectoryBoundObserver: () => chmodSync(chmodDirectory, 0o755),
        }),
      ).toThrow("demo IMAP lease directory is not private");
      expect(demoImapTestPortLeaseExists(6114, chmodDirectory)).toBe(false);
      chmodSync(chmodDirectory, 0o700);

      const hostileRecord = join(hostileDirectory, "6114.json");
      await mkdir(hostileRecord, { mode: 0o700 });
      await writeFile(join(hostileRecord, "marker"), "untouched", { mode: 0o600 });
      expect(() =>
        leaseDemoImapTestPort({ directory: hostileDirectory, preferredPort: 6114 }),
      ).toThrow("demo IMAP lease diagnostic publication failed");
      expect(await readFile(join(hostileRecord, "marker"), "utf8")).toBe("untouched");
      expect(demoImapTestPortLeaseExists(6114, hostileDirectory)).toBe(false);

      expect(() =>
        leaseDemoImapTestPort({
          directory: syncDirectory,
          preferredPort: 6114,
          testOnlyFailure: "directory-sync",
        }),
      ).toThrow("injected demo IMAP lease directory sync failure");
      expect(demoImapTestPortLeaseExists(6114, syncDirectory)).toBe(false);
      const rebound = leaseDemoImapTestPort({ directory: syncDirectory, preferredPort: 6114 });
      rebound.release();
      expect(activeDemoImapTestPortLeases()).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test(
    "keeps maxOwners at one for 100 rounds of 32 live, stale, and crashed processes",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-kernel-stress-"));
      const authority = join(base, "authority");
      const directory = join(authority, "leases");
      const port = 6114;
      const workers: StressWorker[] = [];
      let maxOwners = 0;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        workers.push(
          ...(await Promise.all(
            Array.from({ length: STRESS_WORKERS }, (_, index) =>
              spawnStressWorker(directory, port, String(index)),
            ),
          )),
        );
        for (let round = 0; round < STRESS_ROUNDS; round += 1) {
          const results = await Promise.all(workers.map((worker) => worker.contend(round)));
          const owners = results.filter(({ acquired }) => acquired);
          maxOwners = Math.max(maxOwners, owners.length);
          expect(owners).toHaveLength(1);
          const winner = owners[0];
          if (winner === undefined) throw new Error("stress round has no lease owner");

          let retainedAuthority: string | null = null;
          if (round % 20 === 0) {
            retainedAuthority = join(base, `retained-${round}`);
            await rename(authority, retainedAuthority);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await writeFile(join(directory, "hostile-marker"), "untouched", { mode: 0o600 });
          }
          if (round % 10 === 0) {
            await writeFile(join(directory, `${port}.json`), staleDiagnostic(port, winner, round));
            expect(() => leaseDemoImapTestPort({ directory, preferredPort: port })).toThrow(
              "demo IMAP test port 6114 is leased",
            );
          }

          const winnerIndex = workers.findIndex(({ worker }) => worker === winner.worker);
          if (winnerIndex < 0) throw new Error("stress winner is unavailable");
          if (round % 25 === 24) {
            await workers[winnerIndex]?.stop();
            await Promise.all(
              workers
                .filter((_, index) => index !== winnerIndex)
                .map((worker) => worker.release(round)),
            );
            const recovered = leaseDemoImapTestPort({ directory, preferredPort: port });
            recovered.release();
            workers[winnerIndex] = await spawnStressWorker(
              directory,
              port,
              workers[winnerIndex]?.worker ?? String(winnerIndex),
            );
          } else {
            await Promise.all(workers.map((worker) => worker.release(round)));
          }
          if (retainedAuthority !== null) {
            expect(await readFile(join(directory, "hostile-marker"), "utf8")).toBe("untouched");
            await rm(retainedAuthority, { recursive: true, force: true });
          }
          expect(demoImapTestPortLeaseExists(port, directory)).toBe(false);
        }
        expect(maxOwners).toBe(1);
        expect(activeDemoImapTestPortLeases()).toBe(0);
      } finally {
        await Promise.allSettled(workers.map((worker) => worker.stop()));
        await rm(base, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe("demo IMAP lease authority namespace", () => {
  test("fails closed around an unrelated UDP owner without closing its socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-udp-collision-"));
    const unrelated = await bindUnrelatedUdpOwner(6113);
    try {
      expect(() => leaseDemoImapTestPort({ directory, preferredPort: 6113 })).toThrow(
        "demo IMAP test port 6113 is leased",
      );
      expect(unrelated.address()).toMatchObject({ address: "127.0.0.1", port: 6113 });
    } finally {
      await closeUnrelatedUdpOwner(unrelated);
    }
    try {
      const rebound = leaseDemoImapTestPort({ directory, preferredPort: 6113 });
      rebound.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not inspect, mutate, or remove an unrelated deterministic System V semaphore", async () => {
    const IPC_CREAT = 0o1000;
    const IPC_EXCL = 0o2000;
    const IPC_RMID = 0;
    const GETVAL = 5;
    const unrelatedKey = 0x414d_2600;
    const api = dlopen("/usr/lib/libSystem.B.dylib", {
      __error: { args: [], returns: FFIType.ptr },
      semctl: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      semget: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    const semaphoreId = api.symbols.semget(
      unrelatedKey,
      1,
      IPC_CREAT | IPC_EXCL | 0o600,
    );
    if (semaphoreId < 0) {
      const errorPointer = api.symbols.__error();
      const error = errorPointer === null ? 0 : read.i32(errorPointer, 0);
      throw new Error(`unrelated semaphore fixture creation failed with errno ${error}`);
    }
    const directory = join(tmpdir(), `agent-mail-demo-imap-semaphore-${randomUUID()}`);
    try {
      expect(api.symbols.semctl(semaphoreId, 0, GETVAL, 0)).toBe(0);
      const lease = leaseDemoImapTestPort({ directory, preferredPort: 6112 });
      lease.release();
      expect(api.symbols.semctl(semaphoreId, 0, GETVAL, 0)).toBe(0);
      expect(demoImapTestPortLeaseExists(6112, directory)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
      expect(api.symbols.semctl(semaphoreId, 0, IPC_RMID, 0)).toBe(0);
    }
  });
});
