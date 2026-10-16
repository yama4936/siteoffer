export const REVIEW_CHECKS = [
  ["company", "会社情報の確認", "会社名・住所・電話番号など"],
  ["rights", "画像の利用許諾", "使用する写真・イラストの権利"],
  ["devices", "PC・スマホの表示", "各デバイスでの見え方"],
  ["links", "リンク・問い合わせ導線", "メニュー・ボタン・フォームの動作"],
  ["continuity", "既存機能の引き継ぎ", "ブログ・お知らせなどの更新機能"],
] as const;
export type ReviewValues = {
  note: string;
  company: boolean;
  rights: boolean;
  devices: boolean;
  links: boolean;
  continuity: boolean;
};
export type ReviewDraftSnapshot = { revision: number; values: ReviewValues | null; updatedAt: string | null };
export type ReviewDraftResult =
  | { status: "ok"; snapshot: ReviewDraftSnapshot }
  | { status: "conflict"; snapshot: ReviewDraftSnapshot }
  | { status: "error"; message: string };
export type ReviewCommitInput = { revision: number; decision: "approved" | "rejected"; requestKey: string };
export const EMPTY_REVIEW: ReviewValues = {
  note: "",
  company: false,
  rights: false,
  devices: false,
  links: false,
  continuity: false,
};
export const EMPTY_REVIEW_DRAFT: ReviewDraftSnapshot = { revision: 0, values: null, updatedAt: null };
