/**
 * Fail-closed qualification harness for an explicitly disposable mailbox.
 *
 * This module has no provider connection and no credential lookup. A future
 * authorized runner must supply the connection factory explicitly. Keeping
 * that capability out of the default script is deliberate: prerequisite
 * validation and dry evidence are useful locally, while accidental iCloud
 * access is not.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const LIVE_MUTATION_CONFIRMATION = "I_UNDERSTAND_DISPOSABLE_MUTATION";
export const LIVE_MUTATION_CONFIRMATION_ENV = "AGENT_MAIL_LIVE_MUTATION_CONFIRM";
export const LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV = "AGENT_MAIL_LIVE_MUTATION_ACCOUNT_ALLOWLIST";
export const LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV = "AGENT_MAIL_LIVE_MUTATION_MAILBOX_ALLOWLIST";
export const LIVE_MUTATION_MARKER_ENV = "AGENT_MAIL_LIVE_MUTATION_MARKER";
export const LIVE_MUTATION_TARGETS_ENV = "AGENT_MAIL_LIVE_MUTATION_TARGETS";
export const LIVE_MUTATION_SENTINELS_ENV = "AGENT_MAIL_LIVE_MUTATION_SENTINELS";
export const LIVE_MUTATION_EVIDENCE_DIR_ENV = "AGENT_MAIL_LIVE_MUTATION_EVIDENCE_DIR";

export type QualificationAction = "markSeen" | "markUnseen" | "moveToArchive" | "moveToTrash";

export type RemoteIdentity = Readonly<{
  readonly account: string;
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly uid: number;
}>;

export type FrozenTarget = RemoteIdentity & Readonly<{ readonly marker: string }>;

export type FrozenTargets = Readonly<{
  readonly markSeen: FrozenTarget;
  readonly markUnseen: FrozenTarget;
  readonly moveToArchive: FrozenTarget;
  readonly moveToTrash: FrozenTarget;
}>;

export type SentinelSet = Readonly<{
  readonly unrelated: FrozenTarget;
  readonly unread: FrozenTarget;
}>;

export type DisposableMutationConfig = Readonly<{
  readonly confirmation: typeof LIVE_MUTATION_CONFIRMATION;
  readonly accountAllowlist: readonly string[];
  readonly mailboxAllowlist: readonly string[];
  readonly marker: string;
  readonly targets: FrozenTargets;
  readonly sentinels: SentinelSet;
  readonly evidenceDirectory: string;
}>;

export type BlockedEvidence = Readonly<{
  readonly status: "blocked";
  readonly reason: string;
  readonly prerequisites: readonly string[];
}>;

export type RemoteSnapshot = Readonly<{
  readonly identity: RemoteIdentity;
  readonly present: boolean;
  readonly flags: readonly string[];
  readonly mailbox?: string;
  readonly markerVerified: boolean;
}>;

export type CapturedCommand = Readonly<{
  readonly command: string;
  readonly account: string;
  readonly mailbox: string;
  readonly uid?: number;
  readonly uidValidity?: number;
  readonly destination?: string;
}>;

export type DisposableMutationConnection = Readonly<{
  readonly provision: (targets: FrozenTargets, sentinels: SentinelSet) => Promise<void>;
  readonly snapshot: (identity: RemoteIdentity) => Promise<RemoteSnapshot>;
  readonly mutate: (action: QualificationAction, target: FrozenTarget) => Promise<RemoteSnapshot>;
  readonly cleanup: (targets: FrozenTargets) => Promise<void>;
  readonly commands: () => readonly CapturedCommand[];
}>;

export type ConnectionFactory = (
  config: DisposableMutationConfig,
) => Promise<DisposableMutationConnection>;

export type QualificationResult = Readonly<{
  readonly status: "passed" | "failed";
  readonly before: Readonly<{ readonly sentinels: SentinelSetSnapshot }>;
  readonly after: Readonly<{ readonly sentinels: SentinelSetSnapshot }>;
  readonly actions: readonly ActionQualification[];
  readonly commands: readonly CapturedCommand[];
  readonly cleanupCommands: readonly CapturedCommand[];
  readonly evidencePath?: string;
  readonly failure?: string;
}>;

export type ActionQualification = Readonly<{
  readonly action: QualificationAction;
  readonly target: RemoteIdentity;
  readonly postcondition: RemoteSnapshot;
  readonly passed: boolean;
}>;

export type SentinelSetSnapshot = Readonly<{
  readonly unrelated: RemoteSnapshot;
  readonly unread: RemoteSnapshot;
}>;

export type RedactedEvidence =
  | BlockedEvidence
  | Readonly<{
      readonly status: "dry" | "live" | "failed" | "passed";
      readonly reason?: string;
      readonly qualification?: QualificationResult;
    }>;

const ACTIONS: readonly QualificationAction[] = [
  "markSeen",
  "markUnseen",
  "moveToArchive",
  "moveToTrash",
];
const ALLOWED_COMMANDS = new Set([
  "APPEND",
  "SELECT",
  "UID FETCH",
  "UID STORE",
  "UID MOVE",
  "UID COPY",
]);
const REDACTED = "<redacted>";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)))
      throw new TypeError(`${label} contains unsafe characters`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function identity(value: unknown, label: string): RemoteIdentity {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    account: requiredText(value.account, `${label}.account`),
    mailbox: requiredText(value.mailbox, `${label}.mailbox`),
    uidValidity: positiveInteger(value.uidValidity, `${label}.uidValidity`),
    uid: positiveInteger(value.uid, `${label}.uid`),
  };
}

function target(value: unknown, label: string, expectedMarker: string): FrozenTarget {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const parsed = identity(value, label);
  const marker = requiredText(value.marker, `${label}.marker`);
  if (marker !== expectedMarker)
    throw new TypeError(`${label}.marker must equal the configured marker`);
  return { ...parsed, marker };
}

function jsonObject(value: string, label: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
  if (!isRecord(parsed)) throw new TypeError(`${label} must be a JSON object`);
  return parsed;
}

function commaList(value: string, label: string): readonly string[] {
  const values = value.split(",").map((item) => requiredText(item.trim(), label));
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new TypeError(`${label} must contain unique values`);
  }
  return values;
}

export function validateDisposableMutationConfig(config: DisposableMutationConfig): void {
  if (config.confirmation !== LIVE_MUTATION_CONFIRMATION)
    throw new TypeError("disposable mutation confirmation is not exact");
  const accountAllowlist = commaList(config.accountAllowlist.join(","), "account allowlist");
  const mailboxAllowlist = commaList(config.mailboxAllowlist.join(","), "mailbox allowlist");
  const marker = requiredText(config.marker, "disposable marker");
  if (marker.length < 8 || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(marker))
    throw new TypeError("disposable marker is invalid");
  const all = [...Object.values(config.targets), ...Object.values(config.sentinels)];
  const identities = all.map(identityKey);
  if (new Set(identities).size !== identities.length)
    throw new TypeError("target and sentinel identities must be unique");
  for (const item of all) {
    if (!accountAllowlist.includes(item.account))
      throw new TypeError(`account is not allowlisted: ${item.account}`);
    if (!mailboxAllowlist.includes(item.mailbox))
      throw new TypeError(`mailbox is not allowlisted: ${item.mailbox}`);
    if (item.marker !== marker)
      throw new TypeError("target marker does not match disposable marker");
  }
  if (!isAbsolute(config.evidenceDirectory))
    throw new TypeError("evidence directory must be absolute");
}

export function parseDisposableMutationConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DisposableMutationConfig {
  const confirmation = environment[LIVE_MUTATION_CONFIRMATION_ENV];
  if (confirmation !== LIVE_MUTATION_CONFIRMATION) {
    throw new TypeError(
      `set ${LIVE_MUTATION_CONFIRMATION_ENV} exactly to ${LIVE_MUTATION_CONFIRMATION}`,
    );
  }
  const accountAllowlist = commaList(
    requiredText(
      environment[LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV],
      LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV,
    ),
    LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV,
  );
  const mailboxAllowlist = commaList(
    requiredText(
      environment[LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV],
      LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV,
    ),
    LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV,
  );
  const marker = requiredText(environment[LIVE_MUTATION_MARKER_ENV], LIVE_MUTATION_MARKER_ENV);
  if (marker.length < 8 || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(marker)) {
    throw new TypeError(`${LIVE_MUTATION_MARKER_ENV} must be a unique, descriptive marker`);
  }
  const targetRecord = jsonObject(
    requiredText(environment[LIVE_MUTATION_TARGETS_ENV], LIVE_MUTATION_TARGETS_ENV),
    LIVE_MUTATION_TARGETS_ENV,
  );
  const sentinelRecord = jsonObject(
    requiredText(environment[LIVE_MUTATION_SENTINELS_ENV], LIVE_MUTATION_SENTINELS_ENV),
    LIVE_MUTATION_SENTINELS_ENV,
  );
  const targetValues = {
    markSeen: target(targetRecord.markSeen, "targets.markSeen", marker),
    markUnseen: target(targetRecord.markUnseen, "targets.markUnseen", marker),
    moveToArchive: target(targetRecord.moveToArchive, "targets.moveToArchive", marker),
    moveToTrash: target(targetRecord.moveToTrash, "targets.moveToTrash", marker),
  } satisfies FrozenTargets;
  const sentinels = {
    unrelated: target(sentinelRecord.unrelated, "sentinels.unrelated", marker),
    unread: target(sentinelRecord.unread, "sentinels.unread", marker),
  } satisfies SentinelSet;
  const all = [...Object.values(targetValues), ...Object.values(sentinels)];
  const identities = all.map(identityKey);
  if (new Set(identities).size !== identities.length)
    throw new TypeError("target and sentinel identities must be unique");
  for (const item of all) {
    if (!accountAllowlist.includes(item.account))
      throw new TypeError(`account is not allowlisted: ${item.account}`);
    if (!mailboxAllowlist.includes(item.mailbox))
      throw new TypeError(`mailbox is not allowlisted: ${item.mailbox}`);
  }
  const evidenceDirectory = requiredText(
    environment[LIVE_MUTATION_EVIDENCE_DIR_ENV],
    LIVE_MUTATION_EVIDENCE_DIR_ENV,
  );
  if (!isAbsolute(evidenceDirectory))
    throw new TypeError(`${LIVE_MUTATION_EVIDENCE_DIR_ENV} must be absolute`);
  const config = {
    confirmation: LIVE_MUTATION_CONFIRMATION,
    accountAllowlist,
    mailboxAllowlist,
    marker,
    targets: targetValues,
    sentinels,
    evidenceDirectory: resolve(evidenceDirectory),
  } satisfies DisposableMutationConfig;
  validateDisposableMutationConfig(config);
  return config;
}

function identityKey(value: RemoteIdentity): string {
  return `${value.account}\u0000${value.mailbox}\u0000${value.uidValidity}\u0000${value.uid}`;
}

function snapshotKey(value: RemoteSnapshot): string {
  return `${identityKey(value.identity)}\u0000${value.present}\u0000${value.mailbox ?? ""}\u0000${[...value.flags].sort().join(",")}\u0000${value.markerVerified}`;
}

async function sentinels(
  connection: DisposableMutationConnection,
  config: DisposableMutationConfig,
): Promise<SentinelSetSnapshot> {
  return {
    unrelated: await connection.snapshot(config.sentinels.unrelated),
    unread: await connection.snapshot(config.sentinels.unread),
  };
}

function sentinelsUnchanged(before: SentinelSetSnapshot, after: SentinelSetSnapshot): boolean {
  return (
    before.unrelated.markerVerified &&
    before.unread.markerVerified &&
    after.unrelated.markerVerified &&
    after.unread.markerVerified &&
    !before.unread.flags.includes("\\Seen") &&
    !after.unread.flags.includes("\\Seen") &&
    identityKey(before.unrelated.identity) === identityKey(after.unrelated.identity) &&
    identityKey(before.unread.identity) === identityKey(after.unread.identity) &&
    snapshotKey(before.unrelated) === snapshotKey(after.unrelated) &&
    snapshotKey(before.unread) === snapshotKey(after.unread)
  );
}

function postconditionMatches(
  action: QualificationAction,
  target: RemoteIdentity,
  snapshot: RemoteSnapshot,
): boolean {
  if (!snapshot.markerVerified || identityKey(snapshot.identity) !== identityKey(target))
    return false;
  switch (action) {
    case "markSeen":
      return snapshot.present && snapshot.flags.includes("\\Seen");
    case "markUnseen":
      return snapshot.present && !snapshot.flags.includes("\\Seen");
    case "moveToArchive":
    case "moveToTrash":
      return !snapshot.present && snapshot.mailbox === undefined;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function commandTargetAllowed(command: CapturedCommand, config: DisposableMutationConfig): boolean {
  const normalized = command.command.trim().toUpperCase();
  if (normalized === "EXPUNGE" || normalized === "CLOSE" || !ALLOWED_COMMANDS.has(normalized))
    return false;
  if (
    !config.accountAllowlist.includes(command.account) ||
    !config.mailboxAllowlist.includes(command.mailbox)
  )
    return false;
  if (command.destination !== undefined && !config.mailboxAllowlist.includes(command.destination))
    return false;
  const known = [...Object.values(config.targets), ...Object.values(config.sentinels)];
  if (command.uid === undefined) return true;
  return known.some(
    (item) =>
      item.uid === command.uid &&
      (command.uidValidity === undefined || command.uidValidity === item.uidValidity),
  );
}

export function validateCommandTrace(
  commands: readonly CapturedCommand[],
  config: DisposableMutationConfig,
): readonly string[] {
  return commands.flatMap((command, index) =>
    commandTargetAllowed(command, config) ? [] : [`command ${index} is outside the allowlist`],
  );
}

function validateCleanupTrace(
  commands: readonly CapturedCommand[],
  config: DisposableMutationConfig,
): readonly string[] {
  const disposableTargets = new Set(Object.values(config.targets).map(identityKey));
  return commands.flatMap((command, index) => {
    const normalized = command.command.trim().toUpperCase();
    const exactTarget =
      command.uid !== undefined &&
      [...disposableTargets].some((key) => {
        const [targetAccount, targetMailbox, targetUidValidity, targetUid] = key.split("\u0000");
        return (
          targetAccount === command.account &&
          targetMailbox === command.mailbox &&
          targetUid === String(command.uid) &&
          (command.uidValidity === undefined || targetUidValidity === String(command.uidValidity))
        );
      });
    return exactTarget && ["UID STORE", "UID MOVE", "UID COPY"].includes(normalized)
      ? []
      : [`cleanup command ${index} is outside the exact fixture allowlist`];
  });
}

async function retainEvidence(
  config: DisposableMutationConfig,
  evidence: RedactedEvidence,
): Promise<string> {
  const path = join(config.evidenceDirectory, "disposable-mutation.json");
  await writeFile(path, formatRedactedEvidence(evidence), { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function qualifyDisposableMutation(
  config: DisposableMutationConfig,
  connectionFactory: ConnectionFactory,
): Promise<QualificationResult> {
  validateDisposableMutationConfig(config);
  await mkdir(config.evidenceDirectory, { recursive: true });
  const connection = await connectionFactory(config);
  await connection.provision(config.targets, config.sentinels);
  const before = await sentinels(connection, config);
  const actions: ActionQualification[] = [];
  const cleanup = async (): Promise<
    Readonly<{ readonly commands: readonly CapturedCommand[]; readonly error?: string }>
  > => {
    const cleanupStart = connection.commands().length;
    try {
      await connection.cleanup(config.targets);
    } catch (error) {
      return {
        commands: connection.commands().slice(cleanupStart),
        error: error instanceof Error ? error.message : "cleanup failed",
      };
    }
    return { commands: connection.commands().slice(cleanupStart) };
  };
  try {
    for (const action of ACTIONS) {
      const frozenTarget = config.targets[action];
      const postcondition = await connection.mutate(action, frozenTarget);
      actions.push({
        action,
        target: frozenTarget,
        postcondition,
        passed: postconditionMatches(action, frozenTarget, postcondition),
      });
    }
    const cleanupResult = await cleanup();
    const after = await sentinels(connection, config);
    const allCommands = [...connection.commands()];
    const cleanupCommands = [...cleanupResult.commands];
    const traceErrors = validateCommandTrace(allCommands, config);
    const cleanupErrors = validateCleanupTrace(cleanupCommands, config);
    const passed =
      actions.every((item) => item.passed) &&
      sentinelsUnchanged(before, after) &&
      traceErrors.length === 0 &&
      cleanupErrors.length === 0;
    const result = {
      status: passed ? "passed" : "failed",
      before: { sentinels: before },
      after: { sentinels: after },
      actions,
      commands: allCommands,
      cleanupCommands,
      ...(passed
        ? {}
        : {
            failure: [
              ...traceErrors,
              ...cleanupErrors,
              ...(cleanupResult.error === undefined ? [] : [cleanupResult.error]),
              "postcondition or sentinel parity failed",
            ].join("; "),
          }),
    } satisfies QualificationResult;
    try {
      const evidencePath = await retainEvidence(config, {
        status: result.status,
        qualification: result,
      });
      return { ...result, evidencePath };
    } catch (error) {
      return {
        ...result,
        status: "failed",
        failure: `${result.failure ?? "qualification completed"}; evidence retention failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "qualification failed";
    const cleanupResult = await cleanup();
    let after = before;
    let afterError: string | undefined;
    try {
      after = await sentinels(connection, config);
    } catch (snapshotError) {
      afterError =
        snapshotError instanceof Error ? snapshotError.message : "post-cleanup snapshot failed";
    }
    const result = {
      status: "failed",
      before: { sentinels: before },
      after: { sentinels: after },
      actions,
      commands: [...connection.commands()],
      cleanupCommands: [...cleanupResult.commands],
      failure: [
        message,
        ...(cleanupResult.error === undefined ? [] : [cleanupResult.error]),
        ...(afterError === undefined ? [] : [afterError]),
      ].join("; "),
    } satisfies QualificationResult;
    try {
      const evidencePath = await retainEvidence(config, {
        status: "failed",
        qualification: result,
      });
      return { ...result, evidencePath };
    } catch (retentionError) {
      return {
        ...result,
        failure: `${result.failure}; evidence retention failed: ${retentionError instanceof Error ? retentionError.message : "unknown error"}`,
      };
    }
  }
}

/** Parse the external boundary before a caller can construct a connection. */
export async function qualifyDisposableMutationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  connectionFactory: ConnectionFactory,
): Promise<BlockedEvidence | QualificationResult> {
  let config: DisposableMutationConfig;
  try {
    config = parseDisposableMutationConfig(environment);
  } catch (error) {
    return blockedEvidence(error instanceof Error ? error.message : "invalid prerequisites");
  }
  return qualifyDisposableMutation(config, connectionFactory);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && /(credential|password|secret|token|authorization|raw|body)/iu.test(key))
    return REDACTED;
  if (typeof value === "string" && /(password|secret|token|bearer|raw body)/iu.test(value))
    return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]),
    );
  return value;
}

export function formatRedactedEvidence(evidence: unknown): string {
  return `${JSON.stringify(redactValue(evidence), null, 2)}\n`;
}

export function blockedEvidence(
  reason: string,
  prerequisites: readonly string[] = [],
): BlockedEvidence {
  return { status: "blocked", reason, prerequisites };
}

export function environmentForProcess(): Readonly<Record<string, string | undefined>> {
  return {
    [LIVE_MUTATION_CONFIRMATION_ENV]: process.env[LIVE_MUTATION_CONFIRMATION_ENV],
    [LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV]: process.env[LIVE_MUTATION_ACCOUNT_ALLOWLIST_ENV],
    [LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV]: process.env[LIVE_MUTATION_MAILBOX_ALLOWLIST_ENV],
    [LIVE_MUTATION_MARKER_ENV]: process.env[LIVE_MUTATION_MARKER_ENV],
    [LIVE_MUTATION_TARGETS_ENV]: process.env[LIVE_MUTATION_TARGETS_ENV],
    [LIVE_MUTATION_SENTINELS_ENV]: process.env[LIVE_MUTATION_SENTINELS_ENV],
    [LIVE_MUTATION_EVIDENCE_DIR_ENV]: process.env[LIVE_MUTATION_EVIDENCE_DIR_ENV],
  };
}

export function dryValidateDisposableMutation(
  environment: Readonly<Record<string, string | undefined>>,
):
  | BlockedEvidence
  | Readonly<{
      readonly status: "dry";
      readonly config: Omit<DisposableMutationConfig, "targets" | "sentinels">;
    }> {
  try {
    const config = parseDisposableMutationConfig(environment);
    return {
      status: "dry",
      config: {
        confirmation: config.confirmation,
        accountAllowlist: config.accountAllowlist,
        mailboxAllowlist: config.mailboxAllowlist,
        marker: config.marker,
        evidenceDirectory: config.evidenceDirectory,
      },
    };
  } catch (error) {
    return blockedEvidence(error instanceof Error ? error.message : "invalid prerequisites");
  }
}

if (import.meta.main) {
  const evidence = dryValidateDisposableMutation(environmentForProcess());
  process.stdout.write(formatRedactedEvidence(evidence));
}
