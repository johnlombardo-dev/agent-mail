import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildForecasts,
  buildRelationshipOperations,
  classifyIssue,
  durationBusinessDays,
} from "./project-sync.mjs";

function issue(overrides) {
  return {
    number: 1,
    title: "[P6][Interfaces / CLI][Full/high] Implement command",
    state: "OPEN",
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
    closedAt: null,
    blockedBy: { nodes: [] },
    subIssues: { nodes: [] },
    parent: null,
    body: "",
    ...overrides,
  };
}

describe("project classification", () => {
  test("distinguishes cross-phase work and maps workstream", () => {
    assert.deepEqual(
      classifyIssue(issue({ title: "[P3/P8][Credentials / CLI][Full/xhigh] Implement account commands" })),
      {
        phase: "Cross-phase",
        workType: "Implementation",
        workstream: "Credentials",
        size: "Full",
        effort: "xhigh",
      },
    );
  });

  test("keeps qualification separate from implementation", () => {
    assert.equal(
      classifyIssue(issue({ title: "[P8][Qualification / Release][Full/high] Verify release" })).workType,
      "Qualification",
    );
  });

  test("uses conservative business-day sizes", () => {
    assert.equal(durationBusinessDays(issue({ title: "[P0][Foundation][Compact/low] Small" })), 1);
    assert.equal(durationBusinessDays(issue({ title: "[P6][CLI][Full/high] Normal" })), 2);
    assert.equal(durationBusinessDays(issue({ title: "[P6][CLI][Full/max] Deep" })), 3);
  });
});

describe("native relationship reconciliation", () => {
  test("attaches phase work and corrective blockers without duplicating existing links", () => {
    const phase = issue({ number: 8, title: "[Phase 6] REST, CLI, reports, and export" });
    const target = issue({ number: 165, title: "[P6][Quality][Full/high] Complete parity" });
    const corrective = issue({
      number: 242,
      title: "[P6][Security][Full/xhigh] Exercise composition",
      body: "> Corrective dependency for [#165](https://github.com/example/issues/165)",
    });
    const existing = issue({
      number: 243,
      title: "[P6][Quality][Full/high] Existing relation",
      body: "> Corrective dependency for #165",
      parent: { number: 8 },
    });
    target.blockedBy.nodes.push({ number: 243, state: "OPEN" });

    assert.deepEqual(
      buildRelationshipOperations([phase, target, corrective, existing]).map((operation) => ({
        kind: operation.kind,
        issue: operation.issue.number,
        related: operation.subIssue?.number ?? operation.blocker?.number,
      })),
      [
        { kind: "subIssue", issue: 8, related: 165 },
        { kind: "subIssue", issue: 8, related: 242 },
        { kind: "blockedBy", issue: 165, related: 242 },
      ],
    );
  });
});

describe("rolling forecasts", () => {
  test("starts dependent work after its open blocker", () => {
    const blocker = issue({ number: 10, title: "[P6][Corrective][Full/xhigh] Blocker" });
    const dependent = issue({
      number: 11,
      title: "[P6][Corrective][Full/high] Dependent",
      blockedBy: { nodes: [{ number: 10, state: "OPEN" }] },
    });
    const forecasts = buildForecasts([blocker, dependent], "2026-08-20");
    assert.deepEqual(forecasts.get(10), {
      start: "2026-08-20",
      target: "2026-08-24",
      confidence: "Medium",
    });
    assert.deepEqual(forecasts.get(11), {
      start: "2026-08-25",
      target: "2026-08-26",
      confidence: "Low",
    });
  });

  test("uses actual dates for closed work and leaves post-release unscheduled", () => {
    const closed = issue({ number: 20, state: "CLOSED", closedAt: "2026-08-21T00:00:00Z" });
    const later = issue({ number: 21, title: "[Post-release][Platforms / Linux][Full/xhigh] Debian" });
    const forecasts = buildForecasts([closed, later], "2026-08-20");
    assert.deepEqual(forecasts.get(20), {
      start: "2026-08-20",
      target: "2026-08-21",
      confidence: "High",
    });
    assert.deepEqual(forecasts.get(21), {
      start: null,
      target: null,
      confidence: "Unscheduled",
    });
  });
});
