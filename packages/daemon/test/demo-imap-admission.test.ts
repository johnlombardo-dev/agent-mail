import { describe, expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  createDemoImapServer,
  DEMO_IMAP_ADMISSION_LIMITS,
  leaseDemoImapTestPort,
  type DemoImapMailboxInput,
} from "../src/demo/imap";

const commandProfileChild = join(import.meta.dir, "helpers/demo-imap-command-profile-child.ts");

type WireClient = Readonly<{
  readonly socket: Socket;
  readonly transcript: () => string;
  readonly reset: () => void;
  readonly closed: () => boolean;
  readonly failure: () => Error | null;
}>;

async function waitFor(
  predicate: () => boolean,
  message: string,
  milliseconds = 2_000,
): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(2);
  }
}

async function connectClient(
  server: ReturnType<typeof createDemoImapServer>,
): Promise<WireClient> {
  const socket = createConnection({ host: server.host, port: server.port });
  let transcript = "";
  let closed = false;
  let failure: Error | null = null;
  socket.on("data", (chunk) => {
    transcript += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  });
  socket.on("error", (error) => {
    failure = error;
  });
  socket.on("close", () => {
    closed = true;
  });
  const client: WireClient = Object.freeze({
    socket,
    transcript: () => transcript,
    reset: () => {
      transcript = "";
    },
    closed: () => closed,
    failure: () => failure,
  });
  await waitFor(
    () => transcript.includes("Agent Mail demo ready") || failure !== null,
    "demo IMAP greeting did not arrive",
  );
  if (failure !== null) throw failure;
  client.reset();
  return client;
}

async function createRunningServer(): Promise<Readonly<{
  readonly server: ReturnType<typeof createDemoImapServer>;
  readonly leasePort: ReturnType<typeof leaseDemoImapTestPort>["port"];
}>> {
  const lease = leaseDemoImapTestPort();
  const server = createDemoImapServer({ port: lease.port, releasePort: lease.release });
  await server.start();
  return Object.freeze({ server, leasePort: lease.port });
}

function paddedNoop(tag: string, bytes: number): string {
  const prefix = `${tag} NOOP`;
  if (prefix.length > bytes) throw new Error("NOOP prefix exceeds requested line length");
  return prefix + " ".repeat(bytes - prefix.length);
}

describe("demo IMAP bounded byte admission", () => {
  test("admits line boundary-1 and boundary across partial frames, then rejects boundary+1", async () => {
    const { server } = await createRunningServer();
    const client = await connectClient(server);
    try {
      const below = paddedNoop("L1", DEMO_IMAP_ADMISSION_LIMITS.maxLineBytes - 1);
      client.socket.write(`${below}\r\n`);
      await waitFor(() => client.transcript().includes("L1 OK NOOP completed"), "boundary-1 line stalled");

      client.reset();
      const boundary = paddedNoop("L2", DEMO_IMAP_ADMISSION_LIMITS.maxLineBytes);
      const framed = Buffer.from(`${boundary}\r\n`);
      client.socket.write(framed.subarray(0, framed.length - 1));
      await Bun.sleep(5);
      expect(client.transcript()).not.toContain("L2 OK");
      client.socket.write(framed.subarray(framed.length - 1));
      await waitFor(() => client.transcript().includes("L2 OK NOOP completed"), "boundary line stalled");

      client.socket.write(Buffer.alloc(DEMO_IMAP_ADMISSION_LIMITS.maxLineBytes + 1, 0x78));
      await waitFor(client.closed, "overlong unterminated pre-auth line stayed open");
      expect(client.failure()).toBeNull();
      expect(server.snapshot().commands).toHaveLength(2);
    } finally {
      client.socket.destroy();
      await server.close();
    }
    expect(server.snapshot()).toMatchObject({
      listening: false,
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      activeTestLeases: 0,
    });
  });

  test("discards literal boundary-1 and boundary without materializing, then rejects boundary+1", async () => {
    const { server } = await createRunningServer();
    const client = await connectClient(server);
    try {
      const cases: readonly Readonly<{ readonly tag: string; readonly bytes: number }>[] = [
        { tag: "B1", bytes: DEMO_IMAP_ADMISSION_LIMITS.maxLiteralBytes - 1 },
        { tag: "B2", bytes: DEMO_IMAP_ADMISSION_LIMITS.maxLiteralBytes },
      ];
      for (const { tag, bytes } of cases) {
        client.reset();
        client.socket.write(`${tag} APPEND INBOX {${bytes}}\r\n`);
        await waitFor(() => client.transcript().includes("+ literal accepted"), `${tag} continuation stalled`);
        const literal = Buffer.alloc(bytes, 0x61);
        client.socket.write(literal.subarray(0, Math.floor(bytes / 2)));
        client.socket.write(literal.subarray(Math.floor(bytes / 2)));
        client.socket.write("\r");
        await Bun.sleep(2);
        client.socket.write("\n");
        await waitFor(
          () => client.transcript().includes(`${tag} BAD [CANNOT] Literal commands are unsupported`),
          `${tag} literal completion stalled`,
        );
        client.reset();
        client.socket.write(`${tag}N NOOP\r\n`);
        await waitFor(() => client.transcript().includes(`${tag}N OK NOOP completed`), `${tag} session became unusable`);
      }

      client.reset();
      client.socket.write(
        `B3 APPEND INBOX {${DEMO_IMAP_ADMISSION_LIMITS.maxLiteralBytes + 1}}\r\n`,
      );
      await waitFor(client.closed, "over-budget literal declaration stayed open");
      expect(client.transcript()).not.toContain("+ literal accepted");
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  test("caps outstanding pre-auth pipeline work at boundary-1, boundary, and boundary+1", async () => {
    const { server } = await createRunningServer();
    const client = await connectClient(server);
    try {
      for (let index = 0; index < DEMO_IMAP_ADMISSION_LIMITS.maxQueuedCommands; index += 1) {
        server.scheduleFault({ kind: "latency", command: "NOOP", milliseconds: 2_000 });
      }
      const below = Array.from(
        { length: DEMO_IMAP_ADMISSION_LIMITS.maxQueuedCommands - 1 },
        (_, index) => `Q${index} NOOP\r\n`,
      ).join("");
      client.socket.write(below);
      await waitFor(
        () => server.snapshot().commands.length === DEMO_IMAP_ADMISSION_LIMITS.maxQueuedCommands - 1,
        "boundary-1 pipeline was not admitted",
      );
      expect(client.closed()).toBe(false);

      client.socket.write("QB NOOP\r\n");
      await waitFor(
        () => server.snapshot().commands.length === DEMO_IMAP_ADMISSION_LIMITS.maxQueuedCommands,
        "boundary pipeline was not admitted",
      );
      expect(client.closed()).toBe(false);

      client.socket.write("QX NOOP\r\n");
      await waitFor(client.closed, "boundary+1 pipeline stayed open");
      await waitFor(() => server.snapshot().pendingTimers === 0, "closed session retained timers");
      expect(server.snapshot().commands).toHaveLength(
        DEMO_IMAP_ADMISSION_LIMITS.maxQueuedCommands,
      );
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  test("enforces total retained bytes at boundary-1, boundary, and boundary+1", async () => {
    const { server } = await createRunningServer();
    const client = await connectClient(server);
    try {
      const heldCommands = 5;
      for (let index = 0; index < heldCommands; index += 1) {
        server.scheduleFault({ kind: "latency", command: "NOOP", milliseconds: 2_000 });
      }
      client.socket.write(
        Array.from(
          { length: heldCommands },
          (_, index) => `${paddedNoop(`T${index}`, DEMO_IMAP_ADMISSION_LIMITS.maxLineBytes)}\r\n`,
        ).join(""),
      );
      await waitFor(
        () => server.snapshot().commands.length === heldCommands,
        "retained-byte setup commands stalled",
      );

      const remaining =
        DEMO_IMAP_ADMISSION_LIMITS.maxBufferedBytes -
        heldCommands * DEMO_IMAP_ADMISSION_LIMITS.maxLineBytes;
      client.socket.write(Buffer.alloc(remaining - 1, 0x78));
      await Bun.sleep(5);
      expect(client.closed()).toBe(false);
      client.socket.write("x");
      await Bun.sleep(5);
      expect(client.closed()).toBe(false);
      client.socket.write("x");
      await waitFor(client.closed, "total buffered boundary+1 stayed open");
      await waitFor(() => server.snapshot().pendingTimers === 0, "byte rejection retained timers");
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  test("rejects a very large unterminated frame before command materialization", async () => {
    const { server } = await createRunningServer();
    const client = await connectClient(server);
    try {
      client.socket.write(Buffer.alloc(DEMO_IMAP_ADMISSION_LIMITS.maxBufferedBytes + 1, 0x78));
      await waitFor(client.closed, "large unterminated frame stayed open");
      expect(server.snapshot().commands).toEqual([]);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  test("cleans a session destroyed during a partial command and immediately rebinds", async () => {
    const { server, leasePort } = await createRunningServer();
    const client = await connectClient(server);
    client.socket.write("P1 NO");
    client.socket.destroy();
    await waitFor(() => server.snapshot().activeSessions === 0, "destroyed partial session survived");
    await server.close();

    const reboundLease = leaseDemoImapTestPort({ preferredPort: leasePort });
    const rebound = createDemoImapServer({
      port: reboundLease.port,
      releasePort: reboundLease.release,
    });
    await rebound.start();
    await rebound.close();
    expect(rebound.snapshot()).toMatchObject({
      listening: false,
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      activeTestLeases: 0,
    });
  });

  test("caps global sessions before allocation and closes every admitted session", async () => {
    const { server } = await createRunningServer();
    const clients: WireClient[] = [];
    let excess: Socket | null = null;
    let excessClosed = false;
    try {
      for (let index = 0; index < DEMO_IMAP_ADMISSION_LIMITS.maxSessions; index += 1) {
        clients.push(await connectClient(server));
      }
      excess = createConnection({ host: server.host, port: server.port });
      excess.on("error", () => undefined);
      excess.on("close", () => {
        excessClosed = true;
      });
      await waitFor(() => excessClosed, "session ceiling did not reject the excess connection");
      expect(server.snapshot().activeSessions).toBe(DEMO_IMAP_ADMISSION_LIMITS.maxSessions);
    } finally {
      excess?.destroy();
      for (const client of clients) client.socket.destroy();
      await server.close();
    }
    expect(server.snapshot()).toMatchObject({
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      activeTestLeases: 0,
    });
  });

  test("enforces fixed pre-auth and non-resetting partial-frame deadlines", async () => {
    const { server } = await createRunningServer();
    const unauthenticated = await connectClient(server);
    try {
      await waitFor(
        unauthenticated.closed,
        "pre-authentication deadline left a slow client open",
        DEMO_IMAP_ADMISSION_LIMITS.preAuthDeadlineMilliseconds + 1_000,
      );
      await waitFor(() => server.snapshot().pendingTimers === 0, "pre-auth timer survived close");

      const partial = await connectClient(server);
      try {
        partial.socket.write('A1 LOGIN "demo-user" "demo-pass"\r\n');
        await waitFor(
          () => partial.transcript().includes("A1 OK"),
          "deadline proof login did not complete",
        );
        partial.reset();
        partial.socket.write("P");
        await Bun.sleep(100);
        partial.socket.write("1");
        await Bun.sleep(100);
        partial.socket.write(" ");
        await waitFor(
          partial.closed,
          "partial-frame deadline was reset by slowloris bytes",
          DEMO_IMAP_ADMISSION_LIMITS.partialFrameDeadlineMilliseconds + 500,
        );
      } finally {
        partial.socket.destroy();
      }
    } finally {
      unauthenticated.socket.destroy();
      await server.close();
    }
    expect(server.snapshot()).toMatchObject({
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      activeTestLeases: 0,
    });
  });

  test("cancels a blocked writer within the fixed output budget", async () => {
    const lease = leaseDemoImapTestPort();
    const inbox: DemoImapMailboxInput = Object.freeze({
      path: "INBOX",
      selectable: true,
      uidValidity: Object.freeze({ kind: "known", value: 1 }),
      uidNext: Object.freeze({ kind: "known", value: 2 }),
      highestModseq: Object.freeze({ kind: "known", value: 1n }),
      messages: Object.freeze([
        Object.freeze({
          uid: 1,
          flags: Object.freeze([]),
          modseq: 1n,
          internalDate: "2026-08-17T12:00:00.000Z",
          subject: "Backpressure proof",
          from: "sender@example.test",
          to: "person@example.test",
          raw: `Subject: Backpressure proof\r\n\r\n${"x".repeat(48 * 1024)}`,
        }),
      ]),
    });
    const server = createDemoImapServer({
      port: lease.port,
      releasePort: lease.release,
      mailboxes: Object.freeze([inbox]),
    });
    await server.start();
    const client = await connectClient(server);
    try {
      client.socket.write('A1 LOGIN "demo-user" "demo-pass"\r\nA2 SELECT "INBOX"\r\n');
      await waitFor(
        () => client.transcript().includes("A2 OK [READ-WRITE]"),
        "backpressure proof setup stalled",
      );
      client.reset();
      client.socket.pause();
      client.socket.write(
        Array.from(
          { length: DEMO_IMAP_ADMISSION_LIMITS.maxQueuedCommands },
          (_, index) => `F${index} UID FETCH 1 (BODY.PEEK[])\r\n`,
        ).join(""),
      );
      await waitFor(
        () => server.snapshot().activeSessions === 0,
        "blocked writer exceeded its cancellation deadline",
        2_000,
      );
      await waitFor(() => server.snapshot().pendingTimers === 0, "blocked writer retained a timer");
    } finally {
      client.socket.destroy();
      await server.close();
    }
    expect(server.snapshot()).toMatchObject({
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      activeTestLeases: 0,
    });
  });

  test("bounds 6000-command diagnostics and RSS in an isolated process", async () => {
    const child = Bun.spawn([process.execPath, commandProfileChild], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const profile: unknown = JSON.parse(stdout);
    expect(profile).toMatchObject({
      kind: "profile",
      responses: 6_000,
      retainedCommands: DEMO_IMAP_ADMISSION_LIMITS.maxCommandHistory,
      activeSessions: 0,
      activeSockets: 0,
      activeListeners: 0,
      pendingTimers: 0,
      activeTestLeases: 0,
    });
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
      throw new Error("command profile result is not an object");
    }
    expect(Reflect.get(profile, "rssGrowthBytes")).toBeLessThan(64 * 1024 * 1024);
  });
});
