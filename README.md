# Agent Mail

This workspace contains the evidence-backed planning baseline for a new Agent Mail implementation. Runtime implementation has not started.

The canonical delivery target is [`johnlombardo-dev/agent-mail`](https://github.com/johnlombardo-dev/agent-mail), which is currently empty. The former Sol-Luna implementation is retained as evidence at [`johnlombardo-dev/agent-mail-proto`](https://github.com/johnlombardo-dev/agent-mail-proto).

- [Implementation plan](PLAN.md)
- [Evidence and defect traceability](docs/planning/EVIDENCE.md)
- [Reusable planning skill](.agents/skills/plan-agent-mail/SKILL.md)

The plan combines `agent-mail-sol`'s shared-contract simplicity with selected `agent-mail-sol-luna` persistence and lifecycle mechanisms, while adding release gates for defects demonstrated in the Sol-Luna system audit.

Implementation must use the existing Hermes `agent-mail` range `6110–6119` and the latest stable compatible dependencies, with documented evidence for any older security or compatibility pin.
