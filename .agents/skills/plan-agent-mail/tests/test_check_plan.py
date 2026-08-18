#!/usr/bin/env python3
"""Negative structural probe for the expired-undispatched recovery seam."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve()
SKILL_ROOT = HERE.parents[1]
REPO_ROOT = SKILL_ROOT.parents[2]
CHECKER = SKILL_ROOT / "scripts" / "check_plan.py"
FIXTURE = HERE.parent / "fixtures" / "expired-undispatched-recovery-weakened.row"


def main() -> int:
    bad_row = FIXTURE.read_text(encoding="utf-8").strip()
    with tempfile.TemporaryDirectory(prefix="agent-mail-plan-negative-") as temp:
        root = Path(temp)
        (root / "docs" / "planning").mkdir(parents=True)
        for source, target in (
            (REPO_ROOT / "PLAN.md", root / "PLAN.md"),
            (REPO_ROOT / "docs" / "planning" / "EVIDENCE.md", root / "docs" / "planning" / "EVIDENCE.md"),
        ):
            text = source.read_text(encoding="utf-8")
            mutated, count = re.subn(r"^\| SEC-R01 \|.*$", bad_row, text, flags=re.MULTILINE)
            if count != 1:
                print(f"FAIL: expected one SEC-R01 row in {source}, found {count}")
                return 1
            target.write_text(mutated, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(CHECKER), str(root)],
            capture_output=True,
            text=True,
            check=False,
        )
        output = result.stdout + result.stderr
        if result.returncode == 0:
            print("FAIL: weakened expired-undispatched recovery fixture unexpectedly passed")
            return 1
        if "SEC-R01" not in output or "faithful proof is weakened" not in output:
            print("FAIL: checker rejected fixture without identifying the weakened SEC-R01 proof")
            print(output)
            return 1
    print("PASS: expired-undispatched recovery weakening is rejected by the structural checker")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
