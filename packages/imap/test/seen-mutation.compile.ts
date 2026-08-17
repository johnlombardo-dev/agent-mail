import { ImapFlow } from "imapflow";
import {
  createConditionalSeenMutationClient,
  type ImapSeenMutationClient,
} from "../src/seen-mutation";

/** The installed production client must satisfy the narrow mutation surface. */
const productionClient: ImapSeenMutationClient = new ImapFlow({
  host: "example.invalid",
  port: 993,
  secure: true,
  auth: { user: "compile-only", pass: "compile-only" },
});

void productionClient;

const safeProductionClient = createConditionalSeenMutationClient(productionClient);
void safeProductionClient;
