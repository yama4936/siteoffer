/**
 * デモ専用のDB。PGliteをPostgreSQLのプロトコルで公開し、起動時にマイグレーションを当てる。
 * データは .data/demo/pglite に置く（Gitに入れない。pnpm demo:reset で消す）。
 * 開発用の pnpm dev:db（.data/pglite）とはデータを分ける。本番・実PostgreSQLの検証の代わりにはならない。
 *
 * demo/ はワークスペースのパッケージではないため、PGlite・drizzle は packages/db の依存から読み込む
 * （packages/db/src/dev-server.ts と同じ版）。接続の受け口は pglite-socket ではなく packages/db/src/pglite-server.ts を使う。
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { type PGliteLike, startPGliteServer } from "../packages/db/src/pglite-server.ts";
import { DEMO_PATHS, DEMO_PORTS } from "./paths.ts";

interface PGliteModule {
  PGlite: { create(dataDir: string): Promise<PGliteLike> };
}
interface DrizzleModule {
  drizzle(db: PGliteLike): unknown;
}
interface MigratorModule {
  migrate(db: unknown, opts: { migrationsFolder: string }): Promise<void>;
}

const fromDb = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { PGlite } = fromDb("@electric-sql/pglite") as PGliteModule;
const { drizzle } = fromDb("drizzle-orm/pglite") as DrizzleModule;
const { migrate } = fromDb("drizzle-orm/pglite/migrator") as MigratorModule;

mkdirSync(DEMO_PATHS.pglite, { recursive: true, mode: 0o700 });
const db = await PGlite.create(DEMO_PATHS.pglite);
await migrate(drizzle(db), { migrationsFolder: DEMO_PATHS.migrations });
// web・プレビュー・ワーカー（pg-boss を含む）の接続を受ける。PGlite は1セッションで、
// 問い合わせの単位（Syncまで）・トランザクションの単位で1つの接続に専有させる（pglite-server.ts）
const server = await startPGliteServer(db, { port: DEMO_PORTS.db, host: "127.0.0.1" });
console.log(`[db] デモ用DB（PGlite）を起動した：127.0.0.1:${DEMO_PORTS.db}（マイグレーション済み）`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await db.close();
  console.log("[db] 停止した");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
