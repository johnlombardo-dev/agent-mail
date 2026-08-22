import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activeDemoImapTestPortLeases,
  createDemoImapServer,
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
      expect(demoImapTestPortLeaseExists(port, directory)).toBe(true);
      const recovered = leaseDemoImapTestPort({ directory, preferredPort: port });
      recovered.release();
      expect(demoImapTestPortLeaseExists(port, directory)).toBe(false);
      expect(activeDemoImapTestPortLeases()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reclaims a PID-reused record only when its process start identity differs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mail-demo-imap-reused-pid-"));
    const port = 6112;
    try {
      const oldOwner = leaseDemoImapTestPort({ directory, preferredPort: port });
      const path = join(directory, `${port}.json`);
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("lease record is not an object");
      }
      await writeFile(
        path,
        JSON.stringify({ ...parsed, processStartIdentity: "darwin:simulated-reused-pid" }),
        "utf8",
      );
      const replacement = leaseDemoImapTestPort({ directory, preferredPort: port });
      oldOwner.release();
      replacement.release();
      expect(demoImapTestPortLeaseExists(port, directory)).toBe(false);
      expect(activeDemoImapTestPortLeases()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
