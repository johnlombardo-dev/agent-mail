import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  actionPlanInspectResponseSchema,
  actionPlanPreviewResponseSchema,
  type ActionPlanContract,
  type ActionPlanTarget,
} from "@agent-mail/contracts";
import { actionPlanCreateRequestSchema } from "@agent-mail/contracts";
import type { RemoteAttempt, RemoteAttemptResult } from "@agent-mail/core";
import type { PreconditionObservation } from "../../imap/src/precondition";
import {
  runMigrations,
} from "../../storage/src/migration-runner";
import {
  actionAttemptDispatchSequence,
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
const authorizationScope = "mail:action.commit";

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
  readonly mode: Mode;
}>;

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  runMigrations(database, [
    ...actionAttemptDispatchSequence,
    { ...operationalJournalMigration, version: 6, name: "test-operational-journal" },
    actionResultReconciliationMigration,
  ]);
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
      plans.set(planId, { proposal, mode });
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
    approvePlan: () => {
      throw new Error("retired scope-only fixture");
    },
    cancelApproval: () => {
      throw new Error("retired scope-only fixture");
    },
    authorityCommitPlan: () => {
      throw new Error("retired scope-only fixture");
    },
  };
}

// Retired scope-only composition fixture. Authority composition is covered by
// action-authority-http.test.ts and action-approval-authority.test.ts.
describe.skip("P6-C07 retired scope-only composition", () => {
  test("is replaced by authority-v1 composition coverage", () => {
    expect(publicOperationRegistry.get("action-plans.authorize")).toBeUndefined();
  });
});
