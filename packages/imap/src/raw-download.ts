import {
  createAccountId,
  createMailboxId,
  createRemoteUid,
  createRemoteUidValue,
  createUidValidity,
  type AccountId,
  type MailboxId,
  type RemoteUid,
  type RemoteUidValue,
  type UidValidity,
} from "@agent-mail/core";

/** The fixed upper bound for one raw RFC822 message. */
export const MAX_RAW_MESSAGE_BYTES = 256 * 1024 * 1024;

/** The metadata-only probe used when the installed ImapFlow client is available. */
export const IMAP_RAW_MESSAGE_IDENTITY_QUERY = Object.freeze({
  uid: true,
  size: true,
} satisfies Readonly<{ readonly uid: true; readonly size: true }>);

export type RawMessageDownloadRequest = Readonly<{
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
  readonly stagingDirectory: string;
  readonly owner: RawBlobStageOwner;
  readonly signal?: AbortSignal;
}>;

export type RawBlobStageOwner = Readonly<{
  readonly pid: number;
  readonly processStartIdentity: string;
}>;

export type RawBlobStageInput = Readonly<{
  readonly stagingDirectory: string;
  readonly owner: RawBlobStageOwner;
  readonly source: AsyncIterable<Uint8Array>;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}>;

export type RawBlobStageResult = Readonly<{
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}>;

/** Injected storage boundary; the IMAP package does not depend on storage. */
export type RawBlobStage = (input: RawBlobStageInput) => Promise<RawBlobStageResult>;

/** The narrow ImapFlow surface needed for one raw message. */
export interface ImapFlowRawMessageDownloadClient {
  download(
    range: string,
    part: undefined,
    options: Readonly<{ readonly uid: true; readonly maxBytes: number }>,
  ): Promise<unknown>;
  /** Optional metadata-only identity probe supported by the installed client. */
  fetchOne?(
    range: string,
    query: typeof IMAP_RAW_MESSAGE_IDENTITY_QUERY,
    options: Readonly<{ readonly uid: true }>,
  ): Promise<unknown>;
}

export type RawMessageDownloadResult = Readonly<{
  readonly identity: RemoteUid;
  readonly staged: RawBlobStageResult;
}>;

export interface RawMessageDownloadAdapter {
  download(request: RawMessageDownloadRequest): Promise<RawMessageDownloadResult>;
}

type UnknownAsyncIterable = AsyncIterable<unknown>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
  name: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${name} is missing ${key}`);
    }
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${name} has unknown fields`);
  }
}

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

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  }
  if (hasControlCharacters(value)) throw new TypeError(`${name} contains control characters`);
  return value.normalize("NFC");
}

function parseOwner(value: unknown): RawBlobStageOwner {
  if (!isRecord(value)) throw new TypeError("raw download owner must be an object");
  assertExactKeys(value, ["pid", "processStartIdentity"], [], "raw download owner");
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new TypeError("raw download owner pid must be a positive safe integer");
  }
  const processStartIdentity = requiredText(value.processStartIdentity, "processStartIdentity");
  if (processStartIdentity.length > 4096) {
    throw new TypeError("processStartIdentity is too long");
  }
  return Object.freeze({ pid: value.pid, processStartIdentity });
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

/** Validate request data before constructing an IMAP UID range or stage. */
export function parseRawMessageDownloadRequest(value: unknown): RawMessageDownloadRequest {
  if (!isRecord(value)) throw new TypeError("raw message download request must be an object");
  assertExactKeys(
    value,
    ["accountId", "mailboxId", "uidValidity", "uid", "stagingDirectory", "owner"],
    ["signal"],
    "raw message download request",
  );
  if (value.signal !== undefined && !isAbortSignal(value.signal)) {
    throw new TypeError("raw message download signal must be an AbortSignal");
  }
  return Object.freeze({
    accountId: createAccountId(value.accountId),
    mailboxId: createMailboxId(value.mailboxId),
    uidValidity: createUidValidity(value.uidValidity),
    uid: createRemoteUidValue(value.uid),
    stagingDirectory: requiredText(value.stagingDirectory, "stagingDirectory"),
    owner: parseOwner(value.owner),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  });
}

function positiveSize(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function isUnknownAsyncIterable(value: unknown): value is UnknownAsyncIterable {
  if (!isRecord(value)) return false;
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, Symbol.asyncIterator);
    if (descriptor !== undefined) return typeof descriptor.value === "function";
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function responseUid(value: Readonly<Record<string, unknown>>): RemoteUidValue | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, "uid")) return undefined;
  return createRemoteUidValue(value.uid);
}

function isDestroyable(
  value: UnknownAsyncIterable,
): value is UnknownAsyncIterable & { destroy: (reason?: unknown) => void } {
  return isRecord(value) && typeof value.destroy === "function";
}

type ParsedRawResponse = Readonly<{
  readonly uid: RemoteUidValue | undefined;
  readonly expectedSize: number;
  readonly content: UnknownAsyncIterable;
}>;

function parseRawResponse(value: unknown): ParsedRawResponse {
  if (!isRecord(value)) throw new TypeError("IMAP raw download response must be an object");
  assertExactKeys(value, ["meta", "content"], ["uid"], "IMAP raw download response");
  if (!isRecord(value.meta)) throw new TypeError("IMAP raw download metadata must be an object");
  if (!Object.prototype.hasOwnProperty.call(value.meta, "expectedSize")) {
    throw new TypeError("IMAP raw download metadata is missing expectedSize");
  }
  const expectedSize = positiveSize(value.meta.expectedSize, "IMAP raw expectedSize");
  if (!isUnknownAsyncIterable(value.content)) {
    throw new TypeError("IMAP raw download content must be an async iterable");
  }
  return Object.freeze({ uid: responseUid(value), expectedSize, content: value.content });
}

function parseIdentityProbe(value: unknown): Readonly<{ uid: RemoteUidValue; size: number }> {
  if (!isRecord(value)) throw new TypeError("IMAP raw identity response must be an object");
  if (Object.prototype.hasOwnProperty.call(value, "source")) {
    throw new TypeError("IMAP raw identity response must not contain message bytes");
  }
  // ImapFlow always includes sequence number metadata even when only UID and
  // size were requested. It is deliberately accepted but never used as an
  // identity; all later checks remain UID-based.
  assertExactKeys(value, ["uid", "size"], ["seq"], "IMAP raw identity response");
  return { uid: createRemoteUidValue(value.uid), size: positiveSize(value.size, "IMAP raw size") };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Raw download was aborted", "AbortError");
}

function destroyer(value: UnknownAsyncIterable): (reason?: unknown) => void {
  if (isDestroyable(value)) return (reason?: unknown) => value.destroy(reason);
  return () => undefined;
}

async function* boundedChunks(
  content: UnknownAsyncIterable,
  expectedSize: number,
  signal: AbortSignal | undefined,
  close: () => void = destroyer(content),
): AsyncGenerator<Uint8Array> {
  let size = 0;
  let complete = false;
  try {
    throwIfAborted(signal);
    for await (const chunk of content) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) throw new TypeError("IMAP raw stream yielded non-bytes");
      if (chunk.byteLength > expectedSize - size) {
        throw new RangeError("IMAP raw stream exceeded the advertised message size");
      }
      size += chunk.byteLength;
      yield chunk;
    }
    if (size !== expectedSize) {
      throw new RangeError("IMAP raw stream ended before the advertised message size");
    }
    complete = true;
  } finally {
    if (!complete) close();
  }
}

function once(action: (reason?: unknown) => void): (reason?: unknown) => void {
  let called = false;
  return (reason?: unknown) => {
    if (called) return;
    called = true;
    action(reason);
  };
}

/** Create the single-message, read-only IMAP-to-blob staging adapter. */
export function createRawMessageDownloadAdapter(
  client: ImapFlowRawMessageDownloadClient,
  stage: RawBlobStage,
  options: Readonly<{ readonly maxBytes?: number }> = {},
): RawMessageDownloadAdapter {
  const maxBytes = options.maxBytes ?? MAX_RAW_MESSAGE_BYTES;
  positiveSize(maxBytes, "raw download maxBytes");
  return {
    async download(input: RawMessageDownloadRequest): Promise<RawMessageDownloadResult> {
      const request = parseRawMessageDownloadRequest(input);
      const identity = createRemoteUid(request);
      throwIfAborted(request.signal);

      let probedSize: number | undefined;
      if (client.fetchOne !== undefined) {
        const probe = await client.fetchOne(String(request.uid), IMAP_RAW_MESSAGE_IDENTITY_QUERY, {
          uid: true,
        });
        if (probe === false) throw new Error("IMAP raw message UID is missing");
        const normalizedProbe = parseIdentityProbe(probe);
        if (normalizedProbe.uid !== request.uid) {
          throw new Error("IMAP raw identity UID does not match the requested UID");
        }
        probedSize = normalizedProbe.size;
      }

      const response = parseRawResponse(
        await client.download(String(request.uid), undefined, { uid: true, maxBytes }),
      );
      const closeResponse = once(destroyer(response.content));
      const responseUidValue = response.uid;
      if (responseUidValue !== undefined && responseUidValue !== request.uid) {
        closeResponse(new Error("IMAP raw response UID does not match the requested UID"));
        throw new Error("IMAP raw response UID does not match the requested UID");
      }
      if (responseUidValue === undefined && probedSize === undefined) {
        const error = new Error("IMAP raw response has no verified UID evidence");
        closeResponse(error);
        throw error;
      }
      if (probedSize !== undefined && response.expectedSize !== probedSize) {
        closeResponse(new Error("IMAP raw response size differs from metadata"));
        throw new Error("IMAP raw response size differs from metadata");
      }
      if (response.expectedSize > maxBytes) {
        closeResponse(new RangeError(`IMAP raw message exceeds ${maxBytes} bytes`));
        throw new RangeError(`IMAP raw message exceeds ${maxBytes} bytes`);
      }

      const abort = () => closeResponse(request.signal?.reason);
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        throwIfAborted(request.signal);
        const staged = await stage({
          stagingDirectory: request.stagingDirectory,
          owner: request.owner,
          source: boundedChunks(
            response.content,
            response.expectedSize,
            request.signal,
            closeResponse,
          ),
          maxBytes,
          signal: request.signal,
        });
        return Object.freeze({ identity, staged });
      } catch (error) {
        closeResponse(error);
        throw error;
      } finally {
        request.signal?.removeEventListener("abort", abort);
      }
    },
  };
}
