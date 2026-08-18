import { Hono } from "hono";
import type { Context } from "hono";
import { createHash } from "node:crypto";
import {
  actionPlanCreateOperation,
  actionPlanInspectOperation,
  actionAuthorityOperationDefinitions,
  correlationIdSchema,
  createOperationRegistry,
  httpErrorRegistry,
  assertPublicErrorStatusConsistency,
  parseErrorDefinition,
  publicErrorEnvelopeSchema,
  reportAdminOperationDefinitions,
  retrievalOperationDefinitions,
  routingOperationDefinitions,
  syncOperationDefinitions,
  type ErrorRegistry,
  type OperationDefinition,
  type OperationRegistry,
  type PublicErrorEnvelope,
  type PublicErrorStatus,
} from "@agent-mail/contracts";
import { DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES } from "./config";
import {
  OPERATOR_PRESENCE_PROTOCOL_VERSION,
  OperatorPresenceError,
  type OperatorPresenceAssertion,
  type OperatorPresenceRequest,
} from "./operator-presence";
import {
  createOperatorSessionHandler,
  OperatorPresenceAuthority,
  type OperatorSessionAuthority,
} from "./action-authority-auth";
import { isTrustedAuthContext } from "./trusted-auth-context";

export { DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES } from "./config";

/** Strict, bounded A1 assertion header; it is provisional until native verify. */
export function parseOperatorAssertionHeader(
  value: string | null,
): OperatorPresenceAssertion | undefined {
  if (
    value === null ||
    value.length === 0 ||
    value.length > 2_048 ||
    !value.startsWith("AgentMail-Operator ")
  )
    return undefined;
  const encoded = value.slice("AgentMail-Operator ".length);
  if (
    !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
    Buffer.from(encoded, "base64url").toString("base64url") !== encoded
  )
    return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url")),
    ) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) return undefined;
  const candidate = parsed;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 4 ||
    keys.some(
      (key, index) =>
        key !== ["version", "challengeId", "credentialId", "signatureBase64url"][index],
    )
  )
    return undefined;
  if (
    candidate.version !== OPERATOR_PRESENCE_PROTOCOL_VERSION ||
    typeof candidate.challengeId !== "string" ||
    typeof candidate.credentialId !== "string" ||
    typeof candidate.signatureBase64url !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/u.test(candidate.signatureBase64url) ||
    Buffer.from(candidate.signatureBase64url, "base64url").toString("base64url") !==
      candidate.signatureBase64url
  )
    return undefined;
  return Object.freeze({
    version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
    challengeId: candidate.challengeId,
    credentialId: candidate.credentialId,
    signatureP1363Base64url: candidate.signatureBase64url,
  });
}

export { httpErrorRegistry } from "@agent-mail/contracts";

/** The complete public operation set consumed by the daemon HTTP surface. */
export const publicOperationDefinitions = Object.freeze([
  ...retrievalOperationDefinitions,
  ...routingOperationDefinitions,
  actionPlanCreateOperation,
  actionPlanInspectOperation,
  ...actionAuthorityOperationDefinitions,
  ...reportAdminOperationDefinitions,
  ...syncOperationDefinitions,
] as const satisfies readonly OperationDefinition[]);

export const publicOperationRegistry = createOperationRegistry(publicOperationDefinitions);
assertPublicErrorStatusConsistency(httpErrorRegistry, publicOperationRegistry.operations);

export type OperationHandlerContext = Readonly<{
  readonly operation: OperationDefinition;
  /** Internal transport request; never exposed by the public contract. */
  readonly request?: Request;
  readonly correlationId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly principal: HttpPrincipal;
  readonly authContext?: AuthenticatedRequestContext;
  readonly requestBodySha256?: string;
  /** Internal request bytes for request-bound native operator ceremonies. */
  readonly requestBodyBytes?: Uint8Array;
  /** Parsed only for the loopback operator-session operation. */
  readonly operatorAssertion?: OperatorPresenceAssertion;
}>;

export type OperationHandler = (input: unknown, context: OperationHandlerContext) => unknown;

export type OperationHandlerMap = Readonly<Record<string, OperationHandler>>;

export type PrivateHttpLogEntry = Readonly<{
  readonly kind: "handler-error" | "invalid-handler-output";
  readonly operationKey: string;
  readonly correlationId: string;
}>;

export type PrivateHttpLogger = (entry: PrivateHttpLogEntry) => void;

/**
 * The only feature failure shape the transport will project from a handler.
 * Its fields remain untrusted until the operation response schema validates
 * them at this boundary; the request supplies the public correlation ID.
 */
export type RegisteredFeatureError = Readonly<{
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}>;

/** A typed alternative to returning a registered feature error directly. */
export type RegisteredFeatureOutcome = Readonly<{
  readonly kind: "feature-error";
  readonly error: RegisteredFeatureError;
}>;

/** Handlers may throw this when a feature outcome cannot be returned directly. */
export class RegisteredFeatureErrorException extends Error {
  readonly featureError: RegisteredFeatureError;

  constructor(featureError: RegisteredFeatureError) {
    super("registered feature operation error");
    this.name = "RegisteredFeatureErrorException";
    this.featureError = Object.freeze({
      code: featureError.code,
      message: featureError.message,
      details: Object.freeze({ ...featureError.details }),
    });
  }
}

/** The only identity and authority value a public HTTP handler can receive. */
export type HttpPrincipal = Readonly<{
  readonly subject: string;
  readonly scopes: readonly string[];
}>;

export type AuthenticatedRequestContext = Readonly<{
  readonly principalId: string;
  readonly credentialId: string;
  readonly profile: "operator-interactive" | "agent-unattended" | "internal-action-executor";
  readonly scopes: readonly string[];
  readonly authEventId: string;
  readonly authenticatedAt: string;
  readonly credentialExpiresAt: string;
  readonly presence:
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
        readonly operatorDisplayCode: string;
        readonly authorityInstanceId: string;
        readonly operatorConfigurationRevision: number;
      }>
    | Readonly<{ readonly kind: "unattended" }>
    | Readonly<{
        readonly kind: "a1-non-approval-session";
        readonly sessionId: string;
        readonly sessionAuthEventId: string;
        readonly issuedAt: string;
        readonly expiresAt: string;
        readonly configurationRevision: number;
        readonly credentialExpiresAt: string;
      }>;
}>;

export type HttpCredentialResolution =
  | Readonly<{
      readonly kind: "authenticated";
      readonly principal: HttpPrincipal;
      readonly context?: AuthenticatedRequestContext;
    }>
  | Readonly<{ readonly kind: "invalid" }>
  | Readonly<{ readonly kind: "expired" }>;

/** Resolve one already-parsed bearer value; raw credentials never enter a handler context. */
export type HttpCredentialAuthenticator = (credential: string) => unknown;

export type HttpAuthenticator = HttpCredentialAuthenticator;

const authenticatedPrincipal = Symbol("authenticatedPrincipal");
const authenticatedContext = Symbol("authenticatedContext");

export type TransportRequestContext = Readonly<{
  readonly request: Request;
  readonly correlationId: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly requestBodySha256?: string;
  readonly requestBodyBytes?: Uint8Array;
  readonly operatorAssertion?: OperatorPresenceAssertion;
  readonly [authenticatedPrincipal]?: HttpPrincipal;
  readonly [authenticatedContext]?: AuthenticatedRequestContext;
}>;

export type TransportResult = Readonly<{
  readonly status: 200 | 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503;
  readonly body: unknown;
}>;

export type RegistryTransportAdapter = Readonly<{
  readonly execute: (
    operationKey: string,
    input: unknown,
    context: TransportRequestContext,
  ) => Promise<TransportResult>;
}>;

export type RegistryTransportAdapterOptions = Readonly<{
  readonly registry: OperationRegistry;
  readonly handlers: OperationHandlerMap;
  readonly errorRegistry?: ErrorRegistry;
  readonly logger?: PrivateHttpLogger;
  readonly authenticate?: HttpCredentialAuthenticator;
  readonly operatorSessionAuthority?: OperatorSessionAuthority;
  readonly operatorPresenceAuthority?: OperatorPresenceAuthority;
}>;

export type HttpAppOptions = Readonly<{
  readonly registry?: OperationRegistry;
  readonly handlers?: OperationHandlerMap;
  readonly errorRegistry?: ErrorRegistry;
  readonly logger?: PrivateHttpLogger;
  readonly authenticate?: HttpCredentialAuthenticator;
  readonly maxRequestBodyBytes?: number;
  /** Supplies the native verifier-backed loopback session composition. */
  readonly operatorSessionAuthority?: OperatorSessionAuthority;
  readonly operatorPresenceAuthority?: OperatorPresenceAuthority;
  readonly operatorSessionCredentialId?: string;
  readonly operatorSessionAuthorityInstanceId?: string;
  readonly operatorSessionConfigurationRevision?: number;
}>;

export type HttpAdmissionOptions = Readonly<{
  readonly operation: OperationDefinition;
  readonly request: HttpAdmissionRequest;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly authenticate?: HttpCredentialAuthenticator;
  readonly errorRegistry?: ErrorRegistry;
  readonly maxRequestBodyBytes?: number;
  readonly correlationId?: string;
  readonly lifecycleProbe?: HttpAdmissionLifecycleProbe;
  readonly operatorSessionAdmission?: boolean;
  readonly operatorPresenceAdmission?: boolean;
}>;

/** The minimal request shape needed by the admission boundary. */
export type HttpAdmissionRequest = Pick<Request, "headers" | "body" | "method" | "signal"> &
  Partial<Pick<Request, "url">>;

/** Optional test/diagnostic hooks for proving stream ownership at this boundary. */
export type HttpAdmissionLifecycleProbe = Readonly<{
  readonly onReaderAcquired?: () => void;
  readonly onReaderReleased?: () => void;
  readonly onInputCancelled?: () => void;
  readonly onAbortListenerRemoved?: () => void;
}>;

export type HttpAdmissionResult =
  | Readonly<{
      readonly kind: "accepted";
      readonly input: unknown;
      readonly principal: HttpPrincipal;
      readonly authContext?: AuthenticatedRequestContext;
      readonly requestBodySha256: string;
      readonly requestBodyBytes: Uint8Array;
      readonly operatorAssertion?: OperatorPresenceAssertion;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly status: 400 | 401 | 403 | 413 | 415;
      readonly body: PublicErrorEnvelope;
    }>;

type JsonObject = Readonly<Record<string, unknown>>;

type HttpRequestErrorCode = "invalid_request" | "request_too_large";

class InvalidHttpRequestError extends Error {
  readonly status: 400 | 413 | 415;
  readonly code: HttpRequestErrorCode;

  constructor(
    message: string,
    status: 400 | 413 | 415,
    code: HttpRequestErrorCode = "invalid_request",
  ) {
    super(message);
    this.name = "InvalidHttpRequestError";
    this.status = status;
    this.code = code;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationRouteToHonoRoute(route: string): string {
  return route.replaceAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu, ":$1");
}

type PublicHttpErrorCode =
  | "invalid_request"
  | "invalid_query"
  | "invalid_cursor"
  | "missing_credentials"
  | "invalid_credentials"
  | "expired_credentials"
  | "insufficient_scope"
  | "request_too_large"
  | "not_found"
  | "internal_error"
  | "action.approval_forbidden"
  | "action.approval_presence_required"
  | "action.operator_presence_unsupported"
  | "action.operator_challenge_capacity"
  | "action.operator_challenge_not_found"
  | "action.operator_challenge_expired"
  | "action.operator_challenge_consumed"
  | "action.operator_assertion_invalid"
  | "action.approval_not_found"
  | "action.approval_mismatch"
  | "action.approval_expired"
  | "action.approval_cancelled"
  | "action.approval_invalidated"
  | "action.approval_consumed"
  | "action.plan_version_stale"
  | "action.plan_not_pending"
  | "action.plan_expired"
  | "action.legacy_authority";

function errorStatus(
  body: unknown,
  errorRegistry: Pick<ErrorRegistry, "get">,
  operation?: Pick<OperationDefinition, "errors">,
): 200 | PublicErrorStatus | undefined {
  const result = publicErrorEnvelopeSchema.safeParse(body);
  if (!result.success) return 200;
  const operationError = operation?.errors.find(({ code }) => code === result.data.code);
  return operationError?.status ?? errorRegistry.get(result.data.code)?.status;
}

function fallbackCorrelationId(): string {
  return `request:${crypto.randomUUID()}`;
}

function correlationIdFrom(request: HttpAdmissionRequest): string {
  const header = request.headers.get("x-correlation-id");
  const parsed = correlationIdSchema.safeParse(header);
  return parsed.success ? parsed.data : fallbackCorrelationId();
}

function publicError(
  code: PublicHttpErrorCode,
  message: string,
  correlationId: string,
  errorRegistry: ErrorRegistry,
): PublicErrorEnvelope {
  const candidate = {
    code,
    message,
    correlationId,
    details: {},
  } satisfies PublicErrorEnvelope;
  const registered = errorRegistry.safeParse(candidate);
  if (registered.success) return registered.data;
  return publicErrorEnvelopeSchema.parse(candidate);
}

function immutablePrincipal(principal: HttpPrincipal): HttpPrincipal {
  return Object.freeze({
    subject: principal.subject,
    scopes: Object.freeze([...principal.scopes]),
  });
}

const PRINCIPAL_SUBJECT_MAX_LENGTH = 256;
const PRINCIPAL_SCOPE_MAX_LENGTH = 256;
const PRINCIPAL_SCOPE_MAX_COUNT = 64;

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actualKeys = Reflect.ownKeys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    actualKeys.every((key) => typeof key === "string" && keys.includes(key))
  );
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength)
    return undefined;
  return value;
}

function decodePrincipal(value: unknown): HttpPrincipal | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["subject", "scopes"])) return undefined;
  const subject = boundedText(value.subject, PRINCIPAL_SUBJECT_MAX_LENGTH);
  if (subject === undefined || !Array.isArray(value.scopes)) return undefined;
  if (value.scopes.length > PRINCIPAL_SCOPE_MAX_COUNT) return undefined;

  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const scopeValue of value.scopes) {
    const scope = boundedText(scopeValue, PRINCIPAL_SCOPE_MAX_LENGTH);
    if (scope === undefined || seen.has(scope)) return undefined;
    seen.add(scope);
    scopes.push(scope);
  }
  return immutablePrincipal({ subject, scopes });
}

function decodeCredentialResolution(value: unknown): HttpCredentialResolution | undefined {
  if (!isPlainRecord(value) || !Object.hasOwn(value, "kind")) return undefined;
  if (value.kind === "invalid" && hasExactKeys(value, ["kind"])) return { kind: "invalid" };
  if (value.kind === "expired" && hasExactKeys(value, ["kind"])) return { kind: "expired" };
  if (
    value.kind !== "authenticated" ||
    (!hasExactKeys(value, ["kind", "principal"]) &&
      !hasExactKeys(value, ["kind", "principal", "context"]))
  )
    return undefined;
  const principal = decodePrincipal(value.principal);
  if (principal === undefined) return undefined;
  const context = decodeAuthenticatedContext(value.context);
  if (Object.hasOwn(value, "context") && context === undefined) return undefined;
  if (
    context !== undefined &&
    (context.principalId !== principal.subject ||
      JSON.stringify(context.scopes) !== JSON.stringify(principal.scopes))
  )
    return undefined;
  return context === undefined
    ? { kind: "authenticated", principal }
    : { kind: "authenticated", principal, context };
}

function decodeAuthenticatedContext(value: unknown): AuthenticatedRequestContext | undefined {
  if (!isPlainRecord(value)) return undefined;
  const keys = [
    "principalId",
    "credentialId",
    "profile",
    "scopes",
    "authEventId",
    "authenticatedAt",
    "credentialExpiresAt",
    "presence",
  ];
  if (!hasExactKeys(value, keys)) return undefined;
  const principalId = boundedText(value.principalId, PRINCIPAL_SUBJECT_MAX_LENGTH);
  const credentialId = boundedText(value.credentialId, PRINCIPAL_SUBJECT_MAX_LENGTH);
  const authEventId = boundedText(value.authEventId, PRINCIPAL_SUBJECT_MAX_LENGTH);
  const authenticatedAt = boundedText(value.authenticatedAt, 40);
  const credentialExpiresAt = boundedText(value.credentialExpiresAt, 40);
  if (
    principalId === undefined ||
    credentialId === undefined ||
    authEventId === undefined ||
    authenticatedAt === undefined ||
    credentialExpiresAt === undefined ||
    (authenticatedAt !== undefined && !isCanonicalInstant(authenticatedAt)) ||
    (credentialExpiresAt !== undefined && !isCanonicalInstant(credentialExpiresAt)) ||
    !isActionProfile(value.profile) ||
    !Array.isArray(value.scopes)
  )
    return undefined;
  if (
    value.profile === "internal-action-executor" ||
    (value.profile === "operator-interactive" && value.principalId !== "principal:local-operator")
  )
    return undefined;
  const rawScopes = value.scopes.map((scope) => boundedText(scope, PRINCIPAL_SCOPE_MAX_LENGTH));
  if (rawScopes.some((scope): scope is undefined => scope === undefined)) return undefined;
  if (!isPlainRecord(value.presence) || typeof value.presence.kind !== "string") return undefined;
  if (value.presence.kind === "unattended") {
    if (!hasExactKeys(value.presence, ["kind"])) return undefined;
  } else if (value.presence.kind === "a1-non-approval-session") {
    if (
      !hasExactKeys(value.presence, [
        "kind",
        "sessionId",
        "sessionAuthEventId",
        "issuedAt",
        "expiresAt",
        "configurationRevision",
        "credentialExpiresAt",
      ])
    )
      return undefined;
    const sessionId = boundedText(value.presence.sessionId, 256);
    const sessionAuthEventId = boundedText(value.presence.sessionAuthEventId, 256);
    const issuedAt = boundedText(value.presence.issuedAt, 40);
    const expiresAt = boundedText(value.presence.expiresAt, 40);
    const configurationRevision = value.presence.configurationRevision;
    const sessionCredentialExpiresAt = boundedText(value.presence.credentialExpiresAt, 40);
    if (
      sessionId === undefined ||
      sessionAuthEventId === undefined ||
      issuedAt === undefined ||
      expiresAt === undefined ||
      sessionCredentialExpiresAt === undefined ||
      typeof configurationRevision !== "number" ||
      !Number.isSafeInteger(configurationRevision) ||
      configurationRevision < 1 ||
      !isCanonicalInstant(issuedAt) ||
      !isCanonicalInstant(expiresAt) ||
      !isCanonicalInstant(sessionCredentialExpiresAt)
    )
      return undefined;
  } else if (value.presence.kind === "human-present") {
    if (
      !hasExactKeys(value.presence, [
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
        "operatorDisplayCode",
        "authorityInstanceId",
        "operatorConfigurationRevision",
      ])
    )
      return undefined;
    const ceremonyId = boundedText(value.presence.ceremonyId, 256);
    const verifiedAt = boundedText(value.presence.verifiedAt, 40);
    const validUntil = boundedText(value.presence.validUntil, 40);
    const requestPath = boundedText(value.presence.requestPath, 2_048);
    const requestBodySha256 = boundedText(value.presence.requestBodySha256, 64);
    const challengeCommitmentSha256 = boundedText(value.presence.challengeCommitmentSha256, 64);
    const assertionSignatureSha256 = boundedText(value.presence.assertionSignatureSha256, 64);
    const assertionSignatureP1363Base64url = boundedText(
      value.presence.assertionSignatureP1363Base64url,
      86,
    );
    const operatorDisplayCode = boundedText(value.presence.operatorDisplayCode, 24);
    const authorityInstanceId = boundedText(value.presence.authorityInstanceId, 256);
    const operatorConfigurationRevision = value.presence.operatorConfigurationRevision;
    if (
      ceremonyId === undefined ||
      verifiedAt === undefined ||
      validUntil === undefined ||
      requestPath === undefined ||
      requestBodySha256 === undefined ||
      challengeCommitmentSha256 === undefined ||
      assertionSignatureSha256 === undefined ||
      assertionSignatureP1363Base64url === undefined ||
      operatorDisplayCode === undefined ||
      authorityInstanceId === undefined ||
      typeof operatorConfigurationRevision !== "number" ||
      !Number.isSafeInteger(operatorConfigurationRevision) ||
      operatorConfigurationRevision < 1 ||
      !isCanonicalInstant(verifiedAt) ||
      !isCanonicalInstant(validUntil) ||
      typeof value.presence.requestMethod !== "string" ||
      !/^(?:POST|DELETE)$/u.test(value.presence.requestMethod) ||
      !/^[a-f0-9]{64}$/u.test(requestBodySha256) ||
      !/^[a-f0-9]{64}$/u.test(challengeCommitmentSha256) ||
      !/^[a-f0-9]{64}$/u.test(assertionSignatureSha256) ||
      !/^[A-Za-z0-9_-]{86}$/u.test(assertionSignatureP1363Base64url) ||
      !/^[0-9a-f]{4}(?:-[0-9a-f]{4}){4}$/u.test(operatorDisplayCode)
    )
      return undefined;
  } else return undefined;
  // Validation alone cannot establish provenance. The context must have been
  // registered by an internal credential/session or native-presence boundary;
  // a caller-supplied object with the same fields remains untrusted.
  if (!isTrustedAuthContext(value)) return undefined;
  return value;
}

function isActionProfile(value: unknown): value is AuthenticatedRequestContext["profile"] {
  return (
    value === "operator-interactive" ||
    value === "agent-unattended" ||
    value === "internal-action-executor"
  );
}

function isCanonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

type AuthenticationDecision =
  | Readonly<{
      readonly kind: "authenticated";
      readonly principal: HttpPrincipal;
      readonly context?: AuthenticatedRequestContext;
    }>
  | Readonly<{
      readonly kind: "denied";
      readonly code: "missing_credentials" | "invalid_credentials" | "expired_credentials";
    }>;

function malformedBearerCredential(
  request: HttpAdmissionRequest,
):
  | Readonly<{ readonly kind: "missing" }>
  | Readonly<{ readonly kind: "invalid" }>
  | Readonly<{ readonly kind: "credential"; readonly value: string }> {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return { kind: "missing" };
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  if (match === null || match[1] === undefined) return { kind: "invalid" };
  return { kind: "credential", value: match[1] };
}

async function authenticateRequest(
  request: HttpAdmissionRequest,
  authenticate: HttpCredentialAuthenticator | undefined,
  operation?: OperationDefinition,
  operatorSessionAdmission = false,
  operatorPresenceAdmission = false,
): Promise<AuthenticationDecision> {
  const parsed = malformedBearerCredential(request);
  const operatorAssertionHeader = request.headers.get("authorization");
  const hasOperatorAssertionHeader =
    operatorAssertionHeader !== null && operatorAssertionHeader.startsWith("AgentMail-Operator ");
  if (
    (parsed.kind === "missing" || hasOperatorAssertionHeader) &&
    operatorSessionAdmission &&
    operation?.key === "operator-sessions.create" &&
    isLoopbackHttpRequest(request)
  ) {
    return {
      kind: "authenticated",
      principal: immutablePrincipal({ subject: "principal:local-operator", scopes: [] }),
    };
  }
  if (
    (parsed.kind === "missing" || hasOperatorAssertionHeader) &&
    operatorPresenceAdmission &&
    (operation?.key === "action-plans.approve" || operation?.key === "action-plans.cancel-approval")
  ) {
    return {
      kind: "authenticated",
      principal: immutablePrincipal({
        subject: "principal:local-operator",
        scopes: ["mail:action.approve"],
      }),
    };
  }
  if (parsed.kind === "missing") return { kind: "denied", code: "missing_credentials" };
  if (parsed.kind === "invalid") return { kind: "denied", code: "invalid_credentials" };
  if (authenticate === undefined) return { kind: "denied", code: "invalid_credentials" };

  try {
    const resolution = decodeCredentialResolution(await authenticate(parsed.value));
    if (resolution === undefined) return { kind: "denied", code: "invalid_credentials" };
    switch (resolution.kind) {
      case "authenticated":
        return {
          kind: "authenticated",
          principal: immutablePrincipal(resolution.principal),
          context: resolution.context,
        };
      case "expired":
        return { kind: "denied", code: "expired_credentials" };
      case "invalid":
        return { kind: "denied", code: "invalid_credentials" };
      default:
        return { kind: "denied", code: "invalid_credentials" };
    }
  } catch {
    return { kind: "denied", code: "invalid_credentials" };
  }
}

function authorizationFailure(
  operation: OperationDefinition,
  principal: HttpPrincipal,
  request?: Readonly<{ readonly url?: string }>,
): "insufficient_scope" | undefined {
  if (operation.key === "operator-sessions.create") {
    if (!isLoopbackHttpRequest(request)) return "insufficient_scope";
    return principal.scopes.length === 0 ? undefined : "insufficient_scope";
  }
  if (operation.scope === null) return undefined;
  const requiredScopes = [operation.scope];
  return requiredScopes.every((scope) => principal.scopes.includes(scope))
    ? undefined
    : "insufficient_scope";
}

/** Operator-session issuance is intentionally reachable only through loopback HTTP. */
function isLoopbackHttpRequest(request: Readonly<{ readonly url?: string }> | undefined): boolean {
  if (request?.url === undefined) return false;
  try {
    const hostname = new URL(request.url).hostname.toLowerCase().replace(/\.$/u, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function logPrivate(logger: PrivateHttpLogger | undefined, entry: PrivateHttpLogEntry): void {
  if (logger === undefined) return;
  try {
    logger(entry);
  } catch {
    // A diagnostics sink cannot change the public transport result.
  }
}

type FeatureProjection = Readonly<{
  readonly status: PublicErrorStatus;
  readonly body: PublicErrorEnvelope;
}>;

function featureErrorCandidate(value: unknown): unknown {
  if (value instanceof RegisteredFeatureErrorException) return value.featureError;
  if (!isJsonObject(value)) return undefined;
  if (value.kind === "feature-error" && Object.hasOwn(value, "error")) return value.error;
  return Object.hasOwn(value, "code") ? value : undefined;
}

/**
 * Project only registered operation errors. Success values, malformed error
 * objects, and private exceptions deliberately return no projection so the
 * caller can use the redacted internal-error path.
 */
function projectRegisteredFeatureError(
  operation: OperationDefinition,
  value: unknown,
  correlationId: string,
  errorRegistry: ErrorRegistry,
): FeatureProjection | undefined {
  const candidate = featureErrorCandidate(value);
  if (!isJsonObject(candidate)) return undefined;
  if (typeof candidate.message !== "string" || !isJsonObject(candidate.details)) return undefined;

  const envelope = {
    code: candidate.code,
    message: candidate.message,
    correlationId,
    details: candidate.details,
  };
  const operationDefinition = operation.errors.find(({ code }) => code === candidate.code);
  if (operationDefinition !== undefined) {
    try {
      const body = parseErrorDefinition(operationDefinition, envelope);
      return Object.freeze({ status: operationDefinition.status, body });
    } catch {
      return undefined;
    }
  }
  const registered = errorRegistry.safeParse(envelope);
  if (registered.success) {
    const status = errorRegistry.get(registered.data.code)?.status;
    if (status === undefined) return undefined;
    return Object.freeze({
      status,
      body: registered.data,
    });
  }

  const parsed = operation.response.safeParse({
    code: candidate.code,
    message: candidate.message,
    correlationId,
    details: candidate.details,
  });
  if (!parsed.success) return undefined;
  const publicParsed = publicErrorEnvelopeSchema.safeParse(parsed.data);
  if (!publicParsed.success) return undefined;

  // A response schema can admit a public error that has no operation-owned
  // status metadata. Do not guess a status for that contract escape.
  return undefined;
}

/**
 * Adapt one shared operation registry to request parsing, handler execution,
 * and response validation. The adapter never hands a handler raw JSON.
 */
export function createRegistryTransportAdapter(
  options: RegistryTransportAdapterOptions,
): RegistryTransportAdapter {
  const errorRegistry = options.errorRegistry ?? httpErrorRegistry;
  return Object.freeze({
    execute: async (
      operationKey: string,
      input: unknown,
      context: TransportRequestContext,
    ): Promise<TransportResult> => {
      const operation = options.registry.get(operationKey);
      if (operation === undefined) {
        return {
          status: 404,
          body: publicError(
            "not_found",
            "operation was not found",
            context.correlationId,
            errorRegistry,
          ),
        };
      }

      const authentication: AuthenticationDecision =
        context[authenticatedPrincipal] === undefined
          ? await authenticateRequest(
              context.request,
              options.authenticate,
              operation,
              options.operatorSessionAuthority !== undefined,
              options.operatorPresenceAuthority !== undefined,
            )
          : {
              kind: "authenticated",
              principal: immutablePrincipal(context[authenticatedPrincipal]),
              context: context[authenticatedContext],
            };
      if (authentication.kind === "denied") {
        const body = publicError(
          authentication.code,
          "request credentials are not authorized",
          context.correlationId,
          errorRegistry,
        );
        const status = errorStatus(body, errorRegistry, operation);
        if (status === undefined || status === 200)
          return {
            status: 500,
            body: publicError(
              "internal_error",
              "internal server error",
              context.correlationId,
              errorRegistry,
            ),
          };
        return {
          status,
          body,
        };
      }
      const insufficientScope = authorizationFailure(
        operation,
        authentication.principal,
        context.request,
      );
      if (insufficientScope !== undefined) {
        return {
          status: 403,
          body: publicError(
            insufficientScope,
            "request credentials are not authorized",
            context.correlationId,
            errorRegistry,
          ),
        };
      }

      let parsedInput: unknown;
      try {
        parsedInput = options.registry.parseRequest(operationKey, input);
      } catch {
        return {
          status: 400,
          body: publicError(
            "invalid_request",
            "request is invalid",
            context.correlationId,
            errorRegistry,
          ),
        };
      }

      const handler = options.handlers[operationKey];
      if (handler === undefined) {
        logPrivate(options.logger, {
          kind: "handler-error",
          operationKey,
          correlationId: context.correlationId,
        });
        return {
          status: 500,
          body: publicError(
            "internal_error",
            "internal server error",
            context.correlationId,
            errorRegistry,
          ),
        };
      }

      let output: unknown;
      try {
        output = await handler(parsedInput, {
          operation,
          request: context.request,
          correlationId: context.correlationId,
          params: context.params ?? {},
          query: context.query ?? {},
          principal: authentication.principal,
          authContext: authentication.context,
          ...(context.requestBodySha256 === undefined
            ? {}
            : { requestBodySha256: context.requestBodySha256 }),
          ...(context.requestBodyBytes === undefined
            ? {}
            : { requestBodyBytes: new Uint8Array(context.requestBodyBytes) }),
          ...(context.operatorAssertion === undefined
            ? {}
            : { operatorAssertion: context.operatorAssertion }),
        });
      } catch (error: unknown) {
        const feature = projectRegisteredFeatureError(
          operation,
          error,
          context.correlationId,
          errorRegistry,
        );
        if (feature !== undefined) return feature;
        logPrivate(options.logger, {
          kind: "handler-error",
          operationKey,
          correlationId: context.correlationId,
        });
        return {
          status: 500,
          body: publicError(
            "internal_error",
            "internal server error",
            context.correlationId,
            errorRegistry,
          ),
        };
      }

      const feature = projectRegisteredFeatureError(
        operation,
        output,
        context.correlationId,
        errorRegistry,
      );
      if (feature !== undefined) return feature;

      let parsedOutput: unknown;
      try {
        parsedOutput = options.registry.parseResponse(operationKey, output);
      } catch {
        logPrivate(options.logger, {
          kind: "invalid-handler-output",
          operationKey,
          correlationId: context.correlationId,
        });
        return {
          status: 500,
          body: publicError(
            "internal_error",
            "internal server error",
            context.correlationId,
            errorRegistry,
          ),
        };
      }

      const parsedError = publicErrorEnvelopeSchema.safeParse(parsedOutput);
      const status = errorStatus(parsedOutput, errorRegistry, operation);
      if (!parsedError.success || status === 200) return { status: 200, body: parsedOutput };
      if (status !== undefined) return { status, body: parsedOutput };
      logPrivate(options.logger, {
        kind: "invalid-handler-output",
        operationKey,
        correlationId: context.correlationId,
      });
      return {
        status: 500,
        body: publicError(
          "internal_error",
          "internal server error",
          context.correlationId,
          errorRegistry,
        ),
      };
    },
  });
}

function contentTypeIsJson(request: HttpAdmissionRequest): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function requestMayHaveBody(request: HttpAdmissionRequest): boolean {
  const method = request.method.toUpperCase();
  return (
    request.headers.get("content-length") !== null ||
    ["POST", "PUT", "PATCH", "DELETE"].includes(method)
  );
}

type DeclaredContentLength = number | undefined;

function declaredContentLength(request: HttpAdmissionRequest): DeclaredContentLength {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value) || value.includes(",")) {
    throw new InvalidHttpRequestError("request content length is invalid", 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidHttpRequestError("request content length is invalid", 400);
  }
  return parsed;
}

async function cancelInput(
  request: HttpAdmissionRequest,
  lifecycleProbe: HttpAdmissionLifecycleProbe | undefined,
): Promise<void> {
  const body = request.body;
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Releasing a rejected input stream is best effort; it cannot change the response.
  } finally {
    lifecycleProbe?.onInputCancelled?.();
  }
}

class RequestAbortedError extends Error {
  constructor() {
    super("request body was aborted");
    this.name = "RequestAbortedError";
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  cancelReader: () => Promise<void>,
  lifecycleProbe: HttpAdmissionLifecycleProbe | undefined,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  if (signal.aborted) {
    await cancelReader();
    throw new RequestAbortedError();
  }
  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => {
      reject(new RequestAbortedError());
      void cancelReader();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
      lifecycleProbe?.onAbortListenerRemoved?.();
    }
  }
}

async function readReceivedBytes(
  request: HttpAdmissionRequest,
  maxRequestBodyBytes: number,
  lifecycleProbe: HttpAdmissionLifecycleProbe | undefined,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new TypeError("maxRequestBodyBytes must be a positive safe integer");
  }
  const declared = declaredContentLength(request);
  if (declared !== undefined && declared > maxRequestBodyBytes) {
    await cancelInput(request, lifecycleProbe);
    throw new InvalidHttpRequestError(
      "request body exceeds configured limit",
      413,
      "request_too_large",
    );
  }

  const body = request.body;
  if (body === null) {
    if (declared !== undefined && declared !== 0) {
      throw new InvalidHttpRequestError("request content length does not match body", 400);
    }
    return new Uint8Array(0);
  }

  const initialCapacity = Math.min(maxRequestBodyBytes, declared ?? 64 * 1024);
  let bytes = new Uint8Array(initialCapacity);
  let received = 0;
  const reader = body.getReader();
  lifecycleProbe?.onReaderAcquired?.();
  let shouldCancel = true;
  let readerCancellation: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    readerCancellation ??= reader.cancel().catch(() => {
      // The stream may already be errored or closed.
    });
    return readerCancellation;
  };
  try {
    for (;;) {
      const result = await readWithAbort(reader, request.signal, cancelReader, lifecycleProbe);
      if (result.done) break;
      const chunk = result.value;
      if (chunk.byteLength > maxRequestBodyBytes - received) {
        throw new InvalidHttpRequestError(
          "request body exceeds configured limit",
          413,
          "request_too_large",
        );
      }
      const requiredCapacity = received + chunk.byteLength;
      if (requiredCapacity > bytes.byteLength) {
        const nextCapacity = Math.min(
          maxRequestBodyBytes,
          Math.max(requiredCapacity, Math.max(1, bytes.byteLength * 2)),
        );
        const next = new Uint8Array(nextCapacity);
        next.set(bytes.subarray(0, received));
        bytes = next;
      }
      bytes.set(chunk, received);
      received = requiredCapacity;
    }
    if (declared !== undefined && declared !== received) {
      throw new InvalidHttpRequestError("request content length does not match body", 400);
    }
    shouldCancel = false;
    return bytes.subarray(0, received);
  } catch (error: unknown) {
    if (error instanceof InvalidHttpRequestError) throw error;
    throw new InvalidHttpRequestError("request body could not be read", 400);
  } finally {
    if (shouldCancel) await cancelReader();
    reader.releaseLock();
    lifecycleProbe?.onReaderReleased?.();
  }
}

async function readUnknownRequestInput(
  request: HttpAdmissionRequest,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, string>>,
  maxRequestBodyBytes: number,
  lifecycleProbe: HttpAdmissionLifecycleProbe | undefined,
): Promise<
  Readonly<{ readonly input: unknown; readonly bodySha256: string; readonly bodyBytes: Uint8Array }>
> {
  // Validate the framing header even for methods that normally have no body;
  // malformed framing is always a 400 boundary failure.
  try {
    declaredContentLength(request);
  } catch (error: unknown) {
    await cancelInput(request, lifecycleProbe);
    throw error;
  }
  let body: unknown = {};
  let bodySha256 = createHash("sha256").update(new Uint8Array()).digest("hex");
  let bodyBytes = new Uint8Array(0);
  if (requestMayHaveBody(request)) {
    if (!contentTypeIsJson(request)) {
      await cancelInput(request, lifecycleProbe);
      throw new InvalidHttpRequestError("request content type must be JSON", 415);
    }
    const contentEncoding = request.headers.get("content-encoding");
    if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== "identity") {
      await cancelInput(request, lifecycleProbe);
      throw new InvalidHttpRequestError("request content encoding is unsupported", 415);
    }
    try {
      const received = await readReceivedBytes(request, maxRequestBodyBytes, lifecycleProbe);
      bodyBytes = new Uint8Array(received);
      bodySha256 = createHash("sha256").update(received).digest("hex");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(received);
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch (error: unknown) {
      if (error instanceof InvalidHttpRequestError) throw error;
      throw new InvalidHttpRequestError("request body is malformed JSON", 400);
    }
  }
  if (!isJsonObject(body)) return { input: body, bodySha256, bodyBytes };
  return { input: { ...body, ...query, ...params }, bodySha256, bodyBytes };
}

/** Authenticate and authorize before touching the request body stream. */
export async function admitHttpRequest(
  options: HttpAdmissionOptions,
): Promise<HttpAdmissionResult> {
  const errorRegistry = options.errorRegistry ?? httpErrorRegistry;
  const correlationId = options.correlationId ?? correlationIdFrom(options.request);
  const requiresOperatorAssertion =
    options.operatorSessionAdmission === true &&
    options.operation.key === "operator-sessions.create"
      ? true
      : options.operatorPresenceAdmission === true &&
        (options.operation.key === "action-plans.approve" ||
          options.operation.key === "action-plans.cancel-approval");
  const operatorAssertion = requiresOperatorAssertion
    ? parseOperatorAssertionHeader(options.request.headers.get("authorization"))
    : undefined;
  if (requiresOperatorAssertion && operatorAssertion === undefined) {
    await cancelInput(options.request, options.lifecycleProbe);
    return {
      kind: "rejected",
      status: 403,
      body: publicError(
        "action.operator_assertion_invalid",
        "operator presence assertion is invalid",
        correlationId,
        errorRegistry,
      ),
    };
  }
  const authentication = await authenticateRequest(
    options.request,
    options.authenticate,
    options.operation,
    options.operatorSessionAdmission === true,
    options.operatorPresenceAdmission === true,
  );
  if (authentication.kind === "denied") {
    await cancelInput(options.request, options.lifecycleProbe);
    const body = publicError(
      authentication.code,
      "request credentials are not authorized",
      correlationId,
      errorRegistry,
    );
    return {
      kind: "rejected",
      status: 401,
      body,
    };
  }
  if (
    authorizationFailure(options.operation, authentication.principal, options.request) !== undefined
  ) {
    await cancelInput(options.request, options.lifecycleProbe);
    return {
      kind: "rejected",
      status: 403,
      body: publicError(
        "insufficient_scope",
        "request credentials are not authorized",
        correlationId,
        errorRegistry,
      ),
    };
  }

  try {
    const parsed = await readUnknownRequestInput(
      options.request,
      options.params ?? {},
      options.query ?? {},
      options.maxRequestBodyBytes ?? DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES,
      options.lifecycleProbe,
    );
    return {
      kind: "accepted",
      input: parsed.input,
      principal: authentication.principal,
      authContext: authentication.context,
      requestBodySha256: parsed.bodySha256,
      requestBodyBytes: parsed.bodyBytes,
      ...([
        "operator-sessions.create",
        "action-plans.approve",
        "action-plans.cancel-approval",
      ].includes(options.operation.key)
        ? operatorAssertion === undefined
          ? {}
          : { operatorAssertion }
        : {}),
    };
  } catch (error: unknown) {
    const requestError =
      error instanceof InvalidHttpRequestError
        ? error
        : new InvalidHttpRequestError("request is invalid", 400);
    return {
      kind: "rejected",
      status: requestError.status,
      body: publicError(
        requestError.code,
        requestError.code === "request_too_large"
          ? "request body exceeds configured limit"
          : "request is invalid",
        correlationId,
        errorRegistry,
      ),
    };
  }
}

/** Preserve an already-admitted principal when a feature adapter is called. */
export function authenticatedTransportContext(
  context: TransportRequestContext,
  principal: HttpPrincipal,
  authContext?: AuthenticatedRequestContext,
  requestBodyBytes?: Uint8Array,
  operatorAssertion?: OperatorPresenceAssertion,
): TransportRequestContext {
  return Object.freeze({
    ...context,
    [authenticatedPrincipal]: immutablePrincipal(principal),
    ...(authContext === undefined ? {} : { [authenticatedContext]: authContext }),
    ...(requestBodyBytes === undefined
      ? {}
      : { requestBodyBytes: new Uint8Array(requestBodyBytes) }),
    ...(operatorAssertion === undefined ? {} : { operatorAssertion }),
  });
}

/**
 * Bind the public approval handlers to the native-verified request ceremony.
 * The supplied handler never receives caller identity or an unverified
 * presence object; both are replaced by the verifier's private result.
 */
function operatorPresenceHandler(
  handler: OperationHandler,
  authority: OperatorPresenceAuthority,
  operation: "approve" | "cancel-approval",
): OperationHandler {
  return async (input, context) => {
    const assertion = context.operatorAssertion;
    const body = context.requestBodyBytes;
    const transportRequest = context.request;
    const planId = context.params.planId;
    const approvalId = context.params.approvalId;
    if (
      assertion === undefined ||
      body === undefined ||
      transportRequest === undefined ||
      planId === undefined ||
      (operation === "cancel-approval" && approvalId === undefined)
    ) {
      throw {
        code: "action.operator_assertion_invalid",
        message: "operator presence assertion is invalid",
        details: {},
      };
    }
    let path: string;
    try {
      path = new URL(transportRequest.url).pathname;
    } catch {
      throw {
        code: "action.operator_assertion_invalid",
        message: "operator presence assertion is invalid",
        details: {},
      };
    }
    try {
      const binding = await authority.currentBinding();
      const request: OperatorPresenceRequest = {
        operation,
        method: operation === "approve" ? "POST" : "DELETE",
        path,
        rawBody: new Uint8Array(body),
        credentialId: assertion.credentialId,
        principalId: "principal:local-operator",
        authorityInstanceId: binding.authorityInstanceId,
        configurationRevision: binding.configurationRevision,
      };
      const trusted = await authority.verifyForAction(request, assertion);
      return handler(input, {
        ...context,
        principal: Object.freeze({
          subject: trusted.principalId,
          scopes: Object.freeze([...trusted.scopes]),
        }),
        authContext: trusted,
        requestBodyBytes: new Uint8Array(body),
      });
    } catch (error: unknown) {
      if (error instanceof OperatorPresenceError) {
        throw {
          code: error.code,
          message:
            error.code === "action.operator_presence_unsupported"
              ? "secure operator presence is unavailable"
              : error.code === "action.operator_challenge_capacity"
                ? "operator challenge capacity is exhausted"
                : "operator presence assertion is invalid",
          details: {},
        };
      }
      throw error;
    }
  };
}

/** Construct a Hono app without binding a listener or adding feature behavior. */
export function createHttpApp(options: HttpAppOptions = {}): Hono {
  const registry = options.registry ?? publicOperationRegistry;
  const suppliedHandlers = options.handlers ?? {};
  const handlers: OperationHandlerMap = Object.freeze({
    ...suppliedHandlers,
    ...(options.operatorSessionAuthority === undefined
      ? {}
      : {
          "operator-sessions.create": createOperatorSessionHandler(
            options.operatorSessionAuthority,
          ),
        }),
    ...(options.operatorPresenceAuthority === undefined
      ? {}
      : {
          ...(suppliedHandlers["action-plans.approve"] === undefined
            ? {}
            : {
                "action-plans.approve": operatorPresenceHandler(
                  suppliedHandlers["action-plans.approve"],
                  options.operatorPresenceAuthority,
                  "approve",
                ),
              }),
          ...(suppliedHandlers["action-plans.cancel-approval"] === undefined
            ? {}
            : {
                "action-plans.cancel-approval": operatorPresenceHandler(
                  suppliedHandlers["action-plans.cancel-approval"],
                  options.operatorPresenceAuthority,
                  "cancel-approval",
                ),
              }),
        }),
  });
  const errorRegistry = options.errorRegistry ?? httpErrorRegistry;
  const adapter = createRegistryTransportAdapter({
    registry,
    handlers,
    errorRegistry,
    logger: options.logger,
    authenticate: options.authenticate,
    operatorSessionAuthority: options.operatorSessionAuthority,
    operatorPresenceAuthority: options.operatorPresenceAuthority,
  });
  const app = new Hono();

  // Hono's method router otherwise emits its own unstructured 404. Keep the
  // wrong-method outcome stable while still rejecting before admission/body IO.
  app.use("*", async (context, next) => {
    const path = context.req.path;
    const matched = registry.operations.find((candidate) => {
      const routeParts = candidate.route.split("/");
      const pathParts = path.split("/");
      return (
        routeParts.length === pathParts.length &&
        routeParts.every((part, index) => {
          const actual = pathParts[index];
          return (
            actual !== undefined && (part.startsWith("{") ? actual.length > 0 : part === actual)
          );
        })
      );
    });
    if (matched !== undefined && matched.method !== context.req.method.toUpperCase()) {
      return context.json(
        publicError(
          "not_found",
          "route was not found",
          correlationIdFrom(context.req.raw),
          errorRegistry,
        ),
        404,
      );
    }
    await next();
  });

  for (const operation of registry.operations) {
    const routeHandler = async (context: Context) => {
      const request = context.req.raw;
      const correlationId = correlationIdFrom(request);
      const params: Readonly<Record<string, string>> = { ...context.req.param() };
      const query: Readonly<Record<string, string>> = { ...context.req.query() };
      const admission = await admitHttpRequest({
        operation,
        request,
        params,
        query,
        authenticate: options.authenticate,
        operatorSessionAdmission: options.operatorSessionAuthority !== undefined,
        operatorPresenceAdmission: options.operatorPresenceAuthority !== undefined,
        errorRegistry,
        maxRequestBodyBytes: options.maxRequestBodyBytes,
        correlationId,
      });
      if (admission.kind === "rejected") return context.json(admission.body, admission.status);
      const result = await adapter.execute(
        operation.key,
        admission.input,
        authenticatedTransportContext(
          {
            request,
            correlationId,
            params,
            query,
            requestBodySha256: admission.requestBodySha256,
            requestBodyBytes: admission.requestBodyBytes,
            operatorAssertion: admission.operatorAssertion,
          },
          admission.principal,
          admission.authContext,
          admission.requestBodyBytes,
          admission.operatorAssertion,
        ),
      );
      return context.json(result.body, result.status);
    };
    switch (operation.method) {
      case "GET":
        app.get(operationRouteToHonoRoute(operation.route), routeHandler);
        break;
      case "POST":
        app.post(operationRouteToHonoRoute(operation.route), routeHandler);
        break;
      case "DELETE":
        app.delete(operationRouteToHonoRoute(operation.route), routeHandler);
        break;
      default:
        throw new TypeError("unsupported operation method");
    }
  }

  app.notFound((context) => {
    const correlationId = correlationIdFrom(context.req.raw);
    return context.json(
      publicError("not_found", "route was not found", correlationId, errorRegistry),
      404,
    );
  });
  return app;
}

/** Short alias for callers that treat the Hono instance as the application. */
export const createApp = createHttpApp;

/** Compatibility alias naming the transport adapter explicitly. */
export const createOperationTransportAdapter = createRegistryTransportAdapter;
