import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createActionCredentialRegistry, authenticateActionCredential, createOperatorSessionRegistry } from "../src/action-authority-auth";
import { loadOperatorCredentialConfiguration, writeOperatorCredentialConfiguration } from "../src/action-authority-auth";
import { OperatorPresenceError } from "../src/operator-presence";
import { createTestA1Key, TestOperatorPresenceVerifier as OperatorPresenceVerifier } from "./support/operator-presence";

const issuedAt = "2026-08-18T00:00:00.000Z";
const expiresAt = "2027-08-18T00:00:00.000Z";
const operatorPublicKey = createTestA1Key().publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const operatorPublicKeySha256 = createHash("sha256").update(Buffer.from(operatorPublicKey, "base64url")).digest("hex");

describe("action credential profiles and A1 presence", () => {
  it("rejects composable profiles and static operator bearer credentials", () => {
    expect(() => createActionCredentialRegistry([{ credentialId: "credential:operator", principalId: "principal:local-operator", profile: "operator-interactive", scopes: ["mail:action.approve", "mail:action.commit"], algorithm: "ES256", publicKeySpkiBase64url: operatorPublicKey, publicKeySpkiSha256: operatorPublicKeySha256, status: "active", enrolledAt: issuedAt, expiresAt, revokedAt: null, replacedByCredentialId: null }])).toThrow();
    const registry = createActionCredentialRegistry([
      { credentialId: "credential:operator", principalId: "principal:local-operator", profile: "operator-interactive", scopes: ["mail:action.create", "mail:action.inspect", "mail:action.approve"], algorithm: "ES256", publicKeySpkiBase64url: operatorPublicKey, publicKeySpkiSha256: operatorPublicKeySha256, status: "active", enrolledAt: issuedAt, expiresAt, revokedAt: null, replacedByCredentialId: null },
      { credentialId: "credential:agent", principalId: "principal:agent", profile: "agent-unattended", scopes: ["mail:action.create", "mail:action.inspect", "mail:action.commit"], secret: "machine:agent", issuedAt, expiresAt, authEventId: "event:two" },
    ]);
    const authenticated = authenticateActionCredential(registry, "machine:agent", issuedAt);
    expect(authenticated.kind).toBe("authenticated");
    if (authenticated.kind === "authenticated") expect(authenticated.context?.profile).toBe("agent-unattended");
    expect(authenticateActionCredential(registry, "secure-enclave:operator", issuedAt).kind).toBe("invalid");
    const sessions = createOperatorSessionRegistry(registry, registry.revision);
    expect(() => sessions.issue({} as never)).toThrow(/verified operator/);
  });

  it("binds A1 signatures to exact method/path/body and consumes challenges once", () => {
    const keys = createTestA1Key();
    const verifier = new OperatorPresenceVerifier(keys.publicKey);
    const request = { operation: "approve" as const, method: "POST" as const, path: "/v1/action-plans/plan%3Aone/approvals", rawBody: new TextEncoder().encode(JSON.stringify({ planId: "plan:one", planVersion: 1, previewDigest: "a".repeat(64) })), principalId: "principal:local-operator", credentialId: "credential:operator", authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001", configurationRevision: 1 };
    const challenge = verifier.issue(request, issuedAt);
    const assertion = verifier.signForTest(challenge, keys.privateKey, "2026-08-18T00:00:01.000Z");
    expect(verifier.verifyAndConsume(assertion, request, "2026-08-18T00:00:01.000Z").challengeId).toBe(challenge.challengeId);
    expect(() => verifier.verifyAndConsume(assertion, request, "2026-08-18T00:00:02.000Z")).toThrow(OperatorPresenceError);
    const changed = { ...request, path: `${request.path}/changed` };
    const fresh = verifier.issue(request, issuedAt);
    const signed = verifier.signForTest(fresh, keys.privateKey, "2026-08-18T00:00:01.000Z");
    expect(() => verifier.verifyAndConsume(signed, changed, "2026-08-18T00:00:01.000Z")).toThrow();
  });

  it("bounds outstanding challenges per credential", () => {
    const keys = createTestA1Key();
    const verifier = new OperatorPresenceVerifier(keys.publicKey);
    const request = {
      operation: "approve" as const,
      method: "POST" as const,
      path: "/v1/action-plans/plan%3Aone/approvals",
      rawBody: new TextEncoder().encode(
        JSON.stringify({ planId: "plan:one", planVersion: 1, previewDigest: "a".repeat(64) }),
      ),
      principalId: "principal:local-operator",
      credentialId: "credential:operator",
      authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
      configurationRevision: 1,
    };
    for (let index = 0; index < 4; index += 1) verifier.issue(request, issuedAt);
    try {
      verifier.issue(request, issuedAt);
      throw new Error("expected bounded challenge issuance to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OperatorPresenceError);
      expect((error as OperatorPresenceError).code).toBe("action.operator_challenge_capacity");
    }
  });

  it("round-trips owner-only public operator configuration without private key material", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-operator-config-"));
    await chmod(root, 0o700);
    try {
      const publicKey = createTestA1Key().publicKey.export({ format: "der", type: "spki" }).toString("base64url");
      const configuration = {
        schemaVersion: 1 as const,
        authorityInstanceId: "instance:00000000-0000-4000-8000-000000000010",
        configurationRevision: 4,
        updatedAt: issuedAt,
        credentials: [{
          credentialId: "credential:operator:" + "a".repeat(64),
          principalId: "principal:local-operator" as const,
          profile: "operator-interactive" as const,
          algorithm: "ES256" as const,
          publicKeySpkiBase64url: publicKey,
          publicKeySpkiSha256: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
          status: "active" as const,
          enrolledAt: issuedAt,
          expiresAt,
          revokedAt: null,
          replacedByCredentialId: null,
        }],
      };
      await writeOperatorCredentialConfiguration(root, configuration);
      const loaded = await loadOperatorCredentialConfiguration(root);
      expect(loaded.configuration.configurationRevision).toBe(4);
      expect(loaded.credentials.byId.get(configuration.credentials[0].credentialId)?.profile).toBe("operator-interactive");
      expect(JSON.stringify(loaded.configuration)).not.toContain("privateKey");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
