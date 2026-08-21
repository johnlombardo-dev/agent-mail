import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyMigrations,
  canonicalDatabaseMigrations,
  openDatabase,
} from "../src/index";
import { restoreBackup } from "../src/backup-restore";
import { writeBackup } from "../src/backup-writer";
import { createPendingActionPlan } from "../src/action-plan-repository";
import {
  authorityPreviewDigestForPlan,
  createApprovalSealKeyring,
  issueActionApproval,
  issueOperatorPresenceChallenge,
  recordTrustedActionPlanCreator,
} from "../src/action-approval-authority";
import { registerTrustedAuthorityContext } from "../src/trusted-authority-context";

const operatorSignature = Buffer.concat([
  Buffer.alloc(31),
  Buffer.from([1]),
  Buffer.alloc(31),
  Buffer.from([1]),
]);
const signatureBase64url = operatorSignature.toString("base64url");
const signatureSha256 = createHash("sha256").update(operatorSignature).digest("hex");
const authorityInstanceId = "instance:00000000-0000-4000-8000-000000000029";
const operatorCredentialId = "credential:operator";
const operatorPrincipalId = "principal:local-operator";
const approvalKeyring = createApprovalSealKeyring({
  keyId: "approval-seal-key:provenance-repair",
  keyHex: "1".repeat(64),
});

function plan(database: Database, planId: string): Readonly<{ planId: string; createdAt: string }> {
  return createPendingActionPlan(database, {
    planId,
    action: { kind: "markSeen" },
    targets: [
      {
        accountId: "account:one",
        mailboxId: "mailbox:inbox",
        uidValidity: 1,
        uid: 2,
        precondition: { modseq: 7 },
      },
    ],
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-08-20T01:00:00.000Z",
    previewDigest: "a".repeat(64),
    authorizationScope: "mail:action.commit",
    idempotencyIdentity: `provenance-repair:${planId}`,
  });
}

function operatorContext(planId: string, sequence: number) {
  const challengeId = `operator-challenge:provenance-${sequence}`;
  const challengeNonce = Buffer.alloc(32, sequence).toString("base64url");
  const requestPath = `/v1/action-plans/${encodeURIComponent(planId)}/approvals`;
  const issuedAt = "2026-08-20T00:00:01.000Z";
  const expiresAt = "2026-08-20T00:01:01.000Z";
  const requestBodySha256 = "b".repeat(64);
  const displayCode = "0000-0000-0000-0000-0000";
  const commitment = JSON.stringify([
    "agent-mail-operator-challenge-v1",
    authorityInstanceId,
    challengeId,
    challengeNonce,
    operatorCredentialId,
    operatorPrincipalId,
    "operator-interactive",
    "approve",
    "POST",
    requestPath,
    requestBodySha256,
    displayCode,
    1,
    issuedAt,
    expiresAt,
  ]);
  return {
    challenge: {
      challengeId,
      authorityInstanceId,
      operatorConfigurationRevision: 1,
      challengeNonceBase64url: challengeNonce,
      credentialId: operatorCredentialId,
      operation: "approve" as const,
      requestMethod: "POST" as const,
      requestPath,
      requestBodySha256,
      operatorDisplayCode: displayCode,
      challengeCommitment: commitment,
      issuedAt,
      expiresAt,
    },
    context: registerTrustedAuthorityContext({
      principalId: operatorPrincipalId,
      credentialId: operatorCredentialId,
      profile: "operator-interactive" as const,
      scopes: ["mail:action.approve"],
      authEventId: `auth-event:operator-approval-${sequence}`,
      authenticatedAt: issuedAt,
      credentialExpiresAt: "2027-08-20T00:00:01.000Z",
      presence: {
        kind: "human-present" as const,
        ceremonyId: challengeId,
        verifiedAt: issuedAt,
        validUntil: expiresAt,
        requestMethod: "POST" as const,
        requestPath,
        requestBodySha256,
        challengeCommitmentSha256: createHash("sha256").update(commitment).digest("hex"),
        assertionSignatureSha256: signatureSha256,
        assertionSignatureP1363Base64url: signatureBase64url,
        displayCode,
        authorityInstanceId,
        operatorConfigurationRevision: 1,
      },
    }),
  };
}

function issueApproval(
  database: Database,
  planId: string,
  sequence: number,
): Readonly<{ approvalId: string; planId: string }> {
  const operator = operatorContext(planId, sequence);
  issueOperatorPresenceChallenge(database, operator.challenge);
  const result = issueActionApproval(database, {
    request: {
      planId,
      planVersion: 1,
      previewDigest: authorityPreviewDigestForPlan(database, planId),
    },
    context: operator.context,
    now: "2026-08-20T00:00:01.000Z",
    keyring: approvalKeyring,
  });
  return result.approval;
}

function createCanonicalDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(database, canonicalDatabaseMigrations);
  return database;
}

describe("approval creator provenance repair migration", () => {
  test("keeps fresh and upgraded canonical files at the repair tip", () => {
    const fresh = createCanonicalDatabase();
    const upgraded = new Database(":memory:", { strict: true });
    upgraded.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(upgraded, canonicalDatabaseMigrations.slice(0, -1));
    applyMigrations(upgraded, canonicalDatabaseMigrations);

    for (const database of [fresh, upgraded]) {
      expect(database.query("PRAGMA user_version;").get()).toEqual({ user_version: 29 });
      expect(database.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?;").get("authority_v10_approval_creator_exact_guard")).toBeNull();
      expect(database.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?;").get("authority_v11_approval_creator_provenance_guard")).toEqual({ name: "authority_v11_approval_creator_provenance_guard" });
      database.close();
    }
  });

  test("allows distinct operator approval for operator- and agent-created plans", () => {
    const database = createCanonicalDatabase();
    const operatorPlan = plan(database, "plan:operator-creator");
    recordTrustedActionPlanCreator(database, {
      planId: operatorPlan.planId,
      principalId: operatorPrincipalId,
      credentialId: operatorCredentialId,
      profile: "operator-interactive",
      authEventId: "auth-event:operator-creation",
      createdAt: operatorPlan.createdAt,
    });
    const operatorApproval = issueApproval(database, operatorPlan.planId, 1);

    const agentPlan = plan(database, "plan:agent-creator");
    recordTrustedActionPlanCreator(database, {
      planId: agentPlan.planId,
      principalId: "principal:agent",
      credentialId: "credential:agent",
      profile: "agent-unattended",
      authEventId: "auth-event:agent-creation",
      createdAt: agentPlan.createdAt,
    });
    const agentApproval = issueApproval(database, agentPlan.planId, 2);

    expect(operatorApproval.planId).toBe(operatorPlan.planId);
    expect(agentApproval.planId).toBe(agentPlan.planId);
    expect(database.query("SELECT approver_auth_event_id FROM action_approvals WHERE plan_id = ?;").get(operatorPlan.planId)).toEqual({ approver_auth_event_id: "auth-event:operator-approval-1" });
    expect(database.query("SELECT auth_event_id FROM action_plan_creators WHERE plan_id = ?;").get(operatorPlan.planId)).toEqual({ auth_event_id: "auth-event:operator-creation" });
    expect(database.query("SELECT auth_event_id FROM action_plan_creators WHERE plan_id = ?;").get(agentPlan.planId)).toEqual({ auth_event_id: "auth-event:agent-creation" });
    database.close();
  });

  test("retains provenance and replay rejection on the additive guard", () => {
    const database = createCanonicalDatabase();
    const untrustedPlan = plan(database, "plan:missing-creator");
    database.query("INSERT INTO action_plan_authority_versions (plan_id, authority_version, reason_code, recorded_at) VALUES (?, 'trusted-v1', 'trusted-create', ?);").run(untrustedPlan.planId, untrustedPlan.createdAt);
    const operator = operatorContext(untrustedPlan.planId, 3);
    issueOperatorPresenceChallenge(database, operator.challenge);
    expect(() => issueActionApproval(database, {
      request: { planId: untrustedPlan.planId, planVersion: 1, previewDigest: authorityPreviewDigestForPlan(database, untrustedPlan.planId) },
      context: operator.context,
      now: "2026-08-20T00:00:01.000Z",
      keyring: approvalKeyring,
    })).toThrow("approval creator provenance is not trusted");
    expect(database.query("SELECT COUNT(*) AS count FROM action_approvals WHERE plan_id = ?;").get(untrustedPlan.planId)).toEqual({ count: 0 });
    database.close();
  });

  test("reopens and survives canonical backup and restore admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-provenance-repair-"));
    await chmod(root, 0o700);
    const data = join(root, "data");
    const blobs = join(root, "blobs");
    const journal = join(root, "journal");
    const config = join(root, "config");
    const backups = join(root, "backups");
    await Promise.all([data, blobs, journal, config, backups].map((path) => mkdir(path, { mode: 0o700 })));
    const databasePath = join(data, "archive.sqlite");
    const metadataPath = join(config, "archive-metadata.json");
    await writeFile(metadataPath, '{"format":"agent-mail","version":1}\n', { mode: 0o600 });

    const opened = await openDatabase(databasePath);
    const created = plan(opened.db, "plan:durable-reopen");
    recordTrustedActionPlanCreator(opened.db, {
      planId: created.planId,
      principalId: "principal:agent",
      credentialId: "credential:agent",
      profile: "agent-unattended",
      authEventId: "auth-event:agent-creation",
      createdAt: created.createdAt,
    });
    issueApproval(opened.db, created.planId, 4);
    await opened.close();

    const reopened = await openDatabase(databasePath);
    expect(reopened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 29 });
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM action_approvals WHERE plan_id = ?;").get(created.planId)).toEqual({ count: 1 });
    await reopened.close();

    const backupPath = join(backups, "canonical");
    await writeBackup({
      privateRoot: root,
      databasePath,
      blobDirectory: blobs,
      journalDirectory: journal,
      configurationMetadataPaths: [metadataPath],
      referencedBlobDigests: [],
      destination: backupPath,
    });
    const restored = await restoreBackup({ backupPath, destination: join(root, "restored") });
    const restoredOpened = await openDatabase(restored.databasePath);
    expect(restoredOpened.db.query("PRAGMA user_version;").get()).toEqual({ user_version: 29 });
    expect(restoredOpened.db.query("SELECT approver_auth_event_id FROM action_approvals WHERE plan_id = ?;").get(created.planId)).toEqual({ approver_auth_event_id: "auth-event:operator-approval-4" });
    await restoredOpened.close();
    await rm(root, { recursive: true, force: true });
  });
});
