# P3-C24 runtime conformance qualification

Status: **retained harness complete; production wiring is covered after accepted #210.**

The harness is pinned to candidate.8 model digest `3c26fe8132871e2f2295ca805161e17571c93d99a74aad0161117c38eb979f91`. It drives `createSyncLifecycleActor` with the default production actor map, real temporary SQLite migrations/checkpoints/completions, deterministic fake IDLE/IMAP adapters for the composed lifecycle path, and virtual clocks. It never builds a second machine or replaces the production retry actor.

## Evidence

- `packages/daemon/test/fixtures/sync-runtime-conformance-traces.json` is generated from the signed model and contains 204 expanded source rows across all 91 transition definitions, 8 direct lifecycle ownership sets, 36 before/after ownership pairs, and 7 direct lifecycle actor IDs. Every row carries its generated shortest path, source/target ownership, and cancellation/late/duplicate outcome obligations. The fixture records five default-actor observability gaps explicitly: bootstrap/backfill/sweep actor output (including nested queue output), plus IDLE/polling resource counts; it also records the six model transitions whose SQLite writes require the composed lane.
- `packages/daemon/test/sync-runtime-conformance-p3-c24.test.ts` executes every generated row through the real machine's transition routing. Each path step and row compares formal state/configuration, public state/version, context version/scope, child ownership, and exact version advance semantics; no-write transitions require an unchanged SQLite summary, while retry, cleanup, and terminal resource invariants are exact or bounded by the signed registry contract. The generated rows forge reserved internal outcomes only to test routing guards, not to claim actor implementation output; concrete actor output is probed in the separate production-composed lanes below.
- Eight bounded property seeds exercise 64 external operations each using the default production actor wiring. Stale scope outcomes are injected after every step. Old actor outcomes are sent twice after exits where the target does not own that actor.
- The real composed lifecycle test drives IDLE, polling, initial backfill, recurring sweep, cleanup, SQLite, pause/resume, and shutdown over a deterministic fake adapter. Terminal audits require zero children, timers, listeners, streams, subscriptions, release slots, source-tree snapshots, and phase snapshots.
- Exact signed resource invariants are checked in the concrete lanes: `watching.idling` has one IDLE session, one listener/stream/subscription, one periodic timer, and two release slots; `watching.polling` has one periodic timer and no IDLE resources; `retryWaiting.active` has one retry timer and two release slots; terminal/paused/auth-blocked states have zero live resources.
- The concrete nested queue probe uses the accepted `rawDownloadQueue` actor with one active `rawDownloadJob`, observes its real child snapshot, aborts it through the parent-owned composite release slot, and waits for queue stop plus slot retirement against real temporary SQLite.
- The auth/transient retry trace starts with a real default bootstrap actor, blocks on an authentication fault, applies a credential revision, enters `retryWaiting.active`, observes the actual `retryTimer` child, verifies two registered release slots and the accepted delay (`retryBaseMs * 2` for retry attempt 1), advances virtual time, and verifies timer/slot retirement before startup resumes.
- The generated fixture retains shrunk counterexample IDs `CE-POLL-TIMER-LEAK` (start, poll elapsed, stop, cleanup, leak timer) and `CE-LATE-DOWNLOAD-COMPLETION` (start, stop, late initial-backfill completion). A leaked virtual timer fails the terminal audit; a late completion leaves the stopping state and durable summary unchanged.

## Contract and corrective dependency

The accepted #210 implementation at `d68e48d` wires `retryTimer` to `packages/daemon/src/retry-timer-actor.ts` with injected clock/random seams, pre-registered timer/listener release slots, cancellation, and current-scope terminal events. The signed candidate.8 model and planning/evidence hashes remain unchanged. No production file was changed by this harness work.

## Checks

Focused result: **8 tests passed, 0 failed, 21,449 assertions**.

```sh
bun run packages/daemon/test/fixtures/generate-sync-runtime-conformance-traces.ts
bun test packages/daemon/test/sync-runtime-conformance-p3-c24.test.ts
bun test packages/daemon/test/sync-runtime-conformance-p3-c24.test.ts packages/daemon/test/sync-statechart-p3-c15.test.ts packages/daemon/test/retry-timer-actor-issue-210.test.ts
bunx tsc --noEmit --pretty false --project tsconfig.json
bun run build
bun run lint:check
bunx vp fmt --check docs/architecture/sync-runtime-conformance.md
bunx vp lint packages/daemon/test/sync-runtime-conformance-p3-c24.test.ts
git diff --check
! rg -n '[[:blank:]]+$' packages/daemon/test/sync-runtime-conformance-p3-c24.test.ts packages/daemon/test/fixtures/generate-sync-runtime-conformance-traces.ts packages/daemon/test/fixtures/sync-runtime-conformance-traces.json docs/architecture/sync-runtime-conformance.md
python3 .agents/skills/plan-agent-mail/scripts/check_plan.py
```

The focused harness and combined statechart/retry regression pass. Repository test-inclusive typing retains unrelated pre-existing diagnostics; the new harness/generator have no diagnostics in the scoped compiler output. The repository's current test-file format/lint configuration does not include these ignored test paths; the documentation format check passes. The production build and source lint pass (with existing warnings); readiness and full repository gates remain parent-owned gaps.

Trace SHA-256: `8201004e7b4db7dd716096eaa61d72255831e334e11039efa07d66fee1d3599`.

Retirement: the pre-#210 inert-retry blocker is retired by accepted `d68e48d`; no conformance path or counterexample was removed. No production defect or consequential model decision remains in this qualification seam. Full readiness and external/live-server proof remain outside this isolated contract.
