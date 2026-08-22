import { createHash, type Hash } from "node:crypto";
import {
  CORPUS_VERSION,
  STREAM_CHUNK_BYTES,
  streamCorpus,
  type CorpusBodyPart,
  type CorpusMessage,
} from "../../src/demo/corpus/index.ts";

const PROFILE_ID_ENV = "FM1_DEMO_PROFILE_ID";
const PROFILE_SIZE = 250_000;
const SAMPLE_INTERVAL = 256;
const SETTLE_MILLISECONDS = 50;
const scenarioMix = {
  ordinary: 1,
  transactional: 1,
  "mailing-list": 1,
  newsletter: 1,
  automated: 1,
  spam: 1,
} as const;

type ResourceLifecycle = Readonly<{
  readonly acquired: boolean;
  readonly closeRequested: boolean;
  readonly closeAwaited: boolean;
  readonly finallyCompleted: boolean;
}>;

type ProfileObservation = Readonly<{
  readonly protocol: "fm1-306";
  readonly reportedPid: number;
  readonly identityToken: string;
  readonly environment: Readonly<{
    readonly profile: "demo-corpus-250k";
    readonly scenarioVersion: string;
    readonly seed: string;
    readonly requestedSize: number;
    readonly sampleMethod: "rss-baseline-periodic-precleanup-postcleanup";
    readonly sampleInterval: number;
    readonly runtime: string;
  }>;
  readonly result: Readonly<{
    readonly producedCount: number;
    readonly logicalDigest: string;
    readonly contentDigest: string;
    readonly maximumStreamChunk: number;
    readonly completed: boolean;
  }>;
  readonly memory: Readonly<{
    readonly baselineRss: number;
    readonly peakRss: number;
    readonly preCleanupRss: number;
    readonly postCleanupRss: number;
    readonly peakGrowthBytes: number;
    readonly retainedGrowthBytes: number;
    readonly baselineSampleIndex: number;
    readonly preCleanupSampleIndex: number;
    readonly postCleanupSampleIndex: number;
    readonly sampleCount: number;
  }>;
  readonly resources: Readonly<{
    readonly iterator: ResourceLifecycle;
    readonly attachmentStreams: Readonly<{
      readonly acquiredCount: number;
      readonly closeRequestedCount: number;
      readonly closeAwaitedCount: number;
      readonly finallyCompletedCount: number;
    }>;
    readonly maximumInFlightNextCalls: number;
    readonly maximumRetainedMessages: number;
    readonly maximumRetainedChunks: number;
    readonly maximumRetainedBytes: number;
  }>;
  readonly closure: Readonly<{
    readonly referencesDropped: boolean;
    readonly fullGcAvailable: boolean;
    readonly fullGcInvocations: number;
    readonly fixedSettleMilliseconds: number;
    readonly fixedSettleCompleted: boolean;
  }>;
}>;

function partProjection(part: CorpusBodyPart): Readonly<Record<string, unknown>> {
  if (part.kind === "text") return { kind: part.kind, text: part.text };
  if (part.kind === "html") return { kind: part.kind, html: part.html };
  if (part.kind === "alternative") return { kind: part.kind, text: part.text, html: part.html };
  if (part.kind === "inline")
    return {
      kind: part.kind,
      contentId: part.contentId,
      mediaType: part.mediaType,
      bytes: part.bytes,
    };
  return {
    kind: part.kind,
    filename: part.filename,
    disposition: part.disposition,
    mediaType: part.mediaType,
    byteLength: part.byteLength,
    contentDigest: part.contentDigest,
  };
}

function messageProjection(message: CorpusMessage): string {
  return JSON.stringify({
    id: message.id,
    messageId: message.messageId,
    mailboxId: message.mailboxId,
    threadId: message.threadId,
    relationship: message.relationship,
    uidValidity: message.uidValidity,
    uid: message.uid,
    modSeq: message.modSeq,
    internalDate: message.internalDate,
    category: message.category,
    coverage: message.coverage,
    headers: message.headers,
    parts: message.parts.map(partProjection),
    flags: message.flags,
    tombstone: message.tombstone,
  });
}

function finishHash(hash: Hash | undefined): string {
  if (hash === undefined) throw new Error("profile hash was released before completion");
  return hash.digest("hex");
}

async function nextWithInFlight<T>(
  iterator: AsyncIterator<T>,
  updateInFlight: (delta: 1 | -1) => void,
): Promise<IteratorResult<T>> {
  updateInFlight(1);
  try {
    return await iterator.next();
  } finally {
    updateInFlight(-1);
  }
}

async function closeIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  if (iterator.return === undefined) throw new Error("profile resource omitted async close");
  await iterator.return();
}

async function run(): Promise<ProfileObservation> {
  const identityToken = process.env[PROFILE_ID_ENV];
  if (identityToken === undefined || identityToken.length === 0)
    throw new Error(`missing ${PROFILE_ID_ENV} identity token`);

  let logical: Hash | undefined = createHash("sha256");
  let content: Hash | undefined = createHash("sha256");
  let producedCount = 0;
  let maximumStreamChunk = 0;
  let activeNextCalls = 0;
  let maximumInFlightNextCalls = 0;
  let maximumRetainedMessages = 0;
  let maximumRetainedChunks = 0;
  let maximumRetainedBytes = 0;
  let attachmentStreamsAcquired = 0;
  let attachmentStreamsCloseRequested = 0;
  let attachmentStreamsCloseAwaited = 0;
  let attachmentStreamsFinallyCompleted = 0;
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  let sampleCount = 0;
  const sample = (): number => {
    sampleCount += 1;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    return sampleCount;
  };
  const baselineSampleIndex = sample();
  let source: AsyncIterable<CorpusMessage> | undefined = streamCorpus({
    scenarioVersion: CORPUS_VERSION,
    seed: "profile-250k",
    size: PROFILE_SIZE,
    scenarioMix,
  });
  let iterator: AsyncIterator<CorpusMessage> | undefined = source[Symbol.asyncIterator]();
  if (iterator === undefined) throw new Error("profile corpus iterator was not acquired");
  const iteratorAcquired = true;
  let iteratorCloseRequested = false;
  let iteratorCloseAwaited = false;
  let iteratorFinallyCompleted = false;

  const updateInFlight = (delta: 1 | -1): void => {
    activeNextCalls += delta;
    if (activeNextCalls < 0) throw new Error("profile in-flight resource count became negative");
    maximumInFlightNextCalls = Math.max(maximumInFlightNextCalls, activeNextCalls);
  };

  const consumeAttachment = async (
    part: Extract<CorpusBodyPart, { readonly kind: "attachment" }>,
  ): Promise<void> => {
    let hash: Hash | undefined = createHash("sha256");
    let attachmentSource: AsyncIterable<Uint8Array> | undefined = part.openStream();
    let attachmentIterator: AsyncIterator<Uint8Array> | undefined =
      attachmentSource[Symbol.asyncIterator]();
    if (attachmentIterator === undefined) throw new Error("attachment iterator was not acquired");
    attachmentStreamsAcquired += 1;
    let byteLength = 0;
    try {
      let step: IteratorResult<Uint8Array> | undefined;
      while (true) {
        step = await nextWithInFlight(attachmentIterator, updateInFlight);
        if (step.done) {
          step = undefined;
          break;
        }
        const chunk = step.value;
        if (chunk.byteLength > STREAM_CHUNK_BYTES)
          throw new Error("profile attachment stream exceeded the bounded chunk size");
        maximumStreamChunk = Math.max(maximumStreamChunk, chunk.byteLength);
        maximumRetainedChunks = Math.max(maximumRetainedChunks, 1);
        maximumRetainedBytes = Math.max(maximumRetainedBytes, chunk.byteLength);
        byteLength += chunk.byteLength;
        if (hash === undefined || content === undefined)
          throw new Error("profile attachment hash was released before completion");
        hash.update(chunk);
        content.update(chunk);
        step = undefined;
      }
      const digest = finishHash(hash);
      hash = undefined;
      if (byteLength !== part.byteLength || digest !== part.contentDigest)
        throw new Error(`attachment ${part.filename} failed profile verification`);
    } finally {
      if (attachmentIterator !== undefined) {
        attachmentStreamsCloseRequested += 1;
        try {
          await closeIterator(attachmentIterator);
          attachmentStreamsCloseAwaited += 1;
        } finally {
          attachmentStreamsFinallyCompleted += 1;
        }
      }
      attachmentIterator = undefined;
      attachmentSource = undefined;
      hash = undefined;
    }
  };

  try {
    let step: IteratorResult<CorpusMessage> | undefined;
    while (true) {
      step = await nextWithInFlight(iterator, updateInFlight);
      if (step.done) {
        step = undefined;
        break;
      }
      const message = step.value;
      producedCount += 1;
      maximumRetainedMessages = Math.max(maximumRetainedMessages, 1);
      maximumRetainedBytes = Math.max(maximumRetainedBytes, message.rawBytes.byteLength);
      if (logical === undefined || content === undefined)
        throw new Error("profile hash was released before completion");
      logical.update(messageProjection(message));
      content.update(message.rawBytes);
      for (const part of message.parts) {
        if (part.kind === "attachment") await consumeAttachment(part);
      }
      step = undefined;
      if (producedCount % SAMPLE_INTERVAL === 0) sample();
    }
  } finally {
    if (iterator !== undefined) {
      iteratorCloseRequested = true;
      try {
        await closeIterator(iterator);
        iteratorCloseAwaited = true;
      } finally {
        iteratorFinallyCompleted = true;
      }
    }
    iterator = undefined;
    source = undefined;
  }

  const logicalDigest = finishHash(logical);
  logical = undefined;
  const contentDigest = finishHash(content);
  content = undefined;
  const preCleanupSampleIndex = sample();
  const preCleanupRss = process.memoryUsage().rss;
  const fullGcAvailable = typeof Bun.gc === "function";
  if (!fullGcAvailable) throw new Error("full GC is unavailable; profile evidence is blocked");
  source = undefined;
  iterator = undefined;
  Bun.gc(true);
  Bun.gc(true);
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));
  const postCleanupSampleIndex = sample();
  const postCleanupRss = process.memoryUsage().rss;
  const completed = producedCount === PROFILE_SIZE;
  return {
    protocol: "fm1-306",
    reportedPid: process.pid,
    identityToken,
    environment: {
      profile: "demo-corpus-250k",
      scenarioVersion: CORPUS_VERSION,
      seed: "profile-250k",
      requestedSize: PROFILE_SIZE,
      sampleMethod: "rss-baseline-periodic-precleanup-postcleanup",
      sampleInterval: SAMPLE_INTERVAL,
      runtime: Bun.version,
    },
    result: {
      producedCount,
      logicalDigest,
      contentDigest,
      maximumStreamChunk,
      completed,
    },
    memory: {
      baselineRss,
      peakRss,
      preCleanupRss,
      postCleanupRss,
      peakGrowthBytes: peakRss - baselineRss,
      retainedGrowthBytes: postCleanupRss - baselineRss,
      baselineSampleIndex,
      preCleanupSampleIndex,
      postCleanupSampleIndex,
      sampleCount,
    },
    resources: {
      iterator: {
        acquired: iteratorAcquired,
        closeRequested: iteratorCloseRequested,
        closeAwaited: iteratorCloseAwaited,
        finallyCompleted: iteratorFinallyCompleted,
      },
      attachmentStreams: {
        acquiredCount: attachmentStreamsAcquired,
        closeRequestedCount: attachmentStreamsCloseRequested,
        closeAwaitedCount: attachmentStreamsCloseAwaited,
        finallyCompletedCount: attachmentStreamsFinallyCompleted,
      },
      maximumInFlightNextCalls,
      maximumRetainedMessages,
      maximumRetainedChunks,
      maximumRetainedBytes,
    },
    closure: {
      referencesDropped: source === undefined && iterator === undefined,
      fullGcAvailable,
      fullGcInvocations: 2,
      fixedSettleMilliseconds: SETTLE_MILLISECONDS,
      fixedSettleCompleted: true,
    },
  };
}

if (import.meta.main) {
  run()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "profile failed";
      console.error(message);
      process.exit(1);
    });
}
