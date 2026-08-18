import { describe, expect, it } from "bun:test";
import { httpErrorRegistry } from "@agent-mail/contracts";

describe("CLI contracts boundary", () => {
  it("imports the complete public HTTP authority without daemon reachability", () => {
    expect(httpErrorRegistry.errors).toHaveLength(26);
    expect(httpErrorRegistry.get("request_too_large")?.status).toBe(413);
    expect(httpErrorRegistry.get("action.approval_cancelled")?.status).toBe(409);
  });

  it("rejects a private CLI status/detail map that diverges from contracts", () => {
    const privateMap = new Map(
      httpErrorRegistry.errors.map((error) => [error.code, { status: error.status, details: error.details }]),
    );
    privateMap.set("request_too_large", {
      status: 400,
      details: httpErrorRegistry.get("request_too_large")!.details,
    });
    expect(() => {
      const shared = httpErrorRegistry.get("request_too_large");
      const privateEntry = privateMap.get("request_too_large");
      if (
        shared === undefined ||
        privateEntry === undefined ||
        privateEntry.status !== shared.status ||
        privateEntry.details !== shared.details
      )
        throw new Error("CLI-private status/detail authority diverged");
    }).toThrow(/CLI-private/);
  });
});
