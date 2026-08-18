# Sync lifecycle statechart

Status: design candidate `1.0.0-candidate.7`. Issue #196 freezes the required public `(incarnationId, version)` identity, six fixed-message sync-control errors, and the constructive 85-cell resolver. Candidate.7 preserves every R189-01 through R189-17 disposition, defines the one exact cleanup certificate for R189-18, and freezes bounded registry-owned slot retirement for R189-19. R189-01 through R189-19 are resolved in the oracle; independent exact-digest review remains required.

`sync-statechart.model.json` is the single normative oracle. This document, the decisions ledger, and the coverage ledger are checked views. If prose conflicts with JSON, JSON wins.

## Lifecycle authority and hierarchy

The active atomic XState configuration is the only lifecycle truth. Context carries correlation, progress projection, retry history, credential revisions, cleanup identity, and diagnostics; it carries no mode, paused, stopped, watching, failed, or retrying boolean.

| Parent         | Atomic state                   | Direct actors                        | Public projection      | Cleanup requirement                    |
| -------------- | ------------------------------ | ------------------------------------ | ---------------------- | -------------------------------------- |
| `stopped`      | `stopped.clean`                | none                                 | stopped / none         | none; forbids terminal marker          |
|                | `stopped.failed`               | none                                 | stopped / none         | none; requires `sync.terminal-failure` |
|                | `stopped.shutdown`             | none                                 | stopped / none         | terminal for this incarnation          |
| `starting`     | `starting.active`              | `bootstrapSession`                   | starting / start       | none                                   |
|                | `starting.pausing`             | `cleanupBarrier`                     | starting / start       | workflow                               |
| `backfilling`  | `backfilling.active`           | `initialBackfill`                    | backfilling / backfill | none                                   |
|                | `backfilling.pausing`          | `cleanupBarrier`                     | backfilling / backfill | workflow                               |
| `watching`     | `watching.idling`              | `idleSession`, `periodicStatusTimer` | watching / watch       | none                                   |
|                | `watching.polling`             | `periodicStatusTimer`                | watching / watch       | none                                   |
|                | `watching.closingForSweep`     | `cleanupBarrier`                     | watching / watch       | watch                                  |
|                | `watching.closingForRetry`     | `cleanupBarrier`                     | watching / watch       | workflow                               |
|                | `watching.closingForAuthBlock` | `cleanupBarrier`                     | watching / watch       | workflow                               |
|                | `watching.closingForPause`     | `cleanupBarrier`                     | watching / watch       | workflow                               |
|                | `watching.closingForFailure`   | `cleanupBarrier`                     | watching / watch       | workflow                               |
| `sweeping`     | `sweeping.active`              | `recurringSweep`                     | sweeping / sweep       | none                                   |
|                | `sweeping.pausing`             | `cleanupBarrier`                     | sweeping / sweep       | workflow                               |
| `retryWaiting` | `retryWaiting.active`          | `retryTimer`                         | retrying / retry       | none                                   |
|                | `retryWaiting.pausing`         | `cleanupBarrier`                     | retrying / retry       | workflow                               |
| root           | `authBlocked`                  | none                                 | authBlocked / none     | none                                   |
| root           | `paused`                       | none                                 | paused / none          | none                                   |
| `stopping`     | `stopping.forStop`             | `cleanupBarrier`                     | stopping / stop        | workflow                               |
|                | `stopping.forRestart`          | `cleanupBarrier`                     | stopping / stop        | workflow                               |
|                | `stopping.forShutdown`         | `cleanupBarrier`                     | stopping / stop        | workflow; terminal target              |
|                | `stopping.afterFailure`        | `cleanupBarrier`                     | stopping / stop        | workflow                               |

`paused`, all stopped states, and `authBlocked` own no actors, external resources, unresolved direct release slots, unresolved composite queue slots, or unresolved close terminals. Closing states continue to report the work they are actively releasing. This rejects the adjacent paused-with-live-child, R189-15 source-close, and R189-16 private-queue-subtree counterexamples.

## Complete context and configuration

Every context value exists before `createActor`:

| Context                       | Initial value                             | Writer and purpose                                                |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `incarnationId`               | generated bounded opaque nonempty ID      | Required public status/control ordering identity                  |
| `version`                     | `0`                                       | `advanceVersion`; monotonic only inside one incarnation           |
| `scopeEpoch`                  | `0`                                       | `beginEffectScope`; callback correlation                          |
| `idleReadyEpoch`              | `null`                                    | `markIdleReadyObserved`; one ready per scope                      |
| `retryAttempt`                | `0`                                       | transient-fault/reset actions                                     |
| `checkpoint`                  | validated `constructor.initialCheckpoint` | complete durable status projection, never actor snapshot          |
| `authBlockedDetail`           | `null`                                    | safe constructive public detail                                   |
| `diagnostics`                 | `[]`                                      | bounded safe diagnostics                                          |
| `latestCredentialRevision`    | validated constructor revision            | newer trusted revisions latch here                                |
| `activeCredentialRevision`    | `null`                                    | immutable input captured per credential actor attempt             |
| `authFaultCredentialRevision` | `null`                                    | orders repair against pending auth cleanup                        |
| `cleanupEpoch`                | `0`                                       | authoritative resource-registry cleanup-session identity          |
| `cleanupPhase`                | `0`                                       | versioned terminal source; promotion always creates a fresh phase |
| `cleanupInvokeLease`          | `0`                                       | identity bound to one cleanupBarrier invocation/replacement       |
| `effectiveCleanupScope`       | `null`                                    | registry scope; `watch` may promote to `workflow`                 |

Required bounded configuration is `retryBaseMs`, `retryCapMs`, `retryJitterRatio`, `maxRetryAttempts`, `periodicStatusIntervalMs`, `controlDeadlineMs` (at most 300000), `controlResultRetentionMs` (at most 86400000), `maxControlIdempotencyEntries` (at most 10000), and `maxReleaseSlotEntries` (at most 4096). Release-slot capacity rejects before identity allocation or resource acquisition. Retry cap is at least base; jitter is in `[0,1]`. Clocks and retry randomness are injected.

The composition root synchronously obtains a full six-field `SyncCheckpointSummary` from the durable status projector and parses it before constructing the actor. The oracle freezes empty and populated fixtures. Missing populated progress cannot be replaced with zeros, and no XState child or snapshot is hydrated.

## Complete event, guard, and action surface

The 24 typed events are: `xstate.init`; four `control.*.requested` events; `lifecycle.restart.requested`; `process.shutdown.requested`; `credentials.changed`; done/error events for `bootstrapSession`, `initialBackfill`, `recurringSweep`, and `cleanupBarrier`; four IDLE events; two watch-timer events; and two retry-timer events. Authentication errors carry the attempted credential revision. Cleanup success is `output:CleanupCertificate`; cleanup error is `WorkflowFault` with required `releaseCertificate:CleanupCertificate`. Unknown or malformed input is rejected before `actor.send`.

`CleanupCertificate` is the one sealed normative type. Its 13 exact leaf fields are certificate ID, cleanup epoch, cleanup phase, invoke lease, effective scope, frozen release-set ID, literal `released:true`, audit scope, audit frozen release-set ID, literal zero live-resource count, literal zero unresolved-release count, audit digest, and bounded safe diagnostics. `cleanupBarrier`, `WorkflowFault.releaseCertificate`, both terminal events, both cleanup guards, `appendCleanupDiagnostics`, GEP05, and cleanup admission reference this type rather than copying a partial shape. The structural closure check resolves `CleanupCertificate.*` and requires the same 13 fields in both terminal contracts.

The 27 guards are complete in the oracle. They cover expected version; current callback scope and one-ready admission; bootstrap/backfill/sweep result branches; auth/transient/fatal categories; retry budget; cleanup done/error certificate admission; a newer credential revision; stale/current/future actor credential revisions; and stale/current pending auth cleanup. Ordered guards take the first passing transition.

The 24 actions are complete in the oracle: advance version/scope; adopt committed checkpoint; reset retry; record ready/transient/auth/terminal diagnostics; clear auth or terminal failure; append certified cleanup diagnostics; emit accepted/completed/pending control decisions and rejected/failed/cancelled/timeout/conflict/capacity settlements; latch/bind credential revision; and begin/promote/finish authoritative cleanup.

The coverage ledger expands all 91 transition definitions into 204 source-specific transitions and records source, event, ordered guards, target, action order, actor delta, durable writes, and observation for every row.

Each global-event-policy row is also an exact checked view of all five oracle fields: policy ID, ordered events, literal `when` condition, ordered actions, and literal result. A missing actions column or a paraphrase is a projection failure.

## Actor and effect ownership

| Actor                 | XState logic                  | Owner                                | Terminal/cancellation contract                                                                                                            |
| --------------------- | ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrapSession`    | `fromPromise`                 | `starting.active`                    | One startup decision; acquisition pre-registers direct release slots; abort only triggers them                                            |
| `initialBackfill`     | `fromPromise`                 | `backfilling.active`                 | Pre-registers one workflow composite queue slot before construction; release calls exact `queue.stop()` and adopts its promise            |
| `idleSession`         | `fromCallback`                | `watching.idling`                    | Multiple IDLE messages; acquisition pre-registers direct slots; disposer only triggers their releases                                     |
| `periodicStatusTimer` | `fromCallback`                | both watching active states          | Exactly one timer/listener; disposer clears exact handles                                                                                 |
| `recurringSweep`      | `fromPromise`                 | `sweeping.active`                    | Pre-registers one workflow composite queue slot before construction; release calls exact `queue.stop()` and adopts its promise            |
| `retryTimer`          | `fromCallback`                | `retryWaiting.active`                | One virtualizable timer; exact clear on every exit                                                                                        |
| `cleanupBarrier`      | `fromPromise`                 | every closing/pausing/stopping state | One bounded phase/invoke adapter; the registry session is the sole release owner                                                          |
| `controlWaiter`       | `fromCallback`                | control service outside child graph  | Observes decision plus snapshot; removes two listeners and deadline on every settle                                                       |
| `rawDownloadQueue`    | accepted XState child machine | one active backfill or sweep         | Receives adapter/capacity only; no registry capability or separate slot; parent composite terminal transitively awaits queue `stopped`    |
| `rawDownloadJob`      | private `fromPromise`         | queue active state                   | Receives request/signal/adapter only; no registry slot; active abort and adapter response/staging/finally cleanup precede queue `stopped` |

The queue contract is pinned to P3-C07, issue #98, commit `e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae`: `packages/imap/src/raw-download-queue.ts`, SHA-256 `b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67`; accepted tests `packages/imap/test/raw-download-queue-p3-c07.test.ts`, SHA-256 `53146a3be9ddb66fa9374ad04ed59fca533601c0daa8f07e51925292c68f583f`; and the transitive production adapter `packages/imap/src/raw-download.ts`, SHA-256 `373be897143cac27423c4857db9f2f8d7a8b96239034a8ad72444d56d579b9a2`.

Timers are actor-owned. `watching.idling` owns one status timer beside IDLE; `watching.polling` owns only that timer; `retryWaiting.active` owns only the retry timer. No other state may hold a workflow timer.

## Authoritative cleanup and cancellation

Each cleanup state declares `minimumScope`. One resource registry lives for one actor incarnation and owns at most one cleanup session. Except for the exact frozen P3-C07 queue subtree, before an actor or descendant acquires or starts any external resource that could survive exit, it synchronously registers one direct slot keyed by owner scope, owner invoke identity, and resource ordinal. The registry adds a monotonically increasing positive `slotGeneration` and creates `<incarnationId>:<slotGeneration>` as the never-reused slot instance identity. Registration creates the one awaited terminal immediately. The resource becomes live only after registration completes; acquisition failure settles and retires the existing slot.

The P3-C07 subtree uses one exact composite boundary. `initialBackfill` or `recurringSweep` synchronously registers a workflow-scoped parent slot `rawDownloadQueue:<parentInvokeIdentity>:0` before queue construction. The registered idempotent release closure captures an unbound queue variable. The parent constructs and binds the queue in the same JavaScript turn, where neither XState nor `requestPhase` can interleave; construction failure settles the pre-existing slot. The queue constructor still receives only adapter and capacity. The private job receives only request, signal, and adapter. Neither receives the registry or any register/trigger capability, and neither registers a separate queue, job, listener, response, or staging slot.

The composite release trigger calls exact `queue.stop()` once, and the registry slot terminal aliases/adopts that exact promise. Its stable diagnostic identity remains `rawDownloadQueue:<parentInvokeIdentity>:0`; the registry adds the never-reused generation to form the unique slot member identity. That member appears once in workflow scope and `frozenReleaseSetId` and contributes one live/unresolved unit until the stop promise settles. This is not a parallel close wrapper.

The pinned sources make that terminal transitive. Queued jobs own no acquired external handles and stop rejects them synchronously. The one active `fromPromise` owns an `AbortController`; stop aborts it. The invoke awaits `adapter.download` and removes its caller abort listener in `finally`; the production adapter fulfills or rejects only after response close/error, awaited staging, and its own `finally` cleanup. The queue reaches `stopped` and resolves stop waiters only after that active invoke settles. Therefore the exact stop promise covers the private job, listener, response, and staging cleanup without modifying the frozen API.

Acquisition code holds a registration capability only while its scope is open. A `fromCallback` disposer or `fromPromise` abort handler receives only `triggerRelease(slotId)`. That trigger is idempotent and addresses the same slot and terminal whether cleanup, normal completion, disposal, abort, or descendant shutdown calls it. No disposer or abort handler can create a close promise or register late work. An exact unretired-key deduplication returns the existing handle without allocation or acquisition. For a new key, capacity admission runs before generation admission; when `maxReleaseSlotEntries` is full, registration returns the exact safe transient `sync.release-slot-capacity` `WorkflowFault` before allocating a generation or starting a resource. The generation counter never wraps or resets inside the incarnation; exhaustion returns the exact safe invariant `sync.release-slot-generation-exhausted` fault before allocation or acquisition.

Installed XState 5.32.5 processes the relevant external transition in this order: source exit actions; transition actions; target entry actions; target invoke input evaluation; source `fromCallback` disposal or `fromPromise` abort notification; target invoke start. `beginOrPromoteCleanup` therefore revokes every acquisition capability in the exiting source ownership tree, captures one immutable complete source-tree snapshot, and creates the current immutable phase snapshot from its eligible direct slots plus any parent P3-C07 composite slot in the transition action, before disposal or abort. Target input captures that phase's frozen release-set identity and terminal. JavaScript cannot interleave phase selection with synchronous registration, and no later promotion can reopen registration; it can only select a broader subset of the same source-tree snapshot. Late registration after the first freeze is impossible by construction.

The session contains one current versioned phase and at most one superseded watch phase. `cleanupBarrier` remains a bounded `fromPromise`, but it only awaits one selected immutable phase terminal plus every terminal reference in that snapshot and binds the result to one immutable invoke lease; it does not own or restart cleanup.

`beginOrPromoteCleanup` calls the registry's atomic `requestPhase` before a replacement invoke starts. The first request revokes acquisition for the entire exiting source tree, captures its complete immutable snapshot, selects the eligible covering subset, and idempotently triggers every selected direct or composite release. A new session allocates a new epoch, phase, lease, scope, release-set identity, and pending immutable phase. An equal/narrower request retains the current phase and frozen set, increments the lease, and gives the replacement a new promise over the current pending or cached immutable terminal. A `watch`-to-`workflow` request selects the broader subset of the source-tree snapshot, including already-retired terminal evidence and any workflow composite queue slot, increments the phase, and installs a fresh pending workflow phase over that union before returning, whether the watch phase is still open or already settled. It never reopens registration. Release triggers remain idempotent; scope never downgrades.

The registry's atomic terminal-settlement turn owns retirement. For a normal terminal or acquisition failure with no phase reference, it creates immutable terminal evidence, updates counts and bounded diagnostics, and revokes the acquisition key and registry trigger. The `terminal-settled → retired` transition linearizes at entry deletion in that same turn, before the actor terminal or replacement acquisition. For a source-tree or phase-referenced slot, the registry first publishes the same terminal evidence into the immutable source-tree and every referencing open, promoted, settled, or cached phase and creates replacement immutable audit/diagnostic records; retirement again linearizes at entry deletion after that publication. Phases never look up a retired slot. An old local handle can only return its captured settled promise; it cannot address a new generation.

Retention is exact: slot entries never exceed `maxReleaseSlotEntries`; an open session owns one source-tree snapshot and at most two phase snapshots; every snapshot contains at most `maxReleaseSlotEntries` terminal references/evidence records. Slot entries plus snapshot records are therefore at most `4 * maxReleaseSlotEntries <= 16384`; the three possible envelopes make the total retained registry/session bound `16387`. `finishCleanupScope` purges the source-tree, current/superseded phases, cached terminals, audits, and diagnostic evidence after certificate admission. The terminal event retains its immutable certificate for following actions. Completed incarnation churn therefore retains only scalar epoch, phase, lease, and generation high-water marks.

A cleanup done or error transition is admitted only when all conditions hold:

1. The event belongs to the currently active invoke.
2. Certificate invoke lease equals `context.cleanupInvokeLease`.
3. Certificate epoch and phase equal both context and the registry's current epoch/phase.
4. Certificate effective scope equals both `context.effectiveCleanupScope` and registry effective scope.
5. That exact scope dominates the active state's minimum scope.
6. Certificate frozen release-set identity equals the registry current phase and audit release-set identity.
7. The exact certificate has literal `released:true`; its audit scope equals the certificate scope; live-resource and unresolved-release counts are both literal zero.
8. Certificate ID and audit digest equal the registry's current phase terminal and current audit.

Event-supplied scope never selects the audit or release set. A phase collects every frozen direct terminal and any exact composite `queue.stop()` terminal even when one release rejects, then emits success or error only after the audit reaches zero live and zero unresolved resources. Current pending, current cached, watch-to-workflow promotion, and equal-scope replacement each cover release success and error. In all eight cases, direct triggers and the composite trigger remain idempotent, the composite terminal remains the exact stop promise, and `paused`, `stopped.clean`, `stopped.failed`, and `stopped.shutdown` cannot publish with an unresolved source close.

A pre-promotion watch terminal has the old phase and cannot release a workflow-required state. If watch settles and queues its done event before pause wins mailbox processing, promotion creates a fresh workflow phase from the immutable source-tree snapshot; the old invoke event is ignored and the replacement settles only from the new workflow audit. If watch done wins first, `T140` finishes and purges that session, and the later pause creates a new workflow epoch. If an equal-scope redirect replaces an already-settled wrapper, the registry resolves a new per-invoke promise from the cached current-phase terminal and binds the new lease. Current-pending, current-cached, promoted, and equal-scope certificates are snapshot-owned and therefore byte-identical with or without retired slot entries. No path waits for an impossible replay or second terminal from an old promise. Error settlement requires the same exact `CleanupCertificate` plus a fatal `WorkflowFault`. `finishCleanupScope` alone closes and purges the registry session.

## Durable restart facts and exact writes

Only two accepted durable fact families exist: `MailboxCheckpointRepository` and the shared `InitialBackfillCompletionRepository`. There is no recurring-sweep completion repository.

| Terminal path                            | Accepted repository behavior                       | Modeled durable writes                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P3-C10 completed (`T110`, `T116`)        | `completions.complete` transaction                 | checkpoint `uidNext`, `modseq`, `sweepCursor`, `backfillCompleted`, `observedVersion`; completion `observedUidCeiling`, `observedUidNext`, `observedAt`, `nextSweepEligibleAt` |
| P3-C10 already-complete (`T117`, `T118`) | non-CAS `completions.save` overwrite               | all four completion fields                                                                                                                                                     |
| P3-C11 completed (`T150`, `T156`)        | same `completions.complete` transaction/repository | same five checkpoint and four completion fields                                                                                                                                |
| P3-C11 not-eligible (`T157`, `T158`)     | no write                                           | none                                                                                                                                                                           |

Interruption before non-CAS save preserves the prior row; interruption after save observes the replacement row. Interruption before/after a completion transaction observes the old/new atomic pair. The machine adopts context only from a current-invoke validated terminal result, while reconstruction re-reads any actor-internal commit that survived a crash.

## Credential revision protocol

Every strictly newer `credentials.changed` latches in all non-shutdown states. It advances observation but never restarts otherwise healthy work. Each bootstrap, backfill, IDLE, and sweep attempt captures `latestCredentialRevision` as immutable input. T097's same-state stale-bootstrap repair is an explicit external self-transition with literal XState `reenter: true`; the default non-reentering same-state behavior is forbidden because it would not stop and restart `bootstrapSession`.

For bounded actors, an auth fault older than the latch restarts startup only after the actor terminal release; an equal revision enters `authBlocked`; a future revision is an invariant terminal failure. IDLE first enters workflow cleanup. If a newer revision arrived before or during that cleanup, `T139` restarts with it after certified release; otherwise `T142` enters `authBlocked`. Duplicate/older revisions are no-ops. These rules cover both event orderings without automatic repair of healthy work.

## Restart and shutdown

A live `lifecycle.restart.requested` goes through `stopping.forRestart`, certified workflow cleanup, and fresh `starting.active`. It re-reads durable facts and creates new actors; it does not hydrate a snapshot.

`process.shutdown.requested` instead converges on `stopping.forShutdown`. Once accepted, `lifecycle.restart.requested`, duplicate shutdown, and start/resume/pause controls cannot start children in that incarnation. Certified cleanup ends only in childless `stopped.shutdown`; a certified cleanup fault retains `sync.terminal-failure` but remains terminal. A new process must construct a new incarnation.

## Status, ordering, and control projection

Every atomic state's `public` object contains only `actorState`, `activeOperation`, and `authBlocked`; the projector adds context `incarnationId`, `version`, `checkpoint`, and `diagnostics`. This exact object is parsed by strict `syncStatusResponseSchema`. `stopped.failed` uses state metadata, not an extra public key, to require `sync.terminal-failure`. `compareSyncObservations` orders versions only when incarnation IDs match and returns `unordered` across reconstruction.

The control service registers its decision listener and snapshot subscription before synchronous `send`, then captures `preSend` and `postSend` snapshots. Decision and snapshot may arrive in either order. Completion requires the same `incarnationId` and compatible version; no-op commands use pre/post inspection even if XState emits no subscription notification. Every settle removes the decision listener, snapshot subscription, and deadline.

`syncPendingControlResolverTable` is a constructive discriminated command/ordering table with 18 start, 21 pause, 25 resume, and 21 stop cells. The 85 unique cells cover every success predicate, auth block, terminal or cleanup failure, stop/restart/shutdown/incompatible-command supersession, stale version, incompatible state, busy state, terminal shutdown, deadline, five cached replay outcomes, conflict, capacity, and reconstruction. Each cell selects one completed/rejected/failed/cancelled/timeout/conflict/capacity settlement, exact success variant or registered code/reason, the last real observation source, the idempotency effect, and listener/subscription/deadline cleanup. One compare-and-set wins; later observations cannot settle the waiter again.

Pause/resume/stop idempotency fingerprints the command plus canonical validated request. Same key/fingerprint joins in-flight or returns the byte-identical cached outcome without extending its fixed expiry; replay only touches settled LRU recency. A different fingerprint returns conflict without send and preserves the old entry. Completed/rejected/failed/cancelled/timeout results remain until retention expiry. Expired then oldest settled LRU entries evict; in-flight entries never evict. An all-in-flight capacity returns capacity without creating an entry. Reconstruction destroys the old map; an old waiter that observes the new incarnation settles cancelled/superseded-by-restart from the first real new-incarnation observation.

Two consequential edge choices are fixed. Shutdown superseding an existing pending stop cancels that stop even when shutdown later reaches public `stopped`. A certified cleanup failure fails a pending stop with `terminal-failure` even when the last public actor state is `stopped`. A matching new stop during `stopping.forShutdown` may join cleanup and complete; a stale-version stop is rejected. Conflict, capacity, and replay create no waiter handles.

## Frozen public contract

Issue #196 accepts `P1-C08-R`: every status and operation-specific success observation requires a trimmed, control-safe, nonempty `incarnationId` of at most 256 characters. Every non-success details object carries the same last-observation identity beside actor state and version. No durable global counter or migration is introduced.

`syncControlErrorRegistry` registers exactly `sync.control-rejected`, `sync.control-failed`, `sync.control-cancelled`, `sync.control-timeout`, `sync.control-idempotency-conflict`, and `sync.control-capacity`. Messages are exact. Detail objects are strict and bounded. Start can return the first four; keyed pause/resume/stop can return all six. `R189-06`, `R189-07`, and `R189-14` are resolved by this contract and the terminal-shutdown global policies in the oracle.

## Oracle rule

Implementation must generate or directly consume the machine-readable state, transition, actor-input, guard, action, cleanup, and projection metadata. A hand-maintained diagram is not an implementation oracle. The coverage ledger records the canonical-byte digest and structural checks.
