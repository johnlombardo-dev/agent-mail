import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations, type Migration } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { identityOnlyContentMigration } from "../src/migrations/0002-identity-only-content";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import { threadGraphMigration } from "../src/migrations/0008-thread-graph";
import { ThreadCursorCodec, ThreadCursorError } from "../src/thread-cursor";
import { ThreadGraphError, ThreadGraphRepository } from "../src/thread-graph-repository";
import { normalizeThreadFacts } from "../src/thread-normalizer";

const migrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  { ...threadGraphMigration, version: 3 },
];

function database(): Database {
  const database = new Database(":memory:");
  applyMigrations(database, migrations);
  return database;
}

function placementDatabase(): Database {
  const database = new Database(":memory:");
  applyMigrations(database, [
    messageCatalogMigration,
    structuredContentMigration,
    { ...placementObservationMigration, version: 3 },
    { ...threadGraphMigration, version: 4 },
  ]);
  return database;
}

function identityOnlyDatabase(): Database {
  const database = new Database(":memory:");
  applyMigrations(database, [
    messageCatalogMigration,
    identityOnlyContentMigration,
    { ...threadGraphMigration, version: 3 },
  ]);
  return database;
}

function message(id: string): string {
  return `message:${id.repeat(64)}`;
}

function facts(id: string, messageId: string, references?: string, state: "identity-only" | "parsed" = "parsed") {
  const headers = state === "identity-only"
    ? []
    : [
        { ordinal: 1, normalizedName: "message-id", value: `<${messageId}>` },
        ...(references === undefined ? [] : [{ ordinal: 2, normalizedName: "references", value: references }]),
        { ordinal: 3, normalizedName: "date", value: `2026-01-01T0${id === "a" ? "0" : "1"}:00:00.000Z` },
      ];
  return normalizeThreadFacts({
    accountId: "account:thread-fixture",
    messageId: message(id),
    contentState: state,
    headers,
    sentAt: state === "identity-only" ? null : headers.find((header) => header.normalizedName === "date")?.value ?? null,
    receivedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("deterministic thread graph storage P6-C04", () => {
  test("strictly bounds and canonicalizes RFC anchors without partial edges", () => {
    const normalized = normalizeThreadFacts({
      accountId: "account:thread-fixture",
      messageId: message("a"),
      headers: [
        { ordinal: 1, normalizedName: "message-id", value: "<Local@EXAMPLE.TEST>" },
        { ordinal: 2, normalizedName: "references", value: `${"<a@example.test> ".repeat(101)}` },
      ],
    });
    expect(normalized.normalizedMessageId).toBe("Local@example.test");
    expect(normalized.references).toEqual([]);
    expect(normalized.diagnostics.map((item) => item.code)).toContain("too-many-tokens");
  });

  test("rejects duplicate Message-ID occurrences and adversarial fields as whole fields", () => {
    const duplicate = normalizeThreadFacts({
      accountId: "account:thread-fixture",
      messageId: message("a"),
      headers: [
        { ordinal: 1, normalizedName: "message-id", value: "<a@example.test>" },
        { ordinal: 2, normalizedName: "message-id", value: "<b@example.test>" },
      ],
    });
    expect(duplicate.messageIdNodeKey).toBeNull();
    expect(duplicate.diagnostics.map((item) => item.code)).toContain("duplicate-field");

    const malformed = normalizeThreadFacts({
      accountId: "account:thread-fixture",
      messageId: message("b"),
      headers: [{ ordinal: 1, normalizedName: "references", value: "<root@example.test> phrase" }],
    });
    expect(malformed.references).toEqual([]);
    expect(malformed.diagnostics.map((item) => item.code)).toContain("malformed-cfws");
  });

  test("stores one weak component for reply ancestry and preserves distinct members", () => {
    const repository = new ThreadGraphRepository(database());
    const root = repository.ingestFacts(facts("a", "root@example.test"));
    const reply = repository.ingestFacts(facts("b", "reply@example.test", "<root@example.test>"));
    expect(reply.threadId).toBe(root.threadId);
    expect(repository.snapshot("account:thread-fixture").sets[0]?.members).toEqual([message("a"), message("b")]);
  });

  test("converges for late roots, duplicate claims, and rootless cycles", () => {
    const late = new ThreadGraphRepository(database());
    const reply = late.ingestFacts(facts("b", "reply@example.test", "<root@example.test>"));
    const root = late.ingestFacts(facts("a", "root@example.test"));
    expect(root.threadId).toBe(reply.threadId);

    const duplicate = new ThreadGraphRepository(database());
    duplicate.ingestFacts(facts("a", "root@example.test"));
    duplicate.ingestFacts(facts("b", "same@example.test", "<root@example.test>"));
    duplicate.ingestFacts(facts("c", "same@example.test", "<root@example.test>"));
    expect(duplicate.snapshot("account:thread-fixture").sets[0]?.memberCount).toBe(3);

    const cycle = new ThreadGraphRepository(database());
    cycle.ingestFacts(facts("a", "cycle-a@example.test", "<cycle-b@example.test>"));
    cycle.ingestFacts(facts("b", "cycle-b@example.test", "<cycle-a@example.test>"));
    expect(cycle.snapshot("account:thread-fixture").sets).toHaveLength(1);
  });

  test("permits exactly one identity-only to parsed recovery and leaves an alias", () => {
    const repository = new ThreadGraphRepository(database());
    const identity = repository.ingestFacts(facts("a", "ignored@example.test", undefined, "identity-only"));
    const parsed = repository.ingestFacts(facts("a", "recovered@example.test"));
    expect(parsed.threadId).not.toBe(identity.threadId);
    expect(repository.resolveThread("account:thread-fixture", identity.threadId).threadId).toBe(parsed.threadId);
    expect(() => repository.ingestFacts(normalizeThreadFacts({
      accountId: "account:thread-fixture",
      messageId: message("a"),
      contentState: "parsed",
      headers: [{ ordinal: 1, normalizedName: "message-id", value: "<other@example.test>" }],
    }))).toThrow(ThreadGraphError);
  });

  test("replay is a durable no-op and generation remains unchanged", () => {
    const repository = new ThreadGraphRepository(database());
    const parsed = facts("a", "root@example.test");
    const first = repository.ingestFacts(parsed);
    const second = repository.ingestFacts(parsed);
    expect(second.changed).toBe(false);
    expect(second.generation).toBe(first.generation);
    expect(repository.currentGeneration()).toBe(first.generation);
  });

  test("signs the account and originally requested handle into a bounded live cursor", () => {
    const codec = new ThreadCursorCodec({ accountId: "account:thread-fixture", activeKey: { keyId: "fixture", secret: "thread-cursor-secret" } });
    const threadId = `thread:${"a".repeat(64)}`;
    const cursor = codec.encode({ requestedThreadHandle: threadId, tuple: { sentAtMissingRank: 1, sentAt: null, messageId: message("b") } });
    expect(codec.decode(cursor, { accountId: "account:thread-fixture", requestedThreadHandle: threadId }).lastMessageId).toBe(message("b"));
    expect(() => codec.decode(`${cursor.slice(0, -1)}A`)).toThrow(ThreadCursorError);
  });

  test("distinguishes unknown direct threads from valid known handles", () => {
    const repository = new ThreadGraphRepository(database());
    expect(() => repository.getPage({ accountId: "account:thread-fixture", threadId: `thread:${"f".repeat(64)}` })).toThrow(ThreadGraphError);
    const error = (() => {
      try {
        repository.resolveThread("account:thread-fixture", `thread:${"f".repeat(64)}`);
      } catch (value: unknown) {
        return value;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ThreadGraphError);
    if (error instanceof ThreadGraphError) expect(error.code).toBe("not_found");
  });

  test("persists the participant truncation fact across graph hydration", () => {
    const repository = new ThreadGraphRepository(database());
    const normalized = normalizeThreadFacts({
      accountId: "account:thread-fixture",
      messageId: message("a"),
      headers: [{ ordinal: 1, normalizedName: "message-id", value: "<participants@example.test>" }],
      receivedAt: "2026-01-01T00:00:00.000Z",
      participants: Array.from({ length: 257 }, (_, index) => ({
        address: `participant-${index}@example.test`,
        role: "to" as const,
        position: index + 1,
      })),
    });
    const result = repository.ingestFacts(normalized);
    const page = repository.getPage({ accountId: "account:thread-fixture", threadId: result.threadId });
    expect(page.participants).toHaveLength(256);
    expect(page.participantsTruncated).toBe(true);
  });

  test("hydrates tombstone-inclusive minimum placement INTERNALDATE after later observations", () => {
    const database = placementDatabase();
    const accountId = "account:thread-fixture";
    const mailboxId = "mailbox:fixture";
    const messageId = message("a");
    database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    database.query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);").run(accountId, mailboxId, 1);
    database.query("INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date) VALUES (?, ?, ?, ?, ?, ?);").run(accountId, mailboxId, 1, 1, messageId, "2026-01-02T00:00:00.000Z");
    const repository = new ThreadGraphRepository(database);
    const result = repository.ingestFacts(normalizeThreadFacts({
      accountId,
      messageId,
      headers: [{ ordinal: 1, normalizedName: "message-id", value: "<received@example.test>" }],
      receivedAt: "2026-01-03T00:00:00.000Z",
    }));
    database.query("INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date) VALUES (?, ?, ?, ?, ?, ?);").run(accountId, mailboxId, 1, 2, messageId, "2026-01-01T00:00:00.000Z");
    database.query("UPDATE remote_placements SET tombstone_observed_at = ?, tombstone_reason = ? WHERE account_id = ? AND mailbox_id = ? AND uid = ?;").run("2026-01-04T00:00:00.000Z", "expunged", accountId, mailboxId, 1);
    const page = repository.getPage({ accountId, threadId: result.threadId });
    expect(page.messages[0]?.receivedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(page.firstReceivedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(page.lastReceivedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("hydrates identity-only history from observed_at when no placement date exists", () => {
    const database = identityOnlyDatabase();
    const accountId = "account:thread-fixture";
    const mailboxId = "mailbox:fixture";
    const messageId = message("a");
    database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
    database.query("INSERT INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);").run(accountId, mailboxId, 1);
    database.query("INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);").run(accountId, mailboxId, 1, 1, messageId);
    database.query("INSERT INTO message_content_states (message_id, content_kind, account_id, mailbox_id, uid_validity, uid, absence_reason, observed_at, stored_at) VALUES (?, 'identity-only', ?, ?, ?, ?, 'not-fetched', ?, ?);").run(messageId, accountId, mailboxId, 1, 1, "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    const repository = new ThreadGraphRepository(database);
    const result = repository.ingestFacts(normalizeThreadFacts({ accountId, messageId, contentState: "identity-only" }));
    const page = repository.getPage({ accountId, threadId: result.threadId });
    expect(page.messages[0]?.contentAvailable).toBe(false);
    expect(page.messages[0]?.receivedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});
