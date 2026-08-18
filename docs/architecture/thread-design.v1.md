# Deterministic message threads v1

Status: frozen design with downstream contract blockers. Normative oracle SHA-256: `cddac2500b0a71a5e51525aa42e827b3e487a65aeaf9ad5f5405f39d9de70239`.

[`thread-oracle.v1.json`](thread-oracle.v1.json) is the single normative model. This document, the decisions view, and the coverage view are checked explanations. If prose conflicts with JSON, JSON wins.

## Outcome

Threading is an account-scoped durable graph over immutable canonical messages and bounded RFC identification facts. It replaces the current one-thread-per-message search placeholder. Subject, participants, mailboxes, flags, labels, and body text never establish membership.

The graph has three identities that must not be collapsed:

| Term              | Meaning                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Canonical message | One accepted `message:<sha256>` raw-EML identity. It remains the public member identity.                                 |
| Message-ID node   | One bounded normalized RFC Message-ID digest. Several canonical-message nodes may link to it without being deduplicated. |
| Thread handle     | An account-scoped digest of the deterministic root node. Every issued handle remains resolvable after a merge.           |

A thread is the weakly connected component created by accepted `References` and `In-Reply-To` ancestry. Directed edges retain root meaning. The canonical root is the smallest zero-indegree node key; a rootless adversarial cycle uses the smallest node key. The public formula is:

```text
thread:sha256("agent-mail-thread-v1\0" || account_id || "\0" || root_node_key)
```

Late replies normally retain the root. A reply can name a virtual root before that root message arrives, so materializing a late ancestor does not churn identity. A late bridge, newly disclosed earlier ancestor, duplicate claimant with new ancestry, or cycle can change the root. The old handle becomes a permanent alias in the same transaction.

## Header normalization

The accepted MIME boundary already streams source bytes, unfolds and decodes fields, preserves ordered header rows, caps the header section, and marks MIME-derived content untrusted. Thread v1 reads `message_headers.value` for ordered rows named `message-id`, `references`, and `in-reply-to`; it never reparses raw EML during a query.

The primary syntax and semantics are [RFC 5322 section 3.6.4](https://www.rfc-editor.org/rfc/rfc5322.html#section-3.6.4). Header unfolding comes from [RFC 5322 section 2.2.3](https://www.rfc-editor.org/rfc/rfc5322.html#section-2.2.3). The v1 byte ceiling is grounded in [RFC 5322 section 2.1.1](https://www.rfc-editor.org/rfc/rfc5322.html#section-2.1.1). UTF-8 atoms and Message-IDs come from [RFC 6532 sections 3.1–3.3](https://www.rfc-editor.org/rfc/rfc6532.html#section-3.1), including NFC rather than NFKC. Obsolete phrase/quoted forms described by [RFC 5322 section 4.5.4](https://www.rfc-editor.org/rfc/rfc5322.html#section-4.5.4) remain preserved evidence but do not create v1 links: their ambiguous comparison behavior is unsafe at this trust boundary.

Exact v1 behavior:

- `Message-ID` requires exactly one occurrence and one valid token. Duplicate fields use the canonical-message fallback node.
- `References` and `In-Reply-To` each allow zero or one occurrence. A malformed, oversized, or over-count field contributes no partial prefix.
- Parsing is one bounded left-to-right scan. Only whitespace/comments may occur outside tokens. Comments nest at most eight levels. Controls, Unicode format/surrogate categories, noncharacters, stray phrases, quotes, or angle brackets reject the field.
- A valid token is NFC `id-left@id-right` without angle brackets. Local-part case is preserved. ASCII domain letters are lowercased only for dot-atom `id-right`; Unicode and domain-literal case are preserved.
- `References` accepts at most 100 tokens, `In-Reply-To` 32, and a message contributes at most 134 node keys: its permanent member, optional own-ID node, and bounded ancestry nodes. Raw values never enter IDs, errors, logs, SQL text, HTML, or filenames.

## Graph and merge transaction

Every canonical message is the permanent distinct node `m:<canonical-message-digest>`. A valid own ID creates an undirected equivalence link from that member to `i:<sha256("thread-msgid-v1\0" || normalized-id)>`; several members can link to the same Message-ID node. This preserves duplicate evidence and lets an identity-only member add recovered header facts without removing or replacing its original node.

For `References r[0..n-1]`, storage inserts ancestry edges `r[i] -> r[i+1]` and `r[n-1] -> memberAnchor`, where `memberAnchor` is the own Message-ID node or the canonical member node when the own ID is unusable. Every `In-Reply-To p` adds `p -> memberAnchor`. Equal pairs are deduplicated and self-edges are suppressed. Root calculation collapses own-ID equivalence links; equivalence affects membership but not ancestry indegree.

The storage owner persists normalized facts, member/Message-ID equivalences, ancestry-class nodes and incoming counts, edges, physical sets, memberships, bounded participant projection rows, handles, merge provenance, and one generation in SQLite. Ingestion parses at most 134 keys outside the write transaction, then performs one `BEGIN IMMEDIATE` transaction. It chooses a physical set by union-by-weight, moves only smaller-set rows with indexed SQL, derives the deterministic public root independently, repoints all affected handles, records merges, and commits one generation. A failure rolls the whole change back.

This separation provides both required properties:

- Public identity is independent of which physical set won or which message arrived first.
- Application memory is `O(134 + affected set summaries)`, not `O(thread size)` or `O(corpus size)`. On-disk row moves are amortized logarithmic per row under union-by-weight.

Restart builds no in-memory graph and hydrates no graph snapshot. SQLite is authoritative. An equal state/`facts_sha256` replay is a byte-preserving no-op. The one permitted fact change is a monotonic identity-only-to-parsed transition after accepted content recovery; it only adds equivalence/ancestry facts and can merge but never split components. Parsed facts cannot change.

## Member order and pages

Thread order is oldest to newest by this final tuple:

1. non-null `sentAt` before null;
2. normalized UTC `sentAt` ascending;
3. canonical `messageId` ascending.

Placement UID, row insertion order, and received time never break ties. A parsed tuple is immutable. Identity-only starts with null `sentAt` and may move once to the recovered parsed instant; because null sorts last, recovery moves only earlier and cannot duplicate a member in live keyset continuation. `receivedAt` remains the minimum placement `INTERNALDATE` for the account, including tombstones; an identity-only message with no `INTERNALDATE` uses its durable `observed_at`. It is presentation/history metadata rather than the order key. Equal instants with different offsets therefore tie and fall through to message identity. Missing/invalid dates sort last.

Thread requests require a handle and accept `limit` (default 50, maximum 100) plus an opaque `thread-cursor-v1`. The signed cursor binds a nonsecret cursor-key ID, the account, the permanent originally requested handle, and the last exact order tuple. Normal restart reloads the same owner-only HMAC key. Explicit rotation or restore without that external key yields `invalid_cursor`, never `not_found`. Reads resolve the handle on every page and use a strict keyset predicate. There is no `OFFSET` and no client-side sort.

Pagination is deliberately live, not a hidden snapshot. A late member at or before the cursor appears only on a fresh read. A late member after the cursor may appear on continuation. Parsed tuples and unique membership prevent duplicates; the one identity-recovery transition only moves from the null tail to an earlier position, so an already returned member cannot repeat. A merge cannot invalidate the cursor because the originally requested handle remains resolvable.

## Public semantics

Search keeps its accepted live-placement visibility rule. Search hydration joins `(account_id,message_id)` to durable thread membership instead of fabricating `thread:<message-sha>`. Tombstoned-only messages leave default search but remain in direct message and thread history. A thread filter accepts an alias; a well-formed unknown filter produces a normal empty search page because it is a filter, not direct resource retrieval.

Direct message retrieval returns the current canonical thread handle for a retained known message, including a tombstoned-only message. Direct thread retrieval accepts canonical or alias handles and returns retained members, including tombstoned-only members, in server order. A known v1 thread is never empty.

The bounded thread success object must expose canonical `threadId`, nullable `resolvedFromThreadId`, subject, at most 256 participants plus `participantsTruncated`, complete `messageCount`, one nonempty `messageIds`/`messages` page, complete received-time bounds, and `nextCursor`. Page arrays have identical length/order and `messageIds[i] == messages[i].messageId`.

A well-formed unknown direct handle returns the accepted thread `not_found` envelope and HTTP 404. `[]`, `{thread:null}`, and a 200 thread with empty arrays are forbidden. CLI JSON preserves the server object; human output iterates server order. CLI not-found uses the shared global nonzero policy and cannot invent a thread-local exit code.

## Recovery and versioning

All thread domain authority lives in SQLite, so it enters the accepted manifest-backed database snapshot. Restore parity compares canonical handles, aliases, membership, order, fresh cursor boundaries, tombstone behavior, and unknown outcomes before backup and after verified restore into an empty private root. Cursor HMAC keys remain external private authority and are not silently exported. FTS reindex reads thread truth but never reparses headers, changes generation, merges sets, or rewrites aliases.

The v1 normalizer and identity formula are immutable. A future change that can remove an edge or split a component needs a new algorithm namespace and migration/public compatibility contract. It cannot silently rewrite an old handle.

## Downstream blockers

The current accepted contract and issue boundaries cannot implement this design unchanged:

- `threadRequestSchema` has no page arguments; `threadSchema` has unbounded whole arrays and no count, truncation, cursor, or alias provenance. Issue #137 must gain a contract-revision prerequisite.
- Search still computes `'thread:' || substr(message_id, 9)`. No thread migration/repository exists, but #137 currently owns handlers only and protects query/storage changes. It needs a separate storage implementation dependency.
- Issue #195 says the route/client and global exit policy are frozen, but #137 and #155 are open and no numeric global CLI exit policy exists. #195 must remain blocked and must not choose a local number.

These are delivery blockers, not a proof that stable multi-message identity is impossible. The generic `thread:` namespace can carry the v1 digest once the shared bounded retrieval contract and storage owner are accepted.

## Frozen evidence

The oracle pins exact hashes and commits for PLAN/EVIDENCE, accepted MIME parsing, canonical-message/placement/structured-content storage, search summary and cursor, retrieval contracts, and backup/restore parity. Notable accepted sources are:

- MIME parser `1776503132bd4fbe7cd36128e046ab9a618f66f4`
- canonical message/placement migration `202e83ce2a8b9369a11eaa714832f2ba3ad00486`
- identity-only repository `d83265b4101db6af4b2a3567e7eeb85cb1572020`
- canonical promotion `da026418fe6eb33614732173e2bd4434c4cd1588` and placement tombstone `c0a5ac7824a2d85bf59d1ccfc9113fa7d8d12f3b`
- search summary `165d4a3aff7361de02c456cf592dde6ad4a83a69`
- search cursor `7a9fac905f6635050543e3a2add3de96baecca75`
- retrieval contract `55c01ab0471d806f5c713559f17a55d4c84ecb52`
- manifest `a907766557bf84e5b8d79bd429834c143a1b51a9` and restore `21ce2ac47544e28e5dc10c7e75df983968352995`
