import { createActor, fromCallback, type ActorRefFromLogic, type CallbackActorLogic } from "xstate";
import type { SyncActorInputs } from "./sync-statechart";

export type PollingTimerHandle = number | ReturnType<typeof globalThis.setTimeout>;

export interface PollingTimerClock {
  readonly setTimeout: (callback: () => void, delayMs: number) => PollingTimerHandle;
  readonly clearTimeout: (handle: PollingTimerHandle) => void;
}

export interface PollingTimerFault {
  readonly category: "authentication" | "transient" | "permanent" | "invariant";
  readonly code: string;
  readonly safeMessage: string;
}

/** The actor input is the signed periodicStatusTimer input plus its registry authority. */
export interface PollingTimerInput extends Pick<
  SyncActorInputs,
  "scopeEpoch" | "resourceRegistry"
> {
  readonly periodicStatusIntervalMs: number;
}

export type PollingTimerEvent =
  | { readonly type: "watchTimer.elapsed"; readonly scopeEpoch: number }
  | {
      readonly type: "watchTimer.failed";
      readonly scopeEpoch: number;
      readonly fault: PollingTimerFault;
    };

export interface PollingTimerDependencies {
  readonly clock?: PollingTimerClock;
  readonly createAbortController?: () => AbortController;
  readonly onTick?: () => void;
  readonly faultFromError?: (error: unknown) => PollingTimerFault;
}

interface PollingReleaseSlotHandle {
  readonly triggerRelease: () => Promise<unknown>;
}

const nativeClock: PollingTimerClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const defaultFault = (error: unknown): PollingTimerFault => ({
  category: "invariant",
  code: "sync.polling-timer",
  safeMessage: error instanceof Error ? "Polling timer callback failed" : "Polling timer failed",
});

function validateInput(input: PollingTimerInput): void {
  if (!Number.isSafeInteger(input.scopeEpoch) || input.scopeEpoch < 0)
    throw new RangeError("scopeEpoch must be a non-negative safe integer");
  if (!Number.isSafeInteger(input.periodicStatusIntervalMs) || input.periodicStatusIntervalMs <= 0)
    throw new RangeError("periodicStatusIntervalMs must be a positive safe integer");
  if (
    typeof input.resourceRegistry.requestPhase !== "function" ||
    typeof input.resourceRegistry.awaitPhase !== "function"
  )
    throw new TypeError("resourceRegistry must provide its signed phase authority");
}

/**
 * Creates the signed one-shot periodicStatusTimer callback actor.
 *
 * The controller is created inside each invocation. Its disposer aborts that
 * controller, and the single named abort callback owns the shared cleanup
 * barrier for the timer and listener before any event is sent back.
 */
export function createPollingTimerActorLogic(
  dependencies: PollingTimerDependencies = {},
): CallbackActorLogic<PollingTimerEvent, PollingTimerInput> {
  const clock = dependencies.clock ?? nativeClock;
  const createAbortController = dependencies.createAbortController ?? (() => new AbortController());

  return fromCallback<PollingTimerEvent, PollingTimerInput>(({ input, sendBack }) => {
    validateInput(input);
    const controller = createAbortController();
    const signal = controller.signal;
    let timer: PollingTimerHandle | undefined;
    let cleaned = false;
    let releaseSlot: PollingReleaseSlotHandle | undefined;

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      controller.abort();
      signal.removeEventListener("abort", onAbort);
    };

    const sendFailure = (error: unknown): void => {
      let fault: PollingTimerFault;
      try {
        fault = dependencies.faultFromError?.(error) ?? defaultFault(error);
      } catch {
        fault = defaultFault(error);
      }
      cleanup();
      void releaseSlot?.triggerRelease();
      sendBack({ type: "watchTimer.failed", scopeEpoch: input.scopeEpoch, fault });
    };

    const onTimer = (): void => {
      try {
        dependencies.onTick?.();
      } catch (error: unknown) {
        if (cleaned) return;
        sendFailure(error);
        return;
      }
      if (cleaned) return;
      cleanup();
      void releaseSlot?.triggerRelease();
      sendBack({ type: "watchTimer.elapsed", scopeEpoch: input.scopeEpoch });
    };

    const onAbort = (): void => {
      cleanup();
      void releaseSlot?.triggerRelease();
    };

    if (signal.aborted) {
      cleanup();
      return;
    }

    try {
      releaseSlot = input.resourceRegistry.registerReleaseSlot?.({
        ownerScope: "watch",
        ownerInvokeIdentity: `periodicStatusTimer:${input.scopeEpoch}`,
        resourceOrdinal: 0,
        stableResourceId: `periodicStatusTimer:${input.scopeEpoch}`,
        release: cleanup,
      });
    } catch (error: unknown) {
      sendFailure(error);
      return;
    }

    signal.addEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      timer = clock.setTimeout(onTimer, input.periodicStatusIntervalMs);
    } catch (error: unknown) {
      sendFailure(error);
    }

    return () => {
      controller.abort();
      cleanup();
      void releaseSlot?.triggerRelease();
    };
  });
}

/** Default production logic: directly compatible with periodicStatusTimer invocation. */
export const pollingTimerActorLogic = createPollingTimerActorLogic();

export function createPollingTimerActor(
  input: PollingTimerInput,
  dependencies: PollingTimerDependencies = {},
): ActorRefFromLogic<typeof pollingTimerActorLogic> {
  return createActor(createPollingTimerActorLogic(dependencies), { input });
}
