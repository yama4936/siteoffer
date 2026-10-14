import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const authFile = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json");
const auth = JSON.parse(readFileSync(authFile, "utf8"));
if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token) {
  throw new Error("現在のCodexでChatGPTログインが必要です。codex login を実行してください。");
}
const result = spawnSync("codex", ["login", "status"], { encoding: "utf8", stdio: "pipe" });
if (result.status !== 0) throw new Error("Codexのログイン状態を確認できませんでした。");

let env = readFileSync(".env", "utf8");
const values = {
  SITEOFFER_GENERATOR: "codex",
  SITEOFFER_CODEX_AUTH_FILE: authFile,
  SITEOFFER_CODEX_IMAGE: "siteoffer-codex:local",
  SITEOFFER_CODEX_NETWORK: "bridge",
  SITEOFFER_CODEX_USER: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  SITEOFFER_DISCOVERY_PROVIDERS: "fixture",
  SITEOFFER_AUDIT_COLLECTOR: "fixture",
};
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  env = pattern.test(env) ? env.replace(pattern, () => line) : `${env.trimEnd()}\n${line}\n`;
}
writeFileSync(".env", env, { mode: 0o600 });
console.log(
  "現在のChatGPTログインをCodex SDK用に設定しました。認証ファイルはコピーせず、ジョブごとに読み取り専用で渡します。",
);
