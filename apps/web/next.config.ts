import type { NextConfig } from "next";

const config: NextConfig = {
  // ワークスペースのパッケージはTypeScriptのまま読み込む
  transpilePackages: ["@siteoffer/core", "@siteoffer/db", "@siteoffer/schemas", "@siteoffer/astro-site"],
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default config;
