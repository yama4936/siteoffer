import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { type AuditFindingSummary, compareAudits } from "./audit-comparison";

const base = {
  id: randomUUID(),
  companyId: randomUUID(),
  websiteId: randomUUID(),
  targetUrl: "https://example.test/",
  finalUrl: null,
  status: "evaluated" as const,
  rubricVersion: "fixture-1",
  evaluatorModel: "fixture-model",
  scoreConfirmed: true,
  totalScore: "50.1",
  coverage: "0.9",
};
const finding: AuditFindingSummary = {
  itemCode: "A1",
  category: "A",
  status: "scored",
  score: 1,
  reason: "同じ理由",
  improvementHint: null,
  critical: false,
  inference: false,
};
it("保存済みの小数点差を丸めずに計算し、点数0と評価不能を区別する", () => {
  for (const [before, after, delta] of [
    ["0.1", "0.2", "0.1"],
    ["50.20", "50.1", "-0.1"],
    ["0", "0", "0"],
    ["99.9999999999999999", "100", "0.0000000000000001"],
  ])
    expect(compareAudits({ ...base, totalScore: after! }, { ...base, totalScore: before! }, [], [])).toMatchObject({
      comparable: true,
      scoreDelta: delta,
    });
  for (const totalScore of [null, "", "NaN", "Infinity", "-1", "100.0000000000000001", "101"])
    expect(compareAudits({ ...base, totalScore }, base, [], []).scoreDelta).toBeNull();
});
it("異なる対象・到達先・基準・モデル・未確定結果の点差を表示しない", () => {
  for (const patch of [
    { companyId: randomUUID() },
    { websiteId: randomUUID() },
    { targetUrl: "https://other.example.test/" },
    { finalUrl: "https://redirect.example.test/" },
    { status: "failed" as const },
    { scoreConfirmed: false },
    { scoreConfirmed: null },
    { rubricVersion: null },
    { rubricVersion: "new" },
    { evaluatorModel: null },
    { evaluatorModel: "unknown" },
    { evaluatorModel: "changed" },
  ]) {
    const comparison = compareAudits({ ...base, ...patch }, base, [], []);
    expect(comparison.comparable, JSON.stringify(patch)).toBe(false);
    expect(comparison.scoreDelta).toBeNull();
    expect(comparison.reasons.length).toBeGreaterThan(0);
  }
  expect(compareAudits({ ...base, coverage: "0.8" }, base, [], [])).toMatchObject({
    coverageChanged: true,
    comparable: true,
  });
});
it("状態・レベル・理由・改善案・致命・推測・項目の追加削除を記録し、観測日時だけでは変更扱いにしない", () => {
  expect(
    compareAudits(base, base, [{ ...finding, observations: ["private"] } as AuditFindingSummary], [finding]).changes,
  ).toEqual([]);
  for (const patch of [
    { status: "unevaluable" as const, score: null },
    { score: 0 },
    { reason: "変更" },
    { improvementHint: "新案" },
    { critical: true },
    { inference: true },
    { category: "B" },
  ]) {
    const comparison = compareAudits(base, base, [{ ...finding, ...patch }], [finding]);
    expect(comparison.changes).toHaveLength(1);
    expect(comparison.changes[0]!.after).not.toHaveProperty("observations");
  }
  expect(compareAudits(base, base, [finding], []).changes[0]).toMatchObject({ before: null, after: finding });
  expect(compareAudits(base, base, [], [finding]).changes[0]).toMatchObject({ before: finding, after: null });
});
