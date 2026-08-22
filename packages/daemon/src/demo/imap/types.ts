export const DEMO_IMAP_DEFAULT_PORT = 6111;
export type DemoImapTestPort = 6112 | 6113 | 6114;
export const DEMO_IMAP_TEST_PORTS: readonly DemoImapTestPort[] = Object.freeze([6112, 6113, 6114]);

export type DemoImapPort = 6111 | 6112 | 6113 | 6114;

export type DemoImapEpochFact<T> =
  | Readonly<{ readonly kind: "known"; readonly value: T }>
  | Readonly<{ readonly kind: "unknown" }>;

export type DemoImapMessageInput = Readonly<{
  readonly uid: number;
  readonly flags?: readonly string[];
  readonly modseq: bigint;
  readonly internalDate: string;
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly raw: string;
}>;

export type DemoImapMailboxInput = Readonly<{
  readonly path: string;
  readonly selectable: boolean;
  readonly specialUse?: "\\Archive" | "\\Trash";
  readonly uidValidity: DemoImapEpochFact<number>;
  readonly uidNext: DemoImapEpochFact<number>;
  readonly highestModseq: DemoImapEpochFact<bigint>;
  readonly messages: readonly DemoImapMessageInput[];
}>;

export type DemoImapServerOptions = Readonly<{
  readonly port?: DemoImapPort;
  readonly username?: string;
  readonly password?: string;
  readonly mailboxes?: readonly DemoImapMailboxInput[];
  readonly releasePort?: () => void | Promise<void>;
}>;

export type DemoImapCommand =
  | "CAPABILITY"
  | "LOGIN"
  | "NAMESPACE"
  | "ENABLE"
  | "LIST"
  | "LSUB"
  | "SELECT"
  | "EXAMINE"
  | "UID SEARCH"
  | "UID FETCH"
  | "UID STORE"
  | "UID MOVE"
  | "IDLE"
  | "NOOP"
  | "LOGOUT";

type CommandFault = Readonly<{ readonly command?: DemoImapCommand }>;

export type DemoImapFault =
  | (CommandFault & Readonly<{ readonly kind: "latency"; readonly milliseconds: number }>)
  | (CommandFault &
      Readonly<{
        readonly kind: "throttle";
        readonly chunkBytes: number;
        readonly delayMilliseconds: number;
      }>)
  | (CommandFault &
      Readonly<{ readonly kind: "disconnect"; readonly phase: "before-response" | "after-effect" }>)
  | (CommandFault & Readonly<{ readonly kind: "partial-response"; readonly bytes: number }>)
  | (CommandFault & Readonly<{ readonly kind: "cancel" }>)
  | (CommandFault &
      Readonly<{
        readonly kind: "scripted-failure";
        readonly status: "NO" | "BAD";
        readonly code: string;
      }>);

export type DemoImapMailboxEvent =
  | Readonly<{
      readonly kind: "mail-arrived";
      readonly mailbox: string;
      readonly message: DemoImapMessageInput;
    }>
  | Readonly<{
      readonly kind: "flags-changed";
      readonly mailbox: string;
      readonly uid: number;
      readonly flags: readonly string[];
    }>
  | Readonly<{
      readonly kind: "message-moved";
      readonly source: string;
      readonly destination: string;
      readonly uid: number;
    }>
  | Readonly<{
      readonly kind: "message-disappeared";
      readonly mailbox: string;
      readonly uid: number;
    }>
  | Readonly<{
      readonly kind: "epoch-changed";
      readonly mailbox: string;
      readonly uidValidity: DemoImapEpochFact<number>;
      readonly uidNext: DemoImapEpochFact<number>;
      readonly highestModseq: DemoImapEpochFact<bigint>;
    }>
  | Readonly<{ readonly kind: "reconnect-required"; readonly reason: "scripted" | "epoch-change" }>;

export type DemoImapSessionState =
  | Readonly<{ readonly kind: "not-authenticated" }>
  | Readonly<{ readonly kind: "authenticated" }>
  | Readonly<{ readonly kind: "selected"; readonly mailbox: string; readonly readOnly: boolean }>
  | Readonly<{
      readonly kind: "idling";
      readonly mailbox: string;
      readonly readOnly: boolean;
      readonly idleTag: string;
    }>
  | Readonly<{ readonly kind: "closed" }>;

export type DemoImapSessionEvent =
  | Readonly<{ readonly kind: "authentication-succeeded" }>
  | Readonly<{
      readonly kind: "mailbox-selected";
      readonly mailbox: string;
      readonly readOnly: boolean;
    }>
  | Readonly<{ readonly kind: "idle-started"; readonly idleTag: string }>
  | Readonly<{ readonly kind: "idle-completed" }>
  | Readonly<{ readonly kind: "mailbox-closed" }>
  | Readonly<{ readonly kind: "connection-closed" }>;

export type DemoImapFaultState =
  | Readonly<{ readonly kind: "dormant" }>
  | Readonly<{ readonly kind: "scheduled"; readonly fault: DemoImapFault }>
  | Readonly<{
      readonly kind: "applying";
      readonly fault: DemoImapFault;
      readonly command: DemoImapCommand;
    }>
  | Readonly<{
      readonly kind: "completed";
      readonly fault: DemoImapFault;
      readonly command: DemoImapCommand;
    }>;

export type DemoImapCommandRecord = Readonly<{
  readonly command: string;
  readonly sessionState: DemoImapSessionState["kind"];
}>;

export type DemoImapMessageSnapshot = Readonly<{
  readonly uid: number;
  readonly flags: readonly string[];
  readonly modseq: bigint;
}>;

export type DemoImapMailboxSnapshot = Readonly<{
  readonly path: string;
  readonly selectable: boolean;
  readonly specialUse: "\\Archive" | "\\Trash" | null;
  readonly uidValidity: DemoImapEpochFact<number>;
  readonly uidNext: DemoImapEpochFact<number>;
  readonly highestModseq: DemoImapEpochFact<bigint>;
  readonly messages: readonly DemoImapMessageSnapshot[];
}>;

export type DemoImapServerSnapshot = Readonly<{
  readonly listening: boolean;
  readonly port: DemoImapPort;
  readonly activeSessions: number;
  readonly activeSockets: number;
  readonly activeListeners: number;
  readonly pendingTimers: number;
  readonly childProcesses: 0;
  readonly activeTestLeases: number;
  readonly commands: readonly DemoImapCommandRecord[];
  readonly forbiddenCommands: readonly string[];
  readonly faultState: DemoImapFaultState;
  readonly mailboxes: readonly DemoImapMailboxSnapshot[];
}>;

export type DemoImapServer = Readonly<{
  readonly host: "127.0.0.1";
  readonly port: DemoImapPort;
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly scheduleFault: (fault: DemoImapFault) => void;
  readonly applyMailboxEvent: (event: DemoImapMailboxEvent) => Promise<void>;
  readonly snapshot: () => DemoImapServerSnapshot;
}>;

export type DemoImapTestPortLease = Readonly<{
  readonly port: DemoImapTestPort;
  readonly release: () => void;
}>;

export type RemoteEffectLocalWriteResult<T> =
  | Readonly<{ readonly kind: "persisted"; readonly remoteResult: T }>
  | Readonly<{
      readonly kind: "local-write-failed";
      readonly remoteResult: T;
      readonly safeMessage: "Remote effect completed, but the local result write failed.";
    }>;
