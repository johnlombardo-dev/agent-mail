import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ProcessIdentityAdapter } from "../../../port-lease";
import {
  DEMO_PROFILE_MARKER_NAME,
  DemoProfileOwnershipError,
  createDemoProfile,
  removeDemoProfile,
  verifyDemoProfile,
} from "../src/demo/profile";

const scratchRoots: string[] = [];

async function profileRoot(label: string): Promise<Readonly<{ parent: string; root: string }>> {
  const parent = await mkdtemp(join(tmpdir(), `agent-mail-demo-profile-${label}-`));
  await chmod(parent, 0o700);
  scratchRoots.push(parent);
  return Object.freeze({ parent, root: join(parent, "agent-mail-demo-run") });
}

function identity(value: string): ProcessIdentityAdapter {
  return Object.freeze({
    currentProcessStartIdentity: async () => value,
    inspectProcess: async () => ({ kind: "live", processStartIdentity: value }),
  });
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("disposable demo profile ownership #301", () => {
  test("creates one private identity-bound root and removes only that inode", async () => {
    const { root } = await profileRoot("owned");
    const adapter = identity("process-start-a");
    const profile = await createDemoProfile({ root }, adapter);
    const rootEntry = await lstat(root);
    const markerEntry = await lstat(join(root, DEMO_PROFILE_MARKER_NAME));
    expect(rootEntry.mode & 0o777).toBe(0o700);
    expect(markerEntry.mode & 0o777).toBe(0o600);
    await expect(verifyDemoProfile(profile, adapter)).resolves.toMatchObject({
      dev: rootEntry.dev,
      ino: rootEntry.ino,
    });
    await removeDemoProfile(profile, adapter);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("leaves an existing matching path and its content byte-identical", async () => {
    const { root } = await profileRoot("existing");
    await mkdir(root, { mode: 0o700 });
    const sentinel = join(root, "do-not-touch.txt");
    await writeFile(sentinel, "hostile-sentinel", { mode: 0o600 });
    await expect(createDemoProfile({ root }, identity("process-start-a"))).rejects.toThrow(
      DemoProfileOwnershipError,
    );
    expect(await readFile(sentinel, "utf8")).toBe("hostile-sentinel");
  });

  test("removes a partial root when process identity acquisition fails", async () => {
    const { root } = await profileRoot("identity-failure");
    const adapter: ProcessIdentityAdapter = {
      currentProcessStartIdentity: async () => {
        throw new Error("injected process identity failure");
      },
      inspectProcess: async () => ({ kind: "unknown", reason: "not reached" }),
    };
    await expect(createDemoProfile({ root }, adapter)).rejects.toThrow(
      "injected process identity failure",
    );
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("leaves a matching symlink and its target untouched", async () => {
    const { parent, root } = await profileRoot("symlink");
    const target = join(parent, "target");
    await mkdir(target, { mode: 0o700 });
    const sentinel = join(target, "do-not-touch.txt");
    await writeFile(sentinel, "symlink-sentinel", { mode: 0o600 });
    await symlink(target, root);
    await expect(createDemoProfile({ root }, identity("process-start-a"))).rejects.toThrow(
      DemoProfileOwnershipError,
    );
    expect(await readFile(sentinel, "utf8")).toBe("symlink-sentinel");
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
  });

  test("refuses marker and process-identity mismatches without deleting the root", async () => {
    const first = await profileRoot("identity");
    const profile = await createDemoProfile({ root: first.root }, identity("process-start-a"));
    await expect(removeDemoProfile(profile, identity("process-start-b"))).rejects.toThrow(
      "process identity does not match",
    );
    expect((await lstat(first.root)).isDirectory()).toBe(true);

    const second = await profileRoot("marker");
    const marked = await createDemoProfile({ root: second.root }, identity("process-start-a"));
    const marker = JSON.parse(await readFile(marked.markerPath, "utf8")) as Record<string, unknown>;
    marker.ownerToken = "00000000-0000-4000-8000-000000000000";
    await writeFile(marked.markerPath, JSON.stringify(marker), { mode: 0o600 });
    await expect(removeDemoProfile(marked, identity("process-start-a"))).rejects.toThrow(
      "marker does not match",
    );
    expect((await lstat(second.root)).isDirectory()).toBe(true);

    const third = await profileRoot("oversized-marker");
    const oversized = await createDemoProfile({ root: third.root }, identity("process-start-a"));
    await writeFile(oversized.markerPath, "x".repeat(8 * 1024 + 1), { mode: 0o600 });
    await expect(removeDemoProfile(oversized, identity("process-start-a"))).rejects.toThrow(
      "marker is unsafe",
    );
    expect((await lstat(third.root)).isDirectory()).toBe(true);
  });
});
