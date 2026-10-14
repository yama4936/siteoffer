import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// リポジトリ直下の .env（Gitに入れない）を読む。Next.js は apps/web の .env しか読まないため。
// すでに設定されている環境変数は上書きしない。DATABASE_URL などはサーバー側だけで使い、ブラウザには渡さない
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  // ワークスペースのパッケージはTypeScriptのまま読み込む
  transpilePackages: [
    "@siteoffer/core",
    "@siteoffer/db",
    "@siteoffer/schemas",
    "@siteoffer/astro-site",
    "@siteoffer/discovery",
  ],
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default config;
