import type { ReportAdminSourceCitation } from "./report-admin-operations";

/**
 * The report renderer deliberately accepts claims, rather than mail HTML. Mail
 * is evidence and is always represented as text in the generated artifacts.
 */
export interface ReportClaim {
  readonly text: string;
  readonly citations: readonly ReportAdminSourceCitation[];
}

export interface ReportSection {
  readonly heading: string;
  readonly claims: readonly ReportClaim[];
}

export interface ReportModel {
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly ReportSection[];
}

export interface RenderedReport {
  readonly markdown: string;
  readonly html: string;
  readonly contentSecurityPolicy: string;
}

/**
 * Escape-only sanitization has no accepted HTML or URL scheme. Keeping this
 * policy public makes the trust decision reviewable by report consumers.
 */
export const REPORT_SANITIZER_POLICY = {
  allowedTags: Object.freeze([]),
  allowedAttributes: Object.freeze({}),
  allowedProtocols: Object.freeze([]),
  allowExternalResources: false,
};

/**
 * This policy is intentionally stricter than the generated document requires.
 * The report is static, has no active content, and must not load any resource.
 */
export const REPORT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "child-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'none'",
  "manifest-src 'none'",
].join("; ");

const EXTERNAL_URL = /\b(?:https?|ftp|javascript|data|vbscript):[^\s<>"'`]+/giu;
const CSS_RESOURCE = /\burl\s*\([^)]*\)/giu;
const UNSAFE_ATTRIBUTE =
  /\b(?:on[a-z][\w:-]*|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu;

function removeExternalResources(value: string): string {
  return value
    .replace(UNSAFE_ATTRIBUTE, "[blocked attribute]")
    .replace(CSS_RESOURCE, "[blocked CSS resource]")
    .replace(EXTERNAL_URL, "[blocked external URL]");
}

function safeText(value: string): string {
  return removeExternalResources(value);
}

function escapeHtmlValue(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

function escapeHtmlText(value: string): string {
  return escapeHtmlValue(safeText(value));
}

function escapeMarkdown(value: string): string {
  // Markdown is emitted as plain text. Escaping the full punctuation set keeps
  // untrusted content from becoming links, HTML, emphasis, or directives.
  return safeText(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_\x5b\x5d{}#+.!|~-]/gu, "\\$&");
}

function markdownCode(value: string): string {
  const longestRun = Math.max(
    0,
    ...[...value.matchAll(/`+/gu)].map((match) => match[0]?.length ?? 0),
  );
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${value}${fence}`;
}

function sourcePath(id: string): string {
  // encodeURIComponent encodes delimiters that could change the path/query/
  // fragment. The generated prefix is fixed and cannot become a remote URL.
  return `/v1/messages/${encodeURIComponent(id)}/text`;
}

function markdownCitation(citation: ReportAdminSourceCitation): string {
  const label = escapeMarkdown(citation.label);
  return `[${label}](${sourcePath(citation.id)}) ${markdownCode(citation.id)}`;
}

function htmlCitation(citation: ReportAdminSourceCitation): string {
  const href = escapeHtmlValue(sourcePath(citation.id));
  const label = escapeHtmlText(citation.label);
  const id = escapeHtmlValue(citation.id);
  return `<a href="${href}" data-source-id="${id}">${label}</a> <span class="source-identity">[${id}]</span>`;
}

function markdownClaim(claim: ReportClaim): string {
  const citations = claim.citations.map(markdownCitation).join(", ");
  return `- ${escapeMarkdown(claim.text)} — ${citations}`;
}

function htmlClaim(claim: ReportClaim): string {
  const citations = claim.citations.map(htmlCitation).join(", ");
  return `<li><span class="claim-text">${escapeHtmlText(claim.text)}</span> <span class="citations">${citations}</span></li>`;
}

export function renderReportMarkdown(report: ReportModel): string {
  const sections = report.sections
    .map((section) => {
      const claims = section.claims.map(markdownClaim).join("\n");
      return `## ${escapeMarkdown(section.heading)}\n\n${claims}`;
    })
    .join("\n\n");

  return `# ${escapeMarkdown(report.title)}\n\n${escapeMarkdown(report.summary)}\n\n${sections}\n`;
}

export function renderReportHtml(report: ReportModel): string {
  const sections = report.sections
    .map((section) => {
      const claims = section.claims.map(htmlClaim).join("\n");
      return `<section><h2>${escapeHtmlText(section.heading)}</h2><ul>${claims}</ul></section>`;
    })
    .join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_CONTENT_SECURITY_POLICY}"><title>${escapeHtmlText(report.title)}</title></head><body><main><h1>${escapeHtmlText(report.title)}</h1><p class="summary">${escapeHtmlText(report.summary)}</p>${sections}</main></body></html>`;
}

export function renderReport(report: ReportModel): RenderedReport {
  return {
    markdown: renderReportMarkdown(report),
    html: renderReportHtml(report),
    contentSecurityPolicy: REPORT_CONTENT_SECURITY_POLICY,
  };
}
