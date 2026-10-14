import { describe, expect, it } from "vitest";
import { groupFindings } from "./finding-groups";

const f = (itemCode: string, status: string, score: number | null, critical = false) => ({
  itemCode,
  status,
  score,
  critical,
});

describe("診断項目の振り分け", () => {
  it("レベル0・1と致命項目は要改善、レベル2は軽微、レベル3は問題なし、評価できず・対象外はその他に分ける", () => {
    const g = groupFindings([
      f("A1", "scored", 3),
      f("A2", "scored", 1),
      f("B1", "scored", 3, true),
      f("B2", "unevaluable", null),
      f("C1", "not_applicable", null),
      f("C2", "scored", 0),
      f("D1", "scored", 2),
    ]);
    expect(g.needsWork.map((x) => x.itemCode)).toEqual(["B1", "C2", "A2"]);
    expect(g.minor.map((x) => x.itemCode)).toEqual(["D1"]);
    expect(g.ok.map((x) => x.itemCode)).toEqual(["A1"]);
    expect(g.other.map((x) => x.itemCode)).toEqual(["B2", "C1"]);
  });

  it("採点済みでもレベルがない項目は評価に数えない", () => {
    const g = groupFindings([f("E1", "scored", null)]);
    expect(g).toEqual({ needsWork: [], minor: [], ok: [], other: [f("E1", "scored", null)] });
  });
});
