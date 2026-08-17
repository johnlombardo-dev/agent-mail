import type { Database } from "bun:sqlite";
import {
  createClaimId,
  createExecutingActionPlan,
  parseUtcInstant,
  type ActionPlanState,
  type ExecutingActionPlan,
} from "@agent-mail/core";
import {
  decodeBoundedSafeInteger,
  decodeClosedEnum,
  decodeNullable,
  decodeSqliteRow,
  decodeUtcMillisecondInstant,
  type SqliteColumnContext,
} from "./row-decoders";
import {
  assertPendingActionPlanSchema,
  readPendingActionPlan,
  type PendingActionPlanProposal,
} from "./action-plan-repository";

const SHA256 = /^[a-f0-9]{64}$/u;
const PROPOSAL_TABLE = "action_plan_proposals";

export type ActionPlanClaimResult =
  | Readonly<{
      readonly kind: "claimed";
      readonly plan: ExecutingActionPlan;
      readonly version: number;
    }>
  | Readonly<{
      readonly kind: "already-claimed";
      readonly planId: string;
      readonly claimId: string;
      readonly startedAt: string;
      readonly version: number;
    }>
  | Readonly<{
      readonly kind: "expired";
      readonly planId: string;
      readonly version: number;
    }>
  | Readonly<{
      readonly kind: "rejected";
      readonly planId: string;
      readonly reason: "authorization" | "digest" | "version" | "plan";
      readonly version: number;
    }>
  | Readonly<{
      readonly kind: "terminal";
      readonly planId: string;
      readonly state: "completed" | "partial" | "uncertain";
      readonly version: number;
    }>;

export type PendingActionPlanClaimRepository = Readonly<{
  readonly claim: (input: unknown) => ActionPlanClaimResult;
}>;

export class ActionPlanClaimSchemaError extends Error {
  readonly code = "action-plan-claim-schema-missing" as const;

  constructor() {
    super("action plan claim migration is required before claim use");
    this.name = "ActionPlanClaimSchemaError";
  }
}

/** Claim one authorized pending plan under SQLite's write lock. */
export function claimPendingActionPlan(database: Database, input: unknown): ActionPlanClaimResult {
  const prepared = prepareClaim(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    assertPendingActionPlanSchema(database);
    requireClaimSchema(database);

    const row = readClaimRow(database, prepared.planId);
    if (row === undefined) throw new TypeError("pending action plan does not exist");

    const evidence = readStoredEvidence(database, row.plan_id);
    const evidenceFailure = rejectEvidence(row, prepared, evidence);
    if (evidenceFailure !== undefined) {
      return commitResult(database, evidenceFailure);
    }

    if (row.state === "executing") {
      const claimId = row.claim_id;
      const startedAt = row.started_at;
      if (claimId === null || startedAt === null) {
        throw new Error("executing action plan is missing its claim identity");
      }
      const result: ActionPlanClaimResult = {
        kind: "already-claimed",
        planId: row.plan_id,
        claimId,
        startedAt,
        version: row.version,
      };
      commitClaimTransaction(database);
      transactionStarted = false;
      return result;
    }
    if (row.state === "expired")
      return commitResult(database, {
        kind: "expired",
        planId: row.plan_id,
        version: row.version,
      });
    if (row.state === "rejected")
      return commitResult(database, {
        kind: "rejected",
        planId: row.plan_id,
        reason: "plan",
        version: row.version,
      });
    if (row.state === "completed" || row.state === "partial" || row.state === "uncertain") {
      return commitResult(database, {
        kind: "terminal",
        planId: row.plan_id,
        state: row.state,
        version: row.version,
      });
    }

    const proposal = readPendingActionPlan(database, row.plan_id);
    if (proposal === undefined) throw new Error("pending action plan proposal is missing");
    if (prepared.now >= row.expires_at || prepared.startedAt >= row.expires_at) {
      return commitResult(database, {
        kind: "expired",
        planId: row.plan_id,
        version: row.version,
      });
    }
    if (prepared.expectedVersion !== row.version) {
      return commitResult(database, {
        kind: "rejected",
        planId: row.plan_id,
        reason: "version",
        version: row.version,
      });
    }

    database
      .query("INSERT INTO action_plan_claims (plan_id, claim_id, claimed_at) VALUES (?, ?, ?);")
      .run(row.plan_id, prepared.claimId, prepared.startedAt);
    const update = database
      .query(
        "UPDATE action_plans SET state = 'executing', claim_id = ?, started_at = ?, version = version + 1 " +
          "WHERE plan_id = ? AND state = 'pending' AND version = ?;",
      )
      .run(prepared.claimId, prepared.startedAt, row.plan_id, prepared.expectedVersion);
    if (update.changes !== 1) throw new Error("pending action plan claim lost its version race");

    const executing = createExecutingActionPlan({
      state: "executing",
      planId: proposal.planId,
      action: proposal.action,
      targets: proposal.targets,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      claimId: prepared.claimId,
      startedAt: prepared.startedAt,
    });
    const result: ActionPlanClaimResult = {
      kind: "claimed",
      plan: executing,
      version: prepared.expectedVersion + 1,
    };
    commitClaimTransaction(database);
    transactionStarted = false;
    return result;
  } catch (error: unknown) {
    if (transactionStarted) rollback(database, error);
    throw error;
  }
}

export function createPendingActionPlanClaimRepository(
  database: Database,
): PendingActionPlanClaimRepository {
  return { claim: (input) => claimPendingActionPlan(database, input) };
}

type PreparedClaim = Readonly<{
  readonly planId: string;
  readonly claimId: ReturnType<typeof createClaimId>;
  readonly startedAt: ReturnType<typeof parseUtcInstant>;
  readonly now: ReturnType<typeof parseUtcInstant>;
  readonly digest: string;
  readonly authorizationScope: string;
  readonly expectedVersion: number;
}>;

type ClaimRow = Readonly<{
  readonly plan_id: string;
  readonly state: ActionPlanState;
  readonly expires_at: string;
  readonly claim_id: string | null;
  readonly started_at: string | null;
  readonly version: number;
}>;

type StoredEvidence = Readonly<{
  readonly preview_digest: string;
  readonly authorization_scope: string;
}>;

function prepareClaim(value: unknown): PreparedClaim {
  const input = requirePlainRecord(value, "action plan claim input");
  const keys = Object.keys(input);
  const allowed = new Set([
    "planId",
    "claimId",
    "startedAt",
    "now",
    "digest",
    "expectedVersion",
    "authorizationEvidence",
    "authorizationScope",
  ]);
  if (keys.some((key) => !allowed.has(key)) || keys.length !== 7) {
    throw new TypeError("action plan claim input has missing or unknown fields");
  }
  const hasEvidence = Object.prototype.hasOwnProperty.call(input, "authorizationEvidence");
  const hasScope = Object.prototype.hasOwnProperty.call(input, "authorizationScope");
  if (hasEvidence === hasScope) {
    throw new TypeError(
      "action plan claim input must provide exactly one authorization evidence field",
    );
  }
  const authorizationScope = hasEvidence
    ? parseAuthorizationEvidence(input.authorizationEvidence)
    : boundedText(input.authorizationScope, "authorization scope", 256);
  const expectedVersion = input.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    throw new TypeError("expected action plan version must be a positive safe integer");
  }
  const digest = boundedText(input.digest, "action plan digest", 64);
  if (!SHA256.test(digest)) throw new TypeError("action plan digest must be SHA-256 hex");
  const now = parseUtcInstant(input.now);
  const startedAt = parseUtcInstant(input.startedAt);
  if (startedAt < now) throw new TypeError("claim start must not precede claim observation time");
  return {
    planId: parsePlanId(input.planId),
    claimId: createClaimId(input.claimId),
    startedAt,
    now,
    digest,
    authorizationScope,
    expectedVersion,
  };
}

function parseAuthorizationEvidence(value: unknown): string {
  if (typeof value === "string") return boundedText(value, "authorization evidence", 256);
  const record = requirePlainRecord(value, "authorization evidence");
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "scope") {
    throw new TypeError("authorization evidence must contain only its verified scope");
  }
  return boundedText(record.scope, "authorization evidence scope", 256);
}

function readClaimRow(database: Database, planId: string): ClaimRow | undefined {
  const value: unknown = database
    .query(
      "SELECT plan_id, state, expires_at, claim_id, started_at, version FROM action_plans WHERE plan_id = ?;",
    )
    .get(planId);
  if (value === null) return undefined;
  const row = decodeSqliteRow({
    table: "action_plans",
    row: value,
    columns: {
      plan_id: { decode: decodePlanId },
      state: {
        decode: (item, context) =>
          decodeClosedEnum(item, {
            ...context,
            values: [
              "pending",
              "executing",
              "completed",
              "partial",
              "rejected",
              "expired",
              "uncertain",
            ] as const,
          }),
      },
      expires_at: { decode: decodeUtcMillisecondInstant },
      claim_id: { decode: nullableNamespacedText("claim"), nullable: true },
      started_at: { decode: nullableInstant(), nullable: true },
      version: {
        decode: (item, context) => decodeBoundedSafeInteger(item, { ...context, minimum: 1 }),
      },
    },
  });
  return {
    plan_id: requireString(row.plan_id),
    state: decodeClosedEnum(row.state, {
      table: "action_plans",
      column: "state",
      values: [
        "pending",
        "executing",
        "completed",
        "partial",
        "rejected",
        "expired",
        "uncertain",
      ] as const,
    }),
    expires_at: requireString(row.expires_at),
    claim_id: row.claim_id === null ? null : requireString(row.claim_id),
    started_at: row.started_at === null ? null : requireString(row.started_at),
    version: decodeBoundedSafeInteger(row.version, {
      table: "action_plans",
      column: "version",
      minimum: 1,
    }),
  };
}

function readStoredEvidence(database: Database, planId: string): StoredEvidence {
  const value: unknown = database
    .query(`SELECT preview_digest, authorization_scope FROM ${PROPOSAL_TABLE} WHERE plan_id = ?;`)
    .get(planId);
  if (value === null) throw new Error("action plan authorization evidence is missing");
  const row = decodeSqliteRow({
    table: PROPOSAL_TABLE,
    row: value,
    columns: {
      preview_digest: { decode: (item, context) => boundedDigest(item, context) },
      authorization_scope: { decode: (item, context) => boundedColumnText(item, context, 256) },
    },
  });
  return {
    preview_digest: requireString(row.preview_digest),
    authorization_scope: requireString(row.authorization_scope),
  };
}

function rejectEvidence(
  row: ClaimRow,
  prepared: PreparedClaim,
  evidence: StoredEvidence | PendingActionPlanProposal,
): ActionPlanClaimResult | undefined {
  const previewDigest =
    "preview_digest" in evidence ? evidence.preview_digest : evidence.previewDigest;
  const authorizationScope =
    "authorization_scope" in evidence ? evidence.authorization_scope : evidence.authorizationScope;
  if (prepared.digest !== previewDigest) {
    return { kind: "rejected", planId: row.plan_id, reason: "digest", version: row.version };
  }
  if (prepared.authorizationScope !== authorizationScope) {
    return { kind: "rejected", planId: row.plan_id, reason: "authorization", version: row.version };
  }
  return undefined;
}

function commitResult(database: Database, result: ActionPlanClaimResult): ActionPlanClaimResult {
  commitClaimTransaction(database);
  return result;
}

function nullableNamespacedText(prefix: string) {
  return decodeNullable((value: unknown, context: SqliteColumnContext): string => {
    const text = boundedColumnText(value, context, 256);
    return text.startsWith(`${prefix}:`) ? text : failColumn(context);
  });
}

function nullableInstant() {
  return decodeNullable(decodeUtcMillisecondInstant);
}

function requireClaimSchema(database: Database): void {
  const columns: readonly unknown[] = database.query("PRAGMA table_info(action_plans);").all();
  if (
    !columns.some(
      (value) =>
        typeof value === "object" && value !== null && "name" in value && value.name === "version",
    )
  ) {
    throw new ActionPlanClaimSchemaError();
  }
}

function commitClaimTransaction(database: Database): void {
  database.exec("COMMIT;");
}

function rollback(database: Database, original: unknown): never {
  try {
    database.exec("ROLLBACK;");
  } catch (rollbackError: unknown) {
    throw new AggregateError([original, rollbackError], "pending action plan rollback failed");
  }
  throw original;
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
  return plan;
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
    )
      return true;
  }
  return false;
}

function requirePlainRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${name} must be a plain object`);
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function isPlainRecord(value: object): value is Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
