import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/migration-runner";
import { routingPreviewMigrations } from "../src/routing-preview-migration";
import {
  createRoutingPreview,
  routingPreviewDigest,
  type RoutingPreviewCreationInput,
} from "../src/routing-preview-creation";

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openPreviewDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  applyMigrations(database, routingPreviewMigrations);
  // These adjacent tables model the no-effect assertion without granting the
  // preview operation any access to them.
  database.exec(
    `CREATE TABLE routing_decisions (id TEXT PRIMARY KEY NOT NULL);
     CREATE TABLE local_labels (message_id TEXT NOT NULL, label TEXT NOT NULL);`,
  );
  return database;
}

const candidateTargets = [
  { kind: "local-label", messageId: "message:one", label: "label:important" },
  {
    kind: "remote-placement",
    messageId: "message:two",
    placementId: "placement:two",
    mailboxId: "mailbox:archive",
  },
] satisfies readonly [
  Readonly<{ readonly kind: "local-label"; readonly messageId: string; readonly label: string }>,
  Readonly<{
    readonly kind: "remote-placement";
    readonly messageId: string;
    readonly placementId: string;
    readonly mailboxId: string;
  }>,
];

const input: RoutingPreviewCreationInput = {
  previewId: "preview:one",
  scope: "mail:routing:read",
  rule: {
    version: 1,
    ruleId: "rule:sender",
    ruleVersion: 3,
    predicate: { kind: "exactSender", sender: "Alice@Example.com" },
  },
  facts: { senderAddrSpec: " Alice@example.com ".trim(), listId: null },
  provenance: { source: "routing-evaluator", evaluationId: "evaluation:one" },
  candidateTargets,
  ttlMs: 15 * 60 * 1000,
};

const dependencies = {
  clock: () => "2026-08-18T00:00:00.000Z",
  nonce: () => "nonce:opaque-one",
  digestKey: Buffer.alloc(32, 0x5a),
};

describe("routing preview creation", () => {
  test("persists the exact canonical envelope and digest without routing side effects", () => {
    const database = openPreviewDatabase();
    const preview = createRoutingPreview(database, input, dependencies);

    expect(preview.rule.predicate).toEqual({ kind: "exactSender", sender: "alice@example.com" });
    expect(preview.facts).toEqual({ senderAddrSpec: "alice@example.com", listId: null });
    expect(preview.candidateTargets.map((target) => target.messageId)).toEqual([
      "message:one",
      "message:two",
    ]);
    expect(preview.expiresAt).toBe("2026-08-18T00:15:00.000Z");
    expect(preview.digest).toBe(routingPreviewDigest(preview, dependencies.digestKey));

    expect(
      database.query("SELECT * FROM routing_previews WHERE preview_id = ?;").get("preview:one"),
    ).toEqual({
      preview_id: "preview:one",
      scope: "mail:routing:read",
      rule_version: 3,
      rule_json: '["routing-rule-v1",{"version":1,"ruleId":"rule:sender","ruleVersion":3,"predicate":{"kind":"exactSender","sender":"alice@example.com"}}]',
      facts_json: '{"senderAddrSpec":"alice@example.com","listId":null}',
      provenance_json: '{"source":"routing-evaluator","evaluationId":"evaluation:one"}',
      candidate_targets_json:
        '[{"kind":"local-label","messageId":"message:one","label":"label:important"},{"kind":"remote-placement","messageId":"message:two","placementId":"placement:two","mailboxId":"mailbox:archive"}]',
      created_at: "2026-08-18T00:00:00.000Z",
      expires_at: "2026-08-18T00:15:00.000Z",
      nonce: "nonce:opaque-one",
      digest: preview.digest,
    });
    expect(database.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT COUNT(*) AS count FROM local_labels;").get()).toEqual({ count: 0 });
  });

  test("makes target order and one normalized fact digest-sensitive", () => {
    const database = openPreviewDatabase();
    const first = createRoutingPreview(database, input, dependencies);
    const second = createRoutingPreview(
      database,
      {
        ...input,
        previewId: "preview:two",
        candidateTargets: [...candidateTargets].reverse(),
      },
      dependencies,
    );
    const third = createRoutingPreview(
      database,
      {
        ...input,
        previewId: "preview:three",
        facts: { senderAddrSpec: "alice@example.com", listId: "list.example" },
      },
      dependencies,
    );

    expect(second.digest).not.toBe(first.digest);
    expect(third.digest).not.toBe(first.digest);
    expect(routingPreviewDigest(first, Buffer.alloc(32, 0x6b))).not.toBe(first.digest);
  });

  test("rejects invalid and broadening input before any row is written", () => {
    const database = openPreviewDatabase();
    for (const invalid of [
      { ...input, previewId: "not-a-preview-id" },
      { ...input, scope: "mail:routing:write" },
      { ...input, extra: true },
      {
        ...input,
        candidateTargets: [
          { kind: "local-label", messageId: "message:one", label: "label:important", extra: true },
        ],
      },
      {
        ...input,
        candidateTargets: [
          { kind: "remote-placement", messageId: "deadbeef", placementId: "placement:two", mailboxId: "mailbox:archive" },
        ],
      },
    ]) {
      expect(() => createRoutingPreview(database, invalid, dependencies)).toThrow();
    }
    expect(database.query("SELECT COUNT(*) AS count FROM routing_previews;").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT COUNT(*) AS count FROM routing_decisions;").get()).toEqual({
      count: 0,
    });
    expect(database.query("SELECT COUNT(*) AS count FROM local_labels;").get()).toEqual({ count: 0 });
    expect(() =>
      createRoutingPreview(database, input, { ...dependencies, digestKey: "too-short" }),
    ).toThrow("routing preview digest key must contain at least 32 bytes");
  });

  test("rejects updates and deletes of the bounded proposal", () => {
    const database = openPreviewDatabase();
    const preview = createRoutingPreview(database, input, dependencies);

    expect(() =>
      database.query("UPDATE routing_previews SET scope = ? WHERE preview_id = ?;").run(
        "mail:routing:read",
        preview.previewId,
      ),
    ).toThrow("routing previews are immutable");
    expect(() =>
      database.query("DELETE FROM routing_previews WHERE preview_id = ?;").run(preview.previewId),
    ).toThrow("routing previews are immutable");
    expect(database.query("SELECT COUNT(*) AS count FROM routing_previews;").get()).toEqual({
      count: 1,
    });
  });
});
