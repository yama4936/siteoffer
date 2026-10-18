import { randomUUID } from "node:crypto";
import { BackupError } from "../../../../demo/backup/bundle.ts";
import { requestControl } from "../../../../demo/backup/control-client.ts";
import type { RetentionReply, RetentionRequest } from "../../../../demo/backup/retention-protocol.ts";
import { parseRetentionRequest } from "../../../../demo/backup/retention-request.ts";
import { backupAudit, backupEnvironment, backupRuntimeStatus, requireBackupOps } from "./backups";

export async function retentionOperation(raw: unknown, password?: unknown, confirmed = false): Promise<RetentionReply> {
  const actor = await requireBackupOps(),
    request = parseRetentionRequest(raw),
    env = backupEnvironment();
  if (!env) throw new BackupError("この環境のバックアップ接続が未設定です。データを保持して正常に再起動してください。");
  if (["move", "purge"].includes(request.operation) && confirmed !== true)
    throw new BackupError("対象と影響を確認し、確認欄を選択してください。");
  if (request.operation === "purge" && (typeof password !== "string" || password.length < 12 || password.length > 1024))
    throw new BackupError("残すバックアップのパスフレーズを12〜1024文字で入力してください。");
  const mutation = !["storage", "plan"].includes(request.operation),
    requestId = randomUUID();
  const target = "id" in request ? request.id : requestId;
  if (mutation) await backupAudit(`retention.${request.operation}.requested`, target, actor.userId, { requestId });
  let result: RetentionReply;
  try {
    const reply = await requestControl(
      env.dataRoot,
      "retention",
      typeof password === "string" ? password : undefined,
      undefined,
      undefined,
      request,
      actor.userId,
    );
    if (!reply.retention) throw new BackupError("保管操作の結果を確認できません。一覧を更新してください。");
    result = reply.retention;
    if (mutation)
      await backupAudit(
        `retention.${request.operation}.completed`,
        "batch" in result ? result.batch.id : target,
        null,
        {
          requestId,
          requestedBy: actor.userId,
          ...("batch" in result
            ? { batchState: result.batch.state, moved: result.batch.moved, failed: result.batch.failed }
            : {}),
          ...("removedBytes" in result
            ? { removedBytes: result.removedBytes, freeBefore: result.freeBefore, freeAfter: result.freeAfter }
            : {}),
        },
      );
  } catch (error) {
    if (mutation)
      await backupAudit(`retention.${request.operation}.failed`, target, null, {
        requestId,
        requestedBy: actor.userId,
      });
    throw error;
  } finally {
    password = "";
  }
  await requireBackupOps(actor);
  return result;
}
export async function readBackupStorage(
  input: Omit<Extract<RetentionRequest, { operation: "storage" }>, "operation"> = {},
) {
  const actor = await requireBackupOps(),
    configured = !!backupEnvironment(),
    runtime = await backupRuntimeStatus(actor);
  let data: Extract<RetentionReply, { kind: "storage" }> | null = null,
    error = "";
  if (configured && runtime.available && !runtime.busy) {
    try {
      const result = await retentionOperation({ operation: "storage", ...input });
      if (result.kind !== "storage") throw new BackupError("保管一覧の形式を確認できません。");
      data = result;
    } catch (failure) {
      error =
        failure instanceof BackupError ? failure.message : "保管一覧を取得できません。時間をおいて更新してください。";
    }
  }
  return { configured, runtime, data, error };
}
