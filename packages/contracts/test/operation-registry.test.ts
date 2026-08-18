import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createOperationRegistry,
  defineOperation,
  type OperationDefinition,
} from "../src/operation-registry";

const requestSchema = z.strictObject({ query: z.string() });
const responseSchema = z.strictObject({ count: z.number() });

function operation(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return defineOperation({
    key: "messages.search",
    route: "/v1/messages/search",
    method: "GET",
    cliName: "messages-search",
    scope: "mail:read",
    request: requestSchema,
    response: responseSchema,
    streaming: "none",
    strictness: "strict",
    ...overrides,
  });
}

describe("operation registry", () => {
  it("supports an empty initial registry for later operation additions", () => {
    const registry = createOperationRegistry([] as const);
    expect(registry.operations).toEqual([]);
    expect(registry.metadata).toEqual([]);
    expect(registry.get("future.operation")).toBeUndefined();
  });

  it("shares typed schemas and emits stable metadata", () => {
    const registry = createOperationRegistry([
      operation(),
      operation({
        key: "messages.export",
        route: "/v1/messages/export/{id}",
        cliName: "messages-export",
        scope: "mail:export",
        streaming: "bytes",
      }),
    ] as const);

    expect(registry.metadata).toEqual([
      {
        key: "messages.search",
        route: "/v1/messages/search",
        method: "GET",
        cliName: "messages-search",
        scope: "mail:read",
        errors: [],
        streaming: "none",
        strictness: "strict",
      },
      {
        key: "messages.export",
        route: "/v1/messages/export/{id}",
        method: "GET",
        cliName: "messages-export",
        scope: "mail:export",
        errors: [],
        streaming: "bytes",
        strictness: "strict",
      },
    ]);
    expect(registry.parseRequest("messages.search", { query: "invoice" })).toEqual({
      query: "invoice",
    });
    expect(registry.parseResponse("messages.search", { count: 2 })).toEqual({ count: 2 });
    expect(() =>
      registry.parseRequest("messages.search", { query: "invoice", extra: true }),
    ).toThrow();
    expect(() =>
      registry.parseResponse("messages.search", { count: 2, stack: "secret" }),
    ).toThrow();
  });

  it("rejects every duplicate public identity, including CLI names across scopes", () => {
    const duplicate = (field: keyof OperationDefinition): void => {
      const first = operation();
      const second = operation({
        key: "messages.other",
        route: "/v1/messages/other",
        cliName: "messages-other",
        scope: "mail:other",
        [field]: first[field],
      });
      expect(() => createOperationRegistry([first, second])).toThrow(/duplicate operation/);
    };

    duplicate("key");
    duplicate("route");
    duplicate("cliName");
    duplicate("scope");

    expect(() =>
      createOperationRegistry([
        operation({ cliName: "same", scope: "mail:read" }),
        operation({
          key: "messages.other",
          route: "/v1/messages/other",
          cliName: "same",
          scope: "mail:write",
        }),
      ]),
    ).toThrow(/CLI name/);
  });

  it("requires an explicit strictness policy", () => {
    const registry = createOperationRegistry([
      operation({ request: z.object({ query: z.string() }) }),
      operation({
        key: "messages.response",
        route: "/v1/messages/response",
        cliName: "messages-response",
        scope: "mail:response",
        response: z.object({ count: z.number() }),
      }),
    ]);
    expect(() =>
      registry.parseRequest("messages.search", { query: "invoice", extra: true }),
    ).toThrow();
    expect(() => registry.parseResponse("messages.response", { count: 2, extra: true })).toThrow();
    expect(() => operation({ route: "/v1/messages bad" })).toThrow();
    expect(() => operation({ route: "/v1/messages?query=bad" })).toThrow();
  });

  it("snapshots and freezes definitions and generated metadata", () => {
    const mutableError = {
      code: "nested_mutation",
      status: 400 as const,
      details: z.strictObject({ resource: z.literal("nested") }),
    };
    const definitions = [operation({ errors: [mutableError] })];
    const registry = createOperationRegistry(definitions);
    expect(registry.operations).not.toBe(definitions);
    expect(Object.isFrozen(registry.operations)).toBe(true);
    expect(Object.isFrozen(registry.operations[0])).toBe(true);
    expect(Object.isFrozen(registry.operations[0]?.errors)).toBe(true);
    expect(Object.isFrozen(registry.operations[0]?.errors[0])).toBe(true);
    expect(Reflect.set(registry.operations[0]?.errors[0] ?? {}, "status", 409)).toBe(false);
    expect(registry.operations[0]?.errors[0]?.status).toBe(400);
    expect(Object.isFrozen(registry.metadata)).toBe(true);
    definitions.push(
      operation({
        key: "messages.mutated",
        route: "/v1/messages/mutated",
        cliName: "messages-mutated",
        scope: "mail:mutated",
      }),
    );
    expect(registry.get("messages.mutated")).toBeUndefined();
  });
});
