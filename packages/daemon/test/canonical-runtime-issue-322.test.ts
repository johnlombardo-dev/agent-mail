import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type CanonicalHttpListenerFactory,
} from "../src/runtime";

const roots: string[] = [];
const servers: DemoImapServer[] = [];

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

async function leasedHttpListener(port: 6113 | 6114): Promise<CanonicalHttpListenerFactory> {
  const lease = await leaseDemoImapTestPort(port);
  return async (input) => {
    const listener = await createLoopbackHttpListener({ ...input, port: lease.port });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      baseUrl: listener.baseUrl,
      activeConnections: listener.activeConnections,
      close: () => {
        closePromise ??= (async () => {
          await listener.close();
          await lease.release();
        })();
        return closePromise;
      },
    });
  };
}

function corpus() {
  return buildCorpus({
    scenarioVersion: CORPUS_VERSION,
    seed: "canonical-runtime-322",
    size: 1,
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

afterEach(async () => {
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
    const runtime = createCanonicalDaemonRuntime({
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
      listenerFactory: await leasedHttpListener(6113),
    });

    const firstStart = runtime.start();
    expect(runtime.start()).toBe(firstStart);
    const ready = await firstStart;
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
    expect((await raw.arrayBuffer()).byteLength).toBeGreaterThan(0);
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
    const runtime = createCanonicalDaemonRuntime({
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
      listenerFactory: await leasedHttpListener(6114),
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
  }, 20_000);
});
