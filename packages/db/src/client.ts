import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "./db.ts";
import * as schema from "./schema/index.ts";

/** 実際のPostgreSQLへ接続する。接続文字列は環境変数から渡し、コードに書かない */
export function createDb(
  connectionString: string,
  limits: Pick<
    pg.PoolConfig,
    "max" | "connectionTimeoutMillis" | "query_timeout" | "statement_timeout" | "idleTimeoutMillis" | "allowExitOnIdle"
  > = {},
): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({ ...limits, connectionString });
  // pg removes a failed idle client; consuming the event keeps a network outage from crashing the app.
  pool.on("error", () => console.warn("データベースの待機接続でエラーが発生しました。"));
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}
