import {
  createAccountId,
  createMailboxId,
  createMonotonicSequence,
  createRemoteAttempt,
  createRemoteAttemptRejected,
  createRemoteAttemptStale,
  createRemoteAttemptSuccess,
  createRemoteAttemptUncertain,
  createRemoteUidValue,
  createUidValidity,
  parseUtcInstant,
  type Action,
  type AccountId,
  type MailboxId,
  type MonotonicSequence,
  type RemoteAttempt,
  type RemoteAttemptResult,
  type RemoteUidValue,
  type ServerObservedPostcondition,
  type UncertainReason,
  type UidValidity,
  type UtcInstant,
} from "@agent-mail/core";

/** Reconciliation is allowed to select and fetch, never to write or expunge. */
export const IMAP_RECONCILIATION_LOCK_OPTIONS = Object.freeze({ readOnly: true });
export const IMAP_RECONCILIATION_FETCH_QUERY = Object.freeze({ uid: true, flags: true });
export const IMAP_RECONCILIATION_FETCH_OPTIONS = Object.freeze({ uid: true });

export type ImapFlowUncertainReconciliationClient = Readonly<{
  readonly getMailboxLock: (
    path: string,
    options: typeof IMAP_RECONCILIATION_LOCK_OPTIONS,
  ) => Promise<unknown>;
  readonly mailbox: unknown;
  readonly fetchOne: (
    range: string,
    query: typeof IMAP_RECONCILIATION_FETCH_QUERY,
    options: typeof IMAP_RECONCILIATION_FETCH_OPTIONS,
  ) => Promise<unknown>;
}>;

export type UncertainReconciliationMailbox = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly path: string;
  readonly uidValidity: UidValidity;
}>;

/** The destination UID is required: source absence alone is not move evidence. */
export type UncertainReconciliationDestination = Readonly<
  UncertainReconciliationMailbox & {
    readonly uid: RemoteUidValue;
  }
>;

type ReadObservation = Readonly<{
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
  readonly modseq: MonotonicSequence;
  readonly flags: readonly string[];
}>;

type ReadResult =
  | Readonly<{
      readonly kind: "present";
      readonly observation: ReadObservation;
    }>
  | Readonly<{
      readonly kind: "missing";
      readonly mailboxId: MailboxId;
      readonly uidValidity: UidValidity;
    }>
  | Readonly<{
      readonly kind: "epoch_changed";
      readonly mailboxId: MailboxId;
      readonly expectedUidValidity: UidValidity;
      readonly observedUidValidity: UidValidity;
    }>
  | Readonly<{
      readonly kind: "unsupported";
      readonly mailboxId: MailboxId;
      readonly uidValidity: UidValidity;
      readonly reason: "uid-validity-unavailable" | "modseq-unavailable";
    }>;

export type UncertainReconciliationEvidence = Readonly<{
  readonly observedAt: UtcInstant;
  readonly source: ReadResult;
  readonly destination?: ReadResult;
}>;

export type UncertainReconciliationResult =
  | Readonly<{
      readonly kind: "applied";
      readonly certainty: "definite";
      readonly attempt: RemoteAttempt;
      readonly postcondition: ServerObservedPostcondition;
      readonly evidence: UncertainReconciliationEvidence;
    }>
  | Readonly<{
      readonly kind: "not-applied";
      readonly certainty: "definite";
      readonly attempt: RemoteAttempt;
      readonly evidence: UncertainReconciliationEvidence;
    }>
  | Readonly<{
      readonly kind: "stale";
      readonly certainty: "definite";
      readonly attempt: RemoteAttempt;
      readonly evidence: UncertainReconciliationEvidence;
      readonly reason:
        | "source-epoch-changed"
        | "source-modseq-changed"
        | "destination-epoch-changed";
    }>
  | Readonly<{
      readonly kind: "still-uncertain";
      readonly certainty: "uncertain";
      readonly attempt: RemoteAttempt;
      readonly evidence: UncertainReconciliationEvidence;
      readonly reason:
        | "source-missing"
        | "destination-missing"
        | "partial-move"
        | "destination-identity-unavailable"
        | "transport-error"
        | "unsupported-observation";
    }>;

export type UncertainReconciliationAdapterErrorCode =
  | "invalid-client"
  | "invalid-input"
  | "identity-mismatch"
  | "invalid-selection"
  | "invalid-observation";

export class UncertainReconciliationAdapterError extends TypeError {
  readonly code: UncertainReconciliationAdapterErrorCode;

  constructor(code: UncertainReconciliationAdapterErrorCode, message: string) {
    super(message);
    this.name = "UncertainReconciliationAdapterError";
    this.code = code;
  }
}

type ParsedOptions = Readonly<{
  readonly client: ImapFlowUncertainReconciliationClient;
  readonly source: UncertainReconciliationSource;
  readonly destination?: UncertainReconciliationDestination;
}>;

type UncertainReconciliationSource = Readonly<
  Omit<UncertainReconciliationMailbox, "uidValidity"> & {
    readonly uidValidity?: UidValidity;
  }
>;

type ParsedInput = Readonly<{
  readonly attempt: RemoteAttempt;
  readonly observedAt: UtcInstant;
  readonly destination?: UncertainReconciliationDestination;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value))
    throw new UncertainReconciliationAdapterError("invalid-input", `${label} must be an object`);
  return value;
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
    throw new UncertainReconciliationAdapterError(
      "invalid-input",
      `${label} has missing or unknown fields`,
    );
  }
}

function safeInteger(value: unknown, label: string, positive: boolean): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    (positive ? normalized <= 0 : normalized < 0)
  ) {
    throw new UncertainReconciliationAdapterError(
      "invalid-observation",
      `${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return normalized;
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > 512
  ) {
    throw new UncertainReconciliationAdapterError(
      "invalid-input",
      `${label} must be a bounded path`,
    );
  }
  return value;
}

function parseMailbox(value: unknown, label: string): UncertainReconciliationMailbox {
  const input = record(value, label);
  exactKeys(input, ["accountId", "mailboxId", "path", "uidValidity"], label);
  try {
    return {
      accountId: createAccountId(input.accountId),
      mailboxId: createMailboxId(input.mailboxId),
      path: boundedPath(input.path, `${label} path`),
      uidValidity: createUidValidity(safeInteger(input.uidValidity, `${label} UIDVALIDITY`, true)),
    };
  } catch (error: unknown) {
    if (error instanceof UncertainReconciliationAdapterError) throw error;
    throw new UncertainReconciliationAdapterError("invalid-input", `${label} identity is invalid`);
  }
}

function parseDestination(
  value: unknown,
  label = "destination",
): UncertainReconciliationDestination {
  const input = record(value, label);
  exactKeys(input, ["accountId", "mailboxId", "path", "uidValidity", "uid"], label);
  const mailbox = parseMailbox(
    {
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      path: input.path,
      uidValidity: input.uidValidity,
    },
    label,
  );
  try {
    return { ...mailbox, uid: createRemoteUidValue(safeInteger(input.uid, `${label} UID`, true)) };
  } catch (error: unknown) {
    if (error instanceof UncertainReconciliationAdapterError) throw error;
    throw new UncertainReconciliationAdapterError("invalid-input", `${label} UID is invalid`);
  }
}

function parseSource(value: unknown, label = "source mailbox"): UncertainReconciliationSource {
  const input = record(value, label);
  const keys = Reflect.ownKeys(input);
  if (
    !Object.prototype.hasOwnProperty.call(input, "accountId") ||
    !Object.prototype.hasOwnProperty.call(input, "mailboxId") ||
    !Object.prototype.hasOwnProperty.call(input, "path") ||
    keys.some(
      (key) =>
        key !== "accountId" && key !== "mailboxId" && key !== "path" && key !== "uidValidity",
    )
  ) {
    throw new UncertainReconciliationAdapterError(
      "invalid-input",
      `${label} has missing or unknown fields`,
    );
  }
  try {
    return {
      accountId: createAccountId(input.accountId),
      mailboxId: createMailboxId(input.mailboxId),
      path: boundedPath(input.path, `${label} path`),
      uidValidity:
        input.uidValidity === undefined
          ? undefined
          : createUidValidity(safeInteger(input.uidValidity, `${label} UIDVALIDITY`, true)),
    };
  } catch {
    throw new UncertainReconciliationAdapterError("invalid-input", `${label} identity is invalid`);
  }
}

function parseOptions(value: UncertainReconciliationAdapterOptions): ParsedOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.client !== "object" ||
    value.client === null ||
    typeof value.client.getMailboxLock !== "function" ||
    typeof value.client.fetchOne !== "function"
  ) {
    throw new UncertainReconciliationAdapterError(
      "invalid-client",
      "reconciliation adapter requires read-only getMailboxLock and fetchOne",
    );
  }
  const source = parseSource(value.source);
  const destination =
    value.destination === undefined ? undefined : parseDestination(value.destination);
  if (destination !== undefined && destination.accountId !== source.accountId) {
    throw new UncertainReconciliationAdapterError(
      "identity-mismatch",
      "source and destination accounts must match",
    );
  }
  if (destination !== undefined && destination.mailboxId === source.mailboxId) {
    throw new UncertainReconciliationAdapterError(
      "identity-mismatch",
      "source and destination mailboxes must differ",
    );
  }
  return { client: value.client, source, destination };
}

function parseInput(
  value: unknown,
  fallbackDestination?: UncertainReconciliationDestination,
): ParsedInput {
  const input = record(value, "reconciliation input");
  const keys = Reflect.ownKeys(input);
  if (
    !Object.prototype.hasOwnProperty.call(input, "attempt") ||
    !Object.prototype.hasOwnProperty.call(input, "observedAt") ||
    keys.some((key) => key !== "attempt" && key !== "observedAt" && key !== "destination")
  ) {
    throw new UncertainReconciliationAdapterError(
      "invalid-input",
      "reconciliation input has missing or unknown fields",
    );
  }
  let attempt: RemoteAttempt;
  try {
    attempt = createRemoteAttempt(input.attempt);
  } catch {
    throw new UncertainReconciliationAdapterError(
      "invalid-input",
      "reconciliation attempt is invalid",
    );
  }
  const observedAt = parseUtcInstant(input.observedAt);
  let destination = fallbackDestination;
  if (input.destination !== undefined) {
    const suppliedDestination = parseDestination(input.destination);
    if (
      destination !== undefined &&
      (destination.accountId !== suppliedDestination.accountId ||
        destination.mailboxId !== suppliedDestination.mailboxId ||
        destination.path !== suppliedDestination.path ||
        destination.uidValidity !== suppliedDestination.uidValidity ||
        destination.uid !== suppliedDestination.uid)
    ) {
      throw new UncertainReconciliationAdapterError(
        "identity-mismatch",
        "reconciliation destination conflicts with configured identity",
      );
    }
    destination = suppliedDestination;
  }
  if (attempt.action.kind === "moveToArchive" || attempt.action.kind === "moveToTrash") {
    if (destination === undefined) {
      return { attempt, observedAt, destination: undefined };
    }
    if (
      destination.accountId !== attempt.target.accountId ||
      destination.mailboxId === attempt.target.mailboxId
    ) {
      throw new UncertainReconciliationAdapterError(
        "identity-mismatch",
        "move destination identity is invalid",
      );
    }
  } else if (destination !== undefined) {
    throw new UncertainReconciliationAdapterError(
      "invalid-input",
      "flag reconciliation cannot have a destination",
    );
  }
  return { attempt, observedAt, destination };
}

function selectedUidValidity(value: unknown, label: string): UidValidity {
  const input = record(value, label);
  if (input.uidValidity === undefined || input.uidValidity === null) {
    throw new UncertainReconciliationAdapterError(
      "invalid-selection",
      `${label} UIDVALIDITY is unavailable`,
    );
  }
  return createUidValidity(safeInteger(input.uidValidity, `${label} UIDVALIDITY`, true));
}

function parseFlags(value: unknown): readonly string[] {
  const values = value instanceof Set ? [...value] : value;
  if (
    !Array.isArray(values) ||
    values.some((item) => typeof item !== "string" || item.length === 0 || item.length > 128)
  ) {
    throw new UncertainReconciliationAdapterError("invalid-observation", "IMAP flags are invalid");
  }
  const flags = values.map((item) => {
    if (typeof item !== "string")
      throw new UncertainReconciliationAdapterError("invalid-observation", "IMAP flag is invalid");
    return item;
  });
  if (new Set(flags).size !== flags.length) {
    throw new UncertainReconciliationAdapterError(
      "invalid-observation",
      "IMAP flags are not unique",
    );
  }
  return Object.freeze(flags);
}

function parsePresent(value: unknown, mailbox: UncertainReconciliationMailbox): ReadObservation {
  const input = record(value, "IMAP fetch result");
  const uid = createRemoteUidValue(safeInteger(input.uid, "IMAP UID", true));
  if (input.modseq === undefined || input.modseq === null || input.modseq === "unsupported") {
    throw new UncertainReconciliationAdapterError(
      "invalid-observation",
      "IMAP MODSEQ is unavailable",
    );
  }
  const modseq = createMonotonicSequence(safeInteger(input.modseq, "IMAP MODSEQ", false));
  return {
    mailboxId: mailbox.mailboxId,
    uidValidity: mailbox.uidValidity,
    uid,
    modseq,
    flags: parseFlags(input.flags),
  };
}

function isLock(value: unknown): value is Readonly<{ readonly release: () => void }> {
  return isRecord(value) && typeof value.release === "function";
}

async function readOne(
  options: ParsedOptions,
  mailbox: UncertainReconciliationMailbox,
  uid: RemoteUidValue,
): Promise<Readonly<{ readonly result: ReadResult; readonly transportError: boolean }>> {
  let lock: Readonly<{ readonly release: () => void }> | undefined;
  try {
    let acquired: unknown;
    try {
      acquired = await options.client.getMailboxLock(
        mailbox.path,
        IMAP_RECONCILIATION_LOCK_OPTIONS,
      );
    } catch {
      return {
        result: { kind: "missing", mailboxId: mailbox.mailboxId, uidValidity: mailbox.uidValidity },
        transportError: true,
      };
    }
    if (!isLock(acquired)) {
      throw new UncertainReconciliationAdapterError(
        "invalid-selection",
        "IMAP mailbox lock is invalid",
      );
    }
    lock = acquired;
    const selection = record(options.client.mailbox, "selected mailbox");
    if (selection.path !== mailbox.path) {
      throw new UncertainReconciliationAdapterError(
        "identity-mismatch",
        "selected mailbox path mismatches identity",
      );
    }
    let selected: UidValidity;
    try {
      selected = selectedUidValidity(selection, "selected mailbox");
    } catch (error: unknown) {
      if (
        error instanceof UncertainReconciliationAdapterError &&
        error.code === "invalid-selection" &&
        selection.uidValidity === undefined
      ) {
        return {
          result: {
            kind: "unsupported",
            mailboxId: mailbox.mailboxId,
            uidValidity: mailbox.uidValidity,
            reason: "uid-validity-unavailable",
          },
          transportError: false,
        };
      }
      throw error;
    }
    if (selected !== mailbox.uidValidity) {
      return {
        result: {
          kind: "epoch_changed",
          mailboxId: mailbox.mailboxId,
          expectedUidValidity: mailbox.uidValidity,
          observedUidValidity: selected,
        },
        transportError: false,
      };
    }
    let fetched: unknown;
    try {
      fetched = await options.client.fetchOne(
        String(uid),
        IMAP_RECONCILIATION_FETCH_QUERY,
        IMAP_RECONCILIATION_FETCH_OPTIONS,
      );
    } catch {
      return {
        result: { kind: "missing", mailboxId: mailbox.mailboxId, uidValidity: mailbox.uidValidity },
        transportError: true,
      };
    }
    if (fetched === false) {
      return {
        result: { kind: "missing", mailboxId: mailbox.mailboxId, uidValidity: mailbox.uidValidity },
        transportError: false,
      };
    }
    let present: ReadObservation;
    try {
      present = parsePresent(fetched, mailbox);
    } catch (error: unknown) {
      if (
        error instanceof UncertainReconciliationAdapterError &&
        error.code === "invalid-observation" &&
        error.message.includes("MODSEQ is unavailable")
      ) {
        return {
          result: {
            kind: "unsupported",
            mailboxId: mailbox.mailboxId,
            uidValidity: mailbox.uidValidity,
            reason: "modseq-unavailable",
          },
          transportError: false,
        };
      }
      throw error;
    }
    if (present.uid !== uid) {
      throw new UncertainReconciliationAdapterError(
        "identity-mismatch",
        "IMAP fetch UID mismatches identity",
      );
    }
    return { result: { kind: "present", observation: present }, transportError: false };
  } finally {
    if (lock !== undefined) {
      try {
        lock.release();
      } catch {
        // A read cleanup failure never becomes positive mutation evidence.
      }
    }
  }
}

function flagsContainSeen(flags: readonly string[]): boolean {
  return flags.some((flag) => flag.toLowerCase() === "\\seen");
}

function actionWantsSeen(action: Action): boolean {
  if (action.kind === "markSeen") return true;
  if (action.kind === "markUnseen") return false;
  throw new UncertainReconciliationAdapterError(
    "invalid-input",
    "flag reconciliation received a move action",
  );
}

function detail(evidence: UncertainReconciliationEvidence, reason: string): string {
  const encode = (value: ReadResult): Readonly<Record<string, unknown>> =>
    value.kind === "missing"
      ? { kind: value.kind, mailboxId: value.mailboxId, uidValidity: value.uidValidity }
      : value.kind === "epoch_changed"
        ? {
            kind: value.kind,
            mailboxId: value.mailboxId,
            expectedUidValidity: value.expectedUidValidity,
            observedUidValidity: value.observedUidValidity,
          }
        : value.kind === "unsupported"
          ? {
              kind: value.kind,
              mailboxId: value.mailboxId,
              uidValidity: value.uidValidity,
              reason: value.reason,
            }
          : {
              kind: value.kind,
              mailboxId: value.observation.mailboxId,
              uidValidity: value.observation.uidValidity,
              uid: value.observation.uid,
              modseq: value.observation.modseq,
              flags: value.observation.flags,
            };
  const serialized = JSON.stringify({
    version: 1,
    reason,
    observedAt: evidence.observedAt,
    source: encode(evidence.source),
    destination: evidence.destination === undefined ? null : encode(evidence.destination),
  });
  if (serialized.length > 512) {
    throw new UncertainReconciliationAdapterError(
      "invalid-observation",
      "reconciliation evidence exceeds the bounded operator detail limit",
    );
  }
  return serialized;
}

function sourceEvidence(
  observedAt: UtcInstant,
  source: ReadResult,
  destination?: ReadResult,
): UncertainReconciliationEvidence {
  return destination === undefined ? { observedAt, source } : { observedAt, source, destination };
}

function staleResult(
  attempt: RemoteAttempt,
  evidence: UncertainReconciliationEvidence,
  reason: "source-epoch-changed" | "source-modseq-changed" | "destination-epoch-changed",
): UncertainReconciliationResult {
  return { kind: "stale", certainty: "definite", attempt, evidence, reason };
}

/**
 * Build a one-attempt read-only reconciliation adapter. It never receives a
 * mutation adapter or executor capability, and it performs no retry or target
 * iteration. Move success requires a present exact destination UID.
 */
export function createUncertainReconciliationAdapter(
  options: UncertainReconciliationAdapterOptions,
): Readonly<{
  readonly reconcile: (input: unknown) => Promise<UncertainReconciliationResult>;
  readonly read: (input: unknown) => Promise<UncertainReconciliationResult>;
}> {
  const parsedOptions = parseOptions(options);
  const reconcile = async (value: unknown): Promise<UncertainReconciliationResult> => {
    const input = parseInput(value, parsedOptions.destination);
    if (
      input.attempt.target.accountId !== parsedOptions.source.accountId ||
      input.attempt.target.mailboxId !== parsedOptions.source.mailboxId
    ) {
      throw new UncertainReconciliationAdapterError(
        "identity-mismatch",
        "attempt target mismatches source identity",
      );
    }
    const sourceMailbox: UncertainReconciliationMailbox = {
      accountId: parsedOptions.source.accountId,
      mailboxId: parsedOptions.source.mailboxId,
      path: parsedOptions.source.path,
      uidValidity: parsedOptions.source.uidValidity ?? input.attempt.target.uidValidity,
    };
    const sourceRead = await readOne(parsedOptions, sourceMailbox, input.attempt.target.uid);
    const sourceResult = sourceRead.result;
    const sourceEvidenceValue = sourceEvidence(input.observedAt, sourceResult);
    if (sourceRead.transportError) {
      return {
        kind: "still-uncertain",
        certainty: "uncertain",
        attempt: input.attempt,
        evidence: sourceEvidenceValue,
        reason: "transport-error",
      };
    }
    if (sourceResult.kind === "epoch_changed") {
      return staleResult(input.attempt, sourceEvidenceValue, "source-epoch-changed");
    }
    if (sourceResult.kind === "unsupported") {
      return {
        kind: "still-uncertain",
        certainty: "uncertain",
        attempt: input.attempt,
        evidence: sourceEvidenceValue,
        reason: "unsupported-observation",
      };
    }

    const isMove =
      input.attempt.action.kind === "moveToArchive" || input.attempt.action.kind === "moveToTrash";
    if (!isMove) {
      if (sourceResult.kind === "missing") {
        return {
          kind: "still-uncertain",
          certainty: "uncertain",
          attempt: input.attempt,
          evidence: sourceEvidenceValue,
          reason: "source-missing",
        };
      }
      const applied =
        flagsContainSeen(sourceResult.observation.flags) === actionWantsSeen(input.attempt.action);
      if (applied) {
        return {
          kind: "applied",
          certainty: "definite",
          attempt: input.attempt,
          postcondition: {
            kind: "flags",
            observedAt: input.observedAt,
            flags: sourceResult.observation.flags,
            modseq: sourceResult.observation.modseq,
          },
          evidence: sourceEvidenceValue,
        };
      }
      if (sourceResult.observation.modseq !== input.attempt.target.precondition.modseq) {
        return staleResult(input.attempt, sourceEvidenceValue, "source-modseq-changed");
      }
      return {
        kind: "not-applied",
        certainty: "definite",
        attempt: input.attempt,
        evidence: sourceEvidenceValue,
      };
    }

    if (input.destination === undefined) {
      return {
        kind: "still-uncertain",
        certainty: "uncertain",
        attempt: input.attempt,
        evidence: sourceEvidenceValue,
        reason: "destination-identity-unavailable",
      };
    }
    const destinationRead = await readOne(parsedOptions, input.destination, input.destination.uid);
    const evidence = sourceEvidence(input.observedAt, sourceResult, destinationRead.result);
    if (destinationRead.transportError) {
      return {
        kind: "still-uncertain",
        certainty: "uncertain",
        attempt: input.attempt,
        evidence,
        reason: "transport-error",
      };
    }
    const destination = destinationRead.result;
    if (destination.kind === "epoch_changed") {
      return staleResult(input.attempt, evidence, "destination-epoch-changed");
    }
    if (destination.kind === "unsupported") {
      return {
        kind: "still-uncertain",
        certainty: "uncertain",
        attempt: input.attempt,
        evidence,
        reason: "unsupported-observation",
      };
    }
    if (
      sourceResult.kind === "present" &&
      sourceResult.observation.modseq !== input.attempt.target.precondition.modseq
    ) {
      return staleResult(input.attempt, evidence, "source-modseq-changed");
    }
    if (sourceResult.kind === "missing" && destination.kind === "present") {
      return {
        kind: "applied",
        certainty: "definite",
        attempt: input.attempt,
        postcondition: {
          kind: "mailbox",
          observedAt: input.observedAt,
          mailboxId: destination.observation.mailboxId,
          uidValidity: destination.observation.uidValidity,
          uid: destination.observation.uid,
          modseq: destination.observation.modseq,
        },
        evidence,
      };
    }
    if (sourceResult.kind === "present" && destination.kind === "missing") {
      return { kind: "not-applied", certainty: "definite", attempt: input.attempt, evidence };
    }
    return {
      kind: "still-uncertain",
      certainty: "uncertain",
      attempt: input.attempt,
      evidence,
      reason: sourceResult.kind === "missing" ? "destination-missing" : "partial-move",
    };
  };
  return { reconcile, read: reconcile };
}

export type UncertainReconciliationAdapterOptions = Readonly<{
  readonly client: ImapFlowUncertainReconciliationClient;
  readonly source: unknown;
  readonly destination?: unknown;
}>;

/** Compatibility spelling for callers that name the uncertain attempt first. */
export const createUncertainAttemptReconciliationAdapter = createUncertainReconciliationAdapter;

export function reconciliationDetail(value: UncertainReconciliationResult): string {
  return detail(
    value.evidence,
    value.kind === "stale" || value.kind === "still-uncertain" ? value.reason : value.kind,
  );
}

export function reconciliationResultAt(value: UncertainReconciliationResult): UtcInstant {
  return value.evidence.observedAt;
}

/** Convert the read-only classification to the existing durable result algebra. */
export function toRemoteAttemptResult(
  value: UncertainReconciliationResult,
  uncertainReason: UncertainReason = "local-result-not-durable",
) {
  const base = {
    planId: value.attempt.planId,
    action: value.attempt.action,
    target: value.attempt.target,
    attemptId: value.attempt.attemptId,
    idempotencyKey: value.attempt.idempotencyKey,
    startedAt: value.attempt.startedAt,
    resultAt: value.evidence.observedAt,
  };
  const safeDetail = detail(
    value.evidence,
    value.kind === "stale" || value.kind === "still-uncertain" ? value.reason : value.kind,
  );
  switch (value.kind) {
    case "applied":
      return createRemoteAttemptSuccess({
        ...base,
        kind: "success",
        certainty: "definite",
        postcondition: value.postcondition,
      });
    case "not-applied":
      return createRemoteAttemptRejected({
        ...base,
        kind: "rejected",
        certainty: "definite",
        detail: safeDetail,
      });
    case "stale":
      return createRemoteAttemptStale({
        ...base,
        kind: "stale",
        certainty: "definite",
        detail: safeDetail,
      });
    case "still-uncertain":
      return createRemoteAttemptUncertain({
        ...base,
        kind: "uncertain",
        certainty: "uncertain",
        uncertainReason,
        detail: safeDetail,
      });
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

export const normalizeUncertainReconciliationResult = toRemoteAttemptResult;

/**
 * Compose the IMAP-specific read classification with the storage observer
 * contract. The durable service supplies the result timestamp; dispatch
 * evidence has already been reopened and identity-checked by storage.
 */
export type UncertainReconciliationObserver = Readonly<{
  readonly read: (
    input: Readonly<{
      readonly attempt: RemoteAttempt;
      readonly resultAt: UtcInstant;
    }>,
  ) => Promise<Exclude<RemoteAttemptResult, { readonly kind: "failed" }>>;
}>;

export function createUncertainReconciliationObserver(
  adapter: Readonly<{
    readonly read: (input: unknown) => Promise<UncertainReconciliationResult>;
  }>,
): UncertainReconciliationObserver {
  return {
    read: async ({ attempt, resultAt }) =>
      toRemoteAttemptResult(await adapter.read({ attempt, observedAt: resultAt })),
  };
}
