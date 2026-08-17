import type { RemoteAttempt } from "@agent-mail/core";
import type { PreconditionObservation } from "./precondition";

/** Capability exposed only after the read-only precondition is satisfied. */
export type RemoteMutationCapability = Readonly<{
  readonly execute: (attempt: RemoteAttempt) => Promise<unknown>;
}>;

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
  readonly attempt: RemoteAttempt;
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
  /** This factory is intentionally unreachable for stale or epoch-changed observations. */
  readonly requestMutationCapability: () => Promise<RemoteMutationCapability>;
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
  const observation = await options.readPrecondition(options.attempt.target);
  switch (observation.kind) {
    case "stale":
    case "epoch_changed": {
      const result = await options.finalizeStale({
        attempt: options.attempt,
        observation,
      });
      return { kind: "stale", observation, result };
    }
    case "satisfied": {
      const capability = await options.requestMutationCapability();
      const result = await capability.execute(options.attempt);
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
