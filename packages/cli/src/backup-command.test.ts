import { describe, expect, test } from "bun:test";
import { runBackupCommand } from "./backup-command";

const response = {
  backupId: "backup:api-created",
  manifest: { manifestId: "manifest:abc", digest: "a".repeat(64) },
  destination: "/private/agent-mail/backups/api-created",
  createdAt: "2026-08-18T00:00:00.000Z",
  bytes: 42,
};

const request = { destination: response.destination };

describe("P7-C04 backup CLI adapter", () => {
  test("uses the shared admin.backup operation and retains verified metadata", async () => {
    let call: unknown;
    const result = await runBackupCommand({
      argv: ["admin", "backup"],
      correlationId: "cli:backup",
      request,
      client: {
        request: async (value) => {
          call = value;
          return { kind: "success", operationKey: "admin.backup", status: 200, data: response };
        },
      },
    });
    expect(call).toMatchObject({
      operation: { key: "admin.backup" },
      input: request,
    });
    expect(result).toMatchObject({
      kind: "value",
      operationKey: "admin.backup",
      semanticKind: "success",
      data: response,
    });
  });

  test("does not claim success for malformed responses or invalid invocation", async () => {
    const malformed = await runBackupCommand({
      argv: ["admin", "backup"],
      correlationId: "cli:backup-malformed",
      request,
      client: {
        request: async () => ({
          kind: "success",
          operationKey: "admin.backup",
          status: 200,
          data: { ...response, manifest: { manifestId: "manifest:bad", digest: "not-a-digest" } },
        }),
      },
    });
    expect(malformed).toMatchObject({ kind: "failure", semanticKind: "protocol" });

    const usage = await runBackupCommand({
      argv: ["admin", "backup", "unexpected"],
      correlationId: "cli:backup-usage",
      request,
      client: { request: async () => { throw new Error("must not call"); } },
    });
    expect(usage).toMatchObject({ kind: "failure", semanticKind: "usage" });
  });

  test("rejects malformed request before transport", async () => {
    let calls = 0;
    const result = await runBackupCommand({
      argv: ["admin", "backup"],
      correlationId: "cli:backup-input",
      request: { destination: "relative/path" },
      client: { request: async () => { calls += 1; throw new Error("must not call"); } },
    });
    expect(result).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
    expect(calls).toBe(0);
  });
});
