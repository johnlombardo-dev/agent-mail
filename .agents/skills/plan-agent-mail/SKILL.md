---
name: plan-agent-mail
description: Qualify this repository's Agent Mail implementation plan against the Sol/Sol-Luna evidence, the 30 audited Sol-Luna defects, and the project's mail-specific safety and release gates. Use only in this Agent Mail workspace when checking or updating PLAN.md, docs/planning/EVIDENCE.md, or implementation evidence mapped to F01-F30.
---

# Plan Agent Mail

Complement this repository's rigorous plan with Agent Mail-specific conformance checks. Use the general `$evidence-backed-planning` skill for lessons and plans intended to apply to unrelated future projects.

## Workflow

1. Read `PLAN.md` and `docs/planning/EVIDENCE.md`; freeze their source session IDs, audited fingerprint, current repository boundary, Hermes allocation, dependency policy, security-review prerequisite, status, and explicit gaps.
2. Confirm the plan still uses prototype evidence selectively: Sol's shared-contract skeleton and Sol-Luna's boundary parsing, per-target durability, and cleanup discipline, without inheriting either implementation wholesale.
3. Read [references/failure-shields.md](references/failure-shields.md). Check that F01-F30 still have an invariant, planned control, faithful proof, owner, and honest status.
4. Check the SEC-R05 Daybreak registry for the split F09-P/F09-R rows and distinct authority freshness, independent approval/principal durability, admission-before-allocation (including streaming), output-context safety, trusted intermediary provenance, integrity commitments, and dependency reachability/exception removal controls. Each row must have a demonstrated counterexample, invariant, planned control, faithful proof, owner issue, intervention timing, and honest evidence status.
5. Check the #208 coordination order: hold dependent action/OpenAPI/human-output/final-security work until #202, #203, #204, #205, and #206 close with their original regressions; downstream work may then resume by seam, while #176, #180, #183, and #185 remain release blockers. Treat #203's accepted digest as authority and preserve any later consequential product decision as a blocker.
6. Run `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py` from the repository root and run the negative expired-undispatched-recovery fixture/probe.
7. Report missing, weakened, contradicted, or unverified gates. Do not rewrite the plan merely to make the checker pass.

## Planning rules

- Require outcome closure for promotion plus routing, IMAP effect plus durable result, runtime API plus XState, and backup plus full restore.
- Require parity matrices for existing versus future routing, API versus CLI results, storage versus route not-found behavior, and actor versus API status.
- Make test doubles obey production return shapes, termination behavior, errors, and ordering. Add adapter contract tests against installed SDK behavior where possible.
- Define remote mutation uncertainty explicitly. IMAP effects and local persistence cannot be made atomically exactly-once; plans must specify reconciliation before retry.
- Keep the core domain transport-free. Share one versioned request/response contract between the daemon and CLI, and validate both directions at runtime.
- Parse SQLite rows, configuration, provider results, and external input from `unknown` at their owning boundaries.
- Make XState states describe work that is actually active. Actors own cancellation, retry, cleanup, and status. Await one idempotent cleanup barrier.
- Test performance at the public boundary, including sparse UID mailboxes, selected export, slow consumers, and whole-response behavior.
- Define operational success as a postcondition: restored archive, absent plist, correct doctor diagnosis, exact Tailscale configuration, or equivalent observable outcome.
- Keep live mail, launchd, Tailscale, and complete security-lane evidence marked unverified until actually exercised with authorization. Approved Daybreak access enables the complete lane but is not passing evidence.
- Do not claim release readiness while any required traceability row lacks passing evidence.
- Treat #203's accepted approval/principal oracle digest as binding authority; do not widen it or invent a replacement policy to satisfy a structural check.

## Required output

Return the frozen plan target, checker result, missing or weakened F01-F30 rows, evidence-tier gaps, and a qualification result of `ready to implement`, `needs planning repair`, or `blocked by an unresolved consequential decision`.
