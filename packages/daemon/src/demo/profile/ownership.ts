import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";
import {
  platformProcessIdentityAdapter,
  type ProcessIdentityAdapter,
} from "../../../../../port-lease";
import {
  DEMO_PROFILE_MARKER_NAME,
  DEMO_PROFILE_VERSION,
  demoProfileMarkerSchema,
  type DemoProfile,
  type DemoProfileMarker,
  type DemoProfileOptions,
} from "./types";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MARKER_BYTES = 8 * 1024;

export class DemoProfileOwnershipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DemoProfileOwnershipError";
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]/u).some((segment) => segment === "." || segment === "..");
}

function defaultRoot(): string {
  return join(tmpdir(), `agent-mail-demo-${process.pid}`);
}

export function parseDemoProfileRoot(value: unknown): string {
  const root = value === undefined ? defaultRoot() : value;
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.length > 4096 ||
    !isAbsolute(root) ||
    normalize(root) !== root ||
    root === parse(root).root ||
    hasTraversalSegment(root) ||
    !/^agent-mail-demo(?:-[0-9A-Za-z._-]+)?$/u.test(basename(root))
  ) {
    throw new DemoProfileOwnershipError("Demo root must be one exact agent-mail-demo path.");
  }
  return root;
}

async function assertPrivateDirectory(
  path: string,
): Promise<Readonly<{ dev: number; ino: number }>> {
  const entry = await lstat(path);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (entry.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && entry.uid !== expectedUid)
  ) {
    throw new DemoProfileOwnershipError("Demo root is not a private owned directory.");
  }
  return Object.freeze({ dev: entry.dev, ino: entry.ino });
}

async function writeMarker(path: string, marker: DemoProfileMarker): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(JSON.stringify(marker), "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function readMarker(path: string): Promise<DemoProfileMarker> {
  const entry = await lstat(path);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size > MAX_MARKER_BYTES ||
    (entry.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && entry.uid !== expectedUid)
  ) {
    throw new DemoProfileOwnershipError("Demo ownership marker is unsafe.");
  }
  try {
    return demoProfileMarkerSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error: unknown) {
    throw new DemoProfileOwnershipError("Demo ownership marker is invalid.", { cause: error });
  }
}

async function verifyProcessIdentity(
  marker: DemoProfileMarker,
  adapter: ProcessIdentityAdapter,
): Promise<void> {
  if (marker.pid !== process.pid) {
    throw new DemoProfileOwnershipError("Demo ownership PID does not match this process.");
  }
  const currentIdentity = await adapter.currentProcessStartIdentity();
  if (currentIdentity !== marker.processStartIdentity) {
    throw new DemoProfileOwnershipError("Demo ownership process identity does not match.");
  }
}

export async function verifyDemoProfile(
  profile: DemoProfile,
  adapter: ProcessIdentityAdapter = platformProcessIdentityAdapter,
): Promise<Readonly<{ dev: number; ino: number }>> {
  const identity = await assertPrivateDirectory(profile.root);
  const marker = await readMarker(profile.markerPath);
  if (
    marker.root !== profile.root ||
    marker.ownerToken !== profile.marker.ownerToken ||
    marker.processStartIdentity !== profile.marker.processStartIdentity ||
    marker.createdAt !== profile.marker.createdAt
  ) {
    throw new DemoProfileOwnershipError("Demo ownership marker does not match this run.");
  }
  await verifyProcessIdentity(marker, adapter);
  return identity;
}

export async function createDemoProfile(
  options: DemoProfileOptions,
  adapter: ProcessIdentityAdapter = platformProcessIdentityAdapter,
): Promise<DemoProfile> {
  const root = parseDemoProfileRoot(options.root);
  const parent = dirname(root);
  const parentEntry = await lstat(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new DemoProfileOwnershipError("Demo root parent is unsafe.");
  }
  try {
    await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error: unknown) {
    throw new DemoProfileOwnershipError("Demo root already exists or cannot be created.", {
      cause: error,
    });
  }
  const markerPath = join(root, DEMO_PROFILE_MARKER_NAME);
  try {
    await chmod(root, PRIVATE_DIRECTORY_MODE);
    const marker = demoProfileMarkerSchema.parse({
      version: DEMO_PROFILE_VERSION,
      kind: "agent-mail-disposable-demo",
      root,
      ownerToken: randomUUID(),
      pid: process.pid,
      processStartIdentity: await adapter.currentProcessStartIdentity(),
      createdAt: new Date().toISOString(),
    });
    await writeMarker(markerPath, marker);
    const profile = Object.freeze({ root, markerPath, marker });
    await verifyDemoProfile(profile, adapter);
    return profile;
  } catch (error: unknown) {
    await unlink(markerPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
    throw error;
  }
}

export async function removeDemoProfile(
  profile: DemoProfile,
  adapter: ProcessIdentityAdapter = platformProcessIdentityAdapter,
): Promise<void> {
  const expected = await verifyDemoProfile(profile, adapter);
  const tombstone = `${profile.root}.removing-${profile.marker.ownerToken}`;
  await rename(profile.root, tombstone);
  const moved = await assertPrivateDirectory(tombstone);
  if (moved.dev !== expected.dev || moved.ino !== expected.ino) {
    await rename(tombstone, profile.root).catch(() => undefined);
    throw new DemoProfileOwnershipError("Demo root identity changed during removal.");
  }
  const movedMarker = await readMarker(join(tombstone, DEMO_PROFILE_MARKER_NAME));
  if (
    movedMarker.root !== profile.root ||
    movedMarker.ownerToken !== profile.marker.ownerToken ||
    movedMarker.pid !== profile.marker.pid ||
    movedMarker.processStartIdentity !== profile.marker.processStartIdentity
  ) {
    await rename(tombstone, profile.root).catch(() => undefined);
    throw new DemoProfileOwnershipError("Demo marker changed during removal.");
  }
  await verifyProcessIdentity(movedMarker, adapter);
  await rm(tombstone, { recursive: true, force: false });
}

export async function demoProfileRootExists(root: string): Promise<boolean> {
  try {
    await lstat(root);
    return true;
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}
