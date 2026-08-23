import type { ImapFlowMailboxListClient } from "./mailbox-discovery";
import type { ImapFlowMetadataBatchClient } from "./metadata-batch";
import type { ImapFlowRawMessageDownloadClient } from "./raw-download";

export type ReadOnlyMailboxLock = Readonly<{
  readonly release: () => void | Promise<void>;
}>;

/**
 * The production-shaped portion of an already connected IMAP session used by
 * ordinary initial synchronization. Mutation methods are intentionally absent.
 */
export interface ReadOnlyImapClient
  extends ImapFlowMailboxListClient, ImapFlowMetadataBatchClient, ImapFlowRawMessageDownloadClient {
  readonly mailbox: unknown;
  readonly getMailboxLock: (
    path: string,
    options: Readonly<{ readonly readOnly: true }>,
  ) => Promise<unknown>;
  readonly search: (
    query: Readonly<{ readonly all: true }>,
    options: Readonly<{ readonly uid: true }>,
  ) => Promise<unknown>;
}

export type ReadOnlyImapSession = Readonly<{
  readonly client: ReadOnlyImapClient;
  /** Release the already-resolved connection authority. */
  readonly release: () => void | Promise<void>;
}>;

export type ReadOnlyImapSourceAuthority = Readonly<{
  readonly acquire: (input: Readonly<{ readonly signal: AbortSignal }>) => Promise<unknown>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callable(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return typeof value[key] === "function";
}

function projectIdentityProbe(value: unknown): unknown {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "id")) return value;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "seq" && key !== "uid" && key !== "size" && key !== "id")) {
    return value;
  }
  return Object.freeze({
    ...(Object.prototype.hasOwnProperty.call(value, "seq") ? { seq: value.seq } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "uid") ? { uid: value.uid } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "size") ? { size: value.size } : {}),
  });
}

function parseClient(value: unknown): ReadOnlyImapClient {
  if (!isRecord(value)) throw new TypeError("read-only IMAP client must be an object");
  for (const method of ["list", "getMailboxLock", "search", "fetchAll", "fetchOne", "download"]) {
    if (!callable(value, method)) {
      throw new TypeError(`read-only IMAP client is missing ${method}`);
    }
  }
  const source = value as unknown as ReadOnlyImapClient;
  return Object.freeze({
    get mailbox(): unknown {
      return source.mailbox;
    },
    list: () => source.list(),
    getMailboxLock: (path, options) => source.getMailboxLock(path, options),
    search: (query, options) => source.search(query, options),
    fetchAll: (range, query, options) => source.fetchAll(range, query, options),
    fetchOne: async (range, query, options) =>
      projectIdentityProbe(await source.fetchOne?.(range, query, options)),
    download: (range, part, options) => source.download(range, part, options),
  });
}

export function parseReadOnlyMailboxLock(value: unknown): ReadOnlyMailboxLock {
  if (!isRecord(value) || !callable(value, "release")) {
    throw new TypeError("read-only mailbox lock must provide release");
  }
  return value as unknown as ReadOnlyMailboxLock;
}

/**
 * Project the installed ImapFlow mailbox object onto the existing status
 * normalizer's credential-agnostic input. ImapFlow uses `false` to mean that
 * HIGHESTMODSEQ was not returned; omission preserves that fact as unknown.
 */
export function projectReadOnlyMailboxStatus(client: ReadOnlyImapClient): unknown {
  const value = client.mailbox;
  if (!isRecord(value)) throw new TypeError("read-only IMAP mailbox status is unavailable");
  return Object.freeze({
    ...(Object.prototype.hasOwnProperty.call(value, "uidValidity")
      ? { uidValidity: value.uidValidity }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "uidNext") ? { uidNext: value.uidNext } : {}),
    ...(value.highestModseq === false || value.highestModseq === undefined
      ? {}
      : { highestModseq: value.highestModseq }),
    ...(Object.prototype.hasOwnProperty.call(value, "flags") ? { flags: value.flags } : {}),
  });
}

function parseSession(value: unknown): ReadOnlyImapSession {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "client")) {
    throw new TypeError("read-only IMAP session is invalid");
  }
  if (!callable(value, "release")) {
    throw new TypeError("read-only IMAP session must provide release");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "client" && key !== "release")) {
    throw new TypeError("read-only IMAP session has unknown fields");
  }
  return Object.freeze({
    client: parseClient(value.client),
    release: value.release as () => void | Promise<void>,
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("IMAP session acquisition was aborted", "AbortError");
}

async function releaseRejectedSession(value: unknown): Promise<void> {
  if (!isRecord(value) || !callable(value, "release")) return;
  try {
    await (value.release as () => void | Promise<void>)();
  } catch {
    // Session validation remains the primary failure.
  }
}

/** Validate one injected authority and make its release exact-once. */
export async function acquireReadOnlyImapSession(
  authority: ReadOnlyImapSourceAuthority,
  signal: AbortSignal,
): Promise<ReadOnlyImapSession> {
  if (!isRecord(authority) || !callable(authority, "acquire")) {
    throw new TypeError("read-only IMAP source authority must provide acquire");
  }
  if (!(signal instanceof AbortSignal)) throw new TypeError("session signal is invalid");
  if (signal.aborted) throw abortReason(signal);

  const candidate = await authority.acquire({ signal });
  let acquired: ReadOnlyImapSession;
  try {
    acquired = parseSession(candidate);
  } catch (error: unknown) {
    await releaseRejectedSession(candidate);
    throw error;
  }
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    releasePromise ??= Promise.resolve(acquired.release());
    return releasePromise;
  };
  if (signal.aborted) {
    try {
      await release();
    } catch {
      // Acquisition cancellation remains the primary failure.
    }
    throw abortReason(signal);
  }
  return Object.freeze({ client: acquired.client, release });
}
