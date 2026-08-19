import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unlink } from "node:fs/promises";
import {
  publicErrorEnvelopeSchema,
  routingCommitResponseSchema,
} from "@agent-mail/contracts";
import {
  createRouteDecision,
  parseRoutingDecision,
} from "@agent-mail/core";
import {
  createHttpApp,
  publicOperationRegistry,
  type HttpCredentialResolution,
  type OperationHandlerContext,
} from "../src/http";
import {
  createRoutingHandlers,
  type RoutingServices,
} from "../src/routing-handlers";
import { localLabelMigration } from "../../storage/src/local-label-migration";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
import { runMigrations, type Migration } from "../../storage/src/migration-runner";
import { assignLocalLabel } from "../../storage/src/local-label-assignment";
import {
  consumeRoutingPreview,
  RoutingPreviewConsumptionError,
  type RoutingPreviewConsumptionResult,
} from "../../storage/src/routing-preview-consumption";
import { routingPreviewConsumptionMigration } from "../../storage/src/routing-preview-consumption-migration";
import {
  createRoutingPreview,
  type RoutingPreview,
  type RoutingPreviewCreationDependencies,
} from "../../storage/src/routing-preview-creation";
import { routingDecisionMigration } from "../../storage/src/routing-decision-migration";
import { routingPreviewMigration } from "../../storage/src/routing-preview-migration";
import { canonicalRoutingDecisionId } from "../../storage/src/routing-decision-identity";

const createdAt = "2026-08-18T00:00:00.000Z";
const committedAt = "2026-08-18T00:01:00.000Z";
const previewDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const rule = {
  version: 1 as const,
  ruleId: "rule:finance",
  ruleVersion: 3,
  predicate: { kind: "exactSender" as const, sender: "billing@example.com" },
};
const provenance = { source: "local-rule-engine", evaluationId: "eval:123" };
const preview = {
  authority: "server" as const,
  previewId: "preview:one",
  rule,
  candidateTargets: [
    { kind: "local-label" as const, messageId: "message:one", label: "label:finance" },
  ],
  createdAt,
  expiresAt: "2026-08-18T00:30:00.000Z",
  nonce: "nonce:one-time",
  digest: previewDigest,
  provenance,
};
const committed = {
  authority: "server" as const,
  decisionId: "decision:one",
  committed: true as const,
  dryRun: false as const,
  previewId: preview.previewId,
  previewDigest,
  decision: {
    kind: "route" as const,
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    matchedFacts: [{ field: "sender-addr-spec", value: "billing@example.com" }],
    decidedAt: committedAt,
    provenance,
    label: "label:finance",
  },
  committedAt,
  provenance,
};
const dryRun = {
  authority: "server" as const,
  committed: false as const,
  dryRun: true as const,
  decisionId: null,
  previewId: preview.previewId,
  previewDigest,
  decision: null,
};
const labelAssignment = {
  authority: "server" as const,
  messageId: "message:one",
  label: "label:finance",
  decisionId: "decision:one",
  committed: true as const,
  dryRun: false as const,
  assignedAt: committedAt,
  provenance,
};

const sqliteDigestKey = Buffer.alloc(32, 0x5a);
const sqliteMessageId = `message:${"a".repeat(64)}`;
const sqliteMigrations = [
  { ...messageCatalogMigration, version: 1 },
  { ...localLabelMigration, version: 2 },
  { ...routingDecisionMigration, version: 3 },
  { ...routingPreviewMigration, version: 4 },
  { ...routingPreviewConsumptionMigration, version: 5 },
] satisfies readonly Migration[];
const sqlitePreviewDependencies: RoutingPreviewCreationDependencies = {
  clock: () => createdAt,
  nonce: () => "nonce:http-authority",
  digestKey: sqliteDigestKey,
};
const sqliteDatabases: Database[] = [];

function openRoutingSqlite(path = ":memory:", seedMessage = true): Database {
  const database = new Database(path, { strict: true });
  runMigrations(database, sqliteMigrations);
  database.exec("PRAGMA foreign_keys = ON;");
  if (seedMessage) database.query("INSERT INTO messages (message_id) VALUES (?);").run(sqliteMessageId);
  sqliteDatabases.push(database);
  return database;
}

function sqlitePreviewInput(previewId: string) {
  return {
    previewId,
    scope: "mail:routing:read",
    rule,
    facts: { senderAddrSpec: "billing@example.com", listId: null },
    provenance,
    candidateTargets: [
      { kind: "local-label", messageId: sqliteMessageId, label: "label:finance" },
    ],
    ttlMs: 15 * 60 * 1000,
  };
}

function sqliteRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a record`);
  }
  return value;
}

function sqliteCounts(database: Database) {
  const count = (table: string): number => {
    const row: unknown = database.query(`SELECT COUNT(*) AS count FROM ${table};`).get();
    const value = sqliteRecord(row, `count row for ${table}`).count;
    if (typeof value !== "number") throw new Error(`invalid count value for ${table}`);
    return value;
  };
  return {
    previews: count("routing_previews"),
    decisions: count("routing_decisions"),
    assignments: count("local_label_assignments"),
    labels: count("local_labels"),
  };
}

function sqliteCommittedResponse(
  database: Database,
  preview: RoutingPreview,
  consumed: Extract<RoutingPreviewConsumptionResult, { readonly kind: "consumed" }>,
) {
  const row: unknown = database
    .query("SELECT decision_id, decision_json FROM routing_decisions WHERE message_id = ?;")
    .get(sqliteMessageId);
  const durableRow = sqliteRecord(row, "durable routing decision row");
  const decisionId = durableRow.decision_id;
  const decisionJson = durableRow.decision_json;
  if (typeof decisionId !== "string" || typeof decisionJson !== "string") {
    throw new Error("durable routing decision row is malformed");
  }
  const decision = parseRoutingDecision(decisionJson);
  return {
    authority: "server" as const,
    decisionId,
    committed: true as const,
    dryRun: false as const,
    previewId: preview.previewId,
    previewDigest: preview.digest,
    decision,
    committedAt: consumed.consumedAt,
    provenance: preview.provenance,
  };
}

function sqlitePublicPreview(preview: RoutingPreview) {
  const { facts: _facts, scope: _scope, ...authority } = preview;
  return { ...authority, authority: "server" as const };
}

function sqliteUncommittedResponse(preview: RoutingPreview) {
  return {
    authority: "server" as const,
    committed: false as const,
    dryRun: true as const,
    decisionId: null,
    previewId: preview.previewId,
    previewDigest: preview.digest,
    decision: null,
  };
}

function sqliteRoutingServices(
  database: Database,
  previews: Map<string, RoutingPreview>,
  nowFor: (preview: RoutingPreview) => string = () => committedAt,
): RoutingServices {
  return {
    createPreview: (request) => {
      const created = createRoutingPreview(
        database,
        sqlitePreviewInput("preview:http"),
        sqlitePreviewDependencies,
      );
      // The HTTP request is the only caller-controlled rule. The storage
      // service owns facts, targets, nonce, expiry, and the digest key.
      if (JSON.stringify(created.rule) !== JSON.stringify(request.rule)) {
        throw new Error("stored preview rule does not match the request");
      }
      previews.set(created.previewId, created);
      return sqlitePublicPreview(created);
    },
    commitPreview: (request, context) => {
      const preview = previews.get(request.previewId);
      if (preview === undefined)
        return { kind: "routing-commit-terminal", disposition: "not-found" };
      if (request.dryRun) return sqliteUncommittedResponse(preview);
      try {
        const result = consumeRoutingPreview(
          database,
          {
            previewId: request.previewId,
            scope: preview.scope,
            nonce: preview.nonce,
            digest: request.digest,
            ruleVersion: preview.rule.ruleVersion,
            consumerId: `consumer:${context.principal.subject}`,
            now: nowFor(preview),
          },
          { digestKey: sqliteDigestKey },
        );
        if (result.kind === "consumed") return sqliteCommittedResponse(database, preview, result);
        return {
          kind: "routing-commit-terminal",
          disposition: result.kind,
          previewId: result.previewId,
        };
      } catch (error: unknown) {
        if (error instanceof RoutingPreviewConsumptionError) {
          if (error.reason === "tampered")
            return {
              kind: "routing-commit-terminal",
              disposition: "tampered",
              previewId: preview.previewId,
            };
          if (error.reason === "not-found" || error.reason === "target")
            return { kind: "routing-commit-terminal", disposition: "not-found" };
        }
        throw error;
      }
    },
    assignLabel: (request) => {
      if (request.dryRun) {
        return {
          authority: "server" as const,
          messageId: request.messageId,
          label: request.label,
          decisionId: null,
          committed: false as const,
          dryRun: true as const,
          assignedAt: null,
          provenance: request.provenance,
        };
      }
      const decision = createRouteDecision({
        kind: "route",
        label: request.label,
        ruleId: "rule:manual-label",
        ruleVersion: 1,
        matchedFacts: [{ field: "manual-label", value: request.label }],
        decidedAt: committedAt,
        provenance: request.provenance,
      });
      const assigned = assignLocalLabel(database, {
        messageId: request.messageId,
        label: decision.label,
        ruleId: decision.ruleId,
        ruleVersion: decision.ruleVersion,
        matchedFacts: decision.matchedFacts,
        decidedAt: decision.decidedAt,
        provenance: decision.provenance,
      });
      return {
        authority: "server" as const,
        messageId: assigned.assignment.messageId,
        label: assigned.assignment.label,
        decisionId: canonicalRoutingDecisionId(assigned.assignment.messageId, decision),
        committed: true as const,
        dryRun: false as const,
        assignedAt: assigned.assignment.decidedAt,
        provenance: {
          source: assigned.assignment.provenanceSource,
          evaluationId: assigned.assignment.provenanceEvaluationId,
        },
      };
    },
  };
}

afterEach(() => {
  for (const database of sqliteDatabases.splice(0)) database.close();
});

function authenticated(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: {
      subject: "operator:local",
      scopes: ["mail:routing:read", "mail:routing:write", "mail:label:write"],
    },
  };
}

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer routing-test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function contextFor(key: "routing.preview" | "routing.commit" | "messages.label"):
  OperationHandlerContext {
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

describe("P6-C06 routing and label HTTP handlers", () => {
  test("preview then commit preserves stored authority identities and truthful flags", async () => {
    const calls: Array<{ key: string; input: unknown }> = [];
    const consumptionInputs: unknown[] = [];
    let consumed = false;
    const services: RoutingServices = {
      createPreview: (input, context) => {
        calls.push({ key: `${context.operationKey}:service`, input });
        return preview;
      },
      commitPreview: async (input, context) => {
        calls.push({ key: `${context.operationKey}:service`, input });
        if (input.dryRun) return dryRun;
        // The service owns the stored nonce/rule version and forwards them
        // unchanged with the client-supplied preview identity and digest.
        consumptionInputs.push({
          previewId: input.previewId,
          scope: "mail:routing:read",
          nonce: preview.nonce,
          digest: input.digest,
          ruleVersion: preview.rule.ruleVersion,
        });
        await Promise.resolve();
        if (consumed)
          return {
            kind: "routing-commit-terminal",
            disposition: "replayed",
            previewId: preview.previewId,
          };
        consumed = true;
        return committed;
      },
      assignLabel: () => labelAssignment,
    };
    const handlers = createRoutingHandlers(services);

    const previewHandler = handlers["routing.preview"];
    const commitHandler = handlers["routing.commit"];
    if (previewHandler === undefined || commitHandler === undefined) {
      throw new Error("routing handlers are incomplete");
    }

    const directPreview = await previewHandler(
      { rule },
      contextFor("routing.preview"),
    );
    expect(directPreview).toEqual(preview);
    expect(directPreview).not.toHaveProperty("committed");

    const directDryRun = await commitHandler(
      { previewId: preview.previewId, digest: preview.digest, dryRun: true },
      contextFor("routing.commit"),
    );
    expect(directDryRun).toEqual(dryRun);
    expect(consumptionInputs).toHaveLength(0);

    const commitRequest = { previewId: preview.previewId, digest: preview.digest, dryRun: false };
    const directCommit = await commitHandler(commitRequest, contextFor("routing.commit"));
    expect(directCommit).toEqual(committed);
    expect(calls[2]?.input).toEqual(commitRequest);
    expect(consumptionInputs[0]).toEqual({
      previewId: preview.previewId,
      scope: "mail:routing:read",
      nonce: preview.nonce,
      digest: preview.digest,
      ruleVersion: preview.rule.ruleVersion,
    });
    const parsedCommit = routingCommitResponseSchema.parse(directCommit);
    expect(parsedCommit.committed).toBe(true);
    expect(parsedCommit.previewId).toBe(preview.previewId);
    expect(parsedCommit.previewDigest).toBe(preview.digest);

    await expect(commitHandler(commitRequest, contextFor("routing.commit"))).rejects.toMatchObject({
      featureError: {
        code: "routing.preview_replayed",
        message: "routing preview was already consumed",
        details: { previewId: preview.previewId },
      },
    });
  });

  test("routes each operation through Hono after the shared exact-scope boundary", async () => {
    const calls: string[] = [];
    const app = createHttpApp({
      authenticate: authenticated,
      handlers: createRoutingHandlers({
        createPreview: (_request, context) => {
          calls.push(context.operationKey);
          return preview;
        },
        commitPreview: (_request, context) => {
          calls.push(context.operationKey);
          return committed;
        },
        assignLabel: (_request, context) => {
          calls.push(context.operationKey);
          return labelAssignment;
        },
      }),
    });

    const previewResponse = await app.request(
      request("/v1/routing/preview", { rule }),
    );
    const commitResponse = await app.request(
      request("/v1/routing/commit", {
        previewId: preview.previewId,
        digest: preview.digest,
        dryRun: false,
      }),
    );
    const labelResponse = await app.request(
      request("/v1/messages/message:one/label", {
        messageId: "message:one",
        label: "label:finance",
        provenance,
        dryRun: false,
      }),
    );

    expect(previewResponse.status).toBe(200);
    expect(commitResponse.status).toBe(200);
    expect(labelResponse.status).toBe(200);
    expect(await previewResponse.json()).toEqual(preview);
    expect(await commitResponse.json()).toEqual(committed);
    expect(await labelResponse.json()).toEqual(labelAssignment);
    expect(calls).toEqual(["routing.preview", "routing.commit", "messages.label"]);
  });

  test("tamper, expiry, replay, and storage failure never fabricate committed=true or labels", async () => {
    const calls: string[] = [];
    const failure = (reason: string) => ({ kind: "failure" as const, reason });
    const app = createHttpApp({
      authenticate: authenticated,
      handlers: createRoutingHandlers({
        createPreview: () => preview,
        commitPreview: async (input) => {
          await Promise.resolve();
          if (input.previewId === "preview:tampered")
            return {
              kind: "routing-commit-terminal",
              disposition: "tampered",
              previewId: input.previewId,
            };
          if (input.previewId === "preview:expired")
            return {
              kind: "routing-commit-terminal",
              disposition: "expired",
              previewId: input.previewId,
            };
          if (input.previewId === "preview:replayed")
            return {
              kind: "routing-commit-terminal",
              disposition: "replayed",
              previewId: input.previewId,
            };
          return failure("durable transaction failed");
        },
        assignLabel: () => {
          calls.push("label");
          return labelAssignment;
        },
      }),
    });

    for (const candidate of [
      { previewId: "preview:tampered", code: "routing.preview_tampered", status: 409 },
      { previewId: "preview:expired", code: "routing.preview_expired", status: 409 },
      { previewId: "preview:storage-failure", code: "internal_error", status: 500 },
    ] as const) {
      const response = await app.request(
        request("/v1/routing/commit", {
          previewId: candidate.previewId,
          digest: preview.digest,
          dryRun: false,
        }),
      );
      const body: unknown = await response.json();
      expect(response.status).toBe(candidate.status);
      expect(publicErrorEnvelopeSchema.parse(body)).toMatchObject({
        code: candidate.code,
        details:
          candidate.status === 500 ? {} : { previewId: candidate.previewId },
      });
      expect(body).not.toHaveProperty("committed");
    }

    const replayResponse = await app.request(
      request("/v1/routing/commit", {
        previewId: "preview:replayed",
        digest: preview.digest,
        dryRun: false,
      }),
    );
    const replayBody: unknown = await replayResponse.json();
    expect(replayResponse.status).toBe(409);
    expect(publicErrorEnvelopeSchema.parse(replayBody)).toMatchObject({
      code: "routing.preview_replayed",
      details: { previewId: "preview:replayed" },
    });
    expect(calls).toEqual([]);
  });

  test("awaits a durable label decision and rejects malformed success", async () => {
    let settled = false;
    const handlers = createRoutingHandlers({
      createPreview: () => preview,
      commitPreview: () => committed,
      assignLabel: async (input, context) => {
        expect(input.messageId).toBe("message:one");
        expect(context.scope).toBe("mail:label:write");
        await Promise.resolve();
        settled = true;
        return labelAssignment;
      },
    });
    const labelHandler = handlers["messages.label"];
    if (labelHandler === undefined) throw new Error("missing label handler");
    await expect(labelHandler({
      messageId: "message:one",
      label: "label:finance",
      provenance,
      dryRun: false,
    }, contextFor("messages.label"))).resolves.toEqual(labelAssignment);
    expect(settled).toBe(true);

    const malformed = createRoutingHandlers({
      createPreview: () => preview,
      commitPreview: () => committed,
      assignLabel: () => ({ ...labelAssignment, committed: true, assignedAt: null }),
    })["messages.label"];
    if (malformed === undefined) throw new Error("missing malformed label handler");
    await expect(malformed({
      messageId: "message:one",
      label: "label:finance",
      provenance,
      dryRun: false,
    }, contextFor("messages.label"))).rejects.toThrow();
  });
});

describe("P6-C06 composed Hono and SQLite acceptance", () => {
  test("preview, commit, and replay use one durable preview authority and preserve rows", async () => {
    const database = openRoutingSqlite();
    const previews = new Map<string, RoutingPreview>();
    const app = createHttpApp({
      authenticate: authenticated,
      handlers: createRoutingHandlers(sqliteRoutingServices(database, previews)),
    });

    const previewResponse = await app.request(
      request("/v1/routing/preview", { rule }),
    );
    const previewBody: unknown = await previewResponse.json();
    expect(previewResponse.status).toBe(200);
    const storedPreview = previews.get("preview:http");
    if (storedPreview === undefined) throw new Error("preview service did not persist authority");
    expect(previewBody).toEqual(sqlitePublicPreview(storedPreview));
    expect(sqliteCounts(database)).toEqual({
      previews: 1,
      decisions: 0,
      assignments: 0,
      labels: 0,
    });

    const commitRequest = {
      previewId: storedPreview.previewId,
      digest: storedPreview.digest,
      dryRun: false,
    };
    const commitResponse = await app.request(request("/v1/routing/commit", commitRequest));
    const commitBody: unknown = await commitResponse.json();
    expect(commitResponse.status).toBe(200);
    const committedBody = routingCommitResponseSchema.parse(commitBody);
    expect(committedBody.committed).toBe(true);
    expect(committedBody.previewId).toBe(storedPreview.previewId);
    expect(committedBody.previewDigest).toBe(storedPreview.digest);
    expect(sqliteCounts(database)).toEqual({
      previews: 1,
      decisions: 1,
      assignments: 1,
      labels: 1,
    });
    expect(database.query("SELECT consumed_at, consumed_by FROM routing_previews;").get()).toEqual({
      consumed_at: committedAt,
      consumed_by: "consumer:operator:local",
    });

    const replayResponse = await app.request(request("/v1/routing/commit", commitRequest));
    const replayBody: unknown = await replayResponse.json();
    expect(replayResponse.status).toBe(409);
    expect(publicErrorEnvelopeSchema.parse(replayBody)).toMatchObject({
      code: "routing.preview_replayed",
      details: { previewId: storedPreview.previewId },
    });
    expect(sqliteCounts(database)).toEqual({
      previews: 1,
      decisions: 1,
      assignments: 1,
      labels: 1,
    });
  });

  test("routing dry-run is inert and coarse not-found terminals disclose no target", async () => {
    const database = openRoutingSqlite();
    const previews = new Map<string, RoutingPreview>();
    const app = createHttpApp({
      authenticate: authenticated,
      handlers: createRoutingHandlers(sqliteRoutingServices(database, previews, () => "2026-08-18T00:30:00.000Z")),
    });
    const preview = createRoutingPreview(
      database,
      sqlitePreviewInput("preview:dry-run"),
      sqlitePreviewDependencies,
    );
    previews.set(preview.previewId, preview);
    const before = sqliteCounts(database);
    const dryRunResponse = await app.request(
      request("/v1/routing/commit", {
        previewId: preview.previewId,
        digest: preview.digest,
        dryRun: true,
      }),
    );
    expect(dryRunResponse.status).toBe(200);
    expect(await dryRunResponse.json()).toEqual(sqliteUncommittedResponse(preview));
    expect(sqliteCounts(database)).toEqual(before);

    const expiryResponse = await app.request(
      request("/v1/routing/commit", {
        previewId: preview.previewId,
        digest: preview.digest,
        dryRun: false,
      }),
    );
    expect(expiryResponse.status).toBe(409);
    expect(await expiryResponse.json()).toMatchObject({
      code: "routing.preview_expired",
      details: { previewId: preview.previewId },
    });
    expect(sqliteCounts(database)).toEqual(before);

    const missingResponse = await app.request(
      request("/v1/routing/commit", {
        previewId: "preview:missing-authority",
        digest: preview.digest,
        dryRun: false,
      }),
    );
    const missingBody: unknown = await missingResponse.json();
    expect(missingResponse.status).toBe(404);
    expect(missingBody).toEqual(expect.objectContaining({ code: "not_found", details: {} }));
    expect(missingBody).not.toHaveProperty("previewId");
    expect(sqliteCounts(database)).toEqual(before);

    const targetDatabase = openRoutingSqlite();
    const targetPreviews = new Map<string, RoutingPreview>();
    const targetPreview = createRoutingPreview(
      targetDatabase,
      sqlitePreviewInput("preview:missing-target"),
      sqlitePreviewDependencies,
    );
    targetPreviews.set(targetPreview.previewId, targetPreview);
    targetDatabase.query("DELETE FROM messages WHERE message_id = ?;").run(sqliteMessageId);
    const targetApp = createHttpApp({
      authenticate: authenticated,
      handlers: createRoutingHandlers(sqliteRoutingServices(targetDatabase, targetPreviews)),
    });
    const targetResponse = await targetApp.request(
      request("/v1/routing/commit", {
        previewId: targetPreview.previewId,
        digest: targetPreview.digest,
        dryRun: false,
      }),
    );
    expect(targetResponse.status).toBe(404);
    expect(await targetResponse.json()).toEqual(
      expect.objectContaining({ code: "not_found", details: {} }),
    );
    expect(sqliteCounts(targetDatabase)).toEqual({
      previews: 1,
      decisions: 0,
      assignments: 0,
      labels: 0,
    });
  });

  test("reopen preserves the one-way receipt and projects replay", async () => {
    const path = `/tmp/agent-mail-routing-reopen-${crypto.randomUUID()}.sqlite`;
    let database = openRoutingSqlite(path);
    const previews = new Map<string, RoutingPreview>();
    const preview = createRoutingPreview(
      database,
      sqlitePreviewInput("preview:reopen"),
      sqlitePreviewDependencies,
    );
    previews.set(preview.previewId, preview);
    const firstApp = createHttpApp({
      authenticate: authenticated,
      handlers: createRoutingHandlers(sqliteRoutingServices(database, previews)),
    });
    const requestBody = {
      previewId: preview.previewId,
      digest: preview.digest,
      dryRun: false,
    };
    const first = await firstApp.request(request("/v1/routing/commit", requestBody));
    expect(first.status).toBe(200);
    const receipt = database.query("SELECT consumed_at, consumed_by FROM routing_previews;").get();
    database.close();
    database = openRoutingSqlite(path, false);
    const replayApp = createHttpApp({
      authenticate: authenticated,
      handlers: createRoutingHandlers(sqliteRoutingServices(database, previews)),
    });
    const replay = await replayApp.request(request("/v1/routing/commit", requestBody));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: "routing.preview_replayed",
      details: { previewId: preview.previewId },
    });
    expect(database.query("SELECT consumed_at, consumed_by FROM routing_previews;").get()).toEqual(receipt);
    expect(sqliteCounts(database)).toEqual({
      previews: 1,
      decisions: 1,
      assignments: 1,
      labels: 1,
    });
    database.close();
    await unlink(path);
  });

  test("independent stored authority-field tamper maps to previewId-only conflict", async () => {
    const mutations = [
      ["rule_version", 4],
      ["facts_json", JSON.stringify({ senderAddrSpec: "other@example.com", listId: null })],
      ["provenance_json", JSON.stringify({ source: "tampered", evaluationId: "eval:123" })],
      ["candidate_targets_json", JSON.stringify([{ kind: "local-label", messageId: sqliteMessageId, label: "label:other" }])],
      ["created_at", "2026-08-18T00:00:01.000Z"],
      ["expires_at", "2026-08-18T00:30:00.000Z"],
      ["nonce", "nonce:tampered"],
      ["digest", "f".repeat(64)],
    ] as const;
    for (const [field, value] of mutations) {
      const database = openRoutingSqlite();
      const previews = new Map<string, RoutingPreview>();
      const preview = createRoutingPreview(
        database,
        sqlitePreviewInput(`preview:tamper-${field}`),
        sqlitePreviewDependencies,
      );
      previews.set(preview.previewId, preview);
      database.exec("DROP TRIGGER routing_previews_reject_update;");
      database.query(`UPDATE routing_previews SET ${field} = ? WHERE preview_id = ?;`).run(value, preview.previewId);
      const app = createHttpApp({
        authenticate: authenticated,
        handlers: createRoutingHandlers(sqliteRoutingServices(database, previews)),
      });
      const response = await app.request(
        request("/v1/routing/commit", {
          previewId: preview.previewId,
          digest: preview.digest,
          dryRun: false,
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          code: "routing.preview_tampered",
          details: { previewId: preview.previewId },
        }),
      );
      expect(sqliteCounts(database)).toEqual({
        previews: 1,
        decisions: 0,
        assignments: 0,
        labels: 0,
      });
    }
  });

  test("tamper, expiry, and an injected post-label transaction failure leave zero labels", async () => {
    const cases = [
      { name: "tamper", digest: "f".repeat(64), now: committedAt, inject: false },
      {
        name: "expiry",
        digest: undefined,
        now: "2026-08-18T00:20:00.000Z",
        inject: false,
      },
      { name: "failure", digest: undefined, now: committedAt, inject: true },
    ] as const;

    for (const candidate of cases) {
      const database = openRoutingSqlite();
      const previews = new Map<string, RoutingPreview>();
      const preview = createRoutingPreview(
        database,
        sqlitePreviewInput(`preview:${candidate.name}`),
        sqlitePreviewDependencies,
      );
      previews.set(preview.previewId, preview);
      if (candidate.inject) {
        // This fires after consumeRoutingPreview has inserted labels but before
        // its transaction can commit, proving rollback removes those writes.
        database.exec(`
          CREATE TRIGGER inject_routing_commit_failure
          AFTER UPDATE ON routing_previews
          WHEN NEW.consumed_at IS NOT NULL
          BEGIN
            SELECT RAISE(ABORT, 'injected routing transaction failure');
          END;
        `);
      }
      const app = createHttpApp({
        authenticate: authenticated,
        handlers: createRoutingHandlers(
          sqliteRoutingServices(database, previews, () => candidate.now),
        ),
      });
      const response = await app.request(
        request("/v1/routing/commit", {
          previewId: preview.previewId,
          digest: candidate.digest ?? preview.digest,
          dryRun: false,
        }),
      );
      const body: unknown = await response.json();
      if (candidate.name === "expiry") {
        expect(response.status).toBe(409);
        expect(publicErrorEnvelopeSchema.parse(body)).toMatchObject({
          code: "routing.preview_expired",
          details: { previewId: preview.previewId },
        });
      } else {
        expect(response.status).toBe(candidate.name === "tamper" ? 409 : 500);
        expect(publicErrorEnvelopeSchema.parse(body)).toMatchObject({
          code: candidate.name === "tamper" ? "routing.preview_tampered" : "internal_error",
          details: candidate.name === "tamper" ? { previewId: preview.previewId } : {},
        });
        expect(body).not.toHaveProperty("committed", true);
      }
      expect(sqliteCounts(database)).toEqual({
        previews: 1,
        decisions: 0,
        assignments: 0,
        labels: 0,
      });
      expect(database.query("SELECT consumed_at, consumed_by FROM routing_previews;").get()).toEqual({
        consumed_at: null,
        consumed_by: null,
      });
    }
  });

  test("local-label HTTP dry-run is inert and committed assignment is durable and idempotent", async () => {
    const database = openRoutingSqlite();
    const app = createHttpApp({
      authenticate: authenticated,
      handlers: createRoutingHandlers(sqliteRoutingServices(database, new Map())),
    });
    const body = {
      messageId: sqliteMessageId,
      label: "label:manual",
      provenance: { source: "http-label", evaluationId: "evaluation:one" },
    };

    const dryRunResponse = await app.request(
      request(`/v1/messages/${sqliteMessageId}/label`, { ...body, dryRun: true }),
    );
    expect(dryRunResponse.status).toBe(200);
    expect(await dryRunResponse.json()).toMatchObject({
      committed: false,
      dryRun: true,
      decisionId: null,
      assignedAt: null,
    });
    expect(sqliteCounts(database)).toMatchObject({ assignments: 0, labels: 0 });

    const commitResponse = await app.request(
      request(`/v1/messages/${sqliteMessageId}/label`, { ...body, dryRun: false }),
    );
    const commitBody: unknown = await commitResponse.json();
    expect(commitResponse.status).toBe(200);
    expect(commitBody).toMatchObject({
      committed: true,
      dryRun: false,
      messageId: sqliteMessageId,
      label: "label:manual",
    });
    expect(sqliteCounts(database)).toMatchObject({ assignments: 1, labels: 1 });

    const retryResponse = await app.request(
      request(`/v1/messages/${sqliteMessageId}/label`, { ...body, dryRun: false }),
    );
    expect(retryResponse.status).toBe(200);
    expect((await retryResponse.json())).toMatchObject({ committed: true });
    expect(sqliteCounts(database)).toMatchObject({ assignments: 1, labels: 1 });
  });
});
