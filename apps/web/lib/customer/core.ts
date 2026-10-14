/** 納品・顧客確認の core 関数の取り込み口（顧客向けの画面はここだけを参照する） */
export {
  CUSTOMER_COMMENT_MAX,
  type CustomerDecision,
  type CustomerDecisionError,
  type CustomerReview,
  type CustomerReviewState,
  decideAsCustomer,
  getCustomerReview,
} from "@siteoffer/core";
