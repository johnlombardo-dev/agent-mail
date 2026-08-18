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
  discoverExecutingActionPlans,
  type ExecutingActionPlanRecoveryCandidate,
} from "../../storage/src/action-plan-restart-recovery";
import {
  finalizeActionPlan,
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
  readonly targetLoopOptions: (
    candidate: ExecutingActionPlanRecoveryCandidate,
  ) => Omit<ActionPlanTargetLoopOptions, "database" | "claimedPlan" | "now">;
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
  const candidates = discoverExecutingActionPlans(options.database);
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
      const loopOptions = options.targetLoopOptions(candidate);
      let loopResult: ActionPlanTargetLoopResult;
      try {
        loopResult = await runActionPlanTargetLoop({
          ...loopOptions,
          database: options.database,
          claimedPlan: candidate.plan,
          now: options.now,
          signal: options.signal,
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
        const finalized = finalizeActionPlan(options.database, {
          planId,
          claimId: candidate.plan.claimId,
          expectedVersion: candidate.version,
          now: options.now,
        });
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
