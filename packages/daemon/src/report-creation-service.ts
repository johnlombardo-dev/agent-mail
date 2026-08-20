import { createHash } from "node:crypto";
import {
  REPORT_CONTENT_SECURITY_POLICY,
  renderReport,
  reportAdminReportRequestSchema,
  reportAdminReportResponseSchema,
  type ReportAdminReportRequest,
  type ReportAdminReportResponse,
  type ReportModel,
} from "@agent-mail/contracts";
import { parseAccountId, type AccountId } from "@agent-mail/core";
import {
  REPORT_HTML_LIMIT_BYTES,
  REPORT_MARKDOWN_LIMIT_BYTES,
  REPORT_MAX_CHARGED_BYTES,
  REPORT_MAX_COUNT,
  REPORT_MODEL_LIMIT_BYTES,
  REPORT_SOURCE_JSON_TOTAL_BYTES,
  REPORT_SOURCE_TOTAL_BYTES,
  ReportCreationRepository,
  ReportRepositoryError,
  canonicalJsonBytes,
  createReportIdentity,
  type ReportSourceEvidence,
} from "../../storage/src/report-creation-repository";
import type { ReportAdminService, ReportAdminServiceContext } from "./report-admin-handlers";
import { RegisteredFeatureErrorException } from "./http";

export type ReportCreationServiceOptions = Readonly<{
  readonly repository: ReportCreationRepository;
  readonly accountId: AccountId;
  readonly now?: () => Date;
}>;

const SOURCE_READ_SCOPE = "mail:read.message";

function registeredError(
  code: "insufficient_scope" | "not_found" | "request_too_large" | "internal_error",
  message: string,
): never {
  throw new RegisteredFeatureErrorException({ code, message, details: {} });
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    registeredError("internal_error", "internal server error");
  return value.toISOString();
}

function excerpt(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= 4_096) return text;
  let result = "";
  let used = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (used + characterBytes > 4_093) break;
    result += character;
    used += characterBytes;
  }
  return `${result}…`;
}

function reportModel(title: string, sources: readonly ReportSourceEvidence[]): ReportModel {
  const claims = sources.map((source, index) => ({
    text: excerpt(source.text),
    citations: [{ id: source.messageId, label: `Source ${index + 1}` }],
  }));
  return {
    title,
    summary:
      sources.length === 1
        ? "Evidence report with 1 text-only source."
        : `Evidence report with ${sources.length} text-only sources.`,
    sections: [{ heading: "Source evidence", claims }],
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedPublication(
  model: ReportModel,
  sources: readonly ReportSourceEvidence[],
): Readonly<{
  readonly model: ReportModel;
  readonly modelJson: Uint8Array;
  readonly modelSha256: string;
  readonly markdownSha256: string;
  readonly htmlSha256: string;
  readonly cspSha256: string;
  readonly modelBytes: number;
  readonly markdownBytes: number;
  readonly htmlBytes: number;
}> {
  const sourceBytes = sources.reduce((total, source) => total + source.sourceTextBytes, 0);
  const sourceJsonBytes = sources.reduce(
    (total, source) => total + source.sourceTextJson.byteLength,
    0,
  );
  if (sourceBytes > REPORT_SOURCE_TOTAL_BYTES || sourceJsonBytes > REPORT_SOURCE_JSON_TOTAL_BYTES)
    registeredError("request_too_large", "report request exceeds configured limit");
  const rendered = renderReport(model);
  if (rendered.contentSecurityPolicy !== REPORT_CONTENT_SECURITY_POLICY)
    registeredError("internal_error", "internal server error");
  const modelJson = canonicalJsonBytes(model);
  const markdownBytes = Buffer.byteLength(rendered.markdown, "utf8");
  const htmlBytes = Buffer.byteLength(rendered.html, "utf8");
  if (
    modelJson.byteLength < 1 ||
    modelJson.byteLength > REPORT_MODEL_LIMIT_BYTES ||
    markdownBytes < 1 ||
    markdownBytes > REPORT_MARKDOWN_LIMIT_BYTES ||
    htmlBytes < 1 ||
    htmlBytes > REPORT_HTML_LIMIT_BYTES
  )
    registeredError("request_too_large", "report request exceeds configured limit");
  return {
    model,
    modelJson,
    modelSha256: sha256(modelJson),
    markdownSha256: sha256(Buffer.from(rendered.markdown, "utf8")),
    htmlSha256: sha256(Buffer.from(rendered.html, "utf8")),
    cspSha256: sha256(Buffer.from(rendered.contentSecurityPolicy, "utf8")),
    modelBytes: modelJson.byteLength,
    markdownBytes,
    htmlBytes,
  };
}

function mapRepositoryError(error: ReportRepositoryError): never {
  switch (error.code) {
    case "capacity":
      registeredError(
        "request_too_large",
        error.message === "report request exceeds configured limit"
          ? "report request exceeds configured limit"
          : "report capacity is exhausted",
      );
    case "source-not-found":
      registeredError("not_found", "report source was not found");
    case "invalid":
      registeredError("request_too_large", "report request exceeds configured limit");
    case "busy":
    case "corrupt":
    case "storage":
      registeredError("internal_error", "internal server error");
    default: {
      const exhaustive: never = error.code;
      return exhaustive;
    }
  }
}

function isReportRepositoryError(error: unknown): error is ReportRepositoryError {
  return error instanceof ReportRepositoryError;
}

function requestBodyDigest(context: ReportAdminServiceContext): string {
  const value = context.requestBodySha256;
  if (value === undefined || !/^[a-f0-9]{64}$/u.test(value))
    registeredError("internal_error", "internal server error");
  return value;
}

/** Concrete reports.create service. All source reads happen after scope/rate admission. */
export function createReportCreationService(
  options: ReportCreationServiceOptions,
): ReportAdminService<ReportAdminReportRequest, ReportAdminReportResponse> {
  const accountId = parseAccountId(options.accountId);
  if (options.repository.accountId !== accountId)
    throw new TypeError("report repository account does not match service account");
  const now = options.now ?? (() => new Date());
  const flights = new Map<string, Promise<ReportAdminReportResponse>>();
  return async (request, context): Promise<ReportAdminReportResponse> => {
    if (!context.scopes.includes("reports:write"))
      registeredError("insufficient_scope", "request credentials are not authorized");
    const parsed = reportAdminReportRequestSchema.parse(request);
    let identity: ReturnType<typeof createReportIdentity>;
    try {
      identity = createReportIdentity(parsed, accountId, context.principal.subject);
    } catch (error: unknown) {
      if (isReportRepositoryError(error)) mapRepositoryError(error);
      registeredError("request_too_large", "report request exceeds configured limit");
    }

    const existingFlight = flights.get(identity.reportId);
    if (existingFlight !== undefined) return existingFlight;
    const run = (async (): Promise<ReportAdminReportResponse> => {
      try {
        const replay = options.repository.findReplay(identity);
        if (replay !== undefined) return reportAdminReportResponseSchema.parse(replay);
        const bodyDigest = requestBodyDigest(context);
        const admissionNow = canonicalNow(now);
        if (!options.repository.admitRate(identity.principalJson, admissionNow))
          registeredError("request_too_large", "report capacity is exhausted");
        const capacity = options.repository.accountCapacity();
        if (capacity.count >= REPORT_MAX_COUNT || capacity.logicalCharge > REPORT_MAX_CHARGED_BYTES)
          registeredError("request_too_large", "report capacity is exhausted");
        if (!context.scopes.includes(SOURCE_READ_SCOPE))
          registeredError("insufficient_scope", "request credentials are not authorized");
        const sources: ReportSourceEvidence[] = [];
        for (const sourceMessageId of identity.sourceMessageIds) {
          const source = await options.repository.resolveSourceEvidence(sourceMessageId);
          if (source === undefined) registeredError("not_found", "report source was not found");
          sources.push(source);
        }
        const model = reportModel(identity.title, sources);
        const bounded = boundedPublication(model, sources);
        const timestamp = admissionNow;
        return reportAdminReportResponseSchema.parse(
          options.repository.publish({
            identity,
            model,
            modelJson: bounded.modelJson,
            modelSha256: bounded.modelSha256,
            markdownSha256: bounded.markdownSha256,
            htmlSha256: bounded.htmlSha256,
            cspSha256: bounded.cspSha256,
            modelBytes: bounded.modelBytes,
            markdownBytes: bounded.markdownBytes,
            htmlBytes: bounded.htmlBytes,
            requestBodySha256: bodyDigest,
            authorizationAt: timestamp,
            createdAt: timestamp,
            sources,
          }),
        );
      } catch (error: unknown) {
        if (error instanceof RegisteredFeatureErrorException) throw error;
        if (isReportRepositoryError(error)) mapRepositoryError(error);
        registeredError("internal_error", "internal server error");
      }
    })();
    flights.set(identity.reportId, run);
    try {
      return await run;
    } finally {
      if (flights.get(identity.reportId) === run) flights.delete(identity.reportId);
    }
  };
}
