import { expect, it } from "vitest";
import { type MaterialDraft, materialConflicts, mergeMaterialDraft } from "./merge";

const base: MaterialDraft = {
  label: "会社写真",
  rightsBasis: "own_work",
  rightsNote: "元の説明",
  requestedDemo: true,
  requestedProduction: true,
};
it("片側だけの修正を両方残し、最新側で取り消した用途も反映する", () => {
  const mine = { ...base, rightsNote: "入力中の追加説明" },
    latest = { ...base, label: "更新済みの写真名", requestedDemo: false };
  expect(materialConflicts(base, mine, latest)).toEqual([]);
  expect(mergeMaterialDraft(base, mine, latest, {})).toEqual({ ...latest, rightsNote: mine.rightsNote });
});
it("両方が別内容に変えた説明は選択するまで引き継がず、項目別の選択を守る", () => {
  const mine = { ...base, label: "入力中の名前", rightsNote: "入力中の文面" },
    latest = { ...base, label: "別画面の名前", rightsNote: "別画面の文面" };
  expect(materialConflicts(base, mine, latest)).toEqual(["label", "rightsNote"]);
  expect(mergeMaterialDraft(base, mine, latest, {})).toBeNull();
  expect(mergeMaterialDraft(base, mine, latest, { label: "mine" })).toBeNull();
  expect(mergeMaterialDraft(base, mine, latest, { label: "latest", rightsNote: "mine" })).toEqual({
    ...latest,
    rightsNote: mine.rightsNote,
  });
});
it("同じ変更は競合にせず、確認済みチェックは引き継がない", () => {
  const mine = { ...base, rightsBasis: "permission" as const, confirmed: true },
    latest = { ...mine };
  expect(materialConflicts(base, mine, latest)).toEqual([]);
  const merged = mergeMaterialDraft(base, mine, latest, {});
  expect(merged?.rightsBasis).toBe("permission");
  expect(merged).not.toHaveProperty("confirmed");
});
