import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { restoreBackup } from "./backup-restore";
import type { BackupManifest } from "./backup-manifest";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MANIFEST_NAME = "manifest.json";
const SHA256 = /^[0-9a-f]{64}$/u;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,511}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_TARGET_LENGTH = 4_096;
const MAX_BACKUP_PATH_LENGTH = 4_096;
const MAX_MANIFEST_ID_LENGTH = 256;

/** The exact destructive request from the shared admin contract. */
export type OfflineRootReplacementRequest = Readonly<{
  readonly target: string;
  readonly manifest: Readonly<{
    readonly manifestId: string;
    readonly digest: string;
  }>;
  readonly confirmationNonce: string;
  readonly offline: true;
}>;

/** The supervisor's proof that no service currently owns the target root. */
export type OfflineSupervisorProof = Readonly<{
  readonly kind: "offline-supervisor";
  readonly target: string;
  readonly confirmationNonce: string;
  readonly validatedAt: string;
}>;

export type OfflineSupervisorValidator = (
  token: unknown,
  context: Readonly<{
    readonly target: string;
    readonly backupPath: string;
    readonly confirmationNonce: string;
  }>,
) => OfflineSupervisorProof | Promise<OfflineSupervisorProof>;

export type RootReplacementFailurePoint =
  | "before-rename-live-to-rollback"
  | "after-rename-live-to-rollback"
  | "before-rename-stage-to-target"
  | "after-rename-stage-to-target"
  | "before-post-swap-permissions"
  | "after-post-swap-permissions"
  | "before-post-swap-manifest"
  | "after-post-swap-manifest"
  | "before-post-swap-repository"
  | "after-post-swap-repository";

export type RootReplacementFailureInjector = (
  point: RootReplacementFailurePoint,
) => void | Promise<void>;

export type RootReplacementRepositoryVerifier = (
  context: Readonly<{
    readonly rootPath: string;
    readonly backupPath: string;
    readonly manifest: BackupManifest;
    readonly manifestIdentity: OfflineRootReplacementRequest["manifest"];
  }>,
) => void | Promise<void>;

export type RootPathDisposition =
  | "absent"
  | "directory"
  | "symlink"
  | "non-directory"
  | "unreadable";

export type RootReplacementDisposition = Readonly<{
  readonly target: RootPathDisposition;
  readonly rollback: RootPathDisposition;
  readonly stage: RootPathDisposition;
}>;

export type RootReplacementRollback =
  | Readonly<{ readonly attempted: false; readonly status: "not-needed" }>
  | Readonly<{
      readonly attempted: true;
      readonly status: "succeeded" | "failed";
      readonly error?: string;
    }>;

export type RootReplacementEventStatus = "entered" | "completed" | "failed";
export type RootReplacementEvent = Readonly<{
  readonly point: RootReplacementFailurePoint;
  readonly status: RootReplacementEventStatus;
}>;

export type RootReplacementState =
  | "validated"
  | "staging"
  | "staged"
  | "live-renamed"
  | "swapped"
  | "verified"
  | "completed"
  | "rolled-back"
  | "recoverable-swap";

export type OfflineRootReplacementOptions = Readonly<{
  /** Untrusted request data is parsed before any filesystem mutation. */
  readonly request: unknown;
  /** The exact selected backup path. No backup discovery or newest selection occurs. */
  readonly backupPath: string;
  /** A selected token from the supervisor boundary; never synthesized here. */
  readonly offlineToken: unknown;
  readonly validateOfflineToken: OfflineSupervisorValidator;
  /** Mandatory composed repository proof after the atomic swap. */
  readonly verifyRepository: RootReplacementRepositoryVerifier;
  /** Test/operations seam for every destructive boundary and post-swap check. */
  readonly injectFailure?: RootReplacementFailureInjector;
}>;

export type OfflineRootReplacementResult = Readonly<{
  readonly state: "completed";
  readonly targetPath: string;
  readonly rollbackPath: string;
  /** Retained for exact disposition reporting; it is absent on success. */
  readonly stagePath: string;
  readonly manifest: BackupManifest;
  readonly manifestIdentity: OfflineRootReplacementRequest["manifest"];
  readonly rollback: RootReplacementRollback;
  readonly disposition: RootReplacementDisposition;
  readonly events: readonly RootReplacementEvent[];
}>;

export type OfflineRootReplacementErrorCode =
  | "invalid-request"
  | "invalid-token"
  | "invalid-target"
  | "invalid-backup"
  | "manifest-mismatch"
  | "stage-failed"
  | "rename-failed"
  | "post-swap-verification-failed"
  | "rollback-failed";

/** Stable error carrying the observed root disposition after an interruption. */
export class OfflineRootReplacementError extends Error {
  readonly code: OfflineRootReplacementErrorCode;
  readonly state: RootReplacementState;
  readonly targetPath: string | undefined;
  readonly rollbackPath: string | undefined;
  readonly stagePath: string | undefined;
  readonly rollback: RootReplacementRollback;
  readonly disposition: RootReplacementDisposition | undefined;
  readonly events: readonly RootReplacementEvent[];

  constructor(
    code: OfflineRootReplacementErrorCode,
    message: string,
    options: Readonly<{
      readonly state: RootReplacementState;
      readonly targetPath?: string;
      readonly rollbackPath?: string;
      readonly stagePath?: string;
      readonly rollback: RootReplacementRollback;
      readonly disposition?: RootReplacementDisposition;
      readonly events: readonly RootReplacementEvent[];
      readonly cause?: unknown;
    }>,
  ) {
    super(message, { cause: options.cause });
    this.name = "OfflineRootReplacementError";
    this.code = code;
    this.state = options.state;
    this.targetPath = options.targetPath;
    this.rollbackPath = options.rollbackPath;
    this.stagePath = options.stagePath;
    this.rollback = options.rollback;
    this.disposition = options.disposition;
    this.events = Object.freeze([...options.events]);
  }
}

type RecordValue = Readonly<Record<string, unknown>>;
type SwapState = "not-started" | "live-renamed" | "stage-renamed";

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || (point >= 0x7f && point <= 0x9f))) return true;
  }
  return false;
}

function isManifestId(value: string): boolean {
  const suffix = value.slice("manifest:".length);
  const first = suffix[0];
  return (
    value.length <= MAX_MANIFEST_ID_LENGTH &&
    value.trim() === value &&
    value.startsWith("manifest:") &&
    suffix.length > 0 &&
    first !== undefined &&
    !/\s/u.test(first) &&
    first !== ":" &&
    !hasControlCharacters(value)
  );
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_TARGET_LENGTH &&
    value.trim() === value &&
    !value.includes("\0") &&
    !hasControlCharacters(value) &&
    isAbsolute(value) &&
    normalize(value) === value &&
    value !== parse(value).root &&
    !value.startsWith("//") &&
    !value.endsWith("/") &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function requireString(record: RecordValue, key: string): string {
  const value = record[key];
  if (typeof value !== "string")
    throw new OfflineRootReplacementError("invalid-request", `request.${key} is invalid`, {
      state: "validated",
      rollback: { attempted: false, status: "not-needed" },
      events: [],
    });
  return value;
}

function parseRequest(value: unknown, backupPath: string): OfflineRootReplacementRequest {
  if (!isRecord(value)) {
    throw new OfflineRootReplacementError(
      "invalid-request",
      "offline root replacement request is invalid",
      {
        state: "validated",
        rollback: { attempted: false, status: "not-needed" },
        events: [],
      },
    );
  }
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["confirmationNonce", "manifest", "offline", "target"].join("\0")) {
    throw new OfflineRootReplacementError(
      "invalid-request",
      "offline root replacement request has unknown fields",
      {
        state: "validated",
        rollback: { attempted: false, status: "not-needed" },
        events: [],
      },
    );
  }
  const target = requireString(value, "target");
  const confirmationNonce = requireString(value, "confirmationNonce");
  if (!isCanonicalAbsolutePath(target)) {
    throw new OfflineRootReplacementError(
      "invalid-target",
      "target must be an exact canonical absolute path",
      {
        state: "validated",
        targetPath: target,
        rollback: { attempted: false, status: "not-needed" },
        events: [],
      },
    );
  }
  if (
    typeof backupPath !== "string" ||
    backupPath.length > MAX_BACKUP_PATH_LENGTH ||
    !isCanonicalAbsolutePath(backupPath)
  ) {
    throw new OfflineRootReplacementError(
      "invalid-backup",
      "backupPath must be an exact canonical absolute path",
      {
        state: "validated",
        targetPath: target,
        rollback: { attempted: false, status: "not-needed" },
        events: [],
      },
    );
  }
  if (confirmationNonce.trim() !== confirmationNonce || !NONCE.test(confirmationNonce)) {
    throw new OfflineRootReplacementError("invalid-request", "confirmationNonce is invalid", {
      state: "validated",
      targetPath: target,
      rollback: { attempted: false, status: "not-needed" },
      events: [],
    });
  }
  if (value.offline !== true || !isRecord(value.manifest)) {
    throw new OfflineRootReplacementError("invalid-request", "offline and manifest are required", {
      state: "validated",
      targetPath: target,
      rollback: { attempted: false, status: "not-needed" },
      events: [],
    });
  }
  const manifestKeys = Object.keys(value.manifest).sort();
  if (manifestKeys.join("\0") !== ["digest", "manifestId"].join("\0")) {
    throw new OfflineRootReplacementError(
      "invalid-request",
      "manifest identity has unknown fields",
      {
        state: "validated",
        targetPath: target,
        rollback: { attempted: false, status: "not-needed" },
        events: [],
      },
    );
  }
  const manifestId = value.manifest.manifestId;
  const digest = value.manifest.digest;
  if (
    typeof manifestId !== "string" ||
    !isManifestId(manifestId) ||
    typeof digest !== "string" ||
    !SHA256.test(digest)
  ) {
    throw new OfflineRootReplacementError("invalid-request", "manifest identity is invalid", {
      state: "validated",
      targetPath: target,
      rollback: { attempted: false, status: "not-needed" },
      events: [],
    });
  }
  return Object.freeze({
    target,
    manifest: Object.freeze({ manifestId, digest }),
    confirmationNonce,
    offline: true,
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertOwnerOnly(
  mode: number | bigint,
  path: string,
  code: OfflineRootReplacementErrorCode,
): void {
  const permissions = typeof mode === "bigint" ? mode & 0o77n : mode & 0o077;
  if (permissions !== 0 && permissions !== 0n) {
    throw new OfflineRootReplacementError(code, "root path is not owner-only", {
      state: "validated",
      targetPath: path,
      rollback: { attempted: false, status: "not-needed" },
      events: [],
    });
  }
}

async function assertPrivateDirectory(
  path: string,
  code: "invalid-target" | "invalid-backup",
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    throw new OfflineRootReplacementError(code, "private root is unavailable", {
      state: "validated",
      targetPath: path,
      rollback: { attempted: false, status: "not-needed" },
      events: [],
      cause: error,
    });
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new OfflineRootReplacementError(code, "private root must be a regular directory", {
      state: "validated",
      targetPath: path,
      rollback: { attempted: false, status: "not-needed" },
      events: [],
    });
  }
  assertOwnerOnly(info.mode, path, code);
  const callerUid = process.getuid?.();
  if (callerUid !== undefined && info.uid !== callerUid) {
    throw new OfflineRootReplacementError(code, "private root is not owned by the caller", {
      state: "validated",
      targetPath: path,
      rollback: { attempted: false, status: "not-needed" },
      events: [],
    });
  }
}

async function pathDisposition(path: string): Promise<RootPathDisposition> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    return "non-directory";
  } catch (error: unknown) {
    return isMissing(error) ? "absent" : "unreadable";
  }
}

async function disposition(
  targetPath: string,
  rollbackPath: string,
  stagePath: string,
): Promise<RootReplacementDisposition> {
  const [target, rollback, stage] = await Promise.all([
    pathDisposition(targetPath),
    pathDisposition(rollbackPath),
    pathDisposition(stagePath),
  ]);
  return Object.freeze({ target, rollback, stage });
}

async function makeSibling(parent: string, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(parent, `${prefix}${process.pid}-${randomBytes(16).toString("hex")}.tmp`);
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(path, PRIVATE_DIRECTORY_MODE);
      return path;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("could not allocate a unique sibling root");
}

async function makeUniqueSiblingPath(parent: string, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(parent, `${prefix}${process.pid}-${randomBytes(16).toString("hex")}.tmp`);
    try {
      await lstat(path);
    } catch (error: unknown) {
      if (isMissing(error)) return path;
      throw error;
    }
  }
  throw new Error("could not allocate a unique rollback root");
}

async function readManifestIdentity(
  path: string,
): Promise<Readonly<{ manifestId: string; digest: string }>> {
  const raw = await readFile(join(path, MANIFEST_NAME), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error("root manifest is not valid JSON", { cause: error });
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.manifestId !== "string" ||
    typeof parsed.manifestSha256 !== "string"
  ) {
    throw new Error("root manifest identity is missing");
  }
  return { manifestId: parsed.manifestId, digest: parsed.manifestSha256 };
}

async function writeStageManifest(
  stagePath: string,
  backupPath: string,
  identity: OfflineRootReplacementRequest["manifest"],
): Promise<void> {
  const raw = await readFile(join(backupPath, MANIFEST_NAME), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error("selected backup manifest is not valid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("selected backup manifest is not an object");
  const enriched = { ...parsed, manifestId: identity.manifestId };
  await writeFile(join(stagePath, MANIFEST_NAME), JSON.stringify(enriched), {
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(join(stagePath, MANIFEST_NAME), PRIVATE_FILE_MODE);
}

async function verifyPrivateTree(rootPath: string): Promise<void> {
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("root contains a symbolic link");
    if ((info.mode & 0o077) !== 0) throw new Error("root contains a non-private path");
    if (!info.isDirectory()) return;
    const entries = await readdir(path, { withFileTypes: true, encoding: "utf8" });
    for (const entry of entries) await visit(join(path, entry.name));
  }
  await visit(rootPath);
}

async function invokeFailurePoint(
  point: RootReplacementFailurePoint,
  injectFailure: RootReplacementFailureInjector | undefined,
  events: RootReplacementEvent[],
): Promise<void> {
  events.push({ point, status: "entered" });
  try {
    await injectFailure?.(point);
    events.push({ point, status: "completed" });
  } catch (error: unknown) {
    events.push({ point, status: "failed" });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown rollback failure";
}

async function attemptRollback(
  swapState: SwapState,
  targetPath: string,
  rollbackPath: string,
  stagePath: string,
): Promise<RootReplacementRollback> {
  if (swapState === "not-started") return { attempted: false, status: "not-needed" };
  try {
    if (swapState === "live-renamed") {
      await rename(rollbackPath, targetPath);
      return { attempted: true, status: "succeeded" };
    }
    // The new target is moved back to its known stage path before the old
    // root is restored. No rollback directory is ever deleted recursively.
    await rename(targetPath, stagePath);
    await rename(rollbackPath, targetPath);
    return { attempted: true, status: "succeeded" };
  } catch (error: unknown) {
    return { attempted: true, status: "failed", error: errorMessage(error) };
  }
}

/**
 * Replace one exact private root from one exact verified backup while offline.
 * The live root is never copied into or recursively overwritten. The old root
 * remains at `rollbackPath` after success for an explicit later cleanup action.
 */
export async function replaceOfflinePrivateRoot(
  options: OfflineRootReplacementOptions,
): Promise<OfflineRootReplacementResult> {
  const request = parseRequest(options.request, options.backupPath);
  const events: RootReplacementEvent[] = [];
  let targetPath = request.target;
  let rollbackPath: string | undefined;
  let stagePath: string | undefined;
  let state: RootReplacementState = "validated";
  let swapState: SwapState = "not-started";
  let rollback: RootReplacementRollback = { attempted: false, status: "not-needed" };

  try {
    await assertPrivateDirectory(dirname(request.target), "invalid-target");
    await assertPrivateDirectory(request.target, "invalid-target");
    try {
      await verifyPrivateTree(request.target);
    } catch (error: unknown) {
      throw new OfflineRootReplacementError(
        "invalid-target",
        "live root is not a verified private tree",
        {
          state,
          targetPath,
          rollback,
          events,
          cause: error,
        },
      );
    }
    await assertPrivateDirectory(options.backupPath, "invalid-backup");
    let proof: OfflineSupervisorProof;
    try {
      proof = await options.validateOfflineToken(options.offlineToken, {
        target: request.target,
        backupPath: options.backupPath,
        confirmationNonce: request.confirmationNonce,
      });
    } catch (error: unknown) {
      throw new OfflineRootReplacementError(
        "invalid-token",
        "offline supervisor token was rejected",
        {
          state,
          targetPath,
          rollback,
          events,
          cause: error,
        },
      );
    }
    if (
      !isRecord(proof) ||
      Object.keys(proof).sort().join("\0") !==
        ["confirmationNonce", "kind", "target", "validatedAt"].join("\0") ||
      proof.kind !== "offline-supervisor" ||
      proof.target !== request.target ||
      proof.confirmationNonce !== request.confirmationNonce ||
      typeof proof.validatedAt !== "string" ||
      !INSTANT.test(proof.validatedAt)
    ) {
      throw new OfflineRootReplacementError(
        "invalid-token",
        "offline supervisor proof does not match the request",
        {
          state,
          targetPath,
          rollback,
          events,
        },
      );
    }

    stagePath = await makeSibling(dirname(request.target), ".replace-stage-v1-");
    rollbackPath = await makeUniqueSiblingPath(dirname(request.target), ".replace-rollback-v1-");
    state = "staging";
    let restored: Awaited<ReturnType<typeof restoreBackup>>;
    try {
      restored = await restoreBackup({ backupPath: options.backupPath, destination: stagePath });
      if (restored.manifest.manifestSha256 !== request.manifest.digest) {
        throw new OfflineRootReplacementError(
          "manifest-mismatch",
          "selected backup manifest digest does not match the request",
          {
            state,
            targetPath,
            rollbackPath,
            stagePath,
            rollback,
            events,
          },
        );
      }
      await writeStageManifest(stagePath, options.backupPath, request.manifest);
      await verifyPrivateTree(stagePath);
      const stagedIdentity = await readManifestIdentity(stagePath);
      if (
        stagedIdentity.manifestId !== request.manifest.manifestId ||
        stagedIdentity.digest !== request.manifest.digest
      ) {
        throw new Error("staged manifest identity does not match the selected backup");
      }
    } catch (error: unknown) {
      throw error instanceof OfflineRootReplacementError
        ? error
        : new OfflineRootReplacementError("stage-failed", "verified backup staging failed", {
            state,
            targetPath,
            rollbackPath,
            stagePath,
            rollback,
            events,
            cause: error,
          });
    }
    state = "staged";

    try {
      await invokeFailurePoint("before-rename-live-to-rollback", options.injectFailure, events);
      await rename(request.target, rollbackPath);
      swapState = "live-renamed";
      state = "live-renamed";
      await invokeFailurePoint("after-rename-live-to-rollback", options.injectFailure, events);
      await invokeFailurePoint("before-rename-stage-to-target", options.injectFailure, events);
      await rename(stagePath, request.target);
      swapState = "stage-renamed";
      state = "swapped";
      await invokeFailurePoint("after-rename-stage-to-target", options.injectFailure, events);
    } catch (error: unknown) {
      const cause = error;
      rollback = await attemptRollback(swapState, request.target, rollbackPath, stagePath);
      const finalDisposition = await disposition(request.target, rollbackPath, stagePath);
      if (rollback.status === "succeeded" && swapState === "live-renamed") {
        await rm(stagePath, { force: true, recursive: true });
      }
      if (swapState === "not-started") {
        await rm(stagePath, { force: true, recursive: true });
      }
      const afterCleanup = await disposition(request.target, rollbackPath, stagePath);
      throw new OfflineRootReplacementError(
        rollback.status === "failed" ? "rollback-failed" : "rename-failed",
        rollback.status === "failed"
          ? "root replacement failed and rollback is recoverable"
          : "root replacement rename was interrupted",
        {
          state: rollback.status === "failed" ? "recoverable-swap" : "rolled-back",
          targetPath: request.target,
          rollbackPath,
          stagePath,
          rollback,
          disposition: afterCleanup ?? finalDisposition,
          events,
          cause,
        },
      );
    }

    const verify = async (
      before: RootReplacementFailurePoint,
      after: RootReplacementFailurePoint,
      action: () => void | Promise<void>,
    ): Promise<void> => {
      await invokeFailurePoint(before, options.injectFailure, events);
      try {
        await action();
      } catch (error: unknown) {
        throw new OfflineRootReplacementError(
          "post-swap-verification-failed",
          "post-swap root verification failed",
          {
            state: "swapped",
            targetPath: request.target,
            rollbackPath,
            stagePath,
            rollback,
            events,
            cause: error,
          },
        );
      }
      await invokeFailurePoint(after, options.injectFailure, events);
    };

    try {
      await verify("before-post-swap-permissions", "after-post-swap-permissions", () =>
        verifyPrivateTree(request.target),
      );
      await verify("before-post-swap-manifest", "after-post-swap-manifest", async () => {
        const identity = await readManifestIdentity(request.target);
        if (
          identity.manifestId !== request.manifest.manifestId ||
          identity.digest !== request.manifest.digest
        ) {
          throw new Error("post-swap manifest identity does not match the selected backup");
        }
      });
      await verify("before-post-swap-repository", "after-post-swap-repository", () =>
        options.verifyRepository({
          rootPath: request.target,
          backupPath: options.backupPath,
          manifest: restored.manifest,
          manifestIdentity: request.manifest,
        }),
      );
    } catch (error: unknown) {
      rollback = await attemptRollback(swapState, request.target, rollbackPath, stagePath);
      const finalDisposition = await disposition(request.target, rollbackPath, stagePath);
      throw new OfflineRootReplacementError(
        rollback.status === "failed" ? "rollback-failed" : "post-swap-verification-failed",
        rollback.status === "failed"
          ? "post-swap verification failed and rollback is recoverable"
          : "post-swap verification failed; old root restored",
        {
          state: rollback.status === "failed" ? "recoverable-swap" : "rolled-back",
          targetPath: request.target,
          rollbackPath,
          stagePath,
          rollback,
          disposition: finalDisposition,
          events,
          cause: error,
        },
      );
    }

    state = "verified";
    const finalDisposition = await disposition(request.target, rollbackPath, stagePath);
    const noRollback: RootReplacementRollback = { attempted: false, status: "not-needed" };
    return Object.freeze({
      state: "completed",
      targetPath: request.target,
      rollbackPath,
      stagePath,
      manifest: restored.manifest,
      manifestIdentity: request.manifest,
      rollback: noRollback,
      disposition: finalDisposition,
      events: Object.freeze([...events]),
    });
  } catch (error: unknown) {
    if (error instanceof OfflineRootReplacementError) {
      // Before the first rename the stage is disposable operation state. Clean
      // it only in this pre-swap state; a post-swap failed root remains at the
      // recorded stage path for diagnosis and explicit cleanup.
      if (swapState === "not-started" && stagePath !== undefined) {
        await rm(stagePath, { force: true, recursive: true }).catch(() => undefined);
      }
      if (error.disposition !== undefined) throw error;
      const finalDisposition =
        rollbackPath !== undefined && stagePath !== undefined
          ? await disposition(targetPath, rollbackPath, stagePath)
          : undefined;
      throw new OfflineRootReplacementError(error.code, error.message, {
        state: error.state,
        targetPath: error.targetPath ?? targetPath,
        rollbackPath: error.rollbackPath ?? rollbackPath,
        stagePath: error.stagePath ?? stagePath,
        rollback: error.rollback,
        disposition: finalDisposition,
        events: error.events,
        cause: error.cause,
      });
    }
    if (stagePath !== undefined) {
      await rm(stagePath, { force: true, recursive: true }).catch(() => undefined);
    }
    throw new OfflineRootReplacementError("stage-failed", "offline root replacement failed", {
      state,
      targetPath,
      rollbackPath,
      stagePath,
      rollback,
      events,
      cause: error,
    });
  }
}

/** Short alias used by administration callers. */
export const replaceOfflineRoot = replaceOfflinePrivateRoot;
