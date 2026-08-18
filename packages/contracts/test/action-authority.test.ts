import { describe, expect, it } from "bun:test";
import {
  actionAuthorityOperationDefinitions,
  actionPlanApproveRequestSchema,
  actionPlanAuthorityCommitRequestSchema,
  actionPlanCancelApprovalRequestSchema,
  actionApprovalSchema,
  consumptionReceiptSchema,
} from "../src/action-authority";

const digest = "a".repeat(64);

describe("Policy-A authority contracts", () => {
  it("publishes approve/cancel/commit with strict identity-free requests", () => {
    expect(actionAuthorityOperationDefinitions.map((operation) => operation.key)).toEqual([
      "operator-sessions.create",
      "action-plans.approve",
      "action-plans.cancel-approval",
      "action-plans.commit",
    ]);
    expect(actionAuthorityOperationDefinitions.some((operation) => operation.key.includes("authorize"))).toBe(false);
    expect(actionPlanApproveRequestSchema.parse({ planId: "plan:one", planVersion: 1, previewDigest: digest })).toEqual({ planId: "plan:one", planVersion: 1, previewDigest: digest });
    expect(() => actionPlanApproveRequestSchema.parse({ planId: "plan:one", planVersion: 1, previewDigest: digest, principalId: "spoof" })).toThrow();
    expect(actionPlanCancelApprovalRequestSchema.parse({ planId: "plan:one", approvalId: "approval:one", planVersion: 1, previewDigest: digest })).toHaveProperty("approvalId", "approval:one");
    expect(actionPlanAuthorityCommitRequestSchema.parse({ planId: "plan:one", planVersion: 1, previewDigest: digest, approvalId: "approval:one" })).toHaveProperty("approvalId", "approval:one");
  });

  it("keeps safe approval and receipt projections constructive", () => {
    const approval = actionApprovalSchema.parse({ state: "available", approvalId: "approval:one", planId: "plan:one", planVersion: 1, previewDigest: digest, targetDigest: digest, normalizedIntent: "[\"action-intent-v1\"]", issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:10:00.000Z", authorizationScope: "mail:action.commit", approver: { principalId: "principal:operator", profile: "operator-interactive" } });
    expect(approval.state).toBe("available");
    expect(() => actionApprovalSchema.parse({ ...approval, seal: digest })).toThrow();
    const receipt = consumptionReceiptSchema.parse({ receiptId: "approval-receipt:one", approvalId: approval.approvalId, planId: approval.planId, claimId: "claim:one", consumedAt: "2026-08-18T00:00:01.000Z", committer: { principalId: "principal:agent", profile: "agent-unattended" }, executorProfile: "internal-action-executor" });
    expect(receipt.committer.profile).toBe("agent-unattended");
  });
});
