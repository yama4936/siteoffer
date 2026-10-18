import { lstat } from "node:fs/promises";
import path from "node:path";
import { assertPlainDirectory, BackupError } from "./backup/bundle.ts";

/** Resume an existing database without seeding users or silently replacing the share recovery key. */
export async function assertResumeProfile(paths: { data: string; pglite: string }) {
  try {
    await assertPlainDirectory(paths.data);
    await assertPlainDirectory(paths.pglite);
  } catch {
    throw new BackupError(
      "継続起動に必要な保存先を確認できません。既存データの場所・権限を確認してください。初期化はしていません。",
    );
  }
  for (const file of [path.join(paths.pglite, "PG_VERSION"), path.join(paths.data, "share-token-key")]) {
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink())
      throw new BackupError(
        "継続起動に必要なDB・共有復旧鍵がありません。既存データを確認してください。初期化はしていません。",
      );
  }
}
