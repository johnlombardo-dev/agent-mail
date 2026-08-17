/**
 * The small part of an ImapFlow client used by mailbox discovery.
 *
 * Keeping this boundary narrower than the full client makes it impossible for
 * discovery to open a mailbox, fetch messages, or perform a remote mutation.
 */
export interface ImapFlowMailboxListClient {
  readonly list: () => Promise<unknown>;
}

export type MailboxIdentity = {
  /** The provider-decoded, canonical mailbox path. */
  readonly path: string;
  /** The provider hierarchy delimiter. `null` represents IMAP NIL. */
  readonly delimiter: string | null;
};

export type NormalizedMailbox = MailboxIdentity & {
  readonly flags: readonly string[];
  readonly specialUse: string | null;
};

/** A mailbox safe to hand to a later synchronization step. */
export type MailboxSynchronizationCandidate = NormalizedMailbox;

export type MailboxSkipReason = "noselect";

export type SkippedMailboxContainer = NormalizedMailbox & {
  readonly reason: MailboxSkipReason;
  /** The attribute that caused the row to be skipped. */
  readonly attribute: "\\Noselect";
};

export type MailboxDiscoveryResult = {
  readonly candidates: readonly MailboxSynchronizationCandidate[];
  readonly skipped: readonly SkippedMailboxContainer[];
};

export type MailboxDiscoveryErrorCode =
  | "invalid-client"
  | "invalid-mailbox-list"
  | "invalid-mailbox-row"
  | "invalid-mailbox-path"
  | "invalid-mailbox-delimiter"
  | "invalid-mailbox-flags"
  | "invalid-mailbox-special-use";

/** Stable adapter error that does not expose provider payloads. */
export class MailboxDiscoveryAdapterError extends TypeError {
  readonly code: MailboxDiscoveryErrorCode;

  constructor(code: MailboxDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "MailboxDiscoveryAdapterError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalText(value: unknown, code: MailboxDiscoveryErrorCode, name: string): string {
  if (typeof value !== "string") {
    throw new MailboxDiscoveryAdapterError(code, `${name} must be a string`);
  }
  const normalized = value.normalize("NFC");
  if (normalized.length === 0) {
    throw new MailboxDiscoveryAdapterError(code, `${name} must not be blank`);
  }
  return normalized;
}

function mailboxDelimiter(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const delimiter = canonicalText(value, "invalid-mailbox-delimiter", "mailbox delimiter");
  if ([...delimiter].length !== 1) {
    throw new MailboxDiscoveryAdapterError(
      "invalid-mailbox-delimiter",
      "mailbox delimiter must be one Unicode scalar",
    );
  }
  return delimiter;
}

function mailboxFlags(value: unknown): readonly string[] {
  const values: readonly unknown[] =
    value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new MailboxDiscoveryAdapterError(
      "invalid-mailbox-flags",
      "mailbox flags must be a Set or array",
    );
  }

  return values.map((item) => canonicalText(item, "invalid-mailbox-flags", "mailbox flag"));
}

function mailboxSpecialUse(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return canonicalText(value, "invalid-mailbox-special-use", "mailbox special-use flag");
}

function normalizeMailboxRow(value: unknown): NormalizedMailbox {
  if (!isRecord(value)) {
    throw new MailboxDiscoveryAdapterError(
      "invalid-mailbox-row",
      "mailbox list rows must be objects",
    );
  }

  return {
    path: canonicalText(value.path, "invalid-mailbox-path", "mailbox path"),
    delimiter: mailboxDelimiter(value.delimiter),
    flags: mailboxFlags(value.flags),
    specialUse: mailboxSpecialUse(value.specialUse),
  };
}

function isNoSelect(flags: readonly string[]): boolean {
  return flags.some((flag) => flag.toUpperCase() === "\\NOSELECT");
}

/**
 * Normalize one provider LIST result. This function has no network or
 * persistence effects and intentionally does not inspect mailbox path names.
 */
export function normalizeMailboxList(value: unknown): MailboxDiscoveryResult {
  if (!Array.isArray(value)) {
    throw new MailboxDiscoveryAdapterError(
      "invalid-mailbox-list",
      "mailbox list result must be an array",
    );
  }

  const candidates: MailboxSynchronizationCandidate[] = [];
  const skipped: SkippedMailboxContainer[] = [];

  for (const item of value) {
    const mailbox = normalizeMailboxRow(item);
    if (isNoSelect(mailbox.flags)) {
      skipped.push({ ...mailbox, reason: "noselect", attribute: "\\Noselect" });
    } else {
      candidates.push(mailbox);
    }
  }

  return { candidates, skipped };
}

/**
 * Perform exactly one read-only mailbox LIST call, then normalize its rows.
 * The injected client is deliberately shaped around only ImapFlow's `list()`.
 */
export async function discoverMailboxes(
  client: ImapFlowMailboxListClient,
): Promise<MailboxDiscoveryResult> {
  if (typeof client !== "object" || client === null || typeof client.list !== "function") {
    throw new MailboxDiscoveryAdapterError(
      "invalid-client",
      "mailbox discovery requires an ImapFlow-shaped list client",
    );
  }
  return normalizeMailboxList(await client.list());
}
