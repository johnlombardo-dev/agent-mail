import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import model from "../../../../docs/architecture/sync-statechart.model.json" with { type: "json" };

const invokedActors = (stateId: string): readonly string[] => {
  const state = model.states.find((candidate) => candidate.id === stateId);
  if (state === undefined || !("invokedActors" in state)) return [];
  return state.invokedActors ?? [];
};

const pathForState = (stateId: string): readonly string[] => {
  const path = model.coverage.generatedStatePaths.find((candidate) => candidate.state === stateId);
  if (path === undefined) throw new Error(`missing generated path for ${stateId}`);
  return path.transitionIds;
};

const traces = model.transitions.flatMap((transition) => {
  const sources = Array.isArray(transition.source) ? transition.source : [transition.source];
  return sources.map((source) => {
    const target = transition.target;
    return {
      id: `${transition.id}:${source}`,
      transitionId: transition.id,
      source,
      event: transition.event,
      target,
      stoppedActors: transition.stoppedActors,
      startedActors: transition.startedActors,
      ownershipBefore: invokedActors(source),
      ownershipAfter: target === null ? invokedActors(source) : invokedActors(target),
      pathTransitionIds: source === "@uninitialized" ? ["T001"] : pathForState(source),
      outcomeKinds: ["cancelled", "late", "duplicate"],
    } as const;
  });
});

const output = {
  format: "agent-mail.sync-runtime-conformance-traces/v1",
  modelVersion: model.modelVersion,
  modelDigest: "3c26fe8132871e2f2295ca805161e17571c93d99a74aad0161117c38eb979f91",
  generator: "packages/daemon/test/fixtures/generate-sync-runtime-conformance-traces.ts",
  boundedPropertySeeds: [149, 148, 209, 196, 189, 132, 129, 136],
  resourceObservationGaps: [
    {
      state: "starting.active",
      fields: ["actorOutput"],
      reason: "The default bootstrap actor is the accepted never-settling placeholder; the concrete production-composed lane supplies the real bootstrap result and cleanup behavior.",
    },
    {
      state: "backfilling.active",
      fields: ["actorOutput", "nestedChildren"],
      reason: "The default initial-backfill actor is the accepted never-settling placeholder; the concrete production-composed lane supplies the real SQLite loop, while the separate raw-download probe supplies nested queue/job ownership.",
    },
    {
      state: "watching.idling",
      fields: ["timers", "listeners", "streams", "subscriptions"],
      reason: "The default lifecycle actor map intentionally retains inert callback placeholders; the concrete production-composed IDLE probe supplies exact counts.",
    },
    {
      state: "watching.polling",
      fields: ["timers", "listeners", "streams", "subscriptions"],
      reason: "The default lifecycle actor map intentionally retains an inert callback placeholder; the concrete production-composed polling probe supplies exact counts.",
    },
    {
      state: "sweeping.active",
      fields: ["actorOutput", "nestedChildren"],
      reason: "The default recurring-sweep actor is the accepted never-settling placeholder; the concrete production-composed lane supplies the real SQLite sweep, while the separate raw-download probe supplies nested queue/job ownership.",
    },
  ],
  durableObservationGaps: [
    {
      transitionIds: ["T110", "T116", "T117", "T118", "T150", "T156"],
      fields: ["mailboxCheckpoint", "initialBackfillCompletion"],
      reason: "The generated row lane exercises reserved actor-result routing against the default never-settling backfill/sweep placeholders; concrete production-composed loops own the SQLite writes and are checked separately.",
    },
  ],
  counterexamples: [
    {
      id: "CE-POLL-TIMER-LEAK",
      events: ["control.start.requested", "watchTimer.elapsed", "control.stop.requested", "xstate.done.actor.cleanupBarrier", "leak.virtualTimer"],
      expectedFailure: "terminal audit retains a live timer",
    },
    {
      id: "CE-LATE-DOWNLOAD-COMPLETION",
      events: ["control.start.requested", "control.stop.requested", "xstate.done.actor.initialBackfill"],
      expectedFailure: "late completion is ignored and durable summary is unchanged",
    },
  ],
  traces,
} as const;

await writeFile(
  join(process.cwd(), "packages/daemon/test/fixtures/sync-runtime-conformance-traces.json"),
  `${JSON.stringify(output, null, 2)}\n`,
  "utf8",
);
