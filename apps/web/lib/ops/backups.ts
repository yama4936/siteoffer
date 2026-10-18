import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Actor } from "@siteoffer/core";
import { auditEvents, users } from "@siteoffer/db";
import { and, eq } from "drizzle-orm";
import { BackupError } from "../../../../demo/backup/bundle.ts";
import { BACKUP_ID, listBackups } from "../../../../demo/backup/catalog.ts";
import { type BackupStatus, requestControl } from "../../../../demo/backup/control-client.ts";
import { getDb } from "../db";
import { getCurrentActor } from "../session";
import { isUuid } from "./form";

export class BackupAccessError extends Error {
  status: number;
  constructor(status: number) {
    super("運営アカウントでログインし直してください。");
    this.status = status;
  }
}
export async function requireBackupOps(actor?: Actor | null) {
  const current = actor === undefined ? await getCurrentActor() : actor;
  if (!current) throw new BackupAccessError(401);
  if (current.kind !== "ops" || !isUuid(current.userId)) throw new BackupAccessError(403);
  const [active] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, current.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!active) throw new BackupAccessError(403);
  return current;
}
export function backupEnvironment() {
  const dataRoot = process.env.SITEOFFER_BACKUP_DATA_ROOT,
    backupRoot = process.env.SITEOFFER_BACKUP_ROOT;
  if (!dataRoot || !backupRoot) return null;
  if (!path.isAbsolute(dataRoot) || !path.isAbsolute(backupRoot) || path.resolve(dataRoot) === path.resolve(backupRoot))
    throw new BackupError("バックアップの保存先設定を確認してください。");
  return { dataRoot, backupRoot };
}
export async function backupAudit(
  action: string,
  targetId: string,
  actorId: string | null,
  after?: Record<string, unknown>,
) {
  await getDb()
    .insert(auditEvents)
    .values({
      actorKind: actorId ? "ops" : "system",
      actorId,
      action: `backup.${action}`,
      targetType: "backup",
      targetId,
      after,
    });
}
export async function backupPage(page: number) {
  const actor = await requireBackupOps();
  const env = backupEnvironment();
  const status = await backupRuntimeStatus(actor);
  if (!env) return { enabled: false, ...status, items: [], total: 0, page: 0, pages: 1 };
  return { enabled: true, ...status, ...(await listBackups(env.backupRoot, page)) };
}
export type BackupRuntimeStatus = BackupStatus & { available: boolean };
export async function backupRuntimeStatus(actor?: Actor | null): Promise<BackupRuntimeStatus> {
  await requireBackupOps(actor);
  const idle: BackupRuntimeStatus = {
    available: false,
    busy: false,
    operation: null,
    startedAt: null,
    phase: null,
    files: 0,
  };
  const env = backupEnvironment();
  if (!env) return idle;
  try {
    const reply = await requestControl(env.dataRoot, "status");
    if (!reply.status) return idle;
    return { ...reply.status, available: true };
  } catch {
    return idle;
  }
}
export async function runBackupOperation(
  command: "backup" | "verify",
  password: unknown,
  confirmation: unknown,
  backupId?: string,
) {
  const actor = await requireBackupOps(),
    env = backupEnvironment();
  if (!env) throw new BackupError("この実行環境にはバックアップの接続設定がありません。");
  if (typeof password !== "string" || password.length < 12 || password.length > 1024)
    throw new BackupError("パスフレーズは12〜1024文字で入力してください。");
  if (command === "backup" && password !== confirmation) throw new BackupError("確認用のパスフレーズが一致しません。");
  if (command === "verify" && (!backupId || !BACKUP_ID.test(backupId)))
    throw new BackupError("バックアップを選び直してください。");
  const requestId = randomUUID();
  const targetId = command === "verify" ? backupId! : requestId;
  await backupAudit(`${command}.requested`, targetId, actor.userId, { requestId });
  let result: Awaited<ReturnType<typeof requestControl>>;
  try {
    result = await requestControl(env.dataRoot, command, password, undefined, backupId);
  } catch (e) {
    await backupAudit(`${command}.failed`, targetId, null, { requestId, requestedBy: actor.userId });
    throw e;
  } finally {
    password = "";
    confirmation = "";
  }
  const id = path.basename(path.dirname(result.file ?? ""));
  if (!BACKUP_ID.test(id) || !result.verification)
    throw new BackupError("保存結果を確認できません。保存済み一覧を更新してください。");
  await backupAudit(`${command}.verified`, id, null, {
    requestId,
    requestedBy: actor.userId,
    sha256: result.verification.archiveSha256,
    bytes: result.bytes,
    verifiedAt: result.verification.verifiedAt,
  });
  await requireBackupOps(actor);
  return id;
}
