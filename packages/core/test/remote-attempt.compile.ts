import {
  createSafeOperatorDetail,
  createRemoteIdempotencyKey,
  type RemoteAttempt,
  type RemoteAttemptResult,
  type ServerObservedPostcondition,
} from "../src/remote-attempt";
import { createActionPlanId, createRemoteAttemptId, type Action } from "../src/action-plan";
import {
  createAccountId,
  createMailboxId,
  createRemoteUidValue,
  createUidValidity,
} from "../src/identifiers";
import { createMonotonicSequence, createUtcInstant } from "../src/time-cursor";

const action: Action = { kind: "markSeen" };
const target = {
  accountId: createAccountId("one"),
  mailboxId: createMailboxId("inbox"),
  uidValidity: createUidValidity(42),
  uid: createRemoteUidValue(7),
  precondition: { modseq: createMonotonicSequence(12) },
};
const common = {
  planId: createActionPlanId("one"),
  action,
  target,
  attemptId: createRemoteAttemptId("one"),
  idempotencyKey: createRemoteIdempotencyKey("stable-key"),
  startedAt: createUtcInstant("2026-08-18T00:01:00.000Z"),
  resultAt: createUtcInstant("2026-08-18T00:02:00.000Z"),
};

const postcondition: ServerObservedPostcondition = {
  kind: "flags",
  observedAt: createUtcInstant("2026-08-18T00:01:30.000Z"),
  flags: ["\\Seen"],
  modseq: createMonotonicSequence(13),
};

const attempt: RemoteAttempt = {
  ...common,
  kind: "attempt",
  certainty: "unresolved",
};

const success: RemoteAttemptResult = {
  ...common,
  kind: "success",
  certainty: "definite",
  postcondition,
};

function certainty(value: RemoteAttempt | RemoteAttemptResult): string {
  switch (value.kind) {
    case "attempt":
      return value.certainty;
    case "success":
    case "stale":
    case "rejected":
    case "failed":
    case "uncertain":
      return value.certainty;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

void attempt;
void success;
void certainty;

// @ts-expect-error Success cannot omit the server-observed postcondition.
const missingPostcondition: RemoteAttemptResult = {
  ...common,
  kind: "success",
  certainty: "definite",
};

const timeoutAsFailure: RemoteAttemptResult = {
  ...common,
  kind: "failed",
  certainty: "definite",
  // @ts-expect-error A transmitted timeout is not a definite failure reason.
  failureReason: "socket-timeout-after-transmission",
  detail: createSafeOperatorDetail("timeout"),
};

void missingPostcondition;
void timeoutAsFailure;
