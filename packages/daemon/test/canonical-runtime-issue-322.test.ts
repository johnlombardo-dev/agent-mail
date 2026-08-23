import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { ImapFlow } from "imapflow";
import type { HttpCredentialResolution } from "../src/http";
import { CORPUS_VERSION, buildCorpus } from "../src/demo/corpus";
import {
  DEMO_IMAP_PASSWORD,
  DEMO_IMAP_USERNAME,
  activeDemoImapTestPortLeases,
  createDemoImapServer,
  leaseDemoImapTestPort,
  type DemoImapServer,
} from "../src/demo/imap";
import {
  createCanonicalDaemonRuntime,
  createLoopbackHttpListener,
  type CanonicalDaemonRuntime,
  type CanonicalDaemonRuntimeOptions,
  type CanonicalHttpListenerFactory,
} from "../src/runtime";

const roots: string[] = [];
const servers: DemoImapServer[] = [];
const runtimes: CanonicalDaemonRuntime[] = [];

type SourceFault = "list" | "select" | "status" | "search" | "fetch" | "stage" | "parse" | "promote";
type ReleaseCounter = { count: number };

const scopes = Object.freeze([
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

function authenticate(token: string): HttpCredentialResolution {
  return token === "runtime-322"
    ? {
        kind: "authenticated",
        principal: { subject: "operator:runtime-322", scopes },
      }
    : { kind: "invalid" };
}

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-runtime-322-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

function configuration(root: string) {
  return {
    privateRoot: root,
    ports: {
      productionService: 6110,
      mockImap: 6111,
      apiIntegration: 6112,
      browserPreview: 6113,
      destructiveLiveHarness: 6117,
    },
  } as const;
}

function leasedHttpListener(port: 6113 | 6114): CanonicalHttpListenerFactory {
  return async (input) => {
    const lease = await leaseDemoImapTestPort(port);
    let listener;
    try {
      listener = await createLoopbackHttpListener({ ...input, port: lease.port });
    } catch (error: unknown) {
      await lease.release();
      throw error;
    }
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      baseUrl: listener.baseUrl,
      activeConnections: listener.activeConnections,
      close: () => {
        closePromise ??= (async () => {
          try {
            await listener.close();
          } finally {
            await lease.release();
          }
        })();
        return closePromise;
      },
    });
  };
}

function trackedRuntime(options: CanonicalDaemonRuntimeOptions): CanonicalDaemonRuntime {
  const runtime = createCanonicalDaemonRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

function corpus(size = 1) {
  return buildCorpus({
    scenarioVersion: CORPUS_VERSION,
    seed: "canonical-runtime-322",
    size,
    scenarioMix: {
      ordinary: 1,
      transactional: 1,
      "mailing-list": 1,
      newsletter: 1,
      automated: 1,
      spam: 1,
    },
  });
}

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

async function startDemoServer(): Promise<DemoImapServer> {
  const lease = await leaseDemoImapTestPort(6112);
  const server = createDemoImapServer({
    corpus: corpus(),
    port: lease.port,
    releasePort: lease.release,
  });
  servers.push(server);
  await server.start();
  return server;
}

function injectedFailure(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    category: "permanent",
    code: "RUNTIME_TEST_FAILURE",
    safeMessage: "Injected canonical source failure.",
    secret: "must-not-leak",
  });
}

function faultedClient(flow: ImapFlow, fault: SourceFault): ImapFlow {
  const malformed = Buffer.from("From: sender@example.test\r\nBroken header\r\n\r\nbody\r\n");
  return new Proxy(flow, {
    get(target, property) {
      if (property === "mailbox" && fault === "status") return false;
      const value = Reflect.get(target, property, target);
      if (property === "list" && fault === "list") return async () => Promise.reject(injectedFailure());
      if (property === "getMailboxLock" && fault === "select") {
        return async () => Promise.reject(injectedFailure());
      }
      if (property === "search" && fault === "search") {
        return async () => Promise.reject(injectedFailure());
      }
      if (property === "fetchAll" && fault === "fetch") {
        return async () => Promise.reject(injectedFailure());
      }
      if (property === "fetchOne" && fault === "parse" && typeof value === "function") {
        return async (...arguments_: unknown[]) => {
          const result = await value.apply(target, arguments_);
          return result === false ? false : { ...result, size: malformed.byteLength };
        };
      }
      if (property === "download" && fault === "parse") {
        return async () => ({
          meta: { expectedSize: malformed.byteLength },
          content: Readable.from([malformed]),
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function sourceFor(
  server: DemoImapServer,
  root: string,
  counter: ReleaseCounter,
  fault?: SourceFault,
  failRelease = false,
) {
  return {
    acquire: async () => {
      const flow = createFlow(server);
      await flow.connect();
      try {
        if (fault === "stage") await chmod(join(root, "runtime", "staging"), 0o000);
        if (fault === "promote") {
          const database = new Database(join(root, "data", "archive.sqlite"), { strict: true });
          try {
            database.exec(
              "CREATE TRIGGER runtime_322_fail_promotion BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'runtime-322-promotion-failure'); END;",
            );
          } finally {
            database.close();
          }
        }
        return {
          client: fault === undefined || fault === "stage" || fault === "promote" ? flow : faultedClient(flow, fault),
          release: async () => {
            counter.count += 1;
            if (fault === "stage") await chmod(join(root, "runtime", "staging"), 0o700);
            if (flow.usable) await flow.logout().catch(() => undefined);
            flow.close();
            if (failRelease) throw injectedFailure();
          },
        };
      } catch (error: unknown) {
        if (flow.usable) await flow.logout().catch(() => undefined);
        flow.close();
        throw error;
      }
    },
  };
}

function messageCount(root: string): number {
  const database = new Database(join(root, "data", "archive.sqlite"), {
    create: false,
    readonly: true,
    strict: true,
  });
  try {
    return database.query<Readonly<{ count: number }>, []>("SELECT COUNT(*) AS count FROM messages;").get()?.count ?? -1;
  } finally {
    database.close();
  }
}

function retainedSyncRows(root: string): Readonly<{
  readonly messages: number;
  readonly placements: number;
  readonly checkpoints: number;
}> {
  const database = new Database(join(root, "data", "archive.sqlite"), {
    create: false,
    readonly: true,
    strict: true,
  });
  try {
    const count = (table: "messages" | "remote_placements" | "mailbox_checkpoints"): number =>
      database.query<Readonly<{ count: number }>, []>(`SELECT COUNT(*) AS count FROM ${table};`).get()
        ?.count ?? -1;
    return Object.freeze({
      messages: count("messages"),
      placements: count("remote_placements"),
      checkpoints: count("mailbox_checkpoints"),
    });
  } finally {
    database.close();
  }
}

async function stagingEntries(root: string): Promise<readonly string[]> {
  return readdir(join(root, "runtime", "staging")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
}

async function closeTcpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close().catch(() => undefined);
  while (servers.length > 0) await servers.pop()?.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  expect(activeDemoImapTestPortLeases()).toBe(0);
});

describe("canonical read-only daemon runtime #322", () => {
  test("syncs signed SmartIMAP through ImapFlow, real storage, HTTP search, and message retrieval", async () => {
    const root = await privateRoot();
    const imapLease = await leaseDemoImapTestPort(6112);
    const server = createDemoImapServer({
      corpus: corpus(),
      port: imapLease.port,
      releasePort: imapLease.release,
    });
    servers.push(server);
    await server.start();
    const before = server.backend().snapshot();
    let releases = 0;
    const runtime = trackedRuntime({
      configuration: configuration(root),
      accountId: "account:runtime-322",
      source: {
        acquire: async () => {
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
          await flow.connect();
          return {
            client: flow,
            release: async () => {
              releases += 1;
              if (flow.usable) await flow.logout().catch(() => undefined);
              flow.close();
            },
          };
        },
      },
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: leasedHttpListener(6113),
    });

    const firstStart = runtime.start();
    expect(runtime.start()).toBe(firstStart);
    const ready = await firstStart;
    expect(runtime.start()).toBe(firstStart);
    expect(runtime.snapshot()).toMatchObject({ state: "ready", ready: true });
    expect(ready.checkpoint.completedMessages).toBeGreaterThan(0);

    const search = await fetch(`${ready.baseUrl}/v1/messages/search`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-322", "content-type": "application/json" },
      body: JSON.stringify({ query: "Synthetic", filters: {}, limit: 20 }),
    });
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ items: [{ messageId: ready.observedSource.messageId }] });
    const message = await fetch(`${ready.baseUrl}/v1/messages/${ready.observedSource.messageId}`, {
      headers: { authorization: "Bearer runtime-322" },
    });
    expect(message.status).toBe(200);
    expect(await message.json()).toMatchObject({
      message: { messageId: ready.observedSource.messageId },
    });
    const raw = await fetch(`${ready.baseUrl}/v1/messages/${ready.observedSource.messageId}/raw`, {
      headers: { authorization: "Bearer runtime-322" },
    });
    expect(raw.status).toBe(200);
    const expectedRaw = before.mailboxes.flatMap((mailbox) => mailbox.messages)[0]?.raw;
    expect(expectedRaw).toBeDefined();
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(expectedRaw);
    expect(server.backend().snapshot()).toEqual(before);

    const firstClose = runtime.close();
    expect(runtime.close()).toBe(firstClose);
    await firstClose;
    expect(runtime.snapshot()).toMatchObject({
      state: "closed",
      ready: false,
      sourceReleaseCount: 1,
      activeHttpConnections: 0,
    });
    expect(releases).toBe(1);
  }, 20_000);

  test("fails closed on injected source denial with no promotion or secret diagnostic", async () => {
    const root = await privateRoot();
    const runtime = trackedRuntime({
      configuration: configuration(root),
      accountId: "account:runtime-denial-322",
      source: {
        acquire: async () => {
          throw {
            category: "authentication",
            code: "AUTHENTICATIONFAILED",
            password: "must-not-leak",
          };
        },
      },
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: leasedHttpListener(6114),
    });
    await expect(runtime.start()).rejects.toThrow("Canonical read-only initial sync failed.");
    expect(JSON.stringify(runtime.snapshot())).not.toContain("must-not-leak");
    expect(runtime.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      sourceReleaseCount: 0,
      activeHttpConnections: 0,
    });
    await runtime.close();
    expect(messageCount(root)).toBe(0);

    const invalidRoot = await privateRoot();
    let invalidSessionReleases = 0;
    const invalidSession = trackedRuntime({
      configuration: configuration(invalidRoot),
      accountId: "account:runtime-invalid-session-322",
      source: {
        acquire: async () => ({
          client: {},
          release: async () => {
            invalidSessionReleases += 1;
          },
        }),
      },
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: leasedHttpListener(6113),
    });
    await expect(invalidSession.start()).rejects.toThrow("initial sync failed");
    await invalidSession.close();
    expect(invalidSessionReleases).toBe(1);
    expect(invalidSession.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      sourceReleaseCount: 0,
      activeHttpConnections: 0,
    });
    expect(messageCount(invalidRoot)).toBe(0);
  }, 20_000);

  test("settles ordinary source-boundary failures without promotion, fallback, or leaked resources", async () => {
    const faults: readonly SourceFault[] = [
      "list",
      "select",
      "status",
      "search",
      "fetch",
      "stage",
      "parse",
      "promote",
    ];
    for (const fault of faults) {
      const root = await privateRoot();
      const server = await startDemoServer();
      const before = server.backend().snapshot();
      const releases: ReleaseCounter = { count: 0 };
      const runtime = trackedRuntime({
        configuration: configuration(root),
        accountId: `account:runtime-${fault}-322`,
        source: sourceFor(server, root, releases, fault),
        authenticate,
        readinessAuthorization: "Bearer runtime-322",
        listenerFactory: leasedHttpListener(6113),
      });

      await expect(runtime.start(), fault).rejects.toThrow("Canonical read-only initial sync failed.");
      expect(JSON.stringify(runtime.snapshot()), fault).not.toContain("must-not-leak");
      await runtime.close();
      expect(runtime.snapshot(), fault).toMatchObject({
        state: "failed",
        ready: false,
        sourceReleaseCount: 1,
        activeHttpConnections: 0,
      });
      expect(releases.count, fault).toBe(1);
      expect(messageCount(root), fault).toBe(0);
      expect(await stagingEntries(root), fault).toEqual([]);
      expect(server.backend().snapshot(), fault).toEqual(before);
      await server.close();
    }
  }, 60_000);

  test("rolls back the first committed message when the signed source denies the second download", async () => {
    const root = await privateRoot();
    const lease = await leaseDemoImapTestPort(6112);
    const server = createDemoImapServer({
      corpus: corpus(2),
      port: lease.port,
      releasePort: lease.release,
    });
    servers.push(server);
    await server.start();
    const before = server.backend().snapshot();
    let releases = 0;
    let downloads = 0;
    const runtime = trackedRuntime({
      configuration: configuration(root),
      accountId: "account:runtime-rollback-322",
      source: {
        acquire: async () => {
          const flow = createFlow(server);
          await flow.connect();
          const client = new Proxy(flow, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (property === "download" && typeof value === "function") {
                return (...arguments_: unknown[]) => {
                  downloads += 1;
                  if (downloads === 2) return Promise.reject(injectedFailure());
                  return value.apply(target, arguments_);
                };
              }
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return {
            client,
            release: async () => {
              releases += 1;
              if (flow.usable) await flow.logout().catch(() => undefined);
              flow.close();
            },
          };
        },
      },
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: leasedHttpListener(6114),
    });

    await expect(runtime.start()).rejects.toThrow("Canonical read-only initial sync failed.");
    await runtime.close();
    expect(downloads).toBe(2);
    expect(releases).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      sourceReleaseCount: 1,
      activeHttpConnections: 0,
    });
    expect(retainedSyncRows(root)).toEqual({ messages: 0, placements: 0, checkpoints: 0 });
    expect(await readdir(join(root, "blobs"))).toEqual([]);
    expect(await stagingEntries(root)).toEqual([]);
    expect(server.backend().snapshot()).toEqual(before);
  }, 20_000);

  test("fails infrastructure and readiness acquisition with stable ownership truth", async () => {
    const databaseRoot = await privateRoot();
    await mkdir(join(databaseRoot, "data"), { mode: 0o700 });
    await mkdir(join(databaseRoot, "data", "archive.sqlite"), { mode: 0o700 });
    let databaseSourceAcquisitions = 0;
    const databaseFailure = trackedRuntime({
      configuration: configuration(databaseRoot),
      accountId: "account:runtime-database-322",
      source: {
        acquire: async () => {
          databaseSourceAcquisitions += 1;
          throw injectedFailure();
        },
      },
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: leasedHttpListener(6113),
    });
    await expect(databaseFailure.start()).rejects.toThrow("database could not be opened");
    await databaseFailure.close();
    expect(databaseSourceAcquisitions).toBe(0);
    expect(databaseFailure.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      baseUrl: null,
      sourceReleaseCount: 0,
    });

    const collisionRoot = await privateRoot();
    const blocker = createServer();
    blocker.listen(6113, "127.0.0.1");
    await once(blocker, "listening");
    let collisionSourceAcquisitions = 0;
    const collision = trackedRuntime({
      configuration: configuration(collisionRoot),
      accountId: "account:runtime-collision-322",
      source: {
        acquire: async () => {
          collisionSourceAcquisitions += 1;
          throw injectedFailure();
        },
      },
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: leasedHttpListener(6113),
    });
    await expect(collision.start()).rejects.toThrow("listener could not start");
    await collision.close();
    await closeTcpServer(blocker);
    expect(collisionSourceAcquisitions).toBe(0);
    expect(collision.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      sourceReleaseCount: 0,
      activeHttpConnections: 0,
    });

    const readinessRoot = await privateRoot();
    const readinessServer = await startDemoServer();
    const readinessBefore = readinessServer.backend().snapshot();
    const readinessReleases: ReleaseCounter = { count: 0 };
    const readinessFailure = trackedRuntime({
      configuration: configuration(readinessRoot),
      accountId: "account:runtime-readiness-322",
      source: sourceFor(readinessServer, readinessRoot, readinessReleases),
      authenticate,
      readinessAuthorization: "Bearer rejected-runtime-322",
      listenerFactory: leasedHttpListener(6114),
    });
    await expect(readinessFailure.start()).rejects.toThrow("readiness probe was rejected");
    await readinessFailure.close();
    expect(readinessFailure.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      sourceReleaseCount: 1,
      activeHttpConnections: 0,
    });
    expect(readinessReleases.count).toBe(1);
    expect(retainedSyncRows(readinessRoot)).toEqual({
      messages: 0,
      placements: 0,
      checkpoints: 0,
    });
    expect(await readdir(join(readinessRoot, "blobs"))).toEqual([]);
    expect(await stagingEntries(readinessRoot)).toEqual([]);
    expect(readinessServer.backend().snapshot()).toEqual(readinessBefore);
  }, 30_000);

  test("close preempts listener and source acquisition and remains one idempotent barrier", async () => {
    const listenerRoot = await privateRoot();
    let enterListener = () => undefined;
    const listenerEntered = new Promise<void>((resolve) => {
      enterListener = resolve;
    });
    const listenerRuntime = trackedRuntime({
      configuration: configuration(listenerRoot),
      accountId: "account:runtime-listener-close-322",
      source: { acquire: async () => Promise.reject(injectedFailure()) },
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: async (input) => {
        enterListener();
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(input.signal.reason);
          if (input.signal.aborted) abort();
          else input.signal.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const listenerStart = listenerRuntime.start();
    await listenerEntered;
    const listenerClose = listenerRuntime.close();
    expect(listenerRuntime.close()).toBe(listenerClose);
    await expect(listenerStart).rejects.toThrow("listener could not start");
    await expect(listenerClose).resolves.toBeUndefined();
    expect(listenerRuntime.snapshot()).toMatchObject({
      state: "closed",
      ready: false,
      baseUrl: null,
      sourceReleaseCount: 0,
    });

    const sourceRoot = await privateRoot();
    let enterSource = () => undefined;
    const sourceEntered = new Promise<void>((resolve) => {
      enterSource = resolve;
    });
    const sourceRuntime = trackedRuntime({
      configuration: configuration(sourceRoot),
      accountId: "account:runtime-source-close-322",
      source: {
        acquire: async ({ signal }) => {
          enterSource();
          return new Promise<never>((_resolve, reject) => {
            const abort = (): void => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        },
      },
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: leasedHttpListener(6113),
    });
    const sourceStart = sourceRuntime.start();
    await sourceEntered;
    const sourceClose = sourceRuntime.close();
    expect(sourceRuntime.close()).toBe(sourceClose);
    await expect(sourceStart).rejects.toThrow("initial sync failed");
    await expect(sourceClose).resolves.toBeUndefined();
    expect(sourceRuntime.snapshot()).toMatchObject({
      state: "closed",
      ready: false,
      sourceReleaseCount: 0,
      activeHttpConnections: 0,
    });
  }, 20_000);

  test("surfaces a source finalizer failure after releasing its listener and session once", async () => {
    const root = await privateRoot();
    const server = await startDemoServer();
    const before = server.backend().snapshot();
    const releases: ReleaseCounter = { count: 0 };
    const runtime = trackedRuntime({
      configuration: configuration(root),
      accountId: "account:runtime-finalizer-322",
      source: sourceFor(server, root, releases, undefined, true),
      authenticate,
      readinessAuthorization: "Bearer runtime-322",
      listenerFactory: leasedHttpListener(6114),
    });
    await runtime.start();
    const close = runtime.close();
    expect(runtime.close()).toBe(close);
    await expect(close).rejects.toThrow("cleanup did not fully settle");
    expect(runtime.snapshot()).toMatchObject({
      state: "failed",
      ready: false,
      diagnostic: { code: "runtime.cleanup" },
      sourceReleaseCount: 1,
      activeHttpConnections: 0,
    });
    expect(releases.count).toBe(1);
    expect(server.backend().snapshot()).toEqual(before);
  }, 20_000);
});
