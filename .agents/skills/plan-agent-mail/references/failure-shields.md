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

