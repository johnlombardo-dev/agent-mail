# Thread design coverage v1

Status: checked coverage view. Normative oracle SHA-256: `e24efd672113aa5743ef776c3c3add502eea509512cc0573febc7b1d3b1ea269`.

The oracle contains 13 requirements, 18 decisions, 19 generated examples, 11 property obligations, 10 downstream implementation obligations, and 3 upstream contradictions. The checker requires every requirement to map to valid decision, example, property, and obligation IDs.

## Requirement closure

| Requirement         | Decisions                  | Generated examples                                                                                                                                     | Properties                                             | Downstream obligations                                           |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `REQ-NORMALIZATION` | `D02`, `D15`               | `EX-MALFORMED-ADVERSARIAL`, `EX-DUPLICATE-HEADER-OCCURRENCE`, `EX-OVERSIZED-REFERENCES`                                                                | `PROP-BOUNDED-NORMALIZATION`                           | `I137-01`                                                        |
| `REQ-IDENTITY`      | `D01`, `D05`               | `EX-LATE-ROOT`, `EX-ROOTLESS-CYCLE`                                                                                                                    | `PROP-INGESTION-ORDER`                                 | `I137-01`                                                        |
| `REQ-MEMBERSHIP`    | `D03`, `D04`, `D05`        | `EX-TWO-MESSAGE-REPLY`, `EX-BRANCHED-REPLIES`, `EX-MISSING-HEADERS`, `EX-IDENTITY-ONLY-RECOVERY`, `EX-DUPLICATE-MESSAGE-ID`, `EX-CROSS-MAILBOX-COPIES` | `PROP-INGESTION-ORDER`, `PROP-CROSS-MAILBOX-DUPLICATE` | `I137-01`                                                        |
| `REQ-MERGE-ALIAS`   | `D06`, `D07`, `D08`        | `EX-LATE-BRIDGE-MERGE`                                                                                                                                 | `PROP-STABLE-ALIASES`                                  | `I137-01`, `I137-03`                                             |
| `REQ-ORDER`         | `D09`                      | `EX-EQUAL-TIMESTAMPS`                                                                                                                                  | `PROP-DETERMINISTIC-ORDER`                             | `I137-03`, `I195-02`                                             |
| `REQ-PAGINATION`    | `D10`, `D16`               | `EX-LIVE-PAGINATION-LATE-ARRIVAL`, `EX-LIVE-PAGINATION-IDENTITY-RECOVERY-EMPTY`                                                                        | `PROP-LIVE-CURSOR`                                     | `I198-01`, `I199-01`, `I137-02`, `I137-03`, `I195-02`            |
| `REQ-BOUNDS`        | `D08`, `D10`, `D14`        | `EX-OVERSIZED-REFERENCES`                                                                                                                              | `PROP-BOUNDED-NORMALIZATION`, `PROP-BOUNDED-STORAGE`   | `I137-01`, `I137-04`                                             |
| `REQ-RESTART`       | `D06`, `D13`               | `EX-IDENTITY-ONLY-RECOVERY`, `EX-RESTART-IDEMPOTENCY`                                                                                                  | `PROP-IDEMPOTENCY`, `PROP-RESTART-RESTORE`             | `I137-04`                                                        |
| `REQ-TOMBSTONE`     | `D11`                      | `EX-TOMBSTONED-MEMBER`                                                                                                                                 | `PROP-TOMBSTONE`                                       | `I137-04`, `I195-04`                                             |
| `REQ-RECOVERY`      | `D13`                      | `EX-BACKUP-RESTORE`                                                                                                                                    | `PROP-RESTART-RESTORE`                                 | `I137-04`                                                        |
| `REQ-PUBLIC`        | `D11`, `D12`, `D16`, `D18` | `EX-TOMBSTONED-MEMBER`, `EX-UNKNOWN-THREAD`, `EX-LIVE-PAGINATION-IDENTITY-RECOVERY-EMPTY`                                                              | `PROP-LIVE-CURSOR`, `PROP-NOT-FOUND`                   | `I198-01`, `I199-01`, `I137-02`, `I137-03`, `I195-02`, `I195-03` |
| `REQ-UNTRUSTED`     | `D02`, `D15`               | `EX-MALFORMED-ADVERSARIAL`                                                                                                                             | `PROP-BOUNDED-NORMALIZATION`                           | `I137-01`, `I137-03`                                             |
| `REQ-DOWNSTREAM`    | `D16`, `D17`, `D18`        | `EX-UNKNOWN-THREAD`, `EX-LIVE-PAGINATION-IDENTITY-RECOVERY-EMPTY`                                                                                      | `PROP-LIVE-CURSOR`, `PROP-NOT-FOUND`                   | all `I198-*`, `I199-*`, `I137-*`, `I195-*`                       |

## Required example inventory

| Required case             | Oracle example                               | Decisive expectation                                                                                       |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| two-message reply         | `EX-TWO-MESSAGE-REPLY`                       | one root-derived component; oldest-first order                                                             |
| branched replies          | `EX-BRANCHED-REPLIES`                        | four members; one RFC ancestry component                                                                   |
| missing headers           | `EX-MISSING-HEADERS`                         | content fallback singleton or IRT-linked fallback                                                          |
| malformed/adversarial IDs | `EX-MALFORMED-ADVERSARIAL`                   | no partial edge; safe diagnostics only                                                                     |
| duplicate Message-ID      | `EX-DUPLICATE-MESSAGE-ID`                    | two canonical members on one normalized node                                                               |
| cross-mailbox copies      | `EX-CROSS-MAILBOX-COPIES`                    | one member; placement order cannot affect thread order                                                     |
| late root                 | `EX-LATE-ROOT`                               | virtual root pre-exists; canonical handle unchanged                                                        |
| late bridge merge         | `EX-LATE-BRIDGE-MERGE`                       | one component; losing handle aliases forward                                                               |
| tombstoned member         | `EX-TOMBSTONED-MEMBER`                       | retained direct member; absent from default search                                                         |
| equal timestamps          | `EX-EQUAL-TIMESTAMPS`                        | message identity breaks the normalized-instant tie                                                         |
| restart                   | `EX-RESTART-IDEMPOTENCY`                     | exact snapshot; replay does not advance generation                                                         |
| backup/restore            | `EX-BACKUP-RESTORE`                          | handles, aliases, order, and absence outcome match                                                         |
| unknown thread            | `EX-UNKNOWN-THREAD`                          | storage absence, HTTP 404, shared error, nonzero CLI                                                       |
| live recovery exhaustion  | `EX-LIVE-PAGINATION-IDENTITY-RECOVERY-EMPTY` | known nonempty thread; valid 200 continuation with empty arrays, complete aggregates, and null next cursor |

Additional examples cover identity-only recovery, duplicate header occurrences, live pagination under late arrivals and recovery exhaustion, oversized References, and a rootless adversarial cycle.

## Property corpus

| Property                       | Proof boundary                                                             |
| ------------------------------ | -------------------------------------------------------------------------- |
| `PROP-INGESTION-ORDER`         | permutations compare public-normalized graph snapshots                     |
| `PROP-IDEMPOTENCY`             | replay before/after reopen is byte-unchanged                               |
| `PROP-STABLE-ALIASES`          | every retained handle resolves after bridges/restart/restore               |
| `PROP-DETERMINISTIC-ORDER`     | valid/equal/offset/null/invalid time matrix                                |
| `PROP-LIVE-CURSOR`             | older/equal/newer arrival, recovery exhaustion, and merge between pages    |
| `PROP-BOUNDED-NORMALIZATION`   | byte/token/comment boundaries and Unicode fuzz                             |
| `PROP-BOUNDED-STORAGE`         | union-by-weight large/skewed merges plus query plans                       |
| `PROP-RESTART-RESTORE`         | failure injection and full restored domain parity                          |
| `PROP-TOMBSTONE`               | placement visibility changes without graph change                          |
| `PROP-NOT-FOUND`               | unknown 404 versus nonempty initial versus empty known continuation matrix |
| `PROP-CROSS-MAILBOX-DUPLICATE` | placement dedup and distinct canonical duplicate claimants                 |

## Downstream acceptance matrix

| Surface               | Must own                                                                                                                                                                                                                            | Must not own                                                                                                  | Required evidence                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| #198 shared contracts | Structurally zero-length matching arrays, positive `messageCount`, and one shared request/success validator that requires a nonempty cursorless success and permits empty arrays only for a supplied cursor with `nextCursor:null`. | Resource lookup, storage assembly, or treating every structural empty response as valid for every request.    | Exact positive empty-continuation fixture; negative empty-initial and empty-with-next-cursor fixtures; operation/OpenAPI/CLI registry parity. |
| #199 storage          | Migrations, graph transaction, handle-first resolution, initial/continuation query, complete aggregates on an empty continuation, hydration, and placeholder replacement.                                                           | Transport, CLI, or redefining the contract distinction.                                                       | Every oracle example/property against real SQLite, including the exact identity-recovery counterexample and a fresh nonempty reread.          |
| #137                  | Validated handlers, shared request/success validation, empty known continuation HTTP 200, and exact status/error mapping.                                                                                                           | Hidden migrations, client sort, raw MIME parsing, or converting the empty continuation to 404/invalid_cursor. | Real-SQLite Hono matrix for canonical, alias, nonempty/empty pages, rejected empty initial success, tombstones, and unknown.                  |
| #195                  | One mapped request per page and exact JSON/human projection of success or shared error.                                                                                                                                             | Membership assembly, sorting, alias resolution, local cursor following, or local exit policy.                 | Exact argv/request/output/stderr/exit matrix distinguishing empty continuation success from unknown nonzero error.                            |

## Authority and live drift

Frozen inputs with `gitCommit` are verified from the exact committed blob. The checker separately reports differing worktree bytes as `downstreamWorktreeDrift`; it does not adopt those bytes as design authority. The current #199 identity-only, promotion, and search-summary worktree changes are downstream diagnostics until their owning tickets pass the repaired #197/#198 rule.

## Contradiction ledger

| ID     | Blocker                                                                                                                                              | Required closure                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `UC01` | Accepted #198 contract requires both success arrays to have at least one member, contradicting the real-SQLite identity-recovery empty continuation. | Reopen #198; allow structural empty arrays plus the shared request/success invariant before #137. |
| `UC02` | Search fabricates per-message thread IDs; no storage implementation exists in #137 authority.                                                        | Add a storage/migration dependency and retire the placeholder.                                    |
| `UC03` | #195 assumes route/client/global exit policy that do not yet exist.                                                                                  | Keep it blocked; accept dependencies and shared numeric policy first.                             |
