# Sync lifecycle statechart

Status: candidate `1.0.0-candidate.1` for P3-C15 independent review. No production implementation is authorized by this artifact.

The normative oracle is [`sync-statechart.model.json`](sync-statechart.model.json). This document explains that model. State, event, guard, action, actor, transition, projection, invariant, and coverage identifiers in prose refer to the JSON; where prose and JSON differ, the JSON blocks implementation until the two are reconciled and reviewed. The final checked digest appears in the coverage ledger.

## Frozen boundary

The candidate is designed against the accepted planning hashes and implementations recorded in the model:

- `PLAN.md` at `a4b2c93d9ae47369e6893be0a7eace854fce9dccda14bd0d138d9c98b63a2afc`.
- `docs/planning/EVIDENCE.md` at `544c1ee220e13b96dc88aa71096701a3887fb1adba22e9b8d60a244533f50cc9`.
- P1-C08 status/control schemas at commit `13e0360`.
- P3-C10 initial backfill at commit `b6d07bc`.
- P3-C11 recurring sweep at commit `d510747`.

This design changes no public schema, durable repository, adapter, route, CLI command, or production workflow source.

## One lifecycle truth

The active XState atomic configuration is the only lifecycle mode. Context does not carry a second `mode`, `paused`, `watching`, `retrying`, `failed`, or `stopped` flag. Public status is a pure projection of the atomic configuration plus validated context.

```text
syncLifecycle
├── stopped
│   ├── clean
│   └── failed
├── starting
│   ├── active
│   └── pausing
├── backfilling
│   ├── active
│   └── pausing
├── watching
│   ├── idling
│   ├── polling
│   ├── closingForSweep
│   ├── closingForRetry
│   ├── closingForAuthBlock
│   ├── closingForPause
│   └── closingForFailure
├── sweeping
│   ├── active
│   └── pausing
├── retryWaiting
│   ├── active
│   └── pausing
├── authBlocked
├── paused
└── stopping
    ├── forStop
    ├── forRestart
    └── afterFailure
```

All 22 atomic nodes are reachable. `stopped.failed` is the required internal failure state. It projects the accepted public `stopped` state with at least one bounded diagnostic, so the design does not add an unaccepted tenth public enum member. Internal `retryWaiting` projects public `retrying`. The closing and pausing substates remain inside their truthful public parent until cleanup releases the work being reported.

The adjacent counterexample is structurally impossible: `paused` invokes no actor, and every incoming asynchronous pause path requires `cleanupReleasedScope`. A snapshot cannot be `paused` while IDLE, the periodic timer, a download, a sweep, or the cleanup job remains live.

## State and effect ownership

| Atomic configuration | Work that is active | Exact invoked actors | Public state / operation |
|---|---|---|---|
| `stopped.clean` | None | None | `stopped` / `null` |
| `stopped.failed` | None; failure is retained as diagnostics | None | `stopped` / `null` |
| `starting.active` | Validating and selecting the next bounded sync step | `bootstrapSession` | `starting` / `start` |
| `starting.pausing` | Awaiting release of startup resources | `cleanupBarrier(workflow)` | `starting` / `start` |
| `backfilling.active` | Running the bounded initial-backfill loop | `initialBackfill` | `backfilling` / `backfill` |
| `backfilling.pausing` | Awaiting release of backfill resources | `cleanupBarrier(workflow)` | `backfilling` / `backfill` |
| `watching.idling` | One IDLE subscription and one bounded periodic trigger | `idleSession`, `periodicStatusTimer` | `watching` / `watch` |
| `watching.polling` | One bounded periodic trigger when usable IDLE is unavailable | `periodicStatusTimer` | `watching` / `watch` |
| `watching.closingForSweep` | Closing watch resources before one sweep | `cleanupBarrier(watch)` | `watching` / `watch` |
| `watching.closingForRetry` | Closing all workflow resources before retry | `cleanupBarrier(workflow)` | `watching` / `watch` |
| `watching.closingForAuthBlock` | Closing all workflow resources before auth block | `cleanupBarrier(workflow)` | `watching` / `watch` |
| `watching.closingForPause` | Closing all workflow resources before pause | `cleanupBarrier(workflow)` | `watching` / `watch` |
| `watching.closingForFailure` | Closing all workflow resources before failure | `cleanupBarrier(workflow)` | `watching` / `watch` |
| `sweeping.active` | Running one bounded recurring sweep | `recurringSweep` | `sweeping` / `sweep` |
| `sweeping.pausing` | Awaiting release of sweep resources | `cleanupBarrier(workflow)` | `sweeping` / `sweep` |
| `retryWaiting.active` | Waiting on one capped, jittered delay | `retryTimer` | `retrying` / `retry` |
| `retryWaiting.pausing` | Awaiting removal of retry resources | `cleanupBarrier(workflow)` | `retrying` / `retry` |
| `authBlocked` | None | None | `authBlocked` / `null` |
| `paused` | None | None | `paused` / `null` |
| `stopping.forStop` | Awaiting the shared workflow cleanup job | `cleanupBarrier(workflow)` | `stopping` / `stop` |
| `stopping.forRestart` | Awaiting the same job before fresh startup | `cleanupBarrier(workflow)` | `stopping` / `stop` |
| `stopping.afterFailure` | Awaiting the same job before terminal failure | `cleanupBarrier(workflow)` | `stopping` / `stop` |

The table lists direct lifecycle children. `initialBackfill` and `recurringSweep` may each own one nested `rawDownloadQueue`, and that accepted queue machine owns at most one active `rawDownloadJob`. Those bounded parents are mutually exclusive and cannot emit a terminal result until `queue.stop()` has rejected queued work and awaited the active adapter response/stage cleanup. No other state may own either nested actor.

## Actor protocols

Bounded one-result work uses XState v5 `fromPromise`: `bootstrapSession`, `initialBackfill`, `recurringSweep`, `cleanupBarrier`, and the accepted queue's nested `rawDownloadJob`. Each receives an abort signal. A success or error is terminal only after the actor has released its own resources. Leaving an active state aborts its actor; a subsequent quiescing state invokes the one cleanup barrier and awaits the resource registry.

Ongoing or multi-event protocols use `fromCallback`: `idleSession`, `periodicStatusTimer`, and `retryTimer`. The IDLE actor emits ready, mailbox-change, normal-completion, and typed-failure events. The timer actors own one timer apiece and remove the exact timer/listener before emitting a terminal message. Every callback event carries the immutable `scopeEpoch` received at actor creation. Validated capability selection is structural: `watching.idling` owns IDLE plus the maximum-interval timer, while `watching.polling` owns only that timer and never pretends an IDLE session exists.
The in-process `controlWaiter` is also a callback/subscription protocol. It is outside the lifecycle child graph and cannot mutate the chart. It owns one command's snapshot subscription and deadline, then removes both on accepted, completed, rejected, failed, cancelled, or timeout settlement.

### Actor outcome and cleanup table

| Actor | Success or normal completion | Error | Cancellation and timeout | Retry/timer/cleanup owner |
|---|---|---|---|---|
| `bootstrapSession` | Selects `backfill`, IDLE watch, or polling watch once | Typed auth, transient, permanent, or invariant `WorkflowFault` | State exit aborts; barrier awaits registered release | Chart owns retry; no timer inside actor |
| `initialBackfill` | `completed` or `already-complete` with committed facts | Same typed fault categories | Exit aborts; late `cancelled` result is ignored | Chart owns retry; repository owns durable commit |
| `idleSession` | `idle.ready`, change, or normal completion after listener/socket release | Typed `idle.failed` after release | Disposer cancels IDLE and registers close; watch/workflow barrier awaits it | Chart chooses sweep, retry, auth block, or failure |
| `periodicStatusTimer` | One `watchTimer.elapsed` after clearing timer | Typed non-auth timer failure | Disposer clears exact timer/listener | Actor owns its one timer in idling or polling |
| `recurringSweep` | `completed` or `not-eligible` with committed progress | Same typed fault categories | Exit aborts; late `cancelled` is ignored | Chart owns retry; repository owns durable commit |
| `retryTimer` | One `retryTimer.elapsed` after clearing timer | Timer failure is an invariant fault | Disposer clears exact timer/listener | Actor owns its one timer; chart owns attempt history |
| `cleanupBarrier` | `released=true` only after a zero-resource audit | May reject with an invariant fault only after the same zero-resource audit | Replacement invocation awaits the memoized job; unreleased work keeps it pending | Sole awaited, idempotent cleanup owner |
| `controlWaiter` | Compatible observed state/version | Workflow failure is non-success | Supersession and deadline are non-success; always unsubscribe/clear timer | Control service only; never lifecycle authority |
| `rawDownloadQueue` | Serial FIFO job results with typed overflow | A job failure rejects that job under the accepted queue machine | Parent awaits `queue.stop()`; queued jobs reject and active close completes first | One instance nested under backfill or sweep |
| `rawDownloadJob` | One raw download result after response/stage settle | Typed download/cancellation error after listener removal | Queue aborts and awaits the job before stopped | Queue owns at most one active job |

## Durable restart facts

XState snapshots are not persisted or hydrated. The following are distinct:

- Durable repository facts: mailbox checkpoints, the initial-backfill completion record, and recurring-sweep completion/cursor facts.
- Ephemeral actor facts: active state, `incarnationId`, `version`, `scopeEpoch`, `idleReadyEpoch`, retry attempt, safe diagnostics, and current child identities.
- Cached status data: the validated checkpoint summary copied only from an actor result that reports its transaction committed.

A reconstructed actor begins at `stopped.clean` with no children. An explicit start runs `bootstrapSession`, which reads durable facts and selects backfill, IDLE watch, or polling watch. `backfillCompleted=true` is evidence that the initial pass finished, not a terminal sync mode and not a reason to reject future sweeps. A live-process restart always enters `stopping.forRestart`, awaits the same cleanup barrier, and starts a fresh scope. Old actor identities and scope epochs cannot write into the new incarnation.

The daemon's auto-start-on-process-boot policy remains outside this chart's authority. The chart neither silently auto-starts nor persists pause. A daemon bootstrap owner must send an explicit start event if product policy requires automatic sync.

## Fault and retry policy

Every adapter boundary produces the constructive safe `WorkflowFault` union. Authentication goes to `authBlocked` and never creates a retry timer. Transient faults increment ephemeral attempt history and enter `retryWaiting.active` only while `maxRetryAttempts` permits. Permanent faults, invariant faults, and exhausted attempts traverse failure cleanup and reach `stopped.failed`.

`credentials.changed` is admitted only from stable `authBlocked`. A revision delivered during active work or auth cleanup is ignored, because no accepted credential-repair contract owns a revision latch or authorizes restarting healthy work. The credential owner must emit after observing `authBlocked`, or a supervisor must explicitly restart. D23 marks this conservative race policy for consequential review.

Retry delay calculation is outside the lifecycle chart but is a required input contract: positive base and cap, `cap >= base`, jitter ratio in `[0,1]`, a positive maximum attempt count, and an injected deterministic random source. The periodic status interval is also required and cannot exceed 900,000 ms. Committed backfill/sweep progress or `idle.ready` resets retry history; bootstrap alone does not, so a repeatedly failing downstream step cannot gain an unbounded fresh budget.

## Event ordering and cancellation

XState mailbox order is authoritative. Actor-originated callback events carry `scopeEpoch`; promise completion/error events retain XState invoke identity. The model defines these cases explicitly:

- In `watching.idling`, the first eligible IDLE or timer event moves into one closing state. In `watching.polling`, the timer does so alone. A reordered second event finds no matching owner transition and is ignored.
- A duplicate or stale callback event does not change state, context, version, durable facts, or child ownership. `idle.ready`, the only nonterminal callback message that leaves its actor active, is admitted once per `scopeEpoch` through `idleReadyUnseenForScope`; `idleReadyEpoch` is deduplication metadata, not lifecycle mode.
- A late promise result from an exited invoke cannot run `adoptCommittedCheckpoint`.
- Unknown events are rejected at the typed boundary before `actor.send`.
- Repeated stop, restart, and shutdown requests delivered while cleanup is active join or redirect the single cleanup disposition. They never create a second cleanup job. A supervisor delivery after cleanup completed is a new edge-triggered intent; its `requestId` is correlation data, not a durable idempotency key. D24 marks that boundary for consequential review.

The barrier's first request starts one memoized cleanup job. Later invocations await that job. `watch` scope is narrower than `workflow`; a concurrent broader request atomically promotes the same in-flight job to the union of requested resources, and a narrower request never downgrades it. The barrier cancels the selected owners, waits for each close acknowledgement, and aggregates only bounded safe diagnostics. If a resource has not released, the promise remains pending and the public control may time out; the chart cannot report paused, stopped, failed, or restarted early.

## Public status and controls

Every status response is derived from the state table, `context.version`, the committed checkpoint projection, the constructive auth detail, and bounded diagnostics. There is no adapter-local status flag.

The control service sends typed events and observes the owning actor. It atomically receives the machine's accept/reject decision, then resolves only from a compatible snapshot in the same `incarnationId`:

| Command | Accepted observation | Completed observation | Non-success cases |
|---|---|---|---|
| Start | `starting`, `backfilling`, `sweeping`, or `retrying` | `watching` | Incompatible/busy state, stale expected version, failure, cancellation, timeout |
| Pause | None returned before stable completion | `paused` | Same non-success cases; cleanup timeout never fabricates pause |
| Resume | `starting` | `backfilling`, `watching`, `sweeping`, or `retrying` | Same non-success cases |
| Stop | None returned before stable completion | `stopped` | Same non-success cases; `stopping` is observable status but not successful stop completion |

Pause, resume, and stop idempotency is owned by the control service. The same key and command joins the same waiter/result. Reusing a key for another command shape is rejected without sending a second lifecycle event. The internal protocol may supply `expectedVersion`; the accepted public request schemas do not expose it, so adding that field publicly requires a separate contract revision.

## Transition oracle

The JSON `transitions` array is the complete transition table. Each row freezes source configuration, event, ordered guards, target, actions, actors stopped and started, durable writes observed at the edge, and public observation. Array-valued sources expand into one row per named atomic configuration. The generated checked view is retained in [`sync-statechart.coverage.md`](sync-statechart.coverage.md).

The JSON `globalEventPolicy` is also normative. It covers rejected controls, stale/late/duplicate/reordered actor events, credential changes outside `authBlocked`, and unknown input. Those rules deliberately do not advance the observed version or adopt durable output.

## Integration ratchet

Implementation must export inspection metadata and generated tests from this exact model vocabulary. A change to any state, event, context field, guard, transition, action, actor, timer, cleanup rule, restart rule, public projection, or coverage obligation changes the model digest and reopens independent review. Runtime conformance and production wiring remain owned by P3-C15-IMPLEMENT and P3-C24.
