import { describe, expect, test } from "bun:test";
import { createRemoteUidValue } from "@agent-mail/core";
import {
  buildTaggedStoreCommandAttributes,
  createImapFlowTaggedStorePrimitive,
  type ImapTaggedStoreRequest,
} from "../src/tagged-conditional-store";

const request: ImapTaggedStoreRequest = {
  range: "42",
  operation: "add",
  flags: ["\\Seen"],
  options: { uid: true, unchangedSince: 7n },
};

function responseCode(code: string, value: string): Readonly<Record<string, unknown>> {
  return {
    type: "ATOM",
    value: "",
    section: [
      { type: "ATOM", value: code },
      { type: "SEQUENCE", value },
    ],
  };
}

function tagged(command: "OK" | "NO" | "BAD", attributes: readonly unknown[] = []) {
  return { tag: "A1", command, attributes };
}

type ExecOptions = Readonly<{
  readonly untagged?: Readonly<Record<string, (value: unknown) => void>>;
}>;

type Fake = {
  readonly enabled: Set<string>;
  readonly mailbox: Readonly<{ readonly noModseq?: boolean }>;
  exec: (
    command: string,
    attributes: readonly unknown[],
    options?: ExecOptions,
  ) => Promise<unknown>;
};

function fakeExec(
  result: unknown,
  capture: { command?: string; attributes?: readonly unknown[]; nextCalls: number },
  untagged?: unknown,
): Fake {
  return {
    enabled: new Set(["CONDSTORE"]),
    mailbox: {},
    exec: async (command, attributes, options) => {
      capture.command = command;
      capture.attributes = attributes;
      if (untagged !== undefined) options?.untagged?.OK?.(untagged);
      return result;
    },
  };
}

describe("tagged conditional UID STORE", () => {
  test("builds the exact RFC 7162 additive Seen command AST", () => {
    expect(buildTaggedStoreCommandAttributes(request)).toEqual([
      { type: "SEQUENCE", value: "42" },
      [
        { type: "ATOM", value: "UNCHANGEDSINCE" },
        { type: "ATOM", value: "7" },
      ],
      { type: "ATOM", value: "+FLAGS" },
      [{ type: "ATOM", value: "\\Seen" }],
    ]);
  });

  test("returns applied only for a tagged OK and releases ImapFlow response", async () => {
    const capture = { nextCalls: 0 };
    const result = await createImapFlowTaggedStorePrimitive(
      fakeExec(
        {
          response: tagged("OK"),
          next: () => {
            capture.nextCalls += 1;
          },
        },
        capture,
      ),
    )(request);
    expect(result).toEqual({ kind: "applied" });
    expect(capture.command).toBe("UID STORE");
    expect(capture.attributes).toEqual(buildTaggedStoreCommandAttributes(request));
    expect(capture.nextCalls).toBe(1);
  });

  test("decodes tagged and untagged MODIFIED exact UID evidence", async () => {
    const taggedModified = {
      response: tagged("OK", [responseCode("MODIFIED", "42")]),
      next: () => undefined,
    };
    const taggedResult = await createImapFlowTaggedStorePrimitive(
      fakeExec(taggedModified, { nextCalls: 0 }),
    )(request);
    expect(taggedResult).toEqual({
      kind: "modified",
      modifiedUids: [createRemoteUidValue(42)],
    });

    const untaggedResult = await createImapFlowTaggedStorePrimitive(
      fakeExec(
        { response: tagged("OK"), next: () => undefined },
        { nextCalls: 0 },
        { command: "OK", attributes: [responseCode("MODIFIED", "42")] },
      ),
    )(request);
    expect(untaggedResult).toEqual(taggedResult);
  });

  test("decodes MODIFIED from a tagged NO and rejects non-exact UID evidence", async () => {
    const modifiedError = {
      response: tagged("NO", [responseCode("MODIFIED", "42")]),
      responseStatus: "NO",
    };
    const modified = await createImapFlowTaggedStorePrimitive({
      ...fakeExec({}, { nextCalls: 0 }),
      exec: async () => {
        throw modifiedError;
      },
    })(request);
    expect(modified).toEqual({
      kind: "modified",
      modifiedUids: [createRemoteUidValue(42)],
    });

    const wrongUid = await createImapFlowTaggedStorePrimitive(
      fakeExec(
        { response: tagged("OK", [responseCode("MODIFIED", "43")]), next: () => undefined },
        { nextCalls: 0 },
      ),
    )(request);
    expect(wrongUid).toEqual({
      kind: "rejected",
      status: "malformed",
      certainty: "uncertain",
      phase: "after_transmission",
    });
  });

  test("fails closed before transmission without CONDSTORE or with noModseq", async () => {
    let calls = 0;
    const client = fakeExec({ response: tagged("OK"), next: () => undefined }, { nextCalls: 0 });
    client.enabled.clear();
    client.exec = async () => {
      calls += 1;
      return { response: tagged("OK"), next: () => undefined };
    };
    const unsupported = await createImapFlowTaggedStorePrimitive(client)(request);
    expect(unsupported).toEqual({
      kind: "rejected",
      status: "unsupported",
      certainty: "definite",
      phase: "before_transmission",
    });
    expect(calls).toBe(0);

    const noModseq = { ...fakeExec({ response: tagged("OK"), next: () => undefined }, { nextCalls: 0 }), mailbox: { noModseq: true } };
    expect(await createImapFlowTaggedStorePrimitive(noModseq)(request)).toEqual({
      kind: "rejected",
      status: "unsupported",
      certainty: "definite",
      phase: "before_transmission",
    });
  });

  test("distinguishes missing and transport certainty", async () => {
    const missing = { response: tagged("NO", [responseCode("NONEXISTENT", "42")]), responseStatus: "NO" };
    const missingResult = await createImapFlowTaggedStorePrimitive({
      ...fakeExec({}, { nextCalls: 0 }),
      exec: async () => {
        throw missing;
      },
    })(request);
    expect(missingResult).toEqual({ kind: "missing", status: "NO" });

    const before = await createImapFlowTaggedStorePrimitive({
      ...fakeExec({}, { nextCalls: 0 }),
      exec: async () => {
        throw new Error("not sent");
      },
    })(request);
    expect(before).toEqual({
      kind: "rejected",
      status: "BAD",
      certainty: "uncertain",
      phase: "after_transmission",
    });

    const definiteBefore = await createImapFlowTaggedStorePrimitive({
      ...fakeExec({}, { nextCalls: 0 }),
      exec: async () => {
        throw { beforeTransmission: true };
      },
    })(request);
    expect(definiteBefore).toEqual({
      kind: "rejected",
      status: "BAD",
      certainty: "definite",
      phase: "before_transmission",
    });

    const after = await createImapFlowTaggedStorePrimitive({
      ...fakeExec({}, { nextCalls: 0 }),
      exec: async () => {
        throw { response: tagged("BAD"), responseStatus: "BAD" };
      },
    })(request);
    expect(after).toEqual({
      kind: "rejected",
      status: "BAD",
      certainty: "uncertain",
      phase: "after_transmission",
    });
  });
});
