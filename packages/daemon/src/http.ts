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
}>;

export type OperationHandler = (input: unknown, context: OperationHandlerContext) => unknown;

export type OperationHandlerMap = Readonly<Record<string, OperationHandler>>;

export type PrivateHttpLogEntry = Readonly<{
  readonly kind: "handler-error" | "invalid-handler-output";
  readonly operationKey: string;
  readonly correlationId: string;
}>;

export type PrivateHttpLogger = (entry: PrivateHttpLogEntry) => void;

export type TransportRequestContext = Readonly<{
  readonly request: Request;
  readonly correlationId: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}>;

export type TransportResult = Readonly<{
  readonly status: 200 | 400 | 404 | 415 | 500;
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
}>;

export type HttpAppOptions = Readonly<{
  readonly registry?: OperationRegistry;
  readonly handlers?: OperationHandlerMap;
  readonly errorRegistry?: ErrorRegistry;
  readonly logger?: PrivateHttpLogger;
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

function errorStatus(body: unknown): 200 | 404 | 500 {
  const result = publicErrorEnvelopeSchema.safeParse(body);
  if (!result.success) return 200;
  return result.data.code === "not_found" ? 404 : 500;
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
  code: "invalid_request" | "not_found" | "internal_error",
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
  });
  const app = new Hono();

  for (const operation of registry.operations) {
    app.all(operationRouteToHonoRoute(operation.route), async (context) => {
      const request = context.req.raw;
      const correlationId = correlationIdFrom(request);
      const params: Readonly<Record<string, string>> = { ...context.req.param() };
      const query: Readonly<Record<string, string>> = { ...context.req.query() };
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
