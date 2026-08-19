#!/usr/bin/env python3
"""Check structural Agent Mail planning and Daybreak failure shields.

The checker validates table shape and required controls. It cannot establish
that an executable proof passed or that an external security review ran.
"""

from __future__ import annotations

import re
import sys
from hashlib import sha256
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
AUTHORITY_ORACLE_DIGEST = "8e2f7d7259c6f3b3f9bf152c234594f0565c3cbf933f4394acad092232bdd8d7"
AUTHORITY_IMPLEMENTATION_COMMIT = "9d1f777"
ICLOUD_CREDENTIAL_COMMIT = "3757dfe85bdd9fbeec014f4c183ebfc9fa80effb"
ICLOUD_CREDENTIAL_ORACLE_DIGEST = "9b685e1293570d8f55f9a11c02b108e0ac5585a3cffdc367762db09f3e687c3c"
ICLOUD_CREDENTIAL_ARTIFACTS = {
    "docs/architecture/icloud-credential-authority-check.v1.mjs": "3368a67d75525ba057b6382199de3e33ee4e235c4c34db13b6b7faf578dc3605",
    "docs/architecture/icloud-credential-authority-coverage.v1.md": "6f567a5973a3050d265c92881d093d9c3c7e9467c110d8b6d40e488175221f47",
    "docs/architecture/icloud-credential-authority-decisions.v1.md": "a6af40637d1aa4e3642d2c38e465a99d2c25caab312b4e692f30ab84e2f89c84",
    "docs/architecture/icloud-credential-authority-design.v1.md": "1068bbccf0de7054baaf604e38bf30a3dd400543585bcca2779e0ff33d5fcc28",
    "docs/architecture/icloud-credential-authority-oracle.v1.json": ICLOUD_CREDENTIAL_ORACLE_DIGEST,
}
CREDENTIAL_IDS = tuple(f"CRED-{number:02d}" for number in range(1, 9))
CREDENTIAL_COLUMNS = (
    "ID", "Demonstrated defect", "Invariant", "Planned control",
    "Faithful executable proof", "Owner", "Held issue", "Dependency",
    "Source / artifact reference", "Evidence tier", "Current evidence status",
)
CREDENTIAL_ROW_REQUIREMENTS = {
    "CRED-01": {"defect": "no usable credential-provisioning path", "invariant": "one signed secure-paste ceremony stores only in keychain", "control": "opaque reference", "owner": "credential-provider implementation", "proof": "plaintext negative matrix"},
    "CRED-02": {"defect": "signed construction", "invariant": "acyclic nested signing", "control": "inside-out signed bundle", "owner": "credential-provider implementation and signed qualification", "proof": "peer hello"},
    "CRED-03": {"defect": "non-atomic keychain/config/removal writes", "invariant": "one actor journals before effect", "control": "256-record receipt cap", "owner": "sole actor/journal and local-command implementations", "proof": "crash/compensation/rerun/removal/capacity"},
    "CRED-04": {"defect": "revoked credential", "invariant": "strict newer-revision release", "control": "three-session", "owner": "connection/recovery implementation", "proof": "authentication rows"},
    "CRED-05": {"defect": "backup, restore, reinstall, removal", "invariant": "secret-free backup", "control": "Exclude raw secrets", "owner": "local-command implementation and qualification", "proof": "restore/reinstall/remove/uninstall"},
    "CRED-06": {"defect": "production connection factory", "invariant": "only exact-ref resolution reaches", "control": "constructively type listOnly:true", "owner": "connection/recovery implementation and live qualification", "proof": "real TypeScript compile fixture"},
    "CRED-07": {"defect": "local administration could be confused", "invariant": "authenticated local XPC registry is absent", "control": "outside HTTP", "owner": "credential-provider and local-command implementations", "proof": "public-reachability"},
    "CRED-08": {"defect": "guided and structured setup could fork", "invariant": "one local schema/state/outcome model", "control": "canonical actor", "owner": "local-command implementation and #215", "proof": "guided/structured"},
}
EVIDENCE_TIER_IDS = (
    "design", "local", "signed-installed", "live-read-only", "deployed",
    "security", "documentation", "delivery",
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


def credential_table(text: str) -> tuple[dict[str, dict[str, str]], list[str]]:
    headers = [normalized(cell) for cell in CREDENTIAL_COLUMNS]
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
            if len(cells) != len(CREDENTIAL_COLUMNS):
                continue
            row = dict(zip(CREDENTIAL_COLUMNS, cells))
            row_id = row["ID"]
            if row_id in rows:
                duplicate.append(row_id)
            rows[row_id] = row
        return rows, duplicate
    return {}, []


def check_credential_rows(text: str, label: str, errors: list[str]) -> None:
    rows, duplicate = credential_table(text)
    if not rows:
        errors.append(f"{label} is missing the CRED-01..CRED-08 traceability table")
        return
    if duplicate:
        errors.append(f"{label} has duplicate credential IDs: {', '.join(sorted(set(duplicate)))}")
    missing = [row_id for row_id in CREDENTIAL_IDS if row_id not in rows]
    if missing:
        errors.append(f"{label} is missing credential rows: {', '.join(missing)}")
        return
    unexpected = sorted(set(rows) - set(CREDENTIAL_IDS))
    if unexpected:
        errors.append(f"{label} has unexpected credential rows: {', '.join(unexpected)}")
    for row_id in CREDENTIAL_IDS:
        row = rows[row_id]
        for column in CREDENTIAL_COLUMNS[1:]:
            if not row[column].strip():
                errors.append(f"{label} {row_id} has an empty {column} field")
        normalized_cells = {column: normalized(row[column]) for column in CREDENTIAL_COLUMNS}
        requirements = CREDENTIAL_ROW_REQUIREMENTS[row_id]
        for column, term in (("Demonstrated defect", requirements["defect"]), ("Invariant", requirements["invariant"]), ("Planned control", requirements["control"]), ("Owner", requirements["owner"]), ("Faithful executable proof", requirements["proof"])):
            if term.casefold() not in normalized_cells[column]:
                errors.append(f"{label} {row_id} {column} is weakened: missing {term!r}")
        held = normalized_cells["Held issue"]
        if not re.search(r"#\d+", held):
            errors.append(f"{label} {row_id} must name a held issue")
        dependency = normalized_cells["Dependency"]
        for token in ("#236", ICLOUD_CREDENTIAL_COMMIT, ICLOUD_CREDENTIAL_ORACLE_DIGEST):
            if token.casefold() not in dependency:
                errors.append(f"{label} {row_id} dependency is missing {token!r}")
        source = normalized_cells["Source / artifact reference"]
        for token in (
            "icloud-credential-authority-oracle.v1.json",
            "icloud-credential-authority-coverage.v1.md",
            row_id,
        ):
            if token.casefold() not in source:
                errors.append(f"{label} {row_id} source reference is missing {token!r}")
        tier = normalized_cells["Evidence tier"]
        if not any(token in tier for token in EVIDENCE_TIER_IDS):
            errors.append(f"{label} {row_id} must name an evidence tier")
        status = normalized_cells["Current evidence status"]
        if "design" not in status or "unverified" not in status:
            errors.append(f"{label} {row_id} must retain design and unverified status language")
        if any(token in status for token in ("signed-installed verified", "live verified", "deployed verified", "security verified", "delivery verified")):
            errors.append(f"{label} {row_id} overclaims a non-design evidence tier")


def check_credential_authority(root: Path, combined: str, errors: list[str]) -> None:
    required_markers = (
        "#235", "#236", ICLOUD_CREDENTIAL_COMMIT, ICLOUD_CREDENTIAL_ORACLE_DIGEST,
        "accepted #236 artifact set", "local", "signed-installed", "live-read-only",
        "deployed", "security", "documentation", "delivery", "unverified",
    )
    for marker in required_markers:
        if marker.casefold() not in combined.casefold():
            errors.append(f"planning pack is missing credential authority marker: {marker}")
    for relative_path, expected_digest in ICLOUD_CREDENTIAL_ARTIFACTS.items():
        path = root / relative_path
        if not path.is_file():
            errors.append(f"missing accepted #236 artifact: {relative_path}")
            continue
        actual_digest = sha256(path.read_bytes()).hexdigest()
        if actual_digest != expected_digest:
            errors.append(f"accepted #236 artifact digest changed: {relative_path}")


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
    if AUTHORITY_ORACLE_DIGEST not in combined:
        errors.append("planning pack is missing the accepted #203 oracle digest")
    if AUTHORITY_IMPLEMENTATION_COMMIT not in combined:
        errors.append("planning pack is missing the #204 implementation provenance commit")
    if not all(token in combined for token in ("#203", "accepted", "oracle", "#204", "provenance", "release-blocking")):
        errors.append("planning pack must record accepted #203 authority and #204 provenance while retaining release blockers")
    if re.search(r"#203[^\n.]{0,180}\bunresolved\b|\bunresolved\b[^\n.]{0,180}#203", combined):
        errors.append("planning pack contains stale unresolved #203 authority wording")
    if "implementation not started" in combined or "no implementation evidence attached" in combined:
        errors.append("planning pack contains stale pre-implementation status wording")
    check_credential_authority(root, combined, errors)
    check_daybreak(plan, "PLAN.md", errors)
    check_daybreak(evidence, "EVIDENCE.md", errors)
    check_credential_rows(plan, "PLAN.md", errors)
    check_credential_rows(evidence, "EVIDENCE.md", errors)
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
