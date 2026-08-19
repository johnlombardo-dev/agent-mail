import { describe, expect, it } from "bun:test";
import { actionPlanInspectResponseSchema, createOperationRegistry, httpErrorRegistry } from "@agent-mail/contracts";
import { z } from "zod";
import acceptedOracle from "../../../docs/architecture/cli-command-outcome-oracle.v1.json" with {
  type: "json",
};
import {
  createCommandFailure,
  createCommandRaw,
  createCommandValue,
  createLocalError,
  classifyCliClientError,
  executeCommand,
  evaluateDomainOutcome,
  exitCodes,
  parseCommandResult,
  parseExecutionReceipt,
  parseLocalError,
  parseRegisteredError,
  parseFeatureSelection,
  projectDomainFacts,
  selectDomainOutcome,
  isFailureSemanticKind,
  isValueSemanticKind,
  semanticKinds,
  type CommandSink,
  type SinkWriteResultV1,
} from "./command-outcome";
import { trustedChrome, untrustedValue } from "./output-context";
import { CliClientError } from "./client";
import { publicCliOperations } from "./command-registry";

const oracle = acceptedOracle as unknown as {
  readonly exitCodeRegistry: readonly Readonly<{ readonly semanticKind: string; readonly code: number }>[];
  readonly localErrorRegistry: readonly Readonly<{
    readonly code: string;
    readonly message: string;
    readonly semanticKind: string;
    readonly validDetails: unknown;
  }>[];
  readonly domainFixtureBases: readonly Readonly<{
    readonly id: string;
    readonly operationKey: string;
    readonly facts: Readonly<Record<string, unknown>>;
  }>[];
  readonly domainFixtures: readonly Readonly<{
    readonly baseId: string;
    readonly factOverrides: Readonly<Record<string, unknown>>;
    readonly expectedRuleId: string | null;
    readonly expectedSemanticKind: string;
    readonly expectedLocalCode: string | null;
  }>[];
  readonly domainProjectionFixtures: readonly Readonly<{
    readonly operationKey: string;
    readonly input: unknown;
    readonly expectedFacts: Readonly<Record<string, unknown>>;
  }>[];
  readonly runtimeFailureMatrix: readonly Readonly<{ readonly id: string }>[];
  readonly sharedErrorMatrix: readonly Readonly<{ readonly code: string; readonly semanticKind: string }>[];
  readonly operationErrorMappings: readonly Readonly<{ readonly code: string; readonly selector: string; readonly semanticKind?: string; readonly cases?: Readonly<Record<string, string>> }>[];
  readonly operationErrorApplicability: readonly Readonly<{ readonly operationKey: string; readonly code: string }>[];
  readonly cliClientErrorMatrix: readonly Readonly<{ readonly kind: string; readonly localCode: string | null; readonly semanticKind: string }>[];
  readonly commandResultAlgebra: Readonly<{
    readonly variants: readonly Readonly<{ readonly kind: string; readonly allowedSemanticKinds: readonly string[] }>[];
  }>;
};

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

const errorDetailCandidates: readonly Readonly<Record<string, unknown>>[] = [
  {},
  { resource: "search" },
  { resource: "thread" },
  { resource: "thread", id: `thread:${"a".repeat(64)}` },
  { resource: "message", id: "message:example" },
  { resource: "raw-message", id: "message:example" },
  { resource: "attachment", id: "attachment:example" },
  { planId: "plan:example", approvalId: "approval:example" },
  { planId: "plan:example", approvalId: "approval:example", expiredAt: "2026-01-01T00:00:00.000Z" },
  { planId: "plan:example", approvalId: "approval:example", cancelledAt: "2026-01-01T00:00:00.000Z" },
  { planId: "plan:example", approvalId: "approval:example", invalidatedAt: "2026-01-01T00:00:00.000Z" },
  { planId: "plan:example", approvalId: "approval:example", receiptId: "approval-receipt:example", consumedAt: "2026-01-01T00:00:00.000Z" },
  { planId: "plan:example", currentVersion: 2 },
  { planId: "plan:example", state: "pending" },
  { planId: "plan:example", expiredAt: "2026-01-01T00:00:00.000Z" },
  { planId: "plan:example" },
  { commandId: "command:pause", command: "pause", actorState: "watching", version: 12, incarnationId: "incarnation:example", reason: "stale-version" },
  { commandId: "command:pause", command: "pause", actorState: "watching", version: 12, incarnationId: "incarnation:example", reason: "deadline-elapsed", deadlineMs: 1000 },
  { commandId: "command:pause", command: "pause", actorState: "watching", version: 12, incarnationId: "incarnation:example", reason: "key-reused-with-different-fingerprint", idempotencyKey: "idempotency:example" },
  { commandId: "command:pause", command: "pause", actorState: "watching", version: 12, incarnationId: "incarnation:example", reason: "all-retained-entries-in-flight", capacity: 1 },
  { commandId: "command:pause", command: "pause", actorState: "stopping", version: 12, incarnationId: "incarnation:example", reason: "superseded-by-stop" },
  { commandId: "command:pause", command: "pause", actorState: "stopped", version: 12, incarnationId: "incarnation:example", reason: "terminal-failure" },
];

function validDetails(definition: { readonly details: { safeParse: (input: unknown) => { success: boolean } } }, reason?: string): Readonly<Record<string, unknown>> {
  const candidates = reason === undefined ? errorDetailCandidates : errorDetailCandidates.map((candidate) => ({ ...candidate, reason }));
  const details = candidates.find((candidate) => definition.details.safeParse(candidate).success);
  if (details === undefined) throw new Error(`no valid details fixture for ${reason ?? "error"}`);
  return details;
}

function memorySink(options: Readonly<{ readonly fail?: "EPIPE" | "IO"; readonly accepted?: number }> = {}): CommandSink & { readonly bytes: Uint8Array[] } {
  const bytes: Uint8Array[] = [];
  return {
    bytes,
    async write(value): Promise<SinkWriteResultV1> {
      if (options.fail === "EPIPE") return { kind: "failed", errorCode: "EPIPE", bytesAccepted: "unknown" };
      if (options.fail === "IO") return { kind: "failed", errorCode: "EIO", bytesAccepted: 0 };
      bytes.push(value.slice());
      return { kind: "written", bytesAccepted: options.accepted ?? value.byteLength };
    },
  };
}

function contextFor(
  stdout: CommandSink,
  stderr: CommandSink,
  signal: AbortSignal = new AbortController().signal,
  extra: Readonly<{ readonly cleanup?: () => Promise<void>; readonly terminalSignal?: "SIGINT" | "SIGTERM" }> = {},
) {
  return {
    invocationCorrelationId: "cli:test",
    mode: "json" as const,
    stdout,
    stderr,
    rawPolicy: { destination: "pipe" as const, tty: "refuse" as const },
    signal,
    ...extra,
  };
}

function rawContext(
  stdout: CommandSink,
  stderr: CommandSink,
  signal: AbortSignal = new AbortController().signal,
  extra: Readonly<{ readonly cleanup?: () => Promise<void>; readonly terminalSignal?: "SIGINT" | "SIGTERM" }> = {},
) {
  return { ...contextFor(stdout, stderr, signal, extra), mode: "raw" as const };
}

function rawResult(body: AsyncIterable<Uint8Array>, cancel: () => Promise<void> = async () => {}) {
  return createCommandRaw({ operationKey: "messages.raw", stream: { operationKey: "messages.raw", body, cancel } });
}

function validValue() {
  return createCommandValue({ operationKey: "messages.search", data: { items: [], nextCursor: null }, semanticKind: "success", humanLines });
}

function sinkText(sink: CommandSink & { readonly bytes: Uint8Array[] }): string {
  const total = sink.bytes.reduce((sum, value) => sum + value.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const value of sink.bytes) {
    merged.set(value, offset);
    offset += value.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function sinkByteLength(sink: CommandSink & { readonly bytes: Uint8Array[] }): number {
  return sink.bytes.reduce((sum, value) => sum + value.byteLength, 0);
}

const humanLines = [[trustedChrome("ok: "), untrustedValue("safe")]] as const;

describe("command outcome authority", () => {
  it("keeps the exact semantic and receipt registry pairs", () => {
    expect(exitCodes.success).toBe(0);
    expect(exitCodes.partial_output).toBe(88);
    expect(exitCodes.cancelled).toBe(84);
  });

  it("keeps oracle value and failure membership independent", () => {
    const valueVariant = must(
      oracle.commandResultAlgebra.variants.find((variant) => variant.kind === "value"),
      "missing value algebra variant",
    );
    const rawVariant = must(
      oracle.commandResultAlgebra.variants.find((variant) => variant.kind === "raw"),
      "missing raw algebra variant",
    );
    const failureVariant = must(
      oracle.commandResultAlgebra.variants.find((variant) => variant.kind === "failure"),
      "missing failure algebra variant",
    );
    const valueKinds = new Set(valueVariant.allowedSemanticKinds);
    const rawKinds = new Set(rawVariant.allowedSemanticKinds);
    const failureKinds = new Set(failureVariant.allowedSemanticKinds);
    for (const kind of semanticKinds) {
      expect(isValueSemanticKind(kind)).toBe(valueKinds.has(kind));
      expect(isFailureSemanticKind(kind)).toBe(failureKinds.has(kind));
    }
    expect(rawKinds.has("success")).toBe(true);
    expect(valueKinds.has("stale")).toBe(true);
    expect(valueKinds.has("expired")).toBe(true);
    expect(valueKinds.has("cancelled")).toBe(true);
    expect(failureKinds.has("stale")).toBe(true);
    expect(failureKinds.has("expired")).toBe(true);
    expect(failureKinds.has("cancelled")).toBe(true);
    expect(failureKinds.has("replay")).toBe(true);
  });

  it("reconstructs every accepted domain fixture and evaluates the oracle rule", () => {
    const bases = new Map(oracle.domainFixtureBases.map((base) => [base.id, base]));
    expect(oracle.domainFixtures).toHaveLength(62);
    for (const fixture of oracle.domainFixtures) {
      const base = must(bases.get(fixture.baseId), `missing domain base ${fixture.baseId}`);
      const facts = { ...base.facts, ...fixture.factOverrides };
      const selected = evaluateDomainOutcome(base.operationKey, facts);
      expect(selected).toMatchObject({
        ruleId: fixture.expectedRuleId,
        semanticKind: fixture.expectedSemanticKind,
        localCode: fixture.expectedLocalCode,
      });
    }
  });

  it("reconstructs every accepted projection fixture without production fixture reads", () => {
    expect(oracle.domainProjectionFixtures).toHaveLength(16);
    for (const fixture of oracle.domainProjectionFixtures)
      expect(projectDomainFacts(fixture.operationKey, fixture.input)).toEqual(fixture.expectedFacts);
  });

  it("executes stale, expired, and cancelled domain values with their own stdout exits", async () => {
    const instant = "2026-08-19T00:00:00.000Z";
    const later = "2026-08-19T00:01:00.000Z";
    const digest = "a".repeat(64);
    const target = {
      accountId: "account:test",
      mailboxId: "mailbox:inbox",
      uidValidity: 1,
      uid: 42,
      precondition: { modseq: 9 },
    };
    const pendingPlan = {
      state: "pending" as const,
      planId: "plan:test",
      action: { kind: "markSeen" as const },
      targets: [target],
      createdAt: instant,
      expiresAt: "2026-08-19T00:10:00.000Z",
    };
    const common = {
      planVersion: 1,
      previewDigest: digest,
      targetDigest: digest,
      normalizedIntent: "mark the selected message seen",
      creator: { principalId: "principal:agent", profile: "agent-unattended" as const },
      terminalAudit: "absent" as const,
    };
    const expired = actionPlanInspectResponseSchema.parse({
      ...common,
      plan: { ...pendingPlan, state: "expired" as const, expiredAt: "2026-08-19T00:11:00.000Z" },
      approvalState: "absent",
      results: [],
    });
    const cancelled = actionPlanInspectResponseSchema.parse({
      ...common,
      plan: pendingPlan,
      approvalState: { state: "cancelled", approvalId: "approval:test", planId: "plan:test", cancelledAt: later },
      results: [],
    });
    const staleResult = {
      kind: "stale" as const,
      planId: "plan:test",
      action: pendingPlan.action,
      target,
      attemptId: "attempt:stale",
      idempotencyKey: "idempotency:stale",
      startedAt: instant,
      resultAt: later,
      certainty: "definite" as const,
      detail: "the frozen target changed",
    };
    const stale = actionPlanInspectResponseSchema.parse({
      ...common,
      plan: { ...pendingPlan, state: "completed" as const, completedAt: later },
      approvalState: {
        state: "consumed",
        approvalId: "approval:test",
        planId: "plan:test",
        planVersion: 1,
        previewDigest: digest,
        targetDigest: digest,
        normalizedIntent: common.normalizedIntent,
        issuedAt: instant,
        expiresAt: "2026-08-19T00:10:00.000Z",
        consumedAt: later,
        committer: { principalId: "principal:agent", profile: "agent-unattended" as const },
        receiptId: "approval-receipt:test",
      },
      results: [staleResult],
    });
    const rows = [
      { semanticKind: "stale" as const, data: stale },
      { semanticKind: "expired" as const, data: expired },
      { semanticKind: "cancelled" as const, data: cancelled },
    ];
    for (const row of rows) {
      const result = createCommandValue({ operationKey: "action-plans.inspect", data: row.data, semanticKind: row.semanticKind, humanLines });
      expect(result.kind).toBe("value");
      const stdout = memorySink();
      const stderr = memorySink();
      const receipt = await executeCommand(result, contextFor(stdout, stderr));
      expect(receipt).toMatchObject({ semanticKind: row.semanticKind, exitCode: exitCodes[row.semanticKind], stderrBytesAccepted: 0 });
      expect(sinkByteLength(stdout)).toBeGreaterThan(0);
      expect(sinkByteLength(stdout)).toBe(receipt.stdoutBytesAccepted);
    }
  });

  it("accepts all 24 exact receipt pairs and rejects cross-paired statuses", () => {
    const normal = oracle.exitCodeRegistry;
    expect(normal).toHaveLength(21);
    for (const row of normal) {
      const receipt = parseExecutionReceipt({
        version: 1,
        semanticKind: row.semanticKind,
        exitCode: row.code,
        stdoutBytesAccepted: 0,
        stderrBytesAccepted: 0,
        cleanupAwaited: false,
      });
      expect(receipt.exitCode).toBe(row.code);
    }
    expect(parseExecutionReceipt({ version: 1, semanticKind: "cancelled", exitCode: 130, stdoutBytesAccepted: 0, stderrBytesAccepted: 0, cleanupAwaited: true }).exitCode).toBe(130);
    expect(parseExecutionReceipt({ version: 1, semanticKind: "cancelled", exitCode: 143, stdoutBytesAccepted: 0, stderrBytesAccepted: 0, cleanupAwaited: true }).exitCode).toBe(143);
    expect(parseExecutionReceipt({ version: 1, semanticKind: "partial_output", exitCode: 141, stdoutBytesAccepted: 0, stderrBytesAccepted: 0, cleanupAwaited: true }).exitCode).toBe(141);
    expect(() => parseExecutionReceipt({ version: 1, semanticKind: "success", exitCode: 88, stdoutBytesAccepted: 0, stderrBytesAccepted: 0, cleanupAwaited: false })).toThrow();
    expect(() => parseExecutionReceipt({ version: 1, semanticKind: "cancelled", exitCode: 0, stdoutBytesAccepted: 0, stderrBytesAccepted: 0, cleanupAwaited: false })).toThrow();
    expect(() => parseExecutionReceipt({ version: 1, semanticKind: "partial_output", exitCode: 141, stdoutBytesAccepted: 0, stderrBytesAccepted: 0, cleanupAwaited: false, extra: true })).toThrow();
  });

  it("round-trips all 13 local error schemas and rejects malformed envelopes", () => {
    expect(oracle.localErrorRegistry).toHaveLength(13);
    for (const row of oracle.localErrorRegistry) {
      const error = createLocalError(row.code as Parameters<typeof createLocalError>[0], "cli:oracle", row.validDetails);
      expect(error).toEqual({ code: row.code, message: row.message, correlationId: "cli:oracle", details: row.validDetails });
      expect(parseLocalError(error)).toEqual(error);
      expect(() => parseLocalError({ ...error, message: `${row.message} hostile` })).toThrow();
      expect(() => parseLocalError({ ...error, extra: true })).toThrow();
      const details = { ...(row.validDetails as Record<string, unknown>), extra: true };
      expect(() => createLocalError(row.code as Parameters<typeof createLocalError>[0], "cli:oracle", details)).toThrow();
    }
  });

  it("constructively maps all shared and operation-registered error rows", async () => {
    expect(oracle.sharedErrorMatrix).toHaveLength(26);
    for (const row of oracle.sharedErrorMatrix) {
      const definition = must(httpErrorRegistry.get(row.code), `missing shared error ${row.code}`);
      const envelope = {
        code: row.code,
        message: definition.message ?? `safe ${row.code}`,
        correlationId: "cli:oracle",
        details: validDetails(definition),
      };
      const mapped = parseRegisteredError(envelope, "unknown.operation");
      expect(mapped.semanticKind).toBe(row.semanticKind);
      if (!isFailureSemanticKind(mapped.semanticKind)) throw new Error(`shared row is not a failure: ${row.code}`);
      const result = createCommandFailure({ operationKey: "messages.search", semanticKind: mapped.semanticKind, error: mapped.error });
      expect(parseCommandResult(result).semanticKind).toBe(mapped.semanticKind);
      const stdout = memorySink();
      const stderr = memorySink();
      const receipt = await executeCommand(result, contextFor(stdout, stderr));
      expect(receipt).toMatchObject({ semanticKind: mapped.semanticKind, exitCode: exitCodes[mapped.semanticKind], stdoutBytesAccepted: 0 });
      expect(receipt.stderrBytesAccepted).toBe(sinkByteLength(stderr));
      expect(() => parseRegisteredError({ ...envelope, details: { hostile: true } }, "unknown.operation")).toThrow();
    }

    expect(oracle.operationErrorApplicability).toHaveLength(29);
    for (const row of oracle.operationErrorApplicability) {
      const operation = must(publicCliOperations.find((candidate) => candidate.key === row.operationKey), `missing operation ${row.operationKey}`);
      const definition = must(operation.errors.find((candidate) => candidate.code === row.code), `missing operation error ${row.code}`);
      const mapping = must(oracle.operationErrorMappings.find((candidate) => candidate.code === row.code), `missing mapping ${row.code}`);
      const reason = mapping.cases === undefined ? undefined : Object.keys(mapping.cases)[0];
      const envelope = {
        code: row.code,
        message: definition.message ?? `safe ${row.code}`,
        correlationId: "cli:oracle",
        details: validDetails(definition, reason),
      };
      const expected = reason === undefined ? mapping.semanticKind : mapping.cases?.[reason];
      const mapped = parseRegisteredError(envelope, row.operationKey);
      expect(mapped.semanticKind).toBe(expected);
      if (!isFailureSemanticKind(mapped.semanticKind)) throw new Error(`operation row is not a failure: ${row.code}`);
      const result = createCommandFailure({ operationKey: row.operationKey, semanticKind: mapped.semanticKind, error: mapped.error });
      expect(parseCommandResult(result).semanticKind).toBe(mapped.semanticKind);
      const stdout = memorySink();
      const stderr = memorySink();
      const receipt = await executeCommand(result, contextFor(stdout, stderr));
      expect(receipt).toMatchObject({ semanticKind: mapped.semanticKind, exitCode: exitCodes[mapped.semanticKind], stdoutBytesAccepted: 0 });
      expect(receipt.stderrBytesAccepted).toBe(sinkByteLength(stderr));
      expect(() => parseRegisteredError({ ...envelope, status: row.status, details: { hostile: true } }, row.operationKey)).toThrow();
    }

    const precedence = {
      code: "invalid_query",
      message: "invalid search query",
      correlationId: "cli:oracle",
      details: { resource: "search" },
    };
    const registered = createCommandValue({ operationKey: "messages.search", data: precedence, semanticKind: "success", humanLines });
    expect(registered).toMatchObject({ kind: "failure", semanticKind: "invalid_input" });
    expect(() => parseRegisteredError(precedence, "messages.get")).toThrow();
  });

  it("classifies every CliClientError matrix row with its registered local mapping", () => {
    expect(oracle.cliClientErrorMatrix).toHaveLength(7);
    for (const row of oracle.cliClientErrorMatrix) {
      const serverError =
        row.kind === "http_error"
          ? { code: "invalid_request", message: "invalid request", correlationId: "cli:oracle", details: {} }
          : undefined;
      const classified = classifyCliClientError(
        new CliClientError(row.kind as ConstructorParameters<typeof CliClientError>[0], "messages.search", "hostile", { serverError }),
        "cli:oracle",
      );
      if (row.kind === "http_error") expect(classified.semanticKind).toBe("invalid_input");
      else {
        expect(classified.semanticKind).toBe(row.semanticKind);
        expect(classified.error.code).toBe(row.localCode);
      }
      expect(classified.error.message).not.toContain("hostile");
    }
  });

  it("evaluates action target coverage and precedence from projected facts", () => {
    const data = {
      plan: { state: "completed", targets: [{ accountId: "a", mailboxId: "m", uidValidity: 1, uid: 1 }] },
      results: [{ kind: "uncertain", target: { accountId: "a", mailboxId: "m", uidValidity: 1, uid: 1 } }],
      approvalState: { state: "consumed" },
      terminalAudit: { terminalState: "completed", executorDisposition: "started" },
    };
    expect(projectDomainFacts("action-plans.inspect", data).targetCoverage).toBe("exact");
    expect(selectDomainOutcome("action-plans.inspect", data).semanticKind).toBe("uncertain");
  });

  it("rejects caller numbers and malformed or unbranded result fields", () => {
    expect(() => parseFeatureSelection({ version: 1, operationKey: "messages.search", semanticKind: "success", exitCode: 0 }, "messages.search")).toThrow();
    expect(() => parseCommandResult({ version: 1, kind: "value", operationKey: "messages.search", semanticKind: "success", data: {}, humanLines: [[{ kind: "untrusted-value", text: "x" }]], diagnostics: [] })).toThrow();
  });

  it("writes one JSON frame and retains the domain exit", async () => {
    const stdout = memorySink(); const stderr = memorySink();
    const result = createCommandValue({ operationKey: "messages.search", data: { items: [], nextCursor: null }, semanticKind: "success", humanLines });
    const receipt = await executeCommand(result, { invocationCorrelationId: "cli:test", mode: "json", stdout, stderr, rawPolicy: { destination: "pipe", tty: "refuse" }, signal: new AbortController().signal });
    expect(new TextDecoder().decode(stdout.bytes[0])).toBe('{"items":[],"nextCursor":null}\n');
    expect(stderr.bytes).toHaveLength(0);
    expect(receipt).toMatchObject({ semanticKind: "success", exitCode: 0, stdoutBytesAccepted: 31, stderrBytesAccepted: 0, cleanupAwaited: false });
  });

  it("keeps raw bytes exact and classifies EPIPE without retry", async () => {
    let cancelled = 0;
    const stream = { operationKey: "messages.raw", body: (async function* () { yield Uint8Array.from([0, 27, 255]); })(), cancel: async () => { cancelled += 1; } };
    const stdout = memorySink({ fail: "EPIPE" }); const stderr = memorySink();
    const receipt = await executeCommand(createCommandRaw({ operationKey: "messages.raw", stream }), { invocationCorrelationId: "cli:test", mode: "raw", stdout, stderr, rawPolicy: { destination: "pipe", tty: "refuse" }, signal: new AbortController().signal });
    expect(cancelled).toBe(1);
    expect(receipt).toMatchObject({ semanticKind: "partial_output", exitCode: 141 });
    expect(stderr.bytes).toHaveLength(0);
  });

  it("maps local errors through the registered safe envelope", () => {
    const error = createLocalError("cli.protocol", "cli:test", { operationKey: null, phase: "result-validation" });
    const result = createCommandFailure({ operationKey: null, semanticKind: "protocol", error });
    expect(parseCommandResult(result).semanticKind).toBe("protocol");
    expect(error).toEqual({ code: "cli.protocol", message: "the CLI and service contract do not agree", correlationId: "cli:test", details: { operationKey: null, phase: "result-validation" } });
  });

  it("keeps malformed results protocol failures and local client failures executable", async () => {
    const stdout = memorySink(); const stderr = memorySink();
    const malformed = await executeCommand({ version: 1, kind: "value", operationKey: "messages.search", semanticKind: "success", data: {}, humanLines, diagnostics: [] }, { invocationCorrelationId: "cli:test", mode: "json", stdout, stderr, rawPolicy: { destination: "pipe", tty: "refuse" }, signal: new AbortController().signal });
    expect(malformed).toMatchObject({ semanticKind: "protocol", exitCode: 76 });
    expect(sinkText(stderr)).toContain('"correlationId":"cli:test"');
    expect(sinkText(stderr)).not.toContain("cli:protocol");
    const classified = classifyCliClientError(new CliClientError("transport_error", "messages.search", "ignored hostile message"), "cli:test");
    const secondOut = memorySink(); const secondErr = memorySink();
    const receipt = await executeCommand(classified, { invocationCorrelationId: "cli:test", mode: "json", stdout: secondOut, stderr: secondErr, rawPolicy: { destination: "pipe", tty: "refuse" }, signal: new AbortController().signal });
    expect(receipt).toMatchObject({ semanticKind: "unavailable", exitCode: 69 });
  });

  it("classifies a short sink write as partial output and awaits cleanup once", async () => {
    let cleanups = 0;
    const stdout: CommandSink = { async write(value) { return { kind: "written", bytesAccepted: value.byteLength - 1 }; } };
    const stderr = memorySink();
    const result = createCommandValue({ operationKey: "messages.search", data: { items: [], nextCursor: null }, semanticKind: "success", humanLines });
    const receipt = await executeCommand(result, { invocationCorrelationId: "cli:test", mode: "json", stdout, stderr, rawPolicy: { destination: "pipe", tty: "refuse" }, signal: new AbortController().signal, cleanup: async () => { cleanups += 1; } });
    expect(receipt).toMatchObject({ semanticKind: "partial_output", exitCode: 88, cleanupAwaited: true });
    expect(cleanups).toBe(1);
  });

  it("covers the complete accepted runtime failure matrix", async () => {
    expect(oracle.runtimeFailureMatrix).toHaveLength(15);
    expect(oracle.runtimeFailureMatrix.map((row) => row.id)).toEqual([
      "RUN-PRE-SINK-IO",
      "RUN-POST-SINK-IO",
      "RUN-EPIPE-ZERO",
      "RUN-EPIPE-PARTIAL",
      "RUN-STREAM-FAIL-ZERO",
      "RUN-STREAM-FAIL-PARTIAL",
      "RUN-CALLER-ABORT-ZERO",
      "RUN-CALLER-ABORT-PARTIAL",
      "RUN-SIGINT",
      "RUN-SIGTERM",
      "RUN-RENDER-FAIL",
      "RUN-CLEANUP-FAIL-ZERO",
      "RUN-CLEANUP-FAIL-PARTIAL",
      "RUN-DIAGNOSTIC-FAIL-ZERO",
      "RUN-DIAGNOSTIC-FAIL-PARTIAL",
    ]);

    const preStdout = memorySink({ fail: "IO" });
    const preStderr = memorySink();
    const pre = await executeCommand(validValue(), contextFor(preStdout, preStderr));
    expect(pre).toMatchObject({ semanticKind: "io", exitCode: 74, stdoutBytesAccepted: 0 });
    expect(sinkText(preStderr)).toContain('"code":"cli.output-io"');

    const postStdout: CommandSink = { async write(value) { return { kind: "written", bytesAccepted: value.byteLength - 1 }; } };
    const postStderr = memorySink();
    const post = await executeCommand(validValue(), contextFor(postStdout, postStderr));
    expect(post).toMatchObject({ semanticKind: "partial_output", exitCode: 88, stdoutBytesAccepted: 30 });
    expect(sinkText(postStderr)).toContain('"code":"cli.partial-output"');

    const epipeZero = await executeCommand(rawResult((async function* () { yield Uint8Array.of(1); })()), rawContext(memorySink({ fail: "EPIPE" }), memorySink(), new AbortController().signal));
    expect(epipeZero).toMatchObject({ semanticKind: "partial_output", exitCode: 141, stdoutBytesAccepted: 0 });

    let epipeWrites = 0;
    const epipePartialSink: CommandSink = { async write(value) { epipeWrites += 1; return epipeWrites === 1 ? { kind: "written", bytesAccepted: value.byteLength } : { kind: "failed", errorCode: "EPIPE", bytesAccepted: "unknown" }; } };
    const epipePartial = await executeCommand(rawResult((async function* () { yield Uint8Array.of(1); yield Uint8Array.of(2); })()), rawContext(epipePartialSink, memorySink()));
    expect(epipePartial).toMatchObject({ semanticKind: "partial_output", exitCode: 141, stdoutBytesAccepted: 1 });

    const idleZero = await executeCommand(rawResult((async function* () { throw new CliClientError("stream_idle_timeout", "messages.raw", "hostile"); })()), rawContext(memorySink(), memorySink()));
    expect(idleZero).toMatchObject({ semanticKind: "temporary", exitCode: 75 });

    let idleWrites = 0;
    const idlePartial = await executeCommand(rawResult((async function* () { yield Uint8Array.of(7); throw new CliClientError("stream_idle_timeout", "messages.raw", "hostile"); })()), rawContext({ async write(value) { idleWrites += 1; return { kind: "written", bytesAccepted: value.byteLength }; } }, memorySink()));
    expect(idlePartial).toMatchObject({ semanticKind: "partial_output", exitCode: 88, stdoutBytesAccepted: 1 });
    expect(idleWrites).toBe(1);

    const callerZeroController = new AbortController();
    callerZeroController.abort(new Error("caller abort"));
    const callerZeroErr = memorySink();
    const callerZero = await executeCommand(validValue(), contextFor(memorySink(), callerZeroErr, callerZeroController.signal));
    expect(callerZero).toMatchObject({ semanticKind: "cancelled", exitCode: 84 });
    expect(sinkText(callerZeroErr)).toContain('"code":"cli.cancelled"');

    const callerPartialController = new AbortController();
    const callerPartialStdout: CommandSink = { async write(value) { callerPartialController.abort(new Error("caller abort")); return { kind: "written", bytesAccepted: value.byteLength }; } };
    const callerPartialErr = memorySink();
    const callerPartial = await executeCommand(validValue(), contextFor(callerPartialStdout, callerPartialErr, callerPartialController.signal));
    expect(callerPartial).toMatchObject({ semanticKind: "partial_output", exitCode: 88 });
    expect(sinkText(callerPartialErr)).toContain('"code":"cli.partial-output"');

    const sigintController = new AbortController();
    const sigintStdout: CommandSink = { async write(value) { sigintController.abort("SIGINT"); return { kind: "written", bytesAccepted: value.byteLength }; } };
    const sigint = await executeCommand(validValue(), contextFor(sigintStdout, memorySink(), sigintController.signal, { terminalSignal: "SIGINT" }));
    expect(sigint).toMatchObject({ semanticKind: "cancelled", exitCode: 130, stdoutBytesAccepted: 31 });

    const sigtermController = new AbortController();
    sigtermController.abort("SIGTERM");
    const sigterm = await executeCommand(validValue(), contextFor(memorySink(), memorySink(), sigtermController.signal, { terminalSignal: "SIGTERM" }));
    expect(sigterm).toMatchObject({ semanticKind: "cancelled", exitCode: 143 });

    const cleanupZeroErr = memorySink();
    const cleanupZero = await executeCommand(rawResult((async function* () { throw new CliClientError("stream_idle_timeout", "messages.raw", "idle"); })()), rawContext(memorySink(), cleanupZeroErr, new AbortController().signal, { cleanup: async () => { throw new Error("cleanup"); } }));
    expect(cleanupZero).toMatchObject({ semanticKind: "internal", exitCode: 70, cleanupAwaited: true });
    expect(sinkText(cleanupZeroErr)).toContain('"code":"cli.internal"');

    let cleanupCalls = 0;
    const cleanupPartialErr = memorySink();
    const cleanupPartial = await executeCommand(validValue(), contextFor(memorySink(), cleanupPartialErr, new AbortController().signal, { cleanup: async () => { cleanupCalls += 1; throw new Error("cleanup"); } }));
    expect(cleanupPartial).toMatchObject({ semanticKind: "partial_output", exitCode: 88, cleanupAwaited: true });
    expect(cleanupCalls).toBe(1);
    expect(cleanupPartial.stderrBytesAccepted).toBe(sinkByteLength(cleanupPartialErr));
    expect(sinkText(cleanupPartialErr)).toContain('"code":"cli.partial-output"');

    const diagnostic = [{ version: 1 as const, kind: "diagnostic" as const, level: "warning" as const, code: "cli.warning", message: "notice", correlationId: "cli:test", details: {} }];
    const diagnosticZero = await executeCommand(createCommandValue({ ...validValue(), diagnostics: diagnostic }), contextFor(memorySink(), memorySink({ fail: "IO" })));
    expect(diagnosticZero).toMatchObject({ semanticKind: "io", exitCode: 74 });

    let diagnosticWrites = 0;
    const diagnosticPartialErr: CommandSink = { async write(value) { diagnosticWrites += 1; return diagnosticWrites === 1 ? { kind: "written", bytesAccepted: value.byteLength - 1 } : { kind: "failed", errorCode: "EIO", bytesAccepted: 0 }; } };
    const diagnosticPartial = await executeCommand(createCommandValue({ ...validValue(), diagnostics: diagnostic }), contextFor(memorySink(), diagnosticPartialErr));
    expect(diagnosticPartial).toMatchObject({ semanticKind: "partial_output", exitCode: 88 });
  });

  it("rejects forged raw operations, unknown stream chunks, and exact hostile boundaries", async () => {
    const forged = { version: 1, kind: "raw", operationKey: "messages.search", semanticKind: "success", stream: { operationKey: "messages.search", body: (async function* () { yield Uint8Array.of(120); })(), cancel: async () => {} }, diagnostics: [] };
    const forgedErr = memorySink();
    const forgedReceipt = await executeCommand(forged, rawContext(memorySink(), forgedErr));
    expect(forgedReceipt).toMatchObject({ semanticKind: "protocol", exitCode: 76, stdoutBytesAccepted: 0 });
    expect(sinkText(forgedErr)).toContain('"code":"cli.protocol"');

    const badChunk = { version: 1, kind: "raw", operationKey: "messages.raw", semanticKind: "success", stream: { operationKey: "messages.raw", body: (async function* () { yield "x" as unknown as Uint8Array; })(), cancel: async () => {} }, diagnostics: [] };
    const badChunkErr = memorySink();
    const badChunkReceipt = await executeCommand(badChunk, rawContext(memorySink(), badChunkErr));
    expect(badChunkReceipt).toMatchObject({ semanticKind: "protocol", exitCode: 76 });
    expect(sinkText(badChunkErr)).toContain('"code":"cli.protocol"');
  });

  it("cancels an opened raw stream on mode mismatch and handles refusal cleanup", async () => {
    let cancelled = 0;
    const mismatched = await executeCommand(
      rawResult((async function* () { yield Uint8Array.of(1); })(), async () => { cancelled += 1; }),
      contextFor(memorySink(), memorySink()),
    );
    expect(mismatched).toMatchObject({ semanticKind: "usage", exitCode: 64, cleanupAwaited: true });
    expect(cancelled).toBe(1);

    const refusal = await executeCommand(
      rawResult((async function* () { yield Uint8Array.of(1); })(), async () => { throw new Error("cleanup"); }),
      { ...rawContext(memorySink(), memorySink()), rawPolicy: { destination: "tty" as const, tty: "refuse" as const } },
    );
    expect(refusal).toMatchObject({ semanticKind: "partial_output", exitCode: 88, cleanupAwaited: true });

    const controller = new AbortController();
    const signalled = await executeCommand(
      rawResult((async function* () { yield Uint8Array.of(1); })(), async () => { controller.abort("SIGINT"); }),
      { ...rawContext(memorySink(), memorySink(), controller.signal), rawPolicy: { destination: "tty" as const, tty: "refuse" as const }, terminalSignal: "SIGINT" },
    );
    expect(signalled).toMatchObject({ semanticKind: "cancelled", exitCode: 130, cleanupAwaited: true });
  });

  it("preserves null for the destination counter when stdout acceptance is unknown", async () => {
    const stderr = memorySink();
    const receipt = await executeCommand(
      rawResult((async function* () { yield Uint8Array.of(1); })()),
      rawContext({ async write() { return { kind: "failed", errorCode: "EIO", bytesAccepted: "unknown" }; } }, stderr),
    );
    expect(receipt).toMatchObject({ semanticKind: "partial_output", exitCode: 88, stdoutBytesAccepted: 0 });
    const envelope = JSON.parse(sinkText(stderr).trim()) as { readonly details: { readonly stdoutBytesAccepted: number | null; readonly stderrBytesAccepted: number | null } };
    expect(envelope.details.stdoutBytesAccepted).toBeNull();
    expect(envelope.details.stderrBytesAccepted).toBe(0);

    const stderrUnknown = await executeCommand(
      createCommandFailure({ operationKey: null, semanticKind: "protocol", error: createLocalError("cli.protocol", "cli:test", { operationKey: null, phase: "result-validation" }) }),
      contextFor(memorySink(), { async write() { return { kind: "failed", errorCode: "EIO", bytesAccepted: "unknown" }; } }),
    );
    expect(stderrUnknown).toMatchObject({ semanticKind: "partial_output", exitCode: 88, stdoutBytesAccepted: 0, stderrBytesAccepted: 0 });
  });

  it("treats report EPIPE and a report-time signal as terminal without recursion", async () => {
    const partialErr = memorySink({ fail: "EPIPE" });
    const partial = await executeCommand(
      validValue(),
      contextFor({ async write(value) { return { kind: "written", bytesAccepted: value.byteLength - 1 }; } }, partialErr),
    );
    expect(partial).toMatchObject({ semanticKind: "partial_output", exitCode: 141, stderrBytesAccepted: 0 });

    const controller = new AbortController();
    const reportErr: CommandSink = {
      async write(value) {
        controller.abort("SIGTERM");
        return { kind: "written", bytesAccepted: value.byteLength };
      },
    };
    const signalled = await executeCommand(
      validValue(),
      contextFor(memorySink({ fail: "IO" }), reportErr, controller.signal, { terminalSignal: "SIGTERM" }),
    );
    expect(signalled).toMatchObject({ semanticKind: "cancelled", exitCode: 143, stderrBytesAccepted: 165 });
  });

  it("classifies a genuine structured render failure as internal", async () => {
    const customRegistry = createOperationRegistry([
      {
        key: "test.render",
        route: "/test/render",
        method: "GET",
        cliName: "test-render",
        scope: null,
        request: z.any(),
        response: z.any(),
        errors: [],
        streaming: "none",
        strictness: "strict",
      },
    ]);
    const result = createCommandValue(
      { operationKey: "test.render", data: undefined, semanticKind: "success", humanLines },
      customRegistry,
    );
    const stderr = memorySink();
    const receipt = await executeCommand(result, contextFor(memorySink(), stderr), customRegistry);
    expect(receipt).toMatchObject({ semanticKind: "internal", exitCode: 70, stdoutBytesAccepted: 0 });
    expect(sinkText(stderr)).toContain('"code":"cli.internal"');
  });
});
