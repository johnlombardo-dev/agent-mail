import type { ProcessIdentityAdapter } from "../../../../../port-lease";
import type { ReadOnlyImapSourceAuthority } from "../../../../imap/src/read-only-session";
import type { DemoCorpus } from "../corpus";
import type { DemoImapServer, DemoImapServerOptions } from "../imap";
import type { DemoProfileOptions } from "../profile";
import type {
  CanonicalDaemonRuntime,
  CanonicalDaemonRuntimeOptions,
  CanonicalRuntimeReadiness,
} from "../../runtime/runtime";

export type DemoCompositionReady = Readonly<{
  readonly baseUrl: string;
  readonly authorization: string;
  readonly observedSource: CanonicalRuntimeReadiness["observedSource"];
  readonly completedMessages: number;
}>;

export type DemoCompositionSnapshot = Readonly<{
  readonly profileRoot: string | null;
  readonly profileOwned: boolean;
  readonly imapListening: boolean;
  readonly daemonState: ReturnType<CanonicalDaemonRuntime["snapshot"]>["state"] | "absent";
  readonly activeSourceSessions: number;
  readonly cleanupPending: boolean;
}>;

export type DemoComposition = Readonly<{
  readonly generate: (signal: AbortSignal) => Promise<void>;
  readonly startImap: (signal: AbortSignal) => Promise<void>;
  readonly startDaemon: (signal: AbortSignal) => Promise<void>;
  readonly awaitReady: (signal: AbortSignal) => Promise<DemoCompositionReady>;
  readonly cleanup: () => Promise<void>;
  readonly snapshot: () => DemoCompositionSnapshot;
}>;

export type DemoCompositionAdapters = Readonly<{
  readonly processIdentity: ProcessIdentityAdapter;
  readonly buildCorpus: () => DemoCorpus;
  readonly createImapServer: (options: DemoImapServerOptions) => DemoImapServer;
  readonly createSource: (
    server: DemoImapServer,
    sessionOpened: () => void,
    sessionClosed: () => void,
  ) => ReadOnlyImapSourceAuthority;
  readonly createRuntime: (options: CanonicalDaemonRuntimeOptions) => CanonicalDaemonRuntime;
}>;

export type DemoCompositionOptions = DemoProfileOptions;
