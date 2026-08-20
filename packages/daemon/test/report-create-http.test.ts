import { describe, expect, test } from "bun:test";
import { createHttpApp } from "../src/http";

describe("reports.create HTTP admission", () => {
  test("enforces the operation-specific 1 MiB cap before the handler", async () => {
    let calls = 0;
    const app = createHttpApp({
      authenticate: () => ({
        kind: "authenticated" as const,
        principal: { subject: "principal:http", scopes: ["reports:write"] },
      }),
      handlers: {
        "reports.create": () => {
          calls += 1;
          return {
            reportId: `report:${"a".repeat(64)}`,
            title: "unexpected",
            citations: [
              { id: `message:${"b".repeat(64)}`, label: "Source 1" },
            ],
            authorization: {
              principal: "principal:http",
              scope: "reports:write",
              method: "bearer" as const,
              requestId: `request:${"c".repeat(64)}`,
              authorizedAt: "2026-08-20T00:00:00.000Z",
            },
            createdAt: "2026-08-20T00:00:00.000Z",
          };
        },
      },
    });
    const body = JSON.stringify({
      title: "oversized",
      sourceMessageIds: [`message:${"b".repeat(64)}`],
      metadata: { payload: "x".repeat(1_048_500) },
    });
    const response = await app.request("http://localhost/v1/reports", {
      method: "POST",
      headers: { authorization: "Bearer report", "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      code: "request_too_large",
      message: "request body exceeds configured limit",
      details: {},
    });
    expect(calls).toBe(0);
  });
});
