/** Versioned, pure matching for the two local routing predicate kinds. */

import { domainToASCII } from "node:url";
import { parseRoutingRuleId, type RoutingMatchFact, type RoutingRuleId } from "./routing";

export const ROUTING_RULE_SCHEMA_VERSION = 1 as const;

declare const routingRuleVersionBrand: unique symbol;
export type RoutingRuleVersion = number & {
  readonly [routingRuleVersionBrand]: "RoutingRuleVersion";
};

export type ExactSenderPredicate = {
  readonly kind: "exactSender";
  readonly sender: string;
};

export type ExactListIdPredicate = {
  readonly kind: "exactListId";
  readonly listId: string;
};

export type RoutingPredicate = ExactSenderPredicate | ExactListIdPredicate;

export type RoutingRule = {
  readonly version: typeof ROUTING_RULE_SCHEMA_VERSION;
  readonly ruleId: RoutingRuleId;
  readonly ruleVersion: RoutingRuleVersion;
  readonly predicate: RoutingPredicate;
};

export type RoutingFacts = {
  readonly senderAddrSpec: string | null;
  readonly listId: string | null;
};

export type RoutingRuleEvaluation = {
  readonly version: typeof ROUTING_RULE_SCHEMA_VERSION;
  readonly ruleId: RoutingRuleId;
  readonly ruleVersion: RoutingRuleVersion;
  readonly predicate: RoutingPredicate;
  readonly matched: boolean;
  readonly matchedFacts: readonly RoutingMatchFact[];
};

// Canonical comparison is locale-independent lowercase plus NFC. Domain labels
// additionally use WHATWG IDNA ASCII conversion; display names and comments are
// discarded before extracting the sender addr-spec or List-ID identifier.

type RecordValue = Readonly<Record<string, unknown>>;

function record(value: unknown, name: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value as RecordValue;
}

function exact(value: RecordValue, keys: readonly string[], name: string): void {
  const allowed = new Set(keys);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${name} has missing or unknown fields`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function createRuleVersion(value: unknown): RoutingRuleVersion {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("routing rule version must be a positive safe integer");
  }
  return value as RoutingRuleVersion;
}

function removeComments(value: string, name: string): string {
  let result = "";
  let commentDepth = 0;
  let quoted = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      if (commentDepth === 0) result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      if (commentDepth === 0) result += character;
      escaped = true;
      continue;
    }
    if (character === '"' && commentDepth === 0) {
      quoted = !quoted;
      result += character;
      continue;
    }
    if (!quoted && character === "(") {
      commentDepth += 1;
      continue;
    }
    if (!quoted && character === ")") {
      if (commentDepth === 0) throw new TypeError(`${name} has an unmatched comment`);
      commentDepth -= 1;
      continue;
    }
    if (commentDepth === 0) result += character;
  }
  if (escaped || quoted || commentDepth !== 0) throw new TypeError(`${name} is malformed`);
  return result;
}

function angleIdentifier(value: string, name: string): string {
  const withoutComments = removeComments(value, name).trim();
  const opening = withoutComments.indexOf("<");
  const closing = withoutComments.lastIndexOf(">");
  if (opening < 0 && closing < 0) return withoutComments;
  if (
    opening < 0 ||
    closing < 0 ||
    opening >= closing ||
    withoutComments.indexOf("<", opening + 1) >= 0 ||
    withoutComments.indexOf(">", 0) !== closing ||
    withoutComments.slice(closing + 1).trim() !== ""
  ) {
    throw new TypeError(`${name} has a malformed angle identifier`);
  }
  return withoutComments.slice(opening + 1, closing).trim();
}

function splitUnquotedAt(value: string, name: string): readonly [string, string] {
  let quoted = false;
  let escaped = false;
  let at = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === "@") {
      if (at >= 0) throw new TypeError(`${name} must contain one addr-spec separator`);
      at = index;
    }
  }
  if (quoted || escaped || at <= 0 || at === value.length - 1) {
    throw new TypeError(`${name} must be a valid addr-spec`);
  }
  return [value.slice(0, at), value.slice(at + 1)];
}

function normalizeLocalPart(value: string): string {
  const local = value.normalize("NFC");
  if (local.startsWith('"') || local.endsWith('"')) {
    const quotedBody = local.slice(1, -1);
    if (
      local.length < 2 ||
      !local.endsWith('"') ||
      quotedBody.includes('"') ||
      quotedBody.includes("\r") ||
      quotedBody.includes("\n")
    ) {
      throw new TypeError("sender local part is malformed");
    }
    return local.toLowerCase();
  }
  if (
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    [...local].some(
      (character) =>
        /[\s()<>,;:\\"[\]]/u.test(character) ||
        character === "@" ||
        hasControlCharacters(character),
    )
  ) {
    throw new TypeError("sender local part is malformed");
  }
  return local.toLowerCase();
}

function normalizeDomain(value: string, name: string): string {
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!value.startsWith("[") || !value.endsWith("]") || value.length < 3) {
      throw new TypeError(`${name} domain literal is malformed`);
    }
    const literal = value.slice(1, -1);
    if (/\s/u.test(literal) || hasControlCharacters(literal)) {
      throw new TypeError(`${name} domain literal is malformed`);
    }
    return `[${literal.toLowerCase()}]`;
  }
  if (/\s/u.test(value) || value.includes("<") || value.includes(">")) {
    throw new TypeError(`${name} domain is malformed`);
  }
  const ascii = domainToASCII(value.normalize("NFC"));
  if (ascii.length === 0 || hasControlCharacters(ascii)) {
    throw new TypeError(`${name} domain is malformed`);
  }
  return ascii.toLowerCase();
}

export function normalizeSenderAddrSpec(value: unknown): string {
  const input = text(value, "sender");
  const withoutComments = removeComments(input, "sender").trim();
  const addrSpec = angleIdentifier(withoutComments, "sender");
  if (addrSpec.includes(",") || addrSpec.includes("<") || addrSpec.includes(">")) {
    throw new TypeError("sender must contain one addr-spec");
  }
  const [local, domain] = splitUnquotedAt(addrSpec, "sender");
  return `${normalizeLocalPart(local)}@${normalizeDomain(domain, "sender")}`;
}

function normalizeListIdentifier(value: string): string {
  if (/\s/u.test(value) || value.includes("<") || value.includes(">")) {
    throw new TypeError("List-ID identifier is malformed");
  }
  const at = value.indexOf("@");
  if (at >= 0) {
    const [local, domain] = splitUnquotedAt(value, "List-ID");
    return `${normalizeLocalPart(local)}@${normalizeDomain(domain, "List-ID")}`;
  }
  return normalizeDomain(value, "List-ID");
}

export function normalizeListIdIdentifier(value: unknown): string {
  const input = text(value, "List-ID");
  const identifier = angleIdentifier(input, "List-ID");
  if (identifier.length === 0) throw new TypeError("List-ID identifier must not be empty");
  return normalizeListIdentifier(identifier.normalize("NFC").toLowerCase());
}

function createPredicate(value: unknown): RoutingPredicate {
  const input = record(value, "routing predicate");
  if (input.kind === "exactSender") {
    exact(input, ["kind", "sender"], "exact sender predicate");
    return { kind: "exactSender", sender: normalizeSenderAddrSpec(input.sender) };
  }
  if (input.kind === "exactListId") {
    exact(input, ["kind", "listId"], "exact List-ID predicate");
    return { kind: "exactListId", listId: normalizeListIdIdentifier(input.listId) };
  }
  throw new TypeError("routing predicate kind is unsupported");
}

export function createRoutingRule(value: unknown): RoutingRule {
  const input = record(value, "routing rule");
  exact(input, ["version", "ruleId", "ruleVersion", "predicate"], "routing rule");
  if (input.version !== ROUTING_RULE_SCHEMA_VERSION) {
    throw new TypeError("routing rule schema version is unsupported");
  }
  return {
    version: ROUTING_RULE_SCHEMA_VERSION,
    ruleId: parseRoutingRuleId(input.ruleId),
    ruleVersion: createRuleVersion(input.ruleVersion),
    predicate: createPredicate(input.predicate),
  };
}

export function parseRoutingRule(value: unknown): RoutingRule {
  if (typeof value !== "string") throw new TypeError("routing rule serialization must be a string");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new TypeError("malformed routing rule serialization");
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== "routing-rule-v1") {
    throw new TypeError("malformed routing rule serialization");
  }
  const rule = createRoutingRule(decoded[1]);
  if (serializeRoutingRule(rule) !== value)
    throw new TypeError("non-canonical routing rule serialization");
  return rule;
}

export function serializeRoutingRule(value: RoutingRule): string {
  return JSON.stringify(["routing-rule-v1", value]);
}

export function createRoutingFacts(value: unknown): RoutingFacts {
  const input = record(value, "routing facts");
  const allowed = new Set(["senderAddrSpec", "listId"]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key))
      throw new TypeError("routing facts have unknown fields");
  }
  const sender = input.senderAddrSpec;
  const listId = input.listId;
  return {
    senderAddrSpec:
      sender === undefined || sender === null ? null : normalizeSenderAddrSpec(sender),
    listId: listId === undefined || listId === null ? null : normalizeListIdIdentifier(listId),
  };
}

export function evaluateRoutingRule(
  ruleValue: unknown,
  factsValue: unknown,
): RoutingRuleEvaluation {
  const rule = createRoutingRule(ruleValue);
  const facts = createRoutingFacts(factsValue);
  const observed = rule.predicate.kind === "exactSender" ? facts.senderAddrSpec : facts.listId;
  const expected =
    rule.predicate.kind === "exactSender" ? rule.predicate.sender : rule.predicate.listId;
  const matched = observed !== null && observed === expected;
  return {
    version: ROUTING_RULE_SCHEMA_VERSION,
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    predicate: rule.predicate,
    matched,
    matchedFacts: matched
      ? [
          {
            field: rule.predicate.kind === "exactSender" ? "sender-addr-spec" : "list-id",
            value: expected,
          },
        ]
      : [],
  };
}

export const evaluateRoutingPredicate = evaluateRoutingRule;
