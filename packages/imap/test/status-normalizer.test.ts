import { describe, expect, test } from "bun:test";
import {
  ImapAdapterError,
  normalizeImapCapabilities,
  normalizeImapResponse,
  normalizeMailboxStatus,
  normalizeProtocolError,
} from "../src/status-normalizer";
import {
  runAdapterContractParity,
  type AdapterContractSuite,
  type AdapterFactoryInput,
} from "../../../tests/adapter-contracts/harness";
import fixtures from "./fixtures/status-normalizer-production-labeled.json";

type CapturedResponse = {
  readonly capabilities?: unknown;
  readonly mailbox: unknown;
};

const complete = fixtures.complete as CapturedResponse;
const partial = fixtures.partial as CapturedResponse;
const capabilityAbsent = fixtures.capabilityAbsent as CapturedResponse;

describe("captured ImapFlow capability and mailbox-status normalization", () => {
  test("normalizes a complete response into validated domain facts", () => {
    const result = normalizeImapResponse(complete);
    expect(result.capabilities.specialUse).toEqual({ kind: "known", value: true });
    expect(result.capabilities.idle).toEqual({ kind: "known", value: true });
    expect(result.mailbox.uidValidity).toEqual({ kind: "known", value: 938475 });
    expect(result.mailbox.uidNext).toEqual({ kind: "known", value: 1201 });
    expect(result.mailbox.highestModseq).toEqual({ kind: "known", value: 884422 });
    expect(result.mailbox.selectability).toEqual({ kind: "known", value: true });
    expect(result.mailbox.specialUseFlags).toEqual({
      kind: "known",
      value: ["\\All", "\\Inbox"],
    });
  });

  test("keeps partial fields unknown and unsupported separately", () => {
    const result = normalizeImapResponse(partial);
    expect(result.capabilities.specialUse).toEqual({
      kind: "unsupported",
      reason: "SPECIAL-USE is not advertised",
    });
    expect(result.capabilities.idle).toEqual({ kind: "known", value: true });
    expect(result.mailbox.uidNext).toEqual({ kind: "unknown" });
    expect(result.mailbox.highestModseq).toEqual({ kind: "unknown" });
    expect(result.mailbox.selectability).toEqual({ kind: "known", value: false });
    expect(result.mailbox.specialUseFlags).toEqual({
      kind: "unsupported",
      reason: "SPECIAL-USE flags are not exposed",
    });
  });

  test("capability absence is unknown, not fabricated support", () => {
    const result = normalizeImapResponse(capabilityAbsent);
    expect(result.capabilities.names).toEqual([]);
    expect(result.capabilities.idle).toEqual({ kind: "unknown" });
    expect(result.capabilities.specialUse).toEqual({ kind: "unknown" });
    expect(result.mailbox.uidNext).toEqual({ kind: "unknown" });
    expect(result.mailbox.highestModseq).toEqual({ kind: "known", value: 0 });
  });

  test("the adjacent counterexample never turns absent UIDNEXT into zero", () => {
    const result = normalizeMailboxStatus({ uidValidity: 10 });
    expect(result.uidNext).toEqual({ kind: "unknown" });
    expect(result.uidNext).not.toEqual({ kind: "known", value: 0 });
    expect(normalizeMailboxStatus({ uidNext: "unsupported" }).uidNext).toEqual({
      kind: "unsupported",
      reason: "UIDNEXT is not supported",
    });
  });

  test("rejects malformed UID, MODSEQ, and status types with stable adapter errors", () => {
    const cases: readonly [unknown, string][] = [
      [{ uidValidity: 0 }, "invalid-uid"],
      [{ uidNext: "1201" }, "invalid-uid"],
      [{ uidNext: 1201, uidnext: 1202 }, "invalid-uid"],
      [{ highestModseq: -1 }, "invalid-modseq"],
      [{ flags: ["\\Inbox", 42] }, "invalid-selectability"],
      [null, "invalid-mailbox-status"],
    ];
    for (const [input, code] of cases) {
      try {
        normalizeMailboxStatus(input);
        throw new Error("expected normalization to reject");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ImapAdapterError);
        expect((error as ImapAdapterError).code).toBe(code);
        expect((error as Error).message).not.toContain("1201");
      }
    }
  });

  test("retains safe protocol metadata without credentials or raw payloads", () => {
    expect(
      normalizeProtocolError({
        category: "authentication",
        response: {
          code: "AUTHENTICATIONFAILED",
          condition: "NO",
          text: "password=do-not-retain",
        },
        message: "raw mail body must not be retained",
      }),
    ).toEqual({
      category: "authentication",
      serverResponse: { code: "AUTHENTICATIONFAILED", condition: "NO" },
    });
  });
});

const contractSuite: AdapterContractSuite<Readonly<Record<string, CapturedResponse>>> = {
  name: "captured ImapFlow capability/status normalization",
  cases: [
    {
      id: "complete-captured-response",
      run: (adapter) => {
        expect(normalizeImapResponse(adapter.complete).mailbox.uidNext).toEqual({
          kind: "known",
          value: 1201,
        });
      },
    },
    {
      id: "partial-captured-response",
      run: (adapter) => {
        expect(normalizeImapResponse(adapter.partial).mailbox.uidNext).toEqual({ kind: "unknown" });
      },
    },
    {
      id: "capability-absent-captured-response",
      productionRequired: true,
      run: (adapter) => {
        expect(normalizeImapResponse(adapter.capabilityAbsent).capabilities.idle).toEqual({
          kind: "unknown",
        });
      },
    },
  ],
};

function fixtureAdapter(): Readonly<Record<string, CapturedResponse>> {
  return { complete, partial, capabilityAbsent };
}

const fixtureFactory: Omit<
  AdapterFactoryInput<Readonly<Record<string, CapturedResponse>>>,
  "kind"
> = {
  factory: fixtureAdapter,
  capabilities: [],
  retainedEvidencePath: "evidence/adapter-contracts/imap-status-production-labeled.jsonl",
};

test("runs the captured corpus through the accepted production-labeled adapter harness", async () => {
  const evidence = await runAdapterContractParity({
    suite: contractSuite,
    fake: fixtureFactory,
  });
  expect(evidence.productionEvidence).toEqual({
    status: "gap",
    adapterKind: "production",
    reason: "production-factory-not-provided",
  });
  expect(evidence.semanticParity.status).toBe("not-established");
  expect(evidence.fake.passedCases).toEqual(contractSuite.cases.slice(0, 2).map((item) => item.id));
  expect(evidence.fake.productionRequiredGaps).toHaveLength(1);
});

test("normalizes capability maps and arrays with the same semantics", () => {
  expect(normalizeImapCapabilities(new Map([["idle", true]])).idle).toEqual({
    kind: "known",
    value: true,
  });
  expect(normalizeImapCapabilities(["SPECIAL-USE"]).specialUse).toEqual({
    kind: "known",
    value: true,
  });
  expect(() => normalizeImapCapabilities([" "])).toThrow("must not be blank");
});
