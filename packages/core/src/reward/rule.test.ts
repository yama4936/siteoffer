import { describe, expect, it } from "vitest";
import { calculateRewardAmount, isTermsReadyForSales, parseRewardRule, termsReadinessIssues } from "./rule.ts";

// 値はテスト内だけのもの（仕様の値ではない）
describe("報酬の算式", () => {
  it("定額と割合を扱える", () => {
    const fixed = parseRewardRule({ type: "fixed", amount: 5000 });
    const rate = parseRewardRule({ type: "rate", basisPoints: 1250 });
    expect(fixed.ok && rate.ok).toBe(true);
    if (!fixed.ok || !rate.ok) return;
    expect(calculateRewardAmount(fixed.value, null)).toEqual({ ok: true, value: 5000 });
    expect(calculateRewardAmount(rate.value, 100_001)).toEqual({ ok: true, value: 12_500 });
    expect(calculateRewardAmount(rate.value, null)).toMatchObject({ ok: false, error: "price_missing" });
  });

  it("不正な算式は拒否する", () => {
    expect(parseRewardRule(null)).toMatchObject({ ok: false, error: "reward_rule_missing" });
    for (const bad of [
      {},
      { type: "fixed" },
      { type: "fixed", amount: -1 },
      { type: "fixed", amount: 1.5 },
      { type: "rate", basisPoints: 10_001 },
      { type: "rate", rate: 0.1 },
      [],
    ]) {
      expect(parseRewardRule(bad)).toMatchObject({ ok: false, error: "reward_rule_invalid" });
    }
  });
});

describe("isTermsReadyForSales", () => {
  it("販売条件と報酬条件がそろっていれば営業に使える", () => {
    expect(isTermsReadyForSales({ price: 1000, rewardRule: { type: "fixed", amount: 100 }, active: true })).toBe(true);
  });

  it("価格・報酬条件の未設定、無効な条件は営業に使えない", () => {
    expect(isTermsReadyForSales({ price: null, rewardRule: { type: "fixed", amount: 100 }, active: true })).toBe(false);
    expect(isTermsReadyForSales({ price: 1000, rewardRule: null, active: true })).toBe(false);
    expect(isTermsReadyForSales({ price: 1000, rewardRule: { type: "rate" }, active: true })).toBe(false);
    expect(isTermsReadyForSales({ price: 1000, rewardRule: { type: "fixed", amount: 100 }, active: false })).toBe(
      false,
    );
    expect(termsReadinessIssues({ price: null, rewardRule: null, active: true })).toEqual([
      "price_missing",
      "reward_rule_missing",
    ]);
  });
});
