import { BackupError } from "./bundle.ts";
import { BACKUP_ID } from "./catalog.ts";
import type { RetentionPolicy, RetentionRequest } from "./retention-protocol.ts";

export function retentionPolicy(value: unknown): RetentionPolicy {
  const policy = value as RetentionPolicy;
  if (
    !policy ||
    !Number.isSafeInteger(policy.keepCount) ||
    policy.keepCount < 1 ||
    policy.keepCount > 1000 ||
    !Number.isSafeInteger(policy.ageDays) ||
    policy.ageDays < 0 ||
    policy.ageDays > 3650
  )
    throw new BackupError("残す件数は1〜1000件、経過日数は0〜3650日で指定してください。");
  return { keepCount: policy.keepCount, ageDays: policy.ageDays };
}
function pageNumber(value: unknown) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100000)
    throw new BackupError("保管一覧のページを確認してください。");
  return value as number;
}
export function parseRetentionRequest(raw: unknown): RetentionRequest {
  if (!raw || typeof raw !== "object") throw new BackupError("保管操作を確認してください。");
  const value = raw as Record<string, unknown>;
  if (value.operation === "storage") {
    if (value.batch !== undefined && (typeof value.batch !== "string" || !BACKUP_ID.test(value.batch)))
      throw new BackupError("退避した保存を選び直してください。");
    return {
      operation: "storage",
      page: pageNumber(value.page),
      trashPage: pageNumber(value.trashPage),
      ...(value.batch ? { batch: value.batch as string } : {}),
    };
  }
  if (value.operation === "plan") return { operation: "plan", policy: retentionPolicy(value.policy) };
  if (value.operation === "move" && typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token))
    return { operation: "move", policy: retentionPolicy(value.policy), token: value.token };
  if (
    ["pin", "restore", "purge"].includes(String(value.operation)) &&
    typeof value.id === "string" &&
    BACKUP_ID.test(value.id)
  ) {
    if (value.operation === "restore") return { operation: "restore", id: value.id };
    if (value.operation === "pin" && typeof value.pinned === "boolean")
      return { operation: "pin", id: value.id, pinned: value.pinned };
    if (value.operation === "purge" && typeof value.keeper === "string" && BACKUP_ID.test(value.keeper))
      return { operation: "purge", id: value.id, keeper: value.keeper };
  }
  throw new BackupError("保管操作の内容を確認してください。");
}
