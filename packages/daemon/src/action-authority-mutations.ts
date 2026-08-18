import type { Database } from "bun:sqlite";
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  invalidateAuthorityForConfigurationChange,
  consumeSealKeyAdministration,
  readOperatorPresenceChallenge,
} from "../../storage/src/action-approval-authority";
import {
  actionApprovalSealKeyringPath,
  loadApprovalSealKeyringFile,
  removeApprovalSealKeyringFile,
  rotateApprovalSealKeyringFile,
  type ApprovalSealKeyringFile,
} from "../../storage/src/action-approval-keyring";
import {
  loadOperatorCredentialConfiguration,
  operatorCredentialConfigurationSchema,
  writeOperatorCredentialConfiguration,
  type OperatorCredentialConfiguration,
} from "./action-authority-auth";
import type { AuthorityFileLock } from "./action-authority-lock";

export type AuthorityMutationOptions = Readonly<{
  readonly database: Database;
  readonly authorityLock: AuthorityFileLock;
  readonly privateRoot: string;
  readonly now?: () => string;
}>;

const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
const commitmentSchema = z.string().min(1).max(4_096);
const credentialIdSchema = z.string().regex(/^credential:operator:[0-9a-f]{64}$/u);
export const operatorCredentialCeremonyProofSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("enroll"),
    configuration: operatorCredentialConfigurationSchema,
    enrollmentCommitment: commitmentSchema,
    signatureP1363Base64url: signatureSchema,
  }),
  z.strictObject({
    kind: z.literal("rotate"),
    configuration: operatorCredentialConfigurationSchema,
    currentCredentialId: credentialIdSchema,
    rotationCommitment: commitmentSchema,
    rotationSignatureP1363Base64url: signatureSchema,
    replacementEnrollmentCommitment: commitmentSchema,
    replacementEnrollmentSignatureP1363Base64url: signatureSchema,
  }),
  z.strictObject({
    kind: z.literal("revoke"),
    configuration: operatorCredentialConfigurationSchema,
    credentialId: credentialIdSchema,
    revocationCommitment: commitmentSchema,
    revocationSignatureP1363Base64url: signatureSchema,
  }),
  z.strictObject({
    kind: z.literal("recover"),
    configuration: operatorCredentialConfigurationSchema,
    replacementEnrollmentCommitment: commitmentSchema,
    replacementEnrollmentSignatureP1363Base64url: signatureSchema,
  }),
]);
export type OperatorCredentialCeremonyProof = z.infer<typeof operatorCredentialCeremonyProofSchema>;
export const authorityMutationProofSchema = operatorCredentialCeremonyProofSchema;
export type AuthorityMutationProof = z.infer<typeof authorityMutationProofSchema>;

export const sealKeyAdministrationEnvelopeSchema = z.strictObject({
  version: z.literal("agent-mail-action-authority-admin-v1"),
  requestBodyBase64url: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u)
    .max(2_048),
  assertion: z.strictObject({
    version: z.literal("agent-mail-macos-operator-presence-v1"),
    challengeId: z.string().regex(/^operator-challenge:[0-9a-f-]{36}$/u),
    credentialId: z.string().regex(/^credential:operator:[0-9a-f]{64}$/u),
    signatureBase64url: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  }),
});
export type SealKeyAdministrationEnvelope = z.infer<typeof sealKeyAdministrationEnvelopeSchema>;

function mutationTime(options: AuthorityMutationOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

const SEAL_KEY_ROTATE_PATH = "/internal/action-authority/seal-keyring/rotate";
const SEAL_KEY_REMOVE_PATH = "/internal/action-authority/seal-keyring/remove";

function decodeCanonicalBody(value: string): Uint8Array {
  const body = Buffer.from(value, "base64url");
  if (
    body.byteLength > 2_048 ||
    body.toString("base64url") !== value ||
    new TextDecoder("utf-8", { fatal: true }).decode(body).length === 0
  )
    throw new Error("seal-key administration body is invalid");
  return body;
}

function expectedSealAdministrationDisplayCode(
  operation: "seal-key-rotate" | "seal-key-remove",
  authorityInstanceId: string,
  expectedKeyringRevision: number,
  targetKeyId: string,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "agent-mail-presence-display-v1",
        operation,
        authorityInstanceId,
        expectedKeyringRevision,
        targetKeyId,
      ]),
    )
    .digest("hex")
    .slice(0, 20);
  return digest.match(/.{4}/gu)!.join("-");
}

function sealAdministrationBody(
  operation: "seal-key-rotate" | "seal-key-remove",
  body: Uint8Array,
): Readonly<{ readonly expectedKeyringRevision: number; readonly targetKeyId: string }> {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    parsed = JSON.parse(text) as unknown;
    if (JSON.stringify(parsed) !== text) throw new Error("non-canonical JSON");
  } catch {
    throw new Error("seal-key administration body is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("seal-key administration body is invalid");
  const record = parsed as Record<string, unknown>;
  const expected =
    operation === "seal-key-rotate"
      ? ["expectedKeyringRevision", "expectedActiveKeyId"]
      : ["expectedKeyringRevision", "keyId"];
  const keys = Object.keys(record);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw new Error("seal-key administration body is invalid");
  const target = record[expected[1]];
  if (
    typeof record.expectedKeyringRevision !== "number" ||
    !Number.isSafeInteger(record.expectedKeyringRevision) ||
    record.expectedKeyringRevision < 1 ||
    typeof target !== "string" ||
    !/^approval-seal-key:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      target,
    )
  )
    throw new Error("seal-key administration body is invalid");
  return Object.freeze({
    expectedKeyringRevision: record.expectedKeyringRevision,
    targetKeyId: target,
  });
}

function verifyLowSCeremonySignature(
  publicKeySpkiBase64url: string,
  commitment: string,
  signatureBase64url: string,
): void {
  const signature = Buffer.from(signatureBase64url, "base64url");
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  if (signature.length !== 64) throw new Error("operator presence assertion is invalid");
  const r = BigInt(`0x${signature.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  if (r <= 0n || r >= order || s <= 0n || s > order / 2n)
    throw new Error("operator presence assertion is invalid");
  const key = createPublicKey({
    key: Buffer.from(publicKeySpkiBase64url, "base64url"),
    format: "der",
    type: "spki",
  });
  if (!verify("sha256", Buffer.from(commitment), { key, dsaEncoding: "ieee-p1363" }, signature))
    throw new Error("operator presence assertion is invalid");
}

type OperatorCredentialRecord = OperatorCredentialConfiguration["credentials"][number];
type AuthorityConfigurationProjection = Readonly<{
  readonly authorityInstanceId: string;
  readonly configurationRevision: number;
  readonly credentials: readonly OperatorCredentialRecord[];
}>;

function verifyCeremonySignature(
  record: OperatorCredentialRecord,
  commitment: string,
  signatureBase64url: string,
): void {
  const signature = Buffer.from(signatureBase64url, "base64url");
  if (signature.length !== 64) throw new Error("operator ceremony signature is invalid");
  const r = BigInt(`0x${signature.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  if (r <= 0n || r >= order || s <= 0n || s > order / 2n)
    throw new Error("operator ceremony signature is not low-S P1363");
  const key = createPublicKey({
    key: Buffer.from(record.publicKeySpkiBase64url, "base64url"),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      "sha256",
      Buffer.from(commitment, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    )
  )
    throw new Error("operator ceremony signature is invalid");
}

function canonicalArray(commitment: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commitment);
  } catch {
    throw new Error("operator ceremony commitment is invalid");
  }
  if (!Array.isArray(parsed) || JSON.stringify(parsed) !== commitment)
    throw new Error("operator ceremony commitment is not canonical");
  return parsed;
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(value).toISOString() === value
  );
}

function freshAdministrationTime(value: unknown, now: string): value is string {
  return canonicalInstant(value) && Math.abs(Date.parse(now) - Date.parse(value)) <= 60_000;
}

function assertEnrollmentProof(
  configuration: OperatorCredentialConfiguration,
  commitment: string,
  signature: string,
): void {
  const values = canonicalArray(commitment);
  const activeRecords = configuration.credentials.filter(
    (candidate) => candidate.status === "active",
  );
  const record = activeRecords[0];
  if (
    activeRecords.length !== 1 ||
    record === undefined ||
    values.length !== 10 ||
    values[0] !== "agent-mail-operator-enrollment-v1" ||
    values[1] !== configuration.authorityInstanceId ||
    typeof values[2] !== "string" ||
    values[3] !== "principal:local-operator" ||
    values[4] !== record.credentialId ||
    values[5] !== "operator-interactive" ||
    values[6] !== "ES256" ||
    values[7] !== record.publicKeySpkiBase64url ||
    values[8] !== record.enrolledAt ||
    typeof values[9] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(values[9])
  )
    throw new Error("operator enrollment commitment does not match configuration");
  verifyCeremonySignature(record, commitment, signature);
}

function assertCredentialCeremony(
  current: AuthorityConfigurationProjection,
  proof: OperatorCredentialCeremonyProof,
  now: string,
): void {
  const next = proof.configuration;
  if (next.configurationRevision !== current.configurationRevision + 1)
    throw new Error("operator configuration revision must advance exactly once");
  const currentActiveRecords = current.credentials.filter(
    (candidate) => candidate.status === "active",
  );
  const currentActive = currentActiveRecords[0];
  const nextActiveRecords = next.credentials.filter((candidate) => candidate.status === "active");
  const nextActive = nextActiveRecords[0];
  const expectedNextActiveCount = proof.kind === "revoke" ? 0 : 1;
  if (currentActiveRecords.length > 1 || nextActiveRecords.length !== expectedNextActiveCount)
    throw new Error("operator configuration must contain exactly one active credential");
  if (proof.kind !== "recover" && next.authorityInstanceId !== current.authorityInstanceId)
    throw new Error("only recovery may change authority instance");
  if (proof.kind === "recover") {
    if (
      next.authorityInstanceId === current.authorityInstanceId ||
      nextActive === undefined ||
      current.credentials.some((candidate) => candidate.credentialId === nextActive.credentialId) ||
      next.credentials.some(
        (candidate) =>
          candidate.status === "revoked" &&
          !current.credentials.some((prior) => prior.credentialId === candidate.credentialId),
      )
    )
      throw new Error("recovery must create a new authority instance and active credential");
    assertEnrollmentProof(
      next,
      proof.replacementEnrollmentCommitment,
      proof.replacementEnrollmentSignatureP1363Base64url,
    );
    return;
  }
  if (proof.kind === "enroll") {
    if (currentActive !== undefined || nextActive === undefined || next.credentials.length !== 1)
      throw new Error("enrollment requires no current active credential");
    assertEnrollmentProof(next, proof.enrollmentCommitment, proof.signatureP1363Base64url);
    return;
  }
  if (currentActive === undefined)
    throw new Error("operator ceremony requires an active credential");
  if (proof.kind === "rotate") {
    const replacement = next.credentials.find((candidate) => candidate.status === "active");
    const revoked = next.credentials.find(
      (candidate) => candidate.credentialId === proof.currentCredentialId,
    );
    if (
      currentActive.credentialId !== proof.currentCredentialId ||
      replacement === undefined ||
      revoked?.status !== "revoked" ||
      next.credentials.length !== 2 ||
      replacement.credentialId === currentActive.credentialId ||
      next.credentials.some(
        (candidate) =>
          candidate.credentialId !== replacement.credentialId &&
          candidate.credentialId !== currentActive.credentialId,
      )
    )
      throw new Error("operator rotation configuration does not match current authority");
    const rotation = canonicalArray(proof.rotationCommitment);
    if (
      rotation.length !== 7 ||
      rotation[0] !== "agent-mail-operator-rotation-v1" ||
      rotation[1] !== current.authorityInstanceId ||
      rotation[2] !== proof.currentCredentialId ||
      rotation[3] !== replacement.credentialId ||
      rotation[4] !== replacement.publicKeySpkiSha256 ||
      !freshAdministrationTime(rotation[5], now) ||
      typeof rotation[6] !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(rotation[6])
    )
      throw new Error("operator rotation commitment does not match configuration");
    verifyCeremonySignature(
      currentActive,
      proof.rotationCommitment,
      proof.rotationSignatureP1363Base64url,
    );
    assertEnrollmentProof(
      next,
      proof.replacementEnrollmentCommitment,
      proof.replacementEnrollmentSignatureP1363Base64url,
    );
    return;
  }
  if (currentActive.credentialId !== proof.credentialId)
    throw new Error("operator revocation credential is not current");
  const revoked = next.credentials.find(
    (candidate) => candidate.credentialId === proof.credentialId,
  );
  const currentIds = new Set(current.credentials.map((candidate) => candidate.credentialId));
  const nextIds = new Set(next.credentials.map((candidate) => candidate.credentialId));
  if (
    revoked?.status !== "revoked" ||
    next.credentials.length !== current.credentials.length ||
    nextIds.size !== currentIds.size ||
    [...currentIds].some((credentialId) => !nextIds.has(credentialId)) ||
    next.credentials.some((candidate) => candidate.status === "active")
  )
    throw new Error("operator revocation did not revoke the current credential");
  const revocation = canonicalArray(proof.revocationCommitment);
  if (
    revocation.length !== 5 ||
    revocation[0] !== "agent-mail-operator-revocation-v1" ||
    revocation[1] !== current.authorityInstanceId ||
    revocation[2] !== proof.credentialId ||
    !freshAdministrationTime(revocation[3], now) ||
    typeof revocation[4] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(revocation[4])
  )
    throw new Error("operator revocation commitment does not match configuration");
  verifyCeremonySignature(
    currentActive,
    proof.revocationCommitment,
    proof.revocationSignatureP1363Base64url,
  );
}

/**
 * Publish a credential configuration and close the old authority while one
 * exclusive file/process admission is held. A crash after the atomic file
 * replacement is fail-closed; startup reconciliation repeats the same DB
 * closure from the stricter file projection.
 */
export async function replaceOperatorCredentialConfiguration(
  options: AuthorityMutationOptions,
  value: unknown,
): Promise<
  Readonly<{
    readonly configuration: OperatorCredentialConfiguration;
    readonly invalidatedApprovals: number;
    readonly invalidatedChallenges: number;
  }>
> {
  return options.authorityLock.runExclusive(async () => {
    const proof = authorityMutationProofSchema.parse(value);
    let current: AuthorityConfigurationProjection;
    try {
      current = (await loadOperatorCredentialConfiguration(options.privateRoot)).configuration;
    } catch (error: unknown) {
      const path = join(options.privateRoot, "config", "operator-credentials.v1.json");
      const existing = await lstat(path).catch(() => undefined);
      if (proof.kind !== "enroll" || existing !== undefined) throw error;
      current = Object.freeze({
        authorityInstanceId: proof.configuration.authorityInstanceId,
        configurationRevision: 0,
        credentials: Object.freeze([]),
      });
    }
    assertCredentialCeremony(current, proof, mutationTime(options));
    const configuration = await writeOperatorCredentialConfiguration(
      options.privateRoot,
      proof.configuration,
    );
    const result = invalidateAuthorityForConfigurationChange(options.database, {
      authorityInstanceId: configuration.authorityInstanceId,
      configurationRevision: configuration.configurationRevision,
      activeCredentialIds: configuration.credentials
        .filter((credential) => credential.status === "active")
        .map((credential) => credential.credentialId),
      invalidatedAt: mutationTime(options),
    });
    return Object.freeze({ configuration, ...result });
  });
}

/**
 * Verify and apply the daemon-issued D28 administration assertion. The
 * challenge, exact ADMIN binding, current keyring revision, file replacement,
 * and durable challenge consumption all remain inside one exclusive window.
 */
export async function applySealKeyAdministration(
  options: AuthorityMutationOptions,
  value: unknown,
): Promise<
  Readonly<{ readonly keyring: ApprovalSealKeyringFile; readonly invalidatedApprovals: number }>
> {
  const envelope = sealKeyAdministrationEnvelopeSchema.parse(value);
  const body = decodeCanonicalBody(envelope.requestBodyBase64url);
  return options.authorityLock.runExclusive(async () => {
    const at = mutationTime(options);
    const loadedConfiguration = await loadOperatorCredentialConfiguration(options.privateRoot);
    const credential = loadedConfiguration.credentials.byId.get(envelope.assertion.credentialId);
    if (
      credential === undefined ||
      credential.profile !== "operator-interactive" ||
      credential.status !== "active" ||
      Date.parse(at) >= Date.parse(credential.expiresAt)
    )
      throw new Error("operator presence assertion is invalid");
    const challenge = readOperatorPresenceChallenge(
      options.database,
      envelope.assertion.challengeId,
      envelope.assertion.credentialId,
    );
    if (
      challenge === undefined ||
      (challenge.request.operation !== "seal-key-rotate" &&
        challenge.request.operation !== "seal-key-remove")
    )
      throw new Error("operator presence assertion is invalid");
    const operation = challenge.request.operation;
    const requestPath =
      operation === "seal-key-rotate" ? SEAL_KEY_ROTATE_PATH : SEAL_KEY_REMOVE_PATH;
    const requestBodySha256 = createHash("sha256").update(body).digest("hex");
    if (
      challenge.request.method !== "ADMIN" ||
      challenge.request.path !== requestPath ||
      challenge.request.bodySha256 !== requestBodySha256 ||
      challenge.request.authorityInstanceId !==
        loadedConfiguration.configuration.authorityInstanceId ||
      challenge.request.configurationRevision !==
        loadedConfiguration.configuration.configurationRevision ||
      challenge.request.credentialId !== credential.credentialId ||
      Date.parse(at) < Date.parse(challenge.issuedAt) ||
      Date.parse(at) >= Date.parse(challenge.expiresAt)
    )
      throw new Error("operator presence assertion is invalid");
    const closure = options.database
      .query(
        "SELECT 1 FROM operator_presence_challenge_consumptions WHERE challenge_id = ? UNION ALL SELECT 1 FROM operator_presence_challenge_expirations WHERE challenge_id = ? UNION ALL SELECT 1 FROM operator_presence_challenge_invalidations WHERE challenge_id = ?;",
      )
      .get(challenge.challengeId, challenge.challengeId, challenge.challengeId);
    if (closure !== null) throw new Error("operator presence assertion is invalid");
    const administration = sealAdministrationBody(operation, body);
    if (
      challenge.displayCode !==
        expectedSealAdministrationDisplayCode(
          operation,
          loadedConfiguration.configuration.authorityInstanceId,
          administration.expectedKeyringRevision,
          administration.targetKeyId,
        ) ||
      challenge.request.operatorDisplayCode !== challenge.displayCode
    )
      throw new Error("operator presence assertion is invalid");
    const loadedKeyring = await loadApprovalSealKeyringFile({
      privateRoot: options.privateRoot,
      databaseExists: true,
    });
    if (
      administration.expectedKeyringRevision !== loadedKeyring.file.keyringRevision ||
      (operation === "seal-key-rotate" &&
        administration.targetKeyId !== loadedKeyring.file.activeKeyId) ||
      (operation === "seal-key-remove" &&
        loadedKeyring.file.keys.find((key) => key.keyId === administration.targetKeyId)?.status !==
          "verify-only")
    )
      throw new Error("operator keyring binding is stale");
    verifyLowSCeremonySignature(
      credential.publicKeySpkiBase64url,
      challenge.commitment,
      envelope.assertion.signatureBase64url,
    );
    const next =
      operation === "seal-key-rotate"
        ? await rotateApprovalSealKeyringFile(options.privateRoot)
        : await removeApprovalSealKeyringFile(options.privateRoot, administration.targetKeyId);
    const invalidatedApprovals = consumeSealKeyAdministration(options.database, {
      challengeId: challenge.challengeId,
      consumedAt: at,
      operation,
      credentialId: credential.credentialId,
      authorityInstanceId: loadedConfiguration.configuration.authorityInstanceId,
      operatorConfigurationRevision: loadedConfiguration.configuration.configurationRevision,
      requestPath,
      requestBodySha256,
      operatorDisplayCode: challenge.displayCode,
      signatureP1363Base64url: envelope.assertion.signatureBase64url,
      signatureSha256: createHash("sha256")
        .update(Buffer.from(envelope.assertion.signatureBase64url, "base64url"))
        .digest("hex"),
      authorityOutputId: `seal-keyring-revision:${next.keyringRevision}`,
      ...(operation === "seal-key-remove" ? { removedKeyId: administration.targetKeyId } : {}),
    });
    await loadApprovalSealKeyringFile({ privateRoot: options.privateRoot, databaseExists: true });
    return Object.freeze({ keyring: next, invalidatedApprovals });
  });
}

export function approvalSealKeyringMutationPath(privateRoot: string): string {
  return actionApprovalSealKeyringPath(privateRoot);
}
