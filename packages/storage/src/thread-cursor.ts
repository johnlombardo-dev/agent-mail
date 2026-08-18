import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  createMessageId,
  createThreadId,
  parseAccountId,
  parseMessageId,
  parseThreadId,
  parseUtcInstant,
  type AccountId,
  type MessageId,
  type ThreadId,
  type UtcInstant,
} from "@agent-mail/core";
import { THREAD_CURSOR_VERSION, THREAD_LIMITS, type ThreadCursorTuple } from "./thread-types";

const THREAD_ID = /^thread:[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/u;

export type ThreadCursorPayload = Readonly<{
  readonly registryVersion: 1;
  readonly cursorKeyId: string;
  readonly accountScopeDigest: string;
  readonly requestedThreadHandle: ThreadId;
  readonly lastSentAtMissingRank: 0 | 1;
  readonly lastSentAt: UtcInstant | null;
  readonly lastMessageId: MessageId;
}>;

export type ThreadCursorKey = Readonly<{
  readonly keyId: string;
  readonly secret: Uint8Array | string;
}>;

export type ThreadCursorCodecOptions = Readonly<{
  readonly accountId?: unknown;
  readonly activeKey: ThreadCursorKey;
  readonly keys?: readonly ThreadCursorKey[];
}>;

export class ThreadCursorError extends Error {
  readonly code: "invalid_cursor";

  constructor(message = "thread cursor is invalid", options?: ErrorOptions) {
    super(message, options);
    this.name = "ThreadCursorError";
    this.code = "invalid_cursor";
  }
}

export class ThreadCursorCodec {
  readonly #activeKey: ThreadCursorKey;
  readonly #keys: ReadonlyMap<string, ThreadCursorKey>;
  readonly #accountId: AccountId | null;

  constructor(options: ThreadCursorCodecOptions) {
    validateKey(options.activeKey);
    const keys = [options.activeKey, ...(options.keys ?? [])];
    this.#keys = new Map(
      keys.map((key) => {
        validateKey(key);
        return [key.keyId, key] as const;
      }),
    );
    this.#activeKey = options.activeKey;
    if (options.accountId === undefined) {
      this.#accountId = null;
    } else {
      this.#accountId = parseCursorAccount(options.accountId);
    }
  }

  encode(
    input: Readonly<{
      readonly accountId?: unknown;
      readonly requestedThreadHandle: unknown;
      readonly tuple: ThreadCursorTuple;
    }>,
  ): string {
    const accountId =
      input.accountId === undefined ? this.#accountId : parseCursorAccount(input.accountId);
    if (accountId === null) throw new ThreadCursorError("cursor account scope is unavailable");
    const requestedThreadHandle = parseThreadHandle(input.requestedThreadHandle);
    const tuple = validateTuple(input.tuple);
    const payload: ThreadCursorPayload = {
      registryVersion: 1,
      cursorKeyId: this.#activeKey.keyId,
      accountScopeDigest: digestAccount(accountId),
      requestedThreadHandle,
      lastSentAtMissingRank: tuple.sentAtMissingRank,
      lastSentAt: tuple.sentAt,
      lastMessageId: tuple.messageId,
    };
    const payloadJson = canonicalJson(payload);
    const tag = sign(payloadJson, this.#activeKey.secret);
    const envelope = [THREAD_CURSOR_VERSION, payloadJson, tag] as const;
    const encoded = encodeBase64Url(JSON.stringify(envelope));
    if (new TextEncoder().encode(encoded).byteLength > THREAD_LIMITS.cursorBytes) {
      throw new ThreadCursorError("thread cursor exceeds its bound");
    }
    return encoded;
  }

  decode(
    value: unknown,
    expected?: Readonly<{ readonly accountId?: unknown; readonly requestedThreadHandle?: unknown }>,
  ): ThreadCursorPayload {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      new TextEncoder().encode(value).byteLength > THREAD_LIMITS.cursorBytes
    ) {
      throw new ThreadCursorError();
    }
    let decoded: string;
    try {
      decoded = decodeBase64Url(value);
    } catch (error: unknown) {
      throw new ThreadCursorError("thread cursor encoding is invalid", { cause: error });
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(decoded);
    } catch (error: unknown) {
      throw new ThreadCursorError("thread cursor envelope is invalid", { cause: error });
    }
    if (
      !Array.isArray(envelope) ||
      envelope.length !== 3 ||
      envelope[0] !== THREAD_CURSOR_VERSION ||
      typeof envelope[1] !== "string" ||
      typeof envelope[2] !== "string"
    ) {
      throw new ThreadCursorError();
    }
    if (JSON.stringify(envelope) !== decoded) throw new ThreadCursorError();
    const payloadJson = envelope[1];
    const key = this.#keys.get(readKeyId(payloadJson));
    if (key === undefined || !verify(payloadJson, envelope[2], key.secret))
      throw new ThreadCursorError();
    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson);
    } catch (error: unknown) {
      throw new ThreadCursorError("thread cursor payload is invalid", { cause: error });
    }
    const result = decodePayload(payload);
    if (result.cursorKeyId !== key.keyId || canonicalJson(result) !== payloadJson)
      throw new ThreadCursorError();
    const accountId =
      expected?.accountId === undefined ? this.#accountId : parseCursorAccount(expected.accountId);
    if (accountId !== null && result.accountScopeDigest !== digestAccount(accountId))
      throw new ThreadCursorError();
    if (
      expected?.requestedThreadHandle !== undefined &&
      result.requestedThreadHandle !== parseThreadHandle(expected.requestedThreadHandle)
    )
      throw new ThreadCursorError();
    return result;
  }

  encodeFor(
    input: Readonly<{
      readonly accountId: unknown;
      readonly requestedThreadHandle: unknown;
      readonly tuple: ThreadCursorTuple;
    }>,
  ): string {
    return this.encode(input);
  }
}

export function createThreadCursorCodec(options: ThreadCursorCodecOptions): ThreadCursorCodec {
  return new ThreadCursorCodec(options);
}

export function encodeThreadCursor(
  codec: ThreadCursorCodec,
  input: Readonly<{
    readonly accountId?: unknown;
    readonly requestedThreadHandle: unknown;
    readonly tuple: ThreadCursorTuple;
  }>,
): string {
  return codec.encode(input);
}

export function decodeThreadCursor(
  codec: ThreadCursorCodec,
  value: unknown,
  expected?: Readonly<{ readonly accountId?: unknown; readonly requestedThreadHandle?: unknown }>,
): ThreadCursorPayload {
  return codec.decode(value, expected);
}

export function tupleFromRow(
  value: Readonly<{
    readonly sent_at_missing_rank: unknown;
    readonly sent_at: unknown;
    readonly message_id: unknown;
  }>,
): ThreadCursorTuple {
  if (value.sent_at_missing_rank !== 0 && value.sent_at_missing_rank !== 1)
    throw new ThreadCursorError();
  const messageId = parseMessageId(value.message_id);
  const sentAt = value.sent_at === null ? null : parseUtcInstant(value.sent_at);
  if (
    (value.sent_at_missing_rank === 0 && sentAt === null) ||
    (value.sent_at_missing_rank === 1 && sentAt !== null)
  )
    throw new ThreadCursorError();
  return Object.freeze({ sentAtMissingRank: value.sent_at_missing_rank, sentAt, messageId });
}

function validateKey(value: ThreadCursorKey): void {
  if (
    !KEY_ID.test(value.keyId) ||
    !(typeof value.secret === "string" || value.secret instanceof Uint8Array) ||
    (typeof value.secret === "string" && value.secret.length < 16) ||
    (value.secret instanceof Uint8Array && value.secret.byteLength < 16)
  )
    throw new ThreadCursorError("cursor key is invalid");
}

function validateTuple(value: ThreadCursorTuple): ThreadCursorTuple {
  const messageId = parseMessageId(value.messageId);
  const sentAt = value.sentAt === null ? null : parseUtcInstant(value.sentAt);
  if (
    (value.sentAtMissingRank !== 0 && value.sentAtMissingRank !== 1) ||
    (value.sentAtMissingRank === 0 && sentAt === null) ||
    (value.sentAtMissingRank === 1 && sentAt !== null)
  )
    throw new ThreadCursorError("cursor order tuple is invalid");
  return Object.freeze({ sentAtMissingRank: value.sentAtMissingRank, sentAt, messageId });
}

function parseThreadHandle(value: unknown): ThreadId {
  const id = parseThreadId(value);
  if (!THREAD_ID.test(id)) throw new ThreadCursorError();
  return id;
}

function parseCursorAccount(value: unknown): AccountId {
  try {
    return parseAccountId(value);
  } catch (error: unknown) {
    throw new ThreadCursorError("cursor account scope is invalid", { cause: error });
  }
}

function decodePayload(value: unknown): ThreadCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ThreadCursorError();
  if (!isRecord(value)) throw new ThreadCursorError();
  const object = value;
  const requestedThreadHandle = parseThreadHandle(object.requestedThreadHandle);
  const lastMessageId = parseMessageId(object.lastMessageId);
  if (
    object.registryVersion !== 1 ||
    typeof object.cursorKeyId !== "string" ||
    !KEY_ID.test(object.cursorKeyId) ||
    typeof object.accountScopeDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(object.accountScopeDigest) ||
    (object.lastSentAtMissingRank !== 0 && object.lastSentAtMissingRank !== 1) ||
    (object.lastSentAt !== null && typeof object.lastSentAt !== "string") ||
    !Object.hasOwn(object, "lastSentAt")
  )
    throw new ThreadCursorError();
  const lastSentAt = object.lastSentAt === null ? null : parseUtcInstant(object.lastSentAt);
  if (
    (object.lastSentAtMissingRank === 0 && lastSentAt === null) ||
    (object.lastSentAtMissingRank === 1 && lastSentAt !== null)
  )
    throw new ThreadCursorError();
  return Object.freeze({
    registryVersion: 1,
    cursorKeyId: object.cursorKeyId,
    accountScopeDigest: object.accountScopeDigest,
    requestedThreadHandle,
    lastSentAtMissingRank: object.lastSentAtMissingRank,
    lastSentAt,
    lastMessageId,
  });
}

function readKeyId(payloadJson: string): string {
  try {
    const value: unknown = JSON.parse(payloadJson);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "cursorKeyId" in value &&
      typeof value.cursorKeyId === "string"
    )
      return value.cursorKeyId;
  } catch {
    // Decoding reports a stable invalid_cursor error.
  }
  return "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(payload: ThreadCursorPayload): string {
  return JSON.stringify({
    registryVersion: payload.registryVersion,
    cursorKeyId: payload.cursorKeyId,
    accountScopeDigest: payload.accountScopeDigest,
    requestedThreadHandle: payload.requestedThreadHandle,
    lastSentAtMissingRank: payload.lastSentAtMissingRank,
    lastSentAt: payload.lastSentAt,
    lastMessageId: payload.lastMessageId,
  });
}

function sign(value: string, secret: Uint8Array | string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function verify(value: string, tag: string, secret: Uint8Array | string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(tag)) return false;
  const expected = Buffer.from(sign(value, secret), "hex");
  const actual = Buffer.from(tag, "hex");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function digestAccount(accountId: AccountId): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("invalid base64url");
  const bytes = Buffer.from(value, "base64url");
  const canonical = bytes.toString("base64url");
  if (canonical !== value) throw new TypeError("non-canonical base64url");
  return bytes.toString("utf8");
}

// Keep these imports in the public module's declaration surface for callers
// that used the core constructors while adopting the storage cursor.
export { createMessageId, createThreadId };
