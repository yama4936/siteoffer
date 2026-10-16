"use server";
import { ContentError, publishArticle, saveArticle, systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { requireUser } from "@/lib/session";

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "");
export async function saveArticleAction(fd: FormData) {
  const user = await requireUser("ops");
  const companyId = str(fd, "companyId");
  if (!isUuid(companyId)) throw new Error("Invalid company");
  let id = str(fd, "entryId"),
    error = "";
  try {
    if (id && !isUuid(id)) throw new ContentError("記事IDが不正です");
    const r = await saveArticle(getDb(), systemClock, user.actor, {
      companyId,
      ...(id ? { entryId: id, expectedRevision: Number(str(fd, "expectedRevision")) } : {}),
      slug: str(fd, "slug"),
      title: str(fd, "title"),
      body: str(fd, "body"),
      category: str(fd, "category"),
    });
    id = r.id;
  } catch (e) {
    error = e instanceof ContentError ? e.message : "保存できませんでした。入力内容を確認してください";
  }
  revalidatePath("/ops/content");
  redirect(
    `/ops/content?${new URLSearchParams({ company: companyId, ...(id ? { entry: id } : {}), [error ? "error" : "msg"]: error || "下書きを保存しました。掲載中の内容は変わりません。" })}`,
  );
}
export async function publishArticleAction(fd: FormData) {
  const user = await requireUser("ops");
  const companyId = str(fd, "companyId"),
    id = str(fd, "entryId");
  if (!isUuid(companyId) || !isUuid(id)) throw new Error("Invalid article");
  let error = "";
  try {
    if (!fd.has("confirmed")) throw new ContentError("掲載内容を確認してください");
    await publishArticle(getDb(), systemClock, user.actor, {
      entryId: id,
      expectedRevision: Number(str(fd, "expectedRevision")),
      revision: str(fd, "revision") === "none" ? null : Number(str(fd, "revision")),
    });
  } catch (e) {
    error = e instanceof ContentError ? e.message : "掲載版を変更できませんでした";
  }
  revalidatePath("/ops/content");
  revalidatePath(`/published/${companyId}/news`, "page");
  redirect(
    `/ops/content?${new URLSearchParams({ company: companyId, entry: id, [error ? "error" : "msg"]: error || "掲載設定を保存しました。サイト公開後は更新内容が反映されます。" })}`,
  );
}
