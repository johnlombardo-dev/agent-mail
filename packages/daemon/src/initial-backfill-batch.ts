import { createHash } from "node:crypto";
import {
  createMessageId,
  createRemoteUid,
  createRemoteUidValue,
  createUtcInstant,
  serializeRemoteUid,
  type AccountId,
  type MailboxId,
  type MessageId,
  type RemoteUid,
  type UtcInstant,
  type UidValidity,
} from "@agent-mail/core";
import {
  MAX_METADATA_BATCH_UIDS,
  type MetadataBatchAdapter,
  type MetadataBatchItem,
} from "../../imap/src/metadata-batch";
import type { UidRange } from "../../imap/src/uid-range-planner";
import type { RawBlobStageOwner, RawMessageDownloadRequest } from "../../imap/src/raw-download";
import type {
  MailboxCheckpoint,
  MailboxCheckpointInput,
  SaveMailboxCheckpointInput,
} from "../../storage/src/checkpoint-repository";
import type { PromotionCommit } from "../../storage/src/promotion-adapter";
import type { SingleMessageIngestionInput } from "./single-message-ingestion";

/** A bounded, serial initial-backfill operation. It intentionally has no range loop. */
export type InitialBackfillBatchRequest = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly range: UidRange;
  readonly stagingDirectory: string;
  readonly owner: RawBlobStageOwner;
}>;

export type InitialBackfillCheckpointRepository = Readonly<{
  readonly read: (
    identity: Readonly<{
      readonly accountId: AccountId;
      readonly mailboxId: MailboxId;
      readonly uidValidity: UidValidity;
    }>,
  ) => MailboxCheckpoint | undefined;
  readonly save: (input: SaveMailboxCheckpointInput) => MailboxCheckpoint;
}>;

/** The already-owned one-message caller. It must await queue/child cleanup before settling. */
export type InitialBackfillSingleMessageIngestion = (
  input: SingleMessageIngestionInput,
) => Promise<PromotionCommit>;

export type InitialBackfillMissingObservation = Readonly<{
  readonly messageId: MessageId;
  readonly remoteUid: RemoteUid;
  readonly absenceReason: "provider-unavailable";
  readonly observedAt: UtcInstant;
}>;

/** Metadata persistence is separate from promotion because placement observation owns its transaction. */
export type InitialBackfillMetadataPersistence = (
  item: MetadataBatchItem,
  context: Readonly<{
    readonly observationOrder: number;
    readonly sourceCheckpoint: string;
    readonly observedAt: UtcInstant;
  }>,
) => void;

export type InitialBackfillMissingPersistence = (
  observation: InitialBackfillMissingObservation,
) => void;

export type InitialBackfillBatchDependencies = Readonly<{
  readonly metadata: MetadataBatchAdapter;
  readonly checkpoints: InitialBackfillCheckpointRepository;
  readonly ingestSingleMessage: InitialBackfillSingleMessageIngestion;
  readonly persistMetadata: InitialBackfillMetadataPersistence;
  readonly persistMissing: InitialBackfillMissingPersistence;
  readonly observedAt?: UtcInstant;
  readonly signal?: AbortSignal;
}>;

export type InitialBackfillBatchResult = Readonly<{
  readonly status: "committed" | "cancelled";
  /** The checkpoint that was durable when this operation returned. */
  readonly checkpoint: MailboxCheckpoint;
  readonly processedUids: readonly number[];
}>;

function rangeUids(range: UidRange): readonly ReturnType<typeof createRemoteUidValue>[] {
  if (range.start > range.end) throw new RangeError("initial backfill range must be ascending");
  const span = range.end - range.start + 1;
  if (!Number.isSafeInteger(span) || span <= 0 || span > MAX_METADATA_BATCH_UIDS) {
    throw new RangeError(
      `initial backfill range must contain at most ${MAX_METADATA_BATCH_UIDS} UIDs`,
    );
  }
  return Array.from({ length: span }, (_, index) => createRemoteUidValue(range.start + index));
}

function checkpointIdentity(request: InitialBackfillBatchRequest): Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
}> {
  return {
    accountId: request.accountId,
    mailboxId: request.mailboxId,
    uidValidity: request.uidValidity,
  };
}

function sourceCheckpoint(request: InitialBackfillBatchRequest): string {
  return `initial-backfill-v1:${createHash("sha256")
    .update(
      JSON.stringify([
        request.accountId,
        request.mailboxId,
        request.uidValidity,
        request.range.start,
        request.range.end,
      ]),
    )
    .digest("hex")}`;
}

function missingMessageId(remoteUid: RemoteUid): MessageId {
  const digest = createHash("sha256").update(serializeRemoteUid(remoteUid)).digest("hex");
  return createMessageId(`message:${digest}`);
}

function nextUid(value: number): ReturnType<typeof createRemoteUidValue> {
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("initial backfill range has no representable next UID");
  }
  return createRemoteUidValue(value + 1);
}

function checkpointForNextUid(
  current: MailboxCheckpoint,
  rangeEnd: number,
): MailboxCheckpointInput {
  return {
    accountId: current.accountId,
    mailboxId: current.mailboxId,
    uidValidity: current.uidValidity,
    uidNext: { kind: "known", value: nextUid(rangeEnd) },
    modseq: current.modseq,
    sweepCursor: current.sweepCursor,
    backfillCompleted: current.backfillCompleted,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Initial backfill was aborted", "AbortError");
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

/**
 * Process exactly one planned metadata range. Message work is serial and the
 * checkpoint is advanced in one CAS per UID, only after that UID has a durable terminal
 * observation. No completion flag, retry, sweep, or second range is owned here.
 */
export async function runInitialBackfillBatch(
  request: InitialBackfillBatchRequest,
  dependencies: InitialBackfillBatchDependencies,
): Promise<InitialBackfillBatchResult> {
  const uids = rangeUids(request.range);
  const identity = checkpointIdentity(request);
  let current = dependencies.checkpoints.read(identity);
  if (current === undefined) throw new Error("initial backfill checkpoint does not exist");
  if (
    current.accountId !== request.accountId ||
    current.mailboxId !== request.mailboxId ||
    current.uidValidity !== request.uidValidity
  ) {
    throw new Error("initial backfill checkpoint identity does not match the planned range");
  }
  if (
    (current.uidNext.kind === "known" && current.uidNext.value !== request.range.start) ||
    (current.uidNext.kind === "unknown" && request.range.start !== 1)
  ) {
    throw new Error("initial backfill range would skip an unprocessed UID");
  }

  const observedAt = dependencies.observedAt ?? createUtcInstant(new Date().toISOString());
  const source = sourceCheckpoint(request);
  const processed: number[] = [];
  let metadataResult;
  try {
    throwIfAborted(dependencies.signal);
    metadataResult = await dependencies.metadata.fetch({
      accountId: request.accountId,
      mailboxId: request.mailboxId,
      uidValidity: request.uidValidity,
      uids: uids.map((uid) => createRemoteUidValue(uid)),
    });
    throwIfAborted(dependencies.signal);
  } catch (error: unknown) {
    if (isAbort(error, dependencies.signal)) {
      return { status: "cancelled", checkpoint: current, processedUids: Object.freeze(processed) };
    }
    throw error;
  }

  const items = new Map(metadataResult.items.map((item) => [item.identity.uid, item]));
  const missing = new Set(metadataResult.missingUids);
  if (
    items.size + missing.size !== uids.length ||
    uids.some((uid) => !items.has(uid) && !missing.has(uid))
  ) {
    throw new Error("metadata batch did not account for every planned UID");
  }

  for (const uid of uids) {
    try {
      throwIfAborted(dependencies.signal);
      const item = items.get(uid);
      if (item !== undefined) {
        const messageRequest: RawMessageDownloadRequest = {
          accountId: request.accountId,
          mailboxId: request.mailboxId,
          uidValidity: request.uidValidity,
          uid: createRemoteUidValue(uid),
          stagingDirectory: request.stagingDirectory,
          owner: request.owner,
          signal: dependencies.signal,
        };
        const result = await dependencies.ingestSingleMessage({
          request: messageRequest,
          metadata: item,
        });
        if (result.status !== "committed" && result.status !== "duplicate") {
          throw new Error("single-message ingestion did not return a terminal promotion result");
        }
        dependencies.persistMetadata(item, {
          observationOrder: uid,
          sourceCheckpoint: source,
          observedAt,
        });
      } else {
        const remoteUid = createRemoteUid({
          accountId: request.accountId,
          mailboxId: request.mailboxId,
          uidValidity: request.uidValidity,
          uid: createRemoteUidValue(uid),
        });
        dependencies.persistMissing({
          messageId: missingMessageId(remoteUid),
          remoteUid,
          absenceReason: "provider-unavailable",
          observedAt,
        });
      }
      // Persist the cursor immediately after this UID's terminal observation.
      // If cancellation arrives after the message/identity write, this CAS is
      // still allowed to record that completed UID; cancellation on the next
      // iteration then returns this newest durable checkpoint.
      current = dependencies.checkpoints.save({
        checkpoint: checkpointForNextUid(current, uid),
        expectedVersion: current.observedVersion,
      });
      processed.push(uid);
    } catch (error: unknown) {
      if (isAbort(error, dependencies.signal)) {
        return {
          status: "cancelled",
          checkpoint: current,
          processedUids: Object.freeze(processed),
        };
      }
      throw error;
    }
  }

  return { status: "committed", checkpoint: current, processedUids: Object.freeze(processed) };
}
