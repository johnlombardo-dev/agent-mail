import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createOperationRegistry,
  defineOperation,
  publicErrorEnvelopeSchema,
} from "@agent-mail/contracts";
import {
  createHttpApp,
  createRegistryTransportAdapter,
  type HttpCredentialResolution,
  type PrivateHttpLogEntry,
} from "../src/http";

const requestSchema = z.strictObject({
  id: z.string().min(1),
  value: z.string().min(1),
});
const successSchema = z.strictObject({
  echoed: z.string(),
});
const responseSchema = z.union([successSchema, publicErrorEnvelopeSchema]);
const echoOperation = defineOperation({
  key: "synthetic.echo",
  route: "/v1/synthetic/{id}",
  method: "POST",
  cliName: "synthetic-echo",
  scope: "synthetic:echo",
  request: requestSchema,
  response: responseSchema,
  streaming: "none",
  strictness: "strict",
});
const registry = createOperationRegistry([echoOperation] as const);

function jsonRequest(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer synthetic-test",
      ...headers,
    },
    body,
  });
}

function authenticatedEcho(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: { subject: "test-operator", scopes: [echoOperation.scope] },
  };
}

describe("Hono shared contract boundary", () => {
  test("parses unknown path/body input before invoking a synthetic handler", async () => {
    let received: unknown;
    const app = createHttpApp({
      registry,
      authenticate: authenticatedEcho,
      handlers: {
        "synthetic.echo": (input) => {
          received = input;
          const parsed = requestSchema.parse(input);
          return { echoed: `${parsed.id}:${parsed.value}` };
        },
      },
    });

    const response = await app.request(jsonRequest("/v1/synthetic/path-id", JSON.stringify({ value: "ok" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echoed: "path-id:ok" });
    expect(received).toEqual({ id: "path-id", value: "ok" });
  });

  test("rejects wrong content types, malformed JSON, unknown fields, and schema failures", async () => {
    const app = createHttpApp({
      registry,
      authenticate: authenticatedEcho,
      handlers: { "synthetic.echo": () => ({ echoed: "unused" }) },
    });
    const cases: readonly [Request, number][] = [
      [
        new Request("http://localhost/v1/synthetic/id", {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            authorization: "Bearer synthetic-test",
          },
          body: JSON.stringify({ value: "ok" }),
        }),
        415,
      ],
      [jsonRequest("/v1/synthetic/id", "{bad"), 400],
      [jsonRequest("/v1/synthetic/id", JSON.stringify({ value: "ok", extra: true })), 400],
      [jsonRequest("/v1/synthetic/id", JSON.stringify({ value: 42 })), 400],
    ];

    for (const [request, expectedStatus] of cases) {
      const response = await app.request(request);
      expect(response.status).toBe(expectedStatus);
      const body: unknown = await response.json();
      expect(publicErrorEnvelopeSchema.safeParse(body).success).toBe(true);
    }
  });

  test("returns a stable redacted envelope for thrown causes and invalid handler output", async () => {
    const logs: PrivateHttpLogEntry[] = [];
    const app = createHttpApp({
      registry,
      authenticate: authenticatedEcho,
      logger: (entry) => logs.push(entry),
      handlers: {
        "synthetic.echo": (input) => {
          const parsed = requestSchema.parse(input);
          if (parsed.value === "throw") {
            throw new Error("private message", {
              cause: { token: "bearer secret-token", password: "private-password" },
            });
          }
          return { invalid: parsed.value };
        },
      },
    });

    const thrown = await app.request(
      jsonRequest("/v1/synthetic/id", JSON.stringify({ value: "throw" }), {
        "x-correlation-id": "corr-stable",
      }),
    );
    const invalidOutput = await app.request(
      jsonRequest("/v1/synthetic/id", JSON.stringify({ value: "invalid" }), {
        "x-correlation-id": "corr-stable",
      }),
    );
    const thrownBody: unknown = await thrown.json();
    const invalidOutputBody: unknown = await invalidOutput.json();

    expect(thrown.status).toBe(500);
    expect(invalidOutput.status).toBe(500);
    expect(thrownBody).toEqual({
      code: "internal_error",
      message: "internal server error",
      correlationId: "corr-stable",
      details: {},
    });
    expect(invalidOutputBody).toEqual(thrownBody);
    expect(JSON.stringify(thrownBody)).not.toContain("secret-token");
    expect(JSON.stringify(thrownBody)).not.toContain("private-password");
    expect(logs.map(({ kind }) => kind)).toEqual(["handler-error", "invalid-handler-output"]);
    expect(JSON.stringify(logs)).not.toContain("secret-token");
    expect(JSON.stringify(logs)).not.toContain("private-password");
  });

  test("returns the shared not-found envelope for an unknown route", async () => {
    const app = createHttpApp({ registry, handlers: {} });
    const response = await app.request("/v1/unknown-route");
    const body: unknown = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      code: "not_found",
      message: "route was not found",
      details: {},
      correlationId: expect.any(String),
    });
  });

  test("the registry adapter validates requests and handler responses without Hono", async () => {
    const adapter = createRegistryTransportAdapter({
      registry,
      authenticate: authenticatedEcho,
      handlers: { "synthetic.echo": (input) => ({ echoed: requestSchema.parse(input).value }) },
    });
    const context = {
      request: new Request("http://localhost/v1/synthetic/id", {
        headers: { authorization: "Bearer synthetic-test" },
      }),
      correlationId: "corr-adapter",
    };

    await expect(adapter.execute("synthetic.echo", { id: "id", value: "ok" }, context)).resolves.toEqual({
      status: 200,
      body: { echoed: "ok" },
    });
    await expect(adapter.execute("synthetic.echo", { id: "id", extra: true }, context)).resolves.toMatchObject({
      status: 400,
    });
  });
});
