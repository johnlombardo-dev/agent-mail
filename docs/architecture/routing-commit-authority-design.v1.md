# Routing commit terminal authority v1

Status: specified, not implemented. Issue: #220. Normative oracle SHA-256: `c31919b28e986603b87d5bda14b4f973a850602536f1ea8d0943c5d9af559e2e`.

[routing-commit-authority-oracle.v1.json](routing-commit-authority-oracle.v1.json) is the single normative authority for this corrective seam. This file, the decisions view, and the coverage view are checked projections. The accepted [CLI command outcome oracle](cli-command-outcome-oracle.v1.json) remains the sole authority for numeric exits.

## Outcome

`routing.commit` uses a closed seven-variant `RoutingCommitTerminalDisposition`:

| Disposition         | Public representation                     | HTTP | CLI kind / exit |
| ------------------- | ----------------------------------------- | ---: | --------------- |
| committed           | `committedDecisionSchema` value           |  200 | success / 0     |
| intentional-dry-run | `uncommittedResponseSchema` value         |  200 | success / 0     |
| replayed            | `routing.preview_replayed`, `{previewId}` |  409 | replay / 82     |
| expired             | `routing.preview_expired`, `{previewId}`  |  409 | expired / 81    |
| tampered            | `routing.preview_tampered`, `{previewId}` |  409 | tampered / 83   |
| not-found           | existing `not_found`, `{}`                |  404 | not_found / 66  |
| internal-failure    | existing redacted `internal_error`, `{}`  |  500 | internal / 70   |

The three new failures are operation-scoped registered errors on `routingCommitOperation.errors`. They are not success-value variants and do not enter `httpErrorRegistry`. `routingCommitResponseSchema` remains success-only.

## Domain language

`RoutingCommitTerminalDisposition` is the one final meaning after an admitted request deliberately avoids consumption, consumes a preview, or reaches a typed consumption failure. `IntentionalDryRun` means `request.dryRun=true`, a resolved preview, and zero calls to `consumeRoutingPreview`. `Replay` means a non-dry-run attempt found the one-way consumption receipt already present. `Tamper` means supplied or stored authority failed canonical commitment verification; the public result never names the mismatched field.

The service boundary adds one strict `routing-commit-terminal` variant for replayed, expired, tampered, and not-found. Success still carries a validated response value. Invalid-input, schema, unknown, aggregate, malformed typed terminal, generic failure, and blocked outcomes remain private and project to the existing redacted internal error.

## Source-to-terminal mapping

| Source stage           | Typed signal                            | Dry-run guard | Terminal disposition |
| ---------------------- | --------------------------------------- | ------------- | -------------------- |
| service preview lookup | not-found                               | either        | not-found            |
| service preview lookup | found-and-dry-run                       | true          | intentional-dry-run  |
| storage consume        | result:consumed                         | false         | committed            |
| storage consume        | result:replayed                         | false         | replayed             |
| storage consume        | result:expired                          | false         | expired              |
| storage consume        | error:tampered                          | false         | tampered             |
| storage consume        | error:not-found or error:target         | false         | not-found            |
| storage consume        | error:invalid-input or error:schema     | false         | internal-failure     |
| storage consume        | unknown or aggregate throw              | false         | internal-failure     |
| service invocation     | unregistered failure or blocked outcome | either        | internal-failure     |

Every source case appears exactly once. Only `dryRun=true` can construct the uncommitted success. A replay or expiry returned by storage necessarily came from `dryRun=false` and cannot be rewritten as dry-run.

## Public error authority

The contracts package defines one strict `routingPreviewIdentityErrorDetailsSchema` equivalent to `DETAIL-ROUTING-PREVIEW-IDENTITY`: exactly one `previewId`, no additional property, the existing preview namespace and bounds, and no control characters. The operation owns these exact definitions:

| Code                       | Status | Fixed message                            | Semantic / exit |
| -------------------------- | -----: | ---------------------------------------- | --------------- |
| `routing.preview_replayed` |    409 | routing preview was already consumed     | replay / 82     |
| `routing.preview_expired`  |    409 | routing preview has expired              | expired / 81    |
| `routing.preview_tampered` |    409 | routing preview authority does not match | tampered / 83   |

Their only applicable operation is `routing.commit`. A client must reject each code for `routing.preview`, `messages.label`, and every other operation. Existing `not_found` and `internal_error` remain shared authority with strict empty details. A missing frozen target maps to the coarse not-found result without exposing which target disappeared.

Public details never contain a digest, nonce, rule, rule version, candidate target, stored payload, private reason, cause, or stack. Messages are fixed presentation for the three new definitions and never select semantics. HTTP status alone never selects semantics.

## Layer closure

For committed and intentional dry-run, the service returns the existing strict value, HTTP returns 200, the client returns `CliSuccess`, and the CLI emits the value on stdout with exit 0. Committed exists only after the SQLite transaction and one-way receipt commit. Dry-run performs no routing or receipt write.

For replay, expiry, and tamper, the service terminal is projected through the contracts-owned error definition, HTTP returns a strict 409 envelope, the shared client validates code, status, fixed message, details, and operation applicability, and command outcome maps the registered code to the accepted semantic kind. The feature adapter never supplies a number.

Not-found uses the existing 404 mapping to exit 66. Every unregistered or malformed terminal and every durable or transactional internal failure uses the existing redacted 500 mapping to exit 70. A malformed error envelope at the client remains protocol failure under the accepted CLI authority; it is not a new routing disposition.

## Verification boundary

The oracle requires 14 constructive proofs: direct and real-SQLite composition for each of the seven dispositions. The real composition crosses storage, routing service, Hono, the shared client, and command outcome. Replay closes and reopens SQLite, then proves the first receipt and rows remain authoritative. Expiry, tamper, not-found, and internal failure create no routing write. The internal injection fires after label writes but before commit and proves full rollback.

The checker runs 15 mutation self-tests. It rejects missing, duplicate, overlapping, cross-paired, wrong-operation, message-parsed, unsafe-detail, permissive-detail, dry-run-confused, wrong-status, missing-layer, globally widened, success-nonzero, composition-missing, and base-CLI-drift variants.

## Downstream ownership

`PACKET-LUNA-ROUTING-COMMIT-AUTHORITY` is one bounded Luna/high implementation packet. It owns the routing operation definitions/tests, typed routing handler projection/tests, shared command-outcome mapping/tests, client error tests, and deterministic OpenAPI regeneration. It does not own storage consumption, the generic HTTP transport, the shared global error registry, the shared client, the five accepted CLI authority artifacts, planning files, or the protected #156 candidate.

After that packet is accepted, #156 must re-fetch its exact commit and this oracle. The candidate must replace tamper=internal and replay/expiry=success with tampered/83, replay/82, and expired/81, retain committed and intentional dry-run at success/0, and prove the full seven-row CLI-to-real-HTTP-to-real-SQLite matrix. No command-local code, number, storage reason, exception class, or message parser is permitted.

## Evidence interpretation

A passing checker proves the design oracle, source snapshot, projections, and mutation defenses are internally consistent. It does not prove production conformance. No production TypeScript, test, OpenAPI, planning, Git/GitHub, metric, or #156 candidate file is changed by this design packet. The future regenerated OpenAPI digest is an implementation result and is not invented here.
