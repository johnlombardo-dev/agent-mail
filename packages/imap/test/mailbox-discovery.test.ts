import { expect, test, describe } from "bun:test";
import {
  discoverMailboxes,
  MailboxDiscoveryAdapterError,
  normalizeMailboxList,
  type ImapFlowMailboxListClient,
  type MailboxDiscoveryResult,
} from "../src/mailbox-discovery";
import {
  runAdapterContractParity,
  type AdapterContractSuite,
  type AdapterFactoryInput,
} from "../../../tests/adapter-contracts/harness";
import capturedRows from "./fixtures/mailbox-discovery-production-labeled.json";

const expectedCapturedResult: MailboxDiscoveryResult = {
  candidates: [
    {
      path: "Projects/Inbox",
      delimiter: "/",
      flags: ["\\HasNoChildren"],
      specialUse: "\\Inbox",
    },
    {
      path: "客户/2026/收件箱",
      delimiter: "/",
      flags: ["\\HasNoChildren"],
      specialUse: null,
    },
    {
      path: "Archive.Équipe",
      delimiter: ".",
      flags: ["\\HasNoChildren"],
      specialUse: "\\Archive",
    },
  ],
  skipped: [
    {
      path: "Projects",
      delimiter: "/",
      flags: ["\\Noselect", "\\HasChildren"],
      specialUse: null,
      reason: "noselect",
      attribute: "\\Noselect",
    },
  ],
};

function fakeClient(): ImapFlowMailboxListClient {
  return {
    list: async () => [
      {
        path: "Projects",
        delimiter: "/",
        flags: new Set(["\\Noselect", "\\HasChildren"]),
      },
      {
        path: "Projects/Inbox",
        delimiter: "/",
        flags: new Set(["\\HasNoChildren"]),
        specialUse: "\\Inbox",
      },
      {
        path: "客户/2026/收件箱",
        delimiter: "/",
        flags: new Set(["\\HasNoChildren"]),
      },
      {
        path: "Archive.Équipe",
        delimiter: ".",
        flags: new Set(["\\HasNoChildren"]),
        specialUse: "\\Archive",
      },
    ],
  };
}

function capturedFixtureClient(): ImapFlowMailboxListClient {
  return { list: async () => capturedRows };
}

describe("mailbox discovery", () => {
  test("calls the injected list operation once and skips only the noselect parent", async () => {
    let listCalls = 0;
    const client: ImapFlowMailboxListClient = {
      list: async () => {
        listCalls += 1;
        return [
          {
            path: "Parent",
            delimiter: "/",
            flags: new Set(["\\Noselect"]),
          },
          {
            path: "Parent/INBOX",
            delimiter: "/",
            flags: new Set<string>(),
          },
        ];
      },
    };

    await expect(discoverMailboxes(client)).resolves.toEqual({
      candidates: [{ path: "Parent/INBOX", delimiter: "/", flags: [], specialUse: null }],
      skipped: [
        {
          path: "Parent",
          delimiter: "/",
          flags: ["\\Noselect"],
          specialUse: null,
          reason: "noselect",
          attribute: "\\Noselect",
        },
      ],
    });
    expect(listCalls).toBe(1);
  });

  test("preserves nested Unicode identity and each row delimiter", () => {
    expect(
      normalizeMailboxList([
        {
          path: "客户/2026/收件箱",
          delimiter: "/",
          flags: ["\\HasNoChildren"],
        },
        {
          path: "Archive.Équipe",
          delimiter: ".",
          flags: new Set(["\\HasNoChildren"]),
        },
      ]),
    ).toEqual({
      candidates: [
        {
          path: "客户/2026/收件箱",
          delimiter: "/",
          flags: ["\\HasNoChildren"],
          specialUse: null,
        },
        {
          path: "Archive.Équipe",
          delimiter: ".",
          flags: ["\\HasNoChildren"],
          specialUse: null,
        },
      ],
      skipped: [],
    });
  });

  test("rejects malformed external rows at the adapter boundary", () => {
    expect(() => normalizeMailboxList([{ path: "Inbox", delimiter: "/", flags: [4] }])).toThrow(
      MailboxDiscoveryAdapterError,
    );
    expect(() =>
      normalizeMailboxList([{ path: "Inbox", delimiter: "/", flags: [] }]),
    ).not.toThrow();
    expect(() => normalizeMailboxList([{ path: "Inbox", delimiter: "::", flags: [] }])).toThrow(
      "one Unicode scalar",
    );
    expect(() => normalizeMailboxList({ path: "Inbox" })).toThrow("must be an array");
  });
});

const contractSuite: AdapterContractSuite<ImapFlowMailboxListClient> = {
  name: "mailbox discovery over one injected ImapFlow list call",
  cases: [
    {
      id: "noselect-parent-does-not-hide-child",
      run: async (adapter) => {
        const result = await discoverMailboxes(adapter);
        expect(result.candidates.map((item) => item.path)).toContain("Projects/Inbox");
        expect(result.skipped.map((item) => item.path)).toEqual(["Projects"]);
      },
    },
    {
      id: "nested-unicode-and-delimiter-preserved",
      run: async (adapter) => {
        const result = await discoverMailboxes(adapter);
        expect(result.candidates[0]?.delimiter).toBe("/");
      },
    },
    {
      id: "captured-production-list-rows",
      productionRequired: true,
      run: async (adapter) => {
        await expect(discoverMailboxes(adapter)).resolves.toEqual(expectedCapturedResult);
      },
    },
  ],
};

const fakeFactory: Omit<AdapterFactoryInput<ImapFlowMailboxListClient>, "kind"> = {
  factory: fakeClient,
  capabilities: [{ name: "read-only-list", status: "available" }],
};

const capturedFactory: Omit<AdapterFactoryInput<ImapFlowMailboxListClient>, "kind"> = {
  factory: capturedFixtureClient,
  capabilities: [{ name: "read-only-list", status: "available" }],
  retainedEvidencePath: "packages/imap/test/fixtures/mailbox-discovery-production-labeled.json",
};

test("runs shared contracts against fake and captured production-labeled rows", async () => {
  const evidence = await runAdapterContractParity({
    suite: contractSuite,
    fake: fakeFactory,
    production: capturedFactory,
  });

  expect(evidence.fake.status).toBe("incomplete");
  expect(evidence.productionEvidence).toEqual({
    status: "available",
    adapterKind: "production",
    result: expect.objectContaining({ status: "passed" }),
  });
  expect(evidence.semanticParity.status).toBe("matched");
  expect(evidence.production?.passedCases).toEqual(contractSuite.cases.map((item) => item.id));
});
