/** Canonical, nominal identifiers used at the core domain boundary. */

declare const accountIdBrand: unique symbol;
declare const mailboxIdBrand: unique symbol;
declare const messageIdBrand: unique symbol;
declare const placementIdBrand: unique symbol;
declare const blobIdBrand: unique symbol;
declare const threadIdBrand: unique symbol;
declare const uidValidityBrand: unique symbol;
declare const remoteUidBrand: unique symbol;

export type AccountId = string & { readonly [accountIdBrand]: "AccountId" };
export type MailboxId = string & { readonly [mailboxIdBrand]: "MailboxId" };
export type MessageId = string & { readonly [messageIdBrand]: "MessageId" };
export type PlacementId = string & { readonly [placementIdBrand]: "PlacementId" };
export type BlobId = string & { readonly [blobIdBrand]: "BlobId" };
export type ThreadId = string & { readonly [threadIdBrand]: "ThreadId" };
export type UidValidity = number & { readonly [uidValidityBrand]: "UidValidity" };
export type RemoteUid = {
  readonly accountId: AccountId;
  readonly mailboxId: MailboxId;
  readonly uidValidity: UidValidity;
  readonly uid: RemoteUidValue;
  readonly [remoteUidBrand]: "RemoteUid";
};
export type RemoteUidValue = number & { readonly [remoteUidBrand]: "RemoteUidValue" };

type ScalarId = AccountId | MailboxId | MessageId | PlacementId | BlobId | ThreadId;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function validateId(value: unknown, namespace: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${namespace} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new TypeError(`${namespace} must be trimmed`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`${namespace} must not contain control characters`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeId<T extends ScalarId>(value: unknown, namespace: string, prefix: string): T {
  const validated = validateId(value, namespace);
  if (validated.startsWith(`${prefix}:`)) {
    validateId(validated.slice(prefix.length + 1), namespace);
    return validated as T;
  }
  return `${prefix}:${validated}` as T;
}

export function createAccountId(value: unknown): AccountId {
  return makeId<AccountId>(value, "Account ID", "account");
}
export function createMailboxId(value: unknown): MailboxId {
  return makeId<MailboxId>(value, "Mailbox ID", "mailbox");
}
export function createMessageId(value: unknown): MessageId {
  return makeId<MessageId>(value, "Message ID", "message");
}
export function createPlacementId(value: unknown): PlacementId {
  return makeId<PlacementId>(value, "Placement ID", "placement");
}
export function createBlobId(value: unknown): BlobId {
  return makeId<BlobId>(value, "Blob ID", "blob");
}
export function createThreadId(value: unknown): ThreadId {
  return makeId<ThreadId>(value, "Thread ID", "thread");
}

function parseId<T extends ScalarId>(
  value: unknown,
  namespace: string,
  prefix: string,
  create: (value: unknown) => T,
): T {
  if (typeof value !== "string" || !value.startsWith(`${prefix}:`)) {
    throw new TypeError(`${namespace} serialization has the wrong namespace`);
  }
  return create(value);
}

export function createUidValidity(value: unknown): UidValidity {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("UIDVALIDITY must be a positive safe integer");
  }
  return value as UidValidity;
}

export function createRemoteUidValue(value: unknown): RemoteUidValue {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("remote UID must be a positive safe integer");
  }
  return value as RemoteUidValue;
}

export function createRemoteUid(input: unknown): RemoteUid {
  if (!isRecord(input)) {
    throw new TypeError("remote UID input must be an object");
  }
  return {
    accountId: createAccountId(input.accountId),
    mailboxId: createMailboxId(input.mailboxId),
    uidValidity: createUidValidity(input.uidValidity),
    uid: createRemoteUidValue(input.uid),
  } as RemoteUid;
}

export const serializeAccountId = (value: AccountId): string => value;
export const serializeMailboxId = (value: MailboxId): string => value;
export const serializeMessageId = (value: MessageId): string => value;
export const serializePlacementId = (value: PlacementId): string => value;
export const serializeBlobId = (value: BlobId): string => value;
export const serializeThreadId = (value: ThreadId): string => value;
export const serializeUidValidity = (value: UidValidity): string => String(value);

export function serializeRemoteUid(value: RemoteUid): string {
  return JSON.stringify([
    "remote-uid-v1",
    value.accountId,
    value.mailboxId,
    value.uidValidity,
    value.uid,
  ]);
}

export const parseAccountId = (value: unknown): AccountId =>
  parseId(value, "Account ID", "account", createAccountId);
export const parseMailboxId = (value: unknown): MailboxId =>
  parseId(value, "Mailbox ID", "mailbox", createMailboxId);
export const parseMessageId = (value: unknown): MessageId =>
  parseId(value, "Message ID", "message", createMessageId);
export const parsePlacementId = (value: unknown): PlacementId =>
  parseId(value, "Placement ID", "placement", createPlacementId);
export const parseBlobId = (value: unknown): BlobId =>
  parseId(value, "Blob ID", "blob", createBlobId);
export const parseThreadId = (value: unknown): ThreadId =>
  parseId(value, "Thread ID", "thread", createThreadId);

export function parseUidValidity(value: unknown): UidValidity {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TypeError("UIDVALIDITY serialization must be decimal");
  }
  const result = createUidValidity(Number(value));
  if (serializeUidValidity(result) !== value) {
    throw new TypeError("non-canonical UIDVALIDITY serialization");
  }
  return result;
}

export function parseRemoteUid(value: unknown): RemoteUid {
  if (typeof value !== "string") {
    throw new TypeError("remote UID serialization must be a string");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new TypeError("malformed remote UID serialization");
  }
  if (!Array.isArray(decoded) || decoded.length !== 5 || decoded[0] !== "remote-uid-v1") {
    throw new TypeError("malformed remote UID serialization");
  }
  const parts: readonly unknown[] = decoded;
  const accountId = parts[1];
  const mailboxId = parts[2];
  const uidValidity = parts[3];
  const uid = parts[4];
  if (typeof accountId !== "string" || typeof mailboxId !== "string") {
    throw new TypeError("malformed remote UID serialization");
  }
  const result = createRemoteUid({ accountId, mailboxId, uidValidity, uid });
  if (serializeRemoteUid(result) !== value) {
    throw new TypeError("non-canonical remote UID serialization");
  }
  return result;
}
