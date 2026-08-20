# Agent Mail system context

Status: accepted planning context. This document records boundaries and ownership; the implementation and its evidence remain governed by [PLAN.md](PLAN.md) and [planning evidence](docs/planning/EVIDENCE.md).

## Purpose and operating posture

Agent Mail is a local-first archive and operator tool for one iCloud account. It preserves raw mail and attachments, indexes normalized metadata locally, and exposes search, reporting, export, labeling, routing, and tightly controlled remote actions. Common workflows use safe defaults; destructive or remote effects require an explicit, reviewable confirmation.

Email, filenames, links, rendered text, and all external boundary values are untrusted. Search precedes full-body retrieval. Unread state is preserved. There is no delete-and-expunge path.

## Trust boundaries

| Boundary                            | Rule                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IMAP provider                       | Treat capabilities, status, MIME, flags, UIDs, and errors as optional or hostile protocol data. Normalize at the adapter; never log credentials or raw bodies routinely.                                                 |
| Local filesystem                    | Private roots, blobs, journals, backups, secrets, and configuration are validated and permission-checked. Digest, size, atomic promotion, and restore verification establish content integrity; path existence does not. |
| HTTP clients and proxies            | Authenticate API operations with bearer credentials. Validate `unknown` requests and responses through versioned contracts; proxy identity is trusted only when its provenance is verified.                              |
| CLI stdout and downstream consumers | Output is an untrusted, potentially slow sink. Use stable schemas, bounded streaming, backpressure, and no accidental secret or raw-mail disclosure.                                                                     |
| Rendered mail and reports           | Stored message content is untrusted markup. Sanitize it, apply a strict CSP, and keep source views text-only; no client JavaScript.                                                                                      |

## Package ownership

These are the six implementation package owners named by PLAN.md. The separate `.agents/skills/agent-mail` operator skill is not counted as an implementation package owner.

| Owner                   | Owns                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@agent-mail/core`      | Transport-free domain types, invariants, state-specific action algebra, and use-case ports.                            |
| `@agent-mail/contracts` | Versioned Zod/OpenAPI requests, responses, errors, cursors, stream metadata, and CLI mapping.                          |
| `@agent-mail/storage`   | SQLite migrations and capability catalogs for messages, sync, routing, actions, reports, export, backup, and blobs.    |
| `@agent-mail/imap`      | ImapFlow capability discovery, mailbox/status normalization, streaming fetch, IDLE, and remote-action reconciliation.  |
| `agent-maild`           | XState workflow, dependency wiring, loopback REST/report servers, configuration, credentials, and operations commands. |
| `agent-mail`            | Thin schema-driven CLI with bounded streaming and stable machine-readable output.                                      |

## Decision vocabulary

`Accepted` means the current planning decision. `Deferred` means deliberately out of the current planning baseline. `Evidence-only` means an observed prior implementation or comparison input, not a current implementation claim. Implementation, live, security, deployed, and delivery statuses require the evidence named by PLAN.md; this context does not upgrade them.

See the [ADR index](docs/adr/README.md) for the compact decision records and their supersession rule.
