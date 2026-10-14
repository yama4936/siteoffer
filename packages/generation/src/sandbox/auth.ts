import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Desktopと更新用トークンを同時に使わず、現在のアクセス認証だけを一時ホームに置く。 */
export function accessOnlyChatGptAuth(source: unknown) {
  const auth = source as { auth_mode?: unknown; tokens?: Record<string, unknown>; last_refresh?: unknown } | null;
  if (auth?.auth_mode !== "chatgpt" || typeof auth.tokens?.access_token !== "string" || !auth.tokens.access_token) {
    throw new Error("ChatGPTログインの認証ファイルが必要です");
  }
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    last_refresh: auth.last_refresh,
    tokens: {
      access_token: auth.tokens.access_token,
      id_token: auth.tokens.id_token,
      account_id: auth.tokens.account_id,
      refresh_token: "",
    },
  };
}

export function prepareChatGptAuth(sourceFile: string, codexHome: string): void {
  const auth = accessOnlyChatGptAuth(JSON.parse(readFileSync(sourceFile, "utf8")));
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
}
