import {
  createContentDiagnostic,
  createStageHandle,
  createTombstoneReason,
  type ContentState,
} from "../src/content-state";
import { createBlobId, createMessageId, createRemoteUid } from "../src/identifiers";

const messageId = createMessageId("message-1");
const stageHandle = createStageHandle("stage-1");
const diagnostic = createContentDiagnostic("checksum mismatch");
const tombstoneReason = createTombstoneReason("remote deletion");
const remoteUid = createRemoteUid({
  accountId: "account:one",
  mailboxId: "mailbox:inbox",
  uidValidity: 42,
  uid: 7,
});

const states: ContentState[] = [
  { kind: "staged", messageId, stageHandle },
  { kind: "parsed", messageId, stageHandle },
  { kind: "promoted", messageId, blobId: createBlobId("raw-1") },
  { kind: "identity-only", messageId, remoteUid, absenceReason: "not-fetched" },
  { kind: "corrupt", messageId, diagnostic },
  { kind: "tombstoned", messageId, reason: tombstoneReason },
];

function exhaustivelyDescribe(state: ContentState): string {
  switch (state.kind) {
    case "staged":
      return state.stageHandle;
    case "parsed":
      return state.stageHandle;
    case "promoted":
      return state.blobId;
    case "identity-only":
      return state.absenceReason;
    case "corrupt":
      return state.diagnostic;
    case "tombstoned":
      return state.reason;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

void states.map(exhaustivelyDescribe);

// @ts-expect-error A promoted state cannot omit its canonical blob identity.
const promotedWithoutBlob: ContentState = { kind: "promoted", messageId };
const tombstonedWithBodyBlob: ContentState = {
  kind: "tombstoned",
  messageId,
  reason: tombstoneReason,
  // @ts-expect-error Tombstoned content cannot carry a readable body/blob handle.
  blobId: "blob:forbidden",
};
const corruptWithBodyBlob: ContentState = {
  kind: "corrupt",
  messageId,
  diagnostic,
  // @ts-expect-error Corrupt content cannot carry a readable body/blob handle.
  blobId: "blob:forbidden",
};

void promotedWithoutBlob;
void tombstonedWithBodyBlob;
void corruptWithBodyBlob;
