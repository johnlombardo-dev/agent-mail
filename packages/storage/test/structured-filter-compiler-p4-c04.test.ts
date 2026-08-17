import { describe, expect, test } from "bun:test";
import {
  compileStructuredFilters,
  type CompiledStructuredFilter,
} from "../src/structured-filter-compiler";

function compiled(input: readonly unknown[]): CompiledStructuredFilter {
  const result = compileStructuredFilters(input);
  expect(result.kind).toBe("compiled");
  if (result.kind !== "compiled") throw new Error("expected compiled filters");
  return result;
}

describe("structured filter compiler P4-C04", () => {
  test.each([
    [
      "sender equality",
      { field: "sender", operator: "eq", value: "Alice@Example.COM" },
      "(EXISTS (SELECT 1 FROM message_addresses AS ma WHERE ma.message_id = m.message_id AND ma.role = 'from' AND ma.normalized_address = ?))",
      ["alice@example.com"],
    ],
    [
      "sender inequality",
      { field: "sender", operator: "neq", value: "alice@example.com" },
      "(NOT EXISTS (SELECT 1 FROM message_addresses AS ma WHERE ma.message_id = m.message_id AND ma.role = 'from' AND ma.normalized_address = ?))",
      ["alice@example.com"],
    ],
    [
      "list equality",
      { field: "list", operator: "eq", value: "<News@Example.COM>" },
      "(EXISTS (SELECT 1 FROM message_headers AS mh WHERE mh.message_id = m.message_id AND mh.normalized_name = 'list-id' AND mh.normalized_value = ?))",
      ["<news@example.com>"],
    ],
    [
      "remote mailbox equality",
      { field: "remoteMailbox", operator: "eq", value: "archive" },
      "(EXISTS (SELECT 1 FROM remote_placements AS rp WHERE rp.message_id = m.message_id AND rp.mailbox_id = ? AND rp.tombstone_observed_at IS NULL))",
      ["mailbox:archive"],
    ],
    [
      "remote mailbox inequality",
      { field: "remoteMailbox", operator: "neq", value: "mailbox:archive" },
      "(NOT EXISTS (SELECT 1 FROM remote_placements AS rp WHERE rp.message_id = m.message_id AND rp.mailbox_id = ? AND rp.tombstone_observed_at IS NULL))",
      ["mailbox:archive"],
    ],
    [
      "flag equality",
      { field: "flag", operator: "eq", value: "\\Seen" },
      "(EXISTS (SELECT 1 FROM message_flags AS mf WHERE mf.message_id = m.message_id AND mf.normalized_flag = ?))",
      ["\\seen"],
    ],
    [
      "flag inequality",
      { field: "flag", operator: "neq", value: "$Junk" },
      "(NOT EXISTS (SELECT 1 FROM message_flags AS mf WHERE mf.message_id = m.message_id AND mf.normalized_flag = ?))",
      ["$junk"],
    ],
    [
      "importance equality",
      { field: "importance", operator: "eq", value: "HIGH" },
      "(m.importance = ?)",
      ["high"],
    ],
    [
      "importance inequality",
      { field: "importance", operator: "neq", value: "normal" },
      "(m.importance <> ?)",
      ["normal"],
    ],
    [
      "attachment exists",
      { field: "attachment", operator: "exists" },
      "(EXISTS (SELECT 1 FROM message_attachments AS ma WHERE ma.message_id = m.message_id))",
      [],
    ],
    [
      "attachment missing",
      { field: "attachment", operator: "notExists" },
      "(NOT EXISTS (SELECT 1 FROM message_attachments AS ma WHERE ma.message_id = m.message_id))",
      [],
    ],
    [
      "local label equality",
      { field: "localLabel", operator: "eq", value: "label:Finance" },
      "(EXISTS (SELECT 1 FROM local_label_assignments AS lla WHERE lla.message_id = m.message_id AND lla.label = ?))",
      ["label:Finance"],
    ],
    [
      "local label inequality",
      { field: "localLabel", operator: "neq", value: "label:Finance" },
      "(NOT EXISTS (SELECT 1 FROM local_label_assignments AS lla WHERE lla.message_id = m.message_id AND lla.label = ?))",
      ["label:Finance"],
    ],
    [
      "received after",
      { field: "receivedAt", operator: "gt", value: "2026-01-01T00:00:00+08:00" },
      "(m.received_at > ?)",
      ["2025-12-31T16:00:00.000Z"],
    ],
    [
      "received on or after",
      { field: "receivedAt", operator: "gte", value: "2026-01-01T00:00:00.000Z" },
      "(m.received_at >= ?)",
      ["2026-01-01T00:00:00.000Z"],
    ],
    [
      "received before",
      { field: "receivedAt", operator: "lt", value: "2026-01-02T00:00:00Z" },
      "(m.received_at < ?)",
      ["2026-01-02T00:00:00.000Z"],
    ],
    [
      "received on or before",
      { field: "receivedAt", operator: "lte", value: "2026-01-02T00:00:00.000Z" },
      "(m.received_at <= ?)",
      ["2026-01-02T00:00:00.000Z"],
    ],
  ] as const)("compiles %s to its exact relational predicate", (_name, input, expectedSql, expectedParameters) => {
    const result = compiled([input]);
    expect(result.sql).toBe(expectedSql);
    expect(result.parameters).toEqual(expectedParameters);
  });

  test("canonicalizes combined filters independent of input order", () => {
    const result = compiled([
      { field: "receivedAt", operator: "lt", value: "2026-01-02T00:00:00+08:00" },
      { field: "localLabel", operator: "eq", value: "label:finance" },
      { field: "sender", operator: "eq", value: "ALICE@example.com" },
      { field: "attachment", operator: "exists" },
      { field: "receivedAt", operator: "gte", value: "2025-12-31T16:00:00Z" },
    ]);

    expect(result.filters).toEqual([
      { field: "sender", operator: "eq", value: "alice@example.com" },
      { field: "attachment", operator: "exists" },
      { field: "localLabel", operator: "eq", value: "label:finance" },
      { field: "receivedAt", operator: "gte", value: "2025-12-31T16:00:00.000Z" },
      { field: "receivedAt", operator: "lt", value: "2026-01-01T16:00:00.000Z" },
    ]);
    expect(result.parameters).toEqual([
      "alice@example.com",
      "label:finance",
      "2025-12-31T16:00:00.000Z",
      "2026-01-01T16:00:00.000Z",
    ]);
    expect(result.sql.split(") AND (")).toHaveLength(5);
  });

  test("proves equivalent offset instants use the same canonical parameter", () => {
    const utc = compiled([{ field: "receivedAt", operator: "gte", value: "2026-01-01T00:00:00Z" }]);
    const offset = compiled([{ field: "receivedAt", operator: "gte", value: "2026-01-01T08:00:00+08:00" }]);
    expect(utc.parameters).toEqual(offset.parameters);
    expect(utc.sql).toBe(offset.sql);
  });

  test("rejects the adjacent lexicographic timestamp counterexample", () => {
    const result = compiled([{ field: "receivedAt", operator: "gt", value: "2026-01-01T00:00:00+08:00" }]);
    expect(result.parameters).toEqual(["2025-12-31T16:00:00.000Z"]);
    expect(result.parameters[0] < "2026-01-01T00:00:00Z").toBe(true);
  });

  test("keeps local-label and remote-mailbox namespaces structurally distinct", () => {
    const label = compiled([{ field: "localLabel", operator: "eq", value: "label:archive" }]);
    const mailbox = compiled([{ field: "remoteMailbox", operator: "eq", value: "mailbox:archive" }]);
    expect(label.sql).toContain("local_label_assignments");
    expect(label.sql).not.toContain("remote_placements");
    expect(mailbox.sql).toContain("remote_placements");
    expect(mailbox.sql).not.toContain("local_label_assignments");
    expect(compileStructuredFilters([{ field: "localLabel", operator: "eq", value: "mailbox:archive" }])).toMatchObject({ code: "invalid_filter" });
    expect(compileStructuredFilters([{ field: "remoteMailbox", operator: "eq", value: "label:archive" }])).toMatchObject({ code: "invalid_filter" });
  });

  test("uses NOT EXISTS over the same equality relation for negative filters", () => {
    const result = compiled([
      { field: "sender", operator: "neq", value: "alice@example.com" },
      { field: "localLabel", operator: "neq", value: "label:archive" },
    ]);
    expect(result.sql).toContain("NOT EXISTS (SELECT 1 FROM message_addresses");
    expect(result.sql).toContain("ma.normalized_address = ?");
    expect(result.sql).toContain("NOT EXISTS (SELECT 1 FROM local_label_assignments");
    expect(result.sql).toContain("lla.label = ?");
  });

  test.each([
    ["unknown field", [{ field: "subject", operator: "eq", value: "invoice" }]],
    ["unknown operator", [{ field: "sender", operator: "contains", value: "alice@example.com" }]],
    ["sender malformed", [{ field: "sender", operator: "eq", value: "alice" }]],
    ["attachment value", [{ field: "attachment", operator: "exists", value: true }]],
    ["attachment relational operator", [{ field: "attachment", operator: "eq" }]],
    ["importance outside enum", [{ field: "importance", operator: "eq", value: "urgent" }]],
    ["date without offset", [{ field: "receivedAt", operator: "gte", value: "2026-01-01T00:00:00.000" }]],
    ["date invalid calendar", [{ field: "receivedAt", operator: "lt", value: "2026-02-30T00:00:00Z" }]],
    ["unknown field member", [{ field: "sender", operator: "eq", value: "alice@example.com", extra: true }]],
    ["too many filters", Array.from({ length: 33 }, () => ({ field: "attachment", operator: "exists" }))],
  ] as const)("returns stable invalid_filter for %s", (_name, input) => {
    expect(compileStructuredFilters(input)).toEqual({
      kind: "invalid_filter",
      ok: false,
      code: "invalid_filter",
      message: "invalid structured filter",
    });
  });
});
