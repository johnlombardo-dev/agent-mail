import {
  createClaimId,
  createExecutingActionPlan,
  createMonotonicSequence,
  createRemoteAttempt,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import type {
  DurableAttemptEvidence,
  RemoteMutationAdapter,
  RemoteMutationCapability,
  RemoteMutationCapabilityEvidence,
  RemoteMutationRequest,
} from "../src/remote-executor";

const attempt = createRemoteAttempt({
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
const plan = createExecutingActionPlan({
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
const satisfiedEvidence: RemoteMutationCapabilityEvidence = {
  claimedPlan: plan,
  durableAttempt,
  observation: {
    kind: "satisfied",
    target: attempt.target,
    observed: {
      uidValidity: createUidValidity(9),
      uid: createRemoteUidValue(7),
      modseq: createMonotonicSequence(101),
    },
  },
};

void satisfiedEvidence;

const internalAdapter: RemoteMutationAdapter = {
  execute: async (request: RemoteMutationRequest) => request.attempt,
};
void internalAdapter;

// @ts-expect-error The capability is issued by the module-private constructor.
const forgedCapability: RemoteMutationCapability = {};
void forgedCapability;

// @ts-expect-error A satisfied observation is required before capability issuance.
const missingSatisfiedEvidence: RemoteMutationCapabilityEvidence = {
  claimedPlan: plan,
  durableAttempt,
};
void missingSatisfiedEvidence;

// @ts-expect-error A raw adapter call without the capability is not an internal mutation path.
void internalAdapter.execute({ attempt });

// @ts-expect-error Service/CLI code cannot import the module-private constructor.
import { createRemoteMutationCapability } from "../src/remote-executor";
void createRemoteMutationCapability;
