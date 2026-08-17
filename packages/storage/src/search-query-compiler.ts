/** The only SQL structure emitted by the search-text compiler. */
export const SEARCH_CANDIDATE_SQL = "message_fts MATCH ?";

export type SearchQueryModifier = "optional" | "required" | "excluded";

export type SearchQueryClause = Readonly<{
  readonly kind: "term" | "phrase" | "prefix";
  readonly modifier: SearchQueryModifier;
  readonly value: string;
}>;

export type SearchQueryAst = Readonly<{
  readonly kind: "query";
  readonly clauses: readonly SearchQueryClause[];
}>;

export type CompiledSearchQuery = Readonly<{
  readonly kind: "compiled";
  readonly ok: true;
  readonly ast: SearchQueryAst;
  readonly sql: typeof SEARCH_CANDIDATE_SQL;
  readonly parameters: readonly [string];
}>;

export type InvalidSearchQuery = Readonly<{
  readonly kind: "invalid_query";
  readonly ok: false;
  readonly code: "invalid_query";
  readonly message: "invalid search query";
}>;

export type SearchQueryCompileResult = CompiledSearchQuery | InvalidSearchQuery;

const INVALID_QUERY: InvalidSearchQuery = Object.freeze({
  kind: "invalid_query",
  ok: false,
  code: "invalid_query",
  message: "invalid search query",
});

const UNSUPPORTED_OPERATOR = /^(?:AND|OR|NOT|NEAR)$/iu;
const NEAR_OPERATOR = /^NEAR(?:\/\d+)?$/iu;
const SEARCH_TOKEN_CHARACTER = /[\p{L}\p{N}_]/u;

type ParsedClause = Readonly<{
  readonly kind: SearchQueryClause["kind"];
  readonly modifier: SearchQueryModifier;
  readonly value: string;
}>;

/**
 * Compile the deliberately small user-search grammar without executing it.
 *
 * Supported syntax is a whitespace-separated sequence of terms, quoted
 * phrases, suffix-prefix terms, and leading + or - modifiers. Every term is
 * quoted in the generated FTS expression; AND and NOT are compiler-owned
 * structure, never user-provided syntax.
 */
export function compileSearchQuery(input: unknown): SearchQueryCompileResult {
  if (typeof input !== "string" || input.length === 0 || input.length > 2_048) return INVALID_QUERY;
  if (hasControlCharacters(input)) return INVALID_QUERY;

  const clauses = parseClauses(input);
  if (clauses === undefined || clauses.length === 0) return INVALID_QUERY;

  const positive = clauses.filter((clause) => clause.modifier !== "excluded");
  if (positive.length === 0) return INVALID_QUERY;

  const ast: SearchQueryAst = Object.freeze({
    kind: "query",
    clauses: Object.freeze(clauses.map((clause) => Object.freeze({ ...clause }))),
  });
  const expression = compileExpression(clauses);
  if (expression === undefined) return INVALID_QUERY;
  const parameters: readonly [string] = [expression];

  return Object.freeze({
    kind: "compiled",
    ok: true,
    ast,
    sql: SEARCH_CANDIDATE_SQL,
    parameters,
  });
}

/** Alias kept local to the storage package for callers that name the FTS layer. */
export const compileFtsQuery = compileSearchQuery;

function parseClauses(input: string): readonly ParsedClause[] | undefined {
  const clauses: ParsedClause[] = [];
  let offset = 0;

  while (offset < input.length) {
    while (offset < input.length && isWhitespace(input[offset] ?? "")) offset += 1;
    if (offset === input.length) break;

    let modifier: SearchQueryModifier = "optional";
    const leading = input[offset];
    if (leading === "+" || leading === "-") {
      modifier = leading === "+" ? "required" : "excluded";
      offset += 1;
      if (
        offset === input.length ||
        isWhitespace(input[offset] ?? "") ||
        "+-".includes(input[offset] ?? "")
      ) {
        return undefined;
      }
    }

    const parsed = input[offset] === '"' ? parsePhrase(input, offset) : parseTerm(input, offset);
    if (parsed === undefined) return undefined;
    offset = parsed.nextOffset;
    clauses.push({ kind: parsed.kind, modifier, value: parsed.value });
  }

  return clauses;
}

type ParsedAtom = Readonly<{
  readonly kind: SearchQueryClause["kind"];
  readonly value: string;
  readonly nextOffset: number;
}>;

function parsePhrase(input: string, start: number): ParsedAtom | undefined {
  const end = input.indexOf('"', start + 1);
  if (end < 0) return undefined;

  const raw = input
    .slice(start + 1, end)
    .replace(/\s+/gu, " ")
    .trim();
  if (raw.length === 0 || !SEARCH_TOKEN_CHARACTER.test(raw) || raw.includes("*")) return undefined;

  const nextOffset = end + 1;
  if (nextOffset < input.length && !isWhitespace(input[nextOffset] ?? "")) return undefined;
  return { kind: "phrase", value: raw.normalize("NFC"), nextOffset };
}

function parseTerm(input: string, start: number): ParsedAtom | undefined {
  let end = start;
  while (end < input.length && !isWhitespace(input[end] ?? "")) end += 1;
  const raw = input.slice(start, end);
  if (raw.length === 0 || raw.includes('"') || hasFtsOperatorCharacter(raw)) return undefined;

  let value = raw;
  let kind: SearchQueryClause["kind"] = "term";
  const star = raw.indexOf("*");
  if (star >= 0) {
    if (star !== raw.length - 1 || raw.indexOf("*", star + 1) >= 0) return undefined;
    value = raw.slice(0, -1);
    kind = "prefix";
  }
  if (
    value.length === 0 ||
    !SEARCH_TOKEN_CHARACTER.test(value) ||
    UNSUPPORTED_OPERATOR.test(value) ||
    NEAR_OPERATOR.test(value)
  ) {
    return undefined;
  }
  return { kind, value: value.normalize("NFC"), nextOffset: end };
}

function compileExpression(clauses: readonly ParsedClause[]): string | undefined {
  const positive = clauses
    .filter((clause) => clause.modifier !== "excluded")
    .map((clause) => quoteClause(clause));
  if (positive.length === 0) return undefined;

  const excluded = clauses
    .filter((clause) => clause.modifier === "excluded")
    .map((clause) => quoteClause(clause));
  return `${positive.join(" AND ")}${excluded.map((clause) => ` NOT ${clause}`).join("")}`;
}

function quoteClause(clause: ParsedClause): string {
  const quoted = `"${clause.value.replaceAll('"', '""')}"`;
  return clause.kind === "prefix" ? `${quoted}*` : quoted;
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
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

function hasFtsOperatorCharacter(value: string): boolean {
  for (const character of value) {
    if ("():{}[]^".includes(character)) return true;
  }
  return false;
}
