# Agent Mail implementation plan

Status: evidence-backed planning baseline; implementation not started.

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
| S10 | required | The product indexes private email and exposes identity, bearer, report, filesystem, and mutation boundaries. ChatGPT cybersecurity access is pending; the complete applicable security lane remains a release blocker until run. |
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
- Implement search-first skill behavior, explicit body/raw/attachment retrieval, untrusted-email markers, source citations, sanitized Markdown reports, strict CSP, and text-only source views.
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
- Run a bounded system-mode `evidence-first-review` on the release candidate. Route lanes from the actual manifest. Once ChatGPT cybersecurity access is granted, run the complete applicable security lane without the earlier permission-driven truncation and record any residual gaps.
- Run check-only static gates, the full local suite, composed matrices, capacity gates, live read smoke, explicit live mutation smoke if Phase 1 claims mutation readiness, deployed operations, README command walkthrough, and backup restore.
- Commit intentionally, verify the exact branch/HEAD and clean scope, then record remote delivery separately if requested and available.

Exit evidence:

- No release-blocking traceability row is open. Review reports `no confirmed findings` for the frozen candidate or all findings have a separately verified repair seam.
- Evidence states distinguish locally verified, live verified, deployed verified, security reviewed, and delivered. Missing external proof keeps only the affected promotion gate closed.

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
- The source audit's security work was partial. ChatGPT cybersecurity access is pending; applying for access is not security evidence, and release qualification remains blocked until the complete applicable lane is run.
- Remote IMAP effects cannot be atomically committed with SQLite. `uncertain` plus reconciliation is an explicit design obligation, not a solved exactly-once guarantee.
- The package snapshot was current on 2026-08-17, but bootstrap and release must recheck latest stable releases, peer and engine compatibility, advisories, and installed behavior. Current Apple, ImapFlow, SQLite, and Tailscale behavior still requires primary-documentation and installed-version verification during implementation.
