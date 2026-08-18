import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createOperationRegistry, defineOperation } from "../src/operation-registry";
import { assertOpenApi31, assertOpenApiCompleteness, generateOpenApiDocument, stableJson } from "../src/openapi";
import { publicOperationRegistry } from "../../daemon/src/http";
import { httpErrorRegistry } from "../src/index";

describe("OpenAPI registry projection", () => {
  it("is OpenAPI 3.1, complete, and byte deterministic", () => {
    const first = generateOpenApiDocument(publicOperationRegistry, httpErrorRegistry);
    const second = generateOpenApiDocument(publicOperationRegistry, httpErrorRegistry);
    assertOpenApi31(first);
    assertOpenApiCompleteness(publicOperationRegistry, first, httpErrorRegistry);
    expect(stableJson(first)).toBe(stableJson(second));
    expect(Object.keys(first.paths)).toHaveLength(publicOperationRegistry.operations.length);
    expect(JSON.stringify(first)).toContain("request_too_large");
    expect(JSON.stringify(first)).toContain("principal");
    for (const error of httpErrorRegistry.errors) expect(JSON.stringify(first)).toContain(error.code);
    expect(first.paths["/v1/messages/{messageId}"]?.get).toBeDefined();
    expect(first.paths["/v1/messages/{messageId}"]?.get).not.toHaveProperty("requestBody");
    expect(first.paths["/v1/messages/{messageId}/raw"]?.get).toHaveProperty("responses.200.content.*/*");
    expect(first.paths["/v1/exports"]?.post).toHaveProperty("responses.200.content.application/octet-stream");
  });

  it("fails when a synthetic registry operation has no generated path", () => {
    const operation = defineOperation({
      key: "synthetic.missing",
      route: "/v1/synthetic/missing",
      method: "POST",
      cliName: "synthetic-missing",
      scope: "synthetic:test",
      request: z.strictObject({ value: z.string() }),
      response: z.strictObject({ accepted: z.literal(true) }),
      streaming: "none",
      strictness: "strict",
    });
    const registry = createOperationRegistry([...publicOperationRegistry.operations, operation]);
    const document = generateOpenApiDocument(publicOperationRegistry, httpErrorRegistry);
    expect(() => assertOpenApiCompleteness(registry, document)).toThrow(/synthetic\/missing/);
  });

  it("rejects the adjacent hand-written executor path absent from the registry", () => {
    const document = generateOpenApiDocument(publicOperationRegistry, httpErrorRegistry);
    const registry = createOperationRegistry(publicOperationRegistry.operations);
    document.paths["/v1/internal/executor"] = { post: {} };
    expect(() => assertOpenApiCompleteness(registry, document)).toThrow(/unregistered route/);
  });

  it("rejects a rogue extra HTTP verb on a registered path", () => {
    const document = generateOpenApiDocument(publicOperationRegistry, httpErrorRegistry);
    const path = document.paths["/v1/messages/search"];
    if (path === undefined) throw new Error("search path fixture is missing");
    path.get = path.post;
    expect(() => assertOpenApiCompleteness(publicOperationRegistry, document, httpErrorRegistry)).toThrow(/extra HTTP operation/);
  });
});
