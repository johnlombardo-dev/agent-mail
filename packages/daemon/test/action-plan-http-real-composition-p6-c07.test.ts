import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  actionPlanApproveResponseSchema,
  actionPlanAuthorityCommitResponseSchema,
  actionPlanInspectResponseSchema,
  actionPlanPreviewResponseSchema,
  type ActionPlanInspectResponse,
} from "@agent-mail/contracts";
import { createCliClient, type CliClient } from "../../cli/src/client";
import type { CommandResultV1 } from "../../cli/src/command-outcome";
import {
  actionPlanCommandRegistry,
  runActionPlanCommand,
  type ActionPresenceBroker,
  type ActionPresenceChallenge,
  type ActionPresenceRequest,
} from "../../cli/src/action-plan-command";
import { admitHttpRequest, publicOperationRegistry } from "../src/http";
import type { OperatorPresenceChallenge as DaemonPresenceChallenge } from "../src/operator-presence";
import { acquirePortLease, releasePortLease, type PortLease } from "../../../port-lease";
import {
  actionLifecycleAgentSecret,
  actionLifecycleTargets,
  createActionLifecycleCompositionFixture,
  type ActionLifecycleCompositionFixture,
  type ActionLifecycleMode,
} from "./action-lifecycle-composition-fixture-p6-c07";

const roots: string[] = [];
const fixtures: ActionLifecycleCompositionFixture[] = [];
const loopbackLeaseRoles = ["apiIntegration", "browserPreview"] as const;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function acquireLoopbackPortLease(): Promise<PortLease> {
  for (const role of loopbackLeaseRoles) {
    const lease = await acquirePortLease({ project: "action-lifecycle-composition-242", role });
    if (lease !== null) return lease;
  }
  throw new Error("no leased loopback test port was available");
}

async function withLoopback(
  fixture: ActionLifecycleCompositionFixture,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = request.method === "GET" ? undefined : await readRequest(request);
    const webRequest = new Request(`http://127.0.0.1${request.url ?? "/"}`, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : [],
        ),
      ),
      ...(body === undefined ? {} : { body }),
    });
    const webResponse = await fixture.app.fetch(webRequest);
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  const portLease = await acquireLoopbackPortLease();
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(portLease.port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        listening = true;
        resolve();
      });
    });
    await run(`http://127.0.0.1:${portLease.port}`);
  } finally {
    if (listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    await releasePortLease({ lease: portLease });
  }
}

function client(baseUrl: string, authorization = `Bearer ${actionLifecycleAgentSecret}`): CliClient {
  return createCliClient({ baseUrl, authorization, registry: actionPlanCommandRegistry });
}

function valueData(value: CommandResultV1): unknown {
  if (value.kind !== "value") throw new Error(`CLI command did not return a value: ${value.semanticKind}`);
  return value.data;
}

function presenceBroker(fixture: ActionLifecycleCompositionFixture): ActionPresenceBroker {
  const challenges = new Map<string, DaemonPresenceChallenge>();
  return {
    issue: async (request: ActionPresenceRequest): Promise<ActionPresenceChallenge> => {
      const input: unknown = JSON.parse(new TextDecoder().decode(request.rawBody));
      const daemonRequest = fixture.operatorPresenceRequest(request.operation, input);
      const challenge = await fixture.operatorPresence.issueChallenge(daemonRequest);
      challenges.set(challenge.challengeId, challenge);
      return {
        version: "agent-mail-macos-operator-presence-v1",
        challengeId: challenge.challengeId,
        challengeCommitment: challenge.commitment,
        operatorDisplayCode: challenge.displayCode,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        credentialId: challenge.request.credentialId,
        algorithm: "ES256",
      };
    },
    sign: async (request: ActionPresenceRequest, challenge: ActionPresenceChallenge) => {
      const daemonChallenge = challenges.get(challenge.challengeId);
      if (daemonChallenge === undefined) throw new Error("presence challenge was not retained");
      const input: unknown = JSON.parse(new TextDecoder().decode(request.rawBody));
      const daemonRequest = fixture.operatorPresenceRequest(request.operation, input);
      const assertion = await fixture.operatorPresence.signChallenge(daemonRequest, daemonChallenge);
      return {
        version: "agent-mail-macos-operator-presence-v1",
        challengeId: assertion.challengeId,
        credentialId: assertion.credentialId,
        signatureBase64url: assertion.signatureP1363Base64url,
      };
    },
  };
}

async function createAndApprove(
  fixture: ActionLifecycleCompositionFixture,
  baseUrl: string,
  cli: CliClient,
): Promise<Readonly<{ readonly preview: ActionPlanInspectResponse; readonly approvalId: string }>> {
  const operator = client(baseUrl, `Bearer ${fixture.operatorSessionToken}`);
  const created = await runActionPlanCommand(
    "create",
    { action: { kind: "markSeen" }, targets: actionLifecycleTargets },
    { client: operator, correlationId: "cli:action-lifecycle:create", mode: "json" },
  );
  const preview = actionPlanPreviewResponseSchema.parse(valueData(created));
  const inspected = await runActionPlanCommand(
    "inspect",
    { planId: preview.plan.planId },
    { client: operator, correlationId: "cli:action-lifecycle:inspect", mode: "json" },
  );
  const inspect = actionPlanInspectResponseSchema.parse(valueData(inspected));
  const approved = await runActionPlanCommand(
    "approve",
    { planId: preview.plan.planId, planVersion: inspect.planVersion, previewDigest: inspect.previewDigest },
    {
      client: operator,
      correlationId: "cli:action-lifecycle:approve",
      mode: "human",
      confirm: async () => "yes",
      presence: presenceBroker(fixture),
      displayChallenge: () => undefined,
      operatorClientForAssertion: (authorization) => client(baseUrl, authorization),
    },
  );
  const approval = actionPlanApproveResponseSchema.parse(valueData(approved)).approval;
  return { preview: inspect, approvalId: approval.approvalId };
}

async function createFixture(mode: ActionLifecycleMode): Promise<ActionLifecycleCompositionFixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-action-lifecycle-p6-c07-"));
  roots.push(root);
  const fixture = await createActionLifecycleCompositionFixture(root, mode);
  fixtures.push(fixture);
  return fixture;
}

describe("P6-C07 real action lifecycle composition", () => {
  test("runs create, inspect, approve, cancel, and commit across real REST and CLI paths", async () => {
    const fixture = await createFixture("success");
    await withLoopback(fixture, async (baseUrl) => {
      const agent = client(baseUrl);
      const createResponse = await fetch(`${baseUrl}/v1/action-plans`, {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.operatorSessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ action: { kind: "markSeen" }, targets: actionLifecycleTargets.slice(0, 1) }),
      });
      expect(createResponse.status).toBe(200);
      const restPreview = actionPlanPreviewResponseSchema.parse(await createResponse.json());
      const inspectResponse = await fetch(`${baseUrl}/v1/action-plans/${encodeURIComponent(restPreview.plan.planId)}`, {
        headers: { authorization: `Bearer ${fixture.operatorSessionToken}` },
      });
      expect(inspectResponse.status).toBe(200);
      const restInspect = actionPlanInspectResponseSchema.parse(await inspectResponse.json());
      expect(restInspect.approvalState).toBe("absent");

      const restApprovalBody = { planId: restInspect.plan.planId, planVersion: restInspect.planVersion, previewDigest: restInspect.previewDigest };
      const restApprovalRequest = fixture.operatorPresenceRequest("approve", restApprovalBody);
      const restAssertion = await fixture.operatorAssertion(restApprovalRequest);
      const restApproval = await fetch(`${baseUrl}${restApprovalRequest.path}`, {
        method: "POST",
        headers: {
          authorization: `AgentMail-Operator ${Buffer.from(JSON.stringify({ version: restAssertion.version, challengeId: restAssertion.challengeId, credentialId: restAssertion.credentialId, signatureBase64url: restAssertion.signatureP1363Base64url })).toString("base64url")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(restApprovalBody),
      });
      expect(restApproval.status).toBe(200);

      const cancelled = await createAndApprove(fixture, baseUrl, agent);
      const cancelResult = await runActionPlanCommand(
        "cancel",
        { planId: cancelled.preview.plan.planId, approvalId: cancelled.approvalId, planVersion: cancelled.preview.planVersion, previewDigest: cancelled.preview.previewDigest },
        {
          client: agent,
          correlationId: "cli:action-lifecycle:cancel",
          mode: "human",
          confirm: async () => "yes",
          presence: presenceBroker(fixture),
          displayChallenge: () => undefined,
          operatorClientForAssertion: (authorization) => client(baseUrl, authorization),
        },
      );
      expect(cancelResult.semanticKind).toBe("success");

      const committed = await createAndApprove(fixture, baseUrl, agent);
      const commitResult = await runActionPlanCommand(
        "commit",
        { planId: committed.preview.plan.planId, planVersion: committed.preview.planVersion, previewDigest: committed.preview.previewDigest, approvalId: committed.approvalId },
        { client: agent, correlationId: "cli:action-lifecycle:commit", mode: "json" },
      );
      const commit = actionPlanAuthorityCommitResponseSchema.parse(valueData(commitResult));
      expect(commit.plan.state).toBe("completed");
      expect(commit.results).toHaveLength(2);
      expect(fixture.database.query("SELECT terminal_state FROM action_plan_terminal_audit WHERE plan_id = ?;").get(committed.preview.plan.planId)).toEqual({ terminal_state: "completed" });
    });
  });

  test("maps failed, partial, uncertain, and replay boundaries through the outcome authority", async () => {
    for (const mode of ["failed", "partial", "uncertain"] as const) {
      const fixture = await createFixture(mode);
      await withLoopback(fixture, async (baseUrl) => {
        const agent = client(baseUrl);
        const approved = await createAndApprove(fixture, baseUrl, agent);
        const result = await runActionPlanCommand(
          "commit",
          { planId: approved.preview.plan.planId, planVersion: approved.preview.planVersion, previewDigest: approved.preview.previewDigest, approvalId: approved.approvalId },
          { client: agent, correlationId: `cli:action-lifecycle:${mode}`, mode: "json" },
        );
        expect(result.semanticKind).toBe(mode === "failed" ? "attention" : mode);
        const inspectResponse = await fetch(`${baseUrl}/v1/action-plans/${encodeURIComponent(approved.preview.plan.planId)}`, { headers: { authorization: `Bearer ${actionLifecycleAgentSecret}` } });
        expect(inspectResponse.status).toBe(200);
        const inspect = actionPlanInspectResponseSchema.parse(await inspectResponse.json());
        expect(inspect.terminalAudit).not.toBe("absent");
        const replay = await runActionPlanCommand(
          "commit",
          { planId: approved.preview.plan.planId, planVersion: approved.preview.planVersion, previewDigest: approved.preview.previewDigest, approvalId: approved.approvalId },
          { client: agent, correlationId: `cli:action-lifecycle:${mode}:replay`, mode: "json" },
        );
        expect(replay.semanticKind).toBe("replay");
      });
    }
  });

  test("rejects static/self approval and rejects oversized requests before service effects", async () => {
    const fixture = await createFixture("success");
    const wrongScope = await admitHttpRequest({
      operation: publicOperationRegistry.get("action-plans.approve")!,
      request: new Request("http://127.0.0.1/v1/action-plans/plan%3Awrong/approvals", {
        method: "POST",
        headers: { authorization: `Bearer ${actionLifecycleAgentSecret}`, "content-type": "application/json" },
        body: JSON.stringify({ planId: "plan:wrong", planVersion: 1, previewDigest: "0".repeat(64) }),
      }),
      authenticate: (secret) => secret === actionLifecycleAgentSecret ? {
        kind: "authenticated",
        principal: { subject: "principal:agent", scopes: ["mail:action.commit"] },
      } : { kind: "invalid" },
      operatorPresenceAdmission: true,
    });
    expect(wrongScope.kind).toBe("rejected");
    expect(wrongScope.kind === "rejected" ? wrongScope.status : 200).toBe(403);

    await withLoopback(fixture, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/action-plans`, {
        method: "POST",
        headers: { authorization: `Bearer ${actionLifecycleAgentSecret}`, "content-type": "application/json" },
        body: JSON.stringify({ action: { kind: "markSeen" }, targets: actionLifecycleTargets, padding: "x".repeat(4_096) }),
      });
      expect(response.status).toBe(413);
      expect(fixture.database.query("SELECT COUNT(*) AS count FROM action_plans;").get()).toEqual({ count: 0 });
    });
  });

  test("retains terminal audit in durable SQLite across a database reopen", async () => {
    const fixture = await createFixture("success");
    await withLoopback(fixture, async (baseUrl) => {
      const agent = client(baseUrl);
      const approved = await createAndApprove(fixture, baseUrl, agent);
      const result = await runActionPlanCommand(
        "commit",
        { planId: approved.preview.plan.planId, planVersion: approved.preview.planVersion, previewDigest: approved.preview.previewDigest, approvalId: approved.approvalId },
        { client: agent, correlationId: "cli:action-lifecycle:durable", mode: "json" },
      );
      expect(result.semanticKind).toBe("success");
      await fixture.close();
      const reopened = new Database(fixture.databasePath, { strict: true });
      expect(reopened.query("SELECT terminal_state, executor_instance_id FROM action_plan_terminal_audit WHERE plan_id = ?;").get(approved.preview.plan.planId)).toEqual({ terminal_state: "completed", executor_instance_id: "executor:action-lifecycle-composition" });
      reopened.close();
    });
  });
});
