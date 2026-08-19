import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createAccountId, createBlobId, createMailboxId, createMessageId, createUtcInstant } from "@agent-mail/core";
import { runMigrations, type Migration } from "../src/migration-runner";
import { messageCatalogMigration } from "../src/migrations/0001-message-catalog";
import { structuredContentMigration } from "../src/migrations/0002-structured-content";
import { identityOnlyContentMigration } from "../src/migrations/0002-identity-only-content";
import { placementObservationMigration } from "../src/migrations/0003-placement-observation";
import { messageBlobReferencesMigration } from "../src/migrations/0003-message-blob-references";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import { threadGraphMigration } from "../src/migrations/0008-thread-graph";
import { restoreBackup } from "../src/backup-restore";
import { writeBackup } from "../src/backup-writer";
import { ThreadCursorCodec } from "../src/thread-cursor";
import { ThreadGraphError, ThreadGraphRepository } from "../src/thread-graph-repository";
import { normalizeThreadFacts } from "../src/thread-normalizer";
import { storeIdentityOnlyMessage } from "../src/identity-only-repository";
import { promoteCanonicalMessage, type PromotionUnit } from "../src/canonical-promotion";

type OracleMessage = Readonly<{
  readonly messageId: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly recoveredHeaders?: Readonly<Record<string, string>>;
  readonly orderedHeaders?: readonly (readonly [string, string])[];
  readonly initialContentState?: "identity-only" | "parsed";
  readonly observedAt?: string;
  readonly placements?: readonly OraclePlacement[];
}>;

type OraclePlacement = Readonly<{
  readonly mailboxId: string;
  readonly uidValidity: number;
  readonly uid: number;
  readonly internalDate: string;
}>;

type OracleFixtureMessage = Readonly<{
  readonly messageId: string;
  readonly contentState?: "identity-only" | "parsed";
  readonly headers: Readonly<Record<string, string>>;
  readonly sentAt: string | null;
  readonly receivedAt: string;
}>;

type OracleIdentityRecoveryFixture = Readonly<{
  readonly parsedMembers: readonly OracleFixtureMessage[];
  readonly identityOnlyMember: OracleFixtureMessage;
  readonly initialRequest: Readonly<{ readonly limit: number; readonly cursor: null }>;
}>;

type OracleExample = Readonly<{
  readonly id: string;
  readonly accountId: string;
  readonly messages?: readonly OracleMessage[];
  readonly additionalMessages?: readonly OracleMessage[];
  readonly base?: string;
  readonly arrivalOrder?: readonly string[];
  readonly message?: OracleMessage;
  readonly fixture?: OracleIdentityRecoveryFixture;
  readonly expected: Readonly<Record<string, unknown>>;
}>;

type OracleProperty = Readonly<{ readonly id: string }>;
type OracleFile = Readonly<{
  readonly examples: readonly OracleExample[];
  readonly properties: readonly OracleProperty[];
}>;

const ORACLE_SHA256 = "e24efd672113aa5743ef776c3c3add502eea509512cc0573febc7b1d3b1ea269";
const oraclePath = resolve(import.meta.dir, "../../../docs/architecture/thread-oracle.v1.json");
const oracleBytes = await readFile(oraclePath);
const oracle = JSON.parse(oracleBytes.toString("utf8")) as OracleFile;
const oracleById = new Map(oracle.examples.map((example) => [example.id, example]));
const accountId = createAccountId("account:example");
const mailboxId = createMailboxId("mailbox:fixture");

const standardMigrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  { ...placementObservationMigration, version: 3 },
  { ...threadGraphMigration, version: 4 },
];

const identityMigrations: readonly Migration[] = [
  messageCatalogMigration,
  identityOnlyContentMigration,
  { ...threadGraphMigration, version: 3 },
];

const promotionMigrations: readonly Migration[] = [
  messageCatalogMigration,
  structuredContentMigration,
  { ...placementObservationMigration, version: 3 },
  { ...messageBlobReferencesMigration, version: 4 },
  { ...operationalJournalMigration, version: 5 },
  { ...threadGraphMigration, version: 6 },
];

function openDatabase(kind: "standard" | "identity" | "promotion" = "standard", path = ":memory:"): Database {
  const database = new Database(path);
  database.exec("PRAGMA foreign_keys = ON;");
  runMigrations(
    database,
    kind === "identity" ? identityMigrations : kind === "promotion" ? promotionMigrations : standardMigrations,
  );
  return database;
}

function messageId(value: string): string {
  return value;
}

function allMessages(example: OracleExample): readonly OracleMessage[] {
  if (example.messages !== undefined) return example.messages;
  if (example.base !== undefined) {
    const base = oracleById.get(example.base);
    if (base === undefined) throw new Error(`oracle base ${example.base} is missing`);
    return Object.freeze([
      ...allMessages(base),
      ...(example.additionalMessages ?? []),
    ]);
  }
  return [];
}

function headers(message: OracleMessage): readonly { readonly ordinal: number; readonly normalizedName: string; readonly value: string }[] {
  const values =
    message.orderedHeaders ??
    Object.entries(message.headers ?? message.recoveredHeaders ?? {}).map(([name, value]) => [name, value] as const);
  return values.map(([name, value], index) => ({
    ordinal: index + 1,
    normalizedName: name.toLowerCase(),
    value,
  }));
}

function insertMessage(database: Database, value: string): void {
  database.query("INSERT OR IGNORE INTO messages (message_id) VALUES (?);").run(messageId(value));
}

function ensureCheckpoint(database: Database, account: string, mailbox: string, uidValidity: number): void {
  database
    .query(
      "INSERT OR IGNORE INTO mailbox_checkpoints (account_id, mailbox_id, uid_validity) VALUES (?, ?, ?);",
    )
    .run(account, mailbox, uidValidity);
}

function insertPlacement(
  database: Database,
  account: string,
  value: string,
  placement: OraclePlacement,
  flags = "[]",
): Readonly<{
  readonly first: ReturnType<ThreadGraphRepository["getPage"]>;
  readonly continuation: ReturnType<ThreadGraphRepository["getPage"]>;
  readonly fresh: ReturnType<ThreadGraphRepository["getPage"]>;
}> {
  insertMessage(database, value);
  ensureCheckpoint(database, account, placement.mailboxId, placement.uidValidity);
  const hasInternalDate = database
    .query("PRAGMA table_info(remote_placements);")
    .all()
    .some((row: { readonly name: string }) => row.name === "internal_date");
  if (hasInternalDate) {
    database
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id, internal_date, flags_json) VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(account, placement.mailboxId, placement.uidValidity, placement.uid, value, placement.internalDate, flags);
  } else {
    database
      .query(
        "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, ?, ?, ?);",
      )
      .run(account, placement.mailboxId, placement.uidValidity, placement.uid, value);
  }
}

function receivedAt(message: OracleMessage, index: number): string {
  const date = message.headers?.date ?? message.recoveredHeaders?.date;
  if (date !== undefined && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(date)) {
    return date.length === 20 ? date.replace("Z", ".000Z") : date;
  }
  return `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`;
}

/** Simulate the structured-content boundary: raw Date is accepted here, never by the normalizer. */
function structuredSentAt(message: OracleMessage): string | null {
  const value = message.headers?.date ?? message.recoveredHeaders?.date;
  if (value === undefined) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function ingest(
  database: Database,
  repository: ThreadGraphRepository,
  account: string,
  message: OracleMessage,
  index: number,
  state: "identity-only" | "parsed" = "parsed",
): void {
  insertMessage(database, message.messageId);
  const messageHeaders = state === "identity-only" ? [] : headers(message);
  repository.ingestFacts(
    normalizeThreadFacts({
      accountId: account,
      messageId: message.messageId,
      contentState: state,
      headers: messageHeaders,
      sentAt: state === "identity-only" ? null : structuredSentAt(message),
      receivedAt: state === "identity-only" ? null : receivedAt(message, index),
    }),
  );
}

function ingestFixtureMessage(
  database: Database,
  repository: ThreadGraphRepository,
  account: string,
  message: OracleFixtureMessage,
): void {
  insertMessage(database, message.messageId);
  repository.ingestFacts(
    normalizeThreadFacts({
      accountId: account,
      messageId: message.messageId,
      contentState: message.contentState ?? "parsed",
      headers: headers({ messageId: message.messageId, headers: message.headers }),
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
    }),
  );
}

function ingestExample(
  database: Database,
  repository: ThreadGraphRepository,
  example: OracleExample,
  messages = allMessages(example),
): void {
  for (const [index, message] of messages.entries()) {
    if (message.placements !== undefined) {
      for (const placement of message.placements) {
        insertPlacement(database, example.accountId, message.messageId, placement);
      }
    }
    ingest(database, repository, example.accountId, message, index, message.initialContentState);
    if (message.initialContentState === "identity-only" && message.observedAt !== undefined) {
      ensureCheckpoint(database, example.accountId, mailboxId, 1);
      database
        .query(
          "INSERT INTO remote_placements (account_id, mailbox_id, uid_validity, uid, message_id) VALUES (?, ?, 1, ?, ?);",
        )
        .run(example.accountId, mailboxId, index + 1, message.messageId);
      database
        .query(
          "INSERT INTO message_content_states (message_id, content_kind, account_id, mailbox_id, uid_validity, uid, absence_reason, observed_at, stored_at) VALUES (?, 'identity-only', ?, ?, 1, ?, 'not-fetched', ?, ?);",
        )
        .run(
          message.messageId,
          example.accountId,
          mailboxId,
          index + 1,
          message.observedAt,
          message.observedAt,
        );
    }
  }
}

function snapshot(database: Database, account: string): readonly unknown[] {
  const repository = new ThreadGraphRepository(database);
  return repository
    .snapshot(account)
    .sets.map((set) => ({
      canonicalRootNodeKey: set.canonicalRootNodeKey,
      canonicalThreadId: set.canonicalThreadId,
      memberCount: set.memberCount,
      nodeCount: set.nodeCount,
      edgeCount: set.edgeCount,
      handles: [...set.handles].sort(),
      members: [...set.members],
    }))
    .sort((left, right) => left.canonicalRootNodeKey.localeCompare(right.canonicalRootNodeKey));
}

function rootMessageId(database: Database, account: string): string | null {
  const set = database
    .query<{ readonly canonical_root_node_key: string }, [string]>(
      "SELECT canonical_root_node_key FROM thread_sets WHERE account_id = ? ORDER BY set_id LIMIT 1;",
    )
    .get(account);
  if (set === null) return null;
  const byIdentity = database
    .query<{ readonly message_id: string }, [string, string]>(
      "SELECT message_id FROM thread_header_facts WHERE account_id = ? AND message_id_node_key = ? ORDER BY message_id LIMIT 1;",
    )
    .get(account, set.canonical_root_node_key);
  if (byIdentity !== null) return byIdentity.message_id;
  const byMember = database
    .query<{ readonly message_id: string }, [string, string]>(
      "SELECT message_id FROM thread_equivalences WHERE account_id = ? AND member_node_key = ? LIMIT 1;",
    )
    .get(account, set.canonical_root_node_key);
  return byMember?.message_id ?? null;
}

function firstSet(database: Database, account: string): { readonly setId: string; readonly memberCount: number } {
  const row = database
    .query<{ readonly set_id: string; readonly member_count: number }, [string]>(
      "SELECT set_id, member_count FROM thread_sets WHERE account_id = ? ORDER BY set_id LIMIT 1;",
    )
    .get(account);
  if (row === null) throw new Error("oracle fixture did not create a thread set");
  return { setId: row.set_id, memberCount: row.member_count };
}

function canonicalRootNode(database: Database, account: string): string | null {
  const row = database
    .query<{ readonly canonical_root_node_key: string }, [string]>(
      "SELECT canonical_root_node_key FROM thread_sets WHERE account_id = ? ORDER BY set_id LIMIT 1;",
    )
    .get(account);
  return row?.canonical_root_node_key ?? null;
}

function assertOneSet(database: Database, account: string, memberCount: number): void {
  const set = firstSet(database, account);
  expect(database.query("SELECT count(*) AS count FROM thread_sets WHERE account_id = ?;").get(account)).toEqual({ count: 1 });
  expect(set.memberCount).toBe(memberCount);
}

function factsRows(database: Database, account: string): readonly unknown[] {
  return database
    .query(
      "SELECT message_id, content_state, member_node_key, message_id_node_key, references_json, in_reply_to_json, sent_at, received_at, diagnostics_json, facts_sha256 FROM thread_header_facts WHERE account_id = ? ORDER BY message_id;",
    )
    .all(account);
}

function repository(database: Database, withCursor = false): ThreadGraphRepository {
  return new ThreadGraphRepository(
    database,
    withCursor
      ? {
          cursorCodec: new ThreadCursorCodec({
            accountId,
            activeKey: { keyId: "oracle", secret: "oracle-thread-cursor-secret" },
          }),
        }
      : undefined,
  );
}

function rootFact(message: string, date?: string): OracleMessage {
  return {
    messageId: message,
    headers: {
      "message-id": `<root-${message.slice(-4)}@oracle.test>`,
      ...(date === undefined ? {} : { date }),
    },
  };
}

function replyFact(message: string, reference: string, date?: string): OracleMessage {
  return {
    messageId: message,
    headers: {
      "message-id": `<reply-${message.slice(-4)}@oracle.test>`,
      references: `<${reference}>`,
      ...(date === undefined ? {} : { date }),
    },
  };
}

function promotionUnit(message: string, dateValues: readonly string[]): PromotionUnit {
  const messageIdValue = createMessageId(message);
  const headers = [
    {
      ordinal: 1,
      name: "Message-ID",
      normalizedName: "message-id",
      value: "<promotion@example.test>",
      normalizedValue: "<promotion@example.test>",
    },
    ...dateValues.map((value, index) => ({
      ordinal: index + 2,
      name: "Date",
      normalizedName: "date",
      value,
      normalizedValue: value,
    })),
  ];
  return {
    messageId: messageIdValue,
    rawSource: { blobId: createBlobId(`blob:${"a".repeat(64)}`), size: 1 },
    placements: [
      {
        accountId,
        mailboxId,
        uidValidity: 1,
        uid: Number.parseInt(message.slice(-2), 16) + 1,
        internalDate: createUtcInstant("2026-01-01T00:00:00.000Z"),
      },
    ],
    headers,
    addresses: [],
    bodyParts: [],
    attachments: [],
    routingDecisions: [],
    journal: {
      id: `event:promotion:${message.slice(-8)}`,
      occurredAt: createUtcInstant("2026-01-01T00:00:00.000Z"),
      category: "sync",
      subjectId: messageIdValue,
      correlationId: `sync:${message.slice(-8)}`,
      payloadVersion: 1,
      payloadJson: "{}",
    },
  };
}

function runIdentityRecoveryPaginationCase(
  account: string,
  parsedMembers: readonly OracleFixtureMessage[],
  identityOnlyMembers: readonly OracleFixtureMessage[],
  limit: number,
  recoverCount: number,
): void {
  const database = openDatabase();
  try {
    const repo = repository(database, true);
    for (const message of parsedMembers) ingestFixtureMessage(database, repo, account, message);
    for (const message of identityOnlyMembers)
      ingestFixtureMessage(database, repo, account, { ...message, contentState: "identity-only" });
    const handle = repo.snapshot(account).sets[0]?.canonicalThreadId;
    if (handle === undefined) throw new Error("identity recovery pagination handle missing");
    const first = repo.getPage({ accountId: account, threadId: handle, limit });
    expect(first.messageIds).toEqual(parsedMembers.map((message) => message.messageId));
    expect(first.messageCount).toBe(parsedMembers.length + identityOnlyMembers.length);
    expect(first.nextCursor).not.toBeNull();

    for (const [index, message] of identityOnlyMembers.slice(0, recoverCount).entries()) {
      ingestFixtureMessage(database, repo, account, {
        ...message,
        contentState: "parsed",
        sentAt: `2025-01-0${index + 1}T00:00:00.000Z`,
      });
    }
    const continuation = repo.getPage({
      accountId: account,
      threadId: handle,
      limit,
      cursor: first.nextCursor,
    });
    expect(continuation.messageCount).toBe(parsedMembers.length + identityOnlyMembers.length);
    const continuationIds = [...continuation.messageIds];
    let page = continuation;
    while (page.nextCursor !== null) {
      page = repo.getPage({ accountId: account, threadId: handle, limit, cursor: page.nextCursor });
      continuationIds.push(...page.messageIds);
    }
    expect(continuationIds).toEqual(
      identityOnlyMembers.slice(recoverCount).map((message) => message.messageId),
    );
    expect(continuation.messages.map((message) => message.messageId)).toEqual(continuation.messageIds);
    if (identityOnlyMembers.length - recoverCount === 0) {
      expect(continuation.nextCursor).toBeNull();
    } else if (identityOnlyMembers.length - recoverCount > limit) {
      expect(continuation.nextCursor).toEqual(expect.any(String));
    } else {
      expect(continuation.nextCursor).toBeNull();
    }
    const fresh = repo.getPage({ accountId: account, threadId: handle, limit: 100 });
    expect(fresh.messageIds.length).toBeGreaterThan(0);
    return { first, continuation, fresh };
  } finally {
    database.close();
  }
}

function applyBridge(database: Database, repo: ThreadGraphRepository): readonly string[] {
  const roots = [
    rootFact(`message:${"a".repeat(64)}`),
    rootFact(`message:${"b".repeat(64)}`),
  ];
  for (const [index, message] of roots.entries()) ingest(database, repo, accountId, message, index);
  const handles = [...repo.snapshot(accountId).sets].map((set) => set.canonicalThreadId);
  ingest(
    database,
    repo,
    accountId,
    {
      messageId: `message:${"c".repeat(64)}`,
      headers: {
        "message-id": "<bridge@oracle.test>",
        references: "<root-aaaa@oracle.test> <root-bbbb@oracle.test>",
      },
    },
    2,
  );
  return handles;
}

async function restartFixture(example: OracleExample): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-thread-oracle-restart-"));
  const path = join(root, "archive.sqlite");
  try {
    const first = openDatabase("standard", path);
    const firstRepository = repository(first);
    ingestExample(first, firstRepository, example);
    const before = snapshot(first, example.accountId);
    const beforeFacts = factsRows(first, example.accountId);
    const beforeGeneration = firstRepository.currentGeneration();
    first.close();

    const reopened = openDatabase("standard", path);
    const reopenedRepository = repository(reopened);
    ingestExample(reopened, reopenedRepository, example);
    expect(snapshot(reopened, example.accountId)).toEqual(before);
    expect(factsRows(reopened, example.accountId)).toEqual(beforeFacts);
    expect(reopenedRepository.currentGeneration()).toBe(beforeGeneration);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function backupFixture(example: OracleExample): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-thread-oracle-backup-"));
  const sourceRoot = join(root, "source");
  const destination = join(root, "restored");
  const backupPath = join(root, "backup");
  const data = join(sourceRoot, "data");
  const blobs = join(sourceRoot, "blobs");
  const journal = join(sourceRoot, "journal");
  const config = join(sourceRoot, "config");
  const metadataPath = join(config, "archive-metadata.json");
  const databasePath = join(data, "archive.sqlite");
  try {
    await Promise.all([data, blobs, journal, config].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    await writeFile(metadataPath, '{"format":"thread-oracle"}\n', { mode: 0o600 });
    const source = openDatabase("standard", databasePath);
    const sourceRepository = repository(source);
    ingestExample(source, sourceRepository, example);
    const before = snapshot(source, example.accountId);
    const beforeRoot = rootMessageId(source, example.accountId);
    source.close();
    await chmod(databasePath, 0o600);
    await writeBackup({
      privateRoot: sourceRoot,
      databasePath,
      blobDirectory: blobs,
      journalDirectory: journal,
      configurationMetadataPaths: [metadataPath],
      destination: backupPath,
    });
    const restored = await restoreBackup({ backupPath, destination });
    const restoredDatabase = openDatabase("standard", restored.databasePath);
    const restoredRepository = repository(restoredDatabase);
    expect(snapshot(restoredDatabase, example.accountId)).toEqual(before);
    expect(rootMessageId(restoredDatabase, example.accountId)).toBe(beforeRoot);
    const unknown = `thread:${"f".repeat(64)}`;
    expect(() => restoredRepository.resolveThread(example.accountId, unknown)).toThrow(ThreadGraphError);
    restoredDatabase.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runExample(example: OracleExample): void | Promise<void> {
  const expected = example.expected;
  if (example.id === "EX-TWO-MESSAGE-REPLY") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example);
      assertOneSet(database, example.accountId, 2);
      expect(canonicalRootNode(database, example.accountId)).toBe(
        normalizeThreadFacts({ accountId: example.accountId, messageId: example.messages?.[0]?.messageId, headers: headers(example.messages?.[0] ?? { messageId: `message:${"a".repeat(64)}` }) }).messageIdNodeKey,
      );
      expect(snapshot(database, example.accountId)[0]).toMatchObject({ members: expected.order });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-BRANCHED-REPLIES") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example);
      assertOneSet(database, example.accountId, 4);
      expect(canonicalRootNode(database, example.accountId)).toBe(
        normalizeThreadFacts({ accountId: example.accountId, messageId: allMessages(example)[0]?.messageId, headers: headers(allMessages(example)[0] ?? { messageId: `message:${"a".repeat(64)}` }) }).messageIdNodeKey,
      );
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-MISSING-HEADERS") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example);
      expect(firstSet(database, example.accountId).memberCount).toBe(1);
      const root: OracleMessage = {
        messageId: `message:${"a".repeat(64)}`,
        headers: { "message-id": "<root@example.test>", date: "2026-01-01T02:00:00.000Z" },
      };
      ingest(database, repo, example.accountId, root, 2);
      expect(database.query("SELECT max(member_count) AS maximum FROM thread_sets WHERE account_id = ?;").get(example.accountId)).toEqual({ maximum: 2 });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-MALFORMED-ADVERSARIAL") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example);
      const diagnostics = database
        .query<{ readonly diagnostics_json: string }, [string, string]>("SELECT diagnostics_json FROM thread_header_facts WHERE account_id = ? AND message_id = ?;")
        .get(example.accountId, example.messages?.[0]?.messageId ?? "");
      expect(diagnostics).not.toBeNull();
      expect(JSON.parse(diagnostics?.diagnostics_json ?? "[]").map((item: { readonly code: string }) => item.code)).toEqual(expect.arrayContaining(expected.diagnostics));
      expect(database.query("SELECT count(*) AS count FROM thread_edges WHERE account_id = ?;").get(example.accountId)).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-IDENTITY-ONLY-RECOVERY") {
    const database = openDatabase("identity");
    try {
      const repo = repository(database);
      const message = example.message;
      if (message === undefined) throw new Error("identity oracle message missing");
      const initial = { ...message, headers: {}, initialContentState: "identity-only" as const };
      ingestExample(database, repo, example, [initial]);
      const initialHandle = repo.snapshot(example.accountId).sets[0]?.canonicalThreadId;
      if (initialHandle === undefined) throw new Error("identity handle missing");
      const recovered = { ...message, headers: message.recoveredHeaders };
      repo.ingestFacts(
        normalizeThreadFacts({
          accountId: example.accountId,
          messageId: recovered.messageId,
          headers: headers(recovered),
          receivedAt: null,
        }),
      );
      expect(repo.resolveThread(example.accountId, initialHandle).canonical).toBe(false);
      expect(canonicalRootNode(database, example.accountId)).toBe(
        normalizeThreadFacts({ accountId: example.accountId, messageId: message.messageId, headers: [{ ordinal: 1, normalizedName: "message-id", value: "<recovered-root@example.test>" }] }).messageIdNodeKey,
      );
      expect(repo.getPage({ accountId: example.accountId, threadId: initialHandle }).messages[0]?.receivedAt).toBe(message.observedAt);
      expect(database.query("SELECT count(*) AS count FROM thread_edges WHERE account_id = ?;").get(example.accountId)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-DUPLICATE-MESSAGE-ID") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example);
      assertOneSet(database, example.accountId, 2);
      expect(database.query("SELECT count(*) AS count FROM thread_header_facts WHERE account_id = ? AND message_id_node_key IS NOT NULL;").get(example.accountId)).toEqual({ count: 2 });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-DUPLICATE-HEADER-OCCURRENCE") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example);
      expect(database.query("SELECT message_id_node_key FROM thread_header_facts WHERE account_id = ?;").get(example.accountId)).toEqual({ message_id_node_key: null });
      expect(factsRows(database, example.accountId)[0]).toMatchObject({ diagnostics_json: expect.stringContaining("duplicate-field") });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-CROSS-MAILBOX-COPIES") {
    const message = example.message;
    if (message === undefined) throw new Error("cross-mailbox oracle message missing");
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example, [message]);
      assertOneSet(database, example.accountId, 1);
      expect(repo.getPage({ accountId: example.accountId, threadId: repo.snapshot(example.accountId).sets[0]?.canonicalThreadId }).firstReceivedAt).toBe(expected.receivedAt);
      const reversed = openDatabase();
      try {
        const reversedRepo = repository(reversed);
        const reverseMessage = { ...message, placements: [...(message.placements ?? [])].reverse() };
        ingestExample(reversed, reversedRepo, example, [reverseMessage]);
        expect(snapshot(reversed, example.accountId)).toEqual(snapshot(database, example.accountId));
      } finally {
        reversed.close();
      }
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-LATE-ROOT") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      const messages = allMessages(example);
      for (const value of example.arrivalOrder ?? []) {
        const message = messages.find((item) => item.messageId === value);
        if (message === undefined) throw new Error(`late-root message ${value} missing`);
        ingest(database, repo, example.accountId, message, 0);
      }
      const before = canonicalRootNode(database, example.accountId);
      const beforeHandle = repo.snapshot(example.accountId).sets[0]?.canonicalThreadId;
      const root = messages.find((item) => item.messageId.endsWith("6666666666666666666666666666666666666666666666666666666666666666"));
      if (root === undefined) throw new Error("late root missing");
      ingest(database, repo, example.accountId, root, 1);
      const expectedRoot = normalizeThreadFacts({ accountId: example.accountId, messageId: root.messageId, headers: headers(root) }).messageIdNodeKey;
      expect(before).toBe(expectedRoot);
      expect(canonicalRootNode(database, example.accountId)).toBe(expectedRoot);
      expect(repo.snapshot(example.accountId).sets[0]?.canonicalThreadId).toBe(beforeHandle);
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-LATE-BRIDGE-MERGE") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example);
      assertOneSet(database, example.accountId, 3);
      expect(canonicalRootNode(database, example.accountId)).toBe(
        normalizeThreadFacts({ accountId: example.accountId, messageId: allMessages(example)[0]?.messageId, headers: headers(allMessages(example)[0] ?? { messageId: `message:${"8".repeat(64)}` }) }).messageIdNodeKey,
      );
      expect(database.query("SELECT count(*) AS count FROM thread_handles WHERE account_id = ?;").get(example.accountId)).toEqual({ count: 2 });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-TOMBSTONED-MEMBER") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      const messages = allMessages(example);
      for (const [index, message] of messages.entries()) {
        insertPlacement(database, example.accountId, message.messageId, { mailboxId, uidValidity: 1, uid: index + 1, internalDate: `2026-01-01T00:0${index}:00.000Z` });
        ingest(database, repo, example.accountId, message, index);
      }
      const before = repo.snapshot(example.accountId);
      database.query("UPDATE remote_placements SET tombstone_observed_at = ?, tombstone_reason = ? WHERE account_id = ? AND message_id = ?;").run("2026-01-03T00:00:00.000Z", "expunged", example.accountId, messages[0]?.messageId);
      expect(repo.snapshot(example.accountId)).toEqual(before);
      expect(database.query("SELECT count(*) AS count FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL;").get(example.accountId, messages[0]?.messageId)).toEqual({ count: 0 });
      expect(database.query("SELECT count(*) AS count FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL;").get(example.accountId, messages[1]?.messageId)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-EQUAL-TIMESTAMPS") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example, [...(example.messages ?? [])].reverse());
      expect(repo.snapshot(example.accountId).sets[0]?.members).toEqual(expected.order);
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-RESTART-IDEMPOTENCY") return restartFixture(example);
  if (example.id === "EX-BACKUP-RESTORE") return backupFixture(example);
  if (example.id === "EX-UNKNOWN-THREAD") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      let error: unknown;
      try {
        repo.getPage({ accountId: example.accountId, threadId: "thread:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" });
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ThreadGraphError);
      expect(error).toMatchObject({ code: "not_found" });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-LIVE-PAGINATION-LATE-ARRIVAL") {
    const database = openDatabase();
    try {
      const repo = repository(database, true);
      const root = rootFact(`message:${"a".repeat(64)}`, "2026-01-01T00:00:00.000Z");
      const base = [
        root,
        replyFact(`message:${"b".repeat(64)}`, "root-aaaa@oracle.test", "2026-01-01T01:00:00.000Z"),
        replyFact(`message:${"c".repeat(64)}`, "root-aaaa@oracle.test", "2026-01-01T02:00:00.000Z"),
        replyFact(`message:${"d".repeat(64)}`, "root-aaaa@oracle.test", "2026-01-01T04:00:00.000Z"),
      ];
      for (const [index, message] of base.entries()) ingest(database, repo, example.accountId, message, index);
      const handle = repo.snapshot(example.accountId).sets[0]?.canonicalThreadId;
      if (handle === undefined) throw new Error("pagination handle missing");
      const first = repo.getPage({ accountId: example.accountId, threadId: handle, limit: 2 });
      expect(first.nextCursor).not.toBeNull();
      ingest(database, repo, example.accountId, replyFact(`message:${"e".repeat(64)}`, "root-aaaa@oracle.test", "2025-12-31T23:00:00.000Z"), 4);
      ingest(database, repo, example.accountId, replyFact(`message:${"f".repeat(64)}`, "root-aaaa@oracle.test", "2026-01-01T03:00:00.000Z"), 5);
      ingest(database, repo, example.accountId, replyFact(`message:${"8".repeat(64)}`, "root-aaaa@oracle.test", "2026-01-01T05:00:00.000Z"), 6);
      const second = repo.getPage({ accountId: example.accountId, threadId: handle, limit: 2, cursor: first.nextCursor });
      const third = second.nextCursor === null ? null : repo.getPage({ accountId: example.accountId, threadId: handle, limit: 2, cursor: second.nextCursor });
      const continued = [...second.messageIds, ...(third?.messageIds ?? [])];
      expect(continued).toEqual([base[2]?.messageId, `message:${"f".repeat(64)}`, base[3]?.messageId, `message:${"8".repeat(64)}`]);
      expect(new Set(continued).size).toBe(continued.length);
      expect(repo.getPage({ accountId: example.accountId, threadId: handle, limit: 10 }).messageIds).toContain(`message:${"e".repeat(64)}`);
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-LIVE-PAGINATION-IDENTITY-RECOVERY-EMPTY") {
    const fixture = example.fixture;
    if (fixture === undefined) throw new Error("identity recovery oracle fixture missing");
    const pages = runIdentityRecoveryPaginationCase(
      example.accountId,
      fixture.parsedMembers,
      [fixture.identityOnlyMember],
      fixture.initialRequest.limit,
      1,
    );
    expect(pages.first.messageCount).toBe(3);
    expect(pages.first.messageIds).toEqual([
      fixture.parsedMembers[0]?.messageId,
      fixture.parsedMembers[1]?.messageId,
    ]);
    expect(pages.first.messages.map((message) => message.messageId)).toEqual(pages.first.messageIds);
    expect(pages.first.subject).toBeNull();
    expect(pages.first.participants).toEqual([]);
    expect(pages.first.participantsTruncated).toBe(false);
    expect(pages.first.firstReceivedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(pages.first.lastReceivedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(pages.continuation).toMatchObject({
      threadId: pages.first.threadId,
      resolvedFromThreadId: null,
      messageCount: 3,
      messageIds: [],
      messages: [],
      subject: null,
      participants: [],
      participantsTruncated: false,
      firstReceivedAt: "2026-01-01T00:00:00.000Z",
      lastReceivedAt: "2026-01-03T00:00:00.000Z",
      nextCursor: null,
    });
    expect(pages.fresh.messageIds).toEqual([
      fixture.identityOnlyMember.messageId,
      ...fixture.parsedMembers.map((message) => message.messageId),
    ]);
    const database = openDatabase();
    try {
      const repo = repository(database, true);
      for (const message of fixture.parsedMembers)
        ingestFixtureMessage(database, repo, example.accountId, message);
      ingestFixtureMessage(database, repo, example.accountId, {
        ...fixture.identityOnlyMember,
        contentState: "identity-only",
      });
      const handle = repo.snapshot(example.accountId).sets[0]?.canonicalThreadId;
      if (handle === undefined) throw new Error("identity recovery handle missing");
      expect(() => repo.getPage({
        accountId: example.accountId,
        threadId: handle,
        cursor: "not-a-valid-cursor",
      })).toThrow(expect.objectContaining({ code: "invalid_cursor" }));
      expect(() => repo.getPage({
        accountId: example.accountId,
        threadId: `thread:${"f".repeat(64)}`,
        cursor: "not-a-valid-cursor",
      })).toThrow(expect.objectContaining({ code: "not_found" }));
      database
        .query("DELETE FROM thread_memberships WHERE account_id = ?;")
        .run(example.accountId);
      expect(() => repo.getPage({ accountId: example.accountId, threadId: handle }))
        .toThrow(expect.objectContaining({ code: "invariant" }));
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-OVERSIZED-REFERENCES") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      const message = example.message;
      if (message === undefined) throw new Error("oversized oracle message missing");
      const value = { ...message, headers: { "message-id": "<bounded@example.test>", references: Array.from({ length: 101 }, (_, index) => `<r${index}@example.test>`).join(" ") } };
      ingest(database, repo, example.accountId, value, 0);
      expect(database.query("SELECT references_json FROM thread_header_facts WHERE account_id = ?;").get(example.accountId)).toEqual({ references_json: "[]" });
      expect(factsRows(database, example.accountId)[0]).toMatchObject({ diagnostics_json: expect.stringContaining("too-many-tokens") });
      expect(database.query("SELECT message_id_node_key FROM thread_header_facts WHERE account_id = ?;").get(example.accountId)).toEqual({ message_id_node_key: expect.any(String) });
    } finally {
      database.close();
    }
    return;
  }
  if (example.id === "EX-ROOTLESS-CYCLE") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      ingestExample(database, repo, example, [...(example.messages ?? [])].reverse());
      assertOneSet(database, example.accountId, 2);
      expect(database.query("SELECT count(*) AS count FROM thread_nodes AS n WHERE n.account_id = ? AND NOT EXISTS (SELECT 1 FROM thread_edges AS e WHERE e.account_id = n.account_id AND e.set_id = n.set_id AND e.target_class_key = n.class_key AND e.source_class_key <> e.target_class_key);").get(example.accountId)).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    return;
  }
  throw new Error(`oracle example ${example.id} has no real SQLite runner`);
}

function runProperty(property: OracleProperty): void | Promise<void> {
  if (property.id === "PROP-INGESTION-ORDER") {
    const example = oracleById.get("EX-LATE-BRIDGE-MERGE");
    if (example === undefined) throw new Error("late bridge fixture missing");
    const messages = allMessages(example);
    const permutations = [messages, [...messages].reverse(), [messages[1], messages[2], messages[0]]];
    const snapshots = permutations.map((permutation) => {
      const database = openDatabase();
      try {
        const repo = repository(database);
        ingestExample(database, repo, example, permutation);
        return snapshot(database, example.accountId).map((set) => ({
          ...(set as { readonly canonicalRootNodeKey: string; readonly memberCount: number; readonly members: readonly string[] }),
          handles: undefined,
        }));
      } finally {
        database.close();
      }
    });
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
    return;
  }
  if (property.id === "PROP-IDEMPOTENCY") {
    const database = openDatabase("identity");
    try {
      const repo = repository(database);
      const value = `message:${"1".repeat(64)}`;
      insertMessage(database, value);
      ensureCheckpoint(database, accountId, mailboxId, 1);
      insertPlacement(database, accountId, value, { mailboxId, uidValidity: 1, uid: 1, internalDate: "2026-01-15T00:00:00.000Z" });
      const identity = normalizeThreadFacts({ accountId, messageId: value, contentState: "identity-only" });
      repo.ingestFacts(identity);
      const parsed = normalizeThreadFacts({ accountId, messageId: value, headers: [{ ordinal: 1, normalizedName: "message-id", value: "<recovered@example.test>" }, { ordinal: 2, normalizedName: "references", value: "<root@example.test>" }] });
      repo.ingestFacts(parsed);
      const before = { rows: factsRows(database, accountId), snapshot: snapshot(database, accountId), generation: repo.currentGeneration() };
      repo.ingestFacts(parsed);
      expect({ rows: factsRows(database, accountId), snapshot: snapshot(database, accountId), generation: repo.currentGeneration() }).toEqual(before);
    } finally {
      database.close();
    }
    return;
  }
  if (property.id === "PROP-STABLE-ALIASES") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      const handles = applyBridge(database, repo);
      const final = repo.snapshot(accountId).sets[0]?.canonicalThreadId;
      if (final === undefined) throw new Error("alias final handle missing");
      for (const handle of handles) expect(repo.resolveThread(accountId, handle).threadId).toBe(final);
      expect(repo.resolveThread(accountId, handles[0]).canonical).toBe(false);
    } finally {
      database.close();
    }
    return;
  }
  if (property.id === "PROP-DETERMINISTIC-ORDER") {
    const ids = ["message:a" + "a".repeat(63), "message:b" + "b".repeat(63), "message:c" + "c".repeat(63)];
    const messages: OracleMessage[] = [
      { messageId: ids[0] as string, headers: { "message-id": "<a@oracle.test>", references: "<root@oracle.test>", date: "2026-01-01T00:00:00.000Z" } },
      { messageId: ids[1] as string, headers: { "message-id": "<b@oracle.test>", references: "<root@oracle.test>", date: "2026-01-01T00:00:00+00:00" } },
      { messageId: ids[2] as string, headers: { "message-id": "<c@oracle.test>", references: "<root@oracle.test>" } },
    ];
    const database = openDatabase();
    try {
      const repo = repository(database);
      for (const [index, message] of messages.reverse().entries()) ingest(database, repo, accountId, message, index);
      expect(repo.snapshot(accountId).sets[0]?.members.slice(0, 2)).toEqual([ids[0], ids[1]]);
      expect(repo.snapshot(accountId).sets[0]?.members.at(-1)).toBe(ids[2]);
    } finally {
      database.close();
    }
    return;
  }
  if (property.id === "PROP-LIVE-CURSOR") {
    const example = oracleById.get("EX-LIVE-PAGINATION-LATE-ARRIVAL");
    if (example === undefined) throw new Error("pagination fixture missing");
    runExample(example);
    const recoveryExample = oracleById.get("EX-LIVE-PAGINATION-IDENTITY-RECOVERY-EMPTY");
    if (recoveryExample?.fixture === undefined) throw new Error("identity recovery fixture missing");
    const identityOnlyMembers = ["c", "d", "e"].map((suffix, index) => ({
      messageId: `message:${suffix.repeat(64)}`,
      contentState: "identity-only" as const,
      headers: {
        "message-id": `<pending-${suffix}@oracle.test>`,
        references: "<root-aaaa@oracle.test>",
      },
      sentAt: null,
      receivedAt: `2026-01-0${index + 3}T00:00:00.000Z`,
    }));
    for (const recoverCount of [0, 1, identityOnlyMembers.length]) {
      runIdentityRecoveryPaginationCase(
        recoveryExample.accountId,
        recoveryExample.fixture.parsedMembers,
        identityOnlyMembers,
        recoveryExample.fixture.initialRequest.limit,
        recoverCount,
      );
    }
    return;
  }
  if (property.id === "PROP-BOUNDED-NORMALIZATION") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      for (const count of [0, 1, 100, 101]) {
        const value = `message:${count.toString(16).padStart(2, "0")}${String(count).repeat(62)}`.slice(0, 72);
        const references = Array.from({ length: count }, (_, index) => `<r${index}@oracle.test>`).join(" ");
        const normalized = normalizeThreadFacts({ accountId, messageId: value, headers: [{ ordinal: 1, normalizedName: "message-id", value: `<m${count}@oracle.test>` }, ...(count === 0 ? [] : [{ ordinal: 2, normalizedName: "references", value: references }]) ] });
        insertMessage(database, value);
        repo.ingestFacts(normalized);
        expect(normalized.references.length).toBe(count > 100 ? 0 : count);
      }
      const tooManyReply = normalizeThreadFacts({ accountId, messageId: `message:${"e".repeat(64)}`, headers: [{ ordinal: 1, normalizedName: "in-reply-to", value: Array.from({ length: 33 }, (_, index) => `<r${index}@oracle.test>`).join(" ") }] });
      expect(tooManyReply.inReplyTo).toEqual([]);
      expect(tooManyReply.diagnostics.map((item) => item.code)).toContain("too-many-tokens");
    } finally {
      database.close();
    }
    return;
  }
  if (property.id === "PROP-BOUNDED-STORAGE") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      let previous = "root@oracle.test";
      for (let index = 0; index < 32; index += 1) {
        const value = `message:${index.toString(16).padStart(2, "0")}${String(index).repeat(62)}`.slice(0, 72);
        ingest(database, repo, accountId, { messageId: value, headers: { "message-id": `<n${index}@oracle.test>`, references: index === 0 ? "" : `<${previous}>` } }, index);
        previous = `n${index}@oracle.test`;
      }
      const plan = database.query("EXPLAIN QUERY PLAN SELECT message_id FROM thread_memberships WHERE account_id = ? AND set_id = ? ORDER BY sent_at_missing_rank, sent_at, message_id LIMIT 10;").all(accountId, firstSet(database, accountId).setId).map((row: { readonly detail: string }) => row.detail).join("\n");
      expect(plan).not.toContain("OFFSET");
      expect(plan).toMatch(/USING (COVERING )?INDEX/u);
    } finally {
      database.close();
    }
    return;
  }
  if (property.id === "PROP-RESTART-RESTORE") {
    const example = oracleById.get("EX-BACKUP-RESTORE");
    if (example === undefined) throw new Error("backup fixture missing");
    return backupFixture(example);
  }
  if (property.id === "PROP-TOMBSTONE") {
    const example = oracleById.get("EX-TOMBSTONED-MEMBER");
    if (example === undefined) throw new Error("tombstone fixture missing");
    return runExample(example);
  }
  if (property.id === "PROP-NOT-FOUND") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      expect(() => repo.resolveThread(accountId, `thread:${"f".repeat(64)}`)).toThrow(ThreadGraphError);
      expect(() => repo.resolveThread(accountId, "thread:not-a-digest")).toThrow(ThreadGraphError);
    } finally {
      database.close();
    }
    return;
  }
  if (property.id === "PROP-CROSS-MAILBOX-DUPLICATE") {
    const database = openDatabase();
    try {
      const repo = repository(database);
      const one = `message:${"a".repeat(64)}`;
      const two = `message:${"b".repeat(64)}`;
      insertPlacement(database, accountId, one, { mailboxId, uidValidity: 1, uid: 1, internalDate: "2026-01-01T00:00:00.000Z" });
      insertPlacement(database, accountId, one, { mailboxId: "mailbox:archive", uidValidity: 2, uid: 2, internalDate: "2026-01-01T00:00:01.000Z" });
      ingest(database, repo, accountId, { messageId: one, headers: { "message-id": "<same@oracle.test>" } }, 0);
      ingest(database, repo, accountId, { messageId: two, headers: { "message-id": "<same@oracle.test>" } }, 1);
      assertOneSet(database, accountId, 2);
      expect(repo.snapshot(accountId).sets[0]?.members).toEqual([one, two]);
    } finally {
      database.close();
    }
    return;
  }
  throw new Error(`oracle property ${property.id} has no real SQLite runner`);
}

describe("frozen thread oracle v1 against real SQLite P6-C04", () => {
  test("ORACLE-DIGEST-e24efd67", () => {
    expect(createHash("sha256").update(oracleBytes).digest("hex")).toBe(ORACLE_SHA256);
    expect(oracle.examples.map(({ id }) => id)).toHaveLength(19);
    expect(oracle.properties.map(({ id }) => id)).toHaveLength(11);
  });

  test("REG-IDENTITY-ONLY-GRAPH", () => {
    const database = openDatabase("identity");
    try {
      const value = `message:${"a".repeat(64)}`;
      storeIdentityOnlyMessage(database, {
        messageId: value,
        remoteUid: { accountId, mailboxId, uidValidity: 1, uid: 1 },
        absenceReason: "not-fetched",
        observedAt: "2026-01-15T00:00:00.000Z",
        storedAt: "2026-01-15T00:00:00.000Z",
      });
      expect(database.query("SELECT count(*) AS count FROM thread_header_facts WHERE account_id = ? AND message_id = ?;").get(accountId, value)).toEqual({ count: 1 });
      expect(database.query("SELECT count(*) AS count FROM thread_memberships WHERE account_id = ? AND message_id = ?;").get(accountId, value)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  test("REG-PROMOTION-RFC-DATE-BOUNDARY", () => {
    const database = openDatabase("promotion");
    try {
      const cases = [
        {
          id: `message:${"b".repeat(64)}`,
          dates: ["Thu, 01 Jan 2026 00:00:00 +0000"],
          sentAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: `message:${"c".repeat(64)}`,
          dates: ["Thu, 01 Jan 2026 00:00:00 +0000", "Fri, 02 Jan 2026 00:00:00 +0000"],
          sentAt: null,
        },
        { id: `message:${"d".repeat(64)}`, dates: ["not-a-date"], sentAt: null },
      ];
      for (const item of cases) {
        ensureCheckpoint(database, accountId, mailboxId, 1);
        promoteCanonicalMessage(database, promotionUnit(item.id, item.dates));
        expect(
          database
            .query("SELECT sent_at FROM thread_header_facts WHERE account_id = ? AND message_id = ?;")
            .get(accountId, item.id),
        ).toEqual({ sent_at: item.sentAt });
      }
    } finally {
      database.close();
    }
  });

  test("REG-PAGINATION-EXACT-MULTIPLE", () => {
    const database = openDatabase();
    try {
      const repo = repository(database, true);
      ingest(database, repo, accountId, rootFact(`message:${"c".repeat(64)}`, "2026-01-01T00:00:00.000Z"), 0);
      ingest(database, repo, accountId, replyFact(`message:${"d".repeat(64)}`, "root-cccc@oracle.test", "2026-01-01T01:00:00.000Z"), 1);
      const handle = repo.snapshot(accountId).sets[0]?.canonicalThreadId;
      if (handle === undefined) throw new Error("exact pagination handle missing");
      expect(repo.getPage({ accountId, threadId: handle, limit: 2 }).nextCursor).toBeNull();
    } finally {
      database.close();
    }
  });

  test("REG-CURSOR-CANONICAL-ENVELOPE", () => {
    const codec = new ThreadCursorCodec({
      accountId,
      activeKey: { keyId: "oracle", secret: "oracle-thread-cursor-secret" },
    });
    const cursor = codec.encode({
      requestedThreadHandle: `thread:${"a".repeat(64)}`,
      tuple: { sentAtMissingRank: 1, sentAt: null, messageId: `message:${"b".repeat(64)}` },
    });
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const noncanonical = Buffer.from(` ${decoded} `, "utf8").toString("base64url");
    expect(() => codec.decode(noncanonical)).toThrow();
  });

  test("REG-MERGE-ROW-ONCE", () => {
    const database = openDatabase();
    try {
      const repo = repository(database);
      const handles = applyBridge(database, repo);
      const losing = handles.find((handle) =>
        database.query("SELECT count(*) AS count FROM thread_merges WHERE account_id = ? AND losing_thread_id = ?;").get(accountId, handle).count > 0,
      );
      if (losing === undefined) throw new Error("bridge did not create an alias merge");
      const before = database.query("SELECT count(*) AS count FROM thread_merges WHERE account_id = ? AND losing_thread_id = ?;").get(accountId, losing).count;
      ingest(database, repo, accountId, replyFact(`message:${"d".repeat(64)}`, "bridge@oracle.test", "2026-01-01T04:00:00.000Z"), 4);
      const after = database.query("SELECT count(*) AS count FROM thread_merges WHERE account_id = ? AND losing_thread_id = ?;").get(accountId, losing).count;
      expect(after).toBe(before);
    } finally {
      database.close();
    }
  });

  test("REG-PARTICIPANT-ROLE-ORDER", () => {
    const facts = normalizeThreadFacts({
      accountId,
      messageId: `message:${"e".repeat(64)}`,
      participants: [
        { address: "to@example.test", role: "to", position: 1 },
        { address: "from@example.test", role: "from", position: 1 },
        { address: "cc@example.test", role: "cc", position: 1 },
        { address: "sender@example.test", role: "sender", position: 1 },
      ],
    });
    expect(facts.participants.map((participant) => participant.role)).toEqual(["from", "sender", "to", "cc"]);

    const crowded = normalizeThreadFacts({
      accountId,
      messageId: `message:${"f".repeat(64)}`,
      participants: [
        ...Array.from({ length: 257 }, (_, index) => ({
          address: `to-${index}@example.test`,
          role: "to" as const,
          position: index + 1,
        })),
        { address: "to-0@example.test", role: "from" as const, position: 1 },
      ],
    });
    expect(crowded.participants).toHaveLength(256);
    expect(crowded.participants[0]).toMatchObject({ address: "to-0@example.test", role: "from" });
    expect(crowded.participantsTruncated).toBe(true);
  });

  test("REG-CONTRADICTION-LIVE-CURSOR-IDENTITY-RECOVERY", () => {
    const database = openDatabase();
    try {
      const repo = repository(database, true);
      const rootId = `message:${"a".repeat(64)}`;
      const replyId = `message:${"b".repeat(64)}`;
      const pendingId = `message:${"c".repeat(64)}`;
      ingest(database, repo, accountId, rootFact(rootId, "2026-01-01T00:00:00.000Z"), 0);
      ingest(database, repo, accountId, replyFact(replyId, "root-aaaa@oracle.test", "2026-01-02T00:00:00.000Z"), 1);

      // This is the smallest graph state permitted by the storage boundary: an
      // identity-only member has a durable pending ancestry fact and a null tail
      // tuple before structured content recovery.
      const pendingHeaders = [
        { ordinal: 1, normalizedName: "message-id", value: "<pending@oracle.test>" },
        { ordinal: 2, normalizedName: "references", value: "<root-aaaa@oracle.test>" },
      ];
      repo.ingestFacts(
        normalizeThreadFacts({
          accountId,
          messageId: pendingId,
          contentState: "identity-only",
          headers: pendingHeaders,
          sentAt: null,
          receivedAt: "2026-01-03T00:00:00.000Z",
        }),
      );
      const handle = repo.snapshot(accountId).sets[0]?.canonicalThreadId;
      if (handle === undefined) throw new Error("counterexample handle missing");
      const first = repo.getPage({ accountId, threadId: handle, limit: 2 });
      expect(first.messageIds).toEqual([rootId, replyId]);
      expect(first.nextCursor).not.toBeNull();

      repo.ingestFacts(
        normalizeThreadFacts({
          accountId,
          messageId: pendingId,
          contentState: "parsed",
          headers: pendingHeaders,
          sentAt: "2025-01-01T00:00:00.000Z",
          receivedAt: "2026-01-03T00:00:00.000Z",
        }),
      );
      const continuation = repo.getPage({
        accountId,
        threadId: handle,
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(continuation.messageCount).toBe(3);
      expect(continuation.messageIds).toEqual([]);
    } finally {
      database.close();
    }
  });

  for (const example of oracle.examples) {
    test(example.id, async () => {
      await runExample(example);
    });
  }

  for (const property of oracle.properties) {
    test(property.id, async () => {
      await runProperty(property);
    });
  }
});
