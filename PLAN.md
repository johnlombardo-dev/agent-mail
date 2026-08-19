# Agent Mail implementation plan

Status: evidence-backed implementation underway. Daybreak access is approved, but the complete applicable security lane is unverified and release-blocking. #203's consequential authority decision is accepted at oracle SHA-256 `8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7`; #204 provenance is recorded at commit `9d1f777`. Release qualification remains blocked by #176, #180, #183, and #185 plus live, deployed, delivery, and security-review gates.

## Evidence baseline

This plan uses two prior sessions as evidence:

| Source | Reproducible target | What it establishes | Limits |
|---|---|---|---|
| Comparison session `01a00ade-55b1-7cb3-bfe4-5edf7baa5d85` | `agent-mail-sol` untracked snapshot and clean `agent-mail-sol-luna` snapshot | `sol` has the clearer shared API/CLI contract and smaller mental model; `sol-luna` has stronger persistence boundaries, per-target action durability, cleanup, operator documentation, and repository hygiene. | No live IMAP proof; the `sol` snapshot had no Git HEAD; early test-readiness observations were superseded by the later audit. |
| System audit session `01a00b59-7554-7ef0-850d-6ae1fa44f27d` | clean `agent-mail-sol-luna` `main` at `24bbd9da6824326dcb17ba8be523fe94ecfc954c` | 30 demonstrated defects and five recurring coverage blind spots despite green static, unit, FTS, and memory gates. | Live iCloud, launchd, and Tailscale mutation were not run; the security lane was partial and non-exhaustive. |

Evidence precedence is: demonstrated failure, composed-path proof, boundary contract proof, isolated test, then static or implementation-snapshot evidence. The audit controls release gates. The comparison informs architecture selection. The original prototype plan supplies product requirements only where it does not conflict with stronger evidence.

Sibling implementations are evidence, not code bases to merge. This implementation starts in this workspace with its own Git history and may transplant a design only after restating its invariant and proof.

## Current implementation inputs

These facts were verified on 2026-08-17 unless identified as a user-provided future prerequisite.

### Repository boundary

| Repository | Verified state | Planning consequence |
|---|---|---|
| [`johnlombardo-dev/agent-mail`](https://github.com/johnlombardo-dev/agent-mail) | Empty repository with no default branch. | Use as `origin`; the first pushed history belongs only to this implementation. |
| [`johnlombardo-dev/agent-mail-proto`](https://github.com/johnlombardo-dev/agent-mail-proto) | Non-empty `main`; this is the repository formerly linked to `agent-mail-sol-luna`. | Preserve as prototype evidence. Do not make it `origin`, copy it wholesale, or push this implementation to it. |

The local workspace is not yet a Git repository. Phase 0 must initialize it, attach the empty canonical remote, create the planning-baseline commit, and verify the exact remote and branch before the first push.

### Dependency policy and verified release snapshot

Use the latest stable package release available when the lockfile is created and again at release qualification. Pin exact direct versions and commit the lockfile. An older version is allowed only through a recorded security or compatibility exception that names the latest version tested, the chosen version, the supporting advisory or reproduction, the affected surface, the removal condition, and the owner.

Registry releases verified on 2026-08-17:

| Package | Latest stable |
|---|---|
| `bun`, `@types/bun` | `1.3.14` |
| `vite-plus` | `0.2.9` |
| `imapflow` | `1.7.1` |
| `mailparser`, `@types/mailparser` | `3.9.15`, `3.4.6` |
| `zod` | `4.4.3` |
| `hono`, `@hono/zod-openapi` | `4.13.2`, `1.6.0` |
| `marked` | `18.0.9` |
| `sanitize-html`, `@types/sanitize-html` | `2.17.7`, `2.16.1` |
| `xstate` | `5.32.5` |

The snapshot is evidence, not a permanent pin. Bootstrap and release gates rerun registry, peer-dependency, engine, audit, and installed-runtime checks. The prior prototype's `sanitize-html@2.17.0` is not carried forward.

### Hermes allocation and port roles

Use the existing Hermes slug `agent-mail` and permanent range `6110–6119`; do not delete or reallocate it. The registry still labels the allocation “Agent Mail Canonical” and points at the prior Sol-Luna path, so Phase 0 must correct that metadata without changing the slug or range when Hermes supports an in-place edit.

| Port or subset | Assigned role |
|---|---|
| `6110` | Normal `agent-maild` loopback API and report origin. |
| `6111` | Local mock IMAP server. |
| `6112–6114` | Leased integration and end-to-end test listeners. Tests acquire a free port from this subset; no test assumes one globally fixed listener. |
| `6115` | Performance and capacity harness. |
| `6116` | Opt-in live-read daemon. |
| `6117` | Opt-in disposable-mailbox mutation daemon. |
| `6118` | launchd and Tailscale deployment-acceptance origin. |
| `6119` | Reserved for a future project-owned server role. |

No project listener may bind outside this range. Independent test workers must use a range-aware lease helper and release their lease during cleanup.

## Scope

Build a local-first, agent-first archive for one iCloud account. A portable Bun daemon will run on macOS, sync every available mailbox except Junk and Trash without changing unread state, retain raw EML and attachments, normalize messages into SQLite, and expose safe search, reporting, export, labeling, routing, and explicitly confirmed remote actions through a versioned API and CLI.

Success means an operator can install, diagnose, back up, restore, and use the system from the README; an agent can search before reading full messages; every mutation is attributable and recoverable; and each release claim is backed by the evidence tier it names.

### Non-goals

- Sending mail, automatic unsubscribe, permanent deletion, or any delete-and-expunge path.
- A general mail UI, embedded model, scheduler, attachment text extraction, classifier training, embeddings, or `sqlite-vec`.
- More than one active account in Phase 1, although stored identities retain `account_id`.
- Claiming exactly-once remote IMAP effects. The design must represent and reconcile uncertain outcomes instead.
- Treating local verification as proof of live iCloud, launchd, Tailscale, a completed security-lane review, or GitHub delivery.

## Behavioral-seam manifest

| Behavior | Owner | Durable state | External effect | Public surfaces | Failure and recovery | Trust or capacity |
|---|---|---|---|---|---|---|
| Discover and ingest mail | Sync workflow plus IMAP and storage adapters | Checkpoints, canonical message, placements, blobs, routing, FTS | Read-only IMAP status and fetch | Status, sync, search | Resume after checkpoint, promotion, parse, or routing interruption | Untrusted MIME; sparse UIDs; large attachments |
| Watch and reconcile mailboxes | XState workflow and child actors | Sweep/IDLE state and checkpoint history | IMAP IDLE, status, flags, UID sets | Sync control and status | Normal completion, error, retry, auth block, pause, stop, restart | Provider optionality; bounded retries and journal |
| Search and retrieve | Search use case, storage, contracts | FTS plus normalized content and tombstones | File streaming only | API, CLI, agent skill | Invalid query, not found, tombstone, slow consumer | Untrusted content; 250k corpus; backpressure |
| Route and label locally | Routing/label use cases and storage | Rules, previews, lanes, labels, provenance | None | API, CLI, agent skill | Atomic apply, expiry, replay rejection, restart convergence | Preview authority; existing/future parity |
| Mutate remote state | Action coordinator, internal executor, IMAP adapter | Frozen plans and per-target attempts/results | Mark or move through IMAP | Preview/commit API and CLI | Stale, partial, uncertain effect, reconciliation, resume | Least authority; explicit confirmation; no expunge |
| Report and export | Report/export use cases and storage | Sanitized report metadata and audit/export history | Stream files or rendered text | API, CLI, report server | Correct attribution, selected query, slow sink | Prompt injection, HTML, identity provenance, memory |
| Diagnose, back up, restore, and install | Operations and storage administration | Complete backup manifest and installed configuration | Filesystem, launchd, Tailscale | CLI and operator README | Full restore, exact uninstall, exact config verification | Private paths; no unrelated mutation |

## Planning-shield applicability

| Shield | Status | Evidence or reason |
|---|---|---|
| S01 | required | Two source sessions disagree on early readiness; fingerprint and precedence must remain explicit. |
| S02 | required | The daemon crosses persistence, external protocol, workflow, public, trust, capacity, and operations seams. |
| S03 | required | Ingestion, routing, labels, reports, export, and action history transform and round-trip durable values. |
| S04 | required | IMAP effects and SQLite results cannot commit atomically. |
| S05 | required | XState, IDLE, sweeps, downloads, cleanup, and action execution form interacting workflows. |
| S06 | required | The archive comprises SQLite, raw EML, attachments, metadata, and rebuild/recovery behavior. |
| S07 | required | Existing/future, API/CLI, storage/route, and actor/API paths previously drifted. |
| S08 | required | Provider-shaped fakes masked UIDNEXT, IDLE, auth, and storage-return behavior. |
| S09 | required | FTS, MIME RSS, sparse UIDs, selected export, journals, streaming, and timeouts grow differently. |
| S10 | required | The product indexes private email and exposes identity, bearer, report, filesystem, and mutation boundaries. Daybreak access is approved; the complete applicable security lane remains unverified and release-blocking until run. |
| S11 | required | README truth, Git history, doctor, restore, launchd, Tailscale, and rollback determine operability. |
| S12 | required | Local, live, security, deployed, and delivery evidence were previously easy to conflate. |

## Non-negotiable invariants

1. **Unread preservation:** discovery, sync, search, show, export, report, doctor, backup, and restore never add `\\Seen`.
2. **No destructive mail path:** only explicit mark-seen, mark-unseen, move-to-Archive, and move-to-Trash operations exist; no operation expunges mail.
3. **Canonical integrity:** canonical content is the SHA-256 of verified raw EML; remote placements, tombstones, labels, routing, and action history remain distinct and correctly attributable.
4. **Ingestion closure:** message promotion plus routing is one recoverable protocol. A crash cannot leave a promoted message permanently unrouted.
5. **Mutation closure:** each IMAP effect plus durable result has per-target intent, attempt, outcome, and uncertainty. Retry first reconciles uncertain remote state.
6. **Recovery closure:** backup plus full restore covers SQLite, raw EML, attachments, manifest, and required configuration metadata, and proves the restored public behavior.
7. **Contract parity:** API and CLI use one versioned request/response schema registry and validate both inputs and outputs. Transport types do not live in the core domain.
8. **Workflow truth:** XState states describe currently active work. Actors own effects, retry, cancellation, and cleanup; public status follows observed actor transitions.
9. **Least authority:** public tokens cannot call executor-internal operations. Stored previews are server-authoritative, expiring, frozen-target, single-use, and replay resistant.
10. **Bounded operation:** sync, parsing, search, streaming, journals, and selected export have explicit resource ceilings and backpressure behavior.
11. **Private by default:** sensitive directories and files fail closed on unsafe permissions; secrets and untrusted message data do not enter routine logs.
12. **Truthful evidence:** every acceptance claim names the exact static, isolated, composed, capacity, live, security, deployed, or delivery evidence that supports it.

## Daybreak security intervention gates

The rows below are synchronized with the project failure-shield registry and the evidence ledger. They are structural planning authority, not security-review results. `specified; release-blocking` means the proof is defined but has not passed. `locally verified; Stage 4 release-blocking` means the foundational repair and named local regressions passed, while final capacity, deployed, security, and finding-closure evidence remains open.

| ID | Demonstrated counterexample | Invariant | Planned control | Faithful executable proof | Owner issue | Intervention timing | Evidence status |
|---|---|---|---|---|---|---|---|
| F09-P | Historical F09 bundled bearer executor impersonation with expired-plan recovery; public bearer routes could reach executor capabilities. | Public credentials cannot invoke claim, resume, or finalize capabilities reserved for the internal actor. | Keep executor capability internal, enumerate every route/scope, and reject every bearer path before any effect. | Enumerate registered routes and scopes, exercise each bearer profile against executor calls, and assert zero executor effects and stable denial. | #183, #185 | Stage 2 planning gate; before action CLI, live mutation, and final security qualification. | specified; release-blocking |
| F09-R | Historical F09 bundled public reachability with a persisted undispatched attempt recovered after plan expiry; creation-time expiry did not protect recovery dispatch. | After authority expiry, no new remote effect begins; only an already-dispatched uncertain attempt may reconcile read-only. | Revalidate plan state, claim/version, target identity, and expiry immediately before every new effect, including recovered attempts and later targets; classify expired undispatched attempts durably. | Persist an undispatched attempt before expiry, recover after expiry, and assert zero precondition reads that mutate, zero mutation-adapter calls, and a durable non-executing result; repeat between targets. | #202, #183, #185 | Stage 2, before action CLI/live mutation; Stage 4 reruns the original reproduction and adjacent counterexample. | locally verified by `packages/daemon/test/action-plan-restart-recovery-p5-c17.test.ts` and `action-plan-target-loop-p5-c15.test.ts` at `df02745`; Stage 4 release-blocking |
| SEC-R01 | Same expired-undispatched recovery counterexample as F09-R. | No fresh external effect is admitted after plan authority expiry. | Use one explicit per-effect authority guard with constructive expired-versus-dispatched states and read-only reconciliation for uncertainty. | Crash after persisting an undispatched attempt, advance past expiry, restart, and retain remote-call traces plus durable terminal snapshots. | #202 | Stage 2 before any dependent action work; Stage 4 closure. | locally verified by `packages/daemon/test/action-plan-restart-recovery-p5-c17.test.ts` at `df02745`; Stage 4 release-blocking |
| SEC-R02 | A bearer with authorize and commit scopes can self-mint approval; durable evidence stores only a scope and accepts caller-spoofed principal data. | An unattended acting credential cannot mint the independent approval it consumes, and authenticated principal/profile provenance survives restart and restore. | Apply #203's accepted independent-authority decision at oracle SHA-256 `8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7`; #204 provenance is recorded at commit `9d1f777`; persist trusted principal/profile, exact digest/targets/intent/version, expiry, nonce, and one-use consumption; fail closed for legacy scope-only rows. | Reject same-token approval, spoofed principal, changed digest/targets/intent/version, replay, concurrent consume, and restart-around-consume with zero unauthorized effects; run direct and composed paths. | #203, #204 | Stage 2: retain the accepted #203 oracle and #204 provenance before action CLI or live mutation; Stage 4 closure. | locally verified by `packages/daemon/test/action-approval-service-composed.test.ts` and `packages/storage/test/action-approval-authority.test.ts` at `9d1f777` against oracle `8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7`; Stage 4 release-blocking |
| SEC-R03 | A valid wrong-scope bearer can send an unlimited chunked JSON body; current ingress materializes JSON before exact-scope and byte admission. | Authenticate, authorize exact scope, and enforce received-byte/item/time budgets before parsing, decoding, decompression, or large retention, including streaming input. | Route every request through one bounded streaming admission helper; reject wrong scope and oversize before materialization and keep stable errors. | Exercise honest, absent, malformed, exact, and oversized Content-Length plus chunked/slow/aborted bodies with correct and wrong-scope credentials; assert zero body-reader/handler calls on wrong scope and bounded retained RSS. | #205, #176 | Stage 2 before OpenAPI/route integration; Stage 4 reruns request-admission resource bounds. | locally verified by `packages/daemon/test/http-admission-sec-r03.test.ts` at `44a0b28`; Stage 4 #176 release-blocking |
| SEC-R04 | Untrusted subject text containing OSC 52 or carriage return can forge terminal output; input schemas do not protect human rendering. | Human output cannot emit terminal controls or overwrite trusted chrome, while structured output remains schema-valid and raw bytes remain exact. | Centralize typed output contexts for human terminal, JSON/JSONL, reports, logs, and raw binary; use a hostile corpus and explicit TTY policy. | Run ESC/CSI/OSC, CR/backspace, C0/C1, bidi, links, and filenames through each context; assert inert human bytes, faithful structured bytes, and byte-exact permitted raw streams. | #206, #183, #185 | Stage 2 before human CLI renderers; Stage 4 final CLI/security closure. | locally verified by `packages/cli/test/output-context.test.ts` at `20e4d0e`; Stage 4 #183/#185 release-blocking |
| SEC-R05 | A direct client can supply Tailscale/proxy identity headers over a backend path and appear to be the trusted owner; loopback binding alone does not prove provenance. | Intermediary identity is trusted only across a verified hop; direct copies of trusted headers are stripped or overwritten before authorization. | Define the exact intermediary topology, direct-backend policy, owner mapping, and header allowlist; strip direct-client identity headers and verify owned Serve state. | Exercise direct loopback/LAN/tailnet requests with spoofed, missing, stale, and wrong-owner headers versus a verified intermediary/Serve-mediated request; retain topology/config evidence without secrets. | #180, #183 | Stage 2 planning/deployment prerequisite; Stage 4 deployed security qualification. | specified; release-blocking |
| SEC-R06 | A client or stored record can tamper with or replay keyed previews, content digests, nonces, versions, or target summaries when the consumer trusts the supplied commitment. | Every commitment is recomputed from canonical current inputs at each consume/reuse boundary and mismatch or replay cannot authorize an effect. | Bind canonical intent, target set, plan/version, nonce, and content digest to a server-authoritative commitment; recompute at consume/reuse and retain uncertainty. | Tamper and replay each commitment field with attacker-known algorithms, changed targets, and restored state; assert rejection before effect and matching durable audit evidence. | #183, #185 | Stage 1 planning rule; Stage 2 implementation seams; Stage 4 complete security/finding closure. | specified; release-blocking |
| SEC-R07 | An advisory scan can be green while a vulnerable transitive dependency is reachable, or an old exception persists without an owner/removal condition. | Dependency security decisions combine advisory results with installed-version reachability, affected-surface proof, named exception owner, removal condition, and release recheck. | Require an exact dependency inventory, reachability/affected-version proof, explicit exception record, and bootstrap/release recheck; stale exceptions fail qualification. | Pair advisory output with installed graph/runtime reachability, exercise the affected boundary where feasible, and assert every exception has owner, removal condition, and current recheck. | #183, #185 | Stage 1 planning/dependency policy; Stage 4 release qualification. | specified; release-blocking |

Historical coordination is inherited from #208: Stage 0 held action CLI/live mutation, OpenAPI route integration, ad hoc human renderers, and final security closure until #202, #205, and #206 closed and their original regressions passed. #203's accepted oracle is `8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7`, and #204 provenance is recorded at commit `9d1f777`. Current release qualification remains blocked by #176, #180, #183, and #185 plus live, deployed, delivery, and security-review gates. #202 and #204 may not overlap action contract/service mutation. #205 owns the shared HTTP boundary, and #206 owns the shared CLI output foundation. Historical #151/#152 contracts and the #202–#208 issue bodies remain frozen inputs; this update does not rewrite their hashes or dispositions.

## Architecture decisions

| Boundary | Decision | Evidence used | Rejected alternative |
|---|---|---|---|
| Domain | Use constructive message, body, ingestion, and action-plan unions that make invalid lifecycle combinations unrepresentable. | Sol-Luna models staged ingestion and MIME states well; Sol models action-plan phases more precisely. | One object plus status enums and nullable fields that admit inconsistent combinations. |
| Public contracts | Add `@agent-mail/contracts`, separate from `@agent-mail/core`, as the single Zod/OpenAPI route, request, response, error, cursor, and streaming metadata registry used by daemon and CLI. | Sol's shared registry prevents API/CLI drift; Sol-Luna's hand-written CLI accepted success JSON as `unknown`. | Transport definitions in core, or independent CLI paths and types. |
| Persistence | Use capability-owned storage interfaces, numbered migrations, transactions, and explicit parsers from `unknown` for every SQLite row. | Sol-Luna's boundary parsing and migration discipline are stronger; Sol's broad adapter and duplicate persistence model increase drift. | One broad storage adapter or unchecked casts from SQLite results. |
| Blob store | Stage, fsync, hash, and atomically promote blobs; verify an existing destination before reuse; quarantine mismatch; retain content during placement disappearance. | Audit finding F05 and the original content-addressed requirement. | Trusting path existence as proof of content integrity. |
| Ingestion and routing | Commit canonical promotion, remote placement, FTS state, and the applicable routing decision in one transaction or durable outbox protocol. | Audit finding F02 showed a permanent gap between promotion and routing. | Best-effort callback after promotion. |
| Sync workflow | Use XState v5 for explicit `stopped`, `starting`, `backfilling`, `watching`, `sweeping`, `retrying`, `authBlocked`, `paused`, and `stopping` modes. Child actors own IDLE, periodic sweeps, downloads, and mutations. | Both prototypes identified a state machine; Sol-Luna had cleanup discipline but its nominal backfill state did no work. | Boolean orchestration, fire-and-forget effects, or states that describe already completed work. |
| Cleanup | One awaited, idempotent cleanup barrier owns actor stop, IMAP close, stream cancellation, and storage close. Restart awaits the same barrier. | Sol-Luna's barrier is useful; audit findings F17-F18 require listener and double-cleanup closure. | Entry actions or callers invoking overlapping cleanup independently. |
| IMAP adapter | Treat capabilities and status fields as optional protocol data, request every precondition field actually used, and test installed ImapFlow semantics. Never issue commands inside a `fetch()` generator loop. | Audit findings F03, F06, F10, F20, and F22 escaped through permissive fakes. | Defaults such as missing `UIDNEXT = 1`, fake-only fields, or UID enumeration to the maximum value. |
| Remote actions | Atomically claim a frozen plan, persist each target attempt, restrict executor operations to an internal capability, and represent `uncertain` after an effect whose result was not persisted. | Sol-Luna narrows the crash window; the audit still proved unrecoverable post-effect write failure and excessive public authority. | Sol's whole-pass result write or blind retry after an unknown outcome. |
| Routing previews | Persist the canonical predicate, exact existing targets, expiry, nonce, and digest; atomically consume it once. Future routing reuses the same normalized predicate. | Audit findings F08 and F11. | Client-reconstructible unkeyed digests or separate preview/application matchers. |
| Search and export | Rank lightweight FTS candidates before final-page hydration. Query selected exports by selected identities and stream with backpressure. | Both prototypes met the narrow FTS target; audit findings F23 and F30 exposed public-boundary costs. | Whole-archive serialization followed by filtering or unbounded CLI buffering. |
| Backup and operations | Backup database plus blobs with a hashed manifest; verify by restoring into an empty directory. Operations commands define and check exact postconditions. | Audit findings F07 and F24-F26. | SQLite-only copies, command-list snapshots, global Tailscale resets, or success without checking resulting state. |
| Reports and trust | Bearer authentication remains required for API operations. Any identity-only report surface must verify trusted proxy provenance and owner identity; content is sanitized and carries no client JavaScript. | Comparison found Sol's provenance boundary clearer and Sol-Luna's report trust more implicit. | Trusting spoofable headers or serving stored email HTML. |
| Complexity | Split modules by one owned protocol or capability and review any production file that grows beyond roughly 500 lines for missing boundaries. | Sol-Luna had 26% more production code concentrated in several 1,000-1,900-line files; Sol was easier to trace. | A line-count gate that encourages arbitrary fragmentation, or unbounded coordinator modules. |

### Target packages

- `@agent-mail/core`: transport-free domain types, invariants, state-specific action algebra, and use-case ports.
- `@agent-mail/contracts`: versioned Zod/OpenAPI requests, responses, errors, cursor rules, stream metadata, and CLI command mapping.
- `@agent-mail/storage`: SQLite migrations and capability catalogs for messages, sync, routing, actions, reports, export, backup, and blobs.
- `@agent-mail/imap`: ImapFlow capability discovery, mailbox/status normalization, streaming fetch, IDLE, and remote action reconciliation.
- `agent-maild`: XState workflow, dependency wiring, loopback REST/report servers, configuration, credentials, and operations commands.
- `agent-mail`: thin schema-driven CLI with bounded streaming and stable machine-readable output.
- `.agents/skills/agent-mail`: operator skill that searches first, treats mail as untrusted, and requires preview/digest confirmation before mutation.

## Delivery slices

Each phase is a vertical slice with observable exit evidence. Package creation alone cannot close a phase.

### Phase 0: Reproducible foundation

Entry: this planning pack is accepted.

Work:

- Initialize Git, set `https://github.com/johnlombardo-dev/agent-mail` as `origin`, confirm the remote is still empty immediately before the first push, and record the planning baseline before implementation.
- Resolve the latest stable direct dependencies, pin exact versions, commit the lockfile, and record any security or compatibility exception. Expose `format`, fixing `lint`, `typecheck`, `test`, `build`, `audit`, `outdated`, and `ready`.
- Use Hermes allocation `agent-mail` at `6110–6119` and the documented role map. Add a process-safe, range-aware test-port lease protocol with explicit `available`, `leased`, and `released` states plus stale-lease cleanup; do not use fixed shared test listeners or bind outside the allocation.
- Correct the stale Hermes display name and base path in place when an edit mechanism is available; never remove and recreate the allocation.
- Establish the package boundaries, `CONTEXT.md`, ADRs, configuration schema, private-path policy, and an honest README skeleton.
- Build reusable adapter-contract harnesses so production adapters and fakes must pass the same return-shape, completion, error, cancellation, and ordering cases.

Exit evidence:

- `origin` resolves to `johnlombardo-dev/agent-mail`; the first named commit contains the accepted planning baseline; Git status is clean.
- Exact dependency pins and the lockfile match a retained registry/compatibility snapshot; recursive outdated and audit checks are clear or every exception is recorded with its removal condition.
- `ports show agent-mail --json` still reports `6110–6119`; role assignments are documented; concurrent test leases stay inside the range without collision.
- README commands resolve to implemented or explicitly marked future commands; no promised stub throws “unavailable.”
- Contract harness rejects a deliberately weakened fake.

### Phase 1: Domain and public-contract spine

Entry: Phase 0 evidence passes.

Work:

- Define canonical messages, remote placements, staged ingestion, MIME bodies, tombstones, labels, routing, frozen plans, per-target attempts, and uncertain outcomes as constructive types.
- Implement the shared `/v1` contract registry, stable errors, cursor model, stream metadata, and CLI command mapping.
- Keep core transport-free; validate requests, responses, configuration, and persistence values at their owning boundaries.
- Define parity matrices for existing versus future routing, API versus CLI, storage versus route not-found behavior, and actor versus API status.

Exit evidence:

- Schema round trips, invalid-state compile checks, property tests for state transitions, and request/response validation pass.
- Every matrix row has one executable contract test, including empty arrays, unknown resources, invalid FTS, and committed mutation metadata.

### Phase 2: Durable ingestion and complete recovery substrate

Entry: the domain and contracts are stable enough to persist.

Work:

- Implement migrations, strict database opening, row parsers, canonical/placement separation, staged streaming MIME parsing, address/body/attachment normalization, and FTS update ordering.
- Implement verified content-addressed blobs, abandoned-stage cleanup, promotion plus routing closure, and identity-only recovery from retained raw EML.
- Implement manifest-based backup and restore for SQLite, blobs, essential configuration metadata, labels, routing, reports, and action history.

Exit evidence:

- Malformed MIME, duplicate identities, large attachments, interrupted promotion, corrupt pre-existing blobs, restart, and reparse-without-redownload probes pass.
- Failure injected at every promotion/routing boundary converges after restart without duplicate or permanently unrouted messages.
- A restore into an empty private directory reproduces search results and exact raw/attachment hashes.

### Phase 3: Truthful sync and lifecycle workflow

Entry: ingestion and recovery substrate pass.

Work:

- Implement mailbox discovery, newest-first backfill, completed-checkpoint periodic sweeps, UIDVALIDITY recovery, flag/tombstone updates, bounded downloads, Inbox IDLE, retries, pause/resume, auth blocking, and awaited shutdown.
- Treat missing UIDNEXT and optional capability data as unknown, not invented defaults. Use server-provided UID sets/ranges and bounded batches for sparse mailboxes.
- Make actor completion, error, cancellation, and cleanup observable. API control commands await actor acknowledgement and return the observed state version.

Exit evidence:

- Completed backfill followed by non-empty periodic sweep succeeds.
- IDLE normal completion and failure leave `watching`; auth failures reach `authBlocked`; stop and restart leave no leaked listener or double cleanup.
- Sparse UID fixtures show work proportional to actual returned UIDs, with a stated round-trip ceiling.
- A read-only fake and, when authorized, live iCloud proof show unread state is unchanged.

### Phase 4: Search, routing, labels, and local action closure

Entry: synced messages and placements are durable.

Work:

- Implement FTS5 ranking, snippets, filters, cursor pagination, routing lanes, importance labels, exact sender/List-ID predicates, tombstone rules, and local action deduplication by canonical message.
- Persist authoritative routing previews and consume them once. Apply the same normalized predicate to existing and future messages.
- Normalize timestamps before comparison and bound sweep-journal retention.

Exit evidence:

- Search/filter/reindex property tests cover tombstones, offset-equivalent timestamps, invalid FTS expressions, stable cursors, and routing-lane isolation.
- Existing/future routing parity, tampering, expiry, replay, crash, and multi-placement deduplication probes pass.
- At 250,000 messages, warm top-20 p95 is below 250 ms on the named target hardware with setup and raw measurements retained.

### Phase 5: Remote mutation and uncertainty recovery

Entry: read-only and local-action paths pass.

Work:

- Implement server-authoritative action plans, exact frozen targets, actual requested MODSEQ preconditions, explicit commit, atomic claim, internal executor capability, per-target durable results, stale rejection, partial results, and uncertain-outcome reconciliation.
- Revalidate current authority immediately before every new external effect, including recovered undispatched attempts and later targets; an expired undispatched attempt becomes a durable non-executing result, while an already-dispatched uncertain attempt may only reconcile read-only. This work is blocked until #202 closes.
- Retain the implemented independent approval and durable authenticated-principal/profile provenance against #203's accepted exact oracle SHA-256 `8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7`; #204 provenance is recorded at commit `9d1f777`, and no scope-only compatibility path is permitted.
- Discover Archive/Trash via special-use mailboxes. Never implement delete-and-expunge.
- Restrict public token scopes to user operations; do not expose executor resume/finalize endpoints.

Exit evidence:

- Adapter contracts prove requested MODSEQ and installed SDK result handling.
- IMAP success followed by result-store failure enters `uncertain`; restart observes remote state before any retry and records one attributable outcome.
- Expired, stale, replayed, tampered, wrong-scope, and partial-failure cases fail safely; an executable source/code-path assertion proves no expunge operation exists.
- Live mutation remains opt-in and requires an operator-selected disposable mailbox plus exact preview confirmation.

### Phase 6: API, CLI, skill, reports, and export

Entry: use cases close through storage and workflow.

Work:

- Wire every supported API route and generate OpenAPI from the shared registry. Make the CLI schema-driven and validate success and error responses.
- Gate every HTTP body through authentication, exact-scope authorization, and bounded streaming byte admission before JSON materialization; this work is blocked on #205.
- Implement search-first skill behavior, explicit body/raw/attachment retrieval, untrusted-email markers, source citations, sanitized Markdown reports, strict CSP, and text-only source views.
- Route all human terminal rendering through the shared output-context policy, preserving structured and raw-byte semantics; command renderers wait for #206.
- Stream raw, attachments, selected JSONL export, and report output with backpressure and explicit connect/control/stream-idle timeout policies.

Exit evidence:

- API versus CLI parity passes for all routes, response states, not-found behavior, errors, scopes, commit metadata, and streams.
- Slow stdout and slow network sink probes retain bounded memory and do not inherit a fixed 30-second whole-response timeout.
- Selected export work is proportional to selected IDs on a 250,000-message archive and preserves correctly attributed, non-duplicated action history.
- Malicious Markdown, remote images, raw email HTML, prompt-injection text, spoofed proxy headers, and sensitive logging probes pass.

### Phase 7: Diagnostics, installation, and deployed recovery

Entry: public workflows pass locally.

Work:

- Implement `doctor`, reindex, backup/restore, launchd install/uninstall, exact restart health checks, and scoped Tailscale Serve configuration with Funnel disabled.
- Use `PRAGMA integrity_check` and `PRAGMA foreign_key_check`; preserve issue detail through storage, API, and CLI.
- Make uninstall remove the exact installed plist after bootout. Change only the project-owned Serve entry, honor the supplied config path, and verify exact active configuration.

Exit evidence:

- Seeded corruption and foreign-key violations produce unhealthy doctor output with diagnoses.
- An isolated install/uninstall proves the service is unloaded and the exact plist is absent.
- On an authorized target, Tailscale verification proves loopback origin, owner identity, bearer enforcement, exact Serve entry, and no Funnel or unrelated service mutation.
- Restart and destructive restore drills pass on the target host with file permissions rechecked.

### Phase 8: Release qualification and delivery

Entry: Phases 0-7 have their required local evidence.

Work:

- Close every row in `docs/planning/EVIDENCE.md` with a test/probe path and retained result.
- Run a bounded system-mode `evidence-first-review` on the release candidate. Route lanes from the actual manifest. Daybreak access is approved, so run the complete applicable security lane without the earlier permission-driven truncation and record any residual gaps; access approval is not security evidence.
- Run check-only static gates, the full local suite, composed matrices, capacity gates, live read smoke, explicit live mutation smoke if Phase 1 claims mutation readiness, deployed operations, README command walkthrough, and backup restore.
- Commit intentionally, verify the exact branch/HEAD and clean scope, then record remote delivery separately if requested and available.

Exit evidence:

- No release-blocking traceability row is open. Review reports `no confirmed findings` for the frozen candidate or all findings have a separately verified repair seam.
- Evidence states distinguish locally verified, live verified, deployed verified, security reviewed, and delivered. Missing external proof keeps only the affected promotion gate closed.
- The complete applicable security lane remains unverified and release-blocking until #183 runs. #203's accepted oracle `8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7` and #204 provenance at commit `9d1f777` do not satisfy the remaining #176, #180, #183, and #185, live, deployed, delivery, or security-review gates.

## Acceptance matrices

The implementation must maintain executable matrices for:

- composed closure: promotion plus routing, IMAP effect plus durable result, runtime API plus XState, and backup plus full restore;
- duplicated paths: existing versus future routing, API versus CLI, storage versus route, and actor versus API;
- production boundaries: fake and installed-adapter shapes, optional fields, normal completion, errors, cancellation, cleanup, backpressure, and ordering;
- scale and operations: FTS, MIME RSS, sparse UID, selected export, slow stdout/network, whole-response timeouts, bounded journals, doctor diagnosis, full restore, uninstall, and exact network configuration.

Each matrix row names the owning invariant, fixture or environment, failure injection if applicable, observable outcome, evidence path, and current status.

## Evidence tiers and promotion

| Gate | Required evidence | What it does not prove |
|---|---|---|
| Static | Check-only format, lint, typecheck, dependency policy, build, clean fingerprint. | Runtime behavior or composed closure. |
| Isolated | Unit, property, migration, parser, schema, and adapter-contract tests. | Cross-component persistence/effect outcomes. |
| Composed | Promotion plus routing; IMAP effect plus durable result; runtime API plus XState; backup plus full restore; all four parity matrices. | Live vendor behavior or deployed configuration. |
| Capacity | 250k FTS, 250 MiB MIME, sparse UID, selected export, slow stdout/network, whole-response timeout semantics, bounded journals. | Correctness outside measured cases. |
| Live read | Opt-in iCloud discovery/download/search with unread state preserved. | Remote mutation safety. |
| Live mutation | Explicit disposable mailbox, exact confirmed preview, stale/partial/reconcile cases, no expunge. | General security or deployment correctness. |
| Security | With the required ChatGPT cybersecurity access, complete the applicable security lane across authn/authz, secrets, reports/proxy provenance, local privilege, logging, injection, dependencies, untrusted content, and declared trust boundaries. | Operational installation or risks outside the declared review scope. |
| Deployed operations | Private paths, launchd install/restart/uninstall, exact Tailscale Serve state, doctor, full restore drill. | Git delivery. |
| Delivery | Clean exact commit/branch, intended diff, remote and CI state when a remote is available. | Live or deployed readiness unless separately proven. |

Promotion rules:

1. `implemented` requires source and mapped tests, not passing evidence.
2. `locally verified` requires static, isolated, composed, and capacity gates.
3. `live verified` additionally requires the applicable read and mutation gates.
4. `deployed verified` additionally requires the operations gate on the target host.
5. `release-ready` requires every applicable gate, all F01-F30 rows closed, dedicated security evidence, an accurate README, and no undeclared gap.

## Risk and finding traceability

[The evidence ledger](docs/planning/EVIDENCE.md) maps every finding from the Sol-Luna audit to an invariant, owning phase, planned control, and executable proof. F01-F30 are release-blocking regression shields until their evidence is attached. The ledger also captures the five review blind spots that shape the composed, parity, capacity, fake-contract, and outcome-based gates.

## Explicit gaps and deferred work

- No implementation or runtime evidence exists yet. The local workspace is not initialized as Git, but the empty canonical remote `johnlombardo-dev/agent-mail` is available.
- Hermes slug `agent-mail` and range `6110–6119` are allocated. Its display name and base path still reference the prior Sol-Luna prototype and need an in-place metadata correction without reallocation.
- Live iCloud, live mutation, launchd, Tailscale, target-host restart, and full restore have not been exercised for this implementation.
- The source audit's security work was partial. Daybreak access is approved, but the complete applicable security lane is unverified; access approval is not security evidence, and release qualification remains blocked until #183 runs.
- #203's consequential single-user authority decision is accepted at oracle SHA-256 `8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7`; #204 provenance is recorded at commit `9d1f777`. Preserve the accepted authority and principal/profile rules; do not invent a replacement or compatibility path. Remaining release gates stay blocking.
- Remote IMAP effects cannot be atomically committed with SQLite. `uncertain` plus reconciliation is an explicit design obligation, not a solved exactly-once guarantee.
- The package snapshot was current on 2026-08-17, but bootstrap and release must recheck latest stable releases, peer and engine compatibility, advisories, and installed behavior. Current Apple, ImapFlow, SQLite, and Tailscale behavior still requires primary-documentation and installed-version verification during implementation.

## iCloud credential authority gates

The accepted #235/#236 intervention adds the following planning rows without rewriting historical F01-F30 or SEC-R rows. The normative authority is the exact #236 oracle at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb, oracle SHA-256 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c. These rows are planning authority only: the design artifacts are accepted and checked, while implementation, signed-installed, live, deployed, security-review, documentation, and delivery evidence remain unverified.

### Accepted #236 artifact set

| Artifact | SHA-256 |
|---|---|
| docs/architecture/icloud-credential-authority-check.v1.mjs | 3368a67d75525ba057b6382199de3e33ee4e235c4c34db13b6b7faf578dc3605 |
| docs/architecture/icloud-credential-authority-coverage.v1.md | 6f567a5973a3050d265c92881d093d9c3c7e9467c110d8b6d40e488175221f47 |
| docs/architecture/icloud-credential-authority-decisions.v1.md | a6af40637d1aa4e3642d2c38e465a99d2c25caab312b4e692f30ab84e2f89c84 |
| docs/architecture/icloud-credential-authority-design.v1.md | 1068bbccf0de7054baaf604e38bf30a3dd400543585bcca2779e0ff33d5fcc28 |
| docs/architecture/icloud-credential-authority-oracle.v1.json | 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c |

### CRED-01..CRED-08 traceability

| ID | Demonstrated defect | Invariant | Planned control | Faithful executable proof | Owner | Held issue | Dependency | Source / artifact reference | Evidence tier | Current evidence status |
|---|---|---|---|---|---|---|---|---|---|---|
| CRED-01 | no usable credential-provisioning path | one signed secure-paste ceremony stores only in Keychain | Use one signed secure-paste ceremony; the native broker writes directly to Keychain and returns only an opaque reference; reject argv, stdin, environment, file, config, HTTP, log, result, transcript, evidence, and backup paths. | Connect positive plus plaintext negative matrix exercises the signed broker/Keychain path and every forbidden sink, asserting only an opaque reference and no raw secret. | credential-provider implementation | #153, #177, #215 | #236 accepted at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb; oracle 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c; DOWNSTREAM-PLAN before held work | oracle.planningRows.CRED-01; oracle.coverage.REQ-CRED-01; icloud-credential-authority-oracle.v1.json; icloud-credential-authority-coverage.v1.md | design; local; signed-installed; live-read-only; security | design accepted and checker-verified by #236; implementation and local, signed-installed, live-read-only, deployed, security, documentation, and delivery evidence unverified |
| CRED-02 | signed construction, background access, first unlock, and peer authority unresolved | acyclic nested signing, challenge-first symmetric exact peers, and AfterFirstUnlockThisDeviceOnly | Freeze inside-out signed bundle construction, exact principal/profile/access-group and user LaunchAgent topology, challenge-first symmetric XPC hello, and AfterFirstUnlockThisDeviceOnly Keychain behavior. | SBUILD topology/tamper, peer hello, principal, and first-unlock matrices reject wrong UID/team, unsigned or resigned peers, and pre-first-unlock retry. | credential-provider implementation and signed qualification | #167, #168, #183 | #236 accepted at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb; oracle 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c; DOWNSTREAM-PLAN before held work | oracle.planningRows.CRED-02; oracle.coverage.REQ-CRED-02; icloud-credential-authority-oracle.v1.json; icloud-credential-authority-coverage.v1.md | design; local; signed-installed; deployed; security | design accepted and checker-verified by #236; signed-installed, deployed, security, documentation, and delivery evidence unverified |
| CRED-03 | non-atomic Keychain/config/removal writes, receipt exhaustion, and interruption | one actor journals before effect; REC-00..REC-15 and REM-00..REM-17 converge; request 257 rejects before UI/effect | Make one LocalAccountAuthorityActor journal before every effect; enforce REC-00..REC-15, REM-00..REM-17, the finite recovery map, a 256-record receipt cap, admission before UI/effect, and no orphan or fallback. | All crash/compensation/rerun/removal/capacity rows prove convergence, bounded receipts, exact target absence, and no duplicate effect. | sole actor/journal and local-command implementations | #171, #175, #183, #215 | #236 accepted at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb; oracle 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c; DOWNSTREAM-PLAN before held work | oracle.planningRows.CRED-03; oracle.coverage.REQ-CRED-03; icloud-credential-authority-oracle.v1.json; icloud-credential-authority-coverage.v1.md | design; local; signed-installed; deployed; security | design accepted and checker-verified by #236; local, signed-installed, deployed, security, documentation, and delivery evidence unverified |
| CRED-04 | revoked credential, authBlocked, rotation, and retry bounds | strict newer-revision release and zero blocked retry | Bind authentication to credential generation; final full-address rejection enters authentication-blocked; only a strictly newer validated revision releases it; share one three-session and two-delay budget with zero blocked retry. | All authentication rows cover equal/older/newer revisions, structural and transient failures, the five candidate schedules, and the final authentication-blocked outcome. | connection/recovery implementation | #168, #177, #185 | #236 accepted at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb; oracle 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c; DOWNSTREAM-PLAN before held work | oracle.planningRows.CRED-04; oracle.coverage.REQ-CRED-04; icloud-credential-authority-oracle.v1.json; icloud-credential-authority-coverage.v1.md | design; local; live-read-only; security | design accepted and checker-verified by #236; local, live-read-only, signed-installed, deployed, security, documentation, and delivery evidence unverified |
| CRED-05 | backup, restore, reinstall, removal, and Apple revocation conflated | secret-free backup and four distinct removal authorities | Exclude raw secrets and Keychain exports from backup; restore without the exact same-device item enters credentials-required; keep daemon uninstall, local item removal, archive deletion, and Apple-side revocation distinct. | Restore/reinstall/remove/uninstall rows assert secret-free restore, exact local absence, preserved archive, and no false Apple-revocation claim. | local-command implementation and qualification | #175, #183, #217 | #236 accepted at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb; oracle 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c; DOWNSTREAM-PLAN before held work | oracle.planningRows.CRED-05; oracle.coverage.REQ-CRED-05; icloud-credential-authority-oracle.v1.json; icloud-credential-authority-coverage.v1.md | design; local; signed-installed; deployed; security; documentation | design accepted and checker-verified by #236; local, signed-installed, deployed, security, documentation, and delivery evidence unverified |
| CRED-06 | production connection factory and live-provider closure absent | only exact-ref resolution reaches the declaration-pinned constructive listOnly:true adapter and runtime-pinned ImapFlow with three total sessions and two delays | Resolve only the exact opaque reference through the production factory; constructively type listOnly:true against pinned ImapFlow 1.7.1 declarations/runtime; enforce all five allowlist/denylist branches, three total sessions, and two delays with no mailbox, body, or mutation command. | Real TypeScript compile fixture, installed five-branch LIST transcript, shared-attempt schedules, production adapter, live authentication, and secret-lifetime rows prove the allowlist and denylist. | connection/recovery implementation and live qualification | #153, #168, #177, #185 | #236 accepted at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb; oracle 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c; DOWNSTREAM-PLAN before held work | oracle.planningRows.CRED-06; oracle.coverage.REQ-CRED-06; icloud-credential-authority-oracle.v1.json; icloud-credential-authority-coverage.v1.md | design; local; signed-installed; live-read-only; security | design accepted and checker-verified by #236; local, signed-installed, live-read-only, security, documentation, and delivery evidence unverified |
| CRED-07 | local administration could be confused with public bearer authority | authenticated local XPC registry is absent from HTTP/OpenAPI/demo | Keep the authenticated local XPC registry outside HTTP, OpenAPI, bearer, and demo authority; enforce signed challenge-first broker admission and production/demo isolation. | Broker, public-reachability, and demo-isolation rows assert zero public operation registration, zero wrong-peer payload access, and zero production/provider import or fallback in demo. | credential-provider and local-command implementations | #183, #215, #221 | #236 accepted at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb; oracle 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c; DOWNSTREAM-PLAN before held work | oracle.planningRows.CRED-07; oracle.coverage.REQ-CRED-07; icloud-credential-authority-oracle.v1.json; icloud-credential-authority-coverage.v1.md | design; local; signed-installed; security | design accepted and checker-verified by #236; local, signed-installed, deployed, security, documentation, and delivery evidence unverified |
| CRED-08 | guided and structured setup could fork behavior | one local schema/state/outcome model and setup orchestration only | Use one local request/result/error/state/semantic/exit/journal model and generated views; guided setup orchestrates only the canonical actor and provides no second credential or plaintext path. | Guided/structured and setup/direct parity rows assert identical operation, error, state, semantic, exit, journal, and effect outcomes with presentation-only differences. | local-command implementation and #215 | #215, #217 | #236 accepted at commit 3757dfe85bdd9fbeec014f4c183ebfc9fa80effb; oracle 9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c; DOWNSTREAM-PLAN before held work | oracle.planningRows.CRED-08; oracle.coverage.REQ-CRED-08; icloud-credential-authority-oracle.v1.json; icloud-credential-authority-coverage.v1.md | design; local; deployed; security; documentation | design accepted and checker-verified by #236; local, deployed, security, documentation, and delivery evidence unverified |
