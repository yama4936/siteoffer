import { createDb, type Db } from "@siteoffer/db";

let cached: Db | undefined;
/** Separate, bounded public lookup pool; existing application connections retain their defaults. */
export function getArticleLegacyDb() {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    cached = createDb(url, {
      max: 4,
      connectionTimeoutMillis: 2000,
      query_timeout: 3000,
      statement_timeout: 3000,
      idleTimeoutMillis: 10000,
      allowExitOnIdle: true,
    }).db;
  }
  return cached;
}
