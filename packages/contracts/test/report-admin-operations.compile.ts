import {
  reportAdminExportRequestSchema,
  reportAdminRestoreRequestSchema,
  reportAdminOperationDefinitions,
  type ReportAdminExportRequest,
  type ReportAdminRestoreRequest,
} from "../src/report-admin-operations";

const exportRequest: ReportAdminExportRequest = {
  selection: { kind: "identities", messageIds: ["message:message-1"] },
};
const restoreRequest: ReportAdminRestoreRequest = {
  target: "/private/var/agent-mail/restore-1",
  manifest: { manifestId: "manifest:backup-1", digest: "a".repeat(64) },
  confirmationNonce: "restore-confirmation-2026-08-18",
  offline: true,
};

reportAdminExportRequestSchema.parse(exportRequest);
reportAdminRestoreRequestSchema.parse(restoreRequest);
reportAdminOperationDefinitions satisfies readonly { key: string; request: unknown; response: unknown }[];

