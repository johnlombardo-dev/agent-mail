import { fromCallback } from "xstate";
import type { ImapFlow } from "imapflow";
import { classifyImapAuthenticationFailure } from "./auth-failure-classifier";

/**
 * The resource returned by one IDLE invocation. `close` is a barrier: it does
 * not resolve until the IDLE command, its listeners, and the owned socket are
 * closed. A parent may therefore publish the actor outcome after this promise
 * settles without racing a provider callback.
 */
export interface IdleSessionResource {
  readonly close: () => Promise<void>;
}

interface IdleReleaseSlotHandle {
  readonly triggerRelease: () => Promise<unknown>;
}

interface IdleReleaseRegistry {
  readonly registerReleaseSlot: (request: {
    readonly ownerScope: "watch";
    readonly ownerInvokeIdentity: string;
    readonly resourceOrdinal: number;
    readonly stableResourceId: string;
    readonly release: () => void | Promise<void>;
  }) => IdleReleaseSlotHandle;
}

export interface IdleSessionHandlers {
  readonly ready: () => void;
  readonly mailboxChanged: () => void;
  readonly completed: () => void;
  readonly error: (error: unknown) => void;
}

/** The intentionally narrow, production-shaped seam for one IDLE session. */
export interface IdleSessionAdapter {
  readonly start: (handlers: IdleSessionHandlers) => Promise<IdleSessionResource>;
}

export type IdleSessionOutcome =
  | { readonly kind: "normal-completion" }
  | { readonly kind: "mailbox-change" }
  | { readonly kind: "adapter-error"; readonly error: unknown }
  | { readonly kind: "cancellation" };

export type IdleSessionEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "terminal"; readonly outcome: IdleSessionOutcome };

export type RunIdleSessionInput = Readonly<{
  readonly adapter: unknown;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: IdleSessionEvent) => void;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isResource(value: unknown): value is IdleSessionResource {
  return isRecord(value) && typeof value.close === "function";
}

function isAdapter(value: unknown): value is IdleSessionAdapter {
  return isRecord(value) && typeof value.start === "function";
}

function isReleaseSlotHandle(value: unknown): value is IdleReleaseSlotHandle {
  return isRecord(value) && typeof value.triggerRelease === "function";
}

function notify(
  listener: ((event: IdleSessionEvent) => void) | undefined,
  event: IdleSessionEvent,
): void {
  if (listener === undefined) return;
  try {
    listener(event);
  } catch {
    // Observers cannot change the adapter lifecycle or its terminal outcome.
  }
}

/**
 * Run exactly one IDLE session. Every terminal request first crosses the
 * resource close barrier; only then is the terminal event observed and the
 * promise resolved. This also handles cancellation arriving before `start`
 * has finished acquiring its resource.
 */
export function runIdleSession(input: RunIdleSessionInput): Promise<IdleSessionOutcome> {
  const adapter = input.adapter;
  if (!isAdapter(adapter)) {
    const outcome: IdleSessionOutcome = {
      kind: "adapter-error",
      error: new TypeError("invalid IDLE adapter"),
    };
    notify(input.onEvent, { kind: "terminal", outcome });
    return Promise.resolve(outcome);
  }

  const observer = input.onEvent;
  const resolver: { resolve?: (outcome: IdleSessionOutcome) => void } = {};
  const result = new Promise<IdleSessionOutcome>((resolve) => {
    resolver.resolve = resolve;
  });

  let resource: IdleSessionResource | undefined;
  let closePromise: Promise<void> | undefined;
  let requested: IdleSessionOutcome | undefined;
  let finishing = false;
  let finished = false;
  let acquisitionSettled = false;

  const resolveTerminal = (outcome: IdleSessionOutcome): void => {
    if (finished) return;
    finished = true;
    notify(observer, { kind: "terminal", outcome });
    resolver.resolve?.(outcome);
    if (input.signal !== undefined) input.signal.removeEventListener("abort", cancel);
  };

  const closeResource = async (): Promise<void> => {
    if (resource === undefined) return;
    closePromise ??= resource.close();
    await closePromise;
  };

  const finishRequested = async (): Promise<void> => {
    if (finishing || requested === undefined) return;
    if (resource === undefined) {
      if (!acquisitionSettled) return;
      resolveTerminal(requested);
      return;
    }
    finishing = true;
    const outcome = requested;
    try {
      await closeResource();
      resolveTerminal(outcome);
    } catch (error: unknown) {
      resolveTerminal({ kind: "adapter-error", error });
    }
  };

  const request = (outcome: IdleSessionOutcome): void => {
    if (requested !== undefined || finished) return;
    requested = outcome;
    void finishRequested();
  };

  function cancel(): void {
    request({ kind: "cancellation" });
  }

  const failAcquisition = (error: unknown): void => {
    if (finished) return;
    acquisitionSettled = true;
    requested = { kind: "adapter-error", error };
    void finishRequested();
  };

  const handlers: IdleSessionHandlers = {
    ready: () => {
      if (requested === undefined && !finished) notify(observer, { kind: "ready" });
    },
    mailboxChanged: () => request({ kind: "mailbox-change" }),
    completed: () => request({ kind: "normal-completion" }),
    error: (error) => request({ kind: "adapter-error", error }),
  };

  if (input.signal !== undefined) {
    input.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal.aborted) cancel();
  }

  void Promise.resolve()
    .then(() => adapter.start(handlers))
    .then(
      (candidate: IdleSessionResource) => {
        if (!isResource(candidate)) {
          failAcquisition(new TypeError("invalid IDLE resource"));
          return;
        }
        acquisitionSettled = true;
        resource = candidate;
        void finishRequested();
      },
      (error: unknown) => failAcquisition(error),
    );

  return result;
}

/** Internal event shape used by the signed sync lifecycle chart. */
export type IdleSessionActorEvent =
  | { readonly type: "idle.ready"; readonly scopeEpoch: number }
  | { readonly type: "idle.mailboxChanged"; readonly scopeEpoch: number }
  | { readonly type: "idle.completed"; readonly scopeEpoch: number }
  | {
      readonly type: "idle.failed";
      readonly scopeEpoch: number;
      readonly fault: IdleSessionWorkflowFault;
    };

export type IdleSessionActorInput = Readonly<{
  /** The signed sync actor input fields consumed by this actor. */
  readonly scopeEpoch: number;
  readonly credentialRevision: number | null;
  readonly validatedIdleAdapter: unknown;
  /** The actor-incarnation registry is required before the adapter can start. */
  readonly resourceRegistry: IdleReleaseRegistry;
}>;

export type IdleSessionWorkflowFault = Readonly<{
  readonly category: "authentication" | "transient";
  readonly code: string;
  readonly safeMessage: string;
  readonly authReason?: "provider-rejected";
  readonly attemptedCredentialRevision?: number;
}>;

const IDLE_ADAPTER_FAILURE: Omit<IdleSessionWorkflowFault, "attemptedCredentialRevision"> = {
  category: "transient",
  code: "sync.idle-adapter-failure",
  safeMessage: "IMAP IDLE adapter failed.",
};

const IDLE_AUTH_FAILURE: Omit<IdleSessionWorkflowFault, "attemptedCredentialRevision"> = {
  category: "authentication",
  code: "auth_required",
  safeMessage: "Credentials were rejected.",
  authReason: "provider-rejected",
};

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * XState callback actor for the signed `idleSession` slot. Its disposer only
 * requests cancellation; the callback's terminal event is emitted by
 * `runIdleSession` after the adapter's close barrier has settled.
 */
export const idleSessionActor = fromCallback<IdleSessionActorEvent, IdleSessionActorInput>(
  ({ input, sendBack }) => {
    const scopeEpoch = safeNonNegativeInteger(input.scopeEpoch);
    const credentialRevision = safeNonNegativeInteger(input.credentialRevision);
    if (scopeEpoch === null) return () => undefined;

    const controller = new AbortController();
    let sessionPromise: Promise<IdleSessionOutcome> | undefined;
    const runtimeRegistry: unknown = input.resourceRegistry;
    if (!isRecord(runtimeRegistry) || typeof runtimeRegistry.registerReleaseSlot !== "function") {
      sendBack({
        type: "idle.failed",
        scopeEpoch,
        fault: { ...IDLE_ADAPTER_FAILURE },
      });
      return () => undefined;
    }

    let slot: IdleReleaseSlotHandle;
    try {
      const candidateSlot = input.resourceRegistry.registerReleaseSlot({
        ownerScope: "watch",
        ownerInvokeIdentity: `idleSession:${scopeEpoch}`,
        resourceOrdinal: 0,
        stableResourceId: `idleSession:${scopeEpoch}`,
        release: () => {
          controller.abort();
          return sessionPromise?.then(() => undefined);
        },
      });
      if (!isReleaseSlotHandle(candidateSlot)) throw new TypeError("invalid IDLE release slot");
      slot = candidateSlot;
    } catch {
      sendBack({
        type: "idle.failed",
        scopeEpoch,
        fault: { ...IDLE_ADAPTER_FAILURE },
      });
      return () => undefined;
    }
    sessionPromise = runIdleSession({
      adapter: input.validatedIdleAdapter,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === "ready") {
          sendBack({ type: "idle.ready", scopeEpoch });
          return;
        }
        void slot.triggerRelease();
        switch (event.outcome.kind) {
          case "normal-completion":
            sendBack({ type: "idle.completed", scopeEpoch });
            return;
          case "mailbox-change":
            sendBack({ type: "idle.mailboxChanged", scopeEpoch });
            return;
          case "adapter-error": {
            const authenticationFault = classifyImapAuthenticationFailure(event.outcome.error);
            const baseFault =
              authenticationFault === null ? IDLE_ADAPTER_FAILURE : IDLE_AUTH_FAILURE;
            sendBack({
              type: "idle.failed",
              scopeEpoch,
              fault:
                credentialRevision === null
                  ? baseFault
                  : { ...baseFault, attemptedCredentialRevision: credentialRevision },
            });
            return;
          }
          case "cancellation":
            return;
          default: {
            const exhaustive: never = event.outcome;
            return exhaustive;
          }
        }
      },
    });

    return () => {
      controller.abort();
      void slot.triggerRelease();
    };
  },
);

/**
 * Adapt the installed ImapFlow 1.7.1 IDLE semantics. The adapter owns this
 * connection for the session: cancellation sends NOOP to leave IDLE, waits
 * for `idle()` to settle, removes exactly its listeners, and closes the TCP
 * connection before `close()` resolves.
 */
export function createImapFlowIdleAdapter(flow: ImapFlow): IdleSessionAdapter {
  return {
    start: (handlers) => {
      let closePromise: Promise<void> | undefined;
      let idlePromise: Promise<unknown> | undefined;
      const onMailboxChanged = (): void => handlers.mailboxChanged();
      const onError = (error: Error): void => handlers.error(error);
      const onClose = (): void => handlers.error(new Error("IMAP connection closed during IDLE"));

      // Install every listener before issuing IDLE. A server can deliver an
      // unsolicited mailbox update in the same turn as command admission.
      flow.on("exists", onMailboxChanged);
      flow.on("expunge", onMailboxChanged);
      flow.on("flags", onMailboxChanged);
      flow.on("error", onError);
      flow.on("close", onClose);
      try {
        // ImapFlow documents a no-op `undefined` result when already idling;
        // Promise.resolve preserves that installed-runtime behavior.
        idlePromise = Promise.resolve(flow.idle());
      } catch (error: unknown) {
        handlers.error(error);
        idlePromise = Promise.reject(error);
      }
      handlers.ready();

      void idlePromise.then(
        () => handlers.completed(),
        (error: unknown) => handlers.error(error),
      );

      const close = async (): Promise<void> => {
        closePromise ??= (async () => {
          let firstError: unknown;
          try {
            if (flow.idling) await flow.noop();
          } catch (error: unknown) {
            firstError = error;
          }
          try {
            await (idlePromise ?? Promise.resolve(false));
          } catch (error: unknown) {
            firstError ??= error;
          }
          flow.off("exists", onMailboxChanged);
          flow.off("expunge", onMailboxChanged);
          flow.off("flags", onMailboxChanged);
          flow.off("error", onError);
          flow.off("close", onClose);
          flow.close();
          if (firstError !== undefined) throw firstError;
        })();
        await closePromise;
      };

      return Promise.resolve({ close });
    },
  };
}
