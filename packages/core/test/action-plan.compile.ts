import {
  createActionPlanId,
  type ActionPlan,
  type ActionPlanEvent,
  type ActionPlanState,
} from "../src/action-plan";
import {
  createAccountId,
  createMailboxId,
  createRemoteUidValue,
  createUidValidity,
} from "../src/identifiers";
import { createMonotonicSequence, createUtcInstant } from "../src/time-cursor";

const planId = createActionPlanId("plan:one");
const accountId = createAccountId("account:one");
const mailboxId = createMailboxId("mailbox:inbox");
const uidValidity = createUidValidity(42);
const uid = createRemoteUidValue(7);
const modseq = createMonotonicSequence(12);
const createdAt = createUtcInstant("2026-08-18T00:00:00.000Z");
const expiresAt = createUtcInstant("2026-08-18T01:00:00.000Z");
const target = { accountId, mailboxId, uidValidity, uid, precondition: { modseq } };

function describeState(plan: ActionPlan): string {
  switch (plan.state) {
    case "pending":
      return plan.planId;
    case "executing":
      return plan.claimId;
    case "completed":
      return plan.completedAt;
    case "partial":
      return plan.completedAt;
    case "failed":
      return plan.failedAt;
    case "rejected":
      return plan.reason;
    case "expired":
      return plan.expiredAt;
    case "uncertain":
      return plan.remoteAttemptId;
    case "restore-quarantined":
      return plan.planId;
    default: {
      const exhaustive: never = plan;
      return exhaustive;
    }
  }
}

function describeEvent(event: ActionPlanEvent): ActionPlanState {
  switch (event.type) {
    case "claim":
      return "executing";
    case "complete":
      return "completed";
    case "partial":
      return "partial";
    case "fail":
      return "failed";
    case "reject":
      return "rejected";
    case "expire":
      return "expired";
    case "uncertain":
      return "uncertain";
    case "resolve-completed":
      return "completed";
    case "resolve-partial":
      return "partial";
    case "resolve-failed":
      return "failed";
    case "resolve-rejected":
      return "rejected";
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

void describeState;
void describeEvent;

// @ts-expect-error Executing requires a claim identity and start time.
const missingClaim: ActionPlan = {
  state: "executing",
  planId,
  action: { kind: "markSeen" },
  targets: [target],
  createdAt,
  expiresAt,
};

// @ts-expect-error Uncertain requires a remote attempt identity and boundary.
const missingAttempt: ActionPlan = {
  state: "uncertain",
  planId,
  action: { kind: "markSeen" },
  targets: [target],
  createdAt,
  expiresAt,
  missingLocalResultAt: createdAt,
};

void missingClaim;
void missingAttempt;
