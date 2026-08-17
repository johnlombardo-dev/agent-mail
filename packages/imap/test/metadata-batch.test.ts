import { describe, expect, test } from "bun:test";
import {
  createAccountId,
  createMailboxId,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import {
  createMetadataBatchAdapter,
  IMAP_METADATA_BATCH_QUERY,
  MAX_METADATA_ADDRESS_COUNT,
  MAX_METADATA_BATCH_UIDS,
  MAX_METADATA_FLAG_BYTES,
  MAX_METADATA_FLAG_COUNT,
  MAX_METADATA_TEXT_BYTES,
  parseMetadataBatchRequest,
  type ImapFlowMetadataBatchClient,
  type MetadataBatchRequest,
} from "../src/metadata-batch";
import {
  runAdapterContractParity,
  type AdapterContractSuite,
} from "../../../tests/adapter-contracts/harness";
import fixture from "./fixtures/metadata-batch-production-labeled.json";

const request: MetadataBatchRequest = {
  accountId: createAccountId("person@example.test"),
  mailboxId: createMailboxId("INBOX"),
  uidValidity: createUidValidity(77),
  uids: [2, 3, 4],
};

type FixtureRow = (typeof fixture.present)[number];
type FixtureName = keyof typeof fixture | "contract";

const rowsFor = (name: Exclude<FixtureName, "contract">): readonly FixtureRow[] => fixture[name];

function clientFor(
  name: FixtureName,
  calls: Array<Readonly<{ range: string; query: unknown; options: unknown }>>,
  fakeShape: boolean,
): ImapFlowMetadataBatchClient {
  return {
    async fetchAll(range, query, options): Promise<unknown> {
      calls.push({ range, query, options });
      const requested = new Set(range.split(",").map((value) => Number(value)));
      const fixtureName: Exclude<FixtureName, "contract"> =
        name === "contract"
          ? range === "1000000"
            ? "sparse"
            : range === "2,3,4"
              ? "missing"
              : "present"
          : name;
      return rowsFor(fixtureName)
        .filter((row) => requested.has(row.uid))
        .map((row) => ({
          ...row,
          flags: fakeShape ? new Set(row.flags) : row.flags,
          envelope: {
            ...row.envelope,
            ...(fakeShape ? { date: new Date(row.envelope.date) } : {}),
          },
          ...(fakeShape ? { internalDate: new Date(row.internalDate) } : {}),
        }));
    },
  };
}

function adapterFor(name: FixtureName, fakeShape: boolean, calls: Array<Readonly<{ range: string; query: unknown; options: unknown }>>) {
  return createMetadataBatchAdapter(clientFor(name, calls, fakeShape));
}

describe("bounded UID metadata batch adapter", () => {
  test("requests exactly the bounded UID set and never requests bodies", async () => {
    const calls: Array<Readonly<{ range: string; query: unknown; options: unknown }>> = [];
    const result = await adapterFor("present", false, calls).fetch({ ...request, uids: [4, 2] });

    expect(result.items.map((item) => item.identity.uid)).toEqual([2, 4]);
    expect(result.items[0]?.flags).toEqual([]);
    expect(result.items[1]?.flags).toEqual(["\\Seen", "\\Flagged"]);
    expect(result.items[1]?.modseq).toEqual({ kind: "known", value: 41 });
    expect(result.items[1]?.internalDate).toBe("2026-08-17T04:00:00.000Z");
    expect(calls).toEqual([
      {
        range: "4,2",
        query: IMAP_METADATA_BATCH_QUERY,
        options: { uid: true },
      },
    ]);
  });

  test("surfaces every requested UID omitted by the server", async () => {
    const calls: Array<Readonly<{ range: string; query: unknown; options: unknown }>> = [];
    const result = await adapterFor("missing", false, calls).fetch(request);

    expect(result.items.map((item) => item.identity.uid)).toEqual([4]);
    expect(result.missingUids).toEqual([2, 3]);
  });

  test("keeps sparse high UIDs bounded to the exact requested batch", async () => {
    const calls: Array<Readonly<{ range: string; query: unknown; options: unknown }>> = [];
    const result = await adapterFor("sparse", false, calls).fetch({ ...request, uids: [1_000_000] });

    expect(result.items.map((item) => item.identity.uid)).toEqual([1_000_000]);
    expect(result.missingUids).toEqual([]);
    expect(calls[0]?.range).toBe("1000000");
    expect(calls[0]?.range).not.toContain(":");
  });

  test("normalizes out-of-order captured rows without losing identity", async () => {
    const calls: Array<Readonly<{ range: string; query: unknown; options: unknown }>> = [];
    const result = await adapterFor("present", false, calls).fetch({ ...request, uids: [2, 4] });

    expect(result.items.map((item) => item.identity.uid)).toEqual([2, 4]);
    expect(result.missingUids).toEqual([]);
  });

  test("preserves valid empty subject and display-name envelope fields", async () => {
    const adapter = createMetadataBatchAdapter({
      async fetchAll(): Promise<unknown> {
        return [
          {
            ...fixture.present[0],
            envelope: {
              ...fixture.present[0].envelope,
              subject: "",
              from: [{ name: "", address: "four@example.test" }],
            },
          },
        ];
      },
    });

    const result = await adapter.fetch({ ...request, uids: [4] });
    expect(result.items[0]?.envelope.subject).toBe("");
    expect(result.items[0]?.envelope.from).toEqual([
      { name: "", address: "four@example.test" },
    ]);
  });

  test("rejects a production result containing a UID outside the request", async () => {
    const adapter = createMetadataBatchAdapter({
      async fetchAll(): Promise<unknown> {
        return fixture.outOfRequest;
      },
    });
    await expect(adapter.fetch({ ...request, uids: [2, 4] })).rejects.toThrow(
      "uid is outside the requested batch",
    );
  });

  test("rejects a production MODSEQ that cannot be represented without rounding", async () => {
    const adapter = createMetadataBatchAdapter({
      async fetchAll(): Promise<unknown> {
        return fixture.present.map((row) => ({
          ...row,
          ...(row.uid === 2 ? { modseq: 9_007_199_254_740_993n } : {}),
        }));
      },
    });
    await expect(adapter.fetch({ ...request, uids: [2, 4] })).rejects.toThrow(
      "modseq must be a non-negative safe integer",
    );
  });

  test("rejects an over-cap request before calling the client", async () => {
    const calls: Array<Readonly<{ range: string; query: unknown; options: unknown }>> = [];
    const adapter = adapterFor("present", false, calls);
    const uids = Array.from({ length: MAX_METADATA_BATCH_UIDS + 1 }, (_, index) =>
      createRemoteUidValue(index + 1),
    );

    await expect(adapter.fetch({ ...request, uids })).rejects.toThrow(
      `metadata batch exceeds ${MAX_METADATA_BATCH_UIDS} UIDs`,
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects an overlong response before decoding provider rows", async () => {
    const adapter = createMetadataBatchAdapter({
      async fetchAll(): Promise<unknown> {
        return [fixture.present[0], fixture.present[1], fixture.present[0]];
      },
    });
    await expect(adapter.fetch({ ...request, uids: [2, 4] })).rejects.toThrow(
      "result exceeds the requested UID count",
    );
  });

  test("rejects oversized flags and envelope metadata", async () => {
    const oversizedFlags = createMetadataBatchAdapter({
      async fetchAll(): Promise<unknown> {
        return [{
          ...fixture.present[0],
          flags: Array.from({ length: MAX_METADATA_FLAG_COUNT + 1 }, () => "\\Flagged"),
        }];
      },
    });
    await expect(oversizedFlags.fetch({ ...request, uids: [4] })).rejects.toThrow(
      `flags exceed ${MAX_METADATA_FLAG_COUNT} values`,
    );

    const oversizedFlagText = createMetadataBatchAdapter({
      async fetchAll(): Promise<unknown> {
        return [{
          ...fixture.present[0],
          flags: ["x".repeat(MAX_METADATA_FLAG_BYTES + 1)],
        }];
      },
    });
    await expect(oversizedFlagText.fetch({ ...request, uids: [4] })).rejects.toThrow(
      "flag is empty, contains controls, or exceeds",
    );

    const oversizedEnvelopeText = createMetadataBatchAdapter({
      async fetchAll(): Promise<unknown> {
        return [{
          ...fixture.present[0],
          envelope: { ...fixture.present[0].envelope, subject: "x".repeat(MAX_METADATA_TEXT_BYTES + 1) },
        }];
      },
    });
    await expect(oversizedEnvelopeText.fetch({ ...request, uids: [4] })).rejects.toThrow(
      "envelope subject is empty, contains controls, or exceeds",
    );

    const oversizedAddressList = createMetadataBatchAdapter({
      async fetchAll(): Promise<unknown> {
        return [{
          ...fixture.present[0],
          envelope: {
            ...fixture.present[0].envelope,
            to: Array.from({ length: MAX_METADATA_ADDRESS_COUNT + 1 }, () => ({ address: "a@example.test" })),
          },
        }];
      },
    });
    await expect(oversizedAddressList.fetch({ ...request, uids: [4] })).rejects.toThrow(
      `envelope to exceeds ${MAX_METADATA_ADDRESS_COUNT} addresses`,
    );
  });

  test("rejects malformed request input at the unknown boundary", () => {
    expect(() =>
      parseMetadataBatchRequest({
        ...request,
        uids: [2, 2],
      }),
    ).toThrow("uids must be unique");
    expect(() => parseMetadataBatchRequest({ ...request, body: true })).toThrow("unknown fields");
  });
});

const contractSuite: AdapterContractSuite<ReturnType<typeof adapterFor>> = {
  name: "captured IMAP metadata batch fake-versus-production parity",
  cases: [
    {
      id: "present-captured-batch",
      run: async (adapter) => {
        const result = await adapter.fetch({ ...request, uids: [2, 4] });
        expect(result.missingUids).toEqual([]);
        expect(result.items.map((item) => item.identity.uid)).toEqual([2, 4]);
      },
    },
    {
      id: "missing-captured-batch",
      run: async (adapter) => {
        const result = await adapter.fetch(request);
        expect(result.missingUids).toEqual([2, 3]);
      },
    },
    {
      id: "sparse-captured-batch",
      run: async (adapter) => {
        const result = await adapter.fetch({ ...request, uids: [1_000_000] });
        expect(result.items[0]?.identity.uid).toBe(1_000_000);
      },
    },
    {
      id: "out-of-order-captured-batch",
      run: async (adapter) => {
        const result = await adapter.fetch({ ...request, uids: [2, 4] });
        expect(result.items.map((item) => item.identity.uid)).toEqual([2, 4]);
      },
    },
  ],
};

test("runs the same metadata contract against fake and captured-production-shaped clients", async () => {
  const evidence = await runAdapterContractParity({
    suite: contractSuite,
    fake: { factory: () => adapterFor("contract", true, []), capabilities: [] },
    production: {
      factory: () => adapterFor("contract", false, []),
      capabilities: [],
      retainedEvidencePath: "evidence/adapter-contracts/imap-metadata-batch-production-labeled.jsonl",
    },
  });

  expect(evidence.fake.status).toBe("passed");
  expect(evidence.productionEvidence.status).toBe("available");
  expect(evidence.production?.status).toBe("passed");
  expect(evidence.semanticParity.status).toBe("matched");
  expect(evidence.semanticParity.comparedCases).toEqual(contractSuite.cases.map((item) => item.id));
});
