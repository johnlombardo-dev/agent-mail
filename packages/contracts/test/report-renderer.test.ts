import { describe, expect, it } from "bun:test";
import {
  REPORT_CONTENT_SECURITY_POLICY,
  REPORT_SANITIZER_POLICY,
  renderReport,
  renderReportHtml,
  renderReportMarkdown,
  type ReportModel,
} from "../src/report-renderer";

const adversarialContent = [
  "<script>alert(1)</script>",
  '<svg><a href="javascript:alert(1)">x</a></svg>',
  "<div style=\"background:url(https://tracker.invalid/pixel)\">css</div>",
  '<img src=https://tracker.invalid/pixel onerror="alert(1)">',
  "<form action=https://tracker.invalid><input></form>",
  '<iframe src="https://tracker.invalid/frame"></iframe>',
  "<img src=data:text/html,<script>alert(1)</script>>",
  "<a href=javascript:alert(1)>click</a>",
  "<div><span>unclosed",
] as const;

function reportWith(content: string): ReportModel {
  return {
    title: content,
    summary: content,
    sections: [
      {
        heading: content,
        claims: [
          {
            text: content,
            citations: [{ id: "message:trusted-1", label: content }],
          },
        ],
      },
    ],
  };
}

describe("safe report renderer", () => {
  it("renders adversarial mail as inert escaped text", () => {
    for (const content of adversarialContent) {
      const rendered = renderReport(reportWith(content));

      expect(rendered.html).not.toMatch(/<\/?(?:script|svg|form|iframe|img|style)\b/iu);
      expect(rendered.html).not.toMatch(/\bon[a-z]+\s*=/iu);
      expect(rendered.html).not.toMatch(/\b(?:https?|ftp|javascript|data|vbscript):/iu);
      expect(rendered.html).not.toMatch(/\burl\s*\(/iu);
      expect(rendered.markdown).not.toMatch(/\b(?:https?|ftp|javascript|data|vbscript):/iu);
      expect(rendered.markdown).not.toContain("<script");
    }
  });

  it("keeps citation identity exact and links only to text views", () => {
    const report: ReportModel = {
      title: "Weekly review",
      summary: "One claim",
      sections: [
        {
          heading: "Evidence",
          claims: [
            {
              text: "The exact source is retained.",
              citations: [{ id: "message:2026/08/18?item=1", label: "Source" }],
            },
          ],
        },
      ],
    };

    const first = renderReport(report);
    const second = renderReport(report);
    expect(first).toEqual(second);
    expect(first.markdown).toContain("`message:2026/08/18?item=1`");
    expect(first.html).toContain("[message:2026/08/18?item=1]");
    expect(first.html).toContain('href="/v1/messages/message%3A2026%2F08%2F18%3Fitem%3D1/text"');
    expect(first.html).not.toContain("href=\"https://");
  });

  it("publishes an explicit no-active-content CSP", () => {
    const html = renderReportHtml(reportWith("report"));
    expect(html).toContain(`content="${REPORT_CONTENT_SECURITY_POLICY}"`);
    for (const directive of [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "img-src 'none'",
      "object-src 'none'",
      "script-src 'none'",
      "style-src 'none'",
    ]) {
      expect(REPORT_CONTENT_SECURITY_POLICY).toContain(directive);
    }
  });

  it("keeps the sanitizer allowlist empty", () => {
    expect(REPORT_SANITIZER_POLICY.allowedTags).toEqual([]);
    expect(REPORT_SANITIZER_POLICY.allowedAttributes).toEqual({});
    expect(REPORT_SANITIZER_POLICY.allowedProtocols).toEqual([]);
    expect(REPORT_SANITIZER_POLICY.allowExternalResources).toBe(false);
  });
});
