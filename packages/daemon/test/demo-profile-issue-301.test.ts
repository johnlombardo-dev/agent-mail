import {
  chmod,
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
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.marker)).toBe(true);
    expect(rootEntry.mode & 0o777).toBe(0o700);
    expect(markerEntry.mode & 0o777).toBe(0o600);
    expect(profile).toMatchObject({ device: rootEntry.dev, inode: rootEntry.ino });
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

  test("rejects a same-path directory swap even when its copied marker is valid", async () => {
    const { parent, root } = await profileRoot("directory-swap");
    const adapter = identity("process-start-a");
    const profile = await createDemoProfile({ root }, adapter);
    const parked = join(parent, "parked-original");
    await rename(root, parked);
    await mkdir(root, { mode: 0o700 });
    const copiedMarker = await readFile(join(parked, DEMO_PROFILE_MARKER_NAME), "utf8");
    await writeFile(join(root, DEMO_PROFILE_MARKER_NAME), copiedMarker, { mode: 0o600 });
    const victim = join(root, "victim.txt");
    await writeFile(victim, "replacement-victim", { mode: 0o600 });

    await expect(removeDemoProfile(profile, adapter)).rejects.toThrow("creation inode");
    expect(await readFile(victim, "utf8")).toBe("replacement-victim");
    expect((await lstat(root)).isDirectory()).toBe(true);
    expect((await lstat(root)).ino).not.toBe(profile.inode);
    expect((await lstat(parked)).ino).toBe(profile.inode);
    expect(await readFile(join(parked, DEMO_PROFILE_MARKER_NAME), "utf8")).toBe(copiedMarker);
  });

  test("rejects post-creation symlink and mode attacks without deleting either path", async () => {
    const symlinkCase = await profileRoot("post-create-symlink");
    const adapter = identity("process-start-a");
    const symlinkProfile = await createDemoProfile({ root: symlinkCase.root }, adapter);
    const parked = join(symlinkCase.parent, "parked-original");
    const parkedVictim = join(parked, "victim.txt");
    await writeFile(join(symlinkCase.root, "victim.txt"), "parked-victim", { mode: 0o600 });
    await rename(symlinkCase.root, parked);
    await symlink(parked, symlinkCase.root);
    await expect(removeDemoProfile(symlinkProfile, adapter)).rejects.toThrow(
      "not a private owned directory",
    );
    expect((await lstat(symlinkCase.root)).isSymbolicLink()).toBe(true);
    expect(await readFile(parkedVictim, "utf8")).toBe("parked-victim");

    const modeCase = await profileRoot("post-create-mode");
    const modeProfile = await createDemoProfile({ root: modeCase.root }, adapter);
    const modeVictim = join(modeCase.root, "victim.txt");
    await writeFile(modeVictim, "mode-victim", { mode: 0o600 });
    await chmod(modeCase.root, 0o755);
    await expect(removeDemoProfile(modeProfile, adapter)).rejects.toThrow(
      "not a private owned directory",
    );
    expect(await readFile(modeVictim, "utf8")).toBe("mode-victim");
    expect((await lstat(modeCase.root)).mode & 0o777).toBe(0o755);
  });

  test("revalidates identity after rename and restores the exact inode without deleting it", async () => {
    const { root } = await profileRoot("post-rename");
    let identityReads = 0;
    const adapter: ProcessIdentityAdapter = {
      currentProcessStartIdentity: async () => {
        identityReads += 1;
        return identityReads <= 3 ? "process-start-a" : "process-start-b";
      },
      inspectProcess: async () => ({ kind: "live", processStartIdentity: "process-start-a" }),
    };
    const profile = await createDemoProfile({ root }, adapter);
    await writeFile(join(root, "victim.txt"), "post-rename-victim", { mode: 0o600 });
    await expect(removeDemoProfile(profile, adapter)).rejects.toThrow(
      "process identity does not match",
    );
    const tombstone = `${root}.removing-${profile.marker.ownerToken}`;
    expect((await lstat(root)).ino).toBe(profile.inode);
    expect(await readFile(join(root, "victim.txt"), "utf8")).toBe("post-rename-victim");
    await expect(lstat(tombstone)).rejects.toMatchObject({ code: "ENOENT" });
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
