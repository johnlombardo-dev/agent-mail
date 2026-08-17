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
} from "@agent-mail/core";
import { applyMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import {
  CanonicalPromotionError,
  promoteCanonicalMessage,
  readCanonicalPromotion,
  type PromotionUnit,
} from "../src/canonical-promotion";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { localLabelMigration } from "../src/local-label-migration";
import { routingDecisionMigration } from "../src/routing-decision-migration";
import { messageBlobReferencesMigration } from "../src/migrations/0003-message-blob-references";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import { canonicalRoutingDecisionId } from "../src/routing-decision-identity";
import { persistRouteDecision } from "../src/local-label-assignment";

const roots: string[] = [];
const messageId = createMessageId(`message:${"a".repeat(64)}`);
const accountId = createAccountId("account:one");
const mailboxId = createMailboxId("mailbox:inbox");
const plainBlob = createBlobId("1".repeat(64));
const attachmentBlob = createBlobId("2".repeat(64));
const rawBlob = createBlobId("3".repeat(64));
const decision = createRouteDecision({
  kind: "route",
  ruleId: createRoutingRuleId("rule:inbox"),
  ruleVersion: 2,
  matchedFacts: [{ field: "sender", value: "ada@example.test" }],
  decidedAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
  provenance: { source: "local-rule-engine", evaluationId: "evaluation:one" },
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
];

const unit: PromotionUnit = {
  messageId,
  rawSource: { blobId: rawBlob, size: 512 },
  placements: [
    {
      accountId,
      mailboxId,
      uidValidity: 7,
      uid: 11,
      internalDate: createUtcInstant("2026-08-18T00:00:00.000Z"),
    },
  ],
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
  routingDecisions: [{ decisionId: "decision:one", decision }],
  journal: {
    id: "event:promotion:one",
    occurredAt: createUtcInstant("2026-08-18T00:00:00.000Z"),
    category: "sync",
    subjectId: messageId,
    correlationId: "sync:one",
    payloadVersion: 1,
    payloadJson: '{"status":"promoted"}',
  },
};

async function openPromotionDatabase() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-promotion-p2-c13-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  applyMigrations(opened, migrations);
  opened.db
    .query(
      "INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(accountId, mailboxId, 7);
  return { ...opened, path: join(root, "archive.sqlite") };
}

function countRows(database: Database): Record<string, number> {
  const tables = [
    "messages",
    "remote_placements",
    "message_headers",
    "message_addresses",
    "message_body_parts",
    "message_attachments",
    "message_blob_references",
    "routing_decisions",
    "local_labels",
    "local_label_assignments",
    "operational_journal",
  ];
  return Object.fromEntries(
    tables.map((table) => [table, readCount(database.query(`SELECT COUNT(*) AS count FROM ${table};`).get())]),
  );
}

function readCount(row: unknown): number {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new TypeError("row count is not an object");
  }
  const count = Reflect.get(row, "count");
  if (typeof count !== "number") throw new TypeError("row count is not numeric");
  return count;
}

function capture<T>(operation: () => T): T | unknown {
  try {
    return operation();
  } catch (error: unknown) {
    return error;
  }
}

describe("canonical promotion transaction P2-C13", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("rolls back every real-SQLite write boundary, including routing", async () => {
    const boundaries: number[] = [];
    const first = await openPromotionDatabase();
    promoteCanonicalMessage(first.db, unit, {
      beforeWrite: (_boundary, ordinal) => boundaries.push(ordinal),
    });
    await first.close();

    for (const failureOrdinal of boundaries) {
      const opened = await openPromotionDatabase();
      const failure = new Error(`injected write ${failureOrdinal}`);
      const result = capture(() => promoteCanonicalMessage(opened.db, unit, {
        beforeWrite: (_boundary, ordinal) => {
          if (ordinal === failureOrdinal) throw failure;
        },
      }));
      expect(result).toBeInstanceOf(CanonicalPromotionError);
      expect(result).toMatchObject({ code: "write-failed", cause: failure });
      expect(countRows(opened.db)).toEqual({
        messages: 0,
        remote_placements: 0,
        message_headers: 0,
        message_addresses: 0,
        message_body_parts: 0,
        message_attachments: 0,
        routing_decisions: 0,
        local_labels: 0,
        local_label_assignments: 0,
        message_blob_references: 0,
        operational_journal: 0,
      });
      await opened.close();
    }
    expect(boundaries.length).toBeGreaterThan(8);
  });

  test("reopens and reconstructs exact rows, then distinguishes duplicate and conflict", async () => {
    const opened = await openPromotionDatabase();
    expect(promoteCanonicalMessage(opened.db, unit)).toEqual({ messageId, status: "committed" });
    await opened.close();

    const reopened = await openDatabase(join(roots[0], "archive.sqlite"), { supportedSchemaVersion: 7 });
    applyMigrations(reopened, migrations);
    expect(readCanonicalPromotion(reopened.db, messageId)).toEqual({
      ...unit,
      routingDecisions: unit.routingDecisions.map((routing) => ({
        ...routing,
        decisionId: canonicalRoutingDecisionId(messageId, routing.decision),
      })),
    });
    expect(promoteCanonicalMessage(reopened.db, unit)).toEqual({ messageId, status: "duplicate" });
    const beforeConflict = countRows(reopened.db);
    expect(() =>
      promoteCanonicalMessage(reopened.db, {
        ...unit,
        headers: [{ ...unit.headers[0], value: "different" }],
      }),
    ).toThrow("different promotion content");
    expect(countRows(reopened.db)).toEqual(beforeConflict);
    await reopened.close();
  });

  test("a message row cannot survive a routing-decision failure", async () => {
    const opened = await openPromotionDatabase();
    const failure = capture(() => promoteCanonicalMessage(opened.db, unit, {
      beforeWrite: (boundary) => {
        if (boundary === "routing-decision") throw new Error("routing unavailable");
      },
    }));
    expect(failure).toMatchObject({ code: "write-failed" });
    expect(countRows(opened.db).messages).toBe(0);
    expect(countRows(opened.db).routing_decisions).toBe(0);
    await opened.close();
  });

  test("promotion and equivalent sweep persistence converge on one durable decision", async () => {
    const opened = await openPromotionDatabase();
    expect(promoteCanonicalMessage(opened.db, unit)).toEqual({ messageId, status: "committed" });

    const sweep = persistRouteDecision(opened.db, {
      messageId,
      decisionId: "sweep-caller",
      decision: {
        ...decision,
        provenance: { source: "sweep", evaluationId: "evaluation:sweep" },
      },
    });
    expect(sweep.created).toBe(false);
    expect(opened.db.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({
      count: 1,
    });
    expect(opened.db.query("SELECT COUNT(*) AS count FROM local_label_assignments;").get()).toEqual({
      count: 1,
    });
    expect(opened.db.query("SELECT decision_id FROM routing_decisions;").get()).toEqual({
      decision_id: canonicalRoutingDecisionId(messageId, decision),
    });
    await opened.close();
  });
});
