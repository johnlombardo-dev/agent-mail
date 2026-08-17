import {
  createMonotonicSequence,
  createRemoteUidValue,
  createUidValidity,
  type MonotonicSequence,
  type RemoteUidValue,
  type UidValidity,
} from "@agent-mail/core";
import type { RemoteMutationAdapter, RemoteMutationRequest } from "./remote-executor";
import {
  createImapFlowTaggedStorePrimitive,
  type ImapTaggedStoreResult,
} from "./tagged-conditional-store";

/** The only flag this adapter may add or remove. */
export const IMAP_SEEN_FLAG = "\\Seen";
/** Mutation must select the exact mailbox under a write-capable lock. */
export const IMAP_SEEN_MUTATION_LOCK_OPTIONS = Object.freeze({ readOnly: false });
/** The postcondition fetch must request both values used to establish certainty. */
export const IMAP_SEEN_MUTATION_FETCH_QUERY = Object.freeze({ uid: true, flags: true });
export const IMAP_SEEN_MUTATION_FETCH_OPTIONS = Object.freeze({ uid: true });

export type ImapSeenMutationMailboxLock = Readonly<{ readonly release: () => void }>;
export type ImapSeenMutationStoreOptions = Readonly<{
  readonly uid: true;
  readonly unchangedSince: bigint;
}>;

export type ImapSeenConditionalStoreRequest = Readonly<{
  readonly range: string;
  readonly operation: "add" | "remove";
  readonly flags: readonly [typeof IMAP_SEEN_FLAG];
  readonly options: ImapSeenMutationStoreOptions;
}>;

/**
 * A safe wrapper must expose tagged STORE evidence. ImapFlow's boolean helper
 * is deliberately not accepted here because it hides RFC 7162 MODIFIED.
 */
export type ImapSeenConditionalStoreEvidence =
  | ImapTaggedStoreResult
  | Readonly<{
      /** Legacy fake seam retained for existing contract fixtures; production uses MODIFIED. */
      readonly kind: "precondition_failed";
    }>;

export type ImapSeenConditionalStore = (
  request: ImapSeenConditionalStoreRequest,
) => Promise<ImapSeenConditionalStoreEvidence>;

/** The production-shaped surface intentionally has no replacement-flag, delete, or expunge call. */
export interface ImapSeenMutationClient {
  readonly getMailboxLock: (
    path: string,
    options: typeof IMAP_SEEN_MUTATION_LOCK_OPTIONS,
  ) => Promise<unknown>;
  readonly mailbox: unknown;
  /** ImapFlow's enabled capability set; mutation requires CONDSTORE. */
  readonly enabled: ReadonlySet<string>;
  /** Optional safe wrapper; absent means this raw client cannot mutate. */
  readonly conditionalStore?: ImapSeenConditionalStore;
  readonly messageFlagsAdd: (
    range: string,
    flags: [typeof IMAP_SEEN_FLAG],
    options: ImapSeenMutationStoreOptions,
  ) => Promise<boolean>;
  readonly messageFlagsRemove: (
    range: string,
    flags: [typeof IMAP_SEEN_FLAG],
    options: ImapSeenMutationStoreOptions,
  ) => Promise<boolean>;
  readonly fetchOne: (
    range: string,
    query: typeof IMAP_SEEN_MUTATION_FETCH_QUERY,
    options: typeof IMAP_SEEN_MUTATION_FETCH_OPTIONS,
  ) => Promise<unknown>;
}

export type ImapSeenMutationAdapterOptions = Readonly<{
  readonly client: ImapSeenMutationClient;
  readonly mailboxPath: string;
}>;

export type SeenMutationPostcondition = Readonly<{
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
  readonly flags: readonly string[];
  readonly modseq: MonotonicSequence;
}>;

export type SeenMutationCommandTraceEntry =
  | Readonly<{
      readonly kind: "getMailboxLock";
      readonly path: string;
      readonly options: typeof IMAP_SEEN_MUTATION_LOCK_OPTIONS;
    }>
  | Readonly<{
      readonly kind: "messageFlagsAdd";
      readonly uid: RemoteUidValue;
      readonly flags: readonly [typeof IMAP_SEEN_FLAG];
      readonly options: ImapSeenMutationStoreOptions;
    }>
  | Readonly<{
      readonly kind: "messageFlagsRemove";
      readonly uid: RemoteUidValue;
      readonly flags: readonly [typeof IMAP_SEEN_FLAG];
      readonly options: ImapSeenMutationStoreOptions;
    }>
  | Readonly<{
      readonly kind: "conditionalStore";
      readonly uid: RemoteUidValue;
      readonly operation: "add" | "remove";
      readonly flags: readonly [typeof IMAP_SEEN_FLAG];
      readonly options: ImapSeenMutationStoreOptions;
    }>
  | Readonly<{
      readonly kind: "fetchOne";
      readonly uid: RemoteUidValue;
      readonly query: typeof IMAP_SEEN_MUTATION_FETCH_QUERY;
      readonly options: typeof IMAP_SEEN_MUTATION_FETCH_OPTIONS;
    }>
  | Readonly<{ readonly kind: "release" }>;

type SeenMutationResultBase = Readonly<{
  readonly target: RemoteMutationRequest["attempt"]["target"];
}>;

type SeenMutationResultInput =
  | Readonly<{
      readonly kind: "applied";
      readonly certainty: "definite";
      readonly postcondition: SeenMutationPostcondition;
    }>
  | Readonly<{
      readonly kind: "precondition_failed";
      readonly certainty: "definite";
      readonly observed?: SeenMutationPostcondition;
    }>
  | Readonly<{
      readonly kind: "missing";
      readonly certainty: "definite";
    }>
  | Readonly<{
      readonly kind: "uncertain_transport";
      readonly certainty: "uncertain";
      readonly phase: "after_transmission";
    }>
  | Readonly<{
      readonly kind: "definite_transport_failure";
      readonly certainty: "definite";
      readonly phase: "before_transmission";
    }>;

export type SeenMutationResult = SeenMutationResultBase &
  SeenMutationResultInput & {
    readonly trace: readonly SeenMutationCommandTraceEntry[];
  };

export type SeenMutationAdapterErrorCode =
  | "invalid-client"
  | "invalid-selection"
  | "invalid-postcondition"
  | "unsupported-action";

export class SeenMutationAdapterError extends TypeError {
  readonly code: SeenMutationAdapterErrorCode;

  constructor(code: SeenMutationAdapterErrorCode, message: string) {
    super(message);
    this.name = "SeenMutationAdapterError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMailboxLock(value: unknown): value is ImapSeenMutationMailboxLock {
  return isRecord(value) && typeof value.release === "function";
}

function safeInteger(value: unknown, label: string, positive: boolean): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    (positive ? normalized <= 0 : normalized < 0)
  ) {
    throw new SeenMutationAdapterError(
      "invalid-postcondition",
      `${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return normalized;
}

function parseFlags(value: unknown): readonly string[] {
  const values = value instanceof Set ? [...value] : value;
  if (!Array.isArray(values) || values.some((flag) => typeof flag !== "string")) {
    throw new SeenMutationAdapterError(
      "invalid-postcondition",
      "IMAP postcondition flags must be an array or Set of strings",
    );
  }
  const flags = values.map((flag) => {
    if (typeof flag !== "string" || flag.length === 0) {
      throw new SeenMutationAdapterError(
        "invalid-postcondition",
        "IMAP postcondition flags must be non-empty strings",
      );
    }
    return flag;
  });
  if (new Set(flags).size !== flags.length) {
    throw new SeenMutationAdapterError(
      "invalid-postcondition",
      "IMAP postcondition flags must be unique",
    );
  }
  return Object.freeze(flags);
}

function parsePostcondition(
  value: unknown,
  target: RemoteMutationRequest["attempt"]["target"],
  uidValidity: UidValidity,
): SeenMutationPostcondition {
  if (!isRecord(value)) {
    throw new SeenMutationAdapterError(
      "invalid-postcondition",
      "IMAP postcondition must be an object",
    );
  }
  const uid = createRemoteUidValue(safeInteger(value.uid, "UID", true));
  if (uid !== target.uid) {
    throw new SeenMutationAdapterError(
      "invalid-postcondition",
      "postcondition UID mismatches target",
    );
  }
  if (uidValidity !== target.uidValidity)
    throw new SeenMutationAdapterError(
      "invalid-postcondition",
      "selected UIDVALIDITY mismatches target",
    );
  return Object.freeze({
    uidValidity,
    uid,
    flags: parseFlags(value.flags),
    modseq: createMonotonicSequence(safeInteger(value.modseq, "MODSEQ", false)),
  });
}

function selectedUidValidity(value: unknown): UidValidity {
  if (!isRecord(value)) {
    throw new SeenMutationAdapterError("invalid-selection", "selected mailbox must be an object");
  }
  return createUidValidity(safeInteger(value.uidValidity, "UIDVALIDITY", true));
}

function transportWasDefinitelyBeforeTransmission(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.transmitted === false || value.beforeTransmission === true;
}

function targetResult(
  target: RemoteMutationRequest["attempt"]["target"],
  result: SeenMutationResultInput,
  trace: readonly SeenMutationCommandTraceEntry[],
): SeenMutationResult {
  return { target, ...result, trace };
}

function traceOf(
  entries: readonly SeenMutationCommandTraceEntry[],
): readonly SeenMutationCommandTraceEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function desiredSeen(action: RemoteMutationRequest["attempt"]["action"]): boolean {
  if (action.kind === "markSeen") return true;
  if (action.kind === "markUnseen") return false;
  throw new SeenMutationAdapterError(
    "unsupported-action",
    "Seen mutation adapter accepts only markSeen or markUnseen",
  );
}

function hasSeenFlag(flags: readonly string[]): boolean {
  return flags.some((flag) => flag.toLowerCase() === IMAP_SEEN_FLAG.toLowerCase());
}

function mutationOptions(modseq: MonotonicSequence): ImapSeenMutationStoreOptions {
  return { uid: true, unchangedSince: BigInt(modseq) };
}

function supportsCondstore(value: unknown): value is ReadonlySet<string> {
  return (
    value instanceof Set &&
    [...value].some(
      (capability) => typeof capability === "string" && capability.toUpperCase() === "CONDSTORE",
    )
  );
}

function isConditionalStoreEvidence(value: unknown): value is ImapSeenConditionalStoreEvidence {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "applied" || value.kind === "precondition_failed") return true;
  if (value.kind === "missing") return value.status === "NO" || value.status === "BAD";
  if (value.kind === "modified") return Array.isArray(value.modifiedUids);
  return (
    value.kind === "rejected" &&
    (value.status === "NO" ||
      value.status === "BAD" ||
      value.status === "unsupported" ||
      value.status === "malformed") &&
    (value.certainty === "definite" || value.certainty === "uncertain") &&
    (value.phase === "before_transmission" || value.phase === "after_transmission")
  );
}

/** Add tagged STORE evidence to a raw ImapFlow-shaped client without altering its methods. */
export function createConditionalSeenMutationClient(
  client: ImapSeenMutationClient,
  conditionalStore?: ImapSeenConditionalStore,
): ImapSeenMutationClient {
  const safeStore =
    conditionalStore ??
    (async (request: ImapSeenConditionalStoreRequest): Promise<ImapSeenConditionalStoreEvidence> =>
      createImapFlowTaggedStorePrimitive(client)({
        range: request.range,
        operation: request.operation,
        flags: request.flags,
        options: request.options,
      }));
  return {
    getMailboxLock: (path, lockOptions) => client.getMailboxLock(path, lockOptions),
    get mailbox(): unknown {
      return client.mailbox;
    },
    get enabled(): ReadonlySet<string> {
      return client.enabled;
    },
    conditionalStore: safeStore,
    messageFlagsAdd: (range, flags, storeOptions) =>
      client.messageFlagsAdd(range, flags, storeOptions),
    messageFlagsRemove: (range, flags, storeOptions) =>
      client.messageFlagsRemove(range, flags, storeOptions),
    fetchOne: (range, query, fetchOptions) => client.fetchOne(range, query, fetchOptions),
  };
}

/**
 * Build the one-target Seen/Unseen adapter. The adapter is entered by the
 * executor only after it has consumed the internal one-shot capability.
 */
export function createSeenMutationAdapter(
  options: ImapSeenMutationAdapterOptions,
): RemoteMutationAdapter {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.client !== "object" ||
    options.client === null ||
    typeof options.client.getMailboxLock !== "function" ||
    typeof options.client.messageFlagsAdd !== "function" ||
    typeof options.client.messageFlagsRemove !== "function" ||
    typeof options.client.fetchOne !== "function"
  ) {
    throw new SeenMutationAdapterError("invalid-client", "Seen mutation client is incomplete");
  }
  if (typeof options.mailboxPath !== "string" || options.mailboxPath.trim() === "") {
    throw new SeenMutationAdapterError("invalid-client", "mailbox path must be non-empty");
  }

  return {
    execute: async (request): Promise<SeenMutationResult> => {
      const { attempt } = request;
      const seen = desiredSeen(attempt.action);
      const { target } = attempt;
      const entries: SeenMutationCommandTraceEntry[] = [];
      let lock: ImapSeenMutationMailboxLock | undefined;
      const finish = (result: SeenMutationResultInput): SeenMutationResult => {
        if (lock !== undefined) {
          entries.push({ kind: "release" });
          try {
            lock.release();
          } catch {
            // Cleanup errors cannot make a completed remote result more certain.
          }
          lock = undefined;
        }
        return targetResult(target, result, traceOf(entries));
      };
      try {
        try {
          entries.push({
            kind: "getMailboxLock",
            path: options.mailboxPath,
            options: IMAP_SEEN_MUTATION_LOCK_OPTIONS,
          });
          const acquired = await options.client.getMailboxLock(
            options.mailboxPath,
            IMAP_SEEN_MUTATION_LOCK_OPTIONS,
          );
          if (!isMailboxLock(acquired)) {
            throw new SeenMutationAdapterError(
              "invalid-selection",
              "IMAP mailbox lock must expose release",
            );
          }
          lock = acquired;
        } catch (error: unknown) {
          if (error instanceof SeenMutationAdapterError) throw error;
          return finish({
            kind: "definite_transport_failure",
            certainty: "definite",
            phase: "before_transmission",
          });
        }

        const selection = options.client.mailbox;
        if (!isRecord(selection) || selection.path !== options.mailboxPath) {
          return finish({ kind: "precondition_failed", certainty: "definite" });
        }
        const selectedEpoch = selectedUidValidity(selection);
        if (selectedEpoch !== target.uidValidity) {
          return finish({ kind: "precondition_failed", certainty: "definite" });
        }
        if (!supportsCondstore(options.client.enabled) || selection.noModseq === true) {
          return finish({ kind: "precondition_failed", certainty: "definite" });
        }
        if (options.client.conditionalStore === undefined) {
          return finish({ kind: "precondition_failed", certainty: "definite" });
        }

        const uid = String(target.uid);
        const storeOptions = mutationOptions(target.precondition.modseq);
        const operation = seen ? "add" : "remove";
        entries.push({
          kind: "conditionalStore",
          uid: target.uid,
          operation,
          flags: [IMAP_SEEN_FLAG],
          options: storeOptions,
        });
        let storeEvidence: ImapSeenConditionalStoreEvidence;
        try {
          storeEvidence = await options.client.conditionalStore({
            range: uid,
            operation,
            flags: [IMAP_SEEN_FLAG],
            options: storeOptions,
          });
        } catch (error: unknown) {
          if (transportWasDefinitelyBeforeTransmission(error)) {
            return finish({
              kind: "definite_transport_failure",
              certainty: "definite",
              phase: "before_transmission",
            });
          }
          return finish({
            kind: "uncertain_transport",
            certainty: "uncertain",
            phase: "after_transmission",
          });
        }
        if (!isConditionalStoreEvidence(storeEvidence)) {
          return finish({
            kind: "uncertain_transport",
            certainty: "uncertain",
            phase: "after_transmission",
          });
        }
        if (storeEvidence.kind === "rejected") {
          if (storeEvidence.status === "unsupported") {
            return finish({ kind: "precondition_failed", certainty: "definite" });
          }
          return finish(
            storeEvidence.phase === "before_transmission"
              ? {
                  kind: "definite_transport_failure",
                  certainty: "definite",
                  phase: "before_transmission",
                }
              : {
                  kind: "uncertain_transport",
                  certainty: "uncertain",
                  phase: "after_transmission",
                },
          );
        }
        if (storeEvidence.kind === "missing") {
          return finish({ kind: "missing", certainty: "definite" });
        }

        let fetched: unknown;
        try {
          entries.push({
            kind: "fetchOne",
            uid: target.uid,
            query: IMAP_SEEN_MUTATION_FETCH_QUERY,
            options: IMAP_SEEN_MUTATION_FETCH_OPTIONS,
          });
          fetched = await options.client.fetchOne(
            uid,
            IMAP_SEEN_MUTATION_FETCH_QUERY,
            IMAP_SEEN_MUTATION_FETCH_OPTIONS,
          );
        } catch {
          return finish({
            kind: "uncertain_transport",
            certainty: "uncertain",
            phase: "after_transmission",
          });
        }
        if (fetched === false) return finish({ kind: "missing", certainty: "definite" });

        const postcondition = parsePostcondition(fetched, target, selectedEpoch);
        const desired = hasSeenFlag(postcondition.flags) === seen;
        if (storeEvidence.kind === "applied" && desired)
          return finish({ kind: "applied", certainty: "definite", postcondition });
        if (storeEvidence.kind === "precondition_failed" || storeEvidence.kind === "modified") {
          return finish({
            kind: "precondition_failed",
            certainty: "definite",
            observed: postcondition,
          });
        }
        return finish({
          kind: "uncertain_transport",
          certainty: "uncertain",
          phase: "after_transmission",
        });
      } finally {
        if (lock !== undefined) {
          try {
            lock.release();
          } catch {
            // Cleanup errors cannot make a completed remote result more certain.
          }
        }
      }
    },
  };
}

export const createFlagMutationAdapter = createSeenMutationAdapter;
