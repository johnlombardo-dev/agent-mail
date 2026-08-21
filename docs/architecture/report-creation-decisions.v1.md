# Report creation decisions v1

> Checked projection of `report-creation-oracle.v1.json` at SHA-256 `e3e5f79f0e3f12acb8a6187e0a00d93222a22ee2c972f1eb8f93acb394fa9a63`.
> Status: **signed normative issue #248 authority rebind; prior report invariants preserved; no #232 scope widening**.
> The JSON oracle is the projection source and this file must match the checker exactly.
> Canonical checker invocation: `node docs/architecture/report-creation-check.v1.mjs --rebind-path=docs/architecture/report-creation-oracle.v1.json --rebind-path=docs/architecture/report-creation-check.v1.mjs --rebind-path=docs/architecture/report-creation-design.v1.md --rebind-path=docs/architecture/report-creation-decisions.v1.md --rebind-path=docs/architecture/report-creation-coverage.v1.md --changed-path=<path> [repeat for the complete #232 diff] --self-test`.

The final issue #248 authority preserves the signed report choices and Policy A, keeps report migration slot 28 exact, and rebinds only current migration authority to signed normative issue #247 at commit 47b4866935bce94fb4a87864731870e13498910a. Accepted unrelated slot 29 is not report authority.

| Authority              | Status                                          | Choice or slot |
| ---------------------- | ----------------------------------------------- | -------------- |
| AUTH-CAPACITY-POLICY-A | selected-and-frozen                             | A              |
| AUTH-MIGRATION-SLOT-28 | accepted-report-slot-rebound-to-signed-live-tip | 28             |

## Checker self-test authority

Freeze 152 oracle mutations, 9 issue-232 boundary mutations, and 5 issue-248 rebind-boundary mutations: 166 mutation cases plus 3 inventory counterexamples, for exactly 169 executed self-test cases.

The checker must retain exactly 152 oracle mutations, 9 issue-232 boundary mutations, and 5 issue-248 rebind-boundary mutations for an exact 166-case mutation inventory. Every combined mutation ID must be a nonempty unique string across all three arrays. The self-test must additionally execute three frozen inventory-corruption counterexamples: delete one oracle mutation, duplicate one oracle-mutation ID, and collide one issue-232 boundary ID with an oracle-mutation ID. Each counterexample must be rejected, and runSelfTest must return the exact frozen total of 169 executed cases. Renaming, omission, duplication, cross-array collision, or uncounted probes fail closed.

## D01

Choice: Hash one canonical account-, principal-, order-, and metadata-bound material into report and creation request IDs.

Reason: Exact replay and concurrency become constructive without a new idempotency field or random identity.

Rejected: random IDs, database row IDs, source sorting, caller idempotency keys, and collision suffixes.

## D02

Choice: Resolve first-create sources only in the sole configured account and collapse all ineligible reasons to not_found.

Reason: The Phase 1 one-account boundary is server-authoritative and does not become an enumeration oracle.

Rejected: request-selected account, cross-account fallback, tombstoned-only acceptance, and reason-specific errors.

## D03

Choice: Persist the production MIME parser's bounded normalized text during canonical promotion, safely materialize missing legacy projections from verified raw EML through that same parser, then snapshot exact canonical string bytes as the permanent citation source.

Reason: New and existing archive mail reach one production-faithful text seam, while citations survive tombstones, reopen, backup, and parser drift without direct report HTML/raw access.

Rejected: direct-SQL-only fixtures, search-index text as authority, report-only parsers, placement lookups on serve, stored mail HTML, and network fallback.

## D04

Choice: Build a deterministic source-evidence index with bounded excerpts and one citation per claim.

Reason: The frozen request contains sources, title, and metadata but no trusted generation instruction or external model contract.

Rejected: hidden prompt semantics, metadata templates, uncited synthesis, external inference, and title-only reports.

## D05

Choice: Persist canonical model and output digests, but rerender instead of storing Markdown or HTML.

Reason: The accepted safe renderer stays the only HTML authority and stored arbitrary markup is structurally impossible.

Rejected: stored HTML, stored Markdown, arbitrary paths, and caller renderer options.

## D06

Choice: Publish all four report record classes under one BEGIN IMMEDIATE transaction with strict read-back and BEFORE UPDATE/DELETE/duplicate-INSERT guards.

Reason: It makes concurrency, rollback, restart, orphan prevention, and REPLACE-safe immutability observable at the same boundary.

Rejected: split report transactions, post-commit render, eventual artifact repair, unguarded REPLACE, and filesystem report staging.

## D07

Choice: Record bearer creation provenance from trusted context, a server-derived request ID, body digest, and one server time.

Reason: Current HTTP and CLI both use bearer admission, while correlation and forwarded headers are caller-controlled.

Rejected: x-correlation-id as request provenance, User-Agent method inference, and metadata identity.

## D08

Choice: Keep public schemas unchanged, preserve global ownership of error code/status/details, and freeze exact report-service messages locally.

Reason: No contradiction requires a new public field or report-specific error, while the current global general-error definitions intentionally do not freeze their messages.

Rejected: new idempotency key, account field, replay flag, quota error, or citation route.

## D09

Choice: Freeze user-selected Policy A: 10000 immutable committed reports and 2147483648 logical charged bytes account-wide, 10 authenticated non-replay attempts per principal in every rolling 60000 milliseconds, exact replay before all capacity checks, indefinite retention without eviction/deletion, existing request_too_large/413, and no public or configuration schema widening.

Reason: The fixed dual account budget plus durable principal window closes the denial-of-service growth gap while preserving exact replay, citations, frozen public contracts, and the absence of any delete workflow.

Rejected: configurable limits, new 409/429 outcomes, rolling report retention, reset-on-restart rate state, mutable counters as quota truth, unbounded growth, and SQLITE_FULL as admission.

## D10

Choice: Implement one focused reports create adapter under #213/#214 and prove it through real HTTP and SQLite.

Reason: Command semantics remain central and #165 can promote only demonstrated production/composed cells.

Rejected: direct process writes, mock-only CLI proof, private exit maps, and general dispatcher work.

## D11

Choice: Require reports:write for every invocation; after an exact-replay miss, commit and retain exactly one admitted rate-ledger attempt before checking mail:read.message, while keeping that source scope before every current-source read or materialization.

Reason: The registered create operation owns report write authority; the accepted message-read scope is needed exactly when current mail content is read, but Policy A charges authenticated admitted misses before that guard. An exact replay returns immutable metadata without source text or rate charge, while missing source scope retains only the one rate-ledger attempt.

Rejected: source reads under reports:write alone, replay source revalidation, and requiring mail:read.message for metadata-only exact replay.

## D12

Choice: Serialize accepted identity-sensitive ECMAScript strings as canonical JSON-string BLOB bytes.

Reason: This preserves astral, normalization-distinct, bidi, isolated-surrogate, and maximum-length accepted strings across SQLite and hashing without narrowing the frozen schemas.

Rejected: raw SQLite TEXT, NFC normalization, scalar-only domains, surrogate rejection, and lossy UTF-8 replacement.

## D13

Choice: Enforce a non-raiseable reports.create 1 MiB body cap in the shared authenticated HTTP admission boundary.

Reason: The global configuration can be raised for other operations; a per-operation minimum preserves this report authority for declared and chunked bodies before the handler.

Rejected: handler-local length checks, default-only limits, post-JSON admission, and trusting Content-Length alone.

## D14

Choice: Retain accepted report-creation-v1 at exact canonical slot 28 and immutable target-27 digest 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab while rebinding current migration authority to the exact signed normative issue #247 artifacts at commit 47b4866935bce94fb4a87864731870e13498910a, live tip 29, registry identity 70360bc55dd45b4cc7a851b8f39eed2c77a598dd05f57aa757e3f63a88e27e57, and accepted unrelated issue #246 semantic slot 29 at commit 8b356bb15a9de481460a0d46b54b395a08dad82a.

Reason: Final issue #247 preserves every accepted row through report slot 28, keeps legacy conversion at immutable target 27, gates accepted unrelated slot 29 through the same production suffix path, and proves recorder compatibility at tips 27 through 31 while production authority returns only at 29. Rebinding the report oracle removes stale live-tip-28 claims without changing Policy A, report behavior, or issue #232 scope.

Rejected: renumbering any predecessor, substituting the live full digest for historical target 27, changing protected converter/opener/runner bytes, looping conversion over the live registry, skipping the common suffix runner after legacy conversion, applying suffix effects before prefix verification, recording target 27 before current-tip verification, trusting cached compatibility state without a complete fingerprint recheck, weakening strict applyMigrations, a second registry, direct applyMigrations use, caller-selected ceilings, conversion bypass, and any migration path or slot other than the frozen one.

## D15

Choice: Keep the exact accepted #232 mutation boundary and focused report proofs unchanged while rebinding their current-canonical-schema observations from former live tip 28 to exact live tip 29. The search index oracle still proves all 33 index tuples including the three report-slot-28 indexes; backup/restore parity still proves the same normalized-text bytes and report data.

Reason: Accepted unrelated slot 29 repairs one approval trigger and adds no report index or report schema. The registry-derived focused proofs must nevertheless observe current user_version and history tip 29. This is an authority observation update, not production/test scope widening or a report semantic change.

Rejected: updating the literal index map to another hand-maintained map, accepting any count-only schema, deriving expected indexes from the corpus database under test, ignoring extra or omitted indexes, deriving backup fixture normalized text through a fallback, making normalizedText optional, accepting missing report-source projections, weakening projection byte parity, raising the test timeout, editing protected database/WAL/runner/migration/report behavior, warn-only drift, broad package ownership, protected-file exceptions, and unreviewed extra paths.
