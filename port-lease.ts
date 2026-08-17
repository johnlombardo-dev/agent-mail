import { randomUUID } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { HERMES_PORT_RANGE, PORT_ROLES, portRoleSchema, type PortRole } from "./ports";

/** The private default location for leases owned by this checkout. */
export const DEFAULT_PORT_LEASE_DIRECTORY = join(process.cwd(), ".agent-mail", "port-leases");

const execFile = promisify(nodeExecFile);

/** The durable ownership record written for one role. */
export const portLeaseRecordSchema = z
  .strictObject({
    project: z.string().min(1),
    role: portRoleSchema,
    port: z.number().int().min(HERMES_PORT_RANGE.min).max(HERMES_PORT_RANGE.max),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    ownerToken: z.string().min(1),
  })
  .superRefine((record, context) => {
    if (record.port !== PORT_ROLES[record.role]) {
      context.addIssue({
        code: "custom",
        path: ["port"],
        message: `port ${record.port} is not assigned to role ${record.role}`,
      });
    }
  });

export type PortLease = z.infer<typeof portLeaseRecordSchema>;

export type AcquirePortLeaseOptions = Readonly<{
  project: string;
  role: PortRole;
  directory?: string;
  processIdentityAdapter?: ProcessIdentityAdapter;
}>;

export type ReleasePortLeaseOptions = Readonly<{
  lease: Pick<PortLease, "role" | "ownerToken">;
  directory?: string;
  processIdentityAdapter?: ProcessIdentityAdapter;
}>;

export type PortLeaseReleaseResult = "released" | "already-released" | "not-owner";

/** The result of asking the platform whether a process identity is still live. */
export const processIdentityObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("live"), processStartIdentity: z.string().min(1) }),
  z.strictObject({ kind: z.literal("not-live") }),
  z.strictObject({ kind: z.literal("unknown"), reason: z.string().min(1) }),
]);

export type ProcessIdentityObservation = z.infer<typeof processIdentityObservationSchema>;

/**
 * Platform identity is deliberately an injected boundary. Tests can provide a
 * deterministic implementation, while production uses the platform adapter
 * below. An unknown/error result is never sufficient evidence for reclaim.
 */
export type ProcessIdentityAdapter = Readonly<{
  currentProcessStartIdentity: () => Promise<string>;
  inspectProcess: (pid: number) => Promise<ProcessIdentityObservation>;
}>;

export type PortLeaseClassification =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{
      kind: "live";
      record: PortLease;
      ageMs: number;
    }>
  | Readonly<{
      kind: "stale";
      record: PortLease;
      ageMs: number;
      reason: "not-live" | "pid-reused";
    }>
  | Readonly<{
      kind: "unknown";
      record: PortLease;
      ageMs: number;
      reason: string;
    }>;

export type ClassifyPortLeaseOptions = Readonly<{
  role: PortRole;
  directory?: string;
  processIdentityAdapter?: ProcessIdentityAdapter;
}>;

export type ReclaimPortLeaseResult =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{
      kind: "reclaimed";
      previous: PortLease;
      retainedPath: string;
      reason: "not-live" | "pid-reused";
      ageMs: number;
    }>
  | Readonly<{ kind: "live"; record: PortLease; ageMs: number }>
  | Readonly<{ kind: "unknown"; record: PortLease; ageMs: number; reason: string }>
  | Readonly<{ kind: "busy" }>;

export type ReclaimPortLeaseOptions = ClassifyPortLeaseOptions;

/** The durable ownership record for the per-role operation mutex. */
export const portLeaseLockRecordSchema = z.strictObject({
  pid: z.number().int().positive(),
  processStartIdentity: z.string().min(1),
  ownerToken: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
});

export type PortLeaseLockRecord = z.infer<typeof portLeaseLockRecordSchema>;

type ExistingLease =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; record: PortLease }>
  | Readonly<{ kind: "invalid" }>;

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function leasePath(directory: string, role: PortRole): string {
  return join(directory, `${role}.json`);
}

function operationLockPath(directory: string, role: PortRole): string {
  return join(directory, `${role}.lock`);
}

function retainedLeasePath(directory: string, role: PortRole): string {
  return join(directory, `${role}.reclaimed.${Date.now()}-${randomUUID()}.json`);
}

function retainedLockPath(directory: string, role: PortRole): string {
  return join(directory, `${role}.lock.reclaimed.${Date.now()}-${randomUUID()}.json`);
}

function parseLeaseRecord(value: unknown): PortLease | null {
  const result = portLeaseRecordSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  return result.data;
}

async function readExistingLease(path: string): Promise<ExistingLease> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      return { kind: "absent" };
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(contents);
    const record = parseLeaseRecord(parsed);
    return record === null ? { kind: "invalid" } : { kind: "present", record };
  } catch {
    return { kind: "invalid" };
  }
}

type ExistingLock =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; record: PortLeaseLockRecord }>
  | Readonly<{ kind: "invalid" }>;

async function readExistingLock(path: string): Promise<ExistingLock> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      return { kind: "absent" };
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    const result = portLeaseLockRecordSchema.safeParse(parsed);
    return result.success ? { kind: "present", record: result.data } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

type LockOwnerClassification = "stale" | "live" | "unknown";

async function classifyExistingLock(
  existing: ExistingLock,
  adapter: ProcessIdentityAdapter,
): Promise<LockOwnerClassification> {
  if (existing.kind === "absent") return "stale";
  if (existing.kind === "invalid") return "unknown";
  let observation: ProcessIdentityObservation;
  try {
    observation = processIdentityObservationSchema.parse(
      await adapter.inspectProcess(existing.record.pid),
    );
  } catch {
    return "unknown";
  }
  if (observation.kind === "not-live") return "stale";
  if (observation.kind === "unknown") return "unknown";
  return observation.processStartIdentity === existing.record.processStartIdentity
    ? "live"
    : "stale";
}

async function withRoleLock<T>(
  directory: string,
  role: PortRole,
  adapter: ProcessIdentityAdapter,
  operation: () => Promise<T>,
): Promise<T | null> {
  const path = operationLockPath(directory, role);
  const existing = await readExistingLock(path);
  const lockState = await classifyExistingLock(existing, adapter);
  if (lockState === "live" || lockState === "unknown") {
    return null;
  }
  // Resolve our identity before moving stale evidence. If this boundary is
  // unavailable, leave the existing lock untouched and fail closed.
  const processStartIdentity = await adapter.currentProcessStartIdentity();
  if (existing.kind === "present") {
    // The identity proof is complete before moving the old lock. Rename is
    // atomic; after it, make one and only one acquisition attempt.
    await rename(path, retainedLockPath(directory, role));
  }

  const lockRecord = portLeaseLockRecordSchema.parse({
    pid: process.pid,
    processStartIdentity,
    ownerToken: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error: unknown) {
    // A competing operation owns the lock. Returning null is fail-closed and
    // avoids ever unlinking a lease read before another operation acquired it.
    if (isFileSystemError(error, "EEXIST")) {
      return null;
    }
    throw error;
  }

  let outcome:
    | Readonly<{ kind: "fulfilled"; value: T }>
    | Readonly<{ kind: "rejected"; error: unknown }>;
  try {
    await handle.writeFile(JSON.stringify(lockRecord), "utf8");
    await handle.sync();
    outcome = { kind: "fulfilled", value: await operation() };
  } catch (error: unknown) {
    outcome = { kind: "rejected", error };
  }

  let cleanupError: unknown = null;
  try {
    await handle.close();
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }
  } catch (error: unknown) {
    cleanupError = error;
  }
  if (outcome.kind === "rejected") {
    throw outcome.error;
  }
  if (cleanupError !== null) {
    throw cleanupError;
  }
  return outcome.value;
}

async function readLinuxProcessStartIdentity(pid: number): Promise<ProcessIdentityObservation> {
  let contents: string;
  try {
    contents = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT") || isFileSystemError(error, "ESRCH")) {
      return { kind: "not-live" };
    }
    return { kind: "unknown", reason: error instanceof Error ? error.message : "proc read failed" };
  }

  // The command name may contain spaces and ')' characters. The final ')' is
  // the end of field 2; field 22 (starttime) is then item 19 in the remainder.
  const commandEnd = contents.lastIndexOf(")");
  if (commandEnd < 0) {
    return { kind: "unknown", reason: "malformed /proc process record" };
  }
  const fields = contents
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  if (state === "Z" || state === "X") {
    return { kind: "not-live" };
  }
  const startTime = fields[19];
  if (startTime === undefined || startTime.length === 0) {
    return { kind: "unknown", reason: "missing process start identity" };
  }
  return { kind: "live", processStartIdentity: `linux:${startTime}` };
}

export type DarwinProcessIdentityProbe = Readonly<{
  processExists: (pid: number) => void;
  queryStartIdentity: (pid: number) => Promise<string>;
}>;

export async function inspectDarwinProcessIdentity(
  pid: number,
  probe: DarwinProcessIdentityProbe = {
    processExists: (candidatePid) => process.kill(candidatePid, 0),
    queryStartIdentity: async (candidatePid) => {
      const result = await execFile("ps", ["-o", "lstart=", "-p", String(candidatePid)]);
      return result.stdout;
    },
  },
): Promise<ProcessIdentityObservation> {
  try {
    probe.processExists(pid);
  } catch (error: unknown) {
    if (isFileSystemError(error, "ESRCH")) return { kind: "not-live" };
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "unknown";
    return { kind: "unknown", reason: `process liveness probe failed: ${code}` };
  }

  try {
    const startTime = (await probe.queryStartIdentity(pid)).trim();
    return startTime.length === 0
      ? { kind: "unknown", reason: "missing process start identity" }
      : { kind: "live", processStartIdentity: `darwin:${startTime}` };
  } catch (error: unknown) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : "ps process lookup failed",
    };
  }
}

async function readDarwinProcessStartIdentity(pid: number): Promise<ProcessIdentityObservation> {
  return inspectDarwinProcessIdentity(pid);
}

async function inspectPlatformProcess(pid: number): Promise<ProcessIdentityObservation> {
  if (process.platform === "linux") {
    return readLinuxProcessStartIdentity(pid);
  }
  if (process.platform === "darwin") {
    return readDarwinProcessStartIdentity(pid);
  }
  return { kind: "unknown", reason: `unsupported process identity platform: ${process.platform}` };
}

export const platformProcessIdentityAdapter: ProcessIdentityAdapter = Object.freeze({
  currentProcessStartIdentity: async () => {
    const observation = await inspectPlatformProcess(process.pid);
    if (observation.kind !== "live") {
      throw new Error(
        observation.kind === "unknown"
          ? observation.reason
          : "current process is not live while creating a port lease",
      );
    }
    return observation.processStartIdentity;
  },
  inspectProcess: inspectPlatformProcess,
});

const defaultProcessIdentityAdapter = platformProcessIdentityAdapter;

function leaseAgeMs(record: PortLease): number {
  const timestamp = Date.parse(record.createdAt);
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : 0;
}

async function classifyExistingLease(
  existing: ExistingLease,
  adapter: ProcessIdentityAdapter,
): Promise<PortLeaseClassification> {
  switch (existing.kind) {
    case "absent":
      return existing;
    case "invalid":
      return existing;
    case "present": {
      const ageMs = leaseAgeMs(existing.record);
      let observation: ProcessIdentityObservation;
      try {
        observation = processIdentityObservationSchema.parse(
          await adapter.inspectProcess(existing.record.pid),
        );
      } catch (error: unknown) {
        return {
          kind: "unknown",
          record: existing.record,
          ageMs,
          reason: error instanceof Error ? error.message : "process identity lookup failed",
        };
      }
      switch (observation.kind) {
        case "live":
          return observation.processStartIdentity === existing.record.processStartIdentity
            ? { kind: "live", record: existing.record, ageMs }
            : { kind: "stale", record: existing.record, ageMs, reason: "pid-reused" };
        case "not-live":
          return { kind: "stale", record: existing.record, ageMs, reason: "not-live" };
        case "unknown":
          return { kind: "unknown", record: existing.record, ageMs, reason: observation.reason };
        default: {
          const exhaustive: never = observation;
          return exhaustive;
        }
      }
    }
    default: {
      const exhaustive: never = existing;
      return exhaustive;
    }
  }
}

/** Classifies an existing record. Age is returned for diagnostics only. */
export async function classifyPortLease(
  options: ClassifyPortLeaseOptions,
): Promise<PortLeaseClassification> {
  const role = portRoleSchema.parse(options.role);
  const directory = z
    .string()
    .min(1)
    .parse(options.directory ?? DEFAULT_PORT_LEASE_DIRECTORY);
  const adapter = options.processIdentityAdapter ?? defaultProcessIdentityAdapter;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readExistingLease(leasePath(directory, role));
  return classifyExistingLease(existing, adapter);
}

async function reclaimExistingLease(
  directory: string,
  role: PortRole,
  adapter: ProcessIdentityAdapter,
): Promise<ReclaimPortLeaseResult> {
  const path = leasePath(directory, role);
  const classification = await classifyExistingLease(await readExistingLease(path), adapter);
  switch (classification.kind) {
    case "absent":
    case "invalid":
      return classification;
    case "live":
    case "unknown":
      return classification;
    case "stale": {
      // Stale proof is complete before moving the old record, so the old
      // bytes remain available for later diagnosis if retention fails.
      const retainedPath = retainedLeasePath(directory, role);
      // rename is one filesystem operation: no caller can observe a missing
      // old record between stale proof and retention, and the old bytes remain
      // available for tests and incident diagnosis.
      await rename(path, retainedPath);
      return {
        kind: "reclaimed",
        previous: classification.record,
        retainedPath,
        reason: classification.reason,
        ageMs: classification.ageMs,
      };
    }
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }
}

/** Reclaims only a lease whose PID/start identity no longer names its owner. */
export async function reclaimPortLease(
  options: ReclaimPortLeaseOptions,
): Promise<ReclaimPortLeaseResult> {
  const role = portRoleSchema.parse(options.role);
  const directory = z
    .string()
    .min(1)
    .parse(options.directory ?? DEFAULT_PORT_LEASE_DIRECTORY);
  const adapter = options.processIdentityAdapter ?? defaultProcessIdentityAdapter;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = await withRoleLock(directory, role, adapter, () =>
    reclaimExistingLease(directory, role, adapter),
  );
  // A competing operation is not evidence of staleness. Fail closed.
  return result ?? { kind: "busy" };
}

/** Compatibility spelling for callers that name cleanup explicitly. */
export const reclaimStalePortLease = reclaimPortLease;

/**
 * Atomically claims the port assigned to one role.
 *
 * `null` means another live/unknown/invalid owner already holds the role.
 * A stale record is retained as evidence before the role is reclaimed.
 */
export async function acquirePortLease(
  options: AcquirePortLeaseOptions,
): Promise<PortLease | null> {
  const project = z.string().min(1).parse(options.project);
  const role = portRoleSchema.parse(options.role);
  const directory = z
    .string()
    .min(1)
    .parse(options.directory ?? DEFAULT_PORT_LEASE_DIRECTORY);
  const adapter = options.processIdentityAdapter ?? defaultProcessIdentityAdapter;
  const path = leasePath(directory, role);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = await withRoleLock(directory, role, adapter, async () => {
    const existing = await readExistingLease(path);
    const classification = await classifyExistingLease(existing, adapter);
    const replacementIdentity =
      classification.kind === "stale" ? await adapter.currentProcessStartIdentity() : null;
    switch (classification.kind) {
      case "live":
      case "unknown":
      case "invalid":
        return null;
      case "stale":
        // Keep stale bytes as retained evidence before creating the new record.
        await rename(path, retainedLeasePath(directory, role));
        break;
      case "absent":
        break;
      default: {
        const exhaustive: never = classification;
        return exhaustive;
      }
    }

    const processStartIdentity =
      replacementIdentity ?? (await adapter.currentProcessStartIdentity());
    const record = portLeaseRecordSchema.parse({
      project,
      role,
      port: PORT_ROLES[role],
      pid: process.pid,
      processStartIdentity,
      createdAt: new Date().toISOString(),
      ownerToken: randomUUID(),
    });
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error: unknown) {
      if (isFileSystemError(error, "EEXIST")) {
        return null;
      }
      throw error;
    }

    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
      return record;
    } catch (error: unknown) {
      try {
        await unlink(path);
      } catch (cleanupError: unknown) {
        if (!isFileSystemError(cleanupError, "ENOENT")) {
          throw cleanupError;
        }
      }
      throw error;
    } finally {
      await handle.close();
    }
  });
  return result;
}

/**
 * Releases a role only when the persisted owner token matches exactly.
 * Releasing an already absent lease is an idempotent success for that owner;
 * a different live token is preserved and reported as `not-owner`.
 */
export async function releasePortLease(
  options: ReleasePortLeaseOptions,
): Promise<PortLeaseReleaseResult> {
  const role = portRoleSchema.parse(options.lease.role);
  const ownerToken = z.string().min(1).parse(options.lease.ownerToken);
  const directory = z
    .string()
    .min(1)
    .parse(options.directory ?? DEFAULT_PORT_LEASE_DIRECTORY);
  const adapter = options.processIdentityAdapter ?? defaultProcessIdentityAdapter;
  const path = leasePath(directory, role);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = await withRoleLock(directory, role, adapter, async () => {
    const existing = await readExistingLease(path);
    switch (existing.kind) {
      case "absent":
        return "already-released";
      case "invalid":
        return "not-owner";
      case "present":
        if (existing.record.ownerToken !== ownerToken) {
          return "not-owner";
        }
        try {
          await unlink(path);
          return "released";
        } catch (error: unknown) {
          if (isFileSystemError(error, "ENOENT")) {
            return "already-released";
          }
          throw error;
        }
      default: {
        const exhaustive: never = existing;
        return exhaustive;
      }
    }
  });
  // A competing operation cannot safely be interpreted as released.
  return result ?? "not-owner";
}
