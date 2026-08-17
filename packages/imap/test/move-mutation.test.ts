import { describe, expect, test } from "bun:test";
import {
  createAccountId,
  createClaimId,
  createExecutingActionPlan,
  createMailboxId,
  createMonotonicSequence,
  createRemoteAttempt,
  createRemoteUidValue,
  createUidValidity,
  type RemoteAttempt,
} from "@agent-mail/core";
import {
  createMoveMutationAdapter,
  createImapFlowMoveClient,
  IMAP_MOVE_LOCK_OPTIONS,
  IMAP_MOVE_UID_OPTIONS,
  type ConditionalDeletedStatus,
  type ImapFlowMoveClient,
  type MoveCommandTraceEntry,
  type MoveMutationAdapterOptions,
  type MoveMutationResult,
} from "../src/move-mutation";
import { ImapFlow } from "imapflow";
import { executeRemoteAttempt, type DurableAttemptEvidence } from "../src/remote-executor";
import type { ResolvedSpecialUseMailbox } from "../src/special-use-resolver";
import {
  runAdapterContractParity,
  type AdapterContractSuite,
  type AdapterFactoryInput,
} from "../../../tests/adapter-contracts/harness";
import captured from "./fixtures/move-production-labeled.json";

const accountId = createAccountId("account:one");
const sourceMailboxId = createMailboxId("mailbox:inbox");
const sourcePath = "INBOX";
const target: RemoteAttempt = createRemoteAttempt({
  kind: "attempt",
  planId: "plan:one",
  action: { kind: "moveToArchive" },
  target: {
    accountId,
    mailboxId: sourceMailboxId,
    uidValidity: 9,
    uid: 7,
    precondition: { modseq: 101 },
  },
  attemptId: "attempt:one",
  idempotencyKey: "idempotency:one",
  startedAt: "2026-08-18T01:00:02.000Z",
  certainty: "unresolved",
});
const plan = createExecutingActionPlan({
  state: "executing",
  planId: target.planId,
  action: target.action,
  targets: [target.target],
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T02:00:00.000Z",
  claimId: "claim:one",
  startedAt: "2026-08-18T01:00:01.000Z",
});
const durableAttempt: DurableAttemptEvidence = {
  claimId: createClaimId("claim:one"),
  attempt: target,
};
const satisfied = {
  kind: "satisfied" as const,
  target: target.target,
  observed: {
    uidValidity: createUidValidity(9),
    uid: createRemoteUidValue(7),
    modseq: createMonotonicSequence(101),
  },
};

const archive: ResolvedSpecialUseMailbox = {
  accountId,
  mailboxId: createMailboxId("mailbox:archive"),
  path: "客户/归档/Équipe",
  delimiter: "/",
  epoch: {
    uidValidity: { kind: "known", value: createUidValidity(938475) },
    uidNext: { kind: "known", value: createRemoteUidValue(41) },
    highestModseq: { kind: "known", value: createMonotonicSequence(8) },
  },
};
const trash: ResolvedSpecialUseMailbox = {
  accountId,
  mailboxId: createMailboxId("mailbox:trash"),
  path: "Проекты/Удалённые",
  delimiter: "/",
  epoch: {
    uidValidity: { kind: "known", value: createUidValidity(938476) },
    uidNext: { kind: "known", value: createRemoteUidValue(12) },
    highestModseq: { kind: "known", value: createMonotonicSequence(3) },
  },
};
const trashTarget = createRemoteAttempt({
  ...target,
  action: { kind: "moveToTrash" },
});
const trashPlan = createExecutingActionPlan({
  ...plan,
  action: { kind: "moveToTrash" },
  targets: [trashTarget.target],
});
const trashDurableAttempt: DurableAttemptEvidence = { ...durableAttempt, attempt: trashTarget };

class ProductionShapedMoveFake implements ImapFlowMoveClient {
  capabilities = new Map<string, boolean | number>([["MOVE", true]]);
  mailbox: unknown = { path: sourcePath, uidValidity: 9 };
  readonly calls: MoveCommandTraceEntry[] = [];
  moveResponse: unknown = {
    path: sourcePath,
    destination: archive.path,
    uidMap: new Map([[7, 77]]),
  };
  copyResponse: unknown = {
    path: sourcePath,
    destination: archive.path,
    uidMap: new Map([[7, 77]]),
  };
  moveResult: unknown = this.moveResponse;
  copyResult: unknown = this.copyResponse;
  conditionalDeletedSupportedValue = true;
  conditionalDeletedResult: ConditionalDeletedStatus = "applied";
  unsafeExpungeCalls = 0;

  async getMailboxLock(path: string, options: typeof IMAP_MOVE_LOCK_OPTIONS): Promise<unknown> {
    this.calls.push({ kind: "getMailboxLock", path, options });
    return {
      release: () => this.calls.push({ kind: "release" }),
    };
  }

  async messageMove(
    range: string,
    destination: string,
    options: typeof IMAP_MOVE_UID_OPTIONS,
  ): Promise<unknown> {
    this.calls.push({ kind: "messageMove", uid: createRemoteUidValue(Number(range)), destination, options });
    return this.moveResult;
  }

  async messageCopy(
    range: string,
    destination: string,
    options: typeof IMAP_MOVE_UID_OPTIONS,
  ): Promise<unknown> {
    this.calls.push({ kind: "messageCopy", uid: createRemoteUidValue(Number(range)), destination, options });
    return this.copyResult;
  }

  async conditionalDeleted(
    range: string,
    options: Readonly<{ readonly uid: true; readonly unchangedSince: bigint }>,
  ): Promise<ConditionalDeletedStatus> {
    this.calls.push({
      kind: "conditionalDeleted",
      uid: createRemoteUidValue(Number(range)),
      options,
      status: this.conditionalDeletedResult,
    });
    return this.conditionalDeletedResult;
  }

  conditionalDeletedSupported(): boolean {
    return this.conditionalDeletedSupportedValue;
  }

  /** Adjacent counterexample hook: the adapter must never call this operation. */
  messageExpunge(): void {
    this.unsafeExpungeCalls += 1;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMoveMutationResult(value: unknown): value is MoveMutationResult {
  if (!isRecord(value) || typeof value.kind !== "string" || !Array.isArray(value.trace)) {
    return false;
  }
  if (!isRecord(value.target) || typeof value.certainty !== "string") return false;
  switch (value.kind) {
    case "applied":
      return value.certainty === "definite" && isRecord(value.observation);
    case "partial":
      return value.certainty === "uncertain" && isRecord(value.observation);
    case "precondition_failed":
    case "missing":
    case "unsupported":
      return value.certainty === "definite";
    case "uncertain_transport":
      return (
        (value.certainty === "definite" || value.certainty === "uncertain") &&
        (value.phase === "before_transmission" || value.phase === "after_transmission")
      );
    default:
      return false;
  }
}

function mutationOptions(
  client: ImapFlowMoveClient,
  role: "archive" | "trash" = "archive",
  destination: ResolvedSpecialUseMailbox = archive,
): MoveMutationAdapterOptions {
  return {
    client,
    source: { accountId, mailboxId: sourceMailboxId, path: sourcePath },
    role,
    destination,
  };
}

async function execute(client: ImapFlowMoveClient) {
  const result = await executeRemoteAttempt({
    claimedPlan: plan,
    durableAttempt,
    readPrecondition: async () => satisfied,
    finalizeStale: async () => "not-used",
    markDispatched: async () => undefined,
    mutationAdapter: createMoveMutationAdapter(mutationOptions(client)),
  });
  if (result.kind !== "executed") throw new Error(`expected executed, got ${result.kind}`);
  if (!isMoveMutationResult(result.result)) throw new Error("invalid move mutation result");
  return result.result;
}

async function executeTrash(client: ImapFlowMoveClient) {
  const result = await executeRemoteAttempt({
    claimedPlan: trashPlan,
    durableAttempt: trashDurableAttempt,
    readPrecondition: async () => ({ ...satisfied, target: trashTarget.target }),
    finalizeStale: async () => "not-used",
    markDispatched: async () => undefined,
    mutationAdapter: createMoveMutationAdapter(mutationOptions(client, "trash", trash)),
  });
  if (result.kind !== "executed") throw new Error(`expected executed, got ${result.kind}`);
  if (!isMoveMutationResult(result.result)) throw new Error("invalid move mutation result");
  return result.result;
}

describe("one-target Archive/Trash move mutation", () => {
  test("uses the exact UID MOVE target and SPECIAL-USE destination", async () => {
    const fake = new ProductionShapedMoveFake();
    const result = await execute(fake);
    expect(result).toMatchObject({
      kind: "applied",
      certainty: "definite",
      observation: {
        source: { kind: "absent", mailboxId: sourceMailboxId, uidValidity: 9, uid: 7 },
        destination: {
          kind: "present",
          mailboxId: "mailbox:archive",
          uidValidity: 938475,
          uid: 77,
        },
        mechanism: "MOVE",
      },
    });
    expect(fake.calls).toEqual([
      { kind: "getMailboxLock", path: sourcePath, options: IMAP_MOVE_LOCK_OPTIONS },
      { kind: "messageMove", uid: createRemoteUidValue(7), destination: archive.path, options: IMAP_MOVE_UID_OPTIONS },
      { kind: "release" },
    ]);
    expect(fake.unsafeExpungeCalls).toBe(0);
    expect(result).toMatchObject({ trace: fake.calls });
  });

  test("moves one exact target to the resolved SPECIAL-USE Trash mailbox", async () => {
    const fake = new ProductionShapedMoveFake();
    fake.moveResponse = {
      path: sourcePath,
      destination: trash.path,
      uidMap: new Map([[7, 78]]),
    };
    fake.moveResult = fake.moveResponse;
    const result = await executeTrash(fake);
    expect(result).toMatchObject({
      kind: "applied",
      observation: {
        source: { kind: "absent", mailboxId: sourceMailboxId, uid: 7 },
        destination: { kind: "present", mailboxId: trash.mailboxId, uidValidity: 938476, uid: 78 },
      },
      trace: fake.calls,
    });
    expect(fake.calls).toContainEqual({
      kind: "messageMove",
      uid: createRemoteUidValue(7),
      destination: trash.path,
      options: IMAP_MOVE_UID_OPTIONS,
    });
    expect(fake.unsafeExpungeCalls).toBe(0);
  });

  test("uses only COPY plus conditional Deleted when MOVE is unavailable", async () => {
    const fake = new ProductionShapedMoveFake();
    fake.capabilities = new Map();
    const result = await execute(fake);
    expect(result).toMatchObject({
      kind: "applied",
      observation: { mechanism: "COPY+DELETED", source: { kind: "absent" }, destination: { kind: "present" } },
    });
    expect(fake.calls.map((call) => call.kind)).toEqual([
      "getMailboxLock",
      "messageCopy",
      "conditionalDeleted",
      "release",
    ]);
    const conditional = fake.calls.find((call) => call.kind === "conditionalDeleted");
    expect(conditional).toMatchObject({
      uid: 7,
      options: { uid: true, unchangedSince: 101n },
      status: "applied",
    });
    expect(fake.unsafeExpungeCalls).toBe(0);
  });

  test("fails closed before COPY when CONDSTORE is unavailable", async () => {
    const unsupported = new ProductionShapedMoveFake();
    unsupported.capabilities = new Map();
    unsupported.conditionalDeletedSupportedValue = false;
    expect(await execute(unsupported)).toEqual(
      expect.objectContaining({ kind: "unsupported", certainty: "definite" }),
    );
    expect(unsupported.calls.map((call) => call.kind)).toEqual([
      "getMailboxLock",
      "release",
    ]);
  });

  test("does not treat collapsed native MOVE failure as definite missing", async () => {
    const missing = new ProductionShapedMoveFake();
    missing.moveResult = false;
    expect(await execute(missing)).toEqual(
      expect.objectContaining({
        kind: "uncertain_transport",
        certainty: "uncertain",
        phase: "after_transmission",
      }),
    );

    const explicitMissing = new ProductionShapedMoveFake();
    explicitMissing.moveResult = { kind: "missing" };
    expect(await execute(explicitMissing)).toEqual(
      expect.objectContaining({ kind: "missing", certainty: "definite" }),
    );

    const copied = new ProductionShapedMoveFake();
    copied.capabilities = new Map();
    copied.copyResult = false;
    expect(await execute(copied)).toMatchObject({
      kind: "uncertain_transport",
      certainty: "uncertain",
      phase: "after_transmission",
    });

    const explicitCopyMissing = new ProductionShapedMoveFake();
    explicitCopyMissing.capabilities = new Map();
    explicitCopyMissing.copyResult = { kind: "missing" };
    expect(await execute(explicitCopyMissing)).toMatchObject({
      kind: "missing",
      certainty: "definite",
    });

    const failed = new ProductionShapedMoveFake();
    failed.capabilities = new Map();
    failed.conditionalDeletedResult = "modified";
    expect(await execute(failed)).toMatchObject({
      kind: "partial",
      certainty: "uncertain",
      reason: "conditional-delete-rejected",
      observation: {
        source: { kind: "present", mailboxId: sourceMailboxId, uid: 7 },
        destination: { kind: "present", mailboxId: "mailbox:archive", uid: 77 },
      },
    });
  });

  test("preserves before-transmission native MOVE failures and rejects malformed success", async () => {
    const before = new ProductionShapedMoveFake();
    before.moveResult = undefined;
    before.messageMove = async () => {
      throw { beforeTransmission: true };
    };
    expect(await execute(before)).toMatchObject({
      kind: "uncertain_transport",
      certainty: "definite",
      phase: "before_transmission",
    });

    const malformed = new ProductionShapedMoveFake();
    malformed.moveResult = {};
    expect(await execute(malformed)).toMatchObject({
      kind: "uncertain_transport",
      certainty: "uncertain",
      phase: "after_transmission",
    });

    const copyBefore = new ProductionShapedMoveFake();
    copyBefore.capabilities = new Map();
    copyBefore.messageCopy = async () => {
      throw { beforeTransmission: true };
    };
    expect(await execute(copyBefore)).toMatchObject({
      kind: "uncertain_transport",
      certainty: "definite",
      phase: "before_transmission",
    });

    const malformedCopy = new ProductionShapedMoveFake();
    malformedCopy.capabilities = new Map();
    malformedCopy.copyResult = {};
    expect(await execute(malformedCopy)).toMatchObject({
      kind: "uncertain_transport",
      certainty: "uncertain",
      phase: "after_transmission",
    });
  });

  test("accepts an already-deleted desired state without expunging", async () => {
    const fake = new ProductionShapedMoveFake();
    fake.capabilities = new Map();
    fake.conditionalDeletedResult = "already_deleted";
    expect(await execute(fake)).toMatchObject({
      kind: "applied",
      certainty: "definite",
      observation: { source: { kind: "absent" }, destination: { kind: "present" } },
    });
  });

  test("the COPY+Deleted+EXPUNGE adjacent counterexample is not callable by this adapter", async () => {
    const fake = new ProductionShapedMoveFake();
    fake.capabilities = new Map();
    await execute(fake);
    expect(fake.unsafeExpungeCalls).toBe(0);
    expect(fake.calls).not.toContainEqual(expect.objectContaining({ kind: "messageExpunge" }));
  });
});

type CapturedMove = {
  readonly source: { readonly path: string; readonly uidValidity: number };
  readonly destination: { readonly path: string; readonly uidValidity: number };
  readonly move: { readonly path: string; readonly destination: string; readonly uidMap: Readonly<Record<string, number>> };
};

const contractSuite: AdapterContractSuite<ImapFlowMoveClient> = {
  name: "one-target move/no-expunge over captured production-shaped ImapFlow",
  cases: [
    {
      id: "exact-target-destination-and-no-expunge",
      productionRequired: true,
      run: async (client) => {
        const result = await executeRemoteAttempt({
          claimedPlan: plan,
          durableAttempt,
          readPrecondition: async () => satisfied,
          finalizeStale: async () => "not-used",
          markDispatched: async () => undefined,
          mutationAdapter: createMoveMutationAdapter(mutationOptions(client)),
        });
        expect(result.kind).toBe("executed");
        if (result.kind !== "executed") throw new Error("move was not executed");
        if (!isMoveMutationResult(result.result)) throw new Error("invalid move mutation result");
        expect(result.result).toMatchObject({ kind: "applied", observation: { mechanism: "MOVE" } });
      },
    },
  ],
};

function fakeFactory(): ImapFlowMoveClient {
  return new ProductionShapedMoveFake();
}

function capturedFactory(): ImapFlowMoveClient {
  const fixture: CapturedMove = captured;
  const fake = new ProductionShapedMoveFake();
  fake.mailbox = fixture.source;
  fake.moveResponse = {
    path: fixture.move.path,
    destination: fixture.move.destination,
    uidMap: new Map([[7, fixture.move.uidMap["7"]]]),
  };
  fake.moveResult = fake.moveResponse;
  return fake;
}

const fakeInput: Omit<AdapterFactoryInput<ImapFlowMoveClient>, "kind"> = {
  factory: fakeFactory,
  capabilities: [{ name: "uid-move", status: "available" }],
};
const capturedInput: Omit<AdapterFactoryInput<ImapFlowMoveClient>, "kind"> = {
  factory: capturedFactory,
  capabilities: [{ name: "uid-move", status: "available" }],
  retainedEvidencePath: "packages/imap/test/fixtures/move-production-labeled.json",
};

test("runs the same move/no-expunge contract against fake and production-labeled responses", async () => {
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

function installedImapFlowCompatibilityProof(flow: ImapFlow): ImapFlowMoveClient {
  return createImapFlowMoveClient(flow);
}

void installedImapFlowCompatibilityProof;

test("the installed ImapFlow factory uses tagged UID STORE for conditional Deleted", async () => {
  const calls: Array<{ readonly command: string; readonly attributes: readonly unknown[] }> = [];
  const flow = Object.assign(
    new ImapFlow({
      host: "example.invalid",
      port: 993,
      secure: true,
      auth: { user: "test", pass: "test" },
      logger: false,
    }),
    {
      enabled: new Set(["CONDSTORE"]),
      mailbox: { path: sourcePath, uidValidity: 9 },
      exec: async (command: string, attributes: readonly unknown[]) => {
        calls.push({ command, attributes });
        return { response: { command: "OK" }, next: () => undefined };
      },
    },
  );
  const client = createImapFlowMoveClient(flow);

  expect(client.conditionalDeletedSupported?.()).toBe(true);
  expect(
    await client.conditionalDeleted?.("7", { uid: true, unchangedSince: 101n }),
  ).toBe("applied");
  expect(calls).toEqual([
    {
      command: "UID STORE",
      attributes: [
        { type: "SEQUENCE", value: "7" },
        [
          { type: "ATOM", value: "UNCHANGEDSINCE" },
          { type: "ATOM", value: "101" },
        ],
        { type: "ATOM", value: "+FLAGS" },
        [{ type: "ATOM", value: "\\Deleted" }],
      ],
    },
  ]);
});

test("the installed ImapFlow factory preserves tagged result and transport certainty", async () => {
  const makeClient = (exec: (...args: never[]) => Promise<unknown>, enabled = ["CONDSTORE"]): ImapFlowMoveClient =>
    createImapFlowMoveClient(
      Object.assign(
        new ImapFlow({
          host: "example.invalid",
          port: 993,
          secure: true,
          auth: { user: "test", pass: "test" },
          logger: false,
        }),
        {
          enabled: new Set(enabled),
          mailbox: { path: sourcePath, uidValidity: 9 },
          exec,
        },
      ),
    );
  const response = (value: unknown) => ({ response: value, next: () => undefined });

  expect(
    await makeClient(async () =>
      response({
        command: "OK",
        attributes: [
          {
            section: [
              { type: "ATOM", value: "MODIFIED" },
              { type: "SEQUENCE", value: "7" },
            ],
          },
        ],
      }),
    ).conditionalDeleted?.("7", { uid: true, unchangedSince: 101n }),
  ).toBe("modified");
  expect(
    await makeClient(async () => {
      throw {
        response: {
          command: "NO",
          attributes: [{ section: [{ type: "ATOM", value: "NONEXISTENT" }] }],
        },
      };
    }).conditionalDeleted?.("7", { uid: true, unchangedSince: 101n }),
  ).toBe("missing");
  expect(
    await makeClient(async () => response({ command: "OK" }), []).conditionalDeleted?.("7", {
      uid: true,
      unchangedSince: 101n,
    }),
  ).toBe("unsupported");
  expect(
    await makeClient(async () => {
      throw { beforeTransmission: true };
    }).conditionalDeleted?.("7", { uid: true, unchangedSince: 101n }),
  ).toBe("transport_before");
  expect(
    await makeClient(async () => {
      throw new Error("connection lost");
    }).conditionalDeleted?.("7", { uid: true, unchangedSince: 101n }),
  ).toBe("transport_after");
});
