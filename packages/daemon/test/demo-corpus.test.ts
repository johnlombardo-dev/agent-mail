import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CORPUS_VERSION,
  DEFAULT_REFERENCE_SIZE,
  assertRequiredCoverage,
  assertCorpusIntegrity,
  assertCorpusAttachmentStreams,
  buildCorpus,
  checksumCorpus,
  CorpusOptionsError,
  deriveCorpusInventory,
  parseCorpusOptions,
  requiredCoverageCases,
  streamCorpus,
} from "../src/demo/corpus/index.ts";

const scenarioMix = {
  ordinary: 1,
  transactional: 1,
  "mailing-list": 1,
  newsletter: 1,
  automated: 1,
  spam: 1,
} as const;

function options(seed: string, size = DEFAULT_REFERENCE_SIZE) {
  return { scenarioVersion: CORPUS_VERSION, seed, size, scenarioMix };
}

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
    readonly generator: Readonly<{
      readonly acquired: boolean;
      readonly closeRequested: boolean;
      readonly closeAwaited: boolean;
      readonly finallyCompleted: boolean;
      readonly consumerFinallyCompleted: boolean;
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

type ProfileRun = Readonly<{
  readonly observation: ProfileObservation;
  readonly process: Readonly<{
    readonly pid: number;
    readonly exitCode: number;
    readonly identityMatches: boolean;
    readonly startIdentity: string;
    readonly postExitIdentity: "absent" | "same-start-survivor" | "reused-pid";
    readonly ownedSurvivors: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}>;

type ProcessIdentity =
  | Readonly<{ readonly kind: "present"; readonly startIdentity: string }>
  | Readonly<{ readonly kind: "absent" }>;

type RecordValue = Readonly<Record<string, unknown>>;

function recordValue(value: unknown, name: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${name} must be a string`);
  return value;
}

function integerValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new TypeError(`${name} must be a safe integer`);
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function positiveIntegerValue(value: unknown, name: string): number {
  const result = integerValue(value, name);
  if (result < 1) throw new TypeError(`${name} must be positive`);
  return result;
}

function digestValue(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return result;
}

function rssUnitValue(value: unknown): "bytes" {
  if (value !== "bytes") throw new TypeError("rssUnit must be bytes");
  return "bytes";
}

function kernelSourceValue(value: unknown): "darwin-resource-usage-max-rss" | "linux-proc-vmhwm" {
  if (value === "darwin-resource-usage-max-rss" || value === "linux-proc-vmhwm") return value;
  throw new TypeError("kernel RSS source is invalid");
}

function lifecycleValue(value: unknown, name: string): ProfileObservation["resources"]["iterator"] {
  const record = recordValue(value, name);
  return {
    acquired: booleanValue(record.acquired, `${name}.acquired`),
    closeRequested: booleanValue(record.closeRequested, `${name}.closeRequested`),
    closeAwaited: booleanValue(record.closeAwaited, `${name}.closeAwaited`),
    finallyCompleted: booleanValue(record.finallyCompleted, `${name}.finallyCompleted`),
    consumerFinallyCompleted: booleanValue(
      record.consumerFinallyCompleted,
      `${name}.consumerFinallyCompleted`,
    ),
  };
}

function parseProfileObservation(value: unknown): ProfileObservation {
  const root = recordValue(value, "profile observation");
  const environment = recordValue(root.environment, "profile environment");
  const result = recordValue(root.result, "profile result");
  const memory = recordValue(root.memory, "profile memory");
  const resources = recordValue(root.resources, "profile resources");
  const generator = recordValue(resources.generator, "corpus generator");
  const attachmentStreams = recordValue(resources.attachmentStreams, "attachment streams");
  const closure = recordValue(root.closure, "profile closure");
  if (root.protocol !== "fm1-306") throw new TypeError("unsupported profile protocol");
  if (environment.profile !== "demo-corpus-250k") throw new TypeError("wrong profile name");
  if (environment.sampleMethod !== "rss-baseline-periodic-precleanup-postcleanup")
    throw new TypeError("unsupported profile sample method");
  return {
    protocol: "fm1-306",
    reportedPid: positiveIntegerValue(root.reportedPid, "reportedPid"),
    identityToken: stringValue(root.identityToken, "identityToken"),
    environment: {
      profile: "demo-corpus-250k",
      scenarioVersion: stringValue(environment.scenarioVersion, "scenarioVersion"),
      seed: stringValue(environment.seed, "seed"),
      requestedSize: positiveIntegerValue(environment.requestedSize, "requestedSize"),
      sampleMethod: "rss-baseline-periodic-precleanup-postcleanup",
      sampleInterval: positiveIntegerValue(environment.sampleInterval, "sampleInterval"),
      runtime: stringValue(environment.runtime, "runtime"),
    },
    result: {
      producedCount: integerValue(result.producedCount, "producedCount"),
      logicalDigest: digestValue(result.logicalDigest, "logicalDigest"),
      contentDigest: digestValue(result.contentDigest, "contentDigest"),
      maximumStreamChunk: positiveIntegerValue(result.maximumStreamChunk, "maximumStreamChunk"),
      completed: booleanValue(result.completed, "completed"),
    },
    memory: {
      rssUnit: rssUnitValue(memory.rssUnit),
      kernelHighWaterSource: kernelSourceValue(memory.kernelHighWaterSource),
      baselineRssBytes: positiveIntegerValue(memory.baselineRssBytes, "baselineRssBytes"),
      peakRssBytes: positiveIntegerValue(memory.peakRssBytes, "peakRssBytes"),
      preCleanupRssBytes: positiveIntegerValue(memory.preCleanupRssBytes, "preCleanupRssBytes"),
      postCleanupRssBytes: positiveIntegerValue(memory.postCleanupRssBytes, "postCleanupRssBytes"),
      baselineRuntimeHighWaterRssBytes: positiveIntegerValue(
        memory.baselineRuntimeHighWaterRssBytes,
        "baselineRuntimeHighWaterRssBytes",
      ),
      baselineKernelHighWaterRssBytes: positiveIntegerValue(
        memory.baselineKernelHighWaterRssBytes,
        "baselineKernelHighWaterRssBytes",
      ),
      runtimeHighWaterRssBytes: positiveIntegerValue(
        memory.runtimeHighWaterRssBytes,
        "runtimeHighWaterRssBytes",
      ),
      kernelHighWaterRssBytes: positiveIntegerValue(
        memory.kernelHighWaterRssBytes,
        "kernelHighWaterRssBytes",
      ),
      peakGrowthBytes: integerValue(memory.peakGrowthBytes, "peakGrowthBytes"),
      retainedGrowthBytes: integerValue(memory.retainedGrowthBytes, "retainedGrowthBytes"),
      baselineSampleIndex: positiveIntegerValue(memory.baselineSampleIndex, "baselineSampleIndex"),
      preCleanupSampleIndex: positiveIntegerValue(
        memory.preCleanupSampleIndex,
        "preCleanupSampleIndex",
      ),
      postCleanupSampleIndex: positiveIntegerValue(
        memory.postCleanupSampleIndex,
        "postCleanupSampleIndex",
      ),
      sampleCount: positiveIntegerValue(memory.sampleCount, "sampleCount"),
    },
    resources: {
      generator: {
        ...lifecycleValue(generator, "corpus generator"),
        yieldedCount: integerValue(generator.yieldedCount, "generator yieldedCount"),
        maximumInFlightNextCalls: positiveIntegerValue(
          generator.maximumInFlightNextCalls,
          "generator maximumInFlightNextCalls",
        ),
        maximumRetainedMessages: positiveIntegerValue(
          generator.maximumRetainedMessages,
          "generator maximumRetainedMessages",
        ),
      },
      attachmentStreams: {
        acquiredCount: integerValue(attachmentStreams.acquiredCount, "acquiredCount"),
        yieldedCount: integerValue(attachmentStreams.yieldedCount, "yieldedCount"),
        closeRequestedCount: integerValue(
          attachmentStreams.closeRequestedCount,
          "closeRequestedCount",
        ),
        closeAwaitedCount: integerValue(attachmentStreams.closeAwaitedCount, "closeAwaitedCount"),
        finallyCompletedCount: integerValue(
          attachmentStreams.finallyCompletedCount,
          "finallyCompletedCount",
        ),
        consumerFinallyCompletedCount: integerValue(
          attachmentStreams.consumerFinallyCompletedCount,
          "consumerFinallyCompletedCount",
        ),
        maximumInFlightNextCalls: positiveIntegerValue(
          attachmentStreams.maximumInFlightNextCalls,
          "maximumInFlightNextCalls",
        ),
        maximumRetainedChunks: positiveIntegerValue(
          attachmentStreams.maximumRetainedChunks,
          "maximumRetainedChunks",
        ),
        maximumRetainedBytes: positiveIntegerValue(
          attachmentStreams.maximumRetainedBytes,
          "maximumRetainedBytes",
        ),
        maximumBodyChunk: positiveIntegerValue(
          attachmentStreams.maximumBodyChunk,
          "maximumBodyChunk",
        ),
      },
    },
    closure: {
      referencesDropped: booleanValue(closure.referencesDropped, "referencesDropped"),
      fullGcAvailable: booleanValue(closure.fullGcAvailable, "fullGcAvailable"),
      fullGcInvocations: positiveIntegerValue(closure.fullGcInvocations, "fullGcInvocations"),
      fixedSettleMilliseconds: positiveIntegerValue(
        closure.fixedSettleMilliseconds,
        "fixedSettleMilliseconds",
      ),
      fixedSettleCompleted: booleanValue(closure.fixedSettleCompleted, "fixedSettleCompleted"),
    },
  };
}

async function readProcessIdentity(pid: number): Promise<ProcessIdentity> {
  const probe = Bun.spawn(["ps", "-p", String(pid), "-o", "lstart="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);
  if (stderr !== "") throw new Error("OS process identity is unavailable");
  if (exitCode !== 0) return { kind: "absent" };
  const lines = stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { kind: "absent" };
  if (lines.length !== 1) throw new Error("OS process identity returned an ambiguous result");
  return { kind: "present", startIdentity: lines[0] };
}

async function runProfile(label: string): Promise<ProfileRun> {
  const identityToken = `fm1-306-${label}-${randomUUID()}`;
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "helpers/demo-corpus-large-profile-child.ts")],
    {
      env: { ...process.env, FM1_DEMO_PROFILE_ID: identityToken },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const pid = child.pid;
  const startIdentity = await readProcessIdentity(pid);
  if (startIdentity.kind === "absent")
    throw new Error("profile child disappeared before identity binding");
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
  const identityMatches =
    observation.reportedPid === pid && observation.identityToken === identityToken;
  const postExitIdentity = await readProcessIdentity(pid);
  const postExitKind =
    postExitIdentity.kind === "absent"
      ? "absent"
      : postExitIdentity.startIdentity === startIdentity.startIdentity
        ? "same-start-survivor"
        : "reused-pid";
  return {
    observation,
    process: {
      pid,
      exitCode,
      identityMatches,
      startIdentity: startIdentity.startIdentity,
      postExitIdentity: postExitKind,
      ownedSurvivors: postExitKind === "absent" ? 0 : 1,
      stdout,
      stderr,
    },
  };
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
    const source = streamCorpus(options("large"));
    let count = 0;
    let maxChunk = 0;
    for await (const message of source) {
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
    expect(maxChunk).toBeLessThanOrEqual(64 * 1024);
    await assertCorpusAttachmentStreams(buildCorpus(options("large-verify")));
  });

  test("rejects a missing hostile or sparse case instead of silently passing", () => {
    const corpus = buildCorpus(options("tiny", 1));
    expect(() => assertRequiredCoverage(corpus)).toThrow(/missing required cases/);
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
    ]) {
      expect(() => parseCorpusOptions(input)).toThrow(CorpusOptionsError);
    }
    expect(() => parseCorpusOptions({ ...valid, size: undefined })).toThrow(/size must be/);
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
    const timelineTampered = { ...corpus, timeline };
    await expect(assertCorpusIntegrity(timelineTampered)).rejects.toThrow(/timeline/);

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
    const forged = {
      ...rawTampered,
      inventory: emptyInventory,
      checksum: checksumCorpus(rawTampered),
    };
    await expect(assertCorpusIntegrity(forged)).rejects.toThrow(/inventory/);
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
    expect(Object.isFrozen(corpus.messages[0].parts)).toBe(true);
    expect(Object.isFrozen(corpus.messages[20].parts[0])).toBe(true);
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
    const parts = message.parts.map((part) => {
      if (part.kind !== "attachment" || part.byteLength !== 41) return part;
      return {
        ...part,
        openStream: async function* (): AsyncIterable<Uint8Array> {
          yield new Uint8Array(part.byteLength);
        },
      };
    });
    const tampered = {
      ...corpus,
      messages: corpus.messages.map((candidate, index) =>
        index === messageIndex ? { ...candidate, parts } : candidate,
      ),
    };
    await expect(assertCorpusIntegrity(corpus)).resolves.toBeUndefined();
    await expect(assertCorpusIntegrity(tampered)).rejects.toThrow(/content digest/);
  });

  test(
    "runs two named 250k profiles with truthful resource observations",
    { timeout: 120_000 },
    async () => {
      const first = await runProfile("first");
      const second = await runProfile("second");
      for (const run of [first, second]) {
        expect(run.process.exitCode).toBe(0);
        expect(run.process.stderr).toBe("");
        expect(run.process.identityMatches).toBe(true);
        expect(run.process.startIdentity.length).toBeGreaterThan(0);
        expect(run.process.postExitIdentity).toBe("absent");
        expect(run.process.ownedSurvivors).toBe(0);
        expect(run.observation.environment.profile).toBe("demo-corpus-250k");
        expect(run.observation.environment.scenarioVersion).toBe(CORPUS_VERSION);
        expect(run.observation.environment.requestedSize).toBe(250_000);
        expect(run.observation.environment.sampleMethod).toBe(
          "rss-baseline-periodic-precleanup-postcleanup",
        );
        expect(run.observation.environment.sampleInterval).toBe(256);
        expect(run.observation.result.producedCount).toBe(250_000);
        expect(run.observation.result.completed).toBe(true);
        expect(run.observation.result.maximumStreamChunk).toBeGreaterThan(0);
        expect(run.observation.result.maximumStreamChunk).toBeLessThanOrEqual(64 * 1024);
        expect(run.observation.memory.rssUnit).toBe("bytes");
        expect(run.observation.memory.kernelHighWaterSource).toBe("darwin-resource-usage-max-rss");
        expect(run.observation.memory.baselineRssBytes).toBeGreaterThan(0);
        expect(run.observation.memory.peakRssBytes).toBeGreaterThanOrEqual(
          run.observation.memory.baselineRssBytes,
        );
        expect(run.observation.memory.peakRssBytes).toBeGreaterThanOrEqual(
          run.observation.memory.preCleanupRssBytes,
        );
        expect(run.observation.memory.peakRssBytes).toBeGreaterThanOrEqual(
          run.observation.memory.postCleanupRssBytes,
        );
        expect(run.observation.memory.baselineRuntimeHighWaterRssBytes).toBeGreaterThanOrEqual(
          run.observation.memory.baselineRssBytes,
        );
        expect(run.observation.memory.baselineKernelHighWaterRssBytes).toBeGreaterThanOrEqual(
          run.observation.memory.baselineRssBytes,
        );
        expect(run.observation.memory.runtimeHighWaterRssBytes).toBeGreaterThanOrEqual(
          run.observation.memory.postCleanupRssBytes,
        );
        expect(run.observation.memory.kernelHighWaterRssBytes).toBeGreaterThanOrEqual(
          run.observation.memory.postCleanupRssBytes,
        );
        expect(run.observation.memory.peakGrowthBytes).toBe(
          run.observation.memory.peakRssBytes - run.observation.memory.baselineRssBytes,
        );
        expect(run.observation.memory.retainedGrowthBytes).toBe(
          run.observation.memory.postCleanupRssBytes - run.observation.memory.baselineRssBytes,
        );
        expect(run.observation.memory.baselineSampleIndex).toBe(1);
        expect(run.observation.memory.preCleanupSampleIndex).toBeGreaterThan(
          run.observation.memory.baselineSampleIndex,
        );
        expect(run.observation.memory.preCleanupSampleIndex).toBe(978);
        expect(run.observation.memory.postCleanupSampleIndex).toBeGreaterThan(
          run.observation.memory.preCleanupSampleIndex,
        );
        expect(run.observation.memory.postCleanupSampleIndex).toBe(979);
        expect(run.observation.memory.sampleCount).toBe(979);
        expect(run.observation.resources.generator.acquired).toBe(true);
        expect(run.observation.resources.generator.closeRequested).toBe(true);
        expect(run.observation.resources.generator.closeAwaited).toBe(true);
        expect(run.observation.resources.generator.finallyCompleted).toBe(true);
        expect(run.observation.resources.generator.consumerFinallyCompleted).toBe(true);
        expect(run.observation.resources.generator.yieldedCount).toBe(250_000);
        expect(run.observation.resources.generator.maximumInFlightNextCalls).toBeGreaterThan(0);
        expect(run.observation.resources.generator.maximumRetainedMessages).toBeGreaterThan(0);
        expect(run.observation.resources.attachmentStreams.acquiredCount).toBeGreaterThan(0);
        expect(run.observation.resources.attachmentStreams.yieldedCount).toBeGreaterThan(0);
        expect(run.observation.resources.attachmentStreams.closeRequestedCount).toBe(
          run.observation.resources.attachmentStreams.acquiredCount,
        );
        expect(run.observation.resources.attachmentStreams.closeAwaitedCount).toBe(
          run.observation.resources.attachmentStreams.acquiredCount,
        );
        expect(run.observation.resources.attachmentStreams.finallyCompletedCount).toBe(
          run.observation.resources.attachmentStreams.acquiredCount,
        );
        expect(run.observation.resources.attachmentStreams.consumerFinallyCompletedCount).toBe(
          run.observation.resources.attachmentStreams.acquiredCount,
        );
        expect(
          run.observation.resources.attachmentStreams.maximumInFlightNextCalls,
        ).toBeGreaterThan(0);
        expect(run.observation.resources.attachmentStreams.maximumRetainedChunks).toBeGreaterThan(
          0,
        );
        expect(
          run.observation.resources.attachmentStreams.maximumRetainedBytes,
        ).toBeGreaterThanOrEqual(run.observation.result.maximumStreamChunk);
        expect(run.observation.resources.attachmentStreams.maximumBodyChunk).toBe(
          run.observation.result.maximumStreamChunk,
        );
        expect(run.observation.closure.referencesDropped).toBe(true);
        expect(run.observation.closure.fullGcAvailable).toBe(true);
        expect(run.observation.closure.fullGcInvocations).toBeGreaterThan(0);
        expect(run.observation.closure.fixedSettleMilliseconds).toBeGreaterThan(0);
        expect(run.observation.closure.fixedSettleCompleted).toBe(true);
      }
      expect(first.observation.result.producedCount).toBe(second.observation.result.producedCount);
      expect(first.observation.result.logicalDigest).toBe(second.observation.result.logicalDigest);
      expect(first.observation.result.contentDigest).toBe(second.observation.result.contentDigest);
      expect(first.observation.result.maximumStreamChunk).toBe(
        second.observation.result.maximumStreamChunk,
      );
    },
  );
});
