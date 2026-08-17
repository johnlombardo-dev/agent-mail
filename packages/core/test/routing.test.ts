import { describe, expect, it } from "bun:test";
import {
  createDigestMembershipDecision,
  createLocalLabel,
  createRouteDecision,
  createRoutingDecision,
  createSuppressionDecision,
  parseRoutingDecision,
  serializeRoutingDecision,
} from "../src/routing";
import { createMailboxId } from "../src/identifiers";

const metadata = {
  ruleId: "rule:inbox-cleanup",
  ruleVersion: 2,
  matchedFacts: [{ field: "subject", value: "invoice" }],
  decidedAt: "2026-08-18T00:00:00.000Z",
  provenance: { source: "local-rule-engine", evaluationId: "eval:123" },
} as const;

describe("local routing algebra", () => {
  it("constructs and round-trips each decision variant", () => {
    const decisions = [
      createRouteDecision({
        ...metadata,
        kind: "route",
        label: "label:finance",
      }),
      createSuppressionDecision({
        ...metadata,
        kind: "suppress",
        reason: "duplicate",
      }),
      createDigestMembershipDecision({
        ...metadata,
        kind: "digest-membership",
        digestId: "digest:weekly",
        included: true,
      }),
    ];
    expect(decisions.map((decision) => decision.kind)).toEqual([
      "route",
      "suppress",
      "digest-membership",
    ]);
    for (const decision of decisions) {
      expect(parseRoutingDecision(serializeRoutingDecision(decision))).toEqual(decision);
    }
  });

  it("requires complete provenance and canonical match facts", () => {
    expect(() =>
      createRoutingDecision({
        ...metadata,
        kind: "route",
        label: "label:finance",
        provenance: undefined,
      }),
    ).toThrow();
    expect(() =>
      createRoutingDecision({
        ...metadata,
        kind: "route",
        label: "label:finance",
        ruleVersion: undefined,
      }),
    ).toThrow();
    expect(() =>
      createRoutingDecision({
        ...metadata,
        kind: "route",
        label: "label:finance",
        matchedFacts: undefined,
      }),
    ).toThrow();
    expect(() =>
      createRoutingDecision({
        ...metadata,
        kind: "route",
        label: "label:finance",
        matchedFacts: [],
      }),
    ).toThrow();
    expect(() =>
      createRoutingDecision({
        ...metadata,
        kind: "route",
        label: "label:finance",
        decidedAt: undefined,
      }),
    ).toThrow();
    expect(() =>
      createRoutingDecision({
        ...metadata,
        kind: "route",
        label: "label:finance",
        matchedFacts: [metadata.matchedFacts[0], { field: "a", value: "a" }],
      }),
    ).toThrow();
  });

  it("keeps local labels distinct from remote mailbox placement", () => {
    const archiveMailbox = createMailboxId("Archive");
    expect(() => createLocalLabel(archiveMailbox)).toThrow();
    expect(createLocalLabel("label:archive")).toBe("label:archive");
    expect(() =>
      createRoutingDecision(
        Object.assign(Object.create({}), {
          ...metadata,
          kind: "route",
          label: "label:finance",
        }),
      ),
    ).toThrow();
  });
});
