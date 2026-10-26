"use server";
import { randomUUID } from "node:crypto";
import { CompanyProfileError, saveCompanyProfile, systemClock } from "@siteoffer/core";
import { COMPANY_PROFILE_FIELDS } from "@siteoffer/schemas";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { str } from "@/lib/ops/form";
import { getCurrentActor } from "@/lib/session";
export type CompanyProfileActionState = {
  nonce: string;
  ok: boolean;
  message: string;
  revision: number | null;
  refreshRequired: boolean;
};
export async function companyProfileAction(
  _previous: CompanyProfileActionState,
  form: FormData,
): Promise<CompanyProfileActionState> {
  const nonce = randomUUID();
  try {
    const companyId = str(form, "companyId");
    const result = await saveCompanyProfile(getDb(), systemClock, await getCurrentActor(), {
      companyId,
      expectedRevision: Number(str(form, "revision")),
      values: Object.fromEntries(Object.keys(COMPANY_PROFILE_FIELDS).map((key) => [key, str(form, key) || null])),
      source: str(form, "source"),
      confirmed: form.get("confirmed") === "on",
    });
    revalidatePath(`/ops/companies/${companyId}`);
    revalidatePath("/ops/review");
    return {
      nonce,
      ok: true,
      refreshRequired: false,
      revision: result.profile.revision,
      message: result.unchanged
        ? "保存済みの確認情報と同じです。版は変えていません。"
        : "確認情報を保存しました。次の提案・納品制作に反映します。",
    };
  } catch (error) {
    return {
      nonce,
      ok: false,
      refreshRequired: error instanceof CompanyProfileError && error.code === "conflict",
      revision: null,
      message:
        error instanceof CompanyProfileError
          ? error.message
          : "保存結果を確認できません。入力を控え、画面を更新して現在の会社情報を確認してください。",
    };
  }
}
