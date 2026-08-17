import {
  createMonotonicSequence,
  createRemoteUidValue,
  createUidValidity,
  type MonotonicSequence,
  type RemoteUidValue,
  type UidValidity,
} from "@agent-mail/core";

/** A protocol value that was observed and validated. */
export type KnownFact<T> = { readonly kind: "known"; readonly value: T };
/** The provider did not return enough information to determine this fact. */
export type UnknownFact = { readonly kind: "unknown" };
/** The provider explicitly does not support this fact. */
export type UnsupportedFact = { readonly kind: "unsupported"; readonly reason: string };
export type ProtocolFact<T> = KnownFact<T> | UnknownFact | UnsupportedFact;

export type ImapCapabilityName = "SPECIAL-USE" | "IDLE";

export type ImapCapabilities = {
  readonly names: readonly string[];
  readonly specialUse: ProtocolFact<boolean>;
  readonly idle: ProtocolFact<boolean>;
};

export type MailboxStatusFacts = {
  readonly uidValidity: ProtocolFact<UidValidity>;
  readonly uidNext: ProtocolFact<RemoteUidValue>;
  readonly highestModseq: ProtocolFact<MonotonicSequence>;
  readonly selectability: ProtocolFact<boolean>;
  /** SPECIAL-USE flags returned for this mailbox, when the server provides them. */
  readonly specialUseFlags: ProtocolFact<readonly string[]>;
};

export type NormalizedImapResponse = {
  readonly capabilities: ImapCapabilities;
  readonly mailbox: MailboxStatusFacts;
  readonly error?: NormalizedProtocolError;
};

export type ProtocolErrorCategory =
  | "authentication"
  | "authorization"
  | "connection"
  | "timeout"
  | "cancelled"
  | "protocol"
  | "unknown";

export type SafeServerResponse = {
  readonly code?: string;
  readonly condition?: string;
  readonly text?: string;
};

export type NormalizedProtocolError = {
  readonly category: ProtocolErrorCategory;
  readonly serverResponse?: SafeServerResponse;
};

export type AdapterErrorCode =
  | "invalid-capabilities"
  | "invalid-mailbox-status"
  | "invalid-uid"
  | "invalid-modseq"
  | "invalid-selectability"
  | "invalid-special-use"
  | "invalid-protocol-error";

/** Stable, safe boundary error. It intentionally contains no provider payload. */
export class ImapAdapterError extends TypeError {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "ImapAdapterError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFact(): UnknownFact {
  return { kind: "unknown" };
}

function unsupportedFact(reason: string): UnsupportedFact {
  return { kind: "unsupported", reason };
}

function isMap(value: unknown): value is ReadonlyMap<unknown, unknown> {
  return value instanceof Map;
}

function stringList(value: unknown, code: AdapterErrorCode, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ImapAdapterError(code, `${name} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function capabilityNames(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const normalize = (item: string): string => {
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      throw new ImapAdapterError("invalid-capabilities", "capability names must not be blank");
    }
    return trimmed.toUpperCase();
  };
  if (isMap(value)) {
    return [...value.keys()].map((item) => {
      if (typeof item !== "string") {
        throw new ImapAdapterError("invalid-capabilities", "capability names must be strings");
      }
      return normalize(item);
    });
  }
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== "string")) {
      throw new ImapAdapterError("invalid-capabilities", "capability names must be strings");
    }
    return value.map((item) => normalize(item));
  }
  if (isRecord(value)) return Object.keys(value).map((item) => normalize(item));
  throw new ImapAdapterError(
    "invalid-capabilities",
    "capabilities must be a map, object, or array",
  );
}

function capabilityFact(
  names: readonly string[] | undefined,
  name: ImapCapabilityName,
): ProtocolFact<boolean> {
  if (names === undefined) return unknownFact();
  return names.includes(name)
    ? { kind: "known", value: true }
    : unsupportedFact(`${name} is not advertised`);
}

/** Normalize ImapFlow's Map-like capability collection without trusting its values. */
export function normalizeImapCapabilities(value: unknown): ImapCapabilities {
  const names = capabilityNames(value);
  return {
    names: names ?? [],
    specialUse: capabilityFact(names, "SPECIAL-USE"),
    idle: capabilityFact(names, "IDLE"),
  };
}

function integerValue(
  value: unknown,
  code: AdapterErrorCode,
  name: string,
  positive: boolean,
): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof numberValue !== "number" ||
    !Number.isSafeInteger(numberValue) ||
    (positive ? numberValue <= 0 : numberValue < 0)
  ) {
    throw new ImapAdapterError(
      code,
      `${name} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return numberValue;
}

function factFromField<T>(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  code: AdapterErrorCode,
  name: string,
  create: (value: unknown) => T,
): ProtocolFact<T> {
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (present.length === 0) return unknownFact();
  const values = present.map((key) => input[key]);
  if (values.some((value) => value === undefined || value === null)) return unknownFact();
  if (values.every((value) => value === "unsupported")) {
    return unsupportedFact(`${name} is not supported`);
  }
  if (values.some((value) => value === "unsupported")) {
    throw new ImapAdapterError(code, `${name} has conflicting aliases`);
  }
  let normalized: T[];
  try {
    normalized = values.map((item) => create(item));
  } catch {
    throw new ImapAdapterError(code, `${name} has an invalid value`);
  }
  if (normalized.some((item) => !Object.is(item, normalized[0]))) {
    throw new ImapAdapterError(code, `${name} has conflicting aliases`);
  }
  return { kind: "known", value: normalized[0] };
}

function selectability(input: Readonly<Record<string, unknown>>): ProtocolFact<boolean> {
  if (Object.prototype.hasOwnProperty.call(input, "selectable")) {
    const value = input.selectable;
    if (value === "unsupported") return unsupportedFact("selectability is not exposed");
    if (value === undefined || value === null) return unknownFact();
    if (typeof value !== "boolean") {
      throw new ImapAdapterError("invalid-selectability", "selectable must be a boolean");
    }
    return { kind: "known", value };
  }
  if (!Object.prototype.hasOwnProperty.call(input, "flags")) return unknownFact();
  const rawFlags = input.flags;
  if (rawFlags === undefined || rawFlags === null) return unknownFact();
  let flags: readonly string[];
  if (rawFlags instanceof Set) {
    flags = [...rawFlags].map((flag) => {
      if (typeof flag !== "string") {
        throw new ImapAdapterError("invalid-selectability", "mailbox flags must be strings");
      }
      return flag;
    });
  } else {
    flags = stringList(rawFlags, "invalid-selectability", "mailbox flags");
  }
  return { kind: "known", value: !flags.some((flag) => flag.toUpperCase() === "\\NOSELECT") };
}

function specialUseFlags(
  input: Readonly<Record<string, unknown>>,
): ProtocolFact<readonly string[]> {
  if (!Object.prototype.hasOwnProperty.call(input, "specialUse")) return unknownFact();
  const value = input.specialUse;
  if (value === "unsupported") return unsupportedFact("SPECIAL-USE flags are not exposed");
  if (value === undefined || value === null) return unknownFact();
  try {
    return { kind: "known", value: stringList(value, "invalid-special-use", "specialUse") };
  } catch (error: unknown) {
    if (error instanceof ImapAdapterError) throw error;
    throw new ImapAdapterError("invalid-special-use", "specialUse has an invalid value");
  }
}

/** Normalize one captured ImapFlow mailbox status result. No checkpoint is written. */
export function normalizeMailboxStatus(value: unknown): MailboxStatusFacts {
  if (!isRecord(value))
    throw new ImapAdapterError("invalid-mailbox-status", "mailbox status must be an object");
  return {
    uidValidity: factFromField(
      value,
      ["uidValidity", "uidvalidity"],
      "invalid-uid",
      "UIDVALIDITY",
      (item) => createUidValidity(integerValue(item, "invalid-uid", "UIDVALIDITY", true)),
    ),
    uidNext: factFromField(value, ["uidNext", "uidnext"], "invalid-uid", "UIDNEXT", (item) =>
      createRemoteUidValue(integerValue(item, "invalid-uid", "UIDNEXT", true)),
    ),
    highestModseq: factFromField(
      value,
      ["highestModseq", "highestModSeq", "highestmodseq"],
      "invalid-modseq",
      "HIGHESTMODSEQ",
      (item) =>
        createMonotonicSequence(integerValue(item, "invalid-modseq", "HIGHESTMODSEQ", false)),
    ),
    selectability: selectability(value),
    specialUseFlags: specialUseFlags(value),
  };
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    text += codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }
  text = text.trim();
  if (text.length === 0) return undefined;
  if (/(?:password|passwd|token|secret|credential|authorization)\s*[:=]/iu.test(text))
    return undefined;
  return text.slice(0, 256);
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,63}$/u.test(token) ? token : undefined;
}

function errorCategory(value: Readonly<Record<string, unknown>>): ProtocolErrorCategory {
  const category = typeof value.category === "string" ? value.category.toLowerCase() : "";
  if (
    ["authentication", "authorization", "connection", "timeout", "cancelled", "protocol"].includes(
      category,
    )
  ) {
    return category as ProtocolErrorCategory;
  }
  const code = safeToken(value.code) ?? safeToken(value.responseCode);
  if (code === "AUTHENTICATIONFAILED") return "authentication";
  if (code === "AUTHORIZATIONFAILED" || code === "NOPERM") return "authorization";
  if (code === "TIMEOUT" || value.name === "TimeoutError") return "timeout";
  if (value.name === "AbortError") return "cancelled";
  if (typeof value.code === "string" && /^(?:ECONN|ENET|EHOST|ETIMED)/u.test(value.code))
    return "connection";
  return "unknown";
}

/** Preserve only bounded protocol metadata; credentials and message bodies never cross this boundary. */
export function normalizeProtocolError(value: unknown): NormalizedProtocolError {
  if (!isRecord(value)) return { category: "unknown" };
  const response = isRecord(value.response) ? value.response : value;
  const serverResponse: SafeServerResponse = {
    code: safeToken(response.code ?? response.responseCode ?? response.statusCode),
    condition: safeToken(response.condition ?? response.status),
    text: safeText(response.text ?? response.responseText),
  };
  const metadata = Object.fromEntries(
    Object.entries(serverResponse).filter(([, item]) => item !== undefined),
  );
  return Object.keys(metadata).length === 0
    ? { category: errorCategory(value) }
    : { category: errorCategory(value), serverResponse: metadata as SafeServerResponse };
}

/** Normalize a captured response; this function has no network or persistence effects. */
export function normalizeImapResponse(value: unknown): NormalizedImapResponse {
  if (!isRecord(value))
    throw new ImapAdapterError("invalid-mailbox-status", "IMAP response must be an object");
  return {
    capabilities: normalizeImapCapabilities(value.capabilities),
    mailbox: normalizeMailboxStatus(value.mailbox ?? value.status ?? value),
    ...(value.error === undefined ? {} : { error: normalizeProtocolError(value.error) }),
  };
}
