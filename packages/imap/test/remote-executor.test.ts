import { describe, expect, test } from "bun:test";
import {
  createMonotonicSequence,
  createRemoteAttempt,
  createRemoteUidValue,
  createUidValidity,
  type RemoteAttempt,
} from "@agent-mail/core";
import { executeRemoteAttempt } from "../src/remote-executor";
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
      attempt,
      readPrecondition: async () => observation,
      finalizeStale: async ({ observation: staleObservation }) => {
        finalized += 1;
        expect(staleObservation.kind).toBe(observation.kind);
        return { kind: "stale", certainty: "definite" };
      },
      requestMutationCapability: async () => {
        capabilityRequests += 1;
        return {
          execute: async () => {
            mutationCalls += 1;
            return "moved";
          },
        };
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
      attempt,
      readPrecondition: async () => ({
        kind: "epoch_changed",
        target: attempt.target,
        observedUidValidity: createUidValidity(10),
      }),
      finalizeStale: async ({ observation }) => observation.kind,
      requestMutationCapability: async () => {
        capabilityRequests += 1;
        throw new Error("mutation capability must not be requested");
      },
    });

    expect(result.kind).toBe("stale");
    expect(capabilityRequests).toBe(0);
  });
});
