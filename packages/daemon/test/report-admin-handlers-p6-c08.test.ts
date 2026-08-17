import { describe, expect, test } from "bun:test";
import { publicErrorEnvelopeSchema } from "@agent-mail/contracts";
import {
  createHttpApp,
  publicOperationRegistry,
  type HttpCredentialResolution,
  type OperationHandlerContext,
} from "../src/http";
import {
  createReportAdminHandlers,
  ReportAdminServiceOutcomeError,
  type ReportAdminServices,
} from "../src/report-admin-handlers";

const instant = "2026-08-18T00:00:00.000Z";
const laterInstant = "2026-08-18T00:00:01.000Z";
const digest = "a".repeat(64);
const manifest = { manifestId: "manifest:backup-1", digest };

const requests = {
  "reports.create": {
    title: "Daily report",
    sourceMessageIds: ["message:message-1"],
    metadata: { audience: "operator" },
  },
  "exports.selected": {
    selection: { kind: "identities" as const, messageIds: ["message:message-1"] },
  },
  "admin.backup": { destination: "/private/agent-mail/backups/backup-1" },
  "admin.restore": {
    target: "/private/agent-mail/restore-1",
    manifest,
    confirmationNonce: "restore-confirmation-2026-08-18",
    offline: true as const,
  },
  "admin.doctor": {},
  "admin.reindex": { scope: "messages" as const, operationIntent: "rebuild message index" },
} as const;

const successes = {
  "reports.create": {
    reportId: "report:report-1",
    title: "Daily report",
    citations: [{ id: "message:message-1", label: "source" }],
    authorization: {
      principal: "operator:local",
      scope: "reports:write",
      method: "local-cli" as const,
      requestId: "request:report-1",
      authorizedAt: instant,
    },
    createdAt: instant,
  },
  "exports.selected": {
    version: 1 as const,
    contentType: "application/octet-stream" as const,
    streamVersion: 1 as const,
  },
  "admin.backup": {
    backupId: "backup:backup-1",
    manifest,
    destination: "/private/agent-mail/backups/backup-1",
    createdAt: instant,
    bytes: 12,
  },
  "admin.restore": {
    restored: true as const,
    target: "/private/agent-mail/restore-1",
    manifest,
    completedAt: laterInstant,
  },
  "admin.doctor": {
    status: "healthy" as const,
    checks: [{ id: "sqlite", status: "pass" as const, summary: "SQLite is healthy" }],
    issues: [],
  },
  "admin.reindex": {
    accepted: true as const,
    scope: "messages" as const,
    startedAt: instant,
    indexed: 1,
    expected: 1,
  },
} as const;

type AdminOperationKey = keyof typeof requests;

function authenticated(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: { subject: "operator:local", scopes: ["reports:write", "mail:export.selected", "admin:backup", "admin:restore", "admin:doctor", "admin:reindex"] },
  };
}

function contextFor(key: AdminOperationKey): OperationHandlerContext {
  const operation = publicOperationRegistry.get(key);
  if (operation === undefined) throw new Error(`missing operation ${key}`);
  return {
    operation,
    correlationId: `request:${key}`,
    params: {},
    query: {},
    principal: { subject: "operator:local", scopes: [operation.scope] },
  };
}

function requestFor(key: AdminOperationKey): Request {
  const operation = publicOperationRegistry.get(key);
  if (operation === undefined) throw new Error(`missing operation ${key}`);
  return new Request(`http://localhost${operation.route}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-test" },
    body: JSON.stringify(requests[key]),
  });
}

function servicesFor(
  mode: "success" | "failure" | "blocked",
  calls: string[],
): ReportAdminServices {
  const run = (key: AdminOperationKey, value: unknown): unknown => {
    calls.push(key);
    if (mode === "success") return value;
    return {
      kind: mode,
      reason: `${key} was ${mode} by the injected service`,
      provenance: { service: `fake:${key}`, operation: key },
    };
  };
  return {
    createReport: (request, context) => {
      expect(request).toEqual(requests["reports.create"]);
      expect(context.scope).toBe("reports:write");
      return run("reports.create", successes["reports.create"]);
    },
    exportSelected: (request, context) => {
      expect(request).toEqual(requests["exports.selected"]);
      expect(context.scope).toBe("mail:export.selected");
      return run("exports.selected", successes["exports.selected"]);
    },
    backup: (request, context) => {
      expect(request).toEqual(requests["admin.backup"]);
      expect(context.scope).toBe("admin:backup");
      return run("admin.backup", successes["admin.backup"]);
    },
    restore: (request, context) => {
      expect(request).toEqual(requests["admin.restore"]);
      expect(context.scope).toBe("admin:restore");
      return run("admin.restore", successes["admin.restore"]);
    },
    doctor: (request, context) => {
      expect(request).toEqual(requests["admin.doctor"]);
      expect(context.scope).toBe("admin:doctor");
      return run("admin.doctor", successes["admin.doctor"]);
    },
    reindex: (request, context) => {
      expect(request).toEqual(requests["admin.reindex"]);
      expect(context.scope).toBe("admin:reindex");
      return run("admin.reindex", successes["admin.reindex"]);
    },
  };
}

describe("P6-C08 report/admin handler adapter", () => {
  test("runs every report/admin route through its injected service and shared response schema", async () => {
    const calls: string[] = [];
    const app = createHttpApp({
      authenticate: authenticated,
      handlers: createReportAdminHandlers(servicesFor("success", calls)),
    });

    for (const key of Object.keys(requests) as AdminOperationKey[]) {
      const response = await app.request(requestFor(key));
      const body: unknown = await response.json();
      const operation = publicOperationRegistry.get(key);
      if (operation === undefined) throw new Error(`missing operation ${key}`);
      expect(response.status).toBe(200);
      expect(operation.response.safeParse(body).success).toBe(true);
    }
    expect(calls).toEqual(Object.keys(requests));
  });

  for (const mode of ["failure", "blocked"] as const) {
    test(`preserves every injected ${mode} result without fabricating success`, async () => {
      const directCalls: string[] = [];
      const handlers = createReportAdminHandlers(servicesFor(mode, directCalls));

      for (const key of Object.keys(requests) as AdminOperationKey[]) {
        const handler = handlers[key];
        if (handler === undefined) throw new Error(`missing handler ${key}`);
        await expect(handler(requests[key], contextFor(key))).rejects.toMatchObject({
          name: "ReportAdminServiceOutcomeError",
          kind: mode,
          reason: `${key} was ${mode} by the injected service`,
          provenance: { service: `fake:${key}`, operation: key },
        });
      }
      expect(directCalls).toEqual(Object.keys(requests));

      const routeCalls: string[] = [];
      const app = createHttpApp({
        authenticate: authenticated,
        handlers: createReportAdminHandlers(servicesFor(mode, routeCalls)),
      });
      for (const key of Object.keys(requests) as AdminOperationKey[]) {
        const response = await app.request(requestFor(key));
        const body: unknown = await response.json();
        const operation = publicOperationRegistry.get(key);
        if (operation === undefined) throw new Error(`missing operation ${key}`);
        const error = publicErrorEnvelopeSchema.parse(body);
        expect(response.status).toBe(500);
        expect(error).toMatchObject({
          code: "internal_error",
          message: "internal server error",
          details: {},
        });
        expect(operation.response.safeParse(body).success).toBe(false);
        expect(JSON.stringify(body)).not.toContain(`${key} was ${mode}`);
        expect(JSON.stringify(body)).not.toContain(`fake:${key}`);
      }
      expect(routeCalls).toEqual(Object.keys(requests));
    });
  }

  test("rejects omitted and empty export selection before the service spy", async () => {
    let calls = 0;
    const services = servicesFor("success", []);
    const handlers = createReportAdminHandlers({
      ...services,
      exportSelected: () => {
        calls += 1;
        return successes["exports.selected"];
      },
    });
    const app = createHttpApp({ authenticate: authenticated, handlers });

    for (const body of [{}, { selection: { kind: "identities", messageIds: [] } }]) {
      const response = await app.request(
        new Request("http://localhost/v1/exports", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer admin-test" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("rejects restore without offline confirmation before the destructive service spy", async () => {
    let calls = 0;
    const services = servicesFor("success", []);
    const handlers = createReportAdminHandlers({
      ...services,
      restore: () => {
        calls += 1;
        return successes["admin.restore"];
      },
    });
    const app = createHttpApp({ authenticate: authenticated, handlers });
    const request = requests["admin.restore"];

    for (const body of [
      { ...request, confirmationNonce: undefined },
      { ...request, offline: false },
    ]) {
      const response = await app.request(
        new Request("http://localhost/v1/admin/restore", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer admin-test" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("does not turn a malformed service response into success", async () => {
    const handlers = createReportAdminHandlers({
      ...servicesFor("success", []),
      doctor: () => ({ status: "healthy", checks: [], issues: [{ code: "bad", detail: "bad" }] }),
    });
    const handler = handlers["admin.doctor"];
    if (handler === undefined) throw new Error("missing doctor handler");
    await expect(handler({}, contextFor("admin.doctor"))).rejects.toThrow();
    expect(ReportAdminServiceOutcomeError).toBeDefined();
  });
});
