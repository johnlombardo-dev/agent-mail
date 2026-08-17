import { createRemoteUidValue, type RemoteUidValue } from "@agent-mail/core";

export const IMAP_TAGGED_STORE_FLAG_SEEN = "\\Seen";
export const IMAP_TAGGED_STORE_FLAG_DELETED = "\\Deleted";

export type ImapTaggedStoreFlag =
  | typeof IMAP_TAGGED_STORE_FLAG_SEEN
  | typeof IMAP_TAGGED_STORE_FLAG_DELETED;

export type ImapTaggedStoreOptions = Readonly<{
  readonly uid: true;
  readonly unchangedSince: bigint;
}>;

export type ImapTaggedStoreRequest = Readonly<{
  readonly range: string;
  readonly operation: "add" | "remove";
  readonly flags: readonly [ImapTaggedStoreFlag];
  readonly options: ImapTaggedStoreOptions;
}>;

export type ImapTaggedStoreResult =
  | Readonly<{ readonly kind: "applied" }>
  | Readonly<{ readonly kind: "modified"; readonly modifiedUids: readonly RemoteUidValue[] }>
  | Readonly<{ readonly kind: "missing"; readonly status: "NO" | "BAD" }>
  | Readonly<{
      readonly kind: "rejected";
      readonly status: "NO" | "BAD" | "unsupported" | "malformed";
      readonly certainty: "definite" | "uncertain";
      readonly phase: "before_transmission" | "after_transmission";
    }>;

export type ImapTaggedStorePrimitive = (
  request: ImapTaggedStoreRequest,
) => Promise<ImapTaggedStoreResult>;

type ImapFlowExecResponse = Readonly<{
  readonly response: unknown;
  readonly next: () => void | Promise<void>;
}>;

type ImapFlowExecOptions = Readonly<{
  readonly untagged?: Readonly<Record<string, (response: unknown) => void | Promise<void>>>;
}>;

type ImapFlowExecClient = Readonly<{
  readonly enabled: ReadonlySet<string>;
  readonly mailbox: unknown;
  readonly exec: (
    command: string,
    attributes: readonly unknown[],
    options?: ImapFlowExecOptions,
  ) => Promise<unknown>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExec(value: unknown): value is ImapFlowExecClient {
  return (
    isRecord(value) &&
    value.enabled instanceof Set &&
    "exec" in value &&
    typeof value.exec === "function"
  );
}

function supportsCondstore(client: ImapFlowExecClient): boolean {
  return [...client.enabled].some(
    (capability) => typeof capability === "string" && capability.toUpperCase() === "CONDSTORE",
  );
}

function isExecResponse(value: unknown): value is ImapFlowExecResponse {
  return isRecord(value) && "response" in value && typeof value.next === "function";
}

function requestedUid(range: string): RemoteUidValue | undefined {
  if (!/^\d+$/.test(range)) return undefined;
  const numeric = Number(range);
  return Number.isSafeInteger(numeric) && numeric > 0 ? createRemoteUidValue(numeric) : undefined;
}

function decodeRequest(value: unknown): ImapTaggedStoreRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.range !== "string") return undefined;
  const targetUid = requestedUid(value.range);
  if (targetUid === undefined) return undefined;
  if (value.operation !== "add" && value.operation !== "remove") return undefined;
  if (!Array.isArray(value.flags) || value.flags.length !== 1) return undefined;
  const flag = value.flags[0];
  if (flag !== IMAP_TAGGED_STORE_FLAG_SEEN && flag !== IMAP_TAGGED_STORE_FLAG_DELETED)
    return undefined;
  if (!isRecord(value.options) || value.options.uid !== true) return undefined;
  if (typeof value.options.unchangedSince !== "bigint" || value.options.unchangedSince < 0n) {
    return undefined;
  }
  const flags: readonly [ImapTaggedStoreFlag] = [flag];
  return {
    range: value.range,
    operation: value.operation,
    flags,
    options: { uid: true, unchangedSince: value.options.unchangedSince },
  };
}

async function releaseResponse(value: unknown): Promise<void> {
  if (isExecResponse(value)) await value.next();
}

function isMailboxWithoutModseq(value: unknown): boolean {
  return isRecord(value) && value.noModseq === true;
}

function sequenceSet(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.value !== "string") return undefined;
  return value.value;
}

function modifiedUids(
  value: unknown,
  requestedUid: RemoteUidValue,
): readonly RemoteUidValue[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.attributes) || value.attributes.length === 0)
    return undefined;
  const first = value.attributes[0];
  if (!isRecord(first) || !Array.isArray(first.section) || first.section.length !== 2)
    return undefined;
  const code = first.section[0];
  if (!isRecord(code) || typeof code.value !== "string" || code.value.toUpperCase() !== "MODIFIED")
    return undefined;
  const uidSet = sequenceSet(first.section[1]);
  if (uidSet !== String(requestedUid)) return undefined;
  return Object.freeze([createRemoteUidValue(requestedUid)]);
}

function responseStatus(value: unknown): "OK" | "NO" | "BAD" | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  const command = value.command.toUpperCase();
  return command === "OK" || command === "NO" || command === "BAD" ? command : undefined;
}

function responseText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.attributes)) return "";
  return value.attributes
    .filter((attribute) => isRecord(attribute) && attribute.type === "TEXT")
    .map((attribute) => (typeof attribute.value === "string" ? attribute.value : ""))
    .join(" ");
}

function hasResponseCode(value: unknown, expected: string): boolean {
  if (!isRecord(value) || !Array.isArray(value.attributes) || value.attributes.length === 0)
    return false;
  const first = value.attributes[0];
  if (!isRecord(first) || !Array.isArray(first.section) || first.section.length === 0) return false;
  const code = first.section[0];
  return isRecord(code) && typeof code.value === "string" && code.value.toUpperCase() === expected;
}

function modifiedFrom(
  value: unknown,
  requestedUid: RemoteUidValue,
): readonly RemoteUidValue[] | undefined {
  if (!isRecord(value)) return undefined;
  return modifiedUids(value.response, requestedUid) ?? modifiedUids(value, requestedUid);
}

function hasModifiedCode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return hasResponseCode(value.response, "MODIFIED") || hasResponseCode(value, "MODIFIED");
}

function missingFrom(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const response = value.response ?? value;
  return (
    hasResponseCode(response, "NONEXISTENT") ||
    responseText(response).includes("Some of the requested messages no longer exist")
  );
}

function commandAttributes(request: ImapTaggedStoreRequest): readonly unknown[] {
  const operation = request.operation === "add" ? "+FLAGS" : "-FLAGS";
  return [
    { type: "SEQUENCE", value: request.range },
    [
      { type: "ATOM", value: "UNCHANGEDSINCE" },
      { type: "ATOM", value: request.options.unchangedSince.toString() },
    ],
    { type: "ATOM", value: operation },
    [{ type: "ATOM", value: request.flags[0] }],
  ];
}

export const buildTaggedStoreCommandAttributes = commandAttributes;

/**
 * Wrap the installed ImapFlow low-level `exec` seam. ImapFlow 1.7.1 keeps
 * `exec` out of its declarations and its public flag helpers collapse tagged
 * NO/OK responses to booleans, so this compatibility boundary is intentionally
 * isolated here and tested against the parser's response object shape.
 */
export function createImapFlowTaggedStorePrimitive(client: unknown): ImapTaggedStorePrimitive {
  return async (input): Promise<ImapTaggedStoreResult> => {
    const request = decodeRequest(input);
    const targetUid = request === undefined ? undefined : requestedUid(request.range);
    if (request === undefined || targetUid === undefined) {
      return {
        kind: "rejected",
        status: "malformed",
        certainty: "definite",
        phase: "before_transmission",
      };
    }
    if (!hasExec(client) || !supportsCondstore(client) || isMailboxWithoutModseq(client.mailbox)) {
      return {
        kind: "rejected",
        status: "unsupported",
        certainty: "definite",
        phase: "before_transmission",
      };
    }

    const untaggedResponses: unknown[] = [];
    let raw: unknown;
    try {
      raw = await client.exec("UID STORE", commandAttributes(request), {
        untagged: {
          OK: (response) => {
            untaggedResponses.push(response);
          },
        },
      });
    } catch (error: unknown) {
      const modified = modifiedFrom(error, targetUid);
      if (modified !== undefined) return { kind: "modified", modifiedUids: modified };
      if (hasModifiedCode(error)) {
        return {
          kind: "rejected",
          status: "malformed",
          certainty: "uncertain",
          phase: "after_transmission",
        };
      }
      if (missingFrom(error)) return { kind: "missing", status: "NO" };
      const status = isRecord(error) && error.responseStatus === "NO" ? "NO" : "BAD";
      if (isRecord(error) && isRecord(error.response)) {
        return {
          kind: "rejected",
          status,
          certainty: "uncertain",
          phase: "after_transmission",
        };
      }
      if (isRecord(error) && (error.transmitted === false || error.beforeTransmission === true)) {
        return {
          kind: "rejected",
          status,
          certainty: "definite",
          phase: "before_transmission",
        };
      }
      return {
        kind: "rejected",
        status,
        certainty: "uncertain",
        phase: "after_transmission",
      };
    }

    for (const response of untaggedResponses) {
      const modified = modifiedUids(response, targetUid);
      if (modified !== undefined) {
        await releaseResponse(raw);
        return { kind: "modified", modifiedUids: modified };
      }
      if (hasModifiedCode(response)) {
        await releaseResponse(raw);
        return {
          kind: "rejected",
          status: "malformed",
          certainty: "uncertain",
          phase: "after_transmission",
        };
      }
    }
    const modified = modifiedFrom(raw, targetUid);
    if (modified !== undefined) {
      await releaseResponse(raw);
      return { kind: "modified", modifiedUids: modified };
    }
    if (hasModifiedCode(raw)) {
      await releaseResponse(raw);
      return {
        kind: "rejected",
        status: "malformed",
        certainty: "uncertain",
        phase: "after_transmission",
      };
    }
    if (!isExecResponse(raw)) {
      return {
        kind: "rejected",
        status: "malformed",
        certainty: "uncertain",
        phase: "after_transmission",
      };
    }
    const status = responseStatus(raw.response);
    if (status !== "OK") {
      await releaseResponse(raw);
      return {
        kind: "rejected",
        status: status === "NO" || status === "BAD" ? status : "malformed",
        certainty: "uncertain",
        phase: "after_transmission",
      };
    }
    await raw.next();
    return { kind: "applied" };
  };
}
