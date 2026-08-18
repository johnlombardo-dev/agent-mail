#!/usr/bin/env python3
"""Check structural Agent Mail planning and Daybreak failure shields.

The checker validates table shape and required controls. It cannot establish
that an executable proof passed or that an external security review ran.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REQUIRED_PLAN_HEADINGS = (
    "## Evidence baseline", "## Scope", "## Non-negotiable invariants",
    "## Architecture decisions", "## Behavioral-seam manifest",
    "## Planning-shield applicability", "## Delivery slices",
    "## Acceptance matrices", "## Evidence tiers and promotion",
    "## Risk and finding traceability", "## Explicit gaps and deferred work",
)
REQUIRED_SOURCES = (
    "01a00ade-55b1-7cb3-bfe4-5edf7baa5d85",
    "01a00b59-7554-7ef0-850d-6ae1fa44f27d",
)
REQUIRED_CURRENT_FACTS = (
    "johnlombardo-dev/agent-mail", "johnlombardo-dev/agent-mail-proto",
    "6110", "6119", "latest stable", "security or compatibility exception",
    "complete applicable security lane",
)
REQUIRED_SEAMS = (
    "promotion plus routing", "IMAP effect plus durable result",
    "runtime API plus XState", "backup plus full restore",
    "existing versus future routing", "API versus CLI", "storage versus route",
    "actor versus API", "sparse UID", "selected export", "slow stdout",
    "whole-response",
)
DAYBREAK_IDS = (
    "F09-P", "F09-R", "SEC-R01", "SEC-R02", "SEC-R03", "SEC-R04",
    "SEC-R05", "SEC-R06", "SEC-R07",
)
DAYBREAK_COLUMNS = (
    "ID", "Demonstrated counterexample", "Invariant", "Planned control",
    "Faithful executable proof", "Owner issue", "Intervention timing",
    "Evidence status",
)
# The shape checks deliberately require the distinctive control/proof contract
# for each row. They are not a substitute for running the named proof.
ROW_REQUIREMENTS = {
    "F09-P": (("internal", "executor"), ("routes", "executor")),
    "F09-R": (("revalidate", "expiry"), ("undispatched", "expiry")),
    "SEC-R01": (("authority", "dispatched"), ("undispatched", "remote")),
    "SEC-R02": (("#203", "one-use"), ("replay", "concurrent")),
    "SEC-R03": (("stream", "before"), ("chunked", "wrong-scope")),
    "SEC-R04": (("context", "hostile"), ("esc", "osc")),
    "SEC-R05": (("header", "topology"), ("direct", "intermediary")),
    "SEC-R06": (("recompute", "canonical"), ("tamper", "replay")),
    "SEC-R07": (("reachability", "exception"), ("advisory", "owner")),
}


def normalized(text: str) -> str:
    return re.sub(r"[`*_]", "", text).casefold()


def table_cells(line: str) -> list[str]:
    if not line.lstrip().startswith("|"):
        return []
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def daybreak_table(text: str) -> tuple[dict[str, dict[str, str]], list[str]]:
    headers = [normalized(cell) for cell in DAYBREAK_COLUMNS]
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if [normalized(cell) for cell in table_cells(line)] != headers:
            continue
        rows: dict[str, dict[str, str]] = {}
        duplicate: list[str] = []
        for row_line in lines[index + 2 :]:
            cells = table_cells(row_line)
            if not cells:
                if rows:
                    break
                continue
            if all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
                continue
            if len(cells) != len(DAYBREAK_COLUMNS):
                continue
            row = dict(zip(DAYBREAK_COLUMNS, cells))
            row_id = row["ID"]
            if row_id in rows:
                duplicate.append(row_id)
            rows[row_id] = row
        return rows, duplicate
    return {}, []


def check_daybreak(text: str, label: str, errors: list[str]) -> None:
    rows, duplicate = daybreak_table(text)
    if not rows:
        errors.append(f"{label} is missing the SEC-R05 traceability table")
        return
    if duplicate:
        errors.append(f"{label} has duplicate Daybreak IDs: {', '.join(sorted(set(duplicate)))}")
    missing = [row_id for row_id in DAYBREAK_IDS if row_id not in rows]
    if missing:
        errors.append(f"{label} is missing Daybreak rows: {', '.join(missing)}")
        return
    for row_id in DAYBREAK_IDS:
        row = rows[row_id]
        for column in DAYBREAK_COLUMNS[1:]:
            if not row[column].strip():
                errors.append(f"{label} {row_id} has an empty {column} field")
        if not re.search(r"#\d+", row["Owner issue"]):
            errors.append(f"{label} {row_id} must name an owner issue")
        if "stage" not in normalized(row["Intervention timing"]):
            errors.append(f"{label} {row_id} must name intervention timing")
        if not re.search(r"specified|implemented|verified|blocked|release-blocking", normalized(row["Evidence status"])):
            errors.append(f"{label} {row_id} must name an evidence status")
        control_terms, proof_terms = ROW_REQUIREMENTS[row_id]
        control = normalized(row["Planned control"])
        proof = normalized(row["Faithful executable proof"])
        for term in control_terms:
            if term not in control:
                errors.append(f"{label} {row_id} planned control is weakened: missing {term!r}")
        for term in proof_terms:
            if term not in proof:
                errors.append(f"{label} {row_id} faithful proof is weakened: missing {term!r}")


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
    plan_path = root / "PLAN.md"
    evidence_path = root / "docs" / "planning" / "EVIDENCE.md"
    shields_path = Path(__file__).resolve().parents[1] / "references" / "failure-shields.md"
    errors: list[str] = []
    for path in (plan_path, evidence_path, shields_path):
        if not path.is_file():
            errors.append(f"missing required file: {path}")
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    plan = plan_path.read_text(encoding="utf-8")
    evidence = evidence_path.read_text(encoding="utf-8")
    shields = shields_path.read_text(encoding="utf-8")
    combined = normalized(plan + "\n" + evidence)
    for heading in REQUIRED_PLAN_HEADINGS:
        if heading not in plan:
            errors.append(f"PLAN.md is missing heading: {heading}")
    for source in REQUIRED_SOURCES:
        if source not in plan and source not in evidence:
            errors.append(f"planning pack is missing evidence source: {source}")
    for fact in REQUIRED_CURRENT_FACTS:
        if fact.casefold() not in combined:
            errors.append(f"planning pack is missing current project fact: {fact}")
    expected_ids = {f"F{number:02d}" for number in range(1, 31)}
    actual_ids = set(re.findall(r"\bF(?:0[1-9]|[12][0-9]|30)\b", evidence))
    missing_ids = sorted(expected_ids - actual_ids)
    if missing_ids:
        errors.append("EVIDENCE.md is missing finding IDs: " + ", ".join(missing_ids))
    for seam in REQUIRED_SEAMS:
        if seam.casefold() not in combined:
            errors.append(f"planning pack is missing required seam: {seam}")
    if "daybreak access is approved" not in combined:
        errors.append("planning pack must distinguish approved Daybreak access from review evidence")
    if not all(token in combined for token in ("complete applicable security lane", "unverified", "release-blocking")):
        errors.append("planning pack must keep complete security evidence unverified and release-blocking")
    if not all(token in combined for token in ("#202", "#203", "#204", "#205", "#206", "#208")):
        errors.append("planning pack is missing #202-#206/#208 coordination dependencies")
    if not all(token in combined for token in ("#203", "unresolved", "consequential", "block")):
        errors.append("planning pack must preserve the unresolved consequential #203 decision as a blocker")
    check_daybreak(plan, "PLAN.md", errors)
    check_daybreak(evidence, "EVIDENCE.md", errors)
    check_daybreak(shields, "failure-shields.md", errors)
    if re.search(r"\b(?:TODO|TBD|PLACEHOLDER)\b", plan, flags=re.IGNORECASE):
        errors.append("PLAN.md contains unresolved planning markers")
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: Agent Mail planning pack contains all required evidence and failure shields.")
    print("LIMIT: row structure and required controls are checked; proof execution and external security review remain unverified evidence obligations.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
