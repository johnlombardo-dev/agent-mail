import { describe, expect, test } from "bun:test";
import { runSelfTest, validateIndex } from "../../docs/architecture/release-evidence-index-check.v1.mjs";

describe("release qualification evidence index", () => {
  test("accepts the checked index and retains every planned row", async () => {
    const index = await Bun.file("docs/architecture/release-evidence-index.v1.json").json();
    expect(index.gates.map((gate: { id: string }) => gate.id)).toEqual([
      "static",
      "isolated",
      "composed",
      "capacity",
      "liveRead",
      "liveMutation",
      "security",
      "deployedOperations",
      "delivery",
    ]);
    expect(
      index.rows.filter((row: { result: { kind: string } }) => row.result.kind === "retained-proof"),
    ).toHaveLength(19);
    expect(
      index.rows
        .filter((row: { result: { kind: string } }) => row.result.kind === "blocked")
        .map((row: { id: string }) => row.id),
    ).toEqual(expect.arrayContaining(["F13", "F19", "F22", "F23", "F24"]));
    expect(index.rows.find((row: { id: string }) => row.id === "F30").result.commit).toBe(
      "e633a95",
    );
    expect(validateIndex(index)).toMatchObject({
      rowCount: 59,
      findingRows: 47,
      shieldRows: 12,
      gates: 9,
      releaseReady: false,
      sourceDigests: {
        EVIDENCE: "a141f641cf9254ca04f91c3084419094dc6d8169c3f8f0e0ad26c79f53437fc9",
      },
    });
  });

  test("keeps the legacy v1 projection inactive", async () => {
    const index = await Bun.file("docs/architecture/release-evidence-index.v1.json").json();
    expect(index.legacyV1Projection.status).toBe("inactive");
    const legacy = structuredClone(index);
    legacy.resultRecords = [{ protocol: "legacy-v1", sequence: 1 }];
    expect(() => validateIndex(legacy)).toThrow(/legacy v1 records are inactive/u);
  });

  test("rejects incomplete #184 whole-record dispositions", async () => {
    const index = await Bun.file("docs/architecture/release-evidence-index.v1.json").json();
    const attacks = [
      ["missing target identity", (record: Record<string, unknown>) => delete record.targetGateId],
      ["null target digest", (record: Record<string, unknown>) => (record.targetRecordDigest = null)],
      ["zero target digest", (record: Record<string, unknown>) => (record.targetRecordDigest = "0".repeat(64))],
      ["foreign target owner", (record: Record<string, unknown>) => (record.targetOwnerIssueId = 999)],
      ["foreign target candidate", (record: Record<string, unknown>) => (record.targetCandidateCommit = "f".repeat(40))],
    ] as const;
    for (const [name, mutate] of attacks) {
      const candidate = structuredClone(index);
      candidate.resultRecords = [
        {
          protocol: "agent-mail.release-evidence/v2",
          recordType: "disposition",
          sequence: 1,
          previousRecordDigest: null,
          ownerIssueId: 184,
          mode: "disposition",
          gateId: "disposition",
          obligationIds: [],
          targetSequence: 1,
          targetRecordDigest: "a".repeat(64),
          targetOwnerIssueId: 176,
          targetGateId: "capacity",
          targetCandidateCommit: "a".repeat(40),
          targetCandidateTree: "b".repeat(40),
          targetEvidenceCommit: "c".repeat(40),
          reasonCode: "review-revocation",
          result: "invalidated",
          observedOutcome: { status: "invalidated" },
        },
      ];
      mutate(candidate.resultRecords[0]);
      expect(() => validateIndex(candidate), name).toThrow();
    }
  });

  test("rejects focused completeness mutations", { timeout: 90_000 }, () => {
    expect(runSelfTest()).toEqual({
      attacks: 80,
      validBeforeMutation: 80,
      positiveCapacityFixture: true,
      replayRejected: true,
      liveIndexUnchanged: true,
      liveRecordCount: 0,
      staleClearRejected: true,
      corruptLiveRejected: true,
      doubleApplicationStable: true,
      v2Execution: { attacks: 25, accepted: true, capture: true, replay: true },
      accepted: true,
    });
  });
});
