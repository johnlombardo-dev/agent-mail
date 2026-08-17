# `deepmerge-ts` GHSA-ggr8-5vv4-36mx exception

Status: active compatibility exception, recorded 2026-08-18.

## Decision

The lockfile forces `deepmerge-ts@8.0.1` through the root `package.json`
`overrides` field. This crosses `html-to-text@10.0.0`'s declared
`deepmerge-ts@^7.1.5` range and is intentionally kept as a narrow transitive
override. The direct dependency pins remain `mailparser@3.9.15` and the
workspace's other exact versions.

`GHSA-ggr8-5vv4-36mx` affects every `deepmerge-ts` version below 8.0.0. A
crafted recursive object graph can exhaust the call stack through the public
merge APIs, so retaining the locked `7.1.6` is not acceptable. See the
[GitHub advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx).

The exact resolved chain is:

```text
mailparser@3.9.15
  -> html-to-text@10.0.0
    -> deepmerge-ts@8.0.1 (override; html-to-text declares ^7.1.5)
```

## Compatibility evidence

The following checks passed against the frozen lockfile:

- `bun install --frozen-lockfile`
- `bun audit` (no vulnerabilities)
- `bun run check:exact-versions`
- MailParser HTML input to text output smoke path (`Hello world.`)
- `bun run test` (129 passed)
- `bun run typecheck` (0 errors; three existing warnings)
- `bun run build`

This evidence covers installation, the dependency audit, and the exercised
MailParser HTML-to-text path. It does not establish full MailParser behavior
compatibility across all message formats or production mail traffic.

## Ownership and review

Owner: Agent Mail maintainers responsible for Phase 0 dependency qualification.

Review this exception whenever `html-to-text`, `mailparser`, or
`deepmerge-ts` is upgraded, and at release qualification. Recheck the
transitive graph, advisory status, frozen install, and MailParser smoke path
before changing or removing the override.

Residual risk is bounded to behavior changes between the declared 7.x API
contract and the forced 8.0.1 implementation; the current package exports and
the exercised conversion path are compatible, but complete upstream semantic
compatibility is not claimed.

## Removal condition

Remove the override when a supported `html-to-text` or `mailparser` release
declares `deepmerge-ts >=8.0.0`. Regenerate `bun.lock` and rerun the full
dependency and project gates before removing this record or changing its
status.
