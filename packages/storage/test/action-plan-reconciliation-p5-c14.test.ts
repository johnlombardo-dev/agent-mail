import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createMonotonicSequence,
  createRemoteAttemptSuccess,
  createRemoteAttemptUncertain,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import {
  createUncertainReconciliationAdapter,
  createUncertainReconciliationObserver,
  IMAP_RECONCILIATION_FETCH_OPTIONS,
  IMAP_RECONCILIATION_FETCH_QUERY,
  IMAP_RECONCILIATION_LOCK_OPTIONS,
  type ImapFlowUncertainReconciliationClient,
} from "../../imap/src/uncertain-reconciliation";
import { applyMigrations, type Migration } from "../src/migration-runner";
import {
  actionAttemptStartMigrations,
  readActionPlanAttempt,
  startActionPlanAttempt,
} from "../src/action-plan-attempt";
import { claimPendingActionPlan } from "../src/action-plan-claim";
import { createPendingActionPlan } from "../src/action-plan-repository";
import {
  actionResultReconciliationMigration,
  recordActionPlanReconciliationResult,
  readActionPlanResult,
} from "../src/action-plan-result";
import {
  actionAttemptDispatchMigrations,
  markActionPlanAttemptDispatched,
  recoverUnresolvedActionPlanAttempt,
} from "../src/action-plan-recovery";
import { operationalJournalMigration } from "../src/migrations/0001-operational-journal";
import {
  reconcileUncertainActionPlanAttempt,
  type UncertainAttemptReadOnlyObserver,
} from "../src/action-plan-reconciliation";

const databases: Database[] = [];
const imapAccountId = createAccountId("one");
const imapSource = {
  accountId: imapAccountId,
  mailboxId: createMailboxId("inbox"),
  path: "INBOX",
  uidValidity: createUidValidity(9),
};
const imapDestinations = {
  moveToArchive: {
    accountId: imapAccountId,
    mailboxId: createMailboxId("archive"),
    path: "Archive",
    uidValidity: createUidValidity(4),
    uid: createRemoteUidValue(18),
  },
  moveToTrash: {
    accountId: imapAccountId,
    mailboxId: createMailboxId("trash"),
    path: "Trash",
    uidValidity: createUidValidity(5),
    uid: createRemoteUidValue(19),
  },
} as const;

type ImapFixture = Readonly<{ readonly mailbox: unknown; readonly message: unknown }>;

class ComposedReadOnlyImapFixture implements ImapFlowUncertainReconciliationClient {
  readonly calls: string[] = [];
  readonly fixtures: Readonly<Record<string, ImapFixture>>;
  mailbox: unknown = null;

  constructor(fixtures: Readonly<Record<string, ImapFixture>>) {
    this.fixtures = fixtures;
  }

  async getMailboxLock(
    path: string,
    options: typeof IMAP_RECONCILIATION_LOCK_OPTIONS,
  ): Promise<unknown> {
    this.calls.push(`lock:${path}`);
    expect(options).toEqual(IMAP_RECONCILIATION_LOCK_OPTIONS);
    const fixture = this.fixtures[path];
    if (fixture === undefined) throw new Error("mailbox unavailable");
    this.mailbox = fixture.mailbox;
    return { release: () => this.calls.push(`release:${path}`) };
  }

  async fetchOne(
    range: string,
    query: typeof IMAP_RECONCILIATION_FETCH_QUERY,
    options: typeof IMAP_RECONCILIATION_FETCH_OPTIONS,
  ): Promise<unknown> {
    this.calls.push(`fetch:${range}`);
    expect(query).toEqual(IMAP_RECONCILIATION_FETCH_QUERY);
    expect(options).toEqual(IMAP_RECONCILIATION_FETCH_OPTIONS);
    if (
      typeof this.mailbox !== "object" ||
      this.mailbox === null ||
      !("path" in this.mailbox) ||
      typeof this.mailbox.path !== "string"
    ) {
      throw new Error("not selected");
    }
    return this.fixtures[this.mailbox.path]?.message ?? false;
  }
}
const target = {
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 9,
  uid: 7,
  precondition: { modseq: 101 },
} as const;
const startedAt = "2026-08-18T01:00:02.000Z";
const resultAt = "2026-08-18T01:00:05.000Z";
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const migrations: readonly Migration[] = [
  ...actionAttemptDispatchMigrations,
  { ...operationalJournalMigration, version: 6 },
  actionResultReconciliationMigration,
];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabase(
  action: "markSeen" | "markUnseen" | "moveToArchive" | "moveToTrash" = "markSeen",
): Database {
  const database = new Database(":memory:");
  databases.push(database);
  applyMigrations(database, migrations);
  createPendingActionPlan(database, {
    planId: "plan:one",
    action: { kind: action },
    targets: [target],
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-19T00:00:00.000Z",
    previewDigest: digest,
    authorizationScope: "mail:action.create",
    idempotencyIdentity: "caller:one",
  });
  expect(claimPendingActionPlan(database, {
    planId: "plan:one",
    claimId: "claim:one",
    startedAt: "2026-08-18T01:00:01.000Z",
    now: "2026-08-18T01:00:00.000Z",
    digest,
    authorizationScope: "mail:action.create",
    expectedVersion: 1,
  })).toMatchObject({ kind: "claimed" });
  expect(startActionPlanAttempt(database, {
    planId: "plan:one",
    claimId: "claim:one",
    targetOrdinal: 1,
    attemptId: "attempt:one",
    idempotencyKey: "idempotency:one",
    startedAt,
    now: "2026-08-18T01:00:01.000Z",
  })).toMatchObject({ kind: "started" });
  return database;
}

function successResult(action: "markSeen" | "moveToArchive" = "markSeen") {
  return createRemoteAttemptSuccess({
    planId: "plan:one",
    action: { kind: action },
    target,
    attemptId: "attempt:one",
    idempotencyKey: "idempotency:one",
    startedAt,
    resultAt,
    kind: "success",
    certainty: "definite",
    postcondition: action === "markSeen"
      ? { kind: "flags", observedAt: resultAt, flags: ["\\Seen"], modseq: createMonotonicSequence(102) }
      : { kind: "mailbox", observedAt: resultAt, mailboxId: "mailbox:archive", uidValidity: 4, uid: 18, modseq: 102 },
  });
}

function uncertainResult() {
  return createRemoteAttemptUncertain({
    planId: "plan:one",
    action: { kind: "markSeen" },
    target,
    attemptId: "attempt:one",
    idempotencyKey: "idempotency:one",
    startedAt,
    resultAt,
    kind: "uncertain",
    certainty: "uncertain",
    uncertainReason: "local-result-not-durable",
    detail: "read-only evidence was incomplete",
  });
}

async function persistDispatchMarker(database: Database, recover = true): Promise<void> {
  const result = markActionPlanAttemptDispatched(database, {
    attemptId: "attempt:one",
    dispatchedAt: "2026-08-18T01:00:02.500Z",
    observation: {
      kind: "satisfied",
      target,
      observed: { uidValidity: 9, uid: 7, modseq: 101 },
    },
  });
  expect(result).toMatchObject({ kind: "marked" });
  if (recover) expect(recoverUnresolvedActionPlanAttempt(database, { attemptId: "attempt:one", recoveredAt: "2026-08-18T01:00:03.000Z" })).toMatchObject({ kind: "uncertain" });
}

describe("one-target uncertain reconciliation result transaction P5-C14", () => {
  test("records applied and journal atomically, reopens exact result, and converges replay", async () => {
    const database = openDatabase();
    await persistDispatchMarker(database, false);
    const result = successResult();
    const first = recordActionPlanReconciliationResult(database, { result });
    expect(first).toMatchObject({ kind: "recorded", result: { kind: "success" } });
    expect(readActionPlanResult(database, "attempt:one")).toEqual(result);
    expect(recordActionPlanReconciliationResult(database, { result })).toEqual(first);
    expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 1 });
  });

  test("transitions only the durable uncertain marker and rejects conflicting replay", async () => {
    const database = openDatabase();
    await persistDispatchMarker(database);
    const result = successResult();
    expect(recordActionPlanReconciliationResult(database, { result })).toMatchObject({ kind: "recorded" });
    expect(readActionPlanResult(database, "attempt:one")).toEqual(result);
    expect(recordActionPlanReconciliationResult(database, {
      result: createRemoteAttemptSuccess({ ...result, postcondition: { kind: "flags", observedAt: resultAt, flags: ["\\Seen", "\\Flagged"], modseq: 103 } }),
    })).toEqual({ kind: "rejected", attemptId: "attempt:one", reason: "result-conflict" });
  });

  test("keeps still-uncertain durable and rolls back result plus journal together", async () => {
    const database = openDatabase();
    await persistDispatchMarker(database, false);
    expect(recordActionPlanReconciliationResult(database, { result: uncertainResult() })).toMatchObject({ kind: "recorded", result: { kind: "uncertain" } });
    expect(recordActionPlanReconciliationResult(database, { result: uncertainResult() })).toMatchObject({ kind: "recorded" });
    expect(database.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 1 });

    const failing = openDatabase();
    await persistDispatchMarker(failing, false);
    failing.exec("CREATE TRIGGER reject_reconciliation_journal BEFORE INSERT ON operational_journal WHEN NEW.category = 'action' BEGIN SELECT RAISE(ABORT, 'injected reconciliation journal failure'); END;");
    expect(() => recordActionPlanReconciliationResult(failing, { result: successResult() })).toThrow("injected reconciliation journal failure");
    expect(failing.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 0 });
    expect(failing.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 0 });
  });

  test("mismatched attempt identity is rejected without a durable result", () => {
    const database = openDatabase();
    expect(recordActionPlanReconciliationResult(database, { result: createRemoteAttemptSuccess({ ...successResult(), target: { ...target, uid: 8 }, postcondition: { kind: "flags", observedAt: resultAt, flags: ["\\Seen"], modseq: 102 } }) })).toEqual({ kind: "rejected", attemptId: "attempt:one", reason: "identity" });
    expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 0 });
  });

  test("service reopens one dispatch identity, observes once, and converges without a second read", async () => {
    const database = openDatabase();
    await persistDispatchMarker(database);
    let reads = 0;
    const observer = {
      read: async ({ attempt, dispatch }: { readonly attempt: unknown; readonly dispatch: Readonly<{ readonly observationUid: number }> }) => {
        reads += 1;
        expect(attempt).toMatchObject({ attemptId: "attempt:one", target });
        expect(dispatch).toMatchObject({ observationUid: 7, observationUidValidity: 9, observationModseq: 101 });
        return successResult();
      },
    };
    await expect(reconcileUncertainActionPlanAttempt(database, { attemptId: "attempt:one", resultAt, observer })).resolves.toMatchObject({ kind: "recorded", result: { kind: "success" } });
    await expect(reconcileUncertainActionPlanAttempt(database, { attemptId: "attempt:one", resultAt, observer })).resolves.toMatchObject({ kind: "already-resolved" });
    expect(reads).toBe(1);

    const notDispatched = openDatabase();
    await expect(reconcileUncertainActionPlanAttempt(notDispatched, { attemptId: "attempt:one", resultAt, observer })).resolves.toEqual({ kind: "not-dispatched", attemptId: "attempt:one" });
    expect(reads).toBe(1);
  });

  test.each([
    {
      action: "markSeen",
      sourceMessage: { uid: 7, flags: ["\\Seen"], modseq: 101 },
      expected: "success",
      destination: undefined,
      destinationMessage: undefined,
    },
    {
      action: "markSeen",
      sourceMessage: { uid: 7, flags: ["\\Seen"], modseq: 102 },
      expected: "success",
      destination: undefined,
      destinationMessage: undefined,
    },
    {
      action: "moveToArchive",
      sourceMessage: false,
      expected: "success",
      destination: "moveToArchive",
      destinationMessage: { uid: 18, flags: [], modseq: 4 },
    },
    {
      action: "markUnseen",
      sourceMessage: { uid: 7, flags: ["\\Seen"], modseq: 101 },
      expected: "rejected",
      destination: undefined,
      destinationMessage: undefined,
    },
    {
      action: "markUnseen",
      sourceMessage: { uid: 7, flags: ["\\Flagged"], modseq: 102 },
      expected: "success",
      destination: undefined,
      destinationMessage: undefined,
    },
    {
      action: "markSeen",
      sourceMessage: { uid: 7, flags: ["\\Flagged"], modseq: 102 },
      expected: "stale",
      destination: undefined,
      destinationMessage: undefined,
    },
    {
      action: "moveToArchive",
      sourceMessage: { uid: 7, flags: [], modseq: 102 },
      expected: "stale",
      destination: "moveToArchive",
      destinationMessage: false,
    },
    {
      action: "moveToTrash",
      sourceMessage: false,
      expected: "uncertain",
      destination: "moveToTrash",
      destinationMessage: false,
    },
  ] as const)(
    "composes real IMAP read classification with SQLite result and journal closure",
    async ({ action, sourceMessage, expected, destination, destinationMessage }) => {
      const database = openDatabase(action);
      await persistDispatchMarker(database, false);
      const reopened = readActionPlanAttempt(database, "attempt:one");
      if (reopened === undefined) throw new Error("attempt did not reopen");
      const destinationIdentity = destination === undefined ? undefined : imapDestinations[destination];
      const client = new ComposedReadOnlyImapFixture({
        INBOX: {
          mailbox: { path: "INBOX", uidValidity: 9 },
          message: sourceMessage,
        },
        ...(destinationIdentity === undefined
          ? {}
          : {
              [destinationIdentity.path]: {
                mailbox: { path: destinationIdentity.path, uidValidity: destinationIdentity.uidValidity },
                message: destinationMessage,
              },
            }),
      });
      const adapter = createUncertainReconciliationAdapter({
        client,
        source: imapSource,
        destination: destinationIdentity,
      });
      const observer: UncertainAttemptReadOnlyObserver = createUncertainReconciliationObserver(adapter);
      const first = await reconcileUncertainActionPlanAttempt(database, {
        attemptId: "attempt:one",
        resultAt,
        observer,
      });
      expect(first).toMatchObject({ kind: "recorded", result: { kind: expected } });
      const stored = readActionPlanResult(database, "attempt:one");
      expect(stored).toMatchObject({ kind: expected });
      if (action === "moveToArchive" && expected === "success") {
        expect(stored).toMatchObject({
          kind: "success",
          postcondition: {
            kind: "mailbox",
            mailboxId: "mailbox:archive",
            uidValidity: 4,
            uid: 18,
            modseq: 4,
          },
        });
      }
      if (
        expected === "success" &&
        (action === "markSeen" || action === "markUnseen") &&
        sourceMessage !== false &&
        sourceMessage.modseq === 102
      ) {
        expect(stored).toMatchObject({
          kind: "success",
          postcondition: { kind: "flags", modseq: 102, flags: sourceMessage.flags },
        });
      }
      expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 1 });
      expect(database.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 1 });
      if (expected === "uncertain") {
        expect(database.query("SELECT payload_json FROM operational_journal;").get()).toMatchObject({
          payload_json: expect.stringContaining("destination-missing"),
        });
      }

      const callsBeforeReplay = client.calls.length;
      const replay = await reconcileUncertainActionPlanAttempt(database, {
        attemptId: "attempt:one",
        resultAt,
        observer,
      });
      expect(replay).toMatchObject(
        expected === "uncertain"
          ? { kind: "recorded", result: { kind: expected } }
          : { kind: "already-resolved", result: { kind: expected } },
      );
      expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: 1 });
      expect(database.query("SELECT COUNT(*) AS count FROM operational_journal;").get()).toEqual({ count: 1 });
      expect(client.calls.slice(0, callsBeforeReplay).some((call) => /store|move|copy|delete|expunge/i.test(call))).toBe(false);
      expect(client.calls.some((call) => /store|move|copy|delete|expunge/i.test(call))).toBe(false);
    },
  );
});
