import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type SeededUser, seedDevUsers } from "../packages/core/src/auth/seed.ts";
import { systemClock } from "../packages/core/src/common/clock.ts";
import { createDb } from "../packages/db/src/client.ts";

const dir = fileURLToPath(new URL("../.data/", import.meta.url));
const credentialsFile = `${dir}dev-users.json`;
if (process.argv.includes("--show")) {
  // 利用者が自分の端末で明示的に実行したときだけ表示する。
  console.log(await readFile(credentialsFile, "utf8"));
} else {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL が設定されていません");
  const { db, close } = createDb(process.env.DATABASE_URL);
  try {
    const created = await seedDevUsers(db, systemClock);
    const fresh = created.filter((u) => u.password !== null);
    if (fresh.length) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let previous: SeededUser[] = [];
      try {
        previous = JSON.parse(await readFile(credentialsFile, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const merged = [...previous.filter((u) => !fresh.some((n) => n.email === u.email)), ...fresh];
      await writeFile(credentialsFile, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    }
    console.log("開発用の運営・営業ユーザーを確認しました。ログイン情報は pnpm dev:users で表示できます。");
  } finally {
    await close();
  }
}
