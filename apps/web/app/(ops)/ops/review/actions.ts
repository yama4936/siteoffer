"use server";
import { systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import type { ReviewCommitInput, ReviewDraftResult } from "@/lib/ops/review-draft-types";
import {
  commitReviewDraft,
  loadReviewDraft,
  ReviewDraftConflict,
  ReviewDraftError,
  saveReviewDraft,
} from "@/lib/ops/review-drafts";
import { getCurrentActor } from "@/lib/session";

function failure(e: unknown): Exclude<ReviewDraftResult, { status: "ok" }> {
  if (e instanceof ReviewDraftConflict) return { status: "conflict", snapshot: e.snapshot };
  return {
    status: "error",
    message:
      e instanceof ReviewDraftError
        ? e.message
        : "保存できませんでした。入力は残っています。接続を確認して再試行してください",
  };
}
export async function saveReviewDraftAction(
  versionId: string,
  revision: number,
  values: unknown,
): Promise<ReviewDraftResult> {
  try {
    return {
      status: "ok",
      snapshot: await saveReviewDraft(getDb(), systemClock, await getCurrentActor(), versionId, revision, values),
    };
  } catch (e) {
    return failure(e);
  }
}
export async function loadReviewDraftAction(versionId: string): Promise<ReviewDraftResult> {
  try {
    return { status: "ok", snapshot: await loadReviewDraft(getDb(), await getCurrentActor(), versionId) };
  } catch (e) {
    return failure(e);
  }
}
export async function commitReviewDraftAction(versionId: string, input: ReviewCommitInput): Promise<ReviewDraftResult> {
  try {
    const snapshot = await commitReviewDraft(getDb(), systemClock, await getCurrentActor(), versionId, input);
    revalidatePath("/ops", "layout");
    return { status: "ok", snapshot };
  } catch (e) {
    revalidatePath("/ops/review");
    return failure(e);
  }
}
