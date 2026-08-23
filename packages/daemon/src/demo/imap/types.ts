import type { IImapMailbox, IImapMailBackend, IImapMessage } from "@push.rocks/smartimap";
import type { CorpusDigest, CorpusMessage, DemoCorpus } from "../corpus/types";

export const DEMO_IMAP_DEFAULT_PORT = 6111;
export const DEMO_IMAP_TEST_PORTS = Object.freeze([6112, 6113, 6114] as const);
export const DEMO_IMAP_HOST = "127.0.0.1" as const;
export const DEMO_IMAP_USERNAME = "demo-user" as const;
export const DEMO_IMAP_PASSWORD = "demo-pass" as const;
export const DEMO_IMAP_BACKEND_API_VERSION = 2 as const;
export const DEMO_IMAP_SMARTIMAP_VERSION = "2.1.0" as const;
export const DEMO_IMAP_SELECTION_SIZE = 12;

export type DemoImapTestPort = (typeof DEMO_IMAP_TEST_PORTS)[number];
export type DemoImapPort = typeof DEMO_IMAP_DEFAULT_PORT | DemoImapTestPort;

export type DemoImapRenderedMessage = Readonly<{
  readonly sourceId: CorpusMessage["id"];
  readonly sourceMessageId: string;
  readonly mailboxId: CorpusMessage["mailboxId"];
  readonly uid: number;
  readonly flags: readonly string[];
  readonly internalDate: string;
  readonly rawDigest: CorpusDigest;
  readonly raw: Uint8Array;
  readonly protocol: IImapMessage;
}>;

export type DemoImapRenderedMailbox = Readonly<{
  readonly sourceId: CorpusMessage["mailboxId"];
  readonly sourceName: string;
  readonly protocol: IImapMailbox;
  readonly messages: readonly DemoImapRenderedMessage[];
}>;

export type DemoImapSnapshot = Readonly<{
  readonly corpusVersion: DemoCorpus["scenarioVersion"];
  readonly corpusSeed: DemoCorpus["seed"];
  readonly selectedMessageIds: readonly CorpusMessage["id"][];
  readonly mailboxes: readonly DemoImapRenderedMailbox[];
}>;

export type DemoImapBackend = IImapMailBackend &
  Readonly<{
    readonly snapshot: () => DemoImapSnapshot;
  }>;

export type DemoImapPortLease = Readonly<{
  readonly port: DemoImapTestPort;
  readonly release: () => Promise<void>;
}>;

export type DemoImapServerOptions = Readonly<{
  readonly corpus?: DemoCorpus;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly password?: string;
  readonly releasePort?: () => void | Promise<void>;
}>;

export type DemoImapServerSnapshot = Readonly<{
  readonly host: typeof DEMO_IMAP_HOST;
  readonly port: DemoImapPort;
  readonly listening: boolean;
  readonly backendApiVersion: typeof DEMO_IMAP_BACKEND_API_VERSION;
  readonly activeListeners: number;
  readonly corpus: DemoImapSnapshot;
}>;

export type DemoImapServer = Readonly<{
  readonly host: typeof DEMO_IMAP_HOST;
  readonly port: DemoImapPort;
  readonly backend: () => DemoImapBackend;
  readonly snapshot: () => DemoImapServerSnapshot;
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
}>;
