import {
  normalizeImapCapabilities,
  normalizeMailboxStatus,
  type ProtocolFact,
} from "../src/status-normalizer";
import type { MonotonicSequence, UidValidity } from "@agent-mail/core";

const uidValidity: ProtocolFact<UidValidity> = normalizeMailboxStatus({}).uidValidity;
const modseq: ProtocolFact<MonotonicSequence> = normalizeMailboxStatus({}).highestModseq;
const idle = normalizeImapCapabilities(undefined).idle;

if (uidValidity.kind === "known") {
  const checked: UidValidity = uidValidity.value;
  void checked;
}
if (modseq.kind === "known") {
  const checked: MonotonicSequence = modseq.value;
  void checked;
}
if (idle.kind === "unsupported") {
  const reason: string = idle.reason;
  void reason;
}
