import { z } from "zod";
import { defineError, type ErrorDefinition } from "./error-envelope";
import { defineOperation, type OperationDefinition } from "./operation-registry";

const SHA256 = /^[a-f0-9]{64}$/u;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function text(name: string, maximum: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, `${name} must be trimmed`)
    .refine((value) => !hasControlCharacters(value), `${name} has control characters`);
}

function namespaced(name: string, namespace: string, maximum = 256): z.ZodString {
  return text(name, maximum).regex(
    new RegExp(`^${namespace}:[^\\s:][^\\s]*$`, "u"),
    `${name} must use the ${namespace}: namespace`,
  );
}

/** Canonical identifiers used by the routing boundary. */
export const routingRuleIdSchema = namespaced("routing rule ID", "rule");
export const routingPreviewIdSchema = namespaced("routing preview ID", "preview");
export const routingDecisionIdSchema = namespaced("routing decision ID", "decision");
export const messageIdSchema = namespaced("message ID", "message");
export const placementIdSchema = namespaced("placement ID", "placement");
export const mailboxIdSchema = namespaced("mailbox ID", "mailbox");
export const digestIdSchema = namespaced("digest ID", "digest");
export const localLabelSchema = namespaced("local label", "label");
export const labelSchema = localLabelSchema;
export const nonceSchema = namespaced("preview nonce", "nonce");
export const digestSchema = z
  .string()
  .regex(SHA256, "digest must be a lowercase SHA-256 hexadecimal value");
export const utcInstantSchema = text("UTC instant", 64).refine((value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}, "UTC instant must be a canonical millisecond UTC timestamp");

export type RoutingRuleId = z.infer<typeof routingRuleIdSchema>;
export type RoutingPreviewId = z.infer<typeof routingPreviewIdSchema>;
export type RoutingDecisionId = z.infer<typeof routingDecisionIdSchema>;
export type LocalLabel = z.infer<typeof localLabelSchema>;

const exactSenderPredicateSchema = z
  .strictObject({ kind: z.literal("exactSender"), sender: text("sender", 998) })
  .describe("exact sender predicate");
const exactListIdPredicateSchema = z
  .strictObject({ kind: z.literal("exactListId"), listId: text("List-ID", 998) })
  .describe("exact List-ID predicate");

export const routingPredicateSchema = z.discriminatedUnion("kind", [
  exactSenderPredicateSchema,
  exactListIdPredicateSchema,
]);

/** Versioned, normalized rule data shared by preview and committed records. */
export const routingRuleSchema = z.strictObject({
  version: z.literal(1),
  ruleId: routingRuleIdSchema,
  ruleVersion: z.number().int().positive().safe(),
  predicate: routingPredicateSchema,
});

export const routingProvenanceSchema = z.strictObject({
  source: text("provenance source", 256),
  evaluationId: text("evaluation ID", 256),
});

const routingMatchFactSchema = z.strictObject({
  field: text("match fact field", 128),
  value: text("match fact value", 2_048),
});

export const routingMatchFactsSchema = z
  .array(routingMatchFactSchema)
  .min(1)
  .superRefine((facts, context) => {
    for (let index = 1; index < facts.length; index += 1) {
      const previous = facts[index - 1];
      const current = facts[index];
      if (previous === undefined || current === undefined) continue;
      const previousKey = `${previous.field}\u0000${previous.value}`;
      const currentKey = `${current.field}\u0000${current.value}`;
      if (currentKey <= previousKey) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "match facts must be unique and in canonical order",
        });
      }
    }
  });

const routingDecisionMetadataShape = {
  ruleId: routingRuleIdSchema,
  ruleVersion: z.number().int().positive().safe(),
  matchedFacts: routingMatchFactsSchema,
  decidedAt: utcInstantSchema,
  provenance: routingProvenanceSchema,
};

/** Local labels and remote placements are separate structural variants. */
export const localLabelTargetSchema = z.strictObject({
  kind: z.literal("local-label"),
  label: localLabelSchema,
});
export const remotePlacementTargetSchema = z.strictObject({
  kind: z.literal("remote-placement"),
  placementId: placementIdSchema,
  mailboxId: mailboxIdSchema,
});
export const routingTargetSchema = z.discriminatedUnion("kind", [
  localLabelTargetSchema,
  remotePlacementTargetSchema,
]);

export const routeDecisionSchema = z.strictObject({
  ...routingDecisionMetadataShape,
  kind: z.literal("route"),
  label: localLabelSchema,
});
export const suppressionDecisionSchema = z.strictObject({
  ...routingDecisionMetadataShape,
  kind: z.literal("suppress"),
  reason: text("suppression reason", 2_048),
});
export const digestMembershipDecisionSchema = z.strictObject({
  ...routingDecisionMetadataShape,
  kind: z.literal("digest-membership"),
  digestId: digestIdSchema,
  included: z.boolean(),
});

export const routingDecisionSchema = z.discriminatedUnion("kind", [
  routeDecisionSchema,
  suppressionDecisionSchema,
  digestMembershipDecisionSchema,
]);

export const suppressionSchema = suppressionDecisionSchema;
export const digestMembershipSchema = digestMembershipDecisionSchema;

const localCandidateTargetSchema = z.strictObject({
  kind: z.literal("local-label"),
  messageId: messageIdSchema,
  label: localLabelSchema,
});
const remoteCandidateTargetSchema = z.strictObject({
  kind: z.literal("remote-placement"),
  messageId: messageIdSchema,
  placementId: placementIdSchema,
  mailboxId: mailboxIdSchema,
});

/** A preview freezes the exact identities selected by the server. */
export const routingCandidateTargetSchema = z.discriminatedUnion("kind", [
  localCandidateTargetSchema,
  remoteCandidateTargetSchema,
]);

function targetIdentity(target: z.infer<typeof routingCandidateTargetSchema>): string {
  return target.kind === "local-label"
    ? `local\u0000${target.messageId}`
    : `remote\u0000${target.messageId}\u0000${target.placementId}`;
}

const uniqueCandidateTargetsSchema = z
  .array(routingCandidateTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    const identities = new Set<string>();
    targets.forEach((target, index) => {
      const identity = targetIdentity(target);
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "candidate targets must be unique",
        });
      }
      identities.add(identity);
    });
  });

const routingPreviewShape = {
  authority: z.literal("server"),
  previewId: routingPreviewIdSchema,
  rule: routingRuleSchema,
  candidateTargets: uniqueCandidateTargetsSchema,
  createdAt: utcInstantSchema,
  expiresAt: utcInstantSchema,
  nonce: nonceSchema,
  digest: digestSchema,
  provenance: routingProvenanceSchema,
};

function previewExpiryIsValid(
  preview: z.infer<z.ZodObject<typeof routingPreviewShape>>,
  context: z.RefinementCtx,
): void {
  if (Date.parse(preview.expiresAt) <= Date.parse(preview.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiry must be after creation",
    });
  }
}

/** Server-authoritative, immutable preview payload. */
export const routingPreviewSchema = z
  .strictObject(routingPreviewShape)
  .superRefine(previewExpiryIsValid)
  .transform((preview) => deepFreeze(preview));

export type RoutingPreview = z.infer<typeof routingPreviewSchema>;

const committedDecisionShape = {
  authority: z.literal("server"),
  decisionId: routingDecisionIdSchema,
  committed: z.literal(true),
  dryRun: z.literal(false),
  previewId: routingPreviewIdSchema,
  previewDigest: digestSchema,
  decision: routingDecisionSchema,
  committedAt: utcInstantSchema,
  provenance: routingProvenanceSchema,
};

/** A durable decision can only be represented as committed after persistence. */
export const committedDecisionSchema = z
  .strictObject(committedDecisionShape)
  .transform((decision) => deepFreeze(decision));
export type CommittedDecision = z.infer<typeof committedDecisionSchema>;

export const routingPreviewRequestSchema = z.strictObject({ rule: routingRuleSchema });
export const routingPreviewResponseSchema = routingPreviewSchema;

export const routingCommitRequestSchema = z.strictObject({
  previewId: routingPreviewIdSchema,
  digest: digestSchema,
  dryRun: z.boolean().default(false),
});

const uncommittedResponseSchema = z.strictObject({
  authority: z.literal("server"),
  committed: z.literal(false),
  dryRun: z.literal(true),
  decisionId: z.null(),
  previewId: routingPreviewIdSchema,
  previewDigest: digestSchema,
  decision: z.null(),
});

export const routingCommitResponseSchema = z.discriminatedUnion("committed", [
  committedDecisionSchema,
  uncommittedResponseSchema,
]);

/** Public correlation details for a routing commit authority conflict. */
export const routingPreviewIdentityErrorDetailsSchema = z.strictObject({
  previewId: z
    .string()
    .min(9)
    .max(256)
    .regex(/^preview:[^\s:][^\s]*$/u, "preview ID must use the preview: namespace")
    .refine((value) => !hasControlCharacters(value), "preview ID has control characters"),
});

export type RoutingPreviewIdentityErrorDetails = z.infer<
  typeof routingPreviewIdentityErrorDetailsSchema
>;

/** Operation-owned errors: these never become global HTTP error codes. */
export const routingCommitErrorDefinitions = [
  defineError({
    code: "routing.preview_replayed",
    status: 409,
    message: "routing preview was already consumed",
    details: routingPreviewIdentityErrorDetailsSchema,
  }),
  defineError({
    code: "routing.preview_expired",
    status: 409,
    message: "routing preview has expired",
    details: routingPreviewIdentityErrorDetailsSchema,
  }),
  defineError({
    code: "routing.preview_tampered",
    status: 409,
    message: "routing preview authority does not match",
    details: routingPreviewIdentityErrorDetailsSchema,
  }),
] as const satisfies readonly ErrorDefinition[];

export const RoutingCommitTerminalDispositionSchema = z.enum([
  "replayed",
  "expired",
  "tampered",
  "not-found",
]);
export type RoutingCommitTerminalDisposition = z.infer<
  typeof RoutingCommitTerminalDispositionSchema
>;

/** Strict service terminal algebra for non-success routing.commit outcomes. */
export const routingCommitTerminalSchema = z.discriminatedUnion("disposition", [
  z.strictObject({
    kind: z.literal("routing-commit-terminal"),
    disposition: z.enum(["replayed", "expired", "tampered"]),
    previewId: routingPreviewIdSchema,
  }),
  z.strictObject({
    kind: z.literal("routing-commit-terminal"),
    disposition: z.literal("not-found"),
  }),
]);
export type RoutingCommitTerminal = z.infer<typeof routingCommitTerminalSchema>;

export const labelRequestSchema = z.strictObject({
  messageId: messageIdSchema,
  label: localLabelSchema,
  provenance: routingProvenanceSchema,
  dryRun: z.boolean().default(false),
});

const labelAssignmentSchema = z.strictObject({
  authority: z.literal("server"),
  messageId: messageIdSchema,
  label: localLabelSchema,
  decisionId: routingDecisionIdSchema,
  committed: z.literal(true),
  dryRun: z.literal(false),
  assignedAt: utcInstantSchema,
  provenance: routingProvenanceSchema,
});
export const labelResponseSchema = z.discriminatedUnion("committed", [
  labelAssignmentSchema,
  z.strictObject({
    authority: z.literal("server"),
    messageId: messageIdSchema,
    label: localLabelSchema,
    decisionId: z.null(),
    committed: z.literal(false),
    dryRun: z.boolean(),
    assignedAt: z.null(),
    provenance: routingProvenanceSchema,
  }),
]);

export type RoutingPreviewRequest = z.infer<typeof routingPreviewRequestSchema>;
export type RoutingCommitRequest = z.infer<typeof routingCommitRequestSchema>;
export type LabelRequest = z.infer<typeof labelRequestSchema>;

export const routingPreviewOperation: OperationDefinition<
  typeof routingPreviewRequestSchema,
  typeof routingPreviewResponseSchema
> = defineOperation({
  key: "routing.preview",
  route: "/v1/routing/preview",
  method: "POST",
  cliName: "routing-preview",
  scope: "mail:routing:read",
  request: routingPreviewRequestSchema,
  response: routingPreviewResponseSchema,
  streaming: "none",
  strictness: "strict",
});

export const routingCommitOperation: OperationDefinition<
  typeof routingCommitRequestSchema,
  typeof routingCommitResponseSchema
> = defineOperation({
  key: "routing.commit",
  route: "/v1/routing/commit",
  method: "POST",
  cliName: "routing-commit",
  scope: "mail:routing:write",
  request: routingCommitRequestSchema,
  response: routingCommitResponseSchema,
  errors: routingCommitErrorDefinitions,
  streaming: "none",
  strictness: "strict",
});

export const labelOperation: OperationDefinition<
  typeof labelRequestSchema,
  typeof labelResponseSchema
> = defineOperation({
  key: "messages.label",
  route: "/v1/messages/{messageId}/label",
  method: "POST",
  cliName: "messages-label",
  scope: "mail:label:write",
  request: labelRequestSchema,
  response: labelResponseSchema,
  streaming: "none",
  strictness: "strict",
});

export const routingOperationDefinitions = [
  routingPreviewOperation,
  routingCommitOperation,
  labelOperation,
] as const;

export const routingPreviewOperationDefinition = routingPreviewOperation;
export const routingCommitOperationDefinition = routingCommitOperation;
export const labelOperationDefinition = labelOperation;
export const routingOperations = routingOperationDefinitions;

/** Freeze JSON-shaped output recursively so preview targets cannot be mutated by callers. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

// Capitalized aliases match the naming used by consumers that treat schemas as public types.
export const RoutingRuleSchema = routingRuleSchema;
export const RoutingPreviewSchema = routingPreviewSchema;
export const CommittedDecisionSchema = committedDecisionSchema;
export const RoutingDecisionSchema = routingDecisionSchema;
export const RoutingCandidateTargetSchema = routingCandidateTargetSchema;
export const LocalLabelSchema = localLabelSchema;
export const RemotePlacementTargetSchema = remotePlacementTargetSchema;
export const RoutingPreviewRequestSchema = routingPreviewRequestSchema;
export const RoutingPreviewResponseSchema = routingPreviewResponseSchema;
export const RoutingCommitRequestSchema = routingCommitRequestSchema;
export const RoutingCommitResponseSchema = routingCommitResponseSchema;
export const RoutingPreviewIdentityErrorDetailsSchema = routingPreviewIdentityErrorDetailsSchema;
export const RoutingCommitTerminalSchema = routingCommitTerminalSchema;
export const LabelRequestSchema = labelRequestSchema;
export const LabelResponseSchema = labelResponseSchema;
