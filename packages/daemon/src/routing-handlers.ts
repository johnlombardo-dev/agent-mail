import {
  labelRequestSchema,
  labelResponseSchema,
  routingCommitRequestSchema,
  routingCommitResponseSchema,
  routingPreviewRequestSchema,
  routingPreviewResponseSchema,
  type LabelRequest,
  type RoutingCommitRequest,
  type RoutingPreviewRequest,
} from "@agent-mail/contracts";
import { z } from "zod";
import type {
  HttpPrincipal,
  OperationHandler,
  OperationHandlerContext,
  OperationHandlerMap,
} from "./http";

/** The typed authority context forwarded to every routing/label service. */
export type RoutingServiceContext = Readonly<{
  readonly correlationId: string;
  readonly operationKey: string;
  readonly scope: string | null;
  readonly principal: HttpPrincipal;
}>;

/** A service may report a durable failure without fabricating a response. */
export type RoutingServiceFailure = Readonly<{
  readonly kind: "failure";
  readonly reason: string;
  readonly provenance?: unknown;
}>;

/** A service may decline work while retaining its private reason. */
export type RoutingServiceBlocked = Readonly<{
  readonly kind: "blocked";
  readonly reason: string;
  readonly provenance?: unknown;
}>;

export type RoutingServiceOutcome<TResponse> =
  | Readonly<{ readonly kind: "success"; readonly value: TResponse }>
  | RoutingServiceFailure
  | RoutingServiceBlocked;

export type RoutingServiceResult<TResponse> =
  | TResponse
  | RoutingServiceOutcome<TResponse>
  | Promise<TResponse | RoutingServiceOutcome<TResponse>>;

export type RoutingService<TRequest, TResponse> = (
  request: TRequest,
  context: RoutingServiceContext,
) => RoutingServiceResult<TResponse>;

export type RoutingServices = Readonly<{
  readonly createPreview: RoutingService<RoutingPreviewRequest, RoutingPreviewResponse>;
  readonly commitPreview: RoutingService<RoutingCommitRequest, RoutingCommitResponse>;
  readonly assignLabel: RoutingService<LabelRequest, LabelResponse>;
}>;

type RoutingPreviewResponse = z.infer<typeof routingPreviewResponseSchema>;
type RoutingCommitResponse = z.infer<typeof routingCommitResponseSchema>;
type LabelResponse = z.infer<typeof labelResponseSchema>;

type RoutingServiceFailureOutcome = RoutingServiceFailure | RoutingServiceBlocked;
type ServiceSuccess = Readonly<{ readonly value: unknown }>;

/**
 * Thrown only after a routing service reports failure or blocked work. The
 * transport turns this into its stable internal error envelope and never
 * exposes service details or a fabricated committed response.
 */
export class RoutingServiceOutcomeError extends Error {
  readonly kind: RoutingServiceFailureOutcome["kind"];
  readonly reason: string;
  readonly provenance: unknown;

  constructor(outcome: RoutingServiceFailureOutcome) {
    super("routing service did not complete the requested operation");
    this.name = "RoutingServiceOutcomeError";
    this.kind = outcome.kind;
    this.reason = outcome.reason;
    this.provenance = outcome.provenance;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serviceFailure(value: unknown): RoutingServiceFailureOutcome | undefined {
  if (!isRecord(value) || (value.kind !== "failure" && value.kind !== "blocked")) return undefined;
  if (typeof value.reason !== "string" || value.reason.length === 0) {
    throw new TypeError("routing service outcome has no reason");
  }
  return {
    kind: value.kind,
    reason: value.reason,
    provenance: value.provenance,
  };
}

function serviceSuccess(value: unknown): ServiceSuccess | undefined {
  if (!isRecord(value) || value.kind !== "success" || !Object.hasOwn(value, "value")) {
    return undefined;
  }
  return { value: value.value };
}

function serviceContext(context: OperationHandlerContext): RoutingServiceContext {
  return Object.freeze({
    correlationId: context.correlationId,
    operationKey: context.operation.key,
    scope: context.operation.scope,
    principal: context.principal,
  });
}

async function invokeService<TRequest, TResponse>(
  input: unknown,
  context: RoutingServiceContext,
  requestSchema: { parse(value: unknown): TRequest },
  responseSchema: { parse(value: unknown): TResponse },
  service: RoutingService<TRequest, TResponse>,
): Promise<TResponse> {
  // Keep this parse for direct adapter callers. The shared transport also
  // parses the request, but an exported handler must not trust an untyped call.
  const request = requestSchema.parse(input);
  const result: unknown = await service(request, context);
  const failure = serviceFailure(result);
  if (failure !== undefined) throw new RoutingServiceOutcomeError(failure);

  const unwrapped = serviceSuccess(result);
  const candidate = unwrapped === undefined ? result : unwrapped.value;
  // Parsing after await is the commit boundary: a service cannot claim a
  // durable decision unless it returned the shared committed response shape.
  return responseSchema.parse(candidate);
}

function handlerFor<TRequest, TResponse>(
  requestSchema: { parse(value: unknown): TRequest },
  responseSchema: { parse(value: unknown): TResponse },
  service: RoutingService<TRequest, TResponse>,
): OperationHandler {
  return (input: unknown, context: OperationHandlerContext) =>
    invokeService(input, serviceContext(context), requestSchema, responseSchema, service);
}

/** Create the three routing and local-label handlers for the public registry. */
export function createRoutingHandlers(services: RoutingServices): OperationHandlerMap {
  return Object.freeze({
    "routing.preview": handlerFor(
      routingPreviewRequestSchema,
      routingPreviewResponseSchema,
      services.createPreview,
    ),
    "routing.commit": handlerFor(
      routingCommitRequestSchema,
      routingCommitResponseSchema,
      services.commitPreview,
    ),
    "messages.label": handlerFor(labelRequestSchema, labelResponseSchema, services.assignLabel),
  });
}

/** Compatibility name for callers that refer to the module as an adapter. */
export const createRoutingHandlerAdapter = createRoutingHandlers;
