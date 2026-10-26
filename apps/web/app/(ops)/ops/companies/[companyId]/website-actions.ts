"use server";
import { randomUUID } from "node:crypto";
import { systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { str } from "@/lib/ops/form";
import { reviewOfficialWebsite, saveWebsiteCandidate } from "@/lib/ops/website-candidate";
import { getCurrentActor } from "@/lib/session";
export type WebsiteActionState = { nonce: string; ok: boolean; message: string };
export async function websiteCandidateAction(
  _previous: WebsiteActionState,
  form: FormData,
): Promise<WebsiteActionState> {
  const nonce = randomUUID();
  try {
    const companyId = str(form, "companyId"),
      result = await saveWebsiteCandidate({ db: getDb(), clock: systemClock }, await getCurrentActor(), {
        companyId,
        requestId: str(form, "requestId"),
        expected: str(form, "expected"),
        url: str(form, "url"),
        sourceUrl: str(form, "sourceUrl"),
        note: str(form, "note"),
        confirmed: form.get("confirmed") === "on",
      });
    if (!result.ok) return { nonce, ok: false, message: result.message ?? "入力と現在の状態を確認してください" };
    revalidatePath(`/ops/companies/${companyId}`);
    revalidatePath("/ops/discovery");
    return {
      nonce,
      ok: true,
      message: result.value.alreadySaved
        ? "保存済みの候補を確認しました。"
        : result.value.created
          ? "候補と確認根拠を保存しました。次に公式サイトの確度を確認してください。"
          : "既存の候補へ確認根拠を追記しました。",
    };
  } catch {
    return { nonce, ok: false, message: "保存結果を確認できません。同じ入力でもう一度確認してください。" };
  }
}
export async function websiteReviewAction(_previous: WebsiteActionState, form: FormData): Promise<WebsiteActionState> {
  const nonce = randomUUID();
  try {
    const companyId = str(form, "companyId"),
      status = str(form, "status"),
      expected = str(form, "expected");
    if (!/^[a-f0-9]{64}$/.test(expected) || (status === "confirmed" && form.get("confirmed") !== "on"))
      return { nonce, ok: false, message: "公式サイトの確認欄と選択したURLを確認してください。" };
    const result = await reviewOfficialWebsite({ db: getDb(), clock: systemClock }, await getCurrentActor(), {
      companyId,
      status: status as Parameters<typeof reviewOfficialWebsite>[2]["status"],
      websiteId: str(form, "websiteId") || null,
      note: str(form, "note"),
      expected,
    });
    if (!result.ok) return { nonce, ok: false, message: result.message ?? "選択と現在の状態を確認してください。" };
    revalidatePath(`/ops/companies/${companyId}`);
    revalidatePath("/ops/discovery");
    revalidatePath("/ops/processing");
    return { nonce, ok: true, message: "公式サイトの確度を保存しました。診断は自動では依頼していません。" };
  } catch {
    return { nonce, ok: false, message: "結果を確認できません。画面を更新して現在の確度を確認してください。" };
  }
}
