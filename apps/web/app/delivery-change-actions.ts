"use server";
import { requestDeliveryChange, systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";
export async function requestDeliveryChangeAction(input: unknown) {
  try {
    const r = await requestDeliveryChange(getDb(), systemClock, await getCurrentActor(), input);
    if (!r.ok)
      return {
        ok: false as const,
        code: r.error,
        message: r.message ?? "変更を受け付けられませんでした。状態と権限を確認してください。",
      };
    revalidatePath("/ops/delivery");
    revalidatePath("/ops");
    return { ok: true as const, message: "変更を受け付けました。制作情報・素材を確認して、新しい版の制作へ進めます。" };
  } catch {
    return {
      ok: false as const,
      code: "unknown",
      message: "受付結果を確認できません。同じ内容で再試行できます。入力は保持しています。",
    };
  }
}
