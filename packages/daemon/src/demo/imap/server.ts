import {
  IMAP_SERVER_BACKEND_API_VERSION,
  ImapServer,
  type IImapAuthenticationRequest,
} from "@push.rocks/smartimap";
import { CORPUS_VERSION, buildCorpus, type DemoCorpus } from "../corpus";
import {
  authenticateDemoImap,
  createDemoImapBackend,
  DEFAULT_DEMO_IMAP_CREDENTIALS,
} from "./backend";
import {
  DEMO_IMAP_BACKEND_API_VERSION,
  DEMO_IMAP_DEFAULT_PORT,
  DEMO_IMAP_HOST,
  DEMO_IMAP_PASSWORD,
  DEMO_IMAP_USERNAME,
  type DemoImapBackend,
  type DemoImapPort,
  type DemoImapServer,
  type DemoImapServerOptions,
  type DemoImapServerSnapshot,
} from "./types";

const DEFAULT_SCENARIO_MIX = Object.freeze({
  ordinary: 1,
  transactional: 1,
  "mailing-list": 1,
  newsletter: 1,
  automated: 1,
  spam: 1,
});

function assertSmartimapCompatibility(): void {
  if (IMAP_SERVER_BACKEND_API_VERSION !== DEMO_IMAP_BACKEND_API_VERSION)
    throw new Error("unsupported smartimap backend API version");
}

function defaultCorpus(): DemoCorpus {
  return buildCorpus({
    scenarioVersion: CORPUS_VERSION,
    seed: "fm1-smartimap",
    size: 12,
    scenarioMix: DEFAULT_SCENARIO_MIX,
  });
}

function validPort(value: number): value is DemoImapPort {
  return value === 6111 || value === 6112 || value === 6113 || value === 6114;
}

function validCredential(value: string, name: string): string {
  if (value.length === 0 || value.trim() !== value)
    throw new TypeError(`${name} must be a non-empty trimmed value`);
  return value;
}

function authenticate(
  request: IImapAuthenticationRequest,
  username: string,
  password: string,
): ReturnType<typeof authenticateDemoImap> {
  return authenticateDemoImap(request, username, password);
}

export function createDemoImapServer(options: DemoImapServerOptions = {}): DemoImapServer {
  assertSmartimapCompatibility();
  const port = options.port ?? DEMO_IMAP_DEFAULT_PORT;
  if (options.host !== undefined && options.host !== DEMO_IMAP_HOST)
    throw new Error("demo IMAP server only binds loopback");
  if (!validPort(port)) throw new RangeError("demo IMAP port must be in Hermes range 6111-6114");
  const username = validCredential(options.username ?? DEMO_IMAP_USERNAME, "username");
  const password = validCredential(options.password ?? DEMO_IMAP_PASSWORD, "password");
  const backend = createDemoImapBackend(options.corpus ?? defaultCorpus());
  type Lifecycle =
    | Readonly<{ readonly kind: "created" }>
    | Readonly<{
        readonly kind: "starting";
        readonly candidate: ImapServer;
        readonly startPromise: Promise<void>;
      }>
    | Readonly<{ readonly kind: "running"; readonly candidate: ImapServer }>
    | Readonly<{
        readonly kind: "closing";
        readonly candidate: ImapServer | null;
        readonly closePromise: Promise<void>;
      }>
    | Readonly<{ readonly kind: "closed" }>
    | Readonly<{ readonly kind: "failed"; readonly error: Error }>;

  let lifecycle: Lifecycle = Object.freeze({ kind: "created" });
  let releasePromise: Promise<void> | null = null;

  const releasePort = (): Promise<void> => {
    if (releasePromise === null) {
      releasePromise = Promise.resolve(options.releasePort?.());
    }
    return releasePromise;
  };

  const normalizeFailure = (error: unknown, fallback: string): Error =>
    error instanceof Error ? error : new Error(fallback);

  const cleanup = async (
    candidate: ImapServer | null,
    initial: Error | null,
  ): Promise<Error | null> => {
    let failure = initial;
    if (candidate !== null) {
      try {
        await candidate.stop();
      } catch (error: unknown) {
        failure ??= normalizeFailure(error, "demo IMAP server stop failed");
      }
    }
    try {
      await releasePort();
    } catch (error: unknown) {
      failure ??= normalizeFailure(error, "demo IMAP port release failed");
    }
    return failure;
  };

  const serverOptions = (): ConstructorParameters<typeof ImapServer>[0] => ({
    backend,
    authenticate: (request) => authenticate(request, username, password),
    authMechanisms: ["LOGIN", "PLAIN"],
    allowInsecureAuth: true,
    host: DEMO_IMAP_HOST,
    hostname: DEMO_IMAP_HOST,
    maxConnections: 8,
    maxCommandBytes: 16 * 1024,
    maxLiteralBytes: 64 * 1024,
    maxQueuedCommands: 16,
    maxAuthAttempts: 3,
    socketTimeoutMs: 5_000,
  });

  const startCandidate = async (candidate: ImapServer): Promise<void> => {
    try {
      await candidate.start(port, DEMO_IMAP_HOST);
      if (lifecycle.kind === "starting" && lifecycle.candidate === candidate)
        lifecycle = Object.freeze({ kind: "running", candidate });
    } catch (error: unknown) {
      const failure = normalizeFailure(error, "demo IMAP server start failed");
      if (lifecycle.kind === "starting" && lifecycle.candidate === candidate) {
        let cleanupPromise: Promise<void>;
        cleanupPromise = (async (): Promise<void> => {
          const cleanupFailure = await cleanup(candidate, failure);
          const terminal = cleanupFailure ?? failure;
          lifecycle = Object.freeze({ kind: "failed", error: terminal });
          throw terminal;
        })();
        lifecycle = Object.freeze({ kind: "closing", candidate, closePromise: cleanupPromise });
        await cleanupPromise;
      }
      throw failure;
    }
  };

  const start = (): Promise<void> => {
    switch (lifecycle.kind) {
      case "created": {
        let candidate: ImapServer;
        try {
          candidate = new ImapServer(serverOptions());
        } catch (error: unknown) {
          const failure = normalizeFailure(error, "demo IMAP server construction failed");
          lifecycle = Object.freeze({ kind: "failed", error: failure });
          return Promise.reject(failure);
        }
        const startPromise = startCandidate(candidate);
        lifecycle = Object.freeze({ kind: "starting", candidate, startPromise });
        return startPromise;
      }
      case "starting":
        return lifecycle.startPromise;
      case "running":
        return Promise.reject(new Error("demo IMAP server is already running"));
      case "closing":
      case "closed":
        return Promise.reject(new Error("demo IMAP server is closed"));
      case "failed":
        return Promise.reject(lifecycle.error);
    }
  };

  const close = (): Promise<void> => {
    switch (lifecycle.kind) {
      case "closed":
        return Promise.resolve();
      case "failed":
        return Promise.reject(lifecycle.error);
      case "closing":
        return lifecycle.closePromise;
      case "created": {
        let closePromise: Promise<void>;
        closePromise = (async (): Promise<void> => {
          const failure = await cleanup(null, null);
          if (failure !== null) {
            lifecycle = Object.freeze({ kind: "failed", error: failure });
            throw failure;
          }
          lifecycle = Object.freeze({ kind: "closed" });
        })();
        lifecycle = Object.freeze({ kind: "closing", candidate: null, closePromise });
        return closePromise;
      }
      case "running": {
        const candidate = lifecycle.candidate;
        let closePromise: Promise<void>;
        closePromise = (async (): Promise<void> => {
          const failure = await cleanup(candidate, null);
          if (failure !== null) {
            lifecycle = Object.freeze({ kind: "failed", error: failure });
            throw failure;
          }
          lifecycle = Object.freeze({ kind: "closed" });
        })();
        lifecycle = Object.freeze({ kind: "closing", candidate, closePromise });
        return closePromise;
      }
      case "starting": {
        const candidate = lifecycle.candidate;
        const startPromise = lifecycle.startPromise;
        let closePromise: Promise<void>;
        closePromise = (async (): Promise<void> => {
          let failure: Error | null = null;
          try {
            await startPromise;
          } catch (error: unknown) {
            failure = normalizeFailure(error, "demo IMAP server start failed");
          }
          failure = await cleanup(candidate, failure);
          if (failure !== null) {
            lifecycle = Object.freeze({ kind: "failed", error: failure });
            throw failure;
          }
          lifecycle = Object.freeze({ kind: "closed" });
        })();
        lifecycle = Object.freeze({ kind: "closing", candidate, closePromise });
        return closePromise;
      }
    }
  };

  const snapshot = (): DemoImapServerSnapshot =>
    Object.freeze({
      host: DEMO_IMAP_HOST,
      port,
      listening: lifecycle.kind === "running",
      backendApiVersion: DEMO_IMAP_BACKEND_API_VERSION,
      activeListeners: lifecycle.kind === "running" ? 1 : 0,
      corpus: backend.snapshot(),
    });

  return Object.freeze({
    host: DEMO_IMAP_HOST,
    port,
    backend: (): DemoImapBackend => backend,
    snapshot,
    start,
    close,
  });
}

export const DEMO_IMAP_CREDENTIALS = DEFAULT_DEMO_IMAP_CREDENTIALS;
