import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "bun:test";
import {
  actionPlanAuthorityCommitResponseSchema,
  actionPlanApproveResponseSchema,
  actionPlanCancelApprovalResponseSchema,
  actionPlanInspectResponseSchema,
  actionPlanPreviewResponseSchema,
  type ActionPlanContract,
} from "@agent-mail/contracts";
import { createCliClient, type CliClient } from "./client";
import { executeCommand, exitCodes, type CommandSink } from "./command-outcome";
import {
  actionPlanCommandRegistry,
  actionPlanHumanLines,
  parseActionPlanCommand,
  runActionPlanCommand,
  type ActionPresenceChallenge,
} from "./action-plan-command";
import { renderHuman, defaultHumanTerminalPolicy } from "./output-context";

const instant = "2026-08-19T00:00:00.000Z";
const later = "2026-08-19T00:01:00.000Z";
const expiredAt = "2026-08-19T00:11:00.000Z";
const digest = "a".repeat(64);
const target = {
  accountId: "account:test",
  mailboxId: "mailbox:inbox",
  uidValidity: 1,
  uid: 42,
  precondition: { modseq: 9 },
};

const pendingPlan: ActionPlanContract = {
  state: "pending",
  planId: "plan:test",
  action: { kind: "markSeen" },
  targets: [target],
  createdAt: instant,
  expiresAt: "2026-08-19T00:10:00.000Z",
};

const preview = actionPlanPreviewResponseSchema.parse({
  plan: pendingPlan,
  digest,
  planVersion: 1,
  previewDigest: digest,
  targetDigest: digest,
  normalizedIntent: "mark the selected message seen",
  creator: { principalId: "principal:agent", profile: "agent-unattended" },
  approvalState: "absent",
});

const inspect = actionPlanInspectResponseSchema.parse({
  plan: pendingPlan,
  planVersion: 1,
  previewDigest: digest,
  targetDigest: digest,
  normalizedIntent: "mark the selected message seen",
  creator: { principalId: "principal:agent", profile: "agent-unattended" },
  approvalState: "absent",
  results: [],
  terminalAudit: "absent",
});
const expiredInspect = actionPlanInspectResponseSchema.parse({
  ...inspect,
  plan: { ...pendingPlan, state: "expired", expiredAt },
});
const domainApprovalStates = [
  {
    state: "expired" as const,
    approvalId: "approval:test",
    planId: pendingPlan.planId,
    expiredAt: later,
    expected: "expired" as const,
  },
  {
    state: "invalidated" as const,
    approvalId: "approval:test",
    planId: pendingPlan.planId,
    invalidatedAt: later,
    expected: "stale" as const,
  },
  {
    state: "cancelled" as const,
    approvalId: "approval:test",
    planId: pendingPlan.planId,
    cancelledAt: later,
    expected: "cancelled" as const,
  },
];

const consumedApproval = {
  state: "consumed" as const,
  approvalId: "approval:test",
  planId: pendingPlan.planId,
  planVersion: 1,
  previewDigest: digest,
  targetDigest: digest,
  normalizedIntent: "mark the selected message seen",
  issuedAt: instant,
  expiresAt: "2026-08-19T00:10:00.000Z",
  consumedAt: later,
  committer: { principalId: "principal:agent", profile: "agent-unattended" as const },
  receiptId: "approval-receipt:test",
};
const completedPlan: ActionPlanContract = {
  ...pendingPlan,
  state: "completed",
  completedAt: later,
};
const completedResult = {
  kind: "success" as const,
  planId: completedPlan.planId,
  action: completedPlan.action,
  target,
  attemptId: "attempt:completed",
  idempotencyKey: "idempotency:completed",
  startedAt: instant,
  resultAt: later,
  certainty: "definite" as const,
  postcondition: {
    kind: "flags" as const,
    observedAt: later,
    flags: ["\\Seen"],
    modseq: 10,
  },
};
const consumedInspect = actionPlanInspectResponseSchema.parse({
  ...inspect,
  plan: completedPlan,
  approvalState: consumedApproval,
  results: [completedResult],
  terminalAudit: {
    terminalState: "completed",
    terminalAt: later,
    executorDisposition: "started",
    effectAttemptCount: 1,
    effectAuthoritySetDigest: digest,
    executorInstanceId: "executor:test",
    finalizerKind: "effect-executor",
    finalizerInstanceId: "finalizer:test",
    reasonCode: "normal-finalization",
    restoreEventId: "restore:none",
    resultDigest: digest,
  },
});

const approval = actionPlanApproveResponseSchema.parse({
  approval: {
    state: "available",
    approvalId: "approval:test",
    planId: pendingPlan.planId,
    planVersion: 1,
    previewDigest: digest,
    targetDigest: digest,
    normalizedIntent: "mark the selected message seen",
    issuedAt: instant,
    expiresAt: "2026-08-19T00:10:00.000Z",
    authorizationScope: "mail:action.commit",
    approver: { principalId: "principal:local-operator", profile: "operator-interactive" },
  },
});
const cancelled = actionPlanCancelApprovalResponseSchema.parse({
  approval: {
    state: "cancelled",
    approvalId: "approval:test",
    planId: pendingPlan.planId,
    cancelledAt: later,
  },
  planVersion: 2,
});

const uncertainPlan: ActionPlanContract = {
  ...pendingPlan,
  state: "uncertain",
  remoteAttemptId: "attempt:test",
  missingLocalResultAt: later,
};
const uncertainResult = {
  kind: "uncertain" as const,
  planId: uncertainPlan.planId,
  action: uncertainPlan.action,
  target,
  attemptId: "attempt:test",
  idempotencyKey: "idempotency:test",
  startedAt: instant,
  resultAt: later,
  certainty: "uncertain" as const,
  uncertainReason: "local-result-not-durable" as const,
  detail: "remote result remains uncertain",
};
const uncertainCommit = actionPlanAuthorityCommitResponseSchema.parse({
  plan: uncertainPlan,
  results: [uncertainResult],
  consumptionReceipt: {
    receiptId: "approval-receipt:test",
    approvalId: "approval:test",
    planId: uncertainPlan.planId,
    claimId: "claim:test",
    consumedAt: later,
    committer: { principalId: "principal:agent", profile: "agent-unattended" },
    executorProfile: "internal-action-executor",
  },
});

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (client: CliClient, port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
  try {
    const port = address.port;
    await run(
      createCliClient({ baseUrl: `http://127.0.0.1:${port}`, registry: actionPlanCommandRegistry }),
      port,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function send(response: ServerResponse, data: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

function challenge(): ActionPresenceChallenge {
  return {
    version: "agent-mail-macos-operator-presence-v1",
    challengeId: "operator-challenge:test",
    challengeCommitment: "commitment:test",
    operatorDisplayCode: "1111-2222-3333-4444-5555",
    issuedAt: instant,
    expiresAt: later,
    credentialId: "credential:operator:test",
    algorithm: "ES256",
  };
}

function sink(): CommandSink {
  return {
    write: async (bytes) => ({ kind: "written", bytesAccepted: bytes.byteLength }),
  };
}

describe("action-plan CLI commands", () => {
  it("maps only Policy A/A1 operations and rejects obsolete authorize", () => {
    expect(parseActionPlanCommand("create", { action: { kind: "markSeen" }, targets: [target] })).toMatchObject({
      command: "create",
      input: { action: { kind: "markSeen" } },
    });
    expect(() => parseActionPlanCommand("authorize", { planId: pendingPlan.planId })).toThrow();
  });

  it("runs create through the real shared HTTP client and preserves the server preview", async () => {
    await withServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/action-plans");
      send(response, preview);
    }, async (client) => {
      const result = await runActionPlanCommand(
        "create",
        { action: { kind: "markSeen" }, targets: [target] },
        { client, correlationId: "cli:action-create", mode: "json" },
      );
      expect(result).toMatchObject({ kind: "value", operationKey: "action-plans.create", semanticKind: "success", data: preview });
    });
  });

  it("preflights human approval, signs only the exact request bytes, and uses a distinct operator client", async () => {
    let approvalRequests = 0;
    let receivedBody = "";
    let receivedAuthorization: string | undefined;
    await withServer((request, response) => {
      if (request.method === "GET") {
        send(response, inspect);
        return;
      }
      approvalRequests += 1;
      receivedAuthorization = request.headers.authorization;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      request.on("end", () => send(response, approval));
    }, async (client, port) => {
      let confirmationPrompt = "";
      let displayedCode = "";
      let issuedRequest: { readonly path: string; readonly rawBody: Uint8Array } | undefined;
      const result = await runActionPlanCommand(
        "approve",
        { planId: pendingPlan.planId, planVersion: 1, previewDigest: digest },
        {
          client,
          correlationId: "cli:action-approve",
          mode: "human",
          confirm: async (prompt) => {
            confirmationPrompt = prompt;
            return "YES";
          },
          presence: {
            issue: async (request) => {
              issuedRequest = { path: request.path, rawBody: request.rawBody };
              return challenge();
            },
            sign: async (_request, issuedChallenge) => {
              expect(issuedChallenge.challengeId).toBe("operator-challenge:test");
              return {
                version: issuedChallenge.version,
                challengeId: issuedChallenge.challengeId,
                credentialId: issuedChallenge.credentialId,
                signatureBase64url: "a".repeat(86),
              };
            },
          },
          displayChallenge: (value) => {
            displayedCode = value.operatorDisplayCode;
          },
          operatorClientForAssertion: (authorization) => {
            return createCliClient({
              baseUrl: `http://127.0.0.1:${port}`,
              registry: actionPlanCommandRegistry,
              headers: { authorization },
            });
          },
        },
      );
      expect(result).toMatchObject({ kind: "value", operationKey: "action-plans.approve", semanticKind: "success" });
      expect(approvalRequests).toBe(1);
      expect(receivedAuthorization).toMatch(/^AgentMail-Operator /u);
      expect(issuedRequest?.path).toBe("/v1/action-plans/plan%3Atest/approvals");
      expect(new TextDecoder().decode(issuedRequest?.rawBody)).toBe(receivedBody);
      expect(confirmationPrompt).toBe(
        "Approve this frozen action plan for one unattended commit within 10 minutes and no later than 2026-08-19T00:10:00.000Z? [y/N]",
      );
      expect(displayedCode).toBe("1111-2222-3333-4444-5555");
    });
  });

  it("does not call the approval route for structured output or a non-confirmation", async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests += 1;
      send(response, inspect);
    }, async (client) => {
      const result = await runActionPlanCommand(
        "approve",
        { planId: pendingPlan.planId, planVersion: 1, previewDigest: digest },
        {
          client,
          correlationId: "cli:action-no-approval",
          mode: "json",
          confirm: async () => "yes",
        },
      );
      expect(result).toMatchObject({ kind: "failure", semanticKind: "usage" });
      expect(requests).toBe(0);
    });
  });

  it("maps cancellation to the frozen DELETE route and exact request body", async () => {
    let receivedBody = "";
    await withServer((request, response) => {
      if (request.method === "GET") {
        send(response, inspect);
        return;
      }
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe("/v1/action-plans/plan%3Atest/approvals/approval%3Atest");
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      request.on("end", () => send(response, cancelled));
    }, async (client, port) => {
      const result = await runActionPlanCommand(
        "cancel",
        {
          planId: pendingPlan.planId,
          approvalId: "approval:test",
          planVersion: 1,
          previewDigest: digest,
        },
        {
          client,
          correlationId: "cli:action-cancel",
          mode: "human",
          confirm: async () => "y",
          presence: {
            issue: async () => challenge(),
            sign: async (_request, value) => ({
              version: value.version,
              challengeId: value.challengeId,
              credentialId: value.credentialId,
              signatureBase64url: "b".repeat(86),
            }),
          },
          displayChallenge: () => undefined,
          operatorClientForAssertion: (authorization) =>
            createCliClient({
              baseUrl: `http://127.0.0.1:${port}`,
              registry: actionPlanCommandRegistry,
              headers: { authorization },
            }),
        },
      );
      expect(result).toMatchObject({ kind: "value", operationKey: "action-plans.cancel-approval", semanticKind: "success", data: cancelled });
      expect(receivedBody).toBe(JSON.stringify({ planId: pendingPlan.planId, approvalId: "approval:test", planVersion: 1, previewDigest: digest }));
    });
  });

  it("renders every target/result as hostile-safe human segments", () => {
    const lines = actionPlanHumanLines(inspect);
    const rendered = lines.map((line) => renderHuman(line, defaultHumanTerminalPolicy("tty"))).join("\n");
    expect(rendered).toContain("target 1 requested-modseq: 9");
    expect(rendered).toContain("preview digest: ");
    expect(rendered).not.toContain("\u001b");
  });

  it("returns the oracle's distinct uncertain outcome and never retries the commit request", async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests += 1;
      send(response, uncertainCommit);
    }, async (client) => {
      const result = await runActionPlanCommand(
        "commit",
        {
          planId: uncertainPlan.planId,
          planVersion: 1,
          previewDigest: digest,
          approvalId: "approval:test",
        },
        { client, correlationId: "cli:action-uncertain", mode: "json" },
      );
      expect(result).toMatchObject({
        kind: "value",
        operationKey: "action-plans.commit",
        semanticKind: "uncertain",
        data: uncertainCommit,
      });
      expect(requests).toBe(1);
    });
  });

  it("maps expired domain state and scope denial through the shared outcome authority", async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests += 1;
      send(response, expiredInspect);
    }, async (client) => {
      const result = await runActionPlanCommand(
        "inspect",
        { planId: pendingPlan.planId },
        { client, correlationId: "cli:action-expired", mode: "json" },
      );
      expect(result).toMatchObject({ kind: "value", operationKey: "action-plans.inspect", semanticKind: "expired" });
      expect(requests).toBe(1);
      expect(actionPlanCommandRegistry.get("action-plans.execute")).toBeUndefined();
    });
    await withServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          code: "action.approval_forbidden",
          message: "request credentials cannot perform this approval operation",
          correlationId: "request:scope",
          details: {},
        }),
      );
    }, async (client) => {
      const result = await runActionPlanCommand(
        "commit",
        { planId: pendingPlan.planId, planVersion: 1, previewDigest: digest, approvalId: "approval:test" },
        { client, correlationId: "cli:action-scope", mode: "json" },
      );
      expect(result).toMatchObject({ kind: "failure", operationKey: "action-plans.commit", semanticKind: "authorization" });
    });
  });

  it("retains invalidated, cancelled, and consumed state truth in domain responses", async () => {
    for (const row of domainApprovalStates) {
      const { expected, ...approvalState } = row;
      const response = actionPlanInspectResponseSchema.parse({ ...inspect, approvalState });
      await withServer((_request, serverResponse) => send(serverResponse, response), async (client) => {
        const result = await runActionPlanCommand(
          "inspect",
          { planId: pendingPlan.planId },
          { client, correlationId: `cli:action-${row.state}`, mode: "json" },
        );
        expect(result).toMatchObject({
          kind: "value",
          operationKey: "action-plans.inspect",
          semanticKind: expected,
          data: response,
        });
      });
    }
    await withServer((_request, serverResponse) => send(serverResponse, consumedInspect), async (client) => {
      const result = await runActionPlanCommand(
        "inspect",
        { planId: completedPlan.planId },
        { client, correlationId: "cli:action-consumed", mode: "json" },
      );
      expect(result).toMatchObject({
        kind: "value",
        operationKey: "action-plans.inspect",
        semanticKind: "success",
        data: consumedInspect,
      });
    });
  });

  it("maps registered action terminal failures to exact semantics, exits, and cleanup", async () => {
    const failures = [
      {
        code: "action.approval_expired",
        message: "action approval has expired",
        details: { planId: pendingPlan.planId, approvalId: "approval:test", expiredAt: later },
        semanticKind: "expired" as const,
      },
      {
        code: "action.approval_invalidated",
        message: "action approval is no longer valid",
        details: { planId: pendingPlan.planId, approvalId: "approval:test", invalidatedAt: later },
        semanticKind: "stale" as const,
      },
      {
        code: "action.approval_cancelled",
        message: "action approval was cancelled",
        details: { planId: pendingPlan.planId, approvalId: "approval:test", cancelledAt: later },
        semanticKind: "cancelled" as const,
      },
      {
        code: "action.approval_consumed",
        message: "action approval was already consumed",
        details: {
          planId: pendingPlan.planId,
          approvalId: "approval:test",
          receiptId: "approval-receipt:test",
          consumedAt: later,
        },
        semanticKind: "replay" as const,
      },
    ];
    for (const row of failures) {
      let requests = 0;
      await withServer((_request, serverResponse) => {
        requests += 1;
        serverResponse.writeHead(409, { "content-type": "application/json" });
        serverResponse.end(
          JSON.stringify({
            code: row.code,
            message: row.message,
            correlationId: "request:action-failure",
            details: row.details,
          }),
        );
      }, async (client) => {
        const result = await runActionPlanCommand(
          "commit",
          {
            planId: pendingPlan.planId,
            planVersion: 1,
            previewDigest: digest,
            approvalId: "approval:test",
          },
          { client, correlationId: `cli:${row.code}`, mode: "json" },
        );
        expect(result).toMatchObject({
          kind: "failure",
          operationKey: "action-plans.commit",
          semanticKind: row.semanticKind,
          error: { code: row.code },
        });
        expect(requests).toBe(1);
        let cleanupCalls = 0;
        const receipt = await executeCommand(result, {
          invocationCorrelationId: "cli:action-receipt",
          mode: "json",
          stdout: sink(),
          stderr: sink(),
          rawPolicy: { destination: "pipe", tty: "refuse" },
          signal: new AbortController().signal,
          cleanup: async () => {
            cleanupCalls += 1;
          },
        });
        expect(receipt).toMatchObject({
          semanticKind: row.semanticKind,
          exitCode: exitCodes[row.semanticKind],
        });
        expect(cleanupCalls).toBe(1);
      });
    }
  });
});
