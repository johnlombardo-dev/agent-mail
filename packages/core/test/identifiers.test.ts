import { describe, expect, it } from "bun:test";
import {
  createAccountId,
  createBlobId,
  createMailboxId,
  createMessageId,
  createPlacementId,
  createThreadId,
  createUidValidity,
  createRemoteUid,
  parseAccountId,
  parseBlobId,
  parseMailboxId,
  parseMessageId,
  parsePlacementId,
  parseRemoteUid,
  parseThreadId,
  parseUidValidity,
  serializeAccountId,
  serializeBlobId,
  serializeMailboxId,
  serializeMessageId,
  serializePlacementId,
  serializeRemoteUid,
  serializeThreadId,
  serializeUidValidity,
} from "../src/index";

describe("canonical identifiers", () => {
  it("round-trips scalar and numeric identifiers", () => {
    const account = createAccountId("acct/with-punctuation");
    const mailbox = createMailboxId("mailbox-1");
    const message = createMessageId("message-1");
    const placement = createPlacementId("placement-1");
    const blob = createBlobId("blob-1");
    const thread = createThreadId("thread-1");
    const validity = createUidValidity(Number.MAX_SAFE_INTEGER);
    expect(parseAccountId(serializeAccountId(account))).toBe(account);
    expect(parseMailboxId(serializeMailboxId(mailbox))).toBe(mailbox);
    expect(parseMessageId(serializeMessageId(message))).toBe(message);
    expect(parsePlacementId(serializePlacementId(placement))).toBe(placement);
    expect(parseBlobId(serializeBlobId(blob))).toBe(blob);
    expect(parseThreadId(serializeThreadId(thread))).toBe(thread);
    expect(serializeUidValidity(validity)).toBe("9007199254740991");
    expect(parseUidValidity(serializeUidValidity(validity))).toBe(validity);
  });

  it("keeps remote UID identity scoped and round-trippable", () => {
    const remote = createRemoteUid({
      accountId: "acct,one",
      mailboxId: "mailbox]two",
      uidValidity: 42,
      uid: 7,
    });
    expect(parseRemoteUid(serializeRemoteUid(remote))).toEqual(remote);
  });

  it("rejects invalid values and malformed remote forms", () => {
    for (const invalid of [undefined, null, 1, "", "  ", " leading", "trailing ", "line\nfeed"]) {
      expect(() => createAccountId(invalid)).toThrow();
    }
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => createUidValidity(invalid)).toThrow();
    }
    for (const invalid of [null, undefined, [], "remote", { accountId: "account:a" }]) {
      expect(() => createRemoteUid(invalid)).toThrow();
    }
    for (const invalid of [
      "",
      "[]",
      '["remote-uid-v1","a","m",0,1]',
      '["remote-uid-v1","a","m",1,1,2]',
    ]) {
      expect(() => parseRemoteUid(invalid)).toThrow();
    }
  });

  it("does not make placement IDs parse as message IDs", () => {
    const placement = createPlacementId("placement-1");
    expect(() => parseMessageId(placement)).toThrow();
  });
});
