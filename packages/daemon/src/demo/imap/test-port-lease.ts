import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEMO_IMAP_TEST_PORTS, type DemoImapTestPort, type DemoImapTestPortLease } from "./types";

const DEFAULT_LEASE_DIRECTORY = "/private/tmp/agent-mail-fm1-demo-imap-leases";
const ownedTokens = new Set<string>();

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
    value.processStartIdentity.length === 0 ||
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

function processExists(pid: number): "live" | "not-live" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error: unknown) {
    return isFileSystemError(error, "ESRCH") ? "not-live" : "unknown";
  }
}

function linuxProcessIdentity(pid: number): ProcessIdentityObservation {
  let contents: string;
  try {
    contents = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error: unknown) {
    return isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ESRCH")
      ? { kind: "not-live" }
      : { kind: "unknown" };
  }
  const commandEnd = contents.lastIndexOf(")");
  if (commandEnd < 0) return { kind: "unknown" };
  const fields = contents
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  if (fields[0] === "Z" || fields[0] === "X") return { kind: "not-live" };
  const startTime = fields[19];
  return startTime === undefined || startTime.length === 0
    ? { kind: "unknown" }
    : { kind: "live", processStartIdentity: `linux:${startTime}` };
}

function darwinProcessIdentity(pid: number): ProcessIdentityObservation {
  const liveness = processExists(pid);
  if (liveness !== "live") return { kind: liveness };
  try {
    const startTime = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return startTime.length === 0
      ? { kind: "unknown" }
      : { kind: "live", processStartIdentity: `darwin:${startTime}` };
  } catch {
    const afterFailure = processExists(pid);
    return afterFailure === "not-live" ? { kind: "not-live" } : { kind: "unknown" };
  }
}

function observeProcessIdentity(pid: number): ProcessIdentityObservation {
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (process.platform === "darwin") return darwinProcessIdentity(pid);
  return { kind: "unknown" };
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

function createRecord(path: string, record: LeaseRecord): boolean {
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
    throw failure;
  }
  let acquired = false;
  try {
    linkSync(candidate, path);
    acquired = true;
  } catch (error: unknown) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  } finally {
    try {
      unlinkSync(candidate);
    } catch {
      // The canonical hard link, when acquired, owns the durable record.
    }
  }
  return acquired;
}

function reclaimDeadOwner(path: string, record: LeaseRecord): boolean {
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
    if (createRecord(path, record)) return Object.freeze({ record, path });
    const existing = readRecord(path);
    if (existing === null || !reclaimDeadOwner(path, existing)) return null;
  }
  return null;
}

function releaseOwnedLease(path: string, record: LeaseRecord): void {
  const current = readRecord(path);
  if (current === null || current.ownerToken !== record.ownerToken) {
    ownedTokens.delete(record.ownerToken);
    return;
  }
  const retired = `${path}.released.${record.ownerToken}`;
  renameSync(path, retired);
  try {
    unlinkSync(retired);
  } finally {
    ownedTokens.delete(record.ownerToken);
  }
}

export function leaseDemoImapTestPort(
  options: DemoImapTestPortLeaseOptions = {},
): DemoImapTestPortLease {
  const directory = options.directory ?? DEFAULT_LEASE_DIRECTORY;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
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
        releaseOwnedLease(acquired.path, acquired.record);
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
