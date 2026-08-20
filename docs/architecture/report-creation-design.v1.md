# Report creation design v1

> Checked projection of `report-creation-oracle.v1.json` at SHA-256 `90c3a74a0fbfb30da038998a4c2856808e2e79cd0e95c96e1b01669e016c5273`.
> Status: **frozen-design; signed; normative; implementation authority within the checked #232 boundary**.
> The JSON oracle is the projection source and this file must match the checker exactly.

## Boundary

This JSON file is the single signed and normative authority for report creation, normalized-text materialization, persistence, source serving, and CLI behavior. It freezes user-selected capacity Policy A and consumes the accepted #233 canonical migration registry and safe legacy-fixture recorder authority plus the #234 implementation at the accepted head. The design, decisions, and coverage Markdown files are exact checked projections of this authority.

Implementation rule: Issue 232 may implement only this signed authority from the exact accepted head and within its checked mutation boundary. Any capacity-policy, migration-slot, public-schema, protected-path, or frozen-input drift requires a new explicit authority revision before implementation continues.

## Resolved authorities

| Authority              | Status                | Frozen rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-CAPACITY-POLICY-A | selected-and-frozen   | Freeze exactly 10000 committed reports and 2147483648 logical charged bytes account-wide, plus 10 authenticated non-replay attempts per principal in every rolling 60000 milliseconds. Exact committed replay precedes and bypasses all capacity admission. Committed report graphs are immutable and retained indefinitely without deletion, eviction, TTL, LRU, or cleanup. Capacity denial reuses request_too_large/413 with strict empty details and no public or configuration schema widening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AUTH-MIGRATION-SLOT-28 | accepted-and-consumed | Append report-creation-v1 at the accepted registry's exact reserved report slot 28 after the immutable 1..27 predecessor. Preserve the explicit historical conversion target as version 27 with digest 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab; the real converter must execute and ledger only the frozen 1..27 target slice and return at user_version 27. The common production opener must then route slot 28 through strict applyMigrations and the inside-BEGIN beforePendingMigration verifier before any slot-28 SQL, history, user_version, or commit effect. Only after suffix completion, canonical-state and integrity verification may the opener call the synchronous safe recorder, which independently verifies the registry-derived exact current-tip authority before caching its complete fingerprint for runMigrations fixture compatibility. The live full-registry digest evolves at slot 28 and never replaces or rewrites the target-27 row. Do not renumber, replace, or semantically alter a predecessor, bypass the common suffix runner, weaken applyMigrations, record a prefix before suffix completion, or advance schema authority outside the sole canonical registry. |

| Field                        | Frozen value      |
| ---------------------------- | ----------------- |
| Operation                    | reports.create    |
| HTTP                         | POST /v1/reports  |
| CLI                          | reports create    |
| Scope                        | reports:write     |
| First-create source scope    | mail:read.message |
| reports.create body hard cap | 1048576           |
| Schemas                      | unchanged         |

The accepted strict schemas can express the complete operation. The operation retains reports:write in the registry; the service derives the additional mail:read.message requirement only for first-create source materialization, and all limits use existing global errors.

## Canonical identity and replay

UTF-8 bytes of ECMAScript JSON.stringify([domain, activeAccountId, authenticatedPrincipalSubject, title, sourceMessageIdsInRequestOrder, metadataEntries])

- Metadata ordering: metadataEntries is an array of [key,value] pairs sorted ascending by the UTF-8 bytes of JSON.stringify(key); keys and values otherwise retain their parsed code units exactly.
- Durable strings: Every durable identity-sensitive ECMAScript string is stored as a SQLite BLOB containing the exact UTF-8 bytes of ECMAScript JSON.stringify(value). Read-back decodes UTF-8 fatally, JSON.parse returns exactly one string, and JSON.stringify(parsed) must reproduce the stored bytes byte-for-byte. Raw SQLite TEXT is forbidden for title, principal, account, metadata, model, and source-text values because binding an isolated surrogate would silently replace it.
- String comparison: Compare and index canonical JSON-string BLOB bytes. Do not trim, normalize, case-fold, count Unicode scalars, or compare SQLite-decoded TEXT for an accepted public string. Public Zod validation remains the only value-domain authority.
- Report ID: report:<fingerprint>
- Creation request ID: request:<lowercase SHA-256 hexadecimal digest of creationRequestMaterial>
- Account: Version 1 requires exactly one configured active account. The service injects its canonical account ID; no request, metadata, header, principal claim, or correlation ID selects an account. Startup or construction with zero or multiple active accounts fails closed before serving reports.create.
- Replay: An existing row whose fingerprint, canonical byte material, account, owner, versions, title, metadata, ordered sources, artifact digests, and response provenance all verify returns the first committed response byte-for-value after schema serialization, before any rate/count/byte admission and without resolving current source placement or loading current/snapshot source text again.
- Replay read projection: Select only report identity, canonical request/title metadata, provenance, source IDs/ordinals/labels/digests, and artifact version/digest/length columns. Never select report_artifacts.model_json or report_source_snapshots.source_text_json for create replay. Those content-bearing records are verified only by their separately authorized serving routes; their durable existence and metadata, together with exact identity and response reconstruction, are sufficient for a metadata-only create replay.
- Replay authorization: Every invocation first passes the registered reports:write HTTP authorization. An exact committed replay then succeeds without mail:read.message or any rate-ledger/capacity operation because it reads only immutable report/link/provenance metadata and allocates nothing. If no exact report exists and rolling-rate admission succeeds, exactly one attempt is committed and retained before mail:read.message is checked. Missing source scope returns the exact insufficient_scope 403 with zero source reads, materializer invocations, report/artifact/citation/capacity-total/publication writes, while the one rate-ledger attempt remains; it is therefore never described as zero total writes.
- Collision: An occupied report ID with any non-exact identity or durable-record mismatch is corruption or a hash collision. Return redacted internal_error, emit only private bounded diagnostics, write nothing, and never mint a random or suffixed identity.
- Concurrency: A process-local identity-scoped single-flight guard serializes identical contenders before replay and capacity; the guard is removed in one finally path when its last waiter exits, so identities do not accumulate. BEGIN IMMEDIATE separately serializes principal-rate admission and account-wide publication admission. A same-identity waiter rereads and returns the winner before capacity. A busy-timeout branch returns internal_error with zero report rows; a later retry returns the winner. Duplicate guards and unique keys make a second report impossible even if another process bypasses the in-memory guard.

## Source and citation authority

The canonical messages row exists; no message_content_states identity-only row exists; at least one remote_placements row for the injected active account has tombstone_observed_at IS NULL; and message_text_projections version 1 contains a non-empty production-normalized text value. A legacy row missing that projection may invoke normalizedTextAuthority.materializer only after the same identity/account/placement checks.

| First-create source case                     | Public result | HTTP | Writes                                                                                                                                      |
| -------------------------------------------- | ------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| eligible-active-account-text                 | success       | 200  | exact replay with no write, or one retained rate-ledger attempt followed by one atomic report publication                                   |
| missing-message                              | not_found     | 404  | one retained rate-ledger attempt; zero report publication writes                                                                            |
| identity-only-message                        | not_found     | 404  | one retained rate-ledger attempt; zero report publication writes                                                                            |
| all-configured-account-placements-tombstoned | not_found     | 404  | one retained rate-ledger attempt; zero report publication writes                                                                            |
| cross-account-only-active-placement          | not_found     | 404  | one retained rate-ledger attempt; zero report publication writes                                                                            |
| textless-normalized-projection               | not_found     | 404  | one retained rate-ledger attempt and zero report publication writes; an exact textless legacy projection may already have been materialized |

- Plain text: The production MIME parser emits one bounded message-level normalizedText string. MailParser keeps decoded text/plain when present and, with skipHtmlToText=false plus an explicit bounded maxHtmlLengthToParse, derives text only when HTML supplies the message text. No report-only plain/HTML SQL synthesis exists.
- HTML-derived fallback: HTML-to-text conversion is owned only by the production MIME parser with its pinned dependency and limits. Report code never reads original HTML, implements a second converter, or selects HTML body blobs directly.
- Snapshot: Parse the canonical source string from its canonical JSON BLOB, require byte-for-byte reserialization, and store that exact value once under owner, account, message ID, and projection version with a digest of its canonical string bytes and its emitted UTF-8 byte length. Reuse only an exact digest-and-byte match. A mismatch is internal corruption and rolls back.
- Stable serving: After creation, the durable snapshot remains the citation source even if all remote placements later tombstone or disappear. The text route never re-resolves placement and never falls back to current raw or HTML content.
- Citations: Citation identity is the request message ID. Label is exactly Source <one-based decimal request ordinal> with no zero padding. Response citations, report-model citations, durable source links, and rendered links use the same ordered pair.
- Forbidden content: Report construction and source serving never directly read body blobs, original message HTML, attachments, filenames, headers, URLs, remote resources, IMAP, or the network. The sole exception is the legacy normalized-text materializer: after both scopes and configured-account eligibility, it verifies the canonical raw-EML digest/size, copies exact bytes into an owner-only stage, and invokes the same production parser; only its bounded text projection may reach report code.

## Production normalized text

Extend ParsedStagedMime, SingleMessageIngestion, PromotionUnit, parsePromotionUnit, promoteCanonicalMessage, and strict promotion read-back so the exact bounded normalizedText selected by parseStagedEml is committed with every newly parsed canonical message. A direct SQL fixture, search-index body field, body-blob decode, or report-only parser is not evidence.

- Parser: Use the production parseStagedEml path with maxDecodedTextBytes 8388608, maxHtmlLengthToParse 8388608, skipHtmlToText false, skipTextToHtml true, and the existing bounded source/header/part/nesting rules. Preserve the emitted ECMAScript string exactly; do not trim or normalize it.
- Future ingestion: The canonical promotion transaction inserts and strict-read-backs the message_text_projections row with the message, raw-blob reference, placements, structured MIME rows, routing decisions, and journal. Failure rolls the complete promotion back.
- Legacy materializer: For a configured-account eligible legacy canonical message with no projection, read its immutable raw-eml reference, open the canonical blob without following symlinks, verify regular-file identity, exact size, and SHA-256, copy and fsync the exact bytes into an owner-only staging file, invoke parseStagedEml with the same production configuration, atomically insert and strict-read-back the projection, and await idempotent stage cleanup. It is cursor-bounded, restartable, and never fetches mail or writes a report.
- State set: checking-existing, verifying-raw, staging-exact-bytes, parsing-production-mime, publishing-projection, cleaning-stage, available, failed-clean
- Transition and cleanup: One invocation owns cancellation and exactly one awaited idempotent cleanup barrier. Active states name current work. Success reaches available only after projection read-back and stage cleanup; every failure reaches failed-clean only after cleanup, and restart begins by removing only verified owned stale stages before checking the durable projection.
- Proof: At least one composed fixture must begin with staged RFC 5322 EML bytes, run parseStagedEml through real single-message ingestion and canonical promotion, create through real HTTP/service/SQLite, then serve matching report and text evidence after reopen. A direct-SQL-only source fixture cannot satisfy this proof. A second fixture must restore a legacy database/raw blob with no projection, run the safe materializer, and prove byte-identical text/report behavior.

## Model and renderer

- Title: Exact parsed request title.
- Summary: Evidence report with <N> text-only source. when N is 1; Evidence report with <N> text-only sources. otherwise.
- Section: `Source evidence`.
- Claims: Create one claim per source in request order. Its text is the bounded excerpt of that source snapshot and its citations array contains exactly that source citation.
- Excerpts: If source UTF-8 bytes are at most 4096, use the exact source. Otherwise take the longest prefix ending at a Unicode scalar boundary whose UTF-8 bytes are at most 4093 and append U+2026, yielding at most 4096 bytes. Do not trim, normalize, summarize, execute instructions, or follow links.
- Metadata: Metadata is opaque durable request data and an identity input. It is never interpreted as a prompt, template, claim, source, provenance, renderer option, path, URL, or authorization value.
- Render: Construct and strict-parse the model, call renderReport version 1 inside the transaction, require the exact accepted CSP, enforce all byte limits, hash canonical model JSON, Markdown, HTML, and CSP, and store the model plus digests and lengths. Never store rendered Markdown or HTML.
- Serve: Resolve and strict-parse the stored model, select renderer version 1, render again, and constant-time verify model, Markdown, HTML, and CSP digests and lengths before emitting. Unknown versions or mismatches return redacted internal_error, never damaged content.

## Durable publication

Migration: Create report-creation-v1 only at packages/storage/src/migrations/0028-report-creation.ts and append that exact semantic migration as canonical registry slot 28 after the accepted immutable 1..27 prefix whose identity is 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab. Preserve accepted historical conversion target 27: the protected converter must execute and ledger only the 1..27 target slice and return at user_version 27, after which the protected common opener runs slot 28 only through strict applyMigrations and the inside-BEGIN verifyCanonicalMigrationPrefixState hook before any suffix effect. Only after exact current-tip canonical-state and integrity verification may that opener call the protected effect-safe recorder; runMigrations must rederive and byte-compare the complete fingerprint before a zero-write fixture no-op, while applyMigrations remains compatibility-unaware and strict. Update only the registry-derived live full digest, schema and next-slot constants, storage index report exports, registry test, and focused conversion composition test; do not change the protected converter, database opener, migration runner, or #233 artifacts, renumber or edit a predecessor, substitute the live full digest into historical provenance, loop the converter over the live registry, record target 27 before suffix completion, weaken strict applyMigrations, or bypass opener, doctor, backup, or restore authority.

Prefix evolution: Append slot 28 only through the accepted canonical registry. The accepted real legacy converter resolves explicit target 27, executes and ledgers only canonicalDatabaseMigrations.slice(0, 27), sets user_version 27, verifies that exact base, and returns without observing the live suffix. The common production opener then always invokes strict applyMigrations over the complete live registry; inside the slot-28 BEGIN IMMEDIATE transaction, beforePendingMigration verifies exact prefix 27 before any report SQL, schema_migrations INSERT, user_version write, or commit. After reaching exact current tip 28, the opener verifies canonical state and integrity before the effect-safe recorder independently verifies and fingerprints the complete current-tip authority; only then may runMigrations provide a fingerprint-reverified zero-write legacy-fixture compatibility no-op. Preserve every 1..27 semantic byte and immutable target-27 provenance byte; the new live full-registry digest must differ from and never replace target_registry_sha256. The converter, database opener, and migration runner remain byte-protected; update only the registry, storage index, and focused registry/conversion-composition tests required for slot 28.

Legacy conversion authority:

1. resolve the sole accepted historical target before conversion and freeze targetVersion 27 plus digest 39971e45e0fe51580b0343d05b935a7583e42544b2f96ba6468bd813a11b68ab
2. derive targetMigrations as canonicalDatabaseMigrations.slice(0, targetVersion); never iterate the complete live registry
3. inside one BEGIN IMMEDIATE execute only missing targetMigrations 1..27, install conversion infrastructure, insert the immutable target-27 provenance row, rewrite schema_migrations exactly to targetMigrations 1..27, and set user_version exactly 27
4. verify the complete target-27 state and commit without executing, ledgering, or setting user_version for any migration above targetVersion
5. after conversion returns, the production opener always invokes applyMigrations with the complete live registry and beforePendingMigration; this common suffix path is not confined to a non-legacy else branch
6. each pending 28-or-later definition runs in its own BEGIN IMMEDIATE transaction only after verifyCanonicalMigrationPrefixState accepts the locked predecessor

Safe recorder authority:

1. the real legacy converter commits and verifies only explicit historical target 27, then returns without observing slot 28
2. the common production opener routes pending slot 28 through strict applyMigrations and the inside-BEGIN beforePendingMigration prefix verifier
3. after the complete live registry reaches exact current tip 28, the opener verifies canonical migration state and database integrity before recorder invocation
4. recordVerifiedCanonicalApplicationDatabaseForLegacyFixtures synchronously and independently verifies registry-derived current-tip user_version, exact ordered history, complete sqlite_schema tuples, strict immutable conversion rows, and the grammar-valid reindex overlay before changing its module-private WeakMap
5. runMigrations recomputes and byte-compares the complete recorded fingerprint before a zero-write legacy-fixture compatibility no-op; applyMigrations never reads compatibility state and remains strict

Signed implementation modes: `--implementation-sequence-check` and `--implementation-compatibility-check`.

| Table                   | Primary key                                                           | Purpose                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| reports                 | report_id                                                             | canonical identity, owner/account, request material, title/metadata, first trusted provenance, source count, and creation timestamps |
| report_artifacts        | report_id                                                             | one versioned canonical model and verified model/Markdown/HTML/CSP digests and UTF-8 byte lengths                                    |
| report_source_snapshots | owner_principal_json, account_id_json, message_id, projection_version | one exact text-only snapshot per owner, account, message ID, and projection version                                                  |
| report_sources          | report_id, ordinal                                                    | ordered report-to-snapshot links with stable citation label and source digest                                                        |

1. Validate the already parsed request, trusted context, configured single account, fixed versions, canonical string bytes, and per-request source count before acquiring an identity-scoped single-flight guard.

2. Compute canonical identity, report ID, and server-derived creation request ID; under the guard perform the metadata-only exact-replay lookup before any capacity, source, snapshot-text, or materializer operation.

3. Exact-verify and return an existing report under reports:write alone, or fail collision/corruption. On an exact-replay miss, atomically evaluate rolling-rate admission; a rate-denied miss changes no ledger or report row, while every admitted miss commits and retains exactly one principal attempt before mail:read.message authorization or source materialization.

4. Still before any source read, reject an account already at 10000 committed reports or 2147483648 logical charged bytes; then require mail:read.message. Missing source scope returns the frozen 403 after exactly one retained rate-ledger attempt, with zero source reads, materializer invocations, report/artifact/citation/capacity-total/publication writes, and never a zero-total-writes claim.

5. Resolve every first-create source from its production-normalized durable projection in request order; a legacy-safe materializer completes before the report publication transaction and may remain as canonical message data if later report work fails.

6. Build and strict-parse the model, render with renderer version 1, enforce CSP and every per-request byte bound, compute all digests, classify reusable snapshots, and compute the exact prospective logical charge.

7. Begin BEGIN IMMEDIATE, defensively rerun the metadata-only exact-replay lookup, then recompute committed report count and logical charged bytes from immutable rows. Return an exact concurrent replay, or reject if count plus one or charge plus the prospective graph would exceed Policy A before the first report-table INSERT.

8. Obtain one canonical millisecond UTC instant from the injected server clock for both authorized_at and created_at.

9. Stage the artifact and ordered source-link rows under deferred report/snapshot foreign keys; insert or exact-verify each referenced snapshot; insert the report row last so publication guards observe one complete graph.

10. Read every inserted row back through strict decoders; reconstruct identity, response, citations, model, digests, report count, and logical charge and require exact equality and Policy A compliance.

11. Commit the report publication once and release the identity guard. Any throw, renderer rejection, injected failure, constraint failure, busy timeout, decode mismatch, or read-back mismatch rolls back the publication once and returns no partial public value; a previously admitted non-replay attempt remains durable rate evidence.

Backup: Because every report artifact and source snapshot is in the SQLite database, the accepted serialized SQLite backup, manifest hash, artifact rehash, integrity check, foreign-key check, and atomic empty-root restore include reports without a new manifest role or sidecar. A proof must create before backup and serve after restore; table-existence alone is insufficient.

Restore: Restore only to a new or empty private root, verify the accepted canonical registry before publication, reopen through the sole registry at schema version 28, and verify report/source/projection records, canonical string round trips, all digests, all UPDATE/DELETE/REPLACE/duplicate-key guards, recomputed Policy A count/logical charge, and restored rolling-rate state without reset or double charge. A converted database retains its exact immutable historical target-27 provenance after slot 28; an unknown target or recomputed live-full-digest substitution rejects in preflight, pre-suffix, reopen, doctor, backup, and restore. Preserve owner/account authorization. A legacy database first converts only to target 27, then applies report slot 28 through the verified suffix path, and retains raw EML for the safe materializer.

Duplicate-key guards:

- `reports_reject_duplicate_insert`: EXISTS report_id OR fingerprint_sha256 OR authorization_request_id conflict; BEFORE INSERT RAISE(ABORT, 'reports are immutable').
- `report_artifacts_reject_duplicate_insert`: EXISTS report_id conflict; BEFORE INSERT RAISE(ABORT, 'report artifacts are immutable').
- `report_source_snapshots_reject_duplicate_insert`: EXISTS primary-key or declared unique-key conflict using canonical owner/account BLOB equality; BEFORE INSERT RAISE(ABORT, 'report source snapshots are immutable').
- `report_sources_reject_duplicate_insert`: EXISTS (report_id, ordinal) or (report_id, message_id) conflict; BEFORE INSERT RAISE(ABORT, 'report sources are immutable').

## Provenance, serving, and CLI

Provenance owner: OperationHandlerContext.principal.subject after shared authentication and exact reports:write authorization, serialized as canonical JSON-string bytes without normalization.

Provenance method: The current public reports.create route admits Bearer credentials only. CLI uses that same HTTP route and therefore records bearer, not local-cli. A future trusted-proxy or offline-local method requires a trusted boundary discriminator and a new authority version; headers and User-Agent never choose the method.

First-create scopes: The shared boundary authenticates and enforces reports:write before reading the body. After canonical identity lookup proves there is no exact replay, a miss that passes rolling-rate admission commits and retains exactly one rate-ledger attempt before the service checks mail:read.message. The scope guard still precedes every message, placement, normalized-text, raw-blob, or snapshot query/materialization. Missing scope returns insufficient_scope/403 with exact message 'request credentials are not authorized' and strict {}; it performs zero source reads, materializer invocations, message-text-projection, report, artifact, citation, capacity-total, or publication writes, while retaining the one admitted rate-ledger attempt, so total writes are not zero.

Missing-scope total writes: Exactly one durable rate-ledger attempt is committed and retained; this terminal never claims zero total writes.

Missing-scope instrumentation: Instrument every source read and materializer invocation plus every write to report_create_rate_windows, message_text_projections, reports, report_artifacts, report_source_snapshots, report_sources, any capacity-total state, and any publication sink. The missing-scope branch must observe only the one committed rate-ledger attempt.

Replay scopes: An exact committed replay requires reports:write only and returns without mail:read.message, current-source reads, normalized-text materialization, snapshot-text reads, allocation, rate charge, or write. A caller with mail:read.message but without reports:write is rejected by the shared boundary before body read and cannot probe replay.

Serving repository: Issue 232 changes the internal repository calls to resolveReport(reportId, canonicalPrincipalBytes) and resolveSource(messageId, canonicalPrincipalBytes), with canonical active-account bytes fixed at repository construction. SQL predicates include report/message ID plus byte-exact owner and account BLOBs before model or source materialization. Public routes and schemas do not change.

Report integrity: Before report output, verify canonical model bytes, versions, all stored digests and lengths, rerender using version 1, and compare the accepted CSP. Mismatch is internal_error with no artifact bytes.

Source integrity: Before source output, verify snapshot owner/account/message/version, canonical source_text_json bytes and SHA-256, exact JSON-string round trip, and emitted UTF-8 byte length. Mismatch is internal_error with no source bytes.

CLI success: Strict-parse reportAdminReportResponseSchema and create one #214 value result with operationKey reports.create and semanticKind success. JSON mode emits exactly the validated response as one canonical JSON line on stdout; no wrapper or extra provenance is added.

CLI safety: Every fixed label and separator is trustedChrome. Every response-derived value, including numeric formatting and citation label, is a separate untrustedValue segment. The adapter never concatenates untrusted values into trusted chrome and never prints source text, metadata, paths, credentials, or body digests.

## Capacity and retention

| Limit                                    | Bytes or count |
| ---------------------------------------- | -------------- |
| HTTP request                             | 1048576        |
| Identity material                        | 1048576        |
| Metadata JSON                            | 1048576        |
| Source IDs                               | 100            |
| One source projection                    | 10485760       |
| All source projections                   | 10485760       |
| One canonical source JSON                | 50331650       |
| All canonical source JSON                | 62914760       |
| One claim excerpt                        | 4096           |
| Model JSON                               | 1048576        |
| Rendered Markdown                        | 16777216       |
| Rendered HTML                            | 16777216       |
| Committed reports                        | 10000          |
| Logical charged bytes                    | 2147483648     |
| Non-replay attempts per principal/window | 10 / 60000 ms  |

Admission order: After reports:write authentication and bounded parsing: canonicalize identity; acquire the identity single-flight guard; perform metadata-only exact replay and return it without any capacity charge; on a miss atomically evaluate and record the principal rolling attempt; reject an account already at either committed limit; require mail:read.message; resolve bounded sources and construct bounded outputs; then under BEGIN IMMEDIATE defensively recheck replay and atomically admit count plus exact prospective logical charge before the first report-table INSERT.

Machine admission sequence: reports:write-authorization -> bounded-body-parse -> canonical-identity -> identity-single-flight -> metadata-only-exact-replay -> durable-rate-ledger-admission -> account-capacity-read -> mail:read.message-authorization -> source-resolution-and-materialization -> bounded-model-and-render -> publication-BEGIN-IMMEDIATE -> publication-exact-replay-recheck -> count-and-logical-charge-admission -> report-publication

Reject canonical identity material, metadata JSON, and source count before identity admission. On exact-replay miss, resolve at most 100 sources sequentially while maintaining checked UTF-8 and canonical-JSON byte totals; abort before exceeding a per-source or aggregate bound. Render only the bounded model. Every per-request and Policy A boundary is inclusive at its stated maximum and rejects one byte, row, source, or attempt over.

Issue 232 changes the shared HTTP boundary so reports.create uses min(configured global maxRequestBodyBytes, 1048576). Authentication and the registered reports:write authorization happen before declared-length inspection or body-reader acquisition. A raised global limit cannot raise this operation cap. Declared Content-Length over 1048576 is cancelled and rejected before reader/handler; an undeclared or chunked body is cancelled as soon as received bytes would exceed 1048576, before JSON parsing or handler. Both use request_too_large/413, exact message 'request body exceeds configured limit', strict {}, and zero handler/source/write calls.

For every authenticated exact-replay miss, use injected canonical millisecond UTC now and effectiveNow=max(now,last_observed_at) so wall-clock rollback cannot reopen the window. In one BEGIN IMMEDIATE transaction, strict-decode the principal row, retain only attempts with instant > effectiveNow-60000, and deny when 10 remain without changing the row. Otherwise append exactly one effectiveNow attempt, persist the canonical array and last_observed_at, strict-read it back, and commit before mail:read.message authorization, source scope, or materialization. Missing source scope and every later source, renderer, publication, or storage failure retain this admitted attempt. Backup and restore retain the ledger; elapsed restored windows expire only by the same calculation.

Account-wide logical charged bytes are recomputed from the four immutable report tables. Charge the exact length in bytes of every stored TEXT or BLOB column and exactly 8 bytes for every stored INTEGER column, count each physical row once, count a reusable report_source_snapshots row only when first inserted, and exclude SQLite page/index/trigger/schema overhead, the mutable rate ledger, and canonical mail tables including message_text_projections. Before publication, compute the same sum for the exact prospective new rows and require committedCharge+prospectiveCharge <= 2147483648 under BEGIN IMMEDIATE; checked integer arithmetic overflow is internal corruption and publishes nothing.

Committed report count is COUNT(*) of reports across every owner in the sole configured account. Before source materialization reject when count is already 10000 or logical charge is already 2147483648. At publication require count+1 <= 10000 and exact recomputed charge plus prospective charge <= 2147483648. Account admission and publication are serialized by SQLite; restore and reopen recompute rather than trust a mutable counter.

Every focused admission proof instruments report_create_rate_windows, message_text_projections, all four immutable report tables, any capacity-total state, and every publication sink. It distinguishes zero report-publication writes from zero total writes and proves that a missing mail:read.message terminal after an admitted replay miss retains exactly one rate-ledger attempt and no other write.

Policy A bounds committed report graphs at both 10000 reports and 2147483648 logical charged bytes and bounds each principal's admitted non-replay attempt rate. The database can still encounter physical SQLITE_FULL, I/O, or commit failure below a logical limit; that is redacted internal_error with complete report-publication rollback, never a quota reinterpretation.

Committed reports, artifacts, source snapshots, source links, and creation provenance are immutable and retained indefinitely in backup. There is no report TTL, LRU, automatic compaction, delete route, cascade, quota eviction, or cleanup, including after either fixed limit is reached. Raising, lowering, or configuring the fixed constants is not authorized by version 1.

Whole-database backup includes immutable report rows and the rate ledger. Empty-root restore verifies canonical migration history, integrity, and foreign keys, recomputes exact count and logical charge before accepting a create, strict-verifies every rate row, and never resets, duplicates, discounts, deletes, or evicts committed report evidence. Restoring a database already at a limit succeeds read-only but denies each distinct create under the frozen 413 outcome.

All four Policy A constants are private code authority. Issue 232 adds no configuration key, environment variable, request field, response field, OpenAPI shape, CLI flag, public error code, or status.

## Exact service messages

The global HTTP error authority owns each registered code, HTTP status, and strict details schema. Its general definitions intentionally do not freeze messages. This report authority therefore freezes the exact report-service messages below without changing the global registry or public schemas; the shared HTTP admission boundary retains its own already-implemented exact authentication and request-body messages.

| Terminal                  | Code               | HTTP | Message                                 | Details                                   |
| ------------------------- | ------------------ | ---- | --------------------------------------- | ----------------------------------------- |
| created-or-replayed       | success            | 200  | success value                           | validated ReportAdminReportResponse value |
| source-scope-required     | insufficient_scope | 403  | request credentials are not authorized  | strict empty object                       |
| source-unavailable        | not_found          | 404  | report source was not found             | strict empty object                       |
| capacity-exceeded         | request_too_large  | 413  | report request exceeds configured limit | strict empty object                       |
| policy-capacity-exhausted | request_too_large  | 413  | report capacity is exhausted            | strict empty object                       |
| internal-failure          | internal_error     | 500  | internal server error                   | strict empty object                       |
