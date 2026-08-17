import { createHmac, type BinaryLike } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  createLocalLabel,
  createRoutingFacts,
  createRoutingRule,
  parseMailboxId,
  parseMessageId,
  parsePlacementId,
  parseUtcInstant,
  serializeRoutingRule,
  type LocalLabel,
  type MessageId,
  type RoutingFacts,
  type RoutingRule,
  type RoutingProvenance,
  type UtcInstant,
} from "@agent-mail/core";

export const ROUTING_PREVIEW_SCOPE = "mail:routing:read" as const;
export const DEFAULT_ROUTING_PREVIEW_TTL_MS = 30 * 60 * 1000;
export const MAX_ROUTING_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ROUTING_PREVIEW_TARGETS = 1024;

type PlainRecord = Readonly<Record<string, unknown>>;
type RoutingPreviewDatabase = Database | Readonly<{ readonly db: Database }>;

export type RoutingPreviewCandidateTarget =
  | Readonly<{
      readonly kind: "local-label";
      readonly messageId: MessageId;
      readonly label: LocalLabel;
    }>
  | Readonly<{
      readonly kind: "remote-placement";
      readonly messageId: MessageId;
      readonly placementId: ReturnType<typeof parsePlacementId>;
      readonly mailboxId: ReturnType<typeof parseMailboxId>;
    }>;

export type RoutingPreview = Readonly<{
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
}>;

export type RoutingPreviewCreationInput = Readonly<{
  readonly previewId: unknown;
  readonly rule: unknown;
  readonly facts: unknown;
  readonly provenance: unknown;
  readonly candidateTargets: unknown;
  readonly scope?: unknown;
  readonly ttlMs?: unknown;
}>;

export type RoutingPreviewCreationDependencies = Readonly<{
  /** Returns one canonical millisecond UTC instant for this creation. */
  readonly clock: () => unknown;
  /** Returns one fresh opaque nonce. The caller owns unpredictability. */
  readonly nonce: () => unknown;
  /** Private HMAC key used to make preview commitments non-forgeable by clients. */
  readonly digestKey: BinaryLike;
}>;

type PreparedPreview = Readonly<{
  readonly preview: RoutingPreview;
  readonly ruleJson: string;
  readonly factsJson: string;
  readonly provenanceJson: string;
  readonly candidateTargetsJson: string;
}>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainRecord(value: unknown, name: string): PlainRecord {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function requireExactKeys(value: PlainRecord, keys: readonly string[], name: string): void {
  const actual = Reflect.ownKeys(value);
  const allowed = new Set(keys);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${name} has missing or unknown fields`);
  }
}

function parseCreationInput(value: unknown): PlainRecord {
  const input = requirePlainRecord(value, "routing preview creation input");
  const required = ["previewId", "rule", "facts", "provenance", "candidateTargets"];
  const allowed = new Set([...required, "scope", "ttlMs"]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key)) ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError("routing preview creation input has missing or unknown fields");
  }
  return input;
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

function text(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`${name} must be a bounded, trimmed string`);
  }
  return value;
}

function namespaced(value: unknown, name: string, prefix: string, maximum: number): string {
  const result = text(value, name, maximum);
  if (!result.startsWith(`${prefix}:`) || result.length === prefix.length + 1) {
    throw new TypeError(`${name} must use the ${prefix}: namespace`);
  }
  return result;
}

function boundedCanonical<T>(
  value: unknown,
  name: string,
  parser: (input: unknown) => T,
  maximum = 256,
): T {
  const parsed = parser(value);
  text(parsed, name, maximum);
  return parsed;
}

function boundedLocalLabel(value: unknown): LocalLabel {
  const label = createLocalLabel(value);
  text(label, "candidate local label", 256);
  return label;
}

function parseTarget(value: unknown): RoutingPreviewCandidateTarget {
  const input = requirePlainRecord(value, "routing preview candidate target");
  if (input.kind === "local-label") {
    requireExactKeys(input, ["kind", "messageId", "label"], "local-label candidate target");
    return {
      kind: "local-label",
      messageId: boundedCanonical(input.messageId, "candidate message ID", parseMessageId),
      label: boundedLocalLabel(input.label),
    };
  }
  if (input.kind === "remote-placement") {
    requireExactKeys(
      input,
      ["kind", "messageId", "placementId", "mailboxId"],
      "remote-placement candidate target",
    );
    return {
      kind: "remote-placement",
      messageId: boundedCanonical(input.messageId, "candidate message ID", parseMessageId),
      placementId: boundedCanonical(input.placementId, "candidate placement ID", parsePlacementId),
      mailboxId: boundedCanonical(input.mailboxId, "candidate mailbox ID", parseMailboxId),
    };
  }
  throw new TypeError("routing preview candidate target kind is unsupported");
}

function targetIdentity(target: RoutingPreviewCandidateTarget): string {
  return target.kind === "local-label"
    ? JSON.stringify([target.kind, target.messageId])
    : JSON.stringify([target.kind, target.messageId, target.placementId]);
}

function parseTargets(value: unknown): readonly RoutingPreviewCandidateTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROUTING_PREVIEW_TARGETS) {
    throw new TypeError(
      `routing preview candidate targets must contain 1-${MAX_ROUTING_PREVIEW_TARGETS} entries`,
    );
  }
  const targets = value.map(parseTarget);
  const identities = new Set<string>();
  for (const target of targets) {
    const identity = targetIdentity(target);
    if (identities.has(identity)) throw new TypeError("routing preview targets must be unique");
    identities.add(identity);
  }
  return targets;
}

function parseTtl(value: unknown): number {
  const ttl = value ?? DEFAULT_ROUTING_PREVIEW_TTL_MS;
  if (
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    ttl > MAX_ROUTING_PREVIEW_TTL_MS
  ) {
    throw new TypeError("routing preview TTL must be a positive bounded millisecond integer");
  }
  return ttl;
}

function expireAt(createdAt: UtcInstant, ttlMs: number): UtcInstant {
  const timestamp = Date.parse(createdAt);
  const expiry = timestamp + ttlMs;
  if (!Number.isSafeInteger(expiry)) throw new TypeError("routing preview expiry is out of range");
  return parseUtcInstant(new Date(expiry).toISOString());
}

function serializeFacts(facts: RoutingFacts): string {
  return JSON.stringify(facts);
}

function serializeTargets(targets: readonly RoutingPreviewCandidateTarget[]): string {
  return JSON.stringify(targets);
}

function parseProvenance(value: unknown): RoutingProvenance {
  const input = requirePlainRecord(value, "routing preview provenance");
  requireExactKeys(input, ["source", "evaluationId"], "routing preview provenance");
  return {
    source: text(input.source, "provenance source", 256),
    evaluationId: text(input.evaluationId, "provenance evaluation ID", 256),
  };
}

function enforceRuleBounds(rule: RoutingRule): RoutingRule {
  text(rule.ruleId, "routing rule ID", 256);
  if (rule.predicate.kind === "exactSender") {
    text(rule.predicate.sender, "routing sender predicate", 998);
  } else {
    text(rule.predicate.listId, "routing List-ID predicate", 998);
  }
  return rule;
}

function enforceFactBounds(facts: RoutingFacts): RoutingFacts {
  if (facts.senderAddrSpec !== null) text(facts.senderAddrSpec, "sender fact", 2_048);
  if (facts.listId !== null) text(facts.listId, "List-ID fact", 2_048);
  return facts;
}

/**
 * Canonical bytes hashed for a preview. The serialized rule, facts, and
 * targets are embedded as strings so their own canonical encodings are part of
 * the digest rather than relying on object property insertion by a caller.
 */
export function serializeRoutingPreviewDigestEnvelope(
  preview: Pick<
    RoutingPreview,
    | "previewId"
    | "scope"
    | "createdAt"
    | "expiresAt"
    | "nonce"
    | "rule"
    | "facts"
    | "provenance"
    | "candidateTargets"
  >,
): string {
  return JSON.stringify([
    "routing-preview-v1",
    preview.previewId,
    preview.scope,
    serializeRoutingRule(preview.rule),
    serializeFacts(preview.facts),
    JSON.stringify(preview.provenance),
    serializeTargets(preview.candidateTargets),
    preview.createdAt,
    preview.expiresAt,
    preview.nonce,
  ]);
}

export function routingPreviewDigest(
  preview: Parameters<typeof serializeRoutingPreviewDigestEnvelope>[0],
  digestKey: BinaryLike,
): string {
  const keyLength = typeof digestKey === "string" ? Buffer.byteLength(digestKey) : digestKey.byteLength;
  if (keyLength < 32) throw new TypeError("routing preview digest key must contain at least 32 bytes");
  return createHmac("sha256", digestKey)
    .update(serializeRoutingPreviewDigestEnvelope(preview), "utf8")
    .digest("hex");
}

function preparePreview(
  value: unknown,
  dependencies: RoutingPreviewCreationDependencies,
): PreparedPreview {
  const input = parseCreationInput(value);
  const previewId = namespaced(input.previewId, "preview ID", "preview", 256);
  const scope = input.scope ?? ROUTING_PREVIEW_SCOPE;
  if (scope !== ROUTING_PREVIEW_SCOPE) {
    throw new TypeError("routing preview scope cannot be broadened");
  }
  const rule = enforceRuleBounds(createRoutingRule(input.rule));
  const facts = enforceFactBounds(createRoutingFacts(input.facts));
  const provenance = parseProvenance(input.provenance);
  const candidateTargets = parseTargets(input.candidateTargets);
  const createdAt = parseUtcInstant(dependencies.clock());
  const expiresAt = expireAt(createdAt, parseTtl(input.ttlMs));
  const nonce = namespaced(dependencies.nonce(), "preview nonce", "nonce", 512);
  const previewWithoutDigest = {
    previewId,
    scope: ROUTING_PREVIEW_SCOPE,
    rule,
    facts,
    provenance,
    candidateTargets,
    createdAt,
    expiresAt,
    nonce,
  } satisfies Omit<RoutingPreview, "digest">;
  const digest = routingPreviewDigest(previewWithoutDigest, dependencies.digestKey);
  const preview = {
    ...previewWithoutDigest,
    digest,
  } satisfies RoutingPreview;
  return {
    preview: deepFreeze(preview),
    ruleJson: serializeRoutingRule(rule),
    factsJson: serializeFacts(facts),
    provenanceJson: JSON.stringify(provenance),
    candidateTargetsJson: serializeTargets(candidateTargets),
  };
}

/** Create exactly one immutable preview row; no decision or label writes occur. */
export function createRoutingPreview(
  connection: RoutingPreviewDatabase,
  input: unknown,
  dependencies: RoutingPreviewCreationDependencies,
): RoutingPreview {
  const prepared = preparePreview(input, dependencies);
  const database = getDatabase(connection);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    database
      .query(
        `INSERT INTO routing_previews
          (preview_id, scope, rule_version, rule_json, facts_json, provenance_json,
           candidate_targets_json, created_at, expires_at, nonce, digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        prepared.preview.previewId,
        prepared.preview.scope,
        prepared.preview.rule.ruleVersion,
        prepared.ruleJson,
        prepared.factsJson,
        prepared.provenanceJson,
        prepared.candidateTargetsJson,
        prepared.preview.createdAt,
        prepared.preview.expiresAt,
        prepared.preview.nonce,
        prepared.preview.digest,
      );
    database.exec("COMMIT;");
    return prepared.preview;
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], "routing preview transaction failed");
      }
    }
    throw error;
  }
}

function getDatabase(connection: RoutingPreviewDatabase): Database {
  if (isDatabase(connection)) return connection;
  return connection.db;
}

function isDatabase(connection: RoutingPreviewDatabase): connection is Database {
  return "query" in connection && "exec" in connection;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
