"use server";
import { attachImageAssetFile, ImageAssetError, requireAssetOperator, systemClock } from "@siteoffer/core";
import { normalizeAssetImage } from "@siteoffer/generation/images";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";
export async function uploadImageAssetAction(fd: FormData) {
  try {
    const db = getDb(),
      actor = await getCurrentActor();
    await requireAssetOperator(db, actor);
    const file = fd.get("image");
    if (!(file instanceof File) || file.size < 1 || file.size > 12 * 1024 * 1024)
      return { ok: false, message: "12MB以下のPNG・JPEG・WebP画像を選択してください" };
    let image: Awaited<ReturnType<typeof normalizeAssetImage>>;
    try {
      image = await normalizeAssetImage(Buffer.from(await file.arrayBuffer()));
    } catch {
      return {
        ok: false,
        message: "画像を読み込めません。12MB以下・2000万画素以下の静止画PNG・JPEG・WebPを選択してください",
      };
    }
    const companyId = String(fd.get("companyId") ?? ""),
      assetId = String(fd.get("assetId") ?? "");
    const r = await attachImageAssetFile(db, systemClock, actor, { companyId, assetId, ...image });
    revalidatePath(`/ops/companies/${companyId}`);
    revalidatePath("/ops/delivery");
    return {
      ok: true,
      message: r.alreadyStored
        ? "同じ画像は登録済みです。"
        : "画像を登録しました。この画像の配置先を確認してください。",
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof ImageAssetError ? e.message : "保存結果を確認できません。同じ画像で再試行できます。",
    };
  }
}
