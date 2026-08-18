import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  actionPlanAuthorizeResponseSchema,
  actionPlanCommitResponseSchema,
  actionPlanInspectResponseSchema,
  actionPlanPreviewResponseSchema,
  type ActionPlanContract,
  type ActionPlanTarget,
} from "@agent-mail/contracts";
import { actionPlanCreateRequestSchema } from "@agent-mail/contracts";
import type { RemoteAttempt, RemoteAttemptResult } from "@agent-mail/core";
import type { PreconditionObservation } from "../../imap/src/precondition";
import {
  applyMigrations,
} from "../../storage/src/migration-runner";
import {
  actionAttemptDispatchMigrations,
} from "../../storage/src/migrations/0005-action-attempt-dispatch";
import {
  actionResultReconciliationMigration,
} from "../../storage/src/migrations/0007-action-result-reconciliation";
import { operationalJournalMigration } from "../../storage/src/migrations/0001-operational-journal";
import {
  createPendingActionPlan,
  readPendingActionPlan,
  type PendingActionPlanProposal,
} from "../../storage/src/action-plan-repository";
import { claimPendingActionPlan } from "../../storage/src/action-plan-claim";
import { readActionPlanResult } from "../../storage/src/action-plan-result";
import { finalizeActionPlan } from "../../storage/src/action-plan-finalization";
import {
  runActionPlanTargetLoop,
  type ActionPlanTargetLoopOptions,
} from "../src/action-plan-target-loop";
import {
  createActionPlanHandlers,
  type ActionPlanServices,
} from "../src/action-plan-handlers";
import {
  createHttpApp,
  publicOperationRegistry,
  type HttpCredentialResolution,
} from "../src/http";

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const createdAt = "2026-08-18T00:00:00.000Z";
const expiresAt = "2026-08-18T01:00:00.000Z";
const commitAt = "2026-08-18T00:00:02.000Z";
const authorizationScope = "mail:action.authorize";

const targetOne: ActionPlanTarget = {
  accountId: "account:http-real",
  mailboxId: "mailbox:inbox-real",
  uidValidity: 9,
  uid: 7,
  precondition: { modseq: 101 },
};
const targetTwo: ActionPlanTarget = {
  ...targetOne,
  mailboxId: "mailbox:archive-real",
  uid: 8,
};
const action = { kind: "markSeen" as const };

type Mode = "success" | "partial" | "stale" | "failed" | "uncertain" | "expired";
type PlanRecord = Readonly<{
  readonly proposal: PendingActionPlanProposal;
  readonly authorizationId: string;
  readonly mode: Mode;
}>;

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  applyMigrations(database, actionAttemptDispatchMigrations);
  database.exec(operationalJournalMigration.sql);
  database.exec(actionResultReconciliationMigration.sql);
  return database;
}

function authenticate(credential: string): HttpCredentialResolution {
  const operation = publicOperationRegistry.get(credential);
  return operation === undefined
    ? { kind: "invalid" }
    : { kind: "authenticated", principal: { subject: "real-http-test", scopes: [operation.scope] } };
}

function request(
  path: string,
  method: "GET" | "POST",
  operationKey: string,
  body?: unknown,
): Request {
  const headers = new Headers({ authorization: `Bearer ${operationKey}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function publicPlan(proposal: PendingActionPlanProposal): ActionPlanContract {
  return {
    state: "pending",
    planId: proposal.planId,
    action: proposal.action,
    targets: proposal.targets,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
  };
}

function terminalPlan(
  proposal: PendingActionPlanProposal,
  state: Exclude<ActionPlanContract["state"], "pending" | "executing">,
  at: string,
  remoteAttemptId?: string,
): ActionPlanContract {
  const base = {
    planId: proposal.planId,
    action: proposal.action,
    targets: proposal.targets,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
  };
  switch (state) {
    case "completed":
    case "partial":
      return { ...base, state, completedAt: at };
    case "failed":
      return { ...base, state, failedAt: at };
    case "rejected":
      return { ...base, state, rejectedAt: at, reason: "all targets were rejected or stale" };
    case "expired":
      return { ...base, state, expiredAt: proposal.expiresAt };
    case "uncertain":
      if (remoteAttemptId === undefined) throw new Error("uncertain result has no attempt identity");
      return { ...base, state, remoteAttemptId, missingLocalResultAt: at };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function resultFor(
  attempt: RemoteAttempt,
  resultAt: string,
  mode: Exclude<Mode, "expired" | "partial" | "stale">,
): RemoteAttemptResult {
  if (mode === "success") {
    return {
      kind: "success",
      planId: attempt.planId,
      action: attempt.action,
      target: attempt.target,
      attemptId: attempt.attemptId,
      idempotencyKey: attempt.idempotencyKey,
      startedAt: attempt.startedAt,
      resultAt,
      certainty: "definite",
      postcondition: {
        kind: "flags",
        observedAt: resultAt,
        flags: ["\\Seen"],
        modseq: attempt.target.precondition.modseq + 1,
      },
    };
  }
  if (mode === "failed") {
    return {
      kind: "failed",
      planId: attempt.planId,
      action: attempt.action,
      target: attempt.target,
      attemptId: attempt.attemptId,
      idempotencyKey: attempt.idempotencyKey,
      startedAt: attempt.startedAt,
      resultAt,
      certainty: "definite",
      failureReason: "server-rejected",
      detail: "fake remote rejected the frozen action",
    };
  }
  return {
    kind: "uncertain",
    planId: attempt.planId,
    action: attempt.action,
    target: attempt.target,
    attemptId: attempt.attemptId,
    idempotencyKey: attempt.idempotencyKey,
    startedAt: attempt.startedAt,
    resultAt,
    certainty: "uncertain",
    uncertainReason: "local-result-not-durable",
    detail: "fake remote result crossed the uncertain boundary",
  };
}

function fakeRemoteOptions(
  mode: Mode,
  remoteCalls: string[],
): Pick<ActionPlanTargetLoopOptions, "mutationAdapter" | "readPrecondition" | "uncertainObserver" | "normalizeMutationResult"> {
  const readPrecondition = async (target: ActionPlanTarget): Promise<PreconditionObservation> => {
    if (mode === "stale" || (mode === "partial" && target.uid === targetTwo.uid)) {
      return {
        kind: "stale",
        target,
        observed: { uidValidity: target.uidValidity, uid: target.uid, modseq: target.precondition.modseq + 1 },
        reason: "newer-modseq",
      };
    }
    return {
      kind: "satisfied",
      target,
      observed: { uidValidity: target.uidValidity, uid: target.uid, modseq: target.precondition.modseq },
    };
  };
  const mutationAdapter = {
    execute: async ({ attempt }: { readonly attempt: RemoteAttempt }): Promise<unknown> => {
      remoteCalls.push(attempt.attemptId);
      return { mode, attemptId: attempt.attemptId };
    },
  };
  return {
    readPrecondition,
    mutationAdapter,
    normalizeMutationResult: ({ attempt, resultAt }) =>
      resultFor(attempt, resultAt, mode === "uncertain" ? "uncertain" : mode === "failed" ? "failed" : "success"),
    uncertainObserver: {
      read: async ({ attempt, resultAt }) => resultFor(attempt, resultAt, "uncertain"),
    },
  };
}

function servicesFor(
  database: Database,
  mode: Mode,
  remoteCalls: string[],
): ActionPlanServices {
  const plans = new Map<string, PlanRecord>();
  const snapshots = new Map<string, Readonly<{ readonly plan: ActionPlanContract; readonly results: readonly RemoteAttemptResult[] }>>();
  let sequence = 0;

  return {
    createPlan: (input) => {
      const requestInput = actionPlanCreateRequestSchema.parse(input);
      const planId = `plan:real-${mode}-${++sequence}`;
      const proposal = createPendingActionPlan(database, {
        plan: {
          state: "pending",
          planId,
          action: requestInput.action,
          targets: requestInput.targets,
          createdAt,
          expiresAt,
        },
        digest,
        authorizationScope,
        idempotencyKey: `http:${planId}`,
      });
      const authorizationId = `authorization:${planId.slice("plan:".length)}`;
      plans.set(planId, { proposal, authorizationId, mode });
      return { plan: publicPlan(proposal), digest: proposal.previewDigest };
    },
    inspectPlan: (input) => {
      const planId = input.planId;
      const snapshot = snapshots.get(planId);
      if (snapshot !== undefined) return snapshot;
      const proposal = readPendingActionPlan(database, planId);
      if (proposal === undefined) throw new Error("plan was not found");
      return { plan: publicPlan(proposal), results: [] };
    },
    authorizePlan: (input) => {
      const record = plans.get(input.planId);
      if (record === undefined || input.digest !== record.proposal.previewDigest) throw new Error("preview authority rejected");
      return {
        plan: publicPlan(record.proposal),
        authorizationId: record.authorizationId,
        authorizedAt: createdAt,
      };
    },
    commitPlan: async (input) => {
      const record = plans.get(input.planId);
      if (record === undefined || input.digest !== record.proposal.previewDigest || input.authorizationId !== record.authorizationId) {
        throw new Error("authorization authority rejected");
      }
      if (record.mode === "expired") {
        database.query("UPDATE action_plans SET state = 'expired', expired_at = ? WHERE plan_id = ?;").run(expiresAt, record.proposal.planId);
        const result = { plan: terminalPlan(record.proposal, "expired", expiresAt), results: [] };
        snapshots.set(record.proposal.planId, result);
        return result;
      }

      const claim = claimPendingActionPlan(database, {
        planId: record.proposal.planId,
        claimId: `claim:${record.mode}-${record.proposal.planId.slice("plan:".length)}`,
        startedAt: "2026-08-18T00:00:01.000Z",
        now: "2026-08-18T00:00:01.000Z",
        digest: input.digest,
        authorizationScope,
        expectedVersion: 1,
      });
      if (claim.kind !== "claimed") throw new Error(`plan claim failed: ${claim.kind}`);
      const loop = await runActionPlanTargetLoop({
        database,
        claimedPlan: claim.plan,
        now: "2026-08-18T00:00:01.000Z",
        ...fakeRemoteOptions(record.mode, remoteCalls),
      });
      const finalized = finalizeActionPlan(database, {
        planId: claim.plan.planId,
        claimId: claim.plan.claimId,
        expectedVersion: claim.version,
        now: commitAt,
      });
      const results = finalized.targetResults.map(({ result }) => result);
      const terminal = terminalPlan(
        record.proposal,
        finalized.state,
        commitAt,
        results.find((result) => result.certainty === "uncertain")?.attemptId,
      );
      const response = { plan: terminal, results };
      snapshots.set(record.proposal.planId, response);
      expect(loop.progress).toHaveLength(results.length);
      expect(database.query("SELECT state FROM action_plans WHERE plan_id = ?;").get(record.proposal.planId)).toEqual({ state: finalized.state });
      return response;
    },
  };
}

describe("P6-C07 Hono action routes with real SQLite and fake remote composition", () => {
  test("rejects wrong preview digest and authorization identity before remote work", async () => {
    const database = openDatabase();
    const remoteCalls: string[] = [];
    const app = createHttpApp({
      authenticate,
      handlers: createActionPlanHandlers(servicesFor(database, "success", remoteCalls)),
    });
    const created = await app.request(
      request("/v1/action-plans", "POST", "action-plans.create", { action, targets: [targetOne] }),
    );
    const preview = actionPlanPreviewResponseSchema.parse(await created.json());
    const wrongAuthorization = await app.request(
      request(`/v1/action-plans/${preview.plan.planId}/authorize`, "POST", "action-plans.authorize", {
        planId: preview.plan.planId,
        digest: "f".repeat(64),
        intent: "Approve exact frozen targets",
      }),
    );
    expect(wrongAuthorization.status).toBe(500);
    expect(await wrongAuthorization.json()).toMatchObject({ code: "internal_error", details: {} });
    const validAuthorization = await app.request(
      request(`/v1/action-plans/${preview.plan.planId}/authorize`, "POST", "action-plans.authorize", {
        planId: preview.plan.planId,
        digest: preview.digest,
        intent: "Approve exact frozen targets",
      }),
    );
    const authorization = actionPlanAuthorizeResponseSchema.parse(await validAuthorization.json());
    const wrongCommit = await app.request(
      request(`/v1/action-plans/${preview.plan.planId}/commit`, "POST", "action-plans.commit", {
        planId: preview.plan.planId,
        digest: preview.digest,
        authorizationId: "authorization:wrong",
      }),
    );
    expect(wrongCommit.status).toBe(500);
    expect(await wrongCommit.json()).toMatchObject({ code: "internal_error", details: {} });
    expect(database.query("SELECT state FROM action_plans WHERE plan_id = ?;").get(preview.plan.planId)).toEqual({ state: "pending" });
    expect(remoteCalls).toEqual([]);
    expect(authorization.authorizationId).toContain("authorization:");
  });

  test.each(["success", "partial", "stale", "failed", "uncertain", "expired"] as const)(
    "persists and exposes the %s lifecycle through the public boundary",
    async (mode) => {
      const database = openDatabase();
      const remoteCalls: string[] = [];
      const app = createHttpApp({
        authenticate,
        handlers: createActionPlanHandlers(servicesFor(database, mode, remoteCalls)),
      });
      const targets = mode === "partial" ? [targetOne, targetTwo] : [targetOne];
      const createResponse = await app.request(
        request("/v1/action-plans", "POST", "action-plans.create", { action, targets }),
      );
      expect(createResponse.status).toBe(200);
      const preview = actionPlanPreviewResponseSchema.parse(await createResponse.json());
      expect(database.query("SELECT COUNT(*) AS count FROM action_plans;").get()).toEqual({ count: 1 });
      expect(database.query("SELECT COUNT(*) AS count FROM action_plan_targets;").get()).toEqual({ count: targets.length });

      const inspectResponse = await app.request(
        request(`/v1/action-plans/${preview.plan.planId}`, "GET", "action-plans.inspect"),
      );
      expect(actionPlanInspectResponseSchema.parse(await inspectResponse.json())).toEqual({ plan: preview.plan, results: [] });

      const authorizationResponse = await app.request(
        request(`/v1/action-plans/${preview.plan.planId}/authorize`, "POST", "action-plans.authorize", {
          planId: preview.plan.planId,
          digest: preview.digest,
          intent: "Approve exact frozen targets",
        }),
      );
      const authorization = actionPlanAuthorizeResponseSchema.parse(await authorizationResponse.json());
      const commitResponse = await app.request(
        request(`/v1/action-plans/${preview.plan.planId}/commit`, "POST", "action-plans.commit", {
          planId: preview.plan.planId,
          digest: preview.digest,
          authorizationId: authorization.authorizationId,
        }),
      );
      const committed = actionPlanCommitResponseSchema.parse(await commitResponse.json());
      expect(commitResponse.status).toBe(200);
      expect(committed.plan.state).toBe(
        mode === "success" ? "completed" : mode === "partial" ? "partial" : mode === "stale" ? "rejected" : mode,
      );
      expect(committed.results).toHaveLength(targets.length === 2 ? 2 : mode === "expired" ? 0 : 1);
      expect(remoteCalls).toHaveLength(mode === "stale" || mode === "expired" ? 0 : mode === "partial" ? 1 : 1);
      if (mode !== "expired") {
        expect(database.query("SELECT COUNT(*) AS count FROM action_results;").get()).toEqual({ count: targets.length });
        for (const result of committed.results) expect(readActionPlanResult(database, result.attemptId)).toEqual(result);
      }
    },
  );
});
