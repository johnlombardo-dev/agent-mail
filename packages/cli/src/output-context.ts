/**
 * Output is deliberately modeled as separate contexts. A human terminal is a
 * display boundary; JSON, reports, logs, and raw bytes have different
 * preservation contracts and must not share its transformation.
 */

const trustedChromeBrand = Symbol("TrustedChrome");
const untrustedValueBrand = Symbol("UntrustedValue");

export type TrustedChrome = Readonly<{
  readonly kind: "trusted-chrome";
  readonly text: string;
  readonly [trustedChromeBrand]: "TrustedChrome";
}>;

export type UntrustedValue = Readonly<{
  readonly kind: "untrusted-value";
  readonly text: string;
  readonly [untrustedValueBrand]: "UntrustedValue";
}>;

export type HumanSegment = TrustedChrome | UntrustedValue;

export type HumanTerminalPolicy = Readonly<{
  readonly destination: "tty" | "pipe";
  /** Color is intentionally disabled until a typed style API exists. */
  readonly color: "never";
  /** Human output never truncates forensic values. */
  readonly width: "unbounded";
}>;

export type ReportContext = Readonly<{
  readonly kind: "markdown" | "html";
  readonly text: string;
}>;

export type RawOutputPolicy = Readonly<{
  readonly destination: "tty" | "pipe" | "file";
  readonly tty: "refuse" | "allow";
}>;

const CONTROL_GLYPHS = Object.freeze([
  "␀",
  "␁",
  "␂",
  "␃",
  "␄",
  "␅",
  "␆",
  "␇",
  "␈",
  "␉",
  "␊",
  "␋",
  "␌",
  "␍",
  "␎",
  "␏",
  "␐",
  "␑",
  "␒",
  "␓",
  "␔",
  "␕",
  "␖",
  "␗",
  "␘",
  "␙",
  "␚",
  "␛",
  "␜",
  "␝",
  "␞",
  "␟",
] as const);

const BIDI_NAMES = new Map<number, string>([
  [0x061c, "ALM"],
  [0x200e, "LRM"],
  [0x200f, "RLM"],
  [0x202a, "LRE"],
  [0x202b, "RLE"],
  [0x202c, "PDF"],
  [0x202d, "LRO"],
  [0x202e, "RLO"],
  [0x2066, "LRI"],
  [0x2067, "RLI"],
  [0x2068, "FSI"],
  [0x2069, "PDI"],
]);

function codePointLabel(codePoint: number): string {
  return `⟦U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}⟧`;
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function visibleUntrusted(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint < CONTROL_GLYPHS.length) {
      result += CONTROL_GLYPHS[codePoint];
      continue;
    }
    if (codePoint === 0x7f) {
      result += "␡";
      continue;
    }
    if (codePoint >= 0x80 && codePoint <= 0x9f) {
      result += codePointLabel(codePoint);
      continue;
    }
    const bidiName = BIDI_NAMES.get(codePoint);
    if (bidiName !== undefined) {
      result += `⟦${bidiName}⟧`;
      continue;
    }
    if (codePoint === 0x2028 || codePoint === 0x2029) {
      result += codePointLabel(codePoint);
      continue;
    }
    // Combining marks can visually attach to trusted chrome. Preserve their
    // code point as inert evidence instead of allowing that boundary merge.
    if (isCombiningMark(codePoint)) {
      result += codePointLabel(codePoint);
      continue;
    }
    result += character;
  }
  return result;
}

type SegmentRecord = Record<PropertyKey, unknown>;

function isSegmentRecord(value: unknown): value is SegmentRecord {
  return typeof value === "object" && value !== null;
}

function hasExactSegmentKeys(value: SegmentRecord, brand: symbol): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === 3 && keys.includes("kind") && keys.includes("text") && keys.includes(brand)
  );
}

function isTrustedChrome(value: unknown): value is TrustedChrome {
  if (!isSegmentRecord(value) || !hasExactSegmentKeys(value, trustedChromeBrand)) return false;
  return (
    value.kind === "trusted-chrome" &&
    typeof value.text === "string" &&
    value[trustedChromeBrand] === "TrustedChrome" &&
    !(untrustedValueBrand in value)
  );
}

function isUntrustedValue(value: unknown): value is UntrustedValue {
  if (!isSegmentRecord(value) || !hasExactSegmentKeys(value, untrustedValueBrand)) return false;
  return (
    value.kind === "untrusted-value" &&
    typeof value.text === "string" &&
    value[untrustedValueBrand] === "UntrustedValue" &&
    !(trustedChromeBrand in value)
  );
}

function parseHumanSegment(value: unknown): HumanSegment {
  if (isTrustedChrome(value) || isUntrustedValue(value)) return value;
  throw new TypeError("human output segment must come from its matching factory");
}

function assertTrustedText(text: string): void {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      codePoint !== 0x0a &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    )
      throw new TypeError("trusted chrome cannot contain terminal controls");
  }
}

export function trustedChrome(text: string): TrustedChrome {
  assertTrustedText(text);
  const segment: TrustedChrome = {
    kind: "trusted-chrome",
    text,
    [trustedChromeBrand]: "TrustedChrome",
  };
  return Object.freeze(segment);
}

export function untrustedValue(value: string): UntrustedValue {
  const segment: UntrustedValue = {
    kind: "untrusted-value",
    text: value,
    [untrustedValueBrand]: "UntrustedValue",
  };
  return Object.freeze(segment);
}

export function defaultHumanTerminalPolicy(
  destination: HumanTerminalPolicy["destination"],
): HumanTerminalPolicy {
  return Object.freeze({ destination, color: "never", width: "unbounded" });
}

export function renderHuman(
  segments: readonly [HumanSegment, ...HumanSegment[]],
  policy: HumanTerminalPolicy = defaultHumanTerminalPolicy("pipe"),
): string {
  if (policy.color !== "never" || policy.width !== "unbounded")
    throw new TypeError("human output policy must disable color and truncation");
  return segments
    .map((segment) => {
      const parsed = parseHumanSegment(segment);
      switch (parsed.kind) {
        case "trusted-chrome":
          return parsed.text;
        case "untrusted-value":
          return visibleUntrusted(parsed.text);
        default: {
          const exhaustive: never = parsed;
          return exhaustive;
        }
      }
    })
    .join("");
}

export function reportContext(kind: ReportContext["kind"], text: string): ReportContext {
  return Object.freeze({ kind, text });
}

export function renderReport(context: ReportContext): string {
  return context.text;
}

export function renderJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("structured output cannot encode undefined");
  return encoded;
}

export function renderJsonLine(value: unknown): string {
  return `${renderJson(value)}\n`;
}

export function renderLogRecord(value: unknown): string {
  return renderJsonLine(value);
}

export class RawOutputOnTtyError extends Error {
  public constructor() {
    super(
      "raw EML/attachment output is refused on a TTY; choose a pipe/file or explicitly allow TTY bytes",
    );
    this.name = "RawOutputOnTtyError";
  }
}

export function assertRawOutputAllowed(policy: RawOutputPolicy): void {
  if (policy.destination === "tty" && policy.tty === "refuse") throw new RawOutputOnTtyError();
}

/** Return a copy only after the exact TTY policy has been checked. */
export function renderRawBytes(bytes: Uint8Array, policy: RawOutputPolicy): Uint8Array {
  assertRawOutputAllowed(policy);
  return bytes.slice();
}
