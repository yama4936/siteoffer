// 評価基準0.1の名称。配点・閾値・判定は変更しない。
// .agents/skills/site-evaluation/references/rubric.md と対応する。
const labels: Record<string, string> = {
  A1: "問い合わせ手段の見つけやすさ",
  A2: "スマホからの連絡しやすさ",
  A3: "行動を促す文言・配置",
  A4: "問い合わせフォームの負担",
  B1: "ファーストビューの伝達力",
  B2: "サービス内容の具体性",
  B3: "判断材料（料金・流れ・FAQ・強み）",
  C1: "会社情報",
  C2: "実績・事例・お客様の声",
  C3: "更新性",
  C4: "HTTPS",
  D1: "viewport・レスポンシブ",
  D2: "スマホでの読みやすさ・操作性",
  E1: "表示速度",
  E2: "エラー・古い技術",
  F1: "title・description",
  F2: "見出し構造",
  F3: "インデックス・クロール",
  F4: "構造化データ・SNS表示",
  G1: "画像の代替テキスト",
  G2: "言語指定・フォームのラベル",
  G3: "視認性（コントラスト・文字サイズ）",
};

export function findingLabel(itemCode: string, rubricVersion: string | null): string | null {
  return rubricVersion === "0.1" && Object.hasOwn(labels, itemCode) ? labels[itemCode]! : null;
}
