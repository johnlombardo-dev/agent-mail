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

const emptyDetailsSchema = z.strictObject({});

/** The public errors produced by the transport before a feature handler runs. */
export const httpErrorRegistry = createErrorRegistry([
  defineError({ code: "invalid_request", details: emptyDetailsSchema }),
  defineError({ code: "missing_credentials", details: emptyDetailsSchema }),
  defineError({ code: "invalid_credentials", details: emptyDetailsSchema }),
  defineError({ code: "expired_credentials", details: emptyDetailsSchema }),
  defineError({ code: "insufficient_scope", details: emptyDetailsSchema }),
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
  readonly status: 200 | 400 | 401 | 403 | 404 | 415 | 500;
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
}>;

type JsonObject = Readonly<Record<string, unknown>>;

class InvalidHttpRequestError extends Error {
  readonly status: 400 | 415;

  constructor(message: string, status: 400 | 415) {
    super(message);
    this.name = "InvalidHttpRequestError";
    this.status = status;
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
  | "missing_credentials"
  | "invalid_credentials"
  | "expired_credentials"
  | "insufficient_scope"
  | "not_found"
  | "internal_error";

function errorStatus(body: unknown): 200 | 400 | 401 | 403 | 404 | 500 {
  const result = publicErrorEnvelopeSchema.safeParse(body);
  if (!result.success) return 200;
  switch (result.data.code) {
    case "invalid_request":
      return 400;
    case "missing_credentials":
    case "invalid_credentials":
    case "expired_credentials":
      return 401;
    case "insufficient_scope":
      return 403;
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

function correlationIdFrom(request: Request): string {
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
  request: Request,
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
  request: Request,
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
      } catch {
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

function contentTypeIsJson(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function requestMayHaveBody(request: Request): boolean {
  const method = request.method.toUpperCase();
  return (
    request.headers.get("content-length") !== null || ["POST", "PUT", "PATCH"].includes(method)
  );
}

async function readUnknownRequestInput(
  request: Request,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, string>>,
): Promise<unknown> {
  let body: unknown = {};
  if (requestMayHaveBody(request)) {
    if (!contentTypeIsJson(request))
      throw new InvalidHttpRequestError("request content type must be JSON", 415);
    try {
      body = await request.clone().json();
    } catch {
      throw new InvalidHttpRequestError("request body is malformed JSON", 400);
    }
  }
  if (!isJsonObject(body)) return body;
  return { ...body, ...query, ...params };
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
      const authentication = await authenticateRequest(request, options.authenticate);
      if (authentication.kind === "denied") {
        return context.json(
          publicError(
            authentication.code,
            "request credentials are not authorized",
            correlationId,
            errorRegistry,
          ),
          authentication.code === "missing_credentials" ||
            authentication.code === "invalid_credentials" ||
            authentication.code === "expired_credentials"
            ? 401
            : 403,
        );
      }
      let input: unknown;
      try {
        input = await readUnknownRequestInput(request, params, query);
      } catch (error: unknown) {
        const status = error instanceof InvalidHttpRequestError ? error.status : 400;
        return context.json(
          publicError("invalid_request", "request is invalid", correlationId, errorRegistry),
          status,
        );
      }
      const result = await adapter.execute(operation.key, input, {
        request,
        correlationId,
        params,
        query,
        [authenticatedPrincipal]: authentication.principal,
      });
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
