import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  createAccountId,
  createLocalLabel,
  createMailboxId,
  createRemoteUid,
  createRemoteUidValue,
  createRoutingRule,
  createRoutingRuleId,
  createUtcInstant,
  createUidValidity,
} from "@agent-mail/core";
import type { MetadataBatchItem, MetadataBatchResult } from "../../imap/src/metadata-batch";
import type { RawMessageDownloadRequest, RawMessageDownloadResult } from "../../imap/src/raw-download";
import type { PromotionRoutingDecision } from "../../storage/src/canonical-promotion";
import type { PromotionStoragePort } from "../../storage/src/promotion-adapter";
import { stageBlob } from "../../storage/src/blob-stage";
import { applyMigrations } from "../../storage/src/migration-runner";
import { openDatabase } from "../../storage/src/database";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../../storage/src/migrations/0002-structured-content";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import { localLabelMigration } from "../../storage/src/local-label-migration";
import { routingDecisionMigration } from "../../storage/src/routing-decision-migration";
import { routingDecisionOriginMigration } from "../../storage/src/routing-decision-origin-migration";
import { messageBlobReferencesMigration } from "../../storage/src/migrations/0003-message-blob-references";
import { placementObservationMigration } from "../../storage/src/migrations/0003-placement-observation";
import {
  createMailboxCheckpointRepository,
  mailboxCheckpointMigration,
} from "../../storage/src/checkpoint-repository";
import {
  createInitialBackfillCompletionRepository,
  initialBackfillCompletionMigration,
} from "../src/initial-backfill-loop";
import type { InitialBackfillSingleMessageIngestion } from "../src/initial-backfill-batch";
import { createSqlitePromotionAdapter } from "../../storage/src/promotion-adapter";
import {
  createBoundSingleMessageIngestionCaller,
  type SingleMessageIngestionDependencies,
} from "../src/single-message-ingestion";
import {
  createRecurringSweepIngestionCaller,
  runRecurringMailboxSweep,
  type RecurringSweepDependencies,
  type RecurringSweepRequest,
} from "../src/recurring-mailbox-sweep";
import { createCanonicalRoutingAdapter } from "../src/routing-caller-adapter";

const accountId = createAccountId("account:routing-parity");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(17);
const observedAt = createUtcInstant("2026-08-18T00:00:00.000Z");
const nextSweepAt = createUtcInstant("2026-08-18T01:00:00.000Z");
const secondSweepAt = createUtcInstant("2026-08-18T02:00:00.000Z");
const roots: string[] = [];

const matchingEml = [
  "From: Ada <ada@example.test>",
  "List-ID: <News.Example.COM>",
  "Subject: parity",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "same facts",
  "",
].join("\r\n");

const divergentEml = matchingEml.replace("<News.Example.COM>", "<other.example.com>");

const rule = createRoutingRule({
  version: 1,
  ruleId: createRoutingRuleId("rule:list-id"),
  ruleVersion: 4,
  predicate: { kind: "exactListId", listId: "<news.example.com>" },
});
const label = createLocalLabel("label:news");

type Fixture = Readonly<{
  readonly db: Database;
  readonly root: string;
  readonly stagingDirectory: string;
  readonly canonicalDirectory: string;
  readonly close: () => Promise<void>;
}>;

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-routing-parity-p4-c14-"));
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  applyMigrations(opened, [
    { ...messageCatalogMigration, version: 1 },
    { ...mailboxCheckpointMigration, version: 2 },
    { ...structuredContentMigration, version: 3 },
    { ...operationalJournalMigration, version: 4 },
    { ...localLabelMigration, version: 5 },
    { ...routingDecisionMigration, version: 6 },
    { ...messageBlobReferencesMigration, version: 7 },
    { ...placementObservationMigration, version: 8 },
    { ...initialBackfillCompletionMigration, version: 9 },
    { ...routingDecisionOriginMigration, version: 10 },
  ]);
  opened.db
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, uidValidity);
  const stagingDirectory = join(root, "staging");
  const canonicalDirectory = join(root, "blobs");
  await mkdir(stagingDirectory, { mode: 0o700 });
  await mkdir(canonicalDirectory, { mode: 0o700 });
  createInitialBackfillCompletionRepository(opened.db).save(
    { accountId, mailboxId, uidValidity },
    {
      observedUidCeiling: null,
      observedUidNext: { kind: "known", value: createRemoteUidValue(1) },
      observedAt,
      nextSweepEligibleAt: observedAt,
    },
  );
  return { ...opened, root, stagingDirectory, canonicalDirectory };
}

function metadataFor(uid: number): MetadataBatchItem {
  return {
    identity: createRemoteUid({ accountId, mailboxId, uidValidity, uid }),
    flags: [],
    modseq: { kind: "unknown" },
    envelope: {
      from: [{ name: "Ada", address: "ada@example.test" }],
      subject: "parity",
    },
    size: Buffer.byteLength(uid === 1 ? matchingEml : divergentEml),
    internalDate: observedAt,
  };
}

function queueFor(fixture: Fixture): SingleMessageIngestionDependencies["queue"] {
  return {
    async download(request: RawMessageDownloadRequest): Promise<RawMessageDownloadResult> {
      const content = request.uid === 1 ? matchingEml : divergentEml;
      const staged = await stageBlob({
        stagingDirectory: fixture.stagingDirectory,
        owner: request.owner,
        source: (async function* () {
          yield new TextEncoder().encode(content);
        })(),
      });
      return { identity: createRemoteUid(request), staged };
    },
  };
}

function ingestionDependencies(
  fixture: Fixture,
  routedSnapshots: Array<Readonly<{ readonly caller: string; readonly routed: readonly PromotionRoutingDecision[] }>>,
  promotion: PromotionStoragePort = createSqlitePromotionAdapter(fixture.db),
): SingleMessageIngestionDependencies {
  const adapter = createCanonicalRoutingAdapter({ rule, label });
  return {
    queue: queueFor(fixture),
    promotion,
    stagingDirectory: fixture.stagingDirectory,
    canonicalDirectory: fixture.canonicalDirectory,
    owner: { pid: process.pid, processStartIdentity: "routing-parity-test" },
    routing: (input) => {
      const routed = adapter(input);
      routedSnapshots.push({ caller: input.caller, routed });
      return routed;
    },
    occurredAt: observedAt,
    journal: ({ messageId }) => ({
      id: `event:ingestion:${messageId}`,
      occurredAt: observedAt,
      category: "sync",
      subjectId: messageId,
      correlationId: "sync:routing-parity",
      payloadVersion: 1,
      payloadJson: '{"status":"promoted"}',
    }),
  };
}

function sweepDependencies(
  fixture: Fixture,
  ingestSingleMessage: InitialBackfillSingleMessageIngestion,
  availableUids: readonly number[],
): RecurringSweepDependencies {
  const metadata = new Map(availableUids.map((uid) => [uid, metadataFor(uid)]));
  const checkpoints = createMailboxCheckpointRepository(fixture.db);
  const completions = createInitialBackfillCompletionRepository(fixture.db);
  return {
    checkpoints,
    completions,
    batch: {
      metadata: {
        async fetch(request): Promise<MetadataBatchResult> {
          const items = request.uids.flatMap((uid) => {
            const item = metadata.get(uid);
            return item === undefined ? [] : [item];
          });
          return { items, missingUids: request.uids.filter((uid) => !metadata.has(uid)) };
        },
      },
      ingestSingleMessage,
      // The accepted promotion transaction already owns the immutable
      // placement receipt. Metadata observation is outside this caller-parity
      // seam and is intentionally inert here.
      persistMetadata: () => {},
      persistMissing: () => {
        throw new Error("unexpected missing UID in routing parity fixture");
      },
    },
    listExistingPlacementUids: (identity, after, limit) =>
      fixture.db
        .query(
          "SELECT uid FROM remote_placements WHERE account_id = ? AND mailbox_id = ? AND uid_validity = ? AND tombstone_observed_at IS NULL AND uid > ? ORDER BY uid LIMIT ?;",
        )
        .all(identity.accountId, identity.mailboxId, identity.uidValidity, after, limit)
        .map((row) => {
          if (typeof row !== "object" || row === null || !("uid" in row) || typeof row.uid !== "number") {
            throw new TypeError("routing parity placement row is malformed");
          }
          return createRemoteUidValue(row.uid);
        }),
    reconcileExistingPlacement: ({ identity, uid, metadata: item, observedAt: seenAt, sourceCheckpoint }) => {
      if (item === undefined) throw new Error(`unexpected missing UID ${uid}`);
    },
    ownsActor: () => true,
  };
}

function request(now: ReturnType<typeof createUtcInstant>, ceiling: number, next: ReturnType<typeof createUtcInstant>): RecurringSweepRequest {
  return {
    identity: { accountId, mailboxId, uidValidity },
    now,
    observedUidCeiling: createRemoteUidValue(ceiling),
    observedUidNext: { kind: "known", value: createRemoteUidValue(ceiling + 1) },
    observedAt: now,
    nextSweepEligibleAt: next,
    maxNewUidBatchUids: 10,
    maxReconciliationUids: 10,
    stagingDirectory: "/tmp/routing-parity-staging",
    owner: { pid: process.pid, processStartIdentity: "routing-parity-test" },
    actor: { id: "routing-parity-actor" },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P4-C14 shared ingestion/sweep routing caller", () => {
  test("uses one parsed-fact evaluator and promotion boundary for direct, sweep, dedup, and List-ID divergence", async () => {
    const fixture = await setup();
    const routedSnapshots: Array<Readonly<{ readonly caller: string; readonly routed: readonly PromotionRoutingDecision[] }>> = [];
    const dependencies = ingestionDependencies(fixture, routedSnapshots);
    const direct = createBoundSingleMessageIngestionCaller(dependencies, "direct-ingestion");
    const directCommit = await direct({
      request: {
        accountId,
        mailboxId,
        uidValidity,
        uid: createRemoteUidValue(1),
        stagingDirectory: fixture.stagingDirectory,
        owner: dependencies.owner,
      },
      metadata: metadataFor(1),
    });
    expect(directCommit.status).toBe("committed");

    const sweepCaller = createRecurringSweepIngestionCaller(dependencies);
    const firstSweep = await runRecurringMailboxSweep(
      request(nextSweepAt, 1, secondSweepAt),
      sweepDependencies(fixture, sweepCaller, [1]),
    );
    expect(firstSweep.status).toBe("completed");
    expect(firstSweep.discoveredUids).toEqual([1]);
    expect(routedSnapshots).toHaveLength(2);
    const directRouting = routedSnapshots[0];
    const sweepRouting = routedSnapshots[1];
    if (directRouting === undefined || sweepRouting === undefined) {
      throw new Error("routing parity fixture did not capture both callers");
    }
    expect(directRouting.caller).toBe("direct-ingestion");
    expect(sweepRouting.caller).toBe("recurring-sweep");
    expect(directRouting.routed[0]?.decision).toEqual(sweepRouting.routed[0]?.decision);
    expect(directRouting.routed[0]?.decisionId).not.toBe(sweepRouting.routed[0]?.decisionId);
    expect(
      fixture.db
        .query(
          "SELECT caller_source, observed_at, evaluation_id FROM routing_decision_origins ORDER BY caller_source;",
        )
        .all(),
    ).toEqual([
      {
        caller_source: "direct-ingestion",
        observed_at: observedAt,
        evaluation_id: expect.stringMatching(/^message:[0-9a-f]{64}:rule:list-id:4$/u),
      },
      {
        caller_source: "recurring-sweep",
        observed_at: observedAt,
        evaluation_id: expect.stringMatching(/^message:[0-9a-f]{64}:rule:list-id:4$/u),
      },
    ]);

    await direct({
      request: {
        accountId,
        mailboxId,
        uidValidity,
        uid: createRemoteUidValue(1),
        stagingDirectory: fixture.stagingDirectory,
        owner: dependencies.owner,
      },
      metadata: metadataFor(1),
    });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM routing_decision_origins;").get()).toEqual({
      count: 2,
    });

    const snapshot = fixture.db
      .query(
        "SELECT decision_id, message_id, rule_id, rule_version, matched_facts_json, provenance_source, provenance_evaluation_id FROM routing_decisions JOIN local_label_assignments USING (message_id, rule_id, rule_version, matched_facts_json) ORDER BY decision_id;",
      )
      .all();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      rule_id: "rule:list-id",
      rule_version: 4,
      matched_facts_json: '[{"field":"list-id","value":"news.example.com"}]',
      provenance_source: "canonical-routing-v1",
    });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({ count: 1 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({ count: 1 });

    const divergentSweep = await runRecurringMailboxSweep(
      request(secondSweepAt, 2, secondSweepAt),
      sweepDependencies(fixture, sweepCaller, [1, 2]),
    );
    expect(divergentSweep.discoveredUids).toEqual([2]);
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({ count: 1 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({ count: 1 });
    await fixture.close();
  });

  test("rolls back canonical decision and origin together when origin persistence fails", async () => {
    const fixture = await setup();
    const failingPromotion = createSqlitePromotionAdapter(fixture.db, {
      beforeWrite: (boundary) => {
        if (boundary === "routing-origin") throw new Error("injected origin failure");
      },
    });
    const dependencies = ingestionDependencies(fixture, [], failingPromotion);
    const direct = createBoundSingleMessageIngestionCaller(dependencies, "direct-ingestion");

    await expect(
      direct({
        request: {
          accountId,
          mailboxId,
          uidValidity,
          uid: createRemoteUidValue(1),
          stagingDirectory: fixture.stagingDirectory,
          owner: dependencies.owner,
        },
        metadata: metadataFor(1),
      }),
    ).rejects.toMatchObject({ code: "promotion-failed" });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM messages;").get()).toEqual({ count: 0 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({ count: 0 });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM routing_decision_origins;").get()).toEqual({
      count: 0,
    });
    await fixture.close();
  });

  test("records the same two origins regardless of which caller arrives first", async () => {
    const fixture = await setup();
    const dependencies = ingestionDependencies(fixture, []);
    const sweep = createRecurringSweepIngestionCaller(dependencies);
    await runRecurringMailboxSweep(
      request(nextSweepAt, 1, secondSweepAt),
      sweepDependencies(fixture, sweep, [1]),
    );
    const direct = createBoundSingleMessageIngestionCaller(dependencies, "direct-ingestion");
    await direct({
      request: {
        accountId,
        mailboxId,
        uidValidity,
        uid: createRemoteUidValue(1),
        stagingDirectory: fixture.stagingDirectory,
        owner: dependencies.owner,
      },
      metadata: metadataFor(1),
    });
    expect(fixture.db.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({ count: 1 });
    expect(
      fixture.db
        .query("SELECT caller_source FROM routing_decision_origins ORDER BY caller_source;")
        .all(),
    ).toEqual([{ caller_source: "direct-ingestion" }, { caller_source: "recurring-sweep" }]);
    await fixture.close();
  });
});
