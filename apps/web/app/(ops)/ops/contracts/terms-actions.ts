"use server";

import { randomUUID } from "node:crypto";
import { systemClock } from "@siteoffer/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import type { ProductTermsDraftState } from "@/lib/ops/product-terms-draft";
import { saveProductTermsDraft } from "@/lib/ops/save-product-terms-draft";
import { getCurrentActor } from "@/lib/session";

export async function saveProductTermsDraftAction(
  _previous: ProductTermsDraftState,
  form: FormData,
): Promise<ProductTermsDraftState> {
  const nonce = randomUUID();
  try {
    const result = await saveProductTermsDraft(
      { db: getDb(), clock: systemClock },
      await getCurrentActor(),
      form,
      nonce,
    );
    if (result.status === "saved") revalidatePath("/ops", "layout");
    return result;
  } catch {
    return {
      nonce,
      status: "error",
      errors: {},
      saved: null,
      message: "保存結果を確認できません。入力を残したまま、ログイン状態と保存済みの版を確認してください。",
    };
  }
}
