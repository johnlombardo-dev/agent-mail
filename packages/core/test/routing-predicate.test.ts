import { describe, expect, it } from "bun:test";
import {
  createRoutingFacts,
  createRoutingRule,
  evaluateRoutingRule,
  normalizeListIdIdentifier,
  normalizeSenderAddrSpec,
  parseRoutingRule,
  serializeRoutingRule,
} from "../src/routing-predicate";

const senderRule = {
  version: 1,
  ruleId: "rule:sender",
  ruleVersion: 3,
  predicate: { kind: "exactSender", sender: "alice@example.com" },
} as const;

const listRule = {
  version: 1,
  ruleId: "rule:list",
  ruleVersion: 4,
  predicate: { kind: "exactListId", listId: "weekly.example.com" },
} as const;

describe("versioned exact routing predicates", () => {
  it("normalizes sender addr-specs while ignoring display names and comments", () => {
    expect(normalizeSenderAddrSpec("Alice Example (billing) <ALICE@EXAMPLE.COM>")).toBe(
      "alice@example.com",
    );
    expect(normalizeSenderAddrSpec("A\\lice <aLiCe@ExAmPlE.CoM> (sender)")).toBe(
      "alice@example.com",
    );

    expect(
      evaluateRoutingRule(senderRule, {
        senderAddrSpec: "Alice Example <ALICE@EXAMPLE.COM>",
        listId: null,
      }),
    ).toMatchObject({
      matched: true,
      matchedFacts: [{ field: "sender-addr-spec", value: "alice@example.com" }],
    });
  });

  it("uses NFC and IDNA canonicalization without collapsing lookalikes", () => {
    expect(normalizeSenderAddrSpec("JÖHN@bücher.example")).toBe("jöhn@xn--bcher-kva.example");
    expect(
      evaluateRoutingRule(
        {
          ...senderRule,
          ruleId: "rule:unicode",
          predicate: { kind: "exactSender", sender: "Jöhn@XN--BCHER-KVA.example" },
        },
        {
          senderAddrSpec: "Display Name <jÖHN@bücher.example>",
          listId: null,
        },
      ).matched,
    ).toBe(true);

    expect(
      evaluateRoutingRule(senderRule, {
        senderAddrSpec: "alice@exampΙe.com",
        listId: null,
      }).matched,
    ).toBe(false);
  });

  it("parses the List-ID identifier rather than its display description", () => {
    expect(normalizeListIdIdentifier("Weekly Reports <weekly.example.com>")).toBe(
      "weekly.example.com",
    );
    expect(
      evaluateRoutingRule(listRule, {
        senderAddrSpec: null,
        listId: "Weekly Reports <WEEKLY.EXAMPLE.COM>",
      }),
    ).toMatchObject({
      matched: true,
      matchedFacts: [{ field: "list-id", value: "weekly.example.com" }],
    });
    expect(() =>
      evaluateRoutingRule(listRule, {
        senderAddrSpec: null,
        listId: "Different description",
      }),
    ).toThrow();
  });

  it("does not use substring or arbitrary predicate matching", () => {
    expect(
      evaluateRoutingRule(senderRule, {
        senderAddrSpec: "notalice@example.com",
        listId: null,
      }).matched,
    ).toBe(false);
    expect(
      evaluateRoutingRule(listRule, {
        senderAddrSpec: null,
        listId: "weekly.example.com.evil.example",
      }).matched,
    ).toBe(false);
    expect(() =>
      createRoutingRule({
        ...senderRule,
        predicate: { kind: "regex", pattern: ".*" },
      }),
    ).toThrow();
  });

  it("rejects malformed, ambiguous, and unvalidated external values", () => {
    for (const sender of [
      "alice",
      "alice@@example.com",
      "Alice <alice@example.com>, Bob <b@example.com>",
      "<alice@example.com",
    ]) {
      expect(() => normalizeSenderAddrSpec(sender)).toThrow();
    }
    for (const listId of ["Friendly List", "<>", "one <weekly.example.com> trailing"]) {
      expect(() => normalizeListIdIdentifier(listId)).toThrow();
    }
    expect(() =>
      createRoutingFacts({ senderAddrSpec: "alice@example.com", listId: null, extra: true }),
    ).toThrow();
    expect(() => createRoutingRule({ ...senderRule, version: 2 })).toThrow();
  });

  it("round-trips only canonical rule serialization", () => {
    const rule = createRoutingRule({
      ...senderRule,
      predicate: { kind: "exactSender", sender: "ALICE@EXAMPLE.COM" },
    });
    const serialized = serializeRoutingRule(rule);
    expect(parseRoutingRule(serialized)).toEqual(rule);
    expect(() =>
      parseRoutingRule(serialized.replace("alice@example.com", "ALICE@EXAMPLE.COM")),
    ).toThrow();
  });
});
