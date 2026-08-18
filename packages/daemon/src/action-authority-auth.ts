import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AuthenticatedRequestContext, HttpCredentialResolution, HttpPrincipal } from "./http";
import type { OperationHandler } from "./http";
import {
  actionPlanApproveRequestSchema,
  actionPlanCancelApprovalRequestSchema,
  operatorSessionRequestSchema,
  operatorSessionResponseSchema,
} from "@agent-mail/contracts";
import {
  OperatorPresenceError,
  type OperatorPresenceAssertion,
  type OperatorPresenceBroker,
  type OperatorPresenceChallenge,
  type OperatorPresenceRequest,
} from "./operator-presence";
import {
  consumeOperatorPresenceChallenge,
  issueOperatorPresenceChallenge,
  readOperatorPresenceChallenge,
} from "../../storage/src/action-approval-authority";
import type { ApprovalSealKeyring } from "../../storage/src/action-approval-authority";
import type { Database } from "bun:sqlite";
import { registerTrustedAuthContext } from "./trusted-auth-context";

const text = (name: string, maximum = 256) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, `${name} must be trimmed`)
    .refine(
      (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
      `${name} has control characters`,
    );

const LOCAL_OPERATOR_PRINCIPAL = "principal:local-operator";

export const actionCredentialProfileSchema = z.enum(["operator-interactive", "agent-unattended"]);

const agentCredentialSchema = z.strictObject({
  credentialId: text("credential ID"),
  principalId: text("principal ID"),
  profile: z.literal("agent-unattended"),
  scopes: z.array(text("scope")).min(1).max(8),
  secret: text("credential secret", 512),
  issuedAt: text("credential issued time", 40),
  expiresAt: text("credential expiry", 40),
  authEventId: text("credential auth event ID"),
});
const operatorCredentialSchema = z.strictObject({
  credentialId: text("credential ID"),
  principalId: z.literal(LOCAL_OPERATOR_PRINCIPAL),
  profile: z.literal("operator-interactive"),
  scopes: z.array(text("scope")).min(1).max(8),
  algorithm: z.literal("ES256"),
  publicKeySpkiBase64url: text("operator public key", 2_048),
  publicKeySpkiSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["active", "revoked"]),
  enrolledAt: text("credential enrollment time", 40),
  expiresAt: text("credential expiry", 40),
  revokedAt: z.union([text("credential revocation time", 40), z.null()]),
  replacedByCredentialId: z.union([text("replacement credential ID"), z.null()]),
});
export const actionCredentialSchema = z.discriminatedUnion("profile", [
  operatorCredentialSchema,
  agentCredentialSchema,
]);
export type ActionCredential = z.infer<typeof actionCredentialSchema>;

const operatorCredentialConfigurationRecordSchema = z.strictObject({
  credentialId: text("credential ID"),
  principalId: z.literal(LOCAL_OPERATOR_PRINCIPAL),
  profile: z.literal("operator-interactive"),
  algorithm: z.literal("ES256"),
  publicKeySpkiBase64url: text("operator public key", 2_048),
  publicKeySpkiSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["active", "revoked"]),
  enrolledAt: text("credential enrollment time", 40),
  expiresAt: text("credential expiry", 40),
  revokedAt: z.union([text("credential revocation time", 40), z.null()]),
  replacedByCredentialId: z.union([text("replacement credential ID"), z.null()]),
});

export const operatorCredentialConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  authorityInstanceId: text("authority instance ID").regex(
    /^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  ),
  configurationRevision: z.number().int().safe().positive(),
  updatedAt: text("configuration update time", 40),
  credentials: z.array(operatorCredentialConfigurationRecordSchema).min(1).max(2),
});
export type OperatorCredentialConfiguration = z.infer<typeof operatorCredentialConfigurationSchema>;

const OPERATOR_SCOPES = [
  "mail:action.create",
  "mail:action.inspect",
  "mail:action.approve",
] as const;
const AGENT_SCOPES = ["mail:action.create", "mail:action.inspect", "mail:action.commit"] as const;
const CREDENTIAL_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const OPERATOR_DISPLAY_NAMESPACE = "agent-mail-presence-display-v1";
const OPERATOR_CHALLENGE_LIFETIME_MS = 60_000;
const SEAL_KEY_ROTATE_PATH = "/internal/action-authority/seal-keyring/rotate";
const SEAL_KEY_REMOVE_PATH = "/internal/action-authority/seal-keyring/remove";

function expectedPresenceDisplayCode(
  operation: "approve" | "cancel-approval",
  value: Readonly<{
    readonly planId: string;
    readonly planVersion: number;
    readonly previewDigest: string;
  }>,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        OPERATOR_DISPLAY_NAMESPACE,
        operation,
        value.planId,
        value.planVersion,
        value.previewDigest,
      ]),
    )
    .digest("hex")
    .slice(0, 20);
  return digest.match(/.{4}/gu)?.join("-") ?? "";
}

function expectedOpenSessionDisplayCode(authorityInstanceId: string): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        OPERATOR_DISPLAY_NAMESPACE,
        "open-session",
        authorityInstanceId,
        "mail:action.create",
        "mail:action.inspect",
      ]),
    )
    .digest("hex")
    .slice(0, 20);
  return digest.match(/.{4}/gu)?.join("-") ?? "";
}

function expectedSealKeyDisplayCode(
  operation: "seal-key-rotate" | "seal-key-remove",
  authorityInstanceId: string,
  expectedKeyringRevision: number,
  targetKeyId: string,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        OPERATOR_DISPLAY_NAMESPACE,
        operation,
        authorityInstanceId,
        expectedKeyringRevision,
        targetKeyId,
      ]),
    )
    .digest("hex")
    .slice(0, 20);
  return digest.match(/.{4}/gu)?.join("-") ?? "";
}

function issueDaemonChallenge(
  request: OperatorPresenceRequest,
  displayCode: string,
): OperatorPresenceChallenge {
  const challengeId = `operator-challenge:${randomUUID()}`;
  const nonceBase64url = randomBytes(32).toString("base64url");
  const issuedDate = new Date();
  const issuedAt = issuedDate.toISOString();
  const expiresAt = new Date(issuedDate.getTime() + OPERATOR_CHALLENGE_LIFETIME_MS).toISOString();
  const bodySha256 = createHash("sha256").update(request.rawBody).digest("hex");
  const commitment = JSON.stringify([
    "agent-mail-operator-challenge-v1",
    request.authorityInstanceId,
    challengeId,
    nonceBase64url,
    request.credentialId,
    request.principalId,
    "operator-interactive",
    request.operation,
    request.method,
    request.path,
    bodySha256,
    displayCode,
    request.configurationRevision,
    issuedAt,
    expiresAt,
  ]);
  return Object.freeze({
    challengeId,
    nonceBase64url,
    commitment,
    displayCode,
    issuedAt,
    expiresAt,
    request: Object.freeze({
      operation: request.operation,
      method: request.method,
      path: request.path,
      bodySha256,
      principalId: request.principalId,
      credentialId: request.credentialId,
      authorityInstanceId: request.authorityInstanceId,
      configurationRevision: request.configurationRevision,
      operatorDisplayCode: displayCode,
    }),
  });
}

export type CredentialRegistry = Readonly<{
  readonly bySecret: ReadonlyMap<string, ActionCredential>;
  readonly byId: ReadonlyMap<string, ActionCredential>;
  readonly revision: number;
}>;

/** The only configuration projection an authority may use during admission.
 * Production composition supplies a loader backed by the owner-only config
 * file; the snapshot fields remain for deterministic unit construction. */
export type OperatorAuthorityLiveState = Readonly<{
  readonly credentials: CredentialRegistry;
  readonly authorityInstanceId: string;
  readonly configurationRevision: number;
}>;

export class ActionCredentialConfigurationError extends Error {
  readonly code = "invalid-action-credential-configuration" as const;
}

function expectedScopes(profile: ActionCredential["profile"]): readonly string[] {
  return profile === "operator-interactive" ? OPERATOR_SCOPES : AGENT_SCOPES;
}

function strictJsonBody(rawBody: Uint8Array): unknown {
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > 2_048)
    throw new OperatorPresenceError("operator request body is invalid");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    const parsed = JSON.parse(text) as unknown;
    if (JSON.stringify(parsed) !== text) throw new Error("non-canonical JSON");
    return parsed;
  } catch {
    throw new OperatorPresenceError("operator request body is invalid");
  }
}

function sealAdministrationBody(
  operation: "seal-key-rotate" | "seal-key-remove",
  rawBody: Uint8Array,
): Readonly<{ readonly expectedKeyringRevision: number; readonly targetKeyId: string }> {
  const value = strictJsonBody(rawBody);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OperatorPresenceError("operator seal-key administration body is invalid");
  const record = value as Record<string, unknown>;
  const expectedKeys =
    operation === "seal-key-rotate"
      ? ["expectedKeyringRevision", "expectedActiveKeyId"]
      : ["expectedKeyringRevision", "keyId"];
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    throw new OperatorPresenceError("operator seal-key administration body is invalid");
  const target = record[expectedKeys[1]];
  if (
    typeof record.expectedKeyringRevision !== "number" ||
    !Number.isSafeInteger(record.expectedKeyringRevision) ||
    record.expectedKeyringRevision < 1 ||
    typeof target !== "string" ||
    !/^approval-seal-key:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      target,
    )
  )
    throw new OperatorPresenceError("operator seal-key administration body is invalid");
  return Object.freeze({
    expectedKeyringRevision: record.expectedKeyringRevision,
    targetKeyId: target,
  });
}

function isCanonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactExpiry(issuedAt: string, expiresAt: string): boolean {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  return Number.isFinite(issued) && expires - issued === CREDENTIAL_LIFETIME_SECONDS * 1_000;
}

function validateCredential(value: unknown): ActionCredential {
  const credential = actionCredentialSchema.parse(value);
  const issuedAt =
    credential.profile === "operator-interactive" ? credential.enrolledAt : credential.issuedAt;
  if (!isCanonicalInstant(issuedAt) || !isCanonicalInstant(credential.expiresAt))
    throw new ActionCredentialConfigurationError("credential times must be canonical UTC");
  if (!exactExpiry(issuedAt, credential.expiresAt))
    throw new ActionCredentialConfigurationError("credential lifetime must be exactly 365 days");
  const allowed = expectedScopes(credential.profile);
  if (
    new Set(credential.scopes).size !== credential.scopes.length ||
    credential.scopes.length !== allowed.length ||
    allowed.some((scope) => !credential.scopes.includes(scope)) ||
    (credential.profile === "operator-interactive" &&
      (credential.principalId !== LOCAL_OPERATOR_PRINCIPAL ||
        credential.algorithm !== "ES256" ||
        !/^[A-Za-z0-9_-]+$/u.test(credential.publicKeySpkiBase64url) ||
        Buffer.from(credential.publicKeySpkiBase64url, "base64url").toString("base64url") !==
          credential.publicKeySpkiBase64url ||
        (() => {
          try {
            createPublicKey({
              key: Buffer.from(credential.publicKeySpkiBase64url, "base64url"),
              format: "der",
              type: "spki",
            });
            return false;
          } catch {
            return true;
          }
        })() ||
        createHash("sha256")
          .update(Buffer.from(credential.publicKeySpkiBase64url, "base64url"))
          .digest("hex") !== credential.publicKeySpkiSha256))
  )
    throw new ActionCredentialConfigurationError(
      "credential profile and scopes are not composable",
    );
  return { ...credential, scopes: [...credential.scopes] };
}

export function createActionCredentialRegistry(input: unknown, revision = 1): CredentialRegistry {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ActionCredentialConfigurationError("at least one action credential is required");
  }
  const credentials = input.map(validateCredential);
  const byId = new Map<string, ActionCredential>();
  const bySecret = new Map<string, ActionCredential>();
  const profilesByPrincipal = new Map<string, ActionCredential["profile"]>();
  const operatorKeys = new Set<string>();
  for (const credential of credentials) {
    const secret = credential.profile === "agent-unattended" ? credential.secret : undefined;
    if (
      byId.has(credential.credentialId) ||
      (secret !== undefined && bySecret.has(secret)) ||
      (credential.profile === "operator-interactive" &&
        operatorKeys.has(credential.publicKeySpkiSha256))
    )
      throw new ActionCredentialConfigurationError(
        "action credential IDs and secrets must be unique",
      );
    const priorProfile = profilesByPrincipal.get(credential.principalId);
    if (priorProfile !== undefined && priorProfile !== credential.profile)
      throw new ActionCredentialConfigurationError("a principal cannot map to multiple profiles");
    byId.set(credential.credentialId, credential);
    if (secret !== undefined) bySecret.set(secret, credential);
    if (credential.profile === "operator-interactive")
      operatorKeys.add(credential.publicKeySpkiSha256);
    profilesByPrincipal.set(credential.principalId, credential.profile);
  }
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new ActionCredentialConfigurationError("credential revision must be positive");
  return Object.freeze({ byId, bySecret, revision });
}

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

/** Load the public operator configuration; private keys never cross this boundary. */
export async function loadOperatorCredentialConfiguration(privateRoot: string): Promise<
  Readonly<{
    readonly configuration: OperatorCredentialConfiguration;
    readonly credentials: CredentialRegistry;
  }>
> {
  const configDirectory = join(privateRoot, "config");
  const configPath = join(configDirectory, "operator-credentials.v1.json");
  const directory = await lstat(configDirectory).catch(() => undefined);
  const file = await lstat(configPath).catch(() => undefined);
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    directory === undefined ||
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    (directory.mode & 0o777) !== OWNER_DIRECTORY_MODE ||
    (owner !== undefined && directory.uid !== owner) ||
    file === undefined ||
    file.isSymbolicLink() ||
    !file.isFile() ||
    (file.mode & 0o777) !== OWNER_FILE_MODE ||
    (owner !== undefined && file.uid !== owner)
  ) {
    throw new ActionCredentialConfigurationError(
      "operator credential configuration permissions are unsafe",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch {
    throw new ActionCredentialConfigurationError("operator credential configuration is invalid");
  }
  let configuration: OperatorCredentialConfiguration;
  try {
    configuration = operatorCredentialConfigurationSchema.parse(parsed);
  } catch {
    throw new ActionCredentialConfigurationError("operator credential configuration is invalid");
  }
  if (!isCanonicalInstant(configuration.updatedAt))
    throw new ActionCredentialConfigurationError(
      "operator credential configuration time is invalid",
    );
  for (const credential of configuration.credentials) {
    if (
      !/^credential:operator:[0-9a-f]{64}$/u.test(credential.credentialId) ||
      !isCanonicalInstant(credential.enrolledAt) ||
      !isCanonicalInstant(credential.expiresAt) ||
      !exactExpiry(credential.enrolledAt, credential.expiresAt) ||
      (credential.status === "active" && credential.revokedAt !== null) ||
      createHash("sha256")
        .update(Buffer.from(credential.publicKeySpkiBase64url, "base64url"))
        .digest("hex") !== credential.publicKeySpkiSha256
    )
      throw new ActionCredentialConfigurationError("operator credential configuration is invalid");
  }
  if (configuration.credentials.filter((credential) => credential.status === "active").length > 1)
    throw new ActionCredentialConfigurationError("operator credential configuration is invalid");
  const input = configuration.credentials.map((credential) => ({
    ...credential,
    scopes: [...OPERATOR_SCOPES],
  }));
  const credentials = createActionCredentialRegistry(input, configuration.configurationRevision);
  return Object.freeze({ configuration, credentials });
}

/** Resolve the current trusted configuration for composed admission. */
export function createOperatorAuthorityLiveStateLoader(
  privateRoot: string,
): () => Promise<OperatorAuthorityLiveState> {
  return async () => {
    const loaded = await loadOperatorCredentialConfiguration(privateRoot);
    return Object.freeze({
      credentials: loaded.credentials,
      authorityInstanceId: loaded.configuration.authorityInstanceId,
      configurationRevision: loaded.configuration.configurationRevision,
    });
  };
}

/** Atomically publish public operator configuration during a native ceremony. */
export async function writeOperatorCredentialConfiguration(
  privateRoot: string,
  value: unknown,
): Promise<OperatorCredentialConfiguration> {
  const root = await lstat(privateRoot).catch(() => undefined);
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    root === undefined ||
    root.isSymbolicLink() ||
    !root.isDirectory() ||
    (root.mode & 0o777) !== OWNER_DIRECTORY_MODE ||
    (owner !== undefined && root.uid !== owner)
  )
    throw new ActionCredentialConfigurationError(
      "operator credential configuration permissions are unsafe",
    );
  let configuration: OperatorCredentialConfiguration;
  try {
    configuration = operatorCredentialConfigurationSchema.parse(value);
    if (configuration.credentials.filter((credential) => credential.status === "active").length > 1)
      throw new Error("operator configuration contains multiple active credentials");
    createActionCredentialRegistry(
      configuration.credentials.map((credential) => ({
        ...credential,
        scopes: [...OPERATOR_SCOPES],
      })),
      configuration.configurationRevision,
    );
  } catch {
    throw new ActionCredentialConfigurationError("operator credential configuration is invalid");
  }
  const directory = join(privateRoot, "config");
  await mkdir(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  await chmod(directory, OWNER_DIRECTORY_MODE);
  const path = join(directory, "operator-credentials.v1.json");
  const temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", OWNER_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(configuration)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await chmod(path, OWNER_FILE_MODE);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new ActionCredentialConfigurationError(
      "operator credential configuration atomic replacement failed",
    );
  }
  return configuration;
}

function expiresNow(expiresAt: string, now: string): boolean {
  return Date.parse(now) >= Date.parse(expiresAt);
}

function verifyOperatorAssertionSignature(
  credential: Extract<ActionCredential, { readonly profile: "operator-interactive" }>,
  commitment: string,
  signature: Buffer,
): boolean {
  if (signature.length !== 64) return false;
  const r = BigInt(`0x${signature.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  if (r <= 0n || r >= P256_ORDER || s <= 0n || s > P256_ORDER / 2n) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(credential.publicKeySpkiBase64url, "base64url"),
      format: "der",
      type: "spki",
    });
    return verify(
      "sha256",
      Buffer.from(commitment, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}

export function authenticateActionCredential(
  registry: CredentialRegistry,
  secret: string,
  now = new Date().toISOString(),
  authEventId = `auth-event:${randomUUID()}`,
): HttpCredentialResolution {
  const credential = registry.bySecret.get(secret);
  if (credential === undefined) return { kind: "invalid" };
  // Operator-interactive authority is never resolved from a static bearer or
  // file secret. It can enter HTTP only through an A1-minted memory session
  // (create/inspect) or a separately verified presence context (approve/cancel).
  if (credential.profile === "operator-interactive") return { kind: "invalid" };
  if (expiresNow(credential.expiresAt, now)) return { kind: "expired" };
  const principal: HttpPrincipal = Object.freeze({
    subject: credential.principalId,
    scopes: Object.freeze([...credential.scopes]),
  });
  const presence: AuthenticatedRequestContext["presence"] = { kind: "unattended" };
  const context: AuthenticatedRequestContext = Object.freeze({
    principalId: credential.principalId,
    credentialId: credential.credentialId,
    profile: credential.profile,
    scopes: Object.freeze([...credential.scopes]),
    authEventId,
    authenticatedAt: now,
    credentialExpiresAt: credential.expiresAt,
    presence: Object.freeze(presence),
  });
  return { kind: "authenticated", principal, context };
}

export type OperatorSession = Readonly<{
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly principalId: string;
  readonly credentialId: string;
  readonly scopes: readonly ["mail:action.create", "mail:action.inspect"];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly sessionAuthEventId: string;
  readonly credentialExpiresAt: string;
  readonly configurationRevision: number;
}>;

type OperatorSessionRegistry = Readonly<{
  readonly issue: (capability: VerifiedOpenSessionCapability) => Readonly<{
    readonly session: OperatorSession;
    readonly token: string;
  }>;
  readonly authenticate: (token: string, now?: string) => HttpCredentialResolution;
  readonly clear: () => void;
}>;

type SessionRegistryProjection = {
  credentials: CredentialRegistry;
  configurationRevision: number;
  credentialFingerprint: string;
};

const sessionRegistryProjections = new WeakMap<
  OperatorSessionRegistry,
  SessionRegistryProjection
>();

function operatorCredentialFingerprint(credentials: CredentialRegistry): string {
  return [...credentials.byId.values()]
    .map((credential) =>
      credential.profile === "operator-interactive"
        ? [
            credential.credentialId,
            credential.principalId,
            credential.profile,
            credential.publicKeySpkiSha256,
            credential.status,
            credential.enrolledAt,
            credential.expiresAt,
            credential.revokedAt,
            credential.replacedByCredentialId,
          ]
        : [
            credential.credentialId,
            credential.principalId,
            credential.profile,
            credential.issuedAt,
            credential.expiresAt,
          ],
    )
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    .map((value) => JSON.stringify(value))
    .join("|");
}

function syncOperatorSessionRegistry(
  registry: OperatorSessionRegistry,
  credentials: CredentialRegistry,
  configurationRevision: number,
): void {
  const projection = sessionRegistryProjections.get(registry);
  if (projection === undefined) throw new Error("operator session registry is not trusted");
  const credentialFingerprint = operatorCredentialFingerprint(credentials);
  if (
    projection.configurationRevision !== configurationRevision ||
    projection.credentialFingerprint !== credentialFingerprint
  ) {
    registry.clear();
    projection.credentials = credentials;
    projection.configurationRevision = configurationRevision;
    projection.credentialFingerprint = credentialFingerprint;
  }
}

const verifiedOpenSessionCapability = Symbol("verifiedOpenSessionCapability");
type VerifiedOpenSessionCapability = Readonly<{
  readonly [verifiedOpenSessionCapability]: Readonly<{
    readonly credentialId: string;
    readonly verifiedAt: string;
    readonly configurationRevision: number;
  }>;
}>;

function issueOperatorSession(
  credential: ActionCredential,
  capability: VerifiedOpenSessionCapability,
  configurationRevision: number,
): Readonly<{ readonly session: OperatorSession; readonly token: string }> {
  const now = capability[verifiedOpenSessionCapability].verifiedAt;
  if (
    capability[verifiedOpenSessionCapability].credentialId !== credential.credentialId ||
    credential.profile !== "operator-interactive" ||
    credential.principalId !== LOCAL_OPERATOR_PRINCIPAL ||
    credential.status !== "active" ||
    expiresNow(credential.expiresAt, now)
  )
    throw new ActionCredentialConfigurationError("verified operator session capability is invalid");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Math.min(Date.parse(now) + 600_000, Date.parse(credential.expiresAt)),
  ).toISOString();
  const scopes: readonly ["mail:action.create", "mail:action.inspect"] = [
    "mail:action.create",
    "mail:action.inspect",
  ];
  const session: OperatorSession = Object.freeze({
    sessionId: `operator-session:${randomUUID()}`,
    tokenDigest: createHash("sha256").update(token).digest("hex"),
    principalId: credential.principalId,
    credentialId: credential.credentialId,
    scopes,
    issuedAt: now,
    expiresAt,
    sessionAuthEventId: `auth-event:operator-session:${randomUUID()}`,
    credentialExpiresAt: credential.expiresAt,
    configurationRevision,
  });
  return Object.freeze({ session, token });
}

/**
 * Memory-only A1 session broker. Only token digests are retained; raw bearer
 * tokens never enter the store, logs, database, or returned auth context.
 */
export function createOperatorSessionRegistry(
  credentials: CredentialRegistry,
  configurationRevision: number,
): OperatorSessionRegistry {
  if (!Number.isSafeInteger(configurationRevision) || configurationRevision < 1)
    throw new ActionCredentialConfigurationError("session configuration revision is invalid");
  const sessions = new Map<string, OperatorSession>();
  const projection: SessionRegistryProjection = {
    credentials,
    configurationRevision,
    credentialFingerprint: operatorCredentialFingerprint(credentials),
  };
  const issue = (capability: VerifiedOpenSessionCapability) => {
    const credential = projection.credentials.byId.get(
      capability?.[verifiedOpenSessionCapability]?.credentialId ?? "",
    );
    if (credential === undefined)
      throw new ActionCredentialConfigurationError("verified operator credential was not found");
    const issued = issueOperatorSession(credential, capability, projection.configurationRevision);
    const session = Object.freeze({
      ...issued.session,
      configurationRevision: projection.configurationRevision,
    });
    sessions.set(session.tokenDigest, session);
    return Object.freeze({ session, token: issued.token });
  };
  const authenticate = (
    token: string,
    now = new Date().toISOString(),
  ): HttpCredentialResolution => {
    if (typeof token !== "string" || token.length === 0) return { kind: "invalid" };
    const tokenDigest = createHash("sha256").update(token).digest("hex");
    const session = sessions.get(tokenDigest);
    if (session === undefined) return { kind: "invalid" };
    const credential = projection.credentials.byId.get(session.credentialId);
    if (
      credential === undefined ||
      credential.profile !== "operator-interactive" ||
      credential.status !== "active" ||
      credential.expiresAt !== session.credentialExpiresAt ||
      session.configurationRevision !== projection.configurationRevision
    ) {
      sessions.delete(tokenDigest);
      return { kind: "invalid" };
    }
    if (expiresNow(session.expiresAt, now) || expiresNow(credential.expiresAt, now)) {
      sessions.delete(tokenDigest);
      return { kind: "expired" };
    }
    const scopes = ["mail:action.create", "mail:action.inspect"] as const;
    const principal: HttpPrincipal = Object.freeze({
      subject: session.principalId,
      scopes: Object.freeze([...scopes]),
    });
    const context: AuthenticatedRequestContext = registerTrustedAuthContext(
      Object.freeze({
        principalId: session.principalId,
        credentialId: session.credentialId,
        profile: "operator-interactive",
        scopes: Object.freeze([...scopes]),
        authEventId: session.sessionAuthEventId,
        authenticatedAt: now,
        credentialExpiresAt: session.credentialExpiresAt,
        presence: Object.freeze({
          kind: "a1-non-approval-session",
          sessionId: session.sessionId,
          sessionAuthEventId: session.sessionAuthEventId,
          issuedAt: session.issuedAt,
          expiresAt: session.expiresAt,
          configurationRevision: session.configurationRevision,
          credentialExpiresAt: session.credentialExpiresAt,
        }),
      }),
    );
    return { kind: "authenticated", principal, context };
  };
  const registry = Object.freeze({ issue, authenticate, clear: () => sessions.clear() });
  sessionRegistryProjections.set(registry, projection);
  return registry;
}

export type OperatorSessionAuthorityOptions = Readonly<{
  readonly database: Database;
  readonly credentials: CredentialRegistry;
  readonly sessions: ReturnType<typeof createOperatorSessionRegistry>;
  readonly broker: OperatorPresenceBroker;
  readonly authorityInstanceId: string;
  readonly configurationRevision: number;
  /** Required live loader for every challenge/open admission. */
  readonly loadCurrent: () => OperatorAuthorityLiveState | Promise<OperatorAuthorityLiveState>;
}>;

export type OperatorPresenceAuthorityOptions = Readonly<{
  readonly database: Database;
  readonly credentials: CredentialRegistry;
  readonly broker: OperatorPresenceBroker;
  readonly authorityInstanceId: string;
  readonly configurationRevision: number;
  /** Required live loader for every challenge/verify admission. */
  readonly loadCurrent: () => OperatorAuthorityLiveState | Promise<OperatorAuthorityLiveState>;
  /** Required live seal-key projection for D28 administration challenges. */
  readonly loadKeyring: () => ApprovalSealKeyring | Promise<ApprovalSealKeyring>;
}>;

function validateOperatorAuthorityState(
  state: OperatorAuthorityLiveState,
): OperatorAuthorityLiveState {
  if (
    !/^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      state.authorityInstanceId,
    ) ||
    !Number.isSafeInteger(state.configurationRevision) ||
    state.configurationRevision < 1
  )
    throw new ActionCredentialConfigurationError("operator authority configuration is invalid");
  return state;
}

/** Native-verifier-backed provisional admission for approve/cancel. */
export class OperatorPresenceAuthority {
  readonly #options: OperatorPresenceAuthorityOptions;

  constructor(options: OperatorPresenceAuthorityOptions) {
    if (
      !/^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        options.authorityInstanceId,
      ) ||
      !Number.isSafeInteger(options.configurationRevision) ||
      options.configurationRevision < 1
    )
      throw new ActionCredentialConfigurationError(
        "operator presence authority configuration is invalid",
      );
    this.#options = options;
  }

  async currentBinding(): Promise<
    Readonly<{ readonly authorityInstanceId: string; readonly configurationRevision: number }>
  > {
    const state = await this.#currentState();
    return Object.freeze({
      authorityInstanceId: state.authorityInstanceId,
      configurationRevision: state.configurationRevision,
    });
  }

  async #currentState(): Promise<OperatorAuthorityLiveState> {
    return validateOperatorAuthorityState(await this.#options.loadCurrent());
  }

  async issueChallenge(request: OperatorPresenceRequest): Promise<OperatorPresenceChallenge> {
    const state = await this.#currentState();
    if (
      request.operation !== "approve" &&
      request.operation !== "cancel-approval" &&
      request.operation !== "seal-key-rotate" &&
      request.operation !== "seal-key-remove"
    )
      throw new ActionCredentialConfigurationError(
        "only approval operations may use operator presence",
      );
    if (
      request.authorityInstanceId !== state.authorityInstanceId ||
      request.configurationRevision !== state.configurationRevision ||
      request.principalId !== LOCAL_OPERATOR_PRINCIPAL
    )
      throw new OperatorPresenceError("operator request binding is invalid");
    const credential = state.credentials.byId.get(request.credentialId);
    if (
      credential === undefined ||
      credential.profile !== "operator-interactive" ||
      credential.status !== "active" ||
      expiresNow(credential.expiresAt, new Date().toISOString())
    )
      throw new OperatorPresenceError("operator credential is unavailable");
    const parsed = strictJsonBody(request.rawBody);
    let expectedPath: string;
    let displayCode: string;
    if (request.operation === "seal-key-rotate" || request.operation === "seal-key-remove") {
      if (request.method !== "ADMIN")
        throw new OperatorPresenceError("operator request binding is invalid");
      const keyring = await this.#options.loadKeyring();
      const administration = sealAdministrationBody(request.operation, request.rawBody);
      if (
        administration.expectedKeyringRevision !== keyring.revision ||
        (request.operation === "seal-key-rotate" &&
          administration.targetKeyId !== keyring.active.keyId) ||
        (request.operation === "seal-key-remove" &&
          keyring.keys.get(administration.targetKeyId)?.status !== "verify-only")
      )
        throw new OperatorPresenceError("operator keyring binding is stale");
      expectedPath =
        request.operation === "seal-key-rotate" ? SEAL_KEY_ROTATE_PATH : SEAL_KEY_REMOVE_PATH;
      displayCode = expectedSealKeyDisplayCode(
        request.operation,
        state.authorityInstanceId,
        administration.expectedKeyringRevision,
        administration.targetKeyId,
      );
    } else {
      expectedPath =
        request.operation === "approve"
          ? (() => {
              const value = actionPlanApproveRequestSchema.parse(parsed);
              return `/v1/action-plans/${encodeURIComponent(value.planId)}/approvals`;
            })()
          : (() => {
              const value = actionPlanCancelApprovalRequestSchema.parse(parsed);
              return `/v1/action-plans/${encodeURIComponent(value.planId)}/approvals/${encodeURIComponent(value.approvalId)}`;
            })();
      displayCode = expectedPresenceDisplayCode(
        request.operation,
        request.operation === "approve"
          ? actionPlanApproveRequestSchema.parse(parsed)
          : actionPlanCancelApprovalRequestSchema.parse(parsed),
      );
    }
    if (
      request.method !==
        (request.operation === "cancel-approval"
          ? "DELETE"
          : request.operation === "seal-key-rotate" || request.operation === "seal-key-remove"
            ? "ADMIN"
            : "POST") ||
      request.path !== expectedPath
    )
      throw new OperatorPresenceError("operator request binding is invalid");
    const challenge = issueDaemonChallenge(request, displayCode);
    issueOperatorPresenceChallenge(this.#options.database, {
      challengeId: challenge.challengeId,
      authorityInstanceId: request.authorityInstanceId,
      operatorConfigurationRevision: request.configurationRevision,
      challengeNonceBase64url: challenge.nonceBase64url,
      credentialId: request.credentialId,
      operation: request.operation,
      requestMethod: request.method,
      requestPath: request.path,
      requestBodySha256: createHash("sha256").update(request.rawBody).digest("hex"),
      operatorDisplayCode: challenge.displayCode,
      challengeCommitment: challenge.commitment,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    return challenge;
  }

  /** Sign only the exact challenge that is already durable and still bound to this request. */
  async signChallenge(
    request: OperatorPresenceRequest,
    challenge: OperatorPresenceChallenge,
  ): Promise<OperatorPresenceAssertion> {
    const state = await this.#currentState();
    if (this.#options.broker.sign === undefined)
      throw new OperatorPresenceError(
        "native operator presence signing is unavailable",
        "action.operator_presence_unsupported",
      );
    const durable = readOperatorPresenceChallenge(
      this.#options.database,
      challenge.challengeId,
      request.credentialId,
    );
    if (
      request.authorityInstanceId !== state.authorityInstanceId ||
      request.configurationRevision !== state.configurationRevision ||
      durable === undefined ||
      durable.commitment !== challenge.commitment ||
      durable.request.operation !== request.operation ||
      durable.request.method !== request.method ||
      durable.request.path !== request.path ||
      durable.request.bodySha256 !== createHash("sha256").update(request.rawBody).digest("hex") ||
      durable.request.authorityInstanceId !== request.authorityInstanceId ||
      durable.request.configurationRevision !== request.configurationRevision
    )
      throw new OperatorPresenceError("operator challenge binding is invalid");
    return this.#options.broker.sign(request, challenge);
  }

  async verifyForAction(
    request: OperatorPresenceRequest,
    assertion: OperatorPresenceAssertion,
    now = new Date().toISOString(),
  ): Promise<AuthenticatedRequestContext> {
    const state = await this.#currentState();
    if (request.operation !== "approve" && request.operation !== "cancel-approval")
      throw new OperatorPresenceError("operator action operation is invalid");
    if (request.method !== "POST" && request.method !== "DELETE")
      throw new OperatorPresenceError("operator action method is invalid");
    const credential = state.credentials.byId.get(assertion.credentialId);
    if (
      credential === undefined ||
      credential.profile !== "operator-interactive" ||
      credential.status !== "active" ||
      expiresNow(credential.expiresAt, now) ||
      request.credentialId !== assertion.credentialId ||
      request.authorityInstanceId !== state.authorityInstanceId ||
      request.configurationRevision !== state.configurationRevision
    )
      throw new OperatorPresenceError("operator credential is unavailable");
    const challenge = readOperatorPresenceChallenge(
      this.#options.database,
      assertion.challengeId,
      assertion.credentialId,
    );
    if (
      challenge === undefined ||
      challenge.request.operation !== request.operation ||
      challenge.request.method !== request.method ||
      challenge.request.path !== request.path ||
      challenge.request.bodySha256 !== createHash("sha256").update(request.rawBody).digest("hex") ||
      challenge.request.authorityInstanceId !== request.authorityInstanceId ||
      challenge.request.configurationRevision !== request.configurationRevision ||
      Date.parse(now) < Date.parse(challenge.issuedAt) ||
      Date.parse(now) >= Date.parse(challenge.expiresAt)
    )
      throw new OperatorPresenceError("operator challenge binding is invalid");
    await this.#options.broker.verify(assertion, request, challenge.commitment);
    const signature = Buffer.from(assertion.signatureP1363Base64url, "base64url");
    if (!verifyOperatorAssertionSignature(credential, challenge.commitment, signature))
      throw new OperatorPresenceError("operator assertion signature is invalid");
    return registerTrustedAuthContext(
      Object.freeze({
        principalId: credential.principalId,
        credentialId: credential.credentialId,
        profile: "operator-interactive",
        scopes: Object.freeze(["mail:action.approve"]),
        authEventId: `auth-event:operator-presence:${randomUUID()}`,
        authenticatedAt: now,
        credentialExpiresAt: credential.expiresAt,
        presence: Object.freeze({
          kind: "human-present",
          ceremonyId: challenge.challengeId,
          verifiedAt: now,
          validUntil: challenge.expiresAt,
          requestMethod: request.method,
          requestPath: request.path,
          requestBodySha256: challenge.request.bodySha256,
          challengeCommitmentSha256: createHash("sha256")
            .update(challenge.commitment)
            .digest("hex"),
          assertionSignatureSha256: createHash("sha256").update(signature).digest("hex"),
          assertionSignatureP1363Base64url: assertion.signatureP1363Base64url,
          operatorDisplayCode: challenge.displayCode,
          authorityInstanceId: request.authorityInstanceId,
          operatorConfigurationRevision: request.configurationRevision,
        }),
      }),
    );
  }
}

/** Loopback session ceremony: native A1 verification and durable consume precede minting. */
export class OperatorSessionAuthority {
  readonly #options: OperatorSessionAuthorityOptions;

  constructor(options: OperatorSessionAuthorityOptions) {
    if (
      !/^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        options.authorityInstanceId,
      ) ||
      !Number.isSafeInteger(options.configurationRevision) ||
      options.configurationRevision < 1
    )
      throw new ActionCredentialConfigurationError(
        "operator session authority configuration is invalid",
      );
    this.#options = options;
  }

  async currentBinding(): Promise<
    Readonly<{ readonly authorityInstanceId: string; readonly configurationRevision: number }>
  > {
    const state = await this.#currentState();
    return Object.freeze({
      authorityInstanceId: state.authorityInstanceId,
      configurationRevision: state.configurationRevision,
    });
  }

  async #currentState(): Promise<OperatorAuthorityLiveState> {
    const state = validateOperatorAuthorityState(await this.#options.loadCurrent());
    syncOperatorSessionRegistry(
      this.#options.sessions,
      state.credentials,
      state.configurationRevision,
    );
    return state;
  }

  async issueChallenge(request: OperatorPresenceRequest): Promise<OperatorPresenceChallenge> {
    const state = await this.#currentState();
    if (
      request.operation !== "open-session" ||
      request.method !== "POST" ||
      request.path !== "/v1/operator-sessions" ||
      request.authorityInstanceId !== state.authorityInstanceId ||
      request.configurationRevision !== state.configurationRevision ||
      request.principalId !== LOCAL_OPERATOR_PRINCIPAL
    )
      throw new OperatorPresenceError("operator request binding is invalid");
    const credential = state.credentials.byId.get(request.credentialId);
    if (
      credential === undefined ||
      credential.profile !== "operator-interactive" ||
      credential.status !== "active" ||
      expiresNow(credential.expiresAt, new Date().toISOString())
    )
      throw new OperatorPresenceError("operator credential is unavailable");
    operatorSessionRequestSchema.parse(strictJsonBody(request.rawBody));
    const challenge = issueDaemonChallenge(
      request,
      expectedOpenSessionDisplayCode(state.authorityInstanceId),
    );
    issueOperatorPresenceChallenge(this.#options.database, {
      challengeId: challenge.challengeId,
      authorityInstanceId: request.authorityInstanceId,
      operatorConfigurationRevision: request.configurationRevision,
      challengeNonceBase64url: challenge.nonceBase64url,
      credentialId: request.credentialId,
      operation: request.operation,
      requestMethod: request.method,
      requestPath: request.path,
      requestBodySha256: challenge.request.bodySha256,
      operatorDisplayCode: challenge.displayCode,
      challengeCommitment: challenge.commitment,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    });
    return challenge;
  }

  /** Sign only the exact challenge that is already durable and still bound to this request. */
  async signChallenge(
    request: OperatorPresenceRequest,
    challenge: OperatorPresenceChallenge,
  ): Promise<OperatorPresenceAssertion> {
    const state = await this.#currentState();
    if (this.#options.broker.sign === undefined)
      throw new OperatorPresenceError(
        "native operator presence signing is unavailable",
        "action.operator_presence_unsupported",
      );
    const durable = readOperatorPresenceChallenge(
      this.#options.database,
      challenge.challengeId,
      request.credentialId,
    );
    if (
      request.authorityInstanceId !== state.authorityInstanceId ||
      request.configurationRevision !== state.configurationRevision ||
      durable === undefined ||
      durable.commitment !== challenge.commitment ||
      durable.request.operation !== request.operation ||
      durable.request.method !== request.method ||
      durable.request.path !== request.path ||
      durable.request.bodySha256 !== createHash("sha256").update(request.rawBody).digest("hex") ||
      durable.request.authorityInstanceId !== request.authorityInstanceId ||
      durable.request.configurationRevision !== request.configurationRevision
    )
      throw new OperatorPresenceError("operator challenge binding is invalid");
    return this.#options.broker.sign(request, challenge);
  }

  async open(
    request: OperatorPresenceRequest,
    assertion: OperatorPresenceAssertion,
    now = new Date().toISOString(),
  ): Promise<Readonly<{ readonly session: OperatorSession; readonly token: string }>> {
    const state = await this.#currentState();
    if (
      request.operation !== "open-session" ||
      request.authorityInstanceId !== state.authorityInstanceId ||
      request.configurationRevision !== state.configurationRevision ||
      request.credentialId !== assertion.credentialId
    )
      throw new ActionCredentialConfigurationError(
        "only a current open-session ceremony may mint a session",
      );
    operatorSessionRequestSchema.parse(strictJsonBody(request.rawBody));
    const credential = state.credentials.byId.get(assertion.credentialId);
    if (
      credential === undefined ||
      credential.profile !== "operator-interactive" ||
      credential.status !== "active" ||
      expiresNow(credential.expiresAt, now)
    )
      throw new ActionCredentialConfigurationError("operator credential was not found");
    const signatureBytes = Buffer.from(assertion.signatureP1363Base64url, "base64url");
    const challenge = readOperatorPresenceChallenge(
      this.#options.database,
      assertion.challengeId,
      assertion.credentialId,
    );
    const requestBodySha256 = createHash("sha256").update(request.rawBody).digest("hex");
    if (
      challenge === undefined ||
      challenge.request.operation !== request.operation ||
      challenge.request.method !== request.method ||
      challenge.request.path !== request.path ||
      challenge.request.bodySha256 !== requestBodySha256 ||
      challenge.request.authorityInstanceId !== request.authorityInstanceId ||
      challenge.request.configurationRevision !== request.configurationRevision ||
      Date.parse(now) < Date.parse(challenge.issuedAt) ||
      Date.parse(now) >= Date.parse(challenge.expiresAt) ||
      !verifyOperatorAssertionSignature(credential, challenge.commitment, signatureBytes)
    )
      throw new OperatorPresenceError("operator challenge binding or signature is invalid");
    await this.#options.broker.verify(assertion, request, challenge.commitment);
    const sessionId = `operator-session:${randomUUID()}`;
    const consumed = consumeOperatorPresenceChallenge(this.#options.database, {
      challengeId: assertion.challengeId,
      consumedAt: now,
      operation: "open-session",
      authorityOutputKind: "operator-session",
      authorityOutputId: sessionId,
      credentialId: assertion.credentialId,
      signatureP1363Base64url: assertion.signatureP1363Base64url,
      signatureSha256: createHash("sha256").update(signatureBytes).digest("hex"),
    });
    if (
      consumed.request.operation !== request.operation ||
      consumed.request.method !== request.method ||
      consumed.request.path !== request.path ||
      consumed.request.bodySha256 !== createHash("sha256").update(request.rawBody).digest("hex") ||
      consumed.request.authorityInstanceId !== request.authorityInstanceId ||
      consumed.request.configurationRevision !== request.configurationRevision
    ) {
      throw new OperatorPresenceError("operator challenge binding is invalid");
    }
    const capability: VerifiedOpenSessionCapability = Object.freeze({
      [verifiedOpenSessionCapability]: Object.freeze({
        credentialId: credential.credentialId,
        verifiedAt: now,
        configurationRevision: state.configurationRevision,
      }),
    });
    return this.#options.sessions.issue(capability);
  }
}

/**
 * Compose the only public session route. The caller has to obtain an
 * assertion from the native broker first; this handler never accepts a
 * bearer credential, identity, or caller-supplied profile.
 */
export function createOperatorSessionHandler(
  authority: OperatorSessionAuthority,
): OperationHandler {
  return (input, context) => {
    operatorSessionRequestSchema.parse(input);
    const assertion = context.operatorAssertion;
    const body = context.requestBodyBytes;
    if (assertion === undefined || body === undefined) {
      throw {
        code: "action.operator_assertion_invalid",
        message: "operator presence assertion is invalid",
        details: {},
      };
    }
    return authority
      .currentBinding()
      .then((binding) =>
        authority.open(
          {
            operation: "open-session",
            method: "POST",
            path: "/v1/operator-sessions",
            rawBody: new Uint8Array(body),
            credentialId: assertion.credentialId,
            principalId: "principal:local-operator",
            authorityInstanceId: binding.authorityInstanceId,
            configurationRevision: binding.configurationRevision,
          },
          assertion,
        ),
      )
      .then(({ session, token }) =>
        operatorSessionResponseSchema.parse({
          sessionId: session.sessionId,
          token,
          tokenType: "Bearer",
          scopes: session.scopes,
          issuedAt: session.issuedAt,
          expiresAt: session.expiresAt,
        }),
      )
      .catch((error: unknown) => {
        if (
          error instanceof OperatorPresenceError ||
          error instanceof ActionCredentialConfigurationError
        ) {
          throw {
            code:
              error instanceof OperatorPresenceError
                ? error.code
                : "action.operator_assertion_invalid",
            message: error.message,
            details: {},
          };
        }
        throw error;
      });
  };
}
