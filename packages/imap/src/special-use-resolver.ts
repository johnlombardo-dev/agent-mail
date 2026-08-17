import {
  createMailboxId,
  type AccountId,
  type MailboxId,
  type MonotonicSequence,
  type RemoteUidValue,
  type UidValidity,
} from "@agent-mail/core";
import type { NormalizedMailbox } from "./mailbox-discovery";
import type { ProtocolFact } from "./status-normalizer";

/** The epoch facts observed while discovering one mailbox. */
export type MailboxEpochFacts = {
  readonly uidValidity: ProtocolFact<UidValidity>;
  readonly uidNext: ProtocolFact<RemoteUidValue>;
  readonly highestModseq: ProtocolFact<MonotonicSequence>;
};

/** A normalized mailbox together with the account and status snapshot it came from. */
export type SpecialUseInventoryMailbox = {
  readonly accountId: AccountId;
  readonly mailbox: NormalizedMailbox;
  readonly epoch: MailboxEpochFacts;
};

export type SpecialUseDestinationRole = "archive" | "trash";

/** Exact identity needed by a later action planner; no mailbox name is inferred. */
export type ResolvedSpecialUseMailbox = {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly path: string;
  readonly delimiter: string | null;
  readonly epoch: MailboxEpochFacts;
};

export type SpecialUseResolution =
  | {
      readonly kind: "resolved";
      readonly role: SpecialUseDestinationRole;
      readonly destination: ResolvedSpecialUseMailbox;
    }
  | {
      readonly kind: "absent";
      readonly role: SpecialUseDestinationRole;
    }
  | {
      readonly kind: "ambiguous";
      readonly role: SpecialUseDestinationRole;
      readonly destinations: readonly ResolvedSpecialUseMailbox[];
    };

export type SpecialUseDestinationResolutions = {
  readonly archive: SpecialUseResolution;
  readonly trash: SpecialUseResolution;
};

function isNoSelect(mailbox: NormalizedMailbox): boolean {
  return mailbox.flags.some((flag) => flag.toUpperCase() === "\\NOSELECT");
}

function hasSpecialUse(mailbox: NormalizedMailbox, role: SpecialUseDestinationRole): boolean {
  return mailbox.specialUse?.toUpperCase() === `\\${role.toUpperCase()}`;
}

function identityFor(input: SpecialUseInventoryMailbox): ResolvedSpecialUseMailbox {
  return {
    accountId: input.accountId,
    mailboxId: createMailboxId(input.mailbox.path),
    path: input.mailbox.path,
    delimiter: input.mailbox.delimiter,
    epoch: input.epoch,
  };
}

/**
 * Resolve one destination from normalized SPECIAL-USE metadata.
 *
 * This function has no network, configuration, or persistence effects. A
 * mailbox is eligible only when it is selectable and its normalized
 * SPECIAL-USE value is the requested role. In particular, mailbox names and
 * ordinary IMAP flags never act as fallbacks for SPECIAL-USE metadata.
 */
export function resolveSpecialUseDestination(
  inventory: readonly SpecialUseInventoryMailbox[],
  role: SpecialUseDestinationRole,
): SpecialUseResolution {
  const destinations = inventory
    .filter(({ mailbox }) => !isNoSelect(mailbox) && hasSpecialUse(mailbox, role))
    .map(identityFor);

  if (destinations.length === 0) return { kind: "absent", role };
  if (destinations.length > 1) return { kind: "ambiguous", role, destinations };
  const [destination] = destinations;
  if (destination === undefined) return { kind: "absent", role };
  return { kind: "resolved", role, destination };
}

/** Resolve both action destinations from one captured inventory snapshot. */
export function resolveSpecialUseDestinations(
  inventory: readonly SpecialUseInventoryMailbox[],
): SpecialUseDestinationResolutions {
  return {
    archive: resolveSpecialUseDestination(inventory, "archive"),
    trash: resolveSpecialUseDestination(inventory, "trash"),
  };
}
