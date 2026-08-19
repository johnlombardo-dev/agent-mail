import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createRouteDecision, parseRoutingDecision } from "../../core/src/index";
import { labelResponseSchema, routingPreviewResponseSchema } from "@agent-mail/contracts";
import {
  createHttpApp,
  type HttpCredentialResolution,
} from "../../daemon/src/http";
import { createRoutingHandlers, type RoutingServices } from "../../daemon/src/routing-handlers";
import { assignLocalLabel } from "../../storage/src/local-label-assignment";
import { localLabelMigration } from "../../storage/src/local-label-migration";
import { applyMigrations, type Migration } from "../../storage/src/migration-runner";
import { messageCatalogMigration } from "../../storage/src/migrations/0001-message-catalog";
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
import { executeCommand, type CommandResultV1 } from "./command-outcome";
import { createCliClient, type CliResponse } from "./client";
import { renderHuman } from "./output-context";
import {
  executeLocalLabelCommand,
  executeRoutingCommitCommand,
  executeRoutingPreviewCommand,
} from "./routing-commands";

const createdAt = "2026-08-19T00:00:00.000Z";
const committedAt = "2026-08-19T00:01:00.000Z";
const messageId = `message:${"a".repeat(64)}`;
const digestKey = Buffer.alloc(32, 0x5a);
const rule = {
  version: 1 as const,
  ruleId: "rule:finance",
  ruleVersion: 3,
  predicate: { kind: "exactSender" as const, sender: "billing@example.com" },
};
const provenance = { source: "cli-routing-test", evaluationId: "evaluation:one" };
const migrations = [
  { ...messageCatalogMigration, version: 1 },
  { ...localLabelMigration, version: 2 },
  { ...routingDecisionMigration, version: 3 },
  { ...routingPreviewMigration, version: 4 },
  { ...routingPreviewConsumptionMigration, version: 5 },
] satisfies readonly Migration[];

const databases: Database[] = [];

function openDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database, migrations);
  database.exec("PRAGMA foreign_keys = ON;");
  database.query("INSERT INTO messages (message_id) VALUES (?);").run(messageId);
  databases.push(database);
  return database;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} is not a record`);
  return value;
}

function counts(database: Database): Readonly<Record<string, number>> {
  const count = (table: string): number => {
    const row = record(database.query(`SELECT COUNT(*) AS count FROM ${table};`).get(), table);
    if (typeof row.count !== "number") throw new Error(`${table} count is invalid`);
    return row.count;
  };
  return {
    previews: count("routing_previews"),
    decisions: count("routing_decisions"),
    assignments: count("local_label_assignments"),
    labels: count("local_labels"),
  };
}

function previewInput(previewId: string): Readonly<Record<string, unknown>> {
  return {
    previewId,
    scope: "mail:routing:read",
    rule,
    facts: { senderAddrSpec: "billing@example.com", listId: null },
    provenance,
    candidateTargets: [{ kind: "local-label", messageId, label: "label:finance" }],
    ttlMs: 15 * 60 * 1000,
  };
}

function createServices(
  database: Database,
  previews: Map<string, RoutingPreview>,
  now: () => string = () => committedAt,
): RoutingServices {
  const dependencies: RoutingPreviewCreationDependencies = {
    clock: () => createdAt,
    nonce: () => "nonce:cli-routing",
    digestKey,
  };
  return {
    createPreview: (request) => {
      const preview = createRoutingPreview(database, previewInput("preview:cli"), dependencies);
      if (JSON.stringify(preview.rule) !== JSON.stringify(request.rule))
        throw new Error("request rule was not retained by storage");
      previews.set(preview.previewId, preview);
      const { facts: _facts, scope: _scope, ...publicPreview } = preview;
      return { ...publicPreview, authority: "server" as const };
    },
    commitPreview: (request, context) => {
      const preview = previews.get(request.previewId);
      if (preview === undefined)
        return { kind: "routing-commit-terminal" as const, disposition: "not-found" as const };
      if (request.dryRun)
        return {
          authority: "server" as const,
          committed: false as const,
          dryRun: true as const,
          decisionId: null,
          previewId: preview.previewId,
          previewDigest: preview.digest,
          decision: null,
        };
      let result: RoutingPreviewConsumptionResult;
      try {
        result = consumeRoutingPreview(
          database,
          {
            previewId: request.previewId,
            scope: preview.scope,
            nonce: preview.nonce,
            digest: request.digest,
            ruleVersion: preview.rule.ruleVersion,
            consumerId: `consumer:${context.principal.subject}`,
            now: now(),
          },
          { digestKey },
        );
      } catch (error: unknown) {
        if (!(error instanceof RoutingPreviewConsumptionError)) throw error;
        if (error.reason === "tampered")
          return {
            kind: "routing-commit-terminal" as const,
            disposition: "tampered" as const,
            previewId: preview.previewId,
          };
        if (error.reason === "not-found" || error.reason === "target")
          return { kind: "routing-commit-terminal" as const, disposition: "not-found" as const };
        throw error;
      }
      if (result.kind !== "consumed")
        return {
          kind: "routing-commit-terminal" as const,
          disposition: result.kind,
          previewId: result.previewId,
        };
      return committedResponse(database, preview, result);
    },
    assignLabel: (request) => {
      if (request.dryRun)
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
      const decision = createRouteDecision({
        kind: "route",
        label: request.label,
        ruleId: "rule:manual-label",
        ruleVersion: 1,
        matchedFacts: [{ field: "manual-label", value: request.label }],
        decidedAt: committedAt,
        provenance: request.provenance,
      });
      const assignment = assignLocalLabel(database, {
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
        messageId: assignment.assignment.messageId,
        label: assignment.assignment.label,
        decisionId: canonicalRoutingDecisionId(assignment.assignment.messageId, decision),
        committed: true as const,
        dryRun: false as const,
        assignedAt: assignment.assignment.decidedAt,
        provenance: {
          source: assignment.assignment.provenanceSource,
          evaluationId: assignment.assignment.provenanceEvaluationId,
        },
      };
    },
  };
}

function committedResponse(
  database: Database,
  preview: RoutingPreview,
  result: Extract<RoutingPreviewConsumptionResult, { readonly kind: "consumed" }>,
) {
  const row = record(
    database.query("SELECT decision_id, decision_json FROM routing_decisions WHERE message_id = ?;").get(messageId),
    "routing decision",
  );
  if (typeof row.decision_id !== "string" || typeof row.decision_json !== "string")
    throw new Error("routing decision row is malformed");
  return {
    authority: "server" as const,
    decisionId: row.decision_id,
    committed: true as const,
    dryRun: false as const,
    previewId: preview.previewId,
    previewDigest: preview.digest,
    decision: parseRoutingDecision(row.decision_json),
    committedAt: result.consumedAt,
    provenance: preview.provenance,
  };
}

function authenticated(): HttpCredentialResolution {
  return {
    kind: "authenticated",
    principal: {
      subject: "operator:cli-test",
      scopes: ["mail:routing:read", "mail:routing:write", "mail:label:write"],
    },
  };
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function withApi(
  database: Database,
  run: (baseUrl: string) => Promise<void>,
  now?: () => string,
): Promise<void> {
  const previews = new Map<string, RoutingPreview>();
  const app = createHttpApp({
    authenticate: () => authenticated(),
    handlers: createRoutingHandlers(createServices(database, previews, now)),
  });
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = request.method === "POST" ? await readRequest(request) : undefined;
    const webRequest = new Request(`http://127.0.0.1${request.url ?? "/"}`, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : [],
        ),
      ),
      ...(body === undefined ? {} : { body }),
    });
    const webResponse = await app.fetch(webRequest);
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("API fixture did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("routing and local-label CLI adapters", () => {
  it("preserves preview authority and renders hostile values through typed human segments", async () => {
    const calls: unknown[] = [];
    const preview = {
      authority: "server" as const,
      previewId: "preview:one",
      rule,
      candidateTargets: [
        { kind: "local-label" as const, messageId, label: "label:finance\u202E" },
      ],
      createdAt,
      expiresAt: "2026-08-19T00:15:00.000Z",
      nonce: "nonce:one",
      digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      provenance,
    };
    const result = await executeRoutingPreviewCommand({
      argv: ["routing", "preview"],
      input: { rule },
      correlationId: "cli:routing-preview",
      client: {
        async request(options: { readonly input: unknown }): Promise<CliResponse> {
          calls.push(options.input);
          return { kind: "success", operationKey: "routing.preview", status: 200, data: preview };
        },
      },
    });
    expect(result).toMatchObject({
      kind: "value",
      semanticKind: "success",
      operationKey: "routing.preview",
      data: preview,
    });
    expect(calls).toEqual([{ rule }]);
    if (result.kind === "value") {
      expect(result.humanLines.flat().map((segment) => segment.text).join(" ")).toContain("preview:one");
      expect(result.humanLines.flat().map((segment) => segment.kind)).toContain("untrusted-value");
      const firstLine = result.humanLines[0];
      if (firstLine === undefined) throw new Error("preview human output is empty");
      expect(renderHuman(firstLine)).toContain("preview:one");
      expect(result.humanLines.map((line) => renderHuman(line)).join("\n")).toContain("⟦RLO⟧");
    }
  });

  it("requires explicit confirmation and forwards the exact preview digest", async () => {
    const requests: unknown[] = [];
    const client = {
      async request(options: { readonly input: unknown }): Promise<CliResponse> {
        requests.push(options.input);
        return {
          kind: "success",
          operationKey: "routing.commit",
          status: 200,
          data: {
            authority: "server",
            committed: true,
            dryRun: false,
            decisionId: "decision:one",
            previewId: "preview:one",
            previewDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            decision: {
              kind: "route",
              ruleId: "rule:finance",
              ruleVersion: 3,
              matchedFacts: [{ field: "sender-addr-spec", value: "billing@example.com" }],
              decidedAt: committedAt,
              provenance,
              label: "label:finance",
            },
            committedAt,
            provenance,
          },
        };
      },
    };
    const withoutConfirmation = await executeRoutingCommitCommand({
      argv: ["routing", "commit"],
      input: { previewId: "preview:one", digest: "0".repeat(64), dryRun: false },
      confirm: false,
      correlationId: "cli:routing-commit",
      client,
    });
    expect(withoutConfirmation).toMatchObject({ kind: "failure", semanticKind: "usage" });
    expect(requests).toHaveLength(0);

    const committed = await executeRoutingCommitCommand({
      argv: ["routing", "commit"],
      input: { previewId: "preview:one", digest: "0".repeat(64), dryRun: false },
      confirm: true,
      correlationId: "cli:routing-commit",
      client,
    });
    expect(committed).toMatchObject({ kind: "value", semanticKind: "success", data: { committed: true } });
    expect(requests).toEqual([{ previewId: "preview:one", digest: "0".repeat(64), dryRun: false }]);
  });

  it("runs preview, commit, and local label through the real HTTP API and SQLite storage", async () => {
    const database = openDatabase();
    await withApi(database, async (baseUrl) => {
      const client = createCliClient({ baseUrl, authorization: "Bearer cli-test" });
      const previewResult = await executeRoutingPreviewCommand({
        argv: ["routing", "preview"],
        input: { rule },
        correlationId: "cli:real-routing",
        client,
      });
      expect(previewResult).toMatchObject({ kind: "value", operationKey: "routing.preview" });
      if (previewResult.kind !== "value") throw new Error("preview did not return a value");
      const preview = routingPreviewResponse(previewResult.data);
      expect(counts(database)).toEqual({ previews: 1, decisions: 0, assignments: 0, labels: 0 });

      const dryRunResult = await executeRoutingCommitCommand({
        argv: ["routing", "commit"],
        input: { previewId: preview.previewId, digest: preview.digest, dryRun: true },
        confirm: false,
        correlationId: "cli:real-routing-dry-run",
        client,
      });
      expect(dryRunResult).toMatchObject({
        kind: "value",
        semanticKind: "success",
        data: {
          committed: false,
          dryRun: true,
          previewId: preview.previewId,
          previewDigest: preview.digest,
        },
      });
      expect(await commandReceipt(dryRunResult)).toEqual({ exitCode: 0 });
      expect(counts(database)).toEqual({ previews: 1, decisions: 0, assignments: 0, labels: 0 });

      const commitResult = await executeRoutingCommitCommand({
        argv: ["routing", "commit"],
        input: { previewId: preview.previewId, digest: preview.digest, dryRun: false },
        confirm: true,
        correlationId: "cli:real-routing",
        client,
      });
      expect(commitResult).toMatchObject({ kind: "value", semanticKind: "success", data: { committed: true } });
      expect(await commandReceipt(commitResult)).toEqual({ exitCode: 0 });
      expect(counts(database)).toEqual({ previews: 1, decisions: 1, assignments: 1, labels: 1 });

      const labelResult = await executeLocalLabelCommand({
        argv: ["messages", "label"],
        input: {
          messageId,
          label: "label:manual",
          provenance: { source: "cli-label", evaluationId: "evaluation:two" },
          dryRun: false,
        },
        confirm: true,
        correlationId: "cli:real-label",
        client,
      });
      expect(labelResult).toMatchObject({ kind: "value", semanticKind: "success", data: { committed: true } });
      expect(await commandReceipt(labelResult)).toEqual({ exitCode: 0 });
      expect(counts(database)).toMatchObject({ assignments: 2, labels: 2 });
      if (labelResult.kind !== "value") throw new Error("label did not return a value");
      const labelResponse = labelResponseSchema.parse(labelResult.data);
      expect(labelResponse).toMatchObject({ messageId, label: "label:manual", assignedAt: committedAt });
      expect(labelResponse.decisionId).toMatch(/^decision:/u);
      expect(
        database
          .query(
            "SELECT message_id, label, rule_id, rule_version, decided_at FROM local_label_assignments WHERE label = ?;",
          )
          .get("label:manual"),
      ).toEqual({
        message_id: messageId,
        label: "label:manual",
        rule_id: "rule:manual-label",
        rule_version: 1,
        decided_at: committedAt,
      });
    });
  });

  it("returns shared failure semantics for tamper and never fabricates a committed result", async () => {
    const database = openDatabase();
    await withApi(database, async (baseUrl) => {
      const client = createCliClient({ baseUrl, authorization: "Bearer cli-test" });
      const previewResult = await executeRoutingPreviewCommand({
        argv: ["routing", "preview"],
        input: { rule },
        correlationId: "cli:tamper",
        client,
      });
      if (previewResult.kind !== "value") throw new Error("preview did not return a value");
      const preview = routingPreviewResponse(previewResult.data);
      const result = await executeRoutingCommitCommand({
        argv: ["routing", "commit"],
        input: { previewId: preview.previewId, digest: "f".repeat(64), dryRun: false },
        confirm: true,
        correlationId: "cli:tamper",
        client,
      });
      expect(result).toMatchObject({
        kind: "failure",
        semanticKind: "tampered",
        error: {
          code: "routing.preview_tampered",
          details: { previewId: preview.previewId },
        },
      });
      expect(await commandReceipt(result)).toEqual({ exitCode: 83 });
      expect(result).not.toHaveProperty("data.committed", true);
      expect(counts(database)).toEqual({ previews: 1, decisions: 0, assignments: 0, labels: 0 });
    });
  });

  it("preserves server replay and expiry outcomes without claiming persistence", async () => {
    const replayDatabase = openDatabase();
    await withApi(replayDatabase, async (baseUrl) => {
      const client = createCliClient({ baseUrl, authorization: "Bearer cli-test" });
      const previewResult = await executeRoutingPreviewCommand({
        argv: ["routing", "preview"],
        input: { rule },
        correlationId: "cli:replay",
        client,
      });
      if (previewResult.kind !== "value") throw new Error("replay preview did not return a value");
      const preview = routingPreviewResponse(previewResult.data);
      const request = { previewId: preview.previewId, digest: preview.digest, dryRun: false };
      const first = await executeRoutingCommitCommand({
        argv: ["routing", "commit"],
        input: request,
        confirm: true,
        correlationId: "cli:replay",
        client,
      });
      expect(first).toMatchObject({ kind: "value", data: { committed: true } });
      const replay = await executeRoutingCommitCommand({
        argv: ["routing", "commit"],
        input: request,
        confirm: true,
        correlationId: "cli:replay",
        client,
      });
      expect(replay).toMatchObject({
        kind: "failure",
        semanticKind: "replay",
        error: {
          code: "routing.preview_replayed",
          details: { previewId: preview.previewId },
        },
      });
      expect(await commandReceipt(replay)).toEqual({ exitCode: 82 });
      expect(replay).not.toHaveProperty("data.committed", true);
      expect(counts(replayDatabase)).toEqual({ previews: 1, decisions: 1, assignments: 1, labels: 1 });
    });

    const expiryDatabase = openDatabase();
    await withApi(
      expiryDatabase,
      async (baseUrl) => {
        const client = createCliClient({ baseUrl, authorization: "Bearer cli-test" });
        const previewResult = await executeRoutingPreviewCommand({
          argv: ["routing", "preview"],
          input: { rule },
          correlationId: "cli:expiry",
          client,
        });
        if (previewResult.kind !== "value") throw new Error("expiry preview did not return a value");
        const preview = routingPreviewResponse(previewResult.data);
        const expired = await executeRoutingCommitCommand({
          argv: ["routing", "commit"],
          input: { previewId: preview.previewId, digest: preview.digest, dryRun: false },
          confirm: true,
          correlationId: "cli:expiry",
          client,
        });
        expect(expired).toMatchObject({
          kind: "failure",
          semanticKind: "expired",
          error: {
            code: "routing.preview_expired",
            details: { previewId: preview.previewId },
          },
        });
        expect(await commandReceipt(expired)).toEqual({ exitCode: 81 });
        expect(counts(expiryDatabase)).toEqual({ previews: 1, decisions: 0, assignments: 0, labels: 0 });
      },
      () => "2026-08-19T00:20:00.000Z",
    );
  });

  it("maps missing previews to not-found/66 without exposing storage details", async () => {
    const database = openDatabase();
    await withApi(database, async (baseUrl) => {
      const client = createCliClient({ baseUrl, authorization: "Bearer cli-test" });
      const result = await executeRoutingCommitCommand({
        argv: ["routing", "commit"],
        input: { previewId: "preview:missing", digest: "0".repeat(64), dryRun: false },
        confirm: true,
        correlationId: "cli:not-found",
        client,
      });
      expect(result).toMatchObject({
        kind: "failure",
        semanticKind: "not_found",
        error: { code: "not_found", details: {} },
      });
      expect(await commandReceipt(result)).toEqual({ exitCode: 66 });
      expect(JSON.stringify(result)).not.toContain("preview authority was not stored");
      expect(counts(database)).toEqual({ previews: 0, decisions: 0, assignments: 0, labels: 0 });
    });
  });

  it("maps an injected post-write SQLite failure to internal/70 and proves rollback", async () => {
    const database = openDatabase();
    await withApi(database, async (baseUrl) => {
      const client = createCliClient({ baseUrl, authorization: "Bearer cli-test" });
      const previewResult = await executeRoutingPreviewCommand({
        argv: ["routing", "preview"],
        input: { rule },
        correlationId: "cli:internal-preview",
        client,
      });
      if (previewResult.kind !== "value") throw new Error("internal preview did not return a value");
      const preview = routingPreviewResponse(previewResult.data);
      database.exec(
        "CREATE TRIGGER fail_routing_receipt AFTER UPDATE ON routing_previews BEGIN SELECT RAISE(ABORT, 'injected routing failure'); END;",
      );
      const result = await executeRoutingCommitCommand({
        argv: ["routing", "commit"],
        input: { previewId: preview.previewId, digest: preview.digest, dryRun: false },
        confirm: true,
        correlationId: "cli:internal",
        client,
      });
      expect(result).toMatchObject({
        kind: "failure",
        semanticKind: "internal",
        error: { code: "internal_error", details: {} },
      });
      expect(await commandReceipt(result)).toEqual({ exitCode: 70 });
      expect(result).not.toHaveProperty("data.committed", true);
      expect(counts(database)).toEqual({ previews: 1, decisions: 0, assignments: 0, labels: 0 });
      expect(database.query("SELECT consumed_at, consumed_by FROM routing_previews;").get()).toEqual({
        consumed_at: null,
        consumed_by: null,
      });
    });
  });

  it("does not expose a commit result while storage is delayed", async () => {
    const release: { resolve?: () => void } = {};
    const resultPromise = executeRoutingCommitCommand({
      argv: ["routing", "commit"],
      input: { previewId: "preview:delayed", digest: "0".repeat(64), dryRun: false },
      confirm: true,
      correlationId: "cli:delayed",
      client: {
        async request(): Promise<CliResponse> {
          await new Promise<void>((resolve) => {
            release.resolve = resolve;
          });
          return {
            kind: "success",
            operationKey: "routing.commit",
            status: 200,
            data: {
              authority: "server",
              committed: true,
              dryRun: false,
              decisionId: "decision:delayed",
              previewId: "preview:delayed",
              previewDigest: "0".repeat(64),
              decision: {
                kind: "route",
                ruleId: "rule:finance",
                ruleVersion: 3,
                matchedFacts: [{ field: "sender-addr-spec", value: "billing@example.com" }],
                decidedAt: committedAt,
                provenance,
                label: "label:finance",
              },
              committedAt,
              provenance,
            },
          };
        },
      },
    });
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve?.();
    await expect(resultPromise).resolves.toMatchObject({ kind: "value", data: { committed: true } });
  });
});

function routingPreviewResponse(value: unknown): RoutingPreview {
  return routingPreviewResponseSchema.parse(value);
}

async function commandReceipt(result: CommandResultV1): Promise<Readonly<{ readonly exitCode: number }>> {
  const sink = {
    isTTY: false,
    async write(bytes: Uint8Array) {
      return { kind: "written" as const, bytesAccepted: bytes.byteLength };
    },
  };
  const receipt = await executeCommand(result, {
    invocationCorrelationId: "cli:routing-receipt",
    mode: "json",
    stdout: sink,
    stderr: sink,
    rawPolicy: { destination: "pipe", tty: "refuse" },
    signal: new AbortController().signal,
  });
  return { exitCode: receipt.exitCode };
}
