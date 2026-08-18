import { Hono } from "hono";
import {
  actionPlanOperationDefinitions,
  correlationIdSchema,
  createErrorRegistry,
  createOperationRegistry,
  defineError,
  publicErrorEnvelopeSchema,
  reportAdminOperationDefinitions,
  retrievalOperationDefinitions,
  routingOperationDefinitions,
  syncOperationDefinitions,
  type ErrorRegistry,
  type OperationDefinition,
  type OperationRegistry,
  type PublicErrorEnvelope,
} from "@agent-mail/contracts";
import { z } from "zod";
import { DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES } from "./config";

export { DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES } from "./config";

const emptyDetailsSchema = z.strictObject({});

/** The public errors produced by the transport before a feature handler runs. */
export const httpErrorRegistry = createErrorRegistry([
  defineError({ code: "invalid_request", details: emptyDetailsSchema }),
  defineError({ code: "missing_credentials", details: emptyDetailsSchema }),
  defineError({ code: "invalid_credentials", details: emptyDetailsSchema }),
  defineError({ code: "expired_credentials", details: emptyDetailsSchema }),
  defineError({ code: "insufficient_scope", details: emptyDetailsSchema }),
  defineError({ code: "request_too_large", details: emptyDetailsSchema }),
  defineError({ code: "not_found", details: emptyDetailsSchema }),
  defineError({ code: "internal_error", details: emptyDetailsSchema }),
] as const);

/** The complete public operation set consumed by the daemon HTTP surface. */
export const publicOperationDefinitions = Object.freeze([
  ...retrievalOperationDefinitions,
  ...routingOperationDefinitions,
  ...actionPlanOperationDefinitions,
  ...reportAdminOperationDefinitions,
  ...syncOperationDefinitions,
] as const satisfies readonly OperationDefinition[]);

export const publicOperationRegistry = createOperationRegistry(publicOperationDefinitions);

export type OperationHandlerContext = Readonly<{
  readonly operation: OperationDefinition;
  readonly correlationId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly principal: HttpPrincipal;
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

export type HttpCredentialResolution =
  | Readonly<{ readonly kind: "authenticated"; readonly principal: HttpPrincipal }>
  | Readonly<{ readonly kind: "invalid" }>
  | Readonly<{ readonly kind: "expired" }>;

/** Resolve one already-parsed bearer value; raw credentials never enter a handler context. */
export type HttpCredentialAuthenticator = (credential: string) => unknown;

export type HttpAuthenticator = HttpCredentialAuthenticator;

const authenticatedPrincipal = Symbol("authenticatedPrincipal");

export type TransportRequestContext = Readonly<{
  readonly request: Request;
  readonly correlationId: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly [authenticatedPrincipal]?: HttpPrincipal;
}>;

export type TransportResult = Readonly<{
  readonly status: 200 | 400 | 401 | 403 | 404 | 413 | 415 | 500;
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
}>;

export type HttpAppOptions = Readonly<{
  readonly registry?: OperationRegistry;
  readonly handlers?: OperationHandlerMap;
  readonly errorRegistry?: ErrorRegistry;
  readonly logger?: PrivateHttpLogger;
  readonly authenticate?: HttpCredentialAuthenticator;
  readonly maxRequestBodyBytes?: number;
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
}>;

/** The minimal request shape needed by the admission boundary. */
export type HttpAdmissionRequest = Pick<Request, "headers" | "body" | "method" | "signal">;

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
  | "internal_error";

function errorStatus(body: unknown): 200 | 400 | 401 | 403 | 404 | 413 | 500 {
  const result = publicErrorEnvelopeSchema.safeParse(body);
  if (!result.success) return 200;
  switch (result.data.code) {
    case "invalid_request":
    case "invalid_query":
    case "invalid_cursor":
      return 400;
    case "missing_credentials":
    case "invalid_credentials":
    case "expired_credentials":
      return 401;
    case "insufficient_scope":
      return 403;
    case "request_too_large":
      return 413;
    case "not_found":
      return 404;
    case "internal_error":
      return 500;
    default:
      return 500;
  }
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
  if (value.kind !== "authenticated" || !hasExactKeys(value, ["kind", "principal"]))
    return undefined;
  const principal = decodePrincipal(value.principal);
  return principal === undefined ? undefined : { kind: "authenticated", principal };
}

type AuthenticationDecision =
  | Readonly<{ readonly kind: "authenticated"; readonly principal: HttpPrincipal }>
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
): Promise<AuthenticationDecision> {
  const parsed = malformedBearerCredential(request);
  if (parsed.kind === "missing") return { kind: "denied", code: "missing_credentials" };
  if (parsed.kind === "invalid") return { kind: "denied", code: "invalid_credentials" };
  if (authenticate === undefined) return { kind: "denied", code: "invalid_credentials" };

  try {
    const resolution = decodeCredentialResolution(await authenticate(parsed.value));
    if (resolution === undefined) return { kind: "denied", code: "invalid_credentials" };
    switch (resolution.kind) {
      case "authenticated":
        return { kind: "authenticated", principal: immutablePrincipal(resolution.principal) };
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
): "insufficient_scope" | undefined {
  const requiredScopes = [operation.scope];
  return requiredScopes.every((scope) => principal.scopes.includes(scope))
    ? undefined
    : "insufficient_scope";
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
  readonly status: 200 | 400 | 401 | 403 | 404 | 413 | 500;
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
): FeatureProjection | undefined {
  const candidate = featureErrorCandidate(value);
  if (!isJsonObject(candidate)) return undefined;
  if (typeof candidate.message !== "string" || !isJsonObject(candidate.details)) return undefined;

  const parsed = operation.response.safeParse({
    code: candidate.code,
    message: candidate.message,
    correlationId,
    details: candidate.details,
  });
  if (!parsed.success) return undefined;
  const publicParsed = publicErrorEnvelopeSchema.safeParse(parsed.data);
  if (!publicParsed.success) return undefined;

  const body: PublicErrorEnvelope = publicParsed.data;
  return Object.freeze({
    status: errorStatus(body),
    body,
  });
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
          ? await authenticateRequest(context.request, options.authenticate)
          : {
              kind: "authenticated",
              principal: immutablePrincipal(context[authenticatedPrincipal]),
            };
      if (authentication.kind === "denied") {
        return {
          status: errorStatus(
            publicError(
              authentication.code,
              "request credentials are not authorized",
              context.correlationId,
              errorRegistry,
            ),
          ),
          body: publicError(
            authentication.code,
            "request credentials are not authorized",
            context.correlationId,
            errorRegistry,
          ),
        };
      }
      const insufficientScope = authorizationFailure(operation, authentication.principal);
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
          correlationId: context.correlationId,
          params: context.params ?? {},
          query: context.query ?? {},
          principal: authentication.principal,
        });
      } catch (error: unknown) {
        const feature = projectRegisteredFeatureError(operation, error, context.correlationId);
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

      const feature = projectRegisteredFeatureError(operation, output, context.correlationId);
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

      return { status: errorStatus(parsedOutput), body: parsedOutput };
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
    request.headers.get("content-length") !== null || ["POST", "PUT", "PATCH"].includes(method)
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
): Promise<unknown> {
  // Validate the framing header even for methods that normally have no body;
  // malformed framing is always a 400 boundary failure.
  try {
    declaredContentLength(request);
  } catch (error: unknown) {
    await cancelInput(request, lifecycleProbe);
    throw error;
  }
  let body: unknown = {};
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
      const text = new TextDecoder("utf-8", { fatal: true }).decode(received);
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch (error: unknown) {
      if (error instanceof InvalidHttpRequestError) throw error;
      throw new InvalidHttpRequestError("request body is malformed JSON", 400);
    }
  }
  if (!isJsonObject(body)) return body;
  return { ...body, ...query, ...params };
}

/** Authenticate and authorize before touching the request body stream. */
export async function admitHttpRequest(
  options: HttpAdmissionOptions,
): Promise<HttpAdmissionResult> {
  const errorRegistry = options.errorRegistry ?? httpErrorRegistry;
  const correlationId = options.correlationId ?? correlationIdFrom(options.request);
  const authentication = await authenticateRequest(options.request, options.authenticate);
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
  if (authorizationFailure(options.operation, authentication.principal) !== undefined) {
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
    const input = await readUnknownRequestInput(
      options.request,
      options.params ?? {},
      options.query ?? {},
      options.maxRequestBodyBytes ?? DEFAULT_HTTP_REQUEST_BODY_LIMIT_BYTES,
      options.lifecycleProbe,
    );
    return {
      kind: "accepted",
      input,
      principal: authentication.principal,
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
): TransportRequestContext {
  return Object.freeze({
    ...context,
    [authenticatedPrincipal]: immutablePrincipal(principal),
  });
}

/** Construct a Hono app without binding a listener or adding feature behavior. */
export function createHttpApp(options: HttpAppOptions = {}): Hono {
  const registry = options.registry ?? publicOperationRegistry;
  const handlers = options.handlers ?? {};
  const errorRegistry = options.errorRegistry ?? httpErrorRegistry;
  const adapter = createRegistryTransportAdapter({
    registry,
    handlers,
    errorRegistry,
    logger: options.logger,
    authenticate: options.authenticate,
  });
  const app = new Hono();

  for (const operation of registry.operations) {
    app.all(operationRouteToHonoRoute(operation.route), async (context) => {
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
        errorRegistry,
        maxRequestBodyBytes: options.maxRequestBodyBytes,
        correlationId,
      });
      if (admission.kind === "rejected") return context.json(admission.body, admission.status);
      const result = await adapter.execute(
        operation.key,
        admission.input,
        authenticatedTransportContext(
          { request, correlationId, params, query },
          admission.principal,
        ),
      );
      return context.json(result.body, result.status);
    });
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
