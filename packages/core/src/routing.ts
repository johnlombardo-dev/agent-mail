/** Pure local routing values. Remote mailbox placement is deliberately absent. */

import { parseUtcInstant, type UtcInstant } from "./time-cursor";

declare const localLabelBrand: unique symbol;
declare const ruleIdBrand: unique symbol;

export type LocalLabel = string & { readonly [localLabelBrand]: "LocalLabel" };
export type RoutingRuleId = string & {
  readonly [ruleIdBrand]: "RoutingRuleId";
};

export type RoutingMatchFact = {
  readonly field: string;
  readonly value: string;
};

export type RoutingProvenance = {
  readonly source: string;
  readonly evaluationId: string;
};

type DecisionMetadata = {
  readonly ruleId: RoutingRuleId;
  readonly ruleVersion: number;
  readonly matchedFacts: readonly RoutingMatchFact[];
  readonly decidedAt: UtcInstant;
  readonly provenance: RoutingProvenance;
};

export type RouteDecision = DecisionMetadata & {
  readonly kind: "route";
  readonly label: LocalLabel;
};
export type SuppressionDecision = DecisionMetadata & {
  readonly kind: "suppress";
  readonly reason: string;
};
export type DigestMembershipDecision = DecisionMetadata & {
  readonly kind: "digest-membership";
  readonly digestId: string;
  readonly included: boolean;
};
export type RoutingDecision = RouteDecision | SuppressionDecision | DigestMembershipDecision;

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

export function createLocalLabel(value: unknown): LocalLabel {
  const label = text(value, "local label");
  if (!label.startsWith("label:") || label.length === "label:".length) {
    throw new TypeError("local label must use the label: namespace");
  }
  return label as LocalLabel;
}

export function parseLocalLabel(value: unknown): LocalLabel {
  return createLocalLabel(value);
}

export const serializeLocalLabel = (value: LocalLabel): string => value;

export function createRoutingRuleId(value: unknown): RoutingRuleId {
  const id = text(value, "routing rule ID");
  if (!id.startsWith("rule:") || id.length === "rule:".length) {
    throw new TypeError("routing rule ID must use the rule: namespace");
  }
  return id as RoutingRuleId;
}

export function parseRoutingRuleId(value: unknown): RoutingRuleId {
  return createRoutingRuleId(value);
}

export const serializeRoutingRuleId = (value: RoutingRuleId): string => value;

function createFact(value: unknown): RoutingMatchFact {
  const input = record(value, "routing match fact");
  exact(input, ["field", "value"], "routing match fact");
  return {
    field: text(input.field, "match fact field"),
    value: text(input.value, "match fact value"),
  };
}

function createFacts(value: unknown): readonly RoutingMatchFact[] {
  if (!Array.isArray(value)) throw new TypeError("matched facts must be an array");
  const facts = value.map(createFact);
  if (facts.length === 0) {
    throw new TypeError("matched facts must not be empty");
  }
  for (let index = 1; index < facts.length; index += 1) {
    const previous = `${facts[index - 1].field}\u0000${facts[index - 1].value}`;
    const current = `${facts[index].field}\u0000${facts[index].value}`;
    if (current <= previous) throw new TypeError("matched facts must be in canonical order");
  }
  return facts;
}

function createProvenance(value: unknown): RoutingProvenance {
  const input = record(value, "routing provenance");
  exact(input, ["source", "evaluationId"], "routing provenance");
  return {
    source: text(input.source, "provenance source"),
    evaluationId: text(input.evaluationId, "provenance evaluation ID"),
  };
}

function metadata(value: RecordValue): DecisionMetadata {
  if (
    typeof value.ruleVersion !== "number" ||
    !Number.isSafeInteger(value.ruleVersion) ||
    value.ruleVersion <= 0
  ) {
    throw new TypeError("rule version must be a positive safe integer");
  }
  return {
    ruleId: parseRoutingRuleId(value.ruleId),
    ruleVersion: value.ruleVersion,
    matchedFacts: createFacts(value.matchedFacts),
    decidedAt: parseUtcInstant(value.decidedAt),
    provenance: createProvenance(value.provenance),
  };
}

export function createRouteDecision(value: unknown): RouteDecision {
  const input = record(value, "route decision");
  exact(
    input,
    ["kind", "ruleId", "ruleVersion", "matchedFacts", "decidedAt", "provenance", "label"],
    "route decision",
  );
  if (input.kind !== "route") throw new TypeError("route decision has the wrong kind");
  const common = metadata(input);
  return { ...common, kind: "route", label: createLocalLabel(input.label) };
}

export function createSuppressionDecision(value: unknown): SuppressionDecision {
  const input = record(value, "suppression decision");
  exact(
    input,
    ["kind", "ruleId", "ruleVersion", "matchedFacts", "decidedAt", "provenance", "reason"],
    "suppression decision",
  );
  if (input.kind !== "suppress") throw new TypeError("suppression decision has the wrong kind");
  const common = metadata(input);
  return {
    ...common,
    kind: "suppress",
    reason: text(input.reason, "suppression reason"),
  };
}

export function createDigestMembershipDecision(value: unknown): DigestMembershipDecision {
  const input = record(value, "digest membership decision");
  exact(
    input,
    [
      "kind",
      "ruleId",
      "ruleVersion",
      "matchedFacts",
      "decidedAt",
      "provenance",
      "digestId",
      "included",
    ],
    "digest membership decision",
  );
  if (input.kind !== "digest-membership")
    throw new TypeError("digest membership decision has the wrong kind");
  const common = metadata(input);
  if (typeof input.included !== "boolean") throw new TypeError("digest membership must be boolean");
  return {
    ...common,
    kind: "digest-membership",
    digestId: text(input.digestId, "digest ID"),
    included: input.included,
  };
}

export function createRoutingDecision(value: unknown): RoutingDecision {
  const input = record(value, "routing decision");
  if (input.kind === "route") return createRouteDecision(input);
  if (input.kind === "suppress") return createSuppressionDecision(input);
  if (input.kind === "digest-membership") return createDigestMembershipDecision(input);
  throw new TypeError("unknown routing decision kind");
}

export function serializeRoutingDecision(value: RoutingDecision): string {
  return JSON.stringify(["routing-decision-v1", value]);
}

export function parseRoutingDecision(value: unknown): RoutingDecision {
  if (typeof value !== "string")
    throw new TypeError("routing decision serialization must be a string");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new TypeError("malformed routing decision serialization");
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== "routing-decision-v1") {
    throw new TypeError("malformed routing decision serialization");
  }
  const decision = createRoutingDecision(decoded[1]);
  if (serializeRoutingDecision(decision) !== value)
    throw new TypeError("non-canonical routing decision serialization");
  return decision;
}
