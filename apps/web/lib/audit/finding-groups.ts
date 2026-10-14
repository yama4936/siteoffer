/**
 * 診断の項目を、画面で開いて見せるもの（要改善）と、閉じておくもの（問題なし・評価できず）に分ける。
 * - 要改善：採点済みでレベル3（満点）未満、または致命項目に当たるもの。致命項目を先に、レベルの低い順に並べる
 * - 問題なし：採点済みでレベル3、かつ致命項目でないもの
 * - 評価できず・対象外：unevaluable・not_applicable（低評価には含めない。9章）
 */
export interface GroupableFinding {
  itemCode: string;
  status: string;
  score: number | null;
  critical: boolean;
}

export const MAX_FINDING_SCORE = 3;

export interface FindingGroups<T> {
  needsWork: T[];
  ok: T[];
  other: T[];
}

export function groupFindings<T extends GroupableFinding>(findings: readonly T[]): FindingGroups<T> {
  const groups: FindingGroups<T> = { needsWork: [], ok: [], other: [] };
  for (const f of findings) {
    if (f.status !== "scored" || f.score === null) groups.other.push(f);
    else if (f.critical || f.score < MAX_FINDING_SCORE) groups.needsWork.push(f);
    else groups.ok.push(f);
  }
  groups.needsWork.sort(
    (a, b) =>
      Number(b.critical) - Number(a.critical) ||
      (a.score ?? 0) - (b.score ?? 0) ||
      a.itemCode.localeCompare(b.itemCode),
  );
  return groups;
}
