import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
mkdirSync(".data", { recursive: true, mode: 0o700 });
mkdirSync("reports", { recursive: true, mode: 0o700 });
if (!existsSync(".env")) {
  const password = randomBytes(24).toString("hex");
  writeFileSync(
    ".env",
    `POSTGRES_PASSWORD=${password}\nDATABASE_PORT=54329\nDATABASE_URL=postgres://siteoffer:${password}@127.0.0.1:54329/siteoffer\nWEB_PORT=3100\nPREVIEW_PORT=3200\nNTA_APPLICATION_ID=\nPSI_API_KEY=\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log("ローカル用 .env を作成しました（Git対象外）。");
} else {
  console.log("既存の .env を保持しました。Composeには POSTGRES_PASSWORD が必要です。");
}

// 既存の有効な鍵は更新しない。.env.example由来の空欄も初回生成の対象。
const envText = readFileSync(".env", "utf8");
const keyLine = /^SITEOFFER_SHARE_TOKEN_KEY[ \t]*=.*$/m;
const emptyKeyLine = /^SITEOFFER_SHARE_TOKEN_KEY[ \t]*=[ \t]*(?:""|'')?[ \t]*(?:#[^\r\n]*)?$/m;
if (!keyLine.test(envText) || emptyKeyLine.test(envText)) {
  const entry = `SITEOFFER_SHARE_TOKEN_KEY=${randomBytes(32).toString("base64url")}`;
  if (keyLine.test(envText)) writeFileSync(".env", envText.replace(emptyKeyLine, entry));
  else appendFileSync(".env", `\n${entry}\n`);
  console.log("ローカル用の共有リンク復旧鍵を追加しました（値は非表示）。");
}
