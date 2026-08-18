import { createActor, fromCallback, type ActorRefFromLogic, type CallbackActorLogic } from "xstate";
import { calculateRetryDelay } from "./retry-delay-policy";
import type { RetryTimerActorInput, SyncReleaseSlotHandle, WorkflowFault } from "./sync-statechart";

export type RetryTimerHandle = number | ReturnType<typeof globalThis.setTimeout>;

/** A clock boundary owned by the composition root so tests never sleep. */
export interface RetryTimerClock {
  readonly setTimeout: (callback: () => void, delayMs: number) => RetryTimerHandle;
  readonly clearTimeout: (handle: RetryTimerHandle) => void;
}

export type RetryTimerEvent =
  | { readonly type: "retryTimer.elapsed"; readonly scopeEpoch: number }
  | {
      readonly type: "retryTimer.failed";
      readonly scopeEpoch: number;
      readonly fault: WorkflowFault;
    };

export interface RetryTimerDependencies {
  readonly createAbortController?: () => AbortController;
  readonly faultFromError?: (error: unknown) => WorkflowFault;
}

export const nativeRetryTimerClock: RetryTimerClock = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) =>
    globalThis.setTimeout(() => callback(), delayMs),
  clearTimeout: (handle: RetryTimerHandle) => globalThis.clearTimeout(handle),
});

export const nativeRetryRandomSource = (): number => Math.random();

const defaultFault = (_error: unknown): WorkflowFault => ({
  category: "invariant",
  code: "sync.retry-timer",
  safeMessage: "Retry timer failed.",
});

function validateInput(input: RetryTimerActorInput): void {
  if (!Number.isSafeInteger(input.scopeEpoch) || input.scopeEpoch < 0)
    throw new RangeError("scopeEpoch must be a non-negative safe integer");
  if (!Number.isSafeInteger(input.retryAttempt) || input.retryAttempt < 0)
    throw new RangeError("retryAttempt must be a non-negative safe integer");
  if (typeof input.injectedRandomSource !== "function")
    throw new TypeError("injectedRandomSource must be callable");
  if (
    typeof input.injectedClock.setTimeout !== "function" ||
    typeof input.injectedClock.clearTimeout !== "function"
  )
    throw new TypeError("injectedClock must provide setTimeout and clearTimeout");
}

function normalizeFault(dependencies: RetryTimerDependencies, error: unknown): WorkflowFault {
  try {
    const candidate = dependencies.faultFromError?.(error);
    const keys = candidate && Object.keys(candidate).sort();
    if (
      candidate &&
      candidate.category === "invariant" &&
      JSON.stringify(keys) === JSON.stringify(["category", "code", "safeMessage"]) &&
      typeof candidate.code === "string" &&
      candidate.code.length > 0 &&
      candidate.code.length <= 256 &&
      candidate.code.trim() === candidate.code &&
      typeof candidate.safeMessage === "string" &&
      candidate.safeMessage.length > 0 &&
      candidate.safeMessage.length <= 500 &&
      candidate.safeMessage.trim() === candidate.safeMessage
    )
      return candidate;
  } catch {
    // The error normalizer is a boundary helper; its failure is itself invariant.
  }
  return defaultFault(error);
}

function failedEvent(scopeEpoch: number, fault: WorkflowFault): RetryTimerEvent {
  return { type: "retryTimer.failed", scopeEpoch, fault };
}

/**
 * Creates the signed one-shot retry callback actor. Delay calculation is the
 * sole responsibility of retry-delay-policy; this actor only owns scheduling,
 * release registration, cancellation, and one terminal event.
 */
export function createRetryTimerActorLogic(
  dependencies: RetryTimerDependencies = {},
): CallbackActorLogic<RetryTimerEvent, RetryTimerActorInput> {
  const createAbortController = dependencies.createAbortController ?? (() => new AbortController());

  return fromCallback<RetryTimerEvent, RetryTimerActorInput>(({ input, sendBack }) => {
    let delayMs: number;
    try {
      validateInput(input);
      delayMs = calculateRetryDelay({
        retryAttempt: input.retryAttempt,
        retryBaseMs: input.retryBaseMs,
        retryCapMs: input.retryCapMs,
        retryJitterRatio: input.retryJitterRatio,
        random: input.injectedRandomSource,
      });
    } catch (error: unknown) {
      sendBack(failedEvent(input.scopeEpoch, normalizeFault(dependencies, error)));
      return;
    }

    const clock = input.injectedClock ?? nativeRetryTimerClock;
    let controller: AbortController;
    try {
      controller = createAbortController();
    } catch (error: unknown) {
      sendBack(failedEvent(input.scopeEpoch, normalizeFault(dependencies, error)));
      return;
    }

    const signal = controller.signal;
    let timer: RetryTimerHandle | undefined;
    let timerCleared = false;
    let listenerAttached = false;
    let listenerRemoved = false;
    let status: "open" | "disposed" | "settling" | "settled" = "open";
    let disposed = false;
    let timerSlot: SyncReleaseSlotHandle | undefined;
    let listenerSlot: SyncReleaseSlotHandle | undefined;
    let cleanupError: unknown;

    const clearTimer = (): void => {
      if (timerCleared || timer === undefined) return;
      const handle = timer;
      try {
        clock.clearTimeout(handle);
        timerCleared = true;
        timer = undefined;
      } catch (error: unknown) {
        cleanupError ??= error;
      }
    };

    const onAbort = (): void => {
      if (status !== "open") return;
      status = "disposed";
      disposed = true;
      try {
        signal.removeEventListener("abort", onAbort);
        listenerRemoved = true;
        listenerAttached = false;
      } catch (error: unknown) {
        cleanupError ??= error;
      }
      clearTimer();
      void Promise.allSettled(
        [timerSlot, listenerSlot]
          .filter((slot): slot is SyncReleaseSlotHandle => slot !== undefined)
          .map((slot) => slot.triggerRelease()),
      );
    };

    const removeListener = (): void => {
      if (listenerRemoved || !listenerAttached) return;
      try {
        signal.removeEventListener("abort", onAbort);
        listenerRemoved = true;
        listenerAttached = false;
      } catch (error: unknown) {
        cleanupError ??= error;
      }
    };

    const abortController = (): void => {
      try {
        controller.abort();
      } catch (error: unknown) {
        cleanupError ??= error;
      }
    };

    const releaseSlots = async (): Promise<unknown> => {
      const slots = [timerSlot, listenerSlot].filter(
        (slot): slot is SyncReleaseSlotHandle => slot !== undefined,
      );
      const results = await Promise.allSettled(slots.map((slot) => slot.triggerRelease()));
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected) return rejected.reason;
      const failed = results
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<SyncReleaseSlotHandle["triggerRelease"]>>
          > => result.status === "fulfilled",
        )
        .map((result) => result.value)
        .find((terminal) => terminal.status === "error");
      return failed?.diagnostic ?? undefined;
    };

    const settle = async (kind: "elapsed" | "failed", error?: unknown): Promise<void> => {
      if (status !== "open") return;
      status = "settling";
      removeListener();
      clearTimer();
      abortController();
      const releaseError = await releaseSlots();
      if (disposed) return;
      status = "settled";
      const failure = error ?? cleanupError ?? releaseError;
      if (failure !== undefined || kind === "failed") {
        sendBack(failedEvent(input.scopeEpoch, normalizeFault(dependencies, failure)));
      } else {
        sendBack({ type: "retryTimer.elapsed", scopeEpoch: input.scopeEpoch });
      }
    };

    const dispose = (): void => {
      if (status === "disposed" || status === "settled") return;
      status = "disposed";
      disposed = true;
      removeListener();
      clearTimer();
      abortController();
      void releaseSlots();
    };

    try {
      const registerReleaseSlot = input.resourceRegistry.registerReleaseSlot;
      if (registerReleaseSlot) {
        timerSlot = registerReleaseSlot({
          ownerScope: "workflow",
          ownerInvokeIdentity: `retryTimer:${input.scopeEpoch}`,
          resourceOrdinal: 0,
          stableResourceId: `retryTimer:${input.scopeEpoch}:timer`,
          release: clearTimer,
        });
        listenerSlot = registerReleaseSlot({
          ownerScope: "workflow",
          ownerInvokeIdentity: `retryTimer:${input.scopeEpoch}`,
          resourceOrdinal: 1,
          stableResourceId: `retryTimer:${input.scopeEpoch}:listener`,
          release: removeListener,
        });
      }
      signal.addEventListener("abort", onAbort);
      listenerAttached = true;
      if (signal.aborted) {
        onAbort();
        return dispose;
      }
      timer = clock.setTimeout(() => {
        if (status !== "open") return;
        void settle("elapsed");
      }, delayMs);
      void (timer === undefined && settle("failed", new Error("timer handle was not returned")));
    } catch (error: unknown) {
      void settle("failed", error);
    }

    return dispose;
  });
}

export const retryTimerActorLogic = createRetryTimerActorLogic();

export function createRetryTimerActor(
  input: RetryTimerActorInput,
  dependencies: RetryTimerDependencies = {},
): ActorRefFromLogic<typeof retryTimerActorLogic> {
  return createActor(createRetryTimerActorLogic(dependencies), { input });
}
