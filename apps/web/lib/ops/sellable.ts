import { isTermsReadyForSales, type ProductTerms, termsReadinessIssues } from "@siteoffer/core";

/** 営業可能化を妨げている理由（14章・AC-09）。空なら営業可能にできる */
export type SellableIssue =
  | "company_suppressed"
  | "already_sellable"
  | "no_proposal_version"
  | "review_not_approved"
  | "terms_not_selected"
  | "terms_not_ready";

export interface SellableCheckInput {
  company: { suppression: string; pipelineStatus: string };
  /** 最新の提案版（版番号が最大のもの）。なければ null */
  latestVersion: { status: string } | null;
  /** 営業に使う販売条件・報酬条件の版。未選択なら null */
  terms: Pick<ProductTerms, "price" | "rewardRule" | "active"> | null;
}

/**
 * 営業可能にできるかの判定（純粋関数）。画面の表示と、営業可能化の処理（makeSellable）の両方で使う。
 * - 運営確認：最新の提案版が承認済み（approved）であること。古い版が承認済みでも、新しい版が未確認なら不可
 * - 販売条件・報酬条件：選んだ版が isTermsReadyForSales を満たすこと
 * - 営業抑止がないこと（営業拒否・除外・既存顧客は営業可能へ戻さない、8.1）
 */
export function sellableIssues(input: SellableCheckInput): SellableIssue[] {
  const issues: SellableIssue[] = [];
  if (input.company.suppression !== "none") issues.push("company_suppressed");
  if (input.company.pipelineStatus === "sellable") issues.push("already_sellable");
  if (!input.latestVersion) issues.push("no_proposal_version");
  else if (input.latestVersion.status !== "approved") issues.push("review_not_approved");
  if (!input.terms) issues.push("terms_not_selected");
  else if (!isTermsReadyForSales(input.terms)) issues.push("terms_not_ready");
  return issues;
}

export function termsIssueText(terms: Pick<ProductTerms, "price" | "rewardRule" | "active">): string {
  return termsReadinessIssues(terms).join(", ");
}
