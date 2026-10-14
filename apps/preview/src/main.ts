// プレビュー配信の起動（`pnpm --filter @siteoffer/preview start`）。テストからは読み込まない
import { createDb } from "@siteoffer/db";
import { DEFAULT_FRAME_ANCESTORS, DEFAULT_PREVIEW_PORT, startPreviewServer } from "./server.ts";

const env = process.env;
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL が設定されていません");
  process.exit(1);
}
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const started = await startPreviewServer({
  db,
  port: env.PREVIEW_PORT ? Number(env.PREVIEW_PORT) : DEFAULT_PREVIEW_PORT,
  host: env.PREVIEW_HOST ?? "127.0.0.1",
  frameAncestors: env.PREVIEW_FRAME_ANCESTORS
    ? env.PREVIEW_FRAME_ANCESTORS.split(/\s+/).filter(Boolean)
    : DEFAULT_FRAME_ANCESTORS,
  ...(env.PREVIEW_ARTIFACT_BASE_DIR ? { artifactBaseDir: env.PREVIEW_ARTIFACT_BASE_DIR } : {}),
  log: (m) => console.log(`[preview] ${m}`),
});
console.log(`[preview] listening on ${started.url}`);

const shutdown = async () => {
  await started.close();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
