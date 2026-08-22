import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CORPUS_VERSION,
  DEFAULT_REFERENCE_SIZE,
  STREAM_CHUNK_BYTES,
  assertCorpusAttachmentStreams,
  assertCorpusIntegrity,
  assertRequiredCoverage,
  buildCorpus,
  checksumCorpus,
  CorpusOptionsError,
  createObservedCorpusRun,
  createCorpusMailboxId,
  createCorpusThreadId,
  deriveCorpusInventory,
  parseCorpusOptions,
  requiredCoverageCases,
  streamCorpus,
  type CorpusRunCompletionReceipt,
  type ObservedCorpusRun,
} from "../src/demo/corpus/index.ts";
import {
  parseDarwinProcessIdentity,
  readDarwinProcessIdentity,
  type DarwinProcessIdentity,
} from "./helpers/darwin-process-identity.ts";

const scenarioMix = {
  ordinary: 1,
  transactional: 1,
  "mailing-list": 1,
  newsletter: 1,
  automated: 1,
  spam: 1,
};

function options(seed: string, size = DEFAULT_REFERENCE_SIZE) {
  return { scenarioVersion: CORPUS_VERSION, seed, size, scenarioMix };
}

type NativeRssUnit = "bytes" | "kibibytes";
type KernelHighWaterSource = "darwin-resource-usage-max-rss" | "linux-proc-vmhwm";
type ParsedHighWater = Readonly<{
  readonly source: string;
  readonly nativeUnit: NativeRssUnit;
  readonly bytesPerNativeUnit: 1 | 1024;
  readonly baselineNative: number;
  readonly baselineBytes: number;
  readonly finalNative: number;
  readonly finalBytes: number;
  readonly growthBytes: number;
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
    readonly completed: true;
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
    readonly runtimeHighWater: ParsedHighWater &
      Readonly<{ readonly source: "bun-process-resource-usage-max-rss" }>;
    readonly kernelHighWater: ParsedHighWater &
      Readonly<{ readonly source: KernelHighWaterSource }>;
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
    readonly referencesDropped: true;
    readonly fullGcAvailable: true;
    readonly fullGcInvocations: number;
    readonly fixedSettleMilliseconds: number;
    readonly fixedSettleCompleted: true;
  }>;
}>;

type PostExitIdentity = "absent" | "same-identity-survivor" | "reused-pid";
type ProfileRun = Readonly<{
  readonly observation: ProfileObservation;
  readonly process: Readonly<{
    readonly pid: number;
    readonly exitCode: number;
    readonly receiptIdentityMatches: boolean;
    readonly startSource: "darwin-proc-pid-tbsdinfo";
    readonly startTimeUnit: "microseconds-since-unix-epoch";
    readonly exactStartIdentity: string;
    readonly postExitIdentity: PostExitIdentity;
    readonly ownedSurvivors: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}>;

type RecordValue = Readonly<Record<string, unknown>>;

function recordValue(value: unknown, name: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value;
}

function exactRecord(value: unknown, name: string, expectedKeys: readonly string[]): RecordValue {
  const record = recordValue(value, name);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new TypeError(`${name} fields are invalid`);
  return record;
}

function nonemptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${name} must be a nonempty string`);
  return value;
}

function signedInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new TypeError(`${name} must be a safe integer`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const result = signedInteger(value, name);
  if (result < 1) throw new TypeError(`${name} must be positive`);
  return result;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const result = signedInteger(value, name);
  if (result < 0) throw new TypeError(`${name} must be non-negative`);
  return result;
}

function digest(value: unknown, name: string): string {
  const result = nonemptyString(value, name);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return result;
}

function trueValue(value: unknown, name: string): true {
  if (value !== true) throw new TypeError(`${name} must be observed true`);
  return true;
}

function parseNativeUnit(value: unknown, name: string): NativeRssUnit {
  if (value === "bytes" || value === "kibibytes") return value;
  throw new TypeError(`${name} is unavailable`);
}

function parseHighWater(value: unknown, name: string): ParsedHighWater {
  const record = exactRecord(value, name, [
    "source",
    "nativeUnit",
    "bytesPerNativeUnit",
    "baselineNative",
    "baselineBytes",
    "finalNative",
    "finalBytes",
    "growthBytes",
  ]);
  const nativeUnit = parseNativeUnit(record.nativeUnit, `${name}.nativeUnit`);
  const bytesPerNativeUnit = positiveInteger(
    record.bytesPerNativeUnit,
    `${name}.bytesPerNativeUnit`,
  );
  if (
    (nativeUnit === "bytes" && bytesPerNativeUnit !== 1) ||
    (nativeUnit === "kibibytes" && bytesPerNativeUnit !== 1024)
  )
    throw new TypeError(`${name} unit conversion is invalid`);
  const baselineNative = positiveInteger(record.baselineNative, `${name}.baselineNative`);
  const baselineBytes = positiveInteger(record.baselineBytes, `${name}.baselineBytes`);
  const finalNative = positiveInteger(record.finalNative, `${name}.finalNative`);
  const finalBytes = positiveInteger(record.finalBytes, `${name}.finalBytes`);
  const growthBytes = nonNegativeInteger(record.growthBytes, `${name}.growthBytes`);
  if (
    baselineNative * bytesPerNativeUnit !== baselineBytes ||
    finalNative * bytesPerNativeUnit !== finalBytes ||
    finalBytes < baselineBytes ||
    finalBytes - baselineBytes !== growthBytes
  )
    throw new TypeError(`${name} arithmetic is inconsistent`);
  return {
    source: nonemptyString(record.source, `${name}.source`),
    nativeUnit,
    bytesPerNativeUnit: bytesPerNativeUnit === 1 ? 1 : 1024,
    baselineNative,
    baselineBytes,
    finalNative,
    finalBytes,
    growthBytes,
  };
}

function parseLifecycleReceipt(value: unknown): CorpusRunCompletionReceipt {
  const root = exactRecord(value, "lifecycle receipt", [
    "protocol",
    "generator",
    "attachmentStreams",
  ]);
  if (root.protocol !== "agent-mail-demo-corpus-run.v1")
    throw new TypeError("lifecycle receipt protocol is invalid");
  const generator = exactRecord(root.generator, "lifecycle generator", [
    "acquiredCount",
    "yieldedCount",
    "finallyCompletedCount",
  ]);
  const attachmentStreams = exactRecord(root.attachmentStreams, "lifecycle attachments", [
    "acquiredCount",
    "yieldedCount",
    "finallyCompletedCount",
    "maximumYieldedChunkBytes",
  ]);
  return Object.freeze({
    protocol: "agent-mail-demo-corpus-run.v1",
    generator: Object.freeze({
      acquiredCount: positiveInteger(generator.acquiredCount, "generator acquiredCount"),
      yieldedCount: positiveInteger(generator.yieldedCount, "generator yieldedCount"),
      finallyCompletedCount: positiveInteger(
        generator.finallyCompletedCount,
        "generator finallyCompletedCount",
      ),
    }),
    attachmentStreams: Object.freeze({
      acquiredCount: positiveInteger(attachmentStreams.acquiredCount, "attachment acquiredCount"),
      yieldedCount: positiveInteger(attachmentStreams.yieldedCount, "attachment yieldedCount"),
      finallyCompletedCount: positiveInteger(
        attachmentStreams.finallyCompletedCount,
        "attachment finallyCompletedCount",
      ),
      maximumYieldedChunkBytes: positiveInteger(
        attachmentStreams.maximumYieldedChunkBytes,
        "attachment maximumYieldedChunkBytes",
      ),
    }),
  });
}

function parseProfileObservation(value: unknown): ProfileObservation {
  const root = exactRecord(value, "profile observation", [
    "protocol",
    "identity",
    "environment",
    "result",
    "memory",
    "resources",
    "closure",
  ]);
  if (root.protocol !== "fm1-308") throw new TypeError("profile protocol is invalid");
  const identity = exactRecord(root.identity, "profile identity", ["reportedPid", "token"]);
  const environment = exactRecord(root.environment, "profile environment", [
    "profile",
    "scenarioVersion",
    "seed",
    "requestedSize",
    "memoryMethod",
    "currentRssSampleIntervalMessages",
    "runtime",
  ]);
  if (environment.profile !== "demo-corpus-250k") throw new TypeError("profile name is invalid");
  if (environment.memoryMethod !== "kernel-high-water-with-sampled-current-rss-boundaries")
    throw new TypeError("profile memory method is unavailable");
  const resultRecord = exactRecord(root.result, "profile result", [
    "producedCount",
    "logicalDigest",
    "contentDigest",
    "maximumStreamChunkBytes",
    "completed",
  ]);
  const memory = exactRecord(root.memory, "profile memory", [
    "rssUnit",
    "currentRssSource",
    "sampledCurrentRss",
    "runtimeHighWater",
    "kernelHighWater",
  ]);
  if (memory.rssUnit !== "bytes") throw new TypeError("RSS unit is unavailable");
  if (memory.currentRssSource !== "bun-process-memory-usage-rss")
    throw new TypeError("current RSS source is unavailable");
  const sampled = exactRecord(memory.sampledCurrentRss, "sampled current RSS", [
    "baselineBytes",
    "maximumBytes",
    "preCleanupBytes",
    "postCleanupBytes",
    "maximumGrowthFromBaselineBytes",
    "preCleanupDeltaFromBaselineBytes",
    "postCleanupDeltaFromBaselineBytes",
    "baselineSampleIndex",
    "preCleanupSampleIndex",
    "postCleanupSampleIndex",
    "sampleCount",
  ]);
  const runtimeHighWater = parseHighWater(memory.runtimeHighWater, "runtime high-water RSS");
  if (runtimeHighWater.source !== "bun-process-resource-usage-max-rss")
    throw new TypeError("runtime high-water RSS source is unavailable");
  const kernelHighWater = parseHighWater(memory.kernelHighWater, "kernel high-water RSS");
  if (
    kernelHighWater.source !== "darwin-resource-usage-max-rss" &&
    kernelHighWater.source !== "linux-proc-vmhwm"
  )
    throw new TypeError("kernel high-water RSS source is unavailable");
  if (
    (kernelHighWater.source === "darwin-resource-usage-max-rss" &&
      (kernelHighWater.nativeUnit !== "bytes" || kernelHighWater.bytesPerNativeUnit !== 1)) ||
    (kernelHighWater.source === "linux-proc-vmhwm" &&
      (kernelHighWater.nativeUnit !== "kibibytes" || kernelHighWater.bytesPerNativeUnit !== 1024))
  )
    throw new TypeError("kernel high-water RSS unit is inconsistent with its source");
  const resources = exactRecord(root.resources, "profile resources", [
    "lifecycleReceipt",
    "consumer",
  ]);
  const lifecycleReceipt = parseLifecycleReceipt(resources.lifecycleReceipt);
  const consumer = exactRecord(resources.consumer, "profile consumer", [
    "generator",
    "attachmentStreams",
  ]);
  const consumerGenerator = exactRecord(consumer.generator, "consumer generator", [
    "closeRequestedCount",
    "closeAwaitedCount",
    "finallyCompletedCount",
    "maximumInFlightNextCalls",
    "maximumInFlightMessages",
  ]);
  const consumerAttachments = exactRecord(consumer.attachmentStreams, "consumer attachments", [
    "closeRequestedCount",
    "closeAwaitedCount",
    "finallyCompletedCount",
    "maximumInFlightNextCalls",
    "maximumInFlightChunks",
    "maximumInFlightChunkBytes",
  ]);
  const closure = exactRecord(root.closure, "profile closure", [
    "referencesDropped",
    "fullGcAvailable",
    "fullGcInvocations",
    "fixedSettleMilliseconds",
    "fixedSettleCompleted",
  ]);
  const requestedSize = positiveInteger(environment.requestedSize, "requestedSize");
  const sampleInterval = positiveInteger(
    environment.currentRssSampleIntervalMessages,
    "currentRssSampleIntervalMessages",
  );
  const producedCount = positiveInteger(resultRecord.producedCount, "producedCount");
  const maximumStreamChunkBytes = positiveInteger(
    resultRecord.maximumStreamChunkBytes,
    "maximumStreamChunkBytes",
  );
  const baselineBytes = positiveInteger(sampled.baselineBytes, "sampled baselineBytes");
  const maximumBytes = positiveInteger(sampled.maximumBytes, "sampled maximumBytes");
  const preCleanupBytes = positiveInteger(sampled.preCleanupBytes, "sampled preCleanupBytes");
  const postCleanupBytes = positiveInteger(sampled.postCleanupBytes, "sampled postCleanupBytes");
  const maximumGrowthFromBaselineBytes = nonNegativeInteger(
    sampled.maximumGrowthFromBaselineBytes,
    "sampled maximumGrowthFromBaselineBytes",
  );
  const preCleanupDeltaFromBaselineBytes = signedInteger(
    sampled.preCleanupDeltaFromBaselineBytes,
    "sampled preCleanupDeltaFromBaselineBytes",
  );
  const postCleanupDeltaFromBaselineBytes = signedInteger(
    sampled.postCleanupDeltaFromBaselineBytes,
    "sampled postCleanupDeltaFromBaselineBytes",
  );
  const baselineSampleIndex = positiveInteger(sampled.baselineSampleIndex, "baselineSampleIndex");
  const preCleanupSampleIndex = positiveInteger(
    sampled.preCleanupSampleIndex,
    "preCleanupSampleIndex",
  );
  const postCleanupSampleIndex = positiveInteger(
    sampled.postCleanupSampleIndex,
    "postCleanupSampleIndex",
  );
  const sampleCount = positiveInteger(sampled.sampleCount, "sampleCount");
  const generatorCloseRequestedCount = positiveInteger(
    consumerGenerator.closeRequestedCount,
    "generator closeRequestedCount",
  );
  const generatorCloseAwaitedCount = positiveInteger(
    consumerGenerator.closeAwaitedCount,
    "generator closeAwaitedCount",
  );
  const generatorFinallyCompletedCount = positiveInteger(
    consumerGenerator.finallyCompletedCount,
    "generator consumer finallyCompletedCount",
  );
  const attachmentCloseRequestedCount = positiveInteger(
    consumerAttachments.closeRequestedCount,
    "attachment closeRequestedCount",
  );
  const attachmentCloseAwaitedCount = positiveInteger(
    consumerAttachments.closeAwaitedCount,
    "attachment closeAwaitedCount",
  );
  const attachmentFinallyCompletedCount = positiveInteger(
    consumerAttachments.finallyCompletedCount,
    "attachment consumer finallyCompletedCount",
  );
  const maximumInFlightChunkBytes = positiveInteger(
    consumerAttachments.maximumInFlightChunkBytes,
    "maximumInFlightChunkBytes",
  );
  const observedCompleted = trueValue(resultRecord.completed, "result.completed");
  const referencesDropped = trueValue(closure.referencesDropped, "referencesDropped");
  const fullGcAvailable = trueValue(closure.fullGcAvailable, "fullGcAvailable");
  const fixedSettleCompleted = trueValue(closure.fixedSettleCompleted, "fixedSettleCompleted");
  if (requestedSize !== 250_000 || producedCount !== requestedSize)
    throw new TypeError("profile completion count is inconsistent");
  if (
    maximumStreamChunkBytes > STREAM_CHUNK_BYTES ||
    lifecycleReceipt.attachmentStreams.maximumYieldedChunkBytes !== maximumStreamChunkBytes ||
    maximumInFlightChunkBytes !== maximumStreamChunkBytes
  )
    throw new TypeError("profile chunk equations are inconsistent");
  if (
    maximumBytes < Math.max(baselineBytes, preCleanupBytes, postCleanupBytes) ||
    maximumBytes - baselineBytes !== maximumGrowthFromBaselineBytes ||
    preCleanupBytes - baselineBytes !== preCleanupDeltaFromBaselineBytes ||
    postCleanupBytes - baselineBytes !== postCleanupDeltaFromBaselineBytes
  )
    throw new TypeError("sampled current RSS arithmetic is inconsistent");
  if (
    runtimeHighWater.finalBytes < maximumBytes ||
    kernelHighWater.finalBytes < maximumBytes ||
    runtimeHighWater.baselineBytes < baselineBytes ||
    kernelHighWater.baselineBytes < baselineBytes
  )
    throw new TypeError("high-water RSS does not dominate current RSS observations");
  if (
    kernelHighWater.source === "darwin-resource-usage-max-rss" &&
    (kernelHighWater.baselineBytes !== runtimeHighWater.baselineBytes ||
      kernelHighWater.finalBytes !== runtimeHighWater.finalBytes)
  )
    throw new TypeError("Darwin runtime and kernel high-water RSS diverged");
  const expectedPreCleanupIndex =
    baselineSampleIndex + Math.floor(producedCount / sampleInterval) + 1;
  if (
    baselineSampleIndex !== 1 ||
    preCleanupSampleIndex !== expectedPreCleanupIndex ||
    postCleanupSampleIndex !== preCleanupSampleIndex + 1 ||
    sampleCount !== postCleanupSampleIndex
  )
    throw new TypeError("sample ordering is inconsistent");
  const attachments = lifecycleReceipt.attachmentStreams.acquiredCount;
  if (
    lifecycleReceipt.generator.acquiredCount !== 1 ||
    lifecycleReceipt.generator.yieldedCount !== producedCount ||
    lifecycleReceipt.generator.finallyCompletedCount !== 1 ||
    lifecycleReceipt.attachmentStreams.finallyCompletedCount !== attachments ||
    generatorCloseRequestedCount !== 1 ||
    generatorCloseAwaitedCount !== 1 ||
    generatorFinallyCompletedCount !== 1 ||
    attachmentCloseRequestedCount !== attachments ||
    attachmentCloseAwaitedCount !== attachments ||
    attachmentFinallyCompletedCount !== attachments
  )
    throw new TypeError("resource lifecycle equations are inconsistent");

  return {
    protocol: "fm1-308",
    identity: {
      reportedPid: positiveInteger(identity.reportedPid, "reportedPid"),
      token: nonemptyString(identity.token, "identity token"),
    },
    environment: {
      profile: "demo-corpus-250k",
      scenarioVersion: nonemptyString(environment.scenarioVersion, "scenarioVersion"),
      seed: nonemptyString(environment.seed, "seed"),
      requestedSize,
      memoryMethod: "kernel-high-water-with-sampled-current-rss-boundaries",
      currentRssSampleIntervalMessages: sampleInterval,
      runtime: nonemptyString(environment.runtime, "runtime"),
    },
    result: {
      producedCount,
      logicalDigest: digest(resultRecord.logicalDigest, "logicalDigest"),
      contentDigest: digest(resultRecord.contentDigest, "contentDigest"),
      maximumStreamChunkBytes,
      completed: observedCompleted,
    },
    memory: {
      rssUnit: "bytes",
      currentRssSource: "bun-process-memory-usage-rss",
      sampledCurrentRss: {
        baselineBytes,
        maximumBytes,
        preCleanupBytes,
        postCleanupBytes,
        maximumGrowthFromBaselineBytes,
        preCleanupDeltaFromBaselineBytes,
        postCleanupDeltaFromBaselineBytes,
        baselineSampleIndex,
        preCleanupSampleIndex,
        postCleanupSampleIndex,
        sampleCount,
      },
      runtimeHighWater: { ...runtimeHighWater, source: "bun-process-resource-usage-max-rss" },
      kernelHighWater: {
        ...kernelHighWater,
        source:
          kernelHighWater.source === "darwin-resource-usage-max-rss"
            ? "darwin-resource-usage-max-rss"
            : "linux-proc-vmhwm",
      },
    },
    resources: {
      lifecycleReceipt,
      consumer: {
        generator: {
          closeRequestedCount: generatorCloseRequestedCount,
          closeAwaitedCount: generatorCloseAwaitedCount,
          finallyCompletedCount: generatorFinallyCompletedCount,
          maximumInFlightNextCalls: positiveInteger(
            consumerGenerator.maximumInFlightNextCalls,
            "generator maximumInFlightNextCalls",
          ),
          maximumInFlightMessages: positiveInteger(
            consumerGenerator.maximumInFlightMessages,
            "generator maximumInFlightMessages",
          ),
        },
        attachmentStreams: {
          closeRequestedCount: attachmentCloseRequestedCount,
          closeAwaitedCount: attachmentCloseAwaitedCount,
          finallyCompletedCount: attachmentFinallyCompletedCount,
          maximumInFlightNextCalls: positiveInteger(
            consumerAttachments.maximumInFlightNextCalls,
            "attachment maximumInFlightNextCalls",
          ),
          maximumInFlightChunks: positiveInteger(
            consumerAttachments.maximumInFlightChunks,
            "attachment maximumInFlightChunks",
          ),
          maximumInFlightChunkBytes,
        },
      },
    },
    closure: {
      referencesDropped,
      fullGcAvailable,
      fullGcInvocations: positiveInteger(closure.fullGcInvocations, "fullGcInvocations"),
      fixedSettleMilliseconds: positiveInteger(
        closure.fixedSettleMilliseconds,
        "fixedSettleMilliseconds",
      ),
      fixedSettleCompleted,
    },
  };
}

function classifyPostExitIdentity(
  expected: Extract<DarwinProcessIdentity, { readonly kind: "present" }>,
  observed: DarwinProcessIdentity,
): PostExitIdentity {
  if (observed.pid !== expected.pid) throw new Error("post-exit process identity PID changed");
  if (observed.kind === "absent") return "absent";
  return observed.exactStartIdentity === expected.exactStartIdentity
    ? "same-identity-survivor"
    : "reused-pid";
}

function ownedSurvivorsFor(identity: PostExitIdentity): number {
  return identity === "same-identity-survivor" ? 1 : 0;
}

function assertOwnershipSafePostExit(identity: PostExitIdentity): number {
  const ownedSurvivors = ownedSurvivorsFor(identity);
  if (ownedSurvivors !== 0) throw new Error("profile child has a same-identity survivor");
  return ownedSurvivors;
}

async function runProfile(label: string): Promise<ProfileRun> {
  const identityToken = `fm1-308-${label}-${randomUUID()}`;
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "helpers/demo-corpus-large-profile-child.ts")],
    {
      env: { ...process.env, FM1_DEMO_PROFILE_ID: identityToken },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const pid = child.pid;
  const startIdentity = readDarwinProcessIdentity(pid);
  if (startIdentity.kind === "absent")
    throw new Error("profile child disappeared before exact identity binding");
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const outputLines = stdout.trim().split(/\r?\n/u);
  if (outputLines.length !== 1 || outputLines[0] === "")
    throw new Error(`profile child emitted unexpected stdout: ${stdout}`);
  const parsed: unknown = JSON.parse(outputLines[0]);
  const observation = parseProfileObservation(parsed);
  const postExit = readDarwinProcessIdentity(pid);
  const postExitIdentity = classifyPostExitIdentity(startIdentity, postExit);
  return {
    observation,
    process: {
      pid,
      exitCode,
      receiptIdentityMatches:
        observation.identity.reportedPid === pid && observation.identity.token === identityToken,
      startSource: startIdentity.source,
      startTimeUnit: startIdentity.startTimeUnit,
      exactStartIdentity: startIdentity.exactStartIdentity,
      postExitIdentity,
      ownedSurvivors: assertOwnershipSafePostExit(postExitIdentity),
      stdout,
      stderr,
    },
  };
}

function validProfileFixture(): RecordValue {
  return {
    protocol: "fm1-308",
    identity: { reportedPid: 42, token: "fixture-token" },
    environment: {
      profile: "demo-corpus-250k",
      scenarioVersion: CORPUS_VERSION,
      seed: "profile-250k",
      requestedSize: 250_000,
      memoryMethod: "kernel-high-water-with-sampled-current-rss-boundaries",
      currentRssSampleIntervalMessages: 256,
      runtime: "1.3.14",
    },
    result: {
      producedCount: 250_000,
      logicalDigest: "a".repeat(64),
      contentDigest: "b".repeat(64),
      maximumStreamChunkBytes: STREAM_CHUNK_BYTES,
      completed: true,
    },
    memory: {
      rssUnit: "bytes",
      currentRssSource: "bun-process-memory-usage-rss",
      sampledCurrentRss: {
        baselineBytes: 100,
        maximumBytes: 180,
        preCleanupBytes: 160,
        postCleanupBytes: 120,
        maximumGrowthFromBaselineBytes: 80,
        preCleanupDeltaFromBaselineBytes: 60,
        postCleanupDeltaFromBaselineBytes: 20,
        baselineSampleIndex: 1,
        preCleanupSampleIndex: 978,
        postCleanupSampleIndex: 979,
        sampleCount: 979,
      },
      runtimeHighWater: {
        source: "bun-process-resource-usage-max-rss",
        nativeUnit: "bytes",
        bytesPerNativeUnit: 1,
        baselineNative: 200,
        baselineBytes: 200,
        finalNative: 300,
        finalBytes: 300,
        growthBytes: 100,
      },
      kernelHighWater: {
        source: "darwin-resource-usage-max-rss",
        nativeUnit: "bytes",
        bytesPerNativeUnit: 1,
        baselineNative: 200,
        baselineBytes: 200,
        finalNative: 300,
        finalBytes: 300,
        growthBytes: 100,
      },
    },
    resources: {
      lifecycleReceipt: {
        protocol: "agent-mail-demo-corpus-run.v1",
        generator: { acquiredCount: 1, yieldedCount: 250_000, finallyCompletedCount: 1 },
        attachmentStreams: {
          acquiredCount: 3,
          yieldedCount: 132,
          finallyCompletedCount: 3,
          maximumYieldedChunkBytes: STREAM_CHUNK_BYTES,
        },
      },
      consumer: {
        generator: {
          closeRequestedCount: 1,
          closeAwaitedCount: 1,
          finallyCompletedCount: 1,
          maximumInFlightNextCalls: 1,
          maximumInFlightMessages: 1,
        },
        attachmentStreams: {
          closeRequestedCount: 3,
          closeAwaitedCount: 3,
          finallyCompletedCount: 3,
          maximumInFlightNextCalls: 1,
          maximumInFlightChunks: 1,
          maximumInFlightChunkBytes: STREAM_CHUNK_BYTES,
        },
      },
    },
    closure: {
      referencesDropped: true,
      fullGcAvailable: true,
      fullGcInvocations: 2,
      fixedSettleMilliseconds: 50,
      fixedSettleCompleted: true,
    },
  };
}

async function consumeObservedRun(run: ObservedCorpusRun): Promise<CorpusRunCompletionReceipt> {
  for await (const message of run.stream) {
    for (const part of message.parts) {
      if (part.kind !== "attachment") continue;
      for await (const _chunk of part.openStream()) {
        // Exhaustion, not the caller, owns the attachment-body finalizer.
      }
    }
  }
  return run.completion;
}

async function completionState(
  completion: Promise<CorpusRunCompletionReceipt>,
): Promise<"pending" | "resolved"> {
  return Promise.race([
    completion.then<"resolved">(() => "resolved"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
  ]);
}

describe("deterministic demo corpus", () => {
  test("is byte and logically repeatable across execution context", () => {
    const first = buildCorpus(options("reference"));
    const second = buildCorpus({
      ...options("reference"),
      root: "/other",
      locale: "tr-TR",
      timezone: "Pacific/Auckland",
      wallClock: "2099-12-31T23:59:59.999Z",
    });
    expect(first.logicalDigest).toBe(second.logicalDigest);
    expect(first.byteDigest).toBe(second.byteDigest);
    expect(first.checksum).toBe(second.checksum);
    expect(first.inventory).toEqual(second.inventory);
    expect(checksumCorpus(first)).toBe(first.checksum);
  });

  test("retains every required case and relationship inventory", () => {
    const corpus = buildCorpus(options("coverage"));
    assertRequiredCoverage(corpus);
    expect(corpus.inventory.requiredCases).toEqual(requiredCoverageCases);
    expect(corpus.inventory.entries.every((entry) => entry.messageIds.length > 0)).toBe(true);
    expect(corpus.mailboxes.length).toBe(3);
    expect(corpus.timeline.length).toBeGreaterThan(corpus.messages.length);
  });

  test("streams large attachment profiles without materializing the corpus", async () => {
    let count = 0;
    let maxChunk = 0;
    for await (const message of streamCorpus(options("large"))) {
      count += 1;
      for (const part of message.parts) {
        if (part.kind !== "attachment" || part.byteLength < 8 * 1024 * 1024) continue;
        let chunks = 0;
        for await (const chunk of part.openStream()) {
          chunks += 1;
          maxChunk = Math.max(maxChunk, chunk.byteLength);
          if (chunks > 2) break;
        }
      }
    }
    expect(count).toBe(DEFAULT_REFERENCE_SIZE);
    expect(maxChunk).toBeLessThanOrEqual(STREAM_CHUNK_BYTES);
    await assertCorpusAttachmentStreams(buildCorpus(options("large-verify")));
  });

  test("rejects a missing hostile or sparse case instead of silently passing", () => {
    expect(() => assertRequiredCoverage(buildCorpus(options("tiny", 1)))).toThrow(
      /missing required cases/,
    );
  });

  test("binds strict versioned options and rejects null, future, and unknown inputs", () => {
    const valid = options("strict", 96);
    expect(parseCorpusOptions(valid).scenarioVersion).toBe(CORPUS_VERSION);
    for (const input of [
      { ...valid, scenarioVersion: null },
      { ...valid, seed: null },
      { ...valid, size: null },
      { ...valid, scenarioMix: null },
      { ...valid, scenarioVersion: "agent-mail-demo-corpus.v2" },
      { ...valid, unexpected: true },
    ])
      expect(() => parseCorpusOptions(input)).toThrow(CorpusOptionsError);
    expect(() => parseCorpusOptions({ ...valid, size: undefined })).toThrow(/size must be/);
    expect(() => parseCorpusOptions({ ...valid, scenarioMix: ["ordinary", "ordinary"] })).toThrow(
      /duplicate category/,
    );
    expect(() => parseCorpusOptions({ ...valid, scenarioMix: { ordinary: 0 } })).toThrow(
      /positive integer/,
    );
    expect(parseCorpusOptions({ ...valid, scenarioMix: { ordinary: 2 } }).scenarioMix).toEqual({
      ordinary: 2,
    });
  });

  test("makes partial and weighted mixes authoritative across coverage, relationships, and state", async () => {
    const mixes = [
      { ordinary: 1 },
      { newsletter: 1 },
      { ordinary: 1, spam: 3 },
      scenarioMix,
    ] as const;
    for (const [index, mix] of mixes.entries()) {
      const corpus = buildCorpus({
        ...options(`mix-${index}`),
        scenarioMix: mix,
      });
      const enabled = new Set(Object.keys(mix));
      expect(corpus.messages.every((message) => enabled.has(message.category))).toBe(true);
      const expectedCases = requiredCoverageCases.filter(
        (caseId) =>
          ![
            "ordinary",
            "transactional",
            "mailing-list",
            "newsletter",
            "automated",
            "spam",
          ].includes(caseId) || enabled.has(caseId),
      );
      expect(corpus.inventory.requiredCases).toEqual(expectedCases);
      expect(corpus.inventory.missingCases).toEqual([]);
      const byMessageId = new Map(corpus.messages.map((message) => [message.messageId, message]));
      for (const message of corpus.messages) {
        if (message.relationship.kind === "root") continue;
        if (message.relationship.kind === "missing-reference") {
          expect(byMessageId.has(message.relationship.inReplyTo)).toBe(false);
          continue;
        }
        const parent = byMessageId.get(message.relationship.inReplyTo);
        expect(parent).toBeDefined();
        expect(parent?.threadId).toBe(message.threadId);
        expect(message.relationship.references).toContain(message.relationship.inReplyTo);
        if (message.relationship.kind === "fork")
          expect(message.relationship.branch).toBeGreaterThanOrEqual(0);
      }
      for (const mailbox of corpus.mailboxes) {
        const extant = corpus.messages.filter(
          (message) => message.mailboxId === mailbox.id && !message.tombstone,
        );
        const maxUid = extant.reduce((maximum, message) => Math.max(maximum, message.uid), 0);
        const maxModSeq = extant.reduce(
          (maximum, message) => Math.max(maximum, message.modSeq ?? 0),
          0,
        );
        expect(mailbox.uidNext).toBe(
          mailbox.id === createCorpusMailboxId("archive") ? null : maxUid + 1,
        );
        expect(mailbox.highestModSeq).toBe(
          mailbox.id === createCorpusMailboxId("missing-state") ? null : maxModSeq,
        );
      }
      await expect(assertCorpusIntegrity(corpus)).resolves.toBeUndefined();
    }
  });

  test("resolves replies, records intentional exceptions, and binds mailbox state", async () => {
    const corpus = buildCorpus(options("relationships"));
    const generatedIds = new Set(corpus.messages.map((message) => message.messageId));
    const missing = corpus.messages.filter(
      (message) => message.relationship.kind === "missing-reference",
    );
    expect(missing.length).toBeGreaterThan(0);
    for (const message of corpus.messages) {
      if (message.relationship.kind === "root") continue;
      if (message.relationship.kind === "missing-reference") {
        expect(generatedIds.has(message.relationship.inReplyTo)).toBe(false);
        continue;
      }
      expect(generatedIds.has(message.relationship.inReplyTo)).toBe(true);
      expect(message.headers["in-reply-to"]).toBe(message.relationship.inReplyTo);
    }
    for (const mailbox of corpus.mailboxes) {
      const extant = corpus.messages.filter(
        (message) => message.mailboxId === mailbox.id && !message.tombstone,
      );
      expect(mailbox.exists).toBe(extant.length);
      if (mailbox.uidNext !== null)
        expect(mailbox.uidNext).toBeGreaterThan(
          Math.max(0, ...extant.map((message) => message.uid)),
        );
    }
    await expect(assertCorpusIntegrity(corpus)).resolves.toBeUndefined();
  });

  test("rejects off-by-one mailbox and invalid relationship authorities", async () => {
    const corpus = buildCorpus(options("authority-attacks"));
    const withMailboxes = (
      edit: (
        mailbox: (typeof corpus.mailboxes)[number],
      ) =>
        | Partial<Pick<(typeof corpus.mailboxes)[number], "uidNext" | "highestModSeq">>
        | undefined,
    ) => {
      const mailboxes = corpus.mailboxes.map((mailbox) => {
        const value = edit(mailbox);
        return value === undefined ? mailbox : { ...mailbox, ...value };
      });
      const altered = { ...corpus, mailboxes };
      return { ...altered, checksum: checksumCorpus(altered) };
    };
    const inbox = createCorpusMailboxId("inbox");
    const highestAttack = withMailboxes((mailbox) =>
      mailbox.id === inbox ? { highestModSeq: (mailbox.highestModSeq ?? 0) + 1 } : undefined,
    );
    await expect(assertCorpusIntegrity(highestAttack)).rejects.toThrow(/HIGHESTMODSEQ/);
    const highestBelowAttack = withMailboxes((mailbox) =>
      mailbox.id === inbox
        ? { highestModSeq: Math.max(0, (mailbox.highestModSeq ?? 0) - 1) }
        : undefined,
    );
    await expect(assertCorpusIntegrity(highestBelowAttack)).rejects.toThrow(/HIGHESTMODSEQ/);
    const missingStateValueAttack = withMailboxes((mailbox) =>
      mailbox.id === createCorpusMailboxId("missing-state") ? { highestModSeq: 0 } : undefined,
    );
    await expect(assertCorpusIntegrity(missingStateValueAttack)).rejects.toThrow(/HIGHESTMODSEQ/);
    const uidNextAttack = withMailboxes((mailbox) =>
      mailbox.id === inbox ? { uidNext: (mailbox.uidNext ?? 0) + 1 } : undefined,
    );
    await expect(assertCorpusIntegrity(uidNextAttack)).rejects.toThrow(/UIDNEXT/);
    const uidNextBelowAttack = withMailboxes((mailbox) =>
      mailbox.id === inbox ? { uidNext: Math.max(1, (mailbox.uidNext ?? 1) - 1) } : undefined,
    );
    await expect(assertCorpusIntegrity(uidNextBelowAttack)).rejects.toThrow(/UIDNEXT/);
    const parentIndex = corpus.messages.findIndex(
      (message) => message.relationship.kind === "reply",
    );
    const parent = corpus.messages[parentIndex];
    if (parent.relationship.kind !== "reply") throw new Error("reply fixture is unavailable");
    const wrongThread = {
      ...corpus,
      messages: corpus.messages.map((message, index) =>
        index === parentIndex
          ? { ...message, threadId: createCorpusThreadId("wrong-thread") }
          : message,
      ),
    };
    await expect(
      assertCorpusIntegrity({ ...wrongThread, checksum: checksumCorpus(wrongThread) }),
    ).rejects.toThrow(/another thread/);
    const missingParent = {
      ...corpus,
      messages: corpus.messages.map((message, index) =>
        index === parentIndex && message.relationship.kind === "reply"
          ? {
              ...message,
              relationship: {
                ...message.relationship,
                inReplyTo: "<fabricated-parent@example.test>",
                references: ["<fabricated-parent@example.test>"],
              },
            }
          : message,
      ),
    };
    await expect(
      assertCorpusIntegrity({ ...missingParent, checksum: checksumCorpus(missingParent) }),
    ).rejects.toThrow(/not generated/);
    const forkIndex = corpus.messages.findIndex((message) => message.relationship.kind === "fork");
    const fork = corpus.messages[forkIndex];
    if (fork.relationship.kind !== "fork") throw new Error("fork fixture is unavailable");
    const negativeBranch = {
      ...corpus,
      messages: corpus.messages.map((message, index) =>
        index === forkIndex
          ? { ...message, relationship: { ...fork.relationship, branch: -1 } }
          : message,
      ),
    };
    await expect(
      assertCorpusIntegrity({ ...negativeBranch, checksum: checksumCorpus(negativeBranch) }),
    ).rejects.toThrow(/branch/);
  });

  test("derives coverage and rejects independent authority mutations", async () => {
    const corpus = buildCorpus(options("integrity"));
    expect(deriveCorpusInventory(corpus)).toEqual(corpus.inventory);
    const raw = new Uint8Array(corpus.messages[0].rawBytes);
    raw[0] ^= 0xff;
    const rawTampered = {
      ...corpus,
      messages: corpus.messages.map((message, index) =>
        index === 0 ? { ...message, rawBytes: raw } : message,
      ),
    };
    await expect(assertCorpusIntegrity(rawTampered)).rejects.toThrow(/digest/);
    const timeline = [...corpus.timeline];
    timeline[0] = { ...timeline[0], at: "2099-01-01T00:00:00.000Z" };
    await expect(assertCorpusIntegrity({ ...corpus, timeline })).rejects.toThrow(/timeline/);
    const emptyInventory = {
      requiredCases: corpus.inventory.requiredCases,
      entries: corpus.inventory.entries.map((entry) => ({
        ...entry,
        messageIds: [],
        mailboxIds: [],
      })),
      presentCases: [],
      missingCases: corpus.inventory.requiredCases,
    };
    await expect(
      assertCorpusIntegrity({
        ...rawTampered,
        inventory: emptyInventory,
        checksum: checksumCorpus(rawTampered),
      }),
    ).rejects.toThrow(/inventory/);
  });

  test("returns copy-safe byte buffers and immutable containers", () => {
    const corpus = buildCorpus(options("immutable"));
    const firstBytes = corpus.messages[0].rawBytes;
    const original = firstBytes[0];
    firstBytes[0] ^= 0xff;
    expect(corpus.messages[0].rawBytes[0]).toBe(original);
    expect(Object.isFrozen(corpus.messages)).toBe(true);
    expect(Object.isFrozen(corpus.mailboxes)).toBe(true);
    expect(Object.isFrozen(corpus.timeline)).toBe(true);
    expect(Object.isFrozen(corpus.inventory)).toBe(true);
    expect(Object.isFrozen(corpus.messages[0].headers)).toBe(true);
    expect(Object.isFrozen(corpus.messages[0].coverage)).toBe(true);
    expect(Object.isFrozen(corpus.messages[1].relationship)).toBe(true);
    expect(Object.isFrozen(corpus.messages[0].parts)).toBe(true);
    const attachment = corpus.messages[20].parts.find((part) => part.kind === "attachment");
    expect(attachment).toBeDefined();
    if (attachment?.kind === "attachment") {
      expect(Object.isFrozen(attachment)).toBe(true);
      expect(Reflect.set(attachment, "filename", "changed.txt")).toBe(false);
      expect(attachment.filename).not.toBe("changed.txt");
    }
  });

  test("binds attachment stream bytes to their declared digest", async () => {
    const corpus = buildCorpus(options("attachment-integrity"));
    const messageIndex = corpus.messages.findIndex((message) =>
      message.parts.some((part) => part.kind === "attachment" && part.byteLength === 41),
    );
    const message = corpus.messages[messageIndex];
    const parts = message.parts.map((part) =>
      part.kind !== "attachment" || part.byteLength !== 41
        ? part
        : {
            ...part,
            openStream: async function* (): AsyncIterable<Uint8Array> {
              yield new Uint8Array(part.byteLength);
            },
          },
    );
    const tampered = {
      ...corpus,
      messages: corpus.messages.map((candidate, index) =>
        index === messageIndex ? { ...candidate, parts } : candidate,
      ),
    };
    await expect(assertCorpusIntegrity(corpus)).resolves.toBeUndefined();
    await expect(assertCorpusIntegrity(tampered)).rejects.toThrow(/content digest/);
  });

  test("owns lifecycle authority per run and rejects global injection and cross-talk", async () => {
    let injectedCallbacks = 0;
    const oldGlobalProbe = Symbol.for("agent-mail.demo.corpus.lifecycle-probe");
    const injected = {
      generator: {
        acquired: () => (injectedCallbacks += 1),
        yielded: () => (injectedCallbacks += 1),
        finallyCompleted: () => (injectedCallbacks += 1),
      },
      attachment: {
        acquired: () => (injectedCallbacks += 1),
        yielded: () => (injectedCallbacks += 1),
        finallyCompleted: () => (injectedCallbacks += 1),
      },
    };
    const first = createObservedCorpusRun({
      ...options("concurrent-a", 10),
      [oldGlobalProbe]: injected,
    });
    const second = createObservedCorpusRun({
      ...options("concurrent-b", 24),
      [oldGlobalProbe]: injected,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.completion)).toBe(true);
    expect(Reflect.set(first, "completion", second.completion)).toBe(false);
    const [firstReceipt, secondReceipt] = await Promise.all([
      consumeObservedRun(first),
      consumeObservedRun(second),
    ]);
    expect(injectedCallbacks).toBe(0);
    expect(firstReceipt.generator.yieldedCount).toBe(10);
    expect(secondReceipt.generator.yieldedCount).toBe(24);
    expect(firstReceipt.attachmentStreams.acquiredCount).not.toBe(
      secondReceipt.attachmentStreams.acquiredCount,
    );
    expect(Object.isFrozen(firstReceipt)).toBe(true);
    expect(Object.isFrozen(firstReceipt.generator)).toBe(true);
    expect(Object.isFrozen(firstReceipt.attachmentStreams)).toBe(true);
  });

  test("withholds completion until actual generator and attachment finalizers run", async () => {
    const generatorRun = createObservedCorpusRun(options("omitted-generator-finalizer", 2));
    const generatorIterator = generatorRun.stream[Symbol.asyncIterator]();
    await generatorIterator.next();
    expect(await completionState(generatorRun.completion)).toBe("pending");
    await generatorIterator.return?.();
    expect((await generatorRun.completion).generator.finallyCompletedCount).toBe(1);

    const attachmentRun = createObservedCorpusRun(options("omitted-attachment-finalizer", 24));
    const corpusIterator = attachmentRun.stream[Symbol.asyncIterator]();
    let attachmentIterator: AsyncIterator<Uint8Array> | undefined;
    while (true) {
      const step = await corpusIterator.next();
      if (step.done) break;
      const attachment = step.value.parts.find((part) => part.kind === "attachment");
      if (attachment?.kind === "attachment" && attachmentIterator === undefined) {
        attachmentIterator = attachment.openStream()[Symbol.asyncIterator]();
        await attachmentIterator.next();
      }
    }
    expect(attachmentIterator).toBeDefined();
    expect(await completionState(attachmentRun.completion)).toBe("pending");
    await attachmentIterator?.return?.();
    const receipt = await attachmentRun.completion;
    expect(receipt.attachmentStreams.acquiredCount).toBe(1);
    expect(receipt.attachmentStreams.finallyCompletedCount).toBe(1);
  });

  test("rejects every receipt-domain and authority attack", () => {
    expect(parseProfileObservation(validProfileFixture()).result.completed).toBe(true);
    const missing = { ...validProfileFixture() };
    delete missing.identity;
    expect(() => parseProfileObservation(missing)).toThrow(/fields/);
    const zero = validProfileFixture();
    const zeroResult = recordValue(zero.result, "zero fixture result");
    expect(() =>
      parseProfileObservation({ ...zero, result: { ...zeroResult, producedCount: 0 } }),
    ).toThrow(/positive/);
    const negative = validProfileFixture();
    const negativeResources = recordValue(negative.resources, "negative fixture resources");
    const negativeConsumer = recordValue(negativeResources.consumer, "negative fixture consumer");
    const negativeAttachments = recordValue(
      negativeConsumer.attachmentStreams,
      "negative fixture attachments",
    );
    expect(() =>
      parseProfileObservation({
        ...negative,
        resources: {
          ...negativeResources,
          consumer: {
            ...negativeConsumer,
            attachmentStreams: {
              ...negativeAttachments,
              closeAwaitedCount: -1,
            },
          },
        },
      }),
    ).toThrow(/non-negative|positive/);
    const unavailable = validProfileFixture();
    const unavailableMemory = recordValue(unavailable.memory, "unavailable fixture memory");
    expect(() =>
      parseProfileObservation({
        ...unavailable,
        memory: { ...unavailableMemory, rssUnit: "unavailable" },
      }),
    ).toThrow(/unavailable/);
    const hardcoded = validProfileFixture();
    const hardcodedResult = recordValue(hardcoded.result, "hardcoded fixture result");
    expect(() =>
      parseProfileObservation({
        ...hardcoded,
        result: { ...hardcodedResult, producedCount: 249_999, completed: true },
      }),
    ).toThrow(/completion count|lifecycle/);
    const inconsistent = validProfileFixture();
    const inconsistentMemory = recordValue(inconsistent.memory, "inconsistent fixture memory");
    const sampled = recordValue(
      inconsistentMemory.sampledCurrentRss,
      "inconsistent sampled current RSS",
    );
    expect(() =>
      parseProfileObservation({
        ...inconsistent,
        memory: {
          ...inconsistentMemory,
          sampledCurrentRss: { ...sampled, postCleanupDeltaFromBaselineBytes: 21 },
        },
      }),
    ).toThrow(/arithmetic/);
    const sparseAsKernel = validProfileFixture();
    const sparseMemory = recordValue(sparseAsKernel.memory, "sparse fixture memory");
    const sparseKernel = recordValue(
      sparseMemory.kernelHighWater,
      "sparse fixture kernel high-water",
    );
    expect(() =>
      parseProfileObservation({
        ...sparseAsKernel,
        memory: {
          ...sparseMemory,
          kernelHighWater: {
            ...sparseKernel,
            source: "sampled-current-rss",
          },
        },
      }),
    ).toThrow(/source/);
    const omittedFinalizer = validProfileFixture();
    const omittedResources = recordValue(omittedFinalizer.resources, "omitted-finalizer resources");
    const omittedReceipt = recordValue(
      omittedResources.lifecycleReceipt,
      "omitted-finalizer receipt",
    );
    const omittedGenerator = recordValue(omittedReceipt.generator, "omitted-finalizer generator");
    expect(() =>
      parseProfileObservation({
        ...omittedFinalizer,
        resources: {
          ...omittedResources,
          lifecycleReceipt: {
            ...omittedReceipt,
            generator: {
              ...omittedGenerator,
              finallyCompletedCount: 0,
            },
          },
        },
      }),
    ).toThrow(/positive|lifecycle/);
  });

  test("binds exact sub-second process identity and distinguishes exit outcomes", () => {
    const current = readDarwinProcessIdentity(process.pid);
    expect(current.kind).toBe("present");
    if (current.kind === "absent") throw new Error("test process disappeared");
    expect(current.startTimeUnit).toBe("microseconds-since-unix-epoch");
    expect(current.exactStartIdentity).toMatch(/^[1-9][0-9]*:[0-9]{6}$/u);
    expect(() =>
      parseDarwinProcessIdentity({
        kind: "absent",
        source: "unavailable",
        pid: process.pid,
      }),
    ).toThrow(/source is unavailable/);
    expect(() =>
      parseDarwinProcessIdentity({
        kind: "present",
        source: "darwin-proc-pid-tbsdinfo",
        pid: process.pid,
        startTimeUnit: "seconds-since-unix-epoch",
        startTimeSeconds: current.startTimeSeconds,
      }),
    ).toThrow(/fields|unit/);
    const sameSecondReuse = parseDarwinProcessIdentity({
      kind: "present",
      source: "darwin-proc-pid-tbsdinfo",
      pid: process.pid,
      startTimeUnit: "microseconds-since-unix-epoch",
      startTimeSeconds: current.startTimeSeconds,
      startTimeMicroseconds: (current.startTimeMicroseconds + 1) % 1_000_000,
    });
    expect(classifyPostExitIdentity(current, sameSecondReuse)).toBe("reused-pid");
    expect(assertOwnershipSafePostExit("reused-pid")).toBe(0);
    expect(classifyPostExitIdentity(current, current)).toBe("same-identity-survivor");
    expect(ownedSurvivorsFor("same-identity-survivor")).toBe(1);
    expect(() => assertOwnershipSafePostExit("same-identity-survivor")).toThrow(/survivor/);
    const absent = parseDarwinProcessIdentity({
      kind: "absent",
      source: "darwin-proc-pid-tbsdinfo",
      pid: process.pid,
    });
    expect(classifyPostExitIdentity(current, absent)).toBe("absent");
  });

  test(
    "runs two named 250k profiles with kernel and run-owned authority",
    { timeout: 120_000 },
    async () => {
      const first = await runProfile("first");
      const second = await runProfile("second");
      for (const run of [first, second]) {
        expect(run.process.exitCode).toBe(0);
        expect(run.process.stderr).toBe("");
        expect(run.process.receiptIdentityMatches).toBe(true);
        expect(run.process.startSource).toBe("darwin-proc-pid-tbsdinfo");
        expect(run.process.startTimeUnit).toBe("microseconds-since-unix-epoch");
        expect(run.process.exactStartIdentity).toMatch(/^[1-9][0-9]*:[0-9]{6}$/u);
        expect(run.process.postExitIdentity).toBe("absent");
        expect(run.process.ownedSurvivors).toBe(0);
        expect(run.observation.environment.scenarioVersion).toBe(CORPUS_VERSION);
        expect(run.observation.result.producedCount).toBe(250_000);
        expect(run.observation.result.maximumStreamChunkBytes).toBe(STREAM_CHUNK_BYTES);
        expect(run.observation.memory.rssUnit).toBe("bytes");
        expect(run.observation.memory.kernelHighWater.source).toBe("darwin-resource-usage-max-rss");
        expect(run.observation.memory.kernelHighWater.nativeUnit).toBe("bytes");
        expect(run.observation.memory.kernelHighWater.bytesPerNativeUnit).toBe(1);
        expect(run.observation.memory.kernelHighWater.finalBytes).toBeGreaterThanOrEqual(
          run.observation.memory.sampledCurrentRss.maximumBytes,
        );
        expect(run.observation.resources.lifecycleReceipt.generator.yieldedCount).toBe(250_000);
        expect(
          run.observation.resources.lifecycleReceipt.attachmentStreams.finallyCompletedCount,
        ).toBe(run.observation.resources.lifecycleReceipt.attachmentStreams.acquiredCount);
        expect(run.observation.closure.referencesDropped).toBe(true);
      }
      expect(first.observation.result.logicalDigest).toBe(second.observation.result.logicalDigest);
      expect(first.observation.result.contentDigest).toBe(second.observation.result.contentDigest);
      expect(first.observation.result.maximumStreamChunkBytes).toBe(
        second.observation.result.maximumStreamChunkBytes,
      );
    },
  );
});
