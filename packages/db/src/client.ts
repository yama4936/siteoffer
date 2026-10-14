import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "./db.ts";
import * as schema from "./schema/index.ts";

/** 実際のPostgreSQLへ接続する。接続文字列は環境変数から渡し、コードに書かない */
export function createDb(connectionString: string): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}
