import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const manifestDefaultPath = join(
  repositoryRoot,
  "docs/architecture/release-evidence-execution-manifest.v2.json",
);
const receiptFormat = "agent-mail.executable-receipt/v2";

// Every non-timeout threshold must name one of these observable metrics.  The
// registry is deliberately small: kernel metrics come from the process/resource
// probes, while MIME capacity metrics come from the retained fixture observation.
export const thresholdMetricRegistry = Object.freeze({
  processRssBytes: Object.freeze({ kind: "kernel", source: "kernel:ps", unit: "bytes" }),
  fileDescriptors: Object.freeze({ kind: "kernel", source: "kernel:lsof", unit: "descriptors" }),
  sockets: Object.freeze({ kind: "kernel", source: "kernel:lsof", unit: "sockets" }),
  listeners: Object.freeze({ kind: "kernel", source: "kernel:lsof", unit: "listeners" }),
  rowCount: Object.freeze({
    kind: "retained-observation",
    source: "fixture-inventory",
    unit: "rows",
  }),
  p95: Object.freeze({
    kind: "retained-observation",
    source: "benchmark-observation",
    unit: "milliseconds",
  }),
  exportCount: Object.freeze({
    kind: "retained-observation",
    source: "stream-observation",
    unit: "exports",
  }),
  requestCount: Object.freeze({
    kind: "retained-observation",
    source: "stream-observation",
    unit: "requests",
  }),
  itemCount: Object.freeze({
    kind: "retained-observation",
    source: "queue-observation",
    unit: "items",
  }),
  sessionCount: Object.freeze({
    kind: "retained-observation",
    source: "session-observation",
    unit: "sessions",
  }),
  iterationCount: Object.freeze({
    kind: "retained-observation",
    source: "lifecycle-observation",
    unit: "iterations",
  }),
  bytes: Object.freeze({
    kind: "fixture-observation",
    stepId: "mime-250mib",
    source: "fixture-observation",
    unit: "bytes",
    field: "producedBytes",
    assertionField: "expectedBytes",
    operator: "===",
  }),
  peakGrowth: Object.freeze({
    kind: "fixture-observation",
    stepId: "mime-250mib",
    source: "fixture-observation",
    unit: "bytes",
    field: "peakRssGrowthBytes",
    assertionField: "expectedPeakGrowthBytes",
    operator: "<",
  }),
});

export const numericSourceConstantRegistry = Object.freeze({
  "mime-rss-growth-threshold": Object.freeze({
    sourcePath: "packages/imap/test/mime-capacity-p2-c11.ts",
    exportName: "RSS_GROWTH_THRESHOLD_BYTES",
    expression: "128 * MEBIBYTE",
    value: 134217728,
    fixtureAssertionId: "mime-fixture-observation",
    fixtureAssertionField: "expectedPeakGrowthBytes",
    thresholdMetric: "peakGrowth",
    thresholdField: "limit",
  }),
});

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(`release evidence capture failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 32 * 1024 * 1024 }).trim();
}

function gitStatus(root) {
  return gitStatusEntries(root).map((entry) => entry.path);
}

function gitStatusEntries(root) {
  return execFileSync("git", ["status", "--short", "--untracked-files=all", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
}

function repositorySnapshot(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
    status: gitStatus(root),
    submodules: git(root, ["submodule", "status", "--recursive"]),
  };
}

function isAllowedUntracked(path, allowlist = []) {
  const normalized = path.replace(/\/+$/u, "");
  return allowlist.some((entry) => normalized === entry.replace(/\/+$/u, ""));
}

function assertCleanCandidate(root, allowlist = []) {
  const snapshot = repositorySnapshot(root);
  const forbidden = gitStatusEntries(root).filter(
    (entry) => entry.code !== "??" || !isAllowedUntracked(entry.path, allowlist),
  );
  assert(
    forbidden.length === 0,
    `candidate worktree is dirty: ${forbidden.map((entry) => `${entry.code} ${entry.path}`).join(", ")}`,
  );
  return snapshot;
}

function installFrozenDependencies(checkout, manifest, { selfTest = false } = {}) {
  const dependencyMode = manifest.runner?.dependencyMode;
  if (selfTest) return { mode: "bun-frozen-offline", installed: false, selfTest: true };
  if (!dependencyMode) return { mode: "none", installed: false };
  assert(dependencyMode === "bun-frozen-offline", "unsupported dependency mode");
  assert(
    existsSync(join(checkout, "package.json")) && existsSync(join(checkout, "bun.lock")),
    "frozen dependency inputs are missing",
  );
  execFileSync("bun", ["install", "--frozen-lockfile", "--offline"], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const status = gitStatusEntries(checkout);
  const dependencyDrift = status.filter((entry) => {
    const normalized = entry.path.replace(/\/+$/u, "");
    return !(
      entry.code === "??" &&
      (normalized === "node_modules" ||
        normalized.startsWith("node_modules/") ||
        normalized === "packages/cli/node_modules" ||
        normalized.startsWith("packages/cli/node_modules/") ||
        normalized === "packages/daemon/node_modules" ||
        normalized.startsWith("packages/daemon/node_modules/") ||
        normalized === "packages/imap/node_modules" ||
        normalized.startsWith("packages/imap/node_modules/") ||
        normalized === "packages/storage/node_modules" ||
        normalized.startsWith("packages/storage/node_modules/"))
    );
  });
  assert(
    dependencyDrift.length === 0,
    `dependency install changed committed candidate files: ${dependencyDrift
      .slice(0, 3)
      .map((entry) => `${entry.code} ${entry.path}`)
      .join(", ")}`,
  );
  return {
    mode: dependencyMode,
    installed: true,
    packageManifestSha256: sha256(readFileSync(join(checkout, "package.json"))),
    lockfileSha256: sha256(readFileSync(join(checkout, "bun.lock"))),
  };
}

function regularPath(root, path, label) {
  assert(typeof path === "string" && path.length > 0, `${label} path is missing`);
  assert(!isAbsolute(path) && !path.includes("\\"), `${label} path is not candidate-relative`);
  const normalized = path.split("/");
  assert(
    normalized.every((part) => part && part !== "." && part !== ".."),
    `${label} path traverses`,
  );
  const absolute = resolve(root, path);
  assert(relative(root, absolute) === path, `${label} path escapes repository`);
  const stat = lstatSync(absolute);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
  return absolute;
}

function committedBlob(root, commit, path, label) {
  const entry = git(root, ["ls-tree", "-z", commit, "--", path]).replace(/\0+$/u, "");
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
  assert(match?.[3] === path, `${label} is not a regular committed blob`);
  const bytes = execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { bytes, gitBlob: match[2], sha256: sha256(bytes) };
}

function committedText(root, commit, path, label) {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    fail(`${label} is not committed`);
  }
}

const numericSourceIdentifierAllowlist = Object.freeze(["MEBIBYTE"]);
const numericSourceExpressionPattern = /^(?:0|[1-9](?:_?[0-9])*)(?:\s*[*/]\s*[A-Z][A-Z0-9_]*)?$/u;

function skipQuotedSource(source, start, quote) {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      assert(cursor + 1 < source.length, "numeric source quoted string is unterminated");
      cursor += 2;
    } else if (source[cursor] === quote) {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  fail("numeric source quoted string is unterminated");
}

function skipLineComment(source, start) {
  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source, start) {
  const end = source.indexOf("*/", start + 2);
  assert(end !== -1, "numeric source block comment is unterminated");
  return end + 2;
}

const regexKeywordAllowlist = Object.freeze([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const regexControlHeaderKeywords = Object.freeze(["if", "while", "for", "with", "switch", "catch"]);
const objectBracePreviousValues = Object.freeze(["=", "(", "[", ",", ":", "?", "return", "yield"]);

function delimiterFrame(character, previous) {
  if (character === "(") {
    return {
      open: character,
      kind:
        previous?.kind === "identifier" && regexControlHeaderKeywords.includes(previous.value)
          ? "control-header"
          : "parenthesis",
    };
  }
  if (character === "{") {
    return {
      open: character,
      kind:
        previous?.value === "=>" ||
        previous?.value === ")" ||
        previous?.value === "else" ||
        previous?.value === "do" ||
        previous?.value === "try" ||
        previous?.value === "finally" ||
        !previous ||
        !objectBracePreviousValues.includes(previous.value)
          ? "block"
          : "object",
    };
  }
  return { open: character, kind: character };
}

function regexLiteralAllowed(previous) {
  if (!previous) return true;
  if (previous.regexAfterClose === true) return true;
  if (previous.kind === "identifier") return regexKeywordAllowlist.includes(previous.value);
  if (["number", "literal", "regex"].includes(previous.kind)) return false;
  return ![")", "]", "}"].includes(previous.value);
}

function skipRegexLiteral(source, start) {
  let cursor = start + 1;
  let characterClass = false;
  while (cursor < source.length) {
    const character = source[cursor];
    assert(character !== "\n" && character !== "\r", "numeric source regex contains a newline");
    if (character === "\\") {
      assert(cursor + 1 < source.length, "numeric source regex escape is unterminated");
      assert(
        source[cursor + 1] !== "\n" && source[cursor + 1] !== "\r",
        "numeric source regex escape is invalid",
      );
      cursor += 2;
      continue;
    }
    if (character === "[") {
      characterClass = true;
      cursor += 1;
      continue;
    }
    if (character === "]" && characterClass) {
      characterClass = false;
      cursor += 1;
      continue;
    }
    if (character === "/" && !characterClass) {
      cursor += 1;
      const flags = new Set();
      while (cursor < source.length && /[A-Za-z]/u.test(source[cursor])) {
        const flag = source[cursor];
        assert(
          "dgimsuvy".includes(flag) && !flags.has(flag),
          "numeric source regex flags are invalid",
        );
        flags.add(flag);
        cursor += 1;
      }
      assert(!(flags.has("u") && flags.has("v")), "numeric source regex flags are invalid");
      return cursor;
    }
    cursor += 1;
  }
  assert(!characterClass, "numeric source regex character class is unterminated");
  fail("numeric source regex is unterminated");
}

function skipTemplateInterpolation(source, start) {
  let cursor = start;
  const delimiters = [delimiterFrame("{", null)];
  let previous = null;
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/y;
  const integer = /(?:0|[1-9](?:_?[0-9])*)/y;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "/") {
      cursor = skipLineComment(source, cursor);
    } else if (character === "/" && source[cursor + 1] === "*") {
      cursor = skipBlockComment(source, cursor);
    } else if (character === "'" || character === '"') {
      cursor = skipQuotedSource(source, cursor, character);
      previous = { kind: "literal", value: "<string>" };
    } else if (character === "`") {
      cursor = skipTemplateLiteral(source, cursor);
      previous = { kind: "literal", value: "<template>" };
    } else if (character === "/" && source[cursor + 1] !== "=" && regexLiteralAllowed(previous)) {
      cursor = skipRegexLiteral(source, cursor);
      previous = { kind: "regex", value: "<regex>" };
    } else {
      identifier.lastIndex = cursor;
      const identifierMatch = identifier.exec(source);
      if (identifierMatch) {
        previous = { kind: "identifier", value: identifierMatch[0] };
        cursor = identifier.lastIndex;
        continue;
      }
      integer.lastIndex = cursor;
      const integerMatch = integer.exec(source);
      if (integerMatch) {
        previous = { kind: "number", value: integerMatch[0] };
        cursor = integer.lastIndex;
        continue;
      }
      if (character === "{" || character === "[" || character === "(") {
        delimiters.push(delimiterFrame(character, previous));
      } else if (character === "}" || character === "]" || character === ")") {
        const expected = character === "}" ? "{" : character === "]" ? "[" : "(";
        const frame = delimiters.at(-1);
        assert(frame?.open === expected, "numeric source template delimiter mismatch");
        delimiters.pop();
        if (delimiters.length === 0) return cursor + 1;
        previous = {
          kind: "punctuation",
          value: character,
          regexAfterClose:
            (character === ")" && frame.kind === "control-header") ||
            (character === "}" && frame.kind === "block"),
        };
        cursor += 1;
        continue;
      }
      previous = { kind: "punctuation", value: character };
      cursor += 1;
    }
  }
  fail("numeric source template interpolation is unterminated");
}

function skipTemplateLiteral(source, start) {
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      assert(cursor + 1 < source.length, "numeric source template is unterminated");
      cursor += 2;
    } else if (character === "`") {
      return cursor + 1;
    } else if (character === "$" && source[cursor + 1] === "{") {
      cursor = skipTemplateInterpolation(source, cursor + 2);
    } else {
      cursor += 1;
    }
  }
  fail("numeric source template is unterminated");
}

function sourceTokens(source) {
  const tokens = [];
  const delimiters = [];
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/y;
  const integer = /(?:0|[1-9](?:_?[0-9])*)/y;
  let cursor = 0;
  let previous = null;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "/") {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    if (character === "'" || character === '"') {
      cursor = skipQuotedSource(source, cursor, character);
      previous = { kind: "literal", value: "<string>" };
      continue;
    }
    if (character === "`") {
      cursor = skipTemplateLiteral(source, cursor);
      previous = { kind: "literal", value: "<template>" };
      continue;
    }
    if (character === "/" && source[cursor + 1] !== "=" && regexLiteralAllowed(previous)) {
      const start = cursor;
      cursor = skipRegexLiteral(source, cursor);
      const token = { value: "<regex>", start, end: cursor, depth: delimiters.length };
      tokens.push(token);
      previous = { kind: "regex", value: "<regex>" };
      continue;
    }
    identifier.lastIndex = cursor;
    const identifierMatch = identifier.exec(source);
    if (identifierMatch) {
      const token = {
        value: identifierMatch[0],
        start: cursor,
        end: identifier.lastIndex,
        depth: delimiters.length,
      };
      tokens.push(token);
      previous = { kind: "identifier", value: token.value };
      cursor = identifier.lastIndex;
      continue;
    }
    integer.lastIndex = cursor;
    const integerMatch = integer.exec(source);
    if (integerMatch) {
      const token = {
        value: integerMatch[0],
        start: cursor,
        end: integer.lastIndex,
        depth: delimiters.length,
      };
      tokens.push(token);
      previous = { kind: "number", value: token.value };
      cursor = integer.lastIndex;
      continue;
    }
    const depth = delimiters.length;
    let closedFrame;
    if (character === "}" || character === "]" || character === ")") {
      const expected = character === "}" ? "{" : character === "]" ? "[" : "(";
      closedFrame = delimiters.at(-1);
      assert(closedFrame?.open === expected, "numeric source delimiter mismatch");
      delimiters.pop();
    }
    const openerPrevious = previous;
    const token = { value: character, start: cursor, end: cursor + 1, depth };
    tokens.push(token);
    previous = {
      kind: "punctuation",
      value: character,
      regexAfterClose:
        (character === ")" && closedFrame?.kind === "control-header") ||
        (character === "}" && closedFrame?.kind === "block"),
    };
    if (character === "{" || character === "[" || character === "(") {
      delimiters.push(delimiterFrame(character, openerPrevious));
    }
    cursor += 1;
  }
  assert(delimiters.length === 0, "numeric source delimiter is unterminated");
  return tokens;
}

function numericSourceDeclarations(source) {
  const tokens = sourceTokens(source);
  const declarations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const exportToken = tokens[index];
    const constToken = tokens[index + 1];
    const nameToken = tokens[index + 2];
    if (
      exportToken?.depth !== 0 ||
      exportToken.value !== "export" ||
      constToken?.depth !== 0 ||
      constToken.value !== "const" ||
      nameToken?.depth !== 0
    )
      continue;
    const declaration = { name: nameToken.value, expression: null };
    const equals = tokens[index + 3];
    const first = tokens[index + 4];
    if (equals?.depth === 0 && equals.value === "=" && first?.depth === 0) {
      const number = Number(first.value.replaceAll("_", ""));
      const operator = tokens[index + 5];
      const identifierToken = tokens[index + 6];
      const semicolon = tokens[index + 7];
      const validInteger = /^\d(?:_?\d)*$/u.test(first.value) && Number.isSafeInteger(number);
      const validIdentifier =
        identifierToken?.depth === 0 &&
        numericSourceIdentifierAllowlist.includes(identifierToken.value);
      const validExpression =
        validInteger &&
        (operator?.value === ";" ||
          ((operator?.value === "*" || operator?.value === "/") &&
            validIdentifier &&
            semicolon?.value === ";"));
      if (validExpression) {
        const expressionEnd = operator.value === ";" ? operator.start : identifierToken.end;
        declaration.expression = source.slice(first.start, expressionEnd).trim();
      }
    }
    declarations.push(declaration);
  }
  return declarations;
}

function validateCommittedTypeScriptSyntax(source, label) {
  const transpilerConstructor = globalThis.Bun?.Transpiler;
  assert(
    typeof transpilerConstructor === "function",
    `${label} TypeScript syntax parser is unavailable`,
  );
  try {
    new transpilerConstructor({ loader: "ts" }).transformSync(source);
  } catch {
    fail(`${label} TypeScript syntax is invalid`);
  }
}

function validateNumericSourceConstants(step, root, commit) {
  const fixtureAssertions = step.assertions.filter(
    (assertion) => assertion.kind === "fixture-observation",
  );
  const constants = step.numericSourceConstants;
  if (fixtureAssertions.length === 0) {
    assert(constants === undefined, `${step.id} numeric source constants are unbound`);
    return;
  }
  assert(
    Array.isArray(constants) && constants.length === fixtureAssertions.length,
    `${step.id} numeric source constants are incomplete`,
  );
  const ids = new Set();
  for (const constant of constants) {
    assert(
      constant &&
        typeof constant.id === "string" &&
        constant.id.length > 0 &&
        !ids.has(constant.id),
      `${step.id} numeric source constant ID repeats`,
    );
    ids.add(constant.id);
    const registered = numericSourceConstantRegistry[constant.id];
    assert(registered, `${step.id} numeric source constant is not registered`);
    for (const field of [
      "sourcePath",
      "exportName",
      "expression",
      "value",
      "fixtureAssertionId",
      "fixtureAssertionField",
      "thresholdMetric",
      "thresholdField",
    ])
      assert(
        constant[field] === registered[field],
        `${step.id} numeric source constant authority drifted`,
      );
    assert(
      typeof constant.sourcePath === "string" &&
        step.sources.some((source) => source.path === constant.sourcePath),
      `${step.id} numeric source constant path is not source-bound`,
    );
    assert(
      typeof constant.exportName === "string" && /^[A-Z][A-Z0-9_]*$/u.test(constant.exportName),
      `${step.id} numeric source constant export is invalid`,
    );
    assert(
      Number.isSafeInteger(constant.value) && constant.value > 0,
      `${step.id} numeric source constant value is invalid`,
    );
    assert(
      typeof constant.expression === "string" &&
        numericSourceExpressionPattern.test(constant.expression),
      `${step.id} numeric source constant expression is invalid`,
    );
    assert(
      typeof constant.fixtureAssertionId === "string" &&
        constant.fixtureAssertionField === "expectedPeakGrowthBytes" &&
        constant.thresholdMetric === "peakGrowth" &&
        constant.thresholdField === "limit",
      `${step.id} numeric source constant authority is invalid`,
    );
    const fixtureAssertion = fixtureAssertions.find(
      (assertion) => assertion.id === constant.fixtureAssertionId,
    );
    assert(
      fixtureAssertion && fixtureAssertion.expectedPeakGrowthBytes === constant.value,
      `${step.id} numeric source constant fixture binding is detached`,
    );
    const threshold = step.thresholds[constant.thresholdMetric];
    assert(
      threshold && threshold[constant.thresholdField] === constant.value,
      `${step.id} numeric source constant threshold binding is detached`,
    );
    const source = committedText(root, commit, constant.sourcePath, `${step.id} numeric source`);
    validateCommittedTypeScriptSyntax(source, `${step.id} numeric source`);
    const declarations = numericSourceDeclarations(source).filter(
      (declaration) => declaration.name === constant.exportName,
    );
    assert(
      declarations.length === 1,
      `${step.id} numeric source constant declaration is missing or ambiguous`,
    );
    assert(
      declarations[0].expression === constant.expression,
      `${step.id} numeric source constant declaration drifted`,
    );
  }
}

function sourceBindings(manifest, root, commit) {
  const all = [];
  for (const step of manifest.steps) {
    for (const source of step.sources ?? []) all.push(source);
  }
  for (const source of manifest.runner?.sources ?? []) all.push(source);
  const unique = new Map();
  for (const source of all) {
    const previous = unique.get(source.path);
    assert(
      !previous || (previous.gitBlob === source.gitBlob && previous.sha256 === source.sha256),
      `source ${source.path} binding is inconsistent`,
    );
    unique.set(source.path, source);
  }
  return [...unique.values()].map((source) => {
    const actual = committedBlob(root, commit, source.path, `source ${source.path}`);
    assert(source.gitBlob === actual.gitBlob, `source ${source.path} Git blob drifted`);
    assert(source.sha256 === actual.sha256, `source ${source.path} SHA-256 drifted`);
    return {
      role: source.role,
      path: source.path,
      gitBlob: actual.gitBlob,
      sha256: actual.sha256,
    };
  });
}

function stepSourceBindings(step, root, commit) {
  const seen = new Set();
  return (step.sources ?? []).map((source) => {
    assert(!seen.has(source.path), `${step.id} source binding repeats ${source.path}`);
    seen.add(source.path);
    const actual = committedBlob(root, commit, source.path, `${step.id} source ${source.path}`);
    assert(source.gitBlob === actual.gitBlob, `${step.id} source ${source.path} Git blob drifted`);
    assert(source.sha256 === actual.sha256, `${step.id} source ${source.path} SHA-256 drifted`);
    return { role: source.role, path: source.path, gitBlob: actual.gitBlob, sha256: actual.sha256 };
  });
}

function validateAssertion(assertion, step) {
  assert(assertion && typeof assertion.id === "string", `${step.id} assertion id is missing`);
  assert(typeof assertion.kind === "string", `${step.id} assertion kind is missing`);
  if (assertion.kind === "source-token") {
    assert(
      step.sources.some((source) => source.path === assertion.sourcePath),
      `${step.id} source-token assertion is not source-bound`,
    );
    assert(
      typeof assertion.token === "string" && assertion.token.length > 0,
      `${step.id} source token is missing`,
    );
    assert(
      Number.isSafeInteger(assertion.occurrences) && assertion.occurrences >= 1,
      `${step.id} source token occurrence count is invalid`,
    );
  } else if (assertion.kind === "fixture-observation") {
    assert(
      step.sources.some((source) => source.path === assertion.sourcePath),
      `${step.id} fixture observation is not source-bound`,
    );
    assert(
      typeof assertion.fixtureId === "string" && assertion.fixtureId.length > 0,
      `${step.id} fixture observation id is missing`,
    );
    assert(
      Number.isSafeInteger(assertion.expectedBytes) && assertion.expectedBytes > 0,
      `${step.id} fixture observation byte target is invalid`,
    );
    assert(
      Number.isSafeInteger(assertion.expectedPeakGrowthBytes) &&
        assertion.expectedPeakGrowthBytes > 0,
      `${step.id} fixture observation growth target is invalid`,
    );
  } else if (assertion.kind === "structured-oracle") {
    assert(
      typeof assertion.event === "string" && assertion.event.length > 0,
      `${step.id} oracle event is missing`,
    );
    assert(
      typeof assertion.path === "string" &&
        step.sources.some((source) => source.path === assertion.path),
      `${step.id} oracle path is not source-bound`,
    );
    assert(/^[0-9a-f]{64}$/u.test(assertion.sha256 ?? ""), `${step.id} oracle digest is missing`);
    assert(
      typeof assertion.pointer === "string" && assertion.pointer.startsWith("/"),
      `${step.id} oracle pointer is missing`,
    );
    assert(assertion.value !== undefined, `${step.id} oracle value is missing`);
  } else if (assertion.kind === "exitCode") {
    assert(Number.isInteger(assertion.expected), `${step.id} exit expectation is invalid`);
  } else {
    fail(`${step.id} assertion kind ${assertion.kind} is not runner-supported`);
  }
}

function resolveJsonPointer(document, pointer) {
  assert(pointer === "" || pointer.startsWith("/"), "oracle JSON pointer is invalid");
  let value = document;
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    assert(
      value !== null && value !== undefined && Object.hasOwn(value, key),
      "oracle JSON pointer is missing",
    );
    value = value[key];
  }
  return value;
}

function deepJsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function validateManifest(
  manifest,
  root,
  commit = git(root, ["rev-parse", "HEAD"]),
  { selfTest = false } = {},
) {
  assert(
    manifest?.format === "agent-mail.release-evidence-execution-manifest/v2",
    "manifest format",
  );
  assert(manifest.schemaVersion === 2, "manifest schema version");
  assert(manifest.ownerIssueId === 176, "manifest owner is not #176");
  assert(Array.isArray(manifest.steps) && manifest.steps.length > 0, "manifest steps are missing");
  assert(manifest.replay?.required === true, "independent replay is not required");
  assert(
    Array.isArray(manifest.attackInventory) && manifest.attackInventory.length >= 40,
    "attack inventory is incomplete",
  );
  assert(
    new Set(manifest.attackInventory).size === manifest.attackInventory.length,
    "attack inventory repeats a seam",
  );
  for (const path of manifest.runner?.untrackedAllowlist ?? []) {
    assert(
      typeof path === "string" &&
        path.length > 0 &&
        !isAbsolute(path) &&
        !path.includes("\\") &&
        path.split("/").every((part) => part && part !== "." && part !== ".."),
      "runner untracked allowlist is malformed",
    );
  }
  if (!selfTest) {
    assert(
      manifest.runner?.dependencyMode === "bun-frozen-offline",
      "runner dependency mode must be bun-frozen-offline",
    );
    assert(
      Array.isArray(manifest.runner?.sources) && manifest.runner.sources.length > 0,
      "runner source bindings are missing",
    );
    for (const source of manifest.runner.sources) {
      assert(source.role && typeof source.path === "string", "runner source binding is incomplete");
      assert(/^[0-9a-f]{40}$/u.test(source.gitBlob ?? ""), "runner source Git blob is missing");
      assert(/^[0-9a-f]{64}$/u.test(source.sha256 ?? ""), "runner source SHA-256 is missing");
    }
  }
  const seen = new Set();
  for (const step of manifest.steps) {
    assert(typeof step.id === "string" && !seen.has(step.id), `duplicate manifest step ${step.id}`);
    seen.add(step.id);
    assert(Array.isArray(step.argv) && step.argv.length > 1, `${step.id} argv is missing`);
    assert(
      step.argv.every((arg) => typeof arg === "string" && arg.length > 0),
      `${step.id} argv is malformed`,
    );
    assert(
      ["bun", "node", "python3", "swift", "xcodebuild"].includes(step.argv[0]),
      `${step.id} executable is not allowlisted`,
    );
    assert(typeof step.cwd === "string" && !isAbsolute(step.cwd), `${step.id} cwd is not relative`);
    assert(step.cwd === "." || !step.cwd.split("/").includes(".."), `${step.id} cwd traverses`);
    assert(
      Array.isArray(step.sources) && step.sources.length > 0,
      `${step.id} source bindings are missing`,
    );
    for (const source of step.sources) {
      assert(
        source.role && typeof source.path === "string",
        `${step.id} source binding is incomplete`,
      );
      assert(/^[0-9a-f]{40}$/u.test(source.gitBlob ?? ""), `${step.id} source Git blob is missing`);
      assert(/^[0-9a-f]{64}$/u.test(source.sha256 ?? ""), `${step.id} source SHA-256 is missing`);
    }
    assert(
      Array.isArray(step.assertions) && step.assertions.length > 0,
      `${step.id} assertions are missing`,
    );
    const assertionIds = new Set();
    for (const assertion of step.assertions) {
      assert(!assertionIds.has(assertion.id), `${step.id} assertion id repeats`);
      assertionIds.add(assertion.id);
    }
    for (const assertion of step.assertions) validateAssertion(assertion, step);
    for (const assertion of step.assertions.filter(
      (candidate) => candidate.kind === "structured-oracle",
    )) {
      const source = step.sources.find((candidate) => candidate.path === assertion.path);
      assert(source.sha256 === assertion.sha256, `${step.id} oracle digest is detached`);
    }
    assert(
      step.observations && step.thresholds && Array.isArray(step.probes),
      `${step.id} observation authority is incomplete`,
    );
    const allowedProbes = new Set([
      "processTreeRss",
      "fileDescriptors",
      "sockets",
      "listeners",
      "HermesLease",
      "streams",
      "tempRoot",
      "streamCompletion",
      "sqliteIntegrity",
      "sqliteForeignKeys",
      "queryPlan",
      "sqliteClose",
      "queueCompletion",
      "childActors",
      "process",
    ]);
    for (const probe of step.probes)
      assert(
        typeof probe === "string" && allowedProbes.has(probe),
        `${step.id} probe is not allowlisted`,
      );
    for (const [metric, threshold] of Object.entries(step.thresholds)) {
      if (metric === "timeoutMs") continue;
      const metricSpec = thresholdMetricRegistry[metric];
      assert(
        threshold &&
          metricSpec &&
          typeof threshold.source === "string" &&
          threshold.source.length > 0 &&
          ["<", "<=", "===", ">=", ">"].includes(threshold.operator) &&
          typeof threshold.unit === "string" &&
          threshold.unit.length > 0 &&
          Number.isFinite(threshold.limit) &&
          threshold.limit >= 0 &&
          threshold.source === metricSpec.source &&
          threshold.unit === metricSpec.unit &&
          (!metricSpec.stepId || metricSpec.stepId === step.id) &&
          (!metricSpec.operator || metricSpec.operator === threshold.operator),
        `${step.id} threshold ${metric} source/operator/unit is incomplete`,
      );
    }
    validateNumericSourceConstants(step, root, commit);
    for (const [metric, threshold] of Object.entries(step.thresholds)) {
      if (metric === "timeoutMs" || threshold?.source !== "fixture-observation") continue;
      const metricSpec = thresholdMetricRegistry[metric];
      const fixtureAssertion = step.assertions.find(
        (assertion) =>
          assertion.kind === "fixture-observation" &&
          assertion.sourcePath &&
          step.sources.some((source) => source.path === assertion.sourcePath),
      );
      assert(
        metricSpec?.kind === "fixture-observation" &&
          typeof metricSpec.assertionField === "string" &&
          fixtureAssertion &&
          Number.isSafeInteger(fixtureAssertion[metricSpec.assertionField]) &&
          threshold.limit === fixtureAssertion[metricSpec.assertionField],
        `${step.id} threshold ${metric} limit is detached from fixture observation`,
      );
    }
    if (step.fixture !== undefined) {
      assert(
        step.fixture &&
          ["generated-stream", "generated-file", "committed-bytes"].includes(step.fixture.kind),
        `${step.id} fixture kind is invalid`,
      );
      assert(
        typeof step.fixture.id === "string" &&
          step.fixture.id.length > 0 &&
          !isAbsolute(step.fixture.id) &&
          !step.fixture.id.includes("\\") &&
          step.fixture.id.split("/").every((part) => part && part !== "." && part !== ".."),
        `${step.id} fixture id is unsafe`,
      );
      if (step.fixture.kind === "generated-stream" && step.fixture.minimumBytes !== undefined) {
        assert(
          Number.isSafeInteger(step.fixture.minimumBytes) && step.fixture.minimumBytes >= 0,
          `${step.id} stream fixture size is invalid`,
        );
      }
      if (step.fixture.kind === "generated-file" && step.fixture.generationStepId !== undefined) {
        assert(
          typeof step.fixture.generationStepId === "string" &&
            step.fixture.generationStepId.length > 0 &&
            step.fixture.generationStepId !== step.id &&
            seen.has(step.fixture.generationStepId),
          `${step.id} generation receipt source is invalid`,
        );
      }
    }
    const helperPath = "scripts/capacity/source-token-event.ts";
    const importsSourceTokenHelper = step.sources.some((source) => {
      if (source.path === helperPath) return false;
      try {
        return committedText(root, commit, source.path, `${step.id} source`).includes(
          "source-token-event",
        );
      } catch {
        return false;
      }
    });
    if (importsSourceTokenHelper) {
      assert(
        step.sources.some((source) => source.path === helperPath),
        `${step.id} source-token helper binding is missing`,
      );
    }
  }
  const bindings = sourceBindings(manifest, root, commit);
  assert(bindings.length > 0, "manifest has no source bindings");
  return bindings;
}

function runtimeDigest() {
  try {
    return sha256(readFileSync(process.execPath));
  } catch {
    return null;
  }
}

function optionalDigest(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function filesystemIdentity(path, label, canonical = false) {
  const stat = lstatSync(path);
  assert(
    stat.isDirectory() || (stat.isFile() && !stat.isSymbolicLink()),
    `${label} is not a regular path`,
  );
  return {
    path: canonical ? realpathSync(path) : path,
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
  };
}

function provenanceArtifact(outputRoot, ref, label, capturedAt) {
  const path = resolve(outputRoot, ref.path);
  const identity = filesystemIdentity(path, label);
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  assert(
    bytes.length === ref.bytes && digest === ref.sha256,
    `${label} changed during provenance capture`,
  );
  return {
    path: ref.path,
    dev: identity.dev,
    ino: identity.ino,
    bytes: bytes.length,
    sha256: digest,
    capturedAt,
    birthtimeMs: identity.birthtimeMs,
    ctimeMs: identity.ctimeMs,
    mtimeMs: identity.mtimeMs,
  };
}

function receiptCore(receipt) {
  const core = structuredClone(receipt);
  delete core.provenance;
  return core;
}

function provenanceObservations(receipt) {
  return {
    process: receipt.process,
    processProbe: receipt.probes.process,
    resources: receipt.probes.resources,
    termination: receipt.probes.cleanup.termination,
    cleanup: receipt.probes.cleanup,
    streams: receipt.probes.streams,
    monotonic: receipt.monotonic,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    result: receipt.result,
    observedOutcome: receipt.observedOutcome,
  };
}

function ownerRelativePath(root, path, label) {
  const rootPath = resolve(root);
  const absolutePath = resolve(path);
  const relativePath = relative(rootPath, absolutePath);
  assert(
    relativePath.length > 0 &&
      !relativePath.startsWith("..") &&
      !isAbsolute(relativePath) &&
      !relativePath.includes("\\") &&
      relativePath.split("/").every((part) => part && part !== "." && part !== ".."),
    `${label} path escaped owner root`,
  );
  return relativePath;
}

function fileDigest(path, label) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function outputRef(root, outputRoot, runId, filename, bytes) {
  const path = join(outputRoot, runId, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  return retainedFileRef(root, outputRoot, path, bytes.length, sha256(bytes), "output");
}

function retainedFileRef(root, outputRoot, path, expectedBytes, expectedSha256, label) {
  const relativePath = ownerRelativePath(root, path, label);
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular non-symlink file`);
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  assert(bytes.length === expectedBytes, `${label} byte count drifted`);
  assert(digest === expectedSha256, `${label} digest drifted`);
  return { path: relativePath, sha256: digest, bytes: bytes.length };
}

function assertAbsent(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`${label} already exists before execution (${stat.isSymbolicLink() ? "symlink" : "path"})`);
}

export function cleanGeneratedStaging(path) {
  for (const suffix of ["", ".inventory.json", "-wal", "-shm"]) {
    const candidate = `${path}${suffix}`;
    if (existsSync(candidate)) rmSync(candidate, { force: true });
  }
}

export function retainGeneratedArtifact(outputRoot, fixture, sourcePath, runId) {
  const source = fileDigest(sourcePath, "generated SQLite artifact");
  const sourceInventoryPath = `${sourcePath}.inventory.json`;
  const sourceInventory = fileDigest(sourceInventoryPath, "generated inventory");
  const inventory = JSON.parse(readFileSync(sourceInventoryPath, "utf8"));
  assert(
    typeof inventory.logicalChecksum === "string" &&
      /^[0-9a-f]{64}$/u.test(inventory.logicalChecksum),
    "generated inventory logical checksum is missing",
  );
  const retainedPath = join(
    outputRoot,
    runId,
    "retained",
    `${fixture.id ?? "generated-artifact"}.sqlite`,
  );
  const retainedInventoryPath = `${retainedPath}.inventory.json`;
  mkdirSync(dirname(retainedPath), { recursive: true });
  assertAbsent(retainedPath, "retained generated SQLite artifact");
  assertAbsent(retainedInventoryPath, "retained generated inventory");
  cpSync(sourcePath, retainedPath);
  cpSync(sourceInventoryPath, retainedInventoryPath);
  const retained = fileDigest(retainedPath, "retained generated SQLite artifact");
  const retainedInventory = fileDigest(retainedInventoryPath, "retained generated inventory");
  assert(
    retained.sha256 === source.sha256 && retained.bytes === source.bytes,
    "retained generated SQLite artifact drifted",
  );
  assert(
    retainedInventory.sha256 === sourceInventory.sha256 &&
      retainedInventory.bytes === sourceInventory.bytes,
    "retained generated inventory drifted",
  );
  return {
    path: retainedPath,
    relativePath: ownerRelativePath(outputRoot, retainedPath, "retained generated artifact"),
    inventoryPath: retainedInventoryPath,
    inventoryRelativePath: ownerRelativePath(
      outputRoot,
      retainedInventoryPath,
      "retained generated inventory",
    ),
    artifactSha256: retained.sha256,
    artifactBytes: retained.bytes,
    inventorySha256: retainedInventory.sha256,
    inventoryBytes: retainedInventory.bytes,
    logicalChecksum: inventory.logicalChecksum,
  };
}

async function validateGeneratedSearchArtifact(path, checkout, expectedInventory) {
  const physical = fileDigest(path, "search artifact");
  const inventoryPath = `${path}.inventory.json`;
  const inventoryStat = lstatSync(inventoryPath);
  assert(
    inventoryStat.isFile() && !inventoryStat.isSymbolicLink(),
    "search inventory is not a regular non-symlink file",
  );
  const inventoryBytes = readFileSync(inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  assert(inventory.messages === 250000, "search inventory row count drifted");
  assert(inventory.bytes === physical.bytes, "search inventory byte count drifted");
  assert(
    typeof inventory.logicalChecksum === "string" &&
      /^[0-9a-f]{64}$/u.test(inventory.logicalChecksum),
    "search logical checksum is missing",
  );
  if (expectedInventory !== undefined)
    assert(
      canonicalJson(inventory) === canonicalJson(expectedInventory),
      "search inventory drifted",
    );
  const generator = await import(
    pathToFileURL(join(repositoryRoot, "scripts/capacity/generate-search-corpus.ts")).href
  );
  const sqlite = await import("bun:sqlite");
  const database = new sqlite.Database(path);
  try {
    generator.validateCorpusInventory(database, inventory);
  } finally {
    database.close();
  }
  const after = fileDigest(path, "search artifact");
  assert(
    after.sha256 === physical.sha256 && after.bytes === physical.bytes,
    "search artifact changed during validation",
  );
  return {
    physicalSha256: physical.sha256,
    bytes: physical.bytes,
    inventorySha256: sha256(inventoryBytes),
    logicalChecksum: inventory.logicalChecksum,
    inventory,
  };
}

export function generationReceipt(receiptPath, outputRoot, fixture, candidateCommit) {
  assert(receiptPath, `${fixture.id} requires a prior generation receipt`);
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  assert(receipt.format === receiptFormat, "generation receipt format is invalid");
  assert(receipt.result === "pass", "generation receipt is not passing");
  assert(
    receipt.manifestStepId === fixture.generationStepId,
    "generation receipt step is detached",
  );
  assert(receipt.candidate?.commit === candidateCommit, "generation receipt candidate is stale");
  const generated = receipt.fixture?.materialized;
  assert(
    generated?.owner === "generator" && generated.presentAfterRun === true,
    "generation receipt fixture is invalid",
  );
  assert(
    /^[0-9a-f]{64}$/u.test(generated.sha256 ?? ""),
    "generation receipt artifact digest is missing",
  );
  assert(
    Number.isSafeInteger(generated.bytes) && generated.bytes > 0,
    "generation receipt artifact bytes are invalid",
  );
  const sourcePath = resolve(outputRoot, generated.path);
  ownerRelativePath(outputRoot, sourcePath, "generation artifact");
  const actual = fileDigest(sourcePath, "generation artifact");
  assert(
    actual.sha256 === generated.sha256 && actual.bytes === generated.bytes,
    "generation artifact drifted",
  );
  const generatedInventory = generated.integrity;
  assert(
    generatedInventory &&
      /^[0-9a-f]{64}$/u.test(generatedInventory.inventorySha256 ?? "") &&
      Number.isSafeInteger(generatedInventory.inventoryBytes) &&
      generatedInventory.inventoryBytes > 0 &&
      /^[0-9a-f]{64}$/u.test(generatedInventory.logicalChecksum ?? ""),
    "generation receipt inventory binding is missing",
  );
  const inventoryPath = `${sourcePath}.inventory.json`;
  const inventory = fileDigest(inventoryPath, "generation inventory");
  const inventoryValue = JSON.parse(readFileSync(inventoryPath, "utf8"));
  assert(
    inventory.sha256 === generatedInventory.inventorySha256 &&
      inventory.bytes === generatedInventory.inventoryBytes &&
      inventoryValue.logicalChecksum === generatedInventory.logicalChecksum,
    "generation inventory drifted",
  );
  const receiptAbsolute = resolve(receiptPath);
  const receiptDigest = sha256(receiptBytes);
  return {
    receiptPath: receiptAbsolute,
    receiptSha256: receiptDigest,
    artifactPath: sourcePath,
    artifactRelativePath: ownerRelativePath(outputRoot, sourcePath, "generation artifact"),
    artifactSha256: actual.sha256,
    artifactBytes: actual.bytes,
    inventoryPath,
    inventoryRelativePath: ownerRelativePath(outputRoot, inventoryPath, "generation inventory"),
    inventorySha256: inventory.sha256,
    inventoryBytes: inventory.bytes,
    logicalChecksum: generatedInventory.logicalChecksum,
  };
}

async function finalizeFixture(fixture, outputRoot, fixturePath, checkout, integrityBefore) {
  if (!fixture?.materialized) return fixture;
  if (fixture.materialized.owner === "observation") return fixture;
  if (fixture.materialized.owner === "generator") {
    ownerRelativePath(outputRoot, fixturePath, "generator fixture");
    const physical = fileDigest(fixturePath, "generator fixture");
    const integrity =
      fixture.rowCount === 250000
        ? await validateGeneratedSearchArtifact(fixturePath, checkout)
        : undefined;
    const inventory = integrity
      ? fileDigest(`${fixturePath}.inventory.json`, "generator inventory")
      : undefined;
    return {
      ...fixture,
      materialized: {
        ...fixture.materialized,
        presentAfterRun: true,
        sha256: physical.sha256,
        bytes: physical.bytes,
        integrity: integrity
          ? { ...integrity, inventorySha256: inventory.sha256, inventoryBytes: inventory.bytes }
          : undefined,
      },
    };
  }
  const materialized = retainedFileRef(
    outputRoot,
    outputRoot,
    fixturePath,
    fixture.materialized.bytes,
    fixture.materialized.sha256,
    "fixture",
  );
  if (integrityBefore !== undefined) {
    const integrityAfter = await validateGeneratedSearchArtifact(
      fixturePath,
      checkout,
      integrityBefore.inventory,
    );
    assert(
      integrityAfter.physicalSha256 === integrityBefore.physicalSha256 &&
        integrityAfter.bytes === integrityBefore.bytes &&
        integrityAfter.logicalChecksum === integrityBefore.logicalChecksum,
      "fixture changed during measurement",
    );
    materialized.integrity = { before: integrityBefore, after: integrityAfter, unchanged: true };
  }
  return { ...fixture, materialized };
}

function now() {
  return new Date().toISOString();
}

const KERNEL_SAMPLE_INTERVAL_MS = 25;
const TERMINATION_GRACE_MS = 100;
const TERMINATION_ESCALATION_MS = 500;

function delay(milliseconds) {
  return new Promise((resolveResult) => setTimeout(resolveResult, milliseconds));
}

function signalTrackedProcesses(rootPid, processGroups, pids, signal) {
  for (const processGroup of processGroups) {
    try {
      process.kill(-processGroup, signal);
    } catch {}
  }
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
  if (Number.isInteger(rootPid) && rootPid > 1 && rootPid !== process.pid) {
    try {
      process.kill(rootPid, signal);
    } catch {}
  }
}

function resourceSummary(samples) {
  const observed = samples.filter((sample) => sample.observed);
  const maximum = (key) => {
    const values = observed.map((sample) => sample[key]).filter(Number.isFinite);
    return values.length > 0 ? Math.max(...values) : null;
  };
  return {
    observed: observed.length > 0,
    pids: [...new Set(samples.flatMap((sample) => sample.pids ?? []))],
    fileDescriptors: maximum("fileDescriptors"),
    sockets: maximum("sockets"),
    listeners: maximum("listeners"),
    hermesPorts: [...new Set(samples.flatMap((sample) => sample.hermesPorts ?? []))].sort(
      (left, right) => left - right,
    ),
    samples,
    ...(observed.length === 0 && samples.at(-1)?.reason ? { reason: samples.at(-1).reason } : {}),
  };
}

function treeSummary(samples) {
  const rssSamples = samples
    .filter((sample) => sample.rssStatus === "observed" && Number.isFinite(sample.rssBytes))
    .map((sample) => sample.rssBytes);
  return {
    observed: samples.some((sample) => sample.rootPresent),
    samples,
    completed: samples.at(-1),
    peakRssBytes: rssSamples.length > 0 ? Math.max(...rssSamples) : null,
    rssStatus: rssSamples.length > 0 ? "observed" : "notApplicable",
  };
}

export function runProcess(argv, cwd, timeoutMs) {
  return new Promise((resolveResult) => {
    const started = process.hrtime.bigint();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const trackedPids = new Set([child.pid]);
    const trackedProcessGroups = new Set([child.pid]);
    const treeSamples = [];
    const resourceSamples = [];
    const sample = () => {
      const tree = processTreeSnapshot(child.pid, [...trackedPids]);
      for (const pid of tree.pids) trackedPids.add(pid);
      for (const processGroup of tree.processGroups ?? []) trackedProcessGroups.add(processGroup);
      treeSamples.push(tree);
      resourceSamples.push(kernelResourceSnapshot([...trackedPids]));
      return tree;
    };
    const spawnedAt = sample();
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    let sampler = setInterval(sample, KERNEL_SAMPLE_INTERVAL_MS);
    let timedOut = false;
    let timeoutSigkillSent = false;
    let settled = false;
    let escalationTimer;
    let hardTimeoutTimer;
    let terminationPromise;
    let result;

    const terminateTracked = async (reason = "cleanup") => {
      if (!terminationPromise) {
        terminationPromise = (async () => {
          signalTrackedProcesses(child.pid, trackedProcessGroups, trackedPids, "SIGTERM");
          await delay(TERMINATION_GRACE_MS);
          const beforeKill = sample();
          const survivorsBeforeKill = beforeKill.pids.filter(
            (pid) => pid !== process.pid && pid > 1,
          );
          let escalated = false;
          if (survivorsBeforeKill.length > 0) {
            escalated = true;
            signalTrackedProcesses(child.pid, trackedProcessGroups, survivorsBeforeKill, "SIGKILL");
            await delay(TERMINATION_GRACE_MS);
          }
          const afterKill = sample();
          const survivorsAfterKill = afterKill.pids.filter((pid) => pid !== process.pid && pid > 1);
          const termination = {
            reason,
            sigtermSent: true,
            sigkillSent: escalated,
            survivorsBeforeKill,
            survivorsAfterKill,
            completed: survivorsAfterKill.length === 0,
          };
          if (result) {
            result.tree = treeSummary(treeSamples);
            result.resources = resourceSummary(resourceSamples);
            result.termination = termination;
          }
          return termination;
        })();
      }
      return terminationPromise;
    };

    const settle = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      clearTimeout(hardTimeoutTimer);
      clearInterval(sampler);
      sample();
      result = {
        pid: child.pid,
        processGroup: -child.pid,
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        started,
        completed: process.hrtime.bigint(),
        spawnedAt,
        tree: treeSummary(treeSamples),
        resources: resourceSummary(resourceSamples),
        termination: undefined,
        timeoutSigkillSent,
        terminate: terminateTracked,
        refresh: sample,
      };
      resolveResult(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalTrackedProcesses(child.pid, trackedProcessGroups, trackedPids, "SIGTERM");
      escalationTimer = setTimeout(() => {
        timeoutSigkillSent = true;
        signalTrackedProcesses(child.pid, trackedProcessGroups, trackedPids, "SIGKILL");
      }, TERMINATION_GRACE_MS);
      hardTimeoutTimer = setTimeout(() => {
        timeoutSigkillSent = true;
        signalTrackedProcesses(child.pid, trackedProcessGroups, trackedPids, "SIGKILL");
        settle(null, "SIGKILL");
      }, TERMINATION_ESCALATION_MS);
    }, timeoutMs);
    child.on("close", (exitCode, signal) => settle(exitCode, signal));
    child.on("error", (error) => {
      stderr.push(Buffer.from(String(error)));
      settle(null, null);
    });
  });
}

export function processTreeSnapshot(pid, trackedPids = []) {
  if (!pid)
    return {
      observed: false,
      rootPid: null,
      rootPresent: false,
      descendants: [],
      rssBytes: null,
      rssStatus: "notApplicable",
      pids: [],
      processGroups: [],
    };
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pidValue, ppidValue, pgidValue, rssValue] = line.trim().split(/\s+/u).map(Number);
        return {
          pid: pidValue,
          ppid: ppidValue,
          pgid: pgidValue,
          rssBytes: Number.isFinite(rssValue) ? rssValue * 1024 : null,
        };
      });
    const selected = new Map();
    const descendants = [];
    const pending = [pid];
    while (pending.length > 0) {
      const parent = pending.shift();
      for (const row of rows.filter((candidate) => candidate.ppid === parent)) {
        if (!selected.has(row.pid)) descendants.push(row);
        selected.set(row.pid, row);
        pending.push(row.pid);
      }
    }
    const root = rows.find((row) => row.pid === pid);
    const groupRows = rows.filter((row) => row.pgid === pid && row.pid !== pid);
    for (const row of groupRows) {
      if (!selected.has(row.pid)) descendants.push(row);
      selected.set(row.pid, row);
    }
    for (const row of rows) {
      if (trackedPids.includes(row.pid) && row.pid !== pid && !selected.has(row.pid)) {
        descendants.push(row);
        selected.set(row.pid, row);
      }
    }
    const rssValues = [root, ...selected.values()]
      .map((row) => row?.rssBytes)
      .filter(Number.isFinite);
    return {
      observed: true,
      rootPid: pid,
      rootPresent: root !== undefined,
      descendants: descendants.map(({ pid: childPid, rssBytes }) => ({ pid: childPid, rssBytes })),
      rssBytes:
        root?.rssBytes !== null && root?.rssBytes !== undefined
          ? rssValues.reduce((sum, value) => sum + value, 0)
          : null,
      rssStatus:
        root?.rssBytes !== null && root?.rssBytes !== undefined ? "observed" : "notApplicable",
      pids: [root?.pid, ...descendants.map((row) => row.pid)].filter(Boolean),
      processGroups: [root?.pgid, ...descendants.map((row) => row.pgid)].filter(
        (processGroup, index, values) =>
          Number.isInteger(processGroup) && values.indexOf(processGroup) === index,
      ),
    };
  } catch {
    return {
      observed: false,
      rootPid: pid,
      rootPresent: false,
      descendants: [],
      rssBytes: null,
      rssStatus: "notApplicable",
      pids: [],
      processGroups: [],
    };
  }
}

function kernelResourceSnapshot(pids) {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0)
    return {
      observed: false,
      reason: "no kernel process ids",
      pids: [],
      fileDescriptors: null,
      sockets: null,
      listeners: null,
      hermesPorts: [],
    };
  try {
    const output = execFileSync("lsof", ["-nP", "-a", "-p", uniquePids.join(",")], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const lines = output
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0);
    let sockets = 0;
    let listeners = 0;
    const hermesPorts = new Set();
    for (const line of lines) {
      const columns = line.trim().split(/\s+/u);
      const type = columns[4];
      if (!["IPv4", "IPv6", "unix"].includes(type)) continue;
      sockets += 1;
      if (line.includes("(LISTEN)")) {
        listeners += 1;
        for (const match of line.matchAll(/:(611\d)\b/gu)) hermesPorts.add(Number(match[1]));
      }
    }
    return {
      observed: true,
      pids: uniquePids,
      fileDescriptors: lines.length,
      sockets,
      listeners,
      hermesPorts: [...hermesPorts].sort((left, right) => left - right),
    };
  } catch (error) {
    return {
      observed: false,
      reason: String(error),
      pids: uniquePids,
      fileDescriptors: null,
      sockets: null,
      listeners: null,
      hermesPorts: [],
    };
  }
}

function thresholdSatisfied(value, threshold) {
  if (!Number.isFinite(value)) return false;
  if (threshold.operator === "<") return value < threshold.limit;
  if (threshold.operator === "<=") return value <= threshold.limit;
  if (threshold.operator === "===") return value === threshold.limit;
  if (threshold.operator === ">=") return value >= threshold.limit;
  if (threshold.operator === ">") return value > threshold.limit;
  return false;
}

function fixtureObservationDerived(event, expectedBytes, expectedPeakGrowthBytes) {
  const bytesEqual = event.producedBytes === event.consumedBytes;
  const sha256Equal = event.producedSha256 === event.consumedSha256;
  const exactBytes = event.producedBytes === expectedBytes && event.consumedBytes === expectedBytes;
  const ceilingEqual = event.expectedPeakGrowthBytes === expectedPeakGrowthBytes;
  const validGrowth =
    Number.isSafeInteger(event.peakRssGrowthBytes) && event.peakRssGrowthBytes >= 0;
  const pass =
    event.producerCompleted === true &&
    event.consumerCompleted === true &&
    bytesEqual &&
    sha256Equal &&
    exactBytes &&
    ceilingEqual &&
    event.producedChunks > 0 &&
    event.consumedChunks > 0 &&
    validGrowth &&
    event.peakRssGrowthBytes < expectedPeakGrowthBytes;
  return { bytesEqual, sha256Equal, exactBytes, pass };
}

export function observationThresholdValues(step, assertions, label = step.id) {
  const fixtureThresholds = Object.entries(step.thresholds ?? {}).filter(
    ([metric, threshold]) =>
      threshold?.source === "fixture-observation" ||
      thresholdMetricRegistry[metric]?.kind === "fixture-observation",
  );
  if (fixtureThresholds.length === 0) return {};
  const expectedAssertion = step.assertions.find(
    (assertion) => assertion.kind === "fixture-observation",
  );
  assert(expectedAssertion, `${label} fixture observation assertion is missing`);
  const receiptAssertion = assertions.find((assertion) => assertion.id === expectedAssertion.id);
  const event = receiptAssertion?.observed;
  assert(event && typeof event === "object", `${label} fixture observation is missing`);
  const expectedBytes = expectedAssertion.expectedBytes;
  const expectedPeakGrowthBytes = expectedAssertion.expectedPeakGrowthBytes;
  assert(
    Number.isSafeInteger(expectedPeakGrowthBytes) && expectedPeakGrowthBytes > 0,
    `${label} fixture observation growth target is invalid`,
  );
  const derived = fixtureObservationDerived(event, expectedBytes, expectedPeakGrowthBytes);
  assert(
    typeof event.pass === "boolean" && event.pass === derived.pass,
    `${label} fixture observation pass is inconsistent`,
  );
  assert(
    Number.isSafeInteger(event.expectedPeakGrowthBytes) &&
      event.expectedPeakGrowthBytes === expectedPeakGrowthBytes,
    `${label} fixture observation growth ceiling is detached`,
  );
  const values = {};
  for (const [metric, threshold] of fixtureThresholds) {
    const spec = thresholdMetricRegistry[metric];
    assert(
      spec?.kind === "fixture-observation" && spec.field,
      `${label} threshold ${metric} is not an observed metric`,
    );
    assert(
      spec.assertionField &&
        Number.isSafeInteger(expectedAssertion[spec.assertionField]) &&
        threshold.source === spec.source &&
        threshold.unit === spec.unit &&
        (!spec.stepId || spec.stepId === step.id) &&
        (!spec.operator || spec.operator === threshold.operator) &&
        threshold.limit === expectedAssertion[spec.assertionField],
      `${label} threshold ${metric} is detached from fixture observation`,
    );
    const value = event[spec.field];
    assert(
      Number.isSafeInteger(value) && value >= 0,
      `${label} observation metric ${metric} is missing or malformed`,
    );
    values[metric] = value;
    assert(thresholdSatisfied(value, threshold), `${label} observation threshold ${metric} failed`);
  }
  return values;
}

function observationThresholdsSatisfied(step, assertions) {
  try {
    observationThresholdValues(step, assertions);
    return true;
  } catch {
    return false;
  }
}

function kernelThresholdsSatisfied(step, processResult) {
  const observed = {
    processRssBytes: processResult.tree.peakRssBytes,
    fileDescriptors: processResult.resources.fileDescriptors,
    sockets: processResult.resources.sockets,
    listeners: processResult.resources.listeners,
  };
  return Object.entries(observed).every(([metric, value]) => {
    const threshold = step.thresholds[metric];
    return threshold === undefined || thresholdSatisfied(value, threshold);
  });
}

function createCleanupBarrier(executionRoot, processResult) {
  let promise;
  let invocations = 0;
  return async function cleanup(reason) {
    if (!promise) {
      invocations += 1;
      promise = (async () => {
        const currentProcessResult =
          typeof processResult === "function" ? processResult() : processResult;
        const termination = currentProcessResult?.terminate
          ? await currentProcessResult.terminate(reason)
          : undefined;
        const finalTree = currentProcessResult?.tree?.completed;
        rmSync(executionRoot, { recursive: true, force: true });
        return {
          attempted: true,
          completed: true,
          barrier: "awaited-idempotent",
          reason,
          invocations,
          sigtermSent: termination?.sigtermSent ?? false,
          sigkillSent: termination?.sigkillSent ?? false,
          survivorsBeforeKill: termination?.survivorsBeforeKill ?? [],
          survivorsAfterKill: termination?.survivorsAfterKill ?? [],
          descendantsBeforeRemoval: finalTree?.descendants ?? [],
          executionRootRemoved: !existsSync(executionRoot),
        };
      })();
    }
    return promise;
  };
}

function parseMachineEvents(stdout, stderr) {
  const events = [];
  for (const bytes of [stdout, stderr]) {
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const value = JSON.parse(line);
        if (
          value &&
          typeof value === "object" &&
          (value.format === "agent-mail.observation/v1" || value.event)
        )
          events.push(value);
      } catch {}
    }
  }
  return events;
}

function resolveArgv(argv, fixturePath, outputRoot, runId) {
  const replacements = {
    "<temp-corpus>": fixturePath,
    "<measurement-output>": join(outputRoot, runId, "measurement.json"),
    "<benchmark-copy>": join(outputRoot, runId, "benchmark-copy.sqlite"),
  };
  const resolved = argv.map((arg) => replacements[arg] ?? arg);
  assert(!resolved.some((arg) => /<[^>]+>/u.test(arg)), "unresolved literal placeholder in argv");
  return resolved;
}

function fixtureBytes(fixture) {
  if (!fixture) return null;
  if (fixture.kind === "generated-stream") {
    const size = Number(fixture.minimumBytes ?? 0);
    assert(Number.isSafeInteger(size) && size >= 0, "fixture minimumBytes is invalid");
    const chunk = Buffer.from("agent-mail-fixture\n");
    const output = Buffer.alloc(size);
    for (let offset = 0; offset < output.length; offset += chunk.length)
      chunk.copy(output, offset, 0, Math.min(chunk.length, output.length - offset));
    return output;
  }
  if (fixture.kind === "generated-file") {
    assert(
      typeof fixture.seed === "number" || typeof fixture.recipe === "string",
      "fixture recipe is missing",
    );
    return Buffer.from(`${fixture.recipe ?? "generated"}\nseed=${fixture.seed ?? "none"}\n`);
  }
  return null;
}

function materializeFixture(fixture, destination, runId, priorGeneration) {
  if (!fixture) return null;
  const bytes = fixture.observationAssertionId ? null : fixtureBytes(fixture);
  if (fixture.kind === "generated-stream" && fixture.observationAssertionId) return { ...fixture };
  const path = join(
    destination,
    runId,
    fixture.kind === "generated-file" && !fixture.generationStepId ? "staging" : "fixtures",
    `${fixture.id ?? "fixture"}.bin`,
  );
  if (fixture.kind === "generated-file") {
    if (fixture.generationStepId) {
      assert(priorGeneration, `${fixture.id} requires a prior generation receipt`);
      mkdirSync(dirname(path), { recursive: true });
      assertAbsent(path, "measurement fixture");
      assertAbsent(`${path}.inventory.json`, "measurement inventory");
      cpSync(priorGeneration.artifactPath, path);
      cpSync(priorGeneration.inventoryPath, `${path}.inventory.json`);
      const copied = fileDigest(path, "measurement fixture");
      const copiedInventory = fileDigest(`${path}.inventory.json`, "measurement inventory");
      assert(
        copied.sha256 === priorGeneration.artifactSha256 &&
          copied.bytes === priorGeneration.artifactBytes &&
          copiedInventory.sha256 === priorGeneration.inventorySha256 &&
          copiedInventory.bytes === priorGeneration.inventoryBytes,
        "measurement fixture does not match generation artifact",
      );
      return {
        ...fixture,
        generationReceipt: {
          receiptPath: priorGeneration.receiptPath,
          receiptSha256: priorGeneration.receiptSha256,
          artifactPath: priorGeneration.artifactRelativePath,
          artifactSha256: priorGeneration.artifactSha256,
          artifactBytes: priorGeneration.artifactBytes,
          inventoryPath: priorGeneration.inventoryRelativePath,
          inventorySha256: priorGeneration.inventorySha256,
          inventoryBytes: priorGeneration.inventoryBytes,
          logicalChecksum: priorGeneration.logicalChecksum,
        },
        materialized: {
          path: relative(destination, path),
          owner: "prior-generator",
          presentBeforeRun: true,
          sha256: copied.sha256,
          bytes: copied.bytes,
        },
      };
    }
    return {
      ...fixture,
      materialized: {
        path: relative(destination, path),
        owner: "generator",
        presentBeforeRun: false,
      },
    };
  }
  if (!bytes) return fixture;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    ...fixture,
    materialized: {
      owner: "runner",
      presentBeforeRun: true,
      path: relative(destination, path),
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
  };
}

function evaluateAssertions(step, sourceRoot, processResult, events) {
  return step.assertions.map((assertion) => {
    if (assertion.kind === "exitCode") {
      return {
        ...assertion,
        observed: processResult.exitCode,
        pass: processResult.exitCode === assertion.expected,
      };
    }
    if (assertion.kind === "source-token") {
      const matching = events.filter(
        (event) => event.event === "source-token" && event.assertionId === assertion.id,
      );
      assert(matching.length === 1, `${step.id} source-token event count is not exactly one`);
      const event = matching[0];
      assert(
        event.format === "agent-mail.observation/v1",
        `${step.id} source-token event format is invalid`,
      );
      const source = step.sources.find((candidate) => candidate.path === assertion.sourcePath);
      assert(
        event.sourcePath === assertion.sourcePath && event.sourceSha256 === source.sha256,
        `${step.id} source-token event is detached`,
      );
      assert(event.token === assertion.token, `${step.id} source-token event token is detached`);
      assert(
        Number.isSafeInteger(event.observed) &&
          event.observed >= 0 &&
          event.expected === assertion.occurrences &&
          event.pass === (event.observed === event.expected),
        `${step.id} source-token event result is detached`,
      );
      return {
        ...assertion,
        observed: event.observed,
        pass: event.pass === true && event.observed === assertion.occurrences,
      };
    }
    if (assertion.kind === "fixture-observation") {
      const matching = events.filter(
        (event) => event.event === "fixture-observation" && event.fixtureId === assertion.fixtureId,
      );
      assert(matching.length === 1, `${step.id} fixture observation count is not exactly one`);
      const event = matching[0];
      assert(
        event.format === "agent-mail.fixture-observation/v1",
        `${step.id} fixture observation format is invalid`,
      );
      const source = step.sources.find((candidate) => candidate.path === assertion.sourcePath);
      assert(
        source && event.sourcePath === assertion.sourcePath && event.sourceSha256 === source.sha256,
        `${step.id} fixture observation source is detached`,
      );
      assert(
        event.fixtureId === assertion.fixtureId,
        `${step.id} fixture observation id is detached`,
      );
      for (const field of [
        "producedBytes",
        "consumedBytes",
        "producedChunks",
        "consumedChunks",
        "peakRssGrowthBytes",
        "expectedPeakGrowthBytes",
        "expectedBytes",
      ])
        assert(
          Number.isSafeInteger(event[field]) && event[field] >= 0,
          `${step.id} fixture observation numbers are invalid`,
        );
      assert(
        /^[0-9a-f]{64}$/u.test(event.producedSha256 ?? "") &&
          /^[0-9a-f]{64}$/u.test(event.consumedSha256 ?? ""),
        `${step.id} fixture observation digests are invalid`,
      );
      for (const field of [
        "producerCompleted",
        "consumerCompleted",
        "bytesEqual",
        "sha256Equal",
        "exactBytes",
        "pass",
      ])
        assert(
          typeof event[field] === "boolean",
          `${step.id} fixture observation flags are invalid`,
        );
      const bytesEqual = event.producedBytes === event.consumedBytes;
      const sha256Equal = event.producedSha256 === event.consumedSha256;
      const exactBytes =
        event.producedBytes === assertion.expectedBytes &&
        event.consumedBytes === assertion.expectedBytes;
      const derived = fixtureObservationDerived(
        event,
        assertion.expectedBytes,
        assertion.expectedPeakGrowthBytes,
      );
      const pass = derived.pass;
      assert(
        event.expectedBytes === assertion.expectedBytes &&
          event.expectedPeakGrowthBytes === assertion.expectedPeakGrowthBytes &&
          event.bytesEqual === bytesEqual &&
          event.sha256Equal === sha256Equal &&
          event.exactBytes === exactBytes &&
          event.pass === pass,
        `${step.id} fixture observation result is detached`,
      );
      return { ...assertion, observed: event, pass };
    }
    const matching = events.filter(
      (event) =>
        event.event === assertion.event &&
        event.path === assertion.path &&
        event.sha256 === assertion.sha256 &&
        event.pointer === assertion.pointer,
    );
    assert(matching.length === 1, `${step.id} structured oracle event count is not exactly one`);
    const oracleBytes = readFileSync(resolve(sourceRoot, assertion.path));
    assert(sha256(oracleBytes) === assertion.sha256, `${step.id} oracle bytes drifted`);
    const oracleValue = resolveJsonPointer(
      JSON.parse(oracleBytes.toString("utf8")),
      assertion.pointer,
    );
    const observed = matching[0].value;
    assert(
      matching[0].path === assertion.path &&
        matching[0].sha256 === assertion.sha256 &&
        matching[0].pointer === assertion.pointer &&
        deepJsonEqual(observed, oracleValue),
      `${step.id} structured oracle event is detached`,
    );
    return {
      ...assertion,
      observed,
      pass: deepJsonEqual(observed, assertion.value) && deepJsonEqual(observed, oracleValue),
    };
  });
}

function fixtureFromObservation(fixture, assertions) {
  if (!fixture?.observationAssertionId) return fixture;
  const assertion = assertions.find((candidate) => candidate.id === fixture.observationAssertionId);
  assert(
    assertion?.kind === "fixture-observation" && assertion.pass,
    "fixture observation did not pass",
  );
  const observed = assertion.observed;
  return {
    ...fixture,
    materialized: {
      owner: "observation",
      presentBeforeRun: false,
      presentAfterRun: true,
      bytes: observed.producedBytes,
      sha256: observed.producedSha256,
    },
    observation: observed,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--self-test") args.selfTest = true;
    else if (token.startsWith("--")) args[token.slice(2)] = argv[++index];
    else fail(`unexpected argument ${token}`);
  }
  return args;
}

function selfTestManifest(root) {
  const tiny = "tiny-receipt.mjs";
  writeFileSync(
    join(root, tiny),
    "process.stdout.write('tiny-pass\\n'); setTimeout(() => {}, 250);\n",
  );
  git(root, ["add", tiny]);
  git(root, ["commit", "-qm", "tiny command"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const source = committedBlob(root, head, tiny, "tiny source");
  return {
    format: "agent-mail.release-evidence-execution-manifest/v2",
    schemaVersion: 2,
    ownerIssueId: 176,
    replay: { required: true, compare: ["candidate", "argv", "sources", "fixture", "assertions"] },
    attackInventory: Array.from({ length: 40 }, (_, index) => `tiny-attack-${index + 1}`),
    steps: [
      {
        id: "tiny-command",
        ownerIssueId: 176,
        gate: "capacity",
        obligationIds: ["F17"],
        cwd: ".",
        argv: ["node", tiny],
        sources: [
          { role: "entrypoint", path: tiny, gitBlob: source.gitBlob, sha256: source.sha256 },
        ],
        assertions: [{ id: "tiny-exit-zero", kind: "exitCode", expected: 0 }],
        observations: ["stdout", "stderr", "exitCode", "durationNs"],
        thresholds: {
          timeoutMs: 5000,
          processRssBytes: {
            source: "kernel:ps",
            operator: "<=",
            limit: 1073741824,
            unit: "bytes",
          },
        },
        probes: ["processTreeRss", "streams", "tempRoot"],
        fixture: { kind: "generated-stream", id: "tiny-fixture", recipe: "stdout:tiny-pass" },
      },
    ],
  };
}

export async function capture({
  manifestPath = manifestDefaultPath,
  stepId,
  root = repositoryRoot,
  outputRoot,
  generationReceiptPath,
  generationOutputRoot,
  role = "primary",
  runId = randomUUID(),
  timeoutMs,
  selfTest = process.argv.includes("--self-test"),
} = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const candidateCommit = git(root, ["rev-parse", "HEAD"]);
  const candidateTree = git(root, ["rev-parse", `${candidateCommit}^{tree}`]);
  const manifestRelative = relative(root, resolve(manifestPath));
  assert(!manifestRelative.startsWith(".."), "manifest must be inside candidate repository");
  const manifestBytes = readFileSync(manifestPath);
  const allowedUntracked = manifest.runner?.untrackedAllowlist ?? [];
  const originalSnapshot = assertCleanCandidate(root, allowedUntracked);
  validateManifest(manifest, root, candidateCommit, { selfTest });
  const step = manifest.steps.find((candidate) => candidate.id === stepId) ?? manifest.steps[0];
  assert(step, `unknown manifest step ${stepId}`);
  const stepBindings = stepSourceBindings(step, root, candidateCommit);
  const runnerBindings = manifest.runner?.sources
    ? sourceBindings(manifest, root, candidateCommit).filter((source) =>
        manifest.runner.sources.some((expected) => expected.path === source.path),
      )
    : [];
  const destination = resolve(
    outputRoot ?? mkdtempSync(join(tmpdir(), "agent-mail-release-evidence-")),
  );
  assert(
    !destination.startsWith(`${resolve(root)}/`),
    "output root must be outside candidate repository",
  );
  mkdirSync(destination, { recursive: true });
  const executionRoot = mkdtempSync(join(tmpdir(), "agent-mail-release-candidate-"));
  let checkout = join(executionRoot, "checkout");
  let processResult;
  const cleanupBarrier = createCleanupBarrier(executionRoot, () => processResult);
  try {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", root, checkout], { stdio: "ignore" });
    execFileSync("git", ["checkout", "-q", "--detach", candidateCommit], {
      cwd: checkout,
      stdio: "ignore",
    });
    assert(gitStatus(checkout).length === 0, "disposable candidate checkout is dirty");
    const dependencies = installFrozenDependencies(checkout, manifest, { selfTest });
    const cwd = resolve(checkout, step.cwd);
    for (const source of step.sources)
      committedBlob(checkout, candidateCommit, source.path, `${step.id} source`);
    const priorGeneration = step.fixture?.generationStepId
      ? generationReceipt(
          generationReceiptPath,
          generationOutputRoot ?? dirname(resolve(generationReceiptPath ?? destination)),
          step.fixture,
          candidateCommit,
        )
      : undefined;
    let fixture = materializeFixture(step.fixture, destination, runId, priorGeneration);
    let fixturePath = fixture?.materialized?.path
      ? resolve(destination, fixture.materialized.path)
      : join(executionRoot, "generated-fixture");
    if (fixture?.materialized?.owner === "generator")
      assertAbsent(fixturePath, "generator fixture");
    if (fixture?.materialized?.presentBeforeRun && !existsSync(fixturePath))
      fail("runner fixture was not materialized");
    const argv = resolveArgv(step.argv, fixturePath, destination, runId);
    const beforeRun = repositorySnapshot(checkout);
    const integrityBefore =
      fixture?.materialized?.owner === "prior-generator" && fixture.rowCount === 250000
        ? await validateGeneratedSearchArtifact(fixturePath, checkout)
        : undefined;
    const startedAt = now();
    const captureStartedNs = process.hrtime.bigint();
    const processBefore = processTreeSnapshot(process.pid);
    processResult = await runProcess(argv, cwd, timeoutMs ?? step.thresholds.timeoutMs ?? 300_000);
    const termination = await processResult.terminate("post-process");
    const processAfter = processResult.tree.completed;
    const descendants = processAfter.descendants;
    const eventsValue = parseMachineEvents(processResult.stdout, processResult.stderr);
    const eventBytes = Buffer.from(
      eventsValue.map((event) => `${JSON.stringify(event)}\n`).join(""),
    );
    const stdout = outputRef(
      destination,
      destination,
      runId,
      `${step.id}.stdout`,
      processResult.stdout,
    );
    const stderr = outputRef(
      destination,
      destination,
      runId,
      `${step.id}.stderr`,
      processResult.stderr,
    );
    const events = outputRef(
      destination,
      destination,
      runId,
      `${step.id}.events.jsonl`,
      eventBytes,
    );
    const durationNs = processResult.completed - processResult.started;
    const assertions = evaluateAssertions(step, checkout, processResult, eventsValue);
    const probeUnavailable =
      (step.probes.includes("processTreeRss") &&
        (!processResult.tree.observed ||
          processResult.tree.rssStatus !== "observed" ||
          !Number.isFinite(processResult.tree.peakRssBytes))) ||
      (["fileDescriptors", "sockets", "listeners", "HermesLease"].some((probe) =>
        step.probes.includes(probe),
      ) &&
        (!processResult.resources.observed ||
          (step.probes.includes("HermesLease") &&
            processResult.resources.hermesPorts.length === 0)));
    const kernelThresholdsPass = kernelThresholdsSatisfied(step, processResult);
    const observationThresholdsPass = observationThresholdsSatisfied(step, assertions);
    const result =
      probeUnavailable ||
      processResult.timedOut ||
      processResult.exitCode === null ||
      termination.survivorsAfterKill.length > 0
        ? "blocked"
        : processResult.exitCode === 0 &&
            assertions.every((assertion) => assertion.pass) &&
            kernelThresholdsPass &&
            observationThresholdsPass
          ? "pass"
          : "fail";
    if (fixture?.materialized?.owner === "generator" && result === "pass") {
      const retained = retainGeneratedArtifact(destination, fixture, fixturePath, runId);
      cleanGeneratedStaging(fixturePath);
      fixture = {
        ...fixture,
        materialized: {
          ...fixture.materialized,
          path: retained.relativePath,
          retainedFrom: fixture.materialized.path,
          presentAfterRun: true,
          sha256: retained.artifactSha256,
          bytes: retained.artifactBytes,
          integrity: {
            inventorySha256: retained.inventorySha256,
            inventoryBytes: retained.inventoryBytes,
            logicalChecksum: retained.logicalChecksum,
          },
        },
      };
      fixturePath = retained.path;
    }
    const observedFixture = fixtureFromObservation(fixture, assertions);
    const retainedFixture = await finalizeFixture(
      observedFixture,
      destination,
      fixturePath,
      checkout,
      integrityBefore,
    );
    assert(
      JSON.stringify(repositorySnapshot(checkout)) === JSON.stringify(beforeRun),
      "candidate checkout changed during execution",
    );
    assert(descendants.length === 0, "runner left descendant processes behind");
    const generatedStaging = fixture?.materialized?.retainedFrom
      ? {
          path: fixture.materialized.retainedFrom,
          removed: !existsSync(resolve(destination, fixture.materialized.retainedFrom)),
          retainedPath: fixture.materialized.path,
        }
      : undefined;
    if (generatedStaging)
      assert(generatedStaging.removed, "generated staging artifact was not cleaned");
    const outputRootIdentity = filesystemIdentity(destination, "capture output root", true);
    const tempRootIdentity = filesystemIdentity(executionRoot, "capture temporary root", true);
    const cleanup = {
      ...(await cleanupBarrier("completed")),
      generatedStaging,
    };
    const captureCompletedNs = process.hrtime.bigint();
    const completedAt = new Date(Math.max(Date.now(), Date.parse(startedAt) + 1)).toISOString();
    const intervals = [
      {
        id: "setup",
        startedNs: captureStartedNs,
        completedNs: processResult.started,
      },
      {
        id: "execution",
        startedNs: processResult.started,
        completedNs: processResult.completed,
      },
      {
        id: "retention-and-cleanup",
        startedNs: processResult.completed,
        completedNs: captureCompletedNs,
      },
    ].map((interval) => ({
      ...interval,
      durationNs: interval.completedNs - interval.startedNs,
    }));
    assert(
      intervals.every((interval) => interval.startedNs < interval.completedNs) &&
        intervals.every(
          (interval, index) =>
            index === 0 || intervals[index - 1].completedNs <= interval.startedNs,
        ),
      "capture intervals are not sequential",
    );
    const aggregateDurationNs = intervals.reduce((sum, interval) => sum + interval.durationNs, 0n);
    const receipt = {
      format: receiptFormat,
      runId,
      role,
      manifestStepId: step.id,
      candidate: {
        repository: (() => {
          try {
            return git(root, ["config", "--get", "remote.origin.url"]);
          } catch {
            return "local";
          }
        })(),
        commit: candidateCommit,
        tree: candidateTree,
        manifestPath: manifestRelative,
        manifestSha256: sha256(manifestBytes),
      },
      cwd: step.cwd,
      argv: [...argv],
      stdin: { kind: "none" },
      sources: stepBindings,
      runnerSources: runnerBindings,
      fixture: retainedFixture,
      assertions,
      startedAt,
      completedAt,
      monotonic: {
        startedNs: captureStartedNs.toString(10),
        completedNs: captureCompletedNs.toString(10),
        durationNs: durationNs.toString(10),
        intervals: intervals.map((interval) => ({
          id: interval.id,
          startedNs: interval.startedNs.toString(10),
          completedNs: interval.completedNs.toString(10),
          durationNs: interval.durationNs.toString(10),
        })),
        aggregateDurationNs: aggregateDurationNs.toString(10),
      },
      environment: {
        os: process.platform,
        kernel: (() => {
          try {
            return execFileSync("uname", ["-sr"], { encoding: "utf8" }).trim();
          } catch {
            return "unknown";
          }
        })(),
        arch: process.arch,
        runtime: {
          executable: process.execPath,
          version: process.version,
          sha256: runtimeDigest(),
        },
        packageManifestSha256: optionalDigest(join(root, "package.json")),
        lockfileSha256: optionalDigest(join(root, "bun.lock")),
        dependencies,
      },
      process: {
        pid: processResult.pid,
        processGroup: processResult.processGroup,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
      },
      streams: { stdout, stderr, events },
      probes: {
        process: {
          observed: processResult.tree.observed,
          pid: processResult.pid,
          descendants: processAfter.descendants,
          rssBytes: processResult.tree.peakRssBytes,
          peakRssBytes: processResult.tree.peakRssBytes,
          rssStatus: processResult.tree.rssStatus,
          samples: processResult.tree.samples,
          spawned: processResult.spawnedAt,
        },
        resources: processResult.resources,
        before: processBefore,
        streams: {
          observed: true,
          stdout: stdout.bytes,
          stderr: stderr.bytes,
          events: events.bytes,
        },
        tempRoot: { path: executionRoot, removed: cleanup.executionRootRemoved },
        cleanup: { ...cleanup, termination },
      },
      result,
      observedOutcome: {
        status: result,
        derivedFrom: [
          candidateCommit,
          candidateTree,
          sha256(manifestBytes),
          events.sha256,
          stdout.sha256,
          stderr.sha256,
        ],
      },
    };
    const envelopeArtifacts = {
      stdout: provenanceArtifact(destination, stdout, "stdout stream", completedAt),
      stderr: provenanceArtifact(destination, stderr, "stderr stream", completedAt),
      events: provenanceArtifact(destination, events, "event stream", completedAt),
      ...(retainedFixture?.materialized?.path
        ? {
            fixture: provenanceArtifact(
              destination,
              retainedFixture.materialized,
              "materialized fixture",
              completedAt,
            ),
          }
        : {}),
    };
    const observations = provenanceObservations(receipt);
    const envelope = {
      format: "agent-mail.capture-provenance/v1",
      runId,
      role,
      receiptSha256: sha256(canonicalJson(receiptCore(receipt))),
      authority: {
        candidate: receipt.candidate,
        manifestStepId: receipt.manifestStepId,
        cwd: receipt.cwd,
        argv: receipt.argv,
        sources: receipt.sources,
        runnerSources: receipt.runnerSources,
        fixture: receipt.fixture,
        assertions: receipt.assertions,
        probes: step.probes,
        thresholds: step.thresholds,
      },
      roots: {
        output: outputRootIdentity,
        temporary: { ...tempRootIdentity, removed: cleanup.executionRootRemoved },
      },
      artifacts: envelopeArtifacts,
      observations,
      observationsSha256: sha256(canonicalJson(observations)),
    };
    const envelopeBytes = Buffer.from(json(envelope));
    const envelopePath = join(destination, runId, `${step.id}.provenance.json`);
    mkdirSync(dirname(envelopePath), { recursive: true });
    writeFileSync(envelopePath, envelopeBytes, { mode: 0o600 });
    const envelopeRef = retainedFileRef(
      destination,
      destination,
      envelopePath,
      envelopeBytes.length,
      sha256(envelopeBytes),
      "capture provenance envelope",
    );
    receipt.provenance = {
      format: envelope.format,
      path: envelopeRef.path,
      sha256: envelopeRef.sha256,
      bytes: envelopeRef.bytes,
      receiptSha256: envelope.receiptSha256,
      observationsSha256: envelope.observationsSha256,
    };
    const after = repositorySnapshot(root);
    assert(
      after.head === originalSnapshot.head && after.tree === originalSnapshot.tree,
      "candidate HEAD/tree changed during capture",
    );
    assert(
      after.submodules === originalSnapshot.submodules,
      "candidate submodules changed during capture",
    );
    assert(
      gitStatusEntries(root).every(
        (entry) => entry.code === "??" && isAllowedUntracked(entry.path, allowedUntracked),
      ),
      "capture introduced unallowlisted worktree changes",
    );
    return receipt;
  } finally {
    await cleanupBarrier("finally");
    if (existsSync(executionRoot)) fail("runner temporary checkout was not removed");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const root = mkdtempSync("/tmp/agent-mail-capture-self-test-");
    try {
      git(root, ["init", "-q"]);
      git(root, ["config", "user.email", "capture@example.invalid"]);
      git(root, ["config", "user.name", "capture self-test"]);
      const manifest = selfTestManifest(root);
      const manifestPath = join(root, "manifest.json");
      writeFileSync(manifestPath, json(manifest));
      git(root, ["add", "manifest.json"]);
      git(root, ["commit", "-qm", "tiny manifest"]);
      const receipt = await capture({
        manifestPath,
        root,
        stepId: "tiny-command",
      });
      assert(receipt.result === "pass", "tiny command did not pass");
      console.log(JSON.stringify({ format: receiptFormat, accepted: true, receipt }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }
  const receipt = await capture({
    manifestPath: args.manifest,
    stepId: args.step,
    root: args.root ? resolve(args.root) : repositoryRoot,
    outputRoot: args["output-root"] ? resolve(args["output-root"]) : undefined,
    generationReceiptPath: args["generation-receipt"]
      ? resolve(args["generation-receipt"])
      : undefined,
    generationOutputRoot: args["generation-output-root"]
      ? resolve(args["generation-output-root"])
      : undefined,
    role: args.role ?? "primary",
    runId: args["run-id"],
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });
  const receiptPath = args.receipt
    ? resolve(args.receipt)
    : join(process.cwd(), `${receipt.runId}.receipt.json`);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, json(receipt));
  console.log(JSON.stringify({ receiptPath, result: receipt.result, runId: receipt.runId }));
}

if (import.meta.main) await main();
