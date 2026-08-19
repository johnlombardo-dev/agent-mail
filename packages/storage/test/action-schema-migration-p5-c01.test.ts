import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeBoundedSafeInteger,
  decodeClosedEnum,
  decodeSqliteRow,
  decodeUtcMillisecondInstant,
  type SqliteColumnContext,
} from "../src/row-decoders";
import { runMigrations } from "../src/migration-runner";
import { openDatabase } from "../src/database";
import { actionSchemaSequence } from "../src/migrations/0001-action-schema";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openActionDatabase() {
  const root = await mkdtemp(join(tmpdir(), "agent-mail-storage-action-schema-"));
  await chmod(root, 0o700);
  roots.push(root);
  const opened = await openDatabase(join(root, "archive.sqlite"));
  runMigrations(opened, actionSchemaSequence);
  return opened;
}

const createdAt = "2026-08-18T00:00:00.000Z";
const expiresAt = "2026-08-19T00:00:00.000Z";
const startedAt = "2026-08-18T00:01:00.000Z";
const resultAt = "2026-08-18T00:02:00.000Z";

function planValues(planId: string, state: string): readonly (string | null)[] {
  const stateFields = {
    claimId: state === "executing" ? "claim:fixture" : null,
    startedAt: state === "executing" ? startedAt : null,
    completedAt: state === "completed" || state === "partial" ? resultAt : null,
    failedAt: state === "failed" ? resultAt : null,
    rejectedAt: state === "rejected" ? resultAt : null,
    rejectionReason: state === "rejected" ? "operator rejected" : null,
    expiredAt: state === "expired" ? expiresAt : null,
    uncertainAttemptId: state === "uncertain" ? "attempt:fixture" : null,
    missingLocalResultAt: state === "uncertain" ? resultAt : null,
  };
  return [
    planId,
    "markSeen",
    createdAt,
    expiresAt,
    state,
    stateFields.claimId,
    stateFields.startedAt,
    stateFields.completedAt,
    stateFields.failedAt,
    stateFields.rejectedAt,
    stateFields.rejectionReason,
    stateFields.expiredAt,
    stateFields.uncertainAttemptId,
    stateFields.missingLocalResultAt,
  ];
}

function insertPlan(
  database: Awaited<ReturnType<typeof openActionDatabase>>["db"],
  planId: string,
  state: string,
): void {
  database
    .query(
      "INSERT INTO action_plans " +
        "(plan_id, action_kind, created_at, expires_at, state, claim_id, started_at, completed_at, failed_at, " +
        "rejected_at, rejection_reason, expired_at, uncertain_attempt_id, missing_local_result_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    )
    .run(...planValues(planId, state));
}

function insertTarget(
  database: Awaited<ReturnType<typeof openActionDatabase>>["db"],
  planId: string,
  ordinal: number,
): void {
  database
    .query(
      "INSERT INTO action_plan_targets " +
        "(plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, precondition_modseq) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?);",
    )
    .run(planId, ordinal, "account:fixture", `mailbox:fixture-${ordinal}`, 7, ordinal, 42);
}

function insertClaim(
  database: Awaited<ReturnType<typeof openActionDatabase>>["db"],
  planId: string,
  claimId: string,
): void {
  database
    .query(
      "INSERT INTO action_plan_claims (plan_id, claim_id, claimed_at) VALUES (?, ?, ?);",
    )
    .run(planId, claimId, startedAt);
}

function executingPlan(
  database: Awaited<ReturnType<typeof openActionDatabase>>["db"],
  planId: string,
  targetCount: number,
): void {
  insertPlan(database, planId, "pending");
  for (let ordinal = 1; ordinal <= targetCount; ordinal += 1) insertTarget(database, planId, ordinal);
  insertClaim(database, planId, `claim:${planId.slice("plan:".length)}`);
  database
    .query(
      "UPDATE action_plans SET state = 'executing', claim_id = ?, started_at = ? WHERE plan_id = ?;",
    )
    .run(`claim:${planId.slice("plan:".length)}`, startedAt, planId);
}

function insertAttempt(
  database: Awaited<ReturnType<typeof openActionDatabase>>["db"],
  planId: string,
  ordinal: number,
  attemptId: string,
): void {
  database
    .query(
      "INSERT INTO action_attempts " +
        "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
        "idempotency_key, started_at, certainty) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    )
    .run(
      attemptId,
      planId,
      ordinal,
      "account:fixture",
      `mailbox:fixture-${ordinal}`,
      7,
      ordinal,
      `idempotency:${ordinal}`,
      startedAt,
      "unresolved",
    );
}

function resultValues(
  planId: string,
  ordinal: number,
  attemptId: string,
  resultKind: string,
): readonly (string | number | null)[] {
  const isSuccess = resultKind === "success";
  const isUncertain = resultKind === "uncertain";
  const isFailed = resultKind === "failed";
  return [
    attemptId,
    planId,
    ordinal,
    "account:fixture",
    `mailbox:fixture-${ordinal}`,
    7,
    ordinal,
    `idempotency:${ordinal}`,
    startedAt,
    resultAt,
    resultKind,
    isUncertain ? "uncertain" : "definite",
    isUncertain ? "local-result-not-durable" : null,
    isFailed ? "server-rejected" : null,
    isSuccess ? null : `${resultKind} detail`,
    isSuccess ? "flags" : null,
    isSuccess ? resultAt : null,
    isSuccess ? 43 : null,
    isSuccess ? "[]" : null,
    null,
    null,
    null,
  ];
}

function insertResult(
  database: Awaited<ReturnType<typeof openActionDatabase>>["db"],
  planId: string,
  ordinal: number,
  attemptId: string,
  resultKind: string,
): void {
  database
    .query(
      "INSERT INTO action_results " +
        "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, " +
        "idempotency_key, started_at, result_at, result_kind, certainty, uncertain_reason, " +
        "failure_reason, detail, postcondition_kind, postcondition_observed_at, postcondition_modseq, " +
        "postcondition_flags, postcondition_mailbox_id, postcondition_uid_validity, postcondition_uid) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    )
    .run(...resultValues(planId, ordinal, attemptId, resultKind));
}

function decodeText(value: unknown, context: SqliteColumnContext): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${context.table}.${context.column} must be canonical text`);
  }
  return value;
}

function decodeNamespaced(value: unknown, prefix: string, context: SqliteColumnContext): string {
  const text = decodeText(value, context);
  if (!text.startsWith(`${prefix}:`)) throw new TypeError(`${context.column} has wrong namespace`);
  return text;
}

function decodePlanRow(row: unknown): Readonly<Record<string, unknown>> {
  return decodeSqliteRow({
    table: "action_plans",
    row,
    columns: {
      plan_id: { decode: (value, context) => decodeNamespaced(value, "plan", context) },
      action_kind: {
        decode: (value, context) =>
          decodeClosedEnum(value, { ...context, values: ["markSeen", "markUnseen", "moveToArchive", "moveToTrash"] as const }),
      },
      state: {
        decode: (value, context) =>
          decodeClosedEnum(value, {
            ...context,
            values: ["pending", "executing", "completed", "partial", "rejected", "expired", "failed", "uncertain"] as const,
          }),
      },
      created_at: { decode: decodeUtcMillisecondInstant },
      expires_at: { decode: decodeUtcMillisecondInstant },
    },
  });
}

function decodeResultRow(row: unknown): Readonly<Record<string, unknown>> {
  return decodeSqliteRow({
    table: "action_results",
    row,
    columns: {
      attempt_id: { decode: (value, context) => decodeNamespaced(value, "attempt", context) },
      plan_id: { decode: (value, context) => decodeNamespaced(value, "plan", context) },
      target_ordinal: { decode: (value, context) => decodeBoundedSafeInteger(value, { ...context, minimum: 1 }) },
      result_kind: {
        decode: (value, context) =>
          decodeClosedEnum(value, { ...context, values: ["success", "stale", "rejected", "failed", "uncertain"] as const }),
      },
      certainty: {
        decode: (value, context) => decodeClosedEnum(value, { ...context, values: ["definite", "uncertain"] as const }),
      },
      started_at: { decode: decodeUtcMillisecondInstant },
      result_at: { decode: decodeUtcMillisecondInstant },
    },
  });
}

describe("action schema migration", () => {
  test("stores and decodes every valid plan state and result outcome", async () => {
    const opened = await openActionDatabase();
    insertPlan(opened.db, "plan:pending", "pending");
    insertPlan(opened.db, "plan:completed", "completed");
    insertPlan(opened.db, "plan:partial", "partial");
    insertPlan(opened.db, "plan:failed", "failed");
    insertPlan(opened.db, "plan:rejected", "rejected");
    insertPlan(opened.db, "plan:expired", "expired");

    executingPlan(opened.db, "plan:uncertain", 1);
    insertAttempt(opened.db, "plan:uncertain", 1, "attempt:fixture");
    opened.db
      .query(
        "UPDATE action_plans SET state = 'uncertain', claim_id = NULL, started_at = NULL, " +
          "uncertain_attempt_id = ?, missing_local_result_at = ? WHERE plan_id = ?;",
      )
      .run("attempt:fixture", resultAt, "plan:uncertain");

    executingPlan(opened.db, "plan:results", 5);
    const resultKinds = ["success", "stale", "rejected", "failed", "uncertain"] as const;
    for (const [index, resultKind] of resultKinds.entries()) {
      const ordinal = index + 1;
      const attemptId = `attempt:${resultKind}`;
      insertAttempt(opened.db, "plan:results", ordinal, attemptId);
      insertResult(opened.db, "plan:results", ordinal, attemptId, resultKind);
    }

    const plans: unknown[] = opened.db
      .query(
        "SELECT plan_id, action_kind, state, created_at, expires_at FROM action_plans ORDER BY plan_id;",
      )
      .all();
    const decodedPlans = plans.map(decodePlanRow);
    expect(decodedPlans.map((row) => [row.plan_id, row.action_kind, row.state, row.created_at, row.expires_at])).toEqual([
      ["plan:completed", "markSeen", "completed", createdAt, expiresAt],
      ["plan:expired", "markSeen", "expired", createdAt, expiresAt],
      ["plan:failed", "markSeen", "failed", createdAt, expiresAt],
      ["plan:partial", "markSeen", "partial", createdAt, expiresAt],
      ["plan:pending", "markSeen", "pending", createdAt, expiresAt],
      ["plan:rejected", "markSeen", "rejected", createdAt, expiresAt],
      ["plan:results", "markSeen", "executing", createdAt, expiresAt],
      ["plan:uncertain", "markSeen", "uncertain", createdAt, expiresAt],
    ]);
    expect(decodedPlans.map((row) => row.state)).toEqual([
      "completed",
      "expired",
      "failed",
      "partial",
      "pending",
      "rejected",
      "executing",
      "uncertain",
    ]);

    const results: unknown[] = opened.db
      .query(
        "SELECT attempt_id, plan_id, target_ordinal, result_kind, certainty, started_at, result_at " +
          "FROM action_results ORDER BY target_ordinal;",
      )
      .all();
    expect(results.map(decodeResultRow).map((row) => [row.result_kind, row.certainty])).toEqual([
      ["success", "definite"],
      ["stale", "definite"],
      ["rejected", "definite"],
      ["failed", "definite"],
      ["uncertain", "uncertain"],
    ]);
    expect(opened.db.query("SELECT uncertain_attempt_id FROM action_plans WHERE state = 'uncertain';").get()).toEqual({
      uncertain_attempt_id: "attempt:fixture",
    });
    expect(opened.db.query("PRAGMA foreign_key_check;").all()).toEqual([]);
    await opened.close();
  });

  test("rejects missing claim, missing uncertainty attempt, and orphan target at SQLite", async () => {
    const opened = await openActionDatabase();

    expect(() => insertPlan(opened.db, "plan:executing-without-claim", "executing")).toThrow();
    expect(() => insertPlan(opened.db, "plan:uncertain-without-attempt", "uncertain")).toThrow();
    expect(() => insertTarget(opened.db, "plan:orphan", 1)).toThrow();

    await opened.close();
  });

  test("rejects terminal-to-pending transitions and preserves immutable identities", async () => {
    const opened = await openActionDatabase();
    insertPlan(opened.db, "plan:terminal", "completed");
    expect(() =>
      opened.db
        .query(
          "UPDATE action_plans SET state = 'pending', completed_at = NULL WHERE plan_id = 'plan:terminal';",
        )
        .run(),
    ).toThrow();
    expect(() =>
      opened.db
        .query("UPDATE action_plans SET plan_id = 'plan:changed' WHERE plan_id = 'plan:terminal';")
        .run(),
    ).toThrow();

    executingPlan(opened.db, "plan:immutable", 1);
    expect(() =>
      opened.db
        .query(
          "UPDATE action_plan_targets SET uid = 99 WHERE plan_id = 'plan:immutable' AND target_ordinal = 1;",
        )
        .run(),
    ).toThrow();
    insertAttempt(opened.db, "plan:immutable", 1, "attempt:immutable");
    expect(() =>
      opened.db
        .query("UPDATE action_attempts SET idempotency_key = 'changed' WHERE attempt_id = 'attempt:immutable';")
        .run(),
    ).toThrow();
    await opened.close();
  });

  test("keeps uncertain and definite result identities distinct and rejects orphan results", async () => {
    const opened = await openActionDatabase();
    executingPlan(opened.db, "plan:result-integrity", 1);
    insertAttempt(opened.db, "plan:result-integrity", 1, "attempt:uncertain");
    insertResult(opened.db, "plan:result-integrity", 1, "attempt:uncertain", "uncertain");
    expect(() =>
      insertResult(opened.db, "plan:result-integrity", 1, "attempt:missing", "success"),
    ).toThrow();
    expect(() =>
      opened.db
        .query(
          "INSERT INTO action_results " +
            "(attempt_id, plan_id, target_ordinal, account_id, mailbox_id, uid_validity, uid, idempotency_key, " +
            "started_at, result_at, result_kind, certainty, detail) " +
            "VALUES ('attempt:uncertain', 'plan:result-integrity', 1, 'account:fixture', 'mailbox:fixture-1', 7, 1, 'idempotency:1', ?, ?, 'uncertain', 'definite', 'wrong certainty');",
        )
        .run(startedAt, resultAt),
    ).toThrow();
    await opened.close();
  });
});
