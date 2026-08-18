import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createOperationRegistry,
  defineOperation,
  publicErrorEnvelopeSchema,
} from "@agent-mail/contracts";
import { createHttpApp, type HttpCredentialResolution } from "../src/http";

const operation = defineOperation({
  key: "synthetic.read",
  route: "/v1/synthetic/read",
  method: "GET",
  cliName: "synthetic-read",
  scope: "synthetic:read",
  request: z.strictObject({}),
  response: z.union([z.strictObject({ ok: z.literal(true) }), publicErrorEnvelopeSchema]),
  streaming: "none",
  strictness: "strict",
});
const registry = createOperationRegistry([operation]);

describe("P6-C09A exact HTTP method runtime parity", () => {
  it("rejects a wrong method before body reading or handler invocation", async () => {
    let readers = 0;
    let handlers = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"unexpected":true}'));
        controller.close();
      },
    });
    const originalGetReader = body.getReader.bind(body);
    body.getReader = () => {
      readers += 1;
      return originalGetReader();
    };
    const authenticate = (): HttpCredentialResolution => ({
      kind: "authenticated",
      principal: { subject: "operator", scopes: [operation.scope] },
    });
    const app = createHttpApp({
      registry,
      authenticate,
      handlers: {
        [operation.key]: () => {
          handlers += 1;
          return { ok: true };
        },
      },
    });

    const response = await app.request(
      new Request("http://localhost/v1/synthetic/read", {
        method: "POST",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(readers).toBe(0);
    expect(handlers).toBe(0);
  });

  it("redacts a schema-admitted feature error without operation status metadata", async () => {
    const app = createHttpApp({
      registry,
      authenticate: (): HttpCredentialResolution => ({
        kind: "authenticated",
        principal: { subject: "operator", scopes: [operation.scope] },
      }),
      handlers: {
        [operation.key]: () => ({
          code: "synthetic_error",
          message: "synthetic missing resource",
          correlationId: "private-correlation",
          details: { resource: "synthetic" },
        }),
      },
    });
    const response = await app.request(
      new Request("http://localhost/v1/synthetic/read", {
        method: "GET",
        headers: { authorization: "Bearer valid" },
      }),
    );
    const payload = await response.json();
    expect(response.status).toBe(500);
    expect(payload).toMatchObject({ code: "internal_error" });
  });
});
