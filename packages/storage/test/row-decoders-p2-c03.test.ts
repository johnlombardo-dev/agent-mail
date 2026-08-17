import { describe, expect, test } from "bun:test";
import {
  decodeAccountId,
  decodeBoundedSafeInteger,
  decodeClosedEnum,
  decodeNullable,
  decodeSqliteBoolean,
  decodeSqliteRow,
  decodeUtcMillisecondInstant,
  type SqliteColumnContext,
} from "../src/row-decoders";

const context: SqliteColumnContext = { table: "messages", column: "seen" };

function column(decode: (value: unknown, context: SqliteColumnContext) => unknown) {
  return { decode };
}

function nullableColumn(decode: (value: unknown, context: SqliteColumnContext) => unknown) {
  return { decode: decodeNullable(decode), nullable: true };
}

describe("SQLite row decoders", () => {
  test("decodes canonical identifiers, UTC millisecond instants, SQLite booleans, enums, and bounds", () => {
    expect(String(decodeAccountId("account:one", { table: "messages", column: "account_id" }))).toBe(
      "account:one",
    );
    expect(
      String(
        decodeUtcMillisecondInstant("2026-08-18T12:34:56.007Z", {
          table: "messages",
          column: "received_at",
        }),
      ),
    ).toBe("2026-08-18T12:34:56.007Z");
    expect(decodeSqliteBoolean(0, context)).toBe(false);
    expect(decodeSqliteBoolean(1, context)).toBe(true);
    expect(
      decodeClosedEnum("ready", { table: "messages", column: "state", values: ["ready", "failed"] }),
    ).toBe("ready");
    expect(
      decodeBoundedSafeInteger(10, {
        table: "messages",
        column: "attempts",
        minimum: 0,
        maximum: 10,
      }),
    ).toBe(10);
  });

  test("requires exact row fields and preserves explicit nullable columns", () => {
    const decoded = decodeSqliteRow({
      table: "messages",
      row: { seen: 1, state: null },
      columns: {
        seen: column(decodeSqliteBoolean),
        state: nullableColumn((value, field) => decodeClosedEnum(value, { ...field, values: ["ready"] })),
      },
    });
    expect(decoded).toEqual({ seen: true, state: null });

    expect(() =>
      decodeSqliteRow({
        table: "messages",
        row: { seen: 1 },
        columns: { seen: column(decodeSqliteBoolean), state: nullableColumn(decodeSqliteBoolean) },
      }),
    ).toThrow("messages.state: missing-column");
    expect(() =>
      decodeSqliteRow({
        table: "messages",
        row: { seen: 1, state: null, injected: "secret" },
        columns: { seen: column(decodeSqliteBoolean), state: nullableColumn(decodeSqliteBoolean) },
      }),
    ).toThrow("messages.injected: extra-column");
  });

  test("rejects coercion, invalid nulls, unsafe integers, bad instants, and unknown enums", () => {
    expect(() => decodeSqliteBoolean("false", context)).toThrow("messages.seen: invalid-type");
    expect(() => decodeSqliteBoolean(1n, context)).toThrow("messages.seen: invalid-type");
    expect(() => decodeBoundedSafeInteger("4", { ...context, minimum: 0, maximum: 10 })).toThrow(
      "messages.seen: invalid-type",
    );
    expect(() =>
      decodeBoundedSafeInteger(Number.MAX_SAFE_INTEGER + 1, { ...context, minimum: 0 }),
    ).toThrow("messages.seen: unsafe-integer");
    expect(() => decodeBoundedSafeInteger(-1, { ...context, minimum: 0 })).toThrow(
      "messages.seen: out-of-range",
    );
    expect(() => decodeUtcMillisecondInstant("2026-08-18T12:34:56Z", context)).toThrow(
      "messages.seen: non-canonical",
    );
    expect(() => decodeUtcMillisecondInstant("2026-02-30T12:34:56.000Z", context)).toThrow(
      "messages.seen: invalid-value",
    );
    expect(() => decodeClosedEnum("other", { ...context, values: ["ready", "failed"] })).toThrow(
      "messages.seen: invalid-enum",
    );
    expect(() =>
      decodeSqliteRow({
        table: "messages",
        row: { seen: null },
        columns: { seen: column(decodeSqliteBoolean) },
      }),
    ).toThrow("messages.seen: null-not-allowed");
  });

  test("redacts rejected row values and rejects malformed rows", () => {
    const sensitive = "password=do-not-log";
    try {
      decodeSqliteRow({
        table: "messages",
        row: { seen: sensitive },
        columns: { seen: column(decodeSqliteBoolean) },
      });
      throw new Error("expected decode to fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({ table: "messages", column: "seen", code: "invalid-type" });
      expect(String(error)).not.toContain(sensitive);
    }
    expect(() =>
      decodeSqliteRow({ table: "messages", row: null, columns: { seen: column(decodeSqliteBoolean) } }),
    ).toThrow("messages.<row>: invalid-row");
    expect(() =>
      decodeSqliteRow({ table: "messages", row: [], columns: { seen: column(decodeSqliteBoolean) } }),
    ).toThrow("messages.<row>: invalid-row");
  });
});
