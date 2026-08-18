# P3-C15 independent sync-statechart review

Status: **candidate.7 rejected; reviewer signature withheld for one high/consequential terminal-error contract defect**.

Review mode: independent whole-artifact adversarial review of candidate.7, every retained R189-01 through R189-19 disposition, the accepted planning/public/frozen-source contracts, installed XState 5.32.5 semantics, and every checked view. The reviewer independently reproduced the evidence at Sol/ultra without decomposition or inherited designer conclusions.

Target:

- Candidate provenance commit and shared-worktree HEAD: `c7002f436a0b7372bb098e8fdc4dee92ef2a2f14`
- Normative model: `docs/architecture/sync-statechart.model.json`
- Candidate version: `1.0.0-candidate.7`
- Candidate digest: `cfca5ae69d1cdeac8df628a0ebe0a02bbd20f5a7b512a0aafd2835433bd9a14e`
- Companion hashes: statechart `af23148ee99ccb5dc41aa641d8443adb9b9981666062070dbd0bae1f8b9cf96a`; decisions `b10effc39b02464790adf59619ee12c18fb68d50208c183afc36d9111480b304`; coverage `2ee855d12843ccf5f5042c7ad504c4120148f79e1c60b174acf4ef3f3e68e632`
- Retained candidate.6 ledger: commit `5b00de5`; SHA-256 `6034f1d16d7cc419ffa96a2f9db36bf364b26fee4e64108821d4b21d0adaa760`
- Accepted planning hashes: PLAN `a4b2c93d9ae47369e6893be0a7eace854fce9dccda14bd0d138d9c98b63a2afc`; EVIDENCE `544c1ee220e13b96dc88aa71096701a3887fb1adba22e9b8d60a244533f50cc9`
- Accepted sync contract pin: `packages/contracts/src/sync-operations.ts` at `74a32d41a636ac2334d8245f1043fb6cf76e8bacd9f30895f5475e16dc0817a8`
- Accepted error registry pin: `packages/contracts/src/error-envelope.ts` at `f02a6f25dfd884aa717f136e4024f550697a3d1a32b8cafd5bad84eaf27ae934`
- Accepted P3-C10 pin: commit `b6d07bc56e775cc7aea4b9436b81532bba7c4e9a`, source SHA-256 `89b3eee13a5846be92b16d2e657c197f1d4ee0e5ee90fca0d0a2a542d57692e8`
- Accepted P3-C11 pin: commit `d5107472ffae6f5eb4deb8b87365ffda40fe30d3`, source SHA-256 `506f9dc2dff6affc311f1143a1f5d901f53bc5157836338c497a43332ec5db7f`
- Accepted P3-C07 pin: commit `e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae`; queue SHA-256 `b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67`; accepted-test SHA-256 `53146a3be9ddb66fa9374ad04ed59fca533601c0daa8f07e51925292c68f583f`; adapter SHA-256 `373be897143cac27423c4857db9f2f8d7a8b96239034a8ad72444d56d579b9a2`
- Review contract: GitHub issue `#189`; accepted public-contract authority: issue `#196`; accepted queue authority: issue `#98`
- Reviewer execution profile: Sol, `gpt-5.6-sol`, `ultra`

## Result for candidate.7

Candidate.7 is rejected for implementation and its exact digest is **not signed**. Both advertised repairs work at their stated boundaries. R189-18 now has one sealed 13-leaf `CleanupCertificate` shared by both terminal contracts, every consumer, both guards, cleanup diagnostics, cleanup admission, and GEP05. R189-19 now gives the incarnation registry a linearized four-state retirement lifecycle, immutable source/phase evidence, deduplication before capacity admission, capacity before generation allocation/acquisition, never-reused generations, exact 4096/16384-plus-three bounds, and byte-identical retiring/reference certificates in all eight phase cases. The 10,000-cycle fixture retires all 20,000 entries without closure or generation reuse.

The whole review found R189-20. The declared cleanup error is structurally `WorkflowFault`, whose authority admits authentication, transient, permanent, and invariant categories, but every cleanup-error transition additionally requires `faultIsFatal`, which admits only permanent or invariant. A current first terminal with an exact valid certificate and an authentication or transient category therefore matches neither T145/T171/T183/T185 nor GEP03/GEP05. An actual `fromPromise` rejection at that seam makes the XState root actor enter status `error` while retaining the cleanup state value, outside every modeled/public terminal.

Current unresolved totals are zero critical, one high, zero medium, and zero low. There is one unresolved consequential finding. No other consequential contradiction was reproduced.

## Candidate.7 complete finding disposition

| Finding | Candidate.7 severity/status | Mechanical disposition |
| --- | --- | --- |
| R189-01 | Critical resolved | All 13 cleanup states bind the exact registry/context epoch, phase, lease, effective scope, release-set identity, immutable terminal, state minimum scope, and zero-audit certificate admission. |
| R189-02 | High resolved | T117/T118 retain the accepted P3-C10 four-field non-CAS completion save. |
| R189-03 | High resolved | T150/T156 retain the accepted shared completion repository and atomic checkpoint/completion write; T157/T158 write nothing. |
| R189-04 | High resolved | All 15 context fields have literal or validated constructor initials; all 24 strict status projections pass empty/populated construction. |
| R189-05 | High resolved | Terminal diagnostic policy and reachability distinguish childless `stopped.clean` from `stopped.failed`. |
| R189-06 | High consequential resolved | The model and issue-196 contract retain the same exhaustive 85-cell resolver, seven settlements, exact cache/waiter effects, and six strict registered errors. |
| R189-07 | High consequential resolved | Every status, success observation, and non-success last observation requires incarnation identity; different incarnations remain unordered. |
| R189-08 | High resolved | Ordered credential revision/fault branches remain complete across bootstrap, backfill, both IDLE event orders, and sweep. |
| R189-09 | High resolved | Shutdown covers every atomic source, starts no later child, and terminates through certified cleanup in childless `stopped.shutdown`. |
| R189-10 | Medium resolved | Both queue references and the frozen Git object match issue 98 exactly. |
| R189-11 | Low resolved | The oracle contains 27 guards and 27 checked guard branches; all references and generated counts agree. |
| R189-12 | High consequential resolved | Current pending/cached, watch-to-workflow promotion, and equal-scope replacement preserve phase/set identity and settle once across success and error. |
| R189-13 | Low resolved | PROP-08 constructs U01 through U17 and all 17 forbidden configurations are retained. |
| R189-14 | Low resolved | GEP04 and GEP06 retain the accepted terminal-shutdown credential and stop policy. |
| R189-15 | High consequential resolved | Acquisition-time registration, first-freeze revocation, trigger-only disposal/abort, all eight phase cases, zero-resource audits, and literal T097 reentry pass under installed XState 5.32.5. |
| R189-16 | High consequential resolved | Exact frozen P3-C07 composition retains one parent composite terminal that aliases one `queue.stop()` promise and transitively waits for the private queue subtree without changing its API. |
| R189-17 | Low non-consequential resolved | Global policies project 7/7 across ID, ordered events, literal condition, ordered actions, and literal result; GEP05 includes every certificate-invalidity clause. |
| R189-18 | **High consequential, resolved** | One exact sealed 13-leaf `CleanupCertificate` closes both terminal contracts, all eight consumers, all three 12-leaf semantic read sets, and the checked Markdown view. |
| R189-19 | **High consequential, resolved** | Registry-owned evidence publication precedes entry/key/closure retirement; bounds, admission order, generation exhaustion, 10,000-cycle churn, eight phase cases, and certificate byte parity pass. |
| R189-20 | **High consequential, open** | Cleanup-error transitions are not exhaustive over their declared `WorkflowFault` category union; a valid current authentication/transient rejection terminates the XState root in unmodeled status `error`. |

### R189-20: cleanup terminal error type and dispatch are not closed over the same categories

- Lane: TypeScript/event contract, XState terminal semantics, cleanup/recovery ownership, and public observation completeness.
- Normative contradiction: `faultType.WorkflowFault.categories` is `authentication|transient|permanent|invariant`; `events[xstate.error.actor.cleanupBarrier]` declares `error:WorkflowFault`; and `actors.cleanupBarrier.errorType` is `WorkflowFault`. The four cleanup-error transitions T145, T171, T183, and T185 all require `cleanupFailureCertificateCoversState` followed by `faultIsFatal`, whose predicate is only permanent or invariant. GEP05 tests certificate validity, not fault category. GEP03 tests exited/duplicate invoke identity, not a current first terminal.
- Prose is not structural closure: the actor's `error` sentence says invariant-only, while its exact named error type remains the four-category authority and the transitions additionally admit permanent. A TypeScript implementation generated from the named contract can therefore reject with either nonfatal discriminant without violating the structural payload type.
- Concrete counterexample: enter `watching.closingForPause`; let the current `cleanupBarrier` reject once with `error.category=authentication` and an otherwise exact current `CleanupCertificate` whose epoch, phase, lease, scope, release set, certificate/audit identity, literal `released:true`, and zero audit all match. `cleanupFailureCertificateCoversState` passes, `faultIsFatal` fails, GEP03 is false, and GEP05 is false. The same guard gap expands to all 13 cleanup states through T145/T171/T183/T185.
- Installed-runtime result: XState 5.32.5 does not leave this as an ordinary ignored external event. The invoked promise has rejected and no transition handles its error, so the root snapshot becomes `{value:"closingForPause", status:"error", snapshotError:"authentication"}`. The transient variant is identical. Permanent and invariant variants take the modeled failure transition. The root-error result has no state row, public projection, retry/auth disposition, cleanup completion, or control settlement.
- Violated accepted invariant: the candidate is not an exhaustive lifecycle oracle for its own typed actor terminal; PROP-07's no-deadlock/progress claim, PROP-09's global disposition for every known locally illegal event, PROP-15's cleanup error ordering, and issue 189's terminal/public-observation completeness requirement cannot all hold.

Bounded repair packet:

1. Freeze one exact shared cleanup-terminal error authority and use it in `cleanupBarrier.errorType`, the error event, the actor implementation boundary, and transition-category closure. The owner must decide whether the allowed discriminant is invariant-only or permanent/invariant; the reviewer does not choose between those advertised semantics.
2. Alternatively, retain the full four-category `WorkflowFault` contract and define explicit current-valid-certificate authentication/transient transitions or policies, including their retry/auth/public-control outcomes. Do not rely on an actor prose sentence to narrow a broader named type.
3. Add a structural discriminant-closure check and actual `fromPromise` rejection probes for all four categories in every one of the 13 cleanup states. Assert that each current first terminal reaches one modeled outcome, no root snapshot has status `error`, and stale/invalid-certificate GEP03/GEP05 cases remain separate.

## Candidate.7 manifest and acceptance audit

Selected review lanes were domain/value, public contract, lifecycle/resource, security/trust, persistence/recovery, concurrency/workflow, performance/capacity, external protocol, and operations. Accessibility was not applicable because the artifact exposes no user interface.

| Behavioral seam | Evidence status | Result |
| --- | --- | --- |
| Exact target and frozen inputs | Commit/object hashes, live issue reads, and worktree byte comparison | Exercised: candidate, retained ledger, planning, contracts, P3-C10, P3-C11, and P3-C07 queue/test/adapter all match their pins. |
| Structural graph and references | Independent schema/reference/reachability verifier | Exercised: 24 atomic states, 91 definitions, 204 expanded transitions, 24 events, 27 guards, 24 actions, 10 actors, one named type, nine configuration fields, 15 context fields, 22 invariants, 17 forbidden configurations, 16 properties, 24 state paths, 85 resolver cells, 19 responses, and 13 cleanup states; all atomic states are reachable. |
| Candidate/model/view parity | Exact transition, global-policy, certificate, slot, retention, churn, state, guard, path, source-exit, response, and resolver projections | Exercised: transitions 91/91 across nine fields; policies 7/7 across five; certificate 13/13; resolver 85/85; every checked projection matches. |
| CleanupCertificate closure | Independent authority/reference/read-set expansion | Exercised: one sealed authority, 13 exact leaves, four constraints, both terminal contracts, eight consumers, and three identical 12-leaf semantic read sets pass. R189-18 is resolved. |
| Registry retirement and capacity | Exact-lifecycle reference models and bounds | Exercised: evidence-before-delete, dedup-before-capacity, capacity-before-generation/acquisition, 4096 entries, 16384 retained records plus three envelopes, MAX_SAFE generation once then exhaustion, and old-handle isolation pass. |
| Long-incarnation and phase parity | 10,000-cycle churn plus retiring/reference matrix | Exercised: 20,000 unique increasing generations and matching once-only releases end at zero entries; all eight current/cached/promotion/equal-scope success/error certificates are byte-identical. R189-19 is resolved. |
| Public identity, errors, and resolver | Model-to-contract expansion, strict Zod fixtures, and focused tests | Exercised: 24 status projections, same/cross-incarnation ordering, 85 cells at 18/21/25/21, seven settlements, and six exact errors; 14 tests and 561 expectations pass. |
| Durable facts and reconstruction | Frozen-source hashes plus transition/write projection | Exercised: P3-C10 already-complete and completed paths, P3-C11 completed/not-eligible paths, and empty/populated reconstruction retain the accepted contracts. |
| Installed XState ordering and T097 | Direct XState 5.32.5 callback/promise/self-target probes | Exercised: freeze/input precede disposal/abort and target start; literal T097 reentry stops/starts the child while default self-target does not. |
| Exact P3-C07 composition | Frozen source/test hashes, accepted tests, and production-adapter composite probe | Exercised: four tests/14 expectations pass; one registered composite trigger aliases exact `queue.stop()`, rejects queued work, aborts active work, and settles after response/staging/finally cleanup. |
| Cleanup terminal category dispatch | Static 13-state expansion plus actual four-category promise rejection | **Failed: R189-20.** Authentication/transient declared errors produce root status `error`; permanent/invariant take modeled failure. |
| Credential, shutdown, illegal, and adjacent events | State/event construction and counterexample probes | Exercised: both IDLE credential orders, all 24 shutdown sources, 22 local plus two terminal credential sources, global illegal routing, childless paused entry, late actor completion, and observed pause settlement pass. |
| Candidate preservation and integrity | Candidate.6 semantic comparison, planning/format/JSON/whitespace/diff/protected-file gates | Exercised: the transition graph, state/context/public/durable contracts, 22 non-cleanup events, 25 non-cleanup guards, and prior responses remain exact; only this retained review ledger changes. |

## Candidate.7 checks and adversarial probes

All commands ran from `/Users/john/.codex/worktrees/efa7/agent-mail`. No live iCloud access, remote mutation, launchd, Tailscale, candidate/public/production edit, commit, push, issue edit, metrics edit, or other GitHub mutation was performed. Only this review ledger was changed.

| Evidence | Exact command or probe | Exit | Result |
| --- | --- | ---: | --- |
| E81 | `gh issue view` reads for 189, 188, 196, 98, 57, 117, and 120; `git rev-parse`; SHA-256 over planning, candidate, contracts, frozen Git objects, queue/test/adapter, and retained ledger | 0 | Exact candidate.7, issue contract, complete prior history, and every accepted authority established. |
| E82 | Independent Bun unique/reference/reachability, actor-delta, event, cleanup-input, generated-path, response, source-exit, and T097 verifier | 0 | Counts match the manifest; 24/24 atomic states reachable, 204/204 actor deltas and 24/24 event semantics resolve, 13/13 cleanup inputs pass, and unique T097 has literal `reenter:true`. |
| E83 | Independent JSON-to-Markdown transition/global-policy/certificate/retirement/state/guard/path/source-exit/response/resolver parsers | 0 | 91/91 transitions, 7/7 policies, 13 certificate leaves/four constraints/ten references/three read sets, 24/24 states, 27/27 guards, 24/24 paths, 8/8 source-exit cases, 19/19 responses, and 85/85 resolver cells match. |
| E84 | CleanupCertificate structural authority/consumer/read-set verifier | 0 | One sealed exact type closes both terminal events and all eight consumers; every semantic read is present in both terminal contracts. |
| E85 | Direct model-to-contract resolver/status/error expansion; `bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts` | 0 | 24 strict status fixtures, six error registrations, five operations, cross-incarnation unordered comparison, 85 cells, 14 tests, and 561 expectations pass. |
| E86 | Frozen P3-C10/P3-C11 Git-object hashes and model durable-write projection | 0 | Frozen hashes are exact; T117/T118 write all four completion fields, T150/T156 retain the shared atomic write, and T157/T158 write nothing. |
| E87 | Installed-XState 5.32.5 callback/promise exit-order and default-self versus reentry probes | 0 | Callback/promise order is source start, source exit, transition freeze, target entry/input, source dispose/abort, target start. Default counts are 1/0/1/0 and reentry counts are 2/1/2/1 for starts/stops/entries/exits. |
| E88 | `bun test packages/imap/test/raw-download-queue-p3-c07.test.ts`; exact production-adapter composite probe | 0 | Four tests/14 expectations pass. Registration precedes construction; one trigger aliases exact stop; queued/active rejection and response destroy, stage abort, stage cleanup, and final stopped ordering pass. |
| E89 | Deterministic 10,000-cycle retirement/dedup/capacity/generation/old-handle probe | 0 | 20,000 allocations, generations, and releases are unique/increasing/once-only; peak/end entries are 1/0; dedup wins at capacity; MAX_SAFE is allocated once and the next new key faults before acquisition. |
| E90 | Maximum-retention and eight-case retiring/reference phase-certificate probes | 0 | 4096 entries plus three 4096-record snapshots equal 16384 records and three envelopes; all eight success/error certificates are byte-identical with 13 exact leaves and zero audits. |
| E91 | Static cleanup-error expansion plus installed-XState four-category rejection probe | 0 | Reproduced R189-20: all 13 states use T145/T171/T183/T185 with fatal guard; authentication/transient yield root `error`, permanent/invariant yield modeled `failed`. |
| E92 | Known-event/global-policy, credential-order, and shutdown-source constructor | 0 | No unrouted known state/event pair; shutdown covers 24/24 sources; credentials use 22 local plus two terminal-policy sources; bounded and IDLE revision/fault orderings pass. |
| E93 | Adjacent paused/live-child/late-completion/public-observation counterexample | 0 | `paused` owns zero children; only childless authBlocked enters directly, every live source first enters cleanup, late bounded actor results use GEP03, and pause completes publicly only at paused. |
| E94 | Candidate.6-to-candidate.7 protected semantic comparison | 0 | States, all 91 transitions, context, durable/public/initialization contracts, 22 non-cleanup events, 25 non-cleanup guards, 21 unrelated actions, and six unrelated global policies are byte-identical. |
| E95 | `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py`; candidate-only `bunx vp fmt --check`; `jq empty`; final-newline, trailing-whitespace, scoped `git diff --check`, protected-file byte comparisons, and final hashes | 0 | Planning and artifact integrity pass; four candidate artifacts remain byte-identical to `c7002f4`; prior ledger bytes are preserved after the deliberate candidate.7 prepend. |

Setup-only reviewer harness attempts that exited before candidate evaluation were corrected and rerun above: Markdown normalizers initially treated `none`, comma-separated actor lists, and prose actor-kind labels as literal JSON; one registry script had a field-name typo; one maximum-bound fixture populated workflow rather than watch slots; one public-contract probe used the wrong export name; and one frozen-source hash command used two wrong paths. One combined registry command exceeded the output capture and was replaced by the bounded E89/E90 probes. None is counted as candidate evidence or as a candidate failure.

## Candidate.7 signature

Reviewer signature for digest `cfca5ae69d1cdeac8df628a0ebe0a02bbd20f5a7b512a0aafd2835433bd9a14e`: **WITHHELD**.

Reason: R189-20 leaves the exact cleanup error contract broader than its transition/global-policy disposition. A valid current authentication or transient cleanup rejection exits the modeled lifecycle through XState root status `error`. Choosing a narrowed terminal fault authority or new retry/auth routing is a consequential design decision outside this reviewer's authority. A new candidate digest and fresh whole-artifact review are required before exact-digest consensus.

## Retained candidate.6 and earlier review records

Status: **candidate.6 rejected; reviewer signature withheld for two high/consequential oracle defects**.

Review mode: independent whole-artifact adversarial review of candidate.6, every retained R189-01 through R189-17 disposition, the accepted public and frozen-source contracts, installed XState 5.32.5 semantics, and the checked views. The reviewer independently reproduced the evidence at Sol/ultra. No designer conclusion is inherited as a disposition.

Target:

- Candidate provenance commit: `4bab74ec147dda30d918620b6a39dd5f0e411397`; the shared worktree HEAD advanced to `a59ec3a9eb0403c7924667f81e27f4d981235895` during review, but all four candidate artifacts remain byte-identical to the candidate commit
- Normative model: `docs/architecture/sync-statechart.model.json`
- Candidate version: `1.0.0-candidate.6`
- Candidate digest: `58a60c0cd6cc5ba86db294a3eb24b14107a0369825cda199351eb6e779a67a9a`
- Companion hashes: statechart `9dc9ef6fb4d4b68a74c2d416c64f1f7ad3779c25801130504c4fac0671e0f964`; decisions `002e251b46da2fe0842a81cc3f215faabb2e635a7c330126d7524f8b4e16eab8`; coverage `31c25ed3669a09ad9ebc1af7c83ed6684e575c0d3e901053b3b83f4049b9e7fb`
- Retained candidate.5 ledger: commit `120d1c8`; SHA-256 `e4e0061fbb7be7d130861e897b3ed834eaa99d326b87e729fcf43e2a57d94ea8`
- Accepted planning hashes: PLAN `a4b2c93d9ae47369e6893be0a7eace854fce9dccda14bd0d138d9c98b63a2afc`; EVIDENCE `544c1ee220e13b96dc88aa71096701a3887fb1adba22e9b8d60a244533f50cc9`
- Accepted sync contract pin: `packages/contracts/src/sync-operations.ts` at `74a32d41a636ac2334d8245f1043fb6cf76e8bacd9f30895f5475e16dc0817a8`
- Accepted error registry pin: `packages/contracts/src/error-envelope.ts` at `f02a6f25dfd884aa717f136e4024f550697a3d1a32b8cafd5bad84eaf27ae934`
- Accepted P3-C10 pin: commit `b6d07bc56e775cc7aea4b9436b81532bba7c4e9a`, source SHA-256 `89b3eee13a5846be92b16d2e657c197f1d4ee0e5ee90fca0d0a2a542d57692e8`
- Accepted P3-C11 pin: commit `d5107472ffae6f5eb4deb8b87365ffda40fe30d3`, source SHA-256 `506f9dc2dff6affc311f1143a1f5d901f53bc5157836338c497a43332ec5db7f`
- Accepted P3-C07 pin: commit `e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae`; queue SHA-256 `b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67`; accepted-test SHA-256 `53146a3be9ddb66fa9374ad04ed59fca533601c0daa8f07e51925292c68f583f`; adapter SHA-256 `373be897143cac27423c4857db9f2f8d7a8b96239034a8ad72444d56d579b9a2`
- Review contract: GitHub issue `#189`; accepted public-contract authority: issue `#196`; accepted queue authority: issue `#98`
- Reviewer execution profile: Sol, `gpt-5.6-sol`, `ultra`

## Result for candidate.6

Candidate.6 is rejected for implementation and its exact digest is **not signed**. Both advertised repairs work at their stated boundaries. R189-16 now has one parent-owned workflow composite slot registered before exact P3-C07 queue construction; its idempotent trigger calls `queue.stop()` once, its terminal adopts that exact promise, queued work rejects, and active response/staging/listener cleanup completes before the terminal. The frozen queue and private job receive no registry capability. R189-17 now projects all seven global policies through the exact five checked fields and GEP05 rejects a wrong certificate or audit release-set identity and a nonzero unresolved count.

The whole-oracle audit found two new contradictions outside those repaired rows. R189-18 makes the typed cleanup-success event narrower than the cleanup actor output and the only admission guard: it omits three certificate fields required to decide GEP05 safely. R189-19 leaves release-slot retirement unowned even though the registry lives for the actor incarnation and every sweep queue gets a unique parent-invoke slot ID. Literal retention grows without bound; ID reuse or early deletion changes cleanup safety unless phase snapshots and the retirement linearization point are frozen.

Current unresolved totals are zero critical, two high, zero medium, and zero low. There are two unresolved consequential findings. No other consequential contradiction was reproduced.

## Candidate.6 complete finding disposition

| Finding | Candidate.6 severity/status | Mechanical disposition |
| --- | --- | --- |
| R189-01 | Critical resolved | All 13 cleanup states bind state minimum scope plus exact registry/context epoch, phase, lease, effective scope, release-set identity, terminal, and zero-audit admission. |
| R189-02 | High resolved | T117/T118 retain the accepted P3-C10 four-field non-CAS completion save. |
| R189-03 | High resolved | T150/T156 retain the accepted shared completion repository and atomic checkpoint/completion write; T157/T158 write nothing. |
| R189-04 | High resolved | All 15 context fields have literal or validated constructor initials; strict empty and populated status projections remain complete. |
| R189-05 | High resolved | Terminal diagnostic policy and reachability distinguish childless `stopped.clean` from `stopped.failed`. |
| R189-06 | High consequential resolved | The model and issue-196 contract retain the same exhaustive 85-cell resolver, seven settlements, exact cache/waiter effects, and six strict registered errors. |
| R189-07 | High consequential resolved | Every accepted status, success observation, and non-success last observation carries required incarnation identity; cross-incarnation observations are unordered. |
| R189-08 | High resolved | Ordered credential revision and fault branches remain complete across bootstrap, backfill, IDLE cleanup, and sweep. |
| R189-09 | High resolved | Accepted shutdown covers all nonterminal sources, starts no later child, and terminates through certified success or error in childless `stopped.shutdown`. |
| R189-10 | Medium resolved | Both queue references and the frozen Git object match issue 98 exactly. |
| R189-11 | Low resolved | The oracle contains 27 guards and 27 guard branches; references and generated counts agree. |
| R189-12 | High consequential resolved | Current pending/cached, watch-to-workflow promotion, and equal-scope replacement preserve phase/set identity and settle once across success and error. |
| R189-13 | Low resolved | PROP-08 constructs U01 through U16 and all 16 forbidden configurations are retained. |
| R189-14 | Low resolved | GEP04 and GEP06 retain the accepted terminal-shutdown credential and stop policy. |
| R189-15 | High consequential resolved | Acquisition-time registration, first-freeze revocation, trigger-only disposal/abort, all eight phase cases, zero-resource audits, and literal T097 reentry pass under installed XState 5.32.5. |
| R189-16 | **High consequential, resolved** | Exact frozen P3-C07 composition passes: one parent composite terminal aliases one `queue.stop()` promise and transitively waits for the private queue subtree without changing its API. |
| R189-17 | **Low non-consequential, resolved** | Global policies project 7/7 across ID, ordered events, literal condition, ordered actions, and literal result; GEP05 includes both missing certificate clauses. |
| R189-18 | **High consequential, open** | The normative cleanup-success event omits `output.frozenReleaseSetId`, `output.authoritativeAudit.frozenReleaseSetId`, and `output.authoritativeAudit.unresolvedReleaseCount`, although the actor contract and admission predicate require all three. |
| R189-19 | **High consequential, open** | One incarnation-wide registry receives unique parent-invoke queue slot IDs but defines no slot retirement or safe reuse rule; a conforming literal registry grows linearly across successful sweeps. |

### R189-18: the typed cleanup-success event cannot express its admission contract

- Lane: TypeScript/event contract, cleanup safety, and model completeness.
- Normative contradiction: `events[xstate.done.actor.cleanupBarrier].payload` declares ten fields. `actors[cleanupBarrier].success`, `cleanupCertificateCoversState`, `cleanupProtocol.admission`, and repaired GEP05 require thirteen. The missing fields are exactly `output.frozenReleaseSetId`, `output.authoritativeAudit.frozenReleaseSetId`, and `output.authoritativeAudit.unresolvedReleaseCount`.
- Direct counterexample: generate the success-event TypeScript shape from the normative payload list and implement the literal guard. The guard cannot read any of the three missing properties without a type error or an undocumented widening. Removing those clauses accepts the wrong release set or unresolved close that R189-17 was intended to reject.
- Error-side risk: `xstate.error.actor.cleanupBarrier` names only `error:WorkflowFault` plus opaque `error.releaseCertificate`, while the actor requires the same certificate fields. A shared named certificate type is the smallest way to prevent success/error drift.
- Consequence: downstream implementation must either contradict the typed-event oracle, weaken cleanup admission, or invent an unmodeled event type. The exact digest is not implementation-ready.

Bounded repair packet:

1. Define one exact `CleanupCertificate` schema/type in the normative oracle, including both release-set identities, both zero-audit counters, literal `released: true`, the audit digest, and diagnostics.
2. Reference that same type from cleanupBarrier success, `WorkflowFault.releaseCertificate`, both typed terminal events, both admission guards, and GEP05. Do not duplicate partial field inventories.
3. Add a structural closure check that every field read by either cleanup guard/global policy exists in both terminal-event contracts, then rerun the full exact-view and runtime review on the new digest.

### R189-19: release-slot retirement is unowned and unbounded

- Lane: lifecycle/resource ownership and performance/capacity.
- Normative facts: `cleanupProtocol.owner` creates one registry per actor incarnation. `compositeQueueSlotProtocol.input` keys each queue slot as `rawDownloadQueue:<parentInvokeIdentity>:0`, so normal recurring sweeps create distinct identities. `releaseSlotProtocol` defines only register, capabilities, trigger, settle, descendants, and late-registration; the complete candidate has no retire, unregister, purge, or safe-reuse operation.
- Direct counterexample: run 1,000 normal sweeps in one incarnation, register each unique composite slot, call the idempotent stop terminal, and settle it. A literal deduplicating registry reaches live 0 and unresolved 0 after each sweep but retains 1,000 entries, contradicting F17's bounded-count postcondition.
- Boundary counterexample: reuse the same ID after settlement and a new queue can deduplicate onto the old terminal/release closure. Delete immediately instead and a frozen, promoted, or cached phase can lose the slot or audit evidence it still references. The current oracle chooses neither a retention boundary nor an immutable phase-snapshot rule.
- Consequence: implementation must choose between incarnation-lifetime growth and an unmodeled deletion/reuse linearization point that affects cleanup certification. This is an unowned lifecycle effect, not a tuning choice.

Bounded repair packet:

1. Add one registry-owned slot-lifecycle rule: the exact safe retirement point for normal terminal/acquisition failure and for slots referenced by open, promoted, settled, or cached cleanup phases.
2. Require immutable phase snapshots to retain terminal, release-set, diagnostic, and audit evidence independently of retired registry entries; prohibit a new resource from deduplicating onto a settled terminal.
3. Add one long-incarnation churn proof covering thousands of normal sweeps and direct-resource replacements. Assert a fixed live registry-entry bound, no old release closure reuse, and unchanged current/cached/promotion/equal-scope certificates.

## Candidate.6 manifest and acceptance audit

Selected review lanes were domain/value, public contract, lifecycle/resource, security/trust, persistence/recovery, concurrency/workflow, performance/capacity, external protocol, and operations. Accessibility was not applicable because the artifact exposes no user interface.

| Behavioral seam | Evidence status | Result |
| --- | --- | --- |
| Exact target and frozen inputs | Commit/object hashes, live issue reads, and worktree byte comparison | Exercised: candidate, prior ledger, planning, public contracts, P3-C10, P3-C11, P3-C07 queue/tests/adapter all match their pins despite unrelated shared-HEAD advancement. |
| Structural graph and references | Independent schema/reference/reachability verifier | Exercised: 24 atomic states, 91 definitions, 204 expanded transitions, 24 events, 27 guards, 24 actions, 10 actors, 15 context fields, 21 invariants, 16 forbidden configurations, 15 properties, 24 state paths, 85 resolver cells, 17 responses, and 13 cleanup states; all atomic states reachable. |
| Candidate/model/view parity | Exact transition, global-policy, state, guard, path, source-exit, response, and resolver projections | Exercised: transitions 91/91 across nine fields; global policies 7/7 across five fields; state rows 24/24; resolver 85/85. R189-17 is resolved. |
| TypeScript terminal-event closure | Actor-output/guard/GEP field-set comparison | **Failed: R189-18.** Exactly three required cleanup certificate paths are absent from the typed success event. |
| Public identity, errors, and resolver | Model-to-contract expansion, strict Zod fixtures, and focused tests | Exercised: all 24 status projections, 12 declared success shapes, same/cross-incarnation ordering, 85 cells at 18/21/25/21, seven settlements, and six exact errors pass. |
| Durable facts and reconstruction | Frozen-source hashes plus transition/write projection | Exercised: P3-C10 already-complete and completed paths, P3-C11 completed and not-eligible paths, and initial empty/populated reconstruction remain exact. |
| Installed XState ordering and T097 | Direct XState 5.32.5 callback/promise/self-target probes | Exercised: freeze/input precede disposal/abort and barrier start; literal T097 reentry stops and starts the child while default self-target does not. |
| Release phase and queue composition | Eight-case registry matrix, exact P3-C07 tests, and production-adapter composite probe | Exercised: one composite trigger/terminal, queued cancellation, active abort, response destroy, staging cleanup, and queue stopped order pass. R189-16 is resolved. |
| Registry lifetime/capacity | Protocol inventory plus 1,000-identity literal registry probe | **Failed: R189-19.** Live and unresolved reach zero, but retained slot count grows to 1,000 because no retirement contract exists. |
| Credential, shutdown, diagnostics, and illegal events | Transition/guard/policy construction probes | Exercised: retained R189-05, R189-08, R189-09, R189-14, and PROP-08 obligations pass. |
| Candidate formatting/planning integrity | Planning checker, candidate-only format check, JSON/whitespace/diff checks, final hashes | Exercised: protected candidate artifacts remain valid, formatted, clean, byte-identical, and pinned; only this retained review ledger changes. |

## Candidate.6 checks and adversarial probes

All commands ran from `/Users/john/.codex/worktrees/efa7/agent-mail`. No live iCloud access, remote mutation, launchd, Tailscale, production/candidate/public-contract edit, commit, push, issue edit, metrics edit, or other GitHub mutation was performed. Only this review ledger was changed.

| Evidence | Exact command or probe | Exit | Result |
| --- | --- | ---: | --- |
| E70 | `gh issue view` reads for 189, 188, 196, 98, 57, 117, and 120; `git rev-parse`; SHA-256 over planning, candidate, contracts, frozen Git objects, and retained ledger; candidate-file byte comparison to `4bab74e` | 0 | Exact candidate.6, issue contract, prior history, and accepted authorities established; later shared HEAD did not alter candidate bytes. |
| E71 | Independent Bun unique/reference/reachability, cleanup-input, generated-path, response-range, and T097 structural verifier | 0 | Counts and references match the manifest; 24/24 atomic states reachable, 13/13 cleanup inputs exact, R189-01 through R189-17 responses present, and unique T097 has literal `reenter: true`. |
| E72 | Independent JSON-to-Markdown transition/global-policy/state/guard/path/source-exit/response/resolver parsers | 0 | 91/91 transitions across nine fields, 7/7 policies across the exact five-field checked-view rule, 24/24 states, 27/27 guards, 24/24 paths, 8/8 source-exit cases, 17/17 responses, and 85/85 resolver cells match. |
| E73 | Model-to-accepted-contract schema/resolver expansion; `bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts` | 0 | 14 tests and 561 expectations pass; required identity, six errors, strict detail shapes, seven settlements, command counts 18/21/25/21, and ordering semantics agree. |
| E74 | Frozen P3-C10/P3-C11 source inspection and model write projection | 0 | T117/T118 retain all four P3-C10 save fields; T150/T156 retain the shared atomic repository/write; T157/T158 write nothing. |
| E75 | Installed-XState 5.32.5 callback/promise action-order probe and same-state default versus literal-reentry probe | 0 | Both actor kinds order source exit, transition freeze, target entry/input, source dispose/abort, then target start. Default starts/stops/entries/exits = 1/0/1/0; reentry = 2/1/2/1. |
| E76 | Deterministic release registry: current pending, current cached, watch-to-workflow promotion, and equal-scope replacement crossed with success/error | 0 | All eight reject late registration, trigger each direct/composite slot once, preserve phase/set/lease identity, and settle at live 0/unresolved 0. |
| E77 | Exact P3-C07 negative capability grep and source hashes; `bun test packages/imap/test/raw-download-queue-p3-c07.test.ts`; parent composite probe through `createRawMessageDownloadAdapter` | 0 | Frozen API exposes no registry capability; four tests and 14 expectations pass. Composite stop remains pending through response destroy and stage abort, then settles once only after stage cleanup and queue `stopped`. One setup-only root eval first exited 1 because the workspace alias was unavailable; the same probe with direct relative imports exited 0. |
| E78 | Cleanup-certificate event field-set closure probe | 2 | Required 13 versus declared 10; missing exactly the three R189-18 paths. The nonzero exit is the reproduced finding. |
| E79 | Incarnation-wide slot-lifetime inventory and 1,000 unique composite-slot literal registry probe | 2 | Protocol has six keys and no retirement operation; live 0/unresolved 0 with 1,000 retained entries. The nonzero exit is the reproduced R189-19 finding. |
| E80 | `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py`; candidate-only `bunx vp fmt --check`; `jq empty`; final-newline, whitespace, scoped `git diff --check`, protected-file comparisons, and final hashes | 0 | Planning and artifact integrity pass; review history is preserved. |

## Candidate.6 signature

Reviewer signature for digest `58a60c0cd6cc5ba86db294a3eb24b14107a0369825cda199351eb6e779a67a9a`: **WITHHELD**.

Reason: R189-18 leaves the normative cleanup terminal event unable to carry the release-set and unresolved-count evidence its own guard requires. R189-19 leaves settled slot lifetime unowned across a long-lived actor incarnation. Both require a new candidate digest and a fresh whole-artifact review; no exact-digest consensus disposition is appended.

## Retained candidate.5 and earlier review records

Status: **candidate.5 rejected; reviewer signature withheld for one high/consequential ownership defect and one low checked-view defect**.

Review mode: independent whole-artifact adversarial review of candidate.5 and the accepted public contracts. A corrected orchestration stopped four briefly started exploratory lanes; no child conclusion is used as a disposition below. The reviewer independently reran every retained structural, contract, installed-XState, release-phase, frozen-source, and checked-view probe at Sol/ultra.

Target:

- Candidate provenance commit: `cffc2feaeb8666dc1a87c70f22b0e8b77cbbc88d`; the shared worktree HEAD advanced during review, but all four candidate artifacts remained byte-identical to this commit
- Normative model: `docs/architecture/sync-statechart.model.json`
- Candidate version: `1.0.0-candidate.5`
- Candidate digest: `03a8ba94bac80f613761b63f35697195cabeb8578eae702f1307f2d42496ad69`
- Companion hashes: statechart `6e9d9908f24f7536a4b4aca11487960be04c6f302d701b1c03f4d170a1e67677`; decisions `ec9092088f7c9eee408eb5ef992c061fafd85a6b0a3c76741351cf23a2a51751`; coverage `e77b2c2fcde31356411e21e9274c15320011086491a8f7f4b93dc3d2efad0d6e`
- Accepted sync contract pin: `packages/contracts/src/sync-operations.ts` at `74a32d41a636ac2334d8245f1043fb6cf76e8bacd9f30895f5475e16dc0817a8`
- Accepted error registry pin: `packages/contracts/src/error-envelope.ts` at `f02a6f25dfd884aa717f136e4024f550697a3d1a32b8cafd5bad84eaf27ae934`
- Review contract: GitHub issue `#189`; accepted public-contract authority: issue `#196`; accepted queue authority: issue `#98`
- Reviewer execution profile: Sol, `gpt-5.6-sol`, `ultra`
- Accepted planning hashes: PLAN `a4b2c93d9ae47369e6893be0a7eace854fce9dccda14bd0d138d9c98b63a2afc`; EVIDENCE `544c1ee220e13b96dc88aa71096701a3887fb1adba22e9b8d60a244533f50cc9`

## Result for candidate.5

Candidate.5 is rejected for implementation and its exact digest is **not signed**. R189-15's abstract acquisition-time release protocol works under installed XState 5.32.5: source-exit ordering, frozen current/cached/promotion/equal-scope success and error, impossible late registration, terminal zero-live/zero-unresolved audits, and literal T097 `reenter: true` all passed. The repair is not implementable literally against the exact frozen P3-C07 queue, however. The model requires the queue registration path to receive a parent registry and requires its private job actor to register job, abort-listener, response-stream, and staging slots, while the pinned actor exposes none of those inputs or capabilities. Resolving that mismatch requires an upstream artifact amendment or a different composite ownership contract. The reviewer has no authority to choose either.

R189-17 is separate and non-consequential at runtime: the normative JSON retains the accepted terminal-shutdown behavior and the cleanup guards fail closed, but its global invalid-terminal policy omits two candidate.5 certificate clauses and the coverage table is stale for GEP04/GEP06. This invalidates the claimed exact checked-view pass and should be repaired mechanically with the ownership repair.

Current unresolved totals are zero critical, one high, zero medium, and one low. There is one unresolved consequential finding.

## Candidate.5 complete finding disposition

| Finding | Candidate.5 severity/status | Mechanical disposition |
| --- | --- | --- |
| R189-01 | Critical resolved | All 13 cleanup states bind minimum scope, epoch, phase, lease, frozen release-set identity, phase terminal, and registry; both terminal guards require current invoke, literal identity equality, scope dominance, and zero live/unresolved audit. |
| R189-02 | High resolved | T117/T118 retain the accepted P3-C10 four-field non-CAS completion save. |
| R189-03 | High resolved | T150/T156 retain the accepted shared completion repository and atomic checkpoint/completion write; T157/T158 write nothing. |
| R189-04 | High resolved | All 15 context fields have literal or validated constructor initials; empty and populated strict status projections remain complete. |
| R189-05 | High resolved | Terminal diagnostic policy and transition reachability distinguish childless `stopped.clean` from `stopped.failed`. |
| R189-06 | High consequential resolved | The model and accepted issue-196 contract expand to the same exhaustive 85-cell resolver, seven settlements, exact cache/waiter effects, and six strict registered errors. |
| R189-07 | High consequential resolved | Every accepted status, success observation, and non-success last observation requires the bounded incarnation identity; different incarnations are unordered. |
| R189-08 | High resolved | Ordered credential revision and fault branches remain complete across bootstrap, backfill, IDLE cleanup, and sweep. |
| R189-09 | High resolved | Accepted shutdown covers all nonterminal sources, starts no later child, and terminates through certified success or error in childless `stopped.shutdown`. |
| R189-10 | Medium resolved as an identity pin | Both queue references and the frozen Git object match issue 98 exactly. R189-16 is the distinct candidate.5 interface/ownership incompatibility with that exact pin. |
| R189-11 | Low resolved | The oracle contains 27 guards and 27 guard branches; references and counts are generated consistently. |
| R189-12 | High consequential resolved in the abstract registry | Current pending/cached, watch-to-workflow promotion, and equal-scope replacement each preserve phase/set identity and settle once for success and certified error. |
| R189-13 | Low resolved | PROP-08 constructs U01 through U16 and all 16 forbidden configurations are retained. |
| R189-14 | Low resolved in the normative JSON | GEP04 and GEP06 encode the accepted terminal-shutdown credential and stop policy. R189-17 records the stale coverage projection. |
| R189-15 | High consequential resolved only at the abstract protocol boundary | Acquisition-time registration, first-freeze capability revocation, idempotent trigger-only disposal/abort, all eight phase cases, zero unresolved terminal audits, and literal T097 reentry pass. R189-16 blocks conformance by the frozen descendant actor. |
| R189-16 | **High consequential, open** | The exact P3-C07 queue cannot receive or perform the per-job/per-handle registration candidate.5 requires. An upstream amendment/re-pin or an explicitly different composite queue-terminal contract is required. |
| R189-17 | **Low, non-consequential, open** | GEP05 omits invalid `frozenReleaseSetId` and nonzero `unresolvedReleaseCount` cases; the coverage GEP04/GEP06 rows contradict the normative JSON and the recorded exact-view PASS. |

### R189-16: frozen P3-C07 cannot implement the required descendant release-slot protocol

- Lane: lifecycle/resource ownership, public/upstream contract conformance, and workflow ordering.
- Candidate facts: `frozenInputs.P3-C07` and `rawDownloadQueue.acceptedArtifact` pin issue 98 commit `e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae`, path `packages/imap/src/raw-download-queue.ts`, and SHA-256 `b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67`. The queue actor input separately requires a `parent resource registry`; its `resourceRegistration` requires a job slot before admission; its private job must register abort-listener, response-stream, and staging slots before acquisition. `cleanupProtocol.releaseSlotProtocol.descendants`, D29, I21, U16, PROP-15, F17, and F18 make those requirements normative rather than illustrative.
- Frozen-source facts: `QueueContext` contains only adapter, capacity, queue, active job, shutdown flag, and stop waiters. The machine input contains only adapter and capacity. `DownloadInput` contains only job and adapter. The public constructor accepts only adapter and options. `withActorAbort` installs the private caller abort listener directly, and the private `download` actor calls the adapter then removes that listener in `finally`. The frozen `packages/imap` tree has no `registerReleaseSlot`, resource-registry, frozen-set, or release-slot API.
- Direct counterexample: consume the accepted actor without revision. The parent can pre-register one queue slot and call `queue.stop()`, but the queue cannot register a queued-job slot before admission and the private job cannot register its abort-listener slot. The implementation therefore violates I21 and the claimed frozen release-set inventory even if the composite stop eventually closes safely.
- Boundary counterexample: add the missing registry to the accepted machine input, job input, listener setup, response acquisition, and staging acquisition. That changes the exact frozen artifact and invalidates both P3-C07 pins unless issue 98's owner accepts and re-pins it.
- Wrapper counterexample: retain the exact actor and invent a wrapper or adapter that owns the extra slots. The model names no such actor, capability adapter, or composite audit owner; the private caller abort listener is not observable through the public API. Choosing this path changes the modeled actor graph and ownership boundary rather than implementing the published metadata directly.
- Impact: downstream implementation must silently choose between a false exact-artifact claim, a false per-resource registration claim, or an unmodeled wrapper/composite owner. Issue 189 explicitly stops on an upstream artifact or ownership/interface decision. Abstract registry probes cannot establish end-to-end source-tree closure until this seam is frozen.

Bounded repair packet:

1. Choose and obtain acceptance for one ownership boundary. For per-resource slots, amend P3-C07 so its typed queue input/constructor and private job acquisition path receive the scoped registration capability; register job before admission and listener/response/staging terminals before acquisition; then publish a new exact commit/path/SHA pin.
2. Alternatively, explicitly make one parent-registered composite queue slot authoritative. Its release must call the exact `queue.stop()` terminal, and the model must replace the per-job/per-handle slot claims with a proved transitive terminal contract. Record why queued jobs own no independently live handles and why active job listener/adapter/staging cleanup completes before that terminal.
3. Model any wrapper or capability adapter explicitly, including its actor owner, input type, registration linearization point, release terminal, audit identity, and relationship to the accepted queue. Do not leave the implementation to infer it from prose.
4. Re-run the installed-XState source-exit and all eight phase cases through the selected P3-C07 composition, not only a synthetic registry. Assert late registration is unrepresentable and every `paused`, `stopped.clean`, `stopped.failed`, and `stopped.shutdown` observation has zero unresolved descendant close.

### R189-17: global invalid-terminal policy and checked coverage are incomplete

- Lane: model/schema completeness and generated-oracle fidelity.
- Normative-policy hole: both cleanup guards require equality of `frozenReleaseSetId` and `authoritativeAudit.unresolvedReleaseCount === 0`, but GEP05 enumerates neither invalid case. A current-invoke cleanup terminal with every listed GEP05 field equal, live count zero, and unresolved count one fails its local guard, is not an exited/duplicate GEP03 event, and satisfies no stated global-policy condition. XState still ignores it, so this is fail-closed rather than a new runtime decision, but PROP-09's exhaustive known-illegal-event claim is not mechanically true.
- Checked-view mismatch: an exact parser found 7/7 rows but only 16/21 event/condition/result fields equal. Coverage GEP04 omits `stopping.forShutdown` and describes newer revisions as otherwise transitioning; GEP06 omits `control.stop.requested`, stale-version precedence, and T041 join; GEP05's result is also not the oracle text. The same coverage file nevertheless records checked Markdown views as PASS and its R189-14 row claims the missing GEP04/GEP06 content.
- Repair: add wrong frozen release-set identity and nonzero unresolved count to GEP05, regenerate every global-policy row from the oracle, and extend the checked-view verifier to compare global policy IDs, event lists, conditions, actions, and results.

## Candidate.5 manifest and acceptance audit

| Behavioral seam | Evidence status | Result |
| --- | --- | --- |
| Exact target and frozen inputs | Commit/object hashes plus worktree byte comparison | Exercised: candidate digest and companion/planning/contract/P3-C10/P3-C11/P3-C07 hashes exact despite unrelated shared-HEAD movement. |
| Structural graph and references | Independent schema/reference/reachability verifier | Exercised: 24 atomic states, 91 definitions, 204 expanded transitions, 24 events, 27 guards, 24 actions, 10 actors, 15 context fields, 21 invariants, 16 forbidden configurations, 15 properties, 24 paths, 85 resolver cells, and 15 review responses; all atomic states reachable. |
| Public identity, errors, and resolver | Model-to-contract expansion, strict Zod fixtures, focused tests | Exercised: 48 status projections, every success observation, same/cross-incarnation ordering, 85 cells at 18/21/25/21, seven settlements, and six exact errors pass. |
| Installed XState ordering and T097 | Direct XState 5.32.5 callback/promise/self-target probes | Exercised: source exit/freeze/target input precede disposal/abort; barrier starts last. Default self-target leaves the failed child, while literal `reenter: true` starts a fresh active child. |
| Abstract release registry | Installed-XState frozen-slot harness plus deterministic phase matrix | Exercised: callback/promise release success/error remain closing until settlement; current pending/cached, promotion, and equal-scope success/error settle once; late registration rejects; final audits are live 0/unresolved 0. |
| Frozen descendant source tree | Exact P3-C07 source/API inspection and focused accepted tests | **Failed: R189-16.** Composite `queue.stop()` waits for active cleanup, but the exact actor has no capability for the candidate's claimed queue/job/handle registrations. |
| Global policy and checked views | Exact JSON-to-Markdown policy parser and guard-policy comparison | **Failed: R189-17.** Five field mismatches and two omitted invalid-certificate clauses. |
| Candidate formatting/planning integrity | Planning checker, candidate-only format check, JSON parse, whitespace/diff checks | Exercised: candidate remains valid, formatted, and byte-identical; only this retained review ledger changes. |

## Candidate.5 checks and adversarial probes

All commands ran from `/Users/john/.codex/worktrees/efa7/agent-mail`. No live iCloud access, remote mutation, launchd, Tailscale, production/candidate/public-contract edit, commit, push, issue edit, metrics edit, or other GitHub mutation was performed. Only this review ledger was changed.

| Evidence | Exact command or probe | Exit | Result |
| --- | --- | ---: | --- |
| E61 | Full `gh issue view` reads for issues 189, 196, and 98; `git rev-parse`; SHA-256 over planning, candidate, contracts, and frozen Git objects; candidate-file byte comparison to `cffc2fe` | 0 | Exact candidate.5 and accepted authority established; shared-HEAD movement did not alter candidate bytes. |
| E62 | Independent Bun inventory, unique/reference, reachability, cleanup-input, source-exit, review-response, actor-registration, and T097 structural verifier | 0 | Counts are 24 atomic, 91 definitions, 204 expanded, 24 events, 27 guards, 24 actions, 10 actors, 15 context, 21 invariants, 16 forbidden, 15 properties, 24 paths, 85 resolver cells, 15 responses; 13/13 cleanup inputs, 8/8 source-exit rows, and literal unique T097 `reenter: true` pass. |
| E63 | Independent JSON-to-Markdown transition and global-event-policy parsers | 1 | Transitions pass 91/91 across nine fields. Global policy fails five of 21 compared fields: GEP04 condition/result, GEP05 result, and GEP06 events/result. R189-17 reproduced. |
| E64 | Direct model-to-accepted-contract resolver/schema expansion; `bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts` | 0 | Resolver exact at 85 cells with 18/21/25/21 command counts; 14 tests, 561 expectations, all strict identity/error/consequential-order fixtures pass. |
| E65 | Installed-XState 5.32.5 action-order and T097 self-target probes | 0 | Callback and promise order is source exit, transition freeze, target entry, target input, dispose/abort, target start. Default self-target is starts 1/entries 1/exits 0 with failed child; literal reentry is starts 2/entries 2/exits 1 with active replacement. |
| E66 | Installed-XState frozen-slot harness: callback/promise crossed with release success/error | 0 | All four remain `closing` until release, then success reaches `paused` and error reaches `failed`; registration after freeze rejects, duplicate trigger yields one release, one phase settlement, and live 0/unresolved 0. |
| E67 | Deterministic release registry matrix: current pending, current cached, watch-to-workflow promotion, and equal-scope replacement crossed with success/error | 0 | All eight cases preserve expected phase/lease/frozen set, settle each phase once, reject late registration, trigger each slot once, and finish at live 0/unresolved 0. |
| E68 | Exact frozen P3-C07 API/input inspection; negative grep for registry/slot APIs; `bun test packages/imap/test/raw-download-queue-p3-c07.test.ts` | 0 | Frozen hash exact; no parent registry or per-job/per-handle registration capability exists. Four accepted queue tests pass, including stop waiting for adapter/stage cleanup. This proves the composite terminal but not candidate.5's stronger slot inventory. |
| E69 | `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py`; candidate-only `bunx vp fmt --check`; `jq empty`; final-newline/trailing-whitespace and scoped `git diff --check`; final hashes | 0 | Planning pack passes; four protected candidate artifacts remain valid, formatted, clean, and pinned. Review-ledger history was preserved rather than mechanically reformatted. |

## Candidate.5 signature

Reviewer signature for digest `03a8ba94bac80f613761b63f35697195cabeb8578eae702f1307f2d42496ad69`: **WITHHELD**.

Reason: R189-16 leaves the descendant acquisition-time release owner unimplementable as written against the exact frozen P3-C07 actor. Choosing an upstream queue amendment, an explicit wrapper, or one transitive composite queue terminal is a consequential ownership/interface decision outside this reviewer's authority. R189-17 also requires a mechanical global-policy and checked-view repair. The digest must not be signed until those changes produce a new exact candidate and a fresh independent whole-artifact review finds zero consequential defects.

## Retained candidate.4 and earlier review records

Status: **candidate.4 rejected; reviewer signature withheld for one high/consequential lifecycle defect**.

Review mode: final independent system-mode adversarial review of the complete candidate.4 artifact and its accepted public contracts. The reviewer reread the full issue and candidate rather than inheriting the candidate author's conclusion. No subagents or decomposition were used.

Target:

- Candidate provenance commit: `8cf0d139c47094433b83bf29b46d0c42a2b47e86`; later unrelated commits at the shared worktree HEAD do not change the candidate files
- Normative model: `docs/architecture/sync-statechart.model.json`
- Candidate version: `1.0.0-candidate.4`
- Candidate digest: `dc4a58c495d77c1b0f278d2b3fd8df10410ce22c44d369085aacc9307b9232c8`
- Accepted sync contract pin: `packages/contracts/src/sync-operations.ts` at `74a32d41a636ac2334d8245f1043fb6cf76e8bacd9f30895f5475e16dc0817a8`
- Accepted error registry pin: `packages/contracts/src/error-envelope.ts` at `f02a6f25dfd884aa717f136e4024f550697a3d1a32b8cafd5bad84eaf27ae934`
- Review contract: GitHub issue `#189`, including the accepted issue `#196` UC01/UC02/R189-14 resolution
- Reviewer execution profile: Sol, `gpt-5.6-sol`, `xhigh`
- Accepted planning hashes: PLAN `a4b2c93d9ae47369e6893be0a7eace854fce9dccda14bd0d138d9c98b63a2afc`; EVIDENCE `544c1ee220e13b96dc88aa71096701a3887fb1adba22e9b8d60a244533f50cc9`

## Result for candidate.4

Candidate.4 is rejected for implementation and its exact digest is **not signed**. R189-01 through R189-14 are mechanically resolved. R189-15 is a new high, consequential lifecycle/resource-ownership defect demonstrated against installed XState 5.32.5. Current unresolved totals are zero critical, one high, zero medium, and zero low.

The model creates or promotes the cleanup registry phase in a transition action, and the target cleanup invoke captures that phase terminal in its input. Native XState performs both steps before disposing or aborting the source invoke. The candidate separately requires the `idleSession` disposer to register its asynchronous close promise. Therefore the phase can audit and settle before the close exists in the registry. If late registration changes the authoritative audit, the already-produced certificate is rejected and the one-result cleanup wrapper remains stuck forever. If late registration does not change the audit, the cleanup guard admits the certificate and publishes `paused`/`stopped` while the adapter close remains live. Both interpretations violate the candidate's cleanup invariants.

All other requested probes passed: exact incarnation identity and cross-incarnation ordering; all 85 resolver cells and six public errors; once-only waiter settlement and cleanup; byte-identical replay, fixed expiry, capacity, and reconstruction rules; declared cleanup-certificate success/error branches; shutdown, credential, stop, and restart orderings; exact durable writes and queue pin; terminal-marker reachability; and exact model-to-Markdown projection. These passing checks do not compensate for R189-15's end-to-end ownership failure.

## Candidate.4 complete finding disposition

| Finding | Candidate.4 severity/status | Mechanical disposition |
|---|---|---|
| R189-01 | Critical resolved | Every cleanup state supplies minimum scope, epoch, phase, lease, phase terminal, and registry input; both terminal guards require current invoke, exact registry/context/certificate identity, scope dominance, exact audit/certificate identity, and zero live count. |
| R189-02 | High resolved | T117/T118 retain the accepted P3-C10 non-CAS save of all four `InitialBackfillCompletion` fields. |
| R189-03 | High resolved | T150/T156 use the shared accepted completion repository and exact five checkpoint plus four completion fields; T157/T158 write nothing. |
| R189-04 | High resolved | All 15 context entries have complete literals or validated constructor inputs; 48/48 empty/populated public projections parse before start. |
| R189-05 | High resolved | The abstract transition model reaches 27 state/marker pairs including initialization, with no reachable `stopped.clean` marker and no reachable `stopped.failed` without one. |
| R189-06 | High consequential resolved | Candidate.4 and the accepted contract contain the same exhaustive 85-cell resolver, seven settlement categories, exact consequential selections, and six registered strict public errors. Each cell has exactly one settlement and one applicable public schema. |
| R189-07 | High consequential resolved | The accepted strict status and every success/non-success observation require the same bounded `incarnationId`; ordering is defined only within one incarnation. |
| R189-08 | High resolved | Newer, duplicate/older, current-fault, superseded-fault, and future-fault credential branches remain ordered across bootstrap, backfill, IDLE cleanup, and sweep. |
| R189-09 | High resolved | Shutdown covers every nonterminal atomic source, has no transition escape or non-cleanup child start, and both certified cleanup success and error enter childless `stopped.shutdown`. |
| R189-10 | Medium resolved | Both P3-C07 queue pins and the frozen Git object match issue 98, commit, path, and SHA-256. |
| R189-11 | Low resolved | The oracle and checked view contain exactly 27 guards and 27 guard rows. |
| R189-12 | High consequential resolved for declared phase replacement orders | Promotion, pending/cached equal-scope replacement, repeated replacement, success, and certified error traces settle through the current phase/lease on installed XState. R189-15 is a distinct pre-registration defect before those phase-order traces begin. |
| R189-13 | Low resolved | PROP-08 explicitly constructs and excludes U01-U15; all 15 forbidden rows exist and are referenced. |
| R189-14 | Low resolved | GEP04 explicitly ignores every credential revision in both shutdown states; GEP06 includes stop and provides stale-version/shutdown-terminal rejection while preserving T041's matching stop join. |
| R189-15 | **High consequential, open** | XState target input/phase selection precedes source invoke abort/disposal, while `idleSession` registers its close promise only in that later disposer. The cleanup phase can certify an incomplete resource set, causing either false quiescence or a permanent cleanup-state deadlock. |

### R189-15: cleanup phase can settle before the source disposer registers its close

- Lane: lifecycle/resource ownership plus concurrency/workflow and installed framework semantics.
- Candidate facts: `configuration.actionOrder` says cleanup observes the source release promises; `beginOrPromoteCleanup` calls the registry phase linearization point; cleanup-state input immediately selects `resourceRegistry.awaitPhase(epoch, phase)`; and `idleSession.cancellation` says its disposer initiates cancellation and registers the close promise.
- Installed XState order: source exit action, transition action, target entry, target invoke-input evaluation, source `fromCallback` disposer or `fromPromise` abort, then target invoke start. The transition action and cleanup phase input therefore cannot observe disposer-only registration.
- Tracked-late-registration counterexample: the phase returns a zero-resource terminal; the disposer then registers the unresolved close and changes the current audit; the terminal guard rejects the stale certificate once; close eventually settles, but the already-completed one-result wrapper cannot emit another terminal, so the state remains in cleanup forever.
- Ignored-late-registration counterexample: the phase returns a zero-resource terminal; the disposer begins an untracked asynchronous close; the terminal guard admits the certificate and reaches `paused` while the close is still unresolved.
- Impact: violates I03, I04, I06, I07, PROP-02, PROP-07, PROP-10, U01, U02, U07, U12, F17, and F18. It affects pause, stop, restart, shutdown, retry/failure cleanup, and any transition that relies on exit-time release registration.

Required repair obligations:

1. Establish a synchronous registration/cancellation barrier before `requestPhase` can audit or settle. Every source invoke and descendant resource that may survive exit must already have one deduplicated registry slot and awaited release handle before the phase is selected. A practical design is to register the slot at resource acquisition and let the disposer only trigger its already-registered idempotent release.
2. Make late registration after phase freeze impossible by construction, not merely ignored. Prove that neither an XState disposer nor an abort handler can introduce a new live handle after the audit snapshot.
3. Retain the exact installed-XState trace for both `fromCallback` disposal and `fromPromise` abort, then rerun current/cached/promotion/replacement success and error matrices plus the adjacent assertion that `paused`, `stopped.clean`, `stopped.failed`, and `stopped.shutdown` imply no unresolved source close.
4. Make the XState mapping for T097 literal: its same-state stale-credential branch requires `reenter: true` so `bootstrapSession` actually stops and starts. Installed XState defaults to no reentry (`starts=1`, `stops=0`); explicit reentry produces the normative actor delta (`starts=2`, `stops=1`). This is a concrete implementation-conformance obligation, not a separate unresolved design choice, because the model already specifies `bootstrapSession` to `bootstrapSession`.

## Candidate.4 manifest and acceptance audit

| Behavioral seam | Evidence status | Result |
|---|---|---|
| Public identity and ordering | Contract schema plus direct runtime parsing | Exercised: 48/48 statuses, every success observation, every applicable resolver error, same-incarnation ordering, and cross-incarnation non-comparison pass. |
| Control resolver and waiter | Model/contract exact match plus installed-XState subscription harness | Exercised: 85/85 cells, seven settlements, six errors, synchronous transition and no-op paths, one settlement, and listener/subscription/deadline removal exactly once. |
| Replay, expiry, capacity, reconstruction | Contract assertions plus deterministic property harness | Exercised: byte-identical bytes, fixed expiry, conflict preservation, no in-flight eviction, all-in-flight capacity, and new-incarnation map reset pass. |
| Cleanup identity and phase replacement | Literal guard/registry probe plus installed-XState phase harness | Exercised for declared phase races; exact epoch/phase/lease/scope/certificate/audit admission and six promotion/replacement traces pass. |
| Exit-time resource ownership | Installed-XState source-disposal order and two-branch counterexample | **Failed: R189-15.** |
| Durable and restart semantics | Exact transition-write assertion and constructor/marker exploration | Exercised: accepted P3-C10/P3-C11 fields, no-write cases, childless reconstruction, and terminal diagnostic preservation pass. |
| Credential, stop, restart, shutdown | Ordered-guard/source-coverage/terminal graph probe | Exercised: 22/22 non-shutdown sources, four credential fault families, stop join, shutdown success/error, and zero terminal escape pass. |
| Normative model to checked views | Independent parser and field-by-field equality | Exercised: transitions 91/91 across nine fields, resolver cells 85/85 across eight fields, and every inventory/detail table exactly matches. |

Candidate.4 inventory is internally exact: 24 atomic states, 91 transition definitions, 204 expanded transitions, 24 events, 27 guards, 24 actions, 10 actors, 15 context entries, 20 invariants, 15 forbidden configurations, 14 properties, 24 shortest paths, 85 resolver cells, and 14 review responses. All IDs and references resolve; 24/24 atomic states are reachable; source-specific actor deltas and cleanup-state inputs are complete.

The checked Markdown views exactly project the model: transitions 91/91 across source, event, ordered guards, target, actions, actor delta, durable writes, and observation; resolver cells 85/85 across command, ordering, settlement, response, code, reason, last observation, idempotency, and waiter cleanup after defaults; paths 24/24; guards 27/27; properties 14/14; traceability 7/7; forbidden configurations 15/15; review responses 14/14 in both checked views; decisions 28/28; states 24/24; context 15/15; actors 10/10.

The direct public-applicability probe expanded all 85 resolver cells and parsed every result through the operation-specific schema and the shared six-code registry. It found 70 direct settlements and 15 byte-identical replay settlements, with no missing or inapplicable public response.

## Candidate.4 checks and adversarial probes

All commands ran from `/Users/john/.codex/worktrees/efa7/agent-mail`. No live iCloud access, remote mutation, launchd, Tailscale, production/candidate/public-contract edit, commit, push, issue edit, metrics edit, or other GitHub mutation was performed. Only this review ledger was changed.

| Evidence | Exact command or probe | Exit | Result |
|---|---|---:|---|
| E49 | `gh issue view 189 --repo johnlombardo-dev/agent-mail --json number,title,state,body,comments,labels,assignees,updatedAt,url`; same full reads for issues 188 and 196; `git rev-parse`; `shasum -a 256` over candidate/planning/contracts; frozen Git-object hashes | 0 | Candidate.4, accepted issue-196 authority, both contract pins, planning pins, and P3-C10/P3-C11/P3-C07 object pins exact. |
| E50 | Independent Bun inventory, reference, reachability, shortest-path, actor-delta, cleanup-input, public-key, durable-write, forbidden-property, and terminal-marker verifier | 0 | Exact inventory; 24/24 atomic reachability; 27 marker pairs including initialization; zero stopped-marker violations; R189-01-R189-05 and R189-10-R189-13 structural claims pass. |
| E51 | Independent Bun parser over the model and all checked Markdown tables | 0 | Transition 91/91 and resolver 85/85 field equality; every path/guard/property/traceability/forbidden/review/decision/state/context/actor row exact. |
| E52 | Direct Bun/Zod expansion through accepted `sync-operations.ts` and `error-envelope.ts` | 0 | 48/48 strict status projections; required incarnation identity; same-incarnation ordering only; 85/85 resolver cells; 70 direct plus 15 replay results; six registered codes; no inapplicable response. |
| E53 | Installed-XState 5.32.5 cleanup phase/lease harness | 0 | Six settlement orders pass: queued watch before promotion, watch done before later pause, promotion before old watch, cached equal-scope success, cached equal-scope certified error, and repeated replacement through shutdown. |
| E54 | Installed-XState waiter/subscription harness | 0 | Synchronous-transition and unchanged no-op waiters each settle once and remove the decision listener, snapshot subscription, and deadline once; late notifications are zero. |
| E55 | Deterministic Bun idempotency-cache property harness using the candidate's declared precedence | 0 | 1,000 sequences x 80 steps; 15,451 byte-identical replays, 30,921 conflicts, 30,474 settled evictions, zero in-flight eviction violations; explicit all-in-flight capacity and fixed-expiry boundary pass. |
| E56 | Bun shutdown/credential/stop graph and ordered-guard probe | 0 | 24 atomic states; all 22 non-shutdown sources covered; zero shutdown escapes; 22 credential sources; four ordered fault families; T184/T185 terminal branches, T041 stop join, GEP04, and GEP06 exact. |
| E57 | Installed-XState 5.32.5 exit/disposal-order harness and late-registration counterexample | 0 | For both actor kinds, transition action and target invoke input precede source cleanup. Tracked late registration remains stuck in cleanup after close; ignored registration reaches paused before close. R189-15 reproduced. |
| E58 | Installed-XState 5.32.5 self-target probe | 0 | Default T097-shaped self-target: starts 1/stops 0. Explicit `reenter: true`: starts 2/stops 1. Normative actor delta requires the latter in implementation. |
| E59 | `bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts packages/contracts/test/operation-corpus.test.ts`; `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py` | 0 | 20 pass, 0 fail, 696 expectations; planning checker passes. |
| E60 | `jq empty`; direct final-newline and trailing-whitespace checks over review/candidate/contracts; candidate-only scoped `git diff --check`; final candidate/contract hashes | 0 | JSON valid; all final newlines present; no trailing whitespace or candidate diff errors; candidate and contract pins unchanged. |

The two exploratory verifier corrections were reviewer-harness corrections, not candidate evidence: the terminal-marker count includes the pre-initialization pair, and checked-view actor lists use the rendered `<br>` delimiter. The idempotency property harness was also corrected to apply existing-key join/replay/conflict before capacity eviction, matching the candidate's declared precedence. All retained E49-E60 results use the corrected constructions.

Core retained commands:

```sh
shasum -a 256 PLAN.md docs/planning/EVIDENCE.md docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json packages/contracts/src/sync-operations.ts packages/contracts/src/error-envelope.ts
jq -e 'def byid($id): .transitions[] | select(.id == $id) | .durableWrites; (["mailboxCheckpoint.uidNext","mailboxCheckpoint.modseq","mailboxCheckpoint.sweepCursor","mailboxCheckpoint.backfillCompleted","mailboxCheckpoint.observedVersion","initialBackfillCompletion.observedUidCeiling","initialBackfillCompletion.observedUidNext","initialBackfillCompletion.observedAt","initialBackfillCompletion.nextSweepEligibleAt"]) as $complete | (["initialBackfillCompletion.observedUidCeiling","initialBackfillCompletion.observedUidNext","initialBackfillCompletion.observedAt","initialBackfillCompletion.nextSweepEligibleAt"]) as $save | (byid("T110") == $complete and byid("T116") == $complete and byid("T117") == $save and byid("T118") == $save and byid("T150") == $complete and byid("T156") == $complete and byid("T157") == [] and byid("T158") == [])' docs/architecture/sync-statechart.model.json
jq -e '((.frozenInputs[] | select(.id=="P3-C07")) == {id:"P3-C07",issue:98,path:"packages/imap/src/raw-download-queue.ts",gitCommit:"e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae",sha256:"b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67"}) and ((.actors[] | select(.id=="rawDownloadQueue") | .acceptedArtifact) == {issue:98,planItem:"P3-C07",gitCommit:"e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae",path:"packages/imap/src/raw-download-queue.ts",sha256:"b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67"})' docs/architecture/sync-statechart.model.json
git show e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae:packages/imap/src/raw-download-queue.ts | shasum -a 256
bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts packages/contracts/test/operation-corpus.test.ts
python3 .agents/skills/plan-agent-mail/scripts/check_plan.py
jq empty docs/architecture/sync-statechart.model.json
! rg -n '[[:blank:]]+$' docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md
git diff --check -- docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json packages/contracts/src/sync-operations.ts packages/contracts/src/error-envelope.ts
```

## Candidate.4 signature

Reviewer signature for digest `dc4a58c495d77c1b0f278d2b3fd8df10410ce22c44d369085aacc9307b9232c8`: **WITHHELD**.

Reason: R189-15 permits either false quiescence with a live source close or permanent cleanup deadlock under installed XState ordering. The exact digest must not be signed until the registration/cancellation barrier is part of the normative model, the XState order trace and adjacent no-live-child checks pass, T097 reentry is literal, all checked views are regenerated exactly, and a fresh independent rereview finds no consequential defect.

## Retained round-3 record

Status at round-3 completion: **stopping condition reached; candidate not signed; orchestrator decision required**.

Review mode: system-mode adversarial review of the whole P3-C15 candidate, not a diff-only review. Round 3 reread the complete four-file candidate after the final designer response. The reviewer received the accepted artifacts and candidate files, but no inherited designer discussion or conclusion.

Target:

- Candidate base commit: `8522d12d839613d305a2b77cbea764eac993ae0a`; candidate.3 is an uncommitted four-file working-tree revision over that commit
- Normative model: `docs/architecture/sync-statechart.model.json`
- Candidate version: `1.0.0-candidate.3`
- Candidate digest: `0472e2c0a11ac7cc1abc9677c5fe112fa710da7a655acfb15452ddb595fc10d9`
- Retained round-2 digest: `7eba62c31fc894cd4c029ea529bfa1e7a443d921b5935b924e8b3f92db3fbf58`
- Retained round-1 digest: `6a4643bb1ec47ec823657c16581cc757ffa30f49ac49abf9cc866f9d9c07abad`
- Review contract: GitHub issue `#189`, P3-C15-REVIEW
- Reviewer execution profile: Sol, `gpt-5.6-sol`, `xhigh`; no subagents or decomposition
- Accepted planning hashes: PLAN `a4b2c93d9ae47369e6893be0a7eace854fce9dccda14bd0d138d9c98b63a2afc`; EVIDENCE `544c1ee220e13b96dc88aa71096701a3887fb1adba22e9b8d60a244533f50cc9`
- Accepted upstream sources: P1-C08 `13e036049099241d68b724639c467d9ae8e4424a`; P3-C10 `b6d07bc56e775cc7aea4b9436b81532bba7c4e9a`; P3-C11 `d5107472ffae6f5eb4deb8b87365ffda40fe30d3`; P3-C07 `e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae`

The round-3 candidate files have exact individual SHA-256 values recorded in E33. They differ from base commit `8522d12` only because the designer supplied candidate.3 in the shared working tree. Unrelated modified and generated files were already present and were not read as candidate evidence, repaired, reverted, or included in this review.

## Result

Candidate.3 is rejected for implementation and its exact digest is **not signed**. The complete round-3 rerun mechanically resolves R189-12 and R189-13 and preserves the resolution of R189-01 through R189-05 and R189-08 through R189-11. R189-06 and R189-07 remain high and consequential because accepted P1-C08 still has no complete pending-control resolver, no six-code control error registration, and no public incarnation identity. R189-14 is a new low, non-consequential global-policy completeness defect. Current unresolved totals are zero critical, two high, zero medium, and one low.

The versioned cleanup-session protocol now survives watch settlement before or after promotion, old-terminal delivery, pending and cached equal-scope replacement, repeated replacement, success, and certified error under installed XState 5.32.5. Literal admission rejects wrong or narrow scope, stale epoch/phase/lease, pre-promotion and replaced invokes, wrong certificate/audit identity, and nonzero audits. The original cleanup, shutdown, credential, durable-write, constructor, terminal-diagnostic, and queue-pin counterexamples do not reproduce.

This is the third review-response round. The same consequential public-contract disagreement remains, so issue #189's stop condition applies. There must not be a fourth designer-response loop without an orchestrator decision. The orchestrator must either (a) authorize and dispatch an upstream P1-C08 amendment that accepts UC01 and a complete UC02 resolver/error registry, or (b) select a different accepted public ordering and non-success protocol and require the candidate to conform to it. Narrowing F19/P3-C15 acceptance would also require an explicit orchestrator decision; the reviewer does not recommend silently doing so.

## Round 3 final complete-candidate rereview

### Prior-finding disposition

| Finding | Round-3 severity/status | Mechanical disposition |
|---|---|---|
| R189-01 | Critical resolved | State minimum scope, exact registry/context/certificate scope identity, epoch, phase, lease, current invoke, dominance, current terminal/audit identity, and zero audit reject wrong, narrow, stale, pre-promotion, and replaced certificates. |
| R189-02 | High resolved | T117/T118 still list the accepted P3-C10 non-CAS save of all four `InitialBackfillCompletion` fields. |
| R189-03 | High resolved | T150/T156 still use the shared accepted completion repository and exact five checkpoint plus four completion fields; T157/T158 write nothing. |
| R189-04 | High resolved | All 15 context entries have complete constructor literals or validated constructor inputs; 48/48 empty/populated public projections parse before start. |
| R189-05 | High resolved | The transition abstraction reaches 27 state/marker pairs with zero `stopped.clean`/`stopped.failed` marker violations. |
| R189-06 | High consequential, open | Timing and idempotency mechanics remain bounded, but there is still no exact resolver for pending start/pause/resume/stop supersession and terminal orderings, no failed/cancelled decision action, and 0/6 proposed public errors are registered. |
| R189-07 | High consequential, open | Internal incarnation correlation remains sound, but strict accepted P1-C08 rejects `incarnationId` in both status and control observations. |
| R189-08 | High resolved | Newer/stale/current/future credential revision paths and both IDLE fault/revision orders remain complete. |
| R189-09 | High resolved | `stopping.forShutdown` and `stopped.shutdown` have zero graph escapes to live work; success and certified error remain terminal. |
| R189-10 | Medium resolved | Both queue pins and the frozen Git object match P3-C07 issue 98, commit, path, and SHA-256. |
| R189-11 | Low resolved | The oracle and checked view still contain exactly 27 guards and 27 guard rows. |
| R189-12 | High consequential resolved | A new registry phase is installed before every watch-to-workflow replacement; each equal-scope replacement receives a new lease and wrapper over the current pending/cached phase terminal. Eight installed-XState order traces plus cached certified error settlement pass. |
| R189-13 | Low resolved | PROP-08 now explicitly constructs and excludes U01-U15; all 15 forbidden rows are present and referenced. |
| R189-14 | Low non-consequential, open | Global event policy is not exhaustive in terminal shutdown: newer `credentials.changed` and stale-version `control.stop.requested` in `stopping.forShutdown` match neither a local transition nor a declared global policy. Native XState ignores them safely, but PROP-09 and GEP04's completeness claim are false. |

### R189-12 resolution: versioned cleanup-session protocol

- Lane: lifecycle/resource ownership plus concurrency/workflow and installed XState semantics.
- Status: resolved for candidate.3.
- Literal protocol: `resourceRegistry.requestPhase` is the linearization point. No-session requests allocate a new epoch/phase/lease; equal or narrower requests retain epoch/phase and allocate a new lease; watch-to-workflow requests allocate a fresh workflow phase and pending terminal before replacement invocation; `finishCleanupScope` alone closes the session.
- Runtime evidence: E39 exercised eight orders: settled-watch output queued before promotion; watch completion adopted before later promotion; promotion before old-watch settlement; cached workflow success replaced before done delivery; pending workflow replacement; cached watch replacement followed by promotion; promotion followed by stop and shutdown replacements; and workflow completion followed by a new stop session. Every valid trace reached its selected childless target. E40 separately rebound a cached certified error to the replacement lease and reached the failure target through the current `onError`.
- Admission evidence: E38 admitted valid watch/workflow certificates and rejected wrong effective scope, narrower scope, stale epoch, stale/pre-promotion phase, stale lease, replaced invoke, wrong audit scope, nonzero live count, wrong certificate ID, wrong digest, and registry/context scope mismatch. Both done and error guards contain the same literal certificate clauses.
- Installed semantics: XState 5.32.5 reads the assigned phase/lease before starting the replacement invoke; stopped `fromPromise` outputs do not advance the replacement; a new `Promise.resolve(cachedTerminal)` wrapper produces a current invocation result without replaying the old actor result.
- Invariants supported: I06, I07, PROP-02, PROP-07, PROP-10, U01, U02, U07, and U12.

### R189-13 resolution: forbidden-configuration coverage

E34 verified exact U01-U15 IDs, nonempty exclusion rows, 15/15 forbidden configurations, and PROP-08's literal U01-U15 range. E35 matched the 15 checked Markdown rows to the oracle. R189-13 is closed.

### R189-06 exact remaining scope: public control non-success resolver and registration

- Lane: public contract plus concurrency/workflow.
- Status: high, consequential, and open after three rounds.
- Resolved portion: both listeners register before synchronous send; pre/post snapshots cover current installed no-op behavior; decision/snapshot ordering is buffered; deadline, retention, settled-LRU eviction, all-in-flight capacity, byte-identical cache replay, conflict, and reconstruction are bounded.
- Unresolved resolver: E44 finds only accepted, completed, pending, and rejected actions. There is no failed/cancelled decision action and no resolver/map/settlement table in `controlProjection`. The five pause-cleanup targets can complete, fail cleanup, or be superseded by stop, restart, or shutdown. `stopping.forStop` can complete, fail cleanup, or be superseded by restart or shutdown. Accepted start/resume can reach their success predicate, auth block, terminal failure, pause/stop/restart/shutdown, or timeout. The candidate does not choose exact byte-stable outcomes for those orderings.
- Two especially consequential choices remain unfrozen: whether shutdown completing in `stopped.shutdown` completes or cancels a pending stop, and whether a certified cleanup error ending in public `stopped` fails or completes that stop. The same requirement applies to start/resume/pause supersession and fault orderings.
- Unresolved public boundary: all six proposed codes are unique and bounded in the candidate, but repository source registers 0/6: `sync.control-rejected`, `sync.control-failed`, `sync.control-cancelled`, `sync.control-timeout`, `sync.control-idempotency-conflict`, and `sync.control-capacity`.
- Required orchestrator decision: accept a complete ordering-to-result table for every pending command, then authorize the exact shared error registrations and strict detail schemas, including the accepted UC01 identity in every last observation. An alternate smaller error algebra is lawful only if the orchestrator freezes it and it still proves F19 accepted/rejected/failed/cancelled/completed parity.

### R189-07 exact remaining scope: public incarnation identity

- Lane: public contract plus persistence/recovery.
- Status: high, consequential, and open after three rounds.
- Internal portion: candidate.3 correctly correlates decisions and snapshots by an ephemeral internal `incarnationId`, keeps `version` monotonic inside that incarnation, reconstructs childless, and never hydrates a snapshot.
- Public gap: accepted P1-C08 status and all operation-specific observed schemas are strict objects with `version` but no incarnation. E36 rejects both candidate-shaped additions. A caller cannot distinguish version 0 after reconstruction from version 0 in the prior process, so internal correlation cannot make public observations comparable.
- Required orchestrator decision: authorize a P1-C08 revision that adds one required bounded opaque `incarnationId` to every status and every success/non-success observed object, with versions comparable only when IDs match; or instead accept a durable globally monotonic lifecycle-version owner plus migration and revise D21. No accepted artifact currently owns the latter.

### R189-14 — Low, non-consequential, open: terminal-shutdown global policy has two holes

- Exact trace one: in `stopping.forShutdown`, a newer `credentials.changed` matches neither T059/T060 nor GEP04. GEP04 says strictly newer revisions otherwise take T059/T060 and never silently disappear during cleanup, which is false for this state.
- Exact trace two: T041 handles `control.stop.requested` only when `expectedVersionMatches`. A mismatch cannot use GEP01 because GEP01 excludes `stopping.forShutdown`; GEP06 does not list stop. The promised internal stale-version rejection therefore falls through to XState's implicit ignore and waiter timeout.
- Safety impact: neither trace starts work or violates terminal shutdown. The defect is checked-oracle completeness, not a new high/consequential choice.
- Required disposition after the orchestrator resolves the stopping condition: explicitly ignore newer credential revisions in both terminal shutdown states and route stale stop versions to the declared rejection, then extend PROP-09's construction corpus.

### Consequential decision dispositions after round 3

| Decision | Reviewer disposition | Evidence-backed resolution |
|---|---|---|
| D02 | **Accept replacement** | Strict status fixtures parse; the exact terminal marker remains required in `stopped.failed`, forbidden in `stopped.clean`, and preserved by the abstract transition proof. |
| D16 | **Accept semantics, not implementation-ready delivery** | Stable `paused`/`stopped` remains the correct completion postcondition. R189-06 still blocks exact failed/cancelled public delivery. |
| D17 | **Accept** | `authBlocked` is childless; pause clears safe auth detail and resume starts one fresh credential-bound actor. |
| D21 | **Reject as implementation-ready; accept only as the proposed UC01 direction** | Public `(incarnationId, version)` is supported by the restart counterexample, but strict accepted P1-C08 still rejects it. |
| D23 | **Accept replacement** | Latest/attempt/fault revision ordering remains complete without restarting healthy work. |
| D24 | **Accept replacement** | Shutdown dominates restart and controls; both certified cleanup success and error finish childless in `stopped.shutdown`. |

All six consequential decisions are explicitly resolved at the review level. D21 remains an unaccepted public-contract decision. D16 remains dependent on the unaccepted R189-06/UC02 resolver.

### Round-3 acceptance-claim audit

| Candidate.3 claim | Result | Exact evidence |
|---|---|---|
| Candidate version, digest, and frozen inputs are exact | Supported | E33. |
| 24 atomic states, 91 definitions, 204 expanded transitions, 24 events, 27 guards, 19 actions, 10 actors, 15 context entries, 20 invariants, 15 forbidden configurations, 14 properties, 24 paths, and 13 review responses | Supported | E34. |
| All references, shortest paths, actor deltas, cleanup inputs, and public keys resolve | Supported | E34. |
| All checked Markdown views are exact | Supported | E35: transitions 91/91 across nine fields; paths 24/24; guards 27/27; properties 14/14; traceability 7/7; forbidden 15/15; review responses 13/13 twice; decisions 26/26; states 24/24; context 15/15; actors 10/10; corpora 6/6. |
| Constructor status and declared success controls parse strict P1-C08 | Supported | E36: 48/48 status fixtures plus all declared success shapes. |
| Terminal-failure projection is constructive | Supported | E37: 27 reachable state/marker pairs, zero violations. |
| Wrong/stale/pre-promotion/replaced cleanup certificates cannot release a state | Supported | E38. |
| Versioned cleanup promotion and replacement cannot deadlock | Supported for every declared race/order family | E39/E40 on installed XState 5.32.5. Runtime conformance remains P3-C24. |
| P3-C10/P3-C11 writes, constructor/restart, credential races, shutdown, and queue pin remain exact | Supported | E41/E42. |
| Control timing and idempotency mechanics are bounded | Supported structurally and against installed subscription behavior | E43. |
| Control failed/cancelled/error semantics are complete and accepted | Rejected | E44; R189-06. |
| UC01 is accepted by P1-C08 | Rejected, as candidate.3 expects | E36; R189-07. |
| Every known locally illegal event follows globalEventPolicy | Rejected for two terminal-shutdown cases | E45; R189-14. |
| PROP-08 covers U01-U15 | Supported | E34/E35; R189-13 resolved. |

### Round-3 checks and adversarial probes

All commands ran from `/Users/john/.codex/worktrees/efa7/agent-mail`. No live iCloud, remote mutation, launchd, Tailscale, candidate/production/public-contract edit, commit, push, issue edit, or other GitHub mutation was performed.

| Evidence | Exact command or probe | Exit | Result |
|---|---|---:|---|
| E33 | `gh issue view 189 --repo johnlombardo-dev/agent-mail --json number,title,state,body,comments,labels,assignees,updatedAt,url`; same for 188; `shasum -a 256` over PLAN/EVIDENCE/four candidate files; four `git show <commit>:<path> \| shasum -a 256` probes | 0 | Model `0472e2c...`; checked views `e64b7bf...`, `ff11bdd...`, `de3dcc2...`; all six frozen pins exact. |
| E34 | Independent Bun inventory, unique-ID, reference, BFS, shortest-path, actor-delta, context-initial, cleanup-input, public-key, and PROP-08 verifier | 0 | Exact counts; 24/24 reachable; 203/203 post-init source-specific actor deltas; 15/15 initials; 13/13 cleanup inputs; U01-U15. |
| E35 | Independent Bun parser over transition and checked-view Markdown tables | 0 | 91/91 transition rows exact across nine fields and every inventory/detail count exact. |
| E36 | Direct Bun/Zod projection through accepted `sync-operations.ts` | 0 | 48/48 strict statuses; all candidate success shapes parse; UC01 status and observed additions strict-reject. |
| E37 | Bun abstract terminal-diagnostic transition exploration | 0 | 27 state/marker pairs; zero violations. |
| E38 | Bun literal cleanup admission and guard-clause matrix | 0 | Two valid cases admit; 11 wrong/narrow/stale/pre-promotion/replaced/audit cases reject; done guard 11/11 clauses; error guard shares them. |
| E39 | Installed-XState versioned registry/phase/lease harness | 0 | XState 5.32.5; 8/8 settlement/promotion/replacement orders reach `paused`, `stopped`, or `shutdown` only through a current certified phase. |
| E40 | Installed-XState cached certified error/replacement harness | 0 | Replacement lease 2 receives the cached phase error and current `onError` reaches `failed`. |
| E41 | Exact `jq` durable-write assertion plus `git show ... \| rg` against P3-C10/P3-C11 | 0 | Exact T110/T116/T117/T118/T150/T156/T157/T158 repositories and fields. |
| E42 | Bun credential and shutdown graph/order probes; exact P3-C07 `jq` pin | 0 | Credential permutations converge; shutdown trace `T053,T056,T055,T184,T056` has zero escapes; queue pin exact. |
| E43 | Installed-XState subscription probe plus control handshake/config/idempotency assertions | 0 | Late subscription has no replay; pre-registered no-op is observable; deadline `<=300000`, retention `<=86400000`, capacity `<=10000`; join/cache/conflict/eviction rules present. |
| E44 | Bun control action/resolver/reason/source-registration probe and pending-target exit enumeration | 0 | No failed/cancelled action, no resolver key, six candidate codes, 0/6 source registrations; all pause/stop supersession and terminal exits retained. |
| E45 | `jq` local-transition/global-policy projection for shutdown stop and credentials | 0 | T041 is guarded; no newer-credential local transition; GEP01 excludes shutdown and GEP04 covers only duplicate/older or already-stopped shutdown. |
| E46 | `bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts`; `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py` | 0 | 11 pass, 0 fail, 52 expectations; planning checker passes. |
| E47 | `jq empty`; final-newline/trailing-whitespace checks; `git diff --check --` over the four candidate files and review ledger; final candidate hashes | 0 | JSON valid; 5/5 final newlines; no trailing whitespace; diff check clean. Candidate hashes remained `0472e2c...`, `e64b7bf...`, `ff11bdd...`, and `de3dcc2...`. |
| E48 | `bun run format:check -- docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md` | 1 | Supplemental check reported format issues in all five files. No formatter was run because four candidate files are protected. This check was not a candidate.3 acceptance claim; E47's required syntax/whitespace/diff checks pass. |

The exact high-value commands are retained below. The full E39 harness implements a registry with `requestPhase`, per-phase pending/cached terminals, per-invoke wrappers, exact admission, and `finish`; its eight named output rows are the retained trace corpus.

```sh
shasum -a 256 PLAN.md docs/planning/EVIDENCE.md docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json
for spec in '13e036049099241d68b724639c467d9ae8e4424a:packages/contracts/src/sync-operations.ts' 'b6d07bc56e775cc7aea4b9436b81532bba7c4e9a:packages/daemon/src/initial-backfill-loop.ts' 'd5107472ffae6f5eb4deb8b87365ffda40fe30d3:packages/daemon/src/recurring-mailbox-sweep.ts' 'e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae:packages/imap/src/raw-download-queue.ts'; do printf '%s ' "$spec"; git show "$spec" | shasum -a 256 | awk '{print $1}'; done
jq -e 'def byid($id): .transitions[] | select(.id == $id) | .durableWrites; (["mailboxCheckpoint.uidNext","mailboxCheckpoint.modseq","mailboxCheckpoint.sweepCursor","mailboxCheckpoint.backfillCompleted","mailboxCheckpoint.observedVersion","initialBackfillCompletion.observedUidCeiling","initialBackfillCompletion.observedUidNext","initialBackfillCompletion.observedAt","initialBackfillCompletion.nextSweepEligibleAt"]) as $complete | (["initialBackfillCompletion.observedUidCeiling","initialBackfillCompletion.observedUidNext","initialBackfillCompletion.observedAt","initialBackfillCompletion.nextSweepEligibleAt"]) as $save | (byid("T110") == $complete and byid("T116") == $complete and byid("T117") == $save and byid("T118") == $save and byid("T150") == $complete and byid("T156") == $complete and byid("T157") == [] and byid("T158") == [] and ([.durableFacts[].id] == ["mailboxCheckpoint","initialBackfillCompletion"]))' docs/architecture/sync-statechart.model.json
jq -e '((.frozenInputs[] | select(.id=="P3-C07")) == {id:"P3-C07",issue:98,path:"packages/imap/src/raw-download-queue.ts",gitCommit:"e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae",sha256:"b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67"}) and ((.actors[] | select(.id=="rawDownloadQueue") | .acceptedArtifact) == {issue:98,planItem:"P3-C07",gitCommit:"e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae",path:"packages/imap/src/raw-download-queue.ts",sha256:"b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67"})' docs/architecture/sync-statechart.model.json
bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts
python3 .agents/skills/plan-agent-mail/scripts/check_plan.py
jq empty docs/architecture/sync-statechart.model.json
for file in docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md; do test "$(tail -c 1 "$file" | wc -l | tr -d ' ')" = 1 || exit 1; done
! rg -n '[[:blank:]]+$' docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md
git diff --check -- docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md
bun run format:check -- docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md
```

### Round-3 stopping condition and signature

Reviewer signature for digest `0472e2c0a11ac7cc1abc9677c5fe112fa710da7a655acfb15452ddb595fc10d9`: **WITHHELD**.

Reason: unresolved high/consequential findings R189-06 and R189-07. The same public-contract decisions remain unresolved after three review-response rounds, so another designer-only revision is prohibited by issue #189's stop condition. R189-14 is additionally open at low/non-consequential severity. The exact orchestrator decisions required are the UC01 public ordering identity and the UC02 complete pending-control resolver plus accepted public error algebra.

## Round 2 complete-candidate rereview

### Prior-finding disposition

| Finding | Round-2 severity/status | Mechanical disposition |
|---|---|---|
| R189-01 | Critical resolved, but superseded by narrower R189-12 | State minimum scope, registry/context effective scope, epoch, current invoke, dominance, and authoritative zero audit replace event-selected audit scope. Narrow, stale-epoch, and replaced-invoke probes now reject. The already-settled promotion edge remains separately open as R189-12. |
| R189-02 | High resolved | T117/T118 now list all four semantic `InitialBackfillCompletion` fields written by accepted P3-C10 `completions.save`; before/after non-CAS interruption is retained. |
| R189-03 | High resolved | The invented recurring repository is absent. T150/T156 use the same `InitialBackfillCompletionRepository.complete` transaction and exact five checkpoint plus four completion fields as accepted P3-C11. |
| R189-04 | High resolved | All 13 context fields have literals or validated constructor inputs. Both full six-field checkpoint fixtures parse in all 24 public atomic projections before start. |
| R189-05 | High resolved | The schema-invalid public key is gone. An abstract transition proof found no reachable `stopped.failed` without `sync.terminal-failure` and no reachable `stopped.clean` with it. |
| R189-06 | High consequential, open | Subscribe-before-send, pre/post snapshots, deadlines, and bounded idempotency are frozen. Exact failed/cancelled settlement mapping is still absent, and accepted contracts register 0/6 declared public control errors. UC02 remains open. |
| R189-07 | High consequential, open | The candidate correctly admits that internal incarnation correlation cannot repair the accepted public contract. Status and observed-control fixtures containing `incarnationId` are still rejected by strict P1-C08. UC01 remains open. |
| R189-08 | High resolved | Newer credential revisions latch in every non-shutdown state; actor attempts carry revisions; stale/current/future faults and both IDLE cleanup orderings converge as required. |
| R189-09 | High resolved | `stopping.forShutdown` and `stopped.shutdown` have no transition to live work. T053 -> T056 -> T055 -> T184 -> T056 remains childless and terminal. |
| R189-10 | Medium resolved | P3-C07 issue, commit, path, and SHA-256 match the accepted queue artifact in both frozen inputs and actor metadata. |
| R189-11 | Low resolved | The oracle and guard-branch view both contain exactly 27 guards. |

### R189-06 — High, consequential, open: control non-success behavior is not yet an accepted or complete public protocol

- Lane: public contract plus concurrency/workflow.
- Provenance: candidate.2 omission plus accepted-upstream boundary.
- Status: open; UC02 and an exact resolver table are required.
- Resolved portion: the handshake registers both listeners before synchronous `send`, captures `preSend` and `postSend`, accepts either decision/snapshot order, and clears both listeners plus the deadline on settlement. Installed XState 5.32.5 still does not replay a late subscription, but the new sequence no longer depends on replay. Deadline, retention, settled-LRU eviction, all-in-flight capacity, conflict, timeout replay, and reconstruction scope are bounded.
- Exact remaining evidence:
  - `sync-statechart.model.json:3606-3666` contains handshake, idempotency, and success-state sets, but no resolver mapping from an intervening internal state/event to failed or cancelled code/reason.
  - The action inventory can emit accepted, completed, pending, or rejected decisions. It has no failed or cancelled emission. The cancelled reasons occur only in `controlProjection.nonSuccess`; `auth-blocked` likewise occurs only in that schema.
  - A pending pause followed by stop, restart, shutdown, or cleanup error therefore still requires the implementer to choose the exact terminal control result. Byte-identical idempotency caching makes that choice externally observable.
  - Candidate.2 declares six unique bounded error shapes at lines 3667-3743, but the accepted contracts contain no registration call or those literals. E28 found `0/6` registered.
- Violated invariant/claim: F19's accepted/rejected/failed/cancelled/completed parity, issue #188's complete control projection, I13, PATH-CONTROL, and the zero-consequential-choice implementation gate.
- Required disposition: add a complete resolver table that maps each pending/superseding/terminal ordering to one exact success or `code`/`reason`, then accept UC02 in the shared error registry with strict Zod detail schemas and boundary fixtures. The registration must include UC01's accepted incarnation field.

### R189-07 — High, consequential, open: the required public incarnation identity is still outside accepted P1-C08

- Lane: public contract plus persistence/recovery.
- Provenance: accepted-upstream incompatibility and consequential D21.
- Status: open; D21 is not implementation-ready.
- Exact evidence:
  - Candidate.2 keeps `context.version` incarnation-scoped and explicitly marks UC01 blocking at `sync-statechart.model.json:4566-4573`.
  - Accepted P1-C08 remains strict and has only `version` in status and observed-control shapes. E20 rejected both a status and a completed stop observation containing candidate UC01's `incarnationId`.
  - A client can still observe version 80, cross reconstruction, then receive indistinguishable public version 0. Internal waiter identity does not repair that public ordering ambiguity.
- Violated invariant/claim: F19 observed-version truth, I11/I13 public conformance, and restart observation closure.
- Required disposition: accept a P1-C08 revision that requires a fresh bounded public incarnation identity in every status, success observation, and last non-success observation, and freezes comparison only within matching identities; alternatively accept a durable globally monotonic version owner and migration. Until then candidate.2 must remain blocked and unsigned.

### R189-12 — High, consequential, open: cleanup promotion has no defined post-settlement rearm and its certificate predicate contradicts wrong-scope rejection

- Lane: lifecycle/resource ownership plus concurrency/workflow and installed XState semantics.
- Provenance: candidate.2 internal inconsistency and runtime counterexample.
- Status: open; designer revision required.
- Exact evidence:
  - `cleanupBarrier` is a one-result `fromPromise`. The oracle says replacements attach to the same memoized job/epoch and a pre-promotion watch certificate cannot release a workflow state (`sync-statechart.model.json:774-795`).
  - The literal `cleanupCertificateCoversState` predicate at lines 539-545 checks certificate epoch, current invoke, registry/context scope, dominance, and registry audit, but never checks `certificate.effectiveScope === registry.effectiveScope`. E22 therefore admits a current wrong-scope certificate when the authoritative workflow audit is zero, contrary to GEP05, U12, PROP-10, and the coverage certificate corpus.
  - If the prose-required scope equality/rejection is implemented, E23 shows the liveness failure: resolve the shared watch promise, synchronously send pause before the promise done microtask, promote to workflow, and replace the invoke. The current replacement consumes the already-resolved watch result, rejects it, and remains active in `closingForPause`; the one-result job has no later workflow terminal.
- Concrete counterexample: `watching.closingForSweep` owns epoch 1/watch; the registry job settles watch and queues completion; pause wins mailbox ordering and promotes epoch 1 to workflow; the replacement `fromPromise` attaches to that already-settled job. Candidate.2 must either accept the now-current but prohibited watch result, or reject it and deadlock the pause waiter.
- Violated invariant/claim: issue #189's deadlock attempt, I06/I07, U01/U02/U07/U12, PROP-02/PROP-07/PROP-10, PATH-ACTOR, and the claim that only a workflow certificate can release the promoted state.
- Required disposition: freeze a linearizable promotion/settlement protocol. At minimum, require certificate scope equality and specify how promotion after watch settlement but before `finishCleanupScope` produces a fresh workflow audit and terminal for the current invoke. A versioned cleanup phase or callback/child-machine controller may fit better than one memoized one-result promise. Retain the exact resolve-then-promote-before-done trace.

### R189-13 — Low, non-consequential, open: PROP-08 retains the old forbidden-configuration range

- Lane: checked view/oracle consistency.
- Provenance: candidate.2 normative text and checked view.
- Status: open.
- Exact evidence: the oracle and coverage ledger now contain U01-U15, but PROP-08 still says only “Every U01-U11 forbidden configuration remains unreachable” (`sync-statechart.coverage.md:275`). PROP-10 through PROP-13 separately name U12-U14 behavior and PROP-11 covers U15, so this is not a missing safety obligation; it is a false generated-property completeness claim.
- Required disposition: make PROP-08 cover U01-U15 or explicitly map every forbidden configuration to the property that constructs it.

### Consequential decision dispositions after round 2

| Decision | Reviewer disposition | Evidence-backed resolution |
|---|---|---|
| D02 | **Accept replacement** | The terminal marker is schema-compatible state metadata, `sync.terminal-failure` is required/forbidden exactly, all literal status fixtures parse, and the transition abstraction preserves the marker invariant. |
| D16 | **Accept** | Pause and stop do not return success while cleanup is active. Stable `paused`/`stopped` remains the correct postcondition; R189-06 still blocks exact public non-success delivery. |
| D17 | **Accept** | `authBlocked` is childless; explicit pause safely clears auth detail and resume performs a fresh credential-bound start. |
| D21 | **Reject as implementation-ready; accept only the proposed upstream replacement** | The need for public `(incarnationId, version)` is supported, but UC01 is not accepted and strict P1-C08 rejects it. Internal identity is insufficient. |
| D23 | **Accept replacement** | The latest/active/fault revision protocol covers revision-before-fault and fault-before-revision without restarting healthy work or losing repair. |
| D24 | **Accept replacement** | Shutdown now dominates restart and all controls for the incarnation; both certified cleanup success and error end in childless `stopped.shutdown`. |

All six decisions are explicitly reviewed. D21 remains consequential and unresolved for implementation. D16 remains semantically accepted but depends on R189-06 for a complete public result protocol.

### Round-2 acceptance-claim audit

| Candidate.2 claim | Result | Exact evidence |
|---|---|---|
| Candidate version, digest, and frozen inputs are exact | Supported | E17. |
| 24 atomic states, 91 definitions, 204 expanded transitions, 24 events, 27 guards, 19 actions, 10 actors, 20 invariants, 15 forbidden configurations, 14 properties, and 24 paths | Supported structurally | E18. |
| All IDs, sources, targets, guards, actions, actors, durable writes, actor deltas, and shortest paths resolve | Supported structurally | E18. |
| All 91 Markdown transition rows match all nine JSON fields; inventory/detail rows agree | Supported | E19. |
| All literal public status fixtures and declared success controls parse accepted P1-C08 | Supported | E20 parsed 48/48 empty/populated atomic fixtures and every declared success state. |
| UC01 is compatible with accepted P1-C08 | Rejected, as candidate.2 expects | E20 strict-rejected both status and observed shapes containing `incarnationId`; R189-07. |
| Terminal failure is schema-valid and state-discriminating | Supported as design invariant | E21 found zero abstract marker violations. Runtime conformance remains downstream. |
| Wrong/narrow/stale/pre-promotion/replaced cleanup certificates cannot settle or deadlock | Rejected in part | Narrow, stale, and replaced reject. Wrong certificate scope passes the literal predicate, while prose-required pre-promotion rejection can deadlock an already-settled replacement. E22/E23; R189-12. |
| P3-C10/P3-C11 durable writes and restart boundaries are exact | Supported | E24 matches both accepted sources and all four terminal result families. |
| Constructor status and restart reconstruction are fully seeded without snapshot hydration | Supported structurally | E18/E20 and `initializationProtocol`; populated status is not defaulted to zero. |
| Credential races converge without a lost wakeup | Supported structurally | E25 covers newer/stale/current/future and both IDLE cleanup orderings. |
| Shutdown cannot recreate a child in the same incarnation | Supported structurally | E26 finds no graph escape and exercises success/error terminal paths. |
| Control subscription and idempotency bounds are complete | Supported for timing/bounds | E27 confirms the original late-subscription risk; candidate.2's pre-registration plus pre/post read closes it. Configuration and cache rules are bounded. |
| Control failed/cancelled/error public semantics are complete | Rejected | No exact failed/cancelled resolver exists and accepted contracts register 0/6 codes. E28; R189-06. |
| Queue contract is exactly frozen | Supported | E29. |
| Every U01-U15 is covered by PROP-08 | Rejected as written | PROP-08 names only U01-U11; R189-13. |

### Round-2 checks and adversarial probes

All commands ran from `/Users/john/.codex/worktrees/efa7/agent-mail`. No live iCloud, remote mutation, launchd, Tailscale, candidate/production edit, commit, push, issue edit, or other GitHub mutation was performed.

| Evidence | Command or probe | Exit | Result |
|---|---|---:|---|
| E17 | `gh issue view 189 ... --json ...`; `gh issue view 188 ... --json ...`; SHA-256 commands over candidate, PLAN/EVIDENCE, and four frozen Git objects | 0 | Candidate.2 model `7eba62c...`; checked-view hashes `84940c...`, `60edd4...`, `6d6351...`; all six frozen pins match. |
| E18 | Independent Bun inventory/reference/reachability/path/actor-delta verifier | 0 | Exact counts; references resolved; 24/24 reachable and path-valid; 204/204 actor deltas; 13/13 context initials. |
| E19 | Independent Bun semantic parser over the complete transition table and all checked inventory/detail tables | 0 | 91/91 rows match all nine fields; paths 24/24, guards 27/27, properties 14/14, traceability 7/7, forbidden 15/15, response rows 11/11 in both views, decisions 25/25, states 24/24, context 13/13, actors 10/10. |
| E20 | Bun direct Zod projection through accepted sync schemas | 0 | 48/48 empty/populated atomic status fixtures and all declared success controls parse; UC01 status and observed additions both strict-reject as expected. |
| E21 | Bun abstract terminal-diagnostic transition exploration | 0 | 27 reachable state/marker pairs; zero `stopped.clean`/`stopped.failed` marker violations. |
| E22 | Bun literal cleanup predicate matrix | 0 | Valid watch/workflow admit; narrow registry, stale epoch, and replaced invoke reject; wrong certificate scope admits because scope equality is absent. |
| E23 | Installed XState 5.32.5 resolved-promise promotion/replacement probe | 0 | Ends active in `closingForPause`; no later terminal exists. R189-12 reproduced. |
| E24 | Exact `jq` durable-write assertions plus `git show ... | rg` against P3-C10/P3-C11 | 0 | T110/T116/T150/T156 have exact 5+4 fields; T117/T118 exact four save fields; T157/T158 none; only the two accepted durable fact families exist. |
| E25 | Bun credential transition/guard ordering probe | 0 | Both credential/auth orderings converge; stable current faults block; stale faults restart latest; future faults terminate; duplicates use GEP04. |
| E26 | Bun shutdown trace plus graph-escape check | 0 | T053 -> T056 -> T055 -> T184 -> T056 ends childless `stopped.shutdown`; T185 also ends there; zero live-state escapes. |
| E27 | Installed XState 5.32.5 late/pre-registered subscription probe | 0 | Late subscription sees no replay; candidate.2's registered-before-send plus pre/post snapshot path has an observation and cannot miss a no-op. |
| E28 | Bun control action/reason/registration inspection | 0 | Six unique bounded declarations, no failed/cancelled resolver action or table, and 0/6 accepted-source registrations. |
| E29 | Exact P3-C07 JSON pin assertion plus frozen-source SHA-256 | 0 | Both oracle pins match issue 98, commit, path, and `b676dee...`. |
| E30 | `bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts` | 0 | 11 pass, 0 fail, 52 expectations. |
| E31 | `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py` | 0 | PASS: all required evidence and failure shields present. |
| E32 | `jq empty`; final-newline/trailing-whitespace loop; `git diff --check --` over candidate plus review ledger; final SHA-256 | 0 | JSON, final newline, trailing whitespace, and diff checks pass. Final hashes are model `7eba62c...`, design `84940c...`, decisions `60edd4...`, coverage `6d6351...`. |

The full repository `ready` gate remains intentionally excluded. Candidate.2 is design-only and unrelated concurrent production drafts plus generated outputs are present, so a whole-repository result would not be attributable to these four candidate files.

Four exploratory harness commands failed before their corrected equivalents above: a zsh scalar-splitting loop produced invalid Git object names; the first actor-delta checker incorrectly expected targetless transitions to stop actors; two checked-view parser versions misread blank parent cells; and one queue-pin `jq` expression was missing a closing object brace. The corrected commands are E17, E18, E19, and E29. These were reviewer-harness errors, not candidate findings.

### Round-2 exact command appendix

E17:

```sh
gh issue view 189 --repo johnlombardo-dev/agent-mail --json number,title,state,body,comments --jq '{number,title,state,body,comments:[.comments[]|{author:.author.login,createdAt,body}]}'
gh issue view 188 --repo johnlombardo-dev/agent-mail --json number,title,state,body,comments --jq '{number,title,state,body,comments:[.comments[]|{author:.author.login,createdAt,body}]}'
git status --short
git rev-parse HEAD
shasum -a 256 PLAN.md docs/planning/EVIDENCE.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md
git show 13e036049099241d68b724639c467d9ae8e4424a:packages/contracts/src/sync-operations.ts | shasum -a 256
git show b6d07bc56e775cc7aea4b9436b81532bba7c4e9a:packages/daemon/src/initial-backfill-loop.ts | shasum -a 256
git show d5107472ffae6f5eb4deb8b87365ffda40fe30d3:packages/daemon/src/recurring-mailbox-sweep.ts | shasum -a 256
git show e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae:packages/imap/src/raw-download-queue.ts | shasum -a 256
```

E18:

```sh
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const atomic=m.states.filter((s)=>s.kind==="atomic"); const atomicMap=new Map(atomic.map((s)=>[s.id,s])); const sets={event:new Set(m.events.map((x)=>x.id)),guard:new Set(m.guards.map((x)=>x.id)),action:new Set(m.actions.map((x)=>x.id)),actor:new Set(m.actors.map((x)=>x.id))}; const uniq=(xs)=>new Set(xs).size===xs.length; for(const [name,xs] of [["states",m.states],["events",m.events],["guards",m.guards],["actions",m.actions],["actors",m.actors],["transitions",m.transitions],["invariants",m.invariants],["forbidden",m.unreachableStateAccount.forbiddenConfigurations],["properties",m.coverage.properties],["globalPolicies",m.globalEventPolicy]]) if(!uniq(xs.map((x)=>x.id))) throw Error(`duplicate ${name}`); const durable=new Set(m.durableFacts.flatMap((f)=>f.fields.map((field)=>`${f.id}.${field}`))); for(const s of atomic) for(const a of s.invokedActors) if(!sets.actor.has(a)) throw Error(`bad state actor ${s.id}:${a}`); for(const t of m.transitions){const sources=Array.isArray(t.source)?t.source:[t.source]; for(const s of sources) if(s!=="@uninitialized"&&!atomicMap.has(s)) throw Error(`bad source ${t.id}:${s}`); if(t.target!==null&&!atomicMap.has(t.target)) throw Error(`bad target ${t.id}:${t.target}`); if(!sets.event.has(t.event)) throw Error(`bad event ${t.id}:${t.event}`); for(const g of t.guards) if(!sets.guard.has(g)) throw Error(`bad guard ${t.id}:${g}`); for(const a of t.actions) if(!sets.action.has(a)) throw Error(`bad action ${t.id}:${a}`); for(const a of [...t.stoppedActors,...t.startedActors]) if(!["@source","@target"].includes(a)&&!sets.actor.has(a)) throw Error(`bad actor ${t.id}:${a}`); for(const w of t.durableWrites) if(!durable.has(w)) throw Error(`bad write ${t.id}:${w}`); for(const source of sources){const expectedStop=t.target===null||source==="@uninitialized"?[]:atomicMap.get(source).invokedActors; const actualStop=t.stoppedActors.includes("@source")?expectedStop:t.stoppedActors; const expectedStart=t.target===null?[]:atomicMap.get(t.target).invokedActors; const actualStart=t.startedActors.includes("@target")?expectedStart:t.startedActors; if(JSON.stringify([...actualStop].sort())!==JSON.stringify([...expectedStop].sort())) throw Error(`stop delta ${t.id}:${source}`); if(JSON.stringify([...actualStart].sort())!==JSON.stringify([...expectedStart].sort())) throw Error(`start delta ${t.id}:${source}`)}} const reached=new Set([m.machine.initial]); let changed=true; while(changed){changed=false; for(const t of m.transitions){const sources=Array.isArray(t.source)?t.source:[t.source]; if(t.target&&sources.some((s)=>s==="@uninitialized"||reached.has(s))&&!reached.has(t.target)){reached.add(t.target);changed=true}}} const missingAtomic=atomic.map((s)=>s.id).filter((id)=>!reached.has(id)); if(missingAtomic.length) throw Error(`unreachable ${missingAtomic}`); for(const p of m.coverage.generatedStatePaths){let state="@uninitialized"; for(const id of p.transitionIds){const t=m.transitions.find((x)=>x.id===id); if(!t) throw Error(`path ${p.state} unknown ${id}`); const sources=Array.isArray(t.source)?t.source:[t.source]; if(!sources.includes(state)) throw Error(`path ${p.state} ${id} from ${state}`); state=t.target??state} if(state!==p.state) throw Error(`path ${p.state} ended ${state}`)} const used={guards:new Set(m.transitions.flatMap((t)=>t.guards)),actions:new Set([...m.transitions.flatMap((t)=>t.actions),...m.globalEventPolicy.flatMap((p)=>p.actions)]),events:new Set([...m.transitions.map((t)=>t.event),...m.globalEventPolicy.flatMap((p)=>p.events.filter((e)=>e!=="any unknown event"))])}; for(const [name,inventory] of [["guards",m.guards],["actions",m.actions],["events",m.events]]){const miss=inventory.map((x)=>x.id).filter((id)=>!used[name].has(id)); if(miss.length) throw Error(`unused ${name}:${miss}`)} const counts={atomic:atomic.length,definitions:m.transitions.length,expanded:m.transitions.reduce((n,t)=>n+(Array.isArray(t.source)?t.source.length:1),0),events:m.events.length,guards:m.guards.length,actions:m.actions.length,actors:m.actors.length,invariants:m.invariants.length,forbidden:m.unreachableStateAccount.forbiddenConfigurations.length,properties:m.coverage.properties.length,paths:m.coverage.generatedStatePaths.length,contexts:m.context.length}; const expected={atomic:24,definitions:91,expanded:204,events:24,guards:27,actions:19,actors:10,invariants:20,forbidden:15,properties:14,paths:24,contexts:13}; if(JSON.stringify(counts)!==JSON.stringify(expected)) throw Error(JSON.stringify(counts)); if(!m.context.every((x)=>Object.hasOwn(x,"initial"))) throw Error("missing context initial"); console.log(JSON.stringify({counts,references:"resolved",reachability:`${reached.size}/${atomic.length}`,paths:"24/24 valid",actorDeltas:"204/204 exact",inventoryUse:"complete",contextInitials:"13/13"}));'
```

E19:

```sh
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const text=await Bun.file("docs/architecture/sync-statechart.coverage.md").text(); const rows=text.split("\n").filter((line)=>/^\| `T[^`]+` \|/.test(line)); const items=(cell)=>cell.trim()==="—"?[]:cell.trim().split("<br>").map((x)=>x.replaceAll("`","").trim()); const failures=[]; for(let i=0;i<m.transitions.length;i++){const t=m.transitions[i]; const row=rows[i]; if(!row){failures.push(`${t.id}:missing`);continue} const c=row.split("|").slice(1,-1).map((x)=>x.trim()); const id=c[0].replaceAll("`",""); const source=items(c[1]); const guards=items(c[3]); const target=items(c[4]); const actions=items(c[5]); const [stopCell,startCell]=c[6].split("→").map((x)=>x.trim()); const stopped=items(stopCell); const started=items(startCell); const writes=items(c[7]); const expectedSource=Array.isArray(t.source)?t.source:[t.source]; const checks=[[id,t.id,"id"],[JSON.stringify(source),JSON.stringify(expectedSource),"source"],[c[2].replaceAll("`",""),t.event,"event"],[JSON.stringify(guards),JSON.stringify(t.guards),"guards"],[JSON.stringify(target),JSON.stringify(t.target===null?[]:[t.target]),"target"],[JSON.stringify(actions),JSON.stringify(t.actions),"actions"],[JSON.stringify(stopped),JSON.stringify(t.stoppedActors),"stopped"],[JSON.stringify(started),JSON.stringify(t.startedActors),"started"],[JSON.stringify(writes),JSON.stringify(t.durableWrites),"writes"],[c[8],t.observation,"observation"]]; for(const [actual,expected,label] of checks) if(actual!==expected) failures.push(`${t.id}:${label}:${actual}!=${expected}`)} if(rows.length!==m.transitions.length) failures.push(`row-count:${rows.length}/${m.transitions.length}`); if(failures.length) throw Error(failures.slice(0,10).join("\n")); console.log(`markdown transition rows ${rows.length}/${m.transitions.length} exact across all nine fields`);'
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const cov=await Bun.file("docs/architecture/sync-statechart.coverage.md").text(); const design=await Bun.file("docs/architecture/sync-statechart.md").text(); const decisions=await Bun.file("docs/architecture/sync-statechart.decisions.md").text(); const section=(text,start,end)=>{const a=text.indexOf(start); const b=text.indexOf(end,a+start.length); if(a<0||b<0) throw Error(`section ${start}`); return text.slice(a,b)}; const ids=(text,re)=>[...text.matchAll(re)].map((x)=>x[1]); const eq=(label,a,b)=>{if(JSON.stringify(a)!==JSON.stringify(b)) throw Error(`${label}\n${JSON.stringify(a)}\n${JSON.stringify(b)}`)}; eq("coverage paths",ids(section(cov,"### Retained shortest state paths","### Guard-branch inventory"),/^\| `([^`]+)` \|/gm),m.coverage.generatedStatePaths.map((x)=>x.state)); eq("coverage guards",ids(section(cov,"### Guard-branch inventory","### Generated properties"),/^\| `([^`]+)` \|/gm),m.guards.map((x)=>x.id)); eq("coverage properties",ids(section(cov,"### Generated properties","## F01"),/^\| `([^`]+)` \|/gm),m.coverage.properties.map((x)=>x.id)); eq("coverage traceability",ids(section(cov,"## F01/F03/F17-F20/S05 traceability","## Reachability"),/^\| `([^`]+)` \|/gm),m.traceability.map((x)=>x.id)); eq("coverage forbidden",ids(section(cov,"## Reachability and forbidden-state account","## R189 response"),/^\| `([^`]+)` \|/gm),m.unreachableStateAccount.forbiddenConfigurations.map((x)=>x.id)); eq("coverage reviews",ids(section(cov,"## R189 response coverage","## Upstream-blocker"),/^\| `([^`]+)` \|/gm),m.reviewResponses.map((x)=>x.id)); eq("decision reviews",ids(section(decisions,"## Independent-ledger response","## Blocking upstream"),/^\| (R189-[0-9]+) \|/gm),m.reviewResponses.map((x)=>x.id)); const decisionIds=ids(section(decisions,"## Frozen architecture decisions","## Independent-ledger"),/^\| (D[0-9]+) \|/gm); if(decisionIds.length!==25||decisionIds[0]!=="D01"||decisionIds.at(-1)!=="D25") throw Error(`decisions ${decisionIds}`); const atomicIds=new Set(m.states.filter((s)=>s.kind==="atomic").map((s)=>s.id)); const designStates=section(design,"## Lifecycle authority and hierarchy","## Complete context").split("\n").map((line)=>line.split("|")[2]?.trim().replaceAll("`","")).filter((id)=>atomicIds.has(id)); eq("design states",designStates,[...atomicIds]); const contextIds=ids(section(design,"## Complete context and configuration","## Complete event"),/^\| `([^`]+)` \|/gm); eq("design context",contextIds,m.context.map((x)=>x.id)); const actorIds=ids(section(design,"## Actor and effect ownership","## Authoritative cleanup"),/^\| `([^`]+)` \|/gm); eq("design actors",actorIds,m.actors.map((x)=>x.id)); console.log(JSON.stringify({coveragePaths:"24/24",coverageGuards:"27/27",coverageProperties:"14/14",traceability:"7/7",forbidden:"15/15",reviewRows:"11/11 both views",decisions:"25/25",designStates:"24/24",designContext:"13/13",designActors:"10/10"}));'
```

E20 and E21:

```sh
bun -e 'import {syncStatusResponseSchema,syncStartResponseSchema,syncPauseResponseSchema,syncResumeResponseSchema,syncStopResponseSchema} from "./packages/contracts/src/sync-operations.ts"; const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const atomics=m.states.filter((s)=>s.kind==="atomic"); for(const s of atomics){const keys=Object.keys(s.public).sort(); if(JSON.stringify(keys)!==JSON.stringify(["activeOperation","actorState","authBlocked"])) throw Error(`${s.id} public keys ${keys}`)} let parsed=0; for(const fixture of m.initializationProtocol.fixtures){for(const s of atomics){const authBlocked=s.id==="authBlocked"?{reason:"credentials-invalid",detail:"provider rejected credentials"}:null; const diagnostics=s.id==="stopped.failed"?[{code:"sync.terminal-failure",message:"Workflow stopped after a terminal failure."}]:[]; syncStatusResponseSchema.parse({...s.public,authBlocked,version:0,checkpoint:fixture.constructorCheckpoint,diagnostics}); parsed++}} const id="command-1"; const version=4; const commands=m.controlProjection.commands; for(const state of commands.start.accepted) syncStartResponseSchema.parse({accepted:true,commandId:id,observed:{actorState:state,version}}); for(const state of commands.start.completed) syncStartResponseSchema.parse({accepted:true,completed:true,commandId:id,observed:{actorState:state,version}}); for(const state of commands.pause.completed) syncPauseResponseSchema.parse({accepted:true,completed:true,commandId:id,observed:{actorState:state,version}}); for(const state of commands.resume.accepted) syncResumeResponseSchema.parse({accepted:true,commandId:id,observed:{actorState:state,version}}); for(const state of commands.resume.completed) syncResumeResponseSchema.parse({accepted:true,completed:true,commandId:id,observed:{actorState:state,version}}); for(const state of commands.stop.completed) syncStopResponseSchema.parse({accepted:true,completed:true,commandId:id,observed:{actorState:state,version}}); const checkpoint=m.initializationProtocol.fixtures[0].constructorCheckpoint; const ucStatus=syncStatusResponseSchema.safeParse({actorState:"stopped",activeOperation:null,authBlocked:null,version:0,incarnationId:"inc-1",checkpoint,diagnostics:[]}); const ucObserved=syncStopResponseSchema.safeParse({accepted:true,completed:true,commandId:id,observed:{actorState:"stopped",version:0,incarnationId:"inc-1"}}); if(ucStatus.success||ucObserved.success) throw Error("UC01 unexpectedly accepted"); console.log(JSON.stringify({strictStatusFixtures:`${parsed}/${atomics.length*2}`,successControlFixtures:"all declared states parse",literalPublicKeys:"24/24 exact",UC01:{status:"strict rejection",observed:"strict rejection"}}));'
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const queue=[{state:"@uninitialized",marker:false,path:[]}]; const seen=new Set(); const violations=[]; while(queue.length){const n=queue.shift(); const key=`${n.state}:${n.marker}`; if(seen.has(key)) continue; seen.add(key); if(n.state==="stopped.clean"&&n.marker) violations.push({...n,why:"clean has marker"}); if(n.state==="stopped.failed"&&!n.marker) violations.push({...n,why:"failed lacks marker"}); for(const t of m.transitions){const src=Array.isArray(t.source)?t.source:[t.source]; if(!src.includes(n.state)) continue; let marker=n.marker; if(t.actions.includes("recordTerminalFailure")) marker=true; if(t.actions.includes("clearTerminalFailure")) marker=false; queue.push({state:t.target??n.state,marker,path:[...n.path,t.id]})}} if(violations.length) throw Error(JSON.stringify(violations.slice(0,3))); const incoming=m.transitions.filter((t)=>t.target==="stopped.failed").map((t)=>({id:t.id,sources:t.source,record:t.actions.includes("recordTerminalFailure")})); console.log(JSON.stringify({terminalDiagnosticAbstractStates:seen.size,violations:0,incoming}));'
```

E22 and E23:

```sh
bun -e 'const order={watch:0,workflow:1}; const literal=({currentInvoke,certificateEpoch,contextEpoch,registryScope,contextScope,minimumScope,audit})=>currentInvoke&&certificateEpoch===contextEpoch&&registryScope===contextScope&&order[registryScope]>=order[minimumScope]&&audit[registryScope]===0; const base={currentInvoke:true,certificateEpoch:7,contextEpoch:7,registryScope:"workflow",contextScope:"workflow",minimumScope:"workflow",audit:{watch:0,workflow:0}}; const cases={validWorkflow:literal(base),wrongCertificateScope:literal({...base,certificateScope:"watch"}),narrowRegistry:literal({...base,registryScope:"watch",contextScope:"watch",audit:{watch:0,workflow:1}}),staleEpoch:literal({...base,certificateEpoch:6}),replacedInvoke:literal({...base,currentInvoke:false}),validWatch:literal({...base,registryScope:"watch",contextScope:"watch",minimumScope:"watch",audit:{watch:0,workflow:1}})}; console.log(JSON.stringify(cases)); if(cases.validWorkflow!==true||cases.validWatch!==true||cases.narrowRegistry!==false||cases.staleEpoch!==false||cases.replacedInvoke!==false||cases.wrongCertificateScope!==true) process.exit(1);'
bun -e 'import {assign,createActor,createMachine,fromPromise} from "xstate"; let release; const shared=new Promise((resolve)=>{release=resolve}); const cleanup=fromPromise(()=>shared); const machine=createMachine({context:{effectiveScope:"watch"},initial:"closingForSweep",states:{closingForSweep:{invoke:{id:"cleanupBarrier",src:cleanup,onDone:{guard:({context,event})=>event.output.effectiveScope===context.effectiveScope,target:"sweeping"}},on:{PAUSE:{target:"closingForPause",actions:assign({effectiveScope:()=>"workflow"})}}},closingForPause:{invoke:{id:"cleanupBarrier",src:cleanup,onDone:{guard:({context,event})=>event.output.effectiveScope===context.effectiveScope,target:"paused"}}},sweeping:{},paused:{}}}); const actor=createActor(machine).start(); release({cleanupEpoch:1,effectiveScope:"watch",released:true,authoritativeAudit:0}); actor.send({type:"PAUSE"}); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); console.log(JSON.stringify({state:actor.getSnapshot().value,effectiveScope:actor.getSnapshot().context.effectiveScope,status:actor.getSnapshot().status,note:"replacement invoke consumed the already-settled watch result; no later terminal exists"})); actor.stop();'
```

E24:

```sh
jq -e 'def byid($id): .transitions[] | select(.id == $id) | .durableWrites; (["mailboxCheckpoint.uidNext","mailboxCheckpoint.modseq","mailboxCheckpoint.sweepCursor","mailboxCheckpoint.backfillCompleted","mailboxCheckpoint.observedVersion","initialBackfillCompletion.observedUidCeiling","initialBackfillCompletion.observedUidNext","initialBackfillCompletion.observedAt","initialBackfillCompletion.nextSweepEligibleAt"]) as $complete | (["initialBackfillCompletion.observedUidCeiling","initialBackfillCompletion.observedUidNext","initialBackfillCompletion.observedAt","initialBackfillCompletion.nextSweepEligibleAt"]) as $save | (byid("T110") == $complete and byid("T116") == $complete and byid("T117") == $save and byid("T118") == $save and byid("T150") == $complete and byid("T156") == $complete and byid("T157") == [] and byid("T158") == [] and ([.durableFacts[].id] == ["mailboxCheckpoint","initialBackfillCompletion"]))' docs/architecture/sync-statechart.model.json
git show b6d07bc56e775cc7aea4b9436b81532bba7c4e9a:packages/daemon/src/initial-backfill-loop.ts | rg -n 'completions\.(save|complete)|observedUidCeiling:|observedUidNext:|observedAt:|nextSweepEligibleAt:|uid_next_known|modseq_known|sweep_cursor|backfill_completed|observed_version = observed_version \+ 1'
git show d5107472ffae6f5eb4deb8b87365ffda40fe30d3:packages/daemon/src/recurring-mailbox-sweep.ts | rg -n 'InitialBackfillCompletionRepository|completions\.(read|complete)|sweepCursor:|backfillCompleted:|observedAt:|nextSweepEligibleAt:|observedUidCeiling:|observedUidNext:'
```

E25 through E29:

```sh
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const ts=(source,event)=>m.transitions.filter((t)=>(Array.isArray(t.source)?t.source:[t.source]).includes(source)&&t.event===event); const ids=(xs)=>xs.map((x)=>x.id); const results={revisionThenBootstrapAuth:[ids(ts("starting.active","credentials.changed")),ids(ts("starting.active","xstate.error.actor.bootstrapSession"))],revisionThenIdleAuth:[ids(ts("watching.idling","credentials.changed")),ids(ts("watching.idling","idle.failed")),ids(ts("watching.closingForAuthBlock","xstate.done.actor.cleanupBarrier"))],authThenRevisionDuringCleanup:[ids(ts("watching.idling","idle.failed")),ids(ts("watching.closingForAuthBlock","credentials.changed")),ids(ts("watching.closingForAuthBlock","xstate.done.actor.cleanupBarrier"))],stableAuthBlocked:ids(ts("authBlocked","credentials.changed"))}; const expected={revisionThenBootstrapAuth:[["T059"],["T097","T098","T102","T103","T104","T105"]],revisionThenIdleAuth:[["T059"],["T124F","T125","T126","T127","T128"],["T139","T142"]],authThenRevisionDuringCleanup:[["T124F","T125","T126","T127","T128"],["T059"],["T139","T142"]],stableAuthBlocked:["T060"]}; if(JSON.stringify(results)!==JSON.stringify(expected)) throw Error(JSON.stringify(results)); const guards=Object.fromEntries(m.guards.map((g)=>[g.id,g.predicate])); for(const id of ["authFaultUsesSupersededRevision","authFaultUsesCurrentRevision","authFaultUsesFutureRevision","pendingAuthFaultWasSuperseded","pendingAuthFaultIsCurrent"]) if(!guards[id]) throw Error(id); console.log(JSON.stringify({results,convergence:{olderAttemptAfterRevision:"T097/T107/T146 or T139",currentAttempt:"T102/T112/T152 or T142",futureAttempt:"T098/T108/T124F/T147",duplicateOrOlderRevision:"GEP04"}}));'
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const transitionsFrom=(state)=>m.transitions.flatMap((t)=>(Array.isArray(t.source)?t.source:[t.source]).includes(state)?[t]:[]); const terminal=new Set(["stopping.forShutdown","stopped.shutdown"]); const bad=[]; for(const state of terminal) for(const t of transitionsFrom(state)) if(t.target!==null&&!terminal.has(t.target)) bad.push({state,id:t.id,target:t.target}); if(bad.length) throw Error(JSON.stringify(bad)); const by=(state,event)=>transitionsFrom(state).find((t)=>t.event===event); let state="starting.active"; const trace=[]; for(const event of ["process.shutdown.requested","lifecycle.restart.requested","process.shutdown.requested","xstate.done.actor.cleanupBarrier","lifecycle.restart.requested"]){const t=by(state,event); if(!t) throw Error(`${state}:${event}`); trace.push(t.id); state=t.target??state} const failedCleanup=by("stopping.forShutdown","xstate.error.actor.cleanupBarrier"); console.log(JSON.stringify({trace,state,badEscapes:bad.length,shutdownError:{id:failedCleanup.id,target:failedCleanup.target},children:m.states.find((s)=>s.id===state).invokedActors}));'
bun -e 'import {createActor,createMachine} from "xstate"; const actor=createActor(createMachine({initial:"a",states:{a:{on:{GO:"b",NOOP:{}}},b:{on:{NOOP:{}}}}})).start(); actor.send({type:"GO"}); const late=[]; const lateSub=actor.subscribe((s)=>late.push(s.value)); await Promise.resolve(); lateSub.unsubscribe(); const pre=actor.getSnapshot().value; const observed=[]; const sub=actor.subscribe((s)=>observed.push(s.value)); actor.send({type:"NOOP"}); const post=actor.getSnapshot().value; sub.unsubscribe(); console.log(JSON.stringify({xstateVersion:(await Bun.file("node_modules/xstate/package.json").json()).version,lateSubscribe:{current:actor.getSnapshot().value,seen:late},registeredBeforeNoop:{pre,post,notifications:observed}}));'
bun -e 'import {createErrorRegistry} from "./packages/contracts/src/error-envelope.ts"; const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const outcomes=m.controlProjection.nonSuccess; const codes=outcomes.map((x)=>x.code); if(codes.length!==6||new Set(codes).size!==6) throw Error(`codes ${codes}`); const required=["commandId","command","actorState","version","incarnationId","reason"]; for(const o of outcomes) for(const k of required) if(!(k in o.detailsSchema)) throw Error(`${o.code} missing ${k}`); const sourceFiles=[]; for await (const path of new Bun.Glob("**/*.ts").scan("packages/contracts/src")) sourceFiles.push(path); const source=(await Promise.all(sourceFiles.map((p)=>Bun.file(`packages/contracts/src/${p}`).text()))).join("\n"); const literalRegistrations=codes.filter((code)=>source.includes(`\"${code}\"`)||source.includes(`\x27${code}\x27`)); const registry=createErrorRegistry([]); const lookup=codes.map((code)=>[code,registry.get(code)===undefined?"unregistered":"registered"]); console.log(JSON.stringify({declared:`${codes.length}/6 unique`,boundedBaseFields:"6/6",acceptedSourceRegistrations:`${literalRegistrations.length}/6`,lookup})); if(literalRegistrations.length!==0||lookup.some(([,s])=>s!=="unregistered")) process.exit(1);'
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const actions=m.actions.map((x)=>x.id); const actionKinds={accepted:actions.includes("emitControlAccepted"),completed:actions.includes("emitControlCompleted"),pending:actions.includes("emitControlPending"),rejected:actions.includes("emitControlRejected"),failed:actions.some((x)=>/Failed/.test(x)),cancelled:actions.some((x)=>/Cancelled/.test(x)),timeout:actions.some((x)=>/Timeout/.test(x)),conflict:actions.some((x)=>/Conflict/.test(x)),capacity:actions.some((x)=>/Capacity/.test(x))}; const json=JSON.stringify(m); const reasons=m.controlProjection.nonSuccess.flatMap((x)=>String(x.detailsSchema.reason).split("|")); const reasonCounts=Object.fromEntries(reasons.map((reason)=>[reason,json.split(reason).length-1])); const resolverKeys=Object.keys(m.controlProjection).filter((k)=>/map|resolv|settle|outcome/i.test(k)); console.log(JSON.stringify({actionKinds,reasonCounts,resolverKeys,controlProjectionKeys:Object.keys(m.controlProjection)})); if(actionKinds.failed||actionKinds.cancelled||resolverKeys.length) process.exit(1);'
jq -e '((.frozenInputs[] | select(.id=="P3-C07")) == {id:"P3-C07",issue:98,path:"packages/imap/src/raw-download-queue.ts",gitCommit:"e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae",sha256:"b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67"}) and ((.actors[] | select(.id=="rawDownloadQueue") | .acceptedArtifact) == {issue:98,planItem:"P3-C07",gitCommit:"e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae",path:"packages/imap/src/raw-download-queue.ts",sha256:"b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67"})' docs/architecture/sync-statechart.model.json
git show e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae:packages/imap/src/raw-download-queue.ts | shasum -a 256
```

E30 through E32:

```sh
bun test packages/contracts/test/sync-operations.test.ts packages/contracts/test/error-envelope.test.ts
python3 .agents/skills/plan-agent-mail/scripts/check_plan.py
jq empty docs/architecture/sync-statechart.model.json
for file in docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md; do test "$(tail -c 1 "$file" | wc -l | tr -d ' ')" = 1 || exit 1; done
! rg -n '[[:blank:]]+$' docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md
git diff --check -- docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.review.md
shasum -a 256 docs/architecture/sync-statechart.model.json docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md
```

### Round-2 signature

Reviewer signature for digest `7eba62c31fc894cd4c029ea529bfa1e7a443d921b5935b924e8b3f92db3fbf58`: **WITHHELD**.

Reason: unresolved high/consequential findings R189-06, R189-07, and R189-12. UC01 and UC02 remain accepted-upstream blockers, the control resolver remains incomplete, and cleanup promotion/settlement remains a consequential implementation choice. Candidate changes and upstream acceptance are required before another exact-digest review response.

## Round 1 retained baseline

## Review manifest

| Seam | Owner | Invariant reviewed | Durable, external, or public surface | Evidence status |
|---|---|---|---|---|
| Atomic lifecycle configuration | Concurrency/workflow | One active atomic state; every reachable node has an owned transition path | XState snapshot and inspection metadata | Exercised structurally: 22/22 nodes reachable; finding R189-01 invalidates one forbidden-configuration claim. |
| Child actor and timer ownership | Lifecycle/resource | Active children equal the state inventory; exit, cancellation, and terminal outcomes release exact resources | IDLE socket/listeners, timers, downloads, cleanup registry | Exercised from the complete actor/transition inventory; R189-01 and R189-10 remain open. |
| Cleanup, stop, restart, and shutdown ordering | Lifecycle plus concurrency | No terminal or restarted state before the required scope is empty; shutdown cannot recreate work | Process supervisor and shared cleanup job | Exercised with scope and reordered-supervisor counterexamples; R189-01 and R189-09 remain open. |
| Durable backfill/sweep facts | Persistence/recovery | The oracle names the accepted repositories and every durable write; restart consumes only those facts | SQLite checkpoint and initial-completion repositories | Exercised against the pinned P3-C10/C11 sources; R189-02 and R189-03 remain open. |
| Process reconstruction | Persistence/recovery plus public contract | Required status fields and observation identities remain interpretable across reconstruction | Status checkpoint, public version, idempotency results | Exercised; R189-04, R189-06, and R189-07 remain open. |
| Status and control projection | Public contract | Every success has an observed compatible snapshot; every status projection parses the strict accepted schema | P1-C08 status/control schemas and shared error envelope | Exercised with Zod and installed-XState probes; R189-05 through R189-07 remain open. |
| Authentication classification and repair timing | Protocol plus security/trust | Authentication never retries automatically, exposes only safe detail, and cannot lose the credential revision that should unblock it | Credential owner, IMAP fault classification, diagnostics | Classification/redaction structure is supported; R189-08 remains open for the lost revision race. |
| F01/F03/F17-F20/S05 traceability | Owning lanes above | Each accepted shield maps to real transitions, artifacts, and falsifiable postconditions | Coverage oracle and accepted evidence ledger | F03/F17/F20 are structurally represented. F01, F18, F19, and S05 fail findings below. |
| Generated coverage and checked Markdown view | Public/model contract | Counts, identifiers, references, paths, and human view agree with the normative JSON | Model and coverage ledger | Counts, reachability, references, and 78/78 transition rows pass. R189-05 and R189-11 contradict two stronger coverage claims. |

## Lane routing

Selected lanes:

- Public contract: the candidate freezes status, version, control, and error projections against strict P1-C08 schemas.
- Lifecycle/resource ownership: the candidate owns actors, timers, cancellation, cleanup, and terminal resource claims.
- Persistence/recovery: the candidate names durable checkpoints/completion facts and process-reconstruction rules.
- Concurrency/workflow/ordering: the ticket explicitly requires duplicate, reordered, retry, cancellation, stop, restart, and shutdown traces.
- External protocol/integration: IDLE normal completion, capability selection, authentication classification, and adapter-shaped actor results are acceptance inputs.
- Security/privacy/trust, narrow escalation only: F20 requires credential-safe fault and diagnostic projection. No general security conclusion is made.

Skipped lanes:

- Accessibility/interaction: there is no rendered UI or interaction surface in the candidate.
- Domain/value integrity: mailbox identity and message transformation are owned by the accepted backfill/sweep artifacts; this review checks only their statechart/durability projection.
- Performance/capacity: retry and timer bounds are reviewed as workflow liveness. No benchmark, bulk query, or throughput implementation exists here.
- Operations/configuration/deployment: process event ordering is reviewed, but launchd, Tailscale, ports, files, and deployed configuration are outside this design artifact.

## Finding ledger

### R189-01 — Critical, consequential, open: cleanup completion validates the actor-reported scope instead of the state-required scope

- Lane: lifecycle/resource ownership plus concurrency/workflow.
- Provenance: candidate normative oracle.
- Status: open; designer revision and affected rerun required.
- Exact evidence:
  - `sync-statechart.model.json:470-472` defines `cleanupReleasedScope` as `released` plus zero resources for `event.output.scope`.
  - `sync-statechart.model.json:795-804` declares `backfilling.pausing` with required input `cleanupBarrier.scope = workflow`.
  - `sync-statechart.model.json:2692-2713` lets T170 enter `paused` using only `cleanupReleasedScope`.
  - `sync-statechart.model.json:2981-2983` claims any cleanup completion implies zero resources in its selected scope, but does not bind the result to the current state's required/effectively promoted scope.
  - Probe E07 produced `{requiredScope:"workflow",eventScope:"watch",liveWorkflowResources:1,cleanupReleasedScope:true,target:"paused"}`.
- Concrete counterexample: pause during `backfilling.active`; enter `backfilling.pausing`; inject a current cleanup completion `{released:true, scope:"watch"}` while one backfill/download resource remains in `workflow`; the normative guard passes and T170 enters `paused`.
- Violated invariant/claim: issue #189 adjacent counterexample; I03, I07, U01, and the prose claim at `sync-statechart.md:58` that paused-with-live-child is structurally impossible.
- Required disposition: make the required/effective cleanup scope authoritative in the state or invoke identity. A completion must prove that its effective scope equals or dominates the state's required scope after promotion, and the ownership audit must inspect that authoritative scope rather than trusting the output payload. Add wrong-scope, stale-promotion, and replacement-invoke cases to PATH-ACTOR, PATH-ORDER, U01, and U02.

### R189-02 — High, consequential, open: T117/T118 deny a durable write performed by accepted P3-C10

- Lane: persistence/recovery.
- Provenance: candidate-to-accepted-upstream contradiction.
- Status: open; designer revision and affected restart/F01 rerun required.
- Exact evidence:
  - Accepted `b6d07bc:packages/daemon/src/initial-backfill-loop.ts:203-213` calls `dependencies.completions.save(identity, completion)` before returning `already-complete`.
  - The accepted repository implementation at lines 441-449 performs the upsert and rereads it.
  - `sync-statechart.model.json:1879-1925` gives T117 and T118 empty `durableWrites` and says they claim no new durable write.
  - `sync-statechart.decisions.md:20` and `sync-statechart.coverage.md:62-63,193` repeat the no-write claim.
  - Probe E08 printed the empty T117/T118 write sets beside the accepted `completions.save` call.
- Concrete counterexample: start from `backfillCompleted=true` with a newer observed UID ceiling/UIDNEXT/time. The accepted actor overwrites the durable initial-completion observation and eligibility time, while the normative transition says no durable fact changed.
- Violated invariant/claim: the issue #188 complete transition-table obligation, I08, F01 traceability, PATH-RESTART, and the exact-upstream boundary.
- Required disposition: record the actual `initialBackfillCompletion` write on T117/T118, distinguish its non-CAS `save` semantics from the completed transaction, and cover interruption/restart immediately before and after that write.

### R189-03 — High, consequential, open: the durable oracle invents a recurring-sweep repository/fact absent from accepted P3-C11

- Lane: persistence/recovery.
- Provenance: candidate-to-accepted-upstream contradiction.
- Status: open; designer revision required.
- Exact evidence:
  - `sync-statechart.model.json:159-178` declares separate `initialBackfillCompletion` and `recurringSweepCompletion` facts and assigns the latter to a `recurring-sweep completion repository`.
  - `sync-statechart.model.json:2440-2492` records T150/T156 writes to `recurringSweepCompletion.nextSweepEligibleAt`.
  - Accepted `d510747:packages/daemon/src/recurring-mailbox-sweep.ts:19-23,57-60` imports and uses `InitialBackfillCompletionRepository`; no recurring-sweep completion repository/type exists.
  - Accepted lines 280-307 update `mailboxCheckpoint.sweepCursor` and the same `InitialBackfillCompletion` row through `dependencies.completions.complete`.
  - Probe E09 found no `RecurringSweepCompletion` symbol in the pinned source and printed the actual repository/write call.
- Concrete counterexample: an implementer mechanically following the signed model must either add a protected new repository/migration, or diverge from the model to call the accepted `InitialBackfillCompletionRepository`. P3-C15-IMPLEMENT forbids both choices.
- Violated invariant/claim: exact frozen artifact boundary, D08, I08/I09, PATH-RESTART, and issue #190's no-consequential-implementation-choice gate.
- Required disposition: model the accepted composition exactly: `mailboxCheckpoint.sweepCursor` plus updates to the existing `initialBackfillCompletion` row. Do not introduce a second repository unless an upstream storage/migration contract is separately accepted and frozen.

### R189-04 — High, consequential, open: reconstructed `stopped.clean` has no defined checkpoint/status context

- Lane: public contract plus persistence/recovery.
- Provenance: candidate normative oracle omission.
- Status: open; designer decision required.
- Exact evidence:
  - P1-C08 requires `version`, a six-field `checkpoint`, and `diagnostics` on every status response at `13e0360:packages/contracts/src/sync-operations.ts:50-80,97-113`.
  - `sync-statechart.model.json:83-139` lists context types and writers but no initial values; `checkpoint` can be written only by `adoptCommittedCheckpoint`.
  - `sync-statechart.md:119-121` says a reconstructed actor begins at `stopped.clean` and does not read durable facts until explicit start.
  - T001 claims an initial public status, but does not define the required checkpoint or diagnostic values.
  - Probe E10, `jq -e 'all(.context[]; has("initial"))'`, exited 1 with `false`.
- Concrete counterexample: reconstruct the daemon, query status before start, and project `stopped.clean`. The model supplies no `SyncCheckpointSummary`; inventing zeros hides retained durable progress, while reading repositories contradicts the stated explicit-start rule.
- Violated invariant/claim: I12, T001's valid initial-status claim, D08, and the 22/22 strict-schema projection check.
- Required disposition: freeze every initial context value. For checkpoint, either read and validate the durable summary during construction/status projection without hydrating an actor snapshot, or revise the public contract to represent an unavailable/uninitialized summary. Add reconstruction-before-start fixtures for empty and populated repositories.

### R189-05 — High, consequential, open: D02's failure marker is both schema-invalid as modeled and non-discriminating when stripped

- Lane: public contract.
- Provenance: candidate normative oracle and consequential decision D02.
- Status: open; D02 rejected and replacement required.
- Exact evidence:
  - `sync-statechart.model.json` places `diagnosticRequirement` inside `states[stopped.failed].public`; P1-C08's status schemas are strict and accept only `actorState`, `activeOperation`, `authBlocked`, `version`, `checkpoint`, and `diagnostics`.
  - Probe E05 parsed each `states[].public` object through the accepted schema and exited 1: `unrecognized key: diagnosticRequirement`.
  - Probe E06 passed only after explicitly deleting that oracle field.
  - Accepted `SyncDiagnostic` has only unconstrained `code` and `message` (`13e0360:.../sync-operations.ts:68-74`); the candidate does not freeze a code that distinguishes terminal failure from warnings/history, and `stopped.clean` is not forbidden from retaining diagnostics.
  - `sync-statechart.md:56` and D02 claim public `stopped` plus diagnostics is sufficient, while `sync-statechart.coverage.md:238` claims all 22 projections parsed.
- Concrete counterexample: direct projection of `stopped.failed.public` fails the strict schema. If the model-only field is silently dropped, `stopped.clean` with cleanup diagnostics and `stopped.failed` with generic diagnostics have no frozen machine-readable discriminator.
- Violated invariant/claim: D02, I12, the strict public schema, and the candidate check record.
- Required disposition: move the requirement out of the public payload and freeze an accepted-schema-compatible discriminator. The reviewer's exact replacement is: `stopped.failed` must contain diagnostic code `sync.terminal-failure`; `stopped.clean` must exclude that code; transitions that let stop supersede pending failure must explicitly clear or preserve it according to the selected terminal disposition. Parse the literal public payload without undocumented field stripping.

### R189-06 — High, consequential, open: the control service is not mechanically specified and can miss the deciding snapshot

- Lane: public contract plus concurrency/workflow.
- Provenance: candidate design omission and installed-runtime counterexample.
- Status: open; designer revision required. D16's stable-success policy is accepted, but this finding blocks its implementation.
- Exact evidence:
  - `sync-statechart.md:147` says the service receives the decision and then resolves from a compatible snapshot; the control-waiter coverage row says it starts from an accepted decision.
  - In installed XState `5.32.5`, subscribing after a transition does not replay the current snapshot. Probe E11 transitioned `a -> b`, then subscribed, and returned `{"current":"b","seen":[]}`.
  - No-op success transitions T011, T012, T028, T031, T032, and T040 emit a decision without changing state/version; there may be no later snapshot to rescue a late waiter.
  - `sync-statechart.model.json:2889-2954` gives prose outcomes only. It does not freeze subscribe-before-send versus decision/snapshot handshaking, the deadline/clock/configuration, exact rejected/failed/cancelled/timeout union and public error codes/details, or idempotency retention/eviction/reconstruction.
  - The public schemas require idempotency keys for pause/resume/stop, but the model promises only an unbounded in-process result map at line 2891.
- Concrete counterexamples:
  1. Send idempotent stop in `stopped.clean`; T040 emits completed with no snapshot change; start the waiter after the decision; it times out despite the actor already being in the required state.
  2. Complete a keyed command, reconstruct the process, and replay the same public key; the in-process map is gone, so the implementation must choose between re-execution, rejection, or a new result.
  3. Send infinitely many unique completed keys; no retention bound permits unbounded memory.
- Violated invariant/claim: D15, D16 implementation closure, I13/I16, F19, PATH-CONTROL, bounded operation, and issue #190's mechanical implementation requirement.
- Required disposition: freeze a control-service protocol. Establish observation before `actor.send`, or define an atomic decision carrying an actor-produced observed snapshot plus a race-free subscription handshake. Define bounded deadline configuration and clock, exact typed non-success results/error mapping, and idempotency scope, retention, eviction, timeout replay, and process-reconstruction semantics. Add no-op transitions, transition-before-subscribe, crash/replay, and retention-cap cases.

### R189-07 — High, consequential, open: D21 resets a public ordering value without exposing its epoch

- Lane: public contract plus persistence/recovery.
- Provenance: consequential decision D21.
- Status: open; D21 rejected.
- Exact evidence:
  - `sync-statechart.model.json:85-96` makes `incarnationId` private and `version` ephemeral/monotonic only within that incarnation.
  - Accepted P1-C08 exposes `version` in every status and observed-control response but exposes no incarnation (`13e0360:.../sync-operations.ts:76-80,116-120`).
  - D21 explicitly resets version on reconstruction while I11 calls it strictly increasing on observable transitions.
- Concrete counterexample: a client observes public version 80, the daemon reconstructs, and the next response is version 0 with no public field that distinguishes a new epoch from an older/stale response.
- Violated invariant/claim: truthful observed-version semantics, F19 ordering, D21, and restart observation closure.
- Required disposition: revise P1-C08 to expose a public incarnation/generation in status and every observed-control shape, then order by `(incarnationId, version)`, or accept a durable globally monotonic version owner and migration. The reviewer prefers the explicit incarnation contract because it does not pretend ephemeral actor snapshots are durable.

### R189-08 — High, consequential, open: D23 loses a credential revision that races the failing attempt

- Lane: external protocol/integration plus concurrency/workflow.
- Provenance: consequential decision D23.
- Status: open; D23 rejected.
- Exact evidence:
  - `sync-statechart.model.json:2870-2877` ignores every `credentials.changed` event outside stable `authBlocked`.
  - `sync-statechart.md:127` requires the credential owner to emit again after observing `authBlocked`.
  - T125/T142 can move a now-obsolete authentication failure through cleanup into stable `authBlocked` after the only new revision was discarded.
  - Probe E13 produced trace `GEP04(ignore) -> T125 -> T142`, ending in `authBlocked` with no automatic exit until a second credential event.
- Concrete counterexample: an IDLE attempt uses credential revision 4; the credential owner installs revision 5 and emits `credentials.changed`; the active state ignores it; the old attempt then reports authentication failure; cleanup reaches `authBlocked` and stays there even though credentials already changed.
- Violated invariant/claim: F20's “blocks automatic retry until credentials change” postcondition, event-order safety, no lost wakeup, and the product's frictionless recovery goal.
- Required disposition: latch the latest credential revision without restarting healthy work. Each credential-using actor must carry the revision it attempted; an auth fault for an older revision must clean up and restart against the newer revision, while an auth fault for the latest revision enters `authBlocked`. Stable `authBlocked` keeps the T060 behavior. Add both event orders and duplicate revisions to PATH-ORDER.

### R189-09 — High, consequential, open: D24 lets a reordered restart overturn accepted process shutdown

- Lane: concurrency/workflow plus lifecycle/resource ownership.
- Provenance: candidate transition ordering and consequential decision D24.
- Status: open; D24 rejected/replaced.
- Exact evidence:
  - T053 moves active work to `stopping.forStop` on `process.shutdown.requested` (`sync-statechart.model.json:1599-1635`).
  - T051 unconditionally moves `stopping.forStop` to `stopping.forRestart` on `lifecycle.restart.requested` (`sync-statechart.model.json:1566-1584`).
  - T181 then starts `bootstrapSession` after cleanup.
  - Probe E12 executed T053 -> T051 -> T181 and ended in `starting.active` with `bootstrapSession` live.
  - PATH-ORDER names shutdown but not restart request identity/duplicate timing (`sync-statechart.model.json:3157-3165`); D24's cross-completion behavior has no retained generated obligation.
- Concrete counterexample: a restart request is queued or redelivered after shutdown enters cleanup. Mailbox order applies it second, changes the post-cleanup disposition to restart, and the daemon recreates workflow work instead of remaining stopped for process termination.
- Violated invariant/claim: awaited shutdown, F18, the concurrent-cleanup matrix, I15, PATH-ORDER, and D24.
- Required disposition: replace the joint edge-trigger rule with a distinct `stopping.forShutdown` state. Once shutdown is accepted, restart deliveries are ignored for that incarnation; cleanup can only reach stopped. Restart request IDs may remain correlation-only before shutdown, but duplicate-before/after-cleanup semantics must be generated and retained.

### R189-10 — Medium, non-consequential after exact pinning, open: D22 relies on an unfrozen and misidentified queue artifact

- Lane: lifecycle/resource ownership.
- Provenance: hidden upstream dependency.
- Status: open.
- Exact evidence:
  - D22 calls the accepted queue “P2-C01”; the closed queue contract is issue #98, P3-C07, implemented at commit `e3dd0462a3fc8b1d5770293fc2f270b5c0a76dae`.
  - The queue source digest is `b676dee263b51eaac88846d03a109e6a77ad428959cfbc54de491b076d4cdd67`.
  - `sync-statechart.model.json:frozenInputs` omits that artifact even though I17, U11, PATH-ACTOR, and the actor inventory depend on its exact stop/child semantics.
- Concrete counterexample: the queue implementation changes after candidate review while the four candidate files and signed digest remain unchanged; runtime conformance can still cite the signed digest although the descendant actor contract has drifted.
- Violated invariant/claim: exact accepted-artifact fingerprint and integration ratchet.
- Required disposition: correct the contract identifier and freeze the accepted queue commit/path/digest, or rewrite D22 as a complete independent input contract whose compatibility is mechanically checked against the queue artifact.

### R189-11 — Low, non-consequential, open: the checked coverage view disagrees on guard count

- Lane: public/model contract.
- Provenance: candidate checked view.
- Status: open.
- Exact evidence: `sync-statechart.coverage.md:13` and the JSON contain 20 guards, while line 145 says PATH-TRANSITION covers both outcomes of all 19 guards. The candidate check record returns to 20/20.
- Violated invariant/claim: checked-view/oracle consistency.
- Required disposition: change 19 to 20 and regenerate the view as part of the next candidate digest.

## Consequential decision dispositions

| Decision | Reviewer disposition | Evidence-backed resolution |
|---|---|---|
| D02 | **Reject and replace** | Public `stopped` is acceptable for a no-work terminal state only if failure is machine-discriminating. Move `diagnosticRequirement` out of the strict payload; require `sync.terminal-failure` in `stopped.failed` and forbid it in `stopped.clean`; define stop-over-failure diagnostic handling. R189-05. |
| D16 | **Accept** | Withholding pause/stop success until stable `paused`/`stopped` preserves F19 and cleanup truth without changing P1-C08. Acceptance is semantic only; R189-06 must still freeze the waiter timing, timeout, idempotency, and error protocol. |
| D17 | **Accept** | `authBlocked` owns no work, so explicit pause is a safe, more restrictive operator intent. Clearing the schema-bound auth detail before `paused` is consistent; resume may re-enter `authBlocked`. |
| D21 | **Reject and replace** | A resettable public version without a public epoch is not orderable across reconstruction. Add a public incarnation/generation to P1-C08 or accept a durable global version owner. Reviewer preference: public `(incarnationId, version)`. R189-07. |
| D23 | **Reject and replace** | Ignoring a credential revision during the failing attempt creates a lost wakeup. Latch revision, bind each credential-using attempt to its revision, and restart after cleanup only when a newer revision already exists. R189-08. |
| D24 | **Reject and replace** | Restart may remain edge-triggered before shutdown, but accepted shutdown must be terminal for the incarnation. Add `stopping.forShutdown`, ignore later restart, and generate request-order/duplicate cases. R189-09. |

D02, D21, D23, and D24 remain unresolved until a designer revision and orchestrator acceptance. D16 and D17 are resolved from the reviewer's side, subject to the surrounding open findings.

## Acceptance-claim audit

| Candidate claim | Result | Evidence |
|---|---|---|
| Candidate and frozen-input hashes match | Supported | E01/E02. |
| 22 reachable atomic nodes | Supported as graph reachability | E03/E04. This does not prove runtime behavior. |
| 78 definitions / 167 expanded transitions | Supported structurally | E03/E04. |
| 24 events, 20 guards, 14 actions, 10 actors, 17 invariants, 11 forbidden configurations, 9 properties | Supported as inventory counts | E03; checked-view typo remains R189-11. |
| 78/78 Markdown rows match JSON | Supported after the actor-list rendering convention was applied | E04. |
| Every status projection parses P1-C08 | Rejected as written | E05 fails on `diagnosticRequirement`; E06 passes only after undocumented stripping. R189-05. |
| Paused-with-live-child is structurally impossible | Rejected | E07 constructs it through a mismatched cleanup result scope. R189-01. |
| F01 trace is faithful to P3-C10/C11 | Rejected | E08/E09 and R189-02/R189-03. |
| F03 normal completion/failure leaves active IDLE | Supported by transition inventory | T123-T128 leave `watching.idling`; runtime adapter proof remains downstream. |
| F17 exact listener/timer removal | Specified, not runtime-proven | Actor contracts and PATH-ACTOR name it; downstream runtime conformance still required. |
| F18 one cleanup job and ordered stop/restart/shutdown | Rejected in part | Scope validation and shutdown priority fail R189-01/R189-09. Memoized single-job intent is otherwise explicit. |
| F19 every success observes compatible state/version | Rejected as a complete design | Installed XState timing, missing waiter protocol, version epoch, idempotency, and error outcomes fail R189-06/R189-07. |
| F20 auth maps to authBlocked without retry or secrets | Supported for the classified-fault path; repair race rejected | T102/T112/T125/T142/T152 and safe fault fields cover classification; R189-08 covers lost revision timing. |
| Restart consumes accepted durable facts | Rejected as an exact oracle | R189-02/R189-03/R189-04/R189-07. |
| Deadlock/livelock and all illegal/duplicate/reordered paths are covered | Not established | The corpus is an obligation, not retained execution, and omits the demonstrated cleanup-scope, control-subscription, credential-order, and restart-after-shutdown cases. |

## Checks and adversarial probes

All commands ran from `/Users/john/.codex/worktrees/efa7/agent-mail`. No live iCloud, remote mutation, launchd, Tailscale, commit, push, issue edit, or other GitHub mutation was performed.

| Evidence | Command or probe | Exit | Result |
|---|---|---:|---|
| E01 | `shasum -a 256 PLAN.md docs/planning/EVIDENCE.md docs/architecture/sync-statechart.model.json` plus `git show <frozen-commit>:<frozen-path> \| shasum -a 256` for P1-C08, P3-C10, P3-C11 | 0 | All five hashes exactly match the oracle; model digest is the candidate digest. |
| E02 | `jq empty docs/architecture/sync-statechart.model.json && git diff --exit-code 8522d12 -- docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json && git show 8522d12:docs/architecture/sync-statechart.model.json \| shasum -a 256` | 0 | Valid JSON; all four files match commit; commit model digest matches. |
| E03 | `jq -e '{states:([.states[]\|select(.kind=="atomic")]\|length),transitions:(.transitions\|length),expanded:([.transitions[]\|if (.source\|type)=="array" then .source[] else .source end]\|length),events:(.events\|length),guards:(.guards\|length),actions:(.actions\|length),actors:(.actors\|length),invariants:(.invariants\|length),forbidden:(.unreachableStateAccount.forbiddenConfigurations\|length),properties:(.coverage.properties\|length),paths:(.coverage.generatedStatePaths\|length)} == {states:22,transitions:78,expanded:167,events:24,guards:20,actions:14,actors:10,invariants:17,forbidden:11,properties:9,paths:22}' docs/architecture/sync-statechart.model.json` | 0 | `true`. |
| E04 | Independent Bun reference/BFS verifier over all state, event, guard, action, actor, source, target, and transition IDs | 0 | `atomicStates 22/22`, `78`, `167`, `events 24/24`, references resolved. Exact-row verifier returned `markdown transition rows 78/78 exact`. |
| E05 | Bun projection of each literal `states[].public` object through `syncStatusResponseSchema` | 1 | Zod rejected `stopped.failed.public`: unrecognized key `diagnosticRequirement`. |
| E06 | Same projection probe after explicitly omitting `diagnosticRequirement`, plus every declared success control projection | 0 | `22/22` status projections and declared success controls parse only after the omission. |
| E07 | `bun -e` evaluation of the normative `cleanupReleasedScope` predicate with required `workflow`, event scope `watch`, zero watch resources, and one live workflow resource | 0 | Guard `true`; target `paused`. Adjacent counterexample reproduced. |
| E08 | `jq` T117/T118 durable-write extraction beside `git show b6d07bc:...initial-backfill-loop.ts \| sed -n '203,213p'` | 0 | Oracle says no write; accepted source calls `completions.save`. |
| E09 | `git grep` accepted P3-C11 completion types/call plus `jq` durable facts/T150/T156 | 0 | Accepted source uses `InitialBackfillCompletionRepository`; oracle names absent recurring repository/fact. |
| E10 | `jq -e 'all(.context[]; has("initial"))' docs/architecture/sync-statechart.model.json` | 1 | `false`; no context initializers are frozen. |
| E11 | `bun -e 'import {createActor,createMachine} from "xstate"; const a=createActor(createMachine({initial:"a",states:{a:{on:{GO:"b"}},b:{}}})).start(); a.send({type:"GO"}); const seen=[]; const sub=a.subscribe(s=>seen.push(s.value)); await Promise.resolve(); console.log(JSON.stringify({current:a.getSnapshot().value,seen})); sub.unsubscribe();'` | 0 | XState 5.32.5 returned `{"current":"b","seen":[]}`. |
| E12 | Bun trace lookup for `process.shutdown.requested`, `lifecycle.restart.requested`, cleanup done | 0 | T053 -> T051 -> T181 ends `starting.active` with `bootstrapSession`. |
| E13 | Bun trace lookup for `credentials.changed`, authentication failure, cleanup done | 0 | GEP04 ignore -> T125 -> T142 ends `authBlocked`; the earlier revision is lost. |
| E14 | `bun test packages/contracts/test/sync-operations.test.ts` | 0 | 6 passed, 0 failed, 31 expectations. |
| E15 | `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py` | 0 | Planning pack PASS. |
| E16 | final-newline loop plus `! rg -n '[[:blank:]]+$'` over the four candidate files | 0 | All four pass final-newline/trailing-whitespace checks. |

One exploratory exact-row verifier attempt exited 1 because the reviewer initially rendered multi-actor cells with `<br>` while the checked view uses comma separation. The corrected verifier used the candidate's rendering convention and passed 78/78. This harness correction is not a candidate finding.

The full repository `ready` gate was intentionally not run. The review is design-only, and unrelated concurrent production drafts plus generated outputs are present in the shared worktree; a whole-repository result would not be attributable to candidate `8522d12`.

### Exact command appendix

E01:

```sh
shasum -a 256 PLAN.md docs/planning/EVIDENCE.md docs/architecture/sync-statechart.model.json
git show 13e036049099241d68b724639c467d9ae8e4424a:packages/contracts/src/sync-operations.ts | shasum -a 256
git show b6d07bc56e775cc7aea4b9436b81532bba7c4e9a:packages/daemon/src/initial-backfill-loop.ts | shasum -a 256
git show d5107472ffae6f5eb4deb8b87365ffda40fe30d3:packages/daemon/src/recurring-mailbox-sweep.ts | shasum -a 256
```

E02:

```sh
jq empty docs/architecture/sync-statechart.model.json
git diff --exit-code 8522d12 -- docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json
git show 8522d12:docs/architecture/sync-statechart.model.json | shasum -a 256
```

E03:

```sh
jq -e '{states:([.states[]|select(.kind=="atomic")]|length),transitions:(.transitions|length),expanded:([.transitions[]|if (.source|type)=="array" then .source[] else .source end]|length),events:(.events|length),guards:(.guards|length),actions:(.actions|length),actors:(.actors|length),invariants:(.invariants|length),forbidden:(.unreachableStateAccount.forbiddenConfigurations|length),properties:(.coverage.properties|length),paths:(.coverage.generatedStatePaths|length)} == {states:22,transitions:78,expanded:167,events:24,guards:20,actions:14,actors:10,invariants:17,forbidden:11,properties:9,paths:22}' docs/architecture/sync-statechart.model.json
```

E04 reference/reachability and checked-row probes:

```sh
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const atomic=new Set(m.states.filter(s=>s.kind==="atomic").map(s=>s.id)); const events=new Set(m.events.map(x=>x.id)); const guards=new Set(m.guards.map(x=>x.id)); const actions=new Set(m.actions.map(x=>x.id)); const actors=new Set(m.actors.map(x=>x.id)); const ids=(xs)=>xs.map(x=>x.id); const unique=(xs)=>new Set(xs).size===xs.length; if(!unique(ids(m.events))||!unique(ids(m.guards))||!unique(ids(m.actions))||!unique(ids(m.actors))||!unique(ids(m.transitions))) throw Error("duplicate id"); for(const t of m.transitions){for(const s of (Array.isArray(t.source)?t.source:[t.source])) if(s!=="@uninitialized"&&!atomic.has(s)) throw Error(`bad source ${t.id}:${s}`); if(t.target!==null&&!atomic.has(t.target)) throw Error(`bad target ${t.id}`); if(!events.has(t.event)) throw Error(`bad event ${t.id}`); for(const g of t.guards) if(!guards.has(g)) throw Error(`bad guard ${t.id}:${g}`); for(const a of t.actions) if(!actions.has(a)) throw Error(`bad action ${t.id}:${a}`); for(const a of [...t.stoppedActors,...t.startedActors]) if(a!=="@source"&&a!=="@target"&&!actors.has(a)) throw Error(`bad actor ${t.id}:${a}`)} const reached=new Set([m.machine.initial]); let changed=true; while(changed){changed=false; for(const t of m.transitions){const ss=Array.isArray(t.source)?t.source:[t.source]; if(t.target&&ss.some(s=>s==="@uninitialized"||reached.has(s))&&!reached.has(t.target)){reached.add(t.target);changed=true}}} if([...atomic].some(s=>!reached.has(s))) throw Error(`unreached:${[...atomic].filter(s=>!reached.has(s))}`); const usedEvents=new Set(m.transitions.map(t=>t.event)); for(const p of m.globalEventPolicy) for(const e of p.events) if(e!=="any unknown event") usedEvents.add(e); const missing=[...events].filter(e=>!usedEvents.has(e)); if(missing.length) throw Error(`unused events:${missing}`); console.log(JSON.stringify({atomicStates:`${reached.size}/${atomic.size}`,transitionDefinitions:m.transitions.length,expandedTransitions:m.transitions.reduce((n,t)=>n+(Array.isArray(t.source)?t.source.length:1),0),events:`${usedEvents.size}/${events.size}`,references:"resolved"}))'
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const md=await Bun.file("docs/architecture/sync-statechart.coverage.md").text(); const rows=md.split("\n").filter(l=>/^\| T\d{3} \|/.test(l)); const list=x=>Array.isArray(x)?(x.length?x.join("<br>"):"—"):(x??"—"); const actor=x=>Array.isArray(x)?(x.length?x.join(", "):"—"):(x??"—"); const expected=m.transitions.map(t=>`| ${t.id} | ${list(t.source)} | ${t.event} | ${list(t.guards)} | ${list(t.target)} | ${list(t.actions)} | ${actor(t.stoppedActors)} → ${actor(t.startedActors)} | ${list(t.durableWrites)} | ${t.observation} |`); const bad=expected.map((x,i)=>x===rows[i]?null:{id:m.transitions[i].id,expected:x,actual:rows[i]}).filter(Boolean); if(bad.length) throw Error(JSON.stringify(bad.slice(0,3))); console.log(`markdown transition rows ${rows.length}/${expected.length} exact`)'
```

E05 and E06:

```sh
bun -e 'import {syncStatusResponseSchema} from "./packages/contracts/src/sync-operations.ts"; const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const cp={completedMailboxes:0,totalMailboxes:0,completedMessages:0,pendingMessages:0,lastMailbox:null,lastUid:null}; for(const s of m.states.filter(s=>s.kind==="atomic")){syncStatusResponseSchema.parse({...s.public,authBlocked:s.id==="authBlocked"?{reason:"credentials-invalid",detail:"provider rejected credentials"}:null,version:0,checkpoint:cp,diagnostics:s.id==="stopped.failed"?[{code:"fatal",message:"workflow failed"}]:[]});}'
bun -e 'import {syncStatusResponseSchema,syncStartResponseSchema,syncPauseResponseSchema,syncResumeResponseSchema,syncStopResponseSchema} from "./packages/contracts/src/sync-operations.ts"; const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); const cp={completedMailboxes:0,totalMailboxes:0,completedMessages:0,pendingMessages:0,lastMailbox:null,lastUid:null}; for(const s of m.states.filter(s=>s.kind==="atomic")){const {diagnosticRequirement,...pub}=s.public; syncStatusResponseSchema.parse({...pub,authBlocked:s.id==="authBlocked"?{reason:"credentials-invalid",detail:"provider rejected credentials"}:null,version:0,checkpoint:cp,diagnostics:s.id==="stopped.failed"?[{code:"fatal",message:"workflow failed"}]:[]});} const id="c"; const v=1; for(const state of m.controlProjection.start.accepted) syncStartResponseSchema.parse({accepted:true,commandId:id,observed:{actorState:state,version:v}}); for(const state of m.controlProjection.start.completed) syncStartResponseSchema.parse({accepted:true,completed:true,commandId:id,observed:{actorState:state,version:v}}); for(const state of m.controlProjection.pause.completed) syncPauseResponseSchema.parse({accepted:true,completed:true,commandId:id,observed:{actorState:state,version:v}}); for(const state of m.controlProjection.resume.accepted) syncResumeResponseSchema.parse({accepted:true,commandId:id,observed:{actorState:state,version:v}}); for(const state of m.controlProjection.resume.completed) syncResumeResponseSchema.parse({accepted:true,completed:true,commandId:id,observed:{actorState:state,version:v}}); for(const state of m.controlProjection.stop.completed) syncStopResponseSchema.parse({accepted:true,completed:true,commandId:id,observed:{actorState:state,version:v}}); console.log("22/22 status projections parse only after omitting stopped.failed diagnosticRequirement; declared success controls parse")'
```

E07, E10, and E11:

```sh
bun -e 'const requiredScope="workflow"; const event={output:{scope:"watch",released:true}}; const resources={watch:0,workflow:1}; const cleanupReleasedScope=event.output.released&&resources[event.output.scope]===0; console.log(JSON.stringify({source:"backfilling.pausing",requiredScope,eventScope:event.output.scope,liveWorkflowResources:resources.workflow,cleanupReleasedScope,target:cleanupReleasedScope?"paused":"blocked"})); if(!cleanupReleasedScope) process.exit(1)'
jq -e 'all(.context[]; has("initial"))' docs/architecture/sync-statechart.model.json
bun -e 'import {createActor,createMachine} from "xstate"; const a=createActor(createMachine({initial:"a",states:{a:{on:{GO:"b"}},b:{}}})).start(); a.send({type:"GO"}); const seen=[]; const sub=a.subscribe(s=>seen.push(s.value)); await Promise.resolve(); console.log(JSON.stringify({current:a.getSnapshot().value,seen})); sub.unsubscribe();'
```

E08 and E09:

```sh
jq -r '.transitions[] | select(.id=="T117" or .id=="T118") | [.id,(.durableWrites|join(",")),.observation] | @tsv' docs/architecture/sync-statechart.model.json
git show b6d07bc:packages/daemon/src/initial-backfill-loop.ts | sed -n '203,213p'
git grep -n 'RecurringSweepCompletion\|recurringSweepCompletion' d510747 -- packages/daemon/src/recurring-mailbox-sweep.ts || true
git grep -n 'InitialBackfillCompletionRepository\|dependencies.completions.complete' d510747 -- packages/daemon/src/recurring-mailbox-sweep.ts
jq -r '.durableFacts[],(.transitions[]|select(.id=="T150" or .id=="T156")|{id, durableWrites})' docs/architecture/sync-statechart.model.json
```

E12 and E13:

```sh
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); let state="starting.active"; const apply=(event)=>{const t=m.transitions.find(t=>(Array.isArray(t.source)?t.source:[t.source]).includes(state)&&t.event===event); if(!t) throw Error(`${state} has no ${event}`); state=t.target??state; return t.id}; const trace=[apply("process.shutdown.requested"),apply("lifecycle.restart.requested"),apply("xstate.done.actor.cleanupBarrier")]; console.log(JSON.stringify({trace,state,invoked:m.states.find(s=>s.id===state).invokedActors}))'
bun -e 'const m=await Bun.file("docs/architecture/sync-statechart.model.json").json(); let state="watching.idling"; const lookup=(event)=>m.transitions.find(t=>(Array.isArray(t.source)?t.source:[t.source]).includes(state)&&t.event===event); const trace=[]; let t=lookup("credentials.changed"); trace.push(t?.id??"GEP04(ignore)"); t=lookup("idle.failed"); if(!t||t.id!=="T125") throw Error("auth path missing"); trace.push(t.id); state=t.target; t=lookup("xstate.done.actor.cleanupBarrier"); trace.push(t.id); state=t.target; console.log(JSON.stringify({trace,state,children:m.states.find(s=>s.id===state).invokedActors,automaticExit:lookup("credentials.changed")?.id??null}))'
```

E14 through E16:

```sh
bun test packages/contracts/test/sync-operations.test.ts
python3 .agents/skills/plan-agent-mail/scripts/check_plan.py
for file in docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json; do test "$(tail -c 1 "$file" | wc -l | tr -d ' ')" = 1 || exit 1; done
! rg -n '[[:blank:]]+$' docs/architecture/sync-statechart.md docs/architecture/sync-statechart.decisions.md docs/architecture/sync-statechart.coverage.md docs/architecture/sync-statechart.model.json
```

## Signature

Reviewer signature for digest `6a4643bb1ec47ec823657c16581cc757ffa30f49ac49abf9cc866f9d9c07abad`: **WITHHELD**.

Reason: unresolved critical/high and consequential findings R189-01 through R189-09; consequential decisions D02, D21, D23, and D24 are rejected pending designer revision and orchestrator acceptance. Any candidate revision must publish a new digest, preserve this ledger, disposition every finding with evidence, and rerun the affected probes plus the full completeness audit before signature.
