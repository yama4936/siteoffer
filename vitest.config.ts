import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 1);
if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) {
  throw new Error("VITEST_MAX_WORKERS は1以上の整数で指定してください。");
}

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web", import.meta.url)) } },
  test: {
    include: ["{apps,packages,templates,tests,demo}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    testTimeout: 30_000,
    // 共有環境の拡張ホストをメモリ不足から守るため、PGliteの重いテストは既定1並列。
    // 余裕のある環境では VITEST_MAX_WORKERS に正の整数を指定して変更できる。
    maxWorkers,
  },
});
