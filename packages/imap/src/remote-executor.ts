import type { ExecutingActionPlan, RemoteAttempt } from "@agent-mail/core";
import type { PreconditionObservation } from "./precondition";

type SatisfiedObservation = Extract<PreconditionObservation, { readonly kind: "satisfied" }>;

/** The durable attempt identity returned by the storage attempt-start boundary. */
export type DurableAttemptEvidence = Readonly<{
  readonly claimId: ExecutingActionPlan["claimId"];
  readonly attempt: RemoteAttempt;
}>;

/**
 * A token issued only for one coherent claimed plan, durable attempt, and
 * satisfied observation. The symbol is deliberately not exported, so callers
 * cannot construct this type structurally; the WeakMap below also protects
 * the runtime boundary if a caller copies the visible symbol property.
 */
const capabilityBrand: unique symbol = Symbol("agent-mail.remote-mutation-capability-brand");
const runtimeCapabilityBrand: unique symbol = Symbol("agent-mail.remote-mutation-capability");
const liveCapabilities = new WeakMap<object, RemoteAttempt>();

export type RemoteMutationCapability = Readonly<{
  readonly [capabilityBrand]: symbol;
}>;

export type RemoteMutationRequest = Readonly<{
  readonly capability: RemoteMutationCapability;
  readonly attempt: RemoteAttempt;
}>;

/** The adapter has no callable mutation surface without an issued capability. */
export type RemoteMutationAdapter = Readonly<{
  readonly execute: (request: RemoteMutationRequest) => Promise<unknown>;
}>;

export type RemoteMutationCapabilityEvidence = Readonly<{
  readonly claimedPlan: ExecutingActionPlan;
  readonly durableAttempt: DurableAttemptEvidence;
  readonly observation: SatisfiedObservation;
}>;

function sameTarget(left: RemoteAttempt["target"], right: RemoteAttempt["target"]): boolean {
  return (
    left.accountId === right.accountId &&
    left.mailboxId === right.mailboxId &&
    left.uidValidity === right.uidValidity &&
    left.uid === right.uid &&
    left.precondition.modseq === right.precondition.modseq
  );
}

function sameAction(left: RemoteAttempt["action"], right: ExecutingActionPlan["action"]): boolean {
  return left.kind === right.kind;
}

function assertCoherentEvidence(input: RemoteMutationCapabilityEvidence): void {
  const { claimedPlan, durableAttempt, observation } = input;
  const { attempt } = durableAttempt;
  if (
    durableAttempt.claimId !== claimedPlan.claimId ||
    attempt.planId !== claimedPlan.planId ||
    attempt.certainty !== "unresolved" ||
    !sameAction(attempt.action, claimedPlan.action) ||
    !claimedPlan.targets.some((target) => sameTarget(target, attempt.target)) ||
    !sameTarget(observation.target, attempt.target) ||
    observation.observed.uidValidity !== attempt.target.uidValidity ||
    observation.observed.uid !== attempt.target.uid ||
    observation.observed.modseq !== attempt.target.precondition.modseq ||
    Date.parse(attempt.startedAt) < Date.parse(claimedPlan.startedAt) ||
    Date.parse(attempt.startedAt) >= Date.parse(claimedPlan.expiresAt)
  ) {
    throw new TypeError("remote mutation evidence is not coherent");
  }
}

/**
 * Module-private constructor. Only the satisfied branch of the executor may
 * call this after the durable attempt and read-only observation are available.
 */
function createRemoteMutationCapability(
  input: RemoteMutationCapabilityEvidence,
): RemoteMutationCapability {
  assertCoherentEvidence(input);
  const capability = Object.freeze({ [capabilityBrand]: runtimeCapabilityBrand });
  liveCapabilities.set(capability, input.durableAttempt.attempt);
  return capability;
}

/** @internal The future concrete adapter must enter through this guarded call. */
export function executeWithRemoteMutationCapability(
  adapter: RemoteMutationAdapter,
  capability: RemoteMutationCapability,
  attempt: RemoteAttempt,
): Promise<unknown> {
  if (typeof capability !== "object" || capability === null) {
    throw new TypeError("remote mutation capability was not issued by the internal executor");
  }
  const boundAttempt = liveCapabilities.get(capability);
  if (boundAttempt === undefined) {
    throw new TypeError("remote mutation capability was not issued by the internal executor");
  }
  if (boundAttempt !== attempt) {
    throw new TypeError("remote mutation capability is not bound to this attempt");
  }
  liveCapabilities.delete(capability);
  return adapter.execute({ capability, attempt });
}

export type RemoteAttemptExecution =
  | Readonly<{
      readonly kind: "stale";
      readonly observation: Extract<
        PreconditionObservation,
        { readonly kind: "stale" | "epoch_changed" }
      >;
      readonly result: unknown;
    }>
  | Readonly<{
      readonly kind: "blocked";
      readonly observation: Exclude<
        PreconditionObservation,
        { readonly kind: "satisfied" | "stale" | "epoch_changed" }
      >;
    }>
  | Readonly<{
      readonly kind: "executed";
      readonly observation: Extract<PreconditionObservation, { readonly kind: "satisfied" }>;
      readonly result: unknown;
    }>;

export type RemoteAttemptExecutorOptions = Readonly<{
  readonly claimedPlan: ExecutingActionPlan;
  readonly durableAttempt: DurableAttemptEvidence;
  readonly readPrecondition: (target: RemoteAttempt["target"]) => Promise<PreconditionObservation>;
  /** Persist the definite no-effect result before returning it to the caller. */
  readonly finalizeStale: (
    input: Readonly<{
      readonly attempt: RemoteAttempt;
      readonly observation: Extract<
        PreconditionObservation,
        { readonly kind: "stale" | "epoch_changed" }
      >;
    }>,
  ) => Promise<unknown>;
  /** Internal adapter method; the capability is always supplied by this module. */
  readonly mutationAdapter: RemoteMutationAdapter;
}>;

/**
 * Read one target and keep mutation capability behind the satisfied branch.
 *
 * A newer MODSEQ and a changed UIDVALIDITY are definite no-effect outcomes;
 * neither branch requests nor invokes the remote mutation capability.
 */
export async function executeRemoteAttempt(
  options: RemoteAttemptExecutorOptions,
): Promise<RemoteAttemptExecution> {
  const attempt = options.durableAttempt.attempt;
  const observation = await options.readPrecondition(attempt.target);
  switch (observation.kind) {
    case "stale":
    case "epoch_changed": {
      const result = await options.finalizeStale({ attempt, observation });
      return { kind: "stale", observation, result };
    }
    case "satisfied": {
      const capability = createRemoteMutationCapability({
        claimedPlan: options.claimedPlan,
        durableAttempt: options.durableAttempt,
        observation,
      });
      const result = await executeWithRemoteMutationCapability(
        options.mutationAdapter,
        capability,
        attempt,
      );
      return { kind: "executed", observation, result };
    }
    case "missing":
    case "unsupported":
    case "transport_error":
      return { kind: "blocked", observation };
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}

export const runRemoteAttempt = executeRemoteAttempt;
