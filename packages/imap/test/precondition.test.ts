import { describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createMonotonicSequence,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import {
  createPreconditionAdapter,
  IMAP_PRECONDITION_FETCH_QUERY,
  IMAP_PRECONDITION_LOCK_OPTIONS,
  PreconditionAdapterError,
  type ImapFlowPreconditionClient,
  type PreconditionTarget,
} from "../src/precondition";
import {
  runAdapterContractParity,
  type AdapterContractSuite,
  type AdapterFactoryInput,
} from "../../../tests/adapter-contracts/harness";
import captured from "./fixtures/precondition-production-labeled.json";

const accountId = createAccountId("icloud");
const mailboxId = createMailboxId("INBOX");
const target: PreconditionTarget = {
  accountId,
  mailboxId,
  uidValidity: createUidValidity(938475),
  uid: createRemoteUidValue(42),
  precondition: { modseq: createMonotonicSequence(7) },
};

type Calls = Array<
  Readonly<{
    readonly kind: "getMailboxLock" | "fetchOne" | "release";
    readonly args: readonly unknown[];
  }>
>;

function makeClient(
  selection: unknown,
  fetch: unknown,
  calls: Calls = [],
  errors: Readonly<{ readonly select?: Error; readonly fetch?: Error }> = {},
): ImapFlowPreconditionClient {
  let released = false;
  return {
    getMailboxLock: async (...args) => {
      calls.push({ kind: "getMailboxLock", args });
      if (errors.select !== undefined) throw errors.select;
      return {
        release: () => {
          released = true;
          calls.push({ kind: "release", args: [] });
        },
      };
    },
    get mailbox(): unknown {
      return selection;
    },
    fetchOne: async (...args) => {
      calls.push({ kind: "fetchOne", args });
      if (released) throw new Error("competing reselect after release");
      if (errors.fetch !== undefined) throw errors.fetch;
      return fetch;
    },
  };
}

function adapterFor(
  selection: unknown,
  fetch: unknown,
  calls: Calls = [],
  errors: Readonly<{ readonly select?: Error; readonly fetch?: Error }> = {},
) {
  return createPreconditionAdapter({
    client: makeClient(selection, fetch, calls, errors),
    accountId,
    mailboxId,
    mailboxPath: "INBOX",
  });
}

const completeSelection = {
  path: "INBOX",
  uidValidity: 938475,
  uidNext: 43,
  highestModseq: 884422,
  flags: ["\\HasNoChildren", "\\Inbox"],
};

describe("one-target IMAP remote precondition adapter", () => {
  test("selects the exact mailbox, validates epoch first, and satisfies equal MODSEQ", async () => {
    const calls: Calls = [];
    const result = await adapterFor(completeSelection, { uid: 42, modseq: 7 }, calls).read(target);
    expect(result.kind).toBe("satisfied");
    expect(calls).toEqual([
      { kind: "getMailboxLock", args: ["INBOX", IMAP_PRECONDITION_LOCK_OPTIONS] },
      {
        kind: "fetchOne",
        args: ["42", IMAP_PRECONDITION_FETCH_QUERY, { uid: true }],
      },
      { kind: "release", args: [] },
    ]);
  });

  test.each([
    [8, "newer-modseq"],
    [6, "older-modseq"],
  ] as const)("classifies MODSEQ %d as stale (%s)", async (modseq, reason) => {
    const result = await adapterFor(completeSelection, { uid: 42, modseq }).read(target);
    expect(result).toMatchObject({ kind: "stale", reason });
  });

  test("classifies a missing UID and never treats it as satisfied", async () => {
    const result = await adapterFor(completeSelection, false).read(target);
    expect(result).toEqual({ kind: "missing", target, uidValidity: target.uidValidity });
  });

  test("validates UIDVALIDITY before UID/MODSEQ and stops on an epoch change", async () => {
    const calls: Calls = [];
    const result = await adapterFor(
      { ...completeSelection, uidValidity: 938476 },
      { uid: 42, modseq: 7 },
      calls,
    ).read(target);
    expect(result).toEqual({ kind: "epoch_changed", target, observedUidValidity: 938476 });
    expect(calls.map((call) => call.kind)).toEqual(["getMailboxLock", "release"]);
  });

  test("classifies absent or explicitly unsupported MODSEQ as unsupported", async () => {
    await expect(adapterFor(completeSelection, { uid: 42 }).read(target)).resolves.toMatchObject({
      kind: "unsupported",
      reason: "modseq-unavailable",
    });
    await expect(
      adapterFor({ path: "INBOX", uidValidity: undefined }, { uid: 42, modseq: 7 }).read(target),
    ).resolves.toMatchObject({ kind: "unsupported", reason: "uid-validity-unavailable" });
  });

  test("returns transport_error without retrying", async () => {
    const selectCalls: Calls = [];
    await expect(
      adapterFor(completeSelection, { uid: 42, modseq: 7 }, selectCalls, {
        select: new Error("offline"),
      }).read(target),
    ).resolves.toEqual({ kind: "transport_error", target, phase: "select" });
    expect(selectCalls.map((call) => call.kind)).toEqual(["getMailboxLock"]);

    const fetchCalls: Calls = [];
    await expect(
      adapterFor(completeSelection, { uid: 42, modseq: 7 }, fetchCalls, {
        fetch: new Error("offline"),
      }).read(target),
    ).resolves.toEqual({ kind: "transport_error", target, phase: "fetch" });
    expect(fetchCalls.map((call) => call.kind)).toEqual([
      "getMailboxLock",
      "fetchOne",
      "release",
    ]);
  });

  test("releases the lock exactly once after every acquired classification", async () => {
    const cases: readonly [string, unknown, unknown][] = [
      ["satisfied", completeSelection, { uid: 42, modseq: 7 }],
      ["stale", completeSelection, { uid: 42, modseq: 8 }],
      ["missing", completeSelection, false],
      ["epoch_changed", { ...completeSelection, uidValidity: 938476 }, { uid: 42, modseq: 7 }],
      ["unsupported", completeSelection, { uid: 42 }],
      ["transport_error", completeSelection, { uid: 42, modseq: 7 }],
    ];
    for (const [name, selection, fetched] of cases) {
      const calls: Calls = [];
      const errors = name === "transport_error" ? { fetch: new Error("offline") } : {};
      await adapterFor(selection, fetched, calls, errors).read(target);
      expect(calls.filter((call) => call.kind === "release"), name).toHaveLength(1);
      expect(calls.at(-1)?.kind, name).toBe("release");
    }
  });

  test("fails closed for exact identity mismatches and malformed provider shapes", async () => {
    const calls: Calls = [];
    await expect(
      adapterFor({ ...completeSelection, path: "Archive" }, { uid: 42, modseq: 7 }, calls).read(
        target,
      ),
    ).rejects.toMatchObject({ name: "PreconditionAdapterError", code: "identity-mismatch" });
    expect(calls.map((call) => call.kind)).toEqual(["getMailboxLock", "release"]);

    await expect(
      adapterFor(completeSelection, { uid: 41, modseq: 7 }).read(target),
    ).rejects.toMatchObject({
      name: "PreconditionAdapterError",
      code: "identity-mismatch",
    });
    await expect(
      adapterFor(completeSelection, { uid: 42, modseq: "not-a-number" }).read(target),
    ).rejects.toBeInstanceOf(PreconditionAdapterError);
  });

  test("releases exactly once when the selected mailbox shape is malformed", async () => {
    const calls: Calls = [];
    await expect(
      adapterFor(null, { uid: 42, modseq: 7 }, calls).read(target),
    ).rejects.toMatchObject({ code: "invalid-selection" });
    expect(calls.map((call) => call.kind)).toEqual(["getMailboxLock", "release"]);
  });

  test("rejects a target bound to another account or mailbox before any IMAP call", async () => {
    const calls: Calls = [];
    const wrongTarget = { ...target, accountId: createAccountId("other-account") };
    await expect(
      adapterFor(completeSelection, { uid: 42, modseq: 7 }, calls).read(wrongTarget),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(calls).toHaveLength(0);
  });
});

type CapturedClient = Readonly<{ readonly mailbox: unknown; readonly fetch: unknown }>;
let contractLockOptions: unknown;

function fakeFactory(): ImapFlowPreconditionClient {
  const client = makeClient(completeSelection, { uid: 42, modseq: 7 });
  return {
    getMailboxLock: async (path, options) => {
      contractLockOptions = options;
      return client.getMailboxLock(path, options);
    },
    get mailbox(): unknown {
      return client.mailbox;
    },
    fetchOne: client.fetchOne,
  };
}

function capturedFactory(): ImapFlowPreconditionClient {
  const fixture: CapturedClient = captured;
  const client = makeClient(fixture.mailbox, fixture.fetch);
  return {
    getMailboxLock: async (path, options) => {
      contractLockOptions = options;
      return client.getMailboxLock(path, options);
    },
    get mailbox(): unknown {
      return client.mailbox;
    },
    fetchOne: client.fetchOne,
  };
}

const contractSuite: AdapterContractSuite<ImapFlowPreconditionClient> = {
  name: "one-target read-only precondition over captured ImapFlow selection/fetch",
  cases: [
    {
      id: "equal-epoch-and-modseq-satisfies",
      productionRequired: true,
      run: async (client) => {
        const result = await createPreconditionAdapter({
          client,
          accountId,
          mailboxId,
          mailboxPath: "INBOX",
        }).read(target);
        expect(result.kind).toBe("satisfied");
        expect(contractLockOptions).toEqual(IMAP_PRECONDITION_LOCK_OPTIONS);
      },
    },
  ],
};

const fakeInput: Omit<AdapterFactoryInput<ImapFlowPreconditionClient>, "kind"> = {
  factory: fakeFactory,
  capabilities: [{ name: "read-only-select-fetch", status: "available" }],
};

const capturedInput: Omit<AdapterFactoryInput<ImapFlowPreconditionClient>, "kind"> = {
  factory: capturedFactory,
  capabilities: [{ name: "read-only-select-fetch", status: "available" }],
  retainedEvidencePath: "packages/imap/test/fixtures/precondition-production-labeled.json",
};

test("runs the same precondition contract against fake and captured production-labeled responses", async () => {
  const evidence = await runAdapterContractParity({
    suite: contractSuite,
    fake: fakeInput,
    production: capturedInput,
  });
  expect(evidence.fake.status).toBe("incomplete");
  expect(evidence.productionEvidence).toEqual({
    status: "available",
    adapterKind: "production",
    result: expect.objectContaining({ status: "passed" }),
  });
  expect(evidence.semanticParity.status).toBe("matched");
});
