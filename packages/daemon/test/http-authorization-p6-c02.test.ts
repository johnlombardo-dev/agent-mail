import { describe, expect, test } from "bun:test";
import { operationCorpus } from "../../contracts/test/operation-corpus";
import {
  createHttpApp,
  publicOperationRegistry,
  type HttpCredentialResolution,
  type OperationHandler,
  type PrivateHttpLogEntry,
} from "../src/http";

type JsonRecord = Readonly<Record<string, unknown>>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestPath(operationKey: string): string {
  const operation = publicOperationRegistry.get(operationKey);
  if (operation === undefined) throw new Error(`missing operation ${operationKey}`);
  const fixture = operationCorpus[operationKey];
  if (fixture === undefined || !isJsonRecord(fixture.request))
    throw new Error(`missing object request fixture ${operationKey}`);
  return operation.route.replaceAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu, (_match, name: string) => {
    const value = fixture.request[name];
    return typeof value === "string" ? encodeURIComponent(value) : "fixture";
  });
}

function requestFor(operationKey: string, authorization?: string): Request {
  const fixture = operationCorpus[operationKey];
  if (fixture === undefined) throw new Error(`missing operation fixture ${operationKey}`);
  const operation = publicOperationRegistry.get(operationKey);
  if (operation === undefined) throw new Error(`missing registered operation ${operationKey}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  const query =
    operation.method === "GET" &&
    operationKey === "messages.search" &&
    typeof fixture.request === "object" &&
    fixture.request !== null &&
    "query" in fixture.request &&
    typeof fixture.request.query === "string"
      ? `?query=${encodeURIComponent(fixture.request.query)}`
      : "";
  return new Request(`http://localhost${requestPath(operationKey)}${query}`, {
    method: operation.method,
    headers,
    ...(operation.method === "GET" ? {} : { body: JSON.stringify(fixture.request) }),
  });
}

describe("HTTP operation authentication and exact-scope authorization", () => {
  test("covers every operation category and never invokes handlers for denied credentials", async () => {
    const invocations: string[] = [];
    const principals: string[] = [];
    const logs: PrivateHttpLogEntry[] = [];
    const credentialsSeen: string[] = [];
    const handlers: Record<string, OperationHandler> = {};
    for (const operation of publicOperationRegistry.operations) {
      handlers[operation.key] = (_input, context) => {
        const fixture = operationCorpus[operation.key];
        if (fixture === undefined) throw new Error(`missing fixture ${operation.key}`);
        invocations.push(operation.key);
        principals.push(context.principal.subject);
        expect(Object.isFrozen(context.principal)).toBe(true);
        expect(Object.isFrozen(context.principal.scopes)).toBe(true);
        expect(context.principal.scopes).toEqual(operation.scope === null ? [] : [operation.scope]);
        expect("credential" in context).toBe(false);
        return fixture.success;
      };
    }

    const authenticate = (credential: string): HttpCredentialResolution => {
      credentialsSeen.push(credential);
      if (credential === "invalid-token") return { kind: "invalid" };
      if (credential === "expired-token") return { kind: "expired" };
      const prefix = "sufficient:";
      if (credential.startsWith(prefix)) {
        const operationKey = credential.slice(prefix.length);
        const operation = publicOperationRegistry.get(operationKey);
        if (operation !== undefined) {
          return {
            kind: "authenticated",
            principal: { subject: "operator", scopes: operation.scope === null ? [] : [operation.scope] },
          };
        }
      }
      const insufficientPrefix = "insufficient:";
      if (credential.startsWith(insufficientPrefix)) {
        const operationKey = credential.slice(insufficientPrefix.length);
        const operation = publicOperationRegistry.get(operationKey);
        const otherOperation = publicOperationRegistry.operations.find(
          (candidate) => candidate.scope !== null && candidate.scope !== operation?.scope,
        );
        if (operation !== undefined && otherOperation !== undefined) {
          return {
            kind: "authenticated",
            principal: { subject: "insufficient", scopes: [otherOperation.scope] },
          };
        }
      }
      return { kind: "invalid" };
    };

    const app = createHttpApp({ handlers, logger: (entry) => logs.push(entry), authenticate });
    const responseBodies: unknown[] = [];
    const categoryPrefixes = new Set<string>();

    for (const operation of publicOperationRegistry.operations) {
      const prefix = operation.key.split(".")[0];
      if (prefix !== undefined) categoryPrefixes.add(prefix);
      const before = invocations.length;

      const sufficient = await app.request(
        requestFor(operation.key, `Bearer sufficient:${operation.key}`),
      );
      const sufficientBody: unknown = await sufficient.json();
      responseBodies.push(sufficientBody);
      expect(sufficient.status).toBe(200);
      expect(sufficientBody).toEqual(operationCorpus[operation.key]?.success);
      expect(invocations).toHaveLength(before + 1);

      const absent = await app.request(requestFor(operation.key));
      const absentBody: unknown = await absent.json();
      responseBodies.push(absentBody);
      expect(absent.status).toBe(401);
      expect(absentBody).toMatchObject({ code: "missing_credentials" });
      expect(invocations).toHaveLength(before + 1);

      const invalid = await app.request(requestFor(operation.key, "Basic invalid-token"));
      const invalidBody: unknown = await invalid.json();
      responseBodies.push(invalidBody);
      expect(invalid.status).toBe(401);
      expect(invalidBody).toMatchObject({ code: "invalid_credentials" });
      expect(invocations).toHaveLength(before + 1);

      const verifierInvalid = await app.request(
        requestFor(operation.key, "Bearer invalid-token"),
      );
      const verifierInvalidBody: unknown = await verifierInvalid.json();
      responseBodies.push(verifierInvalidBody);
      expect(verifierInvalid.status).toBe(401);
      expect(verifierInvalidBody).toMatchObject({ code: "invalid_credentials" });
      expect(invocations).toHaveLength(before + 1);

      const expired = await app.request(requestFor(operation.key, "Bearer expired-token"));
      const expiredBody: unknown = await expired.json();
      responseBodies.push(expiredBody);
      expect(expired.status).toBe(401);
      expect(expiredBody).toMatchObject({ code: "expired_credentials" });
      expect(invocations).toHaveLength(before + 1);

      const insufficient = await app.request(
        requestFor(operation.key, `Bearer insufficient:${operation.key}`),
      );
      const insufficientBody: unknown = await insufficient.json();
      responseBodies.push(insufficientBody);
      expect(insufficient.status).toBe(403);
      expect(insufficientBody).toMatchObject({ code: "insufficient_scope" });
      expect(invocations).toHaveLength(before + 1);
    }

    expect(publicOperationRegistry.operations).toHaveLength(25);
    expect([...categoryPrefixes].sort()).toEqual([
      "action-plans",
      "admin",
      "attachments",
      "exports",
      "messages",
      "operator-sessions",
      "reports",
      "routing",
      "sync",
      "threads",
    ]);
    expect(new Set(invocations).size).toBe(25);
    expect(principals).toHaveLength(25);
    expect(credentialsSeen).toHaveLength(25 * 4);
    expect(JSON.stringify({ responseBodies, logs })).not.toContain("invalid-token");
    expect(JSON.stringify({ responseBodies, logs })).not.toContain("expired-token");
    expect(JSON.stringify({ responseBodies, logs })).not.toContain("insufficient:");
    expect(JSON.stringify({ responseBodies, logs })).not.toContain("sufficient:");
  });

  test("rejects a read-only token before action-plan commit can claim or invoke its handler", async () => {
    let invocations = 0;
    const operation = publicOperationRegistry.get("action-plans.commit");
    if (operation === undefined) throw new Error("missing action-plans.commit operation");
    const fixture = operationCorpus[operation.key];
    if (fixture === undefined) throw new Error("missing action-plans.commit fixture");
    const app = createHttpApp({
      authenticate: (credential) =>
        credential === "read-only"
          ? { kind: "authenticated", principal: { subject: "reader", scopes: ["mail:read.search"] } }
          : { kind: "invalid" },
      handlers: {
        [operation.key]: () => {
          invocations += 1;
          return fixture.success;
        },
      },
    });

    const response = await app.request(requestFor(operation.key, "Bearer read-only"));
    const body: unknown = await response.json();
    expect(response.status).toBe(403);
    expect(body).toMatchObject({ code: "insufficient_scope" });
    expect(invocations).toBe(0);
  });

  test("fails closed for malformed authenticator principals and accepts case-insensitive Bearer", async () => {
    const operation = publicOperationRegistry.get("messages.search");
    if (operation === undefined) throw new Error("missing messages.search operation");
    const fixture = operationCorpus[operation.key];
    if (fixture === undefined) throw new Error("missing messages.search fixture");
    const malformedResolutions: readonly unknown[] = [
      {
        kind: "authenticated",
        principal: { subject: 7, scopes: [operation.scope] },
      },
      {
        kind: "authenticated",
        principal: { subject: "secret-subject", scopes: [operation.scope, {}] },
      },
      {
        kind: "authenticated",
        principal: { subject: "secret-subject", scopes: [operation.scope, operation.scope] },
      },
      {
        kind: "authenticated",
        principal: { subject: "s".repeat(257), scopes: [operation.scope] },
      },
      {
        kind: "authenticated",
        principal: { subject: "secret-subject", scopes: ["scope".repeat(257)] },
      },
      {
        kind: "authenticated",
        principal: {
          subject: "secret-subject",
          scopes: Array.from({ length: 65 }, (_entry, index) => `scope-${index}`),
        },
      },
      {
        kind: "authenticated",
        principal: Object.create({
          subject: "secret-subject",
          scopes: [operation.scope],
        }),
      },
      { kind: "authenticated", principal: { subject: "secret-subject" } },
      { kind: "authenticated", principal: { subject: "secret-subject", scopes: null } },
      { kind: "invalid", detail: "secret-resolution" },
      { kind: "unexpected" },
    ];

    for (const resolution of malformedResolutions) {
      let invocations = 0;
      const app = createHttpApp({
        authenticate: () => resolution,
        handlers: {
          [operation.key]: () => {
            invocations += 1;
            return fixture.success;
          },
        },
      });
      const response = await app.request(requestFor(operation.key, "Bearer malformed-token"));
      const body: unknown = await response.json();
      expect(response.status).toBe(401);
      expect(body).toMatchObject({ code: "invalid_credentials" });
      expect(invocations).toBe(0);
      expect(JSON.stringify(body)).not.toContain("secret-subject");
    }

    let invocations = 0;
    const app = createHttpApp({
      authenticate: () => ({
        kind: "authenticated",
        principal: { subject: "operator", scopes: [operation.scope] },
      }),
      handlers: {
        [operation.key]: () => {
          invocations += 1;
          return fixture.success;
        },
      },
    });
    const response = await app.request(requestFor(operation.key, "bearer lower-case-scheme"));
    expect(response.status).toBe(200);
    expect(invocations).toBe(1);
  });
});
