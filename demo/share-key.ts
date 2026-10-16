import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
/** デモDBと同じ寿命の鍵。再起動では保持し、初回だけ生成。破損時は勝手に交換しない。 */
export async function demoShareKey(dataDir: string) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "share-token-key");
  const temporary = path.join(dataDir, `.share-key-${randomUUID()}`);
  await writeFile(temporary, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temporary, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  } finally {
    await unlink(temporary);
  }
  const key = (await readFile(file, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, "base64url").toString("base64url") !== key)
    throw new Error("デモの共有リンク鍵を読み込めません。既存の鍵は変更していません");
  return key;
}
