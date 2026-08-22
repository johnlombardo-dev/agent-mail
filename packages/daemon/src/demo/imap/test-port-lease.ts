import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fstatSync, fsyncSync, type Stats, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { DEMO_IMAP_TEST_PORTS, type DemoImapTestPort, type DemoImapTestPortLease } from "./types";

const DEFAULT_LEASE_DIRECTORY = "/private/tmp/agent-mail-fm1-demo-imap-leases";
const LIBSYSTEM_PATH = "/usr/lib/libSystem.B.dylib";

// Pinned Darwin ABI and constants. An exclusive loopback UDP bind is the
// kernel authority; the durable JSON record is diagnostic evidence only.
const AT_FDCWD = -2;
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = 0x0000_0200;
const O_EXCL = 0x0000_0800;
const O_NOFOLLOW = 0x0000_0100;
const O_DIRECTORY = 0x0010_0000;
const O_CLOEXEC = 0x0100_0000;
const DIRECTORY_OPEN_FLAGS = O_RDONLY | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC;
const RECORD_OPEN_FLAGS = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC;
const AF_INET = 2;
const SOCK_DGRAM = 2;
const F_SETFD = 2;
const FD_CLOEXEC = 1;
const EEXIST = 17;
const EADDRINUSE = 48;
const ENOENT = 2;

const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_BYTES = 136;
const PBI_PID_OFFSET = 12;
const PBI_START_SECONDS_OFFSET = 120;
const PBI_START_MICROSECONDS_OFFSET = 128;
const ESRCH = 3;

const ownedTokens = new Set<string>();

const darwinApi =
  process.platform === "darwin"
    ? dlopen(LIBSYSTEM_PATH, {
        __error: { args: [], returns: FFIType.ptr },
        bind: {
          args: [FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
        fcntl: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        mkdirat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
        openat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32],
          returns: FFIType.i32,
        },
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        renameat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
          returns: FFIType.i32,
        },
        socket: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        unlinkat: {
          args: [FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
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

type DescriptorHandle = {
  readonly descriptor: number;
  open: boolean;
};

type BoundDirectory = DescriptorHandle &
  Readonly<{
    readonly device: number;
    readonly inode: number;
  }>;

type KernelLease = DescriptorHandle;

export type DemoImapTestPortLeaseOptions = Readonly<{
  readonly preferredPort?: DemoImapTestPort;
  readonly directory?: string;
  readonly testOnlyFailure?: "directory-sync";
  readonly testOnlyDirectoryBoundObserver?: () => void;
}>;

function requireDarwinApi(): NonNullable<typeof darwinApi> {
  if (darwinApi === undefined) {
    throw new Error("demo IMAP test port leasing requires Darwin");
  }
  return darwinApi;
}

function currentErrno(): number {
  const errorPointer = requireDarwinApi().symbols.__error();
  return errorPointer === null ? 0 : read.i32(errorPointer, 0);
}

function isTestPort(value: unknown): value is DemoImapTestPort {
  return value === 6112 || value === 6113 || value === 6114;
}

function validateLeaseOptions(options: DemoImapTestPortLeaseOptions): void {
  if (options.preferredPort !== undefined && !isTestPort(options.preferredPort)) {
    throw new Error("demo IMAP test port must be 6112-6114");
  }
  if (options.testOnlyFailure !== undefined && options.testOnlyFailure !== "directory-sync") {
    throw new Error("demo IMAP test lease failure injection is invalid");
  }
  if (
    options.testOnlyDirectoryBoundObserver !== undefined &&
    typeof options.testOnlyDirectoryBoundObserver !== "function"
  ) {
    throw new Error("demo IMAP test lease directory observer is invalid");
  }
}

function closeDescriptorOnce(handle: DescriptorHandle): void {
  if (!handle.open) return;
  handle.open = false;
  closeSync(handle.descriptor);
}

function cString(value: string): Buffer {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("demo IMAP lease path component is invalid");
  }
  return Buffer.from(`${value}\0`, "utf8");
}

function normalizeDarwinPath(input: string): string {
  const absolute = resolve(input);
  for (const alias of ["tmp", "var", "etc"] as const) {
    const prefix = `/${alias}`;
    if (absolute === prefix || absolute.startsWith(`${prefix}/`)) {
      return `/private${absolute}`;
    }
  }
  return absolute;
}

function openAt(directoryDescriptor: number, name: string, flags: number, mode = 0): number {
  const bytes = cString(name);
  return requireDarwinApi().symbols.openat(directoryDescriptor, ptr(bytes), flags, mode);
}

function mkdirAt(directoryDescriptor: number, name: string, mode: number): number {
  const bytes = cString(name);
  return requireDarwinApi().symbols.mkdirat(directoryDescriptor, ptr(bytes), mode);
}

function unlinkAt(directoryDescriptor: number, name: string): number {
  const bytes = cString(name);
  return requireDarwinApi().symbols.unlinkat(directoryDescriptor, ptr(bytes), 0);
}

function renameAt(directoryDescriptor: number, source: string, destination: string): number {
  const sourceBytes = cString(source);
  const destinationBytes = cString(destination);
  return requireDarwinApi().symbols.renameat(
    directoryDescriptor,
    ptr(sourceBytes),
    directoryDescriptor,
    ptr(destinationBytes),
  );
}

function isSafeAncestor(stats: Stats, absolutePath: string, currentUid: number): boolean {
  if (!stats.isDirectory() || (stats.uid !== 0 && stats.uid !== currentUid)) return false;
  const permissions = stats.mode & 0o7777;
  if (absolutePath === "/private/tmp") {
    return stats.uid === 0 && permissions === 0o1777;
  }
  return (permissions & 0o022) === 0;
}

function verifyDirectoryDescriptor(
  descriptor: number,
  absolutePath: string,
  final: boolean,
): Readonly<{ readonly device: number; readonly inode: number }> {
  const stats: Stats = fstatSync(descriptor);
  const currentUid = process.getuid?.();
  if (
    currentUid === undefined ||
    !Number.isSafeInteger(stats.dev) ||
    !Number.isSafeInteger(stats.ino) ||
    stats.dev <= 0 ||
    stats.ino <= 0 ||
    (final
      ? !stats.isDirectory() || stats.uid !== currentUid || (stats.mode & 0o777) !== 0o700
      : !isSafeAncestor(stats, absolutePath, currentUid))
  ) {
    throw new Error("demo IMAP lease directory is not private");
  }
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

function openSecureLeaseDirectory(input: string): BoundDirectory {
  const absolute = normalizeDarwinPath(input);
  const components = absolute.split("/").filter((component) => component.length > 0);
  if (components.length === 0) {
    throw new Error("demo IMAP lease directory is not private");
  }

  const rootDescriptor = openAt(AT_FDCWD, "/", DIRECTORY_OPEN_FLAGS);
  if (rootDescriptor < 0) throw new Error("demo IMAP lease directory is unavailable");
  let current: DescriptorHandle = { descriptor: rootDescriptor, open: true };
  let currentPath = "";
  try {
    verifyDirectoryDescriptor(current.descriptor, "/", false);
    for (const [index, component] of components.entries()) {
      currentPath = `${currentPath}/${component}`;
      let childDescriptor = openAt(current.descriptor, component, DIRECTORY_OPEN_FLAGS);
      if (childDescriptor < 0 && currentErrno() === ENOENT) {
        if (mkdirAt(current.descriptor, component, 0o700) < 0 && currentErrno() !== EEXIST) {
          throw new Error("demo IMAP lease directory is unavailable");
        }
        fsyncSync(current.descriptor);
        childDescriptor = openAt(current.descriptor, component, DIRECTORY_OPEN_FLAGS);
      }
      if (childDescriptor < 0) {
        throw new Error("demo IMAP lease directory is not private");
      }
      const child: DescriptorHandle = { descriptor: childDescriptor, open: true };
      try {
        const final = index === components.length - 1;
        const identity = verifyDirectoryDescriptor(child.descriptor, currentPath, final);
        closeDescriptorOnce(current);
        current = child;
        if (final) {
          return {
            descriptor: current.descriptor,
            open: true,
            device: identity.device,
            inode: identity.inode,
          };
        }
      } catch (error: unknown) {
        closeDescriptorOnce(child);
        throw error;
      }
    }
  } catch (error: unknown) {
    closeDescriptorOnce(current);
    throw error;
  }
  closeDescriptorOnce(current);
  throw new Error("demo IMAP lease directory is unavailable");
}

function verifyBoundDirectory(directory: BoundDirectory): void {
  if (!directory.open) {
    throw new Error("demo IMAP lease directory descriptor is closed");
  }
  const stats: Stats = fstatSync(directory.descriptor);
  const currentUid = process.getuid?.();
  if (
    currentUid === undefined ||
    !stats.isDirectory() ||
    stats.uid !== currentUid ||
    (stats.mode & 0o777) !== 0o700 ||
    stats.dev !== directory.device ||
    stats.ino !== directory.inode
  ) {
    throw new Error("demo IMAP lease directory is not private");
  }
}

function observeProcessIdentity(pid: number): ProcessIdentityObservation {
  if (darwinApi === undefined) return { kind: "unknown" };
  const bytes = Buffer.alloc(PROC_BSDINFO_BYTES);
  const result = darwinApi.symbols.proc_pidinfo(
    pid,
    PROC_PIDTBSDINFO,
    0n,
    ptr(bytes),
    bytes.byteLength,
  );
  if (result === 0) {
    const errorPointer = darwinApi.symbols.__error();
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

function loopbackAddress(port: DemoImapTestPort): Buffer {
  // The authority namespace is exactly (AF_INET, SOCK_DGRAM, 127.0.0.1,
  // Hermes port). It has no derived filesystem or System V key to collide.
  const address = Buffer.alloc(16);
  address.writeUInt8(16, 0);
  address.writeUInt8(AF_INET, 1);
  address.writeUInt16BE(port, 2);
  address.writeUInt32BE(0x7f00_0001, 4);
  return address;
}

function acquireKernelLease(port: DemoImapTestPort): KernelLease | null {
  const descriptor = requireDarwinApi().symbols.socket(AF_INET, SOCK_DGRAM, 0);
  if (descriptor < 0) throw new Error("demo IMAP test port authority is unavailable");
  const lease: KernelLease = { descriptor, open: true };
  try {
    if (requireDarwinApi().symbols.fcntl(descriptor, F_SETFD, FD_CLOEXEC) < 0) {
      throw new Error("demo IMAP test port authority is unavailable");
    }
    const address = loopbackAddress(port);
    if (requireDarwinApi().symbols.bind(descriptor, ptr(address), address.byteLength) === 0) {
      return lease;
    }
    if (currentErrno() === EADDRINUSE) {
      closeDescriptorOnce(lease);
      return null;
    }
    throw new Error("demo IMAP test port authority is unavailable");
  } catch (error: unknown) {
    closeDescriptorOnce(lease);
    throw error;
  }
}

function publishDiagnostic(
  directory: BoundDirectory,
  record: LeaseRecord,
  testOnlyFailure: DemoImapTestPortLeaseOptions["testOnlyFailure"],
): void {
  verifyBoundDirectory(directory);
  const canonical = `${record.port}.json`;
  const candidate = `.${record.port}.${record.ownerToken}.candidate`;
  const descriptor = openAt(directory.descriptor, candidate, RECORD_OPEN_FLAGS, 0o600);
  if (descriptor < 0) throw new Error("demo IMAP lease diagnostic is unavailable");
  const file: DescriptorHandle = { descriptor, open: true };
  let failure: unknown;
  try {
    fchmodSync(file.descriptor, 0o600);
    const stats: Stats = fstatSync(file.descriptor);
    const currentUid = process.getuid?.();
    if (
      currentUid === undefined ||
      !stats.isFile() ||
      stats.uid !== currentUid ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.nlink !== 1
    ) {
      throw new Error("demo IMAP lease diagnostic is unsafe");
    }
    writeFileSync(file.descriptor, JSON.stringify(record), "utf8");
    fsyncSync(file.descriptor);
  } catch (error: unknown) {
    failure = error;
  }
  try {
    closeDescriptorOnce(file);
  } catch (error: unknown) {
    failure ??= error;
  }
  if (failure === undefined && renameAt(directory.descriptor, candidate, canonical) < 0) {
    failure = new Error("demo IMAP lease diagnostic publication failed");
  }
  if (failure === undefined && testOnlyFailure === "directory-sync") {
    failure = new Error("injected demo IMAP lease directory sync failure");
  }
  if (failure === undefined) {
    try {
      fsyncSync(directory.descriptor);
    } catch (error: unknown) {
      failure = error;
    }
  }
  if (failure !== undefined) {
    unlinkAt(directory.descriptor, candidate);
    try {
      fsyncSync(directory.descriptor);
    } catch {
      // The original bounded publication failure remains authoritative.
    }
    throw failure;
  }
}

function acquirePort(
  directory: BoundDirectory,
  port: DemoImapTestPort,
  testOnlyFailure: DemoImapTestPortLeaseOptions["testOnlyFailure"],
): Readonly<{ readonly kernelLease: KernelLease; readonly record: LeaseRecord }> | null {
  const kernelLease = acquireKernelLease(port);
  if (kernelLease === null) return null;
  const record: LeaseRecord = Object.freeze({
    schema: 1,
    port,
    pid: process.pid,
    processStartIdentity: currentProcessStartIdentity(),
    ownerToken: randomUUID(),
  });
  try {
    publishDiagnostic(directory, record, testOnlyFailure);
    return Object.freeze({ kernelLease, record });
  } catch (error: unknown) {
    try {
      closeDescriptorOnce(kernelLease);
    } catch {
      // The original diagnostic failure remains authoritative.
    }
    throw error;
  }
}

export function leaseDemoImapTestPort(
  options: DemoImapTestPortLeaseOptions = {},
): DemoImapTestPortLease {
  validateLeaseOptions(options);
  const directory = openSecureLeaseDirectory(options.directory ?? DEFAULT_LEASE_DIRECTORY);
  const ports =
    options.preferredPort === undefined ? DEMO_IMAP_TEST_PORTS : [options.preferredPort];
  try {
    options.testOnlyDirectoryBoundObserver?.();
    for (const port of ports) {
      const acquired = acquirePort(directory, port, options.testOnlyFailure);
      if (acquired === null) continue;
      ownedTokens.add(acquired.record.ownerToken);
      let released = false;
      return Object.freeze({
        port,
        release: () => {
          if (released) return;
          released = true;
          let failure: unknown;
          try {
            closeDescriptorOnce(acquired.kernelLease);
          } catch (error: unknown) {
            failure = error;
          }
          ownedTokens.delete(acquired.record.ownerToken);
          try {
            closeDescriptorOnce(directory);
          } catch (error: unknown) {
            failure ??= error;
          }
          if (failure !== undefined) throw failure;
        },
      });
    }
  } catch (error: unknown) {
    closeDescriptorOnce(directory);
    throw error;
  }
  closeDescriptorOnce(directory);
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
  _directory = DEFAULT_LEASE_DIRECTORY,
): boolean {
  if (!isTestPort(port)) throw new Error("demo IMAP test port must be 6112-6114");
  const probe = acquireKernelLease(port);
  if (probe === null) return true;
  closeDescriptorOnce(probe);
  return false;
}
