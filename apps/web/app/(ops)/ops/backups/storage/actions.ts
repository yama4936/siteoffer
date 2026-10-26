"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { retentionOperation } from "@/lib/ops/backup-retention";
import { BackupAccessError } from "@/lib/ops/backups";
import { BackupError } from "../../../../../../../demo/backup/bundle.ts";
import type { RetentionPlan, StoredBatch } from "../../../../../../../demo/backup/retention-protocol.ts";
import { parseRetentionRequest } from "../../../../../../../demo/backup/retention-request.ts";
export type RetentionActionState = {
  nonce: string;
  ok: boolean;
  message: string;
  plan?: RetentionPlan;
  batch?: StoredBatch;
};
export async function retentionAction(_previous: RetentionActionState, form: FormData): Promise<RetentionActionState> {
  const nonce = randomUUID();
  try {
    const encoded = form.get("request");
    if (typeof encoded !== "string" || encoded.length > 4096) throw new BackupError("保管操作を選び直してください。");
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(encoded);
    } catch {
      throw new BackupError("保管操作を選び直してください。");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BackupError("保管操作を選び直してください。");
    if (raw.operation === "plan")
      raw.policy = { keepCount: Number(form.get("keepCount")), ageDays: Number(form.get("ageDays")) };
    if (raw.operation === "purge") raw.keeper = String(form.get("keeper") ?? "");
    const request = parseRetentionRequest(raw),
      result = await retentionOperation(request, form.get("password"), form.get("confirmed") === "on");
    if (result.kind === "plan")
      return {
        nonce,
        ok: true,
        message: "候補を確認した時点の内容です。操作後の結果は下に表示されます。",
        plan: result.plan,
      };
    if (result.kind === "pinned")
      return { nonce, ok: true, message: "保護指定を更新しました。整理候補は確認し直してください。" };
    if (
      result.kind === "moved" &&
      ["restored", "purged", "closed"].includes(result.batch.state) &&
      result.batch.failed === 0
    )
      return {
        nonce,
        ok: false,
        message: "この整理操作は既に終了しています。操作結果を確認し、必要なら新しい整理候補を作成してください。",
        batch: result.batch,
      };
    if (result.kind === "moved")
      return {
        nonce,
        ok: result.batch.state === "moved",
        message: `${result.batch.moved}件を退避しました。${result.batch.failed ? `${result.batch.failed}件は未処理です。一覧で確認してください。` : "完全削除するまでは元に戻せます。空き容量はまだ増えません。"}`,
        batch: result.batch,
      };
    if (result.kind === "restored")
      return {
        nonce,
        ok: result.batch.state === "restored",
        message: "退避した保存データを元の一覧へ戻しました。",
        batch: result.batch,
      };
    if (result.kind === "purged")
      return {
        nonce,
        ok: result.batch.moved === 0 && result.batch.failed === 0,
        message: `残すバックアップを復元確認し、退避ファイルを完全削除しました。今回削除したファイル容量：${result.removedBytes.toLocaleString("ja-JP")}バイト。`,
        batch: result.batch,
      };
    throw new BackupError("操作結果を確認してください。");
  } catch (error) {
    return {
      nonce,
      ok: false,
      message:
        error instanceof BackupError || error instanceof BackupAccessError
          ? error.message
          : "処理結果を確認できません。保管一覧を更新し、途中の操作がないか確認してください。",
    };
  } finally {
    form.delete("password");
    revalidatePath("/ops/backups/storage");
    revalidatePath("/ops/backups");
  }
}
