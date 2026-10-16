"use server";
import {
  ArticleCopyConflict,
  type ArticleOperation,
  type ArticleScope,
  ArticleWorkspaceConflict,
  type ArticleWorkspaceResult,
  ContentError,
  loadArticleWorkspace,
  saveArticleWorkingCopy,
  submitArticleOperation,
  systemClock,
} from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";

export async function saveArticleCopyAction(scope: ArticleScope, revision: number, values: unknown) {
  try {
    return {
      status: "ok" as const,
      snapshot: await saveArticleWorkingCopy(getDb(), systemClock, await getCurrentActor(), scope, revision, values),
    };
  } catch (e) {
    if (e instanceof ArticleCopyConflict) return { status: "conflict" as const, snapshot: e.snapshot };
    return {
      status: "error" as const,
      message:
        e instanceof ContentError
          ? e.message
          : "作業コピーを保存できませんでした。入力はこの画面に残っています。再試行してください",
    };
  }
}
export async function refreshArticleAction(scope: ArticleScope) {
  try {
    return { status: "ok" as const, workspace: await loadArticleWorkspace(getDb(), await getCurrentActor(), scope) };
  } catch (e) {
    return {
      status: "error" as const,
      message: e instanceof ContentError ? e.message : "最新の記事を確認できませんでした。入力は残っています",
    };
  }
}
export async function submitArticleAction(
  scope: ArticleScope,
  input: ArticleOperation,
): Promise<ArticleWorkspaceResult> {
  try {
    const result = await submitArticleOperation(getDb(), systemClock, await getCurrentActor(), scope, input);
    revalidatePath("/ops/content");
    revalidatePath("/customer/content");
    if (input.kind === "publish") revalidatePath(`/published/${scope.companyId}/news`, "page");
    return { status: "ok", ...result };
  } catch (e) {
    if (e instanceof ArticleWorkspaceConflict)
      return { status: "conflict", workspace: e.workspace, message: e.message };
    if (e instanceof ContentError) return { status: "error", message: e.message };
    // Unknown failures can follow a committed transaction. The client retries the same receipt.
    throw new Error("記事の操作結果を確認できませんでした");
  }
}
