# Agent Mail

Agent Mail is a local-first archive and operator tool for one iCloud account. This
repository is the phase-zero foundation and is not a release-ready mail product:
the daemon, CLI workflows, live iCloud access, remote mutation, launchd, and
Tailscale operations are planned work.

The canonical target is [`johnlombardo-dev/agent-mail`](https://github.com/johnlombardo-dev/agent-mail).
The former Sol-Luna implementation is evidence only; it is not a dependency or
an installation source.

## Prerequisites and setup

- macOS is the deployment target. Use Bun `1.3.14` (the version in `.bun-version`)
  and Git. No iCloud credentials or other secrets are needed for phase zero.
- Work from the repository root. Dependencies are pinned in `bun.lock` and the
  workspace contains six implementation packages.

<!-- readme-transcript:available -->

```sh
bun install --frozen-lockfile
```

<!-- readme-transcript:end -->

The command transcript checker runs marked blocks in order in a temporary clean
checkout with the environment scrubbed. It does not contact iCloud, mutate mail,
change launchd or Tailscale, or retain its temporary checkout:

```sh
bun tests/readme-transcript/check.ts README.md
```

## Phase-zero quality commands

These commands are implemented and currently executable from a clean checkout.
Run them after setup. Warnings from the configured linter are non-fatal; a
non-zero exit is a failed check.

<!-- readme-transcript:available -->

```sh
bun run lint:check
bun run typecheck
bun test
bun test tests/adapter-contracts/harness.test.ts
bun run build
```

<!-- readme-transcript:end -->

`format:check`, `audit`, `outdated`, and the aggregate `ready` command are
defined, but are not represented as passing phase-zero transcript commands until
their current clean-checkout evidence is attached. Do not interpret the listed
checks as proof of composed, live, security, deployed, or delivery readiness.

## Package ownership

The six implementation packages are:

| Package                 | Responsibility                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@agent-mail/core`      | Transport-free domain types, invariants, and use-case ports                                                                 |
| `@agent-mail/contracts` | Versioned Zod/OpenAPI request, response, error, cursor, and CLI contracts                                                   |
| `@agent-mail/storage`   | SQLite migrations and capability-owned persistence for messages, sync, routing, actions, reports, export, backup, and blobs |
| `@agent-mail/imap`      | ImapFlow capability discovery, mailbox/status normalization, streaming fetch, IDLE, and action reconciliation               |
| `agent-maild`           | Future daemon workflow, dependency wiring, loopback servers, configuration, credentials, and operations                     |
| `agent-mail`            | Future thin schema-driven CLI with bounded streaming and stable output                                                      |

The `.agents/skills/agent-mail` directory is an operator-skill placeholder, not a
seventh implementation package.

## Hermes ports

Use the existing Hermes slug `agent-mail` and range `6110–6119`. Do not allocate
another range or bind a project listener outside it.

| Port        | Role                                               |
| ----------- | -------------------------------------------------- |
| `6110`      | Normal loopback daemon API and report origin       |
| `6111`      | Local mock IMAP server                             |
| `6112–6114` | Leased integration and end-to-end listeners        |
| `6115`      | Performance and capacity harness                   |
| `6116`      | Opt-in live-read daemon                            |
| `6117`      | Opt-in disposable-mailbox mutation daemon          |
| `6118`      | launchd and Tailscale deployment-acceptance origin |
| `6119`      | Reserved future project-owned server role          |

The role map in `ports.ts` is the executable phase-zero subset. Leasing and
external Hermes metadata correction are setup work; neither is performed by the
README transcript.

## Private configuration

The future daemon accepts a strict startup configuration with an absolute,
canonical `privateRoot`. By default it derives `data`, `blobs`, `journal`,
`backups`, and `runtime` beneath that root, and stores the API token at
`<privateRoot>/secrets/api-token` with mode `0600`. Optional path overrides must
remain the exact derived children. Ports must match the approved role map above.

Phase zero does not create these directories, read credentials, or start a
daemon. Keep secrets outside Git and never paste message bodies, tokens, or
provider credentials into routine logs.

## Adapter-contract harness

The harness is an isolated contract runner, not live-provider evidence. It keeps
fake and production-labelled results separate, records skipped capabilities and
production-required gaps, and compares observed case outcomes for semantic
parity. The available test command is:

```sh
bun test tests/adapter-contracts/harness.test.ts
```

Production-labelled fixtures in this phase are explicitly in-memory and must not
be described as installed ImapFlow or iCloud proof.

## Planned product commands

The following are requirements, not currently executable commands. They must not
be copied into setup scripts or treated as evidence:

```text
bun run sync
bun run search -- "from:example@example.com"
bun run doctor
bun run backup --output /private/path
```

Remote mutation, live iCloud reads, launchd changes, and Tailscale changes require
explicit authorization and an isolated verification target when they are
implemented.

## Planning and evidence

- [Implementation plan](PLAN.md)
- [Evidence and defect traceability](docs/planning/EVIDENCE.md)
- [System context](CONTEXT.md)
- [Reusable planning skill](.agents/skills/plan-agent-mail/SKILL.md)

Promotion requires separate static, isolated, composed, capacity, live, security,
deployed, and delivery evidence. Phase-zero commands alone do not claim full
readiness.
