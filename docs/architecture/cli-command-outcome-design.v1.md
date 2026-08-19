# CLI command outcomes v1

Status: specified, not implemented. Normative oracle SHA-256: d0f569cbb3364bebbf3e02ef33b69997a05b4bf6d5dd9485cf386e8ab7768c6d.

[cli-command-outcome-oracle.v1.json](cli-command-outcome-oracle.v1.json) is the single normative authority. This file, the decisions view, and the coverage view are checked projections. If prose conflicts with the JSON, the JSON wins.

## Outcome

Every command crosses one shared boundary in this order:

1. The parser resolves a command, output mode, and request from unknown input.
2. The shared client validates the operation response or registered public error.
3. A feature adapter supplies a strict value, raw stream, or failure result. It selects a registered semantic kind, never a number.
4. The shared executor revalidates the selection, applies deterministic domain rules, emits through owned sinks, awaits cleanup when required, and returns an immutable receipt.
5. The outer process adapter obtains the one numeric exit from the central registry.

The result algebra is process-agnostic. Its three variants forbid exitCode, stdout, stderr, process, stack, and cause fields. A value contains validated operation data, at least one branded human line, diagnostics, and one allowed semantic kind. A raw result contains only the byte stream, diagnostics, and success. A failure contains one exact safe error envelope and a registered failure kind. ErrorEnvelopeV1 is a closed union of the 13 exact local code/message/detail variants and the validated registered-server variant.

Unknown keys, an unknown kind, a kind that is not applicable to the operation, a caller-supplied number, an envelope-like value with invalid code/details, or disagreement with a deterministic classifier is cli.protocol and exit 76. None can fall through to success.

## Exit registry

The registry is one-to-one. Several concrete client or public errors intentionally share a semantic kind and therefore share its number. No feature owns an alias table.

| Semantic kind  | Symbol               | Exit | Meaning                                                      |
| -------------- | -------------------- | ---: | ------------------------------------------------------------ |
| success        | EX_OK                |    0 | Complete requested outcome was emitted                       |
| usage          | EX_USAGE             |   64 | Invalid syntax, flag/mode combination, or raw TTY policy     |
| invalid_input  | EX_DATAERR           |   65 | Invalid shared request data                                  |
| not_found      | EX_NOINPUT           |   66 | Requested public identity is absent                          |
| unavailable    | EX_UNAVAILABLE       |   69 | Service, transport, or secure facility is unavailable        |
| internal       | EX_SOFTWARE          |   70 | CLI or server software invariant failed                      |
| io             | EX_IOERR             |   74 | A sink failed before any output byte was accepted            |
| temporary      | EX_TEMPFAIL          |   75 | Timeout or capacity condition may succeed later              |
| protocol       | EX_PROTOCOL          |   76 | CLI/service contract is malformed or impossible              |
| authorization  | EX_NOPERM            |   77 | Credentials, scope, or approval authority is insufficient    |
| configuration  | EX_CONFIG            |   78 | Local configuration is missing or invalid                    |
| conflict       | AM_EX_CONFLICT       |   79 | Requested transition conflicts with current state            |
| stale          | AM_EX_STALE          |   80 | Version or frozen authority is stale/invalidated             |
| expired        | AM_EX_EXPIRED        |   81 | Plan, preview, challenge, or approval expired                |
| replay         | AM_EX_REPLAY         |   82 | One-use authority was consumed or replayed                   |
| tampered       | AM_EX_TAMPERED       |   83 | Digest, assertion, target, nonce, or authority mismatched    |
| cancelled      | AM_EX_CANCELLED      |   84 | Non-signal caller/domain cancellation                        |
| attention      | AM_EX_ATTENTION      |   85 | Complete validated value requires attention                  |
| partial        | AM_EX_PARTIAL        |   86 | Domain operation has a mixed or explicit partial result      |
| uncertain      | AM_EX_UNCERTAIN      |   87 | A remote-effect postcondition is uncertain                   |
| partial_output | AM_EX_PARTIAL_OUTPUT |   88 | Non-EPIPE failure followed an accepted/unknown output prefix |

Statuses 124 through 127 are never emitted by Agent Mail. Normal outcomes never use 128 through 255. Signal conventions are SIGINT 130, EPIPE/SIGPIPE 141, and SIGTERM 143. The process adapter accepts only 0 through 255.

## Modes and destinations

Operations with streaming none default to human and allow JSON/human modes. Byte-stream operations default to raw and allow raw only. Exactly one recognized explicit context is retained for later validation errors. Before a command/context resolves, or when context selections conflict, errors use human output; a conflict is cli.usage with reason output-context-conflict. An operation mismatch is reported in the selected context as cli.usage/mode-not-supported and stops before configuration, client construction, or network execution. There is no implicit byte encoding or path from raw bytes through the human renderer.

| Context | Valid value                                                                     | Failure before output                                                                          | Nonzero domain value                                      |
| ------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| JSON    | JSON.stringify(validated data) plus exactly one LF on stdout                    | ErrorEnvelopeV1 in code, message, correlationId, details order plus LF on stderr; stdout empty | Full value remains on stdout; central nonzero exit        |
| Human   | Branded human lines on stdout with shared sanitization and exactly one final LF | One safe error line on stderr; stdout empty                                                    | Full human result remains on stdout; central nonzero exit |
| Raw     | Exact stream bytes on stdout; no appended byte                                  | One ErrorEnvelopeV1 JSON line on stderr; stdout empty                                          | Raw has no domain-attention value variant                 |

Diagnostics are opt-in. JSON and raw use DiagnosticV1 JSONL on stderr. Human diagnostics use branded safe lines on stderr. Metadata diagnostics required before a raw stream must complete before the first raw byte. Progress output does not exist. Writes are serialized per sink, complete frames are encoded before their first write, and cross-sink observation order is otherwise unspecified.

JSON preserves schema semantics and never receives terminal escaping. Human values always pass through the accepted output-context brands and renderer. Raw bytes are neither decoded nor sanitized.

## Error classification

The classifier first recognizes a strict operation-scoped or shared PublicErrorEnvelope. This precedence also applies when a success-status response union contains an error envelope. HTTP 200 never forces exit 0.

Shared and operation errors map by registered code and typed details. HTTP status alone does not choose a kind, and message text is never parsed. Unknown code, status mismatch, fixed-message mismatch, or invalid details becomes client contract/protocol exit 76.

The seven accepted client kinds are closed:

| CliClientError kind   | Local/public source             | Semantic kind       |     Exit |
| --------------------- | ------------------------------- | ------------------- | -------: |
| connect_timeout       | cli.connect-timeout             | temporary           |       75 |
| control_timeout       | cli.control-timeout             | temporary           |       75 |
| stream_idle_timeout   | cli.stream-idle-timeout         | temporary           |       75 |
| client_contract_error | cli.protocol                    | protocol            |       76 |
| http_error            | registered public error mapping | code/details decide | registry |
| aborted               | cli.cancelled                   | cancelled           |       84 |
| transport_error       | cli.transport                   | unavailable         |       69 |

The coverage view contains the constructive 26-row shared mapping, nine operation-code mappings, and all 29 operation applicability rows.

## HTTP-200 domain values

A validated domain value remains a value. Nonzero attention describes its meaning; it does not turn the value into a transport error.

Action inspect/commit use this precedence:

1. Any uncertain plan/result, uncertain terminal audit, or unknown-after-restore disposition is uncertain 87.
2. An explicit partial plan/audit or mixed success/non-success results is partial 86.
3. Exact one-result-per-frozen-target coverage with all stale results, or an invalidated inspect approval, is stale 80.
4. An expired plan, terminal audit, or inspect approval is expired 81.
5. A cancelled inspect approval is cancelled 84.
6. Inspect of a pending plan with no results, absent terminal audit, and absent/available approval is success 0.
7. Inspect of a completed plan is success only with exactly one success per frozen target, consumed approval, and a completed/started terminal audit.
8. Commit of a completed plan is success only with exactly one success per frozen target and a consumption receipt.
9. Every remaining combination, including executing, failed, rejected, restore-quarantined, never-started-after-restore, missing/duplicate/unexpected target coverage, or another non-success result, is attention 85.

This prevents incomplete target, approval, terminal-audit, or certainty evidence from disappearing behind exit 0.

The oracle encodes these rules as a typed recursive expression schema, typed projection schema, seven operation selectors, and first-match rule arrays. The stale rule is structurally `any(all(targetCoverage == exact, allResultsStale == true), approvalState == invalidated)`; there is no prose operator precedence to interpret. Eight fixture bases, 62 outcome fixtures, and 16 projection fixtures constructively exercise every rule, overlap, projection branch, target-coverage class, result kind, selector, and deliberate no-match protocol fallback. Registered errors are first in every selector.

Doctor healthy is success. Doctor degraded or unhealthy is attention 85 with every finding preserved. Sync authBlocked is attention 85; every other validated status state is success. Routing committed and explicit dry-run values are success. Label committed and dry-run values are success; a validated non-dry-run uncommitted label is attention 85.

Routing preview/commit currently expose no strict public replay, expiry, or tamper discriminants. The CLI must not parse storage exceptions or messages and must not invent private error codes. The contract/route owner must register those discriminants before issue #156 can select replay 82, expired 81, or tampered 83.

## Emission and termination protocol

One CliCommandEmissionV1 actor owns the AbortController, stdout/stderr sinks, separate accepted-byte counters, terminal-cause latch, and memoized cleanup promise. Its active states are validating, rendering, emitting, cancelling, cleaning, reporting, and settled.

ExecutionReceiptV1 admits only the 21 registered semantic-kind/normal-exit pairs plus cancelled/130, partial_output/141, and cancelled/143. Its JSON Schema uses 24 exact pair branches, so independent semantic and numeric enums cannot create invalid cross-products.

- A proven zero-byte sink failure before any output is io 74. A client error before output retains its mapped kind. A pre-output render/cleanup invariant is internal 70.
- Any non-EPIPE failure after either sink accepted a byte, or after a started write with unknown acceptance, is partial_output 88. Accepted prefixes remain observable. No command, remote operation, frame, or stream prefix is retried.
- EPIPE from either owned sink cancels upstream, awaits the same cleanup once, emits nothing further, and settles 141 regardless of accepted-byte count.
- SIGINT and SIGTERM only latch the event and request abort in the signal handler. Normal async execution awaits cleanup once, emits nothing further, and settles 130 or 143.
- The first SIGINT or SIGTERM outranks every non-signal cause. EPIPE outranks other non-signal failures but not a signal. Cleanup failure cannot replace a latched signal or EPIPE.

Raw streaming performs TTY and requested-diagnostic preflight before any stream byte, awaits backpressure, and never mixes metadata, progress, diagnostics, or an added LF into stdout.

## Safety boundary

Server correlation IDs survive exactly after shared validation. Locally synthesized errors use one injected invocation correlation ID. Human presentation makes correlation IDs and all other untrusted values inert without changing their structured value.

Local errors have registered fixed messages and 13 machine-readable, bounded, strict detail schemas. Each local envelope branch fixes its code and message and references exactly one detail schema; the registry fixes the corresponding semantic kind. Unknown, extra, recursive, and dangerous detail keys are rejected. Public output never includes stack, cause, credentials, raw mail, arbitrary Error.message, inspected exception objects, or recursive sink errors. Error JSON has exactly code, message, correlationId, and details.

Feature adapters may submit only version 1, operationKey, and semanticKind selection. The shared module checks the central registry, operation value policy, mode compatibility, and deterministic classifier. Adapters cannot provide a number, destination, sink, process stream, renderer, or private error map. Reusing an existing kind requires a registered applicable mapping and proof. A new kind, meaning, or number requires oracle v2 and a migration note.

## Standards and authority

Exit behavior is grounded in the [POSIX shell command language](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html), [Apple sysexits](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/sysexits.3.html), [Apple exit](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/exit.3.html), and [Apple sigaction](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/sigaction.2.html).

The oracle pins accepted HEAD 778e01b16cbdbe8917975c85818eaff967dc0a7f and the exact source digests used to reconstruct operations, errors, client kinds, output contexts, thread behavior, planning obligations, and parity seams. The checker verifies those committed blobs, reconstructs all registries, evaluates every domain and projection fixture, probes strict local envelopes and exact receipt pairs positively and negatively, checks every view reference, and separately reports later worktree drift.
