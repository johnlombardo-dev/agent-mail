import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createBlobId,
  createLocalLabel,
  createMailboxId,
  createMessageId,
  createRouteDecision,
  createRoutingRuleId,
  createUtcInstant,
  type MessageId,
} from "@agent-mail/core";
import {
  runAdapterContract,
  runAdapterContractParity,
  type AdapterContractSuite,
  type AdapterFactoryInput,
} from "../../../tests/adapter-contracts/harness";
import { runMigrations, type Migration } from "../src/migration-runner";
import { openDatabase, type OpenDatabase } from "../src/database";
import { localLabelMigration } from "../src/local-label-migration";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { messageBlobReferencesMigration } from "../src/migrations/0003-message-blob-references";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import {
  createSqlitePromotionAdapter,
  parsePromotionUnit,
  PromotionAdapterError,
  type PromotionCommit,
  type PromotionStoragePort,
} from "../src/promotion-adapter";
import { routingDecisionMigration } from "../src/routing-decision-migration";
import { canonicalRoutingDecisionId } from "../src/routing-decision-identity";

const roots: string[] = [];
const accountId = createAccountId("account:promotion-contract");
const mailboxId = createMailboxId("mailbox:inbox");
const plainBlob = createBlobId("1".repeat(64));
const attachmentBlob = createBlobId("2".repeat(64));
const rawBlob = createBlobId("3".repeat(64));

const routingDecision = createRouteDecision({
  kind: "route",
  ruleId: createRoutingRuleId("rule:promotion-contract"),
  ruleVersion: 1,
  matchedFacts: [{ field: "sender", value: "ada@example.test" }],
  decidedAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
  provenance: { source: "contract-fixture", evaluationId: "evaluation:promotion" },
  label: createLocalLabel("label:important"),
});

const migrations = [
  { ...messageCatalogMigration, version: 1 },
  { ...structuredContentMigration, version: 2 },
  { ...operationalJournalMigration, version: 3 },
  { ...localLabelMigration, version: 4 },
  { ...routingDecisionMigration, version: 5 },
  { ...messageBlobReferencesMigration, version: 6 },
  { ...placementObservationMigration, version: 7 },
] satisfies readonly Migration[];

function fixture(messageId: MessageId, duplicatePlacement = false, uid = 11) {
  const placement = {
    accountId,
    mailboxId,
    uidValidity: 7,
    uid,
    internalDate: createUtcInstant("2026-08-18T00:00:00.000Z"),
  };
  return {
    messageId,
    normalizedText: "Promoted normalized text",
    rawSource: { blobId: rawBlob, size: 512 },
    placements: duplicatePlacement ? [placement, placement] : [placement],
    headers: [
      {
        ordinal: 1,
        name: "Subject",
        normalizedName: "subject",
        value: "Atomic promotion",
        normalizedValue: "atomic promotion",
      },
    ],
    addresses: [
      {
        ordinal: 1,
        role: "from",
        position: 1,
        address: "Ada <ada@example.test>",
        normalizedAddress: "ada@example.test",
        displayName: "Ada",
        groupName: null,
      },
    ],
    bodyParts: [
      {
        ordinal: 1,
        contentType: "text/plain",
        normalizedContentType: "text/plain",
        size: 18,
        blobId: plainBlob,
      },
    ],
    attachments: [
      {
        ordinal: 1,
        filename: "note.txt",
        contentType: "text/plain",
        normalizedContentType: "text/plain",
        disposition: "attachment",
        contentId: null,
        size: 12,
        blobId: attachmentBlob,
      },
    ],
    routingDecisions: [{ decisionId: `decision:${messageId}`, decision: routingDecision }],
    journal: {
      id: `event:promotion:${messageId}`,
      occurredAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
      category: "sync",
      subjectId: messageId,
      correlationId: `sync:${messageId}`,
      payloadVersion: 1,
      payloadJson: '{"status":"promoted"}',
    },
  };
}

type ContractAdapter = PromotionStoragePort & { readonly armFailure: () => void };

function createMemoryAdapter(): ContractAdapter {
  const committed = new Map<MessageId, string>();
  let failAtRouting = false;
  return {
    armFailure: () => {
      failAtRouting = true;
    },
    promote(input: unknown): PromotionCommit {
      let unit;
      try {
        unit = parsePromotionUnit(input);
      } catch (error: unknown) {
        throw new PromotionAdapterError("invalid-input", "promotion input is invalid", { cause: error });
      }
      const serialized = JSON.stringify(unit);
      const existing = committed.get(unit.messageId);
      if (existing !== undefined) {
        if (existing !== serialized) {
          throw new PromotionAdapterError(
            "conflicting-identity",
            "canonical message identity already has different promotion content",
          );
        }
        return commit(unit, "duplicate");
      }
      const duplicate = new Set(
        unit.placements.map((placement) =>
          [placement.accountId, placement.mailboxId, placement.uidValidity, placement.uid].join("\u0000"),
        ),
      );
      if (duplicate.size !== unit.placements.length) {
        throw new PromotionAdapterError("constraint", "canonical promotion violates a storage constraint");
      }
      if (failAtRouting) {
        failAtRouting = false;
        throw new PromotionAdapterError("storage", "canonical promotion storage failed");
      }
      committed.set(unit.messageId, serialized);
      return commit(unit, "committed");
    },
  };
}

function commit(unit: ReturnType<typeof parsePromotionUnit>, status: PromotionCommit["status"]): PromotionCommit {
  return {
    messageId: unit.messageId,
    placementIds: unit.placements.map((placement) => ({
      accountId: placement.accountId,
      mailboxId: placement.mailboxId,
      uidValidity: placement.uidValidity,
      uid: placement.uid,
    })),
    routingDecisionIds: unit.routingDecisions.map((routing) =>
      canonicalRoutingDecisionId(unit.messageId, routing.decision),
    ),
    journalId: unit.journal.id,
    status,
  };
}

async function createSqliteFixture(): Promise<{ readonly opened: OpenDatabase; readonly adapter: ContractAdapter }> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-promotion-adapter-p2-c20-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  runMigrations(opened, migrations);
  opened.db
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, 7);
  let armed = false;
  const adapter = createSqlitePromotionAdapter(opened.db, {
    beforeWrite: (boundary) => {
      if (armed && boundary === "routing-decision") {
        armed = false;
        throw new Error("injected routing write failure");
      }
    },
  });
  return {
    opened,
    adapter: {
      promote: adapter.promote,
      armFailure: () => {
        armed = true;
      },
    },
  };
}

const contractSuite: AdapterContractSuite<ContractAdapter> = {
  name: "canonical promotion storage adapter",
  cases: [
    {
      id: "canonical-success-returns-committed-identities",
      productionRequired: true,
      run: (adapter) => {
        const messageId = createMessageId("message:1".padEnd(72, "a"));
        expect(adapter.promote(fixture(messageId))).toEqual({
          messageId,
          placementIds: [{ accountId, mailboxId, uidValidity: 7, uid: 11 }],
          routingDecisionIds: [canonicalRoutingDecisionId(messageId, routingDecision)],
          journalId: `event:promotion:${messageId}`,
          status: "committed",
        });
      },
    },
    {
      id: "duplicate-returns-committed-identities",
      productionRequired: true,
      run: (adapter) => {
        const messageId = createMessageId("message:2".padEnd(72, "a"));
        const unit = fixture(messageId, false, 12);
        expect(adapter.promote(unit).status).toBe("committed");
        expect(adapter.promote(unit).status).toBe("duplicate");
      },
    },
    {
      id: "constraint-failure-is-typed-and-atomic",
      productionRequired: true,
      run: (adapter) => {
        const messageId = createMessageId("message:3".padEnd(72, "a"));
        expect(() => adapter.promote(fixture(messageId, true, 13))).toThrow(
          expect.objectContaining({ code: "constraint" }),
        );
        expect(adapter.promote(fixture(messageId, false, 13)).status).toBe("committed");
      },
    },
    {
      id: "injected-failure-does-not-leak-message-state",
      productionRequired: true,
      run: (adapter) => {
        const messageId = createMessageId("message:4".padEnd(72, "a"));
        adapter.armFailure();
        expect(() => adapter.promote(fixture(messageId, false, 14))).toThrow(
          expect.objectContaining({ code: "storage" }),
        );
        expect(adapter.promote(fixture(messageId, false, 14)).status).toBe("committed");
      },
    },
  ],
};

function productionFactory(
  adapter: ContractAdapter,
): Omit<AdapterFactoryInput<ContractAdapter>, "kind"> {
  return {
    factory: () => adapter,
    capabilities: [{ name: "sqlite-transaction", status: "available" }],
    retainedEvidencePath: "evidence/adapter-contracts/promotion-sqlite.jsonl",
  };
}

describe("promotion storage adapter contract P2-C20", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("runs the same success, duplicate, constraint, and failure contract against fake and real adapters", async () => {
    const sqlite = await createSqliteFixture();
    const evidence = await runAdapterContractParity({
      suite: contractSuite,
      fake: {
        factory: createMemoryAdapter,
        capabilities: [{ name: "sqlite-transaction", status: "available" }],
        retainedEvidencePath: "evidence/adapter-contracts/promotion-fake.jsonl",
      },
      production: productionFactory(sqlite.adapter),
    });
    expect(evidence.fake.status).toBe("incomplete");
    expect(evidence.production?.status).toBe("passed");
    expect(evidence.semanticParity).toEqual({
      status: "matched",
      comparedCases: contractSuite.cases.map((contractCase) => contractCase.id),
      differences: [],
    });
    await sqlite.opened.close();
  });

  test("the shared contract rejects a fake that commits message state before routing", async () => {
    const evidence = await runAdapterContract({
      suite: {
        name: "atomicity counterexample",
        cases: [contractSuite.cases[3]],
      },
      factory: () => {
        const committed = new Set<MessageId>();
        let failNext = false;
        return {
          armFailure: () => {
            failNext = true;
          },
          promote: (input: unknown) => {
            const unit = parsePromotionUnit(input);
            if (failNext) {
              failNext = false;
              committed.add(unit.messageId);
              throw new PromotionAdapterError("storage", "routing write failed after message commit");
            }
            if (committed.has(unit.messageId)) {
              return commit(unit, "duplicate");
            }
            committed.add(unit.messageId);
            return commit(unit, "committed");
          },
        };
      },
      kind: "fake",
      capabilities: [{ name: "sqlite-transaction", status: "available" }],
    });
    expect(evidence.status).toBe("failed");
    expect(evidence.failedCases).toEqual(["injected-failure-does-not-leak-message-state"]);
  });

  test("validates unknown input and freezes the resulting unit at the adapter boundary", () => {
    const value = fixture(createMessageId("message:5".padEnd(72, "a")));
    const parsed = parsePromotionUnit(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.placements)).toBe(true);
    expect(() => {
      const { normalizedText: _normalizedText, ...omitted } = value;
      parsePromotionUnit(omitted);
    }).toThrow(TypeError);
    expect(() => parsePromotionUnit({ ...value, unexpected: true })).toThrow(TypeError);
    expect(() =>
      parsePromotionUnit({
        ...value,
        placements: value.placements.map(({ internalDate: _internalDate, ...placement }) => placement),
      }),
    ).toThrow(TypeError);
    expect(() =>
      parsePromotionUnit({
        ...value,
        placements: value.placements.map((placement) => ({
          ...placement,
          internalDate: "not-an-instant",
        })),
      }),
    ).toThrow(TypeError);
    const database = new Database(":memory:");
    try {
      const adapter = createSqlitePromotionAdapter(database);
      expect(() => adapter.promote({ ...value, unexpected: true })).toThrow(
        expect.objectContaining({ code: "invalid-input" }),
      );
    } finally {
      database.close();
    }
  });

  test("reports the canonical identity actually committed by SQLite", async () => {
    const sqlite = await createSqliteFixture();
    const messageId = createMessageId("message:6".padEnd(72, "a"));
    const committed = sqlite.adapter.promote(fixture(messageId));
    expect(committed.routingDecisionIds).toEqual([
      sqlite.opened.db.query("SELECT decision_id FROM routing_decisions WHERE message_id = ?;").get(messageId)
        ?.decision_id,
    ]);
    await sqlite.opened.close();
  });
});
