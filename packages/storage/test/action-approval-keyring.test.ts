import { describe, expect, it } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  actionApprovalSealKeyringPath,
  loadApprovalSealKeyringFile,
  removeApprovalSealKeyringFile,
  rotateApprovalSealKeyringFile,
} from "../src/action-approval-keyring";
import { approvalKeyringBackupProjection } from "../src/action-approval-authority";

describe("file-backed action approval keyring", () => {
  it("creates owner-only state, rotates, reloads, and excludes key bytes from backup projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-keyring-"));
    await chmod(root, 0o700);
    const first = await loadApprovalSealKeyringFile({ privateRoot: root, databaseExists: false });
    const path = actionApprovalSealKeyringPath(root);
    expect((await lstat(join(root, "secrets"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const rotated = await rotateApprovalSealKeyringFile(root);
    expect(rotated.keyringRevision).toBe(first.file.keyringRevision + 1);
    const reloaded = await loadApprovalSealKeyringFile({ privateRoot: root, databaseExists: true });
    expect(reloaded.file.activeKeyId).toBe(rotated.activeKeyId);
    expect(JSON.stringify(approvalKeyringBackupProjection(reloaded.keyring))).not.toContain(
      reloaded.file.keys[0]?.keyBase64url ?? "",
    );
    const verifyOnly = reloaded.file.keys.find((key) => key.status === "verify-only");
    expect(verifyOnly).toBeDefined();
    const removed = await removeApprovalSealKeyringFile(root, verifyOnly!.keyId);
    expect(removed.keys.some((key) => key.keyId === verifyOnly!.keyId)).toBe(false);
  });

  it("fails closed for an existing database with a missing keyring and symlinked state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-keyring-invalid-"));
    await chmod(root, 0o700);
    await expect(
      loadApprovalSealKeyringFile({ privateRoot: root, databaseExists: true }),
    ).rejects.toThrow(/unavailable/);
    const target = await mkdtemp(join(tmpdir(), "agent-mail-keyring-target-"));
    await chmod(target, 0o700);
    await symlink(target, join(root, "secrets"));
    await expect(
      loadApprovalSealKeyringFile({ privateRoot: root, databaseExists: false }),
    ).rejects.toThrow(/unsafe|unavailable/);
  });

  it("does not accept malformed key material", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mail-keyring-malformed-"));
    await chmod(root, 0o700);
    const first = await loadApprovalSealKeyringFile({ privateRoot: root, databaseExists: false });
    const path = actionApprovalSealKeyringPath(root);
    const text = await readFile(path, "utf8");
    await Bun.write(path, text.replace(first.file.keys[0]!.keyBase64url, "not-base64"));
    await expect(
      loadApprovalSealKeyringFile({ privateRoot: root, databaseExists: true }),
    ).rejects.toThrow(/invalid/);
  });
});
