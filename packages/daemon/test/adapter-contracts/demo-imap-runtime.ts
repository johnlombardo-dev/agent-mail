import { ImapFlow } from "imapflow";
import {
  createAccountId,
  createMailboxId,
  createRemoteUidValue,
  createUidValidity,
} from "@agent-mail/core";
import { discoverMailboxes } from "../../../imap/src/mailbox-discovery";
import { createMetadataBatchAdapter } from "../../../imap/src/metadata-batch";
import { createPreconditionAdapter } from "../../../imap/src/precondition";
import type { AdapterContractSuite } from "../../../../tests/adapter-contracts/harness";
import type { DemoImapServer } from "../../src/demo/imap";

export function createInstalledDemoImapFlow(
  server: DemoImapServer,
  credentials: Readonly<{ readonly user: string; readonly pass: string }> = {
    user: "demo-user",
    pass: "demo-pass",
  },
): ImapFlow {
  return new ImapFlow({
    host: server.host,
    port: server.port,
    secure: false,
    doSTARTTLS: false,
    disableAutoIdle: true,
    logger: false,
    auth: credentials,
    connectionTimeout: 2_000,
    greetingTimeout: 2_000,
    socketTimeout: 5_000,
  });
}

function requireCondition(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

/** Reusable production-adapter contract driven through the installed ImapFlow runtime. */
export const installedDemoImapAdapterContract: AdapterContractSuite<ImapFlow> = {
  name: "production IMAP adapters over installed ImapFlow and real demo TCP",
  cases: [
    {
      id: "mailbox-discovery-preserves-special-use-and-noselect",
      requires: ["real-loopback-list"],
      run: async (flow) => {
        const result = await discoverMailboxes(flow);
        requireCondition(
          result.candidates.some((mailbox) => mailbox.specialUse === "\\Archive"),
          "Archive SPECIAL-USE was not preserved",
        );
        requireCondition(
          result.skipped.some((mailbox) => mailbox.path === "Projects"),
          "Noselect container was not skipped",
        );
      },
    },
    {
      id: "metadata-and-precondition-use-real-select-fetch",
      requires: ["real-loopback-fetch", "condstore"],
      run: async (flow) => {
        await flow.mailboxOpen("INBOX");
        const accountId = createAccountId("person@example.test");
        const mailboxId = createMailboxId("INBOX");
        const batch = await createMetadataBatchAdapter(flow).fetch({
          accountId,
          mailboxId,
          uidValidity: createUidValidity(77),
          uids: [createRemoteUidValue(1), createRemoteUidValue(2)],
        });
        requireCondition(batch.items.length === 2, "metadata adapter did not return both messages");
        const raw = await flow.fetchOne("1", { source: true }, { uid: true });
        requireCondition(
          raw !== false && Buffer.isBuffer(raw.source) && raw.source.includes("Quarterly review"),
          "installed ImapFlow did not stream the raw message literal",
        );
        const observation = await createPreconditionAdapter({
          client: flow,
          accountId,
          mailboxId,
          mailboxPath: "INBOX",
        }).read({
          accountId,
          mailboxId,
          uidValidity: createUidValidity(77),
          uid: createRemoteUidValue(1),
          precondition: { modseq: 10 },
        });
        requireCondition(observation.kind === "satisfied", "precondition adapter did not satisfy");
      },
    },
  ],
};
