import { createHash } from "node:crypto";
import type { MessageId, RoutingDecision } from "@agent-mail/core";

/**
 * Derive the durable routing-decision identity from only canonical decision
 * facts. Caller ids, provenance, labels, and timestamps are not identity.
 */
export function canonicalRoutingDecisionId(
  messageId: MessageId,
  decision: RoutingDecision,
): string {
  const identity = [
    messageId,
    decision.ruleId,
    String(decision.ruleVersion),
    JSON.stringify(decision.matchedFacts),
  ].join("\u0000");
  return `decision:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}
