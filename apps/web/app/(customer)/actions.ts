"use server";

// 顧客確認の Server Action。顧客は常設ログインを持たないため、セッションCookieは読まない。
// フォームのトークンだけで判定し、期限・取り消し・版の一致・受付中かは core の関数が確かめる（5.3・AC-18）。
import { systemClock } from "@siteoffer/core";
import { refresh } from "next/cache";
import { type CustomerActionState, submitCustomerDecision } from "@/lib/customer/review";
import { getDb } from "@/lib/db";

export async function customerDecisionAction(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const r = await submitCustomerDecision({ db: getDb(), clock: systemClock }, formData);
  if (r?.status === "ok") refresh();
  return r;
}
