import { createLocalLabel, createMailboxId, createUtcInstant } from "@agent-mail/core";

/** The message relation alias expected by the candidate-query composer. */
export const STRUCTURED_FILTER_MESSAGE_ALIAS = "m" as const;

const MAX_FILTERS = 32;
const MAX_SENDER_LENGTH = 320;
const MAX_LIST_LENGTH = 998;
const MAX_FLAG_LENGTH = 128;
const MAX_NAMESPACE_VALUE_LENGTH = 256;

export type StructuredFilterField =
  | "sender"
  | "list"
  | "remoteMailbox"
  | "flag"
  | "importance"
  | "attachment"
  | "localLabel"
  | "receivedAt";

export type StructuredFilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "notExists";

export type StructuredFilter =
  | Readonly<{ readonly field: "sender"; readonly operator: "eq" | "neq"; readonly value: string }>
  | Readonly<{ readonly field: "list"; readonly operator: "eq" | "neq"; readonly value: string }>
  | Readonly<{
      readonly field: "remoteMailbox";
      readonly operator: "eq" | "neq";
      readonly value: string;
    }>
  | Readonly<{ readonly field: "flag"; readonly operator: "eq" | "neq"; readonly value: string }>
  | Readonly<{
      readonly field: "importance";
      readonly operator: "eq" | "neq";
      readonly value: "low" | "normal" | "high";
    }>
  | Readonly<{
      readonly field: "attachment";
      readonly operator: "exists" | "notExists";
    }>
  | Readonly<{
      readonly field: "localLabel";
      readonly operator: "eq" | "neq";
      readonly value: string;
    }>
  | Readonly<{
      readonly field: "receivedAt";
      readonly operator: "gt" | "gte" | "lt" | "lte";
      readonly value: string;
    }>;

export type CompiledStructuredFilter = Readonly<{
  readonly kind: "compiled";
  readonly ok: true;
  readonly filters: readonly StructuredFilter[];
  readonly sql: string;
  readonly parameters: readonly string[];
}>;

export type InvalidStructuredFilter = Readonly<{
  readonly kind: "invalid_filter";
  readonly ok: false;
  readonly code: "invalid_filter";
  readonly message: "invalid structured filter";
}>;

export type StructuredFilterCompileResult = CompiledStructuredFilter | InvalidStructuredFilter;

const INVALID_FILTER: InvalidStructuredFilter = Object.freeze({
  kind: "invalid_filter",
  ok: false,
  code: "invalid_filter",
  message: "invalid structured filter",
});

type RecordValue = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return undefined;
  if (value.trim() !== value || hasControlCharacters(value)) return undefined;
  return value.normalize("NFC");
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function normalizeOperator(value: unknown): StructuredFilterOperator | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "eq":
    case "equals":
      return "eq";
    case "neq":
    case "notEquals":
    case "not-equals":
    case "lacks":
      return "neq";
    case "gt":
    case "after":
      return "gt";
    case "gte":
    case "onOrAfter":
      return "gte";
    case "lt":
    case "before":
      return "lt";
    case "lte":
    case "onOrBefore":
      return "lte";
    case "exists":
    case "has":
      return "exists";
    case "notExists":
    case "missing":
      return "notExists";
    default:
      return undefined;
  }
}

function normalizeField(value: unknown): StructuredFilterField | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "sender":
    case "list":
    case "remoteMailbox":
    case "flag":
    case "importance":
    case "attachment":
    case "localLabel":
    case "receivedAt":
      return value;
    case "mailbox":
      return "remoteMailbox";
    case "date":
      return "receivedAt";
    default:
      return undefined;
  }
}

function normalizeSender(value: unknown): string | undefined {
  const text = boundedText(value, MAX_SENDER_LENGTH);
  if (text === undefined || text.length < 3) return undefined;
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@") || at === text.length - 1) return undefined;
  if (/[\s<>()[\],;:\\"]+/u.test(text)) return undefined;
  return text.toLocaleLowerCase("en-US");
}

function normalizeList(value: unknown): string | undefined {
  const text = boundedText(value, MAX_LIST_LENGTH);
  if (text === undefined || text.length === 0) return undefined;
  return text.toLocaleLowerCase("en-US");
}

function normalizeRemoteMailbox(value: unknown): string | undefined {
  const text = boundedText(value, MAX_NAMESPACE_VALUE_LENGTH);
  if (text === undefined || text.startsWith("label:")) return undefined;
  try {
    return createMailboxId(text);
  } catch {
    return undefined;
  }
}

function normalizeFlag(value: unknown): string | undefined {
  const text = boundedText(value, MAX_FLAG_LENGTH);
  if (text === undefined || /\s/u.test(text)) return undefined;
  return text.toLocaleLowerCase("en-US");
}

function normalizeImportance(value: unknown): "low" | "normal" | "high" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLocaleLowerCase("en-US");
  if (normalized === "low" || normalized === "normal" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

function normalizeLocalLabel(value: unknown): string | undefined {
  const text = boundedText(value, MAX_NAMESPACE_VALUE_LENGTH);
  if (text === undefined) return undefined;
  try {
    return createLocalLabel(text);
  } catch {
    return undefined;
  }
}

function normalizeInstant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction = "", offset] = match;
  const local = new Date(0);
  local.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  local.setUTCHours(
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  );
  if (
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() !== Number(month) - 1 ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hour) ||
    local.getUTCMinutes() !== Number(minute) ||
    local.getUTCSeconds() !== Number(second)
  ) {
    return undefined;
  }
  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset.slice(4));
  if (
    offset !== "Z" &&
    (offsetHours > 14 || offsetMinutes >= 60 || (offsetHours === 14 && offsetMinutes !== 0))
  ) {
    return undefined;
  }
  const sign = offset === "Z" || offset.startsWith("+") ? 1 : -1;
  const expected = local.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed !== expected) return undefined;
  try {
    return createUtcInstant(value);
  } catch {
    return undefined;
  }
}

function normalizeFilter(value: unknown): StructuredFilter | undefined {
  if (!isRecord(value)) return undefined;
  const field = normalizeField(value.field);
  const operator = normalizeOperator(value.operator);
  if (field === undefined || operator === undefined) return undefined;
  if (
    field === "attachment"
      ? !hasExactKeys(value, ["field", "operator"])
      : !hasExactKeys(value, ["field", "operator", "value"])
  ) {
    return undefined;
  }

  switch (field) {
    case "sender": {
      if (operator !== "eq" && operator !== "neq") return undefined;
      const sender = normalizeSender(value.value);
      return sender === undefined ? undefined : { field, operator, value: sender };
    }
    case "list": {
      if (operator !== "eq" && operator !== "neq") return undefined;
      const list = normalizeList(value.value);
      return list === undefined ? undefined : { field, operator, value: list };
    }
    case "remoteMailbox": {
      if (operator !== "eq" && operator !== "neq") return undefined;
      const mailbox = normalizeRemoteMailbox(value.value);
      return mailbox === undefined ? undefined : { field, operator, value: mailbox };
    }
    case "flag": {
      if (operator !== "eq" && operator !== "neq") return undefined;
      const flag = normalizeFlag(value.value);
      return flag === undefined ? undefined : { field, operator, value: flag };
    }
    case "importance": {
      if (operator !== "eq" && operator !== "neq") return undefined;
      const importance = normalizeImportance(value.value);
      return importance === undefined ? undefined : { field, operator, value: importance };
    }
    case "attachment":
      return operator === "exists" || operator === "notExists" ? { field, operator } : undefined;
    case "localLabel": {
      if (operator !== "eq" && operator !== "neq") return undefined;
      const label = normalizeLocalLabel(value.value);
      return label === undefined ? undefined : { field, operator, value: label };
    }
    case "receivedAt": {
      if (operator !== "gt" && operator !== "gte" && operator !== "lt" && operator !== "lte") {
        return undefined;
      }
      const instant = normalizeInstant(value.value);
      return instant === undefined ? undefined : { field, operator, value: instant };
    }
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function fieldRank(field: StructuredFilterField): number {
  return [
    "sender",
    "list",
    "remoteMailbox",
    "flag",
    "importance",
    "attachment",
    "localLabel",
    "receivedAt",
  ].indexOf(field);
}

function operatorRank(operator: StructuredFilterOperator): number {
  return ["eq", "neq", "gt", "gte", "lt", "lte", "exists", "notExists"].indexOf(operator);
}

function compareFilters(left: StructuredFilter, right: StructuredFilter): number {
  const fieldDifference = fieldRank(left.field) - fieldRank(right.field);
  if (fieldDifference !== 0) return fieldDifference;
  const operatorDifference = operatorRank(left.operator) - operatorRank(right.operator);
  if (operatorDifference !== 0) return operatorDifference;
  if (!("value" in left) || !("value" in right)) return 0;
  return left.value.localeCompare(right.value, "en-US");
}

function predicate(
  filter: StructuredFilter,
): Readonly<{ readonly sql: string; readonly parameters: readonly string[] }> {
  const value = "value" in filter ? [filter.value] : [];
  const exists =
    filter.operator === "neq" || filter.operator === "notExists" ? "NOT EXISTS" : "EXISTS";
  switch (filter.field) {
    case "sender":
      return {
        sql: `${exists} (SELECT 1 FROM message_addresses AS ma WHERE ma.message_id = m.message_id AND ma.role = 'from' AND ma.normalized_address = ?)`,
        parameters: value,
      };
    case "list":
      return {
        sql: `${exists} (SELECT 1 FROM message_headers AS mh WHERE mh.message_id = m.message_id AND mh.normalized_name = 'list-id' AND mh.normalized_value = ?)`,
        parameters: value,
      };
    case "remoteMailbox":
      return {
        sql: `${exists} (SELECT 1 FROM remote_placements AS rp WHERE rp.message_id = m.message_id AND rp.mailbox_id = ? AND rp.tombstone_observed_at IS NULL)`,
        parameters: value,
      };
    case "flag":
      return {
        sql: `${exists} (SELECT 1 FROM remote_placements AS rp, json_each(rp.flags_json) AS mf WHERE rp.message_id = m.message_id AND rp.tombstone_observed_at IS NULL AND lower(CAST(mf.value AS TEXT)) = ?)`,
        parameters: value,
      };
    case "importance":
      return {
        sql: `${exists} (SELECT 1 FROM local_label_assignments AS lla WHERE lla.message_id = m.message_id AND lla.label = ?)`,
        parameters: value.map((importance) => `label:importance:${importance}`),
      };
    case "attachment":
      return {
        sql: `${exists} (SELECT 1 FROM message_attachments AS ma WHERE ma.message_id = m.message_id)`,
        parameters: value,
      };
    case "localLabel":
      return {
        sql: `${exists} (SELECT 1 FROM local_label_assignments AS lla WHERE lla.message_id = m.message_id AND lla.label = ?)`,
        parameters: value,
      };
    case "receivedAt":
      return {
        sql: `EXISTS (SELECT 1 FROM remote_placements AS rp WHERE rp.message_id = m.message_id AND rp.tombstone_observed_at IS NULL AND rp.internal_date ${filter.operator === "gt" ? ">" : filter.operator === "gte" ? ">=" : filter.operator === "lt" ? "<" : "<="} ?)`,
        parameters: value,
      };
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

/**
 * Normalize a bounded structured-filter list into SQL predicates. This
 * function never executes SQL and never copies a caller value into SQL
 * structure; all value-bearing predicates use bound parameters.
 */
export function compileStructuredFilters(input: unknown): StructuredFilterCompileResult {
  if (!Array.isArray(input) || input.length > MAX_FILTERS) return INVALID_FILTER;
  const filters: StructuredFilter[] = [];
  for (const candidate of input) {
    const filter = normalizeFilter(candidate);
    if (filter === undefined) return INVALID_FILTER;
    filters.push(filter);
  }
  filters.sort(compareFilters);

  const predicates = filters.map(predicate);
  return Object.freeze({
    kind: "compiled",
    ok: true,
    filters: Object.freeze(filters),
    sql: predicates.length === 0 ? "1 = 1" : predicates.map(({ sql }) => `(${sql})`).join(" AND "),
    parameters: Object.freeze(predicates.flatMap(({ parameters }) => parameters)),
  });
}
