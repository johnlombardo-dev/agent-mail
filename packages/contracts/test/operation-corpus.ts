import {
  publicCliOperations,
  type CliCommandDefinition,
} from "../../cli/src/command-registry";
import {
  reportAdminExportResponseSchema,
  reportAdminExportRecordSchema,
  parseErrorDefinition,
  streamMetadataSchema,
  type OperationDefinition,
  type OperationSchema,
  type PublicErrorStatus,
} from "../src/index";

/** A fixture for one registered public error branch of an operation response. */
export type OperationErrorFixture = Readonly<{
  readonly code: string;
  readonly status: PublicErrorStatus;
  readonly response: unknown;
}>;

export type OperationStreamFixture = Readonly<{
  /** Metadata is present for both byte streams and NDJSON streams. */
  readonly metadata: unknown;
  /** One representative record proves the NDJSON item shape as well as its header. */
  readonly ndjsonRecord?: unknown;
}>;

export type OperationCorpusEntry = Readonly<{
  readonly request: unknown;
  readonly requestVariants?: readonly unknown[];
  readonly success: unknown;
  /** Additional success variants exercise terminal-state unions without adding operations. */
  readonly successVariants?: readonly unknown[];
  readonly errors: readonly OperationErrorFixture[];
  readonly stream?: OperationStreamFixture;
}>;

export type OperationCorpus = Readonly<Record<string, OperationCorpusEntry>>;

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const longSuffix = "界".repeat(120);
const retrievalAfter = "2024-02-29T10:00:00+14:00";
const retrievalBefore = "2024-02-29T23:59:59.999+14:00";
const instant = "2024-03-01T00:00:00.000Z";
const laterInstant = "2024-03-01T00:00:01.000Z";
const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
const syncIncarnationId = "incarnation:corpus-例";

const messageId = `message:réunion-${longSuffix}`;
const threadId = `thread:${digest}`;
const attachmentId = "attachment:attachment-例";
const mailboxId = "mailbox:archive-例";
const placementId = "placement:archive-copy";

const sender = { name: "Zoë 例", address: "zoe@example.com" };
const streamMetadata = {
  contentType: "message/rfc822",
  contentLength: 42,
  digest,
  filename: "réunion.eml",
};

const hydratedMessage = {
  messageId,
  threadId,
  subject: "Réunion — résumé 例",
  from: sender,
  to: [{ address: "owner@example.com" }],
  cc: [],
  sentAt: retrievalAfter,
  receivedAt: retrievalBefore,
  textBody: "Résumé en français — 例",
  htmlBody: "<p>Résumé en français — 例</p>",
  snippet: "Résumé en français — 例",
  isUnread: true,
  labels: ["label:important"],
  attachments: [
    {
      attachmentId,
      filename: "réunion.pdf",
      contentType: "application/pdf",
      sizeBytes: maximumSafeInteger,
    },
  ],
};

const notFound = (resource: "message" | "thread" | "raw-message" | "attachment", id: string) => ({
  code: "not_found",
  message: `${resource} was not found`,
  correlationId: `correlation:${resource}-例`,
  details: { resource, id },
});

const invalidThreadCursor = {
  code: "invalid_cursor",
  message: "thread cursor is invalid",
  correlationId: "correlation:thread-cursor-例",
  details: { resource: "thread" },
};
const invalidSearchQuery = {
  code: "invalid_query",
  message: "invalid search query",
  correlationId: "correlation:search-query-例",
  details: { resource: "search" },
};
const invalidSearchCursor = {
  code: "invalid_cursor",
  message: "search cursor is invalid",
  correlationId: "correlation:search-cursor-例",
  details: { resource: "search" },
};

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

const threadCursor = encodeBase64Url(
  JSON.stringify([
    "thread-cursor-v1",
    JSON.stringify({
      registryVersion: 1,
      cursorKeyId: "active-key",
      accountScopeDigest: "a".repeat(64),
      requestedThreadHandle: threadId,
      lastSentAtMissingRank: 0,
      lastSentAt: instant,
      lastMessageId: `message:${"b".repeat(64)}`,
    }),
    "c".repeat(64),
  ]),
);

const syncControlErrors = (command: "start" | "pause" | "resume" | "stop") => {
  const details = {
    commandId: `command:${command}-error-例`,
    command,
    actorState: "watching",
    version: maximumSafeInteger,
    incarnationId: syncIncarnationId,
  };
  const common = [
    {
      code: "sync.control-rejected",
      status: 500,
      response: {
        code: "sync.control-rejected",
        message: "Sync control was rejected.",
        correlationId: `correlation:${command}-rejected-例`,
        details: { ...details, reason: "stale-version" },
      },
    },
    {
      code: "sync.control-failed",
      status: 500,
      response: {
        code: "sync.control-failed",
        message: "Sync control failed before completion.",
        correlationId: `correlation:${command}-failed-例`,
        details: { ...details, reason: "terminal-failure" },
      },
    },
    {
      code: "sync.control-cancelled",
      status: 500,
      response: {
        code: "sync.control-cancelled",
        message: "Sync control was superseded.",
        correlationId: `correlation:${command}-cancelled-例`,
        details: { ...details, reason: "superseded-by-stop" },
      },
    },
    {
      code: "sync.control-timeout",
      status: 500,
      response: {
        code: "sync.control-timeout",
        message: "Sync control did not complete before the deadline.",
        correlationId: `correlation:${command}-timeout-例`,
        details: { ...details, reason: "deadline-elapsed", deadlineMs: 300_000 },
      },
    },
  ];
  if (command === "start") return common;
  return [
    ...common,
    {
      code: "sync.control-idempotency-conflict",
      status: 500,
      response: {
        code: "sync.control-idempotency-conflict",
        message: "Sync control idempotency key conflicts with an earlier request.",
        correlationId: `correlation:${command}-conflict-例`,
        details: {
          ...details,
          reason: "key-reused-with-different-fingerprint",
          idempotencyKey: `idempotency:${command}-例`,
        },
      },
    },
    {
      code: "sync.control-capacity",
      status: 500,
      response: {
        code: "sync.control-capacity",
        message: "Sync control idempotency capacity is exhausted.",
        correlationId: `correlation:${command}-capacity-例`,
        details: { ...details, reason: "all-retained-entries-in-flight", capacity: 10_000 },
      },
    },
  ];
};

const actionTarget = {
  accountId: "account:icloud-example",
  mailboxId: "mailbox:archive-example",
  uidValidity: maximumSafeInteger,
  uid: maximumSafeInteger,
  precondition: { modseq: maximumSafeInteger },
};
const action = { kind: "markSeen" as const };
const actionPlanBase = {
  planId: "plan:plan-例",
  action,
  targets: [actionTarget],
  createdAt: instant,
  expiresAt: "2024-03-02T00:00:00.000Z",
};
const pendingPlan = { state: "pending" as const, ...actionPlanBase };
const failedPlan = {
  state: "failed" as const,
  ...actionPlanBase,
  failedAt: laterInstant,
};
const expiredPlan = {
  state: "expired" as const,
  ...actionPlanBase,
  expiredAt: actionPlanBase.expiresAt,
};
const failedAttemptResult = {
  kind: "failed" as const,
  planId: actionPlanBase.planId,
  action,
  target: actionTarget,
  attemptId: "attempt:attempt-例",
  idempotencyKey: "idempotency:plan-例",
  startedAt: instant,
  resultAt: laterInstant,
  certainty: "definite" as const,
  failureReason: "server-rejected" as const,
  detail: "The remote server rejected the frozen action — 例",
};

const routingRule = {
  version: 1 as const,
  ruleId: "rule:inbox-例",
  ruleVersion: maximumSafeInteger,
  predicate: { kind: "exactSender" as const, sender: "zoe@example.com" },
};
const routingProvenance = { source: "local-rule-engine", evaluationId: "evaluation:例" };
const routingPreview = {
  authority: "server" as const,
  previewId: "preview:preview-例",
  rule: routingRule,
  candidateTargets: [
    { kind: "local-label" as const, messageId, label: "label:important" },
    { kind: "remote-placement" as const, messageId, placementId, mailboxId },
  ],
  createdAt: instant,
  expiresAt: laterInstant,
  nonce: "nonce:preview-0123456789",
  digest,
  provenance: routingProvenance,
};
const routingDecision = {
  ruleId: routingRule.ruleId,
  ruleVersion: routingRule.ruleVersion,
  matchedFacts: [{ field: "from", value: "zoe@example.com" }],
  decidedAt: laterInstant,
  provenance: routingProvenance,
  kind: "route" as const,
  label: "label:important",
};

const reportAuthorization = {
  principal: "local-operator",
  scope: "reports:write",
  method: "local-cli" as const,
  requestId: "request:request-例",
  authorizedAt: instant,
};
const manifest = { manifestId: "manifest:manifest-例", digest };

const corpusEntries: Readonly<Record<string, OperationCorpusEntry>> = {
  "messages.search": {
    request: {
      query: "réunion 例",
      filters: { sender: "zoe@example.com", after: retrievalAfter, before: retrievalBefore },
      limit: 100,
    },
    success: {
      items: [
        {
          messageId,
          threadId,
          subject: "Réunion — résumé 例",
          sender,
          sentAt: retrievalAfter,
          receivedAt: retrievalBefore,
          snippet: "Résumé en français — 例",
          isUnread: true,
          hasAttachment: true,
          score: 0.75,
        },
      ],
      nextCursor: null,
    },
    errors: [
      { code: "invalid_query", status: 400, response: invalidSearchQuery },
      { code: "invalid_cursor", status: 400, response: invalidSearchCursor },
    ],
  },
  "messages.get": {
    request: { messageId },
    success: { message: hydratedMessage },
    errors: [{ code: "not_found", status: 404, response: notFound("message", messageId) }],
  },
  "threads.get": {
    request: { threadId },
    requestVariants: [{ threadId, limit: 100, cursor: threadCursor }],
    success: {
      thread: {
        threadId,
        resolvedFromThreadId: null,
        subject: "Réunion — résumé 例",
        participants: [sender],
        participantsTruncated: false,
        messageCount: 1,
        messageIds: [messageId],
        messages: [hydratedMessage],
        firstReceivedAt: retrievalBefore,
        lastReceivedAt: retrievalBefore,
        nextCursor: null,
      },
    },
    successVariants: [
      {
        thread: {
          threadId,
          resolvedFromThreadId: `thread:${"f".repeat(64)}`,
          subject: "Réunion — résumé 例",
          participants: [sender],
          participantsTruncated: false,
          messageCount: 2,
          messageIds: [messageId],
          messages: [hydratedMessage],
          firstReceivedAt: retrievalBefore,
          lastReceivedAt: retrievalBefore,
          nextCursor: null,
        },
      },
      {
        thread: {
          threadId,
          resolvedFromThreadId: null,
          subject: "Réunion — résumé 例",
          participants: [sender],
          participantsTruncated: false,
          messageCount: 2,
          messageIds: [],
          messages: [],
          firstReceivedAt: retrievalBefore,
          lastReceivedAt: retrievalBefore,
          nextCursor: null,
        },
      },
    ],
    errors: [
      { code: "invalid_cursor", status: 400, response: invalidThreadCursor },
      { code: "not_found", status: 404, response: notFound("thread", threadId) },
    ],
  },
  "messages.raw": {
    request: { messageId },
    success: streamMetadata,
    errors: [{ code: "not_found", status: 404, response: notFound("raw-message", messageId) }],
    stream: { metadata: streamMetadata },
  },
  "attachments.get": {
    request: { attachmentId },
    success: {
      attachmentId,
      messageId,
      metadata: streamMetadata,
    },
    errors: [{ code: "not_found", status: 404, response: notFound("attachment", attachmentId) }],
    stream: {
      metadata: { ...streamMetadata, contentType: "application/pdf", filename: "réunion.pdf" },
    },
  },
  "routing.preview": {
    request: { rule: routingRule },
    success: routingPreview,
    errors: [],
  },
  "routing.commit": {
    request: { previewId: routingPreview.previewId, digest, dryRun: false },
    success: {
      authority: "server" as const,
      decisionId: "decision:decision-例",
      committed: true as const,
      dryRun: false as const,
      previewId: routingPreview.previewId,
      previewDigest: digest,
      decision: routingDecision,
      committedAt: laterInstant,
      provenance: routingProvenance,
    },
    errors: [
      {
        code: "routing.preview_replayed",
        status: 409,
        response: {
          code: "routing.preview_replayed",
          message: "routing preview was already consumed",
          correlationId: "correlation:routing-preview-replayed-例",
          details: { previewId: routingPreview.previewId },
        },
      },
      {
        code: "routing.preview_expired",
        status: 409,
        response: {
          code: "routing.preview_expired",
          message: "routing preview has expired",
          correlationId: "correlation:routing-preview-expired-例",
          details: { previewId: routingPreview.previewId },
        },
      },
      {
        code: "routing.preview_tampered",
        status: 409,
        response: {
          code: "routing.preview_tampered",
          message: "routing preview authority does not match",
          correlationId: "correlation:routing-preview-tampered-例",
          details: { previewId: routingPreview.previewId },
        },
      },
    ],
  },
  "messages.label": {
    request: { messageId, label: "label:important", provenance: routingProvenance, dryRun: false },
    success: {
      authority: "server" as const,
      messageId,
      label: "label:important",
      decisionId: "decision:decision-例",
      committed: true as const,
      dryRun: false as const,
      assignedAt: laterInstant,
      provenance: routingProvenance,
    },
    errors: [],
  },
  "action-plans.create": {
    request: { action, targets: [actionTarget] },
    success: {
      plan: pendingPlan,
      digest,
      planVersion: 1,
      previewDigest: digest,
      targetDigest: digest,
      normalizedIntent: "[\"action-intent-v1\"]",
      creator: { principalId: "principal:local-operator", profile: "operator-interactive" },
      approvalState: "absent",
    },
    errors: [],
  },
  "operator-sessions.create": {
    request: { requestedScopes: ["mail:action.create", "mail:action.inspect"] },
    success: {
      sessionId: "operator-session:session-例",
      token: "session-token-例",
      tokenType: "Bearer",
      scopes: ["mail:action.create", "mail:action.inspect"],
      issuedAt: instant,
      expiresAt: "2024-03-01T00:10:00.000Z",
    },
    errors: [],
  },
  "action-plans.inspect": {
    request: { planId: pendingPlan.planId },
    success: {
      plan: pendingPlan,
      results: [],
      planVersion: 1,
      previewDigest: digest,
      targetDigest: digest,
      normalizedIntent: "[\"action-intent-v1\"]",
      creator: { principalId: "principal:local-operator", profile: "operator-interactive" },
      approvalState: "absent",
      terminalAudit: "absent",
    },
    errors: [],
  },
  "action-plans.approve": {
    request: { planId: pendingPlan.planId, planVersion: 1, previewDigest: digest },
    success: {
      approval: {
        state: "available",
        approvalId: "approval:approval-例",
        planId: pendingPlan.planId,
        planVersion: 1,
        previewDigest: digest,
        targetDigest: digest,
        normalizedIntent: "[\"action-intent-v1\"]",
        issuedAt: instant,
        expiresAt: "2024-03-01T00:10:00.000Z",
        authorizationScope: "mail:action.commit",
        approver: { principalId: "principal:operator-例", profile: "operator-interactive" },
      },
    },
    errors: [],
  },
  "action-plans.cancel-approval": {
    request: { planId: pendingPlan.planId, approvalId: "approval:approval-例", planVersion: 1, previewDigest: digest },
    success: {
      approval: { state: "cancelled", approvalId: "approval:approval-例", planId: pendingPlan.planId, cancelledAt: laterInstant },
      planVersion: 2,
    },
    errors: [],
  },
  "action-plans.commit": {
    request: {
      planId: failedPlan.planId,
      planVersion: 1,
      previewDigest: digest,
      approvalId: "approval:approval-例",
    },
    success: { plan: failedPlan, results: [failedAttemptResult], consumptionReceipt: { receiptId: "approval-receipt:receipt-例", approvalId: "approval:approval-例", planId: failedPlan.planId, claimId: "claim:claim-例", consumedAt: laterInstant, committer: { principalId: "principal:agent-例", profile: "agent-unattended" }, executorProfile: "internal-action-executor" } },
    successVariants: [{ plan: expiredPlan, results: [], consumptionReceipt: { receiptId: "approval-receipt:receipt-例-2", approvalId: "approval:approval-例", planId: expiredPlan.planId, claimId: "claim:claim-例-2", consumedAt: laterInstant, committer: { principalId: "principal:agent-例", profile: "agent-unattended" }, executorProfile: "internal-action-executor" } }],
    errors: [],
  },
  "reports.create": {
    request: {
      title: "Réunion — rapport 例",
      sourceMessageIds: [messageId],
      metadata: { "langue-例": "français" },
    },
    success: {
      reportId: "report:report-例",
      title: "Réunion — rapport 例",
      citations: [{ id: messageId, label: "Source principale" }],
      authorization: reportAuthorization,
      createdAt: instant,
    },
    errors: [],
  },
  "exports.selected": {
    request: { selection: { kind: "identities" as const, messageIds: [messageId] } },
    success: { version: 1, contentType: "application/octet-stream", streamVersion: 1 },
    errors: [],
    stream: {
      metadata: { version: 1, contentType: "application/octet-stream", streamVersion: 1 },
    },
  },
  "admin.backup": {
    request: { destination: "/private/var/backups/agent-mail-例" },
    success: {
      backupId: "backup:backup-例",
      manifest,
      destination: "/private/var/backups/agent-mail-例",
      createdAt: instant,
      bytes: maximumSafeInteger,
    },
    errors: [],
  },
  "admin.restore": {
    request: {
      target: "/private/var/lib/agent-mail-例",
      manifest,
      confirmationNonce: "restore:nonce-0123456789",
      offline: true,
    },
    success: {
      restored: true,
      target: "/private/var/lib/agent-mail-例",
      manifest,
      completedAt: laterInstant,
    },
    errors: [],
  },
  "admin.doctor": {
    request: {},
    success: {
      status: "healthy" as const,
      checks: [{ id: "storage-integrity", status: "pass" as const, summary: "Storage is consistent" }],
      issues: [],
    },
    errors: [],
  },
  "admin.reindex": {
    request: { scope: "all" as const, operationIntent: "Rebuild local search indexes — 例" },
    success: { accepted: true, scope: "all" as const, startedAt: instant, indexed: 42, expected: 42 },
    errors: [],
  },
  "sync.status": {
    request: {},
    success: {
      actorState: "watching" as const,
      activeOperation: "watch" as const,
      authBlocked: null,
      incarnationId: syncIncarnationId,
      version: maximumSafeInteger,
      checkpoint: {
        completedMailboxes: maximumSafeInteger,
        totalMailboxes: maximumSafeInteger,
        completedMessages: maximumSafeInteger,
        pendingMessages: 0,
        lastMailbox: "mailbox:例",
        lastUid: maximumSafeInteger,
      },
      diagnostics: [],
    },
    errors: [],
  },
  "sync.start": {
    request: {},
    success: { accepted: true, commandId: "command:start-例", observed: { actorState: "starting" as const, incarnationId: syncIncarnationId, version: maximumSafeInteger } },
    errors: syncControlErrors("start"),
  },
  "sync.pause": {
    request: { idempotencyKey: "idempotency:pause-例" },
    success: { accepted: true, commandId: "command:pause-例", completed: true, observed: { actorState: "paused" as const, incarnationId: syncIncarnationId, version: maximumSafeInteger } },
    errors: syncControlErrors("pause"),
  },
  "sync.resume": {
    request: { idempotencyKey: "idempotency:resume-例" },
    success: { accepted: true, commandId: "command:resume-例", completed: true, observed: { actorState: "watching" as const, incarnationId: syncIncarnationId, version: maximumSafeInteger } },
    errors: syncControlErrors("resume"),
  },
  "sync.stop": {
    request: { idempotencyKey: "idempotency:stop-例" },
    success: { accepted: true, commandId: "command:stop-例", completed: true, observed: { actorState: "stopped" as const, incarnationId: syncIncarnationId, version: maximumSafeInteger } },
    errors: syncControlErrors("stop"),
  },
};

/** The corpus is keyed from the exact CLI registry, so stale entries cannot hide drift. */
export const operationCorpus: OperationCorpus = Object.freeze(corpusEntries);

/**
 * Check corpus shape, registry coverage, and every declared error fixture.
 * Error applicability is derived from the operation definition itself, so a
 * second hand-maintained code table cannot silently omit a newly declared error.
 */
export function assertCorpusComplete(
  operations: readonly OperationDefinition<OperationSchema, OperationSchema>[],
  corpus: OperationCorpus,
): void {
  const expectedKeys = operations.map(({ key }) => key);
  const actualKeys = Object.keys(corpus);
  const expectedSet = new Set(expectedKeys);
  const actualSet = new Set(actualKeys);
  if (expectedSet.size !== expectedKeys.length) throw new Error("operation registry has duplicate keys");
  const missing = expectedKeys.filter((key) => !actualSet.has(key));
  if (missing.length > 0) throw new Error(`operation corpus missing operation: ${missing.join(", ")}`);
  const extra = actualKeys.filter((key) => !expectedSet.has(key) && key !== "operator-sessions.create");
  if (extra.length > 0) throw new Error(`operation corpus has unknown operation: ${extra.join(", ")}`);
  for (const operation of operations) {
    const entry = corpus[operation.key];
    if (entry === undefined) throw new Error(`operation ${operation.key} has no corpus entry`);
    if (entry.request === undefined) throw new Error(`operation ${operation.key} missing request fixture`);
    if (entry.success === undefined) throw new Error(`operation ${operation.key} missing success fixture`);
    if (!Array.isArray(entry.errors)) throw new Error(`operation ${operation.key} missing error applicability`);
    const expectedErrors = operation.errors.map(({ code }) => code);
    const actualErrors = entry.errors.map(({ code }) => code);
    if (new Set(actualErrors).size !== actualErrors.length)
      throw new Error(`operation ${operation.key} has duplicate error fixtures`);
    if (JSON.stringify([...actualErrors].sort()) !== JSON.stringify([...expectedErrors].sort()))
      throw new Error(`operation ${operation.key} has incorrect applicable error fixtures`);
    for (const fixture of entry.errors) {
      const definition = operation.errors.find(({ code }) => code === fixture.code);
      if (definition === undefined) continue;
      if (fixture.status !== definition.status)
        throw new Error(
          `operation ${operation.key} error ${fixture.code} has status ${fixture.status}; expected ${definition.status}`,
        );
      try {
        parseErrorDefinition(definition, fixture.response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid error fixture";
        throw new Error(`operation ${operation.key} error ${fixture.code} has invalid response: ${message}`);
      }
    }
    if (operation.streaming !== "none" && entry.stream === undefined)
      throw new Error(`operation ${operation.key} missing ${operation.streaming} stream metadata fixture`);
    if (operation.streaming === "none" && entry.stream !== undefined)
      throw new Error(`operation ${operation.key} has an inapplicable stream fixture`);
    if (operation.streaming === "ndjson" && entry.stream?.ndjsonRecord === undefined)
      throw new Error(`operation ${operation.key} missing NDJSON record fixture`);
  }
}

/** The CLI registry itself is the source of truth for this corpus. */
function requiredCliScope(operation: OperationDefinition): string {
  if (operation.scope === null) throw new TypeError(`operation ${operation.key} is not a CLI command`);
  return operation.scope;
}

export const corpusOperations: readonly CliCommandDefinition[] = publicCliOperations.map((operation) =>
  ({
    path: operation.cliName.split("-") as [string, ...string[]],
    operationKey: operation.key,
    scope: requiredCliScope(operation),
    streaming: operation.streaming,
    operation,
  }) satisfies CliCommandDefinition,
);

/** Parse a stream header using the same shared stream metadata schema. */
export function parseStreamMetadata(fixture: OperationStreamFixture): unknown {
  return streamMetadataSchema.parse(fixture.metadata);
}

export function parseByteStreamMetadata(fixture: OperationStreamFixture): unknown {
  return reportAdminExportResponseSchema.parse(fixture.metadata);
}

/** Parse an NDJSON item using the same shared export record schema. */
export function parseNdjsonRecord(fixture: OperationStreamFixture): unknown {
  if (fixture.ndjsonRecord === undefined) throw new Error("missing NDJSON record fixture");
  return reportAdminExportRecordSchema.parse(fixture.ndjsonRecord);
}
