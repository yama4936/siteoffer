import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "./db.ts";
import * as schema from "./schema/index.ts";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * テスト用DB。既定はメモリ上。障害検証では専用のdataDirを指定して再オープンできる。
 * マイグレーションを流した状態で返す。本番・通常デモの保存先は渡さない。
 * 注意：PGliteは単一接続のため、並行トランザクションは直列に実行される。
 * 本当の同時実行は実PostgreSQL（Docker環境）で確認する。
 */
export async function createTestDb(
  options: { dataDir?: string } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite(options.dataDir);
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder });
  return { db, close: () => client.close() };
}
