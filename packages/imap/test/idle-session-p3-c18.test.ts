import { afterEach, describe, expect, test } from "bun:test";
import { createActor, setup } from "xstate";
import {
  createImapFlowIdleAdapter,
  idleSessionActor,
  runIdleSession,
  type IdleSessionAdapter,
  type IdleSessionActorEvent,
  type IdleSessionActorInput,
  type IdleSessionEvent,
  type IdleSessionOutcome,
} from "../src/idle-session";
import {
  runAdapterContractParity,
  type AdapterContractSuite,
  type AdapterFactoryInput,
} from "../../../tests/adapter-contracts/harness";
import { ImapFlow } from "imapflow";

type ResourceCounts = {
  listeners: number;
  sockets: number;
  closeCalls: number;
};

type Fixture = {
  readonly adapter: IdleSessionAdapter;
  readonly complete: () => void;
  readonly mailboxChanged: () => void;
  readonly fail: (error: unknown) => void;
  readonly counts: ResourceCounts;
};

function fixture(): Fixture {
  const counts: ResourceCounts = { listeners: 0, sockets: 0, closeCalls: 0 };
  let handlers: {
    ready: () => void;
    mailboxChanged: () => void;
    completed: () => void;
    error: (error: unknown) => void;
  } | undefined;
  const adapter: IdleSessionAdapter = {
    start: async (nextHandlers) => {
      handlers = nextHandlers;
      counts.listeners = 3;
      counts.sockets = 1;
      nextHandlers.ready();
      return {
        close: async () => {
          counts.closeCalls += 1;
          counts.listeners = 0;
          counts.sockets = 0;
        },
      };
    },
  };
  return {
    adapter,
    complete: () => handlers?.completed(),
    mailboxChanged: () => handlers?.mailboxChanged(),
    fail: (error) => handlers?.error(error),
    counts,
  };
}

const productionFlows: ImapFlow[] = [];

function productionFixture(): Fixture {
  const flow = new ImapFlow({
    host: "127.0.0.1",
    port: 1,
    secure: false,
    auth: { user: "test", pass: "test" },
  });
  productionFlows.push(flow);
  const counts: ResourceCounts = { listeners: 0, sockets: 1, closeCalls: 0 };
  let resolveIdle: ((value: boolean) => void) | undefined;
  flow.idle = () => {
    flow.idling = true;
    return new Promise<boolean>((resolve) => {
      resolveIdle = resolve;
    });
  };
  flow.noop = async () => {
    flow.idling = false;
    resolveIdle?.(true);
  };
  const close = flow.close.bind(flow);
  flow.close = () => {
    counts.closeCalls += 1;
    counts.sockets = 0;
    close();
  };
  const productionAdapter = createImapFlowIdleAdapter(flow);
  const adapter: IdleSessionAdapter = {
    start: async (handlers) => {
      const resource = await productionAdapter.start(handlers);
      counts.listeners = 5;
      return {
        close: async () => {
          await resource.close();
          counts.listeners = 0;
        },
      };
    },
  };
  return {
    adapter,
    complete: () => {
      flow.idling = false;
      resolveIdle?.(true);
    },
    mailboxChanged: () => flow.emit("exists", { count: 1, prevCount: 0 }),
    fail: (error) =>
      flow.emit("error", error instanceof Error ? error : new Error("provider failure")),
    counts,
  };
}

async function settle(
  fixtureValue: Fixture,
  trigger: (value: Fixture) => void,
): Promise<{ readonly outcome: IdleSessionOutcome; readonly events: readonly IdleSessionEvent[] }> {
  const events: IdleSessionEvent[] = [];
  const pending = runIdleSession({
    adapter: fixtureValue.adapter,
    onEvent: (event) => events.push(event),
  });
  await Promise.resolve();
  trigger(fixtureValue);
  return { outcome: await pending, events };
}

const contractSuite: AdapterContractSuite<Fixture> = {
  name: "one cancellable IMAP IDLE lifecycle",
  cases: [
    {
      id: "normal-completion-closes-before-outcome",
      productionRequired: true,
      run: async (value) => {
        const settled = await settle(value, (current) => current.complete());
        expect(settled.outcome).toEqual({ kind: "normal-completion" });
        expect(settled.events.at(-1)).toEqual({
          kind: "terminal",
          outcome: { kind: "normal-completion" },
        });
        expect(value.counts.listeners).toBe(0);
        expect(value.counts.sockets).toBe(0);
        expect(value.counts.closeCalls).toBeGreaterThan(0);
      },
    },
    {
      id: "mailbox-change-closes-before-outcome",
      productionRequired: true,
      run: async (value) => {
        const settled = await settle(value, (current) => current.mailboxChanged());
        expect(settled.outcome).toEqual({ kind: "mailbox-change" });
        expect(value.counts.listeners).toBe(0);
        expect(value.counts.sockets).toBe(0);
        expect(value.counts.closeCalls).toBeGreaterThan(0);
      },
    },
    {
      id: "adapter-error-closes-before-outcome",
      productionRequired: true,
      run: async (value) => {
        const error = new Error("provider failure");
        const settled = await settle(value, (current) => current.fail(error));
        expect(settled.outcome).toEqual({ kind: "adapter-error", error });
        expect(value.counts.listeners).toBe(0);
        expect(value.counts.sockets).toBe(0);
        expect(value.counts.closeCalls).toBeGreaterThan(0);
      },
    },
    {
      id: "cancellation-closes-before-outcome",
      productionRequired: true,
      run: async (value) => {
        const controller = new AbortController();
        const pending = runIdleSession({ adapter: value.adapter, signal: controller.signal });
        await Promise.resolve();
        controller.abort();
        await expect(pending).resolves.toEqual({ kind: "cancellation" });
        expect(value.counts.listeners).toBe(0);
        expect(value.counts.sockets).toBe(0);
        expect(value.counts.closeCalls).toBeGreaterThan(0);
      },
    },
  ],
};

const fakeInput: Omit<AdapterFactoryInput<Fixture>, "kind"> = {
  factory: fixture,
  capabilities: [{ name: "idle-lifecycle", status: "available" }],
};

const productionInput: Omit<AdapterFactoryInput<Fixture>, "kind"> = {
  factory: productionFixture,
  capabilities: [{ name: "idle-lifecycle", status: "available" }],
  retainedEvidencePath: "packages/imap/test/fixtures/idle-session-production-labeled.json",
};

test("runs the same lifecycle contract against fake and production-shaped adapters", async () => {
  const evidence = await runAdapterContractParity({
    suite: contractSuite,
    fake: fakeInput,
    production: productionInput,
  });

  expect(evidence.productionEvidence.status).toBe("available");
  expect(evidence.production?.status).toBe("passed");
  expect(evidence.semanticParity.status).toBe("matched");
  expect(evidence.production?.passedCases).toEqual(contractSuite.cases.map((item) => item.id));
});

test("cancellation waits for the close barrier and leaves no listeners or socket", async () => {
  const value = fixture();
  const controller = new AbortController();
  const events: IdleSessionEvent[] = [];
  const pending = runIdleSession({
    adapter: value.adapter,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  await Promise.resolve();
  controller.abort();

  await expect(pending).resolves.toEqual({ kind: "cancellation" });
  expect(value.counts).toEqual({ listeners: 0, sockets: 0, closeCalls: 1 });
  expect(events.at(-1)).toEqual({ kind: "terminal", outcome: { kind: "cancellation" } });
});

test("normal completion is terminal and cannot leave the actor idling", async () => {
  const value = fixture();
  const events: IdleSessionEvent[] = [];
  const pending = runIdleSession({
    adapter: value.adapter,
    onEvent: (event) => events.push(event),
  });
  await Promise.resolve();
  value.complete();
  await expect(pending).resolves.toEqual({ kind: "normal-completion" });

  const eventCount = events.length;
  value.complete();
  await Promise.resolve();
  expect(events).toHaveLength(eventCount);
  expect(value.counts.sockets).toBe(0);
});

test("start rejection and invalid resource are terminal adapter errors", async () => {
  const rejection = new Error("start failed");
  await expect(
    runIdleSession({
      adapter: {
        start: async () => {
          throw rejection;
        },
      },
    }),
  ).resolves.toEqual({ kind: "adapter-error", error: rejection });

  const invalidEvents: IdleSessionEvent[] = [];
  const invalidOutcome = await runIdleSession({
    adapter: undefined,
    onEvent: (event) => invalidEvents.push(event),
  });
  expect(invalidOutcome).toMatchObject({ kind: "adapter-error" });
  expect(invalidEvents).toHaveLength(1);
  expect(invalidEvents[0]).toMatchObject({
    kind: "terminal",
    outcome: { kind: "adapter-error" },
  });

  await expect(
    runIdleSession({
      adapter: { start: async () => undefined },
    }),
  ).resolves.toMatchObject({ kind: "adapter-error" });
});

test("cancellation before acquisition waits for and closes the eventual resource", async () => {
  const controller = new AbortController();
  let resolveStart: ((resource: { readonly close: () => Promise<void> }) => void) | undefined;
  let closeCalls = 0;
  const pending = runIdleSession({
    adapter: {
      start: () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    },
    signal: controller.signal,
  });
  controller.abort();
  await Promise.resolve();
  resolveStart?.({
    close: async () => {
      closeCalls += 1;
    },
  });

  await expect(pending).resolves.toEqual({ kind: "cancellation" });
  expect(closeCalls).toBe(1);
});

test("ready is not emitted after a terminal request", async () => {
  let handlers:
    | {
        readonly ready: () => void;
        readonly completed: () => void;
      }
    | undefined;
  const events: IdleSessionEvent[] = [];
  const pending = runIdleSession({
    adapter: {
      start: async (nextHandlers) => {
        handlers = nextHandlers;
        return { close: async () => undefined };
      },
    },
    onEvent: (event) => events.push(event),
  });
  await Promise.resolve();
  handlers?.completed();
  await expect(pending).resolves.toEqual({ kind: "normal-completion" });
  handlers?.ready();
  expect(events.filter((event) => event.kind === "ready")).toHaveLength(0);
});

test("the callback actor captures scope and classifies authentication failures", async () => {
  let handlers:
    | {
        readonly ready: () => void;
        readonly error: (error: unknown) => void;
      }
    | undefined;
  const observed: IdleSessionActorEvent[] = [];
  const machine = setup({
    types: {} as {
      context: IdleSessionActorInput;
      input: IdleSessionActorInput;
      events: IdleSessionActorEvent;
    },
    actors: { idleSession: idleSessionActor },
  }).createMachine({
    context: ({ input }) => input,
    invoke: { src: "idleSession", input: ({ context }) => context },
    on: {
      "idle.ready": { actions: ({ event }) => observed.push(event) },
      "idle.failed": { actions: ({ event }) => observed.push(event) },
    },
  });
  const adapter: IdleSessionAdapter = {
    start: async (nextHandlers) => {
      handlers = nextHandlers;
      nextHandlers.ready();
      return { close: async () => undefined };
    },
  };
  const actor = createActor(machine, {
    input: { scopeEpoch: 9, credentialRevision: 7, validatedIdleAdapter: adapter },
  });
  actor.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed).toEqual([{ type: "idle.ready", scopeEpoch: 9 }]);
  handlers?.error({ response: { code: "AUTHENTICATIONFAILED" }, message: "password=secret" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({
    type: "idle.failed",
    scopeEpoch: 9,
    fault: {
      category: "authentication",
      code: "auth_required",
      safeMessage: "Credentials were rejected.",
      authReason: "provider-rejected",
      attemptedCredentialRevision: 7,
    },
  });
  actor.stop();
});

test("the callback actor reports one safe failure for an invalid adapter", async () => {
  const observed: IdleSessionActorEvent[] = [];
  const machine = setup({
    types: {} as {
      context: IdleSessionActorInput;
      input: IdleSessionActorInput;
      events: IdleSessionActorEvent;
    },
    actors: { idleSession: idleSessionActor },
  }).createMachine({
    context: ({ input }) => input,
    invoke: { src: "idleSession", input: ({ context }) => context },
    on: {
      "idle.failed": { actions: ({ event }) => observed.push(event) },
    },
  });
  const actor = createActor(machine, {
    input: { scopeEpoch: 12, credentialRevision: 8, validatedIdleAdapter: undefined },
  });
  actor.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed).toEqual([
    {
      type: "idle.failed",
      scopeEpoch: 12,
      fault: {
        category: "transient",
        code: "sync.idle-adapter-failure",
        safeMessage: "IMAP IDLE adapter failed.",
        attemptedCredentialRevision: 8,
      },
    },
  ]);
  expect(JSON.stringify(observed)).not.toContain("invalid IDLE adapter");
  actor.stop();
});

test("the callback actor emits every signed lifecycle event with its scope", async () => {
  type Trigger = "mailboxChanged" | "completed" | "failed";
  const capture = async (
    scopeEpoch: number,
    credentialRevision: number,
    trigger: Trigger,
  ): Promise<IdleSessionActorEvent[]> => {
    let handlers:
      | {
          readonly ready: () => void;
          readonly mailboxChanged: () => void;
          readonly completed: () => void;
          readonly error: (error: unknown) => void;
        }
      | undefined;
    const observed: IdleSessionActorEvent[] = [];
    const machine = setup({
      types: {} as {
        context: IdleSessionActorInput;
        input: IdleSessionActorInput;
        events: IdleSessionActorEvent;
      },
      actors: { idleSession: idleSessionActor },
    }).createMachine({
      context: ({ input }) => input,
      invoke: { src: "idleSession", input: ({ context }) => context },
      on: {
        "idle.ready": { actions: ({ event }) => observed.push(event) },
        "idle.mailboxChanged": { actions: ({ event }) => observed.push(event) },
        "idle.completed": { actions: ({ event }) => observed.push(event) },
        "idle.failed": { actions: ({ event }) => observed.push(event) },
      },
    });
    const adapter: IdleSessionAdapter = {
      start: async (nextHandlers) => {
        handlers = nextHandlers;
        nextHandlers.ready();
        return { close: async () => undefined };
      },
    };
    const actor = createActor(machine, {
      input: { scopeEpoch, credentialRevision, validatedIdleAdapter: adapter },
    });
    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (handlers === undefined) throw new Error("fake adapter did not start");
    if (trigger === "failed") {
      handlers.error({ response: { code: "AUTHENTICATIONFAILED" }, message: "secret=redact" });
    } else {
      handlers[trigger]();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    actor.stop();
    return observed;
  };

  await expect(capture(21, 1, "mailboxChanged")).resolves.toEqual([
    { type: "idle.ready", scopeEpoch: 21 },
    { type: "idle.mailboxChanged", scopeEpoch: 21 },
  ]);
  await expect(capture(22, 2, "completed")).resolves.toEqual([
    { type: "idle.ready", scopeEpoch: 22 },
    { type: "idle.completed", scopeEpoch: 22 },
  ]);
  await expect(capture(23, 3, "failed")).resolves.toEqual([
    { type: "idle.ready", scopeEpoch: 23 },
    {
      type: "idle.failed",
      scopeEpoch: 23,
      fault: {
        category: "authentication",
        code: "auth_required",
        safeMessage: "Credentials were rejected.",
        authReason: "provider-rejected",
        attemptedCredentialRevision: 3,
      },
    },
  ]);
});

describe("installed ImapFlow lifecycle shape", () => {
  afterEach(() => {
    for (const flow of productionFlows) flow.close();
    productionFlows.splice(0);
  });

  test("leaves IDLE, removes exact listeners, and closes the socket on cancellation", async () => {
    const flow = new ImapFlow({
      host: "127.0.0.1",
      port: 1,
      secure: false,
      auth: { user: "test", pass: "test" },
    });
    productionFlows.push(flow);
    let resolveIdle: ((value: boolean) => void) | undefined;
    let socketClosed = false;
    flow.idle = () => {
      flow.idling = true;
      return new Promise<boolean>((resolve) => {
        resolveIdle = resolve;
      });
    };
    flow.noop = async () => {
      flow.idling = false;
      resolveIdle?.(true);
    };
    const close = flow.close.bind(flow);
    flow.close = () => {
      socketClosed = true;
      close();
    };

    const value = createImapFlowIdleAdapter(flow);
    const controller = new AbortController();
    const pending = runIdleSession({ adapter: value, signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(pending).resolves.toEqual({ kind: "cancellation" });
    expect(socketClosed).toBe(true);
    expect(flow.listenerCount("exists")).toBe(0);
    expect(flow.listenerCount("expunge")).toBe(0);
    expect(flow.listenerCount("flags")).toBe(0);
    expect(flow.listenerCount("error")).toBe(0);
    expect(flow.listenerCount("close")).toBe(0);
  });
});
