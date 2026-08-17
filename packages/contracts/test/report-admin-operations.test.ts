import { describe, expect, it } from "bun:test";
import {
  reportAdminBackupOperation,
  reportAdminBackupRequestSchema,
  reportAdminBackupResponseSchema,
  reportAdminDoctorOperation,
  reportAdminDoctorRequestSchema,
  reportAdminDoctorResponseSchema,
  reportAdminExportOperation,
  reportAdminExportRecordSchema,
  reportAdminExportRequestSchema,
  reportAdminExportResponseSchema,
  reportAdminManifestIdentitySchema,
  reportAdminReindexOperation,
  reportAdminReindexRequestSchema,
  reportAdminReindexResponseSchema,
  reportAdminReportOperation,
  reportAdminReportRequestSchema,
  reportAdminReportResponseSchema,
  reportAdminRestoreOperation,
  reportAdminRestoreRequestSchema,
  reportAdminRestoreResponseSchema,
  reportAdminSourceCitationSchema,
  reportAdminOperationDefinitions,
  type ReportAdminAuthorizationProvenance,
} from "../src/report-admin-operations";

const authorization = {
  principal: "operator:john",
  scope: "reports:write",
  method: "local-cli",
  requestId: "request:request-1",
  authorizedAt: "2026-08-18T00:00:00.000Z",
} satisfies ReportAdminAuthorizationProvenance;

const manifest = {
  manifestId: "manifest:backup-1",
  digest: "a".repeat(64),
};

describe("report and admin operation contracts", () => {
  it("accepts only canonical millisecond UTC instants", () => {
    expect(reportAdminReportResponseSchema.safeParse({
      reportId: "report:report-1",
      title: "Weekly review",
      citations: [{ id: "message:message-1", label: "source" }],
      authorization,
      createdAt: "2026-08-18T00:00:01.000Z",
    }).success).toBe(true);

    for (const instant of [
      "2026-08-18T00:00:01Z",
      "2026-08-18T00:00:01.00Z",
      "2026-08-18T00:00:01.0000Z",
      "2026-08-18T00:00:01.000+00:00",
      "2026-08-18T00:00:01.000-04:00",
      "2026-02-30T00:00:01.000Z",
    ]) {
      expect(reportAdminReportResponseSchema.safeParse({
        reportId: "report:report-1",
        title: "Weekly review",
        citations: [{ id: "message:message-1", label: "source" }],
        authorization,
        createdAt: instant,
      }).success).toBe(false);
    }
  });

  it("round-trips a cited report with authorization provenance", () => {
    const request = {
      title: "Weekly review",
      sourceMessageIds: ["message:message-1"],
      metadata: { audience: "operator" },
    };
    expect(reportAdminReportRequestSchema.parse(request)).toEqual(request);

    const response = {
      reportId: "report:report-1",
      title: request.title,
      citations: [{ id: "message:message-1", label: "[[message:message-1]]" }],
      authorization,
      createdAt: "2026-08-18T00:00:01.000Z",
    };
    expect(reportAdminReportResponseSchema.parse(response)).toEqual(response);
    expect(reportAdminSourceCitationSchema.parse(response.citations[0])).toEqual(
      response.citations[0],
    );
    expect(
      reportAdminReportResponseSchema.safeParse({
        ...response,
        citations: [...response.citations, { id: "message:message-1", label: "duplicate" }],
      }).success,
    ).toBe(false);
  });

  it("requires explicit query or immutable identity selection for export", () => {
    const queryRequest = { selection: { kind: "query", query: "invoice" } };
    const identityRequest = {
      selection: { kind: "identities", messageIds: ["message:message-1"] },
    };
    expect(reportAdminExportRequestSchema.parse(queryRequest)).toEqual(queryRequest);
    expect(reportAdminExportRequestSchema.parse(identityRequest)).toEqual(identityRequest);

    for (const invalid of [
      {},
      { selection: { kind: "identities", messageIds: [] } },
      { selection: { kind: "query", query: "" } },
      { selection: { kind: "all" } },
    ]) {
      expect(reportAdminExportRequestSchema.safeParse(invalid).success).toBe(false);
    }

    const record = {
      version: 1,
      messageId: "message:message-1",
      attribution: {
        sourceMessageId: "message:message-1",
        source: "message",
        occurrence: null,
      },
      actionHistory: [{ actionId: "action:action-1", occurredAt: "2026-08-18T00:00:00.000Z" }],
      contentDigest: "b".repeat(64),
    };
    expect(reportAdminExportRecordSchema.parse(record)).toEqual(record);
    expect(
      reportAdminExportRecordSchema.safeParse({
        ...record,
        attribution: { ...record.attribution, sourceMessageId: "message:other" },
      }).success,
    ).toBe(false);
    expect(
      reportAdminExportRecordSchema.safeParse({
        ...record,
        actionHistory: [...record.actionHistory, ...record.actionHistory],
      }).success,
    ).toBe(false);
    const response = {
      version: 1,
      contentType: "application/octet-stream",
      streamVersion: 1,
    };
    expect(reportAdminExportResponseSchema.parse(response)).toEqual(response);
    expect(reportAdminExportOperation.streaming).toBe("bytes");
  });

  it("round-trips backup and restore while requiring exact destructive preconditions", () => {
    const backupRequest = {
      destination: "/private/var/agent-mail/backups/backup-1",
    };
    expect(reportAdminBackupRequestSchema.parse(backupRequest)).toEqual(backupRequest);
    expect(reportAdminManifestIdentitySchema.parse(manifest)).toEqual(manifest);

    const backupResponse = {
      backupId: "backup:backup-1",
      manifest,
      destination: backupRequest.destination,
      createdAt: "2026-08-18T00:00:02.000Z",
      bytes: 4_096,
    };
    expect(reportAdminBackupResponseSchema.parse(backupResponse)).toEqual(backupResponse);

    const restoreRequest = {
      target: "/private/var/agent-mail/restore-1",
      manifest,
      confirmationNonce: "restore-confirmation-2026-08-18",
      offline: true,
    };
    expect(reportAdminRestoreRequestSchema.parse(restoreRequest)).toEqual(restoreRequest);
    const restoreResponse = {
      restored: true,
      target: restoreRequest.target,
      manifest,
      completedAt: "2026-08-18T00:00:03.000Z",
    };
    expect(reportAdminRestoreResponseSchema.parse(restoreResponse)).toEqual(restoreResponse);

    for (const invalid of [
      { ...restoreRequest, target: "restore-1" },
      { ...restoreRequest, manifest: undefined },
      { ...restoreRequest, confirmationNonce: undefined },
      { ...restoreRequest, offline: false },
    ]) {
      expect(reportAdminRestoreRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("round-trips doctor diagnoses and reindex progress", () => {
    expect(reportAdminDoctorRequestSchema.parse({})).toEqual({});
    const doctor = {
      status: "unhealthy",
      checks: [{ id: "foreign-key-check", status: "fail", summary: "foreign key violation" }],
      issues: [{ code: "foreign-key", detail: "messages references a missing mailbox" }],
    };
    expect(reportAdminDoctorResponseSchema.parse(doctor)).toEqual(doctor);
    expect(
      reportAdminDoctorResponseSchema.safeParse({ ...doctor, issues: [] }).success,
    ).toBe(false);

    const request = { scope: "all", operationIntent: "rebuild search index" };
    const response = {
      accepted: true,
      scope: request.scope,
      startedAt: "2026-08-18T00:00:04.000Z",
      indexed: 12,
      expected: 12,
    };
    expect(reportAdminReindexRequestSchema.parse(request)).toEqual(request);
    expect(reportAdminReindexResponseSchema.parse(response)).toEqual(response);
  });

  it("defines six strict operation contracts with unique public metadata", () => {
    expect(reportAdminOperationDefinitions.map(({ key }) => key)).toEqual([
      "reports.create",
      "exports.selected",
      "admin.backup",
      "admin.restore",
      "admin.doctor",
      "admin.reindex",
    ]);
    for (const operation of reportAdminOperationDefinitions) {
      expect(operation.strictness).toBe("strict");
      expect(operation.request.safeParse({}).success).toBe(
        operation === reportAdminDoctorOperation ? true : false,
      );
    }
    expect(reportAdminBackupOperation.streaming).toBe("none");
    expect(reportAdminRestoreOperation.streaming).toBe("none");
    expect(reportAdminReindexOperation.streaming).toBe("none");
  });
});
