import {
  createRouteDecision,
  evaluateRoutingRule,
  parseRoutingRule,
  parseUtcInstant,
  serializeRoutingDecision,
  createRoutingFacts,
  parseMailboxId,
  parseMessageId,
  parsePlacementId,
  parseRoutingDecision,
  type LocalLabel,
  type RoutingFacts,
  type RoutingProvenance,
  type RoutingRule,
  type UtcInstant,
} from "@agent-mail/core";
import type { Database } from "bun:sqlite";
import { canonicalRoutingDecisionId } from "./routing-decision-identity";
import {
  ROUTING_PREVIEW_SCOPE,
  routingPreviewDigest,
  type RoutingPreviewCandidateTarget,
} from "./routing-preview-creation";

export type RoutingPreviewConsumptionInput = Readonly<{
  readonly previewId: unknown;
  readonly scope: unknown;
  readonly nonce: unknown;
  readonly digest: unknown;
  readonly ruleVersion: unknown;
  readonly consumerId: unknown;
  readonly now: unknown;
}>;

export type RoutingPreviewConsumptionDependencies = Readonly<{
  /** Private HMAC key shared with preview creation. */
  readonly digestKey: Parameters<typeof routingPreviewDigest>[1];
}>;

export type RoutingPreviewConsumptionResult =
  | Readonly<{
      readonly kind: "consumed";
      readonly previewId: string;
      readonly consumerId: string;
      readonly consumedAt: UtcInstant;
      readonly decisionsCreated: number;
      readonly labelsCreated: number;
    }>
  | Readonly<{
      readonly kind: "replayed" | "expired";
      readonly previewId: string;
    }>;

export type RoutingPreviewConsumptionErrorReason =
  | "not-found"
  | "invalid-input"
  | "tampered"
  | "target"
  | "schema";

export class RoutingPreviewConsumptionError extends Error {
  readonly code = "routing-preview-consumption-failed" as const;
  readonly reason: RoutingPreviewConsumptionErrorReason;

  constructor(
    reason: RoutingPreviewConsumptionErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RoutingPreviewConsumptionError";
    this.reason = reason;
  }
}

type PlainRecord = Readonly<Record<string, unknown>>;
type StoredPreview = Readonly<{
  readonly previewId: string;
  readonly scope: typeof ROUTING_PREVIEW_SCOPE;
  readonly rule: RoutingRule;
  readonly facts: RoutingFacts;
  readonly provenance: RoutingProvenance;
  readonly candidateTargets: readonly RoutingPreviewCandidateTarget[];
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly nonce: string;
  readonly digest: string;
  readonly consumedAt: UtcInstant | null;
  readonly consumedBy: string | null;
}>;

type PreparedInput = Readonly<{
  readonly previewId: string;
  readonly scope: string;
  readonly nonce: string;
  readonly digest: string;
  readonly ruleVersion: number;
  readonly consumerId: string;
  readonly now: UtcInstant;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, name: string): PlainRecord {
  if (!isRecord(value))
    throw new RoutingPreviewConsumptionError("invalid-input", `${name} must be a plain object`);
  return value;
}

function exactKeys(value: PlainRecord, keys: readonly string[], name: string): void {
  const allowed = new Set(keys);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new RoutingPreviewConsumptionError(
      "invalid-input",
      `${name} has missing or unknown fields`,
    );
  }
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new RoutingPreviewConsumptionError(
      "invalid-input",
      `${name} must be bounded, trimmed text`,
    );
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      throw new RoutingPreviewConsumptionError("invalid-input", `${name} has control characters`);
    }
  }
  return value;
}

function namespaced(value: unknown, name: string, prefix: string, maximum = 256): string {
  const text = boundedText(value, name, maximum);
  if (!text.startsWith(`${prefix}:`) || text.length === prefix.length + 1) {
    throw new RoutingPreviewConsumptionError(
      "invalid-input",
      `${name} must use the ${prefix}: namespace`,
    );
  }
  return text;
}

function prepareInput(value: unknown): PreparedInput {
  const input = requireRecord(value, "routing preview consumption input");
  exactKeys(
    input,
    ["previewId", "scope", "nonce", "digest", "ruleVersion", "consumerId", "now"],
    "routing preview consumption input",
  );
  const ruleVersion = input.ruleVersion;
  if (typeof ruleVersion !== "number" || !Number.isSafeInteger(ruleVersion) || ruleVersion <= 0) {
    throw new RoutingPreviewConsumptionError(
      "invalid-input",
      "rule version must be a positive safe integer",
    );
  }
  const digest = boundedText(input.digest, "preview digest", 64);
  if (!SHA256.test(digest))
    throw new RoutingPreviewConsumptionError("invalid-input", "preview digest must be SHA-256 hex");
  return {
    previewId: namespaced(input.previewId, "preview ID", "preview"),
    scope: boundedText(input.scope, "preview scope", 256),
    nonce: namespaced(input.nonce, "preview nonce", "nonce", 512),
    digest,
    ruleVersion,
    consumerId: namespaced(input.consumerId, "consumer ID", "consumer", 256),
    now: parseInstant(input.now, "consumption time"),
  };
}

function parseInstant(value: unknown, name: string): UtcInstant {
  try {
    return parseUtcInstant(value);
  } catch (error: unknown) {
    throw new RoutingPreviewConsumptionError(
      "invalid-input",
      `${name} must be a canonical UTC instant`,
      { cause: error },
    );
  }
}

function parseJson(value: unknown, name: string): unknown {
  if (typeof value !== "string")
    throw new RoutingPreviewConsumptionError("schema", `${name} must be serialized JSON`);
  try {
    return JSON.parse(value);
  } catch (error: unknown) {
    throw new RoutingPreviewConsumptionError("schema", `${name} is malformed JSON`, {
      cause: error,
    });
  }
}

function parseCandidateTarget(value: unknown): RoutingPreviewCandidateTarget {
  const target = requireRecord(value, "routing preview target");
  if (target.kind === "local-label") {
    exactKeys(target, ["kind", "messageId", "label"], "local-label target");
    return {
      kind: "local-label",
      messageId: parseMessageId(target.messageId),
      label: namespaced(target.label, "target local label", "label") as LocalLabel,
    };
  }
  if (target.kind === "remote-placement") {
    exactKeys(target, ["kind", "messageId", "placementId", "mailboxId"], "remote-placement target");
    return {
      kind: "remote-placement",
      messageId: parseMessageId(target.messageId),
      placementId: parsePlacementId(target.placementId),
      mailboxId: parseMailboxId(target.mailboxId),
    };
  }
  throw new RoutingPreviewConsumptionError("schema", "routing preview target kind is unsupported");
}

function parseTargets(
  value: unknown,
  serialized: string,
): readonly RoutingPreviewCandidateTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024) {
    throw new RoutingPreviewConsumptionError("schema", "routing preview targets are out of bounds");
  }
  const targets = value.map(parseCandidateTarget);
  const identities = new Set<string>();
  for (const target of targets) {
    const identity =
      target.kind === "local-label"
        ? JSON.stringify([target.kind, target.messageId])
        : JSON.stringify([target.kind, target.messageId, target.placementId]);
    if (identities.has(identity))
      throw new RoutingPreviewConsumptionError("schema", "routing preview targets are duplicated");
    identities.add(identity);
  }
  if (JSON.stringify(targets) !== serialized)
    throw new RoutingPreviewConsumptionError(
      "tampered",
      "routing preview targets are not canonical",
    );
  return targets;
}

function readPreview(database: Database, previewId: string): StoredPreview | null {
  const row: unknown = database
    .query(
      `SELECT preview_id, scope, rule_version, rule_json, facts_json, provenance_json,
            candidate_targets_json, created_at, expires_at, nonce, digest,
            consumed_at, consumed_by
       FROM routing_previews WHERE preview_id = ?;`,
    )
    .get(previewId);
  if (row === null) return null;
  const value = requireRecord(row, "routing preview row");
  exactKeys(
    value,
    [
      "preview_id",
      "scope",
      "rule_version",
      "rule_json",
      "facts_json",
      "provenance_json",
      "candidate_targets_json",
      "created_at",
      "expires_at",
      "nonce",
      "digest",
      "consumed_at",
      "consumed_by",
    ],
    "routing preview row",
  );
  const storedPreviewId = namespaced(value.preview_id, "stored preview ID", "preview");
  const scope = boundedText(value.scope, "stored preview scope", 256);
  const ruleVersion = value.rule_version;
  if (typeof ruleVersion !== "number" || !Number.isSafeInteger(ruleVersion) || ruleVersion <= 0)
    throw new RoutingPreviewConsumptionError("schema", "stored preview rule version is invalid");
  if (typeof value.rule_json !== "string")
    throw new RoutingPreviewConsumptionError("schema", "stored preview rule is invalid");
  const rule = parseRule(value.rule_json);
  if (rule.ruleVersion !== ruleVersion)
    throw new RoutingPreviewConsumptionError(
      "tampered",
      "stored preview rule version does not match its rule",
    );
  const factsValue = parseJson(value.facts_json, "stored preview facts");
  const facts = createRoutingFacts(factsValue);
  if (JSON.stringify(facts) !== value.facts_json)
    throw new RoutingPreviewConsumptionError("tampered", "stored preview facts are not canonical");
  const provenanceValue = parseJson(value.provenance_json, "stored preview provenance");
  const provenance = parseProvenance(provenanceValue);
  if (JSON.stringify(provenance) !== value.provenance_json)
    throw new RoutingPreviewConsumptionError(
      "tampered",
      "stored preview provenance is not canonical",
    );
  if (typeof value.candidate_targets_json !== "string")
    throw new RoutingPreviewConsumptionError("schema", "stored preview targets are invalid");
  const candidateTargets = parseTargets(
    parseJson(value.candidate_targets_json, "stored preview targets"),
    value.candidate_targets_json,
  );
  const createdAt = parseInstant(value.created_at, "stored preview creation time");
  const expiresAt = parseInstant(value.expires_at, "stored preview expiry");
  if (Date.parse(expiresAt) <= Date.parse(createdAt))
    throw new RoutingPreviewConsumptionError(
      "tampered",
      "stored preview expiry is not after creation",
    );
  const nonce = namespaced(value.nonce, "stored preview nonce", "nonce", 512);
  const digest = boundedText(value.digest, "stored preview digest", 64);
  if (!SHA256.test(digest))
    throw new RoutingPreviewConsumptionError("schema", "stored preview digest is invalid");
  const consumedAt =
    value.consumed_at === null
      ? null
      : parseInstant(value.consumed_at, "stored preview consumed time");
  const consumedBy =
    value.consumed_by === null
      ? null
      : namespaced(value.consumed_by, "stored preview consumer ID", "consumer");
  if ((consumedAt === null) !== (consumedBy === null))
    throw new RoutingPreviewConsumptionError(
      "tampered",
      "stored preview consumption receipt is incomplete",
    );
  return {
    previewId: storedPreviewId,
    scope: scope as typeof ROUTING_PREVIEW_SCOPE,
    rule,
    facts,
    provenance,
    candidateTargets,
    createdAt,
    expiresAt,
    nonce,
    digest,
    consumedAt,
    consumedBy,
  };
}

function parseRule(value: string): RoutingRule {
  try {
    const rule = parseRoutingRule(value);
    if (JSON.stringify(["routing-rule-v1", rule]) !== value) throw new Error("non-canonical rule");
    return rule;
  } catch (error: unknown) {
    throw new RoutingPreviewConsumptionError("tampered", "stored preview rule is invalid", {
      cause: error,
    });
  }
}

function parseProvenance(value: unknown): RoutingProvenance {
  const provenance = requireRecord(value, "stored preview provenance");
  exactKeys(provenance, ["source", "evaluationId"], "stored preview provenance");
  return {
    source: boundedText(provenance.source, "provenance source", 256),
    evaluationId: boundedText(provenance.evaluationId, "provenance evaluation ID", 256),
  };
}

function verifyAuthority(
  input: PreparedInput,
  preview: StoredPreview,
  digestKey: RoutingPreviewConsumptionDependencies["digestKey"],
): void {
  if (preview.scope !== ROUTING_PREVIEW_SCOPE || input.scope !== preview.scope)
    throw new RoutingPreviewConsumptionError("tampered", "routing preview scope is not authorized");
  if (
    input.previewId !== preview.previewId ||
    input.nonce !== preview.nonce ||
    input.digest !== preview.digest ||
    input.ruleVersion !== preview.rule.ruleVersion
  )
    throw new RoutingPreviewConsumptionError(
      "tampered",
      "routing preview authority does not match the stored proposal",
    );
  const expectedDigest = routingPreviewDigest(preview, digestKey);
  if (expectedDigest !== preview.digest)
    throw new RoutingPreviewConsumptionError(
      "tampered",
      "routing preview digest does not match its canonical envelope",
    );
}

function requireTargetExists(database: Database, target: RoutingPreviewCandidateTarget): void {
  const message = database
    .query("SELECT 1 AS present FROM messages WHERE message_id = ?;")
    .get(target.messageId);
  if (message === null)
    throw new RoutingPreviewConsumptionError(
      "target",
      "a frozen routing target message no longer exists",
    );
  if (target.kind === "remote-placement") {
    const placement = database
      .query(
        "SELECT 1 AS present FROM remote_placements WHERE mailbox_id = ? AND message_id = ? AND tombstone_observed_at IS NULL LIMIT 1;",
      )
      .get(target.mailboxId, target.messageId);
    if (placement === null)
      throw new RoutingPreviewConsumptionError(
        "target",
        "a frozen remote placement target no longer exists",
      );
  }
}

function applyLocalDecision(
  database: Database,
  target: Extract<RoutingPreviewCandidateTarget, { readonly kind: "local-label" }>,
  preview: StoredPreview,
  consumedAt: UtcInstant,
): Readonly<{ decisionCreated: boolean; labelCreated: boolean }> {
  const evaluation = evaluateRoutingRule(preview.rule, preview.facts);
  if (!evaluation.matched)
    throw new RoutingPreviewConsumptionError(
      "tampered",
      "routing preview facts do not authorize its rule",
    );
  const requestedDecision = createRouteDecision({
    kind: "route",
    label: target.label,
    ruleId: preview.rule.ruleId,
    ruleVersion: preview.rule.ruleVersion,
    matchedFacts: evaluation.matchedFacts,
    decidedAt: consumedAt,
    provenance: preview.provenance,
  });
  const matchedFactsJson = JSON.stringify(requestedDecision.matchedFacts);
  const decisionId = canonicalRoutingDecisionId(target.messageId, requestedDecision);
  const existing: unknown = database
    .query(
      "SELECT decision_id, decision_json FROM routing_decisions WHERE message_id = ? AND rule_id = ? AND rule_version = ? AND matched_facts_json = ?;",
    )
    .get(
      target.messageId,
      requestedDecision.ruleId,
      requestedDecision.ruleVersion,
      matchedFactsJson,
    );
  let decisionCreated = false;
  if (existing === null) {
    database
      .query(
        "INSERT INTO routing_decisions (decision_id, message_id, rule_id, rule_version, matched_facts_json, decision_json) VALUES (?, ?, ?, ?, ?, ?);",
      )
      .run(
        decisionId,
        target.messageId,
        requestedDecision.ruleId,
        requestedDecision.ruleVersion,
        matchedFactsJson,
        serializeRoutingDecision(requestedDecision),
      );
    decisionCreated = true;
  }
  let decision = requestedDecision;
  if (existing !== null) {
    const row = requireRecord(existing, "stored routing decision");
    exactKeys(row, ["decision_id", "decision_json"], "stored routing decision");
    if (typeof row.decision_id !== "string" || typeof row.decision_json !== "string") {
      throw new RoutingPreviewConsumptionError(
        "schema",
        "stored routing decision has an invalid shape",
      );
    }
    try {
      const stored = parseRoutingDecision(row.decision_json);
      if (
        stored.kind !== "route" ||
        row.decision_id !== canonicalRoutingDecisionId(target.messageId, stored) ||
        stored.ruleId !== requestedDecision.ruleId ||
        stored.ruleVersion !== requestedDecision.ruleVersion ||
        JSON.stringify(stored.matchedFacts) !== matchedFactsJson
      ) {
        throw new Error("stored routing decision identity does not match the canonical target");
      }
      if (stored.label !== target.label) {
        throw new RoutingPreviewConsumptionError(
          "tampered",
          "stored routing decision label does not match the frozen target",
        );
      }
      decision = stored;
    } catch (error: unknown) {
      if (error instanceof RoutingPreviewConsumptionError) throw error;
      throw new RoutingPreviewConsumptionError(
        "tampered",
        "frozen target conflicts with its canonical routing decision",
        { cause: error },
      );
    }
  }
  database
    .query("INSERT INTO local_labels (label) VALUES (?) ON CONFLICT(label) DO NOTHING;")
    .run(decision.label);
  const assignment: unknown = database
    .query(
      "SELECT message_id, label, rule_id, rule_version, matched_facts_json, decided_at, provenance_source, provenance_evaluation_id FROM local_label_assignments WHERE message_id = ? AND label = ? AND rule_id = ? AND rule_version = ?;",
    )
    .get(target.messageId, decision.label, decision.ruleId, decision.ruleVersion);
  let labelCreated = false;
  if (assignment === null) {
    database
      .query(
        "INSERT INTO local_label_assignments (message_id, label, rule_id, rule_version, matched_facts_json, decided_at, provenance_source, provenance_evaluation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
      )
      .run(
        target.messageId,
        decision.label,
        decision.ruleId,
        decision.ruleVersion,
        matchedFactsJson,
        decision.decidedAt,
        decision.provenance.source,
        decision.provenance.evaluationId,
      );
    labelCreated = true;
  } else {
    const row = requireRecord(assignment, "stored local label assignment");
    exactKeys(
      row,
      [
        "message_id",
        "label",
        "rule_id",
        "rule_version",
        "matched_facts_json",
        "decided_at",
        "provenance_source",
        "provenance_evaluation_id",
      ],
      "stored local label assignment",
    );
    if (
      row.message_id !== target.messageId ||
      row.label !== decision.label ||
      row.rule_id !== decision.ruleId ||
      row.rule_version !== decision.ruleVersion ||
      row.matched_facts_json !== matchedFactsJson ||
      row.decided_at !== decision.decidedAt ||
      row.provenance_source !== decision.provenance.source ||
      row.provenance_evaluation_id !== decision.provenance.evaluationId
    )
      throw new RoutingPreviewConsumptionError(
        "tampered",
        "frozen target conflicts with its local label assignment",
      );
  }
  return { decisionCreated, labelCreated };
}

/** Consume exactly one stored preview and its frozen local routing targets. */
export function consumeRoutingPreview(
  database: Database,
  input: unknown,
  dependencies: RoutingPreviewConsumptionDependencies,
): RoutingPreviewConsumptionResult {
  const prepared = prepareInput(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const preview = readPreview(database, prepared.previewId);
    if (preview === null)
      throw new RoutingPreviewConsumptionError("not-found", "routing preview does not exist");
    verifyAuthority(prepared, preview, dependencies.digestKey);
    if (preview.consumedAt !== null) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return { kind: "replayed", previewId: preview.previewId };
    }
    if (Date.parse(prepared.now) < Date.parse(preview.createdAt)) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      throw new RoutingPreviewConsumptionError(
        "invalid-input",
        "routing preview cannot be consumed before its creation time",
      );
    }
    if (Date.parse(prepared.now) >= Date.parse(preview.expiresAt)) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return { kind: "expired", previewId: preview.previewId };
    }
    let decisionsCreated = 0;
    let labelsCreated = 0;
    for (const target of preview.candidateTargets) {
      requireTargetExists(database, target);
      if (target.kind !== "local-label") continue;
      const applied = applyLocalDecision(database, target, preview, prepared.now);
      if (applied.decisionCreated) decisionsCreated += 1;
      if (applied.labelCreated) labelsCreated += 1;
    }
    const consumed = database
      .query(
        "UPDATE routing_previews SET consumed_at = ?, consumed_by = ? WHERE preview_id = ? AND consumed_at IS NULL;",
      )
      .run(prepared.now, prepared.consumerId, preview.previewId);
    if (consumed.changes !== 1)
      throw new RoutingPreviewConsumptionError(
        "schema",
        "routing preview consumption receipt was not recorded",
      );
    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      kind: "consumed",
      previewId: preview.previewId,
      consumerId: prepared.consumerId,
      consumedAt: prepared.now,
      decisionsCreated,
      labelsCreated,
    };
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "routing preview consumption transaction failed",
        );
      }
    }
    throw error;
  }
}

export const consumeRoutingPreviewOnce = consumeRoutingPreview;
