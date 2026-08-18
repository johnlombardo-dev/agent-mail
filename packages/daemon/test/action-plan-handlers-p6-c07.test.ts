import { describe, expect, test } from "bun:test";
import {
  actionPlanPreviewResponseSchema,
  actionPlanAuthorityCommitResponseSchema,
  actionPlanOperationDefinitions,
  publicErrorEnvelopeSchema,
} from "@agent-mail/contracts";
import { operationCorpus } from "../../contracts/test/operation-corpus";
import {
  createActionPlanHandlers,
  type ActionPlanServices,
} from "../src/action-plan-handlers";
import {
  createHttpApp,
  publicOperationRegistry,
  type HttpCredentialResolution,
} from "../src/http";
import { registerTrustedAuthContext } from "../src/trusted-auth-context";

const createFixture = operationCorpus["action-plans.create"];
const inspectFixture = operationCorpus["action-plans.inspect"];
const approveFixture = operationCorpus["action-plans.approve"];
const cancelFixture = operationCorpus["action-plans.cancel-approval"];
const commitFixture = operationCorpus["action-plans.commit"];
if (
  createFixture === undefined ||
  inspectFixture === undefined ||
  approveFixture === undefined ||
  cancelFixture === undefined ||
  commitFixture === undefined
) {
  throw new Error("action operation corpus is incomplete");
}

const plan = (() => {
  return actionPlanPreviewResponseSchema.parse(createFixture.success).plan;
})();

const partialPlan = {
  ...plan,
  state: "partial" as const,
  completedAt: "2024-03-01T00:00:01.000Z",
};
const staleResult = {
  kind: "stale" as const,
  planId: plan.planId,
  action: plan.action,
  target: plan.targets[0],
  attemptId: "attempt:stale-例",
  idempotencyKey: "idempotency:stale-例",
  startedAt: "2024-03-01T00:00:00.000Z",
  resultAt: "2024-03-01T00:00:01.000Z",
  certainty: "definite" as const,
  detail: "target was stale",
};
const uncertainPlan = {
  ...plan,
  state: "uncertain" as const,
  remoteAttemptId: "attempt:uncertain-例",
  missingLocalResultAt: "2024-03-01T00:00:01.000Z",
};
const uncertainResult = {
  kind: "uncertain" as const,
  planId: plan.planId,
  action: plan.action,
  target: plan.targets[0],
  attemptId: "attempt:uncertain-例",
  idempotencyKey: "idempotency:uncertain-例",
  startedAt: "2024-03-01T00:00:00.000Z",
  resultAt: "2024-03-01T00:00:01.000Z",
  certainty: "uncertain" as const,
  uncertainReason: "local-result-not-durable" as const,
  detail: "the local result was not durable",
};

function request(
  path: string,
  body: unknown | undefined,
  operationKey: string,
  token = operationKey,
): Request {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(`http://localhost${path}`, {
    method: path.endsWith(`/${plan.planId}`) ? "GET" : path.includes("/approvals/") ? "DELETE" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authenticate(credential: string): HttpCredentialResolution {
  const operation = publicOperationRegistry.get(credential);
  return operation === undefined
    ? { kind: "invalid" }
    : {
        kind: "authenticated",
        principal: { subject: "principal:local-operator", scopes: operation.scope === null ? [] : [operation.scope] },
        context: registerTrustedAuthContext({
          principalId: "principal:local-operator",
          credentialId: "credential:test",
          profile: operation.scope === "mail:action.commit" ? "agent-unattended" : "operator-interactive",
          scopes: operation.scope === null ? [] : [operation.scope],
          authEventId: "auth-event:test",
          authenticatedAt: "2024-03-01T00:00:00.000Z",
          credentialExpiresAt: "2025-03-01T00:00:00.000Z",
          presence: operation.scope === "mail:action.commit"
            ? { kind: "unattended" }
            : operation.scope === "mail:action.approve"
              ? {
                  kind: "human-present",
                  ceremonyId: "operator-challenge:test",
                  verifiedAt: "2024-03-01T00:00:00.000Z",
                  validUntil: "2024-03-01T00:01:00.000Z",
                  requestMethod: credential === "action-plans.cancel-approval" ? "DELETE" : "POST",
                  requestPath: "/v1/action-plans/plan%3Aauthority/approvals",
                  requestBodySha256: "0".repeat(64),
                  challengeCommitmentSha256: "1".repeat(64),
                  assertionSignatureSha256: "2".repeat(64),
                  assertionSignatureP1363Base64url: Buffer.alloc(64, 1).toString("base64url"),
                  operatorDisplayCode: "0000-0000-0000-0000-0000",
                  authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
                  operatorConfigurationRevision: 1,
                }
              : { kind: "a1-non-approval-session", sessionId: "operator-session:test", sessionAuthEventId: "auth-event:test", issuedAt: "2024-03-01T00:00:00.000Z", expiresAt: "2024-03-01T00:10:00.000Z", configurationRevision: 1, credentialExpiresAt: "2025-03-01T00:00:00.000Z" },
        }),
      };
}

function services(calls: string[]): ActionPlanServices {
  const commitVariants = [
    commitFixture.success,
    commitFixture.successVariants?.[0],
    { plan: partialPlan, results: [staleResult], consumptionReceipt: commitFixture.success.consumptionReceipt },
    { plan: uncertainPlan, results: [uncertainResult], consumptionReceipt: commitFixture.success.consumptionReceipt },
  ];
  return {
    createPlan: (input, context) => {
      calls.push(`${context.operationKey}:${JSON.stringify(input)}`);
      return createFixture.success;
    },
    inspectPlan: (input, context) => {
      calls.push(`${context.operationKey}:${JSON.stringify(input)}`);
      return inspectFixture.success;
    },
    approvePlan: (input, context) => {
      calls.push(`${context.operationKey}:${JSON.stringify(input)}`);
      return approveFixture.success;
    },
    cancelApproval: (input, context) => {
      calls.push(`${context.operationKey}:${JSON.stringify(input)}`);
      return cancelFixture.success;
    },
    authorityCommitPlan: (input, context) => {
      calls.push(`${context.operationKey}:${JSON.stringify(input)}`);
      return (
        commitVariants[calls.filter((call) => call.startsWith("action-plans.commit:")).length - 1] ??
        commitFixture.success
      );
    },
  };
}

describe("P6-C07 public action-plan HTTP handlers", () => {
  test("registers exactly create, inspect, approve, cancel, and commit handlers", () => {
    const handlers = createActionPlanHandlers(services([]));
    expect(Object.keys(handlers).sort()).toEqual([
      "action-plans.approve",
      "action-plans.cancel-approval",
      "action-plans.commit",
      "action-plans.create",
      "action-plans.inspect",
    ]);
    expect(actionPlanOperationDefinitions.map((operation) => [operation.key, operation.route, operation.scope])).toEqual([
      ["action-plans.create", "/v1/action-plans", "mail:action.create"],
      ["action-plans.inspect", "/v1/action-plans/{planId}", "mail:action.inspect"],
      ["action-plans.approve", "/v1/action-plans/{planId}/approvals", "mail:action.approve"],
      ["action-plans.cancel-approval", "/v1/action-plans/{planId}/approvals/{approvalId}", "mail:action.approve"],
      ["action-plans.commit", "/v1/action-plans/{planId}/commit", "mail:action.commit"],
    ]);
  });

  test("runs the authority lifecycle operations through Hono with exact scopes and path params", async () => {
    const calls: string[] = [];
    const app = createHttpApp({ authenticate, handlers: createActionPlanHandlers(services(calls)) });

    const createResponse = await app.request(
      request("/v1/action-plans", createFixture.request, "action-plans.create"),
    );
    const inspectResponse = await app.request(
      request(`/v1/action-plans/${plan.planId}`, undefined, "action-plans.inspect"),
    );
    const approveResponse = await app.request(
      request(
        `/v1/action-plans/${plan.planId}/approvals`,
        approveFixture.request,
        "action-plans.approve",
      ),
    );
    const cancelResponse = await app.request(
      request(`/v1/action-plans/${plan.planId}/approvals/approval%3Aapproval-例`, cancelFixture.request, "action-plans.cancel-approval"),
    );
    const commitResponse = await app.request(
      request(
        `/v1/action-plans/${plan.planId}/commit`,
        commitFixture.request,
        "action-plans.commit",
      ),
    );

    expect(createResponse.status).toBe(200);
    expect(inspectResponse.status).toBe(200);
    expect(approveResponse.status).toBe(200);
    expect(cancelResponse.status).toBe(200);
    expect(commitResponse.status).toBe(200);
    expect(await createResponse.json()).toEqual(createFixture.success);
    expect(await inspectResponse.json()).toEqual(inspectFixture.success);
    expect(await approveResponse.json()).toEqual(approveFixture.success);
    expect(await cancelResponse.json()).toEqual(cancelFixture.success);
    expect(actionPlanAuthorityCommitResponseSchema.parse(await commitResponse.json())).toEqual(commitFixture.success);
    expect(calls.map((call) => call.split(":", 1)[0])).toEqual([
      "action-plans.create",
      "action-plans.inspect",
      "action-plans.approve",
      "action-plans.cancel-approval",
      "action-plans.commit",
    ]);
  });

  test("preserves failed, expired, partial, and uncertain per-target outcomes", async () => {
    const calls: string[] = [];
    const app = createHttpApp({ authenticate, handlers: createActionPlanHandlers(services(calls)) });
    const responses = await Promise.all(
      [0, 1, 2, 3].map(() =>
        app.request(
          request(`/v1/action-plans/${plan.planId}/commit`, commitFixture.request, "action-plans.commit"),
        ),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(bodies).toEqual([
      commitFixture.success,
      commitFixture.successVariants?.[0],
      { plan: partialPlan, results: [staleResult], consumptionReceipt: commitFixture.success.consumptionReceipt },
      { plan: uncertainPlan, results: [uncertainResult], consumptionReceipt: commitFixture.success.consumptionReceipt },
    ]);
  });

  test("rejects missing or wrong scopes, malformed bodies, and the adjacent raw executor path", async () => {
    let invocations = 0;
    const base = services([]);
    const guarded: ActionPlanServices = {
      createPlan: async (input, context) => {
        invocations += 1;
        return base.createPlan(input, context);
      },
      inspectPlan: async (input, context) => {
        invocations += 1;
        return base.inspectPlan(input, context);
      },
      approvePlan: async (input, context) => {
        invocations += 1;
        return base.approvePlan?.(input, context);
      },
      cancelApproval: async (input, context) => {
        invocations += 1;
        return base.cancelApproval?.(input, context);
      },
      authorityCommitPlan: async (input, context) => {
        invocations += 1;
        return base.authorityCommitPlan?.(input, context);
      },
    };
    const app = createHttpApp({ authenticate, handlers: createActionPlanHandlers(guarded) });

    const missing = await app.request(
      new Request("http://localhost/v1/action-plans", { method: "POST", body: "{}" }),
    );
    const wrong = await app.request(
      request("/v1/action-plans", createFixture.request, "action-plans.create", "action-plans.inspect"),
    );
    const extra = await app.request(
      request("/v1/action-plans", { ...createFixture.request, execute: true }, "action-plans.create"),
    );
    const raw = await app.request(
      request("/v1/action-plans/execute", { target: "arbitrary" }, "action-plans.inspect"),
    );

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(403);
    expect(extra.status).toBe(400);
    expect(raw.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "insufficient_scope" });
    expect(await extra.json()).toMatchObject({ code: "invalid_request" });
    expect(await raw.json()).toMatchObject({ code: "invalid_request" });
    expect(invocations).toBe(0);
    expect(publicErrorEnvelopeSchema.parse(await missing.json())).toMatchObject({
      code: "missing_credentials",
      details: {},
    });
  });

  test("redacts plan service failures and preserves no adapter-shaped public route", async () => {
    const app = createHttpApp({
      authenticate,
      handlers: createActionPlanHandlers({
        ...services([]),
        authorityCommitPlan: () => ({ kind: "failure", reason: "wrong digest/version: secret storage detail" }),
      }),
    });
    const response = await app.request(
      request(`/v1/action-plans/${plan.planId}/commit`, commitFixture.request, "action-plans.commit"),
    );
    const body: unknown = await response.json();
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ code: "internal_error", details: {} });
    expect(JSON.stringify(body)).not.toContain("wrong digest");
    expect(JSON.stringify(body)).not.toContain("storage");
  });
});
