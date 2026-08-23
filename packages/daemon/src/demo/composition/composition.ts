import { ImapFlow } from "imapflow";
import type { HttpCredentialResolution } from "../../http";
import {
  createCanonicalDaemonRuntime,
  createLoopbackHttpListener,
  type CanonicalRuntimeReadiness,
} from "../../runtime";
import { PORT_ROLES } from "../../../../../ports";
import { platformProcessIdentityAdapter } from "../../../../../port-lease";
import type { ReadOnlyImapSourceAuthority } from "../../../../imap/src/read-only-session";
import { CORPUS_VERSION, buildCorpus } from "../corpus";
import {
  DEMO_IMAP_PASSWORD,
  DEMO_IMAP_USERNAME,
  createDemoImapServer,
  type DemoImapServer,
} from "../imap";
import { createDemoProfile, removeDemoProfile, type DemoProfile } from "../profile";
import type {
  DemoComposition,
  DemoCompositionAdapters,
  DemoCompositionOptions,
  DemoCompositionReady,
} from "./types";

export const DEMO_HTTP_AUTHORIZATION = "Bearer agent-mail-demo" as const;

const HTTP_SCOPES = Object.freeze([
  "mail:read.search",
  "mail:read.message",
  "mail:read.thread",
  "mail:read.raw",
  "mail:read.attachment",
  "sync:read.status",
  "sync:control.start",
  "sync:control.pause",
  "sync:control.resume",
  "sync:control.stop",
]);

const SCENARIO_MIX = Object.freeze({
  ordinary: 1,
  transactional: 1,
  "mailing-list": 1,
  newsletter: 1,
  automated: 1,
  spam: 1,
});

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Demo composition was cancelled", "AbortError");
}

async function cancellableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = (operation: () => void): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      operation();
    };
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const abort = (): void => {
      finish(() => reject(abortReason(signal)));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function createDefaultSource(
  server: DemoImapServer,
  sessionOpened: () => void,
  sessionClosed: () => void,
): ReadOnlyImapSourceAuthority {
  return Object.freeze({
    acquire: async ({ signal }) => {
      if (signal.aborted) throw abortReason(signal);
      const flow = new ImapFlow({
        host: server.host,
        port: server.port,
        secure: false,
        disableAutoIdle: true,
        logger: false,
        auth: { user: DEMO_IMAP_USERNAME, pass: DEMO_IMAP_PASSWORD },
        connectionTimeout: 2_000,
        greetingTimeout: 2_000,
        socketTimeout: 5_000,
      });
      const abort = (): void => flow.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await flow.connect();
        if (signal.aborted) throw abortReason(signal);
      } catch (error: unknown) {
        flow.close();
        signal.removeEventListener("abort", abort);
        throw error;
      }
      sessionOpened();
      let releasePromise: Promise<void> | undefined;
      return Object.freeze({
        client: flow,
        release: () => {
          releasePromise ??= (async () => {
            signal.removeEventListener("abort", abort);
            try {
              if (flow.usable) await flow.logout().catch(() => undefined);
              flow.close();
            } finally {
              sessionClosed();
            }
          })();
          return releasePromise;
        },
      });
    },
  });
}

const defaultAdapters: DemoCompositionAdapters = Object.freeze({
  processIdentity: platformProcessIdentityAdapter,
  buildCorpus: () =>
    buildCorpus({
      scenarioVersion: CORPUS_VERSION,
      seed: "agent-mail-disposable-walkthrough-v1",
      size: 3,
      scenarioMix: SCENARIO_MIX,
    }),
  createImapServer: createDemoImapServer,
  createSource: createDefaultSource,
  createRuntime: createCanonicalDaemonRuntime,
});

function authenticate(token: string): HttpCredentialResolution {
  return token === DEMO_HTTP_AUTHORIZATION.slice("Bearer ".length)
    ? {
        kind: "authenticated",
        principal: { subject: "operator:demo-walkthrough", scopes: HTTP_SCOPES },
      }
    : { kind: "invalid" };
}

function runtimeReadiness(readiness: CanonicalRuntimeReadiness): DemoCompositionReady {
  return Object.freeze({
    baseUrl: readiness.baseUrl,
    authorization: DEMO_HTTP_AUTHORIZATION,
    observedSource: readiness.observedSource,
    completedMessages: readiness.checkpoint.completedMessages,
  });
}

export function createDemoComposition(
  options: DemoCompositionOptions = {},
  adapters: DemoCompositionAdapters = defaultAdapters,
): DemoComposition {
  let profile: DemoProfile | undefined;
  let server: DemoImapServer | undefined;
  let runtime: ReturnType<typeof createCanonicalDaemonRuntime> | undefined;
  let readyPromise: Promise<CanonicalRuntimeReadiness> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let cleanupPending = false;
  let activePhase: Promise<unknown> | undefined;
  let activeSourceSessions = 0;

  const trackPhase = <T>(operation: () => Promise<T>): Promise<T> => {
    const candidate = operation();
    activePhase = candidate;
    const clear = (): void => {
      if (activePhase === candidate) activePhase = undefined;
    };
    void candidate.then(clear, clear);
    return candidate;
  };

  const generate = (signal: AbortSignal): Promise<void> =>
    trackPhase(async () => {
      if (signal.aborted) throw abortReason(signal);
      cleanupPromise = undefined;
      const generated = adapters.buildCorpus();
      if (signal.aborted) throw abortReason(signal);
      profile = await createDemoProfile(options, adapters.processIdentity);
      if (signal.aborted) throw abortReason(signal);
      server = adapters.createImapServer({ corpus: generated, port: PORT_ROLES.mockImap });
    });

  const startImap = (signal: AbortSignal): Promise<void> =>
    trackPhase(async () => {
      if (server === undefined) throw new Error("Demo IMAP composition was not generated.");
      if (signal.aborted) throw abortReason(signal);
      try {
        await server.start();
      } catch (error: unknown) {
        if (!server.snapshot().listening) server = undefined;
        throw error;
      }
      if (signal.aborted) throw abortReason(signal);
    });

  const startDaemon = (signal: AbortSignal): Promise<void> =>
    trackPhase(async () => {
      if (profile === undefined || server === undefined) {
        throw new Error("Demo daemon composition was not generated.");
      }
      const source = adapters.createSource(
        server,
        () => {
          activeSourceSessions += 1;
        },
        () => {
          activeSourceSessions -= 1;
        },
      );
      runtime = adapters.createRuntime({
        configuration: { privateRoot: profile.root, ports: PORT_ROLES },
        accountId: "account:demo-walkthrough",
        source,
        authenticate,
        readinessAuthorization: DEMO_HTTP_AUTHORIZATION,
        listenerFactory: (input) =>
          createLoopbackHttpListener({ ...input, port: PORT_ROLES.demoService }),
      });
      readyPromise = runtime.start();
      void readyPromise.catch(() => undefined);
      while (true) {
        if (signal.aborted) throw abortReason(signal);
        const state = runtime.snapshot().state;
        if (state === "syncing" || state === "ready") return;
        if (state === "failed" || state === "closed") {
          await readyPromise;
          return;
        }
        await cancellableDelay(2, signal);
      }
    });

  const awaitReady = (signal: AbortSignal): Promise<DemoCompositionReady> =>
    trackPhase(async () => {
      if (readyPromise === undefined) throw new Error("Demo daemon was not started.");
      return runtimeReadiness(await awaitWithAbort(readyPromise, signal));
    });

  const cleanup = (): Promise<void> => {
    if (cleanupPromise === undefined) {
      cleanupPending = true;
      const candidate = (async () => {
        try {
          const errors: unknown[] = [];
          const phase = activePhase;
          if (phase !== undefined) await phase.catch(() => undefined);
          if (runtime !== undefined) {
            try {
              await runtime.close();
              runtime = undefined;
              readyPromise = undefined;
            } catch (error: unknown) {
              errors.push(error);
            }
          }
          if (server !== undefined) {
            try {
              await server.close();
              server = undefined;
            } catch (error: unknown) {
              errors.push(error);
            }
          }
          if (activeSourceSessions !== 0) {
            errors.push(new Error("Demo source sessions did not settle."));
          }
          if (
            profile !== undefined &&
            runtime === undefined &&
            server === undefined &&
            activeSourceSessions === 0
          ) {
            try {
              await removeDemoProfile(profile, adapters.processIdentity);
              profile = undefined;
            } catch (error: unknown) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, "Demo composition cleanup failed.");
          }
        } finally {
          cleanupPending = false;
        }
      })();
      cleanupPromise = candidate;
      void candidate.catch(() => {
        if (cleanupPromise === candidate) cleanupPromise = undefined;
      });
    }
    return cleanupPromise;
  };

  return Object.freeze({
    generate,
    startImap,
    startDaemon,
    awaitReady,
    cleanup,
    snapshot: () =>
      Object.freeze({
        profileRoot: profile?.root ?? null,
        profileOwned: profile !== undefined,
        imapListening: server?.snapshot().listening ?? false,
        daemonState: runtime?.snapshot().state ?? "absent",
        activeSourceSessions,
        cleanupPending,
      }),
  });
}

export const demoCompositionDefaultAdapters = defaultAdapters;
