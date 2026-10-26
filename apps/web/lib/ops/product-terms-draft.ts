import { calculateRewardAmount, type RewardRule } from "@siteoffer/core/reward/rule";

// product_terms.price / monthly_fee and rewards.amount are PostgreSQL integer columns.
export const PRODUCT_TERMS_MAX_AMOUNT = 2_147_483_647;
export const PRODUCT_TERMS_FIELDS = [
  "version",
  "name",
  "scope",
  "price",
  "monthlyFee",
  "rewardType",
  "rewardValue",
] as const;
export type ProductTermsField = (typeof PRODUCT_TERMS_FIELDS)[number];
export type ProductTermsDraft = Record<ProductTermsField, string>;
export type ProductTermsErrors = Partial<Record<ProductTermsField, string>>;
export const EMPTY_PRODUCT_TERMS_DRAFT: ProductTermsDraft = {
  version: "",
  name: "",
  scope: "",
  price: "",
  monthlyFee: "",
  rewardType: "",
  rewardValue: "",
};

function money(raw: string): number | null | undefined {
  const text = raw.normalize("NFKC").trim();
  if (!text) return null;
  // Reject partial numbers, exponents, decimals and malformed grouping; never silently round.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return undefined;
  const value = Number(text.replaceAll(",", ""));
  return Number.isSafeInteger(value) && value <= PRODUCT_TERMS_MAX_AMOUNT ? value : undefined;
}

function percent(raw: string): number | undefined {
  const text = raw.normalize("NFKC").trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return undefined;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(basisPoints) && basisPoints <= 10_000 ? basisPoints : undefined;
}

/** Shared by live preview and the server. Blank optional values remain unset. */
export function inspectProductTermsDraft(draft: ProductTermsDraft) {
  const errors: ProductTermsErrors = {};
  if (!draft.version.trim() || draft.version.length > 100) errors.version = "版名を100文字以内で入力してください。";
  if (!draft.name.trim() || draft.name.length > 200) errors.name = "名称を200文字以内で入力してください。";
  if (draft.scope.length > 10_000) errors.scope = "提供範囲は10,000文字以内で入力してください。";
  const price = money(draft.price),
    monthlyFee = money(draft.monthlyFee);
  const moneyError = "0〜2,147,483,647円の整数で入力してください。3桁区切りのカンマを使えます。";
  if (price === undefined) errors.price = moneyError;
  if (monthlyFee === undefined) errors.monthlyFee = moneyError;
  let rewardRule: RewardRule | null = null;
  if (draft.rewardType === "fixed") {
    const amount = money(draft.rewardValue);
    if (amount === null || amount === undefined) errors.rewardValue = moneyError;
    else rewardRule = { type: "fixed", amount };
  } else if (draft.rewardType === "rate") {
    const basisPoints = percent(draft.rewardValue);
    if (basisPoints === undefined) errors.rewardValue = "0〜100%を小数第2位までで入力してください。例：12.5";
    else rewardRule = { type: "rate", basisPoints };
  } else if (draft.rewardType !== "") {
    errors.rewardType = "報酬条件の種類を選び直してください。";
  } else if (draft.rewardValue.trim()) {
    errors.rewardValue = "報酬条件の種類を選んでください。";
  }
  const reward = rewardRule ? calculateRewardAmount(rewardRule, price ?? null) : null;
  return {
    errors,
    price,
    monthlyFee,
    rewardRule,
    rewardAmount: reward?.ok ? reward.value : null,
    input: Object.keys(errors).length
      ? null
      : {
          version: draft.version.trim(),
          name: draft.name.trim(),
          scopeText: draft.scope.trim(),
          price: price ?? null,
          monthlyFee: monthlyFee ?? null,
          rewardRule,
        },
  };
}

/** Read only named single text fields. React's own action metadata is not part of the draft. */
export function readProductTermsDraft(form: FormData): ProductTermsDraft | null {
  const draft = { ...EMPTY_PRODUCT_TERMS_DRAFT };
  for (const field of PRODUCT_TERMS_FIELDS) {
    const values = form.getAll(field);
    if (values.length > 1 || (values.length === 1 && typeof values[0] !== "string")) return null;
    draft[field] = (values[0] as string | undefined) ?? "";
    if (draft[field].length > (field === "scope" ? 10_000 : field === "name" ? 200 : 100)) return null;
  }
  return draft;
}

export type ProductTermsDraftState = {
  nonce: string;
  status: "idle" | "error" | "saved";
  message: string;
  errors: ProductTermsErrors;
  saved: { id: string; version: string } | null;
};
