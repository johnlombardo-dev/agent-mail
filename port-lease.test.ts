import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquirePortLease, releasePortLease } from "./port-lease";

async function makeLeaseDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-mail-port-lease-"));
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
      expect(lease.processStartIdentity).toHaveLength(36);
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
});
