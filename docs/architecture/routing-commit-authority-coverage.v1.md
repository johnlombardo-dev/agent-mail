# Routing commit terminal authority coverage v1

Status: specified design; production conformance unverified. Normative oracle SHA-256: `c31919b28e986603b87d5bda14b4f973a850602536f1ea8d0943c5d9af559e2e`.

[routing-commit-authority-oracle.v1.json](routing-commit-authority-oracle.v1.json) is normative. This checked view inventories its closure, tests, handoff, and evidence limits.

## Requirement traceability

| Requirement       | Closed by decisions | Constructive evidence IDs                                                                                                                                       | Mutation IDs                                                               |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| REQ-ALGEBRA       | D01 D04 D05 D06     | PROOF-DIRECT-COMMITTED, PROOF-DIRECT-DRY-RUN, PROOF-DIRECT-REPLAYED, PROOF-DIRECT-EXPIRED, PROOF-DIRECT-TAMPERED, PROOF-DIRECT-NOT-FOUND, PROOF-DIRECT-INTERNAL | MUT-MISSING-DISPOSITION, MUT-DUPLICATE-DISPOSITION, MUT-OVERLAPPING-SOURCE |
| REQ-PUBLIC        | D01 D02 D03 D04 D05 | PROOF-DIRECT-REPLAYED, PROOF-DIRECT-EXPIRED, PROOF-DIRECT-TAMPERED, PROOF-DIRECT-NOT-FOUND, PROOF-DIRECT-INTERNAL                                               | MUT-CROSS-PAIRED-CODE, MUT-WRONG-STATUS, MUT-MISSING-LAYER                 |
| REQ-DRY-RUN       | D06 D08             | PROOF-DIRECT-DRY-RUN, PROOF-SQLITE-DRY-RUN, PROOF-SQLITE-REPLAYED, PROOF-SQLITE-EXPIRED                                                                         | MUT-DRY-RUN-CONFUSION, MUT-SUCCESS-NONZERO                                 |
| REQ-SAFE          | D03 D04 D05         | PROOF-SQLITE-TAMPERED, PROOF-SQLITE-NOT-FOUND, PROOF-SQLITE-INTERNAL                                                                                            | MUT-UNSAFE-DETAIL, MUT-PERMISSIVE-DETAILS                                  |
| REQ-APPLICABILITY | D09                 | PROOF-DIRECT-REPLAYED, PROOF-DIRECT-EXPIRED, PROOF-DIRECT-TAMPERED                                                                                              | MUT-WRONG-OPERATION, MUT-GLOBAL-WIDENING                                   |
| REQ-CLI           | D07 D08             | PROOF-DIRECT-REPLAYED, PROOF-DIRECT-EXPIRED, PROOF-DIRECT-TAMPERED, PROOF-DIRECT-NOT-FOUND, PROOF-DIRECT-INTERNAL                                               | MUT-MESSAGE-PARSED, MUT-CROSS-PAIRED-CODE, MUT-BASE-CLI-DRIFT              |
| REQ-COMPOSITION   | D10                 | PROOF-SQLITE-COMMITTED, PROOF-SQLITE-DRY-RUN, PROOF-SQLITE-REPLAYED, PROOF-SQLITE-EXPIRED, PROOF-SQLITE-TAMPERED, PROOF-SQLITE-NOT-FOUND, PROOF-SQLITE-INTERNAL | MUT-MISSING-COMPOSITION                                                    |
| REQ-HANDOFF       | D10                 | PROOF-DIRECT-COMMITTED, PROOF-SQLITE-COMMITTED                                                                                                                  | MUT-MISSING-LAYER                                                          |

## Exact disposition matrix

| Disposition         | Request guard | Storage source                                      | Service terminal              | HTTP authority                                  | Client       | CLI            |
| ------------------- | ------------- | --------------------------------------------------- | ----------------------------- | ----------------------------------------------- | ------------ | -------------- |
| committed           | dryRun=false  | result:consumed                                     | success committed value       | 200 `committedDecisionSchema`                   | `CliSuccess` | success / 0    |
| intentional-dry-run | dryRun=true   | preview found; consumption not invoked              | success uncommitted value     | 200 `uncommittedResponseSchema`                 | `CliSuccess` | success / 0    |
| replayed            | dryRun=false  | result:replayed                                     | terminal replayed + previewId | 409 `routing.preview_replayed` + strict details | `http_error` | replay / 82    |
| expired             | dryRun=false  | result:expired                                      | terminal expired + previewId  | 409 `routing.preview_expired` + strict details  | `http_error` | expired / 81   |
| tampered            | dryRun=false  | error:tampered                                      | terminal tampered + previewId | 409 `routing.preview_tampered` + strict details | `http_error` | tampered / 83  |
| not-found           | either        | preview absent or error:not-found/error:target      | terminal not-found            | 404 shared `not_found` + `{}`                   | `http_error` | not_found / 66 |
| internal-failure    | either        | invalid-input/schema/unknown/aggregate/private fail | private failure               | 500 shared `internal_error` + `{}`              | `http_error` | internal / 70  |

## Source coverage

All source IDs are required and unique:

- SOURCE-PREVIEW-MISSING, SOURCE-DRY-RUN, SOURCE-CONSUMED, SOURCE-REPLAYED, SOURCE-EXPIRED
- SOURCE-TAMPERED, SOURCE-PREVIEW-NOT-FOUND, SOURCE-TARGET-NOT-FOUND
- SOURCE-INVALID-INTERNAL, SOURCE-SCHEMA-INTERNAL, SOURCE-UNKNOWN-INTERNAL, SOURCE-SERVICE-INTERNAL

The storage reason `target` intentionally shares the public not-found disposition and exposes no target identity. `invalid-input` is internal because boundary-controlled request fields have already passed the shared request schema; a later invalid input is a service/composition defect, not a second 400 policy.

## Constructive proof inventory

There are 14 rows, exactly two per disposition:

| Disposition         | Direct proof           | Real-SQLite proof      | Observable postcondition                                                                            |
| ------------------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| committed           | PROOF-DIRECT-COMMITTED | PROOF-SQLITE-COMMITTED | One receipt and exact rows exist before success/0.                                                  |
| intentional-dry-run | PROOF-DIRECT-DRY-RUN   | PROOF-SQLITE-DRY-RUN   | Consumption call count and all routing-write counts are zero; success/0.                            |
| replayed            | PROOF-DIRECT-REPLAYED  | PROOF-SQLITE-REPLAYED  | After close/reopen, the first receipt and rows are unchanged; registered 409 and replay/82.         |
| expired             | PROOF-DIRECT-EXPIRED   | PROOF-SQLITE-EXPIRED   | Equality and after-expiry cases write nothing; registered 409 and expired/81.                       |
| tampered            | PROOF-DIRECT-TAMPERED  | PROOF-SQLITE-TAMPERED  | Each authority mutation writes nothing and reveals only previewId; registered 409 and tampered/83.  |
| not-found           | PROOF-DIRECT-NOT-FOUND | PROOF-SQLITE-NOT-FOUND | Missing preview and target cases write nothing and expose no target; existing 404 and not_found/66. |
| internal-failure    | PROOF-DIRECT-INTERNAL  | PROOF-SQLITE-INTERNAL  | Post-label injected failure rolls back; redacted 500 has empty details and exits internal/70.       |

Direct fixtures cannot substitute for the real-SQLite rows. Real-SQLite composition crosses storage, service, Hono, the shared client, and command outcome. It must inspect durable rows and CLI result/exit, not only mock call counts.

## Mutation inventory

The checker self-test must reject all 15 IDs:

- MUT-MISSING-DISPOSITION, MUT-DUPLICATE-DISPOSITION, MUT-OVERLAPPING-SOURCE
- MUT-CROSS-PAIRED-CODE, MUT-WRONG-OPERATION, MUT-MESSAGE-PARSED
- MUT-UNSAFE-DETAIL, MUT-DRY-RUN-CONFUSION, MUT-WRONG-STATUS
- MUT-PERMISSIVE-DETAILS, MUT-MISSING-LAYER, MUT-GLOBAL-WIDENING
- MUT-SUCCESS-NONZERO, MUT-MISSING-COMPOSITION, MUT-BASE-CLI-DRIFT

## Planning-shield routing

| Shield | Status         | Routing                                                                                                      |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------------ |
| S01    | required       | Live issue states, accepted commits, repository head, CLI oracle digest, and exact source hashes are frozen. |
| S02    | required       | Storage, service, HTTP, client, CLI, durable-write, and trust seams are mapped.                              |
| S03    | required       | Values and strict errors are traced across every transformation.                                             |
| S04    | not-applicable | No external effect exists; routing writes and receipt share one SQLite transaction.                          |
| S05    | required       | The closed terminal algebra replaces implicit booleans and reason strings.                                   |
| S06    | not-applicable | Full backup/restore is outside this correction; reopen replay remains a composed proof.                      |
| S07    | required       | Direct/real-SQLite and storage/HTTP/client/CLI parity are explicit.                                          |
| S08    | required       | Each service fixture has a real SQLite counterpart.                                                          |
| S09    | not-applicable | The correction adds bounded constant-size envelopes and no growing collection or stream.                     |
| S10    | required       | Tamper, applicability, and safe details are trust boundaries.                                                |
| S11    | required       | Stable exits remove user and agent text inference.                                                           |
| S12    | required       | Design, production, composed, security, deployed, and delivery evidence remain separate.                     |

## Frozen input summary

The oracle pins accepted repository head `fc321ceba7cacf09f892e46363880625c2db9b8b`, PLAN SHA-256 `3f80537d53e1c06b6434d94a1ae0bc689c19275046787a9de216f7d93ff21f56`, EVIDENCE SHA-256 `07845a1ed7e79e484e2c3ea35a4ce060a9e5cb5d564e8da2982cddc788b45eaf`, current OpenAPI SHA-256 `ff9c2286e461c0402857e51f727d1fc36ae7f4cb0037308de76ba4ef7e4483ac`, and CLI oracle SHA-256 `d0f569cbb3364bebbf3e02ef33b69997a05b4bf6d5dd9485cf386e8ab7768c6d`. Every storage, handler, contracts, HTTP, OpenAPI, client, command-outcome, and named test source used by the decision is individually pinned in the oracle.

The protected #156 candidate hashes are `6d1874648291d2cb73ce4190e698691ec44d76bc209f5075dc13b1aecd1d5363` for `routing-commands.ts` and `4e1e201202c6c54f76bdd18b74a3be288a0d8cead2f73caadb50ac2674d2f49a` for `routing-commands.test.ts`. The design packet does not modify them.

## Downstream packet

`PACKET-LUNA-ROUTING-COMMIT-AUTHORITY` owns the bounded production closure. Its exact mutation list is routing operation definitions/tests, routing handler/tests, shared command-outcome mapping/tests, client error tests, and generated `docs/openapi.json`; `packages/daemon/test/http-authority-p6-c10a.test.ts` is conditional only if the deterministic OpenAPI assertions require it.

It must keep storage consumption, generic HTTP, the shared global error registry, OpenAPI generator, shared client, planning pack, accepted CLI architecture artifacts, and #156 candidate protected. OpenAPI remains 25 paths, adds exactly three operation detail schemas, is generated twice byte-identically, and reports its new digest rather than guessing it here.

## #156 redispatch

- REDISPATCH-156-DEPENDENCY: resume only after the bounded implementation is accepted and pinned.
- REDISPATCH-156-PRESERVE: preserve candidate bytes until redispatch, then re-fetch #213, #214, #220, and the implementation.
- REDISPATCH-156-MATRIX: replace tamper=internal and replay/expiry=success with tampered/83, replay/82, expired/81; preserve the two success/0 variants.
- REDISPATCH-156-PARITY: run the seven-row CLI-to-real-HTTP-to-real-SQLite matrix and never claim committed on failure.
- REDISPATCH-156-NO-PRIVATE-POLICY: add no private code, number, storage reason, exception classifier, or message parser.

## Evidence gaps and qualification

No unresolved #220 product choice remains. The authority is ready for the bounded implementation packet, not yet implemented. Real direct/composed tests, regenerated OpenAPI, full static/test gates, complete security review, live behavior, deployed operations, and delivery are unverified. PLAN.md and EVIDENCE.md also retain historical #203 status text; #220 protects those files, so this packet records but does not repair that planning drift.
