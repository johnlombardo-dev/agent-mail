import type { AccountId, MessageId, ThreadId, UtcInstant } from "@agent-mail/core";

export const THREAD_NORMALIZER_VERSION = "thread-normalizer-v1" as const;
export const THREAD_GRAPH_VERSION = "thread-graph-v1" as const;
export const THREAD_IDENTITY_VERSION = "thread-identity-v1" as const;
export const THREAD_CURSOR_VERSION = "thread-cursor-v1" as const;

export const THREAD_LIMITS = Object.freeze({
  messageIdFieldBytes: 998,
  referencesFieldBytes: 16_384,
  inReplyToFieldBytes: 4_096,
  messageIdTokenBytes: 998,
  referencesTokens: 100,
  inReplyToTokens: 32,
  commentNestingDepth: 8,
  anchorsPerMessage: 134,
  pageDefault: 50,
  pageMaximum: 100,
  participantMaximum: 256,
  diagnosticsPerMessage: 16,
  diagnosticCodeBytes: 64,
  cursorBytes: 8192,
});

export type ThreadNodeKey = `i:${string}` | `m:${string}`;
export type NormalizedMessageId = string & { readonly __normalizedMessageId: "v1" };
export type ThreadSetId = string & { readonly __threadSetId: "v1" };
export type ThreadDiagnosticCode =
  | "absent"
  | "duplicate-field"
  | "field-too-large"
  | "invalid-unicode"
  | "forbidden-codepoint"
  | "malformed-cfws"
  | "malformed-token"
  | "too-many-tokens"
  | "self-edge-suppressed";

export type ThreadHeaderRow = Readonly<{
  readonly ordinal: number;
  readonly normalizedName: string;
  readonly value: string;
}>;

export type ThreadParticipantFact = Readonly<{
  readonly address: string;
  readonly displayName?: string | null;
  readonly role?: "from" | "sender" | "to" | "cc";
  readonly position?: number;
}>;

export type ThreadNormalizedFacts = Readonly<{
  readonly accountId: AccountId;
  readonly messageId: MessageId;
  readonly contentState: "identity-only" | "parsed";
  readonly memberNodeKey: ThreadNodeKey;
  readonly messageIdNodeKey: ThreadNodeKey | null;
  readonly normalizedMessageId: NormalizedMessageId | null;
  readonly references: readonly NormalizedMessageId[];
  readonly inReplyTo: readonly NormalizedMessageId[];
  readonly sentAt: UtcInstant | null;
  readonly receivedAt: UtcInstant | null;
  readonly diagnostics: readonly ThreadDiagnostic[];
  readonly factsSha256: string;
  readonly participants: readonly ThreadParticipantFact[];
  readonly participantsTruncated: boolean;
}>;

export type ThreadDiagnostic = Readonly<{
  readonly field: "message-id" | "references" | "in-reply-to";
  readonly code: ThreadDiagnosticCode;
  readonly ordinal: number | null;
}>;

export type ThreadMessage = Readonly<{
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly sentAt: UtcInstant | null;
  readonly receivedAt: UtcInstant;
  readonly subject: string | null;
  readonly participants: readonly ThreadParticipantFact[];
  readonly isUnread: boolean;
  readonly hasAttachment: boolean;
  readonly contentAvailable: boolean;
}>;

export type ThreadPage = Readonly<{
  readonly threadId: ThreadId;
  readonly resolvedFromThreadId: ThreadId | null;
  readonly subject: string | null;
  readonly participants: readonly ThreadParticipantFact[];
  readonly participantsTruncated: boolean;
  readonly messageCount: number;
  readonly messageIds: readonly MessageId[];
  readonly messages: readonly ThreadMessage[];
  readonly firstReceivedAt: UtcInstant;
  readonly lastReceivedAt: UtcInstant;
  readonly nextCursor: string | null;
}>;

export type ThreadCursorTuple = Readonly<{
  readonly sentAtMissingRank: 0 | 1;
  readonly sentAt: UtcInstant | null;
  readonly messageId: MessageId;
}>;

export type ThreadGraphSnapshot = Readonly<{
  readonly generation: number;
  readonly sets: readonly Readonly<{
    readonly accountId: AccountId;
    readonly setId: ThreadSetId;
    readonly canonicalRootNodeKey: ThreadNodeKey;
    readonly canonicalThreadId: ThreadId;
    readonly memberCount: number;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly handles: readonly ThreadId[];
    readonly members: readonly MessageId[];
  }>[];
}>;

export function memberNodeKey(messageId: MessageId): ThreadNodeKey {
  return `m:${messageId.slice("message:".length)}`;
}

export function assertNodeKey(value: string): asserts value is ThreadNodeKey {
  if (!/^[im]:[0-9a-f]{64}$/u.test(value)) throw new TypeError("invalid thread node key");
}
