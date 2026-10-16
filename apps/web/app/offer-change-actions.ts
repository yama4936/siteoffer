"use server";
import { decideSalesOfferChange, proposeSalesOfferChange, systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";
export async function proposeOfferChangeAction(input: unknown) {
  try {
    const r = await proposeSalesOfferChange(getDb(), systemClock, await getCurrentActor(), input);
    if (!r.ok) return { ok: false, message: r.message ?? "変更を受け付けられませんでした。" };
    revalidatePath("/ops", "layout");
    revalidatePath("/sales", "layout");
    return {
      ok: true,
      message:
        r.value.status === "pending"
          ? "営業担当へ条件変更の確認を依頼しました。"
          : "受付済みの変更を確認しました。履歴で現在の状態を確認できます。",
    };
  } catch {
    return { ok: false, message: "結果を確認できません。同じ確認内容で再試行できます。" };
  }
}
export async function answerOfferChangeAction(input: unknown) {
  try {
    const r = await decideSalesOfferChange(getDb(), systemClock, await getCurrentActor(), input);
    if (!r.ok) return { ok: false, message: r.message ?? "回答できませんでした。" };
    revalidatePath("/ops", "layout");
    revalidatePath("/sales", "layout");
    return {
      ok: true,
      message:
        r.value.status === "accepted"
          ? "変更した条件をこの担当案件に適用しました。提案は新しいリンクを発行して共有してください。"
          : "回答を記録しました。現在の販売条件を維持します。",
    };
  } catch {
    return { ok: false, message: "結果を確認できません。同じ回答で再試行できます。" };
  }
}
