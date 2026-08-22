import { describe, expect, test } from "bun:test";
import {
  classifyImapAuthenticationFailure,
} from "../../imap/src/auth-failure-classifier";
import {
  createImapFlowIdleAdapter,
  runIdleSession,
} from "../../imap/src/idle-session";
import { normalizeImapResponse } from "../../imap/src/status-normalizer";
import { runAdapterContract } from "../../../tests/adapter-contracts/harness";
import {
  createDemoImapServer,
  leaseDemoImapTestPort,
  type DemoImapMessageInput,
} from "../src/demo/imap";
import {
  createInstalledDemoImapFlow,
  installedDemoImapAdapterContract,
} from "./adapter-contracts/demo-imap-runtime";

const arrival: DemoImapMessageInput = Object.freeze({
  uid: 3,
  modseq: 12n,
  internalDate: "2026-08-17T12:00:00.000Z",
  subject: "New mail",
  from: "sender@example.test",
  to: "person@example.test",
  raw: "Message-ID: <demo-3@example.test>\r\nSubject: New mail\r\n\r\nHello\r\n",
});

async function withServer<T>(
  run: (input: Readonly<{
    readonly server: ReturnType<typeof createDemoImapServer>;
    readonly flow: ReturnType<typeof createInstalledDemoImapFlow>;
  }>) => Promise<T>,
): Promise<Readonly<{ readonly result: T; readonly closed: ReturnType<ReturnType<typeof createDemoImapServer>["snapshot"]> }>> {
  const lease = leaseDemoImapTestPort();
  const server = createDemoImapServer({ port: lease.port, releasePort: lease.release });
  await server.start();
  const flow = createInstalledDemoImapFlow(server);
  try {
    await flow.connect();
    const result = await run({ server, flow });
    if (flow.usable) await flow.logout();
    return { result, closed: server.snapshot() };
  } finally {
    flow.close();
    await server.close();
  }
}

describe("stateful demo IMAP over installed ImapFlow 1.7.1", () => {
  test("classifies a real tagged authentication rejection without retaining credentials", async () => {
    const lease = leaseDemoImapTestPort();
    const server = createDemoImapServer({ port: lease.port, releasePort: lease.release });
    const flow = createInstalledDemoImapFlow(server, { user: "demo-user", pass: "wrong" });
    await server.start();
    try {
      let failure: unknown;
      try {
        await flow.connect();
      } catch (error: unknown) {
        failure = error;
      }
      expect(classifyImapAuthenticationFailure(failure)).toMatchObject({
        category: "authentication",
        code: "auth_required",
        authReason: "provider-rejected",
      });
      expect(server.snapshot().commands.map(({ command }) => command).join(" ")).not.toContain(
        "wrong",
      );
    } finally {
      flow.close();
      await server.close();
    }
    expect(server.snapshot()).toMatchObject({
      listening: false,
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      childProcesses: 0,
      activeTestLeases: 0,
    });
  });

  test("runs the reusable production adapter contract through real loopback TCP", async () => {
    const { result } = await withServer(async ({ flow }) =>
      runAdapterContract({
        suite: installedDemoImapAdapterContract,
        factory: () => flow,
        kind: "production",
        capabilities: [
          { name: "real-loopback-list", status: "available" },
          { name: "real-loopback-fetch", status: "available" },
          { name: "condstore", status: "available" },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: "passed",
      passedCases: [
        "mailbox-discovery-preserves-special-use-and-noselect",
        "metadata-and-precondition-use-real-select-fetch",
      ],
    });
  });

  test("normalizes known and unknown epochs and completes IDLE through its cleanup barrier", async () => {
    const lease = leaseDemoImapTestPort();
    const server = createDemoImapServer({
      port: lease.port,
      releasePort: lease.release,
      mailboxes: [
        {
          path: "INBOX",
          selectable: true,
          uidValidity: { kind: "unknown" },
          uidNext: { kind: "unknown" },
          highestModseq: { kind: "unknown" },
          messages: [],
        },
        {
          path: "Archive",
          selectable: true,
          specialUse: "\\Archive",
          uidValidity: { kind: "known", value: 88 },
          uidNext: { kind: "known", value: 1 },
          highestModseq: { kind: "known", value: 0n },
          messages: [],
        },
        {
          path: "Trash",
          selectable: true,
          specialUse: "\\Trash",
          uidValidity: { kind: "known", value: 99 },
          uidNext: { kind: "known", value: 1 },
          highestModseq: { kind: "known", value: 0n },
          messages: [],
        },
      ],
    });
    const flow = createInstalledDemoImapFlow(server);
    await server.start();
    try {
      await flow.connect();
      await flow.mailboxOpen("INBOX");
      const normalized = normalizeImapResponse({
        capabilities: flow.capabilities,
        mailbox: {
          flags: flow.mailbox === false ? undefined : flow.mailbox.flags,
        },
      });
      expect(normalized.mailbox.uidValidity).toEqual({ kind: "unknown" });
      expect(normalized.mailbox.uidNext).toEqual({ kind: "unknown" });
      expect(normalized.mailbox.highestModseq).toEqual({ kind: "unknown" });

      const events: string[] = [];
      const idle = runIdleSession({
        adapter: createImapFlowIdleAdapter(flow),
        onEvent: (event) => events.push(event.kind === "ready" ? "ready" : event.outcome.kind),
      });
      await Bun.sleep(10);
      await server.applyMailboxEvent({ kind: "mail-arrived", mailbox: "INBOX", message: arrival });
      await expect(idle).resolves.toEqual({ kind: "mailbox-change" });
      expect(events).toEqual(["ready", "mailbox-change"]);
      expect(flow.listenerCount("exists")).toBe(0);
      expect(flow.listenerCount("expunge")).toBe(0);
      expect(flow.listenerCount("flags")).toBe(0);
    } finally {
      flow.close();
      await server.close();
    }
    expect(server.snapshot()).toMatchObject({
      listening: false,
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      childProcesses: 0,
      activeTestLeases: 0,
    });
  });

  test("applies seen, unseen, Archive, and Trash effects without a delete or expunge command", async () => {
    const { result } = await withServer(async ({ server, flow }) => {
      await flow.mailboxOpen("INBOX");
      expect(await flow.search({ seen: false }, { uid: true })).toEqual([1]);
      expect(await flow.messageFlagsAdd("1", ["\\Seen"], { uid: true, unchangedSince: 10n })).toBe(true);
      expect(await flow.search({ seen: false }, { uid: true })).toEqual([]);
      expect(await flow.messageFlagsRemove("1", ["\\Seen"], { uid: true, unchangedSince: 11n })).toBe(true);
      expect(await flow.search({ seen: false }, { uid: true })).toEqual([1]);
      expect(await flow.messageMove("2", "Archive", { uid: true })).toMatchObject({
        destination: "Archive",
      });
      expect(await flow.messageMove("1", "Trash", { uid: true })).toMatchObject({
        destination: "Trash",
      });
      return server.snapshot();
    });
    expect(result.forbiddenCommands).toEqual([]);
    expect(result.commands.some(({ command }) => command === "DELETE" || command.includes("EXPUNGE"))).toBe(false);
    expect(result.mailboxes.find(({ path }) => path === "Archive")?.messages).toHaveLength(1);
    expect(result.mailboxes.find(({ path }) => path === "Trash")?.messages).toHaveLength(1);
  });

  test("drives flag, move, disappearance, epoch, and reconnect events through one session", async () => {
    const { result } = await withServer(async ({ server, flow }) => {
      await flow.mailboxOpen("INBOX");
      const observed = { flags: 0, expunge: 0, close: 0 };
      flow.on("flags", () => {
        observed.flags += 1;
      });
      flow.on("expunge", () => {
        observed.expunge += 1;
      });
      flow.on("close", () => {
        observed.close += 1;
      });
      await server.applyMailboxEvent({
        kind: "flags-changed",
        mailbox: "INBOX",
        uid: 1,
        flags: ["\\Flagged"],
      });
      await server.applyMailboxEvent({
        kind: "message-moved",
        source: "INBOX",
        destination: "Archive",
        uid: 2,
      });
      await server.applyMailboxEvent({ kind: "message-disappeared", mailbox: "INBOX", uid: 1 });
      await server.applyMailboxEvent({
        kind: "epoch-changed",
        mailbox: "INBOX",
        uidValidity: { kind: "known", value: 101 },
        uidNext: { kind: "unknown" },
        highestModseq: { kind: "unknown" },
      });
      const beforeReconnect = server.snapshot();
      await server.applyMailboxEvent({ kind: "reconnect-required", reason: "epoch-change" });
      await Bun.sleep(10);
      return { observed, beforeReconnect, afterReconnect: server.snapshot() };
    });
    expect(result.observed).toEqual({ flags: 1, expunge: 2, close: 1 });
    expect(result.beforeReconnect.mailboxes.find(({ path }) => path === "INBOX")).toMatchObject({
      uidValidity: { kind: "known", value: 101 },
      uidNext: { kind: "unknown" },
      highestModseq: { kind: "unknown" },
      messages: [],
    });
    expect(result.beforeReconnect.mailboxes.find(({ path }) => path === "Archive")?.messages).toHaveLength(1);
    expect(result.afterReconnect.activeSessions).toBe(0);
  });
});
