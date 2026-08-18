import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isTrustedAuthorityContext } from "./trusted-authority-context";
type AvailableApproval = Readonly<{
  readonly state: "available";
  readonly approvalId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly previewDigest: string;
  readonly targetDigest: string;
  readonly normalizedIntent: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly authorizationScope: "mail:action.commit";
  readonly approver: Readonly<{
    readonly principalId: string;
    readonly profile: "operator-interactive";
  }>;
}>;
type ConsumptionReceipt = Readonly<{
  readonly receiptId: string;
  readonly approvalId: string;
  readonly planId: string;
  readonly claimId: string;
  readonly consumedAt: string;
  readonly committer: Readonly<{
    readonly principalId: string;
    readonly profile: "agent-unattended";
  }>;
  readonly executorProfile: "internal-action-executor";
}>;
type Presence =
  | Readonly<{
      readonly kind: "human-present";
      readonly ceremonyId: string;
      readonly verifiedAt: string;
      readonly validUntil: string;
      readonly requestMethod: "POST" | "DELETE";
      readonly requestPath: string;
      readonly requestBodySha256: string;
      readonly challengeCommitmentSha256: string;
      readonly assertionSignatureSha256: string;
      readonly assertionSignatureP1363Base64url: string;
      readonly displayCode: string;
      readonly authorityInstanceId: string;
      readonly operatorConfigurationRevision: number;
    }>
  | Readonly<{ readonly kind: "unattended" }>
  | Readonly<{ readonly kind: "a1-non-approval-session"; readonly sessionId: string }>;

export type DurableOperation =
  | "open-session"
  | "approve"
  | "cancel-approval"
  | "seal-key-rotate"
  | "seal-key-remove";
type DurableRequestMethod = "POST" | "DELETE" | "ADMIN";
export type OperatorPresenceChallengeRecord = Readonly<{
  readonly challengeId: string;
  readonly nonceBase64url: string;
  readonly commitment: string;
  readonly displayCode: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly request: Readonly<{
    readonly operation: DurableOperation;
    readonly method: DurableRequestMethod;
    readonly path: string;
    readonly bodySha256: string;
    readonly principalId: "principal:local-operator";
    readonly credentialId: string;
    readonly authorityInstanceId: string;
    readonly configurationRevision: number;
    readonly operatorDisplayCode: string;
  }>;
}>;

const APPROVAL_LIFETIME_MS = 600_000;
const PRESENCE_MAX_AGE_MS = 60_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const P1363_BASE64URL = /^[A-Za-z0-9_-]{86}$/u;
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

export type ApprovalSealKey = Readonly<{
  readonly keyId: string;
  readonly keyHex: string;
  readonly status: "active" | "verify-only";
}>;

export type ApprovalSealKeyring = Readonly<{
  readonly revision: number;
  readonly active: ApprovalSealKey;
  readonly keys: ReadonlyMap<string, ApprovalSealKey>;
}>;

export function createApprovalSealKeyring(
  active: Readonly<{ readonly keyId: string; readonly keyHex: string }>,
  verifyOnly: readonly Readonly<{ readonly keyId: string; readonly keyHex: string }>[] = [],
  revision = 1,
): ApprovalSealKeyring {
  if (!/^[0-9a-f]{64}$/u.test(active.keyHex))
    throw new TypeError("approval seal key must be 32 bytes");
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError("keyring revision is invalid");
  const keys = new Map<string, ApprovalSealKey>();
  keys.set(active.keyId, Object.freeze({ ...active, status: "active" }));
  for (const key of verifyOnly) {
    if (!/^[0-9a-f]{64}$/u.test(key.keyHex) || keys.has(key.keyId))
      throw new TypeError("approval seal keyring contains an invalid or duplicate key");
    keys.set(key.keyId, Object.freeze({ ...key, status: "verify-only" }));
  }
  return Object.freeze({ revision, active: keys.get(active.keyId)!, keys });
}

export function rotateApprovalSealKey(
  keyring: ApprovalSealKeyring,
  next: Readonly<{ readonly keyId: string; readonly keyHex: string }>,
): ApprovalSealKeyring {
  return createApprovalSealKeyring(
    next,
    [...keyring.keys.values()].map((key) => ({ keyId: key.keyId, keyHex: key.keyHex })),
    keyring.revision + 1,
  );
}

export function removeApprovalSealKey(
  keyring: ApprovalSealKeyring,
  keyId: string,
): ApprovalSealKeyring {
  const candidate = keyring.keys.get(keyId);
  if (candidate === undefined || candidate.status === "active")
    throw new TypeError("active or missing approval seal key cannot be removed");
  const remaining = [...keyring.keys.values()]
    .filter((key) => key.keyId !== keyId)
    .map((key) => ({ keyId: key.keyId, keyHex: key.keyHex }));
  return createApprovalSealKeyring(
    { keyId: keyring.active.keyId, keyHex: keyring.active.keyHex },
    remaining,
    keyring.revision + 1,
  );
}

/** Backups contain data only; approval HMAC key bytes are never serialized. */
export function approvalKeyringBackupProjection(keyring: ApprovalSealKeyring): Readonly<{
  readonly revision: number;
  readonly activeKeyId: string;
  readonly verifyOnlyKeyIds: readonly string[];
}> {
  return Object.freeze({
    revision: keyring.revision,
    activeKeyId: keyring.active.keyId,
    verifyOnlyKeyIds: Object.freeze(
      [...keyring.keys.values()]
        .filter((key) => key.status === "verify-only")
        .map((key) => key.keyId),
    ),
  });
}

export type AuthorityContext = Readonly<{
  readonly principalId: string;
  readonly credentialId: string;
  readonly profile: "operator-interactive" | "agent-unattended" | "internal-action-executor";
  readonly scopes: readonly string[];
  readonly authEventId: string;
  readonly authenticatedAt: string;
  readonly credentialExpiresAt: string;
  readonly presence: Presence;
}>;
type OperatorAuthorityContext = AuthorityContext &
  Readonly<{
    readonly profile: "operator-interactive";
    readonly presence: Readonly<{
      readonly kind: "human-present";
      readonly ceremonyId: string;
      readonly verifiedAt: string;
      readonly validUntil: string;
      readonly requestMethod: "POST" | "DELETE";
      readonly requestPath: string;
      readonly requestBodySha256: string;
    }>;
  }>;
type AgentAuthorityContext = AuthorityContext &
  Readonly<{
    readonly profile: "agent-unattended";
    readonly presence: Readonly<{ readonly kind: "unattended" }>;
  }>;

type ApprovalAuthorityRequestBinding = Readonly<{
  readonly method: "POST" | "DELETE";
  readonly path: string;
  readonly bodySha256: string;
  readonly challengeCommitmentSha256: string;
  readonly assertionSignatureSha256: string;
  readonly assertionSignatureP1363Base64url: string;
  readonly displayCode: string;
  readonly authorityInstanceId: string;
  readonly operatorConfigurationRevision: number;
}>;

export type ApprovalAuthorityIssueInput = Readonly<{
  readonly request: unknown;
  readonly context: AuthorityContext;
  readonly now: unknown;
  readonly keyring: ApprovalSealKeyring;
}>;

export type ApprovalAuthorityConsumeInput = Readonly<{
  readonly request: unknown;
  readonly context: AuthorityContext;
  readonly now: unknown;
  readonly keyring: ApprovalSealKeyring;
}>;

export type ApprovalAuthorityCancelInput = Readonly<{
  readonly request: unknown;
  readonly context: AuthorityContext;
  readonly now: unknown;
}>;

export type OperatorPresenceChallengeIssueInput = Readonly<{
  readonly challengeId: string;
  readonly authorityInstanceId: string;
  readonly operatorConfigurationRevision: number;
  readonly challengeNonceBase64url: string;
  readonly credentialId: string;
  readonly operation: DurableOperation;
  readonly requestMethod: DurableRequestMethod;
  readonly requestPath: string;
  readonly requestBodySha256: string;
  readonly operatorDisplayCode: string;
  readonly challengeCommitment: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}>;

export type ApprovalAuthorityResult = Readonly<{
  readonly approval: AvailableApproval;
  readonly receipt?: ConsumptionReceipt;
}>;

export class ApprovalAuthorityError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly status: 403 | 404 | 409 | 429 | 503;

  constructor(
    code: string,
    message: string,
    status: 403 | 404 | 409 | 429 | 503,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApprovalAuthorityError";
    this.code = code;
    this.status = status;
    this.details = Object.freeze({ ...details });
  }
}

type ApprovalRequest = Readonly<{
  readonly planId: string;
  readonly planVersion: number;
  readonly previewDigest: string;
}>;
type ConsumeRequest = ApprovalRequest & Readonly<{ readonly approvalId: string }>;
type CancelRequest = ApprovalRequest & Readonly<{ readonly approvalId: string }>;

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError("authority request must be an object");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requestText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

function authorityIdentity(value: unknown, label: string, prefix: string): string {
  const identity = requestText(value, label);
  if (identity.length <= prefix.length || identity.length > 256 || !identity.startsWith(prefix))
    throw new TypeError(`${label} has the wrong namespace`);
  return identity;
}

function requestDigest(value: unknown, label: string): string {
  const text = requestText(value, label);
  if (!SHA256.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function requestVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError("planVersion is invalid");
  return value;
}

function approveRequest(value: unknown): ApprovalRequest {
  const record = recordValue(value);
  if (!exactKeys(record, ["planId", "planVersion", "previewDigest"]))
    throw new TypeError("approve request has unknown fields");
  return {
    planId: requestText(record.planId, "planId"),
    planVersion: requestVersion(record.planVersion),
    previewDigest: requestDigest(record.previewDigest, "previewDigest"),
  };
}

function consumeRequest(value: unknown): ConsumeRequest {
  const record = recordValue(value);
  if (!exactKeys(record, ["planId", "planVersion", "previewDigest", "approvalId"]))
    throw new TypeError("commit request has unknown fields");
  return {
    planId: requestText(record.planId, "planId"),
    planVersion: requestVersion(record.planVersion),
    previewDigest: requestDigest(record.previewDigest, "previewDigest"),
    approvalId: requestText(record.approvalId, "approvalId"),
  };
}

function cancelRequest(value: unknown): CancelRequest {
  const parsed = consumeRequest(value);
  return parsed;
}

function nowString(value: unknown): string {
  const parsed = requestText(value, "authority time");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed) ||
    !Number.isFinite(Date.parse(parsed)) ||
    new Date(Date.parse(parsed)).toISOString() !== parsed
  )
    throw new TypeError("authority time must be canonical UTC");
  return parsed;
}

function contextValue(value: unknown): AuthorityContext {
  if (!isTrustedAuthorityContext(value))
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  const candidate = recordValue(value);
  if (
    !exactKeys(candidate, [
      "principalId",
      "credentialId",
      "profile",
      "scopes",
      "authEventId",
      "authenticatedAt",
      "credentialExpiresAt",
      "presence",
    ])
  )
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  const profile = candidate.profile;
  if (
    profile !== "operator-interactive" &&
    profile !== "agent-unattended" &&
    profile !== "internal-action-executor"
  )
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  const presence = candidate.presence;
  if (
    typeof candidate.principalId !== "string" ||
    typeof candidate.credentialId !== "string" ||
    typeof candidate.authEventId !== "string" ||
    typeof candidate.authenticatedAt !== "string" ||
    typeof candidate.credentialExpiresAt !== "string" ||
    !Array.isArray(candidate.scopes) ||
    candidate.scopes.some((scope) => typeof scope !== "string") ||
    new Set(candidate.scopes).size !== candidate.scopes.length ||
    typeof presence !== "object" ||
    presence === null
  )
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  const principalId = requestText(candidate.principalId, "principalId");
  const credentialId = requestText(candidate.credentialId, "credentialId");
  const authEventId = requestText(candidate.authEventId, "authEventId");
  const authenticatedAt = nowString(candidate.authenticatedAt);
  const credentialExpiresAt = nowString(candidate.credentialExpiresAt);
  if (Date.parse(credentialExpiresAt) <= Date.parse(authenticatedAt))
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  return {
    principalId,
    credentialId,
    profile,
    scopes: candidate.scopes.filter((scope): scope is string => typeof scope === "string"),
    authEventId,
    authenticatedAt,
    credentialExpiresAt,
    presence: parsePresence(presence),
  };
}

function parsePresence(value: object): Presence {
  const candidate = recordValue(value);
  if (
    candidate.kind === "human-present" &&
    exactKeys(candidate, [
      "kind",
      "ceremonyId",
      "verifiedAt",
      "validUntil",
      "requestMethod",
      "requestPath",
      "requestBodySha256",
      "challengeCommitmentSha256",
      "assertionSignatureSha256",
      "assertionSignatureP1363Base64url",
      "displayCode",
      "authorityInstanceId",
      "operatorConfigurationRevision",
    ]) &&
    typeof candidate.ceremonyId === "string" &&
    typeof candidate.verifiedAt === "string" &&
    typeof candidate.validUntil === "string" &&
    (candidate.requestMethod === "POST" || candidate.requestMethod === "DELETE") &&
    typeof candidate.requestPath === "string" &&
    typeof candidate.requestBodySha256 === "string" &&
    typeof candidate.challengeCommitmentSha256 === "string" &&
    typeof candidate.assertionSignatureSha256 === "string" &&
    typeof candidate.assertionSignatureP1363Base64url === "string" &&
    typeof candidate.displayCode === "string" &&
    typeof candidate.authorityInstanceId === "string" &&
    typeof candidate.operatorConfigurationRevision === "number" &&
    Number.isSafeInteger(candidate.operatorConfigurationRevision) &&
    candidate.operatorConfigurationRevision > 0 &&
    SHA256.test(candidate.requestBodySha256) &&
    SHA256.test(candidate.challengeCommitmentSha256) &&
    SHA256.test(candidate.assertionSignatureSha256) &&
    P1363_BASE64URL.test(candidate.assertionSignatureP1363Base64url) &&
    /^[0-9a-f]{4}(?:-[0-9a-f]{4}){4}$/u.test(candidate.displayCode)
  )
    return {
      kind: "human-present",
      ceremonyId: requestText(candidate.ceremonyId, "ceremonyId"),
      verifiedAt: nowString(candidate.verifiedAt),
      validUntil: nowString(candidate.validUntil),
      requestMethod: candidate.requestMethod,
      requestPath: requestText(candidate.requestPath, "request path"),
      requestBodySha256: candidate.requestBodySha256,
      challengeCommitmentSha256: candidate.challengeCommitmentSha256,
      assertionSignatureSha256: candidate.assertionSignatureSha256,
      assertionSignatureP1363Base64url: candidate.assertionSignatureP1363Base64url,
      displayCode: candidate.displayCode,
      authorityInstanceId: requestText(candidate.authorityInstanceId, "authority instance ID"),
      operatorConfigurationRevision: candidate.operatorConfigurationRevision,
    };
  if (candidate.kind === "unattended" && exactKeys(candidate, ["kind"]))
    return { kind: "unattended" };
  if (
    candidate.kind === "a1-non-approval-session" &&
    exactKeys(candidate, ["kind", "sessionId"]) &&
    typeof candidate.sessionId === "string"
  )
    return {
      kind: "a1-non-approval-session",
      sessionId: requestText(candidate.sessionId, "sessionId"),
    };
  throw new ApprovalAuthorityError(
    "action.approval_forbidden",
    "request credentials cannot perform this approval operation",
    403,
  );
}

function requestBinding(
  value: ApprovalAuthorityRequestBinding,
  expectedMethod: "POST" | "DELETE",
): ApprovalAuthorityRequestBinding {
  if (
    value.method !== expectedMethod ||
    !SHA256.test(value.bodySha256) ||
    !SHA256.test(value.challengeCommitmentSha256) ||
    !SHA256.test(value.assertionSignatureSha256) ||
    !isCanonicalLowSP1363(value.assertionSignatureP1363Base64url) ||
    !Number.isSafeInteger(value.operatorConfigurationRevision) ||
    value.operatorConfigurationRevision < 1
  )
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
  requestText(value.path, "request path");
  requestText(value.authorityInstanceId, "authority instance ID");
  const observedSignatureDigest = createHash("sha256")
    .update(Buffer.from(value.assertionSignatureP1363Base64url, "base64url"))
    .digest("hex");
  if (observedSignatureDigest !== value.assertionSignatureSha256)
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
  if (!/^[0-9a-f]{4}(?:-[0-9a-f]{4}){4}$/u.test(value.displayCode))
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
  return value;
}

function isCanonicalLowSP1363(value: string): boolean {
  if (!P1363_BASE64URL.test(value)) return false;
  const signature = Buffer.from(value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value) return false;
  const r = BigInt(`0x${signature.subarray(0, 32).toString("hex")}`);
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  return r > 0n && r < P256_ORDER && s > 0n && s <= P256_ORDER / 2n;
}

function operatorContext(
  context: AuthorityContext,
  now: string,
  expectedMethod: "POST" | "DELETE",
): OperatorAuthorityContext {
  const parsed = contextValue(context);
  if (
    parsed.profile !== "operator-interactive" ||
    parsed.principalId !== "principal:local-operator" ||
    !parsed.scopes.includes("mail:action.approve") ||
    parsed.presence.kind !== "human-present"
  )
    throw new ApprovalAuthorityError(
      "action.approval_presence_required",
      "fresh human-present authentication is required",
      403,
    );
  if (
    parsed.presence.ceremonyId.length === 0 ||
    parsed.presence.requestMethod !== expectedMethod ||
    Date.parse(now) > Date.parse(parsed.presence.validUntil) + 5_000 ||
    Date.parse(parsed.credentialExpiresAt) <= Date.parse(now) ||
    Date.parse(parsed.authenticatedAt) > Date.parse(now) + 5_000 ||
    Date.parse(now) - Date.parse(parsed.presence.verifiedAt) > PRESENCE_MAX_AGE_MS ||
    Date.parse(parsed.presence.verifiedAt) > Date.parse(now) + 5_000
  )
    throw new ApprovalAuthorityError(
      "action.approval_presence_required",
      "fresh human-present authentication is required",
      403,
    );
  if (parsed.presence.kind !== "human-present") throw new Error("operator presence disappeared");
  return { ...parsed, profile: "operator-interactive", presence: parsed.presence };
}

function bindingFromOperatorContext(
  context: OperatorAuthorityContext,
): ApprovalAuthorityRequestBinding {
  return {
    method: context.presence.requestMethod,
    path: context.presence.requestPath,
    bodySha256: context.presence.requestBodySha256,
    challengeCommitmentSha256: context.presence.challengeCommitmentSha256,
    assertionSignatureSha256: context.presence.assertionSignatureSha256,
    assertionSignatureP1363Base64url: context.presence.assertionSignatureP1363Base64url,
    displayCode: context.presence.displayCode,
    authorityInstanceId: context.presence.authorityInstanceId,
    operatorConfigurationRevision: context.presence.operatorConfigurationRevision,
  };
}

function agentContext(context: unknown, now = new Date().toISOString()): AgentAuthorityContext {
  const parsed = contextValue(context);
  if (
    parsed.profile !== "agent-unattended" ||
    !parsed.scopes.includes("mail:action.commit") ||
    parsed.scopes.includes("mail:action.approve") ||
    parsed.presence.kind !== "unattended"
  )
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  if (Date.parse(parsed.credentialExpiresAt) <= Date.parse(now))
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  if (parsed.presence.kind !== "unattended") throw new Error("agent presence disappeared");
  return { ...parsed, profile: "agent-unattended", presence: parsed.presence };
}

function canonicalTargetSet(database: Database, planId: string): string {
  const rows = database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid, precondition_modseq FROM action_plan_targets WHERE plan_id = ?;",
    )
    .all(planId)
    .map((value) => recordValue(value));
  if (rows.length === 0)
    throw new ApprovalAuthorityError(
      "action.approval_mismatch",
      "action approval does not match the frozen plan",
      409,
      { planId, approvalId: "approval:unknown" },
    );
  const sorted = [...rows].sort((left, right) => {
    const leftAccount = String(left.account_id);
    const rightAccount = String(right.account_id);
    const account = Buffer.from(leftAccount).compare(Buffer.from(rightAccount));
    if (account !== 0) return account;
    const mailbox = Buffer.from(String(left.mailbox_id)).compare(
      Buffer.from(String(right.mailbox_id)),
    );
    if (mailbox !== 0) return mailbox;
    return (
      Number(left.uid_validity) - Number(right.uid_validity) ||
      Number(left.uid) - Number(right.uid) ||
      Number(left.precondition_modseq) - Number(right.precondition_modseq)
    );
  });
  return JSON.stringify([
    "action-target-set-v1",
    sorted.map((row) => [
      row.account_id,
      row.mailbox_id,
      row.uid_validity,
      row.uid,
      row.precondition_modseq,
    ]),
  ]);
}

function targetDigest(targetSet: string): string {
  return createHash("sha256").update(targetSet).digest("hex");
}

function normalizedIntent(actionKind: string, targetDigestValue: string): string {
  return JSON.stringify(["action-intent-v1", actionKind, targetDigestValue]);
}

function previewDigest(
  planId: string,
  planVersion: number,
  actionKind: string,
  canonicalTargets: string,
  intent: string,
  createdAt: string,
  expiresAt: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "action-preview-v1",
        planId,
        planVersion,
        actionKind,
        canonicalTargets,
        intent,
        createdAt,
        expiresAt,
      ]),
    )
    .digest("hex");
}

/** Compute the authority-v1 preview digest from the immutable stored plan. */
export function authorityPreviewDigestForPlan(database: Database, planId: string): string {
  const plan = planRow(database, planId);
  const version = readInteger(plan, "version");
  const targets = canonicalTargetSet(database, planId);
  const digest = targetDigest(targets);
  const intent = normalizedIntent(readString(plan, "action_kind"), digest);
  return previewDigest(
    planId,
    version,
    readString(plan, "action_kind"),
    targets,
    intent,
    readString(plan, "created_at"),
    readString(plan, "expires_at"),
  );
}

function approvalCommitment(fields: readonly unknown[]): string {
  return JSON.stringify(["action-approval-authority-v1", ...fields]);
}

function seal(keyHex: string, commitment: string): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(commitment).digest("hex");
}

function planRow(database: Database, planId: string): Readonly<Record<string, unknown>> {
  const row = database
    .query(
      "SELECT plan_id, action_kind, state, created_at, expires_at, version FROM action_plans WHERE plan_id = ?;",
    )
    .get(planId);
  if (typeof row !== "object" || row === null || Array.isArray(row))
    throw new ApprovalAuthorityError(
      "action.approval_not_found",
      "action approval was not found",
      404,
      { planId, approvalId: "approval:unknown" },
    );
  return recordValue(row);
}

function readString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`authority row ${key} is invalid`);
  return value;
}

function parseDurableOperation(value: string): DurableOperation {
  if (
    value === "open-session" ||
    value === "approve" ||
    value === "cancel-approval" ||
    value === "seal-key-rotate" ||
    value === "seal-key-remove"
  )
    return value;
  throw new Error("authority challenge operation is invalid");
}

function parseRequestMethod(value: string): DurableRequestMethod {
  if (value === "POST" || value === "DELETE" || value === "ADMIN") return value;
  throw new Error("authority challenge request method is invalid");
}

function readInteger(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`authority row ${key} is invalid`);
  return value;
}

export function recordTrustedActionPlanCreator(
  database: Database,
  input: Readonly<{
    readonly planId: string;
    readonly principalId: string;
    readonly credentialId: string;
    readonly profile: "operator-interactive" | "agent-unattended";
    readonly authEventId: string;
    readonly createdAt: string;
  }>,
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database
      .query(
        "INSERT INTO action_plan_authority_versions (plan_id, authority_version, reason_code, recorded_at) VALUES (?, 'trusted-v1', 'trusted-create', ?);",
      )
      .run(input.planId, input.createdAt);
    database
      .query(
        "INSERT INTO action_plan_creators (plan_id, principal_id, credential_id, profile, auth_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?);",
      )
      .run(
        input.planId,
        input.principalId,
        input.credentialId,
        input.profile,
        input.authEventId,
        input.createdAt,
      );
    database.exec("COMMIT;");
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** Create provenance only from an already authenticated service context. */
export function createTrustedPendingActionPlan(
  database: Database,
  create: () => Readonly<{ readonly planId: string; readonly createdAt: string }>,
  creator: Readonly<{
    readonly principalId: string;
    readonly credentialId: string;
    readonly profile: "operator-interactive" | "agent-unattended";
    readonly authEventId: string;
  }>,
): Readonly<{ readonly planId: string; readonly createdAt: string }> {
  const plan = create();
  recordTrustedActionPlanCreator(database, {
    ...creator,
    planId: plan.planId,
    createdAt: plan.createdAt,
  });
  return plan;
}

/** Persist a broker-issued challenge before any approval/session transaction. */
export function issueOperatorPresenceChallenge(
  database: Database,
  input: OperatorPresenceChallengeIssueInput,
): void {
  const issuedAt = nowString(input.issuedAt);
  const expiresAt = nowString(input.expiresAt);
  if (
    !input.challengeId.startsWith("operator-challenge:") ||
    !input.credentialId.startsWith("credential:") ||
    !/^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.authorityInstanceId,
    ) ||
    input.requestMethod !==
      (input.operation === "cancel-approval"
        ? "DELETE"
        : input.operation === "seal-key-rotate" || input.operation === "seal-key-remove"
          ? "ADMIN"
          : "POST") ||
    !SHA256.test(input.requestBodySha256) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(input.challengeNonceBase64url) ||
    Buffer.from(input.challengeNonceBase64url, "base64url").length !== 32 ||
    !/^[0-9a-f]{4}(?:-[0-9a-f]{4}){4}$/u.test(input.operatorDisplayCode) ||
    Date.parse(expiresAt) - Date.parse(issuedAt) !== PRESENCE_MAX_AGE_MS ||
    input.challengeCommitment.length === 0 ||
    input.challengeCommitment.length > 4_096 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(input.challengeCommitment)
  )
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
  database.exec("BEGIN IMMEDIATE;");
  try {
    // Close expired available ceremonies before applying global/per-credential
    // capacity. This keeps capacity a durable state transition, not a query
    // projection that can be replayed after restart.
    database
      .query(
        "INSERT INTO operator_presence_challenge_expirations (challenge_id, expired_at) SELECT c.challenge_id, ? FROM operator_presence_challenges c LEFT JOIN operator_presence_challenge_consumptions x ON x.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_expirations e ON e.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_invalidations i ON i.challenge_id = c.challenge_id WHERE c.expires_at <= ? AND x.challenge_id IS NULL AND e.challenge_id IS NULL AND i.challenge_id IS NULL;",
      )
      .run(issuedAt, issuedAt);
    const available = database
      .query(
        "SELECT COUNT(*) AS count FROM operator_presence_challenges c LEFT JOIN operator_presence_challenge_consumptions x ON x.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_expirations e ON e.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_invalidations i ON i.challenge_id = c.challenge_id WHERE x.challenge_id IS NULL AND e.challenge_id IS NULL AND i.challenge_id IS NULL AND c.expires_at > ?;",
      )
      .get(issuedAt) as { readonly count?: unknown };
    const perCredential = database
      .query(
        "SELECT COUNT(*) AS count FROM operator_presence_challenges c LEFT JOIN operator_presence_challenge_consumptions x ON x.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_expirations e ON e.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_invalidations i ON i.challenge_id = c.challenge_id WHERE c.credential_id = ? AND x.challenge_id IS NULL AND e.challenge_id IS NULL AND i.challenge_id IS NULL AND c.expires_at > ?;",
      )
      .get(input.credentialId, issuedAt) as { readonly count?: unknown };
    const rate = database
      .query(
        "SELECT COUNT(*) AS count FROM operator_presence_challenges WHERE credential_id = ? AND issued_at >= ?;",
      )
      .get(input.credentialId, new Date(Date.parse(issuedAt) - 60_000).toISOString()) as {
      readonly count?: unknown;
    };
    if (
      Number(available.count) >= 128 ||
      Number(perCredential.count) >= 4 ||
      Number(rate.count) >= 10
    )
      throw new ApprovalAuthorityError(
        "action.operator_challenge_capacity",
        "operator challenge capacity is exhausted",
        429,
      );
    database
      .query(
        "INSERT INTO operator_presence_challenges (challenge_id, authority_instance_id, operator_configuration_revision, challenge_nonce_base64url, credential_id, principal_id, profile, operation, request_method, request_path, request_body_sha256, operator_display_code, challenge_commitment, challenge_commitment_sha256, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, 'principal:local-operator', 'operator-interactive', ?, ?, ?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        input.challengeId,
        input.authorityInstanceId,
        input.operatorConfigurationRevision,
        input.challengeNonceBase64url,
        input.credentialId,
        input.operation,
        input.requestMethod,
        input.requestPath,
        input.requestBodySha256,
        input.operatorDisplayCode,
        input.challengeCommitment,
        createHash("sha256").update(input.challengeCommitment).digest("hex"),
        issuedAt,
        expiresAt,
      );
    database.exec("COMMIT;");
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export type OperatorPresenceChallengeConsumptionInput = Readonly<{
  readonly challengeId: string;
  readonly consumedAt: string;
  readonly operation: DurableOperation;
  readonly authorityOutputKind:
    | "operator-session"
    | "approval"
    | "cancellation"
    | "seal-key-rotation"
    | "seal-key-removal";
  readonly authorityOutputId: string;
  readonly credentialId: string;
  readonly signatureP1363Base64url: string;
  readonly signatureSha256: string;
}>;

/** Read one still-durable challenge without closing it. This is provisional
 * admission only; approval/session authority is granted only by the consume
 * transaction owned by the eventual operation. */
export function readOperatorPresenceChallenge(
  database: Database,
  challengeId: string,
  credentialId: string,
): OperatorPresenceChallengeRecord | undefined {
  const row = database
    .query(
      "SELECT * FROM operator_presence_challenges WHERE challenge_id = ? AND credential_id = ?;",
    )
    .get(challengeId, credentialId);
  if (!isRecord(row)) return undefined;
  const value = recordValue(row);
  return Object.freeze({
    challengeId: readString(value, "challenge_id"),
    nonceBase64url: readString(value, "challenge_nonce_base64url"),
    commitment: readString(value, "challenge_commitment"),
    displayCode: readString(value, "operator_display_code"),
    issuedAt: readString(value, "issued_at"),
    expiresAt: readString(value, "expires_at"),
    request: Object.freeze({
      operation: parseDurableOperation(readString(value, "operation")),
      method: parseRequestMethod(readString(value, "request_method")),
      path: readString(value, "request_path"),
      bodySha256: readString(value, "request_body_sha256"),
      principalId: "principal:local-operator",
      credentialId: readString(value, "credential_id"),
      authorityInstanceId: readString(value, "authority_instance_id"),
      configurationRevision: readInteger(value, "operator_configuration_revision"),
      operatorDisplayCode: readString(value, "operator_display_code"),
    }),
  });
}

/** Consume a previously persisted challenge exactly once in BEGIN IMMEDIATE. */
export function consumeOperatorPresenceChallenge(
  database: Database,
  input: OperatorPresenceChallengeConsumptionInput,
): OperatorPresenceChallengeRecord {
  const consumedAt = nowString(input.consumedAt);
  if (
    !input.challengeId.startsWith("operator-challenge:") ||
    !(
      (input.authorityOutputKind === "operator-session" &&
        input.authorityOutputId.startsWith("operator-session:")) ||
      ((input.authorityOutputKind === "approval" || input.authorityOutputKind === "cancellation") &&
        input.authorityOutputId.startsWith("approval:")) ||
      ((input.authorityOutputKind === "seal-key-rotation" ||
        input.authorityOutputKind === "seal-key-removal") &&
        /^seal-keyring-revision:[1-9][0-9]*$/u.test(input.authorityOutputId))
    ) ||
    !P1363_BASE64URL.test(input.signatureP1363Base64url) ||
    createHash("sha256")
      .update(Buffer.from(input.signatureP1363Base64url, "base64url"))
      .digest("hex") !== input.signatureSha256
  )
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
  database.exec("BEGIN IMMEDIATE;");
  try {
    const row = database
      .query(
        "SELECT * FROM operator_presence_challenges WHERE challenge_id = ? AND credential_id = ?;",
      )
      .get(input.challengeId, input.credentialId);
    if (!isRecord(row))
      throw new ApprovalAuthorityError(
        "action.operator_challenge_not_found",
        "operator challenge was not found",
        404,
      );
    const closure = database
      .query(
        "SELECT 1 FROM operator_presence_challenge_consumptions WHERE challenge_id = ? UNION ALL SELECT 1 FROM operator_presence_challenge_expirations WHERE challenge_id = ? UNION ALL SELECT 1 FROM operator_presence_challenge_invalidations WHERE challenge_id = ?;",
      )
      .get(input.challengeId, input.challengeId, input.challengeId);
    if (closure !== null)
      throw new ApprovalAuthorityError(
        "action.operator_challenge_consumed",
        "operator challenge was already consumed",
        409,
      );
    if (Date.parse(consumedAt) >= Date.parse(readString(row, "expires_at")))
      throw new ApprovalAuthorityError(
        "action.operator_challenge_expired",
        "operator challenge has expired",
        409,
      );
    if (readString(row, "operation") !== input.operation)
      throw new ApprovalAuthorityError(
        "action.operator_assertion_invalid",
        "operator presence assertion is invalid",
        403,
      );
    database
      .query(
        "INSERT INTO operator_presence_challenge_consumptions (challenge_id, consumed_at, operation, authority_output_kind, authority_output_id, signature_p1363_base64url, signature_sha256) VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        input.challengeId,
        consumedAt,
        input.operation,
        input.authorityOutputKind,
        input.authorityOutputId,
        input.signatureP1363Base64url,
        input.signatureSha256,
      );
    database.exec("COMMIT;");
    return Object.freeze({
      challengeId: readString(row, "challenge_id"),
      nonceBase64url: readString(row, "challenge_nonce_base64url"),
      commitment: readString(row, "challenge_commitment"),
      displayCode: readString(row, "operator_display_code"),
      issuedAt: readString(row, "issued_at"),
      expiresAt: readString(row, "expires_at"),
      request: Object.freeze({
        operation: parseDurableOperation(readString(row, "operation")),
        method: parseRequestMethod(readString(row, "request_method")),
        path: readString(row, "request_path"),
        bodySha256: readString(row, "request_body_sha256"),
        principalId: "principal:local-operator",
        credentialId: readString(row, "credential_id"),
        authorityInstanceId: readString(row, "authority_instance_id"),
        configurationRevision: readInteger(row, "operator_configuration_revision"),
        operatorDisplayCode: readString(row, "operator_display_code"),
      }),
    });
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export type SealKeyAdministrationConsumptionInput = Readonly<{
  readonly challengeId: string;
  readonly consumedAt: string;
  readonly operation: "seal-key-rotate" | "seal-key-remove";
  readonly credentialId: string;
  readonly authorityInstanceId: string;
  readonly operatorConfigurationRevision: number;
  readonly requestPath: string;
  readonly requestBodySha256: string;
  readonly operatorDisplayCode: string;
  readonly signatureP1363Base64url: string;
  readonly signatureSha256: string;
  readonly authorityOutputId: `seal-keyring-revision:${number}`;
  readonly removedKeyId?: string;
}>;

/**
 * Close a D28 administration challenge in the same SQLite transaction as
 * removal invalidations. The keyring file is replaced by the caller while
 * the exclusive authority lock is held; a failed transaction therefore leaves
 * a newer file revision that startup will reconcile fail-closed.
 */
export function consumeSealKeyAdministration(
  database: Database,
  input: SealKeyAdministrationConsumptionInput,
): number {
  const consumedAt = nowString(input.consumedAt);
  if (
    !input.challengeId.startsWith("operator-challenge:") ||
    !/^instance:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.authorityInstanceId,
    ) ||
    !Number.isSafeInteger(input.operatorConfigurationRevision) ||
    input.operatorConfigurationRevision < 1 ||
    !/^seal-keyring-revision:[1-9][0-9]*$/u.test(input.authorityOutputId) ||
    !P1363_BASE64URL.test(input.signatureP1363Base64url) ||
    !SHA256.test(input.signatureSha256) ||
    createHash("sha256")
      .update(Buffer.from(input.signatureP1363Base64url, "base64url"))
      .digest("hex") !== input.signatureSha256 ||
    input.requestPath !==
      (input.operation === "seal-key-rotate"
        ? "/internal/action-authority/seal-keyring/rotate"
        : "/internal/action-authority/seal-keyring/remove") ||
    !SHA256.test(input.requestBodySha256) ||
    !/^[0-9a-f]{4}(?:-[0-9a-f]{4}){4}$/u.test(input.operatorDisplayCode)
  )
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
  database.exec("BEGIN IMMEDIATE;");
  try {
    const row = database
      .query(
        "SELECT * FROM operator_presence_challenges WHERE challenge_id = ? AND credential_id = ?;",
      )
      .get(input.challengeId, input.credentialId);
    if (!isRecord(row))
      throw new ApprovalAuthorityError(
        "action.operator_challenge_not_found",
        "operator challenge was not found",
        404,
      );
    const challenge = recordValue(row);
    const closure = database
      .query(
        "SELECT 1 FROM operator_presence_challenge_consumptions WHERE challenge_id = ? UNION ALL SELECT 1 FROM operator_presence_challenge_expirations WHERE challenge_id = ? UNION ALL SELECT 1 FROM operator_presence_challenge_invalidations WHERE challenge_id = ?;",
      )
      .get(input.challengeId, input.challengeId, input.challengeId);
    if (closure !== null)
      throw new ApprovalAuthorityError(
        "action.operator_challenge_consumed",
        "operator challenge was already consumed",
        409,
      );
    if (
      challenge.operation !== input.operation ||
      challenge.request_method !== "ADMIN" ||
      challenge.credential_id !== input.credentialId ||
      challenge.authority_instance_id !== input.authorityInstanceId ||
      challenge.operator_configuration_revision !== input.operatorConfigurationRevision ||
      challenge.request_path !== input.requestPath ||
      challenge.request_body_sha256 !== input.requestBodySha256 ||
      challenge.operator_display_code !== input.operatorDisplayCode ||
      Date.parse(consumedAt) >= Date.parse(readString(challenge, "expires_at"))
    )
      throw new ApprovalAuthorityError(
        "action.operator_assertion_invalid",
        "operator presence assertion is invalid",
        403,
      );
    const outputKind =
      input.operation === "seal-key-rotate" ? "seal-key-rotation" : "seal-key-removal";
    database
      .query(
        "INSERT INTO operator_presence_challenge_consumptions (challenge_id, consumed_at, operation, authority_output_kind, authority_output_id, signature_p1363_base64url, signature_sha256) VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        input.challengeId,
        consumedAt,
        input.operation,
        outputKind,
        input.authorityOutputId,
        input.signatureP1363Base64url,
        input.signatureSha256,
      );
    let invalidated = 0;
    if (input.operation === "seal-key-remove") {
      if (
        input.removedKeyId === undefined ||
        !/^approval-seal-key:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          input.removedKeyId,
        )
      )
        throw new Error("removed seal key ID is required");
      const rows = database
        .query(
          "SELECT a.approval_id, a.plan_id, a.seal_key_id, p.version FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id LEFT JOIN action_approval_consumptions c ON c.approval_id = a.approval_id LEFT JOIN action_approval_expirations e ON e.approval_id = a.approval_id LEFT JOIN action_approval_cancellations x ON x.approval_id = a.approval_id LEFT JOIN action_approval_invalidations i ON i.approval_id = a.approval_id WHERE a.seal_key_id = ? AND c.approval_id IS NULL AND e.approval_id IS NULL AND x.approval_id IS NULL AND i.approval_id IS NULL AND p.state = 'pending';",
        )
        .all(input.removedKeyId)
        .map((value) => recordValue(value));
      const affectedPlans = new Map<string, number>();
      for (const approval of rows) {
        const planId = readString(approval, "plan_id");
        const version = readInteger(approval, "version");
        const priorVersion = affectedPlans.get(planId);
        if (priorVersion !== undefined && priorVersion !== version)
          throw new Error("seal-key invalidation plan version mismatch");
        affectedPlans.set(planId, version);
        database
          .query(
            "INSERT INTO action_approval_invalidations (approval_id, invalidated_at, reason_code, plan_version_before, plan_version_after) VALUES (?, ?, 'key-unavailable', ?, ?);",
          )
          .run(readString(approval, "approval_id"), consumedAt, version, version + 1);
        invalidated += 1;
      }
      for (const [planId, version] of affectedPlans) {
        const updated = database
          .query(
            "UPDATE action_plans SET version = version + 1 WHERE plan_id = ? AND state = 'pending' AND version = ?;",
          )
          .run(planId, version);
        if (updated.changes !== 1) throw new Error("seal-key invalidation version race");
      }
    }
    database.exec("COMMIT;");
    return invalidated;
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function issueActionApproval(
  database: Database,
  input: ApprovalAuthorityIssueInput,
): ApprovalAuthorityResult {
  const request = approveRequest(input.request);
  const now = nowString(input.now);
  const context = operatorContext(input.context, now, "POST");
  const binding = requestBinding(bindingFromOperatorContext(context), "POST");
  if (binding.path !== `/v1/action-plans/${encodeURIComponent(request.planId)}/approvals`)
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
  const plan = planRow(database, request.planId);
  const version = readInteger(plan, "version");
  if (readString(plan, "state") !== "pending")
    throw new ApprovalAuthorityError("action.plan_not_pending", "action plan is not pending", 409, {
      planId: request.planId,
      state: readString(plan, "state"),
    });
  if (version !== request.planVersion)
    throw new ApprovalAuthorityError(
      "action.plan_version_stale",
      "action plan version is stale",
      409,
      { planId: request.planId, currentVersion: version },
    );
  const planExpiresAt = readString(plan, "expires_at");
  if (Date.parse(now) >= Date.parse(planExpiresAt))
    throw new ApprovalAuthorityError("action.plan_expired", "action plan has expired", 409, {
      planId: request.planId,
      expiredAt: planExpiresAt,
    });
  const authority = database
    .query("SELECT authority_version FROM action_plan_authority_versions WHERE plan_id = ?;")
    .get(request.planId);
  if (
    typeof authority !== "object" ||
    authority === null ||
    !isRecord(authority) ||
    authority.authority_version !== "trusted-v1"
  )
    throw new ApprovalAuthorityError(
      "action.legacy_authority",
      "action plan lacks trusted approval authority",
      409,
      { planId: request.planId },
    );
  const targets = canonicalTargetSet(database, request.planId);
  const digest = targetDigest(targets);
  const intent = normalizedIntent(readString(plan, "action_kind"), digest);
  const issuedAt = now;
  const expiresAt = new Date(
    Math.min(
      Date.parse(planExpiresAt),
      Date.parse(context.credentialExpiresAt),
      Date.parse(issuedAt) + APPROVAL_LIFETIME_MS,
    ),
  ).toISOString();
  const expectedPreviewDigest = previewDigest(
    request.planId,
    version,
    readString(plan, "action_kind"),
    targets,
    intent,
    readString(plan, "created_at"),
    readString(plan, "expires_at"),
  );
  if (request.previewDigest !== expectedPreviewDigest)
    throw new ApprovalAuthorityError(
      "action.approval_mismatch",
      "action approval does not match the frozen plan",
      409,
      { planId: request.planId, approvalId: "approval:unknown" },
    );
  const approvalId = `approval:${randomUUID()}`;
  const nonce = randomBytes(32).toString("hex");
  const commitmentFields = [
    approvalId,
    context.principalId,
    context.credentialId,
    context.profile,
    context.authEventId,
    context.presence.ceremonyId,
    context.presence.verifiedAt,
    binding.method,
    binding.path,
    binding.bodySha256,
    binding.authorityInstanceId,
    binding.operatorConfigurationRevision,
    binding.challengeCommitmentSha256,
    binding.assertionSignatureSha256,
    binding.displayCode,
    request.planId,
    version,
    request.previewDigest,
    digest,
    targets,
    intent,
    issuedAt,
    expiresAt,
    nonce,
    "mail:action.commit",
    input.keyring.active.keyId,
    input.keyring.revision,
    "hmac-sha256",
  ];
  const commitment = approvalCommitment(commitmentFields);
  const approval: AvailableApproval = {
    state: "available",
    approvalId,
    planId: request.planId,
    planVersion: version,
    previewDigest: request.previewDigest,
    targetDigest: digest,
    normalizedIntent: intent,
    issuedAt,
    expiresAt,
    authorizationScope: "mail:action.commit",
    approver: { principalId: context.principalId, profile: "operator-interactive" },
  };
  database.exec("BEGIN IMMEDIATE;");
  try {
    const challenge = database
      .query(
        "SELECT authority_instance_id, operator_configuration_revision, credential_id, principal_id, profile, operation, request_method, request_path, request_body_sha256, operator_display_code, challenge_commitment, expires_at FROM operator_presence_challenges WHERE challenge_id = ?;",
      )
      .get(context.presence.ceremonyId);
    if (
      typeof challenge !== "object" ||
      challenge === null ||
      Object.entries({
        authority_instance_id: binding.authorityInstanceId,
        operator_configuration_revision: binding.operatorConfigurationRevision,
        credential_id: context.credentialId,
        principal_id: context.principalId,
        profile: context.profile,
        operation: "approve",
        request_method: binding.method,
        request_path: binding.path,
        request_body_sha256: binding.bodySha256,
        operator_display_code: binding.displayCode,
        challenge_commitment: binding.challengeCommitmentSha256,
      }).some(
        ([key, expected]) =>
          !isRecord(challenge) ||
          (key === "challenge_commitment"
            ? createHash("sha256")
                .update(readString(recordValue(challenge), key))
                .digest("hex") !== expected
            : challenge[key] !== expected),
      ) ||
      Date.parse(readString(recordValue(challenge), "expires_at")) <= Date.parse(now)
    )
      throw new ApprovalAuthorityError(
        "action.operator_assertion_invalid",
        "operator presence assertion is invalid",
        403,
      );
    database
      .query(
        "INSERT INTO action_approvals (approval_id, plan_id, plan_version, preview_digest, target_digest, canonical_target_set, normalized_intent, approver_principal_id, approver_credential_id, approver_profile, approver_auth_event_id, ceremony_id, user_presence_verified_at, presence_request_method, presence_request_path, presence_request_body_sha256, authority_instance_id, operator_configuration_revision, challenge_commitment_sha256, assertion_signature_sha256, operator_display_code, issued_at, expires_at, nonce, authorization_scope, seal_key_id, seal_keyring_revision, seal_algorithm, seal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        approvalId,
        request.planId,
        version,
        request.previewDigest,
        digest,
        targets,
        intent,
        context.principalId,
        context.credentialId,
        context.profile,
        context.authEventId,
        context.presence.ceremonyId,
        context.presence.verifiedAt,
        binding.method,
        binding.path,
        binding.bodySha256,
        binding.authorityInstanceId,
        binding.operatorConfigurationRevision,
        binding.challengeCommitmentSha256,
        binding.assertionSignatureSha256,
        binding.displayCode,
        issuedAt,
        expiresAt,
        nonce,
        "mail:action.commit",
        input.keyring.active.keyId,
        input.keyring.revision,
        "hmac-sha256",
        seal(input.keyring.active.keyHex, commitment),
      );
    database
      .query(
        "INSERT INTO operator_presence_challenge_consumptions (challenge_id, consumed_at, operation, authority_output_kind, authority_output_id, signature_p1363_base64url, signature_sha256) VALUES (?, ?, 'approve', 'approval', ?, ?, ?);",
      )
      .run(
        context.presence.ceremonyId,
        now,
        approvalId,
        binding.assertionSignatureP1363Base64url,
        binding.assertionSignatureSha256,
      );
    database.exec("COMMIT;");
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return { approval };
}

export function consumeActionApproval(
  database: Database,
  input: ApprovalAuthorityConsumeInput,
): ConsumptionReceipt {
  const request = consumeRequest(input.request);
  const now = nowString(input.now);
  const context = agentContext(input.context, now);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const existing = database
      .query(
        "SELECT c.receipt_id, c.consumed_at FROM action_approval_consumptions c JOIN action_approvals a ON a.approval_id = c.approval_id WHERE c.approval_id = ?;",
      )
      .get(request.approvalId);
    if (typeof existing === "object" && existing !== null)
      throw new ApprovalAuthorityError(
        "action.approval_consumed",
        "action approval was already consumed",
        409,
        {
          planId: request.planId,
          approvalId: request.approvalId,
          receiptId: readString(recordValue(existing), "receipt_id"),
          consumedAt: readString(recordValue(existing), "consumed_at"),
        },
      );
    const closed = database
      .query(
        "SELECT 'cancelled' AS state, cancelled_at AS closed_at FROM action_approval_cancellations WHERE approval_id = ? UNION ALL SELECT 'expired', expired_at FROM action_approval_expirations WHERE approval_id = ? UNION ALL SELECT 'invalidated', invalidated_at FROM action_approval_invalidations WHERE approval_id = ?;",
      )
      .get(request.approvalId, request.approvalId, request.approvalId);
    if (typeof closed === "object" && closed !== null) {
      const closure = recordValue(closed);
      const state = readString(closure, "state");
      const code =
        state === "cancelled"
          ? "action.approval_cancelled"
          : state === "expired"
            ? "action.approval_expired"
            : "action.approval_invalidated";
      const details =
        state === "cancelled"
          ? {
              planId: request.planId,
              approvalId: request.approvalId,
              cancelledAt: readString(closure, "closed_at"),
            }
          : state === "expired"
            ? {
                planId: request.planId,
                approvalId: request.approvalId,
                expiredAt: readString(closure, "closed_at"),
              }
            : {
                planId: request.planId,
                approvalId: request.approvalId,
                invalidatedAt: readString(closure, "closed_at"),
              };
      throw new ApprovalAuthorityError(
        code,
        state === "cancelled"
          ? "action approval was cancelled"
          : state === "expired"
            ? "action approval has expired"
            : "action approval is no longer valid",
        409,
        details,
      );
    }
    const approvalValue = database
      .query("SELECT * FROM action_approvals WHERE approval_id = ?;")
      .get(request.approvalId);
    if (typeof approvalValue !== "object" || approvalValue === null)
      throw new ApprovalAuthorityError(
        "action.approval_not_found",
        "action approval was not found",
        404,
        { planId: request.planId, approvalId: request.approvalId },
      );
    const approval = recordValue(approvalValue);
    if (
      readString(approval, "plan_id") !== request.planId ||
      readInteger(approval, "plan_version") !== request.planVersion ||
      readString(approval, "preview_digest") !== request.previewDigest
    )
      throw new ApprovalAuthorityError(
        "action.approval_mismatch",
        "action approval does not match the frozen plan",
        409,
        { planId: request.planId, approvalId: request.approvalId },
      );
    const plan = planRow(database, request.planId);
    if (readString(plan, "state") !== "pending")
      throw new ApprovalAuthorityError(
        "action.plan_not_pending",
        "action plan is not pending",
        409,
        { planId: request.planId, state: readString(plan, "state") },
      );
    if (readInteger(plan, "version") !== request.planVersion)
      throw new ApprovalAuthorityError(
        "action.plan_version_stale",
        "action plan version is stale",
        409,
        { planId: request.planId, currentVersion: readInteger(plan, "version") },
      );
    if (Date.parse(now) >= Date.parse(readString(approval, "expires_at")))
      throw new ApprovalAuthorityError(
        "action.approval_expired",
        "action approval has expired",
        409,
        {
          planId: request.planId,
          approvalId: request.approvalId,
          expiredAt: readString(approval, "expires_at"),
        },
      );
    const key = input.keyring.keys.get(readString(approval, "seal_key_id"));
    if (key === undefined)
      throw new ApprovalAuthorityError(
        "action.approval_invalidated",
        "action approval is no longer valid",
        409,
        { planId: request.planId, approvalId: request.approvalId, invalidatedAt: now },
      );
    const canonicalTargets = canonicalTargetSet(database, request.planId);
    const targetDigestValue = targetDigest(canonicalTargets);
    if (
      targetDigestValue !== readString(approval, "target_digest") ||
      normalizedIntent(readString(plan, "action_kind"), targetDigestValue) !==
        readString(approval, "normalized_intent")
    )
      throw new ApprovalAuthorityError(
        "action.approval_mismatch",
        "action approval does not match the frozen plan",
        409,
        { planId: request.planId, approvalId: request.approvalId },
      );
    const sealFields = [
      readString(approval, "approval_id"),
      readString(approval, "approver_principal_id"),
      readString(approval, "approver_credential_id"),
      readString(approval, "approver_profile"),
      readString(approval, "approver_auth_event_id"),
      readString(approval, "ceremony_id"),
      readString(approval, "user_presence_verified_at"),
      readString(approval, "presence_request_method"),
      readString(approval, "presence_request_path"),
      readString(approval, "presence_request_body_sha256"),
      readString(approval, "authority_instance_id"),
      readInteger(approval, "operator_configuration_revision"),
      readString(approval, "challenge_commitment_sha256"),
      readString(approval, "assertion_signature_sha256"),
      readString(approval, "operator_display_code"),
      readString(approval, "plan_id"),
      readInteger(approval, "plan_version"),
      readString(approval, "preview_digest"),
      readString(approval, "target_digest"),
      readString(approval, "canonical_target_set"),
      readString(approval, "normalized_intent"),
      readString(approval, "issued_at"),
      readString(approval, "expires_at"),
      readString(approval, "nonce"),
      readString(approval, "authorization_scope"),
      readString(approval, "seal_key_id"),
      readInteger(approval, "seal_keyring_revision"),
      readString(approval, "seal_algorithm"),
    ];
    const approvalCommitmentValue = approvalCommitment(sealFields);
    if (seal(key.keyHex, approvalCommitmentValue) !== readString(approval, "seal"))
      throw new ApprovalAuthorityError(
        "action.approval_invalidated",
        "action approval is no longer valid",
        409,
        { planId: request.planId, approvalId: request.approvalId, invalidatedAt: now },
      );
    if (
      context.principalId === readString(approval, "approver_principal_id") ||
      context.credentialId === readString(approval, "approver_credential_id")
    )
      throw new ApprovalAuthorityError(
        "action.approval_forbidden",
        "request credentials cannot perform this approval operation",
        403,
      );
    const claimId = `claim:${randomUUID()}`;
    const receiptId = `approval-receipt:${randomUUID()}`;
    const consumedAt = now;
    const approvalCommitmentSha256 = createHash("sha256")
      .update(approvalCommitmentValue)
      .digest("hex");
    const receiptCommitmentSha256 = createHash("sha256")
      .update(
        JSON.stringify([
          "action-approval-consumption-v1",
          receiptId,
          request.approvalId,
          request.planId,
          request.planVersion,
          request.planVersion + 1,
          claimId,
          context.principalId,
          context.credentialId,
          "agent-unattended",
          context.authEventId,
          consumedAt,
          approvalCommitmentSha256,
          "internal-action-executor",
        ]),
      )
      .digest("hex");
    database
      .query("INSERT INTO action_plan_claims (plan_id, claim_id, claimed_at) VALUES (?, ?, ?);")
      .run(request.planId, claimId, consumedAt);
    database
      .query(
        "INSERT INTO action_approval_consumptions (receipt_id, approval_id, plan_id, plan_version_before, plan_version_after, claim_id, committer_principal_id, committer_credential_id, committer_profile, committer_auth_event_id, consumed_at, approval_commitment_sha256, executor_profile, receipt_commitment_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent-unattended', ?, ?, ?, 'internal-action-executor', ?);",
      )
      .run(
        receiptId,
        request.approvalId,
        request.planId,
        request.planVersion,
        request.planVersion + 1,
        claimId,
        context.principalId,
        context.credentialId,
        context.authEventId,
        consumedAt,
        approvalCommitmentSha256,
        receiptCommitmentSha256,
      );
    const updated = database
      .query(
        "UPDATE action_plans SET state = 'executing', claim_id = ?, started_at = ?, version = version + 1 WHERE plan_id = ? AND state = 'pending' AND version = ?;",
      )
      .run(claimId, consumedAt, request.planId, request.planVersion);
    if (updated.changes !== 1) throw new Error("action plan consume version race");
    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      receiptId,
      approvalId: request.approvalId,
      planId: request.planId,
      claimId,
      consumedAt,
      committer: { principalId: context.principalId, profile: "agent-unattended" },
      executorProfile: "internal-action-executor",
    };
  } catch (error: unknown) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  }
}

export function cancelActionApproval(
  database: Database,
  input: ApprovalAuthorityCancelInput,
): Readonly<{
  readonly approvalId: string;
  readonly planId: string;
  readonly cancelledAt: string;
  readonly planVersion: number;
}> {
  const request = cancelRequest(input.request);
  const now = nowString(input.now);
  const context = operatorContext(input.context, now, "DELETE");
  const binding = requestBinding(bindingFromOperatorContext(context), "DELETE");
  if (
    binding.path !==
    `/v1/action-plans/${encodeURIComponent(request.planId)}/approvals/${encodeURIComponent(request.approvalId)}`
  )
    throw new ApprovalAuthorityError(
      "action.operator_assertion_invalid",
      "operator presence assertion is invalid",
      403,
    );
  database.exec("BEGIN IMMEDIATE;");
  try {
    const approval = database
      .query(
        "SELECT approver_principal_id, preview_digest, expires_at FROM action_approvals WHERE approval_id = ? AND plan_id = ?;",
      )
      .get(request.approvalId, request.planId);
    if (typeof approval !== "object" || approval === null)
      throw new ApprovalAuthorityError(
        "action.approval_not_found",
        "action approval was not found",
        404,
        { planId: request.planId, approvalId: request.approvalId },
      );
    const approvalRow = recordValue(approval);
    if (approvalRow.approver_principal_id !== context.principalId)
      throw new ApprovalAuthorityError(
        "action.approval_forbidden",
        "request credentials cannot perform this approval operation",
        403,
      );
    if (approvalRow.preview_digest !== request.previewDigest)
      throw new ApprovalAuthorityError(
        "action.approval_mismatch",
        "action approval does not match the frozen plan",
        409,
        { planId: request.planId, approvalId: request.approvalId },
      );
    if (
      typeof approvalRow.expires_at !== "string" ||
      Date.parse(now) >= Date.parse(approvalRow.expires_at)
    )
      throw new ApprovalAuthorityError(
        "action.approval_expired",
        "action approval has expired",
        409,
        {
          planId: request.planId,
          approvalId: request.approvalId,
          expiredAt: approvalRow.expires_at,
        },
      );
    const plan = planRow(database, request.planId);
    const version = readInteger(plan, "version");
    if (readString(plan, "state") !== "pending")
      throw new ApprovalAuthorityError(
        "action.plan_not_pending",
        "action plan is not pending",
        409,
        { planId: request.planId, state: readString(plan, "state") },
      );
    if (version !== request.planVersion)
      throw new ApprovalAuthorityError(
        "action.plan_version_stale",
        "action plan version is stale",
        409,
        { planId: request.planId, currentVersion: version },
      );
    const challenge = database
      .query(
        "SELECT authority_instance_id, operator_configuration_revision, credential_id, principal_id, profile, operation, request_method, request_path, request_body_sha256, operator_display_code, challenge_commitment, expires_at FROM operator_presence_challenges WHERE challenge_id = ?;",
      )
      .get(context.presence.ceremonyId);
    if (
      typeof challenge !== "object" ||
      challenge === null ||
      Object.entries({
        authority_instance_id: binding.authorityInstanceId,
        operator_configuration_revision: binding.operatorConfigurationRevision,
        credential_id: context.credentialId,
        principal_id: context.principalId,
        profile: context.profile,
        operation: "cancel-approval",
        request_method: binding.method,
        request_path: binding.path,
        request_body_sha256: binding.bodySha256,
        operator_display_code: binding.displayCode,
        challenge_commitment: binding.challengeCommitmentSha256,
      }).some(
        ([key, expected]) =>
          !isRecord(challenge) ||
          (key === "challenge_commitment"
            ? createHash("sha256")
                .update(readString(recordValue(challenge), key))
                .digest("hex") !== expected
            : challenge[key] !== expected),
      ) ||
      Date.parse(readString(recordValue(challenge), "expires_at")) <= Date.parse(now)
    )
      throw new ApprovalAuthorityError(
        "action.operator_assertion_invalid",
        "operator presence assertion is invalid",
        403,
      );
    database
      .query(
        "INSERT INTO action_approval_cancellations (approval_id, cancelled_at, canceller_principal_id, canceller_credential_id, canceller_profile, canceller_auth_event_id, ceremony_id, user_presence_verified_at, presence_request_method, presence_request_path, presence_request_body_sha256, authority_instance_id, operator_configuration_revision, challenge_commitment_sha256, assertion_signature_sha256, operator_display_code, reason_code, plan_version_before, plan_version_after) VALUES (?, ?, ?, ?, 'operator-interactive', ?, ?, ?, 'DELETE', ?, ?, ?, ?, ?, ?, ?, 'operator-cancelled', ?, ?);",
      )
      .run(
        request.approvalId,
        now,
        context.principalId,
        context.credentialId,
        context.authEventId,
        context.presence.ceremonyId,
        context.presence.verifiedAt,
        binding.path,
        binding.bodySha256,
        binding.authorityInstanceId,
        binding.operatorConfigurationRevision,
        binding.challengeCommitmentSha256,
        binding.assertionSignatureSha256,
        binding.displayCode,
        version,
        version + 1,
      );
    database
      .query(
        "INSERT INTO operator_presence_challenge_consumptions (challenge_id, consumed_at, operation, authority_output_kind, authority_output_id, signature_p1363_base64url, signature_sha256) VALUES (?, ?, 'cancel-approval', 'cancellation', ?, ?, ?);",
      )
      .run(
        context.presence.ceremonyId,
        now,
        request.approvalId,
        binding.assertionSignatureP1363Base64url,
        binding.assertionSignatureSha256,
      );
    const updated = database
      .query(
        "UPDATE action_plans SET version = version + 1 WHERE plan_id = ? AND state = 'pending' AND version = ?;",
      )
      .run(request.planId, version);
    if (updated.changes !== 1) throw new Error("action plan cancellation version race");
    database.exec("COMMIT;");
    return {
      approvalId: request.approvalId,
      planId: request.planId,
      cancelledAt: now,
      planVersion: version + 1,
    };
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** Close an available approval once its own 600-second or credential-bound lifetime ends. */
export function expireActionApproval(
  database: Database,
  approvalId: string,
  expiredAt: string,
): Readonly<{
  readonly approvalId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly disposition: "pending-advanced" | "plan-expired";
}> {
  const id = requestText(approvalId, "approval ID");
  const at = nowString(expiredAt);
  database.exec("BEGIN IMMEDIATE;");
  try {
    const row = database
      .query(
        "SELECT a.approval_id, a.plan_id, a.expires_at, p.version, p.state, p.expires_at AS plan_expires_at FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id WHERE a.approval_id = ?;",
      )
      .get(id);
    if (typeof row !== "object" || row === null || Array.isArray(row))
      throw new ApprovalAuthorityError(
        "action.approval_not_found",
        "action approval was not found",
        404,
        { planId: "plan:unknown", approvalId: id },
      );
    const value = recordValue(row);
    const planId = readString(value, "plan_id");
    const version = readInteger(value, "version");
    if (readString(value, "state") !== "pending")
      throw new ApprovalAuthorityError(
        "action.plan_not_pending",
        "action plan is not pending",
        409,
        { planId, state: readString(value, "state") },
      );
    if (Date.parse(at) < Date.parse(readString(value, "expires_at")))
      throw new ApprovalAuthorityError(
        "action.approval_expired",
        "action approval has not expired",
        409,
        { planId, approvalId: id, expiredAt: readString(value, "expires_at") },
      );
    const disposition =
      Date.parse(at) >= Date.parse(readString(value, "plan_expires_at"))
        ? ("plan-expired" as const)
        : ("pending-advanced" as const);
    database
      .query(
        "INSERT INTO action_approval_expirations (approval_id, expired_at, plan_version_before, plan_version_after, plan_disposition) VALUES (?, ?, ?, ?, ?);",
      )
      .run(id, at, version, version + 1, disposition);
    const updated =
      disposition === "plan-expired"
        ? database
            .query(
              "UPDATE action_plans SET state = 'expired', expired_at = ?, version = version + 1 WHERE plan_id = ? AND state = 'pending' AND version = ?;",
            )
            .run(at, planId, version)
        : database
            .query(
              "UPDATE action_plans SET version = version + 1 WHERE plan_id = ? AND state = 'pending' AND version = ?;",
            )
            .run(planId, version);
    if (updated.changes !== 1) throw new Error("action approval expiration version race");
    database.exec("COMMIT;");
    return { approvalId: id, planId, planVersion: version + 1, disposition };
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** Startup reconciliation: a missing referenced seal key invalidates, never rebinds. */
export function invalidateApprovalsForMissingKeys(
  database: Database,
  keyring: ApprovalSealKeyring,
  invalidatedAt: string,
): number {
  const at = nowString(invalidatedAt);
  const available = database
    .query(
      "SELECT a.approval_id, a.plan_id, a.seal_key_id, p.version FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id LEFT JOIN action_approval_consumptions c ON c.approval_id = a.approval_id LEFT JOIN action_approval_expirations e ON e.approval_id = a.approval_id LEFT JOIN action_approval_cancellations x ON x.approval_id = a.approval_id LEFT JOIN action_approval_invalidations i ON i.approval_id = a.approval_id WHERE c.approval_id IS NULL AND e.approval_id IS NULL AND x.approval_id IS NULL AND i.approval_id IS NULL AND p.state = 'pending';",
    )
    .all()
    .map((value) => recordValue(value));
  const missing = available.filter((row) => !keyring.keys.has(readString(row, "seal_key_id")));
  if (missing.length === 0) return 0;
  database.exec("BEGIN IMMEDIATE;");
  try {
    const affectedPlans = new Map<string, number>();
    for (const row of missing) {
      const approvalId = readString(row, "approval_id");
      const planId = readString(row, "plan_id");
      const version = readInteger(row, "version");
      const priorVersion = affectedPlans.get(planId);
      if (priorVersion !== undefined && priorVersion !== version)
        throw new Error("missing-key invalidation plan version mismatch");
      affectedPlans.set(planId, version);
      database
        .query(
          "INSERT INTO action_approval_invalidations (approval_id, invalidated_at, reason_code, plan_version_before, plan_version_after) VALUES (?, ?, 'key-unavailable', ?, ?);",
        )
        .run(approvalId, at, version, version + 1);
    }
    for (const [planId, version] of affectedPlans) {
      const updated = database
        .query(
          "UPDATE action_plans SET version = version + 1 WHERE plan_id = ? AND state = 'pending' AND version = ?;",
        )
        .run(planId, version);
      if (updated.changes !== 1) throw new Error("missing-key invalidation version race");
    }
    database.exec("COMMIT;");
    return missing.length;
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/**
 * Seal-key administration challenges are intentionally one-startup scoped.
 * Their raw administration body is not retained in the authority tables, so a
 * restart cannot prove that an available challenge still names the current
 * keyring revision. Close every pending seal ceremony before any listener or
 * signer is admitted; public HTTP challenges remain durable and are handled by
 * their normal expiry/configuration rules.
 */
export function invalidatePendingSealKeyAdministrationChallenges(
  database: Database,
  invalidatedAt: string,
): number {
  const at = nowString(invalidatedAt);
  database.exec("BEGIN IMMEDIATE;");
  try {
    const rows = database
      .query(
        "SELECT c.challenge_id FROM operator_presence_challenges c LEFT JOIN operator_presence_challenge_consumptions x ON x.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_expirations e ON e.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_invalidations i ON i.challenge_id = c.challenge_id WHERE c.operation IN ('seal-key-rotate', 'seal-key-remove') AND x.challenge_id IS NULL AND e.challenge_id IS NULL AND i.challenge_id IS NULL;",
      )
      .all();
    for (const value of rows) {
      const row = recordValue(value);
      database
        .query(
          "INSERT INTO operator_presence_challenge_invalidations (challenge_id, invalidated_at, reason_code) VALUES (?, ?, 'configuration-change');",
        )
        .run(readString(row, "challenge_id"), at);
    }
    database.exec("COMMIT;");
    return rows.length;
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export type AuthorityConfigurationInvalidationInput = Readonly<{
  readonly authorityInstanceId: string;
  readonly configurationRevision: number;
  readonly activeCredentialIds: readonly string[];
  readonly invalidatedAt: string;
}>;

/**
 * Close authority issued under an older instance/revision or revoked
 * credential before ordinary restart admission. Each still-pending plan is
 * advanced once, even when more than one stale approval is present.
 */
export function invalidateAuthorityForConfigurationChange(
  database: Database,
  input: AuthorityConfigurationInvalidationInput,
): Readonly<{ readonly invalidatedChallenges: number; readonly invalidatedApprovals: number }> {
  const authorityInstanceId = requestText(input.authorityInstanceId, "authority instance ID");
  if (!Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 1)
    throw new TypeError("authority configuration revision is invalid");
  const activeCredentialIds = [...new Set(input.activeCredentialIds)].map((value) =>
    requestText(value, "active credential ID"),
  );
  if (activeCredentialIds.length > 2) throw new TypeError("active credential set is too large");
  const at = nowString(input.invalidatedAt);
  const activePredicate =
    activeCredentialIds.length === 0
      ? "1 = 1"
      : `c.credential_id NOT IN (${activeCredentialIds.map(() => "?").join(",")})`;
  const approvalActivePredicate =
    activeCredentialIds.length === 0
      ? "1 = 1"
      : `a.approver_credential_id NOT IN (${activeCredentialIds.map(() => "?").join(",")})`;
  database.exec("BEGIN IMMEDIATE;");
  try {
    const challengeRows = database
      .query(
        `SELECT c.challenge_id, c.authority_instance_id, c.credential_id
         FROM operator_presence_challenges c
         LEFT JOIN operator_presence_challenge_consumptions x ON x.challenge_id = c.challenge_id
         LEFT JOIN operator_presence_challenge_expirations e ON e.challenge_id = c.challenge_id
         LEFT JOIN operator_presence_challenge_invalidations i ON i.challenge_id = c.challenge_id
         WHERE x.challenge_id IS NULL AND e.challenge_id IS NULL AND i.challenge_id IS NULL
           AND (c.authority_instance_id <> ? OR c.operator_configuration_revision <> ? OR ${activePredicate});`,
      )
      .all(authorityInstanceId, input.configurationRevision, ...activeCredentialIds);
    for (const value of challengeRows) {
      const row = recordValue(value);
      const challengeInstance = readString(row, "authority_instance_id");
      const credentialId = readString(row, "credential_id");
      const reason =
        challengeInstance !== authorityInstanceId
          ? "instance-mismatch"
          : activeCredentialIds.includes(credentialId)
            ? "configuration-change"
            : "credential-revoked";
      database
        .query(
          "INSERT INTO operator_presence_challenge_invalidations (challenge_id, invalidated_at, reason_code) VALUES (?, ?, ?);",
        )
        .run(readString(row, "challenge_id"), at, reason);
    }

    const approvalRows = database
      .query(
        `SELECT a.approval_id, a.plan_id, a.authority_instance_id, a.approver_credential_id, p.version
         FROM action_approvals a
         JOIN action_plans p ON p.plan_id = a.plan_id
         LEFT JOIN action_approval_consumptions c ON c.approval_id = a.approval_id
         LEFT JOIN action_approval_expirations e ON e.approval_id = a.approval_id
         LEFT JOIN action_approval_cancellations x ON x.approval_id = a.approval_id
         LEFT JOIN action_approval_invalidations i ON i.approval_id = a.approval_id
         WHERE c.approval_id IS NULL AND e.approval_id IS NULL AND x.approval_id IS NULL AND i.approval_id IS NULL
           AND p.state = 'pending'
           AND (a.authority_instance_id <> ? OR a.operator_configuration_revision <> ? OR ${approvalActivePredicate});`,
      )
      .all(authorityInstanceId, input.configurationRevision, ...activeCredentialIds);
    const affectedPlans = new Set<string>();
    for (const value of approvalRows) {
      const row = recordValue(value);
      const approvalId = readString(row, "approval_id");
      const planId = readString(row, "plan_id");
      const version = readInteger(row, "version");
      const reason =
        readString(row, "authority_instance_id") !== authorityInstanceId
          ? "configuration-change"
          : activeCredentialIds.includes(readString(row, "approver_credential_id"))
            ? "configuration-change"
            : "credential-revoked";
      database
        .query(
          "INSERT INTO action_approval_invalidations (approval_id, invalidated_at, reason_code, plan_version_before, plan_version_after) VALUES (?, ?, ?, ?, ?);",
        )
        .run(approvalId, at, reason, version, version + 1);
      affectedPlans.add(planId);
    }
    for (const planId of affectedPlans) {
      const row = database
        .query("SELECT version FROM action_plans WHERE plan_id = ? AND state = 'pending';")
        .get(planId);
      if (!isRecord(row)) throw new Error("configuration invalidation plan disappeared");
      const version = readInteger(row, "version");
      const updated = database
        .query(
          "UPDATE action_plans SET version = version + 1 WHERE plan_id = ? AND state = 'pending' AND version = ?;",
        )
        .run(planId, version);
      if (updated.changes !== 1) throw new Error("configuration invalidation version race");
    }
    database.exec("COMMIT;");
    return {
      invalidatedChallenges: challengeRows.length,
      invalidatedApprovals: approvalRows.length,
    };
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export type ActionAttemptAuthorityInput = Readonly<{
  readonly planId: string;
  readonly attemptId: string;
  readonly receiptId: string;
  readonly claimId: string;
  readonly executorInstanceId: string;
  readonly attributedAt: string;
}>;

export type EffectAuthorityProjection = Readonly<{
  readonly rows: readonly EffectAuthorityRow[];
  readonly count: number;
  readonly digest: string;
  readonly executorInstanceId: string;
}>;

type EffectAuthorityRow = readonly [string, "internal-action-executor", string, string];

/** Derive terminal effect attribution only from the complete immutable set. */
export function readEffectAuthorityProjection(
  database: Database,
  input: Readonly<{
    readonly planId: string;
    readonly receiptId: string;
    readonly claimId: string;
  }>,
): EffectAuthorityProjection {
  const planId = requestText(input.planId, "plan ID");
  const receiptId = requestText(input.receiptId, "receipt ID");
  const claimId = requestText(input.claimId, "claim ID");
  const values: readonly unknown[] = database
    .query(
      "SELECT attempt_id, executor_profile, executor_instance_id, attributed_at " +
        "FROM action_attempt_authorities WHERE plan_id = ? AND receipt_id = ? AND claim_id = ?;",
    )
    .all(planId, receiptId, claimId);
  const rows: EffectAuthorityRow[] = values.map((value): EffectAuthorityRow => {
    const row = recordValue(value);
    const attemptId = readString(row, "attempt_id");
    const executorProfile = readString(row, "executor_profile");
    const executorInstanceId = authorityIdentity(
      readString(row, "executor_instance_id"),
      "effect executor identity",
      "executor:",
    );
    const attributedAt = nowString(row.attributed_at);
    if (!attemptId.startsWith("attempt:")) throw new Error("effect attempt identity is invalid");
    if (executorProfile !== "internal-action-executor")
      throw new Error("effect executor profile is invalid");
    if (!executorInstanceId.startsWith("executor:"))
      throw new Error("effect executor identity is invalid");
    return [attemptId, "internal-action-executor", executorInstanceId, attributedAt];
  });
  rows.sort((left, right) =>
    Buffer.compare(Buffer.from(left[0], "utf8"), Buffer.from(right[0], "utf8")),
  );
  const canonicalRows: readonly EffectAuthorityRow[] = rows;
  const serialized = JSON.stringify([
    "action-terminal-effect-authority-set-v1",
    planId,
    receiptId,
    claimId,
    canonicalRows,
  ]);
  const executorIds = new Set(canonicalRows.map((row) => row[2]));
  let terminalExecutor = "executor:not-started";
  if (canonicalRows.length > 0) {
    if (executorIds.size === 1) {
      const firstExecutor = [...executorIds][0];
      if (firstExecutor === undefined) throw new Error("effect executor identity is missing");
      terminalExecutor = firstExecutor;
    } else {
      terminalExecutor = "executor:multiple";
    }
  }
  return {
    rows: canonicalRows,
    count: canonicalRows.length,
    digest: createHash("sha256").update(serialized).digest("hex"),
    executorInstanceId: terminalExecutor,
  };
}

/** Attribute a concrete attempt to the one consumed receipt before remote dispatch. */
export function recordActionAttemptAuthority(
  database: Database,
  input: ActionAttemptAuthorityInput,
): void {
  const planId = requestText(input.planId, "plan ID");
  const attemptId = requestText(input.attemptId, "attempt ID");
  const receiptId = requestText(input.receiptId, "receipt ID");
  const claimId = requestText(input.claimId, "claim ID");
  const executorInstanceId = authorityIdentity(
    input.executorInstanceId,
    "executor instance ID",
    "executor:",
  );
  const at = nowString(input.attributedAt);
  const receipt = database
    .query(
      "SELECT plan_id, claim_id, executor_profile FROM action_approval_consumptions WHERE receipt_id = ?;",
    )
    .get(receiptId);
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt))
    throw new ApprovalAuthorityError(
      "action.approval_not_found",
      "action approval was not found",
      404,
      { planId, approvalId: "approval:unknown" },
    );
  const receiptRow = recordValue(receipt);
  if (
    readString(receiptRow, "plan_id") !== planId ||
    readString(receiptRow, "claim_id") !== claimId ||
    readString(receiptRow, "executor_profile") !== "internal-action-executor"
  )
    throw new ApprovalAuthorityError(
      "action.approval_forbidden",
      "request credentials cannot perform this approval operation",
      403,
    );
  const attempt = database
    .query("SELECT attempt_id FROM action_attempts WHERE attempt_id = ? AND plan_id = ?;")
    .get(attemptId, planId);
  if (typeof attempt !== "object" || attempt === null)
    throw new ApprovalAuthorityError(
      "action.legacy_authority",
      "action plan lacks trusted approval authority",
      409,
      { planId },
    );
  database
    .query(
      "INSERT INTO action_attempt_authorities (plan_id, attempt_id, receipt_id, claim_id, executor_profile, executor_instance_id, attributed_at) VALUES (?, ?, ?, ?, 'internal-action-executor', ?, ?);",
    )
    .run(planId, attemptId, receiptId, claimId, executorInstanceId, at);
}

export type ActionPlanTerminalAuditInput = Readonly<{
  readonly planId: string;
  readonly receiptId: string;
  readonly claimId: string;
  readonly terminalState:
    | "completed"
    | "partial"
    | "failed"
    | "rejected"
    | "expired"
    | "uncertain"
    | "restore-quarantined";
  readonly terminalAt: string;
  readonly executorDisposition: "started" | "never-started-after-restore" | "unknown-after-restore";
  readonly effectAttemptCount: number;
  readonly effectAuthoritySetDigest: string;
  readonly executorInstanceId: string;
  readonly finalizerKind: "effect-executor" | "ordinary-recovery" | "restore-admission";
  readonly finalizerInstanceId: string;
  readonly reasonCode: "normal-finalization" | "explicit-database-restore";
  readonly restoreEventId: string;
  readonly resultDigest: string;
}>;

/** Persist immutable terminal attribution against the exact receipt/claim tuple. */
export function recordActionPlanTerminalAudit(
  database: Database,
  input: ActionPlanTerminalAuditInput,
): void {
  const planId = requestText(input.planId, "plan ID");
  const receiptId = requestText(input.receiptId, "receipt ID");
  const claimId = requestText(input.claimId, "claim ID");
  const at = nowString(input.terminalAt);
  if (!SHA256.test(input.resultDigest)) throw new TypeError("result digest is invalid");
  if (!Number.isSafeInteger(input.effectAttemptCount) || input.effectAttemptCount < 0)
    throw new TypeError("effect attempt count is invalid");
  if (!SHA256.test(input.effectAuthoritySetDigest))
    throw new TypeError("effect authority set digest is invalid");
  const finalizerInstanceId =
    input.finalizerKind === "effect-executor"
      ? authorityIdentity(input.finalizerInstanceId, "finalizer instance ID", "executor:")
      : input.finalizerKind === "ordinary-recovery"
        ? authorityIdentity(
            input.finalizerInstanceId,
            "finalizer instance ID",
            "recovery-finalizer:",
          )
        : input.finalizerInstanceId === "finalizer:restore-admission"
          ? input.finalizerInstanceId
          : (() => {
              throw new TypeError("finalizer identity is invalid");
            })();
  const executorInstanceId =
    input.executorDisposition === "started"
      ? authorityIdentity(input.executorInstanceId, "executor instance ID", "executor:")
      : input.executorDisposition === "never-started-after-restore"
        ? input.executorInstanceId === "executor:not-started"
          ? input.executorInstanceId
          : (() => {
              throw new TypeError("executor disposition is invalid");
            })()
        : input.executorInstanceId === "executor:unknown-after-restore"
          ? input.executorInstanceId
          : (() => {
              throw new TypeError("executor disposition is invalid");
            })();
  const effect = readEffectAuthorityProjection(database, { planId, receiptId, claimId });
  if (
    input.effectAttemptCount !== effect.count ||
    input.effectAuthoritySetDigest !== effect.digest ||
    (effect.count > 0 && executorInstanceId !== effect.executorInstanceId) ||
    (input.executorDisposition === "started" && effect.count === 0) ||
    (input.executorDisposition === "never-started-after-restore" && effect.count !== 0)
  )
    throw new TypeError("terminal effect authority projection is invalid");
  database
    .query(
      "INSERT INTO action_plan_terminal_audit (plan_id, receipt_id, claim_id, terminal_state, terminal_at, executor_disposition, effect_attempt_count, effect_authority_set_digest, executor_instance_id, finalizer_kind, finalizer_instance_id, reason_code, restore_event_id, result_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      planId,
      receiptId,
      claimId,
      input.terminalState,
      at,
      input.executorDisposition,
      input.effectAttemptCount,
      input.effectAuthoritySetDigest,
      executorInstanceId,
      input.finalizerKind,
      finalizerInstanceId,
      input.reasonCode,
      requestText(input.restoreEventId, "restore event ID"),
      input.resultDigest,
    );
}

/**
 * Admission transaction for an explicit database restore. It runs before
 * recovery selection: available authority is closed and consumed executing
 * work is retained as terminal audit, so no restored row can mint an effect.
 */
export function quarantineRestoredAuthority(
  database: Database,
  restoreEventId: string,
  restoredAt: string,
): Readonly<{ readonly invalidatedApprovals: number; readonly quarantinedPlans: number }> {
  const event = requestText(restoreEventId, "restore event ID");
  const at = nowString(restoredAt);
  database.exec("BEGIN IMMEDIATE;");
  try {
    const challenges = database
      .query(
        "SELECT c.challenge_id FROM operator_presence_challenges c LEFT JOIN operator_presence_challenge_consumptions x ON x.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_expirations e ON e.challenge_id = c.challenge_id LEFT JOIN operator_presence_challenge_invalidations i ON i.challenge_id = c.challenge_id WHERE x.challenge_id IS NULL AND e.challenge_id IS NULL AND i.challenge_id IS NULL;",
      )
      .all();
    for (const value of challenges) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("restore challenge row is invalid");
      const row = recordValue(value);
      database
        .query(
          "INSERT INTO operator_presence_challenge_invalidations (challenge_id, invalidated_at, reason_code) VALUES (?, ?, 'database-restore');",
        )
        .run(readString(row, "challenge_id"), at);
    }
    const available = database
      .query(
        "SELECT a.approval_id, a.plan_id, p.version FROM action_approvals a JOIN action_plans p ON p.plan_id = a.plan_id LEFT JOIN action_approval_consumptions c ON c.approval_id = a.approval_id LEFT JOIN action_approval_expirations e ON e.approval_id = a.approval_id LEFT JOIN action_approval_cancellations x ON x.approval_id = a.approval_id LEFT JOIN action_approval_invalidations i ON i.approval_id = a.approval_id WHERE c.approval_id IS NULL AND e.approval_id IS NULL AND x.approval_id IS NULL AND i.approval_id IS NULL;",
      )
      .all();
    for (const value of available) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("restore approval row is invalid");
      const row = recordValue(value);
      const approvalId = readString(row, "approval_id");
      const planId = readString(row, "plan_id");
      const version = readInteger(row, "version");
      database
        .query(
          "INSERT INTO action_approval_invalidations (approval_id, invalidated_at, reason_code, plan_version_before, plan_version_after) VALUES (?, ?, 'database-restore', ?, ?);",
        )
        .run(approvalId, at, version, version + 1);
      database
        .query(
          "UPDATE action_plans SET version = version + 1 WHERE plan_id = ? AND state = 'pending' AND version = ?;",
        )
        .run(planId, version);
    }
    const executing = database
      .query(
        "SELECT p.plan_id, c.receipt_id, c.claim_id FROM action_plans p JOIN action_approval_consumptions c ON c.plan_id = p.plan_id AND c.claim_id = p.claim_id LEFT JOIN action_plan_terminal_audit t ON t.plan_id = p.plan_id WHERE p.state = 'executing' AND t.plan_id IS NULL;",
      )
      .all();
    for (const value of executing) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("restore executing row is invalid");
      const row = recordValue(value);
      const planId = readString(row, "plan_id");
      const receiptId = readString(row, "receipt_id");
      const claimId = readString(row, "claim_id");
      const effect = readEffectAuthorityProjection(database, {
        planId,
        receiptId,
        claimId,
      });
      const dispatched =
        database
          .query(
            "SELECT 1 AS present FROM action_attempt_dispatches d JOIN action_attempts a ON a.attempt_id = d.attempt_id AND a.plan_id = d.plan_id WHERE a.plan_id = ?;",
          )
          .get(planId) !== null;
      const executorDisposition =
        effect.count > 0
          ? "started"
          : dispatched
            ? "unknown-after-restore"
            : "never-started-after-restore";
      const restoredExecutor =
        executorDisposition === "started"
          ? effect.executorInstanceId
          : executorDisposition === "unknown-after-restore"
            ? "executor:unknown-after-restore"
            : "executor:not-started";
      const digest = createHash("sha256")
        .update(
          JSON.stringify(["action-restore-quarantine-v1", event, planId, receiptId, claimId, at]),
        )
        .digest("hex");
      database
        .query(
          "INSERT INTO action_plan_terminal_audit (plan_id, receipt_id, claim_id, terminal_state, terminal_at, executor_disposition, effect_attempt_count, effect_authority_set_digest, executor_instance_id, finalizer_kind, finalizer_instance_id, reason_code, restore_event_id, result_digest) VALUES (?, ?, ?, 'restore-quarantined', ?, ?, ?, ?, ?, 'restore-admission', 'finalizer:restore-admission', 'explicit-database-restore', ?, ?);",
        )
        .run(
          planId,
          receiptId,
          claimId,
          at,
          executorDisposition,
          effect.count,
          effect.digest,
          restoredExecutor,
          event,
          digest,
        );
      const quarantined = database
        .query(
          "UPDATE action_plans SET state = 'restore-quarantined', claim_id = NULL, started_at = NULL, version = version + 1 WHERE plan_id = ? AND state = 'executing' AND claim_id = ?;",
        )
        .run(planId, claimId);
      if (quarantined.changes !== 1) throw new Error("restore quarantine plan transition failed");
    }
    database.exec("COMMIT;");
    return { invalidatedApprovals: available.length, quarantinedPlans: executing.length };
  } catch (error: unknown) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function createApprovalAuthorityRepository(database: Database): Readonly<{
  readonly approve: (input: ApprovalAuthorityIssueInput) => ApprovalAuthorityResult;
  readonly consume: (input: ApprovalAuthorityConsumeInput) => ConsumptionReceipt;
  readonly cancel: (input: ApprovalAuthorityCancelInput) => Readonly<{
    readonly approvalId: string;
    readonly planId: string;
    readonly cancelledAt: string;
    readonly planVersion: number;
  }>;
  readonly expire: (
    approvalId: string,
    expiredAt: string,
  ) => Readonly<{
    readonly approvalId: string;
    readonly planId: string;
    readonly planVersion: number;
    readonly disposition: "pending-advanced" | "plan-expired";
  }>;
}> {
  return Object.freeze({
    approve: (input) => issueActionApproval(database, input),
    consume: (input) => consumeActionApproval(database, input),
    cancel: (input) => cancelActionApproval(database, input),
    expire: (approvalId, expiredAt) => expireActionApproval(database, approvalId, expiredAt),
  });
}
