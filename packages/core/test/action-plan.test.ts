import { describe, expect, it } from "bun:test";
import {
  ACTION_PLAN_ALLOWED_TRANSITIONS,
  ActionPlanTransitionError,
  createActionPlan,
  createActionPlanEvent,
  createCompletedActionPlan,
  createUncertainActionPlan,
  parseActionPlan,
  serializeActionPlan,
  transitionActionPlan,
} from "../src/action-plan";

const target = {
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 42,
  uid: 7,
  precondition: { modseq: 12 },
};
const base = {
  planId: "plan:one",
  action: { kind: "markSeen" },
  targets: [target],
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T01:00:00.000Z",
} as const;

describe("action-plan algebra", () => {
  it("round-trips every state with only state-valid fields", () => {
    const pending = createActionPlan({ state: "pending", ...base });
    const executing = transitionActionPlan(
      pending,
      createActionPlanEvent({
        type: "claim",
        claimId: "claim:one",
        startedAt: "2026-08-18T00:01:00.000Z",
      }),
    );
    const completed = transitionActionPlan(
      executing,
      createActionPlanEvent({
        type: "complete",
        completedAt: "2026-08-18T00:02:00.000Z",
      }),
    );
    expect(completed.state).toBe("completed");
    expect(parseActionPlan(JSON.parse(JSON.stringify(serializeActionPlan(completed))))).toEqual(
      completed,
    );

    const partial = createActionPlan({
      state: "partial",
      ...base,
      targets: [target, { ...target, uid: 8 }],
      completedAt: "2026-08-18T00:02:00.000Z",
    });
    const rejected = createActionPlan({
      ...base,
      state: "rejected",
      rejectedAt: base.createdAt,
      reason: "not confirmed",
    });
    const expired = createActionPlan({ ...base, state: "expired", expiredAt: base.expiresAt });
    const uncertain = createActionPlan({
      ...base,
      state: "uncertain",
      remoteAttemptId: "attempt:one",
      missingLocalResultAt: "2026-08-18T00:02:00.000Z",
    });
    expect(
      [pending, executing, completed, partial, rejected, expired, uncertain].map(
        (item) => item.state,
      ),
    ).toEqual(["pending", "executing", "completed", "partial", "rejected", "expired", "uncertain"]);
  });

  it("follows the complete allowed transition table", () => {
    expect(ACTION_PLAN_ALLOWED_TRANSITIONS).toEqual({
      pending: ["claim", "reject", "expire"],
      executing: ["complete", "partial", "uncertain"],
      uncertain: ["resolve-completed", "resolve-partial", "resolve-rejected"],
      completed: [],
      partial: [],
      rejected: [],
      expired: [],
    });
    const pending = createActionPlan({ state: "pending", ...base });
    const claim = createActionPlanEvent({
      type: "claim",
      claimId: "claim:one",
      startedAt: base.createdAt,
    });
    const executing = transitionActionPlan(pending, claim);
    expect(
      transitionActionPlan(
        pending,
        createActionPlanEvent({ type: "reject", rejectedAt: base.createdAt, reason: "cancelled" }),
      ).state,
    ).toBe("rejected");
    expect(
      transitionActionPlan(
        pending,
        createActionPlanEvent({ type: "expire", expiredAt: base.expiresAt }),
      ).state,
    ).toBe("expired");
    expect(
      transitionActionPlan(
        executing,
        createActionPlanEvent({ type: "complete", completedAt: base.createdAt }),
      ).state,
    ).toBe("completed");
    expect(
      transitionActionPlan(
        executing,
        createActionPlanEvent({ type: "partial", completedAt: base.createdAt }),
      ).state,
    ).toBe("partial");
    const uncertain = transitionActionPlan(
      executing,
      createActionPlanEvent({
        type: "uncertain",
        remoteAttemptId: "attempt:one",
        missingLocalResultAt: "2026-08-18T00:02:00.000Z",
      }),
    );
    expect(uncertain.state).toBe("uncertain");
    expect(
      transitionActionPlan(
        uncertain,
        createActionPlanEvent({
          type: "resolve-completed",
          completedAt: "2026-08-18T00:03:00.000Z",
        }),
      ).state,
    ).toBe("completed");
    expect(
      transitionActionPlan(
        uncertain,
        createActionPlanEvent({ type: "resolve-partial", completedAt: "2026-08-18T00:03:00.000Z" }),
      ).state,
    ).toBe("partial");
    expect(
      transitionActionPlan(
        uncertain,
        createActionPlanEvent({
          type: "resolve-rejected",
          rejectedAt: "2026-08-18T00:03:00.000Z",
          reason: "remote failed",
        }),
      ).state,
    ).toBe("rejected");
  });

  it("rejects malformed values, illegal transitions, and uncertain plans without attempt identity", () => {
    const malformed: unknown[] = [
      { state: "pending", ...base, targets: [] },
      { state: "pending", ...base, targets: [{ ...target, precondition: { modseq: -1 } }] },
      { state: "pending", ...base, targets: [{ ...target, extra: true }] },
      { state: "pending", ...base, targets: [target, target] },
      { ...base, state: "uncertain", missingLocalResultAt: base.createdAt },
      {
        ...base,
        state: "uncertain",
        remoteAttemptId: "attempt:one",
        missingLocalResultAt: "not-time",
      },
      {
        ...base,
        state: "uncertain",
        remoteAttemptId: "attempt:one",
        missingLocalResultAt: "2026-08-17T23:59:59.000Z",
      },
      { type: "claim", claimId: "claim:one", startedAt: base.createdAt, extra: true },
    ];
    for (const value of malformed) expect(() => createActionPlan(value)).toThrow();
    expect(() => createUncertainActionPlan(malformed[4])).toThrow();

    const pending = createActionPlan({ state: "pending", ...base });
    const executing = transitionActionPlan(
      pending,
      createActionPlanEvent({
        type: "claim",
        claimId: "claim:three",
        startedAt: "2026-08-18T00:10:00.000Z",
      }),
    );
    expect(() =>
      transitionActionPlan(
        executing,
        createActionPlanEvent({ type: "complete", completedAt: "2026-08-18T00:09:00.000Z" }),
      ),
    ).toThrow(ActionPlanTransitionError);
    const completed = createCompletedActionPlan({
      ...base,
      state: "completed",
      completedAt: base.createdAt,
    });
    expect(() =>
      transitionActionPlan(
        completed,
        createActionPlanEvent({ type: "claim", claimId: "claim:two", startedAt: base.createdAt }),
      ),
    ).toThrow(ActionPlanTransitionError);
    expect(() =>
      transitionActionPlan(
        pending,
        createActionPlanEvent({ type: "complete", completedAt: base.createdAt }),
      ),
    ).toThrow(ActionPlanTransitionError);
  });
});
