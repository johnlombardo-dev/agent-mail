import { createHash } from "node:crypto";
import { fromPromise } from "xstate";
import type { Database } from "bun:sqlite";
import type { SyncCheckpointSummary } from "@agent-mail/contracts";
import {
  createMailboxId,
  createMessageId,
  createRemoteUidValue,
  createStreamingOffset,
  createUtcInstant,
  type AccountId,
  type MailboxId,
  type RemoteUidValue,
  type UidValidity,
  type UtcInstant,
} from "@agent-mail/core";
import {
  acquireReadOnlyImapSession,
  discoverMailboxes,
  normalizeMailboxStatus,
  normalizeProtocolError,
  parseReadOnlyMailboxLock,
  projectReadOnlyMailboxStatus,
  type MailboxSynchronizationCandidate,
  type ReadOnlyImapSession,
  type ReadOnlyImapSourceAuthority,
} from "../../../imap/src/index";
import { createMetadataBatchAdapter } from "../../../imap/src/metadata-batch";
import { createRawMessageDownloadAdapter } from "../../../imap/src/raw-download";
import { createRawMessageDownloadQueueActor } from "../../../imap/src/raw-download-queue";
import { stageBlob, type BlobStageOwner } from "../../../storage/src/blob-stage";
import { createMailboxCheckpointRepository } from "../../../storage/src/checkpoint-repository";
import { storeIdentityOnlyMessage } from "../../../storage/src/identity-only-repository";
import { observeRemotePlacement } from "../../../storage/src/remote-placement-observation";
import { createSqlitePromotionAdapter } from "../../../storage/src/promotion-adapter";
import { updateMessageSearchProjection } from "../../../storage/src/search-projection";
import {
  createInitialBackfillCompletionRepository,
  runInitialBackfillLoop,
} from "../initial-backfill-loop";
import { ingestSingleMessage } from "../single-message-ingestion";
import {
  createSyncControlDecisionChannel,
  createSyncControlService,
  type SyncControlService,
} from "../sync-control-service";
import {
  createSyncLifecycleActor,
  createSyncLifecycleDependencies,
  createSyncResourceRegistry,
  projectSyncStatus,
  type BootstrapOutput,
  type InitialBackfillActorInput,
  type LoopOutput,
  type SyncLifecycleInput,
  type WorkflowFault,
} from "../sync-statechart";

const MAX_INITIAL_UID_SPAN = 100_000;

type MailboxWork = Readonly<{
  readonly mailbox: MailboxSynchronizationCandidate;
  readonly mailboxId: MailboxId;
}>;

export type CanonicalSyncCompositionOptions = Readonly<{
  readonly database: Database;
  readonly accountId: AccountId;
  readonly source: ReadOnlyImapSourceAuthority;
  readonly stagingDirectory: string;
  readonly canonicalDirectory: string;
  readonly owner: BlobStageOwner;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly configuration?: Partial<SyncLifecycleInput["configuration"]>;
}>;

export type CanonicalSyncComposition = Readonly<{
  readonly actor: ReturnType<typeof createSyncLifecycleActor>;
  readonly control: SyncControlService;
  readonly start: () => Promise<SyncCheckpointSummary>;
  readonly close: (signal?: string) => Promise<void>;
  readonly sourceReleaseCount: () => number;
}>;

function safeFault(error: unknown): WorkflowFault {
  const normalized = normalizeProtocolError(error);
  const category =
    normalized.category === "authentication" || normalized.category === "authorization"
      ? "authentication"
      : normalized.category === "connection" || normalized.category === "timeout"
        ? "transient"
        : "permanent";
  return Object.freeze({
    category,
    code:
      category === "authentication"
        ? "sync.credentials-rejected"
        : category === "transient"
          ? "sync.source-unavailable"
          : "sync.source-invalid",
    safeMessage:
      category === "authentication"
        ? "Source credentials were rejected."
        : category === "transient"
          ? "The read-only mail source is temporarily unavailable."
          : "The read-only mail source returned invalid data.",
  });
}

function combinedSignal(left: AbortSignal, right: AbortSignal): AbortSignal {
  return AbortSignal.any([left, right]);
}

function observationTime(now: () => Date): UtcInstant {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("canonical sync clock is invalid");
  }
  return createUtcInstant(value.toISOString());
}

function futureTime(value: UtcInstant, milliseconds: number): UtcInstant {
  return createUtcInstant(new Date(Date.parse(value) + milliseconds).toISOString());
}

function uidSearchResult(value: unknown): readonly RemoteUidValue[] {
  if (!Array.isArray(value) || value.length > MAX_INITIAL_UID_SPAN) {
    throw new TypeError("IMAP UID search result is invalid or exceeds the initial-sync limit");
  }
  const uids = value.map((item) => createRemoteUidValue(item));
  if (new Set(uids).size !== uids.length)
    throw new TypeError("IMAP UID search result is duplicated");
  const sorted = [...uids].sort((left, right) => left - right);
  return Object.freeze(sorted);
}

function boundedObservedSpan(uids: readonly RemoteUidValue[]): void {
  const first = uids[0];
  const last = uids.at(-1);
  if (first !== undefined && last !== undefined && last - first + 1 > MAX_INITIAL_UID_SPAN) {
    throw new TypeError("IMAP UID span exceeds the initial-sync limit");
  }
}

function summary(database: Database, mailboxes: readonly MailboxWork[]): SyncCheckpointSummary {
  const messages = database
    .query<Readonly<{ count: number }>, []>("SELECT COUNT(*) AS count FROM messages;")
    .get()?.count;
  if (typeof messages !== "number" || !Number.isSafeInteger(messages) || messages < 0) {
    throw new Error("canonical sync message count is invalid");
  }
  const last = database
    .query<Readonly<{ mailbox_id: string; uid: number }>, []>(
      "SELECT mailbox_id, uid FROM remote_placements ORDER BY rowid DESC LIMIT 1;",
    )
    .get();
  return {
    completedMailboxes: mailboxes.length,
    totalMailboxes: mailboxes.length,
    completedMessages: messages,
    pendingMessages: 0,
    lastMailbox: last?.mailbox_id ?? null,
    lastUid: last?.uid ?? null,
  };
}

function initialSummary(): SyncCheckpointSummary {
  return {
    completedMailboxes: 0,
    totalMailboxes: 0,
    completedMessages: 0,
    pendingMessages: 0,
    lastMailbox: null,
    lastUid: null,
  };
}

function syncConfiguration(
  overrides: CanonicalSyncCompositionOptions["configuration"],
): SyncLifecycleInput["configuration"] {
  return {
    retryBaseMs: overrides?.retryBaseMs ?? 25,
    retryCapMs: overrides?.retryCapMs ?? 250,
    retryJitterRatio: overrides?.retryJitterRatio ?? 0,
    maxRetryAttempts: overrides?.maxRetryAttempts ?? 1,
    periodicStatusIntervalMs: overrides?.periodicStatusIntervalMs ?? 60_000,
    controlDeadlineMs: overrides?.controlDeadlineMs ?? 5_000,
    controlResultRetentionMs: overrides?.controlResultRetentionMs ?? 60_000,
    maxControlIdempotencyEntries: overrides?.maxControlIdempotencyEntries ?? 64,
    maxReleaseSlotEntries: overrides?.maxReleaseSlotEntries ?? 32,
  };
}

function sourceCheckpoint(accountId: AccountId, mailboxId: MailboxId, uid: number): string {
  return `runtime-observation:${createHash("sha256")
    .update(JSON.stringify([accountId, mailboxId, uid]))
    .digest("hex")}`;
}

function journalId(accountId: AccountId, mailboxId: MailboxId, uid: number): string {
  return `event:sync:${createHash("sha256")
    .update(JSON.stringify([accountId, mailboxId, uid]))
    .digest("hex")}`;
}

function isExcludedMailbox(mailbox: MailboxSynchronizationCandidate): boolean {
  const use = mailbox.specialUse?.toUpperCase();
  return use === "\\JUNK" || use === "\\TRASH";
}

export function createCanonicalSyncComposition(
  options: CanonicalSyncCompositionOptions,
): CanonicalSyncComposition {
  const configuration = syncConfiguration(options.configuration);
  const incarnationId = `incarnation:runtime:${crypto.randomUUID()}`;
  const registry = createSyncResourceRegistry({
    incarnationId,
    maxReleaseSlotEntries: configuration.maxReleaseSlotEntries,
  });
  const decisions = createSyncControlDecisionChannel();
  let session: ReadOnlyImapSession | undefined;
  let queue: ReturnType<typeof createRawMessageDownloadQueueActor> | undefined;
  let workSet: readonly MailboxWork[] = Object.freeze([]);
  let sourceReleases = 0;
  let resourceCleanupFailed = false;

  const releaseSource = async (): Promise<void> => {
    if (session === undefined) return;
    sourceReleases += 1;
    const owned = session;
    session = undefined;
    try {
      await owned.release();
    } catch (error: unknown) {
      resourceCleanupFailed = true;
      throw error;
    }
  };
  const stopQueue = async (): Promise<void> => {
    if (queue === undefined) return;
    const owned = queue;
    queue = undefined;
    try {
      await owned.stop();
    } catch (error: unknown) {
      resourceCleanupFailed = true;
      throw error;
    }
  };

  const bootstrapSession = fromPromise<BootstrapOutput, { checkpoint: SyncCheckpointSummary }>(
    async ({ signal }) => {
      try {
        const acquired = await acquireReadOnlyImapSession(
          options.source,
          combinedSignal(options.signal, signal),
        );
        session = acquired;
        try {
          registry.registerReleaseSlot?.({
            ownerScope: "workflow",
            ownerInvokeIdentity: `${incarnationId}:source`,
            resourceOrdinal: 0,
            stableResourceId: `${incarnationId}:source`,
            release: releaseSource,
          });
          const raw = createRawMessageDownloadAdapter(acquired.client, stageBlob);
          queue = createRawMessageDownloadQueueActor(raw, { capacity: 8 });
          registry.registerReleaseSlot?.({
            ownerScope: "workflow",
            ownerInvokeIdentity: `${incarnationId}:queue`,
            resourceOrdinal: 1,
            stableResourceId: `${incarnationId}:queue`,
            release: stopQueue,
          });
        } catch (error: unknown) {
          await Promise.allSettled([stopQueue(), releaseSource()]);
          throw error;
        }
        const discovered = await discoverMailboxes(acquired.client);
        workSet = Object.freeze(
          discovered.candidates
            .filter((mailbox) => !isExcludedMailbox(mailbox))
            .map((mailbox) => Object.freeze({ mailbox, mailboxId: createMailboxId(mailbox.path) })),
        );
        return {
          next: workSet.length === 0 ? "poll" : "backfill",
          checkpoint: initialSummary(),
        };
      } catch (error: unknown) {
        throw safeFault(error);
      }
    },
  );

  const initialBackfill = fromPromise<LoopOutput, InitialBackfillActorInput>(async ({ signal }) => {
    try {
      const activeSession = session;
      const activeQueue = queue;
      if (activeSession === undefined || activeQueue === undefined) {
        throw new Error("canonical sync source was not acquired");
      }
      const abortSignal = combinedSignal(options.signal, signal);
      const checkpoints = createMailboxCheckpointRepository(options.database);
      const completions = createInitialBackfillCompletionRepository(options.database);
      const promotion = createSqlitePromotionAdapter(options.database);
      const metadata = createMetadataBatchAdapter(activeSession.client);

      for (const work of workSet) {
        if (abortSignal.aborted) throw abortSignal.reason;
        const lock = parseReadOnlyMailboxLock(
          await activeSession.client.getMailboxLock(work.mailbox.path, { readOnly: true }),
        );
        try {
          const status = normalizeMailboxStatus(projectReadOnlyMailboxStatus(activeSession.client));
          if (status.uidValidity.kind !== "known") {
            throw new Error("mailbox UIDVALIDITY is unavailable");
          }
          const uidValidity: UidValidity = status.uidValidity.value;
          const uids = uidSearchResult(
            await activeSession.client.search({ all: true }, { uid: true }),
          );
          boundedObservedSpan(uids);
          const observedUidCeiling = uids.at(-1) ?? null;
          if (
            status.uidNext.kind === "known" &&
            observedUidCeiling !== null &&
            status.uidNext.value <= observedUidCeiling
          ) {
            throw new Error("mailbox UIDNEXT contradicts observed UIDs");
          }
          const identity = {
            accountId: options.accountId,
            mailboxId: work.mailboxId,
            uidValidity,
          };
          if (checkpoints.read(identity) === undefined) {
            checkpoints.save({
              checkpoint: {
                ...identity,
                uidNext: { kind: "known", value: uids[0] ?? createRemoteUidValue(1) },
                modseq: { kind: "unknown" },
                sweepCursor: createStreamingOffset(0),
                backfillCompleted: false,
              },
              expectedVersion: 0,
            });
          }
          const observedAt = observationTime(options.now);
          await runInitialBackfillLoop(
            {
              ...identity,
              observedUidCeiling,
              observedUidNext:
                status.uidNext.kind === "known"
                  ? { kind: "known", value: status.uidNext.value }
                  : { kind: "unknown" },
              observedAt,
              nextSweepEligibleAt: futureTime(observedAt, configuration.periodicStatusIntervalMs),
              maxBatchUids: 128,
              stagingDirectory: options.stagingDirectory,
              owner: options.owner,
            },
            {
              checkpoints,
              completions,
              signal: abortSignal,
              batch: {
                metadata,
                ingestSingleMessage: async (input) => {
                  const occurredAt = input.metadata.internalDate;
                  return ingestSingleMessage(input, {
                    queue: activeQueue,
                    promotion,
                    stagingDirectory: options.stagingDirectory,
                    canonicalDirectory: options.canonicalDirectory,
                    owner: options.owner,
                    routing: () => Object.freeze([]),
                    occurredAt,
                    journal: ({ downloaded, messageId }) => ({
                      id: journalId(
                        downloaded.identity.accountId,
                        downloaded.identity.mailboxId,
                        downloaded.identity.uid,
                      ),
                      occurredAt,
                      category: "sync",
                      subjectId: messageId,
                      correlationId: sourceCheckpoint(
                        downloaded.identity.accountId,
                        downloaded.identity.mailboxId,
                        downloaded.identity.uid,
                      ),
                      payloadVersion: 1,
                      payloadJson: '{"status":"promoted"}',
                    }),
                  });
                },
                persistMetadata: (item, context) => {
                  observeRemotePlacement(options.database, {
                    ...item.identity,
                    internalDate: item.internalDate,
                    flags: item.flags,
                    modseq: item.modseq,
                    observationOrder: context.observationOrder,
                    observedAt: context.observedAt,
                    sourceCheckpoint: context.sourceCheckpoint,
                  });
                  updateMessageSearchProjection(
                    options.database,
                    createMessageId(
                      options.database
                        .query<Readonly<{ message_id: string }>, [string, string, number, number]>(
                          "SELECT message_id FROM remote_placements WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND uid = ?;",
                        )
                        .get(
                          item.identity.accountId,
                          item.identity.mailboxId,
                          item.identity.uidValidity,
                          item.identity.uid,
                        )?.message_id,
                    ),
                    () => undefined,
                  );
                },
                persistMissing: (observation) => {
                  storeIdentityOnlyMessage(options.database, {
                    messageId: observation.messageId,
                    remoteUid: observation.remoteUid,
                    absenceReason: observation.absenceReason,
                    observedAt: observation.observedAt,
                    storedAt: observation.observedAt,
                  });
                },
              },
            },
          );
        } finally {
          await lock.release();
        }
      }
      const checkpoint = summary(options.database, workSet);
      return {
        status: "completed",
        checkpoint,
        completion: Object.freeze({ mailboxes: workSet.length }),
        watchStrategy: "poll",
      };
    } catch (error: unknown) {
      throw safeFault(error);
    }
  });

  const lifecycleInput: SyncLifecycleInput = {
    configuration,
    initialCheckpoint: initialSummary(),
    initialCredentialRevision: 0,
    incarnationId,
  };
  const actor = createSyncLifecycleActor(
    lifecycleInput,
    { bootstrapSession, initialBackfill },
    {
      ...createSyncLifecycleDependencies(lifecycleInput),
      resourceRegistry: registry,
      controlDecisionSink: decisions.publish,
    },
  );
  const control = createSyncControlService({
    actor: {
      getSnapshot: () => actor.getSnapshot(),
      send: (event) => actor.send(event),
      subscribe: (listener) => actor.subscribe(listener),
    },
    decisions: decisions.source,
    controlDeadlineMs: configuration.controlDeadlineMs,
    controlResultRetentionMs: configuration.controlResultRetentionMs,
    maxControlIdempotencyEntries: configuration.maxControlIdempotencyEntries,
  });

  const waitForReady = (): Promise<SyncCheckpointSummary> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let subscription: Readonly<{ unsubscribe: () => void }> | undefined;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        subscription?.unsubscribe();
        operation();
      };
      const observe = (): void => {
        const snapshot = actor.getSnapshot();
        const status = projectSyncStatus(snapshot);
        const stateValue = JSON.stringify(snapshot.value);
        if (status.actorState === "watching") {
          finish(() => resolve(snapshot.context.checkpoint));
        } else if (status.actorState === "authBlocked" || stateValue.includes("failed")) {
          finish(() =>
            reject(new Error(status.diagnostics.at(-1)?.message ?? "canonical sync failed")),
          );
        }
      };
      subscription = actor.subscribe(observe);
      observe();
    });

  let startPromise: Promise<SyncCheckpointSummary> | undefined;
  let actorStarted = false;
  const start = (): Promise<SyncCheckpointSummary> => {
    startPromise ??= (async () => {
      actor.start();
      actorStarted = true;
      actor.send({
        type: "control.start.requested",
        commandId: `runtime:start:${crypto.randomUUID()}`,
      });
      return waitForReady();
    })();
    return startPromise;
  };

  const waitForShutdown = (): Promise<void> =>
    new Promise((resolve) => {
      let subscription: Readonly<{ unsubscribe: () => void }> | undefined;
      let settled = false;
      const observe = (): void => {
        if (settled) return;
        const snapshot = actor.getSnapshot();
        if (JSON.stringify(snapshot.value).includes("shutdown")) {
          settled = true;
          subscription?.unsubscribe();
          resolve();
        }
      };
      subscription = actor.subscribe(observe);
      observe();
    });

  let closePromise: Promise<void> | undefined;
  const close = (signal = "runtime-close"): Promise<void> => {
    closePromise ??= (async () => {
      let cleanupFailed = false;
      try {
        if (actorStarted) {
          const shutdown = waitForShutdown();
          actor.send({
            type: "process.shutdown.requested",
            requestId: `runtime:shutdown:${crypto.randomUUID()}`,
            signal,
          });
          await shutdown;
          cleanupFailed =
            resourceCleanupFailed ||
            projectSyncStatus(actor.getSnapshot()).diagnostics.some(
              (item) => item.code === "sync.cleanup-release",
            );
        } else {
          const terminals = await Promise.allSettled([stopQueue(), releaseSource()]);
          cleanupFailed = terminals.some((terminal) => terminal.status === "rejected");
        }
      } finally {
        control.close();
        actor.stop();
      }
      if (cleanupFailed) throw new Error("Canonical sync resource cleanup failed.");
    })();
    return closePromise;
  };

  return Object.freeze({ actor, control, start, close, sourceReleaseCount: () => sourceReleases });
}
