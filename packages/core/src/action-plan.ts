/**
 * Pure, state-specific algebra for one frozen remote action plan.
 *
 * This module deliberately has no persistence or transport knowledge. The
 * boundary constructors parse unknown values; transitions only return a new
 * plan and never mutate the input plan.
 */

import {
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  parseUidValidity,
  type AccountId,
  type MailboxId,
  type RemoteUidValue,
  type UidValidity,
} from "./identifiers";
import {
  createMonotonicSequence,
  parseUtcInstant,
  type MonotonicSequence,
  type UtcInstant,
} from "./time-cursor";

declare const actionPlanIdBrand: unique symbol;
declare const claimIdBrand: unique symbol;
declare const remoteAttemptIdBrand: unique symbol;
declare const actionPlanReasonBrand: unique symbol;

export type ActionPlanId = string & { readonly [actionPlanIdBrand]: "ActionPlanId" };
export type ClaimId = string & { readonly [claimIdBrand]: "ClaimId" };
export type RemoteAttemptId = string & { readonly [remoteAttemptIdBrand]: "RemoteAttemptId" };
export type ActionPlanReason = string & {
  readonly [actionPlanReasonBrand]: "ActionPlanReason";
};

export function createActionPlanId(value: unknown): ActionPlanId {
  return createOpaqueText(value, "action plan ID") as ActionPlanId;
}

export function createClaimId(value: unknown): ClaimId {
  return createOpaqueText(value, "claim ID") as ClaimId;
}

export function createRemoteAttemptId(value: unknown): RemoteAttemptId {
  return createOpaqueText(value, "remote attempt ID") as RemoteAttemptId;
}

export function createActionPlanReason(value: unknown): ActionPlanReason {
  return createOpaqueText(value, "action plan reason") as ActionPlanReason;
}

function createOpaqueText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
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

export type Action =
  | { readonly kind: "markSeen" }
  | { readonly kind: "markUnseen" }
  | { readonly kind: "moveToArchive" }
  | { readonly kind: "moveToTrash" };

/** The exact remote identity and MODSEQ captured by a preview. */
export interface ActionPlanTarget {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
  readonly precondition: {
    readonly modseq: MonotonicSequence;
  };
}

interface ActionPlanBase {
  readonly planId: ActionPlanId;
  readonly action: Action;
  readonly targets: readonly [ActionPlanTarget, ...ActionPlanTarget[]];
  readonly createdAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export interface PendingActionPlan extends ActionPlanBase {
  readonly state: "pending";
}

export interface ExecutingActionPlan extends ActionPlanBase {
  readonly state: "executing";
  readonly claimId: ClaimId;
  readonly startedAt: UtcInstant;
}

export interface CompletedActionPlan extends ActionPlanBase {
  readonly state: "completed";
  readonly completedAt: UtcInstant;
}

export interface PartialActionPlan extends ActionPlanBase {
  readonly state: "partial";
  readonly completedAt: UtcInstant;
}

export interface FailedActionPlan extends ActionPlanBase {
  readonly state: "failed";
  readonly failedAt: UtcInstant;
}

export interface RejectedActionPlan extends ActionPlanBase {
  readonly state: "rejected";
  readonly rejectedAt: UtcInstant;
  readonly reason: ActionPlanReason;
}

export interface ExpiredActionPlan extends ActionPlanBase {
  readonly state: "expired";
  readonly expiredAt: UtcInstant;
}

export interface UncertainActionPlan extends ActionPlanBase {
  readonly state: "uncertain";
  readonly remoteAttemptId: RemoteAttemptId;
  /** The point after which the remote attempt has no durable local result. */
  readonly missingLocalResultAt: UtcInstant;
}

export type ActionPlan =
  | PendingActionPlan
  | ExecutingActionPlan
  | CompletedActionPlan
  | PartialActionPlan
  | FailedActionPlan
  | RejectedActionPlan
  | ExpiredActionPlan
  | UncertainActionPlan;

export type ActionPlanState = ActionPlan["state"];

export type ActionPlanEvent =
  | { readonly type: "claim"; readonly claimId: ClaimId; readonly startedAt: UtcInstant }
  | {
      readonly type: "complete";
      readonly completedAt: UtcInstant;
    }
  | {
      readonly type: "partial";
      readonly completedAt: UtcInstant;
    }
  | { readonly type: "fail"; readonly failedAt: UtcInstant }
  | { readonly type: "reject"; readonly rejectedAt: UtcInstant; readonly reason: ActionPlanReason }
  | { readonly type: "expire"; readonly expiredAt: UtcInstant }
  | {
      readonly type: "uncertain";
      readonly remoteAttemptId: RemoteAttemptId;
      readonly missingLocalResultAt: UtcInstant;
    }
  | {
      readonly type: "resolve-completed";
      readonly completedAt: UtcInstant;
    }
  | {
      readonly type: "resolve-partial";
      readonly completedAt: UtcInstant;
    }
  | { readonly type: "resolve-failed"; readonly failedAt: UtcInstant }
  | {
      readonly type: "resolve-rejected";
      readonly rejectedAt: UtcInstant;
      readonly reason: ActionPlanReason;
    };

export type ActionPlanEventType = ActionPlanEvent["type"];

export const ACTION_PLAN_ALLOWED_TRANSITIONS = {
  pending: ["claim", "reject", "expire"],
  executing: ["complete", "partial", "fail", "reject", "expire", "uncertain"],
  uncertain: ["resolve-completed", "resolve-partial", "resolve-failed", "resolve-rejected"],
  completed: [],
  partial: [],
  failed: [],
  rejected: [],
  expired: [],
} as const satisfies Readonly<Record<ActionPlanState, readonly ActionPlanEventType[]>>;

export const actionPlanAllowedTransitions = ACTION_PLAN_ALLOWED_TRANSITIONS;

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("action-plan value has unknown fields");
  }
  if (ownKeys.length !== keys.length) throw new TypeError("action-plan value is missing fields");
}

function parseUidValidityValue(value: unknown): UidValidity {
  return typeof value === "string" ? parseUidValidity(value) : createUidValidity(value);
}

function parseModseqValue(value: unknown): MonotonicSequence {
  return typeof value === "string" ? parseMonotonicSequence(value) : createMonotonicSequence(value);
}

function parseMonotonicSequence(value: unknown): MonotonicSequence {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TypeError("MODSEQ serialization must be decimal");
  }
  const result = createMonotonicSequence(Number(value));
  if (String(result) !== value) throw new TypeError("non-canonical MODSEQ serialization");
  return result;
}

function parseTarget(value: unknown): ActionPlanTarget {
  const record = requireRecord(value, "action-plan target");
  requireExactKeys(record, ["accountId", "mailboxId", "uidValidity", "uid", "precondition"]);
  const precondition = requireRecord(record.precondition, "target precondition");
  requireExactKeys(precondition, ["modseq"]);
  return {
    accountId: parseAccountId(record.accountId),
    mailboxId: parseMailboxId(record.mailboxId),
    uidValidity: parseUidValidityValue(record.uidValidity),
    uid: createRemoteUidValue(record.uid),
    precondition: { modseq: parseModseqValue(precondition.modseq) },
  };
}

function targetIdentity(target: ActionPlanTarget): string {
  return JSON.stringify([target.accountId, target.mailboxId, target.uidValidity, target.uid]);
}

function parseTargets(value: unknown): readonly [ActionPlanTarget, ...ActionPlanTarget[]] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("action-plan targets must be non-empty");
  }
  const targets = value.map(parseTarget);
  const identities = new Set(targets.map(targetIdentity));
  if (identities.size !== targets.length) throw new TypeError("action-plan targets must be unique");
  const [first, ...rest] = targets;
  if (first === undefined) throw new TypeError("action-plan targets must be non-empty");
  return [first, ...rest];
}

function parseAction(value: unknown): Action {
  const record = requireRecord(value, "action");
  requireExactKeys(record, ["kind"]);
  if (
    record.kind !== "markSeen" &&
    record.kind !== "markUnseen" &&
    record.kind !== "moveToArchive" &&
    record.kind !== "moveToTrash"
  ) {
    throw new TypeError("action kind is not recognized");
  }
  return { kind: record.kind };
}

function parseBase(record: Readonly<Record<string, unknown>>): ActionPlanBase {
  const createdAt = parseUtcInstant(record.createdAt);
  const expiresAt = parseUtcInstant(record.expiresAt);
  if (Date.parse(expiresAt) < Date.parse(createdAt)) {
    throw new TypeError("action-plan expiry must not precede creation");
  }
  return {
    planId: createActionPlanId(record.planId),
    action: parseAction(record.action),
    targets: parseTargets(record.targets),
    createdAt,
    expiresAt,
  };
}

function parseStateBase<S extends ActionPlanState>(
  value: unknown,
  state: S,
  keys: readonly string[],
): ActionPlanBase & { readonly state: S } {
  const record = requireRecord(value, `${state} action plan`);
  requireExactKeys(record, keys);
  if (record.state !== state) throw new TypeError(`${state} action plan has the wrong state`);
  return { ...parseBase(record), state };
}

export function createPendingActionPlan(value: unknown): PendingActionPlan {
  return parseStateBase(value, "pending", [
    "state",
    "planId",
    "action",
    "targets",
    "createdAt",
    "expiresAt",
  ]);
}

export function createExecutingActionPlan(value: unknown): ExecutingActionPlan {
  const base = parseStateBase(value, "executing", [
    "state",
    "planId",
    "action",
    "targets",
    "createdAt",
    "expiresAt",
    "claimId",
    "startedAt",
  ]);
  const record = requireRecord(value, "executing action plan");
  const startedAt = parseUtcInstant(record.startedAt);
  if (Date.parse(startedAt) < Date.parse(base.createdAt)) {
    throw new TypeError("execution start must not precede creation");
  }
  return { ...base, state: "executing", claimId: createClaimId(record.claimId), startedAt };
}

function createResultState(
  value: unknown,
  state: "completed" | "partial",
): CompletedActionPlan | PartialActionPlan {
  const record = requireRecord(value, `${state} action plan`);
  const base = parseStateBase(record, state, [
    "state",
    "planId",
    "action",
    "targets",
    "createdAt",
    "expiresAt",
    "completedAt",
  ]);
  const completedAt = parseUtcInstant(record.completedAt);
  if (Date.parse(completedAt) < Date.parse(base.createdAt)) {
    throw new TypeError("completion must not precede creation");
  }
  return { ...base, state, completedAt };
}

export function createCompletedActionPlan(value: unknown): CompletedActionPlan {
  const result = createResultState(value, "completed");
  if (result.state !== "completed")
    throw new TypeError("completed action plan has the wrong state");
  return result;
}

export function createPartialActionPlan(value: unknown): PartialActionPlan {
  const result = createResultState(value, "partial");
  if (result.state !== "partial") throw new TypeError("partial action plan has the wrong state");
  return result;
}

export function createFailedActionPlan(value: unknown): FailedActionPlan {
  const record = requireRecord(value, "failed action plan");
  const base = parseStateBase(record, "failed", [
    "state",
    "planId",
    "action",
    "targets",
    "createdAt",
    "expiresAt",
    "failedAt",
  ]);
  const failedAt = parseUtcInstant(record.failedAt);
  if (Date.parse(failedAt) < Date.parse(base.createdAt)) {
    throw new TypeError("failure must not precede creation");
  }
  return { ...base, state: "failed", failedAt };
}

export function createRejectedActionPlan(value: unknown): RejectedActionPlan {
  const record = requireRecord(value, "rejected action plan");
  const base = parseStateBase(record, "rejected", [
    "state",
    "planId",
    "action",
    "targets",
    "createdAt",
    "expiresAt",
    "rejectedAt",
    "reason",
  ]);
  const rejectedAt = parseUtcInstant(record.rejectedAt);
  if (Date.parse(rejectedAt) < Date.parse(base.createdAt)) {
    throw new TypeError("rejection must not precede creation");
  }
  return { ...base, state: "rejected", rejectedAt, reason: createActionPlanReason(record.reason) };
}

export function createExpiredActionPlan(value: unknown): ExpiredActionPlan {
  const record = requireRecord(value, "expired action plan");
  const base = parseStateBase(record, "expired", [
    "state",
    "planId",
    "action",
    "targets",
    "createdAt",
    "expiresAt",
    "expiredAt",
  ]);
  const expiredAt = parseUtcInstant(record.expiredAt);
  if (Date.parse(expiredAt) < Date.parse(base.expiresAt)) {
    throw new TypeError("expiration must not precede the plan expiry");
  }
  return { ...base, state: "expired", expiredAt };
}

export function createUncertainActionPlan(value: unknown): UncertainActionPlan {
  const record = requireRecord(value, "uncertain action plan");
  const base = parseStateBase(record, "uncertain", [
    "state",
    "planId",
    "action",
    "targets",
    "createdAt",
    "expiresAt",
    "remoteAttemptId",
    "missingLocalResultAt",
  ]);
  const missingLocalResultAt = parseUtcInstant(record.missingLocalResultAt);
  if (Date.parse(missingLocalResultAt) < Date.parse(base.createdAt)) {
    throw new TypeError("missing local result boundary must not precede creation");
  }
  return {
    ...base,
    state: "uncertain",
    remoteAttemptId: createRemoteAttemptId(record.remoteAttemptId),
    missingLocalResultAt,
  };
}

export function createActionPlan(value: unknown): ActionPlan {
  const record = requireRecord(value, "action plan");
  switch (record.state) {
    case "pending":
      return createPendingActionPlan(record);
    case "executing":
      return createExecutingActionPlan(record);
    case "completed":
      return createCompletedActionPlan(record);
    case "partial":
      return createPartialActionPlan(record);
    case "failed":
      return createFailedActionPlan(record);
    case "rejected":
      return createRejectedActionPlan(record);
    case "expired":
      return createExpiredActionPlan(record);
    case "uncertain":
      return createUncertainActionPlan(record);
    default:
      throw new TypeError("action plan state is not recognized");
  }
}

export const parseActionPlan = createActionPlan;

function cloneTargets(
  targets: readonly [ActionPlanTarget, ...ActionPlanTarget[]],
): readonly [ActionPlanTarget, ...ActionPlanTarget[]] {
  const cloned = targets.map((target) => ({ ...target, precondition: { ...target.precondition } }));
  const [first, ...rest] = cloned;
  if (first === undefined) throw new TypeError("action-plan targets must be non-empty");
  return [first, ...rest];
}

export function serializeActionPlan(value: ActionPlan): ActionPlan {
  switch (value.state) {
    case "pending":
      return { ...value, targets: cloneTargets(value.targets) };
    case "executing":
      return { ...value, targets: cloneTargets(value.targets) };
    case "completed":
      return { ...value, targets: cloneTargets(value.targets) };
    case "partial":
      return { ...value, targets: cloneTargets(value.targets) };
    case "failed":
      return { ...value, targets: cloneTargets(value.targets) };
    case "rejected":
      return { ...value, targets: cloneTargets(value.targets) };
    case "expired":
      return { ...value, targets: cloneTargets(value.targets) };
    case "uncertain":
      return { ...value, targets: cloneTargets(value.targets) };
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

export function createActionPlanEvent(value: unknown): ActionPlanEvent {
  const record = requireRecord(value, "action-plan event");
  switch (record.type) {
    case "claim":
      requireExactKeys(record, ["type", "claimId", "startedAt"]);
      return {
        type: "claim",
        claimId: createClaimId(record.claimId),
        startedAt: parseUtcInstant(record.startedAt),
      };
    case "complete":
      requireExactKeys(record, ["type", "completedAt"]);
      return { type: "complete", completedAt: parseUtcInstant(record.completedAt) };
    case "partial":
      requireExactKeys(record, ["type", "completedAt"]);
      return { type: "partial", completedAt: parseUtcInstant(record.completedAt) };
    case "fail":
      requireExactKeys(record, ["type", "failedAt"]);
      return { type: "fail", failedAt: parseUtcInstant(record.failedAt) };
    case "reject":
      requireExactKeys(record, ["type", "rejectedAt", "reason"]);
      return {
        type: "reject",
        rejectedAt: parseUtcInstant(record.rejectedAt),
        reason: createActionPlanReason(record.reason),
      };
    case "expire":
      requireExactKeys(record, ["type", "expiredAt"]);
      return { type: "expire", expiredAt: parseUtcInstant(record.expiredAt) };
    case "uncertain":
      requireExactKeys(record, ["type", "remoteAttemptId", "missingLocalResultAt"]);
      return {
        type: "uncertain",
        remoteAttemptId: createRemoteAttemptId(record.remoteAttemptId),
        missingLocalResultAt: parseUtcInstant(record.missingLocalResultAt),
      };
    case "resolve-completed":
      requireExactKeys(record, ["type", "completedAt"]);
      return { type: "resolve-completed", completedAt: parseUtcInstant(record.completedAt) };
    case "resolve-partial":
      requireExactKeys(record, ["type", "completedAt"]);
      return { type: "resolve-partial", completedAt: parseUtcInstant(record.completedAt) };
    case "resolve-failed":
      requireExactKeys(record, ["type", "failedAt"]);
      return { type: "resolve-failed", failedAt: parseUtcInstant(record.failedAt) };
    case "resolve-rejected":
      requireExactKeys(record, ["type", "rejectedAt", "reason"]);
      return {
        type: "resolve-rejected",
        rejectedAt: parseUtcInstant(record.rejectedAt),
        reason: createActionPlanReason(record.reason),
      };
    default:
      throw new TypeError("action-plan event type is not recognized");
  }
}

export const parseActionPlanEvent = createActionPlanEvent;

function assertAtOrAfter(value: UtcInstant, boundary: UtcInstant, label: string): void {
  if (Date.parse(value) < Date.parse(boundary))
    throw new ActionPlanTransitionError(`${label} precedes its boundary`);
}

function assertEventAllowed(state: ActionPlanState, event: ActionPlanEventType): void {
  if (!ACTION_PLAN_ALLOWED_TRANSITIONS[state].some((candidate) => candidate === event)) {
    throw new ActionPlanTransitionError(`event ${event} is not allowed from ${state}`);
  }
}

export class ActionPlanTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ActionPlanTransitionError";
  }
}

function transitionToResult(
  plan: ActionPlanBase,
  event: { readonly completedAt: UtcInstant },
  state: "completed" | "partial",
): CompletedActionPlan | PartialActionPlan {
  assertAtOrAfter(event.completedAt, plan.createdAt, "completion");
  return {
    ...baseFields(plan),
    state,
    completedAt: event.completedAt,
  };
}

function transitionToFailed(
  plan: ActionPlanBase,
  event: { readonly failedAt: UtcInstant },
): FailedActionPlan {
  assertAtOrAfter(event.failedAt, plan.createdAt, "failure");
  return {
    ...baseFields(plan),
    state: "failed",
    failedAt: event.failedAt,
  };
}

function baseFields(plan: ActionPlanBase): ActionPlanBase {
  return {
    planId: plan.planId,
    action: plan.action,
    targets: cloneTargets(plan.targets),
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  };
}

export function transitionActionPlan(plan: ActionPlan, event: ActionPlanEvent): ActionPlan {
  assertEventAllowed(plan.state, event.type);
  switch (plan.state) {
    case "pending":
      switch (event.type) {
        case "claim":
          assertAtOrAfter(event.startedAt, plan.createdAt, "execution start");
          return {
            ...baseFields(plan),
            state: "executing",
            claimId: event.claimId,
            startedAt: event.startedAt,
          };
        case "reject":
          assertAtOrAfter(event.rejectedAt, plan.createdAt, "rejection");
          return {
            ...baseFields(plan),
            state: "rejected",
            rejectedAt: event.rejectedAt,
            reason: event.reason,
          };
        case "expire":
          assertAtOrAfter(event.expiredAt, plan.expiresAt, "expiration");
          return { ...baseFields(plan), state: "expired", expiredAt: event.expiredAt };
        default: {
          throw new ActionPlanTransitionError(`event ${event.type} is not valid for pending`);
        }
      }
    case "executing":
      switch (event.type) {
        case "complete":
          assertAtOrAfter(event.completedAt, plan.startedAt, "completion");
          return transitionToResult(plan, event, "completed");
        case "partial":
          assertAtOrAfter(event.completedAt, plan.startedAt, "completion");
          return transitionToResult(plan, event, "partial");
        case "fail":
          assertAtOrAfter(event.failedAt, plan.startedAt, "failure");
          return transitionToFailed(plan, event);
        case "reject":
          assertAtOrAfter(event.rejectedAt, plan.startedAt, "rejection");
          return {
            ...baseFields(plan),
            state: "rejected",
            rejectedAt: event.rejectedAt,
            reason: event.reason,
          };
        case "expire":
          assertAtOrAfter(event.expiredAt, plan.expiresAt, "expiration");
          return { ...baseFields(plan), state: "expired", expiredAt: event.expiredAt };
        case "uncertain":
          assertAtOrAfter(event.missingLocalResultAt, plan.startedAt, "missing local result");
          return {
            ...baseFields(plan),
            state: "uncertain",
            remoteAttemptId: event.remoteAttemptId,
            missingLocalResultAt: event.missingLocalResultAt,
          };
        default: {
          throw new ActionPlanTransitionError(`event ${event.type} is not valid for executing`);
        }
      }
    case "uncertain":
      switch (event.type) {
        case "resolve-completed":
          assertAtOrAfter(
            event.completedAt,
            plan.missingLocalResultAt,
            "reconciliation completion",
          );
          return transitionToResult(plan, event, "completed");
        case "resolve-partial":
          assertAtOrAfter(
            event.completedAt,
            plan.missingLocalResultAt,
            "reconciliation completion",
          );
          return transitionToResult(plan, event, "partial");
        case "resolve-failed":
          assertAtOrAfter(event.failedAt, plan.missingLocalResultAt, "reconciliation failure");
          return transitionToFailed(plan, event);
        case "resolve-rejected":
          assertAtOrAfter(event.rejectedAt, plan.missingLocalResultAt, "reconciliation rejection");
          return {
            ...baseFields(plan),
            state: "rejected",
            rejectedAt: event.rejectedAt,
            reason: event.reason,
          };
        default: {
          throw new ActionPlanTransitionError(`event ${event.type} is not valid for uncertain`);
        }
      }
    case "completed":
    case "partial":
    case "failed":
    case "rejected":
    case "expired": {
      throw new ActionPlanTransitionError(`event ${event.type} is not valid for terminal plan`);
    }
    default: {
      const exhaustive: never = plan;
      return exhaustive;
    }
  }
}
