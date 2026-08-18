import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash, sign, type KeyObject } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applySealKeyAdministration,
  replaceOperatorCredentialConfiguration,
  type AuthorityMutationOptions,
} from "../src/action-authority-mutations";
import { writeOperatorCredentialConfiguration } from "../src/action-authority-auth";
import { createTestA1Key } from "./support/operator-presence";
import { applyMigrations } from "../../storage/src/migration-runner";
import { actionAttemptDispatchMigrations } from "../../storage/src/migrations/0005-action-attempt-dispatch";
import { actionResultReconciliationMigration } from "../../storage/src/migrations/0007-action-result-reconciliation";
import { threadGraphMigration } from "../../storage/src/migrations/0008-thread-graph";
import { actionApprovalAuthorityMigration } from "../../storage/src/migrations/0009-action-approval-authority";
import { actionPlanRestoreQuarantineMigration } from "../../storage/src/migrations/0010-action-plan-restore-quarantine";
import { sealKeyAdministrationMigration } from "../../storage/src/migrations/0011-seal-key-administration";
import {
  issueOperatorPresenceChallenge,
  type OperatorPresenceChallengeIssueInput,
} from "../../storage/src/action-approval-authority";
import {
  writeApprovalSealKeyringFile,
  type ApprovalSealKeyringFile,
} from "../../storage/src/action-approval-keyring";

const roots: string[] = [];
const now = "2026-08-19T00:00:30.000Z";
const authorityInstanceId = "instance:00000000-0000-4000-8000-000000000030";
const lock = {
  runShared: async <T>(operation: () => T | Promise<T>) => operation(),
  runExclusive: async <T>(operation: () => T | Promise<T>) => operation(),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function publicKeyMaterial(key: KeyObject): Readonly<{ publicKeySpkiBase64url: string; publicKeySpkiSha256: string }> {
  const publicKeySpkiBase64url = key.export({ format: "der", type: "spki" }).toString("base64url");
  return {
    publicKeySpkiBase64url,
    publicKeySpkiSha256: createHash("sha256")
      .update(Buffer.from(publicKeySpkiBase64url, "base64url"))
      .digest("hex"),
  };
}

function lowSSignature(privateKey: KeyObject, commitment: string): string {
  const signature = Buffer.from(
    sign("sha256", Buffer.from(commitment), { key: privateKey, dsaEncoding: "ieee-p1363" }),
  );
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  if (s > order / 2n)
    signature.set(Buffer.from((order - s).toString(16).padStart(64, "0"), "hex"), 32);
  return signature.toString("base64url");
}

function credential(
  key: KeyObject,
  credentialId: string,
  status: "active" | "revoked" = "active",
): Record<string, unknown> {
  const material = publicKeyMaterial(key);
  return {
    credentialId,
    principalId: "principal:local-operator",
    profile: "operator-interactive",
    algorithm: "ES256",
    ...material,
    status,
    enrolledAt: "2026-08-19T00:00:00.000Z",
    expiresAt: "2027-08-19T00:00:00.000Z",
    revokedAt: status === "revoked" ? now : null,
    replacedByCredentialId: null,
  };
}

function enrollmentProof(
  configuration: Record<string, unknown> & { readonly credentials: readonly Record<string, unknown>[] },
  key: KeyObject,
  enrollmentId: string,
): Readonly<{ readonly commitment: string; readonly signature: string }> {
  const record = configuration.credentials.find((candidate) => candidate.status === "active");
  if (record === undefined) throw new Error("active record missing");
  const commitment = JSON.stringify([
    "agent-mail-operator-enrollment-v1",
    configuration.authorityInstanceId,
    enrollmentId,
    "principal:local-operator",
    record.credentialId,
    "operator-interactive",
    "ES256",
    record.publicKeySpkiBase64url,
    record.enrolledAt,
    Buffer.alloc(32, 9).toString("base64url"),
  ]);
  return { commitment, signature: lowSSignature(key, commitment) };
}

function options(root: string): AuthorityMutationOptions {
  return {
    privateRoot: root,
    database: new Database(":memory:", { strict: true }),
    authorityLock: lock,
    now: () => now,
  };
}

function migratedDatabase(): Database {
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
  return database;
}

describe("operator ceremony active-set boundary", () => {
  test("rejects initial enrollment with a second unsigned active record before file publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-ceremony-active-set-"));
    roots.push(root);
    await chmod(root, 0o700);
    const enrolledKey = createTestA1Key();
    const attackerKey = createTestA1Key();
    const enrolled = credential(enrolledKey.publicKey, "credential:operator:" + "1".repeat(64));
    const attacker = credential(attackerKey.publicKey, "credential:operator:" + "2".repeat(64));
    const configuration = {
      schemaVersion: 1 as const,
      authorityInstanceId,
      configurationRevision: 1,
      updatedAt: now,
      credentials: [enrolled, attacker],
    };
    const proof = enrollmentProof(configuration, enrolledKey.privateKey, "enrollment:one");
    await expect(
      replaceOperatorCredentialConfiguration(options(root), {
        kind: "enroll",
        configuration,
        enrollmentCommitment: proof.commitment,
        signatureP1363Base64url: proof.signature,
      }),
    ).rejects.toThrow(/exactly one active|enrollment/);
    await expect(readFile(join(root, "config", "operator-credentials.v1.json"))).rejects.toThrow();
  });

  test("rejects recovery with an unsigned active attacker and preserves the old file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-ceremony-recovery-set-"));
    roots.push(root);
    await chmod(root, 0o700);
    const currentKey = createTestA1Key();
    const current = {
      schemaVersion: 1 as const,
      authorityInstanceId,
      configurationRevision: 1,
      updatedAt: now,
      credentials: [credential(currentKey.publicKey, "credential:operator:" + "3".repeat(64))],
    };
    await writeOperatorCredentialConfiguration(root, current);
    const before = await readFile(join(root, "config", "operator-credentials.v1.json"), "utf8");
    const replacementKey = createTestA1Key();
    const attackerKey = createTestA1Key();
    const next = {
      schemaVersion: 1 as const,
      authorityInstanceId: "instance:00000000-0000-4000-8000-000000000031",
      configurationRevision: 2,
      updatedAt: now,
      credentials: [
        credential(replacementKey.publicKey, "credential:operator:" + "4".repeat(64)),
        credential(attackerKey.publicKey, "credential:operator:" + "5".repeat(64)),
      ],
    };
    const proof = enrollmentProof(next, replacementKey.privateKey, "enrollment:recover");
    await expect(
      replaceOperatorCredentialConfiguration(options(root), {
        kind: "recover",
        configuration: next,
        replacementEnrollmentCommitment: proof.commitment,
        replacementEnrollmentSignatureP1363Base64url: proof.signature,
      }),
    ).rejects.toThrow(/exactly one active|recovery/);
    expect(await readFile(join(root, "config", "operator-credentials.v1.json"), "utf8")).toBe(before);
  });

  test("accepts a signed revoke with zero active credentials and no new ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-ceremony-revoke-"));
    roots.push(root);
    await chmod(root, 0o700);
    const currentKey = createTestA1Key();
    const credentialId = "credential:operator:" + "6".repeat(64);
    const current = {
      schemaVersion: 1 as const,
      authorityInstanceId,
      configurationRevision: 1,
      updatedAt: now,
      credentials: [credential(currentKey.publicKey, credentialId)],
    };
    await writeOperatorCredentialConfiguration(root, current);
    const next = {
      ...current,
      configurationRevision: 2,
      credentials: [credential(currentKey.publicKey, credentialId, "revoked")],
    };
    const commitment = JSON.stringify([
      "agent-mail-operator-revocation-v1",
      authorityInstanceId,
      credentialId,
      now,
      Buffer.alloc(32, 8).toString("base64url"),
    ]);
    const database = migratedDatabase();
    try {
      const result = await replaceOperatorCredentialConfiguration(
        { ...options(root), database },
        {
          kind: "revoke",
          configuration: next,
          credentialId,
          revocationCommitment: commitment,
          revocationSignatureP1363Base64url: lowSSignature(currentKey.privateKey, commitment),
        },
      );
      expect(result.invalidatedApprovals).toBe(0);
      expect(JSON.parse(await readFile(join(root, "config", "operator-credentials.v1.json"), "utf8")).credentials[0].status).toBe("revoked");
    } finally {
      database.close();
    }
  });
});

describe("D28 seal-key administration boundary", () => {
  test("requires the daemon challenge, exact ADMIN body, current assertion, and consumes once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-seal-admin-"));
    roots.push(root);
    await chmod(root, 0o700);
    await mkdir(join(root, "secrets"), { mode: 0o700 });
    const operatorKeys = createTestA1Key();
    const credentialId = "credential:operator:" + "7".repeat(64);
    const configuration = {
      schemaVersion: 1 as const,
      authorityInstanceId,
      configurationRevision: 1,
      updatedAt: now,
      credentials: [credential(operatorKeys.publicKey, credentialId)],
    };
    await writeOperatorCredentialConfiguration(root, configuration);
    const activeKeyId = "approval-seal-key:00000000-0000-4000-8000-000000000040";
    const keyring: ApprovalSealKeyringFile = {
      schemaVersion: 1,
      keyringRevision: 1,
      updatedAt: now,
      activeKeyId,
      keys: [
        {
          keyId: activeKeyId,
          status: "active",
          keyBase64url: Buffer.alloc(32, 1).toString("base64url"),
          createdAt: now,
          statusChangedAt: now,
        },
      ],
    };
    await writeApprovalSealKeyringFile(join(root, "secrets", "action-approval-seal-keyring.v1.json"), keyring);
    const database = migratedDatabase();
    try {
      const operation = "seal-key-rotate" as const;
      const requestPath = "/internal/action-authority/seal-keyring/rotate";
      const body = JSON.stringify({ expectedKeyringRevision: 1, expectedActiveKeyId: activeKeyId });
      const bodyBytes = Buffer.from(body);
      const bodySha256 = createHash("sha256").update(bodyBytes).digest("hex");
      const displayCode = createHash("sha256")
        .update(JSON.stringify(["agent-mail-presence-display-v1", operation, authorityInstanceId, 1, activeKeyId]))
        .digest("hex")
        .slice(0, 20)
        .match(/.{4}/gu)!
        .join("-");
      const challengeId = "operator-challenge:00000000-0000-4000-8000-000000000041";
      const nonce = Buffer.alloc(32, 2).toString("base64url");
      const issuedAt = now;
      const expiresAt = "2026-08-19T00:01:30.000Z";
      const commitment = JSON.stringify([
        "agent-mail-operator-challenge-v1",
        authorityInstanceId,
        challengeId,
        nonce,
        credentialId,
        "principal:local-operator",
        "operator-interactive",
        operation,
        "ADMIN",
        requestPath,
        bodySha256,
        displayCode,
        1,
        issuedAt,
        expiresAt,
      ]);
      const challenge: OperatorPresenceChallengeIssueInput = {
        challengeId,
        authorityInstanceId,
        operatorConfigurationRevision: 1,
        challengeNonceBase64url: nonce,
        credentialId,
        operation,
        requestMethod: "ADMIN",
        requestPath,
        requestBodySha256: bodySha256,
        operatorDisplayCode: displayCode,
        challengeCommitment: commitment,
        issuedAt,
        expiresAt,
      };
      issueOperatorPresenceChallenge(database, challenge);
      const signature = lowSSignature(operatorKeys.privateKey, commitment);
      const envelope = {
        version: "agent-mail-action-authority-admin-v1" as const,
        requestBodyBase64url: bodyBytes.toString("base64url"),
        assertion: {
          version: "agent-mail-macos-operator-presence-v1" as const,
          challengeId,
          credentialId,
          signatureBase64url: signature,
        },
      };
      const result = await applySealKeyAdministration({ ...options(root), database }, envelope);
      expect(result.keyring.keyringRevision).toBe(2);
      expect(result.keyring.activeKeyId).not.toBe(activeKeyId);
      expect(database.query("SELECT operation, authority_output_kind, authority_output_id FROM operator_presence_challenge_consumptions WHERE challenge_id = ?;").get(challengeId)).toEqual({
        operation,
        authority_output_kind: "seal-key-rotation",
        authority_output_id: "seal-keyring-revision:2",
      });
      await expect(applySealKeyAdministration({ ...options(root), database }, envelope)).rejects.toThrow();
      const reopened = await import("../../storage/src/action-approval-keyring").then(({ loadApprovalSealKeyringFile }) =>
        loadApprovalSealKeyringFile({ privateRoot: root, databaseExists: true }));
      expect(reopened.file.keyringRevision).toBe(2);
      const removedKey = reopened.file.keys.find((key) => key.status === "verify-only");
      if (removedKey === undefined) throw new Error("rotated keyring did not retain verify-only key");
      const removeOperation = "seal-key-remove" as const;
      const removePath = "/internal/action-authority/seal-keyring/remove";
      const removeBody = JSON.stringify({ expectedKeyringRevision: 2, keyId: removedKey.keyId });
      const removeBodyBytes = Buffer.from(removeBody);
      const removeBodySha256 = createHash("sha256").update(removeBodyBytes).digest("hex");
      const removeDisplayCode = createHash("sha256")
        .update(JSON.stringify(["agent-mail-presence-display-v1", removeOperation, authorityInstanceId, 2, removedKey.keyId]))
        .digest("hex")
        .slice(0, 20)
        .match(/.{4}/gu)!
        .join("-");
      const removeChallengeId = "operator-challenge:00000000-0000-4000-8000-000000000042";
      const removeNonce = Buffer.alloc(32, 3).toString("base64url");
      const removeCommitment = JSON.stringify([
        "agent-mail-operator-challenge-v1", authorityInstanceId, removeChallengeId,
        removeNonce, credentialId, "principal:local-operator", "operator-interactive",
        removeOperation, "ADMIN", removePath, removeBodySha256, removeDisplayCode, 1, issuedAt, expiresAt,
      ]);
      issueOperatorPresenceChallenge(database, {
        ...challenge,
        challengeId: removeChallengeId,
        challengeNonceBase64url: removeNonce,
        operation: removeOperation,
        requestPath: removePath,
        requestBodySha256: removeBodySha256,
        operatorDisplayCode: removeDisplayCode,
        challengeCommitment: removeCommitment,
      });
      const removeEnvelope = {
        version: "agent-mail-action-authority-admin-v1" as const,
        requestBodyBase64url: removeBodyBytes.toString("base64url"),
        assertion: {
          version: "agent-mail-macos-operator-presence-v1" as const,
          challengeId: removeChallengeId,
          credentialId,
          signatureBase64url: lowSSignature(operatorKeys.privateKey, removeCommitment),
        },
      };
      const removed = await applySealKeyAdministration({ ...options(root), database }, removeEnvelope);
      expect(removed.keyring.keyringRevision).toBe(3);
      expect(removed.keyring.keys.some((key) => key.keyId === removedKey.keyId)).toBe(false);
      expect(database.query("SELECT authority_output_kind, authority_output_id FROM operator_presence_challenge_consumptions WHERE challenge_id = ?;").get(removeChallengeId)).toEqual({
        authority_output_kind: "seal-key-removal",
        authority_output_id: "seal-keyring-revision:3",
      });
      const staleTarget = removed.keyring.activeKeyId;
      const staleBody = JSON.stringify({ expectedKeyringRevision: 2, expectedActiveKeyId: staleTarget });
      const staleBodyBytes = Buffer.from(staleBody);
      const staleBodySha256 = createHash("sha256").update(staleBodyBytes).digest("hex");
      const staleDisplayCode = createHash("sha256")
        .update(JSON.stringify(["agent-mail-presence-display-v1", operation, authorityInstanceId, 2, staleTarget]))
        .digest("hex")
        .slice(0, 20)
        .match(/.{4}/gu)!
        .join("-");
      const staleChallengeId = "operator-challenge:00000000-0000-4000-8000-000000000043";
      const staleNonce = Buffer.alloc(32, 4).toString("base64url");
      const staleCommitment = JSON.stringify([
        "agent-mail-operator-challenge-v1", authorityInstanceId, staleChallengeId,
        staleNonce, credentialId, "principal:local-operator", "operator-interactive", operation,
        "ADMIN", requestPath, staleBodySha256, staleDisplayCode, 1, issuedAt, expiresAt,
      ]);
      issueOperatorPresenceChallenge(database, {
        ...challenge,
        challengeId: staleChallengeId,
        challengeNonceBase64url: staleNonce,
        requestBodySha256: staleBodySha256,
        operatorDisplayCode: staleDisplayCode,
        challengeCommitment: staleCommitment,
      });
      const beforeStale = await readFile(join(root, "secrets", "action-approval-seal-keyring.v1.json"));
      await expect(applySealKeyAdministration({ ...options(root), database }, {
        version: "agent-mail-action-authority-admin-v1",
        requestBodyBase64url: staleBodyBytes.toString("base64url"),
        assertion: {
          version: "agent-mail-macos-operator-presence-v1",
          challengeId: staleChallengeId,
          credentialId,
          signatureBase64url: lowSSignature(operatorKeys.privateKey, staleCommitment),
        },
      })).rejects.toThrow(/stale/);
      expect(await readFile(join(root, "secrets", "action-approval-seal-keyring.v1.json"))).toEqual(beforeStale);
      expect(database.query("SELECT 1 FROM operator_presence_challenge_consumptions WHERE challenge_id = ?;").get(staleChallengeId)).toBeNull();
    } finally {
      database.close();
    }
  });
});
