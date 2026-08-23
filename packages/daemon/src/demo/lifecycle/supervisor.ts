import { createActor } from "xstate";
import { createDemoComposition, type DemoCompositionAdapters } from "../composition";
import { createDemoLifecycleMachine } from "./machine";
import {
  DemoLifecycleError,
  demoLifecycleStateSchema,
  type DemoLifecycleDiagnostic,
  type DemoLifecycleOptions,
  type DemoLifecycleState,
  type DemoLifecycleStatus,
  type DemoLifecycleSupervisor,
} from "./types";

const COMMAND_DEADLINE_MS = 15_000;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function safeSignal(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 80 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new TypeError("Demo shutdown signal is invalid.");
  }
  return value;
}

function deadlineDiagnostic(): DemoLifecycleDiagnostic {
  return Object.freeze({
    code: "demo.deadline",
    message: "Disposable demo operation exceeded its deadline.",
  });
}

export function createDemoLifecycleSupervisor(
  options: DemoLifecycleOptions = {},
  adapters?: DemoCompositionAdapters,
): DemoLifecycleSupervisor {
  const composition = createDemoComposition(options, adapters);
  const actor = createActor(createDemoLifecycleMachine(composition));
  actor.start();
  let startPromise: ReturnType<DemoLifecycleSupervisor["start"]> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const state = (): DemoLifecycleState => demoLifecycleStateSchema.parse(actor.getSnapshot().value);

  const waitFor = <T>(
    project: () => Readonly<{ readonly done: false }> | Readonly<{ readonly done: true; value: T }>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      let subscription: Readonly<{ unsubscribe: () => void }> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        subscription?.unsubscribe();
        operation();
      };
      const inspect = (): void => {
        try {
          const result = project();
          if (result.done) settle(() => resolve(result.value));
        } catch (error: unknown) {
          settle(() => reject(error));
        }
      };
      timer = setTimeout(
        () => settle(() => reject(new DemoLifecycleError(deadlineDiagnostic()))),
        COMMAND_DEADLINE_MS,
      );
      subscription = actor.subscribe(inspect);
      inspect();
    });

  const waitForReady = (): ReturnType<DemoLifecycleSupervisor["start"]> =>
    waitFor<Awaited<ReturnType<DemoLifecycleSupervisor["start"]>>>(() => {
      const snapshot = actor.getSnapshot();
      const current = demoLifecycleStateSchema.parse(snapshot.value);
      if (current === "ready" && snapshot.context.ready !== null) {
        return { done: true, value: snapshot.context.ready };
      }
      if (current === "failed") {
        throw new DemoLifecycleError(
          snapshot.context.failure ?? {
            code: "demo.sync",
            message: "Disposable demo failed without a diagnostic.",
          },
        );
      }
      if (current === "absent") {
        throw new DemoLifecycleError({
          code: "demo.cleanup",
          message: "Disposable demo stopped before readiness.",
        });
      }
      return { done: false };
    });

  const start = (): ReturnType<DemoLifecycleSupervisor["start"]> => {
    if (startPromise !== undefined) return startPromise;
    if (state() !== "absent") {
      return Promise.reject(
        new DemoLifecycleError({
          code: "demo.generate",
          message: "Disposable demo is not available to start.",
        }),
      );
    }
    startPromise = (async () => {
      cleanupPromise = undefined;
      actor.send({ type: "demo.start" });
      const terminal = waitForReady();
      try {
        return await terminal;
      } catch (error: unknown) {
        if (error instanceof DemoLifecycleError && error.diagnostic.code === "demo.deadline") {
          await stop().catch(() => undefined);
        }
        throw error;
      }
    })();
    return startPromise;
  };

  const runCleanup = (event: "demo.stop" | "demo.reset" | "demo.remove"): Promise<void> => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = (async () => {
      if (state() === "absent") {
        startPromise = undefined;
        cleanupPromise = undefined;
        return;
      }
      actor.send({ type: event });
      const terminal = waitFor(() => {
        const snapshot = actor.getSnapshot();
        const current = demoLifecycleStateSchema.parse(snapshot.value);
        if (current === "absent") return { done: true, value: undefined };
        if (current === "failed") {
          throw new DemoLifecycleError(
            snapshot.context.failure ?? {
              code: "demo.cleanup",
              message: "Disposable demo cleanup failed.",
            },
          );
        }
        return { done: false };
      });
      await terminal;
      startPromise = undefined;
      cleanupPromise = undefined;
    })();
    void cleanupPromise.catch(() => {
      cleanupPromise = undefined;
    });
    return cleanupPromise;
  };

  const stop = (): Promise<void> => runCleanup("demo.stop");

  return Object.freeze({
    start,
    status: (): DemoLifecycleStatus => {
      const snapshot = actor.getSnapshot();
      const current = demoLifecycleStateSchema.parse(snapshot.value);
      const resources = composition.snapshot();
      return Object.freeze({
        state: current,
        ready: current === "ready",
        root: resources.profileRoot,
        baseUrl: snapshot.context.ready?.baseUrl ?? null,
        diagnostic: snapshot.context.failure,
        resources,
      });
    },
    stop,
    reset: () => runCleanup("demo.reset"),
    remove: () => runCleanup("demo.remove"),
    shutdown: (signal) => {
      safeSignal(signal);
      return stop();
    },
  });
}
