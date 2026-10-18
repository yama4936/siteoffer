import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { assertPlainDirectory, BackupError } from "./bundle.ts";
import { latestVerification } from "./verification-receipt.ts";

export const BACKUP_ID = /^backup-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function backupFile(root: string, id: string) {
  if (!BACKUP_ID.test(id)) throw new BackupError("バックアップを選び直してください。");
  const directory = path.join(root, id);
  await assertPlainDirectory(directory);
  const file = path.join(directory, "backup.sob"),
    info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new BackupError("保存済みファイルを確認できません。");
  return { directory, file, info };
}
export type BackupItem = {
  id: string;
  savedAt: string;
  bytes: number;
  status: "verified" | "unverified" | "changed" | "incomplete";
  verifiedAt: string | null;
  sha256: string | null;
  files: number | null;
  tables: number | null;
};
export async function listBackups(root: string, page: number) {
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) throw new BackupError("ページを確認してください。");
  let names: string[];
  try {
    await assertPlainDirectory(root);
    names = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { items: [] as BackupItem[], total: 0, page: 0, pages: 1 };
    throw e;
  }
  const entries: { id: string; savedAt: string }[] = [];
  for (const id of names.filter((n) => BACKUP_ID.test(n))) {
    const info = await lstat(path.join(root, id));
    if (info.isDirectory() && !info.isSymbolicLink()) entries.push({ id, savedAt: info.birthtime.toISOString() });
  }
  entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
  const pages = Math.max(1, Math.ceil(entries.length / 20)),
    current = Math.min(page, pages - 1);
  const items: BackupItem[] = [];
  for (const entry of entries.slice(current * 20, (current + 1) * 20)) {
    try {
      const { directory, info } = await backupFile(root, entry.id),
        receipt = await latestVerification(directory);
      const same = receipt?.archiveBytes === info.size && receipt?.archiveMtimeMs === info.mtimeMs;
      items.push({
        ...entry,
        bytes: info.size,
        status: receipt ? (same ? "verified" : "changed") : "unverified",
        verifiedAt: receipt?.verifiedAt ?? null,
        sha256: same ? receipt.archiveSha256 : null,
        files: receipt?.files ?? null,
        tables: receipt?.tables ?? null,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      items.push({
        ...entry,
        bytes: 0,
        status: "incomplete",
        verifiedAt: null,
        sha256: null,
        files: null,
        tables: null,
      });
    }
  }
  return { items, total: entries.length, page: current, pages };
}
