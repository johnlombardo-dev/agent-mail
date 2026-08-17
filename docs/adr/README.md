# Architecture decision records

This index records decisions accepted by the current planning baseline without reproducing PLAN.md. Prototype observations are evidence-only and never current behavior. A record has one status, one owner, a consequence, and a supersession rule. New decisions supersede an old record only by naming its ID and changing the old record to `Superseded` in the same change.

| ID | Decision | Status | Owner |
|---|---|---|---|
| ADR-001 | Keep the domain transport-free and centralize versioned daemon/CLI contracts. | Accepted | `@agent-mail/core`, `@agent-mail/contracts` |
| ADR-002 | Assign persistence capabilities to storage with parsed SQLite boundaries and durable recovery. | Accepted | `@agent-mail/storage` |
| ADR-003 | Model sync lifecycle and cleanup as explicit XState-owned actors and an awaited barrier. | Accepted | `agent-maild` |
| ADR-004 | Treat IMAP as an optional-field external protocol and normalize it at the adapter boundary. | Accepted | `@agent-mail/imap` |
| ADR-005 | Keep remote effects behind frozen, expiring plans and an internal executor capability. | Accepted | `agent-maild`, `@agent-mail/imap` |
| ADR-006 | Expose bounded, schema-driven CLI and HTTP surfaces that sanitize and constrain untrusted mail. | Accepted | `agent-mail`, `agent-maild`, `@agent-mail/contracts` |

Records: [ADR-001](ADR-001.md), [ADR-002](ADR-002.md), [ADR-003](ADR-003.md), [ADR-004](ADR-004.md), [ADR-005](ADR-005.md), [ADR-006](ADR-006.md).
