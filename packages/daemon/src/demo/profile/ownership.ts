import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
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
const REMOVEFILE_RECURSIVE = 1 << 0; // macOS SDK <removefile.h>
const RENAME_EXCL = 0x0000_0004; // macOS SDK <sys/stdio.h>

const darwinProfileFileApi =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        removefileat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
        renameatx_np: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
      })
    : undefined;

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
  return assertPrivateDirectoryEntry(entry);
}

function assertPrivateDirectoryEntry(
  entry: Stats,
): Readonly<{ readonly dev: number; readonly ino: number }> {
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

async function openExactProfileDirectory(profile: DemoProfile, path: string): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const identity = assertPrivateDirectoryEntry(await handle.stat());
    if (identity.dev !== profile.device || identity.ino !== profile.inode) {
      throw new DemoProfileOwnershipError("Demo root identity does not match its creation inode.");
    }
    return handle;
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (error instanceof DemoProfileOwnershipError) throw error;
    throw new DemoProfileOwnershipError("Demo root descriptor cannot be acquired safely.", {
      cause: error,
    });
  }
}

async function openVerifiedParent(path: string): Promise<FileHandle> {
  const pathEntry = await lstat(path);
  if (!pathEntry.isDirectory() || pathEntry.isSymbolicLink()) {
    throw new DemoProfileOwnershipError("Demo root parent is unsafe.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const descriptorEntry = await handle.stat();
    if (
      !descriptorEntry.isDirectory() ||
      descriptorEntry.dev !== pathEntry.dev ||
      descriptorEntry.ino !== pathEntry.ino
    ) {
      throw new DemoProfileOwnershipError("Demo root parent changed during acquisition.");
    }
    return handle;
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (error instanceof DemoProfileOwnershipError) throw error;
    throw new DemoProfileOwnershipError("Demo root parent cannot be acquired safely.", {
      cause: error,
    });
  }
}

function nulTerminated(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

function renameOwnedDirectoryExclusive(
  parentDescriptor: number,
  sourceName: string,
  targetName: string,
): void {
  if (darwinProfileFileApi === undefined) {
    throw new DemoProfileOwnershipError(
      "Descriptor-relative demo cleanup is unavailable on this platform.",
    );
  }
  const source = nulTerminated(sourceName);
  const target = nulTerminated(targetName);
  const result = darwinProfileFileApi.symbols.renameatx_np(
    parentDescriptor,
    ptr(source),
    parentDescriptor,
    ptr(target),
    RENAME_EXCL,
  );
  if (result !== 0) {
    throw new DemoProfileOwnershipError("Demo root cannot enter exclusive cleanup ownership.");
  }
}

function removeExactOpenedDirectory(descriptor: number): void {
  if (darwinProfileFileApi === undefined) {
    throw new DemoProfileOwnershipError(
      "Descriptor-relative demo cleanup is unavailable on this platform.",
    );
  }
  const currentDirectory = nulTerminated(".");
  const result = darwinProfileFileApi.symbols.removefileat(
    descriptor,
    ptr(currentDirectory),
    null,
    REMOVEFILE_RECURSIVE,
  );
  if (result !== 0) {
    throw new DemoProfileOwnershipError("Descriptor-relative demo cleanup failed.");
  }
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

async function verifyDemoProfileAtPath(
  profile: DemoProfile,
  path: string,
  adapter: ProcessIdentityAdapter,
): Promise<Readonly<{ dev: number; ino: number }>> {
  const identity = await assertPrivateDirectory(path);
  if (identity.dev !== profile.device || identity.ino !== profile.inode) {
    throw new DemoProfileOwnershipError("Demo root identity does not match its creation inode.");
  }
  const marker = await readMarker(join(path, DEMO_PROFILE_MARKER_NAME));
  if (
    marker.root !== profile.root ||
    marker.ownerToken !== profile.marker.ownerToken ||
    marker.pid !== profile.marker.pid ||
    marker.processStartIdentity !== profile.marker.processStartIdentity ||
    marker.createdAt !== profile.marker.createdAt
  ) {
    throw new DemoProfileOwnershipError("Demo ownership marker does not match this run.");
  }
  await verifyProcessIdentity(marker, adapter);
  return identity;
}

export async function verifyDemoProfile(
  profile: DemoProfile,
  adapter: ProcessIdentityAdapter = platformProcessIdentityAdapter,
): Promise<Readonly<{ dev: number; ino: number }>> {
  return verifyDemoProfileAtPath(profile, profile.root, adapter);
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
    const identity = await assertPrivateDirectory(root);
    const marker = Object.freeze(
      demoProfileMarkerSchema.parse({
        version: DEMO_PROFILE_VERSION,
        kind: "agent-mail-disposable-demo",
        root,
        ownerToken: randomUUID(),
        pid: process.pid,
        processStartIdentity: await adapter.currentProcessStartIdentity(),
        createdAt: new Date().toISOString(),
      }),
    );
    await writeMarker(markerPath, marker);
    const profile = Object.freeze({
      root,
      markerPath,
      marker,
      device: identity.dev,
      inode: identity.ino,
    });
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
  await verifyDemoProfile(profile, adapter);
  if (darwinProfileFileApi === undefined) {
    throw new DemoProfileOwnershipError(
      "Descriptor-relative demo cleanup is unavailable on this platform.",
    );
  }
  const parentPath = dirname(profile.root);
  const sourceName = basename(profile.root);
  const tombstoneName = `${sourceName}.removing-${profile.marker.ownerToken}`;
  const tombstone = join(parentPath, tombstoneName);
  let parentHandle: FileHandle | undefined;
  let tombstoneHandle: FileHandle | undefined;
  let operationError: unknown;
  try {
    parentHandle = await openVerifiedParent(parentPath);
    renameOwnedDirectoryExclusive(parentHandle.fd, sourceName, tombstoneName);
    tombstoneHandle = await openExactProfileDirectory(profile, tombstone);
    await verifyDemoProfileAtPath(profile, tombstone, adapter);
    removeExactOpenedDirectory(tombstoneHandle.fd);
    if ((await demoProfileRootExists(profile.root)) || (await demoProfileRootExists(tombstone))) {
      throw new DemoProfileOwnershipError("Demo cleanup left an unowned path residue.");
    }
  } catch (error: unknown) {
    operationError = error;
  }
  try {
    await tombstoneHandle?.close();
  } catch (error: unknown) {
    operationError ??= new DemoProfileOwnershipError("Demo cleanup descriptor close failed.", {
      cause: error,
    });
  }
  try {
    await parentHandle?.close();
  } catch (error: unknown) {
    operationError ??= new DemoProfileOwnershipError("Demo parent descriptor close failed.", {
      cause: error,
    });
  }
  if (operationError !== undefined) throw operationError;
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
