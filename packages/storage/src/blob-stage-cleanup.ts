import { createHash } from "node:crypto";
import { lstat, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { parseBlobStageFilename } from "./blob-stage";

/** The result of one platform process-identity observation. */
export type BlobStageProcessObservation =
  | Readonly<{ kind: "live"; processStartIdentity: string }>
  | Readonly<{ kind: "not-live" }>
  | Readonly<{ kind: "unknown"; reason: string }>;

export type BlobStageProcessInspector = (
  pid: number,
) => BlobStageProcessObservation | Promise<BlobStageProcessObservation>;

export type BlobStageCleanupOptions = Readonly<{
  /** A caller-validated, private directory reserved for staging blobs. */
  stagingDirectory: string;
  /** Platform boundary used to prove whether a recorded owner is abandoned. */
  inspectProcess: BlobStageProcessInspector;
}>;

export type BlobStageCleanupReason =
  | "removed-dead-owner"
  | "removed-pid-reuse"
  | "preserved-live-owner"
  | "preserved-unknown-owner"
  | "preserved-process-inspection-error"
  | "preserved-non-regular"
  | "preserved-malformed-name"
  | "preserved-canonical-name"
  | "preserved-quarantine-name"
  | "preserved-unknown-name"
  | "preserved-remove-error";

export type BlobStageCleanupEntry = Readonly<{
  /** A basename returned by the one directory scan; never an absolute path. */
  name: string;
  reason: BlobStageCleanupReason;
}>;

export type BlobStageCleanupResult = Readonly<{
  entries: readonly BlobStageCleanupEntry[];
  directorySync: "not-needed" | "synced" | "failed";
}>;

const CANONICAL_DIGEST = /^[0-9a-f]{64}$/u;
const QUARANTINE_NAME = /^\.quarantine-v1-[0-9a-f]{64}-[0-9a-f]{32}\.blob$/u;

function identityDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRegularEntry(entry: Dirent<string>): boolean {
  return entry.isFile();
}

function reasonForUnknownName(name: string): BlobStageCleanupReason {
  if (CANONICAL_DIGEST.test(name)) return "preserved-canonical-name";
  if (QUARANTINE_NAME.test(name)) return "preserved-quarantine-name";
  return /^\.stage(?:-|v)/u.test(name) ? "preserved-malformed-name" : "preserved-unknown-name";
}

async function syncStagingDirectory(directory: string): Promise<"synced" | "failed"> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
    return "synced";
  } catch {
    return "failed";
  } finally {
    await handle?.close();
  }
}

/**
 * Scan one caller-validated staging directory once and remove only regular
 * recognized stages whose owner is demonstrably abandoned. Age and mtime are
 * intentionally not consulted: identity is the sole removal proof.
 */
export async function cleanupAbandonedBlobStages(
  options: BlobStageCleanupOptions,
): Promise<BlobStageCleanupResult> {
  const directoryEntries = await readdir(options.stagingDirectory, { withFileTypes: true });
  const entries: BlobStageCleanupEntry[] = [];
  let deleted = false;

  for (const directoryEntry of directoryEntries) {
    const name = directoryEntry.name;
    const metadata = parseBlobStageFilename(name);
    if (metadata === undefined) {
      entries.push({ name, reason: reasonForUnknownName(name) });
      continue;
    }
    if (!isRegularEntry(directoryEntry)) {
      entries.push({ name, reason: "preserved-non-regular" });
      continue;
    }

    // Recheck the entry immediately before unlinking so a recognized symlink
    // or other replacement is never treated as an abandoned regular stage.
    let current;
    try {
      current = await lstat(join(options.stagingDirectory, name));
    } catch {
      entries.push({ name, reason: "preserved-non-regular" });
      continue;
    }
    if (!current.isFile()) {
      entries.push({ name, reason: "preserved-non-regular" });
      continue;
    }

    let observation: BlobStageProcessObservation;
    try {
      observation = await options.inspectProcess(metadata.pid);
    } catch {
      entries.push({ name, reason: "preserved-process-inspection-error" });
      continue;
    }

    let reason: "removed-dead-owner" | "removed-pid-reuse" | undefined;
    switch (observation.kind) {
      case "not-live":
        reason = "removed-dead-owner";
        break;
      case "live":
        if (identityDigest(observation.processStartIdentity) !== metadata.identityDigest) {
          reason = "removed-pid-reuse";
        }
        break;
      case "unknown":
        entries.push({ name, reason: "preserved-unknown-owner" });
        continue;
      default: {
        const exhaustive: never = observation;
        return exhaustive;
      }
    }
    if (reason === undefined) {
      entries.push({ name, reason: "preserved-live-owner" });
      continue;
    }

    try {
      await unlink(join(options.stagingDirectory, name));
      deleted = true;
      entries.push({ name, reason });
    } catch {
      // A concurrent disappearance is not evidence that this scan removed
      // the file; report it as preserved so the result remains conservative.
      entries.push({ name, reason: "preserved-remove-error" });
    }
  }

  return {
    entries,
    directorySync: deleted ? await syncStagingDirectory(options.stagingDirectory) : "not-needed",
  };
}
