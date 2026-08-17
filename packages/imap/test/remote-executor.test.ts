import { describe, expect, test } from "bun:test";
import {
  createClaimId,
  createExecutingActionPlan,
  createMonotonicSequence,
  createRemoteAttempt,
  createRemoteUidValue,
  createUidValidity,
  type RemoteAttempt,
} from "@agent-mail/core";
import {
  executeRemoteAttempt,
  executeWithRemoteMutationCapability,
  type DurableAttemptEvidence,
  type RemoteMutationRequest,
} from "../src/remote-executor";
import type { PreconditionObservation } from "../src/precondition";

const attempt: RemoteAttempt = createRemoteAttempt({
  kind: "attempt",
  planId: "plan:one",
  action: { kind: "moveToArchive" },
  target: {
    accountId: "account:one",
    mailboxId: "mailbox:inbox",
    uidValidity: 9,
    uid: 7,
    precondition: { modseq: 101 },
  },
  attemptId: "attempt:one",
  idempotencyKey: "idempotency:one",
  startedAt: "2026-08-18T01:00:02.000Z",
  certainty: "unresolved",
});

const claimedPlan = createExecutingActionPlan({
  state: "executing",
  planId: "plan:one",
  action: { kind: "moveToArchive" },
  targets: [attempt.target],
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T02:00:00.000Z",
  claimId: "claim:one",
  startedAt: "2026-08-18T01:00:01.000Z",
});

const durableAttempt: DurableAttemptEvidence = {
  claimId: createClaimId("claim:one"),
  attempt,
};

describe("remote stale-result executor gate", () => {
  test("newer MODSEQ MOVE returns stale before requesting mutation capability", async () => {
    let capabilityRequests = 0;
    let mutationCalls = 0;
    let finalized = 0;
    const observation: PreconditionObservation = {
      kind: "stale",
      target: attempt.target,
      observed: {
        uidValidity: createUidValidity(9),
        uid: createRemoteUidValue(7),
        modseq: createMonotonicSequence(102),
      },
      reason: "newer-modseq",
    };

    const result = await executeRemoteAttempt({
      claimedPlan,
      durableAttempt,
      readPrecondition: async () => observation,
      finalizeStale: async ({ observation: staleObservation }) => {
        finalized += 1;
        expect(staleObservation.kind).toBe(observation.kind);
        return { kind: "stale", certainty: "definite" };
      },
      mutationAdapter: {
        execute: async () => {
          capabilityRequests += 1;
          mutationCalls += 1;
          return "moved";
        },
      },
    });

    expect(result.kind).toBe("stale");
    expect(capabilityRequests).toBe(0);
    expect(mutationCalls).toBe(0);
    expect(finalized).toBe(1);
  });

  test("changed UIDVALIDITY follows the same no-effect branch", async () => {
    let capabilityRequests = 0;
    const result = await executeRemoteAttempt({
      claimedPlan,
      durableAttempt,
      readPrecondition: async () => ({
        kind: "epoch_changed",
        target: attempt.target,
        observedUidValidity: createUidValidity(10),
      }),
      finalizeStale: async ({ observation }) => observation.kind,
      mutationAdapter: {
        execute: async () => {
          capabilityRequests += 1;
          throw new Error("mutation capability must not be requested");
        },
      },
    });

    expect(result.kind).toBe("stale");
    expect(capabilityRequests).toBe(0);
  });

  test("satisfied observation issues one capability to the adapter", async () => {
    let request: RemoteMutationRequest | undefined;
    const observation: PreconditionObservation = {
      kind: "satisfied",
      target: attempt.target,
      observed: {
        uidValidity: createUidValidity(9),
        uid: createRemoteUidValue(7),
        modseq: createMonotonicSequence(101),
      },
    };

    const result = await executeRemoteAttempt({
      claimedPlan,
      durableAttempt,
      readPrecondition: async () => observation,
      finalizeStale: async () => {
        throw new Error("satisfied observation cannot finalize stale");
      },
      mutationAdapter: {
        execute: async (value) => {
          request = value;
          return "moved";
        },
      },
    });

    expect(result).toMatchObject({ kind: "executed", result: "moved" });
    expect(request?.attempt).toBe(attempt);
    expect(request?.capability).toBeDefined();
    expect(Object.isFrozen(request?.capability)).toBe(true);

    const captured = request;
    if (captured === undefined) throw new Error("expected captured mutation request");
    const otherAttempt = createRemoteAttempt({
      ...attempt,
      attemptId: "attempt:other",
    });
    expect(() =>
      executeWithRemoteMutationCapability(
        { execute: async () => "cross-attempt" },
        captured.capability,
        otherAttempt,
      ),
    ).toThrow("remote mutation capability was not issued by the internal executor");

    expect(() =>
      executeWithRemoteMutationCapability(
        { execute: async () => "replayed" },
        captured.capability,
        captured.attempt,
      ),
    ).toThrow("remote mutation capability was not issued by the internal executor");
  });

  test("rejects a forged structural token at the runtime guard", () => {
    const forged: unknown = Object.create(null);
    // @ts-expect-error Runtime callers cannot forge the nominal capability type.
    expect(() => executeWithRemoteMutationCapability({ execute: async () => "forged" }, forged, attempt)).toThrow(
      "remote mutation capability was not issued by the internal executor",
    );
  });

  test("rejects mismatched satisfied evidence before the adapter can run", async () => {
    const observation: PreconditionObservation = {
      kind: "satisfied",
      target: { ...attempt.target, uid: createRemoteUidValue(8) },
      observed: {
        uidValidity: createUidValidity(9),
        uid: createRemoteUidValue(8),
        modseq: createMonotonicSequence(101),
      },
    };

    await expect(
      executeRemoteAttempt({
        claimedPlan,
        durableAttempt,
        readPrecondition: async () => observation,
        finalizeStale: async () => "unused",
        mutationAdapter: { execute: async () => "must not run" },
      }),
    ).rejects.toThrow("remote mutation evidence is not coherent");
  });
});
