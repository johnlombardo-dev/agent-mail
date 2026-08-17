/**
 * Pure, state-specific values for one remote mutation attempt and its result.
 *
 * An attempt is deliberately a per-target record. Results repeat the complete
 * identity and precondition snapshot so that a result remains attributable
 * after an action plan has been reloaded. This module does not execute or
 * reconcile a remote operation.
 */

import {
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseMailboxId,
  parseUidValidity,
  type MailboxId,
  type RemoteUidValue,
  type UidValidity,
} from "./identifiers";
import {
  createActionPlanId,
  createRemoteAttemptId,
  type Action,
  type ActionPlanId,
  type ActionPlanTarget,
  type RemoteAttemptId,
} from "./action-plan";
import {
  createMonotonicSequence,
  parseUtcInstant,
  type MonotonicSequence,
  type UtcInstant,
} from "./time-cursor";

declare const remoteIdempotencyKeyBrand: unique symbol;
declare const safeOperatorDetailBrand: unique symbol;

/** A stable key reused when the same frozen target is retried. */
export type RemoteIdempotencyKey = string & {
  readonly [remoteIdempotencyKeyBrand]: "RemoteIdempotencyKey";
};

/** Operator detail is bounded text, never an untrusted transport exception. */
export type SafeOperatorDetail = string & {
  readonly [safeOperatorDetailBrand]: "SafeOperatorDetail";
};

export type AttemptCertainty = "unresolved";
export type ResultCertainty = "definite" | "uncertain";

export type UncertainReason =
  | "socket-timeout-after-transmission"
  | "connection-lost-after-transmission"
  | "local-result-not-durable";

/** Definite failures are only observations that rule out a remote write. */
export type DefiniteFailureReason =
  | "server-rejected"
  | "permission-denied"
  | "target-not-found"
  | "transport-failed-before-transmission";

export interface RemoteAttempt {
  readonly kind: "attempt";
  readonly planId: ActionPlanId;
  readonly action: Action;
  readonly target: ActionPlanTarget;
  readonly attemptId: RemoteAttemptId;
  readonly idempotencyKey: RemoteIdempotencyKey;
  readonly startedAt: UtcInstant;
  readonly certainty: AttemptCertainty;
}

/** The postcondition observed by the server-side read after a successful write. */
export type ServerObservedPostcondition =
  | {
      readonly kind: "flags";
      readonly observedAt: UtcInstant;
      readonly flags: readonly string[];
      readonly modseq: MonotonicSequence;
    }
  | {
      readonly kind: "mailbox";
      readonly observedAt: UtcInstant;
      readonly mailboxId: MailboxId;
      readonly uidValidity: UidValidity;
      readonly uid: RemoteUidValue;
      readonly modseq: MonotonicSequence;
    };

interface RemoteAttemptResultBase {
  readonly planId: ActionPlanId;
  readonly action: Action;
  readonly target: ActionPlanTarget;
  readonly attemptId: RemoteAttemptId;
  readonly idempotencyKey: RemoteIdempotencyKey;
  readonly startedAt: UtcInstant;
  /** Local observation/recording time, not a claim that the write succeeded. */
  readonly resultAt: UtcInstant;
}

export interface RemoteAttemptSuccess extends RemoteAttemptResultBase {
  readonly kind: "success";
  readonly certainty: "definite";
  readonly postcondition: ServerObservedPostcondition;
}

export interface RemoteAttemptStale extends RemoteAttemptResultBase {
  readonly kind: "stale";
  readonly certainty: "definite";
  readonly detail: SafeOperatorDetail;
}

export interface RemoteAttemptRejected extends RemoteAttemptResultBase {
  readonly kind: "rejected";
  readonly certainty: "definite";
  readonly detail: SafeOperatorDetail;
}

export interface RemoteAttemptFailed extends RemoteAttemptResultBase {
  readonly kind: "failed";
  readonly certainty: "definite";
  readonly failureReason: DefiniteFailureReason;
  readonly detail: SafeOperatorDetail;
}

export interface RemoteAttemptUncertain extends RemoteAttemptResultBase {
  readonly kind: "uncertain";
  readonly certainty: "uncertain";
  readonly uncertainReason: UncertainReason;
  readonly detail: SafeOperatorDetail;
}

export type RemoteAttemptResult =
  | RemoteAttemptSuccess
  | RemoteAttemptStale
  | RemoteAttemptRejected
  | RemoteAttemptFailed
  | RemoteAttemptUncertain;

export type RemoteAttemptRecord = RemoteAttempt | RemoteAttemptResult;
export type RemoteAttemptResultKind = RemoteAttemptResult["kind"];

type RecordValue = Readonly<Record<string, unknown>>;

function isPlainRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): RecordValue {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function exact(recordValue: RecordValue, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const ownKeys = Reflect.ownKeys(recordValue);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
}

function text(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
      );
    })
  ) {
    throw new TypeError(`${label} must be bounded, non-empty, trimmed text`);
  }
  return value;
}

function parseIdempotencyKey(value: unknown): RemoteIdempotencyKey {
  return text(value, "remote idempotency key", 256) as RemoteIdempotencyKey;
}

export function createRemoteIdempotencyKey(value: unknown): RemoteIdempotencyKey {
  return parseIdempotencyKey(value);
}

export const createIdempotencyKey = createRemoteIdempotencyKey;

function createDetail(value: unknown): SafeOperatorDetail {
  const detail = text(value, "remote operator detail", 512);
  if (
    /\b(?:password|passwd|secret|credential|token|authorization|bearer|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key)\b/iu.test(
      detail,
    ) ||
    /:\/\/[^/\s:]+:[^/@\s]+@/u.test(detail)
  ) {
    throw new TypeError("remote operator detail contains credential material");
  }
  return detail as SafeOperatorDetail;
}

function rejectPostTransmissionAmbiguity(detail: SafeOperatorDetail): void {
  if (
    /\b(?:socket\s+)?(?:timed?\s*out|timeout)\b.*\b(?:after|following)\b.*\b(?:send|transmi(?:tted|ssion)|command|request)\b/iu.test(
      detail,
    ) ||
    /\bconnection\s+lost\b.*\b(?:after|following)\b.*\b(?:send|transmi(?:tted|ssion)|command|request)\b/iu.test(
      detail,
    )
  ) {
    throw new TypeError("a post-transmission transport ambiguity must be uncertain");
  }
}

function parseDefiniteFailureReason(value: unknown): DefiniteFailureReason {
  if (
    value !== "server-rejected" &&
    value !== "permission-denied" &&
    value !== "target-not-found" &&
    value !== "transport-failed-before-transmission"
  ) {
    throw new TypeError("definite failure reason is not recognized");
  }
  return value;
}

export function createSafeOperatorDetail(value: unknown): SafeOperatorDetail {
  return createDetail(value);
}

function parseUidValidityValue(value: unknown): UidValidity {
  return typeof value === "string" ? parseUidValidity(value) : createUidValidity(value);
}

function parseModseqValue(value: unknown): MonotonicSequence {
  if (typeof value === "string") {
    if (!/^\d+$/u.test(value)) throw new TypeError("MODSEQ serialization must be decimal");
    const result = createMonotonicSequence(Number(value));
    if (String(result) !== value) throw new TypeError("non-canonical MODSEQ serialization");
    return result;
  }
  return createMonotonicSequence(value);
}

function parseTarget(value: unknown): ActionPlanTarget {
  const target = record(value, "remote attempt target");
  exact(target, ["accountId", "mailboxId", "uidValidity", "uid", "precondition"], "target");
  const precondition = record(target.precondition, "target precondition");
  exact(precondition, ["modseq"], "target precondition");
  return {
    accountId: parseAccountId(target.accountId),
    mailboxId: parseMailboxId(target.mailboxId),
    uidValidity: parseUidValidityValue(target.uidValidity),
    uid: createRemoteUidValue(target.uid),
    precondition: { modseq: parseModseqValue(precondition.modseq) },
  };
}

function parseAction(value: unknown): Action {
  const action = record(value, "remote attempt action");
  exact(action, ["kind"], "remote attempt action");
  if (
    action.kind !== "markSeen" &&
    action.kind !== "markUnseen" &&
    action.kind !== "moveToArchive" &&
    action.kind !== "moveToTrash"
  ) {
    throw new TypeError("remote attempt action is not recognized");
  }
  return { kind: action.kind };
}

function parseBase(value: unknown, label: string): RemoteAttemptResultBase {
  const item = record(value, label);
  const target = parseTarget(item.target);
  return {
    planId: createActionPlanId(item.planId),
    action: parseAction(item.action),
    target,
    attemptId: createRemoteAttemptId(item.attemptId),
    idempotencyKey: parseIdempotencyKey(item.idempotencyKey),
    startedAt: parseUtcInstant(item.startedAt),
    resultAt: parseUtcInstant(item.resultAt),
  };
}

function freezeTarget(target: ActionPlanTarget): ActionPlanTarget {
  return Object.freeze({
    accountId: target.accountId,
    mailboxId: target.mailboxId,
    uidValidity: target.uidValidity,
    uid: target.uid,
    precondition: Object.freeze({ modseq: target.precondition.modseq }),
  });
}

function freezeAction(action: Action): Action {
  return Object.freeze({ kind: action.kind });
}

function freezeBase<T extends RemoteAttemptResultBase>(base: T): T {
  return Object.freeze({
    ...base,
    action: freezeAction(base.action),
    target: freezeTarget(base.target),
  });
}

function parseAttempt(value: unknown): RemoteAttempt {
  const item = record(value, "remote attempt");
  exact(
    item,
    ["kind", "planId", "action", "target", "attemptId", "idempotencyKey", "startedAt", "certainty"],
    "remote attempt",
  );
  if (item.kind !== "attempt" || item.certainty !== "unresolved") {
    throw new TypeError("remote attempt has contradictory kind or certainty");
  }
  const action = parseAction(item.action);
  return Object.freeze({
    kind: "attempt",
    planId: createActionPlanId(item.planId),
    action: freezeAction(action),
    target: freezeTarget(parseTarget(item.target)),
    attemptId: createRemoteAttemptId(item.attemptId),
    idempotencyKey: parseIdempotencyKey(item.idempotencyKey),
    startedAt: parseUtcInstant(item.startedAt),
    certainty: "unresolved",
  });
}

function parseFlags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("server-observed flags must be an array");
  const flags = value.map((flag) => text(flag, "server-observed flag", 128));
  if (new Set(flags).size !== flags.length)
    throw new TypeError("server-observed flags must be unique");
  return Object.freeze(flags);
}

function parsePostcondition(value: unknown): ServerObservedPostcondition {
  const postcondition = record(value, "server-observed postcondition");
  if (postcondition.kind === "flags") {
    exact(postcondition, ["kind", "observedAt", "flags", "modseq"], "flags postcondition");
    return Object.freeze({
      kind: "flags",
      observedAt: parseUtcInstant(postcondition.observedAt),
      flags: parseFlags(postcondition.flags),
      modseq: parseModseqValue(postcondition.modseq),
    });
  }
  if (postcondition.kind === "mailbox") {
    exact(
      postcondition,
      ["kind", "observedAt", "mailboxId", "uidValidity", "uid", "modseq"],
      "mailbox postcondition",
    );
    return Object.freeze({
      kind: "mailbox",
      observedAt: parseUtcInstant(postcondition.observedAt),
      mailboxId: parseMailboxId(postcondition.mailboxId),
      uidValidity: parseUidValidityValue(postcondition.uidValidity),
      uid: createRemoteUidValue(postcondition.uid),
      modseq: parseModseqValue(postcondition.modseq),
    });
  }
  throw new TypeError("server-observed postcondition is not recognized");
}

function assertPostconditionMatchesAction(
  action: Action,
  postcondition: ServerObservedPostcondition,
): void {
  const expectsFlags = action.kind === "markSeen" || action.kind === "markUnseen";
  if (expectsFlags !== (postcondition.kind === "flags")) {
    throw new TypeError("server-observed postcondition contradicts the requested action");
  }
  if (postcondition.kind !== "flags") return;
  const hasSeen = postcondition.flags.some((flag) => flag.toLowerCase() === "\\seen");
  if (action.kind === "markSeen" && !hasSeen) {
    throw new TypeError("markSeen success must observe the \\Seen flag");
  }
  if (action.kind === "markUnseen" && hasSeen) {
    throw new TypeError("markUnseen success must observe no \\Seen flag");
  }
}

function parseUncertainReason(value: unknown): UncertainReason {
  if (
    value !== "socket-timeout-after-transmission" &&
    value !== "connection-lost-after-transmission" &&
    value !== "local-result-not-durable"
  ) {
    throw new TypeError("uncertain reason is not recognized");
  }
  return value;
}

export function createRemoteAttempt(value: unknown): RemoteAttempt {
  return parseAttempt(value);
}

export const parseRemoteAttempt = createRemoteAttempt;

export function serializeRemoteAttempt(value: RemoteAttempt): RemoteAttempt {
  return {
    kind: value.kind,
    planId: value.planId,
    action: freezeAction(value.action),
    target: freezeTarget(value.target),
    attemptId: value.attemptId,
    idempotencyKey: value.idempotencyKey,
    startedAt: value.startedAt,
    certainty: value.certainty,
  };
}

function createResult(value: unknown, kind: RemoteAttemptResultKind): RemoteAttemptResult {
  const item = record(value, `${kind} remote attempt result`);
  const commonKeys = [
    "kind",
    "planId",
    "action",
    "target",
    "attemptId",
    "idempotencyKey",
    "startedAt",
    "resultAt",
  ] as const;
  if (item.kind !== kind) throw new TypeError(`${kind} result has the wrong kind`);
  const base = parseBase(item, `${kind} remote attempt result`);
  if (Date.parse(base.resultAt) < Date.parse(base.startedAt)) {
    throw new TypeError("remote attempt result precedes attempt start");
  }
  switch (kind) {
    case "success": {
      exact(item, [...commonKeys, "certainty", "postcondition"], "success result");
      if (item.certainty !== "definite") throw new TypeError("success result must be definite");
      const postcondition = parsePostcondition(item.postcondition);
      assertPostconditionMatchesAction(base.action, postcondition);
      if (Date.parse(postcondition.observedAt) < Date.parse(base.startedAt)) {
        throw new TypeError("postcondition observation precedes attempt start");
      }
      if (Date.parse(postcondition.observedAt) > Date.parse(base.resultAt)) {
        throw new TypeError("postcondition observation follows result recording");
      }
      return Object.freeze({
        ...freezeBase(base),
        kind,
        certainty: "definite",
        postcondition,
      });
    }
    case "stale":
    case "rejected": {
      exact(item, [...commonKeys, "certainty", "detail"], `${kind} result`);
      if (item.certainty !== "definite") throw new TypeError(`${kind} result must be definite`);
      const detail = createDetail(item.detail);
      return Object.freeze({
        ...freezeBase(base),
        kind,
        certainty: "definite",
        detail,
      });
    }
    case "failed": {
      exact(item, [...commonKeys, "certainty", "failureReason", "detail"], "failed result");
      if (item.certainty !== "definite") throw new TypeError("failed result must be definite");
      const failureReason = parseDefiniteFailureReason(item.failureReason);
      const detail = createDetail(item.detail);
      rejectPostTransmissionAmbiguity(detail);
      return Object.freeze({
        ...freezeBase(base),
        kind,
        certainty: "definite",
        failureReason,
        detail,
      });
    }
    case "uncertain": {
      exact(item, [...commonKeys, "certainty", "uncertainReason", "detail"], "uncertain result");
      if (item.certainty !== "uncertain")
        throw new TypeError("uncertain result has wrong certainty");
      return Object.freeze({
        ...freezeBase(base),
        kind,
        certainty: "uncertain",
        uncertainReason: parseUncertainReason(item.uncertainReason),
        detail: createDetail(item.detail),
      });
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function createRemoteAttemptSuccess(value: unknown): RemoteAttemptSuccess {
  const result = createResult(value, "success");
  if (result.kind !== "success") throw new TypeError("not a success result");
  return result;
}

export function createRemoteAttemptStale(value: unknown): RemoteAttemptStale {
  const result = createResult(value, "stale");
  if (result.kind !== "stale") throw new TypeError("not a stale result");
  return result;
}

export function createRemoteAttemptRejected(value: unknown): RemoteAttemptRejected {
  const result = createResult(value, "rejected");
  if (result.kind !== "rejected") throw new TypeError("not a rejected result");
  return result;
}

export function createRemoteAttemptFailed(value: unknown): RemoteAttemptFailed {
  const result = createResult(value, "failed");
  if (result.kind !== "failed") throw new TypeError("not a failed result");
  return result;
}

export function createRemoteAttemptUncertain(value: unknown): RemoteAttemptUncertain {
  const result = createResult(value, "uncertain");
  if (result.kind !== "uncertain") throw new TypeError("not an uncertain result");
  return result;
}

export function createRemoteAttemptResult(value: unknown): RemoteAttemptResult {
  const item = record(value, "remote attempt result");
  switch (item.kind) {
    case "success":
      return createRemoteAttemptSuccess(item);
    case "stale":
      return createRemoteAttemptStale(item);
    case "rejected":
      return createRemoteAttemptRejected(item);
    case "failed":
      return createRemoteAttemptFailed(item);
    case "uncertain":
      return createRemoteAttemptUncertain(item);
    default:
      throw new TypeError("remote attempt result kind is not recognized");
  }
}

export const parseRemoteAttemptResult = createRemoteAttemptResult;
export const createAttemptResult = createRemoteAttemptResult;
export const parseAttemptResult = createRemoteAttemptResult;

export function serializeRemoteAttemptResult(value: RemoteAttemptResult): RemoteAttemptResult {
  switch (value.kind) {
    case "success":
      return {
        ...freezeBase(value),
        kind: value.kind,
        certainty: value.certainty,
        postcondition: parsePostcondition(value.postcondition),
      };
    case "stale":
    case "rejected":
      return {
        ...freezeBase(value),
        kind: value.kind,
        certainty: value.certainty,
        detail: value.detail,
      };
    case "failed":
      return {
        ...freezeBase(value),
        kind: value.kind,
        certainty: value.certainty,
        failureReason: value.failureReason,
        detail: value.detail,
      };
    case "uncertain":
      return {
        ...freezeBase(value),
        kind: value.kind,
        certainty: value.certainty,
        uncertainReason: value.uncertainReason,
        detail: value.detail,
      };
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

export const serializeAttemptResult = serializeRemoteAttemptResult;
