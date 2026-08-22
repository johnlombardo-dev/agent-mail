import { createHash } from "node:crypto";

declare const corpusMessageIdBrand: unique symbol;
declare const corpusMailboxIdBrand: unique symbol;
declare const corpusThreadIdBrand: unique symbol;
declare const corpusDigestBrand: unique symbol;

export type CorpusMessageId = string & { readonly [corpusMessageIdBrand]: "CorpusMessageId" };
export type CorpusMailboxId = string & { readonly [corpusMailboxIdBrand]: "CorpusMailboxId" };
export type CorpusThreadId = string & { readonly [corpusThreadIdBrand]: "CorpusThreadId" };
export type CorpusDigest = string & { readonly [corpusDigestBrand]: "CorpusDigest" };

export const CORPUS_VERSION = "agent-mail-demo-corpus.v1";
export const DEFAULT_REFERENCE_SIZE = 96;
export const MAX_GENERATED_SIZE = 250_000;
export const MAX_MATERIALIZED_SIZE = 10_000;
export const STREAM_CHUNK_BYTES = 64 * 1024;

export const scenarioCategories = Object.freeze([
  "ordinary",
  "transactional",
  "mailing-list",
  "newsletter",
  "automated",
  "spam",
] as const);
export type ScenarioCategory = (typeof scenarioCategories)[number];

export const requiredCoverageCases = Object.freeze([
  "ordinary",
  "transactional",
  "mailing-list",
  "newsletter",
  "automated",
  "spam",
  "long-thread",
  "forked-thread",
  "missing-reference",
  "duplicate-id",
  "cross-mailbox-thread",
  "unicode",
  "offset-date",
  "legal-unusual-headers",
  "missing-headers",
  "malformed-boundary",
  "text-body",
  "html-body",
  "alternative-body",
  "inline-part",
  "attachment",
  "large-streaming-attachment",
  "flags",
  "tombstone",
  "sparse-high-uid",
  "uidvalidity",
  "missing-uidnext",
  "missing-modseq",
  "prompt-injection",
  "hostile-link",
  "hostile-filename",
  "terminal-controls",
  "bidi-text",
  "secret-request",
  "unauthorized-action-request",
] as const);
export type RequiredCoverageCase = (typeof requiredCoverageCases)[number];

export type ScenarioMix = Readonly<Partial<Record<ScenarioCategory, number>>>;

export type CorpusOptions = Readonly<{
  readonly scenarioVersion: string;
  readonly seed: string;
  readonly size: number;
  readonly scenarioMix: ScenarioMix;
  /** Accepted for callers that vary execution context; never used as entropy. */
  readonly root?: string;
  readonly locale?: string;
  readonly timezone?: string;
  readonly wallClock?: string;
}>;

export type TextBody = Readonly<{ readonly kind: "text"; readonly text: string }>;
export type HtmlBody = Readonly<{ readonly kind: "html"; readonly html: string }>;
export type AlternativeBody = Readonly<{
  readonly kind: "alternative";
  readonly text: string;
  readonly html: string;
}>;
export type InlineBody = Readonly<{
  readonly kind: "inline";
  readonly contentId: string;
  readonly mediaType: string;
  readonly bytes: number;
}>;
export type AttachmentBody = Readonly<{
  readonly kind: "attachment";
  readonly filename: string;
  readonly disposition: "attachment" | "inline";
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentDigest: CorpusDigest;
  readonly openStream: () => AsyncIterable<Uint8Array>;
}>;
export type CorpusBodyPart = TextBody | HtmlBody | AlternativeBody | InlineBody | AttachmentBody;

export type CorpusRelationship =
  | Readonly<{ readonly kind: "root" }>
  | Readonly<{
      readonly kind: "reply";
      readonly inReplyTo: string;
      readonly references: readonly string[];
    }>
  | Readonly<{
      readonly kind: "fork";
      readonly inReplyTo: string;
      readonly references: readonly string[];
      readonly branch: number;
    }>
  | Readonly<{
      readonly kind: "missing-reference";
      readonly inReplyTo: string;
      readonly references: readonly string[];
    }>;

export type CorpusMessage = Readonly<{
  readonly id: CorpusMessageId;
  readonly messageId: string;
  readonly mailboxId: CorpusMailboxId;
  readonly threadId: CorpusThreadId;
  readonly relationship: CorpusRelationship;
  readonly uidValidity: number;
  readonly uid: number;
  readonly modSeq: number | null;
  readonly internalDate: string;
  readonly category: ScenarioCategory;
  readonly coverage: readonly RequiredCoverageCase[];
  readonly headers: Readonly<Record<string, string>>;
  readonly parts: readonly CorpusBodyPart[];
  readonly flags: readonly string[];
  readonly tombstone: boolean;
  readonly rawBytes: Uint8Array;
}>;

export type MailboxState = Readonly<{
  readonly id: CorpusMailboxId;
  readonly name: string;
  readonly uidValidity: number;
  readonly uidNext: number | null;
  readonly highestModSeq: number | null;
  readonly exists: number;
  readonly flags: readonly string[];
}>;

export type CorpusTimelineEvent =
  | Readonly<{
      readonly kind: "mailbox-created";
      readonly mailboxId: CorpusMailboxId;
      readonly at: string;
    }>
  | Readonly<{
      readonly kind: "message-added";
      readonly messageId: CorpusMessageId;
      readonly at: string;
    }>
  | Readonly<{
      readonly kind: "flags-updated";
      readonly messageId: CorpusMessageId;
      readonly flags: readonly string[];
      readonly at: string;
    }>
  | Readonly<{
      readonly kind: "tombstoned";
      readonly messageId: CorpusMessageId;
      readonly at: string;
    }>
  | Readonly<{
      readonly kind: "mailbox-state-observed";
      readonly mailboxId: CorpusMailboxId;
      readonly uidNext: number | null;
      readonly highestModSeq: number | null;
      readonly exists: number;
      readonly at: string;
    }>;

export type CorpusInventoryEntry = Readonly<{
  readonly caseId: RequiredCoverageCase;
  readonly messageIds: readonly CorpusMessageId[];
  readonly mailboxIds: readonly CorpusMailboxId[];
}>;

export type CorpusInventory = Readonly<{
  readonly requiredCases: readonly RequiredCoverageCase[];
  readonly entries: readonly CorpusInventoryEntry[];
  readonly presentCases: readonly RequiredCoverageCase[];
  readonly missingCases: readonly RequiredCoverageCase[];
}>;

export type DemoCorpus = Readonly<{
  readonly scenarioVersion: string;
  readonly seed: string;
  readonly size: number;
  readonly scenarioMix: ScenarioMix;
  readonly messages: readonly CorpusMessage[];
  readonly mailboxes: readonly MailboxState[];
  readonly timeline: readonly CorpusTimelineEvent[];
  readonly inventory: CorpusInventory;
  readonly logicalDigest: CorpusDigest;
  readonly byteDigest: CorpusDigest;
  readonly checksum: CorpusDigest;
}>;

function digest(value: string | Uint8Array): CorpusDigest {
  return createHash("sha256").update(value).digest("hex") as CorpusDigest;
}

export function createCorpusMessageId(value: string): CorpusMessageId {
  return `demo-message:${value}` as CorpusMessageId;
}

export function createCorpusMailboxId(value: string): CorpusMailboxId {
  return `demo-mailbox:${value}` as CorpusMailboxId;
}

export function createCorpusThreadId(value: string): CorpusThreadId {
  return `demo-thread:${value}` as CorpusThreadId;
}

export function createCorpusDigest(value: string | Uint8Array): CorpusDigest {
  return digest(value);
}

export function parseCorpusDigest(value: unknown): CorpusDigest {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    throw new TypeError("corpus digest must be a lowercase SHA-256 hex value");
  return value as CorpusDigest;
}
