# Routing commit terminal authority decisions v1

Status: checked decision view. Normative oracle SHA-256: `c31919b28e986603b87d5bda14b4f973a850602536f1ea8d0943c5d9af559e2e`.

[routing-commit-authority-oracle.v1.json](routing-commit-authority-oracle.v1.json) is normative. This table explains its frozen choices and cannot override it.

| ID  | Frozen decision                                                                                                                       | Reason                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D01 | Use operation-scoped registered errors for replay, expiry, and tamper; keep `routingCommitResponseSchema` success-only.               | These are failed authority attempts, and the existing transport/client/CLI path already validates operation-owned errors.      |
| D02 | Register `routing.preview_replayed`, `routing.preview_expired`, and `routing.preview_tampered` at HTTP 409.                           | Each request conflicts with the current one-use preview authority after authentication and route admission succeeded.          |
| D03 | Expose only strict details `{previewId}` for the three new errors.                                                                    | The request identity is already public and useful for correlation; stored commitment fields and private reasons remain hidden. |
| D04 | Map preview absence and vanished frozen targets to existing `not_found`/404 with empty details.                                       | The existing not-found authority remains stable, and the response does not reveal which frozen target vanished.                |
| D05 | Map invalid-input, schema, unknown, aggregate, malformed typed terminal, failure, and blocked cases to redacted `internal_error`/500. | They indicate service, durable-state, or transaction failure; private reasons are unstable and unsafe public protocol.         |
| D06 | Only `request.dryRun=true` can produce the existing uncommitted success; it never invokes preview consumption.                        | Intentional dry-run stays success/0, while non-dry-run replay and expiry cannot be confused with it.                           |
| D07 | Add one strict routing-commit service terminal variant and map it through contracts-owned definitions.                                | Typed dispositions remove private reason strings from classification without changing generic HTTP projection.                 |
| D08 | Keep issue #213 as the sole numeric authority; add only replay/82, expired/81, and tampered/83 code mappings.                         | The correction needs no new semantic kind or process-exit policy.                                                              |
| D09 | Do not add the routing errors to `httpErrorRegistry` or accept them for another operation.                                            | These failures belong only to `routing.commit`; global registration would silently widen client and OpenAPI applicability.     |
| D10 | Treat this checker as design evidence only; require direct and real-SQLite composed proofs before #156 resumes.                       | A self-consistent oracle cannot prove runtime projection, rollback, OpenAPI, client, or CLI behavior.                          |

## Rejected alternatives

- Strict success-value discriminants: they would widen the response union, retain HTTP 200 for failed authority, and create a second CLI classification path.
- Shared global routing errors: they would be accepted for unrelated operations and contradict operation-owned applicability.
- Status-only or message-based classification: several meanings share 409, and presentation text is not a machine protocol.
- Public storage reasons or commitment details: they are unstable implementation data and expose more authority state than the caller needs.
- A new CLI exit table: issue #213 already fixes all required semantic/exit pairs.

No consequential product choice remains for #220.
