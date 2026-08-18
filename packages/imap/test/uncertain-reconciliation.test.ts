import { describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createRemoteAttempt,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import {
  createUncertainReconciliationAdapter,
  IMAP_RECONCILIATION_FETCH_OPTIONS,
  IMAP_RECONCILIATION_FETCH_QUERY,
  IMAP_RECONCILIATION_LOCK_OPTIONS,
  type ImapFlowUncertainReconciliationClient,
} from "../src/uncertain-reconciliation";

const accountId = createAccountId("one");
const source = {
  accountId,
  mailboxId: createMailboxId("inbox"),
  path: "INBOX",
  uidValidity: createUidValidity(9),
};
const destination = {
  accountId,
  mailboxId: createMailboxId("archive"),
  path: "Archive",
  uidValidity: createUidValidity(4),
  uid: createRemoteUidValue(18),
};

type Fixture = Readonly<{ readonly mailbox: unknown; readonly message: unknown }>;

class ReadOnlyFixtureClient implements ImapFlowUncertainReconciliationClient {
  readonly calls: string[] = [];
  readonly fixtures: Readonly<Record<string, Fixture>>;
  mailbox: unknown = null;

  constructor(fixtures: Readonly<Record<string, Fixture>>) {
    this.fixtures = fixtures;
  }

  async getMailboxLock(path: string, options: typeof IMAP_RECONCILIATION_LOCK_OPTIONS): Promise<unknown> {
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
    const selection = this.mailbox;
    if (typeof selection !== "object" || selection === null || !("path" in selection) || typeof selection.path !== "string") {
      throw new Error("not selected");
    }
    return this.fixtures[selection.path]?.message ?? false;
  }
}

function attempt(action: "markSeen" | "markUnseen" | "moveToArchive" | "moveToTrash") {
  return createRemoteAttempt({
    kind: "attempt",
    planId: "plan:one",
    action: { kind: action },
    target: {
      accountId,
      mailboxId: source.mailboxId,
      uidValidity: source.uidValidity,
      uid: createRemoteUidValue(7),
      precondition: { modseq: 101 },
    },
    attemptId: "attempt:one",
    idempotencyKey: "idempotency:one",
    startedAt: "2026-08-18T01:00:00.000Z",
    certainty: "unresolved",
  });
}

function adapterFor(
  action: "markSeen" | "markUnseen" | "moveToArchive" | "moveToTrash",
  sourceMessage: unknown,
  destinationMessage?: unknown,
): Readonly<{ readonly adapter: ReturnType<typeof createUncertainReconciliationAdapter>; readonly client: ReadOnlyFixtureClient }> {
  const client = new ReadOnlyFixtureClient({
    INBOX: { mailbox: { path: "INBOX", uidValidity: 9 }, message: sourceMessage },
    Archive: { mailbox: { path: "Archive", uidValidity: 4 }, message: destinationMessage ?? false },
  });
  return {
    client,
    adapter: createUncertainReconciliationAdapter({
      client,
      source,
      destination: action === "moveToArchive" || action === "moveToTrash" ? destination : undefined,
    }),
  };
}

function readInput(action: ReturnType<typeof attempt>) {
  return { attempt: action, observedAt: "2026-08-18T01:00:05.000Z" };
}

describe("one-target uncertain remote reconciliation", () => {
  test.each([
    ["markSeen", ["\\Seen"], 101, "applied"],
    ["markSeen", ["\\Seen"], 102, "applied"],
    ["markUnseen", ["\\Flagged"], 101, "applied"],
    ["markUnseen", ["\\Flagged"], 102, "applied"],
    ["markSeen", ["\\Flagged"], 101, "not-applied"],
    ["markSeen", ["\\Flagged"], 102, "stale"],
  ] as const)("classifies %s from exact flags and MODSEQ", async (action, flags, modseq, expected) => {
    const { adapter, client } = adapterFor(action, {
      uid: 7,
      flags,
      modseq,
    });
    await expect(adapter.read(readInput(attempt(action)))).resolves.toMatchObject({ kind: expected });
    expect(client.calls).toEqual(["lock:INBOX", "fetch:7", "release:INBOX"]);
  });

  test.each([
    [false, true, "applied"],
    [true, false, "not-applied"],
    [false, false, "still-uncertain"],
    [true, true, "still-uncertain"],
  ] as const)("classifies move only with exact source/destination evidence", async (sourcePresent, destinationPresent, expected) => {
    const { adapter, client } = adapterFor(
      "moveToArchive",
      sourcePresent ? { uid: 7, flags: [], modseq: 101 } : false,
      destinationPresent ? { uid: 18, flags: [], modseq: 4 } : false,
    );
    await expect(adapter.read(readInput(attempt("moveToArchive")))).resolves.toMatchObject({ kind: expected });
    expect(client.calls).toEqual(["lock:INBOX", "fetch:7", "release:INBOX", "lock:Archive", "fetch:18", "release:Archive"]);
  });

  test("applies the same exact-evidence matrix to Trash", async () => {
    for (const [sourceMessage, destinationMessage, expected] of [
      [false, { uid: 18, flags: [], modseq: 4 }, "applied"],
      [{ uid: 7, flags: [], modseq: 101 }, false, "not-applied"],
      [false, false, "still-uncertain"],
    ] as const) {
      const { adapter } = adapterFor("moveToTrash", sourceMessage, destinationMessage);
      await expect(adapter.read(readInput(attempt("moveToTrash")))).resolves.toMatchObject({ kind: expected });
    }
  });

  test("source absence alone remains uncertain and exposes no mutation capability", async () => {
    const { adapter, client } = adapterFor("moveToTrash", false, false);
    const result = await adapter.read(readInput(attempt("moveToTrash")));
    expect(result).toMatchObject({ kind: "still-uncertain", reason: "destination-missing" });
    expect(client.calls.some((call) => /store|move|copy|delete|expunge/i.test(call))).toBe(false);
  });

  test("changed source epoch is stale, while a wrong selected path fails closed", async () => {
    const epochClient = new ReadOnlyFixtureClient({ INBOX: { mailbox: { path: "INBOX", uidValidity: 10 }, message: false } });
    const epochAdapter = createUncertainReconciliationAdapter({ client: epochClient, source });
    await expect(epochAdapter.read(readInput(attempt("markSeen")))).resolves.toMatchObject({ kind: "stale", reason: "source-epoch-changed" });

    const wrongPathClient = new ReadOnlyFixtureClient({ INBOX: { mailbox: { path: "Other", uidValidity: 9 }, message: false } });
    const wrongPathAdapter = createUncertainReconciliationAdapter({ client: wrongPathClient, source });
    await expect(wrongPathAdapter.read(readInput(attempt("markSeen")))).rejects.toMatchObject({ code: "identity-mismatch" });
  });
});
