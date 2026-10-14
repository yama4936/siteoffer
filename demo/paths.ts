import path from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリのルート */
export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** デモのデータ置き場。すべて .data/demo 配下（.gitignore 済み）。pnpm demo:reset で丸ごと消す */
const DATA = path.join(REPO_ROOT, ".data/demo");

export const DEMO_PATHS = {
  data: DATA,
  pglite: path.join(DATA, "pglite"),
  /** デモ用アカウントのログイン情報（自分の端末でだけ見る。権限 600） */
  users: path.join(DATA, "users.json"),
  /** プレビューが配信する成果物（デモサイト・納品サイト）の基点 */
  artifacts: path.join(DATA, "artifacts"),
  demos: path.join(DATA, "artifacts/demos"),
  deliveries: path.join(DATA, "artifacts/deliveries"),
  /** 診断の成果物（collected.json・evaluation.json 等） */
  audits: path.join(DATA, "audits"),
  migrations: path.join(REPO_ROOT, "packages/db/drizzle"),
  evalConfig: "config/site-evaluation.demo.json",
} as const;

export const DEMO_PORTS = {
  db: Number(process.env.DEMO_DB_PORT ?? 54329),
  web: Number(process.env.DEMO_WEB_PORT ?? 3100),
  preview: Number(process.env.DEMO_PREVIEW_PORT ?? 3200),
} as const;

export const DEMO_DATABASE_URL = `postgres://postgres@127.0.0.1:${DEMO_PORTS.db}/postgres`;
