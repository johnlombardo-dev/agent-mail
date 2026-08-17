import { Database } from "bun:sqlite";
import {
  createRemoteUidValue,
  createUidValidity,
  createUtcInstant,
  parseAccountId,
  parseMailboxId,
  type AccountId,
  type MailboxId,
  type RemoteUidValue,
  type UtcInstant,
  type UidValidity,
} from "@agent-mail/core";
import {
  tombstoneRemotePlacement,
  type RemotePlacementTombstoneInput,
} from "./remote-placement-tombstone";

/** Keep this aligned with the accepted bounded metadata-batch contract. */
export const MAX_ABSENCE_QUERY_UIDS = 10_000;
const MAX_OBSERVATION_TEXT_BYTES = 200;

type RecordValue = Readonly<Record<string, unknown>>;

export type AbsenceReconciliationSkipReason =
  | "invalid-observation"
  | "transport-incomplete"
  | "transport-unauthoritative"
  | "target-out-of-scope"
  | "missing-out-of-scope"
  | "scope-incomplete"
  | "target-not-explicitly-missing"
  | "target-present"
  | "present-item-identity-mismatch"
  | "present-item-out-of-scope"
  | "present-item-contradicts-missing";

export type AbsenceReconciliationResult =
  | Readonly<{
      readonly status: "tombstoned";
      readonly sourceCheckpoint: string;
      readonly observationId: string;
    }>
  | Readonly<{
      readonly status: "skipped";
      readonly reason: AbsenceReconciliationSkipReason;
    }>;

export type AbsenceTombstoneWriter = (input: RemotePlacementTombstoneInput) => void;

/** Untrusted, bounded observation envelope accepted by the reconciler. */
export type AbsenceObservationInput = Readonly<{
  readonly accountId: unknown;
  readonly mailboxId: unknown;
  readonly uidValidity: unknown;
  readonly uid: unknown;
  readonly queriedUidScope: unknown;
  readonly missingUids: unknown;
  readonly items: unknown;
  readonly checkpoint: unknown;
  readonly observationId: unknown;
  readonly observedAt: unknown;
  readonly transport: unknown;
}>;

export type AbsenceReconciliationService = Readonly<{
  readonly reconcile: (observation: unknown) => AbsenceReconciliationResult;
}>;

type TransportObservation =
  | Readonly<{
      readonly completion: "complete";
      readonly authority: "authoritative" | "non-authoritative" | "unknown";
    }>
  | Readonly<{
      readonly completion: "partial" | "error" | "unknown";
      readonly authority: "non-authoritative" | "unknown";
    }>;

type ParsedAbsenceObservation = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
  readonly queriedUidScope: readonly RemoteUidValue[];
  readonly missingUids: readonly RemoteUidValue[];
  readonly presentItems: readonly RemotePlacementIdentity[];
  readonly checkpoint: string;
  readonly observationId: string;
  readonly observedAt: UtcInstant;
  readonly transport: TransportObservation;
}>;

type RemotePlacementIdentity = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
}>;

/**
 * Construct a single-placement absence reconciler. The writer is the only
 * mutation capability; an unauthorized observation never reaches it.
 */
export function createAbsenceReconciliationService(
  writeTombstone: AbsenceTombstoneWriter,
): AbsenceReconciliationService {
  return {
    reconcile(observation: unknown): AbsenceReconciliationResult {
      const parsed = parseObservation(observation);
      if (parsed === undefined) return { status: "skipped", reason: "invalid-observation" };

      if (parsed.transport.completion !== "complete") {
        return { status: "skipped", reason: "transport-incomplete" };
      }
      if (parsed.transport.authority !== "authoritative") {
        return { status: "skipped", reason: "transport-unauthoritative" };
      }

      const target = parsed.uid;
      if (!parsed.queriedUidScope.includes(target)) {
        return { status: "skipped", reason: "target-out-of-scope" };
      }
      if (parsed.missingUids.some((uid) => !parsed.queriedUidScope.includes(uid))) {
        return { status: "skipped", reason: "missing-out-of-scope" };
      }
      if (!parsed.missingUids.includes(target)) {
        return { status: "skipped", reason: "target-not-explicitly-missing" };
      }

      for (const item of parsed.presentItems) {
        if (
          item.accountId !== parsed.accountId ||
          item.mailboxId !== parsed.mailboxId ||
          item.uidValidity !== parsed.uidValidity
        ) {
          return { status: "skipped", reason: "present-item-identity-mismatch" };
        }
        if (!parsed.queriedUidScope.includes(item.uid)) {
          return { status: "skipped", reason: "present-item-out-of-scope" };
        }
        if (parsed.missingUids.includes(item.uid)) {
          return { status: "skipped", reason: "present-item-contradicts-missing" };
        }
        if (item.uid === target) {
          return { status: "skipped", reason: "target-present" };
        }
      }

      const accountedUids = new Set([
        ...parsed.missingUids,
        ...parsed.presentItems.map((item) => item.uid),
      ]);
      if (parsed.queriedUidScope.some((scopeUid) => !accountedUids.has(scopeUid))) {
        return { status: "skipped", reason: "scope-incomplete" };
      }

      const reason =
        `authoritative absence; observation=${parsed.observationId}; ` +
        `observedAt=${parsed.observedAt}; checkpoint=${parsed.checkpoint}; ` +
        `placement=${parsed.accountId}/${parsed.mailboxId}/${parsed.uidValidity}/${parsed.uid}; ` +
        `scopeCount=${parsed.queriedUidScope.length}; missing=${parsed.uid}`;
      writeTombstone({
        accountId: parsed.accountId,
        mailboxId: parsed.mailboxId,
        uidValidity: parsed.uidValidity,
        uid: parsed.uid,
        observedAt: parsed.observedAt,
        sourceCheckpoint: parsed.checkpoint,
        reason,
      });
      return {
        status: "tombstoned",
        sourceCheckpoint: parsed.checkpoint,
        observationId: parsed.observationId,
      };
    },
  };
}

/** Use the accepted real SQLite tombstone+journal transaction as the writer. */
export function createSqliteAbsenceReconciliationService(
  database: Database,
): AbsenceReconciliationService {
  return createAbsenceReconciliationService((input) => {
    tombstoneRemotePlacement(database, input);
  });
}

function parseObservation(value: unknown): ParsedAbsenceObservation | undefined {
  try {
    const record = requireExactRecord(value, [
      "accountId",
      "mailboxId",
      "uidValidity",
      "uid",
      "queriedUidScope",
      "missingUids",
      "items",
      "checkpoint",
      "observationId",
      "observedAt",
      "transport",
    ]);
    return {
      accountId: parseAccountId(record.accountId),
      mailboxId: parseMailboxId(record.mailboxId),
      uidValidity: createUidValidity(record.uidValidity),
      uid: createRemoteUidValue(record.uid),
      queriedUidScope: parseUidList(record.queriedUidScope, "queried UID scope"),
      missingUids: parseUidList(record.missingUids, "missing UIDs", true),
      presentItems: parsePresentItems(record.items),
      checkpoint: boundedText(record.checkpoint, "checkpoint"),
      observationId: boundedText(record.observationId, "observation identity"),
      observedAt: createUtcInstant(record.observedAt),
      transport: parseTransport(record.transport),
    };
  } catch {
    return undefined;
  }
}

function parseTransport(value: unknown): TransportObservation {
  const record = requireRecord(value, "transport");
  if (hasExactKeys(record, ["completion", "authority"])) {
    const completion = record.completion;
    const authority = record.authority;
    if (completion === "complete") {
      if (
        authority === "authoritative" ||
        authority === "non-authoritative" ||
        authority === "unknown"
      ) {
        return { completion, authority };
      }
    } else if (
      (completion === "partial" || completion === "error" || completion === "unknown") &&
      (authority === "non-authoritative" || authority === "unknown")
    ) {
      return { completion, authority };
    }
  }
  if (hasExactKeys(record, ["completed", "authoritative"])) {
    if (record.completed === true && record.authoritative === true) {
      return { completion: "complete", authority: "authoritative" };
    }
    if (typeof record.completed === "boolean" && typeof record.authoritative === "boolean") {
      return {
        completion: record.completed ? "complete" : "partial",
        authority: "non-authoritative",
      };
    }
  }
  throw new TypeError("transport completion and authority are invalid");
}

function parseUidList(value: unknown, name: string, allowEmpty = false): readonly RemoteUidValue[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_ABSENCE_QUERY_UIDS
  ) {
    throw new TypeError(`${name} must be a bounded${allowEmpty ? "" : ", non-empty"} array`);
  }
  const parsed = value.map((item) => createRemoteUidValue(item));
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${name} must be unique`);
  return Object.freeze(parsed);
}

function parsePresentItems(value: unknown): readonly RemotePlacementIdentity[] {
  if (!Array.isArray(value) || value.length > MAX_ABSENCE_QUERY_UIDS) {
    throw new TypeError("present items must be a bounded array");
  }
  const items = value.map((item) => parsePresentItem(item));
  const identities = items.map((item) => identityKey(item));
  if (new Set(identities).size !== identities.length) {
    throw new TypeError("present items must have unique identities");
  }
  return Object.freeze(items);
}

function parsePresentItem(value: unknown): RemotePlacementIdentity {
  const record = requireRecord(value, "present item");
  const candidate = Object.prototype.hasOwnProperty.call(record, "identity")
    ? requireRecord(record.identity, "present item identity")
    : record;
  return {
    accountId: parseAccountId(requireField(candidate, "accountId")),
    mailboxId: parseMailboxId(requireField(candidate, "mailboxId")),
    uidValidity: createUidValidity(requireField(candidate, "uidValidity")),
    uid: createRemoteUidValue(requireField(candidate, "uid")),
  };
}

function identityKey(identity: RemotePlacementIdentity): string {
  return `${identity.accountId}\u0000${identity.mailboxId}\u0000${identity.uidValidity}\u0000${identity.uid}`;
}

function requireExactRecord(value: unknown, keys: readonly string[]): RecordValue {
  const record = requireRecord(value, "absence observation");
  if (!hasExactKeys(record, keys)) throw new TypeError("absence observation fields are invalid");
  return record;
}

function requireRecord(value: unknown, name: string): RecordValue {
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && expected.has(key))
  );
}

function requireField(value: RecordValue, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new TypeError(`present item is missing ${key}`);
  }
  return value[key];
}

function boundedText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_OBSERVATION_TEXT_BYTES ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`${name} must be a bounded, non-empty trimmed string`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 31) || (codePoint >= 127 && codePoint <= 159))
    ) {
      return true;
    }
  }
  return false;
}
