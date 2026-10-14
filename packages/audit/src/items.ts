/**
 * 評価項目ID（rubric v0.1）。配点の正は .agents/skills/site-evaluation/scripts/score.py の ITEMS。
 * ここでは項目のそろい方の確認と、評価不能の evaluation.json を作るためにIDだけを持つ。
 * score.py の ITEMS を変えたら、ここも合わせる（score.py の検証で不一致は検出される）。
 */
export const ITEM_IDS = [
  "A1",
  "A2",
  "A3",
  "A4",
  "B1",
  "B2",
  "B3",
  "C1",
  "C2",
  "C3",
  "C4",
  "D1",
  "D2",
  "E1",
  "E2",
  "F1",
  "F2",
  "F3",
  "F4",
  "G1",
  "G2",
  "G3",
] as const;

export type ItemId = (typeof ITEM_IDS)[number];

export function categoryOf(itemId: string): string {
  return itemId.slice(0, 1);
}
