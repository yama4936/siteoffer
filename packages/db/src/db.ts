import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type * as schema from "./schema/index.ts";

type Schema = typeof schema;

/** node-postgres（実DB）とPGlite（テスト）の両方で使える型 */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** トランザクションの中でも外でも呼べる関数の引数に使う */
export type DbOrTx = Db | Tx;
