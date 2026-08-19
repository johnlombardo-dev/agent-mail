# CLI command outcome coverage v1

Status: checked coverage view. Normative oracle SHA-256: 428c4043a5cfa031d237bf9638911b8a2ec71d7c919c11dacfde31b70f3bcfa8.

[cli-command-outcome-oracle.v1.json](cli-command-outcome-oracle.v1.json) is normative. It contains 11 requirements, 19 decisions, 19 constructive examples, 10 property obligations, 27 downstream obligations, and 12 adjacent counterexamples.

No unresolved #213 policy choices. Issue #220 reconciles the downstream routing contract by adding exactly three operation-scoped `routing.commit` mappings: replay/82, expired/81, and tampered/83 at HTTP 409. The #213 registry and all prior mappings remain unchanged; I156-01 still forbids CLI-private substitutes.

## Requirement closure

| Requirement    | Decisions               | Constructive examples                                                                                                                                             | Properties                                          | Downstream obligations                      |
| -------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| REQ-ALGEBRA    | D01, D04, D06           | EX-JSON-SUCCESS, EX-SYNC-200-REJECTED, EX-UNKNOWN-KIND                                                                                                            | PROP-REGISTRY-COMPLETE, PROP-EXTENSION-CLOSED       | I214-01                                     |
| REQ-EXIT       | D02, D03, D10, D11, D12 | EX-ACTION-PARTIAL, EX-ACTION-UNCERTAIN, EX-RAW-EPIPE, EX-SIGINT, EX-SIGTERM                                                                                       | PROP-NUMERIC-UNIQUE                                 | I214-01, I157-01, I158-01                   |
| REQ-OUTPUT     | D07, D08, D09, D19      | EX-JSON-SUCCESS, EX-JSON-NOT-FOUND, EX-HUMAN-HOSTILE, EX-RAW-COMPLETE, EX-MODE-MISMATCH                                                                           | PROP-MODE-DESTINATION, PROP-ATOMIC-FRAMES           | I214-02, I193-01, I194-01, I195-01, I186-01 |
| REQ-ERROR      | D05, D06                | EX-JSON-NOT-FOUND, EX-SYNC-200-REJECTED, EX-UNKNOWN-KIND                                                                                                          | PROP-REGISTRY-COMPLETE, PROP-ERROR-NO-MESSAGE-PARSE | I214-01, I192-01                            |
| REQ-DOMAIN     | D04, D15, D16, D18      | EX-ACTION-PARTIAL, EX-ACTION-UNCERTAIN, EX-ACTION-STALE, EX-ACTION-MISSING-TARGET, EX-ACTION-CANCELLED-AUTHORITY, EX-ACTION-INCOMPLETE-AUDIT, EX-DOCTOR-UNHEALTHY | PROP-ACTION-ATTENTION, PROP-PARITY                  | I156-01, I158-01, I162-01, I191-01, I161-01 |
| REQ-RAW        | D09, D10, D11           | EX-RAW-COMPLETE, EX-RAW-EPIPE, EX-RAW-PARTIAL-TIMEOUT                                                                                                             | PROP-RAW-FAILURE                                    | I157-01, I163-01, I176-01                   |
| REQ-SIGNAL     | D10, D12                | EX-RAW-EPIPE, EX-SIGINT, EX-SIGTERM                                                                                                                               | PROP-RAW-FAILURE                                    | I214-02, I157-01                            |
| REQ-SAFETY     | D07, D08, D13, D14      | EX-HUMAN-HOSTILE, EX-CORRELATION                                                                                                                                  | PROP-HOSTILE-OUTPUT, PROP-ERROR-NO-MESSAGE-PARSE    | I214-02, I183-01                            |
| REQ-EXTENSION  | D01, D17, D18           | EX-UNKNOWN-KIND                                                                                                                                                   | PROP-EXTENSION-CLOSED                               | I214-04, I156-01                            |
| REQ-COVERAGE   | D05, D15, D17           | EX-SYNC-200-REJECTED, EX-RAW-PARTIAL-TIMEOUT                                                                                                                      | PROP-REGISTRY-COMPLETE, PROP-PARITY                 | I214-03, I164-01, I165-01, I169-01, I178-01 |
| REQ-DOWNSTREAM | D17, D18                | EX-DOCTOR-UNHEALTHY, EX-RAW-EPIPE, EX-UNKNOWN-KIND                                                                                                                | PROP-PARITY, PROP-EXTENSION-CLOSED                  | all 27 downstream rows below                |

## Exact exit inventory

| Kind          | Exit | Kind          | Exit | Kind           | Exit |
| ------------- | ---: | ------------- | ---: | -------------- | ---: |
| success       |    0 | usage         |   64 | invalid_input  |   65 |
| not_found     |   66 | unavailable   |   69 | internal       |   70 |
| io            |   74 | temporary     |   75 | protocol       |   76 |
| authorization |   77 | configuration |   78 | conflict       |   79 |
| stale         |   80 | expired       |   81 | replay         |   82 |
| tampered      |   83 | cancelled     |   84 | attention      |   85 |
| partial       |   86 | uncertain     |   87 | partial_output |   88 |

Reserved normal statuses are 124, 125, 126, and 127. Signal results are SIGINT 130, EPIPE 141, and SIGTERM 143. No normal result is 128 or greater.

ExecutionReceiptV1 contains 24 exact pair branches: the 21 rows above plus cancelled/130, partial_output/141, and cancelled/143. The checker accepts every pair and rejects semantic/exit cross-products such as success/88, partial_output/0, cancelled/141, and usage/130.

## Local failure registry

| Code                    | Kind/exit         | Fixed message                                              | Detail schema / exact fields                                                                           |
| ----------------------- | ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| cli.usage               | usage/64          | command invocation is invalid                              | LOCAL-DETAIL-CLI-USAGE: commandPath string or null; reasonCode string                                  |
| cli.invalid-input       | invalid_input/65  | command input does not satisfy the shared request contract | LOCAL-DETAIL-CLI-INVALID-INPUT: operationKey string or null; reasonCode string                         |
| cli.configuration       | configuration/78  | Agent Mail configuration is missing or invalid             | LOCAL-DETAIL-CLI-CONFIGURATION: settingCode string; reasonCode string                                  |
| cli.connect-timeout     | temporary/75      | connection did not complete before its deadline            | LOCAL-DETAIL-CLI-CONNECT-TIMEOUT: operationKey; phase connect                                          |
| cli.control-timeout     | temporary/75      | control response did not arrive before its deadline        | LOCAL-DETAIL-CLI-CONTROL-TIMEOUT: operationKey; phase control                                          |
| cli.stream-idle-timeout | temporary/75      | stream made no progress before its idle deadline           | LOCAL-DETAIL-CLI-STREAM-IDLE-TIMEOUT: operationKey; phase stream-idle                                  |
| cli.protocol            | protocol/76       | the CLI and service contract do not agree                  | LOCAL-DETAIL-CLI-PROTOCOL: operationKey string or null; phase string                                   |
| cli.cancelled           | cancelled/84      | command execution was cancelled                            | LOCAL-DETAIL-CLI-CANCELLED: operationKey string or null; source caller or domain                       |
| cli.transport           | unavailable/69    | the Agent Mail service is unavailable                      | LOCAL-DETAIL-CLI-TRANSPORT: operationKey; phase request or stream                                      |
| cli.internal            | internal/70       | the CLI could not complete the command                     | LOCAL-DETAIL-CLI-INTERNAL: operationKey string or null; phase string                                   |
| cli.output-io           | io/74             | the requested output could not be written                  | LOCAL-DETAIL-CLI-OUTPUT-IO: destination stdout or stderr; phase string                                 |
| cli.partial-output      | partial_output/88 | output ended after an incomplete prefix was written        | LOCAL-DETAIL-CLI-PARTIAL-OUTPUT: operationKey; causeCode; boundary; stdout/stderr accepted counts/null |
| cli.raw-tty-refused     | usage/64          | raw output is refused on a TTY without explicit opt-in     | LOCAL-DETAIL-CLI-RAW-TTY-REFUSED: operationKey; destination tty                                        |

Each row references one `LOCAL-DETAIL-CLI-*` JSON Schema with `additionalProperties: false`, exact required fields, ASCII identifiers or closed enums, bounded strings, and safe-integer bounds where applicable. LocalErrorEnvelopeV1 fixes the code and message for that schema; the registry fixes its semantic kind. Positive probes validate all 13 pairings. Negative probes reject mismatched code/message/details, extra envelope or detail keys, recursive/dangerous keys, control or overlong correlation IDs, overlong detail strings, and invalid accepted-byte counts.

## CliClientError coverage

| Kind                  | Projection                         | Kind/exit                |
| --------------------- | ---------------------------------- | ------------------------ |
| connect_timeout       | cli.connect-timeout                | temporary/75             |
| control_timeout       | cli.control-timeout                | temporary/75             |
| stream_idle_timeout   | cli.stream-idle-timeout            | temporary/75             |
| client_contract_error | cli.protocol                       | protocol/76              |
| http_error            | registered code plus typed details | registered-error-mapping |
| aborted               | cli.cancelled                      | cancelled/84             |
| transport_error       | cli.transport                      | unavailable/69           |

The checker extracts the accepted CliClientErrorKind union and requires this exact seven-row bijection.

## Shared public error coverage

| Registered code                      | HTTP | Kind/exit        |
| ------------------------------------ | ---: | ---------------- |
| invalid_request                      |  400 | invalid_input/65 |
| missing_credentials                  |  401 | authorization/77 |
| invalid_credentials                  |  401 | authorization/77 |
| expired_credentials                  |  401 | authorization/77 |
| insufficient_scope                   |  403 | authorization/77 |
| request_too_large                    |  413 | invalid_input/65 |
| not_found                            |  404 | not_found/66     |
| internal_error                       |  500 | internal/70      |
| action.approval_forbidden            |  403 | authorization/77 |
| action.approval_presence_required    |  403 | authorization/77 |
| action.operator_presence_unsupported |  503 | unavailable/69   |
| action.operator_challenge_capacity   |  429 | temporary/75     |
| action.operator_challenge_not_found  |  404 | not_found/66     |
| action.operator_challenge_expired    |  409 | expired/81       |
| action.operator_challenge_consumed   |  409 | replay/82        |
| action.operator_assertion_invalid    |  403 | tampered/83      |
| action.approval_not_found            |  409 | not_found/66     |
| action.approval_mismatch             |  409 | tampered/83      |
| action.approval_expired              |  409 | expired/81       |
| action.approval_cancelled            |  409 | cancelled/84     |
| action.approval_invalidated          |  409 | stale/80         |
| action.approval_consumed             |  409 | replay/82        |
| action.plan_version_stale            |  409 | stale/80         |
| action.plan_not_pending              |  409 | conflict/79      |
| action.plan_expired                  |  409 | expired/81       |
| action.legacy_authority              |  409 | authorization/77 |

The three #220 routing errors are operation-scoped and are intentionally absent from this shared table.

## Operation-scoped error coverage

| Code                              | HTTP | Selector       | Exact projection                                                                      |
| --------------------------------- | ---: | -------------- | ------------------------------------------------------------------------------------- |
| invalid_query                     |  400 | constant       | invalid_input/65                                                                      |
| invalid_cursor                    |  400 | constant       | invalid_input/65                                                                      |
| not_found                         |  404 | constant       | not_found/66                                                                          |
| routing.preview_replayed          |  409 | constant       | replay/82                                                                             |
| routing.preview_expired           |  409 | constant       | expired/81                                                                            |
| routing.preview_tampered          |  409 | constant       | tampered/83                                                                           |
| sync.control-rejected             |  500 | details.reason | stale-version to stale/80; incompatible-state, busy, shutdown-terminal to conflict/79 |
| sync.control-failed               |  500 | details.reason | terminal-failure to internal/70; auth-blocked to authorization/77                     |
| sync.control-cancelled            |  500 | constant       | cancelled/84                                                                          |
| sync.control-timeout              |  500 | constant       | temporary/75                                                                          |
| sync.control-idempotency-conflict |  500 | constant       | conflict/79                                                                           |
| sync.control-capacity             |  500 | constant       | temporary/75                                                                          |

All 32 accepted applicability rows:

| Operation       | Applicable code/status rows                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| attachments.get | not_found/404                                                                                                                                                              |
| messages.get    | not_found/404                                                                                                                                                              |
| messages.raw    | not_found/404                                                                                                                                                              |
| messages.search | invalid_query/400, invalid_cursor/400                                                                                                                                      |
| routing.commit  | routing.preview_replayed/409, routing.preview_expired/409, routing.preview_tampered/409                                                                                    |
| sync.pause      | sync.control-rejected/500, sync.control-failed/500, sync.control-cancelled/500, sync.control-timeout/500, sync.control-idempotency-conflict/500, sync.control-capacity/500 |
| sync.resume     | sync.control-rejected/500, sync.control-failed/500, sync.control-cancelled/500, sync.control-timeout/500, sync.control-idempotency-conflict/500, sync.control-capacity/500 |
| sync.start      | sync.control-rejected/500, sync.control-failed/500, sync.control-cancelled/500, sync.control-timeout/500                                                                   |
| sync.stop       | sync.control-rejected/500, sync.control-failed/500, sync.control-cancelled/500, sync.control-timeout/500, sync.control-idempotency-conflict/500, sync.control-capacity/500 |
| threads.get     | invalid_cursor/400, not_found/404                                                                                                                                          |

An operation not listed has no operation-scoped error rows at the accepted HEAD. Shared registered errors remain applicable through the shared client authority.

## Operation and mode reconstruction

| Operation                    | Command path                 | Stream | Value policy                |
| ---------------------------- | ---------------------------- | ------ | --------------------------- |
| messages.search              | messages search              | none   | registered-error-or-success |
| messages.get                 | messages get                 | none   | registered-error-or-success |
| threads.get                  | threads get                  | none   | registered-error-or-success |
| messages.raw                 | messages raw                 | bytes  | raw                         |
| attachments.get              | attachments get              | bytes  | raw                         |
| routing.preview              | routing preview              | none   | success                     |
| routing.commit               | routing commit               | none   | routing-commit              |
| messages.label               | messages label               | none   | label                       |
| action-plans.create          | action plans create          | none   | success                     |
| action-plans.inspect         | action plans inspect         | none   | action-plan                 |
| action-plans.approve         | action plans approve         | none   | success                     |
| action-plans.cancel-approval | action plans approval cancel | none   | success                     |
| action-plans.commit          | action plans commit          | none   | action-plan                 |
| reports.create               | reports create               | none   | success                     |
| exports.selected             | exports selected             | bytes  | raw                         |
| admin.backup                 | admin backup                 | none   | success                     |
| admin.restore                | admin restore                | none   | success                     |
| admin.doctor                 | admin doctor                 | none   | doctor                      |
| admin.reindex                | admin reindex                | none   | success                     |
| sync.status                  | sync status                  | none   | sync-status                 |
| sync.start                   | sync start                   | none   | registered-error-or-success |
| sync.pause                   | sync pause                   | none   | registered-error-or-success |
| sync.resume                  | sync resume                  | none   | registered-error-or-success |
| sync.stop                    | sync stop                    | none   | registered-error-or-success |

The 21 none operations default to human and allow JSON/human. The three bytes operations default to raw and allow raw. There is no current ndjson operation. Any other pairing is cli.usage/64 before configuration/client execution; a resolved explicit context owns the error, while pre-command or conflicting context selection uses human.

## Domain-rule construction

The oracle defines a recursive typed expression schema, a typed projection schema, seven ordered selectors, and a first-match evaluator. Eight bases expand into 62 outcome fixtures; 16 projection fixtures derive facts from action, doctor, sync, routing, label, and default values. The corpus reaches all 20 rules, every projection branch, all action state/result/approval/audit combinations represented by the classifier, all five target-coverage values, all precedence overlaps, every sync/doctor branch, registered-error precedence in every selector, and both deliberate no-match protocol fallbacks.

| Selector                | Assigned value operations                                            |
| ----------------------- | -------------------------------------------------------------------- |
| SELECTOR-ACTION-INSPECT | action-plans.inspect                                                 |
| SELECTOR-ACTION-COMMIT  | action-plans.commit                                                  |
| SELECTOR-DOCTOR         | admin.doctor                                                         |
| SELECTOR-SYNC-STATUS    | sync.status                                                          |
| SELECTOR-ROUTING-COMMIT | routing.commit                                                       |
| SELECTOR-LABEL          | messages.label                                                       |
| SELECTOR-DEFAULT        | the other 15 non-streaming operations listed in the operation matrix |

| Rule IDs                                                               | Covered branch                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| DOMAIN-REGISTERED-ERROR                                                | Applicable strict envelope before every value classifier, including HTTP 200         |
| DOMAIN-ACTION-UNCERTAIN                                                | Uncertain plan/result/audit or unknown-after-restore; exit 87                        |
| DOMAIN-ACTION-PARTIAL                                                  | Explicit partial plan/audit or mixed success/non-success; exit 86                    |
| DOMAIN-ACTION-STALE                                                    | Exact frozen-target all-stale or invalidated approval; exit 80                       |
| DOMAIN-ACTION-EXPIRED                                                  | Expired plan, audit, or approval after higher-priority rules; exit 81                |
| DOMAIN-ACTION-CANCELLED                                                | Cancelled inspect approval; exit 84                                                  |
| DOMAIN-ACTION-INSPECT-PENDING                                          | Pending, no results/audit, absent or available approval; exit 0                      |
| DOMAIN-ACTION-INSPECT-COMPLETED                                        | Exact all-success targets plus consumed approval and completed/started audit; exit 0 |
| DOMAIN-ACTION-COMMIT-COMPLETED                                         | Exact all-success targets plus validated consumption receipt; exit 0                 |
| DOMAIN-ACTION-ATTENTION                                                | Active/failure/quarantine, incomplete authority/audit/coverage, unmatched result; 85 |
| DOMAIN-DOCTOR-HEALTHY, DOMAIN-DOCTOR-ATTENTION                         | Healthy 0; degraded/unhealthy 85                                                     |
| DOMAIN-SYNC-AUTH-BLOCKED, DOMAIN-SYNC-STATUS                           | authBlocked 85; other accepted actor state 0                                         |
| DOMAIN-ROUTING-COMMITTED, DOMAIN-ROUTING-DRY-RUN                       | Committed or explicit dry-run 0                                                      |
| DOMAIN-LABEL-COMMITTED, DOMAIN-LABEL-DRY-RUN, DOMAIN-LABEL-UNCOMMITTED | Committed/dry-run 0; other validated uncommitted 85                                  |
| DOMAIN-DEFAULT-SUCCESS                                                 | Remaining declared success policy after no error; exit 0                             |

## Output and runtime probes

The output matrix covers OUT-JSON-VALUE, OUT-JSON-FAILURE, OUT-HUMAN-VALUE, OUT-HUMAN-FAILURE, OUT-RAW-STREAM, OUT-RAW-PREFAIL, OUT-RAW-PARTIAL, OUT-EPIPE, and OUT-SIGNAL.

The runtime injection matrix covers:

| Rows                                                  | Expected result                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| RUN-PRE-SINK-IO                                       | Proven zero acceptance on both sinks: io/74                                     |
| RUN-POST-SINK-IO                                      | Accepted or unknown stdout/stderr prefix: partial_output/88                     |
| RUN-EPIPE-ZERO, RUN-EPIPE-PARTIAL                     | Await cleanup once, silence, 141                                                |
| RUN-STREAM-FAIL-ZERO                                  | Underlying registered client kind before output                                 |
| RUN-STREAM-FAIL-PARTIAL                               | Preserve prefix, no retry, partial_output/88                                    |
| RUN-CALLER-ABORT-ZERO, RUN-CALLER-ABORT-PARTIAL       | cancelled/84 before output; partial_output/88 after prefix                      |
| RUN-SIGINT, RUN-SIGTERM                               | Await cleanup once, silence, 130/143                                            |
| RUN-RENDER-FAIL                                       | internal/70 before output                                                       |
| RUN-CLEANUP-FAIL-ZERO, RUN-CLEANUP-FAIL-PARTIAL       | internal/70 before output; partial_output/88 after prefix                       |
| RUN-DIAGNOSTIC-FAIL-ZERO, RUN-DIAGNOSTIC-FAIL-PARTIAL | io/74 before output; partial_output/88 after accepted/unknown diagnostic prefix |

## Property corpus and adjacent counterexamples

| Property                    | Required proof                                                               |
| --------------------------- | ---------------------------------------------------------------------------- |
| PROP-REGISTRY-COMPLETE      | Accepted source and oracle are exact two-way sets                            |
| PROP-NUMERIC-UNIQUE         | One normal kind per unique 0..88 number; reserved ranges absent              |
| PROP-MODE-DESTINATION       | Full operation-stream/mode/result cross-product                              |
| PROP-ERROR-NO-MESSAGE-PARSE | Message changes do not affect classification; code/details changes do        |
| PROP-HOSTILE-OUTPUT         | #206 corpus across values, errors, diagnostics, IDs, filenames, and URLs     |
| PROP-ACTION-ATTENTION       | All plan/result/approval/audit states and all five target-coverage classes   |
| PROP-RAW-FAILURE            | Every failure before/after every chunk, cleanup once, no retry               |
| PROP-ATOMIC-FRAMES          | Short/error/unknown writes at every JSON/human/diagnostic byte               |
| PROP-EXTENSION-CLOSED       | Missing, duplicate, invented, inapplicable, or numeric selection is rejected |
| PROP-PARITY                 | Direct REST and composed CLI values/errors/attention/streams agree           |

Required negative probes are CE-EXIT-ZERO-UNKNOWN, CE-HTTP200-ERROR, CE-PARTIAL-ACTION, CE-MISSING-ACTION-TARGET, CE-ACTION-AUTHORITY-DROP, CE-RAW-PROGRESS, CE-RAW-RETRY, CE-EPIPE-STACK, CE-SIGNAL-RACE, CE-HOSTILE-CORRELATION, CE-FEATURE-NUMBER, and CE-ROUTING-MESSAGE-PARSE.

## Downstream obligations

| ID      | Issue | Required consumption/proof                                                                                      |
| ------- | ----: | --------------------------------------------------------------------------------------------------------------- |
| I214-01 |  #214 | Strict algebra, registries, classifiers, safe local envelopes, sinks, and receipt                               |
| I214-02 |  #214 | JSON/human/raw actor, byte counters, terminal precedence, and awaited cleanup                                   |
| I214-03 |  #214 | Every matrix/property branch, hostile input, write failure, and signal race                                     |
| I214-04 |  #214 | Structural bans on direct writes, console, private exits, stack, raw sanitizer, and retry                       |
| I156-01 |  #156 | Routing/label mapping; contract owner must add strict replay/expiry/tamper discriminants                        |
| I157-01 |  #157 | Exact raw bytes, TTY preflight, backpressure, 141/88/130/143, one cleanup                                       |
| I158-01 |  #158 | Every target/certainty/approval/audit retained; exact action precedence; no false exit 0                        |
| I159-01 |  #159 | #214 gate before children; no child-local policy                                                                |
| I191-01 |  #191 | authBlocked attention/85; other accepted status states success/0                                                |
| I192-01 |  #192 | HTTP-200 and non-200 registered sync errors map identically                                                     |
| I193-01 |  #193 | invalid query/cursor 65; empty valid page 0; correct destinations                                               |
| I194-01 |  #194 | unknown message not_found/66; known safe value on stdout                                                        |
| I195-01 |  #195 | unknown thread not_found/66; known empty continuation success/0                                                 |
| I160-01 |  #160 | Success only after verified backup; future conflict must register centrally                                     |
| I161-01 |  #161 | All doctor findings; healthy 0 and degraded/unhealthy 85                                                        |
| I162-01 |  #162 | Agent callers retain stdout domain values and interpret their meaningful nonzero exits                          |
| I163-01 |  #163 | Raw JSONL export bytes; diagnostics stderr; EPIPE 141; other prefix failure 88                                  |
| I164-01 |  #164 | Admin canonical values, destinations, and exits across parity cells                                             |
| I165-01 |  #165 | Complete success/error/client/attention/partial/uncertain/raw parity matrix                                     |
| I166-01 |  #166 | Digest plus implementation/composed/capacity/security/delivery evidence kept distinct                           |
| I169-01 |  #169 | Clean-clone check-only oracle, checked-view, source-inventory, and drift gate                                   |
| I176-01 |  #176 | Full-scale slow/closed sink exactness, bounded memory, backpressure, cleanup, and resource closure              |
| I178-01 |  #178 | Full matrix rerun against frozen release candidate and final registries                                         |
| I183-01 |  #183 | Hostile output, raw separation, stack suppression, malformed errors, bypass attempts                            |
| I184-01 |  #184 | Final review treats omitted/misclassified cells, fake drift, races, and missing composed proof as findings/gaps |
| I185-01 |  #185 | Finding stays open through reproduction, affected gate, counterexample, repair digest, and bounded seam review  |
| I186-01 |  #186 | Executable walkthrough asserts exact outputs/exits and does not flatten domain attention or raw interruption    |

## Checker and authority

Run:

    bun docs/architecture/cli-command-outcome-check.v1.mjs
    bun docs/architecture/cli-command-outcome-check.v1.mjs --self-test

The checker verifies the oracle digest, accepted HEAD, every frozen committed input digest, all ID/reference coverage, exact registry numbers, 13 strict local detail schemas and envelope pairings, all client/shared/operation mappings, 29 applicability rows, 24 operation rows, 24 receipt pairs, the typed domain schemas/selectors, 62 outcome fixtures, 16 projection fixtures, output/runtime matrices, official standards, downstream issue ownership, and every checked-view reference. It reconstructs current registry projections and reports committed-authority versus worktree digest drift separately.

Self-tests must also reject missing/added/mismatched receipt pairs, weakened or mispaired local schemas/envelopes, unknown or precedence-changing domain ASTs, selector-operation drift, incorrect fixture outcomes, projection drift, missing projection fixtures, and incorrect target coverage.
