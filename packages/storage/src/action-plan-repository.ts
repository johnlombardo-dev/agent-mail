import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  createMonotonicSequence,
  createActionPlanId,
  createPendingActionPlan as parsePendingActionPlan,
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  type ActionPlanTarget,
  type PendingActionPlan,
} from "@agent-mail/core";
import {
  decodeBoundedSafeInteger,
  decodeClosedEnum,
  decodeSqliteRow,
  decodeUtcMillisecondInstant,
  type SqliteColumnContext,
} from "./row-decoders";

const MAX_TARGETS = 1_024;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROPOSAL_TABLE = "action_plan_proposals";

type PlainRecord = Readonly<Record<string, unknown>>;

/** The pending proposal plus the evidence needed to authorize it later. */
export type PendingActionPlanProposal = Readonly<
  PendingActionPlan & {
    readonly previewDigest: string;
    readonly authorizationScope: string;
    readonly idempotencyIdentity: string;
  }
>;

export type PendingActionPlanRepository = Readonly<{
  readonly create: (input: unknown) => PendingActionPlanProposal;
  readonly read: (planId: unknown) => PendingActionPlanProposal | undefined;
}>;

export class PendingActionPlanIdempotencyConflictError extends Error {
  readonly code = "pending-plan-idempotency-conflict" as const;
  readonly idempotencyIdentity: string;

  constructor(idempotencyIdentity: string) {
    super("pending action plan idempotency identity conflicts with an existing proposal");
    this.name = "PendingActionPlanIdempotencyConflictError";
    this.idempotencyIdentity = idempotencyIdentity;
  }
}

export class PendingActionPlanIdentityConflictError extends Error {
  readonly code = "pending-plan-identity-conflict" as const;
  readonly planId: string;

  constructor(planId: string) {
    super("pending action plan identity already exists with a different proposal");
    this.name = "PendingActionPlanIdentityConflictError";
    this.planId = planId;
  }
}

export class PendingActionPlanSchemaError extends Error {
  readonly code = "pending-plan-schema-missing" as const;

  constructor() {
    super("pending action plan proposal migration is required before repository use");
    this.name = "PendingActionPlanSchemaError";
  }
}

/**
 * Canonical bytes used for idempotency comparison. Targets are sorted by their
 * immutable remote identity; their MODSEQ preconditions remain order-sensitive
 * values within that identity sequence.
 */
export function serializePendingActionPlanProposal(proposal: PendingActionPlanProposal): string {
  const targets = sortTargets(proposal.targets);
  return JSON.stringify([
    "pending-action-plan-v1",
    proposal.planId,
    proposal.action.kind,
    targets.map((target) => [
      target.accountId,
      target.mailboxId,
      target.uidValidity,
      target.uid,
      target.precondition.modseq,
    ]),
    proposal.createdAt,
    proposal.expiresAt,
    proposal.previewDigest,
    proposal.authorizationScope,
    proposal.idempotencyIdentity,
  ]);
}

export function pendingActionPlanProposalDigest(proposal: PendingActionPlanProposal): string {
  return createHash("sha256")
    .update(serializePendingActionPlanProposal(proposal), "utf8")
    .digest("hex");
}

/** Create or converge one immutable pending action plan in one transaction. */
export function createPendingActionPlan(
  database: Database,
  input: unknown,
): PendingActionPlanProposal {
  const prepared = prepareProposal(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    requireProposalSchema(database);

    const existingByIdempotency = readByIdempotency(database, prepared.idempotencyIdentity);
    if (existingByIdempotency !== undefined) {
      if (existingByIdempotency.proposalBytes !== prepared.proposalBytes) {
        throw new PendingActionPlanIdempotencyConflictError(prepared.idempotencyIdentity);
      }
      database.exec("COMMIT;");
      transactionStarted = false;
      return deepFreeze(existingByIdempotency.proposal);
    }

    if (planExists(database, prepared.plan.planId)) {
      throw new PendingActionPlanIdentityConflictError(prepared.plan.planId);
    }

    insertPlan(database, prepared.plan);
    insertTargets(database, prepared.plan);
    insertProposal(database, prepared);

    const saved = readPendingActionPlan(database, prepared.plan.planId);
    if (saved === undefined) throw new Error("pending action plan disappeared during transaction");
    database.exec("COMMIT;");
    transactionStarted = false;
    return deepFreeze(saved);
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

/** Read a proposal through strict SQLite row decoders and the core domain parser. */
export function readPendingActionPlan(
  database: Database,
  planIdInput: unknown,
): PendingActionPlanProposal | undefined {
  const planId = parsePlanId(planIdInput);
  requireProposalSchema(database);
  const metadataRow: unknown = database
    .query(
      `SELECT p.plan_id, p.preview_digest, p.authorization_scope, p.idempotency_identity,
              p.proposal_bytes, a.action_kind, a.state, a.created_at, a.expires_at
         FROM ${PROPOSAL_TABLE} AS p
         JOIN action_plans AS a ON a.plan_id = p.plan_id
        WHERE p.plan_id = ?;`,
    )
    .get(planId);
  if (metadataRow === null) return undefined;
  const metadata = decodeMetadataRow(metadataRow);
  if (metadata.state !== "pending") {
    throw new Error("stored pending action plan is not pending");
  }
  const targetRows: readonly unknown[] = database
    .query(
      "SELECT account_id, mailbox_id, uid_validity, uid, precondition_modseq " +
        "FROM action_plan_targets WHERE plan_id = ? ORDER BY target_ordinal;",
    )
    .all(planId);
  if (targetRows.length === 0 || targetRows.length > MAX_TARGETS) {
    throw new Error("stored pending action plan has an invalid target count");
  }
  const targets = targetRows.map(decodeTargetRow);
  const proposal = createProposal({
    planId: metadata.plan_id,
    action: { kind: metadata.action_kind },
    targets,
    createdAt: metadata.created_at,
    expiresAt: metadata.expires_at,
    previewDigest: metadata.preview_digest,
    authorizationScope: metadata.authorization_scope,
    idempotencyIdentity: metadata.idempotency_identity,
  });
  if (serializePendingActionPlanProposal(proposal) !== metadata.proposal_bytes) {
    throw new Error("stored pending action plan proposal bytes do not match its fields");
  }
  return deepFreeze(proposal);
}

export function createPendingActionPlanRepository(database: Database): PendingActionPlanRepository {
  return {
    create: (input) => createPendingActionPlan(database, input),
    read: (planId) => readPendingActionPlan(database, planId),
  };
}

type PreparedProposal = Readonly<{
  readonly plan: PendingActionPlan;
  readonly previewDigest: string;
  readonly authorizationScope: string;
  readonly idempotencyIdentity: string;
  readonly proposalBytes: string;
}>;

function prepareProposal(value: unknown): PreparedProposal {
  const input = requirePlainRecord(value, "pending action plan creation input");
  const fields = Object.keys(input);
  const nested = Object.prototype.hasOwnProperty.call(input, "plan");
  if (nested) {
    assertMetadataKeys(fields, ["plan"]);
    return prepareValues(
      input.plan,
      selectMetadataValue(input, "previewDigest", "digest"),
      selectMetadataValue(input, "authorizationScope", "scope"),
      selectMetadataValue(input, "idempotencyIdentity", "idempotencyKey"),
    );
  }
  assertMetadataKeys(fields, ["planId", "action", "targets", "createdAt", "expiresAt"]);
  return prepareValues(
    {
      state: "pending",
      planId: input.planId,
      action: input.action,
      targets: input.targets,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    },
    selectMetadataValue(input, "previewDigest", "digest"),
    selectMetadataValue(input, "authorizationScope", "scope"),
    selectMetadataValue(input, "idempotencyIdentity", "idempotencyKey"),
  );
}

function selectMetadataValue(
  input: PlainRecord,
  canonicalKey: string,
  compatibilityKey: string,
): unknown {
  const hasCanonical = Object.prototype.hasOwnProperty.call(input, canonicalKey);
  const hasCompatibility = Object.prototype.hasOwnProperty.call(input, compatibilityKey);
  if (hasCanonical === hasCompatibility) {
    throw new TypeError(
      `pending action plan input must provide exactly one of ${canonicalKey} or ${compatibilityKey}`,
    );
  }
  return hasCanonical ? input[canonicalKey] : input[compatibilityKey];
}

function prepareValues(
  planValue: unknown,
  previewDigestValue: unknown,
  authorizationScopeValue: unknown,
  idempotencyIdentityValue: unknown,
): PreparedProposal {
  const rawPlan = requirePlainRecord(planValue, "pending action plan");
  const plan = parsePendingActionPlan(rawPlan);
  if (plan.targets.length > MAX_TARGETS) {
    throw new TypeError(`pending action plan targets must contain at most ${MAX_TARGETS} entries`);
  }
  const sortedPlan = {
    ...plan,
    targets: sortTargets(plan.targets),
  } satisfies PendingActionPlan;
  const proposal = {
    ...sortedPlan,
    previewDigest: boundedText(previewDigestValue, "preview digest", 64),
    authorizationScope: boundedText(authorizationScopeValue, "authorization scope", 256),
    idempotencyIdentity: boundedText(idempotencyIdentityValue, "idempotency identity", 256),
  } satisfies PendingActionPlanProposal;
  if (!SHA256.test(proposal.previewDigest)) {
    throw new TypeError("preview digest must be a lowercase SHA-256 hexadecimal value");
  }
  return {
    plan: sortedPlan,
    previewDigest: proposal.previewDigest,
    authorizationScope: proposal.authorizationScope,
    idempotencyIdentity: proposal.idempotencyIdentity,
    proposalBytes: serializePendingActionPlanProposal(proposal),
  };
}

function createProposal(values: {
  readonly planId: unknown;
  readonly action: unknown;
  readonly targets: readonly ActionPlanTarget[];
  readonly createdAt: unknown;
  readonly expiresAt: unknown;
  readonly previewDigest: unknown;
  readonly authorizationScope: unknown;
  readonly idempotencyIdentity: unknown;
}): PendingActionPlanProposal {
  const prepared = prepareValues(
    {
      state: "pending",
      planId: values.planId,
      action: values.action,
      targets: values.targets,
      createdAt: values.createdAt,
      expiresAt: values.expiresAt,
    },
    values.previewDigest,
    values.authorizationScope,
    values.idempotencyIdentity,
  );
  return {
    ...prepared.plan,
    previewDigest: prepared.previewDigest,
    authorizationScope: prepared.authorizationScope,
    idempotencyIdentity: prepared.idempotencyIdentity,
  };
}

function sortTargets(
  targets: readonly [ActionPlanTarget, ...ActionPlanTarget[]],
): readonly [ActionPlanTarget, ...ActionPlanTarget[]] {
  const sorted = [...targets].sort(compareTargets);
  const [first, ...rest] = sorted;
  if (first === undefined) throw new TypeError("pending action plan targets must be non-empty");
  return [first, ...rest];
}

function compareTargets(left: ActionPlanTarget, right: ActionPlanTarget): number {
  const accountComparison = compareText(left.accountId, right.accountId);
  const textComparison = accountComparison || compareText(left.mailboxId, right.mailboxId);
  if (textComparison !== 0) return textComparison;
  return left.uidValidity - right.uidValidity || left.uid - right.uid;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function insertPlan(database: Database, plan: PendingActionPlan): void {
  database
    .query(
      "INSERT INTO action_plans " +
        "(plan_id, action_kind, created_at, expires_at, state) VALUES (?, ?, ?, ?, 'pending');",
    )
    .run(plan.planId, plan.action.kind, plan.createdAt, plan.expiresAt);
}

function insertTargets(database: Database, plan: PendingActionPlan): void {
  const statement = database.query(
    "INSERT INTO action_plan_targets " +
      "(plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, precondition_modseq) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?);",
  );
  for (const [index, target] of plan.targets.entries()) {
    statement.run(
      plan.planId,
      index + 1,
      target.accountId,
      target.mailboxId,
      target.uidValidity,
      target.uid,
      target.precondition.modseq,
    );
  }
}

function insertProposal(database: Database, proposal: PreparedProposal): void {
  database
    .query(
      `INSERT INTO ${PROPOSAL_TABLE}
        (plan_id, preview_digest, authorization_scope, idempotency_identity, proposal_bytes)
       VALUES (?, ?, ?, ?, ?);`,
    )
    .run(
      proposal.plan.planId,
      proposal.previewDigest,
      proposal.authorizationScope,
      proposal.idempotencyIdentity,
      proposal.proposalBytes,
    );
}

function readByIdempotency(
  database: Database,
  idempotencyIdentity: string,
):
  | Readonly<{ readonly proposal: PendingActionPlanProposal; readonly proposalBytes: string }>
  | undefined {
  const row: unknown = database
    .query(`SELECT plan_id FROM ${PROPOSAL_TABLE} WHERE idempotency_identity = ?;`)
    .get(idempotencyIdentity);
  if (row === null) return undefined;
  const record = decodeSqliteRow({
    table: PROPOSAL_TABLE,
    row,
    columns: { plan_id: { decode: decodePlanId } },
  });
  const proposal = readPendingActionPlan(database, record.plan_id);
  if (proposal === undefined) throw new Error("pending action plan idempotency row is orphaned");
  return { proposal, proposalBytes: serializePendingActionPlanProposal(proposal) };
}

function planExists(database: Database, planId: string): boolean {
  return (
    database.query("SELECT 1 AS present FROM action_plans WHERE plan_id = ?;").get(planId) !== null
  );
}

function decodeMetadataRow(value: unknown): {
  readonly plan_id: string;
  readonly preview_digest: string;
  readonly authorization_scope: string;
  readonly idempotency_identity: string;
  readonly proposal_bytes: string;
  readonly action_kind: "markSeen" | "markUnseen" | "moveToArchive" | "moveToTrash";
  readonly state: "pending";
  readonly created_at: string;
  readonly expires_at: string;
} {
  const row = decodeSqliteRow({
    table: PROPOSAL_TABLE,
    row: value,
    columns: {
      plan_id: { decode: decodePlanId },
      preview_digest: { decode: (item, context) => boundedDigest(item, context) },
      authorization_scope: { decode: (item, context) => boundedColumnText(item, context, 256) },
      idempotency_identity: { decode: (item, context) => boundedColumnText(item, context, 256) },
      proposal_bytes: { decode: (item, context) => boundedColumnText(item, context, 1_048_576) },
      action_kind: {
        decode: (item, context) =>
          decodeClosedEnum(item, {
            ...context,
            values: ["markSeen", "markUnseen", "moveToArchive", "moveToTrash"] as const,
          }),
      },
      state: {
        decode: (item, context) =>
          decodeClosedEnum(item, { ...context, values: ["pending"] as const }),
      },
      created_at: { decode: decodeUtcMillisecondInstant },
      expires_at: { decode: decodeUtcMillisecondInstant },
    },
  });
  const plan_id = requireString(row.plan_id);
  const preview_digest = requireString(row.preview_digest);
  const authorization_scope = requireString(row.authorization_scope);
  const idempotency_identity = requireString(row.idempotency_identity);
  const proposal_bytes = requireString(row.proposal_bytes);
  const action_kind = decodeClosedEnum(row.action_kind, {
    table: PROPOSAL_TABLE,
    column: "action_kind",
    values: ["markSeen", "markUnseen", "moveToArchive", "moveToTrash"] as const,
  });
  const state = decodeClosedEnum(row.state, {
    table: PROPOSAL_TABLE,
    column: "state",
    values: ["pending"] as const,
  });
  const created_at = requireString(row.created_at);
  const expires_at = requireString(row.expires_at);
  return {
    plan_id,
    preview_digest,
    authorization_scope,
    idempotency_identity,
    proposal_bytes,
    action_kind,
    state,
    created_at,
    expires_at,
  };
}

function decodeTargetRow(value: unknown): ActionPlanTarget {
  const row = decodeSqliteRow({
    table: "action_plan_targets",
    row: value,
    columns: {
      account_id: { decode: (item, context) => boundedColumnText(item, context, 256) },
      mailbox_id: { decode: (item, context) => boundedColumnText(item, context, 256) },
      uid_validity: {
        decode: (item, context) =>
          decodeBoundedSafeInteger(item, { ...context, minimum: 1, maximum: 4_294_967_295 }),
      },
      uid: {
        decode: (item, context) =>
          decodeBoundedSafeInteger(item, { ...context, minimum: 1, maximum: 4_294_967_295 }),
      },
      precondition_modseq: {
        decode: (item, context) => decodeBoundedSafeInteger(item, { ...context, minimum: 0 }),
      },
    },
  });
  return {
    accountId: parseAccountId(requireString(row.account_id)),
    mailboxId: parseMailboxId(requireString(row.mailbox_id)),
    uidValidity: createUidValidity(row.uid_validity),
    uid: createRemoteUidValue(row.uid),
    precondition: { modseq: createMonotonicSequence(row.precondition_modseq) },
  };
}

function decodePlanId(value: unknown, context: SqliteColumnContext): string {
  const planId = boundedColumnText(value, context, 256);
  return planId.startsWith("plan:") ? planId : failColumn(context);
}

function boundedDigest(value: unknown, context: SqliteColumnContext): string {
  const digest = boundedColumnText(value, context, 64);
  return SHA256.test(digest) ? digest : failColumn(context);
}

function boundedColumnText(value: unknown, context: SqliteColumnContext, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    return failColumn(context);
  }
  return value;
}

function failColumn(context: SqliteColumnContext): never {
  throw new TypeError(`invalid SQLite value at ${context.table}.${context.column}`);
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("decoded SQLite text was not a string");
  return value;
}

function parsePlanId(value: unknown): string {
  const plan = boundedText(value, "plan ID", 256);
  if (!plan.startsWith("plan:")) throw new TypeError("plan ID must use the plan: namespace");
  return createActionPlanId(plan);
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`${name} must be bounded canonical text`);
  }
  return value;
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

function requirePlainRecord(value: unknown, name: string): PlainRecord {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertMetadataKeys(actual: readonly string[], required: readonly string[]): void {
  const allowed = new Set([
    ...required,
    "previewDigest",
    "digest",
    "authorizationScope",
    "scope",
    "idempotencyIdentity",
    "idempotencyKey",
  ]);
  if (actual.some((key) => !allowed.has(key)) || actual.length !== required.length + 3) {
    throw new TypeError("pending action plan input has missing or unknown fields");
  }
}

function requireProposalSchema(database: Database): void {
  const table = database
    .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?;")
    .get(PROPOSAL_TABLE);
  if (table === null) throw new PendingActionPlanSchemaError();
  const triggerNames = [
    "action_plan_proposal_target_insert_guard",
    "action_plan_proposal_target_delete_guard",
    "action_plan_proposal_metadata_update_guard",
    "action_plan_proposal_metadata_delete_guard",
  ];
  const placeholders = triggerNames.map(() => "?").join(", ");
  const row = database
    .query(
      `SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'trigger' AND name IN (${placeholders});`,
    )
    .get(...triggerNames);
  if (!isCountRow(row) || row.count !== triggerNames.length) {
    throw new PendingActionPlanSchemaError();
  }
}

function isCountRow(value: unknown): value is Readonly<{ readonly count: number }> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "count" in value &&
    typeof value.count === "number"
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function rollback(database: Database, original: unknown): never {
  try {
    database.exec("ROLLBACK;");
  } catch (rollbackError: unknown) {
    throw new AggregateError([original, rollbackError], "pending action plan rollback failed");
  }
  throw original;
}
