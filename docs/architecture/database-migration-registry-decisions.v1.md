# Database migration registry decisions v1

Status: **frozen design for issue #233**.

Oracle SHA-256: `58bb3aefde5dc4a89c23df2014cf303d2ef843b90acb4bac61f8c2e716c84acc`.

## Evidence baseline

| Fact                           | Accepted value                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Shaping commit                 | `547f70dd67959541324688b7b737749bc43791ab`                                                                                            |
| Production registry            | absent                                                                                                                                |
| Production migration consumer  | absent                                                                                                                                |
| Independent schema ceiling     | 11; legacy compatibility guard only; not a migration registry and not evidence that versions 1 through 11 form the application schema |
| Accepted semantic migrations   | 27                                                                                                                                    |
| Actual composition corpus      | 62 files / 94 calls / `e35638caca271c94c87421d10f12f204b8a3ae38daee54e928323943cfaafa70`                                              |
| Unsafe compatibility artifacts | 4 placeholders; 3 composer references; 3 direct SQL calls; 30 aggregate registry exports                                              |

The repository has no production migration consumer, and no accepted evidence records a live or deployed database lineage. That absence allows automatic **lossless** conversion of exact source-observed ledgers. It does not authorize deletion, heuristic repair, or conversion of unknown files.

## Frozen decisions

| Decision               | Rule                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DEC-ORDER-COMMITS      | Canonical order follows first accepted commit ancestry rather than filenames, feature families, or the schema ceiling.                                                                                                                                                                                                                                                                     |
| DEC-SEMANTIC-REMAP     | The registry remaps only version metadata; accepted names, SQL bytes, and execution modes remain unchanged.                                                                                                                                                                                                                                                                                |
| DEC-REINDEX-SEMANTIC   | The accepted unledgered SEARCH_REINDEX_SCHEMA_SQL becomes canonical slot 20 with declaredVersion null; exact idle and resumable actor overlays are preserved, while invalid overlays fail closed.                                                                                                                                                                                          |
| DEC-EXACT-CONVERSION   | Conversion is whitelist and fingerprint based, never heuristic or table-presence based.                                                                                                                                                                                                                                                                                                    |
| DEC-ATOMIC-CONVERSION  | Legacy conversion is one BEGIN IMMEDIATE transaction with foreign keys disabled only around the transaction and checked before commit.                                                                                                                                                                                                                                                     |
| DEC-BACKUP-FIRST       | File-backed legacy conversion requires an automatically verified pre-conversion backup.                                                                                                                                                                                                                                                                                                    |
| DEC-READONLY-PREFLIGHT | Classification reads a stable main/WAL copy in disposable scratch and never opens source SQLite; backup precedes an exclusive write barrier and exact locked revalidation before WAL configuration or conversion.                                                                                                                                                                          |
| DEC-BYTE-PROVENANCE    | Conversion infrastructure and records use byte-frozen SQL and canonical JSON/digest domains, with one transaction-gated INSERT and aborting UPDATE/DELETE triggers.                                                                                                                                                                                                                        |
| DEC-FAIL-UNKNOWN       | Unknown, ambiguous, direct-SQL, and placeholder histories fail before mutation.                                                                                                                                                                                                                                                                                                            |
| DEC-ONE-OPENER         | The database opener owns registry application and callers cannot select a version or subset.                                                                                                                                                                                                                                                                                               |
| DEC-OPERATIONS         | Doctor, backup, empty restore, and full restore consume the same registry verifier.                                                                                                                                                                                                                                                                                                        |
| DEC-NO-RESTORE-UPGRADE | Restore verifies canonical backups and never upgrades or repairs the staged database.                                                                                                                                                                                                                                                                                                      |
| DEC-CURRENT-TREE       | Issue 234 acceptance scans all tracked and untracked source roots against an exact 111-path allow/protected/unknown boundary whose 27-path semantic subunion equals canonicalRegistry.migrations[].source; authorized aggregate/lazy export retirement is accepted only when runtime semantic projection, the real registry/converter, and every execution-root bypass check remain exact. |
| DEC-REPORT-28          | The exact next legal migration and report creation slot is 28.                                                                                                                                                                                                                                                                                                                             |

## Compatibility boundary

Supported: The empty database, every exact canonical prefix, and every exact non-empty prefix of a convertible ledger composition below, combined only with an exact supported search-reindex schema overlay.

Data preservation: No table, row, blob reference, or accepted provenance may be dropped as a compatibility shortcut. Existing semantic SQL is skipped only after exact identity plus schema proof.

Failure predecessor: An error or crash before an ordinary migration commit leaves its exact canonical predecessor; after commit it leaves the newly committed exact canonical prefix. An error or crash before the legacy conversion commit leaves the exact legacy ledger and reindex overlay; after commit it leaves exact canonical 27 with the same valid active overlay. Reopen always reclassifies ledger plus schema and never infers success from selected schema objects alone.

Repeated open: An exact version-27 database performs no schema, history, conversion-ledger, reindex-actor, or domain write. It revalidates names, checksums, migration infrastructure, and the reindex overlay before return.

Newer version: user_version greater than 27 or any unknown later ledger row fails before mutation. Downgrade and automatic repair are forbidden.

Partial failure: The transaction commit is the only registry cutover. Preflight rejection leaves the complete source tree and sidecar presence/bytes/modes unchanged. Backup or locked-revalidation failure leaves the source database unchanged and retains any verified backup. Before commit, ordinary suffix failure leaves the previous canonical prefix and legacy conversion failure leaves the original legacy history, reindex overlay, and data. After commit, the complete new canonical prefix or complete canonical 27 is authoritative even if later opener work fails. No mixed ledger/schema/provenance state is accepted; foreign keys and the persistent always-deny insertion trigger are restored on every non-crash exit.

Conversion provenance: schema_migration_conversions is versioned migration-runner infrastructure beside schema_migrations, not an application migration slot. Registry v1 creates and verifies the byte-frozen table/index/trigger bundle in the first registry transaction. Fresh databases contain no conversion rows; converted databases preserve and digest the exact old history, base schema, overlay snapshot, target registry, verified backup identity, canonical timestamp, conversion id, and complete record.

## Rejected alternatives

| Alternative          | Rejected choice                                            | Reason                                                                                                    |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ALT-CEILING-REGISTRY | Treat supported schema ceiling 11 as the canonical history | It contains no names, checksums, dependency order, or composition authority.                              |
| ALT-ACTION-CHAIN     | Treat the action-specific 1..11 test chain as global       | It omits most application migrations and uses remapped journal/thread entries plus placeholder variants.  |
| ALT-REPORT-12        | Append report creation at version 12                       | The canonical registry contains 27 accepted semantic migrations; 12 is occupied by identity-only-content. |
| ALT-FILENAME-SORT    | Sort migration filenames                                   | Independent modules reuse prefixes and one file named 0004 declares version 1.                            |
| ALT-SCHEMA-INFERENCE | Infer installed migrations from table presence             | Partial/direct SQL states and later ALTER or rebuild migrations make presence ambiguous.                  |
| ALT-SILENT-REWRITE   | Replace old schema_migrations rows without preserving them | That destroys durable provenance and hides the compatibility decision.                                    |
| ALT-RESTORE-MIGRATE  | Upgrade a backup during restore                            | It mixes recovery with mutation and breaks byte/provenance parity before publication.                     |

## User decision and blockers

The repository and accepted planning evidence contain no live, deployed, or externally inventoried database history. This oracle therefore freezes lossless conversion for every exact accepted ledger observed in source without inventing a data-discard policy.

No user decision is required for this design. The blocker list is empty. Discovery of an external history that does not match the frozen whitelist is a new consequential compatibility decision and must stop before mutation.
