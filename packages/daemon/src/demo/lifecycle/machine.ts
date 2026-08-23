import { assign, fromPromise, setup } from "xstate";
import type { DemoComposition, DemoCompositionReady } from "../composition";
import type { DemoLifecycleDiagnostic } from "./types";

export type DemoLifecycleContext = Readonly<{
  readonly ready: DemoCompositionReady | null;
  readonly failure: DemoLifecycleDiagnostic | null;
  readonly terminal: "absent" | "failed";
}>;

export type DemoLifecycleEvent =
  | Readonly<{ readonly type: "demo.start" }>
  | Readonly<{ readonly type: "demo.stop" }>
  | Readonly<{ readonly type: "demo.reset" }>
  | Readonly<{ readonly type: "demo.remove" }>;

function diagnostic(
  code: DemoLifecycleDiagnostic["code"],
  message: string,
): DemoLifecycleDiagnostic {
  return Object.freeze({ code, message });
}

export function createDemoLifecycleMachine(composition: DemoComposition) {
  const machineSetup = setup({
    types: {
      context: {} as DemoLifecycleContext,
      events: {} as DemoLifecycleEvent,
    },
    actors: {
      generate: fromPromise<void>(async ({ signal }) => composition.generate(signal)),
      startImap: fromPromise<void>(async ({ signal }) => composition.startImap(signal)),
      startDaemon: fromPromise<void>(async ({ signal }) => composition.startDaemon(signal)),
      awaitReady: fromPromise<DemoCompositionReady>(async ({ signal }) =>
        composition.awaitReady(signal),
      ),
      cleanup: fromPromise<void>(async () => composition.cleanup()),
    },
    guards: {
      failedTerminal: ({ context }) => context.terminal === "failed",
    },
    actions: {
      clearRun: assign({
        ready: () => null,
        failure: () => null,
        terminal: () => "absent" as const,
      }),
      recordGenerateFailure: assign({
        failure: () => diagnostic("demo.generate", "Disposable demo generation failed."),
        terminal: () => "failed" as const,
      }),
      recordImapFailure: assign({
        failure: () => diagnostic("demo.imap", "Disposable demo IMAP startup failed."),
        terminal: () => "failed" as const,
      }),
      recordDaemonFailure: assign({
        failure: () => diagnostic("demo.daemon", "Disposable demo daemon startup failed."),
        terminal: () => "failed" as const,
      }),
      recordSyncFailure: assign({
        failure: () => diagnostic("demo.sync", "Disposable demo initial sync failed."),
        terminal: () => "failed" as const,
      }),
      recordCleanupFailure: assign({
        ready: () => null,
        failure: ({ context }) =>
          context.failure ?? diagnostic("demo.cleanup", "Disposable demo cleanup failed."),
        terminal: () => "failed" as const,
      }),
      clearReady: assign({ ready: () => null }),
      requestStop: assign({ terminal: () => "absent" as const }),
      requestFailedCleanup: assign({ terminal: () => "failed" as const }),
    },
  });

  const stopTransition = {
    target: "stopping",
    actions: ["clearReady", "requestStop"],
  } as const;
  const resetTransition = {
    target: "resetting",
    actions: ["clearReady", "requestStop"],
  } as const;
  return machineSetup.createMachine({
    id: "agent-mail-disposable-demo",
    initial: "absent",
    context: {
      ready: null,
      failure: null,
      terminal: "absent",
    },
    states: {
      absent: {
        on: {
          "demo.start": { target: "generating", actions: "clearRun" },
          "demo.reset": resetTransition,
          "demo.remove": resetTransition,
        },
      },
      generating: {
        invoke: {
          src: "generate",
          onDone: { target: "startingImap" },
          onError: {
            target: "stopping",
            actions: ["recordGenerateFailure", "requestFailedCleanup"],
          },
        },
        on: {
          "demo.stop": stopTransition,
          "demo.reset": resetTransition,
          "demo.remove": resetTransition,
        },
      },
      startingImap: {
        invoke: {
          src: "startImap",
          onDone: { target: "startingDaemon" },
          onError: {
            target: "stopping",
            actions: ["recordImapFailure", "requestFailedCleanup"],
          },
        },
        on: {
          "demo.stop": stopTransition,
          "demo.reset": resetTransition,
          "demo.remove": resetTransition,
        },
      },
      startingDaemon: {
        invoke: {
          src: "startDaemon",
          onDone: { target: "syncing" },
          onError: {
            target: "stopping",
            actions: ["recordDaemonFailure", "requestFailedCleanup"],
          },
        },
        on: {
          "demo.stop": stopTransition,
          "demo.reset": resetTransition,
          "demo.remove": resetTransition,
        },
      },
      syncing: {
        invoke: {
          src: "awaitReady",
          onDone: {
            target: "ready",
            actions: assign({
              ready: ({ event }) => event.output,
              failure: () => null,
              terminal: () => "absent" as const,
            }),
          },
          onError: {
            target: "stopping",
            actions: ["recordSyncFailure", "requestFailedCleanup"],
          },
        },
        on: {
          "demo.stop": stopTransition,
          "demo.reset": resetTransition,
          "demo.remove": resetTransition,
        },
      },
      ready: {
        on: {
          "demo.stop": stopTransition,
          "demo.reset": resetTransition,
          "demo.remove": resetTransition,
        },
      },
      stopping: {
        invoke: {
          src: "cleanup",
          onDone: [
            { guard: "failedTerminal", target: "failed" },
            { target: "absent", actions: "clearRun" },
          ],
          onError: { target: "failed", actions: "recordCleanupFailure" },
        },
      },
      resetting: {
        invoke: {
          src: "cleanup",
          onDone: { target: "absent", actions: "clearRun" },
          onError: { target: "failed", actions: "recordCleanupFailure" },
        },
      },
      failed: {
        on: {
          "demo.stop": {
            target: "stopping",
            actions: ["clearReady", "requestFailedCleanup"],
          },
          "demo.reset": resetTransition,
          "demo.remove": resetTransition,
        },
      },
    },
  });
}
