import {
  createAccountId,
  createMailboxId,
  createMonotonicSequence,
  createRemoteUidValue,
  createUidValidity,
  type AccountId,
  type MailboxId,
  type MonotonicSequence,
  type RemoteUidValue,
  type UidValidity,
} from "@agent-mail/core";

/** ImapFlow always includes MODSEQ when CONDSTORE is available for the selected mailbox. */
export const IMAP_PRECONDITION_FETCH_QUERY = Object.freeze({ uid: true });
/** Acquire an exclusive read-only selection lock; no caller can race a reselect during FETCH. */
export const IMAP_PRECONDITION_LOCK_OPTIONS = Object.freeze({ readOnly: true });

export type ImapPreconditionFetchOptions = Readonly<{ readonly uid: true }>;

export type ImapPreconditionMailboxLock = Readonly<{ readonly release: () => void }>;

/** The only ImapFlow operations permitted by this adapter. */
export interface ImapFlowPreconditionClient {
  readonly getMailboxLock: (
    path: string,
    options: typeof IMAP_PRECONDITION_LOCK_OPTIONS,
  ) => Promise<unknown>;
  /** Current selected mailbox state, read only while the lock is held. */
  readonly mailbox: unknown;
  readonly fetchOne: (
    range: string,
    query: typeof IMAP_PRECONDITION_FETCH_QUERY,
    options: ImapPreconditionFetchOptions,
  ) => Promise<unknown>;
}

export type ImapPreconditionAdapterOptions = Readonly<{
  readonly client: ImapFlowPreconditionClient;
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  /** Provider-decoded mailbox path resolved from the exact mailbox identity. */
  readonly mailboxPath: string;
}>;

export type PreconditionTarget = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
  readonly precondition: Readonly<{ readonly modseq: MonotonicSequence }>;
}>;

type ObservedTarget = Readonly<{
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
  readonly modseq: MonotonicSequence;
}>;

export type PreconditionObservation =
  | Readonly<{
      readonly kind: "satisfied";
      readonly target: PreconditionTarget;
      readonly observed: ObservedTarget;
    }>
  | Readonly<{
      readonly kind: "stale";
      readonly target: PreconditionTarget;
      readonly observed: ObservedTarget;
      readonly reason: "newer-modseq" | "older-modseq";
    }>
  | Readonly<{
      readonly kind: "missing";
      readonly target: PreconditionTarget;
      readonly uidValidity: UidValidity;
    }>
  | Readonly<{
      readonly kind: "epoch_changed";
      readonly target: PreconditionTarget;
      readonly observedUidValidity: UidValidity;
    }>
  | Readonly<{
      readonly kind: "unsupported";
      readonly target: PreconditionTarget;
      readonly reason: "uid-validity-unavailable" | "modseq-unavailable";
    }>
  | Readonly<{
      readonly kind: "transport_error";
      readonly target: PreconditionTarget;
      readonly phase: "select" | "fetch";
    }>;

export type PreconditionAdapterErrorCode =
  | "invalid-client"
  | "invalid-target"
  | "invalid-selection"
  | "identity-mismatch"
  | "invalid-fetch-result";

/** Stable boundary error that does not include provider payloads or credentials. */
export class PreconditionAdapterError extends TypeError {
  readonly code: PreconditionAdapterErrorCode;

  constructor(code: PreconditionAdapterErrorCode, message: string) {
    super(message);
    this.name = "PreconditionAdapterError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new PreconditionAdapterError("invalid-target", `${label} has missing or unknown fields`);
  }
}

function parseSafeNumber(value: unknown, label: string, positive: boolean): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    (positive ? normalized <= 0 : normalized < 0)
  ) {
    throw new PreconditionAdapterError(
      "invalid-fetch-result",
      `${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return normalized;
}

function parseTarget(value: unknown): PreconditionTarget {
  if (!isRecord(value)) {
    throw new PreconditionAdapterError("invalid-target", "precondition target must be an object");
  }
  exactKeys(value, ["accountId", "mailboxId", "uidValidity", "uid", "precondition"], "target");
  if (!isRecord(value.precondition)) {
    throw new PreconditionAdapterError("invalid-target", "target precondition must be an object");
  }
  exactKeys(value.precondition, ["modseq"], "target precondition");
  try {
    return Object.freeze({
      accountId: createAccountId(value.accountId),
      mailboxId: createMailboxId(value.mailboxId),
      uidValidity: createUidValidity(value.uidValidity),
      uid: createRemoteUidValue(value.uid),
      precondition: Object.freeze({
        modseq: createMonotonicSequence(value.precondition.modseq),
      }),
    });
  } catch {
    throw new PreconditionAdapterError(
      "invalid-target",
      "precondition target contains invalid values",
    );
  }
}

function validateClient(options: ImapPreconditionAdapterOptions): void {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.client !== "object" ||
    options.client === null ||
    typeof options.client.getMailboxLock !== "function" ||
    typeof options.client.fetchOne !== "function"
  ) {
    throw new PreconditionAdapterError(
      "invalid-client",
      "precondition adapter requires getMailboxLock and fetchOne operations",
    );
  }
  if (typeof options.mailboxPath !== "string" || options.mailboxPath.trim().length === 0) {
    throw new PreconditionAdapterError("invalid-client", "mailbox path must be non-empty");
  }
}

function isMailboxLock(value: unknown): value is ImapPreconditionMailboxLock {
  return isRecord(value) && typeof value.release === "function";
}

function selectedUidValidity(value: unknown): UidValidity | undefined {
  if (!isRecord(value)) {
    throw new PreconditionAdapterError("invalid-selection", "mailbox selection must be an object");
  }
  if (value.uidValidity === undefined || value.uidValidity === null) return undefined;
  try {
    return createUidValidity(parseSafeNumber(value.uidValidity, "UIDVALIDITY", true));
  } catch {
    throw new PreconditionAdapterError("invalid-selection", "mailbox UIDVALIDITY is invalid");
  }
}

function fetchObservation(
  value: unknown,
  target: PreconditionTarget,
  uidValidity: UidValidity,
): PreconditionObservation {
  if (value === false) {
    return { kind: "missing", target, uidValidity };
  }
  if (!isRecord(value)) {
    throw new PreconditionAdapterError(
      "invalid-fetch-result",
      "IMAP fetch result must be an object",
    );
  }
  if (value.uid === undefined || value.uid === null) {
    throw new PreconditionAdapterError("invalid-fetch-result", "IMAP fetch result is missing UID");
  }
  const uid = createRemoteUidValue(parseSafeNumber(value.uid, "UID", true));
  if (uid !== target.uid) {
    throw new PreconditionAdapterError("identity-mismatch", "IMAP fetch UID does not match target");
  }
  if (value.modseq === undefined || value.modseq === null || value.modseq === "unsupported") {
    return { kind: "unsupported", target, reason: "modseq-unavailable" };
  }
  const modseq = createMonotonicSequence(parseSafeNumber(value.modseq, "MODSEQ", false));
  const observed = Object.freeze({ uidValidity, uid, modseq });
  if (modseq === target.precondition.modseq) {
    return { kind: "satisfied", target, observed };
  }
  return {
    kind: "stale",
    target,
    observed,
    reason: modseq > target.precondition.modseq ? "newer-modseq" : "older-modseq",
  };
}

/**
 * Create a one-target, read-only precondition adapter.
 *
 * Selection is intentionally performed before UID fetch. The client surface
 * contains no STORE, MOVE, COPY, DELETE, or EXPUNGE capability, and this
 * operation neither persists nor retries or iterates over targets.
 */
export function createPreconditionAdapter(
  options: ImapPreconditionAdapterOptions,
): Readonly<{ readonly read: (target: unknown) => Promise<PreconditionObservation> }> {
  validateClient(options);
  return {
    async read(value: unknown): Promise<PreconditionObservation> {
      const target = parseTarget(value);
      if (target.accountId !== options.accountId || target.mailboxId !== options.mailboxId) {
        throw new PreconditionAdapterError(
          "identity-mismatch",
          "precondition target account or mailbox does not match adapter",
        );
      }

      let lock: ImapPreconditionMailboxLock | undefined;
      try {
        let acquired: unknown;
        try {
          acquired = await options.client.getMailboxLock(
            options.mailboxPath,
            IMAP_PRECONDITION_LOCK_OPTIONS,
          );
        } catch {
          return { kind: "transport_error", target, phase: "select" };
        }
        if (!isMailboxLock(acquired)) {
          throw new PreconditionAdapterError(
            "invalid-selection",
            "IMAP mailbox lock must expose release",
          );
        }
        lock = acquired;

        const selection = options.client.mailbox;
        if (!isRecord(selection)) {
          throw new PreconditionAdapterError(
            "invalid-selection",
            "selected mailbox must be an object",
          );
        }
        if (selection.path !== options.mailboxPath) {
          throw new PreconditionAdapterError(
            "identity-mismatch",
            "selected mailbox path does not match target",
          );
        }
        const uidValidity = selectedUidValidity(selection);
        if (uidValidity === undefined) {
          return { kind: "unsupported", target, reason: "uid-validity-unavailable" };
        }
        if (uidValidity !== target.uidValidity) {
          return { kind: "epoch_changed", target, observedUidValidity: uidValidity };
        }

        let fetched: unknown;
        try {
          fetched = await options.client.fetchOne(
            String(target.uid),
            IMAP_PRECONDITION_FETCH_QUERY,
            { uid: true },
          );
        } catch {
          return { kind: "transport_error", target, phase: "fetch" };
        }
        return fetchObservation(fetched, target, uidValidity);
      } finally {
        lock?.release();
      }
    },
  };
}
