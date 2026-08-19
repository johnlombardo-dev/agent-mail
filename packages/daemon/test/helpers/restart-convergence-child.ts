import { createHash, randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  createAccountId,
  createLocalLabel,
  createMailboxId,
  createMonotonicSequence,
  createRemoteUid,
  createRemoteUidValue,
  createRouteDecision,
  createRoutingRuleId,
  createUidValidity,
  createUtcInstant,
  type UtcInstant,
} from "@agent-mail/core";
import type {
  MetadataBatchAdapter,
  MetadataBatchItem,
} from "../../../imap/src/metadata-batch";
import type { RawMessageDownloadResult } from "../../../imap/src/raw-download";
import { stageBlob } from "../../../storage/src/blob-stage";
import { cleanupAbandonedBlobStages } from "../../../storage/src/blob-stage-cleanup";
import { runMigrations } from "../../../storage/src/migration-runner";
import { openDatabase, type OpenDatabase } from "../../../storage/src/database";
import { messageCatalogMigration } from "../../../storage/src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../../../storage/src/migrations/0002-structured-content";
import { operationalJournalMigration } from "../../../storage/src/migrations/0001-operational-journal";
import { localLabelMigration } from "../../../storage/src/local-label-migration";
import { routingDecisionMigration } from "../../../storage/src/routing-decision-migration";
import { messageBlobReferencesMigration } from "../../../storage/src/migrations/0003-message-blob-references";
import { placementObservationMigration } from "../../../storage/src/migrations/0003-placement-observation";
import { routingDecisionOriginMigration } from "../../../storage/src/routing-decision-origin-migration";
import {
  createMailboxCheckpointRepository,
  mailboxCheckpointMigration,
} from "../../../storage/src/checkpoint-repository";
import {
  createInitialBackfillCompletionRepository,
  initialBackfillCompletionMigration,
  runInitialBackfillLoop,
} from "../../src/initial-backfill-loop";
import {
  createSqlitePromotionAdapter,
  type PromotionStoragePort,
} from "../../../storage/src/promotion-adapter";
import { observeRemotePlacement } from "../../../storage/src/remote-placement-observation";
import { tombstoneRemotePlacement } from "../../../storage/src/remote-placement-tombstone";
import { resetMailboxEpoch } from "../../../storage/src/epoch-reset";
import {
  runRecurringMailboxSweep,
  type RecurringSweepDependencies,
} from "../../src/recurring-mailbox-sweep";
import {
  ingestSingleMessage,
  type SingleMessageIngestionDependencies,
} from "../../src/single-message-ingestion";
import {
  createSyncControlDecisionChannel,
  createSyncControlService,
  type SyncControlDecision,
} from "../../src/sync-control-service";
import {
  createSyncLifecycleActor,
  createSyncLifecycleDependencies,
  projectSyncStatus,
  type BootstrapOutput,
  type SyncLifecycleSnapshotView,
} from "../../src/sync-statechart";
import { fromCallback, fromPromise } from "xstate";

export const RESTART_CONVERGENCE_PHASES = [
  "download",
  "parse",
  "blob-promotion",
  "storage-transaction",
  "checkpoint-update",
  "epoch-reset",
  "pause",
  "stop",
] as const;

export type RestartConvergencePhase =
  (typeof RESTART_CONVERGENCE_PHASES)[number];
export type ChildMode =
  "oracle" | "resume" | `interrupt:${RestartConvergencePhase}`;

const accountId = createAccountId("account:restart-convergence");
const mailboxId = createMailboxId("mailbox:inbox");
const oldUidValidity = createUidValidity(17);
const newUidValidity = createUidValidity(18);
const observedAt = createUtcInstant("2026-08-18T00:00:00.000Z");
const eligibleAt = createUtcInstant("2026-08-18T01:00:00.000Z");
const sweepObservedAt = createUtcInstant("2026-08-18T02:00:00.000Z");
const resetObservedAt = createUtcInstant("2026-08-18T03:00:00.000Z");
const owner = {
  pid: process.pid,
  processStartIdentity: `restart-convergence-child:${process.pid}:${randomUUID()}`,
} as const;

const migrations = [
  { ...messageCatalogMigration, version: 1 },
  { ...structuredContentMigration, version: 2 },
  { ...operationalJournalMigration, version: 3 },
  { ...localLabelMigration, version: 4 },
  { ...routingDecisionMigration, version: 5 },
  { ...messageBlobReferencesMigration, version: 6 },
  { ...placementObservationMigration, version: 7 },
  { ...routingDecisionOriginMigration, version: 8 },
  { ...mailboxCheckpointMigration, version: 9 },
  { ...initialBackfillCompletionMigration, version: 10 },
] as const;

const rawFor = (uid: number): string =>
  [
    "From: Ada <ada@example.test>",
    "To: Team <team@example.test>",
    `Subject: restart convergence ${uid}`,
    "Content-Type: multipart/mixed; boundary=outer",
    "",
    "--outer",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `body for deterministic UID ${uid}`,
    "--outer",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=note.txt",
    "Content-Transfer-Encoding: base64",
    "",
    "bm90ZSBieXRlcw==",
    "--outer--",
    "",
  ].join("\r\n");

const malformedRaw =
  "Content-Type: multipart/mixed; boundary=missing\r\n\r\n--missing";

type FakeMessage = Readonly<{ readonly uid: number; readonly raw: string }>;

export type ResourceLeakEvidence = Readonly<{
  readonly fakeImapOpenHandles: number;
  readonly activeQueueDownloads: number;
  readonly controlDecisionListeners: number;
  readonly stagingFiles: readonly string[];
}>;

export type DomainSnapshot = Readonly<{
  readonly messages: readonly unknown[];
  readonly placements: readonly unknown[];
  readonly headers: readonly unknown[];
  readonly addresses: readonly unknown[];
  readonly bodyParts: readonly unknown[];
  readonly attachments: readonly unknown[];
  readonly blobs: readonly unknown[];
  readonly blobReferences: readonly unknown[];
  readonly routingDecisions: readonly unknown[];
  readonly routingOrigins: readonly unknown[];
  readonly localRoutingProvenance: readonly unknown[];
  readonly tombstones: readonly unknown[];
  readonly checkpoints: readonly unknown[];
  readonly completions: readonly unknown[];
  readonly journal: readonly unknown[];
}>;

export type ChildResult = Readonly<{
  readonly pid: number;
  readonly mode: ChildMode;
  readonly status: "completed";
  readonly snapshot?: DomainSnapshot;
  readonly resources: ResourceLeakEvidence;
}>;

export type InterruptMarker = Readonly<{
  readonly schemaVersion: 1;
  readonly reached: true;
  readonly phase: RestartConvergencePhase;
  readonly cut: string;
  readonly pid: number;
  readonly durableBefore: Readonly<{
    readonly messageCount: number;
    readonly placementCount: number;
    readonly tombstoneCount: number;
    readonly journalCount: number;
    readonly checkpointVersion: number | null;
    readonly checkpointBackfillCompleted: boolean | null;
    readonly canonicalBlobCount: number;
    readonly stagingFiles: readonly string[];
  }>;
  readonly control?: Readonly<{
    readonly command: "pause" | "stop";
    readonly observed: true;
    readonly actorState: string;
    readonly version: number;
    readonly configurationDigest: string;
    readonly actorListenerCount: number;
    readonly decisionListenerCount: number;
  }>;
}>;

class FakeImap {
  private readonly messages = new Map<number, FakeMessage>(
    [1, 2].map((uid) => [uid, { uid, raw: rawFor(uid) }]),
  );
  private openHandles = 1;

  metadata: MetadataBatchAdapter = {
    fetch: async ({ uids }) => ({
      items: uids
        .map((uid) => this.messages.get(uid))
        .filter((message): message is FakeMessage => message !== undefined)
        .map((message) => metadataFor(message.uid)),
      missingUids: uids.filter((uid) => !this.messages.has(uid)),
    }),
  };

  remove(uid: number): void {
    this.messages.delete(uid);
  }

  raw(uid: number, malformed: boolean): string {
    const message = this.messages.get(uid);
    if (message === undefined)
      throw new Error(`fake IMAP message ${uid} is missing`);
    return malformed ? malformedRaw : message.raw;
  }

  close(): void {
    this.openHandles = 0;
  }

  resources(): number {
    return this.openHandles;
  }
}

function metadataFor(uid: number): MetadataBatchItem {
  return {
    identity: createRemoteUid({
      accountId,
      mailboxId,
      uidValidity: oldUidValidity,
      uid,
    }),
    flags: uid === 1 ? ["\\Seen"] : ["\\Flagged"],
    modseq: { kind: "known", value: createMonotonicSequence(uid) },
    envelope: { subject: `restart convergence ${uid}` },
    size: Buffer.byteLength(rawFor(uid)),
    internalDate: createUtcInstant(`2026-08-18T00:00:0${uid}.000Z`),
  };
}

function journalFor(uid: number) {
  return ({ messageId }: { readonly messageId: string }) => ({
    id: `event:ingestion:restart-convergence:${uid}`,
    occurredAt: observedAt,
    category: "sync" as const,
    subjectId: messageId,
    correlationId: `sync:restart-convergence:${uid}`,
    payloadVersion: 1,
    payloadJson: JSON.stringify({ kind: "ingestion", uid, version: 1 }),
  });
}

function routingFor(uid: number) {
  return [
    {
      decisionId: `caller:restart-convergence:${uid}`,
      decision: createRouteDecision({
        kind: "route",
        ruleId: createRoutingRuleId("rule:restart-convergence"),
        ruleVersion: 1,
        matchedFacts: [
          { field: "sender", value: "ada@example.test" },
          { field: "uid", value: String(uid) },
        ],
        decidedAt: observedAt,
        provenance: {
          source: "restart-convergence",
          evaluationId: `evaluation:${uid}`,
        },
        label: createLocalLabel("label:restart-convergence"),
      }),
      origins: [
        {
          callerSource: "direct-ingestion" as const,
          observedAt,
          evaluationId: `evaluation:${uid}`,
        },
      ],
    },
  ];
}

function databaseMigrations(opened: OpenDatabase): void {
  runMigrations(opened, migrations);
  opened.db
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, oldUidValidity);
}

async function ensureRoot(root: string): Promise<{
  readonly databasePath: string;
  readonly staging: string;
  readonly blobs: string;
}> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = join(root, "staging");
  const blobs = join(root, "blobs");
  await mkdir(staging, { mode: 0o700, recursive: true });
  await mkdir(blobs, { mode: 0o700, recursive: true });
  return { databasePath: join(root, "archive.sqlite"), staging, blobs };
}

async function openFixture(root: string): Promise<{
  readonly opened: OpenDatabase;
  readonly staging: string;
  readonly blobs: string;
}> {
  const paths = await ensureRoot(root);
  let exists = true;
  try {
    await stat(paths.databasePath);
  } catch {
    exists = false;
  }
  const opened = await openDatabase(paths.databasePath);
  if (!exists) databaseMigrations(opened);
  return { opened, staging: paths.staging, blobs: paths.blobs };
}

function durableBefore(
  database: Database,
  staging: string,
  blobs: string,
): InterruptMarker["durableBefore"] {
  const checkpoint = database
    .query(
      "SELECT observed_version, backfill_completed FROM mailbox_checkpoints " +
        "WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ?;",
    )
    .get(accountId, mailboxId, oldUidValidity) as {
    readonly observed_version: number;
    readonly backfill_completed: number;
  } | null;
  const count = (table: string): number =>
    Number(
      (
        database.query(`SELECT COUNT(*) AS count FROM ${table};`).get() as {
          readonly count: number;
        }
      ).count,
    );
  return {
    messageCount: count("messages"),
    placementCount: count("remote_placements"),
    tombstoneCount: Number(
      (
        database
          .query(
            "SELECT COUNT(*) AS count FROM remote_placements WHERE tombstone_observed_at IS NOT NULL;",
          )
          .get() as { readonly count: number }
      ).count,
    ),
    journalCount: count("operational_journal"),
    checkpointVersion: checkpoint?.observed_version ?? null,
    checkpointBackfillCompleted:
      checkpoint === null ? null : checkpoint.backfill_completed === 1,
    canonicalBlobCount: readdirSync(blobs).length,
    stagingFiles: readdirSync(staging).sort(),
  };
}

function abruptInterrupt(
  root: string,
  phase: RestartConvergencePhase,
  database: Database,
  staging: string,
  blobs: string,
  extra: Readonly<{
    readonly cut: string;
    readonly control?: InterruptMarker["control"];
  }>,
): never {
  const marker: InterruptMarker = {
    schemaVersion: 1,
    reached: true,
    phase,
    cut: extra.cut,
    pid: process.pid,
    durableBefore: durableBefore(database, staging, blobs),
    ...(extra.control === undefined ? {} : { control: extra.control }),
  };
  writeFileSync(join(root, "interrupt-marker.json"), JSON.stringify(marker), {
    encoding: "utf8",
    mode: 0o600,
  });
  process.exit(75);
  throw new Error("unreachable interrupt continuation");
}

async function cleanupPriorStages(staging: string): Promise<void> {
  await cleanupAbandonedBlobStages({
    stagingDirectory: staging,
    inspectProcess: (pid) =>
      pid === owner.pid
        ? { kind: "live", processStartIdentity: owner.processStartIdentity }
        : { kind: "not-live" },
  });
}

function checkpointStart(database: Database): number {
  const checkpoint = createMailboxCheckpointRepository(database).read({
    accountId,
    mailboxId,
    uidValidity: oldUidValidity,
  });
  if (checkpoint === undefined)
    throw new Error("restart convergence checkpoint is missing");
  return checkpoint.uidNext.kind === "known" ? checkpoint.uidNext.value : 1;
}

function ingestionDependencies(
  root: string,
  database: Database,
  fake: FakeImap,
  staging: string,
  blobs: string,
  mode: ChildMode,
  activeQueueDownloads: { value: number },
): SingleMessageIngestionDependencies {
  return {
    queue: {
      download: async (request): Promise<RawMessageDownloadResult> => {
        if (mode === "interrupt:download") {
          abruptInterrupt(root, "download", database, staging, blobs, {
            cut: "download-queue-before-fetch",
          });
        }
        activeQueueDownloads.value += 1;
        try {
          const source = fake.raw(request.uid, mode === "interrupt:parse");
          const staged = await stageBlob({
            stagingDirectory: staging,
            owner,
            source: (async function* () {
              yield new TextEncoder().encode(source);
            })(),
          });
          return {
            identity: createRemoteUid(request),
            staged:
              mode === "interrupt:parse"
                ? { ...staged, path: `${staged.path}.missing` }
                : staged,
          };
        } finally {
          activeQueueDownloads.value -= 1;
        }
      },
    },
    promotion: (() => {
      const delegate = createSqlitePromotionAdapter(database, {
        beforeWrite: (boundary) => {
          if (
            mode === "interrupt:storage-transaction" &&
            boundary === "routing-decision"
          )
            abruptInterrupt(
              root,
              "storage-transaction",
              database,
              staging,
              blobs,
              {
                cut: "storage-transaction-before-routing-write",
              },
            );
        },
      });
      if (mode !== "interrupt:blob-promotion") return delegate;
      const promotion: PromotionStoragePort = {
        promote: () =>
          abruptInterrupt(root, "blob-promotion", database, staging, blobs, {
            cut: "blob-publication-before-promotion-storage",
          }),
      };
      return promotion;
    })(),
    stagingDirectory: staging,
    canonicalDirectory: blobs,
    owner,
    routing: ({ download }) => routingFor(download.identity.uid),
    occurredAt: observedAt,
    journal: ({ messageId, downloaded }) =>
      journalFor(downloaded.identity.uid)({ messageId }),
  };
}

async function completeInitialBackfill(
  root: string,
  database: Database,
  fake: FakeImap,
  staging: string,
  blobs: string,
  mode: ChildMode,
  activeQueueDownloads: { value: number },
): Promise<void> {
  const checkpoints = createMailboxCheckpointRepository(database);
  const completions = createInitialBackfillCompletionRepository(database, {
    beforeCompletionWrite: () => {
      if (mode === "interrupt:checkpoint-update")
        abruptInterrupt(root, "checkpoint-update", database, staging, blobs, {
          cut: "checkpoint-update-before-completion-write",

        });
    },
  });
  if (
    checkpoints.read({ accountId, mailboxId, uidValidity: oldUidValidity })
      ?.backfillCompleted === true
  ) {
    return;
  }
  const batch = {
    metadata: fake.metadata,
    ingestSingleMessage: async (
      input: Parameters<typeof ingestSingleMessage>[0],
    ) =>
      ingestSingleMessage(
        input,
        ingestionDependencies(
          root,
          database,
          fake,
          staging,
          blobs,
          mode,
          activeQueueDownloads,
        ),
      ),
    persistMetadata: (
      item: MetadataBatchItem,
      context: {
        readonly observationOrder: number;
        readonly sourceCheckpoint: string;
        readonly observedAt: UtcInstant;
      },
    ) =>
      observeRemotePlacement(database, {
        accountId,
        mailboxId,
        uidValidity: oldUidValidity,
        uid: item.identity.uid,
        internalDate: item.internalDate,
        flags: item.flags,
        modseq: item.modseq,
        observationOrder: context.observationOrder,
        observedAt: context.observedAt,
        sourceCheckpoint: context.sourceCheckpoint,
      }),
    persistMissing: () => {
      throw new Error(
        "restart convergence fixture unexpectedly observed a missing initial UID",
      );
    },
  };
  let result: Awaited<ReturnType<typeof runInitialBackfillLoop>>;
  try {
    result = await runInitialBackfillLoop(
      {
        accountId,
        mailboxId,
        uidValidity: oldUidValidity,
        observedUidCeiling: createRemoteUidValue(2),
        observedUidNext: { kind: "known", value: createRemoteUidValue(3) },
        observedAt,
        nextSweepEligibleAt: eligibleAt,
        maxBatchUids: 2,
        stagingDirectory: staging,
        owner,
      },
      { checkpoints, completions, batch },
    );
  } catch (error: unknown) {
    if (mode === "interrupt:parse")
      abruptInterrupt(root, "parse", database, staging, blobs, {
        cut: "parse-after-stage-before-parse-success",
      });
    throw error;
  }
  if (result.status !== "completed" && result.status !== "already-complete") {
    throw new Error(`initial backfill did not complete: ${result.status}`);
  }
}
async function runSweepAndReset(
  root: string,
  database: Database,
  fake: FakeImap,
  staging: string,
  blobs: string,
  mode: ChildMode,
  activeQueueDownloads: { value: number },
): Promise<void> {
  fake.remove(2);
  const checkpoints = createMailboxCheckpointRepository(database);
  const completions = createInitialBackfillCompletionRepository(database);
  const batch: RecurringSweepDependencies["batch"] = {
    metadata: fake.metadata,
    ingestSingleMessage: async (input) =>
      ingestSingleMessage(
        input,
        ingestionDependencies(
          root,
          database,
          fake,
          staging,
          blobs,
          mode,
          activeQueueDownloads,
        ),
      ),
    persistMetadata: (item, context) =>
      observeRemotePlacement(database, {
        accountId,
        mailboxId,
        uidValidity: oldUidValidity,
        uid: item.identity.uid,
        internalDate: item.internalDate,
        flags: item.flags,
        modseq: item.modseq,
        observationOrder: context.observationOrder,
        observedAt: context.observedAt,
        sourceCheckpoint: context.sourceCheckpoint,
      }),
    persistMissing: () => {
      throw new Error(
        "restart convergence sweep unexpectedly observed a missing new UID",
      );
    },
  };
  const alreadySwept =
    database
      .query(
        "SELECT 1 AS present FROM remote_placements WHERE account_id = ? AND mailbox_id = ? " +
          "AND uid_validity = ? AND uid = 2 AND tombstone_observed_at IS NOT NULL;",
      )
      .get(accountId, mailboxId, oldUidValidity) !== null;
  if (!alreadySwept) {
    await runRecurringMailboxSweep(
      {
        identity: { accountId, mailboxId, uidValidity: oldUidValidity },
        now: eligibleAt,
        observedUidCeiling: createRemoteUidValue(2),
        observedUidNext: { kind: "known", value: createRemoteUidValue(3) },
        observedAt: sweepObservedAt,
        nextSweepEligibleAt: resetObservedAt,
        maxNewUidBatchUids: 2,
        maxReconciliationUids: 2,
        stagingDirectory: staging,
        owner,
        actor: { id: "restart-convergence-actor" },
      },
      {
        checkpoints,
        completions,
        batch,
        listExistingPlacementUids: (identity, after, limit) =>
          database
            .query(
              "SELECT uid FROM remote_placements WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? " +
                "AND tombstone_observed_at IS NULL AND uid > ? ORDER BY uid LIMIT ?;",
            )
            .all(
              identity.accountId,
              identity.mailboxId,
              identity.uidValidity,
              after,
              limit,
            )
            .map((row) =>
              createRemoteUidValue((row as { readonly uid: number }).uid),
            ),
        reconcileExistingPlacement: ({
          identity,
          uid,
          metadata,
          observedAt: at,
          sourceCheckpoint,
        }) => {
          if (metadata === undefined) {
            tombstoneRemotePlacement(database, {
              accountId: identity.accountId,
              mailboxId: identity.mailboxId,
              uidValidity: identity.uidValidity,
              uid,
              observedAt: at,
              sourceCheckpoint,
              reason: "confirmed-absence; restart-convergence-fixture",
            });
            return;
          }
          observeRemotePlacement(database, {
            accountId: identity.accountId,
            mailboxId: identity.mailboxId,
            uid,
            uidValidity: identity.uidValidity,
            internalDate: metadata.internalDate,
            flags: metadata.flags,
            modseq: metadata.modseq,
            observationOrder: 100 + uid,
            observedAt: at,
            sourceCheckpoint,
          });
        },
        ownsActor: () => true,
      },
    );
  }
  resetMailboxEpoch(
    database,
    {
      accountId,
      mailboxId,
      oldUidValidity,
      newUidValidity,
      observedAt: resetObservedAt,
      sourceCheckpoint: "checkpoint:restart-convergence-before-epoch-reset",
    },
    mode === "interrupt:epoch-reset"
      ? {
          beforeJournalWrite: (kind) => {
            if (kind === "epoch-reset")
              abruptInterrupt(root, "epoch-reset", database, staging, blobs, {
                cut: "epoch-reset-before-journal-write",
              });
          },
        }
      : {},
  );
}

function snapshotRows(database: Database, sql: string): readonly unknown[] {
  return database.query(sql).all();
}

async function blobSnapshot(blobs: string): Promise<readonly unknown[]> {
  const entries = (await readdir(blobs)).sort();
  return Promise.all(
    entries.map(async (name) => {
      const bytes = await readFile(join(blobs, name));
      return {
        name,
        size: bytes.byteLength,
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
}

export async function readDomainSnapshot(
  database: Database,
  blobs: string,
): Promise<DomainSnapshot> {
  return {
    messages: snapshotRows(
      database,
      "SELECT message_id FROM messages ORDER BY message_id;",
    ),
    placements: snapshotRows(
      database,
      "SELECT * FROM remote_placements ORDER BY account_id, mailbox_id, uid_validity, uid;",
    ),
    headers: snapshotRows(
      database,
      "SELECT * FROM message_headers ORDER BY message_id, ordinal;",
    ),
    addresses: snapshotRows(
      database,
      "SELECT * FROM message_addresses ORDER BY message_id, ordinal;",
    ),
    bodyParts: snapshotRows(
      database,
      "SELECT * FROM message_body_parts ORDER BY message_id, ordinal;",
    ),
    attachments: snapshotRows(
      database,
      "SELECT * FROM message_attachments ORDER BY message_id, ordinal;",
    ),
    blobs: await blobSnapshot(blobs),
    blobReferences: snapshotRows(
      database,
      "SELECT * FROM message_blob_references ORDER BY message_id, kind, ordinal;",
    ),
    routingDecisions: snapshotRows(
      database,
      "SELECT * FROM routing_decisions ORDER BY decision_id;",
    ),
    routingOrigins: snapshotRows(
      database,
      "SELECT * FROM routing_decision_origins ORDER BY decision_id, caller_source;",
    ),
    localRoutingProvenance: snapshotRows(
      database,
      "SELECT * FROM local_label_assignments ORDER BY message_id, label, rule_id, rule_version;",
    ),
    tombstones: snapshotRows(
      database,
      "SELECT account_id, mailbox_id, uid_validity, uid, message_id, tombstone_observed_at, tombstone_reason FROM remote_placements WHERE tombstone_observed_at IS NOT NULL ORDER BY account_id, mailbox_id, uid_validity, uid;",
    ),
    checkpoints: snapshotRows(
      database,
      "SELECT * FROM mailbox_checkpoints ORDER BY account_id, mailbox_id, uid_validity;",
    ),
    completions: snapshotRows(
      database,
      "SELECT * FROM initial_backfill_completions ORDER BY account_id, mailbox_id, uid_validity;",
    ),
    journal: snapshotRows(
      database,
      "SELECT rowid AS journal_order, id, occurred_at, category, subject_id, correlation_id, payload_version, payload_json FROM operational_journal ORDER BY rowid;",
    ),
  };
}

export function snapshotDigest(snapshot: DomainSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function controlSnapshot(
  state: string,
  version: number,
): SyncLifecycleSnapshotView {
  return {
    value: state,
    context: {
      incarnationId: "incarnation:restart-convergence",
      version,
      scopeEpoch: 0,
      idleReadyEpoch: null,
      retryAttempt: 0,
      checkpoint: {
        completedMailboxes: 0,
        totalMailboxes: 1,
        completedMessages: 2,
        pendingMessages: 0,
        lastMailbox: mailboxId,
        lastUid: 2,
      },
      authBlockedDetail: null,
      diagnostics: [],
      latestCredentialRevision: 0,
      activeCredentialRevision: null,
      authFaultCredentialRevision: null,
      cleanupEpoch: 0,
      cleanupPhase: 0,
      cleanupInvokeLease: 0,
      effectiveCleanupScope: null,
    },
  };
}

async function runControlBoundary(
  root: string,
  command: "pause" | "stop",
  database: Database,
  staging: string,
  blobs: string,
  activeQueueDownloads: { value: number },
): Promise<never> {
  const configuration = {
    retryBaseMs: 1,
    retryCapMs: 1,
    retryJitterRatio: 0,
    maxRetryAttempts: 1,
    periodicStatusIntervalMs: 1,
    controlDeadlineMs: 250,
    controlResultRetentionMs: 250,
    maxControlIdempotencyEntries: 8,
    maxReleaseSlotEntries: 8,
  } as const;
  const initial = controlSnapshot("stopped", 0);
  const decisions = createSyncControlDecisionChannel();
  const actorInput = {
    configuration,
    initialCheckpoint: initial.context.checkpoint,
    initialCredentialRevision: 0,
    incarnationId: "incarnation:restart-convergence-real-control",
  } as const;
  const dependencies = createSyncLifecycleDependencies(actorInput);
  const actor = createSyncLifecycleActor(
    actorInput,
    {
      bootstrapSession: fromPromise<BootstrapOutput, unknown>(async () => ({
        next: "idle",
        checkpoint: initial.context.checkpoint,
      })),
      idleSession: fromCallback(() => undefined),
    },
    { ...dependencies, controlDecisionSink: decisions.publish },
  );
  actor.start();
  actor.send({
    type: "control.start.requested",
    commandId: "restart-convergence:real-start",
  });
  const deadline = Date.now() + 250;
  while (
    Date.now() < deadline &&
    projectSyncStatus(actor.getSnapshot()).actorState !== "watching"
  )
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  if (projectSyncStatus(actor.getSnapshot()).actorState !== "watching")
    throw new Error(
      `real sync lifecycle actor did not reach watching: ${String(actor.getSnapshot().value)} (${projectSyncStatus(actor.getSnapshot()).actorState})`,
    );
  let actorListenerCount = 0;
  let decisionListenerCount = 0;
  const actorView = {
    getSnapshot: () => actor.getSnapshot(),
    subscribe: (listener: (snapshot: SyncLifecycleSnapshotView) => void) => {
      actorListenerCount += 1;
      const subscription = actor.subscribe(listener);
      return {
        unsubscribe: () => {
          subscription.unsubscribe();
          actorListenerCount -= 1;
        },
      };
    },
    send: (event: Parameters<typeof actor.send>[0]) => actor.send(event),
  };
  const decisionSource = {
    subscribe: (listener: (decision: SyncControlDecision) => void) => {
      decisionListenerCount += 1;
      const subscription = decisions.source.subscribe(listener);
      return {
        unsubscribe: () => {
          subscription.unsubscribe();
          decisionListenerCount -= 1;
        },
      };
    },
  };
  const service = createSyncControlService({
    actor: actorView,
    decisions: decisionSource,
    controlDeadlineMs: configuration.controlDeadlineMs,
    controlResultRetentionMs: configuration.controlResultRetentionMs,
    maxControlIdempotencyEntries: 4,
  });
  const result = await service.execute({
    command,
    commandId: `restart-convergence:${command}`,
    correlationId: `restart-convergence:${command}`,
    idempotencyKey: `restart-convergence:${command}`,
  });
  if (
    !("accepted" in result) ||
    result.accepted !== true ||
    !("completed" in result) ||
    result.completed !== true
  ) {
    throw new Error(`control ${command} was not observed as completed`);
  }
  if (actorListenerCount !== 0 || decisionListenerCount !== 0)
    throw new Error(
      `control ${command} left subscriptions after settlement: actor=${actorListenerCount} decision=${decisionListenerCount}`,
    );
  const observed = result.observed;
  abruptInterrupt(root, command, database, staging, blobs, {
    cut: `real-control-${command}-accepted`,
    control: {
      command,
      observed: true,
      actorState: observed.actorState,
      version: observed.version,
      configurationDigest: createHash("sha256")
        .update(JSON.stringify(configuration))
        .digest("hex"),
      actorListenerCount,
      decisionListenerCount,
    },
  });
}

export async function runChild(
  root: string,
  mode: "oracle" | "resume",
): Promise<ChildResult> {
  const fixture = await openFixture(root);
  const fake = new FakeImap();
  const activeQueueDownloads = { value: 0 };
  let snapshot: DomainSnapshot;
  try {
    if (mode === "resume") await cleanupPriorStages(fixture.staging);
    await completeInitialBackfill(
      root,
      fixture.opened.db,
      fake,
      fixture.staging,
      fixture.blobs,
      mode,
      activeQueueDownloads,
    );
    await runSweepAndReset(
      root,
      fixture.opened.db,
      fake,
      fixture.staging,
      fixture.blobs,
      mode,
      activeQueueDownloads,
    );
    snapshot = await readDomainSnapshot(fixture.opened.db, fixture.blobs);
  } finally {
    fake.close();
    await fixture.opened.close();
  }
  return {
    pid: process.pid,
    mode,
    status: "completed",
    snapshot,
    resources: {
      fakeImapOpenHandles: fake.resources(),
      activeQueueDownloads: activeQueueDownloads.value,
      controlDecisionListeners: 0,
      stagingFiles: await readdir(fixture.staging),
    },
  };
}

async function runInterruptedChild(
  root: string,
  phase: RestartConvergencePhase,
): Promise<never> {
  const fixture = await openFixture(root);
  const fake = new FakeImap();
  const activeQueueDownloads = { value: 0 };
  if (phase === "pause" || phase === "stop") {
    await completeInitialBackfill(
      root,
      fixture.opened.db,
      fake,
      fixture.staging,
      fixture.blobs,
      `interrupt:${phase}`,
      activeQueueDownloads,
    );
    return runControlBoundary(
      root,
      phase,
      fixture.opened.db,
      fixture.staging,
      fixture.blobs,
      activeQueueDownloads,
    );
  }
  await completeInitialBackfill(
    root,
    fixture.opened.db,
    fake,
    fixture.staging,
    fixture.blobs,
    `interrupt:${phase}`,
    activeQueueDownloads,
  );
  await runSweepAndReset(
    root,
    fixture.opened.db,
    fake,
    fixture.staging,
    fixture.blobs,
    `interrupt:${phase}`,
    activeQueueDownloads,
  );
  return abruptInterrupt(
    root,
    phase,
    fixture.opened.db,
    fixture.staging,
    fixture.blobs,
    {
      cut: `${phase}-boundary-not-reached`,
    },
  );
}

async function main(): Promise<void> {
  const [root, mode] = process.argv.slice(2);
  if (root === undefined || mode === undefined)
    throw new TypeError("restart convergence child arguments are incomplete");
  if (mode.startsWith("interrupt:")) {
    const phase = mode.slice("interrupt:".length) as RestartConvergencePhase;
    await runInterruptedChild(root, phase);
    return;
  }
  const result = await runChild(root, mode as "oracle" | "resume");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) await main();
