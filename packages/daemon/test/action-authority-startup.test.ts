import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createUtcInstant } from "@agent-mail/core";
import { applyMigrations } from "../../storage/src/migration-runner";
import { actionAttemptDispatchMigrations } from "../../storage/src/migrations/0005-action-attempt-dispatch";
import { actionResultReconciliationMigration } from "../../storage/src/migrations/0007-action-result-reconciliation";
import { threadGraphMigration } from "../../storage/src/migrations/0008-thread-graph";
import { actionApprovalAuthorityMigration } from "../../storage/src/migrations/0009-action-approval-authority";
import { actionPlanRestoreQuarantineMigration } from "../../storage/src/migrations/0010-action-plan-restore-quarantine";
import { sealKeyAdministrationMigration } from "../../storage/src/migrations/0011-seal-key-administration";
import { createApprovalSealKeyring } from "../../storage/src/action-approval-authority";
import { issueOperatorPresenceChallenge } from "../../storage/src/action-approval-authority";
import { startAuthorityRuntime } from "../src/action-plan-restart-recovery";

describe("authority startup orchestration", () => {
  it("admits under the exclusive lock, clears ephemeral state, recovers, then starts listeners", async () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(database, [
      ...actionAttemptDispatchMigrations,
      { version: 6, name: "test-action-chain-placeholder", sql: "SELECT 1;" },
      actionResultReconciliationMigration,
      threadGraphMigration,
      actionApprovalAuthorityMigration,
      actionPlanRestoreQuarantineMigration,
      sealKeyAdministrationMigration,
    ]);
    const sealChallengeId = "operator-challenge:00000000-0000-4000-8000-000000000061";
    const sealKeyId = "approval-seal-key:00000000-0000-4000-8000-000000000062";
    const sealBody = JSON.stringify({ expectedKeyringRevision: 1, expectedActiveKeyId: sealKeyId });
    const sealBodySha256 = createHash("sha256").update(sealBody).digest("hex");
    const sealDisplayCode = createHash("sha256")
      .update(JSON.stringify(["agent-mail-presence-display-v1", "seal-key-rotate", "instance:00000000-0000-4000-8000-000000000001", 1, sealKeyId]))
      .digest("hex")
      .slice(0, 20)
      .match(/.{4}/gu)!
      .join("-");
    const sealIssuedAt = "2026-08-19T00:00:00.000Z";
    const sealExpiresAt = "2026-08-19T00:01:00.000Z";
    const sealNonce = Buffer.alloc(32, 6).toString("base64url");
    issueOperatorPresenceChallenge(database, {
      challengeId: sealChallengeId,
      authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
      operatorConfigurationRevision: 1,
      challengeNonceBase64url: sealNonce,
      credentialId: "credential:operator:" + "a".repeat(64),
      operation: "seal-key-rotate",
      requestMethod: "ADMIN",
      requestPath: "/internal/action-authority/seal-keyring/rotate",
      requestBodySha256: sealBodySha256,
      operatorDisplayCode: sealDisplayCode,
      challengeCommitment: JSON.stringify([
        "agent-mail-operator-challenge-v1",
        "instance:00000000-0000-4000-8000-000000000001",
        sealChallengeId,
        sealNonce,
        "credential:operator:" + "a".repeat(64),
        "principal:local-operator",
        "operator-interactive",
        "seal-key-rotate",
        "ADMIN",
        "/internal/action-authority/seal-keyring/rotate",
        sealBodySha256,
        sealDisplayCode,
        1,
        sealIssuedAt,
        sealExpiresAt,
      ]),
      issuedAt: sealIssuedAt,
      expiresAt: sealExpiresAt,
    });
    const events: string[] = [];
    const recovery = { discovered: 0, outcomes: [] as const };
    const result = await startAuthorityRuntime({
      admission: {
        database,
        restored: false,
        now: createUtcInstant("2026-08-19T00:00:00.000Z"),
        keyring: createApprovalSealKeyring({ keyId: "approval-seal-key:test", keyHex: "1".repeat(64) }),
        authorityInstanceId: "instance:00000000-0000-4000-8000-000000000001",
        configurationRevision: 1,
        activeCredentialIds: [],
      },
      authorityLock: {
        runShared: async (operation) => operation(),
        runExclusive: async (operation) => {
          events.push("admission-start");
          const value = await operation();
          events.push("admission-end");
          return value;
        },
      },
      clearEphemeralAuthority: () => { events.push("clear"); },
      recover: async () => { events.push("recover"); return recovery; },
      startAuthorityMutationServer: () => { events.push("mutation-server"); },
      startAuthorityChallengeServer: () => { events.push("challenge-server"); },
      startListeners: () => { events.push("listeners"); },
    });
    expect(result).toEqual({
      admission: { kind: "ordinary-restart", invalidatedApprovals: 0, quarantinedPlans: 0 },
      recovery,
    });
    expect(events).toEqual(["admission-start", "admission-end", "clear", "recover", "mutation-server", "challenge-server", "listeners"]);
    expect(database.query("SELECT reason_code FROM operator_presence_challenge_invalidations WHERE challenge_id = ?;").get(sealChallengeId)).toEqual({ reason_code: "configuration-change" });
    database.close();
  });
});
