import type { productTerms } from "@siteoffer/db";
import { err, ok, type Result } from "../common/result.ts";

/**
 * 報酬の算式（product_terms.reward_rule）。値そのもの（金額・割合）は未決で、運営が設定する。
 * - fixed：契約1件につき定額（円）
 * - rate：販売価格に対する割合。浮動小数の誤差を避けるため万分率（basis points）の整数で持つ
 *   （例：1000 = 10%）。円未満の端数は切り捨て。端数処理の方針は未決のため、変える場合はここを直す。
 */
export type RewardRule = { type: "fixed"; amount: number } | { type: "rate"; basisPoints: number };

export type ProductTerms = typeof productTerms.$inferSelect;

export type RewardRuleError = "reward_rule_missing" | "reward_rule_invalid" | "price_missing";

const isNonNegativeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseRewardRule(raw: unknown): Result<RewardRule, RewardRuleError> {
  if (raw === null || raw === undefined) return err("reward_rule_missing");
  if (typeof raw !== "object" || Array.isArray(raw)) return err("reward_rule_invalid");
  const r = raw as Record<string, unknown>;
  if (r.type === "fixed" && isNonNegativeInt(r.amount)) return ok({ type: "fixed", amount: r.amount });
  if (r.type === "rate" && isNonNegativeInt(r.basisPoints) && r.basisPoints <= 10_000)
    return ok({ type: "rate", basisPoints: r.basisPoints });
  return err("reward_rule_invalid");
}

/** 報酬額（円）を計算する */
export function calculateRewardAmount(rule: RewardRule, price: number | null): Result<number, RewardRuleError> {
  if (rule.type === "fixed") return ok(rule.amount);
  if (price === null || !isNonNegativeInt(price)) return err("price_missing");
  return ok(Math.floor((price * rule.basisPoints) / 10_000));
}

export type TermsNotReadyReason = "price_missing" | RewardRuleError | "inactive";

/** 販売条件・報酬条件のうち、営業可能化を妨げている理由の一覧（空なら営業に使える） */
export function termsReadinessIssues(
  terms: Pick<ProductTerms, "price" | "rewardRule" | "active">,
): TermsNotReadyReason[] {
  const issues: TermsNotReadyReason[] = [];
  if (!terms.active) issues.push("inactive");
  if (terms.price === null || !isNonNegativeInt(terms.price)) issues.push("price_missing");
  const rule = parseRewardRule(terms.rewardRule);
  if (!rule.ok) issues.push(rule.error);
  return issues;
}

/**
 * 販売条件（price）と報酬条件（reward_rule）が設定済みで、営業可能化に使えるか（14章）。
 * 運営画面の表示と、提案を営業可能にする処理の両方で使う。
 */
export function isTermsReadyForSales(terms: Pick<ProductTerms, "price" | "rewardRule" | "active">): boolean {
  return termsReadinessIssues(terms).length === 0;
}
