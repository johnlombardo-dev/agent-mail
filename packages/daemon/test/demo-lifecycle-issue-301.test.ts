import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createActor } from "xstate";
import {
  createDemoComposition,
  demoCompositionDefaultAdapters,
  type DemoComposition,
  type DemoCompositionReady,
} from "../src/demo/composition";
import { createDemoImapServer, type DemoImapServer } from "../src/demo/imap";
import {
  createDemoLifecycleMachine,
  createDemoLifecycleSupervisor,
  type DemoLifecycleSupervisor,
  type DemoLifecycleState,
} from "../src/demo/lifecycle";
import { demoProfileRootExists } from "../src/demo/profile";

const scratchRoots: string[] = [];
const tcpBlockers: Server[] = [];
const supervisors: DemoLifecycleSupervisor[] = [];
const compositions: DemoComposition[] = [];

async function demoRoot(label: string): Promise<Readonly<{ parent: string; root: string }>> {
  const parent = await mkdtemp(join(tmpdir(), `agent-mail-demo-301-${label}-`));
  await chmod(parent, 0o700);
  scratchRoots.push(parent);
  return Object.freeze({ parent, root: join(parent, "agent-mail-demo-run") });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function blockPort(port: number): Promise<Server> {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  tcpBlockers.push(server);
  return server;
}

async function expectLoopbackClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`unexpected listener on ${port}`));
    });
    socket.once("error", () => resolve());
  });
}

function lifecycleValue(actor: ReturnType<typeof createActor>): DemoLifecycleState {
  return actor.getSnapshot().value as DemoLifecycleState;
}

async function waitForTerminal(actor: ReturnType<typeof createActor>): Promise<DemoLifecycleState> {
  return new Promise<DemoLifecycleState>((resolve) => {
    const inspect = (): void => {
      const state = lifecycleValue(actor);
      if (state === "failed" || state === "ready" || state === "absent") {
        subscription.unsubscribe();
        resolve(state);
      }
    };
    const subscription = actor.subscribe(inspect);
    inspect();
  });
}

afterEach(async () => {
  while (supervisors.length > 0) await supervisors.pop()?.remove().catch(() => undefined);
  while (compositions.length > 0) await compositions.pop()?.cleanup().catch(() => undefined);
  while (tcpBlockers.length > 0) await closeServer(tcpBlockers.pop() as Server);
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await expectLoopbackClosed(6111);
  await expectLoopbackClosed(6119);
});

describe("disposable demo lifecycle #301", () => {
  test("runs the signed corpus through SmartIMAP, ImapFlow, canonical search, and exact cleanup", async () => {
    const { parent, root } = await demoRoot("happy");
    const productionSentinel = join(parent, "production-sentinel.txt");
    await writeFile(productionSentinel, "production-byte-sentinel", { mode: 0o600 });
    let server: DemoImapServer | undefined;
    let sourceBefore: ReturnType<DemoImapServer["backend"]>["snapshot"] extends () => infer T
      ? T
      : never;
    const supervisor = createDemoLifecycleSupervisor(
      { root },
      {
        ...demoCompositionDefaultAdapters,
        createImapServer: (options) => {
          server = createDemoImapServer(options);
          sourceBefore = server.backend().snapshot();
          return server;
        },
      },
    );
    supervisors.push(supervisor);

    const firstStart = supervisor.start();
    expect(supervisor.start()).toBe(firstStart);
    const ready = await firstStart;
    expect(ready.baseUrl).toBe("http://127.0.0.1:6119");
    expect(ready.completedMessages).toBeGreaterThan(0);
    expect(supervisor.status()).toMatchObject({
      state: "ready",
      ready: true,
      root,
      baseUrl: "http://127.0.0.1:6119",
      diagnostic: null,
      resources: {
        profileOwned: true,
        imapListening: true,
        daemonState: "ready",
        activeSourceSessions: 1,
      },
    });

    const unauthorized = await fetch(`${ready.baseUrl}/v1/messages/search`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-demo-token", "content-type": "application/json" },
      body: JSON.stringify({ query: "Synthetic", filters: {}, limit: 20 }),
    });
    expect(unauthorized.status).toBe(401);
    const search = await fetch(`${ready.baseUrl}/v1/messages/search`, {
      method: "POST",
      headers: { authorization: ready.authorization, "content-type": "application/json" },
      body: JSON.stringify({ query: "Synthetic", filters: {}, limit: 20 }),
    });
    expect(search.status).toBe(200);
    const searchResult = (await search.json()) as Readonly<{
      readonly items: readonly Readonly<{ readonly messageId: string; readonly subject: string }>[];
    }>;
    expect(searchResult.items).toHaveLength(3);
    expect(searchResult.items.map((item) => item.messageId)).toContain(
      ready.observedSource.messageId,
    );
    const subjects = searchResult.items.map((item) => item.subject);
    expect(subjects).toContain("Synthetic ordinary 0");
    expect(subjects).toContain("Synthetic transactional 1");
    expect(subjects).toContain("Synthetic mailing-list 2");
    expect(server?.backend().snapshot()).toEqual(sourceBefore);

    const firstStop = supervisor.shutdown("SIGTERM");
    expect(supervisor.stop()).toBe(firstStop);
    await firstStop;
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.status()).toMatchObject({
      state: "absent",
      ready: false,
      root: null,
      resources: {
        profileOwned: false,
        imapListening: false,
        daemonState: "absent",
        activeSourceSessions: 0,
        cleanupPending: false,
      },
    });
    expect(await demoProfileRootExists(root)).toBe(false);
    expect(await readFile(productionSentinel, "utf8")).toBe("production-byte-sentinel");
  }, 30_000);

  test("preempts an immediate start, shares cleanup, and starts fresh after reset", async () => {
    const { root } = await demoRoot("cancel");
    const supervisor = createDemoLifecycleSupervisor({ root });
    supervisors.push(supervisor);
    const starting = supervisor.start();
    const stopping = supervisor.stop();
    expect(supervisor.stop()).toBe(stopping);
    await expect(starting).rejects.toThrow("stopped before readiness");
    await expect(stopping).resolves.toBeUndefined();
    expect(supervisor.status().state).toBe("absent");
    expect(await demoProfileRootExists(root)).toBe(false);

    const ready = await supervisor.start();
    expect(ready.completedMessages).toBeGreaterThan(0);
    const resetting = supervisor.reset();
    expect(supervisor.remove()).toBe(resetting);
    await resetting;
    expect(supervisor.status().state).toBe("absent");
    expect(await demoProfileRootExists(root)).toBe(false);
  }, 30_000);

  test("fails a fixed SmartIMAP collision closed, then resets for a clean retry", async () => {
    const { root } = await demoRoot("collision");
    const blocker = await blockPort(6111);
    const supervisor = createDemoLifecycleSupervisor({ root });
    supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toThrow("Disposable demo IMAP startup failed");
    expect(supervisor.status()).toMatchObject({
      state: "failed",
      diagnostic: { code: "demo.imap" },
      resources: {
        profileOwned: false,
        imapListening: false,
        activeSourceSessions: 0,
      },
    });
    expect(await demoProfileRootExists(root)).toBe(false);
    await supervisor.reset();
    await closeServer(blocker);
    const index = tcpBlockers.indexOf(blocker);
    if (index >= 0) tcpBlockers.splice(index, 1);

    await expect(supervisor.start()).resolves.toMatchObject({ completedMessages: 3 });
    await supervisor.remove();
    expect(await demoProfileRootExists(root)).toBe(false);
  }, 30_000);

  test("fails a canonical HTTP collision closed before exposing readiness", async () => {
    const { root } = await demoRoot("http-collision");
    const blocker = await blockPort(6119);
    const supervisor = createDemoLifecycleSupervisor({ root });
    supervisors.push(supervisor);
    await expect(supervisor.start()).rejects.toThrow("Disposable demo daemon startup failed");
    expect(supervisor.status()).toMatchObject({
      state: "failed",
      ready: false,
      baseUrl: null,
      diagnostic: { code: "demo.daemon" },
      resources: {
        profileOwned: false,
        imapListening: false,
        activeSourceSessions: 0,
      },
    });
    expect(await demoProfileRootExists(root)).toBe(false);
    await supervisor.reset();
    await closeServer(blocker);
    const index = tcpBlockers.indexOf(blocker);
    if (index >= 0) tcpBlockers.splice(index, 1);
  }, 30_000);

  test("fails a public stop closed when the ownership marker changes", async () => {
    const { root } = await demoRoot("marker-attack");
    const supervisor = createDemoLifecycleSupervisor({ root });
    supervisors.push(supervisor);
    await supervisor.start();
    const markerPath = join(root, ".agent-mail-demo-owner.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    marker.ownerToken = "00000000-0000-4000-8000-000000000000";
    await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });

    await expect(supervisor.remove()).rejects.toThrow("Disposable demo cleanup failed");
    expect(supervisor.status()).toMatchObject({
      state: "failed",
      diagnostic: { code: "demo.cleanup" },
      resources: {
        profileOwned: true,
        imapListening: false,
        activeSourceSessions: 0,
      },
    });
    expect((await readFile(markerPath, "utf8")).includes("00000000-0000-4000-8000-000000000000")).toBe(
      true,
    );
  }, 30_000);

  test("cleans actual composition acquisition failures at their owning boundary", async () => {
    const cases = [
      {
        label: "corpus",
        code: "demo.generate",
        adapters: {
          ...demoCompositionDefaultAdapters,
          buildCorpus: () => {
            throw new Error("injected corpus acquisition failure");
          },
        },
      },
      {
        label: "imap-construction",
        code: "demo.generate",
        adapters: {
          ...demoCompositionDefaultAdapters,
          createImapServer: () => {
            throw new Error("injected IMAP construction failure");
          },
        },
      },
      {
        label: "source",
        code: "demo.daemon",
        adapters: {
          ...demoCompositionDefaultAdapters,
          createSource: () => {
            throw new Error("injected source construction failure");
          },
        },
      },
      {
        label: "runtime",
        code: "demo.daemon",
        adapters: {
          ...demoCompositionDefaultAdapters,
          createRuntime: () => {
            throw new Error("injected runtime construction failure");
          },
        },
      },
    ] as const;

    for (const candidate of cases) {
      const { root } = await demoRoot(candidate.label);
      const supervisor = createDemoLifecycleSupervisor({ root }, candidate.adapters);
      supervisors.push(supervisor);
      await expect(supervisor.start(), candidate.label).rejects.toThrow("Disposable demo");
      expect(supervisor.status(), candidate.label).toMatchObject({
        state: "failed",
        ready: false,
        diagnostic: { code: candidate.code },
        resources: {
          profileOwned: false,
          imapListening: false,
          activeSourceSessions: 0,
          cleanupPending: false,
        },
      });
      expect(await demoProfileRootExists(root), candidate.label).toBe(false);
      await supervisor.reset();
    }
  }, 30_000);

  test("maps every acquisition phase failure through one cleanup barrier", async () => {
    const phases = ["generate", "startImap", "startDaemon", "awaitReady"] as const;
    for (const phase of phases) {
      let cleanupCalls = 0;
      const ready: DemoCompositionReady = {
        baseUrl: "http://127.0.0.1:6119",
        authorization: "Bearer test",
        observedSource: {
          messageId: "message:test",
          accountId: "account:test",
          mailboxId: "mailbox:test",
          uidValidity: 1,
          uid: 1,
        },
        completedMessages: 1,
      };
      const operation = async (name: (typeof phases)[number]): Promise<void> => {
        if (phase === name) throw new Error("injected phase failure");
      };
      const composition: DemoComposition = {
        generate: async () => operation("generate"),
        startImap: async () => operation("startImap"),
        startDaemon: async () => operation("startDaemon"),
        awaitReady: async () => {
          await operation("awaitReady");
          return ready;
        },
        cleanup: async () => {
          cleanupCalls += 1;
        },
        snapshot: () => ({
          profileRoot: null,
          profileOwned: false,
          imapListening: false,
          daemonState: "absent",
          activeSourceSessions: 0,
          cleanupPending: false,
        }),
      };
      const actor = createActor(createDemoLifecycleMachine(composition));
      actor.start();
      actor.send({ type: "demo.start" });
      expect(await waitForTerminal(actor), phase).toBe("failed");
      expect(cleanupCalls, phase).toBe(1);
      expect(actor.getSnapshot().context.failure?.code, phase).toBe(
        phase === "generate"
          ? "demo.generate"
          : phase === "startImap"
            ? "demo.imap"
            : phase === "startDaemon"
              ? "demo.daemon"
              : "demo.sync",
      );
      actor.stop();
    }
  });

  test("composition cleanup remains retryable when an owned finalizer fails", async () => {
    const { root } = await demoRoot("cleanup-retry");
    let closeCalls = 0;
    const composition = createDemoComposition(
      { root },
      {
        ...demoCompositionDefaultAdapters,
        createImapServer: (options) => {
          const server = createDemoImapServer(options);
          return {
            ...server,
            close: async () => {
              closeCalls += 1;
              if (closeCalls === 1) throw new Error("injected close failure");
              await server.close();
            },
          };
        },
      },
    );
    compositions.push(composition);
    const controller = new AbortController();
    await composition.generate(controller.signal);
    await composition.startImap(controller.signal);
    await expect(composition.cleanup()).rejects.toThrow("cleanup failed");
    expect(composition.snapshot()).toMatchObject({
      profileOwned: true,
      imapListening: true,
      activeSourceSessions: 0,
    });
    await expect(composition.cleanup()).resolves.toBeUndefined();
    expect(composition.snapshot().imapListening).toBe(false);
    expect(closeCalls).toBe(2);
  });
});
