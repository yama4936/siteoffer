"use server";
import { getDb } from "@/lib/db";
import { getOpsWorkQueue } from "@/lib/ops/work-queue";
import { getCurrentActor } from "@/lib/session";
export async function refreshOpsWorkQueueAction() {
  try {
    const r = await getOpsWorkQueue(getDb(), await getCurrentActor());
    if (!r.ok) return { ok: false as const, message: "運営としてログインし直してください。" };
    return { ok: true as const, result: r.value };
  } catch {
    return { ok: false as const, message: "仕事の一覧を取得できませんでした。接続を確認して再度更新してください。" };
  }
}
