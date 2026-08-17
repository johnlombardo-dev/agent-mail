import { describe, expect, it } from "bun:test";
import {
  createContentDiagnostic,
  createContentState,
  createIdentityOnlyContentState,
  createParsedContentState,
  createPromotedContentState,
  createStageHandle,
  createStagedContentState,
  createTombstoneReason,
  createTombstonedContentState,
  createCorruptContentState,
  parseContentState,
  serializeContentState,
} from "../src/content-state";
import { createMessageId, createRemoteUid, serializeRemoteUid } from "../src/identifiers";

const messageId = createMessageId("message-1");
const remoteUid = createRemoteUid({
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 42,
  uid: 7,
});

const validInputs = [
  {
    kind: "staged",
    messageId,
    stageHandle: createStageHandle("stage-1"),
  },
  {
    kind: "parsed",
    messageId,
    stageHandle: createStageHandle("stage-2"),
  },
  {
    kind: "promoted",
    messageId,
    blobId: "blob:raw-1",
  },
  {
    kind: "identity-only",
    messageId,
    remoteUid: serializeRemoteUid(remoteUid),
    absenceReason: "not-fetched",
  },
  {
    kind: "corrupt",
    messageId,
    diagnostic: "checksum mismatch",
  },
  {
    kind: "tombstoned",
    messageId,
    reason: "remote deletion",
  },
] as const;

describe("content lifecycle states", () => {
  it("constructs and round-trips every lifecycle variant", () => {
    const states = validInputs.map((input) => createContentState(input));
    expect(states.map((state) => state.kind)).toEqual([
      "staged",
      "parsed",
      "promoted",
      "identity-only",
      "corrupt",
      "tombstoned",
    ]);

    for (const state of states) {
      const encoded = JSON.parse(JSON.stringify(serializeContentState(state))) as unknown;
      expect(parseContentState(encoded)).toEqual(state);
    }
  });

  it("constructs each dedicated variant at the typed boundary", () => {
    expect(createStagedContentState(validInputs[0])).toEqual(createContentState(validInputs[0]));
    expect(createParsedContentState(validInputs[1])).toEqual(createContentState(validInputs[1]));
    expect(createPromotedContentState(validInputs[2])).toEqual(createContentState(validInputs[2]));
    expect(createIdentityOnlyContentState(validInputs[3])).toEqual(
      createContentState(validInputs[3]),
    );
    expect(createCorruptContentState(validInputs[4])).toEqual(createContentState(validInputs[4]));
    expect(createTombstonedContentState(validInputs[5])).toEqual(
      createContentState(validInputs[5]),
    );
  });

  it("rejects missing, unknown, mutually exclusive, and malformed fields", () => {
    const invalidInputs: unknown[] = [
      { kind: "promoted", messageId },
      { kind: "identity-only", messageId, remoteUid, absenceReason: "" },
      { kind: "corrupt", messageId, diagnostic: "" },
      { kind: "tombstoned", messageId, reason: "", blobId: "blob:forbidden" },
      { kind: "corrupt", messageId, diagnostic: "bad", body: "readable" },
      { kind: "staged", messageId, stageHandle: "stage:one", extra: true },
      { kind: "staged", messageId: "placement:wrong", stageHandle: "stage:one" },
      { kind: "promoted", messageId, blobId: "message:not-a-blob" },
      {
        kind: "identity-only",
        messageId,
        remoteUid: { accountId: "wrong", mailboxId: "mailbox:inbox", uidValidity: 42, uid: 7 },
        absenceReason: "not-fetched",
      },
      { kind: "unknown", messageId },
      { messageId },
      [],
      Object.create({ kind: "staged" }),
    ];

    for (const invalid of invalidInputs) {
      expect(() => createContentState(invalid)).toThrow();
    }
  });

  it("rejects readable body/blob handles on terminal states", () => {
    expect(() =>
      createContentState({
        kind: "tombstoned",
        messageId,
        reason: "remote deletion",
        blobId: "blob:body",
      }),
    ).toThrow();
    expect(() =>
      createContentState({
        kind: "corrupt",
        messageId,
        diagnostic: "checksum mismatch",
        bodyBlobId: "blob:body",
      }),
    ).toThrow();
  });

  it("rejects symbol fields and non-plain objects", () => {
    const withSymbol = {
      kind: "staged",
      messageId,
      stageHandle: "stage:one",
      [Symbol("unexpected")]: true,
    };
    expect(() => createContentState(withSymbol)).toThrow();
    expect(() => createContentState(new Date())).toThrow();
  });

  it("validates opaque text constructors", () => {
    expect(createStageHandle("stage-1")).toBe("stage-1");
    expect(createContentDiagnostic("bad checksum")).toBe("bad checksum");
    expect(createTombstoneReason("remote deletion")).toBe("remote deletion");
    for (const invalid of [undefined, null, "", " ", " bad", "bad ", "bad\nvalue"]) {
      expect(() => createStageHandle(invalid)).toThrow();
      expect(() => createContentDiagnostic(invalid)).toThrow();
      expect(() => createTombstoneReason(invalid)).toThrow();
    }
  });
});
