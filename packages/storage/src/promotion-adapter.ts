import type { Database } from "bun:sqlite";
import {
  createRoutingDecision,
  parseAccountId,
  parseBlobId,
  parseMailboxId,
  parseMessageId,
  parseUtcInstant,
  type AccountId,
  type BlobId,
  type MailboxId,
  type MessageId,
  type RoutingDecision,
} from "@agent-mail/core";
import {
  CanonicalPromotionError,
  promoteCanonicalMessage,
  type PromotionAddress,
  type PromotionAttachment,
  type PromotionBodyPart,
  type PromotionFailureInjector,
  type PromotionHeader,
  type PromotionJournalEvent,
  type PromotionPlacement,
  type PromotionRoutingDecision,
  type PromotionUnit,
  type PromoteCanonicalMessageOptions,
} from "./canonical-promotion";
import { canonicalRoutingDecisionId } from "./routing-decision-identity";

/** The only caller-facing operation for canonical promotion. */
export interface PromotionStoragePort {
  readonly promote: (input: unknown) => PromotionCommit;
}

/** The identity returned only after the underlying promotion transaction commits. */
export type PromotionCommit = Readonly<{
  readonly messageId: MessageId;
  readonly placementIds: readonly PromotionPlacementIdentity[];
  readonly routingDecisionIds: readonly string[];
  readonly journalId: string;
  readonly status: "committed" | "duplicate";
}>;

export type PromotionPlacementIdentity = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: number;
  readonly uid: number;
}>;

export type PromotionAdapterErrorCode =
  | "invalid-input"
  | "constraint"
  | "busy"
  | "storage"
  | "conflicting-identity";

/** Stable caller-facing errors; SQLite/provider diagnostics remain causes. */
export class PromotionAdapterError extends Error {
  readonly code: PromotionAdapterErrorCode;

  constructor(code: PromotionAdapterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromotionAdapterError";
    this.code = code;
  }
}

/**
 * Parse an untrusted caller value into the immutable unit accepted by the
 * canonical transaction. The adapter is the trust boundary; the primitive
 * itself remains intentionally typed and transport-free.
 */
export function parsePromotionUnit(value: unknown): PromotionUnit {
  const input = record(value, "promotion unit");
  exact(
    input,
    [
      "messageId",
      "placements",
      "headers",
      "addresses",
      "bodyParts",
      "attachments",
      "routingDecisions",
      "journal",
    ],
    "promotion unit",
  );

  const unit: PromotionUnit = {
    messageId: parseCanonicalMessageId(input.messageId),
    placements: array(input.placements, "promotion placements").map(parsePlacement),
    headers: array(input.headers, "promotion headers").map(parseHeader),
    addresses: array(input.addresses, "promotion addresses").map(parseAddress),
    bodyParts: array(input.bodyParts, "promotion body parts").map(parseBodyPart),
    attachments: array(input.attachments, "promotion attachments").map(parseAttachment),
    routingDecisions: array(input.routingDecisions, "promotion routing decisions").map(
      parseRouting,
    ),
    journal: parseJournal(input.journal),
  };
  freezeDeep(unit);
  return unit;
}

export type SqlitePromotionAdapterOptions = Readonly<{
  /** Failure-injection seam used by the real adapter contract fixture. */
  readonly beforeWrite?: PromotionFailureInjector;
}>;

/** Adapt the real #73 SQLite primitive to the narrow caller-facing port. */
export function createSqlitePromotionAdapter(
  database: Database,
  options: SqlitePromotionAdapterOptions = {},
): PromotionStoragePort {
  const primitiveOptions: PromoteCanonicalMessageOptions = { beforeWrite: options.beforeWrite };
  return {
    promote(input: unknown): PromotionCommit {
      try {
        const unit = parsePromotionUnit(input);
        const result = promoteCanonicalMessage(database, unit, primitiveOptions);
        return commitFromUnit(unit, result.status);
      } catch (error: unknown) {
        throw normalizePromotionError(error);
      }
    },
  };
}

function commitFromUnit(unit: PromotionUnit, status: PromotionCommit["status"]): PromotionCommit {
  const result: PromotionCommit = {
    messageId: unit.messageId,
    placementIds: unit.placements.map((placement) => ({
      accountId: placement.accountId,
      mailboxId: placement.mailboxId,
      uidValidity: placement.uidValidity,
      uid: placement.uid,
    })),
    routingDecisionIds: unit.routingDecisions.map((routing) =>
      canonicalRoutingDecisionId(unit.messageId, routing.decision),
    ),
    journalId: unit.journal.id,
    status,
  };
  freezeDeep(result);
  return result;
}

function normalizePromotionError(error: unknown): PromotionAdapterError {
  if (error instanceof PromotionAdapterError) return error;
  if (error instanceof TypeError) {
    return new PromotionAdapterError("invalid-input", "promotion input is invalid", {
      cause: error,
    });
  }
  if (error instanceof CanonicalPromotionError) {
    if (error.code === "conflicting-identity") {
      return new PromotionAdapterError(
        "conflicting-identity",
        "canonical message identity already has different promotion content",
        { cause: error },
      );
    }
    return new PromotionAdapterError(classifyStorageError(error), stableStorageMessage(error), {
      cause: error,
    });
  }
  return new PromotionAdapterError(classifyStorageError(error), stableStorageMessage(error), {
    cause: error,
  });
}

function classifyStorageError(
  error: unknown,
): Exclude<PromotionAdapterErrorCode, "invalid-input" | "conflicting-identity"> {
  if (hasErrorCode(error, "SQLITE_BUSY") || hasErrorCode(error, "SQLITE_LOCKED")) return "busy";
  if (
    hasErrorCode(error, "SQLITE_CONSTRAINT") ||
    hasErrorCode(error, "SQLITE_CONSTRAINT_FOREIGNKEY") ||
    hasErrorCode(error, "SQLITE_CONSTRAINT_PRIMARYKEY") ||
    hasErrorCode(error, "SQLITE_CONSTRAINT_UNIQUE") ||
    messageContains(error, "constraint failed")
  ) {
    return "constraint";
  }
  return "storage";
}

function stableStorageMessage(error: unknown): string {
  const code = classifyStorageError(error);
  if (code === "busy") return "canonical promotion storage is busy";
  if (code === "constraint") return "canonical promotion violates a storage constraint";
  return "canonical promotion storage failed";
}

function hasErrorCode(error: unknown, expected: string): boolean {
  let current: unknown = error;
  const visited = new Set<object>();
  while (isRecordLike(current) && !visited.has(current)) {
    visited.add(current);
    const code = current.code;
    if (typeof code === "string" && code === expected) return true;
    current = current.cause;
  }
  return false;
}

function messageContains(error: unknown, text: string): boolean {
  let current: unknown = error;
  const visited = new Set<object>();
  while (isRecordLike(current) && !visited.has(current)) {
    visited.add(current);
    if (typeof current.message === "string" && current.message.toLowerCase().includes(text)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function parsePlacement(value: unknown): PromotionPlacement {
  const input = record(value, "promotion placement");
  exact(input, ["accountId", "mailboxId", "uidValidity", "uid"], "promotion placement");
  return {
    accountId: parseAccountId(input.accountId),
    mailboxId: parseMailboxId(input.mailboxId),
    uidValidity: uint32(input.uidValidity, "UIDVALIDITY"),
    uid: uint32(input.uid, "UID"),
  };
}

function parseCanonicalMessageId(value: unknown): MessageId {
  const messageId = parseMessageId(value);
  if (!/^message:[0-9a-f]{64}$/u.test(messageId)) {
    throw new TypeError("message ID must be a canonical 64-hex message identity");
  }
  return messageId;
}

function parseHeader(value: unknown): PromotionHeader {
  const input = record(value, "promotion header");
  exact(
    input,
    ["ordinal", "name", "normalizedName", "value", "normalizedValue"],
    "promotion header",
  );
  return {
    ordinal: positiveInteger(input.ordinal, "header ordinal"),
    name: boundedText(input.name, "header name", 255),
    normalizedName: boundedLowerText(input.normalizedName, "normalized header name", 255),
    value: boundedText(input.value, "header value", 4096),
    normalizedValue: boundedText(input.normalizedValue, "normalized header value", 4096),
  };
}

function parseAddress(value: unknown): PromotionAddress {
  const input = record(value, "promotion address");
  exact(
    input,
    ["ordinal", "role", "position", "address", "normalizedAddress", "displayName", "groupName"],
    "promotion address",
  );
  const role = input.role;
  if (
    role !== "from" &&
    role !== "sender" &&
    role !== "reply_to" &&
    role !== "to" &&
    role !== "cc" &&
    role !== "bcc"
  )
    throw new TypeError("promotion address role is invalid");
  return {
    ordinal: positiveInteger(input.ordinal, "address ordinal"),
    role,
    position: positiveInteger(input.position, "address position"),
    address: boundedText(input.address, "address", 1024),
    normalizedAddress: boundedText(input.normalizedAddress, "normalized address", 1024),
    displayName: nullableBoundedText(input.displayName, "display name", 4096),
    groupName: nullableBoundedText(input.groupName, "group name", 4096),
  };
}

function parseBodyPart(value: unknown): PromotionBodyPart {
  const input = record(value, "promotion body part");
  exact(
    input,
    ["ordinal", "contentType", "normalizedContentType", "blobId"],
    "promotion body part",
  );
  return {
    ordinal: positiveInteger(input.ordinal, "body part ordinal"),
    contentType: boundedText(input.contentType, "content type", 255),
    normalizedContentType: boundedLowerText(
      input.normalizedContentType,
      "normalized content type",
      255,
    ),
    blobId: parseCanonicalBlobId(input.blobId),
  };
}

function parseAttachment(value: unknown): PromotionAttachment {
  const input = record(value, "promotion attachment");
  exact(
    input,
    [
      "ordinal",
      "filename",
      "contentType",
      "normalizedContentType",
      "disposition",
      "contentId",
      "size",
      "blobId",
    ],
    "promotion attachment",
  );
  return {
    ordinal: positiveInteger(input.ordinal, "attachment ordinal"),
    filename: nullableBoundedText(input.filename, "attachment filename", 4096),
    contentType: boundedText(input.contentType, "attachment content type", 255),
    normalizedContentType: boundedLowerText(
      input.normalizedContentType,
      "normalized attachment content type",
      255,
    ),
    disposition: nullableBoundedText(input.disposition, "attachment disposition", 255),
    contentId: nullableBoundedText(input.contentId, "attachment content ID", 1024),
    size: nonNegativeInteger(input.size, "attachment size"),
    blobId: parseCanonicalBlobId(input.blobId),
  };
}

function parseCanonicalBlobId(value: unknown): BlobId {
  const blobId = parseBlobId(value);
  if (!/^blob:[0-9a-f]{64}$/u.test(blobId)) {
    throw new TypeError("blob ID must be a canonical 64-hex blob identity");
  }
  return blobId;
}

function parseRouting(value: unknown): PromotionRoutingDecision {
  const input = record(value, "promotion routing decision");
  exact(input, ["decisionId", "decision"], "promotion routing decision");
  return {
    decisionId: boundedText(input.decisionId, "routing decision ID", 200),
    decision: parseDecision(input.decision),
  };
}

function parseDecision(value: unknown): RoutingDecision {
  return createRoutingDecision(value);
}

function parseJournal(value: unknown): PromotionJournalEvent {
  const input = record(value, "promotion journal event");
  exact(
    input,
    ["id", "occurredAt", "category", "subjectId", "correlationId", "payloadVersion", "payloadJson"],
    "promotion journal event",
  );
  const category = input.category;
  if (
    category !== "sync" &&
    category !== "routing" &&
    category !== "action" &&
    category !== "recovery" &&
    category !== "administrative"
  )
    throw new TypeError("promotion journal category is invalid");
  const payloadJson = boundedText(input.payloadJson, "journal payload", 16384);
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch (error: unknown) {
    throw new TypeError("journal payload must be valid JSON", { cause: error });
  }
  if (!isPlainRecord(payload) || JSON.stringify(payload) !== payloadJson) {
    throw new TypeError("journal payload must be canonical JSON object text");
  }
  return {
    id: boundedText(input.id, "journal ID", 200),
    occurredAt: parseUtcInstant(input.occurredAt),
    category,
    subjectId: boundedText(input.subjectId, "journal subject ID", 200),
    correlationId: boundedText(input.correlationId, "journal correlation ID", 200),
    payloadVersion: boundedInteger(input.payloadVersion, "journal payload version", 1, 255),
    payloadJson,
  };
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw new TypeError(`${name} has symbol fields`);
  return Object.fromEntries(Object.entries(value));
}

function exact(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  name: string,
): void {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !allowed.has(key))) {
    throw new TypeError(`${name} has missing or unknown fields`);
  }
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new TypeError(`${name} must be a trimmed string of 1-${maximum} characters`);
  }
  return value;
}

function boundedLowerText(value: unknown, name: string, maximum: number): string {
  const text = boundedText(value, name, maximum);
  if (text !== text.toLowerCase()) throw new TypeError(`${name} must be lowercase`);
  return text;
}

function nullableBoundedText(value: unknown, name: string, maximum: number): string | null {
  if (value === null) return null;
  return boundedText(value, name, maximum);
}

function positiveInteger(value: unknown, name: string): number {
  return boundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function uint32(value: unknown, name: string): number {
  return boundedInteger(value, name, 1, 4_294_967_295);
}

function nonNegativeInteger(value: unknown, name: string): number {
  return boundedInteger(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
    if (codePoint !== undefined && codePoint > 0xffff) index += 1;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isRecordLike(
  value: unknown,
): value is Readonly<Record<string, unknown>> & { readonly cause?: unknown } {
  return typeof value === "object" && value !== null;
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export type { PromotionUnit } from "./canonical-promotion";
