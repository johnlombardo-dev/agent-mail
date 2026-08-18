import { describe, expect, test } from "bun:test";
import {
  LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV,
  LIVE_MUTATION_CONFIRMATION,
  LIVE_MUTATION_CONFIRMATION_ENV,
  LIVE_MUTATION_EVIDENCE_DIR_ENV,
  LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV,
  LIVE_MUTATION_MARKER_ENV,
  LIVE_MUTATION_SENTINELS_ENV,
  LIVE_MUTATION_TARGETS_ENV,
  type CapturedCommand,
  type ConnectionFactory,
  type DisposableMutationConfig,
  type FrozenTarget,
  type FrozenTargets,
  type QualificationAction,
  type RemoteIdentity,
  type RemoteSnapshot,
  blockedEvidence,
  dryValidateDisposableMutation,
  formatRedactedEvidence,
  parseDisposableMutationConfig,
  qualifyDisposableMutation,
  qualifyDisposableMutationFromEnvironment,
  validateCommandTrace,
} from "./disposable-mutation-harness";

const marker = "agent-mail-153";
const account = "account:disposable@example.invalid";
const mailbox = "mailbox:INBOX";
const archive = "mailbox:Archive";
const trash = "mailbox:Trash";

function fixture(uid: number, targetMailbox = mailbox): FrozenTarget {
  return { account, mailbox: targetMailbox, uidValidity: 100, uid, marker };
}

const targets: FrozenTargets = {
  markSeen: fixture(101),
  markUnseen: fixture(102),
  moveToArchive: fixture(103),
  moveToTrash: fixture(104),
};
const sentinels = { unrelated: fixture(201), unread: fixture(202) };

function encoded(value: unknown): string {
  return JSON.stringify(value);
}

function environment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return {
    [LIVE_MUTATION_CONFIRMATION_ENV]: LIVE_MUTATION_CONFIRMATION,
    [LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV]: account,
    [LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV]: `${mailbox},${archive},${trash}`,
    [LIVE_MUTATION_MARKER_ENV]: marker,
    [LIVE_MUTATION_TARGETS_ENV]: encoded(targets),
    [LIVE_MUTATION_SENTINELS_ENV]: encoded(sentinels),
    [LIVE_MUTATION_EVIDENCE_DIR_ENV]: "/tmp/agent-mail-153-evidence",
    ...overrides,
  };
}

function identityKey(identity: RemoteIdentity): string {
  return `${identity.account}/${identity.mailbox}/${identity.uidValidity}/${identity.uid}`;
}

function fakeFactory(): { readonly factory: ConnectionFactory; readonly calls: () => number } {
  let factoryCalls = 0;
  const factory: ConnectionFactory = async (config) => {
    factoryCalls += 1;
    const state = new Map<string, RemoteSnapshot>();
    const commands: CapturedCommand[] = [];
    const put = (target: FrozenTarget, snapshot: Omit<RemoteSnapshot, "identity">) => {
      state.set(identityKey(target), { identity: target, ...snapshot });
    };
    const command = (target: RemoteIdentity, name: string, destination?: string) => {
      commands.push({
        command: name,
        account: target.account,
        mailbox: target.mailbox,
        uid: target.uid,
        uidValidity: target.uidValidity,
        ...(destination === undefined ? {} : { destination }),
      });
    };
    const connection = {
      async provision(provisionedTargets: FrozenTargets, provisionedSentinels: typeof sentinels) {
        for (const target of [...Object.values(provisionedTargets), ...Object.values(provisionedSentinels)]) {
          command(target, "APPEND");
          put(target, { present: true, flags: [], markerVerified: target.marker === config.marker });
        }
      },
      async snapshot(identity: RemoteIdentity): Promise<RemoteSnapshot> {
        command(identity, "UID FETCH");
        const current = state.get(identityKey(identity));
        if (current === undefined) throw new Error("snapshot requested for an unknown identity");
        return { ...current, flags: [...current.flags] };
      },
      async mutate(action: QualificationAction, target: FrozenTarget): Promise<RemoteSnapshot> {
        const current = state.get(identityKey(target));
        if (current === undefined) throw new Error("mutation requested for an unknown identity");
        if (action === "markSeen" || action === "markUnseen") {
          command(target, "UID STORE");
          const flags = new Set(current.flags);
          if (action === "markSeen") flags.add("\\Seen");
          else flags.delete("\\Seen");
          const next = { ...current, flags: [...flags] };
          state.set(identityKey(target), next);
          return next;
        }
        command(target, "UID MOVE", action === "moveToArchive" ? archive : trash);
        const next = { ...current, present: false, mailbox: undefined };
        state.set(identityKey(target), next);
        return next;
      },
      async cleanup(cleanupTargets: FrozenTargets) {
        for (const target of Object.values(cleanupTargets)) command(target, "UID STORE");
      },
      commands: () => [...commands],
    };
    return connection;
  };
  return { factory, calls: () => factoryCalls };
}

describe("disposable live mutation harness", () => {
  test("fails closed for every missing or malformed prerequisite before connection construction", async () => {
    const keys = [
      LIVE_MUTATION_CONFIRMATION_ENV,
      LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV,
      LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV,
      LIVE_MUTATION_MARKER_ENV,
      LIVE_MUTATION_TARGETS_ENV,
      LIVE_MUTATION_SENTINELS_ENV,
      LIVE_MUTATION_EVIDENCE_DIR_ENV,
    ];
    for (const key of keys) {
      const input = environment({ [key]: undefined });
      const fake = fakeFactory();
      const evidence = dryValidateDisposableMutation(input);
      expect(evidence.status).toBe("blocked");
      expect(fake.calls()).toBe(0);
      expect(() => parseDisposableMutationConfig(input)).toThrow();
      const result = await qualifyDisposableMutationFromEnvironment(input, fake.factory);
      expect(result.status).toBe("blocked");
      expect(fake.calls()).toBe(0);
    }
    expect(
      dryValidateDisposableMutation(environment({ [LIVE_MUTATION_CONFIRMATION_ENV]: "yes" })).status,
    ).toBe("blocked");
    expect(
      dryValidateDisposableMutation(environment({ [LIVE_MUTATION_EVIDENCE_DIR_ENV]: "relative/path" })).status,
    ).toBe("blocked");
  });

  test("requires unique exact target and sentinel identities and never selects newest mail", () => {
    const duplicate = { ...targets, markUnseen: targets.markSeen };
    expect(() => parseDisposableMutationConfig(environment({ [LIVE_MUTATION_TARGETS_ENV]: encoded(duplicate) }))).toThrow(
      "target and sentinel identities must be unique",
    );
    const mismatchedMarker = { ...targets, markSeen: { ...targets.markSeen, marker: "other-marker" } };
    expect(() => parseDisposableMutationConfig(environment({ [LIVE_MUTATION_TARGETS_ENV]: encoded(mismatchedMarker) }))).toThrow(
      "configured marker",
    );
  });

  test("rejects target and sentinel mailbox/account mismatches", () => {
    const mismatched = { ...targets, moveToTrash: { ...targets.moveToTrash, mailbox: "mailbox:Other" } };
    expect(() => parseDisposableMutationConfig(environment({ [LIVE_MUTATION_TARGETS_ENV]: encoded(mismatched) }))).toThrow(
      "not allowlisted",
    );
  });

  test("scans command traces and rejects forbidden expunge, close, unknown commands, and targets", () => {
    const config = parseDisposableMutationConfig(environment());
    const valid: CapturedCommand = { command: "UID STORE", account, mailbox, uid: 101, uidValidity: 100 };
    expect(validateCommandTrace([valid], config)).toEqual([]);
    expect(validateCommandTrace([{ ...valid, command: "EXPUNGE" }], config)).toHaveLength(1);
    expect(validateCommandTrace([{ ...valid, command: "CLOSE" }], config)).toHaveLength(1);
    expect(validateCommandTrace([{ ...valid, command: "UID STORE", uid: 999 }], config)).toHaveLength(1);
    expect(validateCommandTrace([{ ...valid, command: "UID STORE", destination: "mailbox:Other" }], config)).toHaveLength(1);
  });

  test("runs all four actions and preserves unrelated and unread sentinels", async () => {
    const config = parseDisposableMutationConfig(environment());
    const fake = fakeFactory();
    const result = await qualifyDisposableMutation(config, fake.factory);
    expect(result.status).toBe("passed");
    expect(result.actions.map((action) => action.action)).toEqual([
      "markSeen",
      "markUnseen",
      "moveToArchive",
      "moveToTrash",
    ]);
    expect(result.actions.every((action) => action.passed)).toBe(true);
    expect(result.before.sentinels).toEqual(result.after.sentinels);
    expect(result.cleanupCommands.some((command) => command.command === "EXPUNGE")).toBe(false);
    if (result.evidencePath === undefined) throw new Error("expected retained evidence path");
    const retained = await Bun.file(result.evidencePath).text();
    expect(retained).toContain('"status": "passed"');
    expect(retained).toContain('"commands"');
    expect(fake.calls()).toBe(1);
  });

  test("redacts credentials and raw bodies while retaining truthful blocked status", () => {
    const output = formatRedactedEvidence({
      status: "failed",
      reason: "provider rejected a disposable target",
      qualification: {
        status: "failed",
        before: { sentinels: { unrelated: { identity: fixture(1), present: true, flags: [], markerVerified: true }, unread: { identity: fixture(2), present: true, flags: [], markerVerified: true } } },
        after: { sentinels: { unrelated: { identity: fixture(1), present: true, flags: [], markerVerified: true }, unread: { identity: fixture(2), present: true, flags: [], markerVerified: true } } },
        actions: [],
        commands: [],
        cleanupCommands: [],
      },
      password: "do-not-print",
      rawBody: "do-not-print",
    });
    expect(output).toContain('"status": "failed"');
    expect(output).toContain("<redacted>");
    expect(output).not.toContain("do-not-print");
    expect(formatRedactedEvidence(blockedEvidence("missing confirmation"))).toContain('"status": "blocked"');
  });
});
