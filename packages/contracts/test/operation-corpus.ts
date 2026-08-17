import {
  publicCliOperations,
  type CliCommandDefinition,
} from "../../cli/src/command-registry";
import {
  reportAdminExportRecordSchema,
  streamMetadataSchema,
  type OperationDefinition,
  type OperationSchema,
} from "../src/index";

/** A fixture for one registered public error branch of an operation response. */
export type OperationErrorFixture = Readonly<{
  readonly code: string;
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
  readonly success: unknown;
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

const messageId = `message:réunion-${longSuffix}`;
const threadId = "thread:thread-例";
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
const completedPlan = {
  state: "completed" as const,
  ...actionPlanBase,
  completedAt: laterInstant,
};
const successfulAttemptResult = {
  kind: "success" as const,
  planId: actionPlanBase.planId,
  action,
  target: actionTarget,
  attemptId: "attempt:attempt-例",
  idempotencyKey: "idempotency:plan-例",
  startedAt: instant,
  resultAt: laterInstant,
  certainty: "definite" as const,
  postcondition: {
    kind: "flags" as const,
    observedAt: laterInstant,
    flags: ["\\Seen"],
    modseq: maximumSafeInteger,
  },
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
    errors: [],
  },
  "messages.get": {
    request: { messageId },
    success: { message: hydratedMessage },
    errors: [{ code: "not_found", response: notFound("message", messageId) }],
  },
  "threads.get": {
    request: { threadId },
    success: {
      thread: {
        threadId,
        subject: "Réunion — résumé 例",
        participants: [sender],
        messageIds: [messageId],
        messages: [hydratedMessage],
        firstReceivedAt: retrievalBefore,
        lastReceivedAt: retrievalBefore,
      },
    },
    errors: [{ code: "not_found", response: notFound("thread", threadId) }],
  },
  "messages.raw": {
    request: { messageId },
    success: streamMetadata,
    errors: [{ code: "not_found", response: notFound("raw-message", messageId) }],
    stream: { metadata: streamMetadata },
  },
  "attachments.get": {
    request: { attachmentId },
    success: {
      attachmentId,
      messageId,
      metadata: streamMetadata,
    },
    errors: [{ code: "not_found", response: notFound("attachment", attachmentId) }],
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
    errors: [],
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
    success: { plan: pendingPlan, digest },
    errors: [],
  },
  "action-plans.inspect": {
    request: { planId: pendingPlan.planId },
    success: { plan: pendingPlan, results: [] },
    errors: [],
  },
  "action-plans.authorize": {
    request: { planId: pendingPlan.planId, digest, intent: "Mark the selected message as read — 例" },
    success: { plan: pendingPlan, authorizationId: "authorization:authorization-例", authorizedAt: instant },
    errors: [],
  },
  "action-plans.commit": {
    request: {
      planId: completedPlan.planId,
      digest,
      authorizationId: "authorization:authorization-例",
    },
    success: { plan: completedPlan, results: [successfulAttemptResult] },
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
    success: { version: 1, contentType: "application/x-ndjson", recordVersion: 1, selectedCount: 1 },
    errors: [],
    stream: {
      metadata: { contentType: "application/x-ndjson", contentLength: 256, digest, filename: "export.ndjson" },
      ndjsonRecord: {
        version: 1,
        messageId,
        attribution: { sourceMessageId: messageId, source: "message" as const, occurrence: null },
        actionHistory: [],
        contentDigest: digest,
      },
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
    success: { accepted: true, commandId: "command:start-例", observed: { actorState: "starting" as const, version: maximumSafeInteger } },
    errors: [],
  },
  "sync.pause": {
    request: { idempotencyKey: "idempotency:pause-例" },
    success: { accepted: true, commandId: "command:pause-例", observed: { actorState: "paused" as const, version: maximumSafeInteger } },
    errors: [],
  },
  "sync.resume": {
    request: { idempotencyKey: "idempotency:resume-例" },
    success: { accepted: true, commandId: "command:resume-例", completed: true, observed: { actorState: "watching" as const, version: maximumSafeInteger } },
    errors: [],
  },
  "sync.stop": {
    request: { idempotencyKey: "idempotency:stop-例" },
    success: { accepted: true, commandId: "command:stop-例", observed: { actorState: "stopped" as const, version: maximumSafeInteger } },
    errors: [],
  },
};

/** The corpus is keyed from the exact CLI registry, so stale entries cannot hide drift. */
export const operationCorpus: OperationCorpus = Object.freeze(corpusEntries);

/** Applicability is explicit: no operation receives an invented error fixture. */
export const registeredPublicErrorApplicability: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      publicCliOperations.map((operation) => [
        operation.key,
        operation.key === "messages.get" ||
          operation.key === "threads.get" ||
          operation.key === "messages.raw" ||
          operation.key === "attachments.get"
          ? ["not_found"]
          : [],
      ]),
    ),
  );

/**
 * Check only corpus shape and registry coverage. This intentionally does not parse fixtures;
 * callers can prove this gate runs before any round-trip assertion.
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
  const extra = actualKeys.filter((key) => !expectedSet.has(key));
  if (extra.length > 0) throw new Error(`operation corpus has unknown operation: ${extra.join(", ")}`);
  for (const operation of operations) {
    const entry = corpus[operation.key];
    if (entry === undefined) throw new Error(`operation ${operation.key} has no corpus entry`);
    if (entry.request === undefined) throw new Error(`operation ${operation.key} missing request fixture`);
    if (entry.success === undefined) throw new Error(`operation ${operation.key} missing success fixture`);
    if (!Array.isArray(entry.errors)) throw new Error(`operation ${operation.key} missing error applicability`);
    const expectedErrors = registeredPublicErrorApplicability[operation.key] ?? [];
    const actualErrors = entry.errors.map(({ code }) => code);
    if (new Set(actualErrors).size !== actualErrors.length)
      throw new Error(`operation ${operation.key} has duplicate error fixtures`);
    if (JSON.stringify([...actualErrors].sort()) !== JSON.stringify([...expectedErrors].sort()))
      throw new Error(`operation ${operation.key} has incorrect applicable error fixtures`);
    if (operation.streaming !== "none" && entry.stream === undefined)
      throw new Error(`operation ${operation.key} missing ${operation.streaming} stream metadata fixture`);
    if (operation.streaming === "none" && entry.stream !== undefined)
      throw new Error(`operation ${operation.key} has an inapplicable stream fixture`);
    if (operation.streaming === "ndjson" && entry.stream?.ndjsonRecord === undefined)
      throw new Error(`operation ${operation.key} missing NDJSON record fixture`);
  }
}

/** The CLI registry itself is the source of truth for this corpus. */
export const corpusOperations: readonly CliCommandDefinition[] = publicCliOperations.map((operation) =>
  ({
    path: operation.cliName.split("-") as [string, ...string[]],
    operationKey: operation.key,
    scope: operation.scope,
    streaming: operation.streaming,
    operation,
  }) satisfies CliCommandDefinition,
);

/** Parse a stream header using the same shared stream metadata schema. */
export function parseStreamMetadata(fixture: OperationStreamFixture): unknown {
  return streamMetadataSchema.parse(fixture.metadata);
}

/** Parse an NDJSON item using the same shared export record schema. */
export function parseNdjsonRecord(fixture: OperationStreamFixture): unknown {
  if (fixture.ndjsonRecord === undefined) throw new Error("missing NDJSON record fixture");
  return reportAdminExportRecordSchema.parse(fixture.ndjsonRecord);
}
