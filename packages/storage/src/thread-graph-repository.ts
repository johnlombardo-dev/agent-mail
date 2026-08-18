import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  createThreadId,
  parseAccountId,
  parseMessageId,
  parseThreadId,
  parseUtcInstant,
  type AccountId,
  type MessageId,
  type ThreadId,
  type UtcInstant,
} from "@agent-mail/core";
import { normalizeThreadFacts, type ThreadNormalizationInput } from "./thread-normalizer";
import { ThreadCursorCodec, type ThreadCursorPayload } from "./thread-cursor";
import {
  THREAD_LIMITS,
  THREAD_NORMALIZER_VERSION,
  assertNodeKey,
  memberNodeKey,
  type NormalizedMessageId,
  type ThreadCursorTuple,
  type ThreadDiagnostic,
  type ThreadGraphSnapshot,
  type ThreadMessage,
  type ThreadNormalizedFacts,
  type ThreadPage,
  type ThreadSetId,
} from "./thread-types";

const THREAD_ID_PATTERN = /^thread:[0-9a-f]{64}$/u;
const NODE_PATTERN = /^[im]:[0-9a-f]{64}$/u;

export type ThreadGraphRepositoryOptions = Readonly<{
  readonly cursorCodec?: ThreadCursorCodec;
}>;

export type ThreadIngestResult = Readonly<{
  readonly accountId: AccountId;
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly aliases: readonly ThreadId[];
  readonly generation: number;
  readonly changed: boolean;
}>;

export class ThreadGraphError extends Error {
  readonly code: "invalid-input" | "not_found" | "invalid_cursor" | "invariant" | "storage";

  constructor(code: ThreadGraphError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ThreadGraphError";
    this.code = code;
  }
}

type SetRow = Readonly<{
  account_id: unknown;
  set_id: unknown;
  member_count: unknown;
  node_count: unknown;
  equivalence_count: unknown;
  edge_count: unknown;
  participant_count: unknown;
  participants_truncated: unknown;
  handle_count: unknown;
  canonical_root_node_key: unknown;
  canonical_thread_id: unknown;
  updated_generation: unknown;
}>;
type StoredFactRow = Readonly<{
  account_id: unknown;
  message_id: unknown;
  content_state: unknown;
  normalizer_version: unknown;
  member_node_key: unknown;
  message_id_node_key: unknown;
  references_json: unknown;
  in_reply_to_json: unknown;
  sent_at: unknown;
  received_at: unknown;
  diagnostics_json: unknown;
  facts_sha256: unknown;
}>;
type MembershipRow = Readonly<{
  message_id: unknown;
  set_id: unknown;
  member_node_key: unknown;
  order_state: unknown;
  sent_at: unknown;
  sent_at_missing_rank: unknown;
  received_at: unknown;
}>;
type HandleRow = Readonly<{ thread_id: unknown; set_id: unknown; canonical_when_created: unknown }>;
type NodeRow = Readonly<{ node_key: unknown; set_id: unknown; class_key: unknown }>;

/** One SQLite-backed owner for v1 normalization facts, graph merges and pages. */
export class ThreadGraphRepository {
  readonly #database: Database;
  readonly #cursorCodec: ThreadCursorCodec | undefined;
  readonly #pendingMergeRoots = new Map<string, string>();

  constructor(database: Database, options: ThreadGraphRepositoryOptions = {}) {
    this.#database = database;
    this.#cursorCodec = options.cursorCodec;
  }

  /** Submit already normalized facts from the ingestion boundary. */
  ingestFacts(facts: ThreadNormalizedFacts): ThreadIngestResult {
    validateFacts(facts);
    let transactionStarted = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      transactionStarted = true;
      const result = this.ingestFactsInTransaction(facts);
      this.#database.exec("COMMIT;");
      transactionStarted = false;
      return result;
    } catch (error: unknown) {
      if (transactionStarted) rollback(this.#database);
      if (error instanceof ThreadGraphError) throw error;
      throw new ThreadGraphError("storage", "thread graph write failed", { cause: error });
    }
  }

  /**
   * Ingest while the caller owns an already-open BEGIN IMMEDIATE transaction.
   * Canonical promotion uses this seam so content, placements, facts and graph
   * rows commit or roll back as one storage unit.
   */
  ingestFactsInTransaction(facts: ThreadNormalizedFacts): ThreadIngestResult {
    validateFacts(facts);
    return this.ingestInTransaction(facts);
  }

  /** Normalize accepted header rows and persist them in one graph transaction. */
  ingest(input: ThreadNormalizationInput | ThreadNormalizedFacts): ThreadIngestResult {
    return isNormalizedFacts(input)
      ? this.ingestFacts(input)
      : this.ingestFacts(normalizeThreadFacts(input));
  }

  ingestMessage(input: ThreadNormalizationInput): ThreadIngestResult {
    return this.ingestFacts(normalizeThreadFacts(input));
  }

  resolveThread(
    accountIdInput: unknown,
    threadIdInput: unknown,
  ): Readonly<{
    readonly threadId: ThreadId;
    readonly setId: ThreadSetId;
    readonly canonical: boolean;
  }> {
    const accountId = parseAccount(accountIdInput);
    const requested = parseThreadHandle(threadIdInput);
    const row = this.#database
      .query<SetRow, [string, string]>(
        "SELECT s.* FROM thread_handles AS h JOIN thread_sets AS s ON s.account_id = h.account_id AND s.set_id = h.set_id WHERE h.account_id = ? AND h.thread_id = ?;",
      )
      .get(accountId, requested);
    if (row === null) throw new ThreadGraphError("not_found", "thread was not found");
    const decoded = decodeSet(row);
    return Object.freeze({
      threadId: decoded.canonicalThreadId,
      setId: decoded.setId,
      canonical: requested === decoded.canonicalThreadId,
    });
  }

  getPage(
    request: Readonly<{
      readonly accountId: unknown;
      readonly threadId: unknown;
      readonly limit?: unknown;
      readonly cursor?: unknown;
    }>,
  ): ThreadPage {
    const accountId = parseAccount(request.accountId);
    const requested = parseThreadHandle(request.threadId);
    const limit = parseLimit(request.limit);
    let transactionStarted = false;
    try {
      this.#database.exec("BEGIN;");
      transactionStarted = true;
      const resolved = this.resolveThread(accountId, requested);
      const cursor =
        request.cursor === undefined || request.cursor === null
          ? undefined
          : this.decodeCursor(request.cursor, accountId, requested);
      const fetchedMembers =
        cursor === undefined
          ? this.readFirstMembers(accountId, resolved.setId, limit)
          : this.readAfterMembers(accountId, resolved.setId, cursor, limit);
      const hasMore = fetchedMembers.length > limit;
      const members = hasMore ? fetchedMembers.slice(0, limit) : fetchedMembers;
      const page = this.hydratePage(
        accountId,
        requested,
        resolved,
        members,
        hasMore,
        cursor !== undefined,
      );
      this.#database.exec("COMMIT;");
      transactionStarted = false;
      return page;
    } catch (error: unknown) {
      if (transactionStarted) rollback(this.#database);
      if (error instanceof ThreadGraphError) throw error;
      throw new ThreadGraphError("storage", "thread page read failed", { cause: error });
    }
  }

  read(request: Parameters<ThreadGraphRepository["getPage"]>[0]): ThreadPage {
    return this.getPage(request);
  }

  snapshot(accountIdInput: unknown): ThreadGraphSnapshot {
    const accountId = parseAccount(accountIdInput);
    let transactionStarted = false;
    try {
      this.#database.exec("BEGIN;");
      transactionStarted = true;
      const generation = readGeneration(this.#database);
      const sets = this.#database
        .query<SetRow, [string]>("SELECT * FROM thread_sets WHERE account_id = ? ORDER BY set_id;")
        .all(accountId);
      const snapshot = sets.map((row) => {
        const set = decodeSet(row);
        const members = this.#database
          .query<Readonly<{ message_id: unknown }>, [string, string]>(
            "SELECT message_id FROM thread_memberships WHERE account_id = ? AND set_id = ? ORDER BY sent_at_missing_rank, sent_at, message_id;",
          )
          .all(accountId, set.setId)
          .map((item) => parseMessageId(item.message_id));
        const handles = this.#database
          .query<Readonly<{ thread_id: unknown }>, [string, string]>(
            "SELECT thread_id FROM thread_handles WHERE account_id = ? AND set_id = ? ORDER BY thread_id;",
          )
          .all(accountId, set.setId)
          .map((item) => parseThreadHandle(item.thread_id));
        return Object.freeze({
          accountId,
          setId: set.setId,
          canonicalRootNodeKey: set.canonicalRootNodeKey,
          canonicalThreadId: set.canonicalThreadId,
          memberCount: set.memberCount,
          nodeCount: decodeNumber(row.node_count),
          edgeCount: decodeNumber(row.edge_count),
          handles: Object.freeze(handles),
          members: Object.freeze(members),
        });
      });
      this.#database.exec("COMMIT;");
      transactionStarted = false;
      return Object.freeze({ generation, sets: Object.freeze(snapshot) });
    } catch (error: unknown) {
      if (transactionStarted) rollback(this.#database);
      if (error instanceof ThreadGraphError) throw error;
      throw new ThreadGraphError("storage", "thread snapshot failed", { cause: error });
    }
  }

  currentGeneration(): number {
    return readGeneration(this.#database);
  }

  private ingestInTransaction(facts: ThreadNormalizedFacts): ThreadIngestResult {
    const existing = this.#database
      .query<StoredFactRow, [string, string]>(
        "SELECT * FROM thread_header_facts WHERE account_id = ? AND message_id = ?;",
      )
      .get(facts.accountId, facts.messageId);
    if (existing !== null) {
      const old = decodeFacts(existing);
      if (old.factsSha256 === facts.factsSha256 && old.contentState === facts.contentState) {
        this.refreshReceivedAtFromPlacements(facts.accountId, facts.messageId, facts.receivedAt);
        const resolved = this.resolveForMessage(facts.accountId, facts.messageId);
        return Object.freeze({
          accountId: facts.accountId,
          messageId: facts.messageId,
          threadId: resolved.threadId,
          aliases: resolved.aliases,
          generation: readGeneration(this.#database),
          changed: false,
        });
      }
      if (
        old.contentState !== "identity-only" ||
        facts.contentState !== "parsed" ||
        !isMonotonicRecovery(old, facts)
      ) {
        throw new ThreadGraphError("invariant", "parsed thread facts are immutable");
      }
    }
    const generationBefore = readGeneration(this.#database);
    const affectedBefore =
      existing === null ? [] : this.collectSetIds(facts.accountId, facts, existing);
    this.ensureNode(facts.accountId, facts.memberNodeKey);
    if (facts.messageIdNodeKey !== null) this.ensureNode(facts.accountId, facts.messageIdNodeKey);
    if (facts.messageIdNodeKey !== null)
      this.claimOwnMessageId(facts.accountId, facts.memberNodeKey, facts.messageIdNodeKey);
    const nodeKeys = new Set<string>([facts.memberNodeKey]);
    if (facts.messageIdNodeKey !== null) nodeKeys.add(facts.messageIdNodeKey);
    for (const token of [...facts.references, ...facts.inReplyTo]) {
      const nodeKey = messageIdNodeKey(token);
      nodeKeys.add(nodeKey);
      this.ensureNode(facts.accountId, nodeKey);
    }
    this.upsertFacts(facts);
    const edgePairs = edgePairsForFacts(facts);
    for (const edge of edgePairs)
      this.insertEdge(
        facts.accountId,
        edge.source,
        edge.target,
        facts.messageId,
        edge.field,
        edge.ordinal,
      );
    for (const nodeKey of nodeKeys) {
      const row = this.readNode(facts.accountId, nodeKey);
      if (row !== undefined) nodeKeys.add(row.classKey);
    }
    const affectedSetIds = new Set<string>([
      ...affectedBefore,
      ...this.readSetIdsForNodes(facts.accountId, nodeKeys),
    ]);
    const winner = this.mergeSets(facts.accountId, affectedSetIds);
    this.upsertMembership(facts, winner, generationBefore + 1);
    this.upsertParticipants(facts, winner);
    const generation = generationBefore + 1;
    const aliases = this.recomputeSet(facts.accountId, winner, generation, facts.messageId);
    const current = this.resolveForMessage(facts.accountId, facts.messageId);
    this.#database
      .query("UPDATE thread_sets SET updated_generation = ? WHERE account_id = ? AND set_id = ?;")
      .run(generation, facts.accountId, winner);
    this.#database
      .query("UPDATE thread_generation SET generation = ? WHERE generation_id = 1;")
      .run(generation);
    return Object.freeze({
      accountId: facts.accountId,
      messageId: facts.messageId,
      threadId: current.threadId,
      aliases: Object.freeze(aliases),
      generation,
      changed: true,
    });
  }

  private ensureNode(accountId: AccountId, nodeKey: string): ThreadSetId {
    assertNodeKey(nodeKey);
    const existing = this.readNode(accountId, nodeKey);
    if (existing !== undefined) return existing.setId;
    const setId =
      `set:${createHash("sha256").update(`${accountId}\0${nodeKey}`, "utf8").digest("hex")}` as ThreadSetId;
    const threadId = deriveThreadId(accountId, nodeKey);
    this.#database
      .query(
        "INSERT INTO thread_sets (account_id, set_id, member_count, node_count, equivalence_count, edge_count, participant_count, participants_truncated, handle_count, canonical_root_node_key, canonical_thread_id, updated_generation) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?);",
      )
      .run(accountId, setId, nodeKey, threadId, readGeneration(this.#database));
    this.#database
      .query(
        "INSERT INTO thread_nodes (account_id, node_key, set_id, class_key, incoming_ancestry_count) VALUES (?, ?, ?, ?, 0);",
      )
      .run(accountId, nodeKey, setId, nodeKey);
    return setId;
  }

  private claimOwnMessageId(accountId: AccountId, memberNodeKey: string, ownNodeKey: string): void {
    const member = this.readNode(accountId, memberNodeKey);
    const own = this.readNode(accountId, ownNodeKey);
    if (member === undefined || own === undefined)
      throw new ThreadGraphError("invariant", "thread member node is missing");
    if (member.classKey === own.classKey) return;
    this.replaceClass(accountId, member.setId, member.classKey, own.classKey);
    this.mergeSets(accountId, new Set([member.setId, own.setId]));
  }

  private replaceClass(
    accountId: AccountId,
    setId: string,
    oldClass: string,
    newClass: string,
  ): void {
    if (oldClass === newClass) return;
    const extraRows = this.#database
      .query<
        Readonly<{
          source_class_key: unknown;
          target_class_key: unknown;
          first_message_id: unknown;
          first_field: unknown;
          first_ordinal: unknown;
        }>,
        [string, string, string, string]
      >(
        "SELECT source_class_key, target_class_key, first_message_id, first_field, first_ordinal FROM thread_edges WHERE account_id = ? AND set_id = ? AND (source_class_key = ? OR target_class_key = ?);",
      )
      .all(accountId, setId, oldClass, oldClass);
    this.#database
      .query(
        "DELETE FROM thread_edges WHERE account_id = ? AND set_id = ? AND (source_class_key = ? OR target_class_key = ?);",
      )
      .run(accountId, setId, oldClass, oldClass);
    this.#database
      .query(
        "UPDATE thread_nodes SET class_key = ? WHERE account_id = ? AND set_id = ? AND class_key = ?;",
      )
      .run(newClass, accountId, setId, oldClass);
    for (const row of extraRows) {
      const source =
        valueString(row.source_class_key) === oldClass
          ? newClass
          : valueString(row.source_class_key);
      const target =
        valueString(row.target_class_key) === oldClass
          ? newClass
          : valueString(row.target_class_key);
      if (source === target) continue;
      this.#database
        .query(
          "INSERT OR IGNORE INTO thread_edges (account_id, source_class_key, target_class_key, set_id, first_message_id, first_field, first_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?);",
        )
        .run(
          accountId,
          source,
          target,
          setId,
          parseMessageId(row.first_message_id),
          fieldValue(row.first_field),
          decodeNumber(row.first_ordinal),
        );
    }
  }

  private insertEdge(
    accountId: AccountId,
    sourceNode: string,
    targetNode: string,
    messageId: MessageId,
    field: "references" | "in-reply-to",
    ordinal: number,
  ): void {
    const source = this.readNode(accountId, sourceNode);
    const target = this.readNode(accountId, targetNode);
    if (source === undefined || target === undefined)
      throw new ThreadGraphError("invariant", "thread edge node is missing");
    if (source.classKey === target.classKey) {
      this.addDiagnostic(accountId, messageId, "self-edge-suppressed", ordinal, field);
      return;
    }
    this.#database
      .query(
        "INSERT OR IGNORE INTO thread_edges (account_id, source_class_key, target_class_key, set_id, first_message_id, first_field, first_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?);",
      )
      .run(accountId, source.classKey, target.classKey, source.setId, messageId, field, ordinal);
  }

  private addDiagnostic(
    accountId: AccountId,
    messageId: MessageId,
    code: "self-edge-suppressed",
    ordinal: number,
    field: "references" | "in-reply-to",
  ): void {
    const row = this.#database
      .query<Readonly<{ diagnostics_json: unknown }>, [string, string]>(
        "SELECT diagnostics_json FROM thread_header_facts WHERE account_id = ? AND message_id = ?;",
      )
      .get(accountId, messageId);
    if (row === null) return;
    const current = parseDiagnostics(row.diagnostics_json);
    if (
      current.some((item) => item.field === field && item.code === code && item.ordinal === ordinal)
    )
      return;
    current.push({ field, code, ordinal });
    this.#database
      .query(
        "UPDATE thread_header_facts SET diagnostics_json = ? WHERE account_id = ? AND message_id = ?;",
      )
      .run(
        JSON.stringify(current.slice(0, THREAD_LIMITS.diagnosticsPerMessage)),
        accountId,
        messageId,
      );
  }

  private mergeSets(accountId: AccountId, setIds: ReadonlySet<string>): ThreadSetId {
    const rows = [...setIds]
      .map((setId) => this.readSet(accountId, setId))
      .filter((row): row is SetRow => row !== undefined);
    if (rows.length === 0) throw new ThreadGraphError("invariant", "thread set is missing");
    const winner = rows
      .slice()
      .sort(
        (left, right) =>
          setWeight(right) - setWeight(left) ||
          valueString(left.set_id).localeCompare(valueString(right.set_id)),
      )[0];
    if (winner === undefined)
      throw new ThreadGraphError("invariant", "thread set winner is missing");
    const winnerId = valueString(winner.set_id);
    const losers = rows.filter((row) => valueString(row.set_id) !== winnerId);
    for (const row of losers) {
      const loserId = valueString(row.set_id);
      if (decodeNumber(row.participants_truncated) !== 0) {
        this.#database
          .query(
            "UPDATE thread_sets SET participants_truncated = 1 WHERE account_id = ? AND set_id = ?;",
          )
          .run(accountId, winnerId);
      }
      const loserHandles = this.#database
        .query<Readonly<{ thread_id: unknown }>, [string, string]>(
          "SELECT thread_id FROM thread_handles WHERE account_id = ? AND set_id = ?;",
        )
        .all(accountId, loserId);
      for (const handle of loserHandles)
        this.#pendingMergeRoots.set(
          `${accountId}\0${winnerId}\0${valueString(handle.thread_id)}`,
          valueString(row.canonical_root_node_key),
        );
      this.#database
        .query("UPDATE thread_nodes SET set_id = ? WHERE account_id = ? AND set_id = ?;")
        .run(winnerId, accountId, loserId);
      this.#database
        .query("UPDATE thread_equivalences SET set_id = ? WHERE account_id = ? AND set_id = ?;")
        .run(winnerId, accountId, loserId);
      this.#database
        .query("UPDATE thread_edges SET set_id = ? WHERE account_id = ? AND set_id = ?;")
        .run(winnerId, accountId, loserId);
      this.#database
        .query("UPDATE thread_memberships SET set_id = ? WHERE account_id = ? AND set_id = ?;")
        .run(winnerId, accountId, loserId);
      this.mergeParticipants(accountId, loserId, winnerId);
      this.#database
        .query("UPDATE thread_handles SET set_id = ? WHERE account_id = ? AND set_id = ?;")
        .run(winnerId, accountId, loserId);
      this.#database
        .query("DELETE FROM thread_sets WHERE account_id = ? AND set_id = ?;")
        .run(accountId, loserId);
    }
    return winnerId as ThreadSetId;
  }

  private mergeParticipants(accountId: AccountId, loserId: string, winnerId: string): void {
    this.#database
      .query(
        "INSERT INTO thread_participants (account_id, set_id, normalized_address, display_name, first_sent_at_missing_rank, first_sent_at, first_message_id, first_role_rank, first_position) SELECT account_id, ?, normalized_address, display_name, first_sent_at_missing_rank, first_sent_at, first_message_id, first_role_rank, first_position FROM thread_participants WHERE account_id = ? AND set_id = ? ON CONFLICT(account_id, set_id, normalized_address) DO UPDATE SET display_name = CASE WHEN excluded.first_sent_at_missing_rank < thread_participants.first_sent_at_missing_rank OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') < coalesce(thread_participants.first_sent_at, '')) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id < thread_participants.first_message_id) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank < thread_participants.first_role_rank) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank = thread_participants.first_role_rank AND excluded.first_position < thread_participants.first_position) THEN excluded.display_name ELSE thread_participants.display_name END, first_sent_at_missing_rank = CASE WHEN excluded.first_sent_at_missing_rank < thread_participants.first_sent_at_missing_rank OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') < coalesce(thread_participants.first_sent_at, '')) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id < thread_participants.first_message_id) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank < thread_participants.first_role_rank) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank = thread_participants.first_role_rank AND excluded.first_position < thread_participants.first_position) THEN excluded.first_sent_at_missing_rank ELSE thread_participants.first_sent_at_missing_rank END, first_sent_at = CASE WHEN excluded.first_sent_at_missing_rank < thread_participants.first_sent_at_missing_rank OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') < coalesce(thread_participants.first_sent_at, '')) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id < thread_participants.first_message_id) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank < thread_participants.first_role_rank) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank = thread_participants.first_role_rank AND excluded.first_position < thread_participants.first_position) THEN excluded.first_sent_at ELSE thread_participants.first_sent_at END, first_message_id = CASE WHEN excluded.first_sent_at_missing_rank < thread_participants.first_sent_at_missing_rank OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') < coalesce(thread_participants.first_sent_at, '')) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id < thread_participants.first_message_id) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank < thread_participants.first_role_rank) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank = thread_participants.first_role_rank AND excluded.first_position < thread_participants.first_position) THEN excluded.first_message_id ELSE thread_participants.first_message_id END, first_role_rank = CASE WHEN excluded.first_sent_at_missing_rank < thread_participants.first_sent_at_missing_rank OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') < coalesce(thread_participants.first_sent_at, '')) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id < thread_participants.first_message_id) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank < thread_participants.first_role_rank) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank = thread_participants.first_role_rank AND excluded.first_position < thread_participants.first_position) THEN excluded.first_role_rank ELSE thread_participants.first_role_rank END, first_position = CASE WHEN excluded.first_sent_at_missing_rank < thread_participants.first_sent_at_missing_rank OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') < coalesce(thread_participants.first_sent_at, '')) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id < thread_participants.first_message_id) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank < thread_participants.first_role_rank) OR (excluded.first_sent_at_missing_rank = thread_participants.first_sent_at_missing_rank AND coalesce(excluded.first_sent_at, '') = coalesce(thread_participants.first_sent_at, '') AND excluded.first_message_id = thread_participants.first_message_id AND excluded.first_role_rank = thread_participants.first_role_rank AND excluded.first_position < thread_participants.first_position) THEN excluded.first_position ELSE thread_participants.first_position END;",
      )
      .run(winnerId, accountId, loserId);
    this.#database
      .query(
        "UPDATE thread_participants AS winner SET display_name = (SELECT loser.display_name FROM thread_participants AS loser WHERE loser.account_id = winner.account_id AND loser.set_id = ? AND loser.normalized_address = winner.normalized_address) WHERE winner.account_id = ? AND winner.set_id = ? AND winner.display_name IS NULL AND EXISTS (SELECT 1 FROM thread_participants AS loser WHERE loser.account_id = winner.account_id AND loser.set_id = ? AND loser.normalized_address = winner.normalized_address AND loser.display_name IS NOT NULL);",
      )
      .run(loserId, accountId, winnerId, loserId);
    this.#database
      .query("DELETE FROM thread_participants WHERE account_id = ? AND set_id = ?;")
      .run(accountId, loserId);
  }

  private upsertFacts(facts: ThreadNormalizedFacts): void {
    this.#database
      .query(
        "INSERT INTO thread_header_facts (account_id, message_id, content_state, normalizer_version, member_node_key, message_id_node_key, references_json, in_reply_to_json, sent_at, received_at, diagnostics_json, facts_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, message_id) DO UPDATE SET content_state = excluded.content_state, normalizer_version = excluded.normalizer_version, member_node_key = excluded.member_node_key, message_id_node_key = excluded.message_id_node_key, references_json = excluded.references_json, in_reply_to_json = excluded.in_reply_to_json, sent_at = excluded.sent_at, received_at = excluded.received_at, diagnostics_json = excluded.diagnostics_json, facts_sha256 = excluded.facts_sha256;",
      )
      .run(
        facts.accountId,
        facts.messageId,
        facts.contentState,
        THREAD_NORMALIZER_VERSION,
        facts.memberNodeKey,
        facts.messageIdNodeKey,
        JSON.stringify(facts.references),
        JSON.stringify(facts.inReplyTo),
        facts.sentAt,
        facts.receivedAt,
        JSON.stringify(facts.diagnostics),
        facts.factsSha256,
      );
    const node = this.readNode(facts.accountId, facts.memberNodeKey);
    if (node === undefined)
      throw new ThreadGraphError("invariant", "thread member node is missing");
    this.#database
      .query(
        "INSERT INTO thread_equivalences (account_id, member_node_key, set_id, message_id_node_key, message_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, member_node_key) DO UPDATE SET set_id = excluded.set_id, message_id_node_key = excluded.message_id_node_key, message_id = excluded.message_id;",
      )
      .run(
        facts.accountId,
        facts.memberNodeKey,
        node.setId,
        facts.messageIdNodeKey,
        facts.messageId,
      );
  }

  private upsertMembership(
    facts: ThreadNormalizedFacts,
    setId: ThreadSetId,
    generation: number,
  ): void {
    const current = this.#database
      .query<MembershipRow, [string, string]>(
        "SELECT * FROM thread_memberships WHERE account_id = ? AND message_id = ?;",
      )
      .get(facts.accountId, facts.messageId);
    const receivedAt =
      facts.receivedAt ??
      (current === null || current.received_at === null
        ? null
        : parseUtcInstant(current.received_at));
    if (current === null) {
      this.#database
        .query(
          "INSERT INTO thread_memberships (account_id, message_id, set_id, member_node_key, order_state, sent_at, sent_at_missing_rank, received_at, added_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
        )
        .run(
          facts.accountId,
          facts.messageId,
          setId,
          facts.memberNodeKey,
          facts.contentState,
          facts.sentAt,
          facts.sentAt === null ? 1 : 0,
          receivedAt,
          generation,
        );
      return;
    }
    if (facts.contentState === "parsed" && current.order_state === "identity-only") {
      this.#database
        .query(
          "UPDATE thread_memberships SET set_id = ?, order_state = 'parsed', sent_at = ?, sent_at_missing_rank = ?, received_at = ? WHERE account_id = ? AND message_id = ?;",
        )
        .run(
          setId,
          facts.sentAt,
          facts.sentAt === null ? 1 : 0,
          receivedAt,
          facts.accountId,
          facts.messageId,
        );
    } else if (receivedAt !== null) {
      this.#database
        .query(
          "UPDATE thread_memberships SET set_id = ?, received_at = CASE WHEN received_at IS NULL OR received_at > ? THEN ? ELSE received_at END WHERE account_id = ? AND message_id = ?;",
        )
        .run(setId, receivedAt, receivedAt, facts.accountId, facts.messageId);
    } else {
      this.#database
        .query("UPDATE thread_memberships SET set_id = ? WHERE account_id = ? AND message_id = ?;")
        .run(setId, facts.accountId, facts.messageId);
    }
  }

  private refreshReceivedAtFromPlacements(
    accountId: AccountId,
    messageId: MessageId,
    fallback: UtcInstant | null,
  ): void {
    if (!this.hasColumn("remote_placements", "internal_date")) return;
    const row = this.#database
      .query<Readonly<{ received_at: unknown }>, [string, string]>(
        "SELECT MIN(internal_date) AS received_at FROM remote_placements WHERE account_id = ? AND message_id = ? AND internal_date IS NOT NULL;",
      )
      .get(accountId, messageId);
    if (row === null || (row.received_at === null && fallback === null)) return;
    const receivedAt = row.received_at === null ? fallback : parseUtcInstant(row.received_at);
    if (receivedAt === null) return;
    this.#database
      .query(
        "UPDATE thread_memberships SET received_at = CASE WHEN received_at IS NULL OR received_at > ? THEN ? ELSE received_at END WHERE account_id = ? AND message_id = ?;",
      )
      .run(receivedAt, receivedAt, accountId, messageId);
  }

  private upsertParticipants(facts: ThreadNormalizedFacts, setId: ThreadSetId): void {
    if (facts.participantsTruncated) {
      this.#database
        .query(
          "UPDATE thread_sets SET participants_truncated = 1 WHERE account_id = ? AND set_id = ?;",
        )
        .run(facts.accountId, setId);
    }
    for (const [index, participant] of facts.participants.entries()) {
      const roleRank =
        participant.role === "from"
          ? 0
          : participant.role === "sender"
            ? 1
            : participant.role === "to"
              ? 2
              : 3;
      const position = participant.position ?? index + 1;
      const existing = this.#database
        .query<
          Readonly<{
            first_sent_at_missing_rank: unknown;
            first_sent_at: unknown;
            first_message_id: unknown;
            first_role_rank: unknown;
            first_position: unknown;
            display_name: unknown;
          }>,
          [string, string, string]
        >(
          "SELECT first_sent_at_missing_rank, first_sent_at, first_message_id, first_role_rank, first_position, display_name FROM thread_participants WHERE account_id = ? AND set_id = ? AND normalized_address = ?;",
        )
        .get(facts.accountId, setId, participant.address);
      const candidate = {
        missing: facts.sentAt === null ? 1 : 0,
        sentAt: facts.sentAt,
        messageId: facts.messageId,
        roleRank,
        position,
      };
      if (existing === null || compareParticipant(candidate, existing) < 0) {
        this.#database
          .query(
            "INSERT INTO thread_participants (account_id, set_id, normalized_address, display_name, first_sent_at_missing_rank, first_sent_at, first_message_id, first_role_rank, first_position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, set_id, normalized_address) DO UPDATE SET display_name = excluded.display_name, first_sent_at_missing_rank = excluded.first_sent_at_missing_rank, first_sent_at = excluded.first_sent_at, first_message_id = excluded.first_message_id, first_role_rank = excluded.first_role_rank, first_position = excluded.first_position;",
          )
          .run(
            facts.accountId,
            setId,
            participant.address,
            participant.displayName ?? null,
            candidate.missing,
            candidate.sentAt,
            candidate.messageId,
            candidate.roleRank,
            candidate.position,
          );
      } else if (
        existing.display_name === null &&
        participant.displayName !== undefined &&
        participant.displayName !== null
      ) {
        this.#database
          .query(
            "UPDATE thread_participants SET display_name = ? WHERE account_id = ? AND set_id = ? AND normalized_address = ? AND display_name IS NULL;",
          )
          .run(participant.displayName, facts.accountId, setId, participant.address);
      }
    }
  }

  private recomputeSet(
    accountId: AccountId,
    setId: ThreadSetId,
    generation: number,
    bridgeMessageId: MessageId,
  ): readonly ThreadId[] {
    const set = this.readSet(accountId, setId);
    if (set === undefined) throw new ThreadGraphError("invariant", "thread set disappeared");
    const oldHandles = this.#database
      .query<HandleRow, [string, string]>(
        "SELECT thread_id, set_id, canonical_when_created FROM thread_handles WHERE account_id = ? AND set_id = ? ORDER BY thread_id;",
      )
      .all(accountId, setId)
      .map(decodeHandleRow);
    const root = this.computeRoot(accountId, setId);
    const canonicalThreadId = deriveThreadId(accountId, root);
    this.#database
      .query(
        "UPDATE thread_sets SET canonical_root_node_key = ?, canonical_thread_id = ?, updated_generation = ? WHERE account_id = ? AND set_id = ?;",
      )
      .run(root, canonicalThreadId, generation, accountId, setId);
    const previousCanonical = valueString(set.canonical_thread_id);
    if (
      this.#database
        .query("SELECT 1 AS present FROM thread_handles WHERE thread_id = ?;")
        .get(canonicalThreadId) === null
    ) {
      this.#database
        .query(
          "INSERT INTO thread_handles (thread_id, account_id, set_id, created_generation, canonical_when_created) VALUES (?, ?, ?, ?, 1);",
        )
        .run(canonicalThreadId, accountId, setId, generation);
    }
    const aliases: ThreadId[] = [];
    for (const handle of oldHandles) {
      if (handle.threadId === canonicalThreadId) continue;
      aliases.push(handle.threadId);
      const pendingMerge = this.#pendingMergeRoots.has(
        `${accountId}\0${setId}\0${handle.threadId}`,
      );
      const lateRootPromotion = handle.threadId === previousCanonical;
      if (pendingMerge || lateRootPromotion) {
        const previousRoot =
          this.#pendingMergeRoots.get(`${accountId}\0${setId}\0${handle.threadId}`) ??
          valueString(set.canonical_root_node_key);
        this.#database
          .query(
            "INSERT OR IGNORE INTO thread_merges (account_id, losing_thread_id, merge_generation, winning_thread_id, bridge_message_id, previous_root_node_key, current_root_node_key) VALUES (?, ?, ?, ?, ?, ?, ?);",
          )
          .run(
            accountId,
            handle.threadId,
            generation,
            canonicalThreadId,
            bridgeMessageId,
            previousRoot,
            root,
          );
        this.#pendingMergeRoots.delete(`${accountId}\0${setId}\0${handle.threadId}`);
      }
    }
    this.refreshCounts(accountId, setId, generation, canonicalThreadId, root);
    return Object.freeze(aliases);
  }

  private refreshCounts(
    accountId: AccountId,
    setId: ThreadSetId,
    generation: number,
    canonicalThreadId: ThreadId,
    root: string,
  ): void {
    this.#database
      .query(
        "UPDATE thread_nodes SET incoming_ancestry_count = (SELECT count(*) FROM thread_edges AS e WHERE e.account_id = thread_nodes.account_id AND e.set_id = thread_nodes.set_id AND e.target_class_key = thread_nodes.class_key AND e.source_class_key <> e.target_class_key) WHERE account_id = ? AND set_id = ?;",
      )
      .run(accountId, setId);
    this.#database
      .query(
        "UPDATE thread_sets SET member_count = (SELECT count(*) FROM thread_memberships WHERE account_id = ? AND set_id = ?), node_count = (SELECT count(*) FROM thread_nodes WHERE account_id = ? AND set_id = ?), equivalence_count = (SELECT count(*) FROM thread_equivalences WHERE account_id = ? AND set_id = ?), edge_count = (SELECT count(*) FROM thread_edges WHERE account_id = ? AND set_id = ?), participant_count = (SELECT count(*) FROM thread_participants WHERE account_id = ? AND set_id = ?), handle_count = (SELECT count(*) FROM thread_handles WHERE account_id = ? AND set_id = ?), canonical_root_node_key = ?, canonical_thread_id = ?, updated_generation = ? WHERE account_id = ? AND set_id = ?;",
      )
      .run(
        accountId,
        setId,
        accountId,
        setId,
        accountId,
        setId,
        accountId,
        setId,
        accountId,
        setId,
        accountId,
        setId,
        root,
        canonicalThreadId,
        generation,
        accountId,
        setId,
      );
  }

  private computeRoot(accountId: AccountId, setId: ThreadSetId): string {
    const root = this.#database
      .query<Readonly<{ class_key: unknown }>, [string, string, string, string]>(
        "SELECT MIN(nodes.class_key) AS class_key FROM (SELECT DISTINCT class_key FROM thread_nodes WHERE account_id = ? AND set_id = ?) AS nodes WHERE NOT EXISTS (SELECT 1 FROM thread_edges AS edges WHERE edges.account_id = ? AND edges.set_id = ? AND edges.source_class_key <> edges.target_class_key AND edges.target_class_key = nodes.class_key);",
      )
      .get(accountId, setId, accountId, setId);
    if (root !== null && root.class_key !== null) return valueString(root.class_key);
    const fallback = this.#database
      .query<Readonly<{ class_key: unknown }>, [string, string]>(
        "SELECT MIN(class_key) AS class_key FROM thread_nodes WHERE account_id = ? AND set_id = ?;",
      )
      .get(accountId, setId);
    return fallback === null || fallback.class_key === null
      ? "m:" + "0".repeat(64)
      : valueString(fallback.class_key);
  }

  private collectSetIds(
    accountId: AccountId,
    facts: ThreadNormalizedFacts,
    existing: StoredFactRow,
  ): readonly string[] {
    const keys = [
      facts.memberNodeKey,
      facts.messageIdNodeKey,
      ...facts.references.map(messageIdNodeKey),
      ...facts.inReplyTo.map(messageIdNodeKey),
      valueString(existing.member_node_key),
      existing.message_id_node_key === null ? null : valueString(existing.message_id_node_key),
    ].filter((value): value is string => value !== null);
    return this.readSetIdsForNodes(accountId, new Set(keys));
  }

  private readSetIdsForNodes(accountId: AccountId, keys: ReadonlySet<string>): readonly string[] {
    const result = new Set<string>();
    for (const key of keys) {
      const row = this.readNode(accountId, key);
      if (row !== undefined) result.add(row.setId);
    }
    return [...result];
  }

  private readNode(
    accountId: AccountId,
    nodeKey: string,
  ): Readonly<{ nodeKey: string; setId: ThreadSetId; classKey: string }> | undefined {
    const row = this.#database
      .query<NodeRow, [string, string]>(
        "SELECT node_key, set_id, class_key FROM thread_nodes WHERE account_id = ? AND node_key = ?;",
      )
      .get(accountId, nodeKey);
    if (row === null) return undefined;
    const node = valueString(row.node_key);
    const setId = valueString(row.set_id) as ThreadSetId;
    const classKey = valueString(row.class_key);
    if (!NODE_PATTERN.test(node) || !NODE_PATTERN.test(classKey))
      throw new ThreadGraphError("invariant", "thread node row is invalid");
    return Object.freeze({ nodeKey: node, setId, classKey });
  }

  private readSet(accountId: AccountId, setId: string): SetRow | undefined {
    const row = this.#database
      .query<SetRow, [string, string]>(
        "SELECT * FROM thread_sets WHERE account_id = ? AND set_id = ?;",
      )
      .get(accountId, setId);
    return row === null ? undefined : row;
  }

  private resolveForMessage(
    accountId: AccountId,
    messageId: MessageId,
  ): Readonly<{ threadId: ThreadId; aliases: readonly ThreadId[] }> {
    const row = this.#database
      .query<Readonly<{ set_id: unknown }>, [string, string]>(
        "SELECT set_id FROM thread_memberships WHERE account_id = ? AND message_id = ?;",
      )
      .get(accountId, messageId);
    if (row === null) throw new ThreadGraphError("invariant", "thread membership is missing");
    const setId = valueString(row.set_id);
    const set = this.readSet(accountId, setId);
    if (set === undefined) throw new ThreadGraphError("invariant", "thread set is missing");
    const handles = this.#database
      .query<Readonly<{ thread_id: unknown; canonical_when_created: unknown }>, [string, string]>(
        "SELECT thread_id, canonical_when_created FROM thread_handles WHERE account_id = ? AND set_id = ? ORDER BY thread_id;",
      )
      .all(accountId, setId);
    return {
      threadId: createThreadId(valueString(set.canonical_thread_id)),
      aliases: Object.freeze(
        handles
          .filter((handle) => handle.thread_id !== set.canonical_thread_id)
          .map((handle) => parseThreadHandle(handle.thread_id)),
      ),
    };
  }

  private readFirstMembers(
    accountId: AccountId,
    setId: ThreadSetId,
    limit: number,
  ): readonly MembershipRow[] {
    return this.#database
      .query<MembershipRow, [string, string, number]>(
        "SELECT message_id, set_id, member_node_key, order_state, sent_at, sent_at_missing_rank, received_at FROM thread_memberships WHERE account_id = ? AND set_id = ? ORDER BY sent_at_missing_rank ASC, sent_at ASC, message_id ASC LIMIT ?;",
      )
      .all(accountId, setId, limit + 1);
  }

  private readAfterMembers(
    accountId: AccountId,
    setId: ThreadSetId,
    cursor: ThreadCursorPayload,
    limit: number,
  ): readonly MembershipRow[] {
    return this.#database
      .query<
        MembershipRow,
        [string, string, number, number, string, number, string | null, string, number]
      >(
        "SELECT message_id, set_id, member_node_key, order_state, sent_at, sent_at_missing_rank, received_at FROM thread_memberships WHERE account_id = ? AND set_id = ? AND (sent_at_missing_rank > ? OR (sent_at_missing_rank = ? AND sent_at > ?) OR (sent_at_missing_rank = ? AND sent_at IS ? AND message_id > ?)) ORDER BY sent_at_missing_rank ASC, sent_at ASC, message_id ASC LIMIT ?;",
      )
      .all(
        accountId,
        setId,
        cursor.lastSentAtMissingRank,
        cursor.lastSentAtMissingRank,
        cursor.lastSentAt ?? "",
        cursor.lastSentAtMissingRank,
        cursor.lastSentAt,
        cursor.lastMessageId,
        limit + 1,
      );
  }

  private hydratePage(
    accountId: AccountId,
    requested: ThreadId,
    resolved: Readonly<{ threadId: ThreadId; setId: ThreadSetId; canonical: boolean }>,
    members: readonly MembershipRow[],
    hasMore: boolean,
    isContinuation: boolean,
  ): ThreadPage {
    const set = this.readSet(accountId, resolved.setId);
    if (set === undefined) throw new ThreadGraphError("invariant", "thread set is missing");
    if (members.length === 0) {
      if (!isContinuation || decodeNumber(set.member_count) === 0)
        throw new ThreadGraphError(
          "invariant",
          isContinuation ? "known thread has no members" : "known thread initial page is empty",
        );
    }
    const messages = members.map((row) => this.hydrateMessage(accountId, resolved.threadId, row));
    const participants = this.#database
      .query<
        Readonly<{ normalized_address: unknown; display_name: unknown }>,
        [string, string, number]
      >(
        "SELECT normalized_address, display_name FROM thread_participants WHERE account_id = ? AND set_id = ? ORDER BY first_sent_at_missing_rank, first_sent_at, first_message_id, first_role_rank, first_position LIMIT ?;",
      )
      .all(accountId, resolved.setId, THREAD_LIMITS.participantMaximum + 1);
    const participantValues = participants.slice(0, THREAD_LIMITS.participantMaximum).map((row) =>
      Object.freeze({
        address: valueString(row.normalized_address),
        displayName: row.display_name === null ? null : valueString(row.display_name),
      }),
    );
    const receivedAt = this.receivedAtExpression(accountId, "m");
    const first = this.#database
      .query<Readonly<{ received_at: unknown }>, string[]>(
        `SELECT ${receivedAt.sql} AS received_at FROM thread_memberships AS m WHERE m.account_id = ? AND m.set_id = ? ORDER BY received_at, m.message_id LIMIT 1;`,
      )
      .get(...receivedAt.bindings, accountId, resolved.setId);
    const last = this.#database
      .query<Readonly<{ received_at: unknown }>, string[]>(
        `SELECT ${receivedAt.sql} AS received_at FROM thread_memberships AS m WHERE m.account_id = ? AND m.set_id = ? ORDER BY received_at DESC, m.message_id DESC LIMIT 1;`,
      )
      .get(...receivedAt.bindings, accountId, resolved.setId);
    if (first === null || last === null)
      throw new ThreadGraphError("invariant", "thread received aggregate is missing");
    if (first.received_at === null || last.received_at === null)
      throw new ThreadGraphError("invariant", "thread received aggregate is missing");
    const nextCursor =
      hasMore && members.at(-1) !== undefined && this.#cursorCodec !== undefined
        ? this.#cursorCodec.encode({
            accountId,
            requestedThreadHandle: requested,
            tuple: tupleFromMembership(members.at(-1)),
          })
        : null;
    const subject = this.readSubject(accountId, resolved.setId);
    return Object.freeze({
      threadId: resolved.threadId,
      resolvedFromThreadId: resolved.canonical ? null : requested,
      subject,
      participants: Object.freeze(participantValues),
      participantsTruncated:
        decodeNumber(set.participants_truncated) !== 0 ||
        participants.length > THREAD_LIMITS.participantMaximum,
      messageCount: decodeNumber(set.member_count),
      messageIds: Object.freeze(members.map((row) => parseMessageId(row.message_id))),
      messages: Object.freeze(messages),
      firstReceivedAt: parseUtcInstant(first.received_at),
      lastReceivedAt: parseUtcInstant(last.received_at),
      nextCursor,
    });
  }

  private hydrateMessage(
    accountId: AccountId,
    threadId: ThreadId,
    row: MembershipRow,
  ): ThreadMessage {
    const messageId = parseMessageId(row.message_id);
    const subject = this.hasTable("message_headers")
      ? this.#database
          .query<Readonly<{ value: unknown }>, [string]>(
            "SELECT value FROM message_headers WHERE message_id = ? AND normalized_name = 'subject' ORDER BY ordinal LIMIT 1;",
          )
          .get(messageId)
      : null;
    const participants = this.hasTable("message_addresses")
      ? this.#database
          .query<
            Readonly<{
              normalized_address: unknown;
              display_name: unknown;
              role: unknown;
              position: unknown;
            }>,
            [string]
          >(
            "SELECT normalized_address, display_name, role, position FROM message_addresses WHERE message_id = ? AND role IN ('from', 'sender', 'to', 'cc') ORDER BY CASE role WHEN 'from' THEN 0 WHEN 'sender' THEN 1 WHEN 'to' THEN 2 ELSE 3 END, position;",
          )
          .all(messageId)
          .map((item) =>
            Object.freeze({
              address: valueString(item.normalized_address),
              displayName: item.display_name === null ? null : valueString(item.display_name),
              role: roleValue(item.role),
              position: decodeNumber(item.position),
            }),
          )
      : [];
    const unread = !this.hasTable("remote_placements")
      ? null
      : this.hasColumn("remote_placements", "flags_json")
        ? this.#database
            .query<Readonly<{ present: unknown }>, [string, string]>(
              "SELECT 1 AS present FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(flags_json) WHERE value = char(92) || 'Seen') LIMIT 1;",
            )
            .get(accountId, messageId)
        : this.#database
            .query<Readonly<{ present: unknown }>, [string, string]>(
              "SELECT 1 AS present FROM remote_placements WHERE account_id = ? AND message_id = ? AND tombstone_observed_at IS NULL LIMIT 1;",
            )
            .get(accountId, messageId);
    const attachment = this.hasTable("message_attachments")
      ? this.#database
          .query("SELECT 1 AS present FROM message_attachments WHERE message_id = ? LIMIT 1;")
          .get(messageId)
      : null;
    const content = this.#database
      .query<Readonly<{ content_state: unknown }>, [string, string]>(
        "SELECT content_state FROM thread_header_facts WHERE account_id = ? AND message_id = ?;",
      )
      .get(accountId, messageId);
    return Object.freeze({
      messageId,
      threadId,
      sentAt: row.sent_at === null ? null : parseUtcInstant(row.sent_at),
      receivedAt: this.readReceivedAt(accountId, messageId),
      subject: subject === null ? null : valueString(subject.value),
      participants,
      isUnread: unread !== null,
      hasAttachment: attachment !== null,
      contentAvailable: content === null || content.content_state === "parsed",
    });
  }

  private readSubject(accountId: AccountId, setId: ThreadSetId): string | null {
    if (!this.hasTable("message_headers")) return null;
    const row = this.#database
      .query<Readonly<{ value: unknown }>, [string, string]>(
        "SELECT h.value FROM thread_memberships AS m JOIN message_headers AS h ON h.message_id = m.message_id WHERE m.account_id = ? AND m.set_id = ? AND h.normalized_name = 'subject' ORDER BY m.sent_at_missing_rank, m.sent_at, m.message_id, h.ordinal LIMIT 1;",
      )
      .get(accountId, setId);
    return row === null ? null : valueString(row.value);
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.#database
      .query<Readonly<{ name: unknown }>, []>(`PRAGMA table_info(${table});`)
      .all();
    return rows.some((row) => row.name === column);
  }

  private hasTable(table: string): boolean {
    return (
      this.#database
        .query<Readonly<{ present: unknown }>, [string]>(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?;",
        )
        .get(table) !== null
    );
  }

  private readReceivedAt(accountId: AccountId, messageId: MessageId): UtcInstant {
    const expression = this.receivedAtExpression(accountId, "m");
    const row = this.#database
      .query<Readonly<{ received_at: unknown }>, string[]>(
        `SELECT ${expression.sql} AS received_at FROM thread_memberships AS m WHERE m.account_id = ? AND m.message_id = ?;`,
      )
      .get(...expression.bindings, accountId, messageId);
    if (row === null || row.received_at === null)
      throw new ThreadGraphError("invariant", "thread message received instant is missing");
    return parseUtcInstant(row.received_at);
  }

  private receivedAtExpression(
    accountId: AccountId,
    alias: string,
  ): Readonly<{ readonly sql: string; readonly bindings: readonly AccountId[] }> {
    let sql = `${alias}.received_at`;
    const bindings: AccountId[] = [];
    if (this.hasColumn("remote_placements", "internal_date")) {
      sql = `COALESCE((SELECT MIN(rp.internal_date) FROM remote_placements AS rp WHERE rp.account_id = ? AND rp.message_id = ${alias}.message_id AND rp.internal_date IS NOT NULL), ${sql})`;
      bindings.push(accountId);
    }
    if (this.hasColumn("message_content_states", "observed_at")) {
      sql = `COALESCE(${sql}, (SELECT cs.observed_at FROM message_content_states AS cs WHERE cs.account_id = ? AND cs.message_id = ${alias}.message_id))`;
      bindings.push(accountId);
    }
    return Object.freeze({ sql, bindings: Object.freeze(bindings) });
  }

  private decodeCursor(
    value: unknown,
    accountId: AccountId,
    requested: ThreadId,
  ): ThreadCursorPayload {
    if (this.#cursorCodec === undefined)
      throw new ThreadGraphError("invalid_cursor", "thread cursor is not configured");
    try {
      return this.#cursorCodec.decode(value, { accountId, requestedThreadHandle: requested });
    } catch (error: unknown) {
      throw new ThreadGraphError("invalid_cursor", "thread cursor is invalid", { cause: error });
    }
  }
}

export const ThreadRepository = ThreadGraphRepository;
export const createThreadGraphRepository = (
  database: Database,
  options: ThreadGraphRepositoryOptions = {},
): ThreadGraphRepository => new ThreadGraphRepository(database, options);

function isNormalizedFacts(
  value: ThreadNormalizationInput | ThreadNormalizedFacts,
): value is ThreadNormalizedFacts {
  return (
    typeof value === "object" &&
    value !== null &&
    "factsSha256" in value &&
    typeof value.factsSha256 === "string" &&
    "memberNodeKey" in value
  );
}

function validateFacts(facts: ThreadNormalizedFacts): void {
  if (
    !/^account:.+/u.test(facts.accountId) ||
    !/^message:[0-9a-f]{64}$/u.test(facts.messageId) ||
    (facts.contentState !== "identity-only" && facts.contentState !== "parsed") ||
    !NODE_PATTERN.test(facts.memberNodeKey) ||
    facts.memberNodeKey !== memberNodeKey(facts.messageId) ||
    (facts.messageIdNodeKey !== null && !/^i:[0-9a-f]{64}$/u.test(facts.messageIdNodeKey)) ||
    !Array.isArray(facts.references) ||
    !Array.isArray(facts.inReplyTo) ||
    facts.references.length > THREAD_LIMITS.referencesTokens ||
    facts.inReplyTo.length > THREAD_LIMITS.inReplyToTokens ||
    !Array.isArray(facts.diagnostics) ||
    facts.diagnostics.length > THREAD_LIMITS.diagnosticsPerMessage ||
    !Array.isArray(facts.participants) ||
    facts.participants.length > THREAD_LIMITS.participantMaximum ||
    typeof facts.participantsTruncated !== "boolean" ||
    typeof facts.factsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(facts.factsSha256) ||
    facts.references.some((value) => !isNormalizedMessageId(value)) ||
    facts.inReplyTo.some((value) => !isNormalizedMessageId(value))
  )
    throw new ThreadGraphError("invalid-input", "thread facts are outside the accepted bounds");
}

function isNormalizedMessageId(value: unknown): value is NormalizedMessageId {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC"))
    return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const left = value.slice(0, at);
  const right = value.slice(at + 1);
  return (
    isNormalizedDotAtom(left) &&
    (isNormalizedDomainLiteral(right) || (isNormalizedDotAtom(right) && !/[A-Z]/u.test(right)))
  );
}

function isNormalizedDotAtom(value: string): boolean {
  if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
  return value.split(".").every(
    (part) =>
      part.length > 0 &&
      everyCharacter(part, (character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined &&
          (codePoint >= 0x80 || /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/u.test(character)) &&
          !/[\s\p{M}\p{Cc}\p{Cf}\p{Cs}]/u.test(character) &&
          !isNonCharacter(codePoint)
        );
      }),
  );
}

function isNormalizedDomainLiteral(value: string): boolean {
  if (!value.startsWith("[") || !value.endsWith("]") || value.length < 3) return false;
  return everyCharacter(value.slice(1, -1), (character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint >= 0x80 || /^[\x21-\x5a\x5e-\x7e]$/u.test(character)) &&
      character !== "\\" &&
      character !== "[" &&
      character !== "]" &&
      !/[\s\p{M}\p{Cc}\p{Cf}\p{Cs}]/u.test(character) &&
      !isNonCharacter(codePoint)
    );
  });
}

function everyCharacter(value: string, predicate: (character: string) => boolean): boolean {
  for (const character of value) if (!predicate(character)) return false;
  return true;
}

function isNonCharacter(codePoint: number): boolean {
  return (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe;
}

function parseAccount(value: unknown): AccountId {
  try {
    return parseAccountId(value);
  } catch (error: unknown) {
    throw new ThreadGraphError("invalid-input", "thread account is invalid", { cause: error });
  }
}

function parseThreadHandle(value: unknown): ThreadId {
  try {
    const threadId = parseThreadId(value);
    if (!THREAD_ID_PATTERN.test(threadId)) throw new TypeError("thread handle is invalid");
    return threadId;
  } catch (error: unknown) {
    throw new ThreadGraphError("invalid-input", "thread handle is invalid", { cause: error });
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null) return THREAD_LIMITS.pageDefault;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > THREAD_LIMITS.pageMaximum
  )
    throw new ThreadGraphError("invalid-input", "thread page limit is invalid");
  return value;
}

function readGeneration(database: Database): number {
  const row: unknown = database
    .query("SELECT generation FROM thread_generation WHERE generation_id = 1;")
    .get();
  if (!isRecord(row)) throw new ThreadGraphError("invariant", "thread generation row is invalid");
  const generation = row.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
    throw new ThreadGraphError("invariant", "thread generation row is invalid");
  return generation;
}

function decodeSet(row: SetRow): Readonly<{
  setId: ThreadSetId;
  canonicalRootNodeKey: `i:${string}` | `m:${string}`;
  canonicalThreadId: ThreadId;
  memberCount: number;
}> {
  const setId = valueString(row.set_id) as ThreadSetId;
  const root = valueString(row.canonical_root_node_key);
  assertNodeKey(root);
  return {
    setId,
    canonicalRootNodeKey: root,
    canonicalThreadId: parseThreadHandle(row.canonical_thread_id),
    memberCount: decodeNumber(row.member_count),
  };
}

function decodeHandleRow(
  row: HandleRow,
): Readonly<{ threadId: ThreadId; canonicalWhenCreated: boolean }> {
  return {
    threadId: parseThreadHandle(row.thread_id),
    canonicalWhenCreated: row.canonical_when_created === 1,
  };
}

function decodeFacts(
  row: StoredFactRow,
): Readonly<{ factsSha256: string; contentState: "identity-only" | "parsed" }> {
  if (
    (row.content_state !== "identity-only" && row.content_state !== "parsed") ||
    row.normalizer_version !== THREAD_NORMALIZER_VERSION ||
    typeof row.facts_sha256 !== "string"
  )
    throw new ThreadGraphError("invariant", "thread fact row is invalid");
  return { factsSha256: row.facts_sha256, contentState: row.content_state };
}

function isMonotonicRecovery(
  old: Readonly<{ factsSha256: string; contentState: "identity-only" | "parsed" }>,
  next: ThreadNormalizedFacts,
): boolean {
  return old.contentState === "identity-only" && next.contentState === "parsed";
}

function edgePairsForFacts(facts: ThreadNormalizedFacts): readonly Readonly<{
  source: string;
  target: string;
  field: "references" | "in-reply-to";
  ordinal: number;
}>[] {
  const result: Readonly<{
    source: string;
    target: string;
    field: "references" | "in-reply-to";
    ordinal: number;
  }>[] = [];
  const anchor = facts.messageIdNodeKey ?? facts.memberNodeKey;
  for (let index = 0; index + 1 < facts.references.length; index += 1)
    result.push({
      source: messageIdNodeKey(facts.references[index]),
      target: messageIdNodeKey(facts.references[index + 1]),
      field: "references",
      ordinal: index + 1,
    });
  const lastReference = facts.references.at(-1);
  if (lastReference !== undefined)
    result.push({
      source: messageIdNodeKey(lastReference),
      target: anchor,
      field: "references",
      ordinal: facts.references.length,
    });
  for (const [index, token] of facts.inReplyTo.entries())
    result.push({
      source: messageIdNodeKey(token),
      target: anchor,
      field: "in-reply-to",
      ordinal: index + 1,
    });
  const seen = new Set<string>();
  return result.filter((edge) => {
    const key = `${edge.source}\0${edge.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function messageIdNodeKey(value: NormalizedMessageId): `i:${string}` {
  return `i:${createHash("sha256").update("thread-msgid-v1\0", "utf8").update(value, "utf8").digest("hex")}`;
}

function deriveThreadId(accountId: AccountId, rootNodeKey: string): ThreadId {
  return createThreadId(
    `thread:${createHash("sha256").update("agent-mail-thread-v1\0", "utf8").update(accountId, "utf8").update("\0", "utf8").update(rootNodeKey, "utf8").digest("hex")}`,
  );
}

function setWeight(row: SetRow): number {
  return (
    decodeNumber(row.member_count) +
    decodeNumber(row.node_count) +
    decodeNumber(row.equivalence_count) +
    decodeNumber(row.edge_count) +
    decodeNumber(row.participant_count) +
    decodeNumber(row.handle_count)
  );
}

function tupleFromMembership(row: MembershipRow | undefined): ThreadCursorTuple {
  if (row === undefined) throw new ThreadGraphError("invariant", "page cursor member is missing");
  const rank = row.sent_at_missing_rank;
  if (rank !== 0 && rank !== 1)
    throw new ThreadGraphError("invariant", "page cursor rank is invalid");
  const sentAt = row.sent_at === null ? null : parseUtcInstant(row.sent_at);
  return { sentAtMissingRank: rank, sentAt, messageId: parseMessageId(row.message_id) };
}

function compareParticipant(
  candidate: Readonly<{
    missing: number;
    sentAt: UtcInstant | null;
    messageId: MessageId;
    roleRank: number;
    position: number;
  }>,
  existing: Readonly<{
    first_sent_at_missing_rank: unknown;
    first_sent_at: unknown;
    first_message_id: unknown;
    first_role_rank: unknown;
    first_position: unknown;
  }>,
): number {
  const values: readonly [number, string, string, number, number][] = [
    [
      candidate.missing,
      candidate.sentAt ?? "",
      candidate.messageId,
      candidate.roleRank,
      candidate.position,
    ],
    [
      decodeNumber(existing.first_sent_at_missing_rank),
      typeof existing.first_sent_at === "string" ? existing.first_sent_at : "",
      valueString(existing.first_message_id),
      decodeNumber(existing.first_role_rank),
      decodeNumber(existing.first_position),
    ],
  ];
  for (let index = 0; index < 5; index += 1) {
    const left = values[0][index];
    const right = values[1][index];
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

function parseDiagnostics(value: unknown): ThreadDiagnostic[] {
  if (typeof value !== "string")
    throw new ThreadGraphError("invariant", "thread diagnostics are invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new ThreadGraphError("invariant", "thread diagnostics are invalid", { cause: error });
  }
  if (!Array.isArray(parsed))
    throw new ThreadGraphError("invariant", "thread diagnostics are invalid");
  return parsed.filter(isDiagnostic).slice(0, THREAD_LIMITS.diagnosticsPerMessage);
}

function isDiagnostic(value: unknown): value is ThreadDiagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "field" in value &&
    (value.field === "message-id" ||
      value.field === "references" ||
      value.field === "in-reply-to") &&
    "code" in value &&
    typeof value.code === "string" &&
    "ordinal" in value &&
    (value.ordinal === null || typeof value.ordinal === "number")
  );
}

function roleValue(value: unknown): "from" | "sender" | "to" | "cc" {
  if (value === "from" || value === "sender" || value === "to" || value === "cc") return value;
  throw new ThreadGraphError("invariant", "thread participant role is invalid");
}

function fieldValue(value: unknown): "references" | "in-reply-to" {
  if (value === "references" || value === "in-reply-to") return value;
  throw new ThreadGraphError("invariant", "thread edge field is invalid");
}

function valueString(value: unknown): string {
  if (typeof value !== "string")
    throw new ThreadGraphError("invariant", "thread row text is invalid");
  return value;
}

function decodeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new ThreadGraphError("invariant", "thread row number is invalid");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rollback(database: Database): void {
  try {
    database.exec("ROLLBACK;");
  } catch {
    // Preserve the original write/read failure.
  }
}
