import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  compileSearchQuery,
  SEARCH_CANDIDATE_SQL,
  type CompiledSearchQuery,
} from "../src/search-query-compiler";

function compiled(input: string): CompiledSearchQuery {
  const result = compileSearchQuery(input);
  expect(result.kind).toBe("compiled");
  if (result.kind !== "compiled") throw new Error("expected a compiled query");
  return result;
}

describe("grammar-aware FTS candidate query compiler P4-C03", () => {
  test("normalizes supported syntax into an AST and one bound FTS value", () => {
    const result = compiled('report "quarterly results" +urgent invoice* -spam');

    expect(result.ast).toEqual({
      kind: "query",
      clauses: [
        { kind: "term", modifier: "optional", value: "report" },
        { kind: "phrase", modifier: "optional", value: "quarterly results" },
        { kind: "term", modifier: "required", value: "urgent" },
        { kind: "prefix", modifier: "optional", value: "invoice" },
        { kind: "term", modifier: "excluded", value: "spam" },
      ],
    });
    expect(result.sql).toBe(SEARCH_CANDIDATE_SQL);
    expect(result.parameters).toEqual([
      '"report" AND "quarterly results" AND "urgent" AND "invoice"* NOT "spam"',
    ]);
    expect(result.sql).not.toContain("report");
  });

  test("supports required and excluded phrases while preserving bound values", () => {
    const result = compiled('+"incident response" -"false positive"');

    expect(result.ast.clauses).toEqual([
      { kind: "phrase", modifier: "required", value: "incident response" },
      { kind: "phrase", modifier: "excluded", value: "false positive" },
    ]);
    expect(result.parameters).toEqual(['"incident response" NOT "false positive"']);
    expect(result.parameters).toHaveLength(1);
  });

  test("emits FTS5-valid grammar for every supported representative", () => {
    const database = new Database(":memory:");
    database.exec("CREATE VIRTUAL TABLE message_fts USING fts5(body);");
    database
      .query("INSERT INTO message_fts(rowid, body) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?);")
      .run(
        1,
        "report quarterly results urgent invoice invoicing alice+tag@example.com",
        2,
        "report quarterly results urgent invoice spam",
        3,
        "report quarterly results urgent invoice junk",
        4,
        "false positive incident response",
        5,
        "spam",
        6,
        "invoice invoicing alice+tag@example.com",
      );

    const cases = [
      ["report -spam", [1, 3]],
      ["report -spam -junk", [1]],
      ['"quarterly results"', [1, 2, 3]],
      ["+urgent", [1, 2, 3]],
      ["invoice*", [1, 2, 3, 6]],
      ["alice+tag@example.com", [1, 6]],
      ['+"incident response" -"false positive"', []],
    ] as const;

    try {
      for (const [input, expectedRowIds] of cases) {
        const result = compileSearchQuery(input);
        expect(result.kind).toBe("compiled");
        if (result.kind !== "compiled") throw new Error("expected a compiled query");
        expect(
          database
            .query<{ rowid: number }, [string]>(
              `SELECT rowid FROM message_fts WHERE ${result.sql} ORDER BY rowid;`,
            )
            .all(...result.parameters)
            .map((row) => row.rowid),
        ).toEqual(expectedRowIds);
      }
    } finally {
      database.close();
    }
  });

  test("rejects the adjacent unmatched-quote counterexample as invalid_query", () => {
    expect(compileSearchQuery('unmatched "quote')).toEqual({
      kind: "invalid_query",
      ok: false,
      code: "invalid_query",
      message: "invalid search query",
    });
  });

  test.each([
    ["unsupported boolean operator", "alpha OR beta"],
    ["unsupported negation operator", "alpha NOT beta"],
    ["unsupported near operator", "alpha NEAR/5 beta"],
    ["unsupported column syntax", "subject:invoice"],
    ["unsupported grouping", "(alpha beta)"],
    ["prefix in the middle", "in*voice"],
    ["double prefix", "invoice**"],
    ["empty phrase", '""'],
    ["operator without a term", "+"],
    ["excluded-only query", "-spam"],
    ["control character", "alpha\n beta"],
    ["unclosed phrase", '"alpha beta'],
    ["adjacent phrase text", '"alpha"beta'],
  ])("returns stable invalid_query for %s", (_label, input) => {
    const result = compileSearchQuery(input);
    expect(result).toEqual({
      kind: "invalid_query",
      ok: false,
      code: "invalid_query",
      message: "invalid search query",
    });
  });

  test("escapes punctuation as data instead of accepting FTS structure", () => {
    const result = compiled("alice+tag@example.com");

    expect(result.ast.clauses).toEqual([
      { kind: "term", modifier: "optional", value: "alice+tag@example.com" },
    ]);
    expect(result.parameters).toEqual(['"alice+tag@example.com"']);
  });

  test("does not throw for non-string malformed input", () => {
    expect(compileSearchQuery(null)).toMatchObject({ code: "invalid_query" });
    expect(compileSearchQuery({ query: "alpha" })).toMatchObject({ code: "invalid_query" });
  });
});
