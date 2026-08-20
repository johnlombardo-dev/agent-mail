import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPromise } from "xstate";
import { afterEach, describe, expect, test } from "bun:test";
import {
  messageNotFoundErrorDefinition,
  messageResponseSchema,
  searchResponseSchema,
  syncStatusResponseSchema,
  threadResponseSchema,
  searchOperation,
} from "@agent-mail/contracts";
import { Database } from "bun:sqlite";
import { createCliClient } from "../../cli/src/client";
import { executeCommand, type CommandResultV1, type CommandSink } from "../../cli/src/command-outcome";
import { runSearchCommand } from "../../cli/src/search-command";
import { executeMessageShow } from "../../cli/src/message-show";
import { executeThreadShow } from "../../cli/src/thread-show-command";
import { executeRawContentCommand } from "../../cli/src/raw-content-command";
import { runStatusCommand } from "../../cli/src/status-command";
import { runSyncControlCommand } from "../../cli/src/sync-control";
import { runMigrations, type Migration } from "../../storage/src/migration-runner";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../../storage/src/migrations/0002-structured-content";
import { externalContentSearchMigration } from "../../storage/src/migrations/0003-external-content-search";
import { placementObservationMigration } from "../../storage/src/migrations/0003-placement-observation";
import { threadGraphMigration } from "../../storage/src/migrations/0008-thread-graph";
import { ThreadGraphRepository } from "../../storage/src/thread-graph-repository";
import { normalizeThreadFacts } from "../../storage/src/thread-normalizer";
import { ThreadCursorCodec } from "../../storage/src/thread-cursor";
import { createSearchCursorIntegrityCodec } from "../../storage/src/search-cursor";
import { admitHttpRequest, createHttpApp, type HttpCredentialResolution } from "../src/http";
import { createRetrievalHandlers } from "../src/retrieval-handlers";
import { createContentStreamingApp } from "../src/content-streaming";
import { createSyncHandlers } from "../src/sync-handlers";
import { createSyncControlDecisionChannel, createSyncControlService } from "../src/sync-control-service";
import { createSyncLifecycleActor, createSyncLifecycleDependencies, projectSyncStatus, type SyncLifecycleInput } from "../src/sync-statechart";
import { acquirePortLease, releasePortLease, type PortLease } from "../../../port-lease";

const accountId = "account:cli-composed-243";
const messageId = `message:${"a".repeat(64)}`;
const attachmentId = `attachment:${"b".repeat(64)}`;
const mailboxId = "mailbox:inbox";
const migrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  externalContentSearchMigration,
  { ...placementObservationMigration, version: 4 },
  { ...threadGraphMigration, version: 5 },
];
const allScopes = [
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
] as const;
const expectedOperations = [
  "messages.search",
  "messages.get",
  "threads.get",
  "messages.raw",
  "attachments.get",
  "sync.status",
  "sync.start",
  "sync.pause",
  "sync.resume",
  "sync.stop",
] as const;
const loopbackLeaseRoles = ["apiIntegration", "browserPreview"] as const;

type Fixture = Readonly<{
  readonly database: Database;
  readonly root: string;
  readonly rawBytes: Uint8Array;
  readonly attachmentBytes: Uint8Array;
  readonly threadId: string;
  readonly close: () => Promise<void>;
  readonly baseUrl: string;
  readonly actor: ReturnType<typeof createSyncLifecycleActor>;
  readonly control: ReturnType<typeof createSyncControlService>;
  readonly server: Server;
  readonly portLease: PortLease;
}>;

const fixtures: Fixture[] = [];

function auth(token: string): HttpCredentialResolution {
  if (token !== "parity") return { kind: "invalid" };
  return {
    kind: "authenticated",
    principal: { subject: "operator:cli-composed-243", scopes: allScopes },
  };
}

function requestToken(incoming: IncomingMessage): string {
  const value = incoming.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function forwardResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (response.body === null) {
    outgoing.end();
    return;
  }
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    if (!outgoing.write(chunk)) await once(outgoing, "drain");
  }
  outgoing.end();
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return new Request(`http://${incoming.headers.host ?? "127.0.0.1"}${incoming.url ?? "/"}`, {
    method: incoming.method,
    headers,
    body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
  });
}

function ingest(database: Database): string {
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  database.query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, 1);").run(accountId, mailboxId);
  database.query("INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, 1, 1, ?, ?, ?);").run(accountId, mailboxId, messageId, "2026-01-01T00:00:00.000Z", "[]");
  const hostileSubject = "subject \u202Eevil";
  database.query("INSERT INTO message_headers (message_id, ordinal, name, normalized_name, value, normalized_value) VALUES (?, 1, 'Subject', 'subject', ?, ?);").run(messageId, hostileSubject, hostileSubject);
  database.query("INSERT INTO message_addresses (message_id, ordinal, role, position, address, normalized_address, display_name) VALUES (?, 1, 'from', 1, 'alice@example.com', 'alice@example.com', 'Alice');").run(messageId);
  database.query("INSERT INTO message_body_parts (message_id, ordinal, content_type, normalized_content_type, blob_id, plain_text, html_derived_text) VALUES (?, 1, 'text/plain', 'text/plain', ?, 'needle body', '');").run(messageId, "c".repeat(64));
  database.query("INSERT INTO message_search_documents (message_id) VALUES (?);").run(messageId);
  database.query("INSERT INTO message_fts (rowid, subject, participants, body_plain, body_html, attachment_names) VALUES (1, ?, 'alice@example.com', 'needle body', '', '');").run(hostileSubject);
  database.exec("INSERT INTO message_fts(message_fts) VALUES ('rebuild');");
  const repository = new ThreadGraphRepository(database);
  repository.ingestFacts(normalizeThreadFacts({
    accountId,
    messageId,
    headers: [
      { ordinal: 1, normalizedName: "message-id", value: "<cli-243@example.com>" },
      { ordinal: 2, normalizedName: "date", value: "2026-01-01T00:00:00.000Z" },
    ],
    sentAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    participants: [{ address: "alice@example.com", displayName: "Alice" }],
  }));
  const threadId = repository.snapshot(accountId).sets[0]?.canonicalThreadId;
  if (threadId === undefined) throw new Error("composed parity thread fixture is missing");
  return threadId;
}

function sink(chunks: Uint8Array[], options: Readonly<{ readonly fail?: string; readonly accepted?: number }> = {}): CommandSink {
  return {
    async write(value) {
      chunks.push(value);
      return options.fail === undefined
        ? { kind: "written", bytesAccepted: value.byteLength }
        : { kind: "failed", errorCode: options.fail, bytesAccepted: options.accepted ?? 0 };
    },
  };
}

async function acquireLoopbackPortLease(): Promise<PortLease> {
  for (const role of loopbackLeaseRoles) {
    const lease = await acquirePortLease({ project: "cli-composed-parity-243", role });
    if (lease !== null) return lease;
  }
  throw new Error("no leased loopback test port was available");
}

async function receipt(result: CommandResultV1, options: Readonly<{ readonly mode?: "human" | "json" | "raw"; readonly stdout?: CommandSink; readonly signal?: AbortSignal; readonly rawDestination?: "pipe" | "tty" | "file"; readonly rawTty?: "refuse" | "allow" }> = {}) {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const execution = await executeCommand(result, {
    invocationCorrelationId: "cli:composed-parity-243",
    mode: options.mode ?? "human",
    stdout: options.stdout ?? sink(stdout),
    stderr: sink(stderr),
    rawPolicy: { destination: options.rawDestination ?? "pipe", tty: options.rawTty ?? "refuse" },
    signal: options.signal ?? new AbortController().signal,
  });
  return {
    execution,
    stdout: Buffer.concat(stdout.map((value) => Buffer.from(value))),
    stderr: Buffer.concat(stderr.map((value) => Buffer.from(value))),
  };
}

async function waitForActorState(actor: ReturnType<typeof createSyncLifecycleActor>, state: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (JSON.stringify(actor.getSnapshot().value).includes(state)) return;
    await Bun.sleep(1);
  }
  throw new Error(`sync fixture did not reach ${state}`);
}

function assertCompleteObservations(observations: Readonly<Record<string, boolean>>): void {
  expect(Object.keys(observations).sort()).toEqual([...expectedOperations].sort());
  expect(Object.values(observations).every(Boolean)).toBe(true);
}

async function createFixture(options: Readonly<{ readonly authBlocked?: boolean; readonly hangingCleanup?: boolean }> = {}): Promise<Fixture> {
  const database = new Database(":memory:", { strict: true });
  runMigrations(database, migrations);
  database.exec("PRAGMA foreign_keys = ON;");
  const threadId = ingest(database);
  const root = await mkdtemp(join(tmpdir(), "agent-mail-cli-composed-243-"));
  const rawBytes = Uint8Array.from({ length: 128 * 1024 + 7 }, (_, index) => {
    if (index === 0) return 0x52;
    if (index === 1) return 0x61;
    if (index === 2) return 0x77;
    if (index === 3) return 0x00;
    if (index === 4) return 0xff;
    if (index === 5) return 0xfe;
    if (index === 6) return 0x0a;
    return index % 251;
  });
  const attachmentBytes = Uint8Array.from([0x00, 0x80, 0xc3, 0x28, 0xff, 0x0a]);
  const rawDigest = createHash("sha256").update(rawBytes).digest("hex");
  const attachmentDigest = createHash("sha256").update(attachmentBytes).digest("hex");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, rawDigest), rawBytes, { mode: 0o600 });
  await writeFile(join(root, attachmentDigest), attachmentBytes, { mode: 0o600 });
  const decisions = createSyncControlDecisionChannel();
  const syncInput = {
    configuration: {
      retryBaseMs: 1,
      retryCapMs: 1,
      retryJitterRatio: 0,
      maxRetryAttempts: 1,
      periodicStatusIntervalMs: 1_000,
      controlDeadlineMs: 25,
      controlResultRetentionMs: 1_000,
      maxControlIdempotencyEntries: 16,
      maxReleaseSlotEntries: 16,
    },
    initialCheckpoint: { completedMailboxes: 0, totalMailboxes: 0, completedMessages: 0, pendingMessages: 0, lastMailbox: null, lastUid: null },
    initialCredentialRevision: 0,
    incarnationId: "incarnation:cli-composed-243",
  } as const satisfies SyncLifecycleInput;
  const actors = options.hangingCleanup
    ? {
        bootstrapSession: fromPromise(async () => {
          if (options.authBlocked) throw { category: "authentication" as const, code: "sync.credentials-rejected", safeMessage: "Credentials were rejected." };
          return { next: "idle" as const, checkpoint: syncInput.initialCheckpoint };
        }),
        cleanupBarrier: fromPromise(async () => new Promise<never>(() => undefined)),
      }
    : {
        bootstrapSession: fromPromise(async () => {
          if (options.authBlocked) throw { category: "authentication" as const, code: "sync.credentials-rejected", safeMessage: "Credentials were rejected." };
          return { next: "idle" as const, checkpoint: syncInput.initialCheckpoint };
        }),
      };
  const actor = createSyncLifecycleActor(syncInput, actors, { ...createSyncLifecycleDependencies(syncInput), controlDecisionSink: decisions.publish });
  actor.start();
  const control = createSyncControlService({
    actor: { getSnapshot: () => actor.getSnapshot(), send: (event) => actor.send(event), subscribe: (listener) => actor.subscribe(listener) },
    decisions: decisions.source,
    controlDeadlineMs: syncInput.configuration.controlDeadlineMs,
    controlResultRetentionMs: syncInput.configuration.controlResultRetentionMs,
    maxControlIdempotencyEntries: syncInput.configuration.maxControlIdempotencyEntries,
  });
  const retrievalHandlers = createRetrievalHandlers({ database, accountId, searchCursorCodec: createSearchCursorIntegrityCodec("cli-243-search-secret"), threadCursorCodec: new ThreadCursorCodec({ accountId, activeKey: { keyId: "cli-243", secret: "cli-243-thread-secret" } }) });
  const httpApp = createHttpApp({
    authenticate: (credential) => auth(credential),
    maxRequestBodyBytes: 1024,
    handlers: {
      ...retrievalHandlers,
      ...createSyncHandlers({ actor: { getSnapshot: () => actor.getSnapshot() }, control }),
    },
  });
  const contentApp = createContentStreamingApp({
    canonicalDirectory: root,
    authenticate: (credential) => auth(credential),
    resolveRaw: async (id) => id === messageId ? { messageId, blobId: `blob:${rawDigest}`, size: rawBytes.byteLength, contentType: "message/rfc822" } : undefined,
    resolveAttachment: async (id) => id === attachmentId ? { attachmentId, messageId, blobId: `blob:${attachmentDigest}`, size: attachmentBytes.byteLength, contentType: "application/octet-stream", filename: "invoice.pdf" } : undefined,
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toRequest(incoming);
      const pathname = new URL(request.url).pathname;
      const response = pathname.includes("/raw") || pathname.startsWith("/v1/attachments/")
        ? await contentApp.fetch(request)
        : await httpApp.fetch(request);
      await forwardResponse(response, outgoing);
    } catch {
      outgoing.statusCode = 500;
      outgoing.end();
    }
  });
  const portLease = await acquireLoopbackPortLease();
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(portLease.port, "127.0.0.1", resolve); });
  } catch (error: unknown) {
    await releasePortLease({ lease: portLease });
    throw error;
  }
  const baseUrl = `http://127.0.0.1:${portLease.port}`;
  const fixture: Fixture = { database, root, rawBytes, attachmentBytes, threadId, baseUrl, actor, control, server, portLease, close: async () => { control.close(); actor.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); await releasePortLease({ lease: portLease }); database.close(); await rm(root, { recursive: true, force: true }); } };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.close();
});

async function closeFixture(fixture: Fixture): Promise<void> {
  const index = fixtures.indexOf(fixture);
  if (index >= 0) fixtures.splice(index, 1);
  await fixture.close();
}

describe("#243 composed CLI parity through the real loopback service", () => {
  test("proves every named operation has an independently removable composed observation", async () => {
    const fixture = await createFixture();
    const client = createCliClient({ baseUrl: fixture.baseUrl, authorization: "Bearer parity" });
    const observations: Record<string, boolean> = {};
    const search = await runSearchCommand({ argv: ["messages", "search", "needle"], client, correlationId: "search" });
    observations["messages.search"] = search.kind === "value" && search.operationKey === "messages.search";
    const message = await executeMessageShow({ messageId, client, correlationId: "message" });
    observations["messages.get"] = message.kind === "value" && message.operationKey === "messages.get";
    const thread = await executeThreadShow({ threadId: fixture.threadId, client, correlationId: "thread" });
    observations["threads.get"] = thread.kind === "value" && thread.operationKey === "threads.get";
    const raw = await executeRawContentCommand({ kind: "raw-message", id: messageId }, { client, correlationId: "raw" });
    observations["messages.raw"] = raw.kind === "raw" && raw.operationKey === "messages.raw";
    if (raw.kind === "raw") await raw.stream.cancel();
    const attachment = await executeRawContentCommand({ kind: "attachment", id: attachmentId }, { client, correlationId: "attachment" });
    observations["attachments.get"] = attachment.kind === "raw" && attachment.operationKey === "attachments.get";
    if (attachment.kind === "raw") await attachment.stream.cancel();
    const status = await runStatusCommand({ argv: ["sync", "status"], client, correlationId: "status" });
    observations["sync.status"] = status.kind === "value" && status.operationKey === "sync.status";
    for (const [command, operation] of [["start", "sync.start"], ["pause", "sync.pause"], ["resume", "sync.resume"], ["stop", "sync.stop"]] as const) {
      const result = await runSyncControlCommand({ argv: command === "start" ? ["sync", command] : ["sync", command, "--idempotency-key", `cli-243-${command}`], client, correlationId: command });
      observations[operation] = result.kind === "value" && result.operationKey === operation;
    }
    assertCompleteObservations(observations);
    for (const removedOperation of expectedOperations) {
      const withoutOne = Object.fromEntries(
        Object.entries(observations).filter(([operation]) => operation !== removedOperation),
      );
      expect(() => assertCompleteObservations(withoutOne)).toThrow();
    }
  });

  test("preserves exact retrieval values, registered errors, hostile terminal values, and exits", async () => {
    const fixture = await createFixture();
    const client = createCliClient({ baseUrl: fixture.baseUrl, authorization: "Bearer parity" });
    const search = await runSearchCommand({ argv: ["messages", "search", "needle"], client, correlationId: "search" });
    const searchResponse = search.kind === "value" ? searchResponseSchema.parse(search.data) : undefined;
    expect(searchResponse?.items[0]?.subject).toContain("\u202E");
    const directSearch = await fetch(`${fixture.baseUrl}/v1/messages/search`, { method: "POST", headers: { authorization: "Bearer parity", "content-type": "application/json" }, body: JSON.stringify({ query: "needle" }) });
    expect(directSearch.status).toBe(200);
    expect(await directSearch.json()).toEqual(searchResponse);
    const human = await receipt(search);
    expect(human.execution.exitCode).toBe(0);
    const humanText = human.stdout.toString("utf8");
    expect(humanText.includes("\u202E")).toBe(false);
    expect(humanText).toContain("⟦RLO⟧");
    const json = await receipt(search, { mode: "json" });
    expect(JSON.parse(json.stdout.toString("utf8")).items[0].subject).toBe(searchResponse?.items[0]?.subject);
    const missing = await executeMessageShow({ messageId: `message:${"f".repeat(64)}`, client, correlationId: "missing" });
    expect(missing).toMatchObject({ kind: "failure", semanticKind: "not_found", error: { code: messageNotFoundErrorDefinition.code } });
    expect((await receipt(missing)).execution.exitCode).toBe(66);
    const directMissing = await fetch(`${fixture.baseUrl}/v1/messages/${encodeURIComponent(`message:${"f".repeat(64)}`)}`, { headers: { authorization: "Bearer parity" } });
    expect(directMissing.status).toBe(404);
    expect(await directMissing.json()).toMatchObject({ code: messageNotFoundErrorDefinition.code, details: { resource: "message" } });
    const invalidSearch = await runSearchCommand({ argv: ["messages", "search", "needle OR reply"], client, correlationId: "invalid-search" });
    expect(invalidSearch).toMatchObject({ kind: "failure", semanticKind: "invalid_input", error: { code: "invalid_query" } });
    expect((await receipt(invalidSearch)).execution.exitCode).toBe(65);
    const directInvalidSearch = await fetch(`${fixture.baseUrl}/v1/messages/search`, { method: "POST", headers: { authorization: "Bearer parity", "content-type": "application/json" }, body: JSON.stringify({ query: "needle OR reply" }) });
    expect(directInvalidSearch.status).toBe(400);
    expect(await directInvalidSearch.json()).toMatchObject({ code: "invalid_query" });
    const threadMissing = await executeThreadShow({ threadId: `thread:${"f".repeat(64)}`, client, correlationId: "thread-missing" });
    expect(threadMissing).toMatchObject({ kind: "failure", semanticKind: "not_found" });
    expect((await receipt(threadMissing)).execution.exitCode).toBe(66);
    const messageResult = await executeMessageShow({ messageId, client, correlationId: "message" });
    const messageResponse = messageResult.kind === "value" ? messageResponseSchema.parse(messageResult.data) : undefined;
    expect(messageResponse).toBeDefined();
    const directMessage = await fetch(`${fixture.baseUrl}/v1/messages/${encodeURIComponent(messageId)}`, { headers: { authorization: "Bearer parity" } });
    expect(await directMessage.json()).toEqual(messageResponse);
    const threadResult = await executeThreadShow({ threadId: fixture.threadId, client, correlationId: "thread" });
    const threadResponse = threadResult.kind === "value" ? threadResponseSchema.parse(threadResult.data) : undefined;
    expect(threadResponse).toBeDefined();
    const directThread = await fetch(`${fixture.baseUrl}/v1/threads/${encodeURIComponent(fixture.threadId)}`, { method: "POST", headers: { authorization: "Bearer parity", "content-type": "application/json" }, body: JSON.stringify({ threadId: fixture.threadId }) });
    expect(await directThread.json()).toEqual(threadResponse);
  });

  test("keeps raw message and attachment stdout byte-exact and separates failure semantics", async () => {
    const fixture = await createFixture();
    const client = createCliClient({ baseUrl: fixture.baseUrl, authorization: "Bearer parity" });
    const attachmentHttp = await fetch(`${fixture.baseUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`, { headers: { authorization: "Bearer parity" } });
    expect(attachmentHttp.status).toBe(200);
    expect(attachmentHttp.headers.get("content-disposition")).toContain('filename="invoice.pdf"');
    await attachmentHttp.body?.cancel();
    for (const [target, expected] of [[{ kind: "raw-message", id: messageId }, fixture.rawBytes], [{ kind: "attachment", id: attachmentId }, fixture.attachmentBytes]] as const) {
      const result = await executeRawContentCommand(target, { client, correlationId: "raw" });
      const output = await receipt(result, { mode: "raw" });
      expect(output.execution.exitCode).toBe(0);
      expect(output.stdout).toEqual(Buffer.from(expected));
      expect(output.stderr.byteLength).toBe(0);
    }
    const refused = await executeRawContentCommand({ kind: "raw-message", id: messageId }, { client, correlationId: "tty" });
    expect((await receipt(refused, { mode: "raw", rawDestination: "tty", rawTty: "refuse" })).execution.exitCode).not.toBe(0);
    const preOutput = await executeRawContentCommand({ kind: "raw-message", id: messageId }, { client, correlationId: "pre-output" });
    const preOutputReceipt = await receipt(preOutput, { mode: "raw", stdout: sink([], { fail: "EIO", accepted: 0 }) });
    expect(preOutputReceipt.execution.exitCode).toBe(74);
    expect(preOutputReceipt.execution.stdoutBytesAccepted).toBe(0);
    const partial = await executeRawContentCommand({ kind: "raw-message", id: messageId }, { client, correlationId: "partial" });
    let partialWrites = 0;
    const partialReceipt = await receipt(partial, {
      mode: "raw",
      stdout: {
        async write(value) {
          partialWrites += 1;
          return partialWrites === 1
            ? { kind: "written", bytesAccepted: value.byteLength }
            : { kind: "failed", errorCode: "EIO", bytesAccepted: 0 };
        },
      },
    });
    expect(partialWrites).toBeGreaterThan(1);
    expect(partialReceipt.execution.exitCode).toBe(88);
    expect(partialReceipt.execution.stdoutBytesAccepted).toBeGreaterThan(0);
    const epipe = await executeRawContentCommand({ kind: "raw-message", id: messageId }, { client, correlationId: "epipe" });
    let epipeWrites = 0;
    let epipeAccepted = 0;
    const epipeReceipt = await receipt(epipe, {
      mode: "raw",
      stdout: {
        async write(value) {
          epipeWrites += 1;
          epipeAccepted = Math.floor(value.byteLength / 2);
          return { kind: "failed", errorCode: "EPIPE", bytesAccepted: epipeAccepted };
        },
      },
    });
    expect(epipeWrites).toBe(1);
    expect(epipeAccepted).toBeGreaterThan(0);
    expect(epipeAccepted).toBeLessThan(fixture.rawBytes.byteLength);
    expect(epipeReceipt.execution.exitCode).toBe(141);
    expect(epipeReceipt.execution.stdoutBytesAccepted).toBe(0);
    const aborted = new AbortController();
    aborted.abort();
    const cancellable = await executeRawContentCommand({ kind: "raw-message", id: messageId }, { client, correlationId: "cancelled" });
    const cancelledReceipt = await receipt(cancellable, { mode: "raw", signal: aborted.signal });
    expect(cancelledReceipt.execution.exitCode).toBe(84);
    expect(cancelledReceipt.execution.cleanupAwaited).toBe(true);
  });

  test("proves sync state/control values and non-success attention/temporary outcomes", async () => {
    const fixture = await createFixture();
    const client = createCliClient({ baseUrl: fixture.baseUrl, authorization: "Bearer parity" });
    const status = await runStatusCommand({ argv: ["sync", "status"], client, correlationId: "status" });
    expect(status.kind).toBe("value");
    if (status.kind === "value") expect(syncStatusResponseSchema.parse(status.data)).toEqual(projectSyncStatus(fixture.actor.getSnapshot()));
    const invalidTransition = await runSyncControlCommand({ argv: ["sync", "pause", "--idempotency-key", "invalid-transition"], client, correlationId: "invalid-transition" });
    expect(invalidTransition).toMatchObject({ kind: "failure", semanticKind: "conflict" });
    expect((await receipt(invalidTransition)).execution.exitCode).not.toBe(0);
    const start = await runSyncControlCommand({ argv: ["sync", "start"], client, correlationId: "start" });
    expect(start).toMatchObject({ kind: "value", operationKey: "sync.start" });
    expect(start.kind).not.toBe("failure");
    await closeFixture(fixture);
    const authFixture = await createFixture({ authBlocked: true });
    const authClient = createCliClient({ baseUrl: authFixture.baseUrl, authorization: "Bearer parity" });
    const authStart = await runSyncControlCommand({ argv: ["sync", "start"], client: authClient, correlationId: "auth-start" });
    expect(authStart).toMatchObject({ kind: "value", operationKey: "sync.start" });
    await waitForActorState(authFixture.actor, "authBlocked");
    const blocked = await runStatusCommand({ argv: ["sync", "status"], client: authClient, correlationId: "blocked" });
    expect(blocked).toMatchObject({ kind: "value", semanticKind: "attention" });
    expect((await receipt(blocked)).execution.exitCode).toBe(85);
    await closeFixture(authFixture);
    const timeoutFixture = await createFixture({ hangingCleanup: true });
    const timeoutClient = createCliClient({ baseUrl: timeoutFixture.baseUrl, authorization: "Bearer parity" });
    await runSyncControlCommand({ argv: ["sync", "start"], client: timeoutClient, correlationId: "timeout-start" });
    await waitForActorState(timeoutFixture.actor, "watching");
    const timedOut = await runSyncControlCommand({ argv: ["sync", "stop", "--idempotency-key", "timeout-stop"], client: timeoutClient, correlationId: "timeout-stop" });
    expect(timedOut).toMatchObject({ kind: "failure", semanticKind: "temporary" });
    expect((await receipt(timedOut)).execution.exitCode).toBe(75);
  });

  test("rejects wrong-scope and oversized bodies before handler effects", async () => {
    const admissionState = { pulls: 0, cancels: 0 };
    const lifecycle = { readerAcquired: 0, readerReleased: 0, inputCancelled: 0 };
    const deniedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
      },
      pull() {
        admissionState.pulls += 1;
      },
      cancel() {
        admissionState.cancels += 1;
      },
    });
    const denied = await admitHttpRequest({
      operation: searchOperation,
      request: {
        headers: new Headers({ authorization: "Bearer wrong", "content-type": "application/json" }),
        body: deniedBody,
        method: "POST",
        signal: new AbortController().signal,
      },
      authenticate: () => ({ kind: "authenticated", principal: { subject: "wrong-scope", scopes: ["mail:read.message"] } }),
      lifecycleProbe: {
        onReaderAcquired: () => (lifecycle.readerAcquired += 1),
        onReaderReleased: () => (lifecycle.readerReleased += 1),
        onInputCancelled: () => (lifecycle.inputCancelled += 1),
      },
    });
    expect(denied).toMatchObject({ kind: "rejected", status: 403 });
    expect(lifecycle).toEqual({ readerAcquired: 0, readerReleased: 0, inputCancelled: 1 });
    expect(admissionState).toEqual({ pulls: 0, cancels: 1 });

    let effects = 0;
    const app = createHttpApp({
      maxRequestBodyBytes: 8,
      authenticate: (credential) => credential === "correct"
        ? { kind: "authenticated", principal: { subject: "correct", scopes: ["mail:read.search"] } }
        : { kind: "authenticated", principal: { subject: "wrong-scope", scopes: ["mail:read.message"] } },
      handlers: { "messages.search": async () => { effects += 1; return { items: [], nextCursor: null }; } },
    });
    const oversized = await app.request(new Request("http://localhost/v1/messages/search", { method: "POST", headers: { authorization: "Bearer correct", "content-type": "application/json", "content-length": "9" }, body: JSON.stringify({ query: "x" }) }));
    expect(oversized.status).toBe(413);
    expect(effects).toBe(0);
  });
});
