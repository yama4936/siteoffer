/**
 * Dockerなしのローカル開発用DB。PGliteをPostgreSQLのプロトコルで公開する。
 * データは .data/pglite に保存する（Gitに入れない）。本番・Docker環境では使わない。
 *
 *   pnpm --filter @siteoffer/db dev-server
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const dataDir = fileURLToPath(new URL("../../../.data/pglite", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const port = Number(process.env.PGLITE_PORT ?? 54329);

mkdirSync(dataDir, { recursive: true });
const db = await PGlite.create(dataDir);
await migrate(drizzle(db), { migrationsFolder });
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 });
await server.start();
console.log(`PGlite dev server: postgres://postgres@127.0.0.1:${port}/postgres`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
