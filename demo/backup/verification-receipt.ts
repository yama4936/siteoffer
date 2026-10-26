import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertPlainDirectory } from "./bundle.ts";
import type { verifySnapshot } from "./verify.ts";

export type VerificationReceipt = Awaited<ReturnType<typeof verifySnapshot>>;
export async function latestVerification(directory: string): Promise<VerificationReceipt | null> {
  await assertPlainDirectory(directory);
  let latest: VerificationReceipt | null = null;
  for (const name of await readdir(directory)) {
    if (!/^verification(?:-[a-f0-9-]{36})?\.json$/.test(name)) continue;
    const file = path.join(directory, name),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) continue;
    try {
      const r = JSON.parse(await readFile(file, "utf8")) as VerificationReceipt;
      if (
        r?.format !== 1 ||
        !Number.isFinite(Date.parse(r.verifiedAt)) ||
        !/^[a-f0-9]{64}$/.test(r.archiveSha256) ||
        ![r.archiveBytes, r.files, r.references, r.tables].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        !Number.isFinite(r.archiveMtimeMs)
      )
        continue;
      if (!latest || r.verifiedAt > latest.verifiedAt) latest = r;
    } catch {}
  }
  return latest;
}
