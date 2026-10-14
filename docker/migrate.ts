/**
 * PostgreSQL へのマイグレーション適用（compose の migrate サービスが起動時に1回だけ実行する）。
 * packages/db/drizzle の SQL を、Drizzle の node-postgres 用マイグレーターで順に適用する。
 * 適用済みのものは drizzle.__drizzle_migrations に記録され、再実行しても二重に適用しない。
 *
 *   DATABASE_URL=postgres://... node docker/migrate.ts
 *
 * 接続文字列は環境変数からだけ読み、ログに出さない。
 * 状態：用意のみ。Docker・PostgreSQL のある環境では未実行（docker/README.md）。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// drizzle-orm・pg は packages/db の依存。このファイルからは解決できないため、packages/db を起点に読む
const dbPackageJson = fileURLToPath(new URL("../packages/db/package.json", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../packages/db/drizzle", import.meta.url));
const require = createRequire(dbPackageJson);
const pg = require("pg");
const { drizzle } = require("drizzle-orm/node-postgres");
const { migrate } = require("drizzle-orm/node-postgres/migrator");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL が設定されていません");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log("migrate: 適用済み（未適用のマイグレーションがあれば適用した）");
} catch (e) {
  console.error(`migrate: 失敗 ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
