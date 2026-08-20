# Report creation decisions v1

> Checked projection of `report-creation-oracle.v1.json` at SHA-256 `e4ad62866e691b4bcff011cf6384ed78439351ce491c8061772dd9bcb17916b0`.
> Status: **frozen-design; signed; normative; implementation authority within the checked #232 boundary**.
> The JSON oracle is the projection source and this file must match the checker exactly.

The signed oracle records the following frozen choices. Policy A and canonical migration slot 28 are resolved authority, not implementation options.

| Authority              | Status                | Choice or slot |
| ---------------------- | --------------------- | -------------- |
| AUTH-CAPACITY-POLICY-A | selected-and-frozen   | A              |
| AUTH-MIGRATION-SLOT-28 | accepted-and-consumed | 28             |

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

Choice: Consume accepted #233 at 2fd5b0eaf993b9f44068bd0f61552fc84479129a / oracle 08d817c11ba3d1a8f213f9254fdb792f43e9384b1a70471788c59497cb432345 and #234 at 4f79eb54ff1442dcd12d3cf8771861c4ae6e15ce by appending report-creation-v1 at packages/storage/src/migrations/0028-report-creation.ts as canonical slot 28 after exact prefix-27 identity 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab, then retaining exact-current-tip safe-recorder compatibility without weakening strict applyMigrations.

Reason: The accepted registry explicitly reserves report slot 28 and proves the real legacy converter commits only target 1..27 before the protected common opener routes slot 28 through its inside-BEGIN verify-before-suffix hook. Only the fully verified current-tip handle is then fingerprint-recorded for legacy fixture compatibility; runMigrations revalidates that fingerprint and applyMigrations remains strict. Slot 28 evolves the live full-registry digest without rewriting converted target-27 rows; reopen, doctor, backup, empty restore, and full restore share that authority at the accepted head.

Rejected: renumbering any predecessor, substituting the live full digest for historical target 27, changing protected converter/opener/runner bytes, looping conversion over the live registry, skipping the common suffix runner after legacy conversion, applying suffix effects before prefix verification, recording target 27 before current-tip verification, trusting cached compatibility state without a complete fingerprint recheck, weakening strict applyMigrations, a second registry, direct applyMigrations use, caller-selected ceilings, conversion bypass, and any migration path or slot other than the frozen one.

## D15

Choice: Pin #232 change authority to base 4f79eb54ff1442dcd12d3cf8771861c4ae6e15ce and fail frozen-input drift, protected paths, and unknown paths; retain the accepted remote-placement normalizedText repair and default-5000-millisecond P2-C13 stabilization, then add exactly packages/storage/test/search-corpus-p4-c16.test.ts for a registry-derived current-canonical-schema index oracle at slot 28. database.ts and migration-runner.ts remain protected accepted dependencies while index.ts remains an allowed report export surface.

Reason: The production promotion boundary and P2-C13 proof repairs remain correct. The search corpus now opens the complete canonical slot-28 schema, so its pre-slot-28 literal four-index map is stale even though the artifact is structurally valid. An independent canonical-registry schema projection with an exact ordered index-tuple digest and count closes that proof gap without changing production behavior, timeout policy, the safe-recorder/opener authority, public contracts, #165, or unrelated code.

Rejected: updating the literal map to another hand-maintained map, accepting any count-only schema, deriving expected indexes from the corpus database under test, ignoring extra or omitted indexes, making normalizedText optional, raising the test timeout, editing protected database/WAL/runner/migration behavior, warn-only drift, broad package ownership, protected-file exceptions, and unreviewed extra paths.
