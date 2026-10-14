import { createDb, type Db } from "@siteoffer/db";

let cached: Db | undefined;

/** サーバー側専用。接続文字列は環境変数 DATABASE_URL から読む */
export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL が設定されていません");
    cached = createDb(url).db;
  }
  return cached;
}
