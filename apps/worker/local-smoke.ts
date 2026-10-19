import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runLocalHttpSmoke } from "./local-http-smoke.ts";

// This command deliberately has no DB, credential, approval or share-link dependency.
const result = await runLocalHttpSmoke(process.argv.slice(2));
if (result.refused) {
  console.error(result.message);
  process.exitCode = 2;
} else {
  const directory = new URL(`../../.data/local-run/http-smoke/${randomUUID()}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL("result.json", directory),
    JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2),
  );
  for (const check of result.checks)
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.route}: ${check.status ?? "接続不可"}`);
  console.log("匿名HTTPの読み取り確認です。DB・認証情報を読み込まず、ログイン・業務更新・モデル通信は行っていません。");
  console.log("担当・承認・契約を含む通し確認は pnpm test:postgres:pipeline 等の専用DBで実行してください。");
  console.log(`結果: ${fileURLToPath(new URL("result.json", directory))}`);
  process.exitCode = result.ok ? 0 : 1;
}
