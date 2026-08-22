import { createHash, type Hash } from "node:crypto";
import {
  CORPUS_VERSION,
  STREAM_CHUNK_BYTES,
  createObservedCorpusRun,
  type CorpusBodyPart,
  type CorpusMessage,
  type CorpusRunCompletionReceipt,
  type ObservedCorpusRun,
} from "../../src/demo/corpus/index.ts";

const PROFILE_ID_ENV = "FM1_DEMO_PROFILE_ID";
const PROFILE_SIZE = 250_000;
const CURRENT_RSS_SAMPLE_INTERVAL_MESSAGES = 256;
const SETTLE_MILLISECONDS = 50;
const scenarioMix = {
  ordinary: 1,
  transactional: 1,
  "mailing-list": 1,
  newsletter: 1,
  automated: 1,
  spam: 1,
};

type NativeRssUnit = "bytes" | "kibibytes";
type KernelHighWaterSource = "darwin-resource-usage-max-rss" | "linux-proc-vmhwm";

type HighWaterObservation = Readonly<{
  readonly nativeValue: number;
  readonly nativeUnit: NativeRssUnit;
  readonly bytesPerNativeUnit: 1 | 1024;
  readonly bytes: number;
}>;

type RssObservation = Readonly<{
  readonly currentBytes: number;
  readonly runtimeHighWater: HighWaterObservation;
  readonly kernelHighWater: HighWaterObservation;
  readonly kernelSource: KernelHighWaterSource;
}>;

type ProfileObservation = Readonly<{
  readonly protocol: "fm1-308";
  readonly identity: Readonly<{ readonly reportedPid: number; readonly token: string }>;
  readonly environment: Readonly<{
    readonly profile: "demo-corpus-250k";
    readonly scenarioVersion: string;
    readonly seed: string;
    readonly requestedSize: number;
    readonly memoryMethod: "kernel-high-water-with-sampled-current-rss-boundaries";
    readonly currentRssSampleIntervalMessages: number;
    readonly runtime: string;
  }>;
  readonly result: Readonly<{
    readonly producedCount: number;
    readonly logicalDigest: string;
    readonly contentDigest: string;
    readonly maximumStreamChunkBytes: number;
    readonly completed: boolean;
  }>;
  readonly memory: Readonly<{
    readonly rssUnit: "bytes";
    readonly currentRssSource: "bun-process-memory-usage-rss";
    readonly sampledCurrentRss: Readonly<{
      readonly baselineBytes: number;
      readonly maximumBytes: number;
      readonly preCleanupBytes: number;
      readonly postCleanupBytes: number;
      readonly maximumGrowthFromBaselineBytes: number;
      readonly preCleanupDeltaFromBaselineBytes: number;
      readonly postCleanupDeltaFromBaselineBytes: number;
      readonly baselineSampleIndex: number;
      readonly preCleanupSampleIndex: number;
      readonly postCleanupSampleIndex: number;
      readonly sampleCount: number;
    }>;
    readonly runtimeHighWater: Readonly<{
      readonly source: "bun-process-resource-usage-max-rss";
      readonly nativeUnit: NativeRssUnit;
      readonly bytesPerNativeUnit: 1 | 1024;
      readonly baselineNative: number;
      readonly baselineBytes: number;
      readonly finalNative: number;
      readonly finalBytes: number;
      readonly growthBytes: number;
    }>;
    readonly kernelHighWater: Readonly<{
      readonly source: KernelHighWaterSource;
      readonly nativeUnit: NativeRssUnit;
      readonly bytesPerNativeUnit: 1 | 1024;
      readonly baselineNative: number;
      readonly baselineBytes: number;
      readonly finalNative: number;
      readonly finalBytes: number;
      readonly growthBytes: number;
    }>;
  }>;
  readonly resources: Readonly<{
    readonly lifecycleReceipt: CorpusRunCompletionReceipt;
    readonly consumer: Readonly<{
      readonly generator: Readonly<{
        readonly closeRequestedCount: number;
        readonly closeAwaitedCount: number;
        readonly finallyCompletedCount: number;
        readonly maximumInFlightNextCalls: number;
        readonly maximumInFlightMessages: number;
      }>;
      readonly attachmentStreams: Readonly<{
        readonly closeRequestedCount: number;
        readonly closeAwaitedCount: number;
        readonly finallyCompletedCount: number;
        readonly maximumInFlightNextCalls: number;
        readonly maximumInFlightChunks: number;
        readonly maximumInFlightChunkBytes: number;
      }>;
    }>;
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

function nativeRuntimeHighWater(): HighWaterObservation {
  if (typeof process.resourceUsage !== "function")
    throw new Error("runtime RSS high-water API is unavailable");
  const nativeValue = process.resourceUsage().maxRSS;
  if (!Number.isSafeInteger(nativeValue) || nativeValue < 1)
    throw new Error("runtime RSS high-water value is invalid");
  if (process.platform === "darwin")
    return { nativeValue, nativeUnit: "bytes", bytesPerNativeUnit: 1, bytes: nativeValue };
  if (process.platform === "linux") {
    const bytes = nativeValue * 1024;
    if (!Number.isSafeInteger(bytes)) throw new Error("runtime RSS conversion is inexact");
    return { nativeValue, nativeUnit: "kibibytes", bytesPerNativeUnit: 1024, bytes };
  }
  throw new Error(`runtime RSS high-water unit is unavailable on ${process.platform}`);
}

async function readRssObservation(): Promise<RssObservation> {
  const currentBytes = process.memoryUsage().rss;
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 1)
    throw new Error("current RSS value is invalid");
  const runtimeHighWater = nativeRuntimeHighWater();
  if (process.platform === "darwin")
    return {
      currentBytes,
      runtimeHighWater,
      kernelHighWater: runtimeHighWater,
      kernelSource: "darwin-resource-usage-max-rss",
    };
  if (process.platform === "linux") {
    const status = await Bun.file("/proc/self/status").text();
    const match = /^VmHWM:\s+([0-9]+)\s+kB$/mu.exec(status);
    if (match === null) throw new Error("kernel RSS high-water value is unavailable");
    const nativeValue = Number(match[1]);
    const bytes = nativeValue * 1024;
    if (!Number.isSafeInteger(nativeValue) || nativeValue < 1 || !Number.isSafeInteger(bytes))
      throw new Error("kernel RSS high-water value is invalid");
    return {
      currentBytes,
      runtimeHighWater,
      kernelHighWater: {
        nativeValue,
        nativeUnit: "kibibytes",
        bytesPerNativeUnit: 1024,
        bytes,
      },
      kernelSource: "linux-proc-vmhwm",
    };
  }
  throw new Error(`kernel RSS high-water source is unavailable on ${process.platform}`);
}

async function run(): Promise<ProfileObservation> {
  const identityToken = process.env[PROFILE_ID_ENV];
  if (identityToken === undefined || identityToken.length === 0)
    throw new Error(`missing ${PROFILE_ID_ENV} identity token`);

  let logical: Hash | undefined = createHash("sha256");
  let content: Hash | undefined = createHash("sha256");
  let producedCount = 0;
  let maximumStreamChunkBytes = 0;
  let generatorInFlightNextCalls = 0;
  let maximumGeneratorInFlightNextCalls = 0;
  let maximumInFlightMessages = 0;
  let attachmentInFlightNextCalls = 0;
  let maximumAttachmentInFlightNextCalls = 0;
  let maximumInFlightChunks = 0;
  let maximumInFlightChunkBytes = 0;
  let generatorCloseRequestedCount = 0;
  let generatorCloseAwaitedCount = 0;
  let generatorConsumerFinallyCompletedCount = 0;
  let attachmentCloseRequestedCount = 0;
  let attachmentCloseAwaitedCount = 0;
  let attachmentConsumerFinallyCompletedCount = 0;
  const baseline = await readRssObservation();
  let sampledCurrentRssMaximumBytes = baseline.currentBytes;
  let currentRssSampleCount = 1;
  const sampleCurrentRss = (currentBytes = process.memoryUsage().rss): number => {
    if (!Number.isSafeInteger(currentBytes) || currentBytes < 1)
      throw new Error("sampled current RSS value is invalid");
    currentRssSampleCount += 1;
    sampledCurrentRssMaximumBytes = Math.max(sampledCurrentRssMaximumBytes, currentBytes);
    return currentRssSampleCount;
  };
  const baselineSampleIndex = 1;
  let observedRun: ObservedCorpusRun | undefined;
  let completion: Promise<CorpusRunCompletionReceipt> | undefined;
  let source: AsyncIterable<CorpusMessage> | undefined;
  let iterator: AsyncIterator<CorpusMessage> | undefined;

  const updateGeneratorInFlight = (delta: 1 | -1): void => {
    generatorInFlightNextCalls += delta;
    if (generatorInFlightNextCalls < 0)
      throw new Error("profile generator in-flight count became negative");
    maximumGeneratorInFlightNextCalls = Math.max(
      maximumGeneratorInFlightNextCalls,
      generatorInFlightNextCalls,
    );
  };
  const updateAttachmentInFlight = (delta: 1 | -1): void => {
    attachmentInFlightNextCalls += delta;
    if (attachmentInFlightNextCalls < 0)
      throw new Error("profile attachment in-flight count became negative");
    maximumAttachmentInFlightNextCalls = Math.max(
      maximumAttachmentInFlightNextCalls,
      attachmentInFlightNextCalls,
    );
  };

  const consumeAttachment = async (
    part: Extract<CorpusBodyPart, { readonly kind: "attachment" }>,
  ): Promise<void> => {
    let hash: Hash | undefined = createHash("sha256");
    let attachmentSource: AsyncIterable<Uint8Array> | undefined = part.openStream();
    let attachmentIterator: AsyncIterator<Uint8Array> | undefined =
      attachmentSource[Symbol.asyncIterator]();
    let byteLength = 0;
    try {
      let step: IteratorResult<Uint8Array> | undefined;
      while (true) {
        step = await nextWithInFlight(attachmentIterator, updateAttachmentInFlight);
        if (step.done) {
          step = undefined;
          break;
        }
        const chunk = step.value;
        if (chunk.byteLength > STREAM_CHUNK_BYTES)
          throw new Error("profile attachment stream exceeded the bounded chunk size");
        maximumStreamChunkBytes = Math.max(maximumStreamChunkBytes, chunk.byteLength);
        maximumInFlightChunks = Math.max(maximumInFlightChunks, 1);
        maximumInFlightChunkBytes = Math.max(maximumInFlightChunkBytes, chunk.byteLength);
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
      attachmentCloseRequestedCount += 1;
      try {
        await closeIterator(attachmentIterator);
        attachmentCloseAwaitedCount += 1;
      } finally {
        attachmentConsumerFinallyCompletedCount += 1;
        attachmentIterator = undefined;
        attachmentSource = undefined;
        hash = undefined;
      }
    }
  };

  observedRun = createObservedCorpusRun({
    scenarioVersion: CORPUS_VERSION,
    seed: "profile-250k",
    size: PROFILE_SIZE,
    scenarioMix,
  });
  completion = observedRun.completion;
  source = observedRun.stream;
  iterator = source[Symbol.asyncIterator]();
  try {
    let step: IteratorResult<CorpusMessage> | undefined;
    while (true) {
      step = await nextWithInFlight(iterator, updateGeneratorInFlight);
      if (step.done) {
        step = undefined;
        break;
      }
      const message = step.value;
      producedCount += 1;
      maximumInFlightMessages = Math.max(maximumInFlightMessages, 1);
      if (logical === undefined || content === undefined)
        throw new Error("profile hash was released before completion");
      logical.update(messageProjection(message));
      content.update(message.rawBytes);
      for (const part of message.parts) {
        if (part.kind === "attachment") await consumeAttachment(part);
      }
      step = undefined;
      if (producedCount % CURRENT_RSS_SAMPLE_INTERVAL_MESSAGES === 0) sampleCurrentRss();
    }
  } finally {
    generatorCloseRequestedCount += 1;
    try {
      await closeIterator(iterator);
      generatorCloseAwaitedCount += 1;
    } finally {
      generatorConsumerFinallyCompletedCount += 1;
      iterator = undefined;
      source = undefined;
    }
  }

  const lifecycleReceipt = await completion;
  const logicalDigest = finishHash(logical);
  logical = undefined;
  const contentDigest = finishHash(content);
  content = undefined;
  const preCleanup = await readRssObservation();
  const preCleanupSampleIndex = sampleCurrentRss(preCleanup.currentBytes);
  const fullGcAvailable = typeof Bun.gc === "function";
  if (!fullGcAvailable) throw new Error("full GC is unavailable; profile evidence is blocked");
  observedRun = undefined;
  completion = undefined;
  source = undefined;
  iterator = undefined;
  Bun.gc(true);
  Bun.gc(true);
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));
  const postCleanup = await readRssObservation();
  const postCleanupSampleIndex = sampleCurrentRss(postCleanup.currentBytes);
  if (
    baseline.kernelSource !== preCleanup.kernelSource ||
    baseline.kernelSource !== postCleanup.kernelSource ||
    baseline.runtimeHighWater.nativeUnit !== postCleanup.runtimeHighWater.nativeUnit ||
    baseline.kernelHighWater.nativeUnit !== postCleanup.kernelHighWater.nativeUnit
  )
    throw new Error("RSS high-water source or unit changed during profile");
  const referencesDropped =
    observedRun === undefined &&
    completion === undefined &&
    source === undefined &&
    iterator === undefined &&
    logical === undefined &&
    content === undefined;
  const completed =
    producedCount === PROFILE_SIZE &&
    lifecycleReceipt.generator.acquiredCount === 1 &&
    lifecycleReceipt.generator.yieldedCount === producedCount &&
    lifecycleReceipt.generator.finallyCompletedCount === 1 &&
    lifecycleReceipt.attachmentStreams.acquiredCount ===
      lifecycleReceipt.attachmentStreams.finallyCompletedCount &&
    generatorCloseRequestedCount === 1 &&
    generatorCloseAwaitedCount === 1 &&
    generatorConsumerFinallyCompletedCount === 1 &&
    attachmentCloseRequestedCount === lifecycleReceipt.attachmentStreams.acquiredCount &&
    attachmentCloseAwaitedCount === lifecycleReceipt.attachmentStreams.acquiredCount &&
    attachmentConsumerFinallyCompletedCount === lifecycleReceipt.attachmentStreams.acquiredCount &&
    referencesDropped;

  return {
    protocol: "fm1-308",
    identity: { reportedPid: process.pid, token: identityToken },
    environment: {
      profile: "demo-corpus-250k",
      scenarioVersion: CORPUS_VERSION,
      seed: "profile-250k",
      requestedSize: PROFILE_SIZE,
      memoryMethod: "kernel-high-water-with-sampled-current-rss-boundaries",
      currentRssSampleIntervalMessages: CURRENT_RSS_SAMPLE_INTERVAL_MESSAGES,
      runtime: Bun.version,
    },
    result: {
      producedCount,
      logicalDigest,
      contentDigest,
      maximumStreamChunkBytes,
      completed,
    },
    memory: {
      rssUnit: "bytes",
      currentRssSource: "bun-process-memory-usage-rss",
      sampledCurrentRss: {
        baselineBytes: baseline.currentBytes,
        maximumBytes: sampledCurrentRssMaximumBytes,
        preCleanupBytes: preCleanup.currentBytes,
        postCleanupBytes: postCleanup.currentBytes,
        maximumGrowthFromBaselineBytes: sampledCurrentRssMaximumBytes - baseline.currentBytes,
        preCleanupDeltaFromBaselineBytes: preCleanup.currentBytes - baseline.currentBytes,
        postCleanupDeltaFromBaselineBytes: postCleanup.currentBytes - baseline.currentBytes,
        baselineSampleIndex,
        preCleanupSampleIndex,
        postCleanupSampleIndex,
        sampleCount: currentRssSampleCount,
      },
      runtimeHighWater: {
        source: "bun-process-resource-usage-max-rss",
        nativeUnit: baseline.runtimeHighWater.nativeUnit,
        bytesPerNativeUnit: baseline.runtimeHighWater.bytesPerNativeUnit,
        baselineNative: baseline.runtimeHighWater.nativeValue,
        baselineBytes: baseline.runtimeHighWater.bytes,
        finalNative: postCleanup.runtimeHighWater.nativeValue,
        finalBytes: postCleanup.runtimeHighWater.bytes,
        growthBytes: postCleanup.runtimeHighWater.bytes - baseline.runtimeHighWater.bytes,
      },
      kernelHighWater: {
        source: baseline.kernelSource,
        nativeUnit: baseline.kernelHighWater.nativeUnit,
        bytesPerNativeUnit: baseline.kernelHighWater.bytesPerNativeUnit,
        baselineNative: baseline.kernelHighWater.nativeValue,
        baselineBytes: baseline.kernelHighWater.bytes,
        finalNative: postCleanup.kernelHighWater.nativeValue,
        finalBytes: postCleanup.kernelHighWater.bytes,
        growthBytes: postCleanup.kernelHighWater.bytes - baseline.kernelHighWater.bytes,
      },
    },
    resources: {
      lifecycleReceipt,
      consumer: {
        generator: {
          closeRequestedCount: generatorCloseRequestedCount,
          closeAwaitedCount: generatorCloseAwaitedCount,
          finallyCompletedCount: generatorConsumerFinallyCompletedCount,
          maximumInFlightNextCalls: maximumGeneratorInFlightNextCalls,
          maximumInFlightMessages,
        },
        attachmentStreams: {
          closeRequestedCount: attachmentCloseRequestedCount,
          closeAwaitedCount: attachmentCloseAwaitedCount,
          finallyCompletedCount: attachmentConsumerFinallyCompletedCount,
          maximumInFlightNextCalls: maximumAttachmentInFlightNextCalls,
          maximumInFlightChunks,
          maximumInFlightChunkBytes,
        },
      },
    },
    closure: {
      referencesDropped,
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
