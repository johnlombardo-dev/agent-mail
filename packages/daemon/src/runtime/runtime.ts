import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { searchResponseSchema, type SyncCheckpointSummary } from "@agent-mail/contracts";
import { parseAccountId } from "@agent-mail/core";
import type { ReadOnlyImapSourceAuthority } from "../../../imap/src/read-only-session";
import { openDatabase, type OpenDatabase } from "../../../storage/src/database";
import { parseBlobStageFilename } from "../../../storage/src/blob-stage";
import { parseStartupConfig, type StartupConfig } from "../config";
import {
  createContentStreamingApp,
  type AttachmentContentRecord,
  type RawContentRecord,
} from "../content-streaming";
import { createHttpApp, type HttpCredentialAuthenticator, type PrivateHttpLogger } from "../http";
import { createRetrievalHandlers } from "../retrieval-handlers";
import { createSyncHandlers } from "../sync-handlers";
import {
  createLoopbackHttpListener,
  type CanonicalHttpListener,
  type CanonicalHttpListenerFactory,
} from "./listener";
import { createCanonicalSyncComposition, type CanonicalSyncComposition } from "./sync";

export type CanonicalRuntimeState =
  | "created"
  | "preparing"
  | "starting-listener"
  | "syncing"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

export type CanonicalRuntimeDiagnostic = Readonly<{
  readonly code:
    | "runtime.invalid-input"
    | "runtime.private-root"
    | "runtime.database"
    | "runtime.listener"
    | "runtime.sync"
    | "runtime.readiness"
    | "runtime.cleanup";
  readonly message: string;
}>;

export type CanonicalRuntimeReadiness = Readonly<{
  readonly baseUrl: string;
  readonly checkpoint: SyncCheckpointSummary;
  readonly observedSource: Readonly<{
    readonly messageId: string;
    readonly accountId: string;
    readonly mailboxId: string;
    readonly uidValidity: number;
    readonly uid: number;
  }>;
}>;

export type CanonicalRuntimeSnapshot = Readonly<{
  readonly state: CanonicalRuntimeState;
  readonly ready: boolean;
  readonly baseUrl: string | null;
  readonly diagnostic: CanonicalRuntimeDiagnostic | null;
  readonly sourceReleaseCount: number;
  readonly activeHttpConnections: number;
}>;

export type CanonicalDaemonRuntimeOptions = Readonly<{
  readonly configuration: unknown;
  readonly accountId: unknown;
  readonly source: ReadOnlyImapSourceAuthority;
  readonly authenticate: HttpCredentialAuthenticator;
  /** Already-resolved local HTTP authorization used only for the readiness probe. */
  readonly readinessAuthorization: string;
  readonly listenerFactory?: CanonicalHttpListenerFactory;
  readonly logger?: PrivateHttpLogger;
  readonly now?: () => Date;
}>;

export type CanonicalDaemonRuntime = Readonly<{
  readonly start: () => Promise<CanonicalRuntimeReadiness>;
  readonly close: () => Promise<void>;
  readonly shutdown: (signal: string) => Promise<void>;
  readonly snapshot: () => CanonicalRuntimeSnapshot;
}>;

export class CanonicalRuntimeError extends Error {
  readonly diagnostic: CanonicalRuntimeDiagnostic;

  constructor(diagnostic: CanonicalRuntimeDiagnostic, options?: ErrorOptions) {
    super(diagnostic.message, options);
    this.name = "CanonicalRuntimeError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

type Resources = {
  database?: OpenDatabase;
  sync?: CanonicalSyncComposition;
  listener?: CanonicalHttpListener;
};

type StartupStorageOwnership = Readonly<{
  readonly markerPath: string;
  readonly identity: string;
}>;

function diagnostic(
  code: CanonicalRuntimeDiagnostic["code"],
  message: string,
): CanonicalRuntimeDiagnostic {
  return Object.freeze({ code, message });
}

function privateDirectoryError(): CanonicalRuntimeError {
  return new CanonicalRuntimeError(
    diagnostic("runtime.private-root", "Canonical runtime private storage is unavailable."),
  );
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (entry.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && entry.uid !== expectedUid)
  ) {
    throw privateDirectoryError();
  }
}

async function ensurePrivateChild(parent: string, path: string): Promise<void> {
  await assertPrivateDirectory(parent);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  await assertPrivateDirectory(path);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) throw error;
  }
}

async function writeOwnershipMarker(path: string, identity: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(identity, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyOwnershipMarker(ownership: StartupStorageOwnership): Promise<void> {
  const entry = await lstat(ownership.markerPath);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    (entry.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && entry.uid !== expectedUid) ||
    (await readFile(ownership.markerPath, "utf8")) !== ownership.identity
  ) {
    throw new Error("canonical startup storage ownership changed");
  }
}

async function claimStartupStorage(
  input: Readonly<{
    readonly dataDirectory: string;
    readonly blobDirectory: string;
    readonly stagingDirectory: string;
    readonly runtimeDirectory: string;
    readonly identity: string;
  }>,
): Promise<StartupStorageOwnership> {
  const markerPath = join(input.runtimeDirectory, ".canonical-runtime-startup-owner");
  const directories = [input.dataDirectory, input.blobDirectory, input.stagingDirectory];
  if (
    (await Promise.all(directories.map((directory) => readdir(directory)))).some(
      (names) => names.length > 0,
    )
  ) {
    throw new Error("canonical disposable startup storage is not empty");
  }
  await writeOwnershipMarker(markerPath, input.identity);
  const ownership = Object.freeze({ markerPath, identity: input.identity });
  try {
    if (
      (await Promise.all(directories.map((directory) => readdir(directory)))).some(
        (names) => names.length > 0,
      )
    ) {
      throw new Error("canonical disposable startup storage changed during acquisition");
    }
    await verifyOwnershipMarker(ownership);
    return ownership;
  } catch (error: unknown) {
    await removeFileIfPresent(markerPath).catch(() => undefined);
    throw error;
  }
}

async function commitStartupStorage(ownership: StartupStorageOwnership): Promise<void> {
  await verifyOwnershipMarker(ownership);
  await removeFileIfPresent(ownership.markerPath);
}

async function rollbackStartupStorage(
  input: Readonly<{
    readonly ownership: StartupStorageOwnership;
    readonly databasePath: string;
    readonly blobDirectory: string;
    readonly stagingDirectory: string;
  }>,
): Promise<void> {
  await verifyOwnershipMarker(input.ownership);
  const stages = await readdir(input.stagingDirectory);
  if (stages.length > 0) throw new Error("canonical startup staging cleanup is incomplete");
  const blobs = await readdir(input.blobDirectory);
  if (blobs.some((name) => !/^[0-9a-f]{64}$/u.test(name))) {
    throw new Error("canonical startup blob ownership is ambiguous");
  }
  for (const name of blobs) await removeFileIfPresent(join(input.blobDirectory, name));
  for (const path of [
    input.databasePath,
    `${input.databasePath}-wal`,
    `${input.databasePath}-shm`,
  ]) {
    await removeFileIfPresent(path);
  }
  await removeFileIfPresent(input.ownership.markerPath);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function authorization(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("Bearer ") ||
    value.length <= "Bearer ".length ||
    value.length > 4_096 ||
    hasControlCharacter(value)
  ) {
    throw new CanonicalRuntimeError(
      diagnostic("runtime.invalid-input", "Canonical runtime authorization is invalid."),
    );
  }
  return value;
}

function ownerIdentity(): string {
  return `canonical-runtime:${crypto.randomUUID()}`;
}

function resolveRaw(database: Database, messageId: string): RawContentRecord | undefined {
  const row = database
    .query<Readonly<{ blob_id: string; size: number }>, [string]>(
      "SELECT blob_id, size FROM message_blob_references WHERE message_id = ? AND kind = 'raw-eml' AND ordinal = 1;",
    )
    .get(messageId);
  return row === null
    ? undefined
    : {
        messageId,
        blobId: `blob:${row.blob_id}`,
        size: row.size,
        contentType: "message/rfc822",
      };
}

function resolveAttachment(
  database: Database,
  attachmentId: string,
): AttachmentContentRecord | undefined {
  const digest = attachmentId.startsWith("attachment:")
    ? attachmentId.slice("attachment:".length)
    : "";
  if (!/^[0-9a-f]{64}$/u.test(digest)) return undefined;
  const row = database
    .query<
      Readonly<{
        message_id: string;
        filename: string | null;
        content_type: string;
        size: number;
        blob_id: string;
      }>,
      [string]
    >(
      "SELECT message_id, filename, content_type, size, blob_id FROM message_attachments WHERE blob_id = ? ORDER BY message_id, ordinal LIMIT 1;",
    )
    .get(digest);
  return row === null
    ? undefined
    : {
        attachmentId,
        messageId: row.message_id,
        blobId: `blob:${row.blob_id}`,
        size: row.size,
        contentType: row.content_type,
        filename: row.filename,
      };
}

function readinessTerm(database: Database): string {
  const rows = database
    .query<Readonly<{ normalized_value: string }>, []>(
      "SELECT normalized_value FROM message_headers WHERE normalized_name = 'subject' ORDER BY message_id, ordinal;",
    )
    .all();
  for (const row of rows) {
    const term = row.normalized_value.match(/[\p{L}\p{N}_]+/u)?.[0];
    if (term !== undefined) return term;
  }
  throw new CanonicalRuntimeError(
    diagnostic("runtime.readiness", "Initial sync produced no searchable source message."),
  );
}

async function proveReadiness(
  listener: CanonicalHttpListener,
  database: Database,
  authorizationValue: string,
  checkpoint: SyncCheckpointSummary,
): Promise<CanonicalRuntimeReadiness> {
  const query = readinessTerm(database);
  const response = await fetch(`${listener.baseUrl}/v1/messages/search`, {
    method: "POST",
    headers: {
      authorization: authorizationValue,
      "content-type": "application/json",
      "x-correlation-id": `runtime-readiness:${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ query, filters: {}, limit: 1 }),
  });
  if (response.status !== 200) {
    throw new CanonicalRuntimeError(
      diagnostic("runtime.readiness", "Canonical search readiness probe was rejected."),
    );
  }
  const page = searchResponseSchema.parse(await response.json());
  if (!("items" in page)) {
    throw new CanonicalRuntimeError(
      diagnostic("runtime.readiness", "Canonical search readiness probe returned an error."),
    );
  }
  const first = page.items[0];
  if (first === undefined) {
    throw new CanonicalRuntimeError(
      diagnostic("runtime.readiness", "Canonical search did not observe initial sync."),
    );
  }
  const placement = database
    .query<
      Readonly<{
        message_id: string;
        account_id: string;
        mailbox_id: string;
        uid_validity: number;
        uid: number;
      }>,
      [string]
    >(
      "SELECT message_id, account_id, mailbox_id, uid_validity, uid FROM remote_placements WHERE message_id = ? AND tombstone_observed_at IS NULL ORDER BY mailbox_id, uid LIMIT 1;",
    )
    .get(first.messageId);
  if (placement === null) {
    throw new CanonicalRuntimeError(
      diagnostic("runtime.readiness", "Search result has no active source identity."),
    );
  }
  return Object.freeze({
    baseUrl: listener.baseUrl,
    checkpoint,
    observedSource: Object.freeze({
      messageId: placement.message_id,
      accountId: placement.account_id,
      mailboxId: placement.mailbox_id,
      uidValidity: placement.uid_validity,
      uid: placement.uid,
    }),
  });
}

async function cleanupOwnedStages(stagingDirectory: string, identity: string): Promise<void> {
  const expected = createHash("sha256").update(identity).digest("hex");
  let names: readonly string[];
  try {
    names = await readdir(stagingDirectory);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const metadata = parseBlobStageFilename(name);
    if (metadata?.pid !== process.pid || metadata.identityDigest !== expected) continue;
    const path = join(stagingDirectory, name);
    const entry = await lstat(path).catch(() => undefined);
    if (entry?.isFile() !== true || entry.isSymbolicLink()) continue;
    await unlink(path).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    });
  }
}

function safeSignal(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 80 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new TypeError("runtime shutdown signal is invalid");
  }
  return value;
}

export function createCanonicalDaemonRuntime(
  options: CanonicalDaemonRuntimeOptions,
): CanonicalDaemonRuntime {
  let configuration: StartupConfig;
  let accountId: ReturnType<typeof parseAccountId>;
  let readinessAuthorization: string;
  if (typeof options.authenticate !== "function") {
    throw new CanonicalRuntimeError(
      diagnostic("runtime.invalid-input", "Canonical runtime authentication is invalid."),
    );
  }
  try {
    configuration = parseStartupConfig(options.configuration);
    accountId = parseAccountId(options.accountId);
    readinessAuthorization = authorization(options.readinessAuthorization);
  } catch (error: unknown) {
    if (error instanceof CanonicalRuntimeError) throw error;
    throw new CanonicalRuntimeError(
      diagnostic("runtime.invalid-input", "Canonical runtime configuration is invalid."),
      { cause: error },
    );
  }

  const resources: Resources = {};
  const abort = new AbortController();
  const identity = ownerIdentity();
  const stagingDirectory = join(configuration.paths.runtime, "staging");
  const databasePath = join(configuration.paths.data, "archive.sqlite");
  const listenerFactory = options.listenerFactory ?? createLoopbackHttpListener;
  const now = options.now ?? (() => new Date());
  let state: CanonicalRuntimeState = "created";
  let failure: CanonicalRuntimeError | undefined;
  let startPromise: Promise<CanonicalRuntimeReadiness> | undefined;
  let closePromise: Promise<void> | undefined;
  let startupStorage: StartupStorageOwnership | undefined;
  let startupStorageCommitted = false;

  const setStartingState = (
    next: Extract<CanonicalRuntimeState, "preparing" | "starting-listener" | "syncing">,
  ): void => {
    if (state !== "closing") state = next;
  };

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const errors: unknown[] = [];
      for (const operation of [
        () => resources.listener?.close(),
        () => resources.sync?.close(),
        () => cleanupOwnedStages(stagingDirectory, identity),
        () => resources.database?.close(),
        async () => {
          if (startupStorage === undefined || startupStorageCommitted) return;
          await rollbackStartupStorage({
            ownership: startupStorage,
            databasePath,
            blobDirectory: configuration.paths.blob,
            stagingDirectory,
          });
        },
      ]) {
        try {
          await operation();
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new CanonicalRuntimeError(
          diagnostic("runtime.cleanup", "Canonical runtime cleanup did not fully settle."),
          { cause: new AggregateError(errors) },
        );
      }
    })();
    return cleanupPromise;
  };

  const startCandidate = async (): Promise<CanonicalRuntimeReadiness> => {
    try {
      setStartingState("preparing");
      await assertPrivateDirectory(configuration.privateRoot);
      await ensurePrivateChild(configuration.privateRoot, configuration.paths.data);
      await ensurePrivateChild(configuration.privateRoot, configuration.paths.blob);
      await ensurePrivateChild(configuration.privateRoot, configuration.paths.runtime);
      await ensurePrivateChild(configuration.paths.runtime, stagingDirectory);
      if (abort.signal.aborted) throw abort.signal.reason;
      try {
        startupStorage = await claimStartupStorage({
          dataDirectory: configuration.paths.data,
          blobDirectory: configuration.paths.blob,
          stagingDirectory,
          runtimeDirectory: configuration.paths.runtime,
          identity,
        });
        resources.database = await openDatabase(databasePath);
      } catch (error: unknown) {
        throw new CanonicalRuntimeError(
          diagnostic("runtime.database", "Canonical application database could not be opened."),
          { cause: error },
        );
      }
      if (abort.signal.aborted) throw abort.signal.reason;

      resources.sync = createCanonicalSyncComposition({
        database: resources.database.db,
        accountId,
        source: options.source,
        stagingDirectory,
        canonicalDirectory: configuration.paths.blob,
        owner: { pid: process.pid, processStartIdentity: identity },
        signal: abort.signal,
        now,
      });
      const retrieval = createRetrievalHandlers({ database: resources.database.db, accountId });
      const httpApp = createHttpApp({
        authenticate: options.authenticate,
        maxRequestBodyBytes: configuration.http.maxRequestBodyBytes,
        logger: options.logger,
        handlers: {
          ...retrieval,
          ...createSyncHandlers({ actor: resources.sync.actor, control: resources.sync.control }),
        },
      });
      const contentApp = createContentStreamingApp({
        canonicalDirectory: configuration.paths.blob,
        authenticate: options.authenticate,
        logger: options.logger,
        resolveRaw: async (messageId) => resolveRaw(resources.database?.db as Database, messageId),
        resolveAttachment: async (attachmentId) =>
          resolveAttachment(resources.database?.db as Database, attachmentId),
      });
      setStartingState("starting-listener");
      try {
        resources.listener = await listenerFactory({
          host: "127.0.0.1",
          port: configuration.ports.productionService,
          maxRequestBodyBytes: configuration.http.maxRequestBodyBytes,
          signal: abort.signal,
          fetch: async (request) => {
            const path = new URL(request.url).pathname;
            return path.includes("/raw") || path.startsWith("/v1/attachments/")
              ? contentApp.fetch(request)
              : httpApp.fetch(request);
          },
        });
      } catch (error: unknown) {
        throw new CanonicalRuntimeError(
          diagnostic("runtime.listener", "Canonical loopback listener could not start."),
          { cause: error },
        );
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      setStartingState("syncing");
      let checkpoint: SyncCheckpointSummary;
      try {
        checkpoint = await resources.sync.start();
      } catch (error: unknown) {
        throw new CanonicalRuntimeError(
          diagnostic("runtime.sync", "Canonical read-only initial sync failed."),
          { cause: error },
        );
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      const ready = await proveReadiness(
        resources.listener,
        resources.database.db,
        readinessAuthorization,
        checkpoint,
      );
      if (abort.signal.aborted) throw abort.signal.reason;
      if (startupStorage === undefined) {
        throw new CanonicalRuntimeError(
          diagnostic("runtime.database", "Canonical startup storage ownership is unavailable."),
        );
      }
      await commitStartupStorage(startupStorage);
      startupStorageCommitted = true;
      state = "ready";
      return ready;
    } catch (error: unknown) {
      const normalized =
        error instanceof CanonicalRuntimeError
          ? error
          : new CanonicalRuntimeError(
              diagnostic("runtime.sync", "Canonical runtime startup was cancelled or failed."),
              { cause: error },
            );
      failure = normalized;
      let startupFailure = normalized;
      try {
        await cleanup();
      } catch (cleanupError: unknown) {
        startupFailure =
          cleanupError instanceof CanonicalRuntimeError
            ? cleanupError
            : new CanonicalRuntimeError(
                diagnostic("runtime.cleanup", "Canonical runtime cleanup did not fully settle."),
                { cause: cleanupError },
              );
      }
      failure = startupFailure;
      if (state !== "closing") state = "failed";
      throw startupFailure;
    }
  };

  const start = (): Promise<CanonicalRuntimeReadiness> => {
    switch (state) {
      case "created":
        startPromise = startCandidate();
        return startPromise;
      case "preparing":
      case "starting-listener":
      case "syncing":
        if (startPromise === undefined) throw new Error("runtime start promise is unavailable");
        return startPromise;
      case "ready":
        if (startPromise === undefined) throw new Error("runtime start promise is unavailable");
        return startPromise;
      case "closing":
      case "closed":
        return Promise.reject(new Error("canonical runtime is closed"));
      case "failed":
        return Promise.reject(failure ?? new Error("canonical runtime failed"));
    }
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    const previousState = state;
    state = "closing";
    abort.abort(new DOMException("Canonical runtime is closing", "AbortError"));
    closePromise = (async () => {
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      try {
        await cleanup();
        state = previousState === "failed" ? "failed" : "closed";
      } catch (error: unknown) {
        failure =
          error instanceof CanonicalRuntimeError
            ? error
            : new CanonicalRuntimeError(
                diagnostic("runtime.cleanup", "Canonical runtime cleanup did not fully settle."),
                { cause: error },
              );
        state = "failed";
        throw failure;
      }
    })();
    return closePromise;
  };

  const snapshot = (): CanonicalRuntimeSnapshot =>
    Object.freeze({
      state,
      ready: state === "ready",
      baseUrl: resources.listener?.baseUrl ?? null,
      diagnostic: failure?.diagnostic ?? null,
      sourceReleaseCount: resources.sync?.sourceReleaseCount() ?? 0,
      activeHttpConnections: resources.listener?.activeConnections() ?? 0,
    });

  return Object.freeze({
    start,
    close,
    shutdown: (signal) => {
      safeSignal(signal);
      return close();
    },
    snapshot,
  });
}
