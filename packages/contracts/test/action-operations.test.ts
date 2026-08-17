import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  actionPlanAuthorizeOperation,
  actionPlanAuthorizeRequestSchema,
  actionPlanCommitOperation,
  actionPlanCommitRequestSchema,
  actionPlanCommitResponseSchema,
  actionPlanCreateOperation,
  actionPlanInspectOperation,
  actionPlanOperationDefinitions,
  actionPlanPreviewResponseSchema,
  actionPlanSchema,
  assertPublicActionOperation,
  createActionOperationRegistry,
  perTargetResultSchema,
  remoteAttemptResultSchema,
  uncertainReconciliationRequestSchema,
} from "../src/action-operations";
import { defineOperation } from "../src/operation-registry";

const target = {
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 42,
  uid: 7,
  precondition: { modseq: 12 },
} as const;

const basePlan = {
  planId: "plan:one",
  action: { kind: "markSeen" },
  targets: [target, { ...target, uid: 8 }],
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T01:00:00.000Z",
} as const;

const attemptBase = {
  planId: basePlan.planId,
  action: basePlan.action,
  target,
  attemptId: "attempt:one",
  idempotencyKey: "idempotency:one",
  startedAt: "2026-08-18T00:01:00.000Z",
  resultAt: "2026-08-18T00:02:00.000Z",
} as const;

const success = {
  ...attemptBase,
  kind: "success",
  certainty: "definite",
  postcondition: {
    kind: "flags",
    observedAt: "2026-08-18T00:01:30.000Z",
    flags: ["\\Seen"],
    modseq: 13,
  },
} as const;

const uncertain = {
  ...attemptBase,
  kind: "uncertain",
  certainty: "uncertain",
  uncertainReason: "socket-timeout-after-transmission",
  detail: "the command was sent before the socket timed out",
} as const;

describe("remote action operation contracts", () => {
  it("round-trips partial plans and preserves each target/result identity", () => {
    const plan = actionPlanSchema.parse({
      ...basePlan,
      state: "partial",
      completedAt: "2026-08-18T00:03:00.000Z",
    });
    const results = [success, { ...success, target: { ...target, uid: 8 }, attemptId: "attempt:two" }, uncertain];
    const parsedResults = results.map((result) => perTargetResultSchema.parse(result));

    expect(plan.state).toBe("partial");
    expect(parsedResults).toHaveLength(3);
    expect(parsedResults.map((result) => result.target.uid)).toEqual([7, 8, 7]);
    expect(parsedResults.map((result) => result.attemptId)).toEqual([
      "attempt:one",
      "attempt:two",
      "attempt:one",
    ]);
    expect(parsedResults.map((result) => result.certainty)).toEqual([
      "definite",
      "definite",
      "uncertain",
    ]);
  });

  it("keeps uncertain reconciliation explicit and rejects boolean collapse", () => {
    const request = uncertainReconciliationRequestSchema.parse({
      planId: basePlan.planId,
      attemptId: uncertain.attemptId,
      result: uncertain,
    });
    expect(request.result.certainty).toBe("uncertain");
    expect(request.result.attemptId).toBe(request.attemptId);
    expect(() => uncertainReconciliationRequestSchema.parse({
      ...request,
      attemptId: "attempt:other",
    })).toThrow();
    expect(() => uncertainReconciliationRequestSchema.parse({
      ...request,
      result: { ...uncertain, certainty: true },
    })).toThrow();
    expect(() => remoteAttemptResultSchema.parse({
      ...success,
      certainty: true,
    })).toThrow();
    expect(() => remoteAttemptResultSchema.parse({
      ...uncertain,
      detail: "Authorization: Bearer secret-value",
    })).toThrow();
  });

  it("rejects duplicate immutable identities, missing MODSEQ, and unknown fields", () => {
    expect(() => actionPlanSchema.parse({
      ...basePlan,
      state: "pending",
      targets: [target, target],
    })).toThrow();
    expect(() => actionPlanSchema.parse({
      ...basePlan,
      state: "pending",
      targets: [{ ...target, precondition: {} }],
    })).toThrow();
    expect(() => actionPlanSchema.parse({
      ...basePlan,
      state: "pending",
      executor: "executeRaw",
    })).toThrow();
    expect(() => actionPlanPreviewResponseSchema.parse({
      plan: { ...basePlan, state: "pending" },
      digest: "a".repeat(64),
      rawExecutor: true,
    })).toThrow();
    expect(() => actionPlanSchema.parse({
      ...basePlan,
      state: "expired",
      expiredAt: "2026-08-18T00:30:00.000Z",
    })).toThrow();
    expect(() => actionPlanCommitResponseSchema.parse({
      plan: {
        ...basePlan,
        state: "partial",
        completedAt: "2026-08-18T00:03:00.000Z",
      },
      results: [{ ...success, planId: "plan:other" }],
    })).toThrow();
  });

  it("defines create, inspect, authorize, and commit with strict public scopes", () => {
    expect(actionPlanOperationDefinitions.map((operation) => operation.key)).toEqual([
      "action-plans.create",
      "action-plans.inspect",
      "action-plans.authorize",
      "action-plans.commit",
    ]);
    expect(actionPlanOperationDefinitions.every((operation) => operation.strictness === "strict")).toBe(true);
    expect(actionPlanCreateOperation.scope).toBe("mail:action.create");
    expect(actionPlanInspectOperation.scope).toBe("mail:action.inspect");
    expect(actionPlanAuthorizeOperation.scope).toBe("mail:action.authorize");
    expect(actionPlanCommitOperation.scope).toBe("mail:action.commit");
    expect(createActionOperationRegistry(actionPlanOperationDefinitions).operations).toHaveLength(4);
    expect(actionPlanAuthorizeRequestSchema.parse({
      planId: basePlan.planId,
      digest: "a".repeat(64),
      intent: "Approve the exact frozen targets",
    }).intent).toContain("frozen");
    expect(actionPlanCommitRequestSchema.parse({
      planId: basePlan.planId,
      digest: "a".repeat(64),
      authorizationId: "authorization:one",
    }).authorizationId).toBe("authorization:one");
  });

  it("rejects an executeRaw operation before registry construction", () => {
    const executeRaw = defineOperation({
      key: "action-plans.execute-raw",
      route: "/v1/action-plans/executeRaw",
      cliName: "action-plans-execute-raw",
      scope: "mail:action.execute-raw",
      request: z.strictObject({ target: z.string() }),
      response: z.strictObject({ ok: z.boolean() }),
      streaming: "none",
      strictness: "strict",
    });
    expect(() => assertPublicActionOperation(executeRaw)).toThrow(/executor-shaped/);
    expect(() => createActionOperationRegistry([executeRaw])).toThrow(/executor-shaped/);
  });
});
