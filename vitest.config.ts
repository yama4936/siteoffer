import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages,templates,tests,demo}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    testTimeout: 30_000,
    // この環境のシェルはメモリ上限4GBの枠で動き、PGliteを使うテストを多数並列にすると強制終了される。
    // 並列数は既定2。環境変数 VITEST_MAX_WORKERS で変えられる。
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 2),
  },
});
