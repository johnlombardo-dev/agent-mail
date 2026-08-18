import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  RawOutputOnTtyError,
  type HumanSegment,
  assertRawOutputAllowed,
  defaultHumanTerminalPolicy,
  renderHuman,
  renderJson,
  renderJsonLine,
  renderLogRecord,
  renderRawBytes,
  renderReport,
  reportContext,
  trustedChrome,
  untrustedValue,
} from "../src/output-context";

const hostileCorpus = [
  "ESC:\u001b",
  "CSI:\u001b[2J",
  "OSC8:\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007",
  "OSC52:\u001b]52;c;Y2xpcGJvYXJk\u0007",
  "TITLE:\u001b]0;forged title\u0007",
  "DCS:\u001bP1;payload\u001b\\",
  "APC:\u001b_1;payload\u001b\\",
  "PM:\u001b^1;payload\u001b\\",
  "SOS:\u001bX1;payload\u001b\\",
  "C0:\u0000\u0007\u0008\u0009\u000a\u000d\u001b",
  "C1:\u0080\u0085\u009b\u009d",
  "DEL:\u007f",
  "BIDI:\u061cALM\u200eLRM\u200fRLM\u202eevil\u2066isolate\u2069",
  "COMBINING:e\u0301\u1ab0\u1dc0\u20d0\ufe20",
  "filename:report\u001b]8;;https://evil.example\u0007.txt",
];

function allSafeHumanBytes(value: string): boolean {
  const bidiControls = new Set([
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ]);
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)))
      return false;
    if (
      codePoint !== undefined &&
      bidiControls.has(codePoint)
    )
      return false;
    if (
      codePoint !== undefined &&
      ((codePoint >= 0x300 && codePoint <= 0x36f) ||
        (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
        (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
        (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
        (codePoint >= 0xfe20 && codePoint <= 0xfe2f))
    )
      return false;
  }
  return true;
}

describe("CLI output contexts", () => {
  it("renders the complete hostile corpus as inert visible evidence", () => {
    const rendered = renderHuman(
      [trustedChrome("subject: "), untrustedValue(hostileCorpus.join("|"))],
      defaultHumanTerminalPolicy("tty"),
    );
    expect(allSafeHumanBytes(rendered)).toBe(true);
    expect(rendered).toContain("␛");
    expect(rendered).toContain("⟦ALM⟧");
    expect(rendered).toContain("⟦LRM⟧");
    expect(rendered).toContain("⟦RLM⟧");
    expect(rendered).toContain("⟦RLO⟧");
    expect(rendered).toContain("⟦U+0301⟧");
    expect(rendered).toContain("⟦U+1AB0⟧");
    expect(rendered).toContain("⟦U+1DC0⟧");
    expect(rendered).toContain("⟦U+20D0⟧");
    expect(rendered).toContain("⟦U+FE20⟧");
    expect(rendered).toContain("https://evil.example");
    expect(rendered).toContain("forged title");
  });

  it("keeps trusted chrome structurally separate and rejects unsafe chrome", () => {
    expect(() => trustedChrome("status\u001b[31m")).toThrow(/trusted chrome/);
    const rendered = renderHuman([
      trustedChrome("RESULT: "),
      untrustedValue("\rFORGED SUCCESS\u000a"),
      trustedChrome("\nEXIT: 1"),
    ]);
    expect(rendered).toBe("RESULT: ␍FORGED SUCCESS␊\nEXIT: 1");
    expect(rendered).not.toContain("\r");
  });

  it("rejects forged, cross-kind, missing-brand, and extra-key segments", () => {
    const trusted = trustedChrome("safe: ");
    const forgedTrusted: unknown = { kind: "trusted-chrome", text: "\u001b[2J" };
    const crossKind: unknown = { ...trusted, kind: "untrusted-value", text: "\u001b[2J" };
    const missingBrand: unknown = { kind: "untrusted-value", text: "\u001b]52;c;bad\u0007" };
    const extraKey: unknown = { ...trusted, extra: "\u001b[2J" };
    const cases = [forgedTrusted, crossKind, missingBrand, extraKey];
    for (const value of cases) {
      expect(() => renderHuman([value as HumanSegment])).toThrow(/matching factory/);
    }
  });

  it("does not change human bytes between TTY and pipe policy", () => {
    const segments = [trustedChrome("subject: "), untrustedValue("hello\u001b[2J")] satisfies readonly [
      HumanSegment,
      HumanSegment,
    ];
    expect(renderHuman(segments, defaultHumanTerminalPolicy("tty"))).toBe(
      renderHuman(segments, defaultHumanTerminalPolicy("pipe")),
    );
  });

  it("preserves structured semantics and JSON framing", () => {
    const value = { subject: "OSC \u001b]52;c;bad\u0007", lines: ["a\nb"] };
    expect(renderJson(value)).toBe(JSON.stringify(value));
    expect(renderJsonLine(value)).toBe(`${JSON.stringify(value)}\n`);
    expect(renderLogRecord(value)).toBe(`${JSON.stringify(value)}\n`);
    expect(() => renderJson(undefined)).toThrow(/undefined/);
  });

  it("passes already-sanitized report documents through their own context", () => {
    const markdown = reportContext("markdown", "# title\n\n[visible](https://example.test)");
    const html = reportContext("html", "<p>sanitized</p>");
    expect(renderReport(markdown)).toBe(markdown.text);
    expect(renderReport(html)).toBe(html.text);
  });

  it("refuses raw bytes on TTY by default and preserves bytes when allowed", () => {
    const bytes = Uint8Array.from([0, 27, 91, 50, 74, 255]);
    expect(() => assertRawOutputAllowed({ destination: "tty", tty: "refuse" })).toThrow(
      RawOutputOnTtyError,
    );
    expect(renderRawBytes(bytes, { destination: "pipe", tty: "refuse" })).toEqual(bytes);
    expect(renderRawBytes(bytes, { destination: "tty", tty: "allow" })).toEqual(bytes);
  });

  it("structurally keeps direct stdout/stderr writes out of CLI renderers", () => {
    const sourceRoot = join(import.meta.dir, "../src");
    for (const file of readdirSync(sourceRoot)) {
      if (!file.endsWith(".ts") || file === "output-context.ts") continue;
      const source = readFileSync(join(sourceRoot, file), "utf8");
      expect(source).not.toMatch(/process\.(stdout|stderr)\.(write|writeSync)/u);
      expect(source).not.toMatch(/console\.(log|error|warn)\(/u);
    }
    const index = readFileSync(join(sourceRoot, "index.ts"), "utf8");
    expect(index).toContain('export * from "./output-context"');
  });
});
