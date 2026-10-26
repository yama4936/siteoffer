"use server";
import { commitArticleImport, previewArticleImport, systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";
export async function previewArticleImportAction(input: unknown) {
  try {
    return await previewArticleImport(getDb(), await getCurrentActor(), input);
  } catch {
    return {
      ok: false as const,
      error: "unknown",
      message: "確認できませんでした。ファイルを保持したまま再試行できます。",
    };
  }
}
export async function commitArticleImportAction(input: unknown) {
  try {
    const r = await commitArticleImport(getDb(), systemClock, await getCurrentActor(), input);
    if (r.ok) {
      revalidatePath("/ops/content");
      revalidatePath("/ops/content/[companyId]/import", "page");
      revalidatePath("/ops/delivery");
    }
    return r;
  } catch {
    return { ok: false as const, error: "unknown", message: "保存結果を確認できません。同じ内容で再試行できます。" };
  }
}
