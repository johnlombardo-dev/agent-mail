import { parseUtcInstant, type UtcInstant } from "@agent-mail/core";

export const ROUTING_ORIGIN_CALLER_SOURCES = ["direct-ingestion", "recurring-sweep"] as const;

export type RoutingOriginCallerSource = (typeof ROUTING_ORIGIN_CALLER_SOURCES)[number];

export type RoutingDecisionOrigin = Readonly<{
  readonly callerSource: RoutingOriginCallerSource;
  readonly observedAt: UtcInstant;
  readonly evaluationId: string;
}>;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
    if (codePoint !== undefined && codePoint > 0xffff) index += 1;
  }
  return false;
}

export function parseRoutingOriginCallerSource(value: unknown): RoutingOriginCallerSource {
  if (value === "direct-ingestion" || value === "recurring-sweep") return value;
  throw new TypeError("routing origin caller source is invalid");
}

export function parseRoutingDecisionOrigin(value: unknown): RoutingDecisionOrigin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("routing decision origin must be an object");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError("routing decision origin has symbol fields");
  }
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.includes("callerSource") ||
    !keys.includes("observedAt") ||
    !keys.includes("evaluationId")
  ) {
    throw new TypeError("routing decision origin has missing or unknown fields");
  }
  if (
    typeof record.evaluationId !== "string" ||
    record.evaluationId.length < 1 ||
    record.evaluationId.length > 256 ||
    record.evaluationId.trim() !== record.evaluationId ||
    hasControlCharacters(record.evaluationId)
  ) {
    throw new TypeError("routing origin evaluation ID is invalid");
  }
  return {
    callerSource: parseRoutingOriginCallerSource(record.callerSource),
    observedAt: parseUtcInstant(record.observedAt),
    evaluationId: record.evaluationId,
  };
}
