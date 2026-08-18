import type { Database } from "bun:sqlite";
import {
  createRemoteAttemptId,
  createRemoteAttemptResult,
  parseUtcInstant,
  type RemoteAttempt,
  type RemoteAttemptResult,
  type UtcInstant,
} from "@agent-mail/core";
import {
  readActionAttemptDispatchEvidence,
  type ActionAttemptDispatchEvidence,
} from "./action-plan-recovery";
import {
  readActionPlanResult,
  recordActionPlanReconciliationResult,
  type ActionPlanReconciliationResult,
} from "./action-plan-result";

/** The observer has no mutation method or executor capability by construction. */
export type UncertainAttemptReadOnlyObserver = Readonly<{
  readonly read: (
    input: Readonly<{
      readonly attempt: RemoteAttempt;
      readonly dispatch: ActionAttemptDispatchEvidence;
      readonly resultAt: UtcInstant;
    }>,
  ) => Promise<RemoteAttemptResult>;
}>;

export type ActionPlanReconciliationServiceResult =
  | Readonly<{ readonly kind: "not-dispatched"; readonly attemptId: string }>
  | Readonly<{ readonly kind: "already-resolved"; readonly result: RemoteAttemptResult }>
  | ActionPlanReconciliationResult;

type PreparedInput = Readonly<{
  readonly attemptId: string;
  readonly resultAt: UtcInstant;
  readonly observer: UncertainAttemptReadOnlyObserver;
}>;

/**
 * Reopen one durable dispatch-crossed attempt, perform one read-only remote
 * observation, and persist exactly one result. This function never retries,
 * iterates targets, aggregates plans, or receives a mutation capability.
 */
export async function reconcileUncertainActionPlanAttempt(
  database: Database,
  input: unknown,
): Promise<ActionPlanReconciliationServiceResult> {
  const prepared = prepareInput(input);
  const dispatch = readActionAttemptDispatchEvidence(database, prepared.attemptId);
  if (dispatch === undefined) {
    return { kind: "not-dispatched", attemptId: prepared.attemptId };
  }
  const existing = readActionPlanResult(database, prepared.attemptId);
  if (existing !== undefined && existing.certainty === "definite") {
    return { kind: "already-resolved", result: existing };
  }
  const observed = await prepared.observer.read({
    attempt: dispatch.attempt,
    dispatch,
    resultAt: prepared.resultAt,
  });
  const result = parseObservedResult(observed, prepared.resultAt);
  return recordActionPlanReconciliationResult(database, { result });
}

export const reconcileUncertainAttempt = reconcileUncertainActionPlanAttempt;

function prepareInput(value: unknown): PreparedInput {
  if (!isRecord(value)) {
    throw new TypeError("uncertain reconciliation service input must be an object");
  }
  const input = value;
  const keys = Reflect.ownKeys(input);
  const expected = new Set(["attemptId", "resultAt", "observer"]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new TypeError("uncertain reconciliation service input has missing or unknown fields");
  }
  if (!isObserver(input.observer)) {
    throw new TypeError("uncertain reconciliation service requires a read-only observer");
  }
  return {
    attemptId: parseAttemptId(input.attemptId),
    resultAt: parseUtcInstant(input.resultAt),
    observer: input.observer,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObserver(value: unknown): value is UncertainAttemptReadOnlyObserver {
  return isRecord(value) && typeof value.read === "function";
}

function parseAttemptId(value: unknown): string {
  const id = createRemoteAttemptId(value);
  if (!id.startsWith("attempt:")) throw new TypeError("attempt ID must use the attempt: namespace");
  return id;
}

function parseObservedResult(value: unknown, resultAt: string): RemoteAttemptResult {
  const result = createRemoteAttemptResult(value);
  if (result.resultAt !== resultAt) {
    throw new TypeError("reconciliation result time does not match the service observation time");
  }
  return result;
}
