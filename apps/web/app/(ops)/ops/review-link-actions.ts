"use server";
import {
  listCustomerReviewLinks,
  recoverCustomerReviewLink,
  revokeCustomerReviewLink,
  systemClock,
} from "@siteoffer/core";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db";
import { customerReviewUrl, webOrigin } from "@/lib/ops/delivery";
import { reviewLinkError, reviewLinkRecovery } from "@/lib/ops/review-links";
import { getCurrentActor } from "@/lib/session";
export async function customerReviewHistoryAction(deliveryId: string, page = 1) {
  try {
    const r = await listCustomerReviewLinks(getDb(), systemClock, await getCurrentActor(), deliveryId, page);
    if (!r.ok) return { status: "error" as const, message: reviewLinkError(r.error) };
    return {
      status: "ok" as const,
      ...r.value,
      links: r.value.links.map((l) => ({
        ...l,
        createdAt: l.createdAt.toISOString(),
        expiresAt: l.expiresAt.toISOString(),
      })),
    };
  } catch {
    return { status: "error" as const, message: "発行履歴を読み込めませんでした。もう一度確認してください。" };
  }
}
export async function recoverCustomerReviewAction(deliveryId: string, linkId: string) {
  try {
    const r = await recoverCustomerReviewLink(
      getDb(),
      systemClock,
      await getCurrentActor(),
      deliveryId,
      linkId,
      reviewLinkRecovery(),
    );
    if (!r.ok) return { status: "error" as const, message: reviewLinkError(r.error) };
    return {
      status: "ok" as const,
      message: "同じリンクを表示しました。有効期限は変更していません。",
      reviewUrl: customerReviewUrl(webOrigin(), r.value.token),
      expiresAt: r.value.link.expiresAt.toISOString(),
      linkId: r.value.link.id,
      versionId: r.value.link.targetId,
    };
  } catch {
    return { status: "error" as const, message: "リンクを確認できませんでした。もう一度確認してください。" };
  }
}
export async function revokeCustomerReviewAction(deliveryId: string, linkId: string) {
  try {
    const r = await revokeCustomerReviewLink(getDb(), systemClock, await getCurrentActor(), deliveryId, linkId);
    if (!r.ok) return { status: "error" as const, message: reviewLinkError(r.error) };
    refresh();
    return { status: "ok" as const, message: "リンクを取り消しました。顧客の判断記録は変更していません。" };
  } catch {
    return { status: "error" as const, message: "取り消し結果を確認できません。同じ取り消しを再確認できます。" };
  }
}
