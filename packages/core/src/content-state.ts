/**
 * Constructive lifecycle states for one message's local content.
 *
 * This module intentionally owns only in-memory domain values. It does not
 * describe storage rows, parsers, or transition protocols.
 */

import {
  createRemoteUid,
  createRemoteUidValue,
  createUidValidity,
  parseAccountId,
  parseBlobId,
  parseMailboxId,
  parseMessageId,
  parseRemoteUid,
  parseUidValidity,
  type BlobId,
  type MessageId,
  type RemoteUid,
} from "./identifiers";

declare const stageHandleBrand: unique symbol;
declare const contentDiagnosticBrand: unique symbol;
declare const tombstoneReasonBrand: unique symbol;

/** A validated opaque handle for content that has not left the staging area. */
export type StageHandle = string & {
  readonly [stageHandleBrand]: "StageHandle";
};

/** A non-empty diagnostic attached to corrupt content. */
export type ContentDiagnostic = string & {
  readonly [contentDiagnosticBrand]: "ContentDiagnostic";
};

/** A non-empty explanation for why a content row was tombstoned. */
export type TombstoneReason = string & {
  readonly [tombstoneReasonBrand]: "TombstoneReason";
};

/** The only reasons an identity may be retained without readable content. */
export type ContentAbsenceReason = "not-fetched" | "provider-unavailable" | "redacted";

export const CONTENT_ABSENCE_REASONS = [
  "not-fetched",
  "provider-unavailable",
  "redacted",
] as const satisfies readonly ContentAbsenceReason[];

export interface StagedContentState {
  readonly kind: "staged";
  readonly messageId: MessageId;
  readonly stageHandle: StageHandle;
}

export interface ParsedContentState {
  readonly kind: "parsed";
  readonly messageId: MessageId;
  readonly stageHandle: StageHandle;
}

export interface PromotedContentState {
  readonly kind: "promoted";
  readonly messageId: MessageId;
  readonly blobId: BlobId;
}

export interface IdentityOnlyContentState {
  readonly kind: "identity-only";
  readonly messageId: MessageId;
  readonly remoteUid: RemoteUid;
  readonly absenceReason: ContentAbsenceReason;
}

export interface CorruptContentState {
  readonly kind: "corrupt";
  readonly messageId: MessageId;
  readonly diagnostic: ContentDiagnostic;
}

export interface TombstonedContentState {
  readonly kind: "tombstoned";
  readonly messageId: MessageId;
  readonly reason: TombstoneReason;
}

export type ContentState =
  | StagedContentState
  | ParsedContentState
  | PromotedContentState
  | IdentityOnlyContentState
  | CorruptContentState
  | TombstonedContentState;

type PlainRecord = Readonly<Record<string, unknown>>;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainRecord(value: unknown, label: string): PlainRecord {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireExactKeys(record: PlainRecord, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`unknown ${typeof key === "string" ? `field ${key}` : "symbol field"}`);
    }
  }
  if (Reflect.ownKeys(record).length !== allowedKeys.length) {
    throw new TypeError("content state is missing required fields");
  }
}

function requireNonEmptyText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

export function createStageHandle(value: unknown): StageHandle {
  return requireNonEmptyText(value, "stage handle") as StageHandle;
}

export function parseStageHandle(value: unknown): StageHandle {
  return createStageHandle(value);
}

export function createContentDiagnostic(value: unknown): ContentDiagnostic {
  return requireNonEmptyText(value, "content diagnostic") as ContentDiagnostic;
}

export function createTombstoneReason(value: unknown): TombstoneReason {
  return requireNonEmptyText(value, "tombstone reason") as TombstoneReason;
}

function isContentAbsenceReason(value: unknown): value is ContentAbsenceReason {
  return typeof value === "string" && CONTENT_ABSENCE_REASONS.some((reason) => reason === value);
}

function parseContentAbsenceReason(value: unknown): ContentAbsenceReason {
  if (!isContentAbsenceReason(value)) {
    throw new TypeError("content absence reason is not recognized");
  }
  return value;
}

function parseRemoteUidObject(value: unknown): RemoteUid {
  if (typeof value === "string") {
    return parseRemoteUid(value);
  }
  const record = requirePlainRecord(value, "remote UID");
  requireExactKeys(record, ["accountId", "mailboxId", "uidValidity", "uid"]);

  // Parsing each namespace before handing the values to the existing value
  // constructor prevents its ergonomic prefixing behavior from accepting a
  // malformed serialized identifier at this boundary.
  const accountId = parseAccountId(record.accountId);
  const mailboxId = parseMailboxId(record.mailboxId);
  const uidValidity =
    typeof record.uidValidity === "string"
      ? parseUidValidity(record.uidValidity)
      : createUidValidity(record.uidValidity);
  const uid = createRemoteUidValue(record.uid);
  return createRemoteUid({ accountId, mailboxId, uidValidity, uid });
}

export function createStagedContentState(value: unknown): StagedContentState {
  const record = requirePlainRecord(value, "staged content state");
  requireExactKeys(record, ["kind", "messageId", "stageHandle"]);
  if (record.kind !== "staged") {
    throw new TypeError("staged content state has the wrong kind");
  }
  return {
    kind: "staged",
    messageId: parseMessageId(record.messageId),
    stageHandle: parseStageHandle(record.stageHandle),
  };
}

export function createParsedContentState(value: unknown): ParsedContentState {
  const record = requirePlainRecord(value, "parsed content state");
  requireExactKeys(record, ["kind", "messageId", "stageHandle"]);
  if (record.kind !== "parsed") {
    throw new TypeError("parsed content state has the wrong kind");
  }
  return {
    kind: "parsed",
    messageId: parseMessageId(record.messageId),
    stageHandle: parseStageHandle(record.stageHandle),
  };
}

export function createPromotedContentState(value: unknown): PromotedContentState {
  const record = requirePlainRecord(value, "promoted content state");
  requireExactKeys(record, ["kind", "messageId", "blobId"]);
  if (record.kind !== "promoted") {
    throw new TypeError("promoted content state has the wrong kind");
  }
  return {
    kind: "promoted",
    messageId: parseMessageId(record.messageId),
    blobId: parseBlobId(record.blobId),
  };
}

export function createIdentityOnlyContentState(value: unknown): IdentityOnlyContentState {
  const record = requirePlainRecord(value, "identity-only content state");
  requireExactKeys(record, ["kind", "messageId", "remoteUid", "absenceReason"]);
  if (record.kind !== "identity-only") {
    throw new TypeError("identity-only content state has the wrong kind");
  }
  return {
    kind: "identity-only",
    messageId: parseMessageId(record.messageId),
    remoteUid: parseRemoteUidObject(record.remoteUid),
    absenceReason: parseContentAbsenceReason(record.absenceReason),
  };
}

export function createCorruptContentState(value: unknown): CorruptContentState {
  const record = requirePlainRecord(value, "corrupt content state");
  requireExactKeys(record, ["kind", "messageId", "diagnostic"]);
  if (record.kind !== "corrupt") {
    throw new TypeError("corrupt content state has the wrong kind");
  }
  return {
    kind: "corrupt",
    messageId: parseMessageId(record.messageId),
    diagnostic: createContentDiagnostic(record.diagnostic),
  };
}

export function createTombstonedContentState(value: unknown): TombstonedContentState {
  const record = requirePlainRecord(value, "tombstoned content state");
  requireExactKeys(record, ["kind", "messageId", "reason"]);
  if (record.kind !== "tombstoned") {
    throw new TypeError("tombstoned content state has the wrong kind");
  }
  return {
    kind: "tombstoned",
    messageId: parseMessageId(record.messageId),
    reason: createTombstoneReason(record.reason),
  };
}

export function createContentState(value: unknown): ContentState {
  const record = requirePlainRecord(value, "content state");
  if (typeof record.kind !== "string") {
    throw new TypeError("content state kind is required");
  }
  switch (record.kind) {
    case "staged":
      return createStagedContentState(record);
    case "parsed":
      return createParsedContentState(record);
    case "promoted":
      return createPromotedContentState(record);
    case "identity-only":
      return createIdentityOnlyContentState(record);
    case "corrupt":
      return createCorruptContentState(record);
    case "tombstoned":
      return createTombstonedContentState(record);
    default:
      throw new TypeError(`unknown content state kind: ${record.kind}`);
  }
}

/** Parse a JSON-shaped content state at the domain boundary. */
export const parseContentState = createContentState;

/** Return a JSON-safe state while preserving the discriminated domain shape. */
export function serializeContentState(value: ContentState): ContentState {
  switch (value.kind) {
    case "staged":
      return { ...value };
    case "parsed":
      return { ...value };
    case "promoted":
      return { ...value };
    case "identity-only":
      return { ...value, remoteUid: { ...value.remoteUid } };
    case "corrupt":
      return { ...value };
    case "tombstoned":
      return { ...value };
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}
