export type ReviewValues = { note: string };
export type ReviewDraftSnapshot = { revision: number; values: ReviewValues | null; updatedAt: string | null };
export type ReviewDraftResult =
  | { status: "ok"; snapshot: ReviewDraftSnapshot; sellable?: ReviewSellableResult; message?: string }
  | { status: "conflict"; snapshot: ReviewDraftSnapshot }
  | { status: "error"; message: string };
/** 承認後の営業可能化の結果。失敗しても承認は確定している */
export type ReviewSellableResult = { ok: true; productTermsVersion: string } | { ok: false; reason: string };
export type ReviewCommitInput = { revision: number; decision: "approved" | "rejected"; requestKey: string };
export const EMPTY_REVIEW: ReviewValues = { note: "" };
export const EMPTY_REVIEW_DRAFT: ReviewDraftSnapshot = { revision: 0, values: null, updatedAt: null };
