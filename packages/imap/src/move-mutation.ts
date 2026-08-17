import {
  createRemoteUidValue,
  type AccountId,
  type Action,
  type MailboxId,
  type RemoteAttempt,
  type RemoteUidValue,
  type UidValidity,
} from "@agent-mail/core";
import type { ResolvedSpecialUseMailbox, SpecialUseDestinationRole } from "./special-use-resolver";
import type { RemoteMutationAdapter, RemoteMutationRequest } from "./remote-executor";
import type { ImapFlow } from "imapflow";
import {
  createImapFlowTaggedStorePrimitive,
  IMAP_TAGGED_STORE_FLAG_DELETED,
  type ImapTaggedStoreResult,
} from "./tagged-conditional-store";

/** ImapFlow's mutation lock is writable, but this adapter owns no close path. */
export const IMAP_MOVE_LOCK_OPTIONS = Object.freeze({ readOnly: false });
export const IMAP_MOVE_UID_OPTIONS = Object.freeze({ uid: true });
export const IMAP_MOVE_DELETED_FLAG = "\\Deleted";

type ImapCapabilities =
  | ReadonlyMap<string, boolean | number>
  | ReadonlySet<string>
  | readonly string[];

/**
 * The production-shaped portion of ImapFlow required by one move. The
 * deliberately narrow surface excludes messageDelete, expunge, mailboxClose,
 * and folder creation operations.
 */
export interface ImapFlowMoveClient {
  readonly capabilities: ImapCapabilities;
  readonly mailbox: unknown;
  readonly getMailboxLock: (
    path: string,
    options: typeof IMAP_MOVE_LOCK_OPTIONS,
  ) => Promise<unknown>;
  readonly messageMove: (
    range: string,
    destination: string,
    options: typeof IMAP_MOVE_UID_OPTIONS,
  ) => Promise<unknown>;
  readonly messageCopy?: (
    range: string,
    destination: string,
    options: typeof IMAP_MOVE_UID_OPTIONS,
  ) => Promise<unknown>;
  /**
   * A wrapper-owned primitive. ImapFlow's messageFlagsAdd is not sufficient:
   * it ignores UNCHANGEDSINCE without CONDSTORE and returns false for both
   * missing and tagged MODIFIED responses.
   */
  readonly conditionalDeleted?: (
    range: string,
    options: Readonly<{ readonly uid: true; readonly unchangedSince: bigint }>,
  ) => Promise<ConditionalDeletedStatus>;
  readonly conditionalDeletedSupported?: () => boolean;
}

export type ConditionalDeletedStatus =
  | "applied"
  | "already_deleted"
  | "modified"
  | "missing"
  | "unsupported"
  | "transport_before"
  | "transport_after";

export type ConditionalDeletedPrimitive = (
  range: string,
  options: Readonly<{ readonly uid: true; readonly unchangedSince: bigint }>,
) => Promise<ConditionalDeletedStatus>;

function mapTaggedStoreResult(result: ImapTaggedStoreResult): ConditionalDeletedStatus {
  switch (result.kind) {
    case "applied":
      return "applied";
    case "modified":
      return "modified";
    case "missing":
      return "missing";
    case "rejected":
      if (result.status === "unsupported") return "unsupported";
      return result.phase === "before_transmission" ? "transport_before" : "transport_after";
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/**
 * Adapt the installed ImapFlow methods without exposing its unsafe MOVE
 * fallback. Conditional deletion is implemented with the shared tagged STORE
 * primitive so RFC 7162 MODIFIED responses and transport certainty survive the
 * ImapFlow compatibility boundary.
 */
export function createImapFlowMoveClient(flow: ImapFlow): ImapFlowMoveClient {
  const taggedStore = createImapFlowTaggedStorePrimitive(flow);
  const conditionalDeleted: ConditionalDeletedPrimitive = async (range, options) =>
    mapTaggedStoreResult(
      await taggedStore({
        range,
        operation: "add",
        flags: [IMAP_TAGGED_STORE_FLAG_DELETED],
        options,
      }),
    );
  return {
    capabilities: flow.capabilities,
    get mailbox(): unknown {
      return flow.mailbox;
    },
    getMailboxLock: (path, options) => flow.getMailboxLock(path, options),
    messageMove: (range, destination, options) => flow.messageMove(range, destination, options),
    messageCopy: (range, destination, options) => flow.messageCopy(range, destination, options),
    conditionalDeleted,
    conditionalDeletedSupported: () => {
      const mailbox = flow.mailbox;
      return (
        flow.enabled.has("CONDSTORE") &&
        typeof mailbox === "object" &&
        mailbox !== null &&
        mailbox.noModseq !== true
      );
    },
  };
}

export type MoveMutationSource = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  /** Provider-decoded path captured for this exact source mailbox identity. */
  readonly path: string;
}>;

export type MoveCommandTraceEntry =
  | Readonly<{
      readonly kind: "getMailboxLock";
      readonly path: string;
      readonly options: typeof IMAP_MOVE_LOCK_OPTIONS;
    }>
  | Readonly<{
      readonly kind: "messageMove";
      readonly uid: RemoteUidValue;
      readonly destination: string;
      readonly options: typeof IMAP_MOVE_UID_OPTIONS;
    }>
  | Readonly<{
      readonly kind: "messageCopy";
      readonly uid: RemoteUidValue;
      readonly destination: string;
      readonly options: typeof IMAP_MOVE_UID_OPTIONS;
    }>
  | Readonly<{
      readonly kind: "conditionalDeleted";
      readonly uid: RemoteUidValue;
      readonly options: Readonly<{ readonly uid: true; readonly unchangedSince: bigint }>;
      readonly status: ConditionalDeletedStatus;
    }>
  | Readonly<{ readonly kind: "release" }>;

export type MovePlacementObservation = Readonly<{
  readonly source: Readonly<{
    /** Logical placement absence; COPY+DELETED deliberately does not expunge the source row. */
    readonly kind: "absent";
    readonly mailboxId: MailboxId;
    readonly uidValidity: UidValidity;
    readonly uid: RemoteUidValue;
  }>;
  readonly destination: Readonly<{
    readonly kind: "present";
    readonly mailboxId: MailboxId;
    readonly uidValidity: UidValidity | null;
    /** UIDPLUS is optional; presence remains observed when no destination UID is returned. */
    readonly uid: RemoteUidValue | null;
  }>;
  readonly mechanism: "MOVE" | "COPY+DELETED";
}>;

export type MovePartialPlacementObservation = Readonly<{
  readonly source: Readonly<{
    readonly kind: "present";
    readonly mailboxId: MailboxId;
    readonly uidValidity: UidValidity;
    readonly uid: RemoteUidValue;
  }>;
  readonly destination: MovePlacementObservation["destination"];
  readonly mechanism: "COPY+DELETED";
}>;

type MoveMutationResultInput =
  | Readonly<{
      readonly kind: "applied";
      readonly certainty: "definite";
      readonly observation: MovePlacementObservation;
      readonly trace: readonly MoveCommandTraceEntry[];
    }>
  | Readonly<{
      readonly kind: "partial";
      readonly certainty: "uncertain";
      readonly observation: MovePartialPlacementObservation;
      readonly reason: "conditional-delete-rejected" | "conditional-delete-transport";
      readonly trace: readonly MoveCommandTraceEntry[];
    }>
  | Readonly<{
      readonly kind: "precondition_failed";
      readonly certainty: "definite";
      readonly trace: readonly MoveCommandTraceEntry[];
    }>
  | Readonly<{
      readonly kind: "missing";
      readonly certainty: "definite";
      readonly trace: readonly MoveCommandTraceEntry[];
    }>
  | Readonly<{
      readonly kind: "unsupported";
      readonly certainty: "definite";
      readonly trace: readonly MoveCommandTraceEntry[];
    }>
  | Readonly<{
      readonly kind: "uncertain_transport";
      readonly certainty: "definite" | "uncertain";
      readonly phase: "before_transmission" | "after_transmission";
      readonly trace: readonly MoveCommandTraceEntry[];
    }>;

type MoveMutationOutcome = MoveMutationResultInput extends infer TResult
  ? TResult extends Readonly<Record<string, unknown>>
    ? Omit<TResult, "trace">
    : never
  : never;

type MoveMutationResultBase = Readonly<{
  readonly target: RemoteAttempt["target"];
}>;

export type MoveMutationResult = MoveMutationResultBase & MoveMutationResultInput;

export type MoveMutationAdapterOptions = Readonly<{
  readonly client: ImapFlowMoveClient;
  readonly source: MoveMutationSource;
  readonly role: SpecialUseDestinationRole;
  /** Exact selectable destination returned by the SPECIAL-USE resolver. */
  readonly destination: ResolvedSpecialUseMailbox;
}>;

export class MoveMutationAdapterError extends TypeError {
  readonly code: "invalid-client" | "invalid-source" | "invalid-destination";

  constructor(code: "invalid-client" | "invalid-source" | "invalid-destination", message: string) {
    super(message);
    this.name = "MoveMutationAdapterError";
    this.code = code;
  }
}

type Lock = Readonly<{ readonly release: () => void }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCapability(capabilities: ImapCapabilities, expected: string): boolean {
  const normalized = expected.toUpperCase();
  if (Array.isArray(capabilities)) {
    return capabilities.some((name) => name.toUpperCase() === normalized);
  }
  if (capabilities instanceof Map || capabilities instanceof Set) {
    return [...capabilities.keys()].some(
      (name) => typeof name === "string" && name.toUpperCase() === normalized,
    );
  }
  return false;
}

function isLock(value: unknown): value is Lock {
  return isRecord(value) && typeof value.release === "function";
}

function sourceSelectionMatches(
  value: unknown,
  source: MoveMutationSource,
  target: RemoteAttempt["target"],
): boolean {
  if (!isRecord(value) || value.path !== source.path) return false;
  if (value.uidValidity === undefined || value.uidValidity === null) return false;
  const uidValidity =
    typeof value.uidValidity === "bigint" ? Number(value.uidValidity) : value.uidValidity;
  return uidValidity === target.uidValidity;
}

function responseDestinationUid(value: unknown, sourceUid: RemoteUidValue): RemoteUidValue | null {
  if (!isRecord(value) || !(value.uidMap instanceof Map)) return null;
  const mapped = value.uidMap.get(sourceUid);
  if (typeof mapped === "number" && Number.isSafeInteger(mapped) && mapped > 0) {
    return createRemoteUidValue(mapped);
  }
  if (typeof mapped === "bigint" && mapped > 0n && mapped <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return createRemoteUidValue(Number(mapped));
  }
  return null;
}

function responseDestinationMatches(
  value: unknown,
  sourcePath: string,
  destinationPath: string,
): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path === sourcePath &&
    typeof value.destination === "string" &&
    value.destination === destinationPath
  );
}

function traceOf(entries: readonly MoveCommandTraceEntry[]): readonly MoveCommandTraceEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function actionMatchesRole(action: Action, role: SpecialUseDestinationRole): boolean {
  return role === "archive" ? action.kind === "moveToArchive" : action.kind === "moveToTrash";
}

function result(
  kind: Exclude<MoveMutationResult["kind"], "applied" | "partial" | "uncertain_transport">,
  target: RemoteAttempt["target"],
  entries: readonly MoveCommandTraceEntry[],
): MoveMutationResult {
  const trace = traceOf(entries);
  switch (kind) {
    case "precondition_failed":
      return { target, kind, certainty: "definite", trace };
    case "missing":
      return { target, kind, certainty: "definite", trace };
    case "unsupported":
      return { target, kind, certainty: "definite", trace };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function transportResult(
  target: RemoteAttempt["target"],
  entries: readonly MoveCommandTraceEntry[],
  phase: "before_transmission" | "after_transmission",
): MoveMutationResult {
  return {
    target,
    kind: "uncertain_transport",
    certainty: phase === "before_transmission" ? "definite" : "uncertain",
    phase,
    trace: traceOf(entries),
  };
}

function validateOptions(options: MoveMutationAdapterOptions): void {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.client !== "object" ||
    options.client === null ||
    typeof options.client.getMailboxLock !== "function" ||
    typeof options.client.messageMove !== "function"
  ) {
    throw new MoveMutationAdapterError(
      "invalid-client",
      "move adapter requires an ImapFlow-shaped client",
    );
  }
  if (
    options.source.path.trim().length === 0 ||
    options.source.accountId !== options.destination.accountId
  ) {
    throw new MoveMutationAdapterError(
      "invalid-source",
      "move source must have a path and match the destination account",
    );
  }
  if (options.destination.path.trim().length === 0) {
    throw new MoveMutationAdapterError("invalid-destination", "move destination must have a path");
  }
  if (options.destination.mailboxId === options.source.mailboxId) {
    throw new MoveMutationAdapterError(
      "invalid-destination",
      "move destination must differ from the source mailbox",
    );
  }
}

function placementObservation(
  target: RemoteAttempt["target"],
  destination: ResolvedSpecialUseMailbox,
  destinationUid: RemoteUidValue | null,
  mechanism: MovePlacementObservation["mechanism"],
): MovePlacementObservation {
  const destinationUidValidity =
    destination.epoch.uidValidity.kind === "known" ? destination.epoch.uidValidity.value : null;
  return {
    source: {
      kind: "absent",
      mailboxId: target.mailboxId,
      uidValidity: target.uidValidity,
      uid: target.uid,
    },
    destination: {
      kind: "present",
      mailboxId: destination.mailboxId,
      uidValidity: destinationUidValidity,
      uid: destinationUid,
    },
    mechanism,
  };
}

function partialPlacementObservation(
  target: RemoteAttempt["target"],
  destination: ResolvedSpecialUseMailbox,
  destinationUid: RemoteUidValue | null,
): MovePartialPlacementObservation {
  const destinationObservation = placementObservation(
    target,
    destination,
    destinationUid,
    "COPY+DELETED",
  );
  return {
    source: {
      kind: "present",
      mailboxId: target.mailboxId,
      uidValidity: target.uidValidity,
      uid: target.uid,
    },
    destination: destinationObservation.destination,
    mechanism: "COPY+DELETED",
  };
}

function isPreconditionFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.code === "MODIFIED" || value.responseCode === "MODIFIED";
}

function isExplicitMissing(value: unknown): boolean {
  return isRecord(value) && value.kind === "missing";
}

function isBeforeTransmissionFailure(value: unknown): boolean {
  return isRecord(value) && (value.transmitted === false || value.beforeTransmission === true);
}

/**
 * Construct the internal, one-shot-capability-backed move adapter. The
 * adapter executes one attempt only; callers must pass the request received
 * from executeRemoteAttempt and cannot provide an arbitrary target.
 */
export function createMoveMutationAdapter(
  options: MoveMutationAdapterOptions,
): RemoteMutationAdapter {
  validateOptions(options);
  return {
    async execute(request: RemoteMutationRequest): Promise<MoveMutationResult> {
      const entries: MoveCommandTraceEntry[] = [];
      const attempt = request.attempt;
      if (
        attempt.target.accountId !== options.source.accountId ||
        attempt.target.mailboxId !== options.source.mailboxId ||
        !actionMatchesRole(attempt.action, options.role)
      ) {
        return result("precondition_failed", attempt.target, entries);
      }

      let lock: Lock | undefined;
      let transmitted = false;
      const finish = <T extends MoveMutationOutcome>(value: T): MoveMutationResult => {
        if (lock !== undefined) {
          const heldLock = lock;
          lock = undefined;
          entries.push({ kind: "release" });
          heldLock.release();
        }
        return { target: attempt.target, ...value, trace: traceOf(entries) };
      };
      try {
        entries.push({
          kind: "getMailboxLock",
          path: options.source.path,
          options: IMAP_MOVE_LOCK_OPTIONS,
        });
        let acquired: unknown;
        try {
          acquired = await options.client.getMailboxLock(
            options.source.path,
            IMAP_MOVE_LOCK_OPTIONS,
          );
        } catch {
          return transportResult(attempt.target, entries, "before_transmission");
        }
        if (!isLock(acquired)) return result("unsupported", attempt.target, entries);
        lock = acquired;

        if (!sourceSelectionMatches(options.client.mailbox, options.source, attempt.target)) {
          return finish({ kind: "precondition_failed", certainty: "definite" });
        }

        const canMove = hasCapability(options.client.capabilities, "MOVE");
        if (canMove) {
          entries.push({
            kind: "messageMove",
            uid: attempt.target.uid,
            destination: options.destination.path,
            options: IMAP_MOVE_UID_OPTIONS,
          });
          transmitted = true;
          let moved: unknown;
          try {
            moved = await options.client.messageMove(
              String(attempt.target.uid),
              options.destination.path,
              IMAP_MOVE_UID_OPTIONS,
            );
          } catch (error) {
            if (isPreconditionFailure(error)) {
              return finish({ kind: "precondition_failed", certainty: "definite" });
            }
            if (isBeforeTransmissionFailure(error)) {
              return finish({
                kind: "uncertain_transport",
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
          if (isExplicitMissing(moved)) return finish({ kind: "missing", certainty: "definite" });
          // ImapFlow 1.7.1's messageMove collapses tagged NO/BAD and socket
          // failures to false. A collapsed result is not evidence that the
          // source UID was absent, so preserve retry uncertainty.
          if (
            moved === false ||
            !isRecord(moved) ||
            !responseDestinationMatches(moved, options.source.path, options.destination.path)
          ) {
            return finish({
              kind: "uncertain_transport",
              certainty: "uncertain",
              phase: "after_transmission",
            });
          }
          return finish({
            kind: "applied",
            certainty: "definite",
            observation: placementObservation(
              attempt.target,
              options.destination,
              responseDestinationUid(moved, attempt.target.uid),
              "MOVE",
            ),
          });
        }

        if (
          typeof options.client.messageCopy !== "function" ||
          typeof options.client.conditionalDeleted !== "function" ||
          options.client.conditionalDeletedSupported?.() !== true
        ) {
          return finish({ kind: "unsupported", certainty: "definite" });
        }

        entries.push({
          kind: "messageCopy",
          uid: attempt.target.uid,
          destination: options.destination.path,
          options: IMAP_MOVE_UID_OPTIONS,
        });
        transmitted = true;
        let copied: unknown;
        try {
          copied = await options.client.messageCopy(
            String(attempt.target.uid),
            options.destination.path,
            IMAP_MOVE_UID_OPTIONS,
          );
        } catch (error) {
          if (isBeforeTransmissionFailure(error)) {
            return finish({
              kind: "uncertain_transport",
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
        if (isExplicitMissing(copied)) return finish({ kind: "missing", certainty: "definite" });
        // ImapFlow 1.7.1's messageCopy also collapses tagged NO/BAD and
        // socket failures to false. That is not evidence that the source UID
        // was missing, so preserve retry uncertainty after COPY was attempted.
        if (copied === false) {
          return finish({
            kind: "uncertain_transport",
            certainty: "uncertain",
            phase: "after_transmission",
          });
        }
        if (!responseDestinationMatches(copied, options.source.path, options.destination.path)) {
          return finish({
            kind: "uncertain_transport",
            certainty: "uncertain",
            phase: "after_transmission",
          });
        }

        const deletedOptions = Object.freeze({
          uid: true as const,
          unchangedSince: BigInt(attempt.target.precondition.modseq),
        });
        transmitted = true;
        let deleted: ConditionalDeletedStatus;
        try {
          deleted = await options.client.conditionalDeleted(
            String(attempt.target.uid),
            deletedOptions,
          );
        } catch (error) {
          deleted = isPreconditionFailure(error) ? "modified" : "transport_after";
        }
        entries.push({
          kind: "conditionalDeleted",
          uid: attempt.target.uid,
          options: deletedOptions,
          status: deleted,
        });
        if (deleted === "applied" || deleted === "already_deleted") {
          return finish({
            kind: "applied",
            certainty: "definite",
            observation: placementObservation(
              attempt.target,
              options.destination,
              responseDestinationUid(copied, attempt.target.uid),
              "COPY+DELETED",
            ),
          });
        }
        return finish({
          kind: "partial",
          certainty: "uncertain",
          reason:
            deleted === "transport_before" || deleted === "transport_after"
              ? "conditional-delete-transport"
              : "conditional-delete-rejected",
          observation: partialPlacementObservation(
            attempt.target,
            options.destination,
            responseDestinationUid(copied, attempt.target.uid),
          ),
        });
      } catch {
        return finish({
          kind: "uncertain_transport",
          certainty: transmitted ? "uncertain" : "definite",
          phase: transmitted ? "after_transmission" : "before_transmission",
        });
      } finally {
        if (lock !== undefined) {
          const heldLock = lock;
          lock = undefined;
          entries.push({ kind: "release" });
          heldLock.release();
        }
      }
    },
  };
}
