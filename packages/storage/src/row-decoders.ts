import {
  parseAccountId,
  parseBlobId,
  parseMailboxId,
  parseMessageId,
  parsePlacementId,
  parseThreadId,
  parseUtcInstant,
  type AccountId,
  type BlobId,
  type MailboxId,
  type MessageId,
  type PlacementId,
  type ThreadId,
  type UtcInstant,
} from "@agent-mail/core";

/** Context attached to every value decoded from a SQLite row. */
export type SqliteColumnContext = Readonly<{
  readonly table: string;
  readonly column: string;
}>;

export type SqliteValueDecoder<T> = (value: unknown, context: SqliteColumnContext) => T;

export type SqliteRowColumn = Readonly<{
  readonly decode: SqliteValueDecoder<unknown>;
  /** Must be set when SQL NULL is part of this column's schema. */
  readonly nullable?: boolean;
}>;

export type SqliteRowColumns = Readonly<Record<string, SqliteRowColumn>>;

export type CanonicalIdentifierKind =
  | "account"
  | "mailbox"
  | "message"
  | "placement"
  | "blob"
  | "thread";

export type CanonicalIdentifier =
  | AccountId
  | MailboxId
  | MessageId
  | PlacementId
  | BlobId
  | ThreadId;

export type BoundedIntegerContext = SqliteColumnContext &
  Readonly<{
    readonly minimum?: number;
    readonly maximum?: number;
  }>;

export type ClosedEnumContext<T extends string> = SqliteColumnContext &
  Readonly<{
    readonly values: readonly T[];
  }>;

export type SqliteRowDecodeErrorCode =
  | "invalid-row"
  | "missing-column"
  | "extra-column"
  | "invalid-type"
  | "null-not-allowed"
  | "invalid-value"
  | "non-canonical"
  | "invalid-enum"
  | "unsafe-integer"
  | "out-of-range";

/**
 * Stable, redacted failure for a SQLite row boundary.
 *
 * The error intentionally contains schema coordinates and a reason code, but
 * never includes the row or the rejected value.
 */
export class SqliteRowDecodeError extends Error {
  readonly code: SqliteRowDecodeErrorCode;
  readonly table: string;
  readonly column: string;

  constructor(context: SqliteColumnContext, code: SqliteRowDecodeErrorCode) {
    super(`SQLite row decode failed for ${context.table}.${context.column}: ${code}`);
    this.name = "SqliteRowDecodeError";
    this.code = code;
    this.table = context.table;
    this.column = context.column;
  }
}

function fail(context: SqliteColumnContext, code: SqliteRowDecodeErrorCode): never {
  throw new SqliteRowDecodeError(context, code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIntegerBounds(context: BoundedIntegerContext): void {
  const { minimum, maximum } = context;
  if (
    minimum !== undefined &&
    (!Number.isSafeInteger(minimum) || minimum < Number.MIN_SAFE_INTEGER)
  ) {
    throw new TypeError("minimum integer bound must be a safe integer");
  }
  if (
    maximum !== undefined &&
    (!Number.isSafeInteger(maximum) || maximum > Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError("maximum integer bound must be a safe integer");
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new TypeError("minimum integer bound must not exceed maximum integer bound");
  }
}

/** Decode an already canonical, namespaced identifier stored in SQLite. */
export function decodeCanonicalIdentifier(
  value: unknown,
  kind: CanonicalIdentifierKind,
  context: SqliteColumnContext,
): CanonicalIdentifier {
  if (typeof value !== "string") fail(context, "invalid-type");
  try {
    switch (kind) {
      case "account":
        return parseAccountId(value);
      case "mailbox":
        return parseMailboxId(value);
      case "message":
        return parseMessageId(value);
      case "placement":
        return parsePlacementId(value);
      case "blob":
        return parseBlobId(value);
      case "thread":
        return parseThreadId(value);
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  } catch {
    fail(context, "non-canonical");
  }
}

function decodeIdentifier<T>(
  value: unknown,
  context: SqliteColumnContext,
  parser: (input: unknown) => T,
): T {
  if (typeof value !== "string") fail(context, "invalid-type");
  try {
    return parser(value);
  } catch {
    fail(context, "non-canonical");
  }
}

export function decodeAccountId(value: unknown, context: SqliteColumnContext): AccountId {
  return decodeIdentifier(value, context, parseAccountId);
}

export function decodeMailboxId(value: unknown, context: SqliteColumnContext): MailboxId {
  return decodeIdentifier(value, context, parseMailboxId);
}

export function decodeMessageId(value: unknown, context: SqliteColumnContext): MessageId {
  return decodeIdentifier(value, context, parseMessageId);
}

export function decodePlacementId(value: unknown, context: SqliteColumnContext): PlacementId {
  return decodeIdentifier(value, context, parsePlacementId);
}

export function decodeBlobId(value: unknown, context: SqliteColumnContext): BlobId {
  return decodeIdentifier(value, context, parseBlobId);
}

export function decodeThreadId(value: unknown, context: SqliteColumnContext): ThreadId {
  return decodeIdentifier(value, context, parseThreadId);
}

/** Decode a canonical UTC instant with exactly millisecond precision. */
export function decodeUtcMillisecondInstant(
  value: unknown,
  context: SqliteColumnContext,
): UtcInstant {
  if (typeof value !== "string") fail(context, "invalid-type");
  // SQLite stores the canonical representation, not an arbitrary offset form.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail(context, "non-canonical");
  }
  try {
    return parseUtcInstant(value);
  } catch {
    fail(context, "invalid-value");
  }
}

/** SQLite booleans are integer 0 or 1; textual and numeric coercions are rejected. */
export function decodeSqliteBoolean(value: unknown, context: SqliteColumnContext): boolean {
  if (typeof value !== "number") fail(context, "invalid-type");
  if (!Number.isSafeInteger(value) || (value !== 0 && value !== 1)) {
    fail(context, "invalid-value");
  }
  return value === 1;
}

/** Decode a safe integer and optionally enforce an inclusive range. */
export function decodeBoundedSafeInteger(value: unknown, context: BoundedIntegerContext): number {
  assertIntegerBounds(context);
  if (typeof value !== "number") fail(context, "invalid-type");
  if (!Number.isSafeInteger(value)) fail(context, "unsafe-integer");
  if (
    (context.minimum !== undefined && value < context.minimum) ||
    (context.maximum !== undefined && value > context.maximum)
  ) {
    fail(context, "out-of-range");
  }
  return value;
}

export function decodeSafeInteger(value: unknown, context: SqliteColumnContext): number {
  return decodeBoundedSafeInteger(value, context);
}

/** Decode a closed string enum without accepting arbitrary text or coercions. */
export function decodeClosedEnum<T extends string>(
  value: unknown,
  context: ClosedEnumContext<T>,
): T {
  if (typeof value !== "string") fail(context, "invalid-type");
  for (const allowed of context.values) {
    if (allowed === value) return allowed;
  }
  fail(context, "invalid-enum");
}

/** Explicitly permit SQL NULL while retaining the wrapped decoder's checks. */
export function decodeNullable<T>(decoder: SqliteValueDecoder<T>): SqliteValueDecoder<T | null> {
  return (value, context) => (value === null ? null : decoder(value, context));
}

/**
 * Decode one SQLite row against an exact column set. The returned values are
 * unknown to callers until the schema-specific decoder narrows them.
 */
export function decodeSqliteRow({
  table,
  row,
  columns,
}: Readonly<{
  readonly table: string;
  readonly row: unknown;
  readonly columns: SqliteRowColumns;
}>): Readonly<Record<string, unknown>> {
  const rowContext: SqliteColumnContext = { table, column: "<row>" };
  if (!isRecord(row)) fail(rowContext, "invalid-row");

  const expected = Object.keys(columns);
  const expectedSet = new Set(expected);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== "string" || !expectedSet.has(key)) {
      fail({ table, column: typeof key === "string" ? key : "<symbol>" }, "extra-column");
    }
  }
  for (const column of expected) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) {
      fail({ table, column }, "missing-column");
    }
  }

  const decoded: Record<string, unknown> = {};
  for (const column of expected) {
    const context: SqliteColumnContext = { table, column };
    let value: unknown;
    try {
      value = row[column];
    } catch {
      fail(context, "invalid-value");
    }
    const columnDecoder = columns[column];
    if (columnDecoder === undefined) {
      fail(context, "invalid-row");
    }
    if (value === null && columnDecoder.nullable !== true) {
      fail(context, "null-not-allowed");
    }
    try {
      decoded[column] = columnDecoder.decode(value, context);
    } catch (error: unknown) {
      if (error instanceof SqliteRowDecodeError) throw error;
      fail(context, "invalid-value");
    }
  }
  return decoded;
}
