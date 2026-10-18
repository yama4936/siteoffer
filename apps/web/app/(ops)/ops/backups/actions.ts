"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { BackupAccessError, runBackupOperation } from "@/lib/ops/backups";
import { BackupError } from "../../../../../../demo/backup/bundle.ts";

export type BackupActionState = { nonce: string; ok: boolean; message: string };
export async function backupAction(_previous: BackupActionState, form: FormData): Promise<BackupActionState> {
  const nonce = randomUUID();
  try {
    const command = form.get("command");
    if (command !== "backup" && command !== "verify") throw new BackupError("操作を選び直してください。");
    await runBackupOperation(
      command,
      form.get("password"),
      form.get("confirmation"),
      String(form.get("backupId") ?? ""),
    );
    revalidatePath("/ops/backups");
    return {
      nonce,
      ok: true,
      message:
        command === "backup"
          ? "暗号化して保存し、隔離環境での復元を確認しました。保存済み一覧からダウンロードできます。"
          : "隔離環境での復元を確認しました。確認日時を更新しました。",
    };
  } catch (e) {
    return {
      nonce,
      ok: false,
      message:
        e instanceof BackupError || e instanceof BackupAccessError
          ? e.message
          : "結果を確認できません。保存済み一覧を更新し、必要に応じて再検証してください。",
    };
  } finally {
    form.delete("password");
    form.delete("confirmation");
  }
}
