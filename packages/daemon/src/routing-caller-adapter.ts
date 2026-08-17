import {
  createRouteDecision,
  createRoutingFacts,
  evaluateRoutingRule,
  type LocalLabel,
  type RoutingRule,
} from "@agent-mail/core";
import type { PromotionRoutingDecision } from "../../storage/src/canonical-promotion";
import type { RoutingOriginCallerSource } from "../../storage/src/routing-decision-origin";
import type { SingleMessageRoutingInput } from "./single-message-ingestion";

/** The two callers share one evaluator; this marker is persisted origin metadata. */
export type RoutingCaller = RoutingOriginCallerSource;

export type CanonicalRoutingAdapter = (
  input: SingleMessageRoutingInput & Readonly<{ readonly caller: RoutingCaller }>,
) => readonly PromotionRoutingDecision[];

export type CanonicalRoutingAdapterOptions = Readonly<{
  readonly rule: RoutingRule;
  readonly label: LocalLabel;
}>;

function routingFacts(input: SingleMessageRoutingInput): Readonly<{
  readonly senderAddrSpec: string | null;
  readonly listId: string | null;
}> {
  const sender = input.parsed.addresses.find(
    (address) => (address.role === "from" || address.role === "sender") && address.address !== null,
  )?.address;
  const listId = input.parsed.headers.find(
    (header) => header.normalizedName === "list-id",
  )?.normalizedValue;
  return createRoutingFacts({ senderAddrSpec: sender ?? null, listId: listId ?? null });
}

/**
 * Build the one canonical routing decision used by both ingestion callers.
 * The caller marker is persisted as an origin beside the non-authoritative
 * PromotionRoutingDecision envelope. Canonical storage derives identity from
 * the decision's message, rule, version, and matched facts.
 */
export function createCanonicalRoutingAdapter(
  options: CanonicalRoutingAdapterOptions,
): CanonicalRoutingAdapter {
  return (input) => {
    const evaluation = evaluateRoutingRule(options.rule, routingFacts(input));
    if (!evaluation.matched) return [];

    const decision = createRouteDecision({
      kind: "route",
      ruleId: evaluation.ruleId,
      ruleVersion: evaluation.ruleVersion,
      matchedFacts: evaluation.matchedFacts,
      decidedAt: input.internalDate,
      provenance: {
        source: "canonical-routing-v1",
        evaluationId: `${input.messageId}:${evaluation.ruleId}:${evaluation.ruleVersion}`,
      },
      label: options.label,
    });
    return [
      {
        // This field is caller metadata. canonical-promotion replaces it with
        // canonicalRoutingDecisionId before writing the durable decision row.
        decisionId: `${input.caller}:${input.messageId}:${evaluation.ruleId}:${evaluation.ruleVersion}`,
        decision,
        origins: [
          {
            callerSource: input.caller,
            observedAt: input.occurredAt,
            evaluationId: `${input.messageId}:${evaluation.ruleId}:${evaluation.ruleVersion}`,
          },
        ],
      },
    ];
  };
}
