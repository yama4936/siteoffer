"use server";
import { systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { makeSellable } from "@/lib/ops/commands";
import { getCurrentActor } from "@/lib/session";

export async function activateSalesCandidateAction(input: {
  companyId: string;
  companyUpdatedAt: string;
  proposalVersionId: string;
  productTermsId: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await makeSellable({ db: getDb(), clock: systemClock }, await getCurrentActor(), {
      companyId: input?.companyId,
      productTermsId: input?.productTermsId,
      expectedProposalVersionId: input?.proposalVersionId ?? "",
      expectedCompanyUpdatedAt: input?.companyUpdatedAt ?? "",
      allowExisting: true,
    });
    revalidatePath("/ops", "layout");
    revalidatePath("/sales", "layout");
    return result.ok
      ? { ok: true, message: "営業可能になりました。営業の企業一覧から担当を確保できます。" }
      : { ok: false, message: result.message ?? "現在の状態を確認して、対象と販売条件を選び直してください" };
  } catch {
    return { ok: false, message: "結果を確認できませんでした。同じ対象で再試行できます。" };
  }
}
