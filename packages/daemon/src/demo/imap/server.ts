import { createServer, type Server, type Socket } from "node:net";
import { activeDemoImapTestPortLeases } from "./test-port-lease";
import {
  beginDemoImapFault,
  completeDemoImapFault,
  scheduleDemoImapFault,
  transitionDemoImapSession,
} from "./state";
import {
  DEMO_IMAP_DEFAULT_PORT,
  type DemoImapCommand,
  type DemoImapCommandRecord,
  type DemoImapEpochFact,
  type DemoImapFault,
  type DemoImapFaultState,
  type DemoImapMailboxEvent,
  type DemoImapMailboxInput,
  type DemoImapMailboxSnapshot,
  type DemoImapMessageInput,
  type DemoImapPort,
  type DemoImapServer,
  type DemoImapServerOptions,
  type DemoImapSessionState,
} from "./types";

const CAPABILITIES =
  "IMAP4rev1 NAMESPACE SPECIAL-USE IDLE MOVE UIDPLUS CONDSTORE ENABLE UTF8=ACCEPT";
const FORBIDDEN_COMMANDS = new Set(["DELETE", "EXPUNGE", "UID EXPUNGE"]);
const LOOPBACK_HOST = "127.0.0.1";

export const DEMO_IMAP_ADMISSION_LIMITS = Object.freeze({
  maxLineBytes: 16 * 1024,
  maxLiteralBytes: 64 * 1024,
  maxQueuedCommands: 16,
  maxBufferedBytes: 96 * 1024,
});

const EMPTY_BUFFER = Buffer.alloc(0);

type MutableMessage = {
  uid: number;
  flags: Set<string>;
  modseq: bigint;
  internalDate: string;
  subject: string;
  from: string;
  to: string;
  raw: string;
};

type MutableMailbox = {
  path: string;
  selectable: boolean;
  specialUse: "\\Archive" | "\\Trash" | null;
  uidValidity: DemoImapEpochFact<number>;
  uidNext: DemoImapEpochFact<number>;
  highestModseq: DemoImapEpochFact<bigint>;
  messages: MutableMessage[];
};

type LiteralAdmissionState =
  | Readonly<{ readonly kind: "none" }>
  | {
      kind: "discarding";
      tag: string;
      headerBytes: number;
      remaining: number;
      terminatorBytes: 0 | 1;
    };

type Session = {
  socket: Socket;
  state: DemoImapSessionState;
  input: Buffer;
  inFlightCommands: number;
  inFlightBytes: number;
  admissionFailed: boolean;
  literal: LiteralAdmissionState;
  closed: boolean;
};

type TimerEntry = Readonly<{
  readonly handle: ReturnType<typeof setTimeout>;
  readonly resolve: () => void;
  readonly owner: Session | null;
}>;

type ServerLifecycleState =
  | Readonly<{ readonly kind: "idle" }>
  | Readonly<{ readonly kind: "starting"; readonly listener: Server }>
  | Readonly<{ readonly kind: "listening"; readonly listener: Server }>
  | Readonly<{ readonly kind: "closing"; readonly listener: Server | null }>
  | Readonly<{ readonly kind: "stopped" }>;

type ServerLifecycleEvent =
  | Readonly<{ readonly kind: "start-requested"; readonly listener: Server }>
  | Readonly<{ readonly kind: "listener-ready" }>
  | Readonly<{ readonly kind: "close-requested" }>
  | Readonly<{ readonly kind: "start-failed" }>
  | Readonly<{ readonly kind: "cleanup-completed" }>;

type ParsedCommand = Readonly<{
  readonly tag: string;
  readonly command: string;
  readonly normalized: DemoImapCommand | null;
  readonly argumentsText: string;
}>;

type CommandResponse = Readonly<{
  readonly wire: string;
  readonly closeAfter?: boolean;
}>;

function known<T>(value: T): DemoImapEpochFact<T> {
  return Object.freeze({ kind: "known", value });
}

function defaultMessage(
  uid: number,
  flags: readonly string[],
  modseq: bigint,
): DemoImapMessageInput {
  const subject = uid === 1 ? "Quarterly review" : "Travel receipt";
  const raw = [
    `Message-ID: <demo-${uid}@example.test>`,
    "Date: Mon, 17 Aug 2026 12:00:00 +0000",
    "From: sender@example.test",
    "To: person@example.test",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Deterministic demo message ${uid}.`,
    "",
  ].join("\r\n");
  return Object.freeze({
    uid,
    flags: Object.freeze([...flags]),
    modseq,
    internalDate: "2026-08-17T12:00:00.000Z",
    subject,
    from: "sender@example.test",
    to: "person@example.test",
    raw,
  });
}

function defaultMailboxes(): readonly DemoImapMailboxInput[] {
  const inputs: DemoImapMailboxInput[] = [
    {
      path: "INBOX",
      selectable: true,
      uidValidity: known(77),
      uidNext: known(3),
      highestModseq: known(11n),
      messages: Object.freeze([defaultMessage(1, [], 10n), defaultMessage(2, ["\\Seen"], 11n)]),
    },
    {
      path: "Archive",
      selectable: true,
      specialUse: "\\Archive",
      uidValidity: known(88),
      uidNext: known(1),
      highestModseq: known(0n),
      messages: Object.freeze([]),
    },
    {
      path: "Trash",
      selectable: true,
      specialUse: "\\Trash",
      uidValidity: known(99),
      uidNext: known(1),
      highestModseq: known(0n),
      messages: Object.freeze([]),
    },
    {
      path: "Projects",
      selectable: false,
      uidValidity: { kind: "unknown" },
      uidNext: { kind: "unknown" },
      highestModseq: { kind: "unknown" },
      messages: Object.freeze([]),
    },
  ];
  return Object.freeze(inputs.map((input) => Object.freeze(input)));
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
}

function containsLineBreakOrNul(value: string): boolean {
  return value.includes("\r") || value.includes("\n") || value.includes("\u0000");
}

function validateFact<T>(
  fact: DemoImapEpochFact<T>,
  name: string,
  validate: (value: T) => void,
): void {
  if (fact.kind === "known") validate(fact.value);
  else if (fact.kind !== "unknown") {
    const exhaustive: never = fact;
    throw new TypeError(`${name} is invalid: ${String(exhaustive)}`);
  }
}

function validateMessage(message: DemoImapMessageInput): void {
  positiveSafeInteger(message.uid, "message UID");
  if (message.modseq < 0n) throw new TypeError("message MODSEQ must be non-negative");
  for (const value of [
    message.internalDate,
    message.subject,
    message.from,
    message.to,
    message.raw,
  ]) {
    if (typeof value !== "string") throw new TypeError("message text fields must be strings");
  }
  if (message.raw.includes("\u0000")) throw new TypeError("message raw source contains NUL");
}

function mutableMailbox(input: DemoImapMailboxInput): MutableMailbox {
  if (
    typeof input.path !== "string" ||
    input.path.trim().length === 0 ||
    containsLineBreakOrNul(input.path)
  ) {
    throw new TypeError("mailbox path is invalid");
  }
  validateFact(input.uidValidity, "UIDVALIDITY", (value) =>
    positiveSafeInteger(value, "UIDVALIDITY"),
  );
  validateFact(input.uidNext, "UIDNEXT", (value) => positiveSafeInteger(value, "UIDNEXT"));
  validateFact(input.highestModseq, "HIGHESTMODSEQ", (value) => {
    if (value < 0n) throw new TypeError("HIGHESTMODSEQ must be non-negative");
  });
  const seen = new Set<number>();
  const messages = input.messages.map((message) => {
    validateMessage(message);
    if (seen.has(message.uid)) throw new TypeError(`duplicate UID ${message.uid}`);
    seen.add(message.uid);
    return {
      ...message,
      flags: new Set(message.flags ?? []),
    };
  });
  messages.sort((left, right) => left.uid - right.uid);
  return {
    path: input.path,
    selectable: input.selectable,
    specialUse: input.specialUse ?? null,
    uidValidity: input.uidValidity,
    uidNext: input.uidNext,
    highestModseq: input.highestModseq,
    messages,
  };
}

function normalizePort(value: DemoImapPort | undefined): DemoImapPort {
  const port = value ?? DEMO_IMAP_DEFAULT_PORT;
  if (port !== 6111 && port !== 6112 && port !== 6113 && port !== 6114) {
    throw new TypeError("demo IMAP port must be 6111-6114");
  }
  return port;
}

function validateFault(fault: DemoImapFault): void {
  if (fault.kind === "latency") positiveSafeInteger(fault.milliseconds, "fault latency");
  if (fault.kind === "throttle") {
    positiveSafeInteger(fault.chunkBytes, "fault chunk bytes");
    positiveSafeInteger(fault.delayMilliseconds, "fault throttle delay");
  }
  if (fault.kind === "partial-response") positiveSafeInteger(fault.bytes, "partial response bytes");
  if (fault.kind === "scripted-failure" && !/^[A-Z][A-Z0-9._-]{0,63}$/u.test(fault.code)) {
    throw new TypeError("scripted fault code is invalid");
  }
}

function commandFrom(value: string): DemoImapCommand | null {
  switch (value) {
    case "CAPABILITY":
    case "LOGIN":
    case "NAMESPACE":
    case "ENABLE":
    case "LIST":
    case "LSUB":
    case "SELECT":
    case "EXAMINE":
    case "UID SEARCH":
    case "UID FETCH":
    case "UID STORE":
    case "UID MOVE":
    case "IDLE":
    case "NOOP":
    case "LOGOUT":
      return value;
    default:
      return null;
  }
}

function parseCommand(line: string): ParsedCommand | null {
  const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/u.exec(line.trim());
  if (match === null) return null;
  const tag = match[1];
  const head = match[2]?.toUpperCase();
  const tail = match[3] ?? "";
  if (tag === undefined || head === undefined) return null;
  if (head === "UID") {
    const uidMatch = /^(\S+)(?:\s+(.*))?$/u.exec(tail);
    const subcommand = uidMatch?.[1]?.toUpperCase();
    if (subcommand === undefined) return null;
    const command = `UID ${subcommand}`;
    return {
      tag,
      command,
      normalized: commandFrom(command),
      argumentsText: uidMatch?.[2] ?? "",
    };
  }
  return { tag, command: head, normalized: commandFrom(head), argumentsText: tail };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"/u.exec(trimmed);
  if (quoted?.[1] !== undefined) return quoted[1].replace(/\\(["\\])/gu, "$1");
  return trimmed.split(/\s+/u)[0] ?? "";
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function mailboxFlags(mailbox: MutableMailbox): string {
  const values = [mailbox.selectable ? "\\HasNoChildren" : "\\Noselect", mailbox.specialUse]
    .filter((value): value is string => value !== null)
    .join(" ");
  return `(${values})`;
}

function listResponse(command: "LIST" | "LSUB", mailboxes: Iterable<MutableMailbox>): string {
  return [...mailboxes]
    .map((mailbox) => `* ${command} ${mailboxFlags(mailbox)} "/" ${quoted(mailbox.path)}\r\n`)
    .join("");
}

function epochResponse(mailbox: MutableMailbox): string {
  const lines: string[] = [];
  if (mailbox.uidValidity.kind === "known") {
    lines.push(`* OK [UIDVALIDITY ${mailbox.uidValidity.value}] UIDs valid\r\n`);
  }
  if (mailbox.uidNext.kind === "known") {
    lines.push(`* OK [UIDNEXT ${mailbox.uidNext.value}] Predicted next UID\r\n`);
  }
  if (mailbox.highestModseq.kind === "known") {
    lines.push(`* OK [HIGHESTMODSEQ ${mailbox.highestModseq.value}] Highest modseq\r\n`);
  } else {
    lines.push("* OK [NOMODSEQ] Mod-sequences unavailable\r\n");
  }
  return lines.join("");
}

function selectResponse(tag: string, mailbox: MutableMailbox, readOnly: boolean): string {
  const unseen = mailbox.messages.findIndex((message) => !message.flags.has("\\Seen"));
  return [
    "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n",
    "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Seen \\Draft \\*)] Flags permitted\r\n",
    `* ${mailbox.messages.length} EXISTS\r\n`,
    "* 0 RECENT\r\n",
    unseen >= 0 ? `* OK [UNSEEN ${unseen + 1}] First unseen\r\n` : "",
    epochResponse(mailbox),
    `${tag} OK [${readOnly ? "READ-ONLY" : "READ-WRITE"}] ${readOnly ? "EXAMINE" : "SELECT"} completed\r\n`,
  ].join("");
}

function parseUidSet(value: string, mailbox: MutableMailbox): number[] {
  const token = value.trim().split(/\s+/u)[0] ?? "";
  const result = new Set<number>();
  for (const piece of token.split(",")) {
    const range = /^(\d+|\*):(\d+|\*)$/u.exec(piece);
    if (range !== null) {
      const maximum = mailbox.messages.at(-1)?.uid ?? 0;
      const left = range[1] === "*" ? maximum : Number(range[1]);
      const right = range[2] === "*" ? maximum : Number(range[2]);
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      for (const message of mailbox.messages) {
        if (message.uid >= start && message.uid <= end) result.add(message.uid);
      }
      continue;
    }
    const uid = piece === "*" ? (mailbox.messages.at(-1)?.uid ?? 0) : Number(piece);
    if (Number.isSafeInteger(uid) && uid > 0) result.add(uid);
  }
  return [...result];
}

function addressParts(address: string): readonly [string, string] {
  const [mailbox, host] = address.split("@", 2);
  return [mailbox ?? "unknown", host ?? "example.test"];
}

function envelope(message: MutableMessage): string {
  const [fromMailbox, fromHost] = addressParts(message.from);
  const [toMailbox, toHost] = addressParts(message.to);
  const from = `((NIL NIL ${quoted(fromMailbox)} ${quoted(fromHost)}))`;
  const to = `((NIL NIL ${quoted(toMailbox)} ${quoted(toHost)}))`;
  return `(${quoted("Mon, 17 Aug 2026 12:00:00 +0000")} ${quoted(message.subject)} ${from} ${from} ${from} ${to} NIL NIL NIL ${quoted(`<demo-${message.uid}@example.test>`)})`;
}

function internalDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "17-Aug-2026 12:00:00 +0000";
  return "17-Aug-2026 12:00:00 +0000";
}

function fetchResponse(mailbox: MutableMailbox, argumentsText: string): string {
  const requested = parseUidSet(argumentsText, mailbox);
  const wantsSource = /BODY(?:\.PEEK)?\s*\[\s*\]/iu.test(argumentsText);
  const responses: string[] = [];
  for (const uid of requested) {
    const sequence = mailbox.messages.findIndex((candidate) => candidate.uid === uid);
    const message = sequence < 0 ? undefined : mailbox.messages[sequence];
    if (message === undefined) continue;
    const fields = [
      `UID ${message.uid}`,
      `FLAGS (${[...message.flags].join(" ")})`,
      `MODSEQ (${message.modseq})`,
      `RFC822.SIZE ${Buffer.byteLength(message.raw)}`,
      `INTERNALDATE ${quoted(internalDate(message.internalDate))}`,
      `ENVELOPE ${envelope(message)}`,
    ];
    if (wantsSource) {
      fields.push(`BODY[] {${Buffer.byteLength(message.raw)}}\r\n${message.raw}`);
    }
    responses.push(`* ${sequence + 1} FETCH (${fields.join(" ")})\r\n`);
  }
  return responses.join("");
}

function searchResponse(mailbox: MutableMailbox, argumentsText: string): string {
  const asksUnseen = /(?:^|\s)UNSEEN(?:\s|$)/iu.test(argumentsText);
  const asksSeen = !asksUnseen && /(?:^|\s)SEEN(?:\s|$)/iu.test(argumentsText);
  const uids = mailbox.messages
    .filter((message) =>
      asksUnseen ? !message.flags.has("\\Seen") : asksSeen ? message.flags.has("\\Seen") : true,
    )
    .map((message) => message.uid);
  return `* SEARCH${uids.length === 0 ? "" : ` ${uids.join(" ")}`}\r\n`;
}

function messageSequence(mailbox: MutableMailbox, uid: number): number {
  return mailbox.messages.findIndex((message) => message.uid === uid) + 1;
}

function nextDestinationUid(mailbox: MutableMailbox): number {
  if (mailbox.uidNext.kind === "known") return mailbox.uidNext.value;
  return (mailbox.messages.at(-1)?.uid ?? 0) + 1;
}

function advanceMailbox(mailbox: MutableMailbox, uid: number, modseq: bigint): void {
  if (mailbox.uidNext.kind === "known" && mailbox.uidNext.value <= uid)
    mailbox.uidNext = known(uid + 1);
  if (mailbox.highestModseq.kind === "known" && mailbox.highestModseq.value < modseq) {
    mailbox.highestModseq = known(modseq);
  }
}

function selectedMailbox(
  session: Session,
  mailboxes: Map<string, MutableMailbox>,
): MutableMailbox | null {
  if (session.state.kind !== "selected" && session.state.kind !== "idling") return null;
  return mailboxes.get(session.state.mailbox) ?? null;
}

function transitionServerLifecycle(
  state: ServerLifecycleState,
  event: ServerLifecycleEvent,
): ServerLifecycleState {
  switch (event.kind) {
    case "start-requested":
      if (state.kind !== "idle") throw new Error("demo IMAP server cannot start now");
      return Object.freeze({ kind: "starting", listener: event.listener });
    case "listener-ready":
      if (state.kind !== "starting") throw new Error("demo IMAP listener is not starting");
      return Object.freeze({ kind: "listening", listener: state.listener });
    case "close-requested":
      if (state.kind === "closing" || state.kind === "stopped") return state;
      return Object.freeze({
        kind: "closing",
        listener: state.kind === "idle" ? null : state.listener,
      });
    case "start-failed":
      if (state.kind !== "starting") throw new Error("demo IMAP listener did not fail to start");
      return Object.freeze({ kind: "stopped" });
    case "cleanup-completed":
      if (state.kind !== "closing") throw new Error("demo IMAP server is not closing");
      return Object.freeze({ kind: "stopped" });
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function lifecycleListener(state: ServerLifecycleState): Server | null {
  switch (state.kind) {
    case "starting":
    case "listening":
      return state.listener;
    case "closing":
      return state.listener;
    case "idle":
    case "stopped":
      return null;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function firstCommandTag(line: string): string {
  return /^\S+/u.exec(line)?.[0] ?? "*";
}

function literalDeclaration(
  line: string,
): Readonly<{ readonly bytes: bigint; readonly nonSynchronizing: boolean }> | null {
  const match = /\{(\d+)(\+)?\}$/u.exec(line.trimEnd());
  if (match?.[1] === undefined) return null;
  return Object.freeze({ bytes: BigInt(match[1]), nonSynchronizing: match[2] === "+" });
}

export function createDemoImapServer(options: DemoImapServerOptions = {}): DemoImapServer {
  const host = LOOPBACK_HOST;
  const port = normalizePort(options.port);
  const username = options.username ?? "demo-user";
  const password = options.password ?? "demo-pass";
  if (
    username.length === 0 ||
    password.length === 0 ||
    containsLineBreakOrNul(username + password)
  ) {
    throw new TypeError("demo authentication values are invalid");
  }

  const mailboxInputs = options.mailboxes ?? defaultMailboxes();
  const mailboxes = new Map<string, MutableMailbox>();
  for (const input of mailboxInputs) {
    const mailbox = mutableMailbox(input);
    if (mailboxes.has(mailbox.path)) throw new TypeError(`duplicate mailbox ${mailbox.path}`);
    mailboxes.set(mailbox.path, mailbox);
  }
  if (!mailboxes.has("INBOX")) throw new TypeError("demo IMAP requires INBOX");

  const sessions = new Set<Session>();
  const commands: DemoImapCommandRecord[] = [];
  const forbiddenCommands: string[] = [];
  const pendingTimers = new Set<TimerEntry>();
  const faults: DemoImapFault[] = [];
  let faultState: DemoImapFaultState = Object.freeze({ kind: "dormant" });
  let lifecycle: ServerLifecycleState = Object.freeze({ kind: "idle" });
  let closeRequested = false;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;

  const delay = (milliseconds: number, owner: Session | null): Promise<void> =>
    new Promise((resolve) => {
      let entry: TimerEntry;
      const complete = (): void => {
        pendingTimers.delete(entry);
        resolve();
      };
      entry = Object.freeze({
        handle: setTimeout(complete, milliseconds),
        resolve: complete,
        owner,
      });
      pendingTimers.add(entry);
    });

  const writeWire = async (
    session: Session,
    wire: string,
    throttle?: Extract<DemoImapFault, { kind: "throttle" }>,
  ): Promise<void> => {
    if (session.closed || session.admissionFailed || session.socket.destroyed) return;
    if (throttle === undefined) {
      session.socket.write(wire);
      return;
    }
    for (let offset = 0; offset < wire.length; offset += throttle.chunkBytes) {
      if (session.closed || session.admissionFailed || session.socket.destroyed) return;
      session.socket.write(wire.slice(offset, offset + throttle.chunkBytes));
      if (offset + throttle.chunkBytes < wire.length) {
        await delay(throttle.delayMilliseconds, session);
      }
    }
  };

  const closeSession = (session: Session): void => {
    if (session.closed) return;
    session.closed = true;
    session.input = EMPTY_BUFFER;
    session.literal = Object.freeze({ kind: "none" });
    for (const entry of pendingTimers) {
      if (entry.owner !== session) continue;
      clearTimeout(entry.handle);
      entry.resolve();
    }
    session.state = transitionDemoImapSession(session.state, { kind: "connection-closed" });
    sessions.delete(session);
  };

  const findFault = (command: DemoImapCommand): DemoImapFault | undefined => {
    const index = faults.findIndex(
      (fault) => fault.command === undefined || fault.command === command,
    );
    if (index < 0) return undefined;
    const [fault] = faults.splice(index, 1);
    return fault;
  };

  const notifyMailbox = async (mailbox: string, wire: string): Promise<void> => {
    await Promise.all(
      [...sessions]
        .filter(
          (session) =>
            !session.closed &&
            (session.state.kind === "selected" || session.state.kind === "idling") &&
            session.state.mailbox === mailbox,
        )
        .map((session) => writeWire(session, wire)),
    );
  };

  const mutateStore = (
    mailbox: MutableMailbox,
    argumentsText: string,
  ):
    | Readonly<{ readonly kind: "applied"; readonly response: string }>
    | Readonly<{ readonly kind: "missing" }>
    | Readonly<{ readonly kind: "modified"; readonly uid: number }>
    | Readonly<{ readonly kind: "forbidden" }> => {
    const uid = Number(argumentsText.trim().split(/\s+/u)[0]);
    const message = mailbox.messages.find((candidate) => candidate.uid === uid);
    if (message === undefined) return { kind: "missing" };
    const unchanged = /UNCHANGEDSINCE\s+(\d+)/iu.exec(argumentsText);
    if (unchanged?.[1] !== undefined && message.modseq > BigInt(unchanged[1])) {
      return { kind: "modified", uid };
    }
    const flagMatch = /([+-])FLAGS(?:\.SILENT)?\s+\(([^)]*)\)/iu.exec(argumentsText);
    if (flagMatch === null) return { kind: "forbidden" };
    const flags = flagMatch[2]?.trim().split(/\s+/u).filter(Boolean) ?? [];
    if (flags.some((flag) => flag.toUpperCase() === "\\DELETED")) return { kind: "forbidden" };
    for (const flag of flags) {
      if (flagMatch[1] === "+") message.flags.add(flag);
      else message.flags.delete(flag);
    }
    message.modseq += 1n;
    advanceMailbox(mailbox, message.uid, message.modseq);
    return {
      kind: "applied",
      response: `* ${messageSequence(mailbox, uid)} FETCH (UID ${uid} FLAGS (${[...message.flags].join(" ")}) MODSEQ (${message.modseq}))\r\n`,
    };
  };

  const handleCommand = async (
    session: Session,
    parsed: ParsedCommand,
  ): Promise<CommandResponse> => {
    const { tag, normalized: command, argumentsText } = parsed;
    if (command === null) {
      if (FORBIDDEN_COMMANDS.has(parsed.command) || parsed.command.includes("EXPUNGE")) {
        forbiddenCommands.push(parsed.command);
      }
      return { wire: `${tag} BAD [CANNOT] Unsupported command\r\n` };
    }
    switch (command) {
      case "CAPABILITY":
        return { wire: `* CAPABILITY ${CAPABILITIES}\r\n${tag} OK CAPABILITY completed\r\n` };
      case "LOGIN": {
        if (session.state.kind !== "not-authenticated")
          return { wire: `${tag} BAD Already authenticated\r\n` };
        const tokens = argumentsText.match(/"(?:[^"\\]|\\.)*"|\S+/gu) ?? [];
        if (unquote(tokens[0] ?? "") !== username || unquote(tokens[1] ?? "") !== password) {
          return { wire: `${tag} NO [AUTHENTICATIONFAILED] Authentication failed\r\n` };
        }
        session.state = transitionDemoImapSession(session.state, {
          kind: "authentication-succeeded",
        });
        return { wire: `${tag} OK [CAPABILITY ${CAPABILITIES}] LOGIN completed\r\n` };
      }
      case "NAMESPACE":
        return session.state.kind === "not-authenticated"
          ? { wire: `${tag} BAD Authenticate first\r\n` }
          : { wire: `* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n` };
      case "ENABLE": {
        if (session.state.kind !== "authenticated")
          return { wire: `${tag} BAD ENABLE unavailable\r\n` };
        const enabled = ["CONDSTORE", "UTF8=ACCEPT"].filter((value) =>
          argumentsText.toUpperCase().includes(value),
        );
        return { wire: `* ENABLED ${enabled.join(" ")}\r\n${tag} OK ENABLE completed\r\n` };
      }
      case "LIST":
      case "LSUB":
        return session.state.kind === "not-authenticated"
          ? { wire: `${tag} BAD Authenticate first\r\n` }
          : {
              wire: `${listResponse(command, mailboxes.values())}${tag} OK ${command} completed\r\n`,
            };
      case "SELECT":
      case "EXAMINE": {
        if (session.state.kind === "not-authenticated" || session.state.kind === "idling") {
          return { wire: `${tag} BAD SELECT unavailable\r\n` };
        }
        const path = unquote(argumentsText);
        const mailbox = mailboxes.get(path);
        if (mailbox === undefined) return { wire: `${tag} NO [NONEXISTENT] Mailbox missing\r\n` };
        if (!mailbox.selectable)
          return { wire: `${tag} NO [CANNOT] Mailbox is not selectable\r\n` };
        session.state = transitionDemoImapSession(session.state, {
          kind: "mailbox-selected",
          mailbox: path,
          readOnly: command === "EXAMINE",
        });
        return { wire: selectResponse(tag, mailbox, command === "EXAMINE") };
      }
      case "UID SEARCH": {
        const mailbox = selectedMailbox(session, mailboxes);
        return mailbox === null
          ? { wire: `${tag} BAD Select a mailbox first\r\n` }
          : { wire: `${searchResponse(mailbox, argumentsText)}${tag} OK SEARCH completed\r\n` };
      }
      case "UID FETCH": {
        const mailbox = selectedMailbox(session, mailboxes);
        return mailbox === null
          ? { wire: `${tag} BAD Select a mailbox first\r\n` }
          : { wire: `${fetchResponse(mailbox, argumentsText)}${tag} OK FETCH completed\r\n` };
      }
      case "UID STORE": {
        const mailbox = selectedMailbox(session, mailboxes);
        if (mailbox === null) return { wire: `${tag} BAD Select a mailbox first\r\n` };
        if (session.state.kind === "selected" && session.state.readOnly) {
          return { wire: `${tag} NO [READ-ONLY] Mailbox is read-only\r\n` };
        }
        const result = mutateStore(mailbox, argumentsText);
        if (result.kind === "missing") {
          return {
            wire: `${tag} NO [NONEXISTENT] Some of the requested messages no longer exist\r\n`,
          };
        }
        if (result.kind === "modified") {
          return { wire: `${tag} OK [MODIFIED ${result.uid}] Conditional STORE not applied\r\n` };
        }
        if (result.kind === "forbidden") {
          forbiddenCommands.push("UID STORE \\Deleted");
          return { wire: `${tag} BAD [CANNOT] Deleted flags are disabled\r\n` };
        }
        return { wire: `${result.response}${tag} OK STORE completed\r\n` };
      }
      case "UID MOVE": {
        const source = selectedMailbox(session, mailboxes);
        if (source === null) return { wire: `${tag} BAD Select a mailbox first\r\n` };
        const parts = argumentsText.match(/"(?:[^"\\]|\\.)*"|\S+/gu) ?? [];
        const uid = Number(parts[0]);
        const destinationPath = unquote(parts[1] ?? "");
        const destination = mailboxes.get(destinationPath);
        const sourceIndex = source.messages.findIndex((message) => message.uid === uid);
        const message = sourceIndex < 0 ? undefined : source.messages[sourceIndex];
        if (message === undefined) return { wire: `${tag} NO [NONEXISTENT] Message missing\r\n` };
        if (destination === undefined || !destination.selectable) {
          return { wire: `${tag} NO [TRYCREATE] Destination unavailable\r\n` };
        }
        const destinationUid = nextDestinationUid(destination);
        source.messages.splice(sourceIndex, 1);
        destination.messages.push({
          ...message,
          uid: destinationUid,
          flags: new Set(message.flags),
        });
        destination.messages.sort((left, right) => left.uid - right.uid);
        advanceMailbox(destination, destinationUid, message.modseq);
        const uidValidity =
          destination.uidValidity.kind === "known" ? destination.uidValidity.value : 1;
        return {
          wire: `* ${sourceIndex + 1} EXPUNGE\r\n${tag} OK [COPYUID ${uidValidity} ${uid} ${destinationUid}] MOVE completed\r\n`,
        };
      }
      case "IDLE": {
        if (session.state.kind !== "selected")
          return { wire: `${tag} BAD Select a mailbox first\r\n` };
        session.state = transitionDemoImapSession(session.state, {
          kind: "idle-started",
          idleTag: tag,
        });
        return { wire: "+ idling\r\n" };
      }
      case "NOOP":
        return { wire: `${tag} OK NOOP completed\r\n` };
      case "LOGOUT":
        return { wire: `* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`, closeAfter: true };
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  };

  const processCommand = async (session: Session, parsed: ParsedCommand): Promise<void> => {
    commands.push({ command: parsed.command, sessionState: session.state.kind });
    const command = parsed.normalized;
    if (command === null) {
      const response = await handleCommand(session, parsed);
      await writeWire(session, response.wire);
      return;
    }
    const fault = findFault(command);
    if (fault !== undefined) {
      faultState = beginDemoImapFault(scheduleDemoImapFault(fault), command);
      if (fault.kind === "latency") await delay(fault.milliseconds, session);
      if (fault.kind === "disconnect" && fault.phase === "before-response") {
        faultState = completeDemoImapFault(faultState);
        session.socket.destroy();
        return;
      }
      if (fault.kind === "scripted-failure") {
        await writeWire(
          session,
          `${parsed.tag} ${fault.status} [${fault.code}] Scripted failure\r\n`,
        );
        faultState = completeDemoImapFault(faultState);
        return;
      }
      if (fault.kind === "cancel") {
        await writeWire(session, `${parsed.tag} BAD [CLIENTBUG] Scripted cancellation\r\n`);
        faultState = completeDemoImapFault(faultState);
        return;
      }
    }

    const response = await handleCommand(session, parsed);
    if (fault?.kind === "partial-response") {
      session.socket.write(response.wire.slice(0, fault.bytes));
      faultState = completeDemoImapFault(faultState);
      session.socket.destroy();
      return;
    }
    if (fault?.kind === "disconnect" && fault.phase === "after-effect") {
      faultState = completeDemoImapFault(faultState);
      session.socket.destroy();
      return;
    }
    await writeWire(session, response.wire, fault?.kind === "throttle" ? fault : undefined);
    if (fault !== undefined) faultState = completeDemoImapFault(faultState);
    if (response.closeAfter === true) session.socket.end();
  };

  const handleLine = async (session: Session, line: string): Promise<void> => {
    if (session.closed) return;
    if (line.trim().toUpperCase() === "DONE") {
      if (session.state.kind !== "idling") {
        await writeWire(session, "* BAD No IDLE command is active\r\n");
        return;
      }
      const tag = session.state.idleTag;
      session.state = transitionDemoImapSession(session.state, { kind: "idle-completed" });
      await writeWire(session, `${tag} OK IDLE completed\r\n`);
      return;
    }
    if (session.state.kind === "idling") {
      await writeWire(session, "* BAD Send DONE before another command\r\n");
      return;
    }
    const parsed = parseCommand(line);
    if (parsed === null) {
      await writeWire(session, "* BAD Malformed command\r\n");
      return;
    }
    await processCommand(session, parsed);
  };

  const rejectAdmission = (session: Session, reason: string): void => {
    if (session.admissionFailed || session.closed) return;
    session.admissionFailed = true;
    session.input = EMPTY_BUFFER;
    session.literal = Object.freeze({ kind: "none" });
    session.socket.pause();
    session.socket.write(`* BYE [LIMIT] ${reason}\r\n`);
    session.socket.destroy();
  };

  const reserveOutstandingCommand = (session: Session, bytes: number): boolean => {
    if (session.inFlightCommands >= DEMO_IMAP_ADMISSION_LIMITS.maxQueuedCommands) {
      rejectAdmission(session, "Too many queued commands");
      return false;
    }
    if (
      session.input.length + session.inFlightBytes + bytes >
      DEMO_IMAP_ADMISSION_LIMITS.maxBufferedBytes
    ) {
      rejectAdmission(session, "Buffered command bytes exceeded");
      return false;
    }
    session.inFlightCommands += 1;
    session.inFlightBytes += bytes;
    return true;
  };

  const releaseOutstandingCommand = (session: Session, bytes: number): void => {
    session.inFlightCommands = Math.max(0, session.inFlightCommands - 1);
    session.inFlightBytes = Math.max(0, session.inFlightBytes - bytes);
  };

  const launchAdmittedLine = (session: Session, line: string, bytes: number): void => {
    if (!reserveOutstandingCommand(session, bytes)) return;
    void handleLine(session, line)
      .catch(() => session.socket.destroy())
      .finally(() => releaseOutstandingCommand(session, bytes));
  };

  const completeLiteral = (session: Session): void => {
    const literal = session.literal;
    if (literal.kind !== "discarding") return;
    session.literal = Object.freeze({ kind: "none" });
    void writeWire(
      session,
      `${literal.tag} BAD [CANNOT] Literal commands are unsupported\r\n`,
    ).finally(() => releaseOutstandingCommand(session, literal.headerBytes));
  };

  const processAdmittedInput = (session: Session): void => {
    while (!session.closed && !session.admissionFailed) {
      if (session.literal.kind === "discarding") {
        const literal = session.literal;
        if (literal.remaining > 0) {
          if (session.input.length === 0) return;
          const consumed = Math.min(literal.remaining, session.input.length);
          literal.remaining -= consumed;
          session.input = session.input.subarray(consumed);
          continue;
        }
        if (session.input.length === 0) return;
        if (literal.terminatorBytes === 0) {
          if (session.input[0] !== 13) {
            rejectAdmission(session, "Literal terminator is invalid");
            return;
          }
          literal.terminatorBytes = 1;
          session.input = session.input.subarray(1);
          continue;
        }
        if (session.input[0] !== 10) {
          rejectAdmission(session, "Literal terminator is invalid");
          return;
        }
        session.input = session.input.subarray(1);
        completeLiteral(session);
        continue;
      }

      const end = session.input.indexOf("\r\n");
      if (end < 0) {
        const permittedPartialTerminator =
          session.input.length === DEMO_IMAP_ADMISSION_LIMITS.maxLineBytes + 1 &&
          session.input.at(-1) === 13;
        if (
          session.input.length > DEMO_IMAP_ADMISSION_LIMITS.maxLineBytes &&
          !permittedPartialTerminator
        ) {
          rejectAdmission(session, "Command line is too long");
        }
        return;
      }
      if (end > DEMO_IMAP_ADMISSION_LIMITS.maxLineBytes) {
        rejectAdmission(session, "Command line is too long");
        return;
      }
      const lineBuffer = session.input.subarray(0, end);
      session.input = session.input.subarray(end + 2);
      const line = lineBuffer.toString("utf8");
      const declaration = literalDeclaration(line);
      if (declaration === null) {
        launchAdmittedLine(session, line, end);
        continue;
      }
      if (declaration.bytes > BigInt(DEMO_IMAP_ADMISSION_LIMITS.maxLiteralBytes)) {
        rejectAdmission(session, "Literal is too large");
        return;
      }
      if (!reserveOutstandingCommand(session, end)) return;
      session.literal = {
        kind: "discarding",
        tag: firstCommandTag(line),
        headerBytes: end,
        remaining: Number(declaration.bytes),
        terminatorBytes: 0,
      };
      if (!declaration.nonSynchronizing) session.socket.write("+ literal accepted\r\n");
    }
  };

  const admitBytes = (session: Session, chunk: Buffer): void => {
    if (session.closed || session.admissionFailed) return;
    if (
      session.input.length + session.inFlightBytes + chunk.length >
      DEMO_IMAP_ADMISSION_LIMITS.maxBufferedBytes
    ) {
      rejectAdmission(session, "Buffered command bytes exceeded");
      return;
    }
    session.input =
      session.input.length === 0
        ? chunk
        : Buffer.concat([session.input, chunk], session.input.length + chunk.length);
    processAdmittedInput(session);
  };

  const accept = (socket: Socket): void => {
    if (lifecycle.kind !== "listening") {
      socket.destroy();
      return;
    }
    const remoteAddress = socket.remoteAddress;
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") {
      socket.destroy();
      return;
    }
    const session: Session = {
      socket,
      state: Object.freeze({ kind: "not-authenticated" }),
      input: EMPTY_BUFFER,
      inFlightCommands: 0,
      inFlightBytes: 0,
      admissionFailed: false,
      literal: Object.freeze({ kind: "none" }),
      closed: false,
    };
    sessions.add(session);
    socket.on("data", (chunk) => {
      admitBytes(session, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      closeSession(session);
      socket.removeAllListeners();
    });
    socket.write(`* OK [CAPABILITY ${CAPABILITIES}] Agent Mail demo ready\r\n`);
  };

  const releasePort = (): Promise<void> => {
    releasePromise ??= Promise.resolve().then(async () => options.releasePort?.());
    return releasePromise;
  };

  const closeListener = (listener: Server): Promise<void> => {
    if (!listener.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      listener.close((error?: Error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  };

  const cleanupOwnedResources = async (listener: Server | null): Promise<void> => {
    const errors: unknown[] = [];
    try {
      for (const entry of pendingTimers) {
        clearTimeout(entry.handle);
        entry.resolve();
      }
      for (const session of sessions) session.socket.destroy();
      for (const session of sessions) {
        closeSession(session);
        session.socket.removeAllListeners();
      }
      faults.splice(0);
    } catch (error: unknown) {
      errors.push(error);
    }
    if (listener !== null) {
      try {
        await closeListener(listener);
      } catch (error: unknown) {
        errors.push(error);
      } finally {
        listener.removeAllListeners();
      }
    }
    if (lifecycle.kind === "closing") {
      lifecycle = transitionServerLifecycle(lifecycle, { kind: "cleanup-completed" });
    } else if (lifecycle.kind === "starting") {
      lifecycle = transitionServerLifecycle(lifecycle, { kind: "start-failed" });
    }
    try {
      await releasePort();
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "demo IMAP cleanup failed");
  };

  const start = (): Promise<void> => {
    if (closeRequested || lifecycle.kind === "closing" || lifecycle.kind === "stopped") {
      return Promise.reject(new Error("demo IMAP server is closed"));
    }
    if (lifecycle.kind === "listening") return Promise.resolve();
    if (lifecycle.kind === "starting") {
      if (startPromise === undefined) {
        return Promise.reject(new Error("demo IMAP start serialization failed"));
      }
      return startPromise;
    }

    const listener = createServer(accept);
    lifecycle = transitionServerLifecycle(lifecycle, { kind: "start-requested", listener });
    startPromise = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            listener.off("listening", onListening);
            reject(error);
          };
          const onListening = (): void => {
            listener.off("error", onError);
            resolve();
          };
          listener.once("error", onError);
          listener.once("listening", onListening);
          listener.listen({ host, port, exclusive: true });
        });
        lifecycle = transitionServerLifecycle(lifecycle, { kind: "listener-ready" });
        listener.on("error", () => {
          void close().catch(() => undefined);
        });
      } catch (error: unknown) {
        try {
          await cleanupOwnedResources(listener);
        } catch (cleanupError: unknown) {
          throw new AggregateError([error, cleanupError], "demo IMAP start rollback failed");
        }
        throw error;
      }
    })();
    return startPromise;
  };

  const close = (): Promise<void> => {
    closeRequested = true;
    closePromise ??= (async () => {
      if (startPromise !== undefined) {
        try {
          await startPromise;
        } catch {
          return;
        }
      }
      const listener = lifecycleListener(lifecycle);
      lifecycle = transitionServerLifecycle(lifecycle, { kind: "close-requested" });
      await cleanupOwnedResources(listener);
    })();
    return closePromise;
  };

  const scheduleFault = (fault: DemoImapFault): void => {
    validateFault(fault);
    faults.push(Object.freeze(fault));
    faultState = scheduleDemoImapFault(fault);
  };

  const applyMailboxEvent = async (event: DemoImapMailboxEvent): Promise<void> => {
    switch (event.kind) {
      case "mail-arrived": {
        const mailbox = mailboxes.get(event.mailbox);
        if (mailbox === undefined || !mailbox.selectable)
          throw new Error("arrival mailbox unavailable");
        validateMessage(event.message);
        if (mailbox.messages.some((message) => message.uid === event.message.uid)) {
          throw new Error("arrival UID already exists");
        }
        mailbox.messages.push({ ...event.message, flags: new Set(event.message.flags ?? []) });
        mailbox.messages.sort((left, right) => left.uid - right.uid);
        advanceMailbox(mailbox, event.message.uid, event.message.modseq);
        await notifyMailbox(mailbox.path, `* ${mailbox.messages.length} EXISTS\r\n`);
        return;
      }
      case "flags-changed": {
        const mailbox = mailboxes.get(event.mailbox);
        const message = mailbox?.messages.find((candidate) => candidate.uid === event.uid);
        if (mailbox === undefined || message === undefined)
          throw new Error("flag target unavailable");
        message.flags = new Set(event.flags);
        message.modseq += 1n;
        advanceMailbox(mailbox, message.uid, message.modseq);
        await notifyMailbox(
          mailbox.path,
          `* ${messageSequence(mailbox, message.uid)} FETCH (UID ${message.uid} FLAGS (${[...message.flags].join(" ")}) MODSEQ (${message.modseq}))\r\n`,
        );
        return;
      }
      case "message-moved": {
        const source = mailboxes.get(event.source);
        const destination = mailboxes.get(event.destination);
        const index = source?.messages.findIndex((message) => message.uid === event.uid) ?? -1;
        const message = index < 0 ? undefined : source?.messages[index];
        if (source === undefined || destination === undefined || message === undefined) {
          throw new Error("move target unavailable");
        }
        source.messages.splice(index, 1);
        const uid = nextDestinationUid(destination);
        destination.messages.push({ ...message, uid, flags: new Set(message.flags) });
        destination.messages.sort((left, right) => left.uid - right.uid);
        advanceMailbox(destination, uid, message.modseq);
        await notifyMailbox(source.path, `* ${index + 1} EXPUNGE\r\n`);
        await notifyMailbox(destination.path, `* ${destination.messages.length} EXISTS\r\n`);
        return;
      }
      case "message-disappeared": {
        const mailbox = mailboxes.get(event.mailbox);
        const index = mailbox?.messages.findIndex((message) => message.uid === event.uid) ?? -1;
        if (mailbox === undefined || index < 0) throw new Error("disappearance target unavailable");
        mailbox.messages.splice(index, 1);
        await notifyMailbox(mailbox.path, `* ${index + 1} EXPUNGE\r\n`);
        return;
      }
      case "epoch-changed": {
        const mailbox = mailboxes.get(event.mailbox);
        if (mailbox === undefined) throw new Error("epoch mailbox unavailable");
        mailbox.uidValidity = event.uidValidity;
        mailbox.uidNext = event.uidNext;
        mailbox.highestModseq = event.highestModseq;
        return;
      }
      case "reconnect-required":
        await Promise.all(
          [...sessions].map(async (session) => {
            await writeWire(session, `* BYE [ALERT] Demo reconnect required: ${event.reason}\r\n`);
            session.socket.destroy();
          }),
        );
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  };

  const mailboxSnapshot = (mailbox: MutableMailbox): DemoImapMailboxSnapshot =>
    Object.freeze({
      path: mailbox.path,
      selectable: mailbox.selectable,
      specialUse: mailbox.specialUse,
      uidValidity: mailbox.uidValidity,
      uidNext: mailbox.uidNext,
      highestModseq: mailbox.highestModseq,
      messages: Object.freeze(
        mailbox.messages.map((message) =>
          Object.freeze({
            uid: message.uid,
            flags: Object.freeze([...message.flags].sort()),
            modseq: message.modseq,
          }),
        ),
      ),
    });

  const snapshot = (): import("./types").DemoImapServerSnapshot => {
    const listener = lifecycleListener(lifecycle);
    return Object.freeze({
      listening: lifecycle.kind === "listening" && listener?.listening === true,
      port,
      activeSessions: sessions.size,
      activeSockets: [...sessions].filter((session) => !session.socket.destroyed).length,
      activeListeners:
        (listener?.eventNames().length ?? 0) +
        [...sessions].reduce((sum, session) => sum + session.socket.eventNames().length, 0),
      pendingTimers: pendingTimers.size,
      childProcesses: 0,
      activeTestLeases: activeDemoImapTestPortLeases(),
      commands: Object.freeze(commands.map((record) => Object.freeze({ ...record }))),
      forbiddenCommands: Object.freeze([...forbiddenCommands]),
      faultState,
      mailboxes: Object.freeze([...mailboxes.values()].map(mailboxSnapshot)),
    });
  };

  return Object.freeze({ host, port, start, close, scheduleFault, applyMailboxEvent, snapshot });
}
