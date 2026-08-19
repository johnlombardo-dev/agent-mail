import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { actionPlanClaimSequence } from "../src/migrations/0003-action-plan-claim";
import { createPendingActionPlan } from "../src/action-plan-repository";
import { claimPendingActionPlan } from "../src/action-plan-claim";

const roots: string[] = [];
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const scope = "mail:action.create";
const createdAt = "2026-08-18T00:00:00.000Z";
const expiresAt = "2026-08-19T00:00:00.000Z";
const now = "2026-08-18T01:00:00.000Z";
const startedAt = "2026-08-18T01:00:01.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeDatabase(name: string): Promise<{
  readonly root: string;
  readonly path: string;
  readonly opened: Awaited<ReturnType<typeof openDatabase>>;
}> {
  const root = await mkdtemp(join(tmpdir(), `agent-mail-claim-${name}-`));
  await chmod(root, 0o700);
  roots.push(root);
  const path = join(root, "archive.sqlite");
  const opened = await openDatabase(path);
  runMigrations(opened, actionPlanClaimSequence);
  return { root, path, opened };
}

function proposal(planId: string, expiry = expiresAt) {
  return {
    planId,
    action: { kind: "markSeen" },
    targets: [
      {
        accountId: "account:one",
        mailboxId: "mailbox:inbox",
        uidValidity: 9,
        uid: 7,
        precondition: { modseq: 101 },
      },
    ],
    createdAt,
    expiresAt: expiry,
    previewDigest: digest,
    authorizationScope: scope,
    idempotencyIdentity: `caller:${planId}`,
  } as const;
}

function claimInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    planId: "plan:one",
    claimId: "claim:one",
    startedAt,
    now,
    digest,
    authorizationScope: scope,
    expectedVersion: 1,
    ...overrides,
  };
}

function snapshot(database: Database, planId: string): Readonly<Record<string, unknown>> {
  return {
    plan: database
      .query(
        "SELECT plan_id, state, claim_id, started_at, version FROM action_plans WHERE plan_id = ?;",
      )
      .get(planId),
    claims: database
      .query("SELECT plan_id, claim_id, claimed_at FROM action_plan_claims WHERE plan_id = ?;")
      .all(planId),
  };
}

type NonPendingState =
  | "executing"
  | "expired"
  | "rejected"
  | "completed"
  | "partial"
  | "failed"
  | "uncertain";

function createNonPendingPlan(database: Database, planId: string, state: NonPendingState): number {
  createPendingActionPlan(database, proposal(planId));
  if (state === "expired") {
    database
      .query("UPDATE action_plans SET state = 'expired', expired_at = ? WHERE plan_id = ?;")
      .run(expiresAt, planId);
    return 1;
  }
  if (state === "rejected") {
    database
      .query(
        "UPDATE action_plans SET state = 'rejected', rejected_at = ?, rejection_reason = ? WHERE plan_id = ?;",
      )
      .run(startedAt, "operator rejected", planId);
    return 1;
  }
  const result = claimPendingActionPlan(database, {
    ...claimInput({ planId, claimId: `claim:${planId.slice("plan:".length)}` }),
  });
  expect(result).toMatchObject({ kind: "claimed" });
  if (state === "executing") {
    return 2;
  }
  if (state === "completed" || state === "partial") {
    database
      .query(
        "UPDATE action_plans SET state = ?, claim_id = NULL, started_at = NULL, completed_at = ? WHERE plan_id = ?;",
      )
      .run(state, startedAt, planId);
  } else if (state === "failed") {
    database
      .query(
        "UPDATE action_plans SET state = 'failed', claim_id = NULL, started_at = NULL, failed_at = ? WHERE plan_id = ?;",
      )
      .run(startedAt, planId);
  } else {
    database
      .query(
        "INSERT INTO action_attempts " +
          "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, idempotency_key, started_at, certainty) " +
          "VALUES (?, ?, 1, 'account:one', 'mailbox:inbox', 9, 7, ?, ?, 'unresolved');",
      )
      .run(`attempt:${planId.slice("plan:".length)}`, planId, `idempotency:${planId}`, startedAt);
    database
      .query(
        "UPDATE action_plans SET state = 'uncertain', claim_id = NULL, started_at = NULL, " +
          "uncertain_attempt_id = ?, missing_local_result_at = ? WHERE plan_id = ?;",
      )
      .run(`attempt:${planId.slice("plan:".length)}`, startedAt, planId);
  }
  return 2;
}

describe("atomic pending action plan claim", () => {
  test("file-backed concurrent claimers produce one executing transition and one claim identity", async () => {
    const database = await makeDatabase("race");
    createPendingActionPlan(database.opened.db, { ...proposal("plan:race"), idempotencyIdentity: "caller:race" });
    await database.opened.close();

    const worker = join(import.meta.dir, "helpers/action-plan-claim-worker.ts");
    const args = [database.path, "claim:worker", startedAt, now, digest, scope, "1"];
    const processes = [
      Bun.spawn(["bun", "run", worker, ...args], { stdout: "pipe", stderr: "pipe" }),
      Bun.spawn(["bun", "run", worker, ...args.map((value, index) => (index === 1 ? "claim:other" : value))], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    ];
    const outputs = await Promise.all(
      processes.map(async (process) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        return JSON.parse(stdout.trim()) as { readonly kind: string; readonly version: number };
      }),
    );
    expect(outputs.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(outputs.filter((result) => result.kind === "already-claimed")).toHaveLength(1);

    const reopened = await openDatabase(database.path);
    try {
      expect(
        reopened.db
          .query("SELECT state, claim_id, started_at, version FROM action_plans WHERE plan_id = 'plan:race';")
          .get(),
      ).toEqual({ state: "executing", claim_id: expect.any(String), started_at: startedAt, version: 2 });
      expect(reopened.db.query("SELECT plan_id, claim_id, claimed_at FROM action_plan_claims;").all()).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });

  test("digest, authorization, expiry, and terminal rejection paths do not mutate", async () => {
    const database = await makeDatabase("zero-mutation");
    try {
      for (const [planId, overrides, expectedKind] of [
        ["plan:digest", { planId: "plan:digest", digest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }, "rejected"],
        ["plan:authorization", { planId: "plan:authorization", authorizationScope: "mail:wrong" }, "rejected"],
        ["plan:version", { planId: "plan:version", expectedVersion: 2 }, "rejected"],
        [
          "plan:expiry",
          {
            planId: "plan:expiry",
            now: "2026-08-20T00:00:00.000Z",
            startedAt: "2026-08-20T00:00:01.000Z",
          },
          "expired",
        ],
      ] as const) {
        createPendingActionPlan(database.opened.db, proposal(planId));
        const before = snapshot(database.opened.db, planId);
        const result = claimPendingActionPlan(database.opened.db, { ...claimInput(overrides), planId });
        expect(result.kind).toBe(expectedKind);
        expect(snapshot(database.opened.db, planId)).toEqual(before);
      }

      const stateExpectations = [
        ["executing", "already-claimed"],
        ["expired", "expired"],
        ["rejected", "rejected"],
        ["completed", "terminal"],
        ["partial", "terminal"],
        ["failed", "terminal"],
        ["uncertain", "terminal"],
      ] as const;
      for (const [state, expectedKind] of stateExpectations) {
        const planId = `plan:${state}`;
        const expectedVersion = createNonPendingPlan(database.opened.db, planId, state);
        const before = snapshot(database.opened.db, planId);
        const badDigest = claimPendingActionPlan(database.opened.db, {
          ...claimInput({ planId, digest: "f".repeat(64), expectedVersion }),
        });
        expect(badDigest).toEqual({ kind: "rejected", planId, reason: "digest", version: expectedVersion });
        const badScope = claimPendingActionPlan(database.opened.db, {
          ...claimInput({ planId, authorizationScope: "mail:wrong", expectedVersion }),
        });
        expect(badScope).toEqual({ kind: "rejected", planId, reason: "authorization", version: expectedVersion });
        expect(snapshot(database.opened.db, planId)).toEqual(before);
        const valid = claimPendingActionPlan(database.opened.db, {
          ...claimInput({ planId, expectedVersion }),
        });
        expect(valid).toMatchObject({ kind: expectedKind, ...(expectedKind === "terminal" ? { state } : {}) });
        expect(snapshot(database.opened.db, planId)).toEqual(before);
      }

      const missingEvidenceId = "plan:missing-evidence";
      database.opened.db
        .query(
          "INSERT INTO action_plans (plan_id, action_kind, created_at, expires_at, state, completed_at) " +
            "VALUES (?, 'markSeen', ?, ?, 'completed', ?);",
        )
        .run(missingEvidenceId, createdAt, expiresAt, startedAt);
      const missingEvidenceBefore = snapshot(database.opened.db, missingEvidenceId);
      expect(() =>
        claimPendingActionPlan(database.opened.db, {
          ...claimInput({ planId: missingEvidenceId }),
        }),
      ).toThrow("action plan authorization evidence is missing");
      expect(snapshot(database.opened.db, missingEvidenceId)).toEqual(missingEvidenceBefore);
    } finally {
      await database.opened.close();
    }
  });

  test("rejects invalid claim times without mutation", async () => {
    const database = await makeDatabase("time-guards");
    try {
      createPendingActionPlan(database.opened.db, proposal("plan:time"));
      const before = snapshot(database.opened.db, "plan:time");
      expect(() =>
        claimPendingActionPlan(database.opened.db, {
          ...claimInput({
            planId: "plan:time",
            startedAt: "2026-08-18T00:59:59.000Z",
          }),
        }),
      ).toThrow("claim start must not precede claim observation time");
      expect(snapshot(database.opened.db, "plan:time")).toEqual(before);

      const atExpiry = claimPendingActionPlan(database.opened.db, {
        ...claimInput({
          planId: "plan:time",
          startedAt: expiresAt,
          now: "2026-08-18T01:00:00.000Z",
        }),
      });
      expect(atExpiry).toMatchObject({ kind: "expired" });
      expect(snapshot(database.opened.db, "plan:time")).toEqual(before);
    } finally {
      await database.opened.close();
    }
  });

  test("checks replay evidence before disclosing an active claim", async () => {
    const database = await makeDatabase("replay-evidence");
    try {
      createPendingActionPlan(database.opened.db, proposal("plan:replay"));
      const claimed = claimPendingActionPlan(database.opened.db, {
        ...claimInput({ planId: "plan:replay", claimId: "claim:replay" }),
      });
      expect(claimed).toMatchObject({ kind: "claimed" });
      const before = snapshot(database.opened.db, "plan:replay");
      const digestFailure = claimPendingActionPlan(database.opened.db, {
        ...claimInput({ planId: "plan:replay", digest: "f".repeat(64) }),
      });
      expect(digestFailure).toEqual({ kind: "rejected", planId: "plan:replay", reason: "digest", version: 2 });
      const authorizationFailure = claimPendingActionPlan(database.opened.db, {
        ...claimInput({ planId: "plan:replay", authorizationScope: "mail:wrong" }),
      });
      expect(authorizationFailure).toEqual({
        kind: "rejected",
        planId: "plan:replay",
        reason: "authorization",
        version: 2,
      });
      expect(snapshot(database.opened.db, "plan:replay")).toEqual(before);
    } finally {
      await database.opened.close();
    }
  });
});
