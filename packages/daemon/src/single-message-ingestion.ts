import {
  createBlobId,
  createMessageId,
  createRemoteUid,
  createUtcInstant,
  type MessageId,
  type RemoteUid,
  type UtcInstant,
} from "@agent-mail/core";
import {
  parseStagedEml,
  type MimeAttachmentMetadata,
  type MimeBodyMetadata,
  type MimeStreamPart,
  type ParsedStagedMime,
} from "../../imap/src/mime-parser";
import type { MetadataBatchItem } from "../../imap/src/metadata-batch";
import type {
  RawMessageDownloadRequest,
  RawMessageDownloadResult,
} from "../../imap/src/raw-download";
import type { PromotionStoragePort, PromotionCommit } from "../../storage/src/promotion-adapter";
import type {
  PromotionAddress,
  PromotionAttachment,
  PromotionBodyPart,
  PromotionHeader,
  PromotionJournalEvent,
  PromotionRoutingDecision,
} from "../../storage/src/canonical-promotion";
import { promoteBlob } from "../../storage/src/blob-promotion";
import { stageBlob, type BlobStageOwner } from "../../storage/src/blob-stage";

/** Stable failure surface for the one-message composition boundary. */
export type SingleMessageIngestionErrorCode =
  | "invalid-input"
  | "parse-failed"
  | "blob-failed"
  | "routing-failed"
  | "promotion-failed";

export class SingleMessageIngestionError extends Error {
  readonly code: SingleMessageIngestionErrorCode;

  constructor(code: SingleMessageIngestionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SingleMessageIngestionError";
    this.code = code;
  }
}

/** The small queue surface consumed by this caller; the actor remains the owner. */
export type RawMessageDownloadQueuePort = Readonly<{
  readonly download: (request: RawMessageDownloadRequest) => Promise<RawMessageDownloadResult>;
}>;

export type SingleMessageIngestionInput = Readonly<{
  readonly request: RawMessageDownloadRequest;
  /** The already parsed metadata row that authoritatively supplies INTERNALDATE. */
  readonly metadata: MetadataBatchItem;
}>;

type DownloadedMessage = RawMessageDownloadResult;

export type SingleMessageRoutingInput = Readonly<{
  readonly messageId: MessageId;
  readonly download: DownloadedMessage;
  readonly parsed: ParsedStagedMime;
  readonly internalDate: UtcInstant;
  readonly bodyParts: readonly PromotionBodyPart[];
  readonly attachments: readonly PromotionAttachment[];
}>;

export type SingleMessageIngestionDependencies = Readonly<{
  readonly queue: RawMessageDownloadQueuePort;
  readonly promotion: PromotionStoragePort;
  readonly stagingDirectory: string;
  readonly canonicalDirectory: string;
  readonly owner: BlobStageOwner;
  readonly routing: (input: SingleMessageRoutingInput) => readonly PromotionRoutingDecision[];
  readonly journal: (
    input: Readonly<{
      readonly messageId: MessageId;
      readonly downloaded: DownloadedMessage;
      readonly occurredAt: UtcInstant;
    }>,
  ) => PromotionJournalEvent;
  readonly occurredAt: UtcInstant;
}>;

type StagedPart = Readonly<{
  readonly kind: "body" | "attachment";
  readonly ordinal: number;
  readonly digest: string;
  readonly size: number;
}>;

/**
 * Consume exactly one completed queue download. Parsing, part publication, and
 * routing all finish before the one caller-facing promotion invocation.
 */
export async function ingestSingleMessage(
  input: SingleMessageIngestionInput,
  dependencies: SingleMessageIngestionDependencies,
): Promise<PromotionCommit> {
  const metadata = parseMetadataPlacement(input.metadata);
  assertIdentityMatches(metadata.identity, input.request, "metadata/request identity");
  const downloaded = await dependencies.queue.download(input.request);
  assertIdentityMatches(metadata.identity, downloaded.identity, "metadata/download identity");
  const messageId = createMessageId(`message:${downloaded.staged.digest}`);
  const publishedParts: StagedPart[] = [];
  let partSequence = Promise.resolve();

  let parsed: ParsedStagedMime;
  try {
    parsed = await parseStagedEml({
      sourcePath: downloaded.staged.path,
      onPart: (part) => {
        const next = partSequence.then(async () => {
          const staged = await stagePart(part, dependencies);
          await publishPart(staged, dependencies);
          publishedParts.push({
            kind: part.kind,
            ordinal: part.provenance.ordinal,
            digest: staged.digest,
            size: staged.size,
          });
        });
        partSequence = next;
        return next;
      },
    });
    await partSequence;
  } catch (error: unknown) {
    throw new SingleMessageIngestionError("parse-failed", "staged message parsing failed", {
      cause: error,
    });
  }

  let rawSource: Readonly<{ readonly digest: string; readonly size: number }>;
  try {
    await publishRaw(downloaded.staged, dependencies);
    rawSource = { digest: downloaded.staged.digest, size: downloaded.staged.size };
  } catch (error: unknown) {
    throw new SingleMessageIngestionError("blob-failed", "raw message blob publication failed", {
      cause: error,
    });
  }

  const bodyParts = parsed.bodyParts.map((part) =>
    bodyPartFrom(part, findPart(publishedParts, "body", part.ordinal)),
  );
  const attachments = parsed.attachments.map((attachment) =>
    attachmentFrom(attachment, findPart(publishedParts, "attachment", attachment.ordinal)),
  );

  let routingDecisions: readonly PromotionRoutingDecision[];
  try {
    routingDecisions = dependencies.routing({
      messageId,
      download: downloaded,
      parsed,
      internalDate: metadata.internalDate,
      bodyParts,
      attachments,
    });
  } catch (error: unknown) {
    throw new SingleMessageIngestionError("routing-failed", "routing input construction failed", {
      cause: error,
    });
  }

  const unit = {
    messageId,
    rawSource: { blobId: createBlobId(`blob:${rawSource.digest}`), size: rawSource.size },
    placements: [
      {
        accountId: downloaded.identity.accountId,
        mailboxId: downloaded.identity.mailboxId,
        uidValidity: downloaded.identity.uidValidity,
        uid: downloaded.identity.uid,
        internalDate: metadata.internalDate,
      },
    ],
    headers: parsed.headers.map(headerFrom),
    addresses: parsed.addresses.flatMap(addressFrom),
    bodyParts,
    attachments,
    routingDecisions,
    journal: dependencies.journal({
      messageId,
      downloaded,
      occurredAt: dependencies.occurredAt,
    }),
  };

  try {
    return dependencies.promotion.promote(unit);
  } catch (error: unknown) {
    throw new SingleMessageIngestionError("promotion-failed", "canonical promotion failed", {
      cause: error,
    });
  }
}

function parseMetadataPlacement(value: MetadataBatchItem): Readonly<{
  readonly identity: RemoteUid;
  readonly internalDate: UtcInstant;
}> {
  try {
    const identity = createRemoteUid(value.identity);
    const internalDate = createUtcInstant(value.internalDate);
    return { identity, internalDate };
  } catch (error: unknown) {
    throw new SingleMessageIngestionError(
      "invalid-input",
      "metadata placement identity or INTERNALDATE is invalid",
      { cause: error },
    );
  }
}

function assertIdentityMatches(
  expected: RemoteUid,
  actual: Readonly<{
    readonly accountId: unknown;
    readonly mailboxId: unknown;
    readonly uidValidity: unknown;
    readonly uid: unknown;
  }>,
  name: string,
): void {
  if (
    expected.accountId !== actual.accountId ||
    expected.mailboxId !== actual.mailboxId ||
    expected.uidValidity !== actual.uidValidity ||
    expected.uid !== actual.uid
  ) {
    throw new SingleMessageIngestionError("invalid-input", `${name} does not match`);
  }
}

async function stagePart(
  part: MimeStreamPart,
  dependencies: SingleMessageIngestionDependencies,
): Promise<Awaited<ReturnType<typeof stageBlob>>> {
  return stageBlob({
    stagingDirectory: dependencies.stagingDirectory,
    owner: dependencies.owner,
    source: part.content,
  });
}

async function publishPart(
  staged: Awaited<ReturnType<typeof stageBlob>>,
  dependencies: SingleMessageIngestionDependencies,
): Promise<void> {
  await promoteBlob({
    stagingPath: staged.path,
    canonicalDirectory: dependencies.canonicalDirectory,
    digest: staged.digest,
    size: staged.size,
  });
}

async function publishRaw(
  staged: DownloadedMessage["staged"],
  dependencies: SingleMessageIngestionDependencies,
): Promise<void> {
  await promoteBlob({
    stagingPath: staged.path,
    canonicalDirectory: dependencies.canonicalDirectory,
    digest: staged.digest,
    size: staged.size,
  });
}

function findPart(
  parts: readonly StagedPart[],
  kind: StagedPart["kind"],
  ordinal: number,
): StagedPart {
  const found = parts.find((part) => part.kind === kind && part.ordinal === ordinal);
  if (found === undefined)
    throw new SingleMessageIngestionError("invalid-input", "parser part has no staged blob");
  return found;
}

function bodyPartFrom(metadata: MimeBodyMetadata, staged: StagedPart): PromotionBodyPart {
  return {
    ordinal: metadata.ordinal,
    contentType: metadata.contentType,
    normalizedContentType: metadata.contentType.toLowerCase(),
    blobId: createBlobId(`blob:${staged.digest}`),
    size: staged.size,
  };
}

function attachmentFrom(metadata: MimeAttachmentMetadata, staged: StagedPart): PromotionAttachment {
  return {
    ordinal: metadata.ordinal,
    filename: metadata.filename,
    contentType: metadata.contentType,
    normalizedContentType: metadata.contentType.toLowerCase(),
    disposition: metadata.disposition,
    contentId: metadata.contentId,
    size: staged.size,
    blobId: createBlobId(`blob:${staged.digest}`),
  };
}

function headerFrom(header: ParsedStagedMime["headers"][number]): PromotionHeader {
  return {
    ordinal: header.ordinal,
    name: header.name,
    normalizedName: header.normalizedName,
    value: header.value,
    normalizedValue: header.normalizedValue,
  };
}

function addressFrom(address: ParsedStagedMime["addresses"][number]): readonly PromotionAddress[] {
  if (address.address === null) return [];
  const role = address.role === "reply-to" ? "reply_to" : address.role;
  return [
    {
      ordinal: address.ordinal,
      role,
      position: address.position,
      address: address.address,
      normalizedAddress: address.address.toLowerCase(),
      displayName: address.displayName,
      groupName: address.groupName,
    },
  ];
}
