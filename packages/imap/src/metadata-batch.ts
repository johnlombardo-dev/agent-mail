import {
  createAccountId,
  createMailboxId,
  createMonotonicSequence,
  createRemoteUid,
  createRemoteUidValue,
  createUidValidity,
  createUtcInstant,
  type AccountId,
  type MailboxId,
  type MonotonicSequence,
  type RemoteUid,
  type RemoteUidValue,
  type UtcInstant,
  type UidValidity,
} from "@agent-mail/core";

/** Maximum number of UIDs represented by one metadata fetch. This matches the accepted sparse-range cap. */
export const MAX_METADATA_BATCH_UIDS = 10_000;
/** Maximum number of flags retained for one message, aligned with the MIME header-line limit. */
export const MAX_METADATA_FLAG_COUNT = 512;
/** Maximum UTF-8 bytes in one IMAP flag atom, matching the remote-action contract. */
export const MAX_METADATA_FLAG_BYTES = 128;
/** Maximum UTF-8 bytes in one normalized envelope text field. */
export const MAX_METADATA_TEXT_BYTES = 16 * 1024;
/** Maximum addresses retained in one envelope address list, aligned with the MIME header-line limit. */
export const MAX_METADATA_ADDRESS_COUNT = 512;

/** The only fields requested by the metadata fetch. ImapFlow adds MODSEQ when CONDSTORE applies. */
export const IMAP_METADATA_BATCH_QUERY = Object.freeze({
  uid: true,
  flags: true,
  envelope: true,
  size: true,
  internalDate: true,
} satisfies Readonly<{
  readonly uid: true;
  readonly flags: true;
  readonly envelope: true;
  readonly size: true;
  readonly internalDate: true;
}>);

export type MetadataBatchRequest = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uids: readonly RemoteUidValue[];
}>;

export type MetadataEnvelopeAddress = Readonly<{
  readonly name?: string;
  readonly address?: string;
}>;

export type MetadataEnvelope = Readonly<{
  readonly date?: UtcInstant;
  readonly subject?: string;
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly from?: readonly MetadataEnvelopeAddress[];
  readonly sender?: readonly MetadataEnvelopeAddress[];
  readonly replyTo?: readonly MetadataEnvelopeAddress[];
  readonly to?: readonly MetadataEnvelopeAddress[];
  readonly cc?: readonly MetadataEnvelopeAddress[];
  readonly bcc?: readonly MetadataEnvelopeAddress[];
}>;

export type MetadataModseq =
  | Readonly<{ readonly kind: "known"; readonly value: MonotonicSequence }>
  | Readonly<{ readonly kind: "unknown" }>;

export type MetadataBatchItem = Readonly<{
  readonly identity: RemoteUid;
  readonly flags: readonly string[];
  readonly modseq: MetadataModseq;
  readonly envelope: MetadataEnvelope;
  readonly size: number;
  readonly internalDate: UtcInstant;
}>;

export type MetadataBatchResult = Readonly<{
  readonly items: readonly MetadataBatchItem[];
  readonly missingUids: readonly RemoteUidValue[];
}>;

/** A narrow structural view of ImapFlow's fetchAll operation. Its result remains untrusted. */
export interface ImapFlowMetadataBatchClient {
  fetchAll(
    range: string,
    query: typeof IMAP_METADATA_BATCH_QUERY,
    options: Readonly<{ readonly uid: true }>,
  ): Promise<unknown>;
}

export interface MetadataBatchAdapter {
  fetch(request: MetadataBatchRequest): Promise<MetadataBatchResult>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): void {
  const expected = new Set(required);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`metadata batch request is missing ${key}`);
    }
  }
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw new TypeError("metadata batch request has unknown fields");
  }
}

function parseUidList(value: unknown): readonly RemoteUidValue[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("metadata batch uids must be a non-empty array");
  }
  if (value.length > MAX_METADATA_BATCH_UIDS) {
    throw new TypeError(`metadata batch exceeds ${MAX_METADATA_BATCH_UIDS} UIDs`);
  }
  const uids = value.map((item) => createRemoteUidValue(item));
  if (new Set(uids).size !== uids.length) {
    throw new TypeError("metadata batch uids must be unique");
  }
  return Object.freeze(uids);
}

/** Parse request data before it is used to construct an IMAP UID set. */
export function parseMetadataBatchRequest(value: unknown): MetadataBatchRequest {
  if (!isRecord(value)) throw new TypeError("metadata batch request must be an object");
  assertExactKeys(value, ["accountId", "mailboxId", "uidValidity", "uids"]);
  return {
    accountId: createAccountId(value.accountId),
    mailboxId: createMailboxId(value.mailboxId),
    uidValidity: createUidValidity(value.uidValidity),
    uids: parseUidList(value.uids),
  };
}

function invalidRow(message: string): TypeError {
  return new TypeError(`invalid IMAP metadata row: ${message}`);
}

function boundedText(
  value: unknown,
  name: string,
  maxBytes: number,
  options: Readonly<{ readonly allowEmpty?: boolean }> = {},
): string {
  if (typeof value !== "string") throw invalidRow(`${name} must be a string`);
  const normalized = value.normalize("NFC");
  let hasControl = false;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      hasControl = true;
      break;
    }
  }
  if (
    (options.allowEmpty !== true && normalized.trim().length === 0) ||
    Buffer.byteLength(normalized, "utf8") > maxBytes ||
    hasControl
  ) {
    throw invalidRow(`${name} is empty, contains controls, or exceeds ${maxBytes} bytes`);
  }
  return normalized;
}

function parseFlags(value: unknown): readonly string[] {
  if (value instanceof Set && value.size > MAX_METADATA_FLAG_COUNT) {
    throw invalidRow(`flags exceed ${MAX_METADATA_FLAG_COUNT} values`);
  }
  if (Array.isArray(value) && value.length > MAX_METADATA_FLAG_COUNT) {
    throw invalidRow(`flags exceed ${MAX_METADATA_FLAG_COUNT} values`);
  }
  const values = value instanceof Set ? [...value] : value;
  if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) {
    throw invalidRow("flags must be a Set or array of strings");
  }
  const flags = values.map((item) => boundedText(item, "flag", MAX_METADATA_FLAG_BYTES));
  if (new Set(flags).size !== flags.length) throw invalidRow("flags must be unique");
  return Object.freeze(flags);
}

function parseInstant(value: unknown, name: string): UtcInstant {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw invalidRow(`${name} must be a valid date`);
    return createUtcInstant(value.toISOString());
  }
  try {
    return createUtcInstant(value);
  } catch {
    throw invalidRow(`${name} must be an ISO instant`);
  }
}

function parseModseq(value: unknown): MetadataModseq {
  if (value === undefined || value === null) return { kind: "unknown" };
  if (typeof value === "bigint" && (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw invalidRow("modseq must be a non-negative safe integer");
  }
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  try {
    return { kind: "known", value: createMonotonicSequence(numberValue) };
  } catch {
    throw invalidRow("modseq must be a non-negative safe integer");
  }
}

const ENVELOPE_FIELDS = [
  "date",
  "subject",
  "messageId",
  "inReplyTo",
  "from",
  "sender",
  "replyTo",
  "to",
  "cc",
  "bcc",
] as const;

function parseAddress(value: unknown): MetadataEnvelopeAddress {
  if (!isRecord(value)) throw invalidRow("envelope address must be an object");
  if (Object.keys(value).some((key) => key !== "name" && key !== "address")) {
    throw invalidRow("envelope address has unknown fields");
  }
  const result: { name?: string; address?: string } = {};
  for (const key of ["name", "address"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      result[key] = boundedText(value[key], `envelope address ${key}`, MAX_METADATA_TEXT_BYTES, {
        allowEmpty: key === "name",
      });
    }
  }
  return Object.freeze(result);
}

function parseAddresses(value: unknown, name: string): readonly MetadataEnvelopeAddress[] {
  if (!Array.isArray(value)) throw invalidRow(`${name} must be an array`);
  if (value.length > MAX_METADATA_ADDRESS_COUNT) {
    throw invalidRow(`${name} exceeds ${MAX_METADATA_ADDRESS_COUNT} addresses`);
  }
  return Object.freeze(value.map((item) => parseAddress(item)));
}

function parseEnvelope(value: unknown): MetadataEnvelope {
  if (!isRecord(value)) throw invalidRow("envelope must be an object");
  const allowed = new Set<string>(ENVELOPE_FIELDS);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidRow("envelope has unknown fields");
  }
  const result: {
    date?: UtcInstant;
    subject?: string;
    messageId?: string;
    inReplyTo?: string;
    from?: readonly MetadataEnvelopeAddress[];
    sender?: readonly MetadataEnvelopeAddress[];
    replyTo?: readonly MetadataEnvelopeAddress[];
    to?: readonly MetadataEnvelopeAddress[];
    cc?: readonly MetadataEnvelopeAddress[];
    bcc?: readonly MetadataEnvelopeAddress[];
  } = {};
  for (const key of ENVELOPE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const field = value[key];
    if (key === "date") result.date = parseInstant(field, "envelope date");
    else if (
      key === "from" ||
      key === "sender" ||
      key === "replyTo" ||
      key === "to" ||
      key === "cc" ||
      key === "bcc"
    ) {
      result[key] = parseAddresses(field, `envelope ${key}`);
    } else {
      result[key] = boundedText(field, `envelope ${key}`, MAX_METADATA_TEXT_BYTES, {
        allowEmpty: key === "subject",
      });
    }
  }
  return Object.freeze(result);
}

function parseRow(
  value: unknown,
  request: MetadataBatchRequest,
  requested: ReadonlySet<RemoteUidValue>,
): MetadataBatchItem {
  if (!isRecord(value)) throw invalidRow("row must be an object");
  if (
    Object.prototype.hasOwnProperty.call(value, "source") ||
    Object.prototype.hasOwnProperty.call(value, "bodyParts") ||
    Object.prototype.hasOwnProperty.call(value, "binaryParts") ||
    Object.prototype.hasOwnProperty.call(value, "headers") ||
    Object.prototype.hasOwnProperty.call(value, "bodyStructure")
  ) {
    throw invalidRow("body fields are not allowed");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "uid")) throw invalidRow("uid is missing");
  const uid = createRemoteUidValue(value.uid);
  if (!requested.has(uid)) throw invalidRow("uid is outside the requested batch");
  if (!Object.prototype.hasOwnProperty.call(value, "flags")) throw invalidRow("flags are missing");
  if (!Object.prototype.hasOwnProperty.call(value, "envelope"))
    throw invalidRow("envelope is missing");
  if (!Object.prototype.hasOwnProperty.call(value, "size")) throw invalidRow("size is missing");
  if (!Object.prototype.hasOwnProperty.call(value, "internalDate")) {
    throw invalidRow("internalDate is missing");
  }
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw invalidRow("size must be a non-negative safe integer");
  }
  return {
    identity: createRemoteUid({
      accountId: request.accountId,
      mailboxId: request.mailboxId,
      uidValidity: request.uidValidity,
      uid,
    }),
    flags: parseFlags(value.flags),
    modseq: parseModseq(value.modseq),
    envelope: parseEnvelope(value.envelope),
    size: value.size,
    internalDate: parseInstant(value.internalDate, "internalDate"),
  };
}

function normalizeBatch(value: unknown, request: MetadataBatchRequest): MetadataBatchResult {
  if (!Array.isArray(value)) throw new TypeError("IMAP metadata fetch result must be an array");
  if (value.length > request.uids.length) {
    throw new TypeError("IMAP metadata fetch result exceeds the requested UID count");
  }
  const requested = new Set(request.uids);
  const seen = new Set<RemoteUidValue>();
  const items = value.map((item) => {
    const normalized = parseRow(item, request, requested);
    const uid = normalized.identity.uid;
    if (seen.has(uid)) throw new TypeError("invalid IMAP metadata batch: duplicate uid");
    seen.add(uid);
    return normalized;
  });
  items.sort((left, right) => left.identity.uid - right.identity.uid);
  const missingUids = request.uids.filter((uid) => !seen.has(uid));
  return Object.freeze({ items: Object.freeze(items), missingUids: Object.freeze(missingUids) });
}

/** Create a read-only metadata adapter over an opened ImapFlow-shaped client. */
export function createMetadataBatchAdapter(
  client: ImapFlowMetadataBatchClient,
): MetadataBatchAdapter {
  return {
    async fetch(request: MetadataBatchRequest): Promise<MetadataBatchResult> {
      const normalizedRequest = parseMetadataBatchRequest(request);
      const range = normalizedRequest.uids.join(",");
      const raw = await client.fetchAll(range, IMAP_METADATA_BATCH_QUERY, { uid: true });
      return normalizeBatch(raw, normalizedRequest);
    },
  };
}
