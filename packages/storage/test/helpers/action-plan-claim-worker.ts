import { Database } from "bun:sqlite";
import { claimPendingActionPlan } from "../../src/action-plan-claim";

const [databasePath, claimId, startedAt, now, digest, authorizationScope, expectedVersion] =
  process.argv.slice(2);
if (
  databasePath === undefined ||
  claimId === undefined ||
  startedAt === undefined ||
  now === undefined ||
  digest === undefined ||
  authorizationScope === undefined ||
  expectedVersion === undefined
) {
  throw new TypeError("claim worker arguments are incomplete");
}

const database = new Database(databasePath, { strict: true });
try {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const result = claimPendingActionPlan(database, {
    planId: "plan:race",
    claimId,
    startedAt,
    now,
    digest,
    authorizationScope,
    expectedVersion: Number(expectedVersion),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  database.close();
}
