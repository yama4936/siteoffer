"use server";
import { saveDeliveryPreparation, systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";
export async function saveDeliveryPreparationAction(input: unknown) {
  try {
    const result = await saveDeliveryPreparation(getDb(), systemClock, await getCurrentActor(), input);
    if (!result.ok)
      return { ok: false as const, code: result.error, message: result.message ?? "制作情報を保存できませんでした。" };
    revalidatePath("/ops/delivery");
    revalidatePath("/ops");
    return {
      ok: true as const,
      revision: result.value.revision,
      message: "納品用の制作情報を記録しました。内容を確認して制作へ進めます。",
    };
  } catch {
    return {
      ok: false as const,
      code: "unknown",
      message: "保存結果を確認できません。同じ内容で再試行できます。入力は保持しています。",
    };
  }
}
