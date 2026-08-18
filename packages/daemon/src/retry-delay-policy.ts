/** The inputs owned by the signed retryTimer actor. */
export interface RetryDelayPolicyInput {
  readonly retryAttempt: number;
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  readonly retryJitterRatio: number;
  /** A deterministic source in [0, 1], injected by the actor/composition root. */
  readonly random: () => number;
}

export type RetryHistory =
  | { readonly kind: "transient-failure"; readonly retryAttempt: number }
  | { readonly kind: "success" }
  | { readonly kind: "authentication-failure" }
  | { readonly kind: "permanent-failure" }
  | { readonly kind: "invariant-failure" };

export type RetryDecision =
  | { readonly retryable: true; readonly delayMs: number; readonly nextRetryAttempt: number }
  | {
      readonly retryable: false;
      readonly delayMs: null;
      readonly nextRetryAttempt: 0;
      readonly reason: Exclude<RetryHistory["kind"], "transient-failure">;
    };

export interface RetryDecisionInput extends Omit<RetryDelayPolicyInput, "retryAttempt"> {
  readonly history: RetryHistory;
}

function validate(input: RetryDelayPolicyInput): void {
  if (typeof input.random !== "function") throw new TypeError("random must be a function");
  if (!Number.isSafeInteger(input.retryAttempt) || input.retryAttempt < 0)
    throw new RangeError("retryAttempt must be a non-negative safe integer");
  if (!Number.isSafeInteger(input.retryBaseMs) || input.retryBaseMs <= 0)
    throw new RangeError("retryBaseMs must be a positive safe integer");
  if (!Number.isSafeInteger(input.retryCapMs) || input.retryCapMs <= 0)
    throw new RangeError("retryCapMs must be a positive safe integer");
  if (input.retryCapMs < input.retryBaseMs)
    throw new RangeError("retryCapMs must be greater than or equal to retryBaseMs");
  if (
    !Number.isFinite(input.retryJitterRatio) ||
    input.retryJitterRatio < 0 ||
    input.retryJitterRatio > 1
  )
    throw new RangeError("retryJitterRatio must be between 0 and 1");
}

/**
 * Calculates one transient retry delay.  The exponential term is capped before
 * multiplication, so a large attempt can never overflow into Infinity or wrap
 * into a negative delay. For nominal delay `n` and ratio `r`, jitter is bounded
 * by `n * (1 - r)` and `n * (1 + r)`; the final result is capped again so the
 * configured cap remains authoritative.
 */
export function calculateRetryDelay(input: RetryDelayPolicyInput): number {
  validate(input);
  const random = input.random();
  if (!Number.isFinite(random) || random < 0 || random > 1)
    throw new RangeError("random must return a number between 0 and 1");

  let exponential = input.retryBaseMs;
  for (
    let attempt = 0;
    attempt < input.retryAttempt && exponential < input.retryCapMs;
    attempt += 1
  ) {
    exponential = Math.min(input.retryCapMs, exponential * 2);
  }

  const jitterMultiplier = 1 - input.retryJitterRatio + 2 * input.retryJitterRatio * random;
  return Math.min(input.retryCapMs, exponential * jitterMultiplier);
}

/** Resolves one history entry without scheduling or performing any side effect. */
export function calculateRetryDecision(input: RetryDecisionInput): RetryDecision {
  if (input.history.kind !== "transient-failure") {
    return {
      retryable: false,
      delayMs: null,
      nextRetryAttempt: 0,
      reason: input.history.kind,
    };
  }

  return {
    retryable: true,
    delayMs: calculateRetryDelay({ ...input, retryAttempt: input.history.retryAttempt }),
    nextRetryAttempt: Math.min(Number.MAX_SAFE_INTEGER, input.history.retryAttempt + 1),
  };
}
