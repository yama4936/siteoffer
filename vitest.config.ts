import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages,templates,tests}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    testTimeout: 30_000,
  },
});
