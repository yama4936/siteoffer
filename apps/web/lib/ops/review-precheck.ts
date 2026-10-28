import { type ProposalPrecheck, type ProposalPrecheckKey, parseProposalPrecheck } from "@siteoffer/schemas";

export type { ProposalPrecheck };

export const PRECHECK_LABEL: Record<ProposalPrecheckKey, { title: string; description: string }> = {
  company: { title: "会社情報", description: "会社名・住所・電話番号など" },
  devices: { title: "PC・スマホの表示", description: "各デバイスでの見え方" },
  links: { title: "リンク・導線", description: "メニュー・ボタン・問い合わせ先" },
  continuity: { title: "既存機能の引き継ぎ", description: "ブログ・お知らせなどの更新機能" },
};

/** 提案版の content.aiCheck（AIの事前チェック）を型を検証して読む。未実施・不正なら null */
export function readReviewPrecheck(content: unknown): ProposalPrecheck | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  return parseProposalPrecheck((content as { aiCheck?: unknown }).aiCheck);
}
