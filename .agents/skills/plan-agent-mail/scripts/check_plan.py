#!/usr/bin/env python3
"""Check the structural failure shields in an Agent Mail planning pack."""

from __future__ import annotations

import re
import sys
from pathlib import Path


REQUIRED_PLAN_HEADINGS = (
    "## Evidence baseline",
    "## Scope",
    "## Non-negotiable invariants",
    "## Architecture decisions",
    "## Behavioral-seam manifest",
    "## Planning-shield applicability",
    "## Delivery slices",
    "## Acceptance matrices",
    "## Evidence tiers and promotion",
    "## Risk and finding traceability",
    "## Explicit gaps and deferred work",
)

REQUIRED_SOURCES = (
    "01a00ade-55b1-7cb3-bfe4-5edf7baa5d85",
    "01a00b59-7554-7ef0-850d-6ae1fa44f27d",
)

REQUIRED_CURRENT_FACTS = (
    "johnlombardo-dev/agent-mail",
    "johnlombardo-dev/agent-mail-proto",
    "6110",
    "6119",
    "latest stable",
    "security or compatibility exception",
    "complete applicable security lane",
)

REQUIRED_SEAMS = (
    "promotion plus routing",
    "IMAP effect plus durable result",
    "runtime API plus XState",
    "backup plus full restore",
    "existing versus future routing",
    "API versus CLI",
    "storage versus route",
    "actor versus API",
    "sparse UID",
    "selected export",
    "slow stdout",
    "whole-response",
)


def normalized(text: str) -> str:
    return re.sub(r"[`*_]", "", text).casefold()


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
    plan_path = root / "PLAN.md"
    evidence_path = root / "docs" / "planning" / "EVIDENCE.md"
    errors: list[str] = []

    for path in (plan_path, evidence_path):
        if not path.is_file():
            errors.append(f"missing required file: {path}")

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    plan = plan_path.read_text(encoding="utf-8")
    evidence = evidence_path.read_text(encoding="utf-8")
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

    unresolved = re.findall(r"\b(?:TODO|TBD|PLACEHOLDER)\b", plan, flags=re.IGNORECASE)
    if unresolved:
        errors.append("PLAN.md contains unresolved planning markers")

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    print("PASS: Agent Mail planning pack contains all required evidence and failure shields.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
