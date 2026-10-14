/**
 * Dockerなしのローカル開発用DB。PGliteをPostgreSQLのプロトコルで公開する。
 * データは .data/pglite に保存する（Gitに入れない）。本番・Docker環境では使わない。
 * 接続の受け口は pglite-socket ではなく pglite-server.ts を使う。pglite-socket は複数の接続のメッセージを1件ずつ混ぜるため、
 * web とワーカーを同時につなぐと拡張問い合わせやトランザクションが割り込まれて壊れる。
 *
 *   pnpm --filter @siteoffer/db dev-server
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { startPGliteServer } from "./pglite-server.ts";

const dataDir = fileURLToPath(new URL("../../../.data/pglite", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const port = Number(process.env.PGLITE_PORT ?? 54329);

mkdirSync(dataDir, { recursive: true });
const db = await PGlite.create(dataDir);
await migrate(drizzle(db), { migrationsFolder });
const server = await startPGliteServer(db, { port, host: "127.0.0.1" });
console.log(`PGlite dev server: postgres://postgres@127.0.0.1:${port}/postgres`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
