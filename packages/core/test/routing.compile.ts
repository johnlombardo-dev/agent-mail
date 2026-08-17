import { createLocalLabel, type LocalLabel } from "../src/routing";
import { createMailboxId, type MailboxId } from "../src/identifiers";

const localLabel: LocalLabel = createLocalLabel("label:archive");
const remoteMailbox: MailboxId = createMailboxId("Archive");

// @ts-expect-error Remote mailbox placement is not a local routing label.
const invalidLocalLabel: LocalLabel = remoteMailbox;
// @ts-expect-error A local routing label cannot identify a remote mailbox.
const invalidRemoteMailbox: MailboxId = localLabel;

void invalidLocalLabel;
void invalidRemoteMailbox;
