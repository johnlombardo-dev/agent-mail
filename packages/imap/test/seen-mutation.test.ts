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
  type Action,
  type RemoteAttempt,
} from "@agent-mail/core";
import {
  executeRemoteAttempt,
  type DurableAttemptEvidence,
} from "../src/remote-executor";
import {
  createSeenMutationAdapter,
  IMAP_SEEN_FLAG,
  IMAP_SEEN_MUTATION_FETCH_OPTIONS,
  IMAP_SEEN_MUTATION_FETCH_QUERY,
  IMAP_SEEN_MUTATION_LOCK_OPTIONS,
  type ImapSeenConditionalStoreEvidence,
  type ImapSeenConditionalStore,
  type ImapSeenConditionalStoreRequest,
  type ImapSeenMutationClient,
  type SeenMutationResult,
} from "../src/seen-mutation";
import {
  runAdapterContractParity,
  type AdapterContractSuite,
  type AdapterFactoryInput,
} from "../../../tests/adapter-contracts/harness";
import fixture from "./fixtures/seen-mutation-production-labeled.json";

const accountId = createAccountId("icloud");
const mailboxId = createMailboxId("INBOX");
const uidValidity = createUidValidity(938475);
const uid = createRemoteUidValue(42);
const modseq = createMonotonicSequence(7);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeenMutationResult(value: unknown): value is SeenMutationResult {
  if (!isRecord(value) || typeof value.kind !== "string" || !Array.isArray(value.trace)) {
    return false;
  }
  if (!isRecord(value.target) || typeof value.certainty !== "string") return false;
  switch (value.kind) {
    case "applied":
      return value.certainty === "definite" && isRecord(value.postcondition);
    case "precondition_failed":
      return value.certainty === "definite";
    case "missing":
      return value.certainty === "definite";
    case "uncertain_transport":
      return value.certainty === "uncertain" && value.phase === "after_transmission";
    case "definite_transport_failure":
      return value.certainty === "definite" && value.phase === "before_transmission";
    default:
      return false;
  }
}

type Call = Readonly<{ readonly kind: string; readonly args: readonly unknown[] }>;

class FakeSeenClient implements ImapSeenMutationClient {
  readonly calls: Call[] = [];
  mailbox: unknown = { path: "INBOX", uidValidity: 938475 };
  readonly enabled = new Set(["CONDSTORE"]);
  responseUid = 42;
  flags = new Set(["\\Flagged", "\\Answered"]);
  currentModseq = 7n;
  storeResult: "apply" | "false" | "throw" = "apply";
  storeEvidenceOverride?: ImapSeenConditionalStoreEvidence;
  fetchResult: "current" | "missing" | "newer" | "throw" = "current";
  lockError: unknown;
  storeError: unknown;

  conditionalStore?: ImapSeenConditionalStore = async (
    request: ImapSeenConditionalStoreRequest,
  ): Promise<ImapSeenConditionalStoreEvidence> => {
    this.calls.push({ kind: "conditionalStore", args: [request] });
    if (this.storeError !== undefined) throw this.storeError;
    if (this.storeResult === "throw") throw new Error("store transport lost");
    if (this.storeEvidenceOverride !== undefined) return this.storeEvidenceOverride;
    if (this.storeResult === "false") return { kind: "precondition_failed" };
    if (request.operation === "add") this.flags.add(IMAP_SEEN_FLAG);
    else this.flags.delete(IMAP_SEEN_FLAG);
    this.currentModseq += 1n;
    return { kind: "applied" };
  };

  async getMailboxLock(
    path: string,
    options: typeof IMAP_SEEN_MUTATION_LOCK_OPTIONS,
  ): Promise<unknown> {
    this.calls.push({ kind: "getMailboxLock", args: [path, options] });
    if (this.lockError !== undefined) throw this.lockError;
    return {
      release: () => this.calls.push({ kind: "release", args: [] }),
    };
  }

  async messageFlagsAdd(
    range: string,
    flags: [typeof IMAP_SEEN_FLAG],
    options: { readonly uid: true; readonly unchangedSince: bigint },
  ): Promise<boolean> {
    this.calls.push({ kind: "messageFlagsAdd", args: [range, flags, options] });
    if (this.storeError !== undefined) throw this.storeError;
    if (this.storeResult === "throw") throw new Error("store transport lost");
    if (this.storeResult === "false") return false;
    this.flags.add(IMAP_SEEN_FLAG);
    this.currentModseq += 1n;
    return true;
  }

  async messageFlagsRemove(
    range: string,
    flags: [typeof IMAP_SEEN_FLAG],
    options: { readonly uid: true; readonly unchangedSince: bigint },
  ): Promise<boolean> {
    this.calls.push({ kind: "messageFlagsRemove", args: [range, flags, options] });
    if (this.storeError !== undefined) throw this.storeError;
    if (this.storeResult === "throw") throw new Error("store transport lost");
    if (this.storeResult === "false") return false;
    this.flags.delete(IMAP_SEEN_FLAG);
    this.currentModseq += 1n;
    return true;
  }

  async fetchOne(
    range: string,
    query: typeof IMAP_SEEN_MUTATION_FETCH_QUERY,
    options: typeof IMAP_SEEN_MUTATION_FETCH_OPTIONS,
  ): Promise<unknown> {
    this.calls.push({ kind: "fetchOne", args: [range, query, options] });
    if (this.fetchResult === "throw") throw new Error("postcondition transport lost");
    if (this.fetchResult === "missing") return false;
    const observedModseq = this.fetchResult === "newer" ? this.currentModseq + 1n : this.currentModseq;
    return {
      uid: this.responseUid,
      flags: new Set(this.flags),
      modseq: observedModseq,
    };
  }
}

function attemptFor(action: Action, targetModseq = modseq): RemoteAttempt {
  return createRemoteAttempt({
    kind: "attempt",
    planId: "plan:seen",
    action,
    target: {
      accountId,
      mailboxId,
      uidValidity,
      uid,
      precondition: { modseq: targetModseq },
    },
    attemptId: "attempt:seen",
    idempotencyKey: "idempotency:seen",
    startedAt: "2026-08-18T01:00:02.000Z",
    certainty: "unresolved",
  });
}

async function run(
  client: ImapSeenMutationClient,
  action: Action,
  targetModseq = modseq,
): Promise<SeenMutationResult> {
  const attempt = attemptFor(action, targetModseq);
  const plan = createExecutingActionPlan({
    state: "executing",
    planId: "plan:seen",
    action,
    targets: [attempt.target],
    createdAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-18T02:00:00.000Z",
    claimId: "claim:seen",
    startedAt: "2026-08-18T01:00:01.000Z",
  });
  const durableAttempt: DurableAttemptEvidence = {
    claimId: createClaimId("claim:seen"),
    attempt,
  };
  const execution = await executeRemoteAttempt({
    claimedPlan: plan,
    durableAttempt,
    readPrecondition: async () => ({
      kind: "satisfied",
      target: attempt.target,
      observed: { uidValidity, uid, modseq: targetModseq },
    }),
    finalizeStale: async () => "unused",
    markDispatched: async () => undefined,
    mutationAdapter: createSeenMutationAdapter({ client, mailboxPath: "INBOX" }),
  });
  if (execution.kind !== "executed") throw new Error(`expected execution, got ${execution.kind}`);
  if (!isSeenMutationResult(execution.result)) throw new Error("invalid Seen mutation result");
  return execution.result;
}

describe("one-target conditional IMAP Seen/Unseen mutation", () => {
  test("marks Seen with UID STORE, conditional MODSEQ, and a flags/MODSEQ postcondition", async () => {
    const client = new FakeSeenClient();
    const result = await run(client, { kind: "markSeen" });

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.postcondition.flags).toEqual(["\\Flagged", "\\Answered", "\\Seen"]);
      expect(result.postcondition.uidValidity).toBe(uidValidity);
      expect(result.postcondition.modseq).toBe(createMonotonicSequence(8));
    }
    expect(client.calls).toEqual([
      { kind: "getMailboxLock", args: ["INBOX", IMAP_SEEN_MUTATION_LOCK_OPTIONS] },
      {
        kind: "conditionalStore",
        args: [
          {
            range: "42",
            operation: "add",
            flags: [IMAP_SEEN_FLAG],
            options: { uid: true, unchangedSince: 7n },
          },
        ],
      },
      {
        kind: "fetchOne",
        args: ["42", IMAP_SEEN_MUTATION_FETCH_QUERY, IMAP_SEEN_MUTATION_FETCH_OPTIONS],
      },
      { kind: "release", args: [] },
    ]);
    expect(client.calls.some(({ kind }) => /set|delete|expunge|move|copy/i.test(kind))).toBe(false);
  });

  test("marks Unseen by removing only Seen and preserves every unrelated flag", async () => {
    const client = new FakeSeenClient();
    client.flags.add(IMAP_SEEN_FLAG);
    const result = await run(client, { kind: "markUnseen" });

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.postcondition.flags).toEqual(["\\Flagged", "\\Answered"]);
      expect(result.postcondition.flags).not.toContain(IMAP_SEEN_FLAG);
    }
    expect(client.calls.some(({ kind }) => kind === "messageFlagsAdd")).toBe(false);
    expect(client.calls.find(({ kind }) => kind === "conditionalStore")?.args).toEqual([
      {
        range: "42",
        operation: "remove",
        flags: [IMAP_SEEN_FLAG],
        options: { uid: true, unchangedSince: 7n },
      },
    ]);
  });

  test("treats a conditional STORE rejection with a newer MODSEQ as precondition_failed", async () => {
    const client = new FakeSeenClient();
    client.storeResult = "false";
    client.fetchResult = "newer";
    const result = await run(client, { kind: "markSeen" });
    expect(result.kind).toBe("precondition_failed");
    expect(client.calls.map(({ kind }) => kind)).toEqual([
      "getMailboxLock",
      "conditionalStore",
      "fetchOne",
      "release",
    ]);
  });

  test("distinguishes missing, uncertain post-transmission, and definite pre-transmission failures", async () => {
    const missingClient = new FakeSeenClient();
    missingClient.fetchResult = "missing";
    await expect(run(missingClient, { kind: "markSeen" })).resolves.toMatchObject({ kind: "missing" });

    const uncertainClient = new FakeSeenClient();
    uncertainClient.storeError = new Error("socket timeout");
    await expect(run(uncertainClient, { kind: "markSeen" })).resolves.toMatchObject({
      kind: "uncertain_transport",
      phase: "after_transmission",
    });

    const definiteClient = new FakeSeenClient();
    definiteClient.lockError = { beforeTransmission: true };
    await expect(run(definiteClient, { kind: "markSeen" })).resolves.toMatchObject({
      kind: "definite_transport_failure",
      phase: "before_transmission",
    });
  });

  test("does not treat generic tagged NO or BAD as MODIFIED evidence", async () => {
    for (const status of ["NO", "BAD"] as const) {
      const client = new FakeSeenClient();
      client.storeEvidenceOverride = {
        kind: "rejected",
        status,
        certainty: "uncertain",
        phase: "after_transmission",
      };
      await expect(run(client, { kind: "markSeen" })).resolves.toMatchObject({
        kind: "uncertain_transport",
        certainty: "uncertain",
        phase: "after_transmission",
      });
      expect(client.calls.map(({ kind }) => kind)).toEqual([
        "getMailboxLock",
        "conditionalStore",
        "release",
      ]);
    }
  });

  test("keeps MODIFIED as precondition_failed even when the desired flag already exists", async () => {
    const client = new FakeSeenClient();
    client.flags.add(IMAP_SEEN_FLAG);
    client.storeResult = "false";
    const result = await run(client, { kind: "markSeen" });
    expect(result.kind).toBe("precondition_failed");
    expect(result).toMatchObject({ certainty: "definite" });
  });

  test("fails closed before any conditional STORE when CONDSTORE is unavailable", async () => {
    const client = new FakeSeenClient();
    client.enabled.clear();
    const result = await run(client, { kind: "markSeen" });
    expect(result.kind).toBe("precondition_failed");
    expect(client.calls.map(({ kind }) => kind)).toEqual(["getMailboxLock", "release"]);

    const noModseqClient = new FakeSeenClient();
    noModseqClient.mailbox = { path: "INBOX", uidValidity: 938475, noModseq: true };
    const noModseqResult = await run(noModseqClient, { kind: "markSeen" });
    expect(noModseqResult.kind).toBe("precondition_failed");
    expect(noModseqClient.calls.map(({ kind }) => kind)).toEqual(["getMailboxLock", "release"]);

    const rawClient = new FakeSeenClient();
    rawClient.conditionalStore = undefined;
    const rawResult = await run(rawClient, { kind: "markSeen" });
    expect(rawResult.kind).toBe("precondition_failed");
    expect(rawClient.calls.map(({ kind }) => kind)).toEqual(["getMailboxLock", "release"]);
  });

  test("is idempotent when Seen is already present", async () => {
    const client = new FakeSeenClient();
    client.flags.add(IMAP_SEEN_FLAG);
    const result = await run(client, { kind: "markSeen" });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") expect(result.postcondition.flags).toContain(IMAP_SEEN_FLAG);
  });
});

type CapturedMutationFixture = Readonly<{
  readonly selected: Readonly<{ readonly path: string; readonly uidValidity: number }>;
  readonly conditionalStore: Readonly<{
    readonly command: Readonly<{
      readonly name: string;
      readonly uid: string;
      readonly operation: string;
      readonly flags: readonly string[];
      readonly unchangedSince: string;
    }>;
      readonly responses: Readonly<{
        readonly applied: Readonly<{ readonly status: string }>;
        readonly modified: Readonly<{ readonly status: string; readonly code: string; readonly uidSet: string }>;
      }>;
      readonly rawCommandAttributes: readonly unknown[];
      readonly rawResponses: Readonly<{
        readonly applied: Readonly<Record<string, unknown>>;
        readonly modified: Readonly<Record<string, unknown>>;
      }>;
    }>;
  readonly seenPostcondition: Readonly<{
    readonly uid: number;
    readonly flags: readonly string[];
    readonly modseq: number;
  }>;
  readonly postconditionAfterModifiedAlreadyDesired: Readonly<{
    readonly uid: number;
    readonly flags: readonly string[];
    readonly modseq: number;
  }>;
}>;

function fixtureClient(): ImapSeenMutationClient {
  const captured: CapturedMutationFixture = fixture;
  const client = new FakeSeenClient();
  client.mailbox = captured.selected;
  client.responseUid = captured.seenPostcondition.uid;
  client.flags = new Set(captured.seenPostcondition.flags.filter((flag) => flag !== IMAP_SEEN_FLAG));
  client.currentModseq = BigInt(captured.seenPostcondition.modseq - 1);
  return client;
}

const contractSuite: AdapterContractSuite<ImapSeenMutationClient> = {
  name: "one-target Seen mutation over production-shaped ImapFlow responses",
  cases: [
    {
      id: "seen-preserves-unrelated-flags",
      productionRequired: true,
      run: async (client) => {
        const result = await run(client, { kind: "markSeen" });
        expect(result.kind).toBe("applied");
        if (result.kind === "applied") {
          expect(result.postcondition.flags).toContain("\\Flagged");
          expect(result.postcondition.flags).toContain(IMAP_SEEN_FLAG);
        }
      },
    },
  ],
};

const fakeInput: Omit<AdapterFactoryInput<ImapSeenMutationClient>, "kind"> = {
  factory: () => new FakeSeenClient(),
  capabilities: [{ name: "conditional-uid-store", status: "available" }],
};

const productionShapedInput: Omit<AdapterFactoryInput<ImapSeenMutationClient>, "kind"> = {
  factory: fixtureClient,
  capabilities: [{ name: "conditional-uid-store", status: "available" }],
  retainedEvidencePath: "packages/imap/test/fixtures/seen-mutation-production-labeled.json",
};

test("runs the same Seen contract against fake and production-shaped responses", async () => {
  const evidence = await runAdapterContractParity({
    suite: contractSuite,
    fake: fakeInput,
    production: productionShapedInput,
  });
  expect(evidence.fake.status).toBe("incomplete");
  expect(evidence.productionEvidence).toEqual({
    status: "available",
    adapterKind: "production",
    result: expect.objectContaining({ status: "passed" }),
  });
  expect(evidence.semanticParity.status).toBe("matched");
});

test("retains the exact conditional UID STORE command and tagged responses", () => {
  const captured: CapturedMutationFixture = fixture;
  expect({
    command: captured.conditionalStore.command,
    responses: captured.conditionalStore.responses,
  }).toEqual({
    command: {
      name: "UID STORE",
      uid: "42",
      operation: "+FLAGS",
      flags: [IMAP_SEEN_FLAG],
      unchangedSince: "7",
    },
    responses: {
      applied: { status: "OK" },
      modified: { status: "NO", code: "MODIFIED", uidSet: "42" },
      },
  });
  expect(captured.conditionalStore.rawCommandAttributes).toEqual([
    { type: "SEQUENCE", value: "42" },
    [
      { type: "ATOM", value: "UNCHANGEDSINCE" },
      { type: "ATOM", value: "7" },
    ],
    { type: "ATOM", value: "+FLAGS" },
    [{ type: "ATOM", value: IMAP_SEEN_FLAG }],
  ]);
  expect(captured.postconditionAfterModifiedAlreadyDesired.flags).toContain(IMAP_SEEN_FLAG);
  expect(captured.conditionalStore.rawResponses.modified).toMatchObject({
    command: "OK",
    attributes: [expect.objectContaining({
      section: [
        expect.objectContaining({ value: "MODIFIED" }),
        expect.objectContaining({ value: "42" }),
      ],
    })],
  });
});
