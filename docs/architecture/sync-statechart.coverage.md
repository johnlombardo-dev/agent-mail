# Sync statechart coverage ledger

Status: candidate `1.0.0-candidate.1`. Normative obligations live in `sync-statechart.model.json`, SHA-256 `6a4643bb1ec47ec823657c16581cc757ffa30f49ac49abf9cc866f9d9c07abad`; this is the checked human view and evidence index.

## Inventory baseline

| Item | Count | Completeness rule |
|---|---:|---|
| Reachable atomic configurations | 22 | Every atomic node has a shortest generated path, exact actor multiset, and exact public projection. |
| Transition definitions | 78 | Every definition has source, event, ordered guards, target, actions, actor delta, durable writes, and observation. |
| Expanded source-specific transitions | 167 | Array-valued sources expand into separately exercised transitions. |
| Typed events | 24 | Every event has a transition or an explicit global ignore/reject policy. |
| Guards | 20 | Every guard has true and false coverage; ordered alternatives are covered independently. |
| Actions | 14 | Every action is reachable and checked for its declared context/public side effect. |
| Actors | 10 | Seven direct workflow actors, two nested queue/job actors, and the observing control waiter have success/error/cancel/cleanup coverage. |
| Invariants | 17 | Every generated step checks the applicable invariants. |
| Forbidden configurations | 11 | Every configuration has a property that attempts to construct it. |
| Generated properties | 9 | Every property has a precise state, ordering, ownership, or boundary postcondition. |

`@source` in the actor-stop column expands to the exact `invokedActors` on that source state. Array-valued source cells list every source configuration; the generator expands them one by one.

## Complete transition table

| ID | Source configuration | Event | Guards, in priority order | Target | Actions | Stop → start actors | Durable writes observed | Public observation |
|---|---|---|---|---|---|---|---|---|
| T001 | @uninitialized | xstate.init | — | stopped.clean | — | — → — | — | Initial status is stopped at version zero with no live child. |
| T010 | stopped.clean<br>stopped.failed | control.start.requested | expectedVersionMatches | starting.active | clearAuthBlock<br>beginEffectScope<br>advanceVersion<br>emitControlAccepted | — → bootstrapSession | — | Accepted start observes starting and the new version. |
| T011 | starting.active<br>backfilling.active<br>sweeping.active<br>retryWaiting.active | control.start.requested | expectedVersionMatches | — | emitControlAccepted | — → — | — | Idempotent start is accepted at the unchanged compatible state/version. |
| T012 | watching.idling<br>watching.polling | control.start.requested | expectedVersionMatches | — | emitControlCompleted | — → — | — | Idempotent start completes at watching and the unchanged version. |
| T020 | starting.active | control.pause.requested | expectedVersionMatches | starting.pausing | advanceVersion<br>emitControlPending | bootstrapSession → cleanupBarrier | — | The public state remains starting until cleanup reaches paused; the pause waiter remains pending. |
| T021 | backfilling.active | control.pause.requested | expectedVersionMatches | backfilling.pausing | advanceVersion<br>emitControlPending | initialBackfill → cleanupBarrier | — | Backfill remains the reported active operation until its resources close. |
| T022 | watching.idling<br>watching.polling | control.pause.requested | expectedVersionMatches | watching.closingForPause | advanceVersion<br>emitControlPending | @source → cleanupBarrier | — | Watching remains reported while the awaited barrier closes IDLE and its timer. |
| T023 | sweeping.active | control.pause.requested | expectedVersionMatches | sweeping.pausing | advanceVersion<br>emitControlPending | recurringSweep → cleanupBarrier | — | Sweep cancellation is awaited before paused can be observed. |
| T024 | retryWaiting.active | control.pause.requested | expectedVersionMatches | retryWaiting.pausing | advanceVersion<br>emitControlPending | retryTimer → cleanupBarrier | — | Retrying remains reported until the timer has been removed and paused is reached. |
| T025 | watching.closingForSweep<br>watching.closingForRetry<br>watching.closingForFailure | control.pause.requested | expectedVersionMatches | watching.closingForPause | advanceVersion<br>emitControlPending | cleanupBarrier → cleanupBarrier | — | The target intent changes to pause; the replacement invocation awaits the same cleanup job. |
| T029 | watching.closingForAuthBlock | control.pause.requested | expectedVersionMatches | watching.closingForPause | clearAuthBlock<br>advanceVersion<br>emitControlPending | cleanupBarrier → cleanupBarrier | — | Explicit pause supersedes the pending auth block, clears its detail, and promotes the same cleanup job to workflow scope. |
| T026 | starting.pausing<br>backfilling.pausing<br>watching.closingForPause<br>sweeping.pausing<br>retryWaiting.pausing | control.pause.requested | expectedVersionMatches | — | emitControlPending | — → — | — | Duplicate pause joins the same target predicate and cleanup result. |
| T027 | authBlocked | control.pause.requested | expectedVersionMatches | paused | clearAuthBlock<br>advanceVersion<br>emitControlPending | — → — | — | An explicit pause replaces the non-running auth block with the stable paused mode. |
| T028 | paused | control.pause.requested | expectedVersionMatches | — | emitControlCompleted | — → — | — | Idempotent pause completes at the unchanged paused version. |
| T030 | paused | control.resume.requested | expectedVersionMatches | starting.active | beginEffectScope<br>advanceVersion<br>emitControlAccepted | — → bootstrapSession | — | Resume is accepted only after starting is observed at the new version. |
| T031 | starting.active | control.resume.requested | expectedVersionMatches | — | emitControlAccepted | — → — | — | Idempotent resume is accepted at the unchanged starting version. |
| T032 | backfilling.active<br>watching.idling<br>watching.polling<br>sweeping.active<br>retryWaiting.active | control.resume.requested | expectedVersionMatches | — | emitControlCompleted | — → — | — | Idempotent resume completes at the unchanged compatible running version. |
| T040 | stopped.clean<br>stopped.failed | control.stop.requested | expectedVersionMatches | — | emitControlCompleted | — → — | — | Idempotent stop completes at the unchanged stopped version. |
| T041 | stopping.forStop | control.stop.requested | expectedVersionMatches | — | emitControlPending | — → — | — | Duplicate stop joins the same cleanup and waits for stopped; it cannot fabricate completion. |
| T042 | stopping.forRestart<br>stopping.afterFailure | control.stop.requested | expectedVersionMatches | stopping.forStop | advanceVersion<br>emitControlPending | cleanupBarrier → cleanupBarrier | — | Stop wins over restart/failure disposition and awaits the same cleanup job. |
| T043 | starting.active<br>starting.pausing<br>backfilling.active<br>backfilling.pausing<br>watching.idling<br>watching.polling<br>watching.closingForSweep<br>watching.closingForRetry<br>watching.closingForAuthBlock<br>watching.closingForPause<br>watching.closingForFailure<br>sweeping.active<br>sweeping.pausing<br>retryWaiting.active<br>retryWaiting.pausing<br>authBlocked<br>paused | control.stop.requested | expectedVersionMatches | stopping.forStop | clearAuthBlock<br>advanceVersion<br>emitControlPending | @source → cleanupBarrier | — | Stopping is observed immediately, but completed stop is withheld until cleanup reaches stopped. |
| T050 | stopped.clean<br>stopped.failed<br>starting.active<br>starting.pausing<br>backfilling.active<br>backfilling.pausing<br>watching.idling<br>watching.polling<br>watching.closingForSweep<br>watching.closingForRetry<br>watching.closingForAuthBlock<br>watching.closingForPause<br>watching.closingForFailure<br>sweeping.active<br>sweeping.pausing<br>retryWaiting.active<br>retryWaiting.pausing<br>authBlocked<br>paused | lifecycle.restart.requested | — | stopping.forRestart | clearAuthBlock<br>advanceVersion | @source → cleanupBarrier | — | Every live-process restart first observes stopping and awaits the shared workflow cleanup barrier. |
| T051 | stopping.forStop<br>stopping.afterFailure | lifecycle.restart.requested | — | stopping.forRestart | advanceVersion | cleanupBarrier → cleanupBarrier | — | Restart changes only the post-cleanup destination and reuses the one in-flight cleanup job. |
| T052 | stopping.forRestart | lifecycle.restart.requested | — | — | — | — → — | — | Duplicate restart is ignored and leaves the cleanup job and version unchanged. |
| T053 | starting.active<br>starting.pausing<br>backfilling.active<br>backfilling.pausing<br>watching.idling<br>watching.polling<br>watching.closingForSweep<br>watching.closingForRetry<br>watching.closingForAuthBlock<br>watching.closingForPause<br>watching.closingForFailure<br>sweeping.active<br>sweeping.pausing<br>retryWaiting.active<br>retryWaiting.pausing<br>authBlocked<br>paused<br>stopping.forRestart<br>stopping.afterFailure | process.shutdown.requested | — | stopping.forStop | clearAuthBlock<br>advanceVersion | @source → cleanupBarrier | — | All shutdown triggers converge on the same stop cleanup disposition. |
| T054 | stopped.clean<br>stopped.failed<br>stopping.forStop | process.shutdown.requested | — | — | — | — → — | — | Duplicate shutdown is an unchanged no-op. |
| T060 | authBlocked | credentials.changed | — | starting.active | clearAuthBlock<br>beginEffectScope<br>advanceVersion | — → bootstrapSession | — | Only an observed credential revision or explicit stop/pause leaves authBlocked automatically. |
| T100 | starting.active | xstate.done.actor.bootstrapSession | bootstrapNeedsBackfill | backfilling.active | adoptCommittedCheckpoint<br>beginEffectScope<br>advanceVersion | bootstrapSession → initialBackfill | — | Committed restart facts select bounded backfill; no snapshot mode is restored. |
| T101 | starting.active | xstate.done.actor.bootstrapSession | bootstrapUsesIdle | watching.idling | adoptCommittedCheckpoint<br>beginEffectScope<br>advanceVersion | bootstrapSession → idleSession, periodicStatusTimer | — | An IDLE-capable provider enters truthful idling with one IDLE actor and one timer. |
| T106 | starting.active | xstate.done.actor.bootstrapSession | bootstrapUsesPolling | watching.polling | adoptCommittedCheckpoint<br>beginEffectScope<br>advanceVersion | bootstrapSession → periodicStatusTimer | — | A provider without usable IDLE enters truthful polling with one timer and no nominal IDLE actor. |
| T102 | starting.active | xstate.error.actor.bootstrapSession | faultIsAuthentication | authBlocked | recordAuthBlock<br>advanceVersion | bootstrapSession → — | — | Authentication failure bypasses retry and exposes safe authBlocked detail. |
| T103 | starting.active | xstate.error.actor.bootstrapSession | faultIsTransient<br>retryBudgetAvailable | retryWaiting.active | recordTransientFault<br>beginEffectScope<br>advanceVersion | bootstrapSession → retryTimer | — | One bounded retry timer owns the delay. |
| T104 | starting.active | xstate.error.actor.bootstrapSession | faultIsTransient<br>retryBudgetExhausted | stopping.afterFailure | recordFatalFault<br>advanceVersion | bootstrapSession → cleanupBarrier | — | Exhausted retry budget enters awaited failure cleanup. |
| T105 | starting.active | xstate.error.actor.bootstrapSession | faultIsFatal | stopping.afterFailure | recordFatalFault<br>advanceVersion | bootstrapSession → cleanupBarrier | — | Permanent or invariant bootstrap failure is cleaned before stopped.failed. |
| T110 | backfilling.active | xstate.done.actor.initialBackfill | backfillCompletedNow<br>actorResultUsesIdle | watching.idling | adoptCommittedCheckpoint<br>resetRetryHistory<br>beginEffectScope<br>advanceVersion | initialBackfill → idleSession, periodicStatusTimer | mailboxCheckpoint.backfillCompleted<br>initialBackfillCompletion.nextSweepEligibleAt | Initial completion is observed without disabling recurring sweeps. |
| T116 | backfilling.active | xstate.done.actor.initialBackfill | backfillCompletedNow<br>actorResultUsesPolling | watching.polling | adoptCommittedCheckpoint<br>resetRetryHistory<br>beginEffectScope<br>advanceVersion | initialBackfill → periodicStatusTimer | mailboxCheckpoint.backfillCompleted<br>initialBackfillCompletion.nextSweepEligibleAt | Initial completion remains recurring-sweep eligible when the validated watch strategy is polling. |
| T117 | backfilling.active | xstate.done.actor.initialBackfill | backfillAlreadyComplete<br>actorResultUsesIdle | watching.idling | adoptCommittedCheckpoint<br>resetRetryHistory<br>beginEffectScope<br>advanceVersion | initialBackfill → idleSession, periodicStatusTimer | — | A previously committed initial completion enters IDLE watch without claiming a new durable write. |
| T118 | backfilling.active | xstate.done.actor.initialBackfill | backfillAlreadyComplete<br>actorResultUsesPolling | watching.polling | adoptCommittedCheckpoint<br>resetRetryHistory<br>beginEffectScope<br>advanceVersion | initialBackfill → periodicStatusTimer | — | A previously committed initial completion enters polling without claiming a new durable write. |
| T111 | backfilling.active | xstate.done.actor.initialBackfill | backfillReturnedUnexpectedCancellation | stopping.afterFailure | recordFatalFault<br>advanceVersion | initialBackfill → cleanupBarrier | — | A cancellation outcome while the invoke is still active is an invariant failure, not false success. |
| T112 | backfilling.active | xstate.error.actor.initialBackfill | faultIsAuthentication | authBlocked | recordAuthBlock<br>advanceVersion | initialBackfill → — | — | Backfill authentication rejection cannot enter retry. |
| T113 | backfilling.active | xstate.error.actor.initialBackfill | faultIsTransient<br>retryBudgetAvailable | retryWaiting.active | recordTransientFault<br>beginEffectScope<br>advanceVersion | initialBackfill → retryTimer | — | Transient backfill failure schedules exactly one bounded retry timer. |
| T114 | backfilling.active | xstate.error.actor.initialBackfill | faultIsTransient<br>retryBudgetExhausted | stopping.afterFailure | recordFatalFault<br>advanceVersion | initialBackfill → cleanupBarrier | — | Backfill retry exhaustion is a cleaned terminal failure. |
| T115 | backfilling.active | xstate.error.actor.initialBackfill | faultIsFatal | stopping.afterFailure | recordFatalFault<br>advanceVersion | initialBackfill → cleanupBarrier | — | Fatal backfill failure cannot leave the chart nominally backfilling. |
| T120 | watching.idling | idle.ready | scopeIsCurrent<br>idleReadyUnseenForScope | — | resetRetryHistory<br>markIdleReadyObserved<br>advanceVersion | — → — | — | IDLE readiness resets retry history and advances the observed version without inventing a second mode. |
| T121 | watching.idling | idle.mailboxChanged | scopeIsCurrent | watching.closingForSweep | advanceVersion | @source → cleanupBarrier | — | Mailbox notification closes both watch actors before sweep starts. |
| T122 | watching.idling<br>watching.polling | watchTimer.elapsed | scopeIsCurrent | watching.closingForSweep | advanceVersion | @source → cleanupBarrier | — | The bounded periodic trigger closes IDLE and its timer before sweep. |
| T123 | watching.idling | idle.completed | scopeIsCurrent<br>retryBudgetAvailable | watching.closingForRetry | recordTransientFault<br>advanceVersion | idleSession, periodicStatusTimer → cleanupBarrier | — | Normal IDLE completion explicitly leaves watching.idling and restarts under retry policy. |
| T124 | watching.idling | idle.completed | scopeIsCurrent<br>retryBudgetExhausted | watching.closingForFailure | recordFatalFault<br>advanceVersion | idleSession, periodicStatusTimer → cleanupBarrier | — | Repeated normal IDLE completion cannot livelock forever. |
| T125 | watching.idling | idle.failed | scopeIsCurrent<br>faultIsAuthentication | watching.closingForAuthBlock | recordAuthBlock<br>advanceVersion | idleSession, periodicStatusTimer → cleanupBarrier | — | Authentication failure closes the timer and session before authBlocked. |
| T126 | watching.idling | idle.failed | scopeIsCurrent<br>faultIsTransient<br>retryBudgetAvailable | watching.closingForRetry | recordTransientFault<br>advanceVersion | idleSession, periodicStatusTimer → cleanupBarrier | — | Transient IDLE failure closes all watch resources before retry. |
| T127 | watching.idling | idle.failed | scopeIsCurrent<br>faultIsTransient<br>retryBudgetExhausted | watching.closingForFailure | recordFatalFault<br>advanceVersion | idleSession, periodicStatusTimer → cleanupBarrier | — | IDLE retry exhaustion closes resources before failure. |
| T128 | watching.idling | idle.failed | scopeIsCurrent<br>faultIsFatal | watching.closingForFailure | recordFatalFault<br>advanceVersion | idleSession, periodicStatusTimer → cleanupBarrier | — | Fatal IDLE failure cannot leave a nominal watching snapshot. |
| T129 | watching.idling<br>watching.polling | watchTimer.failed | scopeIsCurrent<br>faultIsTransient<br>retryBudgetAvailable | watching.closingForRetry | recordTransientFault<br>advanceVersion | @source → cleanupBarrier | — | Timer failure uses the same owned cleanup and retry path. |
| T130 | watching.idling<br>watching.polling | watchTimer.failed | scopeIsCurrent<br>faultIsTransient<br>retryBudgetExhausted | watching.closingForFailure | recordFatalFault<br>advanceVersion | @source → cleanupBarrier | — | Timer retry exhaustion closes every watch resource before failure. |
| T131 | watching.idling<br>watching.polling | watchTimer.failed | scopeIsCurrent<br>faultIsFatal | watching.closingForFailure | recordFatalFault<br>advanceVersion | @source → cleanupBarrier | — | A timer invariant fault is terminal after awaited cleanup. |
| T140 | watching.closingForSweep | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | sweeping.active | appendCleanupDiagnostics<br>beginEffectScope<br>advanceVersion | cleanupBarrier → recurringSweep | — | Sweep starts only after IDLE, timer, listeners, and watch streams are absent. |
| T141 | watching.closingForRetry | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | retryWaiting.active | appendCleanupDiagnostics<br>beginEffectScope<br>advanceVersion | cleanupBarrier → retryTimer | — | Retry timer cannot overlap the watch timer or IDLE session. |
| T142 | watching.closingForAuthBlock | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | authBlocked | appendCleanupDiagnostics<br>advanceVersion | cleanupBarrier → — | — | authBlocked is stable and has no live child. |
| T143 | watching.closingForPause | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | paused | appendCleanupDiagnostics<br>advanceVersion | cleanupBarrier → — | — | Paused becomes observable only after the adjacent live-IDLE/timer counterexample is impossible. |
| T144 | watching.closingForFailure | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | stopped.failed | appendCleanupDiagnostics<br>advanceVersion | cleanupBarrier → — | — | Terminal failure projects stopped plus bounded diagnostics after zero live resources. |
| T145 | watching.closingForSweep<br>watching.closingForRetry<br>watching.closingForAuthBlock<br>watching.closingForPause<br>watching.closingForFailure | xstate.error.actor.cleanupBarrier | faultIsFatal | stopped.failed | clearAuthBlock<br>recordFatalFault<br>advanceVersion | cleanupBarrier → — | — | The cleanup actor may reject only after its zero-resource terminal contract holds. |
| T150 | sweeping.active | xstate.done.actor.recurringSweep | sweepCompletedNow<br>actorResultUsesIdle | watching.idling | adoptCommittedCheckpoint<br>resetRetryHistory<br>beginEffectScope<br>advanceVersion | recurringSweep → idleSession, periodicStatusTimer | mailboxCheckpoint.sweepCursor<br>recurringSweepCompletion.nextSweepEligibleAt | A completed initial backfill can discover later mail and re-enter watching. |
| T156 | sweeping.active | xstate.done.actor.recurringSweep | sweepCompletedNow<br>actorResultUsesPolling | watching.polling | adoptCommittedCheckpoint<br>resetRetryHistory<br>beginEffectScope<br>advanceVersion | recurringSweep → periodicStatusTimer | mailboxCheckpoint.sweepCursor<br>recurringSweepCompletion.nextSweepEligibleAt | A completed sweep re-enters polling when IDLE is not the validated strategy. |
| T157 | sweeping.active | xstate.done.actor.recurringSweep | sweepNotEligible<br>actorResultUsesIdle | watching.idling | adoptCommittedCheckpoint<br>resetRetryHistory<br>beginEffectScope<br>advanceVersion | recurringSweep → idleSession, periodicStatusTimer | — | A not-yet-eligible sweep returns to IDLE watch without claiming durable progress. |
| T158 | sweeping.active | xstate.done.actor.recurringSweep | sweepNotEligible<br>actorResultUsesPolling | watching.polling | adoptCommittedCheckpoint<br>resetRetryHistory<br>beginEffectScope<br>advanceVersion | recurringSweep → periodicStatusTimer | — | A not-yet-eligible sweep returns to polling without claiming durable progress. |
| T151 | sweeping.active | xstate.done.actor.recurringSweep | sweepViolatedOwnership | stopping.afterFailure | recordFatalFault<br>advanceVersion | recurringSweep → cleanupBarrier | — | not-owner or unexpected cancellation is an invariant failure, never a false completed sweep. |
| T152 | sweeping.active | xstate.error.actor.recurringSweep | faultIsAuthentication | authBlocked | recordAuthBlock<br>advanceVersion | recurringSweep → — | — | Sweep authentication failure blocks automatic retry. |
| T153 | sweeping.active | xstate.error.actor.recurringSweep | faultIsTransient<br>retryBudgetAvailable | retryWaiting.active | recordTransientFault<br>beginEffectScope<br>advanceVersion | recurringSweep → retryTimer | — | Transient sweep failure schedules one retry timer after the sweep actor releases. |
| T154 | sweeping.active | xstate.error.actor.recurringSweep | faultIsTransient<br>retryBudgetExhausted | stopping.afterFailure | recordFatalFault<br>advanceVersion | recurringSweep → cleanupBarrier | — | Sweep retry exhaustion enters awaited failure cleanup. |
| T155 | sweeping.active | xstate.error.actor.recurringSweep | faultIsFatal | stopping.afterFailure | recordFatalFault<br>advanceVersion | recurringSweep → cleanupBarrier | — | Fatal sweep failure is cleaned and then exposed as stopped with diagnostics. |
| T160 | retryWaiting.active | retryTimer.elapsed | scopeIsCurrent | starting.active | beginEffectScope<br>advanceVersion | retryTimer → bootstrapSession | — | The one-shot retry timer clears before startup begins. |
| T161 | retryWaiting.active | retryTimer.failed | scopeIsCurrent | stopping.afterFailure | recordFatalFault<br>advanceVersion | retryTimer → cleanupBarrier | — | Timer failure is an invariant failure and cannot create a second timer. |
| T170 | starting.pausing<br>backfilling.pausing<br>sweeping.pausing<br>retryWaiting.pausing | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | paused | appendCleanupDiagnostics<br>advanceVersion | cleanupBarrier → — | — | Paused is reached only after the source actor and all workflow resources close. |
| T171 | starting.pausing<br>backfilling.pausing<br>sweeping.pausing<br>retryWaiting.pausing | xstate.error.actor.cleanupBarrier | faultIsFatal | stopped.failed | recordFatalFault<br>advanceVersion | cleanupBarrier → — | — | Cleanup failure can settle only after zero ownership; failure is then safe to expose. |
| T180 | stopping.forStop | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | stopped.clean | appendCleanupDiagnostics<br>advanceVersion | cleanupBarrier → — | — | Completed stop is observable only now, with zero workflow resources. |
| T181 | stopping.forRestart | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | starting.active | appendCleanupDiagnostics<br>beginEffectScope<br>advanceVersion | cleanupBarrier → bootstrapSession | — | Restart cannot overlap old children; startup reads durable facts afresh. |
| T182 | stopping.afterFailure | xstate.done.actor.cleanupBarrier | cleanupReleasedScope | stopped.failed | appendCleanupDiagnostics<br>advanceVersion | cleanupBarrier → — | — | Failure is terminal only after cleanup; public status is stopped plus diagnostics. |
| T183 | stopping.forStop<br>stopping.forRestart<br>stopping.afterFailure | xstate.error.actor.cleanupBarrier | faultIsFatal | stopped.failed | recordFatalFault<br>advanceVersion | cleanupBarrier → — | — | A rejected barrier is terminal only under its zero-resource error contract. |

The five global event-policy rows in the model complete the event semantics:

1. Incompatible or stale-version controls emit a rejection and change nothing.
2. Stale, late, duplicate, or reordered callback events change nothing. The first current-scope `idle.ready` records `idleReadyEpoch`; a duplicate fails `idleReadyUnseenForScope`.
3. Promise actor results from an inactive invoke cannot transition or adopt durable data.
4. Credential changes outside `authBlocked` do not auto-start paused/stopped work.
5. Unknown events are rejected before `actor.send`.

## Actor lifecycle and cleanup coverage

| Actor | Start | Success / normal completion | Error categories | Cancellation | Timeout or non-settlement | Required resource assertion |
|---|---|---|---|---|---|---|
| `bootstrapSession` | Enter `starting.active` | `backfill`, `watch` | auth, transient with/without budget, fatal | Pause, stop, restart, shutdown | Delayed release keeps pausing/stopping active | Zero socket/listener/stream before terminal |
| `initialBackfill` | Enter `backfilling.active` | completed, already-complete | auth, transient with/without budget, fatal | Pause, stop, restart, shutdown | Delayed release prevents paused/stopped | Zero actor resources; committed facts only adopted on current done edge |
| `idleSession` | Enter `watching.idling` | ready, mailbox change, normal completion | auth, transient with/without budget, fatal | Pause, stop, restart, timer win | Adapter close may delay barrier | Exact IDLE listener/socket removed before terminal event |
| `periodicStatusTimer` | Enter `watching.idling` or `watching.polling` | elapsed | transient with/without budget, fatal | Pause, stop, restart, IDLE win where applicable | None after disposer | Exactly one timer/listener while active, zero after exit |
| `recurringSweep` | Enter `sweeping.active` | completed, not-eligible, invariant not-owner/cancelled | auth, transient with/without budget, fatal | Pause, stop, restart, shutdown | Delayed release prevents paused/stopped | Zero actor resources; no progress adoption from late result |
| `retryTimer` | Enter `retryWaiting.active` | elapsed | invariant timer failure | Pause, stop, restart, shutdown | Virtual time can hold active retry, never a false deadlock | Exactly one timer while active, zero after exit |
| `cleanupBarrier` | Enter any pausing/closing/stopping state | released plus bounded diagnostics | Zero-resource terminal fault only | Replacement invoke joins the memoized job | Unreleased resource keeps it pending; control can time out | One cleanup job, one cancellation per resource, zero resource before settle |
| `rawDownloadQueue` | Nested once under `initialBackfill` or `recurringSweep` | Serial FIFO job result | Per-job typed error; queue remains governed by its accepted machine | Parent awaits `queue.stop()` | Active adapter response/stage cleanup may delay parent settlement | At most one queue and one active job; zero descendants before parent terminal |
| `rawDownloadJob` | Queue enters its accepted active job state | One raw download result | Typed download/cancellation error | Queue stop aborts and awaits it | Adapter response/stage cleanup may delay queue stop | Exact abort listener, response stream, and stage handle removed before settle |
| `controlWaiter` | Accepted decision for one command | accepted or completed compatible observation | failed/rejected | superseded command | deadline returns typed timeout | Snapshot unsubscribe and deadline timer cleared on every settle |

### Concurrent cleanup matrix

| Active edge | Concurrent trigger | Required disposition | Forbidden result |
|---|---|---|---|
| Any work actor | Pause | Source-specific pausing/closing state, then `paused` after barrier | `paused` before child close |
| Any non-stopped state | Stop | `stopping.forStop`; duplicate stop joins | Success while `stopping` or any child is live |
| Any state | Live-process restart | `stopping.forRestart`, then fresh `starting.active` | Old and new actor scopes overlap |
| Restart/failure cleanup | Stop | Redirect to `stopping.forStop` using same job | Restart creates children after stop completion |
| Stop/failure cleanup | Supervisor restart | Redirect to `stopping.forRestart` using same job | Second cleanup job |
| Any active/closing state | Process shutdown | Converge on `stopping.forStop` | Caller-owned parallel cleanup |
| Cleanup pending | Any duplicate trigger | Reuse memoized job and latest modeled disposition | Duplicate cancel/close, double listener removal, early terminal state |

## Generated path corpus

| Corpus | Generator | Coverage postcondition |
|---|---|---|
| `PATH-STATE` | Shortest path from initialization to every atomic state | 22/22 nodes, exact public projection and actor inventory |
| `PATH-TRANSITION` | Shortest prefix plus each expanded transition and each ordered guard outcome | 167/167 expanded transitions; both outcomes of all 19 guards |
| `PATH-ACTOR` | Every actor success, normal completion, fault category, cancellation, and late outcome | All nine workflow actor types, including queue/job descendants, and all six control outcomes |
| `PATH-CONTROL` | Four controls from every state with matching/stale versions and fresh/duplicate/conflicting identities | Accepted, completed, rejected, failed, cancelled, timeout |
| `PATH-ORDER` | Pairwise permutations around actor completion, timer, control, cleanup, and shutdown | Late, duplicate, reordered, and stale events preserve state/context/durable facts |
| `PATH-RESTART` | Restart from every state and every durable commit/cancellation boundary | Cleanup precedes startup; durable result converges; no snapshot hydration |

Properties `PROP-01` through `PROP-09` in the model cover state/actor equality, cleanup, durable closure, auth classification, event-order safety, restart/listener closure, deadlock/livelock, forbidden configurations, and illegal/unknown boundary events. A failure must retain the seed, shrunk trace, configuration sequence, context version/scope, live resource inventory, durable checkpoint digest, and public observations.

### Generated shortest state paths

The retained `PATH-STATE` result is the following transition-ID corpus. Each row begins with `T001`; later IDs name the guarded actor result or control needed to reach the state. Structural validation replays every row and proves that no shorter graph path exists.

| Atomic state | Shortest transition path |
|---|---|
| `stopped.clean` | `T001` |
| `stopped.failed` | `T001 → T050 → T183` |
| `starting.active` | `T001 → T010` |
| `starting.pausing` | `T001 → T010 → T020` |
| `backfilling.active` | `T001 → T010 → T100` |
| `backfilling.pausing` | `T001 → T010 → T100 → T021` |
| `watching.idling` | `T001 → T010 → T101` |
| `watching.polling` | `T001 → T010 → T106` |
| `watching.closingForSweep` | `T001 → T010 → T101 → T121` |
| `watching.closingForRetry` | `T001 → T010 → T101 → T123` |
| `watching.closingForAuthBlock` | `T001 → T010 → T101 → T125` |
| `watching.closingForPause` | `T001 → T010 → T101 → T022` |
| `watching.closingForFailure` | `T001 → T010 → T101 → T124` |
| `sweeping.active` | `T001 → T010 → T101 → T121 → T140` |
| `sweeping.pausing` | `T001 → T010 → T101 → T121 → T140 → T023` |
| `retryWaiting.active` | `T001 → T010 → T103` |
| `retryWaiting.pausing` | `T001 → T010 → T103 → T024` |
| `authBlocked` | `T001 → T010 → T102` |
| `paused` | `T001 → T010 → T020 → T170` |
| `stopping.forStop` | `T001 → T010 → T043` |
| `stopping.forRestart` | `T001 → T050` |
| `stopping.afterFailure` | `T001 → T010 → T104` |

### Deadlock and livelock account

- A timer state is not deadlocked while its modeled timer is active and virtual time can advance.
- A quiescing/stopping state is not deadlocked while cleanup owns unreleased work; public controls time out without fabricating success. The adapter contract must eventually release or expose a retained operational fault.
- Retry and repeated normal-IDLE-completion loops consume `maxRetryAttempts`. Only a successful bounded operation or `idle.ready` resets the attempt count.
- No automatic transition leaves `authBlocked`; only a credential revision, explicit pause, stop, or supervisor restart can do so.

## F01/F03/F17-F20/S05 traceability

| Shield | Exact transitions | Invariants | Failure injection | Observable postcondition |
|---|---|---|---|---|
| F01 | `T110`, `T116`, `T117`, `T118`, `T121`, `T122`, `T140`, `T150`, `T156`, `T157`, `T158` | `I08`, `I09` | Complete backfill, add a later UID, sweep, interrupt each durable substep, restart in both watch strategies. | `backfillCompleted` remains true; later mail commits once and sweep eligibility advances; already-complete/not-eligible edges claim no new write. |
| F03 | `T123`–`T128`, `T141`, `T142`, `T144` | `I02`, `I04`, `I14` | Production-shaped IDLE normal completion and every fault category. | `watching.idling` is left; retry/auth/failure is observed only after owned release. |
| F17 | `T022`, `T024`, `T121`, `T122`, `T140`, `T141`, `T143`, `T160` | `I04`, `I05`, `I16` | Thousands of virtual-clock tick/cancel/error/pause/resume cycles with exact listener counts. | Settled callback actors own zero timers/listeners and counts remain bounded. |
| F18 | `T041`–`T043`, `T050`, `T051`, `T053`, `T180`–`T183` | `I06`, `I07`, `I15` | Concurrent stop/restart/signal/failure with delayed children. | One job cancels/closes each resource once; no terminal/restart state arrives early. |
| F19 | Control transitions plus `T143`, `T170`, `T180` | `I11`, `I12`, `I13` | Delay targets past deadline; stale versions, duplicate keys, failure, supersession. | Success has the exact compatible actor state/version; every other result is typed non-success. |
| F20 | `T102`, `T112`, `T125`, `T142`, `T152` | `I03`, `I10` | Captured production-shaped credential rejection through the adapter boundary. | `authBlocked`, no retry timer, no secret/raw-command detail. |
| S05 | All transitions | `I01`, `I02`, `I06`, `I07`, `I11`–`I17` | Generate every state, guard, actor outcome, timer, cancel, cleanup, control, nested queue/job, and restart edge. | One state truth, exact owned effects, and observed public controls. |

## Reachability and forbidden-state account

Static graph traversal reaches every declared atomic node. There are no accidentally unreachable modeled states. The negative state space is explicit:

| ID | Forbidden configuration | Construction attempt |
|---|---|---|
| U01 | Paused with a live workflow child | Delay every child close and assert pause remains pending. |
| U02 | Stopped clean/failed with a live workflow child | Inject stop/failure and cleanup delay/error at each actor. |
| U03 | `authBlocked` with retry or IMAP work | Inject auth faults at startup, backfill, IDLE, and sweep. |
| U04 | Idling without exactly IDLE plus timer, or polling with anything except one timer | Compare inspection metadata on every strategy entry/re-entry. |
| U05 | More than one workflow timer | Pairwise IDLE/timer/retry/pause/resume sequences under virtual time. |
| U06 | Cleanup and work actor live in the same state | Inspect every quiescing and stopping snapshot. |
| U07 | Two cleanup jobs | Race all stop/restart/failure/shutdown triggers and compare job identity. |
| U08 | Durable checkpoint changes on ignored/rejected event | Inject stale/late/duplicate result payloads with divergent data. |
| U09 | Completed control without compatible observed version | Delay/reorder snapshots and transport responses. |
| U10 | Old-incarnation child/event after restart | Retain old actor callbacks, reconstruct, then deliver them. |
| U11 | Download queue/job outside its bounded parent, duplicated, concurrent, or surviving parent settlement | Inspect nested actor ancestry; race active/queued job cancellation with backfill/sweep pause, stop, failure, and restart. |

The adjacent paused-with-live-child case is U01 and is a mandatory generated failure if the model/runtime ever permits it.

## Structural evidence

The candidate must pass all of these without production code:

1. JSON parse plus identifier/reference/schema-contract validation.
2. Static reachability of all 22 atomic nodes.
3. Every typed event is used by a transition or global policy.
4. Every traceability transition and invariant reference resolves.
5. The generated Markdown transition rows exactly match all 78 JSON definitions.
6. PLAN/EVIDENCE qualification remains green because this design does not weaken the planning pack.

Exact commands, exits, counts, and the normative model digest are recorded in the final section after checks run.

## Candidate check record

- `shasum -a 256` plus `git show <accepted-commit>:<path> | shasum -a 256` exited 0. PLAN, EVIDENCE, P1-C08, P3-C10, and P3-C11 exactly matched the hashes frozen in the oracle.
- `jq empty docs/architecture/sync-statechart.model.json` exited 0. The normative model digest is `6a4643bb1ec47ec823657c16581cc757ffa30f49ac49abf9cc866f9d9c07abad`.
- The inline Bun oracle verifier exited 0: 22/22 atomic states reachable; 78 transition definitions and 167 expanded transitions; 24/24 events, 20/20 guards, 14/14 actions, and 10/10 actor types referenced; 17 invariants, 11 forbidden configurations, and 9 generated properties resolved; 22/22 retained shortest paths replayed and matched generated graph minima; 22/22 status projections and every declared control projection parsed the accepted P1-C08 Zod schemas; 78/78 Markdown transition rows matched the JSON; all four documents passed final-newline/trailing-whitespace checks; the adjacent paused-with-live-child construction was rejected.
- `bun test packages/contracts/test/sync-operations.test.ts` exited 0: 6 passed, 0 failed, 31 expectations.
- `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py` exited 0 with `PASS: Agent Mail planning pack contains all required evidence and failure shields.`

The full repository `ready` gate was not run. This is a design-only ticket with no production change, and the shared worktree contains unrelated concurrent production drafts; a repository-wide result would not be attributable to this candidate.
