import { describe, expect, test } from "bun:test";
import {
  runAdapterContract,
  runAdapterContractParity,
  type AdapterContractSuite,
  type AdapterFactoryInput,
} from "./harness";

interface IllustrativeAdapter {
  readonly read: (key: string) => Promise<string | undefined>;
}

function createIllustrativeFixture(): IllustrativeAdapter {
  return {
    read: async (key: string) => (key === "answer" ? "42" : undefined),
  };
}

const illustrativeSuite: AdapterContractSuite<IllustrativeAdapter> = {
  name: "illustrative adapter behavior",
  cases: [
    {
      id: "reads-a-value",
      requires: ["read"],
      run: async (adapter) => {
        expect(await adapter.read("answer")).toBe("42");
      },
    },
    {
      id: "production-required-read",
      requires: ["read"],
      productionRequired: true,
      run: async (adapter) => {
        expect(await adapter.read("answer")).toBe("42");
      },
    },
    {
      id: "unsupported-capability-is-skipped",
      requires: ["optional-ordering"],
      run: async () => {
        throw new Error("This case must not run when its capability is absent.");
      },
    },
  ],
};

const fake: Omit<AdapterFactoryInput<IllustrativeAdapter>, "kind"> = {
  factory: () => createIllustrativeFixture(),
  capabilities: [
    { name: "read", status: "available" },
    {
      name: "optional-ordering",
      status: "unavailable",
      reason: "Fixture does not model ordering.",
    },
  ],
  retainedEvidencePath: "evidence/adapter-contracts/fake.jsonl",
};

const productionLabeledFixture: Omit<AdapterFactoryInput<IllustrativeAdapter>, "kind"> = {
  // This remains an in-memory fixture. The explicit label only controls the evidence slot.
  factory: () => createIllustrativeFixture(),
  capabilities: [
    { name: "read", status: "available" },
    {
      name: "optional-ordering",
      status: "unavailable",
      reason: "Illustrative fixture omits this capability.",
    },
  ],
  retainedEvidencePath: "evidence/adapter-contracts/production-labeled.jsonl",
};

describe("adapter contract harness", () => {
  test("retains separate fake and production-labeled results with semantic parity", async () => {
    const evidence = await runAdapterContractParity({
      suite: illustrativeSuite,
      fake,
      production: productionLabeledFixture,
    });

    expect(evidence.fake.adapterKind).toBe("fake");
    expect(evidence.fake.retainedEvidencePath).toBe("evidence/adapter-contracts/fake.jsonl");
    expect(evidence.fake.status).toBe("incomplete");
    expect(evidence.productionEvidence.status).toBe("available");
    expect(evidence.production?.adapterKind).toBe("production");
    expect(evidence.production?.retainedEvidencePath).toBe(
      "evidence/adapter-contracts/production-labeled.jsonl",
    );
    expect(evidence.semanticParity.status).toBe("matched");

    const fakeProductionCase = evidence.fake.caseResults.find(
      (result) => result.caseId === "production-required-read",
    );
    expect(fakeProductionCase?.kind).toBe("production-gap");
    expect(evidence.fake.passedCases).not.toContain("production-required-read");
    expect(evidence.fake.productionRequiredGaps).toEqual([
      {
        caseId: "production-required-read",
        observed: "passed",
        reason: "A fake adapter cannot satisfy production-required evidence.",
      },
    ]);
  });

  test("reports a production-required gap when the production factory is omitted", async () => {
    const evidence = await runAdapterContractParity({ suite: illustrativeSuite, fake });

    expect(evidence.production).toBeNull();
    expect(evidence.productionEvidence).toEqual({
      status: "gap",
      adapterKind: "production",
      reason: "production-factory-not-provided",
    });
    expect(evidence.semanticParity.status).toBe("not-established");
    expect(evidence.fake.caseResults.some((result) => result.kind === "production-gap")).toBe(true);
  });

  test("distinguishes skipped capabilities from passes and failures", async () => {
    const evidence = await runAdapterContract({
      suite: illustrativeSuite,
      ...fake,
      kind: "fake",
    });
    const skipped = evidence.caseResults.find(
      (result) => result.caseId === "unsupported-capability-is-skipped",
    );

    expect(skipped?.kind).toBe("skipped");
    expect(evidence.skippedCases).toEqual(["unsupported-capability-is-skipped"]);
    expect(evidence.skippedCapabilities).toEqual([
      {
        caseId: "unsupported-capability-is-skipped",
        capabilities: ["optional-ordering"],
        reason: "optional-ordering: Fixture does not model ordering.",
      },
    ]);
    expect(evidence.passedCases).toEqual(["reads-a-value"]);
    expect(evidence.failedCases).toEqual([]);
  });

  test("propagates a thrown contract case into the adapter result", async () => {
    const evidence = await runAdapterContract({
      suite: {
        name: "failure propagation",
        cases: [
          {
            id: "throws",
            run: () => {
              throw new Error("fixture failure");
            },
          },
        ],
      },
      factory: () => createIllustrativeFixture(),
      kind: "fake",
      capabilities: [],
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.executedCases).toEqual(["throws"]);
    expect(evidence.failedCases).toEqual(["throws"]);
    expect(evidence.caseResults).toEqual([
      {
        kind: "failed",
        caseId: "throws",
        failure: { name: "Error", message: "fixture failure" },
      },
    ]);
  });
});
