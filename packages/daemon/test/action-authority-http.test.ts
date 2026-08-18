import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { actionAuthorityOperationDefinitions } from "@agent-mail/contracts";
import { createHttpApp, publicOperationRegistry } from "../src/http";
import {
  createActionCredentialRegistry,
  createOperatorSessionRegistry,
  OperatorSessionAuthority,
} from "../src/action-authority-auth";
import { registerTrustedAuthContext } from "../src/trusted-auth-context";
import type { OperatorPresenceRequest } from "../src/operator-presence";
import { OPERATOR_PRESENCE_PROTOCOL_VERSION } from "../src/operator-presence";
import { createTestA1Key, TestOperatorPresenceVerifier } from "./support/operator-presence";
import { applyMigrations } from "../../storage/src/migration-runner";
import { actionAttemptDispatchMigrations } from "../../storage/src/migrations/0005-action-attempt-dispatch";
import { actionResultReconciliationMigration } from "../../storage/src/migrations/0007-action-result-reconciliation";
import { threadGraphMigration } from "../../storage/src/migrations/0008-thread-graph";
import { actionApprovalAuthorityMigration } from "../../storage/src/migrations/0009-action-approval-authority";
import { actionPlanRestoreQuarantineMigration } from "../../storage/src/migrations/0010-action-plan-restore-quarantine";

describe("authority HTTP composition", () => {
  it("exposes strict authority routes without the retired authorize route", () => {
    expect(publicOperationRegistry.get("operator-sessions.create")?.scope).toBeNull();
    expect(publicOperationRegistry.get("action-plans.approve")?.route).toBe(
      "/v1/action-plans/{planId}/approvals",
    );
    expect(publicOperationRegistry.get("action-plans.authorize")).toBeUndefined();
    expect(actionAuthorityOperationDefinitions.map((operation) => operation.key)).toContain(
      "action-plans.cancel-approval",
    );
  });

  it("keeps operator-session issuance loopback-only", async () => {
    let invoked = false;
    const app = createHttpApp({
      handlers: {
        "operator-sessions.create": () => {
          invoked = true;
          return {};
        },
      },
      authenticate: () => ({
        kind: "authenticated",
        principal: { subject: "principal:operator", scopes: [] },
      }),
    });
    const response = await app.request(
      new Request("https://remote.example/v1/operator-sessions", {
        method: "POST",
        headers: { authorization: "Bearer operator", "content-type": "application/json" },
        body: JSON.stringify({ requestedScopes: ["mail:action.create", "mail:action.inspect"] }),
      }),
    );
    expect(response.status).toBe(403);
    expect(invoked).toBe(false);
  });

  it("projects registered approval failures with their stable HTTP status and safe details", async () => {
    let observedBodyHash: string | undefined;
    const app = createHttpApp({
      handlers: {
        "action-plans.approve": (_input, context) => {
          observedBodyHash = context.requestBodySha256;
          throw {
            code: "action.approval_expired",
            message: "action approval has expired",
            details: {
              planId: "plan:one",
              approvalId: "approval:one",
              expiredAt: "2026-08-18T00:10:00.000Z",
            },
          };
        },
      },
      authenticate: () => ({
        kind: "authenticated",
        principal: { subject: "principal:operator", scopes: ["mail:action.approve"] },
      }),
    });
    const response = await app.request(
      new Request("http://localhost/v1/action-plans/plan%3Aone/approvals", {
        method: "POST",
        headers: { authorization: "Bearer operator", "content-type": "application/json" },
        body: JSON.stringify({
          planId: "plan:one",
          planVersion: 1,
          previewDigest: "a".repeat(64),
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(observedBodyHash).toBe(
      createHash("sha256")
        .update(JSON.stringify({ planId: "plan:one", planVersion: 1, previewDigest: "a".repeat(64) }))
        .digest("hex"),
    );
    expect(await response.json()).toMatchObject({
      code: "action.approval_expired",
      details: { planId: "plan:one", approvalId: "approval:one" },
    });
  });

  it("forwards only validated authenticated profile context to authority handlers", async () => {
    let observedProfile: unknown;
    const app = createHttpApp({
      handlers: { "action-plans.approve": (_input, context) => { observedProfile = context.authContext; return { approval: { state: "available", approvalId: "approval:one", planId: "plan:one", planVersion: 1, previewDigest: "a".repeat(64), targetDigest: "b".repeat(64), normalizedIntent: "[\"action-intent-v1\"]", issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:10:00.000Z", authorizationScope: "mail:action.commit", approver: { principalId: "principal:local-operator", profile: "operator-interactive" } } }; } },
      authenticate: () => ({ kind: "authenticated", principal: { subject: "principal:local-operator", scopes: ["mail:action.approve"] }, context: registerTrustedAuthContext({ principalId: "principal:local-operator", credentialId: "credential:operator", profile: "operator-interactive", scopes: ["mail:action.approve"], authEventId: "auth-event:one", authenticatedAt: "2026-08-18T00:00:00.000Z", credentialExpiresAt: "2027-08-18T00:00:00.000Z", presence: { kind: "human-present", ceremonyId: "operator-challenge:one", verifiedAt: "2026-08-18T00:00:00.000Z", validUntil: "2026-08-18T00:01:00.000Z", requestMethod: "POST", requestPath: "/v1/action-plans/plan%3Aone/approvals", requestBodySha256: "0".repeat(64), challengeCommitmentSha256: "1".repeat(64), assertionSignatureSha256: "2".repeat(64), assertionSignatureP1363Base64url: Buffer.alloc(64, 1).toString("base64url"), operatorDisplayCode: "0000-0000-0000-0000-0000", authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001", operatorConfigurationRevision: 1 } }) }),
    });
    const response = await app.request(new Request("http://localhost/v1/action-plans/plan%3Aone/approvals", { method: "POST", headers: { authorization: "Bearer operator", "content-type": "application/json" }, body: JSON.stringify({ planId: "plan:one", planVersion: 1, previewDigest: "a".repeat(64) }) }));
    expect(response.status).toBe(200);
    expect((observedProfile as { readonly profile: string }).profile).toBe("operator-interactive");
  });

  it("rejects a caller-supplied authority context before the action handler", async () => {
    let invoked = false;
    const app = createHttpApp({
      handlers: {
        "action-plans.approve": () => {
          invoked = true;
          return {};
        },
      },
      authenticate: () => ({
        kind: "authenticated",
        principal: { subject: "principal:local-operator", scopes: ["mail:action.approve"] },
        context: {
          principalId: "principal:local-operator",
          credentialId: "credential:forged",
          profile: "operator-interactive",
          scopes: ["mail:action.approve"],
          authEventId: "auth-event:forged",
          authenticatedAt: "2026-08-18T00:00:00.000Z",
          credentialExpiresAt: "2027-08-18T00:00:00.000Z",
          presence: { kind: "human-present", ceremonyId: "operator-challenge:forged", verifiedAt: "2026-08-18T00:00:00.000Z", validUntil: "2026-08-18T00:01:00.000Z", requestMethod: "POST", requestPath: "/v1/action-plans/plan%3Aforged/approvals", requestBodySha256: "0".repeat(64), challengeCommitmentSha256: "1".repeat(64), assertionSignatureSha256: "2".repeat(64), assertionSignatureP1363Base64url: Buffer.alloc(64, 1).toString("base64url"), operatorDisplayCode: "0000-0000-0000-0000-0000", authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001", operatorConfigurationRevision: 1 },
        },
      }),
    });
    const response = await app.request(new Request("http://localhost/v1/action-plans/plan%3Aforged/approvals", { method: "POST", headers: { authorization: "Bearer forged", "content-type": "application/json" }, body: JSON.stringify({ planId: "plan:forged", planVersion: 1, previewDigest: "a".repeat(64) }) }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_credentials" });
    expect(invoked).toBe(false);
  });

  it("composes a loopback broker-backed session and returns the raw token once", async () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(database, [
      ...actionAttemptDispatchMigrations,
      { version: 6, name: "test-action-chain-placeholder", sql: "SELECT 1;" },
      actionResultReconciliationMigration,
      threadGraphMigration,
      actionApprovalAuthorityMigration,
      actionPlanRestoreQuarantineMigration,
    ]);
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + 365 * 24 * 60 * 60 * 1_000).toISOString();
    const operatorKeys = createTestA1Key();
    const operatorPublicKey = operatorKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const credentials = createActionCredentialRegistry([
      {
        credentialId: "credential:operator",
        principalId: "principal:local-operator",
        profile: "operator-interactive",
        scopes: ["mail:action.create", "mail:action.inspect", "mail:action.approve"],
        algorithm: "ES256",
        publicKeySpkiBase64url: operatorPublicKey,
        publicKeySpkiSha256: createHash("sha256").update(Buffer.from(operatorPublicKey, "base64url")).digest("hex"),
        status: "active",
        enrolledAt: issuedAt,
        expiresAt,
        revokedAt: null,
        replacedByCredentialId: null,
      },
    ]);
    const sessions = createOperatorSessionRegistry(credentials, credentials.revision);
    const authorityInstanceId = "instance:00000000-0000-4000-8000-000000000002";
    let liveRevision = 1;
    let liveCredentials = credentials;
    const requestBody = new TextEncoder().encode(
      JSON.stringify({ requestedScopes: ["mail:action.create", "mail:action.inspect"] }),
    );
    const challengeId = "operator-challenge:http";
    const challengeNonce = Buffer.alloc(32, 1).toString("base64url");
    const challengeIssuedAt = issuedAt;
    const challengeExpiresAt = new Date(Date.parse(issuedAt) + 60_000).toISOString();
    const challengeDisplayCode = createHash("sha256")
      .update(
        JSON.stringify([
          "agent-mail-presence-display-v1",
          "open-session",
          authorityInstanceId,
          "mail:action.create",
          "mail:action.inspect",
        ]),
      )
      .digest("hex")
      .slice(0, 20)
      .match(/.{4}/gu)!
      .join("-");
    const broker = {
      issue: async (request: OperatorPresenceRequest) => ({
        challengeId,
        nonceBase64url: challengeNonce,
        commitment: JSON.stringify([
          "agent-mail-operator-challenge-v1",
          request.authorityInstanceId,
          challengeId,
          challengeNonce,
          request.credentialId,
          request.principalId,
          "operator-interactive",
          request.operation,
          request.method,
          request.path,
          createHash("sha256").update(request.rawBody).digest("hex"),
          challengeDisplayCode,
          request.configurationRevision,
          challengeIssuedAt,
          challengeExpiresAt,
        ]),
        displayCode: challengeDisplayCode,
        issuedAt: challengeIssuedAt,
        expiresAt: challengeExpiresAt,
        request: {
          operation: request.operation,
          method: request.method,
          path: request.path,
          bodySha256: createHash("sha256").update(request.rawBody).digest("hex"),
          principalId: request.principalId,
          credentialId: request.credentialId,
          authorityInstanceId: request.authorityInstanceId,
          configurationRevision: request.configurationRevision,
          operatorDisplayCode: challengeDisplayCode,
        },
      }),
      verify: async () => undefined,
    };
    const authority = new OperatorSessionAuthority({
      database,
      credentials,
      sessions,
      broker,
      authorityInstanceId,
      configurationRevision: 1,
      loadCurrent: async () => ({
        credentials: liveCredentials,
        authorityInstanceId,
        configurationRevision: liveRevision,
      }),
    });
    const challenge = await authority.issueChallenge({
      operation: "open-session",
      method: "POST",
      path: "/v1/operator-sessions",
      rawBody: requestBody,
      credentialId: "credential:operator",
      principalId: "principal:local-operator",
      authorityInstanceId,
      configurationRevision: 1,
    });
    const signature = new TestOperatorPresenceVerifier(operatorKeys.publicKey).signForTest(challenge, operatorKeys.privateKey).signatureP1363Base64url;
    const app = createHttpApp({ operatorSessionAuthority: authority });
    const headers = {
      "content-type": "application/json",
      authorization: `AgentMail-Operator ${Buffer.from(JSON.stringify({ version: OPERATOR_PRESENCE_PROTOCOL_VERSION, challengeId: challenge.challengeId, credentialId: "credential:operator", signatureBase64url: signature })).toString("base64url")}`,
    };
    const first = await app.request(new Request("http://localhost/v1/operator-sessions", { method: "POST", headers, body: requestBody }));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { readonly token: string; readonly sessionId: string };
    expect(firstBody.token.length).toBeGreaterThan(20);
    expect(firstBody.sessionId).toStartWith("operator-session:");
    const replay = await app.request(new Request("http://localhost/v1/operator-sessions", { method: "POST", headers, body: requestBody }));
    expect(replay.status).toBe(409);
    expect(JSON.stringify(await replay.json())).not.toContain(firstBody.token);
    liveRevision = 2;
    const replacementKeys = createTestA1Key();
    const replacementPublicKey = replacementKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const replacementCredentialId = `credential:operator:${"b".repeat(64)}`;
    liveCredentials = createActionCredentialRegistry([
      {
        credentialId: replacementCredentialId,
        principalId: "principal:local-operator",
        profile: "operator-interactive",
        scopes: ["mail:action.create", "mail:action.inspect", "mail:action.approve"],
        algorithm: "ES256",
        publicKeySpkiBase64url: replacementPublicKey,
        publicKeySpkiSha256: createHash("sha256").update(Buffer.from(replacementPublicKey, "base64url")).digest("hex"),
        status: "active",
        enrolledAt: issuedAt,
        expiresAt,
        revokedAt: null,
        replacedByCredentialId: null,
      },
    ], 2);
    expect((await authority.currentBinding()).configurationRevision).toBe(2);
    expect(sessions.authenticate(firstBody.token).kind).toBe("invalid");
    const replacementChallenge = await authority.issueChallenge({
      operation: "open-session",
      method: "POST",
      path: "/v1/operator-sessions",
      rawBody: requestBody,
      credentialId: replacementCredentialId,
      principalId: "principal:local-operator",
      authorityInstanceId,
      configurationRevision: 2,
    });
    const replacementSignature = new TestOperatorPresenceVerifier(replacementKeys.publicKey)
      .signForTest(replacementChallenge, replacementKeys.privateKey)
      .signatureP1363Base64url;
    const replacementSession = await authority.open(
      {
        operation: "open-session",
        method: "POST",
        path: "/v1/operator-sessions",
        rawBody: requestBody,
        credentialId: replacementCredentialId,
        principalId: "principal:local-operator",
        authorityInstanceId,
        configurationRevision: 2,
      },
      {
        version: OPERATOR_PRESENCE_PROTOCOL_VERSION,
        challengeId: replacementChallenge.challengeId,
        credentialId: replacementCredentialId,
        signatureP1363Base64url: replacementSignature,
      },
    );
    expect(sessions.authenticate(replacementSession.token).kind).toBe("authenticated");
    const remote = await app.request(new Request("https://remote.example/v1/operator-sessions", { method: "POST", headers, body: requestBody }));
    expect(remote.status).toBe(401);
  });
});
