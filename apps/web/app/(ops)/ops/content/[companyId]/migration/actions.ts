"use server";
import { randomUUID } from "node:crypto";
import { ContentError, changeArticleLegacyPaths, systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";
export type LegacyActionState = { nonce: string; ok: boolean; message: string };
export async function changeLegacyAction(_previous: LegacyActionState, form: FormData): Promise<LegacyActionState> {
  const nonce = randomUUID();
  try {
    const company = String(form.get("companyId") ?? ""),
      operation = form.get("operation"),
      encoded = form.get("selected");
    if ((operation !== "enable" && operation !== "disable") || typeof encoded !== "string" || encoded.length > 65536)
      throw new ContentError("操作と対象を選び直してください");
    const selected: unknown = JSON.parse(encoded);
    const result = await changeArticleLegacyPaths(
      getDb(),
      systemClock,
      await getCurrentActor(),
      company,
      operation,
      selected,
      form.get("confirmed") === "on",
    );
    revalidatePath(`/ops/content/${company}/migration`);
    revalidatePath(`/published/${company}/news`);
    return {
      nonce,
      ok: true,
      message: result.changed
        ? `${result.changed}件の旧URLを${operation === "enable" ? "有効に" : "解除"}しました。`
        : "選択した記事は既に指定した状態です。",
    };
  } catch (error) {
    return {
      nonce,
      ok: false,
      message:
        error instanceof ContentError
          ? error.message
          : "結果を確認できません。対応表を更新し、現在の設定を確認してください。",
    };
  }
}
