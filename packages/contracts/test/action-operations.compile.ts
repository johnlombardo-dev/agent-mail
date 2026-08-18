import type { z } from "zod";
import {
  expiredActionPlanSchema,
  failedActionPlanSchema,
  actionPlanSchema,
  perTargetResultSchema,
  uncertainReconciliationRequestSchema,
} from "../src/action-operations";

type ActionPlan = z.infer<typeof actionPlanSchema>;
type FailedActionPlan = z.infer<typeof failedActionPlanSchema>;
type ExpiredActionPlan = z.infer<typeof expiredActionPlanSchema>;
type PerTargetResult = z.infer<typeof perTargetResultSchema>;
type ReconciliationRequest = z.infer<typeof uncertainReconciliationRequestSchema>;

const plan: ActionPlan = {
  state: "partial",
  planId: "plan:one",
  action: { kind: "moveToArchive" },
  targets: [{
    accountId: "account:one",
    mailboxId: "mailbox:inbox",
    uidValidity: 42,
    uid: 7,
    precondition: { modseq: 12 },
  }],
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T01:00:00.000Z",
  completedAt: "2026-08-18T00:03:00.000Z",
};

const failedPlan: FailedActionPlan = {
  state: "failed",
  planId: "plan:one",
  action: { kind: "moveToArchive" },
  targets: plan.targets,
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T01:00:00.000Z",
  failedAt: "2026-08-18T00:03:00.000Z",
};

const expiredPlan: ExpiredActionPlan = {
  state: "expired",
  planId: "plan:one",
  action: { kind: "moveToArchive" },
  targets: plan.targets,
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T01:00:00.000Z",
  expiredAt: "2026-08-18T01:00:00.000Z",
};

const result: PerTargetResult = {
  kind: "uncertain",
  certainty: "uncertain",
  planId: "plan:one",
  action: { kind: "moveToArchive" },
  target: plan.targets[0],
  attemptId: "attempt:one",
  idempotencyKey: "idempotency:one",
  startedAt: "2026-08-18T00:01:00.000Z",
  resultAt: "2026-08-18T00:02:00.000Z",
  uncertainReason: "local-result-not-durable",
  detail: "the local result was not durable",
};

const reconciliation: ReconciliationRequest = {
  planId: result.planId,
  attemptId: result.attemptId,
  result,
};

void plan;
void failedPlan;
void expiredPlan;
void reconciliation;
