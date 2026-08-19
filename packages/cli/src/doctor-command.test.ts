import { describe, expect, test } from "bun:test";
import { reportAdminDoctorResponseSchema } from "@agent-mail/contracts";
import { CliClientError, type CliResponse } from "./client";
import { runDoctorCommand } from "./doctor-command";

const response = reportAdminDoctorResponseSchema.parse({
  status: "unhealthy",
  checks: [
    { id: "foreign-keys", status: "fail", summary: "foreign-key violations" },
    { id: "blobs", status: "warn", summary: "blob evidence is incomplete" },
  ],
  issues: [
    { code: "doctor:foreign-keys:1", detail: '{"severity":"error","subject":"remote:1","evidence":{"reference":"private-root/archive.sqlite","detail":"missing parent"}}' },
    { code: "doctor:blobs:1", detail: '{"severity":"warning","subject":"message:a","evidence":{"reference":"private-root/blobs/body","detail":"missing"}}' },
  ],
});

function clientFor(data: unknown): Pick<Parameters<typeof runDoctorCommand>[0]["client"], "request"> {
  return {
    async request(): Promise<CliResponse> {
      return { kind: "success", operationKey: "admin.doctor", status: 200, data };
    },
  };
}

describe("P7-C02 doctor CLI adapter", () => {
  test("preserves contract-identical unhealthy findings and requests the empty body", async () => {
    let input: unknown;
    const result = await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor",
      request: {},
      client: {
        async request(options) {
          input = options.input;
          return { kind: "success", operationKey: "admin.doctor", status: 200, data: response };
        },
      },
    });
    expect(input).toEqual({});
    expect(result).toMatchObject({
      kind: "value",
      operationKey: "admin.doctor",
      semanticKind: "attention",
      data: response,
    });
    if (result.kind !== "value") throw new Error("doctor result was not a value");
    const text = result.humanLines.flat().map((segment) => segment.text).join("\n");
    expect(text).toContain("doctor:foreign-keys:1");
    expect(text).toContain("doctor:blobs:1");
  });

  test("rejects malformed input and response, and maps transport failures", async () => {
    let calls = 0;
    const invalid = await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-invalid",
      request: { unexpected: true },
      client: { request: async () => { calls += 1; throw new Error("must not call"); } },
    });
    expect(invalid).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
    expect(calls).toBe(0);

    const malformed = await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-malformed",
      request: {},
      client: clientFor({ status: "healthy", checks: [], issues: [{ code: "bad", detail: "bad" }] }),
    });
    expect(malformed).toMatchObject({ kind: "failure", semanticKind: "protocol" });

    const transport = await runDoctorCommand({
      argv: ["admin", "doctor"],
      correlationId: "cli:doctor-transport",
      request: {},
      client: {
        async request(): Promise<CliResponse> {
          throw new CliClientError("control_timeout", "admin.doctor", "deadline");
        },
      },
    });
    expect(transport).toMatchObject({ kind: "failure", semanticKind: "temporary" });
  });

  test("rejects argv drift without a request", async () => {
    let calls = 0;
    const result = await runDoctorCommand({
      argv: ["doctor"],
      correlationId: "cli:doctor-usage",
      request: {},
      client: { request: async () => { calls += 1; throw new Error("must not call"); } },
    });
    expect(result).toMatchObject({ kind: "failure", semanticKind: "usage" });
    expect(calls).toBe(0);
  });
});
