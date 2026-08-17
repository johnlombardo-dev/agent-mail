import { createActor, fromPromise, setup, type ActorRefFrom, type SnapshotFrom } from "xstate";
import type {
  RawMessageDownloadAdapter,
  RawMessageDownloadRequest,
  RawMessageDownloadResult,
} from "./raw-download";

export type RawDownloadQueueErrorCode =
  | "raw-download-queue-capacity-exceeded"
  | "raw-download-queue-cancelled"
  | "raw-download-queue-stopped";

export class RawDownloadQueueError extends Error {
  readonly code: RawDownloadQueueErrorCode;
  constructor(code: RawDownloadQueueErrorCode, message: string) {
    super(message);
    this.name = "RawDownloadQueueError";
    this.code = code;
  }
}

export class RawDownloadQueueBackpressureError extends RawDownloadQueueError {
  readonly capacity: number;
  constructor(capacity: number) {
    super(
      "raw-download-queue-capacity-exceeded",
      `raw download queue capacity ${capacity} has been reached`,
    );
    this.name = "RawDownloadQueueBackpressureError";
    this.capacity = capacity;
  }
}

export class RawDownloadQueueCancelledError extends RawDownloadQueueError {
  readonly jobId: RawDownloadJobId;
  constructor(jobId: RawDownloadJobId) {
    super("raw-download-queue-cancelled", `raw download job ${jobId} was cancelled`);
    this.name = "RawDownloadQueueCancelledError";
    this.jobId = jobId;
  }
}

export class RawDownloadQueueStoppedError extends RawDownloadQueueError {
  constructor() {
    super("raw-download-queue-stopped", "raw download queue is stopped");
    this.name = "RawDownloadQueueStoppedError";
  }
}

export type RawDownloadJobId = number;
export type RawDownloadJobHandle = Readonly<{
  readonly id: RawDownloadJobId;
  readonly result: Promise<RawMessageDownloadResult>;
}>;
export type RawMessageDownloadQueueOptions = Readonly<{
  /** Maximum number of active plus queued jobs. */
  readonly capacity: number;
}>;

type Deferred<T> = Readonly<{
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}>;
type QueueJob = {
  readonly id: RawDownloadJobId;
  readonly request: RawMessageDownloadRequest;
  readonly result: Deferred<RawMessageDownloadResult>;
  cancelRequested: boolean;
  controller: AbortController | undefined;
};
type QueueContext = {
  readonly adapter: RawMessageDownloadAdapter;
  readonly capacity: number;
  readonly queue: QueueJob[];
  active: QueueJob | undefined;
  shutdownRequested: boolean;
  readonly stopWaiters: Deferred<void>[];
};
type QueueEvents =
  | { readonly type: "job.enqueue"; readonly job: QueueJob }
  | { readonly type: "job.cancel"; readonly id: RawDownloadJobId }
  | { readonly type: "queue.stop"; readonly waiter: Deferred<void> };
type DownloadInput = Readonly<{
  readonly job: QueueJob;
  readonly adapter: RawMessageDownloadAdapter;
}>;

function validateCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("raw download queue capacity must be a positive safe integer");
  }
  return value;
}
function cancellationReason(job: QueueJob): RawDownloadQueueCancelledError {
  return new RawDownloadQueueCancelledError(job.id);
}
function withActorAbort(job: QueueJob): {
  readonly request: RawMessageDownloadRequest;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  job.controller = controller;
  const callerSignal = job.request.signal;
  const forwardCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (job.cancelRequested) controller.abort(cancellationReason(job));
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) forwardCallerAbort();
    else callerSignal.addEventListener("abort", forwardCallerAbort, { once: true });
  }
  return {
    request: { ...job.request, signal: controller.signal },
    dispose: () => {
      if (callerSignal !== undefined) callerSignal.removeEventListener("abort", forwardCallerAbort);
      job.controller = undefined;
    },
  };
}

const rawDownloadQueueMachine = setup({
  types: {
    context: {} as QueueContext,
    events: {} as QueueEvents,
    input: {} as Readonly<{
      readonly adapter: RawMessageDownloadAdapter;
      readonly capacity: number;
    }>,
  },
  actors: {
    download: fromPromise<RawMessageDownloadResult, DownloadInput>(async ({ input }) => {
      const { request, dispose } = withActorAbort(input.job);
      try {
        return await input.adapter.download(request);
      } finally {
        dispose();
      }
    }),
  },
  guards: {
    hasCapacity: ({ context }) =>
      context.queue.length + (context.active === undefined ? 0 : 1) < context.capacity,
    isActiveJob: ({ context, event }) =>
      event.type === "job.cancel" && context.active?.id === event.id,
    isQueuedJob: ({ context, event }) =>
      event.type === "job.cancel" && context.queue.some((job) => job.id === event.id),
    isCancelling: ({ context }) => context.active?.cancelRequested === true,
    isShuttingDown: ({ context }) => context.shutdownRequested,
    hasQueuedJobs: ({ context }) => context.queue.length > 0,
  },
  actions: {
    activate: ({ context, event }) => {
      if (event.type === "job.enqueue") context.active = event.job;
    },
    enqueue: ({ context, event }) => {
      if (event.type === "job.enqueue") context.queue.push(event.job);
    },
    rejectOverflow: ({ context, event }) => {
      if (event.type === "job.enqueue") {
        event.job.result.reject(new RawDownloadQueueBackpressureError(context.capacity));
      }
    },
    cancelActive: ({ context }) => {
      const job = context.active;
      if (job === undefined || job.cancelRequested) return;
      job.cancelRequested = true;
      job.controller?.abort(cancellationReason(job));
    },
    cancelQueued: ({ context, event }) => {
      if (event.type !== "job.cancel") return;
      const index = context.queue.findIndex((job) => job.id === event.id);
      if (index < 0) return;
      const [job] = context.queue.splice(index, 1);
      job?.result.reject(cancellationReason(job));
    },
    requestShutdown: ({ context, event }) => {
      if (event.type !== "queue.stop") return;
      context.shutdownRequested = true;
      context.stopWaiters.push(event.waiter);
      const job = context.active;
      if (job !== undefined && !job.cancelRequested) {
        job.cancelRequested = true;
        job.controller?.abort(cancellationReason(job));
      }
    },
    registerStopWaiter: ({ context, event }) => {
      if (event.type === "queue.stop") context.stopWaiters.push(event.waiter);
    },
    rejectQueued: ({ context }) => {
      for (const job of context.queue.splice(0)) job.result.reject(cancellationReason(job));
    },
    resolveStop: ({ event }) => {
      if (event.type === "queue.stop") event.waiter.resolve(undefined);
    },
    resolveStopWaiters: ({ context }) => {
      for (const waiter of context.stopWaiters.splice(0)) waiter.resolve(undefined);
    },
    rejectStopped: ({ event }) => {
      if (event.type === "job.enqueue") event.job.result.reject(new RawDownloadQueueStoppedError());
    },
    finishSuccess: ({ context }, params: { readonly result: RawMessageDownloadResult }) => {
      const job = context.active;
      context.active = undefined;
      job?.result.resolve(params.result);
    },
    finishSuccessAndPromote: (
      { context },
      params: { readonly result: RawMessageDownloadResult },
    ) => {
      const job = context.active;
      if (job === undefined) return;
      job.result.resolve(params.result);
      context.active = context.queue.shift();
    },
    finishCancelled: ({ context }) => {
      const job = context.active;
      context.active = undefined;
      if (job !== undefined) job.result.reject(cancellationReason(job));
    },
    finishCancelledAndPromote: ({ context }) => {
      const job = context.active;
      if (job === undefined) return;
      job.result.reject(cancellationReason(job));
      context.active = context.queue.shift();
    },
    finishStopped: ({ context }) => {
      const job = context.active;
      context.active = undefined;
      if (job !== undefined) job.result.reject(cancellationReason(job));
    },
    finishError: ({ context }, params: { readonly error: unknown }) => {
      const job = context.active;
      context.active = undefined;
      job?.result.reject(params.error);
    },
    finishErrorAndPromote: ({ context }, params: { readonly error: unknown }) => {
      const job = context.active;
      if (job === undefined) return;
      job.result.reject(params.error);
      context.active = context.queue.shift();
    },
  },
}).createMachine({
  id: "rawDownloadQueue",
  initial: "idle",
  context: ({ input }) => ({
    adapter: input.adapter,
    capacity: validateCapacity(input.capacity),
    queue: [],
    active: undefined,
    shutdownRequested: false,
    stopWaiters: [],
  }),
  states: {
    idle: {
      on: {
        "job.enqueue": { target: "active", actions: "activate" },
        "queue.stop": { target: "stopped", actions: "resolveStop" },
      },
    },
    active: {
      initial: "working",
      invoke: {
        src: "download",
        input: ({ context }) => {
          if (context.active === undefined) throw new Error("raw download queue has no active job");
          return { adapter: context.adapter, job: context.active };
        },
        onDone: [
          {
            guard: "isShuttingDown",
            target: "#rawDownloadQueue.stopped",
            actions: "finishStopped",
          },
          {
            guard: ({ context }) =>
              context.active?.cancelRequested === true && context.queue.length > 0,
            target: "#rawDownloadQueue.active",
            reenter: true,
            actions: "finishCancelledAndPromote",
          },
          { guard: "isCancelling", target: "#rawDownloadQueue.idle", actions: "finishCancelled" },
          {
            guard: "hasQueuedJobs",
            target: "#rawDownloadQueue.active",
            reenter: true,
            actions: {
              type: "finishSuccessAndPromote",
              params: ({ event }) => ({ result: event.output }),
            },
          },
          {
            target: "#rawDownloadQueue.idle",
            actions: { type: "finishSuccess", params: ({ event }) => ({ result: event.output }) },
          },
        ],
        onError: [
          {
            guard: "isShuttingDown",
            target: "#rawDownloadQueue.stopped",
            actions: "finishStopped",
          },
          {
            guard: ({ context }) =>
              context.active?.cancelRequested === true && context.queue.length > 0,
            target: "#rawDownloadQueue.active",
            reenter: true,
            actions: "finishCancelledAndPromote",
          },
          { guard: "isCancelling", target: "#rawDownloadQueue.idle", actions: "finishCancelled" },
          {
            guard: "hasQueuedJobs",
            target: "#rawDownloadQueue.active",
            reenter: true,
            actions: {
              type: "finishErrorAndPromote",
              params: ({ event }) => ({ error: event.error }),
            },
          },
          {
            target: "#rawDownloadQueue.idle",
            actions: { type: "finishError", params: ({ event }) => ({ error: event.error }) },
          },
        ],
      },
      on: {
        "job.enqueue": [
          { guard: "hasCapacity", actions: "enqueue" },
          { actions: "rejectOverflow" },
        ],
        "job.cancel": [
          { guard: "isActiveJob", target: ".cancelling", actions: "cancelActive" },
          { guard: "isQueuedJob", actions: "cancelQueued" },
        ],
      },
      states: {
        working: {
          on: {
            "queue.stop": { target: "stopping", actions: ["requestShutdown", "rejectQueued"] },
          },
        },
        cancelling: {
          on: {
            "queue.stop": { target: "stopping", actions: ["requestShutdown", "rejectQueued"] },
          },
        },
        stopping: {
          on: {
            "job.enqueue": { actions: "rejectStopped" },
            "queue.stop": { actions: "registerStopWaiter" },
          },
        },
      },
    },
    stopped: {
      entry: "resolveStopWaiters",
      on: {
        "job.enqueue": { actions: "rejectStopped" },
        "queue.stop": { actions: "resolveStop" },
      },
    },
  },
});

export type RawMessageDownloadQueueSnapshot = SnapshotFrom<typeof rawDownloadQueueMachine>;

export class RawMessageDownloadQueueActor {
  private readonly actor: ActorRefFrom<typeof rawDownloadQueueMachine>;
  private nextJobId = 1;

  constructor(adapter: RawMessageDownloadAdapter, options: RawMessageDownloadQueueOptions) {
    this.actor = createActor(rawDownloadQueueMachine, {
      input: { adapter, capacity: options.capacity },
    }).start();
  }

  enqueue(request: RawMessageDownloadRequest): RawDownloadJobHandle {
    let resolve!: (value: RawMessageDownloadResult | PromiseLike<RawMessageDownloadResult>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<RawMessageDownloadResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const job: QueueJob = {
      id: this.nextJobId,
      request,
      result: { resolve, reject },
      cancelRequested: false,
      controller: undefined,
    };
    this.nextJobId += 1;
    this.actor.send({ type: "job.enqueue", job });
    return Object.freeze({ id: job.id, result });
  }

  download(request: RawMessageDownloadRequest): Promise<RawMessageDownloadResult> {
    return this.enqueue(request).result;
  }

  cancel(id: RawDownloadJobId): void {
    this.actor.send({ type: "job.cancel", id });
  }

  stop(): Promise<void> {
    if (this.actor.getSnapshot().matches("stopped")) return Promise.resolve();
    let resolve!: (value: void | PromiseLike<void>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.actor.send({ type: "queue.stop", waiter: { resolve, reject } });
    return result;
  }

  getSnapshot(): RawMessageDownloadQueueSnapshot {
    return this.actor.getSnapshot();
  }
}

export function createRawMessageDownloadQueueActor(
  adapter: RawMessageDownloadAdapter,
  options: RawMessageDownloadQueueOptions,
): RawMessageDownloadQueueActor {
  return new RawMessageDownloadQueueActor(adapter, options);
}
