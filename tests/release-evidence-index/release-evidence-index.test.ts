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

  test("rejects focused completeness mutations", { timeout: 90_000 }, () => {
    expect(runSelfTest()).toEqual({
      attacks: 80,
      validBeforeMutation: 80,
      positiveCapacityFixture: true,
      replayRejected: true,
      liveIndexUnchanged: true,
      liveRecordCount: 1,
      staleClearRejected: true,
      corruptLiveRejected: true,
      doubleApplicationStable: true,
      accepted: true,
    });
  });
});
