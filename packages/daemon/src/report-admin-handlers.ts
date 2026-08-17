import {
  reportAdminBackupRequestSchema,
  reportAdminBackupResponseSchema,
  reportAdminDoctorRequestSchema,
  reportAdminDoctorResponseSchema,
  reportAdminExportRequestSchema,
  reportAdminExportResponseSchema,
  reportAdminReindexRequestSchema,
  reportAdminReindexResponseSchema,
  reportAdminReportRequestSchema,
  reportAdminReportResponseSchema,
  reportAdminRestoreRequestSchema,
  reportAdminRestoreResponseSchema,
  type ReportAdminBackupRequest,
  type ReportAdminBackupResponse,
  type ReportAdminDoctorResponse,
  type ReportAdminExportRequest,
  type ReportAdminExportResponse,
  type ReportAdminReindexRequest,
  type ReportAdminReindexResponse,
  type ReportAdminReportRequest,
  type ReportAdminReportResponse,
  type ReportAdminRestoreRequest,
  type ReportAdminRestoreResponse,
} from "@agent-mail/contracts";
import { z } from "zod";
import type {
  HttpPrincipal,
  OperationHandler,
  OperationHandlerContext,
  OperationHandlerMap,
} from "./http";

/** The typed authority context forwarded to every report/admin service. */
export type ReportAdminServiceContext = Readonly<{
  readonly correlationId: string;
  readonly operationKey: string;
  readonly scope: string;
  readonly principal: HttpPrincipal;
}>;

/** A service may report a durable failure without making the adapter invent a response. */
export type ReportAdminServiceFailure = Readonly<{
  readonly kind: "failure";
  readonly reason: string;
  readonly provenance?: unknown;
}>;

/** A service may decline work while retaining the reason and its provenance. */
export type ReportAdminServiceBlocked = Readonly<{
  readonly kind: "blocked";
  readonly reason: string;
  readonly provenance?: unknown;
}>;

export type ReportAdminServiceOutcome<TResponse> =
  | Readonly<{ readonly kind: "success"; readonly value: TResponse }>
  | ReportAdminServiceFailure
  | ReportAdminServiceBlocked;

export type ReportAdminServiceResult<TResponse> =
  | TResponse
  | ReportAdminServiceOutcome<TResponse>
  | Promise<TResponse | ReportAdminServiceOutcome<TResponse>>;

export type ReportAdminService<TRequest, TResponse> = (
  request: TRequest,
  context: ReportAdminServiceContext,
) => ReportAdminServiceResult<TResponse>;

export type ReportAdminServices = Readonly<{
  readonly createReport: ReportAdminService<ReportAdminReportRequest, ReportAdminReportResponse>;
  readonly exportSelected: ReportAdminService<ReportAdminExportRequest, ReportAdminExportResponse>;
  readonly backup: ReportAdminService<ReportAdminBackupRequest, ReportAdminBackupResponse>;
  readonly restore: ReportAdminService<ReportAdminRestoreRequest, ReportAdminRestoreResponse>;
  readonly doctor: ReportAdminService<ReportAdminDoctorRequest, ReportAdminDoctorResponse>;
  readonly reindex: ReportAdminService<ReportAdminReindexRequest, ReportAdminReindexResponse>;
}>;

type ServiceFailureOutcome = ReportAdminServiceFailure | ReportAdminServiceBlocked;
type ReportAdminDoctorRequest = z.infer<typeof reportAdminDoctorRequestSchema>;
type ServiceSuccess = Readonly<{ readonly value: unknown }>;

/**
 * Thrown only after a service has returned a failure or blocked outcome. The
 * original result is kept intact for the owner of the adapter boundary; the
 * shared HTTP transport can therefore redact it rather than treating it as a
 * successful operation.
 */
export class ReportAdminServiceOutcomeError extends Error {
  readonly kind: ServiceFailureOutcome["kind"];
  readonly reason: string;
  readonly provenance: unknown;

  constructor(outcome: ServiceFailureOutcome) {
    super("report/admin service did not complete the requested operation");
    this.name = "ReportAdminServiceOutcomeError";
    this.kind = outcome.kind;
    this.reason = outcome.reason;
    this.provenance = outcome.provenance;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serviceContext(context: OperationHandlerContext): ReportAdminServiceContext {
  return Object.freeze({
    correlationId: context.correlationId,
    operationKey: context.operation.key,
    scope: context.operation.scope,
    principal: context.principal,
  });
}

function serviceFailure(value: unknown): ServiceFailureOutcome | undefined {
  if (!isRecord(value) || (value.kind !== "failure" && value.kind !== "blocked")) return undefined;
  if (typeof value.reason !== "string" || value.reason.length === 0) {
    throw new TypeError("report/admin service outcome has no reason");
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

async function invokeService<TRequest, TResponse>(
  request: TRequest,
  context: ReportAdminServiceContext,
  service: ReportAdminService<TRequest, TResponse>,
  responseSchema: z.ZodType<TResponse>,
): Promise<TResponse> {
  const result: unknown = await service(request, context);
  const failure = serviceFailure(result);
  if (failure !== undefined) throw new ReportAdminServiceOutcomeError(failure);

  const unwrapped = serviceSuccess(result);
  const candidate = unwrapped === undefined ? result : unwrapped.value;
  return responseSchema.parse(candidate);
}

function handlerFor<TRequest, TResponse>(
  requestSchema: z.ZodType<TRequest>,
  responseSchema: z.ZodType<TResponse>,
  service: ReportAdminService<TRequest, TResponse>,
): OperationHandler {
  return async (input: unknown, context: OperationHandlerContext): Promise<TResponse> => {
    // Keep this second parse for direct adapter callers. The shared transport
    // already validates it, but a handler must not trust an untyped caller.
    const request = requestSchema.parse(input);
    return invokeService(request, serviceContext(context), service, responseSchema);
  };
}

/**
 * Create handlers for the report/admin operations. Selected export returns
 * only truthful AMEX byte-stream metadata; its bytes are produced by the
 * selected-export streaming route.
 */
export function createReportAdminHandlers(services: ReportAdminServices): OperationHandlerMap {
  return Object.freeze({
    "reports.create": handlerFor(
      reportAdminReportRequestSchema,
      reportAdminReportResponseSchema,
      services.createReport,
    ),
    "exports.selected": handlerFor(
      reportAdminExportRequestSchema,
      reportAdminExportResponseSchema,
      services.exportSelected,
    ),
    "admin.backup": handlerFor(
      reportAdminBackupRequestSchema,
      reportAdminBackupResponseSchema,
      services.backup,
    ),
    "admin.restore": handlerFor(
      reportAdminRestoreRequestSchema,
      reportAdminRestoreResponseSchema,
      services.restore,
    ),
    "admin.doctor": handlerFor(
      reportAdminDoctorRequestSchema,
      reportAdminDoctorResponseSchema,
      services.doctor,
    ),
    "admin.reindex": handlerFor(
      reportAdminReindexRequestSchema,
      reportAdminReindexResponseSchema,
      services.reindex,
    ),
  });
}

/** Compatibility name for callers that refer to the module as an adapter. */
export const createReportAdminHandlerAdapter = createReportAdminHandlers;
