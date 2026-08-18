import {
  actionPlanApproveRequestSchema,
  actionPlanApproveResponseSchema,
  actionPlanCancelApprovalRequestSchema,
  actionPlanCancelApprovalResponseSchema,
  actionPlanAuthorityCommitRequestSchema,
  actionPlanAuthorityCommitResponseSchema,
  actionPlanCreateRequestSchema,
  actionPlanInspectRequestSchema,
  actionPlanInspectResponseSchema,
  actionPlanPreviewResponseSchema,
  type ActionPlanCreateRequest,
} from "@agent-mail/contracts";
import { z } from "zod";
import type {
  AuthenticatedRequestContext,
  HttpPrincipal,
  OperationHandler,
  OperationHandlerContext,
  OperationHandlerMap,
} from "./http";
import { isTrustedAuthContext } from "./trusted-auth-context";

type ActionPlanInspectRequest = z.infer<typeof actionPlanInspectRequestSchema>;
type ActionPlanApproveRequest = z.infer<typeof actionPlanApproveRequestSchema>;
type ActionPlanCancelApprovalRequest = z.infer<typeof actionPlanCancelApprovalRequestSchema>;
type ActionPlanAuthorityCommitRequest = z.infer<typeof actionPlanAuthorityCommitRequestSchema>;
type ActionPlanPreviewResponse = z.infer<typeof actionPlanPreviewResponseSchema>;
type ActionPlanInspectResponse = z.infer<typeof actionPlanInspectResponseSchema>;
type ActionPlanApproveResponse = z.infer<typeof actionPlanApproveResponseSchema>;
type ActionPlanCancelApprovalResponse = z.infer<typeof actionPlanCancelApprovalResponseSchema>;
type ActionPlanAuthorityCommitResponse = z.infer<typeof actionPlanAuthorityCommitResponseSchema>;

/** The authority context forwarded to a plan service after HTTP auth succeeds. */
export type ActionPlanServiceContext = Readonly<{
  readonly correlationId: string;
  readonly operationKey: string;
  readonly scope: string | null;
  readonly principal: HttpPrincipal;
  readonly authContext: AuthenticatedRequestContext;
  readonly requestBodySha256?: string;
}>;

/** A service may report a private durable failure without fabricating a result. */
export type ActionPlanServiceFailure = Readonly<{
  readonly kind: "failure";
  readonly reason: string;
  readonly provenance?: unknown;
}>;

/** A service may decline a plan transition while retaining its private reason. */
export type ActionPlanServiceBlocked = Readonly<{
  readonly kind: "blocked";
  readonly reason: string;
  readonly provenance?: unknown;
}>;

export type ActionPlanServiceOutcome<TResponse> =
  | Readonly<{ readonly kind: "success"; readonly value: TResponse }>
  | ActionPlanServiceFailure
  | ActionPlanServiceBlocked;

export type ActionPlanServiceResult<TResponse> =
  | TResponse
  | ActionPlanServiceOutcome<TResponse>
  | Promise<TResponse | ActionPlanServiceOutcome<TResponse>>;

export type ActionPlanService<TRequest, TResponse> = (
  request: TRequest,
  context: ActionPlanServiceContext,
) => ActionPlanServiceResult<TResponse>;

/**
 * The only service capability the public action routes can receive.
 * In particular, commit accepts a plan service rather than a remote adapter
 * or an arbitrary target executor.
 */
export type ActionPlanServices = Readonly<{
  readonly createPlan: ActionPlanService<ActionPlanCreateRequest, ActionPlanPreviewResponse>;
  readonly inspectPlan: ActionPlanService<ActionPlanInspectRequest, ActionPlanInspectResponse>;
  readonly approvePlan: ActionPlanService<ActionPlanApproveRequest, ActionPlanApproveResponse>;
  readonly cancelApproval: ActionPlanService<
    ActionPlanCancelApprovalRequest,
    ActionPlanCancelApprovalResponse
  >;
  readonly authorityCommitPlan: ActionPlanService<
    ActionPlanAuthorityCommitRequest,
    ActionPlanAuthorityCommitResponse
  >;
}>;

type ActionPlanServiceFailureOutcome = ActionPlanServiceFailure | ActionPlanServiceBlocked;
type ServiceSuccess = Readonly<{ readonly value: unknown }>;

/**
 * Thrown after a service reports a private failure. The HTTP transport maps
 * this to its stable internal error envelope and never exposes service or
 * storage details.
 */
export class ActionPlanServiceOutcomeError extends Error {
  readonly kind: ActionPlanServiceFailureOutcome["kind"];
  readonly reason: string;
  readonly provenance: unknown;

  constructor(outcome: ActionPlanServiceFailureOutcome) {
    super("action-plan service did not complete the requested operation");
    this.name = "ActionPlanServiceOutcomeError";
    this.kind = outcome.kind;
    this.reason = outcome.reason;
    this.provenance = outcome.provenance;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serviceFailure(value: unknown): ActionPlanServiceFailureOutcome | undefined {
  if (!isRecord(value) || (value.kind !== "failure" && value.kind !== "blocked")) return undefined;
  if (typeof value.reason !== "string" || value.reason.length === 0) {
    throw new TypeError("action-plan service outcome has no reason");
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

function serviceContext(context: OperationHandlerContext): ActionPlanServiceContext {
  if (context.authContext === undefined)
    throw new TypeError("action operation requires trusted authenticated context");
  if (!isTrustedAuthContext(context.authContext))
    throw new TypeError("action operation requires authenticator provenance");
  const auth = context.authContext;
  const has = (scope: string) => auth.scopes.includes(scope);
  if (
    (context.operation.key === "action-plans.create" ||
      context.operation.key === "action-plans.inspect") &&
    !has("mail:action.create") &&
    !has("mail:action.inspect")
  )
    throw new TypeError("action create/inspect requires a trusted action profile");
  if (
    (context.operation.key === "action-plans.approve" ||
      context.operation.key === "action-plans.cancel-approval") &&
    (auth.profile !== "operator-interactive" ||
      auth.presence.kind !== "human-present" ||
      !has("mail:action.approve"))
  )
    throw new TypeError("action approval requires fresh trusted operator presence");
  if (
    context.operation.key === "action-plans.commit" &&
    (auth.profile !== "agent-unattended" ||
      auth.presence.kind !== "unattended" ||
      !has("mail:action.commit"))
  )
    throw new TypeError("action commit requires trusted unattended authority");
  return Object.freeze({
    correlationId: context.correlationId,
    operationKey: context.operation.key,
    scope: context.operation.scope,
    principal: context.principal,
    authContext: context.authContext,
    requestBodySha256: context.requestBodySha256,
  });
}

async function invokeService<TRequest, TResponse>(
  input: unknown,
  context: ActionPlanServiceContext,
  requestSchema: z.ZodType<TRequest>,
  responseSchema: z.ZodType<TResponse>,
  service: ActionPlanService<TRequest, TResponse>,
): Promise<TResponse> {
  // This parse protects direct handler use. The shared HTTP adapter performs
  // the ingress parse before a handler is invoked.
  const request = requestSchema.parse(input);
  const result: unknown = await service(request, context);
  const failure = serviceFailure(result);
  if (failure !== undefined) throw new ActionPlanServiceOutcomeError(failure);

  const unwrapped = serviceSuccess(result);
  const candidate = unwrapped === undefined ? result : unwrapped.value;
  return responseSchema.parse(candidate);
}

function handlerFor<TRequest, TResponse>(
  requestSchema: z.ZodType<TRequest>,
  responseSchema: z.ZodType<TResponse>,
  service: ActionPlanService<TRequest, TResponse>,
): OperationHandler {
  return (input: unknown, context: OperationHandlerContext) =>
    invokeService(input, serviceContext(context), requestSchema, responseSchema, service);
}

/** Create handlers for the authority-aware public action-plan lifecycle operations. */
export function createActionPlanHandlers(services: ActionPlanServices): OperationHandlerMap {
  return Object.freeze({
    "action-plans.create": handlerFor(
      actionPlanCreateRequestSchema,
      actionPlanPreviewResponseSchema,
      services.createPlan,
    ),
    "action-plans.inspect": handlerFor(
      actionPlanInspectRequestSchema,
      actionPlanInspectResponseSchema,
      services.inspectPlan,
    ),
    "action-plans.approve": handlerFor(
      actionPlanApproveRequestSchema,
      actionPlanApproveResponseSchema,
      services.approvePlan,
    ),
    "action-plans.cancel-approval": handlerFor(
      actionPlanCancelApprovalRequestSchema,
      actionPlanCancelApprovalResponseSchema,
      services.cancelApproval,
    ),
    "action-plans.commit": handlerFor(
      actionPlanAuthorityCommitRequestSchema,
      actionPlanAuthorityCommitResponseSchema,
      services.authorityCommitPlan,
    ),
  });
}

/** Compatibility alias for callers that describe this as an adapter. */
export const createActionPlanHandlerAdapter = createActionPlanHandlers;
