import { describe, expect, test } from "bun:test";
import {
  REPORT_CONTENT_SECURITY_POLICY,
  renderReport,
} from "@agent-mail/contracts";
import {
  createReportServingApp,
  REPORT_READ_SCOPE,
  SOURCE_READ_SCOPE,
  reportArtifactRecordSchema,
  type ReportArtifactRecord,
  type SourceTextRecord,
} from "../src/report-serving";

const reportId = "report:weekly-1";
const messageId = "message:source-1";
const owner = "operator:owner";
const otherOwner = "operator:other";

const reportModel = {
  title: "Weekly report",
  summary: "A static report",
  sections: [
    {
      heading: "Evidence",
      claims: [
        {
          text: "The source is retained as text.",
          citations: [{ id: messageId, label: "Source" }],
        },
      ],
    },
  ],
};

const report: ReportArtifactRecord = {
  reportId,
  owner,
  scope: REPORT_READ_SCOPE,
  model: reportModel,
};

const source: SourceTextRecord = {
  messageId,
  owner,
  scope: SOURCE_READ_SCOPE,
  text: "<script>alert('this is text, not HTML')</script>\nOriginal body",
};

function authFor(subject: string, scopes: readonly string[]) {
  return () => ({ kind: "authenticated" as const, principal: { subject, scopes } });
}

function appFor(
  records: Readonly<{
    readonly report?: ReportArtifactRecord;
    readonly source?: SourceTextRecord;
  }> = { report, source },
) {
  return createReportServingApp({
    authenticate: authFor(owner, [REPORT_READ_SCOPE, SOURCE_READ_SCOPE]),
    repository: {
      resolveReport: async (id) => (id === records.report?.reportId ? records.report : undefined),
      resolveSource: async (id) => (id === records.source?.messageId ? records.source : undefined),
    },
  });
}

function reportUrl(id = reportId): string {
  return `http://localhost/v1/reports/${encodeURIComponent(id)}`;
}

function sourceUrl(id = messageId): string {
  return `http://localhost/v1/messages/${encodeURIComponent(id)}/text`;
}

describe("P6-C17 authorized report and text-source serving", () => {
  test("serves a renderer artifact and text projection with inert, private headers", async () => {
    const app = appFor();

    const reportResponse = await app.request(reportUrl(), {
      headers: { authorization: "Bearer report-token" },
    });
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(reportResponse.headers.get("content-security-policy")).toBe(
      REPORT_CONTENT_SECURITY_POLICY,
    );
    expect(reportResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reportResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(await reportResponse.text()).toContain('href="/v1/messages/message%3Asource-1/text"');

    const sourceResponse = await app.request(sourceUrl(), {
      headers: { authorization: "Bearer source-token" },
    });
    expect(sourceResponse.status).toBe(200);
    expect(sourceResponse.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(sourceResponse.headers.get("content-security-policy")).toBe(
      REPORT_CONTENT_SECURITY_POLICY,
    );
    expect(sourceResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(sourceResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(await sourceResponse.text()).toBe(source.text);
  });

  test("enforces authentication, operation scope, owner, and record scope before serving", async () => {
    let reportResolutions = 0;
    let sourceResolutions = 0;
    const app = createReportServingApp({
      authenticate: (credential) => {
        if (credential === "insufficient")
          return { kind: "authenticated" as const, principal: { subject: owner, scopes: [] } };
        if (credential === "other-account")
          return {
            kind: "authenticated" as const,
            principal: { subject: otherOwner, scopes: [REPORT_READ_SCOPE, SOURCE_READ_SCOPE] },
          };
        return {
          kind: "authenticated" as const,
          principal: { subject: owner, scopes: [REPORT_READ_SCOPE, SOURCE_READ_SCOPE] },
        };
      },
      repository: {
        resolveReport: async () => {
          reportResolutions += 1;
          return report;
        },
        resolveSource: async () => {
          sourceResolutions += 1;
          return source;
        },
      },
    });

    expect((await app.request(reportUrl())).status).toBe(401);
    expect((await app.request(reportUrl(), { headers: { authorization: "Bearer insufficient" } })).status).toBe(403);
    expect((await app.request(reportUrl(), { headers: { authorization: "Bearer other-account" } })).status).toBe(404);
    expect((await app.request(sourceUrl(), { headers: { authorization: "Bearer other-account" } })).status).toBe(404);
    expect(reportResolutions).toBe(1);
    expect(sourceResolutions).toBe(1);

    const recordScopeApp = createReportServingApp({
      authenticate: authFor(owner, [REPORT_READ_SCOPE, SOURCE_READ_SCOPE]),
      repository: {
        resolveReport: async () => ({ ...report, scope: "reports:restricted" }),
        resolveSource: async () => ({ ...source, scope: "mail:read.restricted" }),
      },
    });
    expect(
      (await recordScopeApp.request(reportUrl(), { headers: { authorization: "Bearer token" } })).status,
    ).toBe(404);
    expect(
      (await recordScopeApp.request(sourceUrl(), { headers: { authorization: "Bearer token" } })).status,
    ).toBe(404);
  });

  test("returns 404 for missing and tampered identities without exposing repository content", async () => {
    const app = appFor();
    const missing = await app.request(reportUrl("report:missing"), {
      headers: { authorization: "Bearer token" },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });

    const tampered = await app.request(reportUrl("report:weekly-1/../../message:source-1"), {
      headers: { authorization: "Bearer token" },
    });
    expect(tampered.status).toBe(404);
    expect(await tampered.json()).toMatchObject({ code: "not_found" });

    const sourceTampered = await app.request(sourceUrl("message:source-2"), {
      headers: { authorization: "Bearer token" },
    });
    expect(sourceTampered.status).toBe(404);
    expect(await sourceTampered.json()).toMatchObject({ code: "not_found" });
  });

  test("renders hostile model fields with the accepted renderer and rejects stored HTML", async () => {
    const maliciousModel = {
      title: '<script>alert("title")</script>',
      summary: '<form action="https://tracker.invalid"><img src="//tracker.invalid/pixel"></form>',
      sections: [
        {
          heading: "<svg onload=alert(1)>",
          claims: [
            {
              text: "javascript:alert(1) data:text/html,<script>alert(1)</script>",
              citations: [{ id: messageId, label: "<iframe>source</iframe>" }],
            },
          ],
        },
      ],
    };
    const unsafe: ReportArtifactRecord = {
      ...report,
      model: maliciousModel,
    };
    const app = appFor({ report: unsafe, source });
    const response = await app.request(reportUrl(), {
      headers: { authorization: "Bearer token" },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toMatch(/<\/?(?:script|form|img|svg|iframe)\b/iu);
    expect(body).not.toMatch(/\b(?:https?|javascript|data):/iu);
    expect(body).toContain("&lt;script&gt;");

    const arbitraryHtmlRecord = {
      ...report,
      html: renderReport(reportModel).html,
    };
    expect(reportArtifactRecordSchema.safeParse(arbitraryHtmlRecord).success).toBe(false);

    const rawProxy = await app.request(`http://localhost/v1/messages/${encodeURIComponent(messageId)}/raw`, {
      headers: { authorization: "Bearer token" },
    });
    expect(rawProxy.status).toBe(404);
    expect(await rawProxy.json()).toMatchObject({ code: "not_found" });
  });
});
