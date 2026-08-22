import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activeDemoImapTestPortLeases,
  createDemoImapServer,
  DemoImapReleaseObserverError,
  demoImapTestPortLeaseExists,
  leaseDemoImapTestPort,
  type DemoImapTestPort,
} from "../src/demo/imap";

const leaseChild = join(import.meta.dir, "helpers/demo-imap-port-lease-child.ts");

function zeroResources(server: ReturnType<typeof createDemoImapServer>): void {
  expect(server.snapshot()).toMatchObject({
    listening: false,
    activeSessions: 0,
    activeSockets: 0,
    activeListeners: 0,
    pendingTimers: 0,
    childProcesses: 0,
    activeTestLeases: 0,
  });
}

async function bindRawServer(port: DemoImapTestPort): Promise<NetServer> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      listener.removeAllListeners("error");
      resolve();
    });
  });
  return listener;
}

async function closeRawServer(listener: NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    listener.close((error?: Error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  listener.removeAllListeners();
}

async function waitForLeaseFile(directory: string, port: DemoImapTestPort): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (demoImapTestPortLeaseExists(port, directory)) return;
    await Bun.sleep(5);
  }
  throw new Error("child did not publish its lease");
}

describe("demo IMAP lifecycle and process-safe port ownership", () => {
  test("serializes adjacent double-start and double-close while cleanup survives release failure", async () => {
    const lease = leaseDemoImapTestPort();
    let releaseCalls = 0;
    const server = createDemoImapServer({
      port: lease.port,
      releasePort: () => {
        releaseCalls += 1;
        lease.release();
        throw new Error("injected release observer failure");
      },
    });

    const firstStart = server.start();
    const secondStart = server.start();
    expect(firstStart).toBe(secondStart);
    await Promise.all([firstStart, secondStart]);

    const firstClose = server.close();
    const secondClose = server.close();
    expect(firstClose).toBe(secondClose);
    const outcomes = await Promise.allSettled([firstClose, secondClose]);
    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(releaseCalls).toBe(1);
    zeroResources(server);

    const reboundLease = leaseDemoImapTestPort({ preferredPort: lease.port });
    const rebound = createDemoImapServer({
      port: reboundLease.port,
      releasePort: reboundLease.release,
    });
    await rebound.start();
    await rebound.close();
    zeroResources(rebound);
  });

  test("makes start-close races deterministic and rejects resurrection", async () => {
    const lease = leaseDemoImapTestPort();
    const server = createDemoImapServer({ port: lease.port, releasePort: lease.release });
    const starting = server.start();
    const closing = server.close();
    await Promise.all([starting, closing]);
    zeroResources(server);
    await expect(server.start()).rejects.toThrow("demo IMAP server is closed");
  });

  test("rolls a failed bind back through lease release and permits immediate rebind", async () => {
    const lease = leaseDemoImapTestPort();
    const occupied = await bindRawServer(lease.port);
    const server = createDemoImapServer({ port: lease.port, releasePort: lease.release });
    await expect(server.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    zeroResources(server);
    await closeRawServer(occupied);

    const reboundLease = leaseDemoImapTestPort({ preferredPort: lease.port });
    const rebound = createDemoImapServer({
      port: reboundLease.port,
      releasePort: reboundLease.release,
    });
    await rebound.start();
    await rebound.close();
    zeroResources(rebound);
  });

  test("separates failed-bind cleanup truth from a retryable release observer", async () => {
    const lease = leaseDemoImapTestPort();
    const occupied = await bindRawServer(lease.port);
    let releaseCalls = 0;
    const server = createDemoImapServer({
      port: lease.port,
      releasePort: () => {
        releaseCalls += 1;
        if (releaseCalls === 1) throw new Error("attacker-controlled observer detail");
        lease.release();
      },
    });
    try {
      await expect(server.start()).rejects.toMatchObject({
        errors: expect.arrayContaining([expect.any(DemoImapReleaseObserverError)]),
      });
      expect(releaseCalls).toBe(1);
      expect(server.snapshot()).toMatchObject({
        listening: false,
        activeSessions: 0,
        activeSockets: 0,
        activeListeners: 0,
        pendingTimers: 0,
        activeTestLeases: 1,
      });
      await server.close();
      expect(releaseCalls).toBe(2);
      zeroResources(server);
    } finally {
      await closeRawServer(occupied);
      lease.release();
    }

    const reboundLease = leaseDemoImapTestPort({ preferredPort: lease.port });
    const rebound = createDemoImapServer({
      port: reboundLease.port,
      releasePort: reboundLease.release,
    });
    await rebound.start();
    await rebound.close();
    zeroResources(rebound);
  });

  test("rejects a live cross-process contender and recovers its killed owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-live-lease-"));
    const port = 6113;
    const child = Bun.spawn([process.execPath, leaseChild, directory, String(port), "hold"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitForLeaseFile(directory, port);
      expect(() => leaseDemoImapTestPort({ directory, preferredPort: port })).toThrow(
        "demo IMAP test port 6113 is leased",
      );
      child.kill();
      await child.exited;
      const recovered = leaseDemoImapTestPort({ directory, preferredPort: port });
      recovered.release();
      expect(demoImapTestPortLeaseExists(port, directory)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
      await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reclaims a crash-stale cross-process lease without a grace delay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-crash-lease-"));
    const port = 6114;
    try {
      const child = Bun.spawn([process.execPath, leaseChild, directory, String(port), "crash"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(73);
      expect(stderr).toBe("");
      expect(stdout).toContain('"kind":"acquired"');
      expect(demoImapTestPortLeaseExists(port, directory)).toBe(false);
      const durableRecord = await lstat(join(directory, `${port}.json`));
      expect(durableRecord.mode & 0o777).toBe(0o600);
      const recovered = leaseDemoImapTestPort({ directory, preferredPort: port });
      recovered.release();
      expect(demoImapTestPortLeaseExists(port, directory)).toBe(false);
      expect(activeDemoImapTestPortLeases()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("ignores a PID-reused diagnostic while the kernel owner remains live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-reused-pid-"));
    const port = 6112;
    try {
      const oldOwner = leaseDemoImapTestPort({ directory, preferredPort: port });
      const path = join(directory, `${port}.json`);
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("lease record is not an object");
      }
      const processStartIdentity = Reflect.get(parsed, "processStartIdentity");
      if (typeof processStartIdentity !== "string") {
        throw new Error("lease record lacks process identity");
      }
      const identityMatch = /^(\d+):([0-9]{6})$/u.exec(processStartIdentity);
      if (identityMatch?.[1] === undefined || identityMatch[2] === undefined) {
        throw new Error("lease record identity is not exact");
      }
      const reusedMicroseconds = (Number(identityMatch[2]) + 1) % 1_000_000;
      await writeFile(
        path,
        JSON.stringify({
          ...parsed,
          processStartIdentity: `${identityMatch[1]}:${String(reusedMicroseconds).padStart(6, "0")}`,
        }),
        "utf8",
      );
      expect(() => leaseDemoImapTestPort({ directory, preferredPort: port })).toThrow(
        "demo IMAP test port 6112 is leased",
      );
      oldOwner.release();
      const replacement = leaseDemoImapTestPort({ directory, preferredPort: port });
      replacement.release();
      expect(demoImapTestPortLeaseExists(port, directory)).toBe(false);
      expect(activeDemoImapTestPortLeases()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed for symlinked, shared-mode, and foreign-owned lease directories", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-hostile-lease-"));
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    const permissive = join(parent, "permissive");
    try {
      await mkdir(target, { mode: 0o700 });
      await symlink(target, linked);
      expect(() => leaseDemoImapTestPort({ directory: linked, preferredPort: 6112 })).toThrow(
        "demo IMAP lease directory is not private",
      );

      await mkdir(permissive, { mode: 0o700 });
      await chmod(permissive, 0o755);
      expect(() =>
        leaseDemoImapTestPort({ directory: permissive, preferredPort: 6112 }),
      ).toThrow("demo IMAP lease directory is not private");

      expect(() =>
        leaseDemoImapTestPort({ directory: "/private/tmp", preferredPort: 6112 }),
      ).toThrow("demo IMAP lease directory is not private");
      expect(activeDemoImapTestPortLeases()).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
