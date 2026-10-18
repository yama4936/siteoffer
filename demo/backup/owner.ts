import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPlainDirectory, BackupError, ensurePlainDirectory } from "./bundle.ts";

type Owner = { kind: "siteoffer-demo-owner-v1"; pid: number; nonce: string; createdAt: string };
const name = "runtime-owner.json";
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function readOwner(dataRoot: string): Promise<Owner> {
  await assertPlainDirectory(dataRoot);
  const file = path.join(dataRoot, name),
    info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new BackupError("データの利用状態を確認できません。");
  const value = JSON.parse(await readFile(file, "utf8")) as Owner;
  if (
    value?.kind !== "siteoffer-demo-owner-v1" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    value.pid > 2147483647 ||
    !/^[a-f0-9-]{36}$/.test(value.nonce) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new BackupError("データの利用状態を確認できません。");
  return value;
}
/** Never remove a live owner's reservation. A crash requires the explicit recovery command. */
export async function acquireOwner(dataRoot: string) {
  await ensurePlainDirectory(dataRoot);
  const owner: Owner = {
    kind: "siteoffer-demo-owner-v1",
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    await writeFile(path.join(dataRoot, name), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const previous = await readOwner(dataRoot);
    throw new BackupError(
      alive(previous.pid)
        ? "このデータは別のプロセスが使用中です。既存のデモを停止してください。"
        : "前回の終了記録が残っています。pnpm demo:unlock で利用状態を確認して解除してください。",
    );
  }
  return {
    owner,
    async release() {
      const current = await readOwner(dataRoot);
      if (current.pid !== owner.pid || current.nonce !== owner.nonce)
        throw new BackupError("データの利用者が変わったため、終了記録を削除していません。");
      await unlink(path.join(dataRoot, name));
    },
  };
}
export async function unlockStoppedOwner(dataRoot: string) {
  const owner = await readOwner(dataRoot);
  if (alive(owner.pid)) throw new BackupError("プロセスが稼働中のため解除できません。先に正常停止してください。");
  const again = await readOwner(dataRoot);
  if (again.nonce !== owner.nonce || again.pid !== owner.pid || alive(again.pid))
    throw new BackupError("利用状態が変わりました。解除していません。");
  await unlink(path.join(dataRoot, name));
  return { recovered: true };
}
