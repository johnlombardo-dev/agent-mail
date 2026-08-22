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
const LIFECYCLE_PROBE_KEY = Symbol.for("agent-mail.demo.corpus.lifecycle-probe");
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
  readonly consumerFinallyCompleted: boolean;
}>;

type LifecycleProbe = Readonly<{
  readonly generator: Readonly<{
    readonly acquired: () => void;
    readonly yielded: () => void;
    readonly finallyCompleted: () => void;
  }>;
  readonly attachment: Readonly<{
    readonly acquired: () => void;
    readonly yielded: (byteLength: number) => void;
    readonly finallyCompleted: () => void;
  }>;
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
    readonly rssUnit: "bytes";
    readonly kernelHighWaterSource: "darwin-resource-usage-max-rss" | "linux-proc-vmhwm";
    readonly baselineRssBytes: number;
    readonly peakRssBytes: number;
    readonly preCleanupRssBytes: number;
    readonly postCleanupRssBytes: number;
    readonly baselineRuntimeHighWaterRssBytes: number;
    readonly baselineKernelHighWaterRssBytes: number;
    readonly runtimeHighWaterRssBytes: number;
    readonly kernelHighWaterRssBytes: number;
    readonly peakGrowthBytes: number;
    readonly retainedGrowthBytes: number;
    readonly baselineSampleIndex: number;
    readonly preCleanupSampleIndex: number;
    readonly postCleanupSampleIndex: number;
    readonly sampleCount: number;
  }>;
  readonly resources: Readonly<{
    readonly generator: ResourceLifecycle &
      Readonly<{
        readonly yieldedCount: number;
        readonly maximumInFlightNextCalls: number;
        readonly maximumRetainedMessages: number;
      }>;
    readonly attachmentStreams: Readonly<{
      readonly acquiredCount: number;
      readonly yieldedCount: number;
      readonly closeRequestedCount: number;
      readonly closeAwaitedCount: number;
      readonly finallyCompletedCount: number;
      readonly consumerFinallyCompletedCount: number;
      readonly maximumInFlightNextCalls: number;
      readonly maximumRetainedChunks: number;
      readonly maximumRetainedBytes: number;
      readonly maximumBodyChunk: number;
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

type RssObservation = Readonly<{
  readonly currentBytes: number;
  readonly runtimeHighWaterBytes: number;
  readonly kernelHighWaterBytes: number;
  readonly kernelSource: "darwin-resource-usage-max-rss" | "linux-proc-vmhwm";
}>;

async function readRssObservation(): Promise<RssObservation> {
  if (typeof process.resourceUsage !== "function")
    throw new Error("runtime RSS high-water API is unavailable");
  const currentBytes = process.memoryUsage().rss;
  const runtimeHighWaterBytes = process.resourceUsage().maxRSS;
  if (!Number.isSafeInteger(runtimeHighWaterBytes) || runtimeHighWaterBytes < 1)
    throw new Error("runtime RSS high-water value is invalid");
  if (process.platform === "darwin")
    return {
      currentBytes,
      runtimeHighWaterBytes,
      kernelHighWaterBytes: runtimeHighWaterBytes,
      kernelSource: "darwin-resource-usage-max-rss",
    };
  if (process.platform === "linux") {
    const status = await Bun.file("/proc/self/status").text();
    const match = /^VmHWM:\s+([0-9]+)\s+kB$/mu.exec(status);
    if (match === null) throw new Error("kernel RSS high-water value is unavailable");
    const kernelHighWaterBytes = Number(match[1]) * 1024;
    if (!Number.isSafeInteger(kernelHighWaterBytes) || kernelHighWaterBytes < 1)
      throw new Error("kernel RSS high-water value is invalid");
    return {
      currentBytes,
      runtimeHighWaterBytes,
      kernelHighWaterBytes,
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
  let maximumStreamChunk = 0;
  let generatorInFlightNextCalls = 0;
  let maximumGeneratorInFlightNextCalls = 0;
  let maximumGeneratorRetainedMessages = 0;
  let attachmentInFlightNextCalls = 0;
  let maximumAttachmentInFlightNextCalls = 0;
  let maximumAttachmentRetainedChunks = 0;
  let maximumAttachmentRetainedBytes = 0;
  let generatorAcquired = 0;
  let generatorYielded = 0;
  let generatorFinallyCompleted = 0;
  let generatorConsumerFinallyCompleted = false;
  let attachmentStreamsAcquired = 0;
  let attachmentStreamsYielded = 0;
  let attachmentStreamsBodyFinallyCompleted = 0;
  let attachmentStreamsConsumerFinallyCompleted = 0;
  let attachmentBodyMaximumChunk = 0;
  let attachmentStreamsCloseRequested = 0;
  let attachmentStreamsCloseAwaited = 0;
  const baseline = await readRssObservation();
  let peakRssBytes = baseline.currentBytes;
  let sampleCount = 0;
  const sample = (): number => {
    sampleCount += 1;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    return sampleCount;
  };
  const baselineSampleIndex = sample();
  let source: AsyncIterable<CorpusMessage> | undefined;
  let iterator: AsyncIterator<CorpusMessage> | undefined;
  let iteratorCloseRequested = false;
  let iteratorCloseAwaited = false;
  const probe: LifecycleProbe = {
    generator: {
      acquired: () => {
        generatorAcquired += 1;
      },
      yielded: () => {
        generatorYielded += 1;
      },
      finallyCompleted: () => {
        generatorFinallyCompleted += 1;
      },
    },
    attachment: {
      acquired: () => {
        attachmentStreamsAcquired += 1;
      },
      yielded: (byteLength) => {
        attachmentStreamsYielded += 1;
        attachmentBodyMaximumChunk = Math.max(attachmentBodyMaximumChunk, byteLength);
      },
      finallyCompleted: () => {
        attachmentStreamsBodyFinallyCompleted += 1;
      },
    },
  };

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
    if (attachmentIterator === undefined) throw new Error("attachment iterator was not acquired");
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
        maximumStreamChunk = Math.max(maximumStreamChunk, chunk.byteLength);
        maximumAttachmentRetainedChunks = Math.max(maximumAttachmentRetainedChunks, 1);
        maximumAttachmentRetainedBytes = Math.max(maximumAttachmentRetainedBytes, chunk.byteLength);
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
          attachmentStreamsConsumerFinallyCompleted += 1;
        }
      }
      attachmentIterator = undefined;
      attachmentSource = undefined;
      hash = undefined;
    }
  };

  {
    source = streamCorpus({
      scenarioVersion: CORPUS_VERSION,
      seed: "profile-250k",
      size: PROFILE_SIZE,
      scenarioMix,
      [LIFECYCLE_PROBE_KEY]: probe,
    });
    iterator = source[Symbol.asyncIterator]();
    if (iterator === undefined) throw new Error("profile corpus iterator was not acquired");
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
        maximumGeneratorRetainedMessages = Math.max(maximumGeneratorRetainedMessages, 1);
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
          iterator = undefined;
          source = undefined;
          generatorConsumerFinallyCompleted = true;
        }
      } else {
        source = undefined;
        generatorConsumerFinallyCompleted = true;
      }
    }
  }

  const logicalDigest = finishHash(logical);
  logical = undefined;
  const contentDigest = finishHash(content);
  content = undefined;
  const preCleanupSampleIndex = sample();
  const preCleanup = await readRssObservation();
  const fullGcAvailable = typeof Bun.gc === "function";
  if (!fullGcAvailable) throw new Error("full GC is unavailable; profile evidence is blocked");
  source = undefined;
  iterator = undefined;
  Bun.gc(true);
  Bun.gc(true);
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));
  const postCleanupSampleIndex = sample();
  const postCleanup = await readRssObservation();
  if (
    baseline.kernelSource !== preCleanup.kernelSource ||
    baseline.kernelSource !== postCleanup.kernelSource
  )
    throw new Error("kernel RSS high-water source changed during profile");
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
      rssUnit: "bytes",
      kernelHighWaterSource: baseline.kernelSource,
      baselineRssBytes: baseline.currentBytes,
      peakRssBytes,
      preCleanupRssBytes: preCleanup.currentBytes,
      postCleanupRssBytes: postCleanup.currentBytes,
      baselineRuntimeHighWaterRssBytes: baseline.runtimeHighWaterBytes,
      baselineKernelHighWaterRssBytes: baseline.kernelHighWaterBytes,
      runtimeHighWaterRssBytes: postCleanup.runtimeHighWaterBytes,
      kernelHighWaterRssBytes: postCleanup.kernelHighWaterBytes,
      peakGrowthBytes: peakRssBytes - baseline.currentBytes,
      retainedGrowthBytes: postCleanup.currentBytes - baseline.currentBytes,
      baselineSampleIndex,
      preCleanupSampleIndex,
      postCleanupSampleIndex,
      sampleCount,
    },
    resources: {
      generator: {
        acquired: generatorAcquired === 1,
        closeRequested: iteratorCloseRequested,
        closeAwaited: iteratorCloseAwaited,
        finallyCompleted: generatorFinallyCompleted === 1,
        consumerFinallyCompleted: generatorConsumerFinallyCompleted,
        yieldedCount: generatorYielded,
        maximumInFlightNextCalls: maximumGeneratorInFlightNextCalls,
        maximumRetainedMessages: maximumGeneratorRetainedMessages,
      },
      attachmentStreams: {
        acquiredCount: attachmentStreamsAcquired,
        yieldedCount: attachmentStreamsYielded,
        closeRequestedCount: attachmentStreamsCloseRequested,
        closeAwaitedCount: attachmentStreamsCloseAwaited,
        finallyCompletedCount: attachmentStreamsBodyFinallyCompleted,
        consumerFinallyCompletedCount: attachmentStreamsConsumerFinallyCompleted,
        maximumInFlightNextCalls: maximumAttachmentInFlightNextCalls,
        maximumRetainedChunks: maximumAttachmentRetainedChunks,
        maximumRetainedBytes: maximumAttachmentRetainedBytes,
        maximumBodyChunk: attachmentBodyMaximumChunk,
      },
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
