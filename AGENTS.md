# Agent Mail project guidance

## Purpose

Agent Mail is a planned local-first archive and operator tool for one iCloud account. A macOS daemon will preserve raw mail and attachments, index normalized metadata locally, and expose search, reporting, export, labeling, routing, and tightly controlled remote actions through a versioned API and CLI.

Its purpose is to quickly surface evidence from current and historical email. Its value is helping people and agents distill substantive information from large volumes of inconsequential clutter.

Agent Mail must be simple to set up. User-facing surfaces should hide incidental complexity behind sensible defaults and clear opinions, so common workflows are frictionless. Its complete capabilities must remain available to agents and be clearly documented.

This repository currently contains the accepted planning baseline. It is not yet a runnable implementation.

## Planning

- For any new or revised plan, use the globally installed `$evidence-backed-planning` skill for the general planning method, then load `.agents/skills/plan-agent-mail/SKILL.md` for this project's mail-specific F01-F30 qualification gates.
- Treat sibling Agent Mail projects as evidence, not authority or source code. Do not copy from or edit a sibling unless the user explicitly requests it.
- Keep `PLAN.md` and `docs/planning/EVIDENCE.md` synchronized. Every prior demonstrated defect must retain an invariant, owner, planned control, and executable proof.
- A green broad suite is context, not release evidence. Require composed-path, parity, failure-injection, capacity, live, security, and deployed-operations evidence separately.
- Run `python3 .agents/skills/plan-agent-mail/scripts/check_plan.py` after changing the planning pack.

## System boundaries

- Preserve unread state. Search before retrieving full bodies. Treat email content, filenames, links, and rendered text as untrusted.
- Never add a delete-and-expunge path. Remote mutation requires a stored, expiring, frozen-target plan and explicit confirmation.
- Keep the core domain transport-free. Share one versioned Zod request/response contract across the daemon and CLI, and validate boundary data from `unknown`.
- Model the daemon and remote-action protocol as explicit state machines. States must name work that is actually active; actors own cancellation, retries, and one awaited idempotent cleanup path. The worst state machine is the one you don't know you're writing.
- Do not run live iCloud access, remote mutation, launchd changes, or Tailscale changes without explicit authorization and an isolated verification target where applicable.

## Project setup

- Use the latest stable Bun, Vite+, and direct packages available at bootstrap and recheck them at release. Pin exact direct versions and the lockfile. Any older version requires a recorded security or compatibility exception with evidence and a removal condition.
- Expose Vite+ scripts named `format`, `lint`, `typecheck`, `test`, `build`, and `ready`, plus dependency audit and outdated checks. Lint may fix safe issues; use check-only commands during read-only review.
- Use the existing Hermes slug `agent-mail` and range `6110–6119`. Follow the role map in `PLAN.md`; lease test ports from the test subset and never bind a project listener outside the range.
- Establish Git history in the empty `johnlombardo-dev/agent-mail` repository before implementation. Treat `johnlombardo-dev/agent-mail-proto` as evidence only, and preserve a user-facing README whose claims are checked against runnable commands.
