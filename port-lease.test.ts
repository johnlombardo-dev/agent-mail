import { describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquirePortLease,
  classifyPortLease,
  inspectDarwinProcessIdentity,
  platformProcessIdentityAdapter,
  portLeaseLockRecordSchema,
  reclaimPortLease,
  releasePortLease,
  type PortLease,
  type ProcessIdentityAdapter,
} from "./port-lease";

async function makeLeaseDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-mail-port-lease-"));
}

function fixedIdentityAdapter(
  currentIdentity: string,
  inspectedIdentity: string | null,
): ProcessIdentityAdapter {
  return {
    currentProcessStartIdentity: async () => currentIdentity,
    inspectProcess: async () =>
      inspectedIdentity === null
        ? { kind: "not-live" }
        : { kind: "live", processStartIdentity: inspectedIdentity },
  };
}

describe("one process-safe port lease", () => {
  test("records its role assignment and only the exact owner can release it", async () => {
    const directory = await makeLeaseDirectory();
    try {
      const lease = await acquirePortLease({
        project: "test-project",
        role: "apiIntegration",
        directory,
      });
      expect(lease).not.toBeNull();
      if (lease === null) {
        throw new Error("expected the isolated role to be available");
      }
      expect(lease).toMatchObject({
        project: "test-project",
        role: "apiIntegration",
        port: 6112,
        pid: process.pid,
      });
      expect(lease.processStartIdentity).toMatch(/^(?:linux|darwin):/u);
      expect(lease.ownerToken).toHaveLength(36);
      expect(lease.createdAt).toMatch(/Z$/u);

      const nonOwner = await releasePortLease({
        lease: { role: lease.role, ownerToken: `${lease.ownerToken}-different` },
        directory,
      });
      expect(nonOwner).toBe("not-owner");
      expect(await readFile(join(directory, "apiIntegration.json"), "utf8")).toContain(
        lease.ownerToken,
      );

      expect(await releasePortLease({ lease, directory })).toBe("released");
      expect(await releasePortLease({ lease, directory })).toBe("already-released");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("races two child processes and gives the role to exactly one", async () => {
    const directory = await makeLeaseDirectory();
    try {
      const moduleUrl = pathToFileURL(join(process.cwd(), "port-lease.ts")).href;
      const childScript = `
        import { acquirePortLease } from ${JSON.stringify(moduleUrl)};
        const directory = process.argv.at(-1);
        if (directory === undefined) throw new Error("missing lease directory");
        const lease = await acquirePortLease({ project: "contention-test", role: "apiIntegration", directory });
        process.stdout.write(JSON.stringify(lease));
      `;
      const children = [0, 1].map(() =>
        Bun.spawn(["bun", "-e", childScript, directory], {
          stderr: "pipe",
          stdout: "pipe",
        }),
      );
      const results = await Promise.all(
        children.map(async (child) => {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          if (exitCode !== 0) {
            throw new Error(`child exited ${exitCode}: ${stderr}`);
          }
          const parsed: unknown = JSON.parse(stdout);
          return parsed;
        }),
      );

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("terminating an owner permits reclaim and retains the old record", async () => {
    const directory = await makeLeaseDirectory();
    try {
      const moduleUrl = pathToFileURL(join(process.cwd(), "port-lease.ts")).href;
      const childScript = `
        import { acquirePortLease } from ${JSON.stringify(moduleUrl)};
        const directory = process.argv.at(-1);
        if (directory === undefined) throw new Error("missing lease directory");
        const lease = await acquirePortLease({ project: "terminated-owner", role: "apiIntegration", directory });
        process.stdout.write(JSON.stringify(lease));
        await new Promise(() => {});
      `;
      const child = Bun.spawn(["bun", "-e", childScript, directory], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const reader = child.stdout.getReader();
      const first = await reader.read();
      if (first.value === undefined) throw new Error("child did not publish its lease");
      const childLease: unknown = JSON.parse(new TextDecoder().decode(first.value));
      if (childLease === null || typeof childLease !== "object") {
        throw new Error("child failed to acquire the lease");
      }
      child.kill();
      await child.exited;

      const reclaimed = await reclaimPortLease({ role: "apiIntegration", directory });
      expect(reclaimed.kind).toBe("reclaimed");
      if (reclaimed.kind !== "reclaimed") throw new Error("expected stale child lease");
      expect(JSON.parse(await readFile(reclaimed.retainedPath, "utf8"))).toEqual(childLease);
      expect(await readFile(join(directory, "apiIntegration.json")).catch(() => null)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not reclaim an old record while its matching identity is live", async () => {
    const directory = await makeLeaseDirectory();
    try {
      const adapter = fixedIdentityAdapter("owner-start", "owner-start");
      const lease = await acquirePortLease({
        project: "old-live-owner",
        role: "apiIntegration",
        directory,
        processIdentityAdapter: adapter,
      });
      if (lease === null) throw new Error("expected lease");
      const oldLease: PortLease = { ...lease, createdAt: "2000-01-01T00:00:00.000Z" };
      await writeFile(join(directory, "apiIntegration.json"), JSON.stringify(oldLease));

      const classified = await classifyPortLease({
        role: "apiIntegration",
        directory,
        processIdentityAdapter: adapter,
      });
      expect(classified.kind).toBe("live");
      if (classified.kind !== "live") throw new Error("expected live classification");
      expect(classified.ageMs).toBeGreaterThan(1_000_000_000);
      const reclaim = await reclaimPortLease({
        role: "apiIntegration",
        directory,
        processIdentityAdapter: adapter,
      });
      expect(reclaim.kind).toBe("live");
      expect(await readFile(join(directory, "apiIntegration.json"), "utf8")).toContain(
        lease.ownerToken,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reclaims a PID-reused record only when the start identity mismatches", async () => {
    const directory = await makeLeaseDirectory();
    try {
      const lease = await acquirePortLease({
        project: "pid-reuse",
        role: "apiIntegration",
        directory,
        processIdentityAdapter: fixedIdentityAdapter("old-start", "old-start"),
      });
      if (lease === null) throw new Error("expected lease");
      const reclaim = await reclaimPortLease({
        role: "apiIntegration",
        directory,
        processIdentityAdapter: fixedIdentityAdapter("replacement-start", "replacement-start"),
      });
      expect(reclaim.kind).toBe("reclaimed");
      if (reclaim.kind !== "reclaimed") throw new Error("expected PID reuse to be stale");
      expect(reclaim.reason).toBe("pid-reused");
      expect(JSON.parse(await readFile(reclaim.retainedPath, "utf8"))).toEqual(lease);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on identity lookup errors and serializes an exact-owner release", async () => {
    const directory = await makeLeaseDirectory();
    try {
      const adapter = fixedIdentityAdapter("owner-start", "owner-start");
      const lease = await acquirePortLease({
        project: "unknown-owner",
        role: "apiIntegration",
        directory,
        processIdentityAdapter: adapter,
      });
      if (lease === null) throw new Error("expected lease");
      const unknownAdapter: ProcessIdentityAdapter = {
        currentProcessStartIdentity: async () => "replacement-start",
        inspectProcess: async () => {
          throw new Error("identity service unavailable");
        },
      };
      expect(
        (await reclaimPortLease({
          role: "apiIntegration",
          directory,
          processIdentityAdapter: unknownAdapter,
        })).kind,
      ).toBe("unknown");

      // Hold the role mutex while both operations are attempted. Neither may
      // unlink the old record based on a read made before a new acquisition.
      const lock = await open(join(directory, "apiIntegration.lock"), "wx");
      const [releaseResult, acquireResult] = await Promise.all([
        releasePortLease({ lease, directory }),
        acquirePortLease({
          project: "new-owner",
          role: "apiIntegration",
          directory,
          processIdentityAdapter: adapter,
        }),
      ]);
      expect(releaseResult).toBe("not-owner");
      expect(acquireResult).toBeNull();
      await lock.close();
      await unlink(join(directory, "apiIntegration.lock"));
      expect(await readFile(join(directory, "apiIntegration.json"), "utf8")).toContain(
        lease.ownerToken,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers a lock left by a terminated child and retains lock evidence", async () => {
    const directory = await makeLeaseDirectory();
    try {
      const moduleUrl = pathToFileURL(join(process.cwd(), "port-lease.ts")).href;
      const childScript = `
        import { platformProcessIdentityAdapter, portLeaseLockRecordSchema } from ${JSON.stringify(moduleUrl)};
        import { randomUUID } from "node:crypto";
        import { writeFile } from "node:fs/promises";
        import { join } from "node:path";
        const directory = process.argv.at(-1);
        if (directory === undefined) throw new Error("missing lease directory");
        const processStartIdentity = await platformProcessIdentityAdapter.currentProcessStartIdentity();
        const lock = portLeaseLockRecordSchema.parse({
          pid: process.pid,
          processStartIdentity,
          ownerToken: randomUUID(),
          createdAt: new Date().toISOString(),
        });
        await writeFile(join(directory, "apiIntegration.lock"), JSON.stringify(lock));
        process.stdout.write("ready");
        await new Promise(() => {});
      `;
      const child = Bun.spawn(["bun", "-e", childScript, directory], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      child.kill();
      await child.exited;

      const lease = await acquirePortLease({
        project: "recovered-lock",
        role: "apiIntegration",
        directory,
      });
      expect(lease).not.toBeNull();
      const retained = (await readdir(directory)).filter((name) =>
        name.startsWith("apiIntegration.lock.reclaimed."),
      );
      expect(retained).toHaveLength(1);
      expect(
        portLeaseLockRecordSchema.safeParse(
          JSON.parse(await readFile(join(directory, retained[0] ?? ""), "utf8")),
        ).success,
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed for live, unknown, and invalid operation locks", async () => {
    const directory = await makeLeaseDirectory();
    const lockPath = join(directory, "apiIntegration.lock");
    try {
      const liveAdapter = fixedIdentityAdapter("lock-start", "lock-start");
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          processStartIdentity: "lock-start",
          ownerToken: "lock-token",
          createdAt: new Date().toISOString(),
        }),
      );
      expect(
        await acquirePortLease({
          project: "live-lock",
          role: "apiIntegration",
          directory,
          processIdentityAdapter: liveAdapter,
        }),
      ).toBeNull();
      await unlink(lockPath);

      const unknownAdapter: ProcessIdentityAdapter = {
        currentProcessStartIdentity: async () => "new-start",
        inspectProcess: async () => ({ kind: "unknown", reason: "identity unavailable" }),
      };
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          processStartIdentity: "lock-start",
          ownerToken: "lock-token",
          createdAt: new Date().toISOString(),
        }),
      );
      expect(
        await acquirePortLease({
          project: "unknown-lock",
          role: "apiIntegration",
          directory,
          processIdentityAdapter: unknownAdapter,
        }),
      ).toBeNull();
      await unlink(lockPath);

      await writeFile(lockPath, "not-json");
      expect(
        await acquirePortLease({
          project: "invalid-lock",
          role: "apiIntegration",
          directory,
          processIdentityAdapter: liveAdapter,
        }),
      ).toBeNull();
      expect(await readFile(lockPath, "utf8")).toBe("not-json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Darwin inspection distinguishes ESRCH, probe errors, and ps errors", async () => {
    let queried = false;
    const notLive = await inspectDarwinProcessIdentity(1, {
      processExists: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      queryStartIdentity: async () => {
        queried = true;
        return "start";
      },
    });
    expect(notLive.kind).toBe("not-live");
    expect(queried).toBe(false);

    const permissionDenied = await inspectDarwinProcessIdentity(1, {
      processExists: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
      queryStartIdentity: async () => "start",
    });
    expect(permissionDenied.kind).toBe("unknown");

    const psFailure = await inspectDarwinProcessIdentity(1, {
      processExists: () => undefined,
      queryStartIdentity: async () => {
        throw new Error("ps failed");
      },
    });
    expect(psFailure.kind).toBe("unknown");

    const emptyPs = await inspectDarwinProcessIdentity(1, {
      processExists: () => undefined,
      queryStartIdentity: async () => "  ",
    });
    expect(emptyPs.kind).toBe("unknown");

    const live = await inspectDarwinProcessIdentity(1, {
      processExists: () => undefined,
      queryStartIdentity: async () => "Tue Aug 18 01:00:00 2026",
    });
    expect(live).toEqual({ kind: "live", processStartIdentity: "darwin:Tue Aug 18 01:00:00 2026" });
    expect(platformProcessIdentityAdapter).toBeDefined();
  });
});
