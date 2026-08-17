import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HERMES_PORT_RANGE, PORT_ROLES, portRoleSchema, type PortRole } from "./ports";

/** The private default location for leases owned by this checkout. */
export const DEFAULT_PORT_LEASE_DIRECTORY = join(process.cwd(), ".agent-mail", "port-leases");

const processStartIdentity = randomUUID();

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
}>;

export type ReleasePortLeaseOptions = Readonly<{
  lease: Pick<PortLease, "role" | "ownerToken">;
  directory?: string;
}>;

export type PortLeaseReleaseResult = "released" | "already-released" | "not-owner";

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

/**
 * Atomically claims the port assigned to one role.
 *
 * `null` means another owner already holds the role. Existing or malformed
 * files are never replaced; stale-owner cleanup is deliberately out of scope.
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
  const path = leasePath(directory, role);
  const record = portLeaseRecordSchema.parse({
    project,
    role,
    port: PORT_ROLES[role],
    pid: process.pid,
    processStartIdentity,
    createdAt: new Date().toISOString(),
    ownerToken: randomUUID(),
  });

  await mkdir(directory, { recursive: true, mode: 0o700 });

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
  const path = leasePath(directory, role);
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
}
