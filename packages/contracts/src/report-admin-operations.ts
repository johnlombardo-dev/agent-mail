import { z } from "zod";
import {
  defineOperation,
  type OperationDefinition,
  type OperationSchema,
} from "./operation-registry";

const SHA256 = /^[a-f0-9]{64}$/u;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)))
      return true;
  }
  return false;
}

function text(name: string, maximum: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, `${name} must be trimmed`)
    .refine((value) => !hasControlCharacters(value), `${name} has control characters`);
}

function namespacedId(namespace: string, maximum = 256): z.ZodString {
  return text(`${namespace} ID`, maximum).regex(
    new RegExp(`^${namespace}:[^\\s:][^\\u0000-\\u001f\\u007f-\\u009f]*$`, "u"),
    `${namespace} ID has the wrong namespace`,
  );
}

const nonNegativeIntegerSchema = z.number().int().safe().nonnegative();

/** Public identifiers are namespaced so report and admin payloads cannot mix identities. */
export const reportAdminMessageIdSchema = namespacedId("message");
export const reportAdminReportIdSchema = namespacedId("report");
export const reportAdminBackupIdSchema = namespacedId("backup");
export const reportAdminManifestIdSchema = namespacedId("manifest");
export const reportAdminRequestIdSchema = namespacedId("request");

export const reportAdminInstantSchema = text("instant", 40).refine((value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}, "instant must be a canonical millisecond UTC timestamp");

export const reportAdminDigestSchema = z
  .string()
  .regex(SHA256, "digest must be a lowercase SHA-256 hexadecimal value");

/** Authorization is returned as provenance; credentials and bearer values never cross this schema. */
export const reportAdminAuthorizationProvenanceSchema = z.strictObject({
  principal: text("authorization principal", 256),
  scope: text("authorization scope", 256),
  method: z.enum(["bearer", "trusted-proxy", "local-cli"]),
  requestId: reportAdminRequestIdSchema,
  authorizedAt: reportAdminInstantSchema,
});
export type ReportAdminAuthorizationProvenance = z.infer<
  typeof reportAdminAuthorizationProvenanceSchema
>;

/** A citation names the immutable message identity, never a subject, UID, or list position. */
export const reportAdminSourceCitationSchema = z.strictObject({
  id: reportAdminMessageIdSchema,
  label: text("citation label", 256),
});
export type ReportAdminSourceCitation = z.infer<typeof reportAdminSourceCitationSchema>;

const uniqueReportAdminCitationsSchema = z
  .array(reportAdminSourceCitationSchema)
  .min(1)
  .superRefine((citations, context) => {
    const messageIds = new Set<string>();
    citations.forEach((citation, index) => {
      if (messageIds.has(citation.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "report citations must have unique message identities",
        });
      }
      messageIds.add(citation.id);
    });
  });

const uniqueMessageIdsSchema = z
  .array(reportAdminMessageIdSchema)
  .min(1)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "message identities must be unique" });
    }
  });

/** A report request declares at least one source; rendered HTML is intentionally out of scope. */
export const reportAdminReportRequestSchema = z.strictObject({
  title: text("report title", 998),
  sourceMessageIds: uniqueMessageIdsSchema,
  metadata: z.record(text("metadata key", 128), text("metadata value", 16_384)).default({}),
});
export type ReportAdminReportRequest = z.infer<typeof reportAdminReportRequestSchema>;

export const reportAdminReportResponseSchema = z.strictObject({
  reportId: reportAdminReportIdSchema,
  title: text("report title", 998),
  citations: uniqueReportAdminCitationsSchema,
  authorization: reportAdminAuthorizationProvenanceSchema,
  createdAt: reportAdminInstantSchema,
});
export type ReportAdminReportResponse = z.infer<typeof reportAdminReportResponseSchema>;

const reportAdminQuerySelectionSchema = z.strictObject({
  kind: z.literal("query"),
  query: text("export query", 2_048),
});
const reportAdminIdentitySelectionSchema = z.strictObject({
  kind: z.literal("identities"),
  messageIds: uniqueMessageIdsSchema,
});
export const reportAdminExportSelectionSchema = z.discriminatedUnion("kind", [
  reportAdminQuerySelectionSchema,
  reportAdminIdentitySelectionSchema,
]);
export type ReportAdminExportSelection = z.infer<typeof reportAdminExportSelectionSchema>;

export const reportAdminExportRequestSchema = z.strictObject({
  selection: reportAdminExportSelectionSchema,
});
export type ReportAdminExportRequest = z.infer<typeof reportAdminExportRequestSchema>;

/** Attribution is explicit on every record so action history cannot be silently reassigned. */
export const reportAdminExportAttributionSchema = z.strictObject({
  sourceMessageId: reportAdminMessageIdSchema,
  source: z.literal("message"),
  occurrence: text("attribution occurrence", 256).nullable(),
});
export type ReportAdminExportAttribution = z.infer<typeof reportAdminExportAttributionSchema>;

const reportAdminExportActionSchema = z.strictObject({
  actionId: namespacedId("action"),
  occurredAt: reportAdminInstantSchema,
});

const uniqueReportAdminExportActionsSchema = z
  .array(reportAdminExportActionSchema)
  .superRefine((actions, context) => {
    const actionIds = new Set<string>();
    actions.forEach((action, index) => {
      if (actionIds.has(action.actionId)) {
        context.addIssue({
          code: "custom",
          path: [index, "actionId"],
          message: "export action history identities must be unique",
        });
      }
      actionIds.add(action.actionId);
    });
  });

export const reportAdminExportRecordSchema = z
  .strictObject({
    version: z.literal(1),
    messageId: reportAdminMessageIdSchema,
    attribution: reportAdminExportAttributionSchema,
    actionHistory: uniqueReportAdminExportActionsSchema,
    contentDigest: reportAdminDigestSchema,
  })
  .superRefine((record, context) => {
    if (record.messageId !== record.attribution.sourceMessageId) {
      context.addIssue({
        code: "custom",
        path: ["attribution", "sourceMessageId"],
        message: "attribution must name the exported message",
      });
    }
  });
export type ReportAdminExportRecord = z.infer<typeof reportAdminExportRecordSchema>;

export const reportAdminExportResponseSchema = z.strictObject({
  version: z.literal(1),
  contentType: z.literal("application/x-ndjson"),
  recordVersion: z.literal(1),
  selectedCount: nonNegativeIntegerSchema,
});
export type ReportAdminExportResponse = z.infer<typeof reportAdminExportResponseSchema>;

/** A manifest identity is supplied by the caller; restore never chooses the newest backup. */
export const reportAdminManifestIdentitySchema = z.strictObject({
  manifestId: reportAdminManifestIdSchema,
  digest: reportAdminDigestSchema,
});
export type ReportAdminManifestIdentity = z.infer<typeof reportAdminManifestIdentitySchema>;

export const reportAdminAbsoluteTargetSchema = text("absolute target", 4_096)
  .regex(/^\/(?!\/).*$/u, "target must be absolute")
  .refine(
    (value) => !/(?:^|\/)\.{1,2}(?:\/|$)/u.test(value),
    "target must not contain dot segments",
  )
  .refine((value) => !value.endsWith("/"), "target must be exact and not a directory prefix");

export const reportAdminConfirmationNonceSchema = text("confirmation nonce", 512).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{15,511}$/u,
  "confirmation nonce must be an explicit opaque value",
);

export const reportAdminBackupRequestSchema = z.strictObject({
  destination: reportAdminAbsoluteTargetSchema,
});
export type ReportAdminBackupRequest = z.infer<typeof reportAdminBackupRequestSchema>;

export const reportAdminBackupResponseSchema = z.strictObject({
  backupId: reportAdminBackupIdSchema,
  manifest: reportAdminManifestIdentitySchema,
  destination: reportAdminAbsoluteTargetSchema,
  createdAt: reportAdminInstantSchema,
  bytes: nonNegativeIntegerSchema,
});
export type ReportAdminBackupResponse = z.infer<typeof reportAdminBackupResponseSchema>;

export const reportAdminRestoreRequestSchema = z.strictObject({
  target: reportAdminAbsoluteTargetSchema,
  manifest: reportAdminManifestIdentitySchema,
  confirmationNonce: reportAdminConfirmationNonceSchema,
  offline: z.literal(true),
});
export type ReportAdminRestoreRequest = z.infer<typeof reportAdminRestoreRequestSchema>;

export const reportAdminRestoreResponseSchema = z.strictObject({
  restored: z.literal(true),
  target: reportAdminAbsoluteTargetSchema,
  manifest: reportAdminManifestIdentitySchema,
  completedAt: reportAdminInstantSchema,
});
export type ReportAdminRestoreResponse = z.infer<typeof reportAdminRestoreResponseSchema>;

export const reportAdminDoctorRequestSchema = z.strictObject({});

export const reportAdminDoctorCheckSchema = z.strictObject({
  id: text("doctor check ID", 128),
  status: z.enum(["pass", "warn", "fail"]),
  summary: text("doctor check summary", 2_048),
});
export type ReportAdminDoctorCheck = z.infer<typeof reportAdminDoctorCheckSchema>;

export const reportAdminDoctorIssueSchema = z.strictObject({
  code: text("doctor issue code", 128),
  detail: text("doctor issue detail", 2_048),
});

export const reportAdminDoctorResponseSchema = z
  .strictObject({
    status: z.enum(["healthy", "degraded", "unhealthy"]),
    checks: z.array(reportAdminDoctorCheckSchema),
    issues: z.array(reportAdminDoctorIssueSchema),
  })
  .superRefine((response, context) => {
    if (response.status === "healthy" && response.issues.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["issues"],
        message: "healthy doctor output has issues",
      });
    }
    if (response.status !== "healthy" && response.issues.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["issues"],
        message: "unhealthy doctor output needs diagnoses",
      });
    }
  });
export type ReportAdminDoctorResponse = z.infer<typeof reportAdminDoctorResponseSchema>;

export const reportAdminReindexRequestSchema = z.strictObject({
  scope: z.enum(["all", "messages", "attachments"]),
  operationIntent: text("operation intent", 2_048),
});
export type ReportAdminReindexRequest = z.infer<typeof reportAdminReindexRequestSchema>;

export const reportAdminReindexResponseSchema = z.strictObject({
  accepted: z.literal(true),
  scope: z.enum(["all", "messages", "attachments"]),
  startedAt: reportAdminInstantSchema,
  indexed: nonNegativeIntegerSchema,
  expected: nonNegativeIntegerSchema,
});
export type ReportAdminReindexResponse = z.infer<typeof reportAdminReindexResponseSchema>;

const operationDefaults = {
  streaming: "none" as const,
  strictness: "strict" as const,
};

export const reportAdminReportOperation = defineOperation({
  key: "reports.create",
  route: "/v1/reports",
  cliName: "reports-create",
  scope: "reports:write",
  request: reportAdminReportRequestSchema,
  response: reportAdminReportResponseSchema,
  ...operationDefaults,
});

export const reportAdminExportOperation = defineOperation({
  key: "exports.selected",
  route: "/v1/exports",
  cliName: "exports-selected",
  scope: "mail:export.selected",
  request: reportAdminExportRequestSchema,
  response: reportAdminExportResponseSchema,
  streaming: "ndjson",
  strictness: "strict",
});

export const reportAdminBackupOperation = defineOperation({
  key: "admin.backup",
  route: "/v1/admin/backup",
  cliName: "admin-backup",
  scope: "admin:backup",
  request: reportAdminBackupRequestSchema,
  response: reportAdminBackupResponseSchema,
  ...operationDefaults,
});

export const reportAdminRestoreOperation = defineOperation({
  key: "admin.restore",
  route: "/v1/admin/restore",
  cliName: "admin-restore",
  scope: "admin:restore",
  request: reportAdminRestoreRequestSchema,
  response: reportAdminRestoreResponseSchema,
  ...operationDefaults,
});

export const reportAdminDoctorOperation = defineOperation({
  key: "admin.doctor",
  route: "/v1/admin/doctor",
  cliName: "admin-doctor",
  scope: "admin:doctor",
  request: reportAdminDoctorRequestSchema,
  response: reportAdminDoctorResponseSchema,
  ...operationDefaults,
});

export const reportAdminReindexOperation = defineOperation({
  key: "admin.reindex",
  route: "/v1/admin/reindex",
  cliName: "admin-reindex",
  scope: "admin:reindex",
  request: reportAdminReindexRequestSchema,
  response: reportAdminReindexResponseSchema,
  ...operationDefaults,
});

export const reportAdminOperationDefinitions = [
  reportAdminReportOperation,
  reportAdminExportOperation,
  reportAdminBackupOperation,
  reportAdminRestoreOperation,
  reportAdminDoctorOperation,
  reportAdminReindexOperation,
] as const satisfies readonly OperationDefinition<OperationSchema, OperationSchema>[];

export const reportAdminOperations = reportAdminOperationDefinitions;
