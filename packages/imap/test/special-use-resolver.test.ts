import { describe, expect, test } from "bun:test";
import { createAccountId } from "@agent-mail/core";
import {
  normalizeMailboxList,
  type NormalizedMailbox,
} from "../src/mailbox-discovery";
import {
  resolveSpecialUseDestination,
  resolveSpecialUseDestinations,
  type MailboxEpochFacts,
  type SpecialUseInventoryMailbox,
  type SpecialUseResolution,
} from "../src/special-use-resolver";
import { normalizeMailboxStatus } from "../src/status-normalizer";
import capturedInventory from "./fixtures/special-use-inventory-production-labeled.json";

type CapturedInventory = {
  readonly accountId: string;
  readonly mailboxes: readonly {
    readonly path: string;
    readonly delimiter: string;
    readonly flags: readonly string[];
    readonly specialUse: string | null;
    readonly status: Readonly<Record<string, unknown>>;
  }[];
};

const corpus: CapturedInventory = capturedInventory;

function normalizeCapturedMailbox(row: CapturedInventory["mailboxes"][number]): NormalizedMailbox {
  const normalized = normalizeMailboxList([row]);
  const mailbox = normalized.candidates[0] ?? normalized.skipped[0];
  if (mailbox === undefined) throw new Error(`fixture row was not normalized: ${row.path}`);
  return mailbox;
}

function inventoryFromRows(
  rows: readonly CapturedInventory["mailboxes"][number][],
): readonly SpecialUseInventoryMailbox[] {
  const accountId = createAccountId(corpus.accountId);
  return rows.map((row) => {
    const status = normalizeMailboxStatus(row.status);
    const epoch: MailboxEpochFacts = {
      uidValidity: status.uidValidity,
      uidNext: status.uidNext,
      highestModseq: status.highestModseq,
    };
    return { accountId, mailbox: normalizeCapturedMailbox(row), epoch };
  });
}

function rows(...paths: readonly string[]): readonly CapturedInventory["mailboxes"][number][] {
  return paths.flatMap((path) => {
    const row = corpus.mailboxes.find((candidate) => candidate.path === path);
    if (row === undefined) throw new Error(`missing fixture row: ${path}`);
    return [row];
  });
}

function expectKind<TKind extends SpecialUseResolution["kind"]>(
  result: SpecialUseResolution,
  kind: TKind,
): Extract<SpecialUseResolution, { readonly kind: TKind }> {
  expect(result.kind).toBe(kind);
  if (result.kind !== kind) throw new Error(`expected ${kind}, got ${result.kind}`);
  return result;
}

describe("SPECIAL-USE destination resolver", () => {
  test("resolves one selectable Archive and Trash by normalized special-use flags", () => {
    const inventory = inventoryFromRows(rows("客户/归档/Équipe", "Проекты/Удалённые"));
    const result = resolveSpecialUseDestinations(inventory);

    const archive = expectKind(result.archive, "resolved");
    expect(archive.destination).toEqual({
      accountId: "account:icloud-example",
      mailboxId: "mailbox:客户/归档/Équipe",
      path: "客户/归档/Équipe",
      delimiter: "/",
      epoch: {
        uidValidity: { kind: "known", value: 938475 },
        uidNext: { kind: "known", value: 41 },
        highestModseq: { kind: "known", value: 8 },
      },
    });

    const trash = expectKind(result.trash, "resolved");
    expect(trash.destination.accountId).toBe("account:icloud-example");
    expect(trash.destination.path).toBe("Проекты/Удалённые");
    expect(trash.destination.epoch.uidValidity).toEqual({ kind: "known", value: 938476 });
  });

  test("does not guess names when special-use is absent", () => {
    const result = resolveSpecialUseDestinations(inventoryFromRows(rows("Archive", "Trash")));

    expect(result.archive).toEqual({ kind: "absent", role: "archive" });
    expect(result.trash).toEqual({ kind: "absent", role: "trash" });
  });

  test("does not select noselect special-use containers", () => {
    const result = resolveSpecialUseDestinations(
      inventoryFromRows(rows("NoSelect/Archive", "NoSelect/Trash")),
    );

    expect(result.archive).toEqual({ kind: "absent", role: "archive" });
    expect(result.trash).toEqual({ kind: "absent", role: "trash" });
  });

  test("returns ambiguous when more than one eligible mailbox has the role", () => {
    const result = resolveSpecialUseDestinations(
      inventoryFromRows(
        rows("Archive-copy-1", "Archive-copy-2", "Trash-copy-1", "Trash-copy-2"),
      ),
    );

    const archive = expectKind(result.archive, "ambiguous");
    expect(archive.destinations.map((destination) => destination.path)).toEqual([
      "Archive-copy-1",
      "Archive-copy-2",
    ]);
    const trash = expectKind(result.trash, "ambiguous");
    expect(trash.destinations.map((destination) => destination.path)).toEqual([
      "Trash-copy-1",
      "Trash-copy-2",
    ]);
  });

  test("uses only normalized special-use and ignores ordinary flags and names", () => {
    const archiveNameOnly = inventoryFromRows(rows("Archive"))[0];
    if (archiveNameOnly === undefined) throw new Error("missing Archive fixture");
    const withArchiveFlag = {
      ...archiveNameOnly,
      mailbox: { ...archiveNameOnly.mailbox, flags: ["\\Archive"] },
    };

    expect(resolveSpecialUseDestination([withArchiveFlag], "archive")).toEqual({
      kind: "absent",
      role: "archive",
    });
  });

  test("returns stable role-specific absence for an unrelated inventory", () => {
    const result = resolveSpecialUseDestination(
      inventoryFromRows(rows("INBOX")),
      "trash",
    );
    expect(result).toEqual({ kind: "absent", role: "trash" });
  });
});
