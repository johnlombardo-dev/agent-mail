import {
  ImapBackendError,
  type IImapAppendInput,
  type IImapAuthenticationRequest,
  type IImapCopyResult,
  type IImapMailbox,
  type IImapMessage,
  type IImapPrincipal,
  type TImapFlagMutationMode,
  type TImapMailboxChangeListener,
} from "@push.rocks/smartimap";
import {
  createCorpusDigest,
  type CorpusBodyPart,
  type CorpusMessage,
  type DemoCorpus,
} from "../corpus";
import {
  DEMO_IMAP_HOST,
  DEMO_IMAP_PASSWORD,
  DEMO_IMAP_SELECTION_SIZE,
  DEMO_IMAP_USERNAME,
  type DemoImapBackend,
  type DemoImapRenderedMailbox,
  type DemoImapRenderedMessage,
  type DemoImapSnapshot,
} from "./types";

const DEMO_PRINCIPAL_ID = "demo-principal";
const READ_ONLY_MESSAGE = "Demo IMAP backend is read-only.";

function unsupportedMutation(): ImapBackendError {
  return new ImapBackendError(READ_ONLY_MESSAGE, "NOPERM");
}

function requirePrincipal(principalId: string): void {
  if (principalId !== DEMO_PRINCIPAL_ID) {
    throw new ImapBackendError("Principal is not authorized for the demo mailbox.", "NOPERM");
  }
}

function safeHeaderValue(value: string, fallback: string): string {
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    const forbidden =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0 && code <= 0x08) ||
      (code >= 0x0b && code <= 0x0c) ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    sanitized += forbidden ? " " : character;
  }
  const normalized = sanitized.trim();
  return normalized.length === 0 ? fallback : normalized;
}

function bodyText(message: CorpusMessage): string {
  return message.parts
    .map((part: CorpusBodyPart): string => {
      switch (part.kind) {
        case "text":
          return part.text;
        case "html":
          return part.html;
        case "alternative":
          return part.text;
        case "inline":
          return `[inline ${part.mediaType}; ${part.contentId}]`;
        case "attachment":
          return `[attachment ${part.filename}; ${part.mediaType}; ${part.contentDigest}]`;
      }
    })
    .join("\r\n");
}

function renderRfc5322(message: CorpusMessage): Uint8Array {
  const subject = safeHeaderValue(message.headers.subject ?? "", `Synthetic ${message.uid}`);
  const from = safeHeaderValue(message.headers.from ?? "", "sender@example.test");
  const to = safeHeaderValue(message.headers.to ?? "", "recipient@example.test");
  const messageId = safeHeaderValue(message.messageId, `<demo-${message.uid}@example.test>`);
  const date = new Date(message.internalDate);
  if (Number.isNaN(date.getTime())) throw new TypeError("corpus internal date is invalid");
  const headers = [
    `Message-ID: ${messageId}`,
    `Date: ${date.toUTCString()}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
  ];
  if (message.relationship.kind !== "root") {
    headers.push(
      `In-Reply-To: ${safeHeaderValue(message.relationship.inReplyTo, messageId)}`,
      `References: ${message.relationship.references.map((value) => safeHeaderValue(value, messageId)).join(" ")}`,
    );
  }
  headers.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  );
  const source = [...headers, "", bodyText(message), ""].join("\r\n");
  return new TextEncoder().encode(source);
}

function protocolMessage(message: DemoImapRenderedMessage): IImapMessage {
  return Object.freeze({
    id: message.sourceId,
    uid: message.uid,
    flags: [...message.flags],
    internalDate: new Date(message.internalDate),
    raw: new Uint8Array(message.raw),
  });
}

function cloneRenderedMessage(message: DemoImapRenderedMessage): DemoImapRenderedMessage {
  const raw = new Uint8Array(message.raw);
  return Object.freeze({
    sourceId: message.sourceId,
    sourceMessageId: message.sourceMessageId,
    mailboxId: message.mailboxId,
    uid: message.uid,
    flags: Object.freeze([...message.flags]),
    internalDate: message.internalDate,
    rawDigest: message.rawDigest,
    raw,
    protocol: Object.freeze({
      id: message.protocol.id,
      uid: message.protocol.uid,
      flags: [...message.protocol.flags],
      internalDate: new Date(message.protocol.internalDate),
      raw: new Uint8Array(message.protocol.raw),
    }),
  });
}

function cloneSnapshot(snapshot: DemoImapSnapshot): DemoImapSnapshot {
  return Object.freeze({
    corpusVersion: snapshot.corpusVersion,
    corpusSeed: snapshot.corpusSeed,
    selectedMessageIds: Object.freeze([...snapshot.selectedMessageIds]),
    mailboxes: Object.freeze(
      snapshot.mailboxes.map((mailbox) =>
        Object.freeze({
          sourceId: mailbox.sourceId,
          sourceName: mailbox.sourceName,
          protocol: Object.freeze({
            id: mailbox.protocol.id,
            name: mailbox.protocol.name,
            delimiter: mailbox.protocol.delimiter,
            attributes: [...mailbox.protocol.attributes],
            subscribed: mailbox.protocol.subscribed,
            uidValidity: mailbox.protocol.uidValidity,
            uidNext: mailbox.protocol.uidNext,
          }),
          messages: Object.freeze(mailbox.messages.map(cloneRenderedMessage)),
        }),
      ),
    ),
  });
}

function renderMessage(message: CorpusMessage): DemoImapRenderedMessage {
  const raw = renderRfc5322(message);
  return Object.freeze({
    sourceId: message.id,
    sourceMessageId: message.messageId,
    mailboxId: message.mailboxId,
    uid: message.uid,
    flags: Object.freeze([...message.flags]),
    internalDate: message.internalDate,
    rawDigest: createCorpusDigest(raw),
    raw,
    protocol: Object.freeze({
      id: message.id,
      uid: message.uid,
      flags: [...message.flags],
      internalDate: new Date(message.internalDate),
      raw: new Uint8Array(raw),
    }),
  });
}

function mailboxAttributes(name: string): readonly string[] {
  return Object.freeze(name === "Archive" ? ["\\Archive"] : []);
}

function mailboxSubscribed(name: string): boolean {
  return name.toUpperCase() === "INBOX";
}

function renderedMailbox(
  source: DemoCorpus["mailboxes"][number],
  messages: readonly DemoImapRenderedMessage[],
): DemoImapRenderedMailbox {
  const maximumUid = messages.reduce((maximum, message) => Math.max(maximum, message.uid), 0);
  const protocol = Object.freeze({
    id: source.id,
    name: source.name,
    delimiter: "/",
    attributes: [...mailboxAttributes(source.name)],
    subscribed: mailboxSubscribed(source.name),
    uidValidity: source.uidValidity,
    uidNext: source.uidNext ?? maximumUid + 1,
  });
  return Object.freeze({
    sourceId: source.id,
    sourceName: source.name,
    protocol,
    messages: Object.freeze(
      [...messages]
        .sort((left, right) => left.uid - right.uid)
        .map((message) => cloneRenderedMessage(message)),
    ),
  });
}

export function createDemoImapSnapshot(corpus: DemoCorpus): DemoImapSnapshot {
  const selected = corpus.messages.slice(
    0,
    Math.min(DEMO_IMAP_SELECTION_SIZE, corpus.messages.length),
  );
  const rendered = selected.filter((message) => !message.tombstone).map(renderMessage);
  const mailboxes = corpus.mailboxes.map((mailbox) =>
    renderedMailbox(
      mailbox,
      rendered.filter((message) => message.mailboxId === mailbox.id),
    ),
  );
  return Object.freeze({
    corpusVersion: corpus.scenarioVersion,
    corpusSeed: corpus.seed,
    selectedMessageIds: Object.freeze(selected.map((message) => message.id)),
    mailboxes: Object.freeze(mailboxes),
  });
}

class ReadOnlyDemoImapBackend implements DemoImapBackend {
  readonly #snapshot: DemoImapSnapshot;
  readonly #mailboxes: ReadonlyMap<string, DemoImapRenderedMailbox>;

  constructor(snapshot: DemoImapSnapshot) {
    this.#snapshot = cloneSnapshot(snapshot);
    this.#mailboxes = new Map(
      this.#snapshot.mailboxes.map((mailbox) => [mailbox.protocol.id, mailbox]),
    );
  }

  snapshot(): DemoImapSnapshot {
    return cloneSnapshot(this.#snapshot);
  }

  async listMailboxes(principalId: string): Promise<IImapMailbox[]> {
    requirePrincipal(principalId);
    return this.#snapshot.mailboxes.map((mailbox) => ({
      ...mailbox.protocol,
      attributes: [...mailbox.protocol.attributes],
    }));
  }

  async getMailboxByName(principalId: string, name: string): Promise<IImapMailbox | null> {
    requirePrincipal(principalId);
    const mailbox = this.#snapshot.mailboxes.find((candidate) => candidate.protocol.name === name);
    return mailbox === undefined
      ? null
      : { ...mailbox.protocol, attributes: [...mailbox.protocol.attributes] };
  }

  async getMessages(principalId: string, mailboxId: string): Promise<IImapMessage[]> {
    requirePrincipal(principalId);
    const mailbox = this.#mailboxes.get(mailboxId);
    if (mailbox === undefined) throw new ImapBackendError("Mailbox does not exist.", "NONEXISTENT");
    return mailbox.messages.map(protocolMessage);
  }

  async appendMessage(
    _principalId: string,
    _mailboxId: string,
    _input: IImapAppendInput,
  ): Promise<IImapMessage> {
    throw unsupportedMutation();
  }

  async updateFlags(
    _principalId: string,
    _mailboxId: string,
    _uids: number[],
    _mode: TImapFlagMutationMode,
    _flags: string[],
  ): Promise<IImapMessage[]> {
    throw unsupportedMutation();
  }

  async copyMessages(
    _principalId: string,
    _sourceMailboxId: string,
    _destinationMailboxId: string,
    _uids: number[],
  ): Promise<IImapCopyResult[]> {
    throw unsupportedMutation();
  }

  async moveMessages(
    _principalId: string,
    _sourceMailboxId: string,
    _destinationMailboxId: string,
    _uids: number[],
  ): Promise<IImapCopyResult[]> {
    throw unsupportedMutation();
  }

  async expungeMessages(
    _principalId: string,
    _mailboxId: string,
    _uids?: number[],
  ): Promise<number[]> {
    throw unsupportedMutation();
  }

  async createMailbox(_principalId: string, _name: string): Promise<IImapMailbox> {
    throw unsupportedMutation();
  }

  async deleteMailbox(_principalId: string, _mailboxId: string): Promise<void> {
    throw unsupportedMutation();
  }

  async renameMailbox(
    _principalId: string,
    _mailboxId: string,
    _newName: string,
  ): Promise<IImapMailbox> {
    throw unsupportedMutation();
  }

  async setSubscribed(
    _principalId: string,
    _mailboxId: string,
    _subscribed: boolean,
  ): Promise<void> {
    throw unsupportedMutation();
  }

  subscribeChanges(principalId: string, _listener: TImapMailboxChangeListener): () => void {
    requirePrincipal(principalId);
    return () => undefined;
  }
}

export function createDemoImapBackend(corpus: DemoCorpus): DemoImapBackend {
  return new ReadOnlyDemoImapBackend(createDemoImapSnapshot(corpus));
}

export function authenticateDemoImap(
  request: IImapAuthenticationRequest,
  username: string,
  password: string,
): IImapPrincipal | null {
  if (
    request.remoteAddress !== undefined &&
    request.remoteAddress !== DEMO_IMAP_HOST &&
    request.remoteAddress !== "::ffff:127.0.0.1" &&
    request.remoteAddress !== "::1"
  )
    return null;
  if (request.mechanism !== "LOGIN" && request.mechanism !== "PLAIN") return null;
  return request.username === username && request.secret === password
    ? Object.freeze({ id: DEMO_PRINCIPAL_ID, username })
    : null;
}

export const DEFAULT_DEMO_IMAP_CREDENTIALS = Object.freeze({
  username: DEMO_IMAP_USERNAME,
  password: DEMO_IMAP_PASSWORD,
});
