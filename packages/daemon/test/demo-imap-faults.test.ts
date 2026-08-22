import { describe, expect, test } from "bun:test";
import {
  createDemoImapServer,
  leaseDemoImapTestPort,
  runRemoteEffectThenLocalWrite,
} from "../src/demo/imap";
import { createInstalledDemoImapFlow } from "./adapter-contracts/demo-imap-runtime";

async function runFaultCase<T>(
  operation: (input: Readonly<{
    readonly server: ReturnType<typeof createDemoImapServer>;
    readonly flow: ReturnType<typeof createInstalledDemoImapFlow>;
  }>) => Promise<T>,
): Promise<Readonly<{ readonly result: T; readonly server: ReturnType<typeof createDemoImapServer> }>> {
  const lease = leaseDemoImapTestPort();
  const server = createDemoImapServer({ port: lease.port, releasePort: lease.release });
  const flow = createInstalledDemoImapFlow(server);
  await server.start();
  try {
    await flow.connect();
    await flow.mailboxOpen("INBOX");
    return { result: await operation({ server, flow }), server };
  } finally {
    flow.close();
    await server.close();
  }
}

describe("demo IMAP failure injection", () => {
  test("applies latency and throttling once while preserving valid protocol completion", async () => {
    const { result, server } = await runFaultCase(async ({ server, flow }) => {
      server.scheduleFault({ kind: "latency", command: "UID SEARCH", milliseconds: 15 });
      const startedAt = performance.now();
      const searched = await flow.search({ all: true }, { uid: true });
      const elapsed = performance.now() - startedAt;
      server.scheduleFault({
        kind: "throttle",
        command: "UID FETCH",
        chunkBytes: 7,
        delayMilliseconds: 1,
      });
      const fetched = await flow.fetchAll("1", { uid: true, flags: true }, { uid: true });
      return { searched, elapsed, fetched };
    });
    expect(result.searched).toEqual([1, 2]);
    expect(result.elapsed).toBeGreaterThanOrEqual(10);
    expect(result.fetched[0]).toMatchObject({ uid: 1 });
    expect(server.snapshot()).toMatchObject({
      listening: false,
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      activeTestLeases: 0,
      faultState: { kind: "completed", command: "UID FETCH" },
    });
  });

  test("surfaces scripted failure and cancellation without corrupting the session", async () => {
    const { result } = await runFaultCase(async ({ server, flow }) => {
      server.scheduleFault({
        kind: "scripted-failure",
        command: "UID SEARCH",
        status: "NO",
        code: "UNAVAILABLE",
      });
      const scripted = await flow.search({ all: true }, { uid: true });
      server.scheduleFault({ kind: "cancel", command: "IDLE" });
      const cancelled = await flow.idle();
      await flow.noop();
      return { scripted, cancelled, snapshot: server.snapshot() };
    });
    expect(result.scripted).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.snapshot.commands.at(-1)).toMatchObject({
      command: "NOOP",
      sessionState: "selected",
    });
  });

  test("disconnects before response and after a remote effect with truthful state", async () => {
    const before = await runFaultCase(async ({ server, flow }) => {
      server.scheduleFault({
        kind: "disconnect",
        command: "UID FETCH",
        phase: "before-response",
      });
      let rejected = false;
      try {
        await flow.fetchAll("1", { uid: true }, { uid: true });
      } catch {
        rejected = true;
      }
      return rejected;
    });
    expect(before.result).toBe(true);

    const after = await runFaultCase(async ({ server, flow }) => {
      server.scheduleFault({
        kind: "disconnect",
        command: "UID STORE",
        phase: "after-effect",
      });
      const result = await flow.messageFlagsAdd("1", ["\\Seen"], {
        uid: true,
        unchangedSince: 10n,
      });
      return { result, snapshot: server.snapshot() };
    });
    expect(after.result.result).toBe(false);
    expect(after.result.snapshot.mailboxes.find(({ path }) => path === "INBOX")?.messages[0]?.flags).toContain("\\Seen");
  });

  test("partial response is terminal and all resources still quiesce", async () => {
    const { result, server } = await runFaultCase(async ({ server, flow }) => {
      server.scheduleFault({ kind: "partial-response", command: "UID FETCH", bytes: 12 });
      let rejected = false;
      try {
        await flow.fetchAll("1", { uid: true, envelope: true }, { uid: true });
      } catch {
        rejected = true;
      }
      return rejected;
    });
    expect(result).toBe(true);
    expect(server.snapshot()).toMatchObject({
      listening: false,
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      activeTestLeases: 0,
    });
  });

  test("retains completed remote evidence when the local result write fails", async () => {
    const { result } = await runFaultCase(async ({ server, flow }) =>
      runRemoteEffectThenLocalWrite({
        remoteEffect: async () => {
          const applied = await flow.messageFlagsAdd("1", ["\\Seen"], {
            uid: true,
            unchangedSince: 10n,
          });
          return { applied, snapshot: server.snapshot() };
        },
        writeLocalResult: async () => {
          throw new Error("injected local result-write failure");
        },
      }),
    );
    expect(result.kind).toBe("local-write-failed");
    expect(result.remoteResult.applied).toBe(true);
    expect(result.remoteResult.snapshot.mailboxes.find(({ path }) => path === "INBOX")?.messages[0]?.flags).toContain("\\Seen");
    if (result.kind === "local-write-failed") {
      expect(result.safeMessage).toBe("Remote effect completed, but the local result write failed.");
    }
  });
});
