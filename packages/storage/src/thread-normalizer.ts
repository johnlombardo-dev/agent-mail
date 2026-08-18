import { createHash } from "node:crypto";
import {
  parseAccountId,
  parseMessageId,
  parseUtcInstant,
  type AccountId,
  type MessageId,
  type UtcInstant,
} from "@agent-mail/core";
import {
  THREAD_LIMITS,
  THREAD_NORMALIZER_VERSION,
  memberNodeKey,
  type NormalizedMessageId,
  type ThreadDiagnostic,
  type ThreadHeaderRow,
  type ThreadMessage,
  type ThreadNormalizedFacts,
  type ThreadParticipantFact,
} from "./thread-types";

const ASCII_ATEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/u;
const ASCII_DTEXT = /^[\x21-\x5a\x5e-\x7e]$/u;
const BAD_SCALAR = /[\u0000-\u001f\u007f-\u009f]/u;
const MESSAGE_ID = "message-id";
const REFERENCES = "references";
const IN_REPLY_TO = "in-reply-to";

export type ThreadNormalizationInput = Readonly<{
  readonly accountId: unknown;
  readonly messageId: unknown;
  readonly contentState?: "identity-only" | "parsed";
  readonly headers?: readonly ThreadHeaderRow[];
  readonly sentAt?: unknown;
  readonly receivedAt?: unknown;
  readonly participants?: readonly ThreadParticipantFact[];
}>;

export class ThreadNormalizationError extends Error {
  readonly code: "invalid-input" | "invalid-message-id";

  constructor(
    code: "invalid-input" | "invalid-message-id",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ThreadNormalizationError";
    this.code = code;
  }
}

type FieldResult = Readonly<{
  readonly values: readonly string[];
  readonly diagnostics: readonly ThreadDiagnostic[];
}>;

/**
 * Normalize the already unfolded MIME header values once at ingestion. This
 * parser intentionally does not accept raw EML and never returns a partial
 * field: one malformed token rejects that complete field.
 */
export function normalizeThreadFacts(input: ThreadNormalizationInput): ThreadNormalizedFacts {
  let accountId: AccountId;
  let messageId: MessageId;
  try {
    accountId = parseAccountId(input.accountId);
    messageId = parseMessageId(input.messageId);
  } catch (error: unknown) {
    throw new ThreadNormalizationError("invalid-input", "thread fact identity is invalid", {
      cause: error,
    });
  }
  if (!/^message:[0-9a-f]{64}$/u.test(messageId)) {
    throw new ThreadNormalizationError("invalid-message-id", "thread fact identity is invalid");
  }
  const headers = validateHeaders(input.headers === undefined ? [] : input.headers);
  const fields = new Map<string, ThreadHeaderRow[]>();
  for (const header of headers) {
    const rows = fields.get(header.normalizedName) ?? [];
    rows.push(header);
    fields.set(header.normalizedName, rows);
  }
  const messageIdRows = fields.get(MESSAGE_ID) ?? [];
  const referencesRows = fields.get(REFERENCES) ?? [];
  const inReplyToRows = fields.get(IN_REPLY_TO) ?? [];
  const messageIdResult = normalizeField(
    messageIdRows,
    MESSAGE_ID,
    1,
    1,
    THREAD_LIMITS.messageIdFieldBytes,
  );
  const referencesResult = normalizeField(
    referencesRows,
    REFERENCES,
    1,
    THREAD_LIMITS.referencesTokens,
    THREAD_LIMITS.referencesFieldBytes,
  );
  const inReplyToResult = normalizeField(
    inReplyToRows,
    IN_REPLY_TO,
    1,
    THREAD_LIMITS.inReplyToTokens,
    THREAD_LIMITS.inReplyToFieldBytes,
  );
  const normalizedMessageId =
    messageIdResult.values[0] === undefined
      ? undefined
      : toNormalizedMessageId(messageIdResult.values[0]);
  const diagnostics = [
    ...messageIdResult.diagnostics,
    ...referencesResult.diagnostics,
    ...inReplyToResult.diagnostics,
  ];
  if (messageIdRows.length === 0)
    diagnostics.push({ field: MESSAGE_ID, code: "absent", ordinal: null });
  if (normalizedMessageId !== undefined) {
    for (const [index, value] of referencesResult.values.entries()) {
      if (value === normalizedMessageId)
        diagnostics.push({ field: REFERENCES, code: "self-edge-suppressed", ordinal: index + 1 });
    }
    for (const [index, value] of inReplyToResult.values.entries()) {
      if (value === normalizedMessageId)
        diagnostics.push({ field: IN_REPLY_TO, code: "self-edge-suppressed", ordinal: index + 1 });
    }
  }
  for (let index = 0; index + 1 < referencesResult.values.length; index += 1) {
    if (referencesResult.values[index] === referencesResult.values[index + 1])
      diagnostics.push({ field: REFERENCES, code: "self-edge-suppressed", ordinal: index + 1 });
  }
  if (diagnostics.length > THREAD_LIMITS.diagnosticsPerMessage) {
    diagnostics.length = THREAD_LIMITS.diagnosticsPerMessage;
  }
  const sentAt = parseNullableInstant(input.sentAt);
  const receivedAt = parseNullableInstant(input.receivedAt);
  const contentState = input.contentState === undefined ? "parsed" : input.contentState;
  if (contentState !== "identity-only" && contentState !== "parsed") {
    throw new ThreadNormalizationError("invalid-input", "thread content state is invalid");
  }
  const factsWithoutHash = {
    content_state: contentState,
    normalizer_version: THREAD_NORMALIZER_VERSION,
    member_node_key: memberNodeKey(messageId),
    message_id_node_key:
      normalizedMessageId === undefined ? null : messageIdNodeKey(normalizedMessageId),
    references: referencesResult.values,
    in_reply_to: inReplyToResult.values,
    sent_at: sentAt,
    diagnostics: [...diagnostics].sort(compareDiagnostics),
  };
  const factsSha256 = createHash("sha256")
    .update(JSON.stringify(factsWithoutHash), "utf8")
    .digest("hex");
  const normalizedParticipants = normalizeParticipants(
    input.participants === undefined ? [] : input.participants,
  );
  const result: ThreadNormalizedFacts = {
    accountId,
    messageId,
    contentState,
    memberNodeKey: memberNodeKey(messageId),
    messageIdNodeKey:
      normalizedMessageId === undefined ? null : messageIdNodeKey(normalizedMessageId),
    normalizedMessageId: normalizedMessageId ?? null,
    references: Object.freeze(referencesResult.values.map(toNormalizedMessageId)),
    inReplyTo: Object.freeze(inReplyToResult.values.map(toNormalizedMessageId)),
    sentAt,
    receivedAt,
    diagnostics: Object.freeze([...factsWithoutHash.diagnostics]),
    factsSha256,
    participants: normalizedParticipants.values,
    participantsTruncated: normalizedParticipants.truncated,
  };
  return Object.freeze(result);
}

export const normalizeMessageThreadFacts = normalizeThreadFacts;

/** Parse a full collection of accepted header rows without retaining raw values. */
export function normalizeThreadHeaderFacts(
  accountId: unknown,
  messageId: unknown,
  headers: readonly ThreadHeaderRow[],
  options: Readonly<{
    readonly contentState?: "identity-only" | "parsed";
    readonly sentAt?: unknown;
    readonly receivedAt?: unknown;
    readonly participants?: readonly ThreadParticipantFact[];
  }> = {},
): ThreadNormalizedFacts {
  return normalizeThreadFacts({ accountId, messageId, headers, ...options });
}

function validateHeaders(value: readonly ThreadHeaderRow[]): readonly ThreadHeaderRow[] {
  if (!Array.isArray(value))
    throw new ThreadNormalizationError("invalid-input", "thread headers are invalid");
  return Object.freeze(
    value.map((header, index) => {
      if (
        !Number.isSafeInteger(header.ordinal) ||
        header.ordinal <= 0 ||
        typeof header.normalizedName !== "string" ||
        header.normalizedName.length === 0 ||
        header.normalizedName !== header.normalizedName.toLowerCase() ||
        typeof header.value !== "string"
      ) {
        throw new ThreadNormalizationError(
          "invalid-input",
          `thread header ${index + 1} is invalid`,
        );
      }
      return Object.freeze({
        ordinal: header.ordinal,
        normalizedName: header.normalizedName,
        value: header.value,
      });
    }),
  );
}

function normalizeField(
  rows: readonly ThreadHeaderRow[],
  field: "message-id" | "references" | "in-reply-to",
  minimumTokens: number,
  maximumTokens: number,
  byteLimit: number,
): FieldResult {
  if (rows.length === 0) return { values: [], diagnostics: [] };
  if ((field === MESSAGE_ID && rows.length !== 1) || (field !== MESSAGE_ID && rows.length > 1)) {
    return {
      values: [],
      diagnostics: [{ field, code: "duplicate-field", ordinal: rows[0]?.ordinal ?? null }],
    };
  }
  const row = rows[0];
  if (row === undefined) return { values: [], diagnostics: [] };
  if (row.value.length > byteLimit)
    return { values: [], diagnostics: [{ field, code: "field-too-large", ordinal: row.ordinal }] };
  const scalarError = invalidScalar(row.value);
  if (scalarError !== null)
    return { values: [], diagnostics: [{ field, code: scalarError, ordinal: row.ordinal }] };
  const bytes = new TextEncoder().encode(row.value).byteLength;
  if (bytes > byteLimit)
    return { values: [], diagnostics: [{ field, code: "field-too-large", ordinal: row.ordinal }] };
  const parsed = scanField(row.value);
  if (!parsed.ok)
    return { values: [], diagnostics: [{ field, code: parsed.code, ordinal: row.ordinal }] };
  if (parsed.tokens.length < minimumTokens || parsed.tokens.length > maximumTokens) {
    return { values: [], diagnostics: [{ field, code: "too-many-tokens", ordinal: row.ordinal }] };
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    const canonical = canonicalizeMessageId(token);
    if (canonical === null)
      return {
        values: [],
        diagnostics: [{ field, code: "malformed-token", ordinal: row.ordinal }],
      };
    if (new TextEncoder().encode(canonical).byteLength > THREAD_LIMITS.messageIdTokenBytes)
      return {
        values: [],
        diagnostics: [{ field, code: "field-too-large", ordinal: row.ordinal }],
      };
    if (!seen.has(canonical)) {
      seen.add(canonical);
      values.push(canonical);
    }
  }
  if (field === MESSAGE_ID && values.length !== 1) {
    return { values: [], diagnostics: [{ field, code: "malformed-token", ordinal: row.ordinal }] };
  }
  const tokenBytes = values[0] === undefined ? 0 : new TextEncoder().encode(values[0]).byteLength;
  if (field === MESSAGE_ID && tokenBytes > THREAD_LIMITS.messageIdTokenBytes) {
    return { values: [], diagnostics: [{ field, code: "field-too-large", ordinal: row.ordinal }] };
  }
  return { values: Object.freeze(values), diagnostics: [] };
}

type ScanResult = Readonly<
  | { readonly ok: true; readonly tokens: readonly string[] }
  | Readonly<{ readonly ok: false; readonly code: "malformed-cfws" | "malformed-token" }>
>;

function scanField(value: string): ScanResult {
  const tokens: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (value[index] === " " || value[index] === "\t")) index += 1;
    if (index >= value.length) break;
    if (value[index] === "(") {
      const comment = consumeComment(value, index);
      if (comment === null) return { ok: false, code: "malformed-cfws" };
      index = comment;
      continue;
    }
    if (value[index] !== "<") return { ok: false, code: "malformed-cfws" };
    index += 1;
    const start = index;
    while (index < value.length && value[index] !== ">") {
      if (
        value[index] === "<" ||
        value[index] === "\\" ||
        value[index] === '"' ||
        value[index] === "(" ||
        value[index] === ")" ||
        value[index] === " " ||
        value[index] === "\t" ||
        value[index] === "\r" ||
        value[index] === "\n"
      ) {
        return { ok: false, code: "malformed-token" };
      }
      index += 1;
    }
    if (index >= value.length) return { ok: false, code: "malformed-cfws" };
    const token = value.slice(start, index);
    if (token.length === 0) return { ok: false, code: "malformed-token" };
    tokens.push(token);
    index += 1;
    if (
      index < value.length &&
      value[index] !== " " &&
      value[index] !== "\t" &&
      value[index] !== "("
    ) {
      return { ok: false, code: "malformed-token" };
    }
  }
  return { ok: true, tokens };
}

function consumeComment(value: string, start: number): number | null {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === "\r" || character === "\n") return null;
      quoted = false;
      continue;
    }
    if (character === "\\") {
      quoted = true;
      continue;
    }
    if (character === '"') return null;
    if (character === "(") {
      depth += 1;
      if (depth > THREAD_LIMITS.commentNestingDepth) return null;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

function canonicalizeMessageId(value: string): NormalizedMessageId | null {
  const nfc = value.normalize("NFC");
  const at = nfc.indexOf("@");
  if (at <= 0 || at !== nfc.lastIndexOf("@")) return null;
  const local = nfc.slice(0, at);
  const right = nfc.slice(at + 1);
  if (!isDotAtom(local) || (!isDotAtom(right) && !isDomainLiteral(right))) return null;
  const canonicalRight = isDotAtom(right)
    ? right.replace(/[A-Z]/gu, (character) => character.toLowerCase())
    : right;
  return `${local}@${canonicalRight}` as NormalizedMessageId;
}

function toNormalizedMessageId(value: string): NormalizedMessageId {
  return value as NormalizedMessageId;
}

function isDotAtom(value: string): boolean {
  if (value.length === 0 || value.startsWith(".") || value.endsWith(".") || value.includes(".."))
    return false;
  for (const part of value.split(".")) {
    for (const character of part) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint === undefined ||
        BAD_SCALAR.test(character) ||
        isNonCharacter(codePoint) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      )
        return false;
      if (
        codePoint < 0x80
          ? !ASCII_ATEXT.test(character)
          : /\s|[\p{M}\p{Cc}\p{Cf}\p{Cs}]/u.test(character)
      )
        return false;
    }
  }
  return true;
}

function isDomainLiteral(value: string): boolean {
  if (!value.startsWith("[") || !value.endsWith("]") || value.length < 3) return false;
  for (const character of value.slice(1, -1)) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      BAD_SCALAR.test(character) ||
      isNonCharacter(codePoint) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    )
      return false;
    if (
      codePoint < 0x80
        ? !ASCII_DTEXT.test(character) ||
          character === "\\" ||
          character === "[" ||
          character === "]"
        : /\s|[\p{M}\p{Cc}\p{Cf}\p{Cs}]/u.test(character)
    )
      return false;
  }
  return true;
}

function invalidScalar(value: string): "invalid-unicode" | "forbidden-codepoint" | null {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return "invalid-unicode";
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return "invalid-unicode";
    const character = value[index];
    const codePoint = character?.codePointAt(0) ?? 0;
    if (
      codePoint === 0 ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(character ?? "") ||
      isNonCharacter(codePoint)
    ) {
      return codePoint === 0 || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? "forbidden-codepoint"
        : "forbidden-codepoint";
    }
  }
  return null;
}

function isNonCharacter(codePoint: number): boolean {
  return (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe;
}

function messageIdNodeKey(value: NormalizedMessageId): `i:${string}` {
  return `i:${createHash("sha256").update("thread-msgid-v1\0", "utf8").update(value, "utf8").digest("hex")}`;
}

function parseNullableInstant(value: unknown): UtcInstant | null {
  if (value === undefined || value === null) return null;
  try {
    return parseUtcInstant(value);
  } catch {
    return null;
  }
}

function normalizeParticipants(
  value: readonly ThreadParticipantFact[],
): Readonly<{ readonly values: readonly ThreadParticipantFact[]; readonly truncated: boolean }> {
  if (!Array.isArray(value))
    throw new ThreadNormalizationError("invalid-input", "thread participants are invalid");
  const normalizedValues: ThreadParticipantFact[] = [];
  for (const [index, participant] of value.entries()) {
    if (
      participant === null ||
      typeof participant !== "object" ||
      typeof participant.address !== "string" ||
      participant.address.trim().length === 0 ||
      BAD_SCALAR.test(participant.address)
    ) {
      throw new ThreadNormalizationError(
        "invalid-input",
        `thread participant ${index + 1} is invalid`,
      );
    }
    const address = participant.address.trim();
    if (
      participant.displayName !== undefined &&
      participant.displayName !== null &&
      (typeof participant.displayName !== "string" ||
        participant.displayName.trim().length === 0 ||
        BAD_SCALAR.test(participant.displayName))
    ) {
      throw new ThreadNormalizationError(
        "invalid-input",
        `thread participant ${index + 1} is invalid`,
      );
    }
    if (
      participant.role !== undefined &&
      participant.role !== "from" &&
      participant.role !== "sender" &&
      participant.role !== "to" &&
      participant.role !== "cc"
    ) {
      throw new ThreadNormalizationError(
        "invalid-input",
        `thread participant ${index + 1} is invalid`,
      );
    }
    if (
      participant.position !== undefined &&
      (!Number.isSafeInteger(participant.position) || participant.position <= 0)
    ) {
      throw new ThreadNormalizationError(
        "invalid-input",
        `thread participant ${index + 1} is invalid`,
      );
    }
    normalizedValues.push(
      Object.freeze({
        address,
        displayName: participant.displayName ?? null,
        role: participant.role,
        position: participant.position ?? index + 1,
      }),
    );
  }
  normalizedValues.sort(compareNormalizedParticipants);
  const deduplicated = new Map<string, ThreadParticipantFact>();
  let truncated = false;
  for (const participant of normalizedValues) {
    const existing = deduplicated.get(participant.address);
    if (existing !== undefined) {
      if (existing.displayName === null && participant.displayName !== null)
        deduplicated.set(
          participant.address,
          Object.freeze({ ...existing, displayName: participant.displayName }),
        );
      continue;
    }
    if (deduplicated.size >= THREAD_LIMITS.participantMaximum) {
      truncated = true;
      continue;
    }
    deduplicated.set(participant.address, participant);
  }
  const values = [...deduplicated.values()];
  return Object.freeze({ values: Object.freeze(values), truncated });
}

function compareNormalizedParticipants(
  left: ThreadParticipantFact,
  right: ThreadParticipantFact,
): number {
  return (
    participantRoleRank(left.role) - participantRoleRank(right.role) ||
    (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
    left.address.localeCompare(right.address)
  );
}

function participantRoleRank(role: ThreadParticipantFact["role"]): number {
  return role === "from" ? 0 : role === "sender" ? 1 : role === "to" ? 2 : role === "cc" ? 3 : 4;
}

function compareDiagnostics(left: ThreadDiagnostic, right: ThreadDiagnostic): number {
  return (
    left.field.localeCompare(right.field) ||
    left.code.localeCompare(right.code) ||
    (left.ordinal ?? 0) - (right.ordinal ?? 0)
  );
}

/** Build the public-shaped message used by tests that only need node identity. */
export function normalizedFactsToMessage(
  facts: ThreadNormalizedFacts,
  receivedAt: UtcInstant,
): ThreadMessage {
  return Object.freeze({
    messageId: facts.messageId,
    threadId: "thread:" as never,
    sentAt: facts.sentAt,
    receivedAt,
    subject: null,
    participants: facts.participants,
    isUnread: false,
    hasAttachment: false,
    contentAvailable: facts.contentState === "parsed",
  });
}
