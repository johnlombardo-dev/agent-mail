import { describe, expect, it } from "bun:test";
import {
  CommittedDecisionSchema,
  LabelResponseSchema,
  LocalLabelSchema,
  RoutingCommitResponseSchema,
  RoutingPreviewSchema,
  RoutingRuleSchema,
  labelOperation,
  routingCommitOperation,
  routingOperationDefinitions,
  routingPreviewOperation,
} from "../src/routing-operations";

const rule = {
  version: 1,
  ruleId: "rule:finance",
  ruleVersion: 3,
  predicate: { kind: "exactSender", sender: "billing@example.com" },
} as const;

const provenance = { source: "local-rule-engine", evaluationId: "eval:123" } as const;
const preview = {
  authority: "server",
  previewId: "preview:2026-08-18T00:00:00Z",
  rule,
  candidateTargets: [
    { kind: "local-label", messageId: "message:one", label: "label:finance" },
    {
      kind: "remote-placement",
      messageId: "message:two",
      placementId: "placement:two-inbox",
      mailboxId: "mailbox:inbox",
    },
  ],
  createdAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T00:30:00.000Z",
  nonce: "nonce:one-time",
  digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  provenance,
} as const;

const decision = {
  authority: "server",
  decisionId: "decision:one",
  committed: true,
  dryRun: false,
  previewId: preview.previewId,
  previewDigest: preview.digest,
  decision: {
    kind: "route",
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    matchedFacts: [{ field: "sender-addr-spec", value: "billing@example.com" }],
    decidedAt: "2026-08-18T00:01:00.000Z",
    provenance,
    label: "label:finance",
  },
  committedAt: "2026-08-18T00:01:00.000Z",
  provenance,
} as const;

describe("routing and label operation contracts", () => {
  it("round-trips an authoritative preview and its committed decision", () => {
    const parsedPreview = RoutingPreviewSchema.parse(preview);
    const parsedDecision = CommittedDecisionSchema.parse(decision);

    expect(parsedPreview).toEqual(preview);
    expect(parsedDecision).toEqual(decision);
    expect(Object.isFrozen(parsedPreview)).toBe(true);
    expect(Object.isFrozen(parsedPreview.candidateTargets)).toBe(true);
    expect(parsedDecision.previewId).toBe(parsedPreview.previewId);
    expect(parsedDecision.previewDigest).toBe(parsedPreview.digest);
    expect(parsedDecision.provenance).toEqual(parsedPreview.provenance);
  });

  it("rejects committed success without durable identity or with dry-run", () => {
    expect(() =>
      RoutingCommitResponseSchema.parse({
        ...decision,
        decisionId: undefined,
      }),
    ).toThrow();
    expect(() => RoutingCommitResponseSchema.parse({ ...decision, dryRun: true })).toThrow();
    expect(() =>
      RoutingCommitResponseSchema.parse({
        authority: "server",
        committed: false,
        dryRun: false,
        decisionId: null,
        previewId: preview.previewId,
        previewDigest: preview.digest,
        decision: null,
      }),
    ).toThrow();
    expect(() =>
      RoutingCommitResponseSchema.parse({
        ...decision,
        committed: false,
        decisionId: "decision:forged",
        decision: null,
      }),
    ).toThrow();
  });

  it("keeps local labels and remote placement targets structurally distinct", () => {
    expect(LocalLabelSchema.parse("label:finance")).toBe("label:finance");
    expect(() => LocalLabelSchema.parse("mailbox:archive")).toThrow();
    expect(() =>
      RoutingPreviewSchema.parse({
        ...preview,
        candidateTargets: [
          { kind: "local-label", messageId: "message:one", label: "mailbox:archive" },
        ],
      }),
    ).toThrow();
    expect(() =>
      RoutingPreviewSchema.parse({
        ...preview,
        candidateTargets: [
          {
            kind: "remote-placement",
            messageId: "message:one",
            placementId: "placement:one",
            mailboxId: "label:archive",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects tampering, duplicate immutable targets, and unknown fields", () => {
    expect(() => RoutingPreviewSchema.parse({ ...preview, digest: "not-a-digest" })).toThrow();
    expect(() =>
      RoutingPreviewSchema.parse({
        ...preview,
        candidateTargets: [preview.candidateTargets[0], preview.candidateTargets[0]],
      }),
    ).toThrow();
    expect(() => RoutingRuleSchema.parse({ ...rule, extra: true })).toThrow();
    expect(() =>
      RoutingPreviewSchema.parse({ ...preview, createdAt: "2026-08-18T00:00:00Z" }),
    ).toThrow();
  });

  it("defines strict shared operation identities for parent registry integration", () => {
    expect(routingOperationDefinitions).toEqual([
      routingPreviewOperation,
      routingCommitOperation,
      labelOperation,
    ]);
    expect(routingPreviewOperation.key).toBe("routing.preview");
    expect(routingCommitOperation.key).toBe("routing.commit");
    expect(labelOperation.key).toBe("messages.label");
    expect(
      LabelResponseSchema.parse({
        authority: "server",
        messageId: "message:one",
        label: "label:finance",
        decisionId: "decision:one",
        committed: true,
        dryRun: false,
        assignedAt: "2026-08-18T00:01:00.000Z",
        provenance,
      }),
    ).toEqual({
      authority: "server",
      messageId: "message:one",
      label: "label:finance",
      decisionId: "decision:one",
      committed: true,
      dryRun: false,
      assignedAt: "2026-08-18T00:01:00.000Z",
      provenance,
    });
  });
});
