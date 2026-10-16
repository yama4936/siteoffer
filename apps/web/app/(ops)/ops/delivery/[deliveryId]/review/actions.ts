"use server";

import { issueDeliveryPreview, systemClock } from "@siteoffer/core";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { webOrigin } from "@/lib/ops/delivery";
import { previewOrigin } from "@/lib/sales/preview";
import { getCurrentActor, SESSION_COOKIE } from "@/lib/session";

export async function openDeliveryPreview(deliveryId: string, versionId: string) {
  let origin: URL;
  try {
    origin = new URL(previewOrigin());
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin === new URL(webOrigin()).origin ||
      origin.username ||
      origin.password
    )
      return { error: "プレビュー配信の設定を確認してください。管理画面とは別の配信元が必要です。" };
  } catch {
    return { error: "プレビュー配信の設定を確認してください。" };
  }
  const actor = await getCurrentActor();
  const session = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const result = await issueDeliveryPreview(getDb(), systemClock, actor, session, deliveryId, versionId);
  if (!result.ok)
    return {
      error:
        result.error === "forbidden"
          ? "ログイン状態を確認して、開き直してください。"
          : "この制作版は表示できません。成果物と版を確認してください。",
    };
  return { url: `${origin.origin}/internal/${result.value.token}/`, expiresAt: result.value.expiresAt.toISOString() };
}
