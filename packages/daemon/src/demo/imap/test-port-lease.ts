import { randomUUID } from "node:crypto";
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEMO_IMAP_TEST_PORTS, type DemoImapTestPort, type DemoImapTestPortLease } from "./types";

const DEFAULT_LEASE_DIRECTORY = "/private/tmp/agent-mail-fm1-demo-imap-leases";
const ownedTokens = new Set<string>();
const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_BYTES = 136;
const PBI_PID_OFFSET = 12;
const PBI_START_SECONDS_OFFSET = 120;
const PBI_START_MICROSECONDS_OFFSET = 128;
const ESRCH = 3;

const darwinProcessApi =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        __error: { args: [], returns: FFIType.ptr },
      })
    : undefined;

type LeaseRecord = Readonly<{
  readonly schema: 1;
  readonly port: DemoImapTestPort;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly ownerToken: string;
}>;

type ProcessIdentityObservation =
  | Readonly<{ readonly kind: "live"; readonly processStartIdentity: string }>
  | Readonly<{ readonly kind: "not-live" }>
  | Readonly<{ readonly kind: "unknown" }>;

export type DemoImapTestPortLeaseOptions = Readonly<{
  readonly preferredPort?: DemoImapTestPort;
  readonly directory?: string;
}>;

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTestPort(value: unknown): value is DemoImapTestPort {
  return value === 6112 || value === 6113 || value === 6114;
}

function parseRecord(value: unknown): LeaseRecord | null {
  if (!isRecord(value)) return null;
  if (
    value.schema !== 1 ||
    !isTestPort(value.port) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processStartIdentity !== "string" ||
    !/^\d+:[0-9]{6}$/u.test(value.processStartIdentity) ||
    typeof value.ownerToken !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.ownerToken)
  ) {
    return null;
  }
  return Object.freeze({
    schema: 1,
    port: value.port,
    pid: value.pid,
    processStartIdentity: value.processStartIdentity,
    ownerToken: value.ownerToken,
  });
}

function leasePath(directory: string, port: DemoImapTestPort): string {
  return join(directory, `${port}.json`);
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function secureLeaseDirectory(input: string): string {
  const directory = resolve(input);
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = lstatSync(directory);
  const uid = process.getuid?.();
  if (
    identity.isSymbolicLink() ||
    !identity.isDirectory() ||
    uid === undefined ||
    identity.uid !== uid ||
    (identity.mode & 0o077) !== 0
  ) {
    throw new Error("demo IMAP lease directory is not private");
  }
  if (created !== undefined) syncDirectory(dirname(directory));
  syncDirectory(directory);
  return directory;
}

function observeProcessIdentity(pid: number): ProcessIdentityObservation {
  if (darwinProcessApi === undefined) return { kind: "unknown" };
  const bytes = Buffer.alloc(PROC_BSDINFO_BYTES);
  const result = darwinProcessApi.symbols.proc_pidinfo(
    pid,
    PROC_PIDTBSDINFO,
    0n,
    ptr(bytes),
    bytes.byteLength,
  );
  if (result === 0) {
    const errorPointer = darwinProcessApi.symbols.__error();
    if (errorPointer === null) return { kind: "unknown" };
    return read.i32(errorPointer, 0) === ESRCH ? { kind: "not-live" } : { kind: "unknown" };
  }
  if (result !== PROC_BSDINFO_BYTES || bytes.readUInt32LE(PBI_PID_OFFSET) !== pid) {
    return { kind: "unknown" };
  }
  const seconds = bytes.readBigUInt64LE(PBI_START_SECONDS_OFFSET);
  const microseconds = bytes.readBigUInt64LE(PBI_START_MICROSECONDS_OFFSET);
  if (
    seconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    microseconds >= 1_000_000n ||
    microseconds > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return { kind: "unknown" };
  }
  return {
    kind: "live",
    processStartIdentity: `${seconds}:${String(Number(microseconds)).padStart(6, "0")}`,
  };
}

function currentProcessStartIdentity(): string {
  const observation = observeProcessIdentity(process.pid);
  if (observation.kind !== "live") {
    throw new Error("current process identity is unavailable for demo IMAP port leasing");
  }
  return observation.processStartIdentity;
}

function readRecord(path: string): LeaseRecord | null {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    return parseRecord(parsed);
  } catch {
    return null;
  }
}

function createRecord(directory: string, path: string, record: LeaseRecord): boolean {
  const candidate = `${path}.candidate.${record.ownerToken}`;
  let descriptor: number;
  try {
    descriptor = openSync(candidate, "wx", 0o600);
  } catch (error: unknown) {
    if (isFileSystemError(error, "EEXIST")) return false;
    throw error;
  }
  let failure: unknown;
  try {
    writeFileSync(descriptor, JSON.stringify(record), "utf8");
    fsyncSync(descriptor);
  } catch (error: unknown) {
    failure = error;
  }
  try {
    closeSync(descriptor);
  } catch (error: unknown) {
    failure ??= error;
  }
  if (failure !== undefined) {
    try {
      unlinkSync(candidate);
    } catch {
      // The original write/close failure remains authoritative.
    }
    try {
      syncDirectory(directory);
    } catch {
      // The original write/close failure remains authoritative.
    }
    throw failure;
  }
  try {
    syncDirectory(directory);
  } catch (error: unknown) {
    try {
      unlinkSync(candidate);
      syncDirectory(directory);
    } catch {
      // The directory sync failure remains authoritative.
    }
    throw error;
  }
  let acquired = false;
  let publicationFailure: unknown;
  try {
    linkSync(candidate, path);
    acquired = true;
  } catch (error: unknown) {
    if (!isFileSystemError(error, "EEXIST")) publicationFailure = error;
  } finally {
    try {
      unlinkSync(candidate);
    } catch (error: unknown) {
      publicationFailure ??= error;
    }
    try {
      syncDirectory(directory);
    } catch (error: unknown) {
      publicationFailure ??= error;
    }
  }
  if (publicationFailure !== undefined) {
    if (acquired) {
      try {
        unlinkSync(path);
        syncDirectory(directory);
      } catch {
        // The publication failure remains authoritative.
      }
    }
    throw publicationFailure;
  }
  return acquired;
}

function reclaimDeadOwner(directory: string, path: string, record: LeaseRecord): boolean {
  const observation = observeProcessIdentity(record.pid);
  if (
    observation.kind === "unknown" ||
    (observation.kind === "live" &&
      observation.processStartIdentity === record.processStartIdentity)
  ) {
    return false;
  }
  const retained = `${path}.stale.${record.ownerToken}.${randomUUID()}`;
  try {
    renameSync(path, retained);
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) return true;
    return false;
  }
  try {
    unlinkSync(retained);
  } catch {
    // The canonical path is already free. Retained stale evidence is inert.
  }
  syncDirectory(directory);
  return true;
}

function acquirePort(
  directory: string,
  port: DemoImapTestPort,
): Readonly<{ readonly record: LeaseRecord; readonly path: string }> | null {
  const path = leasePath(directory, port);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const record: LeaseRecord = Object.freeze({
      schema: 1,
      port,
      pid: process.pid,
      processStartIdentity: currentProcessStartIdentity(),
      ownerToken: randomUUID(),
    });
    if (createRecord(directory, path, record)) return Object.freeze({ record, path });
    const existing = readRecord(path);
    if (existing === null || !reclaimDeadOwner(directory, path, existing)) return null;
  }
  return null;
}

function releaseOwnedLease(directory: string, path: string, record: LeaseRecord): void {
  const retired = `${path}.released.${record.ownerToken}`;
  if (existsSync(retired)) {
    const retained = readRecord(retired);
    if (retained === null || retained.ownerToken !== record.ownerToken) {
      throw new Error("demo IMAP released lease ownership is unavailable");
    }
    unlinkSync(retired);
    syncDirectory(directory);
    ownedTokens.delete(record.ownerToken);
    return;
  }
  const current = readRecord(path);
  if (current === null) {
    if (existsSync(path)) throw new Error("demo IMAP lease ownership is unavailable");
    syncDirectory(directory);
    ownedTokens.delete(record.ownerToken);
    return;
  }
  if (current.ownerToken !== record.ownerToken) {
    ownedTokens.delete(record.ownerToken);
    return;
  }
  try {
    renameSync(path, retired);
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      syncDirectory(directory);
      ownedTokens.delete(record.ownerToken);
      return;
    }
    throw error;
  }
  try {
    unlinkSync(retired);
  } finally {
    syncDirectory(directory);
  }
  ownedTokens.delete(record.ownerToken);
}

export function leaseDemoImapTestPort(
  options: DemoImapTestPortLeaseOptions = {},
): DemoImapTestPortLease {
  const directory = secureLeaseDirectory(options.directory ?? DEFAULT_LEASE_DIRECTORY);
  const ports =
    options.preferredPort === undefined ? DEMO_IMAP_TEST_PORTS : [options.preferredPort];
  for (const port of ports) {
    const acquired = acquirePort(directory, port);
    if (acquired === null) continue;
    ownedTokens.add(acquired.record.ownerToken);
    let released = false;
    return Object.freeze({
      port,
      release: () => {
        if (released) return;
        releaseOwnedLease(directory, acquired.path, acquired.record);
        released = true;
      },
    });
  }
  throw new Error(
    options.preferredPort === undefined
      ? "all demo IMAP test ports are leased"
      : `demo IMAP test port ${options.preferredPort} is leased`,
  );
}

export function activeDemoImapTestPortLeases(): number {
  return ownedTokens.size;
}

export function demoImapTestPortLeaseExists(
  port: DemoImapTestPort,
  directory = DEFAULT_LEASE_DIRECTORY,
): boolean {
  return existsSync(leasePath(directory, port));
}
