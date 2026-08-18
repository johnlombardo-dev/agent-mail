import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutingActionPlan, UtcInstant } from "@agent-mail/core";
import {
  platformProcessIdentityAdapter,
  type ProcessIdentityAdapter,
  type ProcessIdentityObservation,
} from "../../../port-lease";
import {
  discoverLegacyExecutingActionPlans,
  discoverExecutingActionPlans,
  type ExecutingActionPlanRecoveryCandidate,
} from "../../storage/src/action-plan-restart-recovery";
import {
  finalizeActionPlan,
  finalizeActionPlanAfterRecovery,
  finalizeLegacyActionPlan,
  type FinalizeActionPlanResult,
} from "../../storage/src/action-plan-finalization";
import { readActionPlanResult } from "../../storage/src/action-plan-result";
import { readActionPlanAttempt } from "../../storage/src/action-plan-attempt";
import {
  runActionPlanTargetLoop,
  type ActionPlanTargetLoopOptions,
  type ActionPlanTargetLoopResult,
} from "./action-plan-target-loop";
import type { Database } from "bun:sqlite";
import {
  invalidateAuthorityForConfigurationChange,
  invalidateApprovalsForMissingKeys,
  invalidatePendingSealKeyAdministrationChallenges,
  quarantineRestoredAuthority,
  readEffectAuthorityProjection,
  type ApprovalSealKeyring,
} from "../../storage/src/action-approval-authority";
import type { AuthorityFileLock } from "./action-authority-lock";

export type AuthorityStartupAdmission = Readonly<{
  readonly database: Database;
  readonly restored: boolean;
  readonly restoreEventId?: string;
  readonly now: UtcInstant;
  /** Startup cannot admit authority without the validated seal-key projection. */
  readonly keyring: ApprovalSealKeyring;
  readonly authorityInstanceId: string;
  readonly configurationRevision: number;
  readonly activeCredentialIds: readonly string[];
}>;

/** Must run before listeners, session/auth services, or executing-plan discovery. */
export function admitAuthorityStartup(options: AuthorityStartupAdmission): Readonly<{
  readonly kind: "ordinary-restart" | "explicit-restore";
  readonly invalidatedApprovals: number;
  readonly quarantinedPlans: number;
}> {
  if (!options.restored) {
    invalidatePendingSealKeyAdministrationChallenges(options.database, options.now);
    const configuration = invalidateAuthorityForConfigurationChange(options.database, {
      authorityInstanceId: options.authorityInstanceId,
      configurationRevision: options.configurationRevision,
      activeCredentialIds: options.activeCredentialIds,
      invalidatedAt: options.now,
    });
    const invalidatedApprovals = invalidateApprovalsForMissingKeys(
      options.database,
      options.keyring,
      options.now,
    );
    return {
      kind: "ordinary-restart",
      invalidatedApprovals: configuration.invalidatedApprovals + invalidatedApprovals,
      quarantinedPlans: 0,
    };
  }
  if (options.restoreEventId === undefined || !options.restoreEventId.startsWith("restore-event:"))
    throw new Error("restore admission requires a restore event ID");
  const result = quarantineRestoredAuthority(options.database, options.restoreEventId, options.now);
  return { kind: "explicit-restore", ...result };
}

export type AuthorityStartupOrchestrationOptions = Readonly<{
  readonly admission: AuthorityStartupAdmission;
  readonly authorityLock: AuthorityFileLock;
  /** Recovery is deliberately injected so the daemon can use its actor-owned adapters. */
  readonly recover: () => Promise<RestartRecoveryReport>;
  /** Memory-only sessions and provisional challenge caches are cleared before recovery. */
  readonly clearEphemeralAuthority: () => void | Promise<void>;
  /** Network listeners are installed only after admission and recovery complete. */
  readonly startListeners: () => void | Promise<void>;
  /** The owner-only native ceremony adapter is exposed only after recovery. */
  readonly startAuthorityMutationServer: () => void | Promise<void>;
  /** The daemon-owned durable challenge issuer is exposed only after recovery. */
  readonly startAuthorityChallengeServer: () => void | Promise<void>;
}>;

export type AuthorityStartupResult = Readonly<{
  readonly admission: Readonly<{
    readonly kind: "ordinary-restart" | "explicit-restore";
    readonly invalidatedApprovals: number;
    readonly quarantinedPlans: number;
  }>;
  readonly recovery: RestartRecoveryReport;
}>;

/**
 * Compose restore admission, ephemeral authority reset, recovery, and listener
 * startup in one ordered boundary. Callers cannot accidentally expose a
 * listener or session service while restored rows are still eligible work.
 */
export async function startAuthorityRuntime(
  options: AuthorityStartupOrchestrationOptions,
): Promise<AuthorityStartupResult> {
  const admission = await options.authorityLock.runExclusive(() =>
    admitAuthorityStartup(options.admission),
  );
  await options.clearEphemeralAuthority();
  const recovery = await options.recover();
  await options.startAuthorityMutationServer();
  await options.startAuthorityChallengeServer();
  await options.startListeners();
  return Object.freeze({ admission, recovery });
}

/** Process identity is injected so tests can exercise PID reuse and child death deterministically. */
export type RecoveryProcessIdentityAdapter = ProcessIdentityAdapter;
export type RecoveryProcessObservation = ProcessIdentityObservation;

export type ActionPlanOwnerLease = Readonly<{
  readonly planId: string;
  readonly claimId: string;
  readonly ownerToken: string;
}>;

export type ActionPlanOwnerLeaseAcquireResult =
  | Readonly<{ readonly kind: "acquired"; readonly lease: ActionPlanOwnerLease }>
  | Readonly<{ readonly kind: "live"; readonly planId: string; readonly claimId: string }>
  | Readonly<{ readonly kind: "unknown"; readonly planId: string; readonly reason: string }>
  | Readonly<{ readonly kind: "busy"; readonly planId: string }>;

export type ActionPlanOwnerLeaseStore = Readonly<{
  readonly acquire: (
    input: Readonly<{ planId: string; claimId: string }>,
  ) => Promise<ActionPlanOwnerLeaseAcquireResult>;
  readonly release: (
    lease: ActionPlanOwnerLease,
  ) => Promise<"released" | "already-released" | "not-owner">;
}>;

export type OwnedActionPlanRunResult<T> =
  | Readonly<{ readonly kind: "ran"; readonly value: T }>
  | Readonly<{ readonly kind: "live-owner" }>
  | Readonly<{ readonly kind: "unknown-owner"; readonly reason: string }>
  | Readonly<{ readonly kind: "busy" }>;

type StoredLease = ActionPlanOwnerLease &
  Readonly<{
    readonly pid: number;
    readonly processStartIdentity: string;
    readonly createdAt: string;
  }>;

/**
 * A file-backed plan owner lease. A stale record is retained before takeover;
 * age is never used as proof. The lease survives a process crash and is
 * removed only by the exact owner token.
 */
export function createFileActionPlanOwnerLeaseStore(
  options: Readonly<{
    readonly directory: string;
    readonly processIdentityAdapter?: RecoveryProcessIdentityAdapter;
  }>,
): ActionPlanOwnerLeaseStore {
  const adapter = options.processIdentityAdapter ?? platformRecoveryProcessIdentityAdapter;
  const directory = options.directory;
  return {
    acquire: async ({ planId, claimId }) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = leasePath(directory, planId);
      const existing = await readLease(path);
      if (existing.kind === "invalid")
        return { kind: "unknown", planId, reason: "invalid lease record" };
      if (existing.kind === "present") {
        const classification = await classifyLease(existing.record, adapter);
        if (classification.kind === "live") {
          return { kind: "live", planId, claimId: existing.record.claimId };
        }
        if (classification.kind === "unknown") {
          return { kind: "unknown", planId, reason: classification.reason };
        }
        try {
          await rename(path, reclaimedLeasePath(directory, planId));
        } catch (error: unknown) {
          if (isFileSystemError(error, "ENOENT")) return { kind: "busy", planId };
          throw error;
        }
      }

      const processStartIdentity = await adapter.currentProcessStartIdentity();
      const lease: StoredLease = {
        planId,
        claimId,
        ownerToken: randomUUID(),
        pid: process.pid,
        processStartIdentity,
        createdAt: new Date().toISOString(),
      };
      let handle: FileHandle;
      try {
        handle = await open(path, "wx", 0o600);
      } catch (error: unknown) {
        if (isFileSystemError(error, "EEXIST")) return { kind: "busy", planId };
        throw error;
      }
      try {
        await handle.writeFile(JSON.stringify(lease), "utf8");
        await handle.sync();
      } catch (error: unknown) {
        try {
          await handle.close();
          await unlink(path);
        } catch (cleanupError: unknown) {
          throw new AggregateError([error, cleanupError], "action plan owner lease cleanup failed");
        }
        throw error;
      }
      await handle.close();
      return { kind: "acquired", lease };
    },
    release: async (lease) => {
      const path = leasePath(directory, lease.planId);
      const existing = await readLease(path);
      if (existing.kind === "absent") return "already-released";
      if (existing.kind !== "present" || existing.record.ownerToken !== lease.ownerToken) {
        return "not-owner";
      }
      await unlink(path);
      return "released";
    },
  };
}

/** Normal execution and restart recovery share this owner boundary. */
export async function withExecutingActionPlanOwnerLease<T>(
  options: Readonly<{
    readonly ownerLeases: ActionPlanOwnerLeaseStore;
    readonly plan: ExecutingActionPlan;
    readonly run: () => Promise<T>;
  }>,
): Promise<OwnedActionPlanRunResult<T>> {
  const acquired = await options.ownerLeases.acquire({
    planId: options.plan.planId,
    claimId: options.plan.claimId,
  });
  if (acquired.kind === "live") return { kind: "live-owner" };
  if (acquired.kind === "unknown") return { kind: "unknown-owner", reason: acquired.reason };
  if (acquired.kind === "busy") return { kind: "busy" };
  try {
    return { kind: "ran", value: await options.run() };
  } finally {
    await options.ownerLeases.release(acquired.lease);
  }
}

/** Owner-aware entry point for the ordinary target executor. */
export function runOwnedActionPlanTargetLoop(
  options: Readonly<{
    readonly ownerLeases: ActionPlanOwnerLeaseStore;
    readonly targetLoop: ActionPlanTargetLoopOptions;
  }>,
): Promise<OwnedActionPlanRunResult<ActionPlanTargetLoopResult>> {
  return withExecutingActionPlanOwnerLease({
    ownerLeases: options.ownerLeases,
    plan: options.targetLoop.claimedPlan,
    run: () => runActionPlanTargetLoop(options.targetLoop),
  });
}

export type RestartRecoveryPlanOutcome =
  | Readonly<{
      readonly planId: string;
      readonly kind: "recovered";
      readonly finalized: FinalizeActionPlanResult;
    }>
  | Readonly<{
      readonly planId: string;
      readonly kind: "incomplete";
      readonly durableTargetCount: number;
    }>
  | Readonly<{ readonly planId: string; readonly kind: "skipped-live-owner" }>
  | Readonly<{
      readonly planId: string;
      readonly kind: "skipped-unknown-owner";
      readonly reason: string;
    }>
  | Readonly<{ readonly planId: string; readonly kind: "skipped-busy" }>
  | Readonly<{
      readonly planId: string;
      readonly kind: "failed";
      readonly reason: "target-loop" | "finalization";
    }>;

export type RestartRecoveryReport = Readonly<{
  readonly discovered: number;
  readonly outcomes: readonly RestartRecoveryPlanOutcome[];
}>;

export type RestartRecoveryOptions = Readonly<{
  readonly database: Database;
  readonly ownerLeases: ActionPlanOwnerLeaseStore;
  readonly now: UtcInstant;
  /** Actor-owned clock for fresh authority observations during recovery. */
  readonly freshNow: () => UtcInstant;
  /** Identity of the non-authorizing process that finalizes durable results. */
  readonly finalizerInstanceId?: string;
  /** Identity used only when this restart genuinely opens a new effect boundary. */
  readonly executorInstanceId?: string;
  /** Effect-capable recovery callback. It is intentionally optional so a
   * complete result/authority set can finalize without receiving adapters. */
  readonly targetLoopOptions?: (
    candidate: ExecutingActionPlanRecoveryCandidate,
  ) => Omit<
    ActionPlanTargetLoopOptions,
    "database" | "claimedPlan" | "now" | "expectedPlanVersion" | "freshNow"
  >;
  readonly signal?: AbortSignal;
  /** @internal Test-only process-crash seam; absent in production callers. */
  readonly onAllTargetsDurable?: (
    candidate: ExecutingActionPlanRecoveryCandidate,
  ) => void | Promise<void>;
}>;

/**
 * Resume every executing plan visible at startup. The owner lease is acquired
 * before any attempt is opened. Existing target-loop boundaries then decide
 * whether to skip, reconcile read-only, or continue an undispatched attempt.
 */
export async function recoverExecutingActionPlans(
  options: RestartRecoveryOptions,
): Promise<RestartRecoveryReport> {
  const candidates = [
    ...discoverExecutingActionPlans(options.database),
    ...discoverLegacyExecutingActionPlans(options.database),
  ];
  const outcomes: RestartRecoveryPlanOutcome[] = [];
  for (const candidate of candidates) {
    const planId = candidate.plan.planId;
    const acquired = await options.ownerLeases.acquire({
      planId,
      claimId: candidate.plan.claimId,
    });
    if (acquired.kind === "live") {
      outcomes.push({ planId, kind: "skipped-live-owner" });
      continue;
    }
    if (acquired.kind === "unknown") {
      outcomes.push({ planId, kind: "skipped-unknown-owner", reason: acquired.reason });
      continue;
    }
    if (acquired.kind === "busy") {
      outcomes.push({ planId, kind: "skipped-busy" });
      continue;
    }

    try {
      const authorityInstalled = hasAuthorityTables(options.database);
      const preflight =
        candidate.authorityVersion === "legacy-untrusted"
          ? undefined
          : readTrustedRecoveryPreflight(options.database, candidate, authorityInstalled);

      // A complete trusted result/authority set is a read-only recovery case.
      // Do this before resolving targetLoopOptions so no mutation adapter or
      // effect-capable closure is even constructed for the recovery finalizer.
      if (
        candidate.authorityVersion !== "legacy-untrusted" &&
        preflight !== undefined &&
        preflight.kind === "complete"
      ) {
        await options.onAllTargetsDurable?.(candidate);
        try {
          const finalized = finalizeActionPlanAfterRecovery(
            options.database,
            {
              planId,
              claimId: candidate.plan.claimId,
              expectedVersion: candidate.version,
              now: options.now,
            },
            options.finalizerInstanceId ?? `recovery-finalizer:${process.pid}`,
          );
          outcomes.push({ planId, kind: "recovered", finalized });
        } catch {
          outcomes.push({ planId, kind: "failed", reason: "finalization" });
        }
        continue;
      }

      // A fully-resulted trusted plan with an incomplete/tampered authority
      // projection must fail closed. It must not be handed to an effect loop
      // merely because the target result rows happen to exist.
      if (candidate.authorityVersion !== "legacy-untrusted" && preflight?.kind === "invalid") {
        outcomes.push({ planId, kind: "failed", reason: "finalization" });
        continue;
      }

      if (
        candidate.authorityVersion !== "legacy-untrusted" &&
        authorityInstalled &&
        !isExecutorIdentity(options.executorInstanceId)
      ) {
        outcomes.push({ planId, kind: "failed", reason: "target-loop" });
        continue;
      }

      const loopOptions = options.targetLoopOptions?.(candidate);
      if (loopOptions === undefined) {
        outcomes.push({ planId, kind: "failed", reason: "target-loop" });
        continue;
      }
      let loopResult: ActionPlanTargetLoopResult;
      try {
        loopResult = await runActionPlanTargetLoop({
          ...loopOptions,
          database: options.database,
          claimedPlan: candidate.plan,
          now: options.now,
          expectedPlanVersion: candidate.version,
          freshNow: options.freshNow,
          signal: options.signal,
          ...(candidate.authorityVersion === "legacy-untrusted"
            ? { legacyReadOnly: true as const }
            : {}),
          ...(candidate.authorityVersion !== "legacy-untrusted" && authorityInstalled
            ? { executorInstanceId: options.executorInstanceId }
            : {}),
        });
      } catch {
        outcomes.push({ planId, kind: "failed", reason: "target-loop" });
        continue;
      }

      const durableTargetCount = countDurableResults(options.database, candidate.plan);
      if (durableTargetCount !== candidate.plan.targets.length) {
        outcomes.push({ planId, kind: "incomplete", durableTargetCount });
        continue;
      }
      await options.onAllTargetsDurable?.(candidate);
      // P5-C16 precondition: finalization is attempted only after every target
      // has a durable result, regardless of loop cancellation or progress shape.
      try {
        const finalized =
          candidate.authorityVersion === "legacy-untrusted"
            ? finalizeLegacyActionPlan(options.database, {
                planId,
                claimId: candidate.plan.claimId,
                expectedVersion: candidate.version,
                now: options.now,
              })
            : authorityInstalled
              ? finalizeActionPlan(options.database, {
                  planId,
                  claimId: candidate.plan.claimId,
                  expectedVersion: candidate.version,
                  now: options.now,
                  executorInstanceId: options.executorInstanceId,
                })
              : finalizeActionPlanAfterRecovery(
                  options.database,
                  {
                    planId,
                    claimId: candidate.plan.claimId,
                    expectedVersion: candidate.version,
                    now: options.now,
                  },
                  options.finalizerInstanceId ?? `recovery-finalizer:${process.pid}`,
                );
        outcomes.push({ planId, kind: "recovered", finalized });
      } catch {
        outcomes.push({ planId, kind: "failed", reason: "finalization" });
      }
      void loopResult;
    } finally {
      await options.ownerLeases.release(acquired.lease);
    }
  }
  return { discovered: candidates.length, outcomes: Object.freeze(outcomes) };
}

type TrustedRecoveryPreflight = Readonly<{
  readonly kind: "complete" | "incomplete" | "invalid";
  readonly durableTargetCount: number;
}>;

function readTrustedRecoveryPreflight(
  database: Database,
  candidate: ExecutingActionPlanRecoveryCandidate,
  authorityInstalled: boolean,
): TrustedRecoveryPreflight {
  const durableTargetCount = countDurableResults(database, candidate.plan);
  const allTargetResultsDurable = targetResultsAreDurable(database, candidate.plan);
  if (!authorityInstalled) {
    return {
      kind:
        durableTargetCount === candidate.plan.targets.length &&
        allTargetResultsDurable &&
        targetResultsAreDefinite(database, candidate.plan)
          ? "complete"
          : "incomplete",
      durableTargetCount,
    };
  }

  const receipt = database
    .query(
      "SELECT receipt_id FROM action_approval_consumptions WHERE plan_id = ? AND claim_id = ?;",
    )
    .get(candidate.plan.planId, candidate.plan.claimId);
  if (!isRecord(receipt) || typeof receipt.receipt_id !== "string") {
    return { kind: "invalid", durableTargetCount };
  }
  const effect = readEffectAuthorityProjection(database, {
    planId: candidate.plan.planId,
    receiptId: receipt.receipt_id,
    claimId: candidate.plan.claimId,
  });
  if (effect.count > candidate.plan.targets.length) {
    return { kind: "invalid", durableTargetCount };
  }

  const ordinals = new Set<number>();
  for (const [attemptId] of effect.rows) {
    const attempt = readActionPlanAttempt(database, attemptId);
    if (attempt === undefined || attempt.claimId !== candidate.plan.claimId) {
      return { kind: "invalid", durableTargetCount };
    }
    const row = database
      .query("SELECT target_ordinal FROM action_attempts WHERE plan_id = ? AND attempt_id = ?;")
      .get(candidate.plan.planId, attemptId);
    const targetOrdinal = isRecord(row) ? safeInteger(row.target_ordinal) : undefined;
    if (targetOrdinal === undefined) {
      return { kind: "invalid", durableTargetCount };
    }
    if (
      targetOrdinal < 1 ||
      targetOrdinal > candidate.plan.targets.length ||
      ordinals.has(targetOrdinal)
    ) {
      return { kind: "invalid", durableTargetCount };
    }
    ordinals.add(targetOrdinal);
  }

  const complete =
    durableTargetCount === candidate.plan.targets.length &&
    allTargetResultsDurable &&
    effect.count === candidate.plan.targets.length &&
    ordinals.size === candidate.plan.targets.length;
  if (complete) return { kind: "complete", durableTargetCount };
  if (durableTargetCount === candidate.plan.targets.length && allTargetResultsDurable) {
    return { kind: "invalid", durableTargetCount };
  }
  return { kind: "incomplete", durableTargetCount };
}

function targetResultsAreDurable(database: Database, plan: ExecutingActionPlan): boolean {
  const rows: readonly unknown[] = database
    .query("SELECT attempt_id, target_ordinal FROM action_attempts WHERE plan_id = ?;")
    .all(plan.planId);
  const attempts = new Map<number, string>();
  for (const value of rows) {
    if (!isRecord(value) || typeof value.attempt_id !== "string") {
      return false;
    }
    const ordinal = safeInteger(value.target_ordinal);
    if (
      ordinal === undefined ||
      ordinal < 1 ||
      ordinal > plan.targets.length ||
      attempts.has(ordinal)
    ) {
      return false;
    }
    attempts.set(ordinal, value.attempt_id);
  }
  if (attempts.size !== plan.targets.length) return false;
  for (let ordinal = 1; ordinal <= plan.targets.length; ordinal += 1) {
    const attemptId = attempts.get(ordinal);
    if (attemptId === undefined) return false;
    const result = readActionPlanResult(database, attemptId);
    if (result === undefined) return false;
  }
  return true;
}

function targetResultsAreDefinite(database: Database, plan: ExecutingActionPlan): boolean {
  const rows: readonly unknown[] = database
    .query("SELECT attempt_id, target_ordinal FROM action_attempts WHERE plan_id = ?;")
    .all(plan.planId);
  const attempts = new Map<number, string>();
  for (const value of rows) {
    if (!isRecord(value) || typeof value.attempt_id !== "string") return false;
    const ordinal = safeInteger(value.target_ordinal);
    if (
      ordinal === undefined ||
      ordinal < 1 ||
      ordinal > plan.targets.length ||
      attempts.has(ordinal)
    )
      return false;
    attempts.set(ordinal, value.attempt_id);
  }
  if (attempts.size !== plan.targets.length) return false;
  for (let ordinal = 1; ordinal <= plan.targets.length; ordinal += 1) {
    const attemptId = attempts.get(ordinal);
    if (attemptId === undefined) return false;
    const result = readActionPlanResult(database, attemptId);
    if (result === undefined || result.certainty !== "definite") return false;
  }
  return true;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function hasAuthorityTables(database: Database): boolean {
  return (
    database
      .query(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'action_approval_consumptions';",
      )
      .get() !== null
  );
}

function isExecutorIdentity(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.startsWith("executor:") &&
    value.length > "executor:".length &&
    value.length <= 256 &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function countDurableResults(database: Database, plan: ExecutingActionPlan): number {
  const rows: readonly unknown[] = database
    .query(
      "SELECT attempt_id, target_ordinal FROM action_attempts WHERE plan_id = ? ORDER BY target_ordinal;",
    )
    .all(plan.planId);
  const attempts = new Map<number, string>();
  for (const value of rows) {
    const row = record(value, "action plan recovery attempt row");
    const ordinal = positiveInteger(row.target_ordinal, "action plan recovery target ordinal");
    if (ordinal > plan.targets.length || attempts.has(ordinal)) {
      throw new Error("action plan recovery attempt set is not one-to-one");
    }
    const attemptId = text(row.attempt_id, "action plan recovery attempt ID");
    if (!attemptId.startsWith("attempt:")) {
      throw new Error("action plan recovery attempt ID has the wrong namespace");
    }
    attempts.set(ordinal, attemptId);
  }
  let count = 0;
  for (const [index, target] of plan.targets.entries()) {
    const ordinal = index + 1;
    const attemptId = attempts.get(ordinal);
    if (attemptId === undefined) continue;
    const attempt = readActionPlanAttempt(database, attemptId);
    if (
      attempt === undefined ||
      attempt.claimId !== plan.claimId ||
      attempt.attempt.planId !== plan.planId ||
      !sameTarget(attempt.attempt.target, target)
    ) {
      throw new Error("action plan recovery attempt identity is stale");
    }
    if (readActionPlanResult(database, attemptId) !== undefined) count += 1;
  }
  return count;
}

function sameTarget(
  left: ExecutingActionPlan["targets"][number],
  right: ExecutingActionPlan["targets"][number],
): boolean {
  return (
    left.accountId === right.accountId &&
    left.mailboxId === right.mailboxId &&
    left.uidValidity === right.uidValidity &&
    left.uid === right.uid &&
    left.precondition.modseq === right.precondition.modseq
  );
}

type LeaseRead =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "invalid" }>
  | Readonly<{ readonly kind: "present"; readonly record: StoredLease }>;

async function readLease(path: string): Promise<LeaseRead> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value)) return { kind: "invalid" };
    const record = parseStoredLease(value);
    return record === undefined ? { kind: "invalid" } : { kind: "present", record };
  } catch {
    return { kind: "invalid" };
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

async function classifyLease(
  lease: StoredLease,
  adapter: RecoveryProcessIdentityAdapter,
): Promise<
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "live" }>
  | Readonly<{ kind: "unknown"; reason: string }>
> {
  let observation: RecoveryProcessObservation;
  try {
    observation = await adapter.inspectProcess(lease.pid);
  } catch (error: unknown) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : "process probe failed",
    };
  }
  if (observation.kind === "not-live") return { kind: "stale" };
  if (observation.kind === "unknown") return observation;
  return observation.processStartIdentity === lease.processStartIdentity
    ? { kind: "live" }
    : { kind: "stale" };
}

function parseStoredLease(value: Readonly<Record<string, unknown>>): StoredLease | undefined {
  const planId = value.planId;
  const claimId = value.claimId;
  const ownerToken = value.ownerToken;
  const processStartIdentity = value.processStartIdentity;
  const createdAt = value.createdAt;
  const pid = value.pid;
  if (
    typeof planId !== "string" ||
    typeof claimId !== "string" ||
    typeof ownerToken !== "string" ||
    typeof processStartIdentity !== "string" ||
    typeof createdAt !== "string" ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  ) {
    return undefined;
  }
  return { planId, claimId, ownerToken, processStartIdentity, createdAt, pid };
}

function leasePath(directory: string, planId: string): string {
  return join(directory, `${createHash("sha256").update(planId, "utf8").digest("hex")}.json`);
}

function reclaimedLeasePath(directory: string, planId: string): string {
  return join(
    directory,
    `${createHash("sha256").update(planId, "utf8").digest("hex")}.reclaimed.${Date.now()}-${randomUUID()}.json`,
  );
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export const platformRecoveryProcessIdentityAdapter: RecoveryProcessIdentityAdapter =
  platformProcessIdentityAdapter;
