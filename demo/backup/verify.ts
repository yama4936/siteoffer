import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { assertPlainDirectory, BackupError, removeOwnedDirectory } from "./bundle.ts";
import { type RestoreOptions, restoreSnapshot } from "./snapshot.ts";

/** Actually restore and open the DB, check every recorded table, then remove the isolated rehearsal. */
export async function verifySnapshot(options: RestoreOptions) {
  const restored = await restoreSnapshot(options);
  const receipt = await (async () => {
    try {
      const directory = path.dirname(options.file);
      await assertPlainDirectory(directory);
      if (path.basename(options.file) !== "backup.sob" || !/^backup-[a-f0-9-]{36}$/.test(path.basename(directory)))
        throw new BackupError("作成済みバックアップの保存先を確認してください。");
      const receipt = {
        format: 1,
        verifiedAt: new Date().toISOString(),
        backupCreatedAt: restored.backupCreatedAt,
        engineVersion: restored.engineVersion,
        files: restored.files,
        references: restored.references,
        tables: restored.tables,
        archiveSha256: restored.archiveSha256,
        archiveBytes: restored.archiveBytes,
        archiveMtimeMs: restored.archiveMtimeMs,
      };
      return receipt;
    } finally {
      await removeOwnedDirectory(restored.directory, options.restoreRoot);
    }
  })();
  const out = await open(path.join(path.dirname(options.file), `verification-${randomUUID()}.json`), "wx", 0o600);
  try {
    await out.writeFile(JSON.stringify(receipt, null, 2));
    await out.sync();
  } finally {
    await out.close();
  }
  return receipt;
}
export type { VerificationReceipt } from "./verification-receipt.ts";
export { latestVerification } from "./verification-receipt.ts";
