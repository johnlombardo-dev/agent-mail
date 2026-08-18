import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createApprovalSealKeyring, type ApprovalSealKeyring } from "./action-approval-authority";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const KEY_ID =
  /^approval-seal-key:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type ApprovalSealKeyringFileKey = Readonly<{
  readonly keyId: string;
  readonly status: "active" | "verify-only";
  readonly keyBase64url: string;
  readonly createdAt: string;
  readonly statusChangedAt: string;
}>;

export type ApprovalSealKeyringFile = Readonly<{
  readonly schemaVersion: 1;
  readonly keyringRevision: number;
  readonly updatedAt: string;
  readonly activeKeyId: string;
  readonly keys: readonly ApprovalSealKeyringFileKey[];
}>;

export class ApprovalSealKeyringFileError extends Error {
  readonly code = "invalid-action-approval-keyring" as const;
}

export function actionApprovalSealKeyringPath(privateRoot: string): string {
  return join(privateRoot, "secrets", "action-approval-seal-keyring.v1.json");
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" && INSTANT.test(value) && new Date(value).toISOString() === value
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalKeyring(value: unknown): ApprovalSealKeyringFile {
  if (!isPlainRecord(value))
    throw new ApprovalSealKeyringFileError("approval keyring must be an object");
  const root = value;
  if (!exactKeys(root, ["schemaVersion", "keyringRevision", "updatedAt", "activeKeyId", "keys"]))
    throw new ApprovalSealKeyringFileError("approval keyring has unknown fields");
  if (
    root.schemaVersion !== 1 ||
    typeof root.keyringRevision !== "number" ||
    !Number.isSafeInteger(root.keyringRevision) ||
    root.keyringRevision < 1 ||
    !canonicalInstant(root.updatedAt) ||
    typeof root.activeKeyId !== "string" ||
    !KEY_ID.test(root.activeKeyId) ||
    !Array.isArray(root.keys) ||
    root.keys.length === 0
  )
    throw new ApprovalSealKeyringFileError("approval keyring metadata is invalid");

  const keys: ApprovalSealKeyringFileKey[] = [];
  const ids = new Set<string>();
  const bytes = new Set<string>();
  for (const item of root.keys) {
    if (!isPlainRecord(item))
      throw new ApprovalSealKeyringFileError("approval key entry is invalid");
    const candidate = item;
    if (!exactKeys(candidate, ["keyId", "status", "keyBase64url", "createdAt", "statusChangedAt"]))
      throw new ApprovalSealKeyringFileError("approval key entry has unknown fields");
    const keyId = candidate.keyId;
    const status = candidate.status;
    const keyBase64url = candidate.keyBase64url;
    if (
      typeof keyId !== "string" ||
      !KEY_ID.test(keyId) ||
      ids.has(keyId) ||
      (status !== "active" && status !== "verify-only") ||
      typeof keyBase64url !== "string" ||
      keyBase64url.length !== 43 ||
      !/^[A-Za-z0-9_-]+$/u.test(keyBase64url) ||
      Buffer.from(keyBase64url, "base64url").length !== 32 ||
      Buffer.from(keyBase64url, "base64url").toString("base64url") !== keyBase64url ||
      bytes.has(keyBase64url) ||
      !canonicalInstant(candidate.createdAt) ||
      !canonicalInstant(candidate.statusChangedAt)
    )
      throw new ApprovalSealKeyringFileError("approval key entry is invalid");
    ids.add(keyId);
    bytes.add(keyBase64url);
    keys.push(
      Object.freeze({
        keyId,
        status,
        keyBase64url,
        createdAt: candidate.createdAt,
        statusChangedAt: candidate.statusChangedAt,
      }),
    );
  }
  const sorted = [...keys].sort((left, right) =>
    Buffer.from(left.keyId).compare(Buffer.from(right.keyId)),
  );
  if (JSON.stringify(sorted) !== JSON.stringify(keys))
    throw new ApprovalSealKeyringFileError("approval key entries are not bytewise sorted");
  if (
    ids.size !== keys.length ||
    !ids.has(root.activeKeyId) ||
    keys.filter((key) => key.status === "active").length !== 1 ||
    keys.find((key) => key.keyId === root.activeKeyId)?.status !== "active"
  )
    throw new ApprovalSealKeyringFileError("approval keyring must have exactly one active key");
  return Object.freeze({
    schemaVersion: 1,
    keyringRevision: root.keyringRevision,
    updatedAt: root.updatedAt,
    activeKeyId: root.activeKeyId,
    keys: Object.freeze(keys),
  });
}

async function assertOwnerOnly(path: string, expectedMode: number, kind: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    throw new ApprovalSealKeyringFileError(`${kind} is unavailable`);
  }
  if (
    info.isSymbolicLink() ||
    (kind === "directory" ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o777) !== expectedMode
  )
    throw new ApprovalSealKeyringFileError(`${kind} permissions or type are unsafe`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid)
    throw new ApprovalSealKeyringFileError(`${kind} owner is invalid`);
}

async function assertPrivateRoot(privateRoot: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(privateRoot);
  } catch {
    throw new ApprovalSealKeyringFileError("private root is unavailable");
  }
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== DIRECTORY_MODE)
    throw new ApprovalSealKeyringFileError("private root permissions or type are unsafe");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && info.uid !== uid)
    throw new ApprovalSealKeyringFileError("private root owner is invalid");
}

async function readFile(path: string): Promise<ApprovalSealKeyringFile> {
  await assertOwnerOnly(dirname(path), DIRECTORY_MODE, "directory");
  await assertOwnerOnly(path, FILE_MODE, "keyring file");
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new ApprovalSealKeyringFileError("approval keyring cannot be read");
  }
  try {
    return canonicalKeyring(JSON.parse(text) as unknown);
  } catch (error: unknown) {
    if (error instanceof ApprovalSealKeyringFileError) throw error;
    throw new ApprovalSealKeyringFileError("approval keyring JSON is invalid");
  }
}

function toRuntimeKeyring(file: ApprovalSealKeyringFile): ApprovalSealKeyring {
  const active = file.keys.find((key) => key.keyId === file.activeKeyId);
  if (active === undefined)
    throw new ApprovalSealKeyringFileError("active approval key is missing");
  return createApprovalSealKeyring(
    { keyId: active.keyId, keyHex: Buffer.from(active.keyBase64url, "base64url").toString("hex") },
    file.keys
      .filter((key) => key.keyId !== active.keyId)
      .map((key) => ({
        keyId: key.keyId,
        keyHex: Buffer.from(key.keyBase64url, "base64url").toString("hex"),
      })),
    file.keyringRevision,
  );
}

export async function loadApprovalSealKeyringFile(
  options: Readonly<{ readonly privateRoot: string; readonly databaseExists: boolean }>,
): Promise<
  Readonly<{ readonly file: ApprovalSealKeyringFile; readonly keyring: ApprovalSealKeyring }>
> {
  await assertPrivateRoot(options.privateRoot);
  const path = actionApprovalSealKeyringPath(options.privateRoot);
  try {
    const file = await readFile(path);
    return Object.freeze({ file, keyring: toRuntimeKeyring(file) });
  } catch (error: unknown) {
    if (
      !(error instanceof ApprovalSealKeyringFileError) ||
      !String(error.message).includes("unavailable") ||
      options.databaseExists
    )
      throw error;
    await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    await chmod(dirname(path), DIRECTORY_MODE);
    const now = new Date().toISOString();
    const keyId = `approval-seal-key:${randomUUID()}`;
    const keyBase64url = randomBytes(32).toString("base64url");
    const file = canonicalKeyring({
      schemaVersion: 1,
      keyringRevision: 1,
      updatedAt: now,
      activeKeyId: keyId,
      keys: [{ keyId, status: "active", keyBase64url, createdAt: now, statusChangedAt: now }],
    });
    await writeApprovalSealKeyringFile(path, file);
    return Object.freeze({ file, keyring: toRuntimeKeyring(file) });
  }
}

export async function writeApprovalSealKeyringFile(
  path: string,
  value: ApprovalSealKeyringFile,
): Promise<void> {
  const file = canonicalKeyring(value);
  await assertOwnerOnly(dirname(path), DIRECTORY_MODE, "directory");
  const existing = await lstat(path).catch(() => undefined);
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile()))
    throw new ApprovalSealKeyringFileError("keyring file permissions or type are unsafe");
  const temporary = join(dirname(path), `.${file.activeKeyId}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.writeFile(`${JSON.stringify(file)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await chmod(path, FILE_MODE);
  } catch {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new ApprovalSealKeyringFileError("approval keyring atomic replacement failed");
  }
}

export async function rotateApprovalSealKeyringFile(
  privateRoot: string,
): Promise<ApprovalSealKeyringFile> {
  await assertPrivateRoot(privateRoot);
  const current = await readFile(actionApprovalSealKeyringPath(privateRoot));
  const now = new Date().toISOString();
  const nextId = `approval-seal-key:${randomUUID()}`;
  const next: ApprovalSealKeyringFile = {
    schemaVersion: 1,
    keyringRevision: current.keyringRevision + 1,
    updatedAt: now,
    activeKeyId: nextId,
    keys: [
      ...current.keys.map((key): ApprovalSealKeyringFileKey => ({
        ...key,
        status: "verify-only",
        statusChangedAt: now,
      })),
      {
        keyId: nextId,
        status: "active" as const,
        keyBase64url: randomBytes(32).toString("base64url"),
        createdAt: now,
        statusChangedAt: now,
      },
    ].sort((left, right) =>
      Buffer.from(left.keyId).compare(Buffer.from(right.keyId)),
    ) as readonly ApprovalSealKeyringFileKey[],
  };
  await writeApprovalSealKeyringFile(actionApprovalSealKeyringPath(privateRoot), next);
  return canonicalKeyring(next);
}

export async function removeApprovalSealKeyringFile(
  privateRoot: string,
  keyId: string,
): Promise<ApprovalSealKeyringFile> {
  await assertPrivateRoot(privateRoot);
  const current = await readFile(actionApprovalSealKeyringPath(privateRoot));
  const target = current.keys.find((key) => key.keyId === keyId);
  if (target === undefined || target.status === "active")
    throw new ApprovalSealKeyringFileError("active or missing approval key cannot be removed");
  const now = new Date().toISOString();
  const next = {
    ...current,
    keyringRevision: current.keyringRevision + 1,
    updatedAt: now,
    keys: current.keys.filter((key) => key.keyId !== keyId),
  };
  await writeApprovalSealKeyringFile(actionApprovalSealKeyringPath(privateRoot), next);
  return canonicalKeyring(next);
}
