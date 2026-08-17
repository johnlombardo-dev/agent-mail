# Invocation metrics

The main-thread orchestrator using `scale-sol-luna-goals` must initialize a new append-only JSONL journal for each goal. Any agent that dispatches a subagent, including a nested dispatcher, must add one start/outcome pair for that dispatch to the goal's journal. Store each journal outside the repository at:

```text
~/.codex/subagent-metrics/scale-sol-luna-goals/<repository-id>/<skill-use-id>.jsonl
```

Resolve `repository_id` once with the skill's `scripts/repository_id.py`. Reuse that exact value and the same `skill_use_id` for every record in the journal. Hosted repositories use lowercase `host/owner/repository`; local repositories use the helper's `local/repository/path-hash` fallback.

Use the skill's `scripts/append_metric.py` for every append. Pass only the event payload on standard input. The helper validates the payload and journal order, generates the schema version and envelope, adds `created_at`, locks the file, flushes the append, and syncs it to disk.

```sh
printf '%s\n' "$payload" | python3 /absolute/path/to/scale-sol-luna-goals/scripts/append_metric.py \
  --repository-id host/owner/repository \
  --skill-use-id use-1
```

Do not create repository-local metrics, a shared aggregate log, a separate file per subagent, or a current write target under `~/.codex/subagent-contracts`.

## Journal lifecycle and dispatching responsibilities

For every new goal, the main-thread orchestrator must generate a new `skill_use_id`, resolve `repository_id` once, and append `use_started` before goal work or any subagent dispatch. Never reuse a prior goal's journal, even for the same repository or a continuation of related work.

Any agent that dispatches a subagent must:

1. Immediately before the dispatch, append that child's `subagent_started` record to the goal's journal.
2. When that child reaches a terminal state, append the matching `subagent_outcome` record with the accurate outcome and concrete result.
3. Pass the same journal identity and absolute helper path to any nested dispatcher it creates, so that dispatcher can record pairs for its own children.

The main-thread orchestrator owns the goal-level `use_started` and `use_outcome` records. Before appending `use_outcome`, it must close every unmatched direct-child start and verify that every nested dispatcher has closed the pairs it owns.

## Invocation pair

Append `use_started` before any work or dispatch:

```json
{
  "type": "use_started",
  "goal_id": "goal-1",
  "objective": "Implement the accepted Agent Mail Phase 1 plan.",
  "start_fingerprint": "commit and relevant dirty state"
}
```

Append `use_outcome` only after every started subagent has a terminal outcome:

```json
{
  "type": "use_outcome",
  "status": "success",
  "result": "Implemented and verified the Agent Mail Phase 1 plan.",
  "failed_criteria": [],
  "end_fingerprint": "verified commit and relevant dirty state",
  "total_goal_tokens": 12345,
  "token_measurement": "runtime"
}
```

Use these constraints:

- `goal_id` and `skill_use_id` are non-empty, lowercase, path-safe identifiers.
- `objective` and `result` are non-empty, single-line descriptions.
- `status` is `success`, `failure`, or `blocked`.
- `failed_criteria` is a duplicate-free array of stable acceptance-check IDs. It is empty for `success`, non-empty for `failure`, and may be empty for `blocked`.
- `start_fingerprint` and `end_fingerprint` name the relevant repository or no-Git state and material dirty state. Redact credentials, email bodies, headers, attachment names, and other message content.
- `total_goal_tokens` is a directly measured, non-negative whole-goal total for the main task and all subagents. If the runtime does not supply it, use `total_goal_tokens: null` with `token_measurement: "unavailable"`. Never estimate it.

The runtime owns whole-goal elapsed time. Report terminal runtime telemetry to the user, but do not derive or persist elapsed time in this journal.

## Per-subagent pair

Append `subagent_started` immediately before every subagent dispatch:

```json
{
  "type": "subagent_started",
  "assignment_id": "implementation-1",
  "parent_assignment_id": null,
  "role": "luna_worker",
  "requested_model": null,
  "requested_reasoning_effort": "medium",
  "model": "gpt-5.6-luna",
  "reasoning_effort": "medium",
  "objective": "Implement the bounded storage migration and run its focused tests."
}
```

Append `subagent_outcome` when that dispatch reaches a terminal state:

```json
{
  "type": "subagent_outcome",
  "assignment_id": "implementation-1",
  "outcome": "completed",
  "result": "Implemented the migration and passed the focused storage tests."
}
```

Use these constraints:

- `assignment_id` is unique within the invocation and uses the same lowercase, path-safe identifier format.
- `parent_assignment_id` is `null` for a direct child of the orchestrator. For a nested dispatch, use the dispatching agent's `assignment_id`.
- `role` records the requested logical or runtime role.
- `requested_model` and `requested_reasoning_effort` record explicitly requested settings; use `null` when a setting was not requested.
- `model` and `reasoning_effort` record the effective model and reasoning level of the invoked subagent, after resolving role defaults and inherited settings. Both are required, non-null values for every `subagent_started` record.
- `outcome` is `completed`, `useful-no-go`, `failed`, `blocked`, `cancelled`, `interrupted`, or `superseded`.
- Null, negative, ambiguous, contradictory, and unavailable results still receive an outcome record with concrete result text.

Give a nested dispatcher the journal identity and the absolute helper path. The agent that dispatches the child owns that child's `subagent_started` and `subagent_outcome` records and may append only those observational records. It must not edit prior records or write the invocation outcome.

Before appending `use_outcome`, close every unmatched subagent start with the accurate terminal outcome. Use `interrupted`, `cancelled`, `blocked`, or `failed` when a dispatch did not complete normally.

## Generated envelope

The append helper adds this schema version 3 envelope to every payload:

```json
{
  "schema_version": 3,
  "created_at": "2026-08-16T01:02:03.456Z",
  "repository_id": "github.com/example/agent-mail-sol-luna",
  "skill_use_id": "use-1"
}
```

Do not supply generated envelope fields. Do not supply the obsolete timing fields `started_at`, `completed_at`, `elapsed_ms`, or `timing_status`.

## Ordering and write rules

- The first record is exactly one `use_started`; the final record is exactly one `use_outcome`.
- Between them, each dispatch has exactly one `subagent_started` followed eventually by exactly one matching `subagent_outcome`.
- A nested assignment's parent must already have a start record. No record may follow `use_outcome`.
- The helper rejects invalid existing JSONL, mismatched schema/repository/invocation IDs, unknown or missing fields, duplicate starts or outcomes, outcomes without starts, missing parents, unfinished subagents at invocation outcome, and records after the invocation outcome.
- Do not record prompts, reasoning traces, per-subagent durations, per-subagent token estimates, routine tool calls, review events, qualitative comparison cohorts, or inferred timing.
- If persistence fails, continue the goal and report the missing metric. Do not reconstruct records, timestamps, timing, or token counts from recollection, file modification times, or partial worker reports.

## Final summary

After `use_outcome`, run the skill's metrics summarizer:

```sh
python3 /absolute/path/to/scale-sol-luna-goals/scripts/summarize_metrics.py \
  --repository-id host/owner/repository \
  --skill-use-id use-1
```

Report the invocation status, whole-goal token total when available, subagent count, outcome counts, and any unfinished assignment IDs. Preserve unavailable token counts as `null`. Do not calculate durations from the journal.
