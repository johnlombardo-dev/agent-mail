import { createConnection, createServer, type Server } from "node:net";
import { ImapFlow } from "imapflow";
import { describe, expect, test } from "bun:test";
import { CORPUS_VERSION, buildCorpus, type DemoCorpus } from "../src/demo/corpus";
import {
  createDemoImapServer,
  DEMO_IMAP_PASSWORD,
  DEMO_IMAP_USERNAME,
  leaseDemoImapTestPort,
  activeDemoImapTestPortLeases,
  type DemoImapServer,
} from "../src/demo/imap";

const corpus = buildCorpus({
  scenarioVersion: CORPUS_VERSION,
  seed: "smartimap-test",
  size: 12,
  scenarioMix: {
    ordinary: 1,
    transactional: 1,
    "mailing-list": 1,
    newsletter: 1,
    automated: 1,
    spam: 1,
  },
});

function createFlow(server: DemoImapServer): ImapFlow {
  return new ImapFlow({
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
}

async function withServer<T>(
  corpusInput: DemoCorpus,
  run: (flow: ImapFlow, server: DemoImapServer) => Promise<T>,
): Promise<T> {
  const lease = await leaseDemoImapTestPort();
  const server = createDemoImapServer({
    corpus: corpusInput,
    port: lease.port,
    releasePort: lease.release,
  });
  const flow = createFlow(server);
  await server.start();
  try {
    await flow.connect();
    return await run(flow, server);
  } finally {
    if (flow.usable) await flow.logout().catch(() => undefined);
    flow.close();
    await server.close();
  }
}

async function occupyPort(port: number): Promise<Server> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => resolve());
  });
  return blocker;
}

describe("published smartimap demo backend", () => {
  test("runs loopback list, read-only select, UID search, and byte-exact source fetch", async () => {
    await withServer(corpus, async (flow, server) => {
      const listed = await flow.list();
      expect(listed.map((mailbox) => mailbox.path)).toEqual(["INBOX", "Archive", "Sparse"]);
      expect(listed.find((mailbox) => mailbox.path === "Archive")?.specialUse).toBe("\\Archive");
      await flow.mailboxOpen("INBOX", { readOnly: true });
      const selected = server
        .backend()
        .snapshot()
        .mailboxes.find((mailbox) => mailbox.sourceName === "INBOX");
      expect(selected).toBeDefined();
      const first = selected?.messages[0];
      expect(first).toBeDefined();
      const found = await flow.search({ all: true }, { uid: true });
      expect(found).toEqual(selected?.messages.map((message) => message.uid));
      const fetched = await flow.fetchOne(String(first?.uid), { source: true }, { uid: true });
      expect(fetched).not.toBe(false);
      if (fetched === false || first === undefined)
        throw new Error("source fetch did not return a message");
      expect(fetched.source).toEqual(Buffer.from(first.raw));
      expect(Buffer.from(first.raw).includes(Buffer.from("\r\n\r\n"))).toBe(true);
      expect(server.snapshot().listening).toBe(true);
    });
  });

  test("denies every backend mutation without changing the immutable snapshot", async () => {
    await withServer(corpus, async (_flow, server) => {
      const backend = server.backend();
      const before = backend.snapshot();
      const mailbox = before.mailboxes[0];
      if (mailbox === undefined) throw new Error("snapshot has no mailbox");
      const uid = mailbox.messages[0]?.uid ?? 1;
      const attempts: readonly Promise<unknown>[] = [
        backend.appendMessage("demo-principal", mailbox.protocol.id, {
          flags: [],
          internalDate: new Date(0),
          raw: new TextEncoder().encode("Subject: attack\r\n\r\nattack\r\n"),
        }),
        backend.updateFlags("demo-principal", mailbox.protocol.id, [uid], "add", ["\\Seen"]),
        backend.copyMessages("demo-principal", mailbox.protocol.id, mailbox.protocol.id, [uid]),
        backend.moveMessages("demo-principal", mailbox.protocol.id, mailbox.protocol.id, [uid]),
        backend.expungeMessages("demo-principal", mailbox.protocol.id, [uid]),
        backend.createMailbox("demo-principal", "Attack"),
        backend.deleteMailbox("demo-principal", mailbox.protocol.id),
        backend.renameMailbox("demo-principal", mailbox.protocol.id, "Attack"),
        backend.setSubscribed("demo-principal", mailbox.protocol.id, false),
      ];
      for (const attempt of attempts)
        await expect(attempt).rejects.toMatchObject({ code: "NOPERM" });
      expect(backend.snapshot()).toEqual(before);
    });
  });

  test("denies representative protocol mutations before changing state", async () => {
    await withServer(corpus, async (flow, server) => {
      await flow.mailboxOpen("INBOX", { readOnly: true });
      const before = server.backend().snapshot();
      const denied: readonly (() => Promise<unknown>)[] = [
        () => flow.messageFlagsAdd("1", ["\\Seen"], { uid: true }),
        () => flow.messageMove("1", "Archive", { uid: true }),
        () => flow.messageDelete("1", { uid: true }),
        () => flow.append("INBOX", "Subject: denied\r\n\r\ndenied\r\n"),
        () => flow.mailboxCreate("Denied"),
        () => flow.mailboxDelete("Archive"),
        () => flow.mailboxRename("Archive", "Denied"),
        () => flow.mailboxSubscribe("Archive"),
        () => flow.mailboxUnsubscribe("Archive"),
      ];
      for (const [index, operation] of denied.entries()) {
        let failure: unknown;
        let result: unknown;
        try {
          result = await operation();
        } catch (error: unknown) {
          failure = error;
        }
        if (failure === undefined)
          expect(result, `protocol mutation ${index} was accepted`).toBe(false);
        else expect(failure).toMatchObject({ serverResponseCode: "NOPERM" });
      }
      expect(server.backend().snapshot()).toEqual(before);
    });
  });

  test("rejects non-Hermes ports before creating a listener", () => {
    expect(() => createDemoImapServer({ port: 6000 })).toThrow("Hermes range");
    expect(() => createDemoImapServer({ host: "0.0.0.0" })).toThrow("only binds loopback");
  });

  test("leases only the process-safe Hermes test subset and releases idempotently", async () => {
    const first = await leaseDemoImapTestPort(6112);
    const second = await leaseDemoImapTestPort(6113);
    const third = await leaseDemoImapTestPort(6114);
    expect(activeDemoImapTestPortLeases()).toBe(3);
    await expect(leaseDemoImapTestPort()).rejects.toThrow("all demo IMAP test ports are leased");
    await first.release();
    await first.release();
    await second.release();
    await third.release();
    expect(activeDemoImapTestPortLeases()).toBe(0);
  });

  test("awaits idempotent shutdown and leaves no listener or lease", async () => {
    const lease = await leaseDemoImapTestPort(6112);
    const server = createDemoImapServer({ corpus, port: lease.port, releasePort: lease.release });
    await server.start();
    await server.close();
    await server.close();
    expect(server.snapshot()).toMatchObject({ listening: false, activeListeners: 0 });
    expect(activeDemoImapTestPortLeases()).toBe(0);
    await expect(server.start()).rejects.toThrow("closed");
  });

  test("serializes concurrent starts and owns close during start", async () => {
    const lease = await leaseDemoImapTestPort(6112);
    const server = createDemoImapServer({ corpus, port: lease.port, releasePort: lease.release });
    const firstStart = server.start();
    const secondStart = server.start();
    expect(secondStart).toBe(firstStart);
    await Promise.all([firstStart, secondStart]);
    expect(server.snapshot()).toMatchObject({ listening: true, activeListeners: 1 });
    await server.close();

    const closeLease = await leaseDemoImapTestPort(6112);
    const closingServer = createDemoImapServer({
      corpus,
      port: closeLease.port,
      releasePort: closeLease.release,
    });
    const delayedStart = closingServer.start();
    const closeDuringStart = closingServer.close();
    await expect(delayedStart).resolves.toBeUndefined();
    await expect(closeDuringStart).resolves.toBeUndefined();
    expect(closingServer.snapshot()).toMatchObject({ listening: false, activeListeners: 0 });
    await expect(closingServer.start()).rejects.toThrow("closed");
  });

  test("makes bind failure terminal and releases the lease before retry", async () => {
    const lease = await leaseDemoImapTestPort(6112);
    const blocker = await occupyPort(lease.port);
    const server = createDemoImapServer({ corpus, port: lease.port, releasePort: lease.release });
    await expect(server.start()).rejects.toBeTruthy();
    expect(activeDemoImapTestPortLeases()).toBe(0);
    await expect(server.start()).rejects.toBeTruthy();
    await expect(server.close()).rejects.toBeTruthy();
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );
    expect(server.snapshot()).toMatchObject({ listening: false, activeListeners: 0 });
  });

  test("preserves one release failure across repeated close and start attempts", async () => {
    let releaseCalls = 0;
    const server = createDemoImapServer({
      corpus,
      port: 6112,
      releasePort: () => {
        releaseCalls += 1;
        throw new Error("release failed");
      },
    });
    await expect(server.close()).rejects.toThrow("release failed");
    await expect(server.close()).rejects.toThrow("release failed");
    await expect(server.start()).rejects.toThrow("release failed");
    expect(releaseCalls).toBe(1);
  });

  test("stops a half-open connection before releasing listener authority", async () => {
    const lease = await leaseDemoImapTestPort(6112);
    const server = createDemoImapServer({ corpus, port: lease.port, releasePort: lease.release });
    await server.start();
    const socket = createConnection({ host: server.host, port: server.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await server.close();
    await closed;
    expect(server.snapshot()).toMatchObject({ listening: false, activeListeners: 0 });
  });
});
