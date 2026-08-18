# Agent Mail planning failure shields

Use these shields when creating a plan or revising one after review. They are reusable planning constraints, not claims that a current implementation is defective.

## Evidence precedence

1. A minimal reproduction or direct source proof of a user-visible failure.
2. A composed-path or production-adapter test.
3. A boundary contract test.
4. An isolated unit test.
5. Static checks and implementation snapshots.

A lower tier cannot negate a failure demonstrated at a higher tier.

## Required composed seams

| Seam | Failure shield | Faithful proof |
|---|---|---|
| Ingestion | Promotion and routing share one recoverable commit protocol. | Inject failure between steps; restart; prove the message reaches exactly one correct lane. |
| Remote mutation | Each target records intent, attempt, result, and uncertainty durably. | Let IMAP succeed, fail the result write, restart, reconcile remote state, and avoid blind replay. |
| Runtime control | API success follows an observed actor transition. | Exercise real actor acknowledgements for start, pause, resume, failure, and authentication block. |
| Recovery | Backup covers SQLite, raw EML, attachments, manifest, and configuration needed to restore. | Restore into an empty directory and prove search, raw fetch, attachment fetch, labels, routing, and action history. |

## Required parity matrices

- Existing-message routing and future-arrival routing use the same normalized predicate.
- API and CLI share request and response schemas, error codes, commit state, streaming semantics, and timeouts.
- Storage and routes agree on not-found, empty-result, invalid-query, and tombstone behavior.
- Actor state and public status agree after accepted, rejected, failed, cancelled, and completed events.

## Test-double contract

Fakes must preserve production shapes and behavior for optional values, empty collections, normal completion, errors, cancellation, ordering, and backpressure. Run reusable adapter contracts against both the fake and the production adapter when no safe live equivalent exists. Check installed SDK behavior at protocol boundaries; do not invent fields that a fake happens to return.

## Capacity boundaries

The performance plan must include all of these:

- representative 250,000-message search latency;
- a 250 MiB attachment with bounded process memory;
- sparse high UIDs with round trips proportional to actual changes, not maximum UID;
- selected export whose work is proportional to selected messages;
- slow stdout or network consumers with bounded buffering;
- explicit connect, control-request, and stream-idle timeout semantics.

## Outcome-based operations

- `doctor` uses integrity and foreign-key violation checks and returns diagnoses without erasing details.
- `backup` passes a destructive restore drill in an isolated directory.
- launchd uninstall leaves neither a loaded service nor an installed plist.
- Tailscale setup changes only the owned Serve entry and verifies the exact active configuration.
- Sensitive path checks fail closed without silently broadening access or mutating unrelated paths.

## Promotion language

Use these evidence states:

- `specified`: the requirement and proof are defined;
- `implemented`: source exists but the proof has not passed;
- `locally verified`: static, isolated, and required composed probes pass;
- `live verified`: authorized external behavior passed;
- `deployed verified`: launchd, Tailscale, permissions, restart, and restore passed on the target host;
- `release-ready`: every required traceability row and dedicated security gate passed, with no undeclared gaps.

Never substitute `tests pass` for one of these states.

## SEC-R05 Daybreak structural shields

These rows are required planning authority and are synchronized with `PLAN.md` and `docs/planning/EVIDENCE.md`. The checker validates the table schema, unique IDs, owner issue, intervention timing, status, and the required control/proof shape. It cannot establish that an implementation or external review actually passed; those remain evidence obligations.

| ID | Demonstrated counterexample | Invariant | Planned control | Faithful executable proof | Owner issue | Intervention timing | Evidence status |
|---|---|---|---|---|---|---|---|
| F09-P | Historical F09 bundled bearer executor impersonation with expired-plan recovery; public bearer routes could reach executor capabilities. | Public credentials cannot invoke claim, resume, or finalize capabilities reserved for the internal actor. | Keep executor capability internal, enumerate every route/scope, and reject every bearer path before any effect. | Enumerate routes/scopes and exercise bearer profiles against executor calls; assert zero executor effects and stable denial. | #183, #185 | Stage 2 before action CLI/live mutation/final security qualification. | specified; release-blocking |
| F09-R | Historical F09 bundled public reachability with a persisted undispatched attempt recovered after plan expiry; creation-time expiry did not protect recovery dispatch. | After authority expiry, no new remote effect begins; only an already-dispatched uncertain attempt may reconcile read-only. | Revalidate authority and expiry immediately before every new effect, including recovered attempts and later targets; classify expired undispatched attempts durably. | Recover an undispatched attempt after expiry; assert zero mutation-adapter calls and a durable non-executing result; repeat between targets. | #202, #183, #185 | Stage 2 before action CLI/live mutation; Stage 4 closure. | locally verified by `packages/daemon/test/action-plan-restart-recovery-p5-c17.test.ts` and `action-plan-target-loop-p5-c15.test.ts` at `df02745`; Stage 4 release-blocking |
| SEC-R01 | Same expired-undispatched recovery counterexample as F09-R. | No fresh external effect is admitted after plan authority expiry. | One per-effect authority guard with constructive expired-versus-dispatched states and read-only reconciliation. | Crash after persisting an undispatched attempt, restart after expiry, and retain remote-call traces plus durable terminal snapshots. | #202 | Stage 2 before dependent action work; Stage 4 closure. | locally verified by `packages/daemon/test/action-plan-restart-recovery-p5-c17.test.ts` at `df02745`; Stage 4 release-blocking |
| SEC-R02 | A bearer with authorize and commit scopes can self-mint approval; durable evidence stores only a scope and accepts caller-spoofed principal data. | An unattended acting credential cannot mint the independent approval it consumes, and principal/profile provenance survives restart/restore. | Freeze #203 before #204; persist trusted provenance, exact digest/targets/intent/version, expiry, nonce, and one-use consumption; fail closed for scope-only rows. | Reject self-approval, spoofed principal, changed authority fields, replay, concurrent consume, and restart-around-consume with zero unauthorized effects. | #203, #204 | Stage 2: #203 before #204/action CLI/live mutation; Stage 4 closure. | locally verified by `packages/daemon/test/action-approval-service-composed.test.ts` and `packages/storage/test/action-approval-authority.test.ts` at `9d1f777` against oracle `8e2f7d72…`; Stage 4 release-blocking |
| SEC-R03 | A valid wrong-scope bearer can send an unlimited chunked JSON body; ingress materializes JSON before exact-scope and byte admission. | Authenticate, authorize exact scope, and enforce received-byte/item/time budgets before materialization, including streaming input. | One bounded streaming admission helper rejects wrong scope and oversize before parsing and retains stable errors. | Exercise declared and chunked/slow/aborted bodies with correct and wrong-scope credentials; assert zero wrong-scope reader/handler calls and bounded memory. | #205, #176 | Stage 2 before OpenAPI/route integration; Stage 4 resource-bound rerun. | locally verified by `packages/daemon/test/http-admission-sec-r03.test.ts` at `44a0b28`; Stage 4 #176 release-blocking |
| SEC-R04 | Untrusted subject text containing OSC 52 or carriage return can forge terminal output; input schemas do not protect human rendering. | Human output cannot emit terminal controls or overwrite trusted chrome while structured and raw semantics remain faithful. | Centralize typed human, structured, report/log, and raw contexts with hostile corpus and TTY policy. | Run ESC/CSI/OSC, CR/backspace, C0/C1, bidi, links, and filenames through each context and assert context-specific bytes/postconditions. | #206, #183, #185 | Stage 2 before human CLI renderers; Stage 4 CLI/security closure. | locally verified by `packages/cli/test/output-context.test.ts` at `20e4d0e`; Stage 4 #183/#185 release-blocking |
| SEC-R05 | A direct client can supply Tailscale/proxy identity headers over a backend path and appear to be the trusted owner. | Intermediary identity is trusted only across a verified hop; direct header copies are stripped/overwritten before authorization. | Define topology, direct-backend policy, owner mapping, and header allowlist; verify owned Serve state. | Exercise direct requests with spoofed/missing/stale/wrong-owner headers versus a verified intermediary request; retain topology/config evidence. | #180, #183 | Stage 2 planning/deployment prerequisite; Stage 4 deployed security qualification. | specified; release-blocking |
| SEC-R06 | A client or stored record can tamper with or replay keyed previews, content digests, nonces, versions, or target summaries. | Commitments are recomputed from canonical current inputs at every consume/reuse boundary; mismatch/replay cannot authorize effects. | Bind canonical intent, targets, plan/version, nonce, and content digest to server authority and recompute before reuse. | Tamper/replay each field with changed targets and restored state; assert rejection before effect and matching audit evidence. | #183, #185 | Stage 1 planning; Stage 2 implementation; Stage 4 security/finding closure. | specified; release-blocking |
| SEC-R07 | An advisory scan can be green while a vulnerable transitive dependency is reachable, or an old exception lacks an owner/removal condition. | Dependency decisions combine advisories with installed reachability, affected-version proof, exception owner/removal condition, and release recheck. | Require exact inventory, reachability proof, explicit exception record, and bootstrap/release recheck; stale exceptions fail qualification. | Pair advisory output with installed graph/runtime reachability and assert every exception has owner/removal condition/current recheck. | #183, #185 | Stage 1 dependency policy; Stage 4 release qualification. | specified; release-blocking |
